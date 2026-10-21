"""Optional room-owned portrait defaults; no installation or author identities."""
import json
from pathlib import Path
import re

CONFIG_NAME = '先攻头像默认.json'
ELEMENT_ID = 'sundoll-initiative-portrait-defaults'
MAX_BYTES = 64 * 1024


def read_defaults(save_root):
    """Invalid or missing optional configuration never replaces saved artwork."""
    empty = {'owned': {}, 'presets': {}}
    path = Path(save_root).parent / CONFIG_NAME
    try:
        if path.is_symlink() or not path.is_file(): return empty
        with path.open('rb') as handle: raw = handle.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES: return empty
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get('version') != 1: return empty
        result = {}
        for group in ('owned', 'presets'):
            entries = value.get(group, {})
            if not isinstance(entries, dict) or len(entries) > 256: return empty
            result[group] = {key:url for key,url in entries.items()
                if isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,120}', key)
                and isinstance(url, str) and re.fullmatch(r'/api/module-assets/[a-f0-9]{64}', url)}
        return result
    except (OSError, ValueError, UnicodeError):
        return empty


def bootstrap_markup(save_root):
    data = json.dumps(read_defaults(save_root), ensure_ascii=True, separators=(',', ':'))
    return '<script type="application/json" id="' + ELEMENT_ID + '">' + data.replace('<', '\\u003c') + '</script>'
