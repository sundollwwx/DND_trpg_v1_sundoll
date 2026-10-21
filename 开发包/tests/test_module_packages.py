from project_test_paths import APP_ROOT
import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
sys.path.insert(0, str(APP_ROOT))
from server.module_packages import ModulePackages
from server.module_store import RevisionConflict


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.author = ModulePackages(self.root/'author', self.root/'app')
        self.receiver = ModulePackages(self.root/'receiver', self.root/'empty-app')
        self.path = self.root / 'campaign.sundoll'
        self.payload = {'state': {'maps': [{'id':'map1','tokens':[], 'mapData':'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\noriginal').decode()}]}}

    def test_portable_package_import_into_empty_root_and_idempotent_retry(self):
        manifest = self.author.export(self.path, 'campaign-content', '战役', self.payload, 'test-module')
        result = self.receiver.install(self.path)
        self.assertFalse(result['alreadyInstalled'])
        self.assertTrue(self.receiver.install(self.path)['alreadyInstalled'])
        digest = manifest['assets'][0]['id']
        self.assertEqual(self.receiver.store.asset(digest)[0].read_bytes(), b'\x89PNG\r\n\x1a\noriginal')
        self.assertEqual(self.receiver.catalog()[0]['moduleId'], 'test-module')
        self.assertEqual(self.receiver.payload('test-module')['payload']['state']['maps'][0]['id'], 'map1')

    def test_same_module_changed_content_never_overwrites_installed(self):
        self.author.export(self.path, 'campaign-content', '战役', self.payload, 'test-module')
        self.receiver.install(self.path)
        self.payload['state']['maps'][0]['name'] = '新地图'
        self.author.export(self.path, 'campaign-content', '战役', self.payload, 'test-module')
        with self.assertRaises(RevisionConflict): self.receiver.install(self.path)
        self.assertNotIn('name',self.receiver.payload('test-module')['payload']['state']['maps'][0])

    def test_private_characters_rejected_in_content_package(self):
        self.payload['state']['maps'][0]['tokens'] = [{'ownedPieceId':'o'+'1'*32}]
        with self.assertRaises(ValueError): self.author.export(self.path, 'campaign-content', '战役', self.payload)

    def test_tamper_missing_resource_and_arbitrary_paths_rejected_before_registration(self):
        self.author.export(self.path, 'campaign-content', '战役', self.payload, 'test-module')
        with zipfile.ZipFile(self.path) as z: original = {n: z.read(n) for n in z.namelist()}
        for kind in ('tamper','missing','path','duplicate'):
            entries = copy.deepcopy(original)
            if kind == 'tamper': entries['data.json'] = b'{}'
            if kind == 'missing': entries.pop(next(n for n in entries if n.startswith('assets/')))
            if kind == 'path': entries['../../escape.py'] = b'evil'
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as z:
                for name, value in entries.items(): z.writestr(name, value)
                if kind == 'duplicate':
                    import warnings
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore'); z.writestr('data.json', b'{}')
            buffer.seek(0)
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.receiver.install(buffer)
            self.assertEqual(self.receiver.catalog(), [])

    def test_player_export_does_not_contain_credentials_or_other_identity(self):
        pid='p'+'1'*32; oid='o'+'2'*32
        payload={'profile':{'playerId':pid,'name':'玩家','loginCode':'must-never-export'},
                 'library':{'pieces':[{'ownedPieceId':oid,'ownerPlayerId':pid}]},
                 'characters':{oid:{'id':oid,'ownerPlayerId':pid}},
                 'backpack':{'playerId':pid,'items':[]}}
        self.author.export(self.path,'player','玩家',payload)
        with zipfile.ZipFile(self.path) as z:self.assertNotIn(b'must-never-export',z.read('data.json'))
        payload['characters'][oid]['ownerPlayerId']='p'+'3'*32
        with self.assertRaises(ValueError):self.author.export(self.path,'player','玩家',payload)
