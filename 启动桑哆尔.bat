@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Sangduoer Windows launcher
rem Prefer the Windows Python Launcher, then fall back to python on PATH.
where py >nul 2>nul
if %errorlevel%==0 goto use_py

where python >nul 2>nul
if %errorlevel%==0 goto use_python

echo [ERROR] Python 3 was not found.
echo Install Python 3 and enable "Add Python to PATH", then run this file again.
pause
exit /b 1

:use_py
start "Sangduoer Server" /min py -3 "start_server.py"
goto server_started

:use_python
start "Sangduoer Server" /min python "start_server.py"

:server_started
rem Wait until the local server is healthy before opening the host console.
for /l %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8090/api/health | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto server_ready
  timeout /t 1 /nobreak >nul
)
echo [ERROR] Server did not become ready on port 8090.
pause
exit /b 1

:server_ready
start "" "http://127.0.0.1:8090/主控台/主控台.html"
exit /b 0
