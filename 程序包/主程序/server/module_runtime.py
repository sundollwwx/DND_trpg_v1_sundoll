"""Host module operations. Published content and live player state stay separate."""
import copy
import hashlib
import json
from pathlib import Path
import re
import secrets
import time
import tempfile
import shutil
from .workspace import Workspace, read_catalog, write_catalog, cache_root
from .module_store import ModuleStore, RevisionConflict, encode
from .module_packages import ModulePackages
from .resource_database import ResourceDatabase
from . import player_profiles as profiles
from .resources import ResourceStore
from .save_storage import SAVE_WRITE_LOCK, perform_local_save_operation, campaign_catalog


class ModuleRuntime:
    def __init__(self, save_root, app_root):
        self.root, self.app = Path(save_root), Path(app_root)
        self.packages = ModulePackages(save_root, app_root)
        self.store = self.packages.store

    def _transfer_snapshot(self, ledger):
        with self.store.transaction() as db:
            entry = self.store.document(db, 'transfer-authority', 'local')
            if not entry:
                value = {'authority':secrets.token_hex(32)}
                self.store.write_document(db,'transfer-authority','local','',value,0)
            else: value = entry['data']
        return dict(authority=value['authority'], lootHash=hashlib.sha256(encode(ledger.get('mapItems',{})).encode()).hexdigest())

    def _check_transfer(self, db, payload, kind, identity):
        snapshot = payload.get('resourceSnapshot')
        opposite = 'player' if kind == 'progress' else 'progress'
        previous = [json.loads(row[0]) for row in db.execute("SELECT payload FROM documents WHERE kind=?",('transfer-'+opposite,))]
        if snapshot:
            if any((p.get('snapshot') or {}).get('authority') == snapshot['authority'] and p['snapshot']['lootHash'] != snapshot['lootHash'] for p in previous):
                raise RevisionConflict('战役进度包与玩家包的战利品版本不一致；请从来源程序重新成套导出，以免复制已领取物品')
        elif previous and (kind == 'player' or payload.get('mapItems')):
            raise RevisionConflict('此旧模块缺少战利品版本，请从新版来源程序重新导出')
        if kind == 'progress':
            from .resources import tokens
            referenced = {t.get('ownerPlayerId') for _,t in tokens(payload.get('state',{})) if t.get('ownedPieceId')}
            imported = {p['playerId'] for p in previous if snapshot and p.get('snapshot') == snapshot}
            if any(self.store.document(db,'player-library',pid) and pid not in imported for pid in referenced):
                raise RevisionConflict('此进度引用的玩家已在本机独立成长，不能混入另一时间的战利品；可导入战役内容包另开冒险')
        value = {'snapshot':snapshot, 'playerId':identity} if kind == 'player' else {'snapshot':snapshot,'campaignId':identity}
        existing = self.store.document(db,'transfer-'+kind,identity)
        if not existing: self.store.write_document(db,'transfer-'+kind,identity,'',value,0)

    def ensure_empty_runtime(self):
        database = ResourceDatabase(self.root)
        if database.active(): return
        if list(Workspace(self.root).players.glob('*/当前档案.json')) or (self.root / '玩家档案/冒险资源.json').exists():
            raise ValueError('现有玩家数据须先完成模块迁移；未修改旧档')
        database.activate(dict(characters={'@global':{}}, backpacks={}, mapItems={}), {}, {'emptyInstall': True})

    def create_run(self, identity, request_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', str(request_id)): raise ValueError('操作编号无效')
        module = self.packages.payload(identity)
        if module.get('archived'): raise ValueError('请先恢复已卸载的模块')
        if module['manifest']['kind'] not in ('campaign-content', 'campaign-progress'): raise ValueError('请选择战役模块')
        progress = module['manifest']['kind'] == 'campaign-progress'
        with SAVE_WRITE_LOCK, profiles.LOCK:
            self.ensure_empty_runtime()
            with self.store.transaction() as db:
                previous = self.store.document(db, 'module-launch', request_id)
                if previous:
                    if previous['data']['moduleId'] != identity: raise RevisionConflict('操作编号冲突')
                    launch = previous['data']
                else:
                    cid = module['payload']['state'].get('campaignId') if progress else 'c-' + secrets.token_hex(16)
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', str(cid)): raise ValueError('战役进度身份无效')
                    launch = dict(moduleId=identity, campaignId=cid, createdAt=int(time.time()*1000))
                    self.store.write_document(db, 'module-launch', request_id, identity, launch, 0)
            cid = launch['campaignId']
            rel = '战役/' + cid + '/当前存档.json'
            if Workspace(self.root).save_path(rel.split('/')).is_file() or any(r['id'] == cid for r in campaign_catalog(self.root)): return launch
            payload = copy.deepcopy(module['payload'])
            if progress:
                with self.store.transaction() as db: self._check_transfer(db,payload,'progress',cid)
            state = payload['state']
            # Names stay intact. IDs for the new run are distinct from all other runs.
            identities = {m['id'] for m in state['maps']}
            identities.update(t['id'] for m in state['maps'] for t in m.get('tokens', []))
            ids = {} if progress else {old: 'run-' + hashlib.sha256((cid + ':' + old).encode()).hexdigest()[:24] for old in identities}
            def remap(node):
                if isinstance(node, dict): return {k: remap(v) for k,v in node.items()}
                if isinstance(node, list): return [remap(v) for v in node]
                return ids.get(node, node) if isinstance(node, str) else node
            state = remap(state)
            state.update(campaignId=cid, campaignName=module['manifest']['name'], moduleId=identity)
            state.pop('_ownedPieceLocations', None)
            for m in state['maps']:
                for token in m.get('tokens', []):
                    if token.get('ownedPieceId'):
                        # Progress packages can reference a player, but never recreate it.
                        token.pop('characterRevision', None)
            template_ids = self._merge_templates(payload.get('templates', []), identity, cid)
            for m in state['maps']:
                for t in m.get('tokens', []):
                    if t.get('sourcePresetId') in template_ids: t['sourcePresetId'] = template_ids[t['sourcePresetId']]
            self._merge_items(payload.get('items', []), identity, cid, state['campaignName'])
            if payload.get('mapItems'):
                store = profiles.Store(self.root, self.app, cache_root(self.root,self.app))
                resources = ResourceStore(store, profiles)
                ledger = resources.ledger()
                if cid not in ledger.get('mapItems', {}):
                    groups = {}
                    for old_mid, group in payload['mapItems'].items():
                        g = remap(group)
                        if not progress:
                            g['receipts'] = {}; g['lockChecks'] = {}; g['revision'] = 0
                        for marker in ([] if progress else g['markers']):
                            marker['id'] = 'loot-' + hashlib.sha256((cid+marker['id']).encode()).hexdigest()[:32]
                            marker['lockAttempts'] = {}
                            for item in marker['items']:
                                item['id'] = 'content-' + hashlib.sha256((cid+item['id']).encode()).hexdigest()[:32]
                        groups[ids.get(old_mid, old_mid)] = g
                    ledger.setdefault('mapItems', {})[cid] = groups
                    resources.save(ledger)
            self._publish_support_files(payload, cid)
            document = dict(format='sangduoer-campaign', schemaVersion=5, campaignId=cid,
                            campaignName=state['campaignName'], savedAt=int(time.time()*1000), state=state)
            perform_local_save_operation(dict(op='write-campaign',path=rel,text=encode(document),expectedHash=None), self.root)
            return launch

    def _publish_support_files(self, payload, cid):
        suffixes = {'application/pdf':'.pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
                    'text/plain':'.txt','audio/mpeg':'.mp3','audio/ogg':'.ogg','audio/wav':'.wav','audio/mp4':'.m4a','audio/x-m4a':'.m4a'}
        for field, folder in (('documents','文档'),('music','音乐')):
            for entry in payload.get(field, []):
                url = entry.get('fileUrl', '')
                if not url.startswith('/api/module-assets/'): raise ValueError('随包资料缺少本地资源')
                digest = url.rsplit('/',1)[-1]
                asset = self.store.asset(digest)
                if not asset or asset[1] not in suffixes: raise ValueError('随包资料格式不支持')
                name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(entry.get('name') or '资料'))[:100]
                workspace = Workspace(self.root)
                base = workspace.campaign(cid)/'资料' if workspace.active else self.root/'模块资料'
                target = base/folder/'战役'/cid/(name+'-'+digest[:10]+suffixes[asset[1]])
                cursor = workspace.root
                for part in target.relative_to(workspace.root).parts:
                    cursor = cursor / part
                    if cursor.is_symlink(): raise ValueError('随包资料目录不允许符号链接')
                target.parent.mkdir(parents=True,exist_ok=True)
                if target.exists():
                    if self.store.hash_file(target) != digest: raise ValueError('随包资料副本已修改，请先保留再重试')
                    continue
                temporary = target.with_name(target.name+'.tmp-'+secrets.token_hex(6))
                try:
                    shutil.copyfile(asset[0], temporary)
                    temporary.replace(target)
                finally:
                    if temporary.exists(): temporary.unlink()

    def _merge_templates(self, templates, module_id, campaign_id=""):
        path = self.root / '棋子库/棋子库.json'
        try: data = read_catalog(self.root, 'template')
        except FileNotFoundError: data = dict(format='sangduoer-library', schemaVersion=1, presets=[])
        known = {p['id'] for p in data['presets']}
        identities = {}
        for preset in templates:
            preset = copy.deepcopy(preset)
            if preset.get('ownedPieceId') or preset.get('characterId'): raise ValueError('角色不能自动进入模板库')
            old_id = preset['id']
            preset['id'] = 'tpl-' + hashlib.sha256((module_id+':'+campaign_id+':'+preset['id']).encode()).hexdigest()[:24]
            identities[old_id] = preset['id']
            if preset['id'] not in known:
                preset['moduleId'] = module_id
                if campaign_id: preset['campaignId'] = campaign_id
                data['presets'].append(preset); known.add(preset['id'])
        data['savedAt'] = int(time.time()*1000)
        write_catalog(self.root, 'template', data)
        return identities

    def _merge_items(self, items, module_id, cid='', name=''):
        from .item_library import ItemLibrary
        store = profiles.Store(self.root, self.app, cache_root(self.root,self.app))
        library = ItemLibrary(store, profiles)
        data = library.read()
        known = {p['id'] for p in data['templates']}
        from .inventory import item_definition
        for item in items:
            key = 'item-' + hashlib.sha256((module_id+':'+cid+':'+item['id']).encode()).hexdigest()[:24]
            if key not in known:
                data['templates'].append(dict(item_definition(item, ValueError), id=key, version=1, archived=False,
                    **library.metadata(dict(scope='campaign' if cid else 'general', campaignId=cid, campaignName=name))))
                known.add(key)
        data['revision'] += 1
        write_catalog(self.root, 'item-template', data)

    def activate_general(self, identity):
        from .module_management import apply_general
        return apply_general(self,identity)

    def export_player(self, pid, destination):
        store = profiles.Store(self.root, self.app, cache_root(self.root,self.app))
        with profiles.LOCK:
            resources = ResourceStore(store, profiles)
            if not resources.database.active(): raise ValueError('请先完成角色模块迁移')
            lib = store.library(pid)
            ledger = resources.ledger()
            chars = {p['ownedPieceId']: ledger['characters']['@global'][p['ownedPieceId']] for p in lib['pieces']}
            payload = dict(profile=store.read(pid), library=lib, characters=chars, backpack=resources.read(pid), resourceSnapshot=self._transfer_snapshot(ledger))
            return self.packages.export(destination, 'player', payload['profile']['name'], payload, 'player-' + pid)

    def export_campaign(self, cid, kind, destination):
        from .save_storage import campaign_catalog, local_save_target
        if kind not in ('campaign-content','campaign-progress'): raise ValueError('请选择内容包或进度包')
        with SAVE_WRITE_LOCK, profiles.LOCK:
            record = next((r for r in campaign_catalog(str(self.root)) if r['id'] == cid), None)
            if not record: raise ValueError('战役不存在，请先保存')
            document = json.loads(Path(local_save_target(record['_path'], 'read', self.root)).read_text('utf-8'))
            state = copy.deepcopy(document.get('state', document))
            source_paths = {t.get('iconImgPath') for m in state['maps'] for t in m.get('tokens', []) if not t.get('ownedPieceId')}
            library_path = self.root / '棋子库/棋子库.json'
            try: library = read_catalog(self.root, 'template')
            except FileNotFoundError: library = {'presets': []}
            templates = [p for p in library['presets'] if not p.get('characterId') and not p.get('ownedPieceId') and
                         (str(p.get('category','')).startswith(state.get('campaignName','')+'/') or p.get('iconImgPath') in source_paths and p.get('iconImgPath'))]
            state.pop('library', None); state.pop('_ownedPieceLocations', None)
            if kind == 'campaign-content':
                state.pop('parkedOwnedPieces', None); state.pop('travelBasketTokens', None)
                state.pop('journal', None); state.pop('encounter', None); state['selectedId'] = None
                for m in state['maps']:
                    m['tokens'] = [t for t in m.get('tokens', []) if not t.get('ownedPieceId')]
                    m['doodles'] = []
                    for token in m['tokens']:
                        for field in ('ownerPlayerId','owner','characterRevision'): token.pop(field, None)
                for card in state.get('prepHandbook', []):
                    if isinstance(card, dict): card.pop('completed', None)
            store = profiles.Store(self.root, self.app, cache_root(self.root,self.app))
            from .item_library import ItemLibrary
            items = [i for i in ItemLibrary(store, profiles).read()['templates'] if not i['archived'] and (i['scope']=='general' or i.get('campaignId')==cid)]
            ledger = ResourceStore(store, profiles).ledger()
            payload = dict(state=state, templates=templates, items=items, mapItems=ledger.get('mapItems',{}).get(cid,{}), documents=[], music=[])
            if kind == 'campaign-progress': payload['resourceSnapshot'] = self._transfer_snapshot(ledger)
            if kind == 'campaign-content':
                payload['mapItems'] = copy.deepcopy(payload['mapItems'])
                for group in payload['mapItems'].values():
                    group.update(revision=0, receipts={}, lockChecks={})
                    for marker in group.get('markers', []):
                        marker.update(revision=0, lockAttempts={})
                        for item in marker.get('items', []):
                            for field in ('ownerPlayerId','ownerCharacterId','sourceEventId','grantedBy'):
                                item.pop(field, None)
            for folder, field, extensions in (('文档','documents',{'.pdf','.docx','.txt'}),('音乐','music',{'.mp3','.ogg','.wav','.m4a'})):
                workspace = Workspace(self.root)
                if workspace.active:
                    import mimetypes
                    for support_root in workspace.support_roots(folder):
                        for file in support_root.rglob('*'):
                            if file.is_file() and not file.is_symlink() and file.suffix.lower() in extensions and any(part == cid or part.startswith(cid+'-') for part in file.parts):
                                url = self.store.put_asset(file.read_bytes(), mimetypes.guess_type(str(file))[0], 'campaign:'+cid)
                                payload[field].append({'name':file.stem,'fileUrl':url})
                for path in (() if Workspace(self.root).active else (self.app/'asset'/folder).rglob('*')):
                    if not path.is_file() or path.is_symlink() or path.suffix.lower() not in extensions: continue
                    if any(part.startswith(cid+'-') or part==state.get('campaignName') for part in path.parts):
                        payload[field].append({'name':path.stem,'fileUrl':'/'+path.relative_to(self.app).as_posix()})
            if state.get('moduleId'):
                source = self.packages.payload(state['moduleId'])['payload']
                for field in ('documents','music'): payload[field].extend(source.get(field, []))
            return self.packages.export(destination, kind, state.get('campaignName','战役'), payload)

    def activate_player(self, identity):
        from .inventory import InventoryStore
        module = self.packages.payload(identity)
        if module.get('archived'): raise ValueError('请先恢复已卸载的模块')
        if module['manifest']['kind'] != 'player': raise ValueError('请选择玩家模块')
        payload = copy.deepcopy(module['payload'])
        pid = payload['profile']['playerId']
        store = profiles.Store(self.root, self.app, cache_root(self.root,self.app))
        with profiles.LOCK:
            self.ensure_empty_runtime()
            lib = payload['library']
            if type(lib.get('revision')) is not int or lib['revision'] < 1 or not isinstance(lib.get('grants'), dict):
                raise ValueError('角色名册版本无效')
            if not isinstance(payload['profile'].get('name'), str) or not 1 <= len(payload['profile']['name']) <= 24:
                raise ValueError('玩家名称无效')
            resources = ResourceStore(store, profiles)
            for oid, character in payload['characters'].items():
                if character.get('base') != resources.base(character.get('base', {})) or character.get('runtime') != resources.runtime(character.get('runtime', {}), character['base']):
                    raise ValueError('角色资源格式无效')
                if type(character.get('revision')) is not int or character['revision'] < 1: raise ValueError('角色修订无效')
            # Reuse the complete inventory validator, including old receipts/removals.
            # Old single-character packages have an unambiguous destination.
            # Never guess which same-account character owns a legacy item.
            for item in payload['backpack'].get('items', []) + [r['item'] for r in payload['backpack'].get('removedItems', [])]:
                if not item.get('ownerCharacterId'):
                    if len(payload['characters']) != 1:
                        raise ValueError('旧玩家包有未分配角色的物品，请先在原工作区指定角色归属后重新导出')
                    item['ownerCharacterId'] = next(iter(payload['characters']))
                if item['ownerCharacterId'] not in payload['characters']:
                    raise ValueError('玩家包中的物品没有有效的所属角色')
            with tempfile.TemporaryDirectory(prefix='sundoll-player-validate-') as directory:
                path = Path(directory) / 'bag.json'
                profiles.atomic(path, dict(payload['backpack'], revision=max(1,payload['backpack'].get('revision',0))))
                InventoryStore(store, profiles)._read_file(pid, path)
            with self.store.transaction() as db:
                imported = self.store.document(db, 'player-import', identity)
                if imported:
                    if imported['data']['dataHash'] != module['manifest']['dataHash']: raise RevisionConflict('玩家包版本冲突')
                    if imported['data'].get('published') and not store.path(pid, '当前档案.json').exists():
                        raise RevisionConflict('该玩家已归档，重复导入不能自动恢复旧身份')
                else:
                    self._check_transfer(db,payload,'player',pid)
                    if store.path(pid, '当前档案.json').exists() or self.store.document(db, 'player-library', pid):
                        raise RevisionConflict('此玩家身份已存在；请对比版本，不能覆盖当前角色和库存')
                    from .authentication import name_key
                    if any(name_key(p['name']) == name_key(payload['profile']['name']) for p in store.players()):
                        raise RevisionConflict('已有同名玩家，请先在玩家档案中区分姓名再导入')
                    for piece in lib['pieces']:
                        oid = piece['ownedPieceId']
                        if self.store.document(db, 'runtime-character', oid): raise RevisionConflict('角色身份已存在')
                        if type(piece.get('revision')) is not int or piece['revision'] < 1: raise ValueError('角色版本无效')
                        piece['characterId'] = oid
                    incoming_items = {i['id'] for i in payload['backpack']['items']}
                    for row in db.execute("SELECT payload FROM documents WHERE kind='runtime-backpack'"):
                        if incoming_items & {i['id'] for i in json.loads(row[0])['items']}:
                            raise RevisionConflict('物品身份已存在，不能重复导入同一物品')
                    for oid, c in payload['characters'].items():
                        self.store.write_document(db, 'runtime-character', oid, pid, c, 0)
                    self.store.write_document(db, 'runtime-backpack', pid, pid, payload['backpack'], 0)
                    self.store.write_document(db, 'player-library', pid, pid, lib, 0)
                    meta = self.store.document(db, 'runtime-meta', 'resources')
                    self.store.write_document(db, 'runtime-meta', 'resources', '', meta['data'], meta['revision'])
                    self.store.write_document(db, 'player-import', identity, pid, {'dataHash':module['manifest']['dataHash']}, 0)
            # Publication is last. A crash before publication is resumed by the
            # immutable import receipt, without creating another identity.
            if not store.path(pid, '当前档案.json').exists():
                if not (store.auth_root/(pid+'.json')).exists(): store.rotate(pid, creating=True)
                profiles.atomic(store.path(pid, '当前档案.json'), dict(payload['profile'], enabled=True))
            store.name_directory(pid)
            with self.store.transaction() as db:
                imported = self.store.document(db, 'player-import', identity)
                if not imported['data'].get('published'):
                    self.store.write_document(db, 'player-import', identity, pid, dict(imported['data'],published=True), imported['revision'])
            return {'playerId': pid, 'characters': len(lib['pieces'])}
