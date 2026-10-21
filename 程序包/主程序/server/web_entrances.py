"""Public website entrances and a separate, host-bound DM password session."""
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urlparse

COOKIE = '__Host-sundoll-dm'
SESSION_SECONDS = 12 * 60 * 60
PASSWORD_ITERATIONS = 600_000


def password_record(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 256:
        raise ValueError('DM 密码需为 10–256 个字符')
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PASSWORD_ITERATIONS)
    return dict(method='pbkdf2_sha256', iterations=PASSWORD_ITERATIONS,
                salt=salt.hex(), digest=digest.hex())


class WebEntrances:
    def __init__(self, settings, data_root, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.RLock()
        self.sessions = {}
        self.attempts = {}
        self.hosts = {}
        self.verifier = None
        config = settings.get('webEntrances') or {}
        for role in ('main', 'player', 'dm'):
            host = str(config.get(role + 'Hostname') or '').lower()
            if host and re.fullmatch(r'[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?', host):
                self.hosts[role] = host
        auth = settings.get('dmAuthentication') or {}
        relative = Path(str(auth.get('passwordFile') or '认证/dm-password.json'))
        # Authentication material may only be loaded from private runtime storage.
        if relative.is_absolute() or '..' in relative.parts:
            return
        target = Path(data_root) / relative
        try:
            record = json.loads(target.read_text('utf-8'))
            if (record['method'] != 'pbkdf2_sha256'
                    or type(record['iterations']) is not int
                    or not 600_000 <= record['iterations'] <= 2_000_000):
                return
            salt, digest = bytes.fromhex(record['salt']), bytes.fromhex(record['digest'])
            if len(salt) != 32 or len(digest) != 32:
                return
            self.verifier = (salt, digest, record['iterations'])
        except (OSError, ValueError, KeyError, TypeError):
            pass

    @classmethod
    def load(cls, data_root):
        try:
            settings = json.loads((Path(data_root) / '联机设置.json').read_text('utf-8'))
            if not isinstance(settings, dict): settings = {}
        except (OSError, ValueError):
            settings = {}
        return cls(settings, data_root)

    def role(self, handler):
        try:
            address = urlparse('//' + str(handler.headers.get('Host') or ''))
            if address.port not in (None, 443): return ''
            return next((role for role, host in self.hosts.items()
                         if address.hostname == host), '')
        except ValueError:
            return ''

    def url(self, role):
        host = self.hosts.get(role)
        return 'https://' + host if host else ''

    def page_values(self, handler, account_settings):
        """Keep personal campaign access separate from the original host workspace."""
        enabled = account_settings.get('enabled') is True
        rooms = enabled and account_settings.get('roomsEnabled') is True
        local = False
        try:
            address = urlparse('//' + str(handler.headers.get('Host') or ''))
            local = (address.hostname in ('127.0.0.1', 'localhost', '::1')
                     and ipaddress.ip_address(handler.client_address[0]).is_loopback)
        except ValueError:
            pass
        account_base = '' if local else self.url('player')
        return {
            'mainUrl': self.url('main') or '/',
            'playerUrl': self.url('player') or '/主控台/玩家.html',
            'dmUrl': self.url('dm') or '/主控台/主控台.html',
            'accountUrl': account_base + '/account',
            'administratorUrl': ('/主控台/主控台.html' if local
                                 else (self.url('dm') + '/login' if self.url('dm') else '/主控台/主控台.html')),
            'entranceMode': 'account' if enabled else 'legacy',
            'accountTitle': '进入我的战役' if rooms else '进入玩家账号',
            'accountIntro': ('登录邮箱账号，创建自己的战役成为 DM，或接受朋友的邀请加入冒险。'
                             if rooms else '登录邮箱账号，继续使用你的玩家档案。'),
            'accountHint': ('身份、角色和存档随战役保存，下次登录继续。'
                            if rooms else '邮箱注册、登录与玩家档案'),
        }

    def same_origin(self, handler):
        if self.role(handler) != 'dm' or handler.headers.get('X-Forwarded-Proto') != 'https':
            return False
        origin = handler.headers.get('Origin')
        if origin and origin != self.url('dm'):
            return False
        if handler.command not in ('GET', 'HEAD', 'OPTIONS') and not origin:
            return False
        site = handler.headers.get('Sec-Fetch-Site')
        if site and site not in ('same-origin', 'none'):
            # A top-level link from the main website may enter an existing session.
            if not (handler.command in ('GET', 'HEAD')
                    and handler.headers.get('Sec-Fetch-Mode') == 'navigate'):
                return False
        return True

    def token(self, handler):
        try:
            cookies = SimpleCookie(str(handler.headers.get('Cookie') or ''))
            return cookies[COOKIE].value if COOKIE in cookies else ''
        except Exception:
            return ''

    def authorized(self, handler):
        if not self.verifier or not self.same_origin(handler): return False
        token = self.token(handler)
        with self.lock:
            expiry = self.sessions.get(token, 0)
            if expiry <= self.clock():
                self.sessions.pop(token, None)
                return False
            return True

    def login(self, handler, password):
        if not self.same_origin(handler): return 403, '', '请从 DM 登录页面提交'
        if not self.verifier: return 503, '', 'DM 登录尚未配置'
        if not isinstance(password, str) or not 1 <= len(password) <= 256:
            return 400, '', '请填写 DM 密码'
        ip = str(handler.client_address[0])
        # Only a local connector can supply Cloudflare's source-IP header.
        if ip in ('127.0.0.1', '::1'):
            try: ip = str(ipaddress.ip_address(handler.headers.get('CF-Connecting-IP', ip)))
            except ValueError: pass
        with self.lock:
            now = self.clock()
            self.attempts = {key: [t for t in values if now - t < 60]
                             for key, values in self.attempts.items() if values and now - values[-1] < 60}
            bucket = self.attempts.setdefault(ip, [])
            if len(bucket) >= 5 or sum(map(len, self.attempts.values())) >= 30:
                return 429, '', '登录尝试过于频繁，请一分钟后重试'
            bucket.append(now)
        salt, expected, iterations = self.verifier
        actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, iterations)
        if not hmac.compare_digest(actual, expected): return 401, '', 'DM 密码不正确'
        with self.lock:
            now = self.clock()
            self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
            if len(self.sessions) >= 64: return 429, '', 'DM 会话数量已达上限，请稍后重试'
            previous = self.token(handler)
            self.sessions.pop(previous, None)
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + SESSION_SECONDS
        return 200, token, ''

    def logout(self, handler):
        with self.lock:
            self.sessions.pop(self.token(handler), None)

    @staticmethod
    def cookie(token):
        return (COOKIE + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='
                + str(SESSION_SECONDS if token else 0))
