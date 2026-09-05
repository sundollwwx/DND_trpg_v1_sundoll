#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v python3 >/dev/null 2>&1; then
  python3 upload_github.py
  UPLOAD_STATUS=$?
else
  echo "未找到 Python 3，请安装后重新双击。"
  UPLOAD_STATUS=1
fi
echo
read -r -p "按回车关闭窗口……" _
exit "$UPLOAD_STATUS"
