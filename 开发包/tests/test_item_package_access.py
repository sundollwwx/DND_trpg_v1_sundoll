"""Campaign package eligibility is enforced on authoritative item transactions."""
import copy
import unittest

from test_resources import ResourceTests, SERVER
from server.content_packages import ContentPackages, local_package_id
from server.inventory import ORIGIN_FIELDS
from server.item_library import ItemLibrary
from server.map_items import MapItems
from server.resource_database import ResourceDatabase
from server.resources import ResourceStore


class ItemPackageAccessTests(unittest.TestCase):
    def setUp(self):
        ResourceTests.setUp(self)
        data = self.r.ledger()
        data['characters'] = {'@global': data['characters']['c1']}
        ResourceDatabase(self.store.save_root).activate(data,
            {pid: self.store.library(pid) for pid in (self.pid, self.other)}, {'test': 'package-access'})
        self.r = ResourceStore(self.store, SERVER.profiles)
        self.counter = 0
        self.r.apply(self.pid, 'c1', dict(op='assign', revision=self.bag['revision'],
            itemId=self.bag['items'][0]['id'], characterId=self.oid, requestId=self.request_id()), state=self.state)
        self.policy = ContentPackages(self.store.save_root)
        self.c1_package = local_package_id('campaign:c1')
        self.policy.register(dict(id=self.c1_package, name='第一战役', scope='campaign', sourceCampaignId='c1'), local=True)
        self.other_state = dict(copy.deepcopy(self.state), campaignId='c2')

    def request_id(self):
        self.counter += 1
        return 'package-request-%08d' % self.counter

    @staticmethod
    def definition(**extra):
        return dict(name='潮汐密钥', category='gear', effect='揭示一条隐藏的通路。', consumable=True, **extra)

    def grant(self, scope='campaign', campaign='c1', **extra):
        data = dict(op='grant', item=self.definition(scope=scope), quantity=3, characterId=self.oid,
                    revision=self.r.read(self.pid)['revision'], requestId=self.request_id())
        data.update(extra)
        bag, event = self.r.apply(self.pid, campaign, data, True,
                                state=self.state if campaign == 'c1' else self.other_state)
        return next(i for i in bag['items'] if i['id'] == event['itemId'])

    def change(self, target, op='use', campaign='c1', host=False, **extra):
        data = dict(op=op, itemId=target['id'], revision=self.r.read(self.pid)['revision'], requestId=self.request_id())
        data.update(extra)
        return self.r.apply(self.pid, campaign, data, host,
                            state=self.state if campaign == 'c1' else self.other_state)

    def enable_other(self, enabled=True):
        policy = ContentPackages(self.store.save_root)
        context = policy.context('c2')
        ids = [i for i in context['enabledPackageIds'] if i != self.c1_package]
        if enabled: ids.append(self.c1_package)
        return policy.set_enabled('c2', ids, context['selectionRevision'], self.request_id())

    def test_campaign_item_hides_without_deletion_and_reappears_with_remaining_quantity(self):
        item = self.grant()
        before = copy.deepcopy(self.r.ledger())
        self.assertNotIn(item['id'], {i['id'] for i in self.r.view(self.pid, 'c2')['items']})
        self.assertNotIn(item['name'], str(self.r.view(self.pid, 'c2')))
        self.assertEqual(self.r.ledger(), before)
        with self.assertRaises(SERVER.profiles.ProfileError): self.change(item, campaign='c2')
        self.assertEqual(self.r.ledger(), before)
        self.enable_other()
        bag, _ = self.change(item, campaign='c2')
        self.assertEqual(next(i for i in bag['items'] if i['id'] == item['id'])['quantity'], 2)
        self.enable_other(False)
        self.assertNotIn(item['id'], {i['id'] for i in self.r.view(self.pid, 'c2')['items']})
        self.assertEqual(next(i for i in self.r.view(self.pid, 'c1')['items'] if i['id'] == item['id'])['quantity'], 2)

    def test_grant_edit_and_stacking_keep_frozen_source(self):
        item = self.grant()
        general = self.grant('general')
        self.assertNotEqual(item['id'], general['id'])
        frozen = {k: item.get(k) for k in ORIGIN_FIELDS}
        forged = self.definition(scope='general', sourcePackageId=general['sourcePackageId'], sourceScope='general')
        bag, _ = self.change(item, op='edit', host=True, item=forged)
        edited = next(i for i in bag['items'] if i['id'] == item['id'])
        self.assertEqual({k: edited.get(k) for k in ORIGIN_FIELDS}, frozen)
        self.assertIn(general['id'], {i['id'] for i in self.r.view(self.pid, 'c2')['items']})
        self.assertNotIn(item['id'], {i['id'] for i in self.r.view(self.pid, 'c2')['items']})

    def test_missing_source_template_cannot_be_granted_in_other_campaign(self):
        library = ItemLibrary(self.store, SERVER.profiles)
        created = library.apply(dict(op='create', revision=library.read()['revision'], requestId=self.request_id(),
            item=self.definition(scope='campaign', campaignId='c1')))
        before = copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.grant(campaign='c2', templateId=created['templateId'], templateVersion=1)
        self.assertEqual(self.r.ledger(), before)

    def test_stale_campaign_and_stale_package_revision_never_consume(self):
        item = self.grant('general')
        before = copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid, 'c1', dict(op='use', itemId=item['id'], revision=self.r.read(self.pid)['revision'],
                requestId=self.request_id()), state=self.other_state)
        revision = self.r.view(self.pid, 'c2')['packageContextRevision']
        self.enable_other()
        expected = copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.change(item, campaign='c2', packageContextRevision=revision)
        self.assertEqual(self.r.ledger(), expected)
        self.assertEqual(self.r.read(self.pid)['items'], before['backpacks'][self.pid]['items'])

    def test_retry_in_disabled_campaign_does_not_reveal_or_repeat_operation(self):
        item = self.grant()
        command = dict(op='use', itemId=item['id'], revision=self.r.read(self.pid)['revision'], requestId=self.request_id())
        self.r.apply(self.pid, 'c1', command, state=self.state)
        before = copy.deepcopy(self.r.ledger())
        bag, event = self.r.apply(self.pid, 'c2', command, state=self.other_state)
        self.assertEqual(event['op'], 'unavailable')
        self.assertNotIn(item['name'], str((bag, event)))
        self.assertEqual(self.r.ledger(), before)

    def test_hidden_removed_items_cannot_be_restored_or_bulk_purged(self):
        item = self.grant()
        _, removed = self.change(item, op='discard', quantity=3)
        self.assertEqual(self.r.view(self.pid, 'c2')['removedItems'], [])
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.change(item, op='restore', campaign='c2', removalId=removed['id'])
        general = self.grant('general')
        self.change(general, op='discard', quantity=3)
        self.r.apply(self.pid, 'c2', dict(op='purgeAll', revision=self.r.read(self.pid)['revision'],
            requestId=self.request_id()), True, state=self.other_state)
        kept = self.r.read(self.pid)['removedItems']
        self.assertEqual([entry['id'] for entry in kept], [removed['id']])
        bag, _ = self.change(item, op='restore', removalId=removed['id'])
        self.assertEqual(next(i for i in bag['items'] if i['id'] == item['id'])['quantity'], 3)

    def test_partial_transfer_preserves_package_origin_and_blocks_ineligible_use(self):
        item = self.grant()
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.change(item, op='transfer', campaign='c2', characterId=self.target, quantity=1)
        self.change(item, op='transfer', characterId=self.target, quantity=1)
        moved = next(i for i in self.r.read(self.other)['items'] if i['name'] == item['name'])
        self.assertEqual({k: moved.get(k) for k in ORIGIN_FIELDS}, {k: item.get(k) for k in ORIGIN_FIELDS})
        self.assertEqual(moved['ownerCharacterId'], self.target)
        self.assertEqual(moved['quantity'], 1)
        self.assertEqual(next(i for i in self.r.read(self.pid)['items'] if i['id'] == item['id'])['quantity'], 2)
        self.assertNotIn(moved['id'], {i['id'] for i in self.r.view(self.other, 'c2')['items']})

    def test_personal_source_uses_server_recipient_and_is_portable_with_binding(self):
        item = self.grant('personal', item=self.definition(scope='personal', ownerPlayerId=self.other,
            sourcePlayerId=self.other, ownerCharacterId=self.target, sourceCharacterId=self.target,
            sourcePackageId='forged-package', boundCharacterId=''))
        self.assertEqual(item['sourceScope'], 'personal')
        self.assertEqual(item['sourcePlayerId'], self.pid)
        self.assertEqual(item['sourceCharacterId'], self.oid)
        self.assertEqual(item['boundCharacterId'], self.oid)
        self.assertIn(item['id'], {i['id'] for i in self.r.view(self.pid, 'c2')['items']})
        for host in (False, True):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.change(item, op='transfer', host=host, characterId=self.target, quantity=1)
        with self.assertRaises(SERVER.profiles.ProfileError): self.change(item, op='unbind')
        bag, _ = self.change(item, op='unbind', host=True)
        released = next(i for i in bag['items'] if i['id'] == item['id'])
        self.assertEqual(released['boundCharacterId'], '')
        self.change(released, op='transfer', characterId=self.target, quantity=1)
        moved = self.r.view(self.other, 'c2')['items'][0]
        self.assertEqual(moved['sourceScope'], 'personal')
        self.assertEqual(moved['sourceCharacterId'], self.oid)
        self.assertEqual(moved['ownerCharacterId'], self.target)
        self.assertEqual(moved['boundCharacterId'], '')

    def test_personal_edit_and_assign_cannot_remove_binding(self):
        item = self.grant('personal')
        bag, _ = self.change(item, op='edit', host=True,
            item=self.definition(scope='general', sourceScope='general', boundCharacterId=''))
        edited = next(i for i in bag['items'] if i['id'] == item['id'])
        self.assertEqual(edited['boundCharacterId'], self.oid)
        self.assertEqual(edited['sourceScope'], 'personal')
        second = self.store.grant(self.pid, dict(name='另一角色'), self.request_id())['pieces'][-1]['ownedPieceId']
        self.r.reconcile(self.state, self.pid)
        with self.assertRaises(SERVER.profiles.ProfileError): self.change(item, op='assign', characterId=second)

    def test_released_personal_healing_records_holder_separately_from_creation_origin(self):
        from server.inventory import CATALOG
        potion = dict(CATALOG[0], scope='personal')
        item = self.grant('personal', item=potion)
        self.change(item, op='unbind', host=True)
        self.change(item, op='transfer', characterId=self.target, quantity=1)
        bag = self.r.read(self.other)
        moved = bag['items'][0]
        target = self.r.character('c1', self.target)
        result, event = self.r.apply(self.other, 'c1', dict(op='heal', itemId=moved['id'],
            revision=bag['revision'], requestId=self.request_id(), characterId=self.target,
            sourceCharacterId=self.target, targetRevision=target['revision']), state=self.state)
        self.assertEqual(event['actingCharacterId'], self.target)
        self.assertEqual(event['sourceCharacterId'], self.oid)
        self.assertEqual(event['sourcePlayerId'], self.pid)
        self.assertEqual(result['items'][0]['quantity'], 0)

    def test_from_bag_keeps_origin_and_rejects_personal_global_template(self):
        item = self.grant()
        library = ItemLibrary(self.store, SERVER.profiles)
        def command(target, **extra):
            return dict(op='fromBag', revision=library.read()['revision'], requestId=self.request_id(),
                playerId=self.pid, itemId=target['id'], characterId=self.oid,
                bagRevision=self.r.read(self.pid)['revision'], **extra)
        with self.assertRaises(SERVER.profiles.ProfileError):
            library.apply(command(item, item=dict(scope='general')))
        with self.assertRaises(SERVER.profiles.ProfileError):
            wrong = command(item); wrong['characterId'] = self.target; library.apply(wrong)
        created = library.apply(command(item))
        template = next(t for t in created['library']['templates'] if t['id'] == created['templateId'])
        self.assertEqual(template['scope'], 'campaign')
        self.assertEqual(template['campaignId'], 'c1')
        self.assertEqual(template['contentPackageId'], item['sourcePackageId'])
        personal = self.grant('personal')
        with self.assertRaises(SERVER.profiles.ProfileError): library.apply(command(personal))

    def test_map_mixed_container_filters_and_rejects_disabled_content(self):
        self.enable_other()
        library = ItemLibrary(self.store, SERVER.profiles)
        made = library.apply(dict(op='create', revision=library.read()['revision'], requestId=self.request_id(),
            item=self.definition(scope='campaign', campaignId='c1')))
        loot = MapItems(self.store, SERVER.profiles)
        state = dict(campaignId='c2', activeMapId='m', maps=[dict(id='m', playerAccessible=True, mapW=500, mapH=500)])
        def get(): return loot.apply(dict(op='get', campaignId='c2', mapId='m'), state, True)
        def apply(op, **extra):
            return loot.apply(dict(op=op, campaignId='c2', mapId='m', revision=get()['revision'],
                requestId=self.request_id(), **extra), state, True)
        box = apply('container', visible=True)['markers'][0]
        box = apply('add', markerId=box['id'], templateId=made['templateId'], templateVersion=1, quantity=2)['markers'][0]
        hidden_id = box['items'][0]['id']
        apply('add', markerId=box['id'], templateId='healing', templateVersion=1, quantity=1)
        direct = apply('place', templateId=made['templateId'], templateVersion=1, quantity=1, visible=True)['markers'][-1]
        before = copy.deepcopy(self.r.ledger()['mapItems'])
        self.enable_other(False)
        shown = get()['markers']
        self.assertEqual([m['id'] for m in shown], [box['id']])
        self.assertEqual([i['name'] for i in shown[0]['items']], ['治疗药水'])
        for op in ('grant', 'unpack', 'deleteContent'):
            with self.assertRaises(SERVER.profiles.ProfileError):
                apply(op, markerId=box['id'], itemId=hidden_id, quantity=1, playerId=self.pid, characterId=self.oid)
        with self.assertRaises(SERVER.profiles.ProfileError): apply('move', markerId=direct['id'], markerRevision=direct['revision'], x=30)
        self.assertEqual(self.r.ledger()['mapItems'], before)
        self.enable_other()
        self.assertEqual(len(get()['markers']), 2)
        apply('grant', markerId=box['id'], itemId=hidden_id, quantity=1, playerId=self.pid, characterId=self.oid)
        received = next(i for i in self.r.view(self.pid, 'c2')['items'] if i['name'] == '潮汐密钥')
        self.assertEqual(received['sourcePackageId'], self.c1_package)

    def test_player_map_pickup_accepts_current_context_and_rejects_stale_context(self):
        loot = MapItems(self.store, SERVER.profiles)
        state = dict(campaignId='c1', activeMapId='m', maps=[dict(id='m', playerAccessible=True, mapW=500, mapH=500)])
        placed = loot.apply(dict(op='place', campaignId='c1', mapId='m', revision=0,
            requestId=self.request_id(), templateId='healing', templateVersion=1, quantity=1, visible=True), state, True)
        marker = placed['markers'][0]
        player = dict(playerId=self.pid, persistent=True)
        take = dict(op='take', campaignId='c1', mapId='m', markerId=marker['id'], markerRevision=marker['revision'],
            itemId=marker['items'][0]['id'], characterId=self.oid, quantity=1, requestId=self.request_id(),
            packageContextRevision=placed['packageContextRevision'])
        before = copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            loot.apply(dict(take, packageContextRevision='stale'), state, False, player)
        self.assertEqual(self.r.ledger(), before)
        self.assertEqual(loot.apply(take, state, False, player)['markers'], [])
        final = copy.deepcopy(self.r.ledger())
        self.assertEqual(loot.apply(take, state, False, player)['markers'], [])
        self.assertEqual(self.r.ledger(), final)


if __name__ == '__main__': unittest.main()
