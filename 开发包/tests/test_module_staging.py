from project_test_paths import APP_ROOT
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from server.module_staging import ModuleStaging, RETENTION_SECONDS


class ModuleStagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name);self.manager=ModuleStaging(self.root)

    def file(self,kind,name,age=0):
        path=self.manager.path(kind,name);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'transfer')
        stamp=time.time()-age;os.utime(path,(stamp,stamp));return path

    def test_only_expired_transfer_copies_are_deleted(self):
        expired=self.file('export','a'*32+'.zip',RETENTION_SECONDS+10)
        retry=self.file('export','b'*32+'.zip',60)
        source=self.root/'canonical.json';source.write_text('keep')
        result=self.manager.cleanup(force=True)
        self.assertEqual(result,[expired.name]);self.assertFalse(expired.exists())
        self.assertTrue(retry.exists());self.assertTrue(source.exists())

    def test_import_pair_is_retained_together_and_failed_operation_remains_retryable(self):
        archive=self.file('import','a'*32+'.sundoll',RETENTION_SECONDS+10)
        metadata=self.file('import','a'*32+'.json',30)
        self.assertEqual(self.manager.cleanup(force=True),[])
        with self.assertRaises(OSError):
            with self.manager.lease('import',archive.name):raise OSError('retry this import')
        self.assertTrue(archive.exists());self.assertTrue(metadata.exists())
        self.assertLess(time.time()-archive.stat().st_mtime,2)

    def test_another_thread_cannot_delete_active_download_or_upload(self):
        for kind,extension in [('export','.zip'),('import','.sundoll')]:
            path=self.file(kind,'c'*32+extension,RETENTION_SECONDS+10)
            with self.manager.lease(kind,path.name):
                removed=[]
                thread=threading.Thread(target=lambda:removed.extend(ModuleStaging(self.root).cleanup(force=True,now=time.time()+2*RETENTION_SECONDS)))
                thread.start();thread.join(3)
                self.assertFalse(thread.is_alive());self.assertTrue(path.exists());self.assertNotIn(path.name,removed)
            self.assertTrue(path.exists())

    def test_symlinks_and_unrecognized_files_are_not_followed_or_deleted(self):
        target=self.root/'private';target.write_text('keep')
        folder=self.manager.directory('export');folder.mkdir(parents=True)
        link=folder/('d'*32+'.zip');link.symlink_to(target)
        unknown=folder/'notes.txt';unknown.write_text('keep')
        with self.assertRaises(ValueError):
            with self.manager.lease('export',link.name):pass
        self.manager.cleanup(force=True,now=time.time()+2*RETENTION_SECONDS)
        self.assertTrue(target.exists());self.assertTrue(unknown.exists())

    def test_cleanup_directory_io_failure_does_not_break_an_active_transfer(self):
        path=self.file('export','e'*32+'.zip',RETENTION_SECONDS+10)
        with mock.patch.object(Path,'iterdir',side_effect=OSError('temporary directory failure')):
            with self.manager.lease('export',path.name) as leased:
                self.assertEqual(leased.read_bytes(),b'transfer')
                self.assertEqual(self.manager.cleanup(force=True),[])
        self.assertTrue(path.exists())
