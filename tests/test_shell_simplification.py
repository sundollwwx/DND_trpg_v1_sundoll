import re
import struct
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = (PROJECT_ROOT / '主控台' / 'app.js').read_text(encoding='utf-8')
HOST_CSS = (PROJECT_ROOT / '主控台' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = (PROJECT_ROOT / '主控台' / '玩家.html').read_text(encoding='utf-8')
CONDITION_SPRITE = PROJECT_ROOT / 'asset' / '界面' / '状态图标-v1.png'


class ShellSimplificationTests(unittest.TestCase):
    def test_map_has_one_top_level_entry_and_one_file_picker(self):
        self.assertIn('id="btn-map-browser-top"', HOST_HTML)
        self.assertNotIn('data-dropdown="map"', HOST_HTML)
        self.assertEqual(HOST_HTML.count('id="file-map-load"'), 1)
        self.assertIn('id="btn-map-browser-load"', HOST_HTML)
        for removed in ('stitch-modal', 'file-map-add', 'file-map-import', 'file-map-folder', 'perf-modal'):
            self.assertNotIn(f'id="{removed}"', HOST_HTML)

    def test_map_browser_owns_management_and_per_map_grid(self):
        for hook in ('dataset.mapDelete', 'dataset.mapRename', 'dataset.mapGridVisible', 'dataset.mapGridSize'):
            self.assertIn(hook, HOST_JS)
        self.assertIn('gridVisible: gridVisible !== false', HOST_JS)
        self.assertIn('gridVisible: mapGridVisible(m)', HOST_JS)
        self.assertIn("typeof m.gridVisible==='boolean'?m.gridVisible:state.showGrid!==false", PLAYER_HTML)

    def test_network_menu_only_exposes_core_actions(self):
        menu = re.search(r'data-menu="net"[\s\S]*?</div>\s*</div>', HOST_HTML)
        self.assertIsNotNone(menu)
        actions = re.findall(r'data-action="([^"]+)"', menu.group(0))
        self.assertEqual(actions, ['stream', 'stream-copy'])
        for removed in ('server-url-input', 'server-check', 'server-copy', 'stream-push'):
            self.assertNotIn(removed, HOST_HTML)

    def test_condition_sprite_is_rgba_and_has_emoji_fallbacks(self):
        data = CONDITION_SPRITE.read_bytes()
        self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
        width, height = struct.unpack('>II', data[16:24])
        self.assertEqual((width, height), (1254, 1254))
        self.assertEqual(data[25], 6, 'PNG must use RGBA color type')
        self.assertIn("background: transparent", HOST_CSS)
        self.assertIn("badge.textContent = condition.icon || '◆'", HOST_JS)
        self.assertIn("badge.textContent=condition.icon||'◆'", PLAYER_HTML)
        self.assertIn('condition-pixels-ready', HOST_CSS)
        self.assertIn('condition-pixels-ready', PLAYER_HTML)


if __name__ == '__main__':
    unittest.main()
