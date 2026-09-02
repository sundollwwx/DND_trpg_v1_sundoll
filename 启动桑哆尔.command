#!/bin/bash
# 桑哆尔 · 一键启动（macOS 双击本文件）
cd "$(dirname "$0")"
echo "正在启动桑哆尔联机服务器…"
python3 start_server.py &
SERVER_PID=$!
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:8090/api/health" >/dev/null 2>&1; then
    open "http://localhost:8090/主控台/主控台.html"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.2
done
echo "服务器未能在 6 秒内启动，请检查 Python 3 和端口 8090。"
wait "$SERVER_PID"
