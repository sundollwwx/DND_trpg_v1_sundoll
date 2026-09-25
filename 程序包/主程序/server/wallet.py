"""Character wallets live in the same atomic ledger as their owner's inventory."""
import copy
import hashlib
import json
import re
import time

UNITS = {'cp': 1, 'sp': 10, 'ep': 50, 'gp': 100, 'pp': 1000}
LIMIT = 10_000_000_000


ORDER = ('pp', 'gp', 'sp', 'cp')


def change(cp, units=ORDER):
    coins = dict.fromkeys(UNITS, 0)
    for unit in units:
        coins[unit], cp = divmod(cp, UNITS[unit])
    return coins


def spend(coins, amount, unit, error):
    result = dict(coins)
    if unit == 'ep':
        if result['ep'] < amount: raise error('银金币不足；只有明确选择银金币时才会使用银金币', 409)
        result['ep'] -= amount
        return result
    if result[unit] >= amount:
        result[unit] -= amount
        return result
    cost = amount * UNITS[unit]
    if sum(result[u]*UNITS[u] for u in ORDER) < cost:
        raise error('普通币种余额不足；银金币不参与自动换算', 409)
    # Spend the requested denomination first, then smaller coins, then break larger ones.
    remaining = cost
    for u in [unit] + [u for u in reversed(ORDER) if u != unit]:
        take = min(result[u], (remaining + UNITS[u]-1)//UNITS[u])
        result[u] -= take
        remaining -= take * UNITS[u]
        if remaining <= 0:
            for v, count in change(-remaining).items(): result[v] += count
            break
    return result


def coins_for(wallet):
    if 'coins' in wallet: return dict(wallet['coins'])
    # Recover denominations from complete legacy receipts when possible.
    history = wallet.get('history', [])
    if sum(r['deltaCp'] for r in history) == wallet['balanceCp']:
        coins = dict.fromkeys(UNITS, 0)
        try:
            for r in history:
                match = re.search(r'(\d+) (CP|SP|EP|GP|PP)', r.get('effect',''))
                if not match: raise ValueError()
                amount, unit = int(match[1]), match[2].lower()
                if amount*UNITS[unit] != abs(r['deltaCp']): raise ValueError()
                if r['deltaCp'] > 0: coins[unit] += amount
                else: coins = spend(coins, amount, unit, lambda *args: ValueError())
            return coins
        except (ValueError, KeyError): pass
    # Older truncated receipts only retain total value; never invent electrum.
    return change(wallet['balanceCp'], ('gp','sp','cp'))


def apply_wallet(store, pid, campaign, command, host, state, bag):
    error = store.error
    rid = command.get('requestId')
    if not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,96}', rid):
        raise error('操作编号无效')
    fields = ('op', 'revision', 'characterId', 'recipientId', 'action', 'amount', 'currency', 'note')
    signed = {k: command.get(k) for k in fields}
    signed.update(host=host, campaign=campaign)
    signature = hashlib.sha256(json.dumps(signed, sort_keys=True).encode()).hexdigest()
    receipt = bag['receipts'].get(rid)
    if receipt:
        if receipt['signature'] != signature: raise error('操作编号冲突', 409)
        return store.public(bag), store.clean_event(receipt['event'])
    if type(command.get('revision')) is not int or command['revision'] != bag['revision']:
        raise error('钱包已更新，请核对余额后重试', 409)
    chars = store.working['characters'].get(store.character_scope(store.working, campaign), {})
    cid = command.get('characterId')
    source = chars.get(cid)
    if not source or source['ownerPlayerId'] != pid or not store.profiles.owns(pid, cid):
        raise error('只能使用这个玩家所属角色的钱包', 403)
    action, amount, unit = command.get('action'), command.get('amount'), command.get('currency')
    if action not in ('credit', 'debit', 'transfer'): raise error('钱包操作无效')
    if action == 'credit' and not host: raise error('只有主控可以发放货币', 403)
    if type(amount) is not int or not 1 <= amount <= LIMIT or unit not in UNITS:
        raise error('请输入有效的正整数金额与币种')
    cp = amount * UNITS[unit]
    if cp > LIMIT: raise error('金额超过上限')
    note = command.get('note', '')
    if not isinstance(note, str) or len(note) > 200: raise error('备注最多 200 字')
    wallets = bag.setdefault('wallets', {})
    wallet = wallets.setdefault(cid, {'balanceCp': 0, 'history': []})
    wallet['coins'] = coins_for(wallet)
    delta = cp if action == 'credit' else -cp
    if wallet['balanceCp'] + delta < 0: raise error('钱包余额不足', 409)
    if wallet['balanceCp'] + delta > LIMIT: raise error('钱包余额超过上限')
    updated_coins = dict(wallet['coins'])
    if action == 'credit': updated_coins[unit] += amount
    else: updated_coins = spend(updated_coins, amount, unit, error)
    target = None
    if action == 'transfer':
        target = chars.get(command.get('recipientId'))
        if not target or target['id'] == cid or not store.profiles.owns(target['ownerPlayerId'], target['id']):
            raise error('请选择其他有效角色的钱包')
        visible = {c['id'] for c in store.characters(pid, state, host)}
        if target['id'] not in visible: raise error('接收角色当前不可见', 403)
        target_bag = store.read(target['ownerPlayerId'], campaign)
        target_wallet = target_bag.setdefault('wallets', {}).setdefault(target['id'], {'balanceCp': 0, 'history': []})
        target_wallet['coins'] = coins_for(target_wallet)
        if target_wallet['balanceCp'] + cp > LIMIT: raise error('接收方钱包余额超过上限')
    now = int(time.time()*1000)
    label = {'credit':'发放', 'debit':'支付', 'transfer':'转账'}[action]
    effect = label + ' ' + str(amount) + ' ' + unit.upper() + (' → '+target['name'] if target else '')
    record = dict(id=rid, at=now, deltaCp=delta, amount=amount, currency=unit, action=action, note=note,
                  effect=effect, actor='主控' if host else source['name'], balanceCp=wallet['balanceCp']+delta)
    wallet['coins'] = updated_coins
    wallet['balanceCp'] += delta
    wallet['history'] = (wallet['history'] + [record])[-80:]
    if target:
        target_wallet['coins'][unit] += amount
        target_wallet['balanceCp'] += cp
        incoming = dict(record, deltaCp=cp, action='receive', effect='来自 '+source['name'], balanceCp=target_wallet['balanceCp'])
        target_wallet['history'] = (target_wallet['history'] + [incoming])[-80:]
        if target_bag is not bag: target_bag['revision'] += 1
    event = dict(id=rid, at=now, op='wallet', name=source['name']+'的钱包', actor=record['actor'],
                 characterId=cid, effect=effect, delta=0, remaining=0)
    bag['receipts'][rid] = dict(signature=signature, event=copy.deepcopy(event))
    if len(bag['receipts']) > 512: bag['receipts'].pop(next(iter(bag['receipts'])))
    bag['revision'] += 1
    store.save(store.working)
    return store.public(bag), event
