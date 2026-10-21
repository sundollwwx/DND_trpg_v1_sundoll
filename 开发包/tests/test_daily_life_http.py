"""Exercise the actual read-only HTTP boundary using an isolated workspace."""
from project_test_paths import DAILY_LIFE_FIXTURE, APP_ROOT
from contextlib import ExitStack
import http.client
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

from server.daily_life import load_data
from server.workspace import enable
from test_local_save_bridge import SERVER


class DailyLifeHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='sundoll-daily-http-')
        cls.root = Path(cls.temp.name).resolve()
        cls.stack = ExitStack()
        cls.addClassCleanup(cls.cleanup_server)
        cls.save = enable(cls.root)
        cls.module = cls.root/'通用包/日常小事'
        shutil.copytree(DAILY_LIFE_FIXTURE, cls.module)
        cls.engine = cls.root/'主程序'
        cls.engine.mkdir()
        old_file = cls.engine/'主控台/host/fishing-tables.json'
        old_file.parent.mkdir(parents=True)
        old_file.write_text('{"trap":"旧文件绝不能被下载"}', encoding='utf-8')
        cls.stack.enter_context(patch.object(SERVER, 'ROOT', str(cls.engine)))
        cls.stack.enter_context(patch.object(SERVER, 'LOCAL_SAVE_ROOT', str(cls.save)))
        cls.stack.enter_context(patch.object(SERVER, 'ASSET_ROOT', str(cls.root/'缓存/联机资源')))
        cls.stack.enter_context(patch.object(SERVER, 'MUSIC_CACHE_ROOT', str(cls.root/'缓存/音乐')))
        cls.stack.enter_context(patch.object(SERVER.Handler, 'log_message', lambda *args: None))
        cls.server = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        cls.port = cls.server.server_port
        cls.stack.enter_context(patch.object(SERVER, 'PORT', cls.port))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def cleanup_server(cls):
        if getattr(cls, 'server', None):
            cls.server.shutdown()
            cls.server.server_close()
            cls.thread.join(timeout=3)
        cls.stack.close()
        cls.temp.cleanup()

    def get(self, path, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request('GET', path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_json_headers(self, headers):
        self.assertEqual(headers['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_public_menus_and_climate_script_are_safe_serialized_module_projections(self):
        status, headers, body = self.get('/api/daily-life/menus')
        self.assertEqual(status, 200)
        self.assert_json_headers(headers)
        self.assertEqual(json.loads(body), load_data(self.save, 'menus', public=True))
        status, headers, body = self.get('/api/daily-life/climate.js')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/javascript; charset=utf-8')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Cross-Origin-Resource-Policy'], 'same-origin')
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        text = body.decode('ascii')
        prefix = 'window.SundollClimateConfig = '
        self.assertTrue(text.startswith(prefix))
        self.assertTrue(text.endswith(';\n'))
        self.assertEqual(json.loads(text[len(prefix):-2]), load_data(self.save, 'climate', public=True))

    def test_private_content_accepts_local_same_origin_and_rejects_cross_site_headers(self):
        status, headers, body = self.get('/api/daily-life/lifestyle', {
            'Origin': 'http://127.0.0.1:%d' % self.port, 'Sec-Fetch-Site': 'same-origin',
        })
        self.assertEqual(status, 200)
        self.assert_json_headers(headers)
        self.assertEqual(json.loads(body), load_data(self.save, 'lifestyle'))
        hostile = (
            {'Host': 'foreign.example:%d' % self.port},
            {'Origin': 'https://foreign.example'},
            {'Origin': 'null'},
            {'Sec-Fetch-Site': 'cross-site'},
            {'Sec-Fetch-Site': 'same-site'},
        )
        for endpoint in ('lifestyle', 'flavor', 'fishing-tables'):
            for extra_headers in hostile:
                with self.subTest(endpoint=endpoint, headers=extra_headers):
                    status, headers, body = self.get('/api/daily-life/'+endpoint, extra_headers)
                    self.assertEqual(status, 403)
                    self.assert_json_headers(headers)
                    self.assertFalse(json.loads(body)['ok'])

    def test_arbitrary_category_and_traversal_are_404(self):
        for tail in ('menus.json', 'unknown', '../模块.json', '%2E%2E/%E6%A8%A1%E5%9D%97.json',
                     'menus/../../资料/lifestyle.json'):
            with self.subTest(tail=tail):
                status, headers, body = self.get('/api/daily-life/'+quote(tail, safe='/%'))
                self.assertEqual(status, 404)
                self.assert_json_headers(headers)
                self.assertFalse(json.loads(body)['ok'])

    def test_missing_module_is_explicit_503_without_absolute_path(self):
        hidden = self.module.with_name('暂存缺失模块')
        self.module.rename(hidden)
        try:
            for tail in ('menus', 'climate', 'lifestyle'):
                status, headers, body = self.get('/api/daily-life/'+tail)
                self.assertEqual(status, 503)
                self.assert_json_headers(headers)
                self.assertFalse(json.loads(body)['ok'])
                self.assertNotIn(str(self.root), body.decode('utf-8'))
                self.assertNotIn('FileNotFoundError', body.decode('utf-8'))
            status, headers, body = self.get('/api/daily-life/climate.js')
            self.assert_unavailable_climate_script(status, headers, body)
        finally:
            hidden.rename(self.module)

    def assert_unavailable_climate_script(self, status, headers, body):
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'application/javascript; charset=utf-8')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Cross-Origin-Resource-Policy'], 'same-origin')
        text = body.decode('ascii')
        prefix = 'window.SundollClimateConfig = null;\nwindow.SundollClimateAvailability = '
        self.assertTrue(text.startswith(prefix))
        self.assertTrue(text.endswith(';\n'))
        availability = json.loads(text[len(prefix):-2])
        self.assertFalse(availability['available'])
        self.assertIn('通用包', availability['error'])
        self.assertNotIn(str(self.root), text)
        self.assertNotIn('FileNotFoundError', text)

    def test_invalid_climate_source_returns_a_safe_unavailable_script_and_json_503(self):
        path = self.module / '资料/climate.json'
        original = path.read_bytes()
        try:
            for invalid in ('{broken-json-private-content', '{"private-body":"secret"}'):
                path.write_text(invalid, 'utf-8')
                self.assert_unavailable_climate_script(*self.get('/api/daily-life/climate.js'))
                status, headers, body = self.get('/api/daily-life/climate')
                self.assertEqual(status, 503)
                self.assert_json_headers(headers)
                self.assertFalse(json.loads(body)['ok'])
                self.assertNotIn('private-body', body.decode('utf-8'))
        finally:
            path.write_bytes(original)

    def test_legacy_static_table_and_general_directory_are_not_downloadable(self):
        for path in ('/主控台/host/fishing-tables.json', '/通用包/日常小事/资料/lifestyle.json',
                     '/../通用包/日常小事/资料/climate.json'):
            for extra_headers in ({}, {'Host': 'foreign.example:%d' % self.port}):
                with self.subTest(path=path, headers=extra_headers):
                    status, _, body = self.get(quote(path), extra_headers)
                    self.assertIn(status, (403, 404))
                    self.assertNotIn('旧文件绝不能被下载', body.decode('utf-8'))
                    self.assertNotIn('hourlyCurve', body.decode('utf-8'))


if __name__ == '__main__':
    unittest.main()
