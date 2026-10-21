from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

APP = APP_ROOT
CHECKOUT = CHECKOUT_ROOT
SPEC = importlib.util.spec_from_file_location('package_paths_test', TOOLS_ROOT/'github/project_paths.py')
PATHS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PATHS)

class PackageLayoutTests(unittest.TestCase):
    def test_checkout_entries_keep_runtime_and_site_in_separate_roots(self):
        visible = {p.name for p in CHECKOUT.iterdir() if not p.name.startswith('.')}
        required = {
            '程序包','开发包',
            '启动桑哆尔之歌.command','启动桑哆尔之歌.bat','README.md',
            '网站',
        }
        self.assertTrue(required <= visible)
        # Local artifacts are not production modules or HTTP roots.
        self.assertTrue(visible <= required | {'创作包', 'output', 'outputs', 'tmp', '私人备份', '旧恢复备份', '旧发行包'})
        self.assertNotEqual(APP_ROOT, CHECKOUT / '网站')

    def test_daily_launchers_have_only_one_entry_per_platform(self):
        for folder in (CHECKOUT_ROOT, APP_ROOT):
            entries = {p.name for p in folder.iterdir() if p.suffix in ('.command', '.bat')}
            self.assertEqual(entries, {'启动桑哆尔之歌.command', '启动桑哆尔之歌.bat'})
        self.assertTrue((APP_ROOT / 'launch_entry.py').is_file())

    def test_package_separates_runtime_modules_guides_and_paused_client(self):
        visible = {path.name for path in PACKAGE_ROOT.iterdir() if not path.name.startswith('.')}
        folders = {'主程序'}
        guides = {'README.md','使用说明.md','目录导览.md','账号与角色规则.txt'}
        self.assertTrue(folders | guides <= visible)
        self.assertTrue(visible <= folders | guides | {'桌面端', '运行数据'})
        self.assertTrue((APP_ROOT/'defaults/日常小事/模块.json').is_file())
        for folder in folders:
            self.assertTrue((PACKAGE_ROOT / folder).is_dir())
        for guide in guides:
            self.assertTrue((PACKAGE_ROOT / guide).is_file())
        readme = (PACKAGE_ROOT / 'README.md').read_text(encoding='utf-8')
        self.assertIn('不依赖开发包与创作包', readme)
        for folder in folders:
            self.assertIn(folder, readme)

    def test_application_paths_keep_data_and_tools_outside_http_root(self):
        from server import paths
        self.assertEqual(paths.APP_ROOT, APP_ROOT)
        self.assertEqual(paths.PACKAGE_ROOT, PACKAGE_ROOT)
        self.assertEqual(paths.CHECKOUT_ROOT, CHECKOUT_ROOT)
        data_root = PACKAGE_ROOT / ('运行数据' if APP_ROOT.name == '主程序' else '用户数据')
        self.assertEqual(paths.USER_DATA_ROOT, data_root)
        self.assertEqual(paths.SAVE_ROOT, data_root / '存档')
        self.assertEqual(paths.CACHE_ROOT, data_root / '.sundoll-cache')
        self.assertEqual(paths.MUSIC_CACHE_ROOT, data_root / '音乐缓存')
        self.assertEqual(paths.ASSET_ROOT, APP_ROOT / 'asset')

    def test_checkout_locator_supports_nested_package_and_git_worktrees(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'项目 with spaces'
            origin=root/'开发包/github/github_sync.py'
            origin.parent.mkdir(parents=True)
            origin.write_text('')
            (root/'.git').write_text('gitdir: /unused')
            self.assertEqual(PATHS.checkout_root(origin),root.resolve())
            (root/'.git').unlink()
            with self.assertRaises(RuntimeError):PATHS.checkout_root(origin)

    def test_private_files_stay_ignored_and_formal_saves_remain_trackable(self):
        for relative in ('程序包/运行数据/战役空间/rtest/战役包/当前存档.json',
                         '程序包/运行数据/账号角色/角色.sqlite3',
                         '程序包/运行数据/安装级备份/test/数据.json',
                         '程序包/运行数据/迁移暂存-test/玩家包/当前档案.json'):
            result=subprocess.run(['git','check-ignore','--no-index','-q',relative],cwd=CHECKOUT)
            self.assertEqual(result.returncode,0,relative)
        for relative in ('程序包/运行数据/认证/check.json','程序包/用户数据/存档/玩家档案/认证/check.json','程序包/用户数据/存档/.server.lock','程序包/主程序/bin/cloudflared','程序包/用户数据/.sundoll-cache/check','旧恢复备份/check.json','旧发行包/check.zip'):
            result=subprocess.run(['git','check-ignore','--no-index','-q',relative],cwd=CHECKOUT)
            self.assertEqual(result.returncode,0,relative)
        result=subprocess.run(['git','check-ignore','--no-index','-q','程序包/用户数据/存档/战役/test/当前存档.json'],cwd=CHECKOUT)
        self.assertEqual(result.returncode,1)
