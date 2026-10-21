"""Installation storage boundary: account rooms or a retired historical workspace."""
import json
from pathlib import Path

MODE_FILE = '账号房间模式.json'
JOURNAL_FILE = '原工作区归档事务.json'
ARCHIVE_FILE = '历史归档.json'
FORMAT = 'sundoll-account-rooms-v1'


def account_rooms_only(save_root):
    path = Path(save_root).parent / MODE_FILE
    if not path.exists():
        marker = Path(save_root) / '工作区.json'
        if marker.is_file() and json.loads(marker.read_text('utf-8')).get('storageMode') == 'account-rooms':
            raise ValueError('账号房间模式标记缺失，未尝试重建旧工作区')
        return False
    value = json.loads(path.read_text('utf-8'))
    if not isinstance(value, dict) or value.get('format') != FORMAT:
        raise ValueError('存储模式配置无效，未尝试打开旧工作区')
    return True


def validate_startup(save_root, settings):
    data = Path(save_root).parent
    if (data / JOURNAL_FILE).exists():
        raise RuntimeError('原工作区归档尚未完成，请先完成或回滚归档；未启动服务')
    if (data.parent / ARCHIVE_FILE).exists():
        raise RuntimeError('这是只读历史归档，不能作为日常服务启动；请在独立副本中恢复资料')
    if account_rooms_only(save_root) and not (settings.get('enabled') is True and settings.get('roomsEnabled') is True):
        raise RuntimeError('账号房间模式需要启用邮箱账号与房间，不能回退到旧工作区')


def account_destination(handler, app):
    return app.WEB_ENTRANCES.page_values(handler, app.ACCOUNT_SETTINGS)['accountUrl'] + '#dashboard'


def handle_central(handler, app, path):
    """Only room-scoped traffic may reach gameplay in a retired installation."""
    from urllib.parse import unquote, urlsplit
    from .account_http import respond
    if not getattr(app, 'ACCOUNT_ROOMS_ONLY', False): return False
    route = unquote(urlsplit(path).path)
    method = handler.command
    if route == '/account' or route.startswith('/api/account/'):
        return False
    if method in ('GET', 'HEAD') and (route in ('/', '/index.html', '/login') or route.endswith('.html')):
        handler._redirect(account_destination(handler, app)); return True
    if route == '/api/workspace-epoch' and method in ('GET', 'HEAD'):
        return False
    if route in ('/api/info', '/api/health', '/api/local-tunnel') and app.host_request_allowed(handler):
        return False
    if route.startswith('/api/'):
        handler.close_connection = True
        respond(handler, {'ok': False, 'error': '原工作区已归档，请从个人主页选择房间',
                          'accountUrl': account_destination(handler, app)}, 410)
        return True
    # Public account/theme resources retain the existing static allowlist.
    return False
