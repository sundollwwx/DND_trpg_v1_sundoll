"""Map loot and backpacks share the resource ledger and one atomic commit."""
import copy
import hashlib
import json
import math
import re
import secrets
from .resources import ResourceStore
from .inventory import InventoryStore


def public_check(check):
    if not check: return None
    return {k:copy.deepcopy(v) for k,v in check.items() if not k.startswith('_')}


def validate_map_items(data):
    from .inventory import item_definition
    if not isinstance(data, dict): raise ValueError()
    for campaign, maps in data.items():
        if not isinstance(campaign, str) or not isinstance(maps, dict): raise ValueError()
        for map_id, group in maps.items():
            if not isinstance(map_id, str) or type(group['revision']) is not int or group['revision'] < 0: raise ValueError()
            if not isinstance(group['markers'], list) or not isinstance(group['receipts'], dict): raise ValueError()
            if any(not isinstance(k, str) or not isinstance(v, str) for k, v in group['receipts'].items()): raise ValueError()
            seen = set()
            for marker in group['markers']:
                if not isinstance(marker['id'], str) or marker['id'] in seen: raise ValueError()
                seen.add(marker['id'])
                if type(marker.get('locked', False)) is not bool or marker.get('lockType','normal') not in ('normal','arcane') or type(marker.get('lockDC',15)) is not int or not 1<=marker.get('lockDC',15)<=40 or not isinstance(marker.get('lockAttempts',{}),dict): raise ValueError()
                if type(marker.get('revision', 0)) is not int or marker.get('revision', 0) < 0: raise ValueError()
                if marker['kind'] not in ('item', 'container') or type(marker['visible']) is not bool or not isinstance(marker['name'], str): raise ValueError()
                for key in ('x', 'y', 'size'):
                    if type(marker[key]) not in (int, float) or not math.isfinite(marker[key]) or marker[key] < 0: raise ValueError()
                if not .25 <= marker['size'] <= 4 or not isinstance(marker['items'], list): raise ValueError()
                if 'containerItem' in marker:
                    item_definition(marker['containerItem'], ValueError)
                    if marker['kind'] != 'container' or marker['containerItem']['category'] != 'container': raise ValueError()
                ids = set()
                for item in marker['items']:
                    item_definition(item, ValueError)
                    if not isinstance(item['id'], str) or item['id'] in ids or type(item['quantity']) is not int or not 1 <= item['quantity'] <= 999: raise ValueError()
                    ids.add(item['id'])


class StagedGrant(ResourceStore):
    def save(self, data):
        pass  # MapItems saves this staged ledger exactly once, with the map debit.

    def grant_definition(self, command):
        return copy.deepcopy(self.definition)


class MapItems:
    def __init__(self, profiles, implementation):
        self.profiles, self.impl = profiles, implementation
        self.error = implementation.ProfileError
        self.resources = ResourceStore(profiles, implementation)

    def apply(self, command, state, host=False, player=None):
        with self.impl.LOCK:
            campaign, map_id = command.get('campaignId'), command.get('mapId')
            # Hosts also prepare maps before starting a player broadcast. Never use
            # client-supplied metadata to authorize a player request.
            if host and 'hostMap' in command:
                m = command['hostMap']
                if not isinstance(campaign, str) or not 1 <= len(campaign) <= 128 or not isinstance(map_id, str) or not 1 <= len(map_id) <= 128:
                    raise self.error('战役或地图编号无效')
                if not isinstance(m, dict) or m.get('id') != map_id: raise self.error('地图资料无效')
                for key in ('mapW', 'mapH'):
                    v = m.get(key)
                    if type(v) not in (int, float) or not math.isfinite(v) or not 1 <= v <= 10000000: raise self.error('地图尺寸无效')
                state = dict(campaignId=campaign, maps=[m])
            if not isinstance(campaign, str) or not campaign or campaign != (state or {}).get('campaignId'):
                raise self.error('战役已切换，请刷新地图', 409)
            m = next((m for m in state.get('maps', []) if m.get('id') == map_id), None)
            if not m: raise self.error('地图不存在', 404)
            op = command.get('op')
            if not host and (op not in ('get', 'move', 'take', 'pickLock', 'inspireLock', 'finishLock') or not (m.get('playerAccessible') is True or map_id == state.get('activeMapId'))):
                raise self.error('不能访问这张地图的物品', 403)
            if not host and op != 'get':
                if not player or not player.get('playerId'): raise self.error('玩家会话已失效', 401)
                if op in ('take', 'pickLock', 'inspireLock', 'finishLock') and not player.get('persistent'): raise self.error('请使用玩家档案登录后进行检定或领取物品', 403)
                allowed = {'op','campaignId','mapId','markerId','markerRevision','requestId','revision','sessionToken'} | ({'x','y'} if op == 'move' else {'modifier','mode','guidance','inspirationDie'} if op == 'pickLock' else {'checkId','inspirationDie'} if op=='inspireLock' else {'checkId'} if op=='finishLock' else {'itemId','quantity','characterId'})
                if set(command) - allowed: raise self.error('玩家只能移动或领取已展示物品', 403)
            data = self.resources.ledger()
            group = data.setdefault('mapItems', {}).setdefault(campaign, {}).setdefault(map_id, dict(revision=0, markers=[], receipts={}))
            def result():
                markers = copy.deepcopy(group['markers'])
                for v in markers:
                    v.setdefault('revision', 0)
                    v.setdefault('locked', False)
                    v.setdefault('lockType', 'normal')
                    attempts=v.pop('lockAttempts', {})
                    if not host:
                        v['lockAttempt']=public_check(attempts.get((player or {}).get('playerId')))
                        if v['locked']: v['items']=[]
                        v.pop('lockDC', None)
                if not host:
                    markers = [v for v in markers if v['visible']]
                    for v in markers:
                        for item in v['items'] + ([v['containerItem']] if v.get('containerItem') else []):
                            item.pop('sourceTemplateId', None)
                            item.pop('sourceTemplateVersion', None)
                response=dict(revision=group['revision'] if host else 0, markers=markers)
                if data.get('globalCharacters'):
                    eligible = {p['playerId']: p for p in self.profiles.players() if p.get('enabled') is not False} if host else {}
                    response['recipients'] = [dict(id=c['id'], name=c['name'], playerId=c['ownerPlayerId'],
                        playerName=eligible.get(c['ownerPlayerId'], {}).get('name', ''), hpMax=c['base']['hpMax'], ac=c['base']['ac'])
                        for c in data['characters'].get('@global', {}).values()
                        if (c['ownerPlayerId'] in eligible if host else c['ownerPlayerId'] == (player or {}).get('playerId'))
                        and self.profiles.owns(c['ownerPlayerId'], c['id'])]
                if command.get('op') in ('pickLock','inspireLock'):
                    receipt=(player or {}).get('playerId','')+':'+str(command.get('requestId',''))
                    response['check']=public_check(group.get('lockChecks',{}).get(receipt))
                return response
            if op == 'get': return result()
            if op not in ('place', 'container', 'add', 'update', 'remove', 'grant', 'unpack', 'move', 'take', 'deleteContent', 'pickLock', 'inspireLock', 'finishLock'):
                raise self.error('物品操作无效')
            rid = command.get('requestId')
            if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', rid): raise self.error('操作编号无效')
            signed = {k:v for k,v in command.items() if k != 'sessionToken'}
            if not host: signed['_playerId'] = player['playerId']
            signature = hashlib.sha256(json.dumps(signed, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            receipt_id = rid if host else player['playerId']+':'+rid
            previous = group['receipts'].get(receipt_id)
            if previous:
                if previous != signature: raise self.error('操作编号重复，请刷新', 409)
                return result()
            if host and op != 'move' and (type(command.get('revision')) is not int or command['revision'] != group['revision']):
                raise self.error('地图物品已更新，请刷新后核对', 409)
            marker = next((v for v in group['markers'] if v['id'] == command.get('markerId')), None)
            if op not in ('place', 'container') and marker is None: raise self.error('物品已移除，请刷新', 409)
            if not host:
                if not marker or not marker['visible']: raise self.error('物品不可用，请刷新地图', 403)
            if not host or op == 'move':
                if type(command.get('markerRevision')) is not int or command['markerRevision'] != marker.get('revision', 0):
                    raise self.error('物品已更新，请核对最新状态后重试', 409)
            if op in ('pickLock','inspireLock','finishLock') and host: raise self.error('请从玩家端尝试开锁')
            if op in ('place', 'container'):
                if len(group['markers']) >= 300: raise self.error('每张地图最多放置 300 个物品标记')
                marker = dict(id='loot-'+secrets.token_hex(16), kind='container' if op == 'container' else 'item',
                              name='宝箱', x=0, y=0, size=.75 if op == 'container' else .5, visible=False, items=[])
                group['markers'].append(marker)
            if op in ('place', 'container', 'update', 'move'):
                for key in ('x', 'y', 'size'):
                    if key not in command: continue
                    v = command[key]
                    maximum = 4 if key == 'size' else max(1, float(m.get('mapW' if key == 'x' else 'mapH') or 10000))
                    if type(v) not in (int, float) or not math.isfinite(v) or not (0.25 if key == 'size' else 0) <= v <= maximum:
                        raise self.error('位置或尺寸无效')
                    marker[key] = v
                if 'name' in command:
                    name = command['name']
                    if not isinstance(name, str) or not name.strip() or len(name) > 60: raise self.error('名称应为 1–60 字')
                    marker['name'] = name.strip()
                if 'visible' in command:
                    if type(command['visible']) is not bool: raise self.error('展示状态无效')
                    marker['visible'] = command['visible']
            if op=='update' and ('locked' in command or 'lockType' in command or 'lockDC' in command or 'resetLockAttempts' in command):
                if marker['kind']!='container': raise self.error('只有容器可以设置锁')
                if 'lockType' in command:
                    lock_type=command['lockType']
                    if lock_type not in ('normal','arcane'): raise self.error('宝箱锁类型无效')
                    if lock_type!=marker.get('lockType','normal'): marker['lockAttempts']={}
                    marker['lockType']=lock_type
                if 'lockDC' in command:
                    dc=command['lockDC']
                    if type(dc) is not int or not 1<=dc<=40: raise self.error('开锁难度应为 1–40')
                    marker['lockDC']=dc
                if 'locked' in command:
                    if type(command['locked']) is not bool: raise self.error('锁状态无效')
                    if command['locked']!=marker.get('locked',False): marker['lockAttempts']={}
                    marker['locked']=command['locked']
                if command.get('resetLockAttempts') is True: marker['lockAttempts']={}
            if op=='pickLock':
                if marker['kind']!='container' or not marker.get('locked'): raise self.error('宝箱已经解锁，请打开查看',409)
                if marker.get('lockType')=='arcane': raise self.error('秘法锁不能用普通巧手检定解开；请由主控裁定密码或解除魔法',403)
                pid=player['playerId']
                attempts=marker.setdefault('lockAttempts',{})
                if pid in attempts: raise self.error('你已尝试过这把锁，请等待主控重置机会',409)
                modifier=command.get('modifier')
                if type(modifier) is not int or not -10<=modifier<=30: raise self.error('巧手加值应为 -10 至 30')
                mode=command.get('mode',0);guidance=command.get('guidance',False);inspiration=command.get('inspirationDie',0)
                if type(mode) is not int or mode not in (-1,0,1): raise self.error('检定方式无效')
                if type(guidance) is not bool: raise self.error('神导术选项无效')
                if type(inspiration) is not int or inspiration not in (0,6,8,10,12): raise self.error('诗人激励骰无效')
                dice=[secrets.randbelow(20)+1 for _ in range(2 if mode else 1)]
                pick=(dice.index(max(dice)) if mode==1 else dice.index(min(dice))) if mode else 0
                natural=dice[pick];critical='success' if natural==20 else 'fail' if natural==1 else None
                guidance_roll=secrets.randbelow(4)+1 if guidance and not critical else 0
                total=natural+modifier+guidance_roll;dc=marker.get('lockDC',15)
                check=dict(id=rid,eventId=rid,stage='initial',natural=natural,dice=dice,pick=pick,mode=mode,modifier=modifier,
                    guidance=guidance,guidanceRoll=guidance_roll,inspirationDie=inspiration,inspirationRoll=0,
                    inspirationUsed=False,finished=False,total=total,critical=critical,
                    success=natural==20 or (natural!=1 and total>=dc),_dc=dc)
                attempts[pid]=copy.deepcopy(check)
                group.setdefault('lockChecks',{})[receipt_id]=copy.deepcopy(check)
                if check['success']: marker['locked']=False
            if op in ('inspireLock','finishLock'):
                if marker['kind']!='container' or not marker.get('locked'): raise self.error('宝箱已经解锁，请打开查看',409)
                check=marker.get('lockAttempts',{}).get(player['playerId'])
                if not check or check.get('id')!=command.get('checkId'): raise self.error('检定已重置，请重新打开宝箱',409)
                if check.get('success') or check.get('critical')=='fail' or check.get('finished') or check.get('inspirationUsed'):
                    raise self.error('这次检定不能再追加诗人激励',409)
                if op=='inspireLock':
                    die=command.get('inspirationDie',check.get('inspirationDie',0))
                    if type(die) is not int or die not in (6,8,10,12): raise self.error('请选择已有的诗人激励骰')
                    if check.get('inspirationDie') and die!=check['inspirationDie']: raise self.error('不能更换已声明的激励骰')
                    check['inspirationDie']=die
                check['finished']=True
                if op=='inspireLock':
                    roll=secrets.randbelow(check['inspirationDie'])+1
                    check.update(inspirationRoll=roll,inspirationUsed=True,total=check['total']+roll,eventId=rid,stage='inspiration')
                    check['success']=check['total']>=check.get('_dc',marker.get('lockDC',15))
                    group.setdefault('lockChecks',{})[receipt_id]=copy.deepcopy(check)
                    if check['success']: marker['locked']=False
            if op=='take' and marker.get('locked'): raise self.error('宝箱尚未解锁',403)
            if op in ('place', 'add'):
                if op == 'add' and marker['kind'] != 'container': raise self.error('只能向容器添加物品')
                if len(marker['items']) >= 100: raise self.error('容器最多装 100 种物品')
                quantity = command.get('quantity')
                if type(quantity) is not int or not 1 <= quantity <= 999: raise self.error('数量应为 1–999')
                definition = self.resources.grant_definition(command)
                if definition['category'] == 'container':
                    if op == 'add': raise self.error('请将容器单独放到地图上，再向里面装入物品')
                    if quantity != 1: raise self.error('宝箱请一次放置一个，每个宝箱分别保存内容')
                    marker.update(kind='container', size=.75, containerItem=copy.deepcopy(definition))
                else:
                    marker['items'].append(dict(definition, id='content-'+secrets.token_hex(16), quantity=quantity))
                if op == 'place': marker['name'] = definition['name']
            if op == 'unpack':
                if marker['kind'] != 'container': raise self.error('只能从容器中取出物品')
                item = next((v for v in marker['items'] if v['id'] == command.get('itemId')), None)
                if not item: raise self.error('物品已取走，请刷新', 409)
                if len(group['markers']) >= 300: raise self.error('地图物品标记已满，请先整理')
                item = copy.deepcopy(item)
                group['markers'].append(dict(id='loot-'+secrets.token_hex(16), kind='item', name=item['name'],
                    x=min(float(m.get('mapW') or 10000), marker['x']+float(m.get('gridSize') or 50)), y=marker['y'],
                    size=.5, visible=marker['visible'], items=[item]))
                marker['items'] = [v for v in marker['items'] if v['id'] != item['id']]
            if op == 'deleteContent':
                if marker['kind'] != 'container': raise self.error('请在宝箱中选择要删除的物品')
                item = next((v for v in marker['items'] if v['id'] == command.get('itemId')), None)
                if not item: raise self.error('物品已被取走，请刷新', 409)
                marker['items'].remove(item)
            if op == 'remove': group['markers'].remove(marker)
            if op in ('grant', 'take'):
                item = next((v for v in marker['items'] if v['id'] == command.get('itemId')), None)
                quantity = command.get('quantity')
                if not item or type(quantity) is not int or not 1 <= quantity <= item['quantity']:
                    raise self.error('剩余数量不足，请刷新', 409)
                pid = command.get('playerId') if host else player['playerId']
                profile = self.profiles.read(pid)
                if profile.get('enabled') is False: raise self.error('玩家档案已停用', 403)
                staged = StagedGrant(self.profiles, self.impl)
                staged.working = data
                staged.definition = {k: copy.deepcopy(v) for k, v in item.items() if k not in ('id', 'quantity')}
                bag = staged.read(pid, campaign)
                if data.get('globalCharacters'):
                    self.resources.require_recipient(data, pid, command.get('characterId'))
                InventoryStore.apply(staged, pid, campaign, dict(op='grant', item=staged.definition, quantity=quantity,
                    **({'characterId':command['characterId']} if command.get('characterId') else {}),
                    revision=bag['revision'], requestId=rid if host else 'take-'+hashlib.sha256(receipt_id.encode()).hexdigest()), True)
                item['quantity'] -= quantity
                if not item['quantity']: marker['items'].remove(item)
                if not marker['items'] and marker['kind'] == 'item': group['markers'].remove(marker)
            if marker in group['markers']: marker['revision'] = marker.get('revision', 0) + 1
            group['revision'] += 1
            group['receipts'][receipt_id] = signature
            if len(group['receipts']) > 512:
                expired=next(iter(group['receipts']));group['receipts'].pop(expired)
                group.get('lockChecks',{}).pop(expired,None)
            self.resources.save(data)
            return result()
