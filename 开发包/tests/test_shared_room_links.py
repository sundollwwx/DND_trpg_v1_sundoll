from test_campaign_rooms import CampaignRoomTests


class SharedRoomLinkTests(CampaignRoomTests):
    def test_shared_link_joins_as_player_and_cannot_downgrade_owner_or_dm(self):
        link=self.rooms.share(self.tokens[0],self.room['id'])
        self.assertEqual(self.rooms.join(self.tokens[1],link['token'])['role'],'player')
        self.assertEqual(self.rooms.join(self.tokens[0],link['token'])['role'],'owner')
        invite=self.rooms.invite(self.tokens[0],self.room['id'],'u2@example.com','dm')
        self.rooms.accept(self.tokens[2],invite)
        self.assertEqual(self.rooms.join(self.tokens[2],link['token'])['role'],'dm')

    def test_only_owner_can_share_reissue_revoke_and_expiry(self):
        first=self.rooms.share(self.tokens[0],self.room['id'])
        self.rooms.join(self.tokens[1],first['token'])
        self.assertStatus(403,lambda:self.rooms.share(self.tokens[1],self.room['id']))
        second=self.rooms.share(self.tokens[0],self.room['id'])
        self.assertStatus(400,lambda:self.rooms.join(self.tokens[2],first['token']))
        self.rooms.revoke_share(self.tokens[0],self.room['id'])
        self.assertStatus(400,lambda:self.rooms.join(self.tokens[2],second['token']))
        third=self.rooms.share(self.tokens[0],self.room['id'])
        with self.accounts.db() as db:
            db.execute('UPDATE room_share_links SET expires=?', (self.accounts.clock()-1,))
        self.assertStatus(400,lambda:self.rooms.join(self.tokens[2],third['token']))

    def test_removed_member_cannot_rejoin_until_owner_explicitly_invites(self):
        link=self.rooms.share(self.tokens[0],self.room['id'])
        joined=self.rooms.join(self.tokens[1],link['token'])
        aid=self.accounts.session(self.tokens[1])['accountId']
        self.rooms.change(self.tokens[0],joined['id'],aid,'remove')
        self.assertStatus(403,lambda:self.rooms.join(self.tokens[1],link['token']))
        invite=self.rooms.invite(self.tokens[0],joined['id'],'u1@example.com','player')
        self.assertEqual(self.rooms.accept(self.tokens[1],invite)['role'],'player')
        self.assertEqual(self.rooms.join(self.tokens[1],link['token'])['role'],'player')
