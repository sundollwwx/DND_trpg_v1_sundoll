@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "SANGDUOER_PORT=8090"
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 cloudflared。
  echo 请先在主机电脑安装 Cloudflare Tunnel 客户端，朋友不需要安装。
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:%SANGDUOER_PORT%/api/health ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  echo 正在启动本机服务器（端口 %SANGDUOER_PORT%）…
  where py >nul 2>nul
  if not errorlevel 1 (
    start "Sangduoer Server" /min py -3 "start_server.py" --port %SANGDUOER_PORT%
  ) else (
    start "Sangduoer Server" /min python "start_server.py" --port %SANGDUOER_PORT%
  )
)

for /l %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:%SANGDUOER_PORT%/api/health ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto tunnel_ready
  timeout /t 1 /nobreak >nul
)
echo [ERROR] 本机服务器未能启动，请先运行“启动桑哆尔.bat”检查端口。
pause
exit /b 1

:tunnel_ready
echo Tunnel 已启动。等待下面出现 https:// 开头的玩家地址，再把它和房间码发给朋友。
echo 玩家入口：/主控台/玩家.html?room=房间码
cloudflared tunnel --url http://127.0.0.1:%SANGDUOER_PORT%
pause
