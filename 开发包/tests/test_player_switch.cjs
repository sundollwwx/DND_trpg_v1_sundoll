const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const source=readClientSource('主控台/player/player.js');
const section=source.slice(source.indexOf('  function createPlayerSessionMemory'),source.indexOf('  async function releaseOwnedPiece'));
const streamSource=source.slice(source.indexOf('  function connectStream(){'),source.indexOf('  window.journalBridge='));
const joinSubmitSource=source.slice(source.indexOf("  $('#join-form').addEventListener('submit'"),source.indexOf("  $('#join-refresh').addEventListener"));
function storage(){const data=new Map();return{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
function setup(saved=storage()){
 const nodes=new Map(),calls=[],navigation=[],messages=[],streams=[],renders=[];let rejectToken=false,offlineRelease,offlineGate=null,networkFailure=false,validationGate=null,releaseValidation,accountFailure=0;
 const get=s=>{if(!nodes.has(s))nodes.set(s,{value:'',textContent:'',hidden:true,dataset:{},classList:{toggle(name,value){this[name]=value;}},setAttribute(){},getAttribute(){return ''},removeAttribute(){},closest(){return this;},addEventListener(name,handler){this[name]=handler;}});return nodes.get(s);};
 class EventSource{constructor(url){this.url=url;streams.push(this);}close(){this.closed=true;}}
 const c={window:{sessionStorage:saved},document:{querySelector:get},$:get,localStorage:storage(),AbortSignal,AbortController,Promise,setTimeout,clearTimeout,SundollClientRuntime:require(require('node:path').join(require('./project_paths.cjs').APP_ROOT,'主控台/shared/client-runtime.js')),
  PlayerBackpack:{contextChanged(){}},closePlayerLiveAudio(){},setConnection(){},closeDetail(){},updateSessionUi(){},renderTokens(){},openDetail(){},toast:message=>messages.push(message),dispatchPendingPatch:async()=>true,
  EventSource,render:snapshot=>renders.push(snapshot),renderPlayers(){},applyAction(){},applyPlayerWebRtcSignal(){},applyBgm(){},syncMusicState(){},sendPlayerWebRtcSignal:async()=>{},syncRoomState:async()=>false,playerSyncDiagnostics:{report(){}},
  fetch:async(url,args)=>{const body=args?.body?JSON.parse(args.body):{};calls.push({url,body});
   if(networkFailure&&url==='/api/session')throw new Error('offline');
   if(url==='/api/presence'&&body.status==='offline'&&offlineGate)await offlineGate;
   if(url==='/api/session'&&rejectToken&&body.sessionToken)return{ok:false,status:401,json:async()=>{if(validationGate)await validationGate;return{error:'会话已失效，请使用玩家凭证重新加入'};}};
   if(url==='/api/account/player-session')return{ok:!accountFailure,status:accountFailure||200,json:async()=>accountFailure?{ok:false,error:'当前账号尚未连接档案'}:{ok:true,roomCode:'CURRENT',session:{persistent:true,sessionToken:'current-email-session',name:'当前邮箱玩家',playerId:'current-email-player'}}};
   const token=body.sessionToken||(body.nickname==='甲'?'token-a':'token-b');
   return{ok:true,status:200,json:async()=>{if(url==='/api/session'&&body.sessionToken&&validationGate)await validationGate;return(url==='/api/session'||url==='/api/register')?{ok:true,roomCode:'ROOM',session:{persistent:true,sessionToken:token,name:body.nickname||'甲',playerId:token==='token-a'?'id-a':'id-b'}}:{ok:true,protocolVersion:29,...(c.window.SundollRoom?{authentication:{method:'email_password'}}:{})};}};
  },REQUIRED_SERVER_PROTOCOL:29,requestAnimationFrame(){},URL,URLSearchParams,location:{href:'http://localhost:8090/主控台/玩家.html',search:'',assign:url=>navigation.push(url)},performance:{now:()=>0}};
 vm.createContext(c);vm.runInContext("let sessionToken='token-a',myName='甲',myPlayerId='id-a',roomCode='ROOM',presenceStatus='online',patchTimer=null,pendingPatch=null,streamES=null,streamAppliedSeq=0,state=null,currentMap=null,selectedId=null;"+section+streamSource+joinSubmitSource+";this.api={bootstrapSession,setJoinMode,joinSession,leaveSession,validateStoredSession,handleSessionRevoked,sessionMemory,identity:()=>({sessionToken,myName,myPlayerId}),reset:()=>{sessionToken='';myPlayerId='';}}",c);
 return{api:c.api,calls,get,saved,navigation,messages,streams,renders,submit:()=>get('#join-form').submit({preventDefault(){}}),roomAccount(id='r-test'){c.window.SundollRoom={id};},rejectAccount(status){accountFailure=status;},emailMode(){vm.runInContext('emailAccountMode=true',c);},blockPatch(){let release;c.dispatchPendingPatch=()=>new Promise(r=>release=r);return result=>release(result);},blockOffline(){offlineGate=new Promise(r=>offlineRelease=r);},releaseOffline(){offlineRelease();},reject(){rejectToken=true;},networkFail(){networkFailure=true;},blockValidation(){validationGate=new Promise(r=>releaseValidation=r);},releaseValidation(){releaseValidation();},fakeDeadlines(){const timers=new Map();let id=0;c.setTimeout=fn=>{timers.set(++id,fn);return id;};c.clearTimeout=id=>timers.delete(id);return timers;}};
}
test('switch then return resumes the same player even before old server online-name timeout',async()=>{
 const f=setup();await f.api.leaveSession();assert.equal(f.api.identity().sessionToken,'');
 await f.api.joinSession('甲','ROOM',false);assert.equal(f.api.identity().myPlayerId,'id-a');
 assert.equal(f.calls.find(c=>c.url==='/api/session').body.sessionToken,undefined);
 assert.equal(f.calls.find(c=>c.url==='/api/session').body.authMethod,'name');
});
test('A to B to A preserves identity and switch choices survive tab refresh',async()=>{
 const f=setup();await f.api.leaveSession();await f.api.joinSession('乙','ROOM',false);
 assert.equal(f.calls.find(c=>c.url==='/api/session').body.sessionToken,undefined);
 await f.api.leaveSession();const refreshed=setup(f.saved);refreshed.api.reset();
 await refreshed.api.joinSession('甲','ROOM',false);assert.equal(refreshed.api.identity().myPlayerId,'id-a');
});
test('join waits for pending offline notification so it cannot undo resumed presence',async()=>{
 const f=setup();f.blockOffline();await f.api.leaveSession();const joining=f.api.joinSession('甲','ROOM',false);
 await Promise.resolve();assert.equal(f.calls.filter(c=>c.url==='/api/session').length,0);
 f.releaseOffline();await joining;assert.equal(f.calls.at(-1).body.status,'online');
});
test('manual name login does not reuse a revoked remembered session',async()=>{
 const f=setup();await f.api.leaveSession();f.reject();await f.api.joinSession('甲','ROOM',false);
 assert.equal(f.calls.find(c=>c.url==='/api/session').body.sessionToken,undefined);
 assert.equal(f.api.identity().myPlayerId,'id-a');
});
test('changing name on resume never renames the current identity',async()=>{
 const f=setup();await f.api.joinSession('乙','ROOM',true);
 assert.equal(f.calls.find(c=>c.url==='/api/session').body.sessionToken,undefined);
 assert.ok(f.calls.some(c=>c.url==='/api/presence'&&c.body.sessionToken==='token-a'&&c.body.status==='offline'));
});
test('transient validation failure keeps the recovery credential',async()=>{
 const f=setup();f.networkFail();await f.api.validateStoredSession();assert.equal(f.api.identity().sessionToken,'token-a');
});
test('remembered sessions are room scoped and kick removes the active recovery entry',async()=>{
 const f=setup();f.api.sessionMemory.remember({name:'甲',room:'room',token:'token-a'});
 assert.equal(f.api.sessionMemory.find('甲','OTHER'),'');f.api.handleSessionRevoked({playerId:'id-a'});
 assert.equal(f.api.sessionMemory.find('甲','ROOM'),'');assert.equal(f.api.identity().sessionToken,'');
});
test('registration uses its own endpoint without borrowing a remembered identity',async()=>{
 const f=setup();f.api.setJoinMode(true);
 await f.api.joinSession('新玩家','ROOM',true);
 const request=f.calls.find(c=>c.url==='/api/register');assert.ok(request);
 assert.equal(request.body.sessionToken,undefined);assert.equal(request.body.credential,undefined);assert.equal(request.body.authMethod,'name');
 assert.equal(f.api.identity().myName,'新玩家');
});
test('invalid registration remains local and preserves current identity',async()=>{
 const f=setup();f.api.setJoinMode(true);
 await assert.rejects(f.api.joinSession('','ROOM'),/请填写玩家名/);
 assert.equal(f.calls.length,0);assert.equal(f.api.identity().sessionToken,'token-a');
});

const tick=()=>new Promise(setImmediate);
test('stalled stored-session JSON times out without locking the name login form',async()=>{
 const f=setup(),timers=f.fakeDeadlines();f.blockValidation();const bootstrap=f.api.bootstrapSession();await tick();
 assert.notEqual(f.get('.join-shell').classList['is-busy'],true);assert.equal(f.get('#join-error').textContent,'');
 for(const expire of [...timers.values()])expire();await bootstrap;assert.equal(timers.size,0);assert.equal(f.api.identity().sessionToken,'token-a');
 assert.match(f.get('#join-session-hint').textContent,/输入玩家名字登录/);f.releaseValidation();await tick();
});
test('late revoked-session validation cannot clear a newly joined identity',async()=>{
 const f=setup();f.reject();f.blockValidation();const validation=f.api.validateStoredSession();await tick();
 await f.api.joinSession('乙','ROOM',false);assert.equal(f.api.identity().sessionToken,'token-b');f.releaseValidation();await validation;
 assert.equal(f.api.identity().sessionToken,'token-b');assert.equal(f.api.identity().myPlayerId,'id-b');
});

test('email player returns only after pending character changes and presence finish',async()=>{
 const f=setup();f.emailMode();const release=f.blockPatch();f.blockOffline();const leaving=f.api.leaveSession();
 await tick();assert.equal(f.calls.length,0);assert.deepEqual(f.navigation,[]);
 release(true);await tick();assert.equal(f.calls[0].body.status,'offline');assert.deepEqual(f.navigation,[]);
 f.releaseOffline();await leaving;assert.deepEqual(f.navigation,['/account#dashboard']);
});
test('failed character save keeps the email player on the current campaign',async()=>{
 const f=setup();f.emailMode();const release=f.blockPatch();const leaving=f.api.leaveSession();release(false);await leaving;
 assert.deepEqual(f.navigation,[]);assert.equal(f.calls.length,0);assert.equal(f.api.identity().myPlayerId,'id-a');
 assert.match(f.messages[0],/先保存角色修改/);
});

function receiveFirstRoomState(f){
 const snapshot={campaignId:'current-room',_sessionId:'current-server',_stateRevision:1,maps:[{id:'first-map',tokens:[]}]};
 const stream=f.streams[0];assert.equal(stream.url,'/api/events');stream.onopen();
 stream.onmessage({data:JSON.stringify({type:'state',state:snapshot})});
 assert.deepEqual(JSON.parse(JSON.stringify(f.renders[0])),snapshot);
}

test('a new email room entrant obtains a current-cookie session and receives the first real SSE state handler',async()=>{
 const f=setup();f.api.reset();f.roomAccount();await f.api.bootstrapSession();
 assert.equal(f.calls.filter(call=>call.url==='/api/account/player-session').length,1);
 assert.deepEqual(f.calls.find(call=>call.url==='/api/account/player-session').body,{});
 assert.equal(f.calls.some(call=>call.url==='/api/session'),false);
 assert.equal(f.api.identity().myPlayerId,'current-email-player');assert.equal(f.get('#join-mask').hidden,true);
 assert.equal(f.streams.length,1);receiveFirstRoomState(f);
});

test('a cached room token cannot replace current email authorization or require a second manual entry',async()=>{
 const f=setup();f.roomAccount();await f.api.bootstrapSession();
 assert.equal(f.calls.some(call=>call.url==='/api/session'),false);
 assert.deepEqual(f.calls.find(call=>call.url==='/api/account/player-session').body,{});
 assert.equal(f.api.identity().sessionToken,'current-email-session');assert.equal(f.api.identity().myPlayerId,'current-email-player');
 assert.equal(f.get('#join-mask').hidden,true);assert.equal(f.streams.length,1);receiveFirstRoomState(f);
});

test('failed current email authorization never hides the admission panel or connects a stream',async()=>{
 for(const status of [401,409]){
  const f=setup();f.roomAccount();f.rejectAccount(status);await f.api.bootstrapSession();
  assert.equal(f.streams.length,0);assert.equal(f.renders.length,0);assert.equal(f.get('#join-mask').hidden,false);
  assert.deepEqual(f.navigation,['/account#dashboard']);
 }
});

test('the real manual submit handler starts exactly one stream after a successful join',async()=>{
 const f=setup();f.get('#join-name').value='甲';await f.submit();
 assert.equal(f.streams.length,1);receiveFirstRoomState(f);
});

test('expired email room admission resumes the player destination after account login',async()=>{
 const id='r'+'a'.repeat(32),target='/rooms/'+id+'/主控台/玩家.html';
 for(const status of [401,409]){
  const f=setup();f.api.reset();f.roomAccount(id);f.rejectAccount(status);await f.api.bootstrapSession();
  assert.deepEqual(f.navigation,['/account#continue='+encodeURIComponent(target)]);
  assert.equal(f.streams.length,0);assert.equal(f.api.identity().myPlayerId,'');
 }
 const f=setup();f.roomAccount(id);f.emailMode();f.api.setJoinMode(true);
 assert.deepEqual(f.navigation,['/account#register&continue='+encodeURIComponent(target)]);
});


test('local player switching waits for character save and preserves identity on failure',async()=>{
 const f=setup();const release=f.blockPatch();const leaving=f.api.leaveSession();
 await tick();assert.equal(f.api.identity().myPlayerId,'id-a');assert.equal(f.get('#btn-join').disabled,true);
 release(false);await leaving;
 assert.equal(f.api.identity().myPlayerId,'id-a');assert.equal(f.calls.length,0);assert.equal(f.get('#btn-join').disabled,false);assert.match(f.messages.at(-1),/先保存角色修改/);
});
test('repeated leave clicks cannot start duplicate save or offline transitions',async()=>{
 const f=setup();const release=f.blockPatch();const leaving=f.api.leaveSession();await f.api.leaveSession();
 release(true);await leaving;assert.equal(f.calls.filter(c=>c.url==='/api/presence'&&c.body.status==='offline').length,1);
 assert.equal(f.api.identity().sessionToken,'');
});
test('the homepage control opens the dashboard without continuing back into the room',()=>{
 const f=setup();f.roomAccount('r'+'a'.repeat(32));f.emailMode();f.api.setJoinMode(false);
 assert.deepEqual(f.navigation,['/account#dashboard']);
});
