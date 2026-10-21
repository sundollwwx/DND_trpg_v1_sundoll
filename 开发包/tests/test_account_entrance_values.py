from project_test_paths import APP_ROOT
from types import SimpleNamespace
from unittest import TestCase
from pathlib import Path
from server.web_entrances import WebEntrances


class AccountEntranceValuesTests(TestCase):
    def setUp(self):
        self.portal = WebEntrances({'webEntrances': {
            'mainHostname': 'sundollworld.com', 'playerHostname': 'pl.sundollworld.com',
            'dmHostname': 'dm.sundollworld.com',
        }}, '/nonexistent-isolated-entrance-test')

    def handler(self, host, peer='127.0.0.1'):
        return SimpleNamespace(headers={'Host': host}, client_address=(peer, 44000))

    def test_personal_campaign_and_original_workspace_have_separate_public_links(self):
        for host in ('sundollworld.com', 'pl.sundollworld.com', 'dm.sundollworld.com'):
            with self.subTest(host=host):
                values = self.portal.page_values(self.handler(host), {'enabled': True, 'roomsEnabled': True})
                self.assertEqual(values['accountUrl'], 'https://pl.sundollworld.com/account')
                self.assertEqual(values['administratorUrl'], 'https://dm.sundollworld.com/login')
                self.assertEqual(values['entranceMode'], 'account')
                self.assertEqual(values['accountTitle'], '进入我的战役')
                self.assertIn('DM', values['accountIntro'])

    def test_loopback_entry_does_not_depend_on_public_tunnel(self):
        for host in ('localhost:8090', '127.0.0.1:8090', '[::1]:8090'):
            with self.subTest(host=host):
                values = self.portal.page_values(self.handler(host), {'enabled': True, 'roomsEnabled': True})
                self.assertEqual(values['accountUrl'], '/account')
                self.assertEqual(values['administratorUrl'], '/主控台/主控台.html')
        remote = self.portal.page_values(self.handler('127.0.0.1:8090', '192.0.2.3'), {'enabled': True})
        self.assertEqual(remote['accountUrl'], 'https://pl.sundollworld.com/account')

    def test_disabled_account_mode_retains_legacy_entrances(self):
        values = self.portal.page_values(self.handler('sundollworld.com'), {'enabled': False, 'roomsEnabled': True})
        self.assertEqual(values['entranceMode'], 'legacy')
        self.assertEqual(values['dmUrl'], 'https://dm.sundollworld.com')
        self.assertEqual(values['playerUrl'], 'https://pl.sundollworld.com')

    def test_email_without_rooms_does_not_advertise_personal_dm_spaces(self):
        values = self.portal.page_values(self.handler('sundollworld.com'), {'enabled': True, 'roomsEnabled': False})
        self.assertEqual(values['entranceMode'], 'account')
        self.assertEqual(values['accountTitle'], '进入玩家账号')
        self.assertNotIn('DM', values['accountIntro'])

    def test_main_and_administrator_templates_have_no_unresolved_account_navigation(self):
        from html import escape
        values = self.portal.page_values(self.handler('sundollworld.com'), {'enabled': True, 'roomsEnabled': True})
        for filename in ('home.html', 'dm-login.html'):
            with self.subTest(filename=filename):
                source = (APP_ROOT / 'web' / filename).read_text('utf-8')
                for key, value in values.items():
                    source = source.replace('{{' + key + '}}', escape(value, quote=True))
                self.assertNotIn('{{', source)
                self.assertIn('https://pl.sundollworld.com/account', source)
                self.assertIn('原工作区管理', source)
