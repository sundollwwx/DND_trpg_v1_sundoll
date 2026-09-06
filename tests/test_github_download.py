"""Exercise GitHub-to-local replacement only inside disposable repositories."""

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
    'download_github', Path(__file__).resolve().parents[1] / 'download_github.py'
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
        (self.seed / 'old.txt').write_text('initial')
        (self.seed / 'removed.txt').write_text('keep before remote update')
        self.git(self.seed, 'add', '.')
        self.git(self.seed, 'commit', '-m', 'initial')
        self.git(self.seed, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.seed, 'push', 'origin', 'main')
        self.git(base, 'clone', str(self.remote), str(self.local))
        self.identity(self.local)
        self.initial_head = self.git_text(self.local, 'rev-parse', 'HEAD')

    def advance_remote(self, message='remote update'):
        (self.seed / 'old.txt').write_text('from GitHub')
        (self.seed / 'remote-only.txt').write_text('new remote file')
        (self.seed / 'removed.txt').unlink()
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
        (self.local / 'old.txt').write_text('staged local version')
        self.git(self.local, 'add', 'old.txt')
        (self.local / 'old.txt').write_text('latest local working version')
        (self.local / 'local-only.txt').write_text('untracked local file')
        (self.local / 'runtime.log').write_text('ignored cache stays in place')

        result = self.sync()

        self.assertTrue(result['changed'])
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), remote_head)
        self.assertEqual((self.local / 'old.txt').read_text(), 'from GitHub')
        self.assertEqual((self.local / 'remote-only.txt').read_text(), 'new remote file')
        self.assertFalse((self.local / 'removed.txt').exists())
        self.assertFalse((self.local / 'local-only.txt').exists())
        self.assertEqual((self.local / 'runtime.log').read_text(), 'ignored cache stays in place')
        self.assertEqual(self.git_text(self.local, 'status', '--porcelain'), '')

        backup = result['backupBranch']
        self.assertEqual(self.backup_refs(), [backup])
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':old.txt'),
            'latest local working version',
        )
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':local-only.txt'),
            'untracked local file',
        )
        self.assertEqual(
            self.git_text(self.local, 'show', backup + ':removed.txt'),
            'keep before remote update',
        )

    def test_cancel_leaves_local_files_and_branch_untouched(self):
        self.advance_remote()
        (self.local / 'old.txt').write_text('do not replace')
        with mock.patch('builtins.input', return_value='NO'):
            result = self.sync(assume_yes=False)

        self.assertTrue(result['cancelled'])
        self.assertEqual((self.local / 'old.txt').read_text(), 'do not replace')
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual(self.backup_refs(), [])

    def test_wrong_remote_is_rejected_before_local_mutation(self):
        (self.local / 'old.txt').write_text('pending local work')
        self.git(self.local, 'remote', 'set-url', 'origin', 'https://example.invalid/other.git')
        with self.assertRaises(MODULE.DownloadError):
            self.sync()
        self.assertEqual((self.local / 'old.txt').read_text(), 'pending local work')
        self.assertEqual(self.git_text(self.local, 'rev-parse', 'HEAD'), self.initial_head)
        self.assertEqual(self.backup_refs(), [])

    def test_already_current_does_not_create_redundant_backup(self):
        result = self.sync(assume_yes=False)
        self.assertFalse(result['changed'])
        self.assertFalse(result['cancelled'])
        self.assertIsNone(result['backupBranch'])
        self.assertEqual(self.backup_refs(), [])

    def test_ignored_file_that_remote_will_overwrite_is_backed_up(self):
        (self.local / 'important.cache').write_text('local ignored data')
        (self.seed / '.gitignore').write_text('*.log\n')
        (self.seed / 'important.cache').write_text('remote replacement')
        self.git(self.seed, 'add', '--all', '.')
        self.git(self.seed, 'commit', '-m', 'track former cache path')
        self.git(self.seed, 'push', 'origin', 'main')

        result = self.sync()

        self.assertEqual((self.local / 'important.cache').read_text(), 'remote replacement')
        self.assertEqual(
            self.git_text(self.local, 'show', result['backupBranch'] + ':important.cache'),
            'local ignored data',
        )

    def test_failed_overwrite_restores_files_head_and_staging(self):
        remote_head = self.advance_remote()
        (self.local / 'old.txt').write_text('staged version')
        self.git(self.local, 'add', 'old.txt')
        (self.local / 'old.txt').write_text('working version')
        (self.local / 'local-only.txt').write_text('restore me')
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
        self.assertEqual((self.local / 'old.txt').read_text(), 'working version')
        self.assertEqual((self.local / 'local-only.txt').read_text(), 'restore me')
        self.assertEqual(self.git_text(self.local, 'show', ':old.txt'), 'staged version')
        self.assertEqual(self.git_text(self.local, 'status', '--porcelain'), status_before)
        self.assertEqual(len(self.backup_refs()), 1)


if __name__ == '__main__':
    unittest.main()
