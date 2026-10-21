const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=readClientSource('主控台/host/app.js','utf8');
function fn(name){const start=source.indexOf(`async function ${name}(`);return source.slice(start,source.indexOf('\n}',start)+2);}
function fixture({backupFails=false, backupMismatch=false}={}){
 const writes=[];const files=new Map([['战役/c1-旧名/当前存档.json','original']]);
 const c=vm.createContext({Date,JSON,Number,String,state:{campaignId:'c1',maps:[]},streamDirty:false,
  ensureSaveFolderAccess:async()=>true,safeCampaignId:x=>x,usingLocalSaveBridge:()=>false,
  campaignGet:async()=>({_folderName:'c1-旧名',_path:'战役/c1-旧名/当前存档.json'}),
  campaignLoadedHashes:new Map(),
  writeCurrentCampaign:async(p,data)=>{const text=JSON.stringify(data,null,2);writes.push(p);files.set(p,text);return 'new-hash';},
  SAVE_CAMPAIGN_DIR:'战役',campaignRecordsCache:[],campaignFolderName:(id,name)=>`${id}-${name}`,
  readBoundText:async p=>files.get(p),
  writeBoundText:async(p,t)=>{writes.push(p);if(backupFails&&p.includes('自动备份'))return false;files.set(p,backupMismatch&&p.includes('自动备份')?'truncated':t);return true;},
  campaignPackage:(id,name,state,savedAt)=>({campaignId:id,campaignName:name,state,savedAt}),
  trimAutomaticBackups:async()=>{},writeSaveIndex:async()=>{},
  deleteBoundEntry:async()=>{throw Error('must not delete original folder');},
 });
 vm.runInContext(source.slice(source.indexOf('function campaignRecordSummary'),source.indexOf('async function readCampaignRecords')),c);
 for(const n of ['writeVerifiedCampaign','writeCampaignRecord'])vm.runInContext(fn(n),c);
 return {c,files,writes};
}
test('renaming campaign keeps its original directory and history',async()=>{
 const {c,files,writes}=fixture();const result=await c.writeCampaignRecord('c1','新名',{maps:[]},{backup:true,savedAt:100});
 assert.equal(result._folderName,'c1-旧名');assert.equal(result.name,'新名');
 assert.equal(files.get('战役/c1-旧名/自动备份/100.json'),'original');
 assert.ok(writes.every(p=>p.startsWith('战役/c1-旧名/')));
 assert.equal(JSON.parse(files.get('战役/c1-旧名/当前存档.json')).campaignName,'新名');
});
for(const mode of ['backupFails','backupMismatch'])test(`${mode} prevents overwriting current save`,async()=>{
 const {c,files,writes}=fixture({[mode]:true});
 await assert.rejects(c.writeCampaignRecord('c1','新名',{}, {backup:true}),/备份未能完整写入/);
 assert.equal(files.get('战役/c1-旧名/当前存档.json'),'original');assert.equal(writes.length,1);
});
test('rotation retains all recovery and manual snapshots while limiting timestamp backups',async()=>{
 const deleted=[];
 const entries=Array.from({length:12},(_,i)=>({name:`${i+100}.json`,lastModified:i}));
 entries.push({name:'读取前恢复点-1.json',lastModified:0},{name:'人工备份.json',lastModified:0});
 const c=vm.createContext({SAVE_CAMPAIGN_DIR:'战役',listBoundFiles:async()=>entries,deleteBoundEntry:async p=>deleted.push(p)});
 vm.runInContext(fn('trimAutomaticBackups'),c);await c.trimAutomaticBackups('c1');
 assert.deepEqual(deleted,['战役/c1/自动备份/101.json','战役/c1/自动备份/100.json']);
});
