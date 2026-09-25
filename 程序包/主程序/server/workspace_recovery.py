"""Explicit offline rebuild of a missing coordinator from complete module records."""
import json
from pathlib import Path
from .workspace import Workspace
from .module_store import ModuleStore


def rebuild(save_root):
    workspace=Workspace(save_root)
    if not workspace.active:raise ValueError('需要同级模块工作区')
    store=ModuleStore(save_root)
    if store.database.exists():raise ValueError('协调库仍存在；不覆盖现有数据')
    if (workspace.save/'玩家目录调整.json').exists():
        raise ValueError('玩家目录调整未完成；请先恢复协调库并完成目录调整')
    if (workspace.root/'运行数据/模块发布中.json').exists():
        raise ValueError('上次模块保存尚未发布完整；必须恢复原协调库或完整备份')
    index=json.loads((workspace.root/'运行数据/协调记录/索引快照.json').read_text('utf-8'))
    records=[]
    for ref in index['module_records']:
        path=workspace.checked(workspace.root/ref['path'])
        record=json.loads(path.read_text('utf-8'))
        if record['format'] != 4 or (record['kind'],record['id']) != (ref['kind'],ref['id']):raise ValueError('模块记录身份不一致')
        records.append(record)
    for asset in index['assets']:
        candidates=[workspace.checked(workspace.root/r['path']) for r in index['asset_locations'] if r['id']==asset['id']]
        candidates.append(store.assets/asset['id'][:2]/asset['id'])
        if not any(p.is_file() and store.hash_file(p)==asset['id'] for p in candidates):raise ValueError('重建缺少原始资源：'+asset['id'])
    # Build to a new file; publication is the final step, never a half-restored DB.
    temporary=store.database.with_name('重建中.sqlite3')
    if temporary.exists():raise ValueError('有未处理的重建临时文件')
    original=store.database
    store.database=temporary
    try:
        db=store.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            for table,columns in (('assets',('id','mime','size')),('asset_links',('scope','asset_id')),
                ('receipts',('scope','id','signature','result')),('migrations',('id','payload')),
                ('module_records',('kind','id','path')),('asset_locations',('id','path'))):
                for row in index[table]:db.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')',tuple(row[c] for c in columns))
            for record in records:
                db.execute('INSERT INTO documents VALUES (?,?,?,?,?)',(record['kind'],record['id'],record['owner'],record['revision'],json.dumps(record['data'],ensure_ascii=False,separators=(',',':'))))
            # These files already are the validated snapshot; do not republish during recovery.
            db.execute('DELETE FROM module_outbox')
            db.execute('COMMIT')
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        finally:db.close()
        temporary.replace(original)
    finally:
        if temporary.exists():temporary.unlink()
    return dict(documents=len(records),assets=len(index['assets']))
