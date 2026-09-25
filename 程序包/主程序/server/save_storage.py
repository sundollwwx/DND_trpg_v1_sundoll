"""Campaign filesystem operations, CAS writes, summaries and process locking."""
from pathlib import Path
import os, json, time, threading, base64, hashlib, secrets, shutil, sqlite3
from server.paths import local_save_root
from server.workspace import Workspace, read_catalog, write_catalog
from server.module_store import ModuleStore, encode
LOCAL_SAVE_ROOT = local_save_root()
MAX_CAMPAIGN_COVER_BYTES = 8 * 1024 * 1024
CAMPAIGN_COVER_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp')

def ensure_local_save_structure(root=None):
    root = os.path.abspath(root or LOCAL_SAVE_ROOT)
    os.makedirs(Workspace(root).campaigns, exist_ok=True)
    os.makedirs(os.path.join(root, '棋子库'), exist_ok=True)
    return root


def local_save_target(rel_path, operation, root=None):
    raw = str(rel_path or '').replace('\\', '/')
    if not raw or len(raw) > 768 or raw.startswith('/') or '\x00' in raw:
        raise ValueError('invalid save path')
    parts = raw.split('/')
    if any(not part or part in ('.', '..') for part in parts):
        raise ValueError('invalid save path')
    top = parts[0]
    if top == '存档索引.json':
        allowed = len(parts) == 1 and operation in ('read', 'write')
    elif top == '棋子库':
        allowed = parts == ['棋子库', '棋子库.json'] and operation in ('read', 'write')
    elif top == '战役':
        if operation == 'list':
            allowed = True
        elif operation in ('read', 'write'):
            allowed = len(parts) >= 3 and parts[-1].lower().endswith('.json')
        elif operation in ('read-binary', 'write-binary'):
            allowed = (
                len(parts) == 3
                and parts[-1].startswith('封面.')
                and parts[-1].lower().endswith(CAMPAIGN_COVER_EXTENSIONS)
            )
        elif operation == 'delete':
            allowed = len(parts) >= 2
        else:
            allowed = False
    else:
        allowed = False
    if not allowed:
        raise ValueError('save path is outside the allowed structure')

    save_root = os.path.abspath(root or LOCAL_SAVE_ROOT)
    workspace = Workspace(save_root)
    target = str(workspace.save_path(parts))
    if workspace.active: return target
    if os.path.commonpath([save_root, target]) != save_root:
        raise ValueError('save path escapes root')
    cursor = save_root
    for part in parts:
        cursor = os.path.join(cursor, part)
        if os.path.lexists(cursor) and os.path.islink(cursor):
            raise ValueError('symbolic links are not allowed in saves')
    return target


SAVE_WRITE_LOCK = threading.RLock()
CAMPAIGN_SUMMARIES = {}

class SaveConflict(ValueError):
    pass


def campaign_summary(data, folder, rel):
    state = data.get('state', data)
    if not isinstance(state.get('maps'), list):
        raise ValueError('invalid campaign')
    return {'id': data.get('campaignId') or state.get('campaignId') or folder,
            'name': data.get('campaignName') or state.get('campaignName') or folder,
            'savedAt': data.get('savedAt', 0), '_folderName': folder, '_path': rel,
            'state': {'activeMapId': state.get('activeMapId'),
                      'maps': [{'id': m.get('id'), 'name': m.get('name'),
                                'tokenCount': len(m.get('tokens') or [])} for m in state['maps']]},
            'hasLegacyLibrary': bool(state.get('library'))}


def cache_campaign_summary(path, root, data):
    stat = os.stat(path)
    signature = [stat.st_mtime_ns, stat.st_size, stat.st_ino]
    rel = '战役/' + Path(path).relative_to(Workspace(root).campaigns).as_posix()
    summary = campaign_summary(data, os.path.basename(os.path.dirname(path)), rel)
    store = ModuleStore(root)
    with store.transaction() as db:
        old = store.document(db, 'campaign-summary', rel)
        store.write_document(db, 'campaign-summary', rel, '',
                             {'signature': signature, 'summary': summary}, old['revision'] if old else 0)
    CAMPAIGN_SUMMARIES[path] = (tuple(signature), summary)
    return summary

class ProjectServerLock:
    """OS-held lock: released even after process termination; portable to Windows."""
    def __init__(self, root):
        os.makedirs(root, exist_ok=True)
        self.handle = open(os.path.join(root, '.server.lock'), 'a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                self.handle.seek(0)
                self.handle.write(b'0')
                self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError('这个存档目录已有服务器运行，请先关闭旧服务器，再重新启动。')

    def close(self):
        self.handle.close()


def campaign_catalog(root):
    recover_campaign_projection(root)
    records = []
    directory = str(Workspace(root).campaigns)
    os.makedirs(directory, exist_ok=True)
    for folder in os.scandir(directory):
        if not folder.is_dir(follow_symlinks=False):
            continue
        rel = '战役/' + folder.name + '/当前存档.json'
        if os.path.exists(os.path.join(folder.path, '已删除.json')):
            continue
        path = local_save_target(rel, 'read', root)
        if not os.path.isfile(path):
            continue
        stat = os.stat(path)
        signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
        cached = CAMPAIGN_SUMMARIES.get(path)
        if not cached or cached[0] != signature:
            try:
                store = ModuleStore(root)
                db = store.connect()
                try:
                    persisted = store.document(db, 'campaign-summary', rel)
                finally:
                    db.close()
                if persisted and persisted['data'].get('signature') == list(signature):
                    CAMPAIGN_SUMMARIES[path] = (signature, persisted['data']['summary'])
                    records.append(persisted['data']['summary'])
                    continue
                with open(path, encoding='utf-8') as handle:
                    data = json.load(handle)
                cache_campaign_summary(path, root, data)
            except (ValueError, TypeError, AttributeError, OSError):
                continue
        records.append(CAMPAIGN_SUMMARIES[path][1])
    live = {local_save_target(r['_path'], 'read', root) for r in records}
    for key in list(CAMPAIGN_SUMMARIES):
        if key.startswith(directory + os.sep) and key not in live:
            del CAMPAIGN_SUMMARIES[key]
    return records


def publish_campaign_projection(path, text):
    temporary = path + '.tmp-' + secrets.token_hex(6)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(temporary, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.remove(temporary)


def recover_campaign_projection(root, rel=None):
    """Replay a committed projection after interruption; character + campaign commit together."""
    store = ModuleStore(root)
    if not store.database.exists(): return
    with SAVE_WRITE_LOCK, store.transaction() as db:
        rows = db.execute("SELECT id,payload,revision FROM documents WHERE kind='campaign-pending'" +
                          (' AND id=?' if rel else ''), (rel,) if rel else ()).fetchall()
        for row in rows:
            commit = json.loads(row['payload'])
            if not commit.get('pending'): continue
            path = local_save_target(row['id'], 'write', root)
            publish_campaign_projection(path, encode(commit['campaign']))
            commit['pending'] = False
            db.execute("DELETE FROM documents WHERE kind='campaign-pending' AND id=?", (row['id'],))


def write_campaign_checked(data, root):
    path = local_save_target(data.get('path'), 'write', root)
    if os.path.basename(path) != '当前存档.json':
        raise ValueError('checked writes require current campaign file')
    text = data.get('text')
    if not isinstance(text, str) or 'expectedHash' not in data:
        raise ValueError('missing save content or loaded version')
    parsed = json.loads(text)
    if not isinstance(parsed.get('state', {}).get('maps'), list):
        raise ValueError('invalid campaign')
    from . import player_profiles
    with SAVE_WRITE_LOCK, player_profiles.LOCK:
        recover_campaign_projection(root, data['path'])
        if os.path.exists(os.path.join(os.path.dirname(path), '已删除.json')):
            raise SaveConflict('该战役已删除，不能继续保存；请读取其他战役')
        old = None
        if os.path.isfile(path):
            with open(path, 'rb') as handle:
                old = handle.read()
        actual = hashlib.sha256(old.decode('utf-8').replace('\r\n', '\n').encode('utf-8')).hexdigest() if old is not None else None
        store = ModuleStore(root)
        signature = hashlib.sha256((str(data['expectedHash']) + ':' + text).encode()).hexdigest()
        db = store.connect()
        try: previous_commit = store.document(db, 'campaign-commit', data['path'])
        finally: db.close()
        if previous_commit and previous_commit['data']['signature'] == signature and actual == previous_commit['data']['hash']:
            return dict(previous_commit['data']['result'], ok=True)
        if actual != data['expectedHash']:
            recovery = os.path.join(os.path.dirname(path), '自动备份', '保存冲突-' + str(time.time_ns()) + '.json')
            os.makedirs(os.path.dirname(recovery), exist_ok=True)
            with open(recovery, 'x', encoding='utf-8') as handle:
                handle.write(text)
            raise SaveConflict('正式存档已被另一窗口更新，已保留本次进度到自动备份/保存冲突文件；请重新读取后再保存')
        compact = ModuleStore(root).externalize(parsed, 'campaign:' + str(parsed.get('campaignId') or parsed['state'].get('campaignId') or os.path.dirname(path)))
        from .resource_database import ResourceDatabase
        database = ResourceDatabase(root)
        characters = []
        if database.active():
            from . import paths
            from .resources import ResourceStore
            profiles = player_profiles.Store(root, paths.APP_ROOT, paths.CACHE_ROOT / '联机资源')
            resources = ResourceStore(profiles, player_profiles)
            ledger = resources.ledger()
            from .resources import tokens, projection
            for _, token in tokens(compact['state']):
                current = ledger['characters']['@global'].get(token.get('ownedPieceId'))
                if not current or current['ownerPlayerId'] != token.get('ownerPlayerId'): continue
                if isinstance(token.get('characterRevision'), int) and token['characterRevision'] != current['revision']:
                    fields = projection(current)
                    if any(token[k] != v for k,v in fields.items() if k != 'characterRevision' and k in token):
                        recovery = os.path.join(os.path.dirname(path), '自动备份', '角色保存冲突-' + str(time.time_ns()) + '.json')
                        publish_campaign_projection(recovery, text)
                        raise SaveConflict('角色已在另一操作中更新，本次进度已保留到自动备份/角色保存冲突；请重新读取后核对')
            resources.reconcile(compact['state'], accept_changes=True, from_host=True, ledger=ledger, persist=False)
            from .resources import tokens, projection
            ids = {t.get('ownedPieceId') for _,t in tokens(compact['state'])}
            characters = [dict(characterId=c['id'], ownerPlayerId=c['ownerPlayerId'], patch=projection(c))
                          for c in ledger['characters']['@global'].values() if c['id'] in ids]
            text = encode(compact)
            result = {'hash':hashlib.sha256(text.encode('utf-8')).hexdigest(),
                      'mapAssets':{m['id']:m.get('mapData') for m in compact['state']['maps'] if m.get('id')},
                      'characterUpdates':characters}
            with store.transaction() as db:
                database.save_into(db, ledger)
                old_commit = store.document(db, 'campaign-commit', data['path'])
                store.write_document(db, 'campaign-commit', data['path'], '',
                    dict(signature=signature, hash=result['hash'], result=result, campaign=compact, pending=True),
                    old_commit['revision'] if old_commit else 0)
                store.write_document(db, 'campaign-pending', data['path'], '', dict(campaign=compact, pending=True), 0)
            # SQLite is authoritative. File publication is recoverable and repeatable.
            recover_campaign_projection(root, data['path'])
        else:
            if compact != parsed: text = encode(compact)
            publish_campaign_projection(path, text)
        # A summary is rebuildable. Failure to cache it cannot undo a committed save.
        try:
            cache_campaign_summary(path, root, compact)
        except (OSError, ValueError, sqlite3.Error):
            CAMPAIGN_SUMMARIES.pop(path, None)
        return {'ok': True, 'hash': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                'mapAssets': {m['id']: m.get('mapData') for m in compact['state']['maps'] if m.get('id')},
                'characterUpdates': characters}


def perform_local_save_operation(data, root=None):
    if not isinstance(data, dict):
        raise ValueError('request must be an object')
    operation = str(data.get('op') or '')
    save_root = ensure_local_save_structure(root)
    if operation == 'status':
        from .resource_database import ResourceDatabase
        modular = ResourceDatabase(save_root).active()
        # Scope browser recovery by data root; no filesystem path leaves the host.
        from .workspace_backup import epoch
        storage_id = hashlib.sha256((os.path.realpath(save_root)+epoch(save_root)).encode()).hexdigest()[:24]
        return {'ok': True, 'mode': 'local-project', 'name': '存档',
                'modular': modular, 'storageId': storage_id, 'workspace': Workspace(save_root).summary()}

    if operation == 'campaign-catalog':
        with SAVE_WRITE_LOCK:
            return {'ok': True, 'records': campaign_catalog(save_root)}
    if operation == 'write-campaign':
        return write_campaign_checked(data, save_root)
    if operation == 'read-campaign':
        path = local_save_target(data.get('path'), 'read', save_root)
        if not str(data.get('path', '')).startswith('战役/'):
            raise ValueError('invalid campaign path')
        with SAVE_WRITE_LOCK:
            recover_campaign_projection(save_root, data['path'])
            with open(path, encoding='utf-8') as handle:
                text = handle.read()
            parsed = json.loads(text)
            state = parsed.get('state', parsed)
            if not isinstance(state.get('maps'), list): raise ValueError('invalid campaign')
            from .resource_database import ResourceDatabase
            if ResourceDatabase(save_root).active():
                from .player_profiles import Store
                from . import player_profiles, paths
                from .resources import ResourceStore
                profiles = Store(save_root, paths.APP_ROOT, paths.CACHE_ROOT / '联机资源')
                ResourceStore(profiles, player_profiles).reconcile(state)
            compact = ModuleStore(save_root).externalize(parsed, 'campaign:' + str(parsed.get('campaignId') or state.get('campaignId') or os.path.dirname(path)))
            return {'ok': True, 'text': encode(compact), 'sourceHash': hashlib.sha256(text.encode('utf-8')).hexdigest()}
    if operation == 'archive-campaign':
        path = local_save_target(data.get('path'), 'read', save_root)
        if os.path.basename(path) != '当前存档.json' or len(str(data.get('path')).split('/')) != 3:
            raise ValueError('invalid campaign path')
        with SAVE_WRITE_LOCK:
            with open(path, encoding='utf-8') as handle:
                record = json.load(handle)
            campaign_id = record.get('campaignId') or record.get('state', {}).get('campaignId') or os.path.basename(os.path.dirname(path))
            if campaign_id != data.get('campaignId'):
                raise SaveConflict('战役已变化，请刷新后重试')
            marker = os.path.join(os.path.dirname(path), '已删除.json')
            if not os.path.exists(marker):
                with open(marker, 'x', encoding='utf-8') as handle:
                    json.dump({'campaignId': campaign_id, 'deletedAt': int(time.time() * 1000)}, handle)
            CAMPAIGN_SUMMARIES.pop(path, None)
        return {'ok': True}
    target = local_save_target(data.get('path'), operation, save_root)
    if Workspace(save_root).active and data.get('path') == '棋子库/棋子库.json':
        from . import player_profiles
        with SAVE_WRITE_LOCK, player_profiles.LOCK:
            try: current=encode(read_catalog(save_root,'template'))
            except FileNotFoundError: current=None
            digest=hashlib.sha256(current.encode()).hexdigest() if current is not None else None
            if operation == 'read': return {'ok':True,'text':current,'catalogHash':digest}
            if operation == 'write':
                if 'catalogHash' not in data or data['catalogHash'] != digest:
                    raise SaveConflict('棋子库已被其他页面或模块操作更新，请保留本页修改并重新载入后再编辑；正式库未覆盖')
                write_catalog(save_root,'template',json.loads(data['text']))
                updated=encode(read_catalog(save_root,'template'))
                return {'ok':True,'catalogHash':hashlib.sha256(updated.encode()).hexdigest()}
    if operation == 'read':
        if not os.path.isfile(target):
            return {'ok': True, 'text': None}
        with open(target, 'r', encoding='utf-8') as handle:
            return {'ok': True, 'text': handle.read()}
    if operation == 'list':
        kind = str(data.get('kind') or '')
        if kind not in ('file', 'directory'):
            raise ValueError('invalid entry kind')
        entries = []
        if os.path.isdir(target):
            for entry in os.scandir(target):
                if entry.is_symlink():
                    continue
                if kind == 'file' and entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    entries.append({
                        'name': entry.name,
                        'lastModified': int(stat.st_mtime * 1000),
                        'size': stat.st_size,
                    })
                elif kind == 'directory' and entry.is_dir(follow_symlinks=False):
                    entries.append({'name': entry.name})
        entries.sort(key=lambda item: item.get('name') or '')
        return {'ok': True, 'entries': entries}
    if operation == 'write':
        if os.path.basename(target) == '当前存档.json':
            raise SaveConflict('请刷新主控台，正式战役必须使用带版本校验的保存接口')
        text = data.get('text')
        if not isinstance(text, str):
            raise ValueError('save text must be a string')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + '.tmp-' + secrets.token_hex(6)
        try:
            with open(temporary, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(text)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
        return {'ok': True}
    if operation == 'read-binary':
        if not os.path.isfile(target):
            return {'ok': True, 'base64': None, 'mime': None}
        if os.path.getsize(target) > MAX_CAMPAIGN_COVER_BYTES:
            raise ValueError('campaign cover is too large')
        extension = os.path.splitext(target)[1].lower()
        mime = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
        }.get(extension, 'application/octet-stream')
        with open(target, 'rb') as handle:
            encoded = base64.b64encode(handle.read()).decode('ascii')
        return {'ok': True, 'base64': encoded, 'mime': mime}
    if operation == 'write-binary':
        encoded = data.get('base64')
        if not isinstance(encoded, str):
            raise ValueError('campaign cover must be base64 data')
        try:
            binary = base64.b64decode(encoded.encode('ascii'), validate=True)
        except (ValueError, UnicodeEncodeError) as error:
            raise ValueError('invalid campaign cover data') from error
        if len(binary) > MAX_CAMPAIGN_COVER_BYTES:
            raise ValueError('campaign cover is too large')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = target + '.tmp-' + secrets.token_hex(6)
        try:
            with open(temporary, 'wb') as handle:
                handle.write(binary)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
        return {'ok': True, 'size': len(binary)}
    if operation == 'delete':
        removed = False
        if os.path.isdir(target):
            if data.get('recursive'):
                shutil.rmtree(target)
            else:
                os.rmdir(target)
            removed = True
        elif os.path.isfile(target):
            os.remove(target)
            removed = True
        return {'ok': True, 'removed': removed}
    raise ValueError('unsupported save operation')
