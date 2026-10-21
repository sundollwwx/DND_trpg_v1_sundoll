"""User flows across trash, reusable items, map permissions and canonical modules."""
import copy
import hashlib
import json
import threading
import unittest
from unittest import mock
from pathlib import Path
from test_resources import ResourceTests, SERVER
from test_workspace_v4 import WorkspaceTests
from server.resources import ResourceStore
from server.inventory import InventoryStore, item_definition
from server.map_items import MapItems
from server.item_library import ItemLibrary
from server.resource_database import ResourceDatabase
from server.module_store import ModuleStore


class ItemAuditTests(unittest.TestCase):
    setUp = ResourceTests.setUp

    def change(self, op, host=False, pid=None, **fields):
        pid=pid or self.pid
        command=dict(op=op, revision=self.r.read(pid)['revision'], requestId='audit-'+op+'-'+str(self.r.read(pid)['revision']).zfill(12))
        command.update(fields)
        return self.r.apply(pid, 'c1', command, host, state=self.state)

    def test_player_reclaims_discard_but_cannot_reclaim_dm_deletion(self):
        item_id=self.bag['items'][0]['id']
        bag,event=self.change('discard',itemId=item_id,quantity=1)
        bag,_=self.change('restore',removalId=event['id'])
        self.assertEqual(bag['items'][0]['quantity'],3)
        bag,event=self.change('delete',True,itemId=item_id)
        before=self.r.ledger()
        with self.assertRaises(SERVER.profiles.ProfileError) as raised:self.change('restore',removalId=event['id'])
        self.assertEqual(raised.exception.status,403);self.assertEqual(before,self.r.ledger())

    def test_clear_trash_is_host_only_atomic_and_old_retry_does_not_clear_new_trash(self):
        item_id=self.bag['items'][0]['id']
        self.change('discard',itemId=item_id,quantity=1)
        bag,_=self.change('discard',itemId=item_id,quantity=1)
        command=dict(op='purgeAll',revision=bag['revision'],requestId='audit-clear-trash-000001')
        before=self.r.ledger()
        with self.assertRaises(SERVER.profiles.ProfileError):self.r.apply(self.pid,'c1',command,state=self.state)
        self.assertEqual(before,self.r.ledger())
        bag,event=self.r.apply(self.pid,'c1',command,True,state=self.state)
        self.assertEqual(event['count'],2);self.assertEqual(bag['removedItems'],[]);self.assertEqual(bag['items'][0]['quantity'],1)
        self.change('discard',itemId=item_id,quantity=1)
        replay,_=self.r.apply(self.pid,'c1',command,True,state=self.state)
        self.assertEqual(len(replay['removedItems']),1)
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('purgeAll',True,revision=command['revision'])

    def test_identical_transfers_merge_but_different_bodies_never_merge(self):
        item_id=self.bag['items'][0]['id']
        for i in range(2):self.change('transfer',itemId=item_id,characterId=self.target,quantity=1)
        target=self.r.read(self.other)
        self.assertEqual(len(target['items']),1);self.assertEqual(target['items'][0]['quantity'],2)
        doc=dict(name='旧日记',category='document',documentType='book',effect='阅读',rarity='',consumable=False,body='未解之谜')
        bag,_=self.change('edit',True,itemId=item_id,item=doc)
        self.change('transfer',itemId=item_id,characterId=self.target,quantity=1)
        bag,_=self.change('grant',True,item=dict(doc,body='不同的线索'),quantity=1,characterId=self.oid)
        doc_id=next(i['id'] for i in bag['items'] if i['quantity']>0)
        self.change('transfer',itemId=doc_id,characterId=self.target,quantity=1)
        books=[i for i in self.r.read(self.other)['items'] if i['category']=='document']
        self.assertEqual({i['body'] for i in books},{'未解之谜','不同的线索'})

    def test_durable_use_records_without_deducting_and_consumable_deducts_once(self):
        item_id=self.bag['items'][0]['id']
        self.change('edit',True,itemId=item_id,item=dict(name='护符',category='gear',rarity='',consumable=False,effect='随身佩戴'))
        bag,event=self.change('use',itemId=item_id)
        self.assertEqual((bag['items'][0]['quantity'],event['delta']),(3,0))
        self.change('edit',True,itemId=item_id,item=dict(name='酒',category='gear',rarity='',consumable=True,effect='饮用'))
        bag,event=self.change('use',itemId=item_id)
        self.assertEqual((bag['items'][0]['quantity'],event['delta']),(2,-1))

    def test_full_transfer_between_own_roles_merges_and_replays_once(self):
        companion=self.store.grant(self.pid,dict(name='伙伴',hpMax=10), 'audit-own-companion')['pieces'][-1]['ownedPieceId']
        self.state['maps'][0]['tokens'].append(dict(id='t3',ownedPieceId=companion,ownerPlayerId=self.pid,name='伙伴',hp=10,hpMax=10))
        self.r.reconcile(self.state,self.pid)
        item_id=self.bag['items'][0]['id']
        self.change('assign',True,itemId=item_id,characterId=self.oid)
        bag,_=self.change('grant',True,presetId='healing',quantity=1,characterId=companion)
        target_id=next(i['id'] for i in bag['items'] if i.get('ownerCharacterId')==companion)
        command=dict(op='transfer',itemId=item_id,characterId=companion,quantity=3,revision=bag['revision'],requestId='audit-own-full-transfer')
        bag,_=self.r.apply(self.pid,'c1',command,state=self.state)
        active=[i for i in bag['items'] if i['quantity']>0]
        self.assertEqual([(i['id'],i['quantity'],i['ownerCharacterId']) for i in active],[(target_id,4,companion)])
        replay,_=self.r.apply(self.pid,'c1',command,state=self.state)
        self.assertEqual(bag,replay)

    def test_transfer_merges_into_unannotated_grant_and_preserves_annotated_stacks(self):
        item_id=self.bag['items'][0]['id']
        target,_=self.change('grant',True,pid=self.other,presetId='healing',quantity=1,characterId=self.target)
        target_id=target['items'][0]['id']
        self.change('transfer',itemId=item_id,characterId=self.target,quantity=1)
        target=self.r.read(self.other)
        self.assertEqual([(i['id'],i['quantity']) for i in target['items']],[(target_id,2)])
        self.change('annotate',pid=self.other,itemId=target_id,notes='属于法师的标记')
        self.change('transfer',itemId=item_id,characterId=self.target,quantity=1)
        target=self.r.read(self.other)
        self.assertEqual(len(target['items']),2)
        self.assertEqual(next(i for i in target['items'] if i['id']==target_id)['notes'],'属于法师的标记')

    def test_legacy_campaign_migration_preserves_trash_and_disambiguates_colliding_ids(self):
        store=InventoryStore(self.store,SERVER.profiles)
        item_id='i'+'a'*32
        for campaign in ('old-1','old-2'):
            definition=item_definition(dict(name=campaign,category='gear',rarity='',consumable=False,effect='旧物'),ValueError)
            item=dict(definition,id=item_id,quantity=2)
            value=dict(playerId=self.other,campaignId=campaign,revision=1,items=[item],history=[],receipts={},
                       removedItems=[dict(id='same-removal-id-01',at=1,op='discard',item=dict(item,quantity=1))])
            path=store.path(self.other).parent/(hashlib.sha256(campaign.encode()).hexdigest()+'.json')
            SERVER.profiles.atomic(path,value)
        bag=store.read(self.other)
        self.assertEqual(len({i['id'] for i in bag['items']}),2)
        self.assertEqual(len({r['id'] for r in bag['removedItems']}),2)
        self.assertEqual({r['item']['id'] for r in bag['removedItems']},{i['id'] for i in bag['items']})
        for entry in list(bag['removedItems']):
            bag,_=store.apply(self.other,None,dict(op='restore',revision=bag['revision'],requestId='restore-'+entry['id'],removalId=entry['id']))
        self.assertEqual([i['quantity'] for i in bag['items']],[3,3])
        self.assertEqual(bag['removedItems'],[])

    def map(self):return MapItems(self.store,SERVER.profiles)
    def map_command(self,op,**fields):
        context=dict(campaignId='c1',mapId='map1')
        group=self.map().apply(dict(context,op='get'),self.state,True)
        return dict(context,op=op,revision=group['revision'],requestId='audit-map-'+str(group['revision']).zfill(12),**fields)
    def map_change(self,op,**fields):return self.map().apply(self.map_command(op,**fields),self.state,True)

    def test_map_template_defaults_player_permissions_and_host_override(self):
        raw=dict(name='古碑',category='gear',rarity='',effect='铭刻文字',consumable=False,mapDefaults=dict(positionLocked=True,pickupAllowed=False))
        result=self.map_change('place',item=raw,quantity=1,visible=True)
        marker=result['markers'][0];player=dict(playerId=self.pid,persistent=True)
        self.assertTrue(marker['positionLocked']);self.assertFalse(marker['pickupAllowed'])
        before=self.r.ledger()
        for op,fields in [('take',dict(itemId=marker['items'][0]['id'],quantity=1,characterId=self.oid)),('move',dict(x=20,y=10)),('editContent',dict(item=raw))]:
            command=dict(self.map_command(op,markerId=marker['id'],markerRevision=marker['revision']),**fields)
            with self.assertRaises(SERVER.profiles.ProfileError):self.map().apply(command,self.state,False,player)
            self.assertEqual(before,self.r.ledger())
        updated=self.map_change('update',markerId=marker['id'],positionLocked=False,pickupAllowed=True)['markers'][0]
        take=self.map_command('take',markerId=updated['id'],markerRevision=updated['revision'],itemId=updated['items'][0]['id'],quantity=1,characterId=self.oid)
        self.map().apply(take,self.state,False,player)
        self.assertEqual(self.map_change('container')['markers'][-1]['kind'],'container')
        self.assertTrue(any(i['name']=='古碑' for i in self.r.read(self.pid)['items']))

    def test_map_content_edits_quantity_body_and_consumption_without_changing_template(self):
        marker=self.map_change('container')['markers'][0]
        raw=dict(name='线索',category='document',documentType='letter',rarity='',effect='阅读',consumable=False,body='船长的请求')
        self.map_change('add',markerId=marker['id'],item=raw,quantity=1)
        group=self.map().apply(dict(op='get',campaignId='c1',mapId='map1'),self.state,True);item=group['markers'][0]['items'][0]
        edited=dict(raw,body='改写的信件')
        command=self.map_command('editContent',markerId=marker['id'],itemId=item['id'],item=edited,quantity=3)
        result=self.map().apply(command,self.state,True)
        self.assertEqual((result['markers'][0]['items'][0]['body'],result['markers'][0]['items'][0]['quantity']),('改写的信件',3))
        self.assertEqual(result,self.map().apply(command,self.state,True))
        before=self.r.ledger()
        with self.assertRaises(SERVER.profiles.ProfileError):self.map_change('editContent',markerId=marker['id'],itemId=item['id'],item=dict(name='箱',category='container',effect='容器',consumable=False),quantity=1)
        self.assertEqual(before,self.r.ledger())

    def test_legacy_container_can_be_edited_without_replacing_contents_or_lock(self):
        chest=self.map_change('container',visible=True)['markers'][0]
        chest=self.map_change('update',markerId=chest['id'],locked=True)['markers'][0]
        chest=self.map_change('add',markerId=chest['id'],presetId='climbing',quantity=2)['markers'][0]
        self.assertNotIn('containerItem',chest)
        raw=dict(name='改写后的旧箱',category='container',rarity='',effect='旧容器',consumable=False,description='仍是同一个箱子')
        edited=self.map_change('editContent',markerId=chest['id'],itemId='@container',item=raw)['markers'][0]
        self.assertEqual(edited['items'],chest['items']);self.assertTrue(edited['locked'])
        self.assertEqual(edited['name'],raw['name']);self.assertEqual(edited['containerItem']['description'],raw['description'])

    def test_two_players_take_last_item_only_once(self):
        marker=self.map_change('place',presetId='climbing',quantity=1,visible=True)['markers'][0]
        outcomes=[]
        def take(pid,cid):
            command=dict(op='take',campaignId='c1',mapId='map1',markerId=marker['id'],markerRevision=marker['revision'],itemId=marker['items'][0]['id'],quantity=1,characterId=cid,requestId='last-item-'+pid)
            try:self.map().apply(command,self.state,False,dict(playerId=pid,persistent=True));outcomes.append('ok')
            except SERVER.profiles.ProfileError:outcomes.append('conflict')
        workers=[threading.Thread(target=take,args=pair) for pair in [(self.pid,self.oid),(self.other,self.target)]]
        for worker in workers:worker.start()
        for worker in workers:worker.join()
        self.assertEqual(sorted(outcomes),['conflict','ok'])
        self.assertEqual(sum(i['quantity'] for pid in (self.pid,self.other) for i in self.r.read(pid)['items'] if i['name']=='攀爬药水'),1)

    def test_map_permission_validation_rejects_truthy_strings(self):
        for defaults in [dict(pickupAllowed='false'),dict(positionLocked=1),dict(unknown=True)]:
            with self.assertRaises(ValueError):item_definition(dict(name='物品',category='gear',effect='持有',consumable=False,mapDefaults=defaults),ValueError)

    def test_unpacked_content_retains_its_own_ground_defaults_after_reload(self):
        chest=self.map_change('container',visible=True)['markers'][0]
        raw=dict(name='古碑',category='gear',effect='铭文',rarity='',consumable=False,mapDefaults=dict(positionLocked=True,pickupAllowed=False))
        chest=self.map_change('add',markerId=chest['id'],item=raw,quantity=1)['markers'][0]
        self.map_change('unpack',markerId=chest['id'],itemId=chest['items'][0]['id'])
        group=self.map().apply(dict(op='get',campaignId='c1',mapId='map1'),self.state,True)
        stone=next(m for m in group['markers'] if m['kind']=='item')
        self.assertTrue(stone.get('positionLocked',False))
        self.assertFalse(stone.get('pickupAllowed',True))
        self.assertEqual(group['markers'][0]['items'],[])
        before=self.r.ledger()
        for op,fields in [('move',dict(x=20,y=10)),('take',dict(itemId=stone['items'][0]['id'],quantity=1,characterId=self.oid))]:
            command=self.map_command(op,markerId=stone['id'],markerRevision=stone.get('revision',0),**fields)
            with self.assertRaises(SERVER.profiles.ProfileError):self.map().apply(command,self.state,False,dict(playerId=self.pid,persistent=True))
            self.assertEqual(before,self.r.ledger())

    def test_archived_template_purge_is_idempotent_and_keeps_existing_instances(self):
        lib=ItemLibrary(self.store,SERVER.profiles);current=lib.resolve('healing',1)
        before=self.r.read(self.pid)
        def command(op,template):return dict(op=op,templateId=template['id'],templateVersion=template['version'],revision=lib.read()['revision'],requestId='audit-library-'+op+'-'+str(template['version']).zfill(8))
        with self.assertRaises(SERVER.profiles.ProfileError):lib.apply(command('purge',current))
        archived=lib.apply(command('archive',current))['library']['templates'][0]
        purge=command('purge',archived);lib.apply(purge);lib.apply(purge)
        self.assertNotIn('healing',[t['id'] for t in lib.read()['templates']]);self.assertEqual(before,self.r.read(self.pid))


class SQLiteItemAuditTests(ItemAuditTests):
    def setUp(self):
        super().setUp()
        data=self.r.ledger();data['characters']={'@global':data['characters']['c1']}
        ResourceDatabase(self.store.save_root).activate(data,{pid:self.store.library(pid) for pid in (self.pid,self.other)},{'test':'audit'})
        self.r=ResourceStore(self.store,SERVER.profiles)
        self.change('assign',True,itemId=self.bag['items'][0]['id'],characterId=self.oid)

    def test_failed_trash_transaction_keeps_live_quantity_and_archives(self):
        item_id=self.bag['items'][0]['id'];before=self.r.ledger();write=ModuleStore.write_document
        def fail(db,kind,*args):
            if kind=='runtime-backpack':raise OSError('disk full')
            return write(db,kind,*args)
        with mock.patch.object(ModuleStore,'write_document',side_effect=fail):
            with self.assertRaises(OSError):self.change('discard',itemId=item_id,quantity=1)
        self.assertEqual(before,self.r.ledger())


class ModuleItemAuditTests(unittest.TestCase):
    setUp=WorkspaceTests.setUp
    records=WorkspaceTests.records

    def test_trash_and_map_permissions_publish_to_correct_modules_and_reload(self):
        from server import player_profiles as profiles
        pid=self.profiles.create('玩家')['profile']['playerId']
        piece=self.profiles.grant(pid,dict(name='角色'),'module-audit-character')['pieces'][0];cid=piece['ownedPieceId']
        r=ResourceStore(self.profiles,profiles);state=dict(campaignId='c1',maps=[dict(id='m1',playerAccessible=True,tokens=[dict(piece,id='t')])]);r.reconcile(state,pid)
        bag,_=r.apply(pid,'c1',dict(op='grant',presetId='healing',quantity=2,characterId=cid,revision=0,requestId='module-audit-grant-001'),True,state)
        bag,_=r.apply(pid,'c1',dict(op='discard',itemId=bag['items'][0]['id'],quantity=1,revision=bag['revision'],requestId='module-audit-discard-001'),False,state)
        records=self.records(self.profiles.path(pid,'当前档案.json').parent);saved=next(r['data'] for r in records if r['kind']=='runtime-backpack')
        self.assertEqual(saved['removedItems'][0]['item']['quantity'],1)
        self.assertEqual(ResourceStore(self.profiles,profiles).read(pid)['removedItems'],bag['removedItems'])
        loot=MapItems(self.profiles,profiles);loot.apply(dict(op='place',campaignId='c1',mapId='m1',revision=0,requestId='module-audit-map-001',item=dict(name='纪念碑',category='gear',effect='阅读刻文',rarity='',consumable=False,mapDefaults=dict(positionLocked=True,pickupAllowed=False)),quantity=1),state,True)
        saved_map=next(r['data'] for r in self.records(self.package/'战役包/c1-冒险') if r['kind']=='runtime-map')
        self.assertTrue(saved_map['m1']['markers'][0]['positionLocked']);self.assertFalse(saved_map['m1']['markers'][0]['pickupAllowed'])
        conn=ModuleStore(self.save).connect()
        try:self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        finally:conn.close()
