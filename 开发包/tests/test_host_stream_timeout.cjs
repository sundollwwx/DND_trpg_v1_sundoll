const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHostStateFixture}=require('./host_state_fixture.cjs');
const flush=()=>new Promise(setImmediate);
function fixture(){
  let timer,cleared=0,calls=0;
  const f=createHostStateFixture({
    setTimeout:callback=>{timer=callback;return 1;}, clearTimeout:()=>cleared++,
    fetch:(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));},
  });
  return {...f,c:f.context,expire:()=>timer(),stats:()=>({cleared,calls})};
}
test('hung host sync releases its lock, preserves the draft and blocks blind later uploads',async()=>{
  const f=fixture(),first=f.c.streamPush();assert.equal(f.c.streamPushing,true);
  await flush();await f.c.streamPush();assert.equal(f.stats().calls,1);
  f.expire();assert.equal(await first,false);
  assert.equal(f.c.streamPushing,false);assert.equal(f.c.hostStatePostPending,false);assert.equal(f.stats().cleared,1);
  assert.equal(f.c.hostStateConflict.errorCode,'state-result-unknown');assert.equal(f.c.hostStateRevision,7);
  assert.equal(JSON.parse(f.browser.get('test-state:conflict-draft')).state.maps[0].tokens[0].hp,8);
  assert.equal(f.recovery.length,1);
  f.c.streamDirty=true;f.c.streamTick();assert.equal(await f.c.streamPush(),false);
  assert.equal(f.stats().calls,1,'an unknown result requires explicit recovery, never a retry of an old snapshot');
});
test('response-body timeout cannot acknowledge or advance a host synchronization',async()=>{
  const f=fixture();let calls=0;
  f.c.fetch=async(_url,{signal})=>{calls++;return {ok:true,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))};};
  const pending=f.c.streamPush();await flush();f.expire();assert.equal(await pending,false);
  assert.equal(f.c.streamPushing,false);assert.equal(f.c.hostStatePostPending,false);
  assert.equal(f.c.hostStateConflict.errorCode,'state-result-unknown');assert.equal(f.c.hostStateRevision,7);
  assert.ok(f.browser.has('test-state:conflict-draft'));assert.equal(f.c.streamDirty,false);
  await f.c.streamPush();assert.equal(calls,1);
});
