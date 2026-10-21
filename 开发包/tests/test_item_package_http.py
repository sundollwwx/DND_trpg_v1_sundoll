"""Real HTTP checks for package-scoped inventory, media and reading invitations."""
import copy
import json
import unittest
from unittest import mock

import test_player_profiles as fixtures
from server.content_packages import ContentPackages, local_package_id
from server.module_store import ModuleStore
from server.reading_share import ReadingShares
from server.resource_database import ResourceDatabase
from server.resources import ResourceStore

SERVER = fixtures.SERVER


class ItemPackageHttpTests(unittest.TestCase):
    request = fixtures.PlayerProfileHttpTests.request
    login = fixtures.PlayerProfileHttpTests.login
    close_server = fixtures.PlayerProfileHttpTests.close_server

    def setUp(self):
        fixtures.PlayerProfileHttpTests.setUp(self)
        self.counter = 0
        self.store = SERVER.profile_store()
        receiver = self.store.create('乙')
        self.other = receiver['profile']['playerId']
        hero = self.store.grant(self.pid, dict(name='旅人甲', hpMax=20, ac=12), self.rid())['pieces'][0]
        friend = self.store.grant(self.other, dict(name='旅人乙', hpMax=20, ac=12), self.rid())['pieces'][0]
        self.oid, self.target = hero['ownedPieceId'], friend['ownedPieceId']
        self.state = dict(campaignId='c1', activeMapId='m', maps=[dict(id='m', playerAccessible=True,
            mapW=500, mapH=500, tokens=[dict(hero, id='one', hp=10, x=20, y=20), dict(friend, id='two', hp=10, x=60, y=20)])])
        for name, value in [('STATE', self.state), ('RECENT_ACTIONS', []), ('NEXT_SEQ', 1), ('STATE_REVISION', 0),
                            ('READING_SHARES', ReadingShares(SERVER.profiles.ProfileError))]:
            patch = mock.patch.object(SERVER, name, value)
            patch.start(); self.addCleanup(patch.stop)
        resources = ResourceStore(self.store, SERVER.profiles)
        resources.reconcile(self.state, self.pid)
        ledger = resources.ledger()
        ledger['characters'] = {'@global': ledger['characters']['c1']}
        ResourceDatabase(self.save).activate(ledger,
            {pid: self.store.library(pid) for pid in (self.pid, self.other)}, {'test': 'package-http'})
        self.session = self.login()
        self.other_session = self.request({'credential': receiver['credential']}, path='/api/session')[1]['session']['sessionToken']
        self.a = local_package_id('campaign:c1')
        ContentPackages(self.save).register(dict(id=self.a, name='甲战役内容', scope='campaign', sourceCampaignId='c1'), local=True)
        self.art = ModuleStore(self.save).put_asset(b'\x89PNG-story-private-http', 'image/png', 'campaign:c1')
        SERVER.broadcast.reset_mock()

    def rid(self):
        self.counter += 1
        return 'http-package-%08d' % self.counter

    def resource(self): return ResourceStore(self.store, SERVER.profiles)

    def bp(self, data, host=False, token=None, pid=None):
        body = dict(campaignId=SERVER.STATE.get('campaignId') if SERVER.STATE else None)
        body.update(data)
        if host: body.setdefault('playerId', pid or self.pid)
        else: body.setdefault('sessionToken', token or self.session)
        return self.request(body, host=host, path='/api/backpack')

    def grant(self, scope='campaign', document=False, quantity=3):
        item = dict(name='秘密潮汐物品', category='gear', effect='秘密物品的效果', description='不可泄露的描述',
                    consumable=True, image=self.art, scope=scope)
        if document:
            item.update(name='秘密航海日记', category='document', documentType='letter', body='不可泄露的秘密正文', consumable=False)
        command = dict(op='grant', item=item, quantity=quantity, characterId=self.oid,
                       revision=self.resource().read(self.pid)['revision'], requestId=self.rid())
        status, result = self.bp(command, True)
        self.assertEqual(status, 200, result)
        return next(i for i in result['backpack']['items'] if i['id'] == result['event']['itemId'])

    def change(self, item, op, host=False, token=None, pid=None, **extra):
        command = dict(op=op, itemId=item['id'], revision=self.resource().read(pid or self.pid)['revision'], requestId=self.rid())
        command.update(extra)
        return self.bp(command, host, token, pid)

    def context(self):
        status, result = self.request(dict(op='content-packages', campaignId=SERVER.STATE['campaignId']), host=True, path='/api/modules')
        self.assertEqual(status, 200, result)
        return result['packageContext']

    def select(self, enabled=True):
        current = self.context()
        ids = [p for p in current['enabledPackageIds'] if p != self.a]
        if enabled: ids.append(self.a)
        command = dict(op='set-content-packages', campaignId=SERVER.STATE['campaignId'],
                       enabledPackageIds=ids, revision=current['selectionRevision'], requestId=self.rid())
        status, result = self.request(command, host=True, path='/api/modules')
        self.assertEqual(status, 200, result)
        return command, result['packageContext']

    def remote_media(self, token=None, path=None):
        # A tunnel terminates at loopback; simulate its untrusted host boundary.
        with mock.patch.object(SERVER, 'host_request_allowed', return_value=False):
            return self.request(method='GET', path=path or self.art,
                extra={'Cookie': 'sundoll-media-session=' + (token or self.session)})

    def invite(self, item, source=None):
        command = dict(op='invite', campaignId=SERVER.STATE['campaignId'], itemId=item['id'], sessionToken=self.session)
        if source is not None: command['source'] = source
        status, result = self.request(command, path='/api/reading-share')
        self.assertEqual(status, 200, result)
        return [c.args[0] for c in SERVER.broadcast.call_args_list if c.args[0].get('type') == 'readingInvite'][-1]

    def accept(self, invitation):
        return self.request(dict(op='accept', campaignId=SERVER.STATE['campaignId'], shareId=invitation['shareId'],
            sessionToken=self.other_session), path='/api/reading-share')

    def test_no_campaign_player_cannot_select_an_arbitrary_story_context(self):
        story = self.grant(document=True)
        story_art = self.art
        self.art = ModuleStore(self.save).put_asset(b'\x89PNG-general-private-http', 'image/png', 'general:local')
        general = self.grant('general')
        personal = self.grant('personal')
        with mock.patch.object(SERVER, 'STATE', None):
            status, denied = self.bp(dict(op='get', campaignId='c1'))
            self.assertEqual(status, 409, denied)
            self.assertNotIn(story['id'], json.dumps(denied))
            status, current = self.bp(dict(op='get'))
            self.assertEqual(status, 200, current)
            ids = {i['id'] for i in current['backpack']['items']}
            self.assertEqual(ids, {general['id'], personal['id']})
            self.assertEqual(self.change(story, 'use', campaignId='c1')[0], 409)
            self.assertEqual(self.remote_media(path=story_art)[0], 404)
            self.assertEqual(self.remote_media()[0], 200)
            self.assertEqual(self.request(dict(op='get', campaignId='c1'), path='/api/item-library')[0], 403)
            self.assertEqual(self.request(dict(op='invite', campaignId='c1', itemId=story['id'],
                sessionToken=self.session), path='/api/reading-share')[0], 409)

    def test_hidden_bag_trash_history_receipts_and_media_do_not_leak(self):
        item = self.grant(document=True)
        annotation = dict(op='annotate', itemId=item['id'], notes='秘密角色备注',
            revision=self.resource().read(self.pid)['revision'], requestId=self.rid())
        self.assertEqual(self.bp(annotation)[0], 200)
        status, discarded = self.change(item, 'discard', quantity=1)
        self.assertEqual(status, 200, discarded)
        removal = discarded['event']['id']
        self.assertEqual(self.remote_media()[0], 200)
        self.state['campaignId'] = 'c2'
        before = copy.deepcopy(self.resource().ledger())
        status, response = self.bp(dict(op='get'))
        self.assertEqual(status, 200, response)
        for secret in (item['name'], item['body'], item['image'], '秘密角色备注', item['id']):
            self.assertNotIn(secret, json.dumps(response, ensure_ascii=False))
        self.assertNotIn('receipts', response['backpack'])
        status, replay = self.bp(annotation)
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay['event']['op'], 'unavailable')
        self.assertNotIn(item['name'], json.dumps(replay, ensure_ascii=False))
        self.assertEqual(self.change(item, 'restore', removalId=removal)[0], 409)
        status, share = self.request(dict(op='invite', campaignId='c2', itemId=item['id'], sessionToken=self.session), path='/api/reading-share')
        self.assertEqual(status, 404, share)
        self.assertEqual(self.remote_media()[0], 404)
        self.assertEqual(self.resource().ledger(), before)

    def test_old_reading_invitation_revoked_after_package_disabled(self):
        item = self.grant(document=True)
        self.state['campaignId'] = 'c2'
        self.select()
        invitation = self.invite(item)
        self.assertNotIn('body', invitation)
        self.assertEqual(self.accept(invitation)[1]['item']['body'], item['body'])
        self.select(False)
        status, result = self.accept(invitation)
        self.assertEqual(status, 410, result)
        self.assertNotIn(item['body'], str(result))
        self.assertEqual(self.remote_media()[0], 404)
        self.select()
        self.assertEqual(self.remote_media()[0], 200)
        current = self.bp(dict(op='get'))[1]['backpack']
        self.assertEqual(next(i for i in current['items'] if i['id'] == item['id'])['quantity'], 3)

    def test_old_reading_invitation_revoked_when_source_discarded(self):
        item = self.grant(document=True)
        invitation = self.invite(item)
        self.assertEqual(self.change(item, 'discard', quantity=3)[0], 200)
        self.assertEqual(self.accept(invitation)[0], 410)

    def test_module_context_compare_and_swap_retry_and_player_auth(self):
        self.state['campaignId'] = 'c2'
        original = copy.deepcopy(self.resource().ledger())
        context = self.context()
        command, enabled = self.select()
        self.assertIn(self.a, enabled['enabledPackageIds'])
        self.assertEqual(self.request(command, host=False, path='/api/modules')[0], 403)
        status, replay = self.request(command, host=True, path='/api/modules')
        self.assertEqual(status, 200, replay)
        self.assertEqual(replay['packageContext'], enabled)
        forged = dict(command, enabledPackageIds=[])
        self.assertEqual(self.request(forged, host=True, path='/api/modules')[0], 409)
        stale = dict(command, requestId=self.rid(), revision=context['selectionRevision'])
        self.assertEqual(self.request(stale, host=True, path='/api/modules')[0], 409)
        _, disabled = self.select(False)
        replay = self.request(command, host=True, path='/api/modules')
        self.assertEqual(replay[0], 200, replay)
        self.assertEqual(replay[1]['packageContext'], disabled)
        self.assertNotIn(self.a, replay[1]['packageContext']['enabledPackageIds'])
        self.assertEqual(self.resource().ledger(), original)
        # Public invalidation does not carry the host-only package catalogue.
        snapshots = [c.args[0] for c in SERVER.broadcast.call_args_list if c.args[0].get('type') == 'state']
        self.assertTrue(snapshots)
        for message in snapshots:
            self.assertNotIn('enabledPackageIds', json.dumps(message))
            self.assertNotIn('甲战役内容', json.dumps(message, ensure_ascii=False))

    def test_player_stale_context_cannot_spend_or_choose_other_campaign(self):
        item = self.grant('general')
        self.state['campaignId'] = 'c2'
        old = self.bp(dict(op='get'))[1]['packageContextRevision']
        self.select()
        before = copy.deepcopy(self.resource().ledger())
        self.assertEqual(self.change(item, 'use', packageContextRevision=old)[0], 409)
        self.assertEqual(self.change(item, 'use', campaignId='c1')[0], 409)
        self.assertEqual(self.resource().ledger(), before)
        revision = self.bp(dict(op='get'))[1]['packageContextRevision']
        status, used = self.change(item, 'use', packageContextRevision=revision)
        self.assertEqual(status, 200, used)
        self.assertEqual(next(i for i in used['backpack']['items'] if i['id'] == item['id'])['quantity'], 2)

    def test_personal_binding_requires_explicit_host_unbind_and_keeps_origin(self):
        item = self.grant('personal')
        self.state['campaignId'] = 'c2'
        self.assertEqual(self.change(item, 'transfer', characterId=self.target, quantity=1)[0], 403)
        self.assertEqual(self.change(item, 'transfer', host=True, characterId=self.target, quantity=1)[0], 403)
        self.assertEqual(self.change(item, 'unbind')[0], 403)
        command = dict(op='unbind', itemId=item['id'], revision=self.resource().read(self.pid)['revision'], requestId=self.rid())
        status, released = self.bp(command, True)
        self.assertEqual(status, 200, released)
        before_retry = copy.deepcopy(self.resource().ledger())
        self.assertEqual(self.bp(command, True)[0], 200)
        self.assertEqual(self.resource().ledger(), before_retry)
        status, transferred = self.change(item, 'transfer', characterId=self.target, quantity=1)
        self.assertEqual(status, 200, transferred)
        status, other = self.bp(dict(op='get'), token=self.other_session)
        self.assertEqual(status, 200, other)
        moved = other['backpack']['items'][0]
        self.assertEqual(moved['quantity'], 1)
        self.assertEqual(moved['ownerCharacterId'], self.target)
        self.assertEqual(moved['sourceCharacterId'], self.oid)
        self.assertEqual(moved['sourcePlayerId'], self.pid)
        self.assertEqual(moved['boundCharacterId'], '')
        library = self.request(dict(op='get'), host=True, path='/api/item-library')[1]['library']
        status, denied = self.request(dict(op='fromBag', playerId=self.other, characterId=self.target,
            itemId=moved['id'], bagRevision=other['backpack']['revision'], revision=library['revision'],
            requestId=self.rid(), item=dict(scope='general')), host=True, path='/api/item-library')
        self.assertEqual(status, 403, denied)

    def test_map_reading_media_and_pickup_follow_current_package_selection(self):
        item = self.grant(document=True)
        library = self.request(dict(op='get'), host=True, path='/api/item-library')[1]['library']
        status, template = self.request(dict(op='fromBag', playerId=self.pid, characterId=self.oid,
            itemId=item['id'], bagRevision=self.resource().read(self.pid)['revision'], revision=library['revision'],
            requestId=self.rid()), host=True, path='/api/item-library')
        self.assertEqual(status, 200, template)
        self.state['campaignId'] = 'c2'
        self.select()
        status, placed = self.request(dict(op='place', campaignId='c2', mapId='m', revision=0, requestId=self.rid(),
            templateId=template['templateId'], templateVersion=1, quantity=1, visible=True), host=True, path='/api/map-items')
        self.assertEqual(status, 200, placed)
        marker = placed['markers'][0]
        invitation = self.invite(marker['items'][0], dict(mapId='m', markerId=marker['id']))
        self.assertEqual(self.remote_media(token=self.other_session)[0], 200)
        self.select(False)
        before = copy.deepcopy(self.resource().ledger())
        status, hidden = self.request(dict(op='get', campaignId='c2', mapId='m', sessionToken=self.other_session), path='/api/map-items')
        self.assertEqual(status, 200, hidden)
        self.assertEqual(hidden['markers'], [])
        status, rejected = self.request(dict(op='take', campaignId='c2', mapId='m', sessionToken=self.other_session,
            markerId=marker['id'], markerRevision=marker['revision'], itemId=marker['items'][0]['id'],
            characterId=self.target, quantity=1, requestId=self.rid()), path='/api/map-items')
        self.assertEqual(status, 409, rejected)
        self.assertEqual(self.accept(invitation)[0], 410)
        self.assertEqual(self.remote_media(token=self.other_session)[0], 404)
        self.assertEqual(self.resource().ledger(), before)


if __name__ == '__main__': unittest.main()
