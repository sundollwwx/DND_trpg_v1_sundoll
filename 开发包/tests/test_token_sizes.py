from project_test_paths import APP_ROOT
import sys
import unittest
sys.path.insert(0, str(APP_ROOT))
from server.token_sizes import CATEGORIES, size_fields, can_ride, sync_riders


class TokenSizeTests(unittest.TestCase):
    def test_all_ranks_and_legacy_migration(self):
        self.assertEqual(size_fields({'size': 1})['sizeCategory'], 'medium')
        for index, category in enumerate(CATEGORIES):
            self.assertEqual(size_fields({'sizeCategory': category})['size'], [.5, 1, 1, 2, 3, 4][index])
            for other, mount in enumerate(CATEGORIES):
                self.assertEqual(can_ride({'sizeCategory': category}, {'sizeCategory': mount}), other > index)

    def test_nested_riders_follow_root(self):
        tiny = {'id': 't', 'sizeCategory': 'tiny', 'mountId': 's'}
        small = {'id': 's', 'sizeCategory': 'small', 'mountId': 'm'}
        medium = {'id': 'm', 'sizeCategory': 'medium', 'x': 75, 'y': 125}
        sync_riders({'tokens': [tiny, small, medium]})
        self.assertEqual((tiny['x'], small['y']), (75, 125))
