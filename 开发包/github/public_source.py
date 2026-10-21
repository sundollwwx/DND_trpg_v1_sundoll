"""One fail-closed path policy for source publication and source-only updates."""
import os
from pathlib import Path, PurePosixPath

ROOT_FILES = {
    '.gitignore', '.gitattributes', 'README.md',
    '启动桑哆尔之歌.command', '启动桑哆尔之歌.bat',
    '程序包/README.md', '程序包/使用说明.md', '程序包/目录导览.md',
    '程序包/账号与角色规则.txt', '网站/announcement-template.html',
    '网站/README.md', '网站/build_site.py', '开发包/README.md',
    '网站/主站/_headers', '网站/主站/_redirects',
    '开发包/生活玩法/export_fishing.py', '开发包/生活玩法/export_menus.py',
}
TOOL_FILES = {
    'build_distribution_v3.py', 'build_distribution_v4.py',
    'verify_distribution_v3.py', 'verify_unified_workspace.py',
    'activate_workspace_v4.py', 'migrate_modules_v3.py', 'migrate_workspace_v4.py',
    'benchmark_module_reads.py',
}
DOC_FILES = {
    'README.md', '内容包与角色物品.md', '旅行篮子.md', '棋子形态与存档.md',
    '玩家背包.md', '部署与维护.md',
}
DENIED_PARTS = {
    '.git', '.codex', '.agents', '.aws', '.wrangler', '.idea', '.venv',
    '__pycache__', 'node_modules', '运行数据', '认证', '存档', '战役包',
    '玩家包', '通用包', '私人备份', '创作包', '历史归档', '本机配置',
    '本地配置', '密钥', '待审核', '设计原图', '草稿', '候选',
}
DENIED_FOLDED = {value.casefold() for value in DENIED_PARTS}
SOURCE_SUFFIXES = {'.py', '.js', '.cjs', '.mjs', '.css', '.html', '.md', '.json',
                   '.sql', '.toml', '.command', '.bat', '.sh', '.yml', '.yaml'}
ASSET_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp3', '.wav',
                  '.ogg', '.m4a', '.woff', '.woff2'}
EXCLUDED_TESTS = {'test_visual_creation_standards.py', 'test_desktop_assets.cjs'}


def public_path(name):
    """Accept only canonical relative POSIX paths in the public source contract."""
    if not isinstance(name, str) or not name or '\\' in name or '\0' in name:
        return False
    parts = name.split('/')
    if any(part in ('', '.', '..') or ':' in part for part in parts):
        return False
    if any(part.casefold() in DENIED_FOLDED
           or part.casefold().startswith('.env') for part in parts):
        return False
    path = PurePosixPath(name)
    if path.name.lower() in {'credentials.json', 'secrets.json', 'secret.json', 'token.json',
                             'config.local.json', 'settings.local.json'}:
        return False
    if name == '开发包/maintenance/archive_verified_cleanup.py':
        return False  # One-off author migration with machine-specific paths.
    if name in ROOT_FILES:
        return True
    if any(part.startswith('.') for part in parts):
        return False
    if path.suffix.lower() not in SOURCE_SUFFIXES | ASSET_SUFFIXES:
        return False
    if name.startswith('程序包/主程序/'):
        relative = parts[2:]
        if relative[0] in {'server', 'shared', 'web', '主控台', 'defaults'}:
            return True
        if relative[0] == 'asset':
            return (len(relative) > 2 and relative[1] in {'界面', '地图'}
                    or '/'.join(relative) in {'asset/棋子库/棋子库.html', 'asset/棋子库/默认预设.js'})
        return len(relative) == 1 and (path.suffix == '.py' or relative[0] in {
            '启动桑哆尔之歌.command', '启动桑哆尔之歌.bat',
            'distribution.json', '模块.json', '邮箱账号设置.example.json',
        })
    if name.startswith('网站/主站/'):
        return True
    if name.startswith('网站/留言板/'):
        return len(parts) == 3 and path.suffix in {'.js', '.sql', '.toml', '.md'}
    if name.startswith('开发包/'):
        if len(parts) == 2:
            return parts[-1] in TOOL_FILES
        if parts[1] in {'github', 'maintenance', 'scripts'}:
            return path.suffix in SOURCE_SUFFIXES
        if parts[1] == 'tests':
            return path.name not in EXCLUDED_TESTS and path.suffix in SOURCE_SUFFIXES | ASSET_SUFFIXES
        if parts[1] == 'docs':
            return len(parts) == 3 and path.name in DOC_FILES
    return False


def candidate_files(root):
    """Return sorted regular source files without traversing links/private trees."""
    root = Path(root).resolve()
    result = []
    for current, directories, files in os.walk(root, followlinks=False):
        relative = Path(current).relative_to(root)
        kept = []
        for directory in directories:
            if directory in DENIED_PARTS or directory.startswith('.'):
                continue
            if not relative.parts and directory not in {'程序包', '网站', '开发包'}:
                continue
            if relative.parts == ('程序包',) and directory != '主程序':
                continue
            if relative.parts == ('开发包',) and directory not in {'github', 'maintenance', 'scripts', 'tests', 'docs', '生活玩法'}:
                continue
            folder = Path(current) / directory
            if folder.is_symlink():
                raise ValueError('源码目录不能是符号链接：' + folder.relative_to(root).as_posix())
            kept.append(directory)
        directories[:] = kept
        for filename in files:
            file = Path(current) / filename
            name = file.relative_to(root).as_posix()
            if not public_path(name):
                continue
            if file.is_symlink() or not file.is_file():
                raise ValueError('源码只能包含普通文件：' + name)
            result.append(name)
    return sorted(result)


def validate_tree(git, tree):
    """Reject private/unknown paths, links and submodules before any checkout."""
    names = []
    for entry in git('ls-tree', '-r', '-z', tree).stdout.split('\0'):
        if not entry:
            continue
        metadata, name = entry.split('\t', 1)
        mode, kind, _oid = metadata.split()
        if not public_path(name) or mode not in {'100644', '100755'} or kind != 'blob':
            raise ValueError('版本包含私人、未知或链接路径，已停止源码同步：' + name)
        names.append(name)
    return names


def validate_worktree_paths(root, paths):
    """Never let checkout replace a directory or traverse a local symbolic link."""
    root = Path(root).resolve()
    for name in paths:
        target = root / name
        for ancestor in [target, *target.parents]:
            if ancestor == root:
                break
            if ancestor.is_symlink():
                raise ValueError('源码路径与本机链接冲突，未修改该链接：' + name)
        if target.is_dir():
            raise ValueError('源码文件与本机目录冲突，未覆盖目录：' + name)
        if any(parent.exists() and not parent.is_dir() for parent in target.parents if parent != root):
            raise ValueError('源码目录与本机文件冲突：' + name)


def stage_public(git, root, index_env):
    """Build a source-only index; never stage '.' or inherit a private old index."""
    files = candidate_files(root)
    git('read-tree', '--empty', extra_env=index_env)
    for offset in range(0, len(files), 80):
        git('--literal-pathspecs', 'add', '-f', '--', *files[offset:offset + 80], extra_env=index_env)
    tree = git('write-tree', extra_env=index_env).stdout.strip()
    validate_tree(git, tree)
    return tree
