from project_test_paths import APP_ROOT, PACKAGE_ROOT, CHECKOUT_ROOT, TOOLS_ROOT
import http.client
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote
from test_local_save_bridge import SERVER

class StaticHttpBoundaryTests(unittest.TestCase):
    def test_get_head_private_files_traversal_symlinks_and_public_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths=['存档/战役/c1/当前存档.json','备团/秘密.md','output/候选.png','docs/审计.md',
                   '主控台/玩家.html','shared/protocol.js','asset/界面/logo.png','主控台/主控台.html']
            for name in paths:
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('test')
            (root/'asset/界面/leak.png').symlink_to(root/paths[0])
            with mock.patch.object(SERVER,'ROOT',directory):
                httpd=SERVER.Server(('127.0.0.1',0),SERVER.Handler)
                port_patch=mock.patch.object(SERVER,'PORT',httpd.server_port)
                port_patch.start()
                thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
                try:
                    for method in ['GET','HEAD']:
                        for name in paths[:4]+['asset/','asset/界面/leak.png','asset/../存档/战役/c1/当前存档.json']:
                            conn=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=3)
                            conn.request(method,'/'+quote(name));response=conn.getresponse();response.read();self.assertEqual(response.status,404,(method,name));conn.close()
                        for name in paths[4:]:
                            conn=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=3)
                            conn.request(method,'/'+quote(name));response=conn.getresponse();response.read();self.assertEqual(response.status,200,(method,name));conn.close()
                finally:
                    httpd.shutdown();httpd.server_close();thread.join(timeout=3)
                    port_patch.stop()
