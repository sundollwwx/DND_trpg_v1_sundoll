"""Read the JSON-compatible assignment shared with browser clients."""
import json
from pathlib import Path

def protocol_version():
    text = (Path(__file__).resolve().parents[1] / 'shared/protocol.js').read_text(encoding='utf-8').strip()
    prefix = 'globalThis.SundollProtocol = '
    if not text.startswith(prefix) or not text.endswith(';'):
        raise ValueError('Invalid shared protocol configuration')
    value = json.loads(text[len(prefix):-1])['version']
    if type(value) is not int or value < 1:
        raise ValueError('Invalid protocol version')
    return value
