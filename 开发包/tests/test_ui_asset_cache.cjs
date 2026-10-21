const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto, createHash} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../程序包/主程序/shared/ui-assets-sw.js'), 'utf8');
const origin = 'https://pl.example.com';
const bytes = Buffer.from('public artwork');
const entry = {url: '/asset/ui/logo.png', cacheUrl: '/ui-assets/v1/logo.png', size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex')};
function boot(entries = [entry], values = new Map(), options = {}) {
  const events = {}, calls = [];
  const cache = {
    async match(key) { return values.get(key)?.clone(); },
    async put(key, response) { if (options.quota) throw Error('Quota'); values.set(key, response.clone()); },
    async keys() { return [...values.keys()].map(url => ({url})); },
    async delete(key) { return values.delete(key.url || key); },
  };
  const fetch = async (request, settings) => {
    const url = typeof request === 'string' ? request : request.url;
    calls.push({url, settings});
    if (options.offline) throw Error('Offline');
    return new Response(options.corrupt ? 'wrong image' : bytes, {headers: {'Content-Type': 'image/png'}});
  };
  vm.runInNewContext(source.replace('/*__UI_ASSETS__*/ []', JSON.stringify(entries)), {
    self: {location: {origin}, clients: {claim: async () => {}}, skipWaiting: async () => {}, addEventListener: (name, fn) => {events[name] = fn;}},
    caches: {open: async () => {if (options.unavailable) throw Error('Unavailable'); return cache;}},
    URL, Request, Response, AbortController, crypto: webcrypto, Uint8Array, setTimeout, clearTimeout, fetch,
  });
  return {calls, values, options,
    request(url, init) {let result; events.fetch({request: new Request(origin + url, init), respondWith: promise => {result = promise;}}); return result;},
    async event(name, extra = {}) {let done; events[name]({...extra, waitUntil: promise => {done = promise;}}); await done;},
  };
}
test('repeat visits and room URLs read the same cached bytes without network', async () => {
  const sw = boot();
  assert.equal(await (await sw.request(entry.url)).text(), bytes.toString());
  sw.options.offline = true;
  assert.equal(await (await sw.request('/rooms/r' + 'a'.repeat(32) + entry.url)).text(), bytes.toString());
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.calls[0].settings.credentials, 'omit');
});
test('HTML, account, game state, private art, mutations and ranges bypass the cache', () => {
  const sw = boot();
  for (const url of ['/account', '/api/account/session', '/api/state', '/api/module-assets/secret', '/asset/地图/secret.png', '/主控台/玩家.html']) {
    assert.equal(sw.request(url), undefined);
  }
  assert.equal(sw.request(entry.url, {method: 'POST'}), undefined);
  assert.equal(sw.request(entry.url, {headers: {Range: 'bytes=0-3'}}), undefined);
  assert.equal(sw.calls.length, 0);
});
test('updated manifest removes only obsolete UI files and downloads the new version', async () => {
  const values = new Map();
  const first = boot([entry], values);
  await first.request(entry.url);
  const changed = {...entry, cacheUrl: '/ui-assets/v2/logo.png'};
  const next = boot([changed], values);
  await next.event('activate');
  assert.equal(values.size, 0);
  await next.request(entry.url);
  assert.equal(next.calls[0].url, origin + changed.cacheUrl);
});
test('quota failures and unavailable storage still display fetched artwork', async () => {
  for (const options of [{quota: true}, {unavailable: true}]) {
    const sw = boot([entry], new Map(), options);
    assert.equal(await (await sw.request(entry.url)).text(), bytes.toString());
    assert.equal(sw.values.size, 0);
  }
});
test('invalid version bytes are never cached; normal request remains the fallback', async () => {
  const sw = boot([entry], new Map(), {corrupt: true});
  await sw.request(entry.url);
  assert.equal(sw.values.size, 0);
  assert.equal(sw.calls.at(-1).url, origin + entry.url);
});
test('background preparation shares a download with simultaneous requests', async () => {
  const sw = boot();
  await Promise.all([sw.event('message', {data: {type: 'warm-ui-assets'}}), sw.request(entry.url), sw.request(entry.url)]);
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.values.size, 1);
});
test('full browser storage stops background downloads instead of refetching the entire library', async () => {
  const sw = boot([entry, {...entry, url: '/asset/ui/other.png', cacheUrl: '/ui-assets/v1/other.png'}], new Map(), {quota: true});
  await sw.event('message', {data: {type: 'warm-ui-assets'}});
  await sw.event('message', {data: {type: 'warm-ui-assets'}});
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.values.size, 0);
});
