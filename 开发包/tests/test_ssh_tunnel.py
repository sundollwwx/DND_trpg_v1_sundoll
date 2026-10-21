from project_test_paths import APP_ROOT
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import launch_sundoll as launcher
from server import ssh_tunnel


class SshTunnelTests(unittest.TestCase):
    def event(self, **changes):
        data = dict(event='tcpip-forward', status='success', type='opened',
                    address='abc123.lhr.life', tls_termination=True)
        data.update(changes)
        return json.dumps(data)

    def test_only_successful_https_domain_events_are_used(self):
        self.assertEqual(ssh_tunnel.opened_address(self.event()), 'https://abc123.lhr.life')
        for line in ['welcome https://evil.test', '[]', self.event(status='denied'),
                     self.event(tls_termination=False), self.event(address='abc.lhr.life.evil.test'),
                     self.event(address='abc.lhr.life/path'), self.event(type='closed')]:
            self.assertEqual(ssh_tunnel.opened_address(line), '')

    def test_ssh_does_not_use_personal_keys_and_preserves_host_verification(self):
        args = ssh_tunnel.command('/usr/bin/ssh', 8090, Path('/tmp/known_hosts'))
        for value in ['IdentityAgent=none', 'IdentityFile=none', 'IdentitiesOnly=yes',
                      'StrictHostKeyChecking=accept-new', '80:127.0.0.1:8090']:
            self.assertIn(value, args)
        self.assertNotIn('StrictHostKeyChecking=no', args)

    def test_unreachable_or_wrong_room_is_never_published(self):
        api = mock.Mock()
        api.server_info.return_value = {'sessionId': 'local'}
        api.live_tunnel_base.return_value = ''
        self.assertFalse(ssh_tunnel.verify_and_publish(api, 8090, 'https://abc.lhr.life'))
        api.publish_tunnel_base.assert_not_called()
        api.live_tunnel_base.return_value = 'https://abc.lhr.life'
        api.publish_tunnel_base.return_value = True
        self.assertTrue(ssh_tunnel.verify_and_publish(api, 8090, 'https://abc.lhr.life'))

    def test_stopping_old_worker_does_not_clear_a_new_invitation(self):
        api = mock.Mock()
        api.server_info.return_value = {'publicBase': 'https://new.lhr.life'}
        ssh_tunnel.clear_owned(api, 8090, 'https://old.lhr.life')
        api.publish_tunnel_base.assert_not_called()
        ssh_tunnel.clear_owned(api, 8090, 'https://new.lhr.life')
        api.publish_tunnel_base.assert_called_once_with(8090, '', timeout=3)

    def test_free_domain_reuse_checks_service_identity(self):
        info = dict(publicBase='https://abc.lhr.life', projectId='p', sessionId='s', roomCode='r', protocolVersion=34)
        def response(value):
            return mock.MagicMock(__enter__=lambda _:io.BytesIO(json.dumps(value).encode()), __exit__=lambda *_:False)
        with mock.patch.object(launcher.urllib.request, 'urlopen', return_value=response(info)):
            self.assertEqual(launcher.live_tunnel_base(info), info['publicBase'])
        with mock.patch.object(launcher.urllib.request, 'urlopen', return_value=response(dict(info,sessionId='wrong'))):
            self.assertEqual(launcher.live_tunnel_base(info), '')

    def test_provider_selection_and_local_only(self):
        with tempfile.TemporaryDirectory() as folder:
            settings=Path(folder)/'network.json';settings.write_text('{"tunnelProvider":"localhost-run"}')
            with mock.patch.object(launcher, 'NETWORK_SETTINGS', settings), \
                    mock.patch.object(launcher, 'existing_connector', return_value=None), \
                    mock.patch.object(launcher, 'server_info', return_value=None), \
                    mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py']), \
                    mock.patch.object(ssh_tunnel, 'run', return_value=0) as run:
                self.assertEqual(launcher.main(), 0)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[1:], (8090, False))
            with mock.patch.object(launcher, 'NETWORK_SETTINGS', settings), \
                    mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py', '--local-only']), \
                    mock.patch.object(ssh_tunnel, 'run') as run, mock.patch.object(launcher,'run_local',return_value=0):
                self.assertEqual(launcher.main(), 0)
                run.assert_not_called()

    def test_failed_connection_retries_are_bounded_and_keep_existing_server(self):
        with tempfile.TemporaryDirectory() as folder:
            api = mock.Mock(USER_DATA_ROOT=Path(folder))
            api.prepare_server.return_value = (None, {}, 8090)
            api.show_connection_info.return_value = ('http://127.0.0.1:8090', '')
            api.live_tunnel_base.return_value = ''
            process = mock.Mock(stdout=io.StringIO('connection failed\n'))
            with mock.patch.object(ssh_tunnel.shutil,'which',return_value='/usr/bin/ssh'), \
                    mock.patch.object(ssh_tunnel.subprocess,'Popen',return_value=process) as spawn, \
                    mock.patch.object(ssh_tunnel,'events',return_value=[]), \
                    mock.patch.object(ssh_tunnel.time,'sleep'):
                ssh_tunnel.run(api, 8090, True)
            self.assertEqual(spawn.call_count, 5)
            api.wait_local_server.assert_called_once_with(None)
