"""Read-only media catalog; root is passed by the calling service."""
import os, re, hashlib
from .catalog_paths import safe_campaign_name as _safe_music_campaign_name
from pathlib import Path
DEFAULT_MUSIC_ROOT = str(Path(__file__).resolve().parents[1] / "asset" / "音乐")
MUSIC_EXTS = ('.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus', '.webm')
MAX_MUSIC_LIBRARY_FILES = 1000
MUSIC_MIME_TYPES = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
    '.opus': 'audio/ogg', '.webm': 'audio/webm',
}
def _music_path_is_safe(root, path):
    """音乐库不能通过软链接或构造路径越过 ``asset/音乐``。"""
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    try:
        return os.path.commonpath([root, path]) == root and not os.path.islink(path)
    except (OSError, ValueError):
        return False


def _walk_music_files(root, start):
    if not os.path.isdir(start) or not _music_path_is_safe(root, start):
        return
    for directory, subdirs, files in os.walk(start):
        subdirs[:] = [name for name in subdirs
                      if _music_path_is_safe(root, os.path.join(directory, name))]
        for name in files:
            path = os.path.join(directory, name)
            if (name.lower().endswith(MUSIC_EXTS)
                    and _music_path_is_safe(root, path)
                    and os.path.isfile(path)):
                yield path


def music_library_catalog(root=None, campaign_id='', campaign_name=''):
    """扫描项目曲库，返回公开目录与只在服务器内使用的 ID->路径索引。"""
    root = os.path.abspath(root or DEFAULT_MUSIC_ROOT)
    campaign_id = re.sub(r'[^\w\-]', '', str(campaign_id or ''))[:80]
    campaign_name = _safe_music_campaign_name(campaign_name)[:120]
    entries = []
    index = {}

    def add(path, scope, collection_root, default_category):
        if len(entries) >= MAX_MUSIC_LIBRARY_FILES:
            return
        if not _music_path_is_safe(root, path):
            return
        try:
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            stat = os.stat(path)
            size = stat.st_size
        except OSError:
            return
        track_id = hashlib.sha256(relative.encode('utf-8')).hexdigest()[:32]
        category_relative = os.path.relpath(os.path.dirname(path), collection_root)
        category = default_category if category_relative == '.' else category_relative.replace(os.sep, ' / ')
        filename = os.path.basename(path)
        entries.append({
            'id': track_id,
            'title': os.path.splitext(filename)[0],
            'fileName': filename,
            'scope': scope,
            'collection': '当前战役' if scope == 'campaign' else '通用',
            'category': category,
            'size': size,
            'url': '/api/music-stream/' + track_id + '?v=%x-%x' % (stat.st_mtime_ns, size),
        })
        index[track_id] = path

    if os.path.isdir(root):
        # 根目录里的旧曲目继续作为通用音乐；其余通用分类可直接建子文件夹。
        try:
            for name in sorted(os.listdir(root)):
                path = os.path.join(root, name)
                if os.path.isfile(path) and name.lower().endswith(MUSIC_EXTS):
                    add(path, 'general', root, '通用')
                elif os.path.isdir(path) and name != '战役' and not os.path.islink(path):
                    for music_path in _walk_music_files(root, path):
                        add(music_path, 'general', root, '通用')
        except OSError:
            pass

    selected_campaign_folder = ''
    campaigns_root = os.path.join(root, '战役')
    if os.path.isdir(campaigns_root):
        try:
            folder_names = [name for name in os.listdir(campaigns_root)
                            if os.path.isdir(os.path.join(campaigns_root, name))
                            and not os.path.islink(os.path.join(campaigns_root, name))]
        except OSError:
            folder_names = []
        expected = ((campaign_id + '-' + campaign_name) if campaign_id and campaign_name else '')
        candidates = sorted(folder_names, key=lambda name: (
            0 if expected and name == expected else
            1 if campaign_id and name == campaign_id else
            2 if campaign_id and name.startswith(campaign_id + '-') else
            3 if campaign_name and name == campaign_name else 4,
            name,
        ))
        selected_campaign_folder = next((name for name in candidates if (
            (expected and name == expected)
            or (campaign_id and (name == campaign_id or name.startswith(campaign_id + '-')))
            or (campaign_name and name == campaign_name)
        )), '')
        if selected_campaign_folder:
            campaign_root = os.path.join(campaigns_root, selected_campaign_folder)
            for music_path in _walk_music_files(root, campaign_root):
                add(music_path, 'campaign', campaign_root, '未分类')

    entries.sort(key=lambda item: (
        0 if item['scope'] == 'campaign' else 1,
        item['category'].lower(), item['title'].lower(),
    ))
    return {
        'ok': True,
        'campaignId': campaign_id,
        'campaignName': campaign_name,
        'campaignFolder': selected_campaign_folder,
        'tracks': entries,
        '_index': index,
    }


