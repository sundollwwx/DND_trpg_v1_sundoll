"""Resolve packaged application, data, and maintenance paths for tests."""
from pathlib import Path
import sys

TEST_ROOT = Path(__file__).resolve().parent
TOOLS_ROOT = TEST_ROOT.parent
CHECKOUT_ROOT = TOOLS_ROOT.parent
PACKAGE_ROOT = CHECKOUT_ROOT / '程序包'
APP_ROOT = PACKAGE_ROOT / ('主程序' if (PACKAGE_ROOT/'主程序/start_server.py').exists() else '应用')
USER_DATA_ROOT = PACKAGE_ROOT / ('运行数据' if APP_ROOT.name == '主程序' else '用户数据')
SAVE_ROOT = USER_DATA_ROOT / '存档'
CREATIVE_ROOT = CHECKOUT_ROOT / '创作包'

# Import the real application modules even when discovery starts outside it.
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

# Shipped public defaults; tests copy before editing and never read private rooms.
DAILY_LIFE_FIXTURE = APP_ROOT / 'defaults/日常小事'
