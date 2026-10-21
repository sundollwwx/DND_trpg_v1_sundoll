const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
class Element{
 click(){this.clicked=true;}
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.attributes={};this.dataset={};}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}
 all(){return[this,...this.children.flatMap(c=>c.all())];}querySelectorAll(s){return this.all().slice(1).filter(e=>s===e.tag);}showModal(){this.open=true;}close(){this.open=false;}
}
function setup(options={}){
 const body=new Element('body'),state={campaignId:'c1'},calls=[],notifications=[],receipts=new Map();let loseReply=false;
 let packages={revision:'context-1',selectionRevision:2,sourcePackageId:'campaign:c1',enabledPackageIds:['general:base','campaign:c1'],missingPackageIds:[],packages:[{id:'general:base',scope:'general',name:'通用包',available:true},{id:'campaign:c1',scope:'campaign',name:'本战役',available:true},{id:'campaign:c2',scope:'campaign',name:'另一战役',available:true}]};
 const browser=options.browser||new Map();
 const context={STORAGE_KEY:'room-scope',localStorage:{getItem:key=>browser.get(key),setItem:(key,value)=>browser.set(key,value)},Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:()=>1,confirm:()=>options.confirm!==false,campaignRecordsCache:null,syncLibraryWithFolder:async()=>{},refreshHostHome:async()=>{},localSaveApiRequest:async(op,command={})=>{calls.push({op,...command});return options.recovery?options.recovery(op,command):{ok:true,records:[],notice:'原存档保留'};},location:{assign:url=>calls.push({navigate:url})},window:{...(options.room?{SundollRoom:{id:'r'+'1'.repeat(32)}}:{}),PlayerBackpack:{contextChanged:()=>notifications.push('bag')},ItemLibrary:{contextChanged:()=>notifications.push('library')},MapItems:{contextChanged:()=>notifications.push('map')}},document:{body,createElement:tag=>new Element(tag)},state,streamDirty:false,File:class{},crypto:{randomUUID:()=> 'package-request-unique'},queueCurrentFolderSave:async()=>true,fetch:async(_url,args)=>{
  if(_url==='/api/account/config')return {ok:true,json:async()=>({enabled:!!options.email,roomsEnabled:!!options.rooms})};
  const command=JSON.parse(args.body);calls.push(command);let result={};
  if(command.op==='overview')result={campaigns:[{id:'c1',name:'海岛',state:{maps:[]}}],archivedCampaigns:[],players:options.players||[],general:[],modules:[],capabilities:{emailAccounts:!!options.email,spaceAccounts:!!options.email&&!!options.rooms,roomWorkspace:!!options.room,manageMembers:!!options.room&&!options.dm,workspaceBackups:!(options.email&&options.rooms)}};
  if(command.op==='content-packages')result={packageContext:packages};
  if(command.op==='set-content-packages'){
   if(!receipts.has(command.requestId)){packages={...packages,revision:'context-2',selectionRevision:3,enabledPackageIds:command.enabledPackageIds};receipts.set(command.requestId,packages);}
   if(loseReply){loseReply=false;throw Error('lost reply');}result={packageContext:receipts.get(command.requestId)};
  }
  return {ok:true,status:200,json:async()=>({ok:true,...JSON.parse(JSON.stringify(result))})};
 }};vm.createContext(context);vm.runInContext(readClientSource('主控台/host/modules.js'),context);
 return {api:context.window.SundollModules,state,calls,notifications,body,browser,button:text=>body.all().find(e=>e.tag==='button'&&e.textContent===text),input:name=>body.all().find(e=>e.attributes['aria-label']==='启用内容包：'+name),lose(){loseReply=true;}};
}
test('campaign package controls retain its own source and apply an explicit selection',async()=>{
 const f=setup();await f.api.open();await f.button('启用内容包').onclick();assert.equal(f.input('本战役').checked,true);assert.equal(f.input('本战役').disabled,true);assert.equal(f.input('通用包').checked,true);
 f.input('另一战役').checked=true;f.input('通用包').checked=false;await f.button('保存启用内容包').onclick();const write=f.calls.find(c=>c.op==='set-content-packages');assert.deepEqual(write.enabledPackageIds,['campaign:c1','campaign:c2']);assert.equal(write.revision,2);assert.equal(f.state.packageContextRevision,'context-2');assert.deepEqual(f.notifications,['bag','library','map']);
});
test('unknown package selection result is retried with the exact command',async()=>{
 const f=setup();await f.api.open();await f.button('启用内容包').onclick();f.input('另一战役').checked=true;f.lose();await f.button('保存启用内容包').onclick();assert.equal(f.input('另一战役').disabled,true);await f.button('核对并重试原操作').onclick();const writes=f.calls.filter(c=>c.op==='set-content-packages');assert.equal(writes.length,2);assert.equal(JSON.stringify(writes[0]),JSON.stringify(writes[1]));assert.equal(f.state.packageContextRevision,'context-2');
});

test('email multi-room mode hides unavailable private backup operations',async()=>{
 const f=setup({email:true,rooms:true,room:true});await f.api.open('backups');
 const tab=f.body.all().find(e=>e.dataset.tab==='backups');
 assert.equal(tab.hidden,true);assert.equal(f.calls.some(c=>String(c.op||'').startsWith('backup')),false);
 assert.ok(f.button('新建战役'));
});
test('imported player profiles direct the owner to explicit email binding after saving',async()=>{
 const f=setup({email:true,rooms:true,room:true,players:[{name:'旧角色',playerId:'p1',characters:2}]});
 await f.api.open('players');
 assert.equal(f.body.all().some(e=>e.textContent.includes('以玩家名字登录')),false);
 await f.button('成员与角色归属').onclick();
 assert.deepEqual(f.calls.at(-1),{navigate:'/account#manage=r'+'1'.repeat(32)});
});

test('ordinary room DMs are directed to the creator instead of an unavailable member management button',async()=>{
 const f=setup({email:true,rooms:true,room:true,dm:true,players:[{name:'旧角色',playerId:'p1',characters:2}]});
 await f.api.open('players');
 assert.equal(f.button('成员与角色归属'),undefined);
 await f.api.open('migration');
 assert.equal(f.button('前往邮箱连接与完整清单'),undefined);
 assert.ok(f.body.all().some(e=>e.textContent.includes('邮箱连接由此空间创建者完成')));
});

function recoveryRecord(valid=true){return {id:'战役/海岛/自动备份/同步冲突草稿-1.json',path:'战役/海岛/自动备份/同步冲突草稿-1.json',campaignName:'海岛',reason:'同步冲突草稿',createdAt:1,mapCount:2,sha256:'a'.repeat(64),valid,warnings:valid?[]:['JSON 损坏，原件保留']};}
async function expandRecovery(f){const section=f.body.all().find(e=>e.tag==='details');section.open=true;await section.ontoggle();return section;}
test('campaign recovery points are lazy, retain original downloads, and block invalid copy',async()=>{
 const f=setup({recovery:async op=>op==='recovery-list'?{records:[recoveryRecord(false)],notice:'个人角色使用当前数值，背包和钱包不回退'}:{text:'原件文本',notice:'原件保留'}});
 await f.api.open();assert.equal(f.calls.some(c=>c.op==='recovery-list'),false);
 await expandRecovery(f);assert.equal(f.button('恢复为独立副本'),undefined);assert.ok(f.button('下载原件'));
 await f.button('下载原件').onclick();const read=f.calls.find(c=>c.op==='recovery-read');assert.equal(read.expectedHash,'a'.repeat(64));assert.equal(read.recoveryId,recoveryRecord().id);assert.ok(f.body.all().some(e=>e.textContent.includes('原件已生成下载')));
});
test('uncertain recovery copy persists its exact request identity across refresh and opens no campaign',async()=>{
 const browser=new Map(),writes=[];let lose=true;
 const recovery=async(op,command)=>{if(op==='recovery-list')return {records:[recoveryRecord()],notice:'原件保留；背包和钱包不回退'};if(op==='recovery-copy'){writes.push(command);if(lose){lose=false;throw Error('lost reply');}return {ok:true,campaignId:'copy-1',notice:'原件保留；背包和钱包不回退'};}return {ok:true};};
 const a=setup({browser,recovery});await a.api.open();await expandRecovery(a);await a.button('恢复为独立副本').onclick();assert.ok(a.button('核对原副本操作'));
 const b=setup({browser,recovery});await b.api.open();await expandRecovery(b);await b.button('核对原副本操作').onclick();assert.equal(writes.length,2);assert.equal(JSON.stringify(writes[0]),JSON.stringify(writes[1]));assert.equal(b.state.campaignId,'c1');assert.equal(b.calls.some(c=>c.op==='write-campaign'),false);assert.ok(b.body.all().some(e=>e.textContent.includes('独立副本已加入战役列表')));assert.deepEqual(JSON.parse(browser.get('room-scope:recovery-copy')),[]);
});
test('recovery copy cancellation performs no write',async()=>{
 const f=setup({confirm:false,recovery:async()=>({records:[recoveryRecord()],notice:'原件保留'})});await f.api.open();await expandRecovery(f);await f.button('恢复为独立副本').onclick();assert.equal(f.calls.some(c=>c.op==='recovery-copy'),false);
});
