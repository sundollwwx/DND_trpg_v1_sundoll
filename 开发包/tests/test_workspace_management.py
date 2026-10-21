from project_test_paths import APP_ROOT
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0,str(APP_ROOT))
from server.workspace import enable,read_catalog,write_catalog
from server.module_runtime import ModuleRuntime
from server.module_store import RevisionConflict
from server.module_management import apply_general,set_archived,overview
from server.workspace_backup import Backups,recover_pending,epoch
from server import player_profiles as profiles
from server.save_storage import perform_local_save_operation


class WorkspaceManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.save=enable(self.root)
        self.runtime=ModuleRuntime(self.save,APP_ROOT);self.runtime.ensure_empty_runtime()
        write_catalog(self.save,'template',dict(format='sangduoer-library',schemaVersion=1,presets=[]))
        self.payload={'templates':[dict(id='a',name='守卫',category='通用生物/人形',hpMax=10),dict(id='b',name='狼',category='通用生物/野兽',hpMax=11)],'items':[]}
        self.package=self.root/'test.sundoll'

    def install(self,payload,expected=None):
        self.runtime.packages.export(self.package,'general','测试通用',payload,'test-general')
        return self.runtime.packages.install(self.package,expected)

    def test_update_preserves_local_edit_and_removal_then_uninstall_is_reversible(self):
        first=self.install(self.payload);apply_general(self.runtime,'test-general')
        data=read_catalog(self.save,'template');data['presets'][0]['hpMax']=99;write_catalog(self.save,'template',data)
        updated=copy.deepcopy(self.payload);updated['templates'][0]['hpMax']=20;updated['templates'][1]['hpMax']=21
        with self.assertRaises(RevisionConflict):self.install(updated)
        self.install(updated,first['dataHash']);result=apply_general(self.runtime,'test-general')
        self.assertEqual(len(result['kept']),1)
        values={p['name']:p['hpMax'] for p in read_catalog(self.save,'template')['presets']}
        self.assertEqual(values,{'守卫':99,'狼':21})
        set_archived(self.runtime,'test-general',True)
        self.assertEqual([p['name'] for p in read_catalog(self.save,'template')['presets']],['守卫'])
        self.assertTrue(self.runtime.packages.catalog()[0]['archived'])
        with self.assertRaises(ValueError):apply_general(self.runtime,'test-general')
        set_archived(self.runtime,'test-general',False);apply_general(self.runtime,'test-general')
        self.assertEqual(len(read_catalog(self.save,'template')['presets']),2)

    def test_catalog_update_transaction_rolls_back_together(self):
        self.install(self.payload)
        import server.module_management as mm
        original=mm.write_catalog
        def fail(root,kind,data,db=None):
            if kind=='item-template':raise OSError('full disk')
            return original(root,kind,data,db)
        with mock.patch.object(mm,'write_catalog',side_effect=fail):
            with self.assertRaises(OSError):apply_general(self.runtime,'test-general')
        self.assertEqual(read_catalog(self.save,'template')['presets'],[])

    def test_backup_restores_players_auth_assets_and_removes_later_content(self):
        store=profiles.Store(self.save,APP_ROOT,self.root/'cache')
        p=store.create('旅人');pid=p['profile']['playerId'];store.grant(pid,dict(name='勇者',hpMax=20,ac=12),'test-grant-000001')
        auth=(self.root/'运行数据/认证'/ (pid+'.json'))
        auth_before={p.name:p.read_bytes() for p in auth.parent.iterdir() if p.is_file()}
        self.runtime.store.put_asset(b'image','image/png','test')
        backup=Backups(self.save);b=backup.create()
        self.install(self.payload);apply_general(self.runtime,'test-general')
        (self.root/'战役包/后来').mkdir();(self.root/'战役包/后来/新.json').write_text('{}')
        staged=backup.stage_restore(b['id']);self.assertTrue(staged['rollbackId'])
        self.assertTrue(recover_pending(self.save));self.assertFalse(recover_pending(self.save))
        self.assertTrue(epoch(self.save));self.assertFalse((self.root/'战役包/后来').exists())
        self.assertEqual(read_catalog(self.save,'template')['presets'],[])
        self.assertEqual(auth_before,{p.name:p.read_bytes() for p in auth.parent.iterdir() if p.is_file()})
        self.assertEqual(len(store.library(pid)['pieces']),1)

    def test_corrupt_backup_is_rejected_before_staging(self):
        backup=Backups(self.save);b=backup.create();p=backup.path(b['id'])/'数据/运行数据/存档/工作区.json';p.write_text('{}')
        with self.assertRaises(ValueError):backup.stage_restore(b['id'])
        self.assertFalse(backup.journal.exists())

    def test_export_import_archive_and_path_attack(self):
        import zipfile
        backup=Backups(self.save);b=backup.create();dest=self.root/'backup.zip';backup.export(b['id'],dest)
        imported=backup.import_archive(dest);self.assertNotEqual(imported['id'],b['id'])
        with zipfile.ZipFile(dest,'a') as out:out.writestr('数据/../escape','bad')
        with self.assertRaises(ValueError):backup.import_archive(dest)
        self.assertFalse((self.root/'escape').exists())

    def test_interrupted_restore_after_new_directory_move_is_replayed(self):
        backup=Backups(self.save);b=backup.create();backup.stage_restore(b['id'])
        from server import workspace_backup as wb
        original=wb.atomic_json
        def fail(path,value):
            if '/完成/' in str(path):raise OSError('power loss')
            return original(path,value)
        with mock.patch.object(wb,'atomic_json',side_effect=fail):
            with self.assertRaises(OSError):recover_pending(self.save)
        self.assertTrue(recover_pending(self.save));self.assertTrue((self.save/'工作区.json').exists())
        self.assertEqual(read_catalog(self.save,'template')['presets'],[])

    def test_overview_has_actual_players_and_campaigns(self):
        store=profiles.Store(self.save,APP_ROOT,self.root/'cache');store.create('玩家')
        data=dict(campaignId='c1',campaignName='冒险',state=dict(campaignId='c1',maps=[]))
        perform_local_save_operation(dict(op='write-campaign',path='战役/c1/当前存档.json',text=json.dumps(data),expectedHash=None),self.save)
        r=overview(self.runtime);self.assertEqual(r['players'][0]['name'],'玩家');self.assertEqual(r['campaigns'][0]['id'],'c1')

    def test_library_cas_blocks_reintroducing_uninstalled_templates(self):
        self.install(self.payload);apply_general(self.runtime,'test-general')
        old=perform_local_save_operation(dict(op='read',path='棋子库/棋子库.json'),self.save)
        set_archived(self.runtime,'test-general',True)
        from server.save_storage import SaveConflict
        with self.assertRaises(SaveConflict):
            perform_local_save_operation(dict(op='write',path='棋子库/棋子库.json',text=old['text'],catalogHash=old['catalogHash']),self.save)
        self.assertEqual(read_catalog(self.save,'template')['presets'],[])
