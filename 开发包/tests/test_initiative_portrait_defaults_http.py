import json
import re
from test_campaign_rooms import CampaignRoomHttpTests
from server.initiative_portrait_defaults import CONFIG_NAME, ELEMENT_ID
from server.module_store import ModuleStore


class InitiativePortraitDefaultsHttpTests(CampaignRoomHttpTests):
    def test_private_defaults_are_injected_only_into_the_authorized_rooms_dm_page(self):
        rid = self.room['id']
        self.assertEqual(self.request('/rooms/'+rid+'/api/info')[0], 200)
        directory = self.accounts.root.parent/'战役空间'/rid
        save = directory/'运行数据/存档'
        asset = ModuleStore(save).put_asset(b'isolated portrait bytes', 'image/png', 'synthetic-default')
        defaults = dict(owned={'synthetic-owned':asset}, presets={'synthetic-preset':asset})
        (save.parent/CONFIG_NAME).write_text(json.dumps(dict(defaults, version=1)))
        code, body, headers = self.request('/rooms/'+rid+'/主控台/主控台.html')
        self.assertEqual(code, 200, body)
        match = re.search('<script type="application/json" id="'+ELEMENT_ID+'">(.*?)</script>', body.decode())
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match[1]), defaults)
        self.assertLess(body.index(ELEMENT_ID.encode()), body.index(b'host/initiative-portrait-defaults.js'))
        self.assertIn('no-store', ','.join(value for key,value in headers if key.lower()=='cache-control'))
        self.assertEqual(self.request('/rooms/'+rid+asset)[0], 200)
        code, body, _ = self.request(asset, headers={
            'Referer':'https://pl.example.com/rooms/'+rid+'/主控台/主控台.html'})
        self.assertEqual((code, body), (200, b'isolated portrait bytes'))
        invitation = self.rooms.invite(self.tokens[0], rid, 'u1@example.com', 'player')
        self.rooms.accept(self.tokens[1], invitation)
        self.assertEqual(self.request('/rooms/'+rid+'/主控台/主控台.html', user=1)[0], 404)
        self.assertNotIn(ELEMENT_ID.encode(), self.request('/rooms/'+rid+'/主控台/玩家.html', user=1)[1])
        self.assertEqual(self.request('/rooms/'+rid+'/主控台/主控台.html', user=2)[0], 404)
        self.assertEqual(self.request('/rooms/'+rid+'/运行数据/'+CONFIG_NAME)[0], 404)
        other = self.rooms.create(self.tokens[2], '没有私有默认的房间')['id']
        code, body, _ = self.request('/rooms/'+other+'/主控台/主控台.html', user=2)
        self.assertEqual(code, 200, body)
        self.assertNotIn(b'synthetic-owned', body)
        self.assertNotIn(asset.encode(), body)
        self.assertEqual(self.request(asset, user=2, headers={
            'Referer':'https://pl.example.com/rooms/'+other+'/主控台/主控台.html'})[0], 404)


def load_tests(loader, tests, pattern):
    import unittest
    return unittest.TestSuite(InitiativePortraitDefaultsHttpTests(name)
        for name in InitiativePortraitDefaultsHttpTests.__dict__ if name.startswith('test_'))
