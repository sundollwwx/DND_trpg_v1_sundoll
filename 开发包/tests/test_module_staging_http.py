from project_test_paths import APP_ROOT
import http.client
import json
import os
import time
import unittest
from test_backend_storage_http import BackendStorageHttpTests
from server.module_runtime import ModuleRuntime
from server.module_staging import ModuleStaging, RETENTION_SECONDS


class ModuleStagingHttpTests(unittest.TestCase):
    setUp=BackendStorageHttpTests.setUp
    close_server=BackendStorageHttpTests.close_server
    request=BackendStorageHttpTests.request
    login=BackendStorageHttpTests.login

    def test_preview_confirmation_can_be_retried_before_expired_copy_cleanup(self):
        archive=self.root/'source.sundoll'
        ModuleRuntime(self.save,APP_ROOT).packages.export(archive,'general','隔离通用',
            dict(templates=[dict(id='guard',name='守卫',hpMax=10)],items=[]),'stage-general')
        connection=http.client.HTTPConnection('127.0.0.1',self.port)
        connection.request('POST','/api/modules/preview',archive.read_bytes(),
            {'Content-Type':'application/octet-stream','X-Sundoll-Local-Save':'1'})
        response=connection.getresponse();value=json.loads(response.read());status=response.status;connection.close()
        self.assertEqual(status,200,value)
        ticket=value['ticket'];command=dict(op='confirm-import',ticket=ticket)
        first=self.request(command,host=True,path='/api/modules')
        self.assertEqual(first[0],200,first)
        second=self.request(command,host=True,path='/api/modules')
        self.assertEqual(second[0],200,second)
        self.assertTrue(second[1]['module']['alreadyInstalled'])
        self.assertEqual(second[1]['module']['moduleId'],first[1]['module']['moduleId'])
        self.assertEqual(second[1]['module']['dataHash'],first[1]['module']['dataHash'])
        staging=ModuleStaging(self.save);archive_copy=staging.path('import',ticket+'.sundoll')
        self.assertTrue(archive_copy.exists())
        staging.cleanup(force=True,now=time.time()+RETENTION_SECONDS+10)
        self.assertFalse(archive_copy.exists());self.assertFalse(staging.path('import',ticket+'.json').exists())
        self.assertEqual(ModuleRuntime(self.save,APP_ROOT).packages.catalog()[0]['moduleId'],'stage-general')

    def test_download_lease_preserves_payload_and_refreshes_retry_window(self):
        staging=ModuleStaging(self.save);name='a'*32+'.zip';path=staging.path('export',name)
        path.parent.mkdir(parents=True);path.write_bytes(b'isolated zip download')
        expired=time.time()-RETENTION_SECONDS-10;os.utime(path,(expired,expired))
        status,body=self.request(method='GET',path='/api/modules/download/'+name,host=True)
        self.assertEqual(status,200);self.assertEqual(body,b'isolated zip download')
        # The socket can deliver the last byte before the serving thread exits
        # its lease. Either an active lease or its renewed lifetime must protect
        # the payload from an immediate competing cleanup/retry.
        self.assertTrue(path.exists());self.assertEqual(staging.cleanup(force=True),[])
        self.assertEqual(self.request(method='GET',path='/api/modules/download/'+name,host=True),(200,body))


del BackendStorageHttpTests
