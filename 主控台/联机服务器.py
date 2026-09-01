#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
桑哆尔的世界 · 简易联机服务器（零依赖，Python 3.6+）
用法：在项目根目录运行  python3 主控台/联机服务器.py [端口]
默认端口 8090。启动后：
  主机（你）：浏览器打开 http://localhost:8090/主控台/主控台.html 或本地双击主控台，
              在「📡 联机 → 开启玩家模式」开启推送。
  玩家：同一 WiFi 下用浏览器打开 http://<本机IP>:端口/主控台/观战.html
"""
import os, sys, json, time, socket, threading, re, base64, hashlib, math
from urllib.parse import urlparse, parse_qs, unquote_to_bytes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
# 服务器可能放在项目根目录或 主控台/ 下：始终以“项目根目录”为网站根目录
BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE) if os.path.basename(BASE) == '主控台' else BASE
STATE = None
CLIENTS = []          # [(wfile, lock), ...] SSE 连接
LOCK = threading.Lock()
RECENT_ACTIONS = []   # 玩家动作（带自增 seq），用于主机合并
NEXT_SEQ = 1
MAX_RECENT = 500
PATCH_FIELDS = {'hp', 'hpMax', 'ac'}
MAX_MOVE_POINTS = 60
MAX_TURN_PATH_POINTS = 200
MUSIC_EXTS = ('.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus', '.webm')
# 联机媒体只留在服务器内存中。状态里改为内容哈希 URL，浏览器可长期缓存，
# 不再把 Base64 地图和头像塞进每一条 SSE 消息。
ASSETS = {}           # {sha256: (mime, bytes)}
DATA_URL_RE = re.compile(r'^data:([^;,]+)?(;base64)?,(.*)$', re.S)


def cache_data_url(value):
    """把 data URL 放入内存缓存，返回可缓存的同源资源地址。"""
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


def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


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
    """玩家只能操作自己控制组内的棋子；骑手可以把坐骑一起带走。"""
    player = (player or '').strip()
    if not player:
        return False
    group = token_control_group(state, token)
    for m in (state or {}).get('maps', []) or []:
        for candidate in m.get('tokens', []) or []:
            if candidate.get('id') in group and (candidate.get('owner') or '').strip() == player:
                return True
    return False


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


def current_turn_token_id(state):
    encounter = encounter_state(state)
    current_id = encounter.get('currentEntryId')
    for entry in encounter.get('entries', []) or []:
        if isinstance(entry, dict) and entry.get('id') == current_id:
            token_id = entry.get('tokenId')
            return token_id if token_id else None
    return None


def can_move_token(state, token, player, action):
    """判断玩家是否能在当前模式、当前回合移动该棋子。"""
    if not can_control(state, token, player):
        return False, '只能操作自己名下的棋子'
    encounter = encounter_state(state)
    if encounter.get('playMode') != 'turn':
        return True, None
    current_token_id = current_turn_token_id(state)
    if not current_token_id:
        return False, '当前先攻尚未关联棋子，暂时不能移动'
    if current_token_id not in token_control_group(state, token):
        return False, '尚未轮到这个角色'
    requested_serial = finite_number(action.get('turnSerial'))
    if requested_serial is None or int(requested_serial) != encounter_turn_serial(state):
        return False, '回合已经变化，请重新操作'
    return True, None


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


def apply_action(state, action):
    """幂等地把玩家动作应用到状态上。"""
    if not isinstance(action, dict):
        return False
    op = action.get('op')
    m, t = find_token(state, action.get('tokenId'))
    if not m or not t:
        return False
    if op == 'patchToken':
        patch = action.get('patch')
        if not isinstance(patch, dict) or not patch:
            return False
        for k, v in patch.items():
            if k not in PATCH_FIELDS:
                continue
            if k == 'hp':
                try:
                    t[k] = max(0, min(99999, int(v)))
                except Exception:
                    pass
            elif k == 'hpMax':
                try:
                    t[k] = max(1, min(99999, int(v)))
                except Exception:
                    pass
            elif k == 'ac':
                try:
                    t[k] = max(0, min(99, int(v)))
                except Exception:
                    pass
        return True
    if op == 'moveToken':
        if action.get('mapId') is not None and action.get('mapId') != m.get('id'):
            return False
        point = clamp_token_point(m, t, {'x': action.get('x'), 'y': action.get('y')})
        if point is None:
            return False
        action['mapId'] = m.get('id')
        action['x'] = point['x']
        action['y'] = point['y']
        encounter = encounter_state(state)
        if encounter.get('playMode') == 'turn':
            serial = finite_number(action.get('turnSerial'))
            if serial is None:
                return False
            serial = int(serial)
            if serial != encounter_turn_serial(state):
                t['x'] = point['x']
                t['y'] = point['y']
                for r in m.get('tokens', []) or []:
                    if r.get('mountId') == t.get('id'):
                        r['x'] = t['x']
                        r['y'] = t['y']
                return True
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

def broadcast(data):
    payload = ('data: ' + json.dumps(data, ensure_ascii=False) + '\n\n').encode('utf-8')
    with LOCK:
        clients = list(CLIENTS)
    for wfile, lock in clients:
        try:
            with lock:
                wfile.write(payload)
                wfile.flush()
        except Exception:
            with LOCK:
                CLIENTS.remove((wfile, lock))

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
        elif self.path == '/api/state':
            with LOCK:
                self._send_json(STATE if STATE is not None else {})
        elif self.path.startswith('/api/actions'):
            qs = parse_qs(urlparse(self.path).query)
            try:
                after = int((qs.get('after') or ['0'])[0])
            except Exception:
                after = 0
            with LOCK:
                acts = [a for a in RECENT_ACTIONS if a.get('seq', 0) > after]
            self._send_json({'actions': acts})
        elif self.path == '/api/info':
            self._send_json({'port': PORT, 'ips': get_ips(), 'name': '桑哆尔联机'})
        elif self.path == '/api/events':
            self.stream_events()
        elif self.path == '/' or self.path == '/index.html':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self._cors()
            self.end_headers()
            host = 'http://localhost:%d/主控台/主控台.html' % PORT
            viewer = 'http://localhost:%d/主控台/观战.html' % PORT
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

    def do_POST(self):
        if self.path == '/api/state':
            global STATE
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length) if length else b'{}'
            try:
                data = json.loads(body.decode('utf-8'))
            except Exception:
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
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
                # 观战端用服务器时钟作为世界时间运行快照的锚点，避免各设备系统时钟不同。
                STATE['_serverNow'] = int(time.time() * 1000)
            broadcast({'type': 'state', 'state': STATE})
            self._send_json({'ok': True})
        elif self.path.startswith('/api/music'):
            length = int(self.headers.get('Content-Length') or 0)
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
        elif self.path == '/api/action':
            global NEXT_SEQ
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length) if length else b'{}'
            try:
                data = json.loads(body.decode('utf-8'))
            except Exception:
                self._send_json({'ok': False, 'error': 'bad json'}, 400)
                return
            player = str(data.get('player') or '').strip()
            action = data.get('action') or {}
            if not player:
                self._send_json({'ok': False, 'error': '缺少玩家名'}, 400)
                return
            if not isinstance(action, dict):
                self._send_json({'ok': False, 'error': '动作数据无效'}, 400)
                return
            # 掷骰：不修改状态、不写入动作历史，只广播一次让所有人看到
            if action.get('op') == 'roll':
                ev = {'type': 'action', 'seq': 0, 'action': dict(action)}
                ev['action']['name'] = player
                broadcast(ev)
                self._send_json({'ok': True})
                return
            # BGM：不修改状态，只广播让玩家端跟随播放
            if action.get('op') == 'bgm':
                ev = {'type': 'action', 'seq': 0, 'action': dict(action)}
                broadcast(ev)
                self._send_json({'ok': True})
                return
            # 涂鸦：直接更新对应地图的涂鸦列表并广播
            if action.get('op') == 'doodle':
                with LOCK:
                    if STATE is None:
                        self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                        return
                    mid = action.get('mapId')
                    m = next((x for x in STATE.get('maps', []) if x.get('id') == mid), None)
                    if not m or not isinstance(action.get('doodles'), list):
                        self._send_json({'ok': False, 'error': '涂鸦数据无效'}, 400)
                        return
                    m['doodles'] = action['doodles']
                ev = {'type': 'action', 'seq': 0, 'action': dict(action)}
                ev['action']['name'] = player
                broadcast(ev)
                self._send_json({'ok': True})
                return
            with LOCK:
                if STATE is None:
                    self._send_json({'ok': False, 'error': '主机尚未推送状态'}, 400)
                    return
                map_obj, tok = find_token(STATE, action.get('tokenId'))
                if not tok:
                    self._send_json({'ok': False, 'error': '棋子不存在'}, 404)
                    return
                if action.get('op') == 'moveToken':
                    allowed, reason = can_move_token(STATE, tok, player, action)
                    if not allowed:
                        self._send_json({'ok': False, 'error': reason}, 409 if reason == '回合已经变化，请重新操作' else 403)
                        return
                    if action.get('mapId') is not None and action.get('mapId') != map_obj.get('id'):
                        self._send_json({'ok': False, 'error': '地图与棋子不匹配'}, 400)
                        return
                elif not can_control(STATE, tok, player):
                    self._send_json({'ok': False, 'error': '只能操作自己名下的棋子'}, 403)
                    return
                if not apply_action(STATE, action):
                    self._send_json({'ok': False, 'error': '不支持的动作'}, 400)
                    return
                seq = NEXT_SEQ
                NEXT_SEQ += 1
                act = dict(action)
                act['seq'] = seq
                RECENT_ACTIONS.append(act)
                if len(RECENT_ACTIONS) > MAX_RECENT:
                    del RECENT_ACTIONS[:len(RECENT_ACTIONS) - MAX_RECENT]
                ev = {'type': 'action', 'seq': seq, 'action': dict(action)}
            broadcast(ev)
            self._send_json({'ok': True, 'seq': seq})
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
            initial = dict(STATE) if STATE is not None else None
            if initial is not None:
                # 新观战端可能在状态最后一次变更很久之后才接入，需要以本次发送时刻校准世界时间。
                initial['_serverNow'] = int(time.time() * 1000)
        try:
            if initial is not None:
                with lock:
                    ev = {'type': 'state', 'state': initial}
                    self.wfile.write(('data: ' + json.dumps(ev, ensure_ascii=False) + '\n\n').encode('utf-8'))
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
    srv = Server(('0.0.0.0', PORT), Handler)
    print('=' * 56)
    print('桑哆尔联机服务器已启动，端口 %d' % PORT)
    for ip in get_ips():
        if ip != '127.0.0.1':
            print('  玩家请打开:  http://%s:%d/主控台/观战.html' % (ip, PORT))
    print('  主机:        http://localhost:%d/主控台/主控台.html' % PORT)
    print('  按 Ctrl+C 停止')
    print('=' * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
