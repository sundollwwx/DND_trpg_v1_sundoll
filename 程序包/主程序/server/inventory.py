"""Private player backpacks shared across campaigns; mutations use revisions and receipts."""
import copy
import hashlib
import json
import re
import secrets
import time
from decimal import Decimal, InvalidOperation

CATEGORIES = ('potion', 'scroll', 'wondrous', 'gear', 'document', 'container')
RARITIES = ('普通', '非普通', '珍稀', '极珍稀', '传说')
CHEST = dict(id='treasure-chest', name='宝箱', category='container', rarity='', consumable=False, effect='可以装入物品的木制宝箱。放到地图后，打开宝箱查看和分配箱内物品。', description='包铁木板与黄铜锁扣，妥善收起旅途中的发现。')

CATALOG = [
    dict(id='healing', name='治疗药水', category='potion', rarity='普通', consumable=True, effect='饮用后恢复 2d4+2 点生命值。'),
    dict(id='greater-healing', name='高等治疗药水', category='potion', rarity='非普通', consumable=True, effect='饮用后恢复 4d4+4 点生命值。'),
    dict(id='superior-healing', name='强效治疗药水', category='potion', rarity='珍稀', consumable=True, effect='饮用后恢复 8d4+8 点生命值。'),
    dict(id='supreme-healing', name='顶级治疗药水', category='potion', rarity='极珍稀', consumable=True, effect='饮用后恢复 10d4+20 点生命值。'),
    dict(id='climbing', name='攀爬药水', category='potion', rarity='普通', consumable=True, effect='持续 1 小时：获得等于步行速度的攀爬速度，攀爬相关力量（运动）检定具有优势。'),
    dict(id='water-breathing', name='水下呼吸药水', category='potion', rarity='非普通', consumable=True, effect='持续 1 小时：可以在水下呼吸。'),
    dict(id='invisibility', name='隐形药水', category='potion', rarity='极珍稀', consumable=True, effect='持续至多 1 小时：你和携带的物品隐形。攻击或施法时效果结束。'),
    dict(id='fire-resistance', name='火焰抗性药水', category='potion', rarity='非普通', consumable=True, effect='持续 1 小时：获得火焰伤害抗性。'),
    dict(id='detect-magic', name='侦测魔法卷轴', category='scroll', rarity='普通', consumable=True, effect='按法术卷轴规则施放侦测魔法；持续至多 10 分钟，需要专注。使用资格由主控确认。'),
    dict(id='bag-of-holding', name='次元袋', category='wondrous', rarity='非普通', consumable=False, effect='容纳至多 500 磅、64 立方尺的物品。取出物品需要一个动作；具体边界由主控裁定。'),
    dict(id='driftglobe', name='漂浮光球', category='wondrous', rarity='非普通', consumable=False, effect='可发出光亮并漂浮跟随。昼明术每日黎明恢复；次数由主控和玩家记录。'),
]

CATALOG.append(CHEST)

HEALING_RULES = {'healing': (2, 4, 2), 'greater-healing': (4, 4, 4), 'superior-healing': (8, 4, 8), 'supreme-healing': (10, 4, 20)}
for preset in CATALOG:
    if preset['id'] in HEALING_RULES:
        preset.update(ruleId=preset['id'], ruleVersion=1)

def item_definition(data, error):
    if not isinstance(data, dict): raise error('物品资料无效')
    result = {k: data.get(k) for k in ('name', 'category', 'rarity', 'effect', 'consumable')}
    for key, maximum in (('name', 60), ('effect', 1200)):
        if not isinstance(result[key], str) or not result[key].strip() or len(result[key]) > maximum:
            raise error('请填写物品名称与效果说明，并控制长度')
        result[key] = result[key].strip()
    if result['category'] in ('gear', 'document', 'container'):
        result['rarity'] = ''
        if result['category'] in ('document', 'container'): result['consumable'] = False
    if result['category'] not in CATEGORIES or (result['category'] not in ('gear', 'document', 'container') and result['rarity'] not in RARITIES) or type(result['consumable']) is not bool:
        raise error('物品分类、稀有度或使用方式无效')
    for key, limit in (('description', 2000), ('image', 250000)):
        value = data.get(key, '')
        if not isinstance(value, str) or len(value) > limit: raise error('图片或描述过长')
        if key == 'image' and value and not (re.fullmatch(r'data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+', value) or re.fullmatch(r'/api/module-assets/[0-9a-f]{64}', value) or (value.startswith('https://') and len(value) <= 2048)):
            raise error('图片需为 HTTPS 地址或 PNG/JPEG/WebP 图片')
        result[key] = value
    if 'body' in data or result['category'] == 'document':
        body = data.get('body', '')
        if not isinstance(body, str) or len(body) > 20000: raise error('正文最多 20000 字')
        result['body'] = body
    if 'documentType' in data:
        kind = data['documentType']
        if result['category'] != 'document' or kind not in ('letter', 'book'):
            raise error('文书类型无效')
        if not result['body'].strip(): raise error('请填写信件或书籍正文')
        if kind == 'letter' and '\f' in result['body']:
            raise error('信件只能有一页')
        if kind == 'book' and (result['body'].count('\f') >= 24 or any(not page.strip() for page in result['body'].split('\f'))):
            raise error('书籍最多 24 页，且每页都需要正文')
        result['documentType'] = kind
    if data.get('ruleId'):
        if data['ruleId'] not in HEALING_RULES or type(data.get('ruleVersion')) is not int or data['ruleVersion'] != 1 or result['category'] != 'potion' or not result['consumable']:
            raise error('物品规则版本无效')
        result.update(ruleId=data['ruleId'], ruleVersion=1)
    if data.get('valueCp') is not None:
        if type(data['valueCp']) is not int or not 0 <= data['valueCp'] <= 10000000000:
            raise error('价值应为非负数，最小单位为 1 铜币')
        result['valueCp'] = data['valueCp']
        currency = data.get('valueCurrency', 'gp')
        if currency not in ('cp', 'sp', 'ep', 'gp', 'pp'): raise error('币种无效')
        result['valueCurrency'] = currency
    if data.get('weightLb') is not None:
        v = data['weightLb']
        if type(v) not in (int, float): raise error('重量应为非负数字（磅）')
        try:
            d = Decimal(str(v))
            if not d.is_finite() or not 0 <= d <= 1000000 or d * 1000 != (d * 1000).to_integral_value(): raise ValueError()
        except (InvalidOperation, ValueError): raise error('重量应为 0–1000000 磅，最多三位小数')
        result['weightLb'] = v
    return result


def validate_removed(value):
    removed = value.get('removedItems', [])
    if not isinstance(removed, list): raise ValueError()
    seen = set()
    for entry in removed:
        if (not isinstance(entry, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', str(entry.get('id')))
                or entry['id'] in seen or entry.get('op') not in ('delete', 'discard') or type(entry.get('at')) is not int): raise ValueError()
        seen.add(entry['id'])
        item = entry['item']; item_definition(item, ValueError)
        if not re.fullmatch(r'i[0-9a-f]{32}', str(item.get('id'))) or type(item.get('quantity')) is not int or not 1 <= item['quantity'] <= 999: raise ValueError()


class InventoryStore:
    def __init__(self, profiles, implementation):
        self.profiles = profiles
        self.impl = implementation
        self.error = implementation.ProfileError

    def path(self, pid, campaign=None):
        return self.profiles.path(pid, '背包/随身背包.json')

    def _read_file(self, pid, path, campaign=None):
        try:
            value = json.loads(path.read_text('utf-8'))
            if (not isinstance(value, dict) or value.get('playerId') != pid
                    or (value.get('campaignId') != campaign if campaign is not None else value.get('scope') != 'player')
                    or type(value.get('revision')) is not int or value['revision'] < 1
                    or not isinstance(value.get('items'), list) or not isinstance(value.get('history'), list)
                    or not isinstance(value.get('receipts'), dict)):
                raise ValueError()
            seen = set()
            for item in value['items']:
                item_definition(item, ValueError)
                if (not re.fullmatch(r'i[0-9a-f]{32}', str(item.get('id'))) or item['id'] in seen
                        or type(item.get('quantity')) is not int or not 0 <= item['quantity'] <= 999):
                    raise ValueError()
                seen.add(item['id'])
            validate_removed(value)
            legacy_receipts = value.get('legacyReceipts', {})
            if not isinstance(legacy_receipts, dict) or any(not isinstance(group, dict) for group in legacy_receipts.values()):
                raise ValueError()
            all_receipts = list(value['receipts'].values()) + [r for group in legacy_receipts.values() for r in group.values()]
            if any(not isinstance(r, dict) or not isinstance(r.get('signature'), str) or not isinstance(r.get('event'), dict) for r in all_receipts):
                raise ValueError()
            if any(not isinstance(e, dict) or not isinstance(e.get('name'), str) or type(e.get('at')) is not int for e in value['history']):
                raise ValueError()
            return value
        except FileNotFoundError:
            raise self.error('背包存档读取中断，请重试；原文件未被覆盖', 503)
        except (ValueError, TypeError, KeyError, AttributeError):
            raise self.error('背包存档损坏，请主控检查自动备份；原文件未被覆盖', 503)

    def read(self, pid, campaign=None):
        with self.impl.LOCK:
            self.profiles.read(pid)
            path = self.path(pid)
            if path.exists():
                return self._read_file(pid, path)
            sources = []
            for old_path in sorted(path.parent.glob('*.json')):
                if not re.fullmatch(r'[0-9a-f]{64}\.json', old_path.name): continue
                try:
                    legacy_campaign = json.loads(old_path.read_text('utf-8'))['campaignId']
                    if not isinstance(legacy_campaign, str) or hashlib.sha256(legacy_campaign.encode()).hexdigest() != old_path.stem:
                        raise ValueError()
                    sources.append((old_path, self._read_file(pid, old_path, legacy_campaign)))
                except (ValueError, TypeError, KeyError):
                    raise self.error('旧背包存档损坏，迁移已停止；原文件未被覆盖', 503)
            if not sources:
                return dict(playerId=pid, scope='player', revision=0, items=[], history=[], receipts={})
            merged = dict(playerId=pid, scope='player', revision=max(v['revision'] for _, v in sources)+1,
                          items=[], history=[], receipts={}, legacyReceipts={}, migratedFrom=[])
            seen = set()
            for old_path, value in sources:
                ids = {}
                for item in value['items']:
                    item = copy.deepcopy(item)
                    old_id = item['id']
                    if old_id in seen:
                        item['id'] = 'i' + hashlib.sha256((old_path.name + old_id).encode()).hexdigest()[:32]
                    if item['id'] in seen: raise self.error('旧背包物品编号冲突，请主控检查原档', 503)
                    ids[old_id] = item['id']; seen.add(item['id']); merged['items'].append(item)
                def remap(event):
                    event = copy.deepcopy(event)
                    if event.get('itemId') in ids: event['itemId'] = ids[event['itemId']]
                    return event
                merged['history'].extend(remap(event) for event in value['history'])
                merged['legacyReceipts'][value['campaignId']] = {
                    key: dict(signature=receipt['signature'], event=remap(receipt['event']))
                    for key, receipt in value['receipts'].items()
                }
                merged['migratedFrom'].append(old_path.name)
            merged['history'] = sorted(merged['history'], key=lambda event: event['at'])[-80:]
            # Validate everything before writing. Originals remain in place for rollback.
            for old_path, value in sources:
                self.impl.atomic(path.parent / '自动备份' / ('迁移前-' + old_path.name), value)
            self.impl.atomic(path, merged)
            return merged

    @staticmethod
    def public(value):
        result = {k: copy.deepcopy(value[k]) for k in ('playerId', 'scope', 'revision', 'items', 'history')}
        result['removedItems'] = copy.deepcopy(value.get('removedItems', []))
        return result

    def commit(self, pid, campaign, old, value):
        path = self.path(pid, campaign)
        backup = path.parent / '自动备份' / (path.stem + '-%s.json' % old['revision'])
        if old['revision'] > 0: self.impl.atomic(backup, old)
        self.impl.atomic(path, value)

    def grant_definition(self, command):
        preset = next((p for p in CATALOG if p['id'] == command.get('presetId')), None)
        if command.get('presetId') and not preset: raise self.error('物品预设不存在', 404)
        return item_definition(preset or command.get('item'), self.error)

    def apply(self, pid, campaign, command, host=False):
        with self.impl.LOCK:
            value = self.read(pid, campaign)
            op = command.get('op')
            if op not in ('grant', 'use', 'adjust', 'edit', 'annotate', 'delete', 'discard', 'restore', 'purge') or (op not in ('use', 'annotate', 'discard') and not host):
                raise self.error('仅主控可以发放或调整物品', 403)
            request_id = command.get('requestId')
            if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', request_id):
                raise self.error('操作编号无效')
            signed = {k: command.get(k) for k in ('op', 'itemId', 'presetId', 'item', 'quantity', 'revision')}
            if 'templateId' in command or 'templateVersion' in command:
                signed.update(templateId=command.get('templateId'), templateVersion=command.get('templateVersion'))
            if op in ('restore', 'purge'): signed['removalId'] = command.get('removalId')
            if op == 'annotate': signed.update(favorite=command.get('favorite'), notes=command.get('notes'))
            signed['host'] = bool(host)
            if 'characterId' in command:
                signed['characterId'] = command['characterId']
            signature = hashlib.sha256(json.dumps(signed, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            previous = value['receipts'].get(request_id) or value.get('legacyReceipts', {}).get(campaign, {}).get(request_id)
            if previous:
                if previous['signature'] != signature: raise self.error('操作编号已用于另一项操作，请重新打开背包', 409)
                return self.public(value), previous['event']
            if type(command.get('revision')) is not int or command['revision'] != value['revision']:
                raise self.error('背包已更新，请核对最新数量后再操作', 409)
            old = copy.deepcopy(value)
            if op in ('restore', 'purge'):
                removed = value.get('removedItems', [])
                entry = next((r for r in removed if r['id'] == command.get('removalId')), None)
                if not entry: raise self.error('这条移除记录已处理或不存在，请刷新', 409)
                archived = entry['item']
                if op == 'restore':
                    item = next((i for i in value['items'] if i['id'] == archived['id']), None)
                    comparable = lambda i: {k: v for k, v in i.items() if k not in ('quantity', 'resourceRevision')}
                    # A later edit must survive restoration. Keep the archived text/notes in
                    # a separate entry when the original stack changed or is already full.
                    if item is None or comparable(item) != comparable(archived) or item['quantity'] + archived['quantity'] > 999:
                        if len(value['items']) >= 300: raise self.error('背包条目已满，请先整理后恢复', 409)
                        old_item = item
                        item = copy.deepcopy(archived)
                        if old_item is not None: item['id'] = 'i'+secrets.token_hex(16)
                        item['quantity'] = 0
                        value['items'].append(item)
                    delta = archived['quantity']
                    item['quantity'] += delta
                else:
                    item = archived
                    delta = 0
                removed.remove(entry)
            elif op == 'grant':
                definition = self.grant_definition(command)
                quantity = command.get('quantity')
                if type(quantity) is not int or not 1 <= quantity <= 999: raise self.error('发放数量应为 1–999')
                character_id = command.get('characterId') or ''
                item = next((i for i in value['items'] if (i.get('ownerCharacterId') or '') == character_id
                             and item_definition(i, self.error) == item_definition(definition, self.error)
                             and all(i.get(k) == definition.get(k) for k in ('sourceTemplateId', 'sourceTemplateVersion'))), None)
                if item is None:
                    if len(value['items']) >= 300: raise self.error('背包物品种类已达 300 项，请先整理')
                    item = dict(definition, id='i'+secrets.token_hex(16), quantity=0)
                    if character_id: item['ownerCharacterId'] = character_id
                    value['items'].append(item)
                if item['quantity'] + quantity > 999: raise self.error('单种物品最多保留 999 份')
                item['quantity'] += quantity
                delta = quantity
            else:
                item = next((i for i in value['items'] if i['id'] == command.get('itemId')), None)
                if item is None: raise self.error('物品不存在，请刷新背包', 404)
                if op in ('delete', 'discard'):
                    quantity = item['quantity'] if op == 'delete' else command.get('quantity')
                    if type(quantity) is not int or not 1 <= quantity <= item['quantity']:
                        raise self.error('弃置数量应为 1 到当前持有数量，请核对后重试', 409)
                    archived = dict(copy.deepcopy(item), quantity=quantity)
                    value.setdefault('removedItems', []).append(dict(id=request_id, at=int(time.time()*1000), op=op, item=archived))
                    delta = -quantity
                elif op == 'edit':
                    definition = item_definition(command.get('item'), self.error)
                    for key in ('ruleId', 'ruleVersion', 'body', 'documentType', 'valueCp', 'valueCurrency', 'weightLb'):
                        if key not in definition: item.pop(key, None)
                    item.update(definition)
                    delta = 0
                elif op == 'annotate':
                    notes = command.get('notes', item.get('notes', ''))
                    favorite = command.get('favorite', item.get('favorite', False))
                    if not isinstance(notes, str) or len(notes) > 2000 or type(favorite) is not bool:
                        raise self.error('备注最多2000字，收藏状态无效')
                    item.update(notes=notes, favorite=favorite)
                    delta = 0
                elif op == 'use':
                    if item['quantity'] < 1: raise self.error('这件物品已经用完', 409)
                    delta = -1 if item['consumable'] else 0
                else:
                    quantity = command.get('quantity')
                    if type(quantity) is not int or not 0 <= quantity <= 999: raise self.error('数量应为 0–999')
                    delta = quantity - item['quantity']
                item['quantity'] += delta
                if op in ('delete', 'discard') and item['quantity'] == 0: value['items'].remove(item)
            event = dict(id=request_id, at=int(time.time()*1000), op=op, name=item['name'], itemId=item['id'],
                         delta=delta, remaining=0 if op == 'purge' else item['quantity'], effect=item['effect'] if op == 'use' else '', actor='主控' if host else '玩家')
            if op in ('restore', 'purge'): event['removalId'] = command.get('removalId')
            value['history'] = (value['history'] + [event])[-80:]
            value['receipts'][request_id] = dict(signature=signature, event=event)
            # Old requests still fail their revision check after their receipt ages out.
            if len(value['receipts']) > 512: value['receipts'].pop(next(iter(value['receipts'])))
            value['revision'] += 1
            self.commit(pid, campaign, old, value)
            return self.public(value), event
