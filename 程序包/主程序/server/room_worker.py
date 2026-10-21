"""A private room process. Only its authenticated parent gateway can call it."""
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import threading
import time
from urllib.parse import urlsplit


def public_origin(value):
    """Only the configured HTTPS origin may become a shareable public base."""
    try:
        parsed=urlsplit(str(value or '').strip())
        if (parsed.scheme!='https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.path not in ('','/') or parsed.query or parsed.fragment
                or (parsed.port is not None and not 1<=parsed.port<=65535)):
            return ''
        return 'https://'+parsed.netloc
    except ValueError:
        return ''


def main():
    config = json.loads(sys.stdin.readline())
    sys.argv = [sys.argv[0]]
    from server import paths
    root,bundle = Path(config['root']),Path(config['bundle'])
    paths.APP_ROOT = bundle
    paths.PACKAGE_ROOT = root
    paths.CHECKOUT_ROOT = root
    paths.USER_DATA_ROOT = root/'运行数据'
    paths.SAVE_ROOT = paths.USER_DATA_ROOT/'存档'
    paths.CACHE_ROOT = paths.USER_DATA_ROOT/'.sundoll-cache'
    paths.MUSIC_CACHE_ROOT = paths.USER_DATA_ROOT/'音乐缓存'
    paths.ASSET_ROOT = bundle/'asset'
    os.environ['SUNDOLL_TEST_SAVE_ROOT'] = str(paths.SAVE_ROOT)
    from server.save_storage import ProjectServerLock
    from server.installation_backup import InstallationLease, installation_root
    installation_lease = InstallationLease(installation_root(config['centralSave']), shared=True)
    # A newly restarted parent must not overlap an older worker still exiting.
    project_lock=ProjectServerLock(paths.SAVE_ROOT)
    from server.workspace import Workspace,enable,write_catalog,read_catalog,atomic_json
    from server.module_runtime import ModuleRuntime
    new_workspace=not Workspace(paths.SAVE_ROOT).active
    initialization = paths.USER_DATA_ROOT/'新房间初始化.json'
    initializing = new_workspace or initialization.exists()
    if new_workspace: atomic_json(initialization,dict(format=1))
    if new_workspace: enable(root)
    ModuleRuntime(paths.SAVE_ROOT,bundle).ensure_empty_runtime()
    if initializing:
        from server.distribution import install_default_support
        install_default_support(paths.SAVE_ROOT,Path(__file__).resolve().parent.parent)
    try: read_catalog(paths.SAVE_ROOT,'template')
    except FileNotFoundError: write_catalog(paths.SAVE_ROOT,'template',dict(format='sangduoer-library',schemaVersion=1,savedAt=1,presets=[]))
    from server import http_app as app
    from server.email_accounts import AccountStore,AccountError,token_hash
    from server.account_http import respond
    from server.campaign_rooms import RoomStore
    from server.workspace_backup import epoch
    from server.web_entrances import WebEntrances
    app.ROOM_RUNTIME = True
    app.ROOT = str(bundle)
    app.MUSIC_LIBRARY_ROOT = str(bundle/'asset/音乐')
    app.DOCUMENT_LIBRARY_ROOT = str(bundle/'asset/文档')
    app.WEB_ENTRANCES = WebEntrances({},paths.USER_DATA_ROOT)
    app.ACCOUNT_SETTINGS = config['settings']
    app.PUBLIC_BASE_URL = public_origin(config['settings'].get('publicOrigin'))
    app.AUTH_METHOD = 'email_password'
    accounts = AccountStore(config['authRoot'],config['settings'],epoch=lambda:epoch(config['centralSave']))
    app.account_store = lambda:accounts
    rooms = RoomStore(accounts)
    from server.account_characters import Characters, central_root, configure
    character_store = Characters(central_root(accounts))
    character_store.migrate(config['room'], app.profile_store())
    configure(paths.SAVE_ROOT, character_store.root, config['room'])
    def host_allowed(handler):
        try: return rooms.access(config['room'],token=handler.headers.get('X-Room-Account',''))['role'] in ('owner','dm')
        except AccountError: return False
    app.host_request_allowed = host_allowed
    app.local_save_request_allowed = lambda handler:app.host_request_allowed(handler) and handler.headers.get(app.LOCAL_SAVE_HEADER)=='1'
    app.document_request_allowed = app.host_request_allowed
    request_context=threading.local()
    original_touch = app.touch_session
    def touch(token,status=None):
        session=app.SESSIONS.get(str(token or ''))
        if session:
            try: access=rooms.access(config['room'],digest=session.get('_accountSession'))
            except AccountError: app.SESSIONS.pop(str(token),None);return None
            # A valid player token is still private to its authenticated account.
            # Reject another member's token without revoking its legitimate owner.
            current=getattr(request_context,'accountId',None)
            if current and current!=access['accountId']: return None
        return original_touch(token,status)
    app.touch_session = touch
    def cleanup_player_sessions():
        """Discard expired/revoked tokens while preserving other active browsers."""
        now=int(time.time()*1000)
        account_access={}
        profile_valid={}
        with app.LOCK:
            store=app.profile_store()
            for token,session in list(app.SESSIONS.items()):
                digest=session.get('_accountSession')
                valid=bool(digest) and now-int(session.get('lastSeen',0))<=24*60*60*1000
                if valid and digest not in account_access:
                    try: rooms.access(config['room'],digest=digest);account_access[digest]=True
                    except AccountError as error:
                        if error.status not in (401,404): raise
                        account_access[digest]=False
                valid=valid and account_access.get(digest,False)
                if valid and session.get('persistent'):
                    profile_key=(session.get('playerId'),session.get('_authVersion'))
                    if profile_key not in profile_valid:
                        profile_valid[profile_key]=store.session_valid(*profile_key)
                    valid=profile_valid[profile_key]
                if not valid: app.SESSIONS.pop(token,None)
    campaign_id=config['room']
    rel='战役/'+campaign_id+'/当前存档.json'
    if initializing and not Workspace(paths.SAVE_ROOT).save_path(rel.split('/')).exists():
        state=dict(campaignId=campaign_id,campaignName=config['name'],maps=[],mapChapters=[],mapLocations=[],
                   activeMapId=None,presentedMapId=None,snap=True,showNames=True)
        app.perform_local_save_operation(dict(op='write-campaign',path=rel,expectedHash=None,
            text=json.dumps(dict(campaignId=campaign_id,campaignName=config['name'],state=state,savedAt=int(time.time()*1000)))),str(paths.SAVE_ROOT))

    from server.room_checkpoint import RoomCheckpoint, CheckpointConflict
    checkpoint = RoomCheckpoint(root, config['room'], app.SERVER_PROTOCOL_VERSION)
    checkpoint.load(app)
    if initializing: initialization.unlink()
    writes=threading.RLock()
    stopping=threading.Event()
    def save_checkpoint(acknowledge=False,rebase=False):
        # POSTs are serialized by writes. WAL reads do not need SAVE_WRITE_LOCK;
        # reacquiring it while a response holds profiles.LOCK would invert the
        # existing lock order against concurrent readers.
        with writes,app.LOCK:
            checkpoint.save(app,acknowledge=acknowledge,rebase=rebase)

    observed_characters = -1
    def refresh_character_projection():
        nonlocal observed_characters
        with character_store.connect() as db:
            revision=db.execute('SELECT revision FROM meta WHERE id=1').fetchone()[0]
        if revision==observed_characters:return
        with app.LOCK:
            if app.STATE:
                before=json.dumps(app.STATE,sort_keys=True,ensure_ascii=False)
                from server.resources import ResourceStore
                resource=ResourceStore(app.profile_store(),app.profiles)
                ledger=resource.ledger()
                resource.reconcile(app.STATE,ledger=ledger,persist=False)
                for entry in app.STATE.get('_characterRuntime',[]):
                    current=ledger['characters']['@global'].get(entry.get('ownedPieceId'))
                    if current:entry['ownerPlayerId']=current['ownerPlayerId']
                app.sync_all_downed_portraits(app.STATE)
                if before!=json.dumps(app.STATE,sort_keys=True,ensure_ascii=False):
                    app.STATE_REVISION+=1
                    app.STATE['_stateRevision']=app.STATE_REVISION
                    app.broadcast({'type':'state','state':app.state_snapshot()})
            observed_characters=revision

    class Handler(app.Handler):
        @staticmethod
        def strict_json(raw):
            from server.http_json import loads
            return loads(raw)
        def _read_json_body(self,limit=app.MAX_BODY):
            length=int(self.headers.get('Content-Length') or 0)
            if length<0: raise ValueError('invalid content length')
            if length>limit: raise OverflowError('request body too large')
            value=self.strict_json(self.rfile.read(length) if length else b'{}')
            path=urlsplit(self.path).path
            if path=='/api/state' and isinstance(value,dict):
                checkpoint.validate_state_source(value)
            elif path=='/api/player-profiles' and isinstance(value,dict) and value.get('op')=='collect':
                checkpoint.validate_state_source(app.STATE)
                self._durable_runtime=True
            return value
        def gate(self):
            self._room_access={}
            request_context.accountId=None
            try:
                if not hmac.compare_digest(self.headers.get('X-Room-Secret',''),config['secret']):
                    raise AccountError('无权访问',403)
                if urlsplit(self.path).path=='/_internal/hibernate':
                    if self.command!='POST' or self.headers.get('X-Room-Control')!='hibernate':
                        raise AccountError('无权访问',403)
                    stopping.set()
                    save_checkpoint()
                    respond(self,dict(ok=True))
                    threading.Thread(target=self.server.shutdown,daemon=True).start()
                    return True
                if stopping.is_set(): raise AccountError('战役正在保存并重启，请稍后重试',503)
                token=self.headers.get('X-Room-Account','')
                self._room_access=rooms.access(config['room'],token=token)
                request_context.accountId=self._room_access['accountId']
                refresh_character_projection()
                path=urlsplit(self.path).path
                if self.command=='POST' and path in ('/api/action','/api/host-action','/api/journal'):
                    checkpoint.validate_state_source(app.STATE)
                if path=='/_internal/player-profiles':
                    if self.command!='POST': raise AccountError('请求方式无效',405)
                    size=int(self.headers.get('Content-Length') or 0)
                    if not 0<size<=8192: raise AccountError('请求大小无效',413)
                    data=self._read_json_body(8192)
                    if not isinstance(data,dict): raise AccountError('请求格式无效',400)
                    with app.save_storage.SAVE_WRITE_LOCK,app.profiles.LOCK:
                        if data.get('op')=='list':
                            rooms.access(config['room'],token=token)
                            result=dict(profiles=rooms.profiles(token,config['room'],app.profile_store()),characters=character_store.room_list(config['room']))
                        elif data.get('op')=='bind':
                            result=dict(character=rooms.bind_character(token,config['room'],character_store,data.get('characterId'),data.get('accountId')))
                        elif data.get('op')=='onboarding':
                            result=dict(player=rooms.onboarding(token,config['room'],app.profile_store()),characters=character_store.mine(self._room_access['accountId']))
                            if self._room_access['role']=='owner':
                                result['migration']=app.migration_snapshot()
                                result['migration'].update(characters=character_store.room_list(config['room']),members=rooms.members(token,config['room']))
                        elif data.get('op')=='start':
                            result=dict(character=rooms.select_character(token,config['room'],character_store,data.get('characterId'),data.get('expectedRoomId')))
                        else: raise AccountError('档案操作无效',400)
                    refresh_character_projection()
                    respond(self,dict(result,ok=True));return True
                if path.startswith(('/api/local-tunnel','/api/dm/login','/api/dm/logout','/api/workspace-backups')):
                    raise AccountError('此操作不适用于战役空间',403)
                if path=='/api/dm/session':
                    if not app.host_request_allowed(self): raise AccountError('此战役中的身份是玩家',403)
                    respond(self,dict(ok=True,authenticated=True));return True
                if path.startswith('/api/account/'):
                    if path!='/api/account/player-session' or self.command!='POST': raise AccountError('请从账号中心操作',403)
                    if self.headers.get('Origin')!=self.headers.get('X-Room-Origin') or self.headers.get('X-Sundoll-Account')!='1':
                        raise AccountError('请从当前战役页面操作',403)
                    size=int(self.headers.get('Content-Length') or 0)
                    if not 0<size<=8192: raise AccountError('请求大小无效',413)
                    data=self._read_json_body(8192)
                    if not isinstance(data,dict): raise AccountError('请求格式无效',400)
                    # One member refreshing must not exhaust another member's
                    # allowance; all worker traffic shares the parent's loopback IP.
                    accounts.rate('room-player-session',config['room']+':'+self._room_access['accountId'],30,900)
                    with app.save_storage.SAVE_WRITE_LOCK,app.profiles.LOCK:
                        cleanup_player_sessions()
                        profile=rooms.player(token,config['room'],app.profile_store())
                        room_token=secrets.token_urlsafe(32)
                        session=dict(token=room_token,playerId=profile['playerId'],characterId=profile.get('characterId',''),name=profile['name'],persistent=True,
                                     _authVersion=profile['_authVersion'],_accountSession=token_hash(token),
                                     status='online',lastSeen=int(time.time()*1000))
                        app.SESSIONS[room_token]=session
                        public=app.public_player_session(session);public['sessionToken']=room_token
                    respond(self,dict(ok=True,session=public,roomCode=app.ROOM_CODE),secure=self.headers.get('X-Room-Origin','').startswith('https:'))
                    return True
                if path=='/api/modules' and self.command=='POST':
                    # Restoring a workspace replaces authentication files and requires
                    # a coordinated restart; it is never a remote DM operation.
                    size=int(self.headers.get('Content-Length') or 0)
                    if not 0<size<=1024*1024: raise AccountError('请求大小无效',413)
                    raw=self.rfile.read(size)
                    import io
                    self.rfile=io.BytesIO(raw)
                    data=self.strict_json(raw)
                    if data.get('op') not in ('overview','content-packages','set-content-packages','list','confirm-import',
                            'uninstall','restore-module','restore-campaign','create-run','activate-general','activate-player',
                            'export-player','export-campaign','export-general'):
                        raise AccountError('工作区备份和恢复由服务管理员操作',403)
                return False
            except (AccountError,app.profiles.ProfileError,ValueError,TypeError) as error:
                self.close_connection=True
                respond(self,dict(ok=False,error=str(error)),getattr(error,'status',400))
                return True

        def do_GET(self):
            if not self.gate(): super().do_GET()
        def do_HEAD(self):
            if not self.gate(): super().do_HEAD()
        def do_POST(self):
            # No mutation may race a checkpoint or begin after shutdown starts.
            self._checkpoint_saved=False
            self._durable_runtime=False
            with writes:
                self._runtime_before=checkpoint.signature(app)
                try:
                    if not self.gate(): super().do_POST()
                except CheckpointConflict as error:
                    self._headers_buffer=[]
                    self.close_connection=True
                    respond(self,dict(ok=False,error=str(error),code='checkpoint-stale'),409)
        def send_response(self, code, message=None):
            self._response_status=code
            return super().send_response(code,message)
        def end_headers(self):
            if (self.command=='POST' and 200<=getattr(self,'_response_status',0)<300
                    and self._room_access and not getattr(self,'_checkpoint_saved',False)):
                try:
                    path=urlsplit(self.path).path
                    durable=(path in ('/api/state','/api/action','/api/host-action','/api/journal')
                             or self._durable_runtime)
                    save_checkpoint(acknowledge=durable and checkpoint.signature(app)!=self._runtime_before,
                                    rebase=path=='/api/state')
                    self._checkpoint_saved=True
                except Exception:
                    # No successful status line may escape before fsync. A
                    # route may send its normal error response after this fails.
                    self._headers_buffer=[]
                    self.close_connection=True
                    raise
            super().end_headers()
        def do_OPTIONS(self):
            respond(self,dict(ok=False,error='请求方式无效'),405)
        def _cors(self): pass
        def log_message(self,*args): pass

    server=app.Server(('127.0.0.1',0),Handler)
    app.PORT=server.server_address[1]
    parent=os.getppid()
    def stop(*_):
        stopping.set()
        threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    print(json.dumps(dict(port=app.PORT)),flush=True)
    def parent_watch():
        while os.getppid()==parent: time.sleep(2)
        stopping.set()
        server.shutdown()
    threading.Thread(target=parent_watch,daemon=True).start()
    try: server.serve_forever()
    finally:
        stopping.set()
        try: save_checkpoint()
        finally:
            server.server_close()
            project_lock.close()
            installation_lease.close()


if __name__=='__main__': main()
