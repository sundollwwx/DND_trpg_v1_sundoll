"""Real private workers, SIGKILL recovery, and durable successful responses."""
import json
from pathlib import Path
import sqlite3
import unittest
from test_campaign_rooms import CampaignRoomHttpTests, SERVER
from server.module_store import ModuleStore
from server.workspace import atomic_json


class RoomCheckpointHttpTests(CampaignRoomHttpTests):
    def json_request(self,path,data=None,user=0,status=200):
        code,body,_=self.request(path,data,user=user)
        self.assertEqual(code,status,body)
        return json.loads(body)

    def publish(self,name='已确认状态',folder='c-checkpoint'):
        rid=self.room['id']
        state=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-checkpoint',
            campaignName=name,activeMapId='m',maps=[dict(id='m',mapW=500,mapH=500,
                playerAccessible=True,tokens=[])])
        self.json_request('/rooms/'+rid+'/api/info')
        path=self.accounts._supervisor.root/rid/'战役包'/folder/'当前存档.json'
        atomic_json(path,dict(campaignId='c-checkpoint',state=state))
        state['_formalSourceHash']=ModuleStore.hash_file(path)
        return self.json_request('/rooms/'+rid+'/api/state',state)

    def kill_worker(self):
        worker=self.accounts._supervisor.workers[self.room['id']]
        worker['process'].kill();worker['process'].wait(timeout=5)

    def test_acknowledged_state_survives_sigkill_and_second_sigkill_after_resume(self):
        rid=self.room['id']
        first=self.publish('第一份已确认')
        self.kill_worker()
        restored=self.json_request('/rooms/'+rid+'/api/state')
        self.assertEqual(restored['campaignName'],'第一份已确认')
        self.assertEqual(restored['_stateRevision'],first['stateRevision'])
        second=self.publish('第二份已确认')
        self.kill_worker()
        restored=self.json_request('/rooms/'+rid+'/api/state')
        self.assertEqual(restored['campaignName'],'第二份已确认')
        self.assertEqual(restored['_stateRevision'],second['stateRevision'])

    def test_action_receipt_and_sequence_survive_sigkill_and_new_player_session(self):
        rid=self.room['id']
        self.make_character(0,rid)
        player=self.json_request('/rooms/'+rid+'/api/account/player-session',{})['session']
        state=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-checkpoint',
            campaignName='动作持久性',activeMapId='m',maps=[dict(id='m',mapW=500,mapH=500,
                playerAccessible=True,tokens=[dict(id='t',type='pc',ownerPlayerId=player['playerId'],hp=20,hpMax=20)])])
        path=self.accounts._supervisor.root/rid/'战役包/c-checkpoint/当前存档.json'
        atomic_json(path,dict(campaignId='c-checkpoint',state=state))
        state['_formalSourceHash']=ModuleStore.hash_file(path)
        self.json_request('/rooms/'+rid+'/api/state',state)
        def action(session):
            info=self.json_request('/rooms/'+rid+'/api/info')
            return self.json_request('/rooms/'+rid+'/api/action',dict(sessionToken=session['sessionToken'],
                campaignId='c-checkpoint',serverSessionId=info['sessionId'],actionId='durable-hp-action',
                action=dict(op='patchToken',mapId='m',tokenId='t',patch=dict(hp=7))))
        first=action(player)
        self.kill_worker()
        replacement=self.json_request('/rooms/'+rid+'/api/account/player-session',{})['session']
        retry=action(replacement)
        self.assertEqual((retry['duplicate'],retry['seq']),(True,first['seq']))
        self.assertEqual(self.json_request('/rooms/'+rid+'/api/state')['maps'][0]['tokens'][0]['hp'],7)

    def test_checkpoint_write_failure_never_returns_a_successful_status(self):
        rid=self.room['id']
        self.json_request('/rooms/'+rid+'/api/info')
        checkpoint=self.accounts._supervisor.root/rid/'运行数据/房间运行状态.json'
        checkpoint.mkdir()
        code,_,_=self.request('/rooms/'+rid+'/api/state',dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,
            campaignId='c-checkpoint',campaignName='不能确认',maps=[]))
        self.assertNotEqual(code,200)
        checkpoint.rmdir()

    def test_nonfinite_json_is_rejected_before_mutating_state_or_later_session_headers(self):
        rid=self.room['id']
        self.make_character(0,rid)
        self.publish('valid preceding state')
        for invalid in (float('nan'),float('inf')):
            code,_,_=self.request('/rooms/'+rid+'/api/state',dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,
                campaignId='c-checkpoint',campaignName='invalid replacement',maps=[],diagnosticExtra=invalid))
            self.assertEqual(code,400)
        self.assertEqual(self.json_request('/rooms/'+rid+'/api/state')['campaignName'],'valid preceding state')
        self.json_request('/rooms/'+rid+'/api/account/player-session',{})

    def test_checkpoint_valueerror_and_sqlite_error_cannot_leave_a_buffered_200_status(self):
        rid=self.room['id']
        self.make_character(0,rid);self.publish()
        save=self.accounts._supervisor.root/rid/'运行数据/存档'
        marker=save/'工作区.json';original=marker.read_bytes()
        try:
            marker.write_text('broken temporary marker')
            code,_,_=self.request('/rooms/'+rid+'/api/account/player-session',{})
            self.assertNotEqual(code,200)
        finally:marker.write_bytes(original)
        database=save/'模块存储/模块.sqlite3'
        with sqlite3.connect(database) as db:
            row=db.execute('SELECT * FROM room_checkpoint_generation').fetchone()
            db.execute('DROP TABLE room_checkpoint_generation')
        try:
            code,_,_=self.request('/rooms/'+rid+'/api/account/player-session',{})
            self.assertNotEqual(code,200)
        finally:
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE room_checkpoint_generation(id INTEGER PRIMARY KEY,epoch TEXT,revision INTEGER)')
                db.execute('INSERT INTO room_checkpoint_generation VALUES(?,?,?)',row)

    def test_formal_v2_rejects_old_full_state_and_player_action_until_explicit_rebase(self):
        self.assert_formal_v2_rejects_old_runtime('c-checkpoint')

    def test_named_directory_formal_v2_rejects_old_state_action_and_checkpoint(self):
        self.assert_formal_v2_rejects_old_runtime('c-checkpoint-带名字的战役')

    def assert_formal_v2_rejects_old_runtime(self,folder):
        rid=self.room['id']
        self.make_character(0,rid)
        player=self.json_request('/rooms/'+rid+'/api/account/player-session',{})['session']
        self.publish('formal v1',folder=folder)
        room=self.accounts._supervisor.root/rid
        old=json.loads((room/'运行数据/房间运行状态.json').read_text())['state']
        path=room/'战役包'/folder/'当前存档.json'
        fresh=dict(old,campaignName='formal v2')
        fresh.pop('_formalSourceHash',None)
        atomic_json(path,dict(campaignId='c-checkpoint',state=fresh))
        previous=json.loads((room/'运行数据/房间运行状态.json').read_text())
        code,_,_=self.request('/rooms/'+rid+'/api/state',old)
        self.assertEqual(code,409)
        info=self.json_request('/rooms/'+rid+'/api/info')
        code,_,_=self.request('/rooms/'+rid+'/api/action',dict(sessionToken=player['sessionToken'],
            campaignId='c-checkpoint',serverSessionId=info['sessionId'],actionId='stale-action',
            action=dict(op='doodle',mapId='m',points=[[1,1],[2,2]],color='#fff')))
        self.assertEqual(code,409)
        current=json.loads((room/'运行数据/房间运行状态.json').read_text())
        self.assertEqual((current['revision'],current['nextSeq']),(previous['revision'],previous['nextSeq']))
        # Authentication queries remain usable while the old runtime is stale.
        self.json_request('/rooms/'+rid+'/api/account/player-session',{})
        self.kill_worker()
        self.assertNotIn('campaignName',self.json_request('/rooms/'+rid+'/api/state'))
        fresh['_formalSourceHash']=ModuleStore.hash_file(path)
        self.json_request('/rooms/'+rid+'/api/state',fresh)
        self.kill_worker()
        self.assertEqual(self.json_request('/rooms/'+rid+'/api/state')['campaignName'],'formal v2')

    def test_duplicate_identity_rejects_successful_ack_and_checkpoint_loading(self):
        rid=self.room['id'];self.publish(folder='c-checkpoint-原战役')
        room=self.accounts._supervisor.root/rid
        previous=json.loads((room/'运行数据/房间运行状态.json').read_text())
        atomic_json(room/'战役包/c-checkpoint-副本/当前存档.json',
                    dict(campaignId='c-checkpoint',state=dict(campaignId='c-checkpoint',maps=[])))
        code,_,_=self.request('/rooms/'+rid+'/api/state',previous['state'])
        self.assertEqual(code,409)
        self.assertEqual(json.loads((room/'运行数据/房间运行状态.json').read_text()),previous)
        self.kill_worker()
        self.assertNotIn('campaignName',self.json_request('/rooms/'+rid+'/api/state'))

    def test_collect_binding_is_durable_and_stale_collect_does_not_change_map(self):
        rid=self.room['id'];self.make_character(0,rid)
        player=self.json_request('/rooms/'+rid+'/api/account/player-session',{})['session']
        state=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-checkpoint',
            campaignName='收入小库',activeMapId='m',maps=[dict(id='m',mapW=500,mapH=500,
            playerAccessible=True,tokens=[dict(id=tid,name=tid,type='pc',ownerPlayerId=player['playerId'],
                hp=7,hpMax=20,x=40,y=20) for tid in ('collected','uncollected')])])
        room=self.accounts._supervisor.root/rid
        path=room/'战役包/c-checkpoint-命名目录/当前存档.json'
        atomic_json(path,dict(campaignId='c-checkpoint',state=state))
        state['_formalSourceHash']=ModuleStore.hash_file(path)
        self.json_request('/rooms/'+rid+'/api/state',state)
        def collect(token,session):
            return self.request('/rooms/'+rid+'/api/player-profiles',dict(op='collect',
                campaignId='c-checkpoint',tokenId=token,sessionToken=session['sessionToken']),
                headers={'X-Sundoll-Local-Save':''})
        code,body,_=collect('collected',player);self.assertEqual(code,200,body)
        owned=next(piece['ownedPieceId'] for piece in json.loads(body)['library']['pieces'] if piece['name']=='collected')
        self.kill_worker()
        restored=self.json_request('/rooms/'+rid+'/api/state')
        self.assertEqual(restored['maps'][0]['tokens'][0]['ownedPieceId'],owned)
        player=self.json_request('/rooms/'+rid+'/api/account/player-session',{})['session']
        previous=json.loads((room/'运行数据/房间运行状态.json').read_text())
        atomic_json(path,dict(campaignId='c-checkpoint',state=dict(state,campaignName='formal v2')))
        code,body,_=collect('uncollected',player);self.assertEqual(code,409,body)
        current=self.json_request('/rooms/'+rid+'/api/state')
        self.assertNotIn('ownedPieceId',current['maps'][0]['tokens'][1])
        self.assertEqual(current['_stateRevision'],restored['_stateRevision'])
        self.assertEqual(json.loads((room/'运行数据/房间运行状态.json').read_text()),previous)

    def test_stale_journal_and_bgm_rejected_before_runtime_changes(self):
        rid=self.room['id'];self.publish('formal v1')
        room=self.accounts._supervisor.root/rid
        previous=json.loads((room/'运行数据/房间运行状态.json').read_text())
        path=room/'战役包/c-checkpoint/当前存档.json'
        atomic_json(path,dict(campaignId='c-checkpoint',state=dict(previous['state'],campaignName='formal v2')))
        for endpoint,payload in (('/api/journal',dict(campaignId='c-checkpoint',operation='create',revision=0)),
                                 ('/api/host-action',dict(action=dict(op='bgm',url='/test.mp3')))):
            code,body,_=self.request('/rooms/'+rid+endpoint,payload);self.assertEqual(code,409,body)
        self.assertEqual(json.loads((room/'运行数据/房间运行状态.json').read_text()),previous)

    def test_publish_then_formal_save_receipt_can_rebase_and_recover_after_sigkill(self):
        rid=self.room['id'];self.publish('published draft v1')
        room=self.accounts._supervisor.root/rid
        old=json.loads((room/'运行数据/房间运行状态.json').read_text())['state']
        old_hash=old.pop('_formalSourceHash')
        formal=dict(old,campaignName='formally saved v2')
        saved=self.json_request('/rooms/'+rid+'/api/local-save',dict(op='write-campaign',
            protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,path='战役/c-checkpoint/当前存档.json',
            expectedHash=old_hash,text=json.dumps(dict(campaignId='c-checkpoint',campaignName='formally saved v2',state=formal))))
        formal['_formalSourceHash']=saved['hash']
        self.json_request('/rooms/'+rid+'/api/state',formal)
        self.kill_worker()
        self.assertEqual(self.json_request('/rooms/'+rid+'/api/state')['campaignName'],'formally saved v2')


def load_tests(loader,tests,pattern):
    suite=unittest.TestSuite()
    for name in sorted(RoomCheckpointHttpTests.__dict__):
        if name.startswith('test_'):suite.addTest(RoomCheckpointHttpTests(name))
    return suite


if __name__=='__main__':unittest.main()
