"""Coordinate an authorized backpack request under the caller's resource lock.

HTTP authentication, response writing and room event sequence allocation remain
at the transport boundary. Resource reads, package checks and receipt recovery
share this path so they preserve the same ownership and retry semantics.
"""
from .content_packages import ContentPackages
from .item_library import ItemLibrary
from .resources import ResourceStore


def prepare_backpack_request(store, implementation, pid, command, state, host,
                             character_updates, refresh_portraits):
    campaign = command.get('campaignId', (state or {}).get('campaignId'))
    if campaign is not None and (not isinstance(campaign, str) or len(campaign) > 128):
        raise implementation.ProfileError('请求格式无效', 400)
    inventory = ResourceStore(store, implementation)
    mutation = command.get('op') != 'get'
    current_campaign = (state or {}).get('campaignId')
    campaign_changed = ((not host and (campaign or '') != (current_campaign or ''))
                        or (host and mutation and current_campaign and campaign != current_campaign))
    policy = ContentPackages(store.save_root)
    context = policy.context(campaign)
    package_changed = (mutation and 'packageContextRevision' in command
                       and command['packageContextRevision'] != context['revision'])
    recovery = inventory.recover_receipt(pid, campaign, command, host,
        current_campaign=current_campaign or '') if mutation and (campaign_changed or package_changed) else None
    if recovery is None and campaign_changed:
        raise implementation.ProfileError('战役已切换，请重新打开背包', 409)
    if recovery is None and package_changed:
        raise implementation.ProfileError('战役启用的内容包已变化，请重新打开背包', 409)
    before, backpack_changed, ledger = [], False, None
    if recovery is not None:
        backpack, event = recovery
        campaign = current_campaign or ''
        context = policy.context(campaign)
        result = dict(backpack=backpack, event=event, recovered=True)
    else:
        before = character_updates(state, public=True)
        if not mutation:
            ledger = inventory.backpack_ledger(pid, state, host)
        inventory.reconcile(state, pid, ledger=ledger)
        refresh_portraits(state)
        if not mutation:
            backpack = inventory.view(pid, campaign, host=host, ledger=ledger)
            catalog = [t for t in ItemLibrary(store, implementation).read()['templates']
                       if not t['archived'] and policy.is_available(policy.origin_for_template(t), campaign)] if host else []
            result = dict(backpack=backpack, profile=store.read(pid), catalog=catalog)
        else:
            backpack_revision = inventory.read(pid, campaign)['revision']
            backpack, event = inventory.apply(pid, campaign, command, host, state=state)
            result = dict(backpack=backpack, event=inventory.clean_event(event))
            backpack_changed = backpack['revision'] != backpack_revision
            inventory.reconcile(state, pid)
            refresh_portraits(state)
    result.update(campaignId=campaign, packageContextRevision=context['revision'],
                  walletSupported=True, walletCoinsSupported=True,
                  transferQuantitySupported=True, trashSupported=True)
    if recovery is None:
        result['characters'] = inventory.characters(pid, state, host, ledger=ledger)
        result['recipients'] = [dict(id=c['id'], name=c['name'], ownerPlayerId=c['ownerPlayerId'],
            playerName=store.read(c['ownerPlayerId'])['name']) for c in result['characters']]
    if not host:
        result['backpack']['removedItems'] = [r for r in result['backpack'].get('removedItems', []) if r['op'] == 'discard']
    updates = [] if recovery is not None else [action for action in character_updates(state, public=True) if action not in before]
    return result, backpack_changed, updates
