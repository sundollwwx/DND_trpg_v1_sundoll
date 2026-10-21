"""Host-only recovery-point operations; HTTP authentication belongs to the caller.

List/read never open the module store. Copy creates a new campaign, commits only
campaign/selection documents, and projects current owned-character values without
writing character, backpack or map-loot records. Retrying a request reuses its copy.
"""
import copy
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

from .http_json import loads
from .module_store import ModuleStore, encode
from .paths import local_save_root
from .save_storage import SAVE_WRITE_LOCK, cache_campaign_summary, recover_campaign_projection
from .workspace import Workspace

MAX_RECOVERY_BYTES = 128 * 1024 * 1024
NOTICE = '恢复为独立战役副本，原存档与恢复点保留。个人角色使用当前数值，背包和钱包不回退；副本不复制原战役的地图掉落，世界时钟暂停。'
HASH = re.compile(r'[0-9a-f]{64}')
REQUEST = re.compile(r'[A-Za-z0-9_-]{16,96}')


class CampaignRecoveryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _parts(identity):
    if not isinstance(identity, str) or len(identity) > 768 or '\\' in identity or '\x00' in identity:
        raise CampaignRecoveryError('恢复点路径无效')
    parts = identity.split('/')
    if (len(parts) != 4 or parts[0] != '战役' or parts[2] != '自动备份'
            or any(not p or p in ('.', '..') for p in parts)
            or not parts[-1].lower().endswith('.json')):
        raise CampaignRecoveryError('只能读取当前工作区战役的自动备份 JSON')
    return parts


def _read_bytes(workspace, identity):
    """Reject symlinks in every component, including replacements during open."""
    parts = _parts(identity)
    path = workspace.checked(workspace.campaigns.joinpath(*parts[1:]))
    descriptors = []
    try:
        if hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY'):
            descriptor = os.open(workspace.checked(workspace.campaigns), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.append(descriptor)
            for part in parts[1:-1]:
                descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                descriptors.append(descriptor)
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        else:
            descriptor = os.open(workspace.checked(path), os.O_RDONLY | getattr(os, 'O_BINARY', 0))
        descriptors.append(descriptor)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise CampaignRecoveryError('恢复点不是普通文件')
        if before.st_size > MAX_RECOVERY_BYTES:
            raise CampaignRecoveryError('恢复点文件过大', 413)
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, MAX_RECOVERY_BYTES + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RECOVERY_BYTES:
                raise CampaignRecoveryError('恢复点文件过大', 413)
            chunks.append(chunk)
        after = os.fstat(descriptor)
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise CampaignRecoveryError('恢复点正在变化，请刷新列表后重试', 409)
        workspace.checked(path)
        return b''.join(chunks), before
    except FileNotFoundError as error:
        raise CampaignRecoveryError('恢复点已不存在，请刷新列表', 404) from error
    except OSError as error:
        raise CampaignRecoveryError('恢复点无法安全读取：' + str(error), 400) from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _identifier(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 192 or re.search(r'[\x00-\x1f\x7f]', value):
        raise CampaignRecoveryError(label + '身份无效，原文件未修改')
    return value


def _document(text):
    try:
        # A historical BOM is accepted without changing the download text/hash.
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise CampaignRecoveryError('JSON 包含重复字段：' + key)
                result[key] = value
            return result
        import json
        parsed = json.loads(text.lstrip('\ufeff'), object_pairs_hook=unique)
        # Reuse the HTTP finite-number policy, including overflow such as 1e999.
        loads(text.lstrip('\ufeff'))
        if not isinstance(parsed, dict):
            raise CampaignRecoveryError('恢复点必须是战役对象')
        state = parsed.get('state', parsed)
        if not isinstance(state, dict):
            raise CampaignRecoveryError('恢复点缺少战役状态')
        state = copy.deepcopy(state)
        outer, inner = parsed.get('campaignId'), state.get('campaignId')
        if outer and inner and outer != inner:
            raise CampaignRecoveryError('恢复点的战役身份不一致')
        origin = outer or inner
        if origin is not None:
            _identifier(origin, '战役')
        for candidate in (parsed.get('campaignName'), state.get('campaignName')):
            if candidate is not None and not isinstance(candidate, str):
                raise CampaignRecoveryError('战役名称格式无效')
        warnings = []
        if '_takeoverRecovery' in parsed or '_takeoverRecovery' in state:
            warnings.append('接管恢复点包含受限联机投影证据；副本采用完整战役正文，不自动应用 rawLiveState。原件证据保留在此恢复点。')
        if not isinstance(state.get('maps'), list):
            if 'maps' in state:
                raise CampaignRecoveryError('恢复点的地图列表格式无效')
            if 'mapData' not in state and not isinstance(state.get('tokens'), list):
                raise CampaignRecoveryError('恢复点缺少地图列表')
            # Preserve the old single-map fields instead of dropping its contents.
            legacy = {k: copy.deepcopy(state[k]) for k in ('mapData', 'mapW', 'mapH', 'gridSize', 'tokens', 'cells', 'doodles', 'cam') if k in state}
            legacy.update(id='legacy-recovery-map', name=state.get('mapName') or '旧版地图')
            state['maps'] = [legacy]
            state['activeMapId'] = state['presentedMapId'] = legacy['id']
            warnings.append('旧版单地图已转为地图列表，原文件保留。')
        if not origin:
            warnings.append('旧恢复点没有战役身份；副本会创建新身份。')
        maps, token_ids, owned_ids = set(), set(), set()
        all_tokens = []
        for map_value in state['maps']:
            if not isinstance(map_value, dict):
                raise CampaignRecoveryError('地图记录无效')
            identity = _identifier(map_value.get('id'), '地图')
            if identity in maps:
                raise CampaignRecoveryError('恢复点包含重复地图身份')
            maps.add(identity)
            tokens = map_value.get('tokens', [])
            if not isinstance(tokens, list):
                raise CampaignRecoveryError('地图棋子列表无效')
            all_tokens.extend(tokens)
        parked = state.get('parkedOwnedPieces', {})
        travel = state.get('travelBasketTokens', [])
        if not isinstance(parked, dict) or not isinstance(travel, list):
            raise CampaignRecoveryError('旅行篮子或收回角色记录无效')
        for key, token in parked.items():
            if not isinstance(token, dict) or token.get('ownedPieceId') != key:
                raise CampaignRecoveryError('收回角色身份与记录键不一致')
        if any(not isinstance(t, dict) or t.get('ownedPieceId') for t in travel):
            raise CampaignRecoveryError('普通旅行篮子包含个人角色或无效棋子')
        all_tokens.extend(parked.values())
        all_tokens.extend(travel)
        for token in all_tokens:
            if not isinstance(token, dict):
                raise CampaignRecoveryError('棋子记录无效')
            identity = _identifier(token.get('id'), '棋子')
            if identity in token_ids:
                raise CampaignRecoveryError('恢复点包含重复棋子身份')
            token_ids.add(identity)
            if 'ownedPieceId' in token and token['ownedPieceId'] is not None:
                oid, owner = token['ownedPieceId'], token.get('ownerPlayerId')
                if not isinstance(oid, str) or not re.fullmatch(r'o[0-9a-f]{32}', oid) or not isinstance(owner, str) or not re.fullmatch(r'p[0-9a-f]{32}', owner):
                    raise CampaignRecoveryError('个人角色或玩家身份无效')
                if oid in owned_ids:
                    raise CampaignRecoveryError('恢复点包含重复个人角色身份')
                owned_ids.add(oid)
        if state.get('_ownedPieceLocations'):
            raise CampaignRecoveryError('这是联机投影，可能缺少隐藏地图内容；请使用完整战役恢复点')
        return parsed, state, origin, warnings
    except (ValueError, TypeError, RecursionError) as error:
        if isinstance(error, CampaignRecoveryError):
            raise
        raise CampaignRecoveryError('恢复点 JSON 损坏或结构无效：' + str(error)) from error


def _record(workspace, identity):
    record = dict(id=identity, path=identity, campaignId=None, campaignName=_parts(identity)[1],
                  createdAt=0, reason='恢复点', mapCount=None, sha256=None, valid=False, warnings=[])
    stem = Path(identity).stem
    reason = next((label for label in ('接管前恢复点', '读取前恢复点', '角色保存冲突', '身份保存冲突', '保存冲突')
                   if stem == label or stem.startswith(label + '-')), None)
    record['reason'] = reason or ('自动备份' if stem.isdigit() else re.sub(r'-\d+$', '', stem))
    try:
        raw, info = _read_bytes(workspace, identity)
        record.update(sha256=hashlib.sha256(raw).hexdigest(), createdAt=info.st_mtime_ns // 1000000)
        text = raw.decode('utf-8')
        parsed, state, origin, warnings = _document(text)
        record.update(campaignId=origin, campaignName=parsed.get('campaignName') or state.get('campaignName') or record['campaignName'],
                      mapCount=len(state['maps']), valid=True, warnings=warnings)
        return record, text, state
    except (CampaignRecoveryError, UnicodeError, ValueError, OSError) as error:
        record['warnings'].append(str(error))
        return record, None, None


def list_recovery_points(root=None):
    workspace = Workspace(root or local_save_root())
    records, warnings = [], []
    with SAVE_WRITE_LOCK:
        if not workspace.campaigns.exists():
            return dict(ok=True, records=[], warnings=[], notice=NOTICE)
        try:
            folders = sorted(workspace.checked(workspace.campaigns).iterdir())
        except (OSError, ValueError) as error:
            raise CampaignRecoveryError('战役恢复目录不可读：' + str(error), 503) from error
        for folder in folders:
            try:
                workspace.checked(folder)
                if not folder.is_dir():
                    continue
                backups = workspace.checked(folder / '自动备份')
                if not backups.exists():
                    continue
                for path in sorted(backups.iterdir()):
                    if path.suffix.lower() != '.json':
                        continue
                    identity = '战役/' + folder.name + '/自动备份/' + path.name
                    records.append(_record(workspace, identity)[0])
            except (OSError, ValueError) as error:
                warnings.append(dict(path='战役/' + folder.name + '/自动备份', warning=str(error)))
    records.sort(key=lambda row: (row['createdAt'], row['id']), reverse=True)
    return dict(ok=True, records=records, warnings=warnings, notice=NOTICE)


def read_recovery_point(identity, expected_hash, root=None):
    workspace = Workspace(root or local_save_root())
    if not isinstance(expected_hash, str) or not HASH.fullmatch(expected_hash):
        raise CampaignRecoveryError('请提供列表中恢复点的 expectedHash')
    with SAVE_WRITE_LOCK:
        raw, _ = _read_bytes(workspace, identity)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_hash:
            raise CampaignRecoveryError('恢复点已变化，请刷新列表后重新核对', 409)
        try:
            text = raw.decode('utf-8')
        except UnicodeError as error:
            raise CampaignRecoveryError('恢复点不是 UTF-8 JSON，原文件保留') from error
        record, _, _ = _record(workspace, identity)
        if record['sha256'] != digest:
            raise CampaignRecoveryError('恢复点已变化，请刷新列表', 409)
        return dict(ok=True, recoveryId=identity, sha256=digest, text=text, record=record, notice=NOTICE)


def copy_recovery_point(identity, expected_hash, request_id, root=None, name=None):
    root = root or local_save_root()
    workspace = Workspace(root)
    if not isinstance(request_id, str) or not REQUEST.fullmatch(request_id):
        raise CampaignRecoveryError('恢复副本需要有效 requestId，重试应沿用原编号')
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name.strip()) > 120 or re.search(r'[\x00-\x1f\x7f]', name)):
        raise CampaignRecoveryError('恢复副本名称无效')
    from . import player_profiles, paths
    from .resources import projection
    with SAVE_WRITE_LOCK, player_profiles.LOCK:
        source = read_recovery_point(identity, expected_hash, root)
        parsed, state, origin, warnings = _document(source['text'])
        signature = hashlib.sha256(encode(dict(recoveryId=identity, sha256=expected_hash, requestId=request_id, name=name)).encode()).hexdigest()
        # Bind request identity to this workspace, never to a shared application root.
        cid = 'recovery-' + hashlib.sha256((str(workspace.root.resolve()) + ':' + request_id).encode()).hexdigest()[:32]
        rel = '战役/' + cid + '/当前存档.json'
        target = workspace.checked(workspace.campaigns / cid / '当前存档.json')
        store = ModuleStore(root)
        recover_campaign_projection(root, rel)
        db = store.connect()
        try:
            existing = store.document(db, 'campaign-commit', rel)
            if existing:
                metadata = existing['data']['campaign'].get('recovery', {})
                if metadata.get('signature') != signature:
                    raise CampaignRecoveryError('恢复请求编号已用于另一份内容，请核对原操作', 409)
                if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != existing['data']['hash'] or (target.parent / '已删除.json').exists():
                    raise CampaignRecoveryError('恢复副本已变化或已归档，请打开原副本核对；未重复创建', 409)
                return dict(existing['data']['result'], ok=True, reused=True)
            if target.parent.exists():
                raise CampaignRecoveryError('恢复副本目录已存在，未覆盖任何文件', 409)
            title = name.strip() if name else (str(parsed.get('campaignName') or state.get('campaignName') or _parts(identity)[1])[:108] + ' · 恢复副本')
            journal = state.get('journal')
            if isinstance(journal, dict):
                if journal.get('campaignId') and origin and journal['campaignId'] != origin:
                    raise CampaignRecoveryError('日志属于另一战役，请先核对恢复点')
                journal['campaignId'] = cid
            state.update(campaignId=cid, campaignName=title)
            for key in ('_streamSeq', '_stateRevision', '_sessionId', '_roomCode', '_formalSourceHash', '_serverNow', '_characterRuntime', '_takeoverRecovery', 'packageContextRevision'):
                state.pop(key, None)
            if isinstance(state.get('encounter'), dict) and isinstance(state['encounter'].get('worldTime'), dict):
                state['encounter']['worldTime']['runningSince'] = None
            document = dict(format='sangduoer-campaign', schemaVersion=4, campaignId=cid, campaignName=title,
                            savedAt=int(time.time() * 1000), state=state,
                            recovery=dict(sourceRecoveryId=identity, sourceHash=expected_hash, sourceCampaignId=origin, signature=signature))
            # Own-role identities remain intact; current values are read under the
            # same SQLite transaction as publication. No resource records are written.
            db.execute('BEGIN IMMEDIATE')
            owned = [t for m in state['maps'] for t in m.get('tokens', []) if t.get('ownedPieceId')]
            owned += list(state.get('parkedOwnedPieces', {}).values())
            for token in owned:
                oid, owner = token['ownedPieceId'], token['ownerPlayerId']
                character = store.document(db, 'runtime-character', oid)
                library = store.document(db, 'player-library', owner)
                try:
                    profile = player_profiles.Store(root, paths.APP_ROOT, paths.CACHE_ROOT / '联机资源').read(owner)
                except player_profiles.ProfileError as error:
                    raise CampaignRecoveryError('个人角色所属档案不可用：' + str(error) + '；原文件保留', 409) from error
                if (not profile.get('enabled') or not character or character['data'].get('ownerPlayerId') != owner
                        or not library or not any(p.get('ownedPieceId') == oid and p.get('ownerPlayerId') == owner for p in library['data'].get('pieces', []))):
                    raise CampaignRecoveryError('个人角色缺失、归属变化或尚未迁移：' + oid + '；原文件保留', 409)
                token.update(projection(character['data']))
            compact = store.externalize(document, 'campaign:' + cid, db)
            text = encode(compact)
            result = dict(campaignId=cid, campaignName=title, path=rel, hash=hashlib.sha256(text.encode()).hexdigest(),
                          sourceRecoveryId=identity, sourceHash=expected_hash, warnings=warnings, notice=NOTICE)
            selection = store.document(db, 'content-selection', origin) if origin else None
            if selection:
                policy = copy.deepcopy(selection['data'])
                policy['receipts'] = {}
                store.write_document(db, 'content-selection', cid, 'campaign:' + cid, policy, 0)
            store.write_document(db, 'campaign-commit', rel, '', dict(signature=signature, hash=result['hash'],
                                 result=result, campaign=compact, pending=True), 0)
            store.write_document(db, 'campaign-pending', rel, '', dict(campaign=compact, pending=True), 0)
            db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()
        recover_campaign_projection(root, rel)
        try:
            cache_campaign_summary(str(target), root, compact)
        except (OSError, ValueError, sqlite3.Error):
            # The copy is committed; rebuilding a list cannot change that result.
            result['warnings'].append('副本已保存，但列表摘要尚未更新；刷新或核对同一请求可继续。')
        return dict(result, ok=True, reused=False)


def perform_campaign_recovery_operation(data, root=None):
    """Dispatch after host authorization/protocol/workspace generation checks.

    recovery-list -> {records, warnings, notice}
    recovery-read -> recoveryId + expectedHash -> original UTF-8 text + record
    recovery-copy -> same + requestId [+ name] -> new campaignId/path/hash
    CampaignRecoveryError.status should be preserved by the HTTP error boundary.
    """
    if not isinstance(data, dict):
        raise CampaignRecoveryError('恢复请求必须是对象')
    op = data.get('op')
    if op == 'recovery-list':
        return list_recovery_points(root)
    if op == 'recovery-read':
        return read_recovery_point(data.get('recoveryId'), data.get('expectedHash'), root)
    if op == 'recovery-copy':
        return copy_recovery_point(data.get('recoveryId'), data.get('expectedHash'), data.get('requestId'), root, data.get('name'))
    raise CampaignRecoveryError('未知恢复操作')
