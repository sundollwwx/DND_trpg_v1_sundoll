from project_test_paths import APP_ROOT
import copy
import threading
import unittest
from unittest import mock
import test_resources as resource_tests
from server.inventory import InventoryStore, CATALOG
from server.resources import ResourceStore

SERVER=resource_tests.SERVER

class RemovalTests(unittest.TestCase):
    setUp=resource_tests.ResourceTests.setUp
    def change(self, op, host=False, **fields):
        bag=self.r.read(self.pid)
        command=dict(op=op,revision=bag['revision'],requestId=f'removal-{op}-{bag["revision"]:08d}')
        command.update(fields)
        return self.r.apply(self.pid,'c1',command,host,state=self.state)
    def test_delete_is_host_only_and_keeps_definition_and_other_player(self):
        item=self.bag['items'][0];catalog=copy.deepcopy(CATALOG);chars=self.r.ledger()['characters']
        for op in ('delete',):
            with self.assertRaises(SERVER.profiles.ProfileError) as raised:self.change(op,itemId=item['id'],removalId='no-record-0000000')
            self.assertEqual(raised.exception.status,403)
        bag,event=self.change('delete',True,itemId=item['id'])
        self.assertEqual(bag['items'],[]);self.assertEqual(event['delta'],-3)
        self.assertEqual(bag['removedItems'][0]['item']['quantity'],3)
        self.assertEqual(self.r.ledger()['characters'],chars);self.assertEqual(CATALOG,catalog)
        self.assertEqual(self.r.read(self.other)['items'],[])
    def test_partial_then_all_discard_restore_and_restart(self):
        iid=self.bag['items'][0]['id']
        bag,_=self.change('discard',itemId=iid,quantity=1)
        first=bag['removedItems'][0]['id'];self.assertEqual(bag['items'][0]['quantity'],2)
        bag,_=self.change('discard',itemId=iid,quantity=2)
        second=bag['removedItems'][1]['id'];self.assertEqual(bag['items'],[])
        self.r=ResourceStore(self.store,SERVER.profiles)
        previous_version=max(e['item'].get('resourceRevision',0) for e in bag['removedItems'])
        bag,_=self.change('restore',True,removalId=first);self.assertEqual(bag['items'][0]['quantity'],1)
        self.assertGreater(bag['items'][0]['resourceRevision'],previous_version)
        bag,_=self.change('restore',True,removalId=second)
        self.assertEqual(len(bag['items']),1);self.assertEqual(bag['items'][0]['quantity'],3);self.assertEqual(bag['removedItems'],[])
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('restore',True,removalId=second)
    def test_host_can_purge_one_removed_record_without_touching_live_items(self):
        iid=self.bag['items'][0]['id']
        bag,_=self.change('discard',itemId=iid,quantity=1)
        removed_id=bag['removedItems'][0]['id']
        command=dict(op='purge',removalId=removed_id,revision=bag['revision'],requestId='purge-removed-record-0001')
        with self.assertRaises(SERVER.profiles.ProfileError) as denied:self.r.apply(self.pid,'c1',command,state=self.state)
        self.assertEqual(denied.exception.status,403)
        bag,event=self.r.apply(self.pid,'c1',command,True,state=self.state)
        self.assertEqual(bag['removedItems'],[])
        self.assertEqual(bag['items'][0]['quantity'],2)
        self.assertEqual((event['op'],event['removalId'],event['remaining']),('purge',removed_id,0))
        replay,_=self.r.apply(self.pid,'c1',command,True,state=self.state)
        self.assertEqual(replay['revision'],bag['revision'])
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('restore',True,removalId=removed_id)
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('purge',True,removalId=removed_id)
    def test_document_body_notes_and_owner_survive_and_edits_are_not_overwritten(self):
        iid=self.bag['items'][0]['id'];definition=dict(name='密信',category='document',rarity='',consumable=False,effect='一封信',body='第一行\n第二行')
        self.change('edit',True,itemId=iid,item=definition)
        self.change('annotate',itemId=iid,notes='私人物品',favorite=True)
        self.change('assign',itemId=iid,characterId=self.oid)
        bag,_=self.change('discard',itemId=iid,quantity=1);rid=bag['removedItems'][0]['id']
        self.change('edit',True,itemId=iid,item=dict(definition,body='后来更正的正文'))
        bag,_=self.change('restore',True,removalId=rid)
        self.assertEqual(len(bag['items']),2)
        live=next(i for i in bag['items'] if i['id']==iid);restored=next(i for i in bag['items'] if i['id']!=iid)
        self.assertEqual(live['body'],'后来更正的正文');self.assertEqual(live['quantity'],2)
        self.assertEqual(restored['body'],definition['body']);self.assertEqual(restored['notes'],'私人物品')
        self.assertTrue(restored['favorite']);self.assertEqual(restored['ownerCharacterId'],self.oid)
    def test_invalid_quantities_and_stale_commands_leave_bag_unchanged(self):
        before=self.r.public(self.r.read(self.pid));iid=before['items'][0]['id']
        for qty in (0,-1,4,True,1.5,'1',None):
            with self.assertRaises(SERVER.profiles.ProfileError):self.change('discard',itemId=iid,quantity=qty)
        self.assertEqual(self.r.public(self.r.read(self.pid)),before)
        self.change('discard',itemId=iid,quantity=1)
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('delete',True,itemId=iid,revision=before['revision'])
        self.assertEqual(self.r.read(self.pid)['items'][0]['quantity'],2)
    def test_failed_write_and_uncertain_reply_are_atomic_and_idempotent(self):
        iid=self.bag['items'][0]['id'];cmd=dict(op='discard',itemId=iid,quantity=3,revision=self.bag['revision'],requestId='uncertain-discard-0001')
        before=self.r.ledger();atomic=SERVER.profiles.atomic
        def fail(path,value):
            if path==self.r.ledger_path:raise OSError('disk full')
            atomic(path,value)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail):
            with self.assertRaises(OSError):self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(self.r.ledger(),before)
        def uncertain(path,value):
            atomic(path,value)
            if path==self.r.ledger_path:raise OSError('lost response')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=uncertain):
            with self.assertRaises(OSError):self.r.apply(self.pid,'c1',cmd,state=self.state)
        bag,event=self.r.apply(self.pid,'c1',cmd,state=self.state);self.assertEqual(len(bag['removedItems']),1)
        restore=dict(op='restore',removalId=event['id'],revision=bag['revision'],requestId='uncertain-restore-0001')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=uncertain):
            with self.assertRaises(OSError):self.r.apply(self.pid,'c1',restore,True,state=self.state)
        bag,_=self.r.apply(self.pid,'c1',restore,True,state=self.state)
        self.assertEqual(bag['items'][0]['quantity'],3);self.assertEqual(bag['removedItems'],[])
        with self.assertRaises(SERVER.profiles.ProfileError):self.r.apply(self.pid,'c1',dict(restore,removalId='forged-record-0001'),True,state=self.state)
    def test_two_tabs_cannot_discard_the_same_quantity_twice(self):
        cmd=dict(op='discard',itemId=self.bag['items'][0]['id'],quantity=2,revision=self.bag['revision'])
        outcomes=[]
        def discard(i):
            try:self.r.apply(self.pid,'c1',dict(cmd,requestId=f'concurrent-discard-{i:02d}'),state=self.state);outcomes.append('ok')
            except SERVER.profiles.ProfileError:outcomes.append('conflict')
        threads=[threading.Thread(target=discard,args=(i,)) for i in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(sorted(outcomes),['conflict','ok']);self.assertEqual(self.r.read(self.pid)['items'][0]['quantity'],1)
    def test_corrupt_archive_fails_closed(self):
        bag,_=self.change('delete',True,itemId=self.bag['items'][0]['id'])
        data=self.r.ledger();data['backpacks'][self.pid]['removedItems'][0]['item']['quantity']=-1
        SERVER.profiles.atomic(self.r.ledger_path,data);raw=self.r.ledger_path.read_bytes()
        with self.assertRaises(SERVER.profiles.ProfileError) as raised:self.r.read(self.pid)
        self.assertEqual(raised.exception.status,503);self.assertEqual(self.r.ledger_path.read_bytes(),raw)
    def test_restoring_deleted_item_does_not_reenable_old_healing_undo(self):
        command=resource_tests.ResourceTests.command(self)
        bag,event=self.r.apply(self.pid,'c1',command,state=self.state)
        removed,_=self.change('delete',True,itemId=bag['items'][0]['id'])
        self.change('restore',True,removalId=removed['removedItems'][0]['id'])
        with self.assertRaises(SERVER.profiles.ProfileError) as raised:self.change('undo',True,eventId=event['id'])
        self.assertEqual(raised.exception.status,409)
    character=resource_tests.ResourceTests.character
    def test_legacy_store_can_read_removed_items_and_restore(self):
        store=InventoryStore(self.store,SERVER.profiles)
        bag,_=store.apply(self.other,None,dict(op='grant',presetId='healing',quantity=1,revision=0,requestId='legacy-removal-grant'),True)
        bag,event=store.apply(self.other,None,dict(op='delete',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId='legacy-removal-delete'),True)
        self.assertEqual(store.read(self.other)['items'],[])
        bag,_=store.apply(self.other,None,dict(op='restore',removalId=event['id'],revision=bag['revision'],requestId='legacy-removal-restore'),True)
        self.assertEqual(bag['items'][0]['quantity'],1)

import test_player_profiles as profile_tests

class RemovalHttpTests(unittest.TestCase):
    setUp=profile_tests.PlayerProfileHttpTests.setUp
    close_server=profile_tests.PlayerProfileHttpTests.close_server
    request=profile_tests.PlayerProfileHttpTests.request
    login=profile_tests.PlayerProfileHttpTests.login
    def test_player_can_discard_and_restore_own_but_not_delete_or_access_other_bag(self):
        session=self.login();other=SERVER.profile_store().create('乙')['profile']['playerId']
        status,result=self.request(dict(op='grant',playerId=self.pid,presetId='healing',quantity=3,revision=0,requestId='http-removal-grant'),host=True,path='/api/backpack');self.assertEqual(status,200,result)
        iid=result['backpack']['items'][0]['id'];base=dict(sessionToken=session,itemId=iid,revision=result['backpack']['revision'])
        self.assertEqual(self.request(dict(base,op='delete',requestId='http-removal-delete'),path='/api/backpack')[0],403)
        self.assertEqual(self.request(dict(base,op='discard',quantity=1,playerId=other,requestId='http-removal-foreign'),path='/api/backpack')[0],403)
        status,result=self.request(dict(base,op='discard',quantity=2,requestId='http-removal-discard'),path='/api/backpack');self.assertEqual(status,200,result)
        self.assertEqual(result['backpack']['items'][0]['quantity'],1)
        self.assertEqual(len(result['backpack']['removedItems']),1)
        rid=result['event']['id'];restore=dict(op='restore',removalId=rid,revision=result['backpack']['revision'],requestId='http-removal-restore')
        self.assertEqual(self.request(dict(restore,sessionToken=session,playerId=other),path='/api/backpack')[0],403)
        status,result=self.request(dict(restore,sessionToken=session),path='/api/backpack');self.assertEqual(status,200,result)
        self.assertEqual(result['backpack']['items'][0]['quantity'],3);self.assertEqual(result['backpack']['removedItems'],[])
    def test_player_cannot_purge_removed_record_but_host_can(self):
        session=self.login()
        status,result=self.request(dict(op='grant',playerId=self.pid,presetId='healing',quantity=1,revision=0,requestId='http-purge-grant-0001'),host=True,path='/api/backpack');self.assertEqual(status,200,result)
        item_id=result['backpack']['items'][0]['id']
        status,result=self.request(dict(op='discard',sessionToken=session,itemId=item_id,quantity=1,revision=result['backpack']['revision'],requestId='http-purge-discard-001'),path='/api/backpack');self.assertEqual(status,200,result)
        command=dict(op='purge',removalId=result['event']['id'],revision=result['backpack']['revision'],requestId='http-purge-record-0001')
        self.assertEqual(self.request(dict(command,sessionToken=session),path='/api/backpack')[0],403)
        status,result=self.request(dict(command,playerId=self.pid),host=True,path='/api/backpack');self.assertEqual(status,200,result)
        self.assertEqual(result['backpack']['removedItems'],[])
