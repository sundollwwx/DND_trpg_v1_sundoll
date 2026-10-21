const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const app=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const storage=fs.readFileSync(path.join(APP_ROOT,'主控台/host/storage.js'),'utf8');
const oldHash='a'.repeat(64),newHash='b'.repeat(64),otherHash='c'.repeat(64);

function fn(source,name){
 const start=source.indexOf(`async function ${name}(`)>=0?source.indexOf(`async function ${name}(`):source.indexOf(`function ${name}(`);
 assert.notEqual(start,-1,`missing ${name}`);
 return source.slice(start,source.indexOf('\n}',start)+2);
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function campaign(id='c1'){return {campaignId:id,campaignName:'temporary',maps:[],mapChapters:[],mapLocations:[]};}
function fixture(options={}){
 const calls=[],hashes=new Map(options.hashes??[['c1',oldHash]]),state=campaign();
 const context=vm.createContext({Date,JSON,Number,String,Map,Set,console:{warn(){}},
  state,campaignLoadedHashes:hashes,streamDirty:false,campaignRecordsCache:[],SAVE_CAMPAIGN_DIR:'战役',
  ensureSaveFolderAccess:async()=>true,safeCampaignId:id=>id,campaignFolderName:id=>id,
  campaignGet:async id=>({_folderName:id,_path:`战役/${id}/当前存档.json`}),
  readBoundText:async()=>options.readText??JSON.stringify({campaignId:'c1',state:campaign(),savedAt:1}),
  usingLocalSaveBridge:()=>true,
  localSaveApiRequest:async(op,data)=>{
   calls.push({op,data});
   if(op==='read-campaign'){
    if(options.readError)throw options.readError;
    return {text:options.readText??JSON.stringify({campaignId:'c1',state:campaign(),savedAt:1}),sourceHash:oldHash};
   }
   if(options.writeError)throw options.writeError;
   if(options.pendingWrite)return options.pendingWrite.promise;
   return {hash:newHash,stateRevision:(context.hostStateRevision??7)+1,sessionId:'session-1'};
  },
  campaignTextHash:async()=>{throw new Error('bridge must use its actual source hash');},
  campaignPackage:(id,name,snapshot,savedAt)=>({campaignId:id,campaignName:name,state:snapshot,savedAt}),
  campaignRecordSummary:data=>({state:{campaignId:data.state.campaignId}}),
  trimAutomaticBackups:async()=>{},writeSaveIndex:async()=>{if(options.indexError)throw options.indexError;},
  campaignLoadInProgress:false,autosaveTimer:null,folderSaveQueue:Promise.resolve(true),
  flushDetailTextSave(){},folderSaveSnapshot:()=>campaign(),writeRecoverySnapshot:async()=>{},
  parseCampaignFile:text=>{const data=JSON.parse(text);return {...data,id:data.campaignId};},
  applySavedState:next=>{for(const key of Object.keys(state))delete state[key];Object.assign(state,next);return true;},
  applyAllState(){},loadLinks(){},renderLinks(){},cacheLoadedStateInBrowser:()=>({ok:true}),
  rememberCampaignSelection:async()=>{},updateSaveStatus(){},toast(){},confirm:()=>true,
  clearTimeout(){},scheduleAutosave(){},
  ensureMapNavigation(){},presentedMap:()=>null,publicStreamMap:map=>({...map}),publicStreamToken:token=>({...token}),
  mapGridVisible:()=>false,publicEncounterState:()=>({}),cachedStreamMapAssetUrl:()=>'',userLinks:[],
  CampaignJournal:{normalize:()=>({})},hostMusic:{snapshot:()=>null},SundollProtocol:{version:1},
  mapPresentationId:null,streamAppliedSeq:0,
 });
 for(const name of ['loadFolderSave','writeCurrentCampaign','writeCampaignRecord'])vm.runInContext(fn(storage,name),context);
 vm.runInContext(fn(app,'buildStreamPayload'),context);
 return {context,calls,state,hashes,payload:()=>context.buildStreamPayload(),save:(id='c1')=>context.writeCampaignRecord(id,'temporary',campaign(id))};
}

test('actual formal read publishes its returned source hash without a new hash lookup',async()=>{
 const f=fixture({hashes:[]});
 assert.equal(await f.context.loadFolderSave({path:'战役/c1/当前存档.json',name:'temporary'},false),true);
 assert.equal(f.payload()._formalSourceHash,oldHash);
 assert.deepEqual(f.calls.map(call=>call.op),['read-campaign']);
 assert.equal(f.context.streamDirty,true);
});

test('acknowledged formal save advances lineage and queues another publish',async()=>{
 const f=fixture(),publishedBeforeSave=f.payload();
 await f.save();
 assert.equal(f.calls[0].data.expectedHash,oldHash);
 assert.equal(f.payload()._formalSourceHash,newHash);
 assert.equal(publishedBeforeSave._formalSourceHash,oldHash,'an already captured payload is unchanged');
 assert.equal(f.context.streamDirty,true,'the acknowledged hash will be sent even after an earlier publish cleared dirty');
 assert.deepEqual(f.calls.map(call=>call.op),['write-campaign']);
});

test('formal writes wait for an in-flight publish, then publish their new acknowledged lineage',async()=>{
 const f=fixture(),uploads=[],first=deferred(),second=deferred();
 Object.assign(f.context,{AbortController,setTimeout,clearTimeout,streamOn:true,streamPushing:false,
  streamLastPushAt:0,streamFailToastAt:0,streamConnectionState:'online',streamMapAssetCache:new WeakMap(),
  hostStateConflict:null,hostStateRevision:7,hostStateSessionId:'session-1',hostStateWriteQueue:Promise.resolve(),hostStatePostPending:false,hostStatePendingActions:[],hostEditGeneration:0,
  serverApiBase:()=>'',updateStreamUi(){},folderSaveSnapshot:()=>campaign(),fetch:async(_url,options)=>{
   uploads.push(JSON.parse(options.body));return uploads.length===1?first.promise:second.promise;
  }});
 for(const name of ['hostStateGuardFields','ensureHostStateBaseline','enqueueHostStateWrite','acknowledgeHostStateWrite','applyHostStateEvent','receiveHostStateEvent','beginHostStateCommit','endHostStateCommit','applyHostStateAction','receiveHostStateAction','drainHostStateActions','streamPush','streamTick'])vm.runInContext(fn(app,name),f.context);
 const publishing=f.context.streamPush();await new Promise(setImmediate);
 assert.equal(uploads[0]._formalSourceHash,oldHash);
 assert.equal(f.context.streamDirty,false);
 const saving=f.save();await new Promise(setImmediate);assert.equal(f.calls.length,0,'formal write must wait for the live acknowledgement');
 first.resolve({ok:true,json:async()=>({ok:true,stateRevision:8,sessionId:'session-1'})});await publishing;await saving;
 assert.equal(f.context.streamDirty,true,'the acknowledged formal hash remains queued for publication');
 f.context.streamLastPushAt=0;f.context.streamTick();await new Promise(setImmediate);
 assert.equal(uploads[1]._formalSourceHash,newHash);assert.equal(uploads[1].expectedStateRevision,9);
 second.resolve({ok:true,json:async()=>({ok:true,stateRevision:10,sessionId:'session-1'})});
 await new Promise(setImmediate);assert.equal(f.context.streamPushing,false);
});

for(const [label,message] of [['conflict','正式存档已更新'],['failed','写入结果未确认']])test(`${label} save never advances lineage or queues a new marker`,async()=>{
 const f=fixture({writeError:new Error(message)});
 await assert.rejects(f.save(),new RegExp(message));
 assert.equal(f.hashes.get('c1'),oldHash);
 assert.equal(f.payload()._formalSourceHash,oldHash);
 assert.equal(f.context.streamDirty,false);
});

test('save of a different campaign updates only its hash and does not dirty current campaign',async()=>{
 const f=fixture({hashes:[['c1',oldHash],['c2',otherHash]]});
 await f.save('c2');
 assert.equal(f.hashes.get('c2'),newHash);
 assert.equal(f.payload()._formalSourceHash,oldHash);
 assert.equal(f.context.streamDirty,false);
});

test('late save acknowledgement cannot attach the old campaign hash to the new campaign',async()=>{
 const pendingWrite=deferred(),f=fixture({pendingWrite,hashes:[['c1',oldHash],['c2',otherHash]]});
 const saving=f.save();
 while(!f.calls.length)await Promise.resolve();
 Object.assign(f.state,campaign('c2'));
 pendingWrite.resolve({hash:newHash});await saving;
 assert.equal(f.hashes.get('c1'),newHash);
 assert.equal(f.payload()._formalSourceHash,otherHash);
 assert.equal(f.context.streamDirty,false);
});

test('legacy state marker is ignored when no formal read or save has established a hash',()=>{
 const f=fixture({hashes:[]});f.state._formalSourceHash=oldHash;
 assert.equal(Object.hasOwn(f.payload(),'_formalSourceHash'),false);
});

test('missing or invalid hash cannot manufacture formal lineage',()=>{
 const f=fixture();
 for(const value of [undefined,null,'','not-a-sha256',42]){
  f.hashes.set('c1',value);
  assert.equal(Object.hasOwn(f.payload(),'_formalSourceHash'),false);
 }
});

test('old runtime without a hash map still publishes without a fabricated marker',()=>{
 const f=fixture();delete f.context.campaignLoadedHashes;
 assert.equal(Object.hasOwn(f.payload(),'_formalSourceHash'),false);
});

test('failed formal read leaves the prior campaign lineage unchanged',async()=>{
 const f=fixture({readError:new Error('read failed')});
 assert.equal(await f.context.loadFolderSave({path:'战役/c2/当前存档.json',name:'temporary'},false),false);
 assert.equal(f.payload()._formalSourceHash,oldHash);
 assert.equal(f.hashes.has('c2'),false);
 assert.equal(f.context.streamDirty,false);
});

test('a later index failure cannot hide the acknowledged formal write from publication',async()=>{
 const f=fixture({indexError:new Error('index failed')});
 const result=await f.save();
 assert.match(result.indexWarning,/index failed/);
 assert.equal(f.payload()._formalSourceHash,newHash);
 assert.equal(f.context.streamDirty,true);
});
