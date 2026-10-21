"""Room authentication returns to a page and never an API or external origin."""
import unittest
from unittest import mock
from types import SimpleNamespace
from urllib.parse import quote, unquote
from project_test_paths import APP_ROOT
import sys
sys.path.insert(0, str(APP_ROOT))
from server import room_gateway
from server.room_gateway import login_destination
from server.email_accounts import AccountError


class RoomLoginContinuationTests(unittest.TestCase):
    def test_room_pages_keep_their_target(self):
        for suffix in ('', '主控台/主控台.html', '主控台/玩家.html'):
            path = '/rooms/r' + 'a' * 32 + '/' + suffix
            destination = login_destination(quote(path, safe='/') + '?ignored=1')
            self.assertEqual(unquote(destination.split('continue=', 1)[1]), path)

    def test_non_room_pages_and_api_targets_fall_back_to_dashboard(self):
        for path in ('/account', '/rooms/bad/', '/rooms/r' + 'a' * 32 + '/api/state',
                     '/rooms/r' + 'a' * 32 + '/主控台/未知.html'):
            self.assertEqual(login_destination(path), '/account#dashboard')

    def test_unauthenticated_room_page_redirects_but_api_keeps_401(self):
        root = '/rooms/r' + 'b' * 32
        app = SimpleNamespace(ACCOUNT_SETTINGS={'enabled':True,'roomsEnabled':True})
        service = mock.Mock()
        service.access.side_effect = AccountError('请先登录', 401)
        for suffix in ('/主控台/玩家.html', '/api/info'):
            handler = mock.Mock(path=root + suffix, command='GET', headers={})
            with mock.patch.object(room_gateway, 'origin', return_value=('https://pl.example.com', True)), \
                 mock.patch.object(room_gateway, 'rooms', return_value=service), \
                 mock.patch.object(room_gateway, 'respond') as respond:
                self.assertTrue(room_gateway.handle(handler, app))
            if suffix.startswith('/api/'):
                handler._redirect.assert_not_called()
                self.assertEqual(respond.call_args.args[2], 401)
            else:
                self.assertEqual(handler._redirect.call_args.args[0], login_destination(root + suffix))
                respond.assert_not_called()

    def test_room_takeover_has_a_small_host_only_upload_limit(self):
        self.assertEqual(room_gateway.body_limit('/api/host-state/takeover', 'owner'), 65536)
        with self.assertRaises(AccountError) as caught:
            room_gateway.body_limit('/api/host-state/takeover', 'player')
        self.assertEqual(caught.exception.status, 403)
