"""Read-only historical save and immutable asset audit. Never restore a save."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def record(path, root):
    raw = path.read_bytes()
    value = json.loads(raw)
    state = value.get('state', value)
    if not isinstance(state, dict) or not isinstance(state.get('maps'), list):
        return None
    maps = state['maps']
    tokens = [t for m in maps if isinstance(m, dict) for t in m.get('tokens', []) if isinstance(t, dict)]
    return dict(path=str(path.relative_to(root)), sha256=digest(raw), bytes=len(raw),
                campaignId=value.get('campaignId', state.get('campaignId')),
                schemaVersion=value.get('schemaVersion'), savedAt=value.get('savedAt', 0),
                mapCount=len(maps), tokenCount=len(tokens),
                mapIds=[m.get('id') for m in maps], tokenIds=[t.get('id') for t in tokens],
                ownedPieceIds=sorted({str(t['ownedPieceId']) for t in tokens if t.get('ownedPieceId')}),
                playerIds=sorted({str(t['ownerPlayerId']) for t in tokens if t.get('ownerPlayerId')}),
                assetIds=sorted(set(re.findall(r'/api/module-assets/([0-9a-f]{64})', raw.decode()))),
                stateKeys=sorted(state))


def duplicates(values):
    return [k for k, count in Counter(map(str, values)).items() if count > 1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--save-root', type=Path, help='要检查的房间运行数据/存档目录')
    args = parser.parse_args()
    root, output = args.root.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    selected = args.save_root.resolve() if args.save_root else root/'程序包/运行数据/存档'
    if not (selected/'模块存储/模块.sqlite3').is_file():
        rooms = sorted((root/'程序包/运行数据/战役空间').glob('r*/运行数据/存档'))
        if args.save_root or len(rooms) != 1: parser.error('请用 --save-root 明确选择要检查的房间存档')
        selected = rooms[0]
    workspace = selected.parent.parent
    scopes = ['程序包/运行数据/战役空间', '程序包/运行数据/历史归档', '程序包/战役包', '程序包/运行数据/整套备份', '程序包/运行数据/恢复备份',
              '开发包/维护记录', '开发包/修复备份', '旧恢复备份']
    unique, conflicts, errors, scanned = {}, 0, [], 0
    formal = []
    for scope in scopes:
        for path in (root / scope).rglob('*.json'):
            if '保存冲突' in path.name:
                conflicts += 1
                continue
            if path.name not in ('当前存档.json', '迁移前存档.json'):
                continue
            scanned += 1
            try:
                entry = record(path, root)
                if not entry:
                    continue
                entry['copies'] = []
                if entry['sha256'] in unique:
                    unique[entry['sha256']]['copies'].append(entry['path'])
                else:
                    unique[entry['sha256']] = entry
                if path.parent.parent == workspace/'战役包':
                    formal.append(entry.copy())
            except (ValueError, TypeError, OSError) as error:
                errors.append(dict(path=str(path.relative_to(root)), error=str(error)))
    grouped = defaultdict(list)
    for entry in unique.values():
        grouped[str(entry['campaignId'])].append(entry)
    comparisons, structural = [], []
    for current in formal:
        current_state = json.loads((root / current['path']).read_text())['state']
        ids = set(map(str, current['mapIds']))
        references = []
        for name in ['activeMapId', 'presentedMapId']:
            value = current_state.get(name)
            if value is not None and str(value) not in ids:
                references.append(dict(field=name, value=value))
        for value in current_state.get('presentedMapIds', []):
            if str(value) not in ids:
                references.append(dict(field='presentedMapIds', value=value))
        structural.append(dict(path=current['path'], duplicateMapIds=duplicates(current['mapIds']),
                               duplicateTokenIds=duplicates(current['tokenIds']), invalidMapReferences=references))
        older = sorted(grouped[str(current['campaignId'])], key=lambda r: r['savedAt'] or 0)
        for previous in older:
            if previous['sha256'] == current['sha256']:
                continue
            comparisons.append(dict(campaignId=current['campaignId'], previous=previous['path'],
                                    previousSavedAt=previous['savedAt'], current=current['path'],
                                    mapCounts=[previous['mapCount'], current['mapCount']],
                                    tokenCounts=[previous['tokenCount'], current['tokenCount']],
                                    removedMapIds=sorted(set(map(str, previous['mapIds']))-ids),
                                    addedMapIds=sorted(ids-set(map(str, previous['mapIds']))),
                                    removedOwnedPieceIds=sorted(set(previous['ownedPieceIds'])-set(current['ownedPieceIds'])),
                                    addedOwnedPieceIds=sorted(set(current['ownedPieceIds'])-set(previous['ownedPieceIds'])),
                                    removedAssetIds=sorted(set(previous['assetIds'])-set(current['assetIds']))))
    database = selected/'模块存储/模块.sqlite3'
    with tempfile.TemporaryDirectory(prefix='sundoll-readonly-audit-') as tmp:
        import sys
        sys.path.insert(0, str(root/'程序包/主程序'))
        from server.sqlite_read import open_readonly_database
        source = open_readonly_database(database)
        db = sqlite3.connect(str(Path(tmp) / 'snapshot.sqlite3'))
        source.backup(db)
        source.close()
        integrity = db.execute('PRAGMA quick_check').fetchall()
        foreign_keys = db.execute('PRAGMA foreign_key_check').fetchall()
        assets = db.execute('SELECT id,size FROM assets').fetchall()
        asset_results, available = [], set()
        for asset_id, size in assets:
            locations = db.execute('SELECT path FROM asset_locations WHERE id=?', (asset_id,)).fetchall()
            candidates = [workspace / p for (p,) in locations]
            candidates.append(database.parent / '原始资源' / asset_id[:2] / asset_id)
            paths = list(dict.fromkeys(p for p in candidates if p.is_file()))
            checked = [dict(path=str(p.relative_to(root)), bytes=p.stat().st_size,
                            hashMatches=digest(p.read_bytes()) == asset_id) for p in paths]
            valid = any(r['hashMatches'] and r['bytes'] == size for r in checked)
            if valid:
                available.add(asset_id)
            asset_results.append(dict(id=asset_id, expectedBytes=size, valid=valid, locations=checked))
        documents = db.execute('SELECT kind,id,owner,revision,payload FROM documents').fetchall()
        document_counts = Counter(row[0] for row in documents)
        missing_references = []
        for kind, doc_id, owner, revision, payload in documents:
            missing = set(re.findall(r'/api/module-assets/([0-9a-f]{64})', payload))-available
            if missing:
                missing_references.append(dict(kind=kind, id=doc_id, owner=owner, missing=sorted(missing)))
        db.close()
    findings = dict(formal=formal, scannedCurrentOrMigrationFiles=scanned,
                    uniqueSnapshots=len(unique), excludedConflictFiles=conflicts, parseErrors=errors,
                    historyByCampaign={key:len(value) for key,value in grouped.items()},
                    currentStructuralChecks=structural,
                    database=dict(quickCheck=integrity, foreignKeyErrors=foreign_keys,
                                  documentCounts=dict(document_counts), assetCount=len(assets),
                                  invalidAssets=[r for r in asset_results if not r['valid']],
                                  missingDocumentAssetReferences=missing_references),
                    interpretation='Differences alone do not establish loss; compare migration and intentional deletion records.')
    for name, value in [('历史存档清单.json', list(unique.values())), ('历史版本差异.json', comparisons),
                        ('资源完整性.json', asset_results), ('只读数据核查.json', findings)]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k:v for k,v in findings.items() if k!='formal'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
