"""Explicit takeover retains both originals; failures never grant a baseline."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from project_test_paths import APP_ROOT
from test_state_publish_guard import StatePublishGuardTests
from server.host_state import preserve_takeover, recovery_record
from server.save_storage import campaign_text_hash


class HostStateTakeoverTests(StatePublishGuardTests):
    def test_takeover_keeps_live_and_formal_originals_then_invalidates_previous_dm(self):
        self.add_dm()
        state = self.state('DM A running')
        self.api('/api/state', state)
        guard = self.baseline()
        rel = '战役/' + self.room['id'] + '/当前存档.json'
        formal = self.api('/api/local-save', dict(op='read-campaign', path=rel))
        before = self.checkpoint()
        result = self.api('/api/host-state/takeover', dict(campaignId=self.room['id'], path=rel,
            expectedHash=formal['sourceHash'], **guard), user=1)
        self.assertEqual(result['stateRevision'], guard['expectedStateRevision'] + 1)
        self.assertEqual(result['sourceHash'], formal['sourceHash'])
        self.assertEqual(self.api('/api/state')['campaignName'], 'DM A running')
        self.assertEqual(self.checkpoint(), before)
        point = self.api('/api/local-save', dict(op='read', path=result['recoveryPath']))
        record = json.loads(point['text'])
        self.assertEqual(record['_takeoverRecovery']['rawLiveState']['campaignName'], 'DM A running')
        self.assertEqual(record['_takeoverRecovery']['formalRecord']['campaignId'], self.room['id'])
        rejected = self.api('/api/state', dict(state, **guard), status=409)
        self.assertEqual(rejected['errorCode'], 'state-conflict')
        new_guard = dict(expectedStateRevision=result['stateRevision'], serverSessionId=result['sessionId'])
        continued = dict(state, campaignName='DM B formal continuation', **new_guard)
        self.api('/api/state', continued, user=1)
        self.assertEqual(self.api('/api/state')['campaignName'], 'DM B formal continuation')
        # Takeover points appear in the shared save-management recovery list.
        listed = self.api('/api/local-save', dict(op='recovery-list'))
        self.assertTrue(any(p['id'] == result['recoveryPath'] for p in listed['records']))

    def test_formal_changed_takeover_preserves_previous_live_without_faking_lineage(self):
        state = self.state('old live')
        self.api('/api/state', state)
        guard = self.baseline()
        root = self.accounts._supervisor.root / self.room['id']
        path = root / '战役包' / self.room['id'] / '当前存档.json'
        old_hash = state['_formalSourceHash']
        formal = dict(campaignId=self.room['id'], state=dict(state, campaignName='new formal'))
        formal['state'].pop('_formalSourceHash')
        path.write_text(json.dumps(formal))
        new_hash = campaign_text_hash(path.read_bytes())
        checkpoint = self.checkpoint()
        result = self.api('/api/host-state/takeover', dict(campaignId=self.room['id'],
            path='战役/' + self.room['id'] + '/当前存档.json', expectedHash=new_hash, **guard))
        self.assertEqual(self.checkpoint(), checkpoint)
        record = json.loads(self.api('/api/local-save', dict(op='read', path=result['recoveryPath']))['text'])
        self.assertEqual(record['_takeoverRecovery']['rawLiveState']['_formalSourceHash'], old_hash)
        self.assertEqual(record['_takeoverRecovery']['formalRecord']['state']['campaignName'], 'new formal')
        payload = dict(formal['state'], protocolVersion=SERVER_PROTOCOL_VERSION(), _formalSourceHash=new_hash,
            expectedStateRevision=result['stateRevision'], serverSessionId=result['sessionId'])
        self.api('/api/state', payload)
        process = self.accounts._supervisor.workers[self.room['id']]['process']
        process.kill(); process.wait(timeout=5)
        self.assertEqual(self.api('/api/state')['campaignName'], 'new formal')

    def test_bad_baseline_formal_hash_or_recovery_io_never_changes_revision(self):
        state = self.state('kept live')
        self.api('/api/state', state)
        guard = self.baseline()
        rel = '战役/' + self.room['id'] + '/当前存档.json'
        payload = dict(campaignId=self.room['id'], path=rel, expectedHash=state['_formalSourceHash'], **guard)
        def current():
            state = self.api('/api/state'); state.pop('_serverNow', None)
            return self.checkpoint(), state
        previous = current()
        for change in (dict(expectedHash='0'*64), dict(expectedStateRevision=guard['expectedStateRevision']-1),
                       dict(serverSessionId='old-session')):
            self.api('/api/host-state/takeover', dict(payload, **change), status=409)
            self.assertEqual(current(), previous)
        backup = self.accounts._supervisor.root / self.room['id'] / '战役包' / self.room['id'] / '自动备份'
        backup.write_text('cannot be a directory')
        try:
            self.api('/api/host-state/takeover', payload, status=500)
            self.assertEqual(current(), previous)
        finally: backup.unlink()
        self.api('/api/host-state/takeover', dict(payload, expectedHash=state['_formalSourceHash']), user=2, status=404)


def SERVER_PROTOCOL_VERSION():
    from test_campaign_rooms import SERVER
    return SERVER.SERVER_PROTOCOL_VERSION


class HostStateRecoveryUnitTests(unittest.TestCase):
    def test_switching_campaigns_preserves_previous_private_formal_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = dict(campaignId='target', privatePrep={'secret':'target'}, state={'campaignId':'target','maps':[]})
            previous = dict(campaignId='previous', privatePrep={'secret':'previous'}, state={'campaignId':'previous','maps':[]})
            for name, record in (('target', target), ('previous', previous)):
                folder = root / '战役' / name
                folder.mkdir(parents=True)
                (folder / '当前存档.json').write_text(json.dumps(record), encoding='utf-8')
            raw = (root / '战役/target/当前存档.json').read_bytes()
            live = dict(campaignId='previous', maps=[], campaignName='previous unsaved')
            result = preserve_takeover(dict(path='战役/target/当前存档.json', campaignId='target',
                expectedHash=campaign_text_hash(raw)), root, live, 7, 'session')
            record = json.loads((root / result['recoveryPath']).read_text('utf-8'))
            metadata = record['_takeoverRecovery']
            self.assertEqual(metadata['formalRecord'], target)
            self.assertEqual(metadata['liveFormalRecord'], previous)
            self.assertEqual(metadata['rawLiveState'], live)
            self.assertEqual(record['privatePrep'], target['privatePrep'])

    def test_overlay_preserves_private_maps_tokens_notes_and_conditions(self):
        formal = dict(campaignId='c', privatePrep={'secret':'preparation'}, state=dict(campaignId='c', maps=[
            dict(id='m', mapData='private-map', tokens=[
                dict(id='t', hp=20, gmNote='private note', conditions=[{'id':'private', 'visibility':'gm'}]),
                dict(id='hidden', hp=15, hiddenFromPlayers=True)]),
            dict(id='private-map', name='secret map', tokens=[])]))
        live = dict(campaignId='c', maps=[dict(id='m', mapData=None,
            tokens=[dict(id='t', hp=3, x=30, conditions=[{'id':'poison','visibility':'public'}])])])
        result = recovery_record(formal, live, 7, 'session')
        self.assertEqual(result['privatePrep'], formal['privatePrep'])
        self.assertEqual(result['state']['maps'][0]['mapData'], 'private-map')
        self.assertEqual(result['state']['maps'][1], formal['state']['maps'][1])
        token = result['state']['maps'][0]['tokens'][0]
        self.assertEqual((token['hp'], token['gmNote']), (3, 'private note'))
        self.assertEqual([c['id'] for c in token['conditions']], ['private', 'poison'])
        self.assertEqual(result['state']['maps'][0]['tokens'][1], formal['state']['maps'][0]['tokens'][1])
        self.assertEqual(result['_takeoverRecovery']['formalRecord'], formal)
        self.assertEqual(result['_takeoverRecovery']['rawLiveState'], live)


class GracefulShutdownTests(unittest.TestCase):
    def test_sigterm_closes_room_worker_and_releases_both_server_leases(self):
        with tempfile.TemporaryDirectory() as directory:
            script = '''
import json,sys,threading,time
from pathlib import Path
from test_campaign_rooms import SERVER,Mailbox,PASSWORD,AccountStore,RoomStore,WebEntrances
from server.workspace_backup import epoch
from server.save_storage import ProjectServerLock
from server.installation_backup import InstallationLease
root=Path(sys.argv[1]); settings=dict(enabled=True,roomsEnabled=True,publicOrigin='https://pl.example.com')
accounts=AccountStore(root/'save/玩家档案/认证',settings,mailer=Mailbox(),epoch=lambda:epoch(root/'save'))
accounts.register('owner@example.com','Owner',PASSWORD); accounts.verify(accounts.mailer.messages[-1][2],PASSWORD)
token=accounts.login('owner@example.com',PASSWORD)[0];room=RoomStore(accounts).create(token,'Graceful room')
SERVER.LOCAL_SAVE_ROOT=str(root/'save');SERVER._ACCOUNT_STORE=accounts;SERVER.ACCOUNT_SETTINGS=settings
SERVER.WEB_ENTRANCES=WebEntrances({'webEntrances':{'playerHostname':'pl.example.com'}},root)
SERVER.AUTH_METHOD='email_password'
class Quiet(SERVER.Handler):
 def log_message(self,*args):pass
server=SERVER.Server(('127.0.0.1',0),Quiet);SERVER.PORT=server.server_port
project=ProjectServerLock(root/'save');lease=InstallationLease(root/'installation',shared=True)
def watch():
 while not getattr(accounts,'_supervisor',None) or not accounts._supervisor.workers:time.sleep(.02)
 (root/'worker.pid').write_text(str(accounts._supervisor.workers[room['id']]['process'].pid))
threading.Thread(target=watch,daemon=True).start()
print(json.dumps(dict(port=SERVER.PORT,room=room['id'],token=token)),flush=True)
SERVER.serve_application(server,project,lease)
(root/'closed').write_text('ok')
'''
            env = dict(os.environ, PYTHONPATH=str(Path(__file__).parent) + os.pathsep + str(APP_ROOT), PYTHONDONTWRITEBYTECODE='1')
            process = subprocess.Popen([sys.executable, '-u', '-c', script, directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
            try:
                import http.client
                initial = json.loads(process.stdout.readline())
                conn = http.client.HTTPConnection('127.0.0.1', initial['port'], timeout=15)
                headers = {'Host':'pl.example.com', 'X-Forwarded-Proto':'https',
                           'Cookie':'__Host-sundoll-account=' + initial['token']}
                conn.request('GET', '/rooms/' + initial['room'] + '/api/info', headers=headers)
                response=conn.getresponse();body=response.read();self.assertEqual(response.status,200,body);conn.close()
                deadline = time.monotonic() + 5
                while not Path(directory, 'worker.pid').exists() and time.monotonic() < deadline: time.sleep(.02)
                worker = int(Path(directory, 'worker.pid').read_text())
                process.send_signal(signal.SIGTERM)
                out, err = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, err)
                self.assertEqual(Path(directory, 'closed').read_text(), 'ok')
                with self.assertRaises(ProcessLookupError): os.kill(worker, 0)
                from server.save_storage import ProjectServerLock
                from server.installation_backup import InstallationLease
                project = ProjectServerLock(Path(directory) / 'save'); project.close()
                lease = InstallationLease(Path(directory) / 'installation', shared=False); lease.close()
            finally:
                if process.poll() is None: process.kill(); process.communicate(timeout=10)


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for cls in (HostStateTakeoverTests, HostStateRecoveryUnitTests, GracefulShutdownTests):
        for name in sorted(cls.__dict__):
            if name.startswith('test_'): suite.addTest(cls(name))
    return suite


if __name__ == '__main__': unittest.main()
