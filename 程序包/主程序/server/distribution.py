"""Initialize a clean distribution on first launch, never copy author saves."""
import json
from pathlib import Path
from .module_runtime import ModuleRuntime
from .workspace import Workspace, enable, read_catalog, write_catalog
from . import player_profiles


def initialize(app_root, save_root):
    app_root, save_root = Path(app_root), Path(save_root)
    config = app_root / 'distribution.json'
    if not config.is_file(): return
    data = json.loads(config.read_text('utf-8'))
    if data.get('format') not in (3,4): raise ValueError('发行配置版本无效')
    if data.get('format') == 4 and not Workspace(save_root).active:
        if save_root.name != '存档' or save_root.parent.name != '运行数据':
            raise ValueError('同级模块版的数据目录须为 工作区/运行数据/存档')
        enable(save_root.parent.parent)
    runtime = ModuleRuntime(save_root, app_root)
    # A Git checkout carries the complete module projection, but not the
    # machine-local SQLite coordinator. Rebuild only a recognized v4 snapshot;
    # rebuild validates all records/assets and refuses unfinished publications.
    workspace = Workspace(save_root)
    if (workspace.active and not runtime.store.database.exists()
            and (workspace.root / '运行数据/协调记录/索引快照.json').is_file()):
        from .workspace_recovery import rebuild
        rebuild(save_root)
    runtime.ensure_empty_runtime()
    try: read_catalog(save_root, 'template')
    except FileNotFoundError: write_catalog(save_root, 'template', dict(format='sangduoer-library',schemaVersion=1,savedAt=1,presets=[]))
    bundles = app_root.parent / ('通用包' if data.get('format') == 4 else '内容包')
    for path in sorted(bundles.glob('*.sundoll')):
        result = runtime.packages.install(path)
        if result['kind'] != 'general': raise ValueError('内置内容必须是通用包')
        db = runtime.store.connect()
        try: active = runtime.store.document(db, 'bundled-content', result['moduleId'])
        finally: db.close()
        if not active:
            runtime.activate_general(result['moduleId'])
            with runtime.store.transaction() as db:
                runtime.store.write_document(db,'bundled-content',result['moduleId'],'',{'dataHash':result['dataHash']},0)
