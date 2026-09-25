"""Authentication boundary: providers return stable player identities.

HTTP never accepts an arbitrary provider switch. The server selects its provider;
email_password is reserved and fails closed until explicitly implemented.
Legacy credentials remain an internal migration adapter, disabled in production.
"""
import json
import unicodedata
from .player_profiles import ProfileError, LOCK

DEFAULT_METHOD = 'name'


def name_key(value):
    if not isinstance(value, str): raise ProfileError('请填写玩家名')
    value = unicodedata.normalize('NFKC', value).strip()
    if not 1 <= len(value) <= 24 or any(unicodedata.category(c).startswith('C') for c in value):
        raise ProfileError('玩家名需为 1–24 个有效字符')
    return value.casefold()


def authenticate(store, data, *, register=False, method=DEFAULT_METHOD):
    if method != 'name':
        raise ProfileError('此登录方式尚未启用', 501)
    requested = data.get('authMethod', 'name')
    if requested != method: raise ProfileError('此登录方式尚未启用', 501)
    if any(k in data for k in ('credential', 'password', 'email')):
        raise ProfileError('当前仅使用玩家名字登录', 400)
    key = name_key(data.get('nickname'))
    with LOCK:
        matches = [p for p in store.players() if name_key(p['name']) == key]
        if register:
            if matches: raise ProfileError('这个玩家名已被使用，请登录原账号或换一个名字', 409)
            profile = store.create(unicodedata.normalize('NFKC', data['nickname']).strip())['profile']
        else:
            if not matches: raise ProfileError('玩家不存在，请先创建玩家', 404)
            if len(matches) != 1: raise ProfileError('存在同名玩家，请主持人先区分名字', 409)
            profile = matches[0]
        if not profile.get('enabled'): raise ProfileError('此玩家已停用', 403)
        # Session revocation continues to use the existing private version record.
        # No secret is sent to or required from the player.
        record = json.loads((store.auth_root / (profile['playerId'] + '.json')).read_text('utf-8'))
        return dict(profile, _authVersion=record.get('version') or record['digest'])
