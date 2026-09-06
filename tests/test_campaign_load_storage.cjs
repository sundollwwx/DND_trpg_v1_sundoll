// Run with node --test tests/test_campaign_load_storage.cjs.
// Exercises the real campaign-load cache handling with a storage quota failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '主控台/app.js'), 'utf8');
const cacheSource = source.slice(
  source.indexOf('function browserStorageIssue'),
  source.indexOf('function normalizeServerBase'),
);
const loadSource = source.slice(
  source.indexOf('async function loadFolderSave'),
  source.indexOf('function scheduleAutosave'),
);

function largeCampaignState(id = 'c184', name = '大型战役') {
  return {
    campaignId: id,
    campaignName: name,
    maps: [{ id: 'm1', name: '大型地图', mapData: 'A'.repeat(6 * 1024 * 1024), tokens: [] }],
    activeMapId: 'm1',
    sharedResources: [],
  };
}

function fixture(options = {}) {
  const storage = new Map(options.storage || []);
  const statuses = [];
  const toasts = [];
  const warnings = [];
  let quotaErrors = 0;
  let recoveryWrites = 0;
  const targetState = options.targetState || largeCampaignState();
  const state = options.initialState || { campaignId: null, campaignName: '', maps: [] };
  const record = {
    id: targetState.campaignId,
    name: targetState.campaignName,
    savedAt: options.savedAt || 3000,
    state: targetState,
  };
  const localStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) {
      const text = String(value);
      if (key === 'dnd-board-state-v1' && Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) {
        quotaErrors++;
        const error = new Error('simulated localStorage quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      storage.set(key, text);
    },
  };
  const context = vm.createContext({
    STORAGE_KEY: 'dnd-board-state-v1',
    state,
    streamDirty: false,
    browserStateCacheFailed: false,
    projectDirHandle: options.projectDirHandle ?? {},
    localStorage,
    JSON,
    Date,
    String,
    console: { warn: (...args) => warnings.push(args) },
    confirm: () => true,
    toast: (message) => toasts.push(message),
    updateSaveStatus: (message, kind) => statuses.push({ message, kind }),
    readBoundText: async () => JSON.stringify({ state: targetState }),
    parseCampaignFile: (text) => JSON.parse(text),
    folderSaveSnapshot: () => JSON.parse(JSON.stringify(state)),
    writeRecoverySnapshot: async () => { recoveryWrites++; return true; },
    applySavedState: (next) => {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, JSON.parse(JSON.stringify(next)));
      return true;
    },
    applyAllState() {},
    loadLinks() {},
    renderLinks() {},
    stateStorageJson: () => JSON.stringify(state),
    hasSaveFolderPermission: async () => true,
    campaignGet: async () => record,
    queueCurrentFolderSave: async () => true,
  });
  vm.runInContext(cacheSource + '\n' + loadSource, context);
  return {
    context,
    state,
    statuses,
    toasts,
    warnings,
    quotaErrors: () => quotaErrors,
    recoveryWrites: () => recoveryWrites,
    run: (code) => vm.runInContext(code, context),
  };
}

test('a large formal campaign still loads when localStorage exceeds quota', async () => {
  const f = fixture({ projectDirHandle: {} });
  const loaded = await f.run("loadFolderSave({name:'大型战役',path:'战役/c184/当前存档.json'}, false)");

  assert.equal(loaded, true);
  assert.equal(f.state.campaignId, 'c184');
  assert.equal(f.state.maps[0].mapData.length, 6 * 1024 * 1024);
  assert.equal(f.quotaErrors(), 1);
  assert.equal(f.run('browserStateCacheFailed'), true);
  assert.equal(f.run('streamDirty'), true);
  assert.deepEqual(f.statuses.at(-1), {
    message: '已读取 大型战役 · 浏览器恢复缓存已满',
    kind: 'error',
  });
  assert.match(f.toasts.at(-1), /正式文件仍可使用/);
  assert.doesNotMatch(f.toasts.at(-1), /读取存档失败/);
  assert.equal(f.warnings.length, 1);
});

test('newer-folder restore also survives localStorage quota failure', async () => {
  const f = fixture({
    initialState: { campaignId: 'old', campaignName: '旧战役', maps: [{ id: 'old-map', tokens: [] }] },
    storage: [
      ['dnd-board-state-v1', '{"campaignId":"old"}'],
      ['dnd-board-local-save-at', '1000'],
    ],
    savedAt: 3000,
  });

  await f.run('restoreFolderIfAvailable()');

  assert.equal(f.state.campaignId, 'c184');
  assert.equal(f.recoveryWrites(), 1);
  assert.equal(f.quotaErrors(), 1);
  assert.deepEqual(f.statuses.at(-1), {
    message: '已读取文件夹存档 · 浏览器恢复缓存已满',
    kind: 'error',
  });
  assert.match(f.toasts.at(-1), /正式文件仍可使用/);
  assert.equal(f.warnings.length, 1);
});

test('folder restore without a browser snapshot reports cache degradation but keeps the formal state', async () => {
  const f = fixture({
    initialState: { campaignId: 'c184', campaignName: '大型战役', maps: [] },
    storage: [],
  });

  await f.run('restoreFolderIfAvailable()');

  assert.equal(f.state.maps[0].mapData.length, 6 * 1024 * 1024);
  assert.equal(f.recoveryWrites(), 0);
  assert.equal(f.quotaErrors(), 1);
  assert.match(f.statuses.at(-1).message, /^已从文件夹恢复 .*浏览器恢复缓存已满$/);
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.match(f.toasts.at(-1), /正式文件仍可使用/);
});
