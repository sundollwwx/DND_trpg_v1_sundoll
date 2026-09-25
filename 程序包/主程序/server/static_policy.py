"""Explicit public-file boundary, independent of HTTP transport."""
import os
from pathlib import Path

PUBLIC_FILES = frozenset({
    '主控台/shared/chest-locked.svg', '主控台/shared/chest-unlocked.svg',
    '主控台/shared/map-items.js', '主控台/shared/map-items.css',
    '主控台/shared/downed-portrait.js',
    '主控台/shared/danmaku.js', '主控台/shared/danmaku.css',
    '主控台/封面背景.png', '主控台/玩家.html', '主控台/player/player.js', '主控台/player/player.css',
    '主控台/shared/journal.js', '主控台/shared/journal.css', '主控台/shared/player-library.js',
    '主控台/shared/travel-basket.js', '主控台/shared/travel-basket.css',
    '主控台/shared/backpack.js', '主控台/shared/backpack.css',
    'shared/workspace-session.js', 'shared/token-size.js', 'shared/rules.js', 'shared/protocol.js', '主控台/vendor/three.min.js', '主控台/shared/dice.js',
    'asset/界面/休息动画/休息场景.js', 'asset/界面/休息动画/休息音频.js',
    'asset/界面/休息动画/休息动画.css',
})
HOST_FILES = frozenset({
    '主控台/主控台.html', '主控台/host/app.js', '主控台/host/style.css',
    '主控台/host/bootstrap.js', '主控台/host/music.js', '主控台/host/storage.js', '主控台/host/documents.js',
    '主控台/host/item-library.js', '主控台/host/item-library.css',
    '主控台/host/travel-basket.js',
    '主控台/host/modules.js', '主控台/host/modules.css',
    '主控台/host/prep-handbook.js', '主控台/host/prep-handbook.css',
    'asset/棋子库/棋子库.html', 'asset/棋子库/默认预设.js',
    'asset/地图/tile-renderer.js', 'asset/地图/地图创作台.html',
})
MEDIA_ROOTS = ('asset/界面/', 'asset/棋子库/', 'asset/地图/', 'asset/音乐/')
MEDIA_EXTENSIONS = frozenset({'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
                             '.ico', '.woff', '.woff2', '.ttf', '.mp3', '.wav',
                             '.ogg', '.m4a', '.mp4', '.webm', '.flac'})


def static_file_allowed(root, target, is_host=False):
    """Allow listed runtime files, never directories, symlinks or private data."""
    root = Path(os.path.abspath(root))
    target = Path(os.path.abspath(target))
    try:
        relative = target.relative_to(root)
    except ValueError:
        return False
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if part.startswith('.') or cursor.is_symlink():
            return False
    if not target.is_file():
        return False
    name = relative.as_posix()
    if name in PUBLIC_FILES or (is_host and name in HOST_FILES):
        return True
    return name.startswith(MEDIA_ROOTS) and target.suffix.lower() in MEDIA_EXTENSIONS
