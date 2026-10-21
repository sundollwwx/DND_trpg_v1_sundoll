"""Bounded, ephemeral PCM relay. Never writes captured audio to disk."""
import base64
import binascii
import secrets
import threading
import time
from collections import deque


class MusicRelay:
    def __init__(self, clock=time.monotonic):
        self.lock = threading.Lock()
        self.clock = clock
        self.stream_id = ''
        self.sequence = 0
        self.updated = 0
        self.packets = deque(maxlen=12)  # At most six seconds / 1.6 MB base64.

    def _expire(self):
        if self.stream_id and self.clock() - self.updated > 12:
            self.stream_id = ''
            self.packets.clear()

    def write(self, data):
        if not isinstance(data, dict):
            raise ValueError('bad relay command')
        with self.lock:
            self._expire()
            op = data.get('action')
            if op == 'start':
                self.stream_id = secrets.token_hex(16)
                self.sequence = 0
                self.updated = self.clock()
                self.packets.clear()
                return {'ok': True, 'id': self.stream_id, 'url': '/api/music-live?id=' + self.stream_id}
            if not self.stream_id or data.get('id') != self.stream_id:
                raise ValueError('音频连接已失效，请重新连接')
            if op == 'stop':
                self.stream_id = ''
                self.packets.clear()
                return {'ok': True}
            if op != 'chunk':
                raise ValueError('bad relay command')
            seq, rate = data.get('seq'), data.get('rate')
            if type(seq) is not int or seq != self.sequence + 1:
                raise ValueError('音频分片顺序错误，请重新连接')
            if type(rate) is not int or rate not in (44100, 48000):
                raise ValueError('unsupported sample rate')
            encoded = data.get('pcm')
            if not isinstance(encoded, str) or len(encoded) > 128000:
                raise ValueError('audio packet too large')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError('bad audio packet')
            if len(raw) != (rate // 2) * 4:
                raise ValueError('bad audio packet size')
            self.sequence = seq
            self.updated = self.clock()
            self.packets.append({'seq': seq, 'rate': rate, 'pcm': encoded})
            return {'ok': True, 'seq': seq}

    def read(self, stream_id='', after=-1):
        with self.lock:
            self._expire()
            if not stream_id:
                return {'ok': True, 'transport': 'https-pcm', 'active': bool(self.stream_id)}
            if stream_id != self.stream_id:
                return {'ok': True, 'active': False, 'packets': []}
            # Late joins / slow clients start at the live edge, never replay minutes of audio.
            packets = list(self.packets)
            reset = after < 0 or (packets and after < packets[0]['seq'] - 1)
            packets = packets[-2:] if reset else [p for p in packets if p['seq'] > after]
            return {'ok': True, 'active': True, 'reset': bool(reset), 'packets': packets}
