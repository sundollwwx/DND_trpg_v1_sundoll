const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT, 'asset/棋子库/棋子库.html'), 'utf8');
const source = html.slice(html.indexOf("const FILE_DB ="), html.indexOf('// 两级分类树'));
const packageText = (name, savedAt = 20) => JSON.stringify({
  format: 'sangduoer-library', savedAt, presets: [{ id: 'l1', name }],
});

function client({ protocol = 'http:', stored = {}, fetch, handle = null } = {}) {
  const cache = new Map(Object.entries(stored));
  const elements = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set('#' + match[1], { textContent: '', classList: { add() {}, remove() {} } });
  }
  let handleReads = 0;
  const context = vm.createContext({
    location: { protocol },
    localStorage: {
      getItem: key => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, String(value)),
      removeItem: key => cache.delete(key),
    },
    LIBRARY_KEY: 'library', LIBRARY_SAVED_AT_KEY: 'savedAt', BUNDLED_LIBRARY: [],
    presets: [{ id: 'l1', name: 'browser' }], uid: 1,
    normalize: item => ({ ...item }),
    populateCatSelects() {}, renderAll() {}, toast() {},
    console: { warn() {} }, window: {},
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: fetch || (() => { throw new Error('unexpected request'); }),
    $(selector) {
      return elements.get(selector) || null;
    },
    readHandle() { handleReads += 1; return handle; },
  });
  vm.runInContext(source + '\nidbFilesGet = async () => readHandle();', context);
  return { context, cache, run: code => vm.runInContext(code, context),
    handleReads: () => handleReads, status: () => elements.get('#persist-status')?.textContent };
}

function bridge(initial, failure = false) {
  let text = initial;
  const requests = [];
  return {
    requests, content: () => text,
    fetch: async (url, options) => {
      assert.equal(url, '/api/local-save');
      assert.equal(options.headers['X-Sundoll-Local-Save'], '1');
      const body = JSON.parse(options.body);
      assert.equal(body.path, '棋子库/棋子库.json');
      requests.push(body);
      if (failure) return { ok: false, json: async () => ({ ok: false, error: 'denied' }) };
      if (body.op === 'write') text = body.text;
      return { ok: true, json: async () => ({ ok: true, text }) };
    },
  };
}

test('HTTP library reads and writes the current server, ignoring a valid old directory handle', async () => {
  const server = bridge(packageText('current project'));
  const app = client({ fetch: server.fetch, handle: { name: '存档', queryPermission() { throw new Error('old path used'); } } });
  await app.run('initLibPersistStatus()');
  assert.equal(app.context.presets[0].name, 'current project');
  app.run("presets[0].name = 'edited'; saveLibrary()");
  assert.equal(await app.run('flushLibraryFileWrite()'), 'ok');
  assert.equal(JSON.parse(server.content()).presets[0].name, 'edited');
  assert.equal(app.handleReads(), 0);
  assert.equal(app.cache.has('dnd-board-library-pending-v1'), false);
});

test('HTTP failure keeps local recovery and never falls back to an old directory', async () => {
  const server = bridge(null, true);
  const app = client({ fetch: server.fetch, handle: { name: '存档' } });
  app.run("presets[0].name = 'unsaved'; saveLibrary()");
  await app.run('initLibPersistStatus()');
  assert.equal(await app.run('flushLibraryFileWrite()'), 'error');
  assert.equal(app.context.presets[0].name, 'unsaved');
  assert.equal(JSON.parse(app.cache.get('library'))[0].name, 'unsaved');
  assert.ok(app.cache.has('dnd-board-library-pending-v1'));
  assert.equal(app.handleReads(), 0);
  assert.match(app.status(), /失败/);
});

test('initialization does not write missing or malformed server library files', async () => {
  for (const initial of [null, '{broken']) {
    const server = bridge(initial);
    const app = client({ fetch: server.fetch });
    await app.run('initLibPersistStatus()');
    assert.equal(app.context.presets[0].name, 'browser');
    assert.deepEqual(server.requests.map(request => request.op), ['read']);
    assert.match(app.status(), initial === null ? /未保存/ : /失败/);
  }
});

test('an edit while the initial read is pending survives the delayed disk response', async () => {
  let resolveRead;
  const app = client({ fetch: () => new Promise(resolve => { resolveRead = resolve; }) });
  const loading = app.run('initLibPersistStatus()');
  app.run("presets[0].name = 'edited during load'; saveLibrary()");
  resolveRead({ ok: true, json: async () => ({ ok: true, text: packageText('old disk') }) });
  await loading;
  assert.equal(app.context.presets[0].name, 'edited during load');
  assert.match(app.status(), /未保存/);
});

test('a delayed initial read cannot replace content explicitly saved during loading', async () => {
  let resolveRead;
  const app = client({ fetch: async (url, options) => {
    if (JSON.parse(options.body).op === 'read') return new Promise(resolve => { resolveRead = resolve; });
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const loading = app.run('initLibPersistStatus()');
  assert.equal(await app.run('writeLibraryFile(presets)'), 'ok');
  resolveRead({ ok: true, json: async () => ({ ok: true, text: packageText('old disk') }) });
  await loading;
  assert.equal(app.context.presets[0].name, 'browser');
});

test('initialization preserves a newer browser cache and marked pending recovery', async () => {
  for (const stored of [{ savedAt: '30' }, { savedAt: '10', 'dnd-board-library-pending-v1': '10' }]) {
    const server = bridge(packageText('disk', 20));
    const app = client({ stored, fetch: server.fetch });
    await app.run('initLibPersistStatus()');
    assert.equal(app.context.presets[0].name, 'browser');
    assert.deepEqual(server.requests.map(request => request.op), ['read']);
    assert.match(app.status(), /未保存/);
  }
});

test('offline access rejects the outer project directory and ungranted save handles', async () => {
  for (const [handle, status] of [
    [{ name: '桑哆尔的世界', queryPermission() { throw new Error('should not request'); } }, 'unset'],
    [{ name: '存档', queryPermission: async () => 'prompt' }, 'denied'],
  ]) {
    const app = client({ protocol: 'file:', handle });
    await app.run('initLibPersistStatus()');
    assert.equal(await app.run('writeLibraryFile(presets)'), status);
    assert.equal(app.context.presets[0].name, 'browser');
  }
});

test('offline save handles still support loading and persisting the same library', async () => {
  let text = packageText('offline disk');
  const handle = {
    name: '存档', queryPermission: async () => 'granted',
    getDirectoryHandle: async name => {
      assert.equal(name, '棋子库');
      return { getFileHandle: async file => {
        assert.equal(file, '棋子库.json');
        return { getFile: async () => ({ text: async () => text }),
          createWritable: async () => ({ write: async value => { text = value; }, close: async () => {} }) };
      } };
    },
  };
  const app = client({ protocol: 'file:', handle });
  await app.run('initLibPersistStatus()');
  assert.equal(app.context.presets[0].name, 'offline disk');
  app.run("presets[0].name = 'offline edit'; saveLibrary()");
  assert.equal(await app.run('flushLibraryFileWrite()'), 'ok');
  assert.equal(JSON.parse(text).presets[0].name, 'offline edit');
});

test('an old save completion cannot clear a newer pending edit', async () => {
  let resolveWrite;
  const app = client({ fetch: () => new Promise(resolve => { resolveWrite = resolve; }) });
  app.run("presets[0].name = 'first'; saveLibrary()");
  const writing = app.run('writeLibraryFile(presets)');
  app.run("presets[0].name = 'second'; saveLibrary()");
  resolveWrite({ ok: true, json: async () => ({ ok: true }) });
  assert.equal(await writing, 'pending');
  assert.ok(app.cache.has('dnd-board-library-pending-v1'));
  assert.equal(JSON.parse(app.cache.get('library'))[0].name, 'second');
});

test('an intentionally empty cached library is not replaced with bundled presets', () => {
  const app = client({ stored: { library: '[]' } });
  app.context.BUNDLED_LIBRARY = [{ name: 'bundled' }];
  assert.equal(app.run('loadLibrary().length'), 0);
});
