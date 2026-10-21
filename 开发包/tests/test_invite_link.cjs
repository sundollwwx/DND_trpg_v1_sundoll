const {readClientSource}=require('./client_sources.cjs');
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {test}=require('node:test');

const source = readClientSource('主控台/host/app.js', 'utf8');

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

function inviteUrl(search, publicBase = '', room = null, origin='http://127.0.0.1:8090') {
  const context = {
    window: {SundollRoom: room},
    URL,
    URLSearchParams,
    location: {
      search,
      protocol: new URL(origin).protocol,
      hostname: new URL(origin).hostname,
      origin,
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
  'http://192.168.1.20:8090/主控台/玩家.html',
);
assert.strictEqual(
  inviteUrl(''),
  'http://192.168.1.20:8090/主控台/玩家.html',
);
assert.strictEqual(
  inviteUrl('', 'https://server-synced.trycloudflare.com'),
  'https://server-synced.trycloudflare.com/',
);

console.log('invite link tests passed');

assert.strictEqual(inviteUrl('?public=https%3A%2F%2Fold.trycloudflare.com', 'https://new.trycloudflare.com'), 'https://new.trycloudflare.com/');
assert.strictEqual(inviteUrl('', 'https://sundollworld.com'), 'https://sundollworld.com/');

assert.strictEqual(inviteUrl('', 'https://pl.sundollworld.com'), 'https://pl.sundollworld.com/');

assert.strictEqual(
  inviteUrl('', '', {id: 'r1', prefix: '/rooms/r1'}),
  'http://127.0.0.1:8090/rooms/r1/主控台/玩家.html',
);
test('a room opened locally shares its configured public player URL',()=>{
  assert.strictEqual(inviteUrl('', 'https://pl.sundollworld.com', {id:'r1',prefix:'/rooms/r1'}),
    'https://pl.sundollworld.com/rooms/r1/主控台/玩家.html');
});
test('a room opened on the DM domain shares the configured player domain',()=>{
  assert.strictEqual(inviteUrl('', 'https://pl.sundollworld.com/', {id:'r1',prefix:'/rooms/r1'},'https://dm.sundollworld.com'),
    'https://pl.sundollworld.com/rooms/r1/主控台/玩家.html');
});
for(const base of ['', 'https://user:password@example.com', 'javascript:alert(1)', 'http://127.0.0.2:8090','http://[::1]:8090','https://room.localhost']){
  test(`an unavailable or unsafe room public URL falls back to the actual origin: ${base||'absent'}`,()=>{
    assert.strictEqual(inviteUrl('',base,{id:'r1',prefix:'/rooms/r1'},'https://dm.sundollworld.com'),
      'https://dm.sundollworld.com/rooms/r1/主控台/玩家.html');
  });
}
