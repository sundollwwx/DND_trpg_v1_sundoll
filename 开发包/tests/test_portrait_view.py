"""Display framing must survive forms, collections and online player actions."""
import copy
import json
import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_online_rules import SERVER, make_state
import test_player_profiles as profile_fixture

HTTP_SERVER = profile_fixture.SERVER


CENTER = {'scale': 1, 'offsetX': 0, 'offsetY': 0}
CROP = {'scale': 1.65, 'offsetX': -.12, 'offsetY': .18}
DOWN = {'scale': .8, 'offsetX': .2, 'offsetY': -.15}


class PortraitViewTests(unittest.TestCase):
    def state(self):
        state = make_state('free')
        token = SERVER.find_token(state, 'rider')[1]
        token.update(type='pc', iconImgPath='normal.png', portraitVariant=0,
                     portraitVariants=[{'name': '常态', 'iconImgPath': 'normal.png'},
                                       {'name': '战斗', 'iconImgPath': 'fight.png', 'portraitView': CROP},
                                       {'name': '倒地', 'iconImgPath': 'down.png', 'portraitView': DOWN}])
        return state, token

    def action(self, patch, actor='Alice'):
        return dict(op='patchToken', tokenId='rider', actor=actor, playMode='free', patch=patch)

    def shared_image_state(self):
        state, token = self.state()
        token.update(iconImgPath='normal.png', portraitView=CROP, portraitVariant=1)
        token['portraitVariants'] = [dict(form, iconImgPath='normal.png', portraitView=view)
                                    for form, view in zip(token['portraitVariants'], [CENTER, CROP, DOWN])]
        return state, token

    def test_same_image_downed_restore_remembers_view_across_json_and_reorder(self):
        state, token = self.shared_image_state()
        self.assertTrue(SERVER.apply_action(state, self.action({'hp': 0})))
        self.assertEqual(token['portraitVariant'], 2)
        self.assertEqual(token['portraitView'], DOWN)
        self.assertEqual(json.loads(token['portraitBeforeDowned']), {'image': 'iconImgPath:normal.png', 'portraitView': CROP})
        saved = json.loads(json.dumps(token))
        token.clear(); token.update(saved)
        token['portraitVariants'].reverse()
        heal = self.action({'hp': 4})
        self.assertTrue(SERVER.apply_action(state, heal))
        self.assertEqual(token['portraitView'], CROP)
        self.assertEqual(token['portraitVariant'], 1)
        self.assertNotIn('portraitBeforeDowned', token)
        self.assertEqual(heal['patch']['portraitView'], CROP)

    def test_embedded_downed_memory_is_short_and_restores_the_original_view(self):
        state, token = self.shared_image_state()
        embedded = 'data:image/png;base64,' + 'A' * 2048
        token.update(iconImgPath=None, iconImg=embedded)
        for form in token['portraitVariants']:
            form.update(iconImgPath=None, iconImg=embedded)
        self.assertTrue(SERVER.apply_action(state, self.action({'hp': 0})))
        marker = token['portraitBeforeDowned']
        self.assertLess(len(marker), 200)
        self.assertTrue(json.loads(marker)['image'].startswith('iconImg:fnv64:'))
        token['portraitBeforeDowned'] = marker[:1024]
        token['portraitVariants'].reverse()
        self.assertTrue(SERVER.apply_action(state, self.action({'hp': 4})))
        self.assertEqual(token['iconImg'], embedded)
        self.assertEqual(token['portraitView'], CROP)

    def test_compact_marker_fingerprint_matches_client_utf16_vectors(self):
        for value, expected in [('a', '089be207b544f1e4'), ('foobar', 'c882d5010e965f1a'), ('木精灵🧝', 'e1b1249d2054c5fb')]:
            self.assertEqual(SERVER.portrait_before_image({'iconImg': value}), 'iconImg:fnv64:' + expected)
        self.assertEqual(SERVER.portrait_before_image({'iconImg': 'a', 'iconImgId': 'cache-id'}), 'iconImgId:cache-id')

    def test_legacy_embedded_sha_markers_restore_the_previous_form(self):
        for as_json in (False, True):
            state, token = self.shared_image_state()
            for i, form in enumerate(token['portraitVariants']):
                form.update(iconImgPath=None, iconImg='data:image/png;base64,' + str(i) * 2048)
            token.update(iconImgPath=None, iconImg=token['portraitVariants'][1]['iconImg'])
            previous = SERVER.portrait_asset_identity(token)
            self.assertTrue(SERVER.apply_action(state, self.action({'hp': 0})))
            token['portraitBeforeDowned'] = json.dumps({'image': previous, 'portraitView': CROP}) if as_json else previous
            self.assertTrue(SERVER.apply_action(state, self.action({'hp': 4})))
            self.assertEqual(token['portraitView'], CROP)
            self.assertEqual(token['iconImg'], token['portraitVariants'][1]['iconImg'])

    def test_same_image_form_edit_reorder_preserves_selection_and_all_views(self):
        state, token = self.shared_image_state()
        forms = copy.deepcopy(token['portraitVariants'])
        forms[0]['portraitView'] = dict(CENTER, offsetX=.4)
        forms.reverse()
        action = self.action({'portraitVariants': forms})
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(len(token['portraitVariants']), 3)
        self.assertEqual(token['portraitView'], CROP)
        self.assertEqual(token['portraitVariant'], 1)
        self.assertEqual(token['portraitVariants'][2]['portraitView'], dict(CENTER, offsetX=.4))

    def test_same_image_view_patch_changes_only_active_form(self):
        state, token = self.shared_image_state()
        new_view = dict(CROP, scale=2)
        self.assertTrue(SERVER.apply_action(state, self.action({'portraitView': new_view})))
        self.assertEqual([form['portraitView'] for form in token['portraitVariants']], [CENTER, new_view, DOWN])

    def test_variant_source_with_view_selects_matching_form_after_reorder(self):
        state, token = self.shared_image_state()
        self.assertTrue(SERVER.apply_action(state, self.action({'portraitVariant': 0, 'portraitVariantSource': copy.deepcopy(token['portraitVariants'][1])})))
        self.assertEqual(token['portraitVariant'], 1)
        self.assertEqual(token['portraitView'], CROP)

    def test_finite_bounded_values_and_legacy_default(self):
        normalize = SERVER.profiles.normalize_portrait_view
        self.assertIsNone(normalize(None))
        self.assertEqual(normalize(CENTER), CENTER)
        for view in ({'scale': .5, 'offsetX': -1, 'offsetY': 1}, {'scale': 3, 'offsetX': 1, 'offsetY': -1}):
            self.assertEqual(normalize(view), view)
        invalid = [[], {}, {'scale': 1}, dict(CENTER, extra=1)]
        invalid += [dict(CENTER, scale=value) for value in (True, '1', float('nan'), float('inf'), .49, 3.01, 10**1000)]
        invalid += [dict(CENTER, offsetX=value) for value in (False, float('-inf'), -1.01, 1.01)]
        for view in invalid:
            with self.subTest(view=view), self.assertRaises(SERVER.profiles.ProfileError):
                normalize(view)

    def test_switch_copies_view_and_clears_previous_view_for_legacy_form(self):
        state, token = self.state()
        action = self.action({'portraitVariant': 1})
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(token['portraitView'], CROP)
        self.assertEqual(action['patch']['portraitView'], CROP)
        action = self.action({'portraitVariant': 0})
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertNotIn('portraitView', token)
        self.assertIsNone(action['patch']['portraitView'])

    def test_view_patch_updates_active_form_and_broadcasts_normalized_forms(self):
        state, token = self.state()
        action = self.action({'portraitView': CROP})
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(token['portraitView'], CROP)
        self.assertEqual(token['portraitVariants'][0]['portraitView'], CROP)
        self.assertEqual(action['patch']['portraitVariants'][0]['portraitView'], CROP)

    def test_switch_and_crop_in_one_action_apply_to_destination(self):
        for patch in ({'portraitView': CENTER, 'portraitVariant': 1}, {'portraitVariant': 1, 'portraitView': CENTER}):
            state, token = self.state()
            self.assertTrue(SERVER.apply_action(state, self.action(patch)))
            self.assertEqual(token['iconImgPath'], 'fight.png')
            self.assertEqual(token['portraitView'], CENTER)
            self.assertEqual(token['portraitVariants'][1]['portraitView'], CENTER)
            self.assertNotIn('portraitView', token['portraitVariants'][0])

    def test_invalid_view_rejects_action_before_other_fields_change(self):
        for patch in ({'hp': 1, 'portraitView': dict(CENTER, scale=float('nan'))},
                      {'portraitVariants': [{'name': '坏形态', 'iconImgPath': 'normal.png', 'portraitView': {'scale': 2}}], 'hp': 1},
                      {'portraitVariant': 1, 'portraitVariantSource': {'iconImgPath': 'fight.png', 'portraitView': {'scale': 2}}, 'hp': 1}):
            state, token = self.state()
            before = copy.deepcopy(token)
            self.assertFalse(SERVER.apply_action(state, self.action(patch)))
            self.assertEqual(token, before)

    def test_other_player_cannot_change_framing(self):
        state, token = self.state()
        self.assertFalse(SERVER.apply_action(state, self.action({'portraitView': CROP}, actor='Bob')))
        self.assertNotIn('portraitView', token)

    def test_form_edits_preserve_omitted_view_but_allow_explicit_change(self):
        state, token = self.state()
        action = self.action({'portraitVariants': [{'name': '新战斗', 'iconImgPath': 'fight.png'},
                                                   {'name': '常态', 'iconImgPath': 'normal.png', 'portraitView': CENTER},
                                                   {'name': '未授权', 'iconImgPath': '../../secret.png', 'portraitView': CENTER}]})
        self.assertTrue(SERVER.apply_action(state, action))
        self.assertEqual(len(token['portraitVariants']), 2)
        self.assertEqual(token['portraitVariants'][0]['portraitView'], CROP)
        self.assertEqual(token['portraitView'], CENTER)
        self.assertEqual(token['portraitVariant'], 1)

    def test_downed_and_restore_follow_form_framing_after_reorder(self):
        state, token = self.state()
        self.assertTrue(SERVER.apply_action(state, self.action({'portraitVariant': 1})))
        damage = self.action({'hp': 0})
        self.assertTrue(SERVER.apply_action(state, damage))
        self.assertEqual(token['portraitView'], DOWN)
        self.assertEqual(damage['patch']['portraitView'], DOWN)
        token['portraitVariants'].reverse()
        heal = self.action({'hp': 4})
        self.assertTrue(SERVER.apply_action(state, heal))
        self.assertEqual(token['iconImgPath'], 'fight.png')
        self.assertEqual(token['portraitView'], CROP)
        self.assertEqual(heal['patch']['portraitView'], CROP)

    def test_public_snapshot_and_character_updates_keep_framing(self):
        state, token = self.state()
        token.update(portraitView=CROP, ownedPieceId='character', ownerPlayerId='Alice', characterRevision=2)
        state['maps'][0]['playerAccessible'] = True
        with mock.patch.object(SERVER, 'STATE', state):
            snapshot = SERVER.state_snapshot()
        visible = snapshot['maps'][0]['tokens'][0]
        self.assertEqual(visible['portraitView'], CROP)
        self.assertEqual(visible['portraitVariants'][2]['portraitView'], DOWN)
        self.assertEqual(SERVER.character_updates(state, public=True)[0]['patch']['portraitView'], CROP)

    def test_spawn_accepts_explicit_view_and_rejects_invalid_values(self):
        state = make_state('free')
        draft = dict(name='新棋子', portraitView=CENTER)
        request = dict(op='spawnToken', mapId='map-1', x=200, y=200, draft=draft)
        action, error, status = SERVER.normalize_player_spawn_action(state, request, 'Alice', 'pid')
        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(action['token']['portraitView'], CENTER)
        draft['portraitView'] = dict(CENTER, offsetX=2)
        action, error, status = SERVER.normalize_player_spawn_action(state, request, 'Alice', 'pid')
        self.assertIsNone(action)
        self.assertTrue(error)
        self.assertEqual(status, 400)


class PortraitViewCollectionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.store = SERVER.profiles.Store(self.root / '存档', self.root, self.root / 'cache')
        self.pid = self.store.create('玩家甲')['profile']['playerId']
        art = self.root / 'asset/棋子库'
        art.mkdir(parents=True)
        for name in ('normal', 'fight', 'down'):
            (art / (name + '.png')).write_bytes(b'\x89PNG\r\n\x1a\n' + name.encode())
        self.preset = dict(id='preset', name='角色', type='pc', hpMax=20, ac=12, iconImgPath='normal.png', portraitView=CENTER,
                           portraitVariants=[{'name': '战斗', 'iconImgPath': 'fight.png', 'portraitView': CROP},
                                             {'name': '倒地', 'iconImgPath': 'down.png', 'portraitView': DOWN}])

    def grant(self):
        return self.store.grant(self.pid, self.preset, 'portrait-view-test-grant')

    def shared_image_grant(self):
        self.preset.update(iconImgPath='normal.png', portraitView=CROP, portraitVariant=1,
                           portraitVariants=[{'name': name, 'iconImgPath': 'normal.png', 'portraitView': view}
                                             for name, view in [('常态', CENTER), ('战斗', CROP), ('倒地', DOWN)]])
        return self.grant()

    def test_same_image_snapshot_and_edit_preserve_independent_views(self):
        library = self.shared_image_grant()
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitVariant'], 1)
        self.assertEqual(len(piece['portraitVariants']), 3)
        new_view = dict(CROP, scale=2)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitView': new_view}, piece['revision'])
        piece = library['pieces'][0]
        self.assertEqual([form['portraitView'] for form in piece['portraitVariants']], [CENTER, new_view, DOWN])
        self.assertEqual(piece['portraitVariant'], 1)

    def test_upload_same_bytes_updates_only_active_form_view(self):
        library = self.shared_image_grant()
        piece = library['pieces'][0]
        source = self.root / 'asset/棋子库/normal.png'
        upload = 'data:image/png;base64,' + base64.b64encode(source.read_bytes()).decode('ascii')
        new_view = dict(CROP, scale=1.25, offsetX=0, offsetY=0)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'iconImg': upload, 'portraitView': new_view}, piece['revision'])
        saved = library['pieces'][0]
        self.assertEqual(len(saved['portraitVariants']), 3)
        self.assertEqual(saved['portraitVariant'], 1)
        self.assertEqual([form['portraitView'] for form in saved['portraitVariants']], [CENTER, new_view, DOWN])

    def test_upload_different_bytes_retains_all_existing_form_views(self):
        library = self.shared_image_grant()
        piece = library['pieces'][0]
        upload = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nnew').decode('ascii')
        new_view = dict(CROP, scale=1.25)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'iconImg': upload, 'portraitView': new_view}, piece['revision'])
        saved = library['pieces'][0]
        self.assertEqual(saved['portraitVariant'], 0)
        self.assertEqual(saved['portraitView'], new_view)
        self.assertEqual([form['portraitView'] for form in saved['portraitVariants'][1:]], [CENTER, CROP, DOWN])

    def test_same_image_inactive_form_edit_and_old_editor_reorder_keep_current(self):
        library = self.shared_image_grant()
        piece = library['pieces'][0]
        forms = copy.deepcopy(piece['portraitVariants'])
        forms[0]['portraitView'] = dict(CENTER, offsetY=.3)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitVariants': forms}, piece['revision'])
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitView'], CROP)
        forms = [{k: v for k, v in form.items() if k != 'portraitView'} for form in reversed(piece['portraitVariants'])]
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitVariants': forms}, piece['revision'])
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitView'], CROP)
        self.assertEqual([form['portraitView'] for form in piece['portraitVariants']], [DOWN, CROP, dict(CENTER, offsetY=.3)])

    def test_same_image_release_keeps_selected_view(self):
        library = self.shared_image_grant()
        piece = library['pieces'][0]
        state = {'maps': [{'id': 'map', 'tokens': [], 'mapW': 400, 'mapH': 400, 'playerAccessible': True}]}
        with mock.patch.object(SERVER, 'profile_store', return_value=self.store):
            action, error, _ = SERVER.normalize_player_owned_release_action(state, {'op': 'releaseOwnedPiece', 'mapId': 'map', 'ownedPieceId': piece['ownedPieceId']}, self.pid, '甲')
        self.assertIsNone(error)
        self.assertEqual(len(action['token']['portraitVariants']), 3)
        self.assertEqual(action['token']['portraitView'], CROP)
        self.assertEqual(action['token']['portraitVariant'], 1)

    def test_grant_snapshot_and_restart_preserve_each_form(self):
        library = self.grant()
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitView'], CENTER)
        self.assertEqual([v['portraitView'] for v in piece['portraitVariants']], [CENTER, CROP, DOWN])
        reopened = SERVER.profiles.Store(self.root / '存档', self.root, self.root / 'cache')
        self.assertEqual(reopened.library(self.pid), library)

    def test_edit_view_then_switch_and_explicit_reset_are_durable(self):
        library = self.grant()
        piece = library['pieces'][0]
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitView': CROP}, piece['revision'])
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitVariants'][0]['portraitView'], CROP)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitVariant': 2}, piece['revision'])
        piece = library['pieces'][0]
        self.assertEqual(piece['portraitView'], DOWN)
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitView': None}, piece['revision'])
        piece = library['pieces'][0]
        self.assertNotIn('portraitView', piece)
        self.assertNotIn('portraitView', piece['portraitVariants'][2])

    def test_older_form_editor_omission_preserves_view(self):
        library = self.grant()
        piece = library['pieces'][0]
        forms = [{k: v for k, v in form.items() if k != 'portraitView'} for form in piece['portraitVariants']]
        library = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'portraitVariants': forms}, piece['revision'])
        self.assertEqual([v['portraitView'] for v in library['pieces'][0]['portraitVariants']], [CENTER, CROP, DOWN])

    def test_invalid_edit_does_not_commit_or_mutate_library(self):
        library = self.grant()
        piece = library['pieces'][0]
        for patch in ({'portraitView': dict(CENTER, scale=True)},
                      {'portraitVariants': [dict(piece['portraitVariants'][0], portraitView=dict(CENTER, offsetY=2))]}):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], patch, piece['revision'])
            self.assertEqual(self.store.library(self.pid), library)

    def test_map_sync_and_release_keep_view(self):
        library = self.grant()
        piece = library['pieces'][0]
        token = dict(piece, id='live', hp=8, portraitView=CROP)
        token['portraitVariants'] = copy.deepcopy(piece['portraitVariants'])
        token['portraitVariants'][0]['portraitView'] = CROP
        saved = self.store.sync_token(self.pid, token, 'campaign')['pieces'][0]
        self.assertEqual(saved['portraitView'], CROP)
        state = {'maps': [{'id': 'map', 'tokens': [token], 'mapW': 400, 'mapH': 400, 'playerAccessible': True}]}
        with mock.patch.object(SERVER, 'profile_store', return_value=self.store):
            action, error, _ = SERVER.normalize_player_owned_release_action(state, {'op': 'releaseOwnedPiece', 'mapId': 'map', 'ownedPieceId': piece['ownedPieceId']}, self.pid, '甲')
        self.assertIsNone(error)
        self.assertEqual(action['token']['portraitView'], CROP)
        token.pop('portraitView')
        token['portraitVariants'][0].pop('portraitView')
        saved = self.store.sync_token(self.pid, token, 'campaign')['pieces'][0]
        self.assertNotIn('portraitView', saved)


class PortraitViewHttpTests(unittest.TestCase):
    setUp = profile_fixture.PlayerProfileHttpTests.setUp
    close_server = profile_fixture.PlayerProfileHttpTests.close_server
    request = profile_fixture.PlayerProfileHttpTests.request
    login = profile_fixture.PlayerProfileHttpTests.login

    def test_player_edit_and_online_patch_keep_view_across_http(self):
        art = self.root / 'asset/棋子库'
        art.mkdir(parents=True)
        (art / 'normal.png').write_bytes(b'\x89PNG\r\n\x1a\nnormal')
        piece = HTTP_SERVER.profile_store().grant(self.pid, dict(name='角色', type='pc', hpMax=20, iconImgPath='normal.png'), 'http-portrait-view-grant')['pieces'][0]
        session = self.login()
        library = HTTP_SERVER.profile_store().library(self.pid)
        status, saved = self.request(dict(op='edit', sessionToken=session, ownedPieceId=piece['ownedPieceId'],
                                          revision=library['revision'], pieceRevision=piece['revision'], patch={'portraitView': CROP}))
        self.assertEqual(status, 200, saved)
        piece = saved['library']['pieces'][0]
        self.assertEqual(piece['portraitView'], CROP)
        self.assertEqual(piece['portraitVariants'][0]['portraitView'], CROP)
        token = dict(piece, id='t', hp=20, owner=self.pid, x=100, y=100)
        state = dict(protocolVersion=HTTP_SERVER.SERVER_PROTOCOL_VERSION, campaignId='view-campaign', activeMapId='m',
                     maps=[{'id': 'm', 'playerAccessible': True, 'tokens': [token]}])
        with mock.patch.object(HTTP_SERVER, 'STATE', state), mock.patch.object(HTTP_SERVER, 'RECENT_ACTIONS', []), mock.patch.object(HTTP_SERVER, 'ACTION_IDS', {}):
            body = dict(sessionToken=session, campaignId='view-campaign', serverSessionId=HTTP_SERVER.SESSION_ID,
                        action={'op': 'patchToken', 'tokenId': 't', 'mapId': 'm', 'playMode': 'free', 'patch': {'portraitView': CENTER}})
            status, result = self.request(body, path='/api/action')
            self.assertEqual(status, 200, result)
            self.assertEqual(HTTP_SERVER.STATE['maps'][0]['tokens'][0]['portraitView'], CENTER)
            self.assertEqual(HTTP_SERVER.RECENT_ACTIONS[-1]['patch']['portraitView'], CENTER)
            self.assertEqual(HTTP_SERVER.profile_store().library(self.pid)['pieces'][0]['portraitView'], CENTER)
            body['action']['patch'] = {'portraitView': dict(CENTER, scale=4), 'hp': 1}
            body['action']['characterRevision'] = HTTP_SERVER.STATE['maps'][0]['tokens'][0].get('characterRevision')
            status, _ = self.request(body, path='/api/action')
            self.assertEqual(status, 400)
            self.assertEqual(HTTP_SERVER.STATE['maps'][0]['tokens'][0]['hp'], 20)


if __name__ == '__main__':
    unittest.main()
