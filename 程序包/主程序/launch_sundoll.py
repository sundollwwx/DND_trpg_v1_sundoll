#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桑哆尔之歌的跨平台联机启动器。

macOS 和 Windows 的双击脚本只负责找到 Python；服务器检查、端口选择、
浏览器打开和可选 Cloudflare Quick Tunnel 都集中在这里，避免两套脚本漂移。
"""

import argparse
from server.runtime_config import protocol_version
from server.paths import APP_ROOT, CHECKOUT_ROOT, USER_DATA_ROOT
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import quote, urlencode


ROOT = APP_ROOT
SERVER_PROJECT_ID = hashlib.sha256(os.path.normcase(os.path.realpath(str(ROOT))).encode("utf-8")).hexdigest()
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


def tunnel_provider():
    try:
        value = json.loads(NETWORK_SETTINGS.read_text('utf-8')).get('tunnelProvider', 'cloudflare')
    except FileNotFoundError:
        value = 'cloudflare'
    if value not in ('cloudflare', 'localhost-run'):
        raise ValueError('联机设置中的公网通道无效')
    return value


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


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
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
        stop_process(process)
        detail = "进程退出码 %s" % exit_code if exit_code is not None else "等待 12 秒仍未就绪"
        raise RuntimeError("服务器启动失败（%s）。请查看上方报错。" % detail)
    return process, info, port


def connection_urls(info, port, local_only=False):
    room_code = str(info.get("roomCode") or "")
    candidates = []
    for ip in (() if local_only else (info.get("ips") or [])):
        ip = str(ip).strip()
        if ip and ip not in ("127.0.0.1", "localhost") and ip not in candidates:
            candidates.append(ip)
    if not candidates:
        candidates.append("127.0.0.1")
    host_url = page_url("127.0.0.1", port, HOST_ROUTE)
    player_urls = [page_url(ip, port, PLAYER_ROUTE, room_code) for ip in candidates]
    return host_url, player_urls, room_code


def show_connection_info(info, port, local_only=False):
    host_url, player_urls, room_code = connection_urls(info, port, local_only)
    print("\n服务器已就绪。")
    print("主控台：%s" % host_url)
    print("玩家地址（选择朋友能访问的局域网或 Radmin IP）：")
    for url in player_urls:
        print("  %s" % url)
    if room_code:
        print("房间码：%s" % room_code)
    print()
    return host_url, room_code


def open_host_console(url, disabled=False):
    if disabled:
        return
    if not webbrowser.open(url, new=1):
        print("浏览器未能自动打开，请手动复制上面的主控台地址。")


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
    if not public_base:
        return host_url
    separator = "&" if "?" in host_url else "?"
    return host_url + separator + urlencode({"public": public_base})


def live_tunnel_base(info, timeout=1.5):
    """Reuse an already published tunnel only if it reaches this room."""
    base = str((info or {}).get("publicBase") or "").strip().rstrip("/")
    if not PUBLIC_TUNNEL_RE.fullmatch(base):
        return ""
    try:
        with urllib.request.urlopen(base + "/api/info", timeout=timeout) as response:
            remote = json.loads(response.read(32 * 1024).decode("utf-8"))
        for key in ("projectId", "sessionId", "roomCode", "protocolVersion"):
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
        stop_process(server_process)


def run_tunnel(port, no_open=False, local_only=False, combined=False):
    cloudflared = find_cloudflared()
    if not cloudflared:
        print("未找到 cloudflared，无法启动公网 Tunnel。")
        print(cloudflared_install_hint())
        if combined:
            print("继续启动本地 / 同一 Wi-Fi / Radmin 联机。")
            return run_local(port, no_open, local_only)
        print("可直接运行启动器，自动保留本地联机。")
        return 1

    server_process = None
    tunnel_process = None
    actual_port = None
    reused_tunnel = False
    try:
        bind_host = "127.0.0.1" if local_only else "0.0.0.0"
        server_process, info, actual_port = prepare_server(port, bind_host)
        host_url, room_code = show_connection_info(info, actual_port, local_only)
        existing_base = live_tunnel_base(info)
        if existing_base:
            reused_tunnel = True
            public_url = existing_base + quote(PLAYER_ROUTE, safe="/")
            if room_code:
                public_url += "?" + urlencode({"room": room_code})
            print("已复用当前公网入口，玩家完整地址：%s" % public_url)
            open_host_console(host_console_url(host_url, existing_base), no_open)
            return wait_local_server(server_process) if server_process is not None else 0
        if combined:
            publish_tunnel_base(actual_port, "")
            open_host_console(host_url, no_open)
            print("本地联机已就绪，正在同时准备公网入口。")
        print("正在启动 Cloudflare Quick Tunnel：%s" % cloudflared)
        print("等待隧道连接成功后，再将“玩家完整地址”发给朋友。\n")
        tunnel_process = subprocess.Popen(
            [cloudflared, "tunnel", "--url", "http://127.0.0.1:%d" % actual_port],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            errors="replace",
            bufsize=1,
        )
        announced = False
        public_base = ""
        connected = False
        host_opened = False
        for line in tunnel_process.stdout:
            print(line, end="")
            match = TUNNEL_URL_RE.search(line)
            if match:
                public_base = match.group(0)
            if "Registered tunnel connection" in line:
                connected = True
            if public_base and connected and not announced:
                public_url = public_base + quote(PLAYER_ROUTE, safe="/")
                if room_code:
                    public_url += "?" + urlencode({"room": room_code})
                print("\n玩家完整地址：%s\n" % public_url)
                publish_tunnel_base(actual_port, public_base)
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
            publish_tunnel_base(actual_port, "")
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
        print("\n正在停止 Tunnel 和本机服务器……")
        return 0
    finally:
        if actual_port is not None and not reused_tunnel:
            publish_tunnel_base(actual_port, "")
        stop_process(tunnel_process)
        stop_process(server_process)


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
    mode = args.mode
    if mode != 'local' and not args.local_only and (args.tunnel_provider or tunnel_provider()) == 'localhost-run':
        from server.ssh_tunnel import run
        return run(sys.modules[__name__], args.port, args.no_open)
    if mode == "auto":
        if args.local_only:
            return run_local(args.port, args.no_open, True)
        return run_tunnel(args.port, args.no_open, False, combined=True)
    if mode == "tunnel":
        return run_tunnel(args.port, args.no_open, args.local_only)
    return run_local(args.port, args.no_open, args.local_only)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as error:
        print("\n[启动失败] %s" % error)
        raise SystemExit(1)
