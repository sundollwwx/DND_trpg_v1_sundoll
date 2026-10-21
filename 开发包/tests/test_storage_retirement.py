from project_test_paths import APP_ROOT, TOOLS_ROOT
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
from server.workspace import atomic_json, enable
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore
from server.storage_mode import account_rooms_only, validate_startup, MODE_FILE, JOURNAL_FILE, ARCHIVE_FILE
from server.installation_backup import InstallationBackups, InstallationLease

spec=importlib.util.spec_from_file_location('retirement',TOOLS_ROOT/'maintenance/archive_original_workspace.py')
retirement=importlib.util.module_from_spec(spec);spec.loader.exec_module(retirement)

class RetirementTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.home=Path(temp.name);self.root=self.home/'app';self.save=enable(self.root)
        ModuleRuntime(self.save,APP_ROOT).ensure_empty_runtime()
        ModuleStore(self.save).put_asset(b'archived original asset','text/plain','old')
        atomic_json(self.root/'运行数据/认证/邮箱账号设置.json',dict(enabled=True,roomsEnabled=True))
        atomic_json(self.root/'运行数据/工作区代次.json',dict(epoch='keep-session-epoch'))
        self.file=self.root/'战役包/old/当前存档.json';atomic_json(self.file,dict(unique='original version'))
        self.archive=self.root/'运行数据/历史归档/原工作区-20261017'
        retained = self.root/'运行数据/迁入前保留-test';retained.mkdir()
        (retained/'old.sqlite3-wal').write_bytes(b'old history')
        (retained/'.server.lock').write_bytes(b'historical lock record')

    def test_retire_and_snapshot_restore_preserve_archive_and_disable_old_startup(self):
        original=self.file.read_bytes();epoch=(self.root/'运行数据/工作区代次.json').read_bytes()
        result=retirement.retire(self.root)
        self.assertGreater(result['files'],2)
        self.assertFalse(self.file.exists());self.assertEqual((self.archive/'战役包/old/当前存档.json').read_bytes(),original)
        self.assertTrue(account_rooms_only(self.save));self.assertFalse((self.save/'模块存储').exists())
        self.assertEqual((self.root/'运行数据/工作区代次.json').read_bytes(),epoch)
        with self.assertRaises(RuntimeError):validate_startup(self.archive/'运行数据/存档',{})
        with self.assertRaises(RuntimeError):validate_startup(self.save,{})
        report=InstallationBackups(self.root).create(self.home/'backup')
        retirement.verify_archive(self.home/'backup/数据/运行数据/历史归档/原工作区-20261017')
        for name in ('old.sqlite3-wal', '.server.lock'):
            self.assertEqual((self.archive/'运行数据/迁入前保留-test'/name).read_bytes(),
                (self.home/'backup/数据/运行数据/历史归档/原工作区-20261017/运行数据/迁入前保留-test'/name).read_bytes())
        InstallationBackups(self.root).restore(self.home/'backup',report['manifestHash'])
        self.assertTrue(account_rooms_only(self.save));retirement.verify_archive(self.archive)
        self.assertTrue(retirement.retire(self.root)['alreadyArchived'])

    def test_partial_rename_exception_rolls_back_even_if_exception_follows_move(self):
        before=retirement.files_under(self.root,retirement.sources(self.root));calls=[]
        def fail(source,target):
            os.replace(source,target);calls.append(source)
            if len(calls)==3:raise OSError('test interruption')
        with self.assertRaises(OSError):retirement.retire(self.root,replace=fail)
        self.assertEqual(retirement.files_under(self.root,retirement.sources(self.root)),before)
        self.assertFalse((self.root/'运行数据'/JOURNAL_FILE).exists())
        self.assertFalse(account_rooms_only(self.save))

    def test_pending_transaction_and_live_lease_refuse_start_or_retire(self):
        lease=InstallationLease(self.root,shared=True)
        try:
            with self.assertRaises(RuntimeError):retirement.retire(self.root)
        finally:lease.close()
        journal=self.root/'运行数据'/JOURNAL_FILE;atomic_json(journal,{})
        with self.assertRaises(RuntimeError):validate_startup(self.save,{})
        with self.assertRaises(RuntimeError):retirement.retire(self.root)
        journal.unlink();(self.root/'运行数据'/MODE_FILE).write_text('{}')
        with self.assertRaises(ValueError):account_rooms_only(self.save)

    def test_missing_mode_does_not_recreate_retired_workspace(self):
        retirement.retire(self.root)
        (self.root/'运行数据'/MODE_FILE).unlink()
        with self.assertRaises(ValueError): account_rooms_only(self.save)

    def test_changed_archive_is_detected(self):
        retirement.retire(self.root)
        (self.archive/'战役包/old/当前存档.json').write_text('changed')
        with self.assertRaises(ValueError):retirement.verify_archive(self.archive)

if __name__=='__main__':unittest.main()
