from project_test_paths import APP_ROOT
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
sys.path.insert(0, str(APP_ROOT))
from server.module_store import ModuleStore, RevisionConflict, ASSET_URL
from server import save_storage


class ModuleStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = ModuleStore(self.root)
        self.raw = b'\x89PNG\r\n\x1a\noriginal-map'
        self.url = 'data:image/png;base64,' + base64.b64encode(self.raw).decode()
        self.ref = ASSET_URL + hashlib.sha256(self.raw).hexdigest()

    def op(self, **data):
        return save_storage.perform_local_save_operation(data, self.root)

    def test_images_roundtrip_and_deduplicate_without_mutating_input(self):
        original = {'maps': [{'mapData': self.url}, {'mapData': self.url}]}
        result = self.store.externalize(original, 'campaign:a')
        self.assertEqual(original['maps'][0]['mapData'], self.url)
        self.assertEqual(result['maps'][0]['mapData'], self.ref)
        path, mime, size = self.store.asset(self.ref.split('/')[-1])
        self.assertEqual((path.read_bytes(), mime, size), (self.raw, 'image/png', len(self.raw)))
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM assets').fetchone()[0], 1)
        self.assertEqual(self.store.externalize(result, 'campaign:b'), result)

    def test_map_forms_externalize_and_roundtrip_without_scene_reset(self):
        second = 'data:image/png;base64,' + base64.b64encode(self.raw+b'open').decode()
        m = dict(id='m1', mapData=self.url, activeMapFormId='closed',
                 mapForms=[dict(id='closed',name='closed',mapData=self.url),dict(id='open',name='open',mapData=second)],
                 tokens=[dict(id='hero',x=23,y=45,hp=7)],doodles=[dict(id='d1')])
        compact=self.store.externalize(m,'campaign:a')
        self.assertEqual(compact['tokens'],m['tokens'])
        self.assertEqual(compact['mapForms'][0]['mapData'],compact['mapData'])
        self.assertNotEqual(compact['mapForms'][1]['mapData'],compact['mapData'])
        with self.store.transaction() as db:
            self.store.write_document(db,'test-map','m1','campaign:a',compact,0)
        with self.store.transaction() as db:
            self.assertEqual(self.store.document(db,'test-map','m1')['data'],compact)

    def test_write_failure_and_missing_original_fail_closed(self):
        with mock.patch('server.module_store.os.replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.store.externalize({'mapData': self.url}, 'campaign:a')
        with self.store.transaction() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM assets').fetchone()[0], 0)
        with self.assertRaises(ValueError): self.store.externalize({'mapData': self.ref}, 'campaign:a')

    def test_corrupt_original_is_detected(self):
        self.store.externalize(self.url, 'campaign:a')
        self.store.asset_path(self.ref.split('/')[-1]).write_bytes(b'corrupt')
        with self.assertRaises(ValueError): self.store.externalize(self.url, 'campaign:a')

    def test_transaction_rolls_back_both_character_and_consumption(self):
        with self.store.transaction() as db:
            self.store.write_document(db, 'character', 'c', 'p', {'hp': 3}, 0)
            self.store.write_document(db, 'container', 'bag', 'c', {'quantity': 1}, 0)
        with self.assertRaises(RevisionConflict):
            with self.store.transaction() as db:
                self.store.write_document(db, 'character', 'c', 'p', {'hp': 9}, 1)
                self.store.write_document(db, 'container', 'bag', 'c', {'quantity': 0}, 0)
        with self.store.transaction() as db:
            self.assertEqual(self.store.document(db, 'character', 'c')['data']['hp'], 3)
            self.assertEqual(self.store.document(db, 'container', 'bag')['data']['quantity'], 1)

    def test_legacy_read_compacts_without_rewriting_original_and_save_uses_original_hash(self):
        path = '战役/c/当前存档.json'
        target = self.root / path
        target.parent.mkdir(parents=True)
        legacy = json.dumps({'campaignId': 'c', 'state': {'maps': [{'id': 'm', 'mapData': self.url, 'tokens': []}]}})
        target.write_text(legacy)
        loaded = self.op(op='read-campaign', path=path)
        self.assertEqual(target.read_text(), legacy)
        self.assertEqual(json.loads(loaded['text'])['state']['maps'][0]['mapData'], self.ref)
        saved = self.op(op='write-campaign', path=path, text=loaded['text'], expectedHash=loaded['sourceHash'])
        self.assertEqual(saved['hash'], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertNotIn('base64', target.read_text())
        published = target.read_bytes()
        # An exact committed submission is a receipt replay, not a new stale
        # write. Different content still requires the current formal hash.
        with mock.patch('server.save_storage.publish_campaign_projection') as publish:
            replay = self.op(op='write-campaign', path=path, text=loaded['text'], expectedHash=loaded['sourceHash'])
            publish.assert_not_called()
        self.assertTrue(replay['duplicate'])
        self.assertEqual(replay['hash'], saved['hash'])
        self.assertEqual(target.read_bytes(), published)
        changed = json.loads(loaded['text'])
        changed['state']['campaignName'] = 'stale changed content'
        with self.assertRaises(save_storage.SaveConflict):
            self.op(op='write-campaign', path=path, text=json.dumps(changed), expectedHash=loaded['sourceHash'])
        self.assertEqual(target.read_bytes(), published)

    def test_cold_catalog_does_not_open_campaign_body(self):
        path = '战役/c/当前存档.json'
        data = json.dumps({'campaignId': 'c', 'state': {'maps': [{'id': 'm', 'mapData': self.url}]}})
        self.op(op='write-campaign', path=path, text=data, expectedHash=None)
        save_storage.CAMPAIGN_SUMMARIES.clear()
        builtin_open = open
        def guard(file, *args, **kwargs):
            if str(file) == str(self.root / path): raise AssertionError('catalog read entire campaign')
            return builtin_open(file, *args, **kwargs)
        with mock.patch('builtins.open', side_effect=guard):
            records = self.op(op='campaign-catalog')['records']
        self.assertEqual(records[0]['state']['maps'], [{'id': 'm', 'name': None, 'tokenCount': 0}])

    def test_symlink_resource_and_path_traversal_rejected(self):
        for key in ('../secret', 'a' * 63, 'A' * 64):
            with self.assertRaises(ValueError): self.store.asset_path(key)
        self.store.assets.mkdir(parents=True)
        (self.store.assets / 'aa').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): self.store.asset_path('a' * 64)
