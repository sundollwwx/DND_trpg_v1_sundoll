from project_test_paths import APP_ROOT
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock
from server.content_packages import ContentPackages, local_package_id
from server.module_store import ModuleStore, RevisionConflict
from server.module_runtime import ModuleRuntime
from server.workspace import enable, write_catalog, read_catalog
from server.inventory import item_definition, CATALOG
from server.resources import ResourceStore
from server.save_storage import perform_local_save_operation
from server import player_profiles as profiles


class ContentPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.save = enable(self.root/'workspace', {'a':'a', 'b':'b'}, {'a':'甲战役', 'b':'乙战役'})
        for cid in ('a', 'b'): (self.root/'workspace/战役包'/cid).mkdir()
        self.store = ModuleStore(self.save)
        self.runtime = ModuleRuntime(self.save, APP_ROOT)
        self.runtime.ensure_empty_runtime()
        self.a = local_package_id('campaign:a')
        self.b = local_package_id('campaign:b')
        self.general = local_package_id('general:本地通用')

    def content(self): return ContentPackages(self.save)

    def template(self, identity='story', scope='campaign', cid='a'):
        return dict(id=identity, name='旧钥匙', category='gear', rarity='', effect='打开一扇门', consumable=False,
            version=1, archived=False, scope=scope, campaignId=cid if scope=='campaign' else '')

    def item(self):
        t = self.template()
        return dict(item_definition(t, ValueError), id='i'+'1'*32, quantity=3,
            ownerCharacterId='o'+'1'*32, **self.content().origin_for_template(t))

    def test_read_only_default_identity_survives_names_and_never_creates_records(self):
        before = sorted((str(p.relative_to(self.root)), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file() and not p.name.endswith('-shm'))
        c = self.content().context('a')
        self.assertEqual(set(c['enabledPackageIds']), {self.general, self.a})
        self.assertEqual(c['sourcePackageId'], self.a)
        self.assertNotIn(self.b, c['enabledPackageIds'])
        self.assertEqual(c['selectionRevision'], 0)
        self.assertEqual(c, self.content().context('a'))
        after = sorted((str(p.relative_to(self.root)), p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file() and not p.name.endswith('-shm'))
        self.assertEqual(before, after)

    def test_extra_campaign_hides_then_restores_same_instance_and_quantity(self):
        item = self.item(); original = copy.deepcopy(item)
        self.assertFalse(self.content().is_available(item, 'b'))
        context = self.content().set_enabled('b', [self.general, self.a], 0, 'enable-package-0001')
        self.assertIn(self.b, context['enabledPackageIds'])
        self.assertTrue(self.content().is_available(item, 'b'))
        self.content().set_enabled('b', [self.general], context['selectionRevision'], 'disable-package-001')
        self.assertFalse(self.content().is_available(item, 'b'))
        self.assertEqual(item, original)
        self.assertTrue(self.content().is_available(item, 'a'))

    def test_selection_cas_and_idempotency(self):
        service = self.content()
        result = service.set_enabled('a', [self.b], 0, 'same-request-00001')
        self.assertEqual(service.set_enabled('a', [self.b], 0, 'same-request-00001'), result)
        with self.assertRaises(RevisionConflict): service.set_enabled('a', [], 0, 'new-request-000001')
        with self.assertRaises(RevisionConflict): service.set_enabled('a', [], 0, 'same-request-00001')
        self.assertEqual(self.content().context('a'), result)

    def test_personal_keeps_origin_after_unbinding_and_does_not_need_source_install(self):
        pid, oid = 'p'+'1'*32, 'o'+'1'*32
        origin = self.content().origin_for_custom(dict(scope='personal', ownerPlayerId=pid, ownerCharacterId=oid), 'a')
        item = dict(self.item(), **origin)
        self.assertTrue(self.content().is_available(item, 'b'))
        item['ownerCharacterId'] = 'o'+'2'*32
        self.assertFalse(self.content().is_available(item, 'b'))
        item['boundCharacterId'] = ''
        self.assertTrue(self.content().is_available(item, 'b'))
        self.assertEqual(item['sourceCharacterId'], oid)
        self.assertEqual(item['sourcePlayerId'], pid)
        self.assertNotIn(item['sourcePackageId'], self.content().context('b')['enabledPackageIds'])

    def test_unknown_sources_fail_closed_and_exact_builtin_is_read_only_compatible(self):
        item = self.item(); item.pop('sourcePackageId'); item.pop('sourceTemplateId')
        self.assertFalse(self.content().is_available(item, 'a'))
        builtin = item_definition(CATALOG[0], ValueError)
        self.assertTrue(self.content().is_available(builtin, 'b'))
        builtin['effect'] = '不同效果'
        self.assertFalse(self.content().is_available(builtin, 'b'))

    def test_from_bag_template_preserves_source_but_uses_new_template_identity(self):
        template = dict(self.template('new'), sourcePackageId=self.b, sourceScope='campaign', sourceCampaignId='b')
        origin = self.content().origin_for_template(template)
        self.assertEqual(origin['sourcePackageId'], self.b)
        self.assertEqual(origin['sourceTemplateId'], 'new')

    def test_legacy_origin_resolution_preserves_historical_template_version(self):
        current=self.template('historical');current['version']=5
        write_catalog(self.save,'item-template',dict(schemaVersion=1,revision=1,templates=[current],receipts={}))
        old=dict(item_definition(current,ValueError),id='i'+'1'*32,quantity=2,
            sourceTemplateId='historical',sourceTemplateVersion=3)
        origin=self.content().normalize_origin(old)
        self.assertEqual(origin['sourceTemplateVersion'],3)
        self.assertEqual(origin['sourceTemplateId'],'historical')
        self.assertEqual(origin['sourcePackageId'],self.a)

    def migration_fixture(self):
        pid, oid = 'p'+'1'*32, 'o'+'1'*32
        t = self.template()
        item = dict(item_definition(t, ValueError), id='i'+'1'*32, quantity=3, ownerCharacterId=oid)
        bag = dict(playerId=pid, scope='player', revision=7, items=[item], removedItems=[dict(id='removed-request-001',op='delete',at=1,item=dict(item,id='i'+'2'*32,quantity=1))], history=[], receipts={})
        with self.store.transaction() as db:
            base=ResourceStore.base({})
            self.store.write_document(db, 'runtime-character', oid, pid, dict(id=oid,ownerPlayerId=pid,
                name='角色',revision=1,base=base,runtime=ResourceStore.runtime({},base)), 0)
            self.store.write_document(db, 'runtime-backpack', pid, pid, bag, 0)
        return pid, oid, bag

    def test_migration_is_reviewed_atomic_and_does_not_resurrect_removed_item(self):
        pid, oid, original = self.migration_fixture()
        service = self.content()
        preview = service.migration_plan()
        self.assertEqual(len(preview['unresolved']), 2)
        with self.assertRaises(ValueError): service.apply_migration(preview)
        overrides = {'i'+'1'*32:dict(scope='personal'), 'i'+'2'*32:dict(scope='campaign',campaignId='a')}
        plan = self.content().migration_plan(overrides)
        self.assertEqual(plan['unresolved'], [])
        result = self.content().apply_migration(plan)
        self.assertEqual(self.content().apply_migration(plan), result)
        db = self.store.connect()
        try: bag = self.store.document(db,'runtime-backpack',pid)['data']
        finally: db.close()
        self.assertEqual([(i['id'],i['quantity']) for i in bag['items']], [(i['id'],i['quantity']) for i in original['items']])
        self.assertEqual(bag['items'][0]['sourceScope'], 'personal')
        self.assertEqual(bag['items'][0]['boundCharacterId'], oid)
        self.assertEqual(bag['removedItems'][0]['op'], 'delete')
        self.assertEqual(bag['removedItems'][0]['item']['sourcePackageId'], self.a)
        for current, old in [(bag['items'][0],original['items'][0]),(bag['removedItems'][0]['item'],original['removedItems'][0]['item'])]:
            self.assertTrue(all(current[k]==v for k,v in old.items()))

    def test_migration_rejects_concurrent_changes_without_partial_registration(self):
        pid, oid, bag = self.migration_fixture()
        overrides = {'i'+'1'*32:dict(scope='personal'), 'i'+'2'*32:dict(scope='general')}
        plan = self.content().migration_plan(overrides)
        with self.store.transaction() as db:
            bag['items'][0]['quantity'] = 2
            self.store.write_document(db,'runtime-backpack',pid,pid,bag,1)
        with self.assertRaises(RevisionConflict): self.content().apply_migration(plan)
        db=self.store.connect()
        try:
            self.assertEqual(db.execute("SELECT count(*) FROM documents WHERE kind='content-package'").fetchone()[0],0)
            self.assertEqual(self.store.document(db,'runtime-backpack',pid)['data']['items'][0]['quantity'],2)
        finally: db.close()

    def test_migration_write_failure_rolls_back_origins_packages_and_receipt(self):
        pid, oid, bag = self.migration_fixture()
        plan=self.content().migration_plan({'i'+'1'*32:dict(scope='personal'),'i'+'2'*32:dict(scope='general')})
        original=ModuleStore.write_document
        def fail(db, kind, *args):
            if kind=='runtime-backpack': raise OSError('disk full')
            return original(db,kind,*args)
        with mock.patch.object(ModuleStore,'write_document',side_effect=fail), self.assertRaises(OSError):
            self.content().apply_migration(plan)
        db=self.store.connect()
        try:
            self.assertEqual(self.store.document(db,'runtime-backpack',pid)['data'],bag)
            self.assertEqual(db.execute("SELECT count(*) FROM documents WHERE kind='content-package'").fetchone()[0],0)
            self.assertIsNone(db.execute("SELECT 1 FROM migrations WHERE id='content-origins-v1'").fetchone())
        finally: db.close()

    def test_campaign_archive_keeps_general_scope_and_stable_content_across_runs(self):
        source = self.root/'source.sundoll'
        general = self.template('generic', 'general')
        story = self.template('story')
        payload = dict(state=dict(campaignId='a',maps=[dict(id='m',tokens=[])]), items=[general,story])
        manifest = self.runtime.packages.export(source,'campaign-content','甲战役',payload,'portable-campaign')
        target_save=enable(self.root/'target')
        target=ModuleRuntime(target_save,APP_ROOT)
        target.packages.install(source)
        a=target.create_run(manifest['moduleId'],'create-run-first-01')
        b=target.create_run(manifest['moduleId'],'create-run-second01')
        ca=ContentPackages(target_save).context(a['campaignId'])
        cb=ContentPackages(target_save).context(b['campaignId'])
        self.assertEqual(ca['sourcePackageId'], cb['sourcePackageId'])
        items=read_catalog(target_save,'item-template')['templates']
        portable=[i for i in items if i.get('moduleId')==manifest['moduleId']]
        self.assertEqual(len(portable),2)
        self.assertEqual({i['contentEntryId']:i['scope'] for i in portable},{'generic':'general','story':'campaign'})
        self.assertTrue(any(i['contentPackageId']!=ca['sourcePackageId'] for i in portable if i['scope']=='general'))

    def test_uninstall_source_changes_context_and_disables_items_without_erasing_them(self):
        from server.module_management import set_archived
        path=self.root/'source.sundoll'
        m=self.runtime.packages.export(path,'campaign-content','甲',dict(state=dict(maps=[]),items=[self.template()]),'source-campaign')
        self.runtime.packages.install(path)
        run=self.runtime.create_run(m['moduleId'],'create-campaign-001')
        template=next(i for i in read_catalog(self.save,'item-template')['templates'] if i.get('moduleId')==m['moduleId'])
        service=self.content(); item=dict(self.item(),**service.origin_for_template(template))
        before=service.context(run['campaignId'])
        self.assertTrue(service.is_available(item,run['campaignId']))
        set_archived(self.runtime,m['moduleId'],True)
        after=service.context(run['campaignId'])
        self.assertNotEqual(before['revision'],after['revision'])
        self.assertIn(template['contentPackageId'],after['missingPackageIds'])
        self.assertFalse(service.is_available(item,run['campaignId']))
        set_archived(self.runtime,m['moduleId'],False)
        self.assertTrue(service.is_available(item,run['campaignId']))
        self.assertEqual(item['quantity'],3)

    def test_player_dependency_metadata_does_not_install_or_enable_source_campaign(self):
        profile=profiles.Store(self.save,APP_ROOT,self.root/'cache')
        pid=profile.create('旅人')['profile']['playerId']
        piece=profile.grant(pid,dict(name='角色',hpMax=12),'grant-character-001')['pieces'][0]
        state=dict(campaignId='a',maps=[dict(id='m',tokens=[dict(piece,id='t')])])
        resources=ResourceStore(profile,profiles); resources.reconcile(state,accept_changes=True)
        bag,_=resources.apply(pid,'a',dict(op='grant',item=self.template(),characterId=piece['ownedPieceId'],quantity=2,revision=0,requestId='grant-story-item01'),True,state=state)
        path=self.root/'player.sundoll';manifest=self.runtime.export_player(pid,path)
        target_save=enable(self.root/'target')
        target=ModuleRuntime(target_save,APP_ROOT);target.packages.install(path);target.activate_player(manifest['moduleId'])
        content=ContentPackages(target_save)
        self.assertFalse(content.is_available(bag['items'][0],'b'))
        self.assertFalse(next(p for p in content.catalog() if p['id']==self.a)['available'])
        with self.assertRaises(ValueError):content.set_enabled('b',[self.a],0,'enable-missing-0001')
        self.assertEqual(content.context('b')['sourcePackageId'],local_package_id('campaign:b'))

    def test_campaign_save_does_not_replace_content_selection_or_owned_item_origins(self):
        pid,oid,bag=self.migration_fixture()
        plan=self.content().migration_plan({'i'+'1'*32:dict(scope='personal'),'i'+'2'*32:dict(scope='campaign',campaignId='a')})
        self.content().apply_migration(plan)
        context=self.content().context('b')
        self.content().set_enabled('b',[self.a],context['selectionRevision'],'save-policy-test01')
        before=self.content().context('b')
        # A stale map save cannot become the authority for package selection.
        doc=dict(campaignId='b',state=dict(campaignId='b',maps=[],enabledPackageIds=[]))
        perform_local_save_operation(dict(op='write-campaign',path='战役/b/当前存档.json',text=json.dumps(doc),expectedHash=None),self.save)
        self.assertEqual(self.content().context('b')['enabledPackageIds'],before['enabledPackageIds'])
        db=self.store.connect()
        try:
            stored=self.store.document(db,'runtime-backpack',pid)['data']
            self.assertEqual(stored['items'][0]['sourceScope'],'personal')
            self.assertEqual(stored['items'][0]['quantity'],3)
        finally:db.close()


if __name__ == '__main__': unittest.main()
