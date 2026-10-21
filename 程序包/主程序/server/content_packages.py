"""Content identity and campaign eligibility, independent of installed archives.

Reads never initialize a database, publish records, or migrate old saves. SQLite
may initialize WAL coordination sidecars without changing authoritative data. Old local
owners have deterministic identities until an explicit command registers them.
An unavailable item remains owned; this service only decides its current view.
"""
import copy
import hashlib
import json
from pathlib import Path
import re
from .workspace import Workspace
from .module_store import ModuleStore, RevisionConflict, encode
from .sqlite_read import open_readonly_database


PACKAGE_ID = re.compile(r'^[A-Za-z0-9_-]{1,96}$')
ORIGIN_FIELDS = ('sourcePackageId', 'sourceScope', 'sourceCampaignId',
                 'sourceTemplateId', 'sourceTemplateVersion', 'sourcePlayerId', 'sourceCharacterId')


def local_package_id(owner):
    return 'content-' + hashlib.sha256(str(owner).encode()).hexdigest()[:32]


def package_metadata(value):
    if not isinstance(value, dict) or not PACKAGE_ID.fullmatch(str(value.get('id'))):
        raise ValueError('内容包编号无效')
    scope = value.get('scope')
    if scope not in ('general', 'campaign'):
        raise ValueError('内容包归属无效')
    name = value.get('name', value['id'])
    cid = value.get('sourceCampaignId', '')
    if not isinstance(name, str) or not 1 <= len(name) <= 120 or not isinstance(cid, str) or len(cid) > 128:
        raise ValueError('内容包名称或战役来源无效')
    return dict(id=value['id'], name=name, scope=scope,
                sourceCampaignId=cid if scope == 'campaign' else '')


class ContentPackages:
    def __init__(self, save_root):
        self.root = Path(save_root).absolute()
        self.workspace = Workspace(save_root)
        self.database = self.root / '模块存储/模块.sqlite3'
        self._snapshot_cache = None
        self._snapshot_key = None
        self._template_cache = {}

    def _read(self, db=None):
        """Read the small metadata graph, not campaign map bodies or inventories."""
        own = db is None
        if own:
            paths = (self.database, self.database.with_name(self.database.name+'-wal'))
            key = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.is_file() else None for p in paths)
            if key != self._snapshot_key:
                self._snapshot_cache = None
                self._template_cache.clear()
                self._snapshot_key = key
        if own and self._snapshot_cache is not None: return self._snapshot_cache
        if own and not self.database.is_file():
            return {}, {}, [], {}, {}
        if own:
            # Do not call ModuleStore.connect(): that intentionally replays writes.
            db = open_readonly_database(self.database)
        try:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='documents'").fetchone():
                return {}, {}, [], {}, {}
            packages, selections, owners, installed, campaigns = {}, {}, [], {}, {}
            referenced = []
            for row in db.execute("SELECT kind,id,revision,payload FROM documents WHERE kind IN ('content-package','content-selection','installed-module','campaign-summary','player-content-dependencies')"):
                value = json.loads(row['payload'])
                if row['kind'] == 'content-package': packages[row['id']] = value
                elif row['kind'] == 'content-selection': selections[row['id']] = dict(value, _revision=row['revision'])
                elif row['kind'] == 'campaign-summary':
                    summary = value.get('summary', {})
                    if summary.get('id'): campaigns[summary['id']] = summary
                elif row['kind'] == 'player-content-dependencies':
                    referenced.extend(p for p in value.get('packages', []) if p.get('scope') != 'personal')
                else: installed[row['id']] = value
            for dependency in referenced:
                packages.setdefault(dependency['id'], dict(package_metadata(dependency), available=False, referenceOnly=True))
            for row in db.execute("SELECT DISTINCT owner,json_extract(payload,'$.contentPackageId') AS packageId FROM documents WHERE kind IN ('template','item-template')"):
                owners.append((row['owner'], row['packageId']))
            result = packages, selections, owners, installed, campaigns
            if own: self._snapshot_cache = result
            return result
        finally:
            if own: db.close()

    def _catalog(self, snapshot):
        registered, selections, owners, installed, campaigns = snapshot
        result = {}
        names = dict((self.workspace.config or {}).get('campaignNames', {}))
        names.update({cid:value.get('name') or cid for cid,value in campaigns.items()})
        # The local general collection is a built-in content source, including
        # empty/legacy installations whose reusable definitions are still JSON.
        local_owners = {'general:本地通用'}
        local_owners.update(owner for owner, pid in owners
            if owner.startswith(('general:', 'campaign:')) and (not pid or pid == local_package_id(owner)))
        for cid in names:
            directory = self.workspace.campaign(cid)
            own_source = selections.get(cid, {}).get('sourcePackageId', local_package_id('campaign:'+cid))
            if own_source == local_package_id('campaign:'+cid) and directory.is_dir() and not (directory/'已删除.json').exists():
                local_owners.add('campaign:' + cid)
        if not self.workspace.active:
            for path in self.workspace.campaigns.glob('*/当前存档.json'):
                if (path.parent/'已删除.json').exists(): continue
                # This fallback is only for legacy layouts; v4 uses its index.
                value = json.loads(path.read_text('utf-8'))
                cid = value.get('campaignId') or value.get('state', {}).get('campaignId')
                if cid:
                    local_owners.add('campaign:' + cid)
                    names[cid] = value.get('campaignName') or value.get('state', {}).get('campaignName') or cid
        for owner in local_owners:
            scope, identity = owner.split(':', 1)
            available = scope != 'campaign' or not (self.workspace.campaign(identity)/'已删除.json').exists()
            result[local_package_id(owner)] = dict(id=local_package_id(owner),
                name=names.get(identity, identity) if scope == 'campaign' else identity,
                scope=scope, sourceCampaignId=identity if scope == 'campaign' else '',
                available=available, localOwner=owner, local=True)
        for identity, value in registered.items():
            if value.get('referenceOnly') and identity in result: continue
            meta = package_metadata(value)
            module_ids = value.get('moduleIds', [])
            available = value.get('available', True) is not False and (
                value.get('local', False) or not module_ids or
                any(mid in installed and not installed[mid].get('archived') for mid in module_ids))
            if value.get('local') and value.get('localOwner', '').startswith('campaign:'):
                available = available and not (self.workspace.campaign(value['localOwner'][9:])/'已删除.json').exists()
            result[identity] = dict(meta, available=available,
                localOwner=value.get('localOwner', ''), local=value.get('local', False))
        return result

    def catalog(self):
        return sorted(self._catalog(self._read()).values(), key=lambda p:(p['scope'], p['name'], p['id']))

    def _context(self, campaign_id, snapshot):
        cid = str(campaign_id or '')
        packages = self._catalog(snapshot)
        selection = snapshot[1].get(cid, {})
        source = selection.get('sourcePackageId') or (local_package_id('campaign:' + cid) if cid else '')
        if source and source not in packages and not selection.get('sourcePackageId'):
            packages[source] = dict(id=source, name=(self.workspace.config or {}).get('campaignNames', {}).get(cid, cid),
                scope='campaign', sourceCampaignId=cid, available=True, local=True, localOwner='campaign:' + cid)
        if selection:
            enabled = list(selection.get('enabledPackageIds', []))
        else:
            enabled = [p['id'] for p in packages.values() if p['scope'] == 'general' and p['available']]
        if source and source not in enabled: enabled.append(source)
        enabled = sorted(set(enabled))
        missing = [identity for identity in enabled if identity not in packages or not packages[identity]['available']]
        for identity in missing:
            packages.setdefault(identity, dict(id=identity, name='缺失内容包', scope='campaign', sourceCampaignId='', available=False))
        revision = int(selection.get('_revision', 0))
        signature = encode(dict(campaignId=cid, selectionRevision=revision, sourcePackageId=source,
            enabledPackageIds=enabled, missingPackageIds=missing))
        return dict(campaignId=cid, revision=hashlib.sha256(signature.encode()).hexdigest(),
            selectionRevision=revision, enabledPackageIds=enabled, sourcePackageId=source,
            packages=sorted(packages.values(), key=lambda p:(p['scope'], p['name'], p['id'])), missingPackageIds=missing)

    def context(self, campaign_id):
        return self._context(campaign_id, self._read())

    def origin_for_template(self, template):
        scope = template.get('sourceScope') or template.get('scope', 'campaign' if template.get('campaignId') else 'general')
        if scope == 'personal':
            origin = self._personal_origin(template)
            origin.pop('boundCharacterId', None)
            origin.update(sourceTemplateId=template.get('id', ''), sourceTemplateVersion=template.get('version', 1))
            return origin
        if scope not in ('general', 'campaign'): raise ValueError('物品来源归属无效')
        cid = (template.get('sourceCampaignId') or template.get('campaignId', '')) if scope == 'campaign' else ''
        if scope == 'campaign' and not cid and not template.get('contentPackageId'):
            raise ValueError('战役物品缺少所属内容包')
        identity = template.get('contentPackageId') or template.get('sourcePackageId')
        if not identity:
            identity = self.context(cid)['sourcePackageId'] if cid else local_package_id('general:' + (template.get('moduleId') or '本地通用'))
        if not PACKAGE_ID.fullmatch(str(identity)): raise ValueError('物品内容包编号无效')
        return dict(sourcePackageId=identity, sourceScope=scope, sourceCampaignId=cid,
            sourceTemplateId=template.get('id', ''), sourceTemplateVersion=template.get('version', 1))

    def origin_for_custom(self, item, campaign_id):
        scope = item.get('scope', 'campaign' if campaign_id else 'general')
        if scope == 'personal': return self._personal_origin(item)
        cid = item.get('campaignId') or campaign_id if scope == 'campaign' else ''
        if scope == 'campaign' and not cid: raise ValueError('请先选择自定义物品的所属战役')
        origin = self.origin_for_template(dict(scope=scope, campaignId=cid or ''))
        origin.pop('sourceTemplateId'); origin.pop('sourceTemplateVersion')
        return origin

    def _personal_origin(self, item):
        oid = item.get('sourceCharacterId') or item.get('ownerCharacterId') or item.get('characterId')
        pid = item.get('sourcePlayerId') or item.get('ownerPlayerId') or item.get('playerId')
        if not re.fullmatch(r'o[0-9a-f]{32}', str(oid)):
            raise ValueError('角色专属物品需要明确所属角色')
        if self.database.is_file():
            db = open_readonly_database(self.database)
            try:
                row = db.execute("SELECT owner FROM documents WHERE kind='runtime-character' AND id=?", (oid,)).fetchone()
                if row:
                    if pid and pid != row[0]: raise ValueError('角色专属物品的玩家归属不一致')
                    pid = row[0]
            finally: db.close()
        if not re.fullmatch(r'p[0-9a-f]{32}', str(pid)):
            raise ValueError('角色专属物品需要明确所属玩家')
        return dict(sourcePackageId=local_package_id('player:' + pid), sourceScope='personal',
            sourceCampaignId='', sourcePlayerId=pid, sourceCharacterId=oid, boundCharacterId=oid)

    def _template(self, identity):
        if not identity: return None
        if identity in self._template_cache: return self._template_cache[identity]
        if self.database.is_file():
            db = open_readonly_database(self.database)
            try:
                row = db.execute("SELECT payload FROM documents WHERE kind='item-template' AND id=?", (identity,)).fetchone()
                if row:
                    self._template_cache[identity] = json.loads(row[0])
                    return self._template_cache[identity]
            finally: db.close()
        if not self.workspace.active:
            path = self.root/'玩家档案/物品库.json'
            if path.is_file():
                return next((i for i in json.loads(path.read_text('utf-8')).get('templates', []) if i.get('id') == identity), None)
        from .inventory import CATALOG
        return next((dict(i, scope='general', version=1) for i in CATALOG if i['id'] == identity), None)

    def normalize_origin(self, item, campaign_id=None):
        if item.get('sourcePackageId'):
            if not PACKAGE_ID.fullmatch(str(item['sourcePackageId'])) or item.get('sourceScope') not in ('general', 'campaign', 'personal'):
                return None
            if item['sourceScope'] == 'personal' and (not re.fullmatch(r'p[0-9a-f]{32}', str(item.get('sourcePlayerId'))) or
                    not re.fullmatch(r'o[0-9a-f]{32}', str(item.get('sourceCharacterId')))):
                return None
            return {k:copy.deepcopy(item[k]) for k in ORIGIN_FIELDS if k in item}
        template = self._template(item.get('sourceTemplateId'))
        if not template and not item.get('sourceTemplateId'):
            from .inventory import CATALOG, item_definition
            try:
                definition = item_definition(item, ValueError)
                template = next((dict(t, scope='general', version=1) for t in CATALOG
                    if item_definition(t, ValueError) == definition), None)
            except (ValueError, TypeError, KeyError):
                template = None
        if not template: return None
        origin = self.origin_for_template(template)
        # Resolving a legacy source tells us its package, not which later
        # definition version the already-owned copy was originally granted from.
        for key in ('sourceTemplateId', 'sourceTemplateVersion'):
            if key in item: origin[key] = copy.deepcopy(item[key])
        return origin

    def is_available(self, item, campaign_id):
        origin = self.normalize_origin(item, campaign_id)
        if not origin: return False
        if origin['sourceScope'] == 'personal':
            return not item.get('boundCharacterId') or not item.get('ownerCharacterId') or item.get('boundCharacterId') == item.get('ownerCharacterId')
        context = self.context(campaign_id)
        return origin['sourcePackageId'] in context['enabledPackageIds'] and origin['sourcePackageId'] not in context['missingPackageIds']

    def require_available(self, item, campaign_id, error):
        if not self.is_available(item, campaign_id):
            raise error('当前战役未启用这件物品的内容包，物品与剩余数量已保留', 409)

    def register(self, metadata, db=None, module_id=None, local=False):
        """Explicit registration only; callers may include it in their transaction."""
        meta = package_metadata(metadata)
        self._snapshot_cache = None
        store = ModuleStore(self.root)
        if db is None:
            with store.transaction() as conn: return self.register(metadata, conn, module_id, local)
        old = store.document(db, 'content-package', meta['id'])
        prior = old['data'] if old else {}
        if old and any(prior.get(k, '') != meta[k] for k in ('scope', 'sourceCampaignId')):
            raise RevisionConflict('同一内容包的归属不能改变')
        modules = sorted(set(prior.get('moduleIds', []) + ([module_id] if module_id else [])))
        virtual = self._catalog(self._read(db)).get(meta['id'], {}) if not old else {}
        local_owner = virtual.get('localOwner', '')
        locally_present = bool(local_owner and (db.execute(
            "SELECT 1 FROM documents WHERE kind IN ('template','item-template') AND owner=? LIMIT 1", (local_owner,)).fetchone()
            or (local_owner.startswith('campaign:') and (self.workspace.campaign(local_owner[9:])/'当前存档.json').is_file())))
        owner = prior.get('localOwner') or metadata.get('localOwner') or (local_owner if locally_present else '') or (
            'campaign:' + (meta['sourceCampaignId'] or meta['id']) if meta['scope'] == 'campaign' else 'general:' + meta['id'])
        data = dict(meta, moduleIds=modules, local=bool(local or prior.get('local') or locally_present), localOwner=owner,
            available=metadata.get('available', prior.get('available', True)))
        if not old or prior != data:
            store.write_document(db, 'content-package', meta['id'], old['owner'] if old else owner, data, old['revision'] if old else 0)
        return data

    def bind_run(self, campaign_id, source, enabled_ids=None, db=None):
        """Initialize a newly created run without replacing existing selection."""
        store = ModuleStore(self.root)
        self._snapshot_cache = None
        if db is None:
            with store.transaction() as conn: return self.bind_run(campaign_id, source, enabled_ids, conn)
        if store.document(db, 'content-selection', campaign_id): return
        context = self._context(campaign_id, self._read(db))
        enabled = list(enabled_ids) if enabled_ids is not None else [p['id'] for p in context['packages'] if p['scope']=='general' and p['available']]
        enabled.append(source)
        store.write_document(db, 'content-selection', campaign_id, 'campaign:' + campaign_id,
            dict(sourcePackageId=source, enabledPackageIds=sorted(set(enabled)), receipts={}), 0)

    def set_enabled(self, campaign_id, ids, expected_revision, request_id):
        if not isinstance(campaign_id, str) or not 1 <= len(campaign_id) <= 128:
            raise ValueError('请先选择战役')
        if not isinstance(ids, list) or len(ids)>256 or any(not PACKAGE_ID.fullmatch(str(i)) for i in ids):
            raise ValueError('内容包清单无效')
        if type(expected_revision) is not int or expected_revision < 0 or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', str(request_id)):
            raise ValueError('内容包操作版本或编号无效')
        ids = sorted(set(ids))
        self._snapshot_cache = None
        signature = hashlib.sha256(encode([campaign_id, ids, expected_revision]).encode()).hexdigest()
        store = ModuleStore(self.root)
        from .save_storage import SAVE_WRITE_LOCK
        from .player_profiles import LOCK
        with SAVE_WRITE_LOCK, LOCK, store.transaction() as db:
            snapshot = self._read(db)
            current = self._context(campaign_id, snapshot)
            old = store.document(db, 'content-selection', campaign_id)
            receipts = copy.deepcopy(old['data'].get('receipts', {})) if old else {}
            if request_id in receipts:
                if receipts[request_id] != signature: raise RevisionConflict('操作编号已被使用')
                return current
            if expected_revision != current['selectionRevision']:
                raise RevisionConflict('战役启用内容已更新，请刷新后重试')
            known = {p['id']:p for p in current['packages']}
            if any(i not in known for i in ids): raise ValueError('所选内容包不存在，请先导入')
            if any(not known[i]['available'] and i not in current['enabledPackageIds'] for i in ids):
                raise ValueError('所选内容包缺失或已卸载，请先恢复')
            for i in ids + [current['sourcePackageId']]:
                if i and i not in snapshot[0] and known[i].get('local'):
                    self.register(known[i], db, local=True)
            receipts[request_id] = signature
            while len(receipts)>512: receipts.pop(next(iter(receipts)))
            data = dict(sourcePackageId=current['sourcePackageId'],
                enabledPackageIds=sorted(set(ids + [current['sourcePackageId']])), receipts=receipts)
            store.write_document(db, 'content-selection', campaign_id, 'campaign:' + campaign_id,
                data, current['selectionRevision'])
            return self._context(campaign_id, self._read(db))

    def migration_plan(self, overrides=None):
        """Read-only preview. Overrides are keyed by immutable item instance ID."""
        overrides = copy.deepcopy(overrides or {})
        if not isinstance(overrides, dict): raise ValueError('旧物品归属确认应按物品编号提供')
        if not self.database.is_file(): raise ValueError('缺少待迁移的模块数据库')
        db = open_readonly_database(self.database)
        try:
            db.execute('BEGIN')
            self._snapshot_cache = self._read(db)
            rows = [dict(r) for r in db.execute("SELECT kind,id,owner,revision,payload FROM documents WHERE kind IN ('item-template','runtime-backpack','runtime-map','runtime-meta','catalog-meta','content-package','content-selection') ORDER BY kind,id")]
        finally: db.close()
        self._template_cache = {r['id']:json.loads(r['payload']) for r in rows if r['kind']=='item-template'}
        changes, unresolved, used_overrides = [], [], set()
        def visit_item(item, path, campaign=None):
            if item.get('sourcePackageId'):
                if self.normalize_origin(item) is None: unresolved.append(dict(path=path, id=item.get('id'), name=item.get('name'), reason='invalid-origin'))
                return
            identity = item.get('id')
            if identity in overrides:
                raw = dict(overrides[identity], ownerCharacterId=item.get('ownerCharacterId'))
                origin = self.origin_for_custom(raw, raw.get('campaignId') or campaign)
                used_overrides.add(identity)
            else:
                origin = self.normalize_origin(item)
                if not origin and campaign: origin = self.origin_for_custom({}, campaign)
            if origin: item.update(origin)
            else: unresolved.append(dict(path=path, id=identity, name=item.get('name'), reason='missing-origin'))
        for row in rows:
            original = json.loads(row['payload'])
            updated = copy.deepcopy(original)
            kind, identity = row['kind'], row['id']
            if kind == 'item-template':
                updated.setdefault('contentPackageId', self.origin_for_template(updated)['sourcePackageId'])
            elif kind == 'runtime-backpack':
                for item in updated.get('items', []): visit_item(item, 'backpack:'+identity)
                for removal in updated.get('removedItems', []): visit_item(removal['item'], 'removed:'+identity)
            elif kind == 'runtime-map':
                for mid, group in updated.items():
                    for marker in group.get('markers', []):
                        for item in marker.get('items', []): visit_item(item, 'map:'+identity+':'+mid, identity)
                        if marker.get('containerItem'): visit_item(marker['containerItem'], 'container:'+identity+':'+mid, identity)
            if updated != original:
                changes.append(dict(kind=kind, id=identity, owner=row['owner'], revision=row['revision'], data=updated))
        unused = sorted(set(overrides)-used_overrides)
        if unused: raise ValueError('旧物品确认编号未命中待迁移物品：'+', '.join(unused))
        campaign_ids = set((self.workspace.config or {}).get('campaignNames', {})) | set(self._snapshot_cache[4])
        contexts = [self.context(cid) for cid in sorted(campaign_ids)
                    if self.workspace.campaign(cid).is_dir() and not (self.workspace.campaign(cid)/'已删除.json').exists()]
        packages = {p['id']:p for p in self.catalog() if p.get('local')}
        for context in contexts:
            for p in context['packages']:
                if p.get('local'): packages[p['id']] = p
        fingerprint = hashlib.sha256(encode(rows).encode()).hexdigest()
        result = dict(format='sundoll-content-origin-migration', version=1, beforeHash=fingerprint,
            overrides=overrides, changes=changes, unresolved=unresolved,
            packages=list(packages.values()), campaigns=[{k:c[k] for k in ('campaignId','sourcePackageId','enabledPackageIds')} for c in contexts])
        result['planHash'] = hashlib.sha256(encode(result).encode()).hexdigest()
        result['summary'] = dict(changedDocuments=len(changes), templates=sum(r['kind']=='item-template' for r in changes),
            backpacks=sum(r['kind']=='runtime-backpack' for r in changes), maps=sum(r['kind']=='runtime-map' for r in changes), unresolved=len(unresolved))
        return result

    plan_migration = migration_plan

    def apply_migration(self, plan):
        """Explicit, reviewed migration; never called by a read or startup path."""
        from .save_storage import SAVE_WRITE_LOCK
        from .player_profiles import LOCK
        if not isinstance(plan, dict) or plan.get('format') != 'sundoll-content-origin-migration':
            raise ValueError('迁移方案无效')
        store = ModuleStore(self.root)
        with SAVE_WRITE_LOCK, LOCK, store.transaction() as db:
            receipt = db.execute('SELECT payload FROM migrations WHERE id=?', ('content-origins-v1',)).fetchone()
            if receipt:
                result = json.loads(receipt[0])
                if result['planHash'] != plan.get('planHash'): raise RevisionConflict('此工作区已完成另一版内容来源迁移')
                return result
            current = ContentPackages(self.root).migration_plan(plan.get('overrides'))
            if current['planHash'] != plan.get('planHash'): raise RevisionConflict('存档或归属方案已变化，请重新生成迁移预览')
            if current['unresolved']: raise ValueError('仍有旧物品来源待确认，未执行迁移')
            for package in current['packages']: self.register(package, db, local=True)
            for campaign in current['campaigns']:
                self.bind_run(campaign['campaignId'], campaign['sourcePackageId'], campaign['enabledPackageIds'], db)
            for row in current['changes']:
                store.write_document(db, row['kind'], row['id'], row['owner'], row['data'], row['revision'])
            if any(r['kind'].startswith('runtime-') for r in current['changes']):
                meta = store.document(db, 'runtime-meta', 'resources')
                if meta: store.write_document(db, 'runtime-meta', 'resources', '', meta['data'], meta['revision'])
            if any(r['kind']=='item-template' for r in current['changes']):
                meta = store.document(db, 'catalog-meta', 'item-template')
                if meta:
                    value = dict(meta['data'], revision=meta['data'].get('revision',0)+1)
                    store.write_document(db, 'catalog-meta', 'item-template', '', value, meta['revision'])
            result = dict(planHash=current['planHash'], **current['summary'])
            db.execute('INSERT INTO migrations VALUES (?,?)', ('content-origins-v1', encode(result)))
            self._snapshot_cache = None
            return result
