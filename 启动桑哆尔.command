#!/bin/bash
# 桑哆尔 · macOS 双击启动入口
cd "$(dirname "$0")" || exit 1

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

"${PYTHON_BIN}" "launch_sundoll.py" "$@"
STATUS=$?
if [ "${STATUS}" -ne 0 ]; then
  echo
  read -r -p "启动未完成，按回车关闭窗口……" _
fi
exit "${STATUS}"
