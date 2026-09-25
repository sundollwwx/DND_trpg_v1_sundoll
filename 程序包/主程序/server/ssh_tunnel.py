"""Free localhost.run transport; application data remains in the local service."""
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import threading
import time
from urllib.parse import quote, urlencode

DOMAIN = re.compile(r'[a-z0-9-]+\.(?:lhr\.life|localhost\.run)', re.I)


def opened_address(line):
    try:
        event = json.loads(line)
    except (ValueError, TypeError):
        return ''
    if not isinstance(event, dict):
        return ''
    host = event.get('address', '')
    if (event.get('event') == 'tcpip-forward' and event.get('status') == 'success'
            and event.get('type') == 'opened' and event.get('tls_termination') is True
            and isinstance(host, str) and DOMAIN.fullmatch(host)):
        return 'https://' + host
    return ''


def command(ssh, port, known_hosts):
    # Anonymous service: never offer the user's personal keys or SSH agent.
    return [ssh, '-F', os.devnull, '-T', '-o', 'ConnectTimeout=12',
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'IdentityFile=none', '-o', 'IdentityAgent=none',
            '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + str(known_hosts),
            '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
            '-o', 'ExitOnForwardFailure=yes', '-R', '80:127.0.0.1:%d' % port,
            'nokey@localhost.run', '--', '--output', 'json', '--inject-http-proxy-headers']


def events(process):
    """Do not block forever on a quiet SSH connection; allow health checks."""
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
            line = messages.get(timeout=15)
        except queue.Empty:
            yield ''
            continue
        if line is None:
            return
        yield line


def verify_and_publish(launcher, port, base):
    info = launcher.server_info(port, timeout=3)
    if not info or launcher.live_tunnel_base(dict(info, publicBase=base), timeout=8) != base:
        return False
    return launcher.publish_tunnel_base(port, base, timeout=3)


def clear_owned(launcher, port, base):
    if not base:
        return
    info = launcher.server_info(port, timeout=3)
    if info and info.get('publicBase') == base:
        launcher.publish_tunnel_base(port, '', timeout=3)


def run(launcher, port, no_open=False):
    ssh = shutil.which('ssh')
    if not ssh:
        print('未找到 OpenSSH；请安装系统 OpenSSH 客户端。继续使用本地联机。')
        return launcher.run_local(port, no_open)
    server = process = None
    actual_port = None
    owned_base = ''
    try:
        server, info, actual_port = launcher.prepare_server(port)
        host_url, _ = launcher.show_connection_info(info, actual_port)
        existing = launcher.live_tunnel_base(info, timeout=8)
        if existing:
            print('已复用当前可用公网入口：' + existing)
            launcher.open_host_console(launcher.host_console_url(host_url, existing), no_open)
            return launcher.wait_local_server(server) if server else 0
        launcher.publish_tunnel_base(actual_port, '', timeout=3)
        launcher.open_host_console(host_url, no_open)
        folder = Path(launcher.USER_DATA_ROOT) / '联机'
        folder.mkdir(parents=True, exist_ok=True)
        print('正在连接 localhost.run 免费通道；免费版限速，地址可能变化。')
        print('连接窗口需要保持运行，按 Ctrl+C 停止。')
        failures = 0
        while failures < 5:
            process = subprocess.Popen(command(ssh, actual_port, folder / 'known_hosts'),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                universal_newlines=True, errors='replace', bufsize=1)
            candidate = ''
            started = time.monotonic()
            checked = 0
            unhealthy = 0
            for line in events(process):
                address = opened_address(line)
                if address:
                    candidate = address
                now = time.monotonic()
                if candidate and (address or now - checked >= 30):
                    checked = now
                    if verify_and_publish(launcher, actual_port, candidate):
                        if owned_base != candidate:
                            owned_base = candidate
                            current = launcher.server_info(actual_port) or {}
                            print('公网已验证，主控台邀请链接已更新。', flush=True)
                            room = current.get('roomCode', '')
                            url = candidate + quote(launcher.PLAYER_ROUTE, safe='/')
                            if room: url += '?' + urlencode({'room': room})
                            print('玩家完整地址：' + url, flush=True)
                        failures = 0
                        unhealthy = 0
                    else:
                        unhealthy += 1
                        if unhealthy >= 3:
                            print('公网检查连续失败，正在重新连接。', flush=True)
                            break
                if not owned_base and now - started >= 60:
                    print('公网连接未就绪，正在重试。', flush=True)
                    break
            clear_owned(launcher, actual_port, owned_base)
            owned_base = ''
            launcher.stop_process(process)
            if process.stdout:
                process.stdout.close()
            process = None
            failures += 1
            if failures < 5:
                time.sleep(min(10, failures * 2))
        print('免费公网通道暂时无法连接，本地联机保留；稍后重新启动即可重试。')
        return launcher.wait_local_server(server)
    except KeyboardInterrupt:
        print('\n正在停止当前公网通道。')
        return 0
    finally:
        if actual_port is not None:
            clear_owned(launcher, actual_port, owned_base)
        launcher.stop_process(process)
        launcher.stop_process(server)
