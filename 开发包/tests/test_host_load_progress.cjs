const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const loading=require(path.join(require('./project_paths.cjs').APP_ROOT,'主控台/host/load-progress.js'));
function fixture(){let time=0;const samples=[];const controller=loading.create({now:()=>time,changed:sample=>samples.push(sample),yieldTask:()=>Promise.resolve()});return{controller,samples,advance:ms=>time+=ms};}
test('loading stages report actual elapsed time while work is pending and complete only after resolution',async()=>{
  const f=fixture(),run=f.controller.begin('campaign');let finish;
  const pending=run.step('saveRead',()=>new Promise(resolve=>finish=resolve));await Promise.resolve();f.advance(530);
  assert.equal(f.controller.snapshot().status,'running');assert.equal(f.controller.snapshot().stages[0].elapsedMs,530);
  finish('data');assert.equal(await pending,'data');run.finish();f.advance(2000);
  assert.equal(f.controller.snapshot().elapsedMs,530);assert.equal(f.controller.snapshot().status,'success');
});
test('failed loading preserves its precise stage and safe class, with no raw error text in diagnostics',async()=>{
  const f=fixture(),run=f.controller.begin('campaign'),secret='name-account-token-file-path';
  await assert.rejects(run.step('parse',()=>{throw Object.assign(new Error(secret),{name:'Secret '+secret});}));
  assert.equal(f.controller.snapshot().status,'failure');assert.equal(f.controller.snapshot().stages[0].stage,'parse');
  assert.equal(f.controller.snapshot().stages[0].errorClass,'Error');assert.doesNotMatch(f.controller.summaryText(),/name-account|token-file|path/);
  assert.match(f.controller.summaryText(),/解析存档.*失败.*Error/);
});
test('a timed out read exposes TimeoutError and manual retry runs once despite repeated clicks',async()=>{
  const f=fixture();let attempts=0,finish;const run=f.controller.begin('home',{retry:()=>{attempts++;return new Promise(resolve=>finish=resolve);}});
  await assert.rejects(run.step('catalog',()=>{throw Object.assign(new Error('private URL'),{name:'TimeoutError'});}));
  assert.match(f.controller.summaryText(),/TimeoutError/);const retry=f.controller.retry();assert.equal(await f.controller.retry(),false);
  assert.equal(attempts,1);finish(true);assert.equal(await retry,true);
});
test('a replacement run cannot be overwritten by an older late completion',async()=>{
  const f=fixture(),old=f.controller.begin('home');let finish;const pending=old.step('catalog',()=>new Promise(resolve=>finish=resolve));await Promise.resolve();
  const next=f.controller.begin('campaign');await next.step('library',()=>true);finish('old');await pending;old.finish();
  assert.equal(f.controller.snapshot().kind,'campaign');assert.deepEqual(f.controller.snapshot().stages.map(row=>row.stage),['library']);
});
test('optional persistence failures remain visible after successful reading and do not claim all stages succeeded',async()=>{
  const f=fixture(),run=f.controller.begin('campaign');await run.step('saveRead',()=>true);
  await assert.rejects(run.step('selection',()=>{throw new Error('write unknown');}));run.resume();await run.step('connection',()=>true);run.skip('connection');run.finish();
  assert.equal(f.controller.snapshot().status,'partial');assert.equal(f.controller.snapshot().stages.at(-1).status,'skipped');
  assert.equal(f.controller.snapshot().stages[1].status,'failure');
});
test('diagnostic schema accepts only fixed stages and omits identities, paths and payloads',async()=>{
  const f=fixture();assert.throws(()=>f.controller.begin('secret-room-id'),/Unknown/);const run=f.controller.begin('home');
  await assert.rejects(run.step('private-path',()=>true),/Unknown/);await run.step('catalog',()=>({email:'a@b.test',campaignId:'secret',url:'https://a/?token=secret'}));run.finish();
  const summary=f.controller.summaryText();assert.doesNotMatch(summary,/@|campaignId|secret|https|token=/);assert.match(summary,/读取战役目录.*成功/);
});
test('cancelled loading cannot become completed when a later callback resolves',async()=>{
  const f=fixture(),run=f.controller.begin('campaign');let finish;const pending=run.step('saveRead',()=>new Promise(resolve=>finish=resolve));await Promise.resolve();
  run.cancel();finish(true);await pending;run.finish();assert.equal(f.controller.snapshot().status,'cancelled');assert.equal(f.controller.snapshot().stages[0].status,'cancelled');
});
function domFixture(){
  const nodes=new Map();function node(){return{hidden:true,children:[],dataset:{},textContent:'',value:'',events:{},setAttribute(){},replaceChildren(...children){this.children=children;},addEventListener(type,fn){this.events[type]=fn;},focus(){this.focused=true;},select(){this.selected=true;}};}
  const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
  const timers=new Map();let serial=0;const env={document,navigator:{clipboard:{writeText:async()=>{throw new Error('unavailable');}}},setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)};
  const f=fixture();loading.mount(f.controller,env);return{...f,nodes,timers};
}
test('clipboard failure supplies selectable Chinese diagnostic text and visible retry for the failed stage',async()=>{
  const f=domFixture(),run=f.controller.begin('home',{retry:()=>true});await assert.rejects(run.step('catalog',()=>{throw new Error('private');}));
  await f.nodes.get('host-load-copy').events.click();const output=f.nodes.get('host-load-summary');
  assert.equal(output.hidden,false);assert.equal(output.focused,true);assert.equal(output.selected,true);assert.match(output.value,/读取战役目录.*失败/);assert.doesNotMatch(output.value,/private/);
  assert.equal(f.nodes.get('host-load-retry').hidden,false);assert.equal(f.timers.size,0);
});
test('closing diagnostics does not cancel a read, and a new read makes progress visible again',async()=>{
  const f=domFixture(),run=f.controller.begin('home');f.nodes.get('host-load-close').events.click();assert.equal(f.controller.snapshot().status,'running');
  run.finish();assert.equal(f.nodes.get('host-load-progress').hidden,true);f.controller.begin('campaign');assert.equal(f.nodes.get('host-load-progress').hidden,false);
});

test('successful diagnostics dismiss, but reopening or reading them keeps them visible',async()=>{
  const f=domFixture(),run=f.controller.begin('home');await run.step('catalog',()=>true);run.finish();
  assert.equal(f.timers.size,1);for(const [id,callback] of [...f.timers]){f.timers.delete(id);callback();}
  assert.equal(f.nodes.get('host-load-progress').hidden,true);
  f.nodes.get('btn-host-load-diagnostics').events.click();
  assert.equal(f.nodes.get('host-load-progress').hidden,false);
  const next=f.controller.begin('campaign');await next.step('saveRead',()=>true);next.finish();
  f.nodes.get('host-load-progress').events.focusin();
  assert.equal(f.nodes.get('host-load-progress').hidden,false);
  assert.equal(f.timers.size,0);
});
test('a failed replacement load cancels the success dismissal and remains visible',async()=>{
  const f=domFixture(),first=f.controller.begin('home');first.finish();assert.equal(f.timers.size,1);
  const next=f.controller.begin('campaign');await assert.rejects(next.step('saveRead',()=>{throw new Error('read failed');}));
  assert.equal(f.timers.size,0);assert.equal(f.nodes.get('host-load-progress').hidden,false);
  assert.equal(f.nodes.get('host-load-progress').dataset.state,'failure');
});
