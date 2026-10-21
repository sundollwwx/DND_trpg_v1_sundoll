"""Preserve both DM authorities before an explicit edit-baseline takeover."""
import copy
import json
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
