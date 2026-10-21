"""Reject invalid numeric values before a request can mutate runtime state."""
import unittest
from project_test_paths import APP_ROOT
from server.http_json import loads


class HttpJsonTests(unittest.TestCase):
    def test_nonfinite_literals_and_numeric_overflow_are_rejected(self):
        for value in ('NaN', 'Infinity', '-Infinity', '1e309', '-1e309'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                loads('{"state":{"values":[' + value + ']}}')

    def test_names_containing_special_words_remain_valid_text(self):
        self.assertEqual(loads('{"name":"NaN Infinity 1e309","value":1.25,"count":2}'),
            dict(name='NaN Infinity 1e309', value=1.25, count=2))


if __name__ == '__main__':
    unittest.main()
