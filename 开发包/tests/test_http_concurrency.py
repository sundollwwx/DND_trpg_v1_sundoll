"""Transport backpressure must not block unrelated room requests or reorder SSE."""
import concurrent.futures
import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from test_player_profiles import SERVER


class HttpConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in {
            'ROOT': str(self.root), 'LOCAL_SAVE_ROOT': str(self.root / 'save'),
            'AUTH_METHOD': 'name', 'STATE': None, 'CLIENTS': [], 'SESSIONS': {},
            'LOGIN_ATTEMPTS': {}, 'REGISTRATION_ATTEMPTS': {}, 'RECENT_ACTIONS': [],
        }.items():
            patch = mock.patch.object(SERVER, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        SERVER.profile_store().create('并发测试玩家')
        self.httpd = SERVER.Server(('127.0.0.1', 0), SERVER.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        with SERVER.LOCK:
            for client in list(SERVER.CLIENTS):
                client.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)

    def request(self, path, body=None, timeout=1):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=timeout)
        try:
            connection.request('GET' if body is None else 'POST', path,
                               None if body is None else json.dumps(body),
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def slow_upload(self, entered, headers=None):
        original_setup = SERVER.Handler.setup

        class ObservedReader:
            def __init__(self, stream):
                self.stream = stream

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def read(self, count):
                entered.set()
                return self.stream.read(count)

        def setup(handler):
            original_setup(handler)
            handler.rfile = ObservedReader(handler.rfile)

        payload = json.dumps({'nickname': '并发测试玩家'}).encode()
        client = socket.create_connection(('127.0.0.1', self.port), timeout=2)
        self.addCleanup(client.close)
        head = ('POST /api/session HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\n'
                'Content-Length: %d\r\n%s\r\n' % (len(payload), headers or '')).encode()
        with mock.patch.object(SERVER.Handler, 'setup', setup):
            client.sendall(head + payload[:1])
            self.assertTrue(entered.wait(2), 'server did not start reading the upload')
        return client, payload[1:]

    def test_slow_upload_does_not_block_health_or_another_login(self):
        client, remainder = self.slow_upload(threading.Event())
        try:
            self.assertEqual(self.request('/api/health')[0], 200)
            status, result = self.request('/api/session', {'nickname': '并发测试玩家'})
            self.assertEqual(status, 200)
            self.assertTrue(result['ok'])
        finally:
            client.sendall(remainder)
        response = http.client.HTTPResponse(client)
        response.begin()
        self.assertEqual(response.status, 200)
        response.read()

    def test_workspace_epoch_is_rechecked_after_upload(self):
        from server.workspace import atomic_json
        marker = Path(SERVER.LOCAL_SAVE_ROOT).parent / '工作区代次.json'
        atomic_json(marker, {'epoch': 'before-upload'})
        client, remainder = self.slow_upload(threading.Event(), 'X-Sundoll-Workspace: before-upload\r\n')
        atomic_json(marker, {'epoch': 'after-upload'})
        client.sendall(remainder)
        response = http.client.HTTPResponse(client)
        response.begin()
        self.assertEqual(response.status, 409)
        self.assertFalse(json.loads(response.read())['ok'])
        self.assertEqual(SERVER.SESSIONS, {})

    def test_unauthorized_unknown_and_oversized_uploads_reject_without_body(self):
        cases = [('/api/modules/import', 2 * 1024 ** 3, 403),
                 ('/api/unknown-route', 2 * 1024 ** 3, 404),
                 ('/api/session', 64 * 1024 + 1, 413)]
        with mock.patch.object(SERVER, 'local_save_request_allowed', return_value=False):
            for path, length, expected in cases:
                connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=1)
                try:
                    connection.putrequest('POST', path)
                    connection.putheader('Content-Length', str(length))
                    connection.endheaders()
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected, path)
                    response.read()
                finally:
                    connection.close()

    def test_slow_post_response_does_not_hold_transaction_lock(self):
        entered = threading.Event()
        original_setup = SERVER.Handler.setup

        class ObservedWriter:
            def __init__(self, stream):
                self.stream = stream

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def write(self, payload):
                if len(payload) >= 256 * 1024:
                    entered.set()
                return self.stream.write(payload)

        def setup(handler):
            original_setup(handler)
            handler.wfile = ObservedWriter(handler.wfile)

        original_dispatch = SERVER.Handler._dispatch_post

        def dispatch(handler):
            if handler.path == '/api/large-test-response':
                handler._send_json({'padding': 'x' * (8 * 1024 * 1024)})
            else:
                original_dispatch(handler)

        client = socket.socket()
        client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        client.connect(('127.0.0.1', self.port))
        try:
            with mock.patch.object(SERVER.Handler, 'setup', setup), mock.patch.object(SERVER.Handler, '_dispatch_post', dispatch):
                client.sendall(b'POST /api/large-test-response HTTP/1.0\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n')
                self.assertTrue(entered.wait(2))
                # Acquiring from another thread checks the actual global write lock.
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    def lock_available():
                        acquired = SERVER.LOCK.acquire(timeout=.5)
                        if acquired:
                            SERVER.LOCK.release()
                        return acquired
                    self.assertTrue(pool.submit(lock_available).result(1))
                self.assertEqual(self.request('/api/health')[0], 200)
                self.assertEqual(self.request('/api/session', {'nickname': '并发测试玩家'})[0], 200)
        finally:
            client.close()

    def test_binary_module_upload_survives_disk_spooling_unchanged(self):
        payload = b'PK\x00\xfftransport-test' * 80000
        runtime = mock.Mock()
        runtime.packages.catalog.return_value = []
        observed = []

        def inspect(upload):
            observed.append(upload.read())
            return {'moduleId': 'transport-test', 'kind': 'general'}, {}

        runtime.packages.inspect.side_effect = inspect
        with mock.patch('server.module_runtime.ModuleRuntime', return_value=runtime), mock.patch.object(SERVER, 'local_save_request_allowed', return_value=True):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
            try:
                connection.request('POST', '/api/modules/preview', payload,
                                   {'Content-Type': 'application/octet-stream'})
                response = connection.getresponse()
                raw = response.read()
                self.assertEqual(response.status, 200, raw)
                self.assertEqual(int(response.getheader('Content-Length')), len(raw))
            finally:
                connection.close()
        self.assertEqual(observed, [payload])
        preview = next((Path(SERVER.LOCAL_SAVE_ROOT) / '模块存储/导入暂存').glob('*.sundoll'))
        self.assertEqual(preview.read_bytes(), payload)

    @staticmethod
    def read_event(response):
        while True:
            line = response.fp.readline()
            if not line:
                raise AssertionError('SSE disconnected before event')
            if line.startswith(b'data: '):
                return json.loads(line[6:])

    def test_sse_snapshot_precedes_ordered_events_and_reconnects_to_latest_state(self):
        SERVER.STATE = {'maps': [], '_streamSeq': 2}
        SERVER.RECENT_ACTIONS[:] = [{'seq': 1, 'op': 'one'}, {'seq': 2, 'op': 'two'}]
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        connection.request('GET', '/api/events', headers={'Last-Event-ID': '1'})
        response = connection.getresponse()
        try:
            first = self.read_event(response)
            self.assertEqual(first['type'], 'state')
            self.assertEqual(first['state']['_streamSeq'], 2)
            for sequence in (3, 4):
                SERVER.broadcast({'type': 'action', 'seq': sequence}, sequence)
            self.assertEqual([self.read_event(response)['seq'] for _ in range(2)], [3, 4])
            with SERVER.LOCK:
                SERVER.STATE['_streamSeq'] = 4
                for client in list(SERVER.CLIENTS):
                    client.close()
        finally:
            connection.close()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        connection.request('GET', '/api/events', headers={'Last-Event-ID': '2'})
        response = connection.getresponse()
        try:
            self.assertEqual(self.read_event(response)['state']['_streamSeq'], 4)
            self.assertEqual([a['seq'] for a in SERVER.RECENT_ACTIONS], [1, 2])
        finally:
            connection.close()


class SSEQueueTests(unittest.TestCase):
    def test_slow_queue_overflow_does_not_delay_or_reorder_healthy_client(self):
        slow, healthy = SERVER.SSEClient(mock.Mock()), SERVER.SSEClient(mock.Mock())
        slow.MAX_EVENTS = 2
        actions = [{'seq': sequence} for sequence in range(1, 5)]
        with mock.patch.object(SERVER, 'CLIENTS', [slow, healthy]), mock.patch.object(SERVER, 'RECENT_ACTIONS', actions):
            received = []
            for action in actions:
                SERVER.broadcast({'type': 'action', **action}, action['seq'])
                payload = healthy.next_payload(timeout=0)
                received.append(json.loads(payload.split(b'data: ', 1)[1])['seq'])
            self.assertEqual(received, [1, 2, 3, 4])
            self.assertTrue(slow.closed)
            self.assertEqual(slow.pending_bytes, 0)
            self.assertNotIn(slow, SERVER.CLIENTS)
            self.assertEqual(SERVER.RECENT_ACTIONS, actions)
            slow.connection.shutdown.assert_called_once_with(socket.SHUT_RDWR)

    def test_queue_byte_limit_disconnects_only_that_stream(self):
        client = SERVER.SSEClient(mock.Mock())
        client.MAX_BYTES = 8
        self.assertTrue(client.enqueue(b'12345'))
        self.assertFalse(client.enqueue(b'6789'))
        self.assertIsNone(client.next_payload(timeout=0))
        self.assertEqual(client.pending_bytes, 0)


class StateSnapshotTests(unittest.TestCase):
    def test_get_serializes_an_independent_snapshot_without_holding_state_lock(self):
        state = {'maps': [{'tokens': [{'conditions': [], 'nested': {'x': 1}}]}]}
        handler = mock.Mock(path='/api/state')

        def send(snapshot):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                def update():
                    if not SERVER.LOCK.acquire(timeout=.5):
                        return False
                    try:
                        state['maps'][0]['tokens'][0]['nested']['x'] = 2
                        return True
                    finally:
                        SERVER.LOCK.release()
                self.assertTrue(pool.submit(update).result(1))
            self.assertEqual(snapshot['maps'][0]['tokens'][0]['nested']['x'], 1)

        handler._send_json.side_effect = send
        with mock.patch.object(SERVER, 'STATE', state):
            SERVER.Handler.do_GET(handler)
        handler._send_json.assert_called_once()


if __name__ == '__main__':
    unittest.main()
