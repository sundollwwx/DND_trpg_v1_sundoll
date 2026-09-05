"""Exercise publication against disposable local remotes, never GitHub."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('upload_github', Path(__file__).resolve().parents[1] / 'upload_github.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GitHubUploadTests(unittest.TestCase):
    def git(self, directory, *args):
        return subprocess.run(['git', '-C', str(directory), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-upload-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.remote = base / 'remote.git'
        self.local = base / '本地项目'
        self.other = base / 'other'
        self.remote.mkdir()
        self.local.mkdir()
        self.git(self.remote, 'init', '--bare', '--initial-branch=main')
        self.git(self.local, 'init', '--initial-branch=main')
        self.identity(self.local)
        (self.local / 'old.txt').write_text('old')
        (self.local / '.gitignore').write_text('*.log\n')
        self.git(self.local, 'add', '.')
        self.git(self.local, 'commit', '-m', 'initial')
        self.git(self.local, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.local, 'push', 'origin', 'main')

    def identity(self, directory):
        self.git(directory, 'config', 'user.name', 'Upload Test')
        self.git(directory, 'config', 'user.email', 'test@example.invalid')

    def publish(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return MODULE.upload(self.local, str(self.remote))

    def advance_remote(self):
        self.git(self.local, 'clone', str(self.remote), str(self.other))
        self.identity(self.other)
        (self.other / 'remote-only.txt').write_text('from another computer')
        (self.other / 'old.txt').write_text('remote modification')
        self.git(self.other, 'add', '.')
        self.git(self.other, 'commit', '-m', 'remote change')
        self.git(self.other, 'push', 'origin', 'main')
        return self.git(self.other, 'rev-parse', 'HEAD')

    def test_snapshot_includes_saves_and_deletions_excludes_cache(self):
        (self.local / '存档').mkdir()
        (self.local / '存档' / '战役.json').write_text('{"name":"测试"}')
        (self.local / 'old.txt').unlink()
        (self.local / 'runtime.log').write_text('cache')
        commit = self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), commit)
        self.assertEqual(self.git(self.remote, 'show', 'main:存档/战役.json'), '{"name":"测试"}')
        files = self.git(self.remote, 'ls-tree', '-r', '--name-only', 'main')
        self.assertNotIn('old.txt', files)
        self.assertNotIn('runtime.log', files)
        self.assertEqual(self.git(self.local, 'status', '--porcelain'), '')
        self.assertEqual(self.publish(), commit)

    def test_remote_ahead_preserves_history_but_keeps_local_files(self):
        previous = self.advance_remote()
        self.publish()
        self.git(self.remote, 'merge-base', '--is-ancestor', previous, 'main')
        self.assertEqual(self.git(self.remote, 'show', 'main:old.txt'), 'old')
        self.assertNotIn('remote-only.txt', self.git(self.remote, 'ls-tree', '--name-only', 'main'))
        self.assertFalse((self.local / 'remote-only.txt').exists())
        self.assertEqual(self.git(self.local, 'status', '--porcelain'), '')

    def test_divergence_keeps_both_histories_and_local_content(self):
        previous = self.advance_remote()
        (self.local / 'old.txt').write_text('local change')
        self.git(self.local, 'commit', '-am', 'local change')
        local_previous = self.git(self.local, 'rev-parse', 'HEAD')
        self.publish()
        for ancestor in (previous, local_previous):
            self.git(self.remote, 'merge-base', '--is-ancestor', ancestor, 'main')
        self.assertEqual(self.git(self.remote, 'show', 'main:old.txt'), 'local change')

    def test_wrong_remote_does_not_stage_or_commit(self):
        original = self.git(self.local, 'rev-parse', 'HEAD')
        (self.local / 'old.txt').write_text('pending')
        self.git(self.local, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), original)
        self.assertEqual(self.git(self.local, 'diff', '--cached'), '')

    def test_push_failure_retains_snapshot_for_retry(self):
        hook = self.remote / 'hooks' / 'pre-receive'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        original = self.git(self.remote, 'rev-parse', 'main')
        (self.local / 'old.txt').write_text('pending')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), original)
        self.assertEqual((self.local / 'old.txt').read_text(), 'pending')
        hook.unlink()
        self.publish()
        self.assertEqual(self.git(self.remote, 'show', 'main:old.txt'), 'pending')


if __name__ == '__main__':
    unittest.main()
