"""Verify the shared launch menu without interrupting a running game."""
from project_test_paths import APP_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import launch_sundoll as launcher


class LauncherModeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patcher = mock.patch.object(launcher, 'NETWORK_SETTINGS', Path(temporary.name) / 'network.json')
        patcher.start(); self.addCleanup(patcher.stop)
        for name in ('existing_connector', 'process_marker'):
            patcher = mock.patch.object(launcher, name, return_value=None)
            patcher.start(); self.addCleanup(patcher.stop)

    def test_unified_entry_forwards_menu_modes_arguments_and_exit_status(self):
        for folder in (CHECKOUT_ROOT, APP_ROOT):
            for arguments, answer, target, expected in (
                ([], '1\n', 'launch_sundoll.py', ['local', '--no-open']),
                ([], '2\n', 'launch_sundoll.py', ['auto', '--no-open']),
                ([], 'wrong\n1\n', 'launch_sundoll.py', ['local', '--no-open']),
                (['local', '--port', '9000'], '', 'launch_sundoll.py', ['local', '--port', '9000', '--no-open']),
                (['auto', '--no-open'], '', 'launch_sundoll.py', ['auto', '--no-open', '--no-open']),
                (['--check'], '', 'launch_sundoll.py', ['--check', '--no-open']),
                (['--backup', '--root', 'path with spaces'], '', 'manage_installation_ui.py', ['backup', '--root', 'path with spaces']),
                (['--restore', '--help'], '', 'manage_installation_ui.py', ['restore', '--help']),
                (['--verify-backup'], '', 'manage_installation_ui.py', ['verify']),
                (['--recover-backup'], '', 'manage_installation_ui.py', ['recover']),
            ):
                with self.subTest(folder=folder, arguments=arguments, answer=answer), tempfile.TemporaryDirectory() as temporary:
                    destination = Path(temporary) / 'workspace with spaces'
                    destination.mkdir()
                    name = '启动桑哆尔之歌.command'
                    source = folder / name
                    self.assertTrue(source.stat().st_mode & 0o111)
                    shutil.copy2(source, destination / name)
                    engine = destination / '程序包/主程序' if folder == CHECKOUT_ROOT else destination
                    engine.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(APP_ROOT / 'launch_entry.py', engine / 'launch_entry.py')
                    for stub in ('launch_sundoll.py', 'manage_installation_ui.py'):
                        (engine / stub).write_text(
                            'import json, sys\nfrom pathlib import Path\n'
                            'print()\nprint(json.dumps([Path(__file__).name, sys.argv[1:]]))\n'
                            'raise SystemExit(23)\n', encoding='utf-8')
                    result = subprocess.run([str(destination / name), *arguments], input=answer,
                                            cwd=temporary, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 23)
                    self.assertEqual(json.loads(result.stdout.splitlines()[-1]), [target, expected])
                    if not arguments:
                        self.assertIn('1. 本机使用', result.stdout)
                        self.assertIn('2. 公网联机', result.stdout)
                        self.assertNotIn('个人本地版', result.stdout)

    def test_cancel_or_noninteractive_menu_never_starts_a_service(self):
        for answer in ('\n', ''):
            with self.subTest(answer=answer), tempfile.TemporaryDirectory() as temporary:
                entry = Path(temporary) / 'launch_entry.py'
                shutil.copy2(APP_ROOT / 'launch_entry.py', entry)
                # No service files: attempting to invoke one would fail.
                result = subprocess.run(['python3', str(entry)], input=answer,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('已取消', result.stdout)

    def test_archived_compatibility_entries_reach_the_shared_launcher(self):
        archive = TOOLS_ROOT / '维护记录/入口与存档统一-20261013/兼容入口'
        if not archive.is_dir():
            self.skipTest('旧兼容入口仅随本地历史记录保留，不属于公开源码或日常入口')
        for folder in ('根目录', '主程序'):
            for name, mode in (
                ('启动本机服务.command', 'local'),
                ('启动公网联机.command', 'auto'),
                ('备份全部战役.command', '--backup'),
                ('恢复全部战役.command', '--restore'),
            ):
                with self.subTest(folder=folder, name=name), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary) / 'workspace with spaces'
                    copied = root / '开发包/维护记录/入口与存档统一-20261013/兼容入口' / folder / name
                    copied.parent.mkdir(parents=True)
                    shutil.copy2(archive / folder / name, copied)
                    app = root / '程序包/主程序'
                    app.mkdir(parents=True)
                    (app / 'launch_entry.py').touch()
                    (root / '启动桑哆尔之歌.command').write_text(
                        '#!/bin/bash\nprintf "%s\\n" "$@"\nexit 23\n', encoding='utf-8')
                    result = subprocess.run([str(copied), '--port', '9000'],
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 23, result.stderr)
                    self.assertEqual(result.stdout.splitlines(), [mode, '--port', '9000'])

    def test_local_entry_reuses_live_service_without_erasing_public_invitation(self):
        info = {'roomCode': 'ROOM', 'ips': [], 'publicBase': 'https://pl.sundollworld.com'}
        with mock.patch.object(launcher, 'prepare_server', return_value=(None, info, 8090)), \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                mock.patch.object(launcher, 'stop_process') as stop, \
                mock.patch.object(launcher.webbrowser, 'open') as browser, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_local(8090, no_open=True), 0)
        publish.assert_not_called()
        stop.assert_not_called()
        browser.assert_not_called()

    def test_new_local_service_is_maintained_until_it_exits(self):
        server = mock.Mock()
        server.wait.return_value = 0
        with mock.patch.object(launcher, 'prepare_server', return_value=(server, {'ips': []}, 8090)), \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                mock.patch.object(launcher, 'stop_process') as stop, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_local(8090, no_open=True), 0)
        publish.assert_called_once_with(8090, '')
        server.wait.assert_called_once()
        stop.assert_called_once_with(server, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)

    def test_failed_public_precheck_reports_once_and_keeps_reused_local_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            token = Path(temporary) / 'token-file'
            token.touch()
            fixed = {'base': 'https://pl.sundollworld.com', 'tokenFile': token, 'port': 8090}
            info = {'ips': [], 'roomCode': 'ROOM'}
            tunnel = mock.Mock()
            tunnel.wait.return_value = tunnel.poll.return_value = 0
            output = io.StringIO()
            with mock.patch.object(launcher, 'find_cloudflared', return_value='cloudflared'), \
                    mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=fixed), \
                    mock.patch.object(launcher, 'prepare_server', return_value=(None, info, 8090)), \
                    mock.patch.object(launcher, 'server_info', return_value=info), \
                    mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                    mock.patch.object(launcher, 'tunnel_output', return_value=iter([
                        'precheck complete hard_fail=true\n', '', 'retrying\n'])), \
                    mock.patch.object(launcher.time, 'monotonic', side_effect=[0, 10, 35, 40]), \
                    mock.patch.object(launcher.subprocess, 'Popen', return_value=tunnel), \
                    mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                    mock.patch.object(launcher, 'stop_process') as stop, \
                    mock.patch.object(launcher.webbrowser, 'open') as browser, \
                    contextlib.redirect_stdout(output):
                self.assertEqual(launcher.run_tunnel(8090, no_open=True, combined=True), 0)
            self.assertEqual(output.getvalue().count('公网尚未就绪'), 1)
            self.assertNotIn('\n公网联机已就绪。', output.getvalue())
            self.assertIn('本地服务器由另一个窗口维护，可继续使用', output.getvalue())
            publish.assert_not_called()
            self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(None, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)])
            browser.assert_not_called()

    def test_distribution_preserves_only_the_two_platform_entries(self):
        spec = importlib.util.spec_from_file_location('distribution_launch_entries',
                                                     TOOLS_ROOT / 'build_distribution_v4.py')
        distribution = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(distribution)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            distribution.copy_launchers(APP_ROOT, destination)
            self.assertEqual({p.name for p in destination.iterdir()},
                             {'启动桑哆尔之歌.command', '启动桑哆尔之歌.bat'})
            for name in distribution.LAUNCHER_FILES:
                self.assertEqual((destination / name).read_bytes(), (CHECKOUT_ROOT / name).read_bytes())
                self.assertEqual((APP_ROOT / name).read_bytes(), (CHECKOUT_ROOT / name).read_bytes())
            self.assertTrue((destination / '启动桑哆尔之歌.command').stat().st_mode & 0o111)

    def test_closing_public_entry_preserves_service_started_by_another_window(self):
        tunnel = mock.Mock()
        output = io.StringIO()
        with mock.patch.object(launcher, 'find_cloudflared', return_value='cloudflared'), \
                mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=None), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, {'ips': []}, 8090)), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                mock.patch.object(launcher.subprocess, 'Popen', return_value=tunnel), \
                mock.patch.object(launcher, 'publish_tunnel_base'), \
                mock.patch.object(launcher, 'stop_process') as stop, \
                contextlib.redirect_stdout(output):
            tunnel.stdout.__iter__ = mock.Mock(side_effect=KeyboardInterrupt)
            self.assertEqual(launcher.run_tunnel(8090, no_open=True, combined=True), 0)
        self.assertIn('已有本机服务继续运行', output.getvalue())
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(None, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)])


if __name__ == '__main__':
    unittest.main()
