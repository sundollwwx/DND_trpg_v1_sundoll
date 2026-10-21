"""Historical campaign and portable-module boundaries, using isolated data only."""
from project_test_paths import APP_ROOT
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest import mock

from server import player_profiles as profiles
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore, RevisionConflict
from server.module_management import overview, restore_campaign
from server.resources import ResourceStore
from server.save_storage import perform_local_save_operation, campaign_catalog, CAMPAIGN_SUMMARIES, SaveConflict
from server.workspace import Workspace, enable


class ProjectPersistenceAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-persistence-audit-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = ModuleRuntime(self.root/'source', self.root/'app')
        self.target = ModuleRuntime(self.root/'target', self.root/'app')
        self.source.ensure_empty_runtime()

    def install_progress(self, state=None, identity='historical-progress'):
        archive = self.root/'progress.sundoll'
        self.source.packages.export(archive, 'campaign-progress', '旧进度',
            {'state': state or {'campaignId':'c1','maps':[{'id':'new-map','tokens':[]}]}}, identity)
        self.target.packages.install(archive)
        return identity

    def player_pair(self):
        store = profiles.Store(self.source.root, self.source.app, self.root/'pair-cache')
        resources = ResourceStore(store, profiles)
        pids = [store.create(name)['profile']['playerId'] for name in ('甲', '乙')]
        pieces = [store.grant(pid, {'name':name,'hpMax':10}, 'pair-grant-request-'+str(i))['pieces'][0]
            for i, (pid,name) in enumerate(zip(pids, ('甲角色','乙角色')))]
        state = {'campaignId':'c1','maps':[{'id':'m','playerAccessible':True,
            'tokens':[dict(piece,id='t'+str(i)) for i,piece in enumerate(pieces)]}]}
        for pid in pids: resources.reconcile(state, pid)
        bag, _ = resources.apply(pids[0], 'c1', {'op':'grant','characterId':pieces[0]['ownedPieceId'],
            'presetId':'healing','quantity':2,'revision':0,'requestId':'pair-potions-grant01'}, True, state=state)
        return store, resources, pids, pieces, state, bag

    def export_pair_member(self, pid, label, legacy=False, no_snapshot=False):
        archive = self.root/(label+'.sundoll')
        self.source.export_player(pid, archive)
        if legacy or no_snapshot:
            with zipfile.ZipFile(archive) as source:
                entries = {name:source.read(name) for name in source.namelist()}
            payload = json.loads(entries['data.json'])
            if no_snapshot: payload.pop('resourceSnapshot', None)
            else: payload['resourceSnapshot'].pop('inventoryHash', None)
            entries['data.json'] = json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode()
            manifest = json.loads(entries['manifest.json'])
            manifest['dataHash'] = hashlib.sha256(entries['data.json']).hexdigest()
            entries['manifest.json'] = json.dumps(manifest,ensure_ascii=False,separators=(',',':')).encode()
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as destination:
                for name, data in entries.items(): destination.writestr(name, data)
        return archive

    def import_player(self, runtime, archive):
        manifest = runtime.packages.install(archive)
        return runtime.activate_player(manifest['moduleId'])

    def player_data(self, runtime):
        store = profiles.Store(runtime.root, runtime.app, self.root/'target-cache')
        resources = ResourceStore(store, profiles)
        return {'players':store.players(), 'ledger':resources.ledger(),
            'libraries':{player['playerId']:store.library(player['playerId']) for player in store.players()}}

    def test_progress_cannot_revive_a_canonical_archived_campaign(self):
        self.install_progress()
        path = self.target.root/'战役/c1/当前存档.json'
        profiles.atomic(path, {'campaignId':'c1','state':{'campaignId':'c1','maps':[]}})
        profiles.atomic(path.parent/'已删除.json', {'campaignId':'c1'})
        before = path.read_bytes()
        with self.assertRaisesRegex(RevisionConflict, '归档'):
            self.target.create_run('historical-progress', 'archived-canonical-run')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(campaign_catalog(self.target.root), [])

    def test_progress_cannot_create_a_duplicate_of_a_named_archived_campaign(self):
        self.install_progress()
        path = self.target.root/'战役/c1-旧名字/当前存档.json'
        profiles.atomic(path, {'campaignId':'c1','state':{'campaignId':'c1','maps':[]}})
        profiles.atomic(path.parent/'已删除.json', {'campaignId':'c1'})
        with self.assertRaisesRegex(RevisionConflict, '归档'):
            self.target.create_run('historical-progress', 'archived-named-run-01')
        self.assertFalse((self.target.root/'战役/c1').exists())
        self.assertEqual(len(list(self.target.root.glob('战役/*/当前存档.json'))), 1)

    def test_progress_refuses_multiple_existing_directories_for_one_identity(self):
        self.install_progress()
        for folder in ('c1-older', 'c1-newer'):
            profiles.atomic(self.target.root/'战役'/folder/'当前存档.json',
                {'campaignId':'c1','state':{'campaignId':'c1','maps':[]}})
        with self.assertRaisesRegex(RevisionConflict, '重复'):
            self.target.create_run('historical-progress', 'duplicate-progress-run')
        self.assertFalse((self.target.root/'战役/c1').exists())

    def test_old_nested_identity_and_name_are_visible_and_restorable_after_archive(self):
        self.target.ensure_empty_runtime()
        path = self.target.root/'战役/c1-旧名字/当前存档.json'
        profiles.atomic(path, {'state':{'campaignId':'c1','campaignName':'旧名字','maps':[]}})
        profiles.atomic(path.parent/'已删除.json', {'campaignId':'c1'})
        archived = overview(self.target)['archivedCampaigns']
        self.assertEqual(archived, [{'id':'c1','name':'旧名字','path':'战役/c1-旧名字/当前存档.json'}])
        self.assertEqual(restore_campaign(self.target, archived[0]['path'], 'c1'), {'campaignId':'c1'})
        self.assertEqual(campaign_catalog(self.target.root)[0]['id'], 'c1')

    def test_interrupted_module_start_cannot_resume_with_a_changed_package(self):
        archive = self.root/'content.sundoll'
        first = self.source.packages.export(archive, 'campaign-content', '第一版',
            {'state':{'maps':[{'id':'m','name':'第一版地图','tokens':[]}]}}, 'versioned-campaign')
        self.target.packages.install(archive)
        with mock.patch.object(self.target, '_publish_support_files', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                self.target.create_run('versioned-campaign', 'interrupted-version-run')
        self.source.packages.export(archive, 'campaign-content', '第二版',
            {'state':{'maps':[{'id':'m','name':'第二版地图','tokens':[]}]}}, 'versioned-campaign')
        self.target.packages.install(archive, first['dataHash'])
        with self.assertRaisesRegex(RevisionConflict, '版本'):
            self.target.create_run('versioned-campaign', 'interrupted-version-run')
        self.assertEqual(campaign_catalog(self.target.root), [])
        result = self.target.create_run('versioned-campaign', 'new-version-request-001')
        self.assertEqual(campaign_catalog(self.target.root)[0]['id'], result['campaignId'])

    def test_completed_module_start_retry_keeps_the_original_campaign_after_update(self):
        archive = self.root/'content.sundoll'
        first = self.source.packages.export(archive, 'campaign-content', '第一版',
            {'state':{'maps':[{'id':'m','name':'第一版地图','tokens':[]}]}}, 'versioned-campaign')
        self.target.packages.install(archive)
        launch = self.target.create_run('versioned-campaign', 'completed-version-run')
        path = self.target.root/'战役'/launch['campaignId']/'当前存档.json'
        before = path.read_bytes()
        self.source.packages.export(archive, 'campaign-content', '第二版',
            {'state':{'maps':[{'id':'m','name':'第二版地图','tokens':[]}]}}, 'versioned-campaign')
        self.target.packages.install(archive, first['dataHash'])
        self.assertEqual(self.target.create_run('versioned-campaign', 'completed-version-run'), launch)
        self.assertEqual(path.read_bytes(), before)

    def test_old_progress_does_not_restore_character_growth_in_either_import_order(self):
        store = profiles.Store(self.source.root, self.source.app, self.root/'cache')
        pid = store.create('旅人')['profile']['playerId']
        token = store.grant(pid, {'name':'战士','hpMax':20,'ac':12}, 'audit-growth-grant-001')['pieces'][0]
        oid = token['ownedPieceId']; resources = ResourceStore(store, profiles)
        state = {'campaignId':'c1','campaignName':'旧地图','maps':[{'id':'m','tokens':[dict(token,id='t',hp=7)]}]}
        resources.reconcile(state, accept_changes=True, from_host=True)
        perform_local_save_operation({'op':'write-campaign','path':'战役/c1/当前存档.json',
            'text':json.dumps({'campaignId':'c1','campaignName':'旧地图','state':state}), 'expectedHash':None}, self.source.root)
        latest = copy.deepcopy(state); latest['maps'][0]['tokens'][0]['hp'] = 2
        latest['maps'][0]['tokens'][0]['conditions'] = [{'name':'中毒'}]
        resources.reconcile(latest, accept_changes=True, from_host=True)
        lib = store.library(pid); piece = lib['pieces'][0]
        store.edit(pid, oid, lib['revision'], {'hpMax':35,'ac':18,'name':'成长后的战士'}, piece['revision'], host=True)
        player = self.root/'player.sundoll'; progress = self.root/'progress.sundoll'
        pm = self.source.export_player(pid, player)
        cm = self.source.export_campaign('c1', 'campaign-progress', progress)
        for order in ('player-first', 'progress-first'):
            with self.subTest(order=order):
                target = ModuleRuntime(self.root/order, self.root/'app')
                target.packages.install(player); target.packages.install(progress)
                if order == 'player-first': target.activate_player(pm['moduleId'])
                target.create_run(cm['moduleId'], 'historical-growth-run01')
                if order == 'progress-first': target.activate_player(pm['moduleId'])
                loaded = perform_local_save_operation({'op':'read-campaign','path':'战役/c1/当前存档.json'}, target.root)
                projection = json.loads(loaded['text'])['state']['maps'][0]['tokens'][0]
                self.assertEqual((projection['hp'], projection['hpMax'], projection['ac'], projection['name']),
                    (2, 35, 18, '成长后的战士'))
                self.assertEqual(projection['conditions'], [{'name':'中毒'}])

    def test_catalog_cannot_create_an_empty_coordinator_when_live_authority_is_missing(self):
        state = {'campaignId':'c1','maps':[]}
        perform_local_save_operation({'op':'write-campaign','path':'战役/c1/当前存档.json',
            'text':json.dumps({'campaignId':'c1','state':state}), 'expectedHash':None}, self.source.root)
        database = self.source.store.database
        database.rename(database.with_suffix('.retained'))
        CAMPAIGN_SUMMARIES.clear()
        with self.assertRaisesRegex(OSError, '数据库缺失'):
            campaign_catalog(self.source.root)
        self.assertFalse(database.exists())
        from server.resource_database import ResourceDatabase
        with self.assertRaisesRegex(OSError, '数据库缺失'):
            ResourceDatabase(self.source.root).active()

    def test_module_preflight_refuses_duplicate_map_and_token_ids(self):
        cases = [
            {'maps':[{'id':'m','tokens':[]}, {'id':'m','tokens':[]}]},
            {'maps':[{'id':'m','tokens':[{'id':'t'}, {'id':'t'}]}]},
            {'maps':[{'id':'m','tokens':[{'id':'t'}]}, {'id':'n','tokens':[{'id':'t'}]}]},
        ]
        for state in cases:
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, '重复'):
                self.source.packages.export(self.root/'invalid.sundoll', 'campaign-content', '重复身份', {'state':state})
        self.assertEqual(self.source.packages.catalog(), [])

    def test_shared_module_preflight_cannot_include_owned_characters_outside_maps(self):
        character = {'id':'t','ownedPieceId':'o'+'1'*32,'ownerPlayerId':'p'+'1'*32}
        with self.assertRaisesRegex(ValueError, '玩家'):
            self.source.packages.export(self.root/'invalid-general.sundoll', 'general', '通用',
                {'templates':[character], 'items':[]})
        with self.assertRaisesRegex(ValueError, '玩家'):
            self.source.packages.export(self.root/'invalid-content.sundoll', 'campaign-content', '内容',
                {'state':{'maps':[],'travelBasketTokens':[character]}})

    def test_save_refuses_to_replace_an_existing_campaign_identity(self):
        rel = '战役/c1-旧名字/当前存档.json'
        first = perform_local_save_operation({'op':'write-campaign', 'path':rel, 'expectedHash':None,
            'text':json.dumps({'campaignId':'c1','state':{'campaignId':'c1','maps':[]}})}, self.source.root)
        target = self.source.root/rel; before = target.read_bytes()
        with self.assertRaisesRegex(SaveConflict, '身份'):
            perform_local_save_operation({'op':'write-campaign', 'path':rel, 'expectedHash':first['hash'],
                'text':json.dumps({'campaignId':'c2','state':{'campaignId':'c2','maps':[]}})}, self.source.root)
        self.assertEqual(target.read_bytes(), before)
        recovery = list((target.parent/'自动备份').glob('身份保存冲突-*.json'))
        self.assertEqual(len(recovery), 1)
        self.assertEqual(json.loads(recovery[0].read_text('utf-8'))['campaignId'], 'c2')

    def test_save_refuses_conflicting_top_level_and_nested_campaign_identity(self):
        rel = '战役/c1/当前存档.json'
        with self.assertRaisesRegex(ValueError, '身份'):
            perform_local_save_operation({'op':'write-campaign', 'path':rel, 'expectedHash':None,
                'text':json.dumps({'campaignId':'c1','state':{'campaignId':'c2','maps':[]}})}, self.source.root)
        self.assertFalse((self.source.root/rel).exists())

    def test_player_packages_from_before_and_after_transfer_cannot_duplicate_items(self):
        store, resources, pids, pieces, state, bag = self.player_pair()
        before = self.export_pair_member(pids[0], 'sender-before')
        resources.apply(pids[0], 'c1', {'op':'transfer','itemId':bag['items'][0]['id'],
            'characterId':pieces[1]['ownedPieceId'],'quantity':2,'revision':bag['revision'],
            'requestId':'pair-potions-transfer'}, True, state=state)
        after = self.export_pair_member(pids[1], 'recipient-after')
        self.assertEqual(sum(i['quantity'] for pid in pids for i in resources.read(pid)['items']), 2)
        for order in ((before, after), (after, before)):
            with self.subTest(first=order[0].name):
                runtime = ModuleRuntime(self.root/('mixed-'+order[0].stem), self.root/'app')
                self.import_player(runtime, order[0]); baseline = self.player_data(runtime)
                with self.assertRaisesRegex(RevisionConflict, '背包版本'):
                    self.import_player(runtime, order[1])
                self.assertEqual(self.player_data(runtime), baseline)

    def test_players_and_progress_from_one_snapshot_import_with_conserved_quantity(self):
        store, resources, pids, pieces, state, bag = self.player_pair()
        resources.apply(pids[0], 'c1', {'op':'transfer','itemId':bag['items'][0]['id'],
            'characterId':pieces[1]['ownedPieceId'],'quantity':2,'revision':bag['revision'],
            'requestId':'same-batch-transfer'}, True, state=state)
        perform_local_save_operation({'op':'write-campaign','path':'战役/c1/当前存档.json',
            'text':json.dumps({'campaignId':'c1','state':state}), 'expectedHash':None}, self.source.root)
        players = [self.export_pair_member(pid, 'same-batch-'+str(i)) for i,pid in enumerate(pids)]
        progress = self.root/'same-batch-progress.sundoll'
        pm = self.source.export_campaign('c1', 'campaign-progress', progress)
        snapshots = [self.source.packages.inspect(path)[1]['resourceSnapshot'] for path in [*players,progress]]
        self.assertEqual(snapshots[0], snapshots[1]); self.assertEqual(snapshots[1], snapshots[2])
        for player_first in (True, False):
            runtime = ModuleRuntime(self.root/('same-batch-'+str(player_first)), self.root/'app')
            runtime.packages.install(progress)
            if not player_first: runtime.create_run(pm['moduleId'], 'same-batch-progress-run')
            for archive in players: self.import_player(runtime, archive)
            if player_first: runtime.create_run(pm['moduleId'], 'same-batch-progress-run')
            destination = ResourceStore(profiles.Store(runtime.root,runtime.app,self.root/'batch-cache'), profiles)
            self.assertEqual(sum(i['quantity'] for pid in pids for i in destination.read(pid)['items']), 2)

    def test_legacy_single_player_package_is_readable_and_retry_remains_idempotent(self):
        _, _, pids, _, _, _ = self.player_pair()
        for no_snapshot in (False, True):
            archive = self.export_pair_member(pids[0], 'single-legacy-'+str(no_snapshot), legacy=True, no_snapshot=no_snapshot)
            runtime = ModuleRuntime(self.root/('legacy-single-'+str(no_snapshot)), self.root/'app')
            first = self.import_player(runtime, archive); baseline = self.player_data(runtime)
            self.assertEqual(self.import_player(runtime, archive), first)
            self.assertEqual(self.player_data(runtime), baseline)

    def test_legacy_single_progress_package_is_readable_and_retry_remains_idempotent(self):
        snapshot = self.source._transfer_snapshot({'backpacks':{}, 'mapItems':{}})
        snapshot.pop('inventoryHash')
        archive = self.root/'single-legacy-progress.sundoll'
        self.source.packages.export(archive, 'campaign-progress', '旧进度', {
            'state':{'campaignId':'c1','maps':[{'id':'old-map','tokens':[]}]},
            'resourceSnapshot':snapshot}, 'single-legacy-progress')
        self.target.packages.install(archive)
        launch = self.target.create_run('single-legacy-progress', 'single-legacy-progress-run')
        path = self.target.root/'战役/c1/当前存档.json'; before = path.read_bytes()
        self.assertEqual(self.target.create_run('single-legacy-progress', 'single-legacy-progress-run'), launch)
        self.assertEqual(path.read_bytes(), before)

    def test_legacy_same_authority_packages_cannot_be_mixed_without_inventory_version(self):
        _, _, pids, _, _, _ = self.player_pair()
        archives = [self.export_pair_member(pid, 'multiple-legacy-'+str(i), legacy=True) for i,pid in enumerate(pids)]
        self.import_player(self.target, archives[0]); baseline = self.player_data(self.target)
        with self.assertRaisesRegex(RevisionConflict, '同时重新导出'):
            self.import_player(self.target, archives[1])
        self.assertEqual(self.player_data(self.target), baseline)

    def test_legacy_and_new_snapshot_mixing_is_refused_in_both_orders(self):
        _, _, pids, _, _, _ = self.player_pair()
        legacy = self.export_pair_member(pids[0], 'mixed-legacy', legacy=True)
        current = self.export_pair_member(pids[1], 'mixed-current')
        for order in ((legacy,current),(current,legacy)):
            runtime = ModuleRuntime(self.root/('legacy-new-'+order[0].stem), self.root/'app')
            self.import_player(runtime, order[0]); baseline = self.player_data(runtime)
            with self.assertRaisesRegex(RevisionConflict, '同时重新导出'):
                self.import_player(runtime, order[1])
            self.assertEqual(self.player_data(runtime), baseline)

    def test_inventory_snapshot_includes_wallet_and_removed_items_and_ignores_dictionary_order(self):
        data = {'backpacks':{'p1':{'wallets':{'gold':{'copper':10}},'removedItems':[], 'items':[]}}, 'mapItems':{}}
        first = self.source._transfer_snapshot(data)
        shuffled = {'mapItems':{}, 'backpacks':{'p1':{'items':[], 'removedItems':[], 'wallets':{'gold':{'copper':10}}}}}
        self.assertEqual(first, self.source._transfer_snapshot(shuffled))
        changed = copy.deepcopy(data); changed['backpacks']['p1']['wallets']['gold']['copper'] = 9
        self.assertNotEqual(first['inventoryHash'], self.source._transfer_snapshot(changed)['inventoryHash'])
        changed = copy.deepcopy(data); changed['backpacks']['p1']['removedItems'].append({'item':{'id':'example'}})
        self.assertNotEqual(first['inventoryHash'], self.source._transfer_snapshot(changed)['inventoryHash'])

    def test_two_progress_packages_from_one_snapshot_do_not_confuse_campaigns_with_players(self):
        for cid in ('c1','c2'):
            perform_local_save_operation({'op':'write-campaign','path':'战役/'+cid+'/当前存档.json',
                'text':json.dumps({'campaignId':cid,'state':{'campaignId':cid,'maps':[]}}),
                'expectedHash':None}, self.source.root)
            archive = self.root/(cid+'-progress.sundoll')
            manifest = self.source.export_campaign(cid, 'campaign-progress', archive)
            self.target.packages.install(archive)
            launch = self.target.create_run(manifest['moduleId'], 'multiple-progress-'+cid)
            self.assertEqual(launch['campaignId'], cid)
        self.assertEqual({record['id'] for record in campaign_catalog(self.target.root)}, {'c1','c2'})


if __name__ == '__main__':
    unittest.main()
