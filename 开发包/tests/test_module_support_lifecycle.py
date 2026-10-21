"""Source modules, support catalogs and backup ownership stay portable."""
from project_test_paths import APP_ROOT
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_daily_life_api import BUILDER, create_module
from server import player_profiles as profiles
from server.catalog_paths import merge_catalog_indexes, support_module_identity
from server.daily_life import DATA_FILES, load_data, read_bundle
from server.documents import document_library_catalog
from server.item_library import ItemLibrary
from server.inventory import item_definition
from server.module_management import apply_general, export_general, overview, set_archived
from server.module_packages import strip_secrets
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore, RevisionConflict
from server.music_catalog import music_library_catalog
from server.support_files import register_support_files
from server.workspace import enable, write_catalog


class ModuleSupportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-module-support-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root, {'c1':'c1-冒险'})
        self.runtime = ModuleRuntime(self.save, APP_ROOT)
        self.runtime.ensure_empty_runtime()
        self.source = self.root/'source.sundoll'

    def install_daily(self, bundle, identity='daily-test', expected=None):
        manifest = self.runtime.packages.export(self.source, 'general', '日常小事', {'dailyLife':bundle}, identity)
        self.runtime.packages.install(self.source, expected)
        return manifest

    def bundle(self):
        with tempfile.TemporaryDirectory() as source:
            root = Path(source)
            save = enable(root)
            create_module(root)
            return strip_secrets(read_bundle(save))

    def test_local_daily_module_has_export_disable_and_restore(self):
        module, values = create_module(self.root)
        result = overview(self.runtime)
        self.assertEqual(next(g for g in result['general'] if g['id']=='general:日常小事')['files'], 7)
        self.assertEqual(result['modules'][0]['moduleId'], 'daily-life-local')
        export_general(self.runtime, 'general:日常小事', self.source)
        self.assertEqual(set(self.runtime.packages.inspect(self.source)[1]['dailyLife']['data']), set(DATA_FILES))
        original = (module/'资料/flavor.json').read_bytes()
        set_archived(self.runtime, 'daily-life-local', True)
        with self.assertRaisesRegex(ValueError, '停用'): load_data(self.save, 'climate')
        self.assertEqual(json.loads(original), json.loads((module/'资料/flavor.json').read_bytes()))
        self.assertTrue(overview(self.runtime)['modules'][0]['archived'])
        set_archived(self.runtime, 'daily-life-local', False)
        self.assertEqual(load_data(self.save, 'flavor'), values['flavor'])

    def test_import_activate_update_unload_preserves_authored_changes(self):
        bundle = self.bundle()
        first = self.install_daily(bundle)
        apply_general(self.runtime, 'daily-test')
        self.assertEqual(read_bundle(self.save), bundle)
        path = self.root/'通用包/日常小事/资料/flavor.json'
        custom = dict(bundle['data']['flavor'], note='我的故事')
        path.write_text(json.dumps(custom), encoding='utf-8')
        new = copy.deepcopy(bundle)
        new['data']['flavor']['note'] = '包中的故事'
        new['data']['climate']['name'] = '新版气候'
        self.install_daily(new, expected=first['dataHash'])
        result = apply_general(self.runtime, 'daily-test')
        self.assertEqual([v['id'] for v in result['kept']], ['flavor'])
        self.assertEqual(load_data(self.save, 'flavor'), custom)
        self.assertEqual(load_data(self.save, 'climate')['name'], '新版气候')
        set_archived(self.runtime, 'daily-test', True)
        with self.assertRaisesRegex(ValueError, '停用'): load_data(self.save, 'menus')
        self.assertEqual(read_bundle(self.save)['data']['flavor'], custom)
        set_archived(self.runtime, 'daily-test', False)
        apply_general(self.runtime, 'daily-test')
        self.assertEqual(load_data(self.save, 'flavor'), custom)

    def test_two_daily_sources_cannot_silently_replace_one_another(self):
        bundle = self.bundle()
        self.install_daily(bundle)
        apply_general(self.runtime, 'daily-test')
        other = copy.deepcopy(bundle)
        other['data']['climate']['name'] = '其他来源'
        self.install_daily(other, 'other-daily')
        with self.assertRaises(RevisionConflict): apply_general(self.runtime, 'other-daily')
        self.assertEqual(load_data(self.save, 'climate')['name'], bundle['data']['climate']['name'])

    def test_daily_publication_failure_pauses_reads_and_replays_committed_snapshot(self):
        bundle = self.bundle()
        self.install_daily(bundle)
        import server.workspace as workspace
        atomic = workspace.atomic_json

        def fail(path, value):
            if str(path).endswith('/资料/flavor.json'): raise OSError('disk unavailable')
            return atomic(path, value)

        with mock.patch.object(workspace, 'atomic_json', side_effect=fail):
            with self.assertRaises(OSError): apply_general(self.runtime, 'daily-test')
        with self.assertRaisesRegex(ValueError, '发布'): load_data(self.save, 'lifestyle')
        db = self.runtime.store.connect(); db.close()
        self.assertEqual(read_bundle(self.save), bundle)
        self.assertFalse((self.root/'运行数据/模块发布中.json').exists())

    def test_invalid_daily_content_is_rejected_before_archive_or_distribution_write(self):
        bundle = self.bundle()
        bundle['data']['climate']['defaultWeather']['auto'] = 'yes'
        with self.assertRaises(ValueError): self.install_daily(bundle)
        self.assertFalse(self.source.exists())
        module, _ = create_module(self.root)
        (module/'资料/climate.json').write_text(json.dumps(bundle['data']['climate']), encoding='utf-8')
        destination = self.root/'dist'
        with self.assertRaises(ValueError): BUILDER.copy_daily_life(self.root/'主程序', destination)
        self.assertFalse((destination/'通用包/日常小事').exists())

    def test_incomplete_daily_archive_is_rejected(self):
        bundle = self.bundle()
        del bundle['data']['climate']
        with self.assertRaises(ValueError): self.install_daily(bundle)
        self.assertFalse(self.source.exists())

    def test_invalid_local_daily_content_is_visible_without_breaking_module_overview(self):
        module, _ = create_module(self.root)
        (module/'资料/climate.json').write_text('{}', encoding='utf-8')
        result = overview(self.runtime)
        self.assertFalse(result['modules'][0]['available'])
        self.assertTrue(result['modules'][0]['error'])

    def support(self, name='冒险.docx', raw=b'document-original'):
        path = self.root/'战役包/c1-冒险/资料/文档/战役/c1'/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        return path

    def test_support_registration_is_idempotent_and_publishes_module_owned_locations(self):
        path = self.support()
        result = register_support_files(self.save)
        self.assertEqual(result['registered'], 1)
        self.assertEqual(support_module_identity(self.save, path.parents[2]), '战役包:c1')
        self.assertEqual(register_support_files(self.save)['unchanged'], 1)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        db = self.runtime.store.connect()
        try:
            rows = db.execute('SELECT path FROM asset_locations WHERE id=?', (digest,)).fetchall()
            self.assertEqual(len(rows), 1)
            self.assertTrue(rows[0]['path'].startswith('战役包/c1-冒险/资源/'))
            self.assertEqual(db.execute("SELECT revision FROM documents WHERE kind='support-file'").fetchone()[0], 1)
        finally: db.close()
        snapshot = json.loads((self.root/'运行数据/协调记录/索引快照.json').read_text('utf-8'))
        self.assertTrue(any(row['id']==digest for row in snapshot['asset_locations']))
        self.assertEqual(path.read_bytes(), b'document-original')
        path.write_bytes(b'edited document')
        self.assertEqual(register_support_files(self.save)['registered'], 1)

    def test_staging_only_support_document_survives_coordinator_rebuild_without_staging(self):
        from server.workspace_recovery import rebuild
        path = self.support()
        store = self.runtime.store
        url = store.put_asset(path.read_bytes(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'campaign:c1')
        digest = url.rsplit('/',1)[1]
        register_support_files(self.save)
        (store.assets/digest[:2]/digest).unlink()
        store.database.rename(store.database.with_suffix('.backup'))
        rebuild(self.save)
        self.assertEqual(ModuleStore(self.save).asset(digest)[0].read_bytes(), path.read_bytes())

    def test_support_registration_can_limit_one_module_and_reject_symlink(self):
        path = self.support()
        other = self.root/'通用包/通用音乐/资料/音乐/song.mp3'
        other.parent.mkdir(parents=True); other.write_bytes(b'music')
        result = register_support_files(self.save, self.root/'战役包/c1-冒险')
        self.assertEqual(result['registered'], 1)
        path.unlink(); path.symlink_to(other)
        with self.assertRaises(ValueError): register_support_files(self.save)

    def test_catalogs_namespace_identical_paths_and_drop_ambiguous_legacy_alias(self):
        catalogs = []
        for index in (1,2):
            root = self.root/str(index)
            root.mkdir()
            (root/'song.mp3').write_bytes(b'music'+str(index).encode())
            catalogs.append(music_library_catalog(root, module_identity='general:'+str(index)))
        ids = [c['tracks'][0]['id'] for c in catalogs]
        legacy = catalogs[0]['tracks'][0]['legacyId']
        self.assertNotEqual(ids[0], ids[1])
        combined = merge_catalog_indexes(catalogs)
        self.assertEqual(set(combined), set(ids))
        self.assertNotIn(legacy, combined)
        self.assertEqual(merge_catalog_indexes(catalogs[:1])[legacy], catalogs[0]['_index'][ids[0]])

    def test_document_ids_remain_distinct_and_stable_after_module_move(self):
        first = self.support()
        root = first.parents[2]
        one = document_library_catalog(root, 'c1', module_identity='campaign:c1')
        copied_root = self.root/'other'
        copied = copied_root/'战役/c1/冒险.docx'
        copied.parent.mkdir(parents=True); copied.write_bytes(first.read_bytes())
        two = document_library_catalog(copied_root, 'c1', module_identity='campaign:c2')
        self.assertNotEqual(one['documents'][0]['id'], two['documents'][0]['id'])
        moved = document_library_catalog(copied_root, 'c1', module_identity='campaign:c1')
        self.assertEqual(one['documents'][0]['id'], moved['documents'][0]['id'])
        self.assertNotIn(one['documents'][0]['legacyId'], merge_catalog_indexes([one,two]))

    def test_item_automatic_backups_live_in_runtime_and_old_backups_restore_explicitly(self):
        store = profiles.Store(self.save, APP_ROOT, self.root/'cache')
        library = ItemLibrary(store, profiles)
        current = library.read()
        current['templates'] = [dict(item_definition(dict(name='测试物品', category='gear', effect='携带', consumable=False), ValueError),
                                    id='test-item', version=1, archived=False, **library.metadata({}))]
        write_catalog(self.save, 'item-template', current)
        command = dict(op='archive', templateId=current['templates'][0]['id'], templateVersion=1,
                       requestId='test-runtime-backup-0001', revision=current['revision'])
        library.apply(command)
        self.assertTrue((self.root/'运行数据/备份/物品库/1.json').is_file())
        self.assertFalse((self.root/'玩家包/物品库自动备份').exists())
        current = library.read()
        legacy = library.legacy_backup_root
        legacy.mkdir(parents=True)
        data = copy.deepcopy(current); data['revision'] = 99; data['templates'][0]['name'] = '旧备份内容'
        (legacy/'99.json').write_text(json.dumps(data), encoding='utf-8')
        self.assertEqual(library.read_backup(99)['templates'][0]['name'], '旧备份内容')
        with self.assertRaises(profiles.ProfileError): library.restore_backup(99, current['revision']-1)
        restored = library.restore_backup(99, current['revision'])
        self.assertEqual(restored['templates'][0]['name'], '旧备份内容')
        self.assertEqual(restored['revision'], current['revision']+1)
        (legacy/'98.json').write_text('{}', encoding='utf-8')
        with self.assertRaises(profiles.ProfileError): library.read_backup(98)
        self.assertEqual(library.read()['templates'][0]['name'], '旧备份内容')


if __name__ == '__main__': unittest.main()
