"""Regression cases for ownership transitions, stale writes, and retry safety."""
import json
import sqlite3
import unittest
from project_test_paths import APP_ROOT
from test_account_characters import AccountCharactersTests
from test_campaign_rooms import CampaignRoomTests
from server.account_characters import Characters, central_root
from server import player_profiles as profiles
from server.module_runtime import ModuleRuntime
from server.module_store import encode
from server.email_accounts import AccountError


class CharacterLogicTests(AccountCharactersTests):
    def test_editing_notes_keeps_the_full_name_created_on_dashboard(self):
        name='雾港的守灯人与穿越群山的旅者'*3
        cid=self.registry.create(self.a,'甲',name,'long-character-name-001')['characterId']
        self.registry.select(self.a,self.r1,cid,None)
        lib=self.p1.library(self.pid);piece=next(p for p in lib['pieces'] if p['ownedPieceId']==cid)
        updated=self.p1.edit(self.pid,cid,lib['revision'],{'publicNote':'只改公开资料'},piece['revision'])
        self.assertEqual(next(p for p in updated['pieces'] if p['ownedPieceId']==cid)['name'],name)
        self.assertEqual(next(p for p in self.registry.mine(self.a) if p['characterId']==cid)['name'],name)

    def test_reentering_same_character_is_a_read_not_a_write(self):
        before=self.res1.ledger()['revision']
        self.registry.select(self.a,self.r1,self.hero,None)
        self.assertEqual(self.res1.ledger()['revision'],before)

    def test_detached_character_rejects_old_switch_confirmation(self):
        self.registry.detach(self.r1,self.a)
        with self.assertRaises(AccountError):self.registry.select(self.a,self.r2,self.hero,self.r1)
        self.registry.select(self.a,self.r2,self.hero,None)

    def test_stale_sheet_cannot_revert_concurrent_runtime_base(self):
        lib=self.p1.library(self.pid)
        lib['pieces'][0]['name']='我的草稿'
        current=self.res1.ledger();runtime=current['characters']['@global'][self.hero]
        runtime['base']['hpMax']=20;runtime['runtime']['hp']=10;runtime['revision']+=1
        self.res1.save(current)
        with self.assertRaises(profiles.ProfileError):self.p1.commit_library(self.pid,lib)
        saved=self.res1.ledger()['characters']['@global'][self.hero]
        self.assertEqual(saved['base']['hpMax'],20);self.assertEqual(saved['runtime']['hp'],10)
        self.assertEqual(saved['name'],'老角色')

    def test_interleaved_room_history_noop_does_not_reorder_or_write(self):
        second=self.registry.create(self.a,'甲','另一个角色','separate-history-001')['characterId']
        self.registry.select(self.a,self.r2,second,None)
        history=[dict(id='event-history-0001',characterId=self.hero,name='甲',at=1),dict(id='event-history-0002',characterId=second,name='乙',at=2),dict(id='event-history-0003',characterId=self.hero,name='甲',at=3)]
        with self.registry.transaction() as db:
            meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(self.pid,)).fetchone()[0]);meta['history']=history
            db.execute('UPDATE carriers SET metadata=? WHERE id=?',(encode(meta),self.pid))
        before=self.res1.ledger()['revision']
        for resource in (self.res1,self.res2,self.res1):resource.save(resource.ledger())
        self.assertEqual(self.res1.ledger()['revision'],before)
        with self.registry.connect() as db:self.assertEqual(json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(self.pid,)).fetchone()[0])['history'],history)

    def test_transfer_send_receive_history_keeps_both_sides_and_order(self):
        history=[dict(id='same-transfer-0001',op='transfer',characterId=self.hero,name='转出',at=1),dict(id='same-transfer-0001',op='receive',characterId=self.hero,name='收到',at=1)]
        with self.registry.transaction() as db:
            meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(self.pid,)).fetchone()[0]);meta['history']=history
            db.execute('UPDATE carriers SET metadata=? WHERE id=?',(encode(meta),self.pid))
        before=self.res1.ledger()['revision']
        self.res1.save(self.res1.ledger())
        self.assertEqual(self.res1.ledger()['revision'],before)
        self.assertEqual(self.res1.ledger()['backpacks'][self.pid]['history'],history)

    def test_claimed_character_history_leaves_previous_carrier_view(self):
        legacy=self.root/'legacy';ModuleRuntime(legacy,APP_ROOT).ensure_empty_runtime()
        p=profiles.Store(legacy,APP_ROOT,self.root/'cache')
        pid=p.create('旧玩家')['profile']['playerId']
        for n in (1,2):p.grant(pid,dict(name='旧角色'+str(n),type='pc',hpMax=12,ac=13,level=2),'legacy-claim-request-0'+str(n))
        rid='r'+'3'*32;self.registry.migrate(rid,p)
        cid=p.library(pid)['pieces'][0]['ownedPieceId']
        event=dict(id='same-request-00001',op='wallet',characterId=cid,name='旧角色的金币',delta=1,at=1)
        with self.registry.transaction() as db:
            for carrier,ev in ((pid,event),(self.pid,dict(event,characterId=self.hero,name='自己的金币'))):
                meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(carrier,)).fetchone()[0])
                meta['history']=[ev];meta['receipts']={ev['id']:dict(signature=carrier,event=ev)}
                if carrier==pid:meta['revision']=40;meta['libraryRevision']=30
                db.execute('UPDATE carriers SET metadata=? WHERE id=?',(encode(meta),carrier))
        self.registry.bind(rid,cid,self.a,'甲','owner')
        from server.account_characters import configure,_CONFIG
        from server.resources import ResourceStore
        configure(legacy,self.registry.root,rid);self.addCleanup(_CONFIG.pop,str(legacy.resolve()),None)
        new_profiles=profiles.Store(legacy,APP_ROOT,self.root/'cache')
        data=ResourceStore(new_profiles,profiles).ledger()
        self.assertEqual(data['backpacks'][pid]['history'],[])
        with self.registry.connect() as db:
            meta=json.loads(db.execute('SELECT metadata FROM carriers WHERE id=?',(self.pid,)).fetchone()[0])
        self.assertEqual(len(meta['history']),2)
        self.assertEqual(len({e['id'] for e in meta['history']}),2)
        self.assertEqual(meta['receipts'][event['id']]['signature'],'claim-conflict')
        self.assertEqual(len(meta['claimReceiptConflicts']['current'][event['id']]),2)
        self.assertEqual(meta['revision'],41);self.assertEqual(meta['libraryRevision'],31)

    def test_database_context_releases_connection(self):
        with self.registry.connect() as db:db.execute('SELECT 1')
        with self.assertRaises(sqlite3.ProgrammingError):db.execute('SELECT 1')

    def test_disabled_character_is_consistent_in_owner_and_room_lists(self):
        with self.registry.transaction() as db:db.execute('UPDATE carriers SET enabled=0 WHERE id=?',(self.pid,))
        self.assertFalse(self.registry.room_list(self.r1)[0]['enabled'])


class MembershipLogicTests(CampaignRoomTests):
    def prepare_member(self):
        self.rooms.join(self.tokens[1],self.rooms.share(self.tokens[0],self.room['id'])['token'])
        member=self.accounts.session(self.tokens[1])['accountId']
        registry=Characters(central_root(self.accounts))
        cid=registry.create(member,'乙','成员角色','membership-character-001')['characterId']
        self.rooms.select_character(self.tokens[1],self.room['id'],registry,cid,None)
        return member,registry,cid

    def test_failed_member_removal_rolls_back_character_detachment(self):
        member,registry,cid=self.prepare_member()
        with self.accounts.db() as db:
            db.execute("CREATE TRIGGER fail_removal BEFORE INSERT ON room_join_blocks BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.rooms.change(self.tokens[0],self.room['id'],member,'remove')
        self.assertEqual(self.rooms.access(self.room['id'],token=self.tokens[1])['role'],'player')
        self.assertEqual(registry.mine(member)[0]['activeRoomId'],self.room['id'])
        self.assertEqual(registry.room_list(self.room['id'])[0]['characterId'],cid)

    def test_removed_member_cannot_reselect_after_earlier_access_check(self):
        member,registry,cid=self.prepare_member()
        self.rooms.access(self.room['id'],token=self.tokens[1])
        self.rooms.change(self.tokens[0],self.room['id'],member,'remove')
        with self.assertRaises(AccountError):self.rooms.select_character(self.tokens[1],self.room['id'],registry,cid,None)
        self.assertEqual(registry.room_list(self.room['id']),[])
        self.assertIsNone(registry.mine(member)[0]['activeRoomId'])


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(cls(name) for cls in (CharacterLogicTests,MembershipLogicTests) for name in cls.__dict__ if name.startswith('test_'))
