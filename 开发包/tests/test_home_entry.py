from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
from client_sources import read_client_source
import re
import unittest
from pathlib import Path


PROJECT_ROOT = APP_ROOT
HOST_HTML = (PROJECT_ROOT / '主控台' / '主控台.html').read_text(encoding='utf-8')
HOST_JS = read_client_source((PROJECT_ROOT / '主控台' / 'host' / 'app.js'))
HOST_CSS = (PROJECT_ROOT / '主控台' / 'host' / 'style.css').read_text(encoding='utf-8')
PLAYER_HTML = read_client_source((PROJECT_ROOT / '主控台' / '玩家.html'))
SERVER_PY = (PROJECT_ROOT / 'server' / 'http_app.py').read_text(encoding='utf-8')
BRAND_LOGO = PROJECT_ROOT / 'asset' / '界面' / '品牌' / '桑哆尔之歌-logo.png'


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
        self.assertIn('<title>桑哆尔之歌 · 主控台</title>', HOST_HTML)
        self.assertIn('<title>桑哆尔之歌 · 玩家端</title>', PLAYER_HTML)
        for source in (HOST_HTML, PLAYER_HTML):
            self.assertGreaterEqual(source.count('../asset/界面/品牌/桑哆尔之歌-logo.png'), 2)
            self.assertNotIn('桑哆尔跑团', source)
            self.assertNotIn('🐉 桑哆尔', source)

    def test_host_home_has_one_clear_campaign_entry_surface(self):
        for element_id in (
            'cover', 'cover-current', 'cover-continue', 'cover-load', 'cover-new',
            'cover-player-profiles', 'campaign-search', 'btn-campaign-refresh', 'cover-new-form', 'cover-folder', 'cover-recent',
            'cover-storage-status', 'cover-feedback',
        ):
            self.assertEqual(HOST_HTML.count(f'id="{element_id}"'), 1, element_id)
        self.assertIn('id="btn-save-tools-open"', HOST_HTML)
        self.assertNotIn('cover-temp', HOST_HTML)
        self.assertNotIn("$('#cover-temp')", HOST_JS)
        self.assertIn('<strong>冒险管理</strong>', HOST_HTML)
        self.assertNotIn('id="btn-modules"', HOST_HTML)
        self.assertNotIn('data-save-action="load"', HOST_HTML)
        self.assertNotIn('data-save-action="backup"', HOST_HTML)
        self.assertIn('<strong>参团角色</strong>', HOST_HTML)
        self.assertIn("function showCover(", HOST_JS)
        self.assertIn('function refreshHostHome(', HOST_JS)
        self.assertIn('function renderCoverRecent(', HOST_JS)
        self.assertIn('function chooseCampaignCover(', HOST_JS)
        self.assertIn('function prepareCampaignCover(', HOST_JS)
        self.assertIn("localSaveApiRequest('write-binary'", HOST_JS)
        self.assertIn("const CAMPAIGN_COVER_FILES = ['封面.webp', '封面.jpg', '封面.jpeg', '封面.png']", HOST_JS)
        self.assertIn('cover-recent-art', HOST_CSS)
        self.assertIn('cover-image-action', HOST_CSS)
        self.assertNotIn("prompt('新战役名称'", HOST_JS)

    def test_host_home_uses_the_single_bound_save_folder(self):
        self.assertIn('fetch(LOCAL_SAVE_API_PATH', HOST_JS)
        self.assertIn("LOCAL_SAVE_API_HEADER = 'X-Sundoll-Local-Save'", HOST_JS)
        self.assertIn("localSaveApiRequest('status')", HOST_JS)
        self.assertIn('projectDirHandle = LOCAL_SAVE_BRIDGE_HANDLE', HOST_JS)
        self.assertIn("self.path == '/api/local-save'", SERVER_PY)
        self.assertIn('await hasSaveFolderPermission()', HOST_JS)
        home = function_body(HOST_JS, 'refreshHostHome', 'renderCampaignList')
        catalog = r'readCampaignRecords\s*\(\s*options\.forceRecords\s*===\s*true\s*,\s*\{\s*covers\s*:\s*false\s*\}\s*\)'
        self.assertTrue(re.search(catalog, home), '首页应只读取不含封面的战役目录，允许加载阶段包装')
        self.assertFalse(re.search(r'\b(?:loadFolderSave|prepareDeferredHostCampaign|syncLibraryWithFolder|loadSaved)\s*\(', home),
                         '目录检查不得读取完整战役、棋子库或恢复战役状态')
        self.assertFalse(re.search(r"localSaveApiRequest\s*\(\s*['\"]read-campaign['\"]", home),
                         '目录检查不得请求完整存档正文')
        self.assertIn('await ensureSaveFolderAccess(true)', HOST_JS)
        self.assertIn("await campaignPut(id, name, snap, { backup: false })", HOST_JS)

    def test_player_home_is_visible_before_entering(self):
        for element_id in (
            'join-mask', 'join-server-status', 'join-campaign-name',
            'join-map-name', 'join-player-count', 'join-form', 'join-name',
            'join-submit', 'join-refresh', 'join-session-hint', 'join-campaign-card',
            'join-campaign-cover',
        ):
            self.assertEqual(PLAYER_HTML.count(f'id="{element_id}"'), 1, element_id)
        join_tag = re.search(r'<div id="join-mask"[^>]*>', PLAYER_HTML)
        self.assertIsNotNone(join_tag)
        self.assertNotIn(' hidden', join_tag.group(0))
        self.assertIn('function applyJoinCampaignCover(', PLAYER_HTML)
        self.assertIn('applyJoinCampaignCover(info.campaignCoverUrl)', PLAYER_HTML)
        self.assertRegex(
            PLAYER_HTML,
            r'\.join-campaign-card\s*\{[^}]*aspect-ratio\s*:\s*16\s*/\s*9',
        )
        self.assertIn("'campaignCoverUrl':", SERVER_PY)
        self.assertIn("state['_campaignCoverUrl'] = campaign_cover_asset_url(state)", SERVER_PY)

    def test_home_has_no_non_interactive_pseudo_navigation_or_duplicate_feature_cards(self):
        for obsolete in ('cover-tabs', 'cover-project-tags', 'cover-about'):
            self.assertNotIn(obsolete, HOST_HTML)
            self.assertNotIn(obsolete, HOST_CSS)
        for obsolete in ('join-tabs', 'join-feature-list', 'join-about'):
            self.assertNotIn(obsolete, PLAYER_HTML)

    def test_legacy_player_refresh_waits_for_entry_and_email_room_uses_current_account(self):
        bootstrap = function_body(PLAYER_HTML, 'bootstrapSession', 'sendPresence')
        self.assertIn("$('#join-mask').hidden=false", bootstrap)
        self.assertIn('refreshPlayerHome()', bootstrap)
        self.assertIn('validateStoredSession()', bootstrap)
        email_room = 'if (window.SundollRoom && emailAccountMode)'
        self.assertIn(email_room, bootstrap)
        self.assertNotIn('joinSession(', bootstrap.split(email_room, 1)[0])
        self.assertIn('await joinSession(myName)', bootstrap.split(email_room, 1)[1])
        self.assertNotIn('connectStream(', bootstrap)
        self.assertIn('bootstrapSession();', PLAYER_HTML)
        self.assertNotIn('bootstrapSession().then', PLAYER_HTML)

        preview = function_body(PLAYER_HTML, 'refreshPlayerHome', 'bootstrapSession')
        self.assertIn("SundollClientRuntime.requestJson('/api/info'", preview)
        self.assertIn("cache:'no-store'", preview)
        self.assertRegex(preview, r'timeoutMs:\s*[1-9][0-9]*')
        self.assertNotRegex(preview, r"(?:fetch|SundollClientRuntime\.requestJson)\(\s*['\"]/api/state")
        self.assertIn("'campaignName': snapshot.get('campaignName')", SERVER_PY)
        self.assertIn("'activeMapName': active_map.get('name')", SERVER_PY)

    def test_player_enters_then_connects_and_switch_player_closes_stream(self):
        submit = PLAYER_HTML.split("$('#join-form').addEventListener('submit'", 1)[1].split("$('#join-refresh').addEventListener", 1)[0]
        self.assertIn("await joinSession($('#join-name').value)", submit)
        self.assertNotIn('connectStream()', submit, 'joinSession owns the one stream; manual submit must not start another')
        leave = function_body(PLAYER_HTML, 'returnToJoinHome', 'leaveSession')
        self.assertIn('streamES.close()', leave)
        self.assertIn('clearStoredSession()', leave)
        self.assertIn("$('#join-mask').hidden=false", leave)


if __name__ == '__main__':
    unittest.main()
