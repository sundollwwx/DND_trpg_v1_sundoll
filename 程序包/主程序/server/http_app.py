import shutil
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
桑哆尔之歌 · 简易联机服务器（零依赖，Python 3.7+）
用法：在项目根目录运行  python3 程序包/应用/start_server.py [端口]
      或运行  python3 程序包/应用/start_server.py --port 8092 --bind 0.0.0.0
默认端口 8090。启动后：
  主机（你）：浏览器打开 http://localhost:8090/主控台/主控台.html 或本地双击主控台，
              在「📡 联机 → 开启玩家模式」开启推送。
  玩家：同一 WiFi 下用浏览器打开 http://<本机IP>:端口/主控台/玩家.html
"""
import os, sys, json, time, socket, threading, re, base64, hashlib, math, random, secrets, shutil, copy, zipfile
import xml.etree.ElementTree as ET
from urllib.parse import urlparse, parse_qs, unquote_to_bytes, quote
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
import tempfile
import sqlite3
from collections import deque
from contextlib import nullcontext
from pathlib import Path

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
# server/ 包归档后，网站根目录始终是其父目录
BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from server.static_policy import static_file_allowed
from server.runtime_config import protocol_version
from server import paths
from server.inventory import CATALOG as ITEM_CATALOG
from server.resources import ResourceStore, projection as character_projection
from server.item_library import ItemLibrary
from server.map_items import MapItems
from server.domain.values import (
    finite_number,
    finite_int,
)
from server.domain.journal import (
    MAX_JOURNAL_ENTRIES,
    MAX_JOURNAL_TITLE,
    MAX_JOURNAL_TOTAL_TEXT,
    JOURNAL_ENTRY_ID_RE,
    JournalMutationError,
    JournalPermissionError,
    journal_clean_title,
    journal_actor_name,
    journal_nonnegative_int,
    journal_world_value,
    journal_entry_id,
    normalize_journal_entry,
    normalize_journal,
    journal_new_id,
    journal_incoming_entry,
    current_campaign_world_seconds,
    mutate_journal,
)
from server.domain.weather import (
    WORLD_SECONDS_PER_DAY,
    WORLD_DAYS_PER_WEEK,
    WORLD_WEEKS_PER_YEAR,
    WEATHER_ROLLOVER_SECONDS,
    MAX_WEATHER_CATCHUP_DAYS,
    WEATHER_KEYS,
    WIND_KEYS,
    WEATHER_TEMPERATURE_DELTAS,
    WEATHER_MARKOV_TRANSITIONS,
    WIND_MARKOV_TRANSITIONS,
    WEATHER_WIND_WEIGHTS,
    CLIMATE_PROFILES,
    weather_day_index,
    weather_season,
    normalize_weather,
    weighted_weather_choice,
    climate_weather_weights,
    weather_wind_weights,
    generate_climate_weather,
    refresh_scheduled_weather,
)
from server.documents import (
    DOCUMENT_EXTS,
    MAX_DOCUMENT_LIBRARY_FILES,
    MAX_DOCUMENT_SOURCE_BYTES,
    MAX_DOCX_ZIP_ENTRIES,
    MAX_DOCX_UNCOMPRESSED_BYTES,
    MAX_DOCX_XML_BYTES,
    MAX_DOCX_COMPRESSION_RATIO,
    MAX_DOCX_PREVIEW_BLOCKS,
    MAX_DOCX_PREVIEW_CHARS,
    DOCX_MIME,
    WORDPROCESSING_NS,
    DocumentPreviewError,
    DocumentTooLargeError,
    _path_within,
    _path_written_or_resolved_within,
    _document_path_is_safe,
    _walk_document_files,
    document_library_catalog,
    _validate_docx_member_name,
    _validate_docx_archive,
    _read_zip_member_limited,
    _docx_text_pieces,
    _docx_style_map,
    _docx_paragraph_kind,
    parse_docx_preview,
)
from server.music_catalog import (
    MUSIC_EXTS,
    MAX_MUSIC_LIBRARY_FILES,
    MUSIC_MIME_TYPES,
    _music_path_is_safe,
    _walk_music_files,
    _safe_music_campaign_name,
    music_library_catalog,
)

STATE = None
CLIENTS = []          # SSEClient instances; only connection threads write sockets.
LOCK = threading.Lock()
RECENT_ACTIONS = []   # 玩家动作（带自增 seq），用于主机合并
NEXT_SEQ = 1
MAX_RECENT = 500
MAX_BODY = 12 * 1024 * 1024
MAP_ASSET_MIMES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}
from server.token_sizes import size_fields, can_ride, mount_anchor, sync_riders, snapped_point

PATCH_FIELDS = {'portraitVariant', 'portraitVariants', 'hp', 'hpMax', 'tempHp', 'tempHpMax', 'ac', 'spellRange', 'conditions'}
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
PLAYER_OWNED_RELEASE_ACTION = 'releaseOwnedPiece'
PLAYER_OWNED_RECALL_ACTION = 'recallOwnedPiece'
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
ASSET_ROOT = str(paths.CACHE_ROOT / '联机资源')
LOCAL_SAVE_ROOT = paths.local_save_root()
# The module also loads when the server is imported by the launcher or tests.
from server import player_profiles as profiles
# One reentrant transaction lock prevents profile/state lock-order deadlocks.
LOCK = profiles.LOCK
def profile_store():
    return profiles.Store(LOCAL_SAVE_ROOT, ROOT, ASSET_ROOT)
from server.reading_share import ReadingShares
READING_SHARES = ReadingShares(profiles.ProfileError)
LOCAL_SAVE_HEADER = 'X-Sundoll-Local-Save'
MAX_LOCAL_SAVE_BODY = 128 * 1024 * 1024
MAX_CAMPAIGN_COVER_BYTES = 8 * 1024 * 1024
CAMPAIGN_COVER_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp')
CAMPAIGN_COVER_FILES = ('封面.webp', '封面.jpg', '封面.jpeg', '封面.png')
CAMPAIGN_COVER_ASSET_CACHE = {}
MUSIC_LIBRARY_ROOT = os.path.join(ROOT, 'asset', '音乐')
MUSIC_CACHE_ROOT = str(paths.MUSIC_CACHE_ROOT)
MUSIC_LIBRARY_INDEX = {}
DOCUMENT_LIBRARY_ROOT = os.path.join(ROOT, 'asset', '文档')
DOCUMENT_LIBRARY_INDEX = {}
# 地图和头像转换为内容哈希 URL，浏览器可长期缓存；资源同时写入磁盘，
# 不再把 Base64 地图和头像塞进每一条 SSE 消息。
from server.asset_cache import AssetCache
ASSETS = AssetCache()  # Disposable bytes; durable assets remain on disk.
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.S)

SESSION_ID = secrets.token_hex(8)
ROOM_CODE = secrets.token_hex(3).upper()
SERVER_PROTOCOL_VERSION = protocol_version()
PUBLIC_BASE_URL = ''
STATE_REVISION = 0
SESSIONS = {}         # {sessionToken: {playerId, name, status, lastSeen}}
ACTION_IDS = {}       # {actionId: seq}，防止网络重试重复执行
MAX_ACTION_IDS = 2000
ACTION_RATE = {}      # {sessionToken: [最近请求时间戳]}
LOGIN_ATTEMPTS = {}
REGISTRATION_ATTEMPTS = {}

def allow_registration_attempt(peer, now=None):
    now = time.monotonic() if now is None else now
    with LOCK:
        for key in list(REGISTRATION_ATTEMPTS):
            if not REGISTRATION_ATTEMPTS[key] or REGISTRATION_ATTEMPTS[key][-1] <= now - 600:
                del REGISTRATION_ATTEMPTS[key]
        recent = [stamp for stamp in REGISTRATION_ATTEMPTS.get(peer, []) if stamp > now - 600]
        if len(recent) >= 10 or (peer not in REGISTRATION_ATTEMPTS and len(REGISTRATION_ATTEMPTS) >= 4096): return False
        REGISTRATION_ATTEMPTS[peer] = recent + [now]
        return True

def allow_credential_attempt(peer, now=None):
    now = time.monotonic() if now is None else now
    with LOCK:
        for key in list(LOGIN_ATTEMPTS):
            if not LOGIN_ATTEMPTS[key] or LOGIN_ATTEMPTS[key][-1] <= now - 60:
                del LOGIN_ATTEMPTS[key]
        recent = [stamp for stamp in LOGIN_ATTEMPTS.get(peer, []) if stamp > now - 60]
        if len(recent) >= 30 or (peer not in LOGIN_ATTEMPTS and len(LOGIN_ATTEMPTS) >= 4096): return False
        LOGIN_ATTEMPTS[peer] = recent + [now]
        return True
HOST_ACTIONS = {'roll', 'announce', 'bgm', 'mapReaction', 'restTransition', 'danmaku'}
DANMAKU_RATE = {}
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


def host_request_allowed(handler):
    if not is_local_request(handler):
        return False
    try:
        host = urlparse('//' + str(handler.headers.get('Host') or ''))
        allowed = {'localhost', '127.0.0.1', '::1'} | set(get_ips())
        if host.hostname not in allowed or host.port not in (None, PORT):
            return False
        origin = handler.headers.get('Origin')
        if origin and origin != 'null':
            parsed = urlparse(origin)
            if parsed.hostname not in allowed or parsed.port not in (None, PORT):
                return False
        elif origin == 'null':
            return False
        return True
    except (ValueError, OSError):
        return False


def token_controller(token):
    if token.get('ownedPieceId'):
        pid = str(token.get('ownerPlayerId') or '')
        return pid if profile_store().owns(pid, token['ownedPieceId']) else '!missing-profile'
    return str(token.get('ownerPlayerId') or token.get('owner') or '').strip()


def normalize_public_base_url(value):
    raw = str(value or '').strip().rstrip('/')
    if not raw:
        return ''
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        return None
    return 'https://' + parsed.netloc


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


# Compatibility facade for callers; implementation and tests live in server.save_storage.
from server import save_storage
from server.module_store import ModuleStore, ASSET_URL
SaveConflict = save_storage.SaveConflict
ProjectServerLock = save_storage.ProjectServerLock
CAMPAIGN_SUMMARIES = save_storage.CAMPAIGN_SUMMARIES

def ensure_local_save_structure(root=None):
    return save_storage.ensure_local_save_structure(root or LOCAL_SAVE_ROOT)

def local_save_target(rel_path, operation, root=None):
    return save_storage.local_save_target(rel_path, operation, root or LOCAL_SAVE_ROOT)

def perform_local_save_operation(data, root=None):
    return save_storage.perform_local_save_operation(data, root or LOCAL_SAVE_ROOT)


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


def portrait_asset_identity(source):
    """为立绘来源生成稳定标识；大图片只比较摘要，避免复制客户端提交内容。"""
    if not isinstance(source, dict):
        return ''
    for field in ('iconImgPath', 'iconImgId'):
        value = source.get(field)
        if value:
            return field + ':' + str(value).replace('\\', '/')[:1024]
    for field in ('iconImgHd', 'iconImg'):
        value = source.get(field)
        if value:
            encoded = str(value).encode('utf-8', errors='ignore')
            return field + ':' + hashlib.sha256(encoded).hexdigest()
    return ''


def sync_downed_portrait(token):
    """Keep a player's downed portrait tied to zero HP, remembering the prior image."""
    if not isinstance(token, dict) or not (token.get('ownedPieceId') or token.get('type') == 'pc'):
        return False
    forms = token.get('portraitVariants') or []
    if not isinstance(forms, list):
        return False
    down = next((i for i, form in enumerate(forms)
                 if isinstance(form, dict) and str(form.get('name') or '').strip().startswith('倒地')), None)
    if down is None:
        return False
    down_identity = portrait_asset_identity(forms[down])
    if not down_identity:
        return False
    current = portrait_asset_identity(token)
    if int(finite_number(token.get('hp')) or 0) == 0:
        if current == down_identity:
            return False
        if current:
            token['portraitBeforeDowned'] = current
        target = down
    elif current == down_identity:
        previous = token.get('portraitBeforeDowned')
        target = next((i for i, form in enumerate(forms)
                       if i != down and portrait_asset_identity(form) == previous and previous), None)
        if target is None:
            target = next((i for i, form in enumerate(forms)
                           if i != down and portrait_asset_identity(form)), None)
        if target is None:
            return False
        token.pop('portraitBeforeDowned', None)
    else:
        token.pop('portraitBeforeDowned', None)
        return False
    for field in ('iconImgPath', 'iconImg', 'iconImgHd', 'iconImgId'):
        token[field] = forms[target].get(field) or None
    token['portraitVariant'] = target
    return True


def sync_all_downed_portraits(state):
    if not isinstance(state, dict):
        return
    for map_obj in state.get('maps') or []:
        for token in map_obj.get('tokens') or []:
            sync_downed_portrait(token)
    for token in (state.get('parkedOwnedPieces') or {}).values():
        sync_downed_portrait(token)


def normalize_player_portrait_variants(raw, token):
    """玩家只能重命名、排序、删除已有形态，或保存棋子当前正在使用的立绘。"""
    if not isinstance(raw, list) or not isinstance(token, dict):
        return None
    allowed = {}
    for source in list(token.get('portraitVariants') or []) + [token]:
        identity = portrait_asset_identity(source)
        if identity and identity not in allowed:
            allowed[identity] = {
                'iconImg': source.get('iconImg') or None,
                'iconImgHd': source.get('iconImgHd') or None,
                'iconImgPath': source.get('iconImgPath') or None,
                'iconImgId': source.get('iconImgId') or None,
            }
    result = []
    used = set()
    for item in raw[:24]:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name') or '').strip()[:24]
        identity = portrait_asset_identity(item)
        if not name or not identity or identity not in allowed or identity in used:
            continue
        variant = {'name': name}
        variant.update(allowed[identity])
        result.append(variant)
        used.add(identity)
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
        'rollSequence': action.get('rollSequence') is True,
        'extraDice': [dict(sides=d['sides'],value=d['value']) for d in (action.get('extraDice') if isinstance(action.get('extraDice'),list) else [])[:10] if isinstance(d,dict) and type(d.get('sides')) is int and d['sides'] in (4,6,8,10,12,20) and type(d.get('value')) is int and 1<=d['value']<=d['sides']],
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
    """Persist before publishing a URL; LRU entries may disappear at any time."""
    path = asset_file(key)
    if not path:
        return False
    try:
        os.makedirs(ASSET_ROOT, exist_ok=True)
        if not os.path.isfile(path):
            temp_path = path + '.' + secrets.token_hex(8) + '.tmp'
            with open(temp_path, 'wb') as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, path)
        with open(path + '.json', 'w', encoding='utf-8') as f:
            json.dump({'mime': mime, 'size': len(raw)}, f, ensure_ascii=False)
        return True
    except OSError:
        try:
            if 'temp_path' in locals() and os.path.isfile(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        return False


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
    if persist_asset(key, mime, raw) is False:
        return value
    ASSETS[key] = (mime, raw)
    return '/api/assets/' + key


def cache_map_asset(value):
    """校验并缓存主控台提供的单张地图，供玩家端后台预载。"""
    if not isinstance(value, str):
        return None
    match = DATA_URL_RE.match(value)
    mime = str(match.group(1) or '').lower() if match else ''
    if not match or mime not in MAP_ASSET_MIMES:
        return None
    cached = cache_data_url(value)
    return cached if isinstance(cached, str) and cached.startswith('/api/assets/') else None


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
    if persist_asset(key, mime, raw) is False:
        return None, '图片写入失败，请检查磁盘空间后重试', 503
    ASSETS[key] = (mime, raw)
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

    from server.workspace import Workspace
    campaigns_root = str(Workspace(LOCAL_SAVE_ROOT).campaigns)
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
        if persist_asset(key, mime, raw) is False:
            return ''
        ASSETS[key] = (mime, raw)
        url = '/api/assets/' + key
        CAMPAIGN_COVER_ASSET_CACHE[path] = (signature[0], signature[1], url)
        return url
    except OSError:
        return ''


def module_support_roots(folder):
    from server.workspace import Workspace
    return [str(p) for p in Workspace(LOCAL_SAVE_ROOT).support_roots(folder)]


def refresh_music_library(campaign_id='', campaign_name=''):
    catalog = music_library_catalog(MUSIC_LIBRARY_ROOT, campaign_id, campaign_name)
    index = catalog.pop('_index')
    for support_root in module_support_roots('音乐'):
        extra = music_library_catalog(support_root, campaign_id, campaign_name)
        catalog['tracks'].extend(extra['tracks'])
        index.update(extra['_index'])
    with LOCK:
        MUSIC_LIBRARY_INDEX.clear()
        MUSIC_LIBRARY_INDEX.update(index)
    return catalog


def refresh_document_library(campaign_id='', campaign_name=''):
    catalog = document_library_catalog(DOCUMENT_LIBRARY_ROOT, campaign_id, campaign_name)
    index = catalog.pop('_index')
    for support_root in module_support_roots('文档'):
        extra = document_library_catalog(support_root, campaign_id, campaign_name)
        catalog['documents'].extend(extra['documents'])
        index.update(extra['_index'])
    with LOCK:
        DOCUMENT_LIBRARY_INDEX.clear()
        DOCUMENT_LIBRARY_INDEX.update(index)
    return catalog


def document_request_allowed(handler):
    """战役文档只对同源的本机主控台开放，反向隧道和跨站页面均拒绝。"""
    if not is_local_request(handler):
        return False
    host_header = str(handler.headers.get('Host') or '').strip()
    try:
        host_url = urlparse('//' + host_header)
        host_name = (host_url.hostname or '').lower().rstrip('.')
        host_port = host_url.port
    except ValueError:
        return False
    allowed_hosts = {'localhost', '127.0.0.1', '::1'}
    try:
        allowed_hosts.update(str(item).lower().split('%', 1)[0] for item in get_ips())
    except Exception:
        pass
    if not host_name or host_name not in allowed_hosts or host_port not in (None, PORT):
        return False
    origin = str(handler.headers.get('Origin') or '').strip()
    if origin:
        try:
            origin_url = urlparse(origin)
            if (origin_url.scheme != 'http'
                    or (origin_url.hostname or '').lower().rstrip('.') != host_name
                    or origin_url.port not in (None, PORT)):
                return False
        except ValueError:
            return False
    fetch_site = str(handler.headers.get('Sec-Fetch-Site') or '').strip().lower()
    if fetch_site and fetch_site not in ('same-origin', 'none'):
        return False
    return True


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
    map_obj = next((m for m in (state or {}).get('maps', []) if any(t.get('id') == token.get('id') for t in m.get('tokens', []))), {})
    ids = {token.get('id'), mount_anchor(token, map_obj).get('id')}
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
    direct_owner = token_controller(token)
    if direct_owner:
        return direct_owner == player
    if not token.get('id'):
        return False
    for m in (state or {}).get('maps', []) or []:
        for candidate in m.get('tokens', []) or []:
            if candidate is not token and mount_anchor(candidate, m).get('id') == token.get('id') and token_controller(candidate) == player:
                return True
    return False


def turn_controllers(state, current_token):
    """当前先攻棋子有明确归属时只认该玩家；无归属时再继承骑乘控制组的归属。"""
    if not isinstance(current_token, dict):
        return set()
    direct_owner = token_controller(current_token)
    if direct_owner:
        return {direct_owner}
    group = token_control_group(state, current_token)
    owners = set()
    for map_obj in (state or {}).get('maps', []) or []:
        for candidate in map_obj.get('tokens', []) or []:
            owner = token_controller(candidate)
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
        mount = mount_anchor(located, map_obj)
    elif any(isinstance(item, dict) and item.get('mountId') == located.get('id') for item in tokens):
        mount = located
    if not mount:
        return None, []
    riders = [item for item in tokens
              if isinstance(item, dict) and item is not mount and mount_anchor(item, map_obj).get('id') == mount.get('id')]
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
        if (not keeper_token or not token_controller(keeper_token)) and discarded_token and token_controller(discarded_token):
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
            'actor': str(player or '')[:64],
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
        if candidate.get('id') == mount_id and can_ride(token, candidate):
            return mount_anchor(token, m)
    return token


def empty_turn_path():
    return {'mapId': None, 'tokenId': None, 'points': [], 'segmentEnds': []}


def normalize_turn_path_segment_ends(raw_ends, point_count):
    """把每次鼠标松开的位置整理成严格递增的路径索引。"""
    try:
        last_point_index = max(0, int(point_count) - 1)
    except (TypeError, ValueError):
        last_point_index = 0
    if last_point_index < 1:
        return []
    ends = []
    for raw in raw_ends if isinstance(raw_ends, list) else []:
        if isinstance(raw, bool):
            continue
        number = finite_number(raw)
        if number is None or int(number) != number:
            continue
        end = int(number)
        if 1 <= end <= last_point_index and (not ends or end > ends[-1]):
            ends.append(end)
    # 升级前的路径只有 points；兼容时把整条旧路径视为一次已经完成的拖动。
    if not ends or ends[-1] != last_point_index:
        ends.append(last_point_index)
    return ends


def encounter_state(state):
    encounter = (state or {}).get('encounter')
    if isinstance(encounter, dict):
        if encounter.get('playMode') == 'turn' and not (encounter.get('entries') or []):
            encounter['playMode'] = 'prepare'
            encounter['currentEntryId'] = None
            encounter['round'] = 1
            encounter['turnPath'] = empty_turn_path()
        path = encounter.get('turnPath')
        if not isinstance(path, dict):
            encounter['turnPath'] = empty_turn_path()
        else:
            points = path.get('points') if isinstance(path.get('points'), list) else []
            path['points'] = points
            path['segmentEnds'] = normalize_turn_path_segment_ends(path.get('segmentEnds'), len(points))
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
    # 生命值可在任意角色的回合调整；混合其他字段的请求仍按回合校验。
    patch = action.get('patch')
    if (action.get('op') == 'patchToken' and isinstance(patch, dict) and patch
            and set(patch) <= {'hp', 'hpMax', 'tempHp', 'tempHpMax'}):
        serial = finite_number(action.get('turnSerial'))
        if serial is None or int(serial) != encounter_turn_serial(state):
            return False, '回合已经变化，请重新操作'
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
    margin = grid * size / 2
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
    actor = str(player or '').strip()[:64]
    if not actor:
        return None, '缺少玩家名', 400
    tokens = map_obj.get('tokens') if isinstance(map_obj.get('tokens'), list) else []
    owned_temp_count = sum(
        1 for token in tokens
        if isinstance(token, dict) and token.get('playerCreated') is True
        and token_controller(token) == actor
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
    dimensions = size_fields(draft)
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
        **dimensions,
        'hp': hp_max,
        'hpMax': hp_max,
        'ac': ac,
        'spellRange': normalize_spell_range(None),
        'conditions': [],
        'publicNote': '',
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


def owned_piece_locations(state, oid):
    locations = [(m, t) for m in state.get('maps', []) for t in m.get('tokens', [])
                 if isinstance(t, dict) and t.get('ownedPieceId') == oid]
    ids = {(m.get('id'), t.get('id')) for m, t in locations}
    for entry in state.get('_ownedPieceLocations', []):
        token = entry.get('token', {})
        if token.get('ownedPieceId') == oid and (entry.get('mapId'), token.get('id')) not in ids:
            locations.append(({'id': entry.get('mapId'), 'playerAccessible': False}, token))
            ids.add((entry.get('mapId'), token.get('id')))
    return locations


def character_updates(state, public=False):
    result = []
    seen = set()
    for m in (state or {}).get('maps', []):
        if public and m.get('playerAccessible') is not True: continue
        for t in m.get('tokens', []):
            oid = t.get('ownedPieceId')
            if not oid or oid in seen or not t.get('characterRevision') or (public and t.get('hiddenFromPlayers')): continue
            seen.add(oid)
            patch = {k: t[k] for k in ('name','hp','hpMax','tempHp','tempHpMax','ac','level','characterRevision','conditions','spellSlots','resourceSlots') if k in t}
            if any(isinstance(form, dict) and str(form.get('name') or '').strip().startswith('倒地')
                   for form in t.get('portraitVariants') or []):
                patch.update(portraitVariant=t.get('portraitVariant'), portraitBeforeDowned=t.get('portraitBeforeDowned'))
            result.append(dict(op='characterState', characterId=oid, ownerPlayerId=t.get('ownerPlayerId'), patch=patch))
    if not public:
        for entry in (state or {}).get('_ownedPieceLocations', []):
            t = entry.get('token', {}); oid = t.get('ownedPieceId')
            if oid and oid not in seen and t.get('characterRevision'):
                seen.add(oid)
                patch = {k:t[k] for k in ('name','hp','hpMax','tempHp','tempHpMax','ac','level','characterRevision','conditions','spellSlots','resourceSlots') if k in t}
                if any(isinstance(form, dict) and str(form.get('name') or '').strip().startswith('倒地')
                       for form in t.get('portraitVariants') or []):
                    patch.update(portraitVariant=t.get('portraitVariant'), portraitBeforeDowned=t.get('portraitBeforeDowned'))
                result.append(dict(op='characterState', characterId=oid, ownerPlayerId=t.get('ownerPlayerId'), patch=patch))
    if public:
        for action in result:
            action['publicProjection'] = True
            if 'conditions' in action['patch']:
                action['patch']['conditions'] = [c for c in action['patch']['conditions'] if isinstance(c, dict) and c.get('visibility') != 'gm']
    return result


def sync_changed_owned_tokens(previous, updated):
    if not previous or previous.get('campaignId') != updated.get('campaignId'): return
    ids = {t.get('ownedPieceId') for m in updated.get('maps', []) for t in m.get('tokens', []) if t.get('ownedPieceId')}
    ids.update(e.get('token', {}).get('ownedPieceId') for e in updated.get('_ownedPieceLocations', []))
    ids.update((updated.get('parkedOwnedPieces') or {}).keys())
    watched = ('name','hp','hpMax','tempHp','tempHpMax','ac','size','sizeCategory','publicNote','spellRange','conditions','portraitVariants','portraitVariant','iconImgPath','iconImgHd','iconImg')
    for oid in ids:
        before = owned_piece_locations(previous, oid); after = owned_piece_locations(updated, oid)
        parked = (updated.get('parkedOwnedPieces') or {}).get(oid)
        if not after and isinstance(parked, dict): after = [(None, parked)]
        if len(before) != 1 or len(after) != 1: continue
        token = after[0][1]; old = before[0][1]
        if token.get('ownerPlayerId') != old.get('ownerPlayerId'): continue
        if any(old.get(k) != token.get(k) for k in watched) and profile_store().owns(token.get('ownerPlayerId'), oid):
            profile_store().sync_token(token['ownerPlayerId'], token, updated.get('campaignId'))


def normalize_player_owned_recall_action(state, requested, player_id):
    oid = str(requested.get('ownedPieceId') or '')
    if not profile_store().owns(player_id, oid):
        return None, '只能收回自己的棋子', 403
    locations = owned_piece_locations(state, oid)
    if len(locations) > 1:
        return None, '存在重复棋子身份，请主控检查存档', 409
    if not locations:
        return {'op': PLAYER_OWNED_RECALL_ACTION, 'ownedPieceId': oid, 'actor': player_id, 'toBasket': requested.get('toBasket') is True}, None, 200
    source, token = locations[0]
    if token.get('ownerPlayerId') != player_id:
        return None, '棋子归属已变化', 403
    return {'op': PLAYER_OWNED_RECALL_ACTION, 'ownedPieceId': oid, 'actor': player_id,
            'mapId': source['id'], 'tokenId': token['id'], 'token': copy.deepcopy(token), 'toBasket': requested.get('toBasket') is True}, None, 200


def normalize_player_owned_release_action(state, requested, player_id, display_name):
    """从服务器保存的个人小库释放棋子，不信任客户端提交的棋子资料。"""
    if not isinstance(requested, dict) or requested.get('op') != PLAYER_OWNED_RELEASE_ACTION:
        return None, '个人棋子请求无效', 400
    map_obj = find_map(state, requested.get('mapId'))
    if not map_obj:
        return None, '当前地图不存在', 404
    if map_obj.get('playerAccessible') is not True:
        return None, '这张地图尚未向玩家开放', 403
    owned_piece_id = str(requested.get('ownedPieceId') or '')
    try:
        library = profile_store().library(player_id)
    except profiles.ProfileError as error:
        return None, str(error), error.status
    piece = next((item for item in library.get('pieces', [])
                  if item.get('ownedPieceId') == owned_piece_id), None)
    if not piece:
        return None, '这枚棋子不在你的个人小库中', 403

    active = owned_piece_locations(state, owned_piece_id)
    if len(active) > 1:
        return None, '本战役存在重复的个人棋子身份，请联系主控检查存档', 409

    if active and active[0][1].get('ownerPlayerId') != player_id:
        return None, '棋子归属已变化', 403
    source_map = active[0][0] if active else None
    if requested.get('fromBasket') is True and active and source_map.get('id') != map_obj.get('id'):
        return None, '这枚棋子已经抵达其他地图，请刷新队伍', 409
    if active:
        token = copy.deepcopy(active[0][1])
    else:
        parked = (state.get('parkedOwnedPieces') or {}).get(owned_piece_id)
        if isinstance(parked, dict):
            token = copy.deepcopy(parked)
        else:
            token = copy.deepcopy(piece)
            token.update({
                'id': 'ot-' + re.sub(r'[^A-Za-z0-9_-]', '', str(player_id))[:24] + '-' + secrets.token_hex(6),
                'hp': piece.get('hpMax', 10),
                'tempHp': 0,
                'conditions': [],
            })
            token.update(copy.deepcopy(piece.get('campaignStates', {}).get(state.get('campaignId'), {})))
    canonical = ResourceStore(profile_store(), profiles).character(state.get('campaignId'), owned_piece_id)
    if canonical and canonical['ownerPlayerId'] == player_id and (piece.get('characterId') or token.get('characterRevision') != canonical['revision']): token.update(character_projection(canonical))
    forms = copy.deepcopy(token.get('portraitVariants') or [])
    seen = {portrait_asset_identity(v) for v in forms}
    for variant in piece.get('portraitVariants') or []:
        identity = portrait_asset_identity(variant)
        if identity and identity not in seen and len(forms) < 24:
            forms.append(copy.deepcopy(variant)); seen.add(identity)
    token.pop('campaignStates', None)
    token.pop('mapSyncStates', None)
    token['portraitVariants'] = forms
    token['sourcePresetId'] = piece.get('sourcePresetId') or token.get('sourcePresetId', '')
    selected_form = next((i for i,v in enumerate(forms) if portrait_asset_identity(v) == portrait_asset_identity(token)), None)
    if selected_form is None: token.pop('portraitVariant', None)
    else: token['portraitVariant'] = selected_form
    token['ownerPlayerId'] = player_id
    token['owner'] = str(display_name or '玩家')[:24]
    token['ownedPieceId'] = owned_piece_id
    token['ownedPieceRevision'] = piece.get('revision')
    token['playerCreated'] = False
    token['createdByPlayer'] = ''
    token['groupKey'] = None
    token['mountId'] = None
    token['hiddenFromPlayers'] = False
    token['spellRange'] = normalize_spell_range(token.get('spellRange'))
    token['conditions'] = copy.deepcopy(token.get('conditions')) if isinstance(token.get('conditions'), list) else []
    arrival = requested.get('position') if requested.get('fromBasket') is True and not active else None
    if requested.get('fromBasket') is True and not active and ((state.get('parkedOwnedPieces') or {}).get(owned_piece_id) or {}).get('travelBasketStored') is not True:
        return None, '这枚棋子已不在旅行篮子中，请刷新队伍', 409
    point = clamp_token_point(map_obj, token, arrival if isinstance(arrival, dict) else {
        'x': token.get('x', (finite_number(map_obj.get('mapW')) or 1400) / 2),
        'y': token.get('y', (finite_number(map_obj.get('mapH')) or 900) / 2),
    })
    if point is None:
        return None, '放置位置无效', 400
    if state.get('snap') is not False: point = snapped_point(map_obj, token, point)
    if requested.get('fromBasket') is True and not active:
        grid = finite_number(map_obj.get('gridSize')) or 50
        offsets = sorted(((x,y) for x in range(-7,8) for y in range(-7,8)), key=lambda p:p[0]**2+p[1]**2)
        center = point
        point = None
        for dx,dy in offsets:
            candidate = clamp_token_point(map_obj, token, {'x':center['x']+dx*grid,'y':center['y']+dy*grid})
            if state.get('snap') is not False: candidate = snapped_point(map_obj, token, candidate)
            if not any(abs((finite_number(t.get('x')) or 0)-candidate['x']) < (size_fields(t)['size']+size_fields(token)['size'])*grid/2
                       and abs((finite_number(t.get('y')) or 0)-candidate['y']) < (size_fields(t)['size']+size_fields(token)['size'])*grid/2
                       for t in map_obj.get('tokens', [])):
                point = candidate
                break
        if point is None: return None, '目标附近没有空位，请移动视野后重试', 409
    token.update(point)
    return {
        'op': PLAYER_OWNED_RELEASE_ACTION,
        'mapId': map_obj.get('id'),
        'sourceMapId': source_map.get('id') if source_map else None,
        'ownedPieceId': owned_piece_id,
        'tokenId': token.get('id'),
        'token': token,
        'actor': player_id,
        'name': str(display_name or '玩家')[:24],
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
    actor = str(player or '').strip()[:64]
    owner = token_controller(token)
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
    actor = str(player or '').strip()[:64]
    if not actor or token_controller(rider) != actor:
        return None, '只能让自己的角色上骑', 403
    if rider.get('hiddenFromPlayers') is True:
        return None, '这个角色当前不可见', 403
    if rider.get('mountId'):
        return None, '这个角色已经在坐骑上', 409

    mount_map, mount = find_token(state, requested.get('mountId'))
    if not mount_map or not mount:
        return None, '目标坐骑不存在', 404
    if mount_map is not map_obj or mount.get('id') == rider.get('id'):
        return None, '骑手与坐骑必须在同一张地图', 400
    if mount.get('hiddenFromPlayers') is True:
        return None, '该坐骑当前不可见', 403
    if not can_ride(rider, mount):
        return None, '坐骑的体型必须比骑手至少大一级', 409
    mount_owner = token_controller(mount)
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
    actor = str(player or '').strip()[:64]
    if not actor or token_controller(rider) != actor:
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
    if action.get('campaignId') is not None and action.get('campaignId') != state.get('campaignId'):
        return False
    if action.get('_sessionId') is not None and action.get('_sessionId') != SESSION_ID:
        return False
    op = action.get('op')
    if op == 'characterState':
        for _, token in owned_piece_locations(state, action.get('characterId')):
            if token.get('ownerPlayerId') == action.get('ownerPlayerId') and token.get('characterRevision', 0) <= action['patch']['characterRevision']:
                token.update(copy.deepcopy(action['patch']))
        parked = state.get('parkedOwnedPieces', {}).get(action.get('characterId'))
        if parked and parked.get('ownerPlayerId') == action.get('ownerPlayerId'): parked.update(copy.deepcopy(action['patch']))
        return True
    if op == 'journalEdit':
        if not isinstance(state, dict) or action.get('campaignId') != state.get('campaignId'):
            return False
        incoming = action.get('journal')
        if not isinstance(incoming, dict):
            return False
        campaign_id = str(state.get('campaignId') or '').strip()
        if incoming.get('campaignId') and str(incoming.get('campaignId')).strip() != campaign_id:
            return False
        current = normalize_journal(state.get('journal'), campaign_id)
        next_journal = normalize_journal(incoming, campaign_id)
        if current['revision'] < next_journal['revision']:
            state['journal'] = copy.deepcopy(next_journal)
        return True
    if op == PLAYER_SPAWN_ACTION:
        map_obj = find_map(state, action.get('mapId'))
        token = action.get('token')
        actor = str(action.get('actor') or '').strip()
        if not map_obj or not isinstance(token, dict) or not actor:
            return False
        token_id = str(token.get('id') or '')
        if (not token_id.startswith('pt-') or token.get('playerCreated') is not True
                or token.get('type') != 'pc' or token_controller(token) != actor):
            return False
        tokens = map_obj.get('tokens')
        if not isinstance(tokens, list):
            tokens = []
            map_obj['tokens'] = tokens
        existing = next((item for item in tokens if isinstance(item, dict) and item.get('id') == token_id), None)
        if existing:
            return token_controller(existing) == actor and existing.get('playerCreated') is True
        tokens.append(dict(token))
        return True
    if op == PLAYER_OWNED_RELEASE_ACTION:
        target = find_map(state, action.get('mapId'))
        raw = action.get('token')
        owned_piece_id = str(action.get('ownedPieceId') or '')
        actor = str(action.get('actor') or '')
        if (not target or not isinstance(raw, dict) or not owned_piece_id
                or raw.get('ownedPieceId') != owned_piece_id
                or raw.get('ownerPlayerId') != actor):
            return False
        known = owned_piece_locations(state, owned_piece_id)
        if len(known) > 1 or any(t.get('ownerPlayerId') != actor for _, t in known): return False
        matches = []
        for map_obj in state.get('maps', []) or []:
            for token in map_obj.get('tokens', []) or []:
                if isinstance(token, dict) and token.get('ownedPieceId') == owned_piece_id:
                    matches.append((map_obj, token))
        if len(matches) > 1:
            return False
        for map_obj, token in matches:
            map_obj['tokens'] = [item for item in map_obj.get('tokens', [])
                                 if not isinstance(item, dict) or item.get('ownedPieceId') != owned_piece_id]
            for candidate in map_obj.get('tokens', []) or []:
                if isinstance(candidate, dict) and candidate.get('mountId') == token.get('id'):
                    candidate['mountId'] = None
        state['_ownedPieceLocations'] = [e for e in state.get('_ownedPieceLocations', []) if e.get('token', {}).get('ownedPieceId') != owned_piece_id]
        target.setdefault('tokens', []).append(copy.deepcopy(raw))
        parked = state.get('parkedOwnedPieces')
        if isinstance(parked, dict):
            parked.pop(owned_piece_id, None)
        return True
    if op == 'bindOwnedPiece':
        _, token = find_token(state, action.get('tokenId'))
        ownership = action.get('ownership', {})
        if not token or not ownership.get('ownedPieceId') or ownership.get('ownerPlayerId') != action.get('actor'): return False
        if token.get('ownedPieceId') and token.get('ownedPieceId') != ownership['ownedPieceId']: return False
        if not can_control(state, token, action['actor']): return False
        token.update(copy.deepcopy(ownership)); return True
    if op == PLAYER_OWNED_RECALL_ACTION:
        oid = action.get('ownedPieceId')
        locations = owned_piece_locations(state, oid)
        if len(locations) > 1: return False
        if not locations:
            parked = (state.get('parkedOwnedPieces') or {}).get(oid)
            if parked and parked.get('ownerPlayerId') == action.get('actor') and action.get('toBasket') is not True: parked['travelBasketStored'] = False
            return True
        source, token = locations[0]
        if token.get('ownerPlayerId') != action.get('actor'): return False
        recorded = action.get('token')
        if recorded and (recorded.get('ownedPieceId') != oid or recorded.get('ownerPlayerId') != action.get('actor')): return False
        parked = copy.deepcopy(recorded or token); parked['mountId'] = None
        parked['travelBasketStored'] = action.get('toBasket') is True
        state.setdefault('parkedOwnedPieces', {})[oid] = parked
        for map_obj in state.get('maps', []):
            map_obj['tokens'] = [t for t in map_obj.get('tokens', []) if t.get('ownedPieceId') != oid]
            for rider in map_obj['tokens']:
                if rider.get('mountId') == token.get('id'): rider['mountId'] = None
        state['_ownedPieceLocations'] = [e for e in state.get('_ownedPieceLocations', []) if e.get('token', {}).get('ownedPieceId') != oid]
        encounter = encounter_state(state)
        removed = {e.get('id') for e in encounter.get('entries', []) if e.get('tokenId') == token.get('id')}
        encounter['entries'] = [e for e in encounter.get('entries', []) if e.get('id') not in removed]
        if encounter.get('currentEntryId') in removed:
            encounter['currentEntryId'] = next((e.get('id') for e in encounter['entries']), None)
            encounter['turnSerial'] = encounter_turn_serial(state) + 1
            encounter['turnPath'] = empty_turn_path()
        if encounter.get('turnPath', {}).get('tokenId') == token.get('id'):
            encounter['turnPath'] = empty_turn_path()
        if encounter.get('playMode') == 'turn' and not encounter['entries']:
            encounter['playMode'] = 'prepare'; encounter['round'] = 1
        action['encounter'] = copy.deepcopy(encounter)
        return True
    if op == PLAYER_DELETE_ACTION:
        map_obj = find_map(state, action.get('mapId'))
        token_id = str(action.get('tokenId') or '')
        actor = str(action.get('actor') or '').strip()
        if not map_obj or not token_id.startswith('pt-') or not actor:
            return False
        tokens = map_obj.get('tokens') if isinstance(map_obj.get('tokens'), list) else []
        token = next((item for item in tokens if isinstance(item, dict) and item.get('id') == token_id), None)
        if token and (token.get('playerCreated') is not True or token_controller(token) != actor):
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
            encounter['turnPath'] = empty_turn_path()
        if encounter.get('playMode') == 'turn' and not encounter['entries']:
            encounter['playMode'] = 'prepare'
            encounter['currentEntryId'] = None
            encounter['round'] = 1
            encounter['turnPath'] = empty_turn_path()
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
        if action.get('mapId') != map_obj.get('id') or token_controller(rider) != actor:
            return False
        if rider.get('hiddenFromPlayers') is True or mount.get('hiddenFromPlayers') is True:
            return False
        if not can_ride(rider, mount):
            return False
        mount_owner = token_controller(mount)
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
        sync_riders(map_obj)
        initiative_changed = reconcile_mounted_initiative_entries(state)
        if encounter.get('playMode') != 'free' and (invalidates_turn or initiative_changed):
            encounter['turnSerial'] = encounter_turn_serial(state) + 1
            encounter['turnPath'] = empty_turn_path()

        action['x'] = rider.get('x')
        action['y'] = rider.get('y')
        action['initiativeEntries'] = copy.deepcopy(encounter.get('entries', []) or [])
        action['currentEntryId'] = encounter.get('currentEntryId')
        action['encounterPlayMode'] = encounter.get('playMode')
        action['round'] = max(1, int(finite_number(encounter.get('round')) or 1))
        action['turnSerial'] = encounter_turn_serial(state)
        action['turnPath'] = copy.deepcopy(encounter.get('turnPath') or empty_turn_path())
        return True
    if op == PLAYER_DISMOUNT_ACTION:
        map_obj, rider = find_token(state, action.get('tokenId'))
        actor = str(action.get('actor') or '').strip()
        mount_id = str(action.get('mountId') or '').strip()
        if not map_obj or not rider or not actor or not mount_id:
            return False
        if action.get('mapId') != map_obj.get('id') or token_controller(rider) != actor:
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
        if state.get('snap') is not False:
            rider.update(snapped_point(map_obj, rider, {'x': float(rider.get('x') or 0), 'y': float(rider.get('y') or 0)}))
        action['x'], action['y'] = rider.get('x'), rider.get('y')
        sync_riders(map_obj)
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
        encounter['turnPath'] = empty_turn_path()
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
        encounter['turnPath'] = empty_turn_path()
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
        variants_patch_accepted = False
        if 'portraitVariants' in patch:
            current_portrait = portrait_asset_identity(t)
            variants = normalize_player_portrait_variants(patch.get('portraitVariants'), t)
            if variants is not None:
                t['portraitVariants'] = variants
                patch['portraitVariants'] = [dict(variant) for variant in variants]
                selected_index = next((index for index, variant in enumerate(variants)
                                       if portrait_asset_identity(variant) == current_portrait), None)
                if selected_index is None:
                    t.pop('portraitVariant', None)
                    patch['portraitVariant'] = None
                else:
                    t['portraitVariant'] = selected_index
                    patch['portraitVariant'] = selected_index
                accepted = True
                variants_patch_accepted = True
        for k, v in list(patch.items()):
            if k not in PATCH_FIELDS:
                continue
            if k == 'portraitVariants':
                continue
            if k == 'portraitVariant':
                if v is None:
                    if variants_patch_accepted:
                        t.pop('portraitVariant', None)
                        accepted = True
                    continue
                variants = t.get('portraitVariants') or []
                if 'portraitVariantSource' in patch:
                    requested_identity = portrait_asset_identity(patch['portraitVariantSource'])
                    match = next((i for i,form in enumerate(variants) if requested_identity and portrait_asset_identity(form) == requested_identity), None)
                    if match is None: continue
                    v = match
                    patch['portraitVariant'] = v
                if type(v) is not int or v < 0 or v >= len(variants):
                    continue
                variant = variants[v]
                if not isinstance(variant, dict):
                    continue
                for field in ('iconImgPath', 'iconImg', 'iconImgHd', 'iconImgId'):
                    t[field] = variant.get(field) or None
                t[k] = v
                accepted = True
            elif k in ('hp', 'tempHp', 'tempHpMax'):
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
        if accepted and sync_downed_portrait(t):
            patch['portraitVariant'] = t['portraitVariant']
            patch['portraitBeforeDowned'] = t.get('portraitBeforeDowned')
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
            raw_segment_ends = action.get('segmentEnds')
        else:
            raw_points = existing.get('points', []) or []
            raw_segment_ends = existing.get('segmentEnds')
        points = []
        for raw_point in raw_points:
            if not isinstance(raw_point, dict):
                return False
            normalized = clamp_token_point(m, t, raw_point)
            if normalized is None:
                return False
            if not points or not same_point(points[-1], normalized):
                points.append(normalized)
        segment_ends = normalize_turn_path_segment_ends(raw_segment_ends, len(points))
        if not canonical_replay:
            if len(points) < 2:
                return False
            if op == 'turnPathUndo':
                previous_segment_end = segment_ends[-2] if len(segment_ends) > 1 else 0
                points = points[:previous_segment_end + 1]
                segment_ends = segment_ends[:-1]
            else:
                points = points[:1]
                segment_ends = []
            action['pathMode'] = 'replace'
            action['path'] = [dict(candidate) for candidate in points]
            action['segmentEnds'] = list(segment_ends)
        if not points or len(points) > MAX_TURN_PATH_POINTS:
            return False
        segment_ends = normalize_turn_path_segment_ends(segment_ends, len(points))
        target = points[-1]
        encounter['turnPath'] = {
            'mapId': m.get('id'),
            'tokenId': t.get('id'),
            'points': [dict(candidate) for candidate in points],
            'segmentEnds': list(segment_ends),
        }
        t['x'] = target['x']
        t['y'] = target['y']
        sync_riders(m)
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
            existing_segment_ends = []
            if isinstance(existing, dict) and existing.get('mapId') == m.get('id') and existing.get('tokenId') == t.get('id'):
                for raw_point in existing.get('points', []) or []:
                    if isinstance(raw_point, dict):
                        normalized = clamp_token_point(m, t, raw_point)
                        if normalized is not None:
                            existing_points.append(normalized)
                existing_segment_ends = normalize_turn_path_segment_ends(
                    existing.get('segmentEnds'), len(existing_points)
                )
            if existing_points and not same_point(existing_points[-1], fragment[0]):
                existing_points = []
                existing_segment_ends = []
            combined = existing_points[:]
            segment_ends = existing_segment_ends[:]
            previous_length = len(combined)
            for candidate in fragment:
                if not combined or not same_point(combined[-1], candidate):
                    combined.append(candidate)
            if len(combined) > previous_length:
                segment_ends.append(len(combined) - 1)
            if len(combined) > MAX_TURN_PATH_POINTS:
                combined = combined[:MAX_TURN_PATH_POINTS - 1] + [combined[-1]]
                segment_ends = [end for end in segment_ends if end < MAX_TURN_PATH_POINTS - 1]
                segment_ends.append(MAX_TURN_PATH_POINTS - 1)
            encounter['turnPath'] = {
                'mapId': m.get('id'),
                'tokenId': t.get('id'),
                'points': combined,
                'segmentEnds': normalize_turn_path_segment_ends(segment_ends, len(combined)),
            }
            t['x'] = point['x']
            t['y'] = point['y']
            action['turnSerial'] = serial
            action['path'] = fragment
        else:
            encounter['turnPath'] = empty_turn_path()
            action.pop('path', None)
            t['x'] = point['x']
            t['y'] = point['y']
        sync_riders(m)
        return True
    return False


def state_snapshot(now=None):
    """返回带联机元数据的快照；调用方须在 LOCK 内调用。"""
    if STATE is None:
        return None
    snapshot = {k: v for k, v in STATE.items() if k not in ('_ownedPieceLocations', 'parkedOwnedPieces', 'travelBasketTokens')}
    snapshot['maps'] = [dict(m, tokens=[dict(t, conditions=[c for c in t.get('conditions', []) if isinstance(c, dict) and c.get('visibility') != 'gm']) for t in m.get('tokens', [])]) for m in STATE.get('maps', [])]
    snapshot['_sessionId'] = SESSION_ID
    snapshot['_roomCode'] = ROOM_CODE
    snapshot['_stateRevision'] = STATE_REVISION
    snapshot['_serverNow'] = int(now or time.time() * 1000)
    snapshot['_bgm'] = dict(BGM_STATE)
    return snapshot


def normalized_media_url(value):
    if not isinstance(value, str): return ''
    value = unquote_to_bytes(urlparse(value).path).decode('utf-8', 'replace')
    while value.startswith('../'): value = value[3:]
    return '/' + value.lstrip('./')


def module_asset_is_public(url, state):
    """Authorize only currently revealed media, never arbitrary nested GM data."""
    # The login page publishes this cover before a player session exists.
    # Resolve it from the active campaign, never trust arbitrary nested URLs.
    cover = campaign_cover_asset_url(state) if isinstance(state, dict) and normalized_media_url(url).startswith('/api/assets/') else ''
    if cover and normalized_media_url(url) == normalized_media_url(cover):
        return True
    for m in (state or {}).get('maps', []):
        if not isinstance(m, dict) or m.get('playerAccessible') is not True:
            continue
        if normalized_media_url(m.get('mapData')) == normalized_media_url(url):
            return True
        for token in m.get('tokens', []):
            if token.get('hiddenFromPlayers'):
                continue
            if normalized_media_url(url) in [normalized_media_url(token.get(k)) for k in ('iconImg','iconImgHd','iconImgPath')]:
                return True
    return False


def owned_media_urls(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ('iconImgPath','iconImg','iconImgHd','image','assetUrl','fileUrl') and isinstance(child, str):
                yield normalized_media_url(child)
            elif isinstance(child, (dict,list)):
                yield from owned_media_urls(child)
    elif isinstance(value, list):
        for child in value: yield from owned_media_urls(child)


def private_media_allowed(handler, url):
    if host_request_allowed(handler) or module_asset_is_public(url, STATE): return True
    try:
        cookie = SimpleCookie(str(handler.headers.get('Cookie') or ''))
        token = cookie.get('sundoll-media-session')
        session = touch_session(token.value if token else '')
        if not session or not session.get('persistent'): return False
        store = profile_store()
        pid = session['playerId']
        if normalized_media_url(url) in owned_media_urls(store.library(pid)): return True
        return normalized_media_url(url) in owned_media_urls(ResourceStore(store, profiles).read(pid))
    except (ValueError, OSError, sqlite3.Error, profiles.ProfileError):
        return False


def public_player_session(session):
    return {key: value for key, value in session.items() if key != 'token' and not key.startswith('_')}


def touch_session(token, status=None):
    session = SESSIONS.get(str(token or ''))
    if not session:
        return None
    if (int(time.time()*1000) - int(session.get('lastSeen', 0)) > 24*60*60*1000
            or (session.get('persistent') and not profile_store().session_valid(session.get('playerId'), session.get('_authVersion')))):
        SESSIONS.pop(str(token), None)
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
    """One room member per identity, independent of the number of login sessions."""
    now = int(time.time() * 1000)
    cutoff = now - 35000
    members = {}
    with LOCK:
        for session in SESSIONS.values():
            seen = int(session.get('lastSeen', 0))
            if now - seen > 24 * 60 * 60 * 1000:
                continue
            item = public_player_session(session)
            item['online'] = seen >= cutoff and session.get('status') != 'offline'
            # Guest sessions are temporary room visitors, not archived player profiles.
            if not session.get('persistent') and not item['online']:
                continue
            pid = session.get('playerId')
            if not pid:
                continue
            previous = members.get(pid)
            if previous is None or (item['online'], seen) > (previous['online'], int(previous.get('lastSeen', 0))):
                members[pid] = item
    return sorted(members.values(), key=lambda item: (not item['online'], item.get('name', '').lower()))


def revoke_player_sessions(player_id):
    """撤销一个玩家身份的全部会话；调用方在共享服务器状态下须持有 LOCK。"""
    target = str(player_id or '').strip()
    if not target:
        return []
    removed = []
    for token, session in list(SESSIONS.items()):
        if str(session.get('playerId') or '') != target:
            continue
        public_session = public_player_session(session)
        public_session.pop('token', None)
        removed.append(public_session)
        SESSIONS.pop(token, None)
        ACTION_RATE.pop(token, None)
        REACTION_RATE.pop(token, None)
    return removed


def public_event(value):
    if isinstance(value, dict):
        return {k: public_event([c for c in v if isinstance(c, dict) and c.get('visibility') != 'gm'] if k == 'conditions' and isinstance(v, list) else v)
                for k,v in value.items() if k != '_characterRuntime'}
    if isinstance(value, list): return [public_event(v) for v in value]
    return value


def sse_bytes(event, event_id=None):
    lines = []
    if event_id is not None:
        lines.append('id: %s' % event_id)
    lines.append('data: ' + json.dumps(public_event(event), ensure_ascii=False, separators=(',', ':')))
    return ('\n'.join(lines) + '\n\n').encode('utf-8')

def get_ips():
    ips = set()
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
    except Exception:
        pass
    finally:
        if s is not None:
            s.close()
    try:
        ips.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except Exception:
        pass
    ips.add('127.0.0.1')
    return sorted(ips)

class SSEClient:
    """A bounded FIFO; a stalled reader can only disconnect its own stream."""
    MAX_EVENTS = MAX_RECENT + 32
    MAX_BYTES = 16 * 1024 * 1024

    def __init__(self, connection):
        self.connection = connection
        self.pending = deque()
        self.pending_bytes = 0
        self.closed = False
        self.condition = threading.Condition()

    def enqueue(self, payload):
        with self.condition:
            if self.closed:
                return False
            if len(self.pending) >= self.MAX_EVENTS or self.pending_bytes + len(payload) > self.MAX_BYTES:
                self.close()
                return False
            self.pending.append(payload)
            self.pending_bytes += len(payload)
            self.condition.notify()
            return True

    def next_payload(self, timeout=10):
        with self.condition:
            self.condition.wait_for(lambda: self.closed or self.pending, timeout)
            if self.closed:
                return None
            if not self.pending:
                return b': ping\n\n'
            payload = self.pending.popleft()
            self.pending_bytes -= len(payload)
            return payload

    def close(self):
        with self.condition:
            if self.closed:
                return
            self.closed = True
            self.pending.clear()
            self.pending_bytes = 0
            self.condition.notify_all()
        # shutdown does not wait for peer acknowledgement and wakes a blocked writer.
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def broadcast(data, event_id=None):
    # The transaction lock orders both committed events and their queue insertion.
    # No socket writes occur here, including when callers already hold LOCK.
    with LOCK:
        if not CLIENTS:
            return
        payload = sse_bytes(data, event_id)
        for client in list(CLIENTS):
            if not client.enqueue(payload):
                CLIENTS.remove(client)

from server.authentication import authenticate, DEFAULT_METHOD
AUTH_METHOD = DEFAULT_METHOD

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def send_head(self):
        translated = self.translate_path(self.path)
        if not static_file_allowed(ROOT, translated, host_request_allowed(self)):
            self.send_error(404, 'File not found')
            return None
        relative = os.path.relpath(translated, ROOT).replace(os.sep, '/')
        if relative.startswith(('asset/地图/', 'asset/棋子库/')) and not host_request_allowed(self):
            if not private_media_allowed(self, '/' + relative):
                self.send_error(404); return None
        return super().send_head()

    def handle_player_profiles(self):
        global NEXT_SEQ, STATE_REVISION
        binding_event = None
        try:
            data = self._read_json_body(24 * 1024 * 1024)
            if not isinstance(data, dict): raise profiles.ProfileError('请求无效')
            store = profile_store()
            host = host_request_allowed(self) and self.headers.get(LOCAL_SAVE_HEADER) == '1'
            with LOCK:
                session = touch_session(data.get('sessionToken'))
            op = data.get('op')
            if not host and (not session or not session.get('persistent')):
                raise profiles.ProfileError('请使用玩家名字登录', 401)
            pid = str(data.get('playerId') or (session or {}).get('playerId') or '')
            if not host and pid != session['playerId']:
                raise profiles.ProfileError('不能访问其他玩家的小库', 403)
            if op in ('list','create','createWithCode','credential','setCredential','syncForms','reset','grant','delete') and not host:
                raise profiles.ProfileError('仅主控台可以执行此操作', 403)
            with profiles.LOCK:
                if AUTH_METHOD == 'name' and op in ('credential','setCredential','createWithCode','reset'):
                    raise profiles.ProfileError('登录码功能已关闭，请使用玩家名字登录', 410)
                if not host and not store.session_valid(pid, session.get('_authVersion')):
                    raise profiles.ProfileError('会话已失效，请重新加入', 401)
                if op == 'list': result = {'players': store.players()}
                elif op in ('create','createWithCode'):
                    if op == 'createWithCode' and not data.get('loginCode'): raise profiles.ProfileError('请填写登录码')
                    result = store.create(data.get('name'), data.get('loginCode'))
                    if AUTH_METHOD == 'name': result.pop('credential', None)
                elif op == 'syncForms': result = {'library': store.sync_forms(pid, data.get('ownedPieceId'))}
                elif op == 'credential': result = {'credential': store.credential(pid)}
                elif op in ('reset', 'setCredential'):
                    if op == 'setCredential' and not data.get('loginCode'): raise profiles.ProfileError('请填写登录码')
                    credential = store.rotate(pid, login_code=data.get('loginCode') if op == 'setCredential' else None)
                    with LOCK: revoke_player_sessions(pid)
                    result = {'credential': credential}
                elif op == 'delete':
                    result = store.delete(pid)
                    with LOCK: revoke_player_sessions(pid)
                elif op == 'travelBasket':
                    with LOCK:
                        stored, available = [], []
                        for piece in store.library(pid)['pieces']:
                            oid = piece['ownedPieceId']
                            locations = owned_piece_locations(STATE or {}, oid)
                            parked = ((STATE or {}).get('parkedOwnedPieces') or {}).get(oid)
                            if len(locations) > 1: continue
                            token = locations[0][1] if locations else parked
                            if not isinstance(token, dict) or token.get('ownerPlayerId') != pid: continue
                            row = {key: token.get(key) for key in ('id', 'name', 'ownedPieceId', 'icon', 'iconImgPath', 'iconImg')}
                            if locations:
                                source = locations[0][0]
                                row['location'] = source.get('name') if source.get('playerAccessible') is True else '其他地点'
                                available.append(row)
                            elif token.get('travelBasketStored') is True: stored.append(row)
                        result = {'stored': stored, 'available': available, 'campaignId': (STATE or {}).get('campaignId')}
                elif op == 'get':
                    with LOCK:
                        lib = store.library(pid)
                        deployments = {}
                        if STATE:
                            for piece in lib['pieces']:
                                oid = piece['ownedPieceId']; locations = owned_piece_locations(STATE, oid)
                                if len(locations) == 1 and locations[0][1].get('ownerPlayerId') == pid:
                                    map_obj, token = locations[0]
                                    lib = store.sync_token(pid, token, STATE.get('campaignId'))
                                    deployments[oid] = {'status': 'placed', 'mapId': map_obj['id'] if map_obj.get('playerAccessible') is True else None,
                                                        'mapName': map_obj.get('name') if map_obj.get('playerAccessible') is True else None}
                                else:
                                    parked = (STATE.get('parkedOwnedPieces') or {}).get(oid)
                                    if not locations and isinstance(parked, dict) and parked.get('ownerPlayerId') == pid:
                                        lib = store.sync_token(pid, parked, STATE.get('campaignId'))
                                    deployments[oid] = {'status': 'stored' if not locations else 'conflict',
                                                        'inBasket': bool(not locations and isinstance(parked, dict) and parked.get('ownerPlayerId') == pid and parked.get('travelBasketStored') is True)}
                        lib = copy.deepcopy(lib)
                        for piece in lib['pieces']:
                            piece.pop('mapSyncStates', None)
                            if not host and 'conditions' in piece:
                                piece['conditions'] = [c for c in piece['conditions'] if isinstance(c, dict) and c.get('visibility') != 'gm']
                        result = {'profile': store.read(pid), 'library': lib, 'deployments': deployments,
                                  'campaignId': (STATE or {}).get('campaignId')}

                elif op == 'grant': result = {'library': store.grant(pid, data.get('preset'), data.get('grantId'))}
                elif op == 'collect':
                    if host or not session:
                        raise profiles.ProfileError('请从玩家端收入自己的小库', 403)
                    with LOCK:
                        if not STATE or not STATE.get('campaignId') or data.get('campaignId') != STATE.get('campaignId'):
                            raise profiles.ProfileError('战役已变化，请刷新后重试', 409)
                        _, token = find_token(STATE, data.get('tokenId'))
                        if not token or token.get('hiddenFromPlayers') or not can_control(STATE, token, pid):
                            raise profiles.ProfileError('只能收入目前由你控制且可见的棋子', 403)
                        if token.get('ownedPieceId'):
                            if token.get('ownerPlayerId') != pid:
                                raise profiles.ProfileError('这枚棋子已经属于其他玩家的小库', 403)
                            result = {'library': store.library(pid)}
                        else:
                            source = copy.deepcopy(token)
                            # Stable server-derived key makes double clicks/retries idempotent.
                            grant_id = 'collect-' + hashlib.sha256(json.dumps([STATE['campaignId'], token['id']], ensure_ascii=False).encode()).hexdigest()
                            result = {'library': store.grant(pid, source, grant_id)}
                            oid = result['library']['grants'][grant_id]
                            piece = next(p for p in result['library']['pieces'] if p['ownedPieceId'] == oid)
                            ownership = {'ownedPieceId': oid, 'ownerPlayerId': pid, 'owner': session['name'],
                                         'ownedPieceRevision': piece['revision'], 'playerCreated': False, 'createdByPlayer': ''}
                            token.update(ownership)
                            seq = NEXT_SEQ; NEXT_SEQ += 1; STATE_REVISION += 1
                            STATE['_stateRevision'] = STATE_REVISION; STATE['_streamSeq'] = seq
                            action = {'op': 'bindOwnedPiece', 'tokenId': token['id'], 'ownership': ownership,
                                      'actor': pid, 'seq': seq, 'campaignId': STATE.get('campaignId'), '_sessionId': SESSION_ID}
                            RECENT_ACTIONS.append(action)
                            if len(RECENT_ACTIONS) > MAX_RECENT: del RECENT_ACTIONS[:-MAX_RECENT]
                            binding_event = {'type': 'action', 'seq': seq, 'revision': STATE_REVISION, 'action': action}
                elif op == 'edit': result = {'library': store.edit(pid, data.get('ownedPieceId'), data.get('revision'), data.get('patch'), data.get('pieceRevision'), host=host)}
                else: raise profiles.ProfileError('操作无效')
            if binding_event: broadcast(binding_event, binding_event['seq'])
            self._send_document_json(dict(ok=True, **result))
        except profiles.ProfileError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, error.status)
        except (ValueError, TypeError, OverflowError):
            self._send_document_json({'ok': False, 'error': '资料格式无效'}, 400)
        except OSError:
            self._send_document_json({'ok': False, 'error': '写入未完成，请保留编辑内容后重试'}, 500)

    def handle_map_items(self):
        try:
            data = self._read_json_body(512 * 1024)
            if not isinstance(data, dict): raise profiles.ProfileError('请求无效')
            host = host_request_allowed(self) and self.headers.get(LOCAL_SAVE_HEADER) == '1'
            with profiles.LOCK, LOCK:
                session = touch_session(data.get('sessionToken')) if not host else None
                if not host and not session:
                    raise profiles.ProfileError('请先进入玩家地图', 401)
                result = MapItems(profile_store(), profiles).apply(data, STATE, host, player=session)
            self._send_document_json(dict(ok=True, **result))
        except profiles.ProfileError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, error.status)
        except (ValueError, TypeError, OverflowError):
            self._send_document_json({'ok': False, 'error': '地图物品请求格式无效'}, 400)
        except OSError:
            self._send_document_json({'ok': False, 'error': '写入结果待核对，请重试原操作'}, 500)

    def handle_item_library(self):
        try:
            if not (host_request_allowed(self) and self.headers.get(LOCAL_SAVE_HEADER) == '1'):
                raise profiles.ProfileError('仅主控台可以管理物品库', 403)
            data = self._read_json_body(512 * 1024)
            if not isinstance(data, dict): raise profiles.ProfileError('请求无效')
            result = ItemLibrary(profile_store(), profiles).apply(data)
            self._send_document_json(dict(ok=True, **result))
        except profiles.ProfileError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, error.status)
        except (ValueError, TypeError, OverflowError):
            self._send_document_json({'ok': False, 'error': '物品库请求格式无效'}, 400)
        except OSError:
            self._send_document_json({'ok': False, 'error': '物品库写入未完成，请重试原操作'}, 500)

    def handle_reading_share(self):
        try:
            data = self._read_json_body(8192)
            if not isinstance(data, dict): raise profiles.ProfileError('共享请求无效')
            with LOCK:
                session = touch_session(data.get('sessionToken'))
                if not session: raise profiles.ProfileError('请先加入房间', 401)
                campaign = (STATE or {}).get('campaignId')
                if not campaign or data.get('campaignId') != campaign:
                    raise profiles.ProfileError('战役已切换，请重新打开阅读页面', 409)
                pid = session['playerId']
                if data.get('op') == 'invite':
                    if not session.get('persistent'): raise profiles.ProfileError('请使用玩家档案共享物品', 403)
                    if data.get('source') is not None:
                        source = data['source']
                        if not isinstance(source, dict): raise profiles.ProfileError('共享来源无效')
                        visible = MapItems(profile_store(), profiles).apply(dict(op='get', campaignId=campaign, mapId=source.get('mapId')), STATE, False, player=session)
                        marker = next((m for m in visible['markers'] if m['id'] == source.get('markerId')), {})
                        items = marker.get('items', [])
                    else:
                        items = ResourceStore(profile_store(), profiles).read(pid, campaign)['items']
                    item = next((i for i in items if i['id'] == data.get('itemId')), None)
                    if not item: raise profiles.ProfileError('这件文书已不可访问，请重新打开', 404)
                    recipients = [p['playerId'] for p in online_players() if p['online']]
                    invitation = READING_SHARES.invite(campaign, pid, session['name'], item, recipients)
                    result = dict(recipientCount=len(invitation['recipients']))
                elif data.get('op') == 'accept':
                    invitation = None
                    identity = data.get('shareId')
                    if not isinstance(identity, str): raise profiles.ProfileError('共享编号无效')
                    result = dict(item=READING_SHARES.accept(campaign, identity, pid))
                else: raise profiles.ProfileError('共享操作无效')
            if invitation: broadcast(invitation)
            self._send_document_json(dict(ok=True, **result))
        except profiles.ProfileError as error:
            self._send_document_json({'ok':False,'error':str(error)}, error.status)
        except (ValueError, TypeError, OverflowError):
            self._send_document_json({'ok':False,'error':'共享请求格式无效'},400)
        except OSError:
            self._send_document_json({'ok':False,'error':'读取共享内容失败，请稍后重试'},500)

    def handle_backpack(self):
        global NEXT_SEQ, STATE_REVISION
        events = []
        try:
            data = self._read_json_body(512 * 1024)
            if not isinstance(data, dict): raise profiles.ProfileError('请求无效')
            host = host_request_allowed(self) and self.headers.get(LOCAL_SAVE_HEADER) == '1'
            store = profile_store()
            with profiles.LOCK, LOCK:
                session = touch_session(data.get('sessionToken'))
                if not host and (not session or not session.get('persistent')):
                    raise profiles.ProfileError('请使用玩家名字登录后查看物品', 401)
                pid = str(data.get('playerId') or (session or {}).get('playerId') or '')
                if not host and pid != session['playerId']:
                    raise profiles.ProfileError('不能访问其他玩家的背包', 403)
                campaign = data.get('campaignId')
                if campaign is not None and (not isinstance(campaign, str) or len(campaign) > 128):
                    raise profiles.ProfileError('请求格式无效', 400)
                inventory = ResourceStore(store, profiles)
                needs_campaign = data.get('op') in ('heal', 'undo') or (data.get('op') == 'assign' and not inventory.database.active())
                if needs_campaign and campaign != (STATE or {}).get('campaignId'):
                    raise profiles.ProfileError('战役已切换，请重新打开背包', 409)
                before = character_updates(STATE, public=True)
                inventory.reconcile(STATE, pid)
                sync_all_downed_portraits(STATE)
                if data.get('op') == 'get':
                    backpack = inventory.public(inventory.read(pid, campaign))
                    result = dict(backpack=backpack, profile=store.read(pid), catalog=[t for t in ItemLibrary(store, profiles).read()['templates'] if not t['archived']] if host else [])
                else:
                    backpack, event = inventory.apply(pid, campaign, data, host, state=STATE)
                    result = dict(backpack=backpack, event=inventory.clean_event(event))
                # Reconcile again after commit. A lost reply is recovered from the ledger,
                # not by re-rolling or replaying old HP over later combat changes.
                inventory.reconcile(STATE, pid)
                sync_all_downed_portraits(STATE)
                result.update(characters=inventory.characters(pid, STATE, host), campaignId=(STATE or {}).get('campaignId'))
                result['walletSupported'] = True
                result['walletCoinsSupported'] = True
                result['transferQuantitySupported'] = True
                result['recipients'] = [dict(id=c['id'], name=c['name'], ownerPlayerId=c['ownerPlayerId'], playerName=store.read(c['ownerPlayerId'])['name']) for c in result['characters']]
                if not host: result['backpack'].pop('removedItems', None)
                for action in character_updates(STATE, public=True):
                    if action in before: continue
                    seq = NEXT_SEQ; NEXT_SEQ += 1; STATE_REVISION += 1
                    action.update(campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID, seq=seq)
                    RECENT_ACTIONS.append(action)
                    if len(RECENT_ACTIONS) > MAX_RECENT: del RECENT_ACTIONS[:-MAX_RECENT]
                    STATE['_streamSeq'] = seq; STATE['_stateRevision'] = STATE_REVISION
                    events.append(dict(type='action', seq=seq, revision=STATE_REVISION, action=action))
            for event in events: broadcast(event, event['seq'])
            self._send_document_json(dict(ok=True, **result))
        except profiles.ProfileError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, error.status)
        except (ValueError, TypeError, OverflowError):
            self._send_document_json({'ok': False, 'error': '背包请求格式无效'}, 400)
        except OSError:
            self._send_document_json({'ok': False, 'error': '背包写入未完成，请重试原操作'}, 500)

    def end_headers(self):
        if urlparse(self.path).path.endswith('.html'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range, X-Sundoll-Local-Save, X-Sundoll-Workspace')
        self.send_header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length')

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if code == 200 and urlparse(self.path).path == '/api/session' and isinstance(obj, dict):
            session = obj.get('session') if isinstance(obj.get('session'), dict) else obj
            token = session.get('sessionToken')
            if isinstance(token, str) and re.fullmatch(r'[A-Za-z0-9_-]{16,256}', token):
                secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
                self.send_header('Set-Cookie', 'sundoll-media-session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400' + secure)
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _send_document_json(self, obj, code=200, head_only=False):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _document_path(self, document_id):
        if not re.fullmatch(r'[0-9a-f]{32}', str(document_id or '')):
            return None
        with LOCK:
            path = DOCUMENT_LIBRARY_INDEX.get(document_id)
            snapshot = STATE if isinstance(STATE, dict) else {}
            campaign_id = snapshot.get('campaignId') or ''
            campaign_name = snapshot.get('campaignName') or ''
        if not path:
            refresh_document_library(campaign_id, campaign_name)
            with LOCK:
                path = DOCUMENT_LIBRARY_INDEX.get(document_id)
        if (not path or not any(_document_path_is_safe(root, path) for root in [DOCUMENT_LIBRARY_ROOT] + module_support_roots('文档'))
                or not os.path.isfile(path)
                or os.path.splitext(path)[1].lower() not in DOCUMENT_EXTS):
            return None
        return path

    def _document_static_request(self, request_path):
        try:
            translated = self.translate_path(request_path)
        except (OSError, ValueError):
            return False
        return _path_written_or_resolved_within(DOCUMENT_LIBRARY_ROOT, translated)

    def _send_pdf_document(self, document_id, head_only=False):
        path = self._document_path(document_id)
        if not path or os.path.splitext(path)[1].lower() != '.pdf':
            self._send_document_json({'ok': False, 'error': 'document not found'}, 404, head_only)
            return
        try:
            stat = os.stat(path)
            size = stat.st_size
            if size <= 0 or size > MAX_DOCUMENT_SOURCE_BYTES:
                raise DocumentTooLargeError('PDF 文件大小超出限制')
            byte_range = parse_http_byte_range(self.headers.get('Range'), size)
        except DocumentTooLargeError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, 413, head_only)
            return
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % max(0, size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.end_headers()
            return
        except OSError:
            self._send_document_json({'ok': False, 'error': 'document not found'}, 404, head_only)
            return
        start, end = byte_range if byte_range else (0, size - 1)
        length = max(0, end - start + 1)
        encoded_name = quote(os.path.basename(path), safe='')
        self.send_response(206 if byte_range else 200)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'private, max-age=3600')
        self.send_header('ETag', '"%x-%x"' % (stat.st_mtime_ns, size))
        self.send_header('Content-Disposition', "inline; filename=\"document.pdf\"; filename*=UTF-8''" + encoded_name)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        if byte_range:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
        if head_only:
            return
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

    def _send_document_download(self, document_id, head_only=False):
        path = self._document_path(document_id)
        if not path:
            self._send_document_json({'ok': False, 'error': 'document not found'}, 404, head_only)
            return
        extension = os.path.splitext(path)[1].lower()
        try:
            stat = os.stat(path)
            size = stat.st_size
        except OSError:
            self._send_document_json({'ok': False, 'error': 'document not found'}, 404, head_only)
            return
        if size <= 0 or size > MAX_DOCUMENT_SOURCE_BYTES:
            self._send_document_json({'ok': False, 'error': 'document too large'}, 413, head_only)
            return
        encoded_name = quote(os.path.basename(path), safe='')
        mime = 'application/pdf' if extension == '.pdf' else DOCX_MIME
        fallback = 'document.pdf' if extension == '.pdf' else 'document.docx'
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(size))
        self.send_header('Content-Disposition', "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (fallback, encoded_name))
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, 'rb') as handle:
                shutil.copyfileobj(handle, self.wfile, 128 * 1024)
        except (OSError, BrokenPipeError, ConnectionResetError):
            pass

    def _send_docx_preview(self, document_id):
        path = self._document_path(document_id)
        if not path or os.path.splitext(path)[1].lower() != '.docx':
            self._send_document_json({'ok': False, 'error': 'document not found'}, 404)
            return
        try:
            blocks = parse_docx_preview(path)
        except DocumentTooLargeError as error:
            self._send_document_json({'ok': False, 'error': str(error)}, 413)
            return
        except (DocumentPreviewError, OSError, zipfile.BadZipFile) as error:
            self._send_document_json({'ok': False, 'error': str(error) or 'DOCX 无法预览'}, 422)
            return
        self._send_document_json({
            'ok': True,
            'document': {
                'id': document_id,
                'title': os.path.splitext(os.path.basename(path))[0],
                'type': 'docx',
                'blocks': blocks,
            },
        })

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
        media_root = next((root for root in [MUSIC_LIBRARY_ROOT] + module_support_roots('音乐') if path and _music_path_is_safe(root,path)), None)
        if (not path or not media_root
                or not os.path.isfile(path)):
            self._send_json({'ok': False, 'error': 'music not found'}, 404)
            return
        self._send_audio_path(path, media_root)

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
        if urlparse(self.path).path.startswith('/api/document'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403)
                return
            self.send_response(204)
            self.send_header('Allow', 'GET, HEAD, OPTIONS')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_HEAD(self):
        if urlparse(self.path).path.startswith(ASSET_URL):
            self._send_module_asset(head=True)
            return
        path = urlparse(self.path).path
        if path.startswith('/api/document-stream/'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403, True)
                return
            self._send_pdf_document(path.rsplit('/', 1)[-1], True)
        elif path.startswith('/api/document-download/'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403, True)
                return
            self._send_document_download(path.rsplit('/', 1)[-1], True)
        elif self._document_static_request(path):
            self.send_error(404, 'File not found')
        else:
            super().do_HEAD()

    def _private_media_headers(self, mime, size, etag):
        # Authorization must run before this helper, including conditional GETs.
        quoted = '"' + etag + '"'
        candidates = [v.strip().removeprefix('W/') for v in self.headers.get('If-None-Match', '').split(',')]
        matched = quoted in candidates or '*' in candidates
        self.send_response(304 if matched else 200)
        self.send_header('Cache-Control', 'private, no-cache, must-revalidate')
        self.send_header('ETag', quoted)
        self.send_header('Vary', 'Cookie')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if not matched:
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(size))
        self._cors()
        self.end_headers()
        return not matched

    def _send_module_asset(self, head=False):
        from server.media_variants import display_asset, VARIANTS
        path = urlparse(self.path).path
        with LOCK:
            allowed = private_media_allowed(self, path)
        if not allowed:
            self.send_error(404); return
        variant = (parse_qs(urlparse(self.path).query).get('variant') or [''])[0]
        if variant and variant not in VARIANTS:
            self.send_error(400, 'Unknown display variant'); return
        digest = path[len(ASSET_URL):]
        try:
            asset = ModuleStore(LOCAL_SAVE_ROOT).asset(digest)
        except (ValueError, OSError):
            asset = None
        if not asset:
            self.send_error(404); return
        target, mime, size = asset
        target, mime, size, etag = display_asset(target, mime, digest, variant,
            Path(LOCAL_SAVE_ROOT).parent / '.sundoll-cache' / '显示资源')
        if self._private_media_headers(mime, size, etag) and not head:
            with target.open('rb') as handle:
                shutil.copyfileobj(handle, self.wfile, 256 * 1024)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/workspace-epoch':
            from server.workspace_backup import epoch
            self._send_json({'ok':True,'epoch':epoch(LOCAL_SAVE_ROOT)}); return
        if path.startswith('/api/modules/download/'):
            if not host_request_allowed(self): self.send_error(404); return
            name = path.rsplit('/',1)[-1]
            if not re.fullmatch(r'[0-9a-f]{32}\.(?:sundoll|zip)', name): self.send_error(404); return
            target = Path(LOCAL_SAVE_ROOT)/'模块存储/导出暂存'/name
            if not target.is_file() or target.is_symlink(): self.send_error(404); return
            self.send_response(200)
            self.send_header('Content-Type','application/zip')
            self.send_header('Content-Length',str(target.stat().st_size))
            self.send_header('Content-Disposition','attachment; filename="'+name+'"')
            self.send_header('Cache-Control','no-store'); self.end_headers()
            with target.open('rb') as handle: shutil.copyfileobj(handle,self.wfile,256*1024)
            return
        if path.startswith(ASSET_URL):
            self._send_module_asset()
            return
        if path.startswith('/api/player-art/'):
            with LOCK:
                if not private_media_allowed(self, path):
                    self.send_error(404); return
            digest = path.rsplit('/', 1)[-1]
            target = profile_store().root / '资源' / digest
            if not re.fullmatch('[0-9a-f]{64}', digest) or not target.is_file():
                self.send_error(404); return
            raw = target.read_bytes()
            mime = 'image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg' if raw.startswith(b'\xff\xd8') else 'image/gif' if raw.startswith(b'GIF') else 'image/webp'
            if self._private_media_headers(mime, len(raw), 'player-' + digest):
                self.wfile.write(raw)
            return
        if path == '/api/document-library':
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403)
                return
            query = parse_qs(urlparse(self.path).query)
            with LOCK:
                snapshot = STATE if isinstance(STATE, dict) else {}
                campaign_id = (query.get('campaignId') or [snapshot.get('campaignId') or ''])[0]
                campaign_name = (query.get('campaignName') or [snapshot.get('campaignName') or ''])[0]
            self._send_document_json(refresh_document_library(campaign_id, campaign_name))
        elif path.startswith('/api/document-preview/'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403)
                return
            self._send_docx_preview(path.rsplit('/', 1)[-1])
        elif path.startswith('/api/document-stream/'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403)
                return
            self._send_pdf_document(path.rsplit('/', 1)[-1])
        elif path.startswith('/api/document-download/'):
            if not document_request_allowed(self):
                self._send_document_json({'ok': False, 'error': 'document library is host-only'}, 403)
                return
            self._send_document_download(path.rsplit('/', 1)[-1])
        elif path == '/api/music-library':
            if not host_request_allowed(self):
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
            if not private_media_allowed(self, path):
                self._send_json({'ok':False,'error':'asset not found'},404); return
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
            if self._private_media_headers(mime, len(raw), hashlib.sha256(raw).hexdigest()):
                self.wfile.write(raw)
        elif path == '/api/state':
            with LOCK:
                snapshot = copy.deepcopy(state_snapshot() or {})
            self._send_json(snapshot)
        elif self.path.startswith('/api/actions'):
            qs = parse_qs(urlparse(self.path).query)
            try:
                after = int((qs.get('after') or ['0'])[0])
            except Exception:
                after = 0
            with LOCK:
                acts = [a for a in RECENT_ACTIONS if a.get('seq', 0) > after]
                revision = STATE_REVISION
            self._send_json({'actions': public_event(acts), 'stateRevision': revision})
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
                'name': '桑哆尔之歌联机',
                'protocolVersion': SERVER_PROTOCOL_VERSION,
                'authentication': {'method': AUTH_METHOD, 'registration': True},
                'projectId': hashlib.sha256(os.path.normcase(os.path.realpath(ROOT)).encode('utf-8')).hexdigest(),
                'sessionId': SESSION_ID,
                'roomCode': ROOM_CODE,
                'publicBase': PUBLIC_BASE_URL,
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
                response = {'ok': True, 'players': online_players(), 'publicBase': PUBLIC_BASE_URL}
            self._send_json(response)
        elif path == '/api/session':
            token = (parse_qs(urlparse(self.path).query).get('token') or [''])[0]
            with LOCK:
                session = touch_session(token)
                if not session:
                    response, code = {'ok': False, 'error': 'session not found'}, 404
                else:
                    public_session = public_player_session(session)
                    public_session.pop('token', None)
                    response, code = {'ok': True, 'session': public_session, 'roomCode': ROOM_CODE}, 200
            self._send_json(response, code)
        elif path == '/api/health':
            with LOCK:
                response = {'ok': True, 'state': STATE is not None, 'stateRevision': STATE_REVISION, 'clients': len(CLIENTS), 'players': len(SESSIONS)}
            self._send_json(response)
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
                '<meta charset="utf-8"><title>桑哆尔之歌联机服务器</title>'
                '<body style="background:#101218;color:#e8eaf0;font-family:sans-serif;padding:40px">'
                '<h2>🖥️ 桑哆尔之歌联机服务器已启动（端口 %d）</h2>'
                '<p>主机：<a href="%s" style="color:#e0b34c">%s</a></p>'
                '<p>玩家模式：<a href="%s" style="color:#e0b34c">%s</a></p>'
                '<p>同一 WiFi 下的玩家，把 localhost 换成下面的 IP：<br>%s</p>'
                '</body>'
            ) % (PORT, host, host, viewer, viewer, '、'.join(get_ips())))
        elif self._document_static_request(path):
            self.send_error(404, 'File not found')
        else:
            super().do_GET()

    def _read_json_body(self, limit=MAX_BODY):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            raise ValueError('invalid content length')
        if length < 0:
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
            from server.resource_database import ResourceDatabase
            if (isinstance(data, dict) and data.get('op') not in ('status','read','read-campaign','read-binary','list','campaign-catalog')
                    and ResourceDatabase(LOCAL_SAVE_ROOT).active() and data.get('protocolVersion') != SERVER_PROTOCOL_VERSION):
                self._send_json({'ok':False,'error':'程序已经升级，请刷新主控台和棋子库后再保存；旧页面的进度未覆盖正式档案'},409)
                return
            result = perform_local_save_operation(data)
        except SaveConflict as error:
            self._send_json({'ok': False, 'error': str(error)}, 409)
            return
        except OverflowError:
            self._send_json({'ok': False, 'error': 'save too large'}, 413)
            return
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send_json({'ok': False, 'error': str(error) or 'invalid save request'}, 400)
            return
        except (OSError, sqlite3.Error, profiles.ProfileError) as error:
            self._send_json({'ok': False, 'error': 'save operation failed: ' + str(error)}, 500)
            return
        self._send_json(result)

    def handle_modules(self):
        if not local_save_request_allowed(self):
            self._send_document_json({'ok':False,'error':'模块管理仅可从本机主控台操作'},403); return
        try:
            from server.module_runtime import ModuleRuntime
            from server.module_packages import MAX_PACKAGE_BYTES
            from server.module_store import RevisionConflict
            runtime = ModuleRuntime(LOCAL_SAVE_ROOT, ROOT)
            if self.path in ('/api/modules/import','/api/modules/preview','/api/workspace-backups/import'):
                length = int(self.headers.get('Content-Length') or 0)
                limit = 16*1024**3 if self.path == '/api/workspace-backups/import' else MAX_PACKAGE_BYTES
                if not 0 < length <= limit: raise ValueError('模块文件为空或超过容量限制')
                prebuffered = getattr(self, '_buffered_post_body', None) is self.rfile
                # Reuse the transport spool; a 16 GiB backup must not need a
                # second 16 GiB temporary copy while holding the write lock.
                with (nullcontext(self.rfile) if prebuffered else tempfile.TemporaryFile()) as upload:
                    if not prebuffered:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(remaining,256*1024))
                            if not chunk: raise ValueError('上传中断，请重新选择文件')
                            upload.write(chunk); remaining -= len(chunk)
                    upload.seek(0)
                    if self.path == '/api/workspace-backups/import':
                        from server.workspace_backup import Backups
                        result={'backup':Backups(LOCAL_SAVE_ROOT).import_archive(upload)}
                    elif self.path == '/api/modules/preview':
                        manifest,payload=runtime.packages.inspect(upload)
                        old=next((m for m in runtime.packages.catalog() if m['moduleId']==manifest['moduleId']),None)
                        if old and old['kind']!=manifest['kind']: raise ValueError('同一模块不能更改类型')
                        ticket=secrets.token_hex(16)
                        staging=Path(LOCAL_SAVE_ROOT)/'模块存储/导入暂存'
                        staging.mkdir(parents=True,exist_ok=True)
                        upload.seek(0)
                        with (staging/(ticket+'.sundoll')).open('xb') as output: shutil.copyfileobj(upload,output)
                        from server.workspace import atomic_json
                        atomic_json(staging/(ticket+'.json'),{'expectedHash':old['dataHash'] if old else None,'expires':time.time()+3600})
                        result={'module':manifest,'ticket':ticket,'previous':old,'update':bool(old and old['dataHash']!=manifest['dataHash'])}
                    else:
                        result = {'module':runtime.packages.install(upload)}
            else:
                data = self._read_json_body(64*1024)
                op = data.get('op')
                if op == 'overview':
                    from server.module_management import overview
                    result=overview(runtime)
                elif op == 'list':
                    from server.workspace import Workspace
                    result = {'modules':runtime.packages.catalog(), 'workspace':Workspace(LOCAL_SAVE_ROOT).summary()}
                elif op == 'confirm-import':
                    ticket=str(data.get('ticket',''))
                    if not re.fullmatch(r'[0-9a-f]{32}',ticket): raise ValueError('导入预览无效')
                    staging=Path(LOCAL_SAVE_ROOT)/'模块存储/导入暂存'
                    info=json.loads((staging/(ticket+'.json')).read_text('utf-8'))
                    if info['expires']<time.time(): raise ValueError('导入预览已过期，请重新选择文件')
                    result={'module':runtime.packages.install(staging/(ticket+'.sundoll'),info['expectedHash'])}
                elif op in ('uninstall','restore-module'):
                    from server.module_management import set_archived
                    result=set_archived(runtime,data.get('moduleId'),op=='uninstall')
                elif op == 'restore-campaign':
                    from server.module_management import restore_campaign
                    result=restore_campaign(runtime,data.get('path'),data.get('campaignId'))
                elif op == 'backups':
                    from server.workspace_backup import Backups
                    result={'backups':Backups(LOCAL_SAVE_ROOT).list()}
                elif op == 'backup-create':
                    from server.workspace_backup import Backups
                    result={'backup':Backups(LOCAL_SAVE_ROOT).create(data.get('name') or '手动备份')}
                elif op == 'backup-restore':
                    from server.workspace_backup import Backups
                    result=Backups(LOCAL_SAVE_ROOT).stage_restore(data.get('backupId'))
                    self.server.restore_pending=True
                    # serve_forever returns; main restarts only after this response is sent.
                    threading.Timer(1,self.server.shutdown).start()
                elif op == 'backup-export':
                    from server.workspace_backup import Backups
                    name=secrets.token_hex(16)+'.zip'
                    path=Path(LOCAL_SAVE_ROOT)/'模块存储/导出暂存'/name
                    path.parent.mkdir(parents=True,exist_ok=True)
                    Backups(LOCAL_SAVE_ROOT).export(data.get('backupId'),path)
                    result={'downloadUrl':'/api/modules/download/'+name,'filename':'整套私人备份.zip'}
                elif op == 'create-run': result = runtime.create_run(data.get('moduleId'),data.get('requestId'))
                elif op == 'activate-general': result = runtime.activate_general(data.get('moduleId'))
                elif op == 'activate-player': result = runtime.activate_player(data.get('moduleId'))
                elif op in ('export-player','export-campaign','export-general'):
                    name = secrets.token_hex(16)+'.sundoll'
                    path = Path(LOCAL_SAVE_ROOT)/'模块存储/导出暂存'/name
                    from server.module_management import export_general
                    manifest = export_general(runtime,data.get('owner'),path) if op=='export-general' else runtime.export_player(data.get('playerId'),path) if op=='export-player' else runtime.export_campaign(data.get('campaignId'), data.get('kind'), path)
                    result = {'module':manifest,'downloadUrl':'/api/modules/download/'+name}
                else: raise ValueError('模块操作无效')
            self._send_document_json(dict(ok=True,**result))
        except (RevisionConflict, SaveConflict) as error:
            self._send_document_json({'ok':False,'error':str(error)},409)
        except profiles.ProfileError as error:
            self._send_document_json({'ok':False,'error':str(error)},error.status)
        except (ValueError, TypeError, KeyError, zipfile.BadZipFile) as error:
            self._send_document_json({'ok':False,'error':str(error) or '模块数据无效'},400)
        except (OSError, sqlite3.Error):
            self._send_document_json({'ok':False,'error':'模块操作未确认，请核对磁盘空间后重试原操作'},500)

    def handle_danmaku(self, data, action, name, role, sender_key):
        text = action.get('text')
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 120:
            self._send_json({'ok': False, 'error': '弹幕需为 1–120 个字符'}, 400)
            return
        text = ' '.join(text.split())
        if any(ord(char) < 32 or ord(char) == 127 for char in text):
            self._send_json({'ok': False, 'error': '弹幕含有无效字符'}, 400)
            return
        with LOCK:
            if STATE is None or not self.action_context_matches(data):
                self._send_json({'ok': False, 'error': '请等待主控台同步房间后再发送'}, 409)
                return
            now = time.monotonic()
            for key in list(DANMAKU_RATE):
                if now - DANMAKU_RATE[key] >= 1:
                    del DANMAKU_RATE[key]
            if sender_key in DANMAKU_RATE:
                self._send_json({'ok': False, 'error': '弹幕发送太快，请稍等一秒'}, 429)
                return
            DANMAKU_RATE[sender_key] = now
            message = dict(op='danmaku', text=text, name=name, role=role,
                           messageId=secrets.token_hex(12), issuedAt=int(time.time() * 1000),
                           campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID)
        # 即时弹幕不写入存档或重放历史，重连时不会刷出旧消息。
        broadcast({'type': 'action', 'seq': 0, 'action': message})
        self._send_json({'ok': True, 'action': message})

    def action_context_matches(self, data):
        current = STATE or {}
        required = current.get('protocolVersion') == SERVER_PROTOCOL_VERSION
        return ((not required and 'campaignId' not in data) or data.get('campaignId') == current.get('campaignId')) and ((not required and 'serverSessionId' not in data) or data.get('serverSessionId') == SESSION_ID)

    def _post_body_limit(self):
        """Prebuffer only recognized, authorized routes within their existing caps.

        Handlers remain the authority for errors and repeat their normal checks.
        Large uploads are never read before their existing host-only boundary.
        """
        path = self.path
        module_routes = ('/api/modules', '/api/modules/import', '/api/modules/preview', '/api/workspace-backups/import')
        if path in module_routes or path in ('/api/local-save', '/api/local-tunnel'):
            if not local_save_request_allowed(self):
                return 0
            if path == '/api/workspace-backups/import':
                return 16 * 1024 ** 3
            if path in ('/api/modules/import', '/api/modules/preview'):
                from server.module_packages import MAX_PACKAGE_BYTES
                return MAX_PACKAGE_BYTES
            if path == '/api/local-tunnel':
                return 4096
            return MAX_LOCAL_SAVE_BODY if path == '/api/local-save' else 64 * 1024
        host_routes = ('/api/assets/cache-map', '/api/players/kick', '/api/state', '/api/host-action')
        if path in host_routes or path.startswith('/api/music'):
            if not host_request_allowed(self):
                return 0
            if path.startswith('/api/music'):
                return 80 * 1024 * 1024
        if path == '/api/item-library' and not (host_request_allowed(self) and self.headers.get(LOCAL_SAVE_HEADER) == '1'):
            return 0
        if urlparse(path).path == '/api/webrtc-signal':
            return 192 * 1024
        return {
            '/api/map-items': 512 * 1024, '/api/item-library': 512 * 1024,
            '/api/reading-share': 8192, '/api/backpack': 512 * 1024,
            '/api/player-profiles': 24 * 1024 * 1024, '/api/local-tunnel': 4096,
            '/api/assets/cache-map': MAX_BODY, '/api/journal': 128 * 1024,
            '/api/player-name': 4096, '/api/session': 64 * 1024,
            '/api/register': 64 * 1024, '/api/presence': 64 * 1024,
            '/api/players/kick': 64 * 1024, '/api/state': MAX_BODY,
            '/api/host-action': 64 * 1024, '/api/action': MAX_ACTION_BODY,
        }.get(path, 0)

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length < 0:
                raise ValueError('invalid content length')
        except (TypeError, ValueError):
            self.close_connection = True
            self._send_json({'ok': False, 'error': 'invalid content length'}, 400)
            return
        limit = Handler._post_body_limit(self)
        original_reader, original_writer = self.rfile, self.wfile
        # Spool large bodies/responses to disk; neither slow direction owns a
        # shared transaction lock. Header/connection handling stays unchanged.
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as request_body, tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as response_body:
            if 0 < length <= limit:
                remaining = length
                while remaining:
                    chunk = original_reader.read(min(remaining, 256 * 1024))
                    if not chunk:
                        self.close_connection = True
                        self._send_json({'ok': False, 'error': '上传中断，请重新提交'}, 400)
                        return
                    request_body.write(chunk)
                    remaining -= len(chunk)
                request_body.seek(0)
            elif length:
                # The original handler emits its route-specific limit/auth error.
                self.close_connection = True
            self.rfile, self.wfile = request_body, response_body
            self._buffered_post_body = request_body
            try:
                # Keep the existing write order and recheck epoch after upload.
                with save_storage.SAVE_WRITE_LOCK, profiles.LOCK:
                    from server.workspace_backup import epoch
                    if getattr(self.server, 'restore_pending', False) is True:
                        self._send_json({'ok': False, 'error': '正在恢复工作区，请等待重启后刷新页面'}, 409)
                    else:
                        current_epoch = epoch(LOCAL_SAVE_ROOT)
                        if current_epoch and self.headers.get('X-Sundoll-Workspace') != current_epoch:
                            self._send_json({'ok': False, 'error': '工作区已经恢复，请刷新页面；旧页面未覆盖恢复结果'}, 409)
                        else:
                            Handler._dispatch_post(self)
            finally:
                self.rfile, self.wfile = original_reader, original_writer
                del self._buffered_post_body
            response_body.seek(0)
            shutil.copyfileobj(response_body, original_writer, 256 * 1024)

    def _dispatch_post(self):
        if self.path in ('/api/modules','/api/modules/import','/api/modules/preview','/api/workspace-backups/import'):
            self.handle_modules(); return
        global STATE, STATE_REVISION, NEXT_SEQ, PUBLIC_BASE_URL
        if self.path == '/api/map-items':
            self.handle_map_items()
            return
        if self.path == '/api/item-library':
            self.handle_item_library()
            return
        if self.path == '/api/reading-share':
            self.handle_reading_share()
            return
        if self.path == '/api/backpack':
            self.handle_backpack()
            return
        if self.path == '/api/player-profiles':
            self.handle_player_profiles()
            return
        if self.path == '/api/local-tunnel':
            if not local_save_request_allowed(self):
                self._send_json({'ok': False, 'error': 'tunnel api is host-only'}, 403)
                return
            try:
                data = self._read_json_body(4096)
            except (ValueError, TypeError, OverflowError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': '公网地址无效'}, 400)
                return
            public_base = normalize_public_base_url((data or {}).get('publicBase'))
            if public_base is None:
                self._send_json({'ok': False, 'error': '公网地址无效'}, 400)
                return
            with LOCK:
                PUBLIC_BASE_URL = public_base
            self._send_json({'ok': True, 'publicBase': PUBLIC_BASE_URL})
        elif self.path == '/api/assets/cache-map':
            if not host_request_allowed(self):
                self._send_json({'ok': False, 'error': 'map asset api is host-only'}, 403)
                return
            try:
                data = self._read_json_body(MAX_BODY)
            except OverflowError:
                self._send_json({'ok': False, 'error': 'map asset too large'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': 'bad map asset'}, 400)
                return
            asset_url = cache_map_asset((data or {}).get('mapData'))
            if not asset_url:
                self._send_json({'ok': False, 'error': 'bad map asset'}, 400)
                return
            self._send_json({'ok': True, 'mapAssetUrl': asset_url})
        elif self.path == '/api/journal':
            try:
                data = self._read_json_body(128 * 1024)
                if not isinstance(data, dict):
                    raise JournalMutationError('日志格式无效')
                if not isinstance(data.get('revision'), int) or isinstance(data.get('revision'), bool):
                    raise JournalMutationError('日志版本无效')
                if not isinstance(data.get('campaignId'), str) or not data['campaignId']:
                    raise JournalMutationError('战役信息无效')
                if data.get('operation') not in ('create', 'update', 'delete'):
                    raise JournalMutationError('日志操作无效')
            except (ValueError, TypeError, OverflowError, json.JSONDecodeError):
                self._send_json({'error': '日志格式无效或过长'}, 400)
                return
            with LOCK:
                session = session_from_request(data)
                if data.get('sessionToken'):
                    if not session:
                        self._send_json({'error': '请重新加入房间'}, 401)
                        return
                    author = journal_actor_name(session.get('name'), '玩家')
                    is_dm = False
                elif host_request_allowed(self):
                    author = 'DM'
                    is_dm = True
                else:
                    self._send_json({'error': '需要有效玩家会话'}, 401)
                    return
                if STATE is None or data.get('campaignId') != STATE.get('campaignId'):
                    self._send_json({'error': '战役已切换或主机尚未同步'}, 409)
                    return
                current = normalize_journal(STATE.get('journal'), STATE.get('campaignId'))
                if data.get('revision') != current['revision']:
                    self._send_json({'error': '日志已被其他人修改，请保留草稿并重新打开合并'}, 409)
                    return
                if not consume_action_slot(str(data.get('sessionToken') or 'journal-dm')):
                    self._send_json({'error': '保存过于频繁'}, 429)
                    return
                now_ms = int(time.time() * 1000)
                try:
                    journal, entry_id = mutate_journal(
                        current,
                        data,
                        author,
                        is_dm,
                        now_ms,
                        current_campaign_world_seconds(STATE, now_ms),
                        STATE.get('campaignId'),
                    )
                except JournalPermissionError as error:
                    self._send_json({'error': str(error)}, 403)
                    return
                except JournalMutationError as error:
                    self._send_json({'error': str(error)}, 400)
                    return
                act = {'op': 'journalEdit', 'campaignId': STATE.get('campaignId'), 'journal': journal, 'seq': NEXT_SEQ}
                apply_action(STATE, act)
                seq = NEXT_SEQ
                NEXT_SEQ += 1
                STATE_REVISION += 1
                STATE['_streamSeq'] = seq
                STATE['_stateRevision'] = STATE_REVISION
                act.update(campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID)
                RECENT_ACTIONS.append(act)
                del RECENT_ACTIONS[:-MAX_RECENT]
            broadcast({'type': 'action', 'seq': seq, 'action': act}, seq)
            self._send_json({'ok': True, 'journal': journal, 'entryId': entry_id})
        elif self.path == '/api/local-save':
            self.handle_local_save()
        elif self.path == '/api/player-name':
            try:
                data = self._read_json_body(4096)
                if not isinstance(data, dict): raise profiles.ProfileError('请求无效')
                name = data.get('name')
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 24 or any(ord(c) < 32 for c in name):
                    raise profiles.ProfileError('玩家名需为 1–24 个字符')
                name = name.strip()
                with profiles.LOCK, LOCK:
                    session = touch_session(data.get('sessionToken'))
                    if not session: raise profiles.ProfileError('会话已失效，请重新登录', 401)
                    pid = session['playerId']
                    if data.get('playerId') and data['playerId'] != pid: raise profiles.ProfileError('只能修改自己的名字', 403)
                    if data.get('expectedName') != session['name']: raise profiles.ProfileError('名字已更新，请刷新后重试', 409)
                    now = int(time.time()*1000)
                    if any(s['playerId'] != pid and s['name'].casefold() == name.casefold() and s.get('status') != 'offline' and now-int(s.get('lastSeen',0)) < 35000 for s in SESSIONS.values()):
                        raise profiles.ProfileError('这个名字已有玩家使用', 409)
                    store = profile_store()
                    if session.get('persistent'):
                        store.rename(pid, name, data['expectedName'])
                    elif any(p['name'].casefold() == name.casefold() for p in store.players()):
                        raise profiles.ProfileError('这个名字已有玩家档案使用', 409)
                    for active in SESSIONS.values():
                        if active['playerId'] == pid: active['name'] = name
                    result = public_player_session(session)
                    players = online_players()
                self._send_json({'ok':True, 'session':result})
                broadcast({'type':'presence','players':players})
            except profiles.ProfileError as error:
                self._send_json({'ok':False,'error':str(error)},error.status)
            except (ValueError, TypeError, OverflowError):
                self._send_json({'ok':False,'error':'改名信息无效'},400)
            except OSError:
                self._send_json({'ok':False,'error':'名字写入未完成，请刷新核对后重试'},500)
        elif self.path in ('/api/session', '/api/register'):
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
            registering = self.path == '/api/register'
            if (AUTH_METHOD == 'name' and (registering or not data.get('sessionToken'))) or registering or data.get('credential'):
                try:
                    if not allow_credential_attempt(self.client_address[0]):
                        raise profiles.ProfileError('登录尝试过于频繁，请稍后再试', 429)
                    if (registering or data.get('roomCode')) and str(data.get('roomCode') or '').strip().upper() != ROOM_CODE:
                        raise profiles.ProfileError('房间码不正确', 403)
                    if registering:
                        if not allow_registration_attempt(self.client_address[0]):
                            raise profiles.ProfileError('注册尝试过于频繁，请稍后再试', 429)
                        profile = authenticate(profile_store(), data, register=True) if AUTH_METHOD == 'name' else profile_store().register(data.get('nickname'), data.get('credential'))
                    else:
                        profile = authenticate(profile_store(), data) if AUTH_METHOD == 'name' else profile_store().login(data['credential'])
                    token = secrets.token_urlsafe(32)
                    with LOCK:
                        session = {'token': token, 'playerId': profile['playerId'], 'name': profile['name'],
                                   'persistent': True, '_authVersion': profile['_authVersion'], 'status': 'online', 'lastSeen': int(time.time()*1000)}
                        SESSIONS[token] = session
                    public = public_player_session(session); public['sessionToken'] = token
                    self._send_json({'ok': True, 'session': public, 'roomCode': ROOM_CODE})
                    broadcast({'type': 'presence', 'players': online_players()})
                except profiles.ProfileError as error:
                    self._send_json({'ok': False, 'error': str(error)}, error.status)
                except OSError:
                    self._send_json({'ok': False, 'error': '写入未完成，请先尝试用玩家名字登录；若不存在再创建'}, 500)
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
                        public_session = public_player_session(existing)
                        public_session.pop('token', None)
                        public_session['sessionToken'] = resume
                        self._send_json({'ok': True, 'session': public_session, 'roomCode': ROOM_CODE})
                        return
                    self._send_json({'ok': False, 'error': '会话已失效，请使用玩家名字重新登录'}, 401)
                    return
            if not nickname:
                self._send_json({'ok': False, 'error': '请填写玩家名'}, 400)
                return
            with LOCK:
                now = int(time.time() * 1000)
                resuming = touch_session(resume, 'online') if resume else None
                if resuming and resuming.get('persistent'):
                    nickname = profile_store().read(resuming['playerId'])['name']
                if resume and not resuming:
                    self._send_json({'ok': False, 'error': '会话已失效，请使用玩家名字重新登录'}, 401)
                    return
                active_same_name = next((s for s in SESSIONS.values()
                                         if s.get('name') == nickname and now - int(s.get('lastSeen', 0)) < 35000
                                         and s.get('status') != 'offline'
                                         and (not resuming or s.get('playerId') != resuming.get('playerId'))), None)
                if active_same_name and not (resume and active_same_name.get('token') == resume):
                    self._send_json({'ok': False, 'error': '这个名字已经在线，请换一个名字'}, 409)
                    return
                if resuming:
                    session = resuming
                    if not session:
                        self._send_json({'ok': False, 'error': '会话已失效，请使用玩家名字重新登录'}, 401)
                        return
                    session['name'] = nickname
                    public_session = public_player_session(session)
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
            public_session = public_player_session(session)
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
        elif self.path == '/api/players/kick':
            if not host_request_allowed(self):
                self._send_json({'ok': False, 'error': 'kick api is host-only'}, 403)
                return
            try:
                data = self._read_json_body(64 * 1024)
            except OverflowError:
                self._send_json({'ok': False, 'error': '请求过大'}, 413)
                return
            except (ValueError, TypeError, json.JSONDecodeError):
                self._send_json({'ok': False, 'error': '玩家信息无效'}, 400)
                return
            player_id = str((data or {}).get('playerId') or '').strip()[:64]
            if not re.fullmatch(r'[A-Za-z0-9_-]{2,64}', player_id):
                self._send_json({'ok': False, 'error': '玩家标识无效'}, 400)
                return
            with LOCK:
                removed = revoke_player_sessions(player_id)
                players = online_players()
            if not removed:
                self._send_json({'ok': False, 'error': '玩家连接已经不存在'}, 404)
                return
            player_name = str(removed[0].get('name') or '玩家')[:24]
            broadcast({
                'type': 'sessionRevoked',
                'playerId': player_id,
                'reason': '已被主控台移出房间',
            })
            broadcast({'type': 'presence', 'players': players})
            self._send_json({'ok': True, 'playerId': player_id, 'name': player_name, 'players': players})
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
                if not host_request_allowed(self):
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
            if not host_request_allowed(self):
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
            with profiles.LOCK, LOCK:
                if (ResourceStore(profile_store(), profiles).database.active() and data.get('protocolVersion') != SERVER_PROTOCOL_VERSION) or data.get('protocolVersion') not in (None, SERVER_PROTOCOL_VERSION) or ((STATE or {}).get('protocolVersion') == SERVER_PROTOCOL_VERSION and data.get('protocolVersion') != SERVER_PROTOCOL_VERSION):
                    self._send_json({'ok': False, 'error': '请刷新旧主控台页面后重新联机'}, 409)
                    return
                seq0 = 0
                try:
                    seq0 = int(data.pop('_streamSeq', 0) or 0)
                except Exception:
                    seq0 = 0
                if (STATE or {}).get('campaignId') != data.get('campaignId'):
                    RECENT_ACTIONS.clear()
                    ACTION_IDS.clear()
                next_state = cache_stream_media(data)
                next_state['journal'] = normalize_journal(next_state.get('journal'), next_state.get('campaignId'))
                # 主机快照没包含的玩家动作，重新应用回去（动作都是幂等的）
                for act in RECENT_ACTIONS:
                    if act.get('seq', 0) > seq0:
                        apply_action(next_state, act)
                try:
                    ResourceStore(profile_store(), profiles).reconcile(next_state, accept_changes=True, from_host=True)
                    sync_all_downed_portraits(next_state)
                    next_state.pop('_characterRuntime', None)
                    sync_changed_owned_tokens(STATE, next_state)
                except (profiles.ProfileError, OSError) as error:
                    self._send_json({'ok': False, 'error': str(error)}, getattr(error, 'status', 500)); return
                STATE = next_state
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
            active_map = None
            if isinstance(snapshot, dict):
                active_id = snapshot.get('activeMapId')
                active_map = next((item for item in (snapshot.get('maps') or [])
                                   if isinstance(item, dict) and item.get('id') == active_id), None)
            self._send_json({
                'ok': True,
                'stateRevision': STATE_REVISION,
                'characterUpdates': character_updates(STATE),
                'mapId': active_map.get('id') if isinstance(active_map, dict) else None,
                'mapAssetUrl': active_map.get('mapData') if isinstance(active_map, dict) else None,
            })
        elif self.path.startswith('/api/music'):
            if not host_request_allowed(self):
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
            if not host_request_allowed(self):
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
            if action.get('op') == 'danmaku':
                self.handle_danmaku(data, action, 'DM', 'dm', 'dm')
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
            player = str(session.get('playerId') or '').strip()
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
                if not self.action_context_matches(data):
                    self._send_json({'ok': False, 'error': '战役或服务器已切换，请等待同步后重试'}, 409)
                    return
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
                    if not self.action_context_matches(data):
                        self._send_json({'ok': False, 'error': '战役或服务器已切换，请重新同步'}, 409)
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
                    initiative_action.update(campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID)
                    initiative_action.update(name=session['name'], displayName=session['name'])
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
                        'name': session['name'],
                        'displayName': session['name'],
                        'actor': player,
                        'turnSerial': int(requested_serial),
                        'nextEntryId': next_entry.get('id'),
                        'nextTurnSerial': encounter_turn_serial(STATE) + 1,
                        'round': next_round,
                        'worldTimeSeconds': total_seconds,
                    }
                    if not self.action_context_matches(data):
                        self._send_json({'ok': False, 'error': '战役或服务器已切换，请重新同步'}, 409)
                        return
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
                    end_action.update(campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID)
                    RECENT_ACTIONS.append(end_action)
                    if len(RECENT_ACTIONS) > MAX_RECENT:
                        del RECENT_ACTIONS[:len(RECENT_ACTIONS) - MAX_RECENT]
                    ev = {'type': 'action', 'seq': seq, 'revision': STATE_REVISION, 'action': dict(end_action)}
                broadcast(ev, seq)
                self._send_json({'ok': True, 'seq': seq, 'stateRevision': STATE_REVISION})
                return
            if action.get('op') == 'danmaku':
                self.handle_danmaku(data, action, session['name'], 'player', player)
                return
            # 玩家只会把公开骰送到服务器；私密骰完全留在当前浏览器。
            # 公开骰不修改地图状态，但会广播给所有在线客户端写入各自骰点记录。
            if action.get('op') == 'roll':
                public_roll = normalize_roll_action(action, session['name'])
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
                    public_reaction = normalize_map_reaction(STATE, action, session['name']) if STATE is not None else None
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
            with profiles.LOCK, LOCK:
                if STATE is None:
                    self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                    return
                if action.get('op') == 'bindOwnedPiece':
                    self._send_json({'ok': False, 'error': '请使用收入棋子库入口'}, 403); return
                is_spawn_action = action.get('op') == PLAYER_SPAWN_ACTION
                is_owned_release_action = action.get('op') == PLAYER_OWNED_RELEASE_ACTION
                is_owned_recall_action = action.get('op') == PLAYER_OWNED_RECALL_ACTION
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
                    normalized_spawn['token']['ownerPlayerId'] = player
                    normalized_spawn['token']['owner'] = session['name']
                    if not str((action.get('draft') or {}).get('name') or '').strip():
                        normalized_spawn['token']['name'] = (session['name'] + '的临时棋子')[:24]
                    action = normalized_spawn
                elif is_owned_release_action:
                    normalized_release, release_error, release_status = normalize_player_owned_release_action(
                        STATE, action, player, session.get('name')
                    )
                    if not normalized_release:
                        self._send_json({'ok': False, 'error': release_error or '个人棋子释放失败'}, release_status or 400)
                        return
                    action = normalized_release
                elif is_owned_recall_action:
                    normalized, error, code = normalize_player_owned_recall_action(STATE, action, player)
                    if not normalized:
                        self._send_json({'ok': False, 'error': error}, code); return
                    action = normalized
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
                    action['name'] = session['name']
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
                            action.pop('segmentEnds', None)
                    elif not can_control(STATE, tok, player):
                        self._send_json({'ok': False, 'error': '只能操作自己名下的棋子'}, 403)
                        return
                if not self.action_context_matches(data):
                    self._send_json({'ok': False, 'error': '战役或服务器已切换，请重新同步'}, 409)
                    return
                if action.get('op') == 'patchToken':
                    _, changing_token = find_token(STATE, action.get('tokenId'))
                    if changing_token and changing_token.get('ownedPieceId') and any(k in action.get('patch', {}) for k in ('hp','hpMax','tempHp','tempHpMax','ac')):
                        canonical = ResourceStore(profile_store(), profiles).character(STATE.get('campaignId'), changing_token['ownedPieceId'])
                        if canonical and action.get('characterRevision') != canonical['revision']:
                            self._send_json({'ok': False, 'error': '角色状态已更新，请刷新后调整'}, 409); return
                if action.get('op') == 'characterState':
                    self._send_json({'ok': False, 'error': '角色同步由服务器处理'}, 403); return
                candidate = copy.deepcopy(STATE) if action.get('op') in ('patchToken', PLAYER_OWNED_RELEASE_ACTION, PLAYER_OWNED_RECALL_ACTION) else STATE
                if not apply_action(candidate, action):
                    if is_spawn_action:
                        error = '临时棋子放置失败'
                    elif is_owned_release_action:
                        error = '个人棋子释放失败'
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
                try:
                    if action.get('op') in ('patchToken', PLAYER_OWNED_RELEASE_ACTION, PLAYER_OWNED_RECALL_ACTION):
                        ResourceStore(profile_store(), profiles).reconcile(candidate, accept_changes=True, from_host=is_owned_release_action or is_owned_recall_action)
                        sync_all_downed_portraits(candidate)
                        _, synced = find_token(candidate, action.get('tokenId'))
                        if not synced and is_owned_recall_action:
                            synced = candidate.get('parkedOwnedPieces', {}).get(action.get('ownedPieceId'))
                        if synced and synced.get('ownedPieceId') and synced.get('ownerPlayerId') == player:
                            if action.get('op') == 'patchToken':
                                for field in ('hp','hpMax','tempHp','tempHpMax','ac'):
                                    if field in action.get('patch', {}) and field in synced: action['patch'][field] = synced[field]
                                if any(isinstance(form, dict) and str(form.get('name') or '').strip().startswith('倒地')
                                       for form in synced.get('portraitVariants') or []):
                                    action['patch']['portraitVariant'] = synced.get('portraitVariant')
                                    action['patch']['portraitBeforeDowned'] = synced.get('portraitBeforeDowned')
                            elif action.get('op') == PLAYER_OWNED_RELEASE_ACTION: action['token'] = copy.deepcopy(synced)
                            profile_store().sync_token(player, synced, candidate.get('campaignId'))
                except (profiles.ProfileError, OSError) as error:
                    self._send_json({'ok': False, 'error': str(error) or '棋子库保存失败'}, getattr(error, 'status', 500)); return
                STATE = candidate
                STATE_REVISION += 1
                STATE['_stateRevision'] = STATE_REVISION
                seq = NEXT_SEQ
                NEXT_SEQ += 1
                STATE['_streamSeq'] = seq
                action['characterUpdates'] = character_updates(candidate, public=True)
                action['displayName'] = session['name']
                action['name'] = session['name']
                act = dict(action)
                act['seq'] = seq
                if action_id:
                    act['actionId'] = action_id
                act.update(campaignId=STATE.get('campaignId'), _sessionId=SESSION_ID)
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
        self.connection.settimeout(15)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self._cors()
        self.end_headers()
        client = SSEClient(self.connection)
        with LOCK:
            initial = state_snapshot()
            try:
                last_id = int(self.headers.get('Last-Event-ID') or 0)
            except (TypeError, ValueError):
                last_id = 0
            recent = list(RECENT_ACTIONS)
            first_recent = recent[0].get('seq', 0) if recent else 0
            can_replay = bool(last_id and recent and first_recent - 1 <= last_id <= recent[-1].get('seq', 0))
            if initial is not None:
                client.enqueue(sse_bytes({'type': 'state', 'state': initial}, initial.get('_streamSeq')))
                # This snapshot already includes committed actions through its
                # stream sequence; replay only actions it does not represent.
                last_id = max(last_id, int(initial.get('_streamSeq') or 0))
            if can_replay:
                for action in recent:
                    if action.get('seq', 0) > last_id:
                        event = {'type': 'action', 'seq': action.get('seq', 0), 'action': dict(action)}
                        if not client.enqueue(sse_bytes(event, action.get('seq'))):
                            break
            if not client.closed:
                CLIENTS.append(client)
        try:
            while True:
                payload = client.next_payload()
                if payload is None:
                    break
                self.wfile.write(payload)
                self.wfile.flush()
        except (OSError, ValueError):
            pass
        finally:
            client.close()
            with LOCK:
                if client in CLIENTS:
                    CLIENTS.remove(client)

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
    try:
        project_lock = ProjectServerLock(LOCAL_SAVE_ROOT)
    except RuntimeError as error:
        sys.exit(str(error))
    from server.workspace_backup import recover_pending
    recover_pending(LOCAL_SAVE_ROOT)
    from server.distribution import initialize as initialize_distribution
    initialize_distribution(ROOT, LOCAL_SAVE_ROOT)
    from server.player_directories import migrate as migrate_player_directories
    migrate_player_directories(LOCAL_SAVE_ROOT, create_backup=True)
    srv = Server((BIND_HOST, PORT), Handler)
    print('=' * 56)
    print('桑哆尔之歌联机服务器已启动，端口 %d，监听 %s' % (PORT, BIND_HOST))
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
    if getattr(srv,'restore_pending',False):
        srv.server_close()
        project_lock.close()
        os.execv(sys.executable,[sys.executable,*sys.argv])
