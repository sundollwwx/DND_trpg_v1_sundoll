from project_test_paths import APP_ROOT
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
from server.workspace import Workspace, enable, read_catalog, write_catalog
from server.module_store import ModuleStore
from server.module_runtime import ModuleRuntime
from server import player_profiles as profiles
from server.resources import ResourceStore
from server.save_storage import perform_local_save_operation, local_save_target, campaign_catalog


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.package=Path(self.temp.name)/'程序包'
        self.save=enable(self.package,{'c1':'c1-冒险'},{'c1':'冒险'})
        self.app=self.package/'主程序'
        self.runtime=ModuleRuntime(self.save,self.app)
        self.runtime.ensure_empty_runtime()
        self.profiles=profiles.Store(self.save,self.app,self.package/'运行数据/cache')

    def records(self, directory):
        return [json.loads(p.read_text()) for p in directory.glob('记录/*.json')]

    def test_catalog_splits_actual_ownership_and_handles_reclassification(self):
        write_catalog(self.save,'template',{'presets':[{'id':'a','category':'通用生物/龙类'}, {'id':'b','category':'冒险/巢穴'}]})
        self.assertEqual(len(read_catalog(self.save,'template')['presets']),2)
        campaign=self.package/'战役包/c1-冒险'
        self.assertEqual([r['id'] for r in self.records(campaign)],['b'])
        self.assertFalse((self.save/'棋子库/棋子库.json').exists())
        write_catalog(self.save,'template',{'presets':[{'id':'b','category':'通用生物/龙类'}]})
        self.assertEqual(self.records(campaign),[])
        self.assertEqual([t['id'] for t in read_catalog(self.save,'template')['presets']],['b'])

    def test_player_auth_is_outside_player_package_and_shared_state_survives(self):
        player=self.profiles.create('旅人');pid=player['profile']['playerId']
        piece=self.profiles.grant(pid,{'name':'角色','hpMax':30},'create-character-v4')['pieces'][0]
        oid=piece['ownedPieceId']
        resources=ResourceStore(self.profiles,profiles)
        first={'campaignId':'c1','maps':[{'id':'m','tokens':[dict(piece,id='t',hp=7)]}]}
        resources.reconcile(first,accept_changes=True)
        second={'campaignId':'c2','maps':[{'id':'n','tokens':[dict(piece,id='u')]}]}
        resources.reconcile(second)
        self.assertEqual(second['maps'][0]['tokens'][0]['hp'],7)
        self.assertTrue((self.profiles.path(pid,'当前档案.json')).exists())
        self.assertTrue((self.package/'运行数据/认证'/(pid+'.json')).exists())
        self.assertFalse(list((self.package/'玩家包').rglob('认证')))
        record=next(r for r in self.records(self.profiles.path(pid,'当前档案.json').parent) if r['kind']=='runtime-character')
        self.assertEqual((record['id'],record['data']['runtime']['hp']),(oid,7))

    def test_campaign_paths_remain_virtual_but_files_live_in_campaign_module(self):
        rel='战役/c1-冒险/当前存档.json'
        data={'campaignId':'c1','campaignName':'冒险','state':{'campaignId':'c1','maps':[]}}
        result=perform_local_save_operation(dict(op='write-campaign',path=rel,text=json.dumps(data),expectedHash=None),self.save)
        self.assertTrue(result['ok'])
        self.assertTrue((self.package/'战役包/c1-冒险/当前存档.json').exists())
        self.assertFalse((self.save/'战役').exists())
        self.assertEqual(campaign_catalog(self.save)[0]['_path'],rel)
        for attack in ('战役/../../玩家包/x.json','战役/c1/../a.json'):
            with self.assertRaises(ValueError):local_save_target(attack,'read',self.save)

    def test_failed_publication_recovers_committed_update_before_next_read(self):
        store=ModuleStore(self.save)
        with mock.patch('server.workspace.atomic_json',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                with store.transaction() as db:
                    store.write_document(db,'runtime-backpack','p1','p1',{'items':[1]},0)
        # The SQLite commit succeeded and its outbox is retained. Read triggers replay.
        db=store.connect()
        try:
            self.assertEqual(store.document(db,'runtime-backpack','p1')['data']['items'],[1])
            self.assertEqual(db.execute('SELECT count(*) FROM module_outbox').fetchone()[0],0)
        finally:db.close()
        self.assertEqual(self.records(self.package/'玩家包/p1')[0]['data']['items'],[1])

    def test_original_media_is_owned_and_lookup_works_without_staging_copy(self):
        store=ModuleStore(self.save)
        url=store.put_asset(b'image-original','image/png','test')
        digest=url.rsplit('/',1)[1]
        with store.transaction() as db:store.write_document(db,'runtime-backpack','p1','p1',{'image':url},0)
        (store.assets/digest[:2]/digest).unlink()
        self.assertEqual(store.asset(digest)[0].read_bytes(),b'image-original')
        self.assertIn('/玩家包/p1/资源/',str(store.asset(digest)[0]))

    def test_newly_uploaded_cached_map_can_be_exported_from_runtime_directory(self):
        import hashlib
        raw=b'\x89PNG\r\n\x1a\nnew-upload'
        digest=hashlib.sha256(raw).hexdigest()
        directory=self.package/'运行数据/.sundoll-cache/联机资源'
        directory.mkdir(parents=True)
        (directory/digest).write_bytes(raw)
        portable=self.runtime.packages.portable({'mapData':'/api/assets/'+digest},'campaign:c1')
        self.assertEqual(portable['mapData'],'/api/module-assets/'+digest)

    def test_portable_import_still_creates_independent_campaign_modules(self):
        package=self.package/'test.sundoll'
        self.runtime.packages.export(package,'campaign-content','冒险',{'state':{'maps':[{'id':'m','tokens':[]}]},'templates':[{'id':'npc','category':'原战役/洞穴'}]},'adventure')
        self.runtime.packages.install(package)
        a=self.runtime.create_run('adventure','request-first-run')
        b=self.runtime.create_run('adventure','request-other-run')
        self.assertNotEqual(a['campaignId'],b['campaignId'])
        self.assertEqual(len(campaign_catalog(self.save)),2)
        self.assertTrue((self.package/'战役包'/a['campaignId']/'当前存档.json').exists())
        from server.content_packages import ContentPackages
        content=ContentPackages(self.save)
        source=content.context(a['campaignId'])['sourcePackageId']
        self.assertEqual(source,content.context(b['campaignId'])['sourcePackageId'])
        self.assertTrue(any(r['kind']=='content-selection' for r in self.records(self.package/'战役包'/a['campaignId'])))
        self.assertEqual(len(read_catalog(self.save,'template')['presets']),1)
        self.assertEqual(read_catalog(self.save,'template')['presets'][0]['contentPackageId'],source)

    def test_module_symlink_is_rejected_before_write(self):
        (self.package/'玩家包/evil').symlink_to(Path(self.temp.name),target_is_directory=True)
        store=ModuleStore(self.save)
        with self.assertRaises(ValueError):
            with store.transaction() as db:store.write_document(db,'runtime-backpack','evil','evil',{},0)
        self.assertFalse((Path(self.temp.name)/'记录').exists())

    def test_modules_rebuild_missing_coordinator_without_losing_identity_or_inventory(self):
        from server.workspace_recovery import rebuild
        player=self.profiles.create('旅人');pid=player['profile']['playerId']
        piece=self.profiles.grant(pid,{'name':'角色','hpMax':30},'rebuild-character-v4')['pieces'][0]
        before=self.profiles.library(pid)
        resources=ResourceStore(self.profiles,profiles)
        bag,_=resources.apply(pid,'c1',dict(op='grant',characterId=piece['ownedPieceId'],presetId='healing',quantity=2,revision=0,requestId='rebuild-potions-v4'),True)
        bag=resources.read(pid)
        store=ModuleStore(self.save)
        store.database.rename(store.database.with_suffix('.backup'))
        result=rebuild(self.save)
        self.assertGreater(result['documents'],0)
        self.assertEqual(self.profiles.library(pid),before)
        self.assertEqual(ResourceStore(self.profiles,profiles).read(pid),bag)
        self.assertEqual(self.profiles.credential(pid),player['credential'])

    def test_incomplete_module_publication_cannot_be_rebuilt_as_complete(self):
        from server.workspace_recovery import rebuild
        store=ModuleStore(self.save)
        store.database.rename(store.database.with_suffix('.backup'))
        (self.package/'运行数据/模块发布中.json').write_text('{}')
        with self.assertRaises(ValueError):rebuild(self.save)
        self.assertFalse(store.database.exists())

    def test_distribution_starts_from_git_snapshot_without_coordinator(self):
        from server.distribution import initialize
        player = self.profiles.create('旅人'); pid = player['profile']['playerId']
        piece = self.profiles.grant(pid, {'name': '角色', 'hpMax': 30}, 'git-snapshot-character')['pieces'][0]
        resources = ResourceStore(self.profiles, profiles)
        resources.apply(pid, 'c1', dict(op='grant', characterId=piece['ownedPieceId'],
            presetId='healing', quantity=2, revision=0, requestId='git-snapshot-potions'), True)
        before_library, before_bag = self.profiles.library(pid), resources.read(pid)
        store = ModuleStore(self.save)
        store.database.rename(store.database.with_suffix('.backup'))
        self.app.mkdir(parents=True, exist_ok=True)
        (self.app / 'distribution.json').write_text('{"format":4}')
        initialize(self.app, self.save)
        self.assertEqual(self.profiles.library(pid), before_library)
        self.assertEqual(resources.read(pid), before_bag)
        with mock.patch('server.workspace_recovery.rebuild', side_effect=AssertionError('must not replace live DB')):
            initialize(self.app, self.save)

    def test_distribution_refuses_incomplete_git_snapshot(self):
        from server.distribution import initialize
        store = ModuleStore(self.save)
        store.database.rename(store.database.with_suffix('.backup'))
        self.app.mkdir(parents=True, exist_ok=True)
        (self.app / 'distribution.json').write_text('{"format":4}')
        (self.package / '运行数据/模块发布中.json').write_text('{}')
        with self.assertRaises(ValueError):
            initialize(self.app, self.save)
        self.assertFalse(store.database.exists())

    def test_deleted_player_records_follow_archive_without_reviving_account(self):
        player=self.profiles.create('旅人');pid=player['profile']['playerId']
        self.profiles.grant(pid,{'name':'角色','hpMax':30},'archived-character-v4')
        self.profiles.delete(pid)
        self.assertEqual(self.profiles.players(),[])
        self.assertFalse((self.package/'玩家包'/pid).exists())
        db=ModuleStore(self.save).connect()
        try:
            paths=[r[0] for r in db.execute('SELECT path FROM module_records WHERE path LIKE ?',('%'+pid+'%',))]
            self.assertTrue(paths)
            self.assertTrue(all('/已删除/' in p and (self.package/p).exists() for p in paths))
        finally:db.close()


if __name__=='__main__':unittest.main()
