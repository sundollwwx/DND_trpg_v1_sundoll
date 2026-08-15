#!/bin/bash
# 桑哆尔 · 一键启动（macOS 双击本文件）
cd "$(dirname "$0")"
# 先开浏览器，再启动服务器
( sleep 1; open "http://localhost:8090/主控台/主控台.html" ) &
python3 主控台/联机服务器.py
