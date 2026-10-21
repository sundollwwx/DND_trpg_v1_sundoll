from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = APP_ROOT
LAUNCHER_PATH = PROJECT_ROOT / 'launch_sundoll.py'
SERVER_PATH = PROJECT_ROOT / 'server' / 'http_app.py'
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

    def read(self, _size=None):
        return json.dumps(self.payload).encode('utf-8')


class FakeTunnelProcess:
    def __init__(self, lines):
        self.stdout = iter(lines)
        self.pid = 123456

    def wait(self, timeout=None):
        return 0

    def poll(self):
        return 0


class LauncherProtocolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        for name, value in [('NETWORK_SETTINGS', Path(temporary.name) / 'network.json')]:
            patcher = mock.patch.object(LAUNCHER, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        for name in ('existing_connector', 'process_marker'):
            patcher = mock.patch.object(LAUNCHER, name, return_value=None)
            patcher.start(); self.addCleanup(patcher.stop)
        # Quick Tunnel tests must not depend on this host's deployed domain.
        settings = mock.patch.object(LAUNCHER, 'network_settings', return_value={})
        settings.start()
        self.addCleanup(settings.stop)

    def test_background_map_preload_requires_protocol_nineteen(self):
        from server.runtime_config import protocol_version
        self.assertEqual(LAUNCHER.SERVER_PROTOCOL_VERSION, protocol_version())

    def response(self, protocol=None):
        payload = {'name': LAUNCHER.SERVER_NAME, 'port': 8090, 'projectId': LAUNCHER.SERVER_PROJECT_ID}
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

    def test_existing_tunnel_is_reused_only_for_this_live_room(self):
        base = 'https://quiet-river.trycloudflare.com'
        info = {'projectId': 'project', 'sessionId': 'session', 'roomCode': 'ABC',
                'protocolVersion': LAUNCHER.SERVER_PROTOCOL_VERSION,
                'publicBase': base, 'ips': ['192.168.1.20']}
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=FakeResponse(dict(info))) as remote:
            self.assertEqual(LAUNCHER.live_tunnel_base(info), base)
        request = remote.call_args.args[0]
        self.assertEqual(request.full_url, base + '/api/info')
        self.assertEqual(request.get_header('User-agent'), 'SundollLauncher/1.1')
        self.assertEqual(remote.call_args.kwargs, {'timeout': 1.5})
        changed = dict(info, roomCode='DIFFERENT')
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=FakeResponse(changed)):
            self.assertEqual(LAUNCHER.live_tunnel_base(info), '')
        info['publicBase'] = 'https://different.example.com'
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen') as remote:
            self.assertEqual(LAUNCHER.live_tunnel_base(info), '')
            remote.assert_not_called()

    def test_email_spaces_probe_safe_service_identity_and_reject_another_process(self):
        base = 'https://quiet-river.trycloudflare.com'
        info = {'projectId': 'project', 'sessionId': 'session', 'roomCode': 'ABC',
                'protocolVersion': LAUNCHER.SERVER_PROTOCOL_VERSION,
                'publicBase': base, 'endpoints': {'serviceInfo': '/api/service-info'}}
        identity = {k:info[k] for k in ('projectId','sessionId','protocolVersion')}
        with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=FakeResponse(dict(identity,ok=True))) as remote:
            self.assertEqual(LAUNCHER.live_tunnel_base(info), base)
        self.assertEqual(remote.call_args.args[0].full_url, base + '/api/service-info')
        for key in ('projectId','sessionId','protocolVersion'):
            with self.subTest(key=key):
                changed = dict(identity, **{key:'different'})
                with mock.patch.object(LAUNCHER.urllib.request, 'urlopen', return_value=FakeResponse(changed)):
                    self.assertEqual(LAUNCHER.live_tunnel_base(info), '')

    def test_reopening_launcher_does_not_replace_healthy_tunnel(self):
        base = 'https://quiet-river.trycloudflare.com'
        info = {'roomCode': 'ABC', 'ips': ['192.168.1.20'], 'port': 8090, 'publicBase': base}
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(LAUNCHER, 'live_tunnel_base', return_value=base), \
                mock.patch.object(LAUNCHER.subprocess, 'Popen') as spawn, \
                mock.patch.object(LAUNCHER, 'publish_tunnel_base') as publish, \
                mock.patch.object(LAUNCHER, 'open_host_console') as open_console:
            self.assertEqual(LAUNCHER.run_tunnel(8090, combined=True), 0)
        spawn.assert_not_called()
        publish.assert_not_called()
        open_console.assert_called_once_with(
            LAUNCHER.host_console_url(LAUNCHER.page_url('127.0.0.1', 8090, LAUNCHER.HOST_ROUTE), base), False)

    def test_launcher_publishes_tunnel_base_through_host_only_endpoint(self):
        with mock.patch.object(
            LAUNCHER.LOCAL_URL_OPENER,
            'open',
            side_effect=[FakeResponse({'ok': True, 'epoch': 'restored-workspace'}), FakeResponse({'ok': True})],
        ) as direct_open:
            self.assertTrue(LAUNCHER.publish_tunnel_base(
                8090,
                'https://quiet-river.trycloudflare.com',
            ))
        request = direct_open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:8090/api/local-tunnel')
        self.assertEqual(request.get_header('X-sundoll-local-save'), '1')
        self.assertEqual(request.get_header('X-sundoll-workspace'), 'restored-workspace')
        self.assertEqual(direct_open.call_args_list[0].args[0], 'http://127.0.0.1:8090/api/workspace-epoch')
        self.assertEqual(
            json.loads(request.data.decode('utf-8')),
            {'publicBase': 'https://quiet-river.trycloudflare.com'},
        )

    def test_tunnel_publication_stops_if_workspace_cannot_be_checked(self):
        with mock.patch.object(LAUNCHER.LOCAL_URL_OPENER, 'open', side_effect=OSError('unavailable')) as direct_open:
            self.assertFalse(LAUNCHER.publish_tunnel_base(8090, 'https://quiet-river.trycloudflare.com'))
        self.assertEqual(direct_open.call_count, 1)

    def test_local_host_console_url_remains_unchanged(self):
        host_url = 'http://127.0.0.1:8090/主控台/主控台.html'
        self.assertEqual(LAUNCHER.host_console_url(host_url), host_url)

    def test_tunnel_opens_local_console_with_public_invite_base(self):
        info = {'projectId':'isolated-project', 'sessionId':'isolated-session',
                'roomCode': 'ABC123', 'ips': ['192.168.1.20'], 'port': 8090}
        tunnel = FakeTunnelProcess([
            'INF Your quick Tunnel has been created! https://quiet-river.trycloudflare.com\n',
            'INF Registered tunnel connection protocol=http2\n'
        ])
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='/tmp/cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(LAUNCHER, 'server_info', return_value=dict(info, publicBase='https://quiet-river.trycloudflare.com')), \
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

    def test_unconnected_tunnel_never_publishes_invitation(self):
        tunnel = FakeTunnelProcess(['https://unconnected.trycloudflare.com\n'])
        info = {'roomCode': 'ABC', 'ips': [], 'port': 8090}
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(LAUNCHER.subprocess, 'Popen', return_value=tunnel) as spawn, \
                mock.patch.object(LAUNCHER, 'publish_tunnel_base') as publish, \
                mock.patch.object(LAUNCHER, 'open_host_console'):
            LAUNCHER.run_tunnel(8090)
        publish.assert_not_called()

    def test_default_start_has_no_interactive_prompt(self):
        with mock.patch.object(LAUNCHER.sys, 'argv', ['launch_sundoll.py']), \
                mock.patch.object(LAUNCHER, 'tunnel_provider', return_value='cloudflare'), \
                mock.patch('builtins.input', side_effect=AssertionError('unexpected prompt')), \
                mock.patch.object(LAUNCHER, 'run_tunnel', return_value=0) as start:
            self.assertEqual(LAUNCHER.main(), 0)
        start.assert_called_once_with(8090, False, False, combined=True)

    def test_local_only_never_opens_public_tunnel(self):
        with mock.patch.object(LAUNCHER.sys, 'argv', ['launch_sundoll.py', '--local-only']), \
                mock.patch.object(LAUNCHER, 'run_local', return_value=0) as local, \
                mock.patch.object(LAUNCHER, 'run_tunnel') as tunnel:
            self.assertEqual(LAUNCHER.main(), 0)
        local.assert_called_once_with(8090, False, True)
        tunnel.assert_not_called()

    def test_missing_cloudflared_falls_back_to_local(self):
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value=None), \
                mock.patch.object(LAUNCHER, 'run_local', return_value=0) as local:
            self.assertEqual(LAUNCHER.run_tunnel(8090, combined=True), 0)
        local.assert_called_once_with(8090, False, False)

    def test_combined_start_opens_console_before_tunnel_and_keeps_local_alive(self):
        events = []
        server = mock.Mock()
        server.wait.side_effect = lambda: events.append('local wait') or 0
        tunnel = FakeTunnelProcess(['https://quiet-river.trycloudflare.com\n','INF Registered tunnel connection protocol=http2\n'])
        info = {'roomCode': 'ABC', 'ips': [], 'port': 8090}
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(server, info, 8090)), \
                mock.patch.object(LAUNCHER, 'open_host_console', side_effect=lambda *_: events.append('console')) as console, \
                mock.patch.object(LAUNCHER.subprocess, 'Popen', side_effect=lambda *a, **kw: events.append('tunnel') or tunnel), \
                mock.patch.object(LAUNCHER, 'publish_tunnel_base') as publish, \
                mock.patch.object(LAUNCHER, 'stop_process') as stop:
            self.assertEqual(LAUNCHER.run_tunnel(8090, combined=True), 0)
        self.assertEqual(events, ['console', 'tunnel', 'local wait'])
        console.assert_called_once()
        self.assertIn(mock.call(8090, 'https://quiet-river.trycloudflare.com'), publish.call_args_list)
        self.assertIn(mock.call(server, timeout=LAUNCHER.SERVER_SHUTDOWN_TIMEOUT), stop.call_args_list)

    def test_tunnel_spawn_failure_still_waits_for_local_server(self):
        server = mock.Mock()
        server.wait.return_value = 0
        with mock.patch.object(LAUNCHER, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(LAUNCHER, 'prepare_server', return_value=(server, {'ips': []}, 8090)), \
                mock.patch.object(LAUNCHER, 'open_host_console'), \
                mock.patch.object(LAUNCHER.subprocess, 'Popen', side_effect=OSError('unavailable')), \
                mock.patch.object(LAUNCHER, 'publish_tunnel_base'), \
                mock.patch.object(LAUNCHER, 'stop_process'):
            self.assertEqual(LAUNCHER.run_tunnel(8090, combined=True), 0)
        server.wait.assert_called_once()

    def test_protocol_marker_is_shared_by_server_launcher_and_player(self):
        server_source = SERVER_PATH.read_text(encoding='utf-8')
        player_source = PLAYER_PATH.read_text(encoding='utf-8')
        self.assertIn('SERVER_PROTOCOL_VERSION = protocol_version()', server_source)
        self.assertIn('p.protocolVersion = SundollProtocol.version;', (PROJECT_ROOT/'主控台/host/app.js').read_text(encoding='utf-8'))
        self.assertIn("'protocolVersion': SERVER_PROTOCOL_VERSION", server_source)
        self.assertIn('REQUIRED_SERVER_PROTOCOL=SundollProtocol.version', (PROJECT_ROOT/'主控台/player/player.js').read_text(encoding='utf-8'))
        for entry in ['主控台.html','玩家.html']:
            self.assertIn('../shared/protocol.js', (PROJECT_ROOT/'主控台'/entry).read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()


class LauncherProjectIsolationTests(unittest.TestCase):
    def test_same_project_upgrade_gives_version_and_safe_restart_steps(self):
        message = LAUNCHER.incompatible_server_message(8090, {
            'projectId': LAUNCHER.SERVER_PROJECT_ID,
            'protocolVersion': LAUNCHER.SERVER_PROTOCOL_VERSION - 1,
        })
        self.assertIn('运行协议 %s' % (LAUNCHER.SERVER_PROTOCOL_VERSION - 1), message)
        self.assertIn('当前需要 %s' % LAUNCHER.SERVER_PROTOCOL_VERSION, message)
        self.assertIn('保存战役', message)
        self.assertIn('Ctrl+C', message)
        self.assertNotIn('另一份项目', message)

    def test_diagnostics_does_not_claim_it_will_avoid_old_server(self):
        with mock.patch.object(LAUNCHER, 'raw_server_info', return_value={'projectId': 'other'}), \
                mock.patch.object(LAUNCHER, 'find_cloudflared', return_value=None), \
                mock.patch('builtins.print') as output:
            LAUNCHER.diagnostics(8090)
        printed = '\n'.join(str(call.args[0]) for call in output.call_args_list)
        self.assertIn('另一份项目', printed)
        self.assertNotIn('自动避开', printed)

    def test_same_protocol_other_project_is_not_reused(self):
        self.assertFalse(LAUNCHER.compatible_server_info({'protocolVersion':LAUNCHER.SERVER_PROTOCOL_VERSION,'projectId':'other'}))
        self.assertFalse(LAUNCHER.compatible_server_info({'protocolVersion':LAUNCHER.SERVER_PROTOCOL_VERSION}))
        self.assertTrue(LAUNCHER.compatible_server_info({'protocolVersion':LAUNCHER.SERVER_PROTOCOL_VERSION,'projectId':LAUNCHER.SERVER_PROJECT_ID}))
    def test_old_server_stops_launch_instead_of_starting_another(self):
        with mock.patch.object(LAUNCHER,'raw_server_info',return_value={'protocolVersion':22}),mock.patch.object(LAUNCHER,'port_is_open') as probe:
            with self.assertRaises(RuntimeError): LAUNCHER.select_port(8090)
            probe.assert_not_called()
