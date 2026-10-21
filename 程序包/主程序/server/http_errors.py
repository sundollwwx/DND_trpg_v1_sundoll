"""Translate database failures at HTTP boundaries without exposing private data."""
from functools import wraps
import logging
import sqlite3
from urllib.parse import urlparse


DATABASE_UNAVAILABLE = '存档数据库暂时无法读取或写入，请保留当前操作后重试；如仍失败，请检查一致备份。'


def database_error_boundary(method):
    @wraps(method)
    def guarded(handler, *args, **kwargs):
        try:
            return method(handler, *args, **kwargs)
        except sqlite3.Error:
            # Request bodies and query strings can contain credentials or private
            # inventory data; log only the route and the database traceback.
            route = urlparse(getattr(handler, 'path', '')).path
            logging.getLogger(__name__).exception('Database request failed: %s %s', method.__name__, route)
            response = {'ok': False, 'error': DATABASE_UNAVAILABLE, 'code': 'database_unavailable'}
            if getattr(handler, 'command', '') == 'HEAD':
                handler._send_document_json(response, 503, True)
            else:
                handler._send_document_json(response, 503)
    return guarded
