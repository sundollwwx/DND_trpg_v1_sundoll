"""Portable data packages. No executable files, absolute paths or credentials.

Installation validates the entire archive before registering anything. Existing
module identities are immutable: reimport is idempotent, changed versions never
silently replace live state.
"""
import copy
import hashlib
import io
import json
import mimetypes
from pathlib import Path
import re
import secrets
import time
from urllib.parse import unquote, urlparse
import zipfile
from .module_store import ModuleStore, ASSET_URL, DIGEST, encode, RevisionConflict

KINDS = ('general', 'campaign-content', 'campaign-progress', 'player')
MAX_PACKAGE_BYTES = 2 * 1024 ** 3
PRIVATE_KEYS = {'credential','loginCode','password','authVersion','sessionToken','_authVersion','authentication'}


def walk(value):
    if isinstance(value, dict):
        for child in value.values(): yield from walk(child)
    elif isinstance(value, list):
        for child in value: yield from walk(child)
    elif isinstance(value, str): yield value


def strip_secrets(value):
    if isinstance(value, dict): return {k: strip_secrets(v) for k,v in value.items() if k not in PRIVATE_KEYS}
    if isinstance(value, list): return [strip_secrets(v) for v in value]
    return value


from .workspace import Workspace, cache_root


class ModulePackages:
    def __init__(self, save_root, app_root):
        self.store = ModuleStore(save_root)
        self.save_root, self.app = Path(save_root), Path(app_root).resolve()

    def portable(self, value, scope):
        """Resolve only explicit media fields; prose/URLs in handouts stay prose."""
        value = self.store.externalize(strip_secrets(value), scope)
        media_keys = {'mapData','iconImgPath','iconImg','iconImgHd','image','cover','assetUrl','fileUrl'}
        def visit(node, field=''):
            if isinstance(node, dict): return {k: visit(v, k) for k,v in node.items()}
            if isinstance(node, list): return [visit(v, field) for v in node]
            if not isinstance(node, str) or not node or field not in media_keys: return node
            if node.startswith(ASSET_URL): return node
            parsed = urlparse(node)
            if parsed.scheme in ('http', 'https'):
                raise ValueError('完整模块仍有外部图片，请先导入本地：' + field)
            path = unquote(parsed.path).replace('\\','/')
            if path.startswith('/api/player-art/'):
                digest = path.rsplit('/', 1)[-1]
                if not DIGEST.fullmatch(digest): raise ValueError('立绘资源编号无效')
                target = Workspace(self.save_root).players / '资源' / digest
            elif path.startswith('/api/assets/'):
                digest = path.rsplit('/', 1)[-1]
                if not DIGEST.fullmatch(digest): raise ValueError('缓存资源编号无效')
                target = cache_root(self.save_root,self.app) / digest
            else:
                path = re.sub(r'^(?:\.\./)+', '', path).lstrip('/')
                if path.startswith('立绘/') or path.startswith('显示缓存/'):
                    path = 'asset/棋子库/' + path
                if path.startswith('棋子库/'): path = 'asset/' + path
                target = (self.app / path).resolve()
                if self.app not in target.parents: raise ValueError('素材路径超出应用目录')
            if not target.is_file() or target.is_symlink(): raise ValueError('模块缺少素材：' + str(node))
            raw = target.read_bytes()
            mime = mimetypes.guess_type(str(target))[0]
            if raw.startswith(b'\x89PNG'): mime = 'image/png'
            elif raw.startswith(b'\xff\xd8'): mime = 'image/jpeg'
            elif raw.startswith(b'GIF'): mime = 'image/gif'
            elif raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': mime = 'image/webp'
            return self.store.put_asset(raw, mime, scope)
        return visit(value)

    def export(self, destination, kind, name, payload, module_id=None):
        if kind not in KINDS: raise ValueError('模块种类无效')
        module_id = module_id or 'mod-' + secrets.token_hex(16)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', module_id): raise ValueError('模块编号无效')
        payload = self.portable(payload, 'module:' + module_id)
        body = encode(payload).encode()
        assets = []
        for digest in sorted({v[len(ASSET_URL):] for v in walk(payload) if v.startswith(ASSET_URL)}):
            asset = self.store.asset(digest)
            if not asset: raise ValueError('模块依赖缺失：' + digest)
            path, mime, size = asset
            if self.store.hash_file(path) != digest: raise ValueError('模块原图校验失败')
            assets.append({'id': digest, 'mime': mime, 'size': size})
        manifest = dict(format='sundoll-module', schemaVersion=3, moduleId=module_id, kind=kind,
                        name=str(name)[:120], createdAt=int(time.time()*1000), dataHash=hashlib.sha256(body).hexdigest(), assets=assets)
        self.validate_payload(kind, payload)
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.' + secrets.token_hex(6) + '.tmp')
        try:
            with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('manifest.json', encode(manifest))
                archive.writestr('data.json', body)
                for asset in assets:
                    archive.write(self.store.asset_path(asset['id']), 'assets/' + asset['id'])
            temporary.replace(destination)
        finally:
            if temporary.exists(): temporary.unlink()
        return manifest

    @staticmethod
    def validate_payload(kind, payload):
        if not isinstance(payload, dict) or strip_secrets(payload) != payload:
            raise ValueError('模块包含无效或认证资料')
        allowed = {'general': {'templates','items'}, 'campaign-content': {'state','templates','items','documents','music','mapItems'},
                   'campaign-progress': {'state','templates','items','documents','music','mapItems','resourceSnapshot'},
                   'player': {'profile','library','characters','backpack','resourceSnapshot'}}[kind]
        if set(payload) - allowed: raise ValueError('模块含有不属于此类型的数据')
        snapshot = payload.get('resourceSnapshot')
        if snapshot is not None and (not isinstance(snapshot, dict) or set(snapshot) != {'authority','lootHash'} or
                not DIGEST.fullmatch(str(snapshot.get('authority'))) or not DIGEST.fullmatch(str(snapshot.get('lootHash')))):
            raise ValueError('模块资源版本信息无效')
        if kind.startswith('campaign'):
            state = payload.get('state')
            if not isinstance(state, dict) or not isinstance(state.get('maps'), list): raise ValueError('战役地图数据无效')
            if kind == 'campaign-content':
                if state.get('parkedOwnedPieces') or any(t.get('ownedPieceId') or t.get('ownerPlayerId') for m in state['maps'] for t in m.get('tokens', [])):
                    raise ValueError('战役内容包不能包含真实玩家身份')
        if kind == 'player':
            profile = payload.get('profile', {})
            pid = profile.get('playerId')
            if set(profile) - {'playerId','name','enabled','revision'} or not re.fullmatch(r'p[0-9a-f]{32}', str(pid)):
                raise ValueError('玩家档案无效')
            pieces = payload.get('library', {}).get('pieces')
            chars = payload.get('characters')
            if not isinstance(pieces, list) or not isinstance(chars, dict): raise ValueError('角色名册无效')
            identities = set()
            for piece in pieces:
                oid = piece.get('ownedPieceId')
                if not re.fullmatch(r'o[0-9a-f]{32}', str(oid)) or oid in identities or piece.get('ownerPlayerId') != pid: raise ValueError('角色身份或归属冲突')
                identities.add(oid)
            if identities != set(chars) or any(c.get('ownerPlayerId') != pid or c.get('id') != oid for oid,c in chars.items()): raise ValueError('角色主档缺失或混入其他玩家')
            bag = payload.get('backpack', {})
            if bag.get('playerId') != pid or any(i.get('ownerCharacterId') and i['ownerCharacterId'] not in identities for i in bag.get('items', [])):
                raise ValueError('背包归属不一致')

    def inspect(self, source):
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            names = [e.filename for e in entries]
            if len(names) > 10000 or len(names) != len(set(names)) or sum(e.file_size for e in entries) > MAX_PACKAGE_BYTES:
                raise ValueError('模块容量超限或存在重复文件')
            if any(e.flag_bits & 1 or (e.external_attr >> 16) & 0o170000 == 0o120000 for e in entries):
                raise ValueError('模块不能包含加密文件或符号链接')
            for name in names:
                if name not in ('manifest.json','data.json') and not re.fullmatch(r'assets/[0-9a-f]{64}', name):
                    raise ValueError('模块包含不允许的文件路径')
            for key in ('manifest.json', 'data.json'):
                if key not in names or archive.getinfo(key).file_size > 16*1024*1024:
                    raise ValueError('模块清单缺失或过大')
            manifest = json.loads(archive.read('manifest.json'))
            if manifest.get('format') != 'sundoll-module' or manifest.get('schemaVersion') != 3 or manifest.get('kind') not in KINDS:
                raise ValueError('模块格式版本不兼容')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,96}', str(manifest.get('moduleId'))): raise ValueError('模块编号无效')
            body = archive.read('data.json')
            if hashlib.sha256(body).hexdigest() != manifest.get('dataHash'): raise ValueError('模块数据校验失败')
            payload = json.loads(body)
            self.validate_payload(manifest['kind'], payload)
            assets = manifest.get('assets')
            if not isinstance(assets, list): raise ValueError('模块资源清单无效')
            expected = {'manifest.json','data.json'}
            for asset in assets:
                digest = asset.get('id')
                if not DIGEST.fullmatch(str(digest)): raise ValueError('资源编号无效')
                name = 'assets/' + digest
                if name in expected or name not in names: raise ValueError('资源重复或缺失')
                expected.add(name)
                if type(asset.get('size')) is not int or asset['size'] != archive.getinfo(name).file_size or asset['size'] > 128*1024*1024: raise ValueError('资源大小无效')
                with archive.open(name) as handle:
                    digest_value = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(1024*1024), b''): digest_value.update(chunk)
                if digest_value.hexdigest() != digest: raise ValueError('资源内容校验失败')
            referenced = {v[len(ASSET_URL):] for v in walk(payload) if v.startswith(ASSET_URL)}
            if set(names) != expected or referenced != {a['id'] for a in assets}: raise ValueError('模块资源依赖不完整')
            return manifest, payload

    def install(self, source, expected_hash=None):
        manifest, payload = self.inspect(source)
        identity = manifest['moduleId']
        with self.store.transaction() as db:
            old = self.store.document(db, 'installed-module', identity)
            if old:
                previous = old['data']['manifest']
                if previous['kind'] != manifest['kind']: raise RevisionConflict('模块类型不能改变')
                if previous['dataHash'] == manifest['dataHash']:
                    return dict(manifest, alreadyInstalled=True)
                if expected_hash != previous['dataHash']:
                    raise RevisionConflict('此模块已有不同版本，请先预览并确认更新')
                history = identity + '-' + str(old['revision'])
                content = self.store.document(db, 'module-content', identity)
                self.store.write_document(db, 'module-history', history, identity,
                    {'manifest':previous, 'payload':content['data']}, 0)
            elif expected_hash is not None:
                raise RevisionConflict('安装状态已变化，请重新预览')
            with zipfile.ZipFile(source) as archive:
                for asset in manifest['assets']:
                    self.store.put_asset(archive.read('assets/' + asset['id']), asset['mime'], 'module:' + identity, db)
            self.store.write_document(db, 'installed-module', identity, '', {'manifest': manifest}, old['revision'] if old else 0)
            content = self.store.document(db, 'module-content', identity)
            self.store.write_document(db, 'module-content', identity, '', payload, content['revision'] if content else 0)
        return dict(manifest, alreadyInstalled=False, updated=bool(old))

    def catalog(self):
        db = self.store.connect()
        try:
            return [dict(json.loads(row[0])['manifest'], archived=json.loads(row[0]).get('archived',False)) for row in db.execute("SELECT payload FROM documents WHERE kind='installed-module'")]
        finally: db.close()

    def payload(self, identity, allow_archived=True):
        db = self.store.connect()
        try:
            doc = self.store.document(db, 'installed-module', identity)
            content = self.store.document(db, 'module-content', identity)
        finally: db.close()
        if not doc or not content: raise ValueError('模块尚未安装')
        return dict(doc['data'], payload=content['data'])
