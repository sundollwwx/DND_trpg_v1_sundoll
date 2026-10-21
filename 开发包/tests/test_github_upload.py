"""Exercise publication against disposable local remotes, never GitHub."""
from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('upload_github', TOOLS_ROOT / 'github/upload_github.py')
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
        (self.local / 'README.md').write_text('old')
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
        (self.other / '程序包').mkdir()
        (self.other / '程序包/目录导览.md').write_text('from another computer')
        (self.other / 'README.md').write_text('remote modification')
        self.git(self.other, 'add', '.')
        self.git(self.other, 'commit', '-m', 'remote change')
        self.git(self.other, 'push', 'origin', 'main')
        return self.git(self.other, 'rev-parse', 'HEAD')

    def test_snapshot_includes_source_deletions_but_never_private_or_unknown_files(self):
        (self.local / '存档').mkdir()
        (self.local / '存档' / '战役.json').write_text('{"name":"测试"}')
        (self.local / 'README.md').unlink()
        (self.local / 'runtime.log').write_text('cache')
        commit = self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), commit)
        files = self.git(self.remote, 'ls-tree', '-r', '--name-only', 'main')
        self.assertNotIn('存档/战役.json', files)
        self.assertEqual((self.local / '存档/战役.json').read_text(), '{"name":"测试"}')
        self.assertNotIn('README.md', files)
        self.assertNotIn('runtime.log', files)
        self.assertIn('?? ', self.git(self.local, 'status', '--porcelain'))
        self.assertEqual(self.publish(), commit)

    def test_remote_ahead_stops_without_staging_or_changing_either_history(self):
        previous = self.advance_remote()
        local_previous = self.git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(MODULE.UploadError, '正常合并'):
            self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), previous)
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), local_previous)
        self.assertEqual(self.git(self.remote, 'show', 'main:README.md'), 'remote modification')
        self.assertFalse((self.local / '程序包/目录导览.md').exists())
        self.assertEqual(self.git(self.local, 'status', '--porcelain'), '')

    def test_divergence_requires_real_merge_instead_of_synthetic_local_tree_merge(self):
        previous = self.advance_remote()
        (self.local / 'README.md').write_text('local change')
        self.git(self.local, 'commit', '-am', 'local change')
        local_previous = self.git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(MODULE.UploadError, '正常合并'):
            self.publish()
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), local_previous)
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), previous)
        self.assertEqual((self.local / 'README.md').read_text(), 'local change')

    def test_private_staged_file_is_rejected_without_changing_index(self):
        (self.local / 'secret.json').write_text('private-test-only')
        self.git(self.local, 'add', 'secret.json')
        before = self.git(self.local, 'write-tree')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertEqual(self.git(self.local, 'write-tree'), before)
        self.assertEqual((self.local / 'secret.json').read_text(), 'private-test-only')

    def test_a_removed_private_file_in_unpublished_history_is_still_rejected(self):
        (self.local / 'secret.json').write_text('private-test-only')
        self.git(self.local, 'add', 'secret.json')
        self.git(self.local, 'commit', '-m', 'mistaken local secret')
        self.git(self.local, 'rm', 'secret.json')
        self.git(self.local, 'commit', '-m', 'remove from current tree')
        remote = self.git(self.remote, 'rev-parse', 'main')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), remote)

    def test_source_symlink_cannot_publish_private_target(self):
        (self.local / 'private.txt').write_text('private-test-only')
        (self.local / 'README.md').unlink()
        (self.local / 'README.md').symlink_to('private.txt')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertTrue((self.local / 'README.md').is_symlink())

    def test_wrong_remote_does_not_stage_or_commit(self):
        original = self.git(self.local, 'rev-parse', 'HEAD')
        (self.local / 'README.md').write_text('pending')
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
        (self.local / 'README.md').write_text('pending')
        with self.assertRaises(MODULE.UploadError):
            self.publish()
        self.assertEqual(self.git(self.remote, 'rev-parse', 'main'), original)
        self.assertEqual((self.local / 'README.md').read_text(), 'pending')
        hook.unlink()
        self.publish()
        self.assertEqual(self.git(self.remote, 'show', 'main:README.md'), 'pending')


if __name__ == '__main__':
    unittest.main()
