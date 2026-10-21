"""Exercise connector ownership with temporary state and isolated stub processes."""
from project_test_paths import APP_ROOT
import contextlib
import io
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import launch_sundoll as launcher


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        patch = mock.patch.object(launcher, 'NETWORK_SETTINGS', self.root / 'network.json')
        patch.start(); self.addCleanup(patch.stop)
        self.info = dict(projectId='isolated-project', sessionId='isolated-session', port=8090,
                         protocolVersion=launcher.SERVER_PROTOCOL_VERSION, roomCode='FAKE', ips=[], publicBase='')

    def lease(self, root=None):
        lease = launcher.TunnelOwnership(root or self.root)
        self.addCleanup(lease.close)
        return lease

    def process(self, code):
        process = subprocess.Popen([sys.executable, '-B', '-u', '-c', code],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=3)
            for stream in (process.stdin, process.stdout, process.stderr): stream.close()
        self.addCleanup(cleanup)
        return process

    def line(self, process, expected):
        lines = queue.Queue()
        def read():
            for line in process.stdout:
                lines.put(line.decode().strip())
        threading.Thread(target=read, daemon=True).start()
        for _ in range(30):
            line = lines.get(timeout=8)
            if expected in line: return line
        self.fail('Stub did not report readiness')

    def test_same_workspace_excludes_other_owner_and_different_workspace_does_not(self):
        first, second = self.lease(), self.lease()
        self.assertTrue(first.acquire())
        inode = first.path.stat().st_ino
        self.assertFalse(second.acquire())
        third = self.lease(self.root / 'other-workspace')
        self.assertTrue(third.acquire())
        first.close()
        self.assertTrue(second.acquire())
        self.assertEqual(second.path.stat().st_ino, inode)

    def test_os_lock_is_held_across_processes(self):
        code = (f"import sys;sys.path.insert(0,{str(APP_ROOT)!r});import launch_sundoll as l;"
                f"o=l.TunnelOwnership({str(self.root)!r});assert o.acquire();"
                "print('held',flush=True);sys.stdin.read();o.close()")
        child = self.process(code)
        self.line(child, 'held')
        lease = self.lease()
        self.assertFalse(lease.acquire())
        child.stdin.close(); child.wait(timeout=5)
        self.assertTrue(lease.acquire())

    def test_orphan_connector_blocks_replacement_until_its_process_exits(self):
        child = self.process("import sys;print('ready',flush=True);sys.stdin.read()")
        self.line(child, 'ready')
        old = self.lease()
        self.assertTrue(old.acquire())
        old.connector(child.pid)
        # Closing only the descriptor models a launcher crash, not normal cleanup.
        old.handle.close(); old.handle = None
        next_owner = self.lease()
        self.assertFalse(next_owner.acquire())
        child.stdin.close(); child.wait(timeout=5)
        self.assertTrue(next_owner.acquire())

    def test_pid_reuse_does_not_keep_a_dead_connector_owned(self):
        old = self.lease(); self.assertTrue(old.acquire())
        with mock.patch.object(launcher, 'process_marker', return_value='old-process'):
            old.connector(123456)
        old.handle.close(); old.handle = None
        new = self.lease()
        with mock.patch.object(launcher, 'process_marker', return_value='different-process'):
            self.assertTrue(new.acquire())

    def test_busy_lease_and_failed_public_probe_never_spawn_or_clear(self):
        owner = launcher.TunnelOwnership(); self.addCleanup(owner.close)
        self.assertTrue(owner.acquire())
        with mock.patch.object(launcher, 'find_cloudflared', return_value='stub'), \
                mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=None), \
                mock.patch.object(launcher, 'server_info', return_value=self.info), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                mock.patch.object(launcher, 'prepare_server') as prepare, \
                mock.patch.object(launcher.subprocess, 'Popen') as spawn, \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(launcher.run_tunnel(8090, no_open=True), 0)
        prepare.assert_not_called(); spawn.assert_not_called(); publish.assert_not_called()
        self.assertNotIn('公网联机已就绪', output.getvalue())

    def test_preexisting_unmanaged_connector_is_preserved_after_probe_failure(self):
        child = self.process("import sys;print('ready',flush=True);sys.stdin.read()")
        self.line(child, 'ready')
        with mock.patch.object(launcher, 'find_cloudflared', return_value='stub'), \
                mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=None), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, self.info, 8090)), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                mock.patch.object(launcher, 'existing_connector', return_value=child.pid), \
                mock.patch.object(launcher.subprocess, 'Popen') as spawn, \
                mock.patch.object(launcher, 'process_marker', return_value='live-stub'), \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                mock.patch.object(launcher, 'stop_process') as stop, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_tunnel(8090, no_open=True), 0)
        spawn.assert_not_called(); publish.assert_not_called()
        self.assertIsNone(child.poll())
        self.assertNotIn(mock.call(child), stop.call_args_list)

    def test_unknown_process_inventory_never_starts_or_clears_a_connector(self):
        with mock.patch.object(launcher, 'find_cloudflared', return_value='stub'), \
                mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=None), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, self.info, 8090)), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                mock.patch.object(launcher, 'existing_connector', return_value='unknown'), \
                mock.patch.object(launcher.subprocess, 'Popen') as spawn, \
                mock.patch.object(launcher, 'publish_tunnel_base') as publish, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_tunnel(8090, no_open=True), 0)
        spawn.assert_not_called(); publish.assert_not_called()

    def test_ssh_transport_cannot_bypass_a_cloudflare_workspace_owner(self):
        owner = launcher.TunnelOwnership(); self.addCleanup(owner.close)
        self.assertTrue(owner.acquire())
        with mock.patch('server.ssh_tunnel.run') as run, \
                mock.patch.object(launcher, 'server_info', return_value=self.info), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_ssh_tunnel(8090, no_open=True), 0)
        run.assert_not_called()

    def test_ssh_publication_requires_ownership_and_the_original_service(self):
        current = dict(self.info)
        def transport(api, port, no_open):
            api.prepare_server(port)
            self.assertTrue(api.publish_tunnel_base(port, 'https://isolated.lhr.life'))
            current['sessionId'] = 'restarted-service'
            self.assertFalse(api.publish_tunnel_base(port, ''))
            current['sessionId'] = self.info['sessionId']
            lock = self.root / '联机' / '公网连接.lock'
            lock.write_bytes(b'0' + json.dumps({'owner':'different-generation'}).encode())
            self.assertFalse(api.publish_tunnel_base(port, ''))
            return 0
        with mock.patch('server.ssh_tunnel.run', side_effect=transport), \
                mock.patch.object(launcher, 'existing_connector', return_value=None), \
                mock.patch.object(launcher, 'server_info', side_effect=lambda *_,**__:dict(current)), \
                mock.patch.object(launcher, 'prepare_server', return_value=(None, self.info, 8090)), \
                mock.patch.object(launcher, 'publish_tunnel_base', return_value=True) as publish:
            self.assertEqual(launcher.run_ssh_tunnel(8090, no_open=True), 0)
        publish.assert_called_once_with(8090, 'https://isolated.lhr.life', 0.75)

    def test_cleanup_requires_both_lease_generation_and_same_service_session(self):
        owner = self.lease(); self.assertTrue(owner.acquire())
        base = 'https://isolated.trycloudflare.com'
        current = dict(self.info, publicBase=base)
        with mock.patch.object(launcher, 'server_info', return_value=current), \
                mock.patch.object(launcher, 'publish_tunnel_base', return_value=True) as publish:
            self.assertTrue(launcher.clear_owned_tunnel(owner, 8090, base, self.info))
            publish.assert_called_once_with(8090, '')
            publish.reset_mock()
            self.assertFalse(launcher.clear_owned_tunnel(owner, 8090, base, dict(self.info, sessionId='restarted')))
            self.assertFalse(launcher.clear_owned_tunnel(owner, 8090, base, dict(self.info, projectId='different-workspace')))
            self.assertFalse(launcher.clear_owned_tunnel(owner, 8090, base, dict(self.info, sessionId=None)))
            owner.write(dict(owner.record, owner='another-generation'))
            self.assertFalse(launcher.clear_owned_tunnel(owner, 8090, base, self.info))
            publish.assert_not_called()

    @unittest.skipIf(os.name == 'nt', 'Windows prevents replacing this open file')
    def test_replaced_lock_file_cannot_be_cleared_through_the_old_descriptor(self):
        owner = self.lease(); self.assertTrue(owner.acquire())
        owner.path.unlink()
        owner.path.write_bytes(b'0' + json.dumps({'owner':'replacement-generation'}).encode())
        self.assertFalse(owner.is_owner())
        owner.close()
        self.assertIn('replacement-generation', owner.path.read_text())

    def test_existing_connector_scanner_matches_exact_token_and_ssh_workspace(self):
        fixed = dict(tokenFile=self.root / 'private token')
        listing = '101 /opt/cloudflared\n202 /usr/bin/ssh\n'
        for argument in (f'--token-file "{fixed["tokenFile"]}"',
                         f'--token-file {fixed["tokenFile"]}', f'--token-file={fixed["tokenFile"]}'):
            commands = '101 /opt/cloudflared tunnel run ' + argument + '\n'
            results = [mock.Mock(returncode=0, stdout=listing), mock.Mock(returncode=0, stdout=commands)]
            with mock.patch.object(launcher.subprocess, 'run', side_effect=results):
                self.assertEqual(launcher.existing_connector(8090, fixed), 101)
        commands = f'202 /usr/bin/ssh -o "UserKnownHostsFile={launcher.USER_DATA_ROOT}/联机/known_hosts" nokey@localhost.run\n'
        results = [mock.Mock(returncode=0, stdout=listing), mock.Mock(returncode=0, stdout=commands)]
        with mock.patch.object(launcher.subprocess, 'run', side_effect=results):
            self.assertEqual(launcher.existing_connector(8090, fixed), 202)

    def test_windows_inventory_matches_a_quoted_token_path_without_logging_arguments(self):
        import types
        token = r'C:\Work Folder\private-token'
        output = json.dumps(dict(ProcessId=101, CommandLine='cloudflared.exe tunnel run --token-file "' + token + '"'))
        with mock.patch.object(launcher, 'os', types.SimpleNamespace(name='nt')), \
                mock.patch.object(launcher.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout=output)), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(launcher.existing_connector(8090, dict(tokenFile=token)), 101)
        self.assertEqual(printed.getvalue(), '')

    @unittest.skipIf(os.name == 'nt', 'POSIX signal fixture; Windows lock is covered by the portable lease test')
    def test_two_real_launchers_start_only_one_stub_connector(self):
        count = self.root / 'connector-count'
        stub = "import time;print('https://isolated.trycloudflare.com',flush=True);print('Registered tunnel connection',flush=True);time.sleep(120)"
        code = f'''import sys, pathlib
sys.path.insert(0,{str(APP_ROOT)!r})
import launch_sundoll as l
l.NETWORK_SETTINGS=pathlib.Path({str(self.root / 'network.json')!r})
l.find_cloudflared=lambda:'isolated-stub'
l.fixed_tunnel_settings=lambda:None
info={self.info!r}
l.prepare_server=lambda *_:(None,dict(info),8090)
l.server_info=lambda *_,**__:dict(info)
l.live_tunnel_base=lambda *_,**__:''
l.existing_connector=lambda *_:None
l.publish_tunnel_base=lambda *_:True
original=l.subprocess.Popen
def spawn(*args,**kwargs):
    if args[0][0]!='isolated-stub':return original(*args,**kwargs)
    with open({str(count)!r},'a') as f:f.write('connector\\n')
    return original([sys.executable,'-B','-u','-c',{stub!r}],**kwargs)
l.subprocess.Popen=spawn
raise SystemExit(l.run_tunnel(8090,no_open=True))
'''
        first = self.process(code)
        self.line(first, '公网联机已就绪')
        second = subprocess.run([sys.executable, '-B', '-u', '-c', code], capture_output=True, text=True, timeout=10)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('不创建重复连接', second.stdout)
        self.assertEqual(count.read_text().splitlines(), ['connector'])
        os.kill(first.pid, signal.SIGINT)
        first.wait(timeout=8)


class CoordinatedProcess:
    """Simulate shutdown duration without sleeping or signalling any real PID."""
    def __init__(self, duration):
        self.duration = duration
        self.elapsed = 0
        self.exited = False
        self.killed = False
        self.events = []

    def poll(self):
        return 0 if self.exited else None

    def terminate(self):
        self.events.append('terminate')

    def wait(self, timeout=None):
        self.events.append(('wait', timeout))
        if timeout is None:
            raise KeyboardInterrupt()
        if self.exited:
            return 0
        if self.duration > timeout:
            self.elapsed += timeout
            self.duration -= timeout
            raise subprocess.TimeoutExpired('isolated-process', timeout)
        self.elapsed += self.duration
        self.exited = True
        return 0

    def kill(self):
        self.events.append('kill')
        self.killed = self.exited = True


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patch = mock.patch.object(launcher, 'NETWORK_SETTINGS', Path(temporary.name) / 'network.json')
        patch.start(); self.addCleanup(patch.stop)
        self.info = dict(projectId='isolated-project', sessionId='isolated-session', ips=[], publicBase='')

    def test_server_budget_covers_eight_workers_without_premature_kill(self):
        server = CoordinatedProcess(8 * (5 + 5 + 5))
        launcher.stop_process(server, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)
        self.assertEqual(server.events, ['terminate', ('wait', 130)])
        self.assertEqual(server.elapsed, 120)
        self.assertFalse(server.killed)

    def test_server_is_killed_only_after_its_coordination_deadline(self):
        server = CoordinatedProcess(200)
        launcher.stop_process(server, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)
        self.assertEqual(server.events, ['terminate', ('wait', 130), 'kill', ('wait', 2)])
        self.assertEqual(server.elapsed, 130)
        self.assertTrue(server.killed)

    def test_connector_keeps_its_short_deadline(self):
        connector = CoordinatedProcess(8)
        launcher.stop_process(connector)
        self.assertEqual(connector.events, ['terminate', ('wait', 3), 'kill', ('wait', 2)])
        self.assertEqual(connector.elapsed, 3)

    def test_exited_or_absent_processes_do_not_wait_or_receive_signals(self):
        exited = mock.Mock()
        exited.poll.return_value = 0
        launcher.stop_process(None, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)
        launcher.stop_process(exited, timeout=launcher.SERVER_SHUTDOWN_TIMEOUT)
        exited.terminate.assert_not_called(); exited.wait.assert_not_called(); exited.kill.assert_not_called()

    def test_local_exit_actually_passes_the_server_budget(self):
        server = CoordinatedProcess(120)
        with mock.patch.object(launcher, 'prepare_server', return_value=(server, self.info, 8090)), \
                mock.patch.object(launcher, 'publish_tunnel_base'), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_local(8090, no_open=True), 0)
        self.assertEqual(server.events, [('wait', None), 'terminate', ('wait', 130)])
        self.assertFalse(server.killed)

    def test_failed_startup_actually_passes_the_server_budget(self):
        server = CoordinatedProcess(120)
        with mock.patch.object(launcher, 'select_port', return_value=(8090, None)), \
                mock.patch.object(launcher.subprocess, 'Popen', return_value=server), \
                mock.patch.object(launcher, 'wait_for_server', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError): launcher.prepare_server(8090)
        self.assertEqual(server.events, ['terminate', ('wait', 130)])
        self.assertFalse(server.killed)

    def test_cloudflare_exit_passes_distinct_server_and_connector_budgets(self):
        server = CoordinatedProcess(120)
        connector = mock.Mock(pid=123456)
        connector.stdout = iter([])
        connector.poll.return_value = None
        connector.wait.return_value = 0
        with mock.patch.object(launcher, 'find_cloudflared', return_value='isolated-stub'), \
                mock.patch.object(launcher, 'fixed_tunnel_settings', return_value=None), \
                mock.patch.object(launcher, 'prepare_server', return_value=(server, self.info, 8090)), \
                mock.patch.object(launcher, 'live_tunnel_base', return_value=''), \
                mock.patch.object(launcher, 'existing_connector', return_value=None), \
                mock.patch.object(launcher, 'process_marker', return_value=None), \
                mock.patch.object(launcher, 'tunnel_output', return_value=iter([])), \
                mock.patch.object(launcher.subprocess, 'Popen', return_value=connector), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.run_tunnel(8090, no_open=True, combined=True), 0)
        self.assertEqual(server.events, [('wait', None), 'terminate', ('wait', 130)])
        connector.wait.assert_any_call(timeout=3)
        connector.kill.assert_not_called(); self.assertFalse(server.killed)

    def test_ssh_exit_passes_distinct_server_and_connector_budgets(self):
        server, connector = CoordinatedProcess(120), CoordinatedProcess(1)
        def transport(api, port, no_open):
            api.prepare_server(port)
            api.stop_process(connector)
            api.stop_process(server)
            return 0
        with mock.patch('server.ssh_tunnel.run', side_effect=transport), \
                mock.patch.object(launcher, 'existing_connector', return_value=None), \
                mock.patch.object(launcher, 'server_info', return_value=self.info), \
                mock.patch.object(launcher, 'prepare_server', return_value=(server, self.info, 8090)):
            self.assertEqual(launcher.run_ssh_tunnel(8090, no_open=True), 0)
        self.assertEqual(server.events, ['terminate', ('wait', 130)])
        self.assertEqual(connector.events, ['terminate', ('wait', 3)])
        self.assertFalse(server.killed); self.assertFalse(connector.killed)


class AddressTests(unittest.TestCase):
    def test_account_mode_outputs_one_loopback_account_entry(self):
        info = dict(authentication={'method':'email_password'}, ips=['192.168.1.20', '26.1.2.3'])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            launcher.show_connection_info(info, 8090)
        text = output.getvalue()
        self.assertNotIn('本机原工作区管理', text)
        self.assertIn('http://127.0.0.1:8090/account#dashboard', text)
        self.assertEqual(text.count('http://'),1)
        self.assertEqual(launcher.host_console_url('http://127.0.0.1:8090/account#dashboard','https://pl.example.com'),
                         'http://127.0.0.1:8090/account#dashboard')
        self.assertNotIn('192.168.1.20', text); self.assertNotIn('26.1.2.3', text)
        self.assertNotIn('本机玩家', text)

    def test_legacy_addresses_and_verified_account_entry_keep_their_distinct_roles(self):
        info = dict(authentication={'method':'name'}, ips=['192.168.1.20'])
        with contextlib.redirect_stdout(io.StringIO()) as output:
            launcher.show_connection_info(info, 8090)
        self.assertIn('192.168.1.20:8090', output.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as output:
            launcher.show_public_connection({'authentication':{'method':'email_password'}}, 'https://pl.example.com')
        self.assertIn('https://pl.example.com/account#dashboard', output.getvalue())
        self.assertNotIn('玩家完整地址', output.getvalue())


if __name__ == '__main__':
    unittest.main()
