"""Portable data packages. No executable files, absolute paths or credentials.

Installation validates the entire archive before registering anything. Existing
module identities are immutable: reimport is idempotent, changed versions never
silently replace live state.
"""
import copy
import hashlib
import io
import json
import mimetypes
from pathlib import Path
import re
import secrets
import time
from urllib.parse import unquote, urlparse
import zipfile
from .module_store import ModuleStore, ASSET_URL, DIGEST, encode, RevisionConflict
from .content_packages import ContentPackages, local_package_id, package_metadata

KINDS = ('general', 'campaign-content', 'campaign-progress', 'player')
MAX_PACKAGE_BYTES = 2 * 1024 ** 3
PRIVATE_KEYS = {'credential','loginCode','password','authVersion','sessionToken','_authVersion','authentication'}


def walk(value):
    if isinstance(value, dict):
        for child in value.values(): yield from walk(child)
    elif isinstance(value, list):
        for child in value: yield from walk(child)
    elif isinstance(value, str): yield value


def strip_secrets(value):
    if isinstance(value, dict): return {k: strip_secrets(v) for k,v in value.items() if k not in PRIVATE_KEYS}
    if isinstance(value, list): return [strip_secrets(v) for v in value]
    return value


from .workspace import Workspace, cache_root


class ModulePackages:
    def __init__(self, save_root, app_root):
        self.store = ModuleStore(save_root)
        self.save_root, self.app = Path(save_root), Path(app_root).resolve()

    def portable(self, value, scope):
        """Resolve only explicit media fields; prose/URLs in handouts stay prose."""
        value = self.store.externalize(strip_secrets(value), scope)
        media_keys = {'mapData','iconImgPath','iconImg','iconImgHd','image','cover','assetUrl','fileUrl'}
        def visit(node, field=''):
            if isinstance(node, dict): return {k: visit(v, k) for k,v in node.items()}
            if isinstance(node, list): return [visit(v, field) for v in node]
            if not isinstance(node, str) or not node or field not in media_keys: return node
            if node.startswith(ASSET_URL): return node
            parsed = urlparse(node)
            if parsed.scheme in ('http', 'https'):
                raise ValueError('完整模块仍有外部图片，请先导入本地：' + field)
            path = unquote(parsed.path).replace('\\','/')
            if path.startswith('/api/player-art/'):
                digest = path.rsplit('/', 1)[-1]
                if not DIGEST.fullmatch(digest): raise ValueError('立绘资源编号无效')
                target = Workspace(self.save_root).players / '资源' / digest
            elif path.startswith('/api/assets/'):
                digest = path.rsplit('/', 1)[-1]
                if not DIGEST.fullmatch(digest): raise ValueError('缓存资源编号无效')
                target = cache_root(self.save_root,self.app) / digest
            else:
                path = re.sub(r'^(?:\.\./)+', '', path).lstrip('/')
                if path.startswith('立绘/') or path.startswith('显示缓存/'):
                    path = 'asset/棋子库/' + path
                if path.startswith('棋子库/'): path = 'asset/' + path
                target = (self.app / path).resolve()
                if self.app not in target.parents: raise ValueError('素材路径超出应用目录')
            if not target.is_file() or target.is_symlink(): raise ValueError('模块缺少素材：' + str(node))
            raw = target.read_bytes()
            mime = mimetypes.guess_type(str(target))[0]
            if raw.startswith(b'\x89PNG'): mime = 'image/png'
            elif raw.startswith(b'\xff\xd8'): mime = 'image/jpeg'
            elif raw.startswith(b'GIF'): mime = 'image/gif'
            elif raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': mime = 'image/webp'
            return self.store.put_asset(raw, mime, scope)
        return visit(value)

    def export(self, destination, kind, name, payload, module_id=None):
        if kind not in KINDS: raise ValueError('模块种类无效')
        module_id = module_id or 'mod-' + secrets.token_hex(16)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', module_id): raise ValueError('模块编号无效')
        payload = copy.deepcopy(payload)
        if kind != 'player':
            primary, packages = self.content_graph(dict(moduleId=module_id, kind=kind, name=str(name)[:120]), payload)
            payload['contentPackage'] = primary
            known = {p['id']:p for p in packages}
            for field in ('templates', 'items'):
                for entry in payload.get(field, []):
                    scope = entry.get('scope', primary['scope'])
                    identity = entry.get('contentPackageId') or primary['id']
                    if not entry.get('contentPackageId') and scope == 'general' and primary['scope'] == 'campaign':
                        identity = next((p['id'] for p in packages if p['scope']=='general'),
                            local_package_id('legacy-dependency:' + module_id + ':general:'))
                    if identity not in known:
                        known[identity] = package_metadata(dict(id=identity, name=entry.get('campaignName') or name,
                            scope=scope, sourceCampaignId=entry.get('campaignId', '')))
                    entry['contentPackageId'] = identity
                    entry.setdefault('contentEntryId', entry['id'])
                    if field == 'items':
                        entry['scope'] = known[identity]['scope']
                        entry['campaignId'] = known[identity]['sourceCampaignId']
            payload['contentPackages'] = sorted(known.values(), key=lambda p:p['id'])
        payload = self.portable(payload, 'module:' + module_id)
        body = encode(payload).encode()
        assets = []
        for digest in sorted({v[len(ASSET_URL):] for v in walk(payload) if v.startswith(ASSET_URL)}):
            asset = self.store.asset(digest)
            if not asset: raise ValueError('模块依赖缺失：' + digest)
            path, mime, size = asset
            if self.store.hash_file(path) != digest: raise ValueError('模块原图校验失败')
            assets.append({'id': digest, 'mime': mime, 'size': size})
        manifest = dict(format='sundoll-module', schemaVersion=4, moduleId=module_id, kind=kind,
                        name=str(name)[:120], createdAt=int(time.time()*1000), dataHash=hashlib.sha256(body).hexdigest(), assets=assets)
        if kind != 'player': manifest['contentPackageId'] = payload['contentPackage']['id']
        self.validate_payload(kind, payload)
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.' + secrets.token_hex(6) + '.tmp')
        try:
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('manifest.json', encode(manifest))
                archive.writestr('data.json', body)
                for asset in assets:
                    archive.write(self.store.asset_path(asset['id']), 'assets/' + asset['id'])
            temporary.replace(destination)
        finally:
            if temporary.exists(): temporary.unlink()
        return manifest

    @staticmethod
    def content_graph(manifest, payload):
        scope = 'general' if manifest['kind'] == 'general' else 'campaign'
        primary = package_metadata(payload.get('contentPackage') or dict(
            id=local_package_id('archive:' + manifest['moduleId']), name=manifest.get('name') or manifest['moduleId'],
            scope=scope, sourceCampaignId=payload.get('state', {}).get('campaignId', '') if scope == 'campaign' else ''))
        if primary['scope'] != scope: raise ValueError('模块类型与内容包归属不一致')
        raw = payload.get('contentPackages', [primary])
        if 'contentPackage' not in payload and 'contentPackages' not in payload:
            for item in payload.get('items', []):
                item_scope = item.get('scope', scope)
                if item_scope == 'general' and scope == 'campaign':
                    dependency = dict(id=local_package_id('legacy-dependency:' + manifest['moduleId'] + ':general:'),
                        name=(manifest.get('name') or manifest['moduleId'])[:110]+' · 通用内容', scope='general', sourceCampaignId='')
                    if dependency not in raw: raw.append(dependency)
        if not isinstance(raw, list) or len(raw)>256: raise ValueError('内容包依赖清单无效')
        packages = [package_metadata(p) for p in raw]
        if len({p['id'] for p in packages}) != len(packages): raise ValueError('内容包依赖重复')
        if scope == 'general' and any(p['scope'] != 'general' for p in packages):
            raise ValueError('通用内容包不能包含战役专属定义')
        if primary not in packages: raise ValueError('内容包清单缺少自身身份')
        return primary, packages

    @staticmethod
    def validate_payload(kind, payload):
        if not isinstance(payload, dict) or strip_secrets(payload) != payload:
            raise ValueError('模块包含无效或认证资料')
        allowed = {'general': {'templates','items','contentPackage','contentPackages','dailyLife'}, 'campaign-content': {'state','templates','items','documents','music','mapItems','contentPackage','contentPackages','contentSelection'},
                   'campaign-progress': {'state','templates','items','documents','music','mapItems','resourceSnapshot','contentPackage','contentPackages','contentSelection'},
                   'player': {'profile','library','characters','backpack','resourceSnapshot','contentDependencies'}}[kind]
        if set(payload) - allowed: raise ValueError('模块含有不属于此类型的数据')
        if 'dailyLife' in payload:
            from .daily_life import validate_bundle
            validate_bundle(payload['dailyLife'])
        if kind != 'player':
            for item in payload.get('items', []):
                if item.get('sourceScope')=='personal' or any(item.get(k) for k in ('ownerCharacterId','ownerPlayerId','sourcePlayerId','sourceCharacterId','boundCharacterId')):
                    raise ValueError('角色专属物品应保留在玩家包，不能作为共享模板导出')
        if kind == 'general':
            for template in payload.get('templates', []):
                if any(template.get(key) for key in ('ownedPieceId','characterId','ownerPlayerId','campaignId')):
                    raise ValueError('通用内容包不能包含真实玩家身份或战役专属模板')
        if kind != 'player' and 'contentPackage' in payload:
            primary, packages = ModulePackages.content_graph(dict(moduleId='validation', kind=kind), payload)
            known = {p['id']:p for p in packages}
            for entry in payload.get('items', []) + payload.get('templates', []):
                if entry.get('contentPackageId') not in known: raise ValueError('模板缺少内容包来源')
                if entry.get('scope') and entry['scope'] != known[entry['contentPackageId']]['scope']:
                    raise ValueError('物品归属与内容包不一致')
            selection = payload.get('contentSelection')
            if selection is not None and (not isinstance(selection, dict) or
                    selection.get('sourcePackageId') != primary['id'] or
                    not isinstance(selection.get('enabledPackageIds'), list) or len(selection['enabledPackageIds'])>256 or
                    any(not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', str(v)) for v in selection['enabledPackageIds'])):
                raise ValueError('战役内容包启用清单无效')
        snapshot = payload.get('resourceSnapshot')
        if snapshot is not None and (not isinstance(snapshot, dict) or set(snapshot) not in (
                    {'authority','lootHash'}, {'authority','lootHash','inventoryHash'}) or
                not DIGEST.fullmatch(str(snapshot.get('authority'))) or not DIGEST.fullmatch(str(snapshot.get('lootHash'))) or
                ('inventoryHash' in snapshot and not DIGEST.fullmatch(str(snapshot['inventoryHash'])))):
            raise ValueError('模块资源版本信息无效')
        if kind.startswith('campaign'):
            state = payload.get('state')
            if not isinstance(state, dict) or not isinstance(state.get('maps'), list): raise ValueError('战役地图数据无效')
            map_ids, token_ids = set(), set()
            for entry in state['maps']:
                mid = entry.get('id') if isinstance(entry, dict) else None
                if not isinstance(mid, str) or not mid or len(mid) > 128: raise ValueError('战役地图身份无效')
                if mid in map_ids: raise ValueError('战役地图身份重复')
                map_ids.add(mid)
                if not isinstance(entry.get('tokens', []), list): raise ValueError('战役棋子数据无效')
                for token in entry.get('tokens', []):
                    tid = token.get('id') if isinstance(token, dict) else None
                    if not isinstance(tid, str) or not tid or len(tid) > 128: raise ValueError('战役棋子身份无效')
                    if tid in token_ids: raise ValueError('战役棋子身份重复')
                    token_ids.add(tid)
            if kind == 'campaign-content':
                off_map = state.get('travelBasketTokens', [])
                if (state.get('parkedOwnedPieces') or
                        any(t.get('ownedPieceId') or t.get('ownerPlayerId') for m in state['maps'] for t in m.get('tokens', [])) or
                        any(isinstance(t, dict) and (t.get('ownedPieceId') or t.get('ownerPlayerId')) for t in off_map)):
                    raise ValueError('战役内容包不能包含真实玩家身份')
                for group in payload.get('mapItems', {}).values():
                    for marker in group.get('markers', []):
                        if any(i.get('sourceScope')=='personal' or i.get('boundCharacterId') for i in marker.get('items', [])):
                            raise ValueError('角色专属物品应随玩家包导出，不能混入战役内容包')
        if kind == 'player':
            dependencies = payload.get('contentDependencies', [])
            if not isinstance(dependencies, list) or len(dependencies)>512 or len({p.get('id') for p in dependencies if isinstance(p,dict)}) != len(dependencies):
                raise ValueError('玩家包的内容来源清单无效')
            for dependency in dependencies:
                if not isinstance(dependency, dict) or dependency.get('scope') not in ('general','campaign','personal'):
                    raise ValueError('玩家包的内容来源分类无效')
                if dependency['scope']=='personal':
                    if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', str(dependency.get('id'))) or not re.fullmatch(r'p[0-9a-f]{32}', str(dependency.get('sourcePlayerId'))):
                        raise ValueError('角色专属内容的来源无效')
                else: package_metadata(dependency)
            profile = payload.get('profile', {})
            pid = profile.get('playerId')
            if set(profile) - {'playerId','name','enabled','revision'} or not re.fullmatch(r'p[0-9a-f]{32}', str(pid)):
                raise ValueError('玩家档案无效')
            pieces = payload.get('library', {}).get('pieces')
            chars = payload.get('characters')
            if not isinstance(pieces, list) or not isinstance(chars, dict): raise ValueError('角色名册无效')
            identities = set()
            for piece in pieces:
                oid = piece.get('ownedPieceId')
                if not re.fullmatch(r'o[0-9a-f]{32}', str(oid)) or oid in identities or piece.get('ownerPlayerId') != pid: raise ValueError('角色身份或归属冲突')
                identities.add(oid)
            if identities != set(chars) or any(c.get('ownerPlayerId') != pid or c.get('id') != oid for oid,c in chars.items()): raise ValueError('角色主档缺失或混入其他玩家')
            bag = payload.get('backpack', {})
            if bag.get('playerId') != pid or any(i.get('ownerCharacterId') and i['ownerCharacterId'] not in identities for i in bag.get('items', [])):
                raise ValueError('背包归属不一致')

    def inspect(self, source):
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            names = [e.filename for e in entries]
            if len(names) > 10000 or len(names) != len(set(names)) or sum(e.file_size for e in entries) > MAX_PACKAGE_BYTES:
                raise ValueError('模块容量超限或存在重复文件')
            if any(e.flag_bits & 1 or (e.external_attr >> 16) & 0o170000 == 0o120000 for e in entries):
                raise ValueError('模块不能包含加密文件或符号链接')
            for name in names:
                if name not in ('manifest.json','data.json') and not re.fullmatch(r'assets/[0-9a-f]{64}', name):
                    raise ValueError('模块包含不允许的文件路径')
            for key in ('manifest.json', 'data.json'):
                if key not in names or archive.getinfo(key).file_size > 16*1024*1024:
                    raise ValueError('模块清单缺失或过大')
            manifest = json.loads(archive.read('manifest.json'))
            if manifest.get('format') != 'sundoll-module' or manifest.get('schemaVersion') not in (3,4) or manifest.get('kind') not in KINDS:
                raise ValueError('模块格式版本不兼容')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', str(manifest.get('moduleId'))): raise ValueError('模块编号无效')
            body = archive.read('data.json')
            if hashlib.sha256(body).hexdigest() != manifest.get('dataHash'): raise ValueError('模块数据校验失败')
            payload = json.loads(body)
            self.validate_payload(manifest['kind'], payload)
            if manifest['schemaVersion'] == 4 and manifest['kind'] != 'player':
                if manifest.get('contentPackageId') != payload.get('contentPackage', {}).get('id'):
                    raise ValueError('内容包身份与清单不一致')
            assets = manifest.get('assets')
            if not isinstance(assets, list): raise ValueError('模块资源清单无效')
            expected = {'manifest.json','data.json'}
            for asset in assets:
                digest = asset.get('id')
                if not DIGEST.fullmatch(str(digest)): raise ValueError('资源编号无效')
                name = 'assets/' + digest
                if name in expected or name not in names: raise ValueError('资源重复或缺失')
                expected.add(name)
                if type(asset.get('size')) is not int or asset['size'] != archive.getinfo(name).file_size or asset['size'] > 128*1024*1024: raise ValueError('资源大小无效')
                with archive.open(name) as handle:
                    digest_value = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(1024*1024), b''): digest_value.update(chunk)
                if digest_value.hexdigest() != digest: raise ValueError('资源内容校验失败')
            referenced = {v[len(ASSET_URL):] for v in walk(payload) if v.startswith(ASSET_URL)}
            if set(names) != expected or referenced != {a['id'] for a in assets}: raise ValueError('模块资源依赖不完整')
            return manifest, payload

    def install(self, source, expected_hash=None):
        manifest, payload = self.inspect(source)
        identity = manifest['moduleId']
        with self.store.transaction() as db:
            old = self.store.document(db, 'installed-module', identity)
            if old:
                previous = old['data']['manifest']
                if previous['kind'] != manifest['kind']: raise RevisionConflict('模块类型不能改变')
                if previous['dataHash'] == manifest['dataHash']:
                    return dict(manifest, alreadyInstalled=True)
                if expected_hash != previous['dataHash']:
                    raise RevisionConflict('此模块已有不同版本，请先预览并确认更新')
                history = identity + '-' + str(old['revision'])
                content = self.store.document(db, 'module-content', identity)
                self.store.write_document(db, 'module-history', history, identity,
                    {'manifest':previous, 'payload':content['data']}, 0)
            elif expected_hash is not None:
                raise RevisionConflict('安装状态已变化，请重新预览')
            with zipfile.ZipFile(source) as archive:
                for asset in manifest['assets']:
                    self.store.put_asset(archive.read('assets/' + asset['id']), asset['mime'], 'module:' + identity, db)
            self.store.write_document(db, 'installed-module', identity, '', {'manifest': manifest}, old['revision'] if old else 0)
            content = self.store.document(db, 'module-content', identity)
            self.store.write_document(db, 'module-content', identity, '', payload, content['revision'] if content else 0)
            if manifest['kind'] != 'player':
                _, packages = self.content_graph(manifest, payload)
                content = ContentPackages(self.save_root)
                for package in packages: content.register(package, db, module_id=identity)
        return dict(manifest, alreadyInstalled=False, updated=bool(old))

    def catalog(self):
        db = self.store.connect()
        try:
            return [dict(json.loads(row[0])['manifest'], archived=json.loads(row[0]).get('archived',False)) for row in db.execute("SELECT payload FROM documents WHERE kind='installed-module'")]
        finally: db.close()

    def payload(self, identity, allow_archived=True):
        db = self.store.connect()
        try:
            doc = self.store.document(db, 'installed-module', identity)
            content = self.store.document(db, 'module-content', identity)
        finally: db.close()
        if not doc or not content: raise ValueError('模块尚未安装')
        return dict(doc['data'], payload=content['data'])
