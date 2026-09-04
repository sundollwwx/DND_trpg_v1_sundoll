import copy
import base64
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = PROJECT_ROOT / '主控台' / '联机服务器.py'
SPEC = importlib.util.spec_from_file_location('sundoll_online_server', SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
ORIGINAL_ARGV = sys.argv[:]
try:
    sys.argv = [sys.argv[0]]
    SPEC.loader.exec_module(SERVER)
finally:
    sys.argv = ORIGINAL_ARGV


def make_state(play_mode='turn'):
    return {
        'maps': [{
            'id': 'map-1',
            'mapW': 1000,
            'mapH': 700,
            'gridSize': 50,
            'tokens': [
                {'id': 'rider', 'name': '骑手', 'owner': 'Alice', 'size': 1, 'mountId': 'mount', 'x': 250, 'y': 250,
                 'hp': 12, 'hpMax': 12, 'ac': 15, 'conditions': [{'label': '专注', 'remainingTurns': 2}]},
                {'id': 'mount', 'name': '坐骑', 'owner': '', 'size': 2, 'mountId': None, 'x': 250, 'y': 250,
                 'hp': 20, 'hpMax': 20, 'ac': 13, 'conditions': []},
                {'id': 'co-rider', 'name': '同乘者', 'owner': 'Bob', 'size': 1, 'mountId': 'mount', 'x': 250, 'y': 250,
                 'hp': 9, 'hpMax': 9, 'ac': 12, 'conditions': []},
                {'id': 'other', 'name': '其他角色', 'owner': 'Bob', 'size': 1, 'mountId': None, 'x': 500, 'y': 300,
                 'hp': 10, 'hpMax': 10, 'ac': 14, 'conditions': []},
            ],
        }],
        'encounter': {
            'playMode': play_mode,
            'round': 1,
            'currentEntryId': 'init-rider',
            'turnSerial': 7,
            'entries': [
                {'id': 'init-rider', 'name': '骑手', 'tokenId': 'rider', 'value': 18},
                {'id': 'init-other', 'name': '其他角色', 'tokenId': 'other', 'value': 12},
            ],
            'turnPath': {'mapId': None, 'tokenId': None, 'points': []},
            'worldTime': {'totalSeconds': 100, 'runningSince': None},
            'weather': {'climate': 'temperate', 'condition': 'clear', 'temperature': 18,
                        'wind': 'breeze', 'generatedDay': -1},
        },
    }


class TurnPermissionTests(unittest.TestCase):
    def test_current_rider_controls_mount_group_only(self):
        state = make_state()
        mount = SERVER.find_token(state, 'mount')[1]
        co_rider = SERVER.find_token(state, 'co-rider')[1]
        other = SERVER.find_token(state, 'other')[1]
        self.assertEqual(SERVER.can_act_with_token(state, mount, 'Alice', {'turnSerial': 7}), (True, None))
        self.assertEqual(SERVER.can_act_with_token(state, mount, 'Bob', {'turnSerial': 7})[0], False)
        self.assertEqual(SERVER.can_act_with_token(state, co_rider, 'Alice', {'turnSerial': 7})[0], False)
        self.assertEqual(SERVER.can_act_with_token(state, other, 'Bob', {'turnSerial': 7})[0], False)

    def test_mount_and_single_rider_can_share_one_mount_bound_turn(self):
        state = make_state()
        state['maps'][0]['tokens'] = [
            token for token in state['maps'][0]['tokens'] if token['id'] != 'co-rider'
        ]
        state['encounter']['entries'][0]['tokenId'] = 'mount'
        rider = SERVER.find_token(state, 'rider')[1]
        mount = SERVER.find_token(state, 'mount')[1]
        other = SERVER.find_token(state, 'other')[1]
        self.assertEqual(SERVER.can_act_with_token(state, rider, 'Alice', {'turnSerial': 7}), (True, None))
        self.assertEqual(SERVER.can_act_with_token(state, mount, 'Alice', {'turnSerial': 7}), (True, None))
        self.assertFalse(SERVER.can_act_with_token(state, mount, 'Bob', {'turnSerial': 7})[0])
        self.assertFalse(SERVER.can_act_with_token(state, other, 'Bob', {'turnSerial': 7})[0])

    def test_unlinked_current_initiative_never_grants_movement(self):
        state = make_state()
        state['encounter']['entries'][0]['tokenId'] = None
        rider = SERVER.find_token(state, 'rider')[1]
        allowed, reason = SERVER.can_act_with_token(state, rider, 'Alice', {'turnSerial': 7})
        self.assertFalse(allowed)
        self.assertEqual(reason, '当前先攻尚未关联棋子，暂时不能操作')

    def test_normal_player_token_moves_only_on_its_own_turn(self):
        state = make_state()
        state['encounter']['currentEntryId'] = 'init-other'
        other = SERVER.find_token(state, 'other')[1]
        rider = SERVER.find_token(state, 'rider')[1]
        self.assertEqual(SERVER.can_act_with_token(state, other, 'Bob', {'turnSerial': 7}), (True, None))
        self.assertFalse(SERVER.can_act_with_token(state, rider, 'Alice', {'turnSerial': 7})[0])

    def test_control_group_does_not_grant_access_to_another_rider(self):
        state = make_state(play_mode='free')
        rider = SERVER.find_token(state, 'rider')[1]
        mount = SERVER.find_token(state, 'mount')[1]
        co_rider = SERVER.find_token(state, 'co-rider')[1]
        self.assertTrue(SERVER.can_control(state, rider, 'Alice'))
        self.assertTrue(SERVER.can_control(state, mount, 'Alice'))
        self.assertTrue(SERVER.can_control(state, mount, 'Bob'))
        self.assertFalse(SERVER.can_control(state, co_rider, 'Alice'))

    def test_replayed_action_rechecks_latest_owner(self):
        state = make_state(play_mode='free')
        rider = SERVER.find_token(state, 'rider')[1]
        rider['owner'] = 'Carol'
        delayed = {'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Alice', 'playMode': 'free', 'patch': {'hp': 1}}
        self.assertFalse(SERVER.apply_action(state, delayed))
        self.assertEqual(rider['hp'], 12)

    def test_stale_serial_and_stale_mode_do_not_mutate(self):
        state = make_state()
        original = copy.deepcopy(state)
        stale_turn = {'op': 'moveToken', 'tokenId': 'rider', 'mapId': 'map-1', 'x': 400, 'y': 400,
                      'playMode': 'turn', 'turnSerial': 6, 'path': [{'x': 250, 'y': 250}, {'x': 400, 'y': 400}]}
        self.assertFalse(SERVER.apply_action(state, stale_turn))
        self.assertEqual(state['maps'][0]['tokens'], original['maps'][0]['tokens'])

        stale_free = {'op': 'patchToken', 'tokenId': 'rider', 'playMode': 'free', 'patch': {'hp': 1}}
        self.assertFalse(SERVER.apply_action(state, stale_free))
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['hp'], 12)

        state['encounter']['playMode'] = 'free'
        stale_recorded_turn = {'op': 'patchToken', 'tokenId': 'rider', 'playMode': 'turn', 'turnSerial': 7,
                               'patch': {'hp': 1}}
        self.assertFalse(SERVER.apply_action(state, stale_recorded_turn))
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['hp'], 12)

        stale_legacy_turn = {'op': 'moveToken', 'tokenId': 'rider', 'mapId': 'map-1', 'turnSerial': 7,
                             'x': 450, 'y': 450, 'path': [{'x': 250, 'y': 250}, {'x': 450, 'y': 450}]}
        self.assertFalse(SERVER.apply_action(state, stale_legacy_turn))
        self.assertEqual((SERVER.find_token(state, 'rider')[1]['x'], SERVER.find_token(state, 'rider')[1]['y']),
                         (250, 250))

    def test_current_mount_move_syncs_rider_and_records_path(self):
        state = make_state()
        action = {'op': 'moveToken', 'tokenId': 'rider', 'mapId': 'map-1', 'x': 410, 'y': 360,
                  'playMode': 'turn', 'turnSerial': 7,
                  'path': [{'x': 250, 'y': 250}, {'x': 410, 'y': 360}]}
        self.assertTrue(SERVER.apply_action(state, action))
        rider = SERVER.find_token(state, 'rider')[1]
        mount = SERVER.find_token(state, 'mount')[1]
        self.assertEqual((rider['x'], rider['y']), (mount['x'], mount['y']))
        self.assertEqual(action['tokenId'], 'mount')
        self.assertEqual(state['encounter']['turnPath']['tokenId'], 'mount')
        self.assertEqual(state['encounter']['turnPath']['points'][-1], {'x': 410.0, 'y': 360.0})

    def test_turn_path_undo_moves_mount_group_back_and_replay_is_idempotent(self):
        state = make_state()
        points = [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}, {'x': 350, 'y': 300}]
        state['encounter']['turnPath'] = {'mapId': 'map-1', 'tokenId': 'mount', 'points': copy.deepcopy(points)}
        for token_id in ('rider', 'mount', 'co-rider'):
            token = SERVER.find_token(state, token_id)[1]
            token['x'], token['y'] = 350, 300
        action = {
            'op': 'turnPathUndo', 'tokenId': 'rider', 'mapId': 'map-1', 'actor': 'Alice',
            'playMode': 'turn', 'turnSerial': 7,
        }

        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(action['tokenId'], 'mount')
        self.assertEqual(action['pathMode'], 'replace')
        self.assertEqual(action['path'], [{'x': 250.0, 'y': 250.0}, {'x': 300.0, 'y': 250.0}])
        self.assertEqual(state['encounter']['turnPath']['points'], action['path'])
        for token_id in ('rider', 'mount', 'co-rider'):
            token = SERVER.find_token(state, token_id)[1]
            self.assertEqual((token['x'], token['y']), (300.0, 250.0))

        # 主机上传快照时会重放同一个标准动作；完整替换不能再少一个点。
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['turnPath']['points'], action['path'])
        self.assertEqual((SERVER.find_token(state, 'mount')[1]['x'], SERVER.find_token(state, 'mount')[1]['y']),
                         (300.0, 250.0))

    def test_turn_path_reset_returns_mount_group_to_turn_start(self):
        state = make_state()
        state['encounter']['turnPath'] = {
            'mapId': 'map-1', 'tokenId': 'mount',
            'points': [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}, {'x': 350, 'y': 300}],
        }
        for token_id in ('rider', 'mount', 'co-rider'):
            token = SERVER.find_token(state, token_id)[1]
            token['x'], token['y'] = 350, 300
        action = {
            'op': 'turnPathReset', 'tokenId': 'mount', 'mapId': 'map-1', 'actor': 'Alice',
            'playMode': 'turn', 'turnSerial': 7,
        }

        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(action['pathMode'], 'replace')
        self.assertEqual(state['encounter']['turnPath']['points'], [{'x': 250.0, 'y': 250.0}])
        for token_id in ('rider', 'mount', 'co-rider'):
            token = SERVER.find_token(state, token_id)[1]
            self.assertEqual((token['x'], token['y']), (250.0, 250.0))

    def test_turn_path_change_rejects_wrong_player_and_stale_turn(self):
        state = make_state()
        state['encounter']['turnPath'] = {
            'mapId': 'map-1', 'tokenId': 'mount',
            'points': [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}],
        }
        original = copy.deepcopy(state)
        wrong_player = {
            'op': 'turnPathUndo', 'tokenId': 'rider', 'mapId': 'map-1', 'actor': 'Bob',
            'playMode': 'turn', 'turnSerial': 7,
        }
        stale_turn = {
            'op': 'turnPathReset', 'tokenId': 'rider', 'mapId': 'map-1', 'actor': 'Alice',
            'playMode': 'turn', 'turnSerial': 6,
        }

        self.assertFalse(SERVER.apply_action(state, wrong_player))
        self.assertFalse(SERVER.apply_action(state, stale_turn))
        self.assertEqual(state, original)

    def test_end_turn_decrements_every_mount_group_member_once_and_clears_path(self):
        state = make_state()
        state['encounter']['turnPath'] = {'mapId': 'map-1', 'tokenId': 'mount', 'points': [{'x': 250, 'y': 250}]}
        SERVER.find_token(state, 'rider')[1]['conditions'].append({'label': '永久', 'remainingTurns': None})
        SERVER.find_token(state, 'mount')[1]['conditions'] = [
            {'label': '短暂', 'remainingTurns': 1}, {'label': '永久', 'remainingTurns': None},
        ]
        SERVER.find_token(state, 'co-rider')[1]['conditions'] = [{'label': '防护', 'remainingTurns': 3}]
        action = {'op': 'endTurn', 'turnSerial': 7, 'nextEntryId': 'init-other', 'nextTurnSerial': 8,
                  'round': 1, 'worldTimeSeconds': 100}
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['currentEntryId'], 'init-other')
        self.assertEqual(state['encounter']['turnSerial'], 8)
        self.assertEqual(state['encounter']['turnPath']['points'], [])
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['conditions'][0]['remainingTurns'], 1)
        self.assertIsNone(SERVER.find_token(state, 'rider')[1]['conditions'][1]['remainingTurns'])
        self.assertEqual(SERVER.find_token(state, 'mount')[1]['conditions'], [
            {'label': '永久', 'remainingTurns': None},
        ])
        self.assertEqual(SERVER.find_token(state, 'co-rider')[1]['conditions'][0]['remainingTurns'], 2)


class WeatherMarkovTests(unittest.TestCase):
    def test_previous_weather_changes_the_next_day_weights(self):
        profile = SERVER.CLIMATE_PROFILES['temperate']
        rain_weights = SERVER.climate_weather_weights(profile, 'spring', 'rain')
        clear_weights = SERVER.climate_weather_weights(profile, 'spring', 'clear')
        self.assertGreater(rain_weights['rain'], rain_weights['clear'])
        self.assertGreater(clear_weights['clear'], clear_weights['rain'])

    def test_multi_day_jump_runs_the_chain_once_per_missing_day(self):
        encounter = make_state()['encounter']
        calls = []

        def deterministic_random():
            calls.append(True)
            return .42

        target_seconds = 2 * SERVER.WORLD_SECONDS_PER_DAY + SERVER.WEATHER_ROLLOVER_SECONDS
        weather = SERVER.refresh_scheduled_weather(encounter, target_seconds, deterministic_random)
        self.assertIsNotNone(weather)
        self.assertEqual(weather['generatedDay'], 2)
        self.assertEqual(len(calls), 9)  # 每日：天气、温度扰动、风力各一次。

    def test_end_turn_crossing_eight_am_broadcasts_authoritative_weather(self):
        state = make_state()
        state['encounter']['worldTime']['totalSeconds'] = SERVER.WEATHER_ROLLOVER_SECONDS - 1
        state['encounter']['weather']['generatedDay'] = -1
        action = {
            'op': 'endTurn', 'turnSerial': 7, 'nextEntryId': 'init-other', 'nextTurnSerial': 8,
            'round': 2, 'worldTimeSeconds': SERVER.WEATHER_ROLLOVER_SECONDS + 5,
        }
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertIn('weather', action)
        self.assertEqual(action['weather'], state['encounter']['weather'])
        self.assertEqual(action['weather']['generatedDay'], 0)


class PlayerConditionPatchTests(unittest.TestCase):
    def test_owner_can_replace_public_conditions_with_sanitized_data(self):
        state = make_state(play_mode='free')
        requested = [
            {
                'id': 'player-cond-1', 'key': 'custom', 'label': '  被祝福  ', 'icon': '✨',
                'color': '#12abEF', 'remainingTurns': 2000, 'visibility': 'gm',
                'privateNote': '不应广播',
            },
            {
                'id': 'player-cond-2', 'key': 'poisoned', 'label': '伪造名称', 'icon': 'X',
                'color': '#000000', 'remainingTurns': '', 'visibility': 'gm',
            },
            'invalid item',
        ]
        action = {
            'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Alice', 'playMode': 'free',
            'patch': {'conditions': requested},
        }

        self.assertTrue(SERVER.apply_action(state, action))
        conditions = SERVER.find_token(state, 'rider')[1]['conditions']
        self.assertEqual(action['patch']['conditions'], conditions)
        self.assertEqual(len(conditions), 2)
        self.assertEqual(conditions[0], {
            'id': 'player-cond-1', 'key': 'custom', 'label': '被祝福', 'icon': '✨',
            'color': '#12abEF', 'remainingTurns': 999, 'visibility': 'public',
        })
        self.assertEqual(conditions[1]['label'], '中毒')
        self.assertEqual(conditions[1]['icon'], '☠️')
        self.assertEqual(conditions[1]['color'], '#79c267')
        self.assertIsNone(conditions[1]['remainingTurns'])
        self.assertEqual(set(conditions[1]), {
            'id', 'key', 'label', 'icon', 'color', 'remainingTurns', 'visibility',
        })

    def test_condition_patch_is_limited_to_twenty_unique_public_items(self):
        state = make_state(play_mode='free')
        requested = [
            {'id': 'duplicate', 'key': 'custom', 'label': '状态%d' % index, 'visibility': 'gm'}
            for index in range(25)
        ]
        action = {
            'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Alice', 'playMode': 'free',
            'patch': {'conditions': requested},
        }

        self.assertTrue(SERVER.apply_action(state, action))
        conditions = SERVER.find_token(state, 'rider')[1]['conditions']
        self.assertEqual(len(conditions), 20)
        self.assertEqual(len({condition['id'] for condition in conditions}), 20)
        self.assertTrue(all(condition['visibility'] == 'public' for condition in conditions))

    def test_condition_patch_obeys_owner_and_turn_permissions(self):
        state = make_state()
        original = copy.deepcopy(SERVER.find_token(state, 'rider')[1]['conditions'])
        state['encounter']['currentEntryId'] = 'init-other'
        locked = {
            'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Alice', 'playMode': 'turn',
            'turnSerial': 7, 'patch': {'conditions': []},
        }
        self.assertFalse(SERVER.apply_action(state, locked))
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['conditions'], original)

        state = make_state(play_mode='free')
        wrong_owner = {
            'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Bob', 'playMode': 'free',
            'patch': {'conditions': []},
        }
        self.assertFalse(SERVER.apply_action(state, wrong_owner))

    def test_non_array_condition_patch_is_rejected_without_erasing_state(self):
        state = make_state(play_mode='free')
        original = copy.deepcopy(SERVER.find_token(state, 'rider')[1]['conditions'])
        action = {
            'op': 'patchToken', 'tokenId': 'rider', 'actor': 'Alice', 'playMode': 'free',
            'patch': {'conditions': {'label': '错误格式'}},
        }
        self.assertFalse(SERVER.apply_action(state, action))
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['conditions'], original)


class PlayerSpawnTokenTests(unittest.TestCase):
    def normalized(self, state, draft=None, **request_overrides):
        request = {
            'op': 'spawnToken',
            'mapId': 'map-1',
            'x': 5000,
            'y': -50,
            'draft': draft if draft is not None else {
                'name': '  Alice 的召唤物\x00  ',
                'type': 'enemy',
                'owner': 'Mallory',
                'id': 'forged-id',
                'hpMax': 200000,
                'ac': -5,
                'icon': '🐺',
                'size': 2,
            },
        }
        request.update(request_overrides)
        return SERVER.normalize_player_spawn_action(state, request, 'Alice', 'player-123')

    def test_server_owns_identity_type_fields_and_position(self):
        state = make_state(play_mode='free')
        action, error, status = self.normalized(state)

        self.assertIsNone(error)
        self.assertEqual(status, 200)
        token = action['token']
        self.assertRegex(token['id'], r'^pt-player-123-[0-9a-f]{12}$')
        self.assertNotEqual(token['id'], 'forged-id')
        self.assertEqual(token['name'], 'Alice 的召唤物')
        self.assertEqual(token['type'], 'pc')
        self.assertEqual(token['owner'], 'Alice')
        self.assertEqual(token['createdByPlayer'], 'Alice')
        self.assertTrue(token['playerCreated'])
        self.assertEqual((token['hp'], token['hpMax'], token['ac'], token['size']), (99999, 99999, 0, 2))
        self.assertEqual((token['x'], token['y']), (950.0, 50.0))
        self.assertIsNone(token['iconImg'])
        self.assertIsNone(token['iconImgPath'])
        self.assertEqual(token['conditions'], [])

    def test_player_portrait_is_validated_cached_and_attached(self):
        state = make_state(play_mode='free')
        raw = b'\x89PNG\r\n\x1a\n' + b'player-portrait'
        portrait = 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')
        draft = {'name': '头像棋子', 'hpMax': 12, 'ac': 14, 'icon': '🧙', 'size': 1, 'iconImg': portrait}
        key = SERVER.hashlib.sha256(raw).hexdigest()
        try:
            with mock.patch.object(SERVER, 'persist_asset') as persist:
                action, error, status = self.normalized(state, draft=draft)
            self.assertIsNone(error)
            self.assertEqual(status, 200)
            self.assertEqual(action['token']['iconImg'], '/api/assets/' + key)
            persist.assert_called_once_with(key, 'image/png', raw)
        finally:
            SERVER.ASSETS.pop(key, None)

    def test_player_portrait_rejects_unsupported_or_spoofed_content(self):
        state = make_state(play_mode='free')
        base_draft = {'name': '坏头像', 'hpMax': 10, 'ac': 10, 'icon': '🧙', 'size': 1}
        svg = dict(base_draft, iconImg='data:image/svg+xml;base64,' + base64.b64encode(b'<svg/>').decode('ascii'))
        action, error, status = self.normalized(state, draft=svg)
        self.assertIsNone(action)
        self.assertIn('仅支持', error)
        self.assertEqual(status, 400)

        spoofed = dict(base_draft, iconImg='data:image/png;base64,' + base64.b64encode(b'not-a-png').decode('ascii'))
        action, error, status = self.normalized(state, draft=spoofed)
        self.assertIsNone(action)
        self.assertIn('格式不匹配', error)
        self.assertEqual(status, 400)

    def test_apply_is_idempotent_and_another_actor_cannot_replay(self):
        state = make_state(play_mode='free')
        action, _, _ = self.normalized(state, x=300, y=350)
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertTrue(SERVER.apply_action(state, action))
        spawned = [token for token in state['maps'][0]['tokens'] if token.get('playerCreated')]
        self.assertEqual(len(spawned), 1)

        forged_replay = copy.deepcopy(action)
        forged_replay['actor'] = 'Bob'
        self.assertFalse(SERVER.apply_action(state, forged_replay))
        self.assertEqual(len([token for token in state['maps'][0]['tokens'] if token.get('playerCreated')]), 1)

    def test_limit_is_per_player_per_map(self):
        state = make_state(play_mode='free')
        for index in range(SERVER.MAX_PLAYER_TEMP_TOKENS_PER_MAP):
            action, error, status = self.normalized(state, x=100 + index, y=200)
            self.assertIsNone(error)
            self.assertEqual(status, 200)
            self.assertTrue(SERVER.apply_action(state, action))

        action, error, status = self.normalized(state, x=400, y=200)
        self.assertIsNone(action)
        self.assertIn('最多放置 12 个', error)
        self.assertEqual(status, 409)

        bob_action, error, status = SERVER.normalize_player_spawn_action(state, {
            'op': 'spawnToken', 'mapId': 'map-1', 'x': 400, 'y': 200,
            'draft': {'name': 'Bob 的临时棋子', 'hpMax': 10, 'ac': 10, 'icon': '🧙', 'size': 1},
        }, 'Bob', 'player-456')
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertTrue(SERVER.apply_action(state, bob_action))

    def test_invalid_map_draft_and_coordinates_are_rejected(self):
        state = make_state(play_mode='free')
        action, _, status = self.normalized(state, mapId='missing')
        self.assertIsNone(action)
        self.assertEqual(status, 404)

        action, _, status = self.normalized(state, draft='not-an-object')
        self.assertIsNone(action)
        self.assertEqual(status, 400)

        action, _, status = self.normalized(state, x='not-a-number')
        self.assertIsNone(action)
        self.assertEqual(status, 400)


class PlayerDeleteTokenTests(unittest.TestCase):
    def add_temp_token(self, state, owner='Alice'):
        token = {
            'id': 'pt-player-123-delete', 'name': 'Alice 的召唤物', 'type': 'pc',
            'owner': owner, 'playerCreated': True, 'createdByPlayer': owner,
            'size': 2, 'mountId': None, 'x': 250, 'y': 250,
            'hp': 10, 'hpMax': 10, 'ac': 12, 'conditions': [],
        }
        state['maps'][0]['tokens'].append(token)
        return token

    def test_owner_can_delete_temp_token_and_cleanup_linked_state(self):
        state = make_state(play_mode='turn')
        token = self.add_temp_token(state)
        state['maps'][0]['tokens'][0]['mountId'] = token['id']
        state['encounter']['entries'] = [
            {'id': 'init-temp', 'name': token['name'], 'tokenId': token['id'], 'value': 20},
            {'id': 'init-other', 'name': '其他角色', 'tokenId': 'other', 'value': 12},
        ]
        state['encounter']['currentEntryId'] = 'init-temp'
        state['encounter']['turnPath'] = {
            'mapId': 'map-1', 'tokenId': token['id'],
            'points': [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}],
        }
        action, error, status = SERVER.normalize_player_delete_action(state, {
            'op': 'deletePlayerToken', 'mapId': 'map-1', 'tokenId': token['id'],
        }, 'Alice')
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertIsNone(SERVER.find_token(state, token['id'])[1])
        self.assertIsNone(SERVER.find_token(state, 'rider')[1]['mountId'])
        self.assertEqual(state['encounter']['currentEntryId'], 'init-other')
        self.assertEqual(state['encounter']['turnSerial'], 8)
        self.assertEqual(state['encounter']['turnPath']['points'], [])
        self.assertEqual(action['removedEntryIds'], ['init-temp'])

        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['turnSerial'], 8)

    def test_player_cannot_delete_host_or_another_players_token(self):
        state = make_state(play_mode='free')
        action, error, status = SERVER.normalize_player_delete_action(state, {
            'op': 'deletePlayerToken', 'mapId': 'map-1', 'tokenId': 'rider',
        }, 'Alice')
        self.assertIsNone(action)
        self.assertIn('自己创建', error)
        self.assertEqual(status, 403)

        token = self.add_temp_token(state, owner='Bob')
        action, error, status = SERVER.normalize_player_delete_action(state, {
            'op': 'deletePlayerToken', 'mapId': 'map-1', 'tokenId': token['id'],
        }, 'Alice')
        self.assertIsNone(action)
        self.assertIn('自己创建', error)
        self.assertEqual(status, 403)

    def test_delete_rejects_wrong_map_and_forged_replay(self):
        state = make_state(play_mode='free')
        token = self.add_temp_token(state)
        action, error, status = SERVER.normalize_player_delete_action(state, {
            'op': 'deletePlayerToken', 'mapId': 'wrong-map', 'tokenId': token['id'],
        }, 'Alice')
        self.assertIsNone(action)
        self.assertIn('地图与棋子不匹配', error)
        self.assertEqual(status, 400)

        forged = {
            'op': 'deletePlayerToken', 'mapId': 'map-1', 'tokenId': token['id'],
            'actor': 'Mallory',
        }
        self.assertFalse(SERVER.apply_action(state, forged))
        self.assertIsNotNone(SERVER.find_token(state, token['id'])[1])


class PlayerDismountTests(unittest.TestCase):
    def normalize(self, state, player='Alice', **updates):
        request = {
            'op': 'dismountToken', 'mapId': 'map-1', 'tokenId': 'rider',
            'playMode': 'turn' if state['encounter']['playMode'] == 'turn' else 'free',
        }
        if state['encounter']['playMode'] == 'turn':
            request['turnSerial'] = state['encounter']['turnSerial']
        request.update(updates)
        return SERVER.normalize_player_dismount_action(state, request, player)

    def test_owner_can_dismount_in_free_mode_and_replay_is_idempotent(self):
        state = make_state(play_mode='free')
        rider = SERVER.find_token(state, 'rider')[1]
        before_position = (rider['x'], rider['y'])

        action, error, status = self.normalize(state)
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(action['mountId'], 'mount')
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertIsNone(rider['mountId'])
        self.assertEqual((rider['x'], rider['y']), before_position)
        self.assertTrue(SERVER.apply_action(state, action))

    def test_player_cannot_dismount_another_players_rider_or_an_unmounted_token(self):
        state = make_state(play_mode='free')
        action, error, status = self.normalize(state, player='Bob')
        self.assertIsNone(action)
        self.assertIn('自己角色', error)
        self.assertEqual(status, 403)

        state['maps'][0]['tokens'][0]['mountId'] = None
        action, error, status = self.normalize(state)
        self.assertIsNone(action)
        self.assertIn('没有有效坐骑', error)
        self.assertEqual(status, 409)

    def test_turn_mode_requires_the_players_current_turn(self):
        state = make_state(play_mode='turn')
        state['encounter']['currentEntryId'] = 'init-other'
        action, error, status = self.normalize(state)
        self.assertIsNone(action)
        self.assertIn('尚未轮到', error)
        self.assertEqual(status, 403)
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['mountId'], 'mount')

    def test_unique_mount_controller_keeps_initiative_and_path_on_the_rider(self):
        state = make_state(play_mode='turn')
        state['maps'][0]['tokens'] = [
            token for token in state['maps'][0]['tokens'] if token['id'] != 'co-rider'
        ]
        SERVER.find_token(state, 'rider')[1]['type'] = 'pc'
        state['encounter']['entries'][0]['tokenId'] = 'mount'
        state['encounter']['turnPath'] = {
            'mapId': 'map-1', 'tokenId': 'mount',
            'points': [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}],
        }

        action, error, status = self.normalize(state)
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(action['initiativeEntryIds'], ['init-rider'])
        self.assertTrue(action['turnPathTransferred'])
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['entries'][0]['tokenId'], 'rider')
        self.assertEqual(state['encounter']['entries'][0]['color'], '#5b8cff')
        self.assertEqual(state['encounter']['turnPath']['tokenId'], 'rider')
        self.assertEqual(state['encounter']['turnSerial'], 7)
        rider = SERVER.find_token(state, 'rider')[1]
        self.assertEqual(SERVER.can_act_with_token(
            state, rider, 'Alice', {'playMode': 'turn', 'turnSerial': 7}
        ), (True, None))

    def test_shared_mount_turn_is_not_reassigned_to_one_departing_rider(self):
        state = make_state(play_mode='turn')
        state['encounter']['entries'][0]['tokenId'] = 'mount'
        state['encounter']['turnPath'] = {
            'mapId': 'map-1', 'tokenId': 'mount',
            'points': [{'x': 250, 'y': 250}, {'x': 300, 'y': 250}],
        }
        action, error, status = self.normalize(state)
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(action['initiativeEntryIds'], [])
        self.assertFalse(action['turnPathTransferred'])
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['entries'][0]['tokenId'], 'mount')
        self.assertEqual(state['encounter']['turnPath']['tokenId'], 'mount')


class InitiativePreparationTests(unittest.TestCase):
    def make_preparation_state(self):
        state = make_state(play_mode='prepare')
        state['maps'][0]['tokens'].append({
            'id': 'enemy', 'name': '敌人', 'owner': '', 'size': 1, 'mountId': None,
            'x': 700, 'y': 300, 'hp': 10, 'hpMax': 10, 'ac': 12, 'conditions': [],
        })
        state['encounter'].update({
            'currentEntryId': None,
            'turnSerial': 7,
            'entries': [
                {'id': 'init-rider', 'name': '骑手', 'tokenId': 'rider', 'value': 18, 'order': 10},
                {'id': 'init-other', 'name': '其他角色', 'tokenId': 'other', 'value': 18, 'order': 20},
                {'id': 'init-enemy', 'name': '敌人', 'tokenId': 'enemy', 'value': 12, 'order': 30},
            ],
        })
        return state

    def normalize(self, state, request, player='Alice'):
        return SERVER.normalize_player_initiative_action(state, request, player)

    def test_swap_rejects_other_owner_and_stale_serial(self):
        action, _, status = self.normalize(self.make_preparation_state(), {
            'op': 'initiativeSwap', 'entryId': 'init-other', 'targetEntryId': 'init-rider', 'turnSerial': 7,
        })
        self.assertIsNone(action)
        self.assertEqual(status, 403)

        action, _, status = self.normalize(self.make_preparation_state(), {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-other', 'turnSerial': 6,
        })
        self.assertIsNone(action)
        self.assertEqual(status, 409)

    def test_swap_is_available_only_during_combat_preparation(self):
        for mode in ('free', 'turn'):
            state = self.make_preparation_state()
            state['encounter']['playMode'] = mode
            action, _, status = self.normalize(state, {
                'op': 'initiativeSwap', 'entryId': 'init-rider',
                'targetEntryId': 'init-other', 'turnSerial': 7,
            })
            self.assertIsNone(action)
            self.assertEqual(status, 409)

    def test_equal_player_entries_can_swap_and_replay_is_idempotent(self):
        state = self.make_preparation_state()
        action, error, status = self.normalize(state, {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-other', 'turnSerial': 7,
        })
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual([entry['id'] for entry in state['encounter']['entries'][:2]],
                         ['init-other', 'init-rider'])
        self.assertEqual(state['encounter']['turnSerial'], 8)
        self.assertTrue(SERVER.apply_action(state, action))

    def test_swap_rejects_different_value_non_player_and_non_adjacent_target(self):
        state = self.make_preparation_state()
        state['encounter']['entries'][1]['value'] = 17
        action, _, status = self.normalize(state, {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-other', 'turnSerial': 7,
        })
        self.assertIsNone(action)
        self.assertEqual(status, 400)

        state = self.make_preparation_state()
        state['encounter']['entries'] = [
            state['encounter']['entries'][0],
            {'id': 'init-enemy', 'name': '敌人', 'tokenId': 'enemy', 'value': 18, 'order': 15},
            state['encounter']['entries'][1],
        ]
        action, _, status = self.normalize(state, {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-enemy', 'turnSerial': 7,
        })
        self.assertIsNone(action)
        self.assertEqual(status, 403)
        action, _, status = self.normalize(state, {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-other', 'turnSerial': 7,
        })
        self.assertIsNone(action)
        self.assertEqual(status, 400)

    def test_legacy_missing_orders_can_still_swap_safely(self):
        state = self.make_preparation_state()
        state['encounter']['entries'] = state['encounter']['entries'][:2]
        for entry in state['encounter']['entries']:
            entry.pop('order', None)
        action, error, _ = self.normalize(state, {
            'op': 'initiativeSwap', 'entryId': 'init-rider', 'targetEntryId': 'init-other', 'turnSerial': 7,
        })
        self.assertIsNone(error)
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual([entry['id'] for entry in state['encounter']['entries']],
                         ['init-other', 'init-rider'])


class SpellRangeAndRollTests(unittest.TestCase):
    def test_spell_range_normalization(self):
        self.assertEqual(SERVER.normalize_spell_range({'shape': 'radius', 'feet': 183, 'direction': -3}),
                         {'shape': 'radius', 'feet': 180, 'direction': 355})
        self.assertEqual(SERVER.normalize_spell_range({'shape': 'cone', 'feet': 2, 'direction': 362}),
                         {'shape': 'cone', 'feet': 5, 'direction': 0})
        self.assertEqual(SERVER.normalize_spell_range({'shape': 'square', 'feet': 30}),
                         {'shape': 'off', 'feet': 30, 'direction': 0})

    def normalized_roll(self, dice, mode=0, pick=None, sides=20):
        action = {'op': 'roll', 'sides': sides, 'dice': dice, 'mode': mode}
        if pick is not None:
            action['pick'] = pick
        return SERVER.normalize_roll_action(action, 'Alice')

    def test_critical_uses_selected_advantage_or_disadvantage_die(self):
        self.assertEqual(self.normalized_roll([20, 5], 1, 1)['critical'], None)
        self.assertEqual(self.normalized_roll([5, 20], 1, 1)['critical'], 'success')
        self.assertEqual(self.normalized_roll([1, 18], -1, 0)['critical'], 'fail')
        self.assertEqual(self.normalized_roll([1, 20], -1, 0)['critical'], 'fail')

    def test_single_d20_only_triggers_critical(self):
        self.assertEqual(self.normalized_roll([1])['critical'], 'fail')
        self.assertEqual(self.normalized_roll([20])['critical'], 'success')
        self.assertIsNone(self.normalized_roll([20, 20])['critical'])
        self.assertIsNone(self.normalized_roll([1], sides=12)['critical'])

    def test_public_roll_skin_is_validated(self):
        valid = SERVER.normalize_roll_action({'sides': 20, 'dice': [12], 'skin': 'jade'}, 'Alice')
        invalid = SERVER.normalize_roll_action({'sides': 20, 'dice': [12], 'skin': 'unknown'}, 'Alice')
        self.assertEqual(valid['skin'], 'jade')
        self.assertEqual(invalid['skin'], 'obsidian')
        self.assertEqual(valid['visibility'], 'public')


class ReactionTests(unittest.TestCase):
    def test_reaction_validation(self):
        state = make_state()
        valid = SERVER.normalize_map_reaction(state, {
            'reactionId': 'reaction-1', 'mapId': 'map-1', 'x': 100, 'y': 200, 'emoji': '👏'
        }, 'Alice')
        self.assertEqual(valid['name'], 'Alice')
        self.assertEqual(valid['emoji'], '👏')
        self.assertIsNone(SERVER.normalize_map_reaction(state, {
            'reactionId': 'reaction-2', 'mapId': 'map-1', 'x': -1, 'y': 20, 'emoji': '👏'
        }, 'Alice'))
        self.assertIsNone(SERVER.normalize_map_reaction(state, {
            'reactionId': 'reaction-3', 'mapId': 'map-1', 'x': 20, 'y': 20, 'emoji': '🧨'
        }, 'Alice'))


class RestTransitionTests(unittest.TestCase):
    def test_rest_transition_is_a_validated_transient_host_action(self):
        self.assertIn('restTransition', SERVER.HOST_ACTIONS)
        action = SERVER.normalize_rest_transition_action({
            'op': 'restTransition', 'restId': 'rest-123-abc', 'kind': 'short', 'duration': 2200,
        })
        self.assertEqual(action['op'], 'restTransition')
        self.assertEqual(action['kind'], 'short')
        self.assertEqual(action['duration'], 2200)
        self.assertEqual(action['name'], 'GM')
        self.assertIsInstance(action['startedAt'], int)

    def test_rest_transition_rejects_bad_identity_and_clamps_duration(self):
        self.assertIsNone(SERVER.normalize_rest_transition_action({
            'restId': '../bad', 'kind': 'short', 'duration': 2200,
        }))
        self.assertIsNone(SERVER.normalize_rest_transition_action({
            'restId': 'rest-1', 'kind': 'nap', 'duration': 2200,
        }))
        long_rest = SERVER.normalize_rest_transition_action({
            'restId': 'rest-2', 'kind': 'long', 'duration': 99999,
        })
        self.assertEqual(long_rest['duration'], 8000)


if __name__ == '__main__':
    unittest.main()
