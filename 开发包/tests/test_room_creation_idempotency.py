"""Room creation retries are account-scoped and commit with room ownership."""
from concurrent.futures import ThreadPoolExecutor
import json
from unittest import mock
from test_campaign_rooms import CampaignRoomTests, CampaignRoomHttpTests
from server.campaign_rooms import RoomStore
from server.email_accounts import AccountError


REQUEST = 'create-room-retry-0001'


class RoomCreationTests(CampaignRoomTests):
    def test_legacy_room_schema_upgrade_preserves_members_and_existing_rooms(self):
        with self.accounts.db() as db: db.execute('DROP TABLE room_creation_receipts')
        upgraded = RoomStore(self.accounts)
        self.assertEqual(upgraded.list(self.tokens[0])[0]['id'], self.room['id'])
        first = upgraded.create(self.tokens[0], '升级后创建', REQUEST)
        self.assertEqual(upgraded.create(self.tokens[0], '升级后创建', REQUEST)['id'], first['id'])

    def test_retry_after_relogin_and_store_restart_returns_original_even_at_limit(self):
        created = self.rooms.create(self.tokens[0], ' Ａ 的房间 ', REQUEST)
        restarted = RoomStore(self.accounts)
        for index in range(8): restarted.create(self.tokens[0], '另一个房间 '+str(index))
        self.assertEqual(len(restarted.list(self.tokens[0])), 10)
        from test_email_accounts import PASSWORD
        replacement = self.accounts.login('u0@example.com', PASSWORD)[0]
        self.assertEqual(restarted.create(replacement, 'A 的房间', REQUEST)['id'], created['id'])
        self.assertEqual(len(restarted.list(replacement)), 10)

    def test_conflicting_payload_cannot_repurpose_the_receipt(self):
        created = self.rooms.create(self.tokens[0], '原名称', REQUEST)
        with self.assertRaises(AccountError) as caught:
            self.rooms.create(self.tokens[0], '另一名称', REQUEST)
        self.assertEqual((caught.exception.status, caught.exception.code),
                         (409, 'ROOM_CREATE_REQUEST_CONFLICT'))
        self.assertEqual(self.rooms.create(self.tokens[0], '原名称', REQUEST)['id'], created['id'])
        self.assertEqual(len(self.rooms.list(self.tokens[0])), 2)

    def test_request_identity_is_per_account_and_same_names_are_still_allowed(self):
        first = self.rooms.create(self.tokens[0], '同名房间', REQUEST)
        second = self.rooms.create(self.tokens[1], '同名房间', REQUEST)
        separate = self.rooms.create(self.tokens[0], '同名房间', 'create-room-retry-0002')
        self.assertEqual(len({first['id'], second['id'], separate['id']}), 3)
        self.assertEqual(second['role'], 'owner')

    def test_concurrent_retries_create_only_one_room(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _:self.rooms.create(self.tokens[0], '并行提交', REQUEST), range(4)))
        self.assertEqual(len({room['id'] for room in results}), 1)
        self.assertEqual(len(self.rooms.list(self.tokens[0])), 2)

    def test_failed_transaction_rolls_back_room_membership_and_receipt(self):
        original = self.rooms._member
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            raise OSError('simulate failure after all inserts')
        with mock.patch.object(self.rooms, '_member', side_effect=fail):
            with self.assertRaises(OSError): self.rooms.create(self.tokens[0], '重试事务', REQUEST)
        self.assertEqual(len(self.rooms.list(self.tokens[0])), 1)
        with self.accounts.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM room_creation_receipts').fetchone()[0], 0)
        self.assertEqual(self.rooms.create(self.tokens[0], '重试事务', REQUEST)['role'], 'owner')

    def test_old_clients_can_create_without_request_id_and_malformed_ids_are_rejected(self):
        first = self.rooms.create(self.tokens[0], '旧客户端')
        second = self.rooms.create(self.tokens[0], '旧客户端')
        self.assertNotEqual(first['id'], second['id'])
        for invalid in ('', 'short', 'x'*97, [], True):
            self.assertStatus(400, lambda:self.rooms.create(self.tokens[0], '无效请求', invalid))
        self.assertEqual(len(self.rooms.list(self.tokens[0])), 3)


class RoomCreationHttpTests(CampaignRoomHttpTests):
    def test_http_retry_and_conflict_have_stable_account_scoped_results(self):
        data = dict(name='HTTP 重试', requestId=REQUEST)
        first_code, first_body, _ = self.request('/api/account/room-create', data)
        second_code, second_body, _ = self.request('/api/account/room-create', data)
        self.assertEqual((first_code, second_code), (200, 200))
        self.assertEqual(json.loads(first_body)['room']['id'], json.loads(second_body)['room']['id'])
        code, body, _ = self.request('/api/account/room-create', dict(data, name='另一个名称'))
        self.assertEqual(code, 409)
        self.assertEqual(json.loads(body)['errorCode'], 'ROOM_CREATE_REQUEST_CONFLICT')
        other_code, other_body, _ = self.request('/api/account/room-create', data, user=1)
        self.assertEqual(other_code, 200)
        self.assertNotEqual(json.loads(first_body)['room']['id'], json.loads(other_body)['room']['id'])


def load_tests(loader, tests, pattern):
    import unittest
    return unittest.TestSuite(case(name)
        for case in (RoomCreationTests, RoomCreationHttpTests)
        for name in case.__dict__ if name.startswith('test_'))
