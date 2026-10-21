from project_test_paths import APP_ROOT
import sys,unittest
sys.path.insert(0,str(APP_ROOT))
from server.asset_cache import AssetCache

class AssetCacheTests(unittest.TestCase):
    def test_lru_and_byte_budget(self):
        cache=AssetCache(6)
        cache['a']=('x',b'aaa');cache['b']=('x',b'bb')
        self.assertEqual(cache.get('a'),('x',b'aaa'))
        cache['c']=('x',b'ccc')
        self.assertNotIn('b',cache);self.assertEqual(cache.bytes,6)
        self.assertEqual(list(cache),['a','c'])
    def test_large_assets_not_retained_and_replacement_accounted(self):
        cache=AssetCache(4);cache['a']=('x',b'1234')
        cache['large']=('x',b'12345')
        self.assertEqual(cache.bytes,4);self.assertNotIn('large',cache)
        cache['a']=('x',b'1');self.assertEqual(cache.bytes,1)
        del cache['a'];self.assertEqual(cache.bytes,0)
        cache['b']=('x',b'1');cache.clear();self.assertEqual(cache.bytes,0)
