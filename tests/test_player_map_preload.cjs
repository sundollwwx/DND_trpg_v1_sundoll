const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('主控台/玩家.html', 'utf8');

function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
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

(async () => {
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const hashC = 'c'.repeat(64);
  const active = `/api/assets/${hashA}`;
  const requested = [];
  let nextTimer = 1;
  const context = {
    URL,
    AbortController,
    location: { href: 'https://table.example/主控台/玩家.html' },
    currentMap: { mapData: active },
    setTimeout: () => nextTimer++,
    clearTimeout: () => {},
    fetch: async (url, options) => {
      requested.push({ url, options });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    const mapPreloadCached = new Set(), mapPreloadQueued = new Set(), mapPreloadAttempts = new Map();
    let mapPreloadQueue = [], mapPreloadTimer = null, mapPreloadController = null, mapPreloadActiveUrl = '';
    ${functionSource('normalizedMapPreloadUrl')}
    ${functionSource('scheduleNextMapPreload')}
    ${functionSource('preloadNextMapAsset')}
    ${functionSource('queueMapAssetPreloads')}
  `, context);

  vm.runInContext(`queueMapAssetPreloads([
    '${active}', '/api/assets/${hashB}', '/api/assets/${hashC}', 'https://evil.example/map.png'
  ], '${active}')`, context);
  assert.strictEqual(vm.runInContext('mapPreloadQueue.length', context), 2);

  vm.runInContext('mapPreloadTimer=null', context);
  await vm.runInContext('preloadNextMapAsset()', context);
  assert.strictEqual(requested.length, 1);
  assert.strictEqual(requested[0].url, `https://table.example/api/assets/${hashB}`);
  assert.strictEqual(requested[0].options.cache, 'force-cache');
  assert.strictEqual(requested[0].options.priority, 'low');

  vm.runInContext('mapPreloadTimer=null', context);
  await vm.runInContext('preloadNextMapAsset()', context);
  assert.strictEqual(requested.length, 2);
  assert.strictEqual(requested[1].url, `https://table.example/api/assets/${hashC}`);
  assert.strictEqual(vm.runInContext('mapPreloadCached.size', context), 2);

  console.log('player map preload tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
