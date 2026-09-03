#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
桑哆尔的世界 · 简易联机服务器（零依赖，Python 3.6+）
用法：在项目根目录运行  python3 主控台/联机服务器.py [端口]
      或运行  python3 start_server.py --port 8092 --bind 0.0.0.0
默认端口 8090。启动后：
  主机（你）：浏览器打开 http://localhost:8090/主控台/主控台.html 或本地双击主控台，
              在「📡 联机 → 开启玩家模式」开启推送。
  玩家：同一 WiFi 下用浏览器打开 http://<本机IP>:端口/主控台/玩家.html
"""
import os, sys, json, time, socket, threading, re, base64, hashlib, math, secrets
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
PATCH_FIELDS = {'hp', 'hpMax', 'ac', 'spellRange'}
MAX_MOVE_POINTS = 60
MAX_TURN_PATH_POINTS = 200
MAX_ACTION_BODY = 512 * 1024
DOODLE_ACTIONS = {'doodleAdd', 'doodleDelete', 'doodleClear'}
INITIATIVE_ACTIONS = {'initiativeSwap'}
DOODLE_TOOLS = {'pen', 'line', 'arrow', 'circle'}
DOODLE_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
DOODLE_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{6}$')
MAX_DOODLE_POINTS = 800
MAX_DOODLES = 1000
ACTION_WINDOW_MS = 1000
MAX_ACTIONS_PER_WINDOW = 40
ASSET_ROOT = os.path.join(ROOT, '.sundoll-cache', '联机资源')
MUSIC_EXTS = ('.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus', '.webm')
# 地图和头像转换为内容哈希 URL，浏览器可长期缓存；资源同时写入磁盘，
# 不再把 Base64 地图和头像塞进每一条 SSE 消息。
ASSETS = {}           # {sha256: (mime, bytes)}
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.S)

SESSION_ID = secrets.token_hex(8)
ROOM_CODE = secrets.token_hex(3).upper()
STATE_REVISION = 0
SESSIONS = {}         # {sessionToken: {playerId, name, status, lastSeen}}
ACTION_IDS = {}       # {actionId: seq}，防止网络重试重复执行
MAX_ACTION_IDS = 2000
ACTION_RATE = {}      # {sessionToken: [最近请求时间戳]}
HOST_ACTIONS = {'roll', 'announce', 'bgm', 'mapReaction', 'restTransition'}
MAP_REACTION_EMOJIS = {'👍', '❤️', '😂', '😮', '🔥', '✨', '❓', '⚔️', '🎯', '👏'}
REACTION_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,96}$')
REACTION_RATE = {}
REACTION_COOLDOWN_MS = 450
REST_TRANSITION_DURATIONS = {'short': 2200, 'long': 4400}


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
    }


def normalize_rest_transition_action(action):
    """校验主控台发出的瞬时休息表现；它不进入持久状态或动作历史。"""
    if not isinstance(action, dict):
        return None
    kind = str(action.get('kind') or '').strip().lower()
    rest_id = str(action.get('restId') or '').strip()
    if kind not in REST_TRANSITION_DURATIONS or not REACTION_ID_RE.fullmatch(rest_id):
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
    """离开当前单位回合时递减有期限的公开状态；无限期状态保持不变。"""
    token_id = current_turn_token_id(state)
    token = find_token(state, token_id)[1] if token_id else None
    if not token or not isinstance(token.get('conditions'), list):
        return False
    changed = False
    next_conditions = []
    for condition in token.get('conditions') or []:
        if not isinstance(condition, dict):
            next_conditions.append(condition)
            continue
        raw_remaining = condition.get('remainingTurns')
        remaining_number = finite_number(raw_remaining)
        if raw_remaining is None or remaining_number is None or remaining_number <= 0:
            next_conditions.append(condition)
            continue
        remaining = max(0, int(remaining_number) - 1)
        changed = True
        if remaining:
            updated = dict(condition)
            updated['remainingTurns'] = remaining
            next_conditions.append(updated)
    if changed:
        token['conditions'] = next_conditions
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
        world['totalSeconds'] = max(0, int(finite_number(action.get('worldTimeSeconds')) or world.get('totalSeconds', 0)))
        world['runningSince'] = None
        return True
    if op in DOODLE_ACTIONS:
        return apply_doodle_action(state, action)
    m, t = find_token(state, action.get('tokenId'))
    if not m or not t:
        return False
    actor = str(action.get('actor') or '').strip()
    if op in ('moveToken', 'patchToken') and actor:
        replay_allowed, _ = can_act_with_token(state, t, actor, action)
        if not replay_allowed:
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
        return accepted
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
        item['online'] = int(session.get('lastSeen', 0)) >= cutoff
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
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/api/assets/'):
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
            self._send_json({
                'port': PORT,
                'bind': BIND_HOST,
                'ips': get_ips(),
                'name': '桑哆尔联机',
                'sessionId': SESSION_ID,
                'roomCode': ROOM_CODE,
                'stateRevision': revision,
                'playerCount': len([p for p in players if p.get('online')]),
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
                '<meta charset="utf-8"><title>桑哆尔联机服务器</title>'
                '<body style="background:#101218;color:#e8eaf0;font-family:sans-serif;padding:40px">'
                '<h2>🖥️ 桑哆尔联机服务器已启动（端口 %d）</h2>'
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

    def do_POST(self):
        global STATE, STATE_REVISION, NEXT_SEQ
        if self.path == '/api/session':
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
                snapshot = dict(STATE)
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
            d = os.path.join(ROOT, '音乐缓存')
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, name), 'wb') as f:
                f.write(data)
            clean_music_cache(d)
            self._send_json({'ok': True, 'url': '/音乐缓存/' + name})
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
                bgm_action = str(action.get('action') or '').strip().lower()
                if bgm_action not in ('play', 'pause', 'stop'):
                    self._send_json({'ok': False, 'error': 'BGM 动作无效'}, 400)
                    return
                bgm_url = str(action.get('url') or '').strip()[:2048]
                if bgm_url and not (bgm_url.startswith('/') or re.match(r'^https?://', bgm_url, re.I)):
                    self._send_json({'ok': False, 'error': 'BGM 地址无效'}, 400)
                    return
                public_action.update({
                    'action': bgm_action,
                    'track': str(action.get('track') or '')[:120],
                    'url': bgm_url,
                    'time': finite_int(action.get('time'), 0, 86400, 0),
                })
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
                        total_seconds += max(0, int((time.time() * 1000 - running_since) / 1000))
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
            # 掷骰：不修改状态、不写入动作历史，只广播一次让所有人看到
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
                is_doodle_action = action.get('op') in DOODLE_ACTIONS
                if is_doodle_action:
                    # 已加入房间的玩家都可以使用共享标注；作者名由服务器写入，不能伪造。
                    action['name'] = player
                else:
                    map_obj, tok = find_token(STATE, action.get('tokenId'))
                    if not tok:
                        self._send_json({'ok': False, 'error': '棋子不存在'}, 404)
                        return
                    if action.get('op') in ('moveToken', 'patchToken'):
                        allowed, reason = can_act_with_token(STATE, tok, player, action)
                        if not allowed:
                            self._send_json({'ok': False, 'error': reason}, 409 if reason == '回合已经变化，请重新操作' else 403)
                            return
                        if action.get('op') == 'moveToken' and action.get('mapId') is not None and action.get('mapId') != map_obj.get('id'):
                            self._send_json({'ok': False, 'error': '地图与棋子不匹配'}, 400)
                            return
                        # 记录动作原始玩家，主机快照并发覆盖后重放时会重新核对最新归属。
                        action['actor'] = player
                    elif not can_control(STATE, tok, player):
                        self._send_json({'ok': False, 'error': '只能操作自己名下的棋子'}, 403)
                        return
                if not apply_action(STATE, action):
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
    print('桑哆尔联机服务器已启动，端口 %d，监听 %s' % (PORT, BIND_HOST))
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
