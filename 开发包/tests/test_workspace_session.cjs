const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const source=readClientSource('shared/workspace-session.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const response=epoch=>({ok:true,status:200,json:async()=>({epoch})});

function setup(initialHandler){
  const calls=[],timers=new Map();let handler=initialHandler,nextTimer=0;
  const context=vm.createContext({URL,Headers,AbortController,location:{href:'https://table.example/player',origin:'https://table.example'},
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    window:{fetch(input,options={}){const url=new URL(input.url||input,'https://table.example/player');const call={url,options};calls.push(call);return handler(call);}}});
  vm.runInContext(source,context);
  return {fetch:context.window.fetch,calls,timers,setHandler(fn){handler=fn;},expire(){
    assert.equal(timers.size,1);const [id,timer]=timers.entries().next().value;assert.equal(timer.ms,8000);timers.delete(id);timer.fn();
  }};
}

for(const firstEpoch of ['first',''])test(`first successful epoch remains fixed after restoration, including ${JSON.stringify(firstEpoch)}`,async()=>{
  const first=deferred();let epoch='new-workspace';
  const t=setup(()=>first.promise);
  const writes=[t.fetch('/api/modules',{method:'POST',headers:{'Content-Type':'application/json'}}),t.fetch('/api/local-save',{method:'POST'})];
  assert.equal(t.calls.length,1);
  t.setHandler(call=>call.url.pathname==='/api/workspace-epoch'?response(epoch):Promise.resolve({ok:false,status:409}));
  first.resolve(response(firstEpoch));await Promise.all(writes);
  assert.equal(t.calls.length,3);assert.equal(t.timers.size,0);
  assert.equal(t.calls[1].options.headers.get('Content-Type'),'application/json');
  for(const call of t.calls.slice(1))assert.equal(call.options.headers.get('X-Sundoll-Workspace'),firstEpoch);
  await t.fetch('/api/workspace-epoch');
  const restored=await t.fetch(new Request('https://table.example/api/local-save',{method:'POST',headers:{'X-Test':'request-header'}}));
  assert.equal(restored.status,409);assert.equal(t.calls.at(-1).options.headers.get('X-Test'),'request-header');
  assert.equal(t.calls.at(-1).options.headers.get('X-Sundoll-Workspace'),firstEpoch);
  await t.fetch('/api/local-save',{method:'POST'});
  assert.equal(t.calls.filter(call=>call.url.pathname==='/api/workspace-epoch').length,2);
  assert.equal(t.calls.at(-1).options.headers.get('X-Sundoll-Workspace'),firstEpoch);
});

for(const stalledPhase of ['connection','body'])test(`epoch ${stalledPhase} timeout rejects writes and a late response cannot capture an epoch`,async()=>{
  const late=deferred();
  const t=setup(()=>stalledPhase==='connection'?late.promise:Promise.resolve({ok:true,json:()=>late.promise}));
  const failedWrite=assert.rejects(t.fetch('/api/join',{method:'POST'}),/工作区校验超时.*重试.*操作尚未发送/);
  await flush();t.expire();await failedWrite;
  assert.equal(t.calls.length,1);assert.equal(t.calls[0].options.signal.aborted,true);assert.equal(t.timers.size,0);
  late.resolve(stalledPhase==='connection'?response('late-old-epoch'):{epoch:'late-old-epoch'});await flush();
  const retry=deferred();t.setHandler(()=>retry.promise);
  const writes=[t.fetch('/api/join',{method:'POST'}),t.fetch('/api/map-items',{method:'POST'})];
  assert.equal(t.calls.length,2);
  t.setHandler(()=>Promise.resolve({ok:true,status:200}));retry.resolve(response('recovered'));
  await Promise.all(writes);
  assert.equal(t.calls.length,4);assert.equal(t.timers.size,0);
  for(const call of t.calls.slice(2))assert.equal(call.options.headers.get('X-Sundoll-Workspace'),'recovered');
});

for(const failure of ['http','json','missing epoch'])test(`initial ${failure} failure can be retried without sending the blocked write`,async()=>{
  const t=setup(async()=>failure==='http'?{ok:false,status:503}:failure==='json'?{ok:true,json:async()=>{throw new SyntaxError('invalid JSON');}}:{ok:true,json:async()=>({ok:true})});
  await assert.rejects(t.fetch('/api/join',{method:'POST'}),/无法校验工作区.*重试.*操作尚未发送/);
  assert.equal(t.calls.length,1);assert.equal(t.timers.size,0);
  t.setHandler(async()=>response('working'));
  await Promise.all([t.fetch('/api/join',{method:'POST'}),t.fetch('/api/session',{method:'POST'})]);
  assert.equal(t.calls.filter(call=>call.url.pathname==='/api/workspace-epoch').length,2);
  for(const call of t.calls.slice(2))assert.equal(call.options.headers.get('X-Sundoll-Workspace'),'working');
});

test('read-only requests and other origins remain independent of a stalled epoch',async()=>{
  const t=setup(()=>new Promise(()=>{}));
  t.setHandler(async()=>({ok:true,status:200}));
  for(const method of ['GET','HEAD','OPTIONS'])await t.fetch('/api/info',{method});
  await t.fetch('https://other.example/api/submit',{method:'POST'});
  await t.fetch('/outside-api',{method:'POST'});
  assert.equal(t.calls.length,6);
  for(const call of t.calls.slice(1))assert.equal(call.options.headers,undefined);
  t.expire();await flush();
});
