"""One-time ownership migration; no item is discarded or duplicated."""
import copy


def migrate_unassigned(resources, choices=None, dry_run=False):
    choices = choices or {}
    data = resources.ledger()
    if not data.get('globalCharacters'):
        raise ValueError('请先完成角色模块迁移')
    before = copy.deepcopy(data)
    characters = data['characters']['@global']
    changes = []
    for pid, bag in data['backpacks'].items():
        own = [c for c in characters.values() if c['ownerPlayerId'] == pid and resources.profiles.owns(pid, c['id'])]
        changed = False
        for item in bag['items'] + [r['item'] for r in bag.get('removedItems', [])]:
            if item.get('ownerCharacterId'):
                continue
            oid = choices.get(item['id']) or (own[0]['id'] if len(own) == 1 else None)
            if not oid:
                raise ValueError('请指定旧物品的接收角色：' + item['name'] + ' / ' + item['id'])
            character = resources.require_recipient(data, pid, oid)
            changes.append(dict(playerId=pid, itemId=item['id'], name=item['name'],
                                quantity=item['quantity'], characterId=oid, characterName=character['name']))
            item['ownerCharacterId'] = oid
            item['resourceRevision'] = item.get('resourceRevision', 0) + 1
            changed = True
        if changed:
            bag['revision'] += 1
    if not dry_run and data != before:
        resources.save(data)
    return changes
