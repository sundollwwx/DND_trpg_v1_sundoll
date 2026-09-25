from contextlib import nullcontext
"""Transactional module registry and immutable original assets (never a cache).

Only trusted server code opens this store. HTTP authorization belongs at the
request boundary; knowing a digest does not confer permission to read it.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from contextlib import contextmanager
from .workspace import Workspace, setup_projection, project


class ModuleConnection(sqlite3.Connection):
    def commit(self):
        super().commit()
        if getattr(self, 'module_store', None): project(self.module_store, self)

ASSET_URL = '/api/module-assets/'
DIGEST = re.compile(r'^[0-9a-f]{64}$')
IMAGE_DATA = re.compile(r'^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


class RevisionConflict(ValueError):
    pass


class ModuleStore:
    def __init__(self, save_root):
        self.workspace = Workspace(save_root)
        self.root = Path(save_root) / '模块存储'
        self.assets = self.root / '原始资源'
        self.database = self.root / '模块.sqlite3'

    def connect(self):
        from .player_directories import recover
        recover(self.workspace.save)
        self.root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(str(self.database), timeout=15, isolation_level=None, factory=ModuleConnection)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA cache_size=-4096')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS documents (
                kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL,
                revision INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(kind,id));
            CREATE INDEX IF NOT EXISTS documents_owner ON documents(kind,owner);
            CREATE TABLE IF NOT EXISTS asset_links (
                scope TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
                PRIMARY KEY(scope,asset_id));
            CREATE TABLE IF NOT EXISTS receipts (
                scope TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL,
                result TEXT NOT NULL, PRIMARY KEY(scope,id));
            CREATE TABLE IF NOT EXISTS migrations (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        ''')
        if self.workspace.active:
            db.module_store = self
            setup_projection(db)
            try: project(self, db)
            except BaseException:
                db.close(); raise
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def asset_path(self, digest):
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('资源编号无效')
        path = self.assets / digest[:2] / digest
        if self.workspace.active and not path.exists() and self.database.exists():
            db = sqlite3.connect(str(self.database), timeout=15)
            try:
                exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='asset_locations'").fetchone()
                locations = db.execute('SELECT path FROM asset_locations WHERE id=?',(digest,)).fetchall() if exists else []
                for row in locations:
                    candidate = self.workspace.checked(self.workspace.root / row[0])
                    if candidate.is_file(): return candidate
            finally: db.close()
        if any(p.is_symlink() for p in (self.root, self.assets, path.parent, path)):
            raise ValueError('资源仓库不允许符号链接')
        return path

    def put_asset(self, raw, mime, scope, db=None):
        if not raw or len(raw) > 128 * 1024 * 1024:
            raise ValueError('资源为空或超过 128 MiB')
        if mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif',
                        'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'application/pdf',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'text/plain'):
            raise ValueError('不支持此资源类型')
        digest = hashlib.sha256(raw).hexdigest()
        path = self.asset_path(digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Existing originals are verified too: a damaged file must not be blessed.
        if path.exists():
            if self.hash_file(path) != digest:
                raise ValueError('原始资源校验失败：' + digest)
        else:
            temp = path.with_name(digest + '.' + secrets.token_hex(8) + '.tmp')
            try:
                with temp.open('xb') as handle:
                    handle.write(raw)
                    handle.flush()
                    os.fsync(handle.fileno())
                if self.hash_file(temp) != digest:
                    raise OSError('原始资源写入校验失败')
                os.replace(temp, path)
            finally:
                if temp.exists(): temp.unlink()
        def register(conn):
            existing = conn.execute('SELECT mime,size FROM assets WHERE id=?', (digest,)).fetchone()
            if existing and (existing['mime'] != mime or existing['size'] != len(raw)):
                raise ValueError('相同资源的类型或大小冲突')
            conn.execute('INSERT OR IGNORE INTO assets VALUES (?,?,?)', (digest, mime, len(raw)))
            conn.execute('INSERT OR IGNORE INTO asset_links VALUES (?,?)', (scope, digest))
        if db is None:
            with self.transaction() as conn: register(conn)
        else:
            register(db)
        return ASSET_URL + digest

    @staticmethod
    def hash_file(path):
        value = hashlib.sha256()
        with Path(path).open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                value.update(chunk)
        return value.hexdigest()

    def asset(self, digest):
        path = self.asset_path(digest)
        db = self.connect()
        try:
            row = db.execute('SELECT mime,size FROM assets WHERE id=?', (digest,)).fetchone()
        finally:
            db.close()
        if not row or not path.is_file() or path.stat().st_size != row['size']:
            return None
        return path, row['mime'], row['size']

    def externalize(self, value, scope, db=None):
        """Copy a JSON tree, replace image data only, and validate existing links.

        An interrupted operation can leave unreferenced immutable files, never a
        live document referencing a half-written file. Originals are not GC'd.
        """
        with (self.transaction() if db is None else nullcontext(db)) as db:
            def visit(node):
                if isinstance(node, dict): return {k: visit(v) for k, v in node.items()}
                if isinstance(node, list): return [visit(v) for v in node]
                if not isinstance(node, str): return node
                match = IMAGE_DATA.fullmatch(node)
                if match:
                    raw = base64.b64decode(re.sub(r'\s', '', match[2]), validate=True)
                    return self.put_asset(raw, match[1], scope, db)
                if node.startswith(ASSET_URL):
                    digest = node[len(ASSET_URL):]
                    path = self.asset_path(digest)
                    row = db.execute('SELECT size FROM assets WHERE id=?', (digest,)).fetchone()
                    if not row or not path.is_file() or path.stat().st_size != row['size']:
                        raise ValueError('缺少原始资源：' + digest)
                    db.execute('INSERT OR IGNORE INTO asset_links VALUES (?,?)', (scope, digest))
                return node
            return visit(value)

    @staticmethod
    def document(db, kind, identity):
        row = db.execute('SELECT owner,revision,payload FROM documents WHERE kind=? AND id=?', (kind, identity)).fetchone()
        return dict(owner=row['owner'], revision=row['revision'], data=json.loads(row['payload'])) if row else None

    @staticmethod
    def write_document(db, kind, identity, owner, data, expected_revision):
        old = ModuleStore.document(db, kind, identity)
        actual = old['revision'] if old else 0
        if actual != expected_revision:
            raise RevisionConflict('资料已更新，请重新读取后修改')
        if old and old['owner'] != owner:
            raise RevisionConflict('资料归属不一致')
        revision = actual + 1
        db.execute('INSERT INTO documents VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
                   (kind, identity, owner, revision, encode(data)))
        return revision
