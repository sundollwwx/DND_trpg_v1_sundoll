import copy
from unittest import mock
from test_resources import ResourceTests, SERVER
from server.resources import ResourceStore
from server.resource_database import ResourceDatabase
from server.module_store import ModuleStore


class GlobalResourceTests(ResourceTests):
    # Reuse fixture only; the legacy assertions deliberately cover the JSON adapter.
    def setUp(self):
        super().setUp()
        data = self.r.ledger()
        data['characters'] = {'@global': data['characters']['c1']}
        for c in data['characters']['@global'].values(): c['revision'] += 1000000
        libraries = {pid: self.store.library(pid) for pid in (self.pid, self.other)}
        ResourceDatabase(self.store.root.parent).activate(data, libraries, {'test': 'global'})
        self.r = ResourceStore(self.store, SERVER.profiles)
        self.r.reconcile(self.state, self.pid)
        self.bag, _ = self.r.apply(self.pid, 'c1', dict(op='assign', revision=self.bag['revision'],
            itemId=self.bag['items'][0]['id'], characterId=self.oid, requestId='global-bag-assign'), state=self.state)

    def test_collection_role_reaches_backpack_character_projection_without_changing_resources(self):
        before=copy.deepcopy(self.r.ledger())
        lib=self.store.library(self.pid);piece=lib['pieces'][0]
        self.store.edit(self.pid,self.oid,lib['revision'],{'collectionRole':'companion'},piece['revision'])
        entry=next(c for c in self.r.characters(self.pid,self.state) if c['id']==self.oid)
        self.assertEqual(entry['collectionRole'],'companion')
        after=self.r.ledger()
        self.assertEqual(after['backpacks'],before['backpacks'])
        self.assertEqual(after['characters'],before['characters'])
        self.assertEqual(self.store.library(self.pid)['pieces'][0]['collectionRole'],'companion')

    def character(self, oid=None):
        return self.r.character('any-campaign', oid or self.target)

    def test_global_campaign_switch_does_not_restore_hp_or_consumed_item(self):
        legacy_bytes = self.r.ledger_path.read_bytes()
        old = copy.deepcopy(self.state)
        command = self.command()
        bag, event = self.r.apply(self.pid, 'c1', command, state=self.state)
        other = copy.deepcopy(old); other['campaignId'] = 'c2'
        other['maps'][0]['tokens'][1].update(hp=1, characterRevision=1)
        self.r.reconcile(other, accept_changes=True)
        self.assertEqual(other['maps'][0]['tokens'][1]['hp'], event['afterHp'])
        self.r.reconcile(old, accept_changes=True)
        self.assertEqual(old['maps'][0]['tokens'][1]['hp'], event['afterHp'])
        self.assertEqual(self.r.read(self.pid, 'c2')['items'][0]['quantity'], 2)
        self.assertEqual(self.r.ledger_path.read_bytes(), legacy_bytes)
        replay, _ = self.r.apply(self.pid, 'c1', command, state=old)
        self.assertEqual(replay['items'][0]['quantity'], 2)

    def test_global_failed_transaction_preserves_cost_and_healing(self):
        before = self.r.ledger()
        write = ModuleStore.write_document
        def fail(db, kind, *args):
            if kind == 'runtime-backpack': raise OSError('disk full')
            return write(db, kind, *args)
        with mock.patch.object(ModuleStore, 'write_document', side_effect=fail):
            with self.assertRaises(OSError): self.heal()
        self.assertEqual(self.r.ledger(), before)

    def test_global_profile_edit_updates_master_and_old_map_cannot_undo_it(self):
        lib = self.store.library(self.pid); piece = lib['pieces'][0]
        out = self.store.edit(self.pid, self.oid, lib['revision'], {'name':'成长后的战士', 'hpMax': 40, 'ac': 18}, piece['revision'], host=True)
        self.assertEqual(out['pieces'][0]['hpMax'], 40)
        self.r.reconcile(self.state, accept_changes=True)
        self.assertEqual(self.state['maps'][0]['tokens'][0]['hpMax'], 40)
        self.assertEqual(self.character(self.oid)['base']['ac'], 18)
        self.assertEqual(self.state['maps'][0]['tokens'][0]['name'],'成长后的战士')

    def test_global_conditions_and_slots_survive_campaign_change(self):
        token = self.state['maps'][0]['tokens'][0]
        token.update(conditions=[{'name': '中毒'}], spellSlots={'1': {'remaining': 1, 'max': 3}}, resourceSlots={'ki': 2})
        self.r.reconcile(self.state, accept_changes=True)
        state = dict(campaignId='c2', maps=[dict(id='m2', tokens=[dict(token, hp=30, characterRevision=1, conditions=[])])])
        self.r.reconcile(state, accept_changes=True)
        self.assertEqual(state['maps'][0]['tokens'][0]['conditions'], token['conditions'])
        self.assertEqual(state['maps'][0]['tokens'][0]['spellSlots']['1']['remaining'], 1)

    def test_global_items_cannot_be_moved_to_an_unassigned_container(self):
        before = self.r.ledger()
        with self.assertRaisesRegex(SERVER.profiles.ProfileError, '请选择接收'):
            self.r.apply(self.pid, 'c1', dict(op='assign', revision=self.bag['revision'],
                itemId=self.bag['items'][0]['id'], characterId='', requestId='return-to-vault-001'), state=self.state)
        self.assertEqual(self.r.ledger(), before)

    def save_campaign(self, state=None, expected=None):
        from server.save_storage import perform_local_save_operation
        import json
        return perform_local_save_operation(dict(op='write-campaign',path='战役/c1/当前存档.json',
            text=json.dumps(dict(campaignId='c1',state=state or self.state)), expectedHash=expected), self.store.root.parent)

    def test_offline_save_commits_character_and_campaign_together(self):
        self.state['maps'][0]['tokens'][0]['hp'] = 4
        result = self.save_campaign()
        self.assertEqual(self.character(self.oid)['runtime']['hp'], 4)
        self.assertTrue(result['characterUpdates'])
        from server.save_storage import perform_local_save_operation
        import json
        loaded = perform_local_save_operation(dict(op='read-campaign',path='战役/c1/当前存档.json'),self.store.root.parent)
        self.assertEqual(json.loads(loaded['text'])['state']['maps'][0]['tokens'][0]['hp'],4)

    def test_offline_failed_transaction_changes_neither_character_nor_campaign(self):
        before = self.r.ledger()
        self.state['maps'][0]['tokens'][0]['hp'] = 3
        original = ModuleStore.write_document
        def fail(db, kind, *args):
            if kind == 'campaign-commit': raise OSError('disk full')
            return original(db,kind,*args)
        with mock.patch.object(ModuleStore,'write_document',side_effect=fail):
            with self.assertRaises(OSError): self.save_campaign()
        self.assertEqual(self.r.ledger(),before)
        self.assertFalse((self.store.root.parent/'战役/c1/当前存档.json').exists())

    def test_offline_projection_interruption_recovers_and_retry_is_idempotent(self):
        self.state['maps'][0]['tokens'][0]['hp'] = 6
        with mock.patch('server.save_storage.publish_campaign_projection',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError): self.save_campaign()
        revision = self.character(self.oid)['revision']
        result = self.save_campaign()
        self.assertEqual(self.character(self.oid)['revision'],revision)
        self.assertEqual(self.character(self.oid)['runtime']['hp'],6)
        self.assertEqual(result, self.save_campaign())

    def test_public_projection_preserves_host_private_conditions(self):
        token=self.state['maps'][0]['tokens'][0]
        token['conditions']=[dict(name='秘密诅咒',visibility='gm'),dict(name='中毒')]
        self.r.reconcile(self.state,accept_changes=True,from_host=True)
        public=copy.deepcopy(self.state)
        public['maps'][0]['tokens'][0]['conditions']=[]
        self.r.reconcile(public,accept_changes=True)
        self.assertEqual(self.character(self.oid)['runtime']['conditions'],[dict(name='秘密诅咒',visibility='gm')])
        updates=SERVER.character_updates(self.state,public=True)
        self.assertNotIn('秘密诅咒', str(updates))

    def test_stale_offline_character_edit_preserves_recovery_and_rejects_overwrite(self):
        from server.save_storage import SaveConflict
        old=copy.deepcopy(self.state)
        self.state['maps'][0]['tokens'][0]['hp']=5
        self.r.reconcile(self.state,accept_changes=True,from_host=True)
        old['maps'][0]['tokens'][0]['hp']=2
        with self.assertRaises(SaveConflict):self.save_campaign(old)
        self.assertEqual(self.character(self.oid)['runtime']['hp'],5)
        self.assertEqual(len(list((self.store.root.parent/'战役/c1/自动备份').glob('角色保存冲突-*.json'))),1)


# Run only the new global cases; keep the inherited fixture/helpers.
for _name in dir(ResourceTests):
    if _name.startswith('test_'):
        setattr(GlobalResourceTests, _name, None)
