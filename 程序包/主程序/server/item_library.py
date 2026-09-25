"""Host-only reusable item definitions. Granted copies retain their own snapshots."""
import copy
import hashlib
import json
import re
import secrets
from .workspace import read_catalog, write_catalog
from .inventory import CATALOG, CHEST, item_definition


class ItemLibrary:
    def __init__(self, profiles, implementation):
        self.profiles = profiles
        self.impl = implementation
        self.error = implementation.ProfileError
        self.path = profiles.root / '物品库.json'

    def metadata(self, data):
        scope = data.get('scope', 'campaign' if data.get('category') == 'document' else 'general')
        if scope not in ('general', 'campaign'): raise self.error('请选择通用或战役归属')
        result = dict(scope=scope)
        for key, maximum in (('campaignId', 128), ('campaignName', 120), ('location', 120)):
            v = data.get(key, '')
            if not isinstance(v, str) or len(v) > maximum: raise self.error('战役归属或地点无效')
            result[key] = v.strip()
        if scope == 'campaign' and not result['campaignId']: raise self.error('请先选择所属战役')
        if scope == 'general': result.update(campaignId='', campaignName='', location='')
        refs = data.get('usedIn', [])
        if not isinstance(refs, list) or len(refs) > 100: raise self.error('战役引用过多')
        result['usedIn'] = []
        for ref in refs:
            if not isinstance(ref, dict) or not isinstance(ref.get('id'), str) or not 1 <= len(ref['id']) <= 128 or not isinstance(ref.get('name'), str) or len(ref['name']) > 120:
                raise self.error('战役引用无效')
            if ref['id'] not in [r['id'] for r in result['usedIn']]: result['usedIn'].append(dict(id=ref['id'], name=ref['name']))
        return result

    def read(self):
        with self.impl.LOCK:
            try:
                data = read_catalog(self.profiles.save_root, 'item-template')
                if data.get('schemaVersion') != 1 or type(data.get('revision')) is not int or data['revision'] < 1 or not isinstance(data.get('templates'), list) or not isinstance(data.get('receipts'), dict): raise ValueError()
                ids = set()
                for t in data['templates']:
                    item_definition(t, ValueError)
                    self.metadata(t)
                    if not isinstance(t.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', t['id']) or t['id'] in ids or type(t.get('version')) is not int or t['version'] < 1 or type(t.get('archived')) is not bool: raise ValueError()
                    ids.add(t['id'])
                if any(not isinstance(r, dict) or not isinstance(r.get('signature'), str) or not isinstance(r.get('templateId'), str) for r in data['receipts'].values()): raise ValueError()
                if data.get('containerTemplatesVersion', 0) < 1:
                    old = copy.deepcopy(data)
                    if not any(t['id'] == CHEST['id'] for t in data['templates']):
                        data['templates'].append(dict(item_definition(CHEST, self.error), id=CHEST['id'], version=1, archived=False, **self.metadata({})))
                    data['containerTemplatesVersion'] = 1
                    data['revision'] += 1
                    self.impl.atomic(self.path.parent / '物品库自动备份' / ('%s.json' % old['revision']), old)
                    write_catalog(self.profiles.save_root, 'item-template', data)
                return data
            except FileNotFoundError:
                seeds = [] if (self.profiles.project / 'distribution.json').exists() else CATALOG
                data = dict(schemaVersion=1, containerTemplatesVersion=1, revision=1, templates=[dict(item_definition(p, self.error), id=p['id'], version=1, archived=False, **self.metadata({})) for p in seeds], receipts={})
                write_catalog(self.profiles.save_root, 'item-template', data)
                return data
            except (ValueError, TypeError, KeyError, AttributeError, self.error):
                raise self.error('物品库损坏，请检查自动备份；原文件未覆盖', 503)

    @staticmethod
    def public(data):
        return dict(revision=data['revision'], templates=copy.deepcopy(data['templates']))

    def resolve(self, template_id, version=None, required=True):
        template = next((t for t in self.read()['templates'] if t['id'] == template_id), None)
        if not template or template['archived']: raise self.error('物品模板已归档或不存在，请刷新物品库', 409)
        if (required or version is not None) and (type(version) is not int or version != template['version']):
            raise self.error('物品模板已更新，请重新核对后发放', 409)
        return template

    def apply(self, command):
        with self.impl.LOCK:
            data = self.read()
            if command.get('op') == 'get': return dict(library=self.public(data))
            op = command.get('op')
            if op not in ('create', 'edit', 'duplicate', 'archive', 'restore', 'fromBag'): raise self.error('物品库操作无效')
            rid = command.get('requestId')
            if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', rid): raise self.error('操作编号无效')
            signed = {k: command.get(k) for k in ('op', 'revision', 'templateId', 'templateVersion', 'item', 'playerId', 'itemId', 'bagRevision')}
            signature = hashlib.sha256(json.dumps(signed, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            prior = data['receipts'].get(rid)
            if prior:
                if prior['signature'] != signature: raise self.error('操作编号已被使用，请重新操作', 409)
                return dict(library=self.public(data), templateId=prior['templateId'])
            if type(command.get('revision')) is not int or command['revision'] != data['revision']: raise self.error('物品库已更新，请刷新后重试；编辑内容仍可保留', 409)
            old = copy.deepcopy(data)
            current = None
            if op in ('edit', 'duplicate', 'archive', 'restore'):
                current = next((t for t in data['templates'] if t['id'] == command.get('templateId')), None)
                if not current or type(command.get('templateVersion')) is not int or command['templateVersion'] != current['version']: raise self.error('模板已更新，请刷新后重试', 409)
            if op in ('archive', 'restore'):
                current.update(archived=op == 'archive', version=current['version'] + 1)
                result = current
            else:
                raw = command.get('item')
                if op == 'fromBag':
                    from .resources import ResourceStore
                    bag = ResourceStore(self.profiles, self.impl).read(command.get('playerId'))
                    if type(command.get('bagRevision')) is not int or bag['revision'] != command['bagRevision']: raise self.error('背包已更新，请刷新后另存模板', 409)
                    source = next((i for i in bag['items'] if i['id'] == command.get('itemId') and i['quantity'] > 0), None)
                    if not source: raise self.error('背包物品不存在', 404)
                    raw = dict(item_definition(source, self.error), **self.metadata(raw or {}))
                elif op == 'duplicate':
                    raw = dict(current, name=current['name'][:55]+' · 副本')
                if not isinstance(raw, dict): raise self.error('物品资料无效')
                result = dict(item_definition(raw, self.error), **self.metadata(raw))
                if result['category'] == 'document' and not result.get('image'):
                    from .module_store import ModuleStore
                    kind = 'book' if result.get('documentType') == 'book' else 'letter'
                    artwork = self.profiles.project / 'asset/界面/物品/文书' / (kind + '-v2.png')
                    if artwork.is_file():
                        owner = 'campaign:' + result['campaignId'] if result['scope'] == 'campaign' else 'catalog:item-template'
                        result['image'] = ModuleStore(self.profiles.save_root).put_asset(artwork.read_bytes(), 'image/png', owner)
                result.update(id=current['id'] if op == 'edit' else 'tpl_'+secrets.token_hex(16), version=current['version']+1 if op == 'edit' else 1, archived=current['archived'] if op == 'edit' else False)
                if op == 'edit':
                    if current.get('moduleId'): result['moduleId']=current['moduleId']
                    data['templates'][data['templates'].index(current)] = result
                else:
                    if len(data['templates']) >= 3000: raise self.error('物品库已达 3000 项，请先整理')
                    data['templates'].append(result)
            data['revision'] += 1
            data['receipts'][rid] = dict(signature=signature, templateId=result['id'])
            self.impl.atomic(self.path.parent / '物品库自动备份' / ('%s.json' % old['revision']), old)
            write_catalog(self.profiles.save_root, 'item-template', data)
            return dict(library=self.public(data), templateId=result['id'])
