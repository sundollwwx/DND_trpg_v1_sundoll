import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import github_sync as SYNC


class ShortcutTests(unittest.TestCase):
    def run_action(self, action, answer=''):
        def git(root, *args):
            if '--show-toplevel' in args: return str(ROOT)
            if 'symbolic-ref' in args: return 'main'
            if 'remote' in args: return SYNC.REPOSITORY
            return ''
        with mock.patch.object(SYNC, 'git', side_effect=git), mock.patch.object(SYNC, 'sync_lock', return_value=contextlib.nullcontext()), mock.patch('builtins.input', return_value=answer), mock.patch.object(SYNC, 'upload') as upload, mock.patch.object(SYNC, 'download') as download, contextlib.redirect_stdout(io.StringIO()):
            result = SYNC.main([action])
            return result, upload.call_count, download.call_count

    def test_upload_cancel_has_no_mutation(self):
        self.assertEqual(self.run_action('upload'), (0, 0, 0))

    def test_upload_confirm_dispatches_only_upload(self):
        self.assertEqual(self.run_action('upload', 'YES'), (0, 1, 0))

    def test_download_dispatches_only_download(self):
        self.assertEqual(self.run_action('download'), (0, 0, 1))

    def test_check_never_synchronizes(self):
        self.assertEqual(self.run_action('check'), (0, 0, 0))

    def test_lock_prevents_concurrent_sync_and_releases_afterwards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(SYNC, 'git', return_value=str(root / 'sync.lock')):
                with SYNC.sync_lock(root):
                    with self.assertRaises(RuntimeError):
                        with SYNC.sync_lock(root): pass
                with SYNC.sync_lock(root): pass
