import copy
import json
import threading
import unittest
from unittest import mock
from test_backpack import BackpackTests, SERVER
from server.map_items import MapItems
from server.resources import ResourceStore
from server.item_library import ItemLibrary


class MapItemTests(unittest.TestCase):
    setUp = BackpackTests.setUp

    def loot(self): return MapItems(self.store, SERVER.profiles)
    def state(self): return dict(campaignId='c1', activeMapId='m1', maps=[dict(id='m1', mapW=1000, mapH=800, playerAccessible=True), dict(id='secret', playerAccessible=False)])
    def get(self, host=True, **extra): return self.loot().apply(dict(op='get', campaignId='c1', mapId='m1', **extra), self.state(), host)
    def command(self, op, **extra): return dict(op=op, campaignId='c1', mapId='m1', revision=self.get()['revision'], requestId='map-command-%08d'%self.get()['revision'], **extra)
    def change(self, op, **extra): return self.loot().apply(self.command(op, **extra), self.state(), True)
    def place(self, quantity=3): return self.change('place', templateId='healing', templateVersion=1, quantity=quantity, x=40,y=50)['markers'][0]
    def grant(self, marker, quantity=1): return self.command('grant', markerId=marker['id'], itemId=marker['items'][0]['id'], playerId=self.pid, quantity=quantity)

    def test_hidden_projection_auth_and_map_boundary(self):
        m=self.place();self.assertEqual(self.get(False)['markers'],[])
        self.change('update',markerId=m['id'],visible=True)
        public=self.get(False);self.assertEqual(public['markers'][0]['name'],'治疗药水');self.assertNotIn('sourceTemplateId',public['markers'][0]['items'][0]);self.assertNotIn('receipts',public)
        for cmd in [self.command('remove',markerId=m['id']),dict(op='get',campaignId='c1',mapId='secret')]:
            with self.assertRaises(SERVER.profiles.ProfileError):self.loot().apply(cmd,self.state(),False)
        with self.assertRaises(SERVER.profiles.ProfileError):self.loot().apply(dict(op='get',campaignId='other',mapId='m1'),self.state(),True)

    def test_letter_and_book_keep_their_pages_from_library_to_map_and_backpack(self):
        library=ItemLibrary(self.store,SERVER.profiles)
        for index, (kind, body) in enumerate((('letter','亲爱的旅人：\n请在月升前抵达。'),('book','第一章\n旧港\f第二章\n灯塔'))):
            data=library.read()
            created=library.apply(dict(op='create',revision=data['revision'],requestId=f'story-template-{index:08d}',item=dict(name='密信' if kind=='letter' else '旧书',category='document',documentType=kind,campaignId='c1',campaignName='测试战役',rarity='',effect='可以阅读其中的线索。',consumable=False,body=body)))
            placed=self.change('place',templateId=created['templateId'],templateVersion=1,quantity=1,x=80+index*30,y=70)['markers'][-1]
            self.assertEqual(placed['items'][0]['body'],body)
            self.change('update',markerId=placed['id'],visible=True)
            public=next(marker for marker in self.get(False)['markers'] if marker['id']==placed['id'])
            self.assertEqual(public['items'][0]['documentType'],kind)
            self.assertEqual(public['items'][0]['body'],body)
            self.loot().apply(self.grant(placed),self.state(),True)
            received=next(item for item in ResourceStore(self.store,SERVER.profiles).read(self.pid)['items'] if item['name']==placed['name'])
            self.assertEqual((received['documentType'],received['body']),(kind,body))

    def test_atomic_grant_and_retry_survive_restart(self):
        marker=self.place(2);cmd=self.grant(marker)
        self.loot().apply(cmd,self.state(),True);self.loot().apply(cmd,self.state(),True)
        self.assertEqual(self.get()['markers'][0]['items'][0]['quantity'],1)
        bag=ResourceStore(self.store,SERVER.profiles).read(self.pid);self.assertEqual(bag['items'][0]['quantity'],1)
        self.assertEqual(bag['items'][0]['sourceTemplateId'],'healing')
        self.loot().apply(self.grant(self.get()['markers'][0]),self.state(),True)
        self.assertEqual(self.get()['markers'],[])
        self.assertEqual(ResourceStore(self.store,SERVER.profiles).read(self.pid)['items'][0]['quantity'],2)

    def test_failure_and_lost_response_cannot_split_transfer(self):
        marker=self.place();cmd=self.grant(marker);original=SERVER.profiles.atomic
        def fail(path,data):
            if path==self.loot().resources.ledger_path:raise OSError('disk full')
            original(path,data)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail):
            with self.assertRaises(OSError):self.loot().apply(cmd,self.state(),True)
        self.assertEqual(self.get()['markers'][0]['items'][0]['quantity'],3)
        self.assertEqual(ResourceStore(self.store,SERVER.profiles).read(self.pid)['items'],[])
        def lost(path,data):
            original(path,data)
            if path==self.loot().resources.ledger_path:raise OSError('lost response')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=lost):
            with self.assertRaises(OSError):self.loot().apply(cmd,self.state(),True)
        self.loot().apply(cmd,self.state(),True)
        self.assertEqual(self.get()['markers'][0]['items'][0]['quantity'],2)
        self.assertEqual(ResourceStore(self.store,SERVER.profiles).read(self.pid)['items'][0]['quantity'],1)

    def test_two_hosts_cannot_take_last_item(self):
        marker=self.place(1);cmd=self.grant(marker);results=[]
        def run(n):
            try:self.loot().apply(dict(cmd,requestId='concurrent-map-%04d'%n),self.state(),True);results.append('ok')
            except SERVER.profiles.ProfileError:results.append('rejected')
        threads=[threading.Thread(target=run,args=(n,)) for n in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(sorted(results),['ok','rejected'])

    def test_container_empty_persists_and_template_edits_do_not_change_instances(self):
        m=self.change('container',x=20,y=40)['markers'][0]
        m=self.change('add',markerId=m['id'],templateId='healing',templateVersion=1,quantity=1)['markers'][0]
        lib=ItemLibrary(self.store,SERVER.profiles);data=lib.read()
        lib.apply(dict(op='archive',revision=data['revision'],requestId='archive-map-item-01',templateId='healing',templateVersion=1))
        self.loot().apply(self.grant(m),self.state(),True)
        m=self.get()['markers'][0];self.assertEqual(m['items'],[]);self.assertEqual(m['size'],.75)
        self.change('update',markerId=m['id'],x=300,y=250,size=2,name='船长的箱子')
        self.assertEqual(self.get()['markers'][0]['x'],300)

    def test_invalid_values_no_mutation(self):
        before=self.get()
        for fields in [dict(x=float('nan')),dict(size=0),dict(visible='yes'),dict(quantity=True)]:
            cmd=self.command('place',templateId='healing',templateVersion=1,quantity=2);cmd.update(fields)
            with self.assertRaises(SERVER.profiles.ProfileError):self.loot().apply(cmd,self.state(),True)
        self.assertEqual(before,self.get())

    def test_offline_host_preparation_and_forged_player_metadata(self):
        command=self.command('place',templateId='healing',templateVersion=1,quantity=1,hostMap=dict(id='m1',mapW=1000,mapH=800))
        result=self.loot().apply(command,None,True)
        self.assertEqual(result['markers'][0]['size'],.5)
        with self.assertRaises(SERVER.profiles.ProfileError):self.loot().apply(dict(command,op='get'),None,False)
        path=self.loot().resources.ledger_path
        data=json.loads(path.read_text());data['mapItems']['c1']['m1']['markers'][0]['items'][0]['quantity']=-1
        path.write_text(json.dumps(data))
        with self.assertRaises(SERVER.profiles.ProfileError):self.get()
        self.assertEqual(json.loads(path.read_text()),data)

    def test_all_library_categories_place_and_enter_container(self):
        library=ItemLibrary(self.store,SERVER.profiles)
        for category in ('gear','document'):
            data=library.read()
            library.apply(dict(op='create',revision=data['revision'],requestId='category-'+category+'-0000001',item=dict(name=category,category=category,scope='general',effect='测试物品',consumable=False,body='正文' if category=='document' else '')))
        box=self.change('container',x=30,y=30)['markers'][0]
        for template in library.read()['templates']:
            placed=self.change('place',templateId=template['id'],templateVersion=template['version'],quantity=1 if template['category']=='container' else 2,x=50,y=50)['markers'][-1]
            if template['category']=='container':
                self.assertEqual(placed['kind'],'container');self.assertEqual(placed['items'],[]);self.assertEqual(placed['containerItem']['name'],'宝箱');continue
            self.assertEqual(placed['items'][0]['name'],template['name'])
            self.change('add',markerId=box['id'],templateId=template['id'],templateVersion=template['version'],quantity=1)
        self.assertEqual(len(self.get()['markers'][0]['items']),13)

    def test_library_chest_contents_unpack_is_atomic_and_idempotent(self):
        chest=self.change('place',templateId='treasure-chest',templateVersion=1,quantity=1,x=100,y=100)['markers'][0]
        self.assertEqual(chest['kind'],'container');self.assertEqual(chest['size'],.75);self.assertEqual(chest['items'],[])
        chest=self.change('add',markerId=chest['id'],templateId='healing',templateVersion=1,quantity=3)['markers'][0]
        cmd=self.command('unpack',markerId=chest['id'],itemId=chest['items'][0]['id'])
        self.loot().apply(cmd,self.state(),True);self.loot().apply(cmd,self.state(),True)
        markers=self.get()['markers'];self.assertEqual(len(markers),2);self.assertEqual(markers[0]['items'],[]);self.assertEqual(markers[1]['items'][0]['quantity'],3);self.assertFalse(markers[1]['visible'])
        self.assertEqual(self.get(False)['markers'],[])
        before=self.get()
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('place',templateId='treasure-chest',templateVersion=1,quantity=2,x=100,y=100)
        self.assertEqual(self.get(),before)

    def test_http_authentication(self):
        self.place()
        def request(host=False,session=None,op='get'):
            handler=mock.Mock();handler._read_json_body.return_value=dict(op=op,campaignId='c1',mapId='m1');handler.headers={'X-Sundoll-Local-Save':'1'} if host else {}
            with mock.patch.object(SERVER,'profile_store',return_value=self.store),mock.patch.object(SERVER,'host_request_allowed',return_value=host),mock.patch.object(SERVER,'touch_session',return_value=session),mock.patch.object(SERVER,'STATE',self.state()):SERVER.Handler.handle_map_items(handler)
            args=handler._send_document_json.call_args.args;return args[0],args[1] if len(args)>1 else 200
        self.assertEqual(request()[1],401);self.assertEqual(request(session={'id':'guest'})[0]['markers'],[])
        self.assertEqual(request(session={'id':'guest'},op='remove')[1],403);self.assertEqual(len(request(host=True)[0]['markers']),1)

if __name__=='__main__':unittest.main()

class PlayerLootTests(unittest.TestCase):
    setUp = BackpackTests.setUp
    loot, state, get, command, change, place = (getattr(MapItemTests, n) for n in ("loot", "state", "get", "command", "change", "place"))
    def player_command(self,op,marker,**fields):
        return dict(op=op,campaignId='c1',mapId='m1',markerId=marker['id'],markerRevision=marker['revision'],requestId='player-loot-request-0001',**fields)
    def as_player(self,cmd,persistent=True):
        return self.loot().apply(cmd,self.state(),False,player=dict(playerId=self.pid,persistent=persistent))
    def test_fixed_position_blocks_moves_but_allows_pickup_and_host_unlock(self):
        m=self.place(2)
        m=self.change('update',markerId=m['id'],visible=True,positionLocked=True)['markers'][0]
        self.assertTrue(self.get(False)['markers'][0]['positionLocked'])
        for host in (True,False):
            cmd=self.player_command('move',m,x=80,y=90)
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.loot().apply(cmd,self.state(),host,player=dict(playerId=self.pid,persistent=True))
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.change('update',markerId=m['id'],x=80,positionLocked=False)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.as_player(self.player_command('move',m,x=80,y=90,positionLocked=False))
        self.assertEqual(self.get()['markers'][0]['x'],m['x'])
        self.assertTrue(self.get()['markers'][0]['positionLocked'])
        self.as_player(self.player_command('take',m,itemId=m['items'][0]['id'],quantity=1))
        m=self.change('update',markerId=m['id'],positionLocked=False)['markers'][0]
        cmd=self.player_command('move',m,x=80,y=90)
        cmd['requestId']='player-unlocked-move-0001'
        self.assertEqual(self.as_player(cmd)['markers'][0]['x'],80)

    def test_move_and_take_are_scoped_and_retry_safe(self):
        m=self.place(2)
        with self.assertRaises(SERVER.profiles.ProfileError):self.as_player(self.player_command('move',m,x=80,y=90))
        m=self.change('update',markerId=m['id'],visible=True)['markers'][0]
        cmd=self.player_command('move',m,x=80,y=90)
        moved=self.as_player(cmd,False)['markers'][0];self.assertEqual(moved['x'],80)
        self.assertEqual(self.as_player(cmd)['markers'][0]['x'],80)
        take=self.player_command('take',moved,itemId=moved['items'][0]['id'],quantity=1);take['requestId']='player-loot-request-0002'
        with self.assertRaises(SERVER.profiles.ProfileError):self.as_player(take,False)
        with self.assertRaises(SERVER.profiles.ProfileError):self.as_player(dict(take,playerId=self.pid))
        self.as_player(take);self.as_player(dict(take,sessionToken='new-session'))
        self.assertEqual(self.get()['markers'][0]['items'][0]['quantity'],1)
        self.assertEqual(ResourceStore(self.store,SERVER.profiles).read(self.pid)['items'][0]['quantity'],1)
        with self.assertRaises(SERVER.profiles.ProfileError):self.as_player(dict(take,requestId='player-loot-request-0003'))
    def test_host_can_delete_stack_but_player_cannot(self):
        m=self.change('container',x=20,y=40)['markers'][0]
        m=self.change('add',markerId=m['id'],templateId='healing',templateVersion=1,quantity=3)['markers'][0]
        m=self.change('update',markerId=m['id'],visible=True)['markers'][0]
        with self.assertRaises(SERVER.profiles.ProfileError):self.as_player(self.player_command('deleteContent',m,itemId=m['items'][0]['id']))
        self.change('deleteContent',markerId=m['id'],itemId=m['items'][0]['id'])
        self.assertEqual(self.get()['markers'][0]['items'],[])

class MoveRevisionTests(unittest.TestCase):
    setUp = BackpackTests.setUp
    loot, state, get, command, change, place = (getattr(MapItemTests, n) for n in ('loot','state','get','command','change','place'))
    def test_unrelated_changes_do_not_reject_host_move_but_same_marker_does(self):
        m=self.place();cmd=self.command('move',markerId=m['id'],markerRevision=m['revision'],x=81.125,y=93.75)
        cmd['requestId']='independent-move-0001'
        self.change('container',x=200,y=200)
        result=self.loot().apply(cmd,self.state(),True)
        self.assertEqual(result['markers'][0]['x'],81.125)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.loot().apply(dict(cmd,requestId='conflicting-move-0001',x=90),self.state(),True)

class ChestLockTests(unittest.TestCase):
    setUp = BackpackTests.setUp
    loot, state, get, command, change, place = (getattr(MapItemTests, n) for n in ('loot','state','get','command','change','place'))
    def prepare(self):
        m=self.change('container',x=50,y=50)['markers'][0]
        m=self.change('add',markerId=m['id'],templateId='healing',templateVersion=1,quantity=2)['markers'][0]
        return self.change('update',markerId=m['id'],visible=True,locked=True,lockDC=15)['markers'][0]
    def player(self,cmd):return self.loot().apply(cmd,self.state(),False,dict(playerId=self.pid,persistent=True))
    def pick(self,m,rid='lock-check-test-0001',modifier=4):return dict(op='pickLock',campaignId='c1',mapId='m1',markerId=m['id'],markerRevision=m['revision'],requestId=rid,modifier=modifier)
    def test_locked_contents_are_redacted_and_cannot_be_taken(self):
        m=self.prepare();public=self.player(dict(op='get',campaignId='c1',mapId='m1'))['markers'][0]
        self.assertEqual(public['items'],[]);self.assertNotIn('lockDC',public);self.assertNotIn('lockAttempts',public)
        cmd=self.pick(m);cmd.pop('modifier');cmd.update(op='take',itemId=m['items'][0]['id'],quantity=1)
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(cmd)
        self.assertEqual(self.get()['markers'][0]['items'][0]['quantity'],2)
    def test_arcane_lock_has_its_own_state_and_cannot_be_picked(self):
        m=self.prepare()
        m=self.change('update',markerId=m['id'],locked=True,lockType='arcane')['markers'][0]
        self.assertEqual(m['lockType'],'arcane')
        public=self.player(dict(op='get',campaignId='c1',mapId='m1'))['markers'][0]
        self.assertEqual(public['lockType'],'arcane')
        self.assertEqual(public['items'],[])
        with mock.patch('server.map_items.secrets.randbelow') as rng:
            with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.pick(m))
            rng.assert_not_called()
        with self.assertRaises(SERVER.profiles.ProfileError):self.change('update',markerId=m['id'],lockType='unknown')
        m=self.change('update',markerId=m['id'],locked=False,lockType='normal')['markers'][0]
        self.assertEqual(len(self.player(dict(op='get',campaignId='c1',mapId='m1'))['markers'][0]['items']),1)
    def test_success_uses_server_roll_and_retry_never_rerolls(self):
        m=self.prepare();cmd=self.pick(m)
        with mock.patch('server.map_items.secrets.randbelow',return_value=10) as rng:
            a=self.player(cmd);b=self.player(cmd);self.assertEqual(rng.call_count,1)
        self.assertEqual(a['check'],b['check']);self.assertEqual(a['check']['total'],15);self.assertTrue(a['check']['success'])
        self.assertFalse(a['markers'][0]['locked']);self.assertEqual(len(a['markers'][0]['items']),1)
    def test_failure_limits_attempts_and_host_reset_allows_retry(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',return_value=0):a=self.player(self.pick(m))
        self.assertFalse(a['check']['success']);self.assertTrue(a['markers'][0]['locked']);self.assertEqual(a['markers'][0]['items'],[])
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.pick(a['markers'][0],'lock-check-test-0002'))
        m=self.change('update',markerId=m['id'],resetLockAttempts=True)['markers'][0]
        with mock.patch('server.map_items.secrets.randbelow',return_value=19):self.assertTrue(self.player(self.pick(m,'lock-check-test-0003'))['check']['success'])
    def test_invalid_and_unauthorized_checks_do_not_roll(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow') as rng:
            for cmd in [dict(self.pick(m),modifier=99),dict(self.pick(m),natural=20),dict(self.pick(m),lockDC=1)]:
                with self.assertRaises(SERVER.profiles.ProfileError):self.player(cmd)
            self.change('update',markerId=m['id'],visible=False)
            with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.pick(m))
            rng.assert_not_called()
    def test_lost_reply_preserves_natural_twenty_critical_success(self):
        m=self.prepare();m=self.change('update',markerId=m['id'],lockDC=30)['markers'][0];cmd=self.pick(m)
        original=SERVER.profiles.atomic
        def lost(path,data):
            original(path,data)
            if path==self.loot().resources.ledger_path:raise OSError('lost reply')
        with mock.patch('server.map_items.secrets.randbelow',return_value=19) as rng:
            with mock.patch.object(SERVER.profiles,'atomic',side_effect=lost):
                with self.assertRaises(OSError):self.player(cmd)
            result=self.player(cmd);self.assertEqual(rng.call_count,1)
        self.assertTrue(result['check']['success']);self.assertEqual(result['check']['total'],24)
        self.assertEqual(result['check']['critical'],'success');self.assertFalse(result['markers'][0]['locked'])

    def test_natural_one_fails_even_when_modifier_exceeds_dc(self):
        m=self.prepare();m=self.change('update',markerId=m['id'],lockDC=1)['markers'][0]
        with mock.patch('server.map_items.secrets.randbelow',return_value=0):result=self.player(self.pick(m,modifier=30))
        self.assertEqual(result['check']['total'],31);self.assertEqual(result['check']['critical'],'fail')
        self.assertFalse(result['check']['success']);self.assertTrue(result['markers'][0]['locked'])

    def follow(self,op,m,rid='lock-follow-test-001'):
        return dict(op=op,campaignId='c1',mapId='m1',markerId=m['id'],markerRevision=m['revision'],requestId=rid,checkId=m['lockAttempt']['id'])
    def test_advantage_guidance_and_public_breakdown(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',side_effect=[2,17,2]) as rng:
            r=self.player(dict(self.pick(m),mode=1,guidance=True,inspirationDie=8))
        c=r['check'];self.assertEqual(c['dice'],[3,18]);self.assertEqual(c['natural'],18);self.assertEqual(c['guidanceRoll'],3);self.assertEqual(c['total'],25)
        self.assertFalse(c['inspirationUsed']);self.assertTrue(c['success']);self.assertNotIn('_dc',json.dumps(r));self.assertEqual(rng.call_count,3)
    def test_disadvantage_critical_uses_chosen_die(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',side_effect=[19,0]) as rng:
            r=self.player(dict(self.pick(m),mode=-1,guidance=True,inspirationDie=12))
        self.assertEqual(r['check']['critical'],'fail');self.assertEqual(r['check']['natural'],1);self.assertEqual(rng.call_count,2)
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.follow('inspireLock',r['markers'][0]))
    def test_inspiration_appends_once_without_rerolling_and_survives_retry(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',return_value=7):r=self.player(dict(self.pick(m),inspirationDie=8))
        self.assertFalse(r['check']['success']);cmd=self.follow('inspireLock',r['markers'][0])
        with mock.patch('server.map_items.secrets.randbelow',return_value=3) as rng:
            a=self.player(cmd);b=self.player(cmd)
        self.assertEqual(rng.call_count,1);self.assertEqual(a['check'],b['check']);self.assertEqual(a['check']['natural'],8)
        self.assertEqual(a['check']['inspirationRoll'],4);self.assertEqual(a['check']['total'],16);self.assertTrue(a['check']['success']);self.assertFalse(a['markers'][0]['locked'])
    def test_inspiration_failure_and_decline_cannot_be_reused(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',return_value=1):r=self.player(dict(self.pick(m),inspirationDie=6))
        with mock.patch('server.map_items.secrets.randbelow',return_value=0):r=self.player(self.follow('inspireLock',r['markers'][0]))
        self.assertFalse(r['check']['success']);self.assertTrue(r['check']['inspirationUsed'])
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.follow('inspireLock',r['markers'][0],'lock-follow-test-002'))
        m=self.change('update',markerId=m['id'],resetLockAttempts=True)['markers'][0]
        with mock.patch('server.map_items.secrets.randbelow',return_value=1):r=self.player(dict(self.pick(m,'lock-check-new-0001'),inspirationDie=6))
        r=self.player(self.follow('finishLock',r['markers'][0],'lock-finish-test-001'))
        self.assertFalse(r['markers'][0]['lockAttempt']['inspirationUsed'])
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(self.follow('inspireLock',r['markers'][0],'lock-follow-test-003'))
    def test_reset_and_forged_bonus_cannot_modify_old_attempt(self):
        m=self.prepare()
        for extra in [dict(mode=True),dict(mode=2),dict(guidance=1),dict(inspirationDie=20),dict(inspirationDie=True)]:
            with mock.patch('server.map_items.secrets.randbelow') as rng:
                with self.assertRaises(SERVER.profiles.ProfileError):self.player(dict(self.pick(m),**extra))
                rng.assert_not_called()
        with mock.patch('server.map_items.secrets.randbelow',return_value=1):r=self.player(dict(self.pick(m),inspirationDie=6))
        cmd=self.follow('inspireLock',r['markers'][0])
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(dict(cmd,inspirationDie=12))
        m=self.change('update',markerId=m['id'],resetLockAttempts=True)['markers'][0]
        with self.assertRaises(SERVER.profiles.ProfileError):self.player(dict(cmd,markerRevision=m['revision']))

    def test_inspiration_lost_reply_does_not_consume_or_roll_twice(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',return_value=7):r=self.player(dict(self.pick(m),inspirationDie=8))
        cmd=self.follow('inspireLock',r['markers'][0]);original=SERVER.profiles.atomic
        def lost(path,data):
            original(path,data)
            if path==self.loot().resources.ledger_path:raise OSError('lost response')
        with mock.patch('server.map_items.secrets.randbelow',return_value=3) as rng:
            with mock.patch.object(SERVER.profiles,'atomic',side_effect=lost):
                with self.assertRaises(OSError):self.player(cmd)
            r=self.player(cmd);self.assertEqual(rng.call_count,1)
        self.assertEqual(r['check']['inspirationRoll'],4);self.assertEqual(r['check']['natural'],8);self.assertTrue(r['check']['success'])

    def test_inspiration_can_be_selected_after_failure_without_preselection(self):
        m=self.prepare()
        with mock.patch('server.map_items.secrets.randbelow',return_value=7):r=self.player(self.pick(m))
        self.assertEqual(r['check']['inspirationDie'],0)
        cmd=dict(self.follow('inspireLock',r['markers'][0]),inspirationDie=8)
        with mock.patch('server.map_items.secrets.randbelow',return_value=3) as rng:
            a=self.player(cmd);b=self.player(cmd)
        self.assertEqual(rng.call_count,1);self.assertEqual(a['check'],b['check']);self.assertTrue(a['check']['success']);self.assertEqual(a['check']['natural'],8)
