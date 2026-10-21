import copy
import json
import unittest
from unittest import mock
import test_backpack as backpack_tests
import test_player_profiles as profile_tests
from server.item_library import ItemLibrary
from server.inventory import item_definition, CATALOG
from server.resources import ResourceStore

SERVER=profile_tests.SERVER

class ItemLibraryTests(unittest.TestCase):
    setUp=backpack_tests.BackpackTests.setUp
    def lib(self): return ItemLibrary(self.store, SERVER.profiles)
    def change(self, op, **kwargs):
        data=self.lib().read();cmd=dict(op=op,revision=data['revision'],requestId='library-change-%08d'%data['revision']);cmd.update(kwargs)
        return self.lib().apply(cmd)
    def custom(self, **kwargs):
        return dict(name='潮汐之钥',category='gear',rarity='',effect='船长室的钥匙',consumable=False,valueCp=250,weightLb=0.125,**kwargs)
    def test_seed_preserves_builtin_rules_and_never_reseeds(self):
        before=self.lib().read();self.assertEqual(len(before['templates']),len(CATALOG))
        healing=before['templates'][0];self.assertEqual(healing['ruleId'],'healing');self.assertNotIn('valueCp',healing)
        self.change('archive',templateId=healing['id'],templateVersion=1)
        self.assertTrue(self.lib().read()['templates'][0]['archived']);self.assertEqual(len(self.lib().read()['templates']),len(CATALOG))
    def test_existing_library_gets_one_container_without_replacing_edits(self):
        data=self.lib().read();data.pop('containerTemplatesVersion');data['templates']=[t for t in data['templates'] if t['category']!='container'];data['templates'][0]['name']='自定义药水'
        self.lib().path.write_text(json.dumps(data))
        migrated=self.lib().read();self.assertEqual(migrated['revision'],data['revision']+1);self.assertEqual(migrated['templates'][0]['name'],'自定义药水')
        chest=next(t for t in migrated['templates'] if t['category']=='container');self.assertEqual(chest['name'],'宝箱');self.assertFalse(chest['consumable'])
        self.assertEqual(self.lib().read(),migrated)
        self.change('archive',templateId=chest['id'],templateVersion=chest['version'])
        self.assertTrue(next(t for t in self.lib().read()['templates'] if t['id']==chest['id'])['archived'])

    def test_definition_unknown_zero_precision_and_invalid_values(self):
        data=self.custom();self.assertEqual(item_definition(data,ValueError)['valueCp'],250)
        for fields in (dict(valueCp=None,weightLb=None),dict(valueCp=0,weightLb=0)):
            result=item_definition(dict(data,**fields),ValueError)
            if fields['valueCp'] is None:self.assertNotIn('valueCp',result);self.assertNotIn('weightLb',result)
            else:self.assertEqual(result['weightLb'],0);self.assertEqual(result['valueCp'],0)
        for patch in [dict(valueCp=v) for v in (-1,True,1.1,float('nan'),'2')]+[dict(weightLb=v) for v in (-1,True,'2',float('nan'),float('inf'),0.0001)]+[dict(valueCurrency='usd')]:
            with self.assertRaises(ValueError):item_definition(dict(data,**patch),ValueError)
    def test_story_item_definition_rejects_blank_and_malformed_pages(self):
        base=dict(name='航海日志',category='document',documentType='book',rarity='',effect='可供阅读。',consumable=False,body='第一页\f第二页')
        self.assertEqual(item_definition(base,ValueError)['body'],base['body'])
        for change in (dict(body=''),dict(body='第一页\f'),dict(body='\f第二页'),dict(body='页\f'*24+'末页'),dict(documentType='scroll')):
            with self.assertRaises(ValueError):item_definition(dict(base,**change),ValueError)
        with self.assertRaises(ValueError):item_definition(dict(base,documentType='letter'),ValueError)
    def test_new_story_defaults_to_campaign_and_registers_portable_art(self):
        from project_test_paths import APP_ROOT
        from server.module_store import ModuleStore
        target=self.store.project/'asset/界面/物品/文书/book-v2.png'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes((APP_ROOT/'asset/界面/物品/文书/book-v2.png').read_bytes())
        result=self.change('create',item=dict(name='旧书',category='document',documentType='book',campaignId='c1',campaignName='海岛',effect='阅读',consumable=False,body='故事'))
        item=next(t for t in result['library']['templates'] if t['id']==result['templateId'])
        self.assertEqual(item['scope'],'campaign')
        digest=item['image'].split('/')[-1]
        self.assertEqual(ModuleStore(self.store.save_root).asset(digest)[0].read_bytes(),target.read_bytes())
    def test_edit_archive_keeps_copies_and_stale_grants_rejected(self):
        res=self.change('create',item=self.custom());tid=res['templateId'];r=ResourceStore(self.store,SERVER.profiles)
        cmd=dict(op='grant',templateId=tid,templateVersion=1,quantity=2,revision=0,requestId='template-grant-0001')
        bag,_=r.apply(self.pid,'c1',cmd,True);old=copy.deepcopy(bag['items'][0])
        self.assertEqual(old['valueCp'],250);self.assertEqual(old['sourceTemplateVersion'],1)
        item=dict(self.custom(),valueCp=900)
        self.change('edit',templateId=tid,templateVersion=1,item=item)
        with self.assertRaises(SERVER.profiles.ProfileError):r.apply(self.pid,'c1',dict(cmd,revision=bag['revision'],requestId='template-grant-0002'),True)
        self.assertEqual(r.read(self.pid)['items'][0],old)
        self.change('archive',templateId=tid,templateVersion=2)
        replay,_=r.apply(self.pid,'c1',cmd,True);self.assertEqual(replay,bag)
        with self.assertRaises(SERVER.profiles.ProfileError):r.apply(self.pid,'c1',dict(cmd,templateVersion=3,revision=bag['revision'],requestId='template-grant-0003'),True)
        self.change('restore',templateId=tid,templateVersion=3)
        result,_=r.apply(self.pid,'c1',dict(cmd,templateVersion=4,revision=bag['revision'],requestId='template-grant-0004'),True)
        self.assertEqual(len(result['items']),2);self.assertEqual(result['items'][0],old)
    def test_from_bag_sanitizes_and_rejects_stale_snapshot(self):
        r=ResourceStore(self.store,SERVER.profiles)
        bag,_=r.apply(self.pid,'c1',dict(op='grant',item=self.custom(),quantity=2,revision=0,requestId='custom-bag-000001'),True)
        item=bag['items'][0]
        res=self.change('fromBag',playerId=self.pid,itemId=item['id'],bagRevision=bag['revision'],item=dict(scope='campaign',campaignId='c1',campaignName='海岛',location='船骸',name='forged',valueCp=99999))
        template=next(t for t in res['library']['templates'] if t['id']==res['templateId'])
        self.assertEqual(template['valueCp'],250);self.assertEqual(template['name'],'潮汐之钥');self.assertNotIn('quantity',template);self.assertNotIn('ownerPlayerId',template)
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('fromBag',playerId=self.pid,itemId=item['id'],bagRevision=0,item={})
        self.assertEqual(r.read(self.pid)['items'],bag['items'])
    def test_library_lost_response_and_conflict(self):
        data=self.lib().read();cmd=dict(op='create',revision=data['revision'],requestId='create-once-000001',item=self.custom())
        atomic=SERVER.profiles.atomic
        def uncertain(path,value):
            atomic(path,value)
            if path==self.lib().path:raise OSError('lost reply')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=uncertain):
            with self.assertRaises(OSError):self.lib().apply(cmd)
        result=self.lib().apply(cmd);self.assertEqual(len(result['library']['templates']),len(CATALOG)+1)
        with self.assertRaises(SERVER.profiles.ProfileError):self.lib().apply(dict(cmd,requestId='stale-create-00001'))
        with self.assertRaises(SERVER.profiles.ProfileError):self.lib().apply(dict(cmd,item=dict(self.custom(),name='different')))
        self.assertEqual(len(self.lib().read()['templates']),len(CATALOG)+1)
    def test_failed_write_and_corruption_are_not_destructive(self):
        before=self.lib().read();atomic=SERVER.profiles.atomic
        def fail(path,value):
            if path==self.lib().path:raise OSError('disk full')
            atomic(path,value)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail):
            with self.assertRaises(OSError):self.change('create',item=self.custom())
        self.assertEqual(self.lib().read(),before)
        self.lib().path.write_text('{broken')
        with self.assertRaises(SERVER.profiles.ProfileError) as e:self.lib().read()
        self.assertEqual(e.exception.status,503);self.assertEqual(self.lib().path.read_text(),'{broken')
    def test_duplicate_and_campaign_reference_do_not_share_identity(self):
        res=self.change('create',item=dict(self.custom(),usedIn=[dict(id='c1',name='海岛')]))
        res2=self.change('duplicate',templateId=res['templateId'],templateVersion=1)
        self.assertNotEqual(res['templateId'],res2['templateId']);t=res2['library']['templates'][-1];self.assertEqual(t['usedIn'],[dict(id='c1',name='海岛')]);self.assertEqual(t['version'],1)
    def test_price_weight_edit_and_removal_keep_instance_metadata(self):
        r=ResourceStore(self.store,SERVER.profiles)
        bag,_=r.apply(self.pid,None,dict(op='grant',item=self.custom(),quantity=2,revision=0,requestId='item-measures-001'),True);iid=bag['items'][0]['id']
        bag,_=r.apply(self.pid,None,dict(op='edit',itemId=iid,item=dict(self.custom(),valueCp=None,weightLb=0),revision=bag['revision'],requestId='item-measures-002'),True)
        self.assertNotIn('valueCp',bag['items'][0]);self.assertEqual(bag['items'][0]['weightLb'],0)
        bag,event=r.apply(self.pid,None,dict(op='discard',itemId=iid,quantity=2,revision=bag['revision'],requestId='item-measures-003'))
        bag,_=r.apply(self.pid,None,dict(op='restore',removalId=event['id'],revision=bag['revision'],requestId='item-measures-004'),True)
        self.assertEqual(bag['items'][0]['weightLb'],0);self.assertNotIn('valueCp',bag['items'][0])

class ItemLibraryHttpTests(unittest.TestCase):
    setUp=profile_tests.PlayerProfileHttpTests.setUp
    request=profile_tests.PlayerProfileHttpTests.request
    login=profile_tests.PlayerProfileHttpTests.login
    close_server=profile_tests.PlayerProfileHttpTests.close_server
    def test_host_only_library_and_private_files(self):
        status,data=self.request(dict(op='get'),path='/api/item-library');self.assertEqual(status,403)
        status,data=self.request(dict(op='get'),path='/api/item-library',host=True);self.assertEqual(status,200);self.assertEqual(len(data['library']['templates']),len(CATALOG))
        status,_=self.request(dict(op='create',item={}),path='/api/item-library',host=True,extra={'Origin':'https://outside.example'});self.assertEqual(status,403)
        status,_=self.request(path='/server/item_library.py',method='GET');self.assertIn(status,(403,404))
