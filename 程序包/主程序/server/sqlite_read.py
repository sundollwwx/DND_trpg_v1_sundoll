"""Read an existing SQLite database without touching its files or WAL sidecars.

SQLite's mode=ro may create -wal/-shm files beside a closed WAL database. A
query_only writable connection can additionally checkpoint on close. Neither
is suitable for recovery reads that promise to leave the source untouched.

Copy the database and its journals into a private directory, retrying if any
source file changes during the copy. SQLite recovers committed WAL frames in
that copy, so an active WAL is never ignored as it would be with immutable=1.
The returned query-only connection owns and removes its private snapshot.
"""
from pathlib import Path
import shutil
import sqlite3
import tempfile


_JOURNALS = ('', '-wal', '-journal')
_COPY_ATTEMPTS = 5


class _ReadSnapshot(sqlite3.Connection):
    def close(self):
        super().close()
        snapshot = getattr(self, '_snapshot', None)
        if snapshot is not None:
            snapshot.cleanup()
            self._snapshot = None


def _file_versions(path):
    versions = {}
    for suffix in _JOURNALS:
        try:
            stat = Path(str(path) + suffix).stat()
        except FileNotFoundError:
            versions[suffix] = None
        else:
            # Include identity and ctime as well as size/mtime: a writer may
            # replace a file or reset a WAL without changing its length.
            versions[suffix] = (stat.st_dev, stat.st_ino, stat.st_size,
                                stat.st_mtime_ns, stat.st_ctime_ns)
    return versions


def _copy_snapshot(path, target):
    for _ in range(_COPY_ATTEMPTS):
        before = _file_versions(path)
        if before[''] is None:
            raise sqlite3.OperationalError('unable to open database file')
        for suffix in _JOURNALS:
            Path(str(target) + suffix).unlink(missing_ok=True)
        try:
            for suffix in _JOURNALS:
                if before[suffix] is not None:
                    shutil.copyfile(str(path) + suffix, str(target) + suffix)
        except FileNotFoundError:
            # A last writer may checkpoint/delete its WAL while we copy it.
            continue
        if before == _file_versions(path):
            return
    raise sqlite3.OperationalError('database changed while copying read snapshot')


def open_readonly_database(database):
    """Return a query-only, WAL-aware snapshot; never open the source in SQLite."""
    path = Path(database).resolve()
    snapshot = tempfile.TemporaryDirectory(prefix='sundoll-sqlite-read-')
    connection = None
    try:
        target = Path(snapshot.name) / 'snapshot.sqlite3'
        _copy_snapshot(path, target)
        # Writable mode is restricted to our private files: SQLite may need
        # to recover a journal before the first read, even with query_only.
        connection = sqlite3.connect(target.as_uri() + '?mode=rw', uri=True,
                                     factory=_ReadSnapshot)
        connection._snapshot = snapshot
        connection.execute('PRAGMA query_only=ON')
        connection.execute('SELECT name FROM sqlite_master LIMIT 1').fetchone()
        connection.row_factory = sqlite3.Row
        return connection
    except BaseException as exc:
        if connection is not None:
            connection.close()
        snapshot.cleanup()
        if isinstance(exc, OSError):
            raise sqlite3.OperationalError('unable to copy database read snapshot') from exc
        raise
