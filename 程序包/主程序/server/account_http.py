"""Same-origin account endpoints. Expensive hashing/email never hold game locks."""
import ipaddress
import json
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from urllib.parse import urlsplit
from .email_accounts import AccountError, SESSION_SECONDS, token_hash


def origin(handler, app):
    host = handler.headers.get('Host', '')
    try:
        url = urlsplit('//' + host)
        local = ipaddress.ip_address(handler.client_address[0]).is_loopback
        if local and url.hostname in ('localhost', '127.0.0.1', '::1'):
            return 'http://' + host, False
        if local and app.WEB_ENTRANCES.role(handler) in ('main', 'player', 'dm') and handler.headers.get('X-Forwarded-Proto') == 'https':
            return 'https://' + host, True
    except ValueError: pass
    raise AccountError('请从网站的安全入口访问账号', 403)


def cookie_name(secure): return '__Host-sundoll-account' if secure else 'sundoll-local-account'


def read_cookie(handler, secure):
    try:
        jar = SimpleCookie(handler.headers.get('Cookie', ''))
        item = jar.get(cookie_name(secure))
        return item.value if item else ''
    except Exception: return ''


def respond(handler, data, status=200, *, token=None, secure=False):
    body = json.dumps(data, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store, private')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Referrer-Policy', 'no-referrer')
    if data.get('retryAfter') is not None:
        handler.send_header('Retry-After', str(data['retryAfter']))
    if token is not None:
        value = cookie_name(secure) + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + str(SESSION_SECONDS if token else 0)
        if secure: value += '; Secure'
        handler.send_header('Set-Cookie', value)
    if data.get('session', {}).get('sessionToken'):
        value = 'sundoll-media-session=' + data['session']['sessionToken'] + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400'
        if secure: value += '; Secure'
        handler.send_header('Set-Cookie', value)
    handler.end_headers()
    if handler.command != 'HEAD': handler.wfile.write(body)


def handle(handler, app):
    path = urlsplit(handler.path).path
    if path == '/account' and handler.command in ('GET', 'HEAD'):
        if app.WEB_ENTRANCES.role(handler) in ('main', 'dm') and app.WEB_ENTRANCES.url('player'):
            handler._redirect(app.WEB_ENTRANCES.url('player') + '/account')
        else: handler._entrance_page('account.html')
        return True
    if not path.startswith('/api/account/'): return False
    secure = False
    try:
        expected, secure = origin(handler, app)
        service = app.account_store()
        if handler.command in ('GET', 'HEAD') and path == '/api/account/config':
            # Sending credentials can be unavailable without invalidating already
            # verified identities. Keep login/session access independent of SMTP.
            try: email_ready = bool(service.mailer.ready)
            except AccountError: email_ready = False
            respond(handler, {'ok': True, 'enabled': service.enabled, 'emailReady': email_ready,
                             'roomsEnabled':service.settings.get('roomsEnabled') is True}, secure=secure)
            return True
        if not service.enabled: raise AccountError('邮箱账号功能尚未开放', 503)
        token = read_cookie(handler, secure)
        expected_account = handler.headers.get('X-Sundoll-Expected-Account', '')
        private_action = path in ('/api/account/session', '/api/account/logout', '/api/account/rooms', '/api/account/player-session',
                                 '/api/account/create-player', '/api/account/bind', '/api/account/characters', '/api/account/character-create') or path.startswith('/api/account/room-')
        if expected_account and private_action:
            current_account = service.session(token)
            if not current_account: raise AccountError('请先登录', 401)
            if expected_account != current_account['accountId']:
                raise AccountError('邮箱账号已变化，请重新进入', 409)
        if handler.command in ('GET', 'HEAD'):
            if path == '/api/account/characters' and service.settings.get('roomsEnabled') is True:
                from .account_characters import registry
                account=service.session(token)
                if not account:raise AccountError('请先登录',401)
                respond(handler,dict(ok=True,characters=registry(app).mine(account['accountId'])),secure=secure)
                return True
            if path == '/api/account/rooms' and service.settings.get('roomsEnabled') is True:
                from .room_gateway import rooms
                respond(handler,dict(ok=True,rooms=rooms(app).list(token)),secure=secure)
                return True
            if path != '/api/account/session': raise AccountError('页面不存在', 404)
            account = service.session(token)
            if not account: raise AccountError('请先登录', 401)
            respond(handler, {'ok': True, 'account': account}, secure=secure)
            return True
        if handler.command != 'POST': raise AccountError('请求方式无效', 405)
        if getattr(handler.server, 'restore_pending', False) is True:
            raise AccountError('正在恢复工作区，请等待服务恢复后重试', 409)
        if handler.headers.get('Origin') != expected or handler.headers.get('X-Sundoll-Account') != '1':
            raise AccountError('请从账号页面提交操作', 403)
        if handler.headers.get('Content-Type', '').split(';',1)[0].strip().lower() != 'application/json':
            raise AccountError('请求格式无效', 415)
        length = int(handler.headers.get('Content-Length') or 0)
        if not 0 < length <= 8192 or handler.headers.get('Transfer-Encoding'):
            raise AccountError('请求大小无效', 413)
        data = handler._read_json_body(8192)
        if not isinstance(data, dict): raise AccountError('请求格式无效')
        peer = handler.client_address[0]
        if secure:
            try: peer = str(ipaddress.ip_address(handler.headers.get('CF-Connecting-IP', peer)))
            except ValueError: pass
        action = path.removeprefix('/api/account/')
        if action not in ('register','verify','verify-code','resend-code','login','forgot','reset','reset-code','logout','player-session','create-player','bind',
                          'room-create','room-invite','room-accept','room-members','room-member',
                          'room-profiles','room-bind-player','room-onboarding','room-start-player',
                          'room-share','room-join','room-share-revoke','character-create'):
            raise AccountError('请求不存在', 404)
        service.rate('ip-'+action, peer, 30 if action == 'player-session' else 15, 900)
        changed_cookie = None
        if action.startswith('room-'):
            if service.settings.get('roomsEnabled') is not True: raise AccountError('战役空间尚未开放',503)
            from .room_gateway import rooms
            directory=rooms(app)
            if action=='room-create': result={'room':directory.create(token,data.get('name'),data.get('requestId'))}
            elif action in ('room-profiles','room-bind-player','room-onboarding','room-start-player'):
                from .room_gateway import profile_operation
                operation = {'room-profiles':'list','room-bind-player':'bind',
                             'room-onboarding':'onboarding','room-start-player':'start'}[action]
                result=profile_operation(app,token,data.get('roomId'),
                    operation,
                    {'accountId':data.get('accountId'),'playerId':data.get('playerId'),'characterId':data.get('characterId'),'expectedRoomId':data.get('expectedRoomId')})
            elif action=='room-invite':
                invitation=directory.invite(token,data.get('roomId'),data.get('email'),data.get('role'))
                result={'invitationUrl':expected+'/account#room='+invitation}
            elif action=='room-share':
                share=directory.share(token,data.get('roomId'))
                result={'invitationUrl':expected+'/account#join='+share['token'],'expiresAt':share['expiresAt']}
            elif action=='room-join': result={'room':directory.join(token,data.get('token'))}
            elif action=='room-share-revoke':
                directory.revoke_share(token,data.get('roomId'))
                result={}
            elif action=='room-accept': result={'room':directory.accept(token,data.get('token'))}
            elif action=='room-members': result={'members':directory.members(token,data.get('roomId'))}
            else:
                directory.change(token,data.get('roomId'),data.get('accountId'),data.get('role'))
                result={}
        elif action == 'character-create':
            from .account_characters import registry
            if service.settings.get('roomsEnabled') is not True:raise AccountError('账号角色尚未开放',409)
            account=service.session(token)
            if not account:raise AccountError('请先登录',401)
            result=dict(character=registry(app).create(account['accountId'],account['name'],data.get('name'),data.get('requestId'),data.get('base')))
        elif action == 'register':
            register = service.register_code if data.get('delivery') == 'code' else service.register
            result = register(data.get('email'),data.get('name'),data.get('password'))
        elif action == 'verify': result = service.verify(data.get('token'),data.get('password'))
        elif action == 'verify-code':
            changed_cookie, account = service.verify_code(data.get('challenge'),data.get('code'))
            service.logout(token)
            result = {'account':account}
        elif action == 'resend-code': result = service.resend_code(data.get('challenge'))
        elif action == 'login':
            changed_cookie, account = service.login(data.get('email'),data.get('password'))
            service.logout(token)
            result = {'account': account}
        elif action == 'forgot':
            forgot = service.forgot_code if data.get('delivery') == 'code' else service.forgot
            result = forgot(data.get('email'))
        elif action == 'reset':
            result = service.reset(data.get('token'),data.get('password'))
            changed_cookie = ''
        elif action == 'reset-code':
            result = service.reset_code(data.get('challenge'),data.get('code'),data.get('password'))
            changed_cookie = ''
        elif action == 'logout':
            service.logout(token)
            changed_cookie, result = '', {}
        elif action in ('player-session', 'create-player', 'bind'):
            if service.settings.get('roomsEnabled') is True:
                raise AccountError('请从个人主页选择房间和角色',409)
            # These operations may change profile files, so preserve the workspace
            # recovery boundary. SMTP and password hashing occur outside this lock.
            with app.save_storage.SAVE_WRITE_LOCK, app.profiles.LOCK:
                from .workspace_backup import epoch
                current = epoch(app.LOCAL_SAVE_ROOT)
                if getattr(handler.server, 'restore_pending', False) is True or (current and handler.headers.get('X-Sundoll-Workspace') != current):
                    raise AccountError('工作区已恢复，请刷新页面后重试', 409)
                if action == 'bind': result = service.bind(token,data.get('token'),app.profile_store())
                else:
                    profile = service.player(token,app.profile_store(),create=action=='create-player',name=data.get('name'))
                    if action == 'create-player': result = {'account': service.session(token)}
                    else:
                        if app.AUTH_METHOD != 'email_password': raise AccountError('邮箱登录尚未启用', 503)
                        room_token = secrets.token_urlsafe(32)
                        session = {'token':room_token,'playerId':profile['playerId'],'name':profile['name'],
                                   'persistent':True,'_authVersion':profile['_authVersion'],
                                   '_accountSession':token_hash(token),'status':'online','lastSeen':int(time.time()*1000)}
                        app.SESSIONS[room_token] = session
                        public = app.public_player_session(session)
                        public['sessionToken'] = room_token
                        result = {'session':public,'roomCode':app.ROOM_CODE}
        else: raise AccountError('请求不存在', 404)
        respond(handler, dict(result, ok=True), token=changed_cookie, secure=secure)
    except (AccountError, app.profiles.ProfileError) as error:
        handler.close_connection = True
        result = {'ok':False,'error':str(error)}
        if getattr(error, 'code', None): result['errorCode'] = error.code
        if getattr(error, 'retry_after', None) is not None: result['retryAfter'] = error.retry_after
        respond(handler, result,error.status,secure=secure)
    except (ValueError, TypeError, OverflowError):
        handler.close_connection = True
        respond(handler, {'ok':False,'error':'请求格式无效'},400,secure=secure)
    except (OSError, sqlite3.Error):
        handler.close_connection = True
        respond(handler, {'ok':False,'error':'账号服务暂时不可用，请稍后重试'},503,secure=secure)
    return True
