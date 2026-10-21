from project_test_paths import APP_ROOT
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from server.email_accounts import AccountStore, password_digest
from server.campaign_rooms import RoomStore
from server.installation_backup import InstallationBackups, InstallationLease, installation_root
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore
from server.room_checkpoint import RoomCheckpoint, CheckpointConflict
from server.save_storage import ProjectServerLock
from server.workspace import atomic_json, enable
from server.workspace_backup import epoch


class InstallationBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / '程序包'
        self.save = enable(self.root)
        ModuleRuntime(self.save, APP_ROOT).ensure_empty_runtime()
        accounts = AccountStore(self.root / '运行数据/认证', dict(enabled=False))
        RoomStore(accounts)
        self.rids = ['r'+str(index)*32 for index in (1,2,3)]
        with accounts.db() as db:
            db.execute("INSERT INTO accounts(id,email,name,salt,digest,verified,created) VALUES('a','test@example.com','测试','test','test',1,0)")
            for rid in self.rids:
                db.execute('INSERT INTO rooms VALUES (?,?,0)', (rid, '隔离测试'))
                db.execute("INSERT INTO room_members VALUES (?,'a','owner')", (rid,))
        for rid in self.rids[:2]:
            root = self.root / '运行数据/战役空间' / rid
            save = enable(root)
            ModuleRuntime(save,APP_ROOT).ensure_empty_runtime()
            store = ModuleStore(save)
            store.put_asset(('room original '+rid).encode(), 'text/plain', 'test')
            atomic_json(root / '玩家包/test/当前档案.json', dict(playerId='p'+rid, name='测试'))
            atomic_json(root / '运行数据/房间运行状态.json', dict(roomId=rid, test=True))
        atomic_json(self.root / '战役包/original/当前存档.json', dict(campaignId='original', state=dict(maps=[])))
        self.tool = InstallationBackups(self.root)
        self.output = self.home / '完整备份'

    def test_snapshot_contains_all_rooms_original_assets_profiles_and_checkpoint(self):
        report = self.tool.create(self.output)
        self.assertEqual(report['rooms'],3)
        value = json.loads((self.output/'备份清单.json').read_text())
        self.assertEqual([room['materialized'] for room in value['rooms']], [True,True,False])
        names = {item['path'] for item in value['files']}
        for rid in self.rids[:2]:
            prefix = '运行数据/战役空间/'+rid+'/'
            self.assertIn(prefix+'运行数据/房间运行状态.json',names)
            self.assertIn(prefix+'玩家包/test/当前档案.json',names)
            self.assertTrue(any(name.startswith(prefix) and '/原始资源/' in name for name in names))
        self.assertIn('战役包/original/当前存档.json',names)
        self.assertIn('运行数据/认证/邮箱账号.sqlite3',names)
        self.assertEqual(self.output.stat().st_mode & 0o777,0o700)
        self.assertEqual((self.output/'备份清单.json').stat().st_mode & 0o777,0o600)

    def test_backup_rejects_missing_initialized_account_database(self):
        root = self.home/'accounts-only'
        save = enable(root)
        ModuleRuntime(save, APP_ROOT).ensure_empty_runtime()
        accounts = AccountStore(root/'运行数据/认证', dict(enabled=True))
        accounts.initialize()
        accounts.path.unlink()
        with self.assertRaisesRegex(ValueError, '缺少已初始化'):
            InstallationBackups(root).create(self.output)
        self.assertFalse(self.output.exists())

    def test_backup_rejects_missing_initialized_character_database(self):
        from server.account_characters import Characters
        characters = Characters(self.root/'运行数据/账号角色')
        characters.database.unlink()
        with self.assertRaisesRegex(ValueError, '缺少已初始化'):
            self.tool.create(self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_old_active_main_and_worker_locks_and_new_shared_lease(self):
        for save in (self.save,self.root/'运行数据/战役空间'/self.rids[0]/'运行数据/存档'):
            lock = ProjectServerLock(save)
            try:
                with self.assertRaises(RuntimeError): self.tool.create(self.output)
            finally: lock.close()
        lease = InstallationLease(self.root,shared=True)
        try:
            with self.assertRaises(RuntimeError): self.tool.create(self.output)
        finally: lease.close()
        self.assertFalse(self.output.exists())

    def test_machine_credentials_and_existing_backups_are_excluded_without_read(self):
        secret = self.root/'运行数据/联机/resend-api-key'
        secret.parent.mkdir();secret.write_bytes(b'isolated-placeholder')
        previous = self.root/'运行数据/安装级备份/old/file';previous.parent.mkdir(parents=True);previous.write_text('old')
        original = Path.open
        def guarded(path,*args,**kwargs):
            if path==secret: raise AssertionError('machine credential must not be opened')
            return original(path,*args,**kwargs)
        with mock.patch.object(Path,'open',guarded):
            report = self.tool.create(self.root/'运行数据/安装级备份/new')
        manifest = json.loads((Path(report['path'])/'备份清单.json').read_text())
        self.assertFalse(any('/联机/' in item['path'] or '/安装级备份/' in item['path'] for item in manifest['files']))

    def test_machine_entrance_and_mail_settings_are_never_archived_or_replaced(self):
        entrance=self.root/'运行数据/联机设置.json'
        mail=self.root/'运行数据/认证/邮箱账号设置.json'
        entrance.write_text('original machine entrance');mail.write_text('original mail config')
        report=self.tool.create(self.output)
        names={item['path'] for item in json.loads((self.output/'备份清单.json').read_text())['files']}
        self.assertNotIn('运行数据/联机设置.json',names)
        self.assertNotIn('运行数据/认证/邮箱账号设置.json',names)
        entrance.write_text('target machine entrance');mail.write_text('target mail config')
        self.tool.restore(self.output,report['manifestHash'])
        self.assertEqual(entrance.read_text(),'target machine entrance')
        self.assertEqual(mail.read_text(),'target mail config')

    def test_restore_is_complete_and_preserves_rollback_and_private_credentials(self):
        report = self.tool.create(self.output)
        current = self.root/'战役包/original/当前存档.json'
        current.write_text('later formal file')
        added = self.root/'玩家包/later/当前档案.json';added.parent.mkdir();added.write_text('later')
        secret = self.root/'运行数据/联机/resend-api-key';secret.parent.mkdir();secret.write_text('machine-private')
        result = self.tool.restore(self.output,report['manifestHash'])
        self.assertTrue(result['restored'])
        self.assertEqual(json.loads(current.read_text())['campaignId'],'original')
        self.assertFalse(added.exists())
        self.assertEqual(secret.read_text(),'machine-private')
        rollback = Path(result['rollbackPath'])
        self.assertEqual((rollback/'数据/战役包/original/当前存档.json').read_text(),'later formal file')
        self.assertTrue((self.root/'运行数据/工作区代次.json').exists())

    def test_tamper_traversal_extra_paths_and_symlinks_rejected_before_restore(self):
        report = self.tool.create(self.output)
        data = self.output/'数据/战役包/original/当前存档.json'
        original = data.read_bytes(); data.write_bytes(b'corrupt')
        with self.assertRaises(ValueError): self.tool.restore(self.output,report['manifestHash'])
        data.write_bytes(original)
        manifest_path = self.output/'备份清单.json'
        value = json.loads(manifest_path.read_text());original_manifest=manifest_path.read_bytes()
        value['files'][0]['path']='../escape';atomic_json(manifest_path,value)
        with self.assertRaises(ValueError): self.tool.verify(self.output)
        manifest_path.write_bytes(original_manifest)
        extra = self.output/'数据/运行数据/extra';extra.write_text('extra')
        with self.assertRaises(ValueError): self.tool.verify(self.output)
        extra.unlink();data.unlink();data.symlink_to(self.root/'战役包/original/当前存档.json')
        with self.assertRaises(ValueError): self.tool.verify(self.output)
        self.assertFalse(self.tool.journal.exists())

    def test_account_directory_mismatch_and_broken_original_asset_rejected(self):
        orphan = self.root/'运行数据/战役空间'/('r'+'9'*32);orphan.mkdir()
        with self.assertRaises(ValueError): self.tool.create(self.output)
        orphan.rmdir()
        asset = next((self.root/'运行数据/战役空间'/self.rids[0]).rglob('原始资源/*/*'))
        asset.write_bytes(b'damaged')
        with self.assertRaises(ValueError): self.tool.create(self.output)
        self.assertFalse(self.output.exists())

    def test_restore_failure_rolls_back_and_interrupted_restore_blocks_start_until_recover(self):
        report = self.tool.create(self.output)
        original = self.root/'战役包/original/当前存档.json'
        original.write_text('later revision')
        rename = Path.rename
        fired = False
        def fail_after_retirement(path,target):
            nonlocal fired
            result = rename(path,target)
            if path==self.root/'战役包' and not fired:
                fired=True
                raise OSError('simulated replacement failure')
            return result
        with mock.patch.object(Path,'rename',fail_after_retirement):
            with self.assertRaises(OSError): self.tool.restore(self.output,report['manifestHash'])
        self.assertEqual(original.read_text(),'later revision')
        self.assertFalse(self.tool.journal.exists())
        fired=False
        def crash_after_retirement(path,target):
            nonlocal fired
            result=rename(path,target)
            if path==self.save/'工作区.json' and not fired:
                fired=True
                raise SystemExit('simulated power loss')
            return result
        with mock.patch.object(Path,'rename',crash_after_retirement):
            with self.assertRaises(SystemExit): self.tool.restore(self.output,report['manifestHash'])
        self.assertTrue(self.tool.journal.exists())
        with self.assertRaises(RuntimeError): InstallationLease(self.root,shared=True)
        self.assertTrue(self.tool.recover()['recovered'])
        self.assertEqual(original.read_text(),'later revision')
        self.assertTrue((self.save/'工作区.json').exists())

    def test_recover_uses_validated_backup_if_retired_original_directory_is_missing(self):
        report=self.tool.create(self.output)
        current=self.root/'战役包/original/当前存档.json';current.write_text('validated rollback version')
        rename=Path.rename
        def crash_after_install(path,target):
            result=rename(path,target)
            if path.as_posix().endswith('/新备份/数据/战役包'):
                raise SystemExit('interrupted after installing new campaign directory')
            return result
        with mock.patch.object(Path,'rename',crash_after_install):
            with self.assertRaises(SystemExit):self.tool.restore(self.output,report['manifestHash'])
        journal=json.loads(self.tool.journal.read_text())
        retired=self.root/journal['job']/'原数据/战役包'
        import shutil
        shutil.rmtree(retired)
        self.assertTrue(self.tool.recover()['recovered'])
        self.assertEqual(current.read_text(),'validated rollback version')
        self.assertFalse(self.tool.journal.exists())

    def test_wal_rows_are_included_and_foreign_key_or_room_relations_checked(self):
        database=self.root/'运行数据/认证/邮箱账号.sqlite3'
        db=sqlite3.connect(database);self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("UPDATE rooms SET name='committed WAL' WHERE id=?",(self.rids[0],));db.commit()
        self.tool.create(self.output)
        with closing(sqlite3.connect(self.output/'数据/运行数据/认证/邮箱账号.sqlite3')) as snapshot:
            self.assertEqual(snapshot.execute('SELECT name FROM rooms WHERE id=?',(self.rids[0],)).fetchone()[0],'committed WAL')
        db.execute("INSERT INTO room_members VALUES (?,'missing','player')",(self.rids[0],));db.commit()
        with self.assertRaises(ValueError): self.tool.create(self.home/'bad-relations')

    def test_restore_revokes_previous_sessions_but_keeps_verified_account_login(self):
        accounts=AccountStore(self.root/'运行数据/认证',dict(enabled=True),epoch=lambda:epoch(self.save))
        password='isolated account passphrase'
        salt,digest=password_digest(password)
        with accounts.db() as db:
            db.execute("UPDATE accounts SET salt=?,digest=? WHERE id='a'",(salt,digest))
        token,_=accounts.login('test@example.com',password)
        self.assertIsNotNone(accounts.session(token))
        report=self.tool.create(self.output)
        self.tool.restore(self.output,report['manifestHash'])
        self.assertIsNone(accounts.session(token))
        replacement,public=accounts.login('test@example.com',password)
        self.assertEqual(public['accountId'],'a')
        self.assertIsNotNone(accounts.session(replacement))

    def test_portable_cli_create_verify_restore_and_maintenance_forwarder(self):
        entry=APP_ROOT/'manage_installation.py'
        def run(*args):
            result=subprocess.run([sys.executable,str(entry),*map(str,args)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            return json.loads(result.stdout)
        created=run('create','--root',self.root,'--output',self.output)
        verified=run('verify','--backup',self.output)
        self.assertEqual(created['manifestHash'],verified['manifestHash'])
        original=self.root/'战役包/original/当前存档.json';original.write_text('changed')
        self.assertTrue(run('restore','--root',self.root,'--backup',self.output,
                            '--expected-manifest-hash',verified['manifestHash'])['restored'])
        self.assertEqual(json.loads(original.read_text())['campaignId'],'original')
        self.assertFalse(run('recover','--root',self.root)['recovered'])

    def test_real_server_entry_refuses_pending_restore_when_workspace_marker_is_missing(self):
        marker=self.save/'工作区.json';marker.rename(self.home/'retired-marker.json')
        atomic_json(self.tool.journal,dict(pending=True))
        self.assertEqual(installation_root(self.save),self.root)
        result=subprocess.run([sys.executable,str(APP_ROOT/'start_server.py'),'--port','0'],
            env=dict(os.environ,SUNDOLL_TEST_SAVE_ROOT=str(self.save)),capture_output=True,text=True,timeout=8)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('安装级恢复尚未完成',result.stderr)
        self.assertFalse(marker.exists())
        self.assertFalse((self.save/'玩家档案').exists())


class RoomCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.save=enable(self.root);ModuleRuntime(self.save,APP_ROOT).ensure_empty_runtime()
        self.room='r'+'1'*32
        self.checkpoint=RoomCheckpoint(self.root,self.room,'p1')
        self.app=SimpleNamespace(STATE=dict(campaignId='c',maps=[],value='new'),STATE_REVISION=2,
            RECENT_ACTIONS=[dict(seq=1)],NEXT_SEQ=2,ACTION_IDS={'action':dict(seq=1)},BGM_STATE=dict(track=None))

    def test_matching_source_restores_runtime_and_action_receipts(self):
        self.assertTrue(self.checkpoint.save(self.app))
        target=SimpleNamespace()
        self.assertTrue(RoomCheckpoint(self.root,self.room,'p1').load(target))
        self.assertEqual(target.STATE,self.app.STATE)
        self.assertEqual(target.ACTION_IDS,self.app.ACTION_IDS)
        self.assertFalse(self.checkpoint.save(self.app))

    def test_committed_wal_update_invalidates_checkpoint_without_hashing_database_file(self):
        self.checkpoint.save(self.app)
        with ModuleStore(self.save).transaction() as db:
            ModuleStore.write_document(db,'runtime-character','changed','p',dict(hp=5),0)
        self.assertFalse(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))
        self.assertTrue(list((self.root/'运行数据/检查点保留').glob('*.json')))

    def test_formal_file_change_invalidates_and_new_storage_cannot_bless_stale_runtime(self):
        path=self.root/'战役包/c/当前存档.json';atomic_json(path,dict(version=1))
        self.app.STATE['_formalSourceHash']=ModuleStore.hash_file(path)
        self.checkpoint.save(self.app)
        atomic_json(path,dict(version=2))
        self.assertFalse(self.checkpoint.save(self.app,force=True))
        self.app.BGM_STATE=dict(track='later')
        self.assertFalse(self.checkpoint.save(self.app))
        self.app.STATE_REVISION+=1;self.app.NEXT_SEQ+=1
        self.assertFalse(self.checkpoint.save(self.app))
        self.app.STATE=dict(campaignId='c',maps=[],value='full old state again')
        self.app.STATE_REVISION+=1
        self.assertFalse(self.checkpoint.save(self.app))
        self.assertFalse(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))

    def test_only_explicit_current_formal_hash_can_rebase_after_a_formal_save(self):
        path=self.root/'战役包/c/当前存档.json';atomic_json(path,dict(version=1))
        self.app.STATE['_formalSourceHash']=ModuleStore.hash_file(path)
        self.assertTrue(self.checkpoint.save(self.app))
        atomic_json(path,dict(version=2))
        self.assertFalse(self.checkpoint.save(self.app))
        self.app.STATE=dict(campaignId='c',maps=[],value='loaded current formal state',
                            _formalSourceHash=ModuleStore.hash_file(path))
        self.app.STATE_REVISION+=1
        self.assertTrue(self.checkpoint.save(self.app,rebase=True))
        self.assertTrue(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))

    def test_pre_lineage_schema2_checkpoint_cannot_overlay_a_current_formal_file(self):
        path=self.root/'战役包/c/当前存档.json';atomic_json(path,dict(version=2))
        payload=dict(schemaVersion=2,roomId=self.room,protocolVersion='p1',
                     source=self.checkpoint.source(self.app.STATE),**self.checkpoint.runtime(self.app))
        atomic_json(self.checkpoint.path,payload)
        self.assertFalse(self.checkpoint.load(SimpleNamespace()))

    def test_named_directory_uses_immutable_identity_and_cannot_bless_formal_v2(self):
        path=self.root/'战役包/c-带名字的战役/当前存档.json'
        atomic_json(path,dict(campaignId='c',state=dict(campaignId='c',maps=[],value='v1')))
        self.app.STATE['_formalSourceHash']=ModuleStore.hash_file(path)
        self.assertEqual(self.checkpoint.source(self.app.STATE)['campaignHash'],ModuleStore.hash_file(path))
        self.assertTrue(self.checkpoint.save(self.app,acknowledge=True))
        atomic_json(path,dict(campaignId='c',state=dict(campaignId='c',maps=[],value='v2')))
        with self.assertRaises(CheckpointConflict):self.checkpoint.validate_state_source(self.app.STATE)
        self.app.STATE_REVISION+=1;self.app.NEXT_SEQ+=1
        with self.assertRaises(CheckpointConflict):self.checkpoint.save(self.app,acknowledge=True)
        self.assertFalse(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))

    def test_duplicate_immutable_campaign_identity_including_archive_is_rejected(self):
        path=self.root/'战役包/c-原战役/当前存档.json'
        value=dict(campaignId='c',state=dict(campaignId='c',maps=[]))
        atomic_json(path,value);self.app.STATE['_formalSourceHash']=ModuleStore.hash_file(path)
        self.assertTrue(self.checkpoint.save(self.app,acknowledge=True))
        duplicate=self.root/'战役包/c-同身份副本'
        atomic_json(duplicate/'当前存档.json',value)
        for archived in (False,True):
            if archived:atomic_json(duplicate/'已删除.json',dict(campaignId='c'))
            with self.assertRaisesRegex(CheckpointConflict,'身份重复'):
                self.checkpoint.save(self.app,acknowledge=True)
        self.assertFalse(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))

    def test_proven_formal_source_allows_independent_database_changes_and_next_action(self):
        path=self.root/'战役包/c-原战役/当前存档.json'
        atomic_json(path,dict(campaignId='c',state=dict(campaignId='c',maps=[])))
        self.app.STATE['_formalSourceHash']=ModuleStore.hash_file(path)
        self.assertTrue(self.checkpoint.save(self.app,rebase=True))
        with ModuleStore(self.save).transaction() as db:
            ModuleStore.write_document(db,'runtime-backpack','changed','p',dict(items=[]),0)
        self.assertTrue(self.checkpoint.save(self.app))
        self.app.STATE_REVISION+=1;self.app.NEXT_SEQ+=1
        self.assertTrue(self.checkpoint.save(self.app,acknowledge=True))
        self.assertTrue(RoomCheckpoint(self.root,self.room,'p1').load(SimpleNamespace()))

    def test_cross_room_and_unbound_legacy_checkpoint_are_preserved_not_loaded(self):
        self.checkpoint.save(self.app)
        self.assertFalse(RoomCheckpoint(self.root,'r'+'2'*32,'p1').load(SimpleNamespace()))
        atomic_json(self.checkpoint.path,dict(protocolVersion='p1',state=dict(value='old'),revision=1))
        self.assertFalse(self.checkpoint.load(SimpleNamespace()))
        self.assertEqual(len(list((self.root/'运行数据/检查点保留').glob('*.json'))),2)


if __name__=='__main__': unittest.main()
