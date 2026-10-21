const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT, '主控台/host/storage.js'),'utf8');
test('rapid autosaves keep one in-flight snapshot and the latest pending save',async()=>{
 let resolveFirst;const first=new Promise(resolve=>resolveFirst=resolve);const writes=[];
 const context=vm.createContext({state:{campaignId:'c1',campaignName:'战役',hp:10},campaignLoadInProgress:false,
  folderSaveQueue:Promise.resolve(),projectDirHandle:{},hasSaveFolderPermission:async()=>true,
  folderSaveSnapshot:()=>JSON.parse(JSON.stringify(context.state)),
  campaignPut:async(id,name,snapshot,options)=>{writes.push({id,snapshot,options});if(writes.length===1)await first;return {savedAt:1};},
  rememberCampaignSelection:async()=>{},lastFolderSaveAt:0,localStorage:{setItem(){}},updateSaveStatus(){},
  $:()=>null,console,Date});
 vm.runInContext(source.slice(source.indexOf('let pendingFolderSave'),source.indexOf('async function loadFolderSave')),context);
 const initial=context.queueCurrentFolderSave();
 await new Promise(resolve=>setImmediate(resolve));
 let pending;
 for(let i=0;i<50;i++){context.state.hp=i;pending=context.queueCurrentFolderSave({backup:i===2});}
 assert.equal(writes.length,1);resolveFirst();await initial;await pending;
 assert.equal(writes.length,2);assert.equal(writes[1].snapshot.hp,49);assert.equal(writes[1].options.backup,true);
});
test('a modular empty installation cannot import legacy browser campaigns implicitly',async()=>{
 const context=vm.createContext({modularStorage:true,legacyCampaignList:()=>assert.fail('Old browser saves must not be opened'),readCampaignRecords:()=>assert.fail('No legacy migration is needed')});
 vm.runInContext(source.slice(source.indexOf('async function migrateLegacyCampaigns()')),context);
 assert.equal(await context.migrateLegacyCampaigns(),0);
});
test('empty modular storage ignores the previous installations selected campaign',async()=>{
 const context=vm.createContext({modularStorage:true,STORAGE_KEY:'new-install',state:{campaignId:null},projectDirHandle:{},
  localStorage:{getItem:key=>key==='dnd-board-last-campaign-id'?'private-old-campaign':null},
  hasSaveFolderPermission:async()=>true,readBoundText:async()=>'{}',SAVE_INDEX_FILE:'index',readCampaignRecords:async()=>[],
  updateSaveStatus(){},JSON});
 const start=source.indexOf('async function restoreFolderIfAvailable()');const end=source.indexOf('\nfunction ',start);
 vm.runInContext(source.slice(start,end),context);
 assert.equal(await context.restoreFolderIfAvailable(),true);
});

test('restoration never silently refreshes an old pages write generation',async()=>{
 const calls=[];let epoch='first';
 const context=vm.createContext({URL,Headers,AbortController,setTimeout,clearTimeout,location:{href:'http://localhost:8090/host',origin:'http://localhost:8090'},
   window:{fetch:async(input,opts={})=>{calls.push({input,opts});return {ok:true,json:async()=>({epoch})};}}});
 const client=fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT,'shared/workspace-session.js'),'utf8');
 vm.runInContext(client,context);
 await context.window.fetch('/api/modules',{method:'POST'});
 assert.equal(calls.at(-1).opts.headers.get('X-Sundoll-Workspace'),'first');
 epoch='second';await context.window.fetch('/api/workspace-epoch');
 await context.window.fetch(new URL('http://localhost:8090/api/local-save'),{method:'POST'});
 assert.equal(calls.at(-1).opts.headers.get('X-Sundoll-Workspace'),'first');
 await context.window.fetch('https://other.example/api/submit',{method:'POST'});
 assert.equal(calls.at(-1).opts.headers,undefined);
});
test('both template editors preserve module and campaign identity through normalization',()=>{
 const root=require('./project_paths.cjs').APP_ROOT;
 for(const [file,start,end,name] of [
   ['asset/棋子库/棋子库.html','function normalize(p)','/* ============ 全局棋子库','normalize'],
   ['主控台/host/app.js','function normalizeLibPreset(p)','/* ============ 全局棋子库','normalizeLibPreset']]){
   const code=fs.readFileSync(path.join(root,file),'utf8'),pos=code.indexOf(start);
   const ctx=vm.createContext({uid:1,canonicalPortraitPath:x=>x,normalizePortraitVariants:x=>x||[],normalizeSpellRange:x=>x,SundollSize:{normalize:()=>({size:1})}});
   vm.runInContext(fs.readFileSync(path.join(root,'shared/rules.js'),'utf8'),ctx);
   vm.runInContext(code.slice(pos,code.indexOf(end,pos)),ctx);
   const initiativePortrait={iconImgPath:'/api/module-assets/'+'a'.repeat(64)};
   const p=ctx[name]({id:'t',name:'守卫',moduleId:'source',campaignId:'run',ruleSource:'2024',initiativePortrait});
   assert.equal(p.moduleId,'source');assert.equal(p.campaignId,'run');assert.equal(p.ruleSource,'2024');
   assert.equal(p.initiativePortrait.iconImgPath,initiativePortrait.iconImgPath);
 }
});
