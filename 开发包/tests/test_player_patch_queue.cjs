const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const source=readClientSource('主控台/player/player.js');
const section=source.slice(source.indexOf('  let patchTimer=null, pendingPatch=null'),source.indexOf('  function makePlayerConditionId'));
const tick=()=>new Promise(setImmediate);
function fixture(){
  const token={id:'t1',ownedPieceId:'o1',ownerPlayerId:'p1',characterRevision:1,hp:10,hpMax:20};
  const map={id:'m1',tokens:[token]},requests=[],messages=[];let serial=0;
  const context={state:{campaignId:'c1',_sessionId:'server1',maps:[map]},currentMap:map,
    sessionToken:'session1',myName:'甲',myPlayerId:'p1',selectedId:null,playerPortraitManagerTokenId:null,
    setTimeout:()=>++serial,clearTimeout(){},renderTokens(){},renderSpellRanges(){},openDetail(){},
    renderPlayerPortraitManager(){},syncRoomState(){},toast:message=>messages.push(message),
    encounter:()=>({playMode:'free'}),requestAction:action=>new Promise(resolve=>requests.push({action:structuredClone(action),resolve})),
    applyAction(update){if(update.op==='characterState')Object.assign(context.state.maps[0].tokens[0],update.patch);},
  };
  vm.createContext(context);vm.runInContext(section+';this.api={sendPatch,dispatchPendingPatch};',context);
  return {context,token,requests,messages,
    edit(value){const before=token.hp;token.hp=value;context.api.sendPatch(token.id,{hp:value},{hp:before});},
    ack(index,hp,revision){requests[index].resolve({ok:true,data:{ok:true,characterUpdates:[{op:'characterState',characterId:'o1',ownerPlayerId:'p1',patch:{hp,characterRevision:revision}}]}});}};
}
test('queued HP edits use the revision confirmed by their own preceding save without SSE',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();await tick();assert.equal(f.requests.length,1);
  f.ack(0,8,2);await first;await tick();assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].action.characterRevision,2);assert.equal(f.requests[1].action.patch.hp,5);
  f.ack(1,5,3);assert.equal(await second,true);assert.equal(f.token.hp,5);assert.equal(f.token.characterRevision,3);
});
test('an edit still in the debounce window receives the preceding confirmed revision',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);f.ack(0,8,2);await first;const second=f.context.api.dispatchPendingPatch();await tick();
  assert.equal(f.requests[1].action.characterRevision,2);f.ack(1,5,3);assert.equal(await second,true);
});
test('a failed earlier save restores dependent optimistic edits and sends no later request',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();await tick();
  f.requests[0].resolve({ok:false,data:{ok:false,error:'保存失败'}});
  assert.equal(await first,false);assert.equal(await second,false);assert.equal(f.requests.length,1);
  assert.equal(f.token.hp,10);
});
test('a rejected later save restores the preceding committed value',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();f.ack(0,8,2);await first;await tick();
  f.requests[1].resolve({ok:false,data:{ok:false,error:'其他修改冲突'}});assert.equal(await second,false);
  assert.equal(f.token.hp,8);assert.equal(f.token.characterRevision,2);
});
for(const field of ['campaignId','sessionToken','myPlayerId','_sessionId'])test(`queued edits do not cross a changed ${field}`,async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();await tick();
  if(field==='campaignId'||field==='_sessionId')f.context.state[field]='changed';else f.context[field]='changed';
  const replacement={...f.token,hp:19,characterRevision:40};f.context.state.maps[0].tokens=[replacement];
  f.ack(0,8,2);await first;assert.equal(await second,false);
  assert.equal(f.requests.length,1);assert.equal(replacement.hp,19);assert.equal(replacement.characterRevision,40);
});
test('acknowledgement cannot move a newer authoritative character revision backwards',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.token.hp=17;f.token.characterRevision=6;f.ack(0,8,2);await first;
  assert.equal(f.token.hp,17);assert.equal(f.token.characterRevision,6);
});
test('three sequential edits retain their own confirmed revision chain',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();f.edit(3);const third=f.context.api.dispatchPendingPatch();
  f.ack(0,8,2);await first;await tick();assert.equal(f.requests[1].action.characterRevision,2);
  f.ack(1,5,3);await second;await tick();assert.equal(f.requests[2].action.characterRevision,3);
  f.ack(2,3,4);assert.equal(await third,true);assert.equal(f.token.hp,3);assert.equal(f.token.characterRevision,4);
});
test('full condition edits use their own preceding revision and retain the later condition list',async()=>{
  const f=fixture(),firstList=[{id:'a',key:'prone'}],secondList=[...firstList,{id:'b',key:'poisoned'}];
  f.token.conditions=firstList;f.context.api.sendPatch('t1',{conditions:firstList},{conditions:[]});
  const first=f.context.api.dispatchPendingPatch();await tick();
  f.token.conditions=secondList;f.context.api.sendPatch('t1',{conditions:secondList},{conditions:firstList});
  const second=f.context.api.dispatchPendingPatch();
  f.requests[0].resolve({ok:true,data:{ok:true,characterUpdates:[{op:'characterState',characterId:'o1',ownerPlayerId:'p1',patch:{conditions:firstList,characterRevision:2}}]}});
  await first;await tick();assert.equal(f.requests[1].action.characterRevision,2);assert.deepEqual(f.requests[1].action.patch.conditions,secondList);
  f.requests[1].resolve({ok:true,data:{ok:true,characterUpdates:[{op:'characterState',characterId:'o1',ownerPlayerId:'p1',patch:{conditions:secondList,characterRevision:3}}]}});
  assert.equal(await second,true);assert.deepEqual(f.token.conditions,secondList);
});
test('external character updates do not become permission to overwrite a real revision conflict',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.edit(5);const second=f.context.api.dispatchPendingPatch();f.token.hp=17;f.token.characterRevision=6;
  f.ack(0,8,2);await first;await tick();assert.equal(f.requests[1].action.characterRevision,2);
  f.requests[1].resolve({ok:false,data:{ok:false,error:'角色状态已更新'}});assert.equal(await second,false);
  assert.equal(f.token.hp,17);assert.equal(f.token.characterRevision,6);
});
test('a stale old-campaign edit does not cancel an independent new-campaign edit',async()=>{
  const f=fixture();f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();
  f.context.state.campaignId='c2';const next={...f.token,hp:19,characterRevision:40};
  f.context.state.maps[0].tokens=[next];f.context.currentMap=f.context.state.maps[0];
  next.hp=16;f.context.api.sendPatch(next.id,{hp:16},{hp:19});const second=f.context.api.dispatchPendingPatch();
  f.requests[0].resolve({ok:false,data:{ok:false,error:'战役已切换'}});assert.equal(await first,false);await tick();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].action.characterRevision,40);
  f.requests[1].resolve({ok:true,data:{ok:true,characterUpdates:[{op:'characterState',characterId:'o1',ownerPlayerId:'p1',patch:{hp:16,characterRevision:41}}]}});
  assert.equal(await second,true);assert.equal(next.hp,16);assert.equal(next.characterRevision,41);
});
test('unknown mutation results reconcile committed server state and cancel dependent writes without resending',async()=>{
  const f=fixture();let finish,reads=0;f.context.requestAction=()=>new Promise((resolve,reject)=>{finish=reject;});
  f.context.syncRoomState=async context=>{reads++;assert.equal(context.campaignId,'c1');f.token.hp=8;f.token.characterRevision=2;return true;};
  f.edit(8);const first=f.context.api.dispatchPendingPatch();await tick();f.edit(5);const second=f.context.api.dispatchPendingPatch();
  finish(Object.assign(new Error('timeout'),{name:'TimeoutError'}));assert.equal(await first,false);assert.equal(await second,false);
  assert.equal(reads,2);assert.equal(f.token.hp,8);assert.equal(f.token.characterRevision,2);assert.ok(f.messages.some(message=>/回执未确认.*重新读取/.test(message)));
});
test('missing acknowledgement with failed server read remains explicitly unconfirmed',async()=>{
  const f=fixture();f.context.requestAction=async()=>({ok:false,unconfirmed:true,data:{error:'未收到有效操作确认'}});
  f.context.syncRoomState=async()=>false;f.edit(8);assert.equal(await f.context.api.dispatchPendingPatch(),false);
  assert.ok(f.messages.some(message=>/结果未确认.*也未读取成功/.test(message)));
});
