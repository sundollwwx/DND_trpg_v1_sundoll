"""Account-owned characters. Room databases contain scenes, never character copies.

The global database is attached to the room's SQLite transaction (rollback journal,
FULL sync). Loot removal and character inventory changes therefore commit together.
Legacy player IDs are transport adapters only; ownership is character.account_id.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
from contextlib import contextmanager
from .email_accounts import AccountError
from .module_store import RevisionConflict, encode

_CONFIG = {}
_READY = set()

class ClosingConnection(sqlite3.Connection):
    """SQLite's default context manager ends transactions but leaves files open."""
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()

def configure(save_root, root, room):
    _CONFIG[str(Path(save_root).resolve())] = (Path(root), room)

def context(save_root):
    return _CONFIG.get(str(Path(save_root).resolve()))

def central_root(accounts):
    return accounts.root.parent / '账号角色'

def assets_in(value):
    found = set()
    def visit(v):
        if isinstance(v, dict):
            for item in v.values(): visit(item)
        elif isinstance(v, list):
            for item in v: visit(item)
        elif isinstance(v, str) and re.fullmatch('/api/module-assets/[a-f0-9]{64}', v): found.add(v.rsplit('/', 1)[-1])
    visit(value)
    return found

def merge_claim_receipts(target, incoming, conflicts):
    """A collision must never replace a receipt and enable a second deduction."""
    for key,receipt in incoming.items():
        previous=target.get(key)
        if previous is None or previous==receipt:
            target[key]=receipt
        else:
            archive=conflicts.setdefault(key,[])
            for value in (previous,receipt):
                if value['signature']!='claim-conflict' and value not in archive:archive.append(value)
            target[key]=dict(signature='claim-conflict',event=previous['event'])

class Characters:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.database = self.root / '角色.sqlite3'
        key=str(self.database.resolve())
        if key in _READY and self.database.is_file(): return
        with self.connect() as db:
            if (self.root/'格式.json').exists():
                required={'meta','carriers','characters','bags','room_characters','migrations','assets','events'}
                tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not required<=tables:raise OSError('账号角色数据库结构不完整，未创建空表；请恢复一致备份')
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
                INSERT OR IGNORE INTO meta VALUES (1,1);
                CREATE TABLE IF NOT EXISTS carriers (id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL, metadata TEXT NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS carrier_account ON carriers(account_id) WHERE account_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, carrier TEXT NOT NULL, account_id TEXT, custodian TEXT NOT NULL, active_room TEXT, sheet TEXT NOT NULL, runtime TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS bags (character_id TEXT PRIMARY KEY REFERENCES characters(id), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS room_characters (room TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), PRIMARY KEY(room,character_id));
                CREATE TABLE IF NOT EXISTS room_focus (room TEXT NOT NULL, account_id TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES characters(id), PRIMARY KEY(room,account_id));
                CREATE TABLE IF NOT EXISTS migrations (room TEXT PRIMARY KEY, receipt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, operation TEXT NOT NULL, character_id TEXT, actor TEXT, payload TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            """)

        self.database.chmod(0o600)
        marker=self.root/'格式.json'
        if not marker.exists():
            from .workspace import atomic_json
            atomic_json(marker,{'format':'account-characters-v1'})
        _READY.add(key)

    def connect(self):
        marker=self.root/'格式.json'
        if marker.exists() and not self.database.is_file():raise OSError('账号角色数据库缺失，已停止读取；请恢复一致备份')
        database = self.database.absolute().as_uri() + ('?mode=rw' if marker.exists() else '?mode=rwc')
        db=sqlite3.connect(database, uri=True, timeout=15, isolation_level=None, factory=ClosingConnection)
        try:
            db.row_factory=sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA journal_mode=DELETE')
            db.execute('PRAGMA synchronous=FULL')
            return db
        except BaseException:
            db.close()
            raise

    @contextmanager
    def transaction(self):
        db=self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback();raise
        finally: db.close()

    def adopt_assets(self, values, local):
        for digest in assets_in(values):
            target=self.root/'资源'/digest[:2]/digest
            with self.connect() as db:
                registered=db.execute('SELECT size FROM assets WHERE id=?',(digest,)).fetchone()
            if target.exists() and registered and target.stat().st_size==registered['size']: continue
            asset=local.asset(digest)
            if not asset: raise ValueError('角色原始素材缺失：'+digest)
            target.parent.mkdir(parents=True,exist_ok=True)
            tmp=target.with_name(digest+'.'+secrets.token_hex(8)+'.tmp')
            try:
                shutil.copyfile(asset[0],tmp)
                if hashlib.sha256(tmp.read_bytes()).hexdigest()!=digest: raise ValueError('角色素材校验失败')
                with tmp.open('rb') as f: os.fsync(f.fileno())
                os.replace(tmp,target)
            finally:
                if tmp.exists(): tmp.unlink()
            with self.transaction() as db:
                db.execute('INSERT OR IGNORE INTO assets VALUES (?,?,?)',(digest,asset[1],asset[2]))

    def supply_assets(self, values, local):
        # Immutable content-addressed copies let the existing room asset ACL work.
        with self.connect() as db:
            for digest in assets_in(values):
                if local.asset(digest): continue
                asset=db.execute('SELECT * FROM assets WHERE id=?',(digest,)).fetchone()
                if not asset: raise ValueError('角色素材记录缺失')
                raw=(self.root/'资源'/digest[:2]/digest).read_bytes()
                if len(raw)!=asset['size'] or hashlib.sha256(raw).hexdigest()!=digest:
                    raise ValueError('角色原始素材校验失败，未复制到房间')
                local.put_asset(raw,asset['mime'],'account-character')

    def migrate(self, rid, profiles, player_id=None):
        from .module_store import ModuleStore
        local=ModuleStore(profiles.save_root)
        migration_key=rid+(':'+player_id if player_id else '')
        with self.connect() as db:
            if db.execute('SELECT 1 FROM migrations WHERE room=?',(migration_key,)).fetchone(): return
        db=local.connect()
        try:
            db.execute('BEGIN')
            docs={(row['kind'],row['id']):json.loads(row['payload']) for row in db.execute("SELECT kind,id,payload FROM documents WHERE kind IN ('player-library','runtime-character','runtime-backpack')")}
            people=[p for p in profiles.players() if player_id is None or p['playerId']==player_id]
        finally: db.close()
        self.adopt_assets(list(docs.values()),local)
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM migrations WHERE room=?',(migration_key,)).fetchone(): return
            for person in people:
                pid=person['playerId']; account=person.get('accountId') or None
                if db.execute('SELECT 1 FROM carriers WHERE id=? OR (account_id=? AND ? IS NOT NULL)',(pid,account,account)).fetchone():
                    raise ValueError('旧角色归属与其他房间重复，需核对后迁移，未覆盖数据')
                bag=copy.deepcopy(docs.get(('runtime-backpack',pid),dict(playerId=pid,scope='global',revision=0,items=[],history=[],receipts={})))
                library=docs.get(('player-library',pid)) or profiles.library(pid)
                ids={p['ownedPieceId'] for p in library['pieces']}
                all_items=bag.get('items',[])+[r['item'] for r in bag.get('removedItems',[])]
                if any(i.get('ownerCharacterId') not in ids for i in all_items): raise ValueError('有旧物品未明确归属角色，未迁移或丢弃')
                metadata={k:v for k,v in bag.items() if k not in ('items','removedItems','wallets')}
                metadata['libraryRevision']=library['revision'];metadata['grants']=library.get('grants',{})
                db.execute('INSERT INTO carriers VALUES (?,?,?,?,?)',(pid,account,person['name'],int(person.get('enabled',True)),encode(metadata)))
                for piece in library['pieces']:
                    cid=piece['ownedPieceId'];runtime=docs.get(('runtime-character',cid))
                    if runtime is None:
                        from .resources import ResourceStore
                        base=ResourceStore.base(piece)
                        runtime=dict(id=cid,ownerPlayerId=pid,name=piece['name'],revision=1,base=base,runtime=ResourceStore.runtime(piece,base))
                    db.execute('INSERT INTO characters VALUES (?,?,?,?,?,?,?)',(cid,pid,account,rid,rid,encode(piece),encode(runtime)))
                    contents=dict(items=[i for i in bag.get('items',[]) if i['ownerCharacterId']==cid],removedItems=[r for r in bag.get('removedItems',[]) if r['item']['ownerCharacterId']==cid],wallet=bag.get('wallets',{}).get(cid))
                    db.execute('INSERT INTO bags VALUES (?,?)',(cid,encode(contents)))
                    db.execute('INSERT INTO room_characters VALUES (?,?)',(rid,cid))
            db.execute('INSERT INTO migrations VALUES (?,?)',(migration_key,encode(dict(characters=sum(len(v['pieces']) for (kind,_),v in docs.items() if kind=='player-library'),profiles=len(people)))))
            db.execute('UPDATE meta SET revision=revision+1')

    @staticmethod
    def summary(row):
        runtime=json.loads(row['runtime']);sheet=json.loads(row['sheet'])
        return dict(characterId=row['id'],name=runtime['name'],accountId=row['account_id'],activeRoomId=row['active_room'],enabled=bool(row['enabled']) if 'enabled' in row.keys() else True,level=runtime['base'].get('level',1),role=sheet.get('collectionRole','character'))

    def mine(self, account):
        with self.connect() as db:
            return [self.summary(row) for row in db.execute('SELECT c.*,p.enabled FROM characters c JOIN carriers p ON p.id=c.carrier WHERE c.account_id=? ORDER BY c.id',(account,))]

    def room_list(self, rid):
        with self.connect() as db:
            return [self.summary(row) for row in db.execute('SELECT c.*,p.enabled FROM characters c JOIN carriers p ON p.id=c.carrier JOIN room_characters r ON r.character_id=c.id WHERE r.room=? ORDER BY c.id',(rid,))]

    def carrier(self, db, account, name):
        row=db.execute('SELECT id FROM carriers WHERE account_id=?',(account,)).fetchone()
        if row:return row['id']
        pid='p'+secrets.token_hex(16)
        meta=dict(playerId=pid,scope='global',revision=0,history=[],receipts={},libraryRevision=1,grants={})
        db.execute('INSERT INTO carriers VALUES (?,?,?,?,?)',(pid,account,name,1,encode(meta)))
        return pid

    def create(self, account, account_name, name, request_id, base=None):
        if not isinstance(name,str) or not 1<=len(name.strip())<=60 or any(ord(c)<32 for c in name):raise AccountError('角色名称需为 1–60 个字符')
        if not re.fullmatch(r'[A-Za-z0-9_-]{16,96}',str(request_id)):raise AccountError('创建操作编号无效')
        base=base or dict(hpMax=1,ac=10,level=1)
        if not isinstance(base,dict) or set(base)!=set(('hpMax','ac','level')):raise AccountError('角色基础数值无效')
        for key,lo,hi in [('hpMax',1,99999),('ac',0,99),('level',1,99)]:
            if type(base[key]) is not int or not lo<=base[key]<=hi:raise AccountError('角色基础数值超出范围')
        # Stable per-account request identity prevents duplicate cards after retries.
        cid='o'+hashlib.sha256((account+':'+request_id).encode()).hexdigest()[:32]
        with self.transaction() as db:
            existing=db.execute('SELECT * FROM characters WHERE id=?',(cid,)).fetchone()
            if existing:
                if json.loads(existing['sheet']).get('creationSpec')!={'name':name.strip(),'base':base}:raise AccountError('创建请求已被使用',409)
                return self.summary(existing)
            pid=self.carrier(db,account,account_name)
            piece=dict(ownedPieceId=cid,ownerPlayerId=pid,characterId=cid,name=name.strip(),type='pc',icon='🧙',revision=1,hp=base['hpMax'],**base,collectionRole='character',creationSpec={'name':name.strip(),'base':base})
            runtime=dict(id=cid,ownerPlayerId=pid,name=piece['name'],revision=1,base=base,runtime=dict(hp=base['hpMax'],tempHp=0,tempHpMax=0,conditions=[],spellSlots=[],resourceSlots=[]))
            db.execute('INSERT INTO characters VALUES (?,?,?,?,?,?,?)',(cid,pid,account,'',None,encode(piece),encode(runtime)))
            db.execute('INSERT INTO bags VALUES (?,?)',(cid,encode(dict(items=[],removedItems=[],wallet=None))))
            db.execute('UPDATE meta SET revision=revision+1')
            return self.summary(db.execute('SELECT * FROM characters WHERE id=?',(cid,)).fetchone())

    def select(self, account, rid, cid, expected_room):
        with self.transaction() as db:
            row=db.execute('SELECT c.*,p.enabled FROM characters c JOIN carriers p ON p.id=c.carrier WHERE c.id=? AND c.account_id=?',(cid,account)).fetchone()
            if not row:raise AccountError('请选择自己的角色',404)
            if not row['enabled']:raise AccountError('角色已停用，请联系管理员',403)
            # A stale confirmation must not revive a character detached in another tab.
            if row['active_room'] not in (rid,expected_room):raise AccountError('角色所在房间已变化，请刷新后重新选择',409)
            focus=db.execute('SELECT character_id FROM room_focus WHERE room=? AND account_id=?',(rid,account)).fetchone()
            selected=db.execute('SELECT 1 FROM room_characters WHERE room=? AND character_id=?',(rid,cid)).fetchone()
            if row['active_room']==rid and selected and focus and focus[0]==cid:
                return self.summary(row)
            db.execute('INSERT OR IGNORE INTO room_characters VALUES (?,?)',(rid,cid))
            db.execute('INSERT INTO room_focus VALUES (?,?,?) ON CONFLICT(room,account_id) DO UPDATE SET character_id=excluded.character_id',(rid,account,cid))
            db.execute('UPDATE characters SET active_room=? WHERE id=?',(rid,cid))
            db.execute('INSERT INTO events(operation,character_id,actor,payload) VALUES (?,?,?,?)',('select-room',cid,account,encode(dict(before=row['active_room'],after=rid))))
            db.execute('UPDATE meta SET revision=revision+1')
            return self.summary(db.execute('SELECT * FROM characters WHERE id=?',(cid,)).fetchone())

    def detach(self,rid,account):
        with self.transaction() as db:
            self.detach_into(db,rid,account)

    @staticmethod
    def detach_into(db,rid,account,schema='main'):
        if schema not in ('main','people'):raise ValueError('Invalid character database')
        before=db.total_changes
        db.execute(f'DELETE FROM {schema}.room_focus WHERE room=? AND account_id=?',(rid,account))
        db.execute(f'DELETE FROM {schema}.room_characters WHERE room=? AND character_id IN (SELECT id FROM {schema}.characters WHERE account_id=?)',(rid,account))
        db.execute(f'UPDATE {schema}.characters SET active_room=NULL WHERE account_id=? AND active_room=?',(account,rid))
        if db.total_changes!=before:db.execute(f'UPDATE {schema}.meta SET revision=revision+1')

    def bind(self, rid, cid, account, name, actor):
        with self.transaction() as db:
            row=db.execute('SELECT * FROM characters WHERE id=? AND custodian=?',(cid,rid)).fetchone()
            if not row:raise AccountError('待认领角色不存在',404)
            carrier=db.execute('SELECT enabled FROM carriers WHERE id=?',(row['carrier'],)).fetchone()
            if not carrier['enabled']:raise AccountError('旧角色已停用，不能直接认领',403)
            if row['account_id']:
                if row['account_id']==account:return self.summary(row)
                raise AccountError('角色已有所属账号，不能覆盖',409)
            pid=self.carrier(db,account,name)
            contents=json.loads(db.execute('SELECT payload FROM bags WHERE character_id=?',(cid,)).fetchone()[0])
            item_ids={i['id'] for i in contents['items']+[entry['item'] for entry in contents.get('removedItems',[])]}
            belongs=lambda event: event.get('itemId') in item_ids or cid in (event.get('characterId'),event.get('sourceCharacterId'))
            source_meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(row['carrier'],)).fetchone()[0])
            target_meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(pid,)).fetchone()[0])
            known={event['id']:event for event in target_meta.get('history',[])}
            for event in source_meta.get('history',[]):
                if not belongs(event) or known.get(event['id'])==event:continue
                if event['id'] in known:
                    event=dict(event,originalEventId=event['id'],id='claimed-'+hashlib.sha256((row['carrier']+encode(event)).encode()).hexdigest())
                target_meta.setdefault('history',[]).append(event);known[event['id']]=event
            conflicts=target_meta.setdefault('claimReceiptConflicts',{})
            merge_claim_receipts(target_meta.setdefault('receipts',{}),{key:receipt for key,receipt in source_meta.get('receipts',{}).items() if belongs(receipt['event'])},conflicts.setdefault('current',{}))
            for campaign,receipts in source_meta.get('legacyReceipts',{}).items():
                merge_claim_receipts(target_meta.setdefault('legacyReceipts',{}).setdefault(campaign,{}),{key:r for key,r in receipts.items() if belongs(r['event'])},conflicts.setdefault(campaign,{}))
            target_meta['revision']=max(target_meta['revision'],source_meta['revision'])+1
            target_meta['libraryRevision']=max(target_meta.get('libraryRevision',1),source_meta.get('libraryRevision',1))+1
            db.execute('UPDATE carriers SET metadata=? WHERE id=?',(encode(target_meta),pid))
            runtime=json.loads(row['runtime']);sheet=json.loads(row['sheet'])
            runtime['ownerPlayerId']=pid;runtime['revision']+=1;sheet['ownerPlayerId']=pid
            db.execute('UPDATE characters SET carrier=?,account_id=?,runtime=?,sheet=? WHERE id=?',(pid,account,encode(runtime),encode(sheet),cid))
            db.execute('INSERT INTO events(operation,character_id,actor,payload) VALUES (?,?,?,?)',('claim',cid,actor,encode(dict(oldCarrier=row['carrier'],accountId=account))))
            db.execute('UPDATE meta SET revision=revision+1')
            return self.summary(db.execute('SELECT * FROM characters WHERE id=?',(cid,)).fetchone())


def registry(app):
    accounts=app.account_store()
    value=getattr(accounts,'_characters',None)
    if value is not None:return value
    value=Characters(central_root(accounts))
    from .player_profiles import Store
    for room in sorted((accounts.root.parent/'战役空间').glob('r*')):
        if not re.fullmatch(r'r[0-9a-f]{32}',room.name) or not room.is_dir():continue
        save=room/'运行数据/存档'
        if not (save/'模块存储/模块.sqlite3').is_file():continue
        value.migrate(room.name,Store(save,app.ROOT,Path(app.ASSET_ROOT)))
    accounts._characters=value
    return value
