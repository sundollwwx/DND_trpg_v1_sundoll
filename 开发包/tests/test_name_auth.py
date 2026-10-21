from project_test_paths import APP_ROOT
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
import test_player_profiles as legacy_suite
from test_player_profiles import SERVER


class NameAuthTests(unittest.TestCase):
    request = legacy_suite.PlayerProfileHttpTests.request
    close_server = legacy_suite.PlayerProfileHttpTests.close_server

    def setUp(self):
        legacy_suite.PlayerProfileHttpTests.setUp(self)
        patch = mock.patch.object(SERVER, 'AUTH_METHOD', 'name')
        patch.start(); self.addCleanup(patch.stop)

    def login(self, name='甲'):
        return self.request({'nickname':name,'authMethod':'name'}, path='/api/session')

    def test_name_login_is_persistent_and_keeps_existing_player_id(self):
        code, result = self.login()
        self.assertEqual(code, 200, result)
        token = result['session']['sessionToken']
        self.assertEqual(result['session']['playerId'], self.pid)
        code, profile = self.request({'op':'get','sessionToken':token})
        self.assertEqual(code, 200, profile)
        self.assertEqual(profile['profile']['playerId'], self.pid)
        self.assertNotIn('credential', result)
        self.assertNotIn('_authVersion', result['session'])

    def test_unknown_name_never_silently_registers(self):
        self.assertEqual(self.login('拼错名字')[0],404)
        self.assertEqual(len(SERVER.profile_store().players()),1)

    def test_fixed_entrance_registration_and_old_invitation_need_no_room_code(self):
        code, result = self.request({'nickname':'固定入口玩家','authMethod':'name'},path='/api/register')
        self.assertEqual(code, 200, result)
        pid = result['session']['playerId']
        code, result = self.request({'nickname':'固定入口玩家','authMethod':'name','roomCode':'STALE'},path='/api/session')
        self.assertEqual(code, 200, result)
        self.assertEqual(result['session']['playerId'], pid)

    def test_registration_unique_and_normalized_with_concurrent_requests(self):
        payload={'nickname':'Ｔｈｅｓｅｕｓ','roomCode':SERVER.ROOM_CODE,'authMethod':'name'}
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _:self.request(payload,path='/api/register')[0],range(2)))
        self.assertEqual(sorted(results),[200,409])
        self.assertEqual(self.login(' theseus ')[0],200)
        self.assertEqual(self.request({'op':'create','name':'THESEUS'},host=True)[0],409)
        self.assertEqual(len(SERVER.profile_store().players()),2)

    def test_legacy_codes_and_future_methods_are_not_public_login_paths(self):
        self.assertEqual(self.request({'credential':self.created['credential']},path='/api/session')[0],400)
        self.assertEqual(self.request({'nickname':'甲','authMethod':'email_password'},path='/api/session')[0],501)
        for op in ('credential','setCredential','reset','createWithCode'):
            self.assertEqual(self.request({'op':op,'playerId':self.pid},host=True)[0],410)
        code, result=self.request({'op':'create','name':'新玩家'},host=True)
        self.assertEqual(code,200,result)
        self.assertNotIn('credential',result)

    def test_names_do_not_grant_host_or_other_player_access(self):
        token=self.login()[1]['session']['sessionToken']
        other=self.request({'op':'create','name':'乙'},host=True)[1]['profile']['playerId']
        self.assertEqual(self.request({'op':'get','playerId':other,'sessionToken':token})[0],403)
        self.assertEqual(self.request({'op':'create','name':'丙','sessionToken':token})[0],403)
        self.assertEqual(self.request({'op':'delete','playerId':self.pid,'sessionToken':token})[0],403)

    def test_account_rename_changes_login_name_not_character_identity(self):
        store=SERVER.profile_store()
        a=store.grant(self.pid,{'name':'同名角色'},'named-character-01')['pieces'][0]
        b=store.grant(self.pid,{'name':'同名角色'},'named-character-02')['pieces'][1]
        self.assertNotEqual(a['ownedPieceId'],b['ownedPieceId'])
        store.rename(self.pid,'新名字')
        self.assertEqual(self.login()[0],404)
        self.assertEqual(self.login('新名字')[1]['session']['playerId'],self.pid)
        self.assertEqual(len(store.library(self.pid)['pieces']),2)

    def test_deleted_player_cannot_resume_or_login_by_old_name(self):
        token=self.login()[1]['session']['sessionToken']
        self.request({'op':'delete','playerId':self.pid},host=True)
        self.assertEqual(self.login()[0],404)
        self.assertEqual(self.request({'sessionToken':token},path='/api/session')[0],401)

if __name__=='__main__': unittest.main()
