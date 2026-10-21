"""Versioned public interface artwork; never campaign, character or account data."""
import hashlib
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import quote, unquote, urlsplit

from .static_policy import PUBLIC_FILES, static_file_allowed

IMAGE_EXTENSIONS = frozenset({'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf'})
_lock = threading.Lock()
_catalogs = {}


def catalogue(root):
    root = Path(root).absolute()
    candidates = list((root / 'asset/界面').rglob('*'))
    candidates.extend(root / name for name in PUBLIC_FILES if Path(name).suffix.lower() in IMAGE_EXTENSIONS)
    files = sorted({p for p in candidates if p.suffix.lower() in IMAGE_EXTENSIONS and static_file_allowed(root, p)})
    signature = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size, p.stat().st_ctime_ns) for p in files)
    with _lock:
        previous = _catalogs.get(str(root))
        if previous and previous[0] == signature:
            return previous[1]
        entries = []
        for path in files:
            body = path.read_bytes()
            digest = hashlib.sha256(body).hexdigest()
            relative = path.relative_to(root).as_posix()
            url = '/' + quote(relative, safe='/')
            entries.append(dict(url=url, cacheUrl='/ui-assets/' + digest + url,
                                digest=digest, size=len(body)))
        # Each running workspace normally has one root; bound transient preview roots.
        if len(_catalogs) >= 8:
            _catalogs.pop(next(iter(_catalogs)))
        _catalogs[str(root)] = signature, entries
        return entries


def worker_source(template, entries):
    return template.replace('/*__UI_ASSETS__*/ []', json.dumps(entries, ensure_ascii=True, separators=(',', ':'))).encode('utf-8')


def handle(handler, app):
    path = urlsplit(handler.path).path
    if path not in ('/ui-assets-sw.js', '/ui-assets-manifest.json', '/shared/ui-assets-cache.js') and not path.startswith('/ui-assets/'):
        return False
    root = Path(app.ROOT)
    try:
        if path == '/ui-assets-manifest.json':
            body = json.dumps({'assets': catalogue(root)}, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
            mime, control = 'application/json; charset=utf-8', 'no-cache'
        elif path == '/ui-assets-sw.js':
            body = worker_source((root / 'shared/ui-assets-sw.js').read_text('utf-8'), catalogue(root))
            mime, control = 'application/javascript; charset=utf-8', 'no-cache'
        elif path == '/shared/ui-assets-cache.js':
            body = (root / 'shared/ui-assets-cache.js').read_bytes()
            mime, control = 'application/javascript; charset=utf-8', 'no-cache'
        else:
            entry = next((item for item in catalogue(root) if item['cacheUrl'] == path), None)
            if entry is None:
                handler.send_error(404); return True
            target = root / unquote(entry['url']).lstrip('/')
            if not static_file_allowed(root, target):
                handler.send_error(404); return True
            body = target.read_bytes()
            if hashlib.sha256(body).hexdigest() != entry['digest']:
                handler.send_error(404); return True
            mime = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
            control = 'public, max-age=31536000, immutable'
    except OSError:
        handler.send_error(404); return True
    etag = '"' + hashlib.sha256(body).hexdigest() + '"'
    matched = etag in [value.strip().removeprefix('W/') for value in handler.headers.get('If-None-Match', '').split(',')]
    handler._public_ui_response = True
    handler.send_response(304 if matched else 200)
    handler.send_header('Content-Type', mime)
    handler.send_header('Cache-Control', control)
    handler.send_header('ETag', etag)
    handler.send_header('X-Content-Type-Options', 'nosniff')
    if path == '/ui-assets-sw.js':
        handler.send_header('Service-Worker-Allowed', '/')
    if not matched:
        handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    if not matched and handler.command != 'HEAD':
        handler.wfile.write(body)
    return True
