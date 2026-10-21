from project_test_paths import APP_ROOT
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from server.static_policy import static_file_allowed
from server.room_gateway import Supervisor


class HostLoadingAssetTests(unittest.TestCase):
    def test_loading_assets_are_available_to_dm_only(self):
        for name in ['主控台/host/load-progress.js', '主控台/host/load-progress.css']:
            with self.subTest(name=name):
                self.assertTrue(static_file_allowed(APP_ROOT, APP_ROOT / name, True))
                self.assertFalse(static_file_allowed(APP_ROOT, APP_ROOT / name, False))

    def test_room_bundle_carries_the_loading_assets_without_starting_a_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            source = root / 'source'
            files = ['主控台/host/load-progress.js', '主控台/host/load-progress.css']
            for name in files:
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((APP_ROOT / name).read_bytes())
            app = SimpleNamespace(ROOT=source, account_store=lambda: SimpleNamespace(root=root / 'runtime' / 'accounts'))
            supervisor = Supervisor(app)
            try:
                bundle = supervisor.prepare_bundle()
                self.assertFalse(supervisor.workers)
                for name in files:
                    self.assertEqual((bundle / name).read_bytes(), (source / name).read_bytes())
            finally:
                supervisor.close()


if __name__ == '__main__':
    unittest.main()
