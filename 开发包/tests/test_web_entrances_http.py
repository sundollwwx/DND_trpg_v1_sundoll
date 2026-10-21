from project_test_paths import APP_ROOT
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote
from test_local_save_bridge import SERVER
from server.web_entrances import WebEntrances, password_record, COOKIE, SESSION_SECONDS


class WebEntranceHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.record = password_record('isolated-dm-test-password')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / '认证').mkdir()
        (self.root / '认证/dm-password.json').write_text(json.dumps(self.record))
        self.settings = {'webEntrances': {'mainHostname': 'sundollworld.com',
            'playerHostname': 'pl.sundollworld.com', 'dmHostname': 'dm.sundollworld.com'}}
        self.now = 100
        self.portal = WebEntrances(self.settings, self.root, lambda: self.now)
        for name, value in [('WEB_ENTRANCES', self.portal), ('LOCAL_SAVE_ROOT', str(self.root / '存档')),
                            ('STATE', None), ('PUBLIC_BASE_URL', ''),
                            ('ACCOUNT_SETTINGS', {'enabled': False}), ('AUTH_METHOD', 'name')]:
            patch = mock.patch.object(SERVER, name, value)
            patch.start(); self.addCleanup(patch.stop)
        self.httpd = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        self.port = self.httpd.server_port
        patch = mock.patch.object(SERVER, 'PORT', self.port)
        patch.start(); self.addCleanup(patch.stop)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start(); self.addCleanup(self.close)

    def close(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join()

    def request(self, path, method='GET', body=None, host='dm.sundollworld.com', token='', headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        request_headers = {'Host': host, 'X-Forwarded-Proto': 'https'}
        if token: request_headers['Cookie'] = COOKIE + '=' + token
        if method == 'POST': request_headers.update({'Origin': 'https://' + host, 'Content-Type': 'application/json'})
        request_headers.update(headers or {})
        connection.request(method, quote(path, safe='/?=&%'), data, request_headers)
        response = connection.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        connection.close(); return result

    def login(self):
        code, headers, body = self.request('/api/dm/login', 'POST', {'password': 'isolated-dm-test-password'})
        self.assertEqual(code, 200, body)
        cookie = headers['Set-Cookie']
        self.assertIn('Secure', cookie); self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie); self.assertNotIn('Domain=', cookie)
        return cookie.split(';')[0].split('=', 1)[1]

    def test_main_has_two_entrances_and_old_player_link_redirects(self):
        code, _, body = self.request('/', host='sundollworld.com')
        self.assertEqual(code, 200)
        self.assertIn(b'https://dm.sundollworld.com', body)
        self.assertIn(b'https://pl.sundollworld.com', body)
        code, headers, _ = self.request('/主控台/玩家.html?room=STALE', host='sundollworld.com')
        self.assertEqual(code, 302)
        self.assertEqual(headers['Location'], 'https://pl.sundollworld.com/')

    def test_player_bookmark_remains_independent_of_room_and_has_no_dm_access(self):
        self.assertEqual(self.request('/', host='pl.sundollworld.com')[0], 302)
        code, _, html = self.request('/主控台/玩家.html?room=OLD', host='pl.sundollworld.com')
        self.assertEqual(code, 200)
        self.assertNotIn(b'id="join-room"', html)
        self.assertNotIn(b'id="join-room-code"', html)
        token = self.login()
        for path in ('/主控台/主控台.html', '/主控台/host/app.js'):
            self.assertEqual(self.request(path, host='pl.sundollworld.com', token=token)[0], 404)
        self.assertEqual(self.request('/api/local-save', 'POST', {'op': 'status'},
            host='pl.sundollworld.com', token=token, headers={'X-Sundoll-Local-Save': '1'})[0], 403)

    def test_dm_login_guards_pages_scripts_documents_and_write_apis(self):
        code, _, body = self.request('/')
        self.assertEqual(code, 200); self.assertIn(b'id="dm-password"', body)
        self.assertEqual(self.request('/web/dm-login.js')[0], 200)
        self.assertEqual(self.request('/asset/界面/品牌/桑哆尔之歌-logo.png')[0], 200)
        self.assertEqual(self.request('/api/local-save', 'POST', {'op': 'status'})[0], 401)
        self.assertEqual(self.request('/api/document-library')[0], 401)
        self.assertEqual(self.request('/主控台/host/app.js')[0], 401)
        self.assertEqual(self.request('/主控台/主控台.html')[1]['Location'], '/login')
        code, headers, _ = self.request('/api/dm/login', 'POST', {'password': 'incorrect'})
        self.assertEqual(code, 401); self.assertNotIn('Set-Cookie', headers)
        token = self.login()
        self.assertEqual(self.request('/主控台/主控台.html', token=token)[0], 200)
        self.assertEqual(self.request('/主控台/host/app.js', 'HEAD', token=token)[0], 200)
        self.assertEqual(self.request('/api/dm/session', token=token)[0], 200)
        code, _, body = self.request('/api/local-save', 'POST', {'op': 'status'}, token=token,
            headers={'X-Sundoll-Local-Save': '1'})
        self.assertEqual(code, 200, body)
        self.assertEqual(json.loads(body)['mode'], 'local-project')

    def test_csrf_and_insecure_requests_cannot_use_dm_session(self):
        token = self.login()
        for headers in ({'Origin': 'https://pl.sundollworld.com'}, {'Origin': 'null'},
                        {'Origin': ''}, {'X-Forwarded-Proto': 'http'},
                        {'Sec-Fetch-Site': 'same-site'}):
            code, _, _ = self.request('/api/state', 'POST', {'maps': []}, token=token, headers=headers)
            self.assertEqual(code, 401, headers)
            self.assertIsNone(SERVER.STATE)
        self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'isolated-dm-test-password'},
            headers={'Origin': 'https://pl.sundollworld.com'})[0], 403)
        self.assertEqual(self.request('/api/local-save', 'POST', {'op': 'status'}, token=token)[0], 403)
        self.assertEqual(self.request('/api/dm/session', token=token,
            headers={'Sec-Fetch-Site': 'same-site'})[0], 401)

    def test_multi_room_mode_keeps_the_legacy_dm_login_boundary(self):
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', {'enabled': True, 'roomsEnabled': True}), \
                mock.patch.object(SERVER, 'AUTH_METHOD', 'email_password'):
            code, headers, _ = self.request('/')
            self.assertEqual(code, 302)
            self.assertEqual(headers['Location'], 'https://pl.sundollworld.com/account')
            self.assertEqual(self.request('/login')[0], 200)
            self.assertEqual(self.request('/api/dm/session')[0], 401)
            self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'incorrect'})[0], 401)
            self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'isolated-dm-test-password'},
                headers={'Origin': 'https://pl.sundollworld.com'})[0], 403)
            token = self.login()
            self.assertEqual(self.request('/api/dm/session', token=token)[0], 200)
            self.assertEqual(self.request('/主控台/主控台.html', token=token)[0], 200)
            self.assertEqual(self.request('/api/dm/session', token=token,
                headers={'X-Forwarded-Proto': 'http'})[0], 401)
            self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'isolated-dm-test-password'},
                host='pl.sundollworld.com')[0], 403)
            self.assertEqual(self.request('/api/info', host='pl.sundollworld.com', token=token)[0], 403)
            self.assertEqual(self.request('/api/dm/logout', 'POST', token=token)[0], 200)
            self.assertEqual(self.request('/api/dm/session', token=token)[0], 401)

    def test_email_spaces_unify_dm_bookmarks_without_replacing_admin_login(self):
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', {'enabled': True, 'roomsEnabled': True}), \
                mock.patch.object(SERVER, 'AUTH_METHOD', 'email_password'):
            for method in ('GET', 'HEAD'):
                for path in ('/', '/index.html'):
                    code, headers, body = self.request(path, method)
                    self.assertEqual(code, 302, (method, path, body))
                    self.assertEqual(headers['Location'], 'https://pl.sundollworld.com/account')
                    self.assertEqual(body, b'')
            code, _, body = self.request('/login')
            self.assertEqual(code, 200)
            self.assertIn('原工作区管理'.encode(), body)
            self.assertIn(b'id="dm-password"', body)
            self.assertIn(b'https://pl.sundollworld.com/account', body)
            self.assertNotIn(b'{{', body)
            token = self.login()
            self.assertEqual(self.request('/')[1]['Location'], 'https://pl.sundollworld.com/account')
            self.assertEqual(self.request('/login', token=token)[1]['Location'], quote('/主控台/主控台.html', safe='/'))
            self.assertEqual(self.request('/主控台/主控台.html', token=token)[0], 200)

    def test_email_spaces_render_public_home_and_canonical_account_links(self):
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', {'enabled': True, 'roomsEnabled': True}), \
                mock.patch.object(SERVER, 'AUTH_METHOD', 'email_password'):
            for path in ('/', '/index.html'):
                code, _, body = self.request(path, host='sundollworld.com')
                self.assertEqual(code, 200)
                self.assertIn(b'class="entrance-account"', body)
                self.assertIn('进入我的战役'.encode(), body)
                self.assertIn(b'https://pl.sundollworld.com/account', body)
                self.assertIn(b'https://dm.sundollworld.com/login', body)
                self.assertNotIn(b'{{', body)
            code, headers, body = self.request('/', 'HEAD', host='sundollworld.com')
            self.assertEqual(code, 200)
            self.assertGreater(int(headers['Content-Length']), 0)
            self.assertEqual(body, b'')
            for host in ('sundollworld.com', 'dm.sundollworld.com'):
                code, headers, _ = self.request('/account', host=host)
                self.assertEqual(code, 302)
                self.assertEqual(headers['Location'], 'https://pl.sundollworld.com/account')
            code, _, body = self.request('/account', host='pl.sundollworld.com')
            self.assertEqual(code, 200)
            self.assertIn(b'id="account-form"', body)
            self.assertNotIn(b'{{', body)
            self.assertEqual(self.request('/', host='pl.sundollworld.com')[1]['Location'], '/account')

    def test_email_spaces_local_home_keeps_account_and_original_workspace_local(self):
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', {'enabled': True, 'roomsEnabled': True}), \
                mock.patch.object(SERVER, 'AUTH_METHOD', 'email_password'):
            local = '127.0.0.1:' + str(self.port)
            code, _, body = self.request('/', host=local)
            self.assertEqual(code, 200)
            self.assertIn(b'class="entrance-account"', body)
            self.assertIn(b'href="/account"', body)
            self.assertIn('href="/主控台/主控台.html"'.encode(), body)
            self.assertNotIn(b'{{', body)
            self.assertNotIn('同一 WiFi'.encode(), body)
            code, _, body = self.request('/account', host=local)
            self.assertEqual(code, 200)
            self.assertIn(b'id="account-form"', body)
            self.assertNotIn(b'{{', body)
            self.assertEqual(self.request('/主控台/主控台.html', host=local)[0], 200)

    def test_public_account_entrance_brand_probe_needs_no_account_or_admin_session(self):
        with mock.patch.object(SERVER, 'ACCOUNT_SETTINGS', {'enabled': True, 'roomsEnabled': True}), \
                mock.patch.object(SERVER, 'AUTH_METHOD', 'email_password'):
            for host in ('pl.sundollworld.com', 'dm.sundollworld.com'):
                code, headers, body = self.request('/asset/界面/品牌/桑哆尔之歌-logo.png?_portalCheck=isolated-test', host=host)
                self.assertEqual(code, 200)
                self.assertEqual({key.lower():value for key,value in headers.items()}['content-type'], 'image/png')
                self.assertTrue(body.startswith(b'\x89PNG'))
            self.assertEqual(self.request('/api/info', host='pl.sundollworld.com')[0], 403)

    def test_expiry_logout_and_restart_revoke_dm_sessions(self):
        token = self.login()
        self.now += SESSION_SECONDS + 1
        self.assertEqual(self.request('/api/dm/session', token=token)[0], 401)
        token = self.login()
        self.assertEqual(self.request('/api/dm/logout', 'POST', token=token)[0], 200)
        self.assertEqual(self.request('/api/dm/session', token=token)[0], 401)
        token = self.login()
        with mock.patch.object(SERVER, 'WEB_ENTRANCES', WebEntrances(self.settings, self.root)):
            self.assertEqual(self.request('/api/dm/session', token=token)[0], 401)

    def test_missing_password_fails_closed_and_login_attempts_are_bounded(self):
        self.portal.verifier = None
        self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'anything'})[0], 503)
        self.portal.verifier = (bytes.fromhex(self.record['salt']), bytes.fromhex(self.record['digest']), self.record['iterations'])
        for _ in range(5): self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'wrong'})[0], 401)
        self.assertEqual(self.request('/api/dm/login', 'POST', {'password': 'isolated-dm-test-password'})[0], 429)
        self.now += 61
        self.login()

    def test_local_host_and_authenticated_remote_dm_can_write_but_player_cannot(self):
        self.assertEqual(self.request('/主控台/主控台.html', host='127.0.0.1:' + str(self.port))[0], 200)
        token = self.login()
        code, _, body = self.request('/api/local-save', 'POST',
            {'op': 'write', 'path': '存档索引.json', 'text': '{"isolated":true}'}, token=token,
            headers={'X-Sundoll-Local-Save': '1'})
        self.assertEqual(code, 200, body)
        self.assertEqual((self.root / '存档/存档索引.json').read_text(), '{"isolated":true}')
        self.assertEqual(self.request('/api/local-save', 'POST',
            {'op': 'write', 'path': '../认证/dm-password.json', 'text': 'bad'}, token=token,
            headers={'X-Sundoll-Local-Save': '1'})[0], 400)
        self.assertEqual(json.loads((self.root / '认证/dm-password.json').read_text()), self.record)


if __name__ == '__main__': unittest.main()
