from project_test_paths import APP_ROOT
import sys
sys.path.insert(0,str(APP_ROOT))
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest import mock
from test_email_accounts import Mailbox,PASSWORD
from test_player_profiles import SERVER
from server.email_accounts import AccountStore,AccountError
from server.campaign_rooms import RoomStore
from server.web_entrances import WebEntrances
from server.workspace_backup import epoch


class CampaignRoomTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.settings=dict(enabled=True,roomsEnabled=True,publicOrigin='https://pl.example.com')
        self.mail=Mailbox()
        self.accounts=AccountStore(self.root/'save/玩家档案/认证',self.settings,mailer=self.mail,epoch=lambda:epoch(self.root/'save'))
        self.rooms=RoomStore(self.accounts)
        self.tokens=[]
        for i in range(3):
            self.accounts.register(f'u{i}@example.com',f'用户{i}',PASSWORD)
            self.accounts.verify(self.mail.messages[-1][2],PASSWORD)
            self.tokens.append(self.accounts.login(f'u{i}@example.com',PASSWORD)[0])
        self.room=self.rooms.create(self.tokens[0],'甲的战役')

    def assertStatus(self,status,call):
        with self.assertRaises(AccountError) as caught:call()
        self.assertEqual(caught.exception.status,status)

    def test_roles_are_per_room_and_invitation_is_email_bound_single_use(self):
        second=self.rooms.create(self.tokens[1],'乙的战役')
        invite=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','player')
        self.assertStatus(400,lambda:self.rooms.accept(self.tokens[2],invite))
        joined=self.rooms.accept(self.tokens[1],invite)
        self.assertEqual(joined['role'],'player')
        self.assertEqual(self.rooms.access(second['id'],token=self.tokens[1])['role'],'owner')
        self.assertStatus(400,lambda:self.rooms.accept(self.tokens[1],invite))
        self.assertEqual(len(self.rooms.list(self.tokens[1])),2)
        self.assertEqual(self.rooms.list(self.tokens[2]),[])

    def test_only_owner_can_manage_and_owner_cannot_be_removed(self):
        invite=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','dm')
        self.rooms.accept(self.tokens[1],invite)
        self.assertStatus(403,lambda:self.rooms.invite(self.tokens[1],self.room['id'],'u2@example.com','dm'))
        owner=self.accounts.session(self.tokens[0])['accountId']
        self.assertStatus(409,lambda:self.rooms.change(self.tokens[0],self.room['id'],owner,'remove'))
        self.assertStatus(404,lambda:self.rooms.access('../auth',token=self.tokens[0]))

    def test_removal_and_logout_revoke_access(self):
        invite=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','player')
        self.rooms.accept(self.tokens[1],invite)
        member=self.accounts.session(self.tokens[1])['accountId']
        self.rooms.change(self.tokens[0],self.room['id'],member,'remove')
        self.assertStatus(404,lambda:self.rooms.access(self.room['id'],token=self.tokens[1]))
        self.accounts.logout(self.tokens[0])
        self.assertStatus(401,lambda:self.rooms.access(self.room['id'],token=self.tokens[0]))

    def test_removal_revokes_unconsumed_invitation_and_new_invite_restores_access(self):
        rid = self.room['id']
        pending = self.rooms.invite(self.tokens[0], rid, 'u1@example.com', 'dm')
        share = self.rooms.share(self.tokens[0], rid)
        self.rooms.join(self.tokens[1], share['token'])
        member = self.accounts.session(self.tokens[1])['accountId']
        self.rooms.change(self.tokens[0], rid, member, 'remove')
        self.assertStatus(403, lambda:self.rooms.join(self.tokens[1], share['token']))
        self.assertStatus(400, lambda:self.rooms.accept(self.tokens[1], pending))
        self.assertStatus(404, lambda:self.rooms.access(rid, token=self.tokens[1]))
        replacement = self.rooms.invite(self.tokens[0], rid, 'u1@example.com', 'player')
        self.assertEqual(self.rooms.accept(self.tokens[1], replacement)['role'], 'player')
        self.assertEqual(self.rooms.join(self.tokens[1], share['token'])['role'], 'player')


class CampaignRoomHttpTests(CampaignRoomTests):
    def setUp(self):
        super().setUp()
        values=dict(LOCAL_SAVE_ROOT=str(self.root/'save'),ACCOUNT_SETTINGS=self.settings,_ACCOUNT_STORE=self.accounts,
                    WEB_ENTRANCES=WebEntrances({'webEntrances':{'playerHostname':'pl.example.com'}},self.root),AUTH_METHOD='email_password')
        for name,value in values.items():
            patch=mock.patch.object(SERVER,name,value);patch.start();self.addCleanup(patch.stop)
        class Quiet(SERVER.Handler):
            def log_message(self,*args):pass
        self.httpd=SERVER.Server(('127.0.0.1',0),Quiet)
        patch=mock.patch.object(SERVER,'PORT',self.httpd.server_port);patch.start();self.addCleanup(patch.stop)
        self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        supervisor=getattr(self.accounts,'_supervisor',None)
        if supervisor:supervisor.close()
        self.httpd.shutdown();self.httpd.server_close();self.thread.join(3)

    def request(self,path,data=None,user=0,headers=None,state_guard=True):
        full_snapshot = (path.endswith('/api/state') or
                         (path.endswith('/api/local-save') and isinstance(data, dict) and data.get('op') == 'write-campaign'))
        if state_guard and data is not None and path.startswith('/rooms/') and full_snapshot:
            # Existing scenarios use a current client; explicit conflict tests
            # disable this helper or supply the snapshot they actually loaded.
            if 'expectedStateRevision' not in data and 'serverSessionId' not in data:
                info_path = path.rsplit('/api/', 1)[0] + '/api/info'
                code, body, _ = self.request(info_path, user=user, headers=headers)
                if code == 200:
                    info = json.loads(body)
                    data = dict(data, expectedStateRevision=info['stateRevision'], serverSessionId=info['sessionId'])
        conn=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=20)
        hdr={'Host':'pl.example.com','X-Forwarded-Proto':'https','Origin':'https://pl.example.com',
             'Content-Type':'application/json','X-Sundoll-Account':'1','X-Sundoll-Local-Save':'1',
             'Cookie':'__Host-sundoll-account='+self.tokens[user] if user is not None else ''}
        hdr.update(headers or {})
        if 'Referer' in hdr:hdr['Referer']=quote(hdr['Referer'],safe='/:')
        conn.request('POST' if data is not None else 'GET',quote(path,safe='/?=&%'),json.dumps(data) if data is not None else None,hdr)
        response=conn.getresponse();body=response.read();result=(response.status,body,response.getheaders());conn.close()
        return result

    def formal_source_hash(self,rid,campaign_id,user=0):
        code,body,_=self.request('/rooms/'+rid+'/api/local-save',dict(op='read-campaign',
            path='战役/'+campaign_id+'/当前存档.json'),user=user)
        self.assertEqual(code,200,body)
        return json.loads(body)['sourceHash']

    def make_character(self, user=1, room=None, name='旅人'):
        import secrets
        code,body,_=self.request('/api/account/character-create',dict(name=name,requestId=secrets.token_hex(16)),user=user)
        self.assertEqual(code,200,body);cid=json.loads(body)['character']['characterId']
        if room:
            code,body,_=self.request('/api/account/room-start-player',dict(roomId=room,characterId=cid),user=user)
            self.assertEqual(code,200,body)
        return cid

    def seed_legacy(self, name, rid):
        from server.module_runtime import ModuleRuntime
        from server.player_profiles import Store
        from server.account_characters import Characters,central_root
        import secrets
        path=self.root/('legacy-'+secrets.token_hex(5))
        ModuleRuntime(path,APP_ROOT).ensure_empty_runtime()
        store=Store(path,APP_ROOT,path/'cache')
        pid=store.create(name)['profile']['playerId']
        piece=store.grant(pid,dict(name=name,type='pc',hpMax=17,ac=12,level=3),'legacy-character-grant')['pieces'][0]
        Characters(central_root(self.accounts)).migrate(rid,store,pid)
        return piece['ownedPieceId']

    def test_retired_central_workspace_routes_only_through_accounts_and_rooms(self):
        with mock.patch.object(SERVER, 'ACCOUNT_ROOMS_ONLY', True):
            for host in ('pl.example.com', '127.0.0.1'):
                for path in ('/', '/login', '/主控台/主控台.html', '/主控台/玩家.html'):
                    code, body, headers = self.request(path, headers={'Host': host}, user=None)
                    self.assertEqual(code, 302, body)
                    self.assertTrue(dict(headers)['Location'].endswith('/account#dashboard'))
                for path in ('/api/state', '/api/local-save', '/api/backpack', '/api/dm/login'):
                    for data in (None, {}):
                        self.assertEqual(self.request(path, data, headers={'Host': host})[0], 410)
            self.assertEqual(self.request('/account', user=None)[0], 200)
            self.assertEqual(self.request('/api/account/rooms')[0], 200)
            self.assertEqual(self.request('/api/account/room-create', {'name': '另一个房间'})[0], 200)
            rid = self.room['id']
            self.assertEqual(self.request('/rooms/'+rid+'/主控台/主控台.html')[0], 200)
            self.assertEqual(self.request('/rooms/'+rid+'/api/local-save', {'op': 'campaign-catalog'})[0], 200)
            self.assertEqual(self.request('/api/local-save', {'op': 'campaign-catalog'},
                headers={'Referer': 'https://pl.example.com/rooms/'+rid+'/主控台/主控台.html'})[0], 200)
            self.assertEqual(self.request('/rooms/'+rid+'/api/info', user=2)[0], 404)
            self.assertEqual(self.request('/api/info', headers={'Host': '127.0.0.1', 'Origin': 'http://127.0.0.1'})[0], 200)

    def test_two_workers_isolate_saves_profiles_states_and_host_permissions(self):
        rid=self.room['id'];other=self.rooms.create(self.tokens[1],'乙的战役')['id']
        invite=self.rooms.invite(self.tokens[0],rid,'u1@example.com','player');self.rooms.accept(self.tokens[1],invite)
        status,body,_=self.request('/rooms/'+rid+'/api/local-save',{'op':'campaign-catalog'})
        self.assertEqual(status,200,body)
        self.assertIn('甲的战役',body.decode());self.assertNotIn('乙的战役',body.decode())
        self.assertEqual(self.request('/rooms/'+rid+'/api/local-save',{'op':'status'},user=1)[0],403)
        self.assertEqual(self.request('/rooms/'+rid+'/主控台/主控台.html',user=1)[0],404)
        self.assertEqual(self.request('/rooms/'+rid+'/api/document-library',user=1)[0],403)
        status,body,_=self.request('/rooms/'+other+'/api/local-save',{'op':'campaign-catalog'},user=1)
        self.assertEqual(status,200,body);self.assertIn('乙的战役',body.decode());self.assertNotIn('甲的战役',body.decode())
        first_character=self.make_character(1,rid)
        status,body,headers=self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        self.assertEqual(status,200,body);pid=json.loads(body)['session']['playerId']
        self.assertTrue(any('sundoll-media-'+rid+'=' in v for k,v in headers if k.lower()=='set-cookie'))
        second_character=self.make_character(1,other)
        status,body,_=self.request('/rooms/'+other+'/api/account/player-session',{},user=1)
        self.assertEqual(status,200,body);self.assertEqual(json.loads(body)['session']['playerId'],pid)
        self.assertNotEqual(first_character,second_character)
        self.assertEqual(json.loads(body)['session']['characterId'],second_character)
        self.assertEqual(self.accounts.session(self.tokens[1])['playerId'],'')
        self.assertEqual(self.request('/rooms/'+rid+'/api/info',user=2)[0],404)
        workers=self.accounts._supervisor.workers
        self.assertNotEqual(workers[rid]['process'].pid,workers[other]['process'].pid)
        for room_id,user,name in ((rid,0,'甲的公开状态'),(other,1,'乙的公开状态')):
            code,body,_=self.request('/rooms/'+room_id+'/api/state',dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,
                campaignId=room_id,campaignName=name,maps=[],
                _formalSourceHash=self.formal_source_hash(room_id,room_id,user=user)),user=user)
            self.assertEqual(code,200,body)
        self.assertIn('甲的公开状态',self.request('/rooms/'+rid+'/api/state')[1].decode())
        self.assertNotIn('乙的公开状态',self.request('/rooms/'+rid+'/api/state')[1].decode())

    def test_gateway_rejects_unscoped_conflicting_csrf_and_operations(self):
        rid=self.room['id']
        for path in ('/api/state','/api/info','/asset/地图/private.png','/asset%2fprivate.png'):
            self.assertEqual(self.request(path)[0],403)
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',headers={'X-Sundoll-Room':'r'+'0'*32})[0],400)
        self.assertEqual(self.request('/rooms/'+rid+'/api/local-save',{'op':'status'},headers={'Origin':'https://evil.example'})[0],403)
        status,body,_=self.request('/rooms/'+rid+'/api/modules',{'op':'backup-restore'})
        self.assertEqual(status,403,body)
        self.assertEqual(self.request('/rooms/'+rid+'/api/local-tunnel',{})[0],403)
        for route in ('/api/dm/login','/api/dm/logout'):
            self.assertEqual(self.request('/rooms/'+rid+route,{})[0],403)
        self.assertEqual(self.request('/rooms/'+rid+'/api/dm/session')[0],200)
        self.assertEqual(self.request('/api/account/rooms')[0],200)
        self.assertEqual(self.request('/api/account/room-create',{'name':'新世界'})[0],200)
        self.assertEqual(self.request('/api/account/create-player',{})[0],409)

    def test_scope_by_header_and_referer_and_worker_cannot_be_called_directly(self):
        rid=self.room['id']
        status,body,_=self.request('/api/local-save',{'op':'status'},headers={'X-Sundoll-Room':rid})
        self.assertEqual(status,200,body)
        status,body,_=self.request('/api/info',headers={'Referer':'https://pl.example.com/rooms/'+rid+'/主控台/玩家.html'})
        self.assertEqual(status,200,body)
        worker=self.accounts._supervisor.workers[rid]
        conn=http.client.HTTPConnection('127.0.0.1',worker['port']);conn.request('GET','/api/state')
        response=conn.getresponse();self.assertEqual(response.status,403);response.read();conn.close()

    def test_member_removal_closes_existing_stream_before_next_event(self):
        self.assert_stream_stops('player','remove')

    def test_dm_demotion_closes_existing_response_before_next_chunk(self):
        self.assert_stream_stops('dm','player')

    def test_large_or_unauthorized_body_is_rejected_before_body_is_read(self):
        rid=self.room['id']
        invite=self.rooms.invite(self.tokens[0],rid,'u1@example.com','player');self.rooms.accept(self.tokens[1],invite)
        for user,route,size,expected in ((1,'/api/local-save',128*1024**2,403),(0,'/api/account/player-session',9000,413)):
            conn=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=2)
            # Intentionally send only headers: a handler that reads the body hangs.
            conn.putrequest('POST','/rooms/'+rid+route,skip_host=True)
            for key,value in {'Host':'pl.example.com','Origin':'https://pl.example.com','X-Forwarded-Proto':'https',
                'Cookie':'__Host-sundoll-account='+self.tokens[user],'Content-Length':str(size)}.items():conn.putheader(key,value)
            conn.endheaders()
            response=conn.getresponse();self.assertEqual(response.status,expected);response.read();conn.close()
        self.assertFalse(getattr(self.accounts,'_supervisor',None).workers)

    def test_owner_limit_and_idle_checkpoint_restore_without_cross_room_state(self):
        rid=self.room['id']
        second=self.rooms.create(self.tokens[0],'第二个空间')['id']
        third=self.rooms.create(self.tokens[0],'第三个空间')['id']
        payload=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId=rid,campaignName='休眠后仍在的状态',maps=[])
        payload['_formalSourceHash']=self.formal_source_hash(rid,rid)
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',payload)[0],200)
        self.assertEqual(self.request('/rooms/'+second+'/api/info')[0],200)
        self.assertEqual(self.request('/rooms/'+third+'/api/info')[0],429)
        supervisor=self.accounts._supervisor
        old_pid=supervisor.workers[rid]['process'].pid
        with supervisor.lock:supervisor.workers[rid]['lastUsed']-=901
        code,body,_=self.request('/rooms/'+third+'/api/info')
        self.assertEqual(code,200,body)
        self.assertNotIn(rid,supervisor.workers)
        self.assertTrue((supervisor.root/rid/'运行数据/房间运行状态.json').exists())
        with supervisor.lock:supervisor.workers[second]['lastUsed']-=901
        code,body,_=self.request('/rooms/'+rid+'/api/state')
        self.assertEqual(code,200,body)
        self.assertIn('休眠后仍在的状态',body.decode())
        self.assertNotEqual(supervisor.workers[rid]['process'].pid,old_pid)

    def test_normal_restart_restores_published_campaign_for_players(self):
        rid=self.room['id']
        invitation=self.rooms.invite(self.tokens[0],rid,'u1@example.com','player')
        self.rooms.accept(self.tokens[1],invitation)
        payload=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-second',
            campaignName='重启前正在游玩的第二份存档',maps=[])
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',payload)[0],200)
        supervisor=self.accounts._supervisor
        old_pid=supervisor.workers[rid]['process'].pid
        supervisor.close()
        code,body,_=self.request('/rooms/'+rid+'/api/state',user=1)
        self.assertEqual(code,200,body)
        self.assertIn('重启前正在游玩的第二份存档',body.decode())
        self.assertNotEqual(supervisor.workers[rid]['process'].pid,old_pid)

    def test_deleted_initial_campaign_stays_deleted_after_restart(self):
        rid=self.room['id']
        code,body,_=self.request('/rooms/'+rid+'/api/local-save',dict(op='delete',
            path='战役/'+rid+'/当前存档.json',protocolVersion=SERVER.SERVER_PROTOCOL_VERSION))
        self.assertEqual(code,200,body)
        self.accounts._supervisor.close()
        code,body,_=self.request('/rooms/'+rid+'/api/local-save',dict(op='campaign-catalog'))
        self.assertEqual(code,200,body)
        self.assertNotIn(rid,body.decode())

    def test_owner_can_explicitly_bind_existing_profile_without_losing_collection(self):
        rid=self.room['id'];cid=self.seed_legacy('旧角色',rid)
        self.rooms.accept(self.tokens[1],self.rooms.invite(self.tokens[0],rid,'u1@example.com','player'))
        member=self.accounts.session(self.tokens[1])['accountId']
        from server.room_gateway import profile_operation
        self.assertStatus(403,lambda:profile_operation(SERVER,self.tokens[1],rid,'list'))
        self.assertStatus(404,lambda:profile_operation(SERVER,self.tokens[0],rid,'bind',dict(accountId=self.accounts.session(self.tokens[2])['accountId'],characterId=cid)))
        binding=dict(accountId=member,characterId=cid)
        for _ in range(2):
            self.assertEqual(profile_operation(SERVER,self.tokens[0],rid,'bind',binding)['character']['accountId'],member)
        for restart in (False,True):
            if restart:self.accounts._supervisor.close()
            code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)
            self.assertEqual(code,200,body);session=json.loads(body)['session']
            code,body,_=self.request('/rooms/'+rid+'/api/player-profiles',dict(op='get',sessionToken=session['sessionToken']),user=1)
            self.assertEqual(code,200,body);piece=json.loads(body)['library']['pieces'][0]
            self.assertEqual(piece['ownedPieceId'],cid);self.assertEqual(piece['hpMax'],17);self.assertEqual(piece['name'],'旧角色')
        self.assertEqual(self.request('/rooms/'+rid+'/api/dm/session',user=1)[0],403)

    def test_worker_termination_preserves_published_state(self):
        rid=self.room['id']
        payload=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-active',
            campaignName='服务停止前的公开战役',maps=[])
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',payload)[0],200)
        worker=self.accounts._supervisor.workers[rid]
        worker['process'].terminate();worker['process'].wait(timeout=5)
        code,body,_=self.request('/rooms/'+rid+'/api/state')
        self.assertEqual(code,200,body)
        self.assertIn('服务停止前的公开战役',body.decode())

    def test_two_supervisors_cannot_start_workers_for_the_same_workspace(self):
        rid=self.room['id']
        self.assertEqual(self.request('/rooms/'+rid+'/api/info')[0],200)
        original=self.accounts._supervisor.workers[rid]['process']
        from server.room_gateway import Supervisor
        duplicate=Supervisor(SERVER)
        try:
            self.assertStatus(503,lambda:duplicate.get(self.rooms.access(rid,token=self.tokens[0])))
            self.assertIsNone(original.poll())
            self.assertEqual(self.request('/rooms/'+rid+'/api/info')[0],200)
        finally: duplicate.close()

    def test_owner_binding_never_overwrites_an_existing_member_or_profile_binding(self):
        rid=self.room['id']
        for index in (1,2):self.rooms.accept(self.tokens[index],self.rooms.invite(self.tokens[0],rid,f'u{index}@example.com','player'))
        members=[self.accounts.session(token)['accountId'] for token in self.tokens]
        chars=[self.seed_legacy(name,rid) for name in ('待接管甲','待接管乙')]
        from server.room_gateway import profile_operation
        profile_operation(SERVER,self.tokens[0],rid,'bind',dict(accountId=members[1],characterId=chars[0]))
        self.assertStatus(409,lambda:profile_operation(SERVER,self.tokens[0],rid,'bind',dict(accountId=members[2],characterId=chars[0])))
        profile_operation(SERVER,self.tokens[0],rid,'bind',dict(accountId=members[1],characterId=chars[1]))
        result=profile_operation(SERVER,self.tokens[0],rid,'list')['characters']
        self.assertEqual({c['characterId'] for c in result if c['accountId']==members[1]},set(chars))

    def test_logout_invalidates_a_room_player_session(self):
        rid=self.room['id']
        invitation=self.rooms.invite(self.tokens[0],rid,'u1@example.com','player')
        self.rooms.accept(self.tokens[1],invitation)
        self.make_character(1,rid)
        code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        self.assertEqual(code,200,body)
        player_token=json.loads(body)['session']['sessionToken']
        self.accounts.logout(self.tokens[1])
        self.assertEqual(self.request('/rooms/'+rid+'/api/player-profiles',dict(op='get',sessionToken=player_token),user=1)[0],401)

    def test_first_player_entry_can_wait_for_legacy_binding_without_creating_a_profile(self):
        rid=self.room['id']
        invite=self.rooms.invite(self.tokens[0],rid,'u1@example.com','player');self.rooms.accept(self.tokens[1],invite)
        code,body,_=self.request('/api/account/room-onboarding',{'roomId':rid},user=1)
        self.assertEqual(code,200,body);status=json.loads(body)
        self.assertEqual(status['player'],dict(state='unbound',profile=None))
        self.assertNotIn('migration',status)
        self.assertEqual(self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)[0],409)
        code,body,_=self.request('/api/account/room-profiles',{'roomId':rid})
        self.assertEqual(code,200,body);self.assertEqual(json.loads(body)['profiles'],[])
        cid=self.seed_legacy('旧角色',rid)
        member=self.accounts.session(self.tokens[1])['accountId']
        self.assertEqual(self.request('/api/account/room-bind-player',dict(roomId=rid,accountId=member,characterId=cid))[0],200)
        code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        self.assertEqual(code,200,body);self.assertTrue(json.loads(body)['session']['persistent'])

    def test_member_onboarding_and_explicit_start_cannot_target_another_account(self):
        rid=self.room['id']
        self.rooms.accept(self.tokens[1],self.rooms.invite(self.tokens[0],rid,'u1@example.com','player'))
        owner=self.accounts.session(self.tokens[0])['accountId']
        cid=self.make_character(0)
        self.assertEqual(self.request('/api/account/room-start-player',dict(roomId=rid,characterId=cid,accountId=owner),user=1)[0],404)
        own=self.make_character(1)
        code,body,_=self.request('/api/account/room-start-player',dict(roomId=rid,characterId=own,accountId=owner),user=1)
        self.assertEqual(code,200,body)
        self.assertEqual(json.loads(body)['character']['accountId'],self.accounts.session(self.tokens[1])['accountId'])
        code,body,_=self.request('/api/account/room-onboarding',dict(roomId=rid))
        self.assertEqual(code,200,body);view=json.loads(body)
        self.assertEqual(view['player']['state'],'unbound');self.assertIn('members',view['migration'])

    def assert_stream_stops(self,initial_role,next_role):
        rid=self.room['id']
        invitation=self.rooms.invite(self.tokens[0],rid,'u1@example.com',initial_role)
        self.rooms.accept(self.tokens[1],invitation)
        payload=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId=rid,campaignName='公开状态',maps=[])
        payload['_formalSourceHash']=self.formal_source_hash(rid,rid)
        status,body,_=self.request('/rooms/'+rid+'/api/state',payload)
        self.assertEqual(status,200,body)
        conn=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=5)
        conn.request('GET','/rooms/'+rid+'/api/events',headers={'Host':'pl.example.com','X-Forwarded-Proto':'https',
            'Cookie':'__Host-sundoll-account='+self.tokens[1]})
        response=conn.getresponse();self.assertEqual(response.status,200)
        first=response.read1(65536)
        event=next(line[6:] for line in first.splitlines() if line.startswith(b'data: '))
        self.assertEqual(json.loads(event)['type'],'state')
        self.rooms.change(self.tokens[0],rid,self.accounts.session(self.tokens[1])['accountId'],next_role)
        payload['campaignName']='不应收到的新状态'
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',payload)[0],200)
        self.assertEqual(response.read1(65536),b'')
        conn.close()
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',user=1)[0],404 if next_role=='remove' else 200)
        if next_role=='player':self.assertEqual(self.request('/rooms/'+rid+'/api/local-save',{'op':'status'},user=1)[0],403)


if __name__=='__main__':unittest.main()
