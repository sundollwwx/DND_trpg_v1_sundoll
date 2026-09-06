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
PORTRAIT_TOOL = (PROJECT_ROOT / 'asset' / '棋子库' / '棋子库.html').read_text(encoding='utf-8')
PORTRAIT_WORKFLOW = (PROJECT_ROOT / 'asset' / '棋子库' / '立绘制作流程.md').read_text(encoding='utf-8')


class ShellSimplificationTests(unittest.TestCase):
    def test_map_management_lives_in_sidebar_and_has_one_file_picker(self):
        self.assertNotIn('id="btn-map-browser-top"', HOST_HTML)
        self.assertIn('id="btn-map-browser-open"', HOST_HTML)
        map_card = re.search(r'<section class="card map-browser-card"[^>]*data-workspace="map"[\s\S]*?</section>', HOST_HTML)
        self.assertIsNotNone(map_card)
        self.assertIn('id="btn-map-browser-open"', map_card.group(0))
        self.assertNotIn('data-dropdown="map"', HOST_HTML)
        self.assertEqual(HOST_HTML.count('id="file-map-load"'), 1)
        self.assertIn('id="btn-map-browser-load"', HOST_HTML)
        for removed in ('stitch-modal', 'file-map-add', 'file-map-import', 'file-map-folder', 'perf-modal'):
            self.assertNotIn(f'id="{removed}"', HOST_HTML)

    def test_map_browser_keeps_tactical_scale_and_per_map_grid_visibility(self):
        for hook in ('dataset.mapDelete', 'dataset.mapRename', 'dataset.mapGridSize', 'dataset.mapGridVisible'):
            self.assertIn(hook, HOST_JS)
        self.assertIn('mapGridVisible(', HOST_JS)
        self.assertIn('gridVisible:', HOST_JS)
        self.assertIn('gridVisible', PLAYER_HTML)
        self.assertIn("gridSize: m.gridSize", HOST_JS)

    def test_grid_marker_and_fog_features_are_removed(self):
        self.assertIn('id="grid-toggle"', HOST_HTML)
        self.assertNotIn('id="grid-toggle"', PLAYER_HTML)
        for element_id in ('mark-toggle', 'fog-toggle', 'fog-canvas', 'fog-brush'):
            self.assertNotIn(f'id="{element_id}"', HOST_HTML)
            self.assertNotIn(f'id="{element_id}"', PLAYER_HTML)
        for removed in ('fog-reveal', 'fog-hide', 'btn-fog-hide-all', 'btn-fog-show-all'):
            self.assertNotIn(removed, HOST_HTML)
        self.assertNotIn('state.markMode', HOST_JS)
        self.assertNotIn('state.fogOn', HOST_JS)
        self.assertNotIn('function renderFog(', HOST_JS)
        self.assertNotIn('function renderFog(', PLAYER_HTML)
        self.assertIn("value !== 'marked'", HOST_JS)

    def test_network_controls_live_only_in_sidebar_room(self):
        for removed in ('data-menu="net"', 'btn-stream-dd', 'btn-stream-toggle', 'btn-stream-copy', 'net-info'):
            self.assertNotIn(removed, HOST_HTML)
        self.assertIn('id="btn-host-room-toggle"', HOST_HTML)
        self.assertIn('id="btn-host-room-copy"', HOST_HTML)
        for removed in ('server-url-input', 'server-check', 'server-copy', 'stream-push'):
            self.assertNotIn(removed, HOST_HTML)

    def test_map_shortcuts_live_in_the_topbar_in_task_order(self):
        topbar = re.search(r'<header id="topbar">([\s\S]*?)</header>', HOST_HTML)
        self.assertIsNotNone(topbar)
        markup = topbar.group(1)
        for element_id in (
            'btn-toggle-left-panel', 'map-select', 'map-quick-tools',
            'btn-map-reaction', 'btn-fit', 'host-connection', 'save-status',
        ):
            self.assertIn(f'id="{element_id}"', markup)
        self.assertNotIn('id="map-quick-drag"', HOST_HTML)
        self.assertLess(markup.index('id="btn-toggle-left-panel"'), markup.index('id="map-select"'))
        self.assertLess(markup.index('id="map-select"'), markup.index('id="map-quick-tools"'))
        self.assertLess(markup.index('id="map-quick-tools"'), markup.index('id="btn-fit"'))
        self.assertLess(markup.index('data-dropdown="save"'), markup.index('id="host-connection"'))
        board = re.search(r'<div id="board"[\s\S]*?</section>\s*</section>', HOST_HTML)
        self.assertIsNotNone(board)
        self.assertNotIn('id="map-quick-tools"', board.group(0))

    def test_music_shortcuts_live_in_a_collapsible_resource_card(self):
        topbar = re.search(r'<header id="topbar">([\s\S]*?)</header>', HOST_HTML)
        self.assertIsNotNone(topbar)
        self.assertNotIn('class="bgm-mini"', topbar.group(1))
        self.assertNotIn('id="btn-bgm-open"', topbar.group(1))
        music_card = re.search(
            r'<section class="card" id="bgm-card" data-workspace="resources"([^>]*)>([\s\S]*?)</section>',
            HOST_HTML,
        )
        self.assertIsNotNone(music_card)
        self.assertNotIn('data-no-collapse', music_card.group(1))
        for element_id in (
            'btn-bgm-open', 'bgm-mini-title', 'btn-bgm-mini-play',
            'btn-bgm-mini-stop', 'btn-bgm-resource-open',
        ):
            self.assertIn(f'id="{element_id}"', music_card.group(2))
        self.assertIn('选择歌单 / 打开完整播放器', music_card.group(2))

    def test_campaign_documents_are_private_collapsible_resources_above_music(self):
        document_card = re.search(
            r'<section class="card campaign-documents-card" id="campaign-documents-card" data-workspace="resources"([^>]*)>([\s\S]*?)</section>',
            HOST_HTML,
        )
        self.assertIsNotNone(document_card)
        self.assertNotIn('data-no-collapse', document_card.group(1))
        self.assertLess(HOST_HTML.index('id="campaign-documents-card"'), HOST_HTML.index('id="bgm-card"'))
        for element_id in (
            'campaign-document-quick-select', 'btn-campaign-documents-refresh',
            'btn-campaign-document-preview', 'btn-campaign-documents-open',
            'campaign-documents-dialog', 'campaign-documents-list',
            'campaign-document-docx', 'campaign-document-pdf',
        ):
            self.assertEqual(HOST_HTML.count(f'id="{element_id}"'), 1, element_id)
            self.assertNotIn(f'id="{element_id}"', PLAYER_HTML)

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

    def test_every_portrait_prompt_uses_a_real_circular_base(self):
        self.assertIn('明确画出一个完整圆形底板', PORTRAIT_TOOL)
        self.assertIn('圆形底板以外使用干净、均匀的纯白色', PORTRAIT_TOOL)
        self.assertIn('必须在画布正中央明确画出', PORTRAIT_WORKFLOW)
        self.assertNotIn('不要画出圆形底板', PORTRAIT_TOOL)
        self.assertNotIn('不要画出圆形底板', PORTRAIT_WORKFLOW)


if __name__ == '__main__':
    unittest.main()
