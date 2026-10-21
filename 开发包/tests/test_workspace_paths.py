"""Keep maintenance/test workspace isolation without a separate product mode."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from project_test_paths import APP_ROOT


class WorkspacePathTests(unittest.TestCase):
    def probe(self, workspace=None):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(APP_ROOT))
        env.pop('SUNDOLL_WORKSPACE_ROOT', None)
        env.pop('SUNDOLL_TEST_SAVE_ROOT', None)
        if workspace is not None:
            env['SUNDOLL_WORKSPACE_ROOT'] = str(workspace)
            env['SUNDOLL_TEST_SAVE_ROOT'] = '/unrelated/test/save'
        return subprocess.run([sys.executable, '-c',
            'import json; from server import paths as p; '
            'print(json.dumps(dict(save=p.local_save_root(),cache=str(p.CACHE_ROOT),'
            'music=str(p.MUSIC_CACHE_ROOT),root=str(p.USER_DATA_ROOT),id=p.project_id())))'],
            env=env, capture_output=True, text=True)

    def test_explicit_workspace_is_isolated_and_import_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'isolated'
            result = self.probe(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            for key, suffix in [('save', '存档'), ('cache', '.sundoll-cache'), ('music', '音乐缓存')]:
                self.assertEqual(value[key], str(root / '运行数据' / suffix))
            self.assertEqual(value['root'], str(root / '运行数据'))
            self.assertFalse(root.exists())

    def test_product_identity_is_unchanged_and_workspaces_are_distinct(self):
        value = json.loads(self.probe().stdout)
        self.assertEqual(value['id'], hashlib.sha256(os.path.normcase(os.path.realpath(APP_ROOT)).encode()).hexdigest())
        with tempfile.TemporaryDirectory() as temporary:
            ids = [json.loads(self.probe(Path(temporary) / name).stdout)['id'] for name in ('a', 'b')]
        self.assertEqual(len(set([value['id'], *ids])), 3)

    def test_relative_workspace_is_rejected(self):
        result = self.probe('relative')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('绝对路径', result.stderr)
