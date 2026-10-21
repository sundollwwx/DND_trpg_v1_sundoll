from project_test_paths import APP_ROOT
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

from server.installation_backup import InstallationLease
from server.module_store import ModuleStore
from server.save_storage import ProjectServerLock
from server.sqlite_read import open_readonly_database
from server.workspace import enable

TOOL_PATH = Path(__file__).resolve().parents[1] / 'maintenance/prune_stale_asset_locations.py'
SPEC = importlib.util.spec_from_file_location('prune_stale_asset_locations', TOOL_PATH)
tool = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tool)


class StaleAssetLocationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-stale-assets-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.root = self.home / '程序包'
        self.save = enable(self.root)
        self.store = ModuleStore(self.save)
        self.raw = b'unchanged isolated original'
        self.url = self.store.put_asset(self.raw, 'text/plain', 'general:本地通用')
        self.digest = self.url.rsplit('/', 1)[1]
        self.item = dict(id='test-item', name='保留物品', image=self.url)
        with self.store.transaction() as db:
            self.store.write_document(db, 'item-template', self.item['id'], 'general:本地通用', self.item, 0)
        self.live = f'通用包/本地通用/资源/{self.digest[:2]}/{self.digest}'
        self.stale = f'通用包/旧标签/资源/{self.digest[:2]}/{self.digest}'
        self.add_location(self.stale)
        self.output = self.home / '审计/应用.json'

    def add_location(self, relative):
        with self.store.transaction() as db:
            db.execute('INSERT INTO asset_locations VALUES (?,?)', (self.digest, relative))
            db.execute('INSERT INTO module_outbox VALUES (?,?)', ('fixture-index', 'seed'))

    def table(self, name):
        with closing(open_readonly_database(self.store.database)) as db:
            return sorted(tuple(row) for row in db.execute('SELECT * FROM ' + name))

    def index(self):
        return json.loads((self.root / '运行数据/协调记录/索引快照.json').read_text('utf-8'))

    def apply(self, output=None):
        plan = tool.preview(self.save)
        return tool.run(self.save, apply=True, expected_plan_hash=plan['planHash'], output=output or self.output)

    def data_files(self):
        return {p.relative_to(self.root).as_posix(): tool.checksum(p)
                for p in self.root.rglob('*') if p.is_file()
                and not p.name.endswith(('-wal', '-shm'))
                and p.name not in ('.安装维护.lock', '.server.lock')}

    def test_default_preview_has_no_source_writes_or_lease(self):
        before = self.data_files()
        result = tool.run(self.save)
        self.assertTrue(result['readOnly'])
        self.assertEqual(result['blocked'], [])
        self.assertEqual([row['path'] for row in result['candidates']], [self.stale])
        self.assertEqual(result['candidates'][0]['retainedLocations'][0]['path'], self.live)
        self.assertEqual(self.data_files(), before)
        self.assertFalse((self.root / '运行数据/.安装维护.lock').exists())

    def test_archive_is_preview_only_and_central_directory_is_not_a_game_store(self):
        from server.storage_mode import ARCHIVE_FILE, MODE_FILE, FORMAT
        (self.root/ARCHIVE_FILE).write_text('{}')
        before = self.data_files()
        plan = tool.preview(self.save)
        with self.assertRaisesRegex(ValueError, '历史归档只允许预览'):
            tool.run(self.save, apply=True, expected_plan_hash=plan['planHash'], output=self.output)
        self.assertEqual(self.data_files(), before)
        (self.root/ARCHIVE_FILE).unlink()
        (self.save.parent/MODE_FILE).write_text(json.dumps(dict(format=FORMAT)))
        with self.assertRaisesRegex(ValueError, '具体房间'):
            tool.preview(self.save)
        with self.assertRaisesRegex(ValueError, '具体房间'):
            tool.run(self.save)

    def test_apply_preserves_original_documents_links_and_refreshes_index(self):
        documents, links, assets = self.table('documents'), self.table('asset_links'), self.table('assets')
        files = self.data_files()
        previous_index = (self.root / '运行数据/协调记录/索引快照.json').read_bytes()
        result = self.apply()
        self.assertTrue(result['applied'])
        self.assertEqual([row['path'] for row in result['removed']], [self.stale])
        self.assertEqual(self.table('asset_locations'), [(self.digest, self.live)])
        self.assertEqual(self.table('documents'), documents)
        self.assertEqual(self.table('asset_links'), links)
        self.assertEqual(self.table('assets'), assets)
        self.assertEqual(self.table('module_outbox'), [])
        self.assertEqual(self.index()['asset_locations'], [dict(id=self.digest, path=self.live)])
        for relative, digest in files.items():
            if relative not in ('运行数据/存档/模块存储/模块.sqlite3', '运行数据/协调记录/索引快照.json'):
                self.assertEqual(tool.checksum(self.root / relative), digest)
        backup = Path(result['backup']['directory'])
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        for name in ('游戏模块.sqlite3', '索引快照.json'):
            self.assertEqual((backup / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / '索引快照.json').read_bytes(), previous_index)
        with closing(sqlite3.connect((backup / '游戏模块.sqlite3').as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('SELECT count(*) FROM asset_locations').fetchone()[0], 2)

    def test_all_registered_locations_missing_refuses_even_with_central_original(self):
        (self.root / self.live).unlink()
        self.assertTrue(self.store.asset_path(self.digest).is_file())
        plan = tool.preview(self.save)
        self.assertEqual(plan['candidates'], [])
        self.assertTrue(plan['blocked'])
        before = self.table('asset_locations')
        with self.assertRaisesRegex(ValueError, '拒绝项'):
            tool.run(self.save, apply=True, expected_plan_hash=plan['planHash'], output=self.output)
        self.assertEqual(self.table('asset_locations'), before)
        self.assertFalse(self.output.exists())

    def test_size_or_hash_mismatch_cannot_be_retained(self):
        live = self.root / self.live
        live.write_bytes(b'x' * len(self.raw))
        plan = tool.preview(self.save)
        self.assertTrue(plan['blocked'])
        self.assertEqual(plan['candidates'], [])
        live.write_bytes(self.raw + b'changed length')
        self.assertTrue(tool.preview(self.save)['blocked'])

    def test_unregistered_or_escaping_location_is_never_removed(self):
        with self.store.transaction() as db:
            db.execute('INSERT INTO asset_locations VALUES (?,?)',
                       ('f' * 64, '通用包/缺登记/资源/ff/' + 'f' * 64))
            db.execute('INSERT INTO module_outbox VALUES (?,?)', ('fixture-index', 'seed'))
        plan = tool.preview(self.save)
        self.assertTrue(plan['blocked'])
        self.assertEqual([row['id'] for row in plan['candidates']], [self.digest])
        with self.assertRaisesRegex(ValueError, '拒绝项'):
            tool.run(self.save, apply=True, expected_plan_hash=plan['planHash'], output=self.output)
        with self.assertRaises(ValueError):
            tool.location_path(tool.workspace_at(self.save), self.digest, '../outside/' + self.digest)
        if os.name != 'nt':
            link = self.root / '通用包/符号链接'
            link.symlink_to(self.root / '通用包/本地通用', target_is_directory=True)
            with self.assertRaises(ValueError):
                tool.location_path(tool.workspace_at(self.save), self.digest,
                                   f'通用包/符号链接/资源/{self.digest[:2]}/{self.digest}')

    def test_credentials_are_never_opened_during_preview_or_apply(self):
        auth = self.root / '运行数据/认证'
        auth.mkdir()
        (auth / '隔离凭据.json').write_text('isolated-placeholder')
        original = Path.open
        def guarded(path, *args, **kwargs):
            if path.is_relative_to(auth):
                raise AssertionError('credentials must never be read')
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'open', guarded):
            self.apply()

    def test_shared_service_lease_prevents_backup_and_mutation(self):
        before = self.table('asset_locations')
        lease = InstallationLease(self.root, shared=True)
        try:
            with self.assertRaisesRegex(RuntimeError, '完整停服'):
                self.apply()
        finally:
            lease.close()
        self.assertEqual(self.table('asset_locations'), before)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_name(self.output.stem + '-恢复前').exists())

    def test_legacy_room_lock_also_prevents_mutation_without_reading_accounts(self):
        room = self.root / '运行数据/战役空间' / ('r' + '1' * 32)
        room_save = enable(room)
        lock = ProjectServerLock(room_save)
        try:
            with self.assertRaises(RuntimeError):
                self.apply()
        finally:
            lock.close()
        self.assertFalse(self.output.exists())

    def test_room_workspace_uses_central_installation_lease(self):
        room = self.root / '运行数据/战役空间' / ('r' + '2' * 32)
        room_save = enable(room)
        self.assertEqual(tool.installation_at(tool.workspace_at(room_save)), self.root)
        lease = InstallationLease(self.root, shared=True)
        try:
            with self.assertRaisesRegex(RuntimeError, '完整停服'):
                tool.run(room_save, apply=True, expected_plan_hash='0' * 64, output=self.output)
        finally:
            lease.close()

    def test_preview_hash_guard_and_inside_installation_output_are_rejected(self):
        plan = tool.preview(self.save)
        self.add_location(f'通用包/另一个旧标签/资源/{self.digest[:2]}/{self.digest}')
        with self.assertRaisesRegex(ValueError, '重新预览'):
            tool.run(self.save, apply=True, expected_plan_hash=plan['planHash'], output=self.output)
        with self.assertRaisesRegex(ValueError, '安装目录外'):
            tool.run(self.save, output=self.root / '报告.json')
        if os.name != 'nt':
            link = self.home / '绕回安装目录'
            link.symlink_to(self.root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, '安装目录外'):
                tool.run(self.save, output=link / '报告.json')

    def test_transaction_rolls_back_if_second_missing_path_reappears(self):
        second = f'通用包/第二旧标签/资源/{self.digest[:2]}/{self.digest}'
        self.add_location(second)
        before = self.table('asset_locations')
        original = tool.protected_backup
        def backup_then_reappear(store, directory):
            result = original(store, directory)
            target = self.root / second
            target.parent.mkdir(parents=True)
            target.write_bytes(self.raw)
            return result
        with mock.patch.object(tool, 'protected_backup', backup_then_reappear):
            with self.assertRaisesRegex(ValueError, '重新出现'):
                self.apply()
        self.assertEqual(self.table('asset_locations'), before)
        self.assertEqual(self.table('module_outbox'), [])
        report = json.loads(self.output.read_text())
        self.assertFalse(report['databaseCommitted'])
        self.assertEqual(report['removed'], [])

    def test_projection_failure_retains_replayable_outbox_and_recovery_evidence(self):
        import server.workspace as workspace_module
        original = workspace_module.atomic_json
        def fail_index(path, value):
            if Path(path).name == '索引快照.json':
                raise OSError('isolated projection failure')
            return original(path, value)
        documents, links = self.table('documents'), self.table('asset_links')
        with mock.patch.object(workspace_module, 'atomic_json', fail_index):
            with self.assertRaises(OSError):
                self.apply()
        report = json.loads(self.output.read_text())
        self.assertTrue(report['databaseCommitted'])
        self.assertEqual(report['phase'], 'projection-pending')
        self.assertEqual([row['path'] for row in report['removed']], [self.stale])
        self.assertEqual(self.table('module_outbox'), [tool.INDEX_EVENT])
        db = self.store.connect()
        db.close()
        self.assertEqual(self.table('module_outbox'), [])
        self.assertEqual(self.index()['asset_locations'], [dict(id=self.digest, path=self.live)])
        self.assertEqual(self.table('documents'), documents)
        self.assertEqual(self.table('asset_links'), links)


if __name__ == '__main__':
    unittest.main()
