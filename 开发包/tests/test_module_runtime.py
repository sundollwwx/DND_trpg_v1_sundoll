from project_test_paths import APP_ROOT
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(APP_ROOT))
from server.module_runtime import ModuleRuntime
from server import player_profiles as profiles
from server.resources import ResourceStore
from server.module_store import RevisionConflict


class ModuleRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=ModuleRuntime(self.root/'source',self.root/'app')
        self.target=ModuleRuntime(self.root/'target',self.root/'empty-app')
        self.source.ensure_empty_runtime()

    def test_two_campaign_runs_have_distinct_map_tokens_and_retries_do_not_duplicate(self):
        payload={'state':{'maps':[{'id':'m1','tokens':[{'id':'t1','name':'NPC'}]}],'activeMapId':'m1'},'templates':[],'items':[]}
        package=self.root/'campaign.sundoll'
        self.source.packages.export(package,'campaign-content','场景',payload,'module-campaign')
        self.target.packages.install(package)
        first=self.target.create_run('module-campaign','request-first-run')
        self.assertEqual(first,self.target.create_run('module-campaign','request-first-run'))
        second=self.target.create_run('module-campaign','request-other-run')
        self.assertNotEqual(first['campaignId'],second['campaignId'])
        def state(r):return json.loads((self.target.root/'战役'/r['campaignId']/'当前存档.json').read_text())['state']
        a,b=state(first),state(second)
        self.assertNotEqual(a['activeMapId'],b['activeMapId'])
        self.assertNotEqual(a['maps'][0]['tokens'][0]['id'],b['maps'][0]['tokens'][0]['id'])

    def test_player_import_keeps_identity_hp_inventory_and_never_populates_big_library(self):
        store=profiles.Store(self.source.root,self.source.app,self.root/'cache')
        player=store.create('旅人');pid=player['profile']['playerId']
        piece=store.grant(pid,{'name':'旅者','hpMax':30,'ac':15},'grant-character-001')['pieces'][0]
        oid=piece['ownedPieceId'];resources=ResourceStore(store,profiles)
        state={'campaignId':'c1','maps':[{'id':'m','tokens':[dict(piece,id='t',hp=7)]}]}
        resources.reconcile(state,accept_changes=True)
        bag,_=resources.apply(pid,'c1',dict(op='grant',characterId=oid,presetId='healing',quantity=2,revision=0,requestId='grant-potions-001'),True)
        resources.apply(pid,'c1',dict(op='assign',itemId=bag['items'][0]['id'],characterId=oid,revision=bag['revision'],requestId='assign-potions-001'))
        package=self.root/'player.sundoll'
        manifest=self.source.export_player(pid,package)
        self.target.packages.install(package)
        result=self.target.activate_player(manifest['moduleId'])
        self.assertEqual(result['playerId'],pid)
        destination=profiles.Store(self.target.root,self.target.app,self.root/'cache2')
        migrated=destination.library(pid)['pieces'][0]
        self.assertEqual((migrated['ownedPieceId'],migrated['hp']),(oid,7))
        items=ResourceStore(destination,profiles).read(pid)['items']
        self.assertEqual((items[0]['id'],items[0]['quantity'],items[0]['ownerCharacterId']),(bag['items'][0]['id'],2,oid))
        self.assertFalse((self.target.root/'棋子库/棋子库.json').exists())
        self.target.activate_player(manifest['moduleId'])
        self.assertEqual(len(destination.players()),1)
        self.assertNotEqual(destination.credential(pid),player['credential'])
        destination.delete(pid)
        with self.assertRaises(RevisionConflict):self.target.activate_player(manifest['moduleId'])

    def test_player_export_does_not_transfer_server_account_binding(self):
        store=profiles.Store(self.source.root,self.source.app,self.root/'cache')
        player=store.create('账号玩家',account_id='a'+'1'*32)['profile']
        package=self.root/'account-player.sundoll'
        self.source.export_player(player['playerId'],package)
        _,payload=self.source.packages.inspect(package)
        self.assertNotIn('accountId',payload['profile'])
        self.assertEqual(store.read(player['playerId'])['accountId'],'a'+'1'*32)

    def test_progress_import_keeps_campaign_identity_and_does_not_overwrite_newer_run(self):
        package=self.root/'progress.sundoll'
        payload={'state':{'campaignId':'c-existing','maps':[{'id':'m','tokens':[]}],'activeMapId':'m'}}
        self.source.packages.export(package,'campaign-progress','进度',payload,'progress-one')
        self.target.packages.install(package)
        result=self.target.create_run('progress-one','progress-request1')
        self.assertEqual(result['campaignId'],'c-existing')
        path=self.target.root/'战役/c-existing/当前存档.json'
        data=json.loads(path.read_text());data['state']['maps'][0]['name']='newer';profiles.atomic(path,data)
        self.target.create_run('progress-one','progress-request2')
        self.assertEqual(json.loads(path.read_text())['state']['maps'][0]['name'],'newer')

    def test_general_first_import_and_grant_preserve_source_template_version(self):
        from server.item_library import ItemLibrary
        package = self.root / 'versioned-general.sundoll'
        self.source.packages.export(package, 'general', '通用物品', dict(templates=[], items=[
            dict(id='versioned-potion', name='新版药水', category='potion', rarity='普通', scope='general',
                 consumable=True, effect='饮下后恢复体力。', version=7)]), 'versioned-general')
        self.target.ensure_empty_runtime()
        self.target.packages.install(package)
        self.target.activate_general('versioned-general')
        store = profiles.Store(self.target.root, self.target.app, self.root / 'version-cache')
        template = next(i for i in ItemLibrary(store, profiles).read()['templates']
                        if i.get('contentEntryId') == 'versioned-potion')
        self.assertEqual(template['version'], 7)
        pid = store.create('旅者')['profile']['playerId']
        piece = store.grant(pid, dict(name='旅者', hpMax=10), 'version-piece-grant')['pieces'][0]
        resources = ResourceStore(store, profiles)
        state = dict(campaignId='version-campaign', maps=[dict(id='m', tokens=[dict(piece, id='t')])])
        resources.reconcile(state, pid)
        bag, event = resources.apply(pid, 'version-campaign', dict(op='grant',
            characterId=piece['ownedPieceId'], templateId=template['id'], templateVersion=7,
            quantity=1, revision=0, requestId='version-item-grant'), True, state=state)
        item = next(i for i in bag['items'] if i['id'] == event['itemId'])
        self.assertEqual((item['sourceTemplateVersion'], item['sourcePackageId'], item['sourceScope']),
                         (7, template['contentPackageId'], 'general'))

    def test_support_documents_and_music_join_existing_catalogs(self):
        from server.documents import document_library_catalog
        from server.music_catalog import music_library_catalog
        from unittest import mock
        pdf=self.source.store.put_asset(b'%PDF-1.4 test', 'application/pdf', 'support')
        audio=self.source.store.put_asset(b'ID3test', 'audio/mpeg', 'support')
        payload={'state':{'maps':[{'id':'m','tokens':[]}]},'documents':[{'name':'秘密备团','fileUrl':pdf}], 'music':[{'name':'洞穴','fileUrl':audio}]}
        package=self.root/'support.sundoll'
        self.source.packages.export(package,'campaign-content','洞穴',payload,'support-module')
        self.target.packages.install(package)
        with mock.patch.object(self.target,'_publish_support_files',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):self.target.create_run('support-module','support-request-001')
        result=self.target.create_run('support-module','support-request-001')
        cid=result['campaignId']
        docs=document_library_catalog(self.target.root/'模块资料/文档',cid,'洞穴')
        tracks=music_library_catalog(self.target.root/'模块资料/音乐',cid,'洞穴')
        self.assertEqual(len(docs['documents']),1)
        self.assertEqual(len(tracks['tracks']),1)
        self.assertEqual(self.target.create_run('support-module','support-request-001'),result)

    def test_progress_detects_existing_legacy_named_directory(self):
        path=self.target.root/'战役/c-existing-旧名字/当前存档.json'
        profiles.atomic(path,dict(campaignId='c-existing',state=dict(maps=[dict(id='old',tokens=[])])))
        package=self.root/'existing.sundoll'
        self.source.packages.export(package,'campaign-progress','进度',{'state':{'campaignId':'c-existing','maps':[]}},'existing-module')
        self.target.packages.install(package)
        self.target.create_run('existing-module','existing-request-001')
        self.assertFalse((self.target.root/'战役/c-existing').exists())
        self.assertEqual(json.loads(path.read_text())['state']['maps'][0]['id'],'old')

    def test_old_progress_and_new_player_loot_snapshots_cannot_be_combined(self):
        store=profiles.Store(self.source.root,self.source.app,self.root/'cache')
        pid=store.create('旅人')['profile']['playerId']
        store.grant(pid,dict(name='旅人',hpMax=10),'pairing-grant-001')
        resources=ResourceStore(store,profiles)
        resources.reconcile(dict(campaignId='c1',maps=[]),pid)
        ledger=resources.ledger()
        old=self.source._transfer_snapshot(ledger)
        ledger['mapItems']={'c1':{'m':{'revision':1,'markers':[],'receipts':{}}}}
        resources.save(ledger)
        player=self.root/'new-player.sundoll'
        pm=self.source.export_player(pid,player)
        progress=self.root/'old-progress.sundoll'
        payload={'state':{'campaignId':'c1','maps':[{'id':'m','tokens':[]}]},'resourceSnapshot':old}
        self.source.packages.export(progress,'campaign-progress','旧进度',payload,'old-progress')
        self.target.packages.install(player);self.target.packages.install(progress)
        self.target.activate_player(pm['moduleId'])
        with self.assertRaisesRegex(RevisionConflict,'战利品版本'):
            self.target.create_run('old-progress','old-progress-request')
        self.assertFalse((self.target.root/'战役/c1/当前存档.json').exists())
        reverse=ModuleRuntime(self.root/'reverse',self.root/'empty-app')
        reverse.packages.install(progress);reverse.packages.install(player)
        reverse.create_run('old-progress','reverse-progress-request')
        with self.assertRaisesRegex(RevisionConflict,'战利品版本'):reverse.activate_player(pm['moduleId'])

    def test_progress_parked_character_uses_imported_player_resources(self):
        store=profiles.Store(self.source.root,self.source.app,self.root/'cache')
        pid=store.create('旅人')['profile']['playerId']
        piece=store.grant(pid,dict(name='旅人',hpMax=10),'parked-grant-001')['pieces'][0]
        resources=ResourceStore(store,profiles)
        current=dict(campaignId='c1',maps=[dict(id='m',tokens=[dict(piece,id='t')])])
        resources.reconcile(current,pid)
        canonical=resources.ledger()['characters']['@global'][piece['ownedPieceId']]
        stale=dict(current['maps'][0]['tokens'][0],hp=1,characterRevision=canonical['revision']+10)
        state=dict(campaignId='c1',maps=[dict(id='m',tokens=[])],parkedOwnedPieces={piece['ownedPieceId']:stale})
        player=self.root/'parked-player.sundoll';pm=self.source.export_player(pid,player)
        progress=self.root/'parked-progress.sundoll'
        self.source.packages.export(progress,'campaign-progress','旧战役',dict(state=state,
            resourceSnapshot=self.source._transfer_snapshot(resources.ledger())),'parked-progress')
        self.target.packages.install(player);self.target.activate_player(pm['moduleId'])
        self.target.packages.install(progress)
        self.target.create_run('parked-progress','parked-request-001')
        saved=json.loads((self.target.root/'战役/c1/当前存档.json').read_text())['state']
        token=saved['parkedOwnedPieces'][piece['ownedPieceId']]
        self.assertEqual(token['hp'],canonical['runtime']['hp'])
        self.assertEqual(token['characterRevision'],canonical['revision'])
        target_store=profiles.Store(self.target.root,self.target.app,self.root/'cache2')
        self.assertEqual(ResourceStore(target_store,profiles).ledger()['characters']['@global'][piece['ownedPieceId']],canonical)

    def test_matching_progress_and_player_snapshots_can_be_paired(self):
        store=profiles.Store(self.source.root,self.source.app,self.root/'cache')
        pid=store.create('旅人')['profile']['playerId']
        piece=store.grant(pid,dict(name='旅人',hpMax=10),'matched-grant-001')['pieces'][0]
        resources=ResourceStore(store,profiles)
        state=dict(campaignId='c1',maps=[dict(id='m',tokens=[dict(piece,id='t')])])
        resources.reconcile(state,pid)
        player=self.root/'matched-player.sundoll';pm=self.source.export_player(pid,player)
        payload={'state':state,'resourceSnapshot':self.source._transfer_snapshot(resources.ledger())}
        progress=self.root/'matched-progress.sundoll'
        self.source.packages.export(progress,'campaign-progress','进度',payload,'matched-progress')
        self.target.packages.install(player);self.target.packages.install(progress)
        self.target.activate_player(pm['moduleId'])
        self.assertEqual(self.target.create_run('matched-progress','matched-request-001')['campaignId'],'c1')
