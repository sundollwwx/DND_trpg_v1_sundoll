from project_test_paths import APP_ROOT
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from server import sqlite_read


class SqliteReadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def wal_backup_without_sidecars(self):
        source = sqlite3.connect(self.root / 'source.sqlite3')
        target = self.root / 'wal-backup.sqlite3'
        try:
            source.execute('PRAGMA journal_mode=WAL')
            source.execute('CREATE TABLE documents (id TEXT PRIMARY KEY, payload TEXT)')
            source.execute('CREATE TABLE migrations (id TEXT PRIMARY KEY, payload TEXT)')
            source.execute("INSERT INTO documents VALUES ('item-1', '{\"quantity\":3}')")
            source.commit()
            destination = sqlite3.connect(target)
            try:
                source.backup(destination)
            finally:
                destination.close()
        finally:
            source.close()
        self.assertEqual(target.read_bytes()[18:20], b'\x02\x02')
        self.assertFalse(target.with_name(target.name + '-wal').exists())
        self.assertFalse(target.with_name(target.name + '-shm').exists())
        return target

    def assert_preserved_read(self, path):
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        files_before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                        for p in self.root.iterdir() if p.is_file()}
        connection = sqlite_read.open_readonly_database(path)
        snapshot_path = Path(connection.execute('PRAGMA database_list').fetchone()[2])
        try:
            self.assertNotEqual(snapshot_path, path)
            self.assertEqual(connection.execute('PRAGMA query_only').fetchone()[0], 1)
            self.assertEqual([tuple(row) for row in connection.execute('SELECT * FROM documents')],
                             [('item-1', '{"quantity":3}')])
            self.assertEqual(connection.execute('SELECT count(*) FROM migrations').fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE documents SET payload='changed'")
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute('CREATE TABLE forbidden (id TEXT)')
        finally:
            connection.close()
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertEqual({p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                          for p in self.root.iterdir() if p.is_file()}, files_before)
        self.assertFalse(snapshot_path.parent.exists())

    def test_real_wal_backup_without_sidecars_preserves_main_database(self):
        self.assert_preserved_read(self.wal_backup_without_sidecars())

    def test_sqlite_opens_only_private_snapshot_not_source(self):
        path = self.wal_backup_without_sidecars()
        with mock.patch.object(sqlite_read.sqlite3, 'connect', wraps=sqlite3.connect) as connect:
            self.assert_preserved_read(path)
        self.assertEqual(connect.call_count, 1)
        self.assertNotIn(path.as_uri(), connect.call_args.args[0])
        self.assertTrue(connect.call_args.args[0].endswith('?mode=rw'))

    def test_missing_file_is_not_created_or_retried_as_writable(self):
        target = self.root / 'missing.sqlite3'
        with mock.patch.object(sqlite_read.sqlite3, 'connect', wraps=sqlite3.connect) as connect:
            with self.assertRaises(sqlite3.OperationalError):
                sqlite_read.open_readonly_database(target)
            connect.assert_not_called()
        self.assertFalse(target.exists())

    def test_other_errors_do_not_fall_back(self):
        path = self.wal_backup_without_sidecars()
        with mock.patch.object(sqlite_read.sqlite3, 'connect', side_effect=sqlite3.OperationalError('database is locked')) as connect:
            with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                sqlite_read.open_readonly_database(path)
            self.assertEqual(connect.call_count, 1)
        self.assertFalse(path.with_name(path.name + '-wal').exists())

    def test_active_wal_commits_are_visible_without_checkpoint_or_immutable(self):
        path = self.root / 'live.sqlite3'
        writer = sqlite3.connect(path)
        try:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('CREATE TABLE live (value TEXT)')
            writer.execute("INSERT INTO live VALUES ('latest WAL value')")
            writer.commit()
            main_before = path.read_bytes()
            wal_path = path.with_name(path.name + '-wal')
            wal_before = wal_path.read_bytes()
            reader = sqlite_read.open_readonly_database(path)
            try:
                self.assertEqual(reader.execute('SELECT value FROM live').fetchone()[0], 'latest WAL value')
            finally:
                reader.close()
            self.assertEqual(path.read_bytes(), main_before)
            self.assertEqual(wal_path.read_bytes(), wal_before)
        finally:
            writer.close()

    def test_commit_during_copy_retries_and_keeps_latest_committed_wal(self):
        path = self.root / 'live.sqlite3'
        writer = sqlite3.connect(path)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('CREATE TABLE live (value TEXT)')
        writer.execute("INSERT INTO live VALUES ('first')")
        writer.commit()
        copyfile = sqlite_read.shutil.copyfile
        copied = []
        def copy_then_commit(source, target):
            result = copyfile(source, target)
            if source == str(path):
                copied.append(source)
                if len(copied) == 1:
                    writer.execute("INSERT INTO live VALUES ('second')")
                    writer.commit()
            return result
        with mock.patch.object(sqlite_read.shutil, 'copyfile', side_effect=copy_then_commit):
            reader = sqlite_read.open_readonly_database(path)
        try:
            self.assertEqual([row[0] for row in reader.execute('SELECT value FROM live')], ['first', 'second'])
            self.assertEqual(len(copied), 2)
        finally:
            reader.close()

    def test_writer_checkpoint_during_copy_retries_without_creating_source_wal(self):
        path = self.root / 'checkpoint.sqlite3'
        writer = sqlite3.connect(path)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('CREATE TABLE live (value TEXT)')
        writer.execute("INSERT INTO live VALUES ('committed')")
        writer.commit()
        copyfile = sqlite_read.shutil.copyfile
        copied = []
        after_writer_close = {}
        def copy_then_close(source, target):
            result = copyfile(source, target)
            if source == str(path):
                copied.append(source)
                if len(copied) == 1:
                    writer.close()
                    after_writer_close.update({p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                                               for p in self.root.iterdir() if p.is_file()})
            return result
        with mock.patch.object(sqlite_read.shutil, 'copyfile', side_effect=copy_then_close):
            reader = sqlite_read.open_readonly_database(path)
        try:
            self.assertEqual(reader.execute('SELECT value FROM live').fetchone()[0], 'committed')
            self.assertEqual(len(copied), 2)
        finally:
            reader.close()
        self.assertEqual({p.name: (p.read_bytes(), p.stat().st_mtime_ns)
                          for p in self.root.iterdir() if p.is_file()}, after_writer_close)

    def test_busy_snapshot_fails_after_bounded_retries_without_opening_source(self):
        path = self.wal_backup_without_sidecars()
        original = sqlite_read._file_versions
        calls = []
        def changing_versions(candidate):
            versions = original(candidate)
            calls.append(candidate)
            versions[''] = versions[''] + (len(calls),)
            return versions
        with mock.patch.object(sqlite_read, '_file_versions', side_effect=changing_versions), \
             mock.patch.object(sqlite_read.sqlite3, 'connect', wraps=sqlite3.connect) as connect:
            with self.assertRaisesRegex(sqlite3.OperationalError, 'changed while copying'):
                sqlite_read.open_readonly_database(path)
            connect.assert_not_called()
        self.assertEqual(len(calls), 2 * sqlite_read._COPY_ATTEMPTS)
        self.assertFalse(path.with_name(path.name + '-wal').exists())


if __name__ == '__main__':
    unittest.main()
