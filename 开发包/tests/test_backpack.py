from project_test_paths import APP_ROOT
import hashlib
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from test_player_profiles import SERVER
from server.inventory import InventoryStore, CATALOG


class BackpackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.store = SERVER.profiles.Store(Path(self.temp.name)/'saves', self.temp.name, Path(self.temp.name)/'cache')
        created=self.store.create('玩家甲');self.pid=created['profile']['playerId'];self.credential=created['credential']
        self.inventory=InventoryStore(self.store,SERVER.profiles)
        self.base=dict(op='grant',presetId='healing',quantity=3,revision=0,requestId='grant-backpack-0001')
    def grant(self):return self.inventory.apply(self.pid,'c1',self.base,host=True)[0]
    def use(self,bag,request='consume-backpack-0001'):
        return dict(op='use',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId=request)
    def test_empty_read_is_lazy_and_scoped(self):
        self.assertEqual(self.inventory.read(self.pid,'c1')['revision'],0)
        self.assertFalse(self.inventory.path(self.pid,'c1').exists())
        self.grant();other=self.store.create('玩家乙')['profile']['playerId']
        self.assertEqual(self.inventory.read(self.pid,'c2')['items'],self.inventory.read(self.pid)['items'])
        self.assertEqual(self.inventory.read(other,'c1')['items'],[])
    def test_grant_merge_use_retry_and_restart(self):
        bag=self.grant();first=copy.deepcopy(bag)
        same,_=self.inventory.apply(self.pid,'c1',self.base,True);self.assertEqual(same,bag)
        command=self.use(bag);bag,event=self.inventory.apply(self.pid,'c1',command)
        self.assertEqual(bag['items'][0]['quantity'],2)
        again,replayed=self.inventory.apply(self.pid,'c1',command)
        self.assertEqual(again,bag);self.assertEqual(event,replayed)
        restored=InventoryStore(self.store,SERVER.profiles).public(self.inventory.read(self.pid,'c1'))
        self.assertEqual(restored,bag)
        merged,_=self.inventory.apply(self.pid,'c1',dict(self.base,revision=bag['revision'],requestId='merge-backpack-001'),True)
        self.assertEqual(len(merged['items']),1);self.assertEqual(merged['items'][0]['quantity'],5)
        backups=list(self.inventory.path(self.pid,'c1').parent.glob('自动备份/*.json'))
        self.assertTrue(backups);self.assertTrue(any(json.loads(p.read_text())['revision']==first['revision'] for p in backups))
    def test_bad_input_and_forged_commands_leave_quantities_unchanged(self):
        bag=self.grant()
        for patch in [dict(op='adjust',quantity=999),dict(op='grant',quantity=99),dict(op='delete')]:
            with self.assertRaises(SERVER.profiles.ProfileError):self.inventory.apply(self.pid,'c1',dict(self.use(bag),**patch))
        for quantity in [True,1.5,-1,1000,'2']:
            with self.assertRaises(SERVER.profiles.ProfileError):self.inventory.apply(self.pid,'c1',dict(self.base,quantity=quantity,revision=1,requestId='invalid-grant-001'),True)
        self.assertEqual(self.inventory.public(self.inventory.read(self.pid,'c1')),bag)
    def test_stale_revision_and_request_reuse_fail(self):
        bag=self.grant();command=self.use(bag);self.inventory.apply(self.pid,'c1',command)
        for changed in [dict(command,requestId='other-consume-001'),dict(command,itemId='i'+'f'*32)]:
            with self.assertRaises(SERVER.profiles.ProfileError) as caught:self.inventory.apply(self.pid,'c1',changed)
            self.assertEqual(caught.exception.status,409)
    def test_concurrent_double_use_cannot_overspend(self):
        bag,_=self.inventory.apply(self.pid,'c1',dict(self.base,quantity=1),True)
        outcomes=[]
        def consume(i):
            try:self.inventory.apply(self.pid,'c%s'%i,self.use(bag,'concurrent-use-%02d'%i));outcomes.append('ok')
            except SERVER.profiles.ProfileError:outcomes.append('rejected')
        threads=[threading.Thread(target=consume,args=(i,)) for i in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(sorted(outcomes),['ok','rejected']);self.assertEqual(self.inventory.read(self.pid,'c1')['items'][0]['quantity'],0)
    def test_reusable_items_do_not_disappear(self):
        bag,_=self.inventory.apply(self.pid,'c1',dict(self.base,presetId='bag-of-holding',quantity=1),True)
        used,event=self.inventory.apply(self.pid,'c1',self.use(bag))
        self.assertEqual(used['items'][0]['quantity'],1);self.assertEqual(event['delta'],0)
    def test_corrupt_backpack_is_not_replaced(self):
        self.grant();p=self.inventory.path(self.pid,'c1');p.write_text('{broken')
        with self.assertRaises(SERVER.profiles.ProfileError) as caught:self.inventory.read(self.pid,'c1')
        self.assertEqual(caught.exception.status,503);self.assertEqual(p.read_text(),'{broken')
    def test_failed_save_and_uncertain_response_retry_only_once(self):
        bag=self.grant();command=self.use(bag);atomic=SERVER.profiles.atomic
        def fail_final(path,value):
            if Path(path)==self.inventory.path(self.pid,'c1'):raise OSError('disk full')
            return atomic(path,value)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail_final):
            with self.assertRaises(OSError):self.inventory.apply(self.pid,'c1',command)
        self.assertEqual(self.inventory.public(self.inventory.read(self.pid,'c1')),bag)
        def uncertain(path,value):
            atomic(path,value)
            if Path(path)==self.inventory.path(self.pid,'c1'):raise OSError('lost response')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=uncertain):
            with self.assertRaises(OSError):self.inventory.apply(self.pid,'c1',command)
        retry,_=self.inventory.apply(self.pid,'c1',command);self.assertEqual(retry['items'][0]['quantity'],2)
    def test_catalog_and_custom_item(self):
        self.assertGreaterEqual(len(CATALOG),10)
        item=dict(name='月光钥匙',category='wondrous',rarity='珍稀',consumable=False,effect='开启被月光照亮的门。')
        bag,_=self.inventory.apply(self.pid,'c1',dict(self.base,presetId=None,item=item,quantity=1),True)
        self.assertEqual(bag['items'][0]['name'],item['name'])
    def request(self,data,host=False,session=None):
        handler=mock.Mock();handler._read_json_body.return_value=data;handler.headers={'X-Sundoll-Local-Save':'1'} if host else {}
        with mock.patch.object(SERVER,'profile_store',return_value=self.store),mock.patch.object(SERVER,'host_request_allowed',return_value=host),mock.patch.object(SERVER,'touch_session',return_value=session),mock.patch.object(SERVER,'STATE',{'campaignId':'c1'}):
            SERVER.Handler.handle_backpack(handler)
        args=handler._send_document_json.call_args.args
        return args[0],args[1] if len(args)>1 else 200
    def test_http_boundaries_and_no_receipts_or_catalog_for_players(self):
        self.grant();session={'persistent':True,'playerId':self.pid}
        body={'op':'get','campaignId':'c1','playerId':self.pid}
        result,status=self.request(body,session=session);self.assertEqual(status,200)
        self.assertNotIn('receipts',result['backpack']);self.assertEqual(result['catalog'],[])
        self.assertEqual(self.request(body)[1],401)
        self.assertEqual(self.request(body,session={'persistent':False})[1],401)
        other=self.store.create('乙')['profile']['playerId']
        self.assertEqual(self.request(dict(body,playerId=other),session=session)[1],403)
        stale,status=self.request(dict(body,campaignId='c2'),session=session)
        self.assertEqual(status,409);self.assertNotIn('backpack',stale)
        self.assertEqual(self.request({'op':'get','playerId':self.pid},session=session)[0]['backpack'],result['backpack'])
        self.assertEqual(self.request(dict(body,**self.base),session=session)[1],403)
        host,status=self.request(body,host=True);self.assertEqual(status,200);self.assertEqual(len(host['catalog']),len(CATALOG))
    def test_revoked_real_session_cannot_read(self):
        created=self.store.login(self.credential)
        session={'persistent':True,'playerId':self.pid,'_authVersion':created['_authVersion'],'lastSeen':int(SERVER.time.time()*1000)}
        self.store.rotate(self.pid)
        with mock.patch.object(SERVER,'profile_store',return_value=self.store),mock.patch.object(SERVER,'SESSIONS',{'session-backpack':session}):
            self.assertIsNone(SERVER.touch_session('session-backpack'))

    def test_edit_and_annotation_permissions_and_persistence(self):
        bag=self.grant();item=bag['items'][0]
        cmd=dict(op='edit',itemId=item['id'],revision=bag['revision'],requestId='edit-details-00001',item=dict(item,name='月光药水',description='来自海边',image='https://example.com/item.png'))
        with self.assertRaises(SERVER.profiles.ProfileError):self.inventory.apply(self.pid,'c1',cmd)
        bag,_=self.inventory.apply(self.pid,'c1',cmd,True)
        self.assertEqual(bag['items'][0]['quantity'],3)
        self.assertEqual(bag['items'][0]['name'],'月光药水')
        note=dict(op='annotate',itemId=item['id'],revision=bag['revision'],requestId='annotate-item-001',notes='留到决战',favorite=True,quantity=999)
        bag,_=self.inventory.apply(self.pid,'c1',note)
        self.assertEqual(bag['items'][0]['quantity'],3)
        self.assertTrue(bag['items'][0]['favorite'])
        self.assertEqual(self.inventory.read(self.pid,'c1')['items'][0]['notes'],'留到决战')
        replay,_=self.inventory.apply(self.pid,'c1',note)
        self.assertEqual(replay,bag)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.inventory.apply(self.pid,'c1',dict(cmd,revision=bag['revision'],requestId='bad-image-edit-001',item=dict(item,image='javascript:alert(1)')),True)
        self.assertEqual(self.inventory.public(self.inventory.read(self.pid,'c1')),bag)

    def legacy(self, campaigns=('c1', 'c2')):
        self.grant()
        canonical = self.inventory.path(self.pid)
        value = json.loads(canonical.read_text())
        canonical.unlink()
        paths = []
        for campaign in campaigns:
            old = copy.deepcopy(value)
            old.pop('scope'); old['campaignId'] = campaign
            old['items'][0].update(notes=campaign, favorite=True)
            path = canonical.parent / (hashlib.sha256(campaign.encode()).hexdigest()+'.json')
            path.write_text(json.dumps(old))
            paths.append(path)
        return paths

    def test_migrate_multiple_campaigns_preserves_sources_and_only_once(self):
        paths = self.legacy(); originals = [p.read_bytes() for p in paths]
        bag = self.inventory.read(self.pid)
        self.assertEqual(bag['scope'], 'player')
        self.assertEqual(sum(i['quantity'] for i in bag['items']), 6)
        self.assertEqual(len({i['id'] for i in bag['items']}), 2)
        self.assertEqual({i['notes'] for i in bag['items']}, {'c1','c2'})
        self.assertTrue(all(i['favorite'] for i in bag['items']))
        self.assertEqual(len(bag['history']), 2)
        self.assertEqual({e['itemId'] for e in bag['history']}, {i['id'] for i in bag['items']})
        for p, raw in zip(paths, originals):
            self.assertEqual(p.read_bytes(), raw)
            self.assertTrue((p.parent/'自动备份'/('迁移前-'+p.name)).exists())
        for campaign in ('c1','c2'):
            replay, event = self.inventory.apply(self.pid, campaign, self.base, True)
            self.assertEqual(replay['revision'], bag['revision'])
            self.assertEqual(event['itemId'], next(i['id'] for i in bag['items'] if i['notes']==campaign))
        used, _ = self.inventory.apply(self.pid, None, self.use(bag))
        restored = InventoryStore(self.store, SERVER.profiles).read(self.pid, 'c3')
        self.assertEqual(sum(i['quantity'] for i in restored['items']), 5)
        self.assertEqual(restored['revision'], used['revision'])
        self.assertNotIn('legacyReceipts', self.inventory.public(restored))

    def test_corrupt_legacy_aborts_entire_migration(self):
        paths = self.legacy(); paths[1].write_text('{broken')
        with self.assertRaises(SERVER.profiles.ProfileError): self.inventory.read(self.pid)
        self.assertFalse(self.inventory.path(self.pid).exists())
        self.assertEqual(paths[1].read_text(), '{broken')
        self.assertFalse(list(paths[0].parent.glob('自动备份/迁移前-*')))

    def test_migration_write_failure_and_uncertain_commit_are_retryable(self):
        self.legacy(); atomic = SERVER.profiles.atomic
        canonical = self.inventory.path(self.pid)
        def fail(path, value):
            if path == canonical: raise OSError('disk full')
            atomic(path, value)
        with mock.patch.object(SERVER.profiles, 'atomic', side_effect=fail):
            with self.assertRaises(OSError): self.inventory.read(self.pid)
        self.assertFalse(canonical.exists())
        def uncertain(path, value):
            atomic(path, value)
            if path == canonical: raise OSError('uncertain commit')
        with mock.patch.object(SERVER.profiles, 'atomic', side_effect=uncertain):
            with self.assertRaises(OSError): self.inventory.read(self.pid)
        self.assertEqual(sum(i['quantity'] for i in self.inventory.read(self.pid)['items']), 6)

    def test_bad_legacy_receipts_fail_closed(self):
        self.legacy(); self.inventory.read(self.pid)
        path = self.inventory.path(self.pid); value = json.loads(path.read_text())
        value['legacyReceipts'] = {'c1': []}; path.write_text(json.dumps(value))
        before = path.read_bytes()
        with self.assertRaises(SERVER.profiles.ProfileError): self.inventory.read(self.pid)
        self.assertEqual(path.read_bytes(), before)
