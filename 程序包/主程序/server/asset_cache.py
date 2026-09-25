"""Byte-budgeted LRU for disposable media; disk remains the durable source."""
from collections import OrderedDict
from collections.abc import MutableMapping
from threading import RLock

class AssetCache(MutableMapping):
    def __init__(self, max_bytes=64 * 1024 * 1024):
        self.max_bytes = max(0, int(max_bytes))
        self.bytes = 0
        self._items = OrderedDict()
        self._lock = RLock()

    def __getitem__(self, key):
        with self._lock:
            value = self._items[key]
            self._items.move_to_end(key)
            return value

    def __setitem__(self, key, value):
        size = len(value[1])
        with self._lock:
            previous = self._items.pop(key, None)
            if previous is not None:
                self.bytes -= len(previous[1])
            if size > self.max_bytes:
                return
            self._items[key] = value
            self.bytes += size
            while self.bytes > self.max_bytes:
                _, old = self._items.popitem(last=False)
                self.bytes -= len(old[1])

    def __delitem__(self, key):
        with self._lock:
            self.bytes -= len(self._items.pop(key)[1])

    def __iter__(self):
        with self._lock:
            return iter(tuple(self._items))

    def __len__(self):
        with self._lock:
            return len(self._items)

    def clear(self):
        with self._lock:
            self._items.clear()
            self.bytes = 0
