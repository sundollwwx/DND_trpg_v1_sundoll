import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
from project_test_paths import APP_ROOT
from server import media_variants as media
try:
    from PIL import Image
except ImportError:
    Image = None


@unittest.skipIf(Image is None, 'Pillow not installed; runtime falls back to originals')
class DisplayAssetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'original.png'
        # Uncompressed source ensures a real derivative wins even for tiny fixtures.
        image = Image.new('RGBA', (1200, 800), (10, 60, 90, 128))
        image.putpixel((0, 0), (0, 0, 0, 0)); image.save(self.source, compress_level=0)
        self.raw = self.source.read_bytes(); self.digest = hashlib.sha256(self.raw).hexdigest()

    def render(self, variant='token-512'):
        return media.display_asset(self.source, 'image/png', self.digest, variant, self.root/'cache')

    def test_token_size_aspect_transparency_and_original_are_preserved(self):
        path, mime, size, etag = self.render()
        self.assertEqual(mime, 'image/webp'); self.assertLess(size, len(self.raw)//10)
        with Image.open(path) as image:
            self.assertEqual(image.size, (512, 341)); self.assertIn('A', image.getbands())
            self.assertAlmostEqual(image.getpixel((250, 180))[3], 128, delta=2)
        self.assertEqual(self.source.read_bytes(), self.raw)
        self.assertEqual(self.render(), (path, mime, size, etag))
        self.assertNotEqual(self.render('token-192')[3], etag)

    def test_map_keeps_source_dimensions_and_does_not_crop(self):
        path, *_ = self.render('map')
        with Image.open(path) as image: self.assertEqual(image.size, (1200, 800))
        wide = self.root/'wide.png'
        Image.new('RGB', (4400, 220), 'navy').save(wide, compress_level=0)
        digest = hashlib.sha256(wide.read_bytes()).hexdigest()
        output, *_ = media.display_asset(wide, 'image/png', digest, 'map', self.root/'cache')
        with Image.open(output) as image: self.assertEqual(image.size, (4096, 205))

    def test_concurrent_derivation_leaves_one_complete_file(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.render(), range(12)))
        self.assertTrue(all(r == results[0] for r in results))
        with Image.open(results[0][0]) as image: image.load()
        self.assertEqual(list((self.root/'cache').rglob('*.tmp')), [])

    def test_bad_input_and_unavailable_encoder_keep_original(self):
        with self.assertRaises(ValueError): self.render('../../outside')
        with mock.patch.object(media, 'Image', None): self.assertEqual(self.render()[0], self.source)
        with mock.patch.object(media, 'MAX_PIXELS', 1): self.assertEqual(self.render()[0], self.source)
        self.source.write_bytes(b'not an image')
        self.assertEqual(self.render()[0], self.source)

    def test_animated_images_are_not_flattened(self):
        gif=self.root/'animated.gif'
        Image.new('RGB',(20,20),'red').save(gif,save_all=True,append_images=[Image.new('RGB',(20,20),'blue')],duration=100,loop=0)
        digest=hashlib.sha256(gif.read_bytes()).hexdigest()
        self.assertEqual(media.display_asset(gif,'image/gif',digest,'token-512',self.root/'cache')[0],gif)

    def test_tiny_original_is_not_replaced_by_larger_display_file(self):
        self.source.write_bytes(self.raw)
        with mock.patch.object(media.Image.Image,'save',side_effect=lambda p,*a,**k:Path(p).write_bytes(self.raw+b'larger')):
            self.assertEqual(self.render()[0], self.source)
        with mock.patch.object(media.Image,'open',side_effect=AssertionError('unneeded encode')):
            self.assertEqual(self.render()[0], self.source)
