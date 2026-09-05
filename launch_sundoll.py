#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桑多尔之歌的跨平台联机启动器。

macOS 和 Windows 的双击脚本只负责找到 Python；服务器检查、端口选择、
浏览器打开和可选 Cloudflare Quick Tunnel 都集中在这里，避免两套脚本漂移。
"""

import argparse
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


ROOT = Path(__file__).resolve().parent
SERVER_ENTRY = ROOT / "start_server.py"
DEFAULT_PORT = 8090
SERVER_PROTOCOL_VERSION = 7
SERVER_NAME = "桑多尔之歌联机"
COMPATIBLE_SERVER_NAMES = {SERVER_NAME, "桑哆尔联机"}
HOST_ROUTE = "/主控台/主控台.html"
PLAYER_ROUTE = "/主控台/玩家.html"
TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)


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
    """读取端口上的桑多尔之歌服务信息，不在这里判断版本是否兼容。"""
    try:
        with urllib.request.urlopen(
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
        return int(payload.get("protocolVersion", 0)) == SERVER_PROTOCOL_VERSION
    except (TypeError, ValueError):
        return False


def server_info(port, timeout=0.45):
    """只把协议一致的桑多尔之歌服务认作可复用服务。"""
    payload = raw_server_info(port, timeout)
    return payload if compatible_server_info(payload) else None


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
        print("端口 %d 运行的是旧版桑多尔之歌服务器，不再复用。" % requested)
    if not port_is_open(requested):
        return requested, None

    print("端口 %d 已被其他程序占用，正在寻找可用端口……" % requested)
    for port in range(requested + 1, min(requested + 20, 65536)):
        info = server_info(port)
        if info:
            print("发现已运行的桑多尔之歌服务器：端口 %d。" % port)
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
        print("桑多尔之歌服务器已经在端口 %d 运行，将直接复用。" % port)
        return None, info, port

    if not SERVER_ENTRY.is_file():
        raise RuntimeError("找不到服务器入口：%s" % SERVER_ENTRY)

    print("正在启动桑多尔之歌联机服务器（端口 %d）……" % port)
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


def find_cloudflared():
    found = shutil.which("cloudflared")
    if found:
        return found

    names = ["cloudflared.exe"] if os.name == "nt" else ["cloudflared"]
    candidates = [ROOT / name for name in names]
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


def run_tunnel(port, no_open=False, local_only=False):
    cloudflared = find_cloudflared()
    if not cloudflared:
        print("未找到 cloudflared，无法启动公网 Tunnel。")
        print(cloudflared_install_hint())
        print("同一 Wi-Fi 或 Radmin 联机不需要 cloudflared，请选择本地模式。")
        return 1

    server_process = None
    tunnel_process = None
    try:
        bind_host = "127.0.0.1" if local_only else "0.0.0.0"
        server_process, info, actual_port = prepare_server(port, bind_host)
        host_url, room_code = show_connection_info(info, actual_port, local_only)
        open_host_console(host_url, no_open)
        print("正在启动 Cloudflare Quick Tunnel：%s" % cloudflared)
        print("看到“玩家完整地址”后，将该地址发给朋友。\n")
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
        for line in tunnel_process.stdout:
            print(line, end="")
            match = TUNNEL_URL_RE.search(line)
            if match and not announced:
                public_url = match.group(0) + quote(PLAYER_ROUTE, safe="/")
                if room_code:
                    public_url += "?" + urlencode({"room": room_code})
                print("\n玩家完整地址：%s\n" % public_url)
                announced = True
        exit_code = tunnel_process.wait()
        if exit_code:
            print("Tunnel 已异常退出，退出码：%d" % exit_code)
        elif not announced:
            print("Tunnel 已退出，但没有取得 trycloudflare.com 地址。")
        return exit_code
    except KeyboardInterrupt:
        print("\n正在停止 Tunnel 和本机服务器……")
        return 0
    finally:
        stop_process(tunnel_process)
        stop_process(server_process)


def choose_mode():
    if not sys.stdin.isatty():
        return "local"
    print("=" * 58)
    print("桑多尔之歌联机启动器")
    print("  1. 本地 / 同一 Wi-Fi / Radmin（推荐）")
    print("  2. Cloudflare 公网 Tunnel")
    print("  Q. 退出")
    print("=" * 58)
    while True:
        try:
            choice = input("请选择 [1]：").strip().lower()
        except EOFError:
            return "local"
        if choice in ("", "1", "local", "l"):
            return "local"
        if choice in ("2", "tunnel", "t"):
            return "tunnel"
        if choice in ("q", "quit", "exit"):
            return None
        print("请输入 1、2 或 Q。")


def diagnostics(port):
    print("桑多尔之歌启动环境检查")
    print("  系统：%s" % sys.platform)
    print("  Python：%s" % sys.executable)
    print("  版本：%s" % sys.version.split()[0])
    print("  服务器入口：%s" % ("正常" if SERVER_ENTRY.is_file() else "缺失"))
    probed = raw_server_info(port)
    if compatible_server_info(probed):
        port_status = "桑多尔之歌服务器已运行"
    elif probed:
        port_status = "旧版桑多尔之歌服务器正在运行（将自动避开）"
    elif port_is_open(port):
        port_status = "被其他程序占用"
    else:
        port_status = "可用"
    print("  端口 %d：%s" % (port, port_status))
    print("  cloudflared：%s" % (find_cloudflared() or "未安装（仅 Tunnel 模式需要）"))
    return 0 if SERVER_ENTRY.is_file() else 1


def parse_args():
    parser = argparse.ArgumentParser(description="启动桑多尔之歌本地联机或 Cloudflare Tunnel")
    parser.add_argument("mode", nargs="?", choices=("local", "tunnel"))
    parser.add_argument("--port", type=int, default=default_port())
    parser.add_argument("--no-open", action="store_true", help="不自动打开主控台")
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
    mode = args.mode or choose_mode()
    if mode is None:
        return 0
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
