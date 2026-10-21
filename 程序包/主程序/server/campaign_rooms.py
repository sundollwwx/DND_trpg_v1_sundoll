"""Account membership is scoped to a room, never a global host privilege."""
import re
import secrets
import time
import unicodedata
from .email_accounts import AccountError, email_key, token_hash

ROOM_ID = re.compile(r'r[0-9a-f]{32}\Z')


class RoomStore:
    def __init__(self, accounts):
        self.accounts = accounts
        with accounts.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS room_members (
                    room_id TEXT NOT NULL, account_id TEXT NOT NULL, role TEXT NOT NULL,
                    PRIMARY KEY(room_id, account_id));
                CREATE TABLE IF NOT EXISTS room_invitations (
                    hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, email TEXT NOT NULL,
                    role TEXT NOT NULL, expires REAL NOT NULL,
                    UNIQUE(room_id,email));
                CREATE TABLE IF NOT EXISTS room_share_links (
                    hash TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE,
                    expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS room_join_blocks (
                    room_id TEXT NOT NULL, account_id TEXT NOT NULL,
                    PRIMARY KEY(room_id,account_id));
                CREATE TABLE IF NOT EXISTS room_creation_receipts (
                    account_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    room_id TEXT NOT NULL, name TEXT NOT NULL,
                    PRIMARY KEY(account_id,request_id));
            ''')

    def identity(self, db, token=None, digest=None):
        row = db.execute('SELECT a.* FROM accounts a JOIN sessions s ON s.account_id=a.id '
                         'WHERE s.hash=? AND s.expires>? AND s.version=a.version '
                         'AND a.enabled=1 AND a.verified=1',
                         (digest or token_hash(token), self.accounts.clock())).fetchone()
        if not row: raise AccountError('请先登录邮箱账号', 401)
        return row

    def _member(self, db, account, room_id, *, owner=False):
        if not ROOM_ID.fullmatch(str(room_id)): raise AccountError('战役不存在或无权访问', 404)
        row = db.execute("SELECT r.*,m.role,(SELECT account_id FROM room_members o WHERE o.room_id=r.id AND o.role='owner') AS ownerId FROM rooms r JOIN room_members m ON m.room_id=r.id "
                         'WHERE r.id=? AND m.account_id=?', (room_id,account['id'])).fetchone()
        if not row: raise AccountError('战役不存在或无权访问', 404)
        if owner and row['role'] != 'owner': raise AccountError('只有创建者可以管理成员', 403)
        return dict(row)

    def access(self, room_id, *, token=None, digest=None):
        with self.accounts.db() as db:
            account = self.identity(db, token, digest)
            return dict(self._member(db,account,room_id), accountId=account['id'], accountName=account['name'])

    def list(self, token):
        with self.accounts.db() as db:
            account = self.identity(db,token)
            return [dict(row) for row in db.execute('SELECT r.*,m.role FROM rooms r JOIN room_members m '
                'ON m.room_id=r.id WHERE m.account_id=? ORDER BY r.created,r.id', (account['id'],))]

    def create(self, token, name, request_id=None):
        name = unicodedata.normalize('NFKC', str(name or '')).strip()
        if not 1 <= len(name) <= 60 or any(unicodedata.category(c).startswith('C') for c in name):
            raise AccountError('战役名称需为 1–60 个有效字符')
        if request_id is not None and (not isinstance(request_id, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', request_id)):
            raise AccountError('创建操作编号无效')
        with self.accounts.db() as db:
            account = self.identity(db,token)
            if request_id is not None:
                previous = db.execute('SELECT room_id,name FROM room_creation_receipts '
                    'WHERE account_id=? AND request_id=?', (account['id'], request_id)).fetchone()
                if previous:
                    if previous['name'] != name:
                        raise AccountError('创建请求已用于另一个房间名称，请重新提交', 409,
                                           code='ROOM_CREATE_REQUEST_CONFLICT')
                    return self._member(db, account, previous['room_id'], owner=True)
            if db.execute("SELECT count(*) FROM room_members WHERE account_id=? AND role='owner'",(account['id'],)).fetchone()[0] >= 10:
                raise AccountError('每个账号最多创建 10 个战役空间', 409)
            rid = 'r'+secrets.token_hex(16)
            db.execute('INSERT INTO rooms VALUES (?,?,?)',(rid,name,self.accounts.clock()))
            db.execute('INSERT INTO room_members VALUES (?,?,?)',(rid,account['id'],'owner'))
            if request_id is not None:
                db.execute('INSERT INTO room_creation_receipts VALUES (?,?,?,?)',
                    (account['id'], request_id, rid, name))
            return self._member(db,account,rid)

    def members(self, token, rid):
        with self.accounts.db() as db:
            account = self.identity(db,token)
            self._member(db,account,rid,owner=True)
            return [dict(row) for row in db.execute('SELECT a.id AS accountId,a.name,a.email,m.role '
                'FROM room_members m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=? ORDER BY a.name',(rid,))]

    def invite(self, token, rid, email, role):
        if role not in ('dm','player'): raise AccountError('请选择 DM 或玩家')
        email = email_key(email)
        with self.accounts.db() as db:
            account = self.identity(db,token)
            self._member(db,account,rid,owner=True)
            if db.execute('SELECT 1 FROM room_members m JOIN accounts a ON a.id=m.account_id '
                          'WHERE m.room_id=? AND a.email=?',(rid,email)).fetchone():
                raise AccountError('此邮箱已是成员，请在成员列表中调整权限',409)
            invitation = secrets.token_urlsafe(32)
            db.execute('DELETE FROM room_invitations WHERE expires<=? OR (room_id=? AND email=?)',
                       (self.accounts.clock(),rid,email))
            db.execute('INSERT INTO room_invitations VALUES (?,?,?,?,?)',
                       (token_hash(invitation),rid,email,role,self.accounts.clock()+86400))
            return invitation

    def accept(self, token, invitation):
        with self.accounts.db() as db:
            account = self.identity(db,token)
            row = db.execute('SELECT * FROM room_invitations WHERE hash=? AND email=? AND expires>?',
                             (token_hash(invitation),account['email'],self.accounts.clock())).fetchone()
            if not row: raise AccountError('邀请无效、已过期，或与当前邮箱不匹配')
            # Replaying an old invitation must never overwrite a newer role.
            db.execute('INSERT OR IGNORE INTO room_members VALUES (?,?,?)',(row['room_id'],account['id'],row['role']))
            db.execute('DELETE FROM room_join_blocks WHERE room_id=? AND account_id=?',(row['room_id'],account['id']))
            db.execute('DELETE FROM room_invitations WHERE hash=?',(token_hash(invitation),))
            return self._member(db,account,row['room_id'])

    def share(self, token, rid):
        with self.accounts.db() as db:
            account = self.identity(db, token)
            self._member(db, account, rid, owner=True)
            invitation = secrets.token_urlsafe(32)
            expires = self.accounts.clock() + 7 * 86400
            db.execute('DELETE FROM room_share_links WHERE room_id=? OR expires<=?', (rid, self.accounts.clock()))
            db.execute('INSERT INTO room_share_links VALUES (?,?,?)', (token_hash(invitation), rid, expires))
            return dict(token=invitation, expiresAt=expires)

    def revoke_share(self, token, rid):
        with self.accounts.db() as db:
            account = self.identity(db, token)
            self._member(db, account, rid, owner=True)
            db.execute('DELETE FROM room_share_links WHERE room_id=?', (rid,))

    def join(self, token, invitation):
        with self.accounts.db() as db:
            account = self.identity(db, token)
            row = db.execute('SELECT s.* FROM room_share_links s JOIN rooms r ON r.id=s.room_id '
                             'WHERE s.hash=? AND s.expires>?',
                             (token_hash(invitation), self.accounts.clock())).fetchone()
            if not row: raise AccountError('玩家邀请链接无效或已过期')
            if db.execute('SELECT 1 FROM room_join_blocks WHERE room_id=? AND account_id=?',
                          (row['room_id'], account['id'])).fetchone():
                raise AccountError('你已被移出这个房间，请让创建者重新邀请', 403)
            db.execute('INSERT OR IGNORE INTO room_members VALUES (?,?,?)', (row['room_id'], account['id'], 'player'))
            return self._member(db, account, row['room_id'])

    def change(self, token, rid, member_id, role):
        if role not in ('dm','player','remove'): raise AccountError('成员操作无效')
        with self.accounts.db() as db:
            account = self.identity(db,token)
            self._member(db,account,rid,owner=True)
            target = db.execute('SELECT role FROM room_members WHERE room_id=? AND account_id=?',(rid,member_id)).fetchone()
            if not target: raise AccountError('成员不存在',404)
            if target['role'] == 'owner': raise AccountError('不能移除创建者或修改创建者权限',409)
            if role == 'remove':
                db.execute('DELETE FROM room_members WHERE room_id=? AND account_id=?',(rid,member_id))
                from .account_characters import Characters, central_root
                character_root=central_root(self.accounts)
                if (character_root/'角色.sqlite3').exists():
                    characters=Characters(character_root)
                    # Membership and room participation must roll back together.
                    db.execute('ATTACH DATABASE ? AS people',(characters.database.absolute().as_uri()+'?mode=rw',))
                    characters.detach_into(db,rid,member_id,'people')
                db.execute('INSERT OR IGNORE INTO room_join_blocks VALUES (?,?)',(rid,member_id))
                # An invitation issued before removal must not regrant an old DM
                # role. Only a new owner invitation can undo the join block.
                db.execute('DELETE FROM room_invitations WHERE room_id=? AND email='
                           '(SELECT email FROM accounts WHERE id=?)',(rid,member_id))
            else: db.execute('UPDATE room_members SET role=? WHERE room_id=? AND account_id=?',(role,rid,member_id))

    def select_character(self,token,rid,characters,cid,expected_room):
        # Serialize against membership removal before taking the character lock.
        with self.accounts.db() as db:
            account=self.identity(db,token)
            self._member(db,account,rid)
            return characters.select(account['id'],rid,cid,expected_room)

    def bind_character(self,token,rid,characters,cid,member_id):
        with self.accounts.db() as db:
            account=self.identity(db,token)
            self._member(db,account,rid,owner=True)
            member=db.execute('SELECT a.id,a.name FROM room_members m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=? AND m.account_id=?',(rid,member_id)).fetchone()
            if not member:raise AccountError('请选择已加入房间的成员',404)
            return characters.bind(rid,cid,member['id'],member['name'],account['id'])

    @staticmethod
    def public_profile(profile):
        return {key:profile[key] for key in ('playerId','name','enabled','accountId') if key in profile}

    def profiles(self, token, rid, profiles):
        with self.accounts.db() as db:
            account=self.identity(db,token)
            self._member(db,account,rid,owner=True)
            return [self.public_profile(profile) for profile in profiles.players()]

    def bind_player(self, token, rid, member_id, player_id, profiles):
        # The worker holds the profile/save locks. This database transaction also
        # prevents concurrent membership removal during an explicit owner binding.
        with self.accounts.db() as db:
            account=self.identity(db,token)
            self._member(db,account,rid,owner=True)
            member=db.execute('SELECT a.id FROM accounts a JOIN room_members m ON m.account_id=a.id '
                'WHERE m.room_id=? AND a.id=? AND a.enabled=1 AND a.verified=1',(rid,member_id)).fetchone()
            if not member: raise AccountError('请选择此战役空间中的已验证成员',404)
            profile=profiles.read(player_id)
            if not profile.get('enabled'): raise AccountError('此玩家档案已停用',403)
            if profile.get('accountId') not in (None,'',member_id):
                raise AccountError('此玩家档案已绑定其他邮箱账号，不能覆盖',409)
            if any(p.get('accountId')==member_id and p['playerId']!=player_id for p in profiles.players()):
                raise AccountError('此成员已有玩家档案，不能覆盖绑定',409)
            if profile.get('accountId')==member_id: return self.public_profile(profile)
            from .player_profiles import atomic
            # Keep immutable player/character identities and all collection data.
            atomic(profiles.path(player_id,'自动备份/邮箱绑定前-'+str(time.time_ns())+'.json'),profile)
            profile=dict(profile,accountId=member_id,revision=profile.get('revision',1)+1)
            atomic(profiles.path(player_id,'当前档案.json'),profile)
            return self.public_profile(profile)

    def onboarding(self, token, rid, profiles):
        access = self.access(rid,token=token)
        matches = [p for p in profiles.players() if p.get('accountId') == access['accountId']]
        if len(matches)>1: raise AccountError('战役中的玩家身份重复，请联系管理员',503)
        if not matches: return dict(state='unbound',profile=None)
        profile = matches[0]
        return dict(state='ready' if profile.get('enabled') else 'disabled',profile=self.public_profile(profile))

    def player(self, token, rid, profiles, create=False):
        access = self.access(rid,token=token)
        matches = [p for p in profiles.players() if p.get('accountId') == access['accountId']]
        if len(matches)>1: raise AccountError('战役中的玩家身份重复，请联系管理员',503)
        if matches: profile = matches[0]
        else:
            if create is not True:
                raise AccountError('请从个人主页选择角色加入房间，或等待房主确认旧角色归属',409)
            from .authentication import name_key
            name = access['accountName']
            existing = {name_key(p['name']) for p in profiles.players()}
            if name_key(name) in existing: name = name[:14]+'-'+access['accountId'][-8:]
            profile = profiles.create(name,account_id=access['accountId'])['profile']
        if not profile.get('enabled'): raise AccountError('此战役中的玩家已停用',403)
        if profile.get('characterMode'):
            return dict(profile, _authVersion='account-characters-v1', characterId=profiles.preferred_character(profile['playerId']))
        import json
        record = json.loads((profiles.auth_root/(profile['playerId']+'.json')).read_text('utf-8'))
        return dict(profile,_authVersion=record.get('version') or record['digest'])
