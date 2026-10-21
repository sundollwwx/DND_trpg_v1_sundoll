"""Durable room state, tied to committed storage rather than SQLite file bytes."""
import hashlib
import json
from contextlib import closing
import os
from pathlib import Path
import secrets
import sqlite3
from .workspace import Workspace
from .save_storage import campaign_identity, campaign_text_hash


TRACKED = ('campaign-commit', 'runtime-map', 'runtime-character',
           'runtime-backpack', 'archived-player')


class CheckpointConflict(Exception):
    status = 409


def _conflict():
    raise CheckpointConflict('正式存档已更新，请重新载入战役后发布；旧运行状态未确认保存')


def _atomic_private_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(12) + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(value,handle,ensure_ascii=False,separators=(',',':'),allow_nan=False)
            handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary,path)
        if os.name != 'nt':
            descriptor=os.open(path.parent,os.O_RDONLY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


class RoomCheckpoint:
    def __init__(self, root, room_id, protocol):
        self.root = Path(root)
        self.room_id = room_id
        self.protocol = protocol
        self.path = self.root / '运行数据/房间运行状态.json'
        self.database = self.root / '运行数据/存档/模块存储/模块.sqlite3'
        self._files = {}
        self._last = None
        self._state_version = None
        self._source = None
        self._stale = False
        # A committed counter sees WAL changes too. Rebuilt databases receive a
        # new identity, so a checkpoint cannot accidentally match a fresh store.
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS room_checkpoint_generation '
                       '(id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, revision INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO room_checkpoint_generation VALUES (1,?,0)', (secrets.token_hex(24),))
            kinds = ','.join("'" + kind + "'" for kind in TRACKED)
            for operation, prefix in (('INSERT', 'new'), ('UPDATE', 'new'), ('DELETE', 'old')):
                db.execute(f'CREATE TRIGGER IF NOT EXISTS room_checkpoint_{operation.lower()} '
                           f'AFTER {operation} ON documents WHEN {prefix}.kind IN ({kinds}) BEGIN '
                           'UPDATE room_checkpoint_generation SET revision=revision+1 WHERE id=1; END')

    def _formal_campaign(self, campaign):
        """Read immutable IDs, without catalog publication or its write locks.

        The host may use ``id-name`` directories, so Workspace.campaign(id)
        alone is not an identity index. Only changed files are read/hashed;
        each request checks shallow directory/file metadata to detect renames,
        direct edits and newly conflicting IDs as well as committed API writes.
        """
        workspace = Workspace(self.root / '运行数据/存档')
        matches = []
        live = set()
        if not workspace.campaigns.exists():
            return None
        for folder in workspace.campaigns.iterdir():
            workspace.checked(folder)
            if not folder.is_dir():
                continue
            path = workspace.checked(folder / '当前存档.json')
            if not path.is_file():
                continue
            stat = path.stat()
            signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            live.add(str(path))
            cached = self._files.get(str(path))
            if not cached or cached[0] != signature:
                raw = path.read_bytes()
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise CheckpointConflict('正式战役存档格式无效，请先保留并检查原文件')
                # Historical bare-ID directories may predate explicit IDs.
                identity = campaign_identity(value) or folder.name
                if not isinstance(identity, str):
                    raise CheckpointConflict('正式战役身份无效，请先保留并检查原文件')
                cached = (signature, campaign_text_hash(raw), identity)
                self._files[str(path)] = cached
            if cached[2] == campaign:
                archived = workspace.checked(folder / '已删除.json').exists()
                matches.append((cached[1], archived))
        self._files = {path: value for path, value in self._files.items() if path in live}
        if len(matches) > 1:
            raise CheckpointConflict('战役身份重复，请先保留并核对各目录，旧运行状态未确认保存')
        if matches and matches[0][1]:
            raise CheckpointConflict('战役已归档，请先恢复原战役，旧运行状态未确认保存')
        return matches[0][0] if matches else None

    def source(self, state):
        with closing(sqlite3.connect(self.database.as_uri() + '?mode=ro', uri=True)) as db:
            generation = db.execute('SELECT epoch,revision FROM room_checkpoint_generation WHERE id=1').fetchone()
        campaign = str((state or {}).get('campaignId') or '')
        digest = self._formal_campaign(campaign) if campaign else None
        return dict(epoch=generation[0], revision=generation[1], campaignId=campaign, campaignHash=digest)

    @staticmethod
    def runtime(app):
        return dict(state=app.STATE, revision=app.STATE_REVISION, actions=app.RECENT_ACTIONS,
                    nextSeq=app.NEXT_SEQ, actionIds=app.ACTION_IDS, bgm=app.BGM_STATE)

    @staticmethod
    def signature(app):
        # Revision advances on state/action mutations. BGM has its own clock.
        return (app.STATE_REVISION, app.NEXT_SEQ,
                json.dumps(app.BGM_STATE, sort_keys=True, ensure_ascii=False, allow_nan=False))

    def load(self, app):
        if not self.path.exists():
            return False
        saved = json.loads(self.path.read_text('utf-8'))
        if saved.get('protocolVersion') != self.protocol:
            raise RuntimeError('房间运行状态版本不兼容，请管理员保留检查点并安排迁移')
        # Old checkpoints had no room/storage binding. Preserve them for manual
        # review, but never overlay their unprovable state on committed progress.
        if saved.get('schemaVersion') != 2 or saved.get('roomId') != self.room_id:
            self.preserve()
            return False
        try:
            current_source = self.source(saved.get('state'))
        except CheckpointConflict:
            self.preserve()
            return False
        if (saved.get('source') != current_source or (current_source['campaignHash']
                and (saved.get('state') or {}).get('_formalSourceHash') != current_source['campaignHash'])):
            self.preserve()
            return False
        for key in ('state', 'revision', 'actions', 'nextSeq', 'actionIds', 'bgm'):
            if key not in saved:
                raise RuntimeError('房间检查点不完整，请保留文件并安排恢复')
        app.STATE = saved['state']
        app.STATE_REVISION = saved['revision']
        app.RECENT_ACTIONS = saved['actions']
        app.NEXT_SEQ = saved['nextSeq']
        app.ACTION_IDS = saved['actionIds']
        app.BGM_STATE = saved['bgm']
        self._last = self.signature(app)
        self._state_version = (app.STATE_REVISION, app.NEXT_SEQ)
        self._source = saved['source']
        return True

    def preserve(self):
        folder = self.root / '运行数据/检查点保留'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.replace(folder / ('房间运行状态-' + secrets.token_hex(12) + '.json'))

    def validate_state_source(self, state):
        source=self.source(state)
        if ((source['campaignHash'] or (state or {}).get('_formalSourceHash'))
                and (state or {}).get('_formalSourceHash')!=source['campaignHash']):
            _conflict()

    def save(self, app, force=False, acknowledge=False, rebase=False):
        if app.STATE is None and not force:
            return False
        signature = self.signature(app)
        state_version = (app.STATE_REVISION, app.NEXT_SEQ)
        source = self.source(app.STATE)
        # The host attaches the hash it actually loaded or successfully saved.
        # Merely moving a piece / advancing revision / republishing an old full
        # state cannot establish lineage with a newer formal campaign file.
        proven = bool(source['campaignHash']) and (app.STATE or {}).get('_formalSourceHash') == source['campaignHash']
        if (source['campaignHash'] or (app.STATE or {}).get('_formalSourceHash')) and not proven:
            self._stale = True
            if acknowledge: _conflict()
            return False
        if (self._source is not None and source != self._source and signature == self._last
                and not proven):
            self._stale = True
        if self._stale and not (rebase and proven):
            if acknowledge: _conflict()
            return False
        if not force and signature == self._last and source == self._source:
            return False
        value = dict(schemaVersion=2, roomId=self.room_id, protocolVersion=self.protocol,
                     source=source, **self.runtime(app))
        _atomic_private_json(self.path, value)
        self._last, self._source, self._stale = signature, source, False
        self._state_version = state_version
        return True
