import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = (PROJECT_ROOT / '主控台' / 'app.js').read_text(encoding='utf-8')
HOST_CSS = (PROJECT_ROOT / '主控台' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = (PROJECT_ROOT / '主控台' / '玩家.html').read_text(encoding='utf-8')
SERVER_PY = (PROJECT_ROOT / '主控台' / '联机服务器.py').read_text(encoding='utf-8')
BRAND_LOGO = PROJECT_ROOT / 'asset' / '界面' / '品牌' / '桑多尔之歌-logo.png'


def function_body(source, name, next_name):
    match = re.search(
        rf'(?:async\s+)?function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{([\s\S]*?)\n\s*(?:async\s+)?function\s+{re.escape(next_name)}\s*\(',
        source,
    )
    if not match:
        raise AssertionError(f'Function {name} was not found')
    return match.group(1)


class HomeEntryTests(unittest.TestCase):
    def test_brand_name_and_logo_are_shared_by_host_and_player(self):
        self.assertTrue(BRAND_LOGO.is_file())
        self.assertIn('<title>桑多尔之歌 · 主控台</title>', HOST_HTML)
        self.assertIn('<title>桑多尔之歌 · 玩家端</title>', PLAYER_HTML)
        for source in (HOST_HTML, PLAYER_HTML):
            self.assertGreaterEqual(source.count('../asset/界面/品牌/桑多尔之歌-logo.png'), 2)
            self.assertNotIn('桑哆尔跑团', source)
            self.assertNotIn('🐉 桑哆尔', source)

    def test_host_home_has_one_clear_campaign_entry_surface(self):
        for element_id in (
            'cover', 'cover-current', 'cover-continue', 'cover-load', 'cover-new',
            'cover-temp', 'cover-new-form', 'cover-folder', 'cover-recent',
            'cover-storage-status', 'cover-feedback',
        ):
            self.assertEqual(HOST_HTML.count(f'id="{element_id}"'), 1, element_id)
        self.assertIn('data-action="home"', HOST_HTML)
        self.assertIn("case 'home': showCover()", HOST_JS)
        self.assertIn('function refreshHostHome(', HOST_JS)
        self.assertIn('function renderCoverRecent(', HOST_JS)
        self.assertIn('function chooseCampaignCover(', HOST_JS)
        self.assertIn('function prepareCampaignCover(', HOST_JS)
        self.assertIn("localSaveApiRequest('write-binary'", HOST_JS)
        self.assertIn("const CAMPAIGN_COVER_FILES = ['封面.webp', '封面.jpg', '封面.jpeg', '封面.png']", HOST_JS)
        self.assertIn('cover-recent-art', HOST_CSS)
        self.assertIn('cover-image-action', HOST_CSS)
        self.assertNotIn("prompt('新战役名称'", HOST_JS)
        self.assertIn('var(--cover-background-image)', HOST_CSS)
        self.assertIn('id="cover-theme-picker"', HOST_HTML)
        for theme in 'abcd':
            self.assertIn(f'data-cover-theme="{theme}"', HOST_HTML)
            self.assertTrue(
                (PROJECT_ROOT / 'asset' / '界面' / '主页背景' / f'{theme}-主控台.jpg').is_file()
            )
            self.assertIn(f"{theme}: {{ label:", HOST_JS)

    def test_host_home_uses_the_single_bound_save_folder(self):
        self.assertIn('fetch(LOCAL_SAVE_API_PATH', HOST_JS)
        self.assertIn("LOCAL_SAVE_API_HEADER = 'X-Sundoll-Local-Save'", HOST_JS)
        self.assertIn("localSaveApiRequest('status')", HOST_JS)
        self.assertIn('projectDirHandle = LOCAL_SAVE_BRIDGE_HANDLE', HOST_JS)
        self.assertIn("self.path == '/api/local-save'", SERVER_PY)
        self.assertIn('await hasSaveFolderPermission()', HOST_JS)
        self.assertIn('await readCampaignRecords(options.forceRecords === true)', HOST_JS)
        self.assertIn('await ensureSaveFolderAccess(true)', HOST_JS)
        self.assertIn("await campaignPut(id, name, snap, { backup: false })", HOST_JS)

    def test_player_home_is_visible_before_entering(self):
        for element_id in (
            'join-mask', 'join-server-status', 'join-campaign-name', 'join-room-code',
            'join-map-name', 'join-player-count', 'join-form', 'join-name', 'join-room',
            'join-submit', 'join-refresh', 'join-session-hint', 'join-campaign-card',
            'join-campaign-cover',
        ):
            self.assertEqual(PLAYER_HTML.count(f'id="{element_id}"'), 1, element_id)
        join_tag = re.search(r'<div id="join-mask"[^>]*>', PLAYER_HTML)
        self.assertIsNotNone(join_tag)
        self.assertNotIn(' hidden', join_tag.group(0))
        self.assertIn('var(--join-background-image)', PLAYER_HTML)
        self.assertIn('function applyJoinCampaignCover(', PLAYER_HTML)
        self.assertIn('applyJoinCampaignCover(info.campaignCoverUrl)', PLAYER_HTML)
        self.assertRegex(
            PLAYER_HTML,
            r'\.join-campaign-card\s*\{[^}]*aspect-ratio\s*:\s*16\s*/\s*9',
        )
        self.assertIn("'campaignCoverUrl':", SERVER_PY)
        self.assertIn("state['_campaignCoverUrl'] = campaign_cover_asset_url(state)", SERVER_PY)
        self.assertIn('id="join-theme-picker"', PLAYER_HTML)
        for theme in 'abcd':
            self.assertIn(f'data-join-theme="{theme}"', PLAYER_HTML)
            self.assertTrue(
                (PROJECT_ROOT / 'asset' / '界面' / '主页背景' / f'{theme}-玩家端.jpg').is_file()
            )

    def test_home_background_is_random_per_entry_and_manual_for_this_page_only(self):
        host_random = function_body(HOST_JS, 'randomizeCoverTheme', 'initCoverThemePicker')
        host_show = function_body(HOST_JS, 'showCover', 'updateCoverContinue')
        self.assertIn('Math.random()', host_random)
        self.assertIn('randomizeCoverTheme()', host_show)
        self.assertIn('initCoverThemePicker();', HOST_JS)
        self.assertNotIn('localStorage', host_random)

        player_random = function_body(
            PLAYER_HTML, 'randomizeJoinHomeTheme', 'initJoinHomeThemePicker'
        )
        player_bootstrap = function_body(PLAYER_HTML, 'bootstrapSession', 'sendPresence')
        player_leave = function_body(PLAYER_HTML, 'leaveSession', 'mine')
        self.assertIn('Math.random()', player_random)
        self.assertIn('randomizeJoinHomeTheme()', player_bootstrap)
        self.assertIn('randomizeJoinHomeTheme()', player_leave)
        self.assertIn('initJoinHomeThemePicker();', PLAYER_HTML)
        self.assertNotIn('localStorage', player_random)

    def test_home_has_no_non_interactive_pseudo_navigation_or_duplicate_feature_cards(self):
        for obsolete in ('cover-tabs', 'cover-project-tags', 'cover-about'):
            self.assertNotIn(obsolete, HOST_HTML)
            self.assertNotIn(obsolete, HOST_CSS)
        for obsolete in ('join-tabs', 'join-feature-list', 'join-about'):
            self.assertNotIn(obsolete, PLAYER_HTML)

    def test_player_refresh_does_not_auto_enter_or_open_stream(self):
        bootstrap = function_body(PLAYER_HTML, 'bootstrapSession', 'sendPresence')
        self.assertIn("$('#join-mask').hidden=false", bootstrap)
        self.assertIn('refreshPlayerHome()', bootstrap)
        self.assertIn('validateStoredSession()', bootstrap)
        self.assertNotIn('joinSession(', bootstrap)
        self.assertNotIn('connectStream(', bootstrap)
        self.assertIn('bootstrapSession();', PLAYER_HTML)
        self.assertNotIn('bootstrapSession().then', PLAYER_HTML)

        preview = function_body(PLAYER_HTML, 'refreshPlayerHome', 'bootstrapSession')
        self.assertIn("fetch('/api/info'", preview)
        self.assertNotIn("fetch('/api/state'", preview)
        self.assertIn("'campaignName': snapshot.get('campaignName')", SERVER_PY)
        self.assertIn("'activeMapName': active_map.get('name')", SERVER_PY)

    def test_player_enters_then_connects_and_switch_player_closes_stream(self):
        self.assertIn("await joinSession($('#join-name').value,$('#join-room').value,!!sessionToken);connectStream();", PLAYER_HTML)
        leave = function_body(PLAYER_HTML, 'leaveSession', 'mine')
        self.assertIn('streamES.close()', leave)
        self.assertIn('clearStoredSession()', leave)
        self.assertIn("$('#join-mask').hidden=false", leave)


if __name__ == '__main__':
    unittest.main()
