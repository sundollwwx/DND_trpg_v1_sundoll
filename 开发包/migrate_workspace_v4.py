"""Prepare a new sibling workspace from v3, without modifying the source."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import time
PACKAGE = Path(__file__).resolve().parent.parent/'程序包'
APP = next(p for p in (PACKAGE/'主程序',PACKAGE/'应用') if (p/'start_server.py').exists())
sys.path.insert(0,str(APP))
from server.module_store import ModuleStore, encode
from server.module_packages import ModulePackages
from server.workspace import Workspace, enable, atomic_json, read_catalog, write_catalog
from server.save_storage import campaign_catalog, local_save_target
from server.player_profiles import Store
from server.resource_database import ResourceDatabase


def fingerprints(root):
    return {str(p.relative_to(root)):(p.stat().st_size,p.stat().st_mtime_ns)
            for p in root.rglob('*') if p.is_file() and not p.name.endswith(('-shm','-wal','.lock'))}


def migrate(source, app, destination):
    source, app, destination = Path(source).resolve(),Path(app).resolve(),Path(destination).resolve()
    if destination.exists(): raise ValueError('演练目标必须不存在')
    if Workspace(source).active: raise ValueError('此工具只迁移 v3，不覆盖已有同级工作区')
    before = fingerprints(source)
    source_store = ModuleStore(source)
    # Read-only SQLite connection; online backup includes committed WAL safely.
    reader = sqlite3.connect(str(source_store.database))
    reader.execute('PRAGMA query_only=ON')
    try:
        version = reader.execute('PRAGMA data_version').fetchone()[0]
        destination.mkdir(parents=True)
        save = destination/'运行数据/存档'
        save.mkdir(parents=True)
        shutil.copytree(source,save,dirs_exist_ok=True,ignore=shutil.ignore_patterns('*.sqlite3','*.sqlite3-wal','*.sqlite3-shm','.server.lock'))
        database = save/'模块存储/模块.sqlite3'
        writer = sqlite3.connect(database)
        try: reader.backup(writer)
        finally: writer.close()
        # Externalize dependencies while the copied v3 paths are still available.
        packages = ModulePackages(save,app)
        db = packages.store.connect()
        try: rows = db.execute('SELECT kind,id,owner,revision,payload FROM documents').fetchall()
        finally: db.close()
        for row in rows:
            payload = packages.portable(json.loads(row['payload']),'workspace:'+row['kind']+':'+row['id'])
            with packages.store.transaction() as db:
                db.execute('UPDATE documents SET payload=? WHERE kind=? AND id=?',(encode(payload),row['kind'],row['id']))
        library = packages.portable(read_catalog(save,'template'),'workspace:templates')
        items = packages.portable(read_catalog(save,'item-template'),'workspace:items')
        folders, names = {}, {}
        for path in (save/'战役').glob('*/当前存档.json'):
            data = json.loads(path.read_text('utf-8'))
            cid = data.get('campaignId') or data.get('state',{}).get('campaignId')
            if not cid: raise ValueError('战役缺少身份：'+path.parent.name)
            folders[cid] = path.parent.name
            names[cid] = data.get('campaignName') or data.get('state',{}).get('campaignName','')
            atomic_json(path,packages.portable(data,'campaign:'+cid))
        # Preserve current canonical character revisions; only media representation changes.
        shutil.move(str(save/'战役'),str(destination/'战役包'))
        (destination/'玩家包').mkdir()
        for path in (save/'玩家档案').glob('p*/当前档案.json'):
            pid = path.parent.name
            target = destination/'玩家包'/pid
            target.mkdir()
            shutil.copy2(path,target/path.name)
        auth = save/'玩家档案/认证'
        if auth.exists(): shutil.copytree(auth,destination/'运行数据/认证')
        # Old JSON, receipts and deleted profiles remain in the recovery archive,
        # never as a second writable source beside module-owned records.
        recovery = destination/'运行数据/迁移留存'
        recovery.mkdir()
        for name in ('玩家档案','棋子库','修复备份'):
            if (save/name).exists(): shutil.move(str(save/name),str(recovery/name))
        enable(destination,folders,names)
        write_catalog(save,'template',library)
        write_catalog(save,'item-template',items)
        store = ModuleStore(save)
        with store.transaction() as db:
            # Summary signatures and paths are rebuildable; committed campaign revisions are not.
            db.execute("DELETE FROM documents WHERE kind='campaign-summary'")
            db.execute('INSERT OR IGNORE INTO module_outbox SELECT kind,id FROM documents')
        # Campaign handbooks and music live with their owning module as well.
        workspace = Workspace(save)
        for folder in ('文档','音乐'):
            for content in (app/'asset'/folder).rglob('*'):
                if not content.is_file() or content.is_symlink(): continue
                relative = content.relative_to(app/'asset'/folder)
                cid = next((cid for cid in folders if any(p == cid or p.startswith(cid+'-') or p == names[cid] for p in relative.parts)),None)
                base = workspace.campaign(cid) if cid else workspace.general/'本地资料'
                target = base/'资料'/folder/relative
                target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(content,target)
        # Copy imported support material too.
        for folder in ('文档','音乐'):
            for content in (save/'模块资料'/folder).rglob('*'):
                if not content.is_file() or content.is_symlink(): continue
                relative = content.relative_to(save/'模块资料'/folder)
                cid = next((c for c in folders if c in relative.parts),None)
                base = workspace.campaign(cid) if cid else workspace.general/'本地资料'
                target = base/'资料'/folder/relative
                target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(content,target)
        if (save/'模块资料').exists(): shutil.move(str(save/'模块资料'),str(recovery/'模块资料'))
        profiles = Store(save,app,destination/'运行数据/.sundoll-cache/联机资源')
        players = profiles.players()
        characters = [p for player in players for p in profiles.library(player['playerId'])['pieces']]
        db = store.connect()
        try:
            assets = db.execute('SELECT id FROM assets').fetchall()
            routed = {r[0] for r in db.execute('SELECT DISTINCT id FROM asset_locations')}
            document_count = db.execute('SELECT count(*) FROM documents').fetchone()[0]
            assert db.execute('SELECT count(*) FROM module_records').fetchone()[0] == document_count
        finally: db.close()
        for row in assets:
            digest = row[0]
            if store.hash_file(store.asset_path(digest)) != digest: raise ValueError('原图校验失败')
            staged = store.assets/digest[:2]/digest
            if digest in routed and staged.exists(): staged.unlink()
        # Unreferenced originals are retained for recovery, never silently discarded.
        records = campaign_catalog(save)
        if before != fingerprints(source) or version != reader.execute('PRAGMA data_version').fetchone()[0]:
            raise RuntimeError('源存档在演练中变化，请以保存关闭后的最新数据重新迁移')
        credentials = [p for p in (destination/'运行数据/认证').glob('p*.json')]
        assert all(p.read_bytes()==(source/'玩家档案/认证'/p.name).read_bytes() for p in credentials)
        report = dict(format=4,preparedAt=int(time.time()*1000),sourceUnchanged=True,
            players=len(players),characters=len(characters),campaigns=[dict(id=r['id'],maps=len(r['state']['maps'])) for r in records],
            preservedCredentials=len(credentials),moduleRecords=document_count,verifiedAssets=len(assets),
            routedAssets=len(routed),templates=len(read_catalog(save,'template')['presets']),items=len(read_catalog(save,'item-template')['templates']))
        atomic_json(destination/'运行数据/同级模块迁移报告.json',report)
        return report
    finally: reader.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--app',required=True);parser.add_argument('--destination',required=True)
    args=parser.parse_args();print(json.dumps(migrate(args.source,args.app,args.destination),ensure_ascii=False))
