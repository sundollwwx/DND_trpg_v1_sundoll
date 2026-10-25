"""Preserve both DM authorities before an explicit edit-baseline takeover."""
import copy
import json
import math
from pathlib import Path
import secrets
import time
from .save_storage import campaign_identity, campaign_text_hash, local_save_target
from .workspace import Workspace, atomic_json


class HostStateConflict(ValueError):
    status = 409


# These values have the same meaning in the full DM file and live projection.
# Absent tokens/maps mean hidden or omitted; they never authorize deletion.
TOKEN_FIELDS = ('x', 'y', 'rotation', 'hp', 'hpMax', 'tempHp', 'tempHpMax',
                'ac', 'level', 'spellSlots', 'resourceSlots')

# Only fields whose public representation retains its meaning may be overlaid.
# Map image previews, private notes and hidden initiative entries are not full
# DM documents and must never replace their formal counterparts wholesale.
RESUME_TOKEN_FIELDS = TOKEN_FIELDS + ('name', 'type', 'icon', 'iconImg', 'iconImgHd',
    'iconImgPath', 'portraitView', 'portraitVariants', 'portraitVariant',
    'initiativePortrait', 'portraitBeforeDowned', 'size', 'sizeCategory',
    'mountId', 'spellRange', 'publicNote', 'characterRevision', 'travelBasketStored')


def _index(rows, label):
    result = {}
    if not isinstance(rows, list): raise HostStateConflict(label + '格式不完整，未接续')
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] or row['id'] in result:
            raise HostStateConflict(label + '身份不完整或重复，未接续')
        result[row['id']] = row
    return result


def _overlay_token(original, incoming, visible=False):
    token = copy.deepcopy(original)
    for field in RESUME_TOKEN_FIELDS:
        if field in incoming: token[field] = copy.deepcopy(incoming[field])
    # An entry in an accessible map is actually visible. The private location
    # index and parked collection force visibility merely for serialization.
    if visible: token['hiddenFromPlayers'] = False
    if isinstance(incoming.get('conditions'), list):
        private = [copy.deepcopy(c) for c in token.get('conditions', [])
                   if isinstance(c, dict) and c.get('visibility') == 'gm']
        token['conditions'] = private + [copy.deepcopy(c) for c in incoming['conditions']
            if isinstance(c, dict) and c.get('visibility') != 'gm']
    return token


def _covered(map_obj, token):
    cover = map_obj.get('gridCover') or {}
    grid = float(map_obj.get('gridSize') or 50)
    if grid <= 0: raise HostStateConflict('房间网格尺寸无效，未接续')
    col = math.floor((float(token.get('x') or 0) - float(map_obj.get('gridOffsetX') or 0)) / grid)
    row = math.floor((float(token.get('y') or 0) - float(map_obj.get('gridOffsetY') or 0)) / grid)
    return bool(cover.get('all')) != bool((cover.get('cells') or {}).get(f'{col},{row}'))


def _resume_encounter(formal, live, visible_ids, removed_ids):
    if not isinstance(live, dict): return copy.deepcopy(formal)
    result = copy.deepcopy(formal) if isinstance(formal, dict) else {}
    originals = _index(result.get('entries', []), '正式先攻列表')
    incoming = _index(live.get('entries', []), '房间先攻列表')
    private = {key: entry for key, entry in originals.items()
               if entry.get('tokenId') and entry['tokenId'] not in visible_ids
               and entry['tokenId'] not in removed_ids}
    entries = list(copy.deepcopy(private).values())
    for key, entry in incoming.items():
        if key in private:
            entries = [row for row in entries if row['id'] != key]
        merged = copy.deepcopy(originals.get(key, entry))
        for field in ('kind', 'value', 'color', 'tokenId', 'order'):
            if field in entry: merged[field] = copy.deepcopy(entry[field])
        entries.append(merged)
    result['entries'] = sorted(entries, key=lambda row: float(row.get('order') or 0))
    same_turn = all(live.get(key) == result.get(key) for key in ('turnSerial', 'round'))
    private_current = result.get('currentEntryId') in private
    if live.get('currentEntryId') is None and private_current:
        if not same_turn:
            raise HostStateConflict('房间当前回合包含无法确认的隐藏先攻，请先保留草稿并核对')
    elif 'currentEntryId' in live:
        result['currentEntryId'] = live['currentEntryId']
    for field in ('playMode', 'round', 'secondsPerRound', 'turnSerial'):
        if field in live: result[field] = copy.deepcopy(live[field])
    old_path, new_path = result.get('turnPath') or {}, live.get('turnPath')
    if isinstance(new_path, dict):
        hidden_path = old_path.get('tokenId') and old_path['tokenId'] not in visible_ids and old_path['tokenId'] not in removed_ids
        if new_path.get('tokenId') or not (same_turn and hidden_path):
            result['turnPath'] = copy.deepcopy(new_path)
    for field in ('worldTime', 'weather'):
        if isinstance(live.get(field), dict):
            result.setdefault(field, {}).update(copy.deepcopy(live[field]))
    # Public lastEvent labels are deliberately redacted; keep the original
    # private wording only when it refers to the very same event.
    if 'lastEvent' in live and (live.get('lastEvent') or {}).get('at') != (result.get('lastEvent') or {}).get('at'):
        result['lastEvent'] = copy.deepcopy(live['lastEvent'])
    return result


def merge_resume_record(formal, live, actions=(), owners=None):
    """Hydrate a complete DM document without treating redaction as deletion.

    This function is pure. Its caller must bind both inputs to the same formal
    hash and freeze the live revision under the state/save locks.
    """
    record = copy.deepcopy(formal)
    state = record.get('state', record)
    if not isinstance(live, dict) or campaign_identity(formal) != live.get('campaignId'):
        raise HostStateConflict('房间正在运行另一战役，未接续')
    maps = _index(state.get('maps'), '正式地图')
    live_maps = _index(live.get('maps'), '房间地图')
    if set(live_maps) - set(maps):
        raise HostStateConflict('房间有尚未保存完整准备的新地图，请先保留原 DM 草稿')
    if set(maps) - set(live_maps):
        raise HostStateConflict('房间地图与正式存档不完整对应，请先保留原 DM 草稿并核对')
    presented = live.get('activeMapId')
    if presented is not None and presented not in maps:
        raise HostStateConflict('房间展示地图不在正式存档中，未接续')
    known, by_owned, placements = {}, {}, {}
    def remember(token, location):
        tid, oid = token.get('id'), token.get('ownedPieceId')
        if not isinstance(tid, str) or not tid or tid in known or (oid and oid in by_owned):
            raise HostStateConflict('正式棋子身份重复或不完整，未接续')
        known[tid] = token
        if oid: by_owned[oid] = token
        placements[tid] = location
    for mid, map_obj in maps.items():
        for token in _index(map_obj.get('tokens', []), '正式棋子').values(): remember(token, mid)
    parked = state.setdefault('parkedOwnedPieces', {})
    if not isinstance(parked, dict): raise HostStateConflict('正式收藏格式无效，未接续')
    for oid, token in parked.items():
        if not isinstance(token, dict) or token.get('ownedPieceId') != oid:
            raise HostStateConflict('正式收藏角色身份无效，未接续')
        remember(token, None)
    updates, owned_updates = {}, {}
    def add(token, location, visible=False, supplement=False):
        if not isinstance(token, dict) or not isinstance(token.get('id'), str):
            raise HostStateConflict('房间棋子身份不完整，未接续')
        tid, oid = token['id'], token.get('ownedPieceId')
        if supplement and tid in updates:
            previous = updates[tid]
            if previous[1] != location or previous[0].get('ownedPieceId') != oid:
                raise HostStateConflict('房间角色位置索引不一致，未接续')
            # The map copy is newest; the private index only supplies fields
            # omitted by visibility filtering (notably a hidden mount).
            updates[tid] = ({**copy.deepcopy(token), **previous[0]}, location, previous[2])
            return
        if tid in updates or (oid and oid in owned_updates):
            raise HostStateConflict('房间角色出现在多个位置，未接续')
        if location is not None and location not in maps:
            raise HostStateConflict('房间角色目标地图不存在，未接续')
        updates[tid] = (copy.deepcopy(token), location, visible)
        if oid: owned_updates[oid] = tid
    for mid, current in live_maps.items():
        accessible = current.get('playerAccessible') is True or mid == presented
        if current.get('mapData') and current['mapData'] != maps[mid].get('mapData'):
            # A URL may represent a replacement image or a resized preview;
            # without source provenance neither reverting nor replacing the
            # full-resolution preparation is justified.
            raise HostStateConflict('房间地图素材与正式原图无法确认对应，请先保留原 DM 草稿并核对')
        if not accessible and current.get('tokens'):
            raise HostStateConflict('未开放地图的公开棋子数据异常，未接续')
        for token in _index(current.get('tokens', []), '房间棋子').values(): add(token, mid, accessible)
        if accessible:
            for field in ('name', 'floorLabel', 'mapW', 'mapH', 'gridSize', 'gridLineWidth',
                          'gridOffsetX', 'gridOffsetY', 'gridCover', 'gridVisible', 'doodles'):
                if field in current and current[field] is not None: maps[mid][field] = copy.deepcopy(current[field])
        for field in ('chapterId', 'locationId'):
            if field in current: maps[mid][field] = copy.deepcopy(current[field])
        # Presented maps are serialized as accessible even when the DM did
        # not grant independent player access; retain that private choice.
        if mid != presented and 'playerAccessible' in current:
            maps[mid]['playerAccessible'] = current['playerAccessible'] is True
    for entry in live.get('_ownedPieceLocations', []):
        if not isinstance(entry, dict) or not (entry.get('token') or {}).get('ownedPieceId'):
            raise HostStateConflict('房间角色位置索引不完整，未接续')
        add(entry['token'], entry.get('mapId'), supplement=True)
    live_parked = live.get('parkedOwnedPieces', {})
    if not isinstance(live_parked, dict): raise HostStateConflict('房间收藏格式无效，未接续')
    for oid, token in live_parked.items():
        if not isinstance(token, dict) or token.get('ownedPieceId') != oid:
            raise HostStateConflict('房间收藏角色身份不一致，未接续')
        add(token, None)
    deleted = {action.get('tokenId') for action in actions if isinstance(action, dict)
               and action.get('op') == 'deletePlayerToken' and action.get('campaignId', live['campaignId']) == live['campaignId']}
    removed = set()
    def remove(original):
        tid, oid = original['id'], original.get('ownedPieceId')
        location = placements[tid]
        if location is None: parked.pop(oid, None)
        else: maps[location]['tokens'] = [t for t in maps[location].get('tokens', []) if t.get('id') != tid]
    for tid, (incoming, location, visible) in updates.items():
        oid = incoming.get('ownedPieceId')
        original = by_owned.get(oid) if oid else known.get(tid)
        authorized = oid and owners is not None and owners.get(oid) == incoming.get('ownerPlayerId')
        if oid and owners is not None and not authorized:
            # Unclaimed historical pieces may remain in private storage, but
            # cannot be deployed or edited through a resume. Preserve only an
            # unchanged, already parked formal original; grant no ownership.
            candidate = _overlay_token(original, incoming) if original else {}
            unchanged = original and all(candidate.get(key) == original.get(key)
                for key in set(candidate) | set(original) if key != 'travelBasketStored') and bool(candidate.get('travelBasketStored')) == bool(original.get('travelBasketStored'))
            if original and oid not in owners and location is None and placements[original['id']] is None and original.get('ownerPlayerId') == incoming.get('ownerPlayerId') and unchanged:
                continue
            raise HostStateConflict('房间角色归属无法通过当前账号确认，未接续')
        if original:
            if original.get('ownedPieceId') != oid:
                raise HostStateConflict('房间角色归属与正式存档不一致，未接续')
            transferred = oid and original.get('ownerPlayerId') != incoming.get('ownerPlayerId')
            if transferred and not authorized:
                raise HostStateConflict('房间角色归属无法通过当前账号确认，未接续')
            if tid != original['id']:
                raise HostStateConflict('房间角色棋子身份已变化，请先核对原 DM 草稿')
            merged = _overlay_token(original, incoming, visible)
            # Account characters are projected from the canonical resource
            # ledger into raw STATE (not the filtered public GET). Pair the
            # new revision with its full conditions, including GM deletions;
            # otherwise a later publish could revive an old private condition.
            if authorized and type(incoming.get('characterRevision')) is int and incoming['characterRevision'] > 0 and isinstance(incoming.get('conditions'), list):
                merged['conditions'] = copy.deepcopy(incoming['conditions'])
            if transferred:
                merged['ownerPlayerId'] = incoming['ownerPlayerId']
                if 'owner' in incoming: merged['owner'] = incoming['owner']
            remove(original)
        else:
            if not oid and not (tid.startswith('pt-') and incoming.get('playerCreated') is True and incoming.get('type') == 'pc'):
                raise HostStateConflict('房间有尚未保存完整准备的新棋子，请先保留原 DM 草稿')
            if oid and not authorized:
                raise HostStateConflict('房间新增角色无法通过当前账号确认，未接续')
            merged = copy.deepcopy(incoming)
        if location is None:
            if not oid: raise HostStateConflict('房间收藏缺少角色身份，未接续')
            if original and placements[original['id']] is not None:
                # A confirmed recall removes this actor from initiative. Its
                # missing public entry is a deletion, not hidden preparation.
                removed.add(original['id'])
            parked[oid] = merged
        else: maps[location].setdefault('tokens', []).append(merged)
    for tid, original in known.items():
        if tid in updates: continue
        # An explicit server-accepted deletion proves absence; redacted maps
        # and covered/hidden pieces never imply deletion on their own.
        if original.get('playerCreated') is True and tid in deleted:
            remove(original); removed.add(tid)
        elif placements[tid] is not None:
            current = live_maps.get(placements[tid], {})
            if (current.get('playerAccessible') is True or placements[tid] == presented) and not original.get('hiddenFromPlayers') and not _covered(current, original):
                raise HostStateConflict('公开棋子的缺失无法区分删除与隐藏，请先保留原 DM 草稿并核对')
    visible_ids = {t['id'] for t in live_maps.get(presented, {}).get('tokens', [])}
    if 'encounter' in live:
        state['encounter'] = _resume_encounter(state.get('encounter'), live['encounter'], visible_ids, removed)
    for field in ('sharedNotes', 'sharedResources', 'travelBasketOpen', 'travelBasketSkin', 'snap', 'showNames'):
        if field in live: state[field] = copy.deepcopy(live[field])
    for field in ('mapChapters', 'mapLocations'):
        if field not in live: continue
        originals = _index(state.get(field, []), '正式地图目录')
        for key, incoming in _index(live[field], '房间地图目录').items():
            if key not in originals: raise HostStateConflict('房间地图目录尚未保存完整名称，请先保留原 DM 草稿')
            for attribute in ('name', 'chapterId'):
                if attribute in incoming and incoming[attribute] is not None:
                    originals[key][attribute] = copy.deepcopy(incoming[attribute])
    if isinstance(live.get('journal'), dict):
        if int(live['journal'].get('revision') or 0) < int((state.get('journal') or {}).get('revision') or 0):
            raise HostStateConflict('房间日志版本落后于正式存档，请先核对')
        state['journal'] = copy.deepcopy(live['journal'])
    state['presentedMapId'] = presented
    return record


def resume_current(data, root, live, revision, session, actions=(), stream_seq=0, owners=None):
    """Read-only resume receipt. Caller holds save/profile/state locks + CAS."""
    rel = data.get('path')
    if (not isinstance(rel, str) or len(rel.split('/')) != 3 or rel.split('/')[0] != '战役'
            or rel.split('/')[-1] != '当前存档.json'):
        raise ValueError('接续需要当前战役的正式存档路径')
    path = Path(local_save_target(rel, 'read', root))
    if path.parent.joinpath('已删除.json').exists(): raise HostStateConflict('战役已归档，请先恢复')
    raw = path.read_bytes()
    formal = json.loads(raw)
    source_hash = campaign_text_hash(raw)
    if not isinstance(live, dict) or not campaign_identity(formal) or campaign_identity(formal) != data.get('campaignId'):
        raise HostStateConflict('正式存档与请求的战役身份不一致，未接续')
    if source_hash != data.get('expectedHash') or source_hash != live.get('_formalSourceHash'):
        raise HostStateConflict('房间进度与正式存档来源不一致，请先保留草稿并核对')
    record = merge_resume_record(formal, live, actions, owners)
    return dict(record=record, sourceHash=source_hash, stateRevision=revision, sessionId=session,
                streamSeq=stream_seq, mapPresentationId=live.get('mapPresentationId'))


def resume_ownership(root):
    """Take only central ownership facts, without library/asset side effects."""
    from .account_characters import context
    from .sqlite_read import open_readonly_database
    location = context(root)
    if not location: return None
    central, room = location
    db = open_readonly_database(Path(central) / '角色.sqlite3')
    try:
        owners = {row['id']: row['carrier'] for row in db.execute('''SELECT c.carrier,c.id FROM characters c
            JOIN carriers p ON p.id=c.carrier AND p.account_id IS c.account_id
            JOIN room_characters r ON r.character_id=c.id
            WHERE r.room=? AND p.enabled=1''', (room,))}
    finally: db.close()
    return owners


def recovery_record(formal, live, revision, session):
    record = copy.deepcopy(formal)
    state = record.get('state', record)
    if isinstance(live, dict) and campaign_identity(formal) == live.get('campaignId'):
        live_maps = {m.get('id'): m for m in live.get('maps', []) if isinstance(m, dict)}
        for map_obj in state.get('maps', []):
            current = live_maps.get(map_obj.get('id'))
            if not current: continue
            live_tokens = {t.get('id'): t for t in current.get('tokens', []) if isinstance(t, dict)}
            for token in map_obj.get('tokens', []):
                update = live_tokens.get(token.get('id'))
                if not update: continue
                for field in TOKEN_FIELDS:
                    if field in update: token[field] = copy.deepcopy(update[field])
                if isinstance(update.get('conditions'), list):
                    private = [copy.deepcopy(c) for c in token.get('conditions', [])
                               if isinstance(c, dict) and c.get('visibility') == 'gm']
                    token['conditions'] = private + [copy.deepcopy(c) for c in update['conditions']
                                                     if isinstance(c, dict) and c.get('visibility') != 'gm']
    record['_takeoverRecovery'] = dict(schemaVersion=1, capturedAt=int(time.time()*1000),
        stateRevision=revision, sessionId=session, formalRecord=copy.deepcopy(formal),
        rawLiveState=copy.deepcopy(live),
        notice='正式原件和实时状态均保留；仅合并同一棋子的数值、位置和公开状态，隐藏准备保留正式版。')
    record['savedAt'] = int(time.time()*1000)
    return record


def preserve_takeover(data, root, live, revision, session):
    """Caller holds save/state locks. No live mutation occurs until this fsyncs."""
    rel = data.get('path')
    if (not isinstance(rel, str) or len(rel.split('/')) != 3 or rel.split('/')[0] != '战役'
            or rel.split('/')[-1] != '当前存档.json'):
        raise ValueError('接管需要当前战役的正式存档路径')
    path = Path(local_save_target(rel, 'read', root))
    if path.parent.joinpath('已删除.json').exists():
        raise HostStateConflict('战役已归档，请先恢复后再接续编辑')
    raw = path.read_bytes()
    formal = json.loads(raw)
    identity = campaign_identity(formal)
    if not isinstance(formal.get('state', formal).get('maps'), list):
        raise ValueError('正式战役格式无效')
    if not isinstance(data.get('campaignId'), str) or not identity or identity != data['campaignId']:
        raise HostStateConflict('正式存档的战役身份已变化，请重新读取')
    source_hash = campaign_text_hash(raw)
    if not isinstance(data.get('expectedHash'), str) or source_hash != data['expectedHash']:
        raise HostStateConflict('正式存档已变化，请保留草稿并重新读取后再接续编辑')
    recovery_rel = '/'.join(rel.split('/')[:-1]) + '/自动备份/接管前恢复点-' + str(time.time_ns()) + '-' + secrets.token_hex(6) + '.json'
    destination = Path(local_save_target(recovery_rel, 'write', root))
    record = recovery_record(formal, live, revision, session)
    metadata = record['_takeoverRecovery']
    metadata['formalSourceHash'] = source_hash
    # Switching campaigns must also retain the private preparation belonging
    # to the previous live campaign, not just its restricted live projection.
    live_id = (live or {}).get('campaignId') if isinstance(live, dict) else None
    if live_id and live_id != identity:
        workspace = Workspace(root)
        previous = []
        for folder in workspace.campaigns.iterdir():
            old_path = workspace.checked(folder / '当前存档.json')
            if not old_path.is_file(): continue
            old_raw = old_path.read_bytes()
            old_record = json.loads(old_raw)
            if campaign_identity(old_record) == live_id:
                previous.append((old_record, campaign_text_hash(old_raw)))
        if len(previous) > 1:
            raise HostStateConflict('当前实时战役的正式身份重复，请先保留并核对各目录')
        if previous:
            metadata['liveFormalRecord'], metadata['liveFormalSourceHash'] = previous[0]
    atomic_json(destination, record)
    return dict(sourceHash=source_hash, recoveryPath=recovery_rel)
