import copy
import importlib.util
import sys
import unittest
from pathlib import Path


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

    def test_end_turn_decrements_condition_and_clears_path(self):
        state = make_state()
        state['encounter']['turnPath'] = {'mapId': 'map-1', 'tokenId': 'mount', 'points': [{'x': 250, 'y': 250}]}
        action = {'op': 'endTurn', 'turnSerial': 7, 'nextEntryId': 'init-other', 'nextTurnSerial': 8,
                  'round': 1, 'worldTimeSeconds': 100}
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(state['encounter']['currentEntryId'], 'init-other')
        self.assertEqual(state['encounter']['turnSerial'], 8)
        self.assertEqual(state['encounter']['turnPath']['points'], [])
        self.assertEqual(SERVER.find_token(state, 'rider')[1]['conditions'][0]['remainingTurns'], 1)


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


if __name__ == '__main__':
    unittest.main()
