"""First installation must be explicit, isolated and unable to reset live data."""
from project_test_paths import APP_ROOT
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import manage_accounts
from server.email_accounts import read_settings
from server.installation_backup import InstallationLease, InstallationBackups
from server.storage_mode import account_rooms_only, validate_startup, MODE_FILE, FORMAT
from server.workspace import atomic_json


class AccountInstallationSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)/'installation'
        self.save = self.root/'运行数据/存档'
        self.smtp = dict(host='', port=465, security='ssl', username='', **{'from': ''})

    def initialize(self, **overrides):
        return manage_accounts.initialize_accounts(self.save, overrides.get('origin', 'https://play.example.test'),
                                                   overrides.get('smtp', self.smtp))

    def test_new_installation_has_only_account_storage_and_can_be_backed_up(self):
        result = self.initialize()
        self.assertTrue(result['initialized'])
        self.assertFalse(result['emailDeliveryVerified'])
        self.assertFalse(result['smtpConfigured'])
        settings = read_settings(self.root/'运行数据/认证')
        network = json.loads((self.root/'运行数据/联机设置.json').read_text())
        self.assertEqual(network, {'webEntrances':{'playerHostname':'play.example.test'},
                                   'launcher':{'openBrowser':False}})
        self.assertTrue(account_rooms_only(self.save))
        validate_startup(self.save, settings)
        self.assertTrue(settings['enabled'] and settings['roomsEnabled'])
        for path in ('战役包', '玩家包', '通用包', '运行数据/存档/模块存储/模块.sqlite3',
                     '运行数据/认证/邮箱账号.sqlite3', '运行数据/认证/邮箱账号格式.json'):
            self.assertFalse((self.root/path).exists(), path)
        backup = Path(self.temporary.name)/'backup'
        report = InstallationBackups(self.root).create(backup)
        self.assertEqual(InstallationBackups.verify(backup)['manifestHash'], report['manifestHash'])

    def test_configured_smtp_is_validated_without_opening_account_database_or_sending(self):
        smtp = dict(host='smtp.example.test', port=587, security='starttls',
                    username='service', **{'from': 'DM@Example.Test'})
        with mock.patch.object(manage_accounts, 'AccountStore', side_effect=AssertionError('no account access')):
            self.assertTrue(self.initialize(smtp=smtp)['smtpConfigured'])
        self.assertEqual(read_settings(self.root/'运行数据/认证')['smtp']['from'], 'dm@example.test')

    def test_second_initialization_refuses_to_overwrite_current_settings(self):
        self.initialize()
        path = self.root/'运行数据/认证/邮箱账号设置.json'
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, '不会覆盖'):
            self.initialize(origin='https://another.example.test')
        self.assertEqual(path.read_bytes(), before)

    def test_legacy_data_and_private_payloads_are_never_reset(self):
        for relative in ('战役包/old/当前存档.json', '运行数据/认证/邮箱账号.sqlite3',
                         '运行数据/账号角色/角色.sqlite3'):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root/relative
                path.parent.mkdir(parents=True)
                path.write_bytes(b'keep this exact data')
                with self.assertRaises(ValueError):
                    manage_accounts.initialize_accounts(root/'运行数据/存档', 'https://play.example.test', self.smtp)
                self.assertEqual(path.read_bytes(), b'keep this exact data')
                self.assertFalse((root/'运行数据'/MODE_FILE).exists())

    def test_active_service_lease_blocks_initialization(self):
        lease = InstallationLease(self.root, shared=True)
        try:
            with self.assertRaisesRegex(RuntimeError, '仍在运行'):
                self.initialize()
        finally:
            lease.close()
        self.assertFalse((self.root/'运行数据'/MODE_FILE).exists())

    def test_incomplete_exact_initialization_can_resume_but_startup_is_closed(self):
        marker = dict(format=4, workspace='../..', storageMode='account-rooms')
        atomic_json(self.save/'工作区.json', marker)
        with self.assertRaises(ValueError):
            account_rooms_only(self.save)
        atomic_json(self.root/'运行数据'/MODE_FILE, dict(format=FORMAT))
        with self.assertRaises(RuntimeError):
            validate_startup(self.save, {})
        self.initialize()
        validate_startup(self.save, read_settings(self.root/'运行数据/认证'))

    def test_invalid_origin_mail_and_symlinks_do_not_create_settings(self):
        for origin in ('http://play.example.test', 'https://a@example.test', 'https://example.test/path',
                       'https://example.test:99999', 'https://bad host.test'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.initialize(origin=origin)
        for smtp in (dict(self.smtp, host='smtp.example.test'), dict(self.smtp, port=0)):
            with self.subTest(smtp=smtp), self.assertRaises(ValueError):
                self.initialize(smtp=smtp)
        outside = Path(self.temporary.name)/'outside'
        outside.mkdir()
        self.root.mkdir()
        (self.root/'运行数据').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.initialize()
        self.assertEqual(list(outside.iterdir()), [])

    def test_legacy_player_listing_cannot_recreate_central_workspace(self):
        self.initialize()
        error = io.StringIO()
        with mock.patch('sys.argv', ['manage_accounts.py', '--save-root', str(self.save), 'players']), \
                mock.patch.object(manage_accounts.Store, 'players', side_effect=AssertionError('legacy read')), \
                contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit):
                manage_accounts.main()
        self.assertIn('个人主页管理角色', error.getvalue())
        self.assertFalse((self.save/'模块存储').exists())


if __name__ == '__main__':
    unittest.main()
