const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {APP_ROOT}=require('./project_paths.cjs');
const runtime=require(path.join(APP_ROOT,'主控台/shared/client-runtime.js'));
const {createMapDom,rules}=require('./map_render_fixture.cjs');
const tick=()=>new Promise(setImmediate);
function timerEnv(extra={}){let serial=0;const timers=new Map();return{env:{AbortController,setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),...extra},timers,expire(){for(const fn of [...timers.values()])fn();}};}
test('request deadline covers a stalled JSON body and clears timers after timeout and success',async()=>{
 let finishBody,captured;const f=timerEnv({fetch:async(url,options)=>{captured=options.signal;return{ok:true,json:()=>new Promise(resolve=>finishBody=resolve)};}});
 const stalled=runtime.requestJson('/api/info',{}, {env:f.env,timeoutMs:8000});await tick();f.expire();
 await assert.rejects(stalled,{name:'TimeoutError'});assert.equal(captured.aborted,true);assert.equal(f.timers.size,0);
 finishBody({secret:'late'});await tick();
 f.env.fetch=async()=>({ok:true,json:async()=>({ok:true})});const done=await runtime.requestJson('/api/info',{}, {env:f.env});assert.equal(done.data.ok,true);assert.equal(f.timers.size,0);
});
test('external cancellation ends a stalled request even when fetch ignores abort',async()=>{
 const f=timerEnv({fetch:()=>new Promise(()=>{})}),controller=new AbortController();
 const pending=runtime.requestJson('/api/test',{signal:controller.signal},{env:f.env});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(f.timers.size,0);
});
test('read timeout is visible, permits retry, and never applies a late result',async()=>{
 const f=timerEnv(),applied=[],errors=[],reads=[];let key='a';
 const coordinator=runtime.createReadCoordinator({env:f.env,key:()=>key,canRead:()=>true,read:signal=>new Promise(resolve=>reads.push({signal,resolve})),apply:v=>applied.push(v),error:e=>errors.push(e.name)});
 const one=coordinator.request();await tick();f.expire();await one;assert.deepEqual(errors,['TimeoutError']);assert.equal(reads[0].signal.aborted,true);
 const two=coordinator.request();await tick();reads[0].resolve('late');reads[1].resolve('fresh');await two;assert.deepEqual(applied,['fresh']);assert.equal(f.timers.size,0);
});
test('new basket context starts immediately and ignores old result and errors',async()=>{
 const f=timerEnv(),applied=[],errors=[],reads=[];let key='player-a';
 const coordinator=runtime.createReadCoordinator({env:f.env,key:()=>key,canRead:()=>true,read:signal=>new Promise((resolve,reject)=>reads.push({signal,resolve,reject})),apply:v=>applied.push(v),error:e=>errors.push(e)});
 const old=coordinator.request();await tick();key='player-b';const current=coordinator.request();await tick();
 assert.equal(reads.length,2);assert.equal(reads[0].signal.aborted,true);reads[1].resolve('b');await current;reads[0].reject(new Error('a'));await old;
 assert.deepEqual(applied,['b']);assert.equal(errors.length,0);assert.equal(f.timers.size,0);
});
test('cover cache avoids unchanged geometry work and invalidates every covering and grid change',()=>{
 const dom=createMapDom(),map={mapW:500,mapH:400,gridSize:50,gridOffsetX:0,gridOffsetY:0,gridCover:{all:false,cells:{'1,1':true}}};
 let paths=0;const measured={...rules,mapCoverPath:m=>{paths++;return rules.mapCoverPath(m);}};
 const render=m=>runtime.renderCover(dom.world,m,{rules:measured,document:dom.document});
 const svg=render(map),shape=svg.firstChild;let writes=0;const write=shape.setAttribute.bind(shape);shape.setAttribute=(name,value)=>{if(name==='d')writes++;write(name,value);};
 for(let i=0;i<100;i++)render({...map,cam:{x:i,y:i,zoom:1+i/100}});assert.equal(paths,1);assert.equal(writes,0);
 const mutations=[()=>map.gridCover.cells['2,2']=true,()=>delete map.gridCover.cells['1,1'],()=>map.gridCover.all=true,()=>map.gridSize=25,()=>map.gridOffsetX=3,()=>map.gridOffsetY=4,()=>map.mapW=600,()=>map.mapH=450,()=>map.gridCover={all:false,cells:{}}];
 for(const mutate of mutations){mutate();const before=paths;render(map);assert.equal(paths,before+1);assert.equal(shape.getAttribute('d'),rules.mapCoverPath(map));render(map);assert.equal(paths,before+1);}
 assert.equal(writes,mutations.length);assert.equal(svg.getAttribute('width'),'600');assert.equal(svg.getAttribute('height'),'450');
 runtime.renderCover(dom.world,map,{rules:measured,document:dom.document,host:true});assert.equal(shape.getAttribute('fill'),'rgba(5,10,20,.55)');
});
test('diagnostics retain only bounded fixed metadata and rate-limit visible notices',()=>{
 let at=0,notices=0;const d=runtime.createDiagnostics({now:()=>at,notify:()=>notices++});
 for(let i=0;i<25;i++)d.report('stream-processing',new TypeError('secret player and https://private/path'),'action');
 assert.equal(d.snapshot().length,20);assert.equal(notices,1);assert.ok(!JSON.stringify(d.snapshot()).includes('secret'));
 at=10000;d.report('secret-player',Object.assign(new Error('password'),{name:'PlayerSecretError'}),'secret-event');assert.equal(notices,2);
 assert.deepEqual(d.snapshot().at(-1),{at:10000,code:'unknown',error:'Error',type:'unknown'});
 const copied=d.snapshot();copied[0].code='changed';assert.equal(d.snapshot()[0].code,'stream-processing');
});
test('early component failure shows one persistent generic retry notice once body exists',()=>{
 const events={},documentEvents={},nodes=new Map(),created=[];let reloads=0;
 const env={location:{reload:()=>reloads++},addEventListener:(name,fn)=>events[name]=fn,document:{body:null,getElementById:id=>nodes.get(id),addEventListener:(name,fn)=>documentEvents[name]=fn,createElement:tag=>({tag,style:{},children:[],setAttribute(){},append(child){this.children.push(child);}})}};
 const d=runtime.installLoadDiagnostics(env);events.error({target:{tagName:'SCRIPT',src:'https://private'},error:new Error('private')});assert.equal(created.length,0);
 env.document.body={append(node){created.push(node);nodes.set(node.id,node);}};documentEvents.DOMContentLoaded();assert.equal(created.length,1);assert.equal(created[0].children.length,1);created[0].children[0].onclick();assert.equal(reloads,1);
 events.unhandledrejection({reason:new TypeError('private')});assert.equal(created.length,1);assert.equal(runtime.installLoadDiagnostics(env),d);assert.ok(!JSON.stringify(d.snapshot()).includes('private'));
});
