from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import json
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from test_local_save_bridge import SERVER

class AuditConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        self.path = '战役/c1-旧名/当前存档.json'

    def write(self, name, expected=None):
        text = json.dumps({'campaignId':'c1','campaignName':name,'state':{'maps':[{'id':'m1','tokens':[],'mapData':'BIG-IMAGE'}]}}, ensure_ascii=False)
        return SERVER.perform_local_save_operation({'op':'write-campaign','path':self.path,'text':text,'expectedHash':expected},self.root)

    def test_stale_writer_keeps_both_versions_and_legacy_route_cannot_bypass(self):
        first=self.write('初始');self.write('最新', first['hash'])
        with self.assertRaises(SERVER.SaveConflict): self.write('旧页面进度',first['hash'])
        current=json.loads((Path(self.root)/self.path).read_text())
        self.assertEqual(current['campaignName'],'最新')
        backups=list((Path(self.root)/'战役/c1-旧名/自动备份').glob('保存冲突-*.json'))
        self.assertEqual(json.loads(backups[0].read_text())['campaignName'],'旧页面进度')
        with self.assertRaises(SERVER.SaveConflict):
            SERVER.perform_local_save_operation({'op':'write','path':self.path,'text':'{}'},self.root)

    def test_two_concurrent_writers_only_one_can_commit(self):
        first=self.write('初始')
        def attempt(n):
            try:self.write(str(n),first['hash']);return 'saved'
            except SERVER.SaveConflict:return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(attempt,[1,2]))
        self.assertCountEqual(results,['saved','conflict'])

    def test_catalog_is_small_cached_and_refreshes_after_save(self):
        first=self.write('旧名')
        records=SERVER.perform_local_save_operation({'op':'campaign-catalog'},self.root)['records']
        self.assertNotIn('BIG-IMAGE',json.dumps(records))
        self.assertNotIn('tokens',records[0]['state']['maps'][0])
        with mock.patch.object(SERVER.json,'load',side_effect=AssertionError('unchanged file must not be parsed again')):
            SERVER.perform_local_save_operation({'op':'campaign-catalog'},self.root)
        self.write('新名',first['hash'])
        latest=SERVER.perform_local_save_operation({'op':'campaign-catalog'},self.root)['records'][0]
        self.assertEqual(latest['name'],'新名')

    def test_project_lock_excludes_second_server_and_releases(self):
        lock=SERVER.ProjectServerLock(self.root)
        try:
            with self.assertRaises(RuntimeError): SERVER.ProjectServerLock(self.root)
        finally:lock.close()
        lock=SERVER.ProjectServerLock(self.root);lock.close()

    def test_replay_rejects_other_campaign_and_other_server(self):
        state={'campaignId':'new','maps':[]}
        for action in [{'op':'patchToken','campaignId':'old'},{'op':'patchToken','_sessionId':'old-server'}]:
            self.assertFalse(SERVER.apply_action(state,action))

    def test_new_protocol_requires_action_scope_and_rejects_stale_scope(self):
        with mock.patch.object(SERVER,'STATE',{'campaignId':'c1','protocolVersion':SERVER.SERVER_PROTOCOL_VERSION}):
            handler=object.__new__(SERVER.Handler)
            self.assertFalse(handler.action_context_matches({}))
            self.assertFalse(handler.action_context_matches({'campaignId':'c2','serverSessionId':SERVER.SESSION_ID}))
            self.assertTrue(handler.action_context_matches({'campaignId':'c1','serverSessionId':SERVER.SESSION_ID}))

    def test_campaign_switch_clears_old_replay_queue(self):
        handler=mock.Mock(headers={});handler.path='/api/state'
        handler._read_json_body.return_value={'campaignId':'new','maps':[],'protocolVersion':SERVER.SERVER_PROTOCOL_VERSION}
        with mock.patch.object(SERVER,'STATE',{'campaignId':'old'}),mock.patch.object(SERVER,'RECENT_ACTIONS',[{'seq':1,'op':'patchToken'}]) as recent, mock.patch.object(SERVER,'ACTION_IDS',{'old':1}) as ids, mock.patch.object(SERVER,'host_request_allowed',return_value=True), mock.patch.object(SERVER,'broadcast'):
            SERVER.Handler.do_POST(handler)
            self.assertEqual(recent,[]);self.assertEqual(ids,{})
