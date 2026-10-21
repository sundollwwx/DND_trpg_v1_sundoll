const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const runtime=require(require('node:path').join(require('./project_paths.cjs').APP_ROOT,'主控台/shared/client-runtime.js'));
const source=readClientSource('主控台/player/player.js'),start=source.indexOf('  function requestAction('),end=source.indexOf('  function dataUrlBytes(',start);
const tick=()=>new Promise(setImmediate);
function fixture(fetch){
  const timers=new Map(),calls=[],revoked=[];let next=0;
  const context={sessionToken:'session1',myName:'甲',myPlayerId:'p1',state:{campaignId:'c1',_sessionId:'server1'},
    actionId:()=> 'action1',AbortController,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{calls.push({url,options});return fetch(url,options);},handleSessionRevoked:entry=>revoked.push(entry)};
  context.SundollClientRuntime={requestJson:(url,options,settings)=>runtime.requestJson(url,options,{...settings,env:context})};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return{context,calls,revoked,timers,expire(){for(const timeout of [...timers.values()])timeout();}};
}
test('player mutation timeout ends a stalled request without automatically resending it',async()=>{
  const f=fixture(()=>new Promise(()=>{})),pending=f.context.requestAction({op:'patchToken',tokenId:'t1',patch:{hp:8}});
  await tick();f.expire();await assert.rejects(pending,{name:'TimeoutError'});assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.timers.size,0);
});
test('the player mutation deadline includes a stalled acknowledgement body and ignores its late result',async()=>{
  let finish;const f=fixture(async()=>({ok:true,status:200,json:()=>new Promise(resolve=>finish=resolve)}));
  const pending=f.context.requestAction({op:'patchToken'});await tick();f.expire();await assert.rejects(pending,{name:'TimeoutError'});
  finish({ok:true});await tick();assert.equal(f.calls.length,1);assert.equal(f.timers.size,0);
});
test('HTTP 200 with malformed or missing acknowledgement cannot claim a saved mutation',async()=>{
  for(const reply of [()=>{throw new SyntaxError('bad JSON');},()=>({})]){
    const f=fixture(async()=>({ok:true,status:200,json:async()=>reply()})),result=await f.context.requestAction({op:'patchToken'});
    assert.equal(result.ok,false);assert.equal(result.unconfirmed,true);assert.match(result.data.error,/未收到有效操作确认/);assert.equal(f.calls.length,1);
  }
});
test('a valid mutation receipt retains confirmed character updates and original request context',async()=>{
  const updates=[{op:'characterState',characterId:'o1',patch:{characterRevision:2}}];
  const f=fixture(async()=>({ok:true,status:200,json:async()=>({ok:true,characterUpdates:updates})}));
  const pending=f.context.requestAction({op:'patchToken',tokenId:'t1'});f.context.state.campaignId='new';
  const result=await pending;assert.equal(result.ok,true);assert.deepEqual(result.data.characterUpdates,updates);
  assert.equal(JSON.parse(f.calls[0].options.body).campaignId,'c1');assert.equal(f.timers.size,0);
});
test('a late unauthorized receipt for an earlier identity cannot revoke the newly joined player',async()=>{
  let finish;const f=fixture(async()=>({ok:false,status:401,json:()=>new Promise(resolve=>finish=resolve)}));
  const pending=f.context.requestAction({op:'patchToken'});await tick();f.context.sessionToken='session2';f.context.myPlayerId='p2';
  finish({ok:false,error:'会话已失效'});assert.equal((await pending).ok,false);assert.deepEqual(f.revoked,[]);
});

function stateFixture(fetch){
  const f=fixture(fetch),renders=[];f.context.render=data=>renders.push(data);
  f.context.playerPatchContext=()=>({sessionToken:f.context.sessionToken,playerId:f.context.myPlayerId,campaignId:f.context.state.campaignId,serverSessionId:f.context.state._sessionId});
  const stateStart=source.indexOf('  async function syncRoomState('),stateEnd=source.indexOf('  const playerSyncDiagnostics',stateStart);
  vm.runInContext(source.slice(stateStart,stateEnd),f.context);return{...f,renders};
}
test('state reconciliation has a deadline, including a stalled JSON body',async()=>{
  const f=stateFixture(async()=>({ok:true,json:()=>new Promise(()=>{})})),pending=f.context.syncRoomState();
  await tick();f.expire();assert.equal(await pending,false);assert.deepEqual(f.renders,[]);assert.equal(f.calls.length,1);
});
for(const field of ['campaignId','_sessionId','sessionToken','myPlayerId'])test(`a state read cannot replace a changed ${field}`,async()=>{
  let finish;const f=stateFixture(async()=>({ok:true,json:()=>new Promise(resolve=>finish=resolve)})),pending=f.context.syncRoomState();await tick();
  if(field==='campaignId'||field==='_sessionId')f.context.state[field]='changed';else f.context[field]='changed';
  finish({campaignId:'c1',_sessionId:'server1',maps:[]});assert.equal(await pending,false);assert.deepEqual(f.renders,[]);
});
test('state reconciliation accepts only valid state for the same campaign and server',async()=>{
  const replies=[{campaignId:'wrong',_sessionId:'server1',maps:[]},{campaignId:'c1',_sessionId:'wrong',maps:[]},{}, {campaignId:'c1',_sessionId:'server1',maps:[]}];
  const f=stateFixture(async()=>({ok:true,json:async()=>replies.shift()}));
  for(let index=0;index<3;index++)assert.equal(await f.context.syncRoomState(),false);
  assert.equal(await f.context.syncRoomState(),true);assert.equal(f.renders.length,1);
});
