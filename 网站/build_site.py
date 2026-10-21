#!/usr/bin/env python3
"""Build a self-contained Pages upload with content-addressed static assets."""

import argparse
import hashlib
from html import escape
from html.parser import HTMLParser
import json
from datetime import date
from pathlib import Path
import re
import tempfile
from urllib.parse import unquote, urlsplit
import zipfile


PUBLIC_FILES = (
    "index.html", "about.html", "style.css", "site.js", "announcements.json",
    "_headers", "_redirects", "assets/sundoll-logo.png", "assets/world-background.png",
    "assets/about-background.png", "assets/theseus-puzzle.png",
    "announcements.js", "puzzle.js", "guestbook.js", "site-account.js",
    "assets/legendary-news-background.png",
)
ASSETS = (
    "assets/sundoll-logo.png", "assets/world-background.png", "assets/about-background.png",
    "assets/theseus-puzzle.png",
    "site.js", "announcements.js", "puzzle.js", "guestbook.js", "site-account.js",
    "assets/legendary-news-background.png",
)
HTML_REFERENCE = re.compile(r"\b(src|href)(\s*=\s*)([\"'])([^\"']*)\3", re.IGNORECASE)
CSS_REFERENCE = re.compile(r"url\(\s*([\"']?)([^\"')]+)\1\s*\)", re.IGNORECASE)


def fingerprint(name, content):
    path = Path(name)
    return str(path.with_name(f"{path.stem}.{hashlib.sha256(content).hexdigest()[:12]}{path.suffix}"))


def rewrite_html(text, mapping):
    def replace(match):
        attr, spacing, quote, value = match.groups()
        return f"{attr}{spacing}{quote}{mapping.get(value, value)}{quote}"
    return HTML_REFERENCE.sub(replace, text)


def rewrite_css(text, mapping):
    def replace(match):
        quote, value = match.groups()
        replacement = mapping.get(value.strip())
        return f"url({quote}{replacement}{quote})" if replacement else match.group(0)
    return CSS_REFERENCE.sub(replace, text)


def build_headers(source, hashed_paths):
    # Preserve security and redirect-related headers; replace cache rules.
    blocks = []
    route, headers = None, []
    for line in source.splitlines() + ["END"]:
        if line and not line[0].isspace():
            if route is not None and headers:
                blocks.append("\n".join([route] + headers))
            route, headers = line, []
        elif line.strip() and not line.strip().lower().startswith("cache-control:"):
            headers.append(line)
    for route in ("/", "/index.html", "/about", "/about.html", "/announcements.json", "/ui-assets-sw.js"):
        blocks.append(f"{route}\n  Cache-Control: no-cache, max-age=0, must-revalidate")
    for route in sorted(hashed_paths):
        blocks.append(f"{route}\n  Cache-Control: public, max-age=31536000, immutable")
    return "\n\n".join(blocks) + "\n"


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("src", "href") and value:
                self.urls.append(value)


def validate_package(files, mapping, article_paths=()):
    expected = {mapping.get(f"/{name}", f"/{name}").lstrip("/") for name in PUBLIC_FILES}
    expected.update(article_paths)
    expected.update(path.lstrip('/') for path in mapping.values())
    expected.add('ui-assets-sw.js')
    assert set(files) == expected, "Unexpected public files"
    assert "index.html" in files, "Missing root index.html"
    for target in mapping.values():
        name = target.lstrip("/")
        assert name in files, f"Missing fingerprinted asset: {name}"
        assert hashlib.sha256(files[name]).hexdigest()[:12] == Path(name).stem.rsplit(".", 1)[1], name
    for name, content in files.items():
        urls = []
        if name.endswith(".html"):
            parser = References()
            parser.feed(content.decode("utf-8"))
            urls = parser.urls
        elif name.endswith(".css"):
            urls = [match.group(2).strip() for match in CSS_REFERENCE.finditer(content.decode("utf-8"))]
        for url in urls:
            parts = urlsplit(url)
            if parts.scheme or parts.netloc or not parts.path:
                continue
            path = unquote(parts.path).lstrip("/") if parts.path.startswith("/") else str(Path(name).parent / unquote(parts.path))
            path = path or "index.html"
            assert path in files, f"Missing local reference in {name}: {url}"
            assert url not in mapping, f"Unversioned asset reference in {name}: {url}"
    json.loads(files["announcements.json"].decode("utf-8"))


def read_announcements(content):
    items = json.loads(content.decode("utf-8"))
    if not isinstance(items, list):
        raise ValueError("Announcements must be a list")
    ids = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("title"), str) or not item["title"].strip():
            raise ValueError("Each announcement needs a title")
        notice_id = item.get("id")
        if not isinstance(notice_id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", notice_id) or notice_id in ids:
            raise ValueError("Announcement IDs must be unique URL-safe names")
        ids.add(notice_id)
        item_date = item.get("date")
        if not isinstance(item_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item_date):
            raise ValueError("Announcement dates must use YYYY-MM-DD")
        date.fromisoformat(item_date)
        body = item.get("body", [])
        if not isinstance(body, list) or not all(isinstance(paragraph, str) for paragraph in body):
            raise ValueError("Announcement bodies must be lists of plain-text paragraphs")
        item["body"] = [paragraph.strip() for paragraph in body if paragraph.strip()]
        background = item.get("background", "")
        if not isinstance(background, str) or (background and background not in ASSETS):
            raise ValueError("Announcement backgrounds must use an allowed public image")
        if background and not background.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            raise ValueError("Announcement backgrounds must be images")
    return sorted(items, key=lambda item: item["date"], reverse=True)


def render_announcements(index, items):
    articles = []
    for item in items:
        title = escape(item["title"])
        if item["body"]:
            title = f'<a class="announcement-title-link" href="/news/{item["id"]}.html">{title}</a>'
        articles.append(f'<article class="announcement" data-notice-id="{item["id"]}"><time datetime="{item["date"]}">{item["date"].replace("-", ".")}</time><h3>{title}</h3><span class="announcement-star" aria-hidden="true">✦</span></article>')
    marker = re.compile(r"<!-- ANNOUNCEMENTS -->.*?<!-- /ANNOUNCEMENTS -->", re.DOTALL)
    replacement = "<!-- ANNOUNCEMENTS -->\n          " + "\n          ".join(articles) + "\n          <!-- /ANNOUNCEMENTS -->"
    index, count = marker.subn(lambda match: replacement, index)
    if count != 1:
        raise ValueError("Homepage needs exactly one announcement template region")
    return index


def build(source, output, archive):
    original = {name: (source / name).read_bytes() for name in PUBLIC_FILES}
    # One palette source for Pages and the local/room clients, bundled locally.
    design = Path(__file__).resolve().parent.parent / '程序包/主程序/shared/design-system.css'
    original['style.css'] += b'\n' + design.read_bytes()
    announcements = read_announcements(original["announcements.json"])
    mapping = {}
    files = {}
    for name in ASSETS:
        target = fingerprint(name, original[name])
        files[target] = original[name]
        mapping[f"/{name}"] = f"/{target}"
    shared = design.parent
    registration = (shared / 'ui-assets-cache.js').read_bytes()
    registration_name = fingerprint('ui-assets-cache.js', registration)
    files[registration_name] = registration
    mapping['/ui-assets-cache.js'] = '/' + registration_name
    artwork = [dict(url='/' + name, cacheUrl=mapping['/' + name],
                    digest=hashlib.sha256(original[name]).hexdigest(), size=len(original[name]))
               for name in ASSETS if name.startswith('assets/')]
    worker = (shared / 'ui-assets-sw.js').read_text('utf-8')
    files['ui-assets-sw.js'] = worker.replace('/*__UI_ASSETS__*/ []', json.dumps(artwork, ensure_ascii=True, separators=(',', ':'))).encode('utf-8')
    css = rewrite_css(original["style.css"].decode("utf-8"), mapping).encode("utf-8")
    css_name = fingerprint("style.css", css)
    files[css_name] = css
    mapping["/style.css"] = f"/{css_name}"
    for name in ("index.html", "about.html"):
        html = original[name].decode("utf-8")
        if name == "index.html":
            html = render_announcements(html, announcements)
        files[name] = rewrite_html(html, mapping).encode("utf-8")
    article_paths = []
    template = (Path(__file__).resolve().parent / "announcement-template.html").read_text(encoding="utf-8")
    for item in announcements:
        if not item["body"]:
            continue
        values = {
            "TITLE": escape(item["title"]), "DATE": item["date"],
            "DISPLAY_DATE": item["date"].replace("-", "."),
            "DESCRIPTION": escape(item["body"][0][:160]),
            "BODY": "\n".join(f"<p>{escape(paragraph)}</p>" for paragraph in item["body"]),
            "PAGE_CLASS": "",
            "BACKGROUND": "",
        }
        if item.get("background"):
            values["PAGE_CLASS"] = " news-page-illustrated"
            values["BACKGROUND"] = f'<div class="news-landscape" aria-hidden="true"><img src="/{escape(item["background"])}" alt="" decoding="async" fetchpriority="high"></div>'
        html = re.sub(r"\{\{([A-Z_]+)\}\}", lambda match: values[match.group(1)], template)
        path = f'news/{item["id"]}.html'
        files[path] = rewrite_html(html, mapping).encode("utf-8")
        article_paths.append(path)
    for name in ("announcements.json", "_redirects"):
        files[name] = original[name]
    for name in ('index.html', 'about.html', *article_paths):
        html = files[name].decode('utf-8')
        script = '<script src="' + mapping['/ui-assets-cache.js'] + '" defer></script>\n'
        files[name] = html.replace('</head>', script + '</head>', 1).encode('utf-8')
    headers = build_headers(original["_headers"].decode("utf-8"), mapping.values())
    headers += "\n/news/*\n  Cache-Control: no-cache, max-age=0, must-revalidate\n"
    files["_headers"] = headers.encode("utf-8")
    validate_package(files, mapping, article_paths)

    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output directory must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, files[name])
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None, "Archive integrity check failed"
        assert set(bundle.namelist()) == set(files), "Archive contains unexpected files"
        assert all(bundle.read(name) == content for name, content in files.items()), "Archive content mismatch"
    return {"output_directory": str(output), "upload_zip": str(archive), "public_file_count": len(files), "fingerprinted_assets": mapping}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent / "主站")
    parser.add_argument("--output", type=Path, help="Empty public output directory; defaults to a new /private/tmp directory")
    parser.add_argument("--zip", dest="archive", type=Path, help="Upload ZIP path; defaults to the output directory name plus .zip")
    args = parser.parse_args()
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="sundollworld-site-", dir="/private/tmp"))
    archive = args.archive.resolve() if args.archive else output.with_suffix(".zip")
    if archive == output or output in archive.parents:
        parser.error("The ZIP must be outside the public output directory")
    try:
        result = build(args.source.resolve(), output, archive)
    except (OSError, ValueError, AssertionError) as error:
        parser.exit(1, f"Build failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
