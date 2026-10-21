"""Recovery tests operate exclusively on temporary, isolated workspaces."""
from project_test_paths import APP_ROOT
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from server import campaign_recovery as recovery, player_profiles
from server.module_store import ModuleStore
from server.resource_database import ResourceDatabase
from server.resources import ResourceStore
from server.workspace import enable


class CampaignRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root)
        self.source_id = '战役/c1-旧战役/自动备份/保存冲突-1700000000000.json'
        self.original = dict(campaignId='c1', campaignName='旧战役', savedAt=1700000000000,
            state=dict(campaignId='c1', campaignName='旧战役', maps=[dict(id='m1', name='旧地图', tokens=[dict(id='t1', name='怪物', hp=12)])],
                       activeMapId='m1', presentedMapId='m1', prepHandbook=[{'title':'备团内容'}],
                       combatQuickCards=[{'name':'速查卡'}], journal={'campaignId':'c1','entries':[{'id':'j1','text':'原日志'}]},
                       encounter={'worldTime':{'totalSeconds':120,'runningSince':1}}))
        self.write_source(self.original)

    def path(self, identity=None):
        return self.root / '战役包' / Path(identity or self.source_id).relative_to('战役')

    def write_source(self, value, identity=None):
        path = self.path(identity)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), 'utf-8')
        return path

    def hash(self, identity=None):
        return hashlib.sha256(self.path(identity).read_bytes()).hexdigest()

    def copy_point(self, **fields):
        command = dict(op='recovery-copy', recoveryId=self.source_id,
                       expectedHash=self.hash(), requestId='recovery-request-001')
        command.update(fields)
        return recovery.perform_campaign_recovery_operation(command, self.save)

    def stored(self, result):
        return json.loads(self.path(result['path']).read_text('utf-8'))

    def rows(self):
        db = ModuleStore(self.save).connect()
        try:
            return list(map(tuple, db.execute("SELECT kind,id,owner,revision,payload FROM documents WHERE kind IN ('runtime-character','runtime-backpack','runtime-map','player-library','runtime-meta') ORDER BY kind,id")))
        finally:
            db.close()

    def activate_owned(self):
        profiles = player_profiles.Store(self.save, APP_ROOT, self.root/'cache')
        pid = profiles.create('甲')['profile']['playerId']
        lib = profiles.grant(pid, dict(name='当前战士', hpMax=30, ac=15), 'grant-character-001')
        oid = lib['pieces'][0]['ownedPieceId']
        char = dict(id=oid, ownerPlayerId=pid, name='当前战士', revision=100,
                    base=dict(hpMax=30, ac=15, level=1), runtime=dict(hp=7, tempHp=2, tempHpMax=2,
                    conditions=[{'name':'当前状态'}], spellSlots={'1':{'remaining':1,'max':3}}))
        ledger = dict(version=1, revision=0, globalCharacters=True, characters={'@global':{oid:char}},
                      backpacks={}, mapItems={'c1':{'m1':{'revision':4,'markers':[],'receipts':{}}}})
        ResourceDatabase(self.save).activate(ledger, {pid:lib}, {'test':'recovery-owned'})
        self.original['state']['maps'][0]['tokens'][0].update(ownedPieceId=oid, ownerPlayerId=pid,
            name='旧战士', hp=1, hpMax=30, ac=15, characterRevision=100, conditions=[], spellSlots={})
        self.write_source(self.original)
        return pid, oid, char

    def test_list_reads_all_categories_without_opening_store(self):
        second = self.source_id.replace('保存冲突-1700000000000', '读取前恢复点-1700000000001')
        third = self.source_id.replace('保存冲突-1700000000000', '1700000000002')
        self.write_source(self.original, second)
        self.write_source(self.original, third)
        with mock.patch.object(ModuleStore, 'connect', side_effect=AssertionError('read wrote store')):
            result = recovery.list_recovery_points(self.save)
            self.assertEqual({r['reason'] for r in result['records']}, {'保存冲突','读取前恢复点','自动备份'})
            self.assertTrue(all(r['valid'] and r['mapCount']==1 and r['sha256'] for r in result['records']))
            self.assertEqual(result['warnings'], [])
            recovery.read_recovery_point(self.source_id, self.hash(), self.save)

    def test_list_explicitly_reports_corrupt_and_duplicate_identity_records(self):
        bad = self.source_id.replace('保存冲突-', '损坏-')
        self.path(bad).write_text('{ broken', 'utf-8')
        self.original['state']['maps'].append(copy.deepcopy(self.original['state']['maps'][0]))
        self.write_source(self.original)
        result = recovery.list_recovery_points(self.save)
        self.assertEqual(len(result['records']), 2)
        self.assertTrue(all(not r['valid'] and r['warnings'] and r['sha256'] for r in result['records']))

    def test_corrupt_utf8_json_can_be_viewed_but_not_copied(self):
        self.path().write_text('{ broken', 'utf-8')
        result = recovery.read_recovery_point(self.source_id, self.hash(), self.save)
        self.assertEqual(result['text'], '{ broken')
        self.assertFalse(result['record']['valid'])
        with self.assertRaises(recovery.CampaignRecoveryError):
            self.copy_point()
        self.assertFalse((self.save/'模块存储/模块.sqlite3').exists())

    def test_source_hash_is_required_and_change_is_conflict(self):
        digest = self.hash()
        self.path().write_text('{}', 'utf-8')
        with self.assertRaises(recovery.CampaignRecoveryError) as caught:
            recovery.read_recovery_point(self.source_id, digest, self.save)
        self.assertEqual(caught.exception.status, 409)
        for value in (None, '', 'x'*64):
            with self.subTest(value=value), self.assertRaises(recovery.CampaignRecoveryError):
                recovery.read_recovery_point(self.source_id, value, self.save)

    def test_allowlist_rejects_traversal_current_saves_absolute_and_other_workspaces(self):
        for path in ('../outside.json', '/tmp/file.json', '战役/c1/当前存档.json',
                     '战役/c1/自动备份/../当前存档.json', '战役/c1/自动备份/a/b.json',
                     '玩家包/p1/自动备份/a.json', '战役\\c1\\自动备份\\a.json'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                recovery.read_recovery_point(path, self.hash(), self.save)

    def test_symbolic_links_are_warned_and_never_followed(self):
        outside = self.root/'outside.json'
        outside.write_text(json.dumps(self.original), 'utf-8')
        linked = self.source_id.replace('保存冲突-', '链接-')
        self.path(linked).symlink_to(outside)
        folder = self.root/'战役包/链接战役'
        folder.symlink_to(self.path().parent.parent, target_is_directory=True)
        result = recovery.list_recovery_points(self.save)
        self.assertFalse(next(r for r in result['records'] if r['id']==linked)['valid'])
        self.assertTrue(result['warnings'])
        with self.assertRaises(ValueError):
            recovery.read_recovery_point(linked, hashlib.sha256(outside.read_bytes()).hexdigest(), self.save)

    def test_nonregular_file_is_not_read(self):
        identity = self.source_id.replace('保存冲突-', '目录-')
        self.path(identity).mkdir()
        result = recovery.list_recovery_points(self.save)
        self.assertFalse(next(r for r in result['records'] if r['id']==identity)['valid'])

    def test_size_limit_is_enforced(self):
        with mock.patch.object(recovery, 'MAX_RECOVERY_BYTES', 3):
            result = recovery.list_recovery_points(self.save)
            self.assertFalse(result['records'][0]['valid'])
            with self.assertRaises(recovery.CampaignRecoveryError) as caught:
                recovery.read_recovery_point(self.source_id, self.hash(), self.save)
            self.assertEqual(caught.exception.status, 413)

    def test_copy_keeps_original_and_current_campaign_bytes_and_retargets_journal(self):
        current = self.path().parent.parent/'当前存档.json'
        current.write_text(json.dumps(self.original), 'utf-8')
        before, current_before = self.path().read_bytes(), current.read_bytes()
        result = self.copy_point()
        document = self.stored(result)
        self.assertNotEqual(result['campaignId'], 'c1')
        self.assertIn('恢复副本', result['campaignName'])
        self.assertEqual(document['state']['journal']['campaignId'], result['campaignId'])
        self.assertEqual(document['state']['journal']['entries'], self.original['state']['journal']['entries'])
        self.assertEqual(document['state']['prepHandbook'], self.original['state']['prepHandbook'])
        self.assertEqual(document['state']['combatQuickCards'], self.original['state']['combatQuickCards'])
        self.assertIsNone(document['state']['encounter']['worldTime']['runningSince'])
        self.assertEqual(self.path().read_bytes(), before)
        self.assertEqual(current.read_bytes(), current_before)
        self.assertEqual(result['hash'], hashlib.sha256(self.path(result['path']).read_bytes()).hexdigest())

    def test_copy_retry_reuses_identity_and_request_collision_is_rejected(self):
        first = self.copy_point()
        second = self.copy_point()
        self.assertEqual(first['campaignId'], second['campaignId'])
        self.assertTrue(second['reused'])
        with self.assertRaises(recovery.CampaignRecoveryError) as caught:
            self.copy_point(name='另一个副本')
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(len(list((self.root/'战役包').glob('recovery-*/当前存档.json'))), 1)

    def test_modified_or_archived_copy_cannot_be_overwritten_by_retry(self):
        result = self.copy_point()
        target = self.path(result['path'])
        target.write_text('{}', 'utf-8')
        with self.assertRaises(recovery.CampaignRecoveryError):
            self.copy_point()
        self.assertEqual(target.read_text(), '{}')

    def test_copy_uses_current_owned_values_without_touching_resource_records(self):
        pid, oid, char = self.activate_owned()
        before = self.rows()
        result = self.copy_point()
        token = self.stored(result)['state']['maps'][0]['tokens'][0]
        self.assertEqual((token['ownedPieceId'],token['ownerPlayerId']), (oid,pid))
        self.assertEqual((token['hp'],token['characterRevision'],token['name']), (7,100,'当前战士'))
        self.assertEqual(token['conditions'], char['runtime']['conditions'])
        self.assertEqual(token['spellSlots'], char['runtime']['spellSlots'])
        self.assertEqual(self.rows(), before)
        ledger = ResourceDatabase(self.save).read()
        self.assertEqual(set(ledger['mapItems']), {'c1'})
        self.assertNotIn(result['campaignId'], ledger['mapItems'])

    def test_parked_owned_role_uses_current_values(self):
        pid, oid, _ = self.activate_owned()
        token = self.original['state']['maps'][0]['tokens'].pop()
        self.original['state']['parkedOwnedPieces'] = {oid:token}
        self.write_source(self.original)
        result = self.copy_point()
        parked = self.stored(result)['state']['parkedOwnedPieces'][oid]
        self.assertEqual(parked['ownerPlayerId'], pid)
        self.assertEqual(parked['hp'], 7)

    def test_missing_or_mismatched_owned_roles_do_not_create_copy(self):
        self.original['state']['maps'][0]['tokens'][0].update(ownedPieceId='o'+'1'*32, ownerPlayerId='p'+'2'*32)
        self.write_source(self.original)
        with self.assertRaises((recovery.CampaignRecoveryError, player_profiles.ProfileError)):
            self.copy_point()
        self.assertEqual(list((self.root/'战役包').glob('recovery-*/当前存档.json')), [])

    def test_copy_rejects_duplicate_owned_identity_without_dropping_tokens(self):
        self.activate_owned()
        token = copy.deepcopy(self.original['state']['maps'][0]['tokens'][0])
        token['id'] = 't2'
        self.original['state']['maps'][0]['tokens'].append(token)
        self.write_source(self.original)
        before = self.path().read_bytes()
        with self.assertRaises(recovery.CampaignRecoveryError):
            self.copy_point()
        self.assertEqual(self.path().read_bytes(), before)

    def test_copy_legacy_without_identity_and_single_map(self):
        self.write_source(dict(mapData=None,mapW=100,mapH=100,gridSize=10,tokens=[dict(id='old-token',name='旧怪物')]))
        result = self.copy_point()
        document = self.stored(result)
        self.assertEqual(document['state']['maps'][0]['tokens'][0]['id'], 'old-token')
        self.assertEqual(len(result['warnings']), 2)
        self.assertEqual(document['state']['campaignId'], result['campaignId'])

    def test_inner_outer_identity_mismatch_duplicate_json_and_nonfinite_are_invalid(self):
        for raw in ('{"campaignId":"a","state":{"campaignId":"b","maps":[]}}',
                    '{"maps":[],"maps":[]}', '{"maps":[],"hp":NaN}', '{"maps":[],"hp":1e999}'):
            with self.subTest(raw=raw):
                self.path().write_text(raw, 'utf-8')
                self.assertFalse(recovery.list_recovery_points(self.save)['records'][0]['valid'])
                with self.assertRaises(recovery.CampaignRecoveryError):
                    self.copy_point()

    def test_malformed_maps_are_not_silently_converted_to_empty_legacy_map(self):
        self.write_source(dict(mapData=None, maps={'invalid':'would be dropped'}))
        self.assertFalse(recovery.list_recovery_points(self.save)['records'][0]['valid'])
        with self.assertRaises(recovery.CampaignRecoveryError):
            self.copy_point()

    def test_legacy_filesystem_layout_uses_only_its_own_root(self):
        with tempfile.TemporaryDirectory() as other:
            source = Path(other)/self.source_id
            source.parent.mkdir(parents=True)
            source.write_bytes(self.path().read_bytes())
            result = recovery.copy_recovery_point(self.source_id,self.hash(),'legacy-recovery-001',other)
            self.assertTrue((Path(other)/result['path']).is_file())
            self.assertEqual(source.read_bytes(), self.path().read_bytes())

    def test_content_selection_is_copied_without_receipts_or_loot(self):
        store = ModuleStore(self.save)
        with store.transaction() as db:
            store.write_document(db,'content-selection','c1','campaign:c1',
                dict(sourcePackageId='pkg-source',enabledPackageIds=['pkg-source','pkg-general'],receipts={'old':'receipt'}),0)
        result = self.copy_point()
        db = store.connect()
        try:
            policy = store.document(db,'content-selection',result['campaignId'])['data']
            self.assertEqual(policy['enabledPackageIds'], ['pkg-source','pkg-general'])
            self.assertEqual(policy['receipts'], {})
            self.assertEqual(store.document(db,'content-selection','c1')['data']['receipts'], {'old':'receipt'})
        finally:
            db.close()

    def test_takeover_point_uses_full_formal_body_and_preserves_raw_evidence(self):
        identity = '战役/c1-旧战役/自动备份/接管前恢复点-1700000000000000000-abc123.json'
        source = copy.deepcopy(self.original)
        source['_takeoverRecovery'] = dict(formalRecord=copy.deepcopy(self.original),
            rawLiveState=dict(campaignId='c1', maps=[], _sessionId='old-session'), stateRevision=9, sessionId='old-session')
        source['state'].update(_sessionId='old-session', _formalSourceHash='a'*64, _characterRuntime=[])
        self.write_source(source, identity)
        before = self.path(identity).read_bytes()
        row = next(r for r in recovery.list_recovery_points(self.save)['records'] if r['id']==identity)
        self.assertEqual(row['reason'], '接管前恢复点')
        self.assertTrue(any('rawLiveState' in w for w in row['warnings']))
        viewed = recovery.read_recovery_point(identity, self.hash(identity), self.save)
        self.assertEqual(json.loads(viewed['text'])['_takeoverRecovery'], source['_takeoverRecovery'])
        result = self.copy_point(recoveryId=identity, expectedHash=self.hash(identity))
        document = self.stored(result)
        self.assertEqual(document['state']['prepHandbook'], self.original['state']['prepHandbook'])
        self.assertEqual(len(document['state']['maps']), 1)
        self.assertNotIn('_sessionId', document['state'])
        self.assertNotIn('_formalSourceHash', document['state'])
        self.assertNotIn('_characterRuntime', document['state'])
        self.assertNotIn('_takeoverRecovery', document)
        self.assertEqual(document['recovery']['sourceRecoveryId'], identity)
        self.assertEqual(self.path(identity).read_bytes(), before)

    def test_summary_failure_reports_saved_copy_and_retry_reuses_it(self):
        with mock.patch.object(recovery,'cache_campaign_summary',side_effect=OSError('summary failed')):
            result = self.copy_point()
        self.assertTrue(self.path(result['path']).is_file())
        self.assertTrue(any('副本已保存' in w for w in result['warnings']))
        self.assertTrue(self.copy_point()['reused'])

    def test_interrupted_publication_is_resumed_by_same_request(self):
        real = recovery.recover_campaign_projection
        def fail_after_commit(root, rel):
            db = ModuleStore(root).connect()
            try:
                if ModuleStore.document(db,'campaign-pending',rel):
                    raise OSError('publication interrupted')
            finally:
                db.close()
            return real(root, rel)
        with mock.patch.object(recovery,'recover_campaign_projection',side_effect=fail_after_commit):
            with self.assertRaises(OSError):
                self.copy_point()
        result = self.copy_point()
        self.assertTrue(result['reused'])
        self.assertTrue(self.path(result['path']).is_file())
        self.assertEqual(len(list((self.root/'战役包').glob('recovery-*/当前存档.json'))), 1)

    def test_failed_commit_rolls_back_documents_and_never_publishes_copy(self):
        original_write = ModuleStore.write_document
        def fail(db, kind, *args):
            if kind == 'campaign-pending':
                raise OSError('disk full')
            return original_write(db, kind, *args)
        with mock.patch.object(ModuleStore,'write_document',side_effect=fail):
            with self.assertRaises(OSError):
                self.copy_point()
        self.assertEqual(list((self.root/'战役包').glob('recovery-*/当前存档.json')), [])
        result = self.copy_point()
        self.assertFalse(result['reused'])

    def test_workspaces_are_independent_even_with_same_request_and_source_path(self):
        first = self.copy_point()
        with tempfile.TemporaryDirectory() as other:
            save = enable(other)
            path = Path(other)/'战役包'/Path(self.source_id).relative_to('战役')
            path.parent.mkdir(parents=True)
            path.write_bytes(self.path().read_bytes())
            second = recovery.copy_recovery_point(self.source_id,self.hash(),'recovery-request-001',save)
            self.assertNotEqual(first['campaignId'],second['campaignId'])
            self.assertEqual(len(recovery.list_recovery_points(save)['records']),1)

    def test_bad_commands_and_names_are_rejected(self):
        for command in (None, {}, {'op':'not-recovery'}):
            with self.subTest(command=command), self.assertRaises(recovery.CampaignRecoveryError):
                recovery.perform_campaign_recovery_operation(command,self.save)
        for fields in ({'requestId':'short'}, {'name':''}, {'name':'\x00'}, {'name':123}):
            with self.subTest(fields=fields), self.assertRaises(recovery.CampaignRecoveryError):
                self.copy_point(**fields)


if __name__ == '__main__':
    unittest.main()
