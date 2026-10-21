"""Repair missing portrait bindings without replacing campaign gameplay state."""
import argparse, copy, hashlib, importlib.util, json, sys, time
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]/'程序包'
ROOT = next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0, str(ROOT))
from server.paths import CACHE_ROOT, local_save_root
spec = importlib.util.spec_from_file_location('portrait_profiles', ROOT / 'server/player_profiles.py')
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)

def identity(value):
    return str(value.get('iconImgPath') or value.get('iconImgHd') or value.get('iconImg') or '').replace('\\', '/')

def resolve_source(token, presets):
    explicit = token.get('presetId') or token.get('sourcePresetId')
    found = [p for p in presets if p.get('id') == explicit]
    if len(found) == 1: return found[0]
    image = identity(token)
    found = [p for p in presets if image and any(identity(v) == image for v in [p] + (p.get('portraitVariants') or []))]
    if len(found) == 1: return found[0]
    found = [p for p in presets if p.get('name') == token.get('name') and p.get('type') == token.get('type')]
    return found[0] if len(found) == 1 else None

def supplement(token, source, owned=False):
    before = copy.deepcopy(token)
    forms = copy.deepcopy(token.get('portraitVariants') or [])
    seen = {identity(v) for v in forms}
    for form in source.get('portraitVariants') or []:
        if identity(form) and identity(form) not in seen:
            forms.append(copy.deepcopy(form)); seen.add(identity(form))
    if len(forms) > 24: raise ValueError('形态超出上限：' + token.get('name',''))
    token['portraitVariants'] = forms
    token['sourcePresetId' if owned else 'presetId'] = source.get('sourcePresetId') if owned else source['id']
    if owned: token['ownedPieceRevision'] = source['revision']
    current = next((i for i,v in enumerate(forms) if identity(v) and identity(v) == identity(token)), None)
    if current is not None: token['portraitVariant'] = current
    else: token.pop('portraitVariant', None)
    allowed = {'portraitVariants','portraitVariant','presetId','sourcePresetId','ownedPieceRevision'}
    assert {k:v for k,v in before.items() if k not in allowed} == {k:v for k,v in token.items() if k not in allowed}
    return token != before

def run(save_root, apply=False):
    save_root = Path(save_root)
    from server.workspace import Workspace
    if Workspace(save_root).active: raise ValueError('旧版形态修复工具不适用于同级模块，请在角色名册或棋子库编辑形态')
    presets = json.loads((save_root / '棋子库/棋子库.json').read_text('utf-8'))['presets']
    store = profiles.Store(save_root, ROOT, CACHE_ROOT / '联机资源')
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = save_root / '修复备份' / ('形态绑定-' + stamp)
    changes = []
    owned = {}
    def preserve(path, raw):
        target = backup / path.relative_to(save_root)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists(): target.write_bytes(raw)
    for path in sorted((save_root / '玩家档案').glob('p*/棋子库.json')):
        raw = path.read_bytes()
        library = json.loads(raw)
        for piece in library['pieces']:
            source = resolve_source(piece, presets)
            if not source: continue
            needs = not piece.get('portraitVariants') or not any(p['id'] == piece.get('sourcePresetId') for p in presets)
            if not needs: continue
            changes.append({'kind':'collection','name':piece['name'],'source':source['id'],'forms':len(source.get('portraitVariants') or [])})
            if apply:
                if path.read_bytes() != raw: raise RuntimeError('收藏在修复期间变化，已停止')
                preserve(path, raw)
                store.sync_forms(path.parent.name, piece['ownedPieceId'])
                raw = path.read_bytes()
        library = json.loads(path.read_bytes())
        for piece in library['pieces']: owned[piece['ownedPieceId']] = piece
    for path in sorted((save_root / '战役').glob('*/当前存档.json')):
        raw = path.read_bytes(); document = json.loads(raw); state = document.get('state', document)
        updated = False
        tokens = [t for m in state.get('maps',[]) for t in m.get('tokens',[])]
        tokens += list((state.get('parkedOwnedPieces') or {}).values())
        for token in tokens:
            is_owned = bool(token.get('ownedPieceId'))
            source = owned.get(token.get('ownedPieceId')) if is_owned else resolve_source(token, presets)
            if not source or not source.get('portraitVariants'): continue
            # Respect deliberately customized map rosters; supply missing forms only.
            if not is_owned and token.get('portraitVariantsCustomized'): continue
            if supplement(token, source, is_owned):
                updated = True
                changes.append({'kind':'campaign','name':token.get('name'),'forms':len(token['portraitVariants'])})
        if updated and apply:
            if path.read_bytes() != raw: raise RuntimeError('战役在修复期间变化，已停止')
            preserve(path, raw)
            profiles.atomic(path, document)
    if apply:
        backup.mkdir(parents=True, exist_ok=True)
        profiles.atomic(backup / '修复报告.json', changes)
    return {'changes':changes,'backup':str(backup) if apply else None}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--save-root', default=str(local_save_root()))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.save_root, args.apply), ensure_ascii=False, indent=2))
