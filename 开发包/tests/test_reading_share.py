import copy
import unittest
from unittest import mock
import test_player_profiles as profiles
from server.reading_share import ReadingShares

SERVER = profiles.SERVER


class ReadingShareTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.shares = ReadingShares(SERVER.profiles.ProfileError, lambda: self.now)
        self.item = dict(id='document', name='旧书', category='document', documentType='book',
                         body='第一页\f第二页\f第三页', quantity=1, notes='private', ownerCharacterId='private-owner')

    def test_invite_has_no_body_and_accept_exposes_only_reading_fields(self):
        event = self.shares.invite('c1', 'p1', '甲', self.item, ['p1', 'p2', 'p2'])
        self.assertNotIn('body', event)
        self.assertEqual(event['recipients'], ['p2'])
        self.item['body'] = 'later edit'
        result = self.shares.accept('c1', event['shareId'], 'p2')
        self.assertEqual(result['body'], '第一页\f第二页\f第三页')
        self.assertEqual(set(result), {'name', 'category', 'documentType', 'body'})
        result['body'] = 'client edit'
        self.assertNotEqual(self.shares.accept('c1', event['shareId'], 'p2')['body'], 'client edit')

    def test_access_expiry_campaign_and_rate_limits(self):
        event = self.shares.invite('c1', 'p1', '甲', self.item, ['p2'])
        with self.assertRaises(SERVER.profiles.ProfileError): self.shares.accept('c1', event['shareId'], 'p3')
        with self.assertRaises(SERVER.profiles.ProfileError): self.shares.invite('c1', 'p1', '甲', self.item, ['p2'])
        self.now += 121
        with self.assertRaises(SERVER.profiles.ProfileError): self.shares.accept('c1', event['shareId'], 'p2')
        event = self.shares.invite('c1', 'p1', '甲', self.item, ['p2'])
        with self.assertRaises(SERVER.profiles.ProfileError): self.shares.accept('c2', event['shareId'], 'p2')

    def test_only_held_documents_and_other_recipients(self):
        for change in ({'quantity':0}, {'category':'potion'}, {'body':''}, {'documentType':'invalid'}):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.shares.invite('c1', 'p1', '甲', dict(self.item, **change), ['p2'])
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.shares.invite('c1', 'p1', '甲', self.item, ['p1'])

    def test_disabling_content_revokes_an_existing_invitation(self):
        event = self.shares.invite('c1', 'p1', '甲', self.item, ['p2'], context_revision='enabled')
        with self.assertRaisesRegex(SERVER.profiles.ProfileError, '已变化'):
            self.shares.accept('c1', event['shareId'], 'p2', context_revision='disabled')
        self.assertNotIn(event['shareId'], self.shares.entries)

    def test_removed_source_cannot_be_read_from_an_old_invitation(self):
        event = self.shares.invite('c1', 'p1', '甲', self.item, ['p2'],
            source={'mapId':'map','markerId':'chest'}, context_revision='same')
        self.assertEqual(self.shares.accept('c1', event['shareId'], 'p2',
            available=lambda entry: entry['itemId'] == 'document', context_revision='same')['body'], self.item['body'])
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.shares.accept('c1', event['shareId'], 'p2', available=lambda entry: False, context_revision='same')


class ReadingShareHttpTests(unittest.TestCase):
    setUp = profiles.PlayerProfileHttpTests.setUp
    request = profiles.PlayerProfileHttpTests.request
    login = profiles.PlayerProfileHttpTests.login
    close_server = profiles.PlayerProfileHttpTests.close_server

    def test_authenticated_invite_accept_and_forged_item_rejected(self):
        token = self.login()
        receiver = self.request({'op':'create', 'name':'乙'}, host=True)[1]
        receiver_token = self.request({'credential':receiver['credential']}, path='/api/session')[1]['session']['sessionToken']
        item = dict(id='doc1', name='来信', category='document', documentType='letter', body='完整正文', quantity=1, notes='私密备注')
        bag = dict(items=[item])
        with mock.patch.object(SERVER, 'STATE', {'campaignId':'c1'}), mock.patch.object(SERVER, 'READING_SHARES', ReadingShares(SERVER.profiles.ProfileError)), mock.patch.object(SERVER.ResourceStore, 'view', return_value=bag) as read:
            def call(data): return self.request(dict(campaignId='c1', **data), path='/api/reading-share')
            self.assertEqual(call(dict(op='invite', itemId='doc1'))[0], 401)
            self.assertEqual(call(dict(op='invite', itemId='missing', sessionToken=token))[0], 404)
            code, result = call(dict(op='invite', itemId='doc1', sessionToken=token, playerId=receiver['profile']['playerId'], body='forged'))
            self.assertEqual(code, 200, result)
            self.assertEqual(read.call_args.args[0], self.pid)
            event = SERVER.broadcast.call_args.args[0]
            self.assertEqual(event['type'], 'readingInvite')
            self.assertNotIn('body', event)
            self.assertEqual(call(dict(op='accept', shareId=event['shareId'], sessionToken=token))[0], 403)
            code, accepted = call(dict(op='accept', shareId=event['shareId'], sessionToken=receiver_token))
            self.assertEqual(code, 200, accepted)
            self.assertEqual(accepted['item']['body'], '完整正文')
            self.assertNotIn('notes', accepted['item'])
            self.assertEqual(bag['items'][0]['quantity'], 1)

    def test_map_sharing_resolves_only_server_visible_contents(self):
        token = self.login()
        receiver = self.request({'op':'create','name':'乙'}, host=True)[1]
        self.request({'credential':receiver['credential']},path='/api/session')
        item = dict(id='map-doc',name='地图信件',category='document',documentType='letter',body='可见正文',quantity=1)
        with mock.patch.object(SERVER,'STATE',{'campaignId':'c1'}), mock.patch.object(SERVER,'READING_SHARES',ReadingShares(SERVER.profiles.ProfileError)), mock.patch.object(SERVER.MapItems,'apply',return_value={'markers':[{'id':'marker','items':[]}]}) as visible:
            command=dict(op='invite',campaignId='c1',sessionToken=token,itemId='map-doc',source={'mapId':'m1','markerId':'marker'})
            self.assertEqual(self.request(command,path='/api/reading-share')[0],404)
            visible.return_value={'markers':[{'id':'marker','items':[item]}]}
            code,result=self.request(command,path='/api/reading-share')
            self.assertEqual(code,200,result)
            self.assertEqual(visible.call_args.args[0],{'op':'get','campaignId':'c1','mapId':'m1'})
            self.assertFalse(visible.call_args.args[2])
