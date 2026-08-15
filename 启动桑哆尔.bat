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
rem Wait until the local server has had time to bind port 8090.
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8090/%%E4%%B8%%BB%%E6%%8E%%A7%%E5%%8F%%B0/%%E4%%B8%%BB%%E6%%8E%%A7%%E5%%8F%%B0.html"
exit /b 0
