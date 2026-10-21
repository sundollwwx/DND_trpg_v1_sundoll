from project_test_paths import APP_ROOT
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from test_player_profiles import SERVER
from server.inventory import InventoryStore
from server.resources import ResourceStore, project, projection


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.store = SERVER.profiles.Store(Path(self.tmp.name)/'saves', self.tmp.name, Path(self.tmp.name)/'cache')
        self.pid = self.store.create('甲')['profile']['playerId']
        self.other = self.store.create('乙')['profile']['playerId']
        self.oid = self.store.grant(self.pid,dict(name='战士',hpMax=30,ac=15), 'grant-character-01')['pieces'][0]['ownedPieceId']
        self.target = self.store.grant(self.other,dict(name='法师',hpMax=20,ac=12), 'grant-character-02')['pieces'][0]['ownedPieceId']
        self.state = dict(campaignId='c1',maps=[dict(id='map1',playerAccessible=True,tokens=[
            dict(id='t1',ownedPieceId=self.oid,ownerPlayerId=self.pid,name='战士',hp=10,hpMax=30,ac=15),
            dict(id='t2',ownedPieceId=self.target,ownerPlayerId=self.other,name='法师',hp=18,hpMax=20,ac=12)])])
        self.r = ResourceStore(self.store,SERVER.profiles)
        self.r.reconcile(self.state,self.pid)
        self.bag,_ = self.r.apply(self.pid,'c1',dict(op='grant',presetId='healing',quantity=3,revision=0,requestId='grant-healing-001'),True,state=self.state)
    def character(self, oid=None): return self.r.ledger()['characters']['c1'][oid or self.target]
    def command(self, **kwargs):
        cmd=dict(op='heal',revision=self.r.read(self.pid)['revision'],requestId='healing-once-001',itemId=self.bag['items'][0]['id'],sourceCharacterId=self.oid,characterId=self.target,targetRevision=self.character()['revision'])
        cmd.update(kwargs);return cmd
    def heal(self, **kwargs): return self.r.apply(self.pid,'c1',self.command(**kwargs),state=self.state)
    def test_transfer_is_atomic_and_retry_does_not_duplicate(self):
        cmd=self.command(op='transfer',requestId='transfer-once-001')
        bag,event=self.r.apply(self.pid,'c1',cmd,state=self.state)
        target=self.r.read(self.other)
        self.assertEqual(bag['items'][0]['quantity'],0)
        self.assertEqual(target['items'][0]['quantity'],3)
        self.assertEqual(target['items'][0]['ownerCharacterId'],self.target)
        self.assertEqual(target['revision'],1)
        self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(len(self.r.read(self.other)['items']),1)
        self.assertEqual(self.r.read(self.other)['revision'],1)
        self.r.ledger()  # Stored ledger remains valid.

    def test_partial_transfer_preserves_remainder_and_signs_quantity(self):
        cmd=self.command(op='transfer',quantity=2,requestId='partial-transfer-01')
        bag,event=self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(bag['items'][0]['quantity'],1)
        self.assertEqual(self.r.read(self.other)['items'][0]['quantity'],2)
        self.r.apply(self.pid,'c1',cmd,state=self.state)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid,'c1',dict(cmd,quantity=1),state=self.state)
        self.assertEqual(self.r.read(self.other)['items'][0]['quantity'],2)

    def test_partial_transfer_between_own_roles(self):
        # A previously unassigned stack can be split into this player's character bag.
        if self.bag['items'][0].get('ownerCharacterId') == self.oid:
            self.skipTest('Global fixture already belongs to this character')
        bag,_=self.r.apply(self.pid,'c1',self.command(op='transfer',quantity=1,characterId=self.oid),state=self.state)
        self.assertEqual(sorted(i['quantity'] for i in bag['items']),[1,2])
        self.assertEqual(bag['items'][1]['ownerCharacterId'],self.oid)

    def test_transfer_rejects_invalid_quantity(self):
        before=copy.deepcopy(self.r.ledger())
        for amount in (0,-1,4,1.5,True,'2'):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.r.apply(self.pid,'c1',self.command(op='transfer',quantity=amount),state=self.state)
            self.assertEqual(self.r.ledger(),before)

    def test_transfer_write_failure_leaves_both_inventories_unchanged(self):
        before=copy.deepcopy(self.r.ledger())
        with mock.patch.object(self.r, 'save', side_effect=OSError('write failed')):
            with self.assertRaises(OSError):
                self.r.apply(self.pid,'c1',self.command(op='transfer'),state=self.state)
        self.assertEqual(self.r.ledger(),before)

    def test_transfer_rejects_hidden_target_without_changing_bags(self):
        self.state['maps'][0]['tokens'][1]['hiddenFromPlayers']=True
        before=copy.deepcopy(self.r.ledger())
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.pid,'c1',self.command(op='transfer'),state=self.state)
        self.assertEqual(self.r.ledger(),before)

    def test_heal_cross_player_clamp_retry_restart_and_undo(self):
        cmd=self.command();bag,e=self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(e['beforeHp'],18);self.assertEqual(e['afterHp'],20)
        self.assertEqual(sum(e['dice'])+e['bonus'],e['total']);self.assertEqual(bag['items'][0]['quantity'],2)
        self.assertNotIn('afterItem',e);self.assertNotIn('afterItem',bag['history'][-1])
        self.r=ResourceStore(self.store,SERVER.profiles)
        replay,ev=self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(replay,bag);self.assertEqual(ev,e)
        undo=dict(op='undo',revision=bag['revision'],requestId='undo-healing-001',eventId=e['id'])
        restored,_=self.r.apply(self.pid,'c1',undo,True,state=self.state)
        self.assertEqual(restored['items'][0]['quantity'],3);self.assertEqual(self.character()['runtime']['hp'],18)
        self.r.apply(self.pid,'c1',undo,True,state=self.state)
        self.assertEqual(self.character()['runtime']['hp'],18)
    def test_failed_and_uncertain_commit_do_not_split_cost_and_effect(self):
        before=self.r.ledger();cmd=self.command();atomic=SERVER.profiles.atomic
        def fail(path,value):
            if path==self.r.ledger_path: raise OSError('disk full')
            atomic(path,value)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail):
            with self.assertRaises(OSError):self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(self.r.ledger(),before)
        def uncertain(path,value):
            atomic(path,value)
            if path==self.r.ledger_path: raise OSError('lost reply')
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=uncertain):
            with self.assertRaises(OSError):self.r.apply(self.pid,'c1',cmd,state=self.state)
        bag,event=self.r.apply(self.pid,'c1',cmd,state=self.state)
        self.assertEqual(bag['items'][0]['quantity'],2);self.assertEqual(self.character()['runtime']['hp'],20)
        self.assertEqual(len([h for h in bag['history'] if h['op']=='heal']),1)
    def test_stale_map_reconnect_projects_and_fresh_combat_changes_invalidate_undo(self):
        old=copy.deepcopy(self.state);bag,e=self.heal();self.r.reconcile(old,accept_changes=True)
        t=old['maps'][0]['tokens'][1];self.assertEqual(t['hp'],20)
        t['hp']=11;self.r.reconcile(old,accept_changes=True);self.assertEqual(self.character()['runtime']['hp'],11)
        with self.assertRaises(SERVER.profiles.ProfileError) as raised:
            self.r.apply(self.pid,'c1',dict(op='undo',revision=bag['revision'],requestId='undo-stale-00001',eventId=e['id']),True,state=old)
        self.assertEqual(raised.exception.status,409)
        self.r.reconcile(self.state,accept_changes=True);self.assertEqual(self.state['maps'][0]['tokens'][1]['hp'],11)
    def test_hidden_cross_map_and_foreign_source_rejected(self):
        for change in ('hidden','map','source','duplicate','full','stale'):
            with self.subTest(change=change):
                state=copy.deepcopy(self.state);cmd=self.command(requestId='invalid-heal-'+change)
                if change=='hidden':state['maps'][0]['tokens'][1]['hiddenFromPlayers']=True
                if change=='map':state['maps'].append(dict(id='m2',playerAccessible=True,tokens=[state['maps'][0]['tokens'].pop()]))
                if change=='source':cmd['sourceCharacterId']=self.target
                if change=='duplicate':state['maps'][0]['tokens'].append(copy.deepcopy(state['maps'][0]['tokens'][1]))
                if change=='stale':cmd['targetRevision']=0
                if change=='full':cmd['characterId']=self.oid;state['maps'][0]['tokens'][0]['hp']=30;self.r.reconcile(state,accept_changes=True);cmd['targetRevision']=self.character(self.oid)['revision']
                with self.assertRaises(SERVER.profiles.ProfileError): self.r.apply(self.pid,'c1',cmd,state=state)
                self.assertEqual(self.r.read(self.pid)['items'][0]['quantity'],3)
    def test_concurrent_spend_only_once(self):
        outcomes=[];cmd=self.command()
        def use(i):
            try:self.r.apply(self.pid,'c1',dict(cmd,requestId='parallel-heal-%03d'%i),state=self.state);outcomes.append('ok')
            except SERVER.profiles.ProfileError:outcomes.append('conflict')
        threads=[threading.Thread(target=use,args=(i,)) for i in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(sorted(outcomes),['conflict','ok'])
    def test_document_and_gear_no_magic_rarity_or_automatic_consumption(self):
        for cat in ('document','gear'):
            bag=self.r.read(self.pid)
            item=dict(name='蜡封日记' if cat=='document' else '麻绳',category=cat,rarity='传说',effect='船骸找到',body='亲爱的，你会回来。\n我仍在等候。',consumable=False)
            out,_=self.r.apply(self.pid,'c1',dict(op='grant',item=item,quantity=1,revision=bag['revision'],requestId='grant-story-'+cat),True,state=self.state)
            self.assertEqual(out['items'][-1]['rarity'],'');self.assertFalse(out['items'][-1]['consumable'])
            if cat=='document':self.assertEqual(out['items'][-1]['body'],item['body'])
        self.assertNotIn('backpacks',self.state)
    def test_legacy_import_shared_backpack_preserves_original(self):
        legacy=InventoryStore(self.store,SERVER.profiles)
        legacy.apply(self.other,'old-campaign',dict(op='grant',presetId='healing',quantity=2,revision=0,requestId='legacy-grant-001'),True)
        raw=legacy.path(self.other).read_bytes()
        bag=self.r.read(self.other,'another-campaign');self.assertEqual(bag['items'][0]['ruleId'],'healing')
        self.r.apply(self.other,'c1',dict(op='annotate',itemId=bag['items'][0]['id'],notes='保留',revision=bag['revision'],requestId='migrate-note-001'),state=self.state)
        self.assertEqual(legacy.path(self.other).read_bytes(),raw)
        self.assertEqual(self.r.read(self.other,'c2')['items'][0]['quantity'],2)
    def test_pending_legacy_use_receipt_survives_rule_upgrade(self):
        old=InventoryStore(self.store,SERVER.profiles)
        bag,_=old.apply(self.other,'c1',dict(op='grant',presetId='healing',quantity=2,revision=0,requestId='legacy-pending-grant'),True)
        cmd=dict(op='use',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId='legacy-pending-use')
        used,event=old.apply(self.other,'c1',cmd)
        migrated,replayed=self.r.apply(self.other,'c1',cmd,state=self.state)
        self.assertEqual(migrated['items'][0]['quantity'],1);self.assertEqual(replayed,event)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.r.apply(self.other,'c1',dict(cmd,revision=migrated['revision'],requestId='new-rule-use-0001'),state=self.state)
    def test_assign_ownership_and_prevent_shared_grant_merging(self):
        bag,_=self.r.apply(self.pid,'c1',dict(op='assign',revision=self.bag['revision'],requestId='assign-owner-001',itemId=self.bag['items'][0]['id'],characterId=self.oid),state=self.state)
        self.assertEqual(bag['items'][0]['ownerCharacterId'],self.oid)
        with self.assertRaises(SERVER.profiles.ProfileError): self.r.apply(self.pid,'c1',dict(op='assign',revision=bag['revision'],requestId='assign-foreign-001',itemId=self.bag['items'][0]['id'],characterId=self.target),state=self.state)
        bag,_=self.r.apply(self.pid,'c1',dict(op='grant',presetId='healing',quantity=1,revision=bag['revision'],requestId='grant-unassigned-001'),True,state=self.state)
        self.assertEqual(len(bag['items']),2)
    def test_undo_rejects_item_changes_even_when_quantity_returns_to_same_value(self):
        bag,event=self.heal()
        for index,quantity in enumerate((1,2)):
            bag,_=self.r.apply(self.pid,'c1',dict(op='adjust',itemId=bag['items'][0]['id'],revision=bag['revision'],quantity=quantity,requestId='adjust-after-heal-%s'%index),True,state=self.state)
        with self.assertRaises(SERVER.profiles.ProfileError) as error:
            self.r.apply(self.pid,'c1',dict(op='undo',revision=bag['revision'],requestId='undo-after-item-001',eventId=event['id']),True,state=self.state)
        self.assertEqual(error.exception.status,409)
    def test_corrupt_ledger_fail_closed_and_disabled_character(self):
        raw=self.r.ledger_path.read_bytes();self.r.ledger_path.write_text('{bad')
        with self.assertRaises(SERVER.profiles.ProfileError):self.r.read(self.pid)
        self.assertEqual(self.r.ledger_path.read_text(),'{bad');self.r.ledger_path.write_bytes(raw)
        with mock.patch.object(self.store,'owns',return_value=False):
            with self.assertRaises(SERVER.profiles.ProfileError):self.heal()
    def test_offmap_character_release_uses_canonical_hp(self):
        self.heal()
        state=dict(campaignId='c1',maps=[dict(id='m2',playerAccessible=True,mapW=1000,mapH=1000,tokens=[])])
        with mock.patch.object(SERVER,'profile_store',return_value=self.store):
            action,error,_=SERVER.normalize_player_owned_release_action(state,dict(op='releaseOwnedPiece',mapId='m2',ownedPieceId=self.target),self.other,'乙')
        self.assertIsNone(error);self.assertEqual(action['token']['hp'],20)
    def test_unbound_new_map_token_does_not_reset_record(self):
        self.heal();state=copy.deepcopy(self.state);state['maps'][0]['tokens'][1].pop('characterRevision')
        self.r.reconcile(state,accept_changes=True);self.assertEqual(state['maps'][0]['tokens'][1]['hp'],20)
    def test_http_private_characters_and_server_only_action(self):
        state=copy.deepcopy(self.state);state['maps'][0]['tokens'][1]['hiddenFromPlayers']=True
        handler=mock.Mock();handler.headers={};handler._read_json_body.return_value=dict(op='get',playerId=self.pid,campaignId='c1')
        with mock.patch.object(SERVER,'profile_store',return_value=self.store),mock.patch.object(SERVER,'host_request_allowed',return_value=False),mock.patch.object(SERVER,'touch_session',return_value=dict(persistent=True,playerId=self.pid)),mock.patch.object(SERVER,'STATE',state):
            SERVER.Handler.handle_backpack(handler)
        result=handler._send_document_json.call_args.args[0]
        self.assertTrue(result['ok']);self.assertEqual([c['id'] for c in result['characters']],[self.oid])
        self.assertNotIn('characters',SERVER.state_snapshot() or {})

import test_player_profiles as profile_tests

class ResourceHttpTests(unittest.TestCase):
    setUp = profile_tests.PlayerProfileHttpTests.setUp
    close_server = profile_tests.PlayerProfileHttpTests.close_server
    request = profile_tests.PlayerProfileHttpTests.request
    login = profile_tests.PlayerProfileHttpTests.login
    def test_healing_preserved_when_stale_host_map_and_stale_player_hp_rejected(self):
        store=SERVER.profile_store();session=self.login()
        piece=store.grant(self.pid,dict(name='旅者',type='pc',hpMax=30,ac=15),'rules-http-character')['pieces'][0]
        token=dict(piece,id='rules-token',hp=4,x=30,y=30)
        initial=dict(campaignId='c1',maps=[dict(id='m1',playerAccessible=True,tokens=[token])])
        with mock.patch.object(SERVER,'STATE',None),mock.patch.object(SERVER,'RECENT_ACTIONS',[]),mock.patch.object(SERVER,'ACTION_IDS',{}):
            status,info=self.request(method='GET',path='/api/info');self.assertEqual(status,200,info)
            authority=info['stateAuthority']
            initial.update(expectedStateRevision=authority['stateRevision'],serverSessionId=authority['sessionId'])
            status,result=self.request(initial,path='/api/state');self.assertEqual(status,200,result)
            stale=copy.deepcopy(SERVER.STATE);revision=stale['maps'][0]['tokens'][0]['characterRevision']
            # This page's baseline is the acknowledgement of its own publish.
            # Receiving a later version number cannot authorize its old map.
            stale.update(expectedStateRevision=result['stateRevision'],serverSessionId=result['sessionId'])
            status,result=self.request(dict(op='grant',playerId=self.pid,presetId='healing',quantity=2,revision=0,requestId='http-rules-grant'),host=True,path='/api/backpack')
            self.assertEqual(status,200,result)
            item=result['backpack']['items'][0];cid=piece['ownedPieceId']
            command=dict(op='heal',sessionToken=session,campaignId='c1',itemId=item['id'],sourceCharacterId=cid,characterId=cid,targetRevision=revision,revision=1,requestId='http-rules-healing')
            status,result=self.request(command,path='/api/backpack');self.assertEqual(status,200,result)
            healed=result['event']['afterHp'];self.assertGreater(healed,4)
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['hp'],healed)
            status,replayed=self.request(command,path='/api/backpack');self.assertEqual(status,200,replayed)
            self.assertEqual(replayed['event']['dice'],result['event']['dice']);self.assertEqual(replayed['backpack']['items'][0]['quantity'],1)
            status,result=self.request(stale,path='/api/state');self.assertEqual(status,409,result)
            self.assertEqual(result['errorCode'],'state-conflict')
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['hp'],healed)
            request=dict(sessionToken=session,action=dict(op='patchToken',tokenId='rules-token',mapId='m1',patch={'hp':1},characterRevision=revision))
            self.assertEqual(self.request(request,path='/api/action')[0],409)
            request['action']['characterRevision']=SERVER.STATE['maps'][0]['tokens'][0]['characterRevision']
            request['actionId']='http-rules-patch-ack'
            status,result=self.request(request,path='/api/action');self.assertEqual(status,200,result)
            updates={u['characterId']:u['patch'] for u in result['characterUpdates']}
            self.assertEqual(updates[cid]['hp'],1)
            self.assertEqual(updates[cid]['characterRevision'],SERVER.STATE['maps'][0]['tokens'][0]['characterRevision'])
            status,repeated=self.request(request,path='/api/action');self.assertEqual(status,200,repeated)
            self.assertTrue(repeated['duplicate'])
            self.assertEqual(repeated['characterUpdates'],result['characterUpdates'])
            wrong_campaign=dict(request,campaignId='another-campaign')
            self.assertEqual(self.request(wrong_campaign,path='/api/action')[0],409)
            condition_request=dict(sessionToken=session,actionId='http-rules-condition-ack',
                                   action=dict(op='patchToken',tokenId='rules-token',mapId='m1',
                                               patch={'conditions':[]},characterRevision=revision))
            self.assertEqual(self.request(condition_request,path='/api/action')[0],409)
            condition_request['action']['characterRevision']=SERVER.STATE['maps'][0]['tokens'][0]['characterRevision']
            status,condition_result=self.request(condition_request,path='/api/action')
            self.assertEqual(status,200,condition_result)
            self.assertEqual(ResourceStore(store,SERVER.profiles).ledger()['characters']['c1'][cid]['runtime']['hp'],1)
            status,result=self.request(dict(op='undo',playerId=self.pid,campaignId='c1',revision=2,requestId='http-rules-undo-001',eventId=command['requestId']),host=True,path='/api/backpack')
            self.assertEqual(status,409,result)
    def test_resource_ledger_is_not_public_or_cross_player_readable(self):
        session=self.login()
        status,result=self.request(dict(op='grant',playerId=self.pid,presetId='healing',quantity=2,revision=0,requestId='http-secret-grant'),host=True,path='/api/backpack');self.assertEqual(status,200,result)
        for path in ('/存档/玩家档案/冒险资源.json','/存档/玩家档案/资源自动备份/1.json'):
            from urllib.parse import quote
            self.assertEqual(self.request(path=quote(path),method='GET')[0],404)
        other=SERVER.profile_store().create('其他')['profile']['playerId']
        status,result=self.request(dict(op='get',sessionToken=session,playerId=other),path='/api/backpack');self.assertEqual(status,403,result)
