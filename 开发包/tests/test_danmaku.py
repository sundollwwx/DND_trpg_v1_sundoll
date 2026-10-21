import copy
import unittest
from unittest import mock
import test_player_profiles as fixtures
SERVER = fixtures.SERVER


class DanmakuHttpTests(unittest.TestCase):
    setUp = fixtures.PlayerProfileHttpTests.setUp
    close_server = fixtures.PlayerProfileHttpTests.close_server
    request = fixtures.PlayerProfileHttpTests.request
    login = fixtures.PlayerProfileHttpTests.login

    def prepare(self):
        for name, value in [('STATE', {'campaignId': 'danmaku-test', 'maps': []}),
                            ('DANMAKU_RATE', {}), ('ACTION_RATE', {}), ('ACTION_IDS', {})]:
            patch = mock.patch.object(SERVER, name, value)
            patch.start(); self.addCleanup(patch.stop)
        token = self.login()
        SERVER.broadcast.reset_mock()
        return token

    def send(self, token, text, **extra):
        return self.request({'sessionToken': token, 'action': dict(op='danmaku', text=text, **extra)}, path='/api/action')

    def test_player_name_and_role_are_authoritative_and_not_saved(self):
        token = self.prepare()
        before = copy.deepcopy(SERVER.STATE)
        history = copy.deepcopy(SERVER.RECENT_ACTIONS)
        status, result = self.send(token, '<img src=x onerror=alert(1)>', name='DM', role='dm', actor='forged')
        self.assertEqual(status, 200)
        message = result['action']
        self.assertEqual(message['name'], '甲')
        self.assertEqual(message['role'], 'player')
        self.assertNotIn('actor', message)
        self.assertEqual(message['text'], '<img src=x onerror=alert(1)>')
        self.assertEqual(SERVER.broadcast.call_args.args[0]['action'], message)
        self.assertEqual(SERVER.STATE, before)
        self.assertEqual(SERVER.RECENT_ACTIONS, history)

    def test_dm_sender_is_automatic(self):
        self.prepare()
        status, result = self.request({'action': {'op': 'danmaku', 'text': '开团！', 'name': '假名字'}}, host=True, path='/api/host-action')
        self.assertEqual(status, 200)
        self.assertEqual(result['action']['name'], 'DM')
        self.assertEqual(result['action']['role'], 'dm')

    def test_empty_long_invalid_and_unauthenticated_messages_rejected(self):
        token = self.prepare()
        for text in ('', '   ', '字'*121, None, ['x'], '\x00'):
            self.assertEqual(self.send(token, text)[0], 400)
        self.assertEqual(self.send('invalid-session', 'hello')[0], 401)
        self.assertFalse(SERVER.broadcast.called)

    def test_cooldown_and_campaign_boundary(self):
        token = self.prepare()
        self.assertEqual(self.send(token, '第一条')[0], 200)
        self.assertEqual(self.send(token, '第二条')[0], 429)
        self.assertEqual(self.request({'sessionToken': token, 'campaignId': 'wrong', 'action': {'op':'danmaku','text':'跨战役'}}, path='/api/action')[0], 409)
        self.assertEqual(self.request({'campaignId': 'wrong', 'action': {'op':'danmaku','text':'跨战役'}}, host=True, path='/api/host-action')[0], 409)

    def test_remote_dm_endpoint_and_unpublished_room_rejected(self):
        token = self.prepare()
        with mock.patch.object(SERVER, 'host_request_allowed', return_value=False):
            status, _ = self.request({'action': {'op':'danmaku','text':'冒充 DM'}}, path='/api/host-action')
            self.assertEqual(status, 403)
        with mock.patch.object(SERVER, 'STATE', None):
            self.assertEqual(self.send(token, '尚未开团')[0], 409)
        self.assertFalse(SERVER.broadcast.called)

    def test_public_assets_allowed(self):
        self.prepare()
        from project_test_paths import APP_ROOT
        with mock.patch.object(SERVER, 'ROOT', str(APP_ROOT)):
            for path in ('danmaku.js', 'danmaku.css'):
                from urllib.parse import quote
                status, body = self.request(path=quote('/主控台/shared/'+path), method='GET')
                self.assertEqual(status, 200)
                self.assertTrue(body)


if __name__ == '__main__': unittest.main()
