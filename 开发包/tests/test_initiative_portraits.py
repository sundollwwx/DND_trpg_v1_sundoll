from project_test_paths import APP_ROOT
import base64
import copy
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from test_player_profiles import SERVER


class InitiativePortraitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = SERVER.profiles.Store(self.root / '存档', self.root, self.root / 'cache')
        self.pid = self.store.create('头像玩家')['profile']['playerId']
        self.preset = {'id': 'portrait-source', 'name': '勇者', 'type': 'pc', 'hpMax': 20,
                       'iconImg': self.image('body'), 'initiativePortrait': {'iconImg': self.image('default')},
                       'portraitVariants': [{'name': '战斗', 'iconImg': self.image('battle'),
                                             'initiativePortrait': {'iconImg': self.image('battle-head')}}]}

    @staticmethod
    def image(label):
        return 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n' + label.encode()).decode()

    def grant(self):
        return self.store.grant(self.pid, self.preset, 'initiative-grant-01')

    def test_grant_restart_keeps_default_and_form_original_bytes(self):
        lib = self.grant()
        piece = lib['pieces'][0]
        default = piece['initiativePortrait']['iconImgPath']
        battle = piece['portraitVariants'][1]['initiativePortrait']['iconImgPath']
        self.assertNotEqual(default, battle)
        self.assertEqual((self.store.root / '资源' / default.rsplit('/', 1)[-1]).read_bytes(), b'\x89PNG\r\n\x1a\ndefault')
        restored = SERVER.profiles.Store(self.root / '存档', self.root, self.root / 'cache')
        self.assertEqual(restored.library(self.pid), lib)

    def test_host_edits_default_and_player_cannot_set_it_or_import_a_private_path(self):
        lib = self.grant(); piece = lib['pieces'][0]
        for patch in ({'initiativePortrait': {'iconImg': self.image('forbidden')}},
                      {'portraitVariants': [{'name': '秘密', 'iconImgPath': '/Users/private.png',
                                             'initiativePortrait': {'iconImgPath': '/Users/private.png'}}]}):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.store.edit(self.pid, piece['ownedPieceId'], lib['revision'], patch)
        saved = self.store.edit(self.pid, piece['ownedPieceId'], lib['revision'],
                                {'initiativePortrait': {'iconImg': self.image('new-default')}}, host=True)
        self.assertNotEqual(saved['pieces'][0]['initiativePortrait'], piece['initiativePortrait'])
        self.assertEqual(self.store.edit(self.pid, piece['ownedPieceId'], saved['revision'],
                                        {'initiativePortrait': None}, host=True)['pieces'][0]['initiativePortrait'], None)

    def test_changing_only_default_initiative_preserves_form_identifiers_and_crop(self):
        preset = copy.deepcopy(self.preset)
        preset['portraitVariants'][0].update(formId='form-original-01', portraitView={'scale':1.4,'offsetX':0.1,'offsetY':-0.2})
        lib = self.store.grant(self.pid, preset, 'form-id-preservation')
        piece = lib['pieces'][0]
        before = copy.deepcopy(piece['portraitVariants'])
        saved = self.store.edit(self.pid, piece['ownedPieceId'], lib['revision'],
                                {'initiativePortrait': {'iconImg': self.image('new-head')}}, host=True)
        self.assertEqual(saved['pieces'][0]['portraitVariants'], before)
        self.assertIn('form-original-01', [form.get('formId') for form in before])
        piece = saved['pieces'][0]
        legacy_forms = [{k:v for k,v in form.items() if k != 'formId'} for form in piece['portraitVariants']]
        again = self.store.edit(self.pid, piece['ownedPieceId'], saved['revision'],
                                {'portraitVariants': legacy_forms, 'initiativePortrait': None}, host=True)
        self.assertIn('form-original-01', [form.get('formId') for form in again['pieces'][0]['portraitVariants']])

    def test_older_player_form_editor_preserves_host_assigned_head_on_reorder(self):
        lib = self.grant(); piece = lib['pieces'][0]
        forms = [{k: v for k, v in form.items() if k != 'initiativePortrait'} for form in reversed(piece['portraitVariants'])]
        forms[0]['name'] = '改名'
        forms[0]['initiativePortrait'] = {'iconImgPath': '/Users/private.png'}
        saved = self.store.edit(self.pid, piece['ownedPieceId'], lib['revision'], {'portraitVariants': forms})
        self.assertEqual(saved['pieces'][0]['portraitVariants'][0]['initiativePortrait'], piece['portraitVariants'][1]['initiativePortrait'])
        self.assertEqual(saved['pieces'][0]['portraitVariants'][0]['name'], '改名')

    def test_map_variant_normalizer_preserves_only_existing_initiative_sources(self):
        lib = self.grant(); token = lib['pieces'][0]
        raw = copy.deepcopy(token['portraitVariants'])
        raw[-1]['initiativePortrait'] = {'iconImgPath': '/Users/private.png'}
        normalized = SERVER.normalize_player_portrait_variants(raw, token)
        self.assertEqual(normalized[-1]['initiativePortrait'], token['portraitVariants'][-1]['initiativePortrait'])

    def test_source_sync_updates_head_for_existing_body_without_duplicate_forms(self):
        lib = self.grant(); piece = lib['pieces'][0]
        source = copy.deepcopy(self.preset)
        source['initiativePortrait'] = {'iconImg': self.image('updated-default')}
        source['portraitVariants'][0]['initiativePortrait'] = {'iconImg': self.image('updated-battle')}
        with mock.patch.object(SERVER.profiles, 'read_catalog', return_value={'presets': [source]}):
            saved = self.store.sync_forms(self.pid, piece['ownedPieceId'])['pieces'][0]
        self.assertEqual(len(saved['portraitVariants']), len(piece['portraitVariants']))
        self.assertNotEqual(saved['initiativePortrait'], piece['initiativePortrait'])
        self.assertNotEqual(saved['portraitVariants'][1]['initiativePortrait'], piece['portraitVariants'][1]['initiativePortrait'])

    def test_public_media_requires_revealed_map_and_visible_token(self):
        url = '/api/module-assets/' + 'a' * 64
        token = {'initiativePortrait': {'iconImgPath': url}, 'portraitVariants': []}
        state = {'maps': [{'playerAccessible': True, 'tokens': [token]}]}
        self.assertTrue(SERVER.module_asset_is_public(url, state))
        token['hiddenFromPlayers'] = True
        self.assertFalse(SERVER.module_asset_is_public(url, state))
        token.pop('hiddenFromPlayers'); state['maps'][0]['playerAccessible'] = False
        self.assertFalse(SERVER.module_asset_is_public(url, state))
        state['maps'][0]['playerAccessible'] = True
        token['initiativePortrait'] = None
        token['portraitVariants'] = [{'initiativePortrait': {'iconImgPath': url}}]
        self.assertTrue(SERVER.module_asset_is_public(url, state))

    def test_stream_caches_default_and_form_images_without_changing_bytes(self):
        state = {'maps': [{'tokens': [{'initiativePortrait': {'iconImg': self.image('head')},
                                      'portraitVariants': [{'initiativePortrait': {'iconImgHd': self.image('form-head')}}]}]}]}
        with mock.patch.object(SERVER, 'persist_asset', return_value=True) as persist:
            result = SERVER.cache_stream_media(state)
        token = result['maps'][0]['tokens'][0]
        self.assertTrue(token['initiativePortrait']['iconImg'].startswith('/api/assets/'))
        self.assertTrue(token['portraitVariants'][0]['initiativePortrait']['iconImgHd'].startswith('/api/assets/'))
        self.assertEqual({call.args[2] for call in persist.call_args_list}, {b'\x89PNG\r\n\x1a\nhead', b'\x89PNG\r\n\x1a\nform-head'})

    def test_module_library_registers_nested_originals_and_survives_reopen(self):
        from server.module_runtime import ModuleRuntime
        from server.module_store import ModuleStore
        from server.workspace import enable
        module_root = self.root / 'module-workspace'
        enable(module_root)
        runtime = ModuleRuntime(module_root / '运行数据/存档', self.root / 'app')
        runtime.ensure_empty_runtime()
        store = SERVER.profiles.Store(runtime.root, runtime.app, self.root / 'module-cache')
        pid = store.create('模块头像玩家')['profile']['playerId']
        lib = store.grant(pid, self.preset, 'module-initiative-grant')
        portrait = lib['pieces'][0]['initiativePortrait']['iconImgPath']
        self.assertTrue(portrait.startswith('/api/module-assets/'))
        asset = ModuleStore(runtime.root).asset(portrait.rsplit('/', 1)[-1])
        self.assertEqual(asset[0].read_bytes(), b'\x89PNG\r\n\x1a\ndefault')
        reopened = SERVER.profiles.Store(runtime.root, runtime.app, self.root / 'module-cache')
        self.assertEqual(reopened.library(pid), lib)


if __name__ == '__main__': unittest.main()
