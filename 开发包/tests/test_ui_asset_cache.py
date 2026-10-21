"""Public UI cache transport, version changes and private-file boundaries."""
from project_test_paths import APP_ROOT, CHECKOUT_ROOT
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from test_local_save_bridge import SERVER
from server.ui_assets import catalogue
from server.web_entrances import WebEntrances


class PublicArtworkHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['shared/ui-assets-cache.js', 'shared/ui-assets-sw.js']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((APP_ROOT / name).read_bytes())
        self.image = self.root / 'asset/界面/logo.png'
        self.image.parent.mkdir(parents=True)
        self.image.write_bytes(b'public-image-v1')
        private = self.root / 'asset/地图/secret.png'
        private.parent.mkdir(parents=True)
        private.write_bytes(b'private-map')
        (self.image.parent / 'linked.png').symlink_to(private)
        (self.image.parent / 'secret.json').write_text('{"private":true}')
        entrances = WebEntrances({'webEntrances': {'dmHostname': 'dm.example.com'}}, self.root)
        for name, value in dict(ROOT=str(self.root), WEB_ENTRANCES=entrances).items():
            patch = mock.patch.object(SERVER, name, value)
            patch.start(); self.addCleanup(patch.stop)
        class Quiet(SERVER.Handler):
            def log_message(self, *args): pass
        self.httpd = SERVER.Server(('127.0.0.1', 0), Quiet)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.thread.join(3)

    def get(self, url, method='GET', **headers):
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        connection.request(method, url, headers={'Host': 'dm.example.com', **headers})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_only_public_artwork_is_listed_and_served_without_dm_login(self):
        entries = catalogue(self.root)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        status, headers, body = self.get(entry['cacheUrl'])
        self.assertEqual((status, body), (200, self.image.read_bytes()))
        self.assertEqual(headers['Cache-Control'], 'public, max-age=31536000, immutable')
        self.assertNotIn('Set-Cookie', headers)
        conditional = self.get(entry['cacheUrl'], **{'If-None-Match': headers['ETag']})
        self.assertEqual((conditional[0], conditional[2]), (304, b''))
        self.assertEqual(self.get(entry['cacheUrl'], 'HEAD')[2], b'')
        for name in ['asset/地图/secret.png', 'asset/界面/linked.png', 'asset/界面/secret.json', '../secret.png']:
            from urllib.parse import quote
            self.assertEqual(self.get('/ui-assets/' + entry['digest'] + '/' + quote(name))[0], 404)

    def test_replacement_changes_url_and_cannot_poison_an_old_version(self):
        before = catalogue(self.root)[0]
        self.image.write_bytes(b'public-image-v2')
        after = catalogue(self.root)[0]
        self.assertNotEqual(before['cacheUrl'], after['cacheUrl'])
        self.assertEqual(self.get(before['cacheUrl'])[0], 404)
        self.assertEqual(self.get(after['cacheUrl'])[2], b'public-image-v2')

    def test_worker_and_registration_revalidate_and_never_include_private_data(self):
        for path in ['/ui-assets-sw.js', '/ui-assets-manifest.json', '/shared/ui-assets-cache.js']:
            status, headers, body = self.get(path)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'no-cache')
            self.assertEqual(self.get(path, **{'If-None-Match': headers['ETag']})[0], 304)
            self.assertEqual(self.get(path, 'HEAD')[2], b'')
            self.assertNotIn(b'private-map', body)
        worker = self.get('/ui-assets-sw.js')[2].decode()
        self.assertNotIn('/*__UI_ASSETS__*/', worker)
        entries = json.loads(worker.split('const UI_ASSETS = ', 1)[1].split(';', 1)[0])
        self.assertEqual(entries, catalogue(self.root))


class PublicSiteCacheBuildTests(unittest.TestCase):
    def test_pages_manifest_and_html_use_only_versioned_public_artwork(self):
        spec = importlib.util.spec_from_file_location('build_ui_cache_site', CHECKOUT_ROOT / '网站/build_site.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'public'
            module.build(CHECKOUT_ROOT / '网站/主站', output, Path(directory) / 'site.zip')
            worker = (output / 'ui-assets-sw.js').read_text()
            entries = json.loads(worker.split('const UI_ASSETS = ', 1)[1].split(';', 1)[0])
            self.assertEqual(len(entries), 5)
            for entry in entries:
                body = (output / entry['cacheUrl'].lstrip('/')).read_bytes()
                self.assertTrue(entry['cacheUrl'].startswith('/assets/'))
                self.assertEqual(hashlib.sha256(body).hexdigest(), entry['digest'])
                self.assertEqual(len(body), entry['size'])
            for page in output.rglob('*.html'):
                self.assertEqual(page.read_text().count('src="/ui-assets-cache.'), 1)
            self.assertIn('/ui-assets-sw.js\n  Cache-Control: no-cache', (output / '_headers').read_text())


if __name__ == '__main__': unittest.main()
