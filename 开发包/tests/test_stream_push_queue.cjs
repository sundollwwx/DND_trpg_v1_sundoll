const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHostStateFixture}=require('./host_state_fixture.cjs');
const flush=()=>new Promise(setImmediate);
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

test('host publishes queued map changes serially with each acknowledged CAS baseline',async()=>{
  let now=1000,currentMap={id:'map-a',mapData:'data:image/png;base64,AAA'};
  const requests=[],pending=[],signals=[],timers=new Set();
  const {context:c}=createHostStateFixture({
    setTimeout(callback,delay){const timer=setTimeout(callback,delay);timers.add(timer);return timer;},
    clearTimeout(timer){timers.delete(timer);clearTimeout(timer);},
    Date:{now:()=>now},presentedMap:()=>currentMap,
    buildStreamPayload:()=>({maps:[{id:currentMap.id,mapData:currentMap.mapData}]}),
    fetch:(_url,options)=>{
      assert.ok(options.signal instanceof AbortSignal,'uploads are abortable');signals.push(options.signal);
      requests.push(JSON.parse(options.body));const job=deferred();pending.push(job);return job.promise;
    },
  });
  try {
    c.streamTick();await flush();
    assert.equal(requests.length,1);assert.equal(requests[0].maps[0].id,'map-a');
    assert.equal(requests[0].expectedStateRevision,7);assert.equal(requests[0].serverSessionId,'session-1');
    assert.equal(timers.size,1,'the in-flight request owns its timeout');
    currentMap={id:'map-b',mapData:'data:image/png;base64,BBB'};c.streamDirty=true;now=1400;c.streamTick();await flush();
    assert.equal(requests.length,1,'there is no parallel upload');assert.equal(c.streamDirty,true,'a queued change is retained');
    pending[0].resolve({ok:true,json:async()=>({stateRevision:8,sessionId:'session-1',mapId:'map-a',mapAssetUrl:'/api/assets/map-a'})});await flush();
    assert.equal(timers.size,0);assert.equal(c.hostStateRevision,8);
    now=1800;c.streamTick();await flush();
    assert.equal(requests.length,2);assert.equal(requests[1].maps[0].id,'map-b');
    assert.equal(requests[1].expectedStateRevision,8,'only the acknowledged predecessor authorizes this write');
    pending[1].resolve({ok:true,json:async()=>({stateRevision:9,sessionId:'session-1',mapId:'map-b',mapAssetUrl:'/api/assets/map-b'})});await flush();
    assert.equal(c.streamDirty,false);assert.equal(c.hostStateRevision,9);assert.equal(c.hostStateConflict,null);
    assert.equal(timers.size,0);assert.ok(signals.every(signal=>!signal.aborted));
  } finally {for(const timer of timers)clearTimeout(timer);}
});
