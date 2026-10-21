"""Filesystem locations; HTTP URLs remain relative to APP_ROOT.

Keep user saves outside application code. Resolving from this file allows the
whole project to move without depending on the shell's working directory.
"""
import os
import json
import hashlib
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = APP_ROOT.parent
CHECKOUT_ROOT = PACKAGE_ROOT.parent
def sibling_layout():
    try:
        return json.loads((APP_ROOT / 'distribution.json').read_text('utf-8')).get('format') == 4
    except (OSError, ValueError):
        return (APP_ROOT / '模块.json').is_file()


_workspace_override = os.environ.get('SUNDOLL_WORKSPACE_ROOT', '').strip()
WORKSPACE_ROOT = Path(_workspace_override).expanduser() if _workspace_override else None
if WORKSPACE_ROOT is not None:
    if not WORKSPACE_ROOT.is_absolute():
        raise ValueError('SUNDOLL_WORKSPACE_ROOT 必须是工作区根目录的绝对路径')
    WORKSPACE_ROOT = WORKSPACE_ROOT.absolute()
USER_DATA_ROOT = (WORKSPACE_ROOT / '运行数据' if WORKSPACE_ROOT is not None else
                  PACKAGE_ROOT / ('运行数据' if sibling_layout() else '用户数据'))
SAVE_ROOT = USER_DATA_ROOT / '存档'
CACHE_ROOT = USER_DATA_ROOT / '.sundoll-cache'
MUSIC_CACHE_ROOT = USER_DATA_ROOT / '音乐缓存'
ASSET_ROOT = APP_ROOT / 'asset'


def local_save_root():
    """Tests may select isolated saves; never create directories on import."""
    # A production workspace selection must not be silently redirected by a
    # test-only variable inherited from another terminal.
    if WORKSPACE_ROOT is not None:
        return str(SAVE_ROOT)
    return os.environ.get('SUNDOLL_TEST_SAVE_ROOT') or str(SAVE_ROOT)


def project_id(app_root=None):
    """Preserve the product identity; distinguish shared code with separate data."""
    source = os.path.normcase(os.path.realpath(str(app_root or APP_ROOT)))
    if WORKSPACE_ROOT is not None:
        workspace = os.path.normcase(os.path.realpath(str(USER_DATA_ROOT.parent)))
        source += '\0workspace:' + workspace
    return hashlib.sha256(source.encode('utf-8')).hexdigest()
