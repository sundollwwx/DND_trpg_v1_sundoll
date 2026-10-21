import json
import tempfile
import unittest
from pathlib import Path
from test_player_profiles import SERVER
from server.module_runtime import ModuleRuntime
from server import player_profiles


class MigrationSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=ModuleRuntime(self.root/'source',self.root/'app')
        self.target=ModuleRuntime(self.root/'target',self.root/'empty-app')
        self.source.ensure_empty_runtime();self.target.ensure_empty_runtime()
        self.original=player_profiles.Store(self.source.root,self.source.app,self.root/'cache')
        self.profile=self.original.create('原玩家')['profile']
        self.original.grant(self.profile['playerId'],dict(name='原角色',hpMax=25,ac=14),'migration-original-hero')
        progress=self.root/'progress.sundoll'
        player_profiles.atomic(self.source.root/'战役/c-original/当前存档.json',dict(campaignId='c-original',campaignName='原战役',savedAt=1,state=dict(campaignId='c-original',maps=[],gmNote='private GM note')))
        self.progress_source=self.source.export_campaign('c-original','campaign-progress',progress)
        self.target.packages.install(progress)
        player=self.root/'player.sundoll'
        self.player_source=self.source.export_player(self.profile['playerId'],player)
        self.target.packages.install(player)

    def test_installed_sources_are_pending_until_actual_campaign_and_player_publish(self):
        pending=SERVER.migration_snapshot(self.target)
        self.assertEqual(pending['campaigns'],[]);self.assertEqual(pending['profiles'],[])
        self.assertEqual({entry['state'] for entry in pending['sources']},{'pending'})
        self.target.create_run(self.progress_source['moduleId'],'migration-progress-request')
        self.target.activate_player(self.player_source['moduleId'])
        ready=SERVER.migration_snapshot(self.target)
        self.assertEqual(ready['campaigns'][0]['id'],'c-original')
        self.assertTrue(ready['campaigns'][0]['importedProgress'])
        self.assertEqual(ready['profiles'][0]['playerId'],self.profile['playerId'])
        self.assertTrue(ready['profiles'][0]['imported'])
        self.assertNotIn('accountId',ready['profiles'][0])
        self.assertEqual({entry['state'] for entry in ready['sources']},{'ready'})
        text=json.dumps(ready)
        self.assertNotIn('private GM note',text);self.assertNotIn(str(self.root),text)
        self.assertNotIn('digest',text);self.assertNotIn('credential',text)

    def test_binding_and_removal_status_are_read_from_current_profile_files(self):
        self.target.activate_player(self.player_source['moduleId'])
        target=player_profiles.Store(self.target.root,self.target.app,self.root/'target-cache')
        path=target.path(self.profile['playerId'],'当前档案.json')
        player_profiles.atomic(path,dict(target.read(self.profile['playerId']),accountId='a'+'1'*32))
        snapshot=SERVER.migration_snapshot(self.target)
        self.assertEqual(snapshot['profiles'][0]['accountId'],'a'+'1'*32)
        before=path.read_bytes();SERVER.migration_snapshot(self.target);self.assertEqual(path.read_bytes(),before)
        with self.assertRaises(player_profiles.ProfileError) as caught:
            target.delete(self.profile['playerId'])
        self.assertEqual(caught.exception.status,409)
        self.assertEqual(path.read_bytes(),before)
        unbound=target.read(self.profile['playerId']);unbound.pop('accountId',None)
        player_profiles.atomic(path,unbound)
        target.delete(self.profile['playerId'])
        snapshot=SERVER.migration_snapshot(self.target)
        self.assertEqual(snapshot['profiles'],[])
        self.assertEqual(next(source for source in snapshot['sources'] if source['kind']=='player')['state'],'pending')
