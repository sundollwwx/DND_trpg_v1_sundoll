"""Regression cases for account switches and room HTTP authorization."""
import json
import http.client
import unittest
from urllib.parse import quote
from unittest import mock

from test_campaign_rooms import CampaignRoomHttpTests
from test_email_accounts import PASSWORD


class AuthorizationAuditTests(CampaignRoomHttpTests):
    def join(self, user=1, role='player'):
        invitation=self.rooms.invite(self.tokens[0],self.room['id'],f'u{user}@example.com',role)
        self.rooms.accept(self.tokens[user],invitation)

    def start_player(self, user=0, room_id=None):
        self.make_character(user, room_id or self.room['id'])

    def stream(self, user=1):
        connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=5)
        connection.request('GET','/rooms/'+self.room['id']+'/api/events',headers={
            'Host':'pl.example.com','X-Forwarded-Proto':'https',
            'Cookie':'__Host-sundoll-account='+self.tokens[user]})
        response=connection.getresponse()
        self.assertEqual(response.status,200)
        first=response.read1(65536)
        event=next(line[6:] for line in first.splitlines() if line.startswith(b'data: '))
        self.assertEqual(json.loads(event)['type'],'state')
        self.addCleanup(connection.close)
        return response

    def publish(self, name):
        from test_campaign_rooms import SERVER
        self.assertEqual(self.request('/rooms/'+self.room['id']+'/api/state',dict(
            protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-audit',
            campaignName=name,maps=[]))[0],200)

    def test_stale_account_logout_does_not_revoke_the_replacement_login(self):
        owner = self.accounts.session(self.tokens[0])['accountId']
        code, body, headers = self.request('/api/account/logout', {}, user=1,
            headers={'X-Sundoll-Expected-Account': owner})
        self.assertEqual(code, 409, body)
        self.assertIsNotNone(self.accounts.session(self.tokens[1]))
        self.assertFalse(any(key.lower() == 'set-cookie' for key, _ in headers))
        current = self.accounts.session(self.tokens[1])['accountId']
        self.assertEqual(self.request('/api/account/logout', {}, user=1,
            headers={'X-Sundoll-Expected-Account': current})[0], 200)
        self.assertIsNone(self.accounts.session(self.tokens[1]))

    def test_unavailable_mail_credentials_leave_existing_account_login_available(self):
        from server.email_accounts import SMTPMailer,AccountError
        settings=dict(self.settings,smtp=dict(host='smtp.invalid',username='isolated',
            security='ssl',**{'from':'no-reply@example.com'}))
        self.accounts.mailer=SMTPMailer(settings)
        with mock.patch.object(SMTPMailer,'_secret',side_effect=AccountError('测试中的邮件配置不可用',503)):
            code,body,_=self.request('/api/account/config',user=None)
            self.assertEqual(code,200,body)
            config=json.loads(body)
            self.assertEqual((config['enabled'],config['emailReady']),(True,False))
            self.assertEqual(self.request('/api/account/login',dict(
                email='u0@example.com',password=PASSWORD),user=None)[0],200)
            self.assertEqual(self.request('/api/account/register',dict(
                email='new@example.com',name='临时测试',password=PASSWORD),user=None)[0],503)

    def test_logout_closes_an_existing_room_stream_before_a_new_event(self):
        self.join();self.publish('公开旧状态')
        response=self.stream()
        self.accounts.logout(self.tokens[1])
        self.publish('退出后不应继续收到')
        self.assertEqual(response.read1(65536),b'')
        self.assertEqual(self.request('/rooms/'+self.room['id']+'/api/state',user=1)[0],401)

    def test_password_reset_revokes_a_running_stream_and_all_browser_sessions(self):
        self.join();self.publish('修改密码前')
        second=self.accounts.login('u1@example.com',PASSWORD)[0]
        response=self.stream()
        self.accounts.forgot('u1@example.com')
        self.accounts.reset(self.mail.messages[-1][2],'new isolated test passphrase')
        self.assertIsNone(self.accounts.session(second))
        self.assertIsNone(self.accounts.session(self.tokens[1]))
        self.publish('重设后不应继续收到')
        self.assertEqual(response.read1(65536),b'')

    def test_player_token_is_private_to_its_account_but_not_to_one_browser(self):
        self.join();self.join(user=2)
        rid=self.room['id']
        self.start_player(user=1)
        code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        self.assertEqual(code,200,body)
        token=json.loads(body)['session']['sessionToken']
        second=self.accounts.login('u1@example.com',PASSWORD)[0]
        payload=dict(op='get',sessionToken=token)
        self.assertEqual(self.request('/rooms/'+rid+'/api/player-profiles',payload,
            headers={'Cookie':'__Host-sundoll-account='+second})[0],200)
        # A rejected request by another member must not invalidate the owner.
        for _ in range(3):
            self.assertEqual(self.request('/rooms/'+rid+'/api/player-profiles',payload,user=2)[0],401)
            self.assertEqual(self.request('/rooms/'+rid+'/api/player-profiles',payload,user=1)[0],200)

    def test_action_retries_follow_stable_player_identity_across_logins_and_restart(self):
        self.join();self.join(user=2)
        rid=self.room['id']
        for user in (1,2):self.start_player(user=user)
        def player_session(user):
            code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=user)
            self.assertEqual(code,200,body)
            return json.loads(body)['session']
        sessions={user:player_session(user) for user in (1,2)}
        from test_campaign_rooms import SERVER
        state=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-audit',
            campaignName='独立的玩家请求',activeMapId='m',maps=[dict(id='m',mapW=500,mapH=500,
                playerAccessible=True,tokens=[dict(id='t'+str(user),type='pc',
                    ownerPlayerId=session['playerId'],hp=20,hpMax=20)
                    for user,session in sessions.items()])])
        self.assertEqual(self.request('/rooms/'+rid+'/api/state',state)[0],200)
        def roll(user, token, result):
            code,info,_=self.request('/rooms/'+rid+'/api/info',user=user)
            self.assertEqual(code,200,info)
            code,body,_=self.request('/rooms/'+rid+'/api/action',dict(sessionToken=token,
                campaignId='c-audit',serverSessionId=json.loads(info)['sessionId'],actionId='shared-action-id',
                action=dict(op='patchToken',mapId='m',tokenId='t'+str(user),patch=dict(hp=result))),user=user)
            self.assertEqual(code,200,body)
            return json.loads(body)
        first=roll(1,sessions[1]['sessionToken'],12)
        second=roll(2,sessions[2]['sessionToken'],17)
        self.assertNotEqual(first['seq'],second['seq'])
        self.assertFalse(second.get('duplicate',False))
        retry=roll(1,player_session(1)['sessionToken'],12)
        self.assertEqual((retry['seq'],retry['duplicate']),(first['seq'],True))
        self.accounts._supervisor.close()
        after_restart=roll(1,player_session(1)['sessionToken'],12)
        self.assertEqual((after_restart['seq'],after_restart['duplicate']),(first['seq'],True))

    def test_email_room_mode_rejects_legacy_registration_and_provider_switch(self):
        self.join();rid=self.room['id']
        for route,payload in (('/api/register',dict(nickname='伪装玩家',credential='LegacyCode-2026')),
                ('/api/session',dict(nickname='用户1',authMethod='name')),
                ('/api/session',dict(credential='LegacyCode-2026'))):
            self.assertIn(self.request('/rooms/'+rid+route,payload,user=1)[0],(401,413),route)
        self.assertEqual(self.request('/api/account/create-player',dict(name='不应写入原工作区'),user=1)[0],409)

    def test_room_worker_advertises_a_valid_public_origin_without_granting_membership(self):
        rid=self.room['id']
        for route in ('/api/info','/api/players'):
            code,body,_=self.request('/rooms/'+rid+route)
            self.assertEqual(code,200,body)
            self.assertEqual(json.loads(body)['publicBase'],'https://pl.example.com')
            self.assertEqual(self.request('/rooms/'+rid+route,user=2)[0],404)
        self.accounts._supervisor.close()
        self.settings['publicOrigin']='https://user:secret@example.com/private?token=invalid'
        code,body,_=self.request('/rooms/'+rid+'/api/info')
        self.assertEqual(code,200,body)
        self.assertEqual(json.loads(body)['publicBase'],'')

    def test_public_share_origin_rejects_non_origins_and_unsafe_urls(self):
        from server.room_worker import public_origin
        for invalid in ('','http://pl.example.com','javascript:alert(1)',
                'https://user@example.com','https://user:secret@example.com','https://@pl.example.com','https://:@pl.example.com',
                'https://pl.example.com/private','https://pl.example.com?token=value',
                'https://pl.example.com#room','https://pl.example.com:invalid',
                'https://pl.example.com:0','https://pl.example.com:65536','https://[broken'):
            self.assertEqual(public_origin(invalid),'',invalid)
        self.assertEqual(public_origin('https://pl.example.com/'),'https://pl.example.com')
        self.assertEqual(public_origin('https://pl.example.com:443'),'https://pl.example.com:443')

    def test_room_session_rate_limit_is_per_member_and_room(self):
        self.join();self.join(user=2);rid=self.room['id']
        for user in (1,2):self.start_player(user=user)
        for _ in range(30):
            self.assertEqual(self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)[0],200)
        self.assertEqual(self.request('/rooms/'+rid+'/api/account/player-session',{},user=1)[0],429)
        self.assertEqual(self.request('/rooms/'+rid+'/api/account/player-session',{},user=2)[0],200)
        own_room=self.rooms.create(self.tokens[1],'独立的会话额度')['id']
        self.start_player(user=1,room_id=own_room)
        self.assertEqual(self.request('/rooms/'+own_room+'/api/account/player-session',{},user=1)[0],200)

    def test_new_room_session_cleans_revoked_tokens_without_revoking_valid_old_tabs(self):
        self.join();self.join(user=2);rid=self.room['id']
        sessions={}
        for user in (1,2):
            self.start_player(user=user)
            code,body,_=self.request('/rooms/'+rid+'/api/account/player-session',{},user=user)
            self.assertEqual(code,200,body)
            sessions[user]=json.loads(body)['session']['sessionToken']
        self.accounts.logout(self.tokens[1])
        self.start_player()
        self.assertEqual(self.request('/rooms/'+rid+'/api/account/player-session',{})[0],200)
        code,body,_=self.request('/rooms/'+rid+'/api/health')
        self.assertEqual(code,200,body)
        self.assertEqual(json.loads(body)['players'],2)
        self.assertEqual(self.request('/rooms/'+rid+'/api/player-profiles',dict(
            op='get',sessionToken=sessions[2]),user=2)[0],200)

    def test_player_role_cannot_use_host_apis_or_private_static_paths_by_get_or_head(self):
        self.join()
        rid=self.room['id']
        for path,expected in (('/主控台/主控台.html',404),('/主控台/host/app.js',404),
                ('/api/document-library',403),('/api/modules/download/'+'a'*32+'.zip',404),
                ('/server/http_app.py',404),('/.git/config',404),('/运行数据/认证/邮箱账号.sqlite3',404)):
            # Document HEAD intentionally falls back to the same deny boundary.
            for method in ('GET','HEAD'):
                connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=5)
                connection.request(method,quote('/rooms/'+rid+path,safe='/'),headers={
                    'Host':'pl.example.com','X-Forwarded-Proto':'https',
                    'Cookie':'__Host-sundoll-account='+self.tokens[1]})
                response=connection.getresponse();response.read();connection.close()
                self.assertIn(response.status,(403,404),(method,path,response.status))
                if method=='GET':self.assertEqual(response.status,expected,(method,path))
        for route,payload in (('/api/local-save',{'op':'status'}),('/api/modules',{'op':'overview'}),
                ('/api/state',{'maps':[]}),('/api/host-action',{'op':'announce'}),
                ('/api/players/kick',{}),('/api/assets/cache-map',{}),('/api/item-library',{})):
            self.assertEqual(self.request('/rooms/'+rid+route,payload,user=1)[0],403,route)


# Collect only these new regressions, without duplicating the shared fixture suite.
for name in dir(CampaignRoomHttpTests):
    if name.startswith('test_') and name not in AuthorizationAuditTests.__dict__:
        setattr(AuthorizationAuditTests,name,None)
del CampaignRoomHttpTests


if __name__ == '__main__':
    unittest.main()
