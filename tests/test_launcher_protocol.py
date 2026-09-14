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


class FakeTunnelProcess:
    def __init__(self, lines):
        self.stdout = iter(lines)

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0


class LauncherProtocolTests(unittest.TestCase):
    def test_background_map_preload_requires_protocol_nineteen(self):
        self.assertEqual(LAUNCHER.SERVER_PROTOCOL_VERSION, 19)

    def response(self, protocol=None):
        payload = {'name': LAUNCHER.SERVER_NAME, 'port': 8090}
        if protocol is not None:
            payload['protocolVersion'] = protocol
        return FakeResponse(payload)

    def test_only_current_protocol_server_is_reused(self):
        with mock.patch.object(LAUNCHER.LOCAL_URL_OPENER, 'open', return_value=self.response()):
            self.assertIsNone(LAUNCHER.server_info(8090))
        with mock.patch.object(
            LAUNCHER.LOCAL_URL_OPENER,
            'open',
            return_value=self.response(LAUNCHER.SERVER_PROTOCOL_VERSION - 1),
        ):
            self.assertIsNone(LAUNCHER.server_info(8090))
        with mock.patch.object(
            LAUNCHER.LOCAL_URL_OPENER,
            'open',
            return_value=self.response(LAUNCHER.SERVER_PROTOCOL_VERSION),
        ):
            self.assertEqual(LAUNCHER.server_info(8090)['protocolVersion'], LAUNCHER.SERVER_PROTOCOL_VERSION)

    def test_previous_brand_name_remains_reusable_during_upgrade(self):
        response = self.response(LAUNCHER.SERVER_PROTOCOL_VERSION)
        response.payload['name'] = '桑哆尔联机'
        with mock.patch.object(LAUNCHER.LOCAL_URL_OPENER, 'open', return_value=response):
            self.assertEqual(LAUNCHER.server_info(8090)['protocolVersion'], LAUNCHER.SERVER_PROTOCOL_VERSION)

    def test_local_probe_never_uses_system_proxy_urlopen(self):
        response = self.response(LAUNCHER.SERVER_PROTOCOL_VERSION)
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', side_effect=AssertionError('system proxy used')), \
                mock.patch.object(LAUNCHER.LOCAL_URL_OPENER, 'open', return_value=response) as direct_open:
            self.assertEqual(LAUNCHER.server_info(8090)['protocolVersion'], LAUNCHER.SERVER_PROTOCOL_VERSION)
        direct_open.assert_called_once_with('http://127.0.0.1:8090/api/info', timeout=0.45)

    def test_tunnel_public_base_is_passed_to_local_host_console(self):
        host_url = 'http://127.0.0.1:8090/主控台/主控台.html'
        actual = LAUNCHER.host_console_url(host_url, 'https://quiet-river.trycloudflare.com/')
        self.assertEqual(
            actual,
            host_url + '?public=https%3A%2F%2Fquiet-river.trycloudflare.com',
        )

    def test_launcher_publishes_tunnel_base_through_host_only_endpoint(self):
        with mock.patch.object(
            LAUNCHER.LOCAL_URL_OPENER,
            'open',
            return_value=FakeResponse({'ok': True}),
        ) as direct_open:
            self.assertTrue(LAUNCHER.publish_tunnel_base(
                8090,
                'https://quiet-river.trycloudflare.com',
            ))
        request = direct_open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8090/api/local-tunnel')
        self.assertEqual(request.get_header('X-sundoll-local-save'), '1')
        self.assertEqual(
            json.loads(request.data.decode('utf-8')),
            {'publicBase': 'https://quiet-river.trycloudflare.com'},
        )

    def test_local_host_console_url_remains_unchanged(self):
        host_url = 'http://127.0.0.1:8090/主控台/主控台.html'
        self.assertEqual(LAUNCHER.host_console_url(host_url), host_url)

    def test_tunnel_opens_local_console_with_public_invite_base(self):
        info = {'roomCode': 'ABC123', 'ips': ['192.168.1.20'], 'port': 8090}
        tunnel = FakeTunnelProcess([
            'INF Your quick Tunnel has been created! https://quiet-river.trycloudflare.com\n'
        ])
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='/tmp/cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(LAUNCHER.subprocess, 'Popen', return_value=tunnel), \
                mock.patch.object(LAUNCHER, 'publish_tunnel_base') as publish_base, \
                mock.patch.object(LAUNCHER, 'open_host_console') as open_console:
            self.assertEqual(LAUNCHER.run_tunnel(8090), 0)
        self.assertEqual(
            publish_base.call_args_list,
            [mock.call(8090, 'https://quiet-river.trycloudflare.com'), mock.call(8090, '')],
        )
        open_console.assert_called_once_with(
            LAUNCHER.page_url('127.0.0.1', 8090, LAUNCHER.HOST_ROUTE)
            + '?public=https%3A%2F%2Fquiet-river.trycloudflare.com',
            False,
        )

    def test_protocol_marker_is_shared_by_server_launcher_and_player(self):
        server_source = SERVER_PATH.read_text(encoding='utf-8')
        player_source = PLAYER_PATH.read_text(encoding='utf-8')
        marker = 'SERVER_PROTOCOL_VERSION = %d' % LAUNCHER.SERVER_PROTOCOL_VERSION
        self.assertIn(marker, server_source)
        self.assertIn("'protocolVersion': SERVER_PROTOCOL_VERSION", server_source)
        self.assertIn('REQUIRED_SERVER_PROTOCOL=%d' % LAUNCHER.SERVER_PROTOCOL_VERSION, player_source)


if __name__ == '__main__':
    unittest.main()
