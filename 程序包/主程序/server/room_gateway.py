"""Route authenticated room traffic to isolated loopback-only worker processes."""
import atexit
import http.client
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import subprocess
import sys
import threading
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, unquote, quote
from .account_http import origin, read_cookie, respond
from .campaign_rooms import ROOM_ID, RoomStore
from .email_accounts import AccountError

HOP_HEADERS = {'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'}
IDLE_SECONDS = 15*60


def login_destination(path):
    """Resume only a room page after authentication; never resume API mutations."""
    parsed = urlsplit(path)
    parts = unquote(parsed.path).split('/')
    if (len(parts) >= 4 and parts[1] == 'rooms' and ROOM_ID.fullmatch(parts[2])
            and '/'.join(parts[3:]) in ('', '主控台/主控台.html', '主控台/玩家.html')):
        target = '/rooms/' + parts[2] + '/' + '/'.join(parts[3:])
        return '/account#continue=' + quote(target, safe='')
    return '/account#dashboard'


def body_limit(path,role):
    host=role in ('owner','dm')
    host_only={'/api/local-save':128*1024**2,'/api/modules':64*1024,
        '/api/modules/import':128*1024**2,'/api/modules/preview':128*1024**2,
        '/api/assets/cache-map':12*1024**2,'/api/players/kick':64*1024,
        '/api/state':12*1024**2,'/api/host-state/takeover':64*1024,
        '/api/host-action':64*1024,'/api/item-library':512*1024}
    if path in host_only:
        if not host: raise AccountError('此操作需要该战役的 DM 权限',403)
        return host_only[path]
    if path.startswith('/api/music'):
        if not host: raise AccountError('此操作需要该战役的 DM 权限',403)
        return 132000 if path=='/api/music-live' else 80*1024**2
    return {'/api/map-items':512*1024,'/api/reading-share':8192,'/api/backpack':512*1024,
        '/api/player-profiles':24*1024**2,'/api/journal':128*1024,'/api/player-name':4096,
        '/api/session':64*1024,'/api/presence':64*1024,'/api/action':512*1024,
        '/api/webrtc-signal':192*1024,'/api/account/player-session':8192}.get(path,0)


def enabled(app):
    return app.ACCOUNT_SETTINGS.get('enabled') is True and app.ACCOUNT_SETTINGS.get('roomsEnabled') is True


def rooms(app):
    service = app.account_store()
    cached = getattr(service,'_rooms',None)
    if cached is None:
        # Reuse the account initialization mutex only after database initialization.
        service.initialize()
        with service._init_lock:
            if not hasattr(service,'_rooms'): service._rooms = RoomStore(service)
        cached = service._rooms
    return cached


def scope(handler):
    path = urlsplit(handler.path).path
    parts = path.split('/')
    explicit = parts[2] if len(parts)>2 and parts[1]=='rooms' else ''
    if explicit:
        if not ROOM_ID.fullmatch(explicit): raise AccountError('战役地址无效',404)
        if handler.headers.get('X-Sundoll-Room',explicit)!=explicit: raise AccountError('战役地址不一致',400)
        return explicit, handler.path[len('/rooms/'+explicit):] or '/'
    header = handler.headers.get('X-Sundoll-Room','')
    ref = urlsplit(handler.headers.get('Referer',''))
    ref_parts = ref.path.split('/')
    referenced = ref_parts[2] if len(ref_parts)>2 and ref_parts[1]=='rooms' and ref.netloc == handler.headers.get('Host') else ''
    rid = header or referenced
    if header and referenced and header!=referenced: raise AccountError('战役地址不一致',400)
    if rid and not ROOM_ID.fullmatch(rid): raise AccountError('战役地址无效',404)
    # Account management stays at the central origin; player sessions are per room.
    if path == '/account' or (path.startswith('/api/account/') and path != '/api/account/player-session'):
        return '', handler.path
    return rid, handler.path


class Supervisor:
    def __init__(self, app):
        self.app = app
        self.root = app.account_store().root.parent / '战役空间'
        self.workers = {}
        self.lock = threading.Lock()
        self.bundle = None
        self.clock=time.monotonic
        atexit.register(self.close)

    def close(self):
        with self.lock:
            for worker in list(self.workers.values()):
                connection=http.client.HTTPConnection('127.0.0.1',worker['port'],timeout=5)
                try:
                    connection.request('POST','/_internal/hibernate',b'',{'X-Room-Secret':worker['secret'],'X-Room-Control':'hibernate'})
                    response=connection.getresponse();response.read()
                    if response.status!=200: worker['process'].terminate()
                except (OSError,http.client.HTTPException): worker['process'].terminate()
                finally: connection.close()
            for worker in list(self.workers.values()):
                try: worker['process'].wait(timeout=5)
                except subprocess.TimeoutExpired:
                    worker['process'].kill();worker['process'].wait(timeout=5)
                worker['process'].stdout.close()
            self.workers.clear()
            if self.bundle and self.bundle.exists(): shutil.rmtree(self.bundle)
            self.bundle=None

    def prepare_bundle(self):
        if self.bundle: return self.bundle
        from .static_policy import PUBLIC_FILES, HOST_FILES, MEDIA_EXTENSIONS
        source = Path(self.app.ROOT)
        target = self.root / ('前端-'+secrets.token_hex(8))
        self.root.mkdir(parents=True,exist_ok=True)
        target.mkdir()
        files = set(PUBLIC_FILES)|set(HOST_FILES)|{'shared/room-context.js'}
        files.update(str(p.relative_to(source)) for p in (source/'asset/界面').rglob('*') if p.is_file() and p.suffix.lower() in MEDIA_EXTENSIONS)
        for name in files:
            src,dst = source/name,target/name
            if not src.is_file() or src.is_symlink(): continue
            if any(p.is_symlink() for p in src.parents if p!=source.parent): continue
            dst.parent.mkdir(parents=True,exist_ok=True)
            if src.suffix == '.html':
                text = src.read_text('utf-8')
                text = text.replace('<head>','<head><meta name="referrer" content="same-origin"><script src="/shared/room-context.js"></script>',1)
                text = text.replace('class="cover-project-badge">本机','class="cover-project-badge">战役空间')
                text = text.replace('>复制邀请链接</button>','>复制房间链接</button>')
                dst.write_text(text,encoding='utf-8')
            else: shutil.copyfile(src,dst)
        self.bundle = target
        return target

    def get(self, room):
        with self.lock:
            rid = room['id']
            current = self.workers.get(rid)
            if current and current['process'].poll() is None:
                current['active']+=1;current['lastUsed']=self.clock();return current
            for key,value in list(self.workers.items()):
                if value['process'].poll() is not None:
                    value['process'].stdout.close();del self.workers[key]
            for key,value in list(self.workers.items()):
                if value['active'] or self.clock()-value['lastUsed']<IDLE_SECONDS: continue
                # A worker must confirm its runtime checkpoint before termination.
                connection=http.client.HTTPConnection('127.0.0.1',value['port'],timeout=5)
                try:
                    connection.request('POST','/_internal/hibernate',b'',{'X-Room-Secret':value['secret'],'X-Room-Control':'hibernate'})
                    response=connection.getresponse();response.read()
                    if response.status!=200:continue
                    value['process'].wait(timeout=5)
                    value['process'].stdout.close();del self.workers[key]
                except (OSError,http.client.HTTPException,subprocess.TimeoutExpired):pass
                finally:connection.close()
            if sum(value['ownerId']==room['ownerId'] for value in self.workers.values())>=2:
                raise AccountError('每位创建者最多同时运行 2 个战役空间；关闭不用的页面后，空闲空间将在 15 分钟后按需休眠',429)
            if len(self.workers)>=8: raise AccountError('当前同时运行的战役较多，请稍后再试',503)
            bundle = self.prepare_bundle()
            secret = secrets.token_urlsafe(32)
            config = dict(room=rid,name=room['name'],root=str(self.root/rid),bundle=str(bundle),
                          authRoot=str(self.app.account_store().root),settings=self.app.ACCOUNT_SETTINGS,
                          centralSave=str(self.app.LOCAL_SAVE_ROOT),secret=secret)
            log = open(self.root/(rid+'.log'),'ab')
            try:
                process = subprocess.Popen([sys.executable,'-m','server.room_worker'],cwd=self.app.ROOT,
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=dict(os.environ,PYTHONUNBUFFERED='1'))
                process.stdin.write(json.dumps(config).encode()+b'\n');process.stdin.close()
                if not select.select([process.stdout],[],[],12)[0]: raise AccountError('战役启动超时，请稍后重试',503)
                ready = json.loads(process.stdout.readline())
                if not isinstance(ready.get('port'),int): raise ValueError('invalid worker')
            except Exception:
                if 'process' in locals():
                    process.terminate();process.wait(timeout=5)
                    process.stdin.close();process.stdout.close()
                raise AccountError('战役暂时无法启动，请稍后重试',503) from None
            finally: log.close()
            worker = dict(process=process,port=ready['port'],secret=secret,ownerId=room['ownerId'],active=1,lastUsed=self.clock())
            self.workers[rid] = worker
            return worker

    def release(self,worker):
        with self.lock:
            worker['active']-=1;worker['lastUsed']=self.clock()


_SUPERVISOR_LOCK = threading.Lock()


def supervisor_for(app):
    with _SUPERVISOR_LOCK:
        if not hasattr(app.account_store(),'_supervisor'):
            app.account_store()._supervisor = Supervisor(app)
        return app.account_store()._supervisor


def profile_operation(app, token, rid, operation, data=None):
    if not enabled(app): raise AccountError('战役空间尚未开放',503)
    if operation not in ('list','bind','onboarding','start'): raise AccountError('档案操作无效',400)
    room=rooms(app).access(rid,token=token)
    if operation in ('list','bind') and room['role']!='owner':
        raise AccountError('只有创建者可以绑定玩家档案',403)
    supervisor=supervisor_for(app)
    worker=supervisor.get(room)
    connection=http.client.HTTPConnection('127.0.0.1',worker['port'],timeout=20)
    try:
        # Onboarding and starting a player always apply to the authenticated
        # member. Caller-supplied identities cannot create another member's file.
        fields = (data or {}) if operation == 'bind' else ({key:(data or {}).get(key) for key in ('characterId','expectedRoomId')} if operation == 'start' else {})
        payload=json.dumps(dict(fields,op=operation)).encode('utf-8')
        connection.request('POST','/_internal/player-profiles',payload,
            {'Content-Type':'application/json','X-Room-Secret':worker['secret'],'X-Room-Account':token})
        response=connection.getresponse()
        result=json.loads(response.read(64*1024))
        if response.status!=200 or not result.get('ok'):
            raise AccountError(result.get('error') or '空间档案暂时不可用',response.status)
        result = {key:value for key,value in result.items() if key!='ok'}
        if operation == 'onboarding':
            if room['role'] == 'owner':
                result.setdefault('migration',{})['members'] = rooms(app).members(token,rid)
            else:
                result.pop('migration',None)
        return result
    except AccountError: raise
    except (OSError,http.client.HTTPException,ValueError):
        raise AccountError('空间档案暂时不可用，请稍后重试',503) from None
    finally:
        connection.close();supervisor.release(worker)


def handle(handler, app):
    if getattr(app,'ROOM_RUNTIME',False) or not enabled(app): return False
    started=False
    worker=supervisor=upload=None
    try:
        rid,path = scope(handler)
        if not rid:
            from .storage_mode import handle_central
            if handle_central(handler,app,handler.path): return True
            central=unquote(urlsplit(handler.path).path)
            if central.startswith('/api/account/') or central=='/account' or central=='/api/workspace-epoch': return False
            # Keep the separate administrator login under its existing origin,
            # password and session checks before requiring a selected room.
            if app.WEB_ENTRANCES.role(handler)=='dm' and central in ('/api/dm/login','/api/dm/logout','/api/dm/session'):
                return False
            if app.host_request_allowed(handler): return False
            if unquote(central)=='/主控台/玩家.html' or (central=='/' and app.WEB_ENTRANCES.role(handler)=='player'):
                handler._redirect('/account');return True
            if central.startswith('/api/') or (central.startswith('/asset/') and not unquote(central).startswith('/asset/界面/')):
                raise AccountError('请从账号中心选择战役',403)
            return False
        expected,secure = origin(handler,app)
        if handler.command not in ('GET','HEAD','POST'): raise AccountError('请求方式无效',405)
        if handler.command=='POST' and handler.headers.get('Origin')!=expected:
            raise AccountError('请从当前战役页面提交操作',403)
        token = read_cookie(handler,secure)
        room = rooms(app).access(rid,token=token)
        parsed=urlsplit(path)
        query=parse_qsl(parsed.query,keep_blank_values=True)
        expected_accounts=[value for key,value in query if key=='sundollAccount']
        expected_header=handler.headers.get('X-Sundoll-Expected-Account')
        if expected_header is not None: expected_accounts.append(expected_header)
        if any(value!=room['accountId'] for value in expected_accounts):
            raise AccountError('邮箱账号已变化，请重新进入',409)
        if any(key=='sundollAccount' for key,_ in query):
            # EventSource cannot send headers. Consume only its account guard,
            # preserving the worker's original route and other query arguments.
            query=[(key,value) for key,value in query if key!='sundollAccount']
            path=urlunsplit((parsed.scheme,parsed.netloc,parsed.path,urlencode(query),parsed.fragment))
        route=urlsplit(path).path
        if route.startswith(('/_internal/','/api/local-tunnel','/api/workspace-backups','/api/dm/login','/api/dm/logout')):
            raise AccountError('此操作不适用于战役空间',403)
        if path=='/':
            target = '/主控台/主控台.html' if room['role'] in ('owner','dm') else '/主控台/玩家.html'
            handler._redirect('/rooms/'+rid+target);return True
        supervisor=supervisor_for(app)
        length = int(handler.headers.get('Content-Length') or 0)
        limit=body_limit(route,room['role']) if handler.command=='POST' else 0
        if length<0 or length>limit or handler.headers.get('Transfer-Encoding'):
            raise AccountError('请求大小无效',413)
        upload=tempfile.SpooledTemporaryFile(max_size=1024*1024)
        handler.connection.settimeout(20)
        remaining=length
        while remaining:
            chunk=handler.rfile.read(min(remaining,64*1024))
            if not chunk:raise AccountError('上传中断，请重试',400)
            upload.write(chunk);remaining-=len(chunk)
        upload.seek(0)
        # Slow uploads do not reserve a worker or hold any room/database lock.
        room=rooms(app).access(rid,token=token)
        if handler.command=='POST':body_limit(route,room['role'])
        worker=supervisor.get(room)
        headers = {k:v for k,v in handler.headers.items() if k.lower() not in HOP_HEADERS and not k.lower().startswith('x-room-')}
        headers.update({'X-Room-Secret':worker['secret'],'X-Room-Account':token,'X-Room-Origin':expected})
        # Distinct cookies keep media sessions correct when multiple rooms are open.
        cookies=SimpleCookie(headers.get('Cookie',''))
        media=cookies.get('sundoll-media-'+rid)
        headers['Cookie']='sundoll-media-session='+media.value if media else ''
        connection = http.client.HTTPConnection('127.0.0.1',worker['port'],timeout=20)
        try:
            connection.request(handler.command,quote(unquote(path),safe='/?=&%:+,;@'),upload if length else None,headers)
            response = connection.getresponse()
            started=True
            handler.send_response(response.status)
            for key,value in response.getheaders():
                if key.lower() in HOP_HEADERS or key.lower() in ('server','date','access-control-allow-origin','cache-control','referrer-policy'): continue
                if key.lower()=='set-cookie': value=value.replace('sundoll-media-session=','sundoll-media-'+rid+'=')
                if key.lower()=='location' and value.startswith('/') and not value.startswith('/account'):
                    value='/rooms/'+rid+value
                handler.send_header(key,value)
            handler.send_header('Cache-Control','no-store, private')
            handler.send_header('Referrer-Policy','same-origin')
            handler.send_header('Connection','close')
            handler.end_headers();handler.close_connection=True
            if handler.command!='HEAD':
                while True:
                    chunk=response.read1(65536)
                    if not chunk: break
                    # Long-lived SSE/media responses lose access after logout/removal.
                    current=rooms(app).access(rid,token=token)
                    if current['role']!=room['role']: raise AccountError('战役权限已变化，请刷新页面',403)
                    handler.wfile.write(chunk);handler.wfile.flush()
        finally: connection.close()
        return True
    except (AccountError,ValueError) as error:
        if started: return True
        handler.close_connection=True
        if isinstance(error,AccountError) and error.status==401 and handler.command=='GET' and '/api/' not in urlsplit(handler.path).path:
            handler._redirect(login_destination(handler.path));return True
        respond(handler,{'ok':False,'error':str(error)},getattr(error,'status',400));return True
    except (OSError,http.client.HTTPException):
        if not started:
            respond(handler,{'ok':False,'error':'战役连接暂时不可用，请重试'},503)
        handler.close_connection=True
        return True
    finally:
        if worker is not None:supervisor.release(worker)
        if upload is not None:upload.close()
