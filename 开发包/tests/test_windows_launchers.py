from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import unittest
from pathlib import Path


PROJECT_ROOT = APP_ROOT
START_BAT = CHECKOUT_ROOT / '启动桑哆尔之歌.bat'
UPLOAD_BAT = TOOLS_ROOT / 'github/一键上传GitHub.bat'
DOWNLOAD_BAT = TOOLS_ROOT / 'github/一键从GitHub覆盖本地.bat'
DOWNLOAD_COMMAND = TOOLS_ROOT / 'github/一键从GitHub覆盖本地.command'


class WindowsLauncherTests(unittest.TestCase):
    def read_batch(self, path):
        raw = path.read_bytes()
        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), f'{path.name} 不应带 UTF-8 BOM')
        self.assertIn(b'\r\n', raw, f'{path.name} 应使用 Windows CRLF 换行')
        self.assertNotIn(b'\n', raw.replace(b'\r\n', b''), f'{path.name} 含有非 CRLF 换行')
        return raw.decode('utf-8')

    def assert_common_bootstrap(self, source, minimum=7):
        self.assertIn('chcp 65001 >nul', source)
        self.assertIn('setlocal EnableExtensions DisableDelayedExpansion', source)
        self.assertIn('pushd "%~dp0" >nul 2>nul', source)
        self.assertIn('popd', source)
        self.assertNotIn('cd /d "%~dp0"', source)
        for command in ('py -3', 'python', 'python3'):
            probe = (
                f'{command} -c "import sys; print(\'SUNDOLL_PY_OK\' if '
                f'sys.version_info >= (3, {minimum}) else \'\')" 2>nul | '
                'findstr /x /c:"SUNDOLL_PY_OK" >nul'
            )
            self.assertIn(probe, source)
        self.assertIn('PYTHONIOENCODING=utf-8', source)
        self.assertIn('PYTHONUTF8=1', source)
        self.assertIn(':bad_project_dir', source)

    def test_multiplayer_launcher_is_windows_safe(self):
        for entry in (START_BAT, APP_ROOT / START_BAT.name):
            source = self.read_batch(entry)
            self.assert_common_bootstrap(source, 9 if APP_ROOT.name == '主程序' else 7)
            for python in ('py -3', 'python', 'python3'):
                self.assertIn(f'{python} -u "%SUNDOLL_ENGINE%" %*', source)
            self.assertIn('set "SUNDOLL_ENGINE=launch_entry.py"', source)
            self.assertIn('set "SUNDOLL_ENGINE=程序包\\主程序\\launch_entry.py"', source)
            self.assertIn('模块.json', source)
            self.assertIn('endlocal & exit /b %EXIT_CODE%', source)
        self.assertEqual(START_BAT.read_bytes(), (APP_ROOT / START_BAT.name).read_bytes())

    def test_upload_launcher_is_windows_safe(self):
        source = self.read_batch(UPLOAD_BAT)
        self.assert_common_bootstrap(source)
        self.assertIn('py -3 "github_sync.py" upload %*', source)
        self.assertIn('python "github_sync.py" upload %*', source)
        self.assertIn('python3 "github_sync.py" upload %*', source)
        self.assertIn('endlocal & exit /b %UPLOAD_STATUS%', source)

    def test_download_launcher_is_windows_safe(self):
        source = self.read_batch(DOWNLOAD_BAT)
        self.assert_common_bootstrap(source)
        self.assertIn('py -3 "github_sync.py" download %*', source)
        self.assertIn('python "github_sync.py" download %*', source)
        self.assertIn('python3 "github_sync.py" download %*', source)
        self.assertIn('endlocal & exit /b %DOWNLOAD_STATUS%', source)

    def test_download_launcher_is_executable_on_macos(self):
        source = DOWNLOAD_COMMAND.read_text(encoding='utf-8')
        self.assertTrue(DOWNLOAD_COMMAND.stat().st_mode & 0o111)
        self.assertIn("sys.version_info >= (3, 7)", source)
        self.assertIn('"${PYTHON_BIN}" "github_sync.py" download "$@"', source)
        self.assertIn('read -r -p "按回车关闭窗口……"', source)

    def test_legacy_brand_filenames_are_gone(self):
        legacy = '桑' + '多尔'
        self.assertTrue(START_BAT.is_file())
        self.assertTrue((CHECKOUT_ROOT / '启动桑哆尔之歌.command').is_file())
        self.assertTrue((PROJECT_ROOT / 'asset' / '界面' / '品牌' / '桑哆尔之歌-logo.png').is_file())
        self.assertFalse((CHECKOUT_ROOT / f'启动{legacy}之歌.bat').exists())
        self.assertFalse((CHECKOUT_ROOT / f'启动{legacy}之歌.command').exists())
        self.assertFalse((PROJECT_ROOT / 'asset' / '界面' / '品牌' / f'{legacy}之歌-logo.png').exists())


if __name__ == '__main__':
    unittest.main()
