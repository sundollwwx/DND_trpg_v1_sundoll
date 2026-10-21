from project_test_paths import APP_ROOT
import sys
sys.path.insert(0, str(APP_ROOT))
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from server.email_accounts import AccountStore, AccountError, email_key, read_settings
from server.player_profiles import Store, ProfileError, LOCK

PASSWORD = 'This is my test password 2026'
NEW_PASSWORD = 'This is a changed password 2026'


class Mailbox:
    ready = True
    def __init__(self): self.messages = []
    def send(self, email, purpose, token): self.messages.append((email,purpose,token))


class EmailAccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1_800_000_000
        self.mail = Mailbox()
        self.settings = {'enabled':True,'publicOrigin':'https://pl.example.com'}
        self.store = AccountStore(self.root/'auth',self.settings,mailer=self.mail,clock=lambda:self.now)
        self.profiles = Store(self.root/'save',self.root,self.root/'cache')

    def register(self, email='one@example.com', name='邮箱玩家'):
        self.store.register(email,name,PASSWORD)
        return self.mail.messages[-1][2]

    def login(self, email='one@example.com', name='邮箱玩家'):
        token = self.register(email,name)
        self.store.verify(token,PASSWORD)
        return self.store.login(email,PASSWORD)[0]

    def test_verification_requires_both_mail_token_and_registration_password(self):
        token = self.register()
        with self.assertRaises(AccountError): self.store.login('one@example.com',PASSWORD)
        with self.assertRaises(AccountError): self.store.verify(token,'Someone elses password')
        self.store.verify(token,PASSWORD)
        self.assertTrue(self.store.session(self.store.login('ONE@example.com',PASSWORD)[0])['emailVerified'])
        with self.assertRaises(AccountError): self.store.verify(token,PASSWORD)

    def test_challenges_are_expiring_one_time_and_not_interchangeable(self):
        token = self.register()
        with self.assertRaises(AccountError): self.store.reset(token,NEW_PASSWORD)
        self.now += 86401
        with self.assertRaises(AccountError): self.store.verify(token,PASSWORD)

    def test_registration_never_changes_a_verified_account_password_or_name(self):
        session = self.login()
        before = self.store.session(session)
        self.store.register('ONE@example.com','恶意昵称',NEW_PASSWORD)
        self.assertEqual(self.store.session(session),before)
        self.assertTrue(self.store.login('one@example.com',PASSWORD))
        with self.assertRaises(AccountError): self.store.login('one@example.com',NEW_PASSWORD)

    def test_pending_registration_replaces_previous_token_and_password(self):
        old = self.register()
        self.store.register('one@example.com','新昵称',NEW_PASSWORD)
        token = self.mail.messages[-1][2]
        with self.assertRaises(AccountError): self.store.verify(old,PASSWORD)
        with self.assertRaises(AccountError): self.store.verify(token,PASSWORD)
        self.store.verify(token,NEW_PASSWORD)

    def test_reset_revokes_all_sessions_and_previous_reset_links(self):
        first = self.login()
        second = self.store.login('one@example.com',PASSWORD)[0]
        self.store.forgot('one@example.com'); old = self.mail.messages[-1][2]
        self.store.forgot('one@example.com'); token = self.mail.messages[-1][2]
        with self.assertRaises(AccountError): self.store.reset(old,NEW_PASSWORD)
        self.store.reset(token,NEW_PASSWORD)
        self.assertIsNone(self.store.session(first));self.assertIsNone(self.store.session(second))
        with self.assertRaises(AccountError): self.store.reset(token,PASSWORD)
        self.assertTrue(self.store.login('one@example.com',NEW_PASSWORD))

    def test_reset_expiry_and_disabled_accounts(self):
        session = self.login()
        self.store.forgot('one@example.com'); token = self.mail.messages[-1][2]
        self.now += 1801
        with self.assertRaises(AccountError): self.store.reset(token,NEW_PASSWORD)
        with self.store.db() as db: db.execute('UPDATE accounts SET enabled=0')
        self.assertIsNone(self.store.session(session))
        with self.assertRaises(AccountError): self.store.login('one@example.com',PASSWORD)

    def test_no_plaintext_password_or_bearer_tokens_in_database(self):
        token = self.register();self.store.verify(token,PASSWORD)
        session = self.store.login('one@example.com',PASSWORD)[0]
        data = self.store.path.read_bytes()
        for secret in (PASSWORD,token,session): self.assertNotIn(secret.encode(),data)
        self.assertEqual(self.store.path.stat().st_mode & 0o777,0o600)

    def test_missing_initialized_database_never_creates_empty_replacement(self):
        self.store.initialize()
        self.store.path.rename(self.store.path.with_suffix('.retained'))
        for store in (self.store, AccountStore(self.store.root, self.settings, mailer=self.mail)):
            with self.assertRaisesRegex(AccountError, '数据库缺失'):
                with store.db(): pass
            self.assertFalse(self.store.path.exists())

    def test_restart_does_not_recreate_a_missing_account_table(self):
        self.store.initialize()
        with self.store.db() as db: db.execute('DROP TABLE accounts')
        restarted = AccountStore(self.store.root, self.settings, mailer=self.mail)
        with self.assertRaisesRegex(AccountError, '结构不完整'): restarted.initialize()
        import sqlite3
        with sqlite3.connect(self.store.path) as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='accounts'").fetchone())

    def test_forgot_does_not_reveal_whether_email_exists(self):
        self.login()
        self.assertEqual(self.store.forgot('one@example.com'),self.store.forgot('missing@example.com'))
        self.assertEqual(len(self.mail.messages),2)

    def test_logout_only_revokes_current_session_and_restart_preserves_others(self):
        first = self.login(); second = self.store.login('one@example.com',PASSWORD)[0]
        self.store.logout(first)
        restarted = AccountStore(self.store.root,self.settings,mailer=self.mail,clock=lambda:self.now)
        self.assertIsNone(restarted.session(first));self.assertTrue(restarted.session(second))
        self.now += 7*86400+1
        self.assertIsNone(restarted.session(second))

    def test_email_normalization_does_not_merge_provider_aliases(self):
        self.assertEqual(email_key(' Me@EXAMPLE.COM '),'me@example.com')
        self.assertNotEqual(email_key('m.e@example.com'),email_key('me@example.com'))
        self.assertNotEqual(email_key('me+x@example.com'),email_key('me@example.com'))
        for invalid in ('x\n@example.com','x@-example.com','x@foo..com','a..b@example.com','x@localhost'):
            with self.assertRaises(AccountError): email_key(invalid)

    def test_short_password_and_malformed_configuration_fail_closed(self):
        with self.assertRaises(AccountError): self.store.register('one@example.com','昵称','x')
        self.store.root.mkdir(exist_ok=True)
        path = self.store.root/'邮箱账号设置.json';path.write_text('{broken')
        with self.assertRaises(RuntimeError): read_settings(self.store.root)
        path.write_text(json.dumps({'enabled':True,'publicOrigin':'http://unsafe.example.com'}))
        with self.assertRaises(RuntimeError): read_settings(self.store.root)

    def test_new_password_range_applies_to_registration_reset_and_login(self):
        for index, password in enumerate(('', 'x', 'x' * 257)):
            with self.subTest(length=len(password)), self.assertRaises(AccountError):
                self.store.register(f'bad{index}@example.com', '昵称', password)
        self.store.register('one@example.com', '昵称', '你好')
        self.store.verify(self.mail.messages[-1][2], '你好')
        self.assertTrue(self.store.login('one@example.com', '你好'))
        self.store.forgot('one@example.com')
        token = self.mail.messages[-1][2]
        for password in ('x', 'x' * 257):
            with self.subTest(resetLength=len(password)), self.assertRaises(AccountError):
                self.store.reset(token, password)
        password = '密' * 256
        self.store.reset(token, password)
        self.assertTrue(self.store.login('one@example.com', password))

    def test_unconfigured_or_failed_smtp_does_not_claim_delivery(self):
        self.mail.ready = False
        with self.assertRaises(AccountError): self.register()
        self.mail.ready = True
        with mock.patch.object(self.mail,'send',side_effect=OSError('private SMTP details')):
            with self.assertRaises(AccountError) as result: self.register()
        self.assertNotIn('private',str(result.exception))
        with self.store.db() as db: self.assertEqual(db.execute('SELECT count(*) FROM challenges').fetchone()[0],0)

    def test_rate_limits_persist_across_store_instances(self):
        for _ in range(2): self.store.rate('test','peer',2,60)
        restarted = AccountStore(self.store.root,self.settings,clock=lambda:self.now)
        with self.assertRaises(AccountError) as error: restarted.rate('test','peer',2,60)
        self.assertEqual(error.exception.status,429)
        self.now += 61;restarted.rate('test','peer',2,60)

    def test_concurrent_verification_consumes_token_exactly_once(self):
        token = self.register()
        def verify(_):
            try: self.store.verify(token,PASSWORD);return True
            except AccountError:return False
        with ThreadPoolExecutor(2) as pool: self.assertEqual(sorted(pool.map(verify,range(2))),[False,True])

    def test_binding_needs_admin_invitation_and_matching_verified_email(self):
        existing = self.profiles.create('原玩家')['profile']['playerId']
        before = self.profiles.library(existing)
        first = self.login(); second = self.login('two@example.com','另一位')
        invite = self.store.invite('one@example.com',existing,self.profiles)
        with self.assertRaises(AccountError): self.store.bind(second,invite,self.profiles)
        self.store.bind(first,invite,self.profiles)
        self.assertEqual(self.store.session(first)['playerId'],existing)
        self.assertEqual(self.profiles.library(existing),before)
        with self.assertRaises(AccountError): self.store.bind(first,invite,self.profiles)
        with self.assertRaises(AccountError): self.store.invite('two@example.com',existing,self.profiles)

    def test_new_account_cannot_claim_existing_player_by_name_or_replace_binding(self):
        existing = self.profiles.create('邮箱玩家')['profile']['playerId']
        token = self.login()
        with self.assertRaises(AccountError): self.store.player(token,self.profiles)
        with self.assertRaises(ProfileError): self.store.player(token,self.profiles,create=True)
        self.assertFalse(self.store.session(token)['playerId'])
        profile = self.store.player(token,self.profiles,create=True,name='新玩家')
        self.assertNotEqual(profile['playerId'],existing)
        invitation = self.store.invite('one@example.com',existing,self.profiles)
        with self.assertRaises(AccountError): self.store.bind(token,invitation,self.profiles)

    def test_profile_creation_retry_preserves_identity(self):
        token = self.login()
        with LOCK:
            first = self.store.player(token,self.profiles,create=True)
            second = self.store.player(token,self.profiles,create=True)
        self.assertEqual(first['playerId'],second['playerId'])
        self.assertEqual(len(self.profiles.players()),1)
        # A registered account's data cannot be deleted by the legacy profile
        # action. Retrying creation or a rejected deletion must retain identity.
        with self.assertRaises(ProfileError) as caught:
            self.profiles.delete(first['playerId'])
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(self.store.player(token,self.profiles)['playerId'],first['playerId'])
        self.assertEqual(len(self.profiles.players()),1)

    def test_interrupted_profile_binding_recovers_committed_identity(self):
        token = self.login()
        create = self.profiles.create
        def interrupted(*args, **kwargs):
            create(*args, **kwargs)
            raise OSError('reply interrupted after profile creation')
        with mock.patch.object(self.profiles,'create',side_effect=interrupted):
            with self.assertRaises(OSError): self.store.player(token,self.profiles,create=True)
        profile = self.store.player(token,self.profiles,create=True)
        self.assertEqual(len(self.profiles.players()),1)
        self.assertEqual(profile['playerId'],self.profiles.players()[0]['playerId'])

    def test_workspace_restore_invalidates_sessions_and_mail_links(self):
        generation = ['before']
        self.store.epoch = lambda:generation[0]
        session = self.login()
        self.store.forgot('one@example.com'); reset = self.mail.messages[-1][2]
        generation[0] = 'after'
        self.assertIsNone(self.store.session(session))
        with self.assertRaises(AccountError): self.store.reset(reset,NEW_PASSWORD)
        self.assertTrue(self.store.login('one@example.com',PASSWORD))

    def test_workspace_backup_uses_consistent_account_database_snapshot(self):
        import sqlite3
        from server.workspace import enable, Workspace
        from server.module_runtime import ModuleRuntime
        from server.workspace_backup import Backups
        save = enable(self.root/'workspace')
        ModuleRuntime(save,APP_ROOT).ensure_empty_runtime()
        accounts = AccountStore(Workspace(save).auth,self.settings,mailer=self.mail)
        accounts.register('backup@example.com','备份玩家',PASSWORD)
        accounts.verify(self.mail.messages[-1][2],PASSWORD)
        backups = Backups(save)
        result = backups.create('邮箱账号备份')
        path = backups.path(result['id'])/'数据/运行数据/认证/邮箱账号.sqlite3'
        db = sqlite3.connect(path)
        try:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT email,verified FROM accounts').fetchone(),('backup@example.com',1))
        finally: db.close()
        self.assertFalse(Backups.allowed('运行数据/认证/邮箱账号.sqlite3-journal'))


if __name__ == '__main__': unittest.main()
