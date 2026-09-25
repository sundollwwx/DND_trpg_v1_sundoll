"""Private, server-owned player collections. No browser file writes."""
import os, json, secrets, hashlib, threading, copy, base64, re, time
from pathlib import Path
from urllib.parse import unquote, urlparse
from server.module_store import ModuleStore, RevisionConflict
from server.resource_database import ResourceDatabase
from server.workspace import Workspace, read_catalog

LOCK = threading.RLock()
class ProfileError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
    temp = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        with open(temp, 'xb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
        if os.name != 'nt':
            fd = os.open(str(path.parent), os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
        if path.read_bytes() != data:
            raise OSError('存档回读校验失败')
    finally:
        if temp.exists(): temp.unlink()


class Store:
    def __init__(self, save_root, project_root, cache_root):
        self.save_root = Path(save_root)
        self.workspace = Workspace(save_root)
        self.root = self.workspace.players
        self.auth_root = self.workspace.auth
        self.project = Path(project_root).resolve()
        self.cache = Path(cache_root)

    def path(self, player_id, filename):
        if not re.fullmatch(r'p[0-9a-f]{32}', str(player_id)):
            raise ProfileError('玩家编号无效')
        return self.workspace.checked(self.workspace.player(player_id) / filename)

    def read(self, player_id):
        try:
            profile = json.loads(self.path(player_id, '当前档案.json').read_text('utf-8'))
            if not isinstance(profile, dict) or profile.get('playerId') != player_id or not isinstance(profile.get('name'), str):
                raise ValueError()
            return profile
        except FileNotFoundError: raise ProfileError('玩家档案不存在', 404)
        except (ValueError, TypeError): raise ProfileError('玩家档案损坏，请主控检查备份；未覆盖原文件', 503)

    def library(self, player_id):
        self.read(player_id)
        try:
            store = ModuleStore(self.save_root)
            doc = None
            if ResourceDatabase(self.save_root).active():
                db = store.connect()
                try:
                    db.execute('BEGIN')
                    doc = store.document(db, 'player-library', player_id)
                    if doc:
                        lib = doc['data']
                        for piece in lib['pieces']:
                            character = store.document(db, 'runtime-character', piece['ownedPieceId'])
                            if character:
                                c = character['data']
                                if c['ownerPlayerId'] != player_id: raise ValueError('character owner mismatch')
                                piece.update(c['base'], **c['runtime'], characterRevision=c['revision'], characterId=c['id'], name=c['name'])
                                piece.pop('campaignStates', None)
                                piece.pop('mapSyncStates', None)
                finally:
                    db.close()
            if not doc:
                lib = json.loads(self.path(player_id, '棋子库.json').read_text('utf-8'))
            if not isinstance(lib, dict) or type(lib.get('revision')) is not int or lib['revision'] < 1 or not isinstance(lib.get('pieces'), list) or not isinstance(lib.get('grants'), dict):
                raise ValueError()
            seen = set()
            for piece in lib['pieces']:
                if not isinstance(piece, dict) or piece.get('ownerPlayerId') != player_id or not re.fullmatch(r'o[0-9a-f]{32}', str(piece.get('ownedPieceId'))) or piece['ownedPieceId'] in seen or type(piece.get('revision')) is not int:
                    raise ValueError()
                seen.add(piece['ownedPieceId'])
            return lib
        except (ValueError, TypeError, FileNotFoundError):
            raise ProfileError('个人棋子库存档损坏或缺失，请主控检查自动备份；未覆盖原文件', 503)

    def players(self):
        result = []
        for path in sorted(self.root.glob('*/当前档案.json')):
            self.workspace.checked(path)
            profile = self.read(json.loads(path.read_text('utf-8'))['playerId'])
            result.append(profile)
        return result

    def create(self, name, login_code=None):
        from .authentication import name_key
        identity_name = name_key(name)
        name = str(name).strip()
        with LOCK:
            if any(name_key(p['name']) == identity_name for p in self.players()):
                raise ProfileError('这个玩家名已被使用，请登录原账号或换一个名字', 409)
            if login_code is not None: self.validate_login_code(login_code)
            pid = 'p' + secrets.token_hex(16)
            profile = {'playerId': pid, 'name': name, 'enabled': True, 'revision': 1}
            try:
                atomic(self.path(pid, '棋子库.json'), {'revision': 1, 'pieces': [], 'grants': {}})
                credential = self.rotate(pid, creating=True, login_code=login_code)
                atomic(self.path(pid, '当前档案.json'), profile)
            except Exception:
                # No published profile means this is our own incomplete creation.
                # A committed profile is retained so a lost reply can be retried.
                if not self.path(pid, '当前档案.json').exists():
                    for partial in (self.path(pid, '棋子库.json'), self.auth_root/(pid+'.json')):
                        try: partial.unlink()
                        except FileNotFoundError: pass
                    try: self.path(pid, 'x').parent.rmdir()
                    except OSError: pass
                raise
            self.name_directory(pid)
            return {'profile': profile, 'credential': credential}

    def name_directory(self, pid):
        if self.workspace.active:
            from .player_directories import rename_directory
            rename_directory(self.save_root, pid)

    def register(self, name, code):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 24 or any(ord(c) < 32 for c in name):
            raise ProfileError('玩家名需为 1–24 个字符')
        name = name.strip()
        with LOCK:
            matches = [p for p in self.players() if p['name'].casefold() == name.casefold()]
            if matches:
                # A lost response may be retried with the same secret, but a name
                # alone can never recover or overwrite another player's profile.
                try: existing = self.login(code)
                except ProfileError: raise ProfileError('这个玩家名已被使用，请登录原档案或换一个名字', 409)
                if len(matches) == 1 and existing['playerId'] == matches[0]['playerId']:
                    return existing
                raise ProfileError('这个玩家名已被使用，请换一个名字', 409)
            self.validate_login_code(code)
            self.create(name, login_code=code)
            return self.login(code)

    def rename(self, pid, name, expected=None):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 24 or any(ord(c) < 32 for c in name):
            raise ProfileError('玩家名需为 1–24 个字符')
        name = name.strip()
        with LOCK:
            profile = self.read(pid)
            if expected is not None and expected != profile['name']:
                raise ProfileError('名字已在另一处修改，请刷新后重试', 409)
            from .authentication import name_key
            normalized = name_key(name)
            if any(p['playerId'] != pid and name_key(p['name']) == normalized for p in self.players()):
                raise ProfileError('这个玩家名已被使用，请换一个名字', 409)
            if profile['name'] == name: return profile
            atomic(self.path(pid, '自动备份/改名前-%s.json' % time.time_ns()), profile)
            profile = dict(profile, name=name, revision=profile['revision'] + 1)
            atomic(self.path(pid, '当前档案.json'), profile)
            self.name_directory(pid)
            return profile

    def delete(self, pid):
        """Remove the active profile while retaining a private rollback copy."""
        with LOCK:
            source = self.path(pid, '当前档案.json').parent
            archived = self.root / '已删除' / pid
            if source.exists():
                if archived.exists(): raise ProfileError('删除备份已存在，请检查档案目录', 409)
                archived.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source, archived)
            elif not archived.is_dir():
                raise ProfileError('玩家档案不存在', 404)
            # Read/login fail as soon as the directory moves, including racing sessions.
            credential = self.auth_root / (pid + '.json')
            try: credential.unlink()
            except FileNotFoundError: pass
            if self.workspace.active:
                store = ModuleStore(self.save_root)
                with store.transaction() as db:
                    if not store.document(db,'archived-player',pid):
                        store.write_document(db,'archived-player',pid,pid,{'archived':True},0)
                    db.execute("INSERT INTO module_outbox SELECT kind,id FROM documents WHERE owner=? ON CONFLICT(kind,id) DO NOTHING",(pid,))
            return {'deletedPlayerId': pid}

    def validate_login_code(self, code, pid=None):
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,48}', code):
            raise ProfileError('登录码需为 8–48 位英文字母、数字、短横线或下划线，区分大小写')
        digest = hashlib.sha256(code.encode()).hexdigest()
        for path in (self.auth_root).glob('p*.json'):
            if path.stem == pid: continue
            try:
                record = json.loads(path.read_text('utf-8'))
                if not isinstance(record, dict): raise ValueError()
                if record.get('custom') and secrets.compare_digest(str(record.get('digest', '')), digest):
                    raise ProfileError('这个登录码已被使用，请换一个', 409)
            except (OSError, ValueError) as error:
                if isinstance(error, ProfileError): raise
                raise ProfileError('认证记录不可用，请先检查认证文件', 503)
        return code

    def rotate(self, pid, creating=False, login_code=None):
        with LOCK:
            if not creating: self.read(pid)
            secret = self.validate_login_code(login_code, pid) if login_code is not None else secrets.token_urlsafe(32)
            self.path(pid, 'x')  # Validate identity independently of the folder label.
            auth_path = self.auth_root / (pid + '.json')
            if not creating and auth_path.exists():
                try: old = json.loads(auth_path.read_text('utf-8'))
                except (ValueError, OSError): old = None
                if old is not None:
                    atomic(self.auth_root / '自动备份' / (pid + '-' + str(time.time_ns()) + '.json'), old)
            atomic(auth_path,
                   {'digest': hashlib.sha256(secret.encode()).hexdigest(), 'version': secrets.token_hex(16), 'copySecret': secret, 'custom': login_code is not None})
            return secret if login_code is not None else pid + '.' + secret

    def credential(self, pid):
        """Host-only reusable credential; legacy hashes and sessions remain valid."""
        with LOCK:
            self.read(pid)
            path = self.auth_root / (pid + '.json')
            try:
                record = json.loads(path.read_text('utf-8'))
                if not isinstance(record.get('digest'), str) or not record['digest']:
                    raise ValueError()
                if not record.get('copySecret'):
                    record['copySecret'] = secrets.token_urlsafe(32)
                    atomic(path, record)
                return record['copySecret'] if record.get('custom') else pid + '.' + record['copySecret']
            except (OSError, ValueError, TypeError, KeyError):
                raise ProfileError('凭证记录不可用，请检查认证文件或重置玩家凭证', 503)

    def login(self, credential):
        with LOCK:
            try:
                value = str(credential).strip()
                if '.' not in value:
                    if not re.fullmatch(r'[A-Za-z0-9_-]{8,48}', value): raise ValueError()
                    digest = hashlib.sha256(value.encode()).hexdigest()
                    matches = []
                    for path in (self.auth_root).glob('p*.json'):
                        candidate = json.loads(path.read_text('utf-8'))
                        if candidate.get('custom') and secrets.compare_digest(str(candidate.get('digest', '')), digest):
                            matches.append(path.stem)
                    if len(matches) != 1: raise ValueError()
                    pid, secret = matches[0], value
                else:
                    pid, secret = value.split('.', 1)
                self.path(pid, 'x')
                record = json.loads((self.auth_root / (pid + '.json')).read_text('utf-8'))
                profile = self.read(pid)
                if not profile['enabled'] or not (secrets.compare_digest(record['digest'], hashlib.sha256(secret.encode()).hexdigest()) or (record.get('copySecret') and secrets.compare_digest(record['copySecret'], secret))):
                    raise ValueError()
                return dict(profile, _authVersion=record.get('version') or record['digest'])
            except (ValueError, OSError, KeyError, TypeError, AttributeError): raise ProfileError('玩家凭证无效或已重置', 401)

    def session_valid(self, pid, version):
        # Do not acquire LOCK here: this read also runs while the server state lock is held.
        try:
            self.path(pid, 'x')
            record = json.loads((self.auth_root / (pid + '.json')).read_text('utf-8'))
            return bool(version and self.read(pid).get('enabled') and secrets.compare_digest(str(version), str(record.get('version') or record.get('digest') or '')))
        except (ValueError, OSError, KeyError, TypeError, AttributeError):
            return False

    def snapshot_image(self, source):
        if not source: return None
        source = str(source)
        if source.startswith('/api/module-assets/'):
            digest = source.rsplit('/', 1)[-1]
            try: asset = ModuleStore(self.save_root).asset(digest)
            except ValueError: asset = None
            if not asset or not asset[1].startswith('image/') or asset[2] > 16 * 1024 * 1024:
                raise ProfileError('角色原图不存在或格式无效')
            return source
        if source.startswith('/api/player-art/'):
            digest = source.rsplit('/', 1)[-1]
            if not re.fullmatch('[0-9a-f]{64}', digest) or not (self.root / '资源' / digest).is_file():
                raise ProfileError('个人立绘资源缺失')
            return source
        if source.startswith('data:image/'):
            try:
                meta, encoded = source.split(',', 1)
                if ';base64' not in meta or meta.split(';')[0] not in ('data:image/png','data:image/jpeg','data:image/webp','data:image/gif'):
                    raise ValueError()
                raw = base64.b64decode(encoded, validate=True)
            except ValueError: raise ProfileError('立绘数据无效')
        else:
            parsed = urlparse(source)
            if parsed.scheme or parsed.netloc: raise ProfileError('请先把远程立绘导入本机，再发放')
            path = unquote(parsed.path).replace('\\', '/')
            if path.startswith('/api/assets/'):
                digest = path.rsplit('/', 1)[-1]
                if not re.fullmatch('[0-9a-f]{64}', digest): raise ProfileError('立绘缓存无效')
                target = self.cache / digest
            else:
                path = re.sub(r'^(?:\.\./)?(?:asset/)?棋子库/', '', path)
                target = self.project / (path.lstrip('/') if path.startswith('/asset/') else 'asset/棋子库/' + path)
            target = target.resolve()
            if os.path.commonpath([str(target), str(self.project)]) != str(self.project) and os.path.commonpath([str(target), str(self.cache.resolve())]) != str(self.cache.resolve()):
                raise ProfileError('立绘路径无效')
            if not target.is_file() or target.stat().st_size > 16 * 1024 * 1024: raise ProfileError('立绘不存在或超过 16 MB')
            raw = target.read_bytes()
        if not raw or len(raw) > 16 * 1024 * 1024: raise ProfileError('立绘大小无效')
        if not (raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'\xff\xd8\xff') or raw.startswith((b'GIF87a',b'GIF89a')) or (raw[:4] == b'RIFF' and raw[8:12] == b'WEBP')):
            raise ProfileError('只支持 PNG、JPEG、WebP、GIF 立绘')
        if self.workspace.active:
            mime = 'image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg' if raw.startswith(b'\xff\xd8') else 'image/gif' if raw.startswith(b'GIF') else 'image/webp'
            return ModuleStore(self.save_root).put_asset(raw, mime, 'player-upload')
        digest = hashlib.sha256(raw).hexdigest()
        target = self.root / '资源' / digest
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temp = target.with_name(digest + '.' + secrets.token_hex(8) + '.tmp')
            try:
                with open(temp, 'xb') as f:
                    f.write(raw); f.flush(); os.fsync(f.fileno())
                os.replace(temp, target)
            finally:
                if temp.exists(): temp.unlink()
        if target.read_bytes() != raw: raise OSError('立绘写入校验失败')
        return '/api/player-art/' + digest

    def snapshot(self, preset):
        if not isinstance(preset, dict): raise ProfileError('棋子资料无效')
        # Only character data; never copy embedded credentials or arbitrary ownership.
        from server.token_sizes import size_fields
        fields = ('name','type','icon','size','sizeCategory','hpMax','ac','level','category','publicNote','spellRange')
        result = {k: copy.deepcopy(preset[k]) for k in fields if k in preset}
        result['name'] = str(result.get('name') or '未命名棋子')[:24]
        result['publicNote'] = str(result.get('publicNote') or '')[:240]
        for key, default, maximum in [('hpMax',10,99999),('ac',10,99),('level',1,99)]:
            try: result[key] = max(0 if key == 'ac' else 1, min(maximum, int(result.get(key, default))))
            except (ValueError, TypeError): raise ProfileError('棋子数值无效')
        result.update(size_fields(preset))
        result['type'] = result.get('type') if result.get('type') in ('pc','ally','npc','enemy') else 'pc'
        result['iconImgPath'] = self.snapshot_image(preset.get('iconImgPath') or preset.get('iconImgHd') or preset.get('iconImg'))
        if preset.get('iconImgId') and not result['iconImgPath']: raise ProfileError('请先将浏览器中的立绘保存为文件再发放')
        result['portraitVariants'] = []
        variants = preset.get('portraitVariants') or []
        if not isinstance(variants, list) or len(variants) > 24 or any(not isinstance(v, dict) for v in variants):
            raise ProfileError('立绘形态必须是最多 24 项的列表')
        for variant in variants:
            image = self.snapshot_image(variant.get('iconImgPath') or variant.get('iconImgHd') or variant.get('iconImg'))
            if not image:
                raise ProfileError('形态缺少可读取的立绘，请先保存图片再发放或同步')
            result['portraitVariants'].append({'name': str(variant.get('name') or '形态')[:24], 'iconImgPath': image})
        current = result.get('iconImgPath')
        if current and not any(v.get('iconImgPath') == current for v in result['portraitVariants']):
            if len(result['portraitVariants']) >= 24:
                raise ProfileError('当前立绘与形态合计超过 24 项，请先整理形态')
            result['portraitVariants'].insert(0, {'name':'默认形态', 'iconImgPath':current})
        result['portraitVariant'] = next((i for i,v in enumerate(result['portraitVariants']) if v.get('iconImgPath') == current and current), None)
        return result

    def sync_forms(self, pid, oid):
        with LOCK:
            lib = self.library(pid)
            piece = next((p for p in lib['pieces'] if p['ownedPieceId'] == oid), None)
            if not piece: raise ProfileError('收藏不存在', 404)
            try:
                document = read_catalog(self.save_root, 'template')
                presets = document.get('presets', [])
            except (OSError, ValueError, AttributeError):
                raise ProfileError('无法读取正式棋子库，请先保存大棋子库', 503)
            candidates = [p for p in presets if p.get('id') == piece.get('sourcePresetId')]
            if not candidates and not ResourceDatabase(self.save_root).active():
                candidates = [p for p in presets if p.get('name') == piece.get('name') and p.get('type') == piece.get('type')]
            if len(candidates) != 1:
                raise ProfileError('来源棋子不明确，请主控从正确的大棋子库条目重新发放；原收藏已保留', 409)
            source = candidates[0]
            incoming = self.snapshot(source)
            forms = copy.deepcopy(piece.get('portraitVariants') or [])
            seen = {v.get('iconImgPath') for v in forms}
            for variant in incoming['portraitVariants']:
                if variant.get('iconImgPath') and variant['iconImgPath'] not in seen:
                    forms.append(variant); seen.add(variant['iconImgPath'])
            if len(forms) > 24: raise ProfileError('合并后超过 24 个形态，未修改收藏')
            if forms == piece.get('portraitVariants') and piece.get('sourcePresetId') == source['id']:
                return lib
            piece['portraitVariants'] = forms
            piece['sourcePresetId'] = source['id']
            piece['revision'] += 1
            return self.commit_library(pid, lib)

    def commit_library(self, pid, lib):
        old = self.library(pid)
        if ResourceDatabase(self.save_root).active():
            store = ModuleStore(self.save_root)
            from server.resources import ResourceStore
            try:
                with store.transaction() as db:
                    current = store.document(db, 'player-library', pid)
                    if current and current['data']['revision'] != lib['revision']:
                        raise RevisionConflict('角色名册已更新，请刷新后重试')
                    for piece in lib['pieces']:
                        oid = piece['ownedPieceId']
                        former = next((p for p in old['pieces'] if p['ownedPieceId'] == oid), None)
                        doc = store.document(db, 'runtime-character', oid)
                        if not doc:
                            base = ResourceStore.base(piece)
                            c = dict(id=oid, ownerPlayerId=pid, name=piece['name'], revision=1000000,
                                     base=base, runtime=ResourceStore.runtime(piece, base))
                        else:
                            c = copy.deepcopy(doc['data'])
                            if c['ownerPlayerId'] != pid: raise RevisionConflict('角色归属不一致')
                            changes = {key: piece[key] for key in ('hpMax', 'ac', 'level') if former and piece.get(key) != former.get(key)}
                            if changes or c['name'] != piece['name']:
                                c['base'] = ResourceStore.base(dict(c['base'], **changes))
                                c['runtime'] = ResourceStore.runtime(c['runtime'], c['base'])
                                c.update(name=piece['name'], revision=c['revision'] + 1)
                        if not doc or c != doc['data']:
                            store.write_document(db, 'runtime-character', oid, pid, c, doc['revision'] if doc else 0)
                        # The sheet carries appearance; current numeric values are projected on read.
                        piece['characterId'] = oid
                        piece.pop('campaignStates', None); piece.pop('mapSyncStates', None)
                    lib['revision'] += 1
                    store.write_document(db, 'player-library', pid, pid, lib, current['revision'] if current else 0)
                    meta = store.document(db, 'runtime-meta', 'resources')
                    store.write_document(db, 'runtime-meta', 'resources', '', meta['data'], meta['revision'])
                return self.library(pid)
            except RevisionConflict as error:
                raise ProfileError(str(error), 409)
        atomic(self.path(pid, '自动备份/棋子库-%s.json' % old['revision']), old)
        lib['revision'] = old['revision'] + 1
        atomic(self.path(pid, '棋子库.json'), lib)
        return lib

    def grant(self, pid, preset, grant_id):
        if not re.fullmatch('[A-Za-z0-9_-]{16,96}', str(grant_id)): raise ProfileError('发放请求编号无效')
        with LOCK:
            lib = self.library(pid)
            if grant_id in lib['grants']: return lib
            piece = self.snapshot(preset)
            piece.update(ownedPieceId='o'+secrets.token_hex(16), ownerPlayerId=pid, revision=1,
                         sourcePresetId=str(preset.get('sourcePresetId') or preset.get('presetId') or preset.get('id') or '')[:96],
                         sourcePresetVersion=hashlib.sha256(json.dumps(preset, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
                         createdAt=int(time.time()*1000))
            lib['pieces'].append(piece)
            lib['grants'][grant_id] = piece['ownedPieceId']
            return self.commit_library(pid, lib)

    def sync_token(self, pid, token, campaign_id):
        """Sync validated map character data; runtime belongs to its campaign."""
        if ResourceDatabase(self.save_root).active():
            # Global values are updated through revision-checked resource commands.
            # An old campaign projection must never write itself into the master.
            lib = self.library(pid)
            if token.get('ownerPlayerId') != pid or not any(p['ownedPieceId'] == token.get('ownedPieceId') for p in lib['pieces']):
                raise ProfileError('棋子归属已变化', 403)
            return lib
        with LOCK:
            lib = self.library(pid)
            piece = next((p for p in lib['pieces'] if p['ownedPieceId'] == token.get('ownedPieceId')), None)
            if not piece or token.get('ownerPlayerId') != pid:
                raise ProfileError('棋子归属已变化', 403)
            watched = ('name','type','icon','size','sizeCategory','hpMax','ac','level','category','publicNote','spellRange','iconImgPath','iconImgHd','iconImg','portraitVariants','portraitVariant','hp','tempHp','tempHpMax','conditions')
            source = {k: copy.deepcopy(token[k]) for k in watched if k in token}
            if campaign_id and piece.get('mapSyncStates', {}).get(campaign_id) == source:
                return lib
            previous = piece.get('mapSyncStates', {}).get(campaign_id)
            changed = {k: v for k, v in source.items() if previous is None or previous.get(k) != v}
            updated = self.snapshot(dict(piece, **changed))
            runtime = {k: copy.deepcopy(token[k]) for k in ('hp','tempHp','tempHpMax','conditions') if k in token}
            if any(piece.get(k) != v for k, v in updated.items()) or campaign_id:
                piece.update(updated)
                if campaign_id:
                    piece.setdefault('campaignStates', {})[campaign_id] = runtime
                    piece.setdefault('mapSyncStates', {})[campaign_id] = source
                piece['revision'] += 1
                self.commit_library(pid, lib)
            return lib

    def edit(self, pid, oid, revision, patch, piece_revision=None, host=False):
        with LOCK:
            lib = self.library(pid)
            if piece_revision is None and lib['revision'] != revision: raise ProfileError('小库已更新，请刷新后重新编辑', 409)
            piece = next((p for p in lib['pieces'] if p['ownedPieceId'] == oid), None)
            if not piece: raise ProfileError('棋子不存在', 404)
            if piece_revision is not None and (type(piece_revision) is not int or piece_revision != piece['revision']):
                raise ProfileError('这枚棋子的资料已更新；你的草稿已保留，请查看最新版本后处理', 409)
            allowed = {'name','publicNote','iconImg','portraitVariants','portraitVariant'}
            if host: allowed.update({'hpMax', 'ac', 'level', 'size', 'sizeCategory'})
            if not isinstance(patch, dict) or set(patch) - allowed:
                raise ProfileError('不允许修改这些资料', 403)
            for field, minimum, maximum in [('hpMax',1,99999),('ac',0,99),('level',1,99)]:
                if field in patch and (type(patch[field]) is not int or not minimum <= patch[field] <= maximum):
                    raise ProfileError('棋子数值超出范围')
            # Player editors may upload bytes or reuse images already in this collection;
            # they must never turn arbitrary host filesystem paths into public art URLs.
            allowed_images = set()
            for owned in lib['pieces']:
                allowed_images.add(owned.get('iconImgPath'))
                for variant in owned.get('portraitVariants') or []:
                    allowed_images.add(variant.get('iconImgPath'))
            candidates = []
            if 'iconImg' in patch:
                candidates.append(patch['iconImg'])
            if 'portraitVariants' in patch:
                variants = patch['portraitVariants']
                if not isinstance(variants, list) or len(variants) > 24 or any(not isinstance(v, dict) for v in variants):
                    raise ProfileError('立绘形态必须是最多 24 项的列表')
                for variant in variants:
                    candidates.extend(variant.get(key) for key in ('iconImgPath', 'iconImgHd', 'iconImg') if variant.get(key))
            for image in ([] if host else candidates):
                if image is not None and (not isinstance(image, str) or (not image.startswith('data:image/') and image not in allowed_images)):
                    raise ProfileError('只能上传图片或使用自己小库已有的立绘', 403)
            from server.token_sizes import CATEGORIES, size_fields
            if 'sizeCategory' in patch and patch['sizeCategory'] not in CATEGORIES:
                raise ProfileError('体型无效')
            if 'size' in patch and (type(patch['size']) not in (int, float) or patch['size'] not in (.5, 1, 2, 3, 4)):
                raise ProfileError('体型占格无效')
            merged = dict(piece, **patch)
            if 'size' in patch and 'sizeCategory' not in patch: merged.pop('sizeCategory', None)
            merged.update(size_fields(merged))
            if 'portraitVariant' in patch:
                index = patch['portraitVariant']
                variants = merged.get('portraitVariants') or []
                if type(index) is not int or not 0 <= index < len(variants):
                    raise ProfileError('形态已变化，请刷新收藏后重试', 409)
                merged['iconImgPath'] = variants[index].get('iconImgPath') or variants[index].get('iconImgHd') or variants[index].get('iconImg')
                merged.pop('iconImg', None)

            if patch.get('iconImg'): merged['iconImgPath'] = None
            updated = self.snapshot(merged)
            piece.update(updated)
            piece['revision'] += 1
            return self.commit_library(pid, lib)

    def owns(self, pid, oid):
        try:
            return self.read(pid)['enabled'] and any(p['ownedPieceId']==oid for p in self.library(pid)['pieces'])
        except (ValueError, OSError, KeyError, TypeError, AttributeError): return False
