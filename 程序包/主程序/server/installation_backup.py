"""Private, offline snapshots of the original workspace and every account room.

An installation lease prevents new services from starting while maintenance owns
the installation. Existing service versions are additionally excluded with their
per-workspace OS locks. Neither backup nor verification opens source databases for
writing. Interrupted restoration blocks service startup until explicit rollback.
"""
from contextlib import ExitStack, closing, contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import sqlite3
import stat
from .save_storage import ProjectServerLock
from .sqlite_read import open_readonly_database
from .workspace import Workspace, atomic_json


FORMAT = 'sundoll-installation-backup'
ROOM_ID = re.compile(r'r[0-9a-f]{32}\Z')
TOP = ('通用包', '战役包', '玩家包', '运行数据')
EXCLUDED_DATA = {'联机', '整套备份', '恢复任务', '安装级恢复任务', '安装级备份'}
EXCLUDED_FILES = {'.server.lock', '.安装维护.lock', '安装级恢复.json',
                  '联机设置.json', '邮箱账号设置.json'}
MAX_BYTES = 64 * 1024**3
MAX_FILES = 500000


def installation_root(save_root):
    """Resolve the maintenance gate even while restoration retires its marker."""
    save = Path(save_root).absolute()
    candidate = save.parent.parent
    if save.name == '存档' and save.parent.name == '运行数据':
        if any((candidate/'运行数据'/name).exists() for name in ('.安装维护.lock','安装级恢复.json')):
            return candidate
    from . import paths
    if save == Path(paths.SAVE_ROOT).absolute():
        if paths.WORKSPACE_ROOT is not None:
            return Path(paths.WORKSPACE_ROOT).absolute()
        return Path(paths.PACKAGE_ROOT).absolute()
    return Workspace(save).root


def _private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def _safe_path(root, path):
    root, path = Path(root).absolute(), Path(path).absolute()
    parts = path.relative_to(root).parts
    if root.is_symlink() or '..' in parts:
        raise ValueError('安装或备份路径不允许符号链接或越界')
    cursor = root
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError('安装或备份路径不允许符号链接')
    return path


def _is_archive(name):
    return str(name).split('/')[:2] == ['运行数据', '历史归档']

def _allowed(name):
    parts = str(name).split('/')
    if (not parts or parts[0] not in TOP or '\\' in name
            or any(p in ('', '.', '..') for p in parts)
            or (not _is_archive(name) and any(p in EXCLUDED_FILES for p in parts))):
        return False
    if parts[0] == '运行数据' and len(parts) > 1 and parts[1] in EXCLUDED_DATA:
        return False
    if parts[:2] == ['运行数据', '战役空间'] and len(parts) > 2:
        return bool(ROOM_ID.fullmatch(parts[2]))
    return True


def _hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _sync(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)


class InstallationLease:
    """Hold shared=True for a service's lifetime; maintenance uses exclusive."""
    def __init__(self, root, shared=False, allow_pending=False):
        self.root = Path(root).absolute()
        _safe_path(self.root, self.root / '运行数据')
        self.root.joinpath('运行数据').mkdir(parents=True, exist_ok=True)
        self.path = _safe_path(self.root, self.root / '运行数据/.安装维护.lock')
        self.handle = self.path.open('a+b')
        self.path.chmod(0o600)
        try:
            if os.name == 'nt':
                import msvcrt
                self.handle.seek(0); self.handle.write(b'0'); self.handle.flush(); self.handle.seek(0)
                mode = msvcrt.LK_NBRLCK if shared else msvcrt.LK_NBLCK
                msvcrt.locking(self.handle.fileno(), mode, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            journal = _safe_path(self.root, self.root / '运行数据/安装级恢复.json')
            if not allow_pending and journal.exists():
                raise RuntimeError('安装级恢复尚未完成；请先运行管理员 recover 命令回滚，服务未启动')
        except OSError:
            self.close()
            raise RuntimeError('服务或安装级维护仍在运行；请完整停服后重试') from None
        except BaseException:
            self.close()
            raise

    def close(self):
        if not self.handle.closed: self.handle.close()


def _inventory(root):
    files, directories = [], []
    for top in TOP:
        source = _safe_path(root, root / top)
        if not source.exists(): continue
        for folder, names, leaves in os.walk(source, followlinks=False):
            path = Path(folder)
            rel = path.relative_to(root).as_posix()
            if not _allowed(rel):
                names[:] = []
                continue
            directories.append(rel)
            keep = []
            for name in sorted(names):
                child = path / name
                child_rel = child.relative_to(root).as_posix()
                if not _allowed(child_rel): continue
                _safe_path(root, child)
                if not child.is_dir(): raise ValueError('备份目录类型无效')
                keep.append(name)
            names[:] = keep
            for name in sorted(leaves):
                child = path / name
                child_rel = child.relative_to(root).as_posix()
                if not _allowed(child_rel): continue
                _safe_path(root, child)
                if name.endswith(('-wal', '-shm', '-journal')) and not _is_archive(child_rel): continue
                if not stat.S_ISREG(child.stat().st_mode): raise ValueError('备份仅允许普通文件')
                files.append(child_rel)
    if len(files) + len(directories) > MAX_FILES:
        raise ValueError('安装备份条目数量超过上限')
    return sorted(files), sorted(directories)


def _rooms(root):
    database = root / '运行数据/认证/邮箱账号.sqlite3'
    rooms = []
    if database.exists():
        with closing(open_readonly_database(database)) as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='rooms'").fetchone():
                rooms = [row[0] for row in db.execute('SELECT id FROM rooms ORDER BY id')]
                for rid in rooms:
                    if not ROOM_ID.fullmatch(rid): raise ValueError('账号数据库含有无效空间身份')
                invalid = db.execute("SELECT 1 FROM room_members m LEFT JOIN rooms r ON r.id=m.room_id "
                    "LEFT JOIN accounts a ON a.id=m.account_id WHERE r.id IS NULL OR a.id IS NULL "
                    "OR m.role NOT IN ('owner','dm','player') LIMIT 1").fetchone()
                invalid_owner = db.execute("SELECT r.id FROM rooms r LEFT JOIN room_members m "
                    "ON m.room_id=r.id AND m.role='owner' GROUP BY r.id HAVING count(m.account_id)!=1 LIMIT 1").fetchone()
                invalid_invite = db.execute('SELECT 1 FROM room_invitations i LEFT JOIN rooms r '
                    'ON r.id=i.room_id WHERE r.id IS NULL LIMIT 1').fetchone()
                if invalid or invalid_owner or invalid_invite:
                    raise ValueError('账号、空间或成员关系不完整，未进行恢复')
    directory = _safe_path(root, root / '运行数据/战役空间')
    materialized = set()
    if directory.is_dir():
        for path in directory.iterdir():
            if ROOM_ID.fullmatch(path.name):
                _safe_path(root, path)
                if not path.is_dir(): raise ValueError('空间目录无效')
                materialized.add(path.name)
            elif path.is_dir() and not path.name.startswith('前端-'):
                raise ValueError('空间目录含有无法识别的子目录')
    if materialized - set(rooms):
        raise ValueError('空间目录缺少对应的账号数据库记录，未进行恢复')
    return [dict(id=rid, materialized=rid in materialized) for rid in rooms]


def _validate_databases(root, files):
    names = set(files)
    for marker, database in (('运行数据/认证/邮箱账号格式.json', '运行数据/认证/邮箱账号.sqlite3'),
                             ('运行数据/账号角色/格式.json', '运行数据/账号角色/角色.sqlite3')):
        if marker in names and (database not in names or not (root/database).is_file()):
            raise ValueError('备份缺少已初始化的账号或角色数据库：' + database)
    for name in files:
        if not name.endswith(('.sqlite3', '.sqlite', '.db')): continue
        path = root / name
        with closing(open_readonly_database(path)) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchone():
                raise ValueError('备份数据库完整性检查失败：' + name)
            if name.endswith('账号角色/角色.sqlite3'):
                if db.execute('SELECT 1 FROM characters c LEFT JOIN bags b ON b.character_id=c.id WHERE b.character_id IS NULL').fetchone():
                    raise ValueError('备份中的角色缺少独立背包')
                for digest, size in db.execute('SELECT id,size FROM assets'):
                    asset=path.parent/'资源'/digest[:2]/digest
                    if not re.fullmatch(r'[a-f0-9]{64}',digest) or asset.relative_to(root).as_posix() not in names or not asset.is_file() or asset.stat().st_size!=size or _hash(asset)!=digest:
                        raise ValueError('备份缺少角色原始素材')
            if name.endswith('模块存储/模块.sqlite3'):
                base = path.parents[3]
                base_rel = base.relative_to(root).as_posix()
                prefix = '' if base_rel == '.' else base_rel + '/'
                if prefix + '运行数据/存档/工作区.json' not in names:
                    raise ValueError('空间备份缺少工作区标记')
                for digest, size in db.execute('SELECT id,size FROM assets'):
                    if not re.fullmatch(r'[0-9a-f]{64}', digest): raise ValueError('资源哈希格式无效')
                    pending = '运行数据/存档/模块存储/原始资源/' + digest[:2] + '/' + digest
                    locations = [row[0] for row in db.execute('SELECT path FROM asset_locations WHERE id=?', (digest,))]
                    if not any(prefix + item in names and (root / (prefix + item)).stat().st_size == size
                               and _hash(root / (prefix + item)) == digest
                               for item in [pending, *locations] if _allowed(prefix + item)):
                        raise ValueError('备份缺少或损坏原始资源：' + digest)
    roots = [root, *[root / '运行数据/战役空间' / row['id'] for row in _rooms(root) if row['materialized']]]
    for workspace in roots:
        marker = workspace / '运行数据/存档/工作区.json'
        database = workspace / '运行数据/存档/模块存储/模块.sqlite3'
        from .storage_mode import account_rooms_only
        central_only = workspace == root and account_rooms_only(workspace / '运行数据/存档')
        if not marker.is_file() or (not central_only and not database.is_file()): raise ValueError('备份缺少空间工作区或协调数据库')
        value = json.loads(marker.read_text('utf-8'))
        if value.get('format') != 4 or value.get('workspace') != '../..': raise ValueError('空间工作区标记无效')


class InstallationBackups:
    def __init__(self, root):
        self.root = Path(root).absolute()
        _safe_path(self.root, self.root)
        self.save = self.root / '运行数据/存档'
        self.journal = self.root / '运行数据/安装级恢复.json'

    @contextmanager
    def locked(self, allow_pending=False):
        with ExitStack() as stack:
            lease = InstallationLease(self.root, allow_pending=allow_pending)
            stack.callback(lease.close)
            if not allow_pending and not Workspace(self.save).active:
                raise ValueError('安装级工具需要完整的第4版程序包工作区根目录')
            _safe_path(self.root,self.save/'.server.lock')
            lock = ProjectServerLock(self.save); stack.callback(lock.close)
            directory = _safe_path(self.root, self.root / '运行数据/战役空间')
            if directory.is_dir():
                for path in sorted(directory.iterdir()):
                    if ROOM_ID.fullmatch(path.name) and path.is_dir():
                        save = _safe_path(self.root, path / '运行数据/存档')
                        if not allow_pending and not (save / '工作区.json').is_file():
                            raise ValueError('空间目录缺少工作区标记，未进行安装级维护')
                        _safe_path(self.root,save/'.server.lock')
                        lock = ProjectServerLock(save); stack.callback(lock.close)
            if not allow_pending:
                files, _ = _inventory(self.root)
                if any(Path(name).name == '待恢复.json' for name in files):
                    raise ValueError('工作区有待完成的旧整套恢复，请先完成后再运行安装级维护')
            yield

    def _snapshot(self, destination):
        destination = Path(destination).absolute()
        _safe_path(destination, destination)
        if destination.exists(): raise ValueError('备份输出已存在，请选择新的路径')
        if destination.is_relative_to(self.root) and not any(destination.is_relative_to(self.root / '运行数据' / folder)
                                                          for folder in ('安装级恢复任务','安装级备份')):
            raise ValueError('备份输出请放在程序包以外，避免递归归档')
        _private_directory(destination)
        data = destination / '数据'; _private_directory(data)
        try:
            files, directories = _inventory(self.root)
            rooms = _rooms(self.root)
            if sum((self.root / item).stat().st_size for item in files) > MAX_BYTES:
                raise ValueError('安装备份超过64 GiB上限')
            for name in directories: _private_directory(data / name)
            entries = []
            for name in files:
                source, target = self.root / name, data / name
                _private_directory(target.parent)
                # Frozen archives are copied byte-for-byte, including historical sidecars.
                if name.endswith(('.sqlite3', '.sqlite', '.db')) and not _is_archive(name):
                    with closing(open_readonly_database(source)) as db, closing(sqlite3.connect(target)) as output:
                        db.backup(output)
                else:
                    shutil.copyfile(source, target)
                target.chmod(0o600)
                with target.open('rb') as handle: os.fsync(handle.fileno())
                entries.append(dict(path=name, size=target.stat().st_size, sha256=_hash(target)))
            manifest = dict(format=FORMAT, schemaVersion=1, id='i'+secrets.token_hex(16),
                            createdAt=int(__import__('time').time()*1000), rooms=rooms,
                            directories=directories, files=entries,
                            excluded=['运行数据/'+item for item in sorted(EXCLUDED_DATA)])
            atomic_json(destination / '备份清单.json', manifest)
            destination.joinpath('备份清单.json').chmod(0o600)
            _sync(destination)
            return self.verify(destination)
        except BaseException:
            shutil.rmtree(destination)
            raise

    def create(self, destination):
        with self.locked(): return self._snapshot(destination)

    @staticmethod
    def verify(folder):
        folder = Path(folder).absolute()
        _safe_path(folder, folder / '备份清单.json')
        manifest_path = folder / '备份清单.json'
        if manifest_path.stat().st_size > 64*1024**2: raise ValueError('备份清单过大')
        value = json.loads(manifest_path.read_text('utf-8'))
        if value.get('format') != FORMAT or value.get('schemaVersion') != 1:
            raise ValueError('请使用对应工具处理旧单工作区备份；本命令只恢复安装级备份')
        entries, directories = value.get('files'), value.get('directories')
        if not isinstance(entries, list) or not isinstance(directories, list) or len(entries)+len(directories)>MAX_FILES:
            raise ValueError('备份清单条目无效或超限')
        names = set()
        total = 0
        data = folder / '数据'
        for item in entries:
            name, size, digest = item.get('path'), item.get('size'), item.get('sha256')
            if (not isinstance(name,str) or not _allowed(name) or name in names
                    or type(size) is not int or size < 0 or not re.fullmatch(r'[0-9a-f]{64}',str(digest))):
                raise ValueError('备份文件清单含有无效或重复路径')
            names.add(name); total += size
            path = _safe_path(folder, data / name)
            if not path.is_file() or path.stat().st_size != size or _hash(path) != digest:
                raise ValueError('备份文件哈希或尺寸不一致：' + name)
        if total > MAX_BYTES: raise ValueError('备份容量超限')
        if len(directories) != len(set(directories)) or any(not isinstance(name,str) or not _allowed(name) for name in directories):
            raise ValueError('备份目录清单无效')
        for name in directories:
            if not _safe_path(folder,data/name).is_dir(): raise ValueError('备份缺少目录')
        actual_files, actual_dirs = _inventory(data)
        # Inventory ignores forbidden paths, so also reject every extra entry.
        for path in data.rglob('*'):
            _safe_path(folder, path)
            name = path.relative_to(data).as_posix()
            if not _allowed(name): raise ValueError('备份含有未登记或禁止的路径')
            if path.is_file() and name not in names: raise ValueError('备份含有未登记文件')
        if set(actual_files) != names or set(actual_dirs) != set(directories):
            raise ValueError('备份清单与实际内容不一致')
        if _rooms(data) != value.get('rooms'): raise ValueError('账号数据库与空间目录清单不一致')
        _validate_databases(data, sorted(names))
        return dict(id=value['id'], manifestHash=_hash(manifest_path), files=len(names),
                    bytes=total, rooms=len(value['rooms']), path=str(folder))

    def _targets(self, staged):
        targets = list(TOP[:3])
        names = {p.name for base in (self.root / '运行数据', staged / '运行数据')
                 if base.is_dir() for p in base.iterdir()}
        names.add('工作区代次.json')
        for name in sorted(names):
            if name in EXCLUDED_DATA or name in EXCLUDED_FILES: continue
            if name in ('存档','认证'):
                children = {p.name for base in (self.root / '运行数据' / name, staged / '运行数据' / name)
                            if base.is_dir() for p in base.iterdir() if p.name not in EXCLUDED_FILES}
                targets.extend('运行数据/'+name+'/'+child for child in sorted(children))
            else: targets.append('运行数据/'+name)
        if not all(_allowed(name) for name in targets): raise ValueError('恢复目标路径无效')
        return targets

    def _rollback(self, job, journal):
        verified = self.verify(job / '恢复前备份')
        if verified['manifestHash'] != journal['rollback']:
            raise ValueError('回滚副本已变化，恢复事务保留')
        started = journal['started']
        completed = journal['rolledBack']
        fallback = {}
        missing = [name for name in started if name not in completed and journal['originals'][name]
                   and not (job/'原数据'/name).exists()]
        # If a retired SQLite journal is missing, restore its canonical backup
        # database too; never combine an old main file with a lost WAL.
        for name in list(missing):
            if name.endswith(('-wal','-shm','-journal')):
                base=name.rsplit('-',1)[0]
                if base in started and base not in completed and base not in missing:
                    missing.append(base)
        for name in list(missing):
            if name.endswith(('.sqlite3','.sqlite','.db')):
                for suffix in ('-wal','-shm','-journal'):
                    sidecar=name+suffix
                    if sidecar in journal['targets']:
                        if sidecar not in started: started.append(sidecar)
                        if sidecar in completed: completed.remove(sidecar)
                        if sidecar not in missing: missing.append(sidecar)
        stage = job / ('回滚暂存-'+secrets.token_hex(12))
        for name in missing:
            source=_safe_path(self.root,job/'恢复前备份/数据'/name)
            target=_safe_path(self.root,stage/name)
            if source.exists():
                _private_directory(target.parent)
                if source.is_dir(): shutil.copytree(source,target)
                else: shutil.copyfile(source,target);target.chmod(0o600)
                fallback[name]=target
            elif not name.endswith(('-wal','-shm','-journal')):
                raise ValueError('恢复前备份缺少原目标，事务保留，未报告回滚成功')
            else:
                fallback[name]=None
        for name in reversed(started):
            if name in completed: continue
            target = _safe_path(self.root, self.root / name)
            old = _safe_path(self.root, job / '原数据' / name)
            new = _safe_path(self.root, job / '新备份/数据' / name)
            candidate=fallback[name] if name in fallback else old if old.exists() else None
            if candidate is not None:
                if target.is_dir(): shutil.rmtree(target)
                elif target.exists(): target.unlink()
                target.parent.mkdir(parents=True, exist_ok=True)
                candidate.rename(target); _sync(target.parent)
            elif (name in fallback or not journal['originals'][name]) and target.exists():
                if target.is_dir(): shutil.rmtree(target)
                else: target.unlink()
            completed.append(name)
            atomic_json(self.journal,journal);self.journal.chmod(0o600)
        self.journal.unlink(missing_ok=True)
        _sync(self.journal.parent)

    def restore(self, folder, expected_manifest_hash):
        verified = self.verify(folder)
        if verified['manifestHash'] != expected_manifest_hash: raise ValueError('备份清单已变化，请重新校验')
        with self.locked():
            job = self.root / '运行数据/安装级恢复任务' / ('r'+secrets.token_hex(16))
            _private_directory(job)
            shutil.copytree(folder, job / '新备份')
            for path in (job / '新备份').rglob('*'):
                path.chmod(0o700 if path.is_dir() else 0o600)
            job.joinpath('新备份').chmod(0o700)
            if self.verify(job / '新备份')['manifestHash'] != expected_manifest_hash:
                raise ValueError('恢复副本与已校验备份不一致')
            rollback = self._snapshot(job / '恢复前备份')
            targets = self._targets(job / '新备份/数据')
            journal = dict(schemaVersion=2, job=job.relative_to(self.root).as_posix(),
                           targets=targets, originals={name:(self.root/name).exists() for name in targets},
                           rollback=rollback['manifestHash'], started=[], rolledBack=[])
            atomic_json(self.journal,journal); self.journal.chmod(0o600)
            try:
                for name in targets:
                    journal['started'].append(name)
                    atomic_json(self.journal,journal);self.journal.chmod(0o600)
                    target = _safe_path(self.root,self.root/name)
                    old = _safe_path(self.root,job/'原数据'/name)
                    new = _safe_path(self.root,job/'新备份/数据'/name)
                    _private_directory(old.parent); target.parent.mkdir(parents=True,exist_ok=True)
                    if target.exists(): target.rename(old); _sync(target.parent); _sync(old.parent)
                    if new.exists(): new.rename(target); _sync(target.parent); _sync(new.parent)
                atomic_json(self.root / '运行数据/工作区代次.json',dict(epoch=secrets.token_hex(24)))
                self.journal.unlink(); _sync(self.journal.parent)
                return dict(restored=True, rollbackPath=rollback['path'], restartRequired=True)
            except Exception:
                self._rollback(job,journal)
                raise

    def recover(self):
        with self.locked(allow_pending=True):
            if not self.journal.exists(): return dict(recovered=False)
            journal = json.loads(self.journal.read_text('utf-8'))
            if journal.get('schemaVersion') != 2 or not re.fullmatch(r'运行数据/安装级恢复任务/r[0-9a-f]{32}',str(journal.get('job'))):
                raise ValueError('恢复事务路径无效，未修改安装数据')
            job = _safe_path(self.root,self.root/journal['job'])
            rollback = self.verify(job / '恢复前备份')
            if rollback['manifestHash'] != journal.get('rollback'): raise ValueError('回滚副本校验失败')
            targets = journal.get('targets')
            if (not isinstance(targets,list) or len(targets)!=len(set(targets))
                    or not all(isinstance(name,str) and _allowed(name) and (
                        name in TOP[:3] or (name.startswith('运行数据/') and len(PurePosixPath(name).parts)==2)
                        or (name.startswith(('运行数据/存档/','运行数据/认证/')) and len(PurePosixPath(name).parts)==3)) for name in targets)
                    or any(name in targets for name in ('运行数据/存档','运行数据/认证'))
                    or set(journal.get('originals',{})) != set(targets)
                    or any(type(flag) is not bool for flag in journal['originals'].values())
                    or not isinstance(journal.get('started'),list) or not isinstance(journal.get('rolledBack'),list)
                    or len(journal['started'])!=len(set(journal['started']))
                    or len(journal['rolledBack'])!=len(set(journal['rolledBack']))
                    or not set(journal['rolledBack'])<=set(journal['started'])<=set(targets)):
                raise ValueError('恢复事务目标无效，未修改安装数据')
            self._rollback(job,journal)
            return dict(recovered=True, rollbackPath=rollback['path'])
