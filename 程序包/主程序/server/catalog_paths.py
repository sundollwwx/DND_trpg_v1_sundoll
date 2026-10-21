"""Naming rules shared by filesystem catalogs."""
import hashlib
import json
import os
from pathlib import Path
import re

def safe_campaign_name(value):
    return re.sub(r'[\\/:*?"<>|]', '_', str(value or '')).strip()


def catalog_identity(relative, module_identity=''):
    """Keep legacy IDs readable while namespacing independently owned content."""
    legacy = hashlib.sha256(relative.encode('utf-8')).hexdigest()[:32]
    identity = hashlib.sha256((module_identity+'\0'+relative).encode('utf-8')).hexdigest()[:32] if module_identity else legacy
    return identity, legacy


def support_module_identity(save_root, support_root):
    from .workspace import Workspace
    workspace = Workspace(save_root)
    path = workspace.checked(support_root)
    if not workspace.active: return ''
    parts = path.relative_to(workspace.root).parts
    if len(parts) < 3 or parts[0] not in ('通用包', '战役包'):
        raise ValueError('媒体目录没有模块归属')
    manifest_path = workspace.checked(workspace.root.joinpath(*parts[:2], '模块.json'))
    # Read-only compatibility for older authored support directories. Startup
    # registration will publish a manifest with this same directory identity.
    manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.is_file() else dict(
        format='sundoll-workspace-module', family=parts[0], id=parts[1])
    if manifest.get('format') != 'sundoll-workspace-module' or manifest.get('family') != parts[0] or not manifest.get('id'):
        raise ValueError('媒体模块清单无效')
    identity = manifest['id']
    if parts[0] == '战役包':
        identity = next((cid for cid, folder in (workspace.config or {}).get('campaignFolders', {}).items()
                         if folder == parts[1]), identity)
    return parts[0]+':'+str(identity)


def merge_catalog_indexes(catalogs):
    """Resolve an old URL only when its relative ID has one physical target.

    Never let directory enumeration order choose a file after an ID collision.
    Canonical collisions are rejected in the same way as ambiguous old aliases.
    """
    candidates = {}
    for catalog in catalogs:
        index = catalog.get('_index', {})
        for identity, path in index.items():
            candidates.setdefault(identity, {})[os.path.abspath(path)] = path
        for alias, identities in catalog.get('_aliases', {}).items():
            for identity in identities:
                if identity in index:
                    path = index[identity]
                    candidates.setdefault(alias, {})[os.path.abspath(path)] = path
    return {identity:next(iter(paths.values())) for identity, paths in candidates.items() if len(paths) == 1}
