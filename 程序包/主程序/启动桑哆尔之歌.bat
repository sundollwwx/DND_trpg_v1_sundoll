@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" >nul 2>nul
if errorlevel 1 goto bad_project_dir
if not exist "launch_sundoll.py" goto missing_package

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

py -3 -c "import sys; print('SUNDOLL_PY_OK' if sys.version_info >= (3, 9) else '')" 2>nul | findstr /x /c:"SUNDOLL_PY_OK" >nul
if not errorlevel 1 goto use_py

python -c "import sys; print('SUNDOLL_PY_OK' if sys.version_info >= (3, 9) else '')" 2>nul | findstr /x /c:"SUNDOLL_PY_OK" >nul
if not errorlevel 1 goto use_python

python3 -c "import sys; print('SUNDOLL_PY_OK' if sys.version_info >= (3, 9) else '')" 2>nul | findstr /x /c:"SUNDOLL_PY_OK" >nul
if not errorlevel 1 goto use_python3

echo [启动失败] 未找到可用的 Python 3.9 或更高版本。
echo 请从 https://www.python.org/downloads/windows/ 安装 Python 3，
echo 安装时勾选 "Add Python to PATH"，然后重新双击本文件。
set "EXIT_CODE=1"
goto finish

:use_py
py -3 "launch_sundoll.py" %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:use_python
python "launch_sundoll.py" %*
set "EXIT_CODE=%ERRORLEVEL%"
goto finish

:use_python3
python3 "launch_sundoll.py" %*
set "EXIT_CODE=%ERRORLEVEL%"

:finish
popd
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [启动未完成] 请根据上方提示处理后重试。
  pause
)
endlocal & exit /b %EXIT_CODE%

:bad_project_dir
echo [启动失败] 无法进入项目目录：
echo "%~dp0"
echo 请确认项目文件夹仍完整，并避免从压缩包内部直接运行。
pause
endlocal & exit /b 1

:missing_package
echo [启动失败] 找不到“程序包”，请将启动器与程序包放在同一文件夹。
set "EXIT_CODE=1"
goto finish
