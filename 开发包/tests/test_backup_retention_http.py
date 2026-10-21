from unittest import mock
from test_module_http import ModuleHttpTests, SERVER
from server.workspace import enable
from server.module_runtime import ModuleRuntime
from server.workspace_backup import Backups


class BackupRetentionHttpTests(ModuleHttpTests):
    def setUp(self):
        super().setUp()
        self.save = enable(self.root / '备份维护验收')
        patch = mock.patch.object(SERVER, 'LOCAL_SAVE_ROOT', str(self.save))
        patch.start(); self.addCleanup(patch.stop)
        ModuleRuntime(self.save, self.root).ensure_empty_runtime()

    def test_retention_endpoints_are_host_only(self):
        for operation in ('backups', 'backup-policy', 'backup-pin', 'backup-cleanup'):
            with mock.patch.object(SERVER, 'local_save_request_allowed', return_value=False):
                code, value = self.request({'op': operation}, path='/api/modules', host=True)
            self.assertEqual(code, 403, operation)

    def test_overview_policy_and_explicit_cleanup_with_stale_preview(self):
        backup = Backups(self.save)
        old = backup.create('手动旧备份')
        latest = backup.create('最新备份')
        code, result = self.request({'op': 'backups'}, path='/api/modules', host=True)
        self.assertEqual(code, 200, result)
        self.assertEqual(result['storage']['count'], 2)
        code, view = self.request({'op': 'backup-policy', 'keepCount': 1, 'keepDays': 0}, path='/api/modules', host=True)
        self.assertEqual(code, 200, view)
        self.assertTrue(backup.path(old['id']).exists())
        self.assertTrue(backup.path(latest['id']).exists())
        command = {'op': 'backup-cleanup', 'backupIds': [old['id']], 'previewToken': view['plan']['previewToken'], 'requestId': 'http-cleanup-request-1'}
        code, _ = self.request({'op': 'backup-pin', 'backupId': old['id'], 'pinned': True}, path='/api/modules', host=True)
        self.assertEqual(code, 200)
        self.assertEqual(self.request(command, path='/api/modules', host=True)[0], 409)
        self.assertTrue(backup.path(old['id']).exists())
        self.request({'op': 'backup-pin', 'backupId': old['id'], 'pinned': False}, path='/api/modules', host=True)
        _, view = self.request({'op': 'backups'}, path='/api/modules', host=True)
        command['previewToken'] = view['plan']['previewToken']
        code, result = self.request(command, path='/api/modules', host=True)
        self.assertEqual(code, 200, result)
        self.assertEqual(result['deletedIds'], [old['id']])
        self.assertFalse(backup.path(old['id']).exists())
        self.assertTrue(backup.path(latest['id']).exists())
        self.assertEqual(self.request(command, path='/api/modules', host=True)[0], 200)


for name in dir(ModuleHttpTests):
    if name.startswith('test_'):
        if name not in BackupRetentionHttpTests.__dict__:
            setattr(BackupRetentionHttpTests, name, None)
del ModuleHttpTests
