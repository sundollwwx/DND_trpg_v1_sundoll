from project_test_paths import APP_ROOT
import http.client
import json
import time
import unittest
from unittest import mock
import test_player_profiles as legacy
from test_email_accounts import Mailbox, PASSWORD, NEW_PASSWORD
from server.email_accounts import AccountStore
from server.web_entrances import WebEntrances

SERVER = legacy.SERVER


class EmailAccountHttpTests(unittest.TestCase):
    close_server = legacy.PlayerProfileHttpTests.close_server
    request = legacy.PlayerProfileHttpTests.request

    def setUp(self):
        legacy.PlayerProfileHttpTests.setUp(self)
        self.mail = Mailbox()
        self.settings = {'enabled':True,'publicOrigin':'https://pl.example.com'}
        self.accounts = AccountStore(SERVER.profile_store().auth_root,self.settings,mailer=self.mail)
        for patch in [mock.patch.object(SERVER,'AUTH_METHOD','email_password'),
                      mock.patch.object(SERVER,'ACCOUNT_SETTINGS',self.settings),
                      mock.patch.object(SERVER,'_ACCOUNT_STORE',self.accounts)]:
            patch.start();self.addCleanup(patch.stop)
        self.cookie = ''

    def api(self, action, data=None, *, method='POST', headers=None, cookie=None):
        conn = http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
        values = {'Content-Type':'application/json','Origin':f'http://127.0.0.1:{self.port}',
                  'X-Sundoll-Account':'1','Cookie':self.cookie if cookie is None else cookie}
        values.update(headers or {})
        conn.request(method,'/api/account/'+action,json.dumps(data or {}) if method=='POST' else None,values)
        response = conn.getresponse();body=response.read();code=response.status
        returned_headers=response.getheaders();conn.close()
        for key,value in returned_headers:
            if key.lower()=='set-cookie' and value.startswith('sundoll-local-account='):
                self.cookie=value.split(';',1)[0]
        return code,json.loads(body) if body else {},returned_headers

    def login(self):
        self.assertEqual(self.api('register',{'email':'me@example.com','name':'邮箱玩家','password':PASSWORD})[0],200)
        token = self.mail.messages[-1][2]
        self.assertEqual(self.api('verify',{'token':token,'password':PASSWORD})[0],200)
        self.assertEqual(self.api('login',{'email':'me@example.com','password':PASSWORD})[0],200)

    def test_register_verify_login_and_room_access_preserve_private_cookie(self):
        self.login()
        code,result,headers=self.api('session',method='GET')
        self.assertEqual(code,200,result)
        self.assertNotIn('password',str(result));self.assertNotIn('digest',str(result))
        self.assertIn(('Cache-Control','no-store, private'),headers)
        self.assertEqual(self.api('player-session')[0],409)
        self.assertEqual(self.api('create-player',{'name':'新玩家'})[0],200)
        code,result,headers=self.api('player-session')
        self.assertEqual(code,200,result)
        self.assertTrue(any(key=='Set-Cookie' and value.startswith('sundoll-media-session=') for key,value in headers))
        token=result['session']['sessionToken']
        self.assertEqual(self.request({'op':'get','sessionToken':token})[0],200)
        self.assertEqual(self.request({'op':'get','playerId':self.pid,'sessionToken':token})[0],403)
        self.assertEqual(self.request({'op':'list','sessionToken':token})[0],403)

    def test_email_mode_rejects_name_credential_temporary_sessions_and_old_tokens(self):
        for data in ({'nickname':'甲'},{'credential':self.created['credential']},
                     {'nickname':'新玩家','authMethod':'name'},{'authMethod':'legacy'},
                     {'nickname':'甲','sessionToken':'x'}):
            self.assertEqual(self.request(data,path='/api/session')[0],401)
            self.assertEqual(self.request(data,path='/api/register')[0],401)
        SERVER.SESSIONS['old']={'token':'old','playerId':self.pid,'persistent':False,'lastSeen':int(time.time()*1000)}
        self.assertEqual(self.request({'sessionToken':'old'},path='/api/session')[0],401)

    def test_reset_and_logout_revoke_player_tokens_as_well_as_account_cookie(self):
        self.login();self.api('create-player')
        token=self.api('player-session')[1]['session']['sessionToken']
        self.assertEqual(self.api('forgot',{'email':'me@example.com'})[0],200)
        reset=self.mail.messages[-1][2]
        self.assertEqual(self.api('reset',{'token':reset,'password':NEW_PASSWORD})[0],200)
        self.assertEqual(self.request({'sessionToken':token},path='/api/session')[0],401)
        self.api('login',{'email':'me@example.com','password':NEW_PASSWORD})
        token=self.api('player-session')[1]['session']['sessionToken']
        self.api('logout')
        self.assertEqual(self.request({'sessionToken':token},path='/api/session')[0],401)

    def test_csrf_transport_and_content_type_are_checked(self):
        data={'email':'me@example.com','name':'玩家','password':PASSWORD}
        for headers,expected in [({'Origin':'https://evil.example'},403),({'Origin':''},403),
                                 ({'X-Sundoll-Account':''},403),({'Content-Type':'text/plain'},415),
                                 ({'Host':'unknown.example'},403)]:
            self.assertEqual(self.api('register',data,headers=headers)[0],expected)
        self.assertFalse(self.mail.messages)

    def test_verified_account_does_not_gain_dm_or_host_access(self):
        self.login();self.api('create-player')
        entrances=WebEntrances({'webEntrances':{'playerHostname':'pl.example.com','dmHostname':'dm.example.com'}},self.root)
        with mock.patch.object(SERVER,'WEB_ENTRANCES',entrances):
            self.assertEqual(self.request({'op':'status'},path='/api/local-save',extra={
                'Host':'pl.example.com','Origin':'https://pl.example.com','X-Forwarded-Proto':'https',
                'Cookie':self.cookie,'X-Sundoll-Local-Save':'1'})[0],403)
            self.assertEqual(self.request({},path='/api/dm/session',method='GET',extra={
                'Host':'dm.example.com','Origin':'https://dm.example.com','X-Forwarded-Proto':'https','Cookie':self.cookie})[0],401)

    def test_https_login_uses_host_only_httponly_cookie(self):
        self.login()
        entrances=WebEntrances({'webEntrances':{'playerHostname':'pl.example.com'}},self.root)
        with mock.patch.object(SERVER,'WEB_ENTRANCES',entrances):
            code,result,headers=self.api('login',{'email':'me@example.com','password':PASSWORD},headers={
                'Host':'pl.example.com','Origin':'https://pl.example.com','X-Forwarded-Proto':'https'})
        self.assertEqual(code,200,result)
        value=next(v for k,v in headers if k=='Set-Cookie')
        self.assertTrue(value.startswith('__Host-sundoll-account='))
        self.assertIn('; Secure',value);self.assertIn('; HttpOnly',value);self.assertNotIn('Domain=',value)

    def test_binding_keeps_old_player_identity_without_guessing_names(self):
        self.login()
        invitation=self.accounts.invite('me@example.com',self.pid,SERVER.profile_store())
        self.assertEqual(self.api('bind',{'token':invitation})[0],200)
        session=self.api('player-session')[1]['session']
        self.assertEqual(session['playerId'],self.pid)

    def test_mail_delivery_does_not_block_room_lock(self):
        import threading
        with mock.patch.object(self.mail,'send') as send:
            acquired=[]
            def mail(*args):
                def check():
                    with SERVER.LOCK: acquired.append(True)
                thread=threading.Thread(target=check);thread.start();thread.join(1)
                self.assertEqual(acquired,[True])
            send.side_effect=mail
            self.assertEqual(self.api('register',{'email':'me@example.com','name':'玩家','password':PASSWORD})[0],200)

    def test_unconfigured_email_blocks_register_but_not_verified_login(self):
        self.login();self.mail.ready=False
        self.assertEqual(self.api('register',{'email':'new@example.com','name':'新人','password':PASSWORD})[0],503)
        self.assertEqual(self.api('login',{'email':'me@example.com','password':PASSWORD})[0],200)

    def test_profile_writes_obey_workspace_generation_and_restore_gate(self):
        self.login()
        from server.workspace import atomic_json
        atomic_json(self.save.parent/'工作区代次.json',{'epoch':'new-generation'})
        self.assertEqual(self.api('create-player')[0],409)
        self.assertEqual(self.api('create-player',headers={'X-Sundoll-Workspace':'new-generation'})[0],200)
        self.httpd.restore_pending = True
        self.assertEqual(self.api('logout')[0],409)

    def test_binding_invitation_cannot_be_created_through_public_account_api(self):
        self.login()
        self.assertEqual(self.api('invite',{'email':'me@example.com','playerId':self.pid})[0],404)


if __name__=='__main__':unittest.main()
