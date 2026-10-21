"""Host-bound account cookies issue narrowly scoped, revocable website tickets."""
import base64
import hashlib
import hmac
import json
import re
import sqlite3
from urllib.parse import urlsplit
from .account_http import origin, read_cookie, cookie_name
from .email_accounts import AccountError, token_hash, SESSION_SECONDS

ISSUER = 'https://pl.sundollworld.com'
AUDIENCE = 'sundollworld-message-board'
TTL = 300
KEY_FILE = '主站留言身份密钥'
HEX = re.compile(r'[0-9a-f]{64}\Z')
BASE = '/api/account/site-session'


def key_for(service):
    path = service.root / KEY_FILE
    try:
        if path.is_symlink(): raise ValueError()
        secret = path.read_text('ascii').strip()
        if not HEX.fullmatch(secret): raise ValueError()
        return secret.encode('ascii')
    except (OSError, ValueError, UnicodeError):
        raise AccountError('主页账号连接暂不可用，请稍后重试', 503) from None


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def unb64(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise AccountError('账号身份已失效，请重新登录', 401)
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def identity(key, account):
    subject = hmac.new(key, ('board-subject-v1:' + account['accountId']).encode(), hashlib.sha256).hexdigest()
    public = 'board_' + hmac.new(key, ('board-public-v1:' + account['accountId']).encode(), hashlib.sha256).hexdigest()[:32]
    return dict(sub=subject, publicId=public, nickname=account['name'])


def issue(service, token):
    account = service.session(token)
    if not account: raise AccountError('请先登录', 401)
    key = key_for(service)
    now = int(service.clock())
    claims = dict(identity(key, account), v=1, iss=ISSUER, aud=AUDIENCE,
                  sid=token_hash(token), iat=now, exp=now + TTL)
    header = b64(b'{"alg":"HS256","typ":"JWT"}')
    payload = b64(json.dumps(claims, ensure_ascii=False, separators=(',', ':')).encode())
    unsigned = header + '.' + payload
    ticket = unsigned + '.' + b64(hmac.new(key, unsigned.encode('ascii'), hashlib.sha256).digest())
    return dict(ok=True, identity=dict(id=claims['publicId'], name=claims['nickname']),
                ticket=ticket, expiresAt=claims['exp'])


def validate(service, ticket):
    if not isinstance(ticket, str) or len(ticket) > 4096:
        raise AccountError('账号身份已失效，请重新登录', 401)
    key = key_for(service)
    try:
        head, body, signature = ticket.split('.')
        supplied = unb64(signature)
        actual = hmac.new(key, (head + '.' + body).encode('ascii'), hashlib.sha256).digest()
        if not hmac.compare_digest(actual, supplied): raise ValueError()
        if json.loads(unb64(head)) != {'alg': 'HS256', 'typ': 'JWT'}: raise ValueError()
        claims = json.loads(unb64(body))
        now = int(service.clock())
        if (type(claims.get('v')) is not int or claims['v'] != 1 or claims.get('iss') != ISSUER or claims.get('aud') != AUDIENCE
                or type(claims.get('iat')) is not int or type(claims.get('exp')) is not int
                or not claims['iat'] <= now < claims['exp'] or not 0 < claims['exp'] - claims['iat'] <= TTL
                or not HEX.fullmatch(str(claims.get('sid')))):
            raise ValueError()
        account = service.session(digest=claims['sid'])
        if not account: raise ValueError()
        expected = identity(key, account)
        if any(claims.get(field) != value for field, value in expected.items()): raise ValueError()
        return claims
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise AccountError('账号身份已失效，请重新登录', 401) from None


def allowed_origin(value, app, handler):
    if value in {app.WEB_ENTRANCES.url('main'), 'https://sundollworld.pages.dev'} - {''}:
        return True
    try:
        # Local previews are explicitly local, and never allowed by the public host.
        expected, secure = origin(handler, app)
        parsed = urlsplit(value or '')
        return (not secure and parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')
                and not parsed.username and not parsed.password and parsed.path in ('', '/')
                and parsed.geturl().rstrip('/') == parsed.scheme + '://' + parsed.netloc)
    except (ValueError, AccountError):
        return False


def respond(handler, data, status, request_origin, app, *, clear=False, secure=False):
    body = b'' if status == 204 else json.dumps(data, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    if status != 204: handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('Vary', 'Origin')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if request_origin and allowed_origin(request_origin, app, handler):
        handler.send_header('Access-Control-Allow-Origin', request_origin)
        handler.send_header('Access-Control-Allow-Credentials', 'true')
        handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        handler.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Sundoll-Account')
    if clear:
        cookie = cookie_name(secure) + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        if secure: cookie += '; Secure'
        handler.send_header('Set-Cookie', cookie)
    handler.end_headers()
    if handler.command != 'HEAD': handler.wfile.write(body)


def handle(handler, app):
    path = urlsplit(handler.path).path
    if path not in (BASE, BASE + '/validate', BASE + '/logout'): return False
    request_origin = handler.headers.get('Origin', '')
    secure = False
    try:
        _, secure = origin(handler, app)
        if getattr(app, 'ROOM_RUNTIME', False): raise AccountError('页面不存在', 404)
        if request_origin and not allowed_origin(request_origin, app, handler):
            raise AccountError('请从主页访问账号', 403)
        service = app.account_store()
        if not service.enabled: raise AccountError('账号功能尚未开放', 503)
        if handler.command == 'OPTIONS':
            if not request_origin: raise AccountError('请求来源无效', 403)
            respond(handler, {}, 204, request_origin, app); return True
        if path == BASE and handler.command in ('GET', 'HEAD'):
            result = issue(service, read_cookie(handler, secure))
            respond(handler, result, 200, request_origin, app); return True
        if handler.command != 'POST': raise AccountError('请求方式无效', 405)
        if path == BASE: raise AccountError('请求方式无效', 405)
        if handler.headers.get('Content-Type', '').split(';')[0].lower() != 'application/json':
            raise AccountError('请求格式无效', 415)
        if handler.headers.get('Transfer-Encoding') or not 0 < int(handler.headers.get('Content-Length', '0')) <= 8192:
            raise AccountError('请求大小无效', 413)
        data = handler._read_json_body(8192)
        if not isinstance(data, dict): raise AccountError('请求格式无效')
        if path.endswith('/validate'):
            validate(service, data.get('ticket'))
            respond(handler, dict(ok=True, active=True), 200, request_origin, app)
        else:
            if not request_origin or handler.headers.get('X-Sundoll-Account') != '1':
                raise AccountError('请从主页退出账号', 403)
            token = read_cookie(handler, secure)
            current = issue(service, token)
            if data.get('identityId') != current['identity']['id']:
                raise AccountError('账号已切换，请刷新后重试', 409)
            service.logout(token)
            respond(handler, dict(ok=True), 200, request_origin, app, clear=True, secure=secure)
    except AccountError as error:
        handler.close_connection = True
        respond(handler, dict(ok=False, error=str(error)), error.status, request_origin, app)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        handler.close_connection = True
        respond(handler, dict(ok=False, error='账号连接暂不可用，请稍后重试'), 503, request_origin, app)
    return True
