from project_test_paths import APP_ROOT
import unittest
from unittest import mock
import test_player_profiles as fixtures
from server.workspace import enable
from server.module_runtime import ModuleRuntime
from server.module_store import ModuleStore

SERVER=fixtures.SERVER


class BackendStorageHttpTests(unittest.TestCase):
    close_server=fixtures.PlayerProfileHttpTests.close_server
    request=fixtures.PlayerProfileHttpTests.request
    login=fixtures.PlayerProfileHttpTests.login

    def setUp(self):
        fixtures.PlayerProfileHttpTests.setUp(self)
        self.save=enable(self.root/'workspace')
        for field,value in [('LOCAL_SAVE_ROOT',str(self.save)),('STATE',None)]:
            patch=mock.patch.object(SERVER,field,value);patch.start();self.addCleanup(patch.stop)
        ModuleRuntime(self.save,APP_ROOT).ensure_empty_runtime()
        self.created=SERVER.profile_store().create('隔离玩家');self.pid=self.created['profile']['playerId']

    def test_corrupt_database_returns_uniform_503_and_private_details_stay_in_logs(self):
        database=self.save/'模块存储/模块.sqlite3';database.write_bytes(b'not a sqlite database')
        before=database.read_bytes()
        cases=[('/api/item-library',dict(op='get')),('/api/item-library',dict(op='create')),
               ('/api/backpack',dict(op='get',playerId=self.pid)),
               ('/api/modules',dict(op='content-packages',campaignId='c1')),
               ('/api/local-save',dict(op='write',path='棋子库/棋子库.json',text='{}',protocolVersion=SERVER.SERVER_PROTOCOL_VERSION))]
        for path,body in cases:
            with self.subTest(path=path,body=body),self.assertLogs('server.http_errors',level='ERROR') as logs:
                status,value=self.request(body,host=True,path=path)
            self.assertEqual(status,503,value);self.assertEqual(value['code'],'database_unavailable')
            self.assertIn('DatabaseError',logs.output[0])
            self.assertNotIn('file is not a database',str(value));self.assertNotIn(str(self.save),str(value))
            self.assertEqual(database.read_bytes(),before)

    def test_unauthorized_database_operations_are_denied_before_storage(self):
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False), \
             mock.patch('server.item_library.ItemLibrary.apply',side_effect=AssertionError('unauthorized storage access')):
            status,_=self.request({'op':'get'},host=False,path='/api/item-library')
        self.assertEqual(status,403)

    def test_get_and_head_media_database_failures_use_same_http_boundary(self):
        url=ModuleStore(self.save).put_asset(b'PNG-fixture','image/png','test')
        (self.save/'模块存储/模块.sqlite3').write_bytes(b'not a sqlite database')
        with self.assertLogs('server.http_errors',level='ERROR'):
            status,value=self.request(path=url,method='GET',host=True)
        self.assertEqual(status,503,value);self.assertEqual(value['code'],'database_unavailable')
        with self.assertLogs('server.http_errors',level='ERROR'):
            status,body=self.request(path=url,method='HEAD',host=True)
        self.assertEqual(status,503);self.assertEqual(body,b'')
