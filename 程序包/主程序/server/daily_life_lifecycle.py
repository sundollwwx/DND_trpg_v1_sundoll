"""Everyday content participates in the same general-module lifecycle."""
import copy
import hashlib
import json

from .daily_life import MODULE_ID, read_bundle, validate_bundle
from .module_store import RevisionConflict, encode
from .workspace import Workspace

LOCAL_ID = 'daily-life-local'
OWNER = 'general:'+MODULE_ID


def local_entry(runtime):
    workspace = Workspace(runtime.root)
    try:
        bundle = read_bundle(runtime.root)
    except (OSError, ValueError) as error:
        if not workspace.checked(workspace.general/MODULE_ID).exists(): return None
        return dict(moduleId=LOCAL_ID, kind='general', name=MODULE_ID, assets=[], archived=False,
                    dataHash='', local=True, files=0, available=False, error=str(error))
    manifest = json.loads(workspace.checked(workspace.general/MODULE_ID/'模块.json').read_text('utf-8'))
    return dict(moduleId=manifest.get('sourceModuleId') or LOCAL_ID, kind='general', name=MODULE_ID,
                assets=[], archived=not manifest.get('enabled', True),
                dataHash=hashlib.sha256(encode(bundle).encode()).hexdigest(), local=True,
                files=5+int('readme' in bundle)+int('dataReadme' in bundle)+1)


def set_enabled(runtime, enabled):
    bundle = read_bundle(runtime.root)
    with runtime.store.transaction() as db:
        old = runtime.store.document(db, 'daily-life-module', MODULE_ID)
        data = dict(bundle=bundle, enabled=enabled, sourceModuleId=LOCAL_ID)
        runtime.store.write_document(db, 'daily-life-module', MODULE_ID, OWNER, data, old['revision'] if old else 0)
    return dict(moduleId=LOCAL_ID, changed=1, kept=[])


def merge(runtime, db, identity, desired, previous, remove=False):
    """Merge JSON files separately, preserving authored changes on package update."""
    old = runtime.store.document(db, 'daily-life-module', MODULE_ID)
    if old and old['data']['enabled'] and old['data']['sourceModuleId'] not in (identity, LOCAL_ID):
        raise RevisionConflict('日常小事已由其他通用包启用，请先卸载原来源')
    try: current = read_bundle(runtime.root)
    except FileNotFoundError: current = None
    if desired is not None: validate_bundle(desired)
    if (remove or desired is None) and (not old or old['data']['sourceModuleId'] != identity):
        return 0, []
    if current is None: current = copy.deepcopy(desired or old['data']['bundle'])
    merged = copy.deepcopy(current)
    kept = []
    if not remove and desired is not None:
        prior = previous or desired
        for kind, value in desired['data'].items():
            if current['data'][kind] in (prior['data'][kind], value): merged['data'][kind] = copy.deepcopy(value)
            else: kept.append(dict(kind='daily-life', id=kind, name=MODULE_ID+'／'+kind))
        for field in ('readme', 'dataReadme'):
            if current.get(field) in (prior.get(field), desired.get(field)):
                if field in desired: merged[field] = desired[field]
                else: merged.pop(field, None)
            elif field in current or field in desired:
                kept.append(dict(kind='daily-life', id=field, name=MODULE_ID+'／说明'))
    data = dict(bundle=merged, enabled=not remove and desired is not None, sourceModuleId=identity)
    if old and old['data'] == data: return 0, kept
    runtime.store.write_document(db, 'daily-life-module', MODULE_ID, OWNER, data, old['revision'] if old else 0)
    return 1, kept
