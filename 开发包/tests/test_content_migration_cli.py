from project_test_paths import APP_ROOT
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from server.inventory import item_definition
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore
from server.save_storage import ProjectServerLock
from server.workspace import enable, write_catalog


SCRIPT = Path(__file__).resolve().parents[1] / 'maintenance/migrate_content_origins.py'
spec = importlib.util.spec_from_file_location('content_migration_cli', SCRIPT)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class ContentMigrationCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root / 'workspace')
        ModuleRuntime(self.save, APP_ROOT).ensure_empty_runtime()
        self.store = ModuleStore(self.save)
        template = dict(id='old-potion', name='治疗药水', category='potion', rarity='普通',
                        effect='治疗', consumable=True, version=5, archived=False, scope='general', campaignId='')
        write_catalog(self.save, 'item-template', dict(schemaVersion=1, revision=1,
                      templates=[template], receipts={}))
        self.pid, self.oid = 'p' + '1' * 32, 'o' + '1' * 32
        self.item = dict(item_definition(template, ValueError), id='i' + '1' * 32,
                         quantity=2, ownerCharacterId=self.oid, sourceTemplateId=template['id'],
                         sourceTemplateVersion=3, notes='保留旧药水', favorite=True)
        with self.store.transaction() as db:
            self.store.write_document(db, 'runtime-backpack', self.pid, self.pid,
                dict(playerId=self.pid, revision=7, items=[self.item], removedItems=[], history=[], receipts={}), 0)
        self.output = self.root / 'maintenance' / 'migration-report.json'
        self.plan = cli.run(self.save)

    def documents(self):
        connection = sqlite3.connect(self.store.database.as_uri() + '?mode=ro', uri=True)
        try:
            return connection.execute('SELECT * FROM documents ORDER BY kind,id').fetchall()
        finally:
            connection.close()

    def apply(self, plan_hash=None):
        return cli.run(self.save, apply=True, expected_plan_hash=plan_hash or self.plan['planHash'], output=self.output)

    def test_preview_does_not_initialize_lock_backup_or_modify_documents(self):
        before = self.documents()
        preview = cli.run(self.save, output=self.output)
        self.assertEqual(preview['planHash'], self.plan['planHash'])
        self.assertEqual(before, self.documents())
        self.assertFalse((self.save / '.server.lock').exists())
        self.assertFalse((self.root / 'workspace/运行数据/整套备份').exists())

    def test_archive_is_read_only_and_central_directory_requires_a_room(self):
        from server.storage_mode import ARCHIVE_FILE, MODE_FILE, FORMAT
        root = self.save.parent.parent
        (root/ARCHIVE_FILE).write_text('{}')
        before = self.documents()
        self.assertEqual(cli.run(self.save)['planHash'], self.plan['planHash'])
        with self.assertRaisesRegex(ValueError, '历史归档只允许预览'):
            self.apply()
        self.assertEqual(self.documents(), before)
        self.assertFalse((self.save/'.server.lock').exists())
        (root/ARCHIVE_FILE).unlink()
        (self.save.parent/MODE_FILE).write_text(json.dumps(dict(format=FORMAT)))
        with self.assertRaisesRegex(ValueError, '具体房间'):
            cli.run(self.save)

    def test_running_server_refuses_before_backup(self):
        lock = ProjectServerLock(self.save)
        try:
            with mock.patch.object(cli.Backups, 'create') as backup:
                with self.assertRaisesRegex(RuntimeError, '已有服务器运行'):
                    self.apply()
                backup.assert_not_called()
        finally:
            lock.close()
        self.assertIsNone(cli.migration_receipt(self.store.database))

    def test_wrong_hash_refuses_before_backup(self):
        before = self.documents()
        with mock.patch.object(cli.Backups, 'create') as backup:
            with self.assertRaisesRegex(ValueError, '哈希不一致'):
                self.apply('0' * 64)
            backup.assert_not_called()
        self.assertEqual(before, self.documents())

    def test_backup_failure_never_applies_migration(self):
        before = self.documents()
        with mock.patch.object(cli.Backups, 'create', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                self.apply()
        self.assertEqual(before, self.documents())
        self.assertIsNone(cli.migration_receipt(self.store.database))

    def test_rechecks_plan_after_backup_and_refuses_changed_source(self):
        create = cli.Backups.create
        def changed(backup_service, name):
            result = create(backup_service, name)
            with self.store.transaction() as db:
                bag = self.store.document(db, 'runtime-backpack', self.pid)
                bag['data']['items'][0]['quantity'] = 1
                self.store.write_document(db, 'runtime-backpack', self.pid, self.pid,
                                          bag['data'], bag['revision'])
            return result
        with mock.patch.object(cli.Backups, 'create', new=changed):
            with self.assertRaisesRegex(ValueError, '备份完成后存档指纹变化'):
                self.apply()
        self.assertIsNone(cli.migration_receipt(self.store.database))

    def test_output_cannot_overwrite_live_module_data(self):
        before = self.documents()
        with self.assertRaisesRegex(ValueError, '程序包以外'):
            cli.run(self.save, output=self.store.database)
        self.assertEqual(before, self.documents())

    def test_success_backs_up_and_independently_verifies_original_fields(self):
        report = self.apply()
        self.assertEqual(report['phase'], 'verified')
        self.assertTrue(report['verification']['passed'])
        self.assertTrue(report['backupId'])
        cli.Backups(self.save).validate(cli.Backups(self.save).path(report['backupId']))
        before = Path(report['beforeDatabase'])
        with sqlite3.connect(before.as_uri() + '?mode=ro', uri=True) as connection:
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
            item = json.loads(connection.execute("SELECT payload FROM documents WHERE kind='runtime-backpack'").fetchone()[0])['items'][0]
        self.assertEqual(item, self.item)
        with mock.patch.object(cli.Backups, 'create') as backup:
            repeated = self.apply()
            backup.assert_not_called()
        self.assertTrue(repeated['alreadyApplied'])
        self.assertEqual(repeated['backupId'], report['backupId'])
        self.assertEqual(repeated['migrationResult'], report['migrationResult'])

    def test_verifier_rejects_historical_version_rewrite(self):
        report = self.apply()
        connection = sqlite3.connect(self.store.database)
        try:
            raw = connection.execute("SELECT payload FROM documents WHERE kind='runtime-backpack'").fetchone()[0]
            altered = json.loads(raw)
            altered['items'][0]['sourceTemplateVersion'] = 5
            connection.execute("UPDATE documents SET payload=? WHERE kind='runtime-backpack'",
                               (json.dumps(altered, ensure_ascii=False, separators=(',', ':')),))
            connection.commit()
        finally:
            connection.close()
        verification = cli.verify(report['beforeDatabase'], self.store.database, self.plan)
        self.assertFalse(verification['passed'])
        self.assertTrue(any('改写原字段' in error for error in verification['errors']))


if __name__ == '__main__':
    unittest.main()
