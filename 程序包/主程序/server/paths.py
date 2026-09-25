"""Filesystem locations; HTTP URLs remain relative to APP_ROOT.

Keep user saves outside application code. Resolving from this file allows the
whole project to move without depending on the shell's working directory.
"""
import os
import json
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = APP_ROOT.parent
CHECKOUT_ROOT = PACKAGE_ROOT.parent
def sibling_layout():
    try:
        return json.loads((APP_ROOT / 'distribution.json').read_text('utf-8')).get('format') == 4
    except (OSError, ValueError):
        return (APP_ROOT / '模块.json').is_file()


USER_DATA_ROOT = PACKAGE_ROOT / ('运行数据' if sibling_layout() else '用户数据')
SAVE_ROOT = USER_DATA_ROOT / '存档'
CACHE_ROOT = USER_DATA_ROOT / '.sundoll-cache'
MUSIC_CACHE_ROOT = USER_DATA_ROOT / '音乐缓存'
ASSET_ROOT = APP_ROOT / 'asset'


def local_save_root():
    """Tests may select isolated saves; never create directories on import."""
    return os.environ.get('SUNDOLL_TEST_SAVE_ROOT') or str(SAVE_ROOT)
