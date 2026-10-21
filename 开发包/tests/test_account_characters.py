from project_test_paths import APP_ROOT
import sys
sys.path.insert(0,str(APP_ROOT))
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from server import player_profiles as profiles
from server.account_characters import Characters,configure,_CONFIG
from server.module_runtime import ModuleRuntime
from server.resource_database import ResourceDatabase
from server.resources import ResourceStore
from server.module_store import ModuleStore,RevisionConflict
from server.email_accounts import AccountError


class AccountCharactersTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.a='a'+'1'*32;self.b='a'+'2'*32;self.r1='r'+'1'*32;self.r2='r'+'2'*32
        self.registry=Characters(self.root/'people')
        self.paths=[self.root/'room1',self.root/'room2']
        for path,rid in zip(self.paths,[self.r1,self.r2]):
            ModuleRuntime(path,APP_ROOT).ensure_empty_runtime()
            self.registry.migrate(rid,profiles.Store(path,APP_ROOT,self.root/'cache'))
            configure(path,self.registry.root,rid)
            self.addCleanup(_CONFIG.pop,str(path.resolve()),None)
        self.hero=self.registry.create(self.a,'甲','老角色','new-card-request-0001')['characterId']
        self.registry.select(self.a,self.r1,self.hero,None)
        self.p1=profiles.Store(self.paths[0],APP_ROOT,self.root/'cache')
        self.p2=profiles.Store(self.paths[1],APP_ROOT,self.root/'cache')
        self.pid=self.p1.players()[0]['playerId']
        self.res1=ResourceStore(self.p1,profiles);self.res2=ResourceStore(self.p2,profiles)

    def test_create_retry_does_not_duplicate(self):
        self.assertEqual(self.registry.create(self.a,'甲','老角色','new-card-request-0001')['characterId'],self.hero)
        self.assertEqual(len(self.registry.mine(self.a)),1)
        self.assertEqual(self.p1.library(self.pid)['pieces'][0]['type'],'pc')
        with self.assertRaises(AccountError):self.registry.create(self.a,'甲','其他名字','new-card-request-0001')

    def test_selection_requires_owner_and_explicit_switch(self):
        with self.assertRaises(AccountError):self.registry.select(self.b,self.r2,self.hero,self.r1)
        with self.assertRaises(AccountError):self.registry.select(self.a,self.r2,self.hero,None)
        self.registry.select(self.a,self.r2,self.hero,self.r1)
        self.assertEqual(self.registry.mine(self.a)[0]['activeRoomId'],self.r2)
        with self.assertRaises(AccountError):self.registry.select(self.a,self.r1,self.hero,self.r1)

    def test_unselected_room_has_no_private_data(self):
        self.assertEqual(self.p2.players(),[])
        self.assertEqual(self.res2.ledger()['characters']['@global'],{})
        with self.assertRaises(profiles.ProfileError):self.p2.library(self.pid)

    def grant(self):
        return self.res1.apply(self.pid,'campaign1',dict(op='grant',item=dict(name='药水',category='potion',rarity='普通',effect='测试消耗',consumable=True),characterId=self.hero,quantity=3,revision=0,requestId='give-potion-request-0001'),True)[0]

    def test_backpack_follows_character_between_rooms(self):
        bag=self.grant()
        self.registry.select(self.a,self.r2,self.hero,self.r1)
        self.assertEqual(self.res2.view(self.pid,'campaign2')['items'],bag['items'])
        got,event=self.res2.apply(self.pid,'campaign2',dict(op='use',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId='use-in-second-room-001'))
        self.assertEqual(got['items'][0]['quantity'],2)
        self.assertEqual(self.res1.read(self.pid)['items'][0]['quantity'],2)

    def test_inactive_room_cannot_mutate_bag_or_runtime(self):
        bag=self.grant();self.registry.select(self.a,self.r2,self.hero,self.r1)
        with self.assertRaises((RevisionConflict,profiles.ProfileError)):
            self.res1.apply(self.pid,'campaign1',dict(op='use',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId='inactive-use-request-001'))
        data=self.res1.ledger();data['characters']['@global'][self.hero]['runtime']['hp']=0
        with self.assertRaises(profiles.ProfileError):self.res1.save(data)
        self.assertEqual(self.res2.read(self.pid)['items'][0]['quantity'],3)

    def test_stale_revision_cannot_overwrite_global_changes(self):
        stale=self.res1.ledger();self.grant()
        stale['characters']['@global'][self.hero]['runtime']['hp']=0
        with self.assertRaises(profiles.ProfileError):self.res1.save(stale)

    def test_two_characters_have_distinct_bags_and_wallets(self):
        self.grant()
        second=self.registry.create(self.a,'甲','新角色','new-card-request-0002')['characterId']
        self.registry.select(self.a,self.r2,second,None)
        bag=self.res2.read(self.pid)
        self.assertEqual(bag['items'],[]);self.assertEqual(bag['wallets'],{})
        self.assertEqual([c['id'] for c in self.res2.characters(self.pid,{},True)],[second])

    def test_loot_and_character_write_roll_back_together(self):
        data=self.res1.ledger();data['characters']['@global'][self.hero]['runtime']['hp']=0
        with self.assertRaises(RuntimeError):
            with ModuleStore(self.paths[0]).transaction() as db:
                ResourceDatabase(self.paths[0]).save_into(db,data)
                ModuleStore.write_document(db,'test-loot','one','',dict(taken=True),0)
                raise RuntimeError('crash before commit')
        self.assertEqual(self.res1.ledger()['characters']['@global'][self.hero]['runtime']['hp'],1)
        db=ModuleStore(self.paths[0]).connect()
        try:self.assertIsNone(ModuleStore.document(db,'test-loot','one'))
        finally:db.close()

    def test_character_sheet_edit_is_shared_and_inactive_edit_denied(self):
        lib=self.p1.library(self.pid);piece=lib['pieces'][0]
        self.p1.edit(self.pid,self.hero,lib['revision'],{'name':'成长后的老角色'},piece['revision'])
        self.registry.select(self.a,self.r2,self.hero,self.r1)
        self.assertEqual(self.p2.library(self.pid)['pieces'][0]['name'],'成长后的老角色')
        lib=self.p1.library(self.pid)
        with self.assertRaises(profiles.ProfileError):self.p1.edit(self.pid,self.hero,lib['revision'],{'name':'覆盖'},lib['pieces'][0]['revision'])

    def test_binding_legacy_preserves_bag_and_does_not_auto_claim_name(self):
        legacy=self.root/'legacy';ModuleRuntime(legacy,APP_ROOT).ensure_empty_runtime()
        p=profiles.Store(legacy,APP_ROOT,self.root/'cache')
        pid=p.create('甲')['profile']['playerId']
        lib=p.grant(pid,dict(name='待认领',type='pc',hpMax=12,ac=13,level=2),'legacy-grant-request-01')
        cid=lib['pieces'][0]['ownedPieceId']
        self.registry.migrate('r'+'3'*32,p)
        self.assertNotIn(cid,[c['characterId'] for c in self.registry.mine(self.a)])
        result=self.registry.bind('r'+'3'*32,cid,self.a,'甲','owner')
        self.assertEqual(result['characterId'],cid)
        self.assertEqual(len(self.registry.mine(self.a)),2)
        with self.assertRaises(AccountError):self.registry.bind('r'+'3'*32,cid,self.b,'乙','owner')

    def test_room_departure_keeps_owned_card_and_bag(self):
        self.grant();self.registry.detach(self.r1,self.a)
        self.assertEqual(self.p1.players(),[])
        self.assertEqual(self.registry.mine(self.a)[0]['characterId'],self.hero)
        self.registry.select(self.a,self.r2,self.hero,None)
        self.assertEqual(self.res2.read(self.pid)['items'][0]['quantity'],3)

    def test_missing_global_database_never_initializes_an_empty_replacement(self):
        self.registry.database.rename(self.registry.database.with_suffix('.retained'))
        with self.assertRaises(OSError):self.registry.connect()
        self.assertFalse(self.registry.database.exists())

    def test_room_attachment_never_recreates_missing_central_database(self):
        self.registry.database.rename(self.registry.database.with_suffix('.retained'))
        with self.assertRaises(OSError): ModuleStore(self.paths[0]).connect()
        self.assertFalse(self.registry.database.exists())

    def test_character_connection_is_closed_if_setup_fails(self):
        import sqlite3
        self.registry.database.write_bytes(b'not a sqlite database')
        connect = sqlite3.connect
        opened = []
        def track(*args, **kwargs):
            db = connect(*args, **kwargs); opened.append(db); return db
        with mock.patch('server.account_characters.sqlite3.connect', side_effect=track):
            with self.assertRaises(sqlite3.DatabaseError): self.registry.connect()
        self.assertTrue(opened)
        for db in opened:
            with self.assertRaises(sqlite3.ProgrammingError): _ = db.in_transaction

    def test_corrupt_central_asset_is_not_copied_to_another_room(self):
        original = b'central character portrait'
        local = ModuleStore(self.paths[0])
        url = local.put_asset(original, 'image/png', 'test-character')
        self.registry.adopt_assets({'portrait':url}, local)
        digest = url.rsplit('/', 1)[-1]
        (self.registry.root/'资源'/digest[:2]/digest).write_bytes(b'x'*len(original))
        target = ModuleStore(self.paths[1])
        with self.assertRaisesRegex(ValueError, '校验失败'):
            self.registry.supply_assets({'portrait':url}, target)
        with target.transaction() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM assets').fetchone()[0], 0)

    def test_reloading_old_scene_projects_current_character_without_reverting_it(self):
        piece=self.p1.library(self.pid)['pieces'][0]
        state=dict(campaignId='old',maps=[dict(id='map',tokens=[dict(piece,id='token',hp=99,characterRevision=0)])])
        self.res1.reconcile(state,accept_changes=False)
        self.assertEqual(state['maps'][0]['tokens'][0]['hp'],1)
        self.assertEqual(self.res1.ledger()['characters']['@global'][self.hero]['runtime']['hp'],1)

    def test_disabled_legacy_character_cannot_be_selected(self):
        with self.registry.transaction() as db:db.execute('UPDATE carriers SET enabled=0 WHERE id=?',(self.pid,))
        self.assertFalse(self.registry.mine(self.a)[0]['enabled'])
        with self.assertRaises(AccountError):self.registry.select(self.a,self.r2,self.hero,self.r1)

    def test_retry_after_switch_does_not_consume_twice(self):
        bag=self.grant()
        command=dict(op='use',itemId=bag['items'][0]['id'],revision=bag['revision'],requestId='consume-before-switch-001')
        self.res1.apply(self.pid,'campaign1',command)
        self.registry.select(self.a,self.r2,self.hero,self.r1)
        got,event=self.res2.apply(self.pid,'campaign2',command)
        self.assertEqual(got['items'][0]['quantity'],2)

    def test_physical_character_bag_key_and_atomic_crash_recovery(self):
        import subprocess
        db=self.registry.connect()
        try:self.assertEqual(db.execute('SELECT character_id FROM bags').fetchall()[0][0],self.hero)
        finally:db.close()
        script="""
import sys,os,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from server.account_characters import configure,Characters
from server.module_store import ModuleStore
from server.resource_database import ResourceDatabase
root,save,room,cid=sys.argv[2:]
Characters(root);configure(save,root,room)
resources=ResourceDatabase(save);data=resources.read();data['characters']['@global'][cid]['runtime']['hp']=0
with ModuleStore(save).transaction() as db:
 resources.save_into(db,data)
 ModuleStore.write_document(db,'crash-loot','one','',{'taken':True},0)
 os._exit(7)
"""
        proc=subprocess.run([sys.executable,'-c',script,str(APP_ROOT),str(self.registry.root),str(self.paths[0]),self.r1,self.hero],timeout=20)
        self.assertEqual(proc.returncode,7)
        self.assertEqual(self.res1.ledger()['characters']['@global'][self.hero]['runtime']['hp'],1)
        db=ModuleStore(self.paths[0]).connect()
        try:self.assertIsNone(ModuleStore.document(db,'crash-loot','one'))
        finally:db.close()

    def test_capacity_is_per_character_not_per_account(self):
        from server.inventory import InventoryStore
        items=[dict(id='item'+str(i),quantity=1,ownerCharacterId=self.hero) for i in range(300)]
        inventory=InventoryStore(self.p1,profiles)
        inventory.require_item_capacity(dict(items=items),character_id='o'+'9'*32)
        with self.assertRaises(profiles.ProfileError):inventory.require_item_capacity(dict(items=items),character_id=self.hero)

    def test_installation_backup_includes_global_characters_and_bags(self):
        from server.workspace import enable
        from server.installation_backup import InstallationBackups
        installation=self.root/'installation'
        save=enable(installation);ModuleRuntime(save,APP_ROOT).ensure_empty_runtime()
        registry=Characters(installation/'运行数据/账号角色')
        registry.create(self.a,'甲','备份角色','backup-character-001')
        destination=self.root/'installation-backup'
        InstallationBackups(installation).create(destination)
        copied=Characters(destination/'数据/运行数据/账号角色')
        self.assertEqual(copied.mine(self.a)[0]['name'],'备份角色')
        with copied.connect() as db:self.assertEqual(db.execute('SELECT count(*) FROM bags').fetchone()[0],1)

    def test_restart_does_not_recreate_missing_character_table(self):
        from server.account_characters import _READY
        with self.registry.connect() as db:db.execute('DROP TABLE bags')
        _READY.discard(str(self.registry.database.resolve()))
        with self.assertRaises(OSError):Characters(self.registry.root)
        with self.registry.connect() as db:self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='bags'").fetchone())

if __name__=='__main__':unittest.main()
