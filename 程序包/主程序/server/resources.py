"""Authoritative resources and character runtime. One atomic ledger commits both.

Legacy backpacks are lazily copied, never removed. Map/library tokens are projections;
characterRevision prevents stale maps or reconnects from replacing newer runtime.
"""
import copy
import hashlib
import json
import re
import secrets
import time
from .inventory import InventoryStore, CATALOG, HEALING_RULES, item_definition, validate_removed
from .resource_database import ResourceDatabase
from .module_store import RevisionConflict

RUNTIME_FIELDS = ('hp', 'tempHp', 'tempHpMax', 'conditions', 'spellSlots', 'resourceSlots')
BASE_FIELDS = ('hpMax', 'ac', 'level')


def tokens(state):
    seen = set()
    for m in (state or {}).get('maps', []):
        for t in m.get('tokens', []):
            seen.add((m.get('id'), t.get('id')))
            yield m, t
    for e in (state or {}).get('_ownedPieceLocations', []):
        t = e.get('token', {})
        if (e.get('mapId'), t.get('id')) not in seen:
            seen.add((e.get('mapId'), t.get('id')))
            yield {'id': e.get('mapId')}, t
    for t in (state or {}).get('parkedOwnedPieces', {}).values():
        yield {}, t


def projection(c):
    return dict(c['base'], **c['runtime'], name=c['name'], characterRevision=c['revision'])


def project(state, c):
    all_tokens = [t for _, t in tokens(state)] + [e.get('token', {}) for e in (state or {}).get('_ownedPieceLocations', [])]
    for t in all_tokens:
        if t.get('ownedPieceId') == c['id'] and t.get('ownerPlayerId') == c['ownerPlayerId']:
            t.update(projection(c))


class ResourceStore(InventoryStore):
    def grant_definition(self, command):
        from .item_library import ItemLibrary
        template_id = command.get('templateId') or command.get('presetId')
        if not template_id: return item_definition(command.get('item'), self.error)
        template = ItemLibrary(self.profiles, self.impl).resolve(template_id, command.get('templateVersion'), required='templateId' in command)
        return dict(item_definition(template, self.error), sourceTemplateId=template['id'], sourceTemplateVersion=template['version'])

    def __init__(self, profiles, implementation):
        super().__init__(profiles, implementation)
        self.ledger_path = profiles.root / '冒险资源.json'
        self.working = None
        self.database = ResourceDatabase(profiles.save_root)

    def ledger(self):
        try:
            data = self.database.read() if self.database.active() else json.loads(self.ledger_path.read_text('utf-8'))
            if data.get('version') != 1 or type(data.get('revision')) is not int or not isinstance(data.get('backpacks'), dict) or not isinstance(data.get('characters'), dict):
                raise ValueError()
            for pid, bag in data['backpacks'].items():
                if bag.get('playerId') != pid or not re.fullmatch(r'p[0-9a-f]{32}', pid) or type(bag.get('revision')) is not int or not isinstance(bag.get('receipts'), dict) or not isinstance(bag.get('history'), list): raise ValueError()
                if any(not isinstance(r, dict) or not isinstance(r.get('signature'), str) or not isinstance(r.get('event'), dict) for r in bag['receipts'].values()): raise ValueError()
                if any(not isinstance(e, dict) or not isinstance(e.get('name'), str) or type(e.get('at')) is not int for e in bag['history']): raise ValueError()
                wallets = bag.get('wallets', {})
                if not isinstance(wallets, dict): raise ValueError()
                for cid, wallet in wallets.items():
                    if not isinstance(cid, str) or not re.fullmatch(r'o[0-9a-f]{32}', cid) or not isinstance(wallet, dict): raise ValueError()
                    if type(wallet.get('balanceCp')) is not int or not 0 <= wallet['balanceCp'] <= 10_000_000_000: raise ValueError()
                    if not isinstance(wallet.get('history'), list): raise ValueError()
                    if 'coins' in wallet:
                        from .wallet import UNITS
                        coins = wallet['coins']
                        if not isinstance(coins, dict) or set(coins) != set(UNITS): raise ValueError()
                        if any(type(v) is not int or v < 0 for v in coins.values()): raise ValueError()
                        if sum(coins[u]*UNITS[u] for u in UNITS) != wallet['balanceCp']: raise ValueError()
                validate_removed(bag)
                ids = set()
                for item in bag['items']:
                    item_definition(item, ValueError)
                    if not re.fullmatch(r'i[0-9a-f]{32}', str(item.get('id'))) or item['id'] in ids or type(item.get('quantity')) is not int or not 0 <= item['quantity'] <= 999: raise ValueError()
                    ids.add(item['id'])
            from .map_items import validate_map_items
            validate_map_items(data.get('mapItems', {}))
            for campaign, chars in data['characters'].items():
                if not isinstance(campaign, str) or not isinstance(chars, dict): raise ValueError()
                for oid, c in chars.items():
                    if c['id'] != oid or not re.fullmatch(r'o[0-9a-f]{32}', oid) or not re.fullmatch(r'p[0-9a-f]{32}', c['ownerPlayerId']) or type(c['revision']) is not int or c['revision'] < 1: raise ValueError()
                    if c['base'] != self.base(c['base']) or c['runtime'] != self.runtime(c['runtime'], c['base']): raise ValueError()
            return data
        except FileNotFoundError:
            return dict(version=1, revision=0, backpacks={}, characters={})
        except (ValueError, TypeError, KeyError, AttributeError):
            raise self.error('冒险资源存档损坏，请检查自动备份；原文件未覆盖', 503)

    def save(self, data):
        if self.database.active():
            try:
                self.database.save(data)
            except RevisionConflict as error:
                raise self.error(str(error), 409)
            return
        previous = self.ledger()
        if data == previous: return
        if previous['revision']:
            self.impl.atomic(self.ledger_path.parent / '资源自动备份' / ('%s.json' % previous['revision']), previous)
        data['revision'] = previous['revision'] + 1
        self.impl.atomic(self.ledger_path, data)

    def read(self, pid, campaign=None):
        with self.impl.LOCK:
            self.profiles.read(pid)
            data = self.working if self.working is not None else self.ledger()
            if pid not in data['backpacks']:
                bag = InventoryStore(self.profiles, self.impl).read(pid, campaign)
                # Only exact former built-in definitions qualify for this migration.
                for item in bag['items']:
                    preset = next((p for p in CATALOG if p.get('ruleId') and all(item.get(k) == p.get(k) for k in ('name', 'category', 'rarity', 'effect', 'consumable'))), None)
                    if preset: item.update(ruleId=preset['ruleId'], ruleVersion=1)
                data['backpacks'][pid] = bag
            if data.get('globalCharacters'):
                data['backpacks'][pid]['modular'] = True
            return data['backpacks'][pid]

    def commit(self, pid, campaign, old, value):
        previous = {i['id']: i for i in old['items']}
        for item in value['items']:
            former = previous.get(item['id'])
            if item != former:
                # Revival from an older archive must not reuse a past item version.
                item['resourceRevision'] = max(old['revision'], (former if former is not None else item).get('resourceRevision', 0)) + 1
        self.working['backpacks'][pid] = value
        self.save(self.working)

    @staticmethod
    def base(t):
        def num(key, default, low, high):
            v = t.get(key, default)
            return max(low, min(high, int(v))) if type(v) in (int, float) else default
        return dict(hpMax=num('hpMax', 10, 1, 99999), ac=num('ac', 10, 0, 99), level=num('level', 1, 1, 99))

    @staticmethod
    def runtime(t, base):
        def num(k, default):
            v = t.get(k, default)
            return max(0, min(99999, int(v))) if type(v) in (int, float) else default
        result = dict(hp=min(base['hpMax'], num('hp', base['hpMax'])), tempHp=num('tempHp', 0), tempHpMax=num('tempHpMax', num('tempHp', 0)))
        for key in ('conditions', 'spellSlots', 'resourceSlots'):
            if key in t:
                value = t[key]
                if not isinstance(value, (dict, list)) or len(json.dumps(value, allow_nan=False)) > 20000:
                    raise ValueError('角色持续状态或资源槽无效')
                result[key] = copy.deepcopy(value)
        return result

    @staticmethod
    def character_scope(data, campaign):
        return '@global' if data.get('globalCharacters') else campaign

    def reconcile(self, state, pid=None, accept_changes=False, from_host=False, ledger=None, persist=True):
        """Persist canonical runtime, overlay stale projections, lazily bind owned pieces.
        Called under the same RLock as the map API. No inventory enters public maps.
        """
        if not state or not state.get('campaignId'): return []
        with self.impl.LOCK:
            data = self.ledger() if ledger is None else ledger
            campaign = state['campaignId']
            chars = data['characters'].setdefault(self.character_scope(data, campaign), {})
            candidates = {}
            for _, t in tokens(state):
                oid = t.get('ownedPieceId'); owner = t.get('ownerPlayerId')
                if oid and owner:
                    candidates.setdefault(oid, []).append(t)
            if pid:
                for p in self.profiles.library(pid)['pieces']:
                    if p['ownedPieceId'] not in candidates:
                        candidates[p['ownedPieceId']] = [dict(p, **p.get('campaignStates', {}).get(campaign, {}))]
            for oid, group in candidates.items():
                t = group[0]; owner = t['ownerPlayerId']
                # A duplicate identity cannot choose one of several differing HP values.
                if len(group) != 1: continue
                if not self.profiles.owns(owner, oid): continue
                c = chars.get(oid)
                if not c:
                    b = self.base(t)
                    c = dict(id=oid, ownerPlayerId=owner, name=t.get('name', '角色'), revision=1, base=b, runtime=self.runtime(t, b))
                    chars[oid] = c
                elif c['ownerPlayerId'] != owner:
                    raise self.error('角色归属冲突，请检查棋子绑定', 409)
                elif accept_changes and t.get('characterRevision') == c['revision']:
                    t = dict(t)
                    private = next((p for p in state.get('_characterRuntime', []) if p.get('ownedPieceId') == oid and p.get('ownerPlayerId') == owner and p.get('characterRevision') == c['revision']), None) if from_host else None
                    if 'conditions' in t:
                        hidden = private.get('conditions', []) if private is not None else t.get('conditions', []) if from_host else c['runtime'].get('conditions', [])
                        t['conditions'] = [v for v in hidden if isinstance(v, dict) and v.get('visibility') == 'gm'] + [v for v in t['conditions'] if isinstance(v, dict) and v.get('visibility') != 'gm']
                    if private:
                        for field in ('spellSlots','resourceSlots'):
                            if field in private: t[field] = private[field]
                    b = self.base(dict(c['base'], **{k: t[k] for k in BASE_FIELDS if k in t}))
                    r = self.runtime(dict(c['runtime'], **{k: t[k] for k in RUNTIME_FIELDS if k in t}), b)
                    name = t.get('name', c['name'])
                    if b != c['base'] or r != c['runtime'] or name != c['name']:
                        c.update(base=b, runtime=r, name=name, revision=c['revision']+1)
            if persist: self.save(data)
            for c in chars.values(): project(state, c)
            return list(chars.values())

    def characters(self, pid, state, host=False):
        campaign = (state or {}).get('campaignId')
        data = self.ledger()
        chars = data['characters'].get(self.character_scope(data, campaign), {})
        visible = {t.get('ownedPieceId') for m, t in tokens(state) if m.get('playerAccessible') is True and not t.get('hiddenFromPlayers')}
        result = []
        for c in chars.values():
            owner = c['ownerPlayerId']
            if not self.profiles.owns(owner, c['id']): continue
            if owner == pid or c['id'] in visible or host:
                entry = copy.deepcopy(c)
                if not host and 'conditions' in entry['runtime']:
                    entry['runtime']['conditions'] = [v for v in entry['runtime']['conditions'] if isinstance(v, dict) and v.get('visibility') != 'gm']
                result.append(entry)
        return result

    def character(self, campaign, identity):
        data = self.ledger()
        return data['characters'].get(self.character_scope(data, campaign), {}).get(identity)

    def require_recipient(self, data, pid, identity):
        character = data['characters'].get('@global', {}).get(identity)
        if not identity:
            raise self.error('请选择接收物品的角色', 400)
        if not character or character['ownerPlayerId'] != pid or not self.profiles.owns(pid, identity):
            raise self.error('只能将物品交给该玩家名下的角色', 403)
        return character

    def apply(self, pid, campaign, command, host=False, state=None):
        with self.impl.LOCK:
            self.working = self.ledger()
            try:
                bag = self.read(pid, campaign)
                op = command.get('op')
                if op == 'wallet':
                    from .wallet import apply_wallet
                    return apply_wallet(self, pid, campaign, command, host, state, bag)
                if self.working.get('globalCharacters') and op == 'grant':
                    self.require_recipient(self.working, pid, command.get('characterId'))
                if self.working.get('globalCharacters') and op == 'restore':
                    removed = next((r for r in bag.get('removedItems', []) if r['id'] == command.get('removalId')), None)
                    if removed:
                        self.require_recipient(self.working, pid, removed['item'].get('ownerCharacterId'))
                if op not in ('heal', 'undo', 'assign', 'transfer'):
                    old_receipt = bag['receipts'].get(command.get('requestId')) or bag.get('legacyReceipts', {}).get(campaign, {}).get(command.get('requestId'))
                    if op == 'use' and not old_receipt:
                        item = next((i for i in bag['items'] if i['id'] == command.get('itemId')), {})
                        if self.working.get('globalCharacters') and not item.get('ownerCharacterId'):
                            raise self.error('这件旧物品尚未分配角色，请主持人先指定归属', 409)
                        if item.get('ruleId') in HEALING_RULES: raise self.error('请选择治疗目标后使用药水')
                        if item.get('category') == 'document': raise self.error('文书请使用阅读按钮')
                    return super().apply(pid, campaign, command, host)
                if not (op == 'assign' and self.working.get('globalCharacters')) and (not state or not campaign or campaign != state.get('campaignId')):
                    raise self.error('请连接当前战役后使用角色资源', 409)
                rid = command.get('requestId')
                if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', rid): raise self.error('操作编号无效')
                signed = {k: command.get(k) for k in ('op','itemId','revision','characterId','targetRevision','sourceCharacterId','eventId')}
                if op == 'transfer' and 'quantity' in command: signed['quantity'] = command['quantity']
                signed.update(host=host, campaign=campaign)
                sig = hashlib.sha256(json.dumps(signed, sort_keys=True).encode()).hexdigest()
                receipt = bag['receipts'].get(rid)
                if receipt:
                    if receipt['signature'] != sig: raise self.error('操作编号冲突', 409)
                    return self.public(bag), self.clean_event(receipt['event'])
                if type(command.get('revision')) is not int or command['revision'] != bag['revision']: raise self.error('背包已更新，请刷新后操作', 409)
                chars = self.working['characters'].get(self.character_scope(self.working, campaign), {})
                event = dict(id=rid, at=int(time.time()*1000), op=op, actor='主控' if host else '玩家', campaignId=campaign)
                if op == 'undo':
                    if not host: raise self.error('请主控核对后撤销治疗', 403)
                    original = next((e for e in bag['history'] if e['id'] == command.get('eventId') and e['op'] == 'heal'), None)
                    if not original or original.get('undone'): raise self.error('这次治疗已撤销或记录已过期', 409)
                    if original.get('campaignId') != campaign: raise self.error('只能撤销当前战役的治疗', 409)
                    c = chars.get(original['characterId'])
                    item = next((i for i in bag['items'] if i['id'] == original['itemId']), None)
                    if not c or not item or not self.profiles.owns(c['ownerPlayerId'], c['id']): raise self.error('角色或物品已变化', 409)
                    if c['revision'] != original['afterRevision'] or item != original['afterItem']:
                        raise self.error('治疗后的角色或物品已有新变化，不能直接撤销；请主控手动调整', 409)
                    c['runtime']['hp'] = original['beforeHp']; c['revision'] += 1
                    item['quantity'] += 1; item['resourceRevision'] = item.get('resourceRevision', 0)+1; original['undone'] = True
                    event.update(name=item['name'], itemId=item['id'], delta=1, remaining=item['quantity'], effect='已撤销治疗', characterId=c['id'])
                else:
                    item = next((i for i in bag['items'] if i['id'] == command.get('itemId')), None)
                    if not item: raise self.error('物品不存在', 404)
                    cid = command.get('characterId')
                    c = chars.get(cid)
                    if op == 'transfer':
                        if not c or not self.profiles.owns(c['ownerPlayerId'], cid):
                            raise self.error('接收角色不存在', 404)
                        if cid not in {entry['id'] for entry in self.characters(pid, state, host)}:
                            raise self.error('接收角色当前不可见', 403)
                        if item['quantity'] < 1: raise self.error('物品已用完或已转移', 409)
                        if item.get('ownerCharacterId') == cid: raise self.error('物品已在这个角色的背包里')
                        target_pid = c['ownerPlayerId']
                        amount = command.get('quantity', item['quantity'])
                        if type(amount) is not int or not 1 <= amount <= item['quantity']:
                            raise self.error('转移数量必须是整数，且不能超过持有数量')
                        if target_pid != pid or amount < item['quantity']:
                            target_bag = self.read(target_pid, campaign)
                            if len(target_bag['items']) >= 300: raise self.error('接收方背包物品种类已达 300 项，请先整理', 409)
                            moved = copy.deepcopy(item)
                            moved.update(id='i'+secrets.token_hex(16), ownerCharacterId=cid, quantity=amount,
                                         resourceRevision=item.get('resourceRevision', 0)+1,
                                         notes=item.get('notes','') if target_pid == pid else '',
                                         favorite=item.get('favorite',False) if target_pid == pid else False)
                            target_bag['items'].append(moved)
                            item['quantity'] -= amount
                            if target_pid != pid: target_bag['revision'] += 1
                            incoming = dict(event, op='receive', name=item['name'], itemId=moved['id'],
                                            delta=amount, remaining=amount, effect='收到转交物品')
                            target_bag['history'] = (target_bag['history'] + [incoming])[-80:]
                        else:
                            item['ownerCharacterId'] = cid
                        item['resourceRevision'] = item.get('resourceRevision', 0)+1
                        event.update(name=item['name'], itemId=item['id'], delta=-amount if target_pid != pid else 0,
                                     remaining=item['quantity'], characterId=cid, effect='已转交给'+c['name'])
                    elif op == 'assign':
                        if self.working.get('globalCharacters'):
                            self.require_recipient(self.working, pid, cid)
                        if cid and (not c or c['ownerPlayerId'] != pid or not self.profiles.owns(pid, cid)): raise self.error('只能分配给该玩家的角色', 403)
                        item['ownerCharacterId'] = cid or ''
                        item['resourceRevision'] = item.get('resourceRevision', 0)+1
                        event.update(name=item['name'], itemId=item['id'], delta=0, remaining=item['quantity'], effect='更新角色归属')
                    else:
                        if not c or not self.profiles.owns(c['ownerPlayerId'], c['id']): raise self.error('请选择有效的治疗目标', 404)
                        if type(command.get('targetRevision')) is not int or c['revision'] != command['targetRevision']: raise self.error('目标状态已变化，请核对生命值后重试', 409)
                        source_id = item.get('ownerCharacterId') or command.get('sourceCharacterId')
                        if self.working.get('globalCharacters') and not item.get('ownerCharacterId'):
                            raise self.error('这件旧药水尚未分配角色，请主持人先指定归属', 409)
                        source = chars.get(source_id)
                        if not source or source['ownerPlayerId'] != pid or not self.profiles.owns(pid, source_id): raise self.error('请选择使用这件物品的角色', 403)
                        locations = lambda oid: [(m,t) for m,t in tokens(state) if t.get('ownedPieceId') == oid and m.get('id')]
                        sources, targets = locations(source_id), locations(cid)
                        if len(sources) > 1 or len(targets) > 1: raise self.error('存在重复角色棋子，请主控检查', 409)
                        if not host:
                            if len(sources) != 1 or len(targets) != 1 or sources[0][0].get('id') != targets[0][0].get('id') or sources[0][0].get('playerAccessible') is not True or targets[0][1].get('hiddenFromPlayers') or sources[0][1].get('hiddenFromPlayers'):
                                raise self.error('玩家只能治疗同一张已开放地图上的可见角色；离场角色请主控处理', 403)
                        rule = HEALING_RULES.get(item.get('ruleId'))
                        if not rule or item.get('ruleVersion') != 1 or item['quantity'] < 1: raise self.error('药水无效或已用完', 409)
                        if c['runtime']['hp'] >= c['base']['hpMax']: raise self.error('目标生命值已满，未消耗药水', 409)
                        count, sides, bonus = rule
                        dice = [secrets.randbelow(sides)+1 for _ in range(count)]
                        total = sum(dice)+bonus; before = c['runtime']['hp']
                        c['runtime']['hp'] = min(c['base']['hpMax'], before+total); c['revision'] += 1
                        item['quantity'] -= 1
                        item['resourceRevision'] = item.get('resourceRevision', 0)+1
                        event.update(name=item['name'], itemId=item['id'], delta=-1, remaining=item['quantity'],
                                     characterId=cid, sourceCharacterId=source_id, targetName=c['name'], beforeHp=before,
                                     afterHp=c['runtime']['hp'], afterRevision=c['revision'], afterItem=copy.deepcopy(item),
                                     dice=dice, bonus=bonus, total=total, formula=f'{count}d{sides}+{bonus}',
                                     effect=f"{c['name']}：{before} → {c['runtime']['hp']} HP（实际恢复 {c['runtime']['hp']-before}）")
                bag['history'] = (bag['history'] + [event])[-80:]
                bag['receipts'][rid] = dict(signature=sig, event=copy.deepcopy(event))
                if len(bag['receipts']) > 512: bag['receipts'].pop(next(iter(bag['receipts'])))
                bag['revision'] += 1
                self.save(self.working)
                return self.public(bag), self.clean_event(event)
            finally:
                self.working = None

    @staticmethod
    def clean_event(event):
        return {k: copy.deepcopy(v) for k,v in event.items() if k != 'afterItem'}

    @staticmethod
    def public(bag):
        result = InventoryStore.public(bag)
        result['wallets'] = copy.deepcopy(bag.get('wallets', {}))
        from .wallet import coins_for
        for wallet in result['wallets'].values(): wallet['coins'] = coins_for(wallet)
        if bag.get('modular'):
            result['modular'] = True
            for item in result['items']:
                item['containerId'] = 'bag:' + item['ownerCharacterId'] if item.get('ownerCharacterId') else ''
        result['history'] = [ResourceStore.clean_event(e) for e in result['history']]
        return result
