import importlib.util
import base64
import hashlib
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = PROJECT_ROOT / '主控台' / '联机服务器.py'
SPEC = importlib.util.spec_from_file_location('sundoll_local_save_server', SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
ORIGINAL_ARGV = sys.argv[:]
try:
    sys.argv = [sys.argv[0]]
    SPEC.loader.exec_module(SERVER)
finally:
    sys.argv = ORIGINAL_ARGV


class LocalSaveBridgeTests(unittest.TestCase):
    def test_host_can_cache_one_map_for_player_background_preload(self):
        raw = b'\x89PNG\r\n\x1a\nbackground-map'
        data_url = 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')
        asset_url = '/api/assets/' + hashlib.sha256(raw).hexdigest()
        handler = mock.Mock()
        handler.path = '/api/assets/cache-map'
        handler._read_json_body.return_value = {'mapData': data_url}
        with mock.patch.object(SERVER, 'ASSETS', {}), \
                mock.patch.object(SERVER, 'is_local_request', return_value=True), \
                mock.patch.object(SERVER, 'persist_asset') as persist_asset:
            SERVER.Handler.do_POST(handler)
        handler._send_json.assert_called_once_with({'ok': True, 'mapAssetUrl': asset_url})
        persist_asset.assert_called_once_with(asset_url.rsplit('/', 1)[-1], 'image/png', raw)

        rejected = mock.Mock()
        rejected.path = '/api/assets/cache-map'
        with mock.patch.object(SERVER, 'is_local_request', return_value=False):
            SERVER.Handler.do_POST(rejected)
        rejected._send_json.assert_called_once_with(
            {'ok': False, 'error': 'map asset api is host-only'},
            403,
        )

    def test_state_upload_returns_cached_active_map_asset_url(self):
        raw = b'\x89PNG\r\n\x1a\nstream-map'
        data_url = 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')
        asset_url = '/api/assets/' + hashlib.sha256(raw).hexdigest()
        handler = mock.Mock()
        handler.path = '/api/state'
        handler._read_json_body.return_value = {
            'maps': [{'id': 'map-fast', 'mapData': data_url, 'tokens': []}],
            'activeMapId': 'map-fast',
        }
        with mock.patch.object(SERVER, 'STATE', None), \
                mock.patch.object(SERVER, 'STATE_REVISION', 0), \
                mock.patch.object(SERVER, 'RECENT_ACTIONS', []), \
                mock.patch.object(SERVER, 'ASSETS', {}), \
                mock.patch.object(SERVER, 'is_local_request', return_value=True), \
                mock.patch.object(SERVER, 'persist_asset') as persist_asset, \
                mock.patch.object(SERVER, 'broadcast') as broadcast:
            SERVER.Handler.do_POST(handler)

        response = handler._send_json.call_args.args[0]
        self.assertEqual(response['mapId'], 'map-fast')
        self.assertEqual(response['mapAssetUrl'], asset_url)
        persist_asset.assert_called_once_with(asset_url.rsplit('/', 1)[-1], 'image/png', raw)
        pushed_state = broadcast.call_args.args[0]['state']
        self.assertEqual(pushed_state['maps'][0]['mapData'], asset_url)

    def test_tunnel_public_base_only_accepts_https_origins(self):
        self.assertEqual(
            SERVER.normalize_public_base_url('https://quiet-river.trycloudflare.com/'),
            'https://quiet-river.trycloudflare.com',
        )
        self.assertEqual(SERVER.normalize_public_base_url(''), '')
        for value in (
            'http://quiet-river.trycloudflare.com',
            'https://user:pass@example.com',
            'https://example.com/path',
            'https://example.com/?query=1',
        ):
            with self.subTest(value=value):
                self.assertIsNone(SERVER.normalize_public_base_url(value))

    def test_tunnel_public_base_endpoint_is_local_host_only(self):
        handler = mock.Mock()
        handler.path = '/api/local-tunnel'
        handler._read_json_body.return_value = {
            'publicBase': 'https://quiet-river.trycloudflare.com',
        }
        old_public_base = SERVER.PUBLIC_BASE_URL
        try:
            with mock.patch.object(SERVER, 'local_save_request_allowed', return_value=True):
                SERVER.Handler.do_POST(handler)
            self.assertEqual(SERVER.PUBLIC_BASE_URL, 'https://quiet-river.trycloudflare.com')
            handler._send_json.assert_called_once_with({
                'ok': True,
                'publicBase': 'https://quiet-river.trycloudflare.com',
            })

            rejected = mock.Mock()
            rejected.path = '/api/local-tunnel'
            with mock.patch.object(SERVER, 'local_save_request_allowed', return_value=False):
                SERVER.Handler.do_POST(rejected)
            rejected._send_json.assert_called_once_with(
                {'ok': False, 'error': 'tunnel api is host-only'},
                403,
            )
        finally:
            SERVER.PUBLIC_BASE_URL = old_public_base

    def test_fixed_project_save_folder_supports_round_trip_and_listing(self):
        with tempfile.TemporaryDirectory() as temp_root:
            status = SERVER.perform_local_save_operation({'op': 'status'}, temp_root)
            self.assertEqual(status['mode'], 'local-project')
            rel_path = '战役/c1-测试/当前存档.json'
            payload = json.dumps({'campaignId': 'c1', 'state': {'maps': []}}, ensure_ascii=False)
            SERVER.perform_local_save_operation({'op': 'write', 'path': rel_path, 'text': payload}, temp_root)
            restored = SERVER.perform_local_save_operation({'op': 'read', 'path': rel_path}, temp_root)
            self.assertEqual(restored['text'], payload)
            folders = SERVER.perform_local_save_operation(
                {'op': 'list', 'path': '战役', 'kind': 'directory'}, temp_root
            )['entries']
            self.assertEqual(folders, [{'name': 'c1-测试'}])

    def test_bridge_rejects_paths_outside_save_structure(self):
        with tempfile.TemporaryDirectory() as temp_root:
            for path in ('../主控台/app.js', '/tmp/out.json', '棋子库/其他.json', '战役'):
                with self.subTest(path=path):
                    with self.assertRaises(ValueError):
                        SERVER.perform_local_save_operation(
                            {'op': 'write', 'path': path, 'text': '{}'}, temp_root
                        )

    def test_campaign_cover_supports_safe_binary_round_trip(self):
        with tempfile.TemporaryDirectory() as temp_root:
            rel_path = '战役/c1-测试/封面.webp'
            binary = b'RIFF-test-campaign-cover-WEBP'
            encoded = SERVER.base64.b64encode(binary).decode('ascii')
            written = SERVER.perform_local_save_operation(
                {'op': 'write-binary', 'path': rel_path, 'base64': encoded}, temp_root
            )
            self.assertEqual(written['size'], len(binary))
            restored = SERVER.perform_local_save_operation(
                {'op': 'read-binary', 'path': rel_path}, temp_root
            )
            self.assertEqual(restored['mime'], 'image/webp')
            self.assertEqual(SERVER.base64.b64decode(restored['base64']), binary)

    def test_binary_bridge_only_accepts_campaign_cover_images(self):
        with tempfile.TemporaryDirectory() as temp_root:
            for path in (
                '战役/c1-测试/地图.png',
                '战役/c1-测试/封面.svg',
                '战役/c1-测试/自动备份/封面.png',
                '棋子库/封面.png',
            ):
                with self.subTest(path=path):
                    with self.assertRaises(ValueError):
                        SERVER.perform_local_save_operation(
                            {'op': 'write-binary', 'path': path, 'base64': ''}, temp_root
                        )

    def test_current_campaign_cover_becomes_public_hashed_asset(self):
        with tempfile.TemporaryDirectory() as temp_root:
            old_save_root = SERVER.LOCAL_SAVE_ROOT
            old_asset_root = SERVER.ASSET_ROOT
            try:
                save_root = Path(temp_root) / '存档'
                campaign_root = save_root / '战役' / 'c1-明亮冒险'
                campaign_root.mkdir(parents=True)
                (campaign_root / '封面.jpg').write_bytes(b'\xff\xd8\xfftest-cover')
                (save_root / '存档索引.json').write_text(json.dumps({
                    'campaigns': [{
                        'id': 'c1',
                        'name': '明亮冒险',
                        'folder': 'c1-明亮冒险',
                        'cover': '封面.jpg',
                    }],
                }, ensure_ascii=False), encoding='utf-8')
                SERVER.LOCAL_SAVE_ROOT = str(save_root)
                SERVER.ASSET_ROOT = str(Path(temp_root) / '联机资源')
                SERVER.CAMPAIGN_COVER_ASSET_CACHE.clear()
                url = SERVER.campaign_cover_asset_url({
                    'campaignId': 'c1',
                    'campaignName': '明亮冒险',
                })
                self.assertRegex(url, r'^/api/assets/[0-9a-f]{64}$')
                self.assertTrue(Path(SERVER.ASSET_ROOT, url.rsplit('/', 1)[-1]).is_file())
            finally:
                SERVER.LOCAL_SAVE_ROOT = old_save_root
                SERVER.ASSET_ROOT = old_asset_root
                SERVER.CAMPAIGN_COVER_ASSET_CACHE.clear()

    def test_bridge_requires_local_host_and_private_header(self):
        valid = SimpleNamespace(
            client_address=('127.0.0.1', 50000),
            headers={
                'Host': '127.0.0.1:%d' % SERVER.PORT,
                'Origin': 'http://127.0.0.1:%d' % SERVER.PORT,
                SERVER.LOCAL_SAVE_HEADER: '1',
            },
        )
        self.assertTrue(SERVER.local_save_request_allowed(valid))
        missing_header = SimpleNamespace(
            client_address=valid.client_address,
            headers={'Host': valid.headers['Host'], 'Origin': valid.headers['Origin']},
        )
        self.assertFalse(SERVER.local_save_request_allowed(missing_header))
        tunnel = SimpleNamespace(
            client_address=('127.0.0.1', 50000),
            headers={
                'Host': 'example.trycloudflare.com',
                'Origin': 'https://example.trycloudflare.com',
                SERVER.LOCAL_SAVE_HEADER: '1',
            },
        )
        self.assertFalse(SERVER.local_save_request_allowed(tunnel))


if __name__ == '__main__':
    unittest.main()
