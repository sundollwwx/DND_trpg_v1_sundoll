"""Unified host overview and source-module lifecycle; live play is independent."""
import copy
import hashlib
import json
import secrets
import time
from pathlib import Path
from .workspace import Workspace, read_catalog, write_catalog, cache_root
from .module_store import RevisionConflict
from .save_storage import SAVE_WRITE_LOCK, campaign_catalog, campaign_summary, local_save_target, CAMPAIGN_SUMMARIES
from . import player_profiles as profiles
from .content_packages import ContentPackages, local_package_id


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
                rel = '战役/'+marker.parent.name+'/当前存档.json'
                record = campaign_summary(d, marker.parent.name, rel)
                archived.append(dict(id=record['id'], name=record['name'], path=rel))
        store = profiles.Store(runtime.root,runtime.app,cache_root(runtime.root,runtime.app))
        players = []
        for p in store.players():
            players.append(dict(playerId=p['playerId'],name=p['name'],characters=len(store.library(p['playerId'])['pieces'])))
        groups = {}
        content_names = {p.get('localOwner'):p['name'] for p in ContentPackages(runtime.root).catalog()}
        db = runtime.store.connect()
        try:
            for row in db.execute("SELECT kind,owner,payload FROM documents WHERE kind IN ('template','item-template')"):
                owner = row['owner']
                if not owner.startswith('general:'): continue
                g = groups.setdefault(owner,dict(id=owner,name=content_names.get(owner,owner.split(':',1)[1]),templates=0,items=0))
                g['templates' if row['kind']=='template' else 'items'] += 1
        finally: db.close()
        from .daily_life_lifecycle import local_entry, OWNER
        daily = local_entry(runtime)
        modules = runtime.packages.catalog()
        if daily:
            groups.setdefault(OWNER, dict(id=OWNER, name=daily['name'], templates=0, items=0, files=daily['files']))
            installed_daily = next((m for m in modules if m['moduleId'] == daily['moduleId']), None)
            if installed_daily:
                installed_daily.update(files=daily['files'], dailyLife=True, available=daily.get('available', True))
                if daily.get('error'): installed_daily['error'] = daily['error']
            else:
                daily['moduleId'] = 'daily-life-local'
                daily['dailyLife'] = True
                modules.append(daily)
        return dict(workspace=workspace.summary(),campaigns=campaigns,archivedCampaigns=archived,
                    players=players,general=list(groups.values()),modules=modules,
                    contentPackages=ContentPackages(runtime.root).catalog())


def general_definitions(runtime, module):
    from .inventory import item_definition
    from .item_library import ItemLibrary
    lib = ItemLibrary(profiles.Store(runtime.root,runtime.app,cache_root(runtime.root,runtime.app)),profiles)
    identity = module['manifest']['moduleId']
    primary, packages = runtime.packages.content_graph(module['manifest'], module['payload'])
    values = {'template':{},'item-template':{}}
    for kind, field, prefix in [('template','templates','tpl-'),('item-template','items','item-')]:
        for raw in module['payload'].get(field,[]):
            package_id = raw.get('contentPackageId') or primary['id']
            entry_id = raw.get('contentEntryId') or raw['id']
            key = prefix + hashlib.sha256((package_id+':'+entry_id).encode()).hexdigest()[:24]
            if kind == 'template':
                if raw.get('ownedPieceId') or raw.get('characterId') or raw.get('campaignId'):
                    raise ValueError('通用内容不能混入玩家角色或战役专属模板')
                value = dict(copy.deepcopy(raw),id=key,moduleId=identity,contentPackageId=package_id,contentEntryId=entry_id)
            else:
                if raw.get('scope', 'general') != 'general' or raw.get('campaignId') or raw.get('sourceScope') in ('campaign','personal') or any(raw.get(k) for k in ('ownerCharacterId','ownerPlayerId','sourcePlayerId','sourceCharacterId')):
                    raise ValueError('通用内容不能混入战役或角色专属物品')
                version = raw.get('version', 1)
                if type(version) is not int or version < 1: raise ValueError('通用物品模板版本无效')
                value = dict(item_definition(raw,ValueError),id=key,version=version,archived=False,moduleId=identity,
                    contentPackageId=package_id,contentEntryId=entry_id,**lib.metadata({}))
            values[kind][key] = value
    return values


def apply_general(runtime, identity, remove=False):
    """Three-way merge source definitions. Persist both catalogs and baseline together."""
    with SAVE_WRITE_LOCK, profiles.LOCK:
        from .daily_life_lifecycle import LOCAL_ID, set_enabled, merge as merge_daily
        if identity == LOCAL_ID: return set_enabled(runtime, not remove)
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
            previous_daily = old['data'].get('dailyLife') if old else None
            desired_daily = module['payload'].get('dailyLife')
            if desired_daily is not None or previous_daily is not None:
                delta, daily_kept = merge_daily(runtime, db, identity, desired_daily, previous_daily, remove)
                changed += delta; kept.extend(daily_kept)
            baseline_data = dict(definitions={'template':{},'item-template':{}} if remove else desired,dataHash=module['manifest']['dataHash'])
            if not remove and desired_daily is not None: baseline_data['dailyLife'] = desired_daily
            runtime.store.write_document(db,'general-baseline',identity,'',baseline_data,old['revision'] if old else 0)
            if remove:
                runtime.store.write_document(db,'installed-module',identity,'',dict(installed['data'],archived=True),installed['revision'])
        return dict(moduleId=identity,changed=changed,kept=kept)


def set_archived(runtime, identity, archived):
    with SAVE_WRITE_LOCK, profiles.LOCK:
        from .daily_life_lifecycle import LOCAL_ID, set_enabled
        if identity == LOCAL_ID: return set_enabled(runtime, not archived)
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
        record = campaign_summary(doc, target.parent.name, path)
        if record['id']!=cid: raise RevisionConflict('战役身份已变化')
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
        from .daily_life_lifecycle import OWNER
        from .daily_life import read_bundle
        daily = read_bundle(runtime.root) if owner == OWNER else None
        if not any(data.values()) and daily is None: raise ValueError('收藏为空或不存在')
        content = ContentPackages(runtime.root)
        package_ids = {v.get('contentPackageId') or local_package_id(owner) for entries in data.values() for v in entries}
        if not package_ids and daily is not None: package_ids.add(local_package_id(owner))
        if len(package_ids) != 1: raise ValueError('收藏包含不同来源的内容包，请按内容包分别导出')
        content_id = next(iter(package_ids))
        metadata = next((p for p in content.catalog() if p['id']==content_id),
            dict(id=content_id, name=owner.split(':',1)[1], scope='general', sourceCampaignId=''))
        with runtime.store.transaction() as db:
            publication=runtime.store.document(db,'publication-id',owner)
            if publication: identity=publication['data']['id']
            else:
                identity='general-'+secrets.token_hex(16)
                runtime.store.write_document(db,'publication-id',owner,'',{'id':identity},0)
        payload = dict(templates=data['template'],items=data['item-template'],
                       contentPackage={k:metadata[k] for k in ('id','name','scope','sourceCampaignId')})
        if daily is not None: payload['dailyLife'] = daily
        return runtime.packages.export(destination,'general',owner.split(':',1)[1],payload,identity)
