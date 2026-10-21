"""Browser preferences apply to every launcher path without starting services."""
from project_test_paths import APP_ROOT
import launch_sundoll as launcher
import unittest
import tempfile
from pathlib import Path
from unittest import mock


class LauncherBrowserTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patcher = mock.patch.object(launcher, 'NETWORK_SETTINGS', Path(temporary.name) / 'network.json')
        patcher.start(); self.addCleanup(patcher.stop)
        settings = mock.patch.object(launcher, 'network_settings', return_value={})
        self.settings = settings.start()
        self.addCleanup(settings.stop)

    def test_only_boolean_false_disables_browser_by_default(self):
        cases = [
            ({}, False),
            ({'launcher': None}, False),
            ({'launcher': {}}, False),
            ({'launcher': {'openBrowser': True}}, False),
            ({'launcher': {'openBrowser': 0}}, False),
            ({'launcher': {'openBrowser': 'false'}}, False),
            ({'launcher': {'openBrowser': False}}, True),
        ]
        for settings, expected in cases:
            with self.subTest(settings=settings):
                self.settings.return_value = settings
                self.assertIs(launcher.browser_open_disabled(), expected)

    def test_non_object_launcher_settings_are_rejected(self):
        for value in [False, 0, 'false', []]:
            with self.subTest(value=value):
                self.settings.return_value = {'launcher': value}
                with self.assertRaises(ValueError):
                    launcher.browser_open_disabled()

    def test_explicit_no_open_overrides_enabled_browser_setting(self):
        self.settings.return_value = {'launcher': {'openBrowser': True}}
        self.assertIs(launcher.browser_open_disabled(explicit=True), True)

    def test_main_passes_preference_to_cloudflare_and_local_modes(self):
        self.settings.return_value = {'launcher': {'openBrowser': False}}
        cases = [
            ([], 'tunnel', mock.call(8090, True, False, combined=True)),
            (['local'], 'local', mock.call(8090, True, False)),
            (['tunnel'], 'tunnel', mock.call(8090, True, False)),
            (['--local-only'], 'local', mock.call(8090, True, True)),
            (['tunnel', '--local-only'], 'tunnel', mock.call(8090, True, True)),
        ]
        for arguments, branch, expected in cases:
            with self.subTest(arguments=arguments), \
                    mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py'] + arguments), \
                    mock.patch.object(launcher, 'run_local', return_value=0) as local, \
                    mock.patch.object(launcher, 'run_tunnel', return_value=0) as tunnel:
                self.assertEqual(launcher.main(), 0)
            selected, unused = (local, tunnel) if branch == 'local' else (tunnel, local)
            self.assertEqual(selected.call_args_list, [expected])
            unused.assert_not_called()

    def test_main_passes_preference_to_localhost_run(self):
        self.settings.return_value = {'launcher': {'openBrowser': False}}
        with mock.patch.object(launcher.sys, 'argv', [
            'launch_sundoll.py', '--tunnel-provider', 'localhost-run',
        ]), mock.patch('server.ssh_tunnel.run', return_value=0) as start, \
                mock.patch.object(launcher, 'existing_connector', return_value=None), \
                mock.patch.object(launcher, 'server_info', return_value=None):
            self.assertEqual(launcher.main(), 0)
        start.assert_called_once()
        self.assertEqual(start.call_args.args[1:], (8090, True))

    def test_main_honors_cli_no_open_when_configuration_enables_browser(self):
        self.settings.return_value = {'launcher': {'openBrowser': True}}
        with mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py', '--no-open']), \
                mock.patch.object(launcher, 'run_tunnel', return_value=0) as start:
            self.assertEqual(launcher.main(), 0)
        start.assert_called_once_with(8090, True, False, combined=True)

    def test_check_returns_before_reading_browser_preference(self):
        with mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py', '--check']), \
                mock.patch.object(launcher, 'diagnostics', return_value=0) as diagnostics, \
                mock.patch.object(launcher, 'browser_open_disabled',
                                  side_effect=AssertionError('browser preference read')):
            self.assertEqual(launcher.main(), 0)
        diagnostics.assert_called_once_with(8090)

    def test_disabled_helper_does_not_open_browser(self):
        with mock.patch.object(launcher.webbrowser, 'open') as open_browser:
            launcher.open_host_console('https://dm.sundollworld.com/', disabled=True)
        open_browser.assert_not_called()

    def test_main_reuses_healthy_tunnel_without_opening_browser(self):
        self.settings.return_value = {'launcher': {'openBrowser': False}}
        base = 'https://quiet-river.trycloudflare.com'
        info = {'roomCode': 'TEST', 'ips': [], 'port': 8090, 'publicBase': base}
        with mock.patch.object(launcher.sys, 'argv', ['launch_sundoll.py']), \
                mock.patch.object(launcher, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=base), \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                mock.patch.object(launcher.subprocess, 'Popen') as spawn, \
                mock.patch.object(launcher.webbrowser, 'open') as open_browser:
            self.assertEqual(launcher.main(), 0)
        spawn.assert_not_called()
        publish.assert_not_called()
        open_browser.assert_not_called()


if __name__ == '__main__':
    unittest.main()
