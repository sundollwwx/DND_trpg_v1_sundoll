"""Recoverable player folder labels. Credentials and all game IDs stay unchanged."""
import json
import os
import re
import sqlite3
from .workspace import Workspace, atomic_json, LOCK


def journal_path(workspace):
    return workspace.save / '玩家目录调整.json'


def recover(save_root):
    workspace = Workspace(save_root)
    journal = journal_path(workspace)
    if not workspace.active or not journal.exists(): return
    with LOCK:
        operation = json.loads(journal.read_text('utf-8'))
        pid = operation['playerId']
        if not re.fullmatch(r'p[0-9a-f]{32}', pid): raise ValueError('玩家目录迁移编号无效')
        source = workspace.checked(workspace.root / operation['source'])
        target = workspace.checked(workspace.root / operation['target'])
        if source.parent != workspace.players or target.parent != workspace.players or source == target:
            raise ValueError('玩家目录迁移范围无效')
        if source.exists() and target.exists(): raise ValueError('玩家目标目录已存在，未覆盖')
        actual = source if source.exists() else target
        profile = json.loads((actual / '当前档案.json').read_text('utf-8'))
        if profile.get('playerId') != pid: raise ValueError('玩家目录迁移身份不一致')
        if source.exists(): os.replace(source, target)
        # The journal survives both rename and SQL commit. Prefix substitution is
        # idempotent and includes originals, so recovery works without staging.
        database = workspace.save / '模块存储/模块.sqlite3'
        if database.exists():
            db = sqlite3.connect(str(database), timeout=15)
            db.row_factory = sqlite3.Row
            try:
                db.execute('BEGIN IMMEDIATE')
                for table in ('module_records', 'asset_locations'):
                    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone(): continue
                    prefix = operation['source'] + '/'
                    for row in db.execute('SELECT rowid,path FROM ' + table).fetchall():
                        if row['path'].startswith(prefix):
                            db.execute('UPDATE ' + table + ' SET path=? WHERE rowid=?',
                                       (operation['target'] + '/' + row['path'][len(prefix):], row['rowid']))
                metadata = {table: [dict(row) for row in db.execute('SELECT * FROM ' + table)]
                            for table in ('assets', 'asset_links', 'receipts', 'migrations', 'module_records', 'asset_locations')}
                atomic_json(workspace.root / '运行数据/协调记录/索引快照.json', metadata)
                db.commit()
            finally: db.close()
        journal.unlink()


def rename_directory(save_root, pid):
    workspace = Workspace(save_root)
    if not workspace.active: return
    with LOCK:
        recover(save_root)
        source = workspace.player(pid)
        profile = json.loads((source / '当前档案.json').read_text('utf-8'))
        label = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', profile['name']).strip(' .')[:40] or '玩家'
        if label.upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}:
            label = '玩家-' + label
        target = workspace.checked(workspace.players / (label + '--' + pid[1:9]))
        if source == target: return
        if target.exists():
            target = workspace.checked(workspace.players / (label + '--' + pid))
        if source == target: return
        if target.exists(): raise ValueError('玩家目标目录已存在，未覆盖')
        atomic_json(journal_path(workspace), dict(playerId=pid,
                    source=source.relative_to(workspace.root).as_posix(),
                    target=target.relative_to(workspace.root).as_posix()))
        recover(save_root)


def migrate(save_root, create_backup=False):
    """Run after obtaining the server lock, before accepting any requests."""
    workspace = Workspace(save_root)
    if not workspace.active: return
    recover(save_root)
    paths = sorted(workspace.players.glob('*/当前档案.json'))
    if create_backup and any(re.fullmatch(r'p[0-9a-f]{32}', p.parent.name) for p in paths):
        from .workspace_backup import Backups
        Backups(save_root).create('玩家目录姓名化前')
    for path in paths:
        workspace.checked(path)
        profile = json.loads(path.read_text('utf-8'))
        pid = profile['playerId']
        if not re.fullmatch(r'p[0-9a-f]{32}', pid): raise ValueError('玩家档案编号无效')
        rename_directory(save_root, pid)
