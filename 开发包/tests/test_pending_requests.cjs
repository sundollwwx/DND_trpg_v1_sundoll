const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../../程序包/主程序/主控台/shared/pending-requests.js');
const {MemoryStorage}=require('./pending_requests_fixture.cjs');
function setup(channel='backpack',storage=new MemoryStorage()){
 const state={projectId:'workspace-a',epoch:'epoch-a',accountId:'',roomId:'',playerId:'player-a',host:false,sessionToken:'secret-token-a',campaignId:'campaign-a',mapId:'map-a',target:'player-a'},calls=[];
 const env={location:{origin:'http://127.0.0.1:9999',hostname:'127.0.0.1'},localStorage:storage,AbortController,setTimeout,clearTimeout,
  get SundollRoom(){return state.roomId?{id:state.roomId,accountId:state.accountId}:undefined;},
  async fetch(url,options){calls.push({url,method:options.method||'GET'});let body;
   if(url==='/api/info')body={projectId:state.projectId,authentication:{method:state.accountId?'email_password':'name'}};
   else if(url==='/api/workspace-epoch')body={epoch:state.epoch};
   else if(url==='/api/account/session')body={account:{accountId:state.accountId}};
   else if(url==='/api/dm/session')body={authenticated:true};
   else if(url.startsWith('/api/session?'))body={session:{playerId:state.playerId,persistent:true}};
   else throw Error('unexpected path');
   return {ok:true,status:200,json:async()=>body};
  }};
 const context=()=>({host:state.host,playerId:state.host?state.target:state.playerId,sessionToken:state.sessionToken,campaignId:state.campaignId,mapId:state.mapId});
 const fresh=()=>create({channel,context,env});
 const command=(id='original-request-0001')=>({op:channel==='backpack'?'use':'take',requestId:id,playerId:state.target,campaignId:state.campaignId,
   ...(channel==='map-items'?{mapId:state.mapId,markerRevision:5,markerId:'marker-a',quantity:2}:{}),revision:4,itemId:'item-a',sessionToken:state.sessionToken});
 return {state,env,calls,storage,command,fresh,outbox:fresh()};
}
for(const channel of ['backpack','map-items'])test(`reload retains exact operation without any mutation request: ${channel}`,async()=>{
 const f=setup(channel),original=f.command(),saved=await f.outbox.prepare(original);
 const serialized=[...f.storage.data.values()].join('');assert.ok(!serialized.includes('secret-token'));assert.ok(!serialized.includes('sessionToken'));
 const reopened=f.fresh(),restored=await reopened.load();assert.deepEqual(restored.command,original);assert.equal(restored.ticket.requestId,saved.ticket.requestId);
 assert.deepEqual(await reopened.authorize(restored.ticket),original);assert.ok(f.calls.every(c=>c.method==='GET'));
 reopened.complete(restored.ticket);assert.equal(await f.fresh().load(),null);
});
test('renewed authentication of the same player uses current token and preserves signed fields',async()=>{
 const f=setup('map-items'),original=f.command();await f.outbox.prepare(original);f.state.sessionToken='new-secret-token';
 const replay=await f.fresh().load();assert.equal(replay.command.sessionToken,'new-secret-token');
 const {sessionToken:a,...first}=original,{sessionToken:b,...second}=replay.command;assert.deepEqual(second,first);
});
for(const field of ['projectId','epoch','roomId','accountId'])test(`old page refuses changed ${field}; fresh page cannot see old operation`,async()=>{
 const f=setup();if(field==='accountId'||field==='roomId'){f.state.accountId='account-a';f.state.roomId='room-a';}
 const saved=await f.outbox.prepare(f.command());f.state[field]='different-'+field;
 await assert.rejects(()=>f.outbox.authorize(saved.ticket));assert.equal(await f.fresh().load(),null);
 assert.equal(f.storage.length,1);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('switching player identity never exposes or authorizes the old request',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command());f.state.playerId=f.state.target='player-b';f.state.sessionToken='secret-token-b';
 assert.equal(await f.fresh().load(),null);await assert.rejects(()=>f.outbox.authorize(saved.ticket));assert.equal(f.storage.length,1);
});
test('host account switch is isolated even when the target backpack is unchanged',async()=>{
 const f=setup();f.state.host=true;f.state.accountId='account-a';f.state.roomId='room-a';const saved=await f.outbox.prepare(f.command());
 f.state.accountId='account-b';assert.equal(await f.fresh().load(),null);await assert.rejects(()=>f.outbox.authorize(saved.ticket));
});
test('host backpack targets are independent',async()=>{
 const f=setup();f.state.host=true;const saved=await f.outbox.prepare(f.command());f.state.target='player-b';
 assert.equal(await f.outbox.load(),null);await assert.rejects(()=>f.outbox.authorize(saved.ticket));f.state.target='player-a';assert.equal((await f.outbox.load()).command.requestId,saved.command.requestId);
});
for(const field of ['campaignId','mapId'])test(`map outbox is isolated by ${field}`,async()=>{
 const f=setup('map-items'),saved=await f.outbox.prepare(f.command());f.state[field]='different';
 assert.equal(await f.outbox.load(),null);await assert.rejects(()=>f.outbox.authorize(saved.ticket));
});
test('backpack old-campaign commands remain exact for explicit receipt recovery',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command());f.state.campaignId='campaign-b';
 const restored=await f.outbox.load();assert.equal(restored.command.campaignId,'campaign-a');assert.deepEqual(await f.outbox.authorize(saved.ticket),saved.command);
});
test('new write is refused while a previous operation is unresolved',async()=>{
 const f=setup();await f.outbox.prepare(f.command());await assert.rejects(()=>f.fresh().prepare(f.command('another-request-0002')),/先点击核对/);assert.equal(f.storage.length,1);
});
test('unavailable storage blocks preparation and never silently falls back to memory',async()=>{
 const f=setup();f.storage.setItem=()=>{throw Error('QuotaExceededError');};await assert.rejects(()=>f.outbox.prepare(f.command()),/本次操作未发送/);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('a failed persistence readback blocks preparation',async()=>{
 const f=setup();f.storage.setItem=function(k,v){this.data.set(k,v+'corrupt');};await assert.rejects(()=>f.outbox.prepare(f.command()),/本次操作未发送/);
});
test('corrupted pending records are explicit errors and are never overwritten',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command());f.storage.data.set(saved.ticket.key,'broken');await assert.rejects(()=>f.fresh().load(),/损坏/);await assert.rejects(()=>f.fresh().prepare(f.command('another-request-0002')));assert.equal(f.storage.getItem(saved.ticket.key),'broken');
});
test('tampered targets or changed command fields cannot be authorized or cleared by old ticket',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command()),row=JSON.parse(f.storage.getItem(saved.ticket.key));row.command.quantity=99;f.storage.setItem(saved.ticket.key,JSON.stringify(row));
 await assert.rejects(()=>f.outbox.authorize(saved.ticket),/已变化/);assert.throws(()=>f.outbox.complete(saved.ticket),/其他记录未删除/);assert.equal(JSON.parse(f.storage.getItem(saved.ticket.key)).command.quantity,99);
 row.command.playerId='other-player';f.storage.setItem(saved.ticket.key,JSON.stringify(row));await assert.rejects(()=>f.fresh().load(),/目标身份/);
});
test('blocked deletion uses a resolved tombstone and never restores it',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command());f.storage.removeItem=()=>{};f.outbox.complete(saved.ticket);assert.equal(await f.fresh().load(),null);assert.ok(JSON.parse(f.storage.getItem(saved.ticket.key)).resolved);
});
test('complete failure to clear is disclosed without claiming refresh recovery succeeded',async()=>{
 const f=setup(),saved=await f.outbox.prepare(f.command());f.storage.removeItem=()=>{throw Error('disabled');};f.storage.setItem=()=>{throw Error('disabled');};
 assert.throws(()=>f.outbox.complete(saved.ticket),/结果已确认.*未能清理/);assert.equal((await f.fresh().load()).command.requestId,saved.command.requestId);
});
test('storage with room-context namespacing is correctly enumerated and read',async()=>{
 const backing=new MemoryStorage(),prefix='room:room-a:account:account-a:';
 const storage={get length(){return backing.length;},key:i=>backing.key(i),getItem:k=>backing.getItem(prefix+k),setItem:(k,v)=>backing.setItem(prefix+k,v),removeItem:k=>backing.removeItem(prefix+k)};
 const f=setup('backpack',storage);f.state.accountId='account-a';f.state.roomId='room-a';const saved=await f.outbox.prepare(f.command());assert.equal((await f.fresh().load()).command.requestId,saved.command.requestId);
});
test('parallel tabs never overwrite another request record',async()=>{
 const f=setup();const results=await Promise.allSettled([f.outbox.prepare(f.command()),f.fresh().prepare(f.command('parallel-request-0002'))]);
 const successful=results.filter(r=>r.status==='fulfilled');assert.ok(successful.length>=1);assert.equal(f.storage.length,successful.length);
 for(const r of successful){assert.equal(JSON.parse(f.storage.getItem(r.value.ticket.key)).command.requestId,r.value.command.requestId);}
});
test('failed identity verification never writes an outbox or sends a mutation',async()=>{
 const f=setup();f.env.fetch=async()=>({ok:false,status:401,json:async()=>({error:'身份已失效'})});await assert.rejects(()=>f.outbox.prepare(f.command()));assert.equal(f.storage.length,0);
});
