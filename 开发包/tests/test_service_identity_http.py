"""Public tunnel readiness identity must stay separate from private room data."""
import http.client
import json
import unittest
from unittest import mock

from test_campaign_rooms import CampaignRoomHttpTests, SERVER
from server.web_entrances import WebEntrances


class ServiceIdentityHttpTests(CampaignRoomHttpTests):
    def public_request(self, method='GET', host='pl.example.com', path='/api/service-info'):
        connection=http.client.HTTPConnection('127.0.0.1',self.httpd.server_port,timeout=5)
        headers={'Host':host,'X-Forwarded-Proto':'https'}
        body=None
        if method=='POST':
            body=b'{}'
            headers.update({'Origin':'https://'+host,'Content-Type':'application/json'})
        connection.request(method,path,body,headers)
        response=connection.getresponse()
        data=response.read();result=response.status,dict(response.getheaders()),data
        connection.close()
        return result

    def test_anonymous_service_identity_is_available_before_room_and_dm_gates(self):
        portal=WebEntrances({'webEntrances':{'playerHostname':'pl.example.com',
            'dmHostname':'dm.example.com','mainHostname':'main.example.com'}},self.root)
        with mock.patch.object(SERVER,'WEB_ENTRANCES',portal), \
                mock.patch.object(SERVER,'host_request_allowed',return_value=False):
            reference=None
            for host in ('pl.example.com','dm.example.com','main.example.com'):
                status,headers,body=self.public_request(host=host)
                self.assertEqual(status,200,(host,body))
                result=json.loads(body)
                self.assertEqual(set(result),{'ok','projectId','sessionId','protocolVersion'})
                self.assertIs(result['ok'],True)
                self.assertRegex(result['projectId'],r'^[0-9a-f]{64}$')
                self.assertEqual(result['sessionId'],SERVER.SESSION_ID)
                self.assertEqual(result['protocolVersion'],SERVER.SERVER_PROTOCOL_VERSION)
                self.assertNotIn('Set-Cookie',headers)
                if reference is None: reference=result
                else: self.assertEqual(result,reference)
            self.assertFalse(getattr(self.accounts,'_supervisor',None))

    def test_public_head_has_the_same_identity_headers_and_no_body(self):
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False):
            get_status,get_headers,get_body=self.public_request()
            head_status,head_headers,head_body=self.public_request(method='HEAD')
            self.assertEqual((get_status,head_status),(200,200))
            self.assertEqual(head_body,b'')
            self.assertEqual(int(head_headers['Content-Length']),len(get_body))
            self.assertEqual(head_headers['Content-Type'],get_headers['Content-Type'])
            self.assertNotIn('Set-Cookie',head_headers)

    def test_public_identity_does_not_serialize_campaign_players_or_authentication(self):
        sensitive='private-synthetic-campaign-value'
        fake_state=dict(campaignId='c-private',campaignName=sensitive,maps=[{'id':'private-map'}])
        fake_sessions={'private-session-token':dict(playerId='p-private',name='private-player-name')}
        with mock.patch.object(SERVER,'STATE',fake_state), \
                mock.patch.object(SERVER,'SESSIONS',fake_sessions), \
                mock.patch.object(SERVER,'ROOM_CODE','PRIVATE-ROOM-CODE'), \
                mock.patch.object(SERVER,'host_request_allowed',return_value=False):
            status,headers,body=self.public_request()
            self.assertEqual(status,200,body)
            result=json.loads(body)
            self.assertEqual(set(result),{'ok','projectId','sessionId','protocolVersion'})
            for private in (sensitive,'c-private','private-map','private-session-token',
                    'p-private','private-player-name','PRIVATE-ROOM-CODE'):
                self.assertNotIn(private,body.decode())
            for private_key in ('campaignId','campaignName','players','playerCount','roomCode',
                    'authentication','state','stateRevision','publicBase','ips','bind','port'):
                self.assertNotIn(private_key,result)
            self.assertNotIn('Set-Cookie',headers)

    def test_new_public_readiness_route_does_not_open_private_data_or_post_operations(self):
        with mock.patch.object(SERVER,'host_request_allowed',return_value=False):
            self.assertEqual(self.public_request()[0],200)
            for route in ('/api/info','/api/state','/api/players','/api/health'):
                self.assertEqual(self.public_request(path=route)[0],403,route)
            self.assertIn(self.public_request(method='POST')[0],(403,404,405))
            self.assertFalse(getattr(self.accounts,'_supervisor',None))


for name in dir(CampaignRoomHttpTests):
    if name.startswith('test_') and name not in ServiceIdentityHttpTests.__dict__:
        setattr(ServiceIdentityHttpTests,name,None)
del CampaignRoomHttpTests


if __name__=='__main__':
    unittest.main()
