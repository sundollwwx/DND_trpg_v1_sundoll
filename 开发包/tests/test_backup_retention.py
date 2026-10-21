from project_test_paths import APP_ROOT
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(APP_ROOT))
from server.workspace import enable, atomic_json
from server.backup_retention import BackupRetention, BackupPlanConflict


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manager = BackupRetention(enable(self.root))
        self.ids = []
        for index in range(14):
            identity = 'b' + format(index, '032x')
            self.ids.append(identity)
            folder = self.manager.backups.path(identity)
            (folder / '数据').mkdir(parents=True)
            (folder / '数据/file').write_bytes(b'backup')
            atomic_json(folder / '备份清单.json', dict(id=identity, name='手动备份',
                createdAt=100000 + index, bytes=6, fileCount=1))

    def test_read_and_policy_changes_never_delete_backups(self):
        overview = self.manager.overview()
        self.assertEqual(overview['storage']['count'], 14)
        self.assertEqual(overview['storage']['totalBytes'], 84)
        self.assertFalse(self.manager.settings.exists())
        changed = self.manager.set_policy(2, 0)
        self.assertEqual(len(changed['plan']['candidates']), 12)
        self.assertEqual(len(self.manager.backups.list()), 14)
        self.assertFalse(changed['policy']['automaticDeletion'])

    def test_latest_migration_and_pinned_points_are_not_deletable(self):
        path = self.manager.backups.path(self.ids[0]) / '备份清单.json'
        value = json.loads(path.read_text()); value['name'] = '内容来源迁移前自动备份'
        atomic_json(path, value)
        self.manager.set_policy(1, 0)
        self.manager.set_pinned(self.ids[1], True)
        overview = self.manager.overview()
        candidates = {b['id'] for b in overview['plan']['candidates']}
        self.assertFalse({self.ids[0], self.ids[1], self.ids[-1]} & candidates)
        for identity in (self.ids[0], self.ids[-1]):
            with self.assertRaises(ValueError): self.manager.set_pinned(identity, False)
        with self.assertRaises(BackupPlanConflict):
            self.manager.apply(overview['plan']['previewToken'], [self.ids[0]], 'protected-request-1')

    def test_policy_retains_recent_days_as_well_as_newest_count(self):
        path = self.manager.backups.path(self.ids[0]) / '备份清单.json'
        value = json.loads(path.read_text()); value['createdAt'] = 999999900
        atomic_json(path, value)
        with mock.patch('server.backup_retention.time.time', return_value=1000000):
            result = self.manager.set_policy(1, 1)
        self.assertNotIn(self.ids[0], [b['id'] for b in result['plan']['candidates']])

    def test_changed_preview_blocks_deletion(self):
        plan = self.manager.set_policy(1, 0)['plan']
        self.manager.set_pinned(self.ids[1], True)
        with self.assertRaises(BackupPlanConflict):
            self.manager.apply(plan['previewToken'], [self.ids[0]], 'changed-preview-1')
        self.assertTrue(self.manager.backups.path(self.ids[0]).exists())

    def test_cleanup_is_explicit_and_exact_retry_is_idempotent(self):
        plan = self.manager.set_policy(1, 0)['plan']
        result = self.manager.apply(plan['previewToken'], [self.ids[0]], 'cleanup-request-1')
        self.assertEqual(result['reclaimedBytes'], 6)
        self.assertFalse(self.manager.backups.path(self.ids[0]).exists())
        self.assertTrue(self.manager.backups.path(self.ids[1]).exists())
        self.assertEqual(result, self.manager.apply(plan['previewToken'], [self.ids[0]], 'cleanup-request-1'))
        with self.assertRaises(BackupPlanConflict):
            self.manager.apply(plan['previewToken'], [self.ids[1]], 'cleanup-request-1')

    def test_failed_cleanup_can_finish_original_selection_without_deleting_new_backup(self):
        plan = self.manager.set_policy(1, 0)['plan']
        import server.backup_retention as retention
        original = retention.shutil.rmtree
        def fail_second(path):
            if path.name == self.ids[1]: raise OSError('temporary disk error')
            return original(path)
        with mock.patch.object(retention.shutil, 'rmtree', side_effect=fail_second):
            with self.assertRaises(OSError):
                self.manager.apply(plan['previewToken'], self.ids[:2], 'cleanup-request-2')
        new = 'b' + 'f' * 32
        folder = self.manager.backups.path(new); folder.mkdir()
        atomic_json(folder / '备份清单.json', dict(id=new, name='后来创建', createdAt=999999999, bytes=1, fileCount=0))
        result = self.manager.apply(plan['previewToken'], self.ids[:2], 'cleanup-request-2')
        self.assertEqual(result['deletedIds'], self.ids[:2])
        self.assertTrue(folder.exists())

    def test_pending_restore_source_and_rollback_are_protected(self):
        job = '运行数据/恢复任务/r' + 'a' * 32
        atomic_json(self.root / job / '备份清单.json', {'id': self.ids[0]})
        atomic_json(self.manager.backups.journal, {'job': job, 'rollbackId': self.ids[1]})
        overview = self.manager.set_policy(1, 0)
        ids = {b['id'] for b in overview['plan']['candidates']}
        self.assertFalse({self.ids[0], self.ids[1]} & ids)

    def test_invalid_selection_and_symlink_are_rejected_before_deletion(self):
        plan = self.manager.set_policy(1, 0)['plan']
        with self.assertRaises(ValueError):
            self.manager.apply(plan['previewToken'], ['../outside'], 'invalid-selection-1')
        external = self.root / 'outside'; external.mkdir(); (external / 'keep').write_text('keep')
        linked = self.manager.backups.path(self.ids[0]); import shutil; shutil.rmtree(linked)
        linked.symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.manager.apply(plan['previewToken'], [self.ids[0]], 'symlink-selection-1')
        self.assertTrue((external / 'keep').exists())
