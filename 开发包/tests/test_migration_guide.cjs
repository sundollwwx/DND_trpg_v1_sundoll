const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.dataset={};this.textContent='';}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;this.textContent='';}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(k){delete this.attributes[k];}remove(){this.removed=true;}click(){this.clicked=true;}
 all(){return[this,...this.children.flatMap(c=>c.all())];}querySelectorAll(s){return this.all().slice(1).filter(e=>s===e.tag);}showModal(){this.open=true;}close(){this.open=false;}
}
function setup({room=true,owner=true,kind='player'}={}){
 const body=new Element('body'),calls=[],prompts=[],state={campaignId:'current'};let lost=false,next=0;
 const snapshot={campaigns:[{id:'c-old',name:'原岛屿',savedAt:1,importedProgress:true}],profiles:[{playerId:'p-old',name:'原玩家',enabled:true,imported:true}],sources:[{moduleId:'pending-source',name:'待载入角色',kind:'player',state:'pending'}]};
 class File{}
 const context={window:{...(room?{SundollRoom:{id:'r'+'1'.repeat(32)}}:{})},location:{assign:url=>calls.push({navigate:url})},document:{body,createElement:tag=>new Element(tag)},state,File,crypto:{randomUUID:()=> 'migration-operation-'+(++next)},confirm:message=>{prompts.push(message);return true;},queueCurrentFolderSave:async()=>true,syncLibraryWithFolder:async()=>{},refreshHostHome:async()=>{},campaignRecordsCache:null,fetch:async(url,args)=>{
  if(url==='/api/account/config')return{ok:true,json:async()=>({enabled:true,roomsEnabled:true})};
  const command=args.body instanceof File?{op:'upload'}:JSON.parse(args.body);calls.push({url,...command});let result={};
  if(command.op==='overview')result={capabilities:{emailAccounts:true,roomWorkspace:room,manageMembers:room&&owner,workspaceBackups:false},migration:snapshot,campaigns:[{id:'c-old',name:'原岛屿',state:{maps:[]}}],archivedCampaigns:[],players:[{name:'原玩家',playerId:'p-old',characters:2}],general:[],modules:[]};
  if(url==='/api/modules/preview')result={module:{moduleId:'uploaded-source',name:'旧文件',kind,assets:[]},ticket:'preview'};
  if(command.op==='confirm-import')snapshot.sources.push({moduleId:'uploaded-source',name:'旧文件',kind,state:'pending'});
  if(command.op==='activate-player'||command.op==='create-run'){
   if(lost){lost=false;throw Error('连接已中断');}
   const source=snapshot.sources.find(source=>source.moduleId===command.moduleId);if(source)source.state='ready';
   result=command.op==='activate-player'?{playerId:'p-old'}:{campaignId:'c-old'};
  }
  if(command.op==='export-player'||command.op==='export-campaign')result={filename:'migration.sundoll',downloadUrl:'/download/export',module:{name:'旧文件'}};
  return{ok:true,status:200,json:async()=>({ok:true,...result})};
 }};
 vm.createContext(context);vm.runInContext(readClientSource('主控台/host/modules.js'),context);
 return {body,calls,prompts,snapshot,File,api:context.window.SundollModules,button:text=>body.all().find(e=>e.tag==='button'&&e.textContent===text),texts:()=>body.all().map(e=>e.textContent).join('\n'),lose(){lost=true;}};
}
async function settle(){for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));}

test('the original workspace offers campaign and player exports in the same migration guide',async()=>{
 const f=setup({room:false});await f.api.open('migration');
 assert.match(f.texts(),/迁移到邮箱账号空间/);assert.match(f.texts(),/c-old/);assert.match(f.texts(),/p-old/);
 await f.button('导出进度').onclick();await f.button('导出玩家包').onclick();
 assert.ok(f.calls.some(c=>c.op==='export-campaign'&&c.kind==='campaign-progress'&&c.campaignId==='c-old'));
 assert.ok(f.calls.some(c=>c.op==='export-player'&&c.playerId==='p-old'));
 await f.button('前往账号页创建或选择空间').onclick();assert.equal(f.calls.at(-1).navigate,'/account');
});

test('target migration completion is refreshed from committed server state rather than local checks',async()=>{
 const f=setup();await f.api.open('migration');
 assert.match(f.texts(),/进度包已载入/);assert.match(f.texts(),/玩家包已载入 · 等待连接邮箱/);assert.match(f.texts(),/已安装，待载入/);
 f.snapshot.profiles[0].accountId='a-member';f.snapshot.sources[0].state='ready';
 await f.button('刷新迁移清单').onclick();
 assert.match(f.texts(),/已连接邮箱账号/);assert.doesNotMatch(f.texts(),/已安装，待载入/);
 await f.button('前往邮箱连接与完整清单').onclick();assert.equal(f.calls.at(-1).navigate,'/account#manage=r'+'1'.repeat(32));
});

test('an uncertain activation retains the exact operation identity for a safe explicit retry',async()=>{
 const f=setup();await f.api.open('migration');f.lose();
 await f.button('继续载入').onclick();await f.button('继续载入').onclick();
 const writes=f.calls.filter(c=>c.op==='activate-player');assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);
 assert.equal(f.snapshot.sources[0].state,'ready');
});

test('migration imports preview and explicitly load supported progress or player packages',async()=>{
 const f=setup();await f.api.open('migration');await f.button('导入进度包或玩家包').onclick();
 const input=f.body.all().filter(e=>e.tag==='input').at(-1);input.files=[new f.File()];input.onchange();await settle();
 assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/导入并载入/);
 assert.ok(f.calls.some(c=>c.op==='confirm-import'));assert.ok(f.calls.some(c=>c.op==='activate-player'&&c.moduleId==='uploaded-source'));
});

test('sharing a campaign content package cannot be mistaken for a continuation migration',async()=>{
 const f=setup({kind:'campaign-content'});await f.api.open('migration');await f.button('导入进度包或玩家包').onclick();
 const input=f.body.all().filter(e=>e.tag==='input').at(-1);input.files=[new f.File()];input.onchange();await settle();
 assert.equal(f.prompts.length,0);assert.equal(f.calls.some(c=>c.op==='confirm-import'),false);assert.match(f.texts(),/分享内容包用于新冒险/);
});
