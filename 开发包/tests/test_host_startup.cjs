const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = require('./project_paths.cjs').APP_ROOT;
const read = name => fs.readFileSync(path.join(root, '主控台/host', name), 'utf8');
const app = read('app.js'), storage = read('storage.js');
const cut = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('HTTP bootstrap displays the catalog without restoring a board, library or stream', async () => {
  const calls = [];
  const elem = {classList:{add(){},remove(){}}, textContent:''};
  const context = {console, Promise, location:{protocol:'https:'},hostCampaignDeferred:true, hdEnabled:true, $:()=>elem,
    SundollHostLoading:{create:()=>null,mount(){}},
    updateSaveStatus:message=>calls.push(message), state:{library:[]}, localStorage:{getItem:()=>null,setItem(){}}, window:{addEventListener(){}},
    document:{addEventListener(){},querySelector:()=>elem,querySelectorAll:()=>[]},
    hostDocuments:{init(){},ensureCampaign(){}},hostPrep:{init(){}},
    hostMusic:{loadProjectMusicLibrary(){calls.push('music');}},
    refreshHostHome:async()=>{calls.push('catalog');},
    loadSaved:()=>{calls.push('cache');},loadLibrary:()=>{calls.push('library');return [];},
    loadProjectDirHandle:async()=>{calls.push('status');},
    restoreStreamFromStorage:async()=>{calls.push('stream');},
    loadHostStreamAccountConfig:async()=>true,
    syncLibraryWithFolder:()=>new Promise(()=>{}),
    setTimeout(){},setInterval(){},clearInterval(){},encounterClockTimer:null,APP_VERSION:'test',
    ItemLibrary:{configure(){}},PlayerBackpack:{configure(){}},PlayerLibrary:{configure(){}},MapItems:{configure(){}},
    placeOwnedPiece(){},bindSelectedOwnedPiece(){},world:{},board:{},toast(){},
  };
  for(const name of ['preloadConditionPixels','bindEvents','syncHdUi','updateStreamUi','setUnitSource','renderLibrary','loadLinks','renderLinks','initWorkspaceTabs','initMapQuickTools','syncActiveMapGridSetting','renderEncounter','initHostDiceLoading','updateCoverContinue'])context[name]=()=>{};
  vm.runInNewContext(read('bootstrap.js'),context);
  await new Promise(setImmediate);
  assert.deepEqual(calls,['catalog']);
});

function entryFixture({failRead=false,failLibrary=false}={}) {
  const calls=[];
  const context=vm.createContext({location:{protocol:'https:'},state:{campaignId:null},campaignLoadInProgress:false,
    campaignGet:async()=>({id:'c1',name:'formal',_path:'save'}),
    syncLibraryWithFolder:async()=>{calls.push('library');return !failLibrary;},
    loadSaved(){calls.push('cache');},loadLibraryRecentIds:()=>[],
    loadFolderSave:async()=>{calls.push('read');return !failRead;},
    setCoverFeedback(){},toast(){},updateCoverContinue(){},closeCampaignModal(){},
    hideCover(){calls.push('enter');},hostMusic:{loadProjectMusicLibrary(){calls.push('music');}},
    restoreStreamFromStorage:async()=>{calls.push('stream');},prewarmAvatarCache(){},
  });
  vm.runInContext(cut(app,'let hostCampaignDeferred','let coverRefreshSerial')+'\n'+cut(app,'async function openCampaign(id)','function hideCover()'),context);
  return {calls,context,run:code=>vm.runInContext(code,context)};
}
test('entering reads formal data before revealing the board or restoring sync',async()=>{
  const f=entryFixture();assert.equal(await f.run("openCampaign('c1')"),true);
  assert.deepEqual(f.calls,['library','cache','read','enter','music','stream']);
  assert.equal(f.run('hostCampaignDeferred'),false);
});
test('failed campaign read keeps the home open and never publishes cached state; retry works',async()=>{
  const f=entryFixture({failRead:true});assert.equal(await f.run("openCampaign('c1')"),false);
  assert.equal(f.run('hostCampaignDeferred'),true);assert.ok(!f.calls.includes('stream'));assert.ok(!f.calls.includes('enter'));
  f.context.loadFolderSave=async()=>true;
  assert.equal(await f.run("openCampaign('c1')"),true);assert.ok(f.calls.includes('stream'));
});
test('a failed library read can be retried and does not load browser cache',async()=>{
  const f=entryFixture({failLibrary:true});assert.equal(await f.run("openCampaign('c1')"),false);
  assert.deepEqual(f.calls,['library']);f.context.syncLibraryWithFolder=async()=>true;
  assert.equal(await f.run("openCampaign('c1')"),true);
});

function requestFixture(){
  const timers=[];let finish;const c=vm.createContext({AbortController,Promise,JSON,
    LOCAL_SAVE_API_PATH:'/api/local-save',LOCAL_SAVE_API_HEADER:'X-Sundoll-Local-Save',loadedCatalogHash:'original',
    setTimeout:fn=>{timers.push(fn);return 1;},clearTimeout(){},
    fetch:()=>new Promise(resolve=>{finish=resolve;}),
  });vm.runInContext(cut(storage,'async function localSaveApiRequest','async function loadProjectDirHandle'),c);
  return {c,timers,run:code=>vm.runInContext(code,c),finish:response=>finish(response)};
}
test('read timeout covers the response body and ignores a late catalog hash',async()=>{
  const f=requestFixture();let body;
  const request=f.run("localSaveApiRequest('read',{path:'棋子库/棋子库.json'})");
  f.finish({ok:true,json:()=>new Promise(resolve=>{body=resolve;})});await new Promise(setImmediate);
  f.timers[0]();await assert.rejects(request,/读取超时/);
  body({ok:true,catalogHash:'late'});await new Promise(setImmediate);
  assert.equal(f.c.loadedCatalogHash,'original');
});
test('writes have their own bounded deadline and are never automatically retried',async()=>{
  const f=requestFixture();const request=f.run("localSaveApiRequest('write',{path:'棋子库/棋子库.json'})");
  assert.equal(f.timers.length,1);f.finish({ok:true,json:async()=>({ok:true,catalogHash:'saved'})});
  await request;assert.equal(f.c.loadedCatalogHash,'saved');
});
test('saving a deferred recovery cache is blocked before any persistence operation',()=>{
  const c=vm.createContext({hostCampaignDeferred:true});
  vm.runInContext(cut(storage,'function saveNow(options','async function saveNowWithFeedback'),c);
  assert.equal(vm.runInContext('saveNow()',c),false);
});

test('an early HTTP action resolves the server workspace instead of a browser directory',async()=>{
  const calls=[];
  const c=vm.createContext({location:{protocol:'https:'},projectDirHandle:null,localSaveApiAvailable:false,
    loadProjectDirHandle:async()=>{calls.push('server');c.projectDirHandle={};},usingLocalSaveBridge:()=>Boolean(c.projectDirHandle),
    localSaveApiRequest:async()=>{},bindProjectFolder:()=>{throw Error('must not prompt for directory');}});
  vm.runInContext(cut(storage,'async function ensureSaveFolderAccess','async function bindProjectFolder'),c);
  assert.equal(await vm.runInContext('ensureSaveFolderAccess(true)',c),true);
  assert.deepEqual(calls,['server']);
});
test('failed early HTTP connection never falls back to an unrelated folder',async()=>{
  const c=vm.createContext({location:{protocol:'https:'},projectDirHandle:null,
    loadProjectDirHandle:async()=>{throw Error('timeout');},updateSaveStatus(){},
    bindProjectFolder:()=>{throw Error('must not prompt for directory');}});
  vm.runInContext(cut(storage,'async function ensureSaveFolderAccess','async function bindProjectFolder'),c);
  assert.equal(await vm.runInContext('ensureSaveFolderAccess(true)',c),false);
});
