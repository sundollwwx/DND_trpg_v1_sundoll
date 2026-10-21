"""End-to-end account authorization and portable saves across isolated rooms."""
import hashlib
import http.client
import json
import unittest
from urllib.parse import urlsplit

from test_campaign_rooms import CampaignRoomHttpTests, SERVER
from server import player_profiles as profiles
from server.module_runtime import ModuleRuntime
from server.resources import ResourceStore
from server.save_storage import perform_local_save_operation
from server.workspace import Workspace, enable


class AccountRoomIntegrationTests(CampaignRoomHttpTests):
    def json_request(self, path, data=None, user=0, headers=None, status=200):
        code,body,response_headers=self.request(path,data,user,headers)
        self.assertEqual(code,status,body)
        return json.loads(body),response_headers

    def join_member(self, rid, user=1, role='player'):
        invitation,_=self.json_request('/api/account/room-invite',
            dict(roomId=rid,email=f'u{user}@example.com',role=role))
        token=urlsplit(invitation['invitationUrl']).fragment.removeprefix('room=')
        result,_=self.json_request('/api/account/room-accept',dict(token=token),user=user)
        self.assertEqual((result['room']['id'],result['room']['role']),(rid,role))
        return self.accounts.session(self.tokens[user])['accountId']

    def upload_package(self, rid, archive, user=0, status=200):
        connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=20)
        headers={'Host':'pl.example.com','X-Forwarded-Proto':'https','Origin':'https://pl.example.com',
            'Content-Type':'application/octet-stream','X-Sundoll-Local-Save':'1',
            'Cookie':'__Host-sundoll-account='+self.tokens[user]}
        connection.request('POST','/rooms/'+rid+'/api/modules/preview',archive.read_bytes(),headers)
        response=connection.getresponse();body=response.read();code=response.status;connection.close()
        self.assertEqual(code,status,body)
        preview=json.loads(body)
        if status!=200: return preview
        installed,_=self.json_request('/rooms/'+rid+'/api/modules',
            dict(op='confirm-import',ticket=preview['ticket']),user=user)
        self.assertEqual(installed['module']['moduleId'],preview['module']['moduleId'])
        return installed['module']

    def test_central_profile_actions_enforce_owner_session_csrf_and_binding_conflicts(self):
        rid=self.room['id'];member=self.join_member(rid)
        cid=self.seed_legacy('旧角色',rid)
        profile_list=dict(roomId=rid)
        bind=dict(roomId=rid,accountId=member,characterId=cid)
        for action,data in (('room-profiles',profile_list),('room-bind-player',bind)):
            path='/api/account/'+action
            self.json_request(path,data,user=None,status=401)
            self.json_request(path,data,user=1,status=403)
            self.json_request(path,data,user=2,status=404)
            self.json_request(path,data,headers={'Origin':'https://evil.example'},status=403)
            self.json_request(path,data,headers={'X-Sundoll-Account':'0'},status=403)
        listed,_=self.json_request('/api/account/room-profiles',profile_list)
        self.assertEqual(listed['characters'][0]['characterId'],cid)
        self.assertNotIn('credential',listed)
        self.json_request('/api/account/room-bind-player',dict(bind,
            accountId=self.accounts.session(self.tokens[2])['accountId']),status=404)
        self.json_request('/api/account/room-bind-player',dict(bind,characterId='o'+'0'*32),status=404)
        first,_=self.json_request('/api/account/room-bind-player',bind)
        retry,_=self.json_request('/api/account/room-bind-player',bind)
        self.assertEqual(first,retry)
        self.assertEqual(first['character']['accountId'],member)
        ready,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        pid=ready['player']['profile']['playerId']
        self.json_request('/rooms/'+rid+'/api/player-profiles',dict(op='delete',playerId=pid),status=409)
        retained,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        self.assertEqual(retained['player']['profile']['playerId'],pid)
        self.assertEqual(retained['player']['state'],'ready')
        another=self.seed_legacy('第二个旧角色',rid)
        self.json_request('/api/account/room-bind-player',dict(bind,characterId=another))
        self.json_request('/api/account/room-member',dict(roomId=rid,accountId=member,role='remove'))
        self.json_request('/api/account/room-bind-player',bind,status=404)
        self.json_request('/api/account/logout',{})
        self.json_request('/api/account/room-profiles',profile_list,status=401)

    def test_room_html_scopes_cache_to_authenticated_account_before_room_script(self):
        rid=self.room['id'];self.join_member(rid)
        for user in (0,1):
            code,body,headers=self.request('/rooms/'+rid+'/主控台/玩家.html',user=user)
            self.assertEqual(code,200,body)
            html=body.decode('utf-8')
            account_id=self.accounts.session(self.tokens[user])['accountId']
            meta='<meta name="sundoll-account-id" content="'+account_id+'">'
            self.assertEqual(html.count(meta),1)
            self.assertLess(html.index(meta),html.index('src="/shared/room-context.js"'))
            other_id=self.accounts.session(self.tokens[1-user])['accountId']
            self.assertNotIn(other_id,html)
            header_map={key.lower():value for key,value in headers}
            cache_control=','.join(value for key,value in headers if key.lower()=='cache-control')
            self.assertIn('no-store',cache_control)
            self.assertIn('private',cache_control)
            self.assertIn('Cookie',header_map['vary'])
        code,body,_=self.request('/rooms/'+rid+'/主控台/主控台.html')
        self.assertEqual(code,200,body)
        self.assertIn(self.accounts.session(self.tokens[0])['accountId'],body.decode())
        self.assertEqual(self.request('/rooms/'+rid+'/主控台/玩家.html',user=2)[0],404)
        self.assertEqual(self.request('/rooms/'+rid+'/主控台/玩家.html',user=None)[0],302)

    def test_room_player_session_cannot_be_reused_with_another_members_account_cookie(self):
        rid=self.room['id'];self.join_member(rid,user=1);self.join_member(rid,user=2)
        self.make_character(1,rid)
        first,_=self.json_request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        token=first['session']['sessionToken']
        self.json_request('/rooms/'+rid+'/api/player-profiles',dict(op='get',sessionToken=token),user=1)
        self.json_request('/rooms/'+rid+'/api/player-profiles',dict(op='get',sessionToken=token),user=2,status=401)
        self.json_request('/rooms/'+rid+'/api/backpack',dict(op='get',sessionToken=token),user=2,status=401)
        self.json_request('/rooms/'+rid+'/api/player-profiles',dict(op='get',sessionToken=token),user=1)
        self.json_request('/rooms/'+rid+'/api/player-profiles',dict(op='get',playerId=first['session']['playerId']))

    def test_stale_account_guard_blocks_changes_after_cookie_switch_and_sse_still_connects(self):
        rid=self.room['id'];self.join_member(rid,user=1,role='dm')
        owner=self.accounts.session(self.tokens[0])['accountId']
        dm=self.accounts.session(self.tokens[1])['accountId']
        initial=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId='c-account-guard',
            campaignName='切换前的状态',maps=[])
        self.json_request('/rooms/'+rid+'/api/state',initial,
            headers={'X-Sundoll-Expected-Account':owner})
        changed=dict(initial,campaignName='不应被旧页面写入')
        self.json_request('/rooms/'+rid+'/api/state',changed,user=1,
            headers={'X-Sundoll-Expected-Account':owner},status=409)
        state,_=self.json_request('/rooms/'+rid+'/api/state',user=1)
        self.assertEqual(state['campaignName'],initial['campaignName'])
        self.json_request('/rooms/'+rid+'/api/state?sundollAccount='+owner,user=1,status=409)
        connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=5)
        connection.request('GET','/rooms/'+rid+'/api/events?sundollAccount='+dm,
            headers={'Host':'pl.example.com','X-Forwarded-Proto':'https',
                'Cookie':'__Host-sundoll-account='+self.tokens[1]})
        response=connection.getresponse()
        self.assertEqual(response.status,200)
        chunk=response.read1(65536)
        event=next(line[6:] for line in chunk.splitlines() if line.startswith(b'data: '))
        self.assertEqual(json.loads(event)['state']['campaignName'],initial['campaignName'])
        connection.close()

    def test_central_account_guard_rejects_stale_pages_without_creating_another_accounts_room(self):
        rid=self.room['id'];self.join_member(rid)
        owner=self.accounts.session(self.tokens[0])['accountId']
        member=self.accounts.session(self.tokens[1])['accountId']
        for user,account_id in ((0,owner),(1,member)):
            result,_=self.json_request('/api/account/rooms',user=user,
                headers={'X-Sundoll-Expected-Account':account_id})
            self.assertEqual([room['id'] for room in result['rooms']],[rid])
        stale={'X-Sundoll-Expected-Account':owner}
        self.json_request('/api/account/rooms',user=1,headers=stale,status=409)
        self.json_request('/api/account/rooms',user=None,headers=stale,status=401)
        self.json_request('/api/account/room-create',dict(name='不应创建的空间'),
            user=1,headers=stale,status=409)
        result,_=self.json_request('/api/account/rooms',user=1)
        self.assertEqual([room['id'] for room in result['rooms']],[rid])
        created,_=self.json_request('/api/account/room-create',dict(name='当前成员自己的空间'),
            user=1,headers={'X-Sundoll-Expected-Account':member})
        self.assertEqual(created['room']['role'],'owner')

    def original_workspace_packages(self):
        source_root=self.root/'original-workspace'
        source_save=enable(source_root)
        runtime=ModuleRuntime(source_save,self.root/'original-app')
        runtime.ensure_empty_runtime()
        store=profiles.Store(source_save,runtime.app,self.root/'original-cache')
        player=store.create('原存档玩家',account_id='a'+'f'*32)['profile']
        pid=player['playerId']
        piece=store.grant(pid,dict(name='原角色',type='pc',hpMax=30,ac=15,level=4),
            'original-character-grant')['pieces'][0]
        oid=piece['ownedPieceId']
        asset_bytes=b'\x89PNG\r\n\x1a\noriginal-isolated-map-asset'
        asset=runtime.store.put_asset(asset_bytes,'image/png','campaign:original')
        cid='c-original-campaign'
        state=dict(protocolVersion=SERVER.SERVER_PROTOCOL_VERSION,campaignId=cid,campaignName='原冒险进度',
            activeMapId='original-map',presentedMapId='original-map',maps=[dict(id='original-map',name='原地图',
                playerAccessible=True,mapW=800,mapH=600,mapData=asset,
                tokens=[dict(piece,id='original-token',hp=7,x=33,y=44)])])
        resources=ResourceStore(store,profiles)
        resources.reconcile(state,accept_changes=True)
        bag,_=resources.apply(pid,cid,dict(op='grant',characterId=oid,presetId='healing',quantity=4,
            revision=0,requestId='original-potions-grant'),True)
        relative='战役/'+cid+'/当前存档.json'
        document=dict(format='sangduoer-campaign',schemaVersion=5,campaignId=cid,
            campaignName=state['campaignName'],savedAt=123456,state=state)
        perform_local_save_operation(dict(op='write-campaign',path=relative,expectedHash=None,
            text=json.dumps(document)),str(source_save))
        campaign_file=Workspace(source_save).save_path(relative.split('/'))
        source_hash=hashlib.sha256(campaign_file.read_bytes()).hexdigest()
        player_archive=self.root/'original-player.sundoll'
        campaign_archive=self.root/'original-progress.sundoll'
        runtime.export_player(pid,player_archive)
        runtime.export_campaign(cid,'campaign-progress',campaign_archive)
        self.assertEqual(hashlib.sha256(campaign_file.read_bytes()).hexdigest(),source_hash)
        return dict(pid=pid,oid=oid,cid=cid,bag=bag,asset=asset,assetBytes=asset_bytes,
            playerArchive=player_archive,campaignArchive=campaign_archive)

    def assert_original_member_data(self, rid, original):
        login,_=self.json_request('/rooms/'+rid+'/api/account/player-session',{},user=1)
        session=login['session']
        self.assertEqual(session['playerId'],original['pid'])
        collection,_=self.json_request('/rooms/'+rid+'/api/player-profiles',
            dict(op='get',sessionToken=session['sessionToken']),user=1)
        pieces=collection['library']['pieces']
        self.assertEqual(len(pieces),1)
        self.assertEqual((pieces[0]['ownedPieceId'],pieces[0]['hp'],pieces[0]['name']),
            (original['oid'],7,'原角色'))
        backpack,_=self.json_request('/rooms/'+rid+'/api/backpack',dict(op='get',
            sessionToken=session['sessionToken'],campaignId=original['cid']),user=1)
        items=backpack['backpack']['items']
        self.assertEqual(len(items),1)
        self.assertEqual((items[0]['id'],items[0]['quantity'],items[0]['ownerCharacterId']),
            (original['bag']['items'][0]['id'],4,original['oid']))
        current,_=self.json_request('/rooms/'+rid+'/api/state',user=1)
        self.assertEqual((current['campaignId'],current['activeMapId']),
            (original['cid'],'original-map'))
        self.assertEqual(current['maps'][0]['tokens'][0]['id'],'original-token')
        self.assertEqual(current['maps'][0]['tokens'][0]['ownerPlayerId'],original['pid'])
        code,media,_=self.request('/rooms/'+rid+original['asset'],user=1)
        self.assertEqual(code,200,media)
        self.assertEqual(media,original['assetBytes'])
        self.json_request('/rooms/'+rid+'/api/local-save',dict(op='read-campaign',
            path='战役/'+original['cid']+'/当前存档.json'),user=1,status=403)

    def test_portable_original_saves_import_bind_publish_and_resume_for_email_member(self):
        original=self.original_workspace_packages()
        rid=self.room['id'];member=self.join_member(rid)
        waiting,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        self.assertEqual(waiting['player']['state'],'unbound')
        self.assertNotIn('migration',waiting)
        self.json_request('/rooms/'+rid+'/api/account/player-session',{},user=1,status=409)
        self.upload_package(rid,original['playerArchive'],user=1,status=403)
        player_module=self.upload_package(rid,original['playerArchive'])
        progress_module=self.upload_package(rid,original['campaignArchive'])
        activated,_=self.json_request('/rooms/'+rid+'/api/modules',
            dict(op='activate-player',moduleId=player_module['moduleId']))
        self.assertEqual(activated['playerId'],original['pid'])
        run,_=self.json_request('/rooms/'+rid+'/api/modules',dict(op='create-run',
            moduleId=progress_module['moduleId'],requestId='original-progress-run-01'))
        self.assertEqual(run['campaignId'],original['cid'])
        progress,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid))
        self.assertTrue(any(c['id']==original['cid'] and c['importedProgress']
            for c in progress['migration']['campaigns']))
        self.assertTrue(any(p['playerId']==original['pid'] and p['imported']
            for p in progress['migration']['profiles']))
        listed,_=self.json_request('/api/account/room-profiles',dict(roomId=rid))
        self.assertEqual(listed['characters'][0]['characterId'],original['oid'])
        self.json_request('/api/account/room-bind-player',dict(roomId=rid,accountId=member,
            characterId=original['oid']))
        ready,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        self.assertEqual(ready['player']['state'],'ready')
        original['pid']=ready['player']['profile']['playerId']
        self.assertNotIn('migration',ready)
        loaded,_=self.json_request('/rooms/'+rid+'/api/local-save',dict(op='read-campaign',
            path='战役/'+original['cid']+'/当前存档.json'))
        state=json.loads(loaded['text'])['state']
        state['_formalSourceHash']=loaded['sourceHash']
        self.json_request('/rooms/'+rid+'/api/state',state)
        self.assert_original_member_data(rid,original)
        self.accounts._supervisor.close()
        self.assert_original_member_data(rid,original)
        independent=self.rooms.create(self.tokens[1],'另一人的独立空间')['id']
        isolated,_=self.json_request('/api/account/room-profiles',dict(roomId=independent),user=1)
        self.assertEqual(isolated['profiles'],[])
        self.assertEqual(self.request('/rooms/'+independent+original['asset'],user=1)[0],404)

    def test_first_entry_is_explicit_and_never_creates_a_spoofed_members_profile(self):
        rid=self.room['id'];member=self.join_member(rid)
        owner=self.accounts.session(self.tokens[0])['accountId']
        unbound,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        self.assertEqual(unbound['player'],dict(state='unbound',profile=None))
        self.json_request('/rooms/'+rid+'/api/account/player-session',{},user=1,status=409)
        listed,_=self.json_request('/api/account/room-profiles',dict(roomId=rid))
        self.assertEqual(listed['profiles'],[])
        self.json_request('/api/account/room-start-player',dict(roomId=rid),user=None,status=401)
        self.json_request('/api/account/room-start-player',dict(roomId=rid),user=2,status=404)
        self.json_request('/api/account/room-start-player',dict(roomId=rid),user=1,
            headers={'Origin':'https://evil.example'},status=403)
        self.json_request('/api/account/room-start-player',dict(roomId=rid),user=1,
            headers={'X-Sundoll-Expected-Account':owner},status=409)
        cid=self.make_character(1)
        first,_=self.json_request('/api/account/room-start-player',
            dict(roomId=rid,accountId=owner,characterId=cid),user=1)
        repeat,_=self.json_request('/api/account/room-start-player',dict(roomId=rid,characterId=cid),user=1)
        self.assertEqual(first,repeat)
        self.assertEqual(first['character']['accountId'],member)
        owner_state,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid))
        self.assertEqual(owner_state['player']['state'],'unbound')
        self.assertEqual(len(owner_state['migration']['profiles']),1)
        self.assertEqual(len(owner_state['migration']['members']),2)

    def test_onboarding_never_exposes_owner_migration_details_to_a_guest_dm(self):
        rid=self.room['id'];self.join_member(rid,role='dm')
        self.seed_legacy('隐私旧档案',rid)
        owner,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid))
        self.assertIn('migration',owner)
        for field in ('campaigns','profiles','members','sources'):
            self.assertIn(field,owner['migration'])
        guest,_=self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=1)
        self.assertNotIn('migration',guest)
        self.assertNotIn('隐私旧档案',json.dumps(guest,ensure_ascii=False))
        self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=2,status=404)
        self.json_request('/api/account/room-onboarding',dict(roomId=rid),user=None,status=401)


# Reuse setup/request helpers without collecting their existing tests again.
for name in dir(CampaignRoomHttpTests):
    if name.startswith('test_') and name not in AccountRoomIntegrationTests.__dict__:
        setattr(AccountRoomIntegrationTests,name,None)
del CampaignRoomHttpTests


if __name__=='__main__': unittest.main()
