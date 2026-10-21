"""Fixed domains must reach this room before they replace its invitation."""
from project_test_paths import APP_ROOT
import io
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import launch_sundoll as launcher
from test_local_save_bridge import SERVER


class FixedTunnelTests(unittest.TestCase):
    base = 'https://sundollworld.com'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        self.settings = folder / 'network.json'
        self.token_file = folder / 'connector-token'
        self.token_file.write_text('private-test-token')
        self.settings.write_text(json.dumps({'cloudflareTunnel': {
            'hostname': 'sundollworld.com', 'tokenFile': str(self.token_file), 'port': 8090,
        }}))
        patcher = mock.patch.object(launcher, 'NETWORK_SETTINGS', self.settings)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ('existing_connector', 'process_marker'):
            patcher = mock.patch.object(launcher, name, return_value=None)
            patcher.start(); self.addCleanup(patcher.stop)
        self.info = dict(projectId='project', sessionId='session', roomCode='ROOM',
                         protocolVersion=launcher.SERVER_PROTOCOL_VERSION, port=8090, ips=[])

    def test_named_hostname_must_match_the_current_session(self):
        info = dict(self.info, publicBase=self.base)
        def response(payload):
            stream = io.BytesIO(json.dumps(payload).encode())
            return mock.MagicMock(__enter__=lambda _: stream, __exit__=lambda *_: False)
        for remote, expected in [(info, self.base), (dict(info, sessionId='another'), '')]:
            with mock.patch.object(launcher.urllib.request, 'urlopen', return_value=response(remote)):
                self.assertEqual(launcher.live_tunnel_base(info, expected_base=self.base), expected)
        with mock.patch.object(launcher.urllib.request, 'urlopen') as fetch:
            self.assertEqual(launcher.live_tunnel_base(dict(info, publicBase='https://other.test'),
                                                      expected_base=self.base), '')
            fetch.assert_not_called()

    def test_hostnames_do_not_accept_paths_credentials_ports_or_invalid_labels(self):
        for hostname in ['https://sundollworld.com', 'user@sundollworld.com',
                         'sundollworld.com/path', 'sundollworld.com:8090', '-bad.com', 'bad-.com']:
            self.settings.write_text(json.dumps({'cloudflareTunnel': {'hostname': hostname}}))
            with self.assertRaises(ValueError):
                launcher.fixed_tunnel_settings()

    def run_connector(self, lines, verify, combined=False):
        tunnel = mock.Mock(stdout=iter(lines))
        tunnel.wait.return_value = tunnel.poll.return_value = 0
        with mock.patch.object(launcher, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, self.info, 8090)), \
                mock.patch.object(launcher, 'server_info', return_value=self.info), \
                mock.patch.object(launcher, 'live_tunnel_base', side_effect=verify), \
                mock.patch.object(launcher, 'tunnel_output', return_value=iter(lines)), \
                mock.patch.object(launcher.subprocess, 'Popen', return_value=tunnel) as spawn, \
                mock.patch.object(launcher, 'open_host_console'), \
                mock.patch.object(launcher, 'publish_tunnel_base', return_value=True) as publish, \
                mock.patch.object(launcher.time, 'monotonic', side_effect=[0, 10, 20, 30]):
            self.assertEqual(launcher.run_tunnel(8090, combined=combined), 0)
        return spawn, publish

    def test_connector_reads_token_file_without_putting_secret_in_arguments(self):
        spawn, publish = self.run_connector(['Registered tunnel connection\n'], ['', self.base])
        command = spawn.call_args.args[0]
        self.assertIn('--token-file', command)
        self.assertIn(str(self.token_file), command)
        self.assertNotIn('private-test-token', ' '.join(command))
        publish.assert_called_once_with(8090, self.base)

    def test_connected_but_unreachable_domain_is_not_published(self):
        _, publish = self.run_connector(['Registered tunnel connection\n'], ['', ''])
        publish.assert_not_called()

    def test_quiet_connector_can_retry_when_dns_becomes_ready(self):
        _, publish = self.run_connector(['Registered tunnel connection\n', ''], ['', '', self.base])
        publish.assert_called_once_with(8090, self.base)

    def test_unregistered_connector_is_not_published(self):
        _, publish = self.run_connector(['starting connector\n'], [''])
        publish.assert_not_called()

    def test_stale_fixed_invitation_is_cleared_before_an_unconnected_retry(self):
        self.info['publicBase'] = self.base
        _, publish = self.run_connector(['starting connector\n'], [''])
        publish.assert_called_once_with(8090, '')

    def test_mismatched_origin_port_and_missing_token_do_not_start_a_server(self):
        with mock.patch.object(launcher, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(launcher, 'prepare_server') as prepare:
            with self.assertRaises(RuntimeError):
                launcher.run_tunnel(8091)
            self.token_file.unlink()
            with self.assertRaises(RuntimeError):
                launcher.run_tunnel(8090)
            prepare.assert_not_called()

    def test_healthy_fixed_domain_is_reused_without_starting_another_connector(self):
        spawn, publish = self.run_connector([], [self.base])
        spawn.assert_not_called()
        publish.assert_not_called()


class PublicLandingTests(unittest.TestCase):
    def setUp(self):
        # These legacy domain checks must not inherit this computer's main/DM routes.
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        from server.web_entrances import WebEntrances
        patcher = mock.patch.object(SERVER, 'WEB_ENTRANCES', WebEntrances({}, temporary.name))
        patcher.start()
        self.addCleanup(patcher.stop)

        for name, value in [('ACCOUNT_SETTINGS', {'enabled': False, 'roomsEnabled': False}),
                            ('LOCAL_SAVE_ROOT', temporary.name)]:
            patcher = mock.patch.object(SERVER, name, value)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_http_domain_root_player_page_and_host_boundary(self):
        httpd = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with mock.patch.object(SERVER, 'PORT', httpd.server_port):
                for path, host, status in [
                    ('/', 'sundollworld.com', 302),
                    (launcher.quote(launcher.PLAYER_ROUTE, safe='/'), 'sundollworld.com', 200),
                    (launcher.quote(launcher.HOST_ROUTE, safe='/'), 'sundollworld.com', 404),
                    ('/', '127.0.0.1:%d' % httpd.server_port, 200),
                ]:
                    connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=3)
                    try:
                        connection.request('GET', path, headers={'Host': host})
                        response = connection.getresponse()
                        body = response.read()
                        self.assertEqual(response.status, status, (path, host))
                        if status == 302:
                            self.assertEqual(response.getheader('Location'), launcher.quote(launcher.PLAYER_ROUTE, safe='/'))
                        if host == 'sundollworld.com':
                            self.assertNotIn(b'http://localhost:', body)
                    finally:
                        connection.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(3)

    def handler(self, host, path='/'):
        handler = mock.Mock(spec=SERVER.Handler)
        handler.path = path
        handler.client_address = ('127.0.0.1', 50000)
        handler.headers = {'Host': host}
        handler.wfile = io.BytesIO()
        return handler

    def test_public_domain_root_enters_player_page_without_local_links(self):
        for path in ['/', '/index.html', '/?anything=1']:
            handler = self.handler('sundollworld.com', path)
            SERVER.Handler.do_GET(handler)
            handler.send_response.assert_called_once_with(302)
            handler.send_header.assert_any_call('Location', launcher.quote(launcher.PLAYER_ROUTE, safe='/'))
            self.assertEqual(handler.wfile.getvalue(), b'')

    def test_local_host_landing_remains_available(self):
        handler = self.handler('127.0.0.1:8090')
        with mock.patch.object(SERVER, 'PORT', 8090):
            SERVER.Handler.do_GET(handler)
        handler.send_response.assert_called_once_with(200)
        self.assertIn('localhost:8090'.encode(), handler.wfile.getvalue())

    def test_public_hostname_is_not_a_host_even_when_tunnel_connects_over_loopback(self):
        self.assertFalse(SERVER.host_request_allowed(self.handler('sundollworld.com')))


if __name__ == '__main__':
    unittest.main()
