import json
import unittest
from test_campaign_rooms import CampaignRoomHttpTests as Base


class GlobalCharacterHttpTests(Base):
    setUp=Base.setUp
    close=Base.close
    request=Base.request
    assertStatus=Base.assertStatus
    def call(self,path,data=None,user=0):
        code,raw,_=self.request(path,data,user=user)
        value=json.loads(raw)
        self.assertEqual(code,200,(path,code,value))
        return value

    def test_two_room_http_create_select_use_and_revoke(self):
        cid=self.call('/api/account/character-create',dict(name='旅行者',requestId='http-new-character-001'))['character']['characterId']
        room=self.room['id'];prefix='/rooms/'+room
        self.call('/api/account/room-start-player',dict(roomId=room,characterId=cid))
        session=self.call(prefix+'/api/account/player-session',{})['session']
        pid=session['playerId']
        listing=self.call(prefix+'/api/player-profiles',dict(op='get',playerId=pid,sessionToken=session['sessionToken']))
        self.assertEqual(listing['library']['pieces'][0]['ownedPieceId'],cid)
        second=self.call('/api/account/room-create',dict(name='第二间'))['room']['id']
        self.call('/api/account/room-start-player',dict(roomId=second,characterId=cid,expectedRoomId=room))
        second_session=self.call('/rooms/'+second+'/api/account/player-session',{})['session']
        self.assertEqual(second_session['playerId'],pid)
        self.assertEqual(self.call('/api/account/characters')['characters'][0]['activeRoomId'],second)
        code,raw,_=self.request('/api/account/room-start-player',dict(roomId=room,characterId=cid),user=0)
        self.assertEqual(code,409,raw)
        # Foreign accounts cannot select another account's character even in their own room.
        foreign=self.call('/api/account/room-create',dict(name='别人的房间'),user=1)['room']['id']
        code,raw,_=self.request('/api/account/room-start-player',dict(roomId=foreign,characterId=cid,expectedRoomId=second),user=1)
        self.assertEqual(code,404,raw)

    def test_member_removal_preserves_character_but_revokes_room(self):
        cid=self.call('/api/account/character-create',dict(name='朋友',requestId='friend-character-001'),user=1)['character']['characterId']
        invitation=self.rooms.share(self.tokens[0],self.room['id'])['token']
        self.rooms.join(self.tokens[1],invitation)
        self.call('/api/account/room-start-player',dict(roomId=self.room['id'],characterId=cid),user=1)
        member=self.accounts.session(self.tokens[1])['accountId']
        self.call('/api/account/room-member',dict(roomId=self.room['id'],accountId=member,role='remove'))
        self.assertEqual(self.call('/api/account/characters',user=1)['characters'][0]['characterId'],cid)
        listing=self.call('/rooms/'+self.room['id']+'/api/player-profiles',dict(op='list'))
        self.assertEqual(listing['players'],[])

def load_tests(loader, tests, pattern):
    return unittest.TestSuite(GlobalCharacterHttpTests(name) for name in GlobalCharacterHttpTests.__dict__ if name.startswith('test_'))

if __name__=='__main__':unittest.main()
