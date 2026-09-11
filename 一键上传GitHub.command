#!/bin/bash
# 桑哆尔之歌 · macOS 一键上传 GitHub
cd "$(dirname "$0")" || exit 1

python_is_compatible() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)' >/dev/null 2>&1
}

PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
if [ -n "${PYTHON_BIN}" ] && ! python_is_compatible "${PYTHON_BIN}"; then
  PYTHON_BIN=""
fi
if [ -z "${PYTHON_BIN}" ]; then
  for CANDIDATE in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [ -x "${CANDIDATE}" ] && python_is_compatible "${CANDIDATE}"; then
      PYTHON_BIN="${CANDIDATE}"
      break
    fi
  done
fi

if [ -z "${PYTHON_BIN}" ]; then
  echo "[上传失败] 未找到 Python 3.7 或更高版本。"
  echo "请先安装可用的 Python 3，然后重新双击本文件。"
  UPLOAD_STATUS=1
else
  "${PYTHON_BIN}" "github_sync.py" upload "$@"
  UPLOAD_STATUS=$?
fi

echo
read -r -p "按回车关闭窗口……" _
exit "${UPLOAD_STATUS}"
