"""Unified host overview and source-module lifecycle; live play is independent."""
import copy
import hashlib
import json
import secrets
import time
from pathlib import Path
from .workspace import Workspace, read_catalog, write_catalog, cache_root
from .module_store import RevisionConflict
from .save_storage import SAVE_WRITE_LOCK, campaign_catalog, local_save_target, CAMPAIGN_SUMMARIES
from . import player_profiles as profiles


def overview(runtime):
    workspace = Workspace(runtime.root)
    with SAVE_WRITE_LOCK, profiles.LOCK:
        campaigns = campaign_catalog(runtime.root)
        archived = []
        for marker in workspace.campaigns.glob('*/已删除.json'):
            workspace.checked(marker)
            path = marker.parent/'当前存档.json'
            if path.is_file():
                d = json.loads(path.read_text('utf-8'))
                archived.append(dict(id=d.get('campaignId'), name=d.get('campaignName'), path='战役/'+marker.parent.name+'/当前存档.json'))
        store = profiles.Store(runtime.root,runtime.app,cache_root(runtime.root,runtime.app))
        players = []
        for p in store.players():
            players.append(dict(playerId=p['playerId'],name=p['name'],characters=len(store.library(p['playerId'])['pieces'])))
        groups = {}
        db = runtime.store.connect()
        try:
            for row in db.execute("SELECT kind,owner,payload FROM documents WHERE kind IN ('template','item-template')"):
                owner = row['owner']
                if not owner.startswith('general:'): continue
                g = groups.setdefault(owner,dict(id=owner,name=owner.split(':',1)[1],templates=0,items=0))
                g['templates' if row['kind']=='template' else 'items'] += 1
        finally: db.close()
        return dict(workspace=workspace.summary(),campaigns=campaigns,archivedCampaigns=archived,
                    players=players,general=list(groups.values()),modules=runtime.packages.catalog())


def general_definitions(runtime, module):
    from .inventory import item_definition
    from .item_library import ItemLibrary
    lib = ItemLibrary(profiles.Store(runtime.root,runtime.app,cache_root(runtime.root,runtime.app)),profiles)
    identity = module['manifest']['moduleId']
    values = {'template':{},'item-template':{}}
    for kind, field, prefix in [('template','templates','tpl-'),('item-template','items','item-')]:
        for raw in module['payload'].get(field,[]):
            key = prefix + hashlib.sha256((identity+'::'+raw['id']).encode()).hexdigest()[:24]
            if kind == 'template':
                if raw.get('ownedPieceId') or raw.get('characterId') or raw.get('campaignId'):
                    raise ValueError('通用内容不能混入玩家角色或战役专属模板')
                value = dict(copy.deepcopy(raw),id=key,moduleId=identity)
            else:
                value = dict(item_definition(raw,ValueError),id=key,version=1,archived=False,moduleId=identity,**lib.metadata({}))
            values[kind][key] = value
    return values


def apply_general(runtime, identity, remove=False):
    """Three-way merge source definitions. Persist both catalogs and baseline together."""
    with SAVE_WRITE_LOCK, profiles.LOCK:
        module = runtime.packages.payload(identity)
        if module['manifest']['kind'] != 'general': raise ValueError('请选择通用内容包')
        desired = general_definitions(runtime,module)
        from .item_library import ItemLibrary
        try: templates=read_catalog(runtime.root,'template')
        except FileNotFoundError: templates=dict(format='sangduoer-library',schemaVersion=1,presets=[])
        catalogs = {'template':templates,
                    'item-template':ItemLibrary(profiles.Store(runtime.root,runtime.app,cache_root(runtime.root,runtime.app)),profiles).read()}
        kept, changed = [], 0
        with runtime.store.transaction() as db:
            installed = runtime.store.document(db,'installed-module',identity)
            if installed['data'].get('archived') and not remove: raise ValueError('请先恢复已卸载的模块')
            old = runtime.store.document(db,'general-baseline',identity)
            baseline = old['data']['definitions'] if old else {'template':{},'item-template':{}}
            for kind, field in [('template','presets'),('item-template','templates')]:
                entries = {v['id']:v for v in catalogs[kind][field]}
                # Older releases did not store a baseline: only identical values are adopted.
                prior = baseline[kind] if old else desired[kind]
                target = {} if remove else desired[kind]
                for key in dict.fromkeys([*prior,*target]):
                    current, previous, new = entries.get(key),prior.get(key),target.get(key)
                    if kind == 'item-template' and old and previous and new:
                        differs={k:v for k,v in previous.items() if k!='version'} != {k:v for k,v in new.items() if k!='version'}
                        new['version']=previous['version'] + int(differs)
                    legacy_equal = not old and current and previous and {k:v for k,v in current.items() if k!='moduleId'} == {k:v for k,v in previous.items() if k!='moduleId'}
                    if current is None and (previous is None or not old):
                        if new is not None: entries[key]=new; changed+=1
                    elif current == previous or current == new or legacy_equal:
                        if new is None:
                            if key in entries: del entries[key]; changed+=1
                        elif current != new: entries[key]=new; changed+=1
                    elif current is not None or new is not None:
                        kept.append(dict(kind=kind,id=key,name=(current or new or previous).get('name',key)))
                catalogs[kind][field]=list(entries.values())
                if kind == 'item-template': catalogs[kind]['revision'] += 1
                else: catalogs[kind]['savedAt']=int(time.time()*1000)
                write_catalog(runtime.root,kind,catalogs[kind],db)
            runtime.store.write_document(db,'general-baseline',identity,'',
                dict(definitions={'template':{},'item-template':{}} if remove else desired,dataHash=module['manifest']['dataHash']),old['revision'] if old else 0)
            if remove:
                runtime.store.write_document(db,'installed-module',identity,'',dict(installed['data'],archived=True),installed['revision'])
        return dict(moduleId=identity,changed=changed,kept=kept)


def set_archived(runtime, identity, archived):
    with SAVE_WRITE_LOCK, profiles.LOCK:
        module = runtime.packages.payload(identity)
        if archived and module['manifest']['kind']=='general': return apply_general(runtime,identity,True)
        with runtime.store.transaction() as db:
            old = runtime.store.document(db,'installed-module',identity)
            runtime.store.write_document(db,'installed-module',identity,'',dict(old['data'],archived=archived),old['revision'])
        return dict(moduleId=identity)


def restore_campaign(runtime, path, cid):
    with SAVE_WRITE_LOCK:
        target = Path(local_save_target(path,'read',runtime.root))
        if target.name != '当前存档.json' or len(str(path).split('/'))!=3: raise ValueError('战役路径无效')
        doc = json.loads(target.read_text('utf-8'))
        if doc.get('campaignId')!=cid: raise RevisionConflict('战役身份已变化')
        (target.parent/'已删除.json').unlink(missing_ok=True)
        CAMPAIGN_SUMMARIES.pop(str(target),None)
        return dict(campaignId=cid)


def export_general(runtime, owner, destination):
    if not isinstance(owner,str) or not owner.startswith('general:'): raise ValueError('请选择通用收藏')
    with SAVE_WRITE_LOCK, profiles.LOCK:
        db = runtime.store.connect()
        try:
            data={kind:[json.loads(r[0]) for r in db.execute('SELECT payload FROM documents WHERE kind=? AND owner=?',(kind,owner))]
                  for kind in ('template','item-template')}
        finally: db.close()
        if not any(data.values()): raise ValueError('收藏为空或不存在')
        with runtime.store.transaction() as db:
            publication=runtime.store.document(db,'publication-id',owner)
            if publication: identity=publication['data']['id']
            else:
                identity='general-'+secrets.token_hex(16)
                runtime.store.write_document(db,'publication-id',owner,'',{'id':identity},0)
        return runtime.packages.export(destination,'general',owner.split(':',1)[1],
            dict(templates=data['template'],items=data['item-template']),identity)
