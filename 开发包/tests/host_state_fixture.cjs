// Load production CAS and queue functions without booting the whole host UI.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readClientSource} = require('./client_sources.cjs');
const source = readClientSource('主控台/host/app.js');
function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart < 0 ? source.indexOf(`function ${name}(`) : asyncStart;
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `Find production ${name}`);
  return source.slice(start, end + 2);
}
function createHostStateFixture(overrides = {}) {
  const browser = new Map(), elements = new Map(), recovery = [];
  const state = {campaignId:'c1',maps:[{id:'map-a',tokens:[{id:'token-a',hp:8}]}]};
  const context = vm.createContext({
    AbortController, Date, Promise, JSON, Number, String, Math, Map, Set, setTimeout, clearTimeout,
    window:{}, globalThis:{}, state,
    hostStateRevision:7, hostStateSessionId:'session-1', hostStateConflict:null,
    hostStateReadPromise:null, hostStateWriteQueue:Promise.resolve(), hostStatePostPending:false,
    hostStatePendingActions:[], streamServerSessionId:'session-1', streamAppliedSeq:0,
    streamOn:true, streamPushing:false, streamDirty:true, streamLastPushAt:0,
    streamFailToastAt:0, streamConnectionState:'online', streamMapAssetCache:new WeakMap(),
    campaignLoadInProgress:false, autosaveTimer:null,
    STORAGE_KEY:'test-state', localStorage:{setItem:(key,value)=>browser.set(key,value),getItem:key=>browser.get(key)},
    $:id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:''});return elements.get(id);},
    folderSaveSnapshot:()=>JSON.parse(JSON.stringify(state)),
    writeRecoverySnapshot:async(label,snapshot)=>{recovery.push({label,snapshot});return true;},
    updateSaveStatus(){}, updateStreamUi(){}, toast(){},
    presentedMap:()=>null, buildStreamPayload:()=>({campaignId:state.campaignId,maps:state.maps}),
    serverApiBase:()=>'', renderTokens(){}, updateDetail(){}, scheduleAutosave(){},
    ...overrides,
  });
  for (const name of [
    'hostStateGuardFields','keepHostConflictDraft','pauseHostStateSync','ensureHostStateBaseline',
    'enqueueHostStateWrite','acknowledgeHostStateWrite','applyHostStateEvent','receiveHostStateEvent',
    'beginHostStateCommit','endHostStateCommit','applyHostStateAction','receiveHostStateAction',
    'drainHostStateActions','streamPush','streamTick',
  ]) vm.runInContext(functionSource(name),context);
  return {context,browser,elements,recovery};
}
module.exports = {createHostStateFixture};
