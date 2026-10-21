from project_test_paths import APP_ROOT
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from server.workspace import enable, Workspace, atomic_json
from server.player_directories import migrate, recover, rename_directory, journal_path
from server import player_profiles as profiles
from server.module_store import ModuleStore
from server.module_runtime import ModuleRuntime
from server.workspace_recovery import rebuild


class PlayerDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root)
        self.app = self.root/'主程序'
        ModuleRuntime(self.save, self.app).ensure_empty_runtime()
        self.profiles = profiles.Store(self.save, self.app, self.root/'cache')

    def test_named_folder_keeps_identity_auth_and_character_after_rename(self):
        created = self.profiles.create('雷弗')
        pid = created['profile']['playerId']
        old = self.profiles.path(pid, '当前档案.json').parent
        self.assertEqual(old.name, '雷弗--'+pid[1:9])
        self.profiles.grant(pid, {'name':'独立角色','hpMax':24}, 'directory-grant-test')
        before = self.profiles.library(pid)
        self.profiles.rename(pid, '新名字')
        self.assertFalse(old.exists())
        self.assertEqual(self.profiles.library(pid), before)
        self.assertEqual(self.profiles.login(created['credential'])['playerId'], pid)
        self.assertEqual(self.profiles.credential(pid), created['credential'])
        self.assertEqual(len(self.profiles.players()), 1)
        self.profiles.delete(pid)
        self.assertEqual(self.profiles.players(), [])
        with self.assertRaises(profiles.ProfileError): self.profiles.login(created['credential'])

    def test_legacy_migration_and_interrupted_rename_preserve_original_assets_and_rebuild(self):
        created = self.profiles.create('旅人')
        pid = created['profile']['playerId']
        named = self.profiles.path(pid, '当前档案.json').parent
        legacy = named.parent/pid
        named.rename(legacy)
        store = ModuleStore(self.save)
        url = store.put_asset(b'original', 'image/png', 'test')
        digest = url.rsplit('/',1)[1]
        with store.transaction() as db:
            store.write_document(db, 'runtime-backpack', pid, pid, {'image':url}, 0)
        (store.assets/digest[:2]/digest).unlink()
        # Stop after the filesystem move; a second run must finish index changes.
        with patch('server.player_directories.sqlite3.connect', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError): migrate(self.save)
        self.assertTrue(journal_path(Workspace(self.save)).exists())
        recover(self.save)
        self.assertFalse(legacy.exists())
        self.assertEqual(store.asset(digest)[0].read_bytes(), b'original')
        self.assertEqual(self.profiles.login(created['credential'])['playerId'], pid)
        store.database.rename(store.database.with_suffix('.old'))
        rebuild(self.save)
        self.assertEqual(ModuleStore(self.save).asset(digest)[0].read_bytes(), b'original')

    def test_unsafe_names_and_same_names_cannot_escape_or_overwrite(self):
        a = self.profiles.create('../法师/\\:*?')
        with self.assertRaises(profiles.ProfileError): self.profiles.create('../法师/\\:*?')
        b = self.profiles.create('../法师2/\\:*?')
        paths = [self.profiles.path(p['profile']['playerId'], '当前档案.json').parent for p in (a,b)]
        self.assertNotEqual(*paths)
        self.assertTrue(all(p.parent == self.root/'玩家包' for p in paths))
        self.assertEqual(len(self.profiles.players()), 2)

    def test_duplicate_player_identity_fails_closed(self):
        created = self.profiles.create('旅人')
        pid = created['profile']['playerId']
        atomic_json(self.root/'玩家包/重复/当前档案.json', created['profile'])
        with self.assertRaises(ValueError): self.profiles.read(pid)

if __name__ == '__main__': unittest.main()
