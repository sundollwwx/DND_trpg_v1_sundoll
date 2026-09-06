// Run with node --test tests/test_resource_links.cjs. Uses the actual shared-link code, no live saves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '主控台/app.js'), 'utf8');
const links = source.slice(
  source.indexOf("const LINKS_KEY = 'sangduoer-links-v1';"),
  source.indexOf('/* ==================== BGM 音乐'),
);

function fixture(initialState = [], localLinks = null) {
  const storage = new Map();
  if (localLinks) storage.set('sangduoer-links-v1', JSON.stringify(localLinks));
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.innerHTML = ''; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
  }
  const box = new Element();
  const context = vm.createContext({
    URL,
    uid: 1,
    state: { sharedResources: initialState },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    document: { createElement: () => new Element() },
    $: (selector) => selector === '#links-list' ? box : null,
    scheduleAutosave() {},
    toast() {},
  });
  vm.runInContext(links, context);
  return { context, storage, box, run: (code) => vm.runInContext(code, context) };
}

const builtinUrl = 'https://www.trpgcard.com/share/INV-U8NL';

test('the character-sheet link is merged idempotently into saved campaign links', () => {
  const fixtureState = fixture([{ id: 'saved', name: '战役资料', url: 'https://example.com/saved' }], [
    { id: 'local', name: '本机资料', url: 'https://example.com/local' },
  ]);
  fixtureState.run('loadLinks(); loadLinks();');
  const linksAfterLoad = JSON.parse(JSON.stringify(
    fixtureState.run('userLinks.map(({id,name,url}) => ({id,name,url}))'),
  ));
  assert.deepEqual(linksAfterLoad, [
    { id: 'builtin-trpgcard', name: '车卡器', url: builtinUrl },
    { id: 'saved', name: '战役资料', url: 'https://example.com/saved' },
  ]);
});

test('the merge also covers local-storage and empty-library fallback sources', () => {
  const fromLocal = fixture([], [{ id: 'local', name: '本机资料', url: 'https://example.com/local' }]);
  fromLocal.run('loadLinks()');
  assert.deepEqual(JSON.parse(JSON.stringify(fromLocal.run('userLinks.map(link => link.url)'))), [builtinUrl, 'https://example.com/local']);

  const fromFallback = fixture();
  fromFallback.run('loadLinks()');
  assert.deepEqual(JSON.parse(JSON.stringify(fromFallback.run('userLinks.map(link => link.url)'))), [builtinUrl, 'https://5echm.kagangtuya.top/']);
});

test('the builtin link has no delete control and saveLinks restores it if removed', () => {
  const fixtureState = fixture([{ id: 'custom', name: '资料', url: 'https://example.com/custom' }]);
  fixtureState.run('loadLinks(); renderLinks()');
  assert.equal(fixtureState.box.children[0].children.length, 1);
  assert.equal(fixtureState.box.children[1].children.length, 2);

  fixtureState.run("userLinks = userLinks.filter(link => link.id !== 'builtin-trpgcard'); saveLinks()");
  assert.equal(fixtureState.run("userLinks.filter(link => link.id === 'builtin-trpgcard').length"), 1);
});
