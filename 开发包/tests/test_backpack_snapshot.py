from project_test_paths import APP_ROOT
import copy
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from server import player_profiles as profiles
from server.backpack_service import prepare_backpack_request
from server.module_runtime import ModuleRuntime
from server.resource_database import ResourceDatabase
from server.resources import ResourceStore
from server.workspace import enable


class BackpackSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.save = enable(self.root)
        self.runtime = ModuleRuntime(self.save, APP_ROOT); self.runtime.ensure_empty_runtime()
        self.store = profiles.Store(self.save, APP_ROOT, self.root/'cache')
        self.pid = self.store.create('目标玩家')['profile']['playerId']
        self.other = self.store.create('其他玩家')['profile']['playerId']
        self.piece = self.store.grant(self.pid, dict(name='旅行者',type='pc',hpMax=24), 'snapshot-hero-0001')['pieces'][0]
        self.other_piece = self.store.grant(self.other, dict(name='远处角色',type='pc',hpMax=30), 'snapshot-hero-0002')['pieces'][0]
        self.state = dict(campaignId='active', maps=[])
        with self.runtime.store.transaction() as db:
            for index in range(5):
                self.runtime.store.write_document(db, 'runtime-map', 'inactive-'+str(index), 'inactive-'+str(index), {}, 0)
        self.resources = ResourceStore(self.store, profiles)

    def request(self, host=False):
        return prepare_backpack_request(self.store, profiles, self.pid,
            dict(op='get',campaignId='active'),self.state,host,
            lambda state,public: [],lambda state: None)

    def test_get_reads_one_scoped_snapshot_without_inactive_map_or_other_bag(self):
        original = ResourceDatabase.read_for_backpack; snapshots = []
        def counted(database, *args, **kwargs):
            value = original(database, *args, **kwargs); snapshots.append(copy.deepcopy(value)); return value
        with mock.patch.object(ResourceDatabase,'read',side_effect=AssertionError('full ledger read')), \
             mock.patch.object(ResourceDatabase,'read_for_backpack',counted):
            result, changed, updates = self.request()
        self.assertEqual(len(snapshots),1)
        self.assertEqual(snapshots[0]['mapItems'],{})
        self.assertNotIn(self.other,snapshots[0]['backpacks'])
        self.assertNotIn(self.other_piece['ownedPieceId'],snapshots[0]['characters']['@global'])
        self.assertEqual([c['id'] for c in result['characters']],[self.piece['ownedPieceId']])
        self.assertFalse(changed); self.assertEqual(updates,[])
        self.assertEqual(len(ResourceDatabase(self.save).read()['mapItems']),5)

    def test_host_keeps_all_character_recipients_without_loading_map_loot(self):
        result, _, _ = self.request(True)
        self.assertEqual({c['id'] for c in result['recipients']},
            {self.piece['ownedPieceId'],self.other_piece['ownedPieceId']})
        self.assertEqual(self.resources.backpack_ledger(self.pid,self.state,True)['mapItems'],{})

    def test_hidden_other_character_is_reconciled_but_never_exposed_to_player(self):
        token=dict(self.other_piece,id='map-other',hp=-999,characterRevision=0,hiddenFromPlayers=True)
        self.state['maps']=[dict(id='secret',playerAccessible=False,tokens=[token])]
        result, _, _ = self.request()
        self.assertNotIn(self.other_piece['ownedPieceId'],[c['id'] for c in result['characters']])
        self.assertEqual(token['hp'],30)
        self.assertEqual(self.resources.character('active',self.other_piece['ownedPieceId'])['runtime']['hp'],30)

    def test_partial_reconciliation_cannot_delete_other_player_or_campaign_records(self):
        before=ResourceDatabase(self.save).read()
        self.request()
        after=ResourceDatabase(self.save).read()
        self.assertEqual(before['mapItems'],after['mapItems'])
        self.assertEqual(before['characters']['@global'][self.other_piece['ownedPieceId']],
                         after['characters']['@global'][self.other_piece['ownedPieceId']])
