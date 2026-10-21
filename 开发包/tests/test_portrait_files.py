from project_test_paths import APP_ROOT
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from server.workspace import enable
from server.module_store import ModuleStore
from server.portrait_files import sync_directory

class PortraitFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.save=enable(Path(self.tmp.name)/'程序包',{'c1':'c1-冒险'},{'c1':'冒险'})
        self.store=ModuleStore(self.save)
        self.url=self.store.put_asset(b'\x89PNG-original','image/png','test')
    def write(self,pieces):
        with self.store.transaction() as db:
            old=self.store.document(db,'player-library','p1')
            self.store.write_document(db,'player-library','p1','p1',dict(pieces=pieces),old['revision'] if old else 0)
    def piece(self,identity='a',name='角色'):
        return dict(ownedPieceId=identity,name=name,iconImgPath=self.url,portraitVariants=[dict(name='常态',iconImgPath=self.url)])
    def files(self):
        return json.loads((self.store.workspace.player('p1')/'棋子立绘/立绘索引.json').read_text())['files']
    def test_same_names_remain_independent_and_deletion_cleans_only_managed_files(self):
        self.write([self.piece('a'),self.piece('b')]);files=self.files();self.assertEqual(len(files),2);self.assertNotEqual(files[0]['path'],files[1]['path'])
        root=self.store.workspace.player('p1')/'棋子立绘';(root/'我的备注.txt').write_text('keep')
        self.write([self.piece('b')]);self.assertFalse((root/files[0]['path']).exists());self.assertTrue((root/'我的备注.txt').exists())
        self.assertEqual((root/self.files()[0]['path']).read_bytes(),b'\x89PNG-original')
    def test_rename_unsafe_names_and_html_are_safe(self):
        self.write([self.piece(name='../<script>')]);root=self.store.workspace.player('p1')/'棋子立绘';old=self.files()[0]['path']
        self.assertNotIn('<script>',(root/'浏览立绘.html').read_text())
        self.assertTrue((root/old).is_file());self.write([self.piece(name='新名字')]);self.assertFalse((root/old).exists());self.assertIn('新名字',self.files()[0]['path'])
    def test_reclassification_moves_readable_portraits_with_template(self):
        data=dict(id='npc',name='龙',iconImgPath=self.url)
        with self.store.transaction() as db:self.store.write_document(db,'template','npc','general:基础',data,0)
        with self.store.transaction() as db:db.execute("UPDATE documents SET owner='campaign:c1',revision=revision+1 WHERE kind='template' AND id='npc'")
        self.assertFalse(list((self.store.workspace.general/'基础/棋子立绘').rglob('*.png')))
        self.assertEqual(len(list((self.store.workspace.campaign('c1')/'棋子立绘').rglob('*.png'))),1)
    def test_copies_cannot_modify_original_and_symlinks_are_rejected(self):
        self.write([self.piece()]);root=self.store.workspace.player('p1')/'棋子立绘';p=root/self.files()[0]['path'];p.write_bytes(b'edited')
        self.assertEqual(self.store.asset_path(self.url.rsplit('/',1)[-1]).read_bytes(),b'\x89PNG-original')
        with self.assertRaises(ValueError):sync_directory(self.store,root.parent)
        p.unlink();p.symlink_to(self.store.asset_path(self.url.rsplit('/',1)[-1]))
        with self.assertRaises(ValueError):sync_directory(self.store,root.parent)

    def test_gallery_failure_does_not_poison_committed_save_or_future_reads(self):
        with mock.patch('server.portrait_files.sync_directory', side_effect=OSError('gallery unavailable')), \
                self.assertLogs('server.workspace', level='ERROR') as logged:
            self.write([self.piece()])
        self.assertIn('正式存档已提交', logged.output[0])
        db = self.store.connect()
        try:
            self.assertEqual(self.store.document(db, 'player-library', 'p1')['data']['pieces'][0]['name'], '角色')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM module_outbox').fetchone()[0], 0)
        finally:
            db.close()
        self.assertFalse((self.store.workspace.root/'运行数据/模块发布中.json').exists())
        self.write([self.piece(name='恢复后')])
        self.assertIn('恢复后', self.files()[0]['path'])
