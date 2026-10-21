#!/usr/bin/env python3
"""Offline, journalled retirement of the original workspace; room data stays put."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '程序包/主程序'))
from server.installation_backup import InstallationBackups, _safe_path, _validate_databases
from server.storage_mode import FORMAT, MODE_FILE, JOURNAL_FILE, ARCHIVE_FILE, account_rooms_only
from server.workspace import atomic_json
from server.sqlite_read import open_readonly_database


def checksum(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def sqlite_digest(path):
    with closing(open_readonly_database(path)) as db:
        return hashlib.sha256("\n".join(db.iterdump()).encode()).hexdigest()

def sources(root):
    names = ['通用包', '战役包', '玩家包']
    data = root / '运行数据'
    names += ['运行数据/' + n for n in (
        '协调记录', '.sundoll-cache', '音乐缓存', '备份', '恢复备份', '整套备份', '迁移留存', '维护记录',
        '同级模块迁移报告.json', '正式切换记录-v4.json', '正式切换记录-统一管理.json', '正式切换记录-联机性能修复-20260923.json')]
    names += [str(p.relative_to(root)) for p in data.glob('迁入前保留-*')]
    names += [str(p.relative_to(root)) for p in (data / '存档').iterdir() if p.name != '.server.lock']
    names += [str(p.relative_to(root)) for p in (data / '认证').iterdir()
              if p.name == 'dm-password.json' or re.fullmatch(r'p[0-9a-f]{32}\.json', p.name)]
    return sorted(name for name in names if (root / name).exists())


def files_under(root, names):
    result = []
    for name in names:
        path = _safe_path(root, root / name)
        candidates = [path] if path.is_file() else sorted(path.rglob('*'))
        for file in candidates:
            _safe_path(root, file)
            if file.is_dir(): continue
            if not file.is_file(): raise ValueError('归档仅支持普通文件')
            entry = dict(path=file.relative_to(root).as_posix(), size=file.stat().st_size, sha256=checksum(file))
            if file.suffix in ('.sqlite3', '.sqlite', '.db'): entry['sqliteDigest'] = sqlite_digest(file)
            result.append(entry)
    return result


def verify_archive(folder):
    folder = Path(folder)
    value = json.loads((folder / ARCHIVE_FILE).read_text('utf-8'))
    if value.get('format') != 'sundoll-legacy-workspace-archive-v1': raise ValueError('归档格式无效')
    for entry in value['files']:
        p = _safe_path(folder, folder / entry['path'])
        if not p.is_file(): raise ValueError('归档文件缺失：' + entry['path'])
        # SQLite snapshots can change page layout while preserving every SQL value.
        exact = p.stat().st_size == entry['size'] and checksum(p) == entry['sha256']
        if not exact and not (entry.get('sqliteDigest') and sqlite_digest(p) == entry['sqliteDigest']):
            raise ValueError('归档文件校验失败：' + entry['path'])
    _validate_databases(folder, [entry['path'] for entry in value['files']])
    return dict(files=len(value['files']), bytes=sum(x['size'] for x in value['files']))


def retire(root, archive_name='原工作区-20261017', replace=os.replace):
    root = Path(root).absolute()
    if not re.fullmatch(r'[\w-]{1,80}', archive_name): raise ValueError('归档目录名称无效')
    data = root / '运行数据'; save = data / '存档'
    journal = data / JOURNAL_FILE
    destination = data / '历史归档' / archive_name
    if journal.exists(): raise RuntimeError('归档事务尚未结束，请先检查并回滚')
    if account_rooms_only(save):
        mode = json.loads((data / MODE_FILE).read_text('utf-8'))
        return dict(alreadyArchived=True, archive=mode['archive'])
    with InstallationBackups(root).locked():
        settings = json.loads((data / '认证/邮箱账号设置.json').read_text('utf-8'))
        if not (settings.get('enabled') is True and settings.get('roomsEnabled') is True):
            raise ValueError('请先完成邮箱账号和房间迁移')
        if destination.exists(): raise ValueError('归档目标已存在，不会覆盖')
        _safe_path(root, destination)
        # Remove transient WAL files only after checkpointing the old coordinator.
        with sqlite3.connect(save / '模块存储/模块.sqlite3') as db:
            if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] != 0: raise RuntimeError('旧数据库仍被占用')
        db.close()
        moves = sources(root)
        entries = files_under(root, moves)
        record = dict(format='sundoll-legacy-workspace-archive-v1', createdAt=datetime.now(timezone.utc).isoformat(),
                      readOnly=True, originalWorkspace=str(root), files=entries)
        destination.mkdir(parents=True, mode=0o700)
        destination.parent.chmod(0o700)
        stub = dict(format=4, workspace='../..', storageMode='account-rooms')
        mode = dict(format=FORMAT, archive=destination.relative_to(data).as_posix())
        atomic_json(journal, dict(destination=destination.relative_to(root).as_posix(), moves=moves, state='moving'))
        completed = []
        try:
            for name in moves:
                source, target = root / name, destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                replace(source, target); completed.append(name)
            epoch = data / '工作区代次.json'
            if epoch.is_file():
                target = destination / '运行数据/工作区代次.json'
                shutil.copy2(epoch, target)
                record['files'].append(dict(path='运行数据/工作区代次.json', size=target.stat().st_size, sha256=checksum(target)))
            atomic_json(destination / ARCHIVE_FILE, record)
            (destination / ARCHIVE_FILE).chmod(0o600)
            verification = verify_archive(destination)
            atomic_json(save / '工作区.json', stub)
            atomic_json(data / MODE_FILE, mode)
            journal.unlink()
            return dict(archive=str(destination), movedGroups=len(completed), **verification)
        except BaseException:
            rollback(root, locked=True)
            raise


def rollback(root, locked=False):
    root = Path(root).absolute(); data = root / '运行数据'; journal = data / JOURNAL_FILE
    if not locked:
        with InstallationBackups(root).locked(allow_pending=True): return rollback(root, locked=True)
    if not journal.is_file(): return dict(recovered=False)
    value = json.loads(journal.read_text('utf-8'))
    destination = _safe_path(root, root / value['destination'])
    if destination.parent != data / '历史归档': raise ValueError('事务归档路径无效')
    moves = value['moves']
    for name in moves:
        source = _safe_path(root, root / name); target = _safe_path(destination, destination / name)
        allowed = (name in ('通用包', '战役包', '玩家包') or name.startswith('运行数据/存档/') or
                   name.startswith('运行数据/认证/') or name.count('/') == 1 and name.startswith('运行数据/'))
        if not allowed or name in ('运行数据/认证/邮箱账号.sqlite3','运行数据/认证/邮箱账号设置.json'):
            raise ValueError('事务包含非归档路径')
        stub = dict(format=4, workspace='../..', storageMode='account-rooms')
        is_stub = name == '运行数据/存档/工作区.json' and source.is_file() and json.loads(source.read_text()) == stub
        if source.exists() and target.exists() and not is_stub: raise RuntimeError('归档回滚遇到路径冲突')
        if not source.exists() and not target.exists(): raise RuntimeError('归档回滚缺少原件')
    for name in reversed(moves):
        source, target = root / name, destination / name
        if target.exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(target, source)
    (data / MODE_FILE).unlink(missing_ok=True)
    if destination.exists(): shutil.rmtree(destination)
    journal.unlink()
    return dict(recovered=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--verify',type=Path)
    parser.add_argument('--rollback',action='store_true')
    args=parser.parse_args()
    if args.verify: result=verify_archive(args.verify)
    elif args.rollback: result=rollback(args.root)
    elif args.apply: result=retire(args.root)
    elif account_rooms_only(args.root/'运行数据/存档'):
        result=dict(alreadyArchived=True, moves=[], archive=json.loads((args.root/'运行数据'/MODE_FILE).read_text())['archive'])
    else:
        names=sources(args.root);entries=files_under(args.root,names)
        result=dict(moves=names,files=len(entries),bytes=sum(x['size'] for x in entries),requiresOffline=True)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__': main()
