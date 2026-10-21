from project_test_paths import APP_ROOT
import gc
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
from server.module_store import ModuleStore
from server.module_runtime import ModuleRuntime
from server.workspace import enable
from server.workspace_backup import Backups


class DatabaseLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.save = enable(self.root)
        self.runtime = ModuleRuntime(self.save, APP_ROOT); self.runtime.ensure_empty_runtime()

    def tracked(self):
        original = sqlite3.connect; opened = []
        def connect(*args, **kwargs):
            connection = original(*args, **kwargs); opened.append(connection); return connection
        return opened, mock.patch.object(sqlite3, 'connect', side_effect=connect)

    def assert_closed(self, connections):
        self.assertTrue(connections)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                _ = connection.in_transaction

    def test_backup_closes_source_destination_and_validation_before_return(self):
        opened, patch = self.tracked()
        with patch: result = Backups(self.save).create()
        self.assert_closed(opened)
        self.assertEqual(Backups(self.save).validate(Backups(self.save).path(result['id']))['id'], result['id'])

    def test_backup_validation_failure_closes_every_connection_and_removes_temp(self):
        opened, patch = self.tracked()
        with patch, mock.patch.object(Backups, 'validate', side_effect=ValueError('invalid backup')):
            with self.assertRaisesRegex(ValueError, 'invalid backup'): Backups(self.save).create()
        self.assert_closed(opened)
        self.assertFalse(list(Backups(self.save).home.glob('.*.tmp')))

    def test_connect_closes_connection_when_pragma_fails(self):
        self.runtime.store.database.write_bytes(b'not a sqlite database')
        opened, patch = self.tracked()
        with patch:
            with self.assertRaises(sqlite3.DatabaseError): self.runtime.store.connect()
        self.assert_closed(opened)

    def test_connect_closes_connection_when_projection_setup_fails(self):
        opened, patch = self.tracked()
        with patch, mock.patch('server.module_store.setup_projection', side_effect=sqlite3.OperationalError('full disk')):
            with self.assertRaises(sqlite3.OperationalError): self.runtime.store.connect()
        self.assert_closed(opened)
