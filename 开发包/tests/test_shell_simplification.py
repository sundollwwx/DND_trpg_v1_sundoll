from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
from client_sources import read_client_source
import re
import struct
import unittest
from pathlib import Path


PROJECT_ROOT = APP_ROOT
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = read_client_source((PROJECT_ROOT / '主控台' / 'host' / 'app.js'))
HOST_CSS = (PROJECT_ROOT / '主控台' / 'host' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = read_client_source((PROJECT_ROOT / '主控台' / '玩家.html'))
PLAYER_JS = read_client_source((PROJECT_ROOT / '主控台' / 'player' / 'player.js'))
CONDITION_SPRITE = PROJECT_ROOT / 'asset' / '界面' / '状态图标-v1.png'
PORTRAIT_TOOL = (PROJECT_ROOT / 'asset' / '棋子库' / '棋子库.html').read_text(encoding='utf-8')
MAP_PROMPT_STUDIO = (PROJECT_ROOT / 'asset' / '地图' / '地图创作台.html').read_text(encoding='utf-8')
PREP_JS = (PROJECT_ROOT / '主控台' / 'host' / 'prep-handbook.js').read_text(encoding='utf-8')
PREP_CSS = (PROJECT_ROOT / '主控台' / 'host' / 'prep-handbook.css').read_text(encoding='utf-8')


class ShellSimplificationTests(unittest.TestCase):
    def test_map_management_lives_in_sidebar_and_has_one_file_picker(self):
        self.assertNotIn('id="btn-map-browser-top"', HOST_HTML)
        self.assertIn('id="btn-map-browser-open"', HOST_HTML)
        map_card = re.search(r'<section class="card scene-shortcuts"[\s\S]*?</section>', HOST_HTML)
        self.assertIsNotNone(map_card)
        self.assertIn('id="btn-map-browser-open"', map_card.group(0))
        self.assertNotIn('data-dropdown="map"', HOST_HTML)
        self.assertEqual(HOST_HTML.count('id="file-map-load"'), 1)
        self.assertIn('id="btn-map-browser-load"', HOST_HTML)
        self.assertIn('id="btn-map-prompt-studio"', HOST_HTML)
        self.assertIn('href="../asset/地图/地图创作台.html"', HOST_HTML)
        self.assertNotIn('id="btn-map-prompt-studio" class="map-prompt-studio-button" href="../asset/地图/地图创作台.html" target=', HOST_HTML)
        for removed in ('stitch-modal', 'file-map-add', 'file-map-import', 'file-map-folder', 'perf-modal'):
            self.assertNotIn(f'id="{removed}"', HOST_HTML)

    def test_map_prompt_studio_replaces_the_old_tile_editor(self):
        self.assertFalse((PROJECT_ROOT / 'asset' / '地图' / '地图工坊.html').exists())
        for text in (
            '桑哆尔统一战术地图', 'STRICT ORTHOGRAPHIC TOP-DOWN CAMERA',
            'CONTINUITY ANCHOR', '负向提示词', '状态变体',
            '不连接外部模型', '不写入正式战役', 'SD-ART 1.0',
            'SD-MAP 1.1', 'ONE complete map', 'floor thumbnails',
        ):
            self.assertIn(text, MAP_PROMPT_STUDIO)
        self.assertIn("schema:SCHEMA", MAP_PROMPT_STUDIO)
        self.assertIn("sundoll-map-prompt-project@1", MAP_PROMPT_STUDIO)

    def test_player_has_direct_character_library_entry(self):
        self.assertEqual(PLAYER_HTML.count('id="btn-player-library"'), 1)
        self.assertIn("$('#btn-player-library').onclick=()=>PlayerLibrary.open({ownedPieceId:myCharacterId,edit:false})", PLAYER_JS)

    def test_legacy_library_snapshot_tools_are_demoted_to_recovery(self):
        header = re.search(r'<header>([\s\S]*?)</header>', PORTRAIT_TOOL)
        self.assertIsNotNone(header)
        self.assertNotIn('id="btn-export"', header.group(1))
        self.assertNotIn('id="btn-import"', header.group(1))
        self.assertIn('<summary>高级恢复工具</summary>', PORTRAIT_TOOL)
        self.assertIn('导出 JSON 快照', PORTRAIT_TOOL)
        self.assertIn('从 JSON 替换', PORTRAIT_TOOL)
        self.assertNotIn('程序包/应用/asset/棋子库', PORTRAIT_TOOL)

    def test_host_flow_bar_uses_compact_open_heights(self):
        heights = re.findall(r'#init-bar\s*\{\s*--flow-open-height:\s*(\d+)px', HOST_CSS)
        self.assertEqual(heights[-3:], ['210', '226', '296'])
        for breakpoint, height in ((1180, 226), (900, 296)):
            self.assertRegex(HOST_CSS,
                             rf'@media\s*\(max-width:\s*{breakpoint}px\)\s*\{{\s*'
                             rf'#init-bar\s*\{{\s*--flow-open-height:\s*{height}px')
        self.assertRegex(HOST_CSS, r'#init-bar:not\(\.collapsed\)\s*\{\s*height:\s*var\(--flow-open-height\)')
        self.assertRegex(HOST_CSS, r'#init-bar\.collapsed \.init-body\s*\{\s*display:\s*none')
        self.assertRegex(HOST_CSS, r'\.init-panel\s*\{\s*overflow-y:\s*auto')
        self.assertIn('#init-bar.collapsed .init-readout', HOST_CSS)

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

    def test_map_shortcuts_open_the_scene_dialog(self):
        card = re.search(r'<section class="card scene-shortcuts"[\s\S]*?</section>', HOST_HTML)
        self.assertIsNotNone(card)
        for hook in ('btn-map-browser-open', 'btn-grid-settings-open', 'btn-bgm-open'):
            self.assertIn(f'id="{hook}"', card.group(0))
        for hook in ('map-browser-modal','map-thumbnail-strip','btn-map-browser-present'):
            self.assertEqual(HOST_HTML.count(f'id="{hook}"'),1)

    def test_music_uses_sidebar_shortcut_and_separate_player(self):
        self.assertNotIn('id="bgm-card"', HOST_HTML)
        self.assertEqual(HOST_HTML.count('id="btn-bgm-open"'),1)
        self.assertIn('<dialog id="bgm-player"', HOST_HTML)
        self.assertLess(HOST_HTML.index('id="btn-doodle-undo"'), HOST_HTML.index('id="btn-bgm-open"'))

    def test_campaign_documents_are_private_collapsible_resources(self):
        document_card = re.search(
            r'<section class="card campaign-documents-card" id="campaign-documents-card" data-workspace="resources"([^>]*)>([\s\S]*?)</section>',
            HOST_HTML,
        )
        self.assertIsNotNone(document_card)
        self.assertNotIn('data-no-collapse', document_card.group(1))
        self.assertIn('data-default-collapsed', document_card.group(1))
        for element_id in (
            'campaign-document-quick-select', 'btn-campaign-documents-refresh',
            'btn-campaign-document-preview', 'btn-campaign-documents-open',
            'campaign-documents-dialog', 'campaign-documents-list',
            'campaign-document-docx', 'campaign-document-pdf',
        ):
            self.assertEqual(HOST_HTML.count(f'id="{element_id}"'), 1, element_id)
            self.assertNotIn(f'id="{element_id}"', PLAYER_HTML)

    def test_resource_cards_start_collapsed_and_prep_opens_from_scene_shortcut(self):
        for card_id in ('journal-card', 'campaign-documents-card', 'links-card', 'shared-note-card'):
            tag = re.search(rf'<section[^>]*id="{card_id}"[^>]*>', HOST_HTML)
            self.assertIsNotNone(tag, card_id)
            self.assertIn('data-default-collapsed', tag.group(0), card_id)
        self.assertNotIn('id="prep-card"', HOST_HTML)
        scene = re.search(r'<section class="card scene-shortcuts"[^>]*>([\s\S]*?)</section>', HOST_HTML)
        self.assertIsNotNone(scene)
        self.assertIn('data-workspace="scene"', scene.group(0))
        self.assertIn('id="btn-prep-open"', scene.group(1))
        self.assertIn('aria-controls="prep-dialog"', scene.group(1))
        self.assertNotIn('id="btn-prep-open"', PLAYER_HTML)
        dialog = re.search(r'<dialog[^>]*id="prep-dialog"[^>]*>', HOST_HTML)
        self.assertIsNotNone(dialog)
        self.assertNotRegex(dialog.group(0), r'\sopen(?:\s|=|>)')
        dialog_style = re.search(r'#prep-dialog\s*\{([^}]+)\}', PREP_CSS)
        self.assertIsNotNone(dialog_style)
        self.assertNotRegex(dialog_style.group(1), r'(?:^|;)\s*display\s*:',
                            'Keep the native closed-dialog display behavior')
        self.assertIn("$('btn-prep-open').onclick=()=>open('areas')", PREP_JS)
        self.assertIn("if(!$('prep-dialog').open)$('prep-dialog').showModal()", PREP_JS)
        self.assertIn("$('prep-close').onclick=()=>$('prep-dialog').close()", PREP_JS)

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

    def test_every_portrait_prompt_uses_full_square_background_and_program_crop(self):
        self.assertIn('SD-PORTRAIT 2.0', PORTRAIT_TOOL)
        self.assertIn('PARCHMENT-SQUARE-2', PORTRAIT_TOOL)
        self.assertIn('满幅1:1方形羊皮纸', PORTRAIT_TOOL)
        self.assertIn('不要绘制圆形底板', PORTRAIT_TOOL)
        self.assertIn('圆形外观由程序统一裁切，原图完整保存', PORTRAIT_TOOL)
        self.assertIn('一次生成一张', PORTRAIT_TOOL)
        self.assertNotIn('id="portrait-style"', PORTRAIT_TOOL)
        self.assertNotIn('id="portrait-background"', PORTRAIT_TOOL)
        self.assertNotIn('明确画出一个完整圆形底板', PORTRAIT_TOOL)
        self.assertNotIn('圆外背景均匀纯白', PORTRAIT_TOOL)
        for color in ('#D9B574', '#E7CB93', '#B58B50'):
            self.assertIn(color, PORTRAIT_TOOL)


if __name__ == '__main__':
    unittest.main()
