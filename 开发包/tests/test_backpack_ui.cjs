const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const {installPendingFixture}=require('./pending_requests_fixture.cjs');
const source=readClientSource('主控台/shared/backpack.js');
class Element{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.className='';this.dataset={};this.children=[];this.attributes={};this.value='';this.events={};this.scrollTop=0;}
 append(...children){for(const c of children)c.parentElement=this;this.children.push(...children);}prepend(...children){this.children.unshift(...children);}replaceChildren(...children){this.children=children;}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.events[k]=v;}contains(n){return this===n||this.children.some(c=>c.contains(n));}
 remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(c=>c!==this);this.parentElement=null;}}
 all(){return[this,...this.children.flatMap(c=>c.all())];}
 querySelectorAll(s){return this.all().slice(1).filter(e=>s.includes(',')?s.split(',').includes(e.tag):s==='button'?e.tag==='button':s.startsWith('#')?e.id===s.slice(1):false);}
 scrollIntoView(options){(this.scrollCalls??=[]).push(options);}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}showModal(){this.open=true;}close(){this.open=false;this.events.close?.();}
}
function setup(host=false,extras={}){
 const body=new Element('body'),clone=x=>JSON.parse(JSON.stringify(x));let campaign='c1',packageRevision='pkg-1',session='session-1',id=0,pause=false,release,failAfter=false,pauseGet=false,releaseGet;
 let bag=extras.bag||{revision:1,playerId:'p1',scope:'player',history:[],items:[{id:'item1',name:'治疗药水',effect:'恢复生命值',category:'potion',rarity:'普通',consumable:true,quantity:3}]};
 Object.assign(bag.items[0],extras.item||{});if(extras.modular)bag.modular=true;
 const characters=extras.characters||[{id:'c1',name:'角色甲',ownerPlayerId:'p1',base:{hpMax:20,ac:15},runtime:{hp:20}}];
 const receipts=extras.receipts||new Map(),calls=[],nav=[];
 const windowEvents={};const context={window:{confirm:extras.confirm||(()=>false),addEventListener(name,fn){windowEvents[name]=fn;}},document:{body,activeElement:null,createElement:tag=>new Element(tag)},Option:class extends Element{constructor(label,value){super('option',label);this.value=value;}},crypto:extras.crypto||{randomUUID:()=>`test-request-${String(++id).padStart(8,'0')}`},setInterval:()=>1,clearInterval(){},fetch:async(url,args)=>{
  const data=JSON.parse(args.body);calls.push(data);const responseCampaign=campaign,responsePackage=packageRevision;
  if(extras.fetch&&url==='/api/reading-share')return extras.fetch(data);
  if(pauseGet&&data.op==='get')await new Promise(resolve=>{releaseGet=resolve;});
  if(pause && data.op!=='get')await new Promise(resolve=>{release=resolve;});
  if(data.op==='get')return{ok:true,json:async()=>({ok:true,trashSupported:extras.trashSupported!==false,transferQuantitySupported:true,profile:{name:'玩家甲'},characters:clone(characters),campaignId:responseCampaign,packageContextRevision:responsePackage,backpack:{...clone(bag),items:responsePackage==='blocked'?[]:clone(bag.items)},catalog:host?[{...bag.items[0],id:'healing'}]:[]})};
  if(extras.edit400&&data.op==='edit'){extras.edit400=false;return {ok:false,status:400,json:async()=>({ok:false,error:'物品资料无效'})};}
  if(extras.edit409&&data.op==='edit'){extras.edit409=false;bag.revision++;return {ok:false,status:409,json:async()=>({ok:false,error:'版本已更新'})};}
  if(extras.recovered&&receipts.has(data.requestId))return {ok:true,json:async()=>({ok:true,recovered:true,trashSupported:true,transferQuantitySupported:true,campaignId:responseCampaign,packageContextRevision:responsePackage,backpack:{...clone(bag),items:responsePackage==='blocked'?[]:clone(bag.items)},event:receipts.get(data.requestId)})};
  let event=receipts.get(data.requestId);
  if(!event){if(data.op==='unbind')delete bag.items[0].boundCharacterId;bag.items[0].quantity-=['use','heal'].includes(data.op)?1:0;bag.revision++;event={name:'治疗药水',effect:'恢复生命值',remaining:bag.items[0].quantity,op:data.op,at:Date.now(),delta:-1,actor:'玩家'};if(data.op==='heal')Object.assign(event,{formula:'2d4+2',dice:[2,2],bonus:2,total:6,characterId:data.characterId});bag.history.push(event);receipts.set(data.requestId,event);}
  if(failAfter){failAfter=false;throw new Error('network lost');}
  return{ok:true,json:async()=>({ok:true,trashSupported:extras.trashSupported!==false,transferQuantitySupported:true,characters:clone(characters),campaignId:responseCampaign,packageContextRevision:responsePackage,backpack:{...clone(bag),items:responsePackage==='blocked'?[]:clone(bag.items)},event})};
 }};
 if(Object.hasOwn(extras,'mobile'))context.window.matchMedia=query=>({matches:query==='(max-width: 650px)'?extras.mobile:!!extras.reducedMotion});
 const durable=installPendingFixture(context,extras.pending||{});
 vm.createContext(context);vm.runInContext(source,context);
 const api=context.window.PlayerBackpack;api.configure({host,campaignId:()=>campaign,packageContextRevision:()=>packageRevision,campaignName:()=>campaign,session:()=>session,playerId:()=> 'p1',maps:()=>nav.push('maps'),journal:()=>nav.push('journal'),library:()=>nav.push('library'),roll:extras.roll});
 const all=()=>body.all(),button=text=>all().find(e=>e.tag==='button'&&e.textContent===text),card=()=>all().find(e=>e.attributes['aria-label']==='治疗药水，3件');
 return{api,body,all,button,card,calls,bag,receipts,nav,durable,focus:()=>windowEvents.focus?.(),pauseGet(){pauseGet=true;},releaseGet(){pauseGet=false;releaseGet();},pause(){pause=true;},release(){pause=false;release();},failAfter(){failAfter=true;},campaign(value){campaign=value;},package(value){packageRevision=value;},session(value){session=value;}};
}
test('reload restores an uncertain use only as a prompt and confirms the original receipt once',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.failAfter();await f.button('使用').onclick();const original=f.calls.find(c=>c.op==='use');
 assert.equal(f.durable.storage.length,1);assert.ok(![...f.durable.storage.data.values()].join('').includes('sessionToken'));
 const next=setup(false,{bag:f.bag,receipts:f.receipts,pending:{storage:f.durable.storage}});await next.api.open();
 assert.ok(next.button('核对并重试'));assert.ok(next.calls.every(c=>c.op==='get'));assert.equal(f.bag.items[0].quantity,2);
 await next.button('核对并重试').onclick();assert.deepEqual(next.calls.find(c=>c.op==='use'),original);assert.equal(f.bag.items[0].quantity,2);assert.equal(next.durable.storage.length,0);
});
test('renewed player session after reload uses the same receipt ID and current token',async()=>{
 const f=setup(false,{pending:{state:{projectId:'fixture-project',epoch:'fixture-epoch',playerId:'p1'}}});await f.api.open();f.card().onclick();f.failAfter();await f.button('使用').onclick();
 const original=f.calls.find(c=>c.op==='use'),next=setup(false,{bag:f.bag,receipts:f.receipts,pending:{storage:f.durable.storage,state:{projectId:'fixture-project',epoch:'fixture-epoch',playerId:'p1'}}});next.session('renewed-session');await next.api.open();await next.button('核对并重试').onclick();
 const retried=next.calls.find(c=>c.op==='use');assert.equal(retried.requestId,original.requestId);assert.equal(retried.sessionToken,'renewed-session');assert.equal(next.bag.items[0].quantity,2);
});
test('a different host account cannot see or replay the previous host pending grant',async()=>{
 const state={projectId:'fixture-project',epoch:'fixture-epoch',accountId:'account-a',roomId:'room-a'},f=setup(true,{pending:{state}});await f.api.open({playerId:'p1'});f.card().onclick();f.failAfter();await f.button('使用').onclick();
 const next=setup(true,{pending:{storage:f.durable.storage,state:{...state,accountId:'account-b'}}});await next.api.open({playerId:'p1'});assert.equal(next.button('核对并重试'),undefined);assert.ok(next.calls.every(c=>c.op==='get'));
});
test('disabled durable storage blocks use while allowing read-only item display',async()=>{
 const f=setup();f.durable.storage.setItem=()=>{throw Error('quota');};await f.api.open();f.card().onclick();await f.button('使用').onclick();assert.equal(f.calls.filter(c=>c.op==='use').length,0);assert.equal(f.bag.items[0].quantity,3);assert.ok(f.all().some(e=>(e.textContent||'').includes('本次操作未发送')));
});
test('known 400 clears durable edit request and preserves its editable draft',async()=>{
 const f=setup(true,{edit400:true});await f.api.open({playerId:'p1'});f.card().onclick();await f.button('编辑物品资料').onclick();await f.button('保存').onclick();assert.equal(f.durable.storage.length,0);assert.equal(f.button('核对并重试'),undefined);assert.ok(f.button('保存'));
});
test('player backpack removes duplicate navigation and manual refresh',async()=>{
 const f=setup();await f.api.open();
 assert.equal(f.button('刷新'),undefined);
 assert.equal(f.all().some(e=>['btn-player-maps','bp-journal','bp-library'].includes(e.id)),false);
});
test('opening before the campaign finishes syncing clears the old loading notice after the new context loads',async()=>{
 const f=setup();f.pauseGet();const opening=f.api.open();
 assert.equal(f.all().find(e=>e.className==='bp-status').textContent,'正在打开背包…');
 f.campaign('c2');f.releaseGet();f.api.contextChanged();
 await opening;await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.card());
 assert.equal(f.calls.at(-1).campaignId,'c2');
 assert.equal(f.all().find(e=>e.className==='bp-status').textContent,'已同步');
});
test('magic filter separates ordinary gear from common magic and clears incompatible rarity',async()=>{
 const f=setup();f.bag.items.push({id:'letter',name:'旧信',category:'document',rarity:'',effect:'阅读',quantity:1});await f.api.open();
 const choose=label=>f.all().find(e=>e.tag==='button'&&e.textContent===label).onclick();
 await choose('魔法物品');assert.ok(f.card());assert.equal(f.all().some(e=>e.attributes['aria-label']==='旧信，1件'),false);
 const ordinary=f.all().find(e=>e.tag==='button'&&e.textContent==='普通');await ordinary.onclick();
 await choose('非魔法物品');assert.equal(f.card(),undefined);assert.ok(f.all().find(e=>e.attributes['aria-label']==='旧信，1件'));
 const menu=f.all().find(e=>e.className==='bp-rarity-menu');assert.equal(menu.hidden,true);
 await choose('全部物品');assert.ok(f.card());assert.equal(menu.hidden,false);
});
test('compact item fields keep document type and artwork while placing price below body',()=>{
 const f=setup(true),fields=f.api.extraFields({category:'document',documentType:'book',body:'第一行',image:'/existing.png',description:'旧说明'},()=>{},{compact:true});
 assert.equal(fields.wrap.children[0],fields.body);assert.equal(fields.wrap.children[1],fields.metrics);
 assert.equal(fields.wrap.all().some(e=>e.attributes['aria-label']==='物品图片'),false);
 assert.equal(fields.wrap.all().find(e=>e.attributes['aria-label']==='文书形式'),undefined);
 assert.equal(fields.read(true).documentType,'book');assert.equal(fields.read(true).image,'/existing.png');assert.equal(fields.read(true).description,'旧说明');
});
test('generic creation categories use matching illustrated fallback art',()=>{
 const f=setup(true);
 for(const category of ['potion','scroll','wondrous','gear']){
  const img=f.api.art({category}).all().find(e=>e.tag==='img');
  assert.equal(img.src,`/asset/界面/物品/通用/${category}-v1.png`);
 }
 assert.equal(f.api.art({category:'container'}).all().find(e=>e.tag==='img').src,'/asset/界面/物品/宝箱/chest-unlocked-v2.png');
});
test('double use while pending sends one command and preserves exact retry after uncertain success',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.pause();f.failAfter();
 const use=f.button('使用');const first=use.onclick();await use.onclick();await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.filter(c=>c.op==='use').length,1);f.release();await first;
 assert.equal(f.bag.items[0].quantity,2);assert.ok(f.button('核对并重试'));
 await f.button('核对并重试').onclick();
 const writes=f.calls.filter(c=>c.op==='use');assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(f.bag.items[0].quantity,2);
});
test('a delayed mutation cannot replace another session view',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.pause();const first=f.button('使用').onclick();await new Promise(r=>setImmediate(r));
 f.session('session-2');f.api.contextChanged();f.release();await first;
 assert.equal(f.button('使用'),undefined);
 assert.equal(f.calls.at(-1).op,'get');assert.equal(f.calls.at(-1).sessionToken,'session-2');
});
test('changed session refreshes instead of spending from the previously viewed bag',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.session('session-2');await f.button('使用').onclick();
 assert.equal(f.calls.filter(c=>c.op==='use').length,0);assert.equal(f.calls.at(-1).sessionToken,'session-2');
});
test('host grant controls and player use controls are distinct',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});assert.ok(h.button('＋ 发放物品'));h.card().onclick();assert.ok(h.button('保存数量'));assert.ok(h.button('使用'));
 const p=setup();await p.api.open();assert.equal(p.button('＋ 发放物品'),undefined);p.card().onclick();assert.ok(p.button('使用'));
});
test('grant form opened during loading becomes usable automatically',async()=>{
 const h=setup(true);h.pauseGet();const opening=h.api.open({playerId:'p1'});
 h.button('＋ 发放物品').onclick();assert.equal(h.button('确认发放'),undefined);
 h.releaseGet();await opening;assert.ok(h.button('确认发放'));
});
test('host grant validates quantity and custom fields, then sends the selected definition',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.button('＋ 发放物品').onclick();
 const field=label=>h.all().find(e=>e.attributes['aria-label']===label);
 h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();field('发放数量').value='0';await h.button('确认发放').onclick();
 assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
 field('发放数量').value='2';await h.button('确认发放').onclick();
 assert.equal(h.calls.at(-1).presetId,'healing');assert.equal(h.calls.at(-1).quantity,2);
 h.button('自定义物品').onclick();await h.button('确认发放').onclick();
 assert.equal(h.calls.filter(c=>c.op==='grant').length,1);
 field('物品名称').value='星光药水';field('物品效果').value='发出柔和星光';field('物品类型').value='potion';field('物品稀有度').value='普通';
 await h.button('确认发放').onclick();assert.equal(h.calls.at(-1).item.name,'星光药水');assert.equal(h.calls.at(-1).item.consumable,false);
});

test('host backpack returns to its originating profile and clears stale return action',async()=>{
 const f=setup(true);let returned=0;
 await f.api.open({playerId:'p1',onBack:()=>{returned++;}});
 assert.equal(f.button('← 返回玩家档案').hidden,false);
 await f.button('← 返回玩家档案').onclick();assert.equal(returned,1);
 assert.equal(f.all().find(e=>e.tag==='dialog').open,false);
 await f.api.open({playerId:'p2'});assert.equal(f.button('← 返回玩家档案').hidden,true);
});

test('player notes and favorites send only annotation commands',async()=>{
 const p=setup();await p.api.open();p.card().onclick();
 const notes=p.all().find(e=>e.attributes['aria-label']==='物品备注');notes.value='决战时使用';notes.oninput();
 await p.button('保存备注').onclick();assert.equal(p.calls.at(-1).op,'annotate');assert.equal(p.calls.at(-1).notes,'决战时使用');assert.equal(p.calls.at(-1).quantity,undefined);
 await p.button('收藏').onclick();assert.equal(p.calls.at(-1).op,'annotate');assert.equal(p.calls.at(-1).favorite,true);
 assert.equal(p.button('编辑物品资料'),undefined);
});
test('host edits preserve quantity and submit image and description together',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();h.button('编辑物品资料').onclick();
 const field=label=>h.all().find(e=>e.attributes['aria-label']===label);
 field('编辑物品名称').value='海雾瓶';field('编辑使用说明').value='打开后散出海雾';field('物品描述').value='来自船骸';field('物品图片').value='https://example.com/bottle.png';
 await h.button('保存').onclick();const cmd=h.calls.at(-1);assert.equal(cmd.op,'edit');assert.equal(cmd.item.name,'海雾瓶');assert.equal(cmd.item.description,'来自船骸');assert.equal(cmd.item.image,'https://example.com/bottle.png');assert.equal(cmd.quantity,undefined);
});
test('live refresh keeps drafted notes while updating item quantities',async()=>{
 const f=setup();await f.api.open();f.card().onclick();const notes=f.all().find(e=>e.attributes['aria-label']==='物品备注');notes.value='尚未保存的备注';notes.oninput();
 f.bag.items[0].quantity=8;f.bag.revision++;await f.api.changed();
 assert.equal(f.all().find(e=>e.attributes['aria-label']==='物品备注'),notes);assert.equal(notes.value,'尚未保存的备注');assert.ok(f.all().some(e=>e.attributes['aria-label']==='治疗药水，8件'));
});
test('host editor survives unrelated live updates and saves its original draft',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();h.button('编辑物品资料').onclick();const name=h.all().find(e=>e.attributes['aria-label']==='编辑物品名称');name.value='尚未保存的新名称';
 h.bag.items.push({id:'other',name:'另一件物品',category:'gear',rarity:'',consumable:false,effect:'持有',quantity:1});h.bag.revision++;await h.api.changed();
 assert.equal(h.all().find(e=>e.attributes['aria-label']==='编辑物品名称'),name);await h.button('保存').onclick();assert.equal(h.calls.at(-1).item.name,'尚未保存的新名称');
});
test('host editor cannot overwrite a changed item until fresh content is reviewed',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();h.button('编辑物品资料').onclick();const name=h.all().find(e=>e.attributes['aria-label']==='编辑物品名称');name.value='自己的草稿';
 h.bag.items[0].name='另一端改写';h.bag.revision++;await h.api.changed();await h.button('保存').onclick();assert.equal(h.calls.some(c=>c.op==='edit'),false);assert.equal(name.value,'自己的草稿');
 await h.button('载入更新').onclick();assert.equal(h.all().find(e=>e.attributes['aria-label']==='编辑物品名称').value,'另一端改写');
});
test('closed backpack never performs a live read and also closes operation windows',async()=>{
 const f=setup(false,{characters:chars});await f.api.open();f.card().onclick();await f.button('转移').onclick();const transfer=f.all().find(e=>e.attributes['aria-label']==='转移物品');
 f.all().find(e=>e.className==='backpack-dialog').close();assert.equal(transfer.open,false);const count=f.calls.length;await f.api.changed();assert.equal(f.calls.length,count);
});
test('host edits in a separate dialog that closes with the backpack',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();await h.button('编辑物品资料').onclick();const edit=h.all().find(e=>e.attributes['aria-label']==='编辑物品');assert.equal(edit.open,true);assert.ok(edit.className.includes('bp-edit-dialog'));const save=h.button('保存');h.all().find(e=>e.className==='backpack-dialog').close();assert.equal(edit.open,false);await save.onclick();assert.equal(h.calls.some(c=>c.op==='edit'),false);
});
test('live notifications are coalesced while a read is already pending',async()=>{
 const f=setup();await f.api.open();f.pauseGet();const first=f.api.changed();await f.api.changed();await f.api.changed();assert.equal(f.calls.filter(c=>c.op==='get').length,2);
 f.releaseGet();await first;await new Promise(r=>setImmediate(r));assert.ok(f.calls.filter(c=>c.op==='get').length<=3);
});

test('notes survive live updates while stale use and favorite buttons are rejected',async()=>{
 const f=setup(false,{item:{category:'gear',consumable:false,effect:'持有'}});await f.api.open();f.card().onclick();const use=f.button('使用'),favorite=f.button('收藏'),notes=f.all().find(e=>e.attributes['aria-label']==='物品备注');notes.value='我的草稿';notes.oninput();
 f.bag.items[0].consumable=true;f.bag.items[0].effect='一次性消耗';f.bag.revision++;await f.api.changed();await use.onclick();await favorite.onclick();
 assert.equal(f.calls.some(c=>c.op==='use'||c.op==='annotate'),false);assert.equal(notes.value,'我的草稿');assert.ok(f.all().some(e=>e.textContent==='持有 3 件 · 消耗品'));
 await f.button('使用').onclick();assert.equal(f.calls.at(-1).op,'use');
});
test('live item changes reject old single discard and host quantity controls',async()=>{
 const p=setup();p.bag.items[0].quantity=1;await p.api.open();p.all().find(e=>e.attributes['aria-label']==='治疗药水，1件').onclick();const discard=p.button('弃置');p.bag.items[0].quantity=3;p.bag.revision++;await p.api.changed();await discard.onclick();assert.equal(p.calls.some(c=>c.op==='discard'),false);
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();const save=h.button('保存数量');h.all().find(e=>e.attributes['aria-label']==='调整持有数量').value='0';h.bag.items[0].name='新定义';h.bag.revision++;await h.api.changed();await save.onclick();assert.equal(h.calls.some(c=>c.op==='delete'||c.op==='adjust'),false);
});
test('transfer reopens recipient choices if a role changes owner',async()=>{
 const people=[{id:'own',name:'勇者',ownerPlayerId:'p1'},{id:'ally',name:'学者',ownerPlayerId:'p2'}];const f=setup(false,{characters:people,item:{ownerCharacterId:'own'}});await f.api.open();f.card().onclick();await f.button('转移').onclick();const recipient=f.button('学者');people[1].ownerPlayerId='p3';people[1].name='另一人';await f.api.changed();await recipient.onclick();
 assert.equal(f.calls.some(c=>c.op==='transfer'),false);assert.ok(f.button('另一人'));
});
test('healing reopens choices after target identity changes and closed choices cannot spend',async()=>{
 const people=[{id:'own',name:'勇者',ownerPlayerId:'p1',revision:1},{id:'ally',name:'学者',ownerPlayerId:'p2',revision:1}];const f=setup(false,{characters:people,item:{ownerCharacterId:'own',ruleId:'healing',ruleVersion:1}});await f.api.open();f.card().onclick();await f.button('使用').onclick();const recipient=f.button('学者');people[1].ownerPlayerId='p3';people[1].name='另一人';await f.api.changed();await recipient.onclick();assert.equal(f.calls.some(c=>c.op==='heal'),false);
 const fresh=f.button('另一人');f.all().find(e=>e.className==='backpack-dialog').close();await fresh.onclick();assert.equal(f.calls.some(c=>c.op==='heal'),false);
});
test('failed edit keeps the removed healing linkage removed in its draft',async()=>{
 const h=setup(true,{item:{ruleId:'healing',ruleVersion:1},edit409:true});await h.api.open({playerId:'p1'});h.card().onclick();h.button('编辑物品资料').onclick();h.all().find(e=>e.attributes['aria-label']==='使用联动').value='';await h.button('保存').onclick();
 assert.equal(h.calls.find(c=>c.op==='edit').item.ruleId,undefined);assert.equal(h.all().find(e=>e.attributes['aria-label']==='使用联动').value,'');
});
test('failed host save displays the error inside its restored edit window',async()=>{
 const h=setup(true,{edit400:true});await h.api.open({playerId:'p1'});h.card().onclick();h.button('编辑物品资料').onclick();h.all().find(e=>e.attributes['aria-label']==='编辑物品名称').value='保留名称';await h.button('保存').onclick();const view=h.all().find(e=>e.attributes['aria-label']==='编辑物品');assert.equal(view.open,true);assert.equal(view.all().find(e=>e.className==='bp-edit-notice').textContent,'物品资料无效');assert.equal(h.all().find(e=>e.attributes['aria-label']==='编辑物品名称').value,'保留名称');
});
test('live updates preserve an in-progress host quantity adjustment',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.card().onclick();const amount=h.all().find(e=>e.attributes['aria-label']==='调整持有数量');amount.value='7';amount.oninput();h.bag.items.push({id:'other',name:'其他',category:'gear',quantity:1});h.bag.revision++;await h.api.changed();assert.equal(h.all().find(e=>e.attributes['aria-label']==='调整持有数量'),amount);await h.button('保存数量').onclick();assert.equal(h.calls.at(-1).quantity,7);
});
for(const context of ['campaign','package'])test(`receipt recovery confirms an old ${context} command without replaying its dice`,async()=>{
 let rolls=0;const f=setup(false,{recovered:true,characters:chars,item:{ruleId:'healing',ruleVersion:1,ownerCharacterId:'own'},roll:()=>rolls++});await f.api.open();f.card().onclick();await f.button('使用').onclick();f.pause();f.failAfter();const first=f.button('学者').onclick();await new Promise(r=>setImmediate(r));f.release();await first;assert.equal(f.bag.items[0].quantity,2);assert.equal(rolls,0);
 if(context==='campaign')f.campaign('c2');else f.package('blocked');f.api.contextChanged();await new Promise(r=>setImmediate(r));await f.button('核对并重试').onclick();const writes=f.calls.filter(c=>c.op==='heal');assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);assert.equal(f.calls.at(-1).op,'get');assert.equal(f.calls.at(-1).campaignId,context==='campaign'?'c2':'c1');assert.equal(f.bag.items[0].quantity,2);assert.equal(rolls,0);assert.equal(f.button('核对并重试'),undefined);if(context==='package')assert.equal(f.button('使用'),undefined);
});
test('receipt recovery waits for current character projections before exposing item actions',async()=>{
 const f=setup(false,{recovered:true});await f.api.open();f.card().onclick();f.failAfter();await f.button('使用').onclick();f.package('pkg-2');f.api.contextChanged();await new Promise(r=>setImmediate(r));
 f.pauseGet();const retry=f.button('核对并重试').onclick();await new Promise(r=>setImmediate(r));assert.equal(f.button('使用'),undefined);assert.equal(f.button('转移'),undefined);
 f.releaseGet();await retry;const writes=f.calls.filter(c=>c.op==='use');assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);assert.equal(f.bag.items[0].quantity,2);assert.equal(f.calls.at(-1).op,'get');
});
test('unrelated live update preserves discard amount and does not require extra confirmation',async()=>{
 const f=setup();await f.api.open();f.card().onclick();await f.button('弃置').onclick();const amount=f.all().find(e=>e.attributes['aria-label']==='弃置数量');amount.value='2';amount.oninput();f.bag.items.push({id:'other',name:'其他',category:'gear',quantity:1});f.bag.revision++;await f.api.changed();assert.equal(f.all().find(e=>e.attributes['aria-label']==='弃置数量'),amount);await f.button('弃置').onclick();assert.equal(f.calls.at(-1).quantity,2);
});

test('grant requires explicit selection and an empty search cannot grant the old selection',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.button('＋ 发放物品').onclick();
 assert.equal(h.button('确认发放').disabled,true);await h.button('确认发放').onclick();assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
 h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();assert.equal(h.button('确认发放').disabled,false);
 const search=h.all().find(e=>e.attributes['aria-label']==='搜索可发放物品');search.value='不存在的物品';search.oninput();
 assert.equal(h.button('确认发放').disabled,true);await h.button('确认发放').onclick();assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
 assert.equal(h.all().find(e=>e.className==='bp-grant-custom').hidden,true);
});
test('grant locks during saving and success cannot be clicked twice',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.button('＋ 发放物品').onclick();h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();
 h.pause();const submit=h.button('确认发放'),first=submit.onclick();assert.equal(submit.disabled,true);await submit.onclick();await new Promise(r=>setImmediate(r));assert.equal(h.calls.filter(c=>c.op==='grant').length,1);
 h.release();await first;assert.equal(h.button('已发放').disabled,true);await h.button('已发放').onclick();assert.equal(h.calls.filter(c=>c.op==='grant').length,1);
});
test('uncertain grant preserves custom draft and retries the original request',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});h.button('＋ 发放物品').onclick();h.button('自定义物品').onclick();
 const field=label=>h.all().find(e=>e.attributes['aria-label']===label);field('物品名称').value='潮汐护符';field('物品效果').value='发出蓝光';
 h.failAfter();await h.button('确认发放').onclick();assert.equal(field('物品名称').value,'潮汐护符');assert.equal(h.button('等待核对结果').disabled,true);
 await h.button('核对并重试').onclick();const grants=h.calls.filter(c=>c.op==='grant');assert.equal(grants.length,2);assert.deepEqual(grants[0],grants[1]);assert.equal(h.button('已发放').disabled,true);
 h.button('返回背包').onclick();h.button('＋ 发放物品').onclick();assert.equal(field('物品名称').value,'潮汐护符');
 await h.api.open({playerId:'p2'});h.button('＋ 发放物品').onclick();assert.equal(h.button('确认发放').disabled,true);assert.equal(field('物品名称').value,'');
});

test('campaign switch preserves the original command while reloading the current inventory projection',async()=>{
 const f=setup();await f.api.open();f.card().onclick();
 const notes=f.all().find(e=>e.attributes['aria-label']==='物品备注');notes.value='跨战役保留';notes.oninput();
 f.pause();const first=f.button('使用').onclick();await new Promise(r=>setImmediate(r));
 f.campaign('c2');f.api.contextChanged();f.release();await first;
 assert.equal(f.calls.filter(c=>c.op==='get').length,2);
 assert.equal(f.bag.items[0].quantity,2);assert.equal(f.button('使用'),undefined);
 await new Promise(r=>setImmediate(r));await f.all().find(e=>e.attributes['aria-label']==='治疗药水，2件').onclick();
 assert.equal(f.all().find(e=>e.attributes['aria-label']==='物品备注').value,'跨战役保留');
 assert.equal(f.calls.find(c=>c.op==='use').campaignId,'c1');
});
test('inventory opens without a campaign and header has no campaign subtitle',async()=>{
 const f=setup();f.campaign('');await f.api.open();assert.ok(f.card());
 const header=f.all().find(e=>e.tag==='header');assert.ok(!header.all().some(e=>e.className==='bp-subtitle'));
});

const chars=[{id:'own',ownerPlayerId:'p1',name:'勇者',base:{hpMax:30},runtime:{hp:8},revision:3},{id:'ally',ownerPlayerId:'p2',name:'学者',base:{hpMax:20},runtime:{hp:5},revision:6}];
test('healing uses backpack owner automatically and retries immutable roll command',async()=>{
 const rolls=[];const f=setup(false,{item:{ruleId:'healing',ruleVersion:1,ownerCharacterId:'own'},characters:chars,roll:(...args)=>rolls.push(args)});await f.api.open();f.card().onclick();
 assert.equal(f.all().find(e=>e.attributes['aria-label']==='给谁使用'),undefined);await f.button('使用').onclick();assert.equal(f.calls.filter(c=>c.op==='heal').length,0);
 assert.equal(f.all().find(e=>e.attributes['aria-label']==='使用药水的角色'),undefined);assert.ok(f.button('学者'));
 f.failAfter();await f.button('学者').onclick();await f.button('核对并重试').onclick();
 const calls=f.calls.filter(c=>c.op==='heal');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].targetRevision,6);assert.equal(calls[0].sourceCharacterId,'own');assert.equal(f.bag.items[0].quantity,2);
 assert.equal(rolls.length,1);assert.equal(rolls[0][0],4);assert.equal(rolls[0][2],6);assert.deepEqual(Array.from(rolls[0][3].dice),[2,2]);assert.equal(rolls[0][3].surface.open,true);
});
test('document reading is local and preserves literal text without consumption',async()=>{
 const f=setup(false,{item:{category:'document',rarity:'',consumable:false,body:'第一行\n<script>不执行</script>'},characters:chars});await f.api.open();f.card().onclick();
 const count=f.calls.length;await f.button('阅读').onclick();assert.equal(f.calls.length,count);assert.equal(f.button('使用'),undefined);
 assert.equal(f.all().find(e=>e.className==='bp-document-body').textContent,'第一行\n<script>不执行</script>');
});
test('item preview opens a separate detail page while documents show reading in the top-left',async()=>{
 const ordinary=setup(false);await ordinary.api.open();ordinary.card().onclick();assert.equal(ordinary.all().find(e=>e.className==='bp-detail').children[0].textContent,'查看详情');
 await ordinary.button('查看详情').onclick();assert.ok(ordinary.all().find(e=>e.className==='bp-item-detail-dialog'&&e.open));
 const document=setup(false,{item:{category:'document',body:'正文'}});await document.api.open();document.card().onclick();
 assert.equal(document.all().find(e=>e.className==='bp-detail').children[0].textContent,'阅读');
 assert.equal(document.button('查看详情'),undefined);
});
test('book editor keeps page order and reader turns pages without consuming items',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});
 const extra=f.api.extraFields({},()=>{}),field=label=>extra.wrap.all().find(e=>e.attributes['aria-label']===label);
 field('文书形式').value='book';field('文书形式').onchange();field('书籍当前页正文').value='第一章';
 await extra.wrap.all().find(e=>e.tag==='button'&&e.textContent==='＋ 新增一页').onclick();
 field('书籍当前页正文').value='第二章 <script>只是文字</script>';
 const saved=extra.read(true);assert.equal(saved.documentType,'book');assert.equal(saved.body,'第一章\f第二章 <script>只是文字</script>');
 const count=f.calls.length;f.api.openDocument({name:'旧书',category:'document',...saved});
 const page=()=>f.all().filter(e=>e.className==='bp-document-body');
 assert.equal(page()[0].textContent,'第一章');assert.equal(page()[1].textContent,'第二章 <script>只是文字</script>');
 assert.equal(f.calls.length,count);
});
test('book reader turns by two-page spreads and composer keeps the drafted pages',async()=>{
 const f=setup(true);const extra=f.api.extraFields({category:'document',documentType:'book',body:'第一页\f第二页'},()=>{},{compact:true,title:()=> '航海日志'});
 assert.equal(extra.wrap.all().some(e=>e.attributes['aria-label']==='书籍当前页正文'),false);
 await extra.wrap.all().find(e=>e.textContent==='打开书籍编辑页').onclick();
 const page1=f.all().find(e=>e.attributes['aria-label']==='第 1 页正文');page1.value='改过的第一页';page1.oninput();
 await f.button('＋ 新增一页').onclick();const page3=f.all().find(e=>e.attributes['aria-label']==='第 3 页正文');page3.value='第三页';page3.oninput();
 assert.equal(extra.read(true).body,'改过的第一页\f第二页\f第三页');
 f.api.openDocument({name:'航海日志',documentType:'book',body:extra.read(true).body});
 await f.all().filter(e=>e.tag==='button'&&e.textContent==='下一页 →').at(-1).onclick();
 const current=f.all().filter(e=>e.className==='bp-document-body');assert.equal(current.at(-1).textContent,'第三页');
});
test('letter composer keeps text without a network mutation',async()=>{
 const f=setup(true),extra=f.api.extraFields({category:'document',documentType:'letter'},()=>{},{compact:true,title:()=> '未署名信'});
 const calls=f.calls.length;await extra.wrap.all().find(e=>e.textContent==='打开信件编辑页').onclick();
 const body=f.all().find(e=>e.attributes['aria-label']==='信件正文');body.value='请到灯塔见面。';body.oninput();
 assert.equal(extra.read(true).body,'请到灯塔见面。');assert.equal(f.calls.length,calls);
});
test('document grant hides rarity and sends full body without consumption',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});f.button('＋ 发放物品').onclick();f.button('自定义物品').onclick();
 const field=label=>f.all().find(e=>e.attributes['aria-label']===label);
 field('物品类型').value='document';field('物品类型').onchange();field('物品名称').value='信';field('物品效果').value='密封信件';field('文书正文').value='请于月落之前抵达。';
 assert.equal(field('物品稀有度').parentElement.hidden,true);await f.button('确认发放').onclick();
 const cmd=f.calls.at(-1);assert.equal(cmd.item.rarity,'');assert.equal(cmd.item.consumable,false);assert.equal(cmd.item.body,'请于月落之前抵达。');
});
test('transfer chooses amount and then commits by tapping recipient once',async()=>{
 const f=setup(false,{characters:chars});await f.api.open();f.card().onclick();await f.button('转移').onclick();
 const options=f.all().find(e=>e.attributes['aria-label']==='转移给');assert.equal(options.children.length,chars.length);
 const amount=f.all().find(e=>e.attributes['aria-label']==='转移数量');assert.equal(amount.value,'1');amount.value='4';await f.button('学者').onclick();assert.equal(f.calls.filter(c=>c.op==='transfer').length,0);amount.value='2';
 await f.button('学者').onclick();assert.equal(f.calls.at(-1).quantity,2);assert.equal(f.calls.at(-1).op,'transfer');assert.equal(f.calls.at(-1).characterId,chars[1].id);
});
test('transfer cannot silently send an item edited while its target window is open',async()=>{
 const f=setup(false,{characters:chars});await f.api.open();f.card().onclick();await f.button('转移').onclick();
 const choose=f.button('学者');f.bag.items[0].name='修改后的任务物品';f.bag.items[0].resourceRevision=2;f.bag.revision++;await f.focus();await new Promise(r=>setImmediate(r));
 await choose.onclick();assert.equal(f.calls.some(c=>c.op==='transfer'),false);
 const view=f.all().filter(e=>e.attributes['aria-label']==='转移物品'&&e.open).at(-1);assert.ok(view);assert.ok(view.all().some(e=>e.textContent==='修改后的任务物品 ×3'));
 await view.all().find(e=>e.tag==='button'&&e.textContent==='学者').onclick();assert.equal(f.calls.filter(c=>c.op==='transfer').length,1);
});
test('transfer closes if its item was taken away while choosing a recipient',async()=>{
 const f=setup(false,{characters:chars});await f.api.open();f.card().onclick();await f.button('转移').onclick();
 const view=f.all().find(e=>e.attributes['aria-label']==='转移物品'),choose=f.button('学者');f.bag.items=[];f.bag.revision++;await f.focus();await new Promise(r=>setImmediate(r));
 await choose.onclick();assert.equal(f.calls.some(c=>c.op==='transfer'),false);assert.equal(view.open,false);
});

test('host deletion and player discard require an explicit inline confirmation',async()=>{
 const host=setup(true);await host.api.open({playerId:'p1'});host.card().onclick();
 assert.equal(host.button('弃置'),undefined);await host.button('删除').onclick();assert.equal(host.calls.filter(c=>c.op==='delete').length,0);
 assert.equal(host.all().find(e=>e.className==='bp-removal-summary').textContent,'删除「治疗药水」×3，剩余 ×0');
 await host.button('取消').onclick();assert.equal(host.calls.filter(c=>c.op==='delete').length,0);
 await host.button('删除').onclick();await host.button('确认删除').onclick();assert.equal(host.calls.at(-1).op,'delete');
 const player=setup();await player.api.open();player.card().onclick();assert.equal(player.button('删除'),undefined);
 await player.button('弃置').onclick();const qty=player.all().find(e=>e.attributes['aria-label']==='弃置数量');qty.value='2';qty.oninput();
 assert.equal(player.all().find(e=>e.className==='bp-removal-summary'),undefined);
 assert.equal(player.button('全部弃置'),undefined);
 assert.equal(player.button('弃置').parentElement,player.button('取消').parentElement);
 await player.button('弃置').onclick();assert.equal(player.calls.at(-1).op,'discard');assert.equal(player.calls.at(-1).quantity,2);
});
test('discard quantity rejects invalid input and supports whole stack',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.button('弃置').onclick();
 const qty=f.all().find(e=>e.attributes['aria-label']==='弃置数量');qty.value='4';qty.oninput();assert.equal(f.button('弃置').disabled,true);await f.button('弃置').onclick();assert.equal(f.calls.filter(c=>c.op==='discard').length,0);
 qty.value='3';qty.oninput();assert.equal(qty.value,'3');assert.equal(f.calls.filter(c=>c.op==='discard').length,0);await f.button('弃置').onclick();assert.equal(f.calls.at(-1).quantity,3);
});
test('confirmation from an earlier backpack revision cannot delete newly granted items',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});f.card().onclick();f.button('删除').onclick();const confirm=f.button('确认删除');
 f.bag.revision++;f.bag.items[0].quantity=9;await f.api.open({playerId:'p1'});await confirm.onclick();assert.equal(f.calls.filter(c=>c.op==='delete').length,0);
});
test('trash is collapsed on both clients and player can reclaim own discard',async()=>{
 const h=setup(true);h.bag.removedItems=[{id:'removed-record-001',op:'discard',at:Date.now(),item:{name:'信件',quantity:1}}];await h.api.open({playerId:'p1'});
 const section=h.all().find(e=>e.className==='bp-removed');assert.equal(!!section.open,false);const restore=h.all().find(e=>e.attributes['aria-label']==='恢复 信件 ×1');assert.ok(restore);await restore.onclick();assert.equal(h.calls.at(-1).op,'restore');assert.equal(h.calls.at(-1).removalId,'removed-record-001');
 const p=setup();p.bag.removedItems=[{id:'player-discard-0001',op:'discard',at:Date.now(),item:{name:'信件',quantity:1}}];await p.api.open();assert.ok(p.all().find(e=>e.className==='bp-removed'));await p.button('收回').onclick();assert.equal(p.calls.at(-1).op,'restore');assert.equal(p.button('彻底删除'),undefined);
});
test('permanent removal requires a second host click and targets only the removed record',async()=>{
 const h=setup(true);h.bag.removedItems=[{id:'removed-record-001',op:'delete',at:Date.now(),item:{name:'密信',quantity:1}}];await h.api.open({playerId:'p1'});
 const action=h.all().find(e=>e.attributes['aria-label']==='彻底删除 密信 ×1');assert.ok(action);
 await action.onclick();assert.equal(h.calls.filter(c=>c.op==='purge').length,0);
 const confirm=h.all().find(e=>e.attributes['aria-label']==='确认彻底删除 密信 ×1');assert.ok(confirm);
 await confirm.onclick();assert.equal(h.calls.at(-1).op,'purge');assert.equal(h.calls.at(-1).removalId,'removed-record-001');
 const p=setup();await p.api.open();assert.equal(p.all().find(e=>e.textContent==='彻底删除'),undefined);
});
test('uncertain discard keeps the same request and quantity during retry',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.button('弃置').onclick();const qty=f.all().find(e=>e.attributes['aria-label']==='弃置数量');qty.value='3';qty.oninput();f.failAfter();await f.button('弃置').onclick();await f.button('核对并重试').onclick();const calls=f.calls.filter(c=>c.op==='discard');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});

test('value and weight totals multiply quantities and disclose unknowns separately from zero',()=>{
 const t=setup(true),api=t.api;
 assert.match(api.totalText([{quantity:3,valueCp:1250,weightLb:0.25},{quantity:1},{quantity:2,valueCp:0,weightLb:0},{quantity:0,valueCp:90000,weightLb:900}]),/已知价值 37.5 金币（另有 1 种未定价） · 已知重量 0.75 磅（另有 1 种未填重量）/);
 assert.match(api.facts({valueCp:0,weightLb:0}),/0 金币.*0 磅/);
 assert.match(api.facts({}),/未知.*未知/);
});

test('grant keeps the reviewed template version even after a background catalog refresh',async()=>{
 const h=setup(true,{item:{version:1}});await h.api.open({playerId:'p1'});await h.button('＋ 发放物品').onclick();await h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();
 h.bag.items[0].version=2;await h.focus();await h.button('确认发放').onclick();
 const cmd=h.calls.find(c=>c.op==='grant');assert.equal(cmd.templateId,'healing');assert.equal(cmd.templateVersion,1);
});
test('custom price converts currency exactly and rejects fractional copper or negative pounds',async()=>{
 const h=setup(true);await h.api.open({playerId:'p1'});await h.button('＋ 发放物品').onclick();await h.button('自定义物品').onclick();
 const field=label=>h.all().find(e=>e.attributes['aria-label']===label);
 field('物品名称').value='铜钥匙';field('物品效果').value='开门';field('单件价值').value='12.5';field('价值币种').value='sp';field('价值币种').onchange();assert.equal(field('单件价值').value,'125');field('单件重量（磅）').value='-1';
 await h.button('确认发放').onclick();assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
 field('单件重量（磅）').value='0.25';await h.button('确认发放').onclick();const cmd=h.calls.find(c=>c.op==='grant');assert.equal(cmd.item.valueCp,1250);assert.equal(cmd.item.weightLb,0.25);
});

test('discard works on HTTP browsers without randomUUID and double click sends once',async()=>{
 const f=setup(false,{crypto:{getRandomValues:require('node:crypto').webcrypto.getRandomValues.bind(require('node:crypto').webcrypto)}});
 await f.api.open();f.card().onclick();f.button('弃置').onclick();const discard=f.button('弃置');
 assert.equal(discard.disabled,false);f.pause();const first=discard.onclick();await discard.onclick();await new Promise(r=>setImmediate(r));f.release();await first;
 const commands=f.calls.filter(c=>c.op==='discard');assert.equal(commands.length,1);assert.match(commands[0].requestId,/^[0-9a-f]{32}$/);assert.equal(commands[0].quantity,1);
});

test('modular grant defaults to the main bag and can target a same-name role',async()=>{
 const characters=[{id:'c1',name:'同名',ownerPlayerId:'p1',base:{hpMax:24,ac:16},runtime:{hp:24}},{id:'c2',name:'同名',ownerPlayerId:'p1',base:{hpMax:43,ac:17},runtime:{hp:43}}];
 const h=setup(true,{modular:true,characters,item:{ownerCharacterId:'c1'}});await h.api.open({playerId:'p1'});
 assert.equal(h.all().some(e=>e.textContent==='玩家公共仓库'),false);
 assert.ok(h.card());
 h.button('＋ 发放物品').onclick();h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();
 assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
 const target=h.all().find(e=>e.attributes['aria-label']==='接收角色');target.value='c2';target.onchange();
 await h.button('确认发放').onclick();assert.equal(h.calls.find(c=>c.op==='grant').characterId,'c2');
 const picker=h.all().find(e=>e.attributes['aria-label']==='选择角色背包');assert.equal(picker.value,'c2');
 assert.equal(h.card(),undefined);picker.value='c1';picker.onchange();assert.ok(h.card());
});
test('a player with no character cannot receive a grant',async()=>{
 const h=setup(true,{modular:true,characters:[]});await h.api.open({playerId:'p1'});h.button('＋ 发放物品').onclick();
 h.all().find(e=>e.attributes['aria-label']==='选择物品：治疗药水').onclick();await h.button('确认发放').onclick();
 assert.equal(h.button('确认发放').disabled,true);assert.equal(h.calls.filter(c=>c.op==='grant').length,0);
});
test('unassigned legacy items are only visible in the explicit host repair view',async()=>{
 const characters=[{id:'c1',name:'甲',ownerPlayerId:'p1',base:{hpMax:24,ac:16}},{id:'c2',name:'乙',ownerPlayerId:'p1',base:{hpMax:43,ac:17}}];
 const p=setup(false,{modular:true,characters});await p.api.open();assert.equal(p.card(),undefined);
 const pp=p.all().find(e=>e.attributes['aria-label']==='选择角色背包');assert.equal(pp.children.some(e=>e.value==='__unassigned__'),false);
 const h=setup(true,{modular:true,characters});await h.api.open({playerId:'p1'});assert.equal(h.card(),undefined);
 const hp=h.all().find(e=>e.attributes['aria-label']==='选择角色背包');hp.value='__unassigned__';hp.onchange();assert.ok(h.card());
});

test('player favorite and transfer are adjacent matching actions and selector opens on demand',async()=>{
 const f=setup();await f.api.open();f.card().onclick();
 const row=f.all().find(e=>e.className==='bp-item-quick-actions');
 assert.deepEqual(row.children.map(e=>e.textContent),['使用','转移','收藏','弃置']);
 assert.equal(row.children[1].className,row.children[2].className);
 assert.equal(f.all().some(e=>e.className==='bp-transfer-picker'),false);
 await row.children[1].onclick();assert.ok(f.all().find(e=>e.attributes['aria-label']==='转移给'));
});
const readingInvitation=(changes={})=>({shareId:'share-1',campaignId:'c1',senderId:'p2',senderName:'玩家乙',name:'一封信',documentType:'letter',recipients:['p1'],expiresAt:Date.now()+120000,...changes});
test('reading invitations require consent; rejection does not fetch a body or consume an item',async()=>{
 const f=setup();f.api.receiveReadingInvite(readingInvitation());
 assert.ok(f.button('否，暂不阅读'));assert.equal(f.calls.length,0);
 await f.button('否，暂不阅读').onclick();assert.equal(f.calls.length,0);
 assert.equal(f.all().some(e=>e.className.includes('bp-reader-dialog')),false);
 f.api.receiveReadingInvite(readingInvitation());assert.equal(f.all().filter(e=>e.className==='bp-reading-invite'&&e.open).length,0);
});
test('accept opens the shared book without granting it and hides reshare',async()=>{
 const f=setup(false,{fetch:async data=>({ok:true,json:async()=>({ok:true,item:{name:'手记',category:'document',documentType:'book',body:'第一页\f第二页\f第三页'}})})});
 f.api.receiveReadingInvite(readingInvitation({documentType:'book'}));await f.button('是，一起阅读').onclick();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'accept');assert.equal(f.calls[0].sessionToken,'session-1');
 assert.ok(f.all().find(e=>e.attributes['aria-label']==='阅读手记'&&e.open));assert.equal(f.button('共享'),undefined);
 assert.equal(f.bag.items[0].quantity,3);
});
test('unrelated, expired, own and other-campaign invitations never prompt',()=>{
 const f=setup();for(const change of [{recipients:['p3']},{senderId:'p1'},{expiresAt:Date.now()-1},{campaignId:'elsewhere'}])f.api.receiveReadingInvite(readingInvitation(change));
 assert.equal(f.button('是，一起阅读'),undefined);
});
test('sharing a reader sends only its item ID and keeps the reader open',async()=>{
 const f=setup(false,{fetch:async data=>({ok:true,json:async()=>({ok:true,recipientCount:2})})});
 const reader=f.api.openDocument({id:'letter-1',name:'信',category:'document',documentType:'letter',body:'正文'});
 await f.button('共享').onclick();assert.equal(f.calls[0].op,'invite');assert.equal(f.calls[0].itemId,'letter-1');assert.equal(f.calls[0].body,undefined);assert.equal(reader.open,true);
});
test('late acceptance cannot open private reading after identity changes or rejection',async()=>{
 let release;const f=setup(false,{fetch:()=>new Promise(resolve=>release=()=>resolve({ok:true,json:async()=>({ok:true,item:{name:'信',category:'document',documentType:'letter',body:'内容'}})}))});
 f.api.receiveReadingInvite(readingInvitation());const waiting=f.button('是，一起阅读').onclick();
 f.session('new-session');f.api.contextChanged();release();await waiting;
 assert.equal(f.all().some(e=>e.className.includes('bp-reader-dialog')&&e.open),false);
});

for(const host of [false,true])test(`main character wins over first companion and manual selection stays host=${host}`,async()=>{
 const characters=[{id:'pet',name:'仆从',collectionRole:'companion',ownerPlayerId:'p1'},{id:'hero',name:'主角',collectionRole:'main',ownerPlayerId:'p1'}];
 const f=setup(host,{modular:true,characters,item:{ownerCharacterId:'hero'}});await f.api.open({playerId:'p1'});
 const picker=()=>f.all().find(e=>e.attributes['aria-label']==='选择角色背包');assert.equal(picker().value,'hero');assert.ok(f.card());
 picker().value='pet';picker().onchange();assert.equal(picker().value,'pet');assert.equal(f.card(),undefined);
 await f.api.open({playerId:'p1'});assert.equal(picker().value,'hero');
 await f.api.open({playerId:'p1',characterId:'pet'});assert.equal(picker().value,'pet');
});

test('single item discard takes one action and player trash never offers purge',async()=>{
 const f=setup(false,{item:{quantity:1}});f.bag.removedItems=[];await f.api.open();
 await f.all().find(e=>e.attributes['aria-label']==='治疗药水，1件').onclick();await f.button('弃置').onclick();
 assert.equal(f.calls.filter(c=>c.op==='discard').length,1);assert.equal(f.calls.at(-1).quantity,1);
 assert.equal(f.button('清空垃圾箱'),undefined);assert.equal(f.button('彻底删除'),undefined);
});
test('DM clearing trash needs confirmation and refuses a changed revision',async()=>{
 const f=setup(true);f.bag.removedItems=[{id:'trash1',op:'discard',at:Date.now(),item:{name:'药水',quantity:1}}];await f.api.open({playerId:'p1'});
 await f.button('清空垃圾箱').onclick();assert.equal(f.calls.some(c=>c.op==='purgeAll'),false);const confirm=f.button('确认清空');
 f.bag.revision++;await f.api.open({playerId:'p1'});await confirm.onclick();assert.equal(f.calls.some(c=>c.op==='purgeAll'),false);
 await f.button('清空垃圾箱').onclick();await f.button('确认清空').onclick();assert.equal(f.calls.at(-1).op,'purgeAll');
});
test('host editor can switch consumption and persist map defaults with full content',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});f.card().onclick();await f.button('编辑物品资料').onclick();
 const field=name=>f.all().find(e=>e.attributes['aria-label']===name);
 field('物品类型').value='gear';field('物品类型').onchange();field('消耗品').checked=false;field('默认固定位置').checked=true;field('允许玩家拾取').checked=false;
 await f.button('保存').onclick();const command=f.calls.at(-1);
 assert.equal(command.op,'edit');assert.equal(command.item.category,'gear');assert.equal(command.item.consumable,false);assert.equal(command.item.mapDefaults.pickupAllowed,false);assert.equal(command.item.mapDefaults.positionLocked,true);
});
test('double recipient tap cannot heal or transfer twice while saving',async()=>{
 const f=setup(false,{item:{ruleId:'healing',ruleVersion:1,ownerCharacterId:'own'},characters:chars});await f.api.open();f.card().onclick();await f.button('使用').onclick();f.pause();const recipient=f.button('学者');const first=recipient.onclick();await recipient.onclick();await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.op==='heal').length,1);f.release();await first;
});

test('DM quantity zero goes through trash deletion rather than hiding an unarchived stack',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});f.card().onclick();f.all().find(e=>e.attributes['aria-label']==='调整持有数量').value='0';
 await f.button('保存数量').onclick();assert.equal(f.calls.at(-1).op,'delete');assert.equal(f.calls.at(-1).itemId,f.bag.items[0].id);
});
test('durable potion editing clears automatic consumable healing',async()=>{
 const f=setup(true,{item:{ruleId:'healing',ruleVersion:1}});await f.api.open({playerId:'p1'});f.card().onclick();await f.button('编辑物品资料').onclick();
 const consume=f.all().find(e=>e.attributes['aria-label']==='消耗品');consume.checked=false;consume.onchange();await f.button('保存').onclick();
 assert.equal(f.calls.at(-1).item.consumable,false);assert.equal(f.calls.at(-1).item.ruleId,undefined);
});

test('long item prose belongs to the detail window rather than the quick use panel',async()=>{
 const story='完整规则与背景故事';const f=setup(false,{item:{description:story}});await f.api.open();f.card().onclick();
 const detail=f.all().find(e=>e.className==='bp-detail');assert.equal(detail.all().some(e=>e.textContent===story),false);
 await f.button('查看详情').onclick();assert.ok(f.all().some(e=>e.textContent===story));
});
test('older server does not expose unsupported player trash recovery or DM clearing',async()=>{
 for(const host of [true,false]){
  const f=setup(host,{trashSupported:false});f.bag.removedItems=[{id:'trash1',op:'discard',at:Date.now(),item:{name:'药水',quantity:1}}];await f.api.open({playerId:'p1'});
  assert.equal(f.button('清空垃圾箱'),undefined);if(!host)assert.equal(f.all().find(e=>e.className==='bp-removed').hidden,true);
 }
});


test('same-campaign package change clears old items and detail windows before the new read returns',async()=>{
 const f=setup();await f.api.open();f.card().onclick();await f.button('查看详情').onclick();const detail=f.all().find(e=>e.className==='bp-item-detail-dialog');
 f.pauseGet();f.package('blocked');f.api.contextChanged();assert.equal(f.card(),undefined);assert.equal(detail.open,false);assert.equal(f.button('使用'),undefined);
 f.releaseGet();await new Promise(r=>setImmediate(r));assert.equal(f.card(),undefined);
 f.package('pkg-2');f.api.contextChanged();await new Promise(r=>setImmediate(r));assert.ok(f.card());assert.equal(f.bag.items[0].quantity,3);
});
test('uncertain old-context item operation keeps its original request while only rendering the new projection',async()=>{
 const f=setup();await f.api.open();f.card().onclick();f.failAfter();await f.button('使用').onclick();const original=f.calls.find(c=>c.op==='use');assert.equal(original.packageContextRevision,'pkg-1');
 f.package('blocked');f.api.contextChanged();await new Promise(r=>setImmediate(r));assert.equal(f.card(),undefined);await f.button('核对并重试').onclick();
 assert.deepEqual(f.calls.filter(c=>c.op==='use'),[original,original]);assert.equal(f.bag.items[0].quantity,2);assert.equal(f.button('使用'),undefined);
});
test('direct grants explicitly identify generic campaign and personal sources',async()=>{
 const f=setup(true);await f.api.open({playerId:'p1'});f.button('＋ 发放物品').onclick();f.button('自定义物品').onclick();const field=label=>f.all().find(e=>e.attributes['aria-label']===label);
 const source=field('物品归属');assert.deepEqual(source.children.map(e=>e.value),['general','personal','campaign']);source.value='personal';field('物品名称').value='角色乐谱';field('物品效果').value='演奏';await f.button('确认发放').onclick();
 const grant=f.calls.find(c=>c.op==='grant');assert.equal(grant.scope,'personal');assert.equal(grant.item.scope,'personal');assert.equal(grant.characterId,'c1');assert.equal(grant.packageContextRevision,'pkg-1');
});
test('personal inventory instances cannot be offered as global templates',async()=>{
 const f=setup(true,{item:{sourceScope:'personal'}});await f.api.open({playerId:'p1'});f.card().onclick();assert.equal(f.button('另存为物品模板'),undefined);
});


test('bound personal items cannot be transferred by the player',async()=>{
 const f=setup(false,{item:{sourceScope:'personal',boundCharacterId:'own',ownerCharacterId:'own'},characters:chars});await f.api.open();f.card().onclick();assert.equal(f.button('转移').disabled,true);await f.button('转移').onclick();assert.equal(f.calls.some(c=>c.op==='transfer'),false);
});
test('host must explicitly confirm releasing a personal binding before transfer',async()=>{
 let approved=false,confirmed=0;const f=setup(true,{item:{sourceScope:'personal',boundCharacterId:'own',ownerCharacterId:'own'},characters:chars,confirm:()=>{confirmed++;return approved;}});await f.api.open({playerId:'p1'});f.card().onclick();await f.button('转移').onclick();await f.button('学者').onclick();assert.equal(confirmed,1);assert.equal(f.calls.some(c=>c.op==='transfer'),false);approved=true;await f.button('学者').onclick();const transfer=f.calls.find(c=>c.op==='transfer');assert.equal(transfer.releaseBinding,undefined);assert.equal(transfer.characterId,'ally');assert.deepEqual(f.calls.filter(c=>c.op!=='get').map(c=>c.op),['unbind','transfer']);assert.notEqual(f.calls.find(c=>c.op==='unbind').requestId,transfer.requestId);
});


test('the same character keeps inventory quantities while campaign changes hide and restore its source items',async()=>{
 const f=setup(false,{modular:true,item:{ownerCharacterId:'c1'}});await f.api.open();assert.ok(f.card());f.campaign('c2');f.package('blocked');f.api.contextChanged();await new Promise(r=>setImmediate(r));assert.equal(f.card(),undefined);assert.equal(f.calls.some(c=>c.op!=='get'),false);
 f.campaign('c1');f.package('pkg-1');f.api.contextChanged();await new Promise(r=>setImmediate(r));assert.ok(f.card());assert.equal(f.bag.items[0].quantity,3);assert.equal(f.bag.items[0].ownerCharacterId,'c1');
});

test('mobile selection scrolls to detail but refresh and return preserve the open draft without writes',async()=>{
 const f=setup(false,{mobile:true});await f.api.open();
 const detail=f.all().find(e=>e.className==='bp-detail'),items=f.all().find(e=>e.className==='bp-items');
 assert.equal(detail.scrollCalls,undefined);await f.card().onclick();assert.equal(detail.scrollCalls.length,1);assert.equal(detail.scrollCalls[0].behavior,'smooth');
 const notes=f.all().find(e=>e.attributes['aria-label']==='物品备注');notes.value='尚未保存的手机备注';notes.oninput();
 await f.button('返回物品列表').onclick();assert.equal(items.scrollCalls.length,1);assert.equal(f.all().find(e=>e.attributes['aria-label']==='物品备注'),notes);
 await f.card().onclick();assert.equal(detail.scrollCalls.length,2);assert.equal(f.all().find(e=>e.attributes['aria-label']==='物品备注'),notes);
 f.bag.items[0].quantity=8;f.bag.revision++;await f.api.changed();
 assert.equal(detail.scrollCalls.length,2);assert.equal(items.scrollCalls.length,1);assert.equal(f.all().find(e=>e.attributes['aria-label']==='物品备注'),notes);assert.equal(notes.value,'尚未保存的手机备注');
 assert.ok(f.calls.every(c=>c.op==='get'));assert.ok(f.all().some(e=>e.attributes['aria-label']==='治疗药水，8件'));
});
for(const mobile of [false,undefined])test(`desktop or absent matchMedia does not auto-scroll selection: ${mobile}`,async()=>{
 const f=setup(false,mobile===undefined?{}:{mobile});await f.api.open();await f.card().onclick();
 assert.equal(f.all().find(e=>e.className==='bp-detail').scrollCalls,undefined);assert.ok(f.calls.every(c=>c.op==='get'));
});
test('mobile detail navigation honours reduced motion',async()=>{
 const f=setup(false,{mobile:true,reducedMotion:true});await f.api.open();await f.card().onclick();
 assert.equal(f.all().find(e=>e.className==='bp-detail').scrollCalls[0].behavior,'auto');
});

test('returning to the same mobile item keeps an unsaved host quantity adjustment',async()=>{
 const f=setup(true,{mobile:true});await f.api.open({playerId:'p1'});await f.card().onclick();
 const quantity=f.all().find(e=>e.attributes['aria-label']==='调整持有数量');quantity.value='7';quantity.oninput();
 await f.button('返回物品列表').onclick();await f.card().onclick();
 assert.equal(f.all().find(e=>e.attributes['aria-label']==='调整持有数量'),quantity);assert.equal(quantity.value,'7');assert.ok(f.calls.every(c=>c.op==='get'));
});
