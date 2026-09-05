#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
桑多尔之歌 · 简易联机服务器（零依赖，Python 3.6+）
用法：在项目根目录运行  python3 主控台/联机服务器.py [端口]
      或运行  python3 start_server.py --port 8092 --bind 0.0.0.0
默认端口 8090。启动后：
  主机（你）：浏览器打开 http://localhost:8090/主控台/主控台.html 或本地双击主控台，
              在「📡 联机 → 开启玩家模式」开启推送。
  玩家：同一 WiFi 下用浏览器打开 http://<本机IP>:端口/主控台/玩家.html
"""
import os, sys, json, time, socket, threading, re, base64, hashlib, math, random, secrets, shutil, copy
from urllib.parse import urlparse, parse_qs, unquote_to_bytes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

def cli_options():
    """保持旧的 ``python 联机服务器.py 8090`` 用法，同时支持跨平台自定义端口。"""
    port = 8090
    bind = '0.0.0.0'
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg in ('--port', '-p') and i + 1 < len(sys.argv):
            i += 1
            port = int(sys.argv[i])
        elif arg in ('--bind', '-b') and i + 1 < len(sys.argv):
            i += 1
            bind = str(sys.argv[i])
        elif not arg.startswith('-') and i == 1:
            port = int(arg)
        i += 1
    return port, bind


PORT, BIND_HOST = cli_options()
# 服务器可能放在项目根目录或 主控台/ 下：始终以“项目根目录”为网站根目录
BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE) if os.path.basename(BASE) == '主控台' else BASE
STATE = None
CLIENTS = []          # [(wfile, lock), ...] SSE 连接
LOCK = threading.Lock()
RECENT_ACTIONS = []   # 玩家动作（带自增 seq），用于主机合并
NEXT_SEQ = 1
MAX_RECENT = 500
MAX_BODY = 12 * 1024 * 1024
PATCH_FIELDS = {'hp', 'hpMax', 'ac', 'spellRange', 'conditions'}
MAX_TOKEN_CONDITIONS = 20
CONDITION_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
CONDITION_KEY_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')
CONDITION_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')
CONDITION_META = {
    'prone': ('倒地', '🛌', '#f4a261'),
    'unconscious': ('昏迷', '💤', '#9b8cff'),
    'incapacitated': ('失能', '🚫', '#b9c0cc'),
    'blinded': ('目盲', '🙈', '#c6a97d'),
    'deafened': ('耳聋', '🙉', '#c6a97d'),
    'frightened': ('恐慌', '😨', '#d879ff'),
    'charmed': ('魅惑', '💗', '#ff8fb3'),
    'poisoned': ('中毒', '☠️', '#79c267'),
    'grappled': ('擒抱', '✊', '#d99b62'),
    'restrained': ('束缚', '⛓️', '#d99b62'),
    'stunned': ('眩晕', '💫', '#ffd166'),
    'petrified': ('石化', '🗿', '#a9b3bf'),
    'invisible': ('隐形', '👻', '#8fbaff'),
    'concentrating': ('专注', '🎯', '#68d9c0'),
    'burning': ('燃烧', '🔥', '#ef6c45'),
}
MAX_MOVE_POINTS = 60
MAX_TURN_PATH_POINTS = 200
MAX_ACTION_BODY = 512 * 1024
MAX_PLAYER_PORTRAIT_BYTES = 320 * 1024
PLAYER_PORTRAIT_MIMES = {'image/png', 'image/jpeg', 'image/webp'}
DOODLE_ACTIONS = {'doodleAdd', 'doodleDelete', 'doodleClear'}
INITIATIVE_ACTIONS = {'initiativeSwap'}
TURN_PATH_ACTIONS = {'turnPathUndo', 'turnPathReset'}
PLAYER_SPAWN_ACTION = 'spawnToken'
PLAYER_DELETE_ACTION = 'deletePlayerToken'
PLAYER_MOUNT_ACTION = 'mountToken'
PLAYER_DISMOUNT_ACTION = 'dismountToken'
MAX_PLAYER_TEMP_TOKENS_PER_MAP = 12
DOODLE_TOOLS = {'pen', 'line', 'arrow', 'circle'}
DOODLE_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
DOODLE_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')
MAX_DOODLE_POINTS = 800
MAX_DOODLES = 1000
ACTION_WINDOW_MS = 1000
MAX_ACTIONS_PER_WINDOW = 40
ASSET_ROOT = os.path.join(ROOT, '.sundoll-cache', '联机资源')
LOCAL_SAVE_ROOT = os.path.join(ROOT, '存档')
LOCAL_SAVE_HEADER = 'X-Sundoll-Local-Save'
MAX_LOCAL_SAVE_BODY = 128 * 1024 * 1024
MAX_CAMPAIGN_COVER_BYTES = 8 * 1024 * 1024
CAMPAIGN_COVER_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp')
CAMPAIGN_COVER_FILES = ('封面.webp', '封面.jpg', '封面.jpeg', '封面.png')
CAMPAIGN_COVER_ASSET_CACHE = {}
MUSIC_EXTS = ('.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus', '.webm')
MUSIC_LIBRARY_ROOT = os.path.join(ROOT, 'asset', '音乐')
MUSIC_CACHE_ROOT = os.path.join(ROOT, '音乐缓存')
MUSIC_LIBRARY_INDEX = {}
MAX_MUSIC_LIBRARY_FILES = 1000
MUSIC_MIME_TYPES = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
    '.opus': 'audio/ogg', '.webm': 'audio/webm',
}
# 地图和头像转换为内容哈希 URL，浏览器可长期缓存；资源同时写入磁盘，
# 不再把 Base64 地图和头像塞进每一条 SSE 消息。
ASSETS = {}           # {sha256: (mime, bytes)}
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.S)

SESSION_ID = secrets.token_hex(8)
ROOM_CODE = secrets.token_hex(3).upper()
SERVER_PROTOCOL_VERSION = 7
STATE_REVISION = 0
SESSIONS = {}         # {sessionToken: {playerId, name, status, lastSeen}}
ACTION_IDS = {}       # {actionId: seq}，防止网络重试重复执行
MAX_ACTION_IDS = 2000
ACTION_RATE = {}      # {sessionToken: [最近请求时间戳]}
HOST_ACTIONS = {'roll', 'announce', 'bgm', 'mapReaction', 'restTransition'}
BGM_STATE = {
    'op': 'bgm', 'action': 'stop', 'mode': 'library', 'trackId': '',
    'track': '', 'url': '', 'time': 0.0, 'loop': False, 'issuedAt': 0,
}
WEBRTC_SIGNAL_TYPES = {'offer', 'answer', 'ice', 'ready', 'stop'}
DICE_SKIN_KEYS = {'obsidian', 'dragon', 'arcane', 'jade', 'royal', 'ivory'}
TOKEN_RING_COLORS = {'pc': '#5b8cff', 'enemy': '#ef476f', 'npc': '#f4a261', 'ally': '#2ecc71'}
MAP_REACTION_EMOJIS = {'👍', '❤️', '😂', '😮', '🔥', '✨', '❓', '⚔️', '🎯', '👏'}
REACTION_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
REACTION_RATE = {}
REACTION_COOLDOWN_MS = 450
REST_TRANSITION_DURATIONS = {'short': 2200, 'long': 4400}
REST_TRANSITION_SCENES = {
    'short-outdoor': 'short', 'short-indoor': 'short', 'short-dungeon': 'short',
    'long-outdoor': 'long', 'long-indoor': 'long', 'long-shelter': 'long',
}
REST_TRANSITION_DEFAULT_SCENES = {'short': 'short-outdoor', 'long': 'long-outdoor'}
WORLD_SECONDS_PER_DAY = 24 * 60 * 60
WORLD_DAYS_PER_WEEK = 7
WORLD_WEEKS_PER_YEAR = 52
WEATHER_ROLLOVER_SECONDS = 8 * 60 * 60
MAX_WEATHER_CATCHUP_DAYS = 3660
WEATHER_KEYS = ('clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'wind', 'heat')
WIND_KEYS = ('calm', 'breeze', 'strong', 'gale')
WEATHER_TEMPERATURE_DELTAS = {
    'clear': 2, 'cloudy': 0, 'rain': -3, 'storm': -5,
    'fog': -2, 'snow': -7, 'wind': -2, 'heat': 7,
}
WEATHER_MARKOV_TRANSITIONS = {
    'clear':  {'clear': 7, 'cloudy': 3, 'rain': .6, 'storm': .15, 'fog': .8, 'snow': .4, 'wind': 1.2, 'heat': 2},
    'cloudy': {'clear': 2.5, 'cloudy': 6, 'rain': 4, 'storm': 1.5, 'fog': 2.5, 'snow': 3, 'wind': 1.5, 'heat': .3},
    'rain':   {'clear': 1.2, 'cloudy': 4, 'rain': 6, 'storm': 2.5, 'fog': 2, 'snow': .8, 'wind': 1.4, 'heat': .1},
    'storm':  {'clear': .8, 'cloudy': 4, 'rain': 5, 'storm': 2, 'fog': .6, 'snow': .5, 'wind': 3, 'heat': .1},
    'fog':    {'clear': 2, 'cloudy': 4, 'rain': 2, 'storm': .4, 'fog': 5, 'snow': 1.5, 'wind': .8, 'heat': .2},
    'snow':   {'clear': 1.5, 'cloudy': 4, 'rain': .8, 'storm': .4, 'fog': 1.8, 'snow': 7, 'wind': 2, 'heat': .05},
    'wind':   {'clear': 2.5, 'cloudy': 3, 'rain': 1.5, 'storm': 2, 'fog': .5, 'snow': 1.5, 'wind': 5, 'heat': 1},
    'heat':   {'clear': 4, 'cloudy': 1, 'rain': .4, 'storm': .8, 'fog': .1, 'snow': .01, 'wind': 2, 'heat': 7},
}
WIND_MARKOV_TRANSITIONS = {
    'calm': {'calm': 6, 'breeze': 4, 'strong': .5, 'gale': .1},
    'breeze': {'calm': 2, 'breeze': 6, 'strong': 2, 'gale': .3},
    'strong': {'calm': .4, 'breeze': 3, 'strong': 5, 'gale': 2},
    'gale': {'calm': .2, 'breeze': 2, 'strong': 5, 'gale': 3},
}
WEATHER_WIND_WEIGHTS = {
    'clear': {'calm': 4, 'breeze': 6, 'strong': 1, 'gale': .05},
    'cloudy': {'calm': 2, 'breeze': 6, 'strong': 2, 'gale': .2},
    'rain': {'calm': .8, 'breeze': 4, 'strong': 3, 'gale': .8},
    'storm': {'calm': .05, 'breeze': .3, 'strong': 4, 'gale': 8},
    'fog': {'calm': 5, 'breeze': 3, 'strong': .4, 'gale': .05},
    'snow': {'calm': 1.5, 'breeze': 4, 'strong': 3, 'gale': .8},
    'wind': {'calm': .1, 'breeze': 1, 'strong': 7, 'gale': 3},
    'heat': {'calm': 3, 'breeze': 5, 'strong': 1.5, 'gale': .1},
}
CLIMATE_PROFILES = {
    'temperate': {
        'temperatures': {'spring': 14, 'summer': 25, 'autumn': 15, 'winter': 3},
        'weather': {
            'spring': ['clear', 'cloudy', 'rain', 'rain', 'fog', 'wind'],
            'summer': ['clear', 'clear', 'cloudy', 'rain', 'storm', 'heat'],
            'autumn': ['clear', 'cloudy', 'rain', 'fog', 'wind', 'wind'],
            'winter': ['clear', 'cloudy', 'snow', 'snow', 'fog', 'wind'],
        },
    },
    'cold': {
        'temperatures': {'spring': 0, 'summer': 12, 'autumn': 2, 'winter': -15},
        'weather': {
            'spring': ['cloudy', 'snow', 'rain', 'wind', 'fog'],
            'summer': ['clear', 'cloudy', 'rain', 'fog', 'wind'],
            'autumn': ['cloudy', 'rain', 'snow', 'wind', 'fog'],
            'winter': ['snow', 'snow', 'clear', 'wind', 'fog'],
        },
    },
    'tropical': {
        'temperatures': {'spring': 27, 'summer': 29, 'autumn': 28, 'winter': 26},
        'weather': {
            'spring': ['clear', 'rain', 'rain', 'storm', 'fog'],
            'summer': ['clear', 'heat', 'rain', 'storm', 'storm'],
            'autumn': ['clear', 'rain', 'rain', 'storm', 'cloudy'],
            'winter': ['clear', 'clear', 'cloudy', 'rain', 'fog'],
        },
    },
    'arid': {
        'temperatures': {'spring': 22, 'summer': 36, 'autumn': 25, 'winter': 14},
        'weather': {
            'spring': ['clear', 'clear', 'heat', 'wind', 'cloudy'],
            'summer': ['clear', 'heat', 'heat', 'wind', 'storm'],
            'autumn': ['clear', 'clear', 'heat', 'wind', 'cloudy'],
            'winter': ['clear', 'clear', 'cloudy', 'wind', 'rain'],
        },
    },
    'coastal': {
        'temperatures': {'spring': 15, 'summer': 23, 'autumn': 17, 'winter': 9},
        'weather': {
            'spring': ['cloudy', 'rain', 'fog', 'wind', 'clear'],
            'summer': ['clear', 'cloudy', 'rain', 'fog', 'storm'],
            'autumn': ['cloudy', 'rain', 'wind', 'storm', 'fog'],
            'winter': ['cloudy', 'rain', 'wind', 'fog', 'snow'],
        },
    },
    'highland': {
        'temperatures': {'spring': 5, 'summer': 16, 'autumn': 7, 'winter': -6},
        'weather': {
            'spring': ['clear', 'cloudy', 'fog', 'rain', 'snow'],
            'summer': ['clear', 'cloudy', 'rain', 'storm', 'wind'],
            'autumn': ['cloudy', 'fog', 'rain', 'snow', 'wind'],
            'winter': ['snow', 'snow', 'clear', 'fog', 'wind'],
        },
    },
}


def is_local_request(handler):
    host = handler.client_address[0] if handler.client_address else ''
    if host in ('127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'):
        return True
    # 主机也可能通过自己的局域网/Radmin 地址打开页面；TCP 来源仍是本机地址。
    # 远程玩家的来源地址不会出现在本机网卡列表中。
    try:
        return host in get_ips()
    except Exception:
        return False


def local_save_request_allowed(handler):
    """本机页面专用：Tunnel、局域网玩家和跨站网页都不能调用磁盘存档桥。"""
    if handler.headers.get(LOCAL_SAVE_HEADER) != '1' or not is_local_request(handler):
        return False
    host_header = str(handler.headers.get('Host') or '')
    try:
        host_url = urlparse('//' + host_header)
        host_name = (host_url.hostname or '').lower()
        host_port = host_url.port
    except ValueError:
        return False
    local_hosts = {'localhost', '127.0.0.1', '::1'}
    if host_name not in local_hosts or host_port not in (None, PORT):
        return False
    origin = str(handler.headers.get('Origin') or '').strip()
    if origin:
        try:
            origin_url = urlparse(origin)
            if (origin_url.scheme != 'http'
                    or (origin_url.hostname or '').lower() not in local_hosts
                    or origin_url.port not in (None, PORT)):
                return False
        except ValueError:
            return False
    return True


def ensure_local_save_structure(root=None):
    root = os.path.abspath(root or LOCAL_SAVE_ROOT)
    os.makedirs(os.path.join(root, '战役'), exist_ok=True)
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
    target = os.path.abspath(os.path.join(save_root, *parts))
    if os.path.commonpath([save_root, target]) != save_root:
        raise ValueError('save path escapes root')
    cursor = save_root
    for part in parts:
        cursor = os.path.join(cursor, part)
        if os.path.lexists(cursor) and os.path.islink(cursor):
            raise ValueError('symbolic links are not allowed in saves')
    return target


def perform_local_save_operation(data, root=None):
    if not isinstance(data, dict):
        raise ValueError('request must be an object')
    operation = str(data.get('op') or '')
    save_root = ensure_local_save_structure(root)
    if operation == 'status':
        return {'ok': True, 'mode': 'local-project', 'name': '存档'}

    target = local_save_target(data.get('path'), operation, save_root)
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


def consume_action_slot(session_token):
    now = int(time.time() * 1000)
    cutoff = now - ACTION_WINDOW_MS
    recent = [stamp for stamp in ACTION_RATE.get(session_token, []) if stamp > cutoff]
    if len(recent) >= MAX_ACTIONS_PER_WINDOW:
        ACTION_RATE[session_token] = recent
        return False
    recent.append(now)
    ACTION_RATE[session_token] = recent
    return True


def consume_reaction_slot(session_token):
    now = int(time.time() * 1000)
    previous = int(REACTION_RATE.get(session_token, 0) or 0)
    if now - previous < REACTION_COOLDOWN_MS:
        return False
    REACTION_RATE[session_token] = now
    return True


def finite_int(value, minimum=None, maximum=None, fallback=None):
    number = finite_number(value)
    if number is None:
        return fallback
    value = int(number)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def normalize_spell_range(raw):
    source = raw if isinstance(raw, dict) else {}
    shape = source.get('shape') if source.get('shape') in ('radius', 'cone') else 'off'
    feet_number = finite_number(source.get('feet'))
    feet = int(round((feet_number if feet_number is not None else 30) / 5.0) * 5)
    feet = max(5, min(180, feet))
    direction_number = finite_number(source.get('direction'))
    direction = int(round((direction_number if direction_number is not None else 0) / 5.0) * 5) % 360
    return {'shape': shape, 'feet': feet, 'direction': direction}


def normalize_public_condition(raw):
    """把玩家提交的单个状态收敛为公开、有限且可安全广播的数据。"""
    if not isinstance(raw, dict):
        return None
    raw_key = str(raw.get('key') or 'custom').strip()
    key = raw_key if CONDITION_KEY_RE.fullmatch(raw_key) else 'custom'
    meta = CONDITION_META.get(key)
    if meta:
        label, icon, color = meta
    else:
        key = 'custom'
        label = str(raw.get('label') or '').strip()[:24]
        icon = str(raw.get('icon') or '◆').strip()[:4] or '◆'
        raw_color = str(raw.get('color') or '').strip()
        color = raw_color if CONDITION_COLOR_RE.fullmatch(raw_color) else '#a8b3c7'
    if not label:
        return None
    condition_id = str(raw.get('id') or '').strip()
    if not CONDITION_ID_RE.fullmatch(condition_id):
        condition_id = 'cond-' + secrets.token_hex(8)
    raw_turns = raw.get('remainingTurns')
    turns_number = None if raw_turns in (None, '') else finite_number(raw_turns)
    remaining_turns = None
    if turns_number is not None and turns_number > 0:
        remaining_turns = max(1, min(999, int(turns_number)))
    return {
        'id': condition_id,
        'key': key,
        'label': label,
        'icon': icon,
        'color': color,
        'remainingTurns': remaining_turns,
        'visibility': 'public',
    }


def normalize_public_conditions(raw):
    """校验玩家状态数组；非数组拒绝，非法条目过滤，最多保留 20 项。"""
    if not isinstance(raw, list):
        return None
    result = []
    seen_ids = set()
    for item in raw[:MAX_TOKEN_CONDITIONS]:
        condition = normalize_public_condition(item)
        if not condition:
            continue
        if condition['id'] in seen_ids:
            condition['id'] = 'cond-' + secrets.token_hex(8)
        seen_ids.add(condition['id'])
        result.append(condition)
    return result


def normalize_roll_action(action, name):
    if not isinstance(action, dict):
        return None
    sides = finite_int(action.get('sides'), 2, 1000, 20)
    raw_dice = action.get('dice')
    if not isinstance(raw_dice, list):
        raw_dice = []
    dice = [finite_int(value, 1, sides, 1) for value in raw_dice[:100]]
    mode = finite_int(action.get('mode'), -1, 1, 0)
    if mode not in (-1, 1) or len(dice) != 2:
        mode = 0
    pick = finite_int(action.get('pick'), 0, 1, 0) if mode else None
    natural = None
    critical = None
    if sides == 20 and ((mode and len(dice) == 2) or (not mode and len(dice) == 1)):
        natural = dice[pick] if mode else dice[0]
        critical = 'success' if natural == 20 else ('fail' if natural == 1 else None)
    skin = str(action.get('skin') or '').strip().lower()
    if skin not in DICE_SKIN_KEYS:
        skin = 'obsidian'
    return {
        'op': 'roll',
        'name': str(name or '玩家')[:24],
        'rid': str(action.get('rid') or '')[:96],
        'expr': str(action.get('expr') or '')[:40],
        'detail': str(action.get('detail') or '')[:600],
        'total': finite_int(action.get('total'), -99999, 99999, 0),
        'sides': sides,
        'dice': dice,
        'pick': pick,
        'mode': mode,
        'natural': natural,
        'critical': critical,
        'skin': skin,
        'visibility': 'public',
    }


def normalize_rest_transition_action(action):
    """校验主控台发出的瞬时休息表现；它不进入持久状态或动作历史。"""
    if not isinstance(action, dict):
        return None
    kind = str(action.get('kind') or '').strip().lower()
    rest_id = str(action.get('restId') or '').strip()
    if kind not in REST_TRANSITION_DURATIONS or not REACTION_ID_RE.fullmatch(rest_id):
        return None
    scene = str(action.get('scene') or REST_TRANSITION_DEFAULT_SCENES[kind]).strip().lower()
    if REST_TRANSITION_SCENES.get(scene) != kind:
        return None
    duration = finite_int(
        action.get('duration'),
        1000,
        8000,
        REST_TRANSITION_DURATIONS[kind],
    )
    return {
        'op': 'restTransition',
        'restId': rest_id,
        'kind': kind,
        'scene': scene,
        'duration': duration,
        'startedAt': int(time.time() * 1000),
        'name': 'GM',
    }


def asset_file(key):
    if not re.fullmatch(r'[0-9a-f]{64}', str(key or '')):
        return None
    return os.path.join(ASSET_ROOT, key)


def persist_asset(key, mime, raw):
    """把资源原子写入磁盘缓存；失败时仍允许本次联机使用内存缓存。"""
    path = asset_file(key)
    if not path:
        return
    try:
        os.makedirs(ASSET_ROOT, exist_ok=True)
        if not os.path.isfile(path):
            temp_path = path + '.tmp'
            with open(temp_path, 'wb') as f:
                f.write(raw)
                f.flush()
            os.replace(temp_path, path)
        with open(path + '.json', 'w', encoding='utf-8') as f:
            json.dump({'mime': mime, 'size': len(raw)}, f, ensure_ascii=False)
    except OSError:
        try:
            if os.path.isfile(path + '.tmp'):
                os.remove(path + '.tmp')
        except OSError:
            pass


def load_disk_asset(key):
    path = asset_file(key)
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, 'rb') as f:
            raw = f.read()
        mime = 'application/octet-stream'
        meta_path = path + '.json'
        if os.path.isfile(meta_path):
            with open(meta_path, 'r', encoding='utf-8') as f:
                mime = str((json.load(f) or {}).get('mime') or mime)
        return mime, raw
    except (OSError, ValueError, TypeError):
        return None


def cache_data_url(value):
    """把 data URL 放入可持久化的资源缓存，返回同源资源地址。"""
    if not isinstance(value, str):
        return value
    m = DATA_URL_RE.match(value)
    if not m:
        return value
    mime = m.group(1) or 'application/octet-stream'
    try:
        raw = base64.b64decode(m.group(3), validate=False) if m.group(2) else unquote_to_bytes(m.group(3))
    except Exception:
        return value
    if not raw:
        return value
    key = hashlib.sha256(raw).hexdigest()
    ASSETS[key] = (mime, raw)
    persist_asset(key, mime, raw)
    return '/api/assets/' + key


def cache_player_portrait(value):
    """校验玩家临时棋子图片并写入同源缓存，避免任意大文件进入房间状态。"""
    if value in (None, ''):
        return None, None, 200
    if not isinstance(value, str):
        return None, '棋子图片格式无效', 400
    match = DATA_URL_RE.match(value)
    mime = str(match.group(1) or '').lower() if match else ''
    if not match or not match.group(2) or mime not in PLAYER_PORTRAIT_MIMES:
        return None, '棋子图片仅支持 PNG、JPG 或 WebP', 400
    try:
        raw = base64.b64decode(match.group(3), validate=True)
    except Exception:
        return None, '棋子图片数据损坏', 400
    if not raw:
        return None, '棋子图片为空', 400
    if len(raw) > MAX_PLAYER_PORTRAIT_BYTES:
        return None, '棋子图片过大，请重新选择', 413
    valid_signature = (
        (mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n'))
        or (mime == 'image/jpeg' and raw.startswith(b'\xff\xd8\xff'))
        or (mime == 'image/webp' and len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP')
    )
    if not valid_signature:
        return None, '棋子图片内容与格式不匹配', 400
    key = hashlib.sha256(raw).hexdigest()
    ASSETS[key] = (mime, raw)
    persist_asset(key, mime, raw)
    return '/api/assets/' + key, None, 200


def campaign_cover_path(state):
    """只从当前战役自己的存档根目录解析封面，不对玩家开放存档路径。"""
    if not isinstance(state, dict):
        return None
    campaign_id = str(state.get('campaignId') or '').strip()
    campaign_name = str(state.get('campaignName') or '').strip()
    folder_name = ''
    cover_name = ''
    try:
        index_path = os.path.join(LOCAL_SAVE_ROOT, '存档索引.json')
        with open(index_path, 'r', encoding='utf-8') as handle:
            entries = (json.load(handle) or {}).get('campaigns') or []
        match = next((item for item in entries if isinstance(item, dict) and campaign_id and str(item.get('id') or '') == campaign_id), None)
        if match is None:
            match = next((item for item in entries if isinstance(item, dict) and campaign_name and str(item.get('name') or '') == campaign_name), None)
        if match:
            folder_name = str(match.get('folder') or '')
            cover_name = str(match.get('cover') or '')
    except (OSError, ValueError, TypeError):
        pass

    campaigns_root = os.path.abspath(os.path.join(LOCAL_SAVE_ROOT, '战役'))
    if not folder_name and campaign_id and os.path.isdir(campaigns_root):
        prefix = re.sub(r'[^\w\-]', '', campaign_id)[:80] + '-'
        try:
            folder_name = next((name for name in os.listdir(campaigns_root) if name.startswith(prefix)), '')
        except OSError:
            return None
    if not folder_name or '/' in folder_name or '\\' in folder_name or folder_name in ('.', '..'):
        return None
    campaign_root = os.path.abspath(os.path.join(campaigns_root, folder_name))
    if os.path.commonpath([campaigns_root, campaign_root]) != campaigns_root or os.path.islink(campaign_root):
        return None
    candidates = [cover_name] if cover_name in CAMPAIGN_COVER_FILES else []
    candidates.extend(name for name in CAMPAIGN_COVER_FILES if name not in candidates)
    for name in candidates:
        path = os.path.join(campaign_root, name)
        if os.path.isfile(path) and not os.path.islink(path):
            return path
    return None


def campaign_cover_asset_url(state):
    """把战役封面转为内容哈希资源，玩家只会拿到不可反查存档的 URL。"""
    path = campaign_cover_path(state)
    if not path:
        return ''
    try:
        stat = os.stat(path)
        if stat.st_size <= 0 or stat.st_size > MAX_CAMPAIGN_COVER_BYTES:
            return ''
        signature = (stat.st_mtime_ns, stat.st_size)
        cached = CAMPAIGN_COVER_ASSET_CACHE.get(path)
        if cached and cached[:2] == signature:
            return cached[2]
        with open(path, 'rb') as handle:
            raw = handle.read()
        extension = os.path.splitext(path)[1].lower()
        mime = 'image/png' if extension == '.png' else 'image/webp' if extension == '.webp' else 'image/jpeg'
        valid = (
            (mime == 'image/png' and raw.startswith(b'\x89PNG\r\n\x1a\n'))
            or (mime == 'image/jpeg' and raw.startswith(b'\xff\xd8\xff'))
            or (mime == 'image/webp' and len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP')
        )
        if not valid:
            return ''
        key = hashlib.sha256(raw).hexdigest()
        ASSETS[key] = (mime, raw)
        persist_asset(key, mime, raw)
        url = '/api/assets/' + key
        CAMPAIGN_COVER_ASSET_CACHE[path] = (signature[0], signature[1], url)
        return url
    except OSError:
        return ''


def _music_path_is_safe(root, path):
    """音乐库不能通过软链接或构造路径越过 ``asset/音乐``。"""
    root = os.path.abspath(root)
    path = os.path.abspath(path)
    try:
        return os.path.commonpath([root, path]) == root and not os.path.islink(path)
    except (OSError, ValueError):
        return False


def _walk_music_files(root, start):
    if not os.path.isdir(start) or not _music_path_is_safe(root, start):
        return
    for directory, subdirs, files in os.walk(start):
        subdirs[:] = [name for name in subdirs
                      if _music_path_is_safe(root, os.path.join(directory, name))]
        for name in files:
            path = os.path.join(directory, name)
            if (name.lower().endswith(MUSIC_EXTS)
                    and _music_path_is_safe(root, path)
                    and os.path.isfile(path)):
                yield path


def _safe_music_campaign_name(value):
    return re.sub(r'[\\/:*?"<>|]', '_', str(value or '')).strip()


def music_library_catalog(root=None, campaign_id='', campaign_name=''):
    """扫描项目曲库，返回公开目录与只在服务器内使用的 ID->路径索引。"""
    root = os.path.abspath(root or MUSIC_LIBRARY_ROOT)
    campaign_id = re.sub(r'[^\w\-]', '', str(campaign_id or ''))[:80]
    campaign_name = _safe_music_campaign_name(campaign_name)[:120]
    entries = []
    index = {}

    def add(path, scope, collection_root, default_category):
        if len(entries) >= MAX_MUSIC_LIBRARY_FILES:
            return
        if not _music_path_is_safe(root, path):
            return
        try:
            relative = os.path.relpath(path, root).replace(os.sep, '/')
            size = os.path.getsize(path)
        except OSError:
            return
        track_id = hashlib.sha256(relative.encode('utf-8')).hexdigest()[:32]
        category_relative = os.path.relpath(os.path.dirname(path), collection_root)
        category = default_category if category_relative == '.' else category_relative.replace(os.sep, ' / ')
        filename = os.path.basename(path)
        entries.append({
            'id': track_id,
            'title': os.path.splitext(filename)[0],
            'fileName': filename,
            'scope': scope,
            'collection': '当前战役' if scope == 'campaign' else '通用',
            'category': category,
            'size': size,
            'url': '/api/music-stream/' + track_id,
        })
        index[track_id] = path

    if os.path.isdir(root):
        # 根目录里的旧曲目继续作为通用音乐；其余通用分类可直接建子文件夹。
        try:
            for name in sorted(os.listdir(root)):
                path = os.path.join(root, name)
                if os.path.isfile(path) and name.lower().endswith(MUSIC_EXTS):
                    add(path, 'general', root, '通用')
                elif os.path.isdir(path) and name != '战役' and not os.path.islink(path):
                    for music_path in _walk_music_files(root, path):
                        add(music_path, 'general', root, '通用')
        except OSError:
            pass

    selected_campaign_folder = ''
    campaigns_root = os.path.join(root, '战役')
    if os.path.isdir(campaigns_root):
        try:
            folder_names = [name for name in os.listdir(campaigns_root)
                            if os.path.isdir(os.path.join(campaigns_root, name))
                            and not os.path.islink(os.path.join(campaigns_root, name))]
        except OSError:
            folder_names = []
        expected = ((campaign_id + '-' + campaign_name) if campaign_id and campaign_name else '')
        candidates = sorted(folder_names, key=lambda name: (
            0 if expected and name == expected else
            1 if campaign_id and name == campaign_id else
            2 if campaign_id and name.startswith(campaign_id + '-') else
            3 if campaign_name and name == campaign_name else 4,
            name,
        ))
        selected_campaign_folder = next((name for name in candidates if (
            (expected and name == expected)
            or (campaign_id and (name == campaign_id or name.startswith(campaign_id + '-')))
            or (campaign_name and name == campaign_name)
        )), '')
        if selected_campaign_folder:
            campaign_root = os.path.join(campaigns_root, selected_campaign_folder)
            for music_path in _walk_music_files(root, campaign_root):
                add(music_path, 'campaign', campaign_root, '未分类')

    entries.sort(key=lambda item: (
        0 if item['scope'] == 'campaign' else 1,
        item['category'].lower(), item['title'].lower(),
    ))
    return {
        'ok': True,
        'campaignId': campaign_id,
        'campaignName': campaign_name,
        'campaignFolder': selected_campaign_folder,
        'tracks': entries,
        '_index': index,
    }


def refresh_music_library(campaign_id='', campaign_name=''):
    catalog = music_library_catalog(MUSIC_LIBRARY_ROOT, campaign_id, campaign_name)
    index = catalog.pop('_index')
    with LOCK:
        MUSIC_LIBRARY_INDEX.clear()
        MUSIC_LIBRARY_INDEX.update(index)
    return catalog


def parse_http_byte_range(header, size):
    """把单段 HTTP Range 转成闭区间；无 Range 返回 None，坏 Range 抛 ValueError。"""
    if not header:
        return None
    value = str(header).strip()
    if not value.startswith('bytes=') or ',' in value:
        raise ValueError('unsupported range')
    spec = value[6:].strip()
    if '-' not in spec or size <= 0:
        raise ValueError('bad range')
    start_raw, end_raw = spec.split('-', 1)
    try:
        if not start_raw:
            suffix = int(end_raw)
            if suffix <= 0:
                raise ValueError('bad suffix')
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_raw)
            end = int(end_raw) if end_raw else size - 1
            if start < 0 or start >= size or end < start:
                raise ValueError('bad bounds')
            end = min(end, size - 1)
    except (TypeError, ValueError, OverflowError):
        raise ValueError('bad range')
    return start, end


def normalize_bgm_action(action, now=None):
    source = action if isinstance(action, dict) else {}
    command = str(source.get('action') or '').strip().lower()
    if command not in ('play', 'pause', 'stop'):
        return None
    mode = str(source.get('mode') or 'library').strip().lower()
    if mode not in ('library', 'upload', 'live'):
        mode = 'library'
    position = finite_number(source.get('time'))
    position = max(0.0, min(86400.0, position if position is not None else 0.0))
    if command == 'stop':
        position = 0.0
    return {
        'op': 'bgm',
        'action': command,
        'mode': mode,
        'trackId': str(source.get('trackId') or '')[:64],
        'track': str(source.get('track') or '')[:120],
        'url': str(source.get('url') or '').strip()[:2048],
        'time': round(position, 3),
        'loop': bool(source.get('loop')),
        'issuedAt': int(now if now is not None else time.time() * 1000),
    }


def normalize_webrtc_signal(raw):
    source = raw if isinstance(raw, dict) else {}
    signal_type = str(source.get('type') or '').strip().lower()
    if signal_type not in WEBRTC_SIGNAL_TYPES:
        return None
    if signal_type in ('offer', 'answer'):
        sdp = str(source.get('sdp') or '')
        if not sdp or len(sdp) > 128 * 1024:
            return None
        return {'type': signal_type, 'sdp': sdp}
    if signal_type == 'ice':
        candidate = str(source.get('candidate') or '')[:8192]
        if not candidate:
            return None
        result = {'type': 'ice', 'candidate': candidate}
        if source.get('sdpMid') is not None:
            result['sdpMid'] = str(source.get('sdpMid'))[:128]
        line_index = finite_int(source.get('sdpMLineIndex'), 0, 1024, None)
        if line_index is not None:
            result['sdpMLineIndex'] = line_index
        return result
    return {'type': signal_type}


def cache_stream_media(state):
    """就地压缩公开状态中的地图与头像；调用方须持有 LOCK。"""
    for m in (state or {}).get('maps', []) or []:
        if isinstance(m, dict):
            m['mapData'] = cache_data_url(m.get('mapData'))
            for t in m.get('tokens', []) or []:
                if not isinstance(t, dict):
                    continue
                t['iconImg'] = cache_data_url(t.get('iconImg'))
                t['iconImgHd'] = cache_data_url(t.get('iconImgHd'))
    if isinstance(state, dict):
        state['_campaignCoverUrl'] = campaign_cover_asset_url(state)
    return state


def clean_music_cache(d):
    try:
        files = []
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if os.path.isfile(p):
                files.append((os.path.getmtime(p), p))
        if len(files) > 50:
            files.sort()
            for _, p in files[:len(files) - 50]:
                try:
                    os.remove(p)
                except Exception:
                    pass
    except Exception:
        pass


def find_token(state, token_id):
    """在全部地图里找棋子，返回 (map, token) 或 (None, None)。"""
    for m in (state or {}).get('maps', []) or []:
        for t in m.get('tokens', []) or []:
            if t.get('id') == token_id:
                return m, t
    return None, None


def find_map(state, map_id):
    """按公开地图 ID 查找地图。"""
    for map_obj in (state or {}).get('maps', []) or []:
        if isinstance(map_obj, dict) and map_obj.get('id') == map_id:
            return map_obj
    return None


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def weather_day_index(total_seconds):
    total = max(0, int(finite_number(total_seconds) or 0))
    return int(math.floor((total - WEATHER_ROLLOVER_SECONDS) / float(WORLD_SECONDS_PER_DAY)))


def weather_season(total_seconds):
    total = max(0, int(finite_number(total_seconds) or 0))
    day_index = total // WORLD_SECONDS_PER_DAY
    day_of_year = day_index % (WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR)
    week = day_of_year // WORLD_DAYS_PER_WEEK + 1
    if week <= 13:
        return 'spring'
    if week <= 26:
        return 'summer'
    if week <= 39:
        return 'autumn'
    return 'winter'


def normalize_weather(raw, total_seconds=None):
    source = raw if isinstance(raw, dict) else {}
    climate = source.get('climate') if source.get('climate') in CLIMATE_PROFILES else 'temperate'
    condition = source.get('condition') if source.get('condition') in WEATHER_KEYS else 'clear'
    wind = source.get('wind') if source.get('wind') in WIND_KEYS else 'breeze'
    temperature = finite_number(source.get('temperature'))
    temperature = max(-100, min(100, int(round(temperature if temperature is not None else 18))))
    generated_day = finite_number(source.get('generatedDay'))
    if generated_day is None:
        generated_day = weather_day_index(total_seconds if total_seconds is not None else WEATHER_ROLLOVER_SECONDS)
    return {
        'climate': climate,
        'condition': condition,
        'temperature': temperature,
        'wind': wind,
        'generatedDay': int(generated_day),
    }


def weighted_weather_choice(weights, random_fn=random.random):
    options = [(key, float(weights.get(key, 0))) for key in weights if float(weights.get(key, 0)) > 0]
    total = sum(weight for _, weight in options)
    if not options or total <= 0:
        return None
    sample = finite_number(random_fn())
    sample = max(0.0, min(0.999999999999, sample if sample is not None else 0.0))
    cursor = sample * total
    for key, weight in options:
        cursor -= weight
        if cursor < 0:
            return key
    return options[-1][0]


def climate_weather_weights(profile, season, previous_condition):
    base = {}
    for condition in profile.get('weather', {}).get(season, profile.get('weather', {}).get('spring', [])):
        if condition in WEATHER_KEYS:
            base[condition] = base.get(condition, 0) + 1
    transition = WEATHER_MARKOV_TRANSITIONS.get(previous_condition, WEATHER_MARKOV_TRANSITIONS['clear'])
    return dict((condition, weight * float(transition.get(condition, .01)))
                for condition, weight in base.items())


def weather_wind_weights(condition, previous_wind):
    weather_weights = WEATHER_WIND_WEIGHTS.get(condition, WEATHER_WIND_WEIGHTS['clear'])
    transition = WIND_MARKOV_TRANSITIONS.get(previous_wind, WIND_MARKOV_TRANSITIONS['breeze'])
    return dict((wind, float(weather_weights.get(wind, .01)) * float(transition.get(wind, .01)))
                for wind in WIND_KEYS)


def generate_climate_weather(encounter, climate_key=None, total_seconds=None,
                             random_fn=random.random, generated_day=None):
    """运行一次天气马尔可夫转移；温度保留昨日惯性，风力也按独立链转移。"""
    world = encounter.get('worldTime') if isinstance(encounter.get('worldTime'), dict) else {}
    if total_seconds is None:
        total_seconds = max(0, int(finite_number(world.get('totalSeconds')) or 0))
    previous = normalize_weather(encounter.get('weather'), total_seconds)
    climate = climate_key if climate_key in CLIMATE_PROFILES else previous['climate']
    profile = CLIMATE_PROFILES[climate]
    season = weather_season(total_seconds)
    condition = weighted_weather_choice(
        climate_weather_weights(profile, season, previous['condition']), random_fn
    ) or 'clear'
    expected = profile['temperatures'][season] + WEATHER_TEMPERATURE_DELTAS[condition]
    noise = (max(0.0, min(1.0, finite_number(random_fn()) or 0.0)) * 4) - 2
    temperature = max(-100, min(100, int(round(expected * .65 + previous['temperature'] * .35 + noise))))
    wind = weighted_weather_choice(weather_wind_weights(condition, previous['wind']), random_fn) or 'breeze'
    day = int(generated_day) if generated_day is not None else weather_day_index(total_seconds)
    encounter['weather'] = {
        'climate': climate,
        'condition': condition,
        'temperature': temperature,
        'wind': wind,
        'generatedDay': day,
    }
    return encounter['weather']


def refresh_scheduled_weather(encounter, total_seconds, random_fn=random.random):
    """跨过每日 08:00 时逐日推演，超长时间跳跃最多补算十年。"""
    encounter['weather'] = normalize_weather(encounter.get('weather'), total_seconds)
    current_day = weather_day_index(total_seconds)
    generated_day = encounter['weather']['generatedDay']
    if current_day < generated_day:
        encounter['weather']['generatedDay'] = current_day
        return None
    if current_day == generated_day:
        return None
    missing_days = current_day - generated_day
    first_day = (current_day - MAX_WEATHER_CATCHUP_DAYS + 1
                 if missing_days > MAX_WEATHER_CATCHUP_DAYS else generated_day + 1)
    for day in range(first_day, current_day + 1):
        rollover_seconds = max(0, day * WORLD_SECONDS_PER_DAY + WEATHER_ROLLOVER_SECONDS)
        generate_climate_weather(
            encounter,
            encounter['weather']['climate'],
            rollover_seconds,
            random_fn,
            day,
        )
    return encounter['weather']


def normalize_map_reaction(state, action, name):
    if not isinstance(action, dict):
        return None
    map_obj = find_map(state, action.get('mapId'))
    emoji = str(action.get('emoji') or '')
    reaction_id = str(action.get('reactionId') or '').strip()
    x = finite_number(action.get('x'))
    y = finite_number(action.get('y'))
    map_w = finite_number((map_obj or {}).get('mapW'))
    map_h = finite_number((map_obj or {}).get('mapH'))
    if not map_obj or emoji not in MAP_REACTION_EMOJIS or not REACTION_ID_RE.fullmatch(reaction_id):
        return None
    if x is None or y is None or map_w is None or map_h is None or x < 0 or y < 0 or x > map_w or y > map_h:
        return None
    return {
        'op': 'mapReaction',
        'reactionId': reaction_id,
        'mapId': map_obj.get('id'),
        'x': round(x, 3),
        'y': round(y, 3),
        'emoji': emoji,
        'name': str(name or '玩家')[:24],
    }


def token_control_group(state, token):
    """返回棋子、坐骑和坐骑上骑手组成的控制组 ID。"""
    if not isinstance(token, dict) or not token.get('id'):
        return set()
    ids = {token.get('id')}
    mount_id = token.get('mountId')
    if mount_id:
        ids.add(mount_id)
    changed = True
    while changed:
        changed = False
        for m in (state or {}).get('maps', []) or []:
            for rider in m.get('tokens', []) or []:
                if rider.get('mountId') in ids and rider.get('id') not in ids:
                    ids.add(rider.get('id'))
                    changed = True
    return ids


def can_control(state, token, player):
    """玩家控制自己的棋子；无主大型坐骑可由其名下骑手共同控制。"""
    player = (player or '').strip()
    if not player or not isinstance(token, dict):
        return False
    direct_owner = str(token.get('owner') or '').strip()
    if direct_owner:
        return direct_owner == player
    if (finite_number(token.get('size')) or 1) < 2 or not token.get('id'):
        return False
    for m in (state or {}).get('maps', []) or []:
        for candidate in m.get('tokens', []) or []:
            if candidate.get('mountId') == token.get('id') and (candidate.get('owner') or '').strip() == player:
                return True
    return False


def turn_controllers(state, current_token):
    """当前先攻棋子有明确归属时只认该玩家；无归属时再继承骑乘控制组的归属。"""
    if not isinstance(current_token, dict):
        return set()
    direct_owner = str(current_token.get('owner') or '').strip()
    if direct_owner:
        return {direct_owner}
    group = token_control_group(state, current_token)
    owners = set()
    for map_obj in (state or {}).get('maps', []) or []:
        for candidate in map_obj.get('tokens', []) or []:
            owner = str(candidate.get('owner') or '').strip()
            if candidate.get('id') in group and owner:
                owners.add(owner)
    return owners


def initiative_entry(encounter, entry_id):
    for entry in encounter.get('entries', []) or []:
        if isinstance(entry, dict) and entry.get('id') == entry_id:
            return entry
    return None


def initiative_entry_token(state, entry):
    token_id = entry.get('tokenId') if isinstance(entry, dict) else None
    return find_token(state, token_id)[1] if token_id else None


def initiative_sort_key(entry):
    value = finite_number(entry.get('value')) if isinstance(entry, dict) else None
    order = finite_number(entry.get('order')) if isinstance(entry, dict) else None
    return (-(int(value) if value is not None else 0), order if order is not None else 0)


def sort_initiative_entries(encounter):
    entries = encounter.get('entries')
    if not isinstance(entries, list):
        encounter['entries'] = []
        return
    entries.sort(key=initiative_sort_key)


def mounted_group_parts(state, token):
    """返回棋子所在骑乘组的坐骑与骑手；未骑乘时返回空组。"""
    if not isinstance(token, dict) or not token.get('id'):
        return None, []
    map_obj, located = find_token(state, token.get('id'))
    if not map_obj or not located:
        return None, []
    tokens = map_obj.get('tokens', []) or []
    mount = None
    mount_id = located.get('mountId')
    if mount_id:
        mount = next((item for item in tokens if isinstance(item, dict) and item.get('id') == mount_id), None)
    elif any(isinstance(item, dict) and item.get('mountId') == located.get('id') for item in tokens):
        mount = located
    if not mount:
        return None, []
    riders = [item for item in tokens
              if isinstance(item, dict) and item.get('mountId') == mount.get('id')]
    return mount, riders


def initiative_group_label(state, token):
    """生成与主控台一致的骑手 · 坐骑先攻名称。"""
    if not isinstance(token, dict):
        return '未命名单位'
    mount, riders = mounted_group_parts(state, token)
    if not mount or not riders:
        return str(token.get('name') or '未命名单位')[:48]
    lead = token if token.get('id') != mount.get('id') else riders[0]
    lead_name = str(lead.get('name') or '骑手')
    rider_label = '%s 等 %d 人' % (lead_name, len(riders)) if len(riders) > 1 else lead_name
    return ('%s · %s' % (rider_label, str(mount.get('name') or '坐骑')))[:48]


def reconcile_mounted_initiative_entries(state):
    """骑乘关系变化后合并同组先攻项，并保留当前项与玩家归属。"""
    encounter = encounter_state(state)
    entries = encounter.get('entries') if isinstance(encounter.get('entries'), list) else []
    normalized = []
    changed = False
    for entry in entries:
        token = initiative_entry_token(state, entry)
        if not isinstance(entry, dict) or not token:
            normalized.append(entry)
            continue
        label = initiative_group_label(state, token)
        color = TOKEN_RING_COLORS.get(token.get('type'), TOKEN_RING_COLORS['npc'])
        if entry.get('name') != label or entry.get('color') != color:
            changed = True
        entry['name'] = label
        entry['color'] = color
        group_ids = token_control_group(state, token)
        duplicate_index = next((index for index, candidate in enumerate(normalized)
                                if initiative_entry_token(state, candidate)
                                and initiative_entry_token(state, candidate).get('id') in group_ids), -1)
        if duplicate_index < 0:
            normalized.append(entry)
            continue
        previous = normalized[duplicate_index]
        keep_current = entry.get('id') == encounter.get('currentEntryId') and previous.get('id') != encounter.get('currentEntryId')
        keeper = entry if keep_current else previous
        discarded = previous if keep_current else entry
        keeper_token = initiative_entry_token(state, keeper)
        discarded_token = initiative_entry_token(state, discarded)
        if (not keeper_token or not str(keeper_token.get('owner') or '').strip()) and discarded_token and str(discarded_token.get('owner') or '').strip():
            keeper['tokenId'] = discarded_token.get('id')
        final_token = initiative_entry_token(state, keeper)
        if final_token:
            keeper['name'] = initiative_group_label(state, final_token)
            keeper['color'] = TOKEN_RING_COLORS.get(final_token.get('type'), TOKEN_RING_COLORS['npc'])
        normalized[duplicate_index] = keeper
        if encounter.get('currentEntryId') == discarded.get('id'):
            encounter['currentEntryId'] = keeper.get('id')
        changed = True
    encounter['entries'] = normalized
    sort_initiative_entries(encounter)
    entry_ids = {entry.get('id') for entry in normalized if isinstance(entry, dict)}
    if encounter.get('playMode') == 'turn' and encounter.get('currentEntryId') not in entry_ids:
        encounter['currentEntryId'] = normalized[0].get('id') if normalized and isinstance(normalized[0], dict) else None
        changed = True
    elif encounter.get('playMode') != 'turn' and encounter.get('currentEntryId') is not None:
        encounter['currentEntryId'] = None
        changed = True
    return changed


def initiative_effective_order(encounter, entry):
    """为旧存档中缺失或重复的 order 提供稳定、可验证的当前位置。"""
    entries = encounter.get('entries', []) or []
    try:
        index = entries.index(entry)
    except ValueError:
        return 0
    raw = finite_number(entry.get('order')) if isinstance(entry, dict) else None
    if raw is None:
        return index
    duplicates = sum(1 for item in entries
                     if isinstance(item, dict) and finite_number(item.get('order')) == raw)
    return index if duplicates > 1 else raw


def normalize_player_initiative_action(state, requested, player):
    """把玩家的准备阶段请求转换成可重放、幂等的标准动作。"""
    encounter = encounter_state(state)
    if encounter.get('playMode') != 'prepare':
        return None, '只能在战斗准备阶段调整先攻', 409
    requested_serial = finite_number(requested.get('turnSerial'))
    current_serial = encounter_turn_serial(state)
    if requested_serial is None or int(requested_serial) != current_serial:
        return None, '先攻顺序已经变化，请重新操作', 409
    entry_id = str(requested.get('entryId') or '').strip()
    source = initiative_entry(encounter, entry_id)
    source_token = initiative_entry_token(state, source)
    if not source or not source_token:
        return None, '先攻项没有关联可操作的棋子', 404
    if not can_control(state, source_token, player):
        return None, '只能调整自己角色的先攻', 403
    next_serial = current_serial + 1
    current_value = int(finite_number(source.get('value')) or 0)
    source_order = initiative_effective_order(encounter, source)
    op = requested.get('op')
    if op == 'initiativeSwap':
        target_id = str(requested.get('targetEntryId') or '').strip()
        target = initiative_entry(encounter, target_id)
        target_token = initiative_entry_token(state, target)
        if not target or not target_token:
            return None, '目标先攻项不存在', 404
        entries = encounter.get('entries', []) or []
        source_index = next((index for index, item in enumerate(entries) if item is source), -1)
        target_index = next((index for index, item in enumerate(entries) if item is target), -1)
        target_value = int(finite_number(target.get('value')) or 0)
        if abs(source_index - target_index) != 1 or target_value != current_value:
            return None, '只能与相邻且先攻相同的玩家角色换位', 400
        if not turn_controllers(state, target_token):
            return None, '只能与另一名玩家角色换位', 403
        target_order = initiative_effective_order(encounter, target)
        return {
            'op': 'initiativeSwap',
            'name': str(player or '玩家')[:24],
            'actor': str(player or '')[:24],
            'entryId': entry_id,
            'targetEntryId': target_id,
            'value': current_value,
            'previousEntryOrder': source_order,
            'previousTargetOrder': target_order,
            'entryOrder': target_order,
            'targetOrder': source_order,
            'turnSerial': current_serial,
            'nextTurnSerial': next_serial,
        }, None, 200
    return None, '不支持的先攻操作', 400


def movement_anchor(m, token):
    """骑手发起移动时，实际移动并广播其可见坐骑。"""
    if not isinstance(m, dict) or not isinstance(token, dict):
        return token
    mount_id = token.get('mountId')
    if not mount_id:
        return token
    for candidate in m.get('tokens', []) or []:
        if candidate.get('id') == mount_id and (finite_number(candidate.get('size')) or 1) >= 2:
            return candidate
    return token


def encounter_state(state):
    encounter = (state or {}).get('encounter')
    if isinstance(encounter, dict):
        if encounter.get('playMode') == 'turn' and not (encounter.get('entries') or []):
            encounter['playMode'] = 'prepare'
            encounter['currentEntryId'] = None
            encounter['round'] = 1
            encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
        return encounter
    if isinstance(state, dict):
        state['encounter'] = {}
        return state['encounter']
    return {}


def encounter_turn_serial(state):
    value = finite_number(encounter_state(state).get('turnSerial', 1))
    return max(1, int(value)) if value is not None else 1


def action_play_mode(action):
    """旧客户端未发送 playMode 时，用 turnSerial 区分回合动作与自由动作。"""
    raw_mode = action.get('playMode') if isinstance(action, dict) else None
    if raw_mode in ('free', 'turn'):
        return raw_mode
    return 'turn' if finite_number((action or {}).get('turnSerial')) is not None else 'free'


def current_turn_token_id(state):
    encounter = encounter_state(state)
    current_id = encounter.get('currentEntryId')
    for entry in encounter.get('entries', []) or []:
        if isinstance(entry, dict) and entry.get('id') == current_id:
            token_id = entry.get('tokenId')
            return token_id if token_id else None
    return None


def can_act_with_token(state, token, player, action):
    """判断玩家能否操控棋子；回合制同时校验当前先攻和回合版本。"""
    encounter = encounter_state(state)
    current_mode = 'turn' if encounter.get('playMode') == 'turn' else 'free'
    recorded_mode = action_play_mode(action)
    if recorded_mode != current_mode:
        return False, '回合已经变化，请重新操作'
    action['playMode'] = recorded_mode
    if not can_control(state, token, player):
        return False, '只能操作自己名下的棋子'
    if current_mode != 'turn':
        return True, None
    current_token_id = current_turn_token_id(state)
    if not current_token_id:
        return False, '当前先攻尚未关联棋子，暂时不能操作'
    if current_token_id not in token_control_group(state, token):
        return False, '尚未轮到这个角色'
    current_token = find_token(state, current_token_id)[1]
    if str(player or '').strip() not in turn_controllers(state, current_token):
        return False, '尚未轮到你的角色'
    requested_serial = finite_number(action.get('turnSerial'))
    if requested_serial is None or int(requested_serial) != encounter_turn_serial(state):
        return False, '回合已经变化，请重新操作'
    return True, None


def decrement_current_token_conditions(state):
    """离开当前回合时，骑手、坐骑和同乘者各自递减一次有期限状态。"""
    token_id = current_turn_token_id(state)
    token = find_token(state, token_id)[1] if token_id else None
    if not token:
        return False
    changed = False
    group_ids = token_control_group(state, token)
    for map_obj in (state or {}).get('maps', []) or []:
        for member in map_obj.get('tokens', []) or []:
            if member.get('id') not in group_ids or not isinstance(member.get('conditions'), list):
                continue
            member_changed = False
            next_conditions = []
            for condition in member.get('conditions') or []:
                if not isinstance(condition, dict):
                    next_conditions.append(condition)
                    continue
                raw_remaining = condition.get('remainingTurns')
                remaining_number = finite_number(raw_remaining)
                if raw_remaining is None or remaining_number is None or remaining_number <= 0:
                    next_conditions.append(condition)
                    continue
                remaining = max(0, int(remaining_number) - 1)
                member_changed = True
                if remaining:
                    updated = dict(condition)
                    updated['remainingTurns'] = remaining
                    next_conditions.append(updated)
            if member_changed:
                member['conditions'] = next_conditions
                changed = True
    return changed


def token_limits(m, token):
    grid = finite_number(m.get('gridSize', 50)) or 50
    grid = max(1, grid)
    map_w = max(0, finite_number(m.get('mapW', 0)) or 0)
    map_h = max(0, finite_number(m.get('mapH', 0)) or 0)
    size = finite_number(token.get('size', 1)) or 1
    margin = grid if size >= 2 else grid / 2
    return map_w, map_h, min(margin, map_w / 2), min(margin, map_h / 2)


def clamp_token_point(m, token, point):
    x = finite_number(point.get('x'))
    y = finite_number(point.get('y'))
    if x is None or y is None:
        return None
    map_w, map_h, margin_x, margin_y = token_limits(m, token)
    return {
        'x': max(margin_x, min(map_w - margin_x, x)),
        'y': max(margin_y, min(map_h - margin_y, y)),
    }


def normalize_player_spawn_action(state, requested, player, player_id=''):
    """把玩家临时棋子请求收敛为只属于自己的安全棋子。"""
    if not isinstance(requested, dict) or requested.get('op') != PLAYER_SPAWN_ACTION:
        return None, '临时棋子数据无效', 400
    map_obj = find_map(state, requested.get('mapId'))
    if not map_obj:
        return None, '当前地图不存在', 404
    actor = str(player or '').strip()[:24]
    if not actor:
        return None, '缺少玩家名', 400
    tokens = map_obj.get('tokens') if isinstance(map_obj.get('tokens'), list) else []
    owned_temp_count = sum(
        1 for token in tokens
        if isinstance(token, dict) and token.get('playerCreated') is True
        and str(token.get('owner') or '').strip() == actor
    )
    if owned_temp_count >= MAX_PLAYER_TEMP_TOKENS_PER_MAP:
        return None, '每位玩家每张地图最多放置 12 个临时棋子', 409
    draft = requested.get('draft')
    if not isinstance(draft, dict):
        return None, '临时棋子数据无效', 400
    name = re.sub(r'[\x00-\x1f\x7f]+', '', str(draft.get('name') or '')).strip()[:24]
    if not name:
        name = (actor + '的临时棋子')[:24]
    icon = re.sub(r'[\x00-\x1f\x7f]+', '', str(draft.get('icon') or '')).strip()[:4] or '🧙'
    size = 2 if finite_int(draft.get('size'), 1, 2, 1) == 2 else 1
    hp_max = finite_int(draft.get('hpMax'), 1, 99999, 10)
    ac = finite_int(draft.get('ac'), 0, 99, 10)
    icon_img, image_error, image_status = cache_player_portrait(draft.get('iconImg'))
    if image_error:
        return None, image_error, image_status
    token = {
        'id': 'pt-' + re.sub(r'[^A-Za-z0-9_-]', '', str(player_id or 'player'))[:24] + '-' + secrets.token_hex(6),
        'name': name,
        'type': 'pc',
        'icon': icon,
        'iconImg': icon_img,
        'iconImgHd': None,
        'iconImgPath': None,
        'iconImgId': None,
        'size': size,
        'hp': hp_max,
        'hpMax': hp_max,
        'ac': ac,
        'spellRange': normalize_spell_range(None),
        'conditions': [],
        'publicNote': '',
        'gmNote': '',
        'hiddenFromPlayers': False,
        'owner': actor,
        'mountId': None,
        'groupKey': None,
        'playerCreated': True,
        'createdByPlayer': actor,
    }
    point = clamp_token_point(map_obj, token, {'x': requested.get('x'), 'y': requested.get('y')})
    if point is None:
        return None, '放置位置无效', 400
    token.update(point)
    return {
        'op': PLAYER_SPAWN_ACTION,
        'mapId': map_obj.get('id'),
        'tokenId': token['id'],
        'token': token,
        'name': actor,
        'actor': actor,
    }, None, 200


def normalize_player_delete_action(state, requested, player):
    """只允许玩家删除自己创建、且仍归属于自己的临时棋子。"""
    if not isinstance(requested, dict) or requested.get('op') != PLAYER_DELETE_ACTION:
        return None, '删除请求无效', 400
    map_obj, token = find_token(state, requested.get('tokenId'))
    if not map_obj or not token:
        return None, '棋子不存在', 404
    requested_map_id = requested.get('mapId')
    if requested_map_id is not None and requested_map_id != map_obj.get('id'):
        return None, '地图与棋子不匹配', 400
    actor = str(player or '').strip()[:24]
    owner = str(token.get('owner') or '').strip()
    if not actor or token.get('playerCreated') is not True or owner != actor:
        return None, '只能删除自己创建的临时棋子', 403
    return {
        'op': PLAYER_DELETE_ACTION,
        'mapId': map_obj.get('id'),
        'tokenId': token.get('id'),
        'tokenName': str(token.get('name') or '临时棋子')[:24],
        'name': actor,
        'actor': actor,
    }, None, 200


def normalize_player_mount_action(state, requested, player):
    """只允许玩家让自己的 1x1 棋子骑上当前地图内可用的大型坐骑。"""
    if not isinstance(requested, dict) or requested.get('op') != PLAYER_MOUNT_ACTION:
        return None, '上骑请求无效', 400
    map_obj, rider = find_token(state, requested.get('tokenId'))
    if not map_obj or not rider:
        return None, '骑手棋子不存在', 404
    requested_map_id = requested.get('mapId')
    if requested_map_id is not None and requested_map_id != map_obj.get('id'):
        return None, '地图与骑手不匹配', 400
    actor = str(player or '').strip()[:24]
    if not actor or str(rider.get('owner') or '').strip() != actor:
        return None, '只能让自己的角色上骑', 403
    if rider.get('hiddenFromPlayers') is True:
        return None, '这个角色当前不可见', 403
    if (finite_number(rider.get('size')) or 1) >= 2:
        return None, '只有 1x1 棋子可以骑乘', 409
    if rider.get('mountId'):
        return None, '这个角色已经在坐骑上', 409

    mount_map, mount = find_token(state, requested.get('mountId'))
    if not mount_map or not mount:
        return None, '目标坐骑不存在', 404
    if mount_map is not map_obj or mount.get('id') == rider.get('id'):
        return None, '骑手与坐骑必须在同一张地图', 400
    if mount.get('hiddenFromPlayers') is True:
        return None, '该坐骑当前不可见', 403
    if (finite_number(mount.get('size')) or 1) < 2:
        return None, '只能骑乘 2x2 及以上的大型棋子', 409
    mount_owner = str(mount.get('owner') or '').strip()
    if mount_owner and mount_owner != actor:
        return None, '不能骑乘其他玩家名下的坐骑', 403

    permission_action = dict(requested)
    allowed, reason = can_act_with_token(state, rider, actor, permission_action)
    if not allowed:
        return None, reason or '当前不能上骑', 409 if reason == '回合已经变化，请重新操作' else 403
    encounter = encounter_state(state)
    action = {
        'op': PLAYER_MOUNT_ACTION,
        'mapId': map_obj.get('id'),
        'tokenId': rider.get('id'),
        'mountId': mount.get('id'),
        'riderName': str(rider.get('name') or '骑手')[:24],
        'mountName': str(mount.get('name') or '坐骑')[:24],
        'playMode': permission_action.get('playMode', 'free'),
        'name': actor,
        'actor': actor,
    }
    if action['playMode'] == 'turn':
        action['turnSerial'] = encounter_turn_serial(state)
    return action, None, 200


def normalize_player_dismount_action(state, requested, player):
    """只允许玩家让自己名下、当前正在骑乘的骑手下马。"""
    if not isinstance(requested, dict) or requested.get('op') != PLAYER_DISMOUNT_ACTION:
        return None, '解除骑乘请求无效', 400
    map_obj, rider = find_token(state, requested.get('tokenId'))
    if not map_obj or not rider:
        return None, '骑手棋子不存在', 404
    requested_map_id = requested.get('mapId')
    if requested_map_id is not None and requested_map_id != map_obj.get('id'):
        return None, '地图与棋子不匹配', 400
    actor = str(player or '').strip()[:24]
    if not actor or str(rider.get('owner') or '').strip() != actor:
        return None, '只能解除自己角色的骑乘', 403
    mount_id = str(rider.get('mountId') or '').strip()
    mount_map, mount = find_token(state, mount_id)
    if not mount_id or not mount or mount_map is not map_obj:
        return None, '这个角色当前没有有效坐骑', 409

    permission_action = dict(requested)
    allowed, reason = can_act_with_token(state, rider, actor, permission_action)
    if not allowed:
        return None, reason or '当前不能解除骑乘', 409 if reason == '回合已经变化，请重新操作' else 403

    encounter = encounter_state(state)
    unique_mount_controller = turn_controllers(state, mount) == {actor}
    transferred_entry_ids = []
    if unique_mount_controller:
        transferred_entry_ids = [
            entry.get('id') for entry in encounter.get('entries', []) or []
            if isinstance(entry, dict) and entry.get('tokenId') == mount_id and entry.get('id')
        ]
    current_entry = initiative_entry(encounter, encounter.get('currentEntryId'))
    current_will_follow_rider = bool(
        current_entry and (
            current_entry.get('tokenId') == rider.get('id')
            or current_entry.get('id') in transferred_entry_ids
        )
    )
    path = encounter.get('turnPath') if isinstance(encounter.get('turnPath'), dict) else {}
    transfer_path = bool(
        encounter.get('playMode') == 'turn'
        and current_will_follow_rider
        and path.get('mapId') == map_obj.get('id')
        and path.get('tokenId') == mount_id
    )
    action = {
        'op': PLAYER_DISMOUNT_ACTION,
        'mapId': map_obj.get('id'),
        'tokenId': rider.get('id'),
        'mountId': mount_id,
        'riderName': str(rider.get('name') or '骑手')[:24],
        'mountName': str(mount.get('name') or '坐骑')[:24],
        'riderColor': TOKEN_RING_COLORS.get(rider.get('type'), TOKEN_RING_COLORS['npc']),
        'initiativeEntryIds': transferred_entry_ids,
        'turnPathTransferred': transfer_path,
        'playMode': permission_action.get('playMode', 'free'),
        'name': actor,
        'actor': actor,
    }
    if action['playMode'] == 'turn':
        action['turnSerial'] = encounter_turn_serial(state)
    return action, None, 200


def same_point(a, b):
    return abs(a['x'] - b['x']) < 0.01 and abs(a['y'] - b['y']) < 0.01


def normalize_doodle_point(map_obj, raw):
    if not isinstance(raw, dict):
        return None
    x = finite_number(raw.get('x'))
    y = finite_number(raw.get('y'))
    map_w = finite_number(map_obj.get('mapW'))
    map_h = finite_number(map_obj.get('mapH'))
    if x is None or y is None or map_w is None or map_h is None or map_w <= 0 or map_h <= 0:
        return None
    if x < 0 or y < 0 or x > map_w or y > map_h:
        return None
    return {'x': round(x, 3), 'y': round(y, 3)}


def normalize_doodle_stroke(map_obj, raw, author=''):
    """校验并压缩一条共享标注，避免任意对象进入房间状态。"""
    if not isinstance(raw, dict):
        return None
    doodle_id = str(raw.get('id') or '').strip()
    tool = str(raw.get('tool') or '').strip()
    color = str(raw.get('color') or '').strip()
    width = finite_number(raw.get('width'))
    if not DOODLE_ID_RE.fullmatch(doodle_id) or tool not in DOODLE_TOOLS:
        return None
    if not DOODLE_COLOR_RE.fullmatch(color) or width is None or width < 1 or width > 24:
        return None
    stroke = {
        'id': doodle_id,
        'tool': tool,
        'color': color.lower(),
        'width': round(width, 2),
        'author': str(author or raw.get('author') or '')[:24],
    }
    if tool == 'pen':
        points = raw.get('points')
        if not isinstance(points, list) or len(points) < 2 or len(points) > MAX_DOODLE_POINTS:
            return None
        normalized = []
        for point in points:
            clean = normalize_doodle_point(map_obj, point)
            if clean is None:
                return None
            if not normalized or not same_point(normalized[-1], clean):
                normalized.append(clean)
        if len(normalized) < 2:
            return None
        stroke['points'] = normalized
        return stroke
    start = normalize_doodle_point(map_obj, {'x': raw.get('x0'), 'y': raw.get('y0')})
    end = normalize_doodle_point(map_obj, {'x': raw.get('x1'), 'y': raw.get('y1')})
    if start is None or end is None or same_point(start, end):
        return None
    stroke.update({'x0': start['x'], 'y0': start['y'], 'x1': end['x'], 'y1': end['y']})
    return stroke


def apply_doodle_action(state, action):
    map_obj = find_map(state, action.get('mapId'))
    if not map_obj:
        return False
    doodles = map_obj.get('doodles')
    if not isinstance(doodles, list):
        doodles = []
        map_obj['doodles'] = doodles
    op = action.get('op')
    if op == 'doodleAdd':
        stroke = normalize_doodle_stroke(map_obj, action.get('stroke'), action.get('name'))
        if not stroke:
            return False
        action['mapId'] = map_obj.get('id')
        action['stroke'] = stroke
        if any(isinstance(item, dict) and item.get('id') == stroke['id'] for item in doodles):
            return True
        if len(doodles) >= MAX_DOODLES:
            return False
        doodles.append(stroke)
        return True
    if op == 'doodleDelete':
        doodle_id = str(action.get('doodleId') or '').strip()
        if not DOODLE_ID_RE.fullmatch(doodle_id):
            return False
        action['mapId'] = map_obj.get('id')
        action['doodleId'] = doodle_id
        map_obj['doodles'] = [item for item in doodles
                              if not isinstance(item, dict) or item.get('id') != doodle_id]
        return True
    if op == 'doodleClear':
        action['mapId'] = map_obj.get('id')
        map_obj['doodles'] = []
        return True
    return False


def apply_action(state, action):
    """幂等地把玩家动作应用到状态上。"""
    if not isinstance(action, dict):
        return False
    op = action.get('op')
    if op == PLAYER_SPAWN_ACTION:
        map_obj = find_map(state, action.get('mapId'))
        token = action.get('token')
        actor = str(action.get('actor') or '').strip()
        if not map_obj or not isinstance(token, dict) or not actor:
            return False
        token_id = str(token.get('id') or '')
        if (not token_id.startswith('pt-') or token.get('playerCreated') is not True
                or token.get('type') != 'pc' or str(token.get('owner') or '').strip() != actor):
            return False
        tokens = map_obj.get('tokens')
        if not isinstance(tokens, list):
            tokens = []
            map_obj['tokens'] = tokens
        existing = next((item for item in tokens if isinstance(item, dict) and item.get('id') == token_id), None)
        if existing:
            return str(existing.get('owner') or '').strip() == actor and existing.get('playerCreated') is True
        tokens.append(dict(token))
        return True
    if op == PLAYER_DELETE_ACTION:
        map_obj = find_map(state, action.get('mapId'))
        token_id = str(action.get('tokenId') or '')
        actor = str(action.get('actor') or '').strip()
        if not map_obj or not token_id.startswith('pt-') or not actor:
            return False
        tokens = map_obj.get('tokens') if isinstance(map_obj.get('tokens'), list) else []
        token = next((item for item in tokens if isinstance(item, dict) and item.get('id') == token_id), None)
        if token and (token.get('playerCreated') is not True or str(token.get('owner') or '').strip() != actor):
            return False
        if token:
            action['tokenName'] = str(token.get('name') or action.get('tokenName') or '临时棋子')[:24]
        detached = []
        for candidate in tokens:
            if isinstance(candidate, dict) and candidate.get('mountId') == token_id:
                candidate['mountId'] = None
                detached.append(candidate.get('id'))
        map_obj['tokens'] = [item for item in tokens
                             if not isinstance(item, dict) or item.get('id') != token_id]

        encounter = encounter_state(state)
        old_entries = encounter.get('entries', []) if isinstance(encounter.get('entries'), list) else []
        old_current_index = next((index for index, entry in enumerate(old_entries)
                                  if isinstance(entry, dict) and entry.get('id') == encounter.get('currentEntryId')), -1)
        removed_entry_ids = [entry.get('id') for entry in old_entries
                             if isinstance(entry, dict) and entry.get('tokenId') == token_id]
        encounter['entries'] = [entry for entry in old_entries
                                if not isinstance(entry, dict) or entry.get('tokenId') != token_id]
        current_removed = encounter.get('currentEntryId') in removed_entry_ids
        if current_removed:
            next_index = min(max(0, old_current_index), len(encounter['entries']) - 1) if encounter['entries'] else -1
            encounter['currentEntryId'] = encounter['entries'][next_index].get('id') if next_index >= 0 else None
        elif not any(isinstance(entry, dict) and entry.get('id') == encounter.get('currentEntryId')
                     for entry in encounter['entries']):
            encounter['currentEntryId'] = encounter['entries'][0].get('id') if encounter['entries'] else None
        path = encounter.get('turnPath') if isinstance(encounter.get('turnPath'), dict) else {}
        path_removed = path.get('tokenId') == token_id
        if removed_entry_ids or path_removed:
            encounter['turnSerial'] = encounter_turn_serial(state) + 1
            encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
        if encounter.get('playMode') == 'turn' and not encounter['entries']:
            encounter['playMode'] = 'prepare'
            encounter['currentEntryId'] = None
            encounter['round'] = 1
            encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
        action['detachedRiderIds'] = [item for item in detached if item]
        action['removedEntryIds'] = [item for item in removed_entry_ids if item]
        action['currentEntryId'] = encounter.get('currentEntryId')
        action['playMode'] = encounter.get('playMode')
        action['round'] = max(1, int(finite_number(encounter.get('round')) or 1))
        action['turnSerial'] = encounter_turn_serial(state)
        return True
    if op == PLAYER_MOUNT_ACTION:
        map_obj, rider = find_token(state, action.get('tokenId'))
        mount_map, mount = find_token(state, action.get('mountId'))
        actor = str(action.get('actor') or '').strip()
        if not map_obj or not rider or not mount or mount_map is not map_obj or not actor:
            return False
        if action.get('mapId') != map_obj.get('id') or str(rider.get('owner') or '').strip() != actor:
            return False
        if rider.get('hiddenFromPlayers') is True or mount.get('hiddenFromPlayers') is True:
            return False
        if (finite_number(rider.get('size')) or 1) >= 2 or (finite_number(mount.get('size')) or 1) < 2:
            return False
        mount_owner = str(mount.get('owner') or '').strip()
        if mount_owner and mount_owner != actor:
            return False
        if rider.get('mountId'):
            return rider.get('mountId') == mount.get('id')

        replay_allowed, _ = can_act_with_token(state, rider, actor, action)
        if not replay_allowed:
            return False
        encounter = encounter_state(state)
        current_token_id = current_turn_token_id(state)
        affected_before = token_control_group(state, rider) | token_control_group(state, mount)
        invalidates_turn = encounter.get('playMode') == 'turn' and current_token_id in affected_before

        rider['mountId'] = mount.get('id')
        rider['x'] = mount.get('x', rider.get('x'))
        rider['y'] = mount.get('y', rider.get('y'))
        initiative_changed = reconcile_mounted_initiative_entries(state)
        if encounter.get('playMode') != 'free' and (invalidates_turn or initiative_changed):
            encounter['turnSerial'] = encounter_turn_serial(state) + 1
            encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}

        action['x'] = rider.get('x')
        action['y'] = rider.get('y')
        action['initiativeEntries'] = copy.deepcopy(encounter.get('entries', []) or [])
        action['currentEntryId'] = encounter.get('currentEntryId')
        action['encounterPlayMode'] = encounter.get('playMode')
        action['round'] = max(1, int(finite_number(encounter.get('round')) or 1))
        action['turnSerial'] = encounter_turn_serial(state)
        action['turnPath'] = copy.deepcopy(encounter.get('turnPath') or {'mapId': None, 'tokenId': None, 'points': []})
        return True
    if op == PLAYER_DISMOUNT_ACTION:
        map_obj, rider = find_token(state, action.get('tokenId'))
        actor = str(action.get('actor') or '').strip()
        mount_id = str(action.get('mountId') or '').strip()
        if not map_obj or not rider or not actor or not mount_id:
            return False
        if action.get('mapId') != map_obj.get('id') or str(rider.get('owner') or '').strip() != actor:
            return False
        encounter = encounter_state(state)
        entry_ids = [str(item) for item in action.get('initiativeEntryIds', []) if item]
        transfer_path = action.get('turnPathTransferred') is True

        # 同一标准动作可能因主机快照并发而被重放；最终状态一致时直接成功。
        if not rider.get('mountId'):
            entries_done = all(
                (initiative_entry(encounter, entry_id) or {}).get('tokenId') == rider.get('id')
                for entry_id in entry_ids
            )
            path = encounter.get('turnPath') if isinstance(encounter.get('turnPath'), dict) else {}
            path_done = not transfer_path or path.get('tokenId') == rider.get('id')
            return entries_done and path_done
        if rider.get('mountId') != mount_id:
            return False
        mount_map, mount = find_token(state, mount_id)
        if not mount or mount_map is not map_obj:
            return False
        replay_allowed, _ = can_act_with_token(state, rider, actor, action)
        if not replay_allowed:
            return False

        unique_mount_controller = turn_controllers(state, mount) == {actor}
        expected_entry_ids = [
            str(entry.get('id')) for entry in encounter.get('entries', []) or []
            if unique_mount_controller and isinstance(entry, dict)
            and entry.get('tokenId') == mount_id and entry.get('id')
        ]
        if entry_ids != expected_entry_ids:
            return False
        current_entry = initiative_entry(encounter, encounter.get('currentEntryId'))
        current_will_follow_rider = bool(
            current_entry and (
                current_entry.get('tokenId') == rider.get('id')
                or str(current_entry.get('id')) in expected_entry_ids
            )
        )
        path = encounter.get('turnPath') if isinstance(encounter.get('turnPath'), dict) else {}
        expected_path_transfer = bool(
            encounter.get('playMode') == 'turn'
            and current_will_follow_rider
            and path.get('mapId') == map_obj.get('id')
            and path.get('tokenId') == mount_id
        )
        if transfer_path != expected_path_transfer:
            return False

        rider['mountId'] = None
        for entry_id in expected_entry_ids:
            entry = initiative_entry(encounter, entry_id)
            if entry:
                entry['tokenId'] = rider.get('id')
                entry['name'] = str(rider.get('name') or entry.get('name') or '骑手')[:48]
                entry['color'] = TOKEN_RING_COLORS.get(rider.get('type'), TOKEN_RING_COLORS['npc'])
        if expected_path_transfer:
            path['tokenId'] = rider.get('id')
        return True
    if op in INITIATIVE_ACTIONS:
        encounter = encounter_state(state)
        source = initiative_entry(encounter, action.get('entryId'))
        if encounter.get('playMode') != 'prepare' or not source:
            return False
        serial_number = finite_number(action.get('turnSerial'))
        next_serial_number = finite_number(action.get('nextTurnSerial'))
        if serial_number is None or next_serial_number is None:
            return False
        serial = max(1, int(serial_number))
        next_serial = max(serial + 1, int(next_serial_number))
        current_serial = encounter_turn_serial(state)
        if current_serial == next_serial:
            target = initiative_entry(encounter, action.get('targetEntryId'))
            return bool(target and finite_number(source.get('order')) == finite_number(action.get('entryOrder'))
                        and finite_number(target.get('order')) == finite_number(action.get('targetOrder')))
        if current_serial != serial:
            return False
        actor = str(action.get('actor') or '').strip()
        source_token = initiative_entry_token(state, source)
        if actor and (not source_token or not can_control(state, source_token, actor)):
            return False
        target = initiative_entry(encounter, action.get('targetEntryId'))
        target_token = initiative_entry_token(state, target)
        source_before = finite_number(action.get('previousEntryOrder'))
        target_before = finite_number(action.get('previousTargetOrder'))
        source_after = finite_number(action.get('entryOrder'))
        target_after = finite_number(action.get('targetOrder'))
        if not target or not target_token or not turn_controllers(state, target_token):
            return False
        if int(finite_number(source.get('value')) or 0) != int(finite_number(target.get('value')) or 0):
            return False
        if None in (source_before, target_before, source_after, target_after):
            return False
        if (initiative_effective_order(encounter, source) != source_before
                or initiative_effective_order(encounter, target) != target_before):
            return False
        source['order'] = source_after
        target['order'] = target_after
        sort_initiative_entries(encounter)
        encounter['turnSerial'] = next_serial
        encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
        return True
    if op == 'endTurn':
        encounter = encounter_state(state)
        serial = finite_number(action.get('turnSerial'))
        next_id = action.get('nextEntryId')
        next_serial = finite_number(action.get('nextTurnSerial'))
        if encounter.get('playMode') != 'turn' or serial is None or next_serial is None:
            return False
        if int(serial) != encounter_turn_serial(state) or not next_id:
            return False
        if not any(isinstance(entry, dict) and entry.get('id') == next_id for entry in encounter.get('entries', [])):
            return False
        decrement_current_token_conditions(state)
        encounter['currentEntryId'] = next_id
        encounter['round'] = max(1, int(finite_number(action.get('round')) or encounter.get('round', 1)))
        encounter['turnSerial'] = max(1, int(next_serial))
        encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
        world = encounter.setdefault('worldTime', {})
        old_total = max(0, int(finite_number(world.get('totalSeconds')) or 0))
        encounter['weather'] = normalize_weather(encounter.get('weather'), old_total)
        requested_total = finite_number(action.get('worldTimeSeconds'))
        world['totalSeconds'] = max(0, int(requested_total if requested_total is not None else old_total))
        world['runningSince'] = None
        if isinstance(action.get('weather'), dict):
            encounter['weather'] = normalize_weather(action['weather'], world['totalSeconds'])
            action['weather'] = dict(encounter['weather'])
        else:
            generated_weather = refresh_scheduled_weather(encounter, world['totalSeconds'])
            if generated_weather:
                action['weather'] = dict(generated_weather)
        return True
    if op in DOODLE_ACTIONS:
        return apply_doodle_action(state, action)
    m, t = find_token(state, action.get('tokenId'))
    if not m or not t:
        return False
    actor = str(action.get('actor') or '').strip()
    if (op in ('moveToken', 'patchToken') or op in TURN_PATH_ACTIONS) and actor:
        replay_allowed, _ = can_act_with_token(state, t, actor, action)
        if not replay_allowed:
            return False
    if (op in ('moveToken', 'patchToken') or op in TURN_PATH_ACTIONS) and action.get('mapId') is not None and action.get('mapId') != m.get('id'):
        return False
    if op == 'patchToken':
        encounter = encounter_state(state)
        current_mode = 'turn' if encounter.get('playMode') == 'turn' else 'free'
        recorded_mode = action_play_mode(action)
        if recorded_mode != current_mode:
            return False
        action['playMode'] = recorded_mode
        if current_mode == 'turn':
            serial = finite_number(action.get('turnSerial'))
            if serial is None or int(serial) != encounter_turn_serial(state):
                return False
        patch = action.get('patch')
        if not isinstance(patch, dict) or not patch:
            return False
        accepted = False
        for k, v in patch.items():
            if k not in PATCH_FIELDS:
                continue
            if k == 'hp':
                try:
                    t[k] = max(0, min(99999, int(v)))
                    accepted = True
                except Exception:
                    pass
            elif k == 'hpMax':
                try:
                    t[k] = max(1, min(99999, int(v)))
                    accepted = True
                except Exception:
                    pass
            elif k == 'ac':
                try:
                    t[k] = max(0, min(99, int(v)))
                    accepted = True
                except Exception:
                    pass
            elif k == 'spellRange':
                t[k] = normalize_spell_range(v)
                patch[k] = dict(t[k])
                accepted = True
            elif k == 'conditions':
                public_conditions = normalize_public_conditions(v)
                if public_conditions is not None:
                    t[k] = public_conditions
                    # 广播经过服务器校验的版本，避免客户端把额外字段带给主控台。
                    patch[k] = [dict(condition) for condition in public_conditions]
                    accepted = True
        return accepted
    if op in TURN_PATH_ACTIONS:
        t = movement_anchor(m, t)
        action['tokenId'] = t.get('id')
        encounter = encounter_state(state)
        if encounter.get('playMode') != 'turn':
            return False
        serial = finite_number(action.get('turnSerial'))
        if serial is None or int(serial) != encounter_turn_serial(state):
            return False
        existing = encounter.get('turnPath')
        canonical_replay = action.get('pathMode') == 'replace' and isinstance(action.get('path'), list)
        if not canonical_replay and (not isinstance(existing, dict)
                                     or existing.get('mapId') != m.get('id')
                                     or existing.get('tokenId') != t.get('id')):
            return False
        if canonical_replay:
            raw_points = action.get('path')
        else:
            raw_points = existing.get('points', []) or []
        points = []
        for raw_point in raw_points:
            if not isinstance(raw_point, dict):
                return False
            normalized = clamp_token_point(m, t, raw_point)
            if normalized is None:
                return False
            if not points or not same_point(points[-1], normalized):
                points.append(normalized)
        if not canonical_replay:
            if len(points) < 2:
                return False
            points = points[:-1] if op == 'turnPathUndo' else points[:1]
            action['pathMode'] = 'replace'
            action['path'] = [dict(candidate) for candidate in points]
        if not points or len(points) > MAX_TURN_PATH_POINTS:
            return False
        target = points[-1]
        encounter['turnPath'] = {
            'mapId': m.get('id'),
            'tokenId': t.get('id'),
            'points': [dict(candidate) for candidate in points],
        }
        t['x'] = target['x']
        t['y'] = target['y']
        for rider in m.get('tokens', []) or []:
            if rider.get('mountId') == t.get('id'):
                rider['x'] = t['x']
                rider['y'] = t['y']
        action['mapId'] = m.get('id')
        action['x'] = target['x']
        action['y'] = target['y']
        action['playMode'] = 'turn'
        action['turnSerial'] = int(serial)
        return True
    if op == 'moveToken':
        t = movement_anchor(m, t)
        action['tokenId'] = t.get('id')
        if action.get('mapId') is not None and action.get('mapId') != m.get('id'):
            return False
        point = clamp_token_point(m, t, {'x': action.get('x'), 'y': action.get('y')})
        if point is None:
            return False
        action['mapId'] = m.get('id')
        action['x'] = point['x']
        action['y'] = point['y']
        encounter = encounter_state(state)
        current_mode = 'turn' if encounter.get('playMode') == 'turn' else 'free'
        recorded_mode = action_play_mode(action)
        if recorded_mode != current_mode:
            return False
        action['playMode'] = recorded_mode
        if current_mode == 'turn':
            serial = finite_number(action.get('turnSerial'))
            if serial is None:
                return False
            serial = int(serial)
            if serial != encounter_turn_serial(state):
                # 过期动作可能在主机上传新快照时被重放；不能让旧回合覆盖新状态。
                return False
            raw_path = action.get('path')
            if raw_path is None:
                raw_path = []
            if not isinstance(raw_path, list) or len(raw_path) > MAX_MOVE_POINTS:
                return False
            fragment = []
            for raw_point in raw_path:
                if not isinstance(raw_point, dict):
                    return False
                normalized = clamp_token_point(m, t, raw_point)
                if normalized is None:
                    return False
                fragment.append(normalized)
            if not fragment:
                fragment = [{'x': finite_number(t.get('x')) or point['x'], 'y': finite_number(t.get('y')) or point['y']}]
            if not same_point(fragment[-1], point):
                fragment.append(point)
            if len(fragment) > MAX_MOVE_POINTS:
                fragment = fragment[:MAX_MOVE_POINTS - 1] + [fragment[-1]]
            existing = encounter.get('turnPath')
            existing_points = []
            if isinstance(existing, dict) and existing.get('mapId') == m.get('id') and existing.get('tokenId') == t.get('id'):
                for raw_point in existing.get('points', []) or []:
                    if isinstance(raw_point, dict):
                        normalized = clamp_token_point(m, t, raw_point)
                        if normalized is not None:
                            existing_points.append(normalized)
            combined = existing_points[:]
            for candidate in fragment:
                if not combined or not same_point(combined[-1], candidate):
                    combined.append(candidate)
            if len(combined) > MAX_TURN_PATH_POINTS:
                combined = combined[:MAX_TURN_PATH_POINTS - 1] + [combined[-1]]
            encounter['turnPath'] = {
                'mapId': m.get('id'),
                'tokenId': t.get('id'),
                'points': combined,
            }
            t['x'] = point['x']
            t['y'] = point['y']
            action['turnSerial'] = serial
            action['path'] = fragment
        else:
            encounter['turnPath'] = {'mapId': None, 'tokenId': None, 'points': []}
            action.pop('path', None)
            t['x'] = point['x']
            t['y'] = point['y']
        for r in m.get('tokens', []) or []:
            if r.get('mountId') == t.get('id'):
                r['x'] = t['x']
                r['y'] = t['y']
        return True
    return False


def state_snapshot(now=None):
    """返回带联机元数据的快照；调用方须在 LOCK 内调用。"""
    if STATE is None:
        return None
    snapshot = dict(STATE)
    snapshot['_sessionId'] = SESSION_ID
    snapshot['_roomCode'] = ROOM_CODE
    snapshot['_stateRevision'] = STATE_REVISION
    snapshot['_serverNow'] = int(now or time.time() * 1000)
    snapshot['_bgm'] = dict(BGM_STATE)
    return snapshot


def touch_session(token, status=None):
    session = SESSIONS.get(str(token or ''))
    if not session:
        return None
    session['lastSeen'] = int(time.time() * 1000)
    if status is not None:
        session['status'] = str(status or 'online')[:24]
    return session


def session_from_request(data):
    token = str((data or {}).get('sessionToken') or '').strip()
    if not token:
        return None
    return touch_session(token)


def online_players():
    cutoff = int(time.time() * 1000) - 35000
    result = []
    for session in SESSIONS.values():
        item = dict(session)
        item['online'] = int(session.get('lastSeen', 0)) >= cutoff and session.get('status') != 'offline'
        item.pop('token', None)
        result.append(item)
    result.sort(key=lambda item: (not item.get('online'), item.get('name', '').lower()))
    return result


def sse_bytes(event, event_id=None):
    lines = []
    if event_id is not None:
        lines.append('id: %s' % event_id)
    lines.append('data: ' + json.dumps(event, ensure_ascii=False, separators=(',', ':')))
    return ('\n'.join(lines) + '\n\n').encode('utf-8')

def get_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    ips.add('127.0.0.1')
    return sorted(ips)

def broadcast(data, event_id=None):
    payload = sse_bytes(data, event_id)
    with LOCK:
        clients = list(CLIENTS)
    for wfile, lock in clients:
        try:
            with lock:
                wfile.write(payload)
                wfile.flush()
        except Exception:
            with LOCK:
                try:
                    CLIENTS.remove((wfile, lock))
                except ValueError:
                    pass

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        if urlparse(self.path).path.endswith('.html'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range, X-Sundoll-Local-Save')
        self.send_header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length')

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_music_track(self, track_id):
        if not re.match(r'^[0-9a-f]{32}$', str(track_id or '')):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        with LOCK:
            path = MUSIC_LIBRARY_INDEX.get(track_id)
            snapshot = STATE if isinstance(STATE, dict) else {}
            campaign_id = snapshot.get('campaignId') or ''
            campaign_name = snapshot.get('campaignName') or ''
        if not path:
            refresh_music_library(campaign_id, campaign_name)
            with LOCK:
                path = MUSIC_LIBRARY_INDEX.get(track_id)
        if (not path or not _music_path_is_safe(MUSIC_LIBRARY_ROOT, path)
                or not os.path.isfile(path)):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        self._send_audio_path(path, MUSIC_LIBRARY_ROOT)

    def _send_uploaded_music(self, cache_name):
        if not re.match(r'^[0-9a-f]{24}\.[a-z0-9]{2,5}$', str(cache_name or '')):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        path = os.path.join(MUSIC_CACHE_ROOT, cache_name)
        if (not _music_path_is_safe(MUSIC_CACHE_ROOT, path) or not os.path.isfile(path)
                or not path.lower().endswith(MUSIC_EXTS)):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        self._send_audio_path(path, MUSIC_CACHE_ROOT)

    def _send_audio_path(self, path, safe_root):
        if not _music_path_is_safe(safe_root, path):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        try:
            stat = os.stat(path)
            size = stat.st_size
            byte_range = parse_http_byte_range(self.headers.get('Range'), size)
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % max(0, size))
            self.send_header('Accept-Ranges', 'bytes')
            self._cors()
            self.end_headers()
            return
        except OSError:
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        start, end = byte_range if byte_range else (0, size - 1)
        length = max(0, end - start + 1)
        extension = os.path.splitext(path)[1].lower()
        self.send_response(206 if byte_range else 200)
        self.send_header('Content-Type', MUSIC_MIME_TYPES.get(extension, 'application/octet-stream'))
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'private, max-age=3600')
        self.send_header('ETag', '"%x-%x"' % (stat.st_mtime_ns, size))
        if byte_range:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self._cors()
        self.end_headers()
        try:
            with open(path, 'rb') as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(128 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/music-library':
            if not is_local_request(self):
                self._send_json({'ok': False, 'error': 'music library is host-only'}, 403)
                return
            query = parse_qs(urlparse(self.path).query)
            with LOCK:
                snapshot = STATE if isinstance(STATE, dict) else {}
                campaign_id = (query.get('campaignId') or [snapshot.get('campaignId') or ''])[0]
                campaign_name = (query.get('campaignName') or [snapshot.get('campaignName') or ''])[0]
            self._send_json(refresh_music_library(campaign_id, campaign_name))
        elif path.startswith('/api/music-stream/'):
            self._send_music_track(path.rsplit('/', 1)[-1])
        elif path.startswith('/api/music-upload/'):
            self._send_uploaded_music(path.rsplit('/', 1)[-1])
        elif path == '/api/music-state':
            with LOCK:
                bgm = dict(BGM_STATE)
            self._send_json({'ok': True, 'bgm': bgm, 'serverNow': int(time.time() * 1000)})
        elif path.startswith('/api/assets/'):
            key = path.rsplit('/', 1)[-1]
            with LOCK:
                asset = ASSETS.get(key)
            if not asset:
                asset = load_disk_asset(key)
                if asset:
                    with LOCK:
                        ASSETS[key] = asset
            if not asset:
                self._send_json({'ok': False, 'error': 'asset not found'}, 404)
                return
            mime, raw = asset
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
            self._cors()
            self.end_headers()
            self.wfile.write(raw)
        elif path == '/api/state':
            with LOCK:
                self._send_json(state_snapshot() or {})
        elif self.path.startswith('/api/actions'):
            qs = parse_qs(urlparse(self.path).query)
            try:
                after = int((qs.get('after') or ['0'])[0])
            except Exception:
                after = 0
            with LOCK:
                acts = [a for a in RECENT_ACTIONS if a.get('seq', 0) > after]
                revision = STATE_REVISION
            self._send_json({'actions': acts, 'stateRevision': revision})
        elif self.path == '/api/info':
            with LOCK:
                players = online_players()
                revision = STATE_REVISION
                snapshot = STATE if isinstance(STATE, dict) else {}
                maps = snapshot.get('maps') if isinstance(snapshot.get('maps'), list) else []
                active_map_id = snapshot.get('activeMapId')
                active_map = next((item for item in maps if isinstance(item, dict) and item.get('id') == active_map_id), None)
                if active_map is None:
                    active_map = next((item for item in maps if isinstance(item, dict)), None)
            self._send_json({
                'port': PORT,
                'bind': BIND_HOST,
                'ips': get_ips(),
                'name': '桑多尔之歌联机',
                'protocolVersion': SERVER_PROTOCOL_VERSION,
                'sessionId': SESSION_ID,
                'roomCode': ROOM_CODE,
                'stateRevision': revision,
                'playerCount': len([p for p in players if p.get('online')]),
                'campaignName': snapshot.get('campaignName') or '',
                'campaignCoverUrl': snapshot.get('_campaignCoverUrl') or campaign_cover_asset_url(snapshot),
                'bgmState': dict(BGM_STATE),
                'activeMapName': active_map.get('name') if active_map else '',
                'mapCount': len(maps),
                'endpoints': {'host': '/主控台/主控台.html', 'player': '/主控台/玩家.html'},
            })
        elif path == '/api/players':
            with LOCK:
                self._send_json({'ok': True, 'players': online_players()})
        elif path == '/api/session':
            token = (parse_qs(urlparse(self.path).query).get('token') or [''])[0]
            with LOCK:
                session = touch_session(token)
                if not session:
                    self._send_json({'ok': False, 'error': 'session not found'}, 404)
                    return
                public_session = dict(session)
                public_session.pop('token', None)
                self._send_json({'ok': True, 'session': public_session, 'roomCode': ROOM_CODE})
        elif path == '/api/health':
            with LOCK:
                self._send_json({'ok': True, 'state': STATE is not None, 'stateRevision': STATE_REVISION, 'clients': len(CLIENTS), 'players': len(SESSIONS)})
        elif self.path == '/api/events':
            self.stream_events()
        elif self.path == '/' or self.path == '/index.html':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self._cors()
            self.end_headers()
            host = 'http://localhost:%d/主控台/主控台.html' % PORT
            viewer = 'http://localhost:%d/主控台/玩家.html' % PORT
            self.wfile.write((
                '<meta charset="utf-8"><title>桑多尔之歌联机服务器</title>'
                '<body style="background:#101218;color:#e8eaf0;font-family:sans-serif;padding:40px">'
                '<h2>🖥️ 桑多尔之歌联机服务器已启动（端口 %d）</h2>'
                '<p>主机：<a href="%s" style="color:#e0b34c">%s</a></p>'
                '<p>玩家模式：<a href="%s" style="color:#e0b34c">%s</a></p>'
                '<p>同一 WiFi 下的玩家，把 localhost 换成下面的 IP：<br>%s</p>'
                '</body>'
            ) % (PORT, host, host, viewer, viewer, '、'.join(get_ips())))
        else:
            super().do_GET()

    def _read_json_body(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            raise ValueError('invalid content length')
        if length > limit:
            raise OverflowError('request body too large')
        body = self.rfile.read(length) if length else b'{}'
        return json.loads(body.decode('utf-8'))

    def handle_local_save(self):
        if not local_save_request_allowed(self):
            self._send_json({'ok': False, 'error': 'local save api is host-only'}, 403)
            return
        try:
            data = self._read_json_body(MAX_LOCAL_SAVE_BODY)
            result = perform_local_save_operation(data)
        except OverflowError:
            self._send_json({'ok': False, 'error': 'save too large'}, 413)
            return
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json({'ok': False, 'error': str(error) or 'invalid save request'}, 400)
            return
        except OSError as error:
            self._send_json({'ok': False, 'error': 'save operation failed: ' + str(error)}, 500)
            return
        self._send_json(result)

    def do_POST(self):
        global STATE, STATE_REVISION, NEXT_SEQ
        if self.path == '/api/local-save':
            self.handle_local_save()
        elif self.path == '/api/session':
            try:
                data = self._read_json_body(64 * 1024)
            except OverflowError:
                self._send_json({'ok': False, 'error': '请求过大'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': '加入信息无效'}, 400)
                return
            if not isinstance(data, dict):
                self._send_json({'ok': False, 'error': '加入信息无效'}, 400)
                return
            room = str(data.get('roomCode') or '').strip().upper()
            nickname = str(data.get('nickname') or '').strip()[:24]
            resume = str(data.get('sessionToken') or '').strip()
            if room and room != ROOM_CODE:
                self._send_json({'ok': False, 'error': '房间码不正确'}, 403)
                return
            if not nickname and resume:
                with LOCK:
                    existing = touch_session(resume)
                    if existing:
                        public_session = dict(existing)
                        public_session.pop('token', None)
                        public_session['sessionToken'] = resume
                        self._send_json({'ok': True, 'session': public_session, 'roomCode': ROOM_CODE})
                        return
            if not nickname:
                self._send_json({'ok': False, 'error': '请填写玩家名'}, 400)
                return
            with LOCK:
                now = int(time.time() * 1000)
                active_same_name = next((s for s in SESSIONS.values()
                                         if s.get('name') == nickname and now - int(s.get('lastSeen', 0)) < 35000), None)
                if active_same_name and not (resume and active_same_name.get('token') == resume):
                    self._send_json({'ok': False, 'error': '这个名字已经在线，请换一个名字'}, 409)
                    return
                if resume and resume in SESSIONS:
                    session = touch_session(resume, 'online')
                    session['name'] = nickname
                    public_session = dict(session)
                    public_session.pop('token', None)
                    public_session['sessionToken'] = resume
                    self._send_json({'ok': True, 'session': public_session, 'roomCode': ROOM_CODE})
                    return
                token = secrets.token_urlsafe(24)
                session = {
                    'token': token,
                    'playerId': 'p' + secrets.token_hex(6),
                    'name': nickname,
                    'status': 'online',
                    'lastSeen': now,
                }
                SESSIONS[token] = session
            broadcast({'type': 'presence', 'players': online_players()})
            public_session = dict(session)
            public_session.pop('token', None)
            public_session['sessionToken'] = token
            self._send_json({'ok': True, 'session': public_session, 'roomCode': ROOM_CODE})
        elif self.path == '/api/presence':
            try:
                data = self._read_json_body(64 * 1024)
            except OverflowError:
                self._send_json({'ok': False, 'error': '请求过大'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': '状态信息无效'}, 400)
                return
            if not isinstance(data, dict):
                self._send_json({'ok': False, 'error': '状态信息无效'}, 400)
                return
            with LOCK:
                session = touch_session(data.get('sessionToken'), data.get('status') or 'online')
                if not session:
                    self._send_json({'ok': False, 'error': '会话已失效'}, 401)
                    return
                players = online_players()
            broadcast({'type': 'presence', 'players': players})
            self._send_json({'ok': True, 'players': players})
        elif urlparse(self.path).path == '/api/webrtc-signal':
            try:
                data = self._read_json_body(192 * 1024)
            except OverflowError:
                self._send_json({'ok': False, 'error': 'signal too large'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': 'bad signal'}, 400)
                return
            signal = normalize_webrtc_signal(data.get('signal') if isinstance(data, dict) else None)
            if not signal:
                self._send_json({'ok': False, 'error': 'bad signal'}, 400)
                return
            session_token = str(data.get('sessionToken') or '').strip() if isinstance(data, dict) else ''
            if session_token:
                with LOCK:
                    session = touch_session(session_token)
                    sender_id = session.get('playerId') if session else ''
                if not session:
                    self._send_json({'ok': False, 'error': 'session expired'}, 401)
                    return
                event = {
                    'type': 'webrtcSignal', 'target': 'host', 'senderPlayerId': sender_id,
                    'signal': signal,
                }
            else:
                if not is_local_request(self):
                    self._send_json({'ok': False, 'error': 'host signal is local-only'}, 403)
                    return
                target_id = str(data.get('targetPlayerId') or '').strip()[:64]
                with LOCK:
                    target_exists = any(item.get('playerId') == target_id for item in SESSIONS.values())
                if not target_id or not target_exists:
                    self._send_json({'ok': False, 'error': 'player not found'}, 404)
                    return
                event = {
                    'type': 'webrtcSignal', 'target': target_id, 'senderPlayerId': 'host',
                    'signal': signal,
                }
            broadcast(event)
            self._send_json({'ok': True})
        elif self.path == '/api/state':
            # 这是 GM 上传公共快照的入口。玩家端只读，不能借它覆盖房间状态。
            if not is_local_request(self):
                self._send_json({'ok': False, 'error': 'state api is host-only'}, 403)
                return
            try:
                data = self._read_json_body(MAX_BODY)
            except OverflowError:
                self._send_json({'ok': False, 'error': 'state too large'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
                return
            if not isinstance(data, dict):
                self._send_json({'ok': False, 'error': 'state must be an object'}, 400)
                return
            with LOCK:
                seq0 = 0
                try:
                    seq0 = int(data.pop('_streamSeq', 0) or 0)
                except Exception:
                    seq0 = 0
                STATE = cache_stream_media(data)
                # 主机快照没包含的玩家动作，重新应用回去（动作都是幂等的）
                for act in RECENT_ACTIONS:
                    if act.get('seq', 0) > seq0:
                        apply_action(STATE, act)
                STATE['_streamSeq'] = RECENT_ACTIONS[-1]['seq'] if RECENT_ACTIONS else 0
                STATE_REVISION += 1
                STATE['_stateRevision'] = STATE_REVISION
                STATE['_sessionId'] = SESSION_ID
                STATE['_roomCode'] = ROOM_CODE
                # 玩家端用服务器时钟作为世界时间运行快照的锚点，避免各设备系统时钟不同。
                STATE['_serverNow'] = int(time.time() * 1000)
                snapshot = state_snapshot()
            state_event_id = RECENT_ACTIONS[-1].get('seq', 0) if RECENT_ACTIONS else None
            broadcast({'type': 'state', 'state': snapshot}, state_event_id)
            self._send_json({'ok': True, 'stateRevision': STATE_REVISION})
        elif self.path.startswith('/api/music'):
            if not is_local_request(self):
                self._send_json({'ok': False, 'error': 'music api is host-only'}, 403)
                return
            length = int(self.headers.get('Content-Length') or 0)
            if length > 80 * 1024 * 1024:
                self._send_json({'ok': False, 'error': 'file too large'}, 413)
                return
            data = self.rfile.read(length) if length else b''
            qs = parse_qs(urlparse(self.path).query)
            name = (qs.get('name') or [''])[0]
            name = re.sub(r'[^\w\u4e00-\u9fff.\- ]', '', name)[:120]
            if not name:
                self._send_json({'ok': False, 'error': 'missing name'}, 400)
                return
            if len(data) > 80 * 1024 * 1024:
                self._send_json({'ok': False, 'error': 'file too large'}, 413)
                return
            if not name.lower().endswith(MUSIC_EXTS):
                self._send_json({'ok': False, 'error': 'unsupported type'}, 400)
                return
            extension = os.path.splitext(name)[1].lower()
            cache_name = hashlib.sha256(data).hexdigest()[:24] + extension
            os.makedirs(MUSIC_CACHE_ROOT, exist_ok=True)
            with open(os.path.join(MUSIC_CACHE_ROOT, cache_name), 'wb') as f:
                f.write(data)
            clean_music_cache(MUSIC_CACHE_ROOT)
            self._send_json({'ok': True, 'url': '/api/music-upload/' + cache_name})
        elif self.path == '/api/host-action':
            # GM 的公开骰子、公告、BGM 与休息表现只能从主机本机发出。
            if not is_local_request(self):
                self._send_json({'ok': False, 'error': 'host action is local-only'}, 403)
                return
            try:
                data = self._read_json_body(64 * 1024)
            except OverflowError:
                self._send_json({'ok': False, 'error': '请求过大'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
                return
            action = data.get('action') if isinstance(data, dict) else None
            if not isinstance(action, dict) or action.get('op') not in HOST_ACTIONS:
                self._send_json({'ok': False, 'error': '不支持的 GM 动作'}, 400)
                return
            public_action = {'op': action.get('op'), 'name': 'GM'}
            if action.get('op') == 'roll':
                public_action = normalize_roll_action(action, 'GM')
                if not public_action:
                    self._send_json({'ok': False, 'error': '骰子数据无效'}, 400)
                    return
            elif action.get('op') == 'mapReaction':
                with LOCK:
                    public_action = normalize_map_reaction(STATE, action, 'GM') if STATE is not None else None
                if not public_action:
                    self._send_json({'ok': False, 'error': '表情位置或内容无效'}, 400)
                    return
            elif action.get('op') == 'bgm':
                public_action = normalize_bgm_action(action)
                if not public_action:
                    self._send_json({'ok': False, 'error': 'BGM 动作无效'}, 400)
                    return
                bgm_url = public_action['url']
                if bgm_url and not (bgm_url.startswith('/') or re.match(r'^https?://', bgm_url, re.I)):
                    self._send_json({'ok': False, 'error': 'BGM 地址无效'}, 400)
                    return
                with LOCK:
                    BGM_STATE.clear()
                    BGM_STATE.update(public_action)
            elif action.get('op') == 'restTransition':
                public_action = normalize_rest_transition_action(action)
                if not public_action:
                    self._send_json({'ok': False, 'error': '休息动画数据无效'}, 400)
                    return
            else:
                public_action['text'] = str(action.get('text') or '').strip()[:1000]
                if not public_action['text']:
                    self._send_json({'ok': False, 'error': '公告内容为空'}, 400)
                    return
            broadcast({'type': 'action', 'seq': 0, 'action': public_action})
            self._send_json({'ok': True})
        elif self.path == '/api/action':
            try:
                data = self._read_json_body(MAX_ACTION_BODY)
            except OverflowError:
                self._send_json({'ok': False, 'error': '请求过大'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
                return
            if not isinstance(data, dict):
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
                return
            session_token = str(data.get('sessionToken') or '').strip()
            with LOCK:
                session = session_from_request(data)
            if not session_token or not session:
                self._send_json({'ok': False, 'error': '需要有效的玩家会话，请重新加入'}, 401)
                return
            player = str((session or {}).get('name') or data.get('player') or '').strip()
            action = data.get('action') or {}
            if not player:
                self._send_json({'ok': False, 'error': '缺少玩家名'}, 400)
                return
            if not isinstance(action, dict):
                self._send_json({'ok': False, 'error': '动作数据无效'}, 400)
                return
            action_id = str(data.get('actionId') or action.get('actionId') or '').strip()[:96]
            if action_id:
                with LOCK:
                    duplicate_seq = ACTION_IDS.get(action_id)
                if duplicate_seq is not None:
                    self._send_json({'ok': True, 'seq': duplicate_seq, 'duplicate': True})
                    return
            with LOCK:
                if not consume_action_slot(session_token):
                    self._send_json({'ok': False, 'error': '操作过于频繁，请稍后再试'}, 429)
                    return
            if action.get('op') in INITIATIVE_ACTIONS:
                with LOCK:
                    if STATE is None:
                        self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                        return
                    initiative_action, error, status = normalize_player_initiative_action(STATE, action, player)
                    if not initiative_action:
                        self._send_json({'ok': False, 'error': error or '先攻操作无效'}, status or 400)
                        return
                    if not apply_action(STATE, initiative_action):
                        self._send_json({'ok': False, 'error': '先攻顺序已经变化，请重新操作'}, 409)
                        return
                    STATE_REVISION += 1
                    STATE['_stateRevision'] = STATE_REVISION
                    seq = NEXT_SEQ
                    NEXT_SEQ += 1
                    STATE['_streamSeq'] = seq
                    initiative_action['seq'] = seq
                    if action_id:
                        initiative_action['actionId'] = action_id
                        ACTION_IDS[action_id] = seq
                    RECENT_ACTIONS.append(initiative_action)
                    if len(RECENT_ACTIONS) > MAX_RECENT:
                        del RECENT_ACTIONS[:len(RECENT_ACTIONS) - MAX_RECENT]
                    ev = {'type': 'action', 'seq': seq, 'revision': STATE_REVISION, 'action': dict(initiative_action)}
                broadcast(ev, seq)
                self._send_json({'ok': True, 'seq': seq, 'stateRevision': STATE_REVISION})
                return
            if action.get('op') == 'endTurn':
                with LOCK:
                    if STATE is None:
                        self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                        return
                    encounter = encounter_state(STATE)
                    entries = encounter.get('entries', []) or []
                    current_index = next((i for i, entry in enumerate(entries)
                                          if isinstance(entry, dict) and entry.get('id') == encounter.get('currentEntryId')), -1)
                    if encounter.get('playMode') != 'turn' or current_index < 0:
                        self._send_json({'ok': False, 'error': '当前不是可结束的回合'}, 409)
                        return
                    requested_serial = finite_number(action.get('turnSerial'))
                    if requested_serial is None or int(requested_serial) != encounter_turn_serial(STATE):
                        self._send_json({'ok': False, 'error': '回合已经变化，请重新操作'}, 409)
                        return
                    current_entry = entries[current_index]
                    current_token = find_token(STATE, current_entry.get('tokenId'))[1]
                    turn_allowed, turn_reason = can_act_with_token(STATE, current_token, player, action) if current_token else (False, '还没有轮到你的角色')
                    if not turn_allowed:
                        self._send_json({'ok': False, 'error': turn_reason or '还没有轮到你的角色'}, 403)
                        return
                    next_index = (current_index + 1) % len(entries)
                    next_entry = entries[next_index]
                    next_round = max(1, int(encounter.get('round', 1))) + (1 if next_index == 0 else 0)
                    world = encounter.get('worldTime') if isinstance(encounter.get('worldTime'), dict) else {}
                    total_seconds = max(0, int(finite_number(world.get('totalSeconds')) or 0))
                    running_since = finite_number(world.get('runningSince'))
                    if running_since:
                        rate = finite_number(world.get('rate'))
                        rate = max(.01, min(60, rate if rate is not None and rate > 0 else 1))
                        total_seconds += max(0, int((time.time() * 1000 - running_since) * rate / 1000))
                    seconds_per_round = max(1, int(finite_number(encounter.get('secondsPerRound')) or 6))
                    if next_index == 0:
                        total_seconds += seconds_per_round
                    end_action = {
                        'op': 'endTurn',
                        'name': player,
                        'turnSerial': int(requested_serial),
                        'nextEntryId': next_entry.get('id'),
                        'nextTurnSerial': encounter_turn_serial(STATE) + 1,
                        'round': next_round,
                        'worldTimeSeconds': total_seconds,
                    }
                    if not apply_action(STATE, end_action):
                        self._send_json({'ok': False, 'error': '回合状态已变化，请重新操作'}, 409)
                        return
                    STATE_REVISION += 1
                    STATE['_stateRevision'] = STATE_REVISION
                    seq = NEXT_SEQ
                    NEXT_SEQ += 1
                    STATE['_streamSeq'] = seq
                    end_action['seq'] = seq
                    if action_id:
                        end_action['actionId'] = action_id
                        ACTION_IDS[action_id] = seq
                    RECENT_ACTIONS.append(end_action)
                    if len(RECENT_ACTIONS) > MAX_RECENT:
                        del RECENT_ACTIONS[:len(RECENT_ACTIONS) - MAX_RECENT]
                    ev = {'type': 'action', 'seq': seq, 'revision': STATE_REVISION, 'action': dict(end_action)}
                broadcast(ev, seq)
                self._send_json({'ok': True, 'seq': seq, 'stateRevision': STATE_REVISION})
                return
            # 玩家只会把公开骰送到服务器；私密骰完全留在当前浏览器。
            # 公开骰不修改地图状态，但会广播给所有在线客户端写入各自骰点记录。
            if action.get('op') == 'roll':
                public_roll = normalize_roll_action(action, player)
                if not public_roll:
                    self._send_json({'ok': False, 'error': '骰子数据无效'}, 400)
                    return
                ev = {'type': 'action', 'seq': 0, 'action': public_roll}
                broadcast(ev)
                if action_id:
                    with LOCK:
                        ACTION_IDS[action_id] = 0
                self._send_json({'ok': True})
                return
            # 地图表情是短暂表现，不写入状态和动作历史，避免重连后重新播放旧表情。
            if action.get('op') == 'mapReaction':
                with LOCK:
                    if not consume_reaction_slot(session_token):
                        self._send_json({'ok': False, 'error': '表情发送太快了，请稍等'}, 429)
                        return
                    public_reaction = normalize_map_reaction(STATE, action, player) if STATE is not None else None
                if not public_reaction:
                    self._send_json({'ok': False, 'error': '表情位置或内容无效'}, 400)
                    return
                broadcast({'type': 'action', 'seq': 0, 'action': public_reaction})
                if action_id:
                    with LOCK:
                        ACTION_IDS[action_id] = 0
                self._send_json({'ok': True})
                return
            # BGM：不修改状态，只广播让玩家端跟随播放
            if action.get('op') == 'bgm':
                # BGM 是主持人的本机动作；玩家端即使伪造请求也不应改变所有人的音乐。
                self._send_json({'ok': False, 'error': 'BGM 只能由主控台广播'}, 403)
                return
            with LOCK:
                if STATE is None:
                    self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                    return
                is_spawn_action = action.get('op') == PLAYER_SPAWN_ACTION
                is_delete_action = action.get('op') == PLAYER_DELETE_ACTION
                is_mount_action = action.get('op') == PLAYER_MOUNT_ACTION
                is_dismount_action = action.get('op') == PLAYER_DISMOUNT_ACTION
                is_doodle_action = action.get('op') in DOODLE_ACTIONS
                if is_spawn_action:
                    normalized_spawn, spawn_error, spawn_status = normalize_player_spawn_action(
                        STATE, action, player, (session or {}).get('playerId')
                    )
                    if not normalized_spawn:
                        self._send_json({'ok': False, 'error': spawn_error or '临时棋子数据无效'}, spawn_status or 400)
                        return
                    action = normalized_spawn
                elif is_delete_action:
                    normalized_delete, delete_error, delete_status = normalize_player_delete_action(STATE, action, player)
                    if not normalized_delete:
                        self._send_json({'ok': False, 'error': delete_error or '删除请求无效'}, delete_status or 400)
                        return
                    action = normalized_delete
                elif is_mount_action:
                    normalized_mount, mount_error, mount_status = normalize_player_mount_action(STATE, action, player)
                    if not normalized_mount:
                        self._send_json({'ok': False, 'error': mount_error or '上骑请求无效'}, mount_status or 400)
                        return
                    action = normalized_mount
                elif is_dismount_action:
                    normalized_dismount, dismount_error, dismount_status = normalize_player_dismount_action(
                        STATE, action, player
                    )
                    if not normalized_dismount:
                        self._send_json({'ok': False, 'error': dismount_error or '解除骑乘请求无效'}, dismount_status or 400)
                        return
                    action = normalized_dismount
                elif is_doodle_action:
                    # 已加入房间的玩家都可以使用共享标注；作者名由服务器写入，不能伪造。
                    action['name'] = player
                else:
                    map_obj, tok = find_token(STATE, action.get('tokenId'))
                    if not tok:
                        self._send_json({'ok': False, 'error': '棋子不存在'}, 404)
                        return
                    if action.get('op') in ('moveToken', 'patchToken') or action.get('op') in TURN_PATH_ACTIONS:
                        allowed, reason = can_act_with_token(STATE, tok, player, action)
                        if not allowed:
                            self._send_json({'ok': False, 'error': reason}, 409 if reason == '回合已经变化，请重新操作' else 403)
                            return
                        if action.get('mapId') is not None and action.get('mapId') != map_obj.get('id'):
                            self._send_json({'ok': False, 'error': '地图与棋子不匹配'}, 400)
                            return
                        # 记录动作原始玩家，主机快照并发覆盖后重放时会重新核对最新归属。
                        action['actor'] = player
                        if action.get('op') in TURN_PATH_ACTIONS:
                            # 路径结果只能由服务器从当前权威路径推导；客户端不能自带替换内容。
                            action.pop('path', None)
                            action.pop('pathMode', None)
                    elif not can_control(STATE, tok, player):
                        self._send_json({'ok': False, 'error': '只能操作自己名下的棋子'}, 403)
                        return
                if not apply_action(STATE, action):
                    if is_spawn_action:
                        error = '临时棋子放置失败'
                    elif is_delete_action:
                        error = '临时棋子删除失败'
                    elif is_mount_action:
                        error = '上骑失败'
                    elif is_dismount_action:
                        error = '解除骑乘失败'
                    else:
                        error = '涂鸦数据无效或地图不存在' if is_doodle_action else '不支持的动作'
                    self._send_json({'ok': False, 'error': error}, 400)
                    return
                STATE_REVISION += 1
                STATE['_stateRevision'] = STATE_REVISION
                seq = NEXT_SEQ
                NEXT_SEQ += 1
                STATE['_streamSeq'] = seq
                act = dict(action)
                act['seq'] = seq
                if action_id:
                    act['actionId'] = action_id
                RECENT_ACTIONS.append(act)
                if len(RECENT_ACTIONS) > MAX_RECENT:
                    del RECENT_ACTIONS[:len(RECENT_ACTIONS) - MAX_RECENT]
                ev = {'type': 'action', 'seq': seq, 'revision': STATE_REVISION, 'action': dict(act)}
                if action_id:
                    ACTION_IDS[action_id] = seq
                    if len(ACTION_IDS) > MAX_ACTION_IDS:
                        for old_id in list(ACTION_IDS)[:len(ACTION_IDS) - MAX_ACTION_IDS]:
                            ACTION_IDS.pop(old_id, None)
            broadcast(ev, seq if seq else None)
            self._send_json({'ok': True, 'seq': seq, 'stateRevision': STATE_REVISION})
        else:
            self._send_json({'ok': False, 'error': 'not found'}, 404)

    def stream_events(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self._cors()
        self.end_headers()
        lock = threading.Lock()
        with LOCK:
            CLIENTS.append((self.wfile, lock))
            initial = state_snapshot()
            try:
                last_id = int(self.headers.get('Last-Event-ID') or 0)
            except (TypeError, ValueError):
                last_id = 0
            recent = list(RECENT_ACTIONS)
            first_recent = recent[0].get('seq', 0) if recent else 0
            can_replay = bool(last_id and (not first_recent or last_id >= first_recent - 1))
        try:
            if can_replay:
                for action in recent:
                    if action.get('seq', 0) > last_id:
                        event = {'type': 'action', 'seq': action.get('seq', 0), 'action': dict(action)}
                        with lock:
                            self.wfile.write(sse_bytes(event, action.get('seq')))
                            self.wfile.flush()
            elif initial is not None:
                with lock:
                    ev = {'type': 'state', 'state': initial}
                    initial_event_id = recent[-1].get('seq', 0) if recent else None
                    self.wfile.write(sse_bytes(ev, initial_event_id))
                    self.wfile.flush()
            while True:
                time.sleep(10)
                with lock:
                    self.wfile.write(b': ping\n\n')
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with LOCK:
                if (self.wfile, lock) in CLIENTS:
                    CLIENTS.remove((self.wfile, lock))

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # 浏览器刷新/关页会正常中断 SSE 长连接；不把这种预期断开打印成异常栈。
        exc_type = sys.exc_info()[0]
        if exc_type and issubclass(exc_type, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

if __name__ == '__main__':
    os.chdir(ROOT)
    srv = Server((BIND_HOST, PORT), Handler)
    print('=' * 56)
    print('桑多尔之歌联机服务器已启动，端口 %d，监听 %s' % (PORT, BIND_HOST))
    for ip in get_ips():
        if ip != '127.0.0.1':
            print('  玩家请打开:  http://%s:%d/主控台/玩家.html' % (ip, PORT))
    print('  主机:        http://localhost:%d/主控台/主控台.html' % PORT)
    print('  按 Ctrl+C 停止')
    print('=' * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
