"""Inventory limits apply to held items, while empty undo/receipt anchors survive."""
import copy
import unittest
import test_resources as fixtures
from server.resources import ResourceStore
from server.resource_database import ResourceDatabase


class ItemCapacityTests(unittest.TestCase):
    setUp = fixtures.ResourceTests.setUp
    character = fixtures.ResourceTests.character
    command = fixtures.ResourceTests.command

    def change(self, op, pid=None, host=False, **fields):
        pid = pid or self.pid
        bag = self.r.read(pid)
        command = dict(op=op, revision=bag['revision'], requestId='capacity-%s-%012d' % (op, bag['revision']))
        command.update(fields)
        return self.r.apply(pid, 'c1', command, host, state=self.state)

    def fill(self, pid=None, held=0, empty=0):
        pid = pid or self.pid
        data = self.r.ledger()
        bag = self.r.read(pid)
        data['backpacks'][pid] = bag
        for index in range(held + empty):
            item = copy.deepcopy(self.bag['items'][0])
            item.update(id='i' + ('%032x' % (index + 1)), name='旧物品-%d' % index,
                        quantity=1 if index < held else 0)
            bag['items'].append(item)
        self.r.save(data)

    def test_empty_entries_do_not_block_new_grants_and_keep_their_ids(self):
        self.fill(empty=299)
        empty_ids = {i['id'] for i in self.r.read(self.pid)['items'] if i['quantity'] == 0}
        definition = dict(name='新银条', category='gear', rarity='', consumable=False, effect='贵金属')
        bag, _ = self.change('grant', host=True, item=definition, quantity=1)
        self.assertEqual(len([i for i in bag['items'] if i['quantity'] > 0]), 2)
        self.assertEqual({i['id'] for i in bag['items'] if i['quantity'] == 0}, empty_ids)

    def test_empty_recipient_entries_do_not_block_transfer_or_duplicate_retries(self):
        self.fill(pid=self.other, empty=300)
        command = self.command(op='transfer', quantity=1, requestId='capacity-transfer-retry')
        bag, event = self.r.apply(self.pid, 'c1', command, state=self.state)
        recipient = self.r.read(self.other)
        self.assertEqual(len([i for i in recipient['items'] if i['quantity'] > 0]), 1)
        self.assertEqual(recipient['items'][-1]['quantity'], 1)
        replay, replay_event = self.r.apply(self.pid, 'c1', command, state=self.state)
        self.assertEqual((replay, replay_event), (bag, event))
        self.assertEqual(self.r.read(self.other), recipient)

    def test_held_limit_rejects_revival_and_adjust_without_mutating(self):
        iid = self.bag['items'][0]['id']
        self.change('adjust', host=True, itemId=iid, quantity=0)
        self.fill(held=300)
        before = self.r.ledger()
        for op, fields in [('grant', dict(presetId='healing', quantity=1)),
                           ('adjust', dict(itemId=iid, quantity=1))]:
            with self.subTest(op=op):
                with self.assertRaises(fixtures.SERVER.profiles.ProfileError):
                    self.change(op, host=True, **fields)
                self.assertEqual(self.r.ledger(), before)

    def test_new_grant_does_not_destroy_last_potion_undo_anchor(self):
        iid = self.bag['items'][0]['id']
        self.change('adjust', host=True, itemId=iid, quantity=1)
        bag, event = self.r.apply(self.pid, 'c1', self.command(requestId='capacity-heal-last-one'), state=self.state)
        self.assertEqual(bag['items'][0]['quantity'], 0)
        anchor = copy.deepcopy(bag['items'][0])
        self.fill(empty=299)
        self.change('grant', host=True, item=dict(name='钥匙', category='gear', rarity='', consumable=False, effect='开门'), quantity=1)
        self.assertEqual(next(i for i in self.r.read(self.pid)['items'] if i['id'] == iid), anchor)
        bag, _ = self.change('undo', host=True, eventId=event['id'])
        self.assertEqual(next(i for i in bag['items'] if i['id'] == iid)['quantity'], 1)
        self.assertEqual(self.character()['runtime']['hp'], event['beforeHp'])

    def test_recovery_merges_identical_new_stack_without_losing_annotations(self):
        iid = self.bag['items'][0]['id']
        _, removed = self.change('discard', itemId=iid, quantity=3)
        bag, _ = self.change('grant', host=True, presetId='healing', quantity=1)
        new_id = bag['items'][0]['id']
        self.change('annotate', itemId=new_id, notes='', favorite=False)
        bag, _ = self.change('restore', removalId=removed['id'])
        held = [i for i in bag['items'] if i['quantity'] > 0]
        self.assertEqual([(i['id'], i['quantity']) for i in held], [(new_id, 4)])
        self.assertEqual(bag['removedItems'], [])

    def test_recovery_preserves_different_notes_in_separate_stack(self):
        iid = self.bag['items'][0]['id']
        self.change('annotate', itemId=iid, notes='原主人的笔记', favorite=True)
        _, removed = self.change('discard', itemId=iid, quantity=3)
        bag, _ = self.change('grant', host=True, presetId='healing', quantity=1)
        new_id = bag['items'][0]['id']
        self.change('annotate', itemId=new_id, notes='新的标记', favorite=False)
        bag, _ = self.change('restore', removalId=removed['id'])
        held = [i for i in bag['items'] if i['quantity'] > 0]
        self.assertEqual(len(held), 2)
        self.assertEqual({(i['notes'], i['favorite'], i['quantity']) for i in held},
                         {('新的标记', False, 1), ('原主人的笔记', True, 3)})

    def test_empty_entries_do_not_block_recovery_after_original_changes(self):
        iid = self.bag['items'][0]['id']
        _, removed = self.change('discard', itemId=iid, quantity=1)
        self.change('edit', host=True, itemId=iid,
                    item=dict(name='修改后的物品', category='gear', rarity='', consumable=False, effect='保留更改'))
        self.fill(empty=299)
        bag, _ = self.change('restore', removalId=removed['id'])
        held = [i for i in bag['items'] if i['quantity'] > 0]
        self.assertEqual({(i['name'], i['quantity']) for i in held}, {('修改后的物品', 2), ('治疗药水', 1)})

    def test_full_transfer_can_replace_a_held_slot_with_an_empty_own_role_stack(self):
        companion = self.store.grant(self.pid, dict(name='伙伴', hpMax=10), 'capacity-companion')['pieces'][-1]['ownedPieceId']
        self.state['maps'][0]['tokens'].append(dict(id='t3', ownedPieceId=companion, ownerPlayerId=self.pid,
                                                 name='伙伴', hp=10, hpMax=10))
        self.r.reconcile(self.state, self.pid)
        iid = self.bag['items'][0]['id']
        self.change('assign', host=True, itemId=iid, characterId=self.oid)
        self.fill(held=299)
        data = self.r.ledger()
        destination = copy.deepcopy(data['backpacks'][self.pid]['items'][0])
        destination.update(id='i' + 'e' * 32, ownerCharacterId=companion, quantity=0)
        data['backpacks'][self.pid]['items'].append(destination)
        self.r.save(data)
        bag, _ = self.change('transfer', itemId=iid, characterId=companion, quantity=3)
        self.assertEqual(len([i for i in bag['items'] if i['quantity'] > 0]), 300)
        self.assertEqual(next(i for i in bag['items'] if i['id'] == destination['id'])['quantity'], 3)
        self.assertEqual(next(i for i in bag['items'] if i['id'] == iid)['quantity'], 0)

    def test_existing_held_stack_can_receive_more_at_capacity(self):
        target, _ = self.change('grant', pid=self.other, host=True, presetId='healing', quantity=1,
                                characterId=self.target)
        target_id = target['items'][0]['id']
        self.fill(pid=self.other, held=299)
        self.change('transfer', itemId=self.bag['items'][0]['id'], characterId=self.target, quantity=1)
        target = self.r.read(self.other)
        self.assertEqual(len([i for i in target['items'] if i['quantity'] > 0]), 300)
        self.assertEqual(next(i for i in target['items'] if i['id'] == target_id)['quantity'], 2)

    def test_capacity_and_restoration_merge_survive_sqlite_reload(self):
        data = self.r.ledger()
        data['characters'] = {'@global': data['characters']['c1']}
        data['backpacks'][self.pid]['items'][0]['ownerCharacterId'] = self.oid
        ResourceDatabase(self.store.save_root).activate(data,
            {pid: self.store.library(pid) for pid in (self.pid, self.other)}, {'test': 'capacity'})
        self.r = ResourceStore(self.store, fixtures.SERVER.profiles)
        self.fill(empty=299)
        iid = self.bag['items'][0]['id']
        _, removed = self.change('discard', itemId=iid, quantity=3)
        bag, _ = self.change('grant', host=True, presetId='healing', characterId=self.oid, quantity=1)
        new_id = next(i['id'] for i in bag['items'] if i['quantity'] > 0)
        bag, _ = self.change('restore', removalId=removed['id'])
        reloaded = ResourceStore(self.store, fixtures.SERVER.profiles).read(self.pid)
        self.assertEqual([(i['id'], i['quantity']) for i in reloaded['items'] if i['quantity'] > 0], [(new_id, 4)])
        self.assertEqual(reloaded['removedItems'], [])
        self.assertEqual(reloaded['revision'], bag['revision'])


if __name__ == '__main__':
    unittest.main()
