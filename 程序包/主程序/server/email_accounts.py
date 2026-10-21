"""Verified email identities, independent of campaign and host permissions."""
import contextlib
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import threading
import time
import unicodedata
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlsplit
from .mail_credentials import MailCredentialError, read_smtp_secret

ITERATIONS = 600_000
SESSION_SECONDS = 7 * 24 * 3600
HASH_SLOTS = threading.BoundedSemaphore(4)
CODE_SECONDS = 600
CODE_RESEND_SECONDS = 60
CODE_MAX_ATTEMPTS = 5
CODE_HANDLE_SECONDS = 3600


class AccountError(ValueError):
    def __init__(self, message, status=400, *, code=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


def email_key(value):
    if not isinstance(value, str): raise AccountError('请填写邮箱地址')
    value = value.strip()
    if len(value) > 254 or not value.isascii() or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}", value):
        raise AccountError('请填写有效的邮箱地址')
    local, domain = value.rsplit('@', 1)
    if len(local) > 64 or local.startswith('.') or local.endswith('.') or '..' in local:
        raise AccountError('请填写有效的邮箱地址')
    if any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in domain.split('.')):
        raise AccountError('请填写有效的邮箱地址')
    # This application explicitly treats email addresses as case-insensitive.
    # Never remove dots or plus-tags, which are provider-specific semantics.
    return value.lower()


def display_name(value):
    if not isinstance(value, str): raise AccountError('请填写昵称')
    value = unicodedata.normalize('NFKC', value).strip()
    if not 1 <= len(value) <= 24 or any(unicodedata.category(c).startswith('C') for c in value):
        raise AccountError('昵称需为 1–24 个有效字符')
    return value


def password_digest(password, salt=None, *, validate=True):
    if not isinstance(password, str) or not 1 <= len(password) <= 256:
        raise AccountError('密码需为 2–256 个字符')
    if validate and len(password) < 2: raise AccountError('密码需为 2–256 个字符，可以使用一句容易记住的话')
    if not HASH_SLOTS.acquire(blocking=False): raise AccountError('登录服务繁忙，请稍后重试', 503)
    try:
        salt = salt or secrets.token_hex(32)
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), ITERATIONS)
        return salt, digest.hex()
    finally:
        HASH_SLOTS.release()


def token_hash(token):
    return hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()


def read_settings(auth_root):
    path = Path(auth_root) / '邮箱账号设置.json'
    if not path.exists(): return {'enabled': False}
    try:
        value = json.loads(path.read_text('utf-8'))
        if not isinstance(value, dict) or type(value.get('enabled')) is not bool: raise ValueError()
        if 'roomsEnabled' in value and type(value['roomsEnabled']) is not bool: raise ValueError()
        if value['enabled']:
            url = urlsplit(str(value.get('publicOrigin') or ''))
            if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
                raise ValueError()
        return value
    except (OSError, ValueError, TypeError):
        # A broken enabled configuration must never fall back to name-only login.
        raise RuntimeError('邮箱账号设置无效，请检查认证目录中的配置') from None


class SMTPMailer:
    def __init__(self, settings):
        self.settings = settings.get('smtp') or {}
        self.origin = str(settings.get('publicOrigin') or '').rstrip('/')

    @staticmethod
    def _secret():
        try:
            return read_smtp_secret()
        except MailCredentialError:
            raise AccountError('邮件密钥配置不可用，请联系管理员', 503) from None

    @property
    def ready(self):
        config = self.settings
        return bool(self.origin and config.get('host') and config.get('username') and config.get('from')
                    and config.get('security') in ('ssl', 'starttls')
                    and self._secret())

    def send(self, recipient, purpose, token):
        if not self.ready: raise AccountError('邮箱服务尚未配置，请稍后再试', 503)
        secret = self._secret()
        if not secret: raise AccountError('邮箱服务尚未配置，请稍后再试', 503)
        config = self.settings
        sender = email_key(config['from'])
        code_delivery = purpose in ('verify-code', 'reset-code')
        action = 'verify' if purpose in ('verify', 'verify-code') else 'reset'
        label = '验证邮箱' if action == 'verify' else '重设密码'
        message = EmailMessage()
        message['From'] = sender
        message['To'] = recipient
        message['Subject'] = '桑哆尔之歌 · ' + label
        if code_delivery:
            if not isinstance(token, str) or not re.fullmatch(r'[0-9]{6}', token):
                raise AccountError('验证码邮件格式无效', 503)
            message.set_content(f'你的{label}验证码：\n\n{token}\n\n请回到发起操作的原网页填写。验证码在 10 分钟后失效，且只能使用一次。\n请勿把验证码交给其他人。如果不是你发起的操作，请忽略这封邮件。\n')
        else:
            link = self.origin + '/account#' + action + '=' + token
            minutes = 1440 if purpose == 'verify' else 30
            message.set_content(f'请打开以下链接{label}：\n\n{link}\n\n链接将在 {minutes} 分钟后失效，且只能使用一次。\n如果不是你发起的操作，请忽略这封邮件。\n')
        try:
            context = ssl.create_default_context()
            if config['security'] == 'ssl':
                smtp = smtplib.SMTP_SSL(config['host'], int(config.get('port', 465)), timeout=12, context=context)
            else:
                smtp = smtplib.SMTP(config['host'], int(config.get('port', 587)), timeout=12)
            with smtp:
                if config['security'] == 'starttls': smtp.starttls(context=context)
                smtp.login(config['username'], secret)
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException, ValueError):
            raise AccountError('邮件暂时无法发送，请稍后重试', 503) from None


class AccountStore:
    def __init__(self, auth_root, settings, *, mailer=None, clock=time.time, epoch=None):
        self.root = Path(auth_root)
        self.settings = settings
        self.mailer = mailer if mailer is not None else SMTPMailer(settings)
        self.clock = clock
        self.epoch = epoch
        self.path = self.root / '邮箱账号.sqlite3'
        self._initialized = False
        self._init_lock = threading.Lock()

    @property
    def enabled(self): return self.settings.get('enabled') is True

    def initialize(self):
        if self._initialized:
            if not self.path.is_file() or self.path.is_symlink():
                raise AccountError('账号数据库缺失或路径无效，请恢复一致备份', 503)
            return
        with self._init_lock:
            if self._initialized: return
            self.root.mkdir(parents=True, exist_ok=True)
            if self.path.is_symlink(): raise AccountError('账号数据库路径无效', 503)
            marker = self.root / '邮箱账号格式.json'
            if marker.exists() and not self.path.is_file():
                raise AccountError('账号数据库缺失，未创建空库；请恢复一致备份', 503)
            if not marker.exists(): self.path.touch(mode=0o600, exist_ok=True)
            os.chmod(self.path, 0o600)
            with contextlib.closing(sqlite3.connect(self.path.absolute().as_uri() + '?mode=rw', uri=True, timeout=10)) as db:
                required = {'accounts', 'challenges', 'sessions', 'invitations', 'attempts', 'metadata'}
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if (marker.exists() or tables) and not required <= tables:
                    raise AccountError('账号数据库结构不完整，未创建空表；请恢复一致备份', 503)
                db.executescript('''
                    CREATE TABLE IF NOT EXISTS accounts (
                        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                        salt TEXT NOT NULL, digest TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
                        enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
                        player_id TEXT UNIQUE, created REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS challenges (
                        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, purpose TEXT NOT NULL,
                        expires REAL NOT NULL, created REAL NOT NULL);
                    CREATE INDEX IF NOT EXISTS challenge_account ON challenges(account_id, purpose);
                    CREATE TABLE IF NOT EXISTS code_challenges (
                        hash TEXT PRIMARY KEY, account_id TEXT, purpose TEXT NOT NULL,
                        code_hash TEXT NOT NULL, email_hash TEXT NOT NULL, version INTEGER NOT NULL,
                        expires REAL NOT NULL, created REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                        active INTEGER NOT NULL DEFAULT 1);
                    CREATE INDEX IF NOT EXISTS code_challenge_email ON code_challenges(email_hash, purpose);
                    CREATE TABLE IF NOT EXISTS sessions (
                        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, version INTEGER NOT NULL,
                        expires REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS invitations (
                        hash TEXT PRIMARY KEY, email TEXT NOT NULL, player_id TEXT NOT NULL UNIQUE,
                        expires REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at REAL NOT NULL);
                    CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, at);
                    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                ''')
                db.execute('BEGIN IMMEDIATE')
                if 'active' not in {row[1] for row in db.execute('PRAGMA table_info(code_challenges)')}:
                    db.execute('ALTER TABLE code_challenges ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
                db.commit()
            os.chmod(self.path, 0o600)
            if not marker.exists():
                from .workspace import atomic_json
                atomic_json(marker, {'format': 'email-accounts-v1'})
            self._initialized = True

    @contextlib.contextmanager
    def db(self):
        self.initialize()
        # Initialization owns creation. Ordinary requests must never replace a
        # missing database with an empty SQLite file, including a rename race.
        db = sqlite3.connect(self.path.absolute().as_uri() + '?mode=rw', uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE')
            if self.epoch is not None:
                current = str(self.epoch())
                previous = db.execute("SELECT value FROM metadata WHERE key='workspace-epoch'").fetchone()
                if previous is None or previous['value'] != current:
                    for table in ('sessions', 'challenges', 'code_challenges', 'invitations'):
                        db.execute('DELETE FROM ' + table)
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_invitations'").fetchone():
                        db.execute('DELETE FROM room_invitations')
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_share_links'").fetchone():
                        db.execute('DELETE FROM room_share_links')
                    db.execute("INSERT OR REPLACE INTO metadata VALUES ('workspace-epoch', ?)", (current,))
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally: db.close()

    def rate(self, scope, key, limit, seconds):
        now, key = self.clock(), token_hash(scope + ':' + key)
        with self.db() as db:
            db.execute('DELETE FROM attempts WHERE at < ?', (now - 86400,))
            count, oldest = db.execute('SELECT count(*),min(at) FROM attempts WHERE key=? AND at>?', (key, now-seconds)).fetchone()
            if count >= limit:
                raise AccountError('操作过于频繁，请稍后重试', 429,
                                   retry_after=max(1, math.ceil(oldest + seconds - now)))
            db.execute('INSERT INTO attempts VALUES (?, ?)', (key, now))

    @staticmethod
    def public(row):
        return {'accountId': row['id'], 'email': row['email'], 'name': row['name'],
                'emailVerified': bool(row['verified']), 'playerId': row['player_id'] or ''}

    def _challenge(self, db, aid, purpose):
        token, now = secrets.token_urlsafe(32), self.clock()
        db.execute('DELETE FROM code_challenges WHERE account_id=? AND purpose=?', (aid, purpose))
        db.execute('DELETE FROM challenges WHERE expires<=? OR (account_id=? AND purpose=?)', (now, aid, purpose))
        db.execute('INSERT INTO challenges VALUES (?,?,?,?,?)',
                   (token_hash(token), aid, purpose, now+(86400 if purpose=='verify' else 1800), now))
        return token

    @staticmethod
    def _code_hash(challenge, code):
        # The high-entropy browser handle is not stored, preventing offline
        # guessing of six-digit codes from a database-only disclosure.
        return hashlib.sha256((challenge + '\0' + code).encode('utf-8')).hexdigest()

    @staticmethod
    def _code_reply(challenge, purpose):
        message = ('若此邮箱可以注册，验证码将发送到你的邮箱，请在本页填写。已有账号可直接登录或找回密码。'
                   if purpose == 'verify' else '若此邮箱已有可用账号，验证码将发送到你的邮箱，请在本页填写。')
        return dict(challenge=challenge, purpose=purpose, expiresIn=CODE_SECONDS,
                    resendAfter=CODE_RESEND_SECONDS, message=message)

    def _code_cooldown(self, db, email_hash, purpose):
        row = db.execute('SELECT max(created) FROM code_challenges WHERE email_hash=? AND purpose=?',
                         (email_hash, purpose)).fetchone()
        remaining = CODE_RESEND_SECONDS - (self.clock() - row[0]) if row[0] is not None else 0
        if remaining > 0:
            raise AccountError('请稍后再发送验证码', 429, code='code_cooldown',
                               retry_after=math.ceil(remaining))

    def _issue_code(self, db, email_hash, purpose, account=None, *, previous=None, deferred=False):
        challenge, number, now = secrets.token_urlsafe(32), secrets.randbelow(1_000_000), self.clock()
        code = f'{number:06d}'
        if previous and hmac.compare_digest(self._code_hash(previous[0], code), previous[1]):
            code = f'{(number + 1) % 1_000_000:06d}'
        db.execute('DELETE FROM code_challenges WHERE created<=?', (now - CODE_HANDLE_SECONDS,))
        if not deferred:
            db.execute('DELETE FROM code_challenges WHERE email_hash=? AND purpose=?', (email_hash, purpose))
        aid, version = (account['id'], account['version']) if account else (None, 0)
        if aid:
            db.execute('DELETE FROM challenges WHERE account_id=? AND purpose=?', (aid, purpose))
        db.execute('INSERT INTO code_challenges (hash,account_id,purpose,code_hash,email_hash,version,expires,created,attempts,active) VALUES (?,?,?,?,?,?,?,?,0,?)',
                   (token_hash(challenge), aid, purpose, self._code_hash(challenge, code),
                    email_hash, version, now + CODE_SECONDS, now, int(not deferred)))
        return challenge, code

    def _send_code(self, email, purpose, challenge, code):
        try:
            if email: self.mailer.send(email, purpose + '-code', code)
        except Exception:
            with self.db() as db:
                db.execute('DELETE FROM code_challenges WHERE hash=?', (token_hash(challenge),))
            raise AccountError('邮件暂时无法发送，请稍后重试', 503) from None
        return self._code_reply(challenge, purpose)

    def register_code(self, email, name, password):
        email, name = email_key(email), display_name(name)
        if not self.mailer.ready: raise AccountError('邮箱服务尚未配置，暂不能注册', 503)
        identity = token_hash(email)
        self.rate('code-send-verify', identity, 3, 3600)
        salt, digest = password_digest(password)
        with self.db() as db:
            self._code_cooldown(db, identity, 'verify')
            row = db.execute('SELECT * FROM accounts WHERE email=?', (email,)).fetchone()
            if row is None:
                aid = 'a' + secrets.token_hex(16)
                db.execute('INSERT INTO accounts(id,email,name,salt,digest,created) VALUES (?,?,?,?,?,?)',
                           (aid, email, name, salt, digest, self.clock()))
                row = db.execute('SELECT * FROM accounts WHERE id=?', (aid,)).fetchone()
            elif not row['verified'] and row['enabled']:
                db.execute('UPDATE accounts SET name=?,salt=?,digest=?,version=version+1 WHERE id=?',
                           (name, salt, digest, row['id']))
                row = db.execute('SELECT * FROM accounts WHERE id=?', (row['id'],)).fetchone()
            account = row if not row['verified'] and row['enabled'] else None
            challenge, code = self._issue_code(db, identity, 'verify', account)
        return self._send_code(email if account else None, 'verify', challenge, code)

    def forgot_code(self, email):
        email = email_key(email)
        if not self.mailer.ready: raise AccountError('邮箱服务尚未配置，暂不能找回密码', 503)
        identity = token_hash(email)
        self.rate('code-send-reset', identity, 3, 3600)
        with self.db() as db:
            self._code_cooldown(db, identity, 'reset')
            row = db.execute('SELECT * FROM accounts WHERE email=? AND verified=1 AND enabled=1', (email,)).fetchone()
            challenge, code = self._issue_code(db, identity, 'reset', row)
        return self._send_code(email if row else None, 'reset', challenge, code)

    def _code_row(self, db, challenge, purpose=None, *, allow_expired=False):
        if not isinstance(challenge, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', challenge):
            raise AccountError('验证码无效或已过期，请重新发送', code='code_invalid')
        row = db.execute('SELECT * FROM code_challenges WHERE hash=?', (token_hash(challenge),)).fetchone()
        if not row or not row['active'] or (purpose is not None and row['purpose'] != purpose):
            raise AccountError('验证码无效或已过期，请重新发送', code='code_invalid')
        if row['created'] + CODE_HANDLE_SECONDS <= self.clock():
            raise AccountError('验证操作已过期，请重新发起', code='code_expired')
        if row['expires'] <= self.clock() and not allow_expired:
            raise AccountError('验证码已过期，请重新发送', code='code_expired')
        return row

    def resend_code(self, challenge):
        if not self.mailer.ready: raise AccountError('邮箱服务尚未配置，请稍后再试', 503)
        with self.db() as db:
            previous = self._code_row(db, challenge, allow_expired=True)
            self._code_cooldown(db, previous['email_hash'], previous['purpose'])
        self.rate('code-send-' + previous['purpose'], previous['email_hash'], 3, 3600)
        with self.db() as db:
            previous = self._code_row(db, challenge, allow_expired=True)
            self._code_cooldown(db, previous['email_hash'], previous['purpose'])
            row = db.execute('SELECT * FROM accounts WHERE id=?', (previous['account_id'],)).fetchone()
            eligible = row and row['enabled'] and row['version'] == previous['version']
            eligible = eligible and bool(row['verified']) == (previous['purpose'] == 'reset')
            account = row if eligible else None
            current, code = self._issue_code(db, previous['email_hash'], previous['purpose'], account,
                                             previous=(challenge, previous['code_hash']), deferred=True)
        # Keep the original row, budget and expiry until delivery succeeds. The
        # pending row is a persistent nonce; consumed/deleted challenges cannot
        # be resurrected by a late delivery callback or an empty-table check.
        result = self._send_code(row['email'] if account else None, previous['purpose'], current, code)
        error = None
        with self.db() as db:
            original = db.execute('SELECT * FROM code_challenges WHERE hash=? AND active=1',
                                  (token_hash(challenge),)).fetchone()
            replacement = db.execute('SELECT rowid,* FROM code_challenges WHERE hash=? AND active=0',
                                     (token_hash(current),)).fetchone()
            latest = db.execute('SELECT max(rowid) FROM code_challenges WHERE email_hash=? AND purpose=?',
                                (previous['email_hash'], previous['purpose'])).fetchone()[0]
            valid = original and replacement and replacement['rowid'] == latest
            valid = valid and original['created'] + CODE_HANDLE_SECONDS > self.clock()
            valid = valid and replacement['expires'] > self.clock()
            if valid and replacement['account_id']:
                account = db.execute('SELECT * FROM accounts WHERE id=?', (replacement['account_id'],)).fetchone()
                valid = account and account['enabled'] and account['version'] == replacement['version']
                valid = valid and bool(account['verified']) == (previous['purpose'] == 'reset')
            if valid:
                db.execute('DELETE FROM code_challenges WHERE email_hash=? AND purpose=? AND hash<>?',
                           (previous['email_hash'], previous['purpose'], token_hash(current)))
                db.execute('UPDATE code_challenges SET active=1 WHERE hash=?', (token_hash(current),))
            else:
                db.execute('DELETE FROM code_challenges WHERE hash=? AND active=0', (token_hash(current),))
                error = AccountError('验证操作已变化，请重新发送验证码', 409, code='code_invalid')
        if error: raise error
        return result

    def _code_attempt_rate(self, challenge, purpose):
        with self.db() as db: row = self._code_row(db, challenge, purpose)
        self.rate('code-attempt-email', row['email_hash'], 15, 900)

    def _check_code(self, db, challenge, code, purpose):
        row = self._code_row(db, challenge, purpose)
        if row['attempts'] >= CODE_MAX_ATTEMPTS:
            return None, AccountError('验证码错误次数过多，请重新发送', 429, code='code_attempts',
                                      retry_after=max(1, math.ceil(row['created'] + CODE_RESEND_SECONDS - self.clock())))
        account = db.execute('SELECT * FROM accounts WHERE id=?', (row['account_id'],)).fetchone()
        eligible = account and account['enabled'] and account['version'] == row['version']
        eligible = eligible and bool(account['verified']) == (purpose == 'reset')
        valid = isinstance(code, str) and re.fullmatch(r'[0-9]{6}', code)
        valid = valid and hmac.compare_digest(row['code_hash'], self._code_hash(challenge, code))
        if not valid or not eligible:
            attempts = row['attempts'] + 1
            db.execute('UPDATE code_challenges SET attempts=? WHERE hash=?', (attempts, row['hash']))
            if attempts >= CODE_MAX_ATTEMPTS:
                return None, AccountError('验证码错误次数过多，请重新发送', 429, code='code_attempts',
                                          retry_after=max(1, math.ceil(row['created'] + CODE_RESEND_SECONDS - self.clock())))
            return None, AccountError('验证码不正确，请检查后重试', code='code_invalid')
        return account, None

    def verify_code(self, challenge, code):
        self._code_attempt_rate(challenge, 'verify')
        with self.db() as db:
            account, error = self._check_code(db, challenge, code, 'verify')
            if not error:
                db.execute('UPDATE accounts SET verified=1 WHERE id=?', (account['id'],))
                db.execute('DELETE FROM challenges WHERE account_id=?', (account['id'],))
                db.execute('DELETE FROM code_challenges WHERE account_id=?', (account['id'],))
                token = secrets.token_urlsafe(32)
                db.execute('DELETE FROM sessions WHERE expires<=?', (self.clock(),))
                db.execute('INSERT INTO sessions VALUES (?,?,?,?)',
                           (token_hash(token), account['id'], account['version'], self.clock() + SESSION_SECONDS))
                account = db.execute('SELECT * FROM accounts WHERE id=?', (account['id'],)).fetchone()
        # Failed-attempt updates must commit, even when verification is rejected.
        if error: raise error
        return token, self.public(account)

    def reset_code(self, challenge, code, password):
        self._code_attempt_rate(challenge, 'reset')
        salt, digest = password_digest(password)
        with self.db() as db:
            account, error = self._check_code(db, challenge, code, 'reset')
            if not error:
                db.execute('UPDATE accounts SET salt=?,digest=?,version=version+1 WHERE id=?',
                           (salt, digest, account['id']))
                for table in ('sessions', 'challenges', 'code_challenges'):
                    db.execute('DELETE FROM ' + table + ' WHERE account_id=?', (account['id'],))
        if error: raise error
        return {'message': '密码已更新，其他设备的登录已失效，请重新登录。'}

    def _send(self, email, purpose, token):
        try: self.mailer.send(email, purpose, token)
        except Exception:
            with self.db() as db: db.execute('DELETE FROM challenges WHERE hash=?', (token_hash(token),))
            raise AccountError('邮件暂时无法发送，请稍后重试', 503) from None

    def register(self, email, name, password):
        email, name = email_key(email), display_name(name)
        if not self.mailer.ready: raise AccountError('邮箱服务尚未配置，暂不能注册', 503)
        self.rate('register-email', email, 3, 3600)
        salt, digest = password_digest(password)
        token = None
        with self.db() as db:
            row = db.execute('SELECT * FROM accounts WHERE email=?', (email,)).fetchone()
            if row is None:
                aid = 'a' + secrets.token_hex(16)
                db.execute('INSERT INTO accounts(id,email,name,salt,digest,created) VALUES (?,?,?,?,?,?)',
                           (aid, email, name, salt, digest, self.clock()))
                token = self._challenge(db, aid, 'verify')
            elif not row['verified'] and row['enabled']:
                db.execute('UPDATE accounts SET name=?,salt=?,digest=?,version=version+1 WHERE id=?', (name,salt,digest,row['id']))
                token = self._challenge(db, row['id'], 'verify')
        if token: self._send(email, 'verify', token)
        return {'message': '若此邮箱可以注册，验证邮件将发送到你的邮箱。已有账号请直接登录或找回密码。'}

    def verify(self, token, password):
        with self.db() as db:
            row = db.execute('SELECT a.*,c.expires FROM challenges c JOIN accounts a ON a.id=c.account_id WHERE c.hash=? AND c.purpose=?',
                             (token_hash(token),'verify')).fetchone()
        if row is None or row['expires'] <= self.clock() or not row['enabled']:
            raise AccountError('验证链接已失效，请重新注册以获取验证邮件')
        _, digest = password_digest(password, row['salt'], validate=False)
        if not hmac.compare_digest(digest, row['digest']): raise AccountError('请输入注册时设置的密码', 401)
        with self.db() as db:
            current = db.execute('SELECT * FROM accounts WHERE id=?', (row['id'],)).fetchone()
            challenge = db.execute('SELECT expires FROM challenges WHERE hash=? AND purpose=?', (token_hash(token),'verify')).fetchone()
            if not challenge or challenge['expires'] <= self.clock() or current['version'] != row['version'] or not current['enabled']:
                raise AccountError('验证链接已失效，请重新注册以获取验证邮件')
            db.execute('UPDATE accounts SET verified=1 WHERE id=?', (row['id'],))
            db.execute('DELETE FROM challenges WHERE account_id=?', (row['id'],))
            db.execute('DELETE FROM code_challenges WHERE account_id=?', (row['id'],))
        return {'message': '邮箱验证成功，现在可以登录了。'}

    def login(self, email, password):
        email = email_key(email)
        self.rate('login-email', email, 10, 900)
        with self.db() as db: row = db.execute('SELECT * FROM accounts WHERE email=?', (email,)).fetchone()
        _, digest = password_digest(password, row['salt'] if row else '00'*32, validate=False)
        if row is None or not hmac.compare_digest(digest, row['digest']) or not row['enabled']:
            raise AccountError('邮箱或密码不正确', 401)
        if not row['verified']: raise AccountError('请先完成邮箱验证；邮件失效时可以重新注册以补发', 403)
        token = secrets.token_urlsafe(32)
        with self.db() as db:
            current = db.execute('SELECT * FROM accounts WHERE id=?', (row['id'],)).fetchone()
            if current['version'] != row['version'] or not current['enabled']: raise AccountError('账号状态已变化，请重新登录', 401)
            db.execute('DELETE FROM sessions WHERE expires<=?', (self.clock(),))
            db.execute('INSERT INTO sessions VALUES (?,?,?,?)', (token_hash(token),row['id'],row['version'],self.clock()+SESSION_SECONDS))
        return token, self.public(row)

    def session(self, token=None, *, digest=None):
        if not token and not digest: return None
        with self.db() as db:
            row = db.execute('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires>? AND s.version=a.version AND a.enabled=1 AND a.verified=1',
                             (digest or token_hash(token),self.clock())).fetchone()
            return self.public(row) if row else None

    def logout(self, token):
        with self.db() as db: db.execute('DELETE FROM sessions WHERE hash=?', (token_hash(token),))

    def forgot(self, email):
        email = email_key(email)
        if not self.mailer.ready: raise AccountError('邮箱服务尚未配置，暂不能找回密码', 503)
        self.rate('reset-email', email, 3, 3600)
        token = None
        with self.db() as db:
            row = db.execute('SELECT * FROM accounts WHERE email=? AND verified=1 AND enabled=1', (email,)).fetchone()
            if row: token = self._challenge(db, row['id'], 'reset')
        if token: self._send(email, 'reset', token)
        return {'message': '如果此邮箱已有可用账号，你会收到重设密码的邮件。'}

    def reset(self, token, password):
        salt, digest = password_digest(password)
        with self.db() as db:
            row = db.execute('SELECT a.id FROM challenges c JOIN accounts a ON a.id=c.account_id WHERE c.hash=? AND c.purpose=? AND c.expires>? AND a.verified=1 AND a.enabled=1',
                             (token_hash(token),'reset',self.clock())).fetchone()
            if not row: raise AccountError('重设链接已失效，请重新申请')
            db.execute('UPDATE accounts SET salt=?,digest=?,version=version+1 WHERE id=?', (salt,digest,row['id']))
            db.execute('DELETE FROM sessions WHERE account_id=?', (row['id'],))
            db.execute('DELETE FROM challenges WHERE account_id=?', (row['id'],))
            db.execute('DELETE FROM code_challenges WHERE account_id=?', (row['id'],))
        return {'message': '密码已更新，其他设备的登录已失效，请重新登录。'}

    def invite(self, email, player_id, profiles):
        email = email_key(email)
        profile = profiles.read(player_id)
        if not profile.get('enabled'): raise AccountError('此玩家已停用')
        token = secrets.token_urlsafe(32)
        with self.db() as db:
            if db.execute('SELECT 1 FROM accounts WHERE player_id=?', (player_id,)).fetchone():
                raise AccountError('此档案已绑定邮箱账号', 409)
            db.execute('DELETE FROM invitations WHERE player_id=? OR expires<=?', (player_id,self.clock()))
            db.execute('INSERT INTO invitations VALUES (?,?,?,?)', (token_hash(token),email,player_id,self.clock()+86400))
        return token

    def bind(self, token, invitation, profiles):
        account = self.session(token)
        if not account: raise AccountError('请先登录', 401)
        with self.db() as db:
            row = db.execute('SELECT * FROM invitations WHERE hash=? AND email=? AND expires>?',
                             (token_hash(invitation),account['email'],self.clock())).fetchone()
            if not row: raise AccountError('档案绑定链接无效、已过期，或与当前邮箱不匹配')
            profile = profiles.read(row['player_id'])
            if not profile.get('enabled'): raise AccountError('此玩家已停用', 403)
            # Never let an invitation discard a previously linked collection.
            current = db.execute('SELECT player_id FROM accounts WHERE id=?', (account['accountId'],)).fetchone()
            if current['player_id']: raise AccountError('账号已有玩家档案，不能覆盖绑定', 409)
            try: db.execute('UPDATE accounts SET player_id=? WHERE id=?', (row['player_id'],account['accountId']))
            except sqlite3.IntegrityError: raise AccountError('此玩家档案已被绑定', 409) from None
            db.execute('DELETE FROM invitations WHERE hash=?', (token_hash(invitation),))
        return {'message': '已有玩家档案已绑定，角色和背包已保留。'}

    def player(self, token, profiles, *, create=False, name=None):
        account = self.session(token)
        if not account: raise AccountError('请先登录邮箱账号', 401)
        if not account['playerId']:
            if not create: raise AccountError('请先在账号页面建立或绑定玩家档案', 409)
            with self.db() as db:
                row = db.execute('SELECT * FROM accounts WHERE id=?', (account['accountId'],)).fetchone()
                pid = row['player_id']
                if not pid:
                    # The profile carries its account ID so an interrupted cross-file
                    # operation can recover without creating a second player.
                    matches = [p for p in profiles.players() if p.get('accountId') == row['id']]
                    if len(matches) > 1: raise AccountError('账号档案重复，请管理员核对', 503)
                    if matches: pid = matches[0]['playerId']
                    else:
                        profile = profiles.create(display_name(name or row['name']), account_id=row['id'])['profile']
                        pid = profile['playerId']
                    db.execute('UPDATE accounts SET player_id=? WHERE id=?', (pid,row['id']))
                account['playerId'] = pid
        profile = profiles.read(account['playerId'])
        if not profile.get('enabled'): raise AccountError('此玩家已停用', 403)
        record = json.loads((profiles.auth_root / (profile['playerId']+'.json')).read_text('utf-8'))
        return dict(profile, _authVersion=record.get('version') or record['digest'])
