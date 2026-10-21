from project_test_paths import APP_ROOT
import sys
sys.path.insert(0, str(APP_ROOT))
import smtplib
import unittest
from unittest import mock
from server.email_accounts import AccountError, SMTPMailer
from server.mail_credentials import MailCredentialError


class SMTPMailerTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            'publicOrigin': 'https://pl.example.com',
            'smtp': {'host': 'smtp.resend.com', 'port': 465, 'security': 'ssl',
                     'username': 'resend', 'from': 'no-reply@account.example.com'},
        }

    def test_ready_checks_credentials_without_claiming_delivery(self):
        mailer = SMTPMailer(self.settings)
        with mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
             mock.patch('server.email_accounts.smtplib.SMTP_SSL') as connect:
            self.assertTrue(mailer.ready)
            connect.assert_not_called()
        with mock.patch('server.email_accounts.read_smtp_secret', return_value=''):
            self.assertFalse(mailer.ready)
            with self.assertRaises(AccountError) as error:
                mailer.send('user@example.com', 'verify', 'test-token')
            self.assertEqual(error.exception.status, 503)

    def test_ssl_uses_resolved_secret_and_the_configured_verification_origin(self):
        with mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
             mock.patch('server.email_accounts.smtplib.SMTP_SSL') as connect:
            SMTPMailer(self.settings).send('user@example.com', 'verify', 'test-token')
            smtp = connect.return_value
            smtp.login.assert_called_once_with('resend', 'test-secret')
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(message['From'], 'no-reply@account.example.com')
            self.assertEqual(message['To'], 'user@example.com')
            self.assertIn('https://pl.example.com/account#verify=test-token', message.get_content())
            self.assertNotIn('test-secret', message.as_string())
            self.assertEqual(connect.call_args.args, ('smtp.resend.com', 465))

    def test_starttls_happens_before_authentication(self):
        self.settings['smtp'].update(port=587, security='starttls')
        with mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
             mock.patch('server.email_accounts.smtplib.SMTP') as connect:
            SMTPMailer(self.settings).send('user@example.com', 'reset', 'test-token')
            smtp = connect.return_value
            self.assertEqual([call[0] for call in smtp.method_calls], ['starttls', 'login', 'send_message'])
            message = smtp.send_message.call_args.args[0]
            self.assertIn('/account#reset=test-token', message.get_content())

    def test_code_mail_keeps_registration_and_reset_on_the_original_page(self):
        for purpose in ('verify-code', 'reset-code'):
            with self.subTest(purpose=purpose), \
                 mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
                 mock.patch('server.email_accounts.smtplib.SMTP_SSL') as connect:
                SMTPMailer(self.settings).send('user@example.com', purpose, '000123')
                message = connect.return_value.send_message.call_args.args[0]
                self.assertIn('000123', message.get_content())
                self.assertIn('10 分钟', message.get_content())
                self.assertIn('原网页', message.get_content())
                self.assertNotIn('/account#', message.get_content())
                self.assertNotIn('test-secret', message.as_string())

    def test_code_mail_rejects_non_numeric_or_non_six_digit_values_before_connection(self):
        with mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
             mock.patch('server.email_accounts.smtplib.SMTP_SSL') as connect:
            for value in ('12345', '１２３４５６', '1234567', None):
                with self.subTest(value=value), self.assertRaises(AccountError):
                    SMTPMailer(self.settings).send('user@example.com', 'verify-code', value)
            connect.assert_not_called()

    def test_credential_and_smtp_errors_do_not_expose_private_details(self):
        mailer = SMTPMailer(self.settings)
        with mock.patch('server.email_accounts.read_smtp_secret',
                        side_effect=MailCredentialError()):
            with self.assertRaises(AccountError) as error:
                mailer.ready
            self.assertEqual(str(error.exception), '邮件密钥配置不可用，请联系管理员')
            self.assertEqual(error.exception.status, 503)
        with mock.patch('server.email_accounts.read_smtp_secret', return_value='test-secret'), \
             mock.patch('server.email_accounts.smtplib.SMTP_SSL',
                        side_effect=smtplib.SMTPException('private-smtp-detail')):
            with self.assertRaises(AccountError) as error:
                mailer.send('user@example.com', 'verify', 'test-token')
            self.assertNotIn('private-smtp-detail', str(error.exception))


if __name__ == '__main__':
    unittest.main()
