const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const {MemoryStorage}=require('./pending_requests_fixture.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=(markers=[])=>({ok:true,status:200,json:async()=>({ok:true,revision:1,markers})});
class Element{
  constructor(){this.children=[];this.events={};this.style={};this.dataset={};this.classList={add(){},remove(){}};}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  addEventListener(name,fn){this.events[name]=fn;}setAttribute(){}
  querySelectorAll(){return this.children;}querySelector(){return null;}
  getBoundingClientRect(){return {left:0,top:0};}
}
function setup({host=true,hidden=false,handler=async()=>response()}={}){
  const body=new Element(),world=new Element(),board=new Element(),listeners=new Map(),timers=new Map(),calls=[],identityCalls=[],storage=new MemoryStorage();let nextTimer=0,session='player-session',mapId='map1';
  const document={body,hidden,createElement:()=>new Element(),addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);}};
  const context=vm.createContext({window:{},document,MutationObserver:class{observe(){}},crypto:{randomUUID:()=> 'visibility-test-request'},
    location:{origin:'http://127.0.0.1:9999',hostname:'127.0.0.1'},localStorage:storage,AbortController,setTimeout,clearTimeout,
    setInterval(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearInterval(id){timers.delete(id);},
    fetch:async(path,options)=>{
      if(path==='/api/map-items'){const command=JSON.parse(options.body);calls.push(command);return handler(command);}
      identityCalls.push(path);
      let data;
      if(path==='/api/info')data={projectId:'test-workspace',authentication:{method:'name'}};
      else if(path==='/api/workspace-epoch')data={epoch:'test-epoch'};
      else if(path.startsWith('/api/session?'))data={session:{playerId:'player-id',persistent:true}};
      else throw Error('unexpected identity read: '+path);
      return {ok:true,status:200,json:async()=>data};
    }});
  vm.runInContext(readClientSource('主控台/shared/pending-requests.js'),context);
  vm.runInContext(readClientSource('主控台/shared/map-items.js'),context);
  const api=context.window.MapItems,config={host,campaign:()=> 'campaign1',map:()=>mapId?{id:mapId,mapW:500,mapH:500}:null,session:()=>session,world:()=>world,board:()=>board,zoom:()=>1};
  api.configure(config);
  return {api,config,calls,identityCalls,storage,world,board,body,timers,listeners,setHandler(fn){handler=fn;},setSession(value){session=value;},setMap(value){mapId=value;},
    visible(value){document.hidden=!value;for(const fn of listeners.get('visibilitychange')||[])fn();},
    tick(){for(const timer of timers.values()){assert.equal(timer.ms,1800);timer.fn();}}};
}

for(const host of [true,false])test(`hidden pages stop timers and automatic reads, then refresh on visibility for host=${host}`,async()=>{
  const t=setup({host});await flush();assert.equal(t.calls.length,1);assert.equal(t.timers.size,1);
  const staleTick=[...t.timers.values()][0].fn;
  t.visible(false);assert.equal(t.timers.size,0);staleTick();await t.api.refresh();await flush();
  assert.equal(t.calls.length,1);
  t.visible(true);await flush();assert.equal(t.calls.length,2);assert.equal(t.timers.size,1);
  t.tick();await flush();assert.equal(t.calls.length,3);
});

test('configuration in a hidden page defers automatic reads and binds visibility once',async()=>{
  const t=setup({hidden:true});t.api.configure(t.config);
  assert.equal(t.calls.length,0);assert.equal(t.timers.size,0);assert.equal(t.listeners.get('visibilitychange').size,1);
  t.visible(true);await flush();assert.equal(t.calls.length,1);assert.equal(t.timers.size,1);
});

test('visibility refresh shares an existing read and keeps player session and map guards',async()=>{
  let release;const t=setup({host:false,handler:()=>new Promise(resolve=>{release=resolve;})});
  t.visible(false);t.visible(true);t.tick();assert.equal(t.calls.length,1);
  t.setSession('replacement-session');
  release(response([{id:'stale-marker',name:'Old session loot',visible:true,size:1,items:[]} ]));await flush();
  assert.equal(t.world.children.length,0);
  t.setHandler(async()=>response());t.tick();await flush();
  assert.equal(t.calls.length,2);assert.equal(t.calls[1].sessionToken,'replacement-session');
  t.visible(false);t.setSession('');t.visible(true);t.tick();await flush();assert.equal(t.calls.length,2);
  t.setSession('replacement-session');t.setMap('');t.tick();await flush();assert.equal(t.calls.length,2);
});

test('forced manual reads and placement writes remain available while hidden',async()=>{
  const t=setup({hidden:true});
  await t.api.containers();assert.equal(t.calls.length,1);
  assert.equal(await t.api.place({id:'potion',version:1,name:'药水'},2),true);
  t.board.events.pointerdown({button:0,clientX:30,clientY:40,preventDefault(){},stopImmediatePropagation(){}});await flush();
  assert.deepEqual(t.calls.map(call=>call.op),['get','get','place']);
  assert.equal(t.calls[2].quantity,2);assert.equal(t.calls[2].x,30);assert.equal(t.calls[2].y,40);
  assert.ok(t.identityCalls.includes('/api/info'));assert.ok(t.identityCalls.includes('/api/workspace-epoch'));
  assert.equal(t.storage.length,0,'confirmed writes clear the durable pending request');
  assert.equal(t.timers.size,0);
});

for(const status of [401,403])test(`visibility refresh still clears player loot after permission denial ${status}`,async()=>{
  const marker={id:'marker',name:'Loot',visible:true,size:1,x:10,y:10,items:[]};
  const t=setup({host:false,handler:async()=>response([marker])});await flush();assert.equal(t.world.children.length,1);
  t.visible(false);t.setHandler(async()=>({ok:false,status,json:async()=>({ok:false,error:'permission denied'})}));
  t.visible(true);await flush();assert.equal(t.calls.length,2);assert.equal(t.world.children.length,0);
});
