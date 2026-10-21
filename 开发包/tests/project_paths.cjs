// Tests live outside the application; resolve sources independently of shell cwd.
const path = require('node:path');
const TEST_ROOT = __dirname;
const TOOLS_ROOT = path.dirname(TEST_ROOT);
const CHECKOUT_ROOT = path.dirname(TOOLS_ROOT);
const PACKAGE_ROOT = path.join(CHECKOUT_ROOT, '程序包');
const APP_ROOT = path.join(PACKAGE_ROOT, require('node:fs').existsSync(path.join(PACKAGE_ROOT,'主程序','start_server.py')) ? '主程序' : '应用');
const DAILY_LIFE_FIXTURE = path.join(APP_ROOT, "defaults/日常小事");
module.exports = { DAILY_LIFE_FIXTURE, TEST_ROOT, TOOLS_ROOT, PACKAGE_ROOT, APP_ROOT, CHECKOUT_ROOT };
