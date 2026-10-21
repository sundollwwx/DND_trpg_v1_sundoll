from project_test_paths import APP_ROOT
import json
import unittest
from unittest import mock
import test_backend_storage_http as fixtures

SERVER = fixtures.SERVER


class MediaSourceHttpTests(unittest.TestCase):
    close_server = fixtures.BackendStorageHttpTests.close_server
    request = fixtures.BackendStorageHttpTests.request

    def setUp(self):
        fixtures.BackendStorageHttpTests.setUp(self)
        self.workspace = self.save.parent.parent
        for field, value in [('DOCUMENT_LIBRARY_ROOT', str(self.root/'legacy-documents')),
                             ('MUSIC_LIBRARY_ROOT', str(self.root/'legacy-music')),
                             ('DOCUMENT_LIBRARY_INDEX', {}), ('MUSIC_LIBRARY_INDEX', {})]:
            patch = mock.patch.object(SERVER, field, value)
            patch.start(); self.addCleanup(patch.stop)

    def media(self, module, folder, filename, content):
        path = self.workspace/'通用包'/module/'资料'/folder/filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def test_bad_module_does_not_break_healthy_catalogs_and_http_files(self):
        fixtures = [
            ('文档', 'document', 'documents', '战役/c1/good.pdf', b'%PDF-module',
             self.root/'legacy-documents/战役/c1/legacy.pdf', b'%PDF-legacy'),
            ('音乐', 'music', 'tracks', 'good.mp3', b'ID3-module',
             self.root/'legacy-music/legacy.mp3', b'ID3-legacy'),
        ]
        for folder, api, field, filename, raw, legacy, old_raw in fixtures:
            self.media('正常资料', folder, filename, raw)
            self.media('损坏资料', folder, filename.replace('good', 'hidden'), b'broken-source')
            legacy.parent.mkdir(parents=True, exist_ok=True)
            legacy.write_bytes(old_raw)
        (self.workspace/'通用包/正常资料/模块.json').write_text(json.dumps(dict(
            format='sundoll-workspace-module', family='通用包', id='healthy')), encoding='utf-8')
        (self.workspace/'通用包/损坏资料/模块.json').write_text('{bad JSON', encoding='utf-8')

        for folder, api, field, _, raw, _, old_raw in fixtures:
            with self.subTest(library=folder), self.assertLogs('server.media_library', level='ERROR') as logs:
                status, value = self.request(path='/api/'+api+'-library?campaignId=c1', method='GET', host=True)
            self.assertEqual(status, 200, value)
            self.assertEqual({item['title'] for item in value[field]}, {'good', 'legacy'})
            self.assertEqual(value['warningCount'], 1)
            self.assertEqual(value['warnings'][0]['module'], '损坏资料')
            self.assertEqual(value['warnings'][0]['code'], 'media_source_unavailable')
            self.assertIn('JSONDecodeError', logs.output[0])
            self.assertIn(str(self.workspace), logs.output[0])
            serialized = json.dumps(value, ensure_ascii=False)
            self.assertNotIn(str(self.root), serialized)
            self.assertNotIn('_index', value); self.assertNotIn('_aliases', value)
            for item in value[field]:
                expected = raw if item['title'] == 'good' else old_raw
                urls = [item['previewUrl'], item['downloadUrl']] if api == 'document' else [item['url']]
                for url in urls:
                    self.assertEqual(self.request(path=url, method='GET', host=True), (200, expected))

    def test_unreadable_module_warning_count_is_bounded(self):
        for number in range(23):
            self.media('unreadable-'+str(number), '音乐', 'hidden.mp3', b'ID3-hidden')
        with mock.patch('server.catalog_paths.support_module_identity', side_effect=PermissionError('private path')), \
             self.assertLogs('server.media_library', level='ERROR'):
            status, value = self.request(path='/api/music-library', method='GET', host=True)
        self.assertEqual(status, 200, value)
        self.assertEqual(value['tracks'], [])
        self.assertEqual(value['warningCount'], 23)
        self.assertEqual(len(value['warnings']), 20)
        self.assertNotIn('private path', json.dumps(value))
