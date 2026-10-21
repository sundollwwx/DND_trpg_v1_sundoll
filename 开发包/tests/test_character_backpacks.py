from project_test_paths import APP_ROOT
import copy
import unittest
from unittest import mock
import test_global_resources as fixtures
from test_resources import SERVER
from server.resources import ResourceStore
from server.character_inventory import migrate_unassigned
from server.map_items import MapItems
from server.module_store import ModuleStore


class CharacterBackpackTests(fixtures.GlobalResourceTests):

    def grant(self, oid, rid='role-direct-grant-001', quantity=2):
        return self.r.apply(self.pid, 'c1', dict(op='grant', characterId=oid,
            presetId='healing', quantity=quantity, revision=self.r.read(self.pid)['revision'], requestId=rid), True)

    def second_role(self):
        return self.store.grant(self.pid, dict(name='战士',hpMax=43,ac=17), 'second-role-grant-001')['pieces'][-1]['ownedPieceId']

    def test_direct_grant_same_name_roles_never_share_or_merge_inventory(self):
        second = self.second_role()
        bag, _ = self.grant(second)
        self.assertEqual({i['ownerCharacterId']:i['quantity'] for i in bag['items']}, {self.oid:3,second:2})
        self.grant(second, 'role-direct-grant-002', 1)
        bag = ResourceStore(self.store,SERVER.profiles).read(self.pid,'other-campaign')
        self.assertEqual({i['ownerCharacterId']:i['quantity'] for i in bag['items']}, {self.oid:3,second:3})

    def test_missing_foreign_and_unknown_recipients_never_write(self):
        for oid in ('',self.target,'missing'):
            before=self.r.ledger()
            with self.assertRaises(SERVER.profiles.ProfileError): self.grant(oid)
            self.assertEqual(before,self.r.ledger())

    def test_retry_does_not_duplicate_or_retarget_a_grant(self):
        second=self.second_role()
        cmd=dict(op='grant',characterId=self.oid,presetId='healing',quantity=1,
                 revision=self.r.read(self.pid)['revision'],requestId='idempotent-role-grant')
        first=self.r.apply(self.pid,'c1',cmd,True)
        self.assertEqual(first,self.r.apply(self.pid,'c1',cmd,True))
        with self.assertRaises(SERVER.profiles.ProfileError): self.r.apply(self.pid,'c1',dict(cmd,characterId=second),True)
        self.assertEqual(self.r.read(self.pid)['items'][0]['quantity'],4)

    def test_migration_requires_ambiguous_choice_preserves_items_and_is_idempotent(self):
        self.second_role();data=self.r.ledger();item=data['backpacks'][self.pid]['items'][0]
        item.pop('ownerCharacterId');self.r.save(data);before=self.r.ledger()
        with self.assertRaisesRegex(ValueError,'请指定'): migrate_unassigned(self.r)
        self.assertEqual(before,self.r.ledger())
        choices={item['id']:self.oid}
        plan=migrate_unassigned(self.r,choices,dry_run=True)
        self.assertEqual(len(plan),1);self.assertEqual(before,self.r.ledger())
        migrate_unassigned(self.r,choices)
        after=self.r.read(self.pid)['items'][0]
        self.assertEqual((after['id'],after['quantity'],after['ownerCharacterId']),(item['id'],3,self.oid))
        self.assertEqual(migrate_unassigned(self.r,choices),[])

    def test_map_pickup_targets_role_and_rejects_foreign_role_without_loot_loss(self):
        second=self.second_role();loot=MapItems(self.store,SERVER.profiles)
        ctx=dict(campaignId='c1',mapId='map1')
        placed=loot.apply(dict(ctx,op='place',revision=0,requestId='place-role-loot-001',
            templateId='healing',templateVersion=1,quantity=2,visible=True),self.state,True)
        marker=placed['markers'][0]
        public=loot.apply(dict(ctx,op='get'),self.state,False,player=dict(playerId=self.pid,persistent=True))
        self.assertEqual({c['id'] for c in public['recipients']},{self.oid,second})
        cmd=dict(ctx,op='take',markerId=marker['id'],markerRevision=marker['revision'],
            itemId=marker['items'][0]['id'],quantity=1,characterId=self.target,requestId='take-role-loot-001')
        before=self.r.ledger()
        with self.assertRaises(SERVER.profiles.ProfileError):loot.apply(cmd,self.state,False,player=dict(playerId=self.pid,persistent=True))
        self.assertEqual(before,self.r.ledger())
        cmd['characterId']=second
        result=loot.apply(cmd,self.state,False,player=dict(playerId=self.pid,persistent=True))
        self.assertEqual(result,loot.apply(cmd,self.state,False,player=dict(playerId=self.pid,persistent=True)))
        self.assertEqual(result['markers'][0]['items'][0]['quantity'],1)
        self.assertEqual(next(i for i in self.r.read(self.pid)['items'] if i['ownerCharacterId']==second)['quantity'],1)

    def test_map_grant_commit_failure_changes_neither_loot_nor_role_bag(self):
        loot=MapItems(self.store,SERVER.profiles);ctx=dict(campaignId='c1',mapId='map1')
        placed=loot.apply(dict(ctx,op='place',revision=0,requestId='place-role-loot-002',templateId='healing',templateVersion=1,quantity=2),self.state,True)
        marker=placed['markers'][0];before=self.r.ledger()
        cmd=dict(ctx,op='grant',revision=placed['revision'],markerId=marker['id'],itemId=marker['items'][0]['id'],
            quantity=1,playerId=self.pid,characterId=self.oid,requestId='grant-role-loot-002')
        write=ModuleStore.write_document
        def fail(db,kind,*args):
            if kind=='runtime-backpack': raise OSError('disk full')
            return write(db,kind,*args)
        with mock.patch.object(ModuleStore,'write_document',side_effect=fail):
            with self.assertRaises(OSError):loot.apply(cmd,self.state,True)
        self.assertEqual(before,self.r.ledger())

for name in dir(fixtures.GlobalResourceTests):
    if name.startswith("test_") and name not in CharacterBackpackTests.__dict__:
        setattr(CharacterBackpackTests, name, None)
