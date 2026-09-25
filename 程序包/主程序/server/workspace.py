from contextlib import nullcontext
"""Sibling module layout and recoverable, module-owned document projections.

SQLite remains the transaction coordinator. Its committed outbox publishes
module records before a successful write returns; a failed publication is
replayed before the next connection can read. Never infer v4 from directory names.
"""
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import threading

LOCK = threading.RLock()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            handle.flush(); os.fsync(handle.fileno())
        os.replace(temp, path)
        if os.name != 'nt':
            fd = os.open(str(path.parent), os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        if temp.exists(): temp.unlink()


def key(value):
    value = str(value)
    return value if re.fullmatch(r'[\w-]{1,96}', value) else 'id-' + hashlib.sha256(value.encode()).hexdigest()[:32]


class Workspace:
    def __init__(self, save_root):
        self.save = Path(save_root).absolute()
        marker = self.save / '工作区.json'
        self.config = json.loads(marker.read_text('utf-8')) if marker.is_file() else None
        if self.config and (self.config.get('format') != 4 or self.config.get('workspace') != '../..'):
            raise ValueError('工作区配置无效，未尝试读取旧存档')
        self.active = self.config is not None
        self.root = self.save.parent.parent if self.active else self.save
        self.campaigns = self.root / '战役包' if self.active else self.save / '战役'
        self.players = self.root / '玩家包' if self.active else self.save / '玩家档案'
        self.auth = self.root / '运行数据/认证' if self.active else self.players / '认证'
        self.general = self.root / '通用包'

    def checked(self, path):
        path = Path(path).absolute()
        parts = path.relative_to(self.root).parts
        cursor = self.root
        if cursor.is_symlink(): raise ValueError('模块目录不允许符号链接')
        for part in parts:
            if part in ('.', '..'): raise ValueError('模块路径无效')
            cursor /= part
            if cursor.is_symlink(): raise ValueError('模块目录不允许符号链接')
        return path

    def campaign(self, cid):
        folder = (self.config or {}).get('campaignFolders', {}).get(cid, key(cid))
        if '/' in folder or '\\' in folder or folder in ('.', '..'): raise ValueError('战役目录无效')
        return self.checked(self.campaigns / folder)

    def player(self, pid):
        """Resolve by immutable identity, never by the user's display name."""
        legacy = self.checked(self.players / key(pid))
        if not self.active: return legacy
        matches = []
        for profile in self.players.glob('*/当前档案.json'):
            self.checked(profile)
            value = json.loads(profile.read_text('utf-8'))
            if value.get('playerId') == pid: matches.append(profile.parent)
        if len(matches) > 1: raise ValueError('玩家身份重复，不能选择任意目录')
        return matches[0] if matches else legacy

    def save_path(self, parts):
        if self.active and parts[0] == '战役':
            return self.checked(self.campaigns.joinpath(*parts[1:]))
        return self.checked(self.save.joinpath(*parts))

    def module_path(self, kind, identity, owner, data, db):
        if kind in ('runtime-character', 'runtime-backpack', 'player-library','archived-player'):
            pid = owner or identity
            archived = db.execute("SELECT 1 FROM documents WHERE kind='archived-player' AND id=?",(pid,)).fetchone()
            return self.players / '已删除' / key(pid) if archived else self.player(pid)
        if kind == 'runtime-map': return self.campaign(identity)
        if kind in ('campaign-commit', 'campaign-pending', 'campaign-summary'):
            parts = identity.split('/')
            if len(parts) >= 2 and parts[0] == '战役': return self.campaigns / parts[1]
        if kind in ('template', 'item-template'):
            if owner.startswith('campaign:'): return self.campaign(owner[9:])
            if owner.startswith('general:'): return self.general / key(owner[8:])
        if kind in ('installed-module', 'module-content'):
            row = db.execute("SELECT payload FROM documents WHERE kind='installed-module' AND id=?", (identity,)).fetchone()
            manifest = json.loads(row[0])['manifest'] if row else {}
            category = manifest.get('kind', '')
            base = self.players if category == 'player' else self.campaigns if category.startswith('campaign') else self.general
            return base / ('安装源-' + key(identity))
        return self.root / '运行数据/协调记录'

    def summary(self):
        if not self.active: return {'format': 3, 'layout': 'legacy'}
        return {'format': 4, 'layout': 'siblings', 'modules': [
            {'kind':'engine', 'name':'主程序', 'description':'界面、规则能力与运行服务'},
            {'kind':'general', 'name':'通用包', 'description':'共享生物、物品与素材'},
            {'kind':'campaign', 'name':'战役包', 'description':'战役地图、专属内容与冒险进度'},
            {'kind':'player', 'name':'玩家包', 'description':'角色、伙伴与各角色独立背包'}]}

    def support_roots(self, folder):
        if not self.active: return [self.save/'模块资料'/folder]
        return [self.checked(module/'资料'/folder) for base in (self.general,self.campaigns)
                if base.is_dir() for module in sorted(base.iterdir()) if module.is_dir() and not module.is_symlink()]


def enable(workspace_root, campaign_folders=None, campaign_names=None):
    root = Path(workspace_root)
    save = root / '运行数据/存档'
    if (save / '工作区.json').exists(): raise ValueError('工作区已存在')
    for folder in ('通用包', '战役包', '玩家包', '运行数据'):
        (root / folder).mkdir(parents=True, exist_ok=True)
    atomic_json(save / '工作区.json', {'format':4, 'workspace':'../..',
        'campaignFolders':campaign_folders or {}, 'campaignNames':campaign_names or {}})
    return save


def setup_projection(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS module_outbox(kind TEXT, id TEXT, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS module_records(kind TEXT,id TEXT,path TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS asset_locations(id TEXT,path TEXT,PRIMARY KEY(id,path));
        CREATE TRIGGER IF NOT EXISTS module_insert AFTER INSERT ON documents BEGIN
          INSERT INTO module_outbox VALUES (new.kind,new.id) ON CONFLICT(kind,id) DO NOTHING; END;
        CREATE TRIGGER IF NOT EXISTS module_update AFTER UPDATE ON documents BEGIN
          INSERT INTO module_outbox VALUES (new.kind,new.id) ON CONFLICT(kind,id) DO NOTHING; END;
        CREATE TRIGGER IF NOT EXISTS module_delete AFTER DELETE ON documents BEGIN
          INSERT INTO module_outbox VALUES (old.kind,old.id) ON CONFLICT(kind,id) DO NOTHING; END;
    ''')


def project(store, db):
    """Called only outside a transaction; never expose partly published changes."""
    workspace = store.workspace
    if not workspace.active: return
    if db.in_transaction: raise RuntimeError('不能在事务内发布模块')
    publication_marker = workspace.root/'运行数据/模块发布中.json'
    if not db.execute('SELECT 1 FROM module_outbox LIMIT 1').fetchone():
        return
    # SQLite serializes processes; LOCK also prevents local recursive publishers.
    with LOCK:
        db.execute('BEGIN IMMEDIATE')
        try:
            atomic_json(publication_marker, {'pending':True})
            portrait_directories = set()
            for pending in db.execute('SELECT kind,id FROM module_outbox').fetchall():
                kind, identity = pending
                old = db.execute('SELECT path FROM module_records WHERE kind=? AND id=?', (kind, identity)).fetchone()
                if old and kind in ('player-library', 'template'):
                    portrait_directories.add((workspace.root / old['path']).parent.parent)
                row = db.execute('SELECT owner,revision,payload FROM documents WHERE kind=? AND id=?', (kind,identity)).fetchone()
                if row:
                    value = json.loads(row['payload'])
                    directory = workspace.checked(workspace.module_path(kind,identity,row['owner'],value,db))
                    if kind in ('player-library', 'template'): portrait_directories.add(directory)
                    manifest_path = workspace.checked(directory/'模块.json')
                    if not manifest_path.exists():
                        family = directory.relative_to(workspace.root).parts[0]
                        atomic_json(manifest_path,dict(format='sundoll-workspace-module',version=4,
                            family=family,id=directory.name,portable=False))
                    relative = (directory / '记录' / (hashlib.sha256((kind+':'+identity).encode()).hexdigest()+'.json')).relative_to(workspace.root).as_posix()
                    digests = set()
                    def visit(node):
                        if isinstance(node, dict):
                            for v in node.values(): visit(v)
                        elif isinstance(node, list):
                            for v in node: visit(v)
                        elif isinstance(node, str) and re.fullmatch(r'/api/module-assets/[0-9a-f]{64}', node): digests.add(node.rsplit('/',1)[1])
                    visit(value)
                    assets = []
                    for digest in sorted(digests):
                        info = db.execute('SELECT mime,size FROM assets WHERE id=?', (digest,)).fetchone()
                        if not info: raise ValueError('模块引用未登记资源：'+digest)
                        source = store.asset_path(digest)
                        target = workspace.checked(directory/'资源'/digest[:2]/digest)
                        if not target.exists():
                            if not source.is_file() or store.hash_file(source) != digest: raise ValueError('模块原始资源缺失或损坏')
                            target.parent.mkdir(parents=True,exist_ok=True)
                            temp = target.with_name(digest+'.'+secrets.token_hex(8)+'.tmp')
                            try:
                                shutil.copyfile(source,temp)
                                with temp.open('rb') as handle: os.fsync(handle.fileno())
                                os.replace(temp,target)
                            finally:
                                if temp.exists(): temp.unlink()
                        elif target.stat().st_size != info['size']: raise ValueError('模块资源大小校验失败')
                        location = target.relative_to(workspace.root).as_posix()
                        db.execute('INSERT OR IGNORE INTO asset_locations VALUES (?,?)',(digest,location))
                        assets.append(dict(id=digest,mime=info['mime'],size=info['size']))
                    atomic_json(workspace.checked(workspace.root/relative), dict(format=4,kind=kind,id=identity,
                        owner=row['owner'],revision=row['revision'],data=value,assets=assets))
                    db.execute('INSERT OR REPLACE INTO module_records VALUES (?,?,?)',(kind,identity,relative))
                    if old and old['path'] != relative:
                        workspace.checked(workspace.root/old['path']).unlink(missing_ok=True)
                else:
                    if old: workspace.checked(workspace.root/old['path']).unlink(missing_ok=True)
                    db.execute('DELETE FROM module_records WHERE kind=? AND id=?',(kind,identity))
                db.execute('DELETE FROM module_outbox WHERE kind=? AND id=?',(kind,identity))
            metadata = {table:[dict(row) for row in db.execute('SELECT * FROM '+table)]
                        for table in ('assets','asset_links','receipts','migrations','module_records','asset_locations')}
            atomic_json(workspace.root/'运行数据/协调记录/索引快照.json',metadata)
            # Use SQL COMMIT: calling the subclass commit would recurse.
            db.execute('COMMIT')
            publication_marker.unlink(missing_ok=True)
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        # Readable copies are derived conveniences, not authoritative save data.
        # Keep ordering under LOCK, but release the database transaction first.
        from .portrait_files import sync_directory
        for directory in sorted(portrait_directories):
            try:
                sync_directory(store, directory)
            except Exception:
                logging.getLogger(__name__).exception(
                    '立绘浏览目录同步失败；正式存档已提交：%s', directory)


def read_catalog(save_root, kind):
    from .module_store import ModuleStore
    workspace = Workspace(save_root)
    if not workspace.active:
        path = Path(save_root) / ('棋子库/棋子库.json' if kind == 'template' else '玩家档案/物品库.json')
        return json.loads(path.read_text('utf-8'))
    store = ModuleStore(save_root)
    db = store.connect()
    try:
        db.execute('BEGIN')
        meta = store.document(db,'catalog-meta',kind)
        if not meta: raise FileNotFoundError(kind)
        data = dict(meta['data'])
        order = data.pop('_order', [])
        rows = {r['id']:json.loads(r['payload']) for r in db.execute('SELECT id,payload FROM documents WHERE kind=?',(kind,))}
        data['presets' if kind == 'template' else 'templates'] = [rows.pop(k) for k in order if k in rows] + list(rows.values())
        return data
    finally: db.close()


def write_catalog(save_root, kind, data, db=None):
    from .module_store import ModuleStore
    workspace = Workspace(save_root)
    if not workspace.active:
        path = Path(save_root) / ('棋子库/棋子库.json' if kind == 'template' else '玩家档案/物品库.json')
        from .player_profiles import atomic
        atomic(path,data); return
    field = 'presets' if kind == 'template' else 'templates'
    entries = data[field]
    ids = [str(v['id']) for v in entries]
    if len(set(ids)) != len(ids): raise ValueError('模板身份重复')
    store = ModuleStore(save_root)
    data = store.externalize(data,'catalog:'+kind, db)
    entries = data[field]
    with (store.transaction() if db is None else nullcontext(db)) as db:
        for entry in entries:
            if entry.get('ownedPieceId') or entry.get('characterId'): raise ValueError('玩家角色应保存在玩家包中')
            cid = entry.get('campaignId') if entry.get('scope') == 'campaign' else ''
            if kind == 'template':
                full_category = str(entry.get('category',''))
                category = full_category.split('/')[0]
                cid = next((identity for identity,name in workspace.config.get('campaignNames',{}).items()
                            if name == category or name.startswith(category+'-')), '') if category else ''
                cid = entry.get('campaignId','') or cid
                if not cid and category == '玩家':
                    cid = next((i for i,n in workspace.config.get('campaignNames',{}).items() if n and n in full_category), '')
            private_collection = kind == 'template' and str(entry.get('category','')).startswith('城主/')
            owner = 'campaign:'+cid if cid else 'general:'+key('私人收藏' if private_collection else entry.get('moduleId') or '本地通用')
            old = store.document(db,kind,entry['id'])
            if old and old['data'] == entry and old['owner'] == owner: continue
            if old and old['owner'] != owner:
                # A host classification edit explicitly moves template ownership.
                db.execute('UPDATE documents SET owner=? WHERE kind=? AND id=?',(owner,kind,entry['id']))
            store.write_document(db,kind,entry['id'],owner,entry,old['revision'] if old else 0)
        for row in db.execute('SELECT id FROM documents WHERE kind=?',(kind,)).fetchall():
            if row[0] not in ids: db.execute('DELETE FROM documents WHERE kind=? AND id=?',(kind,row[0]))
        meta = {k:v for k,v in data.items() if k != field}; meta['_order'] = ids
        old = store.document(db,'catalog-meta',kind)
        store.write_document(db,'catalog-meta',kind,'',meta,old['revision'] if old else 0)


def cache_root(save_root, app_root):
    workspace = Workspace(save_root)
    return workspace.root/'运行数据/.sundoll-cache/联机资源' if workspace.active else Path(app_root).parent/'用户数据/.sundoll-cache/联机资源'
