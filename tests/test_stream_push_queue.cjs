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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

(async () => {
  let now = 1000;
  let currentMap = { id: 'map-a', mapData: 'data:image/png;base64,AAA' };
  const requests = [];
  const pending = [];
  const context = {
    Date: { now: () => now },
    streamOn: true,
    streamPushing: false,
    streamDirty: true,
    streamLastPushAt: 0,
    streamConnectionState: 'online',
    streamFailToastAt: 0,
    streamMapAssetCache: new WeakMap(),
    activeMap: () => currentMap,
    buildStreamPayload: () => ({ maps: [{ id: currentMap.id, mapData: currentMap.mapData }] }),
    serverApiBase: () => 'http://127.0.0.1:8090',
    updateStreamUi: () => {},
    toast: () => {},
    fetch: (_url, options) => {
      requests.push(JSON.parse(options.body));
      const job = deferred();
      pending.push(job);
      return job.promise;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('streamPush'),
    functionSource('streamTick'),
  ].join('\n'), context);

  vm.runInContext('streamTick()', context);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].maps[0].id, 'map-a');

  currentMap = { id: 'map-b', mapData: 'data:image/png;base64,BBB' };
  context.streamDirty = true;
  now = 1400;
  vm.runInContext('streamTick()', context);
  assert.strictEqual(requests.length, 1, 'an in-flight upload must not start a parallel upload');
  assert.strictEqual(context.streamDirty, true, 'an in-flight upload must not clear the queued map change');

  pending[0].resolve({
    ok: true,
    json: async () => ({ mapId: 'map-a', mapAssetUrl: '/api/assets/map-a' }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  now = 1800;
  vm.runInContext('streamTick()', context);
  assert.strictEqual(requests.length, 2, 'the queued map change must upload after the first request finishes');
  assert.strictEqual(requests[1].maps[0].id, 'map-b');

  pending[1].resolve({
    ok: true,
    json: async () => ({ mapId: 'map-b', mapAssetUrl: '/api/assets/map-b' }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(context.streamDirty, false);

  console.log('stream push queue tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
