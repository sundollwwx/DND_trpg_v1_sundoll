import json
import http.client
from unittest import mock
from test_player_profiles import PlayerProfileHttpTests, SERVER
from server.module_store import ModuleStore
from server.module_runtime import ModuleRuntime


class ModuleHttpTests(PlayerProfileHttpTests):
    def test_private_media_owner_public_reveal_and_revocation(self):
        store = SERVER.profile_store()
        assets = ModuleStore(self.save)
        own = assets.put_asset(b'\x89PNG-owner', 'image/png', 'owner')
        hidden = assets.put_asset(b'\x89PNG-hidden', 'image/png', 'campaign')
        piece = store.grant(self.pid, dict(name='独立角色',iconImgPath=own), 'media-owner-grant')['pieces'][0]
        login = self.login()
        cookie = {'Cookie':'sundoll-media-session='+login}
        # A remote request is proxied from loopback in these isolated HTTP tests.
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False), mock.patch.object(SERVER,'STATE',None):
            self.assertEqual(self.request(method='GET',path=own)[0],404)
            self.assertEqual(self.request(method='GET',path=own,extra=cookie)[0],200)
            self.assertEqual(self.request(method='GET',path=hidden,extra=cookie)[0],404)
            # Notes are not media grants.
            lib=store.library(self.pid)
            store.edit(self.pid,piece['ownedPieceId'],lib['revision'],{'publicNote':hidden},piece['revision'],host=True)
            self.assertEqual(self.request(method='GET',path=hidden,extra=cookie)[0],404)
            state=dict(maps=[dict(playerAccessible=False,mapData=hidden,tokens=[])])
            with mock.patch.object(SERVER,'STATE',state):
                self.assertEqual(self.request(method='GET',path=hidden)[0],404)
                state['maps'][0]['playerAccessible']=True
                self.assertEqual(self.request(method='GET',path=hidden)[0],200)
            store.delete(self.pid)
            self.assertEqual(self.request(method='GET',path=own,extra=cookie)[0],404)

    def test_current_campaign_cover_is_public_but_other_assets_stay_private(self):
        path='/api/assets/'+'a'*64
        other='/api/assets/'+'b'*64
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False), mock.patch.object(SERVER,'STATE',dict(maps=[])), mock.patch.object(SERVER,'campaign_cover_asset_url',return_value=path), mock.patch.object(SERVER,'load_disk_asset',return_value=('image/png',b'cover')):
            self.assertEqual(self.request(method='GET',path=path)[0],200)
            self.assertEqual(self.request(method='GET',path=other)[0],404)
            with mock.patch.object(SERVER,'campaign_cover_asset_url',return_value=other):
                self.assertEqual(self.request(method='GET',path=path)[0],404)

    def test_session_login_and_resume_issue_http_only_media_cookie(self):
        token=self.login()
        for body in ({'credential':self.created['credential']},{'sessionToken':token}):
            connection=http.client.HTTPConnection('127.0.0.1',self.port)
            connection.request('POST','/api/session',json.dumps(body),{'Content-Type':'application/json'})
            response=connection.getresponse(); response.read()
            cookie=response.getheader('Set-Cookie')
            self.assertEqual(response.status,200)
            self.assertIn('HttpOnly',cookie);self.assertIn('SameSite=Strict',cookie);self.assertIn('Path=/',cookie)
            connection.close()

    def test_modular_save_rejects_old_client_before_write(self):
        # Activate a separate fresh store: real host credentials are untouched.
        empty=self.root/'empty'
        ModuleRuntime(empty,self.root).ensure_empty_runtime()
        with mock.patch.object(SERVER,'LOCAL_SAVE_ROOT',str(empty)):
            body=dict(op='write',path='棋子库/棋子库.json',text='{}')
            code,_=self.request(body,host=True,path='/api/local-save')
            self.assertEqual(code,409)
            self.assertFalse((empty/'棋子库/棋子库.json').exists())
            body['protocolVersion']=SERVER.SERVER_PROTOCOL_VERSION
            self.assertEqual(self.request(body,host=True,path='/api/local-save')[0],200)

    def test_legacy_media_does_not_bypass_reveal_boundary(self):
        key='f'*64
        path='/api/assets/'+key
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False), mock.patch.object(SERVER,'STATE',None), mock.patch.object(SERVER,'load_disk_asset',return_value=('image/png',b'old-map')):
            self.assertEqual(self.request(method='GET',path=path)[0],404)
            with mock.patch.object(SERVER,'STATE',dict(maps=[dict(playerAccessible=True,mapData=path,tokens=[])])):
                self.assertEqual(self.request(method='GET',path=path)[0],200)


for name in dir(PlayerProfileHttpTests):
    if name.startswith('test_'): setattr(ModuleHttpTests,name,None)
# Do not collect the imported legacy class a second time.
del PlayerProfileHttpTests
