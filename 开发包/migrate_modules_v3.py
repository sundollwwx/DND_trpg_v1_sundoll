"""Reviewed migration, always into a NEW directory; never edits the source.

The output is an isolated rehearsal until the application is stopped and the
verified directory is installed. Authentication files are copied unchanged.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import sys
PACKAGE = Path(__file__).resolve().parent.parent/'程序包'
APP = next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0,str(APP))
from server import player_profiles as profiles
from server.resources import ResourceStore
from server.resource_database import ResourceDatabase
from server.module_store import ModuleStore
from server.save_storage import perform_local_save_operation


def migrate(source, destination, app):
    source, destination, app = Path(source), Path(destination), Path(app)
    if ResourceDatabase(source).active(): raise ValueError('源目录已经是模块版，请使用模块导出或完整备份，不可重新导入旧账本')
    if destination.exists(): raise ValueError('迁移目标必须是尚不存在的新目录')
    destination.mkdir(parents=True, mode=0o700)
    report = {'format': 3, 'sourceFiles': [], 'decisions': {
        'blackWalnuts': '同一玩家账号下的两个独立角色，保留各自数值',
        'newPlayers': ['忒修斯', '潘塞尔', '拉斐尔'],
        'mumu': '桑哆尔的持久伙伴',
        'campaignUnits': ['轮式魔导炮台', '小恶魔', '妖精马']}, 'characters': [], 'campaigns': []}
    for path in source.rglob('*'):
        if not path.is_file() or path.is_symlink(): continue
        rel = path.relative_to(source)
        if any(part in ('自动备份', '资源自动备份', '已删除', '模块存储') for part in rel.parts): continue
        if path.name.startswith('.') or path.suffix == '.tmp': continue
        if rel.parts[0] == '战役' and path.name not in ('当前存档.json', '已删除.json') and not path.name.startswith('封面.'):
            continue
        target = destination / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        digest = ModuleStore.hash_file(target)
        if ModuleStore.hash_file(path) != digest: raise ValueError('复制时源存档发生变化，请先保存并关闭主控台')
        report['sourceFiles'].append({'path': rel.as_posix(), 'sha256': digest, 'bytes': target.stat().st_size})
    # A legacy campaign may already use compact originals after a normal save.
    # Carry those verified originals across without activating/copying the source database.
    source_assets = ModuleStore(source)
    target_assets = ModuleStore(destination)
    if source_assets.database.exists():
        from server.module_packages import walk
        refs = set()
        for item in report['sourceFiles']:
            file = destination / item['path']
            if file.suffix != '.json': continue
            try: document = json.loads(file.read_text('utf-8'))
            except (ValueError, UnicodeError): continue
            refs.update(v for v in walk(document) if v.startswith('/api/module-assets/'))
        for ref in refs:
            asset = source_assets.asset(ref.rsplit('/',1)[-1])
            if not asset: raise ValueError('原存档缺少已引用素材：' + ref)
            if target_assets.put_asset(asset[0].read_bytes(), asset[1], 'migration-v3') != ref:
                raise ValueError('原存档素材校验不匹配：' + ref)
    store = profiles.Store(destination, app, app.parent / '用户数据/.sundoll-cache/联机资源')
    library_path = destination / '棋子库/棋子库.json'
    library = json.loads(library_path.read_text('utf-8'))
    presets = {p['id']: p for p in library['presets']}
    players = {p['name']: p['playerId'] for p in store.players()}
    for name in ('忒修斯', '潘塞尔', '拉斐尔'):
        if name not in players: players[name] = store.create(name)['profile']['playerId']
    campaigns = {}
    for path in destination.glob('战役/*/当前存档.json'):
        if (path.parent / '已删除.json').exists(): continue
        document = json.loads(path.read_text('utf-8'))
        state = document.get('state', document)
        campaigns[state.get('campaignId', path.parent.name)] = (path, document, state)
    # Explicit user-reviewed source identities; names are not used to merge.
    links = [('l67', '忒修斯', 't279'), ('l68', '黑胡桃', 't280'),
             ('l69', '潘塞尔', 't281'), ('l70', '拉斐尔', 't278')]
    if 'c184' in campaigns:
        state = campaigns['c184'][2]
        for preset_id, player_name, token_id in links:
            pid = players[player_name]
            token = next(t for m in state['maps'] for t in m.get('tokens', []) if t['id'] == token_id)
            if token.get('ownedPieceId'): raise ValueError('旧战役绑定已变化，请重新审核')
            preset = presets[preset_id]
            # Map state is actual play data; template only supplies missing artwork.
            piece_source = dict(preset, **{k: v for k, v in token.items() if v is not None})
            piece_source['sourcePresetId'] = preset_id
            piece = store.grant(pid, piece_source, 'migration-v3-c184-' + preset_id)['pieces'][-1]
            token.update(ownedPieceId=piece['ownedPieceId'], characterId=piece['ownedPieceId'],
                         ownerPlayerId=pid, owner=player_name)
    resources = ResourceStore(store, profiles)
    legacy = resources.ledger()
    from server.module_packages import ModulePackages
    portable = ModulePackages(destination, app)
    global_chars, libraries, bags = {}, {}, {}
    for profile in store.players():
        pid = profile['playerId']
        lib = store.library(pid)
        for piece in lib['pieces']:
            oid = piece['ownedPieceId']
            versions = [(campaign, chars[oid]) for campaign, chars in legacy['characters'].items() if oid in chars]
            if versions:
                first = versions[0][1]
                def normalized_runtime(v):
                    return {'conditions':[], 'spellSlots':{}, 'resourceSlots':{}, **v['runtime']}
                if any(v['base'] != first['base'] or normalized_runtime(v) != normalized_runtime(first) for _, v in versions[1:]):
                    raise ValueError('角色跨战役数值冲突，需审核：' + oid)
                c = copy.deepcopy(first)
                for _, version in versions:
                    for field in ('conditions','spellSlots','resourceSlots'):
                        if field in version['runtime']: c['runtime'].setdefault(field,copy.deepcopy(version['runtime'][field]))
            else:
                candidates = [t for _, _, s in campaigns.values() for m in s.get('maps', []) for t in m.get('tokens', []) if t.get('ownedPieceId') == oid]
                b = resources.base(piece)
                runtimes = [resources.runtime(t, b) for t in candidates]
                if runtimes and any(r != runtimes[0] for r in runtimes[1:]):
                    raise ValueError('角色地图状态冲突，需审核：' + oid)
                c = dict(id=oid, ownerPlayerId=pid, name=piece['name'], base=b,
                         runtime=runtimes[0] if runtimes else resources.runtime(piece, b))
            # Legacy ledger predates conditions/slots. Preserve explicit map state if unambiguous.
            from server.resources import tokens
            candidates = [t for _, _, source in campaigns.values() for _, t in tokens(source) if t.get('ownedPieceId') == oid]
            for field in ('conditions', 'spellSlots', 'resourceSlots'):
                values = [t[field] for t in candidates if field in t]
                if values and any(v != values[0] for v in values[1:]):
                    raise ValueError('角色状态跨地图冲突，需审核：' + oid + ':' + field)
                if values and field not in c['runtime']: c['runtime'][field] = copy.deepcopy(values[0])
            origins = [source.get('campaignName') for _, _, source in campaigns.values()
                       if any(t.get('ownedPieceId') == oid for _,t in tokens(source))]
            if origins: piece['originCampaignName'] = next((name for name in origins if name), '')
            if c['base'] != resources.base(piece):
                raise ValueError('主档与资源账本基础属性冲突，需审核：' + oid)
            c['revision'] = 1000000 + max([v.get('revision', 0) for _, v in versions] or [0])
            c['identityKind'] = 'companion' if piece.get('sourcePresetId') == 'npc-castellan-mumu' else 'character'
            piece.update(characterId=oid, identityKind=c['identityKind'])
            for index, form in enumerate(piece.get('portraitVariants', [])):
                form.setdefault('formId', 'form-' + hashlib.sha256((oid + ':' + str(index)).encode()).hexdigest()[:24])
            piece.pop('campaignStates', None); piece.pop('mapSyncStates', None)
            global_chars[oid] = c
            report['characters'].append({'playerId': pid, 'playerName': profile['name'], 'characterId': oid,
                'name': c['name'], 'kind': c['identityKind'], 'base': c['base'], 'runtime': c['runtime'], 'sourcePresetId': piece.get('sourcePresetId')})
        libraries[pid] = portable.portable(lib, 'player:' + pid)
        bags[pid] = portable.portable(copy.deepcopy(resources.read(pid)), 'bag:' + pid)
        bags[pid]['modular'] = True
    item_library = destination / '玩家档案/物品库.json'
    if item_library.exists():
        profiles.atomic(item_library, portable.portable(json.loads(item_library.read_text('utf-8')), 'item-library'))
    item_ids = set()
    for pid, bag in bags.items():
        for item in bag['items']:
            if item['id'] in item_ids: raise ValueError('跨玩家物品编号冲突：' + item['id'])
            item_ids.add(item['id'])
            cid = item.get('ownerCharacterId')
            if cid and (cid not in global_chars or global_chars[cid]['ownerPlayerId'] != pid):
                raise ValueError('物品角色归属不明确：' + item['id'])
    report['itemCount'] = len(item_ids)
    data = dict(version=1, revision=0, globalCharacters=True, characters={'@global': global_chars},
                backpacks=bags, mapItems=legacy.get('mapItems', {}))
    ResourceDatabase(destination).activate(data, libraries, {'sourceFiles': report['sourceFiles'], 'decisions': report['decisions']})
    removed = set(('l67','l68','l69','l70','l86','l87','l88','l89','npc-castellan-mumu'))
    library['presets'] = [p for p in library['presets'] if p['id'] not in removed]
    library = portable.portable(library, 'template-library')
    profiles.atomic(library_path, library)
    for cid, (path, document, state) in campaigns.items():
        resources.reconcile(state)
        document = portable.portable(document, 'campaign:' + cid)
        before = path.stat().st_size
        digest = hashlib.sha256(path.read_text('utf-8').encode()).hexdigest()
        perform_local_save_operation({'op': 'write-campaign', 'path': path.relative_to(destination).as_posix(),
                                      'text': json.dumps(document, ensure_ascii=False), 'expectedHash': digest}, str(destination))
        report['campaigns'].append({'id': cid, 'beforeBytes': before, 'afterBytes': path.stat().st_size,
                                    'maps': len(state.get('maps', [])), 'tokens': sum(len(m.get('tokens', [])) for m in state.get('maps', []))})
    for item in report['sourceFiles']:
        if ModuleStore.hash_file(source / item['path']) != item['sha256']:
            raise ValueError('迁移过程中源存档发生变化，请先保存并关闭主控台；原存档未修改')
    profiles.atomic(destination / '迁移报告.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--app', default=str(APP))
    args = parser.parse_args()
    report = migrate(args.source, args.destination, args.app)
    print(json.dumps({k: report[k] for k in ('characters', 'itemCount', 'campaigns')}, ensure_ascii=False, indent=2))
