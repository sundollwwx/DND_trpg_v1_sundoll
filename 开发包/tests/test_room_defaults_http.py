"""Exercise new-room default rules through the real isolated worker gateway."""
from test_campaign_rooms import CampaignRoomHttpTests


class RoomDefaultsHttpTests(CampaignRoomHttpTests):
    def test_new_room_daily_life_defaults_work_without_legacy_workspace(self):
        rid = self.room['id']
        prefix = '/rooms/'+rid+'/api/daily-life/'
        for kind in ('menus', 'climate', 'lifestyle', 'flavor', 'fishing-tables'):
            status, body, _ = self.request(prefix+kind)
            self.assertEqual(status, 200, body)
        invitation = self.rooms.invite(self.tokens[0], rid, 'u1@example.com', 'player')
        self.rooms.accept(self.tokens[1], invitation)
        for kind in ('menus', 'climate'):
            status, body, _ = self.request(prefix+kind, user=1)
            self.assertEqual(status, 200, body)
        status, body, _ = self.request(prefix+'lifestyle', user=1)
        self.assertEqual(status, 403, body)
        directory = self.accounts.root.parent/'战役空间'/rid
        self.assertTrue((directory/'通用包/日常小事/模块.json').is_file())
        self.assertFalse((directory/'运行数据/新房间初始化.json').exists())
        # Existing room data belongs to its owner. Restart must not reinstall a
        # deliberately removed module from the application's default files.
        module = directory/'通用包/日常小事'
        (module/'模块.json').unlink()
        self.accounts._supervisor.close()
        status, body, _ = self.request(prefix+'menus')
        self.assertEqual(status, 503, body)
        self.assertFalse((module/'模块.json').exists())


for _name in dir(CampaignRoomHttpTests):
    if _name.startswith('test_'):
        setattr(RoomDefaultsHttpTests, _name, None)
del CampaignRoomHttpTests
