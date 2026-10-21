from pathlib import Path
from test_campaign_rooms import CampaignRoomTests
from server import player_profiles
from server.email_accounts import AccountError


class RoomOnboardingTests(CampaignRoomTests):
    def setUp(self):
        super().setUp()
        self.store=player_profiles.Store(self.root/'profiles',self.root/'app',self.root/'cache')
        invitation=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','player')
        self.rooms.accept(self.tokens[1],invitation)
        self.member=self.accounts.session(self.tokens[1])['accountId']

    def test_waiting_does_not_create_or_guess_a_same_name_legacy_profile(self):
        legacy=self.store.create('用户1')['profile']
        for _ in range(2):
            self.assertEqual(self.rooms.onboarding(self.tokens[1],self.room['id'],self.store),dict(state='unbound',profile=None))
            self.assertStatus(409,lambda:self.rooms.player(self.tokens[1],self.room['id'],self.store))
        self.assertEqual(self.store.players(),[legacy])
        self.assertNotIn('accountId',self.store.read(legacy['playerId']))

    def test_explicit_new_choice_is_idempotent_and_never_claims_the_old_name(self):
        legacy=self.store.create('用户1')['profile']
        fresh=self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)
        self.assertNotEqual(fresh['playerId'],legacy['playerId'])
        self.assertEqual(fresh['accountId'],self.member)
        self.assertEqual(self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)['playerId'],fresh['playerId'])
        self.assertEqual(self.rooms.onboarding(self.tokens[1],self.room['id'],self.store)['state'],'ready')
        self.assertEqual(len(self.store.players()),2)
        self.assertNotIn('accountId',self.store.read(legacy['playerId']))

    def test_waiting_then_owner_binding_keeps_original_identity_and_collection(self):
        legacy=self.store.create('旧玩家')['profile'];pid=legacy['playerId']
        library=self.store.grant(pid,dict(name='原角色',hpMax=20,ac=14),'migration-character-test')
        self.assertStatus(409,lambda:self.rooms.player(self.tokens[1],self.room['id'],self.store))
        self.rooms.bind_player(self.tokens[0],self.room['id'],self.member,pid,self.store)
        profile=self.rooms.player(self.tokens[1],self.room['id'],self.store)
        self.assertEqual(profile['playerId'],pid)
        self.assertEqual(self.store.library(pid),library)
        state=self.rooms.onboarding(self.tokens[1],self.room['id'],self.store)
        self.assertEqual(state['state'],'ready');self.assertNotIn('_authVersion',state['profile'])

    def test_removal_and_reinvitation_restore_the_same_bound_profile(self):
        profile=self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)
        pid=profile['playerId']
        library=self.store.grant(pid,dict(name='保留的角色',hpMax=20,ac=14),'retained-role-test')
        self.rooms.change(self.tokens[0],self.room['id'],self.member,'remove')
        self.assertStatus(404,lambda:self.rooms.onboarding(self.tokens[1],self.room['id'],self.store))
        self.assertEqual(self.store.read(pid)['accountId'],self.member)
        invitation=self.rooms.invite(self.tokens[0],self.room['id'],'u1@example.com','dm')
        self.rooms.accept(self.tokens[1],invitation)
        self.assertEqual(self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)['playerId'],pid)
        self.assertEqual(self.store.library(pid),library)
        self.assertEqual(len(self.store.players()),1)

    def test_one_account_has_independent_profiles_in_different_rooms(self):
        first=self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)
        second=self.rooms.create(self.tokens[1],'我主持的另一个房间')
        other=player_profiles.Store(self.root/'other-profiles',self.root/'app',self.root/'other-cache')
        new=self.rooms.player(self.tokens[1],second['id'],other,create=True)
        self.assertEqual(first['accountId'],new['accountId'])
        self.assertNotEqual(first['playerId'],new['playerId'])
        self.assertEqual(self.rooms.access(self.room['id'],token=self.tokens[1])['role'],'player')
        self.assertEqual(self.rooms.access(second['id'],token=self.tokens[1])['role'],'owner')

    def test_bound_profile_cannot_be_reassigned_to_another_account(self):
        profile=self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)
        owner=self.accounts.session(self.tokens[0])['accountId']
        self.assertStatus(409,lambda:self.rooms.bind_player(self.tokens[0],self.room['id'],owner,profile['playerId'],self.store))
        self.assertEqual(self.store.read(profile['playerId'])['accountId'],self.member)

    def test_disabled_duplicate_or_removed_identity_cannot_be_replaced_by_new_choice(self):
        profile=self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True)
        from server.player_profiles import atomic
        atomic(self.store.path(profile['playerId'],'当前档案.json'),dict(self.store.read(profile['playerId']),enabled=False))
        self.assertEqual(self.rooms.onboarding(self.tokens[1],self.room['id'],self.store)['state'],'disabled')
        self.assertStatus(403,lambda:self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True))
        self.store.create('重复关联',account_id=self.member)
        self.assertStatus(503,lambda:self.rooms.onboarding(self.tokens[1],self.room['id'],self.store))
        self.rooms.change(self.tokens[0],self.room['id'],self.member,'remove')
        self.assertStatus(404,lambda:self.rooms.player(self.tokens[1],self.room['id'],self.store,create=True))


for name in ('test_roles_are_per_room_and_invitation_is_email_bound_single_use','test_only_owner_can_manage_and_owner_cannot_be_removed','test_removal_and_logout_revoke_access',
             'test_removal_revokes_unconsumed_invitation_and_new_invite_restores_access'):
    setattr(RoomOnboardingTests,name,None)
del CampaignRoomTests
