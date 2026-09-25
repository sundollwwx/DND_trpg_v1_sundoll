#!/bin/bash
# 桑哆尔之歌 · macOS 双击启动入口
cd "$(dirname "$0")" || exit 1

if [ ! -f "launch_sundoll.py" ]; then
  echo "[启动失败] 找不到“程序包”。请将启动器与程序包放在同一文件夹。"
  read -r -p "按回车退出……" _
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
  echo "[启动失败] 未找到 Python 3。"
  echo "请先安装 Python 3，然后重新双击本文件。"
  read -r -p "按回车退出……" _
  exit 1
fi

if ! "${PYTHON_BIN}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "[启动失败] 需要 Python 3.9 或更高版本。"
  read -r -p "按回车退出……" _
  exit 1
fi

"${PYTHON_BIN}" "launch_sundoll.py" "$@"
STATUS=$?
if [ "${STATUS}" -ne 0 ]; then
  echo
  read -r -p "启动未完成，按回车关闭窗口……" _
fi
exit "${STATUS}"
