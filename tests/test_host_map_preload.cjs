const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('主控台/app.js', 'utf8');

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
  const active = { id: 'map-a', mapData: 'data:image/png;base64,AAA' };
  const mapB = { id: 'map-b', mapData: 'data:image/png;base64,BBB' };
  const mapC = { id: 'map-c', mapData: 'data:image/png;base64,CCC' };
  const requests = [];
  const context = {
    AbortController,
    streamOn: true,
    streamPushing: false,
    streamDirty: false,
    streamMapPreloadGeneration: 7,
    streamMapPreloadController: null,
    streamMapAssetCache: new WeakMap(),
    state: { maps: [active, mapB, mapC] },
    activeMap: () => active,
    serverApiBase: () => 'http://127.0.0.1:8090',
    setTimeout: (callback) => { callback(); return 1; },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      const suffix = payload.mapData.endsWith('BBB') ? 'b'.repeat(64) : 'c'.repeat(64);
      return {
        ok: true,
        json: async () => ({ mapAssetUrl: `/api/assets/${suffix}` }),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('cachedStreamMapAssetUrl'),
    functionSource('prepareStreamMapPreloads'),
  ].join('\n'), context);

  await vm.runInContext('prepareStreamMapPreloads(7)', context);
  assert.deepStrictEqual(requests.map((request) => request.payload.mapData), [mapB.mapData, mapC.mapData]);
  assert(requests.every((request) => request.url.endsWith('/api/assets/cache-map')));
  assert.strictEqual(context.streamDirty, true);
  assert.strictEqual(
    vm.runInContext('cachedStreamMapAssetUrl(state.maps[1])', context),
    `/api/assets/${'b'.repeat(64)}`,
  );
  assert(source.includes('_mapPreloads: state.maps.map(cachedStreamMapAssetUrl).filter(Boolean)'));

  console.log('host map preload tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
