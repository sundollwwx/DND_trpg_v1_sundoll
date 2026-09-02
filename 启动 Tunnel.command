#!/bin/bash
# 桑哆尔 · 可选外网 HTTPS Tunnel（macOS）
# 朋友只需浏览器；cloudflared 只安装在运行主控台的这台电脑上。
set -u
cd "$(dirname "$0")"

TUNNEL_PORT="${1:-8090}"
SERVER_PID=""

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "未找到 cloudflared。请先安装 Cloudflare Tunnel 客户端，或继续使用同一 Wi-Fi 的「启动桑哆尔.command」。"
  echo "安装完成后重新双击本文件。"
  read -r -p "按回车退出…" _
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:${TUNNEL_PORT}/api/health" >/dev/null 2>&1; then
  echo "正在启动本机服务器（端口 ${TUNNEL_PORT}）…"
  python3 start_server.py --port "${TUNNEL_PORT}" &
  SERVER_PID=$!
  for _ in {1..30}; do
    if curl -fsS "http://127.0.0.1:${TUNNEL_PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -fsS "http://127.0.0.1:${TUNNEL_PORT}/api/health" >/dev/null 2>&1; then
  echo "本机服务器未能启动，请先运行「启动桑哆尔.command」检查端口。"
  if [ -n "${SERVER_PID}" ]; then kill "${SERVER_PID}" 2>/dev/null || true; fi
  read -r -p "按回车退出…" _
  exit 1
fi

echo "Tunnel 已启动。等待下面出现 https:// 开头的玩家地址，再把它和房间码发给朋友。"
echo "玩家入口：/主控台/玩家.html?room=房间码"
cloudflared tunnel --url "http://127.0.0.1:${TUNNEL_PORT}"
