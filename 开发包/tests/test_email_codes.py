"""Email codes use disposable accounts and a memory-only delivery service."""
from project_test_paths import APP_ROOT
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from server.email_accounts import AccountError, AccountStore, token_hash
from test_email_accounts import Mailbox


class EmailCodeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='sundoll-email-codes-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.now = 1_800_000_000
        self.mail = Mailbox()
        self.settings = {'enabled':True, 'publicOrigin':'https://pl.example.test'}
        self.store = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        self.email = 'one@example.test'

    def register(self, password='你好'):
        result = self.store.register_code(self.email, '玩家', password)
        return result['challenge'], self.mail.messages[-1][2]

    def verified(self, password='你好'):
        challenge, code = self.register(password)
        return self.store.verify_code(challenge, code)[0]

    def reset_challenge(self):
        result = self.store.forgot_code(self.email)
        return result['challenge'], self.mail.messages[-1][2]

    def test_registration_code_creates_verified_session_once_without_plaintext_storage(self):
        challenge, code = self.register('密' * 256)
        self.assertRegex(code, r'^[0-9]{6}$')
        self.assertEqual(self.mail.messages[-1][1], 'verify-code')
        with self.store.db() as db:
            row = db.execute('SELECT * FROM code_challenges').fetchone()
            self.assertEqual(row['hash'], token_hash(challenge))
            self.assertNotEqual(row['code_hash'], token_hash(code))
            self.assertFalse(db.execute('SELECT verified FROM accounts').fetchone()[0])
            serialized = json.dumps(dict(row))
            for secret in (challenge, '密' * 256): self.assertNotIn(secret, serialized)
            self.assertNotIn(code, (row['hash'], row['code_hash'], row['email_hash']))
        session, account = self.store.verify_code(challenge, code)
        self.assertTrue(account['emailVerified'])
        self.assertEqual(self.store.session(session), account)
        with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
        self.assertTrue(self.store.login(self.email, '密' * 256))

    def test_four_wrong_attempts_allow_correct_retry_and_restart_keeps_budget(self):
        challenge, code = self.register()
        wrong = '999999' if code != '999999' else '000000'
        for _ in range(4):
            with self.assertRaises(AccountError) as error: self.store.verify_code(challenge, wrong)
            self.assertEqual(error.exception.code, 'code_invalid')
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        self.assertTrue(restarted.verify_code(challenge, code)[1]['emailVerified'])

    def test_fifth_wrong_attempt_locks_code_even_when_next_guess_is_correct(self):
        challenge, code = self.register()
        for value in (None, 123456, '１２３４５６', '1', 'abcdef'):
            with self.assertRaises(AccountError): self.store.verify_code(challenge, value)
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        with self.assertRaises(AccountError) as error: restarted.verify_code(challenge, code)
        self.assertEqual(error.exception.status, 429)
        self.assertEqual(error.exception.code, 'code_attempts')
        with restarted.db() as db:
            self.assertEqual(db.execute('SELECT attempts FROM code_challenges').fetchone()[0], 5)
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)

    def test_resend_rotates_handle_code_and_rejects_old_code_under_new_handle(self):
        with mock.patch('server.email_accounts.secrets.randbelow', return_value=10):
            old, old_code = self.register()
            with self.assertRaises(AccountError) as error: self.store.resend_code(old)
            self.assertEqual(error.exception.code, 'code_cooldown')
            self.assertEqual(error.exception.retry_after, 60)
            self.now += 60
            reply = self.store.resend_code(old)
        current, current_code = reply['challenge'], self.mail.messages[-1][2]
        self.assertNotEqual(current, old)
        self.assertNotEqual(current_code, old_code)
        with self.assertRaises(AccountError): self.store.verify_code(old, old_code)
        with self.assertRaises(AccountError): self.store.verify_code(current, old_code)
        self.assertTrue(self.store.verify_code(current, current_code)[1]['emailVerified'])

    def test_expired_code_can_be_resent_but_an_hour_old_handle_cannot(self):
        challenge, code = self.register()
        self.now += 600
        with self.assertRaises(AccountError) as error: self.store.verify_code(challenge, code)
        self.assertEqual(error.exception.code, 'code_expired')
        current = self.store.resend_code(challenge)['challenge']
        code = self.mail.messages[-1][2]
        self.now += 3600
        with self.assertRaises(AccountError): self.store.resend_code(current)
        with self.assertRaises(AccountError): self.store.verify_code(current, code)

    def test_email_attempt_limit_spans_rotations_purposes_and_store_instances(self):
        self.verified()
        challenge, code = self.reset_challenge()
        wrong = '999999' if code != '999999' else '000000'
        # Verification already consumed one attempt; three locked reset codes
        # approach/exceed the same persisted email budget across rotations.
        for rotation in range(3):
            for _ in range(5):
                with self.assertRaises(AccountError): self.store.reset_code(challenge, wrong, '新密')
            if rotation < 2:
                self.now += 60
                challenge = self.store.resend_code(challenge)['challenge']
                code = self.mail.messages[-1][2]
                wrong = '999999' if code != '999999' else '000000'
        self.now += 60
        phantom = self.store.register_code(self.email, '不会覆盖', '新密')['challenge']
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        with self.assertRaises(AccountError) as error: restarted.verify_code(phantom, '123456')
        self.assertEqual(error.exception.status, 429)
        self.now += 901
        with self.assertRaises(AccountError) as error: restarted.verify_code(phantom, '123456')
        self.assertNotEqual(error.exception.status, 429)

    def test_send_budget_is_persisted_and_not_reset_by_resending(self):
        challenge, _ = self.register()
        for _ in range(2):
            self.now += 60
            challenge = self.store.resend_code(challenge)['challenge']
        self.now += 60
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        with self.assertRaises(AccountError) as error: restarted.resend_code(challenge)
        self.assertEqual(error.exception.status, 429)
        self.assertGreater(error.exception.retry_after, 0)
        self.assertEqual(len(self.mail.messages), 3)

    def test_reset_invalid_password_does_not_consume_code_and_success_revokes_sessions(self):
        first = self.verified()
        second = self.store.login(self.email, '你好')[0]
        challenge, code = self.reset_challenge()
        for password in ('x', 'x' * 257):
            with self.assertRaises(AccountError): self.store.reset_code(challenge, code, password)
        self.assertTrue(self.store.session(first))
        self.assertTrue(self.store.session(second))
        with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
        self.store.reset_code(challenge, code, '新密')
        self.assertIsNone(self.store.session(first))
        self.assertIsNone(self.store.session(second))
        self.assertTrue(self.store.login(self.email, '新密'))
        with self.assertRaises(AccountError): self.store.reset_code(challenge, code, '新密')

    def test_registered_and_missing_addresses_have_the_same_public_reply_shape(self):
        session = self.verified()
        before = self.store.session(session)
        current = self.store.register_code(self.email, '冒名', '错误密码')
        missing = self.store.register_code('new@example.test', '冒名', '错误密码')
        self.assertEqual({k:v for k,v in current.items() if k != 'challenge'},
                         {k:v for k,v in missing.items() if k != 'challenge'})
        self.assertEqual(self.store.session(session), before)
        real = self.store.forgot_code(self.email)
        phantom = self.store.forgot_code('missing@example.test')
        self.assertEqual({k:v for k,v in real.items() if k != 'challenge'},
                         {k:v for k,v in phantom.items() if k != 'challenge'})
        with self.assertRaises(AccountError): self.store.reset_code(phantom['challenge'], '123456', '新密')
        self.assertTrue(self.store.login(self.email, '你好'))

    def test_legacy_requests_and_code_requests_replace_previous_challenges(self):
        self.store.register(self.email, '玩家', '旧密')
        legacy = self.mail.messages[-1][2]
        challenge, code = self.register()
        with self.assertRaises(AccountError): self.store.verify(legacy, '你好')
        self.store.register(self.email, '玩家', '新密')
        legacy = self.mail.messages[-1][2]
        with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
        self.store.verify(legacy, '新密')
        challenge, code = self.reset_challenge()
        self.store.forgot(self.email)
        legacy = self.mail.messages[-1][2]
        with self.assertRaises(AccountError): self.store.reset_code(challenge, code, '最新')
        self.store.reset(legacy, '最新')
        self.assertTrue(self.store.login(self.email, '最新'))

    def test_account_version_and_disabled_state_prevent_old_code_authorization(self):
        for column, value in (('version', 99), ('enabled', 0)):
            with self.subTest(column=column):
                challenge, code = self.register()
                with self.store.db() as db: db.execute('UPDATE accounts SET ' + column + '=?', (value,))
                with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
                with self.store.db() as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
                    db.execute('DELETE FROM accounts')
                    db.execute('DELETE FROM code_challenges')
                    db.execute('DELETE FROM attempts')

    def test_epoch_change_revokes_codes_and_shares_but_preserves_join_blocks(self):
        generation = ['before']
        self.store.epoch = lambda:generation[0]
        challenge, code = self.register()
        with self.store.db() as db:
            db.executescript('CREATE TABLE room_share_links (id TEXT); CREATE TABLE room_join_blocks (id TEXT);')
            db.execute("INSERT INTO room_share_links VALUES ('share')")
            db.execute("INSERT INTO room_join_blocks VALUES ('block')")
        generation[0] = 'after'
        with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM room_share_links').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM room_join_blocks').fetchone()[0], 1)

    def test_concurrent_verification_commits_one_session_only(self):
        challenge, code = self.register()
        def verify(_):
            try: return bool(self.store.verify_code(challenge, code))
            except AccountError: return False
        with ThreadPoolExecutor(2) as pool: self.assertEqual(sorted(pool.map(verify, range(2))), [False, True])
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 1)

    def test_send_failure_discards_failed_code_and_hides_transport_details(self):
        with mock.patch.object(self.mail, 'send', side_effect=OSError('private transport details')):
            with self.assertRaises(AccountError) as error: self.register()
        self.assertEqual(error.exception.status, 503)
        self.assertNotIn('private', str(error.exception))
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM code_challenges').fetchone()[0], 0)

    def test_registration_password_and_mail_availability_boundaries_are_preserved(self):
        for index, password in enumerate(('', 'x', 'x' * 257, None)):
            with self.subTest(passwordLength=len(password) if isinstance(password, str) else None), self.assertRaises(AccountError):
                self.store.register_code(f'bad{index}@example.test', '玩家', password)
        self.assertEqual(self.mail.messages, [])
        self.mail.ready = False
        with self.assertRaises(AccountError) as error: self.store.register_code(self.email, '玩家', '你好')
        self.assertEqual(error.exception.status, 503)
        with self.assertRaises(AccountError): self.store.forgot_code(self.email)

    def test_failed_resend_keeps_the_original_hash_budget_and_expiry_for_a_real_retry(self):
        challenge, code = self.register()
        for _ in range(2):
            with self.assertRaises(AccountError): self.store.verify_code(challenge, 'not-a-code')
        with self.store.db() as db: before = dict(db.execute('SELECT * FROM code_challenges').fetchone())
        self.now += 60
        with mock.patch.object(self.mail, 'send', side_effect=OSError('failed delivery')):
            with self.assertRaises(AccountError) as error: self.store.resend_code(challenge)
        self.assertEqual(error.exception.status, 503)
        with self.store.db() as db:
            rows = db.execute('SELECT * FROM code_challenges').fetchall()
            self.assertEqual([dict(row) for row in rows], [before])
        replacement = self.store.resend_code(challenge)['challenge']
        self.assertTrue(self.store.verify_code(replacement, self.mail.messages[-1][2]))

    def test_a_pending_resend_code_cannot_authorize_before_delivery_commits(self):
        challenge, _ = self.register()
        self.now += 60
        send = self.store._send_code
        def probe(email, purpose, current, code):
            with self.assertRaises(AccountError): self.store.verify_code(current, code)
            return send(email, purpose, current, code)
        with mock.patch.object(self.store, '_send_code', side_effect=probe):
            replacement = self.store.resend_code(challenge)['challenge']
        self.assertTrue(self.store.verify_code(replacement, self.mail.messages[-1][2]))

    def test_late_resend_never_resurrects_a_consumed_nonce_after_another_reset_consumes_all_rows(self):
        challenge, original_code = self.register()
        self.now += 60
        original_send = self.mail.send
        def consume_during_delivery(email, purpose, code):
            original_send(email, purpose, code)
            if purpose != 'verify-code': return
            self.store.verify_code(challenge, original_code)
            reset = self.store.forgot_code(self.email)['challenge']
            self.store.reset_code(reset, self.mail.messages[-1][2], '新密')
        with mock.patch.object(self.mail, 'send', side_effect=consume_during_delivery):
            with self.assertRaises(AccountError) as error: self.store.resend_code(challenge)
        self.assertEqual(error.exception.status, 409)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM code_challenges').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
        self.assertTrue(self.store.login(self.email, '新密'))

    def test_an_earlier_delivery_cannot_replace_a_newer_successful_resend(self):
        challenge, _ = self.register()
        self.now += 60
        original_send, completed = self.mail.send, []
        def newer_during_delivery(email, purpose, code):
            original_send(email, purpose, code)
            if completed: return
            completed.append(None)
            self.now += 60
            completed[0] = self.store.resend_code(challenge)['challenge']
        with mock.patch.object(self.mail, 'send', side_effect=newer_during_delivery):
            with self.assertRaises(AccountError) as error: self.store.resend_code(challenge)
        self.assertEqual(error.exception.status, 409)
        current_code = self.mail.messages[-1][2]
        self.assertTrue(self.store.verify_code(completed[0], current_code))

    def test_account_version_changes_during_delivery_cannot_activate_a_stale_resend(self):
        challenge, code = self.register()
        self.now += 60
        def change_version(*args):
            with self.store.db() as db: db.execute('UPDATE accounts SET version=version+1')
        with mock.patch.object(self.mail, 'send', side_effect=change_version):
            with self.assertRaises(AccountError): self.store.resend_code(challenge)
        with self.assertRaises(AccountError): self.store.verify_code(challenge, code)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM sessions').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM code_challenges WHERE active=0').fetchone()[0], 0)

    def test_existing_database_initialization_preserves_accounts_and_sessions(self):
        session = self.verified()
        with self.store.db() as db: db.execute('DROP TABLE code_challenges')
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        self.assertTrue(restarted.session(session))
        self.assertIn('challenge', restarted.forgot_code(self.email))

    def test_pending_delivery_schema_upgrade_keeps_existing_active_codes_and_sessions(self):
        session = self.verified()
        reply = self.store.register_code('pending@example.test', '另一位', '你好')
        code = self.mail.messages[-1][2]
        columns = 'hash,account_id,purpose,code_hash,email_hash,version,expires,created,attempts'
        with self.store.db() as db:
            db.execute('CREATE TABLE prior_codes (hash TEXT PRIMARY KEY,account_id TEXT,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,email_hash TEXT NOT NULL,version INTEGER NOT NULL,expires REAL NOT NULL,created REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)')
            db.execute('INSERT INTO prior_codes SELECT ' + columns + ' FROM code_challenges')
            db.execute('DROP TABLE code_challenges')
            db.execute('ALTER TABLE prior_codes RENAME TO code_challenges')
        restarted = AccountStore(self.root, self.settings, mailer=self.mail, clock=lambda:self.now)
        self.assertTrue(restarted.session(session))
        self.assertTrue(restarted.verify_code(reply['challenge'], code)[1]['emailVerified'])


if __name__ == '__main__':
    unittest.main()
