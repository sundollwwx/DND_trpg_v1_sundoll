import http.client
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, urlencode


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = PROJECT_ROOT / '主控台' / '联机服务器.py'
SPEC = importlib.util.spec_from_file_location('sundoll_document_server', SERVER_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
ORIGINAL_ARGV = sys.argv[:]
try:
    sys.argv = [sys.argv[0]]
    SPEC.loader.exec_module(SERVER)
finally:
    sys.argv = ORIGINAL_ARGV


WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def write_docx(path, extra_members=None):
    document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="%s"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>整备物资</w:t><w:br w:type="page"/><w:t>抵达海岸</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>地点</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>线索</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>''' % WORD_NS
    styles = '''<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="%s"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>''' % WORD_NS
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('word/document.xml', document)
        archive.writestr('word/styles.xml', styles)
        for name, data in extra_members or []:
            archive.writestr(name, data)
    return path.read_bytes()


class DocumentCatalogTests(unittest.TestCase):
    def test_catalog_only_exposes_current_campaign_and_opaque_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / '战役' / 'c185-风骸岛之龙'
            other = root / '战役' / 'c9-秘密战役'
            current.mkdir(parents=True)
            other.mkdir(parents=True)
            (current / '地图.pdf').write_bytes(b'%PDF-current')
            write_docx(current / '模组.docx')
            (current / '~$模组.docx').write_bytes(b'temporary')
            (current / '宏.docm').write_bytes(b'unsupported')
            (other / '秘密.pdf').write_bytes(b'%PDF-secret')

            catalog = SERVER.document_library_catalog(str(root), 'c185', '风骸岛之龙')
            public = dict(catalog)
            public.pop('_index')
            serialized = json.dumps(public, ensure_ascii=False)

            self.assertEqual([item['title'] for item in catalog['documents']], ['地图', '模组'])
            self.assertNotIn('秘密', serialized)
            self.assertNotIn(str(root), serialized)
            for item in catalog['documents']:
                self.assertRegex(item['id'], r'^[0-9a-f]{32}$')
                self.assertNotIn('风骸岛之龙', item['previewUrl'])
                self.assertNotIn('风骸岛之龙', item['downloadUrl'])

    def test_catalog_rejects_file_and_directory_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / '文档'
            campaign = root / '战役' / 'c1-测试'
            campaign.mkdir(parents=True)
            outside = Path(directory) / 'outside.pdf'
            outside.write_bytes(b'%PDF-outside')
            outside_dir = Path(directory) / 'outside-dir'
            outside_dir.mkdir()
            (outside_dir / 'nested.pdf').write_bytes(b'%PDF-nested')
            try:
                (campaign / 'linked.pdf').symlink_to(outside)
                (campaign / 'linked-dir').symlink_to(outside_dir, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('symbolic links unavailable')

            catalog = SERVER.document_library_catalog(str(root), 'c1', '测试')
            self.assertEqual(catalog['documents'], [])


class DocxPreviewTests(unittest.TestCase):
    def test_preview_extracts_headings_lists_page_breaks_and_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'module.docx'
            write_docx(path)
            blocks = SERVER.parse_docx_preview(str(path))

        self.assertEqual(blocks[0], {'type': 'heading', 'text': '第一章', 'level': 1})
        self.assertEqual(blocks[1], {'type': 'list', 'text': '整备物资'})
        self.assertEqual(blocks[2], {'type': 'pageBreak'})
        self.assertEqual(blocks[3], {'type': 'list', 'text': '抵达海岸'})
        self.assertEqual(blocks[4], {'type': 'table', 'rows': [['地点', '线索']]})

    def test_preview_rejects_traversal_members(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'unsafe.docx'
            write_docx(path, [('../outside.xml', b'bad')])
            with self.assertRaises(SERVER.DocumentPreviewError):
                SERVER.parse_docx_preview(str(path))

    def test_preview_enforces_zip_entry_and_compression_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            ordinary = Path(directory) / 'ordinary.docx'
            write_docx(ordinary)
            previous_limit = SERVER.MAX_DOCX_ZIP_ENTRIES
            try:
                SERVER.MAX_DOCX_ZIP_ENTRIES = 1
                with self.assertRaises(SERVER.DocumentTooLargeError):
                    SERVER.parse_docx_preview(str(ordinary))
            finally:
                SERVER.MAX_DOCX_ZIP_ENTRIES = previous_limit

            compressed = Path(directory) / 'compressed.docx'
            with zipfile.ZipFile(compressed, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('word/document.xml', b'A' * (1024 * 1024))
            with self.assertRaises(SERVER.DocumentTooLargeError):
                SERVER.parse_docx_preview(str(compressed))


class DocumentRequestSecurityTests(unittest.TestCase):
    def handler(self, client='127.0.0.1', host=None, origin='', fetch_site=''):
        headers = {'Host': host or '127.0.0.1:%d' % SERVER.PORT}
        if origin:
            headers['Origin'] = origin
        if fetch_site:
            headers['Sec-Fetch-Site'] = fetch_site
        return SimpleNamespace(client_address=(client, 50000), headers=headers)

    def test_document_access_requires_local_client_local_host_and_same_origin(self):
        self.assertTrue(SERVER.document_request_allowed(self.handler(fetch_site='same-origin')))
        self.assertFalse(SERVER.document_request_allowed(self.handler(client='203.0.113.9')))
        self.assertFalse(SERVER.document_request_allowed(self.handler(host='example.trycloudflare.com')))
        self.assertFalse(SERVER.document_request_allowed(self.handler(
            origin='https://evil.example', fetch_site='cross-site')))
        self.assertFalse(SERVER.document_request_allowed(self.handler(fetch_site='cross-site')))


class DocumentHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.document_root = self.root / 'asset' / '文档'
        self.campaign = self.document_root / '战役' / 'c185-风骸岛之龙'
        self.campaign.mkdir(parents=True)
        self.pdf_bytes = b'%PDF-1.7\n0123456789abcdef\n%%EOF'
        (self.campaign / '海岛地图.pdf').write_bytes(self.pdf_bytes)
        self.docx_bytes = write_docx(self.campaign / '风骸岛模组.docx')
        self.previous = {
            'ROOT': SERVER.ROOT,
            'DOCUMENT_LIBRARY_ROOT': SERVER.DOCUMENT_LIBRARY_ROOT,
            'STATE': SERVER.STATE,
            'PORT': SERVER.PORT,
        }
        SERVER.ROOT = str(self.root)
        SERVER.DOCUMENT_LIBRARY_ROOT = str(self.document_root)
        SERVER.STATE = {'campaignId': 'c185', 'campaignName': '风骸岛之龙'}
        SERVER.DOCUMENT_LIBRARY_INDEX.clear()
        self.httpd = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        SERVER.PORT = self.httpd.server_port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        SERVER.DOCUMENT_LIBRARY_INDEX.clear()
        for name, value in self.previous.items():
            setattr(SERVER, name, value)
        self.temp.cleanup()

    def request(self, method, path, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        result = (response.status, dict(response.getheaders()), body)
        connection.close()
        return result

    def catalog(self):
        query = urlencode({'campaignId': 'c185', 'campaignName': '风骸岛之龙'})
        status, headers, body = self.request('GET', '/api/document-library?' + query,
                                             {'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        return json.loads(body.decode('utf-8'))

    def test_catalog_preview_and_original_download_contract(self):
        catalog = self.catalog()
        self.assertEqual(catalog['campaignId'], 'c185')
        self.assertEqual(len(catalog['documents']), 2)
        self.assertNotIn(str(self.root), json.dumps(catalog, ensure_ascii=False))
        docx = next(item for item in catalog['documents'] if item['type'] == 'docx')

        status, headers, body = self.request('GET', docx['previewUrl'],
                                             {'Sec-Fetch-Site': 'same-origin'})
        preview = json.loads(body.decode('utf-8'))
        self.assertEqual(status, 200)
        self.assertEqual(preview['document']['id'], docx['id'])
        self.assertEqual(preview['document']['blocks'][0]['type'], 'heading')
        self.assertNotIn('Access-Control-Allow-Origin', headers)

        status, headers, body = self.request('GET', docx['downloadUrl'],
                                             {'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200)
        self.assertEqual(body, self.docx_bytes)
        self.assertEqual(headers['Content-Type'], SERVER.DOCX_MIME)
        self.assertTrue(headers['Content-Disposition'].startswith('attachment;'))

    def test_pdf_supports_full_range_suffix_invalid_range_and_head(self):
        pdf = next(item for item in self.catalog()['documents'] if item['type'] == 'pdf')
        status, headers, body = self.request('GET', pdf['previewUrl'])
        self.assertEqual((status, body), (200, self.pdf_bytes))
        self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertEqual(headers['Accept-Ranges'], 'bytes')
        self.assertTrue(headers['Content-Disposition'].startswith('inline;'))

        status, headers, body = self.request('GET', pdf['previewUrl'], {'Range': 'bytes=5-9'})
        self.assertEqual((status, body), (206, self.pdf_bytes[5:10]))
        self.assertEqual(headers['Content-Range'], 'bytes 5-9/%d' % len(self.pdf_bytes))

        status, headers, body = self.request('GET', pdf['previewUrl'], {'Range': 'bytes=-5'})
        self.assertEqual((status, body), (206, self.pdf_bytes[-5:]))

        status, headers, body = self.request('GET', pdf['previewUrl'], {'Range': 'bytes=999-'})
        self.assertEqual(status, 416)
        self.assertEqual(headers['Content-Range'], 'bytes */%d' % len(self.pdf_bytes))

        status, headers, body = self.request('HEAD', pdf['previewUrl'])
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertEqual(int(headers['Content-Length']), len(self.pdf_bytes))

    def test_document_routes_reject_cross_site_and_static_fallback(self):
        status, headers, body = self.request('GET', '/api/document-library', {
            'Host': 'evil.example', 'Origin': 'https://evil.example',
            'Sec-Fetch-Site': 'cross-site',
        })
        self.assertEqual(status, 403)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        status, headers, body = self.request('OPTIONS', '/api/document-library', {
            'Origin': 'http://127.0.0.1:%d' % self.httpd.server_port,
            'Sec-Fetch-Site': 'same-origin',
        })
        self.assertEqual(status, 204)
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertEqual(self.request('OPTIONS', '/api/document-library', {
            'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site',
        })[0], 403)

        direct = '/asset/%s/%s/%s/%s' % (
            quote('文档'), quote('战役'), quote('c185-风骸岛之龙'), quote('海岛地图.pdf'))
        self.assertEqual(self.request('GET', direct)[0], 404)
        status, headers, body = self.request('HEAD', direct)
        self.assertEqual(status, 404)
        self.assertEqual(body, b'')
        try:
            (self.root / 'public-documents').symlink_to(self.document_root, target_is_directory=True)
        except (OSError, NotImplementedError):
            return
        alias = '/public-documents/%s/%s/%s' % (
            quote('战役'), quote('c185-风骸岛之龙'), quote('海岛地图.pdf'))
        self.assertEqual(self.request('GET', alias)[0], 404)


if __name__ == '__main__':
    unittest.main()
