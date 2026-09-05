import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER_PATH = PROJECT_ROOT / 'launch_sundoll.py'
SERVER_PATH = PROJECT_ROOT / '主控台' / '联机服务器.py'
PLAYER_PATH = PROJECT_ROOT / '主控台' / '玩家.html'
SPEC = importlib.util.spec_from_file_location('sundoll_launcher', LAUNCHER_PATH)
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode('utf-8')


class LauncherProtocolTests(unittest.TestCase):
    def response(self, protocol=None):
        payload = {'name': LAUNCHER.SERVER_NAME, 'port': 8090}
        if protocol is not None:
            payload['protocolVersion'] = protocol
        return FakeResponse(payload)

    def test_only_current_protocol_server_is_reused(self):
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=self.response()):
            self.assertIsNone(LAUNCHER.server_info(8090))
        with mock.patch.object(
            LAUNCHER.urllib.request,
            'urlopen',
            return_value=self.response(LAUNCHER.SERVER_PROTOCOL_VERSION),
        ):
            self.assertEqual(LAUNCHER.server_info(8090)['protocolVersion'], LAUNCHER.SERVER_PROTOCOL_VERSION)

    def test_previous_brand_name_remains_reusable_during_upgrade(self):
        response = self.response(LAUNCHER.SERVER_PROTOCOL_VERSION)
        response.payload['name'] = '桑哆尔联机'
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=response):
            self.assertEqual(LAUNCHER.server_info(8090)['protocolVersion'], LAUNCHER.SERVER_PROTOCOL_VERSION)

    def test_protocol_marker_is_shared_by_server_launcher_and_player(self):
        server_source = SERVER_PATH.read_text(encoding='utf-8')
        player_source = PLAYER_PATH.read_text(encoding='utf-8')
        marker = 'SERVER_PROTOCOL_VERSION = %d' % LAUNCHER.SERVER_PROTOCOL_VERSION
        self.assertIn(marker, server_source)
        self.assertIn("'protocolVersion': SERVER_PROTOCOL_VERSION", server_source)
        self.assertIn('REQUIRED_SERVER_PROTOCOL=%d' % LAUNCHER.SERVER_PROTOCOL_VERSION, player_source)


if __name__ == '__main__':
    unittest.main()
