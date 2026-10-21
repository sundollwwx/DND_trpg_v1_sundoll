"""Register authored support files through normal recoverable module publication."""
import hashlib
import json
from pathlib import Path

from .module_store import ModuleStore
from .workspace import Workspace

TYPES = {
    '文档': {'.pdf':'application/pdf', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt':'text/plain'},
    '音乐': {'.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.m4a':'audio/mp4'},
}


def register_support_files(save_root, module_directory=None):
    """Scan once at startup, or one changed module after import.

    Only declared document/music file types inside module-owned ``资料`` are
    indexed. Unchanged size/mtime/path entries are idempotent; changed files
    publish a support-file record and immutable asset through the standard
    outbox, including the recovery snapshot. Raw originals are never moved.
    ``module_directory`` limits work to one general/campaign module.
    Returns counts and a bounded list of oversized files skipped.
    """
    workspace = Workspace(save_root)
    result = dict(registered=0, unchanged=0, skipped=[])
    if not workspace.active: return result
    selected = workspace.checked(module_directory) if module_directory is not None else None
    store = ModuleStore(save_root)
    with store.transaction() as db:
        for folder, extensions in TYPES.items():
            for root in workspace.support_roots(folder):
                module = root.parent.parent
                if selected is not None and module != selected: continue
                family = module.relative_to(workspace.root).parts[0]
                manifest_path = workspace.checked(module/'模块.json')
                manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.is_file() else {}
                identity = manifest.get('id') or module.name
                if family == '战役包':
                    identity = next((cid for cid, name in (workspace.config or {}).get('campaignFolders', {}).items()
                                     if name == module.name), identity)
                    save = workspace.checked(module/'当前存档.json')
                    if save.is_file(): identity = json.loads(save.read_text('utf-8')).get('campaignId') or identity
                owner = ('campaign:' if family == '战役包' else 'general:') + identity
                if not root.is_dir(): continue
                for path in sorted(root.rglob('*')):
                    if path.suffix.lower() not in extensions or not path.is_file(): continue
                    workspace.checked(path)
                    if path.name.startswith(('.', '~$')): continue
                    stat = path.stat()
                    if not 0 < stat.st_size <= 128*1024*1024:
                        if len(result['skipped']) < 100: result['skipped'].append(path.relative_to(workspace.root).as_posix())
                        continue
                    relative = path.relative_to(workspace.root).as_posix()
                    local = path.relative_to(module).as_posix()
                    key = hashlib.sha256((owner+'\0'+local).encode('utf-8')).hexdigest()
                    old = store.document(db, 'support-file', key)
                    fingerprint = dict(sourcePath=relative, size=stat.st_size, mtimeNs=stat.st_mtime_ns)
                    if old and all(old['data'].get(k) == v for k,v in fingerprint.items()):
                        result['unchanged'] += 1
                        continue
                    with path.open('rb') as handle: raw = handle.read(128*1024*1024+1)
                    if len(raw) != stat.st_size or len(raw) > 128*1024*1024:
                        raise ValueError('资料在登记时发生变化，请稍后重试')
                    url = store.put_asset(raw, extensions[path.suffix.lower()], owner, db)
                    data = dict(fingerprint, fileUrl=url, name=path.stem,
                                moduleDirectory=module.relative_to(workspace.root).as_posix())
                    store.write_document(db, 'support-file', key, owner, data, old['revision'] if old else 0)
                    result['registered'] += 1
    return result
