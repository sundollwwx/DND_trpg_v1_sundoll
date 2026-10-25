'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const app=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const storage=fs.readFileSync(path.join(APP_ROOT,'主控台/host/storage.js'),'utf8');
const html=fs.readFileSync(path.join(APP_ROOT,'主控台/主控台.html'),'utf8');
function fn(source,name){const a=source.indexOf(`async function ${name}(`),b=source.indexOf(`function ${name}(`),start=a<0?b:a;assert.notEqual(start,-1,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(options={}){
 const hash='a'.repeat(64),calls=[],recoveries=[],cached=new Map(),elements=new Map(),cleared=[];
 const state={campaignId:'c1',campaignName:'合成战役',activeMapId:'private-map',presentedMapId:'m1',travelBasketOpen:false,
  prepHandbook:[{privateText:'合成DM准备'}],maps:[{id:'m1',tokens:[{id:'public',hp:8},{id:'hidden',hiddenFromPlayers:true,legacyGmNotes:'合成私有记录'}]},{id:'private-map',playerAccessible:false,tokens:[{id:'private-token',hp:23}]}]};
 const original=copy(state),merged=copy(state);merged.maps[0].tokens[0].hp=3;merged.travelBasketOpen=true;
 const result={ok:true,record:{campaignId:'c1',campaignName:'合成战役',state:merged},sourceHash:hash,stateRevision:7,sessionId:'session-1',streamSeq:19,mapPresentationId:'presentation-current',...options.result};
 const element=id=>{if(!elements.has(id))elements.set(id,{tagName:'SECTION',id,inert:false,hidden:false,disabled:false,open:false,textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},focus(){this.focused=true;}});return elements.get(id);};
 const panel=element('#host-save-conflict'),layout=element('#layout'),oldInert=element('#old-inert');oldInert.inert=true;
 const context=vm.createContext({JSON,Date,Number,String,Array,Map,Set,Promise,console:{warn(){}},
  state,hostStateRevision:2,hostStateSessionId:'session-old',hostStateConflict:{message:'已有运行进度'},hostStateResumeInProgress:false,hostEditGeneration:0,
  hostStateWriteQueue:Promise.resolve(),folderSaveQueue:Promise.resolve(),hostStatePendingActions:[{type:'old'}],streamServerSessionId:'session-old',streamAppliedSeq:1,
  campaignLoadInProgress:false,campaignOpenInProgress:false,autosaveTimer:123,streamDirty:false,mapPresentationId:'presentation-old',campaignLoadedHashes:new Map([['c1',hash]]),
  window:{TravelBasket:{changed(){calls.push('basket-ui');}}},document:{body:{children:[layout,oldInert,panel]}},$:element,
  localStorage:{setItem:(k,v)=>cached.set(k,v)},STORAGE_KEY:'synthetic-host',serverApiBase:()=>'',
  flushDetailTextSave(){},keepHostConflictDraft(){cached.set('draft',JSON.stringify(state));return true;},folderSaveSnapshot:()=>copy(state),
  writeRecoverySnapshot:async(label,snapshot)=>{recoveries.push({label,snapshot:copy(snapshot)});if(options.recoveryFailure)throw new Error('恢复点写入失败');},
  campaignGet:async()=>({_path:'战役/c1/当前存档.json',_folderName:'c1',name:'合成战役'}),
  localSaveApiRequest:async(op,payload)=>{calls.push(op);assert.equal(op,'read-campaign');return {sourceHash:hash,text:JSON.stringify({campaignId:'c1',state:original})};},
  applySavedState(next){calls.push('apply');Object.keys(state).forEach(key=>delete state[key]);Object.assign(state,copy(next));state.travelBasketOpen=false;return !options.loadFailure;},
  applyAllState(){options.onInterface?.(context);},loadLinks(){},renderLinks(){},cacheLoadedStateInBrowser:()=>({ok:true}),rememberCampaignSelection:async()=>{},
  clearTimeout:id=>cleared.push(id),scheduleAutosave(){throw new Error('resume cannot schedule a save');},
  updateSaveStatus:(message,kind)=>calls.push({status:message,kind}),updateStreamUi(){},toast:message=>calls.push({toast:message}),
  usingLocalSaveBridge:()=>true,
  streamPush(){throw new Error('resume cannot publish');},fetch(){throw new Error('resume cannot issue a raw write');},
  SundollClientRuntime:{requestJson:async(url,request)=>{
   calls.push({url,request});
   if(url.endsWith('/api/host-state/resume')){options.onResume?.(context);return {response:{ok:options.responseOK!==false},data:result};}
   assert.equal(url,'/api/info');
   const count=calls.filter(call=>call.url==='/api/info').length;
   return {response:{ok:true},data:{stateRevision:7,sessionId:'session-1',stateAuthority:{published:true,campaignId:'c1',formalSourceHash:hash},...(count===2?options.check:{})}};
  }},
 });
 for(const name of ['parseCampaignFile','loadFolderSave'])vm.runInContext(fn(storage,name),context);
 for(const name of ['pauseHostStateSync','resumeHostRuntimeAfterConflict','applyHostStateEvent'])vm.runInContext(fn(app,name),context);
 return {c:context,state,original,hash,calls,recoveries,cached,elements,layout,oldInert,panel,cleared,result};
}

test('resume keeps full DM preparation, live progress and lineage without publishing or saving the formal file',async()=>{
 const f=fixture();assert.equal(await f.c.resumeHostRuntimeAfterConflict(),true);
 assert.equal(f.state.maps[0].tokens[0].hp,3);
 assert.deepEqual(f.state.maps[0].tokens[1],f.original.maps[0].tokens[1]);
 assert.deepEqual(f.state.maps[1],f.original.maps[1]);
 assert.deepEqual(f.state.prepHandbook,f.original.prepHandbook);
 assert.equal(f.state.activeMapId,'private-map');assert.equal(f.state.presentedMapId,'m1');
 assert.equal(f.state.travelBasketOpen,true);assert.equal(f.c.mapPresentationId,'presentation-current');
 assert.equal(f.c.campaignLoadedHashes.get('c1'),f.hash);
 assert.equal(f.c.hostStateRevision,7);assert.equal(f.c.hostStateSessionId,'session-1');assert.equal(f.c.streamServerSessionId,'session-1');assert.equal(f.c.streamAppliedSeq,19);
 assert.equal(f.c.hostStateConflict,null);assert.equal(f.c.hostStatePendingActions.length,0);assert.equal(f.c.streamDirty,false);assert.equal(f.c.autosaveTimer,null);
 assert.equal(f.c.hostStateResumeInProgress,false);assert.equal(f.panel.hidden,true);assert.equal(f.layout.inert,false);assert.equal(f.oldInert.inert,true);
 assert.deepEqual(f.recoveries.map(item=>item.label),['读取前恢复点']);
 assert.deepEqual(f.recoveries[0].snapshot,f.original);
 assert.deepEqual(JSON.parse(f.cached.get('draft')),f.original);
 const requests=f.calls.filter(call=>call.url);assert.deepEqual(requests.map(call=>call.url),['/api/info','/api/host-state/resume','/api/info']);
 assert.deepEqual(JSON.parse(requests[1].request.body),{campaignId:'c1',path:'战役/c1/当前存档.json',expectedHash:f.hash,expectedStateRevision:7,serverSessionId:'session-1'});
 assert.equal(f.calls.filter(call=>call==='read-campaign').length,1);
 assert.equal(f.elements.get('#btn-save-tools-open').focused,true);
});

for(const check of [{stateRevision:8},{sessionId:'session-new'},{stateAuthority:{published:true,campaignId:'another',formalSourceHash:'a'.repeat(64)}},{stateAuthority:{published:true,campaignId:'c1',formalSourceHash:'b'.repeat(64)}}])
test('a changed post-load authority cannot grant a newer baseline: '+JSON.stringify(check),async()=>{
 const f=fixture({check});assert.equal(await f.c.resumeHostRuntimeAfterConflict(),false);
 assert.ok(f.c.hostStateConflict);assert.equal(f.c.hostStateRevision,2);assert.equal(f.c.hostStateSessionId,'session-old');assert.equal(f.c.streamAppliedSeq,1);
 assert.equal(f.c.streamDirty,false);assert.equal(f.panel.hidden,false);assert.equal(f.layout.inert,false);assert.equal(f.oldInert.inert,true);
 assert.equal(f.elements.get('#host-conflict-resume').focused,true);
 assert.deepEqual(f.recoveries[0].snapshot,f.original);
});

test('resume waits for prior writes, prevents duplicate clicks and keeps page controls inert until completion',async()=>{
 const f=fixture(),pending=deferred();f.c.hostStateWriteQueue=pending.promise;
 const run=f.c.resumeHostRuntimeAfterConflict();await new Promise(setImmediate);
 assert.equal(f.layout.inert,true);assert.equal(f.panel.inert,false);
 for(const id of ['#host-conflict-resume','#host-conflict-reload','#host-conflict-download'])assert.equal(f.elements.get(id).disabled,true);
 assert.equal(await f.c.resumeHostRuntimeAfterConflict(),false);assert.equal(f.calls.filter(call=>call.url).length,0);
 pending.resolve();assert.equal(await run,true);
 for(const id of ['#host-conflict-resume','#host-conflict-reload','#host-conflict-download'])assert.equal(f.elements.get(id).disabled,false);
});

for(const change of ['edit','campaign'])test('a changed local '+change+' during resume rejects the response before replacing the draft',async()=>{
 const f=fixture({onResume:c=>{if(change==='edit'){c.hostEditGeneration++;c.state.maps[0].tokens[0].hp=1;}else c.state.campaignId='c-other';}});
 assert.equal(await f.c.resumeHostRuntimeAfterConflict(),false);assert.ok(f.c.hostStateConflict);assert.equal(f.calls.includes('apply'),false);
 assert.equal(f.c.hostStateRevision,2);assert.equal(f.state.maps[0].tokens[0].hp,change==='edit'?1:8);
});

test('edits detected while rebuilding the interface retain conflict and never authorize a write',async()=>{
 const f=fixture({onInterface:c=>{c.hostEditGeneration++;c.state.maps[0].tokens[0].hp=1;}});
 assert.equal(await f.c.resumeHostRuntimeAfterConflict(),false);assert.ok(f.c.hostStateConflict);assert.equal(f.c.hostStateRevision,2);assert.equal(f.state.maps[0].tokens[0].hp,1);
 assert.equal(f.calls.filter(call=>call.url==='/api/info').length,1);
});

for(const options of [{recoveryFailure:true},{loadFailure:true},{responseOK:false,result:{ok:false,error:'正式谱系已变化'}},{result:{sourceHash:'b'.repeat(64)}},{result:{streamSeq:-1}},{result:{record:{campaignId:'another',state:{maps:[]}}}}])
test('a failed or incomplete resume stays locked: '+JSON.stringify(options),async()=>{
 const f=fixture(options);assert.equal(await f.c.resumeHostRuntimeAfterConflict(),false);
 assert.ok(f.c.hostStateConflict);assert.equal(f.c.hostStateRevision,2);assert.equal(f.panel.hidden,false);assert.equal(f.layout.inert,false);
 assert.equal(f.c.hostStateResumeInProgress,false);assert.equal(f.c.streamDirty,false);
 if(options.recoveryFailure){assert.equal(f.calls.includes('apply'),false);assert.deepEqual(f.state,f.original);}
});

test('a newer SSE state after resume pauses normally instead of silently advancing the adopted revision',async()=>{
 const f=fixture();assert.equal(await f.c.resumeHostRuntimeAfterConflict(),true);
 assert.equal(f.c.applyHostStateEvent({type:'state',state:{campaignId:'c1',_stateRevision:8,_sessionId:'session-1'}}),false);
 assert.ok(f.c.hostStateConflict);assert.equal(f.c.hostStateRevision,7);assert.equal(f.state.maps[0].tokens[0].hp,3);
});

test('the conflict panel offers one read-only resume, retains draft/recovery exits and versions the script',()=>{
 assert.equal(html.match(/id="host-conflict-resume"/g)?.length,1);
 for(const id of ['host-conflict-download','host-conflict-reload'])assert.equal(html.match(new RegExp(`id="${id}"`,'g'))?.length,1);
 assert.match(html,/host\/app\.js\?v=20261024-room-resume-v1/);
 assert.match(html,/此操作会用正式存档替换房间当前进度/);
});

test('actual applyAllState and encounter rendering do not turn resume into a user edit',async()=>{
 const f=fixture();
 const node=()=>({dataset:{},style:{},children:[],classList:{add(){},toggle(){}},setAttribute(){},addEventListener(){},append(...items){this.children.push(...items);},appendChild(item){this.children.push(item);},closest(){return null;}});
 for(const entry of f.elements.values())Object.assign(entry,node());
 const originalGet=f.c.$;
 f.c.$=id=>{const existing=f.elements.has(id),element=originalGet(id);if(!existing)Object.assign(element,node());return element;};
 f.c.document.querySelectorAll=()=>[];f.c.document.createElement=node;
 const encounter={playMode:'turn',round:3,turnSerial:12,secondsPerRound:6,currentEntryId:'entry-one',entries:[{id:'entry-one',tokenId:'public',name:'合成参团者',value:12}],worldTime:{totalSeconds:120,runningSince:null},weather:{}};
 Object.assign(f.c,{encounterState:()=>encounter,worldTimeNow:()=>120,worldTimeParts:()=>({year:1,week:1,day:1}),
  currentInitiativeEntry:()=>encounter.entries[0],initiativeEntryLabel:entry=>entry.name,initiativeEntryToken:()=>({id:'public'}),
  weatherPresentation:()=>({season:{icon:'',label:'合成季节'},conditionIcon:'',conditionLabel:'晴',detail:'',climate:'test',temperature:20,wind:0}),
  formatWorldClock:()=>'00:02',formatWorldDate:()=>'合成日期',CLIMATE_AVAILABLE:true,restAnimationActive:false,hostInitiativeValueDrafts:new Map(),
  updateHostTurnPathControls(){},renderHostInitiativeSwapControls(){},scrollCurrentInitiativeIntoView(){},renderTurnPath(){},renderInitiativeSelection(){},esc:value=>value,
  updateCoverContinue(){},syncActiveMapGridSetting(){},renderLibrary(){},renderSharedNotes(){},hostMusic:{ensureBgmLibraryForCampaign(){}},hostDocuments:{ensureCampaign(){}},syncMapSelect(){},applyActiveMap(){f.calls.push('active-map-render');},
 });
 const encounterSource=fs.readFileSync(path.join(APP_ROOT,'主控台/host/encounter-ui.js'),'utf8');
 for(const name of ['renderHostInitiativeRibbon','refreshHostClock','renderEncounter'])vm.runInContext(fn(encounterSource,name),f.c);
 vm.runInContext(fn(app,'applyAllState'),f.c);
 assert.equal(await f.c.resumeHostRuntimeAfterConflict(),true);
 assert.equal(f.elements.get('#init-round-readout').textContent,'第 3 轮');
 assert.equal(f.elements.get('#init-bar-list').children.length,1);
 assert.equal(f.calls.includes('active-map-render'),true);
 assert.equal(f.c.hostEditGeneration,0);assert.equal(f.c.hostStateConflict,null);assert.equal(f.c.streamDirty,false);
});

test('actual resumed loader and public projection retain live resources without disclosing DM state',async()=>{
 const f=fixture();
 const saved=f.result.record.state;
 Object.assign(saved.maps[0],{name:'Public map',chapterId:'chapter-public',locationId:'location-public',playerAccessible:true});
 Object.assign(saved.maps[1],{name:'Private map',chapterId:'chapter-private',locationId:'location-private'});
 Object.assign(saved.maps[0].tokens[0],{
  type:'pc',name:'Synthetic adventurer',owner:'synthetic-owner',ownedPieceId:'synthetic-owned',ownerPlayerId:'synthetic-owner',
  characterRevision:9,hp:3,hpMax:10,x:120,y:240,
  spellSlots:{1:{max:4,used:2}},resourceSlots:[{id:'synthetic-resource',current:2,max:5}],
  conditions:[{id:'public-condition',visibility:'public'},{id:'private-condition',visibility:'gm'}],
 });
 saved.maps[0].tokens[1].name='Hidden adversary';
 Object.assign(saved,{
  library:[],mapChapters:[{id:'chapter-public',name:'Visible chapter'},{id:'chapter-private',name:'Secret chapter'}],
  mapLocations:[{id:'location-public',chapterId:'chapter-public',name:'Visible location'},{id:'location-private',chapterId:'chapter-private',name:'Secret location'}],
  encounter:{playMode:'turn',allowInitiativeSwap:true,round:2,turnSerial:12,secondsPerRound:6,currentEntryId:'entry-public',
   entries:[{id:'entry-public',tokenId:'public',name:'Synthetic adventurer',value:12},{id:'entry-hidden',tokenId:'hidden',name:'Hidden adversary',value:5}],
   turnPath:{mapId:'m1',tokenId:'public',points:[{x:100,y:240},{x:120,y:240}],segmentEnds:[1]},
   worldTime:{totalSeconds:120,runningSince:null,rate:1},weather:{},lastEvent:{at:123,label:'Private encounter note'}},
 });
 f.state.library=[];
 const rules=require(path.join(APP_ROOT,'shared/rules.js'));
 Object.assign(f.c,{
  userLinks:[],uid:1,pendingLegacyPortraitMigrations:0,SundollRules:rules,MAX_TURN_PATH_POINTS:1000,
  normalizeLink:value=>value,CampaignJournal:{normalize:value=>value||{}},normalizeWeather:value=>value||{},defaultWeatherState:()=>({}),worldTimeNow:()=>120,
  loadLibrary:()=>[],BUNDLED_LIBRARY:[],normalizeLibPreset:value=>value,canonicalPortraitPath:value=>value||null,migrateLegacyTokenPortrait:()=>false,
  normalizeSheet:token=>token,clamp:(value,min,max)=>Math.min(max,Math.max(min,value)),
  mapById:id=>f.state.maps.find(map=>map.id===id),ensureMapNavigation(){},repairDuplicateTokenIds(){},reconcileInitiativeEntries(){},
  initiativeEntryToken:entry=>f.state.maps.flatMap(map=>map.tokens).find(token=>token.id===entry.tokenId),nextSafeCounter:()=>100,renumberAllMaps(){},
  tokenPortraitVariants:token=>token.portraitVariants||[],portraitLibraryPresetForToken:()=>null,normalizeSpellRange:rules.normalizeSpellRange,
  cachedStreamMapAssetUrl:()=>'',mapGridVisible:map=>map?.gridVisible!==false,ensureDoodleIds:map=>map.doodles||[],
  presentedMap:()=>f.state.maps.find(map=>map.id===f.state.presentedMapId),encounterState:()=>f.state.encounter,initiativeEntryLabel:entry=>entry.name,
  normalizeTurnPathSegmentEnds:rules.normalizeTurnPathSegmentEnds,hostMusic:{snapshot:()=>null},SundollProtocol:{version:34},
 });
 vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'shared/token-size.js'),'utf8'),f.c);
 for(const name of ['defaultEncounterState','emptyTurnPath','normalizeEncounter','publicStreamToken','publicStreamMap','publicEncounterState','buildStreamPayload'])vm.runInContext(fn(app,name),f.c);
 vm.runInContext(fn(storage,'applySavedState'),f.c);
 assert.equal(await f.c.resumeHostRuntimeAfterConflict(),true);
 const payload=f.c.buildStreamPayload(),live=f.state.maps[0].tokens[0],visible=payload.maps[0].tokens[0];
 assert.equal(f.state.activeMapId,'private-map');assert.equal(payload.activeMapId,'m1');
 for(const token of [live,visible])assert.deepEqual([token.hp,token.x,token.y,token.characterRevision],[3,120,240,9]);
 assert.equal(f.state.maps[0].tokens[1].hiddenFromPlayers,true);assert.equal(f.state.maps[1].tokens.length,1);
 assert.deepEqual(copy(payload.maps[0].tokens.map(token=>token.id)),['public']);assert.deepEqual(copy(payload.maps[1].tokens),[]);assert.equal(payload.maps[1].name,null);
 assert.equal(payload.mapChapters[1].name,null);assert.equal(payload.mapLocations[1].name,null);
 assert.deepEqual(copy(visible.conditions),[{id:'public-condition',visibility:'public'}]);
 assert.deepEqual(copy(live.conditions),saved.maps[0].tokens[0].conditions);
 assert.deepEqual(copy(f.state.prepHandbook),saved.prepHandbook);assert.equal(Object.hasOwn(payload,'prepHandbook'),false);
 assert.equal(f.state.encounter.allowInitiativeSwap,true);assert.equal(payload.encounter.allowInitiativeSwap,false);
 assert.deepEqual(copy(payload.encounter.entries.map(entry=>entry.tokenId)),['public']);assert.equal(payload.encounter.lastEvent.label,'流程状态已更新');
 assert.deepEqual(copy(payload.encounter.turnPath.points),saved.encounter.turnPath.points);
 // These underscored fields are private host-to-server reconciliation input, not player-facing maps.
 assert.deepEqual(copy(payload._characterRuntime[0].spellSlots),saved.maps[0].tokens[0].spellSlots);
 assert.deepEqual(copy(payload._characterRuntime[0].resourceSlots),saved.maps[0].tokens[0].resourceSlots);
 assert.equal(Object.hasOwn(visible,'spellSlots'),false);assert.equal(Object.hasOwn(visible,'resourceSlots'),false);
 assert.equal(payload._ownedPieceLocations[0].token.x,120);assert.equal(payload._ownedPieceLocations[0].token.hp,3);
 assert.equal(payload.mapPresentationId,'presentation-current');assert.equal(payload._streamSeq,19);assert.equal(payload._formalSourceHash,f.hash);
 assert.equal(payload.travelBasketOpen,true);assert.equal(f.c.streamDirty,false);assert.equal(f.c.hostEditGeneration,0);
});
