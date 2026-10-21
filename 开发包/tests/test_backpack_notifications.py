"""Real HTTP handlers notify only committed inventory changes, without private data."""
import copy
import unittest
from unittest import mock
import test_player_profiles as fixtures
from server.resources import ResourceStore

SERVER = fixtures.SERVER


class BackpackNotificationTests(unittest.TestCase):
    close_server = fixtures.PlayerProfileHttpTests.close_server
    request = fixtures.PlayerProfileHttpTests.request
    login = fixtures.PlayerProfileHttpTests.login

    def setUp(self):
        fixtures.PlayerProfileHttpTests.setUp(self)
        self.store = SERVER.profile_store()
        piece = self.store.grant(self.pid, dict(name='旅人', type='pc', hpMax=30, ac=12),
                                 'notification-hero-grant')['pieces'][0]
        self.oid = piece['ownedPieceId']
        state = dict(campaignId='c1', activeMapId='m1', maps=[dict(id='m1', playerAccessible=True,
            mapW=800, mapH=600, tokens=[dict(piece, id='hero', hp=2, x=30, y=30)])])
        for name, value in [('STATE', state), ('RECENT_ACTIONS', []), ('NEXT_SEQ', 1), ('STATE_REVISION', 0)]:
            patch = mock.patch.object(SERVER, name, value)
            patch.start(); self.addCleanup(patch.stop)
        self.session = self.login()
        SERVER.broadcast.reset_mock()

    def backpack(self, data, host=False):
        return self.request(dict(campaignId='c1', **data), host=host, path='/api/backpack')

    def grant(self, definition=None, quantity=3, request_id='notification-grant-001'):
        command = dict(op='grant', playerId=self.pid, characterId=self.oid, quantity=quantity, revision=0,
                       requestId=request_id)
        if definition is None: command['presetId'] = 'healing'
        else: command['item'] = definition
        status, result = self.backpack(command, True)
        self.assertEqual(status, 200, result)
        return command, result

    def notices(self):
        result = [call.args[0] for call in SERVER.broadcast.call_args_list if call.args[0].get('type') == 'backpackChanged']
        self.assertTrue(all(item == {'type': 'backpackChanged'} for item in result))
        return result

    def test_grant_notifies_once_get_and_replay_do_not(self):
        command, result = self.grant()
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        SERVER.broadcast.reset_mock()
        status, read = self.backpack(dict(op='get', sessionToken=self.session))
        self.assertEqual(status, 200, read)
        self.assertEqual(self.notices(), [])
        status, replay = self.backpack(command, True)
        self.assertEqual(status, 200, replay)
        self.assertEqual(result['backpack'], replay['backpack'])
        self.assertEqual(self.notices(), [])

    def test_stale_denied_and_conflicting_commands_never_notify(self):
        command, result = self.grant()
        before = copy.deepcopy(ResourceStore(self.store, SERVER.profiles).ledger())
        SERVER.broadcast.reset_mock()
        requests = [(dict(command, requestId='notification-stale-001'), True, 409),
                    (dict(command, sessionToken=self.session, revision=1, requestId='notification-denied-001'), False, 403),
                    (dict(command, quantity=1), True, 409)]
        for data, host, expected in requests:
            status, response = self.backpack(data, host)
            self.assertEqual(status, expected, response)
            self.assertEqual(self.notices(), [])
            self.assertEqual(ResourceStore(self.store, SERVER.profiles).ledger(), before)

    def test_player_note_favorite_and_use_notifications_never_include_contents(self):
        _, result = self.grant(dict(name='暗号烈酒', category='gear', rarity='', consumable=True,
                                    effect='饮用', description='这段秘密不广播'))
        item_id = result['backpack']['items'][0]['id']
        SERVER.broadcast.reset_mock()
        status, result = self.backpack(dict(op='annotate', sessionToken=self.session, itemId=item_id,
            revision=1, notes='我的私人物品，不要公开', favorite=True, requestId='notification-note-001'))
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        SERVER.broadcast.reset_mock()
        status, result = self.backpack(dict(op='use', sessionToken=self.session, itemId=item_id,
            revision=2, requestId='notification-use-001'))
        self.assertEqual(status, 200, result)
        self.assertEqual(result['backpack']['items'][0]['quantity'], 2)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])

    def test_write_failure_has_no_notification_and_leaves_original_quantity(self):
        _, result = self.grant()
        before = copy.deepcopy(ResourceStore(self.store, SERVER.profiles).ledger())
        SERVER.broadcast.reset_mock()
        atomic = SERVER.profiles.atomic
        ledger_path = ResourceStore(self.store, SERVER.profiles).ledger_path
        def fail(path, value):
            if path == ledger_path: raise OSError('disk full')
            return atomic(path, value)
        with mock.patch.object(SERVER.profiles, 'atomic', side_effect=fail):
            status, response = self.backpack(dict(op='annotate', sessionToken=self.session,
                itemId=result['backpack']['items'][0]['id'], revision=1,
                notes='写入失败的内容', requestId='notification-failed-save'))
        self.assertEqual(status, 500, response)
        self.assertEqual(self.notices(), [])
        self.assertEqual(ResourceStore(self.store, SERVER.profiles).ledger(), before)

    def place(self):
        status, result = self.request(dict(op='place', campaignId='c1', mapId='m1', revision=0,
            templateId='healing', templateVersion=1, quantity=3, visible=True,
            requestId='notification-map-place'), host=True, path='/api/map-items')
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [])
        return result

    def test_map_take_notifies_once_and_failed_take_get_replay_stay_silent(self):
        placed = self.place(); marker = placed['markers'][0]
        command = dict(op='take', campaignId='c1', mapId='m1', sessionToken=self.session,
            markerId=marker['id'], markerRevision=marker['revision'], itemId=marker['items'][0]['id'],
            characterId=self.oid, quantity=1, requestId='notification-map-take')
        status, result = self.request(command, path='/api/map-items')
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        SERVER.broadcast.reset_mock()
        status, replay = self.request(command, path='/api/map-items')
        self.assertEqual(status, 200, replay)
        self.assertEqual(self.notices(), [])
        status, read = self.request(dict(op='get', campaignId='c1', mapId='m1', sessionToken=self.session), path='/api/map-items')
        self.assertEqual(status, 200, read)
        self.assertEqual(self.notices(), [])
        status, response = self.request(dict(command, quantity=999, requestId='notification-invalid-take'), path='/api/map-items')
        self.assertEqual(status, 409, response)
        self.assertEqual(self.notices(), [])

    def test_map_host_grant_notifies_once_and_move_does_not(self):
        placed = self.place(); marker = placed['markers'][0]
        move = dict(op='move', campaignId='c1', mapId='m1', markerId=marker['id'], markerRevision=marker['revision'],
                    x=80, y=90, requestId='notification-map-move')
        status, moved = self.request(move, host=True, path='/api/map-items')
        self.assertEqual(status, 200, moved)
        self.assertEqual(self.notices(), [])
        marker = moved['markers'][0]
        command = dict(op='grant', campaignId='c1', mapId='m1', revision=moved['revision'],
            markerId=marker['id'], itemId=marker['items'][0]['id'], quantity=1, playerId=self.pid,
            characterId=self.oid, requestId='notification-map-grant')
        status, result = self.request(command, host=True, path='/api/map-items')
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        SERVER.broadcast.reset_mock()
        status, replay = self.request(command, host=True, path='/api/map-items')
        self.assertEqual(status, 200, replay)
        self.assertEqual(self.notices(), [])

    def test_healing_keeps_existing_hp_events_and_adds_one_anonymous_notice(self):
        _, result = self.grant()
        target = next(c for c in result['characters'] if c['id'] == self.oid)
        SERVER.broadcast.reset_mock()
        command = dict(op='heal', sessionToken=self.session, itemId=result['backpack']['items'][0]['id'],
            characterId=self.oid, targetRevision=target['revision'], sourceCharacterId=self.oid,
            revision=1, requestId='notification-healing-001')
        status, result = self.backpack(command)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        actions = [call.args[0] for call in SERVER.broadcast.call_args_list if call.args[0]['type'] == 'action']
        self.assertTrue(actions)
        SERVER.broadcast.reset_mock()
        status, replay = self.backpack(command)
        self.assertEqual(status, 200, replay)
        self.assertEqual(self.notices(), [])

    def test_wallet_change_uses_anonymous_notice_and_retry_stays_silent(self):
        command = dict(op='wallet', playerId=self.pid, characterId=self.oid, action='credit', amount=5,
                       currency='gp', note='私密付款说明', revision=0, requestId='notification-wallet-001')
        status, result = self.backpack(command, True)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        SERVER.broadcast.reset_mock()
        status, replay = self.backpack(command, True)
        self.assertEqual(status, 200, replay)
        self.assertEqual(self.notices(), [])

    def test_cross_player_transfer_notifies_once_without_sender_or_receiver_identity(self):
        other = self.store.create('收件人的秘密名字')['profile']['playerId']
        piece = self.store.grant(other, dict(name='接收角色', type='pc', hpMax=10),
                                 'notification-recipient')['pieces'][0]
        SERVER.STATE['maps'][0]['tokens'].append(dict(piece, id='receiver', hp=10, x=80, y=80))
        _, granted = self.grant()
        SERVER.broadcast.reset_mock()
        command = dict(op='transfer', sessionToken=self.session,
            itemId=granted['backpack']['items'][0]['id'], characterId=piece['ownedPieceId'],
            quantity=2, revision=1, requestId='notification-transfer-001')
        status, result = self.backpack(command)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.notices(), [{'type': 'backpackChanged'}])
        self.assertEqual(SERVER.broadcast.call_args_list, [mock.call({'type': 'backpackChanged'})])
        target = ResourceStore(self.store, SERVER.profiles).read(other)
        self.assertEqual(target['items'][0]['quantity'], 2)
        SERVER.broadcast.reset_mock()
        status, replay = self.backpack(command)
        self.assertEqual(status, 200, replay)
        self.assertEqual(self.notices(), [])
        status, denied = self.backpack(dict(op='get', sessionToken=self.session, playerId=other))
        self.assertEqual(status, 403, denied)
        self.assertEqual(self.notices(), [])

    def test_failed_map_grant_has_no_notice_or_split_inventory_write(self):
        placed = self.place(); marker = placed['markers'][0]
        before = copy.deepcopy(ResourceStore(self.store, SERVER.profiles).ledger())
        command = dict(op='grant', campaignId='c1', mapId='m1', revision=placed['revision'],
            markerId=marker['id'], itemId=marker['items'][0]['id'], quantity=1, playerId=self.pid,
            characterId=self.oid, requestId='notification-map-fail')
        atomic = SERVER.profiles.atomic
        ledger_path = ResourceStore(self.store, SERVER.profiles).ledger_path
        def fail(path, value):
            if path == ledger_path: raise OSError('disk full')
            return atomic(path, value)
        with mock.patch.object(SERVER.profiles, 'atomic', side_effect=fail):
            status, result = self.request(command, host=True, path='/api/map-items')
        self.assertEqual(status, 500, result)
        self.assertEqual(self.notices(), [])
        self.assertEqual(ResourceStore(self.store, SERVER.profiles).ledger(), before)


if __name__ == '__main__':
    unittest.main()
