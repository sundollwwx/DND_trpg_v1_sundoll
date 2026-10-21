const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=readClientSource('主控台/玩家.html');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert.ok(start>=0,name);let level=0;const body=source.indexOf('{',start);for(let i=body;i<source.length;i++){if(source[i]==='{')level++;if(source[i]==='}'&&--level===0)return source.slice(start,i+1);}throw Error(name);}
const tick=()=>new Promise(setImmediate);
test('module portraits select token-512 while legacy paths and original fallbacks stay intact',()=>{
 const c=vm.createContext({PLAYER_PORTRAIT_TIER:512});vm.runInContext(['projectAssetUrl','portraitLodUrl','assetUrl','originalPortraitUrl'].map(fn).join('\n'),c);
 const token={iconImgPath:'/api/module-assets/'+'a'.repeat(64)};
 assert.equal(c.assetUrl(token),token.iconImgPath+'?variant=token-512');assert.equal(c.originalPortraitUrl(token),token.iconImgPath);
 assert.equal(c.assetUrl({iconImgPath:'立绘/物件/训练器材/测试假人.png'}),'../asset/棋子库/显示缓存/512/物件/训练器材/测试假人.webp');
 assert.equal(c.assetUrl({iconImg:'data:image/png;base64,A'}),'data:image/png;base64,A');
});
function streamFixture(){
 const instances=[],timers=new Map(),renders=[],calls=[];let serial=0;
 class EventSource{constructor(url){this.url=url;instances.push(this);}close(){this.closed=true;}}
 const diagnostics=require(require('node:path').join(require('./project_paths.cjs').APP_ROOT,'主控台/shared/client-runtime.js')).createDiagnostics();
 const c=vm.createContext({playerSyncDiagnostics:diagnostics,EventSource,setTimeout:(fn)=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id),setConnection(){},sendPresence(){},sendPlayerWebRtcSignal:async()=>{},syncRoomState:()=>calls.push('state'),syncMusicState:()=>calls.push('music'),render:v=>renders.push(v),renderPlayers(){},applyAction(){},handleSessionRevoked(){},applyPlayerWebRtcSignal(){},applyBgm(){},state:{},presenceStatus:'online'});
 vm.runInContext('let streamES=null,streamAppliedSeq=0;'+fn('connectStream'),c);return{c,instances,timers,renders,calls,diagnostics};
}
test('SSE supplies the map snapshot while music syncs independently on connect and reconnect',()=>{
 const f=streamFixture();f.c.connectStream();const es=f.instances[0];es.onopen();assert.deepEqual(f.calls,['music']);
 es.onmessage({data:JSON.stringify({type:'state',state:{_stateRevision:1}})});assert.equal(f.renders.length,1);assert.equal(f.timers.size,0);
 es.onerror();es.onopen();for(const timer of f.timers.values())timer();assert.deepEqual(f.calls,['music','music','state','music']);
 f.c.connectStream();assert.equal(es.closed,true);es.onmessage({data:JSON.stringify({type:'state',state:{_stateRevision:2}})});assert.equal(f.renders.length,1);
});
function diceFixture(){
 const scripts=[],rolls=[],notices=[];const window={};
 const c=vm.createContext({window,AbortController,setTimeout,clearTimeout,document:{createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)}},localStorage:{getItem:()=> 'saved-skin'},toast:s=>notices.push(s)});
 vm.runInContext(fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT,'主控台/shared/client-runtime.js'),'utf8'),c);c.SundollClientRuntime=window.SundollClientRuntime;
 vm.runInContext('let playerDiceLoad=null;'+['loadPlayerScript','ensurePlayerDice','playPlayerDice','currentDiceSkin'].map(fn).join('\n'),c);
 return{c,window,scripts,rolls,notices};
}
test('first local and remote rolls wait for a single dice import and preserve results/order',async()=>{
 const f=diceFixture();assert.equal(f.c.currentDiceSkin(),'saved-skin');f.c.playPlayerDice(20,'first',19,{visibility:'private'});f.c.playPlayerDice(6,'second',4,{visibility:'public'});
 await tick();assert.equal(f.scripts.length,1);assert.equal(f.scripts[0].src,'vendor/three.min.js');f.window.THREE={};f.scripts[0].onload();await tick();assert.equal(f.scripts.length,2);
 f.window.SundollDiceSkins={get:()=> 'loaded'};f.window.playDieAnimation=(...args)=>f.rolls.push(args);f.scripts[1].onload();await tick();assert.deepEqual(f.rolls.map(a=>a[2]),[19,4]);assert.equal(f.c.currentDiceSkin(),'loaded');
 f.c.playPlayerDice(4,'ready',2,{});assert.equal(f.rolls.length,3);assert.equal(f.scripts.length,2);
});
test('failed first dice import exposes the result and allows a later retry',async()=>{
 const f=diceFixture();f.c.playPlayerDice(20,'private roll',17,{});await tick();f.scripts[0].onerror();await tick();assert.match(f.notices[0],/17/);f.c.playPlayerDice(20,'retry',3,{});await tick();assert.equal(f.scripts.length,2);f.scripts[1].onerror();await tick();
});
test('login HTML does not request dice bundles or status sprite and CSS has no large fallback image',()=>{
 const root=require('./project_paths.cjs').APP_ROOT,html=fs.readFileSync(path.join(root,'主控台/玩家.html'),'utf8'),css=fs.readFileSync(path.join(root,'主控台/player/player.css'),'utf8');
 assert.doesNotMatch(html,/<script[^>]+src="(?:vendor\/three\.min|shared\/dice)\.js/);assert.doesNotMatch(html,/rel="preload"[^>]+状态图标/);assert.doesNotMatch(css,/封面背景\.png/);
});
test('rest media modules make no startup downloads and retain scene/gesture APIs',()=>{
 const root=require('./project_paths.cjs').APP_ROOT,requested=[],events=[],timers=[];
 const window={addEventListener:name=>events.push(name),requestIdleCallback:fn=>timers.push(fn),setTimeout:fn=>timers.push(fn)};
 const c=vm.createContext({window,URL,Image:class{set src(value){requested.push(value);}},document:{currentScript:{src:'https://table.example/asset/界面/休息动画/休息场景.js'}},fetch:async url=>{requested.push(url);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(1)};}});
 for(const file of ['休息场景.js','休息音频.js'])vm.runInContext(fs.readFileSync(path.join(root,'asset/界面/休息动画',file),'utf8'),c);
 for(const timer of timers)timer();assert.equal(requested.length,0);assert.equal(typeof window.SundollRestAudio.play,'function');assert.ok(events.includes('pointerdown'));
 assert.equal(window.SundollRestScenes.get('short-indoor','short').id,'short-indoor');assert.equal(Object.keys(window.SundollRestScenes.SCENES).length,6);
});
test('reading invitations still reach the shared backpack handler over SSE',()=>{
 const f=streamFixture(),invites=[];f.c.PlayerBackpack={receiveReadingInvite:v=>invites.push(v)};f.c.connectStream();f.instances[0].onmessage({data:JSON.stringify({type:'readingInvite',invitationId:'reading-1'})});assert.equal(invites.length,1);assert.equal(invites[0].invitationId,'reading-1');
});
test('default room does not load dice; opening tools loads skins and failed loading can retry',async()=>{
 const f=diceFixture(),tabs=['room','tools','units'].map(name=>({dataset:{playerWorkspaceTab:name},active:name==='room',classList:{toggle(){}},setAttribute(){},addEventListener(event,handler){this[event]=handler;}}));
 f.c.document.querySelectorAll=selector=>selector==='[data-player-workspace-tab]'?tabs:[];
 f.c.document.querySelector=()=>tabs[0];f.c.leavePlayerDoodleMode=()=>{};
 vm.runInContext(fn('activatePlayerWorkspace')+'\n'+fn('initPlayerWorkspaceTabs'),f.c);
 f.c.initPlayerWorkspaceTabs();assert.equal(f.scripts.length,0);tabs[2].click();assert.equal(f.scripts.length,0);
 tabs[1].click();await tick();assert.equal(f.scripts.length,1);assert.equal(f.scripts[0].src,'vendor/three.min.js');
 f.scripts[0].onerror();await tick();assert.match(f.notices[0],/重新打开工具页可重试/);tabs[0].click();tabs[1].click();await tick();assert.equal(f.scripts.length,2);f.scripts[1].onerror();await tick();
});
test('music reconciles without SSE messages, bounds requests, and ignores departed sessions',async()=>{
 const calls=[],applied=[],timers=new Map();let resolveFetch,serial=0;
 const c=vm.createContext({AbortController,performance:{now:()=>1},setTimeout:f=>{timers.set(++serial,f);return serial;},clearTimeout:id=>timers.delete(id),fetch:(url,options)=>{calls.push({url,options});return new Promise(resolve=>resolveFetch=resolve);},applyBgm:v=>applied.push(v)});
 vm.runInContext('let sessionToken="player",streamES={},musicSyncPending=false,flowClockAnchor={};'+fn('syncMusicState')+fn('pollMusicState'),c);
 c.pollMusicState();c.pollMusicState();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/music-state');assert.equal(calls[0].options.cache,'no-store');
 resolveFetch({ok:true,json:async()=>({bgm:{action:'play'},serverNow:12})});await tick();assert.equal(applied[0].action,'play');assert.equal(timers.size,0);
 c.pollMusicState();assert.equal(calls.length,2);vm.runInContext('sessionToken="";streamES=null;',c);resolveFetch({ok:true,json:async()=>({bgm:{action:'pause'}})});await tick();c.pollMusicState();assert.equal(applied.length,1);assert.equal(calls.length,2);
 vm.runInContext('sessionToken="new";streamES={};',c);c.pollMusicState();for(const timer of timers.values())timer();assert.equal(calls[2].options.signal.aborted,true);
 resolveFetch({ok:false,json:async()=>({})});await tick();c.pollMusicState();assert.equal(calls.length,4);
 assert.match(source,/setInterval\(pollMusicState,3000\)/);
});

test('SSE processing errors are visible as bounded private metadata and later state processing continues',()=>{
 const f=streamFixture();f.c.connectStream();const es=f.instances[0];
 es.onmessage({data:'secret invalid json'});assert.equal(f.diagnostics.snapshot()[0].error,'SyntaxError');
 f.c.applyAction=()=>{throw new TypeError('secret-token secret-player /private/path');};
 es.onmessage({data:JSON.stringify({type:'action',action:{op:'roll',name:'secret-player'},seq:1})});
 const entries=f.diagnostics.snapshot();assert.equal(entries[1].type,'action');assert.ok(!JSON.stringify(entries).includes('secret'));
 es.onmessage({data:JSON.stringify({type:'state',state:{_stateRevision:3}})});assert.equal(f.renders.length,1);
});
