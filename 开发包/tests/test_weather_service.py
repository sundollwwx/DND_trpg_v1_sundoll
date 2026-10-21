"""Optional climate content must not prevent normal multiplayer operations."""
from project_test_paths import DAILY_LIFE_FIXTURE, PACKAGE_ROOT
import copy
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest import mock

from server import daily_life, weather_service
from server.domain import weather
from server.workspace import enable
import test_player_profiles as profile_fixtures


CONFIG = json.loads((DAILY_LIFE_FIXTURE / '资料/climate.json').read_text('utf-8'))
SOURCE = DAILY_LIFE_FIXTURE
SERVER = profile_fixtures.SERVER


class WeatherServiceTests(unittest.TestCase):
    def test_domain_requires_explicit_config_instead_of_runtime_global_state(self):
        with self.assertRaisesRegex(ValueError, '显式'):
            weather.normalize_weather(None, 3600)
        self.assertFalse(hasattr(weather, 'configure_weather'))
        self.assertFalse(hasattr(weather, 'climate_config'))

    def test_runtime_reader_uses_requested_workspace_without_a_fallback(self):
        with mock.patch.object(daily_life, 'load_data', return_value=CONFIG) as reader:
            self.assertIs(weather_service.load_climate_config('/tmp/isolated-weather-save'), CONFIG)
        reader.assert_called_once_with('/tmp/isolated-weather-save', 'climate', public=True)
        with mock.patch.object(daily_life, 'load_data', side_effect=FileNotFoundError('missing')):
            with self.assertRaises(FileNotFoundError):
                weather_service.load_climate_config('/tmp/isolated-weather-save')

    def test_missing_or_bad_source_preserves_every_weather_field_without_rolls(self):
        for error in (FileNotFoundError('missing'), ValueError('invalid'), PermissionError('blocked')):
            original = {'weather': {**CONFIG['defaultWeather'], 'generatedHour': 8,
                                    'customSceneNote': '原来的天气'},
                        'worldTime': {'totalSeconds': 50 * 3600}}
            before = copy.deepcopy(original)
            with self.subTest(error=error), mock.patch.object(weather_service, 'load_climate_config', side_effect=error):
                result = weather_service.refresh_encounter_weather(original, 50 * 3600, '/tmp/isolated',
                    previous_total_seconds=8 * 3600, random_fn=lambda: self.fail('unavailable weather must not roll'))
            self.assertIsNone(result)
            self.assertEqual(original, before)

    def test_no_weather_is_synthesized_when_source_is_unavailable(self):
        value = {'worldTime': {'totalSeconds': 3600}}
        with mock.patch.object(weather_service, 'load_climate_config', side_effect=FileNotFoundError('missing')):
            weather_service.refresh_encounter_weather(value, 3600, '/tmp/isolated')
        self.assertNotIn('weather', value)

    def test_complete_catchup_shares_one_fresh_configuration_snapshot(self):
        config = copy.deepcopy(CONFIG)
        config['schedule']['maxCatchupHours'] = 3
        value = {'weather': {**config['defaultWeather'], 'generatedHour': 0}}
        calls = []
        with mock.patch.object(weather_service, 'load_climate_config', return_value=config) as reader:
            weather_service.refresh_encounter_weather(value, 2 * 365 * 24 * 3600, '/tmp/isolated',
                random_fn=lambda: calls.append(True) or .42)
            self.assertEqual(reader.call_count, 1)
            self.assertEqual(len(calls), 9)
            self.assertEqual(value['weather']['generatedHour'], 2 * 365 * 24)
            weather_service.refresh_encounter_weather(value, (2 * 365 * 24 + 1) * 3600, '/tmp/isolated',
                random_fn=lambda: .42)
            self.assertEqual(reader.call_count, 2)


class WeatherUnavailableHttpTests(unittest.TestCase):
    request = profile_fixtures.PlayerProfileHttpTests.request
    close_server = profile_fixtures.PlayerProfileHttpTests.close_server

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sundoll-optional-weather-http-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root)
        self.module = self.root / '通用包/日常小事'
        for name, value in {
            'ROOT': str(self.root), 'LOCAL_SAVE_ROOT': str(self.save), 'AUTH_METHOD': 'name',
            'ASSET_ROOT': str(self.root / '缓存/联机资源'), 'STATE': None, 'STATE_REVISION': 0,
            'RECENT_ACTIONS': [], 'NEXT_SEQ': 1, 'ACTION_IDS': {}, 'ACTION_RATE': {},
            'CLIENTS': [], 'SESSIONS': {}, 'LOGIN_ATTEMPTS': {}, 'REGISTRATION_ATTEMPTS': {},
        }.items():
            patch = mock.patch.object(SERVER, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(SERVER, 'broadcast')
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(SERVER.Handler, 'log_message', lambda *args: None)
        patch.start()
        self.addCleanup(patch.stop)
        self.pid = SERVER.profile_store().create('气候测试玩家')['profile']['playerId']
        self.httpd = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        self.port = self.httpd.server_port
        patch = mock.patch.object(SERVER, 'PORT', self.port)
        patch.start()
        self.addCleanup(patch.stop)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def install_source(self):
        if self.module.exists():
            shutil.rmtree(self.module)
        shutil.copytree(SOURCE, self.module)

    def state(self, with_weather=True):
        encounter = dict(playMode='turn', round=1, currentEntryId='init-hero', turnSerial=7,
            secondsPerRound=6, entries=[dict(id='init-hero', tokenId='hero', name='角色', value=18)],
            turnPath=dict(mapId=None, tokenId=None, points=[], segmentEnds=[]),
            worldTime=dict(totalSeconds=3599, runningSince=None))
        if with_weather:
            encounter['weather'] = {**CONFIG['defaultWeather'], 'generatedHour': 0,
                                    'customSceneNote': '保持旧天气'}
        return dict(campaignId='weather-test', activeMapId='map', encounter=encounter,
            maps=[dict(id='map', playerAccessible=True, mapW=500, mapH=500, gridSize=50,
                       tokens=[dict(id='hero', owner=self.pid, name='角色', hp=20, hpMax=20,
                                    x=250, y=250, conditions=[])])])

    def login_and_end_turn(self, action_id):
        status, result = self.request(dict(nickname='气候测试玩家'), path='/api/session')
        self.assertEqual(status, 200, result)
        token = result['session']['sessionToken']
        serial = SERVER.STATE['encounter']['turnSerial']
        return self.request(dict(sessionToken=token, campaignId='weather-test', actionId=action_id,
            action=dict(op='endTurn', turnSerial=serial, weather={'temperature': 99})), path='/api/action')

    def publish_new_encounter(self, encounter_state):
        # A new case explicitly loads the current page, then replaces the
        # encounter with its intended test setup. Freeze that loaded baseline;
        # never attach a freshly fetched revision to a retained stale draft.
        status, loaded = self.request(method='GET', path='/api/state')
        self.assertEqual(status, 200, loaded)
        if not loaded:
            status, info = self.request(method='GET', path='/api/info')
            self.assertEqual(status, 200, info)
            authority = info['stateAuthority']
            revision, session = authority['stateRevision'], authority['sessionId']
            draft = {}
        else:
            revision, session = loaded['_stateRevision'], loaded['_sessionId']
            draft = copy.deepcopy(loaded)
        draft.update(copy.deepcopy(encounter_state))
        draft.update(expectedStateRevision=revision, serverSessionId=session)
        return self.request(draft, host=True, path='/api/state')

    def test_missing_and_invalid_sources_allow_login_sync_and_hour_crossing_end_turn(self):
        for case in ('missing-module', 'missing-file', 'invalid-json', 'invalid-schema', 'invalid-manifest'):
            with self.subTest(source=case):
                self.install_source()
                SERVER.RECENT_ACTIONS.clear()
                SERVER.ACTION_IDS.clear()
                original = self.state()
                status, result = self.publish_new_encounter(original)
                self.assertEqual(status, 200, result)
                if case == 'missing-module':
                    shutil.rmtree(self.module)
                elif case == 'missing-file':
                    (self.module / '资料/climate.json').unlink()
                elif case == 'invalid-manifest':
                    (self.module / '模块.json').write_text('{}', 'utf-8')
                else:
                    (self.module / '资料/climate.json').write_text('{bad' if case == 'invalid-json' else '{}', 'utf-8')
                status, result = self.login_and_end_turn('weather-failure-' + case)
                self.assertEqual(status, 200, result)
                self.assertTrue(result['ok'])
                status, snapshot = self.request(method='GET', path='/api/state')
                self.assertEqual(status, 200)
                current = snapshot['encounter']
                self.assertEqual(current['weather'], original['encounter']['weather'])
                self.assertEqual(current['round'], 2)
                self.assertEqual(current['turnSerial'], 8)
                self.assertEqual(current['worldTime']['totalSeconds'], 3605)
                status, actions = self.request(method='GET', path='/api/actions?after=0')
                self.assertEqual(status, 200)
                self.assertEqual(actions['actions'][-1]['weather'], original['encounter']['weather'])

    def test_missing_weather_source_can_finish_a_new_encounter_without_weather(self):
        status, result = self.publish_new_encounter(self.state(with_weather=False))
        self.assertEqual(status, 200, result)
        status, result = self.login_and_end_turn('weather-no-existing-state')
        self.assertEqual(status, 200, result)
        self.assertNotIn('weather', SERVER.STATE['encounter'])
        self.assertNotIn('weather', SERVER.RECENT_ACTIONS[-1])

    def test_restoring_valid_content_resumes_the_same_saved_weather(self):
        self.assertEqual(self.publish_new_encounter(self.state())[0], 200)
        self.assertEqual(self.login_and_end_turn('weather-before-restore')[0], 200)
        preserved = copy.deepcopy(SERVER.STATE['encounter']['weather'])
        self.install_source()
        self.assertEqual(self.login_and_end_turn('weather-after-restore')[0], 200)
        resumed = SERVER.STATE['encounter']['weather']
        self.assertEqual(resumed['generatedHour'], 1)
        self.assertEqual(resumed['climate'], preserved['climate'])
        self.assertEqual(SERVER.STATE['encounter']['worldTime']['totalSeconds'], 3611)

    def test_extra_unvalidated_climate_keys_do_not_break_an_hour_crossing_turn(self):
        self.install_source()
        config = copy.deepcopy(CONFIG)
        config['climates']['custom_region'] = {}
        (self.module / '资料/climate.json').write_text(json.dumps(config), 'utf-8')
        state = self.state()
        state['encounter']['weather']['climate'] = 'custom_region'
        self.assertEqual(self.publish_new_encounter(state)[0], 200)
        self.assertEqual(self.login_and_end_turn('weather-extra-climate')[0], 200)
        normalized = weather_service.load_climate_config(self.save)
        self.assertNotIn('custom_region', normalized['climates'])
        self.assertEqual(normalized, daily_life.load_data(self.save, 'climate', public=True))
        current = SERVER.STATE['encounter']
        self.assertEqual(current['weather']['climate'], CONFIG['defaultWeather']['climate'])
        self.assertEqual(current['weather']['generatedHour'], 1)
        self.assertEqual(current['worldTime']['totalSeconds'], 3605)

    def test_manual_module_default_does_not_randomize_a_new_encounter(self):
        self.install_source()
        config = copy.deepcopy(CONFIG)
        config['defaultWeather']['auto'] = False
        (self.module / '资料/climate.json').write_text(json.dumps(config), 'utf-8')
        self.assertEqual(self.publish_new_encounter(self.state(with_weather=False))[0], 200)
        with mock.patch.object(weather, 'generate_climate_weather',
                               side_effect=AssertionError('manual default must not generate weather')):
            self.assertEqual(self.login_and_end_turn('weather-manual-module-default')[0], 200)
        self.assertEqual(SERVER.STATE['encounter']['weather'], {
            **config['defaultWeather'], 'generatedHour': 1,
        })
        self.assertEqual(SERVER.STATE['encounter']['worldTime']['totalSeconds'], 3605)


if __name__ == '__main__':
    unittest.main()
