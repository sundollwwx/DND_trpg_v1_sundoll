"""Disposable, content-addressed display images; originals stay untouched."""
import hashlib
import os
from pathlib import Path
import re
import secrets
import threading
import warnings

try:
    from PIL import Image, ImageOps
except ImportError:  # Portable installs still serve the original image.
    Image = ImageOps = None

VERSION = 'display-v1'
VARIANTS = {'token-192': (192, 84), 'token-512': (512, 86), 'map': (4096, 88)}
_LOCKS = [threading.Lock() for _ in range(16)]
_ENCODERS = threading.BoundedSemaphore(2)
MAX_PIXELS = 48_000_000


def display_asset(source, mime, digest, variant, cache_root):
    """Return path, MIME, length, ETag after the caller authorizes the original.

    A derivative URL never grants access. It is keyed by the immutable source
    digest and encoder version, and may be deleted without losing user data.
    """
    source = Path(source)
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('资源编号无效')
    original = (source, mime, source.stat().st_size, 'original-' + digest)
    if not variant:
        return original
    if variant not in VARIANTS:
        raise ValueError('显示版本无效')
    if Image is None or mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'):
        return original
    key = hashlib.sha256((VERSION + ':' + digest + ':' + variant).encode()).hexdigest()
    target = Path(cache_root) / VERSION / key[:2] / (key + '.webp')
    unchanged = target.with_suffix('.original')
    with _LOCKS[int(key[:2], 16) % len(_LOCKS)]:
        if target.is_file() and target.stat().st_size:
            return target, 'image/webp', target.stat().st_size, key
        if unchanged.is_file():
            return original
        temporary = target.with_name(key + '.' + secrets.token_hex(8) + '.tmp')
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with _ENCODERS, warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(source) as image:
                    if image.width * image.height > MAX_PIXELS or getattr(image, 'is_animated', False):
                        return original
                    image = ImageOps.exif_transpose(image)
                    limit, quality = VARIANTS[variant]
                    image.thumbnail((limit, limit), Image.Resampling.LANCZOS)
                    image = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
                    image.save(temporary, 'WEBP', quality=quality, method=4)
            if temporary.stat().st_size >= original[2]:
                temporary.write_bytes(b'original')
                os.replace(temporary, unchanged)
                return original
            os.replace(temporary, target)
            return target, 'image/webp', target.stat().st_size, key
        except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            return original
        finally:
            if temporary.exists():
                temporary.unlink()
