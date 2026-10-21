import http.client
import io
from unittest import mock
import test_player_profiles as fixtures
from server.module_store import ModuleStore
from server import media_variants

SERVER = fixtures.SERVER


class MediaHttpTests(fixtures.PlayerProfileHttpTests):
    def get_media(self, path, headers=None, method='GET'):
        connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        connection.request(method,path,headers=headers or {})
        response=connection.getresponse(); data=response.read(); result=(response.status,dict(response.getheaders()),data)
        connection.close();return result

    def test_private_revalidation_requires_permission_even_with_matching_etag(self):
        raw=b'\x89PNG-not-real-for-original-cache-test'
        url=ModuleStore(self.save).put_asset(raw,'image/png','campaign')
        state=dict(maps=[dict(playerAccessible=True,mapData=url,tokens=[])])
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False),mock.patch.object(SERVER,'STATE',state):
            status,headers,data=self.get_media(url)
            self.assertEqual((status,data),(200,raw));self.assertIn('private',headers['Cache-Control']);self.assertIn('no-cache',headers['Cache-Control'])
            conditional={'If-None-Match':headers['ETag']}
            self.assertEqual(self.get_media(url,conditional)[::2],(304,b''))
            state['maps'][0]['playerAccessible']=False
            self.assertEqual(self.get_media(url,conditional)[0],404)
            self.assertEqual(self.get_media(url+'?variant=token-512',conditional)[0],404)

    def test_display_get_head_and_invalid_variant(self):
        if media_variants.Image is None:self.skipTest('Pillow unavailable')
        out=io.BytesIO();media_variants.Image.new('RGBA',(1200,800),(40,70,90,100)).save(out,'PNG',compress_level=0)
        raw=out.getvalue();url=ModuleStore(self.save).put_asset(raw,'image/png','campaign')
        state=dict(maps=[dict(playerAccessible=True,mapData=url,tokens=[])])
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False),mock.patch.object(SERVER,'STATE',state):
            status,headers,data=self.get_media(url+'?variant=token-512')
            self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'image/webp');self.assertLess(len(data),len(raw)//10)
            with media_variants.Image.open(io.BytesIO(data)) as image:self.assertEqual(image.width,512)
            hstatus,hheaders,hdata=self.get_media(url+'?variant=token-512',method='HEAD')
            self.assertEqual(hstatus,200);self.assertEqual(hheaders['ETag'],headers['ETag']);self.assertEqual(hdata,b'')
            self.assertEqual(self.get_media(url+'?variant=map',{'If-None-Match':headers['ETag']})[0],200)
            self.assertEqual(self.get_media(url+'?variant=bogus')[0],400)
            self.assertEqual(self.get_media(url)[2],raw)


for name in dir(fixtures.PlayerProfileHttpTests):
    if name.startswith('test_'):setattr(MediaHttpTests,name,None)
