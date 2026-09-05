@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 goto use_py
where python >nul 2>nul
if not errorlevel 1 goto use_python
echo 未找到 Python 3，请安装并勾选 Add Python to PATH 后重试。
set "UPLOAD_STATUS=1"
goto finish
:use_py
py -3 "upload_github.py"
set "UPLOAD_STATUS=%ERRORLEVEL%"
goto finish
:use_python
python "upload_github.py"
set "UPLOAD_STATUS=%ERRORLEVEL%"
:finish
echo.
pause
exit /b %UPLOAD_STATUS%
