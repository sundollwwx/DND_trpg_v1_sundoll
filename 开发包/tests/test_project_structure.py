from project_test_paths import DAILY_LIFE_FIXTURE, APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import ast
import importlib
import http.client
import json
import re
import shutil
import tempfile
import threading
import unittest
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
from unittest.mock import patch
from server.static_policy import static_file_allowed
from server import save_storage

ROOT = APP_ROOT
DYNAMIC_SCRIPT_PATHS = {'/api/daily-life/climate.js'}

class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.scripts.append(attrs['src'].split('?')[0])
        key = 'href' if tag == 'link' else 'src'
        if tag in ('script', 'link', 'img') and attrs.get(key):
            self.refs.append(attrs[key])

class ProjectStructureTests(unittest.TestCase):
    def test_entry_dependencies_exist_and_are_served(self):
        for name, host in [('主控台/主控台.html', True), ('主控台/玩家.html', False),
                           ('asset/棋子库/棋子库.html', True), ('asset/地图/地图创作台.html', True)]:
            page = ROOT / name
            parsed = References()
            parsed.feed(page.read_text())
            for ref in parsed.refs:
                url = urlsplit(ref)
                if url.scheme or url.netloc or not url.path:
                    continue
                if url.path.startswith('/api/'):
                    with self.subTest(page=name, ref=ref):
                        self.assertIn(url.path, DYNAMIC_SCRIPT_PATHS)
                        entry = 'host/app.js' if host else 'player/player.js'
                        self.assertLess(parsed.scripts.index(url.path), parsed.scripts.index(entry))
                    continue
                target = (ROOT / unquote(url.path).lstrip('/')) if url.path.startswith('/') else page.parent / unquote(url.path)
                with self.subTest(page=name, ref=ref):
                    self.assertTrue(target.is_file())
                    self.assertTrue(static_file_allowed(ROOT, target, host))
            if name.startswith('主控台/'):
                entry = 'host/app.js' if host else 'player/player.js'
                for dependency in ['../shared/protocol.js', '../shared/rules.js']:
                    self.assertLess(parsed.scripts.index(dependency), parsed.scripts.index(entry))
                if host:
                    self.assertGreater(parsed.scripts.index('host/bootstrap.js'), parsed.scripts.index(entry))
                    for dependency in ['host/storage.js', 'host/documents.js', 'host/music.js']:
                        self.assertLess(parsed.scripts.index(dependency), parsed.scripts.index(entry))

    def test_dynamic_script_dependency_is_served_by_the_real_http_handler(self):
        from server import daily_life
        from server.workspace import enable
        from test_local_save_bridge import SERVER
        with tempfile.TemporaryDirectory(prefix='sundoll-structure-http-') as directory:
            workspace = Path(directory)
            save_root = enable(workspace)
            shutil.copytree(DAILY_LIFE_FIXTURE, workspace/'通用包/日常小事')
            with patch.object(SERVER, 'LOCAL_SAVE_ROOT', str(save_root)), patch.object(SERVER.Handler, 'log_message', lambda *args: None):
                server = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                try:
                    connection.request('GET', '/api/daily-life/climate.js')
                    response = connection.getresponse()
                    body = response.read().decode('ascii')
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader('Content-Type'), 'application/javascript; charset=utf-8')
                    self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                    self.assertEqual(response.getheader('X-Content-Type-Options'), 'nosniff')
                    prefix = 'window.SundollClimateConfig = '
                    self.assertTrue(body.startswith(prefix))
                    self.assertEqual(json.loads(body[len(prefix):-2]), daily_life.load_data(save_root, 'climate', public=True))
                finally:
                    connection.close()
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=3)

    def test_extracted_storage_preserves_conflicting_progress(self):
        with tempfile.TemporaryDirectory() as root:
            path = '战役/structure/当前存档.json'
            original = json.dumps({'state': {'maps': []}, 'name': 'first'})
            stale = json.dumps({'state': {'maps': []}, 'name': 'stale'})
            result = save_storage.perform_local_save_operation(dict(op='write-campaign', path=path, text=original, expectedHash=None), root)
            self.assertTrue(result['hash'])
            with self.assertRaises(save_storage.SaveConflict):
                save_storage.perform_local_save_operation(dict(op='write-campaign', path=path, text=stale, expectedHash=None), root)
            self.assertEqual((Path(root)/path).read_text(), original)
            backups = list((Path(root)/path).parent.glob('自动备份/保存冲突-*.json'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), stale)

    def test_domain_modules_do_not_depend_on_transport_or_filesystem_services(self):
        for path in (ROOT/'server/domain').glob('*.py'):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertIn(alias.name, {'math', 'random', 're', 'secrets', 'copy', 'time'}, str(path))
                elif isinstance(node, ast.ImportFrom):
                    self.assertEqual((node.level, node.module), (1, 'values'), str(path))
                self.assertNotIsInstance(node, ast.Global, str(path))

    def test_domain_entrypoints_are_the_same_functions_used_by_server(self):
        from test_local_save_bridge import SERVER
        from server.domain import journal, weather
        from server import documents, music_catalog, weather_service
        self.assertIs(SERVER.mutate_journal, journal.mutate_journal)
        self.assertIs(SERVER.refresh_encounter_weather, weather_service.refresh_encounter_weather)
        self.assertIs(weather_service.normalize_weather, weather.normalize_weather)
        self.assertIs(weather_service.refresh_scheduled_weather, weather.refresh_scheduled_weather)
        self.assertIs(SERVER.parse_docx_preview, documents.parse_docx_preview)
        self.assertIs(SERVER.music_library_catalog, music_catalog.music_library_catalog)

    def test_domain_imports_leave_runtime_state_in_the_transport(self):
        for name in ('server.domain.journal', 'server.domain.weather', 'server.documents', 'server.music_catalog'):
            module = importlib.import_module(name)
            for forbidden in ('STATE', 'SESSIONS', 'Handler', 'profile_store', 'LOCAL_SAVE_ROOT'):
                self.assertFalse(hasattr(module, forbidden), (name, forbidden))

    def test_relocated_stylesheet_images_resolve_inside_public_assets(self):
        for name in ('主控台/host/style.css','主控台/player/player.css','主控台/shared/journal.css'):
            css=ROOT/name
            for raw in re.findall(r"url\(([^)]+)\)",css.read_text()):
                ref=raw.strip().strip('\"\'')
                url=urlsplit(ref)
                if url.scheme or url.netloc or not url.path:
                    continue
                target=css.parent/unquote(url.path)
                self.assertTrue(static_file_allowed(ROOT,target,True),(name,ref))

    def test_classified_tools_resolve_project_root(self):
        import importlib.util
        for name in ('maintenance/check_project.py','maintenance/repair_portrait_bindings.py'):
            spec=importlib.util.spec_from_file_location('structure_tool',TOOLS_ROOT/name)
            module=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertEqual(module.ROOT,ROOT)
        from test_github_shortcuts import SYNC
        self.assertEqual(SYNC.checkout_root(),CHECKOUT_ROOT)
