"""Bounded lifetime for module transfer copies; active transfers hold leases.

These directories contain reproducible downloads and import previews, never
canonical modules or workspace backups. Keep a day for retries and sweep old
copies on startup/access. A process-wide lease covers generation, installation
and download so concurrent cleanup cannot remove an in-use file.
"""
from collections import Counter
from contextlib import contextmanager
import os
from pathlib import Path
import re
import threading
import time


RETENTION_SECONDS = 24 * 60 * 60
SWEEP_INTERVAL = 5 * 60
_NAME = re.compile(r'[0-9a-f]{32}\.(?:json|sundoll|zip)')
_LOCK = threading.RLock()
_ACTIVE = Counter()
_LAST_SWEEP = {}
_DIRECTORIES = {'import': '导入暂存', 'export': '导出暂存'}


class ModuleStaging:
    def __init__(self, save_root):
        self.root = Path(save_root).resolve() / '模块存储'

    def directory(self, kind):
        path = self.root / _DIRECTORIES[kind]
        if self.root.is_symlink() or path.is_symlink():
            raise ValueError('模块暂存目录不能是符号链接')
        return path

    def path(self, kind, name):
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise ValueError('模块暂存文件名无效')
        path = self.directory(kind) / name
        if path.is_symlink(): raise ValueError('模块暂存文件不能是符号链接')
        return path

    def _key(self, kind, identity):
        return str(self.root), kind, identity

    @contextmanager
    def lease(self, kind, name):
        path = self.path(kind, name)
        key = self._key(kind, path.stem)
        with _LOCK:
            _ACTIVE[key] += 1
        try:
            self.cleanup()
            yield path
        finally:
            with _LOCK:
                # Refresh both files of an import preview together, including
                # failed operations whose original request can still be retried.
                for suffix in ('.json', '.sundoll', '.zip'):
                    candidate = path.with_suffix(suffix)
                    try:
                        if candidate.is_file() and not candidate.is_symlink():
                            os.utime(candidate, None)
                    except OSError:
                        pass  # housekeeping must not mask a committed result
                _ACTIVE[key] -= 1
                if not _ACTIVE[key]: del _ACTIVE[key]

    def cleanup(self, force=False, now=None):
        now = time.time() if now is None else now
        identity = str(self.root)
        removed = []
        with _LOCK:
            if not force and now - _LAST_SWEEP.get(identity, 0) < SWEEP_INTERVAL:
                return removed
            _LAST_SWEEP[identity] = now
            # A server normally has one workspace; bound test/maintenance roots.
            while len(_LAST_SWEEP) > 128: _LAST_SWEEP.pop(next(iter(_LAST_SWEEP)))
            for kind in _DIRECTORIES:
                try:
                    directory = self.directory(kind)
                    if not directory.is_dir(): continue
                    entries = list(directory.iterdir())
                except OSError:
                    continue
                groups = {}
                for path in entries:
                    try:
                        if _NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink():
                            groups.setdefault(path.stem, []).append(path)
                    except OSError:
                        continue
                for stem, paths in groups.items():
                    if _ACTIVE[self._key(kind, stem)]: continue
                    try:
                        if max(path.stat().st_mtime for path in paths) > now - RETENTION_SECONDS:
                            continue
                        for path in paths:
                            path.unlink()
                            removed.append(path.name)
                    except OSError:
                        # Retry cleanup later; transfer correctness is unrelated.
                        continue
        return removed
