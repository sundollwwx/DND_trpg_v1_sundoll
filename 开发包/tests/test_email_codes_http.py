"""Exercise the real account HTTP code protocol against temporary fixtures."""
from project_test_paths import APP_ROOT
import unittest
from unittest import mock
import test_email_accounts_http as legacy
from server.web_entrances import WebEntrances

SERVER = legacy.SERVER


class EmailCodeHttpTests(unittest.TestCase):
    setUp = legacy.EmailAccountHttpTests.setUp
    close_server = legacy.EmailAccountHttpTests.close_server
    request = legacy.EmailAccountHttpTests.request
    api = legacy.EmailAccountHttpTests.api
    login = legacy.EmailAccountHttpTests.login

    def register_code(self, email='code@example.com'):
        code, result, headers = self.api('register', {'email':email, 'name':'验证码玩家',
                                                      'password':'你好', 'delivery':'code'})
        self.assertEqual(code, 200, result)
        self.assertRegex(result['challenge'], r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(result['purpose'], 'verify')
        self.assertEqual(result['expiresIn'], 600)
        self.assertNotIn('code', result)
        return result['challenge'], self.mail.messages[-1][2]

    def test_code_verification_sets_private_cookie_and_does_not_create_a_player(self):
        challenge, value = self.register_code()
        code, result, headers = self.api('verify-code', {'challenge':challenge, 'code':value})
        self.assertEqual(code, 200, result)
        self.assertTrue(result['account']['emailVerified'])
        self.assertNotIn('sessionToken', str(result))
        self.assertIn(('Cache-Control', 'no-store, private'), headers)
        cookie = next(value for key,value in headers if key == 'Set-Cookie')
        self.assertIn('; HttpOnly', cookie)
        self.assertIn('; SameSite=Lax', cookie)
        self.assertEqual(self.api('session', method='GET')[1]['account'], result['account'])
        self.assertEqual(self.api('player-session')[0], 409)
        self.assertEqual(self.api('verify-code', {'challenge':challenge, 'code':value})[0], 400)

    def test_verification_replaces_old_cookie_session_like_login(self):
        self.login()
        old = self.cookie.split('=', 1)[1]
        challenge, value = self.register_code()
        self.assertEqual(self.api('verify-code', {'challenge':challenge, 'code':value})[0], 200)
        self.assertIsNone(self.accounts.session(old))
        self.assertEqual(self.api('session', method='GET')[1]['account']['email'], 'code@example.com')

    def test_https_code_verification_keeps_the_host_only_secure_cookie_boundary(self):
        challenge, value = self.register_code()
        entrances = WebEntrances({'webEntrances':{'playerHostname':'pl.example.com'}}, self.root)
        with mock.patch.object(SERVER, 'WEB_ENTRANCES', entrances):
            code, result, headers = self.api('verify-code', {'challenge':challenge, 'code':value},
                headers={'Host':'pl.example.com','Origin':'https://pl.example.com','X-Forwarded-Proto':'https'})
        self.assertEqual(code, 200, result)
        cookie = next(value for key,value in headers if key == 'Set-Cookie')
        self.assertTrue(cookie.startswith('__Host-sundoll-account='))
        self.assertIn('; Secure', cookie)
        self.assertIn('; HttpOnly', cookie)
        self.assertNotIn('Domain=', cookie)

    def test_csrf_content_type_origin_and_purpose_are_checked_before_success(self):
        challenge, value = self.register_code()
        body = {'challenge':challenge, 'code':value}
        for headers, expected in (({'Origin':'https://evil.example'}, 403),
                                  ({'X-Sundoll-Account':''}, 403),
                                  ({'Content-Type':'text/plain'}, 415)):
            self.assertEqual(self.api('verify-code', body, headers=headers)[0], expected)
        self.assertEqual(self.api('reset-code', dict(body, password='新密'))[0], 400)
        self.assertEqual(self.api('verify-code', body)[0], 200)

    def test_cooldown_and_wrong_attempts_have_safe_machine_readable_errors(self):
        now = [1_800_000_000]
        self.accounts.clock = lambda:now[0]
        challenge, value = self.register_code()
        code, result, headers = self.api('resend-code', {'challenge':challenge})
        self.assertEqual(code, 429, result)
        self.assertEqual(result['errorCode'], 'code_cooldown')
        self.assertEqual(result['retryAfter'], 60)
        self.assertIn(('Retry-After', '60'), headers)
        wrong = '999999' if value != '999999' else '000000'
        self.assertEqual(self.api('verify-code', {'challenge':challenge,'code':wrong})[1]['errorCode'], 'code_invalid')
        now[0] += 60
        code, result, headers = self.api('resend-code', {'challenge':challenge})
        self.assertEqual(code, 200, result)
        self.assertNotEqual(result['challenge'], challenge)
        self.assertEqual(self.api('verify-code', {'challenge':challenge, 'code':value})[0], 400)
        self.assertEqual(self.api('verify-code', {'challenge':result['challenge'], 'code':self.mail.messages[-1][2]})[0], 200)

    def test_reset_code_clears_cookie_and_revokes_account_and_player_sessions(self):
        self.login()
        self.api('create-player')
        player = self.api('player-session')[1]['session']['sessionToken']
        old = self.cookie.split('=', 1)[1]
        code, result, _ = self.api('forgot', {'email':'me@example.com', 'delivery':'code'})
        self.assertEqual(code, 200, result)
        self.assertEqual(result['purpose'], 'reset')
        body = {'challenge':result['challenge'], 'code':self.mail.messages[-1][2], 'password':'新密'}
        code, result, headers = self.api('reset-code', body)
        self.assertEqual(code, 200, result)
        self.assertTrue(any(key == 'Set-Cookie' and 'Max-Age=0' in value for key,value in headers))
        self.assertIsNone(self.accounts.session(old))
        self.assertEqual(self.request({'sessionToken':player}, path='/api/session')[0], 401)
        self.assertEqual(self.api('login', {'email':'me@example.com','password':'新密'})[0], 200)

    def test_public_code_responses_do_not_reveal_address_existence(self):
        self.login()
        _, known, _ = self.api('register', {'email':'me@example.com','name':'玩家','password':'新密','delivery':'code'})
        _, new, _ = self.api('register', {'email':'new@example.com','name':'玩家','password':'新密','delivery':'code'})
        self.assertEqual({k:v for k,v in known.items() if k != 'challenge'},
                         {k:v for k,v in new.items() if k != 'challenge'})
        _, known, _ = self.api('forgot', {'email':'me@example.com','delivery':'code'})
        _, missing, _ = self.api('forgot', {'email':'missing@example.com','delivery':'code'})
        self.assertEqual({k:v for k,v in known.items() if k != 'challenge'},
                         {k:v for k,v in missing.items() if k != 'challenge'})

    def test_share_actions_forward_only_the_logged_in_cookie_and_declared_inputs(self):
        self.login()
        directory = mock.Mock()
        directory.share.return_value = {'token':'share-token','expiresAt':12345}
        directory.join.return_value = {'id':'room-id','role':'player'}
        with mock.patch.dict(self.settings, roomsEnabled=True), \
             mock.patch('server.room_gateway.rooms', return_value=directory):
            code, result, _ = self.api('room-share', {'roomId':'room-id','role':'owner','accountId':'forged'})
            self.assertEqual(code, 200, result)
            self.assertEqual(result['invitationUrl'], f'http://127.0.0.1:{self.port}/account#join=share-token')
            directory.share.assert_called_once_with(self.cookie.split('=',1)[1], 'room-id')
            self.assertEqual(self.api('room-join', {'token':'share-token','role':'owner'})[1]['room']['role'], 'player')
            directory.join.assert_called_once_with(self.cookie.split('=',1)[1], 'share-token')
            self.assertEqual(self.api('room-share-revoke', {'roomId':'room-id'})[0], 200)
            directory.revoke_share.assert_called_once_with(self.cookie.split('=',1)[1], 'room-id')


if __name__ == '__main__':
    unittest.main()
