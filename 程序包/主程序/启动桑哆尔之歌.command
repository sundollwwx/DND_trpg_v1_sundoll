#!/bin/bash
# 桑哆尔之歌 · macOS 统一启动入口
cd "$(dirname "$0")" || exit 1

SUNDOLL_ENGINE="launch_entry.py"
if [ ! -f "$SUNDOLL_ENGINE" ]; then
  SUNDOLL_ENGINE="程序包/主程序/launch_entry.py"
fi
if [ ! -f "$SUNDOLL_ENGINE" ]; then
  for CANDIDATE in 程序包/*; do
    if [ -f "$CANDIDATE/模块.json" ] && [ -f "$CANDIDATE/launch_entry.py" ]; then
      SUNDOLL_ENGINE="$CANDIDATE/launch_entry.py"
      break
    fi
  done
fi
if [ ! -f "$SUNDOLL_ENGINE" ]; then
  echo "[启动失败] 找不到主程序。请完整解压，并保留启动器与程序包的相对位置。"
  if [ -t 0 ]; then read -r -p "按回车退出……" _; fi
  exit 1
fi

PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
if [ -z "${PYTHON_BIN}" ]; then
  for CANDIDATE in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [ -x "${CANDIDATE}" ]; then
      PYTHON_BIN="${CANDIDATE}"
      break
    fi
  done
fi
if [ -z "${PYTHON_BIN}" ]; then
  echo "[启动失败] 未找到 Python 3。请先安装 Python 3.9 或更高版本。"
  if [ -t 0 ]; then read -r -p "按回车退出……" _; fi
  exit 1
fi
if ! "${PYTHON_BIN}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "[启动失败] 需要 Python 3.9 或更高版本。"
  if [ -t 0 ]; then read -r -p "按回车退出……" _; fi
  exit 1
fi

"${PYTHON_BIN}" -u "$SUNDOLL_ENGINE" "$@"
STATUS=$?
if [ "${STATUS}" -ne 0 ] && [ -t 0 ]; then
  echo
  read -r -p "启动未完成，按回车关闭窗口……" _
fi
exit "${STATUS}"
