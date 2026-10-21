from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import copy
import importlib.util
import json
import sys
import tempfile
import unittest
import threading
import http.client
from pathlib import Path
from unittest import mock

ROOT = APP_ROOT
spec = importlib.util.spec_from_file_location('profile_test_server', ROOT/'server/http_app.py')
SERVER = importlib.util.module_from_spec(spec)
with mock.patch.object(sys, 'argv', ['server']): spec.loader.exec_module(SERVER)

class PlayerProfilesTests(unittest.TestCase):
    def test_collection_roles_prioritize_pc_and_persist_one_main(self):
        lib=self.store.grant(self.pid,dict(self.preset,name='仆从',type='ally'),'companion-role-grant')
        pet=lib['pieces'][-1]
        lib=self.store.grant(self.pid,dict(self.preset,name='主角',type='pc'),'main-role-grant-01')
        hero=lib['pieces'][-1]
        roles=self.store.piece_roles(lib)
        self.assertEqual(roles[pet['ownedPieceId']],'companion')
        self.assertEqual(roles[hero['ownedPieceId']],'main')
        lib=self.store.edit(self.pid,pet['ownedPieceId'],lib['revision'],{'collectionRole':'main'},pet['revision'])
        pet=next(p for p in lib['pieces'] if p['ownedPieceId']==pet['ownedPieceId'])
        self.assertEqual(self.store.piece_roles(lib)[pet['ownedPieceId']],'main')
        lib=self.store.edit(self.pid,hero['ownedPieceId'],lib['revision'],{'collectionRole':'main'},hero['revision'])
        self.assertEqual(sum(p.get('collectionRole')=='main' for p in lib['pieces']),1)
        self.assertEqual(self.store.piece_roles(self.store.library(self.pid))[hero['ownedPieceId']],'main')
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.store.edit(self.pid,hero['ownedPieceId'],lib['revision'],{'collectionRole':'admin'})

    def test_all_body_sizes_survive_grant_edit_and_map_sync(self):
        from server.token_sizes import CATEGORIES, size_fields
        for index, category in enumerate(CATEGORIES):
            dimensions = size_fields({'sizeCategory': category})
            lib = self.store.grant(self.pid, dict(self.preset, **dimensions), 'size-grant-case-%02d' % index)
            piece = lib['pieces'][-1]
            self.assertEqual(piece['sizeCategory'], category)
            self.assertEqual(piece['size'], dimensions['size'])
            synced = self.store.sync_token(self.pid, dict(piece, id='map-token', hp=7), 'size-test')
            saved = next(p for p in synced['pieces'] if p['ownedPieceId'] == piece['ownedPieceId'])
            self.assertEqual(saved['sizeCategory'], category)
            self.assertEqual(saved['campaignStates']['size-test']['hp'], 7)

    def test_host_can_edit_piece_stats_but_player_cannot(self):
        library = self.store.grant(self.pid, self.preset, 'attribute-editor')
        piece = library['pieces'][0]
        patch = {'hpMax': 35, 'ac': 16, 'level': 5, 'size': 2}
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], patch)
        for invalid in ({'ac': -1}, {'size': 5}, {'hpMax': 1.5}, {'level': True}):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], invalid, host=True)
        saved = self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], patch, piece_revision=piece['revision'], host=True)
        for key, value in patch.items(): self.assertEqual(saved['pieces'][0][key], value)
        with self.assertRaises(SERVER.profiles.ProfileError):
            self.store.edit(self.pid, piece['ownedPieceId'], library['revision'], {'ac': 20}, piece_revision=piece['revision'], host=True)

    def test_rename_preserves_credentials_library_and_identity(self):
        version=self.store.login(self.credential)['_authVersion'];library=self.store.library(self.pid)
        renamed=self.store.rename(self.pid,'新名字','玩家甲')
        self.assertEqual(renamed['playerId'],self.pid)
        self.assertEqual(self.store.login(self.credential)['name'],'新名字')
        self.assertTrue(self.store.session_valid(self.pid,version))
        self.assertEqual(self.store.library(self.pid),library)
        self.store.create('占用')
        for name,expected in [('占用','新名字'),('新名称','旧名字'),('','新名字')]:
            with self.assertRaises(SERVER.profiles.ProfileError):self.store.rename(self.pid,name,expected)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):self.store.rename(self.pid,'不应保存','新名字')
        self.assertEqual(self.store.read(self.pid)['name'],'新名字')
    def test_registration_retry_collision_and_no_privilege_inheritance(self):
        profile=self.store.register('新玩家','NewPlayer-2026')
        again=self.store.register('新玩家','NewPlayer-2026')
        self.assertEqual(profile['playerId'],again['playerId'])
        self.assertEqual(self.store.library(profile['playerId'])['pieces'],[])
        for name,code in [('新玩家','Another-2026'),('另一个玩家','NewPlayer-2026'),('', 'ValidCode-2026'),('x'*25,'ValidCode-2026')]:
            with self.assertRaises(SERVER.profiles.ProfileError):self.store.register(name,code)

    def test_registration_failure_does_not_reserve_code(self):
        original=SERVER.profiles.atomic
        def fail_profile(path,value):
            if Path(path).name=='当前档案.json':raise OSError('disk full')
            return original(path,value)
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=fail_profile):
            with self.assertRaises(OSError):self.store.register('重试玩家','RetryCode-2026')
        profile=self.store.register('重试玩家','RetryCode-2026')
        self.assertEqual(self.store.login('RetryCode-2026')['playerId'],profile['playerId'])

    def test_concurrent_registrations_with_same_name_have_one_identity(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            result=list(pool.map(lambda _: self.store.register('同时注册','Concurrent-2026'),range(2)))
        self.assertEqual(result[0]['playerId'],result[1]['playerId'])
    def test_custom_code_replaces_long_credential_but_preserves_identity_and_library(self):
        before=self.store.library(self.pid);version=self.store.login(self.credential)['_authVersion']
        code=self.store.rotate(self.pid,login_code='Sundoll-2026')
        self.assertEqual(code,'Sundoll-2026');self.assertEqual(self.store.credential(self.pid),code)
        self.assertEqual(self.store.login(code)['playerId'],self.pid)
        self.assertFalse(self.store.session_valid(self.pid,version))
        with self.assertRaises(SERVER.profiles.ProfileError):self.store.login(self.credential)
        self.assertEqual(before,self.store.library(self.pid))
        self.assertTrue(list((self.store.root/'认证/自动备份').glob('*.json')))
        self.assertNotIn(code,json.dumps(self.store.players()))

    def test_custom_code_uniqueness_validation_and_restart(self):
        self.store.rotate(self.pid,login_code='Unique_2026')
        other=self.store.create('乙')['profile']['playerId']
        for code in ['short','has space here','has.dot.2026','x'*49,'Unique_2026']:
            with self.assertRaises(SERVER.profiles.ProfileError):self.store.rotate(other,login_code=code)
        restored=SERVER.profiles.Store(self.root/'存档',self.root,self.root/'cache')
        self.assertEqual(restored.login('Unique_2026')['playerId'],self.pid)
        with self.assertRaises(SERVER.profiles.ProfileError):restored.login('unique_2026')
        created=self.store.create('丙',login_code='PlayerC-2026')
        self.assertEqual(self.store.login('PlayerC-2026')['playerId'],created['profile']['playerId'])

    def test_failed_custom_update_keeps_previous_login_and_reset_revokes_custom_code(self):
        with mock.patch.object(SERVER.profiles,'atomic',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):self.store.rotate(self.pid,login_code='NewCode-2026')
        self.assertEqual(self.store.login(self.credential)['playerId'],self.pid)
        self.store.rotate(self.pid,login_code='NewCode-2026')
        replacement=self.store.rotate(self.pid)
        with self.assertRaises(SERVER.profiles.ProfileError):self.store.login('NewCode-2026')
        self.assertEqual(self.store.login(replacement)['playerId'],self.pid)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = SERVER.profiles.Store(self.root/'存档', self.root, self.root/'cache')
        created = self.store.create('玩家甲')
        self.pid = created['profile']['playerId']; self.credential = created['credential']
        self.preset = {'id':'l1','name':'勇者','type':'pc','hpMax':20,'ac':12}
    def test_map_form_sync_is_durable_and_preserves_unrelated_library_edits(self):
        import copy
        art=self.root/'asset/棋子库/立绘';art.mkdir(parents=True)
        for name in ('甲','乙'):(art/(name+'.png')).write_bytes(b'\x89PNG\r\n\x1a\n'+name.encode())
        source=dict(self.preset,iconImgPath='立绘/甲.png',portraitVariants=[{'name':name,'iconImgPath':'立绘/'+name+'.png'} for name in ('甲','乙')])
        piece=self.store.grant(self.pid,source,'map-forms-sync-01')['pieces'][0]
        token=dict(piece,id='live',hp=8,tempHp=2,portraitVariant=1,iconImgPath=piece['portraitVariants'][1]['iconImgPath'])
        saved=self.store.sync_token(self.pid,token,'campaign-a')['pieces'][0]
        self.assertEqual(saved['portraitVariant'],1);self.assertEqual(saved['campaignStates']['campaign-a']['hp'],8)
        self.store.edit(self.pid,piece['ownedPieceId'],None,{'publicNote':'新笔记'},saved['revision'])
        token['hp']=4
        latest=self.store.sync_token(self.pid,token,'campaign-a')['pieces'][0]
        self.assertEqual(latest['publicNote'],'新笔记');self.assertEqual(latest['campaignStates']['campaign-a']['hp'],4)
        unchanged=self.store.library(self.pid)
        self.assertEqual(self.store.sync_token(self.pid,token,'campaign-a'),unchanged)
        restored=SERVER.profiles.Store(self.root/'存档',self.root,self.root/'cache')
        self.assertEqual(restored.library(self.pid),unchanged)
        before={'campaignId':'campaign-a','maps':[{'id':'m1','tokens':[copy.deepcopy(token)]}]}
        after=copy.deepcopy(before);after['maps'][0]['tokens'][0]['ac']=18
        with mock.patch.object(SERVER,'profile_store',return_value=restored):SERVER.sync_changed_owned_tokens(before,after)
        self.assertEqual(restored.library(self.pid)['pieces'][0]['ac'],18)

    def test_persistent_identity_and_rotation(self):
        restored = SERVER.profiles.Store(self.root/'存档', self.root, self.root/'cache')
        self.assertEqual(restored.login(self.credential)['playerId'], self.pid)
        public = json.dumps(restored.players()) + json.dumps(restored.library(self.pid))
        self.assertNotIn(self.credential.split('.')[1], public)
        replacement = restored.rotate(self.pid)
        with self.assertRaises(SERVER.profiles.ProfileError): restored.login(self.credential)
        self.assertEqual(restored.login(replacement)['playerId'], self.pid)
    def test_copy_preserves_credentials_and_sessions(self):
        version = self.store.login(self.credential)['_authVersion']
        self.assertEqual(self.store.credential(self.pid), self.credential)
        self.assertTrue(self.store.session_valid(self.pid, version))
        path = self.store.root / '认证' / (self.pid + '.json')
        record = json.loads(path.read_text())
        record.pop('copySecret')
        record.pop('version')
        path.write_text(json.dumps(record))
        version = self.store.login(self.credential)['_authVersion']
        copied = self.store.credential(self.pid)
        self.assertEqual(copied, self.store.credential(self.pid))
        self.assertEqual(self.store.login(copied)['_authVersion'], version)
        self.assertEqual(self.store.login(self.credential)['_authVersion'], version)
        self.assertTrue(self.store.session_valid(self.pid, version))
        replacement = self.store.rotate(self.pid)
        for old in (copied, self.credential):
            with self.assertRaises(SERVER.profiles.ProfileError): self.store.login(old)
        self.assertEqual(self.store.credential(self.pid), replacement)
        self.assertFalse(self.store.session_valid(self.pid, version))

    def test_forms_grant_default_merge_release_and_roundtrip(self):
        art = self.root / 'asset/棋子库'
        art.mkdir(parents=True)
        for name in ('base','fire','ice'):
            (art / (name+'.png')).write_bytes(b'\x89PNG\r\n\x1a\n'+name.encode())
        preset = dict(self.preset, iconImgPath='base.png', portraitVariants=[
            {'name':'火焰','iconImgPath':'fire.png'},
            {'name':'寒冰','iconImgPath':'ice.png'}])
        library = self.store.grant(self.pid,preset,'forms-roundtrip-test')
        piece = library['pieces'][0]
        self.assertEqual(len(piece['portraitVariants']),3)
        self.assertEqual(piece['sourcePresetId'],'l1')
        self.assertTrue(all(v['iconImgPath'].startswith('/api/player-art/') for v in piece['portraitVariants']))
        saved = self.store.edit(self.pid,piece['ownedPieceId'],library['revision'],{'portraitVariant':2},piece_revision=1)
        piece = saved['pieces'][0]
        self.assertEqual(piece['iconImgPath'],piece['portraitVariants'][2]['iconImgPath'])
        restarted = SERVER.profiles.Store(self.root/'存档',self.root,self.root/'cache')
        self.assertEqual(restarted.library(self.pid),saved)
        token = dict(piece,id='existing',hp=3,tempHp=5,conditions=[{'label':'受伤'}],portraitVariants=piece['portraitVariants'][:1])
        state = {'maps':[{'id':'m','playerAccessible':True,'mapW':600,'mapH':400,'tokens':[token]}]}
        with mock.patch.object(SERVER,'profile_store',return_value=restarted):
            action,error,_ = SERVER.normalize_player_owned_release_action(state,{'op':'releaseOwnedPiece','mapId':'m','ownedPieceId':piece['ownedPieceId']},self.pid,'甲')
        self.assertFalse(error)
        self.assertEqual(action['token']['hp'],3)
        self.assertEqual(action['token']['tempHp'],5)
        self.assertEqual(len(action['token']['portraitVariants']),3)
        self.assertEqual(action['token']['iconImgPath'],piece['iconImgPath'])

    def test_sync_forms_repairs_legacy_source_without_duplicate_or_reset(self):
        art = self.root / 'asset/棋子库';art.mkdir(parents=True)
        (art/'form.png').write_bytes(b'\x89PNG\r\n\x1a\nform')
        source = dict(self.preset, portraitVariants=[{'name':'新形态','iconImgPath':'form.png'}])
        path = self.root / '存档/棋子库/棋子库.json';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'presets':[source]}))
        lib=self.store.grant(self.pid,dict(self.preset,id='old-map-token'),'legacy-forms-grant')
        oid=lib['pieces'][0]['ownedPieceId']
        updated=self.store.sync_forms(self.pid,oid)
        self.assertEqual(updated['pieces'][0]['sourcePresetId'],'l1')
        self.assertEqual(len(updated['pieces'][0]['portraitVariants']),1)
        self.assertEqual(updated,self.store.sync_forms(self.pid,oid))
        self.assertTrue(list(self.store.path(self.pid,'自动备份').glob('*.json')))

    def test_grant_is_idempotent_and_two_players_are_independent(self):
        first = self.store.grant(self.pid,self.preset,'grant-request-0001')
        again = self.store.grant(self.pid,dict(self.preset,name='changed'),'grant-request-0001')
        self.assertEqual(first,again)
        other = self.store.create('玩家乙')['profile']['playerId']
        second = self.store.grant(other,self.preset,'grant-request-0001')
        self.assertNotEqual(first['pieces'][0]['ownedPieceId'],second['pieces'][0]['ownedPieceId'])
        edited=self.store.edit(self.pid,first['pieces'][0]['ownedPieceId'],first['revision'],{'name':'改名'})
        self.assertEqual(edited['pieces'][0]['name'],'改名')
        self.assertEqual(self.store.library(other)['pieces'][0]['name'],'勇者')
        self.assertEqual(self.preset['name'],'勇者')
    def test_media_survives_original_deletion_and_edit(self):
        image=self.root/'asset/棋子库/立绘/勇者.png';image.parent.mkdir(parents=True)
        raw=b'\x89PNG\r\n\x1a\nimmutable-original';image.write_bytes(raw)
        self.preset.update(iconImgPath='立绘/勇者.png',portraitVariants=[{'name':'战斗','iconImgPath':'立绘/勇者.png'}])
        lib=self.store.grant(self.pid,self.preset,'grant-request-0001');piece=lib['pieces'][0]
        image.unlink()
        target=self.store.root/'资源'/piece['iconImgPath'].rsplit('/',1)[-1]
        self.assertEqual(target.read_bytes(),raw)
        self.store.edit(self.pid,piece['ownedPieceId'],lib['revision'],{'publicNote':'说明'})
        self.assertEqual(target.read_bytes(),raw)
    def test_revision_conflict_and_forged_ownership_rejected(self):
        lib=self.store.grant(self.pid,self.preset,'grant-request-0001');piece=lib['pieces'][0]
        for revision, patch, status in [(1,{'name':'旧编辑'},409),(lib['revision'],{'ownerPlayerId':'fake'},403)]:
            with self.assertRaises(SERVER.profiles.ProfileError) as caught:
                self.store.edit(self.pid,piece['ownedPieceId'],revision,patch)
            self.assertEqual(caught.exception.status,status)
        self.assertEqual(self.store.library(self.pid),lib)
    def test_failed_commit_leaves_original_and_retry_once(self):
        original=self.store.library(self.pid)
        with mock.patch.object(SERVER.profiles.os,'replace',side_effect=OSError('full')):
            with self.assertRaises(OSError): self.store.grant(self.pid,self.preset,'grant-request-0001')
        self.assertEqual(self.store.library(self.pid),original)
        self.assertEqual(len(self.store.grant(self.pid,self.preset,'grant-request-0001')['pieces']),1)
    def test_bound_piece_authorization_uses_registry_and_id(self):
        lib=self.store.grant(self.pid,self.preset,'grant-request-0001')
        token=dict(lib['pieces'][0],owner='玩家甲',id='t1')
        with mock.patch.object(SERVER,'profile_store',return_value=self.store):
            self.assertTrue(SERVER.can_control({},token,self.pid))
            self.assertFalse(SERVER.can_control({},token,'玩家甲'))
            self.assertFalse(SERVER.can_control({},dict(token,ownerPlayerId='p'+'f'*32),'p'+'f'*32))
    def test_path_traversal_and_remote_resources_rejected(self):
        for source in ('https://example.com/a.png','../../secret.png','data:text/html;base64,WA=='):
            with self.assertRaises(SERVER.profiles.ProfileError): self.store.snapshot_image(source)
        with self.assertRaises(SERVER.profiles.ProfileError): self.store.read('../../认证')

    def test_piece_revision_allows_independent_edits(self):
        self.store.grant(self.pid,self.preset,'grant-request-0001')
        lib=self.store.grant(self.pid,self.preset,'grant-request-0002')
        a,b=lib['pieces']
        self.store.edit(self.pid,a['ownedPieceId'],lib['revision'],{'name':'甲'},piece_revision=1)
        saved=self.store.edit(self.pid,b['ownedPieceId'],lib['revision'],{'name':'乙'},piece_revision=1)
        self.assertEqual([p['name'] for p in saved['pieces']],['甲','乙'])
        with self.assertRaises(SERVER.profiles.ProfileError) as error:
            self.store.edit(self.pid,a['ownedPieceId'],saved['revision'],{'name':'stale'},piece_revision=1)
        self.assertEqual(error.exception.status,409)
    def test_editor_rejects_host_paths_and_malformed_variants(self):
        lib=self.store.grant(self.pid,self.preset,'grant-request-0001');oid=lib['pieces'][0]['ownedPieceId']
        for patch in ({'iconImg':'/asset/private.png'},{'portraitVariants':[{'iconImgPath':'../../private.png'}]},{'portraitVariants':['bad']},{'portraitVariants':{}},{'iconImg':[]}):
            with self.assertRaises(SERVER.profiles.ProfileError):
                self.store.edit(self.pid,oid,lib['revision'],patch)
            self.assertEqual(self.store.library(self.pid),lib)
    def test_corrupt_library_fails_closed_without_overwrite(self):
        path=self.store.path(self.pid,'棋子库.json');raw=b'{corrupt';path.write_bytes(raw)
        with self.assertRaises(SERVER.profiles.ProfileError) as error:self.store.library(self.pid)
        self.assertEqual(error.exception.status,503);self.assertFalse(self.store.owns(self.pid,'fake'));self.assertEqual(path.read_bytes(),raw)
    def test_snapshot_cache_uses_binary_not_metadata(self):
        digest='a'*64;self.store.cache.mkdir();(self.store.cache/(digest+'.meta')).write_text('{}')
        raw=b'\x89PNG\r\n\x1a\ncache';(self.store.cache/digest).write_bytes(raw)
        url=self.store.snapshot_image('/api/assets/'+digest)
        self.assertEqual((self.store.root/'资源'/url.rsplit('/',1)[-1]).read_bytes(),raw)

    def test_bound_profile_cannot_be_deleted_or_lose_its_collection(self):
        from server.player_profiles import atomic
        profile = self.store.read(self.pid)
        atomic(self.store.path(self.pid, '当前档案.json'), dict(profile, accountId='registered-account'))
        library = self.store.grant(self.pid, self.preset, 'bound-delete-test')
        with self.assertRaises(SERVER.profiles.ProfileError) as caught:
            self.store.delete(self.pid)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.store.read(self.pid)['accountId'], 'registered-account')
        self.assertEqual(self.store.library(self.pid), library)
        self.assertEqual(self.store.login(self.credential)['playerId'], self.pid)
        self.assertFalse((self.store.root/'已删除'/self.pid).exists())

    def test_delete_preserves_backup_and_other_players(self):
        lib=self.store.grant(self.pid,self.preset,'delete-test-grant')
        other=self.store.create('保留的玩家')['profile']['playerId']
        version=self.store.login(self.credential)['_authVersion']
        self.store.delete(self.pid);self.store.delete(self.pid)
        self.assertEqual([p['playerId'] for p in self.store.players()],[other])
        self.assertFalse(self.store.session_valid(self.pid,version))
        self.assertFalse((self.store.root/'认证'/(self.pid+'.json')).exists())
        self.assertEqual(json.loads((self.store.root/'已删除'/self.pid/'棋子库.json').read_text()),lib)
        with self.assertRaises(SERVER.profiles.ProfileError):self.store.login(self.credential)
    def test_failed_delete_keeps_active_profile(self):
        with mock.patch.object(SERVER.profiles.os,'replace',side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):self.store.delete(self.pid)
        self.assertEqual(self.store.login(self.credential)['playerId'],self.pid)

class PlayerProfileHttpTests(unittest.TestCase):
    def test_player_initiative_swap_respects_host_permission_and_publishes_stable_order(self):
        session = self.login()
        other = self.request({'op': 'create', 'name': '先攻同伴'}, host=True)[1]['profile']
        snapshot = {'campaignId': 'initiative-permission', 'activeMapId': 'm', 'maps': [{
            'id': 'm', 'playerAccessible': True, 'gridSize': 50,
            'tokens': [
                {'id': 't', 'ownerPlayerId': self.pid, 'owner': '甲', 'x': 50, 'y': 50, 'conditions': []},
                {'id': 'other', 'ownerPlayerId': other['playerId'], 'owner': '先攻同伴', 'x': 100, 'y': 50, 'conditions': []},
                {'id': 'enemy', 'owner': '', 'x': 150, 'y': 50, 'conditions': []},
            ]}], 'encounter': {
                'playMode': 'prepare', 'allowInitiativeSwap': False, 'turnSerial': 1, 'round': 1,
                'currentEntryId': None, 'turnPath': {'mapId': None, 'tokenId': None, 'points': [], 'segmentEnds': []},
                'entries': [{'id': 'e1', 'tokenId': 't', 'value': 12, 'order': 0},
                            {'id': 'e2', 'tokenId': 'other', 'value': 12, 'order': 0},
                            {'id': 'e3', 'tokenId': 'enemy', 'value': 12, 'order': 0}],
            }}
        with mock.patch.object(SERVER, 'STATE', snapshot), mock.patch.object(SERVER, 'RECENT_ACTIONS', []), mock.patch.object(SERVER, 'ACTION_IDS', {}):
            SERVER.broadcast.reset_mock()
            action = {'op': 'initiativeSwap', 'entryId': 'e1', 'targetEntryId': 'e2', 'turnSerial': 1,
                      'actor': other['playerId'], 'allowInitiativeSwap': True}
            before = copy.deepcopy(snapshot)
            status, result = self.request({'sessionToken': session, 'action': action}, path='/api/action')
            self.assertEqual(status, 403, result)
            self.assertEqual(SERVER.STATE, before)
            self.assertFalse(SERVER.broadcast.called)
            status, public = self.request(path='/api/state', method='GET')
            self.assertEqual(status, 200)
            self.assertIs(public['encounter']['allowInitiativeSwap'], False)
            SERVER.STATE['encounter']['allowInitiativeSwap'] = True
            before = copy.deepcopy(SERVER.STATE)
            status, result = self.request({'sessionToken': session, 'action': action}, path='/api/action')
            self.assertEqual(status, 403, result)
            self.assertIn('DM', result['error'])
            self.assertEqual(SERVER.STATE, before)
            self.assertFalse(SERVER.broadcast.called)

    def test_actions_publish_profile_name_without_changing_controller_id(self):
        session = self.login()
        snapshot = {'campaignId':'name-test','activeMapId':'m','maps':[{'id':'m','playerAccessible':True,'mapW':500,'mapH':500,'gridSize':50,'tokens':[{'id':'t','ownerPlayerId':self.pid,'owner':'甲','type':'pc','hp':10,'hpMax':10,'size':1}]}]}
        with mock.patch.object(SERVER, 'STATE', snapshot), mock.patch.object(SERVER, 'RECENT_ACTIONS', []), mock.patch.object(SERVER, 'ACTION_IDS', {}):
            for action in [
                {'op':'roll','sides':20,'dice':[12]},
                {'op':'mapReaction','reactionId':'name-check-reaction-01','mapId':'m','x':50,'y':50,'emoji':'👍'},
                {'op':'patchToken','tokenId':'t','mapId':'m','patch':{'hp':8}},
            ]:
                action.update(name='伪造名字', displayName='伪造名字')
                code, result = self.request({'sessionToken':session,'action':action}, path='/api/action')
                self.assertEqual(code, 200, result)
                event = SERVER.broadcast.call_args.args[0]['action']
                self.assertEqual(event['name'], '甲')
                if action['op'] == 'patchToken':
                    self.assertEqual(event['actor'], self.pid)
                    self.assertEqual(event['displayName'], '甲')
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['ownerPlayerId'], self.pid)
            SERVER.STATE['maps'][0]['tokens'].append({'id':'t2','ownerPlayerId':self.pid,'owner':'甲','type':'pc','hp':10,'hpMax':10})
            SERVER.STATE['encounter'] = {'playMode':'prepare','turnSerial':1,'round':1,'entries':[{'id':'e1','tokenId':'t','value':10,'order':0},{'id':'e2','tokenId':'t2','value':10,'order':1}]}
            code, result = self.request({'sessionToken':session,'action':{'op':'initiativeSwap','entryId':'e1','targetEntryId':'e2','turnSerial':1}},path='/api/action')
            self.assertEqual(code,403,result)
            self.assertIn('DM', result['error'])
            SERVER.STATE['encounter'].update(playMode='turn',currentEntryId='e1')
            serial = SERVER.STATE['encounter']['turnSerial']
            code, result = self.request({'sessionToken':session,'action':{'op':'endTurn','turnSerial':serial}},path='/api/action')
            self.assertEqual(code,200,result)
            event = SERVER.broadcast.call_args.args[0]['action']
            self.assertEqual(event['name'],'甲')
            self.assertEqual(event['actor'],self.pid)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.save=self.root/'存档'
        # Explicit compatibility coverage for the private legacy adapter.
        self.patches=[mock.patch.object(SERVER,'AUTH_METHOD','legacy'),mock.patch.object(SERVER,'ACCOUNT_SETTINGS',{'enabled':False}),mock.patch.object(SERVER,'ROOT',str(self.root)),mock.patch.object(SERVER,'LOCAL_SAVE_ROOT',str(self.save)),mock.patch.object(SERVER,'SESSIONS',{}),mock.patch.object(SERVER,'LOGIN_ATTEMPTS',{}),mock.patch.object(SERVER,'REGISTRATION_ATTEMPTS',{}),mock.patch.object(SERVER,'broadcast')]
        for patch in self.patches: patch.start();self.addCleanup(patch.stop)
        self.httpd=SERVER.Server(('127.0.0.1',0),SERVER.Handler)
        self.port=self.httpd.server_address[1]
        patch=mock.patch.object(SERVER,'PORT',self.port);patch.start();self.addCleanup(patch.stop)
        self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.close_server)
        self.created=self.request({'op':'create','name':'甲'},host=True)[1]
        self.pid=self.created['profile']['playerId']
    def close_server(self): self.httpd.shutdown();self.httpd.server_close();self.thread.join()
    def request(self,data=None,host=False,path='/api/player-profiles',method='POST',extra=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port)
        headers={'Content-Type':'application/json'}
        if host: headers['X-Sundoll-Local-Save']='1'
        headers.update(extra or {})
        conn.request(method,path,json.dumps(data) if data is not None else None,headers)
        response=conn.getresponse();raw=response.read();code=response.status;conn.close()
        try: return code,json.loads(raw)
        except ValueError: return code,raw
    def login(self): return self.request({'credential':self.created['credential']},path='/api/session')[1]['session']['sessionToken']
    def test_player_rename_updates_all_sessions_and_profile_without_rotating_identity(self):
        first=self.login();second=self.login()
        payload={'sessionToken':first,'name':'新名字','expectedName':'甲'}
        self.assertEqual(self.request(dict(payload,playerId='another'),path='/api/player-name')[0],403)
        status,result=self.request(payload,path='/api/player-name')
        self.assertEqual(status,200);self.assertEqual(result['session']['playerId'],self.pid)
        self.assertEqual(SERVER.SESSIONS[second]['name'],'新名字')
        # Resuming a stale tab must not undo a durable name change.
        resumed=self.request({'sessionToken':second,'nickname':'甲'},path='/api/session')[1]
        self.assertEqual(resumed['session']['name'],'新名字')
        self.assertEqual(self.request(payload,path='/api/player-name')[0],409)
        self.assertEqual(self.request({'credential':self.created['credential']},path='/api/session')[1]['session']['name'],'新名字')

    def test_guest_rename_cannot_take_registered_name_or_other_guest(self):
        session=self.request({'nickname':'游客'},path='/api/session')[1]['session']
        token=session['sessionToken']
        self.assertEqual(self.request({'sessionToken':token,'name':'甲','expectedName':'游客'},path='/api/player-name')[0],409)
        status,result=self.request({'sessionToken':token,'name':'游客新名','expectedName':'游客'},path='/api/player-name')
        self.assertEqual(status,200);self.assertEqual(result['session']['playerId'],session['playerId'])
        self.assertEqual(self.request({'sessionToken':'bad','name':'假名','expectedName':'游客'},path='/api/player-name')[0],401)
    def test_legacy_public_registration_uses_fixed_entrance_and_returns_only_own_session(self):
        payload={'nickname':'自助玩家','credential':'Register-2026','roomCode':SERVER.ROOM_CODE}
        # The fixed player entrance intentionally ignores the retired room code.
        # Email room mode separately rejects all legacy registration endpoints.
        status,result=self.request(dict(payload,playerId=self.pid,host=True),path='/api/register')
        self.assertEqual(status,200);self.assertTrue(result['session']['persistent'])
        self.assertNotEqual(result['session']['playerId'],self.pid)
        self.assertNotIn('Register-2026',json.dumps(result));self.assertNotIn('_authVersion',json.dumps(result))
        token=result['session']['sessionToken']
        status,own=self.request({'op':'get','sessionToken':token})
        self.assertEqual(status,200);self.assertEqual(own['library']['pieces'],[])
        self.assertEqual(self.request({'op':'get','sessionToken':token,'playerId':self.pid})[0],403)
        self.assertEqual(self.request(payload,path='/api/register')[1]['session']['playerId'],result['session']['playerId'])
        for code in ('','WRONG'):
            self.assertEqual(self.request(dict(payload,roomCode=code),path='/api/register')[1]['session']['playerId'],result['session']['playerId'])
        self.assertEqual(self.request({'credential':'Register-2026'},path='/api/session')[1]['session']['playerId'],result['session']['playerId'])

    def test_registration_rate_limit_expires(self):
        for _ in range(10):self.assertTrue(SERVER.allow_registration_attempt('peer',100))
        self.assertFalse(SERVER.allow_registration_attempt('peer',101))
        self.assertTrue(SERVER.allow_registration_attempt('peer',701))
    def test_only_host_can_set_custom_code_and_old_session_is_revoked(self):
        token=self.login()
        data={'op':'setCredential','playerId':self.pid,'sessionToken':token,'loginCode':'TestCode-2026'}
        self.assertEqual(self.request(data)[0],403)
        self.assertEqual(self.request(data,host=True)[0],200)
        self.assertEqual(self.request({'sessionToken':token},path='/api/session')[0],401)
        status,result=self.request({'credential':'TestCode-2026'},path='/api/session')
        self.assertEqual(status,200);self.assertEqual(result['session']['playerId'],self.pid)
        request={'op':'createWithCode','name':'新玩家','loginCode':'NewPlayer-2026','sessionToken':result['session']['sessionToken']}
        self.assertEqual(self.request(request)[0],403)
        status,created=self.request(request,host=True)
        self.assertEqual(status,200)
        self.assertEqual(self.request({'credential':'NewPlayer-2026'},path='/api/session')[1]['session']['playerId'],created['profile']['playerId'])

    def test_credential_attempts_are_bounded_and_expire(self):
        for _ in range(30):self.assertTrue(SERVER.allow_credential_attempt('test-peer',100))
        self.assertFalse(SERVER.allow_credential_attempt('test-peer',101))
        self.assertTrue(SERVER.allow_credential_attempt('test-peer',161))
        for _ in range(30):SERVER.allow_credential_attempt('127.0.0.1')
        self.assertEqual(self.request({'credential':'Wrong-2026'},path='/api/session')[0],429)
    def test_only_host_can_copy_without_revoking_session(self):
        session = self.login()
        code, copied = self.request({'op':'credential','playerId':self.pid}, host=True)
        self.assertEqual(code, 200)
        self.assertEqual(copied['credential'], self.created['credential'])
        self.assertEqual(self.request({'op':'credential','sessionToken':session})[0], 403)
        self.assertEqual(self.request({'op':'credential','playerId':self.pid})[0], 401)
        code, public = self.request({'op':'get','sessionToken':session})
        self.assertEqual(code, 200)
        self.assertNotIn(copied['credential'].split('.')[1], json.dumps(public))

    def test_only_host_can_supplement_source_forms(self):
        session=self.login()
        self.assertEqual(self.request({'op':'syncForms','sessionToken':session,'ownedPieceId':'missing'})[0],403)
        self.assertEqual(self.request({'op':'syncForms','playerId':self.pid,'ownedPieceId':'missing'},host=True)[0],404)

    def test_player_cannot_read_other_library_or_grant(self):
        session=self.login()
        self.assertEqual(self.request({'op':'get','sessionToken':session})[0],200)
        self.assertEqual(self.request({'op':'get','sessionToken':session,'playerId':'p'+'f'*32})[0],403)
        self.assertEqual(self.request({'op':'grant','sessionToken':session})[0],403)
        self.assertEqual(self.request({'op':'list'})[0],401)
    def test_authenticated_piece_action_survives_display_name_change(self):
        lib=SERVER.profile_store().grant(self.pid,{'id':'l1','name':'角色','type':'pc','hpMax':20},'grant-request-0001')
        token=dict(lib['pieces'][0],id='t1',owner='旧昵称',hp=20,x=20,y=20)
        snapshot={'protocolVersion':SERVER.SERVER_PROTOCOL_VERSION,'campaignId':'c1','activeMapId':'m1','maps':[{'id':'m1','tokens':[token]}]}
        with mock.patch.object(SERVER,'STATE',snapshot), mock.patch.object(SERVER,'RECENT_ACTIONS',[]), mock.patch.object(SERVER,'ACTION_IDS',{}):
            session=self.login()
            status,_=self.request({'sessionToken':session,'campaignId':'c1','serverSessionId':SERVER.SESSION_ID,'action':{'op':'patchToken','tokenId':'t1','mapId':'m1','patch':{'hp':8}}},path='/api/action')
            self.assertEqual(status,200)
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['hp'],8)
            guest=self.request({'nickname':'旧昵称'},path='/api/session')[1]['session']['sessionToken']
            status,_=self.request({'sessionToken':guest,'campaignId':'c1','serverSessionId':SERVER.SESSION_ID,'action':{'op':'patchToken','tokenId':'t1','patch':{'hp':20}}},path='/api/action')
            self.assertEqual(status,403)
            self.assertEqual(self.request({'maps':[]},path='/api/state')[0],409)

    def test_proxy_host_does_not_grant_gm_rights(self):
        status,_=self.request({'op':'create','name':'冒充'},host=True,extra={'Host':'game.example.com'})
        self.assertNotEqual(status,200)
        self.assertEqual(self.request({},path='/api/state',extra={'Host':'game.example.com'})[0],403)
    def test_static_get_head_encoded_and_symlink_blocked(self):
        (self.root/'alias').symlink_to(self.save/'玩家档案',target_is_directory=True)
        for path in ('/存档/玩家档案/'+self.pid+'/当前档案.json','/alias/认证/'+self.pid+'.json','/存档/玩家档案/'):
            from urllib.parse import quote
            for method in ('GET','HEAD'):
                self.assertEqual(self.request(path=quote(path),method=method)[0],404)
    def test_reset_revokes_old_session_and_credentials(self):
        session=self.login()
        self.assertEqual(self.request({'op':'reset','playerId':self.pid},host=True)[0],200)
        self.assertEqual(self.request({'op':'get','sessionToken':session})[0],401)
        self.assertEqual(self.request({'credential':self.created['credential']},path='/api/session')[0],401)

    def test_expired_resume_returns_401(self):
        session=self.login();SERVER.SESSIONS[session]['lastSeen']=1
        status,_=self.request({'sessionToken':session,'nickname':'甲'},path='/api/session')
        self.assertEqual(status,401)
    def test_offline_guest_does_not_block_name_but_name_never_restores_ownership(self):
        first=self.request({'nickname':'访客甲'},path='/api/session')[1]['session']
        self.assertEqual(self.request({'nickname':'访客甲'},path='/api/session')[0],409)
        self.request({'sessionToken':first['sessionToken'],'status':'offline'},path='/api/presence')
        status,other=self.request({'nickname':'访客甲'},path='/api/session')
        self.assertEqual(status,200)
        self.assertNotEqual(other['session']['playerId'],first['playerId'])

    def test_switch_resume_retains_persistent_and_guest_identity(self):
        for join in ({'credential':self.created['credential']},{'nickname':'临时甲'}):
            first=self.request(join,path='/api/session')[1]['session']
            self.request({'sessionToken':first['sessionToken'],'status':'offline'},path='/api/presence')
            status,result=self.request({'sessionToken':first['sessionToken'],'nickname':first['name']},path='/api/session')
            self.assertEqual(status,200)
            self.assertEqual(result['session']['playerId'],first['playerId'])
            self.assertEqual(result['session'].get('persistent'),first.get('persistent'))
            self.assertEqual(result['session']['status'],'online')
    def test_rotation_rejects_racing_old_login_and_hides_version(self):
        response=self.request({'credential':self.created['credential']},path='/api/session')[1]
        session=response['session']['sessionToken'];old=dict(SERVER.SESSIONS[session])
        self.assertNotIn('_authVersion',json.dumps(response))
        self.request({'op':'reset','playerId':self.pid},host=True)
        SERVER.SESSIONS[session]=old
        self.assertEqual(self.request({'op':'get','sessionToken':session})[0],401)
    def test_same_player_can_resume_multiple_tabs(self):
        first=self.login();second=self.login()
        for session in (first,second):
            status,result=self.request({'sessionToken':session,'nickname':'甲'},path='/api/session')
            self.assertEqual(status,200);self.assertNotIn('_authVersion',json.dumps(result))

    def test_collect_checks_live_control_and_is_idempotent(self):
        session=self.login()
        token={'id':'controlled','ownerPlayerId':self.pid,'name':'受控棋子','hpMax':20,'hp':7,'x':42,'y':21}
        snapshot={'campaignId':'collect-campaign','maps':[{'id':'m1','tokens':[token]}]}
        with mock.patch.object(SERVER,'STATE',snapshot):
            request={'op':'collect','sessionToken':session,'campaignId':'collect-campaign','tokenId':'controlled','preset':{'name':'伪造资料'}}
            for _ in range(2):
                code,result=self.request(request);self.assertEqual(code,200)
                self.assertEqual(len(result['library']['pieces']),1)
                self.assertEqual(result['library']['pieces'][0]['name'],'受控棋子')
            self.assertEqual(token['hp'],7);self.assertEqual(token['x'],42)
            self.assertEqual(token['ownedPieceId'],result['library']['pieces'][0]['ownedPieceId'])
            token['ownerPlayerId']='someone-else'
            self.assertEqual(self.request(request)[0],403)
            token['ownerPlayerId']=self.pid;token['hiddenFromPlayers']=True
            self.assertEqual(self.request(request)[0],403)
            token['hiddenFromPlayers']=False
            self.assertEqual(self.request(dict(request,campaignId='stale'))[0],409)
            self.assertEqual(self.request(dict(request,tokenId='missing'))[0],403)
    def test_collect_existing_owned_piece_does_not_duplicate(self):
        session=self.login();lib=SERVER.profile_store().grant(self.pid,{'name':'收藏'},'existing-owned-piece')
        token=dict(lib['pieces'][0],id='existing')
        with mock.patch.object(SERVER,'STATE',{'campaignId':'c1','maps':[{'tokens':[token]}]}):
            code,result=self.request({'op':'collect','sessionToken':session,'campaignId':'c1','tokenId':'existing'})
            self.assertEqual(code,200);self.assertEqual(result['library'],lib)

    def test_player_releases_only_own_collection_to_open_map_without_duplicates(self):
        session=self.login()
        lib=SERVER.profile_store().grant(self.pid,{'name':'收藏角色','type':'pc','hpMax':20,'ac':15},'release-owned-piece')
        piece=lib['pieces'][0]
        other=self.request({'op':'create','name':'乙'},host=True)[1]
        foreign=SERVER.profile_store().grant(other['profile']['playerId'],{'name':'别人的角色'},'foreign-owned-piece')['pieces'][0]
        snapshot={'campaignId':'c1','activeMapId':'m1','parkedOwnedPieces':{},'maps':[
            {'id':'m1','playerAccessible':True,'mapW':500,'mapH':400,'gridSize':50,'tokens':[]},
            {'id':'m2','playerAccessible':False,'mapW':300,'mapH':300,'gridSize':50,'tokens':[]},
        ]}
        with mock.patch.object(SERVER,'STATE',snapshot), mock.patch.object(SERVER,'RECENT_ACTIONS',[]), mock.patch.object(SERVER,'ACTION_IDS',{}):
            request={'sessionToken':session,'action':{'op':'releaseOwnedPiece','mapId':'m1','ownedPieceId':piece['ownedPieceId']}}
            for _ in range(2):
                code,result=self.request(request,path='/api/action');self.assertEqual(code,200,result)
            tokens=SERVER.STATE['maps'][0]['tokens']
            self.assertEqual(len(tokens),1)
            self.assertEqual(tokens[0]['ownerPlayerId'],self.pid)
            self.assertEqual(tokens[0]['name'],'收藏角色')
            self.assertEqual(tokens[0]['hp'],20)
            self.assertFalse(tokens[0]['playerCreated'])
            locked=dict(request);locked['action']=dict(request['action'],mapId='m2')
            self.assertEqual(self.request(locked,path='/api/action')[0],403)
            forged=dict(request);forged['action']=dict(request['action'],ownedPieceId=foreign['ownedPieceId'])
            self.assertEqual(self.request(forged,path='/api/action')[0],403)

    def test_release_moves_active_piece_and_restores_parked_campaign_state(self):
        session=self.login()
        piece=SERVER.profile_store().grant(self.pid,{'name':'旅行者','hpMax':24},'release-state-test')['pieces'][0]
        active=dict(piece,id='owned-token',hp=7,tempHp=3,conditions=[{'id':'poison','key':'poisoned','label':'中毒','icon':'☠️','color':'#79c267','visibility':'public'}],x=460,y=370)
        snapshot={'campaignId':'c1','activeMapId':'m2','parkedOwnedPieces':{},'maps':[
            {'id':'m1','playerAccessible':True,'mapW':500,'mapH':400,'gridSize':50,'tokens':[active]},
            {'id':'m2','playerAccessible':True,'mapW':100,'mapH':80,'gridSize':50,'tokens':[]},
        ]}
        with mock.patch.object(SERVER,'STATE',snapshot), mock.patch.object(SERVER,'RECENT_ACTIONS',[]), mock.patch.object(SERVER,'ACTION_IDS',{}):
            payload={'sessionToken':session,'action':{'op':'releaseOwnedPiece','mapId':'m2','ownedPieceId':piece['ownedPieceId']}}
            code,result=self.request(payload,path='/api/action');self.assertEqual(code,200,result)
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'],[])
            moved=SERVER.STATE['maps'][1]['tokens'][0]
            self.assertEqual((moved['id'],moved['hp'],moved['tempHp']),('owned-token',7,3))
            self.assertLess(moved['x'],100);self.assertLess(moved['y'],80)
            SERVER.STATE['maps'][1]['tokens']=[]
            SERVER.STATE['parkedOwnedPieces'][piece['ownedPieceId']]=dict(moved,hp=4,conditions=[{'id':'burn','key':'burning','label':'燃烧','icon':'🔥','color':'#ef6c45','visibility':'gm'}])
            code,result=self.request(payload,path='/api/action');self.assertEqual(code,200,result)
            restored=SERVER.STATE['maps'][1]['tokens'][0]
            self.assertEqual((restored['id'],restored['hp']),('owned-token',4))
            self.assertEqual(restored['conditions'][0]['visibility'],'gm')
            self.assertNotIn(piece['ownedPieceId'],SERVER.STATE['parkedOwnedPieces'])

    def test_travel_basket_privacy_recall_arrival_and_stale_requests(self):
        session=self.login();store=SERVER.profile_store()
        piece=store.grant(self.pid,{'name':'旅客','hpMax':20},'travel-basket-test')['pieces'][0]
        unplaced=store.grant(self.pid,{'name':'未上场','hpMax':10},'travel-unplaced-test')['pieces'][-1]
        other=store.create('其他玩家')['profile']['playerId']
        foreign=store.grant(other,{'name':'别人的秘密角色'},'travel-foreign-test')['pieces'][0]
        token=dict(piece,id='travel-token',hp=6,tempHp=2,x=25,y=25,conditions=[{'visibility':'gm','label':'秘密状态'}])
        state={'campaignId':'travel-test','activeMapId':'m2','maps':[
            {'id':'m1','name':'不可泄漏的地点','playerAccessible':False,'mapW':800,'mapH':600,'gridSize':50,'tokens':[token]},
            {'id':'m2','name':'港口','playerAccessible':True,'mapW':800,'mapH':600,'gridSize':50,'tokens':[]},
            {'id':'m3','name':'山谷','playerAccessible':True,'mapW':800,'mapH':600,'gridSize':50,'tokens':[]}],
            'parkedOwnedPieces':{foreign['ownedPieceId']:dict(foreign,id='foreign-token')},'travelBasketTokens':[{'id':'hidden-npc','name':'主控私藏NPC'}]}
        with mock.patch.object(SERVER,'STATE',state),mock.patch.object(SERVER,'RECENT_ACTIONS',[]),mock.patch.object(SERVER,'ACTION_IDS',{}):
            self.assertNotIn('travelBasketTokens', SERVER.state_snapshot())
            query={'op':'travelBasket','sessionToken':session}
            code,data=self.request(query);self.assertEqual(code,200,data)
            self.assertEqual(len(data['available']),1);self.assertEqual(data['stored'],[])
            text=json.dumps(data,ensure_ascii=False)
            for private in ['不可泄漏的地点','秘密状态','别人的秘密角色','未上场']:self.assertNotIn(private,text)
            self.assertEqual(self.request(dict(query,playerId=other))[0],403)
            self.assertEqual(self.request({'op':'travelBasket'})[0],401)
            def action(a):return self.request({'sessionToken':session,'action':a},path='/api/action')
            recall={'op':'recallOwnedPiece','ownedPieceId':piece['ownedPieceId'],'toBasket':True}
            self.assertEqual(action(dict(recall,toBasket=False))[0],200)
            self.assertEqual(self.request(query)[1]['stored'],[])
            code,_=action({'op':'releaseOwnedPiece','ownedPieceId':piece['ownedPieceId'],'mapId':'m2'});self.assertEqual(code,200)
            self.assertEqual(action(recall)[0],200)
            self.assertEqual(len(self.request(query)[1]['stored']),1)
            self.assertEqual(action(recall)[0],200)
            arrival={'op':'releaseOwnedPiece','ownedPieceId':piece['ownedPieceId'],'mapId':'m1','fromBasket':True,'position':{'x':310,'y':220}}
            self.assertEqual(action(arrival)[0],403)
            arrival['mapId']='m2';code,data=action(arrival);self.assertEqual(code,200,data)
            landed=SERVER.STATE['maps'][1]['tokens'][0]
            self.assertEqual((landed['hp'],landed['tempHp']),(6,2));self.assertEqual((landed['x'],landed['y']),(325,225))
            self.assertEqual(action(arrival)[0],200);self.assertEqual(len(SERVER.STATE['maps'][1]['tokens']),1)
            self.assertEqual(action(dict(arrival,mapId='m3'))[0],409)
            self.assertEqual(action(dict(arrival,ownedPieceId=unplaced['ownedPieceId']))[0],409)
            self.assertEqual(self.request(query)[1]['stored'],[])
            self.assertEqual(action(recall)[0],200)
            SERVER.STATE['maps'][1]['tokens']=[{'id':'occupied','x':325,'y':225,'size':1}]
            self.assertEqual(action(arrival)[0],200)
            landed=next(t for t in SERVER.STATE['maps'][1]['tokens'] if t['id']=='travel-token')
            self.assertTrue(abs(landed['x']-325)>=50 or abs(landed['y']-225)>=50)
            self.assertEqual(action(recall)[0],200)
            self.assertEqual(action(dict(recall,toBasket=False))[0],200)
            self.assertEqual(self.request(query)[1]['stored'],[])
            code,profile=self.request({'op':'get','sessionToken':session});self.assertEqual(code,200)
            self.assertFalse(profile['deployments'][piece['ownedPieceId']]['inBasket'])
            restored=next(p for p in profile['library']['pieces'] if p['ownedPieceId']==piece['ownedPieceId'])
            self.assertEqual(SERVER.STATE['parkedOwnedPieces'][piece['ownedPieceId']]['hp'],6)
            self.assertEqual(action(arrival)[0],409)
            self.assertEqual(action({'op':'releaseOwnedPiece','ownedPieceId':piece['ownedPieceId'],'mapId':'m2'})[0],200)
            self.assertEqual(next(t for t in SERVER.STATE['maps'][1]['tokens'] if t.get('ownedPieceId')==piece['ownedPieceId'])['hp'],6)

    def test_room_roster_merges_relogins_and_keeps_online_session(self):
        first=self.login();second=self.login()
        self.request({'sessionToken':first,'status':'offline'},path='/api/presence')
        rows=[p for p in SERVER.online_players() if p['playerId']==self.pid]
        self.assertEqual(len(rows),1);self.assertTrue(rows[0]['online'])
        self.assertNotIn('token',rows[0]);self.assertNotIn('_authVersion',rows[0])
        self.request({'sessionToken':second,'status':'offline'},path='/api/presence')
        rows=[p for p in SERVER.online_players() if p['playerId']==self.pid]
        self.assertEqual(len(rows),1);self.assertFalse(rows[0]['online'])
        # An offline session stays usable for an authenticated return.
        code,_=self.request({'sessionToken':first,'nickname':'甲'},path='/api/session')
        self.assertEqual(code,200)
        rows=[p for p in SERVER.online_players() if p['playerId']==self.pid]
        self.assertEqual(len(rows),1);self.assertTrue(rows[0]['online'])

    def test_room_roster_hides_departed_guests_without_merging_same_name_identities(self):
        import time
        now=int(time.time()*1000)
        sessions={
            'a':{'token':'a','playerId':'one','name':'同名','persistent':True,'status':'online','lastSeen':now},
            'b':{'token':'b','playerId':'two','name':'同名','persistent':True,'status':'online','lastSeen':now},
            'oldguest':{'token':'oldguest','playerId':'guest-old','name':'游客','status':'offline','lastSeen':now},
            'newguest':{'token':'newguest','playerId':'guest-new','name':'游客','status':'online','lastSeen':now},
            'expired':{'token':'expired','playerId':'expired','name':'过期','persistent':True,'status':'online','lastSeen':now-86400001},
        }
        with mock.patch.object(SERVER,'SESSIONS',sessions):
            self.assertEqual({r['playerId'] for r in SERVER.online_players()},{'one','two','guest-new'})
            self.assertIn('oldguest',SERVER.SESSIONS)

    def test_owned_lifecycle_sync_recall_transfer_and_hidden_map_privacy(self):
        session=self.login();store=SERVER.profile_store()
        piece=store.grant(self.pid,{'name':'旅者','hpMax':24,'ac':14},'lifecycle-grant-1')['pieces'][0];oid=piece['ownedPieceId']
        active=dict(piece,id='live-token',hp=11,tempHp=2,x=50,y=60)
        snapshot={'campaignId':'life-c1','activeMapId':'m1','maps':[
            {'id':'m1','name':'海岸','playerAccessible':True,'mapW':500,'mapH':500,'tokens':[active]},
            {'id':'m2','name':'山谷','playerAccessible':True,'mapW':500,'mapH':500,'tokens':[]},
            {'id':'secret','name':None,'playerAccessible':False,'tokens':[]}], 'encounter':{'playMode':'free'}}
        with mock.patch.object(SERVER,'STATE',snapshot),mock.patch.object(SERVER,'RECENT_ACTIONS',[]),mock.patch.object(SERVER,'ACTION_IDS',{}):
            def action(op,**fields):
                return self.request({'sessionToken':session,'action':dict(op=op,**fields)},path='/api/action')
            code,result=action('patchToken',tokenId='live-token',mapId='m1',patch={'hp':6,'hpMax':28,'ac':17,'tempHp':3})
            self.assertEqual(code,200,result)
            saved=store.library(self.pid)['pieces'][0]
            self.assertEqual((saved['hpMax'],saved['ac'],saved['campaignStates']['life-c1']['hp']),(28,17,6))
            # Library edits survive a refresh when the map has not changed again.
            store.edit(self.pid,oid,None,{'name':'小库新名'},saved['revision'])
            code,result=self.request({'op':'get','sessionToken':session})
            self.assertEqual(result['library']['pieces'][0]['name'],'小库新名')
            self.assertEqual(result['deployments'][oid]['mapName'],'海岸')
            code,result=action('releaseOwnedPiece',ownedPieceId=oid,mapId='m2');self.assertEqual(code,200,result)
            self.assertEqual(sum(len(m['tokens']) for m in SERVER.STATE['maps']),1)
            self.assertEqual(SERVER.STATE['maps'][1]['tokens'][0]['hp'],6)
            code,result=action('recallOwnedPiece',ownedPieceId=oid);self.assertEqual(code,200,result)
            self.assertEqual(sum(len(m['tokens']) for m in SERVER.STATE['maps']),0)
            self.assertEqual(SERVER.STATE['parkedOwnedPieces'][oid]['hp'],6)
            self.assertEqual(action('recallOwnedPiece',ownedPieceId=oid)[0],200)
            self.assertEqual(action('releaseOwnedPiece',ownedPieceId=oid,mapId='secret')[0],403)
            self.assertEqual(action('releaseOwnedPiece',ownedPieceId=oid,mapId='m1')[0],200)
            restored=SERVER.STATE['maps'][0]['tokens'][0]
            self.assertEqual((restored['hp'],restored['tempHp']),(6,3))
            self.assertNotIn('campaignStates',restored)
            # A closed source is known only to the server, never exposed in public state.
            SERVER.STATE['maps'][0]['tokens']=[]
            SERVER.STATE['_ownedPieceLocations']=[{'mapId':'secret','token':restored}]
            public=SERVER.state_snapshot();self.assertNotIn('_ownedPieceLocations',public);self.assertNotIn('parkedOwnedPieces',public)
            result=self.request({'op':'get','sessionToken':session})[1]
            self.assertIsNone(result['deployments'][oid]['mapName']);self.assertIsNone(result['deployments'][oid]['mapId'])
            self.assertEqual(action('recallOwnedPiece',ownedPieceId=oid)[0],200)
            self.assertEqual(SERVER.STATE['_ownedPieceLocations'],[])

    def test_owned_sync_failure_does_not_commit_map_mutation(self):
        session=self.login();store=SERVER.profile_store()
        piece=store.grant(self.pid,{'name':'失败测试','hpMax':20},'lifecycle-failure')['pieces'][0]
        active=dict(piece,id='t1',hp=9,x=50,y=50)
        state={'campaignId':'life','maps':[{'id':'m1','playerAccessible':True,'tokens':[active]}]}
        with mock.patch.object(SERVER,'STATE',state),mock.patch.object(SERVER,'RECENT_ACTIONS',[]),mock.patch.object(SERVER,'ACTION_IDS',{}),mock.patch.object(SERVER.profiles,'atomic',side_effect=OSError('disk full')):
            code,_=self.request({'sessionToken':session,'action':{'op':'patchToken','mapId':'m1','tokenId':'t1','patch':{'hp':1}}},path='/api/action')
            self.assertEqual(code,500);self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['hp'],9)
            code,_=self.request({'sessionToken':session,'action':{'op':'recallOwnedPiece','ownedPieceId':piece['ownedPieceId']}},path='/api/action')
            self.assertEqual(code,500);self.assertEqual(len(SERVER.STATE['maps'][0]['tokens']),1)

    def test_concurrent_destinations_have_one_piece_and_recall_replays_after_stale_host_save(self):
        from concurrent.futures import ThreadPoolExecutor
        import copy
        session=self.login();store=SERVER.profile_store()
        piece=store.grant(self.pid,{'name':'并发旅者','hpMax':30},'concurrent-travel')['pieces'][0]
        initial={'campaignId':'travel','maps':[{'id':mid,'playerAccessible':True,'mapW':500,'mapH':500,'tokens':[]} for mid in ('a','b')]}
        with mock.patch.object(SERVER,'STATE',copy.deepcopy(initial)),mock.patch.object(SERVER,'RECENT_ACTIONS',[]),mock.patch.object(SERVER,'ACTION_IDS',{}):
            def place(mid):return self.request({'sessionToken':session,'action':{'op':'releaseOwnedPiece','mapId':mid,'ownedPieceId':piece['ownedPieceId']}},path='/api/action')
            with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(place,('a','b')))
            self.assertEqual([r[0] for r in results],[200,200])
            tokens=[t for m in SERVER.STATE['maps'] for t in m['tokens']];self.assertEqual(len(tokens),1)
            tokens[0]['hp']=5
            self.assertEqual(self.request({'sessionToken':session,'action':{'op':'recallOwnedPiece','ownedPieceId':piece['ownedPieceId']}},path='/api/action')[0],200)
            replay=copy.deepcopy(initial)
            for action in SERVER.RECENT_ACTIONS:self.assertTrue(SERVER.apply_action(replay,copy.deepcopy(action)))
            self.assertEqual(sum(len(m['tokens']) for m in replay['maps']),0)
            # Replaying recalls must preserve the authoritative token in the recorded action.
            self.assertEqual(replay['parkedOwnedPieces'][piece['ownedPieceId']]['hp'],5)
            # A different campaign starts with its own runtime rather than importing damage.
            SERVER.STATE={'campaignId':'another','maps':copy.deepcopy(initial['maps'])}
            self.assertEqual(place('a')[0],200)
            self.assertEqual(SERVER.STATE['maps'][0]['tokens'][0]['hp'],30)

    def test_recall_rejects_foreign_identity_and_preserves_campaign_runtime(self):
        session=self.login();store=SERVER.profile_store()
        other=store.create('乙');foreign=store.grant(other['profile']['playerId'],{'name':'他人'},'foreign-recall-id')['pieces'][0]
        state={'campaignId':'life','maps':[{'id':'m1','tokens':[dict(foreign,id='foreign',hp=4)]}]}
        with mock.patch.object(SERVER,'STATE',state):
            code,_=self.request({'sessionToken':session,'action':{'op':'recallOwnedPiece','ownedPieceId':foreign['ownedPieceId']}},path='/api/action')
            self.assertEqual(code,403);self.assertEqual(len(SERVER.STATE['maps'][0]['tokens']),1)

    def test_delete_requires_host_and_revokes_sessions(self):
        session=self.login()
        self.assertEqual(self.request({'op':'delete','sessionToken':session})[0],403)
        self.assertEqual(self.request({'op':'delete','playerId':self.pid},host=True,extra={'Host':'public.example.com'})[0],401)
        self.assertEqual(self.request({'op':'delete','playerId':self.pid},host=True)[0],200)
        self.assertEqual(self.request({'op':'get','sessionToken':session})[0],401)
        self.assertEqual(self.request({'credential':self.created['credential']},path='/api/session')[0],401)
        self.assertEqual(self.request({'op':'list'},host=True)[1]['players'],[])
        from urllib.parse import quote
        self.assertEqual(self.request(path=quote('/存档/玩家档案/已删除/'+self.pid+'/当前档案.json'),method='GET')[0],404)

if __name__=='__main__': unittest.main()
