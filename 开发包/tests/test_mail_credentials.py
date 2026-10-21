from project_test_paths import APP_ROOT
import sys
sys.path.insert(0, str(APP_ROOT))
import contextlib
import getpass
import io
import json
import os
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

import manage_accounts
from server import mail_credentials
from server.workspace_backup import Backups


class MailCredentialTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / '运行数据'
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(mail_credentials.paths, 'USER_DATA_ROOT', self.root).start()
        mock.patch.dict(os.environ, {}, clear=True).start()
        self.secret = 're_test_secret_only_in_temporary_directory'

    def make_file(self, content, mode=0o600):
        path = mail_credentials.smtp_secret_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)
        return path

    def test_environment_precedes_file_and_does_not_open_private_file(self):
        os.environ['SUNDOLL_SMTP_PASSWORD'] = 're_environment_value'
        self.make_file(self.secret.encode(), 0o644)
        with mock.patch.object(mail_credentials.os, 'open', side_effect=AssertionError('file should not open')):
            self.assertEqual(mail_credentials.read_smtp_secret(), 're_environment_value')

    def test_non_posix_uses_environment_and_never_opens_a_private_file(self):
        os.environ['SUNDOLL_SMTP_PASSWORD'] = 're_environment_value'
        with mock.patch.object(mail_credentials.os, 'name', 'nt'), \
                mock.patch.object(mail_credentials.os, 'open', side_effect=AssertionError('file should not open')):
            self.assertEqual(mail_credentials.read_smtp_secret(), 're_environment_value')
            os.environ.pop('SUNDOLL_SMTP_PASSWORD')
            self.assertEqual(mail_credentials.read_smtp_secret(), '')
            with self.assertRaises(mail_credentials.MailCredentialError) as result:
                mail_credentials.write_smtp_secret(self.secret)
            self.assertEqual(str(result.exception), mail_credentials.ERROR_MESSAGE)

    def test_non_posix_cli_explains_environment_without_prompting_for_a_key(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['manage_accounts.py', 'set-smtp-secret']), \
                mock.patch.object(manage_accounts.os, 'name', 'nt'), \
                mock.patch.object(manage_accounts.getpass, 'getpass', side_effect=AssertionError('no key prompt')), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit) as result:
                manage_accounts.main()
        self.assertEqual(result.exception.code, 1)
        self.assertIn('SUNDOLL_SMTP_PASSWORD', error.getvalue())
        self.assertNotIn(self.secret, output.getvalue() + error.getvalue())

    def test_missing_blank_environment_and_empty_file_mean_unconfigured(self):
        self.assertEqual(mail_credentials.read_smtp_secret(), '')
        os.environ['SUNDOLL_SMTP_PASSWORD'] = '   '
        self.make_file(b' \n')
        self.assertEqual(mail_credentials.read_smtp_secret(), '')
        self.make_file((self.secret + '\n').encode())
        self.assertEqual(mail_credentials.read_smtp_secret(), self.secret)

    def test_write_is_owner_only_and_replaces_instead_of_truncating_old_inode(self):
        path = self.make_file(b'old-value', 0o644)
        with path.open('rb') as old_stream:
            self.assertEqual(mail_credentials.write_smtp_secret(self.secret), path)
            self.assertEqual(old_stream.read(), b'old-value')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(mail_credentials.read_smtp_secret(), self.secret)
        self.assertEqual(list(path.parent.iterdir()), [path])
        self.assertEqual(path, self.root / '联机' / 'resend-api-key')
        self.assertFalse(Backups.allowed('运行数据/联机/resend-api-key'))

    def test_secret_at_maximum_supported_length_round_trips(self):
        value = 'x' * mail_credentials.MAX_SECRET_BYTES
        mail_credentials.write_smtp_secret(value)
        self.assertEqual(mail_credentials.read_smtp_secret(), value)

    def test_failed_replacement_preserves_old_file_and_removes_temporary_secret(self):
        path = self.make_file(b'old-value')
        with mock.patch.object(mail_credentials.os, 'replace', side_effect=PermissionError(self.secret)):
            with self.assertRaises(mail_credentials.MailCredentialError) as result:
                mail_credentials.write_smtp_secret(self.secret)
        self.assertEqual(str(result.exception), mail_credentials.ERROR_MESSAGE)
        self.assertEqual(path.read_bytes(), b'old-value')
        self.assertEqual(list(path.parent.iterdir()), [path])

    def test_symlink_file_is_rejected_for_read_and_write_without_touching_target(self):
        target = self.root.parent / 'outside-key'
        target.write_text('outside-unchanged')
        path = mail_credentials.smtp_secret_path()
        path.parent.mkdir(parents=True)
        path.symlink_to(target)
        for action in (mail_credentials.read_smtp_secret,
                       lambda: mail_credentials.write_smtp_secret(self.secret)):
            with self.assertRaises(mail_credentials.MailCredentialError) as result:
                action()
            self.assertEqual(str(result.exception), mail_credentials.ERROR_MESSAGE)
        self.assertEqual(target.read_text(), 'outside-unchanged')

    def test_symlink_directory_cannot_redirect_secret_storage(self):
        self.root.mkdir()
        target = self.root.parent / 'outside-directory'
        target.mkdir()
        (self.root / '联机').symlink_to(target, target_is_directory=True)
        for action in (mail_credentials.read_smtp_secret,
                       lambda: mail_credentials.write_smtp_secret(self.secret)):
            with self.assertRaises(mail_credentials.MailCredentialError):
                action()
        self.assertEqual(list(target.iterdir()), [])

    def test_unreadable_unsafe_and_invalid_files_return_the_same_safe_error(self):
        for content, mode in ((self.secret.encode(), 0o644), (b'\xffprivate-value', 0o600),
                              (b'x' * 4098, 0o600), (b'first\nsecond', 0o600)):
            self.make_file(content, mode)
            with self.assertRaises(mail_credentials.MailCredentialError) as result:
                mail_credentials.read_smtp_secret()
            self.assertEqual(str(result.exception), mail_credentials.ERROR_MESSAGE)
        with mock.patch.object(mail_credentials.os, 'open', side_effect=PermissionError(self.secret)):
            with self.assertRaises(mail_credentials.MailCredentialError) as result:
                mail_credentials.read_smtp_secret()
            self.assertNotIn(self.secret, str(result.exception))

    def test_cli_hidden_input_saves_without_account_store_or_secret_output(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['manage_accounts.py', 'set-smtp-secret']), \
                mock.patch.object(manage_accounts.getpass, 'getpass', return_value=self.secret) as prompt, \
                mock.patch.object(manage_accounts, 'Store', side_effect=AssertionError('must not access accounts')), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            manage_accounts.main()
        prompt.assert_called_once()
        self.assertTrue(json.loads(output.getvalue())['saved'])
        self.assertNotIn(self.secret, output.getvalue() + error.getvalue())
        self.assertEqual(mail_credentials.read_smtp_secret(), self.secret)

    def test_cli_refuses_getpass_visible_input_fallback(self):
        def warn_instead_of_hidden_input(_):
            warnings.warn('Cannot control echo', getpass.GetPassWarning)
            return self.secret
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['manage_accounts.py', 'set-smtp-secret']), \
                mock.patch.object(manage_accounts.getpass, 'getpass', side_effect=warn_instead_of_hidden_input), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit) as result:
                manage_accounts.main()
        self.assertEqual(result.exception.code, 1)
        self.assertFalse(mail_credentials.smtp_secret_path().exists())
        self.assertNotIn(self.secret, output.getvalue() + error.getvalue())

    def test_cli_rejects_secret_in_arguments_without_repeating_it(self):
        output, error = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', ['manage_accounts.py', 'set-smtp-secret', self.secret]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit) as result:
                manage_accounts.main()
        self.assertEqual(result.exception.code, 2)
        self.assertNotIn(self.secret, output.getvalue() + error.getvalue())
        self.assertFalse(mail_credentials.smtp_secret_path().exists())


if __name__ == '__main__':
    unittest.main()
