@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto use_py

where python >nul 2>nul
if not errorlevel 1 goto use_python

echo [启动失败] 未找到 Python 3。
echo 请安装 Python 3，并勾选“Add Python to PATH”，然后重新双击本文件。
pause
exit /b 1

:use_py
py -3 "launch_sundoll.py" %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:use_python
python "launch_sundoll.py" %*
set "EXIT_CODE=%ERRORLEVEL%"

:finish
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
