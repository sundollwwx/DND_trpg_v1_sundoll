"""Exercise GitHub-to-local replacement only inside disposable repositories."""
from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT

import contextlib
import datetime
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    'download_github', TOOLS_ROOT / 'github/download_github.py'
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GitHubDownloadTests(unittest.TestCase):
    NOW = datetime.datetime(2026, 9, 5, 16, 0, 0)

    def git(self, directory, *args, check=True):
        return subprocess.run(
            ['git', '-C', str(directory), *args], check=check,
            capture_output=True, text=True,
        )

    def git_text(self, directory, *args):
        return self.git(directory, *args).stdout.strip()

    def identity(self, directory):
        self.git(directory, 'config', 'user.name', 'Download Test')
        self.git(directory, 'config', 'user.email', 'test@example.invalid')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-download-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.remote = base / 'remote.git'
        self.seed = base / 'seed'
        self.local = base / '本地项目'
        self.remote.mkdir()
        self.seed.mkdir()
        self.git(self.remote, 'init', '--bare', '--initial-branch=main')
        self.git(self.seed, 'init', '--initial-branch=main')
        self.identity(self.seed)
        (self.seed / '.gitignore').write_text('*.log\n*.cache\n')
        (self.seed / '程序包').mkdir()
        (self.seed / 'README.md').write_text('initial')
        (self.seed / '程序包/使用说明.md').write_text('keep before remote update')
        self.git(self.seed, 'add', '.')
        self.git(self.seed, 'commit', '-m', 'initial')
        self.git(self.seed, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.seed, 'push', 'origin', 'main')
        self.git(base, 'clone', str(self.remote), str(self.local))
        self.identity(self.local)
        (self.local / '开发包').mkdir()
        self.initial_head = self.git_text(self.local, 'rev-parse', 'HEAD')

    def advance_remote(self, message='remote update'):
        (self.seed / 'README.md').write_text('from GitHub')
        (self.seed / '程序包/目录导览.md').write_text('new remote file')
        (self.seed / '程序包/使用说明.md').unlink()
        self.git(self.seed, 'add', '--all', '.')
        self.git(self.seed, 'commit', '-m', message)
        self.git(self.seed, 'push', 'origin', 'main')
        return self.git_text(self.seed, 'rev-parse', 'HEAD')

    def sync(self, assume_yes=True):
        with contextlib.redirect_stdout(io.StringIO()):
            return MODULE.download(
                self.local, str(self.remote), assume_yes=assume_yes, now=self.NOW
            )

    def backup_refs(self):
        output = self.git_text(
            self.local, 'for-each-ref', '--format=%(refname:short)',
            'refs/heads/backup',
        )
        return [
            ref for ref in output.splitlines()
            if ref.startswith(MODULE.BACKUP_PREFIX)
        ] if output else []

    def test_remote_replaces_local_and_backup_preserves_working_files(self):
        remote_head = self.advance_remote()
        (self.local / 'README.md').write_text('staged local version')
        self.git(self.local, 'add', 'README.md')
        (self.local / 'README.md').write_text('latest local working version')
        (self.local / '开发包/README.md').write_text('untracked local file')
        (self.local / 'runtime.log').write_text('ignored cache stays in place')

        result = self.sync()

        self.assertTrue(result['changed'])
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), remote_head)
        self.assertEqual((self.local / 'README.md').read_text(), 'from GitHub')
        self.assertEqual((self.local / '程序包/目录导览.md').read_text(), 'new remote file')
        self.assertFalse((self.local / '程序包/使用说明.md').exists())
        self.assertFalse((self.local / '开发包/README.md').exists())
        self.assertEqual((self.local / 'runtime.log').read_text(), 'ignored cache stays in place')
        self.assertEqual(self.git_text(self.local, 'status', '--porcelain'), '')

        backup = result['backupBranch']
        self.assertEqual(self.backup_refs(), [backup])
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':README.md'),
            'latest local working version',
        )
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':开发包/README.md'),
            'untracked local file',
        )
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':程序包/使用说明.md'),
            'keep before remote update',
        )

    def test_cancel_leaves_local_files_and_branch_untouched(self):
        self.advance_remote()
        (self.local / 'README.md').write_text('do not replace')
        with mock.patch('builtins.input', return_value='NO'):
            result = self.sync(assume_yes=False)

        self.assertTrue(result['cancelled'])
        self.assertEqual((self.local / 'README.md').read_text(), 'do not replace')
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual(self.backup_refs(), [])

    def test_wrong_remote_is_rejected_before_local_mutation(self):
        (self.local / 'README.md').write_text('pending local work')
        self.git(self.local, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((self.local / 'README.md').read_text(), 'pending local work')
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual(self.backup_refs(), [])

    def test_already_current_does_not_create_redundant_backup(self):
        result = self.sync(assume_yes=False)
        self.assertFalse(result['changed'])
        self.assertFalse(result['cancelled'])
        self.assertIsNone(result['backupBranch'])
        self.assertEqual(self.backup_refs(), [])

    def test_remote_unknown_file_is_rejected_before_local_mutation(self):
        (self.local / 'important.cache').write_text('local ignored data')
        (self.seed / '.gitignore').write_text('*.log\n')
        (self.seed / 'important.cache').write_text('remote replacement')
        self.git(self.seed, 'add', '--all', '.')
        self.git(self.seed, 'commit', '-m', 'track former cache path')
        self.git(self.seed, 'push', 'origin', 'main')

        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((self.local / 'important.cache').read_text(), 'local ignored data')
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual(self.backup_refs(), [])

    def test_unignored_private_files_and_unknown_directories_survive_source_update(self):
        self.advance_remote()
        samples = ['私人备份/恢复点.json', '程序包/运行数据/认证/账号.sqlite3',
                   '未知内容/记事.txt', '程序包/主程序/server/.env', '创作包/新原稿.png']
        for relative in samples:
            target = self.local / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('private-test-only:' + relative)
        result = self.sync()
        self.assertTrue(result['changed'])
        for relative in samples:
            self.assertEqual((self.local / relative).read_text(), 'private-test-only:' + relative)
        files = self.git_text(self.local, 'ls-tree', '-r', '--name-only', result['backupBranch'])
        for relative in samples:
            self.assertNotIn(relative, files)

    def test_private_tracked_head_or_index_is_rejected_and_cannot_be_deleted_by_reset(self):
        for commit in (False, True):
            target = self.local / '程序包/运行数据/联机设置.json'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('private-test-only')
            self.git(self.local, 'add', str(target.relative_to(self.local)))
            if commit:
                self.git(self.local, 'commit', '-m', 'legacy private state')
            before_head = self.git_text(self.local, 'rev-parse', 'HEAD')
            before_index = self.git_text(self.local, 'write-tree')
            with self.assertRaises(MODULE.DownloadError):
                self.sync()
            self.assertEqual(target.read_text(), 'private-test-only')
            self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), before_head)
            self.assertEqual(self.git_text(self.local, 'write-tree'), before_index)
            self.assertEqual(self.backup_refs(), [])

    def test_remote_source_cannot_replace_local_directory_containing_private_files(self):
        self.advance_remote()
        target = self.local / '程序包/目录导览.md'
        target.mkdir()
        (target / 'private.sqlite3').write_text('private-test-only')
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((target / 'private.sqlite3').read_text(), 'private-test-only')
        self.assertEqual(self.backup_refs(), [])

    def test_private_untracked_files_do_not_create_redundant_backups(self):
        (self.local / 'private.txt').write_text('private-test-only')
        result = self.sync()
        self.assertFalse(result['changed'])
        self.assertEqual(self.backup_refs(), [])
        self.assertEqual((self.local / 'private.txt').read_text(), 'private-test-only')

    def test_remote_private_state_is_rejected_even_when_the_local_copy_is_untracked(self):
        relative = '程序包/运行数据/联机设置.json'
        for root, content in [(self.seed, 'remote-private'), (self.local, 'local-private')]:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        self.git(self.seed, 'add', relative)
        self.git(self.seed, 'commit', '-m', 'unsafe remote state')
        self.git(self.seed, 'push', 'origin', 'main')
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((self.local / relative).read_text(), 'local-private')
        self.assertEqual(self.backup_refs(), [])

    def test_remote_source_symlink_and_local_parent_link_both_stop_before_checkout(self):
        target = self.seed / '程序包/目录导览.md'
        target.symlink_to('../private.txt')
        self.git(self.seed, 'add', '程序包/目录导览.md')
        self.git(self.seed, 'commit', '-m', 'unsafe remote link')
        self.git(self.seed, 'push', 'origin', 'main')
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        target.unlink()
        self.advance_remote('replace with regular source')
        (self.local / '程序包/使用说明.md').unlink()
        (self.local / '程序包').rmdir()
        outside = self.local.parent / 'private-outside'
        outside.mkdir()
        (outside / '目录导览.md').write_text('do not overwrite')
        (self.local / '程序包').symlink_to(outside)
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((outside / '目录导览.md').read_text(), 'do not overwrite')
        self.assertEqual(self.backup_refs(), [])

    def test_failed_overwrite_restores_files_head_and_staging(self):
        remote_head = self.advance_remote()
        (self.local / 'README.md').write_text('staged version')
        self.git(self.local, 'add', 'README.md')
        (self.local / 'README.md').write_text('working version')
        (self.local / '开发包/README.md').write_text('restore me')
        status_before = self.git_text(self.local, 'status', '--porcelain')
        real_run = MODULE.subprocess.run
        failed = {'done': False}

        def fail_target_reset(args, *run_args, **run_kwargs):
            if (
                not failed['done']
                and args[:3] == ['git', 'reset', '--hard']
                and len(args) > 3 and args[3] == remote_head
            ):
                failed['done'] = True
                return subprocess.CompletedProcess(
                    args, 1, stdout='', stderr='simulated reset failure'
                )
            return real_run(args, *run_args, **run_kwargs)

        with mock.patch.object(MODULE.subprocess, 'run', side_effect=fail_target_reset):
            with self.assertRaises(MODULE.DownloadError):
                self.sync()

        self.assertTrue(failed['done'])
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual((self.local / 'README.md').read_text(), 'working version')
        self.assertEqual((self.local / '开发包/README.md').read_text(), 'restore me')
        self.assertEqual(self.git_text(self.local, 'show', ':README.md'), 'staged version')
        self.assertEqual(self.git_text(self.local, 'status', '--porcelain'), status_before)
        self.assertEqual(len(self.backup_refs()), 1)


if __name__ == '__main__':
    unittest.main()
