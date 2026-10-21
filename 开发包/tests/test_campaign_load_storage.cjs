const {readClientSource}=require('./client_sources.cjs');
// Run with node --test tests/test_campaign_load_storage.cjs.
// Exercises the real campaign-load cache handling with a storage quota failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = require('./project_paths.cjs').APP_ROOT;
const source = readClientSource(path.join(root, '主控台/host/app.js'), 'utf8');
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
    _path: '战役/test/当前存档.json',
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
    usingLocalSaveBridge: () => Boolean(options.compact),
    localSaveApiRequest: async () => ({ text: JSON.stringify({state:targetState,savedAt:record.savedAt}), sourceHash:'original-disk-hash' }),
    campaignTextHash: async () => 'test-hash',
    campaignLoadedHashes: new Map(),
    STORAGE_KEY: 'dnd-board-state-v1',
    SAVE_INDEX_FILE: '存档索引.json',
    rememberCampaignSelection: async () => {},
    state,
    streamDirty: false,
    campaignLoadInProgress: false,
    autosaveTimer: null,
    clearTimeout() {},
    flushDetailTextSave() {},
    folderSaveQueue: Promise.resolve(true),
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
    readBoundText: async (file) => file === '存档索引.json' ? JSON.stringify(options.diskIndex || {lastCampaignId: targetState.campaignId}) : JSON.stringify({ state: targetState, savedAt: record.savedAt }),
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
    readCampaignRecords: async () => [record],
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

test('continue restores last campaign even when full browser cache belongs to an older campaign', async () => {
  const f = fixture({
    initialState: {campaignId:'old', maps:[]},
    storage: [['dnd-board-last-campaign-id','c184'], ['dnd-board-state-v1','old-cache']],
  });
  await f.run('restoreFolderIfAvailable()');
  assert.equal(f.state.campaignId, 'c184');
  assert.equal(f.quotaErrors(), 1);
  assert.match(f.statuses.at(-1).message, /已读取 大型战役/);
});

test('disk last campaign wins over obsolete browser selection', async () => {
  const f = fixture({initialState:{campaignId:'old',maps:[]},storage:[['dnd-board-last-campaign-id','old']],diskIndex:{lastCampaignId:'c184'}});
  await f.run('restoreFolderIfAvailable()');
  assert.equal(f.state.campaignId,'c184');
});

test('fresh browser can restore most recent formal campaign', async () => {
  const f = fixture();
  await f.run('restoreFolderIfAvailable()');
  assert.equal(f.state.campaignId, 'c184');
});

test('applying loaded state refreshes world clock and continue card', () => {
  const body = source.slice(source.indexOf('function applyAllState()'), source.indexOf('function applyActiveMap()'));
  assert.match(body, /renderEncounter\(\)/);
  assert.match(body, /updateCoverContinue\(\)/);
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
    message: '已读取 大型战役 · 浏览器恢复缓存已满',
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
  assert.equal(f.recoveryWrites(), 1);
  assert.equal(f.quotaErrors(), 1);
  assert.match(f.statuses.at(-1).message, /^已读取 大型战役 · 浏览器恢复缓存已满$/);
  assert.equal(f.statuses.at(-1).kind, 'error');
  assert.match(f.toasts.at(-1), /正式文件仍可使用/);
});


test('loading uses original save timestamp, never the time it was opened', async () => {
  const f = fixture({targetState:{campaignId:'c184', maps:[]}, savedAt:123});
  await f.run("loadFolderSave({name:'test',path:'test'}, false)");
  assert.equal(f.context.localStorage.getItem('dnd-board-local-save-at'), '123');
});

test('apparently newer browser cache is backed up then formal state is restored without overwriting disk', async () => {
  const f = fixture({initialState:{campaignId:'c184', maps:[{id:'old'}]},
    storage:[['dnd-board-local-save-at', String(Date.now())]]});
  f.context.queueCurrentFolderSave = () => {throw Error('must not overwrite formal save');};
  await f.run('restoreFolderIfAvailable()');
  assert.equal(f.state.maps[0].id, 'm1');
  assert.equal(f.recoveryWrites(), 1);
});

test('overlapping load is rejected and load lock is released after failure', async () => {
  const f = fixture();
  let release;
  f.context.folderSaveQueue = new Promise(resolve => {release=resolve;});
  const first = f.run("loadFolderSave({name:'first',path:'first'}, false)");
  assert.equal(await f.run("loadFolderSave({name:'second',path:'second'}, false)"), false);
  f.context.readBoundText = async () => {throw Error('文件读取中断');};
  release();
  assert.equal(await first,false);
  assert.equal(f.context.campaignLoadInProgress,false);
  assert.match(f.toasts.at(-1), /文件读取中断/);
});

test('index write failure does not report an already loaded campaign as failed', async () => {
  const f = fixture();
  f.context.rememberCampaignSelection = async () => {throw Error('索引不可写');};
  assert.equal(await f.run("loadFolderSave({name:'test',path:'test'}, false)"),true);
  assert.equal(f.state.campaignId,'c184');
  assert.ok(f.toasts.some(t=>t.includes('索引不可写')));
});


test('failed read restores an autosave timer that fired during loading', async () => {
  const f=fixture();let scheduled=0;
  f.context.autosaveTimer=1;
  f.context.scheduleAutosave=()=>{scheduled++;};
  f.context.readBoundText=async()=>{f.context.autosaveTimer=null;throw Error('读取失败');};
  assert.equal(await f.run("loadFolderSave({name:'test',path:'test'}, false)"),false);
  assert.equal(scheduled,1);
});
test('recovery backup failure leaves existing campaign open', async () => {
  const f=fixture({initialState:{campaignId:'old',maps:[{id:'old-map'}]}});
  f.context.writeRecoverySnapshot=async()=>{throw Error('恢复点写入失败');};
  assert.equal(await f.run("loadFolderSave({name:'test',path:'test'}, false)"),false);
  assert.equal(f.state.campaignId,'old');assert.equal(f.state.maps[0].id,'old-map');
});


test('missing last campaign does not silently open a different campaign', async () => {
  const f=fixture({initialState:{campaignId:'missing',maps:[]},diskIndex:{lastCampaignId:'missing'}});
  assert.equal(await f.run('restoreFolderIfAvailable()'),false);
  assert.equal(f.state.campaignId,'missing');assert.equal(f.recoveryWrites(),0);
  assert.match(f.statuses.at(-1).message,/上次战役未找到/);
});

test('compact server reads retain original disk hash for the next CAS save', async () => {
  const f=fixture({compact:true,targetState:{campaignId:'compact',maps:[{id:'m',mapData:'/api/module-assets/'+'a'.repeat(64)}]}});
  assert.equal(await f.run("loadFolderSave({name:'模块地图',path:'战役/c/当前存档.json'}, false)"),true);
  assert.equal(f.run("campaignLoadedHashes.get('compact')"),'original-disk-hash');
});
