"""New rooms get public rules through the ordinary recoverable module store."""
from project_test_paths import APP_ROOT
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from server.distribution import install_default_support
from server.daily_life import DATA_FILES, load_data, read_bundle
from server.daily_life_lifecycle import set_enabled
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore
from server.workspace import enable


class RoomDefaultsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.save = enable(self.root/'room')
        self.runtime = ModuleRuntime(self.save, APP_ROOT)
        self.runtime.ensure_empty_runtime()

    def test_new_room_receives_all_default_rules_with_recoverable_record(self):
        self.assertTrue(install_default_support(self.save, APP_ROOT))
        for kind in DATA_FILES: self.assertTrue(load_data(self.save, kind))
        with self.runtime.store.transaction() as db:
            record = self.runtime.store.document(db, 'daily-life-module', '日常小事')
        self.assertEqual(set(record['data']['bundle']['data']), set(DATA_FILES))
        self.assertFalse(install_default_support(self.save, APP_ROOT))

    def test_program_root_alias_does_not_hide_public_defaults(self):
        alias = self.root/'program-alias'
        alias.symlink_to(APP_ROOT, target_is_directory=True)
        self.assertTrue(install_default_support(self.save, alias))
        self.assertTrue(load_data(self.save, 'climate'))

    def test_retry_keeps_authored_rules_and_disabled_state(self):
        install_default_support(self.save, APP_ROOT)
        path = self.root/'room/通用包/日常小事/资料/lifestyle.json'
        authored = {'version':123, 'rules':['房主修改']}
        path.write_text(json.dumps(authored), encoding='utf-8')
        set_enabled(self.runtime, False)
        self.assertFalse(install_default_support(self.save, APP_ROOT))
        self.assertEqual(json.loads(path.read_text('utf-8')), authored)
        with self.assertRaisesRegex(ValueError, '已停用'): load_data(self.save, 'lifestyle')

    def test_failed_publication_is_recovered_without_second_rule_record(self):
        import server.module_store as store
        project = store.project
        def fail_after_commit(module, db):
            if not db.in_transaction and db.execute("SELECT 1 FROM documents WHERE kind='daily-life-module'").fetchone():
                raise OSError('publication interrupted')
            return project(module, db)
        with mock.patch.object(store, 'project', side_effect=fail_after_commit):
            with self.assertRaises(OSError): install_default_support(self.save, APP_ROOT)
        self.assertFalse((self.root/'room/通用包/日常小事/模块.json').exists())
        install_default_support(self.save, APP_ROOT)
        self.assertTrue(load_data(self.save, 'menus'))
        with self.runtime.store.transaction() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM documents WHERE kind='daily-life-module'").fetchone()[0], 1)

    def test_standard_distribution_general_bundle_is_installed_once(self):
        install_default_support(self.save, APP_ROOT)
        bundle = read_bundle(self.save)
        bundle['data']['lifestyle']['edition'] = '明确选用的通用包'
        source = self.root/'program'
        package = source/'defaults/通用内容/default.sundoll'
        package.parent.mkdir(parents=True)
        self.runtime.packages.export(package, 'general', '默认通用内容',
            {'dailyLife':bundle}, 'general-default')
        target = enable(self.root/'other-room')
        runtime = ModuleRuntime(target, APP_ROOT)
        runtime.ensure_empty_runtime()
        install_default_support(target, source)
        self.assertEqual(load_data(target, 'lifestyle')['edition'], '明确选用的通用包')
        set_enabled(runtime, False)
        install_default_support(target, source)
        with self.assertRaisesRegex(ValueError, '已停用'): load_data(target, 'lifestyle')


if __name__ == '__main__': unittest.main()
