"""The shared source policy cannot accidentally admit live/private data."""
from project_test_paths import TOOLS_ROOT
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(TOOLS_ROOT / 'github'))
from public_source import public_path, candidate_files


class PublicSourceTests(unittest.TestCase):
    def test_real_product_entries_rules_and_public_assets_are_allowed(self):
        for name in [
            'README.md', '.gitignore', '.gitattributes', '启动桑哆尔之歌.bat',
            '程序包/账号与角色规则.txt', '程序包/主程序/server/http_app.py',
            '程序包/主程序/defaults/日常小事/资料/climate.json',
            '程序包/主程序/邮箱账号设置.example.json',
            '程序包/主程序/asset/棋子库/棋子库.html',
            '程序包/主程序/asset/界面/品牌/桑哆尔之歌-logo.png',
            '网站/主站/_headers', '网站/主站/_redirects',
            '网站/announcement-template.html', '网站/留言板/worker.js',
            '开发包/tests/test_github_public_source.py',
        ]:
            self.assertTrue(public_path(name), name)

    def test_private_unknown_and_paused_paths_are_denied_even_when_nested(self):
        for name in [
            '程序包/运行数据/认证/邮箱账号.sqlite3',
            '程序包/战役包/campaign/当前存档.json',
            '程序包/玩家包/player/资源.json', '程序包/通用包/目录.json',
            '私人备份/recovery.zip', '创作包/流程.md', '其他/笔记.md',
            '程序包/主程序/server/.env', '程序包/主程序/server/secret.json',
            '程序包/主程序/server/credentials.json',
            '程序包/主程序/server/运行数据/令牌.json',
            '程序包/主程序/server/old.sqlite3', '程序包/主程序/bin/cloudflared',
            '程序包/主程序/asset/棋子库/立绘/角色.png',
            '程序包/桌面端/package.json', '开发包/build_desktop.py',
            '开发包/tests/test_desktop_assets.cjs',
            '开发包/tests/test_visual_creation_standards.py',
            '开发包/维护记录/账号映射.json',
            '网站/留言板/.wrangler/config.json',
            '网站/主站/node_modules/library/index.js',
            '网站/主站/Node_Modules/library/index.js',
        ]:
            self.assertFalse(public_path(name), name)

    def test_noncanonical_names_cannot_escape_the_source_root(self):
        for name in ['/README.md', '../README.md', '网站/../README.md',
                     './README.md', '网站//主站/site.js', '网站\\主站\\site.js',
                     '网站/主站/site.js:private', '', None, 'README.md\0']:
            self.assertFalse(public_path(name), name)

    def test_candidates_ignore_unknown_private_files_and_refuse_source_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['README.md', '网站/主站/site.js', '未知目录/private.json',
                         '程序包/运行数据/存档/工作区.json']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('test-only')
            self.assertEqual(candidate_files(root), ['README.md', '网站/主站/site.js'])
            (root / 'README.md').unlink()
            (root / 'README.md').symlink_to('未知目录/private.json')
            with self.assertRaisesRegex(ValueError, '普通文件'):
                candidate_files(root)


if __name__ == '__main__':
    unittest.main()
