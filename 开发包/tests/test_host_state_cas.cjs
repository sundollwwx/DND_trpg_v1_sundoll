const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const app=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const storage=fs.readFileSync(path.join(APP_ROOT,'主控台/host/storage.js'),'utf8');
function fn(source,name){const a=source.indexOf(`async function ${name}(`),b=source.indexOf(`function ${name}(`),start=a<0?b:a;assert.notEqual(start,-1,name);return source.slice(start,source.indexOf('\n}',start)+2);}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function fixture(options={}){
 const requests=[],statuses=[],browser=new Map(),elements=new Map();
 const state={campaignId:'c1',campaignName:'测试',maps:[{id:'m1',tokens:[{id:'t1',hp:8}]}]};
 const context=vm.createContext({Promise,JSON,Number,String,Date,Math,Map,Set,AbortController,setTimeout,clearTimeout,
  console:{warn(){}},window:options.room?{SundollRoom:{id:'r1'}}:{},globalThis:{},
  state,hostStateRevision:options.unbased?null:7,hostStateSessionId:options.unbased?'':'session-1',hostStateConflict:null,hostStateReadPromise:null,hostStateWriteQueue:Promise.resolve(),hostStatePostPending:false,hostStatePendingActions:[],hostEditGeneration:0,
  streamOn:true,streamPushing:false,streamDirty:true,streamAppliedSeq:0,streamServerSessionId:'session-1',streamLastPushAt:0,streamFailToastAt:0,streamConnectionState:'online',streamMapAssetCache:new WeakMap(),campaignLoadInProgress:false,autosaveTimer:null,
  STORAGE_KEY:'test-state',localStorage:{setItem:(key,value)=>browser.set(key,value),getItem:key=>browser.get(key)},
  $:id=>{if(!elements.has(id))elements.set(id,{hidden:true,textContent:'',dataset:{}});return elements.get(id);},
  updateSaveStatus:(text,kind)=>statuses.push({text,kind}),updateStreamUi(){},toast(){},writeRecoverySnapshot:async()=>true,
  folderSaveSnapshot:()=>JSON.parse(JSON.stringify(state)),buildStreamPayload:()=>({campaignId:state.campaignId,maps:state.maps}),presentedMap:()=>null,renderTokens(){},updateDetail(){},scheduleAutosave(){},
  serverApiBase:()=>'',hostStreamAccountConfig:{roomsEnabled:false},
  SundollClientRuntime:{requestJson:async()=>({response:{ok:true},data:{stateRevision:0,sessionId:'session-1',stateAuthority:{published:!!options.published}}})},
  fetch:async(url,args)=>{const body=JSON.parse(args.body);requests.push({url,body});return options.reply?options.reply(requests.length,body):{ok:true,json:async()=>({ok:true,stateRevision:body.expectedStateRevision+1,sessionId:body.serverSessionId})};},
 });
 for(const name of ['hostStateGuardFields','keepHostConflictDraft','pauseHostStateSync','ensureHostStateBaseline','enqueueHostStateWrite','acknowledgeHostStateWrite','applyHostStateEvent','receiveHostStateEvent','beginHostStateCommit','endHostStateCommit','applyHostStateAction','receiveHostStateAction','drainHostStateActions','streamPush','streamTick'])vm.runInContext(fn(app,name),context);
 return {c:context,requests,statuses,browser,elements,state};
}
test('each DM publish uses its frozen revision and session, then advances only on acknowledgement',async()=>{
 const f=fixture();assert.equal(await f.c.streamPush(),true);f.c.streamDirty=true;assert.equal(await f.c.streamPush(),true);
 assert.deepEqual(f.requests.map(r=>[r.body.expectedStateRevision,r.body.serverSessionId]),[[7,'session-1'],[8,'session-1']]);assert.equal(f.c.hostStateRevision,9);
});
test('409 preserves the local draft and stops automatic and explicit old-snapshot retries',async()=>{
 const f=fixture({reply:()=>({ok:false,status:409,json:async()=>({ok:false,error:'另一个 DM 已更新',errorCode:'state-conflict',stateRevision:8,sessionId:'session-1'})})});
 await f.c.streamPush();f.c.streamDirty=true;f.c.streamTick();await f.c.streamPush();
 assert.equal(f.requests.length,1);assert.equal(f.c.hostStateRevision,7);assert.equal(f.c.hostStateConflict.errorCode,'state-conflict');assert.equal(f.state.maps[0].tokens[0].hp,8);assert.ok(f.browser.has('test-state:conflict-draft'));assert.equal(f.elements.get('#host-save-conflict').hidden,false);
});
test('a lost publish acknowledgement is preserved and paused rather than blindly repeated',async()=>{
 const f=fixture({reply:()=>{throw new TypeError('connection lost');}});await f.c.streamPush();f.c.streamDirty=true;f.c.streamTick();
 assert.equal(f.requests.length,1);assert.equal(f.c.hostStateConflict.errorCode,'state-result-unknown');assert.ok(f.browser.has('test-state:conflict-draft'));
});
test('an existing room snapshot cannot become the baseline of a newly opened stale formal page',async()=>{
 const f=fixture({room:true,unbased:true,published:true});assert.equal(await f.c.streamPush(),false);assert.equal(f.requests.length,0);assert.equal(f.c.hostStateRevision,null);assert.equal(f.c.hostStateConflict.errorCode,'state-baseline-required');
});
test('an existing local workspace snapshot also requires deliberate takeover',async()=>{
 const f=fixture({unbased:true,published:true});assert.equal(await f.c.streamPush(),false);assert.equal(f.requests.length,0);assert.equal(f.c.hostStateRevision,null);assert.equal(f.c.hostStateConflict.errorCode,'state-baseline-required');
});
test('an empty room establishes its first version before publishing',async()=>{
 const f=fixture({room:true,unbased:true});assert.equal(await f.c.streamPush(),true);assert.equal(f.requests[0].body.expectedStateRevision,0);assert.equal(f.requests[0].body.serverSessionId,'session-1');
});
test('a late own acknowledgement cannot roll back a newer fully applied action revision',()=>{
 const f=fixture();f.c.hostStateRevision=10;assert.equal(f.c.acknowledgeHostStateWrite({stateRevision:8,sessionId:'session-1'},{expectedStateRevision:7,serverSessionId:'session-1'}),true);assert.equal(f.c.hostStateRevision,10);
});
test('queued writes remain serial and a conflict prevents the next queued operation',async()=>{
 const f=fixture(),first=deferred(),calls=[];const one=f.c.enqueueHostStateWrite(async()=>{calls.push(1);await first.promise;});const two=f.c.enqueueHostStateWrite(async()=>{calls.push(2);});
 await new Promise(setImmediate);assert.deepEqual(calls,[1]);f.c.pauseHostStateSync('冲突');first.resolve();await one;await assert.rejects(two,/同步已暂停/);assert.deepEqual(calls,[1]);
});
test('the first edit marks formal save pending and further edits do not postpone its window',()=>{
 const f=fixture();let timers=0;f.c.setTimeout=()=>++timers;f.c.AUTOSAVE_INTERVAL_MS=60000;vm.runInContext(fn(storage,'scheduleAutosave'),f.c);f.c.scheduleAutosave();f.c.scheduleAutosave();assert.equal(timers,1);assert.equal(f.c.hostEditGeneration,2);assert.equal(f.statuses.at(-1).kind,'pending');
});
test('edits during a conflict remain a draft without scheduling formal persistence',()=>{
 const f=fixture();f.c.pauseHostStateSync('冲突');f.c.setTimeout=()=>{throw new Error('must not autosave');};vm.runInContext(fn(storage,'scheduleAutosave'),f.c);f.state.maps[0].tokens[0].hp=3;f.c.scheduleAutosave();assert.equal(JSON.parse(f.browser.get('test-state:conflict-draft')).state.maps[0].tokens[0].hp,3);
});
test('map layout imports do not duplicate persistent personal character identities',()=>{
 const f=fixture();vm.runInContext(fn(app,'mapImportToken'),f.c);const token=f.c.mapImportToken({name:'角色',hp:13,ownedPieceId:'oc1',ownerPlayerId:'p1',characterRevision:8,owner:'某玩家',mountId:'old-mount',playerCreated:true,createdByPlayer:'p1'});
 assert.equal(token.hp,13);assert.equal(token.name,'角色');assert.equal(token.owner,'');for(const key of ['ownedPieceId','ownerPlayerId','characterRevision','mountId','playerCreated','createdByPlayer'])assert.equal(Object.hasOwn(token,key),false);
});
test('duplicate campaign identities are rejected instead of silently choosing the newest file',async()=>{
 const f=fixture();Object.assign(f.c,{campaignRecordsCache:[{id:'obsolete'}],usingLocalSaveBridge:()=>true,localSaveApiRequest:async()=>({records:[{id:'c1',name:'原件',savedAt:1,_path:'战役/原件/当前存档.json'},{id:'c1',name:'副本',savedAt:9,_path:'战役/副本/当前存档.json'}]}),homeLastCampaignId:''});vm.runInContext(fn(storage,'readCampaignRecords'),f.c);await assert.rejects(f.c.readCampaignRecords(true,{covers:false}),/重复战役身份/);assert.equal(f.c.campaignRecordsCache,null);
});
for(const committed of [true,false])test(`unknown formal write preserves exact text and performs one read-only receipt check, committed=${committed}`,async()=>{
 const f=fixture();const calls=[],timers=[];const original={path:'战役/c1/当前存档.json',text:'原始提交文本',expectedHash:'a'.repeat(64),expectedStateRevision:7,serverSessionId:'session-1'};
 Object.assign(f.c,{LOCAL_SAVE_API_PATH:'/api/local-save',LOCAL_SAVE_API_HEADER:'X-Sundoll-Local-Save',loadedCatalogHash:null,setTimeout:cb=>{timers.push(cb);return timers.length;},clearTimeout(){},campaignTextHash:async text=>{assert.equal(text,'a'.repeat(64)+':原始提交文本');return 's'.repeat(64);},fetch:async(_url,args)=>{const body=JSON.parse(args.body);calls.push(body);if(body.op==='write-campaign')return new Promise(()=>{});return {ok:true,json:async()=>body.op==='save-receipt'?{ok:true,committed,matchesCurrent:true,stateRevision:8,sessionId:'session-1',hash:'b'.repeat(64),result:{hash:'b'.repeat(64),stateRevision:8,sessionId:'session-1'}}:{ok:true}};}});
 for(const name of ['preserveUnconfirmedCampaignWrite','localSaveApiRequest'])vm.runInContext(fn(storage,name),f.c);
 const writing=f.c.localSaveApiRequest('write-campaign',original);timers[0]();
 if(committed){const result=await writing;assert.equal(result.hash,'b'.repeat(64));assert.equal(result.stateRevision,8);assert.equal(f.c.hostStateConflict,null);}else{await assert.rejects(writing,/尚未确认/);assert.equal(f.c.hostStateConflict.errorCode,'state-result-unknown');}
 assert.deepEqual(calls.map(x=>x.op),['write-campaign','write','save-receipt']);assert.equal(calls[1].text,original.text);assert.equal(JSON.parse(f.browser.get('test-state:pending-save')).payload.text,original.text);
});
function action(revision=8,seq=1){return {type:'action',revision,seq,action:{op:'patchToken',campaignId:'c1',_sessionId:'session-1',tokenId:'t1',patch:{hp:3}}};}
function enableActions(f){f.c.applyRemoteAction=a=>{f.state.maps[0].tokens[0].hp=a.patch.hp;return true;};}
test('a fully applied consecutive player action advances the frozen baseline before the next publish',async()=>{
 const f=fixture();enableActions(f);assert.equal(f.c.receiveHostStateAction(action()),true);assert.equal(f.c.hostStateRevision,8);assert.equal(f.state.maps[0].tokens[0].hp,3);await f.c.streamPush();assert.equal(f.requests[0].body.expectedStateRevision,8);
});
test('a skipped or incompletely applied player action does not manufacture a newer baseline',()=>{
 for(const incomplete of [false,true]){const f=fixture();enableActions(f);if(incomplete)f.c.applyRemoteAction=()=>false;f.c.receiveHostStateAction(action(incomplete?8:9));assert.equal(f.c.hostStateRevision,7);assert.ok(f.c.hostStateConflict);assert.equal(f.state.maps[0].tokens[0].hp,8);}
});
test('the next action arriving before an own publish acknowledgement waits for that causal acknowledgement',async()=>{
 const reply=deferred(),f=fixture({reply:()=>reply.promise});enableActions(f);const posting=f.c.streamPush();await new Promise(setImmediate);assert.equal(f.c.hostStatePostPending,true);f.c.receiveHostStateAction(action(9));assert.equal(f.c.hostStateRevision,7);assert.equal(f.state.maps[0].tokens[0].hp,8);
 reply.resolve({ok:true,json:async()=>({ok:true,stateRevision:8,sessionId:'session-1'})});assert.equal(await posting,true);assert.equal(f.c.hostStateRevision,9);assert.equal(f.state.maps[0].tokens[0].hp,3);assert.equal(f.c.hostStateConflict,null);
});
test('an own failed publish does not apply buffered actions over its conflicted draft',async()=>{
 const reply=deferred(),f=fixture({reply:()=>reply.promise});enableActions(f);const posting=f.c.streamPush();await new Promise(setImmediate);f.c.receiveHostStateAction(action(9));reply.resolve({ok:false,status:409,json:async()=>({error:'另一 DM 已提交',errorCode:'state-conflict'})});await posting;assert.equal(f.c.hostStateRevision,7);assert.equal(f.state.maps[0].tokens[0].hp,8);assert.equal(f.c.hostStatePendingActions.length,0);
});
test('a foreign full runtime event pauses instead of treating its public projection as a full formal save',()=>{
 const f=fixture();Object.assign(f.c,{streamES:null,EventSource:class{},hostMusic:{},PlayerBackpack:{}});vm.runInContext(fn(app,'startStreamClient'),f.c);f.c.startStreamClient();f.c.streamES.onmessage({data:JSON.stringify({type:'state',state:{_sessionId:'session-1',_stateRevision:8,campaignId:'c1',maps:[]}})});assert.ok(f.c.hostStateConflict);assert.equal(f.c.hostStateRevision,7);assert.equal(f.state.maps.length,1);
});
for(const loaded of [true,false])test(`explicit formal takeover preserves the draft and uses the exact verified formal read, loaded=${loaded}`,async()=>{
 const f=fixture(),order=[],formal={text:JSON.stringify({campaignId:'c1',state:{maps:[]}}),sourceHash:'a'.repeat(64)};f.c.streamOn=false;f.c.pauseHostStateSync('原冲突');
 Object.assign(f.c,{folderSaveQueue:Promise.resolve(),confirmHostFormalReload:async()=>true,campaignGet:async()=>({_path:'战役/c1/当前存档.json',_folderName:'c1'}),writeRecoverySnapshot:async label=>order.push(label),localSaveApiRequest:async(op,payload)=>{order.push(op);assert.equal(payload.path,'战役/c1/当前存档.json');return formal;},parseCampaignFile:()=>({id:'c1',state:{maps:[]}}),loadFolderSave:async record=>{order.push('load');assert.equal(record._verifiedRead,formal);return loaded;},SundollClientRuntime:{requestJson:async(url,options)=>{
  if(url.endsWith('/api/info'))return {response:{ok:true},data:{stateRevision:10,sessionId:'session-1'}};
  order.push('takeover');const sent=JSON.parse(options.body);assert.equal(sent.expectedHash,formal.sourceHash);assert.equal(sent.expectedStateRevision,10);assert.equal(sent.serverSessionId,'session-1');return {response:{ok:true},data:{ok:true,stateRevision:11,sessionId:'session-1',sourceHash:formal.sourceHash,recoveryPath:'战役/c1/自动备份/接管前恢复点.json'}};
 }}});vm.runInContext(fn(app,'reloadHostFormalAfterConflict'),f.c);
 assert.equal(await f.c.reloadHostFormalAfterConflict(),loaded);assert.deepEqual(order,['重新读取前本页草稿','read-campaign','takeover','load']);assert.ok(f.browser.has('test-state:conflict-draft'));assert.equal(f.c.hostStateRevision,loaded?11:7);assert.equal(f.c.hostStateConflict===null,loaded);assert.equal(f.elements.get('#host-save-conflict').hidden,loaded);
});
function enableFormalWrites(f,write){
 Object.assign(f.c,{campaignLoadedHashes:new Map([['c1','a'.repeat(64)]]),campaignRecordsCache:[],SAVE_CAMPAIGN_DIR:'战役',usingLocalSaveBridge:()=>true,ensureSaveFolderAccess:async()=>true,safeCampaignId:id=>id,campaignFolderName:id=>id,campaignGet:async()=>({_path:'战役/c1/当前存档.json',_folderName:'c1'}),readBoundText:async()=>null,campaignPackage:(id,name,snapshot,savedAt)=>({campaignId:id,campaignName:name,state:snapshot,savedAt}),campaignRecordSummary:doc=>({state:{campaignId:doc.campaignId}}),trimAutomaticBackups:async()=>{},writeSaveIndex:async()=>{},localSaveApiRequest:async(op,payload)=>{assert.equal(op,'write-campaign');return write(payload);}});
 for(const name of ['writeCurrentCampaign','writeCampaignRecord'])vm.runInContext(fn(storage,name),f.c);
}
test('a player action while preparing a formal save is included in the snapshot with its matching frozen guard',async()=>{
 const f=fixture(),reading=deferred(),writes=[];enableActions(f);enableFormalWrites(f,payload=>{writes.push(payload);return {hash:'b'.repeat(64),stateRevision:payload.expectedStateRevision+1,sessionId:'session-1'};});f.c.readBoundText=async()=>{await reading.promise;return null;};
 const original=f.c.folderSaveSnapshot(),saving=f.c.writeCampaignRecord('c1','测试',original,{currentProgress:true});await new Promise(setImmediate);f.c.receiveHostStateAction(action(8));reading.resolve();const result=await saving;assert.equal(JSON.parse(writes[0].text).state.maps[0].tokens[0].hp,3);assert.equal(writes[0].expectedStateRevision,8);assert.equal(f.c.hostStateRevision,9);assert.equal(result.indexWarning,'');
});
test('formal commit invalidation events arriving before their own acknowledgement are buffered and matched',async()=>{
 const f=fixture();enableFormalWrites(f,payload=>{assert.equal(f.c.hostStatePostPending,true);f.c.receiveHostStateEvent({type:'state',state:{_stateRevision:8,_sessionId:'session-1',campaignId:'c1'}});assert.equal(f.c.hostStateConflict,null);return {hash:'b'.repeat(64),stateRevision:8,sessionId:'session-1'};});await f.c.writeCampaignRecord('c1','测试',f.c.folderSaveSnapshot(),{currentProgress:true});assert.equal(f.c.hostStateRevision,8);assert.equal(f.c.hostStateConflict,null);assert.equal(f.c.hostStatePendingActions.length,0);
});
test('a static snapshot does not borrow a newer player-action revision during file preparation',async()=>{
 const f=fixture(),reading=deferred(),writes=[];enableActions(f);enableFormalWrites(f,payload=>{writes.push(payload);f.c.pauseHostStateSync('版本冲突',{errorCode:'state-conflict'});throw Object.assign(new Error('版本冲突'),{status:409});});f.c.readBoundText=async()=>{await reading.promise;return null;};const saving=f.c.writeCampaignRecord('c1','固定导入',f.c.folderSaveSnapshot());await new Promise(setImmediate);f.c.receiveHostStateAction(action(8));reading.resolve();await assert.rejects(saving,/版本冲突/);assert.equal(JSON.parse(writes[0].text).state.maps[0].tokens[0].hp,8);assert.equal(writes[0].expectedStateRevision,7,'server CAS must reject this stale static snapshot, not authorize it with current revision 8');
});
test('a later runtime revision cannot make an old unknown formal-write receipt current again',async()=>{
 const f=fixture(),timers=[],calls=[];const payload={path:'战役/c1/当前存档.json',text:'原文',expectedHash:'a'.repeat(64),expectedStateRevision:7,serverSessionId:'session-1'};
 Object.assign(f.c,{LOCAL_SAVE_API_PATH:'/api/local-save',LOCAL_SAVE_API_HEADER:'X-Sundoll-Local-Save',loadedCatalogHash:null,setTimeout:cb=>{timers.push(cb);return timers.length;},clearTimeout(){},campaignTextHash:async()=> 's'.repeat(64),fetch:async(_url,args)=>{const body=JSON.parse(args.body);calls.push(body);if(body.op==='write-campaign')return new Promise(()=>{});return {ok:true,json:async()=>body.op==='save-receipt'?{ok:true,committed:true,matchesCurrent:true,stateRevision:9,sessionId:'session-1',hash:'b'.repeat(64),result:{hash:'b'.repeat(64),stateRevision:8,sessionId:'session-1'}}:{ok:true}};}});
 for(const name of ['preserveUnconfirmedCampaignWrite','localSaveApiRequest'])vm.runInContext(fn(storage,name),f.c);const write=f.c.localSaveApiRequest('write-campaign',payload);timers[0]();await assert.rejects(write,/尚未确认/);assert.equal(f.c.hostStateRevision,7);assert.equal(f.c.hostStateConflict.errorCode,'state-result-unknown');assert.equal(calls.filter(c=>c.op==='write-campaign').length,1);
});

test('passive music notifications do not pause the host or authorize a newer runtime version',()=>{
 const f=fixture();f.c.applyRemoteAction=()=>false;assert.equal(f.c.receiveHostStateAction({type:'action',seq:0,action:{op:'bgm'}}),false);assert.equal(f.c.hostStateConflict,null);assert.equal(f.c.hostStateRevision,7);
 f.c.applyRemoteAction=()=>true;f.c.receiveHostStateAction({type:'action',revision:8,seq:0,action:{op:'roll',_sessionId:'session-1'}});assert.equal(f.c.hostStateRevision,7);assert.ok(f.c.hostStateConflict);
});

test('formal recovery requires the in-page confirmation and cancellation does not write',async()=>{
 const f=fixture();let close,opened=0;
 const dialog={open:false,returnValue:'',addEventListener(event,handler,options){assert.equal(event,'close');assert.equal(options.once,true);close=handler;},showModal(){this.open=true;opened++;}};
 f.c.$=()=>dialog;vm.runInContext(fn(app,'confirmHostFormalReload'),f.c);
 let decision=f.c.confirmHostFormalReload();assert.equal(opened,1);assert.equal(await f.c.confirmHostFormalReload(),false);
 dialog.open=false;dialog.returnValue='cancel';close();assert.equal(await decision,false);
 decision=f.c.confirmHostFormalReload();assert.equal(dialog.returnValue,'');dialog.open=false;dialog.returnValue='continue';close();assert.equal(await decision,true);
 f.c.confirmHostFormalReload=async()=>false;f.c.writeRecoverySnapshot=()=>{throw Error('cancel must not write');};
 vm.runInContext(fn(app,'reloadHostFormalAfterConflict'),f.c);assert.equal(await f.c.reloadHostFormalAfterConflict(),false);assert.equal(f.requests.length,0);
});
