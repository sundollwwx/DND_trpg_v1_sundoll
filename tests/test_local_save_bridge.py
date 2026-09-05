import importlib.util
import json
import sys
import tempfile
import unittest
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
