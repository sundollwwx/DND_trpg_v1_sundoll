const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {APP_ROOT}=require('./project_paths.cjs'),{readClientSource}=require('./client_sources.cjs');
const source=readClientSource('主控台/host/app.js');
const code=source.slice(source.indexOf('function hostStreamRequiresRoom()'),source.indexOf('async function refreshStreamPlayers()'))+'\n'+source.slice(source.indexOf('async function copyStreamUrl()'),source.indexOf('/* ==================== 棋子库 ==================== */'));
function fixture({enabled=true,roomsEnabled=true,room=null,configValid=true}={}){
  const calls=[],nodes=new Map(),config={ok:configValid,enabled,roomsEnabled};
  const node=()=>({disabled:false,hidden:true,textContent:'',title:'',innerHTML:'',dataset:{},classList:{toggle(){},remove(){}},appendChild(value){this.child=value;}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const context={window:{SundollRoom:room},location:{protocol:'https:'},hostStreamAccountConfig:null,hostStreamAccountRead:null,
    streamOn:false,streamInfo:null,streamPlayers:[],streamConnectionState:'off',hostPlayerKickPending:new Set(),hostStateConflict:null,renderHostSaveScope(){},
    $,document:{createElement:node},toast:text=>calls.push(['toast',text]),hostMusic:{updateBgmStatus(){},stopLiveAudioBroadcast:async()=>{}},
    SundollClientRuntime:{requestJson:async(url,options,settings)=>{calls.push([url==='/api/info'?'info':'config',url,settings.timeoutMs]);return{response:{ok:true},data:url==='/api/info'?{ips:[],publicBase:'',sessionId:'qa-session',stateRevision:0}:config};}},
    localStorage:{getItem:()=> '1',setItem(){calls.push(['storage']);},removeItem(){calls.push(['remove-storage']);}},
    navigator:{clipboard:{writeText:async url=>calls.push(['clipboard',url])}},playerViewerUrl:()=>'/player',
    serverApiBase:()=>'',fetch:async()=>{calls.push(['info']);return{ok:true,json:async()=>({ips:[],publicBase:''})};},
    normalizeServerBase:value=>value,queryPublicBase:()=>'',AbortController,setTimeout:()=>1,clearTimeout(){},
    setInterval:()=>1,clearInterval(id){calls.push(['clear-interval',id]);},streamTimer:null,streamPlayersTimer:null,streamES:null,
    startStreamClient:()=>calls.push(['events']),streamPush:()=>calls.push(['push']),streamTick(){},scheduleStreamMapPreloads(){},cancelStreamMapPreloads(){},
    mergePlayerStateFromServer:async()=>{},refreshStreamPlayers:async()=>{},
  };
  vm.createContext(context);vm.runInContext(code,context);return{context,calls,$};
}
test('email rooms in the original workspace disable invalid controls and expose the migration entry',async()=>{
  const f=fixture();await f.context.loadHostStreamAccountConfig();f.context.renderHostRoom();
  assert.equal(f.$('#btn-host-room-toggle').disabled,true);assert.equal(f.$('#btn-host-room-copy').disabled,true);
  assert.equal(f.$('#host-room-migration').hidden,false);assert.match(f.$('#host-player-list').child.textContent,/导入战役进度与各玩家包/);
  const html=fs.readFileSync(path.join(APP_ROOT,'主控台/主控台.html'),'utf8');assert.match(html,/<a id="host-room-migration"[^>]*href="\/account"/);
});
test('invalid original-workspace actions cannot publish, copy or auto-restore a misleading legacy link',async()=>{
  const f=fixture();await f.context.toggleStream();f.context.streamInfo={};f.context.streamOn=true;await f.context.copyStreamUrl();
  f.context.streamOn=false;await f.context.restoreStreamFromStorage();assert.equal(f.context.streamOn,false);
  assert.equal(f.calls.some(call=>['clipboard','push','events','storage','info'].includes(call[0])),false);
  assert.ok(f.calls.some(call=>call[0]==='toast'&&/战役空间/.test(call[1])));
});
for(const config of [{enabled:false,roomsEnabled:true},{enabled:true,roomsEnabled:false}])test(`legacy stream remains available for config ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);await f.context.toggleStream();assert.equal(f.context.streamOn,true);assert.ok(f.calls.some(call=>call[0]==='push'));
  await f.context.copyStreamUrl();assert.ok(f.calls.some(call=>call[0]==='clipboard'));assert.equal(f.$('#host-room-migration').hidden,true);
});
test('a real room preserves its existing stream without querying global account configuration',async()=>{
  const f=fixture({room:{id:'r1',prefix:'/rooms/r1'}});await f.context.toggleStream();await f.context.copyStreamUrl();
  assert.equal(f.context.streamOn,true);assert.equal(f.calls.some(call=>call[0]==='config'),false);assert.ok(f.calls.some(call=>call[0]==='clipboard'));
});
test('unconfirmed account mode prevents a write and can be retried without guessing old mode',async()=>{
  const f=fixture({configValid:false});await f.context.toggleStream();assert.equal(f.context.streamOn,false);assert.equal(f.calls.some(call=>call[0]==='push'),false);
  f.context.SundollClientRuntime.requestJson=async()=>({response:{ok:true},data:{ok:true,enabled:false,roomsEnabled:false,sessionId:'qa-session',stateRevision:0}});
  await f.context.toggleStream();assert.equal(f.context.streamOn,true);
});
test('LAN origins denied account configuration may retain explicitly confirmed legacy authentication',async()=>{
  const f=fixture();f.context.SundollClientRuntime.requestJson=async url=>url==='/api/account/config'?{response:{ok:false},data:{}}:{response:{ok:true},data:{authentication:{method:'name'},sessionId:'qa-session',stateRevision:0}};
  await f.context.toggleStream();assert.equal(f.context.streamOn,true);assert.ok(f.calls.some(call=>call[0]==='push'));
});

test('manual connection bounds the complete JSON read and preserves a specific server error',async()=>{
 const f=fixture({room:{id:'r1'}});let received;
 f.context.SundollClientRuntime.requestJson=async(url,options,settings)=>{received=settings;return{response:{ok:false},data:{error:'请重新登录'}};};
 await f.context.toggleStream();assert.equal(received.timeoutMs,8000);assert.equal(f.context.streamOn,false);
 assert.ok(f.calls.some(c=>c[0]==='toast'&&c[1]==='请重新登录'));
 assert.equal(f.calls.some(c=>c[0]==='push'),false);
 assert.equal(f.calls.some(c=>String(c[1]).includes('服务器未启动')),false);
});

test('a partial connection failure closes the stream and timers instead of keeping a false restore flag',async()=>{
 const f=fixture({room:{id:'r1'}});
 f.context.startStreamClient=()=>{f.context.streamES={close(){f.calls.push(['closed']);}};throw new Error('Stream failed');};
 await f.context.toggleStream();assert.equal(f.context.streamOn,false);assert.equal(f.context.streamES,null);
 assert.ok(f.calls.some(c=>c[0]==='closed'));assert.ok(f.calls.some(c=>c[0]==='remove-storage'));
 assert.ok(f.calls.filter(c=>c[0]==='clear-interval'&&c[1]===1).length>=2);
 assert.equal(f.calls.some(c=>c[0]==='push'),false);
});
test('LAN fallback cannot treat an email or unknown mode as legacy access',async()=>{
  for(const method of ['email_password','future_auth',undefined]){
    const f=fixture();f.context.SundollClientRuntime.requestJson=async url=>url==='/api/account/config'?{response:{ok:false},data:{}}:{response:{ok:true},data:{authentication:{method}}};
    await f.context.toggleStream();assert.equal(f.context.streamOn,false);assert.equal(f.calls.some(call=>call[0]==='push'),false);
  }
});
