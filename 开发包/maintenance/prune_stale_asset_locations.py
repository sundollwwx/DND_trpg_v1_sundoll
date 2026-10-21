#!/usr/bin/env python3
"""Preview missing registered asset locations; apply only to an offline v4 workspace."""
import argparse
from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

sys.dont_write_bytecode = True
APP_ROOT = Path(__file__).resolve().parents[2] / '程序包/主程序'
sys.path.insert(0, str(APP_ROOT))

from server.installation_backup import InstallationLease
from server.module_store import ModuleStore
from server.paths import local_save_root
from server.save_storage import ProjectServerLock
from server.sqlite_read import open_readonly_database
from server.storage_mode import account_rooms_only, ARCHIVE_FILE
from server.workspace import Workspace, atomic_json


DIGEST = re.compile(r'[0-9a-f]{64}\Z')
ROOM_ID = re.compile(r'r[0-9a-f]{32}\Z')
INDEX_EVENT = ('maintenance-index-refresh', 'stale-asset-locations')


def checksum(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def workspace_at(save_root):
    path = Path(save_root).absolute()
    if '..' in path.parts or path.name != '存档' or path.parent.name != '运行数据':
        raise ValueError('请指定目标 v4 工作区的运行数据/存档目录')
    workspace = Workspace(path)
    if not workspace.active:
        raise ValueError('仅支持已有 v4 工作区，不初始化或迁移数据')
    workspace.checked(path)
    return workspace


def installation_at(workspace):
    root = workspace.root
    if (root.parent.name == '战役空间' and root.parent.parent.name == '运行数据'
            and ROOM_ID.fullmatch(root.name)):
        installation = root.parent.parent.parent
        central = workspace_at(installation / '运行数据/存档')
        central.checked(root)
        return central.root
    return root


def location_path(workspace, digest, relative):
    parts = str(relative).split('/')
    if (not DIGEST.fullmatch(str(digest)) or '\\' in str(relative)
            or any(part in ('', '.', '..') for part in parts)):
        raise ValueError('资源位置不是合法的工作区相对路径')
    module_asset = (len(parts) >= 5 and parts[0] in ('通用包', '战役包', '玩家包')
                    and parts[-3:] == ['资源', digest[:2], digest])
    central_asset = (parts == ['运行数据', '存档', '模块存储', '原始资源', digest[:2], digest])
    if not (module_asset or central_asset):
        raise ValueError('资源位置不属于目标工作区的正式原图目录')
    return workspace.checked(workspace.root.joinpath(*parts))


def preview(save_root):
    workspace = workspace_at(save_root)
    if account_rooms_only(workspace.save):
        raise ValueError('中央目录只保存账号关联，请用 --save-root 明确选择具体房间')
    store = ModuleStore(workspace.save)
    if not store.database.is_file():
        raise ValueError('游戏模块数据库不存在，未创建新库')
    with closing(open_readonly_database(store.database)) as db:
        db.execute('BEGIN')
        assets = {row['id']: dict(mime=row['mime'], size=row['size'])
                  for row in db.execute('SELECT id,mime,size FROM assets ORDER BY id')}
        locations = [dict(row) for row in db.execute('SELECT id,path FROM asset_locations ORDER BY id,path')]
        pending = db.execute('SELECT count(*) FROM module_outbox').fetchone()[0]
        collision = any(db.execute(f'SELECT 1 FROM {table} WHERE kind=? AND id=?', INDEX_EVENT).fetchone()
                        for table in ('documents', 'module_records'))
    by_asset = {}
    for row in locations:
        by_asset.setdefault(row['id'], []).append(row['path'])
    candidates, blocked = [], []
    for digest, paths in by_asset.items():
        missing, present = [], []
        try:
            for relative in paths:
                target = location_path(workspace, digest, relative)
                if not target.exists():
                    missing.append(relative)
                elif target.is_file():
                    present.append((relative, target))
                else:
                    raise ValueError('登记资源位置存在但不是普通文件')
            if not missing:
                continue
            if digest not in assets:
                raise ValueError('缺失路径的资源尚未登记，不能整理')
            verified = []
            for relative, target in present:
                if target.stat().st_size == assets[digest]['size'] and checksum(target) == digest:
                    verified.append(dict(path=relative, size=assets[digest]['size'], sha256=digest))
            if not verified:
                raise ValueError('没有另一份大小与 SHA256 正确的已登记资源位置，拒绝移除')
            candidates.extend(dict(id=digest, path=relative, retainedLocations=verified) for relative in missing)
        except (ValueError, OSError) as error:
            blocked.append(dict(id=digest, reason=str(error)))
    markers = [workspace.root / '运行数据/待恢复.json',
               workspace.root / '运行数据/模块发布中.json',
               workspace.save / '玩家目录调整.json']
    if any(path.exists() for path in markers):
        blocked.append(dict(reason='工作区存在待完成的恢复、发布或目录调整'))
    if pending:
        blocked.append(dict(reason='工作区仍有待发布的模块记录'))
    if collision:
        blocked.append(dict(reason='维护索引刷新身份与现有文档或记录冲突'))
    index = workspace.checked(workspace.root / '运行数据/协调记录/索引快照.json')
    index_hash = checksum(index) if index.is_file() else None
    if index_hash is None:
        blocked.append(dict(reason='工作区缺少可保留的索引快照'))
    registry = dict(assets=assets, assetLocations=locations)
    report = dict(readOnly=True, workspace=str(workspace.root),
                  installation=str(installation_at(workspace)),
                  registryHash=hashlib.sha256(encode(registry).encode()).hexdigest(),
                  indexHash=index_hash,
                  registeredAssets=len(assets), registeredLocations=len(locations),
                  candidates=candidates, blocked=blocked)
    report['planHash'] = hashlib.sha256(encode(report).encode()).hexdigest()
    return report


def offline_locks(stack, installation):
    lease = InstallationLease(installation)
    stack.callback(lease.close)
    saves = [installation / '运行数据/存档']
    rooms = installation / '运行数据/战役空间'
    if rooms.is_dir():
        for root in sorted(rooms.iterdir()):
            if root.is_dir() and ROOM_ID.fullmatch(root.name):
                save = root / '运行数据/存档'
                if save.is_dir():
                    Workspace(installation / '运行数据/存档').checked(save)
                    saves.append(save)
    for save in saves:
        lock = ProjectServerLock(save)
        stack.callback(lock.close)


def protected_backup(store, directory):
    if directory.exists():
        raise ValueError('恢复前目录已经存在，请使用新的报告文件名')
    directory.mkdir(mode=0o700, parents=True)
    directory.chmod(0o700)
    target = directory / '游戏模块.sqlite3'
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    with closing(open_readonly_database(store.database)) as source, closing(sqlite3.connect(target)) as destination:
        source.backup(destination)
    target.chmod(0o600)
    index = store.workspace.checked(store.workspace.root / '运行数据/协调记录/索引快照.json')
    original = index.read_bytes()
    index_target = directory / '索引快照.json'
    descriptor = os.open(index_target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(original)
        handle.flush()
        os.fsync(handle.fileno())
    with target.open('rb') as handle:
        os.fsync(handle.fileno())
    if os.name != 'nt':
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return dict(directory=str(directory), databaseSha256=checksum(target),
                databaseBytes=target.stat().st_size,
                indexSha256=hashlib.sha256(original).hexdigest(), indexBytes=len(original))


def run(save_root, apply=False, expected_plan_hash=None, output=None):
    workspace = workspace_at(save_root)
    if account_rooms_only(workspace.save):
        raise ValueError('中央目录只保存账号关联，请用 --save-root 明确选择具体房间')
    if apply and any((parent/ARCHIVE_FILE).exists() for parent in (workspace.root, *workspace.root.parents)):
        raise ValueError('历史归档只允许预览；请在独立恢复副本中修改')
    installation = installation_at(workspace)
    report_path = Path(output).absolute() if output else None
    if report_path and ('..' in report_path.parts
                        or report_path.resolve().is_relative_to(installation.resolve())):
        raise ValueError('维护报告必须放在目标安装目录外，不覆盖游戏数据')
    if not apply:
        result = preview(workspace.save)
        if report_path:
            atomic_json(report_path, result)
        return result
    if not DIGEST.fullmatch(str(expected_plan_hash)) or report_path is None:
        raise ValueError('--apply 必须同时提供已审查的 --expected-plan-hash 和 --output')
    if report_path.exists():
        raise ValueError('应用报告已经存在，请使用新的文件名保留恢复证据')
    with ExitStack() as stack:
        offline_locks(stack, installation)
        result = preview(workspace.save)
        if result['planHash'] != expected_plan_hash:
            raise ValueError('预览之后资源登记或文件状态已变化，请重新预览')
        if result['blocked']:
            raise ValueError('预览仍有拒绝项，未修改数据库')
        if not result['candidates']:
            applied = dict(result, readOnly=False, applied=False, removed=[], note='没有可整理的缺失位置')
            atomic_json(report_path, applied)
            return applied
        store = ModuleStore(workspace.save)
        backup = protected_backup(store, report_path.with_name(report_path.stem + '-恢复前'))
        applied = dict(result, readOnly=False, applied=False, phase='backed-up', backup=backup, removed=[])
        atomic_json(report_path, applied)
        try:
            with store.transaction() as db:
                for row in result['candidates']:
                    target = location_path(workspace, row['id'], row['path'])
                    if target.exists():
                        raise ValueError('待整理路径重新出现，已停止本次事务')
                    info = db.execute('SELECT size FROM assets WHERE id=?', (row['id'],)).fetchone()
                    if not info or not any(
                        db.execute('SELECT 1 FROM asset_locations WHERE id=? AND path=?', (row['id'], live['path'])).fetchone()
                        and location_path(workspace, row['id'], live['path']).is_file()
                        and location_path(workspace, row['id'], live['path']).stat().st_size == info['size']
                        and checksum(location_path(workspace, row['id'], live['path'])) == row['id']
                        for live in row['retainedLocations']):
                        raise ValueError('没有可验证的已登记保留原图，已停止本次事务')
                    cursor = db.execute('DELETE FROM asset_locations WHERE id=? AND path=?', (row['id'], row['path']))
                    if cursor.rowcount != 1:
                        raise ValueError('缺失位置登记已变化，已停止本次事务')
                # A tombstone with no document or record asks the normal outbox
                # publisher to refresh metadata without rewriting any document.
                db.execute('INSERT INTO module_outbox(kind,id) VALUES (?,?)', INDEX_EVENT)
            applied.update(applied=True, phase='applied', removed=result['candidates'])
            atomic_json(report_path, applied)
            return applied
        except Exception as error:
            with closing(open_readonly_database(store.database)) as db:
                removed = [row for row in result['candidates'] if not db.execute(
                    'SELECT 1 FROM asset_locations WHERE id=? AND path=?', (row['id'], row['path'])).fetchone()]
                pending = bool(db.execute('SELECT 1 FROM module_outbox WHERE kind=? AND id=?', INDEX_EVENT).fetchone())
            applied.update(phase='projection-pending' if removed and pending else 'stopped',
                           removed=removed, databaseCommitted=bool(removed), errorType=type(error).__name__,
                           note='恢复前快照已保留；数据库提交后的投影可由正式模块连接重放')
            atomic_json(report_path, applied)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--save-root', type=Path, default=local_save_root())
    parser.add_argument('--apply', action='store_true', help='取得安装独占租约后提交；默认仅预览')
    parser.add_argument('--expected-plan-hash', help='--apply 必填：先预览并审查的 planHash')
    parser.add_argument('--output', type=Path, help='安装目录外的 JSON 报告；--apply 必填且不可覆盖')
    args = parser.parse_args()
    try:
        result = run(args.save_root, args.apply, args.expected_plan_hash, args.output)
    except (ValueError, RuntimeError, OSError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result['blocked'] else 0


if __name__ == '__main__':
    sys.exit(main())
