"""Private, consistent workspace snapshots and restart-only journalled restoration.

Restore never swaps a live database. Startup owns the OS project lock, completes
an idempotent journal, then initializes services. The engine is never restored.
"""
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import time
import zipfile
from .workspace import Workspace, atomic_json
from .module_store import ModuleStore
from .save_storage import SAVE_WRITE_LOCK, recover_campaign_projection
from . import player_profiles as profiles

TOP = ('通用包','战役包','玩家包','运行数据/存档','运行数据/认证','运行数据/协调记录','运行数据/.sundoll-cache/联机资源')
SKIP = {'.server.lock','导出暂存','导入暂存','迁移前备份'}
MAX_BYTES = 16 * 1024**3


def epoch(save_root):
    path=Path(save_root).parent/'工作区代次.json'
    return json.loads(path.read_text('utf-8'))['epoch'] if path.is_file() else ''


class Backups:
    def __init__(self, save_root):
        self.save=Path(save_root)
        self.workspace=Workspace(save_root)
        if not self.workspace.active: raise ValueError('整套备份需要同级模块工作区')
        self.root=self.workspace.root
        self.home=self.root/'运行数据/整套备份'
        self.journal=self.root/'运行数据/待恢复.json'

    def path(self, identity):
        if not re.fullmatch(r'b[0-9a-f]{32}',str(identity)): raise ValueError('备份编号无效')
        return self.workspace.checked(self.home/identity)

    def list(self):
        out=[]
        for path in self.home.glob('b*/备份清单.json'):
            self.workspace.checked(path)
            try:
                m=json.loads(path.read_text('utf-8'))
                out.append({k:m[k] for k in ('id','name','createdAt','bytes','fileCount')})
            except (ValueError,KeyError,OSError): continue
        return sorted(out,key=lambda m:m['createdAt'],reverse=True)

    @staticmethod
    def allowed(name):
        p=PurePosixPath(name)
        return (not p.is_absolute() and '\\' not in name and not any(x in ('','.','..') for x in name.split('/'))
                and not any(x in SKIP for x in p.parts)
                and any(name.startswith(t+'/') for t in TOP)
                and not name.endswith(('-wal','-shm')))

    def create(self, name='手动备份'):
        with SAVE_WRITE_LOCK, profiles.LOCK:
            recover_campaign_projection(self.save)
            store=ModuleStore(self.save)
            db=store.connect()  # completes committed module projections
            db.close()
            identity='b'+secrets.token_hex(16)
            folder=self.path(identity)
            temp=folder.with_name('.'+identity+'.tmp')
            temp.mkdir(parents=True)
            try:
                dbfile=store.database
                for top in TOP:
                    source=self.root/top
                    self.workspace.checked(source)
                    if not source.exists(): continue
                    for path in source.rglob('*'):
                        rel=path.relative_to(self.root).as_posix()
                        self.workspace.checked(path)
                        if not path.is_file() or not self.allowed(rel) or path==dbfile: continue
                        target=temp/'数据'/rel;target.parent.mkdir(parents=True,exist_ok=True)
                        shutil.copy2(path,target)
                target=temp/'数据'/dbfile.relative_to(self.root);target.parent.mkdir(parents=True,exist_ok=True)
                with sqlite3.connect(str(dbfile)) as src, sqlite3.connect(str(target)) as dst: src.backup(dst)
                files=[]
                for path in sorted((temp/'数据').rglob('*')):
                    if path.is_file(): files.append(dict(path=path.relative_to(temp/'数据').as_posix(),size=path.stat().st_size,sha256=ModuleStore.hash_file(path)))
                manifest=dict(format='sundoll-workspace-backup',schemaVersion=1,id=identity,name=str(name)[:120],
                    createdAt=int(time.time()*1000),files=files,fileCount=len(files),bytes=sum(x['size'] for x in files))
                atomic_json(temp/'备份清单.json',manifest)
                self.validate(temp)
                temp.replace(folder)
                return {k:manifest[k] for k in ('id','name','createdAt','bytes','fileCount')}
            finally:
                if temp.exists(): shutil.rmtree(temp)

    def validate(self, folder):
        folder=Path(folder)
        m=json.loads((folder/'备份清单.json').read_text('utf-8'))
        if m.get('format')!='sundoll-workspace-backup' or m.get('schemaVersion')!=1: raise ValueError('备份格式不兼容')
        files=m.get('files',[])
        if not isinstance(files,list) or len(files)>100000 or sum(f['size'] for f in files)>MAX_BYTES: raise ValueError('备份容量超限')
        names=set()
        for entry in files:
            name=entry['path']
            if name in names or not self.allowed(name): raise ValueError('备份含有无效文件路径')
            names.add(name);path=folder/'数据'/name
            cursor=folder
            for part in ('数据',*PurePosixPath(name).parts):
                cursor=cursor/part
                if cursor.is_symlink(): raise ValueError('备份不能含有符号链接')
            if not path.is_file() or path.stat().st_size!=entry['size'] or ModuleStore.hash_file(path)!=entry['sha256']: raise ValueError('备份校验失败：'+name)
        marker='运行数据/存档/工作区.json';dbrel='运行数据/存档/模块存储/模块.sqlite3'
        if not {marker,dbrel}<=names: raise ValueError('备份缺少工作区或协调数据库')
        actual={p.relative_to(folder/'数据').as_posix() for p in (folder/'数据').rglob('*') if p.is_file()}
        if actual!=names: raise ValueError('备份文件清单不完整')
        config=json.loads((folder/'数据'/marker).read_text('utf-8'))
        if config.get('format')!=4 or config.get('workspace')!='../..': raise ValueError('备份工作区配置无效')
        with sqlite3.connect((folder/'数据'/dbrel).as_uri()+'?mode=ro&immutable=1',uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok': raise ValueError('备份数据库损坏')
            # Every registered original must be recoverable from the snapshot.
            for digest, in db.execute('SELECT id FROM assets'):
                pending='运行数据/存档/模块存储/原始资源/'+digest[:2]+'/'+digest
                locations=[r[0] for r in db.execute('SELECT path FROM asset_locations WHERE id=?',(digest,))]
                if not any(n in names and ModuleStore.hash_file(folder/'数据'/n)==digest for n in [pending,*locations]): raise ValueError('备份缺少原始素材：'+digest)
        return m

    def export(self, identity, destination):
        folder=self.path(identity);self.validate(folder)
        with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as out:
            out.write(folder/'备份清单.json','备份清单.json')
            for path in (folder/'数据').rglob('*'):
                if path.is_file(): out.write(path,path.relative_to(folder).as_posix())

    def import_archive(self, source):
        identity='b'+secrets.token_hex(16);folder=self.path(identity);temp=folder.with_name('.'+identity+'.tmp')
        temp.mkdir(parents=True)
        try:
            with zipfile.ZipFile(source) as archive:
                entries=archive.infolist();names=[e.filename for e in entries]
                if len(names)!=len(set(names)) or len(names)>100001 or sum(e.file_size for e in entries)>MAX_BYTES: raise ValueError('备份容量超限或含有重复路径')
                for e in entries:
                    if e.flag_bits&1 or (e.external_attr>>16)&0o170000==0o120000: raise ValueError('备份不能包含加密文件或链接')
                    if e.filename!='备份清单.json' and not (e.filename.startswith('数据/') and self.allowed(e.filename[3:])): raise ValueError('备份路径无效')
                    target=temp/e.filename;target.parent.mkdir(parents=True,exist_ok=True)
                    with archive.open(e) as src,target.open('wb') as dst: shutil.copyfileobj(src,dst)
            m=self.validate(temp);m['id']=identity;m['name']='导入 · '+str(m.get('name','备份'))[:110]
            atomic_json(temp/'备份清单.json',m);temp.replace(folder)
            return dict(id=identity,name=m['name'])
        finally:
            if temp.exists(): shutil.rmtree(temp)

    def stage_restore(self, identity):
        with SAVE_WRITE_LOCK,profiles.LOCK:
            if self.journal.exists(): raise ValueError('已有恢复正在等待重启')
            source=self.path(identity);self.validate(source)
            rollback=self.create('恢复前自动备份')
            job=self.root/'运行数据/恢复任务'/('r'+secrets.token_hex(16));job.mkdir(parents=True)
            shutil.copytree(source/'数据',job/'新数据')
            # Copy and validate before publishing a recovery intent.
            shutil.copy2(source/'备份清单.json',job/'备份清单.json')
            (job/'新数据').rename(job/'数据');self.validate(job);(job/'数据').rename(job/'新数据')
            targets=list(TOP)
            targets.remove('运行数据/存档')
            names={p.name for p in self.save.iterdir() if p.name!='.server.lock'} | {p.name for p in (job/'新数据/运行数据/存档').iterdir() if p.name!='.server.lock'}
            targets += ['运行数据/存档/'+name for name in sorted(names)]
            atomic_json(self.journal,dict(job=job.relative_to(self.root).as_posix(),targets=targets,rollbackId=rollback['id']))
            return dict(backupId=identity,rollbackId=rollback['id'],restartRequired=True)


def recover_pending(save_root):
    """Must run before any service opens SQLite; caller holds ProjectServerLock."""
    save=Path(save_root);root=save.parent.parent;journal=root/'运行数据/待恢复.json'
    if not journal.exists(): return False
    data=json.loads(journal.read_text('utf-8'))
    if not re.fullmatch(r'运行数据/恢复任务/r[0-9a-f]{32}',str(data.get('job'))): raise ValueError('恢复任务路径无效')
    job=root/data['job']
    for rel in data['targets']:
        if rel not in TOP and not (rel.startswith('运行数据/存档/') and len(PurePosixPath(rel).parts)==3 and PurePosixPath(rel).name not in ('.','..','.server.lock')): raise ValueError('恢复目标无效')
        target=root/rel;old=job/'原数据'/rel;new=job/'新数据'/rel;done=job/'完成'/hashlib_name(rel)
        for path in (target,old,new,done):
            cursor=root
            for part in path.relative_to(root).parts:
                cursor=cursor/part
                if cursor.is_symlink(): raise ValueError('恢复目标含有链接')
        if done.exists(): continue
        old.parent.mkdir(parents=True,exist_ok=True);target.parent.mkdir(parents=True,exist_ok=True)
        retired=job/'退役'/hashlib_name(rel)
        if not retired.exists():
            if not old.exists() and target.exists():
                target.rename(old); sync_dirs(target.parent,old.parent)
            atomic_json(retired,True)
        if new.exists():
            new.rename(target); sync_dirs(new.parent,target.parent)
        atomic_json(done,True)
    atomic_json(root/'运行数据/工作区代次.json',dict(epoch=secrets.token_hex(24)))
    journal.unlink()
    return True


def hashlib_name(value):
    import hashlib
    return hashlib.sha256(value.encode()).hexdigest()+'.json'


def sync_dirs(*paths):
    if os.name == 'nt': return
    for path in paths:
        fd=os.open(str(path),os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
