const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const {installPendingFixture}=require('./pending_requests_fixture.cjs');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.events={};this.style={};this.dataset={};this.attributes={};this.classList={add(){},remove(){},toggle(){},contains(){return false;}};}
 append(...children){for(const e of children){e.parentElement=this;this.children.push(e);}}replaceChildren(...children){this.children=[];this.append(...children);}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(e=>e!==this);}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,fn){this.events[k]=fn;}querySelectorAll(selector){const all=this.children.flatMap(e=>[e,...e.querySelectorAll("*")]);return all.filter(e=>selector==="*"||selector.startsWith(".")&&(e.className||"").split(" ").includes(selector.slice(1))||e.tag===selector);}querySelector(selector){return this.querySelectorAll(selector)[0]||null;}setPointerCapture(){}showModal(){this.open=true;}close(){this.open=false;}getBoundingClientRect(){return {left:0,top:0};}
 focus(){}scrollIntoView(){}get isConnected(){return !!this.parentElement;}
}
function setup(extras={}){
 const body=new Element('body'),world=new Element('world'),board=new Element('board'),calls=[],artItems=[];let handler=async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[]})}),counter=0;
 const context={PlayerBackpack:{art:item=>{artItems.push(item);return new Element("div");}},Option:class extends Element{constructor(text,value){super("option");this.textContent=text;this.value=value;}},window:{},document:{body,createElement:tag=>new Element(tag),addEventListener(){}},MutationObserver:class{observe(){}},setInterval:()=>1,clearInterval(){},crypto:{randomUUID:()=>`request-map-${++counter}-000000`},fetch:async(path,options)=>{const cmd=JSON.parse(options.body);calls.push(cmd);return handler(cmd);}};
 const durable=installPendingFixture(context,extras.pending||{});
 vm.createContext(context);vm.runInContext(readClientSource('主控台/shared/map-items.js'),context);
 const api=context.window.MapItems,config={host:true,map:()=>({id:'m1',mapW:500,mapH:500,gridSize:50}),campaign:()=> 'c1',world:()=>world,board:()=>board,zoom:()=>1,toast(){}};
 return {api,config,body,board,world,calls,artItems,durable,backpack:context.PlayerBackpack,setHandler(fn){handler=fn;}};
}
test('reload prompts before retrying an uncertain pickup and preserves every signed field',async()=>{
 const f=setup(),marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};f.config.host=false;f.config.session=()=> 'old-session';let consumed=0,receipt;
 f.setHandler(async command=>{if(command.op==='take'){receipt=command;consumed++;throw Error('lost response');}return {ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker],recipients:[{id:'hero',name:'主角',collectionRole:'main'}]})};});f.api.configure(f.config);await f.api.refresh(true);f.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await f.body.querySelectorAll('button').find(e=>e.textContent==='领取').onclick();assert.equal(consumed,1);
 const next=setup({pending:{storage:f.durable.storage}});next.config.host=false;next.config.session=()=> 'old-session';next.setHandler(async command=>{if(command.op==='take')assert.deepEqual(command,receipt);return {ok:true,status:200,json:async()=>({ok:true,revision:4,markers:[],recipients:[]})};});next.api.configure(next.config);await next.api.refresh(true);
 assert.ok(next.calls.every(c=>c.op==='get'));assert.ok(next.body.querySelectorAll('button').some(e=>e.textContent==='核对并重试原操作'));await next.body.querySelectorAll('button').find(e=>e.textContent==='核对并重试原操作').onclick();assert.equal(next.calls.filter(c=>c.op==='take').length,1);assert.equal(consumed,1);assert.equal(next.durable.storage.length,0);
});
test('a restored lock receipt never replays its dice automatically or on manual confirmation',async()=>{
 const f=setup(),marker={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.5,visible:true,locked:true,revision:3,items:[]};f.config.host=false;f.config.session=()=> 'session';
 f.setHandler(async command=>{if(command.op==='pickLock')throw Error('lost response');return {ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker],recipients:[]})};});f.api.configure(f.config);await f.api.refresh(true);f.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await f.body.querySelectorAll('button').find(e=>e.textContent==='⚄ 尝试开锁').onclick();
 let rolls=0;const next=setup({pending:{storage:f.durable.storage}});next.config.host=false;next.config.session=()=> 'session';next.config.playCheck=()=>rolls++;next.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:4,markers:[marker],check:{success:true}})}));next.api.configure(next.config);await next.api.refresh(true);assert.equal(rolls,0);await next.body.querySelectorAll('button').find(e=>e.textContent==='核对并重试原操作').onclick();assert.equal(rolls,0);
});
test('storage failure blocks map mutation and keeps marker readable',async()=>{
 const f=setup(),marker={id:'m',name:'物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[]};f.durable.storage.setItem=()=>{throw Error('quota');};f.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker]})}));f.api.configure(f.config);await f.api.refresh(true);f.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await f.body.querySelectorAll('button').find(e=>e.textContent==='隐藏').onclick();assert.equal(f.calls.filter(c=>c.op==='update').length,0);
});
for(const code of [400,409,500,200])test(`map pending clearing distinguishes confirmed rejection from unknown response ${code}`,async()=>{
 const f=setup(),marker={id:'m',name:'物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[]};f.setHandler(async command=>command.op==='get'?{ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker]})}:{ok:code===200,status:code,json:async()=>{if(code===200)throw Error('bad response');return {ok:false,error:'rejected'};}});f.api.configure(f.config);await f.api.refresh(true);f.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await f.body.querySelectorAll('button').find(e=>e.textContent==='隐藏').onclick();assert.equal(f.durable.storage.length,code>=400&&code<500?0:1);
});
test('host edit is available for legacy chests without a container definition',async()=>{
 const t=setup(),chest={id:'m',name:'旧箱',kind:'container',x:50,y:50,size:.75,visible:true,revision:3,items:[]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[chest]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});assert.ok(t.body.querySelector('dialog').querySelectorAll('button').some(e=>e.textContent==='编辑物品'));
});
for(const category of ['potion','document'])test(`map preview uses the same compact details or reading surface: ${category}`,async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';let opened,readingOptions;
 t.backpack.openItemDetail=item=>{opened=item;};t.backpack.openDocument=(item,options)=>{opened=item;readingOptions=options;};
 const item={id:'loot',name:'物品',category,effect:'简短效果',description:'完整规则和故事',documentType:'letter',body:'书信正文',consumable:category==='potion',quantity:1};
 const marker={id:'m',name:'物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[item]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker],recipients:[]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 assert.equal(d.querySelectorAll('*').some(e=>e.textContent===item.description),false);
 const info=d.querySelectorAll('button').find(e=>e.textContent===(category==='document'?'阅读':'查看详情'));assert.ok(d.querySelector('.mi-header-tools').querySelectorAll('button').includes(info));
 await info.onclick();assert.equal(opened.id,item.id);if(category==='document')assert.equal(readingOptions.shareSource.markerId,'m');
 if(category==='potion')assert.ok(d.querySelectorAll('*').some(e=>e.textContent==='消耗品'));
});
test('unrelated map updates do not invalidate open host item controls',async()=>{
 const t=setup();const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};let revision=3;
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 const hide=d.querySelectorAll('button').find(e=>e.textContent==='隐藏');revision=4;await t.api.refresh(true);await hide.onclick();
 const write=t.calls.find(c=>c.op==='update');assert.ok(write);assert.equal(write.revision,4);assert.equal(write.markerRevision,3);
});
for(const host of [true,false])test(`unrelated polling preserves in-progress item form host=${host}`,async()=>{
 const t=setup();t.config.host=host;t.config.session=()=> 'session';let revision=3;
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',name:'药水',category:'potion',quantity:3}]};
 const recipients=[{id:'hero',name:'主角',playerId:'p',collectionRole:'main'}];
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision,markers:[marker],recipients})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 await d.querySelectorAll('button').find(e=>e.textContent===(host?'发给玩家':'领取选项')).onclick();
 const form=d.querySelector('.mi-grant'),count=form.querySelector('input');count.value='2';revision=4;await t.api.refresh(true);
 assert.equal(d.querySelector('.mi-grant'),form);assert.equal(count.value,'2');
 await form.querySelectorAll('button').find(e=>e.textContent===(host?'确认发放':'确认领取')).onclick();
 assert.equal(t.calls.find(c=>c.op===(host?'grant':'take'))?.quantity,2);
});
test('changed selected marker invalidates old host actions',async()=>{
 const t=setup();let marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:marker.revision,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const hide=t.body.querySelector('dialog').querySelectorAll('button').find(e=>e.textContent==='隐藏');
 marker={...marker,revision:4,visible:false};await t.api.refresh(true);await hide.onclick();assert.equal(t.calls.some(c=>c.op==='update'),false);
});
test('host drafting survives selected-item changes and can load the fresh version explicitly',async()=>{
 const t=setup();let marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:marker.revision,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog'),name=d.querySelectorAll('input').find(e=>e.attributes['aria-label']==='显示名称');
 name.value='尚未保存的名称';d.events.input();marker={...marker,name:'其他人改写的名称',revision:4};await t.api.refresh(true);
 assert.ok(d.querySelectorAll('input').includes(name));assert.equal(name.value,'尚未保存的名称');
 await d.querySelectorAll('button').find(e=>e.textContent==='保存设置').onclick();assert.equal(t.calls.some(c=>c.op==='update'),false);
 await d.querySelectorAll('button').find(e=>e.textContent==='载入更新').onclick();assert.equal(d.querySelectorAll('input').find(e=>e.attributes['aria-label']==='显示名称').value,'其他人改写的名称');
});
for(const host of [true,false])test(`moving an open item preserves its form and submits the current marker revision host=${host}`,async()=>{
 const t=setup();t.config.host=host;t.config.session=()=> 'session';let marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',name:'药水',category:'potion',quantity:3}]};
 const recipients=[{id:'hero',name:'主角',playerId:'p',collectionRole:'main'}];
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:marker.revision,markers:[marker],recipients})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 await d.querySelectorAll('button').find(e=>e.textContent===(host?'发给玩家':'领取选项')).onclick();
 const form=d.querySelector('.mi-grant'),count=form.querySelector('input');count.value='2';if(host)d.events.input();
 marker={...marker,x:100,revision:4};await t.api.refresh(true);
 assert.equal(d.querySelector('.mi-grant'),form);assert.equal(count.value,'2');
 await form.querySelectorAll('button').find(e=>e.textContent===(host?'确认发放':'确认领取')).onclick();
 const command=t.calls.find(c=>c.op===(host?'grant':'take'));assert.equal(command?.quantity,2);assert.equal(command?.markerRevision,4);
});
test('moving an open locked chest preserves the selected check bonuses',async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';let marker={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,revision:3,items:[]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog'),field=name=>d.querySelectorAll('*').find(e=>e.attributes['aria-label']===name);
 const modifier=field('巧手加值');modifier.value='4';field('检定方式').value='1';field('神导术').checked=true;
 marker={...marker,y:90,revision:4};await t.api.refresh(true);
 assert.equal(field('巧手加值'),modifier);assert.equal(modifier.value,'4');
 await d.querySelectorAll('button').find(e=>e.textContent==='⚄ 尝试开锁').onclick();const command=t.calls.find(c=>c.op==='pickLock');
 assert.equal(command.modifier,4);assert.equal(command.mode,1);assert.equal(command.guidance,true);assert.equal(command.markerRevision,4);
});
test('switching the player session clears an old map item even when the map is unchanged',async()=>{
 const t=setup();t.config.host=false;let session='old-session';t.config.session=()=>session;
 const marker={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,revision:3,items:[{id:'letter',name:'秘密信件',category:'document',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');assert.equal(d.open,true);
 let release;t.setHandler(()=>new Promise(resolve=>{release=resolve;}));session='new-session';const read=t.api.refresh(true);
 assert.equal(d.open,false);assert.equal(t.world.querySelector('.map-item-marker'),null);
 release({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[]})});await read;
});
test('a retained player action cannot run under a newly selected player session',async()=>{
 const t=setup();t.config.host=false;let session='old-session';t.config.session=()=>session;
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker],recipients:[{id:'hero',name:'主角',collectionRole:'main'}]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const take=t.body.querySelectorAll('button').find(e=>e.textContent==='领取');
 session='new-session';await take.onclick();assert.equal(t.calls.some(c=>c.op==='take'),false);
});
test('uncertain pickup retries remain tied to the player who initiated them',async()=>{
 const t=setup();t.config.host=false;let session='old-session',attempts=0;t.config.session=()=>session;
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};
 t.setHandler(async command=>{if(command.op==='take'&&++attempts===1)throw new Error('连接中断');return {ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker],recipients:[{id:'hero',name:'主角',collectionRole:'main'}]})};});t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await t.body.querySelectorAll('button').find(e=>e.textContent==='领取').onclick();assert.equal(attempts,1);
 session='new-session';await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 assert.equal(t.body.querySelectorAll('button').some(e=>e.textContent==='核对并重试原操作'),false);assert.equal(attempts,1);assert.equal(t.body.querySelectorAll('button').find(e=>e.textContent==='领取').disabled,false);
 session='old-session';await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 await t.body.querySelectorAll('button').find(e=>e.textContent==='核对并重试原操作').onclick();assert.equal(attempts,2);
 const commands=t.calls.filter(c=>c.op==='take');assert.equal(commands[0].requestId,commands[1].requestId);assert.equal(commands[1].sessionToken,'old-session');
});
test('an in-flight write from the old player cannot overwrite the newly selected player view',async()=>{
 const t=setup();t.config.host=false;let session='old-session',release;t.config.session=()=>session;
 const original={id:'old-marker',name:'旧玩家物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]},fresh={...original,id:'new-marker',name:'新玩家物品'};
 const response=marker=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker],recipients:[{id:'hero',name:'主角',collectionRole:'main'}]})});
 t.setHandler(command=>command.op==='take'?new Promise(resolve=>{release=()=>resolve(response(original));}):response(command.sessionToken==='new-session'?fresh:original));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const oldTake=t.body.querySelectorAll('button').find(e=>e.textContent==='领取'),writing=oldTake.onclick();await new Promise(r=>setImmediate(r));
 session='new-session';await t.api.refresh(true);assert.equal(t.body.querySelector('dialog').open,false);assert.equal(t.world.querySelector('.map-item-marker'),null);
 release();await writing;await new Promise(r=>setImmediate(r));assert.equal(t.world.querySelector('.map-item-marker').dataset.markerId,'new-marker');assert.equal(t.calls.filter(c=>c.op==='take').length,1);
 session='old-session';await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});assert.equal(t.body.querySelectorAll('button').some(e=>e.textContent==='核对并重试原操作'),false);
});
test('uncertain host writes do not block a different map and restore the same request on return',async()=>{
 const t=setup();let mapId='m1',attempts=0;t.config.map=()=>({id:mapId,mapW:500,mapH:500,gridSize:50});
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',category:'potion',quantity:2}]};
 t.setHandler(async command=>{if(command.op==='update'&&++attempts===1)throw new Error('连接中断');return {ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker]})};});t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await t.body.querySelectorAll('button').find(e=>e.textContent==='隐藏').onclick();assert.equal(attempts,1);
 mapId='m2';await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});assert.equal(t.body.querySelectorAll('button').some(e=>e.textContent==='核对并重试原操作'),false);
 mapId='m1';await t.api.refresh(true);await t.body.querySelectorAll('button').find(e=>e.textContent==='核对并重试原操作').onclick();assert.equal(attempts,2);
 const writes=t.calls.filter(c=>c.op==='update');assert.equal(writes[0].mapId,'m1');assert.equal(writes[1].mapId,'m1');assert.equal(writes[0].requestId,writes[1].requestId);
});
for(const update of ['quantity','pickup','definition','visibility','lock'])test(`coordinate rebasing never permits a stale pickup after ${update} changes`,async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';let marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,pickupAllowed:true,items:[{id:'loot',name:'药水',category:'potion',quantity:2}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:marker.visible?[marker]:[],recipients:[{id:'hero',name:'主角',collectionRole:'main'}]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const take=t.body.querySelectorAll('button').find(e=>e.textContent==='领取');
 const changed=update==='quantity'?{items:[{...marker.items[0],quantity:1}]}:update==='definition'?{items:[{...marker.items[0],name:'新物品'}]}:update==='pickup'?{pickupAllowed:false}:update==='visibility'?{visible:false}:{locked:true};
 marker={...marker,...changed,x:100,revision:4};await t.api.refresh(true);await take.onclick();assert.equal(t.calls.some(c=>c.op==='take'),false);
});
test('a role reassignment invalidates an open host grant while preserving its draft',async()=>{
 const t=setup();let recipients=[{id:'hero',name:'主角',playerId:'p',collectionRole:'main'}];
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',name:'药水',category:'potion',quantity:3}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[marker],recipients})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');await d.querySelectorAll('button').find(e=>e.textContent==='发给玩家').onclick();
 const form=d.querySelector('.mi-grant');form.querySelector('input').value='2';d.events.input();recipients=[{...recipients[0],playerId:'another-player'}];await t.api.refresh(true);
 assert.ok(d.querySelector('.mi-grant')===form);assert.equal(form.querySelector('input').value,'2');
 await form.querySelectorAll('button').find(e=>e.textContent==='确认发放').onclick();assert.equal(t.calls.some(c=>c.op==='grant'),false);
});
test('placement awaits a background refresh instead of reporting a missing map',async()=>{
 const t=setup();let release;t.setHandler(()=>new Promise(resolve=>{release=resolve;}));t.api.configure(t.config);const placement=t.api.place({id:'healing',version:1,name:'药水'},2);assert.equal(t.calls.length,1);
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:7,markers:[]})}));release({ok:true,status:200,json:async()=>({ok:true,revision:7,markers:[]})});
 assert.equal(await placement,true);assert.equal(t.calls.length,2);assert.ok(t.body.children.some(e=>e.className==='mi-placement-banner'));
});
test('old server 404 gives an actionable error and never arms placement',async()=>{
 const t=setup();t.setHandler(async()=>({ok:false,status:404,json:async()=>({ok:false,error:'not found'})}));t.api.configure(t.config);
 await assert.rejects(t.api.container(),/重启启动器/);assert.equal(t.body.children.length,0);
});
test('switching maps during preparation cannot place on the new map',async()=>{
 const t=setup();let mapId='m1',release;t.config.map=()=>({id:mapId,mapW:500,mapH:500});t.setHandler(()=>new Promise(resolve=>{release=resolve;}));t.api.configure(t.config);
 const placement=t.api.place({id:'healing',version:1,name:'药水'});mapId='m2';t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[]})}));release({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[]})});
 await assert.rejects(placement,/地图已切换/);assert.equal(t.body.children.length,0);assert.ok(t.calls.every(c=>c.op==='get'));
});

for(const host of [true,false])test(`deliberate drag moves without opening for host=${host}`,async()=>{
 const t=setup();t.config.host=host;t.config.session=()=> 'session';let z=.2;t.config.zoom=()=>z;
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{category:'potion',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 const b=t.world.querySelector('.map-item-marker');assert.equal(b.style.width,'25px');z=3;t.api.resize();assert.equal(b.style.width,'25px');
 const e=(x)=>({clientX:x,clientY:50,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 b.onpointerdown(e(50));b.onpointermove(e(59));b.onpointerup(e(59));b.onclick({...e(59),detail:1});await new Promise(r=>setImmediate(r));
 assert.equal(t.body.children.filter(e=>e.tag==='dialog').length,0);const move=t.calls.find(c=>c.op==='move');assert.ok(move);assert.equal(move.markerRevision,3);assert.equal(move.x,53);
});

for(const host of [true,false])test(`late poll cannot undo a saved drag for host=${host}`,async()=>{
 const t=setup();t.config.host=host;t.config.session=()=> 'session';
 const old={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{category:'potion',quantity:1}]};
 let current=old,release,delay=false;
 const response=m=>({ok:true,status:200,json:async()=>({ok:true,revision:m.revision,markers:[m]})});
 t.setHandler(async cmd=>{if(cmd.op==='move'){current={...old,x:cmd.x,y:cmd.y,revision:4};return response(current);}if(delay){delay=false;return new Promise(resolve=>{release=()=>resolve(response(old));});}return response(current);});
 t.api.configure(t.config);await t.api.refresh(true);delay=true;const poll=t.api.refresh();
 const b=t.world.querySelector('.map-item-marker'),e=x=>({clientX:x,clientY:50,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 b.onpointerdown(e(50));b.onpointermove(e(83));b.onpointerup(e(83));await new Promise(r=>setImmediate(r));
 assert.equal(t.world.querySelector('.map-item-marker').style.left,'83px');release();await poll;
 assert.equal(t.world.querySelector('.map-item-marker').style.left,'83px');await t.api.refresh(true);assert.equal(t.world.querySelector('.map-item-marker').style.left,'83px');
});

for(const event of ['onlostpointercapture','onpointercancel'])test(`interrupted drag saves its last position: ${event}`,async()=>{
 const t=setup();let current={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{category:'potion',quantity:1}]};
 t.setHandler(async c=>{if(c.op==='move')current={...current,x:c.x,y:c.y,revision:4};return {ok:true,status:200,json:async()=>({ok:true,revision:4,markers:[current]})};});
 t.api.configure(t.config);await t.api.refresh(true);const b=t.world.querySelector('.map-item-marker');const e=x=>({clientX:x,clientY:50,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 b.onpointerdown(e(50));b.onpointermove(e(91));b[event](e(91));b.onlostpointercapture(e(91));b.onpointerup(e(91));await new Promise(r=>setImmediate(r));
 assert.equal(t.calls.filter(c=>c.op==='move').length,1);assert.equal(t.world.querySelector('.map-item-marker').style.left,'91px');assert.equal(t.body.children.filter(e=>e.tag==='dialog').length,0);
});

for(const host of [true,false])for(const zoom of [.25,3])test(`click tolerates jitter host=${host} zoom=${zoom}`,async()=>{
 const t=setup();t.config.host=host;t.config.zoom=()=>zoom;t.config.session=()=> 'session';
 const m={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{category:'potion',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:3,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 const b=t.world.querySelector('.map-item-marker'),e=x=>({clientX:x,clientY:50,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 b.onpointerdown(e(50));b.onpointermove(e(54));b.onpointerup(e(54));
 assert.equal(t.calls.filter(c=>c.op==='move').length,0);assert.equal(b.style.left,'50px');assert.equal(t.body.querySelector('dialog').open,true);
});

test('2024 lock form declares bonuses without spending inspiration up front',async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';
 const m={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,revision:3,items:[]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 const d=t.body.querySelector('dialog'),fields=d.querySelectorAll('*'),field=name=>fields.find(e=>e.attributes['aria-label']===name);
 field('检定方式').value='1';field('巧手加值').value='4';field('神导术').checked=true;field('诗人激励').value='8';
 await fields.find(e=>e.textContent==='⚄ 尝试开锁').onclick();
 const c=t.calls.find(c=>c.op==='pickLock');assert.equal(c.mode,1);assert.equal(c.modifier,4);assert.equal(c.guidance,true);assert.equal(c.inspirationDie,8);assert.equal(t.calls.some(c=>c.op==='inspireLock'),false);assert.equal(d.open,true);
});
test('chest states use three actual artworks without emoji overlays',async()=>{
 for(const [locked,lockType,expected] of [[false,'normal','unlocked'],[true,'normal','locked'],[true,'arcane','arcane']]){
  const t=setup();const m={id:'chest',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked,lockType,revision:1,items:[],containerItem:{name:'宝箱',category:'container',image:'/old-chest.png'}};
  t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:1,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
  const marker=t.world.querySelector('.map-item-marker');assert.match(marker.querySelector('img').src,new RegExp('chest-'+expected+'-v2\\.png$'));
  assert.equal(marker.querySelector('.mi-art-lock'),null);assert.equal(marker.children.some(e=>e.textContent==='🔒'||e.textContent==='🔓'),false);
 }
});
test('letter and book map markers keep distinct transparent artwork',async()=>{
 for(const [kind,file] of [['letter','letter-v2.png'],['book','book-v2.png']]){
  const t=setup(),m={id:'story',name:'剧情物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:1,items:[{name:'剧情物品',category:'document',documentType:kind,quantity:1,body:'正文'}]};
  t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:1,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
  assert.match(t.world.querySelector('.map-item-marker').querySelector('img').src,new RegExp('/文书/'+file.replace('.','\\.')+'$'));
 }
});
for(const host of [true,false])test(`custom container art survives placement and detail display host=${host}`,async()=>{
 for(const [locked,lockType] of [[false,'normal'],[true,'normal'],[true,'arcane']]){
  const t=setup();t.config.host=host;t.config.session=()=> 'session';
  const image='/api/module-assets/'+'a'.repeat(64);
  const m={id:'iron',name:'沉底铁箱',kind:'container',x:50,y:50,size:.75,visible:true,locked,lockType,revision:1,items:[],containerItem:{name:'沉底铁箱',category:'container',image}};
  t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:1,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
  const marker=t.world.querySelector('.map-item-marker');assert.equal(marker.querySelector('img').src,image);
  marker.onclick({detail:0,stopPropagation(){}});assert.equal(t.artItems.at(-1).image,image);
  assert.equal(marker.querySelector('.mi-art-lock'),null);
 }
});
test('module-backed standard chest still selects its lock-state artwork',async()=>{
 const t=setup(),m={id:'standard',name:'重命名的宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,lockType:'arcane',revision:1,items:[],containerItem:{category:'container',image:'/api/module-assets/2313b3ce86c47ed09283432b8d42c52abc74172b36545bb605cc9917395e4083'}};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:1,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 assert.match(t.world.querySelector('img').src,/chest-arcane-v2\.png$/);
});
test('arcane chest shows the player no mundane lock-picking button',async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';
 const m={id:'chest',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,lockType:'arcane',revision:1,items:[]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 const buttons=t.body.querySelector('dialog').querySelectorAll('button');
 assert.equal(buttons.some(e=>e.textContent==='⚄ 尝试开锁'),false);
});
test('failed check offers one 2024 inspiration followup tied to original check',async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';const attempt={id:'original-check',natural:8,modifier:4,total:12,success:false,inspirationDie:8};
 const m={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,revision:3,items:[],lockAttempt:attempt};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 await d.querySelectorAll('button').find(e=>e.textContent==='使用诗人激励 d8').onclick();
 const c=t.calls.find(c=>c.op==='inspireLock');assert.equal(c.checkId,'original-check');assert.equal('inspirationDie' in c,false);assert.equal(t.calls.some(c=>c.op==='pickLock'),false);
});

test('ordinary failure allows choosing inspiration after the roll',async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';const attempt={id:'unselected-check',natural:8,modifier:4,total:12,success:false,inspirationDie:0};
 const m={id:'m',name:'宝箱',kind:'container',x:50,y:50,size:.75,visible:true,locked:true,revision:3,items:[],lockAttempt:attempt};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const d=t.body.querySelector('dialog');
 d.querySelectorAll('select').find(e=>e.attributes['aria-label']==='已有的诗人激励骰').value='10';await d.querySelectorAll('button').find(e=>e.textContent==='使用诗人激励').onclick();
 const c=t.calls.find(c=>c.op==='inspireLock');assert.equal(c.checkId,'unselected-check');assert.equal(c.inspirationDie,10);
});

for(const host of [true,false])test(`fixed marker ignores drag but still opens on click host=${host}`,async()=>{
 const t=setup();t.config.host=host;t.config.session=()=> 'session';
 const marker={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,positionLocked:true,items:[{category:'potion',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:0,markers:[marker]})}));t.api.configure(t.config);await t.api.refresh(true);
 const b=t.world.querySelector('.map-item-marker'),e=x=>({clientX:x,clientY:50,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 b.onpointerdown(e(50));b.onpointermove(e(90));b.onpointerup(e(90));await new Promise(r=>setImmediate(r));
 assert.equal(b.style.left,'50px');assert.equal(t.calls.filter(c=>c.op==='move').length,0);assert.equal(t.body.children.filter(e=>e.tag==='dialog').length,0);
 b.onpointerdown(e(50));b.onpointerup(e(50));assert.ok(t.body.children.some(e=>e.tag==='dialog'));
});

for(const pickupAllowed of [true,false])test(`player map pickup is one click and respects permissions: ${pickupAllowed}`,async()=>{
 const t=setup();t.config.host=false;t.config.session=()=> 'session';
 const m={id:'m',name:'药水',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,pickupAllowed,items:[{id:'loot',name:'药水',category:'potion',effect:'治疗',quantity:3}]};
 const recipients=[{id:'pet',name:'仆从',collectionRole:'companion'},{id:'hero',name:'主角',collectionRole:'main'}];
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:5,markers:[m],recipients})}));t.api.configure(t.config);await t.api.refresh(true);
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 const take=t.body.querySelectorAll('button').find(e=>e.textContent==='领取');
 assert.equal(!!take,pickupAllowed);if(take){await take.onclick();const command=t.calls.find(c=>c.op==='take');assert.equal(command.characterId,'hero');assert.equal(command.quantity,1);assert.equal(command.markerRevision,3);}
});
test('host can edit map content using the shared editor with quantity',async()=>{
 const t=setup(),edited={name:'改写信件',category:'document',documentType:'letter',body:'新线索',effect:'阅读',consumable:false};
 const m={id:'m',name:'信件',kind:'item',x:50,y:50,size:.5,visible:true,revision:3,items:[{id:'loot',name:'信件',category:'document',documentType:'letter',body:'原线索',effect:'阅读',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:5,markers:[m]})}));t.api.configure(t.config);await t.api.refresh(true);
 t.backpack.definitionEditor=()=>({form:new Element('section'),read:()=>edited});
 t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});
 await t.body.querySelectorAll('button').find(e=>e.textContent==='编辑物品').onclick();
 t.body.querySelectorAll('input').find(e=>e.attributes['aria-label']==='数量').value='2';
 await t.body.querySelectorAll('button').find(e=>e.textContent==='保存').onclick();
 const command=t.calls.find(c=>c.op==='editContent');assert.deepEqual(command.item,edited);assert.equal(command.quantity,2);assert.equal(command.itemId,'loot');
});


test('package configuration change immediately removes stale map loot and invalidates old pickup controls',async()=>{
 const t=setup();let revision='pkg-1';t.config.host=false;t.config.session=()=> 'session';t.config.packageContextRevision=()=>revision;
 const marker={id:'m',name:'任务物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:1,pickupAllowed:true,items:[{id:'i',name:'任务物品',category:'gear',quantity:1}]};
 t.setHandler(async()=>({ok:true,status:200,json:async()=>({ok:true,revision:1,packageContextRevision:revision,markers:revision==='pkg-1'?[marker]:[],recipients:[{id:'c',name:'角色',playerId:'p',collectionRole:'main'}]})}));
 t.api.configure(t.config);await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});const take=t.body.querySelector('dialog').querySelectorAll('button').find(b=>b.textContent==='领取');
 revision='pkg-2';const updating=t.api.contextChanged();assert.equal(t.world.querySelector('.map-item-marker'),null);assert.equal(t.body.querySelector('dialog').open,false);await updating;await take.onclick();assert.equal(t.calls.some(c=>c.op==='take'),false);
});


test('an uncertain pickup remains recoverable after its package is disabled without re-showing the item',async()=>{
 const t=setup();let revision='pkg-1',lost=true;const receipts=new Set();t.config.host=false;t.config.session=()=> 'session';t.config.packageContextRevision=()=>revision;
 const marker={id:'m',name:'任务物品',kind:'item',x:50,y:50,size:.5,visible:true,revision:1,pickupAllowed:true,items:[{id:'i',name:'任务物品',category:'gear',quantity:1}]};
 t.setHandler(async command=>{if(command.op==='take'){receipts.add(command.requestId);if(lost){lost=false;throw Error('lost reply');}}return{ok:true,status:200,json:async()=>({ok:true,revision:1,packageContextRevision:revision,markers:revision==='pkg-1'?[marker]:[],recipients:[{id:'c',name:'角色',playerId:'p',collectionRole:'main'}]})};});
 t.api.configure(t.config);await t.api.refresh(true);t.world.querySelector('.map-item-marker').onclick({detail:0,stopPropagation(){}});await t.body.querySelector('dialog').querySelectorAll('button').find(b=>b.textContent==='领取').onclick();
 const original=t.calls.find(c=>c.op==='take');assert.equal(original.packageContextRevision,'pkg-1');revision='pkg-2';await t.api.contextChanged();assert.equal(t.world.querySelector('.map-item-marker'),null);
 await t.body.querySelector('dialog').querySelectorAll('button').find(b=>b.textContent==='核对并重试原操作').onclick();await new Promise(r=>setImmediate(r));assert.deepEqual(t.calls.filter(c=>c.op==='take'),[original,original]);assert.equal(receipts.size,1);assert.equal(t.world.querySelector('.map-item-marker'),null);
});
