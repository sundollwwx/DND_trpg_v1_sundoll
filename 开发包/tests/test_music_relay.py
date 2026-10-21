import base64
import http.client
import json
import time
import unittest
from unittest import mock
import test_http_concurrency as concurrency
SERVER = concurrency.SERVER
from server.music_relay import MusicRelay


class RelayBufferTests(unittest.TestCase):
    def packet(self, ident, seq):
        return {'action': 'chunk', 'id': ident, 'seq': seq, 'rate': 48000,
                'pcm': base64.b64encode(bytes(96000)).decode()}

    def test_bounded_buffer_and_late_join(self):
        relay = MusicRelay(); ident = relay.write({'action': 'start'})['id']
        for n in range(1, 21): relay.write(self.packet(ident, n))
        self.assertEqual(len(relay.packets), 12)
        self.assertEqual([p['seq'] for p in relay.read(ident)['packets']], [19, 20])
        self.assertEqual([p['seq'] for p in relay.read(ident, 18)['packets']], [19, 20])
        self.assertTrue(relay.read(ident, 1)['reset'])

    def test_old_stream_cannot_write_or_stop_new_stream(self):
        relay = MusicRelay(); first = relay.write({'action': 'start'})['id']
        second = relay.write({'action': 'start'})['id']
        with self.assertRaises(ValueError): relay.write(self.packet(first, 1))
        with self.assertRaises(ValueError): relay.write({'action': 'stop', 'id': first})
        relay.write(self.packet(second, 1))
        self.assertTrue(relay.read(second)['active'])
        relay.write({'action': 'stop', 'id': second})
        self.assertFalse(relay.read(second)['active'])

    def test_expiry_and_invalid_packets(self):
        now = [0]; relay = MusicRelay(lambda: now[0]); ident = relay.write({'action': 'start'})['id']
        for patch in [{'seq': 2}, {'pcm': '??'}, {'pcm': 'AA=='}, {'rate': 3}, {'pcm': 'A'*128004}]:
            with self.assertRaises(ValueError): relay.write({**self.packet(ident, 1), **patch})
        now[0] = 13
        self.assertFalse(relay.read(ident)['active'])
        self.assertEqual(len(relay.packets), 0)


class RelayHttpTests(unittest.TestCase):
    setUp = concurrency.HttpConcurrencyTests.setUp
    close_server = concurrency.HttpConcurrencyTests.close_server

    def request(self, method='GET', data=None, suffix='', headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=4)
        c.request(method, '/api/music-live'+suffix, body=json.dumps(data) if data is not None else None,
                  headers={'Content-Type':'application/json', **(headers or {})})
        r=c.getresponse(); status=r.status; hdr=dict(r.getheaders()); body=r.read();c.close()
        return status,hdr,json.loads(body)

    def test_authorization_and_no_cache(self):
        with mock.patch.object(SERVER, 'MUSIC_RELAY', MusicRelay()), mock.patch.object(SERVER, 'PORT', self.port):
            status,_,start=self.request('POST', {'action':'start'})
            self.assertEqual(status,200)
            ident=start['id']
            self.assertEqual(self.request(headers={'Host':'public.example'})[0],401)
            self.assertEqual(self.request('POST',{'action':'stop','id':ident},headers={'Host':'public.example'})[0],403)
            token='test-relay-player'
            with mock.patch.dict(SERVER.SESSIONS,{token:{'playerId':'p','lastSeen':int(time.time()*1000)}}):
                status,headers,result=self.request(suffix='?id='+ident,headers={'Host':'public.example','X-Sundoll-Session':token})
                self.assertEqual(status,200);self.assertTrue(result['active'])
                self.assertIn('no-store',headers['Cache-Control'])
            self.assertEqual(self.request(suffix='?after=oops')[0],400)
            self.assertEqual(self.request('POST',{'action':'chunk','id':ident,'pcm':'bad'})[0],400)
