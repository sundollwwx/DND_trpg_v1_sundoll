const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {APP_ROOT} = require('./project_paths.cjs');
const storage = fs.readFileSync(path.join(APP_ROOT, '主控台/host/storage.js'), 'utf8');
const app = fs.readFileSync(path.join(APP_ROOT, '主控台/host/app.js'), 'utf8');
const tick = () => new Promise(setImmediate);

function fn(source, name) {
  const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  let level = 0;
  for (let i = source.indexOf('{', source.indexOf(') {', start)); i < source.length; i++) {
    if (source[i] === '{') level++;
    if (source[i] === '}' && --level === 0) return source.slice(start, i + 1);
  }
  throw Error(name);
}

function recordsFixture() {
  const requested = [], covers = [];
  const context = vm.createContext({
    usingLocalSaveBridge: () => true,
    localSaveApiRequest: async op => {
      requested.push(op);
      return {records: [
        {id: 'first', savedAt: 1, _folderName: 'first'},
        {id: 'latest', savedAt: 2, _folderName: 'latest'},
      ]};
    },
    readCampaignCover: folder => new Promise(resolve => covers.push({folder, resolve})),
    campaignCoverReadVersion: () => 'current',
  });
  vm.runInContext('let campaignRecordsCache = null;\n' +
    fn(storage, 'loadCampaignRecordCovers') + '\n' + fn(storage, 'readCampaignRecords'), context);
  return {context, requested, covers};
}

test('fresh startup metadata is usable while every cover request is still unresolved', async () => {
  const f = recordsFixture();
  const records = await f.context.readCampaignRecords(true, {covers: false});
  assert.deepEqual(Array.from(records, r => r.id), ['latest', 'first']);
  assert.equal(f.covers.length, 0);
  assert.deepEqual(f.requested, ['campaign-catalog']);
  const cached = await f.context.readCampaignRecords(false, {covers: false});
  assert.equal(cached[0], records[0]);
  assert.equal(f.requested.length, 1);
});

test('index-writing callers still wait for complete cover metadata, including missing covers', async () => {
  const f = recordsFixture();
  await f.context.readCampaignRecords(true, {covers: false});
  let completed = false;
  const pending = f.context.readCampaignRecords().then(records => {completed = true; return records;});
  await tick();
  assert.equal(f.covers.length, 2);
  assert.equal(completed, false);
  f.covers[0].resolve({fileName: '封面.webp', url: 'data:image/webp;base64,AAA'});
  f.covers[1].resolve(null);
  const records = await pending;
  assert.equal(records[0].coverFile, '封面.webp');
  assert.equal(records[1].coverUrl, '');
  await f.context.readCampaignRecords();
  assert.equal(f.covers.length, 2);
});

test('simultaneous cover readers share one download and invalidation discards an old result', async () => {
  let resolveBlob;
  let lists = 0, downloads = 0;
  const c = vm.createContext({
    SAVE_CAMPAIGN_DIR: '战役', CAMPAIGN_COVER_FILES: ['封面.webp'],
    listBoundFiles: async () => {lists++; return [{name: '封面.webp', size: 1, lastModified: 1}];},
    readBoundBlob: () => {downloads++; return new Promise(resolve => {resolveBlob = resolve;});},
    readFileAsDataUrl: async () => 'old-image',
  });
  vm.runInContext('const campaignCoverCache = new Map(), campaignCoverReadJobs = new Map(), campaignCoverReadVersions = new Map();\n' +
    'let campaignCoverCacheVersion = 0;\n' +
    ['clearCampaignCoverCache', 'campaignCoverReadVersion', 'readCampaignCover', 'readCampaignCoverFile'].map(n => fn(storage, n)).join('\n'), c);
  const first = c.readCampaignCover('first');
  const duplicate = c.readCampaignCover('first');
  assert.equal(first, duplicate);
  await tick();
  assert.equal(lists, 1); assert.equal(downloads, 1);
  c.clearCampaignCoverCache('first');
  assert.equal(c.campaignCoverReadVersion('second'), '0:0');
  assert.equal(c.campaignCoverReadVersion('first'), '0:1');
  resolveBlob({});
  assert.equal(await first, null);
  assert.equal(vm.runInContext('campaignCoverCache.has("first")', c), false);
});

test('a complete index read retries a cover replaced while its old response was pending', async () => {
  const f = recordsFixture();
  let version = 'old';
  f.context.campaignCoverReadVersion = () => version;
  await f.context.readCampaignRecords(true, {covers: false});
  const pending = f.context.readCampaignRecords();
  await tick();
  version = 'new';
  for (const request of f.covers.slice()) request.resolve({fileName: 'old.webp', url: 'old'});
  await tick();
  assert.equal(f.covers.length, 4);
  for (const request of f.covers.slice(2)) request.resolve({fileName: 'new.webp', url: 'new'});
  const records = await pending;
  assert.ok(records.every(record => record.coverFile === 'new.webp'));
});

function homeFixture() {
  const make = tag => ({tag, children: [], style: {}, listeners: {}, classList: {add() {}},
    append(...nodes) {this.children.push(...nodes);}, appendChild(node) {this.children.push(node);},
    insertBefore(node, before) {this.children.splice(this.children.indexOf(before), 0, node);},
    addEventListener(name, callback) {this.listeners[name] = callback;},
  });
  const box = make('box');
  Object.defineProperty(box, 'innerHTML', {set() {this.children = [];}});
  box.contains = item => box.children.includes(item);
  let resolveCover;
  const c = vm.createContext({
    $: () => box, document: {createElement: make}, console,
    formatCampaignHomeMeta: () => 'summary', chooseCampaignCover() {}, removeCampaignCover() {},
    readCampaignCover: () => new Promise(resolve => {resolveCover = resolve;}),
    campaignCoverCacheVersion: 0,
  });
  c.campaignCoverReadVersion = () => c.campaignCoverCacheVersion;
  vm.runInContext(fn(app, 'renderCoverRecent'), c);
  return {c, box, resolve: value => resolveCover(value)};
}

test('home shows campaign controls first, then adds artwork and cover actions without rebuilding the row', async () => {
  const f = homeFixture(), record = {id: 'first', name: 'First', _folderName: 'first'};
  f.c.renderCoverRecent([record]);
  const row = f.box.children[0], button = row.children[0], actions = row.children[1];
  assert.equal(button.children[0].children[0].textContent, 'First');
  assert.equal(actions.children[0].textContent, '上传封面');
  f.resolve({fileName: '封面.webp', url: 'image'});
  await tick();
  assert.equal(f.box.children[0], row);
  assert.equal(row.children[1], button);
  assert.equal(row.children[0].src, 'image');
  assert.equal(actions.children[0].textContent, '更换封面');
  assert.equal(actions.children[1].textContent, '移除');
  assert.equal(record.coverFile, '封面.webp');
});

test('an outdated background response cannot repaint a refreshed home or undo a cover removal', async () => {
  for (const invalidate of [false, true]) {
    const f = homeFixture(), record = {id: 'first', _folderName: 'first'};
    f.c.renderCoverRecent([record]);
    const row = f.box.children[0];
    if (invalidate) f.c.campaignCoverCacheVersion++;
    else f.c.renderCoverRecent([]);
    f.resolve({fileName: '封面.webp', url: 'stale-image'});
    await tick();
    assert.equal(Object.hasOwn(record, 'coverUrl'), false);
    assert.equal(row.children.length, 2);
  }
});
