/* Execute real loading entry points with temporary in-memory campaign fixtures. */
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),path=require('node:path');
const {readClientSource}=require('./client_sources.cjs'),{APP_ROOT}=require('./project_paths.cjs');
const app=readClientSource('主控台/host/app.js'),storage=readClientSource('主控台/host/storage.js');
const loading=require(path.join(APP_ROOT,'主控台/host/load-progress.js')),runtime=require(path.join(APP_ROOT,'主控台/shared/client-runtime.js'));
const cut=(source,from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const tick=()=>new Promise(setImmediate);
function fixture(){
  const calls=[],nodes=new Map(),timers=new Map();let timerId=0;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{},textContent:'',click(){calls.push('permission-click');}});return nodes.get(id);};
  const record={id:'fixture-only',name:'private name not exported',_path:'private/test.json',_folderName:'test'};
  const data={id:record.id,savedAt:123,state:{campaignId:record.id,campaignName:record.name,maps:[]}},local=new Map();
  const controller=loading.create({yieldTask:()=>Promise.resolve(),now:Date.now});
  const c={globalThis:null,SundollHostLoadProgress:controller,location:{protocol:'https:'},state:{campaignId:null,maps:[]},localSaveApiAvailable:true,projectDirHandle:{},modularStorage:true,
    $,localStorage:{getItem:key=>local.get(key)||null,setItem:(key,value)=>local.set(key,String(value))},
    updateCoverContinue(){},setCoverFeedback(){},renderCoverRecent(){},loadProjectDirHandle:async()=>calls.push('status'),
    hasSaveFolderPermission:async()=>true,readCampaignRecords:async(force,options)=>{calls.push(['catalog',options]);return[record];},usingLocalSaveBridge:()=>true,
    campaignGet:async()=>{calls.push('get');return record;},syncLibraryWithFolder:async()=>{calls.push('library');return true;},loadSaved:()=>calls.push('cache'),loadLibraryRecentIds:()=>[],
    libRecentIds:[],campaignLoadInProgress:false,autosaveTimer:null,folderSaveQueue:Promise.resolve(),clearTimeout:id=>timers.delete(id),
    setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId;},AbortController,
    flushDetailTextSave(){},localSaveApiRequest:async op=>{calls.push(op);return{text:JSON.stringify(data),sourceHash:'fixture-hash'};},
    readBoundText:async()=>{calls.push('full-read');return JSON.stringify(data);},parseCampaignFile:text=>JSON.parse(text),
    folderSaveSnapshot:()=>({}),writeRecoverySnapshot:async()=>calls.push('write-recovery'),campaignTextHash:async()=> 'fixture-hash',campaignLoadedHashes:new Map(),
    applySavedState:state=>{calls.push('normalize');c.state=structuredClone(state);return true;},
    applyAllState:()=>calls.push('interface'),loadLinks(){},renderLinks(){},stateStorageJson:()=>JSON.stringify(c.state),
    STORAGE_KEY:'fixture-cache',browserStateCacheFailed:false,rememberCampaignSelection:async()=>calls.push('write-selection'),
    updateSaveStatus(){},toast(){},console:{warn(){}},confirm:()=>true,scheduleAutosave(){},
    closeCampaignModal(){},hideCover:()=>calls.push('enter'),hostMusic:{loadProjectMusicLibrary(){}},prewarmAvatarCache(){},
    streamOn:false,streamConnectionState:'off',restoreStreamFromStorage:async()=>{calls.push('restore-connection');return null;},
    serverApiBase:()=>'',fetch:async()=>({ok:true,json:async()=>({sessionId:'fixture-session',ips:[]})}),
  };
  c.globalThis=c;c.SundollClientRuntime={deadline:(task,settings)=>runtime.deadline(task,{...settings,env:c}),requestJson:async()=>{calls.push('connection-read');return{response:{ok:true},data:{sessionId:'fixture-session'}};}};
  vm.createContext(c);
  vm.runInContext(cut(app,'let hostCampaignDeferred','async function renderCampaignList')+'\n'+cut(app,'async function openCampaign(id)','function hideCover()')+'\n'+cut(storage,'function browserStorageIssue','function normalizeServerBase')+'\n'+cut(storage,'async function loadFolderSave','function scheduleAutosave'),c);
  return{c,controller,calls,data,record,timers,$,run:code=>vm.runInContext(code,c),expire:delay=>{for(const item of [...timers.values()])if(item.delay===delay)item.fn();}};
}
test('home diagnostics read catalog summaries only, leaving board, library and full saves deferred',async()=>{
  const f=fixture();await f.c.refreshHostHome({forceRecords:true});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[['catalog',{covers:false}]]);assert.equal(f.run('hostCampaignDeferred'),true);
  assert.deepEqual(f.controller.snapshot().stages.map(row=>row.stage),['workspace','permission','catalog']);assert.equal(f.controller.snapshot().status,'success');
});
test('campaign diagnostics follow real library/read/parse/interface logic and preserve the original disk hash',async()=>{
  const f=fixture();assert.equal(await f.c.openCampaign('fixture-only'),true);
  assert.deepEqual(f.controller.snapshot().stages.map(row=>row.stage),['catalog','library','recoveryCache','pendingSave','saveRead','parse','normalize','interface','browserCache','selection','connection']);
  assert.equal(f.controller.snapshot().status,'success');assert.equal(f.controller.snapshot().stages.at(-1).status,'skipped');
  assert.equal(f.c.campaignLoadedHashes.get('fixture-only'),'fixture-hash');assert.equal(f.run('hostCampaignDeferred'),false);
  assert.doesNotMatch(f.controller.summaryText(),/private|fixture-only|test\.json/);
});
for(const [stage,replace] of [
  ['catalog',f=>f.c.campaignGet=async()=>{throw new Error('secret');}],
  ['library',f=>f.c.syncLibraryWithFolder=async()=>{throw Object.assign(new Error('secret'),{name:'TimeoutError'});}],
  ['saveRead',f=>f.c.localSaveApiRequest=async()=>{throw Object.assign(new Error('secret'),{name:'TimeoutError'});}],
  ['parse',f=>f.c.parseCampaignFile=()=>{throw new SyntaxError('secret');}],
  ['normalize',f=>f.c.applySavedState=()=>false],
])test(`a ${stage} failure names the failing stage, prevents publication and permits explicit read retry`,async()=>{
  const f=fixture();replace(f);assert.equal(await f.c.openCampaign('fixture-only'),false);
  assert.equal(f.controller.snapshot().stages.findLast(row=>row.status==='failure').stage,stage);assert.equal(f.controller.snapshot().retryAvailable,true);
  assert.equal(f.calls.includes('restore-connection'),false);assert.equal(f.calls.includes('write-selection'),false);assert.equal(f.run('hostCampaignDeferred'),true);
  assert.doesNotMatch(f.controller.summaryText(),/secret/);
});
test('failed save reads retry only after explicit input, and retry does not reread an already loaded library',async()=>{
  const f=fixture();let reads=0;f.c.localSaveApiRequest=async()=>{reads++;if(reads===1)throw new Error('offline');return{text:JSON.stringify(f.data),sourceHash:'fixture-hash'};};
  assert.equal(await f.c.openCampaign('fixture-only'),false);await tick();assert.equal(reads,1);
  assert.equal(await f.controller.retry(),true);assert.equal(reads,2);assert.equal(f.calls.filter(call=>call==='library').length,1);
});
test('interface retry redraws the already loaded data without rereading or repeating any writes',async()=>{
  const f=fixture();let renderCount=0;f.c.applyAllState=()=>{if(++renderCount===1)throw new TypeError('UI secret');};
  assert.equal(await f.c.openCampaign('fixture-only'),false);assert.equal(f.controller.snapshot().retryLabel,'重试恢复界面');
  assert.equal(await f.controller.retry(),true);assert.equal(f.calls.filter(call=>call==='read-campaign').length,1);
  assert.equal(f.calls.includes('write-selection'),false);assert.equal(f.calls.includes('write-recovery'),false);assert.equal(f.run('hostCampaignDeferred'),false);
});
test('a failed recovery write offers only the read-only directory, never repeating the uncertain write',async()=>{
  const f=fixture();f.c.state.campaignId='previous';let writes=0;f.c.writeRecoverySnapshot=async()=>{writes++;throw new Error('unknown write result');};
  assert.equal(await f.c.openCampaign('fixture-only'),false);assert.equal(f.controller.snapshot().retryLabel,'返回存档列表');
  await f.controller.retry();assert.equal(writes,1);assert.equal(f.c.state.campaignId,'previous');assert.equal(f.controller.snapshot().kind,'home');
});
test('failure to remember selection stays partial after a real load, with a directory-only retry',async()=>{
  const f=fixture();let writes=0;f.c.rememberCampaignSelection=async()=>{writes++;throw new Error('uncertain');};
  assert.equal(await f.c.openCampaign('fixture-only'),true);assert.equal(f.controller.snapshot().status,'partial');
  assert.equal(f.controller.snapshot().stages.find(row=>row.stage==='selection').status,'failure');await f.controller.retry();assert.equal(writes,1);
});
test('an enabled but unconfirmed stream times out visibly; connection retry performs only a read',async()=>{
  const f=fixture();f.c.restoreStreamFromStorage=async()=>{f.c.streamOn=true;f.c.streamConnectionState='connecting';return true;};
  const pending=f.c.openCampaign('fixture-only');await tick();f.expire(8000);assert.equal(await pending,true);
  assert.equal(f.controller.snapshot().stages.at(-1).stage,'connection');assert.equal(f.controller.snapshot().stages.at(-1).errorClass,'TimeoutError');
  f.c.streamConnectionState='online';const writesBefore=f.calls.filter(call=>typeof call==='string'&&call.startsWith('write-')).length;
  assert.equal(await f.controller.retry(),true);assert.equal(f.calls.filter(call=>call==='connection-read').length,1);
  assert.equal(f.calls.filter(call=>typeof call==='string'&&call.startsWith('write-')).length,writesBefore);
});
test('permission failure identifies permission and routes retry through the explicit authorization control',async()=>{
  const f=fixture();f.c.hasSaveFolderPermission=async()=>false;await f.c.refreshHostHome();
  assert.equal(f.controller.snapshot().stages.at(-1).stage,'permission');assert.equal(f.controller.snapshot().stages.at(-1).errorClass,'NotAllowedError');
  await f.controller.retry();assert.deepEqual(f.calls,['permission-click']);
});
