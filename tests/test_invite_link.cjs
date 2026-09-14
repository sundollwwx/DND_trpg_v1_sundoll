const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('主控台/app.js', 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function inviteUrl(search, publicBase = '') {
  const context = {
    URL,
    URLSearchParams,
    location: {
      search,
      protocol: 'http:',
      hostname: '127.0.0.1',
      origin: 'http://127.0.0.1:8090',
    },
    streamInfo: { roomCode: 'ABC123', ip: '192.168.1.20', port: 8090, publicBase },
    configuredServerBase: () => '',
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('normalizeServerBase'),
    functionSource('isLoopbackHost'),
    functionSource('queryPublicBase'),
    functionSource('playerViewerUrl'),
    'result = playerViewerUrl();',
  ].join('\n'), context);
  return context.result;
}

assert.strictEqual(
  inviteUrl('?public=https%3A%2F%2Fquiet-river.trycloudflare.com'),
  'https://quiet-river.trycloudflare.com/主控台/玩家.html?room=ABC123',
);
assert.strictEqual(
  inviteUrl(''),
  'http://192.168.1.20:8090/主控台/玩家.html?room=ABC123',
);
assert.strictEqual(
  inviteUrl('', 'https://server-synced.trycloudflare.com'),
  'https://server-synced.trycloudflare.com/主控台/玩家.html?room=ABC123',
);

console.log('invite link tests passed');
