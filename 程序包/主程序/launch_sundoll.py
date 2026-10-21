#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桑哆尔之歌的跨平台联机启动器。

macOS 和 Windows 的双击脚本只负责找到 Python；服务器检查、端口选择、
浏览器打开和 Cloudflare 临时 / 固定 Tunnel 都集中在这里，避免两套脚本漂移。
"""

import argparse
from server.runtime_config import protocol_version
from server.paths import APP_ROOT, CHECKOUT_ROOT, USER_DATA_ROOT, project_id
import json
import os
import queue
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import quote, urlencode


ROOT = APP_ROOT
SERVER_PROJECT_ID = project_id(ROOT)
SERVER_ENTRY = ROOT / "start_server.py"
DEFAULT_PORT = 8090
SERVER_PROTOCOL_VERSION = protocol_version()
SERVER_NAME = "桑哆尔之歌联机"
COMPATIBLE_SERVER_NAMES = {SERVER_NAME, "桑哆尔联机"}
HOST_ROUTE = "/主控台/主控台.html"
PLAYER_ROUTE = "/主控台/玩家.html"
LOCAL_URL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)
PUBLIC_TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.(?:trycloudflare\.com|lhr\.life|localhost\.run)", re.I)
NETWORK_SETTINGS = USER_DATA_ROOT / '联机设置.json'
# Eight workers: 5 s for hibernate, wait and post-kill wait, plus a margin.
SERVER_SHUTDOWN_TIMEOUT = 130
CONNECTOR_SHUTDOWN_TIMEOUT = 3


def process_marker(pid):
    """Identify a live process without sending a signal on Windows."""
    try:
        pid = int(pid)
        if pid <= 0:
            return None
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                return None if ctypes.get_last_error() == 87 else 'unknown'
            try:
                code = wintypes.DWORD()
                times = [wintypes.FILETIME() for _ in range(4)]
                if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return 'unknown'
                if code.value != 259:
                    return None
                if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                    return 'unknown'
                return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
            finally:
                kernel.CloseHandle(handle)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        except PermissionError:
            return 'unknown'
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=,comm='],
                                capture_output=True, text=True, timeout=3)
        return result.stdout.strip() or 'unknown'
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return 'unknown'


class TunnelOwnership:
    """One OS-held connector lease per workspace, including orphan detection."""
    def __init__(self, root=None):
        self.path = Path(root or NETWORK_SETTINGS.parent / '联机') / '公网连接.lock'
        self.handle = None
        self.owner = secrets.token_hex(24)
        self.record = {}

    def read(self):
        self.handle.seek(1)
        raw = self.handle.read(8193)
        if len(raw) > 8192:
            raise RuntimeError('公网连接记录过大，请保留文件并检查。')
        return json.loads(raw.decode('utf-8')) if raw else {}

    def write(self, record):
        self.handle.seek(1)
        self.handle.truncate(1)
        self.handle.write(json.dumps(record, ensure_ascii=False).encode('utf-8'))
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.record = record

    def acquire(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.handle = os.fdopen(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600), 'r+b')
        if self.path.stat().st_size == 0:
            self.handle.write(b'0'); self.handle.flush()
        try:
            if os.name == 'nt':
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close(); self.handle = None
            return False
        try:
            previous = self.read()
            if previous.get('connectorPid'):
                current = process_marker(previous['connectorPid'])
                if current is not None and (current == 'unknown' or
                        previous.get('connectorMarker') in (None, 'unknown', current)):
                    self.handle.close(); self.handle = None
                    return False
            self.write(dict(owner=self.owner, launcherPid=os.getpid()))
            return True
        except Exception:
            self.handle.close(); self.handle = None
            raise

    def is_owner(self):
        if self.handle is None:
            return False
        try:
            opened, current = os.fstat(self.handle.fileno()), self.path.stat()
            if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
                return False
            return self.read().get('owner') == self.owner
        except (OSError, ValueError, AttributeError):
            return False

    def connector(self, pid, borrowed=False):
        if not self.is_owner():
            raise RuntimeError('公网连接所有权已变化，本窗口不能创建或发布连接。')
        marker = process_marker(pid)
        self.write(dict(self.record, connectorPid=int(pid) if marker is not None else None,
                        connectorMarker=marker, borrowed=borrowed))

    def close(self):
        if self.handle is None:
            return
        try:
            if self.is_owner():
                pid = self.record.get('connectorPid')
                if not pid or process_marker(pid) is None:
                    self.write({})
        finally:
            self.handle.close(); self.handle = None


def existing_connector(port, fixed=None):
    """Find pre-lease connectors; never print captured process arguments."""
    try:
        if os.name == 'nt':
            command = ['powershell', '-NoProfile', '-Command',
                "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe' OR Name='ssh.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"]
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=5)
            if result.returncode:
                return 'unknown'
            entries = json.loads(result.stdout or '[]')
            entries = entries if isinstance(entries, list) else [entries]
            processes = [(row['ProcessId'], row.get('CommandLine') or '') for row in entries]
        else:
            result = subprocess.run(['ps', '-ax', '-o', 'pid=,comm='], capture_output=True, text=True, timeout=3)
            if result.returncode:
                return 'unknown'
            pids = []
            for line in result.stdout.splitlines():
                pid, executable = line.strip().split(None, 1)
                if Path(executable).name in ('cloudflared', 'ssh'):
                    pids.append(pid)
            if not pids:
                return None
            result = subprocess.run(['ps', '-p', ','.join(pids), '-o', 'pid=,args='], capture_output=True, text=True, timeout=3)
            if result.returncode:
                return 'unknown'
            processes = [line.strip().split(None, 1) for line in result.stdout.splitlines()]
        if fixed:
            token_file = Path(fixed['tokenFile'])
        else:
            configured = network_settings().get('cloudflareTunnel')
            token_file = Path(configured.get('tokenFile') or '联机/cloudflare-token') if isinstance(configured, dict) else Path('联机/cloudflare-token')
            if not token_file.is_absolute(): token_file = USER_DATA_ROOT / token_file
        token = str(token_file)
        known_hosts = str(USER_DATA_ROOT / '联机' / 'known_hosts')
        for pid, command in processes:
            args = [arg.strip('"') for arg in shlex.split(command, posix=os.name != 'nt')]
            # POSIX ps may render arguments containing spaces without quotes.
            token_match = ('--token-file' in args and token in args) or re.search(
                r'(?:^|\s)--token-file(?:\s+|=)[\"\']?' + re.escape(token) + r'[\"\']?(?=\s+-|$)', command)
            quick_url = 'http://127.0.0.1:%d' % port
            quick_match = ('--url' in args and quick_url in args) or re.search(
                r'(?:^|\s)--url(?:\s+|=)[\"\']?' + re.escape(quick_url) + r'[\"\']?(?=\s|$)', command)
            ssh_match = ('UserKnownHostsFile=' + known_hosts in command and 'nokey@localhost.run' in args)
            if token_match or quick_match or ssh_match:
                return int(pid)
        return None
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return 'unknown'


def network_settings():
    try:
        settings = json.loads(NETWORK_SETTINGS.read_text('utf-8'))
    except FileNotFoundError:
        settings = {}
    if not isinstance(settings, dict):
        raise ValueError('联机设置必须是 JSON 对象')
    return settings


def tunnel_provider():
    value = network_settings().get('tunnelProvider', 'cloudflare')
    if value not in ('cloudflare', 'localhost-run'):
        raise ValueError('联机设置中的公网通道无效')
    return value


def fixed_tunnel_settings():
    """The connector token stays in an ignored, machine-private file."""
    settings = network_settings().get('cloudflareTunnel')
    if settings is None:
        return None
    if not isinstance(settings, dict):
        raise ValueError('固定隧道设置必须是 JSON 对象')
    hostname = str(settings.get('hostname') or '').strip().lower()
    label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    if len(hostname) > 253 or not re.fullmatch(label + r'(?:\.' + label + r')+', hostname):
        raise ValueError('固定域名必须是纯域名，例如 sundollworld.com')
    token_file = Path(settings.get('tokenFile') or '联机/cloudflare-token')
    if not token_file.is_absolute():
        token_file = USER_DATA_ROOT / token_file
    port = int(settings.get('port', DEFAULT_PORT))
    if not 1 <= port <= 65535:
        raise ValueError('固定隧道的本机端口无效')
    return {'base': 'https://' + hostname, 'tokenFile': token_file, 'port': port}


def tunnel_output(process):
    """Allow DNS and origin checks even when connector logs are quiet."""
    messages = queue.Queue()
    def read():
        try:
            for line in process.stdout:
                messages.put(line)
        finally:
            messages.put(None)
    threading.Thread(target=read, daemon=True).start()
    while True:
        try:
            line = messages.get(timeout=5)
        except queue.Empty:
            yield ''
            continue
        if line is None:
            return
        yield line


def default_port():
    try:
        port = int(os.environ.get("SANGDUOER_PORT", DEFAULT_PORT))
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    return port if 1 <= port <= 65535 else DEFAULT_PORT


def page_url(host, port, route, room_code=""):
    url = "http://%s:%d%s" % (host, port, quote(route, safe="/"))
    if room_code:
        url += "?" + urlencode({"room": room_code})
    return url


def raw_server_info(port, timeout=0.45):
    """读取端口上的桑哆尔之歌服务信息，不在这里判断版本是否兼容。"""
    try:
        # 本机健康检查固定直连，避免系统 HTTP/HTTPS 代理接管 localhost
        # 后造成“服务器已启动但等待 12 秒超时”的误判。
        with LOCAL_URL_OPENER.open(
            "http://127.0.0.1:%d/api/info" % port, timeout=timeout
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        if payload.get("name") not in COMPATIBLE_SERVER_NAMES:
            return None
        if int(payload.get("port", 0)) != int(port):
            return None
        return payload
    except Exception:
        return None


def compatible_server_info(payload):
    if not isinstance(payload, dict):
        return False
    try:
        return int(payload.get("protocolVersion", 0)) == SERVER_PROTOCOL_VERSION and payload.get("projectId") == SERVER_PROJECT_ID
    except (TypeError, ValueError):
        return False


def server_info(port, timeout=0.45):
    """只把协议一致的桑哆尔之歌服务认作可复用服务。"""
    payload = raw_server_info(port, timeout)
    return payload if compatible_server_info(payload) else None


def incompatible_server_message(port, payload):
    if payload.get("projectId") == SERVER_PROJECT_ID:
        return (
            "端口 %d 仍在运行本项目更新前的服务（运行协议 %s，当前需要 %s）。\n"
            "请先在原主控台保存战役，再到原来的启动终端按 Ctrl+C 停止服务，"
            "然后重新双击启动器，并刷新主控台和玩家页面。\n"
            "仅关闭网页或再次双击启动器，不会停止旧服务。"
        ) % (port, payload.get("protocolVersion", "未知"), SERVER_PROTOCOL_VERSION)
    return (
        "端口 %d 被另一份项目或无法确认目录的桑哆尔之歌服务占用。\n"
        "请确认原服务的项目目录并保存战役，再在它的启动终端按 Ctrl+C 停止，"
        "然后重新启动本项目。"
    ) % port


def port_is_open(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.25)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    finally:
        sock.close()


def select_port(requested):
    probed = raw_server_info(requested)
    if compatible_server_info(probed):
        return requested, probed
    if probed:
        raise RuntimeError(incompatible_server_message(requested, probed))
    if not port_is_open(requested):
        return requested, None

    print("端口 %d 已被其他程序占用，正在寻找可用端口……" % requested)
    for port in range(requested + 1, min(requested + 20, 65536)):
        info = server_info(port)
        if info:
            print("发现已运行的桑哆尔之歌服务器：端口 %d。" % port)
            return port, info
        if not port_is_open(port):
            print("将改用端口 %d。" % port)
            return port, None
    raise RuntimeError("端口 %d–%d 均不可用" % (requested, requested + 19))


def wait_for_server(process, port, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = server_info(port)
        if info:
            return info
        if process.poll() is not None:
            return None
        time.sleep(0.25)
    return None


def stop_process(process, timeout=CONNECTOR_SHUTDOWN_TIMEOUT):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def prepare_server(requested_port, bind_host="0.0.0.0"):
    port, info = select_port(requested_port)
    if info:
        print("桑哆尔之歌服务器已经在端口 %d 运行，将直接复用。" % port)
        return None, info, port

    if not SERVER_ENTRY.is_file():
        raise RuntimeError("找不到服务器入口：%s" % SERVER_ENTRY)

    print("正在启动桑哆尔之歌联机服务器（端口 %d）……" % port)
    process = subprocess.Popen(
        [
            sys.executable,
            str(SERVER_ENTRY),
            "--port",
            str(port),
            "--bind",
            bind_host,
        ],
        cwd=str(ROOT),
    )
    info = wait_for_server(process, port)
    if not info:
        exit_code = process.poll()
        stop_process(process, timeout=SERVER_SHUTDOWN_TIMEOUT)
        detail = "进程退出码 %s" % exit_code if exit_code is not None else "等待 12 秒仍未就绪"
        raise RuntimeError("服务器启动失败（%s）。请查看上方报错。" % detail)
    return process, info, port


def connection_urls(info, port, local_only=False):
    room_code = str(info.get("roomCode") or "")
    candidates = []
    email_mode = (info.get('authentication') or {}).get('method') == 'email_password'
    for ip in (() if local_only or email_mode else (info.get("ips") or [])):
        ip = str(ip).strip()
        if ip and ip not in ("127.0.0.1", "localhost") and ip not in candidates:
            candidates.append(ip)
    if not candidates:
        candidates.append("127.0.0.1")
    host_url = page_url("127.0.0.1", port, '/account' if email_mode else HOST_ROUTE) + ('#dashboard' if email_mode else '')
    player_urls = [page_url(ip, port, '/account' if email_mode else PLAYER_ROUTE) + ('#dashboard' if email_mode else '') for ip in candidates]
    return host_url, player_urls, room_code


def show_connection_info(info, port, local_only=False):
    host_url, player_urls, room_code = connection_urls(info, port, local_only)
    print("\n本机服务已就绪。")
    email_mode = (info.get('authentication') or {}).get('method') == 'email_password'
    if email_mode:
        print("本机账号与房间：%s" % host_url)
        print("登录后从个人主页选择房间，以 DM 或玩家身份进入。\n")
        return host_url, room_code
    print("本机 DM：%s" % host_url)
    print("本机玩家：%s" % page_url("127.0.0.1", port, PLAYER_ROUTE))
    print("玩家地址（选择朋友能访问的局域网或 Radmin IP）：")
    for url in player_urls:
        print("  %s" % url)
    print()
    return host_url, room_code


def show_public_connection(info, base, reused=False):
    print('公网联机已就绪。')
    if (info.get('authentication') or {}).get('method') == 'email_password':
        print('公网账号房间：%s/account#dashboard' % base)
        print('DM 和玩家登录后，从“我的战役”进入对应房间。')
    else:
        print(('已复用当前公网入口，' if reused else '') + '玩家完整地址：%s/' % base)


def show_existing_connector(port, fixed=None, no_open=False):
    """A non-owner can inspect an existing connection but cannot replace it."""
    info = server_info(port, timeout=3)
    if info:
        host_url, _ = show_connection_info(info, port)
        base = live_tunnel_base(info, timeout=8, expected_base=fixed['base']) if fixed else live_tunnel_base(info)
        if base:
            show_public_connection(info, base, reused=True)
            open_host_console(host_console_url(host_url, base), no_open)
            return 0
    print('公网连接已有维护窗口，或进程状态尚未确认；本次不创建重复连接。')
    print('公网暂未验证可用，请保留原连接窗口；本次启动窗口可以关闭。')
    return 0


def clear_owned_tunnel(ownership, port, base, initial_info):
    """Clear only this generation's invitation on the same server session."""
    if not base or not ownership.is_owner():
        return False
    current = server_info(port)
    if not current or current.get('publicBase') != base:
        return False
    if any(not initial_info.get(key) or current.get(key) != initial_info.get(key)
           for key in ('projectId', 'sessionId')):
        return False
    return publish_tunnel_base(port, '')


def run_ssh_tunnel(port, no_open=False):
    """Keep the legacy SSH transport behind the same workspace lease."""
    from server import ssh_tunnel
    ownership = TunnelOwnership()
    if not ownership.acquire():
        return show_existing_connector(port, no_open=no_open)
    try:
        previous = existing_connector(port)
        if isinstance(previous, int):
            ownership.connector(previous, borrowed=True)
            return show_existing_connector(port, no_open=no_open)
        info = server_info(port, timeout=3)
        if previous == 'unknown':
            return show_existing_connector(port, no_open=no_open)

        class OwnedAPI:
            def __init__(self):
                self.initial = None
                self.server_process = None
            def __getattr__(self, name):
                try: return globals()[name]
                except KeyError: raise AttributeError(name) from None
            def prepare_server(self, requested):
                result = prepare_server(requested)
                self.initial = result[1]
                self.server_process = result[0]
                return result
            def stop_process(self, process):
                if process is not None and process is self.server_process:
                    return stop_process(process, timeout=SERVER_SHUTDOWN_TIMEOUT)
                return stop_process(process)
            def publish_tunnel_base(self, actual_port, base='', timeout=0.75):
                if not ownership.is_owner() or self.initial is None:
                    return False
                current = server_info(actual_port)
                if not current or any(not self.initial.get(key) or current.get(key) != self.initial.get(key)
                                      for key in ('projectId', 'sessionId')):
                    return False
                return publish_tunnel_base(actual_port, base, timeout)
        return ssh_tunnel.run(OwnedAPI(), port, no_open)
    finally:
        ownership.close()


def open_host_console(url, disabled=False):
    if disabled:
        return
    if not webbrowser.open(url, new=1):
        print("浏览器未能自动打开，请手动复制上面的主控台地址。")


def browser_open_disabled(explicit=False):
    """Respect the machine's launcher preference and the --no-open override."""
    if explicit:
        return True
    settings = network_settings().get('launcher')
    if settings is None:
        settings = {}
    if not isinstance(settings, dict):
        raise ValueError('启动器设置必须是 JSON 对象')
    return settings.get('openBrowser') is False


def publish_tunnel_base(port, public_base="", timeout=0.75):
    """把当前 Tunnel 入口写入本机服务器，供所有主控台标签页读取。"""
    try:
        with LOCAL_URL_OPENER.open(
            "http://127.0.0.1:%d/api/workspace-epoch" % port, timeout=timeout,
        ) as response:
            workspace_epoch = json.loads(response.read().decode("utf-8")).get("epoch", "")
    except Exception:
        return False
    payload = json.dumps({"publicBase": str(public_base or "")}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%d/api/local-tunnel" % port,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Sundoll-Local-Save": "1",
            "X-Sundoll-Workspace": str(workspace_epoch),
        },
        method="POST",
    )
    try:
        with LOCAL_URL_OPENER.open(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        return bool(result.get("ok"))
    except Exception:
        return False


def host_console_url(host_url, public_base=""):
    """把 Tunnel 公网入口传给本机主控台，仅用于生成玩家邀请链接。"""
    public_base = str(public_base or "").strip().rstrip("/")
    if not public_base or host_url.split('#', 1)[0].split('?', 1)[0].endswith('/account'):
        return host_url
    separator = "&" if "?" in host_url else "?"
    return host_url + separator + urlencode({"public": public_base})


def live_tunnel_base(info, timeout=1.5, expected_base=None):
    """Reuse an already published tunnel only if it reaches this room."""
    base = str((info or {}).get("publicBase") or "").strip().rstrip("/")
    if expected_base is not None:
        if base != expected_base:
            return ''
    elif not PUBLIC_TUNNEL_RE.fullmatch(base):
        return ""
    try:
        public_identity = (info.get('endpoints') or {}).get('serviceInfo') == '/api/service-info'
        identity_path = '/api/service-info' if public_identity else '/api/info'
        request = urllib.request.Request(base + identity_path, headers={
            'User-Agent': 'SundollLauncher/1.1', 'Accept': 'application/json',
        })
        with urllib.request.urlopen(request, timeout=timeout) as response:
            remote = json.loads(response.read(32 * 1024).decode("utf-8"))
        keys = ("projectId", "sessionId", "protocolVersion") if public_identity else ("projectId", "sessionId", "roomCode", "protocolVersion")
        for key in keys:
            if not info.get(key) or remote.get(key) != info.get(key):
                return ""
        return base
    except (OSError, ValueError, TypeError, UnicodeError):
        return ""


def find_cloudflared():
    found = shutil.which("cloudflared")
    if found:
        return found

    names = ["cloudflared.exe"] if os.name == "nt" else ["cloudflared"]
    candidates = [APP_ROOT / "bin" / name for name in names] + [CHECKOUT_ROOT / name for name in names]
    if sys.platform == "darwin":
        candidates.extend(
            [Path("/opt/homebrew/bin/cloudflared"), Path("/usr/local/bin/cloudflared")]
        )
    if os.name == "nt":
        for env_name in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(env_name)
            if base:
                candidates.extend(
                    [
                        Path(base) / "cloudflared.exe",
                        Path(base) / "Cloudflare" / "cloudflared.exe",
                        Path(base) / "Cloudflare" / "Cloudflared" / "cloudflared.exe",
                    ]
                )
    return next((str(path) for path in candidates if path.is_file()), None)


def cloudflared_install_hint():
    if sys.platform == "darwin":
        return "macOS 可运行：brew install cloudflared"
    if os.name == "nt":
        return "Windows 可运行：winget install --id Cloudflare.cloudflared"
    return "请从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 安装 cloudflared"


def run_local(port, no_open=False, local_only=False):
    bind_host = "127.0.0.1" if local_only else "0.0.0.0"
    server_process, info, actual_port = prepare_server(port, bind_host)
    # Reusing the local service must not erase another window's public entry.
    if server_process is not None:
        publish_tunnel_base(actual_port, "")
    host_url, _room_code = show_connection_info(info, actual_port, local_only)
    open_host_console(host_url, no_open)
    if server_process is None:
        print("服务器由另一个窗口维护，本启动器可以关闭。")
        return 0

    print("服务器运行中。关闭此窗口或按 Ctrl+C 即可停止联机。")
    try:
        exit_code = server_process.wait()
        if exit_code:
            print("服务器已异常退出，退出码：%d" % exit_code)
            return exit_code
        return 0
    except KeyboardInterrupt:
        print("\n正在停止服务器……")
        return 0
    finally:
        stop_process(server_process, timeout=SERVER_SHUTDOWN_TIMEOUT)


def run_tunnel(port, no_open=False, local_only=False, combined=False):
    cloudflared = find_cloudflared()
    if not cloudflared:
        print("未找到 cloudflared，无法启动公网 Tunnel。")
        print(cloudflared_install_hint())
        if combined:
            print("继续启动本机服务。")
            return run_local(port, no_open, local_only)
        print("可直接运行启动器，自动保留本地联机。")
        return 1

    fixed = fixed_tunnel_settings()
    if fixed and not fixed['tokenFile'].is_file():
        raise RuntimeError('尚未保存固定隧道凭据，请先完成 Cloudflare 固定隧道配置。')
    if fixed and port != fixed['port']:
        raise RuntimeError('固定隧道要求本机端口 %d，请同步 Cloudflare 的服务地址后再更换端口。' % fixed['port'])
    ownership = TunnelOwnership()
    if not ownership.acquire():
        return show_existing_connector(port, fixed, no_open)
    server_process = None
    tunnel_process = None
    actual_port = None
    reused_tunnel = False
    owned_base = ''
    try:
        bind_host = "127.0.0.1" if local_only else "0.0.0.0"
        server_process, info, actual_port = prepare_server(port, bind_host)
        if fixed and actual_port != fixed['port']:
            raise RuntimeError('固定隧道指向端口 %d，当前服务使用 %d；请先解决端口占用。' % (fixed['port'], actual_port))
        host_url, room_code = show_connection_info(info, actual_port, local_only)
        existing_base = (live_tunnel_base(info, timeout=8, expected_base=fixed['base'])
                         if fixed else live_tunnel_base(info))
        if existing_base:
            reused_tunnel = True
            show_public_connection(info, existing_base, reused=True)
            open_host_console(host_console_url(host_url, existing_base), no_open)
            return wait_local_server(server_process) if server_process is not None else 0
        previous_connector = existing_connector(actual_port, fixed)
        if isinstance(previous_connector, int):
            ownership.connector(previous_connector, borrowed=True)
            print('已有公网连接进程仍在运行，公网暂未验证可用；本次不创建重复连接。')
            return wait_local_server(server_process) if server_process is not None else 0
        if previous_connector == 'unknown':
            print('无法确认公网连接进程状态；本次不创建重复连接，保留本机入口。')
            return wait_local_server(server_process) if server_process is not None else 0
        ownership.write(dict(ownership.record, port=actual_port, provider='cloudflare',
                             projectId=info.get('projectId'), sessionId=info.get('sessionId')))
        if combined or (fixed and info.get('publicBase') == fixed['base']):
            clear_owned_tunnel(ownership, actual_port, info.get('publicBase'), info)
        if combined:
            open_host_console(host_url, no_open)
            print("本地联机已就绪，正在同时准备公网入口。")
        if fixed:
            print('正在连接 Cloudflare 固定域名：%s' % fixed['base'])
            command = [cloudflared, 'tunnel', '--no-autoupdate', 'run',
                       '--token-file', str(fixed['tokenFile'])]
        else:
            print("正在启动 Cloudflare Quick Tunnel：%s" % cloudflared)
            command = [cloudflared, 'tunnel', '--url', 'http://127.0.0.1:%d' % actual_port]
        print("等待隧道连接成功后，再将“玩家完整地址”发给朋友。\n")
        tunnel_process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            errors="replace",
            bufsize=1,
        )
        ownership.connector(tunnel_process.pid)
        announced = False
        public_base = fixed['base'] if fixed else ''
        connected = False
        host_opened = False
        last_check = -float('inf')
        started_at = time.monotonic()
        pending_notice_shown = False
        lines = tunnel_output(tunnel_process) if fixed else tunnel_process.stdout
        for line in lines:
            print(line, end="")
            now = time.monotonic()
            if not announced and not pending_notice_shown and (
                'hard_fail=true' in line or now - started_at >= 30
            ):
                print('\n公网尚未就绪，正在重试连接；本机入口仍可使用。')
                print('请使用上方本机地址；域名入口需等到“公网联机已就绪”后再使用。\n')
                pending_notice_shown = True
            match = TUNNEL_URL_RE.search(line) if not fixed else None
            if match:
                public_base = match.group(0)
            if "Registered tunnel connection" in line:
                connected = True
            if public_base and connected and not announced:
                if not ownership.is_owner():
                    raise RuntimeError('公网连接所有权已变化，请保留原连接窗口。')
                if fixed:
                    if now - last_check < 5:
                        continue
                    last_check = now
                    current = server_info(actual_port, timeout=3)
                    candidate = dict(current or {}, publicBase=public_base)
                    if not current or live_tunnel_base(candidate, timeout=8, expected_base=public_base) != public_base:
                        print('隧道已连接，正在等待固定域名能访问当前房间……')
                        continue
                    if not publish_tunnel_base(actual_port, public_base):
                        print('固定域名已可访问，正在同步主控台邀请链接……')
                        continue
                if not fixed:
                    publish_tunnel_base(actual_port, public_base)
                owned_base = public_base
                print()
                show_public_connection(info, public_base)
                if not combined:
                    open_host_console(host_console_url(host_url, public_base), no_open)
                host_opened = True
                announced = True
        exit_code = tunnel_process.wait()
        if exit_code:
            print("Tunnel 已异常退出，退出码：%d" % exit_code)
        elif not announced:
            print("Tunnel 已退出，但尚未建立可用的公网连接。")
        if combined:
            clear_owned_tunnel(ownership, actual_port, owned_base, info)
            print("公网入口已停止，本地联机继续运行。")
            return wait_local_server(server_process)
        if not host_opened:
            open_host_console(host_url, no_open)
        return exit_code
    except OSError as error:
        if not combined or actual_port is None:
            raise
        print("公网入口未能启动：%s。本地联机继续运行。" % error)
        return wait_local_server(server_process)
    except KeyboardInterrupt:
        if server_process is None:
            print("\n正在停止本窗口的公网连接；已有本机服务继续运行。")
        else:
            print("\n正在停止本窗口的公网连接和本机服务……")
        return 0
    finally:
        try:
            if actual_port is not None and not reused_tunnel:
                clear_owned_tunnel(ownership, actual_port, owned_base, info)
            stop_process(tunnel_process)
            stop_process(server_process, timeout=SERVER_SHUTDOWN_TIMEOUT)
        finally:
            ownership.close()


def wait_local_server(server_process):
    """公网失败时继续维护已启动的本地服务，不重复启动服务。"""
    if server_process is None:
        print("本地服务器由另一个窗口维护，可继续使用。")
        return 0
    print("本地服务器运行中，按 Ctrl+C 停止。")
    try:
        return server_process.wait()
    except KeyboardInterrupt:
        return 0



def diagnostics(port):
    print("桑哆尔之歌启动环境检查")
    print("  系统：%s" % sys.platform)
    print("  Python：%s" % sys.executable)
    print("  版本：%s" % sys.version.split()[0])
    print("  服务器入口：%s" % ("正常" if SERVER_ENTRY.is_file() else "缺失"))
    probed = raw_server_info(port)
    if compatible_server_info(probed):
        port_status = "桑哆尔之歌服务器已运行"
    elif probed:
        port_status = incompatible_server_message(port, probed)
    elif port_is_open(port):
        port_status = "被其他程序占用"
    else:
        port_status = "可用"
    print("  端口 %d：%s" % (port, port_status))
    print("  cloudflared：%s" % (find_cloudflared() or "未安装（仅 Tunnel 模式需要）"))
    return 0 if SERVER_ENTRY.is_file() else 1


def parse_args():
    parser = argparse.ArgumentParser(description="一键启动本地联机和免费公网入口")
    parser.add_argument("mode", nargs="?", choices=("auto", "local", "tunnel"), default="auto", help="默认同时启用本地和公网；local 仅本地，tunnel 为兼容旧命令")
    parser.add_argument("--port", type=int, default=default_port())
    parser.add_argument("--no-open", action="store_true", help="不自动打开主控台")
    parser.add_argument("--tunnel-provider", choices=('cloudflare', 'localhost-run'), help="选择免费公网通道；默认读取运行数据/联机设置.json")
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="只监听 127.0.0.1（用于本机诊断，其他设备无法连接）",
    )
    parser.add_argument("--check", action="store_true", help="只检查启动环境")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间")
    return args


def main():
    args = parse_args()
    if args.check:
        return diagnostics(args.port)
    no_open = browser_open_disabled(args.no_open)
    if no_open:
        print('启动器仅运行服务，不自动打开网页。')
    mode = args.mode
    if mode != 'local' and not args.local_only and (args.tunnel_provider or tunnel_provider()) == 'localhost-run':
        return run_ssh_tunnel(args.port, no_open)
    if mode == "auto":
        if args.local_only:
            return run_local(args.port, no_open, True)
        return run_tunnel(args.port, no_open, False, combined=True)
    if mode == "tunnel":
        return run_tunnel(args.port, no_open, args.local_only)
    return run_local(args.port, no_open, args.local_only)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as error:
        print("\n[启动失败] %s" % error)
        raise SystemExit(1)
