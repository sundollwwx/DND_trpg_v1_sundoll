from project_test_paths import APP_ROOT
import sys
sys.path.insert(0, str(APP_ROOT))
import base64
import hashlib
import hmac
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from server.email_accounts import AccountStore, AccountError
from server.site_identity import issue, validate, KEY_FILE, BASE
from server.web_entrances import WebEntrances
from test_email_accounts import Mailbox, PASSWORD, NEW_PASSWORD
from test_player_profiles import SERVER


class WebsiteIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1800000000
        self.mail = Mailbox()
        self.store = AccountStore(self.root/'auth', dict(enabled=True), mailer=self.mail, clock=lambda:self.now)
        self.store.register('test@example.com', '公开昵称', PASSWORD)
        self.store.verify(self.mail.messages[-1][2], PASSWORD)
        self.token, self.account = self.store.login('test@example.com', PASSWORD)
        (self.store.root/KEY_FILE).write_text('a'*64)

    def test_scoped_ticket_contains_no_email_or_raw_account_or_cookie(self):
        result = issue(self.store, self.token)
        claims = validate(self.store, result['ticket'])
        self.assertEqual(claims['nickname'], '公开昵称')
        self.assertEqual(claims['exp']-claims['iat'], 300)
        self.assertEqual(result['identity']['id'], claims['publicId'])
        serialized = json.dumps(claims)
        for private in ('test@example.com', self.account['accountId'], self.token): self.assertNotIn(private, serialized)
        second = self.store.login('test@example.com', PASSWORD)[0]
        self.assertEqual(issue(self.store, second)['identity'], result['identity'])

    def test_expired_forged_and_wrong_audience_tickets_fail(self):
        result = issue(self.store, self.token)
        self.now += 300
        with self.assertRaises(AccountError): validate(self.store, result['ticket'])
        self.now -= 300
        head, payload, sig = result['ticket'].split('.')
        with self.assertRaises(AccountError): validate(self.store, head+'.'+payload+'.'+('A' if sig[0]!='A' else 'B')+sig[1:])
        claims = validate(self.store, result['ticket']); claims['aud'] = 'campaign-admin'
        encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        content = head+'.'+encoded
        signature = base64.urlsafe_b64encode(hmac.new(b'a'*64, content.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        with self.assertRaises(AccountError): validate(self.store, content+'.'+signature)

    def test_logout_reset_and_disable_immediately_revoke_live_write_ticket(self):
        ticket = issue(self.store, self.token)['ticket']; self.store.logout(self.token)
        with self.assertRaises(AccountError): validate(self.store, ticket)
        token = self.store.login('test@example.com', PASSWORD)[0]
        ticket = issue(self.store, token)['ticket']; self.store.forgot('test@example.com')
        self.store.reset(self.mail.messages[-1][2], NEW_PASSWORD)
        with self.assertRaises(AccountError): validate(self.store, ticket)
        token = self.store.login('test@example.com', NEW_PASSWORD)[0]
        ticket = issue(self.store, token)['ticket']
        with self.store.db() as db: db.execute('UPDATE accounts SET enabled=0')
        with self.assertRaises(AccountError): validate(self.store, ticket)

    def test_missing_or_symlink_key_fails_closed(self):
        path = self.store.root/KEY_FILE; path.unlink()
        with self.assertRaises(AccountError): issue(self.store,self.token)
        target = self.root/'key'; target.write_text('b'*64); path.symlink_to(target)
        with self.assertRaises(AccountError): issue(self.store,self.token)


class WebsiteIdentityHttpTests(WebsiteIdentityTests):
    def setUp(self):
        super().setUp()
        values = dict(_ACCOUNT_STORE=self.store, ACCOUNT_SETTINGS=self.store.settings,
                      LOCAL_SAVE_ROOT=str(self.root/'save'),
                      WEB_ENTRANCES=WebEntrances({'webEntrances':{'mainHostname':'main.example.com','playerHostname':'pl.example.com'}},self.root))
        for field,value in values.items():
            patch=mock.patch.object(SERVER,field,value);patch.start();self.addCleanup(patch.stop)
        patch=mock.patch.object(SERVER,'account_store',return_value=self.store);patch.start();self.addCleanup(patch.stop)
        class Quiet(SERVER.Handler):
            def log_message(self,*args):pass
        self.httpd=SERVER.Server(('127.0.0.1',0),Quiet)
        self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.httpd.shutdown();self.httpd.server_close();self.thread.join(3)

    def request(self,method='GET',path=BASE,data=None,origin='https://main.example.com',cookie=True):
        conn=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=8)
        headers={'Host':'pl.example.com','X-Forwarded-Proto':'https','Content-Type':'application/json','X-Sundoll-Account':'1'}
        if origin:headers['Origin']=origin
        if cookie:headers['Cookie']='__Host-sundoll-account='+self.token
        conn.request(method,path,json.dumps(data) if data is not None else None,headers)
        response=conn.getresponse();body=response.read();result=(response.status,dict(response.getheaders()),json.loads(body) if body else {})
        conn.close();return result

    def test_cors_is_exact_and_denies_foreign_origin_and_unauthenticated_cookie(self):
        status,headers,data=self.request();self.assertEqual(status,200)
        self.assertEqual(headers['Access-Control-Allow-Origin'],'https://main.example.com')
        self.assertEqual(headers['Access-Control-Allow-Credentials'],'true')
        self.assertNotIn('email',data['identity'])
        self.assertEqual(self.request(origin='https://evil.example')[0],403)
        self.assertNotIn('Access-Control-Allow-Origin',self.request(origin='https://evil.example')[1])
        self.assertEqual(self.request(cookie=False)[0],401)
        self.assertEqual(self.request(method='OPTIONS')[0],204)

    def test_real_introspection_logout_and_mismatched_identity(self):
        ticket=self.request()[2]['ticket']
        self.assertEqual(self.request('POST',BASE+'/validate',{'ticket':ticket},origin=None,cookie=False)[0],200)
        self.assertEqual(self.request('POST',BASE+'/logout',{'identityId':'board_'+'0'*32})[0],409)
        identity=self.request()[2]['identity']['id']
        status,headers,_=self.request('POST',BASE+'/logout',{'identityId':identity});self.assertEqual(status,200)
        self.assertIn('Max-Age=0',headers['Set-Cookie'])
        self.assertEqual(self.request('POST',BASE+'/validate',{'ticket':ticket},origin=None,cookie=False)[0],401)
