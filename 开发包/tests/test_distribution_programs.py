"""Exercise packaged entrances and offline tools without author data or services."""
from project_test_paths import APP_ROOT, TOOLS_ROOT, DAILY_LIFE_FIXTURE
from html.parser import HTMLParser
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from urllib.parse import quote, urljoin, urlsplit


class Dependencies(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == 'script' and attributes.get('src'):
            self.paths.append(attributes['src'])
        if tag == 'link' and attributes.get('rel') == 'stylesheet':
            self.paths.append(attributes['href'])


class DistributionProgramTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='sundoll-distribution-tools-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name) / '发行 with spaces'
        cls.app = cls.root / '程序包/主程序'
        spec = importlib.util.spec_from_file_location('distribution_programs',
                                                     TOOLS_ROOT / 'build_distribution_v4.py')
        distribution = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(distribution)
        cls.distribution = distribution
        distribution.copy_engine(APP_ROOT, cls.app)
        distribution.copy_launchers(APP_ROOT, cls.root)
        cls.env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1',
                       SUNDOLL_TEST_SAVE_ROOT=str(cls.root / '程序包/运行数据/存档'))
        cls.env.pop('SUNDOLL_SMTP_PASSWORD', None)
        cls.env.pop('SUNDOLL_WORKSPACE_ROOT', None)
        cls.env['PATH'] = str(Path(sys.executable).parent) + os.pathsep + cls.env.get('PATH', '')

    def cli(self, command):
        return subprocess.run(command, cwd=self.root, env=self.env,
                              capture_output=True, text=True, timeout=20)

    def test_packaged_account_and_installation_cli_are_self_contained(self):
        for name, keywords in (
            ('manage_accounts.py', ('check', 'set-smtp-secret', 'invite')),
            ('manage_installation.py', ('create', 'verify', 'restore', 'recover')),
            ('manage_installation_ui.py', ('backup', 'restore', 'verify', 'recover')),
        ):
            with self.subTest(program=name):
                result = self.cli([sys.executable, str(self.app / name), '--help'])
                self.assertEqual(result.returncode, 0, result.stderr)
                for word in keywords:
                    self.assertIn(word, result.stdout)
        example = json.loads((self.app / '邮箱账号设置.example.json').read_text('utf-8'))
        self.assertIs(example['enabled'], False)
        self.assertFalse((self.app.parent / '运行数据/认证').exists())

    def test_packaged_unified_entry_reaches_the_local_maintenance_tools(self):
        for folder in (self.root, self.app):
            for mode in ('--backup', '--restore', '--verify-backup', '--recover-backup'):
                with self.subTest(folder=folder, mode=mode):
                    entry = folder / '启动桑哆尔之歌.command'
                    self.assertTrue(entry.stat().st_mode & 0o111)
                    result = self.cli(['/bin/bash', str(entry), mode, '--help'])
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('backup', result.stdout)
                    self.assertIn('restore', result.stdout)

    def test_packaged_launchers_are_complete_and_only_have_two_platform_entries(self):
        for folder in (self.root, self.app):
            self.assertEqual({p.name for p in folder.iterdir() if p.suffix in ('.command', '.bat')},
                             {'启动桑哆尔之歌.command', '启动桑哆尔之歌.bat'})
            result = self.cli(['/bin/bash', str(folder / '启动桑哆尔之歌.command'), '--help'])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('--backup', result.stdout)
            self.assertIn('--port', result.stdout)
        self.assertTrue((self.app / 'launch_entry.py').is_file())

    def test_actual_empty_distribution_zip_has_complete_unified_entries(self):
        destination = self.root / 'empty edition'
        result = self.distribution.build(APP_ROOT, None, destination)
        self.assertFalse((destination/'程序包/通用包').exists())
        self.assertFalse((destination/'程序包/运行数据/存档').exists())
        default = destination/'程序包/主程序/defaults/日常小事'
        self.assertEqual((default/'资料/climate.json').read_bytes(),
                         (DAILY_LIFE_FIXTURE/'资料/climate.json').read_bytes())
        manifest = json.loads((destination / '发行清单.json').read_text('utf-8'))
        self.assertIn('程序包/主程序/launch_entry.py', {entry['path'] for entry in manifest['files']})
        for folder in (destination, destination / '程序包/主程序'):
            self.assertEqual({p.name for p in folder.iterdir() if p.suffix in ('.command', '.bat')},
                             {'启动桑哆尔之歌.command', '启动桑哆尔之歌.bat'})
            help_result = self.cli(['/bin/bash', str(folder / '启动桑哆尔之歌.command'), '--help'])
            self.assertEqual(help_result.returncode, 0, help_result.stderr)
            self.assertIn('--backup', help_result.stdout)
        with zipfile.ZipFile(result['path']) as archive:
            names = archive.namelist()
            self.assertFalse(any('兼容入口' in name for name in names))
            self.assertTrue(any(name.endswith('/程序包/主程序/launch_entry.py') for name in names))

    def test_existing_zip_is_preserved_and_invalid_input_leaves_no_release(self):
        destination = self.root/'protected edition'
        archive = destination.with_suffix('.zip')
        archive.write_bytes(b'existing release')
        with self.assertRaisesRegex(ValueError, '不会覆盖'):
            self.distribution.build(APP_ROOT, None, destination)
        self.assertEqual(archive.read_bytes(), b'existing release')
        self.assertFalse(destination.exists())
        archive.unlink()
        with self.assertRaisesRegex(ValueError, 'v4'):
            self.distribution.build(APP_ROOT, self.root/'missing-save', destination)
        self.assertFalse(destination.exists())
        self.assertFalse(archive.exists())
        with self.assertRaisesRegex(ValueError, '--source'):
            self.distribution.build(APP_ROOT, None, destination, standard=True)
        self.assertFalse(destination.exists())

    def test_packaged_dynamic_entrances_have_their_actual_http_dependencies(self):
        data_root = self.app.parent / '运行数据'
        data_root.mkdir(exist_ok=True)
        (data_root / '联机设置.json').write_text(json.dumps({'webEntrances': {
            'mainHostname': 'main.example.test', 'dmHostname': 'dm.example.test',
            'playerHostname': 'pl.example.test'}}), encoding='utf-8')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with (self.root / 'temporary-server.log').open('w') as log:
            process = subprocess.Popen([sys.executable, str(self.app / 'start_server.py'),
                                        '--port', str(port), '--bind', '127.0.0.1'],
                                       cwd=self.app, env=self.env, stdout=log, stderr=log)
            try:
                def get(path, host='pl.example.test'):
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                    try:
                        connection.request('GET', quote(path, safe='/?=&%'), headers={'Host': host})
                        response = connection.getresponse()
                        return response.status, response.read(), response.getheader('Content-Type', '')
                    finally:
                        connection.close()

                deadline = time.monotonic() + 15
                while True:
                    try:
                        if get('/account')[0] == 200:
                            break
                    except OSError:
                        pass
                    if process.poll() is not None or time.monotonic() >= deadline:
                        self.fail('Temporary distribution failed to start: ' +
                                  (self.root / 'temporary-server.log').read_text('utf-8'))
                    time.sleep(.05)
                for path, host in (('/account', 'pl.example.test'),
                                   ('/', 'main.example.test'), ('/login', 'dm.example.test')):
                    with self.subTest(path=path):
                        status, body, content_type = get(path, host)
                        self.assertEqual(status, 200)
                        self.assertIn('text/html', content_type)
                        parsed = Dependencies()
                        parsed.feed(body.decode('utf-8'))
                        self.assertTrue(parsed.paths)
                        for dependency in parsed.paths:
                            url = urlsplit(urljoin('https://' + host + path, dependency))
                            if url.hostname != host:
                                continue
                            self.assertEqual(get(url.path, host)[0], 200, dependency)
                # This worker is served dynamically, so HTML dependency scans
                # alone cannot catch a missing source file in the release.
                status, worker, content_type = get('/ui-assets-sw.js')
                self.assertEqual(status, 200)
                self.assertIn('javascript', content_type)
                self.assertIn(b'addEventListener', worker)
                status, manifest, _ = get('/ui-assets-manifest.json')
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(manifest))
                for path in ('/manage_accounts.py', '/manage_installation.py', '/launch_entry.py',
                             '/邮箱账号设置.example.json', '/web/account.html',
                             '/defaults/日常小事/资料/menus.json'):
                    self.assertIn(get(path)[0], (403, 404), path)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

    def test_packaged_account_installation_opens_a_new_room_with_default_rules(self):
        from server.email_accounts import AccountStore, read_settings
        from server.workspace_backup import epoch
        from test_email_accounts import Mailbox, PASSWORD
        with tempfile.TemporaryDirectory(prefix='sundoll-account-release-') as directory:
            root = Path(directory).resolve()
            app = root/'程序包/主程序'
            save = root/'程序包/运行数据/存档'
            self.distribution.copy_engine(APP_ROOT, app)
            env = dict(self.env, SUNDOLL_TEST_SAVE_ROOT=str(save))
            result = subprocess.run([sys.executable, str(app/'manage_accounts.py'),
                                     '--save-root', str(save), 'init', '--origin', 'https://pl.example.test'],
                                    cwd=root, env=env, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            auth = root/'程序包/运行数据/认证'
            mailbox = Mailbox()
            accounts = AccountStore(auth, read_settings(auth), mailer=mailbox, epoch=lambda:epoch(save))
            accounts.register('release@example.test', '发行验收玩家', PASSWORD)
            accounts.verify(mailbox.messages[-1][2], PASSWORD)
            token = accounts.login('release@example.test', PASSWORD)[0]
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            with (root/'server.log').open('w') as log:
                process = subprocess.Popen([sys.executable, str(app/'start_server.py'),
                                            '--port', str(port), '--bind', '127.0.0.1'],
                                           cwd=app, env=env, stdout=log, stderr=log)
                try:
                    def request(path, payload=None):
                        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
                        headers = {'Host':'pl.example.test', 'X-Forwarded-Proto':'https',
                                   'Origin':'https://pl.example.test', 'X-Sundoll-Account':'1',
                                   'Content-Type':'application/json', 'Cookie':'__Host-sundoll-account='+token}
                        try:
                            connection.request('GET' if payload is None else 'POST',
                                quote(path, safe='/?=&%'), None if payload is None else json.dumps(payload), headers)
                            response = connection.getresponse()
                            return response.status, response.read(), dict(response.getheaders())
                        finally:
                            connection.close()

                    deadline = time.monotonic()+15
                    while True:
                        try:
                            if request('/account')[0] == 200:break
                        except OSError:
                            pass
                        if process.poll() is not None or time.monotonic() >= deadline:
                            self.fail('New account installation did not start: '+(root/'server.log').read_text())
                        time.sleep(.05)
                    for path in ('/', '/login', '/主控台/主控台.html', '/主控台/玩家.html'):
                        status, _, headers = request(path)
                        self.assertEqual(status, 302, path)
                        self.assertTrue(headers['Location'].endswith('/account#dashboard'))
                    self.assertEqual(request('/api/state')[0], 410)
                    status, body, _ = request('/api/account/room-create', {'name':'发行验收房间'})
                    self.assertEqual(status, 200, body)
                    room = json.loads(body)['room']['id']
                    for page in ('主控台/主控台.html', '主控台/玩家.html'):
                        status, body, _ = request('/rooms/'+room+'/'+page)
                        self.assertEqual(status, 200, page)
                        self.assertIn(b'sundoll-account-id', body)
                    for kind in ('menus', 'climate', 'lifestyle'):
                        status, body, _ = request('/rooms/'+room+'/api/daily-life/'+kind)
                        self.assertEqual(status, 200, body)
                        self.assertTrue(json.loads(body))
                    room_data = root/'程序包/运行数据/战役空间'/room
                    self.assertTrue((room_data/'通用包/日常小事/模块.json').is_file())
                    self.assertFalse((save/'模块存储/模块.sqlite3').exists())
                    self.assertFalse((root/'程序包/玩家包').exists())
                    self.assertFalse((root/'程序包/战役包').exists())
                    self.assertEqual(request('/defaults/日常小事/资料/lifestyle.json')[0], 404)
                finally:
                    process.terminate()
                    try:process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill();process.wait()

    def test_legacy_builder_gives_a_current_alternative_without_creating_output(self):
        result = self.cli([sys.executable, str(TOOLS_ROOT / 'build_distribution_v3.py'), '--help'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('build_distribution_v4.py', result.stdout)
        destination = self.root / 'unused legacy output'
        result = self.cli([sys.executable, str(TOOLS_ROOT / 'build_distribution_v3.py'),
                           '--source-save', str(self.root / 'unused source'),
                           '--destination', str(destination)])
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('build_distribution_v4.py', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
