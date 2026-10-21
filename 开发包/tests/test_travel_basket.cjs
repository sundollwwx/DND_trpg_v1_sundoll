const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {APP_ROOT}=require('./project_paths.cjs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(APP_ROOT,p),'utf8');
function host(){
 const state={campaignId:'c',activeMapId:'a',maps:[{id:'a',tokens:[{id:'t99',name:'向导',hp:7,tempHp:3,size:1,conditions:[{key:'poisoned'}],mountId:'horse',x:25,y:25}],mapW:900,mapH:600,gridSize:50,cam:{x:0,y:0,zoom:1}},{id:'b',tokens:[],mapW:900,mapH:600,gridSize:50,cam:{x:0,y:0,zoom:1}}],parkedOwnedPieces:{},snap:true};
 let config;const context={state,window:{TravelBasket:{configure:c=>config=c}},document:{getElementById:()=>({}),querySelector:()=>null},board:{getBoundingClientRect:()=>({width:900,height:600})},activeMap:()=>state.maps.find(m=>m.id===state.activeMapId),portraitLodAssetUrl:x=>x,normalizeSheet:t=>t,renderTokens(){},updateDetail(){},renderEncounter(){},scheduleAutosave(){},deleteToken(id,silent,toBasket=false){const m=context.activeMap(),t=m.tokens.find(t=>t.id===id);if(t.ownedPieceId)state.parkedOwnedPieces[t.ownedPieceId]={...t,mountId:null,travelBasketStored:toBasket===true};m.tokens=m.tokens.filter(t=>t.id!==id);}};
 vm.createContext(context);vm.runInContext(read('shared/token-size.js'),context);vm.runInContext(read('主控台/host/travel-basket.js'),context);return{state,config};
}
test('NPC travels between maps with identity and runtime intact, then cannot be duplicated',async()=>{
 const {state,config}=host();config.collect({id:'t99'});assert.equal(state.maps[0].tokens.length,0);assert.equal((await config.list()).stored.length,1);
 state.activeMapId='b';assert.equal((await config.list()).stored.length,1);config.release({id:'t99'});
 const t=state.maps[1].tokens[0];assert.equal(t.id,'t99');assert.equal(t.hp,7);assert.equal(t.tempHp,3);assert.equal(t.conditions[0].key,'poisoned');assert.equal(t.mountId,null);
 assert.equal(state.travelBasketTokens.length,0);assert.throws(()=>config.release({id:'t99'}));
});
test('owned tokens use parked state and stale duplicate map identity is rejected',()=>{
 const {state,config}=host();const t=state.maps[0].tokens[0];t.ownedPieceId='own';config.collect({id:t.id});assert.ok(state.parkedOwnedPieces.own);assert.equal(state.travelBasketTokens,undefined);
 state.activeMapId='b';state.maps[1].tokens.push({...t});assert.throws(()=>config.release({id:t.id,ownedPieceId:'own'}));assert.ok(state.parkedOwnedPieces.own);
 state.maps[1].tokens=[];config.release({id:t.id,ownedPieceId:'own'});assert.equal(state.parkedOwnedPieces.own,undefined);assert.equal(state.maps[1].tokens.length,1);
});
class E{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes={};this.events={};this.style={};this.textContent='';this.classList={toggle(){},remove(){},add(){}};}contains(n){return this===n||this.children.some(c=>c.contains(n));}cloneNode(){return new E(this.tag);}removeAttribute(k){delete this.attributes[k];}remove(){}setPointerCapture(){}releasePointerCapture(){}hasPointerCapture(){return false;}getBoundingClientRect(){return {left:10,top:10,right:100,bottom:100};}append(...c){this.children.push(...c);}replaceChildren(...c){this.children=c;}setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.events[k]=v;}focus(){}showModal(){this.open=true;}close(){this.open=false;}querySelectorAll(sel){return this.all().filter(e=>'.'+e.className===sel);}all(){return[this,...this.children.flatMap(c=>c.all())];}}
function ui(host=true,follow=false){let hostOpen=false;const body=new E('body');const board=new E('board');let hit=board,released=null,hitStack=null;let skin='wagon',collects=0;let key='p1',data={stored:[{id:'t',name:'旅行者'}],available:[],canPlace:true},resolvers=[],calls=0,delay=false;
 const context={AbortController,setTimeout,clearTimeout,SundollClientRuntime:require(path.join(APP_ROOT,'主控台/shared/client-runtime.js')),window:{location:{href:'http://test/主控台/玩家.html'},addEventListener(){}},document:{body,elementsFromPoint:()=>hitStack||[hit],elementFromPoint:()=>hit,createElement:t=>new E(t)},URL,localStorage:{getItem(){return null;},setItem(){}},setInterval:()=>1,clearInterval(){}};
 vm.createContext(context);vm.runInContext(read('主控台/shared/travel-basket.js'),context);
 const api=context.window.TravelBasket;api.configure({...(follow?{followOpen:true,open:()=>hostOpen}:{}),board,mapPoint:(x,y)=>({x:x*2,y:y*2}),skin:()=>skin,...(host?{setSkin:s=>skin=s}:{}),key:()=>key,list:async()=>{calls++;const result=data;if(delay)await new Promise(r=>resolvers.push(r));return result;},release:async(item,point)=>{released=point;data={...data,stored:[]};},collect(){collects++;}});
 return{api,board,setHits:v=>hitStack=v,loadMask(){const image=body.all().find(e=>e.className==='travel-scene').children[0];image.naturalWidth=128;image.naturalHeight=128;context.document.createElement=t=>{const n=new E(t);if(t==='canvas')n.getContext=()=>({drawImage(){},getImageData(){const data=new Uint8ClampedArray(128*128*4);for(let y=20;y<108;y++)for(let x=20;x<108;x++)data[(y*128+x)*4+3]=255;return{data};}});return n;};image.onload();},setHostOpen:v=>hostOpen=v,hit:v=>hit=v,released:()=>released,all:()=>body.all(),setKey:v=>key=v,setData:v=>data=v,delay(){delay=true;},resolve(){resolvers.shift()();},calls:()=>calls,collects:()=>collects,setSkin:s=>skin=s};}
const tick=()=>new Promise(r=>setImmediate(r));
test('skin change preserves passengers, click does not release, and repeated renders do not poll',async()=>{
 const u=ui();(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();
 u.all().find(e=>e.className==='travel-skin-card'&&e.dataset.skin==='star-portal').onclick();await tick();
 assert.ok(u.all().find(e=>e.attributes['aria-label']==='传送抵达：旅行者'));u.api.changed();u.api.changed();assert.equal(u.calls(),1);
 await u.all().find(e=>e.attributes['aria-label']==='传送抵达：旅行者').onclick({preventDefault(){}});assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,1);
});
test('identity changes clear passengers immediately and stale responses are ignored',async()=>{
 const u=ui();(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();u.delay();const old=u.api.refresh();await tick();
 u.setKey('p2');u.setData({stored:[],available:[],canPlace:false});u.api.changed();assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,0);await tick();
 u.resolve();await old;u.resolve();await tick();assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,0);
});

test('compact tray has no instructions or candidate controls and player cannot choose skin',async()=>{
 const u=ui(false);(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();
 assert.equal(u.all().filter(e=>e.tag==='select').length,0);
 for(const text of ['一起去下一站','等待同行者','收起选中棋子','可带走'])assert.ok(!u.all().some(e=>e.textContent.includes(text)));
 u.setSkin('road');u.api.changed();assert.ok(u.all().find(e=>e.attributes['aria-label']==='抵达：旅行者'));
});
test('drop hit testing collects once and opens the collapsed basket',async()=>{
 const u=ui();assert.equal(u.api.drop({id:'t'},200,200),false);assert.equal(u.collects(),0);
 assert.equal(u.api.drop({id:'t'},50,50),true);assert.equal(u.api.drop({id:'t'},50,50),true);
 await tick();assert.equal(u.collects(),1);assert.equal(u.all().find(e=>e.className==='travel-panel').hidden,false);
});

const pe=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){}});
test('drag out releases at converted map point; cancelled and outside drops remain stored',async()=>{
 const u=ui();(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();
 const token=u.all().find(e=>e.className==='travel-passenger');
 token.onpointerdown(pe(30,30));token.onpointerup(pe(30,30));assert.equal(u.released(),null);
 token.onpointerdown(pe(30,30));token.onpointermove(pe(200,200));token.onpointercancel();assert.equal(u.released(),null);
 token.onpointerdown(pe(30,30));token.onpointermove(pe(200,200));u.hit(null);token.onpointerup(pe(200,200));assert.equal(u.released(),null);
 u.hit(u.all()[0]);token.onpointerdown(pe(30,30));token.onpointermove(pe(200,200));token.onpointerup(pe(200,200));assert.equal(u.released(),null);
});
test('valid drag out preserves requested drop coordinates',async()=>{
 const u=ui();(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();const token=u.all().find(e=>e.className==='travel-passenger');
 token.onpointerdown(pe(30,30));token.onpointermove(pe(200,210));await token.onpointerup(pe(200,210));
 assert.equal(u.released().x,400);assert.equal(u.released().y,420);assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,0);
});

test('new cutout skins load assets and the portal rejects corner drops while retaining passengers',async()=>{
 const u=ui();(u.all().find(e=>e.className==='travel-fold')||u.all().find(e=>e.className==='travel-toggle')).onclick();await tick();
 
 for(const id of ['forest-path','snow-trail','voyage-ship','stone-road','travel-wagon','star-portal']){
  u.all().find(e=>e.className==='travel-skin-card'&&e.dataset.skin===id).onclick();await tick();
  const img=u.all().find(e=>e.className==='travel-scene').children[0];
  assert.ok(img.src.endsWith(id+'-v1.webp'));
  assert.ok(fs.existsSync(path.join(APP_ROOT,'asset/界面/旅行篮子',id+'-v1.webp')));
  assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,1);
 }
 assert.equal(u.api.containsPoint(11,11),false);
 assert.equal(u.api.containsPoint(55,55),true);
 assert.equal(u.api.drop({id:'t'},11,11),false);assert.equal(u.collects(),0);
 const player=ui(false);player.setSkin('star-portal');player.api.changed();
 assert.ok(player.all().find(e=>e.tag==='img').src.endsWith('star-portal-v1.webp'));
 assert.equal(player.all().filter(e=>e.tag==='select').length,0);
});

 test('host opens preview dialog without changing skin and player has no dialog',async()=>{
 const u=ui();u.all().find(e=>e.className==='travel-toggle').onclick();
 const dialog=u.all().find(e=>e.tag==='dialog');assert.equal(dialog.open,true);
 assert.equal(u.all().filter(e=>e.className==='travel-skin-card').length,15);
 assert.equal(u.all().find(e=>e.className==='travel-basket').dataset.skin,'travel-wagon');
 u.all().find(e=>e.className==='travel-skin-card'&&e.dataset.skin==='star-portal').onclick();await tick();
 assert.equal(dialog.open,false);assert.equal(u.all().find(e=>e.className==='travel-panel').hidden,false);
 assert.equal(u.all().find(e=>e.className==='travel-basket').dataset.skin,'star-portal');
 assert.equal(ui(false).all().filter(e=>e.tag==='dialog').length,0);
 });

test('six distinct passengers collect once and arrive without duplicates or overlap',async()=>{
 const {state,config}=host(),base=state.maps[0].tokens[0];
 state.maps[0].tokens=Array.from({length:6},(_,i)=>({...base,id:'six-'+i,name:'同行者'+i}));
 for(let i=0;i<6;i++){config.collect({id:'six-'+i});assert.throws(()=>config.collect({id:'six-'+i}));}
 assert.equal((await config.list()).stored.length,6);state.activeMapId='b';
 for(let i=0;i<6;i++){config.release({id:'six-'+i},{x:250,y:250});assert.throws(()=>config.release({id:'six-'+i}));}
 const tokens=state.maps[1].tokens;assert.equal(new Set(tokens.map(t=>t.id)).size,6);
 assert.equal(state.travelBasketTokens.length,0);
 assert.ok(tokens.every((a,i)=>tokens.slice(i+1).every(b=>Math.abs(a.x-b.x)>=50||Math.abs(a.y-b.y)>=50)));
});

test('preview groups all fifteen skins by ground, vehicle and portal',()=>{
 const u=ui(),groups=u.all().filter(e=>e.className==='travel-skin-group');
 assert.deepEqual(groups.map(g=>g.attributes['aria-label']),['路面','载具','传送门']);
 assert.deepEqual(groups.map(g=>g.all().filter(e=>e.className==='travel-skin-card').length),[12,2,1]);
});

test('all skin choices survive saved-state restore and remain available to players',()=>{
 const hostUi=ui(),cards=hostUi.all().filter(e=>e.className==='travel-skin-card');
 const statement=read('主控台/host/storage.js').match(/state\.travelBasketSkin = [^;]+;/)[0];
 for(const card of cards){
  const id=card.dataset.skin,context={state:{},s:JSON.parse(JSON.stringify({travelBasketSkin:id}))};
  vm.runInNewContext(statement,context);assert.equal(context.state.travelBasketSkin,id);
  const player=ui(false);player.setSkin(context.state.travelBasketSkin);player.api.changed();
  assert.equal(player.all().find(e=>e.className==='travel-basket').dataset.skin,id);
  assert.ok(fs.existsSync(path.join(APP_ROOT,'asset/界面/旅行篮子',id+'-v1.webp')));
 }
});

test('player follows host visibility and cannot open by click, Escape or a collapsed drop',async()=>{
 const u=ui(false,true),root=u.all().find(e=>e.className==='travel-basket'),toggle=u.all().find(e=>e.className==='travel-toggle');
 assert.equal(root.hidden,true);assert.equal(toggle.hidden,true);toggle.onclick();assert.equal(root.hidden,true);
 assert.equal(u.api.drop({id:'t'},50,50),false);assert.equal(u.collects(),0);
 u.setHostOpen(true);u.api.changed();await tick();assert.equal(root.hidden,false);
 root.events.keydown({key:'Escape',stopPropagation(){},preventDefault(){}});assert.equal(root.hidden,false);
 const token=u.all().find(e=>e.className==='travel-passenger');token.onpointerdown(pe(30,30));token.onpointermove(pe(200,200));
 u.setHostOpen(false);u.api.changed();token.onpointerup(pe(200,200));assert.equal(u.released(),null);assert.equal(root.hidden,true);
 u.setHostOpen(true);u.api.changed();await tick();assert.equal(root.hidden,false);assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,1);
});

test('transparent basket margins accept map drops but opaque surface and controls do not',async()=>{
 const u=ui();u.all().find(e=>e.className==='travel-fold').onclick();await tick();u.loadMask();
 assert.equal(u.api.containsPoint(12,12),false);assert.equal(u.api.containsPoint(55,55),true);
 const scene=u.all().find(e=>e.className==='travel-scene'),token=u.all().find(e=>e.className==='travel-passenger');
 // With an overlay over a non-map element, do not release.
 u.setHits([scene,u.all()[0]]);token.onpointerdown(pe(50,50));token.onpointermove(pe(12,12));token.onpointerup(pe(12,12));assert.equal(u.released(),null);
 // Pass the real board through the default hit getter by omitting the overlay.
 u.setHits([scene,u.board]);token.onpointerdown(pe(50,50));token.onpointermove(pe(12,12));await token.onpointerup(pe(12,12));assert.equal(u.released().x,24);
});

test('dropping on map toolbar controls does not release a passenger',async()=>{
 const u=ui();u.all().find(e=>e.className==='travel-fold').onclick();await tick();
 const control=new E('button');control.closest=()=>control;u.board.append(control);u.setHits([control,u.board]);
 const token=u.all().find(e=>e.className==='travel-passenger');token.onpointerdown(pe(30,30));token.onpointermove(pe(200,200));token.onpointerup(pe(200,200));assert.equal(u.released(),null);
});

test('ordinary parked player pieces stay in library while explicit collection enters basket',async()=>{
 const {state,config}=host(),token=state.maps[0].tokens[0];token.ownedPieceId='own';
 state.parkedOwnedPieces.own={...token,travelBasketStored:false};
 assert.equal((await config.list()).stored.length,0);
 assert.throws(()=>config.release({id:token.id,ownedPieceId:'own'}));
 delete state.parkedOwnedPieces.own;config.collect({id:token.id});
 assert.equal(state.parkedOwnedPieces.own.travelBasketStored,true);assert.equal((await config.list()).stored.length,1);
});
test('Delete returns owned pieces to library and permanently removes ordinary map pieces',()=>{
 const source=read('主控台/host/app.js'),state={selectedId:'pc',parkedOwnedPieces:{},maps:[]};
 const map={tokens:[{id:'pc',ownedPieceId:'own',hp:7,portraitVariants:[{name:'形态'}],travelBasketStored:true},{id:'npc'}]};state.maps=[map];
 const ctx={state,JSON,findToken:id=>map.tokens.find(t=>t.id===id),activeMap:()=>map,currentTurnIncludesToken:()=>false,pruneInitiativeTokenRefs:()=>({removed:false}),renumberTokens(){},renderTokens(){},updateDetail(){},encounterState:()=>({playMode:'free'}),renderTurnPath(){},scheduleAutosave(){},toast(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function parkOwnedPiece('),source.indexOf('function mergeOwnedPortraitForms(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function deleteToken(id,'),source.indexOf('// 相同棋子自动编号')),ctx);
 ctx.deleteToken('pc');assert.equal(state.parkedOwnedPieces.own.travelBasketStored,false);assert.equal(state.parkedOwnedPieces.own.hp,7);assert.equal(state.parkedOwnedPieces.own.portraitVariants.length,1);
 ctx.deleteToken('npc');assert.equal(map.tokens.length,0);assert.equal(state.travelBasketTokens,undefined);
});

test('slow basket reads apply their first result despite repeated refreshes, then perform one follow-up',async()=>{
 const u=ui();u.all().find(e=>e.className==='travel-fold').onclick();await tick();
 u.delay();const first=u.api.refresh();await tick();const before=u.calls();
 u.api.refresh(true);u.api.refresh(true);u.api.refresh(true);assert.equal(u.calls(),before);
 u.resolve();await first;assert.equal(u.all().filter(e=>e.className==='travel-passenger').length,1);
 await tick();assert.equal(u.calls(),before+1);u.resolve();await tick();
});
