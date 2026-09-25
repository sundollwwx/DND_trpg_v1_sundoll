// BEGIN BUNDLED MUSIC MODULE
/* Player audio is a receiver: room commands select playback, local controls set volume only. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.SundollPlayerMusic={create:factory};
})(typeof globalThis!=='undefined'?globalThis:this,function createPlayerMusic(options){
  'use strict';
  const {$,session,playerId,serverNow}=options,env=options.env||globalThis;
  const file=new env.Audio(),live=new env.Audio();
  const rtcConfig={iceServers:[{urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']}]};
  let command={action:'stop',mode:'library'},key='',lastIssued=0,revision=0,peer=null,ice=[],muted=false,blocked=false,error='';
  const current=()=>command.mode==='live'?live:file;
  function ui(){
    $('#player-audio-title').textContent=command.track||(command.mode==='live'?'外部音源':'尚未播放');
    let status=command.action==='stop'?'等待主控台':command.action==='pause'?'主控台已暂停':command.mode==='live'&&!live.srcObject?'正在连接外部音源…':current().paused?'正在加载声音…':'正在播放 · 与主控台同步';
    $('#player-audio-status').textContent=error||(blocked?'点击“启用声音”开始收听':status);
    $('#player-audio-enable').hidden=command.action!=='play'||(!blocked&&!error&&!current().paused);
    $('#player-audio-mute').textContent=muted||Number($('#player-audio-volume').value)===0?'🔇':'🔊';
  }
  async function play(){
    const audio=current(),requested=revision;
    if(command.action!=='play'||(audio===live&&!live.srcObject)|| (audio===file&&!file.src)){ui();return;}
    try{await audio.play();if(requested!==revision)return;blocked=false;error='';}
    catch(e){if(requested!==revision)return;blocked=e.name==='NotAllowedError';error=blocked?'':'音乐加载失败，可点击“启用声音”重试';}
    ui();
  }
  function closeLive(){
    ice=[];
    const old=peer;peer=null;
    if(old){old.ontrack=null;old.onicecandidate=null;old.onconnectionstatechange=null;old.close();}
    live.pause();live.srcObject=null;
  }
  function reset(){
    ++revision;key='';lastIssued=0;command={action:'stop',mode:'library'};error='';blocked=false;
    file.onloadedmetadata=null;file.pause();file.removeAttribute('src');file.load();closeLive();ui();
  }
  function align(){
    if(!file.src||file.readyState<1)return;
    const elapsed=command.action==='play'&&Number(command.issuedAt)?Math.max(0,(serverNow()-Number(command.issuedAt))/1000):0;
    let expected=Math.max(0,(Number(command.time)||0)+elapsed);
    if(Number.isFinite(file.duration)&&file.duration>0)expected=command.loop?expected%file.duration:Math.min(expected,file.duration);
    if(Math.abs((file.currentTime||0)-expected)>.55)try{file.currentTime=expected;}catch(_){}
  }
  async function apply(next){
    if(!next||!['play','pause','stop'].includes(next.action))return;
    const issued=Number(next.issuedAt)||0;if(issued&&issued<lastIssued)return;
    const nextKey=JSON.stringify([next.action,next.mode,next.url,next.track,next.time,next.loop,issued]);
    if(nextKey===key){if(command.mode!=='live')align();ui();return;}
    key=nextKey;lastIssued=Math.max(lastIssued,issued);++revision;error='';
    command={...next,mode:next.mode||'library'};
    if(command.mode==='live'){
      file.onloadedmetadata=null;file.pause();
      if(command.action==='stop')closeLive();
      else if(command.action==='pause')live.pause();
      else await play();
    }else{
      closeLive();file.loop=!!command.loop;
      if(command.url&&file.getAttribute('src')!==command.url)file.src=command.url;
      // One handler reads the latest command; stale metadata cannot seek a newer song.
      file.onloadedmetadata=()=>{align();ui();};align();
      if(command.action==='play')await play();
      else{file.pause();if(command.action==='stop'){file.onloadedmetadata=null;try{file.currentTime=0;}catch(_){}}}
    }
    ui();
  }
  function send(signal){
    const token=session();if(!token)return Promise.resolve({ok:false});
    return env.fetch('/api/webrtc-signal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:token,signal})}).then(async r=>({ok:r.ok,data:await r.json().catch(()=>({}))}));
  }
  function createPeer(){
    closeLive();const pc=new env.RTCPeerConnection(rtcConfig);peer=pc;
    pc.onicecandidate=event=>{if(pc!==peer||!event.candidate)return;const candidate=event.candidate.toJSON?event.candidate.toJSON():event.candidate;send({type:'ice',...candidate}).catch(()=>{});};
    pc.ontrack=event=>{if(pc!==peer)return;live.srcObject=event.streams?.[0]||new env.MediaStream([event.track]);if(command.mode==='live')play();};
    pc.onconnectionstatechange=()=>{if(pc!==peer)return;if(pc.connectionState==='failed'){closeLive();error='直播连接失败，等待重新同步';}ui();};
    return pc;
  }
  async function signal(event){
    if(!session()||!event||event.target!==playerId()||!event.signal)return;
    const msg=event.signal,token=session();
    try{
      if(msg.type==='offer'){
        const queued=ice.splice(0),pc=createPeer();ice.push(...queued);
        await pc.setRemoteDescription({type:'offer',sdp:msg.sdp});if(peer!==pc||session()!==token)return;
        for(const candidate of ice.splice(0))await pc.addIceCandidate(candidate);
        const answer=await pc.createAnswer();if(peer!==pc||session()!==token)return;
        await pc.setLocalDescription(answer);if(peer!==pc||session()!==token)return;
        await send({type:'answer',sdp:pc.localDescription.sdp});
      }else if(msg.type==='ice'){
        const candidate={candidate:msg.candidate,sdpMid:msg.sdpMid??null,sdpMLineIndex:msg.sdpMLineIndex??null};
        if(peer?.remoteDescription)await peer.addIceCandidate(candidate);else ice.push(candidate);
      }else if(msg.type==='stop'){closeLive();ui();}
    }catch(_){error='直播连接失败，等待主控台重新同步';ui();}
  }
  function volume(value){
    const v=Math.max(0,Math.min(1,(Number(value)||0)/100));file.volume=v;live.volume=v;
    try{env.localStorage.setItem('sangduoer-player-audio-volume',String(v));}catch(_){}ui();
  }
  let saved=.7;try{const value=parseFloat(env.localStorage.getItem('sangduoer-player-audio-volume'));if(Number.isFinite(value))saved=Math.max(0,Math.min(1,value));}catch(_){}
  $('#player-audio-volume').value=Math.round(saved*100);file.volume=saved;live.volume=saved;
  $('#player-audio-volume').addEventListener('input',e=>volume(e.target.value));
  $('#player-audio-mute').addEventListener('click',()=>{muted=!muted;file.muted=muted;live.muted=muted;ui();});
  $('#player-audio-enable').addEventListener('click',()=>{muted=false;file.muted=false;live.muted=false;play();});
  file.addEventListener('error',()=>{if(command.mode!=='live'&&command.action==='play'){error='音乐加载失败，可点击“启用声音”重试';ui();}});
  file.addEventListener('ended',ui);live.addEventListener('playing',ui);file.addEventListener('playing',ui);
  ui();
  return Object.freeze({apply,signal,send,reset,backgrounds:()=>[file,live],muted:()=>muted});
});

// END BUNDLED MUSIC MODULE

'use strict';
  const $ = (s) => document.querySelector(s);
  const TYPE = { pc:{label:'玩家角色',ring:'#5b8cff'}, enemy:{label:'敌人',ring:'#ef476f'}, npc:{label:'中立NPC',ring:'#f4a261'}, ally:{label:'友好NPC',ring:'#2ecc71'} };
  const clamp = (n,a,b) => Math.min(b,Math.max(a,n));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const world = $('#world'), board = $('#board'), doodle = $('#doodle-canvas'), doodleCtx = doodle.getContext('2d'), spellRangeCanvas = $('#spell-range-canvas'), spellRangeCtx = spellRangeCanvas.getContext('2d'), turnPath = $('#turn-path-canvas'), turnPathCtx = turnPath.getContext('2d');
  const WORLD_MINUTES_PER_DAY = 24 * 60, WORLD_DAYS_PER_WEEK = 7, WORLD_WEEKS_PER_YEAR = 52;
  const WORLD_MINUTES_PER_YEAR = WORLD_MINUTES_PER_DAY * WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR;
  const MAX_MOVE_POINTS = 60, MAX_TURN_PATH_POINTS = 200, TURN_DIAGONAL_MIN_STEP = .55, TURN_DIAGONAL_MAX_STEP = 1.45, TURN_DIAGONAL_INTENT_RATIO = .35, MAX_DOODLE_POINTS = 800, SPELL_RANGE_MIN_FEET = 5, SPELL_RANGE_MAX_FEET = 180, SPELL_CONE_HALF_ANGLE = Math.atan(.5);
  const MAP_REACTION_EMOJIS = new Set(['👍','❤️','😂','😮','🔥','✨','❓','⚔️','🎯','👏']);
  const CONDITION_PIXEL_KEYS = new Set(['prone','unconscious','incapacitated','blinded','deafened','frightened','charmed','poisoned','grappled','restrained','stunned','petrified','invisible','concentrating','burning']);
  const CONDITION_META = {
    prone:{label:'倒地',icon:'🛌',color:'#f4a261'},unconscious:{label:'昏迷',icon:'💤',color:'#9b8cff'},incapacitated:{label:'失能',icon:'🚫',color:'#b9c0cc'},blinded:{label:'目盲',icon:'🙈',color:'#c6a97d'},deafened:{label:'耳聋',icon:'🙉',color:'#c6a97d'},frightened:{label:'恐慌',icon:'😨',color:'#d879ff'},charmed:{label:'魅惑',icon:'💗',color:'#ff8fb3'},poisoned:{label:'中毒',icon:'☠️',color:'#79c267'},grappled:{label:'擒抱',icon:'✊',color:'#d99b62'},restrained:{label:'束缚',icon:'⛓️',color:'#d99b62'},stunned:{label:'眩晕',icon:'💫',color:'#ffd166'},petrified:{label:'石化',icon:'🗿',color:'#a9b3bf'},invisible:{label:'隐形',icon:'👻',color:'#8fbaff'},concentrating:{label:'专注',icon:'🎯',color:'#68d9c0'},burning:{label:'燃烧',icon:'🔥',color:'#ef6c45'}
  };
  const MAX_TOKEN_CONDITIONS = 20;
  const CONDITION_SPRITE_URL = '../asset/界面/状态图标-v1.png';
  const PLAYER_HOME_THEMES = Object.freeze({
    a:{label:'冒险桌',image:'../asset/界面/主页背景/a-玩家端.jpg'},
    b:{label:'城外营地',image:'../asset/界面/主页背景/b-玩家端.jpg'},
    c:{label:'传送门大厅',image:'../asset/界面/主页背景/c-玩家端.jpg'},
    d:{label:'旅途区域地图',image:'../asset/界面/主页背景/d-玩家端.jpg'}
  });
  let state = null, currentMap = null, playerMapId = null, lastPresentedMapId = null, playerMapBrowserChapterId = null, view = {scale:1,ox:0,oy:0}, myName = '', myPlayerId = '', sessionToken = '', roomCode = '', players = [], presenceStatus = 'online', selectedId = null, drag = null, toastTimer = null, peekTimer = null, restAnimationTimer = null, localRolls = new Set(), lastMapViewKey = '', flowPanel = 'initiative', flowClockAnchor = { localNow: performance.now(), serverNow: Date.now() }, flowTimer = null, measureMode = false, measureDraft = null, doodleTool = null, doodleColor = '#ff4d4f', doodleWidth = 6, doodleDraft = null, presenceTimer = null, streamES = null, streamAppliedSeq = 0, lastStateRevision = 0, spellAimTokenId = null, pendingMapReaction = null, spellRangeRaf = null, initiativePending = false, lastFlowScrollEntryId = null, editingPlayerConditionId = null, activePlayerDetailTab = 'status', diceVisibility = 'public', contextTokenId = null, investigationTokenId = null, playerPortraitManagerTokenId = null, playerTempHpUndo = null;
  const localReactionIds = new Set();
  const playedRestTransitions = new Set();
  const mapPreloadCached = new Set(), mapPreloadQueued = new Set(), mapPreloadAttempts = new Map();
  let mapPreloadQueue = [], mapPreloadTimer = null, mapPreloadController = null, mapPreloadActiveUrl = '';
  const mapAssetLoads = new Map(), mapVariantFailures = new Set();
  let activeMapAssetSource = '', activeMapAssetReady = false;
  const REQUIRED_SERVER_PROTOCOL=SundollProtocol.version,PLAYER_PORTRAIT_SOURCE_LIMIT=12*1024*1024,PLAYER_PORTRAIT_TARGET_BYTES=280*1024;
  let playerSpawnPending=false,playerPortraitPending=false,playerDraftPortrait='',playerDeletePending=null,playerMountPending=null,playerDismountPending=null;
  function applyJoinHomeTheme(themeKey){
    const mask=$('#join-mask'),key=Object.prototype.hasOwnProperty.call(PLAYER_HOME_THEMES,themeKey)?themeKey:'a',theme=PLAYER_HOME_THEMES[key];if(!mask||!theme)return;
    mask.dataset.homeTheme=key;mask.dataset.homeThemeLabel=theme.label;mask.style.setProperty('--join-background-image','url("'+new URL(theme.image,document.baseURI).href+'")');
    document.querySelectorAll('[data-join-theme]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.joinTheme===key)));
  }
  function randomizeJoinHomeTheme(){const keys=Object.keys(PLAYER_HOME_THEMES);applyJoinHomeTheme(keys[Math.floor(Math.random()*keys.length)]);}
  function initJoinHomeThemePicker(){const picker=$('#join-theme-picker');if(!picker)return;picker.addEventListener('click',event=>{const button=event.target.closest('[data-join-theme]');if(button&&picker.contains(button))applyJoinHomeTheme(button.dataset.joinTheme);});}
  function preloadConditionPixels(){const image=new Image();image.onload=()=>document.documentElement.classList.add('condition-pixels-ready');image.onerror=()=>document.documentElement.classList.remove('condition-pixels-ready');image.src=CONDITION_SPRITE_URL;}
  let conditionPixelsStarted=false;
  function ensureConditionPixels(){if(!conditionPixelsStarted){conditionPixelsStarted=true;preloadConditionPixels();}}
  try { myName = localStorage.getItem('sangduoer-watch-name') || ''; sessionToken = localStorage.getItem('sangduoer-watch-session') || ''; } catch (e) {}
  $('#player-name').value = myName;

  function toast(msg) { const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2400); }
  function playRestTransition(action) {
    const kind=action&&action.kind==='long'?'long':action&&action.kind==='short'?'short':null;if(!kind)return;
    const restId=String(action.restId||'');if(restId&&playedRestTransitions.has(restId))return;
    if(restId){playedRestTransitions.add(restId);while(playedRestTransitions.size>24)playedRestTransitions.delete(playedRestTransitions.values().next().value);}
    const isLong=kind==='long',fallback=isLong?4400:2200,reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,duration=reducedMotion?(isLong?900:600):clamp(Math.trunc(Number(action.duration)||fallback),1000,8000),layer=$('#rest-transition'),sceneApi=window.SundollRestScenes,scene=sceneApi&&sceneApi.get?sceneApi.get(action.scene,kind):{id:isLong?'long-outdoor':'short-outdoor',icon:isLong?'🌙':'🔥',subtitle:isLong?'星夜安营，静候黎明':'林间停驻，整备再启',effect:isLong?'stars':'embers',image:new URL(isLong?'../asset/界面/休息动画/长休-室外星夜.jpg':'../asset/界面/休息动画/短休-室外林地.jpg',window.location.href).href};
    clearTimeout(restAnimationTimer);
    window.SundollRestAudio?.play(scene,duration,{volume:()=>playerMusic.muted()?0:Number($('#player-audio-volume').value)/100,backgroundVolume:()=>Number($('#player-audio-volume').value)/100,backgrounds:()=>playerMusic.backgrounds(),onBlocked:()=>toast('点击页面启用声音，下次休息将播放配乐'),onError:()=>toast('休息配乐加载失败')});
    layer.hidden=false;layer.className='rest-transition '+(isLong?'is-long':'is-short')+' rest-effect-'+scene.effect;layer.dataset.restScene=scene.id;layer.style.setProperty('--rest-scene-image','url("'+scene.image+'")');layer.style.setProperty('--rest-duration',duration+'ms');layer.setAttribute('aria-label',isLong?'长休进行中':'短休进行中');
    $('#rest-transition-icon').textContent=scene.icon;$('#rest-transition-title').textContent=isLong?'长休':'短休';$('#rest-transition-subtitle').textContent=scene.subtitle;void layer.offsetWidth;
    restAnimationTimer=setTimeout(()=>{restAnimationTimer=null;layer.hidden=true;layer.className='rest-transition';delete layer.dataset.restScene;layer.style.removeProperty('--rest-scene-image');layer.removeAttribute('aria-label');},duration);
  }
  function actionId() { return (crypto&&crypto.randomUUID) ? crypto.randomUUID() : 'a'+Date.now()+Math.random().toString(36).slice(2); }
  const danmaku = (() => {
    try {
      return window.SundollDanmaku.mount({
        board: document.querySelector('#board'),
    toggleButton: document.querySelector('#dock-danmaku'),
        canSend: () => !!sessionToken && !!state,
        unavailable: '请先加入房间',
        send: text => requestAction({op:'danmaku',text}),
      });
    } catch (error) {
      console.warn('弹幕未能加载，其他功能仍可使用；请重启服务并刷新页面。', error);
      return { receive() {}, clear() {} };
    }
  })();
  function requestAction(action) {
    const body={player:myName||'玩家',sessionToken,actionId:actionId(),action,campaignId:state?.campaignId,serverSessionId:state?._sessionId};
    const requestedToken=sessionToken;
    return fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>{const result={ok:r.ok,data:await r.json().catch(()=>({}))};if(r.status===401&&sessionToken===requestedToken)handleSessionRevoked({playerId:myPlayerId,reason:result.data.error||'玩家会话已失效'});return result;});
  }
  function dataUrlBytes(value){const comma=String(value||'').indexOf(',');return comma<0?0:Math.ceil((value.length-comma-1)*3/4);}
  function renderPlayerDraftPortrait(){
    const pick=$('#player-token-image-pick'),preview=$('#player-token-image-preview'),label=$('#player-token-image-label'),clear=$('#player-token-image-clear');if(!pick||!preview||!label||!clear)return;
    pick.classList.toggle('has-image',!!playerDraftPortrait);preview.style.backgroundImage=playerDraftPortrait?'url("'+playerDraftPortrait+'")':'none';preview.textContent=playerDraftPortrait?'':'＋';label.textContent=playerPortraitPending?'正在处理图片…':playerDraftPortrait?'更换棋子图片':'上传棋子图片';clear.hidden=!playerDraftPortrait;pick.disabled=playerPortraitPending||playerSpawnPending;clear.disabled=playerPortraitPending||playerSpawnPending;
  }
  function compressPlayerDraftPortrait(file){
    return new Promise((resolve,reject)=>{
      const source=URL.createObjectURL(file),image=new Image();
      image.onerror=()=>{URL.revokeObjectURL(source);reject(new Error('无法读取这张图片'));};
      image.onload=()=>{
        try{
          const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height,crop=Math.min(width,height);if(!crop)throw new Error('图片尺寸无效');
          const first=Math.min(512,Math.max(1,Math.floor(crop))),edges=[...new Set([first,Math.min(first,448),Math.min(first,384),Math.min(first,320)])],qualities=[.9,.82,.74,.66];
          for(const edge of edges){
            const canvas=document.createElement('canvas');canvas.width=edge;canvas.height=edge;const context=canvas.getContext('2d',{alpha:true});if(!context)throw new Error('浏览器无法处理图片');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';context.drawImage(image,(width-crop)/2,(height-crop)/2,crop,crop,0,0,edge,edge);
            for(const quality of qualities){const data=canvas.toDataURL('image/webp',quality);if(dataUrlBytes(data)<=PLAYER_PORTRAIT_TARGET_BYTES)return resolve(data);}
          }
          throw new Error('图片内容过于复杂，请换一张图片');
        }catch(error){reject(error);}finally{URL.revokeObjectURL(source);}
      };
      image.src=source;
    });
  }
  async function choosePlayerDraftPortrait(file){
    if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('⚠ 请选择 PNG、JPG 或 WebP 图片');return;}if(file.size>PLAYER_PORTRAIT_SOURCE_LIMIT){toast('⚠ 原图不能超过 12 MB');return;}
    playerPortraitPending=true;renderPlayerDraftPortrait();updatePlayerPlaceUi();
    try{playerDraftPortrait=await compressPlayerDraftPortrait(file);toast('✓ 棋子图片已准备好');}
    catch(error){toast('⚠ '+(error.message||'图片处理失败'));}
    finally{playerPortraitPending=false;renderPlayerDraftPortrait();updatePlayerPlaceUi();}
  }
  function updatePlayerPlaceUi() {
    const button=$('#player-place-token');if(!button)return;
    button.disabled=playerSpawnPending||playerPortraitPending||!sessionToken||!currentMap;
    button.textContent=playerPortraitPending?'正在处理图片…':playerSpawnPending?'正在放置…':'📌 放到视野中央';renderPlayerDraftPortrait();
  }
  async function placePlayerDraftToken() {
    if(playerSpawnPending||playerPortraitPending)return;
    if(!sessionToken){toast('请先加入房间');updatePlayerPlaceUi();return;}
    if(!currentMap){toast('等待主控台载入地图');updatePlayerPlaceUi();return;}
    const name=$('#player-token-name').value.trim().slice(0,24)||((myName||'玩家')+'的临时棋子').slice(0,24),hpMax=clamp(parseInt($('#player-token-hp').value,10)||10,1,99999),ac=clamp(parseInt($('#player-token-ac').value,10)||10,0,99),icon=$('#player-token-icon').value.trim().slice(0,4)||'🧙',sizeCategory=$('#player-token-size').value,size=SundollSize.footprint({sizeCategory});
    const center={x:(board.clientWidth/2-view.ox)/Math.max(.2,view.scale),y:(board.clientHeight/2-view.oy)/Math.max(.2,view.scale)},position=state&&state.snap===false?{x:center.x,y:center.y}:snap(center.x,center.y,{size}),grid=Number(currentMap.gridSize)||50,margin=size*grid/2,x=clamp(position.x,margin,currentMap.mapW-margin),y=clamp(position.y,margin,currentMap.mapH-margin);
    playerSpawnPending=true;updatePlayerPlaceUi();
    try{
      const result=await requestAction({op:'spawnToken',mapId:currentMap.id,x,y,draft:{name,hpMax,ac,icon,size,sizeCategory,iconImg:playerDraftPortrait||null}}),data=result.data||{};
      if(!result.ok||data.ok===false){updatePlayerPlaceUi(data.error||'放置失败');toast('⚠ '+(data.error||'放置失败'));return;}
      updatePlayerPlaceUi('已放置「'+name+'」；可继续调整后再次放置');
    }catch(error){updatePlayerPlaceUi('放置未送达，请检查连接');toast('⚠ 放置未送达');}
    finally{playerSpawnPending=false;setTimeout(()=>updatePlayerPlaceUi(),1800);}
  }
  function setConnection(label,on) { const el=$('#connection'); el.textContent=label; el.classList.toggle('on',!!on); }
  let playerNameSaving=false;
  function applyPlayerDisplayName(name) {
    myName=name;
    try{localStorage.setItem('sangduoer-watch-name',name);}catch(e){}
    sessionMemory.remember({token:sessionToken,name,room:roomCode});
    $('#session-badge').textContent=name+' · 已加入';
    if(document.activeElement!==$('#player-name'))$('#player-name').value=name;
  }
  async function savePlayerName() {
    const input=$('#player-name'),name=input.value.trim(),token=sessionToken,oldName=myName;
    if(playerNameSaving||!token||name===myName)return;
    if(!name||name.length>24){input.value=myName;toast('玩家名需为 1–24 个字符');return;}
    playerNameSaving=true;input.readOnly=true;
    try{
      const response=await fetch('/api/player-name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:token,name,expectedName:oldName})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.ok)throw new Error(response.status===404?'请主控保存战役并重启服务以启用改名':result.error||'改名失败');
      if(sessionToken!==token)return;
      applyPlayerDisplayName(result.session.name);input.value=myName;toast('名字已更新');
    }catch(error){if(sessionToken===token){input.value=myName;toast(error.message||'改名未确认，请刷新核对');}}
    finally{playerNameSaving=false;input.readOnly=!sessionToken;}
  }
  function renderPlayers(nextPlayers=players) {
    players=Array.isArray(nextPlayers)?nextPlayers:[]; const box=$('#player-list'); if(!box)return; box.innerHTML='';
    const own=players.find(p=>p.playerId===myPlayerId);
    if(sessionToken&&own?.name&&own.name!==myName&&!playerNameSaving)applyPlayerDisplayName(own.name);
    if(!players.length){box.innerHTML='<span class="hint">暂无其他玩家</span>';return;}
    players.forEach(p=>{const row=document.createElement('div');row.className='player-row'+(p.name===myName?' me':'');const dot=document.createElement('i');dot.className='player-dot'+(p.online?' online':'');const name=document.createElement('span');name.className='player-row-name';name.textContent=p.name||'未命名玩家';const status=document.createElement('span');status.className='player-row-status';status.textContent=p.online?(p.status==='ready'?'已准备':'在线'):'离线';row.append(dot,name,status);box.appendChild(row);});
  }
  function updateSessionUi() { $('#session-badge').textContent=sessionToken?(myName+' · 已加入'):'未加入'; $('#player-name').readOnly=!sessionToken||playerNameSaving; $('#btn-join .player-action-label').textContent=sessionToken?'切换玩家':'加入房间'; renderPlayers(players); updateEndTurnUi(); updatePlayerPlaceUi(); }
  function leavePlayerDoodleMode() {
    if(!doodleTool&&!doodleDraft)return;
    doodleTool=null;doodleDraft=null;
    if(drag?.kind==='doodle'||drag?.kind==='doodle-erase')drag=null;
    updateToolButtons();renderDoodles();
  }
  function leaveDoodleForControl(event) {
    const control=event.target.closest?.('button,a,input,select,textarea,summary,[role="tab"],[contenteditable="true"]');
    if(control&&!control.closest('#player-doodle-card'))leavePlayerDoodleMode();
  }
  document.addEventListener('click',leaveDoodleForControl,true);
  document.addEventListener('focusin',leaveDoodleForControl,true);
  function activatePlayerWorkspace(workspace,userInitiated=false) {
    const valid=['room','units','tools','draw','resources'].includes(workspace)?workspace:'room';
    if(valid!=='draw')leavePlayerDoodleMode();
    document.querySelectorAll('[data-player-workspace-tab]').forEach(tab=>{const active=tab.dataset.playerWorkspaceTab===valid;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
    document.querySelectorAll('#left-panel [data-player-workspace]').forEach(card=>{card.hidden=card.dataset.playerWorkspace!==valid;});
    if(valid==='tools'&&userInitiated)ensurePlayerDice().catch(()=>toast('骰子皮肤暂时无法加载，重新打开工具页可重试'));
  }
  function initPlayerWorkspaceTabs() {
    document.querySelectorAll('[data-player-workspace-tab]').forEach(tab=>tab.addEventListener('click',()=>activatePlayerWorkspace(tab.dataset.playerWorkspaceTab,true)));
    activatePlayerWorkspace(document.querySelector('[data-player-workspace-tab].active')?.dataset.playerWorkspaceTab||'room');
  }
  function activatePlayerDetailTab(tab, revealMobile=true) {
    leavePlayerDoodleMode();
    activePlayerDetailTab=['status','tactics','manage'].includes(tab)?tab:'status';
    document.querySelectorAll('[data-player-detail-tab]').forEach(button=>{const active=button.dataset.playerDetailTab===activePlayerDetailTab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    document.querySelectorAll('[data-player-detail-panel]').forEach(panel=>{panel.hidden=panel.dataset.playerDetailPanel!==activePlayerDetailTab;});
    const right=$('#right-panel');right.dataset.detailTab=activePlayerDetailTab;
    if(revealMobile&&!$('#detail').hidden)right.classList.add('mobile-open');
  }
  function createPlayerSessionMemory(storage) {
    const KEY='sundoll-player-switch-sessions';
    let entries=[];
    const room=value=>String(value||'').trim().toUpperCase();
    try { const saved=JSON.parse(storage?.getItem(KEY)||'[]');if(Array.isArray(saved))entries=saved.filter(e=>e&&typeof e.token==='string'&&typeof e.name==='string'&&typeof e.room==='string').slice(-8); } catch(e) {}
    const save=()=>{try{storage?.setItem(KEY,JSON.stringify(entries));}catch(e){}};
    return {
      remember(session){
        if(!session.token||!session.name)return;
        entries=entries.filter(e=>e.token!==session.token&&!(e.name===session.name&&e.room===room(session.room)));
        entries.push({token:session.token,name:session.name,room:room(session.room)});entries=entries.slice(-8);save();
      },
      find(name,code){return entries.findLast(e=>e.name===String(name||'').trim()&&e.room===room(code))?.token||'';},
      forget(token){entries=entries.filter(e=>e.token!==token);save();},
    };
  }
  let switchPresence=Promise.resolve(), joinPending=false, registeringPlayer=false;
  function setJoinMode(registering) {
    if(joinPending)return;
    registeringPlayer=!!registering;
    $('#join-mode-login').setAttribute('aria-pressed',String(!registeringPlayer));
    $('#join-mode-register').setAttribute('aria-pressed',String(registeringPlayer));
    $('#join-submit').textContent=registeringPlayer?'注册并进入':'进入玩家地图';
    $('#join-name').placeholder=registeringPlayer?'选择一个未被使用的玩家名':'输入你的玩家名字';
    $('#join-session-hint').textContent=registeringPlayer?'名字不可重复；创建后用这个名字登录。':'输入玩家名字，进入对应角色名册和背包。';
    $('#join-error').textContent='';
  }
  let switchStorage;try{switchStorage=window.sessionStorage;}catch(e){}
  const sessionMemory=createPlayerSessionMemory(switchStorage);
  async function joinSession(nickname, requestedRoom, resume=true) {
    await switchPresence;
    const payload={nickname:String(nickname||'').trim(),roomCode:String(requestedRoom||roomCode||'').trim()};
    payload.authMethod='name';
    if(!payload.nickname)throw new Error('请填写玩家名');
    const res=await fetch(registeringPlayer?'/api/register':'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); const data=await res.json().catch(()=>({}));
    if(registeringPlayer&&res.status===404)throw new Error('服务尚未启用自助注册，请主控保存战役并重启服务');
    if(!res.ok||!data.ok){if(res.status===401&&payload.sessionToken){sessionMemory.forget(payload.sessionToken);if(sessionToken===payload.sessionToken)clearStoredSession();}throw new Error(data.error||'无法加入房间');}
    if(data.session?.persistent!==true)throw new Error('服务尚未启用名字登录，请主持人保存并重启服务后再试');
    const previousToken=sessionToken;
    sessionToken=data.session?.sessionToken||sessionToken; myName=data.session?.name||payload.nickname; myPlayerId=String(data.session?.playerId||''); roomCode=data.roomCode||payload.roomCode;
    sessionMemory.remember({token:sessionToken,name:myName,room:roomCode});
    if(previousToken&&previousToken!==sessionToken)sendPresence('offline',previousToken);
    try { localStorage.setItem('sangduoer-watch-name',myName); if(sessionToken)localStorage.setItem('sangduoer-watch-session',sessionToken); } catch(e) {}
    registeringPlayer=false;
    document.querySelector('#join-mode-login')?.setAttribute('aria-pressed','true');
    document.querySelector('#join-mode-register')?.setAttribute('aria-pressed','false');
    $('#player-name').value=myName; $('#join-mask').hidden=true; $('#join-error').textContent=''; updateSessionUi();
    if(currentMap)renderTokens(currentMap); if(selectedId)openDetail(selectedId);
    sendPresence('online');
    return true;
  }
  function setJoinHomeBusy(busy) {
    const shell=document.querySelector('.join-shell');if(!shell)return;shell.classList.toggle('is-busy',!!busy);shell.setAttribute('aria-busy',String(!!busy));
  }
  function setJoinHomeStatus(label,stateName='checking') {
    const badge=$('#join-server-status');if(!badge)return;badge.textContent=label;badge.dataset.state=stateName;
  }
  function applyJoinCampaignCover(value) {
    const card=$('#join-campaign-card'),image=$('#join-campaign-cover'),url=String(value||'').trim();if(!card||!image)return;
    card.classList.toggle('has-cover',!!url);image.hidden=!url;
    if(url&&image.getAttribute('src')!==url)image.src=url;
    if(!url)image.removeAttribute('src');
  }
  function clearStoredSession() {
    sessionToken='';myPlayerId='';window.TravelBasket?.changed();PlayerBackpack.contextChanged();closePlayerLiveAudio();try{localStorage.removeItem('sangduoer-watch-session');}catch(e){}
  }
  async function validateStoredSession() {
    if(!sessionToken)return false;
    try{
      const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken})}),data=await response.json().catch(()=>({}));
      if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||'会话已失效'),{status:response.status});
      myName=String(data.session?.name||myName).trim();myPlayerId=String(data.session?.playerId||'');roomCode=String(data.roomCode||roomCode).trim();
      sessionMemory.remember({token:sessionToken,name:myName,room:roomCode});
      try{if(myName)localStorage.setItem('sangduoer-watch-name',myName);}catch(e){}
      $('#join-name').value=myName;$('#join-room').value=roomCode;$('#join-submit').textContent='继续进入玩家地图';
      $('#join-session-hint').textContent='已找到上次的玩家身份，确认后继续进入。';
      return true;
    }catch(error){
      if(error.status===401){sessionMemory.forget(sessionToken);clearStoredSession();}
      $('#join-submit').textContent='进入玩家地图';$('#join-session-hint').textContent='上次会话暂时无法恢复；可以重试，或输入玩家名字登录。';return false;
    }
  }
  async function refreshPlayerHome() {
    setJoinHomeStatus('连接服务器中','checking');
    const infoResponse=await fetch('/api/info',{cache:'no-store'});
    if(!infoResponse.ok)throw new Error('服务器没有响应');
    const info=await infoResponse.json();
    if(Number(info.protocolVersion)!==REQUIRED_SERVER_PROTOCOL)throw new Error('联机服务器版本过旧，请重新运行启动程序');
    if(!roomCode)roomCode=String(info.roomCode||'').trim();
    if(!$('#join-room').value)$('#join-room').value=roomCode;
    $('#join-room-code').textContent=info.roomCode||roomCode||'—';
    $('#join-map-name').textContent=info.activeMapName||'尚未载入地图';
    $('#join-player-count').textContent=Number.isFinite(Number(info.playerCount))?`${Number(info.playerCount)} 人在线`:'—';
    $('#join-campaign-name').textContent=info.campaignName||'等待主控台载入战役';
    applyJoinCampaignCover(info.campaignCoverUrl);
    $('#join-room-hint').textContent=info.activeMapName
      ? `${Number(info.mapCount)||1} 张地图 · 当前为「${info.activeMapName}」`
      : '主控台在线，正在等待地图';
    setJoinHomeStatus('服务器在线','ready');
    return true;
  }
  async function bootstrapSession() {
    randomizeJoinHomeTheme();
    const q=new URLSearchParams(location.search), urlRoom=q.get('room')||''; roomCode=urlRoom;
    $('#join-mask').hidden=false;$('#join-name').value=myName;$('#join-room').value=roomCode;setJoinHomeBusy(true);
    const preview=refreshPlayerHome().catch(error=>{setJoinHomeStatus('服务器未连接','error');$('#join-room-hint').textContent='请确认主控台已经开启联机服务';$('#join-error').textContent=error.message||'暂时无法连接服务器';});
    const session=validateStoredSession();
    await Promise.all([preview,session]);
    setJoinHomeBusy(false);updateSessionUi();
    requestAnimationFrame(()=>$('#join-name').focus());
  }
  function sendPresence(status=presenceStatus,requestedToken=sessionToken) { if(!requestedToken)return Promise.resolve();if(requestedToken===sessionToken)presenceStatus=status;return fetch('/api/presence',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({sessionToken:requestedToken,status})}).then(response=>{if(response.status===401&&sessionToken===requestedToken)handleSessionRevoked({playerId:myPlayerId,reason:'玩家会话已失效'});return response;}).catch(()=>{}); }
  function returnToJoinHome({notifyServer=true,hint='输入玩家名字返回原账号，或切换到另一位玩家。'}={}) { clearTimeout(patchTimer);patchTimer=null;pendingPatch=null;if(notifyServer&&sessionToken){sessionMemory.remember({token:sessionToken,name:myName,room:roomCode});switchPresence=sendPresence('offline');}if(streamES){try{streamES.close();}catch(e){}streamES=null;}clearStoredSession();setConnection('未进入',false);$('#join-error').textContent='';$('#join-name').value=myName;$('#join-room').value=roomCode;$('#join-submit').textContent='进入玩家地图';$('#join-session-hint').textContent=hint;randomizeJoinHomeTheme();$('#join-mask').hidden=false;closeDetail();updateSessionUi();if(currentMap)renderTokens(currentMap);refreshPlayerHome().catch(()=>setJoinHomeStatus('服务器未连接','error')); }
  function leaveSession() { returnToJoinHome(); }
  function handleSessionRevoked(event) { if(!sessionToken||String(event&&event.playerId||'')!==String(myPlayerId||''))return;sessionMemory.forget(sessionToken);const reason=String(event&&event.reason||'已被主控台移出房间');returnToJoinHome({notifyServer:false,hint:reason+'。如需继续游戏，请重新加入。'});toast('👋 '+reason); }
  async function releaseOwnedPiece(piece, destinationOverride, fromBasket=false,dropPosition=null) {
    if(!sessionToken)throw new Error('请先加入房间');
    const targetMap=destinationOverride?(state?.maps||[]).find(m=>m.id===destinationOverride):currentMap;
    if(!targetMap||!playerMapOpen(targetMap))throw new Error('目标地图尚未开放');
    if(await dispatchPendingPatch()===false)throw new Error('请等待角色修改保存后重试');
    if(!piece?.ownedPieceId)throw new Error('棋子资料已变化，请刷新小库');
    const destinationId=targetMap.id;
    const arrival=fromBasket?{fromBasket:true,position:dropPosition||{x:(board.clientWidth/2-view.ox)/view.scale,y:(board.clientHeight/2-view.oy)/view.scale}}:{};
    const result=await requestAction({op:'releaseOwnedPiece',mapId:destinationId,ownedPieceId:piece.ownedPieceId,...arrival});
    if(!result.ok||result.data?.ok===false)throw new Error(result.data?.error||'释放棋子失败');
    // HTTP acknowledgement does not guarantee that the SSE update reached this tab.
    let snapshot;
    try {
      const response=await fetch('/api/state',{cache:'no-store'});
      if(!response.ok)throw new Error('state unavailable');
      snapshot=await response.json();
    } catch (_) {
      throw new Error('服务器已接受放置，但地图同步失败。请刷新地图核对；重试不会重复创建这枚收藏。');
    }
    if(destinationOverride)playerMapId=destinationId;
    render(snapshot);
    const placedMap=(state?.maps||[]).find(map=>map.id===destinationId);
    const placed=placedMap?.tokens?.find(token=>token.ownedPieceId===piece.ownedPieceId);
    if(!placed)throw new Error('放置请求已接受，但最新地图中未找到棋子，请刷新后重试或联系主控检查同步。');
    if(destinationOverride&&currentMap?.id!==destinationId&&placedMap?.mapData)switchPlayerMap(destinationId);
    if(currentMap?.id!==destinationId)throw new Error('棋子已放到原目标地图，但当前地图已切换，请返回目标地图查看。');
    renderTokens(currentMap);
    openDetail(placed.id);
    if(dropPosition)return;
    const viewport=board.getBoundingClientRect();
    view.ox=viewport.width/2-Number(placed.x)*view.scale;
    view.oy=viewport.height/2-Number(placed.y)*view.scale;
    applyView();
  }
  async function recallOwnedPiece(piece,toBasket=false){
    if(await dispatchPendingPatch()===false)throw new Error('请等待角色修改保存后重试');
    const result=await requestAction({op:'recallOwnedPiece',ownedPieceId:piece.ownedPieceId,toBasket:toBasket===true});
    if(!result.ok||result.data?.ok===false)throw new Error(result.data?.error||'收回失败');
    const response=await fetch('/api/state',{cache:'no-store'});
    if(!response.ok)throw new Error('已收回，地图同步暂未完成，请刷新核对');
    render(await response.json());
  }
  window.TravelBasket.configure({
    board,mapPoint:(x,y)=>{const r=board.getBoundingClientRect();return {x:(x-r.left-view.ox)/view.scale,y:(y-r.top-view.oy)/view.scale};},
    followOpen:true,open:()=>Boolean(sessionToken&&myPlayerId&&state?.travelBasketOpen===true),
    parent:board,skin:()=>state?.travelBasketSkin||'travel-wagon',
    key:()=>[sessionToken,myPlayerId,state?.campaignId,currentMap?.id].join('|'),
    list:async()=>{
      if(!sessionToken||!myPlayerId)throw new Error('请先登录玩家档案');
      const response=await fetch('/api/player-profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'travelBasket',sessionToken})});
      const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'队伍暂时无法同步');
      if(data.campaignId!==state?.campaignId)throw new Error('战役正在切换，请稍候');
      const row=t=>({...t,image:assetUrl(t)});
      return {stored:data.stored.map(row),available:data.available.map(row),canPlace:Boolean(currentMap&&playerMapOpen(currentMap))};
    },
    collect:piece=>{if(!piece.ownedPieceId||piece.ownerPlayerId!==myPlayerId)throw new Error('只能收起自己的个人棋子');return recallOwnedPiece(piece,true);},
    release:(piece,point)=>releaseOwnedPiece(piece,undefined,true,point),

  });
  PlayerLibrary.configure({host:false,session:()=>sessionToken,recall:recallOwnedPiece,transfer:(piece,mapId)=>releaseOwnedPiece(piece,mapId),destinations:()=> (state?.maps||[]).filter(playerMapOpen).map(m=>({id:m.id,name:m.name||m.floorLabel||'地图'})),place:piece=>releaseOwnedPiece(piece),placeLabel:'释放到当前地图',placeStatus:'已释放到当前地图',
    signIn:()=>returnToJoinHome({hint:'输入玩家名字，打开你的个人收藏。'}),
    mapId:()=>currentMap?.id || '',
    mapName:()=>currentMap?.name || '',
    describePlacement:piece=>{
      if(!sessionToken) return {hint:'请先加入房间，再使用个人棋子。',blocked:true};
      if(!currentMap || !playerMapOpen(currentMap)) return {hint:'等待主控开放地图后，即可带入你的棋子。',blocked:true};
      const existing=currentMap.tokens?.find(t=>t.ownedPieceId===piece.ownedPieceId);
      return existing ? {label:'返回地图使用棋子',hint:'这枚棋子已在当前地图，不会重复创建。'} : {label:'释放到当前地图',hint:'带入时会保留已有的本战役血量与状态。'};
    }
  });
  $('#player-collect-token').onclick=async()=>{
    const token=tokenById(selectedId);if(!token)return;
    if(token.ownedPieceId && token.ownerPlayerId===myPlayerId) { await PlayerLibrary.open({ownedPieceId:token.ownedPieceId}); return; }
    const button=$('#player-collect-token');button.disabled=true;
    try{
      await PlayerLibrary.api({op:'collect',tokenId:token.id,campaignId:state?.campaignId});
      toast('已收入个人小库；已有收藏不会重复添加');await PlayerLibrary.open();
    }catch(error){toast(error.message||'收入失败，请重试');}
    finally{button.disabled=false;}
  };

  PlayerBackpack.configure({host:false,roll:(...args)=>playPlayerDice(...args),campaignId:()=>state?.campaignId||'',characters:(chars,campaign)=>{if(campaign!==state?.campaignId)return;for(const c of chars)applyAction({op:'characterState',characterId:c.id,ownerPlayerId:c.ownerPlayerId,patch:{...c.base,...c.runtime,characterRevision:c.revision}});},session:()=>sessionToken,playerId:()=>myPlayerId,
    signIn:()=>returnToJoinHome({hint:'使用玩家名字登录，打开你的物品和个人棋子。'})
  });
  $('#btn-player-library').onclick=()=>PlayerLibrary.open();
  $('#btn-player-backpack').onclick=()=>PlayerBackpack.open();
  $('#btn-player-maps').onclick=()=>openPlayerMapBrowser();
  $('#btn-player-journal').onclick=()=>CampaignJournal.open();
  function mine(t) { return !!myPlayerId && (t.ownerPlayerId || t.owner || '') === myPlayerId; }
  function friendly(t) { return !!t && (!!t.ownedPieceId || t.type === 'pc' || t.type === 'ally'); }
  const PLAYER_PORTRAIT_TIER=512, portraitProbes=new Map();
  function projectAssetUrl(src) {
    if (!src || /^(?:data:|blob:|https?:|\/)/.test(src)) return src||'';
    return '../asset/棋子库/' + String(src).replace(/\\/g,'/').replace(/^(?:\.\.\/)?(?:(?:asset|assets)\/)?棋子库\//,'');
  }
  function portraitLodUrl(path,tier=PLAYER_PORTRAIT_TIER) {
    const normalized=String(path||'').replace(/\\/g,'/').replace(/^(?:\.\.\/)?(?:(?:asset|assets)\/)?棋子库\//,'').replace('立绘/NPC/短团-烬鳞讨伐/','立绘/NPC/短团·烬鳞讨伐/');
    if(/^\/api\/module-assets\/[0-9a-f]{64}$/.test(normalized))return normalized+'?variant=token-512';
    if(!normalized.startsWith('立绘/'))return projectAssetUrl(path);
    const relative=normalized.slice(3).replace(/\.[^./]+$/,'.webp');
    return projectAssetUrl('显示缓存/'+tier+'/'+relative);
  }
  function assetUrl(t) {
    if(t.iconImgPath)return portraitLodUrl(t.iconImgPath);
    return projectAssetUrl(t.iconImgHd || t.iconImg || '');
  }
  function originalPortraitUrl(t) { return t&&t.iconImgPath ? projectAssetUrl(t.iconImgPath) : assetUrl(t); }
  function normalizePlayerPortraitVariants(raw) {
    return(Array.isArray(raw)?raw:[]).filter(v=>v&&typeof v==='object'&&String(v.name||'').trim()&&(v.iconImgPath||v.iconImg||v.iconImgHd||v.iconImgId)).slice(0,24).map(v=>({name:String(v.name).trim().slice(0,24),iconImg:v.iconImg||null,iconImgHd:v.iconImgHd||null,iconImgPath:v.iconImgPath||null,iconImgId:v.iconImgId||null}));
  }
  function portraitIdentity(source) { if(!source)return'';if(source.iconImgPath)return'path:'+String(source.iconImgPath).replace(/\\/g,'/');if(source.iconImgId)return'id:'+source.iconImgId;if(source.iconImgHd)return'hd:'+source.iconImgHd;if(source.iconImg)return'img:'+source.iconImg;return''; }
  function currentPortraitVariantIndex(t,variants=normalizePlayerPortraitVariants(t&&t.portraitVariants)) { const identity=portraitIdentity(t);if(!identity)return-1;const hinted=Number.isInteger(t&&t.portraitVariant)?t.portraitVariant:-1;if(hinted>=0&&hinted<variants.length&&portraitIdentity(variants[hinted])===identity)return hinted;return variants.findIndex(v=>portraitIdentity(v)===identity); }
  function applyPlayerPortrait(el,t) {
    const url=assetUrl(t); if(!url)return false;
    el.dataset.portraitUrl=url;
    el.style.backgroundImage='url("'+url+'")';
    if(t.iconImgPath){el.style.backgroundSize=String(t.iconImgPath).includes('/零式-')?'119.2% 119.2%':'116.3% 116.3%';el.style.backgroundPosition='center';}
    const fallback=originalPortraitUrl(t); if(!t.iconImgPath||url===fallback)return true;
    const known=portraitProbes.get(url);
    if(known===false){el.style.backgroundImage='url("'+fallback+'")';return true;}
    if(known===true)return true;
    if(known){known.then(ok=>{if(!ok&&el.isConnected&&el.dataset.portraitUrl===url)el.style.backgroundImage='url("'+fallback+'")';});return true;}
    const pending=new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(true);img.onerror=()=>resolve(false);img.src=url;}).then(ok=>{portraitProbes.set(url,ok);return ok;});
    portraitProbes.set(url,pending);pending.then(ok=>{if(!ok&&el.isConnected&&el.dataset.portraitUrl===url)el.style.backgroundImage='url("'+fallback+'")';});
    return true;
  }
  function applyView() { world.style.transform = 'translate(' + view.ox + 'px,' + view.oy + 'px) scale(' + view.scale + ')'; document.querySelectorAll('.map-reaction').forEach(el=>el.style.setProperty('--reaction-scale',String(1/clamp(Number(view.scale)||1,.2,6)))); }
  function fit() { if (!currentMap) return; const r=board.getBoundingClientRect(), m=currentMap; view.scale=Math.min(r.width/m.mapW,r.height/m.mapH,2); view.ox=(r.width-m.mapW*view.scale)/2; view.oy=(r.height-m.mapH*view.scale)/2; applyView(); }
  function point(e) { const r=world.getBoundingClientRect(); return {x:(e.clientX-r.left)/view.scale,y:(e.clientY-r.top)/view.scale}; }
  function snapMeasurePoint(p) { return SundollRules.snapMeasurePoint(p,currentMap,view.scale); }
  function snap(x,y,t) { return SundollSize.point(currentMap,t,x,y,true); }

  function normalizeSpellRange(...args) { return SundollRules.normalizeSpellRange(...args); }
  function spellDirectionLabel(degrees){const labels=['东','东南','南','西南','西','西北','北','东北'],d=((Number(degrees)||0)%360+360)%360;return labels[Math.round(d/45)%8]+' · '+Math.round(d)+'°';}
  function drawSpellRangeForToken(ctx,t,m,selected){
    const range=normalizeSpellRange(t.spellRange);
    if(range.shape==='off')return;
    const grid=m.gridSize||50,radius=range.feet/5*grid;
    if(!Number.isFinite(radius)||radius<=0)return;
    const meta=TYPE[t.type]||TYPE.npc,color=meta.ring||'#6fa4ed';
    ctx.save();
    ctx.lineWidth=Math.max(2,grid*(selected ? .055 : .038));
    ctx.strokeStyle=color;ctx.fillStyle=color;ctx.globalAlpha=selected ? .25 : .12;
    ctx.beginPath();
    if(range.shape==='cone'){
      const a=range.direction*Math.PI/180;
      ctx.moveTo(t.x,t.y);ctx.arc(t.x,t.y,radius,a-SPELL_CONE_HALF_ANGLE,a+SPELL_CONE_HALF_ANGLE);ctx.closePath();
    }else ctx.arc(t.x,t.y,radius,0,Math.PI*2);
    ctx.fill();ctx.globalAlpha=selected ? .94 : .56;
    ctx.setLineDash(selected?[]:[Math.max(7,grid*.18),Math.max(5,grid*.12)]);ctx.stroke();ctx.setLineDash([]);
    ctx.globalAlpha=selected ? .43 : .22;ctx.lineWidth=Math.max(1,grid*.018);
    if(range.shape==='radius'){
      const rings=Math.min(6,Math.floor(range.feet/30));
      for(let i=1;i<=rings;i++){ctx.beginPath();ctx.arc(t.x,t.y,radius*i/(rings+1),0,Math.PI*2);ctx.stroke();}
    }else{
      const a=range.direction*Math.PI/180;
      ctx.beginPath();ctx.moveTo(t.x,t.y);ctx.lineTo(t.x+Math.cos(a)*radius,t.y+Math.sin(a)*radius);ctx.stroke();
    }
    const la=range.shape==='cone'?range.direction*Math.PI/180:-Math.PI/2,lr=Math.min(radius*.82,radius-12),lx=t.x+Math.cos(la)*lr,ly=t.y+Math.sin(la)*lr,fs=clamp(grid*.23,10,18);
    ctx.globalAlpha=selected ? .95 : .68;ctx.font='700 '+fs+'px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=Math.max(3,fs*.26);ctx.strokeStyle='rgba(9,12,18,.84)';ctx.strokeText(range.feet+' 尺',lx,ly);ctx.fillStyle='#f4f8ff';ctx.fillText(range.feet+' 尺',lx,ly);ctx.restore();
  }
  function renderSpellRanges(){
    const enabled=currentMap?(currentMap.tokens||[]).filter(t=>normalizeSpellRange(t.spellRange).shape!=='off'):[];
    if(!enabled.length){if(spellRangeCanvas.width!==1)spellRangeCanvas.width=1;if(spellRangeCanvas.height!==1)spellRangeCanvas.height=1;return;}
    if(spellRangeCanvas.width!==currentMap.mapW)spellRangeCanvas.width=currentMap.mapW;
    if(spellRangeCanvas.height!==currentMap.mapH)spellRangeCanvas.height=currentMap.mapH;
    spellRangeCtx.clearRect(0,0,currentMap.mapW,currentMap.mapH);
    enabled.filter(t=>t.id!==selectedId).forEach(t=>drawSpellRangeForToken(spellRangeCtx,t,currentMap,false));
    const selected=enabled.find(t=>t.id===selectedId);if(selected)drawSpellRangeForToken(spellRangeCtx,selected,currentMap,true);
  }
  function requestSpellRangeRender(){if(spellRangeRaf!=null)return;spellRangeRaf=requestAnimationFrame(()=>{spellRangeRaf=null;renderSpellRanges();});}
  function makeReactionId(){return window.crypto&&typeof window.crypto.randomUUID==='function'?'p-'+window.crypto.randomUUID():'p-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}
  function displayPlayerName(value, fallback = '玩家') {
  const raw = String(value || '').trim();
  const looksLikeId = /^p[0-9a-f]{12,32}$/i.test(raw);
  const matches = players.filter(player => player.playerId === raw || (looksLikeId && String(player.playerId || '').startsWith(raw)));
  if (matches.length === 1 && matches[0].name && matches[0].name !== raw) return matches[0].name;
  return raw && !looksLikeId ? raw : fallback;
}
function tokenOwnerName(token) {
  return displayPlayerName(token.ownerPlayerId || token.owner, displayPlayerName(token.owner));
}
function showMapReaction(a){if(!currentMap||!a||a.mapId!==currentMap.id||!MAP_REACTION_EMOJIS.has(a.emoji))return;const layer=$('#reaction-layer'),item=document.createElement('div');item.className='map-reaction';item.dataset.reactionId=String(a.reactionId||'');item.style.left=clamp(Number(a.x)||0,0,currentMap.mapW)+'px';item.style.top=clamp(Number(a.y)||0,0,currentMap.mapH)+'px';item.style.setProperty('--reaction-scale',String(1/clamp(Number(view.scale)||1,.2,6)));const bubble=document.createElement('div');bubble.className='map-reaction-bubble';const emoji=document.createElement('span');emoji.className='map-reaction-emoji';emoji.textContent=a.emoji;const author=document.createElement('span');author.className='map-reaction-author';author.textContent=String(displayPlayerName(a.displayName||a.name||a.actor)).slice(0,24);bubble.append(emoji,author);item.appendChild(bubble);layer.appendChild(item);setTimeout(()=>item.remove(),2850);}
  function syncReactionUi(){const palette=$('#reaction-palette'),placing=!!pendingMapReaction;palette.querySelectorAll('[data-map-reaction]').forEach(b=>b.classList.toggle('active',b.dataset.mapReaction===pendingMapReaction));document.querySelectorAll('#btn-reaction,#dock-reaction').forEach(b=>b.classList.toggle('active',placing||!palette.hidden));board.classList.toggle('reaction-placing',placing);}
  function toggleReactionPalette(){if(!sessionToken){toast('请先加入房间');return;}const palette=$('#reaction-palette');if(!palette.hidden){palette.hidden=true;pendingMapReaction=null;}else{cancelSpellAim();palette.hidden=false;}syncReactionUi();}
  function selectMapReaction(emoji){if(!MAP_REACTION_EMOJIS.has(emoji))return;cancelSpellAim();measureMode=false;measureDraft=null;doodleTool=null;doodleDraft=null;updateToolButtons();renderDoodles();renderTurnPath();pendingMapReaction=emoji;$('#reaction-palette').hidden=true;syncReactionUi();toast('点击地图发送表情；按 Esc 取消');}
  function cancelMapReaction(){pendingMapReaction=null;$('#reaction-palette').hidden=true;syncReactionUi();}
  function placePlayerReactionAt(e){if(!pendingMapReaction||!currentMap)return false;if(!sessionToken){cancelMapReaction();toast('请先加入房间');return true;}const p=point(e),action={op:'mapReaction',reactionId:makeReactionId(),mapId:currentMap.id,x:clamp(p.x,0,currentMap.mapW),y:clamp(p.y,0,currentMap.mapH),emoji:pendingMapReaction};localReactionIds.add(action.reactionId);setTimeout(()=>localReactionIds.delete(action.reactionId),5000);showMapReaction({...action,name:myName||'玩家'});cancelMapReaction();requestAction(action).then(r=>{if(!r.ok||r.data?.ok===false)toast('⚠ '+(r.data?.error||'表情未送达'));}).catch(()=>toast('⚠ 表情未送达'));return true;}

  function syncSpellRangeUi(t,editable=canActWithToken(t)){
    const range=normalizeSpellRange(t&&t.spellRange);if(t)t.spellRange=range;
    document.querySelectorAll('[data-spell-shape]').forEach(button=>{const active=button.dataset.spellShape===range.shape;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.disabled=!editable;});
    $('#spell-controls').hidden=range.shape==='off';$('#spell-feet').value=range.feet;$('#spell-feet').disabled=!editable;
    $('#spell-feet-output').textContent=range.feet+' 尺';$('#spell-grid-output').textContent=(range.feet/5)+' 格';
    document.querySelectorAll('[data-spell-feet]').forEach(button=>{button.classList.toggle('active',Number(button.dataset.spellFeet)===range.feet);button.disabled=!editable;});
    $('#spell-direction-row').hidden=range.shape!=='cone';$('#spell-direction').value=range.direction;$('#spell-direction').disabled=!editable;$('#spell-direction-output').textContent=spellDirectionLabel(range.direction);
    const aiming=!!t&&spellAimTokenId===t.id,aim=$('#spell-aim');aim.disabled=!editable;aim.classList.toggle('active',aiming);aim.textContent=aiming?'按住左键旋转…':'⌖ 在地图上瞄准';
    board.classList.toggle('spell-aiming',Boolean(spellAimTokenId));
    const mode=encounter().playMode;
    $('#spell-lock-hint').textContent=editable?(mode==='turn'?'✓ 当前回合可调整范围':mode==='prepare'?'战斗准备阶段可调整。':'自由模式下可调整。'):(mode==='turn'?'🔒 等到该棋子的回合才能调整':'请先加入房间');
  }
  function cancelSpellAim(options={}){
    const restore=options.restore!==false,aimDrag=drag&&drag.kind==='spell-aim'?drag:null,aimingId=aimDrag?.id||spellAimTokenId;
    if(aimDrag){const aimed=currentMap&&(currentMap.tokens||[]).find(token=>token.id===aimDrag.id);if(restore&&aimed)aimed.spellRange={...aimDrag.previous};try{if(board.hasPointerCapture?.(aimDrag.pointerId))board.releasePointerCapture(aimDrag.pointerId);}catch(error){}drag=null;}
    spellAimTokenId=null;board.classList.remove('spell-aiming');
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===(aimingId||selectedId));if(t&&!$('#detail').hidden)syncSpellRangeUi(t);requestSpellRangeRender();
  }
  function updateOwnedSpellRange(patch){
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===selectedId);if(!t||!ownedToken(t))return;
    if(!canActWithToken(t)){syncSpellRangeUi(t,false);toast('🔒 只有轮到该角色时才能调整范围');return;}
    const previous={...normalizeSpellRange(t.spellRange)},next=normalizeSpellRange({...previous,...patch});t.spellRange=next;
    if(next.shape!=='cone'&&spellAimTokenId===t.id)cancelSpellAim({restore:false});
    sendPatch(t.id,{spellRange:{...next}},{spellRange:previous});syncSpellRangeUi(t,true);requestSpellRangeRender();
  }
  function toggleSpellAim(){
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===selectedId);if(!t||!ownedToken(t))return;
    if(!canActWithToken(t)){syncSpellRangeUi(t,false);toast('🔒 只有轮到该角色时才能调整范围');return;}
    if(spellAimTokenId===t.id){cancelSpellAim();return;}
    if(normalizeSpellRange(t.spellRange).shape!=='cone')updateOwnedSpellRange({shape:'cone'});
    cancelMapReaction();measureMode=false;measureDraft=null;doodleTool=null;doodleDraft=null;updateToolButtons();renderDoodles();renderTurnPath();
    spellAimTokenId=t.id;syncSpellRangeUi(t,true);toast('在地图上按住左键旋转锥形，松开确定；Esc 取消');
  }
  function previewPlayerSpellAimAt(e){
    if(!spellAimTokenId||!currentMap)return false;
    const t=(currentMap.tokens||[]).find(token=>token.id===spellAimTokenId);
    if(!t||!canActWithToken(t)){cancelSpellAim();if(t)toast('🔒 回合已经变化，方向未修改');return false;}
    const p=point(e),direction=((Math.atan2(p.y-t.y,p.x-t.x)*180/Math.PI)+360)%360;
    t.spellRange=normalizeSpellRange({...t.spellRange,shape:'cone',direction});syncSpellRangeUi(t,true);requestSpellRangeRender();return true;
  }
  function beginPlayerSpellAim(e){
    if(!spellAimTokenId||!currentMap)return false;
    const t=(currentMap.tokens||[]).find(token=>token.id===spellAimTokenId);
    if(!t||!canActWithToken(t)){cancelSpellAim();if(t)toast('🔒 回合已经变化，方向未修改');return true;}
    drag={kind:'spell-aim',id:t.id,mapId:currentMap.id,pointerId:e.pointerId,turnSerial:Number(encounter().turnSerial)||1,previous:{...normalizeSpellRange(t.spellRange)}};
    try{board.setPointerCapture(e.pointerId);}catch(error){}
    previewPlayerSpellAimAt(e);return true;
  }
  function finishPlayerSpellAim(e,cancelled=false){
    const aimDrag=drag&&drag.kind==='spell-aim'?drag:null;if(!aimDrag)return false;
    try{if(board.hasPointerCapture?.(aimDrag.pointerId))board.releasePointerCapture(aimDrag.pointerId);}catch(error){}
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===aimDrag.id),sameTurn=encounter().playMode!=='turn'||Number(encounter().turnSerial)===aimDrag.turnSerial;
    const valid=!cancelled&&t&&currentMap.id===aimDrag.mapId&&sameTurn&&canActWithToken(t);
    if(valid)previewPlayerSpellAimAt(e);else if(t)t.spellRange={...aimDrag.previous};
    const next=t?{...normalizeSpellRange(t.spellRange)}:null;
    drag=null;spellAimTokenId=null;board.classList.remove('spell-aiming');
    if(t&&!$('#detail').hidden)syncSpellRangeUi(t,canActWithToken(t));requestSpellRangeRender();
    if(valid){sendPatch(t.id,{spellRange:next},{spellRange:{...aimDrag.previous}});toast('锥形方向：'+spellDirectionLabel(next.direction));}
    else if(!cancelled)toast('🔒 回合已经变化，方向未修改');
    return true;
  }

  function encounter() {
    const e=state&&state.encounter&&typeof state.encounter==='object'?state.encounter:{playMode:'free',round:1,currentEntryId:null,entries:[],turnSerial:1,turnPath:{mapId:null,tokenId:null,points:[],segmentEnds:[]}};
    if(e.playMode==='turn'&&(!Array.isArray(e.entries)||!e.entries.length)){e.playMode='prepare';e.currentEntryId=null;e.round=1;e.turnPath={mapId:null,tokenId:null,points:[],segmentEnds:[]};}
    if(!e.turnPath||typeof e.turnPath!=='object')e.turnPath={mapId:null,tokenId:null,points:[],segmentEnds:[]};
    if(!Array.isArray(e.turnPath.points))e.turnPath.points=[];
    e.turnPath.segmentEnds=normalizeTurnPathSegmentEnds(e.turnPath.segmentEnds,e.turnPath.points.length);
    return e;
  }
  function tokenControlGroup(token) {
    if (!currentMap || !token) return new Set();
    const ids=new Set([token.id,SundollSize.anchor(token,currentMap).id]);
    if (token.mountId) ids.add(token.mountId);
    let changed=true;
    while(changed){ changed=false; (currentMap.tokens||[]).forEach(candidate=>{ if(candidate.mountId && ids.has(candidate.mountId) && !ids.has(candidate.id)){ids.add(candidate.id);changed=true;} }); }
    return ids;
  }
  function ridersOfToken(token,map=currentMap) {
    return map&&token ? (map.tokens||[]).filter(candidate=>candidate.mountId===token.id) : [];
  }
  function movementAnchor(token,map=currentMap) {
    if(!map||!token||!token.mountId)return token;
    const mount=(map.tokens||[]).find(candidate=>candidate.id===token.mountId);
    return SundollSize.anchor(token,map);
  }
  function syncMountedCoordinates(token,map=currentMap) {
    const anchor=movementAnchor(token,map);
    if(!map||!anchor)return anchor;
    SundollSize.repair(map);
    return anchor;
  }
  function currentTurnEntry() {
    const e=encounter();
    return (Array.isArray(e.entries)?e.entries:[]).find(x=>x&&x.id===e.currentEntryId)||null;
  }
  function currentTurnToken() {
    const entry=currentTurnEntry();
    return entry&&entry.tokenId ? (currentMap&&currentMap.tokens||[]).find(t=>t.id===entry.tokenId)||null : null;
  }
  function ownedToken(token) {
    if (!sessionToken || !myName || !token) return false;
    const directOwner=(token.ownerPlayerId||token.owner||'').trim(), player=myPlayerId;
    if(directOwner)return directOwner===player;
    if(!token)return false;
    return SundollSize.riders(token,currentMap).some(rider=>(rider.ownerPlayerId||rider.owner||'').trim()===player);
  }
  function controlsCurrentTurn(token){
    if(!token||!sessionToken||!myName)return false;
    const directOwner=(token.ownerPlayerId||token.owner||'').trim();
    return directOwner?directOwner===myPlayerId:ownedToken(token);
  }
  function canActWithToken(token) {
    if (!ownedToken(token)) return false;
    const e=encounter();
    if (e.playMode!=='turn') return true;
    const current=currentTurnToken();
    return !!current && controlsCurrentTurn(current) && tokenControlGroup(token).has(current.id);
  }
  function canMoveToken(token) { return canActWithToken(token); }
  function sameTurnPoint(...args) { return SundollRules.sameTurnPoint(...args); }
  function normalizeTurnPathSegmentEnds(...args) { return SundollRules.normalizeTurnPathSegmentEnds(...args); }
  function turnPathEdgeKey(...args) { return SundollRules.turnPathEdgeKey(...args); }
  function turnPathEdgeCounts(...args) { return SundollRules.turnPathEdgeCounts(...args); }
  function drawTurnPath(points, color, dashed, priorPoints=[]) {
    if (!Array.isArray(points)||points.length<2) return;
    turnPathCtx.save(); turnPathCtx.strokeStyle=color; turnPathCtx.fillStyle=color; turnPathCtx.lineCap='round'; turnPathCtx.lineJoin='round'; if(dashed)turnPathCtx.setLineDash([10,8]);
    const counts=turnPathEdgeCounts(priorPoints,points),drawn=new Set();for(let i=1;i<points.length;i++){const start=points[i-1],end=points[i];if(sameTurnPoint(start,end))continue;const key=turnPathEdgeKey(start,end);if(drawn.has(key))continue;drawn.add(key);turnPathCtx.lineWidth=4+Math.min(8,Math.max(0,(counts.get(key)||1)-1)*2);turnPathCtx.beginPath();turnPathCtx.moveTo(start.x,start.y);turnPathCtx.lineTo(end.x,end.y);turnPathCtx.stroke();}turnPathCtx.setLineDash([]);
    turnPathCtx.beginPath(); turnPathCtx.arc(points[0].x,points[0].y,6,0,Math.PI*2); turnPathCtx.fill(); const end=points[points.length-1]; turnPathCtx.globalAlpha=.9; turnPathCtx.beginPath(); turnPathCtx.arc(end.x,end.y,7,0,Math.PI*2); turnPathCtx.fill(); turnPathCtx.restore();
  }
  function measureGridFeet(...args) { return SundollRules.measureGridFeet(...args); }
  function renderTurnPath(draftPoints=null) {
    if(!currentMap)return;
    const e=encounter(), saved=e.playMode==='turn'&&e.turnPath&&e.turnPath.mapId===currentMap.id?e.turnPath.points:[];
    if(!(saved?.length||draftPoints?.length||(measureDraft&&measureDraft.mapId===currentMap.id))){
      if(turnPath.width!==1)turnPath.width=1;if(turnPath.height!==1)turnPath.height=1;$('#measure-label').hidden=true;return;
    }
    if(turnPath.width!==currentMap.mapW)turnPath.width=currentMap.mapW;
    if(turnPath.height!==currentMap.mapH)turnPath.height=currentMap.mapH;
    turnPathCtx.clearRect(0,0,currentMap.mapW,currentMap.mapH);
    drawTurnPath(saved,'rgba(224,179,76,.82)',false); if(Array.isArray(draftPoints))drawTurnPath(draftPoints,'rgba(255,232,145,.95)',true,saved);
    if(measureDraft&&measureDraft.mapId===currentMap.id&&measureDraft.from&&measureDraft.to){
      turnPathCtx.save(); turnPathCtx.strokeStyle='rgba(126,205,255,.96)'; turnPathCtx.lineWidth=4; turnPathCtx.setLineDash([12,8]); turnPathCtx.beginPath(); turnPathCtx.moveTo(measureDraft.from.x,measureDraft.from.y); turnPathCtx.lineTo(measureDraft.to.x,measureDraft.to.y); turnPathCtx.stroke(); turnPathCtx.setLineDash([]); turnPathCtx.fillStyle='#7ecfff'; [measureDraft.from,measureDraft.to].forEach(p=>{turnPathCtx.beginPath();turnPathCtx.arc(p.x,p.y,6,0,Math.PI*2);turnPathCtx.fill();}); turnPathCtx.restore();
      const mid={x:(measureDraft.from.x+measureDraft.to.x)/2,y:(measureDraft.from.y+measureDraft.to.y)/2}, feet=measureGridFeet(measureDraft.from,measureDraft.to,currentMap.gridSize), rounded=Math.round(feet*10)/10; const label=$('#measure-label'); label.hidden=false; label.textContent=(Number.isInteger(rounded)?rounded:rounded.toFixed(1))+' 尺'; label.style.left=(mid.x*view.scale+view.ox)+'px'; label.style.top=(mid.y*view.scale+view.oy)+'px';
    } else $('#measure-label').hidden=true;
  }
  function updateToolButtons(){
    document.querySelectorAll('#btn-measure,#dock-measure').forEach(el=>el.classList.toggle('active',measureMode));
    document.querySelectorAll('[data-doodle-tool]').forEach(el=>el.classList.toggle('active',el.dataset.doodleTool===doodleTool));
    $('#btn-ready').textContent=presenceStatus==='ready'?'取消准备':'✓ 准备';$('#dock-ready').textContent=presenceStatus==='ready'?'取消准备':'✓ 准备';
    board.style.cursor=measureMode||doodleTool?'crosshair':'';
  }
  function toggleMeasure(){
    measureMode=!measureMode;if(measureMode){cancelMapReaction();cancelSpellAim();doodleTool=null;doodleDraft=null;renderDoodles();}else measureDraft=null;updateToolButtons();renderTurnPath();
  }
  function toggleDoodleTool(tool){
    const allowed=['pen','line','arrow','circle','eraser'];if(!allowed.includes(tool))return;doodleTool=doodleTool===tool?null:tool;doodleDraft=null;
    if(doodleTool){cancelMapReaction();cancelSpellAim();measureMode=false;measureDraft=null;renderTurnPath();hideTokenPeek();}renderDoodles();updateToolButtons();
  }
  function updateEndTurnUi(){
    const e=encounter(), entry=currentTurnEntry(), current=currentTurnToken(), ownsCurrent=!!sessionToken&&e.playMode==='turn'&&!!current&&canActWithToken(current), anchor=ownsCurrent?movementAnchor(current,currentMap):null;
    const path=e.turnPath&&anchor&&e.turnPath.mapId===currentMap?.id&&e.turnPath.tokenId===anchor.id&&Array.isArray(e.turnPath.points)?e.turnPath.points:[], canChangePath=ownsCurrent&&path.length>1&&!turnPathActionPending&&!endTurnPending, status=$('#turn-action-status'), actions=$('#turn-path-actions');
    if(actions)actions.hidden=!ownsCurrent;
    const undo=$('#turn-path-undo'),reset=$('#turn-path-reset');
    if(undo){undo.disabled=!canChangePath;undo.title=path.length>1?'撤销上一次完整拖动':'移动后可以撤销上一次拖动';}
    if(reset){reset.disabled=!canChangePath;reset.title=path.length>1?'回到本回合开始时的位置':'移动后可以重置路径';}
    const can=ownsCurrent&&!endTurnPending&&!turnPathActionPending;
    document.querySelectorAll('#end-turn').forEach(b=>{b.disabled=!can;b.title=endTurnPending?'正在结束回合':turnPathActionPending?'正在修改路径':can?'结束当前角色回合':e.playMode==='turn'?'还没有轮到你的角色':e.playMode==='prepare'?'战斗尚未开始':'自由模式没有回合结束操作';});
    status.className='';
    if(!sessionToken){status.textContent='尚未加入房间';}
    else if(e.playMode==='prepare'){status.classList.add('prepare');status.textContent='战斗准备 · 同先攻玩家可换位';}
    else if(e.playMode!=='turn'){status.classList.add('free');status.textContent='自由行动 · 可操控自己的棋子';}
    else if(ownsCurrent){status.classList.add('mine');status.textContent=(endTurnPending?'… 正在结束 · ':turnPathActionPending?'… 正在修改路径 · ':'✓ 你的回合 · ')+(entry&&entry.name||current.name||'当前角色');}
    else {status.classList.add('locked');status.textContent='🔒 等待 '+(entry&&entry.name||'主控台关联当前角色');}
  }

  function decrementCurrentTokenConditions(){
    const token=currentTurnToken();if(!token||!currentMap)return;
    const groupIds=tokenControlGroup(token);
    (currentMap.tokens||[]).forEach(member=>{
      if(!groupIds.has(member.id)||!Array.isArray(member.conditions))return;
      member.conditions=member.conditions.flatMap(condition=>{
        const raw=condition&&condition.remainingTurns,turns=Number(raw);
        if(raw==null||!Number.isFinite(turns)||turns<=0)return [condition];
        const remaining=Math.max(0,Math.trunc(turns)-1);
        return remaining?[Object.assign({},condition,{remainingTurns:remaining})]:[];
      });
    });
  }

  function recordTurnDragPoint(move, point, gridSize, snapEnabled=true, rawPoint=point) {
    if(!move||!Array.isArray(move.pathPoints)||!point)return false;
    const x=Number(point.x),y=Number(point.y),points=move.pathPoints;if(!Number.isFinite(x)||!Number.isFinite(y))return false;
    const candidate={x,y},last=points[points.length-1],grid=Math.max(1,Number(gridSize)||50),threshold=snapEnabled?.01:Math.max(3,grid*.08),rawX=Number(rawPoint&&rawPoint.x),rawY=Number(rawPoint&&rawPoint.y);
    const diagonalGestureFrom=origin=>{if(!origin||!Number.isFinite(rawX)||!Number.isFinite(rawY))return false;const dx=Math.abs(rawX-Number(origin.x)),dy=Math.abs(rawY-Number(origin.y)),major=Math.max(dx,dy);return major>=grid*.25&&Math.min(dx,dy)/major>=TURN_DIAGONAL_INTENT_RATIO;};
    if(last&&Math.hypot(x-last.x,y-last.y)<threshold){const intent=move.diagonalCornerIntent;if(intent&&intent.eligible&&Math.abs(last.x-intent.cornerX)<.01&&Math.abs(last.y-intent.cornerY)<.01&&!diagonalGestureFrom({x:intent.startX,y:intent.startY}))intent.eligible=false;return false;}
    const backtrackThreshold=snapEnabled?.01:Math.max(5,grid*.12);for(let i=points.length-2;i>=0;i--){if(Math.hypot(candidate.x-points[i].x,candidate.y-points[i].y)>backtrackThreshold)continue;points.splice(i+1);if(!snapEnabled)points[i]=candidate;move.diagonalCornerIntent=null;return true;}
    if(snapEnabled&&points.length>=2){
      const start=points[points.length-2],corner=last,step=v=>v>=TURN_DIAGONAL_MIN_STEP&&v<=TURN_DIAGONAL_MAX_STEP,zero=v=>v<=(1-TURN_DIAGONAL_MIN_STEP);
      const ax=Math.abs(corner.x-start.x)/grid,ay=Math.abs(corner.y-start.y)/grid,bx=Math.abs(candidate.x-corner.x)/grid,by=Math.abs(candidate.y-corner.y)/grid,dx=Math.abs(candidate.x-start.x)/grid,dy=Math.abs(candidate.y-start.y)/grid;
      const firstHorizontal=step(ax)&&zero(ay),firstVertical=step(ay)&&zero(ax),secondHorizontal=step(bx)&&zero(by),secondVertical=step(by)&&zero(bx),intent=move.diagonalCornerIntent,directDiagonal=intent&&intent.eligible&&Math.abs(start.x-intent.startX)<.01&&Math.abs(start.y-intent.startY)<.01&&Math.abs(corner.x-intent.cornerX)<.01&&Math.abs(corner.y-intent.cornerY)<.01&&diagonalGestureFrom(start);
      if(step(dx)&&step(dy)&&directDiagonal&&((firstHorizontal&&secondVertical)||(firstVertical&&secondHorizontal))){points[points.length - 1] = candidate;move.diagonalCornerIntent=null;return true;}
    }
    points.push(candidate);
    if(snapEnabled&&last){const sx=Math.abs(candidate.x-last.x)/grid,sy=Math.abs(candidate.y-last.y)/grid,step=v=>v>=TURN_DIAGONAL_MIN_STEP&&v<=TURN_DIAGONAL_MAX_STEP,zero=v=>v<=(1-TURN_DIAGONAL_MIN_STEP);move.diagonalCornerIntent={startX:last.x,startY:last.y,cornerX:candidate.x,cornerY:candidate.y,eligible:((step(sx)&&zero(sy))||(step(sy)&&zero(sx)))&&diagonalGestureFrom(last)};}else move.diagonalCornerIntent=null;
    if(points.length>MAX_MOVE_POINTS)move.pathPoints=points.slice(0,MAX_MOVE_POINTS-1).concat(points[points.length-1]);return true;
  }
  function appendTurnPath(mapId, tokenId, points) {
    const e=encounter(); if(e.playMode!=='turn'||!mapId||!tokenId||!Array.isArray(points))return;
    const same=e.turnPath&&e.turnPath.mapId===mapId&&e.turnPath.tokenId===tokenId,previous=same&&Array.isArray(e.turnPath.points)?e.turnPath.points:[],previousEnds=same?normalizeTurnPathSegmentEnds(e.turnPath.segmentEnds,previous.length):[];
    const first=points.find(point=>point&&Number.isFinite(Number(point.x))&&Number.isFinite(Number(point.y))),continuous=!previous.length||(first&&sameTurnPoint(previous[previous.length-1],first));
    let combined=same&&continuous?previous.slice():[],segmentEnds=same&&continuous?previousEnds.slice():[];const previousLength=combined.length;
    points.slice(0,MAX_MOVE_POINTS).forEach(point=>{
      const x=Number(point&&point.x), y=Number(point&&point.y); if(!Number.isFinite(x)||!Number.isFinite(y))return;
      const last=combined[combined.length-1]; if(!last||Math.hypot(last.x-x,last.y-y)>=.01)combined.push({x,y});
    });
    if(combined.length>previousLength)segmentEnds.push(combined.length-1);if(combined.length>MAX_TURN_PATH_POINTS){combined=combined.slice(0,MAX_TURN_PATH_POINTS-1).concat(combined[combined.length-1]);segmentEnds=segmentEnds.filter(end=>end<MAX_TURN_PATH_POINTS-1);segmentEnds.push(MAX_TURN_PATH_POINTS-1);}e.turnPath={mapId:String(mapId),tokenId:String(tokenId),points:combined,segmentEnds:normalizeTurnPathSegmentEnds(segmentEnds,combined.length)};
  }

  async function runTurnPathAction(op){
    if(turnPathActionPending||endTurnPending||!['turnPathUndo','turnPathReset'].includes(op))return;
    const e=encounter(),current=currentTurnToken(),anchor=current&&movementAnchor(current,currentMap),path=e.turnPath;
    if(e.playMode!=='turn'||!current||!anchor||!canActWithToken(current)||!path||path.mapId!==currentMap?.id||path.tokenId!==anchor.id||!Array.isArray(path.points)||path.points.length<2){updateEndTurnUi();toast('当前没有可以修改的本回合路径');return;}
    turnPathActionPending=op;updateEndTurnUi();
    try{
      // 权限主体必须使用先攻中有归属的角色；服务器会再把骑手映射到实际移动的坐骑。
      const result=await requestAction({op,mapId:currentMap.id,tokenId:current.id,playMode:'turn',turnSerial:Number(e.turnSerial)||1}),data=result.data||{};
      if(!result.ok||data.ok===false)toast('⚠ '+(data.error||'路径修改失败'));
      await syncRoomState();
    }catch(error){toast('⚠ 路径修改未送达');await syncRoomState();}
    finally{turnPathActionPending=null;updateEndTurnUi();}
  }

  let lastMapPaintKey = '';
  function renderMap(m) {
    const paintKey=JSON.stringify([m.id,m.mapW,m.mapH,m.mapData,m.gridSize,m.gridVisible,state?.showGrid,m.gridLineWidth,m.gridOffsetX,m.gridOffsetY]);
    if(paintKey===lastMapPaintKey)return;
    lastMapPaintKey=paintKey;
    const g=m.gridSize||50,hasMap=!!m.mapData,mapUrl=mapDisplayUrl(m.mapData);
    const showGrid=typeof m.gridVisible==='boolean'?m.gridVisible:state?.showGrid!==false;
    const lw=Math.max(.5,Math.min(8,Number(m.gridLineWidth)||2));
    const grid='repeating-linear-gradient(to right,rgba(255,255,255,.78) 0,rgba(255,255,255,.78) '+lw+'px,transparent '+lw+'px,transparent '+g+'px),repeating-linear-gradient(to bottom,rgba(255,255,255,.78) 0,rgba(255,255,255,.78) '+lw+'px,transparent '+lw+'px,transparent '+g+'px),repeating-linear-gradient(to right,rgba(0,0,0,.16) 0,rgba(0,0,0,.16) '+lw+'px,transparent '+lw+'px,transparent '+g+'px),repeating-linear-gradient(to bottom,rgba(0,0,0,.16) 0,rgba(0,0,0,.16) '+lw+'px,transparent '+lw+'px,transparent '+g+'px)';
    world.style.width=m.mapW+'px'; world.style.height=m.mapH+'px';
    world.style.backgroundColor=hasMap?'transparent':showGrid?'#ddd6c2':'#0f1116';
    world.style.backgroundImage=hasMap?(showGrid?grid+',url("'+mapUrl+'")':'url("'+mapUrl+'")'):(showGrid?grid:'none');
    world.style.backgroundSize=hasMap?(showGrid?g+'px '+g+'px,'+g+'px '+g+'px,'+g+'px '+g+'px,'+g+'px '+g+'px,100% 100%':'100% 100%'):(showGrid?g+'px '+g+'px,'+g+'px '+g+'px,'+g+'px '+g+'px,'+g+'px '+g+'px':'');
    world.style.backgroundRepeat=showGrid?(hasMap?'repeat,repeat,repeat,repeat,no-repeat':'repeat'):'no-repeat';
    const gridPos=(Number(m.gridOffsetX)||0)+'px '+(Number(m.gridOffsetY)||0)+'px';
    world.style.backgroundPosition=showGrid?[gridPos,gridPos,gridPos,gridPos,'0 0'].join(','):'0 0';
  }
  function mapDisplayUrl(value) {
    const source=String(value||'');
    return /^\/api\/module-assets\/[0-9a-f]{64}$/.test(source)&&!mapVariantFailures.has(source)?source+'?variant=map':source;
  }
  function normalizedMapPreloadUrl(value) {
    const source=String(value||'');
    if(!/^\/api\/(?:module-assets|assets)\/[0-9a-f]{64}$/.test(source))return'';
    try{return new URL(mapDisplayUrl(source),location.href).href;}catch(error){return'';}
  }
  function loadPlayerMapAsset(url,priority='low',signal) {
    let job=mapAssetLoads.get(url);
    if(job){if(priority==='high'){job.priority='high';job.image.fetchPriority='high';}return job.promise;}
    const image=new Image();image.decoding='async';image.fetchPriority=priority;
    job={image,priority,promise:null};
    job.promise=new Promise((resolve,reject)=>{
      const finish=(error)=>{image.onload=image.onerror=null;signal?.removeEventListener('abort',abort);if(error){mapAssetLoads.delete(url);reject(error);}else resolve(url);};
      const abort=()=>{if(job.priority==='high')return;image.src='';finish(Object.assign(new Error('地图预加载已暂停'),{name:'AbortError'}));};
      image.onload=()=>finish();image.onerror=()=>finish(new Error('地图图片加载失败'));
      signal?.addEventListener('abort',abort,{once:true});image.src=url;
    });
    mapAssetLoads.set(url,job);
    // Keep decoded image requests reusable without retaining every visited map.
    if(mapAssetLoads.size>6){for(const key of mapAssetLoads.keys()){if(key!==url&&!key.includes(activeMapAssetSource)){mapAssetLoads.delete(key);break;}}}
    return job.promise;
  }
  function watchCurrentMapAsset(value) {
    const source=String(value||'');if(activeMapAssetSource===source)return;
    activeMapAssetSource=source;activeMapAssetReady=!source;
    if(!source){scheduleNextMapPreload();return;}
    const candidate=mapDisplayUrl(source),url=new URL(candidate,location.href).href;
    if(mapPreloadController&&mapPreloadActiveUrl!==url)mapPreloadController.abort();
    loadPlayerMapAsset(url,'high').catch(async error=>{
      if(activeMapAssetSource!==source)throw error;
      if(candidate===source)throw error;
      mapVariantFailures.add(source);
      if(currentMap?.mapData===source){lastMapPaintKey='';renderMap(currentMap);}
      return loadPlayerMapAsset(new URL(source,location.href).href,'high');
    }).then(()=>{if(activeMapAssetSource===source){activeMapAssetReady=true;scheduleNextMapPreload();}}).catch(()=>{if(activeMapAssetSource===source){activeMapAssetSource='';activeMapAssetReady=false;}});
  }
  function playerMayPreloadMaps() {
    return !document.hidden && !navigator.connection?.saveData
      && !(Number(navigator.deviceMemory)>0 && Number(navigator.deviceMemory)<=4)
      && !['slow-2g','2g'].includes(navigator.connection?.effectiveType);
  }
  function scheduleNextMapPreload(delay=1500) {
    if(!activeMapAssetReady||!playerMayPreloadMaps())return;
    if(mapPreloadTimer||mapPreloadController||!mapPreloadQueue.length)return;
    mapPreloadTimer=setTimeout(()=>{mapPreloadTimer=null;preloadNextMapAsset();},delay);
  }
  async function preloadNextMapAsset() {
    if(mapPreloadController||!activeMapAssetReady||!playerMayPreloadMaps())return;
    const currentUrl=normalizedMapPreloadUrl(currentMap&&currentMap.mapData);
    let url='';
    while(mapPreloadQueue.length&&!url){
      const candidate=mapPreloadQueue.shift();mapPreloadQueued.delete(candidate);
      if(candidate===currentUrl)continue;
      if(!mapPreloadCached.has(candidate))url=candidate;
    }
    if(!url)return;
    const controller=new AbortController();mapPreloadController=controller;mapPreloadActiveUrl=url;
    try{
      await loadPlayerMapAsset(url,'low',controller.signal);
      mapPreloadCached.add(url);mapPreloadAttempts.delete(url);
      if(mapPreloadCached.size>32)mapPreloadCached.delete(mapPreloadCached.values().next().value);
    }catch(error){
      if(error&&error.name!=='AbortError'){
        const attempts=(mapPreloadAttempts.get(url)||0)+1;mapPreloadAttempts.set(url,attempts);
        if(attempts<2&&!mapPreloadQueued.has(url)){mapPreloadQueued.add(url);mapPreloadQueue.push(url);}
      }
    }finally{
      if(mapPreloadController===controller)mapPreloadController=null;
      if(mapPreloadActiveUrl===url)mapPreloadActiveUrl='';
      scheduleNextMapPreload();
    }
  }
  function queueMapAssetPreloads(values,activeMapData) {
    // Only preload published candidates, after the visible map has finished.
    mapPreloadQueue=[];mapPreloadQueued.clear();watchCurrentMapAsset(activeMapData);
    if(!playerMayPreloadMaps())return;
    const activeUrl=normalizedMapPreloadUrl(activeMapData);
    (Array.isArray(values)?values:[]).forEach(value=>{
      const url=normalizedMapPreloadUrl(value);
      if(mapPreloadQueue.length>=2||!url||url===activeUrl||mapPreloadCached.has(url)||mapPreloadQueued.has(url)||url===mapPreloadActiveUrl)return;
      mapPreloadQueued.add(url);mapPreloadQueue.push(url);
    });
    scheduleNextMapPreload(2000);
  }
  function cloneDoodleStroke(stroke) {
    if(!stroke||typeof stroke!=='object')return null;
    const copy={...stroke};
    if(Array.isArray(stroke.points))copy.points=stroke.points.map(p=>({x:Number(p.x),y:Number(p.y)}));
    return copy;
  }
  function newDoodleId() {
    if(window.crypto&&typeof window.crypto.randomUUID==='function')return 'p-'+window.crypto.randomUUID();
    return 'p-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
  }
  function doodleMap(mapId) { return state&&(state.maps||[]).find(m=>m.id===mapId)||null; }
  function boundedDoodlePoint(raw,map=currentMap) {
    if(!map||!raw)return null;
    const x=Number(raw.x),y=Number(raw.y);if(!Number.isFinite(x)||!Number.isFinite(y))return null;
    return{x:clamp(x,0,Number(map.mapW)||0),y:clamp(y,0,Number(map.mapH)||0)};
  }
  function drawStroke(g,s) {
    if(!s)return;
    const width=Number(s.width)||5,color=/^#[0-9a-f]{6}$/i.test(s.color||'')?s.color:'#ff4d4f';
    g.save();g.strokeStyle=color;g.fillStyle=color;g.lineWidth=width;g.lineCap='round';g.lineJoin='round';
    if(s.tool==='pen'){
      if(!Array.isArray(s.points)||s.points.length<2){g.restore();return;}
      g.beginPath();g.moveTo(s.points[0].x,s.points[0].y);s.points.slice(1).forEach(p=>g.lineTo(p.x,p.y));g.stroke();g.restore();return;
    }
    if(s.tool==='circle'){
      const r=Math.hypot(s.x1-s.x0,s.y1-s.y0);g.beginPath();g.arc(s.x0,s.y0,r,0,Math.PI*2);g.globalAlpha=.15;g.fill();g.globalAlpha=1;g.stroke();g.restore();return;
    }
    if(s.tool==='line'||s.tool==='arrow'){
      g.beginPath();g.moveTo(s.x0,s.y0);g.lineTo(s.x1,s.y1);g.stroke();
      if(s.tool==='arrow'){
        const a=Math.atan2(s.y1-s.y0,s.x1-s.x0),h=Math.max(10,width*2.2);g.beginPath();g.moveTo(s.x1,s.y1);g.lineTo(s.x1-h*Math.cos(a-Math.PI/6),s.y1-h*Math.sin(a-Math.PI/6));g.lineTo(s.x1-h*Math.cos(a+Math.PI/6),s.y1-h*Math.sin(a+Math.PI/6));g.closePath();g.fill();
      }
    }
    g.restore();
  }
  let lastDoodlePaintKey='';
  function renderDoodles() {
    if(!currentMap)return;
    const paintKey=JSON.stringify([currentMap.id,currentMap.mapW,currentMap.mapH,currentMap.doodles||[],doodleDraft]);
    if(paintKey===lastDoodlePaintKey)return;
    lastDoodlePaintKey=paintKey;
    const hasStrokes=!!((currentMap.doodles||[]).length||doodleDraft);
    if(!hasStrokes){
      // 空白层无需分配地图尺寸的 RGBA 位图。
      doodle.width=1;doodle.height=1;
      $('#player-doodle-count').textContent='0 条';$('#player-doodle-undo').disabled=true;$('#player-doodle-clear').disabled=true;
      return;
    }
    if(doodle.width!==currentMap.mapW)doodle.width=currentMap.mapW;if(doodle.height!==currentMap.mapH)doodle.height=currentMap.mapH;doodleCtx.clearRect(0,0,doodle.width,doodle.height);
    if(!Array.isArray(currentMap.doodles))currentMap.doodles=[];
    const count=currentMap.doodles.length;$('#player-doodle-count').textContent=count+' 条';$('#player-doodle-undo').disabled=count===0;$('#player-doodle-clear').disabled=count===0;
    currentMap.doodles.forEach(s=>drawStroke(doodleCtx,s));if(doodleDraft)drawStroke(doodleCtx,doodleDraft);
  }
  function startDoodleAt(raw) {
    const p=boundedDoodlePoint(raw);if(!p||!doodleTool||doodleTool==='eraser')return;
    doodleDraft=doodleTool==='pen'?{tool:'pen',color:doodleColor,width:doodleWidth,points:[p]}:{tool:doodleTool,color:doodleColor,width:doodleWidth,x0:p.x,y0:p.y,x1:p.x,y1:p.y};renderDoodles();
  }
  function continueDoodleAt(raw) {
    if(!doodleDraft)return;const p=boundedDoodlePoint(raw);if(!p)return;
    if(doodleDraft.tool==='pen'){
      const points=doodleDraft.points,last=points[points.length-1],dx=p.x-last.x,dy=p.y-last.y,dist=Math.hypot(dx,dy),count=Math.min(MAX_DOODLE_POINTS-points.length,Math.max(1,Math.ceil(dist/6)));
      for(let i=1;i<=count;i++)points.push({x:last.x+dx*i/count,y:last.y+dy*i/count});
    }else{doodleDraft.x1=p.x;doodleDraft.y1=p.y;}
    renderDoodles();
  }
  async function reconcileDoodles(mapId) {
    try{
      const res=await fetch('/api/state');if(!res.ok)return false;const snapshot=await res.json(),remote=(snapshot.maps||[]).find(m=>m.id===mapId),local=doodleMap(mapId);if(!remote||!local||!Array.isArray(remote.doodles))return false;
      local.doodles=remote.doodles.map(cloneDoodleStroke).filter(Boolean);if(currentMap&&currentMap.id===mapId)renderDoodles();return true;
    }catch(e){return false;}
  }
  function rollbackDoodleAdd(mapId,doodleId) {
    const map=doodleMap(mapId);if(!map)return;map.doodles=(map.doodles||[]).filter(s=>s&&s.id!==doodleId);if(currentMap&&currentMap.id===mapId)renderDoodles();
  }
  function restoreDeletedDoodle(mapId,stroke,index) {
    const map=doodleMap(mapId);if(!map||!stroke||(map.doodles||[]).some(s=>s&&s.id===stroke.id))return;if(!Array.isArray(map.doodles))map.doodles=[];map.doodles.splice(clamp(index,0,map.doodles.length),0,cloneDoodleStroke(stroke));if(currentMap&&currentMap.id===mapId)renderDoodles();
  }
  function endDoodle() {
    if(!doodleDraft)return;const map=currentMap,draft=doodleDraft;doodleDraft=null;if(!map){renderDoodles();return;}
    const pen=draft.tool==='pen',short=!pen&&Math.hypot(draft.x1-draft.x0,draft.y1-draft.y0)<=4;if((pen&&draft.points.length<2)||(!pen&&short)){renderDoodles();return;}
    const stroke={...draft,id:newDoodleId(),author:myName||'玩家'};if(Array.isArray(draft.points))stroke.points=draft.points.slice(0,MAX_DOODLE_POINTS).map(p=>({...p}));if(!Array.isArray(map.doodles))map.doodles=[];map.doodles.push(stroke);renderDoodles();
    requestAction({op:'doodleAdd',mapId:map.id,stroke:cloneDoodleStroke(stroke)}).then(result=>{const data=result.data||{};if(!result.ok||data.ok===false){rollbackDoodleAdd(map.id,stroke.id);toast('⚠ '+(data.error||'标注未送达'));}}).catch(async()=>{if(!(await reconcileDoodles(map.id)))rollbackDoodleAdd(map.id,stroke.id);toast('⚠ 标注同步中断，已重新核对');});
  }
  function distToDoodleSegment(px,py,a,b) { const dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy;let t=len2?((px-a.x)*dx+(py-a.y)*dy)/len2:0;t=clamp(t,0,1);return Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy)); }
  function doodleHitTest(raw) {
    const p=boundedDoodlePoint(raw);if(!p||!currentMap)return null;const strokes=currentMap.doodles||[];
    for(let i=strokes.length-1;i>=0;i--){const s=strokes[i],tol=Math.max(10,(Number(s.width)||5)+6);if(s.tool==='pen'&&Array.isArray(s.points)){for(let j=1;j<s.points.length;j++)if(distToDoodleSegment(p.x,p.y,s.points[j-1],s.points[j])<=tol)return s;}else if(s.tool==='line'||s.tool==='arrow'){if(distToDoodleSegment(p.x,p.y,{x:s.x0,y:s.y0},{x:s.x1,y:s.y1})<=tol)return s;}else if(s.tool==='circle'){const r=Math.hypot(s.x1-s.x0,s.y1-s.y0);if(Math.abs(Math.hypot(p.x-s.x0,p.y-s.y0)-r)<=tol)return s;}}
    return null;
  }
  function deleteSharedDoodle(stroke) {
    const map=currentMap;if(!map||!stroke||!stroke.id)return false;const index=(map.doodles||[]).findIndex(s=>s&&s.id===stroke.id);if(index<0)return false;const snapshot=cloneDoodleStroke(map.doodles[index]);map.doodles.splice(index,1);renderDoodles();
    requestAction({op:'doodleDelete',mapId:map.id,doodleId:stroke.id}).then(result=>{const data=result.data||{};if(!result.ok||data.ok===false){restoreDeletedDoodle(map.id,snapshot,index);toast('⚠ '+(data.error||'擦除未送达'));}}).catch(async()=>{if(!(await reconcileDoodles(map.id)))restoreDeletedDoodle(map.id,snapshot,index);toast('⚠ 擦除同步中断，已重新核对');});return true;
  }
  function eraseDoodleAt(raw,erased) { const stroke=doodleHitTest(raw);if(!stroke||(erased&&erased.has(stroke.id)))return false;if(erased)erased.add(stroke.id);return deleteSharedDoodle(stroke); }
  function undoSharedDoodle() { const strokes=currentMap&&currentMap.doodles||[];if(!strokes.length){toast('没有可以撤销的标注');return;}deleteSharedDoodle(strokes[strokes.length-1]); }
  function clearSharedDoodles() {
    const map=currentMap;if(!map||!(map.doodles||[]).length){toast('当前地图没有标注');return;}const previous=map.doodles.map(cloneDoodleStroke).filter(Boolean);map.doodles=[];renderDoodles();
    const restore=()=>{const local=doodleMap(map.id);if(!local)return;const current=local.doodles||[],ids=new Set(current.map(s=>s&&s.id));local.doodles=previous.filter(s=>!ids.has(s.id)).concat(current);if(currentMap&&currentMap.id===map.id)renderDoodles();};
    requestAction({op:'doodleClear',mapId:map.id}).then(result=>{const data=result.data||{};if(!result.ok||data.ok===false){restore();toast('⚠ '+(data.error||'清空未送达'));}else toast('已一键清空共享标注');}).catch(async()=>{if(!(await reconcileDoodles(map.id)))restore();toast('⚠ 清空同步中断，已重新核对');});
  }
  function tokenNameGap(size) { return size*.38+3; }
  function tokenLabelPositions(t,m) {
    const size=(m.gridSize||50)*(t.size||1), out=[], riders=SundollSize.riders(t,m);
    if(riders.length){
      out.push({id:t.id,text:t.name,x:t.x,y:t.y+size/2+4,below:true});
      riders.forEach((r,i)=>{let ox=0;if(riders.length>1)ox=(i-(riders.length-1)/2)*size*.34;out.push({id:r.id,text:r.name,x:t.x+ox,y:t.y-(size*.38+7),below:false});});
    }else out.push({id:t.id,text:t.name,x:t.x,y:t.y-tokenNameGap(size),below:false});
    return out;
  }
  function renderNamesLayer(m) {
    const layer=$('#names-layer');
    const signature=JSON.stringify([m.id,m.gridSize,state.showNames,myName,myPlayerId,(m.tokens||[]).map(t=>[t.id,t.name,t.x,t.y,t.size,t.mountId,t.hp,t.hpMax,t.tempHp,t.tempHpMax,t.type,t.owner,t.ownerPlayerId])]);
    if(layer.dataset.renderSignature===signature)return;
    layer.dataset.renderSignature=signature;layer.innerHTML='';
    if(!state.showNames)return;
    const mountIds=new Set((m.tokens||[]).map(t=>t.id));
    (m.tokens||[]).forEach(t=>{
      if(t.mountId&&mountIds.has(t.mountId))return;
      tokenLabelPositions(t,m).forEach(p=>{
        const labelToken=(m.tokens||[]).find(candidate=>candidate.id===p.id)||t, label=document.createElement('div'), name=document.createElement('span');
        label.className='token-name-label'+(p.below?' below':''); label.dataset.id=p.id; name.className='token-name-text'; name.textContent=p.text; label.appendChild(name);
        label.style.left=p.x+'px'; label.style.top=p.y+'px'; label.style.fontSize=Math.max(7,(m.gridSize||50)*(t.size||1)*.15)+'px';
        if(friendly(labelToken)&&Number.isFinite(Number(labelToken.hp))&&Number.isFinite(Number(labelToken.hpMax))){
          const pct=clamp(Number(labelToken.hp)/Math.max(1,Number(labelToken.hpMax))*100,0,100), bar=document.createElement('span'), fill=document.createElement('i');
          bar.className='token-name-hp'; bar.style.width=Math.max(28,Math.min(56,(m.gridSize||50)*(labelToken.size||1)*.68))+'px'; bar.title=labelToken.hp+' / '+labelToken.hpMax;
          fill.style.width=pct+'%'; fill.style.background=pct>50?'#4cc38a':pct>25?'#f4a261':'#e74c5e'; bar.appendChild(fill); label.appendChild(bar);
          if(Number(labelToken.tempHp)>0){const extra=bar.cloneNode(true);extra.title='临时生命值 '+labelToken.tempHp;extra.firstChild.style.width=clamp(Number(labelToken.tempHp)/Math.max(1,Number(labelToken.tempHpMax ?? labelToken.tempHp))*100,0,100)+'%';extra.firstChild.style.background='#a8e6b0';label.appendChild(extra);}
        }
        layer.appendChild(label);
      });
    });
  }
  function syncLabelsFor(t) {
    if(!currentMap||!state.showNames)return;
    const layer=$('#names-layer');
    const anchor=movementAnchor(t,currentMap);
    tokenLabelPositions(anchor,currentMap).forEach(p=>{const label=layer.querySelector('.token-name-label[data-id="'+p.id+'"]');if(label){label.style.left=p.x+'px';label.style.top=p.y+'px';}});
  }
  function appendConditionBadges(container,rawConditions) {
    const conditions=(Array.isArray(rawConditions)?rawConditions:[]).filter(condition=>condition.visibility!=='gm');
    if(!conditions.length)return;
    const badges=document.createElement('div');badges.className='token-condition-badges';
    conditions.slice(0,3).forEach(condition=>{const badge=document.createElement('span');badge.className='token-condition-badge';badge.style.setProperty('--condition-color',condition.color||'#a8b3c7');if(CONDITION_PIXEL_KEYS.has(condition.key)){ensureConditionPixels();badge.dataset.conditionIcon=condition.key;}badge.textContent=condition.icon||'◆';badge.title=(condition.label||'状态')+(condition.remainingTurns?' · 剩余 '+condition.remainingTurns+' 回合':'');badges.appendChild(badge);});
    if(conditions.length>3){const more=document.createElement('span');more.className='token-condition-badge more';more.textContent='+'+(conditions.length-3);more.title='另有 '+(conditions.length-3)+' 个状态';badges.appendChild(more);}
    container.appendChild(badges);
  }
  function renderTokens(m) {
    if(typeof window!=='undefined')window.MapItems?.refresh().catch(()=>{});
    if(typeof window!=='undefined')window.TravelBasket?.changed();
    SundollSize.repair(m);
    const box=$('#tokens'),existing=new Map(Array.from(box.children,el=>[el.dataset.id,el])),keep=new Set();
    const mountIds=new Set((m.tokens||[]).map(t=>t.id));
    const current=currentTurnToken();
    (m.tokens||[]).forEach(t=>{if(t.mountId&&mountIds.has(t.mountId))syncMountedCoordinates(t,m);});
    (m.tokens||[]).forEach(t=>{
      if (t.mountId && mountIds.has(t.mountId)) return;
      const size=(m.gridSize||50)*(t.size||1), meta=TYPE[t.type]||TYPE.npc, owned=ownedToken(t), movable=canMoveToken(t), isCurrent=!!current&&tokenControlGroup(t).has(current.id);
      const signature=JSON.stringify([t,ridersOfToken(t,m),size,owned,movable,isCurrent,current?.id,myPlayerId,myName]);
      const previous=existing.get(String(t.id));keep.add(String(t.id));
      if(previous&&previous.dataset.renderSignature===signature){return;}
      const el=document.createElement('div');
      el.dataset.renderSignature=signature;
      el.className='token'+(owned?' mine':'')+(owned&&!movable?' locked':'')+(isCurrent?' current-turn':''); el.dataset.id=t.id; el.style.left=t.x+'px'; el.style.top=t.y+'px'; el.style.width=size+'px'; el.style.height=size+'px';el.style.setProperty('--ring',meta.ring);
      el.title=owned&&!movable&&encounter().playMode==='turn'?'尚未轮到该角色':movable?'拖动以移动本回合角色':'';
      const circle=document.createElement('div'); circle.className='circle'; circle.style.setProperty('--ring',meta.ring);
      if (!applyPlayerPortrait(circle,t)) circle.textContent=t.icon||'?';
      el.append(circle);
      appendConditionBadges(el,t.conditions);
      const riders=SundollSize.riders(t,m);
      if(riders.length){
        riders.forEach((r,i)=>{
          const rMeta=TYPE[r.type]||TYPE.npc, rs=size*.4, rd=document.createElement('div');
          rd.className='rider'+(mine(r)?' owned':'')+(current&&current.id===r.id?' current-rider':'');
          rd.dataset.id=r.id; rd.dataset.mountId=t.id;
          const publicConditions=(r.conditions||[]).filter(c=>c.visibility!=='gm').map(c=>c.label||'状态').filter(Boolean);
          rd.title=r.name+(publicConditions.length?' · '+publicConditions.join('、'):'');
          rd.setAttribute('aria-label',r.name||'骑手');
          rd.style.width=rs+'px'; rd.style.height=rs+'px'; rd.style.setProperty('--ring',rMeta.ring);
          const ox=(i%2===0?1:-1)*size*.22, oy=(i%2===0?-1:1)*size*.22;
          rd.style.left=(size/2+ox-rs/2)+'px'; rd.style.top=(size/2+oy-rs/2)+'px';
          if(!applyPlayerPortrait(rd,r)){rd.textContent=r.icon||'?';rd.style.fontSize=(rs*.45)+'px';}
          appendConditionBadges(rd,r.conditions);
          el.appendChild(rd);
        });
      }
      if(previous)previous.replaceWith(el);else box.appendChild(el);
    });
    existing.forEach((el,id)=>{if(!keep.has(id))el.remove();});
    const nodes=new Map(Array.from(box.children,el=>[el.dataset.id,el]));
    Array.from(keep).forEach((id,index)=>{const el=nodes.get(id);if(box.children[index]!==el)box.insertBefore(el,box.children[index]||null);});
    renderNamesLayer(m);
    updateEndTurnUi();
  }
  function renderLinks(list) { const box=$('#player-links'); box.innerHTML=''; (list||[]).forEach(l=>{ if (!l || !l.name || !/^https?:\/\//i.test(l.url)) return; const a=document.createElement('a'); a.href=l.url; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=l.name; box.appendChild(a); }); if(!box.children.length)box.innerHTML='<span class="hint">主控台尚未添加共享网站</span>'; }
  const FLOW_SEASONS=[{key:'spring',label:'春季',icon:'🌱',first:1,last:13},{key:'summer',label:'夏季',icon:'☀️',first:14,last:26},{key:'autumn',label:'秋季',icon:'🍂',first:27,last:39},{key:'winter',label:'冬季',icon:'❄️',first:40,last:52}];
  const FLOW_CLIMATES={temperate:{label:'温带',icon:'🌿',diurnalRange:5},cold:{label:'寒带',icon:'🧊',diurnalRange:6},tropical:{label:'热带',icon:'🌴',diurnalRange:3},arid:{label:'干旱',icon:'🏜️',diurnalRange:9},coastal:{label:'海洋',icon:'🌊',diurnalRange:3},highland:{label:'高山',icon:'⛰️',diurnalRange:7}};
  const FLOW_WEATHER={clear:{label:'晴朗',icon:'☀️'},cloudy:{label:'多云',icon:'☁️'},rain:{label:'降雨',icon:'🌧️'},storm:{label:'雷暴',icon:'⛈️'},fog:{label:'浓雾',icon:'🌫️'},snow:{label:'降雪',icon:'🌨️'},wind:{label:'强风',icon:'💨'},heat:{label:'酷热',icon:'🏜️'}};
  const FLOW_WINDS={calm:'无风',breeze:'微风',strong:'强风',gale:'烈风'};
  const FLOW_HOURLY_TEMP_CURVE=[-.60,-.72,-.82,-.90,-1,-.95,-.70,-.35,0,.25,.50,.70,.85,.95,1,.95,.80,.55,.25,0,-.15,-.30,-.42,-.52];
  function flowWeatherPresentation(raw,parts){const w=raw&&typeof raw==='object'?raw:{},climate=FLOW_CLIMATES[w.climate]||FLOW_CLIMATES.temperate,condition=FLOW_WEATHER[w.condition]||FLOW_WEATHER.clear,week=Number(parts&&parts.week)||1,hour=Math.max(0,Math.min(23,Math.trunc(Number(parts&&parts.hour)||0))),season=FLOW_SEASONS.find(s=>week>=s.first&&week<=s.last)||FLOW_SEASONS[0],baseTemperature=Number.isFinite(Number(w.temperature))?Math.round(Number(w.temperature)):18,temperature=Math.max(-100,Math.min(100,baseTemperature+Math.round(climate.diurnalRange*FLOW_HOURLY_TEMP_CURVE[hour]))),wind=FLOW_WINDS[w.wind]||FLOW_WINDS.breeze;return{icon:condition.icon,name:condition.label,compact:condition.icon+' '+condition.label+' · '+temperature+'°C',detail:climate.icon+' '+climate.label+' · '+season.icon+' '+season.label+' · '+temperature+'°C · '+wind};}
  function flowWorldParts(totalSeconds) {
    const total=Math.max(0,Math.floor(Number(totalSeconds)||0)), secondsPerDay=WORLD_MINUTES_PER_DAY*60, dayIndex=Math.floor(total/secondsPerDay), dayOfYear=dayIndex%(WORLD_DAYS_PER_WEEK*WORLD_WEEKS_PER_YEAR), inDay=total%secondsPerDay;
    return {year:Math.floor(dayIndex/(WORLD_DAYS_PER_WEEK*WORLD_WEEKS_PER_YEAR))+1,week:Math.floor(dayOfYear/WORLD_DAYS_PER_WEEK)+1,day:(dayOfYear%WORLD_DAYS_PER_WEEK)+1,hour:Math.floor(inDay/3600),minute:Math.floor((inDay%3600)/60),second:inDay%60};
  }
  function flowDateLabel(p) { return '第 '+p.year+' 年 · 第 '+p.week+' 周 · 第 '+p.day+' 天'; }
  function flowClockLabel(p) { return String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0')+':'+String(p.second).padStart(2,'0'); }
  function flowWorldTotal(e) {
    const w=e&&e.worldTime&&typeof e.worldTime==='object'?e.worldTime:{};
    if (!w.runningSince) return Math.max(0,Math.floor(Number(w.totalSeconds ?? (Number(w.totalMinutes)||0)*60)||0));
    const serverDeltaAtSnapshot=Math.max(0,(Number(flowClockAnchor.serverNow)||Date.now())-(Number(w.runningSince)||0));
    const localDelta=Math.max(0,performance.now()-flowClockAnchor.localNow);
    const rate=Number(w.rate)>0?Number(w.rate):1;
    // 快照到达时先用服务器锚点校准，再叠加本机经过时间，玩家端时钟才会持续前进。
    const elapsed=serverDeltaAtSnapshot+localDelta;
    return Math.max(0,Math.floor((Number(w.totalSeconds ?? (Number(w.totalMinutes)||0)*60)||0)+elapsed*rate/1000));
  }
  function flowEncounterMap(next){return(next&&next.maps||[]).find(map=>map.id===next.activeMapId)||(next&&next.maps||[])[0]||null;}
  function flowEntryToken(map,entry){return map&&entry&&entry.tokenId?(map.tokens||[]).find(token=>token.id===entry.tokenId)||null:null;}
  function flowEntryControllers(map,entry){
    const token=flowEntryToken(map,entry);if(!token)return[];
    const owner=String(token.ownerPlayerId||token.owner||'').trim();if(owner)return[owner];
    if(!token)return[];
    return[...new Set((map.tokens||[]).filter(candidate=>candidate.mountId===token.id).map(candidate=>String(candidate.ownerPlayerId||candidate.owner||'').trim()).filter(Boolean))];
  }
  function flowOwnsEntry(map,entry){return!!sessionToken&&!!myName&&flowEntryControllers(map,entry).includes(myPlayerId);}
  function sortFlowInitiativeEntries(e){
    if(!e||!Array.isArray(e.entries))return;
    e.entries.sort((a,b)=>{
      const valueDelta=(Number(b&&b.value)||0)-(Number(a&&a.value)||0);
      if(valueDelta)return valueDelta;
      const aOrder=Number.isFinite(Number(a&&a.order))?Number(a.order):0,bOrder=Number.isFinite(Number(b&&b.order))?Number(b.order):0;
      return aOrder-bOrder;
    });
  }
  function applyFlowInitiativeAction(e,action){
    if(!e||e.playMode!=='prepare'||!action||!Array.isArray(e.entries))return false;
    const serial=Math.max(1,Math.trunc(Number(action.turnSerial)||1)),nextSerial=Math.max(serial+1,Math.trunc(Number(action.nextTurnSerial)||(serial+1))),currentSerial=Math.max(1,Math.trunc(Number(e.turnSerial)||1));
    // 完整快照可能先于 SSE 到达；这时同一标准动作已经落地，不再重复交换。
    if(currentSerial===nextSerial)return true;
    if(currentSerial!==serial)return false;
    const entry=e.entries.find(item=>item&&item.id===action.entryId);
    if(!entry)return false;
    if(action.op==='initiativeSwap'){
      const target=e.entries.find(item=>item&&item.id===action.targetEntryId),entryOrder=Number(action.entryOrder),targetOrder=Number(action.targetOrder);
      if(!target||Number(entry.value)!==Number(target.value)||!Number.isFinite(entryOrder)||!Number.isFinite(targetOrder))return false;
      entry.order=entryOrder;target.order=targetOrder;
    }else return false;
    sortFlowInitiativeEntries(e);e.turnSerial=nextSerial;e.currentEntryId=null;e.turnPath={mapId:null,tokenId:null,points:[],segmentEnds:[]};
    return true;
  }
  function scrollFlowCurrentIntoView(list,e){
    const targetId=e.playMode==='turn'?e.currentEntryId:null;
    if(!targetId){const leftTurnMode=!!lastFlowScrollEntryId;lastFlowScrollEntryId=null;if(leftTurnMode)requestAnimationFrame(()=>list.scrollTo({top:0,behavior:'smooth'}));return;}
    if(targetId===lastFlowScrollEntryId)return;
    lastFlowScrollEntryId=targetId;
    requestAnimationFrame(()=>{const current=list.querySelector('.flow-chip.current');if(!current||!list.isConnected)return;const listRect=list.getBoundingClientRect(),itemRect=current.getBoundingClientRect(),top=list.scrollTop+itemRect.top-listRect.top-(listRect.height-itemRect.height)/2;list.scrollTo({top:Math.max(0,top),behavior:'smooth'});});
  }
  async function submitFlowInitiativeAction(action){
    const e=encounter();
    if(!sessionToken){toast('请先加入房间');return;}
    if(e.playMode!=='prepare'){toast('只能在战斗准备阶段调整先攻');return;}
    if(initiativePending)return;
    initiativePending=true;renderFlow(state);
    try{
      const result=await requestAction({...action,turnSerial:Number(e.turnSerial)||1}),data=result.data||{};
      if(!result.ok||data.ok===false)toast('⚠ '+(data.error||'先攻调整失败'));
      await syncRoomState();
    }catch(error){toast('⚠ 先攻调整未送达');await syncRoomState();}
    finally{initiativePending=false;renderFlow(state);}
  }
  function refreshPlayerClock() {
    if(document.hidden||!state?.encounter)return;
    const e=state.encounter,p=flowWorldParts(flowWorldTotal(e)),weather=flowWeatherPresentation(e.weather,p);
    const values={'#flow-date':flowDateLabel(p)+' '+flowClockLabel(p),'#flow-time-date':flowDateLabel(p),
      '#flow-time-clock':flowClockLabel(p),'#flow-weather-summary':weather.compact,'#flow-weather-meta':weather.detail};
    Object.entries(values).forEach(([selector,value])=>{const el=$(selector);if(el&&el.textContent!==value)el.textContent=value;});
  }
  function renderFlow(next) {
    const bar=$('#flowbar'), e=next&&next.encounter&&typeof next.encounter==='object'?next.encounter:{playMode:'free',round:1,currentEntryId:null,entries:[],worldTime:{totalSeconds:480*60}};
    const p=flowWorldParts(flowWorldTotal(e)), entries=Array.isArray(e.entries)?e.entries:[], currentIndex=entries.findIndex(x=>x.id===e.currentEntryId), current=currentIndex>=0?entries[currentIndex]:null, nextEntry=entries.length&&currentIndex>=0?entries[(currentIndex+1)%entries.length]:entries[0]||null, weather=flowWeatherPresentation(e.weather,p), preparing=e.playMode==='prepare', inTurn=e.playMode==='turn', map=flowEncounterMap(next);
    bar.classList.toggle('collapsed',bar.dataset.collapsed!=='false');
    $('#flow-toggle').textContent=(bar.dataset.collapsed!=='false'?'▸':'▾')+' 游戏流程';
    $('#flow-toggle').setAttribute('aria-expanded',String(bar.dataset.collapsed==='false'));
    $('#flow-mode').textContent=inTurn?'回合制':preparing?'战斗准备':'自由模式';
    $('#flow-mode').classList.toggle('prepare',preparing);
    $('#flow-current-summary').textContent=inTurn&&current?(current.name||'未命名单位'):preparing?'等待 DM 开始战斗':'所有单位可行动';
    $('#flow-weather-summary').textContent=weather.compact;
    $('#flow-date').textContent=flowDateLabel(p)+' '+flowClockLabel(p);
    $('#flow-round').textContent=inTurn?'第 '+(Math.max(1,Number(e.round)||1)+' 轮'):preparing?'战斗准备阶段':'自由行动';
    $('#flow-current').textContent=inTurn&&current?current.name||'未命名单位':preparing?'确认你的先攻顺序':'所有单位可行动';
    $('#flow-next').textContent=inTurn&&nextEntry?'下一位：'+(nextEntry.name||'未命名单位'):preparing?'先攻相同的玩家可以互换顺序':'进入战斗后显示下一位';
    $('#flow-time-date').textContent=flowDateLabel(p);
    $('#flow-time-clock').textContent=flowClockLabel(p);
    $('#flow-time-mode').textContent=inTurn?'战斗轮推进：每轮 +'+(Number(e.secondsPerRound)||6)+' 秒':(e.worldTime.runningSince?'时间运行中':'时间已暂停');
    $('#flow-weather-icon').textContent=weather.icon;
    $('#flow-weather-name').textContent=weather.name;
    $('#flow-weather-meta').textContent=weather.detail;
    document.querySelectorAll('[data-flow-panel]').forEach(tab=>{const active=tab.dataset.flowPanel===flowPanel;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});
    $('#flow-panel-initiative').hidden=flowPanel!=='initiative'; $('#flow-panel-time').hidden=flowPanel!=='time';
    const list=$('#flow-init-list'),previousScrollTop=list.scrollTop; list.innerHTML='';
    if(!entries.length){list.innerHTML='<span class="flow-empty">等待主控台设置先攻</span>';lastFlowScrollEntryId=null;return;}
    entries.forEach((entry,index)=>{
      const active=inTurn&&entry.id===e.currentEntryId,owned=preparing&&flowOwnsEntry(map,entry),chip=document.createElement('div');
      chip.className='flow-chip'+(active?' current':'')+(owned?' owned-adjustable':'');chip.dataset.entryId=entry.id;
      chip.innerHTML='<span class="flow-chip-order">'+(index+1)+'</span><span class="flow-chip-dot" style="background:'+(entry.color||'#e0b34c')+'"></span><span class="flow-chip-name">'+esc(entry.name||'未命名单位')+'</span><span class="flow-chip-value">'+(Number(entry.value)||0)+'</span>'+(active?'<span class="flow-chip-current">行动中</span>':'');
      if(owned){
        const actions=document.createElement('div');actions.className='flow-chip-actions';actions.setAttribute('aria-label','同先攻换位');
        const makeSwap=(label,target,title)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.title=title;const allowed=!!target&&Number(target.value)===Number(entry.value)&&flowEntryControllers(map,target).length>0;button.disabled=initiativePending||!allowed;button.addEventListener('click',event=>{event.stopPropagation();if(allowed)submitFlowInitiativeAction({op:'initiativeSwap',entryId:entry.id,targetEntryId:target.id});});return button;};
        actions.appendChild(makeSwap('↑',entries[index-1],entries[index-1]?'与上一位同先攻玩家换位':'已经是第一位'));
        actions.appendChild(makeSwap('↓',entries[index+1],entries[index+1]?'与下一位同先攻玩家换位':'已经是最后一位'));
        chip.appendChild(actions);
      }
      list.appendChild(chip);
    });
    list.scrollTop=previousScrollTop;scrollFlowCurrentIntoView(list,e);
  }
  function playerMapOpen(map){return !!map&&map.playerAccessible===true;}
  function playerMapGroupOpen(structure,{chapterId=null,locationId=null}={}){
    return structure.maps.some(map=>playerMapOpen(map)
      &&(!chapterId||structure.chapterId(map)===chapterId)
      &&(!locationId||structure.locationId(map)===locationId));
  }
  function playerMapStructure(next){
    const maps=Array.isArray(next&&next.maps)?next.maps:[],chapters=Array.isArray(next&&next.mapChapters)&&next.mapChapters.length?next.mapChapters:[{id:'player-default-chapter',name:'地图'}],locations=Array.isArray(next&&next.mapLocations)&&next.mapLocations.length?next.mapLocations:[{id:'player-default-location',chapterId:chapters[0].id,name:'默认地点'}];
    return{maps,chapters,locations,chapterId:map=>map.chapterId||chapters[0].id,locationId:map=>map.locationId||locations[0].id};
  }
  function renderPlayerMapBrowser(){
    const tabs=$('#player-map-chapter-tabs'),columns=$('#player-map-location-columns');if(!tabs||!columns)return;
    const structure=playerMapStructure(state),available=structure.maps.filter(playerMapOpen).length;
    if(!structure.chapters.some(chapter=>chapter.id===playerMapBrowserChapterId))playerMapBrowserChapterId=structure.chapterId(currentMap||structure.maps[0]||{});
    $('#player-map-browser-count').textContent=structure.chapters.length+' 章 · '+structure.locations.length+' 个地点 · '+available+'/'+structure.maps.length+' 张已开放';
    $('#player-map-browser-current').textContent=currentMap?'当前：'+(currentMap.floorLabel||currentMap.name||'未命名地图'):'当前尚未进入地图';
    tabs.innerHTML='';structure.chapters.forEach(chapter=>{const button=document.createElement('button'),revealed=playerMapGroupOpen(structure,{chapterId:chapter.id});button.type='button';button.className='player-map-chapter'+(chapter.id===playerMapBrowserChapterId?' active':'')+(revealed?'':' locked');button.dataset.playerMapChapter=chapter.id;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(chapter.id===playerMapBrowserChapterId));button.textContent=revealed?(chapter.name||'未命名章节'):'?';button.title=revealed?button.textContent:'这个章节尚无已开放地图';tabs.appendChild(button);});
    columns.innerHTML='';const locations=structure.locations.filter(location=>location.chapterId===playerMapBrowserChapterId);
    if(!locations.length){columns.innerHTML='<div class="player-map-empty">这个章节还没有地点</div>';return;}
    locations.forEach(location=>{const section=document.createElement('section'),heading=document.createElement('h3'),list=document.createElement('div'),revealed=playerMapGroupOpen(structure,{locationId:location.id});section.className='player-map-location'+(revealed?'':' locked');heading.textContent=revealed?(location.name||'未命名地点'):'?';heading.title=revealed?heading.textContent:'这个地点尚无已开放地图';list.className='player-map-floor-list';const maps=structure.maps.filter(map=>structure.locationId(map)===location.id);
      if(!maps.length)list.innerHTML='<div class="player-map-empty">暂无地图</div>';
      maps.forEach((map,index)=>{const open=playerMapOpen(map),ready=open&&!!map.mapData,card=document.createElement('article'),button=document.createElement('button'),preview=document.createElement('span'),order=document.createElement('span'),copy=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('span');card.className='player-map-card'+(map.id===currentMap?.id?' current':'')+(open?'':' locked');button.type='button';button.className='player-map-open';button.dataset.playerMapOpen=map.id;button.disabled=!ready;button.title=!open?'这张地图尚未开放':ready?'进入 '+(map.floorLabel||map.name):'地图资源正在准备';preview.className='player-map-preview';if(ready)preview.style.backgroundImage='linear-gradient(#0002,#0005),url("'+String(map.mapData).replace(/"/g,'%22')+'")';else{const question=document.createElement('span');question.className='player-map-question';question.textContent=open?'…':'?';preview.appendChild(question);}order.className='player-map-badge player-map-order';order.textContent=String(index+1);preview.appendChild(order);if(map.id===state?.activeMapId){const badge=document.createElement('span');badge.className='player-map-badge player-map-presented';badge.textContent='DM 引导';preview.appendChild(badge);}copy.className='player-map-copy';title.textContent=open?(map.floorLabel||map.name||'未命名地图'):'?';meta.textContent=!open?'尚未开放':ready?(map.name||'已开放'):'已开放 · 资源准备中';copy.append(title,meta);button.append(preview,copy);card.appendChild(button);list.appendChild(card);});section.append(heading,list);columns.appendChild(section);});
    requestAnimationFrame(()=>columns.querySelector('.player-map-card.current')?.scrollIntoView({block:'nearest',inline:'center'}));
  }
  function closePlayerMapBrowser(){$('#player-map-browser-modal').hidden=true;}
  let mapBrowserReturn=null;
  $('#player-map-browser-back').onclick=()=>{closePlayerMapBrowser();mapBrowserReturn?.();};
  function openPlayerMapBrowser(options={}){mapBrowserReturn=typeof options.onBack==='function'?options.onBack:null;$('#player-map-browser-back').hidden=!mapBrowserReturn;if(!state){toast('等待主控台同步地图');return;}playerMapBrowserChapterId=playerMapStructure(state).chapterId(currentMap||{});renderPlayerMapBrowser();$('#player-map-browser-modal').hidden=false;}
  function resetPlayerMapInteraction(){hideTokenPeek();hideTokenContextMenu();hideTokenInvestigation();closePlayerPortraitManager();closeDetail();cancelMapReaction();cancelSpellAim();$('#reaction-layer').innerHTML='';doodleDraft=null;measureDraft=null;if(drag)drag=null;}
  function switchPlayerMap(mapId){
    const map=(state?.maps||[]).find(item=>item.id===mapId);if(!playerMapOpen(map)){toast('🔒 这张地图尚未由主控台开放');return;}if(!map.mapData){toast('地图资源正在准备，请稍后再试');return;}if(currentMap?.id===map.id){closePlayerMapBrowser();return;}
    resetPlayerMapInteraction();playerMapId=map.id;currentMap=map;lastMapViewKey='';$('#empty').style.display='none';renderMap(map);queueMapAssetPreloads(state?._mapPreloads,map.mapData);renderDoodles();renderTurnPath();renderTokens(map);renderSpellRanges();updateEndTurnUi();updatePlayerPlaceUi();fit();renderPlayerMapBrowser();closePlayerMapBrowser();toast('已进入「'+(map.floorLabel||map.name||'地图')+'」');
  }
  function mapForPlayerSnapshot(next){
    const previousMaps=new Map((state?.maps||[]).map(map=>[map.id,map]));
    (next.maps||[]).forEach(map=>{const old=previousMaps.get(map.id);if(playerMapOpen(map)&&!map.mapData&&old?.mapData)map.mapData=old.mapData;});
    const presentedChanged=lastPresentedMapId!==null&&next.activeMapId!==lastPresentedMapId;
    if(!playerMapId||presentedChanged)playerMapId=next.activeMapId;
    lastPresentedMapId=next.activeMapId||null;
    let chosen=(next.maps||[]).find(map=>map.id===playerMapId&&playerMapOpen(map)&&map.mapData);
    if(!chosen)chosen=(next.maps||[]).find(map=>map.id===next.activeMapId&&playerMapOpen(map)&&map.mapData)||(next.maps||[]).find(map=>playerMapOpen(map)&&map.mapData)||null;
    if(!(next.maps||[]).some(map=>map.id===playerMapId&&playerMapOpen(map)))playerMapId=chosen?.id||null;
    return chosen;
  }
  const retiredServerSessions=new Set();
  function acceptPlayerStreamSession(next) {
    if(retiredServerSessions.has(next._sessionId))return false;
    if(next._sessionId && next._sessionId!==state?._sessionId){
      playerMusic.reset();
      if(state?._sessionId)retiredServerSessions.add(state._sessionId);
      lastStateRevision=0;streamAppliedSeq=0;playerMapId=null;lastPresentedMapId=null;lastMapViewKey='';
      drag=null;measureDraft=null;doodleDraft=null;
      clearTimeout(patchTimer);patchTimer=null;pendingPatch=null;
    }
    return true;
  }
  function render(next) {
    if(!next||typeof next!=='object')return;
    if(!acceptPlayerStreamSession(next))return;
    next.journal=CampaignJournal.normalize(next.journal,next.campaignId);
    const incomingRevision=Number(next._stateRevision)||0;if(incomingRevision&&incomingRevision<lastStateRevision)return;
    const incomingEncounter=next&&next.encounter&&typeof next.encounter==='object'?next.encounter:null;
    if(drag&&drag.kind==='token'&&incomingEncounter&&Number(incomingEncounter.turnSerial)!==Number(drag.turnSerial)){drag=null;toast('⚠ 回合已变化，当前移动已取消');}
    if(drag&&drag.kind==='spell-aim'&&incomingEncounter&&Number(incomingEncounter.turnSerial)!==Number(drag.turnSerial)){cancelSpellAim();toast('⚠ 回合已变化，锥形方向未修改');}
    const previousMapId=currentMap&&currentMap.id;
    const nextCurrentMap=mapForPlayerSnapshot(next);state=next; lastStateRevision=Math.max(lastStateRevision,incomingRevision);streamAppliedSeq=Math.max(streamAppliedSeq,Number(next._streamSeq)||0);flowClockAnchor={localNow:performance.now(),serverNow:Number(next._serverNow)||Date.now()}; renderFlow(next); currentMap=nextCurrentMap;updateEndTurnUi();updatePlayerPlaceUi();renderPlayerMapBrowser();
    if(previousMapId&&(!currentMap||previousMapId!==currentMap.id)){hideTokenPeek();hideTokenContextMenu();hideTokenInvestigation();closePlayerPortraitManager();closeDetail();cancelMapReaction();cancelSpellAim();$('#reaction-layer').innerHTML='';doodleDraft=null;if(drag&&(drag.kind==='doodle'||drag.kind==='doodle-erase'))drag=null;}
    setConnection('已连接',true); $('#campaign').textContent=next.campaignName?'📂 '+next.campaignName:'';applyJoinCampaignCover(next._campaignCoverUrl);
    renderLinks(next.sharedResources || next._links);
    CampaignJournal.refresh();
    PlayerBackpack.contextChanged();
    const sharedNote=$('#shared-note'); if(sharedNote){sharedNote.textContent=next.sharedNotes||''; if(!sharedNote.textContent)sharedNote.innerHTML='<span class="hint">等待主控台发布内容</span>';}
    if(next._bgm) applyBgm(next._bgm);
    if (!currentMap) { $('#empty').style.display='grid';renderSpellRanges();$('#reaction-layer').innerHTML='';return; }
    $('#empty').style.display='none'; renderMap(currentMap);queueMapAssetPreloads(next._mapPreloads,currentMap.mapData); renderDoodles(); renderTurnPath(); renderTokens(currentMap);renderSpellRanges();
    const mapViewKey=currentMap.id+'|'+currentMap.mapW+'|'+currentMap.mapH;
    if(mapViewKey!==lastMapViewKey){lastMapViewKey=mapViewKey;fit();}
    if (selectedId) openDetail(selectedId); updateEndTurnUi();
  }

  let patchTimer=null, pendingPatch=null, endTurnPending=false, turnPathActionPending=null;
  function clonePatchValue(value){return value&&typeof value==='object'?JSON.parse(JSON.stringify(value)):value;}
  function patchValuesEqual(a,b){if(a&&typeof a==='object'&&b&&typeof b==='object')return JSON.stringify(a)===JSON.stringify(b);return Object.is(a,b)||String(a)===String(b);}
  function restoreRejectedPatch(job){
    const map=state&&(state.maps||[]).find(item=>(item.tokens||[]).some(token=>token.id===job.id)), token=map&&(map.tokens||[]).find(item=>item.id===job.id);
    if(token)Object.keys(job.before).forEach(key=>{if(patchValuesEqual(token[key],job.patch[key]))token[key]=clonePatchValue(job.before[key]);});
    if(currentMap&&map===currentMap){renderTokens(currentMap);renderSpellRanges();if(selectedId===job.id)openDetail(job.id);if(playerPortraitManagerTokenId===job.id)renderPlayerPortraitManager();}
    syncRoomState();
  }
  const pendingPatchRequests=new Set();
  async function dispatchPendingPatch(){
    clearTimeout(patchTimer);patchTimer=null;const job=pendingPatch;pendingPatch=null;
    if(!job){const results=await Promise.all([...pendingPatchRequests]);return results.every(result=>result!==false);}
    const action={op:'patchToken',tokenId:job.id,mapId:job.mapId,patch:job.patch,playMode:job.playMode,characterRevision:job.characterRevision};if(job.turnSerial!=null)action.turnSerial=job.turnSerial;
    const preceding=[...pendingPatchRequests];
    const request=(async()=>{
      const results=await Promise.all(preceding);if(results.some(result=>result===false))return false;
      try{const r=await requestAction(action),d=r.data||{};if(!r.ok||d.ok===false){restoreRejectedPatch(job);toast('⚠ '+(d.error||'同步失败'));return false;}return true;}
      catch(error){restoreRejectedPatch(job);toast('⚠ 修改未送达');return false;}
    })();
    pendingPatchRequests.add(request);
    try{return await request;}finally{pendingPatchRequests.delete(request);}
  }
  function sendPatch(id, patch, before) {
    if (!sessionToken || !myName || !id) return;
    const e=encounter(),mapId=currentMap?.id||null,playMode=e.playMode==='turn'?'turn':'free', turnSerial=playMode==='turn'?(Number(e.turnSerial)||1):null;
    if(pendingPatch&&(pendingPatch.id!==id||pendingPatch.mapId!==mapId||pendingPatch.playMode!==playMode||pendingPatch.turnSerial!==turnSerial))dispatchPendingPatch();
    if(!pendingPatch)pendingPatch={id,mapId,playMode,turnSerial,characterRevision:currentMap?.tokens?.find(t=>t.id===id)?.characterRevision,patch:{},before:{}};
    Object.keys(patch).forEach(key=>{if(!(key in pendingPatch.before))pendingPatch.before[key]=clonePatchValue(before[key]);pendingPatch.patch[key]=clonePatchValue(patch[key]);});
    clearTimeout(patchTimer);patchTimer=setTimeout(dispatchPendingPatch,180);
  }
  function makePlayerConditionId(){return window.crypto&&typeof window.crypto.randomUUID==='function'?'cond-'+window.crypto.randomUUID():'cond-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}
  function normalizePlayerCondition(raw){
    const source=raw&&typeof raw==='object'?raw:{},requestedKey=String(source.key||'custom').slice(0,32),key=CONDITION_META[requestedKey]?requestedKey:'custom',meta=CONDITION_META[key]||{},rawTurns=Number(source.remainingTurns),rawId=String(source.id||'').replace(/[^A-Za-z0-9_.:-]/g,'').slice(0,96);
    const label=String(meta.label||(source.label||'')).trim().slice(0,24),icon=String(meta.icon||(source.icon||'◆')).trim().slice(0,4)||'◆',rawColor=String(meta.color||source.color||'#a8b3c7');
    return{id:rawId||makePlayerConditionId(),key,label:label||'自定义状态',icon,color:/^#[0-9a-f]{6}$/i.test(rawColor)?rawColor:'#a8b3c7',remainingTurns:Number.isFinite(rawTurns)&&rawTurns>0?clamp(Math.trunc(rawTurns),1,999):null,visibility:'public'};
  }
  function playerPublicConditions(t){return(Array.isArray(t&&t.conditions)?t.conditions:[]).filter(condition=>condition&&condition.visibility!=='gm').slice(0,MAX_TOKEN_CONDITIONS).map(normalizePlayerCondition);}
  function populatePlayerConditionSelect(){
    const select=$('#player-condition-select');if(!select||select.options.length)return;select.innerHTML='<option value="">选择状态…</option>';
    Object.entries(CONDITION_META).forEach(([key,meta])=>{const option=document.createElement('option');option.value=key;option.textContent=meta.icon+' '+meta.label;select.appendChild(option);});
    const custom=document.createElement('option');custom.value='custom';custom.textContent='◆ 自定义状态…';select.appendChild(custom);
  }
  function syncPlayerConditionCustomFields(){const custom=$('#player-condition-custom-fields');if(custom)custom.hidden=$('#player-condition-select').value!=='custom';}
  function setPlayerConditionDuration(value){const normalized=value==null?'':String(value);$('#player-condition-turns').value=normalized;document.querySelectorAll('[data-player-condition-duration]').forEach(button=>button.classList.toggle('active',button.dataset.playerConditionDuration===normalized));}
  function syncPlayerConditionDuration(){const value=String($('#player-condition-turns').value||'');document.querySelectorAll('[data-player-condition-duration]').forEach(button=>button.classList.toggle('active',button.dataset.playerConditionDuration===value));}
  function closePlayerConditionEditor(){editingPlayerConditionId=null;$('#player-condition-editor').hidden=true;}
  function openPlayerConditionEditor(conditionId=null){
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===selectedId);if(!t||!ownedToken(t))return;
    if(!canActWithToken(t)){toast('🔒 只有轮到该角色时才能修改状态');renderPlayerConditions(t,false);return;}
    populatePlayerConditionSelect();const condition=conditionId?playerPublicConditions(t).find(item=>item.id===conditionId):null,select=$('#player-condition-select');editingPlayerConditionId=condition?.id||null;
    $('#player-condition-editor').hidden=false;$('#player-condition-editor-title').textContent=condition?'编辑状态':'添加状态';$('#player-condition-save').textContent=condition?'保存状态':'添加状态';
    const knownKey=condition&&CONDITION_META[condition.key]?condition.key:'custom';select.value=condition?knownKey:'';$('#player-condition-custom-name').value=condition&&knownKey==='custom'?condition.label:'';$('#player-condition-custom-icon').value=condition&&knownKey==='custom'?(condition.icon||'◆'):'◆';syncPlayerConditionCustomFields();setPlayerConditionDuration(condition?(condition.remainingTurns??''):'1');
    requestAnimationFrame(()=>select.focus());
  }
  function renderPlayerConditions(t,editable=canActWithToken(t)){
    const box=$('#detail-conditions');box.innerHTML='';const conditions=playerPublicConditions(t);$('#player-condition-open').disabled=!editable;
    $('#player-condition-lock-hint').textContent=editable?'修改后会实时同步，并通知主控台。':(encounter().playMode==='turn'?'🔒 等到该棋子的回合才能修改状态。':'请先加入房间。');
    conditions.forEach(condition=>{const chip=document.createElement('div'),edit=document.createElement('button'),remove=document.createElement('button');chip.className='condition-chip';chip.style.setProperty('--condition-color',condition.color);edit.type='button';edit.className='condition-main';edit.textContent=condition.icon+' '+condition.label+' · '+(condition.remainingTurns?condition.remainingTurns+' 回合':'永久');edit.title='编辑状态';edit.disabled=!editable;edit.addEventListener('click',()=>openPlayerConditionEditor(condition.id));remove.type='button';remove.className='condition-remove';remove.textContent='×';remove.title='移除状态';remove.setAttribute('aria-label','移除'+condition.label);remove.disabled=!editable;remove.addEventListener('click',()=>applyPlayerConditions(t,conditions.filter(item=>item.id!==condition.id),'已移除状态：'+condition.label));chip.append(edit,remove);box.appendChild(chip);});
    if(!conditions.length)box.innerHTML='<span class="hint">暂无公开状态</span>';
    if(!editable)closePlayerConditionEditor();
  }
  function applyPlayerConditions(t,nextConditions,successMessage){
    if(!t||!ownedToken(t)||!canActWithToken(t)){if(t)renderPlayerConditions(t,false);toast('🔒 只有轮到该角色时才能修改状态');return;}
    const previous=playerPublicConditions(t).map(condition=>({...condition})),next=(Array.isArray(nextConditions)?nextConditions:[]).slice(0,MAX_TOKEN_CONDITIONS).map(normalizePlayerCondition);t.conditions=next;closePlayerConditionEditor();renderTokens(currentMap);openDetail(t.id);sendPatch(t.id,{conditions:next.map(condition=>({...condition}))},{conditions:previous});dispatchPendingPatch().then(ok=>{if(ok)toast((successMessage||'状态已更新')+' · 已通知主控台');});
  }
  function savePlayerCondition(){
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===selectedId),select=$('#player-condition-select');if(!t||!select||!select.value)return;
    const key=select.value,meta=CONDITION_META[key]||{};let label=meta.label||'',icon=meta.icon||'◆';
    if(key==='custom'){label=$('#player-condition-custom-name').value.trim().slice(0,24);icon=$('#player-condition-custom-icon').value.trim().slice(0,4)||'◆';if(!label){toast('请输入自定义状态名称');$('#player-condition-custom-name').focus();return;}}
    const rawText=$('#player-condition-turns').value.trim(),rawTurns=rawText===''?null:Number(rawText);if(rawTurns!==null&&(!Number.isFinite(rawTurns)||rawTurns<1||rawTurns>999)){toast('持续回合数必须是 1–999，留空表示永久');return;}
    const conditions=playerPublicConditions(t),editingIndex=editingPlayerConditionId?conditions.findIndex(item=>item.id===editingPlayerConditionId):-1,duplicateIndex=editingIndex<0?conditions.findIndex(item=>item.key===key&&item.label===label):-1,targetIndex=editingIndex>=0?editingIndex:duplicateIndex;
    if(targetIndex<0&&conditions.length>=MAX_TOKEN_CONDITIONS){toast('每个棋子最多记录 20 个状态');return;}
    const existing=targetIndex>=0?conditions[targetIndex]:null,condition=normalizePlayerCondition({...existing,key,label,icon,color:meta.color||existing?.color,remainingTurns:rawTurns});if(targetIndex>=0)conditions[targetIndex]=condition;else conditions.push(condition);
    applyPlayerConditions(t,conditions,(existing?'已更新状态：':'已添加状态：')+condition.label);
  }
  async function deleteOwnedTemporaryToken(){
    const t=currentMap&&(currentMap.tokens||[]).find(token=>token.id===selectedId);if(!t||t.playerCreated!==true||!mine(t)){toast('只能删除自己创建的临时棋子');return;}if(playerDeletePending)return;
    if(!confirm('确定删除临时棋子「'+t.name+'」？'))return;
    if(pendingPatch&&pendingPatch.id===t.id){clearTimeout(patchTimer);patchTimer=null;pendingPatch=null;}else if(await dispatchPendingPatch()===false)return;
    playerDeletePending=t.id;openDetail(t.id);
    try{
      const result=await requestAction({op:'deletePlayerToken',mapId:currentMap.id,tokenId:t.id}),data=result.data||{};
      if(!result.ok||data.ok===false){toast('⚠ '+(data.error||'删除失败'));return;}
      await syncRoomState();
    }catch(error){toast('⚠ 删除请求未送达');await syncRoomState();}
    finally{const pendingId=playerDeletePending;playerDeletePending=null;if(selectedId===pendingId)openDetail(pendingId);}
  }
  function playerMountCandidates(rider){
    if(!currentMap||!rider)return[];
    const player=myPlayerId,grid=Math.max(1,Number(currentMap.gridSize)||50);
    return(currentMap.tokens||[]).filter(mount=>mount&&mount.id!==rider.id&&SundollSize.canRide(rider,mount)&&mount.hiddenFromPlayers!==true&&(!String(mount.ownerPlayerId||mount.owner||'').trim()||String(mount.ownerPlayerId||mount.owner||'').trim()===player)).sort((a,b)=>Math.hypot(Number(a.x||0)-Number(rider.x||0),Number(a.y||0)-Number(rider.y||0))-Math.hypot(Number(b.x||0)-Number(rider.x||0),Number(b.y||0)-Number(rider.y||0))).map(mount=>({...mount,_playerMountFeet:Math.round(Math.hypot(Number(mount.x||0)-Number(rider.x||0),Number(mount.y||0)-Number(rider.y||0))/grid*5)}));
  }
  async function mountOwnedRider(riderId,mountId){
    const rider=currentMap&&(currentMap.tokens||[]).find(token=>token.id===riderId),mount=currentMap&&(currentMap.tokens||[]).find(token=>token.id===mountId),e=encounter();
    if(!rider||!mine(rider)||rider.mountId){toast('只能让自己尚未骑乘的角色上骑');return;}
    if(!mount||!playerMountCandidates(rider).some(candidate=>candidate.id===mount.id)){toast('这匹坐骑当前不可用');return;}
    if(!canActWithToken(rider)){toast(e.playMode==='turn'?'🔒 只有轮到这个角色时才能上骑':'当前不能上骑');return;}
    if(playerMountPending)return;
    playerMountPending=rider.id;if(selectedId)openDetail(selectedId);
    try{
      if(await dispatchPendingPatch()===false)return;
      const latest=encounter(),action={op:'mountToken',mapId:currentMap.id,tokenId:rider.id,mountId:mount.id,playMode:latest.playMode==='turn'?'turn':'free'};if(action.playMode==='turn')action.turnSerial=Number(latest.turnSerial)||1;
      const result=await requestAction(action),data=result.data||{};if(!result.ok||data.ok===false){toast('⚠ '+(data.error||'上骑失败'));await syncRoomState();return;}
      await syncRoomState();
    }catch(error){toast('⚠ 上骑请求未送达');await syncRoomState();}
    finally{playerMountPending=null;if(selectedId)openDetail(selectedId);}
  }
  async function dismountOwnedRider(riderId){
    const rider=currentMap&&(currentMap.tokens||[]).find(token=>token.id===riderId);if(!rider||!mine(rider)||!rider.mountId){toast('只能解除自己角色当前的骑乘');return;}if(playerDismountPending)return;
    const mount=(currentMap.tokens||[]).find(token=>token.id===rider.mountId),e=encounter();if(!canActWithToken(rider)){toast(e.playMode==='turn'?'🔒 只有轮到这个角色时才能解除骑乘':'当前不能解除骑乘');return;}
    if(!confirm('确定让「'+rider.name+'」从「'+((mount&&mount.name)||'坐骑')+'」下马？'))return;
    playerDismountPending=rider.id;if(selectedId)openDetail(selectedId);
    try{
      if(await dispatchPendingPatch()===false)return;
      const latest=encounter(),action={op:'dismountToken',mapId:currentMap.id,tokenId:rider.id,playMode:latest.playMode==='turn'?'turn':'free'};if(action.playMode==='turn')action.turnSerial=Number(latest.turnSerial)||1;
      const result=await requestAction(action),data=result.data||{};if(!result.ok||data.ok===false){toast('⚠ '+(data.error||'解除骑乘失败'));await syncRoomState();return;}
      await syncRoomState();
    }catch(error){toast('⚠ 解除骑乘请求未送达');await syncRoomState();}
    finally{playerDismountPending=null;if(selectedId)openDetail(selectedId);}
  }
  function closeDetail() { selectedId=null;cancelSpellAim();closePlayerConditionEditor();closePlayerPortraitManager(); $('#detail').hidden=true; $('#detail-empty').hidden=false;const chain=$('#detail-mounted-chain');chain.hidden=true;chain.innerHTML='';$('#right-panel').classList.remove('mobile-open');requestSpellRangeRender(); }
  function mountedDetailPair(token) {
    if(!currentMap||!token)return null;
    const mount=movementAnchor(token,currentMap);
    if(!mount)return null;
    const riders=ridersOfToken(mount,currentMap),rider=token.mountId===mount.id&&mine(token)?token:riders.find(mine);
    return rider&&rider.id!==mount.id?{rider,mount}:null;
  }
  function mountedDetailUnitButton(unit,role) {
    const meta=TYPE[unit.type]||TYPE.npc,button=document.createElement('button'),avatar=document.createElement('span'),copy=document.createElement('span'),roleEl=document.createElement('span'),name=document.createElement('span'),stats=document.createElement('span');
    button.type='button';button.className='mounted-detail-unit'+(unit.id===selectedId?' active':'');button.dataset.tokenId=unit.id;button.setAttribute('aria-pressed',unit.id===selectedId?'true':'false');button.title='切换到'+(unit.name||role)+'的完整信息';
    avatar.className='mounted-detail-avatar';avatar.style.setProperty('--unit-ring',meta.ring);if(!applyPlayerPortrait(avatar,unit))avatar.textContent=unit.icon||'?';
    copy.className='mounted-detail-copy';roleEl.className='mounted-detail-role';roleEl.textContent=role;name.className='mounted-detail-name';name.textContent=unit.name||'未命名';stats.className='mounted-detail-stats';stats.textContent=Number.isFinite(Number(unit.hp))?'HP '+unit.hp+'/'+unit.hpMax+' · AC '+unit.ac:'HP / AC 未公开';
    copy.append(roleEl,name,stats);button.append(avatar,copy);button.addEventListener('click',()=>{activatePlayerDetailTab('status');openDetail(unit.id);});return button;
  }
  function renderMountedDetail(token) {
    const container=$('#detail-mounted-chain'),pair=mountedDetailPair(token);container.innerHTML='';
    if(pair){
      container.hidden=false;
      const head=document.createElement('div'),label=document.createElement('div'),dismount=document.createElement('button'),units=document.createElement('div'),link=document.createElement('span'),allowed=canActWithToken(pair.rider),pending=playerDismountPending===pair.rider.id;head.className='mounted-detail-head';label.className='mounted-detail-label';label.textContent='🔗 骑乘联动 · 点击切换编辑对象';dismount.type='button';dismount.className='mounted-detail-dismount';dismount.textContent=pending?'解除中…':'解除骑乘';dismount.disabled=!allowed||pending;dismount.title=pending?'正在解除骑乘':allowed?'让自己的角色从当前坐骑下马':encounter().playMode==='turn'?'只有轮到该角色时才能解除骑乘':'当前不能解除骑乘';dismount.addEventListener('click',()=>dismountOwnedRider(pair.rider.id));head.append(label,dismount);units.className='mounted-detail-units';link.className='mounted-detail-link';link.textContent='↕';link.setAttribute('aria-hidden','true');
      units.append(mountedDetailUnitButton(pair.rider,'玩家'),link,mountedDetailUnitButton(pair.mount,'坐骑'));container.append(head,units);return;
    }
    const canOffer=mine(token)&&!token.mountId;container.hidden=!canOffer;if(!canOffer)return;
    const candidates=playerMountCandidates(token),allowed=canActWithToken(token),pending=playerMountPending===token.id,head=document.createElement('div'),label=document.createElement('div'),picker=document.createElement('div'),select=document.createElement('select'),button=document.createElement('button'),hint=document.createElement('p');
    head.className='mounted-detail-head';label.className='mounted-detail-label';label.textContent='🐎 上骑';head.append(label);picker.className='player-mount-picker';select.setAttribute('aria-label','选择坐骑');
    if(!candidates.length){const option=document.createElement('option');option.value='';option.textContent='暂无可用坐骑';select.append(option);}else candidates.forEach(mount=>{const option=document.createElement('option'),riderCount=ridersOfToken(mount,currentMap).length;option.value=mount.id;option.textContent=(mount.name||'未命名坐骑')+' · '+Number(mount.size||2)+'×'+Number(mount.size||2)+' · '+mount._playerMountFeet+' 尺'+(riderCount?' · 已有 '+riderCount+' 名骑手':'');select.append(option);});
    select.disabled=!allowed||pending||!candidates.length;button.type='button';button.textContent=pending?'上骑中…':'上骑';button.disabled=select.disabled;button.addEventListener('click',()=>mountOwnedRider(token.id,select.value));picker.append(select,button);hint.className='player-mount-hint';hint.textContent=!candidates.length?'当前地图没有无主或属于你的大型坐骑。':!allowed?(encounter().playMode==='turn'?'等待这个角色的回合。':'请先加入房间。'):'';hint.hidden=!hint.textContent;container.append(head,picker,hint);
  }
  function tokenById(id) { return currentMap&&(currentMap.tokens||[]).find(token=>token.id===id)||null; }
  function placeFloatingElement(element,clientX,clientY,{gap=10,topMin=58}={}) { const margin=10,anchorX=Number.isFinite(Number(clientX))?Number(clientX):window.innerWidth/2,anchorY=Number.isFinite(Number(clientY))?Number(clientY):80,rect=element.getBoundingClientRect();let left=anchorX+gap,top=anchorY+gap;if(left+rect.width>window.innerWidth-margin)left=anchorX-rect.width-gap;if(top+rect.height>window.innerHeight-margin)top=anchorY-rect.height-gap;element.style.left=clamp(left,margin,Math.max(margin,window.innerWidth-rect.width-margin))+'px';element.style.top=clamp(top,topMin,Math.max(topMin,window.innerHeight-rect.height-margin))+'px'; }
  function hideTokenContextMenu() { contextTokenId=null;const menu=$('#token-context-menu');menu.hidden=true;delete menu.dataset.anchorX;delete menu.dataset.anchorY; }
  function showTokenContextMenu(t,clientX,clientY) { if(!t)return;contextTokenId=t.id;const menu=$('#token-context-menu');menu.dataset.anchorX=String(clientX);menu.dataset.anchorY=String(clientY);menu.hidden=false;placeFloatingElement(menu,clientX,clientY,{gap:4});requestAnimationFrame(()=>$('#token-investigate').focus()); }
  function hideTokenInvestigation() { investigationTokenId=null;const mask=$('#token-investigation'),panel=$('#token-investigation-window');mask.hidden=true;panel.innerHTML=''; }
  function applyInvestigationPortrait(stage,t) {
    const image=stage.querySelector('img'),fallback=stage.querySelector('.investigation-portrait-fallback'),candidate=assetUrl(t),original=originalPortraitUrl(t),showFallback=()=>{image.hidden=true;fallback.hidden=false;fallback.textContent=t.icon||'?';};
    stage.style.setProperty('--investigation-ring',(TYPE[t.type]||TYPE.npc).ring);stage.classList.toggle('portrait-path',!!t.iconImgPath);fallback.textContent=t.icon||'?';
    if(!candidate){showFallback();return;}
    fallback.hidden=true;image.hidden=false;image.dataset.fallbackTried='0';image.onload=()=>{image.hidden=false;fallback.hidden=true;};image.onerror=()=>{if(image.dataset.fallbackTried==='0'&&original&&original!==candidate){image.dataset.fallbackTried='1';image.src=original;return;}showFallback();};image.src=candidate;
  }
  function populateTokenInvestigation(t) {
    const panel=$('#token-investigation-window'),meta=TYPE[t.type]||TYPE.npc,detailed=friendly(t)&&Number.isFinite(Number(t.hp))&&Number.isFinite(Number(t.hpMax)),conditions=(t.conditions||[]).filter(condition=>condition.visibility!=='gm'),pct=detailed?clamp(Number(t.hp)/Math.max(1,Number(t.hpMax))*100,0,100):0,owner=detailed&&String(t.owner||'').trim()?(' · '+tokenOwnerName(t)+' 控制'):'';
    panel.classList.toggle('investigation-limited',!detailed);panel.setAttribute('aria-label','调查：'+String(t.name||'未命名棋子'));
    const conditionMarkup=conditions.length?conditions.map(c=>'<span class="condition-chip" style="--condition-color:'+esc(c.color||'#a8b3c7')+'">'+esc(c.icon||'◆')+' '+esc(c.label||'状态')+(c.remainingTurns?' · '+esc(c.remainingTurns)+'回合':'')+'</span>').join(''):'<span class="hint">暂无公开状态</span>';
    const stats=detailed?'<div class="investigation-stats"><div class="investigation-stat">生命值<b>'+esc(t.hp)+' / '+esc(t.hpMax)+'</b><div class="investigation-hp"><i style="width:'+pct+'%;background:'+(pct>50?'#4cc38a':pct>25?'#f4a261':'#e74c5e')+'"></i></div>'+(Number(t.tempHp)>0?'<span style="color:#a8e6b0">临时 '+esc(t.tempHp)+' / '+esc(t.tempHpMax??t.tempHp)+'</span>':'')+'</div><div class="investigation-stat">护甲等级<b>AC '+esc(t.ac)+'</b></div></div>':'';
    panel.innerHTML='<div class="investigation-layout"><div class="investigation-portrait"><img alt="'+esc(t.name||'棋子')+'的完整立绘"><span class="investigation-portrait-fallback"></span></div><div class="investigation-body"><div class="investigation-head"><div class="investigation-title"><strong>'+esc(t.name||'未命名棋子')+'</strong>'+(detailed?'<span>'+esc(meta.label+owner)+'</span>':'')+'</div><button class="investigation-close" type="button" aria-label="关闭调查">✕</button></div>'+stats+'<span class="investigation-status-title">公开状态</span><div class="condition-list">'+conditionMarkup+'</div>'+(detailed&&t.publicNote?'<div class="public-note">'+esc(t.publicNote)+'</div>':'')+'</div></div>';
    applyInvestigationPortrait(panel.querySelector('.investigation-portrait'),t);panel.querySelector('.investigation-close').onclick=hideTokenInvestigation;
  }
  function showTokenInvestigation(t) { if(!t)return;hideTokenPeek();investigationTokenId=t.id;populateTokenInvestigation(t);const mask=$('#token-investigation');mask.hidden=false;requestAnimationFrame(()=>mask.querySelector('.investigation-close')?.focus()); }
  function refreshTokenInvestigation(t) { const mask=$('#token-investigation');if(!mask.hidden&&investigationTokenId===t.id)populateTokenInvestigation(t); }

  function playerPortraitManagerToken() { return playerPortraitManagerTokenId?tokenById(playerPortraitManagerTokenId):null; }
  function playerPortraitVariants(t) { return normalizePlayerPortraitVariants(t&&t.portraitVariants); }
  function loadPlayerPortraitThumb(image,variant) { const source=assetUrl(variant),original=originalPortraitUrl(variant);image.alt=(variant.name||'形态')+'立绘缩略图';image.onerror=()=>{if(image.dataset.originalTried!=='1'&&original&&original!==source){image.dataset.originalTried='1';image.src=original;return;}image.removeAttribute('src');image.alt=(variant.name||'形态')+'立绘无法读取';};if(source)image.src=source; }
  function playerPortraitTool(label,title,action,index,disabled=false) { const button=document.createElement('button');button.type='button';button.textContent=label;button.title=title;button.setAttribute('aria-label',title);button.dataset.playerPortraitAction=action;button.dataset.playerPortraitIndex=String(index);button.disabled=disabled;return button; }
  function updatePlayerPortraitScrollButtons() { const strip=$('#player-portrait-strip'),left=$('#player-portrait-scroll-left'),right=$('#player-portrait-scroll-right'),max=Math.max(0,strip.scrollWidth-strip.clientWidth);left.disabled=strip.scrollLeft<=2;right.disabled=strip.scrollLeft>=max-2; }
  function renderPlayerPortraitManager(focusIndex=null) {
    const modal=$('#player-portrait-manager-modal');if(modal.hidden)return;const t=playerPortraitManagerToken();if(!t||!ownedToken(t)){closePlayerPortraitManager();return;}const variants=playerPortraitVariants(t),active=currentPortraitVariantIndex(t,variants),strip=$('#player-portrait-strip'),previousScroll=strip.scrollLeft,editable=canActWithToken(t);strip.innerHTML='';$('#player-portrait-manager-title').textContent=(t.name||'棋子')+' · 不同形态';$('#player-portrait-manager-summary').textContent=variants.length?variants.length+' 个形态 · 点击切换，使用箭头排序':'还没有保存形态，可把当前立绘保存为第一个形态。';$('#player-portrait-save-collection').hidden=!t.ownedPieceId;$('#player-portrait-save-current').disabled=!editable||!portraitIdentity(t)||variants.length>=24;
    if(!variants.length){const empty=document.createElement('div');empty.className='player-portrait-empty';empty.textContent=portraitIdentity(t)?'当前立绘尚未保存为形态。':'当前棋子没有可保存的立绘。';strip.appendChild(empty);}else variants.forEach((variant,index)=>{const card=document.createElement('article'),open=document.createElement('button'),image=document.createElement('img'),name=document.createElement('span'),stateLabel=document.createElement('span'),tools=document.createElement('div');card.className='player-portrait-card'+(index===active?' active':'');card.dataset.playerPortraitIndex=String(index);open.type='button';open.className='player-portrait-open';open.dataset.playerPortraitSelect=String(index);open.disabled=!editable;image.className='player-portrait-thumb';loadPlayerPortraitThumb(image,variant);name.className='player-portrait-name';name.textContent=variant.name;stateLabel.className='player-portrait-state';stateLabel.textContent=index===active?'当前形态':'形态 '+(index+1);open.append(image,name,stateLabel);tools.className='player-portrait-tools';tools.append(playerPortraitTool('←','向前移动 '+variant.name,'left',index,!editable||index===0),playerPortraitTool('✎','重命名 '+variant.name,'rename',index,!editable),playerPortraitTool('×','删除 '+variant.name,'delete',index,!editable),playerPortraitTool('→','向后移动 '+variant.name,'right',index,!editable||index===variants.length-1));card.append(open,tools);strip.appendChild(card);});
    requestAnimationFrame(()=>{if(Number.isInteger(focusIndex))strip.querySelector('[data-player-portrait-index="'+focusIndex+'"]')?.scrollIntoView({block:'nearest',inline:'center'});else strip.scrollLeft=previousScroll;updatePlayerPortraitScrollButtons();});
  }
  function openPlayerPortraitManager() { const t=tokenById(selectedId);if(!t||!ownedToken(t))return;playerPortraitManagerTokenId=t.id;$('#player-portrait-manager-modal').hidden=false;renderPlayerPortraitManager(currentPortraitVariantIndex(t)); }
  function closePlayerPortraitManager() { playerPortraitManagerTokenId=null;$('#player-portrait-manager-modal').hidden=true; }
  $('#player-portrait-save-collection').onclick=async()=>{
    const token=playerPortraitManagerToken();if(!token?.ownedPieceId)return;
    const control=$('#player-portrait-save-collection');control.disabled=true;
    try { await PlayerLibrary.saveForms({...token,portraitVariants:playerPortraitVariants(token)});toast('形态已保存到个人收藏，下次战役仍可使用'); }
    catch(error){toast(error.message||'保存形态失败');} finally{control.disabled=false;}
  };
  function commitPlayerPortraitVariants(t,variants,focusIndex=null) { const before=playerPortraitVariants(t);t.portraitVariants=normalizePlayerPortraitVariants(variants);renderPlayerPortraitManager(focusIndex);openDetail(t.id);sendPatch(t.id,{portraitVariants:t.portraitVariants},{portraitVariants:before}); }
  function savePlayerCurrentPortraitVariant() { const t=playerPortraitManagerToken();if(!t||!canActWithToken(t)||!portraitIdentity(t))return;const variants=playerPortraitVariants(t),name=prompt('给这个形态命名','形态 '+(variants.length+1));if(name===null||!name.trim())return;const snapshot={name:name.trim().slice(0,24),iconImg:t.iconImg||null,iconImgHd:t.iconImgHd||null,iconImgPath:t.iconImgPath||null,iconImgId:t.iconImgId||null},identity=portraitIdentity(snapshot),existing=variants.findIndex(v=>portraitIdentity(v)===identity);let index=existing;if(existing>=0)variants[existing]=snapshot;else{variants.push(snapshot);index=variants.length-1;}commitPlayerPortraitVariants(t,variants,index);toast(existing>=0?'已更新这个形态的名称':'已保存当前立绘为形态'); }
  function renamePlayerPortraitVariant(index) { const t=playerPortraitManagerToken(),variants=playerPortraitVariants(t),variant=variants[index];if(!t||!variant||!canActWithToken(t))return;const name=prompt('修改形态名称',variant.name);if(name===null||!name.trim())return;variant.name=name.trim().slice(0,24);commitPlayerPortraitVariants(t,variants,index); }
  function movePlayerPortraitVariant(index,step) { const t=playerPortraitManagerToken(),variants=playerPortraitVariants(t),target=index+step;if(!t||!variants[index]||target<0||target>=variants.length||!canActWithToken(t))return;[variants[index],variants[target]]=[variants[target],variants[index]];commitPlayerPortraitVariants(t,variants,target); }
  function deletePlayerPortraitVariant(index) { const t=playerPortraitManagerToken(),variants=playerPortraitVariants(t),variant=variants[index];if(!t||!variant||!canActWithToken(t)||!confirm('删除形态「'+variant.name+'」？'))return;variants.splice(index,1);commitPlayerPortraitVariants(t,variants,variants.length?Math.min(index,variants.length-1):null);toast('已删除形态「'+variant.name+'」'); }
  function hideTokenPeek() { clearTimeout(peekTimer); peekTimer=null; const peek=$('#token-peek'); peek.hidden=true; peek.dataset.tokenId=''; }
  function populateTokenPeek(t) {
    const peek=$('#token-peek'), meta=TYPE[t.type]||TYPE.npc, pct=clamp(Number(t.hp)/Math.max(1,Number(t.hpMax))*100,0,100);
    const publicConditions=(t.conditions||[]).filter(c=>c.visibility!=='gm');
    peek.innerHTML='<div class="token-peek-head"><div class="token-peek-icon"></div><div class="token-peek-title"><strong>'+esc(t.name||'未命名棋子')+'</strong><span>'+esc(meta.label)+'</span></div><button class="token-peek-close" type="button" aria-label="关闭">✕</button></div>'+
      '<div class="token-peek-stats"><div class="token-peek-stat">生命值<b>'+esc(t.hp)+' / '+esc(t.hpMax)+'</b><div class="token-peek-hp"><i style="width:'+pct+'%;background:'+(pct>50?'#4cc38a':pct>25?'#f4a261':'#e74c5e')+'"></i></div></div><div class="token-peek-stat">护甲等级<b>AC '+esc(t.ac)+'</b></div></div>'+
      '<div class="condition-list">'+(publicConditions.length?publicConditions.map(c=>'<span class="condition-chip" style="--condition-color:'+esc(c.color||'#a8b3c7')+'">'+esc(c.icon||'◆')+' '+esc(c.label||'状态')+(c.remainingTurns?' · '+esc(c.remainingTurns)+'回合':'')+'</span>').join(''):'<span class="hint">暂无公开状态</span>')+'</div>'+
      (t.publicNote?'<div class="public-note">'+esc(t.publicNote)+'</div>':'');
    const icon=peek.querySelector('.token-peek-icon'); icon.style.setProperty('--peek-ring',meta.ring); const hasPortrait=applyPlayerPortrait(icon,t); icon.textContent=hasPortrait?'':(t.icon||'?'); if(!hasPortrait)icon.style.backgroundImage='none';
    peek.querySelector('.token-peek-close').onclick=hideTokenPeek;
    if(Number(t.tempHp)>0){const block=document.createElement('div');block.textContent='临时生命值 '+t.tempHp;block.style.color='#a8e6b0';const track=document.createElement('div'),fill=document.createElement('i');track.className='hp-bar';fill.style.background='#a8e6b0';fill.style.width=clamp(Number(t.tempHp)/Math.max(1,Number(t.tempHpMax ?? t.tempHp))*100,0,100)+'%';track.append(fill);block.append(track);peek.querySelector('.token-peek-stat').append(block);}
  }
  function showTokenPeek(t,clientX,clientY) {
    if(!t||ownedToken(t)||!friendly(t)||!Number.isFinite(Number(t.hp))){hideTokenPeek();return;}
    closeDetail(); const peek=$('#token-peek'); populateTokenPeek(t); peek.dataset.tokenId=t.id; peek.hidden=false;
    const margin=12, anchorX=Number.isFinite(Number(clientX))?Number(clientX):window.innerWidth/2, anchorY=Number.isFinite(Number(clientY))?Number(clientY):80, rect=peek.getBoundingClientRect();
    let left=anchorX+14, top=anchorY+14; if(left+rect.width>window.innerWidth-margin)left=anchorX-rect.width-14; if(top+rect.height>window.innerHeight-margin)top=anchorY-rect.height-14;
    peek.style.left=clamp(left,margin,Math.max(margin,window.innerWidth-rect.width-margin))+'px'; peek.style.top=clamp(top,60,Math.max(60,window.innerHeight-rect.height-margin))+'px';
    clearTimeout(peekTimer); peekTimer=setTimeout(hideTokenPeek,5000);
  }
  function refreshTokenPeek(t) { const peek=$('#token-peek'); if(!peek.hidden&&peek.dataset.tokenId===t.id)populateTokenPeek(t); }
  function openDetail(id) {
    const t=currentMap && currentMap.tokens.find(x=>x.id===id);
    if (!t || !ownedToken(t) || !Number.isFinite(Number(t.hp))) { closeDetail(); return; }
    hideTokenPeek();
    const alreadyCollected=!!t.ownedPieceId && t.ownerPlayerId===myPlayerId;
    $('#player-collect-token').textContent=alreadyCollected?'查看对应收藏':'收入我的小棋子库';
    selectedId=id; $('#detail').hidden=false; $('#detail-empty').hidden=true;$('#right-panel').classList.add('mobile-open');
    renderMountedDetail(t);
    $('#detail-name').textContent=t.name; $('#detail-type').textContent=(TYPE[t.type]||TYPE.npc).label;
    const icon=$('#detail-icon'), hasPortrait=applyPlayerPortrait(icon,t); icon.textContent=hasPortrait?'':(t.icon||'?'); if(!hasPortrait)icon.style.backgroundImage='none';
    const deleteButton=$('#player-delete-token'),canDelete=t.playerCreated===true&&mine(t);deleteButton.hidden=!canDelete;deleteButton.disabled=playerDeletePending===t.id;deleteButton.textContent=playerDeletePending===t.id?'正在删除…':'删除这个临时棋子';
    $('#hp').value=t.hp; $('#hp-max').value=t.hpMax; $('#ac').value=t.ac;
    $('#temp-hp').value=t.tempHp||0; $('#temp-hp-track').hidden=!(t.tempHp>0); $('#temp-hp-fill').style.width=clamp((t.tempHp||0)/Math.max(1,t.tempHpMax ?? t.tempHp)*100,0,100)+'%'; $('#temp-hp-max').value=t.tempHpMax??t.tempHp??0; $('#temp-hp-summary').textContent=(t.tempHp||0)+' / '+(t.tempHpMax??t.tempHp??0);
    const editable=canActWithToken(t), hpEditable=ownedToken(t), e=encounter();
    const portraitVariants=playerPortraitVariants(t),portraitSelect=$('#player-portrait');portraitSelect.replaceChildren(new Option((t.iconImgPath||t.iconImg||t.iconImgHd||t.iconImgId)?'当前自定义立绘':'文字图标',''));
    portraitVariants.forEach((v,i)=>portraitSelect.add(new Option(v.name,String(i))));
    const selectedPortrait=currentPortraitVariantIndex(t,portraitVariants);if(selectedPortrait>=0)portraitSelect.value=String(selectedPortrait);
    portraitSelect.disabled=!editable||portraitSelect.options.length<2;
    $('#player-portrait-manager-open').disabled=false;
    $('#player-appearance-status').textContent=(editable?'当前：':'只读：')+portraitSelect.options[portraitSelect.selectedIndex].textContent+' · '+portraitVariants.length+' 个已保存形态';
    $('#hp').disabled=!hpEditable; $('#hp-max').disabled=!hpEditable; $('#ac').disabled=!editable; $('#temp-hp').disabled=!hpEditable; $('#temp-hp-max').disabled=!hpEditable;
    document.querySelectorAll('[data-hp]').forEach(b=>b.disabled=!hpEditable);
    document.querySelectorAll('[data-temp-hp]').forEach(b=>b.disabled=!hpEditable);
    const tempUndoReady=hpEditable&&playerTempHpUndo&&playerTempHpUndo.tokenId===t.id&&playerTempHpUndo.mapId===currentMap?.id&&Number(t.tempHp||0)===playerTempHpUndo.after.tempHp&&Number(t.tempHpMax??t.tempHp??0)===playerTempHpUndo.after.tempHpMax;
    $('#temp-hp-undo').disabled=!tempUndoReady;
    $('#ac-hint').textContent='生命值随时可调整 · 护甲：'+(editable?(e.playMode==='turn'?'✓ 当前回合可修改':e.playMode==='prepare'?'战斗准备阶段可修改':'自由模式可修改'):(e.playMode==='turn'?'🔒 等待你的回合':'请先加入房间'));
    syncSpellRangeUi(t,editable);requestSpellRangeRender();
    const pct=clamp((t.hp/Math.max(1,t.hpMax))*100,0,100); $('#hp-bar').style.width=pct+'%'; $('#hp-bar').style.background=pct>50?'#4cc38a':pct>25?'#f4a261':'#e74c5e';
    renderPlayerConditions(t,editable);
    const note=$('#detail-public-note'); note.hidden=!t.publicNote; note.textContent=t.publicNote||'';
  }
  $('#player-portrait').addEventListener('change',e=>{
    const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId);
    if(!t||!ownedToken(t)||!canActWithToken(t)||e.target.value==='')return;
    const index=Number(e.target.value);if(!playerPortraitVariants(t)[index])return;
    sendPatch(t.id,{portraitVariant:index,portraitVariantSource:playerPortraitVariants(t)[index]},{});
  });
  function updateOwned(field,value) { const t=currentMap && currentMap.tokens.find(x=>x.id===selectedId); if (!t || !ownedToken(t)) return; if(!['hp','hpMax','tempHp','tempHpMax'].includes(field)&&!canActWithToken(t)){openDetail(t.id);toast('🔒 只有轮到该角色时才能修改');return;} const previous=t[field];t[field]=value;sendPatch(t.id,{[field]:value},{[field]:previous});renderNamesLayer(currentMap);openDetail(t.id); }
  function commitPlayerTempHp(t,nextHp,nextMax){
    if(!t||!ownedToken(t))return;
    const before={tempHp:clamp(Number(t.tempHp)||0,0,99999),tempHpMax:clamp(Number(t.tempHpMax??t.tempHp)||0,0,99999)};
    const after={tempHp:clamp(Number(nextHp)||0,0,99999),tempHpMax:clamp(Number(nextMax)||0,0,99999)};
    if(before.tempHp===after.tempHp&&before.tempHpMax===after.tempHpMax){openDetail(t.id);return;}
    playerTempHpUndo={tokenId:t.id,mapId:currentMap?.id||null,before,after};
    t.tempHp=after.tempHp;t.tempHpMax=after.tempHpMax;
    sendPatch(t.id,{tempHp:after.tempHp,tempHpMax:after.tempHpMax},before);
    renderNamesLayer(currentMap);openDetail(t.id);
  }
  function adjustPlayerTempHp(value){
    const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId);if(!t)return;
    const current=clamp(Number(t.tempHp)||0,0,99999),capacity=clamp(Number(t.tempHpMax??t.tempHp)||0,0,99999);
    const next=value==='full'?capacity:clamp(current+(parseInt(value,10)||0),0,capacity);
    commitPlayerTempHp(t,next,capacity);
  }
  function undoPlayerTempHp(){
    const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId),undo=playerTempHpUndo;
    if(!t||!ownedToken(t)||!undo||undo.tokenId!==t.id||undo.mapId!==currentMap?.id)return;
    if(Number(t.tempHp||0)!==undo.after.tempHp||Number(t.tempHpMax??t.tempHp??0)!==undo.after.tempHpMax){playerTempHpUndo=null;openDetail(t.id);toast('临时生命值已发生其他变化，不能撤销');return;}
    const current={tempHp:Number(t.tempHp)||0,tempHpMax:Number(t.tempHpMax??t.tempHp)||0};
    t.tempHp=undo.before.tempHp;t.tempHpMax=undo.before.tempHpMax;playerTempHpUndo=null;
    sendPatch(t.id,{tempHp:t.tempHp,tempHpMax:t.tempHpMax},current);
    renderNamesLayer(currentMap);openDetail(t.id);toast('已撤销临时生命值变化');
  }
  function setTokenPosition(t,x,y) {
    const anchor=movementAnchor(t,currentMap);
    if(!anchor)return null;
    anchor.x=x; anchor.y=y; syncMountedCoordinates(anchor,currentMap);
    const el=document.querySelector('.token[data-id="'+anchor.id+'"]');
    if(el){el.style.left=anchor.x+'px';el.style.top=anchor.y+'px';}
    syncLabelsFor(anchor);
    requestSpellRangeRender();
    return anchor;
  }
  function rollbackMove(move) {
    const e=encounter();
    if(move.turnMode&&Number(e.turnSerial)!==Number(move.turnSerial))return;
    const m=state&&(state.maps||[]).find(x=>x.id===move.mapId), t=m&&(m.tokens||[]).find(x=>x.id===move.tokenId);
    if(t&&(!move.endXWorld||Math.abs(Number(t.x)-move.endXWorld)<.01)&&(!move.endYWorld||Math.abs(Number(t.y)-move.endYWorld)<.01)){setTokenPosition(t,move.startXWorld,move.startYWorld);renderTokens(m);}
    renderTurnPath();
  }
  function sendMove(t,move) {
    if (!myName || !currentMap || !t) return;
    move.endXWorld=Number(t.x); move.endYWorld=Number(t.y);
    const action={op:'moveToken',mapId:move.mapId,tokenId:t.id,x:t.x,y:t.y,playMode:move.turnMode?'turn':'free'};
    if(move.turnMode){action.turnSerial=move.turnSerial;action.path=move.pathPoints.slice(0,MAX_MOVE_POINTS);}
    requestAction(action)
      .then(result=>{
        const d=result.data||{};
        if(!result.ok||d.ok===false){rollbackMove(move);toast('⚠ '+(d.error||'移动失败'));return;}
      })
      .catch(()=>{rollbackMove(move);toast('⚠ 移动未送达');});
  }
  function parseDice(expr) { const m=String(expr||'').trim().toLowerCase().match(/^(\d*)d(\d+)([+-]\d+)?$/); if (!m) return null; const n=+(m[1]||1), sides=+m[2], mod=+(m[3]||0); return n>0&&n<=100&&sides>=2&&sides<=1000?{n,sides,mod,label:m[0]}:null; }
  function rollSet(count,sides) { return Array.from({length:count},()=>1+Math.floor(Math.random()*sides)); }
  function d20CriticalOutcome(parsed,chosen,rollMode,pick,dicePayload){if(!parsed||parsed.n!==1||parsed.sides!==20)return{natural:null,critical:null};const natural=rollMode?Number(dicePayload[pick]):Number(chosen[0]);return{natural,critical:natural===20?'success':natural===1?'fail':null};}
  let playerDiceLoad=null;
  function loadPlayerScript(src) {
    return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=()=>resolve();script.onerror=()=>{script.remove();reject(new Error('骰子动画加载失败'));};document.head.appendChild(script);});
  }
  function ensurePlayerDice() {
    if(window.playDieAnimation&&window.SundollDiceSkins)return Promise.resolve();
    if(!playerDiceLoad)playerDiceLoad=(async()=>{if(!window.THREE)await loadPlayerScript('vendor/three.min.js');await loadPlayerScript('shared/dice.js?v=20260922-mixed-dice-v14');})().catch(error=>{playerDiceLoad=null;throw error;});
    return playerDiceLoad;
  }
  function playPlayerDice(...args) {
    if(window.playDieAnimation){window.playDieAnimation(...args);return;}
    ensurePlayerDice().then(()=>window.playDieAnimation(...args)).catch(()=>toast(args[1]+' → '+args[2]+'（动画暂时无法加载）'));
  }
  function currentDiceSkin(){if(window.SundollDiceSkins?.get)return window.SundollDiceSkins.get();try{return localStorage.getItem('sundoll-dice-skin-v1')||'obsidian';}catch(error){return'obsidian';}}
  function setDiceVisibility(value,persist=true){diceVisibility=value==='private'?'private':'public';document.querySelectorAll('[data-dice-visibility]').forEach(button=>{const active=button.dataset.diceVisibility===diceVisibility;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});if(persist){try{localStorage.setItem('sundoll-dice-visibility-v1',diceVisibility);}catch(e){}}}
  function roll(expr,mode=0) {
    const d=parseDice(expr); if(!d){toast('骰子格式如 2d6+3');return;} const isPublic=diceVisibility==='public'; if(isPublic&&!sessionToken){toast('请先加入房间');return;}
    const rollMode=(mode===1||mode===-1)&&d.n===1&&d.sides===20?mode:0, first=rollSet(d.n,d.sides); let second=null, chosen=first, pick;
    if(rollMode){second=rollSet(d.n,d.sides);const sumA=first.reduce((a,b)=>a+b,0),sumB=second.reduce((a,b)=>a+b,0);pick=rollMode===1?(sumA>=sumB?0:1):(sumA<=sumB?0:1);chosen=pick===0?first:second;}
    const total=chosen.reduce((a,b)=>a+b,0)+d.mod, label=d.label+(rollMode===1?' ⚖️优势':rollMode===-1?' ⬇️劣势':''), note=second?'（两次 '+first.reduce((a,b)=>a+b,0)+' / '+second.reduce((a,b)=>a+b,0)+'，取'+(rollMode===1?'大':'小')+'）':'', dice=second?[first[0],second[0]]:chosen.slice(), outcome=d20CriticalOutcome(d,chosen,rollMode,pick,dice), criticalText=outcome.critical==='success'?' · 天然 20，大成功！':outcome.critical==='fail'?' · 天然 1，大失败！':'', detail=chosen.join(' + ')+(d.mod?(d.mod>0?' + ':' ')+d.mod:'')+note+criticalText, rid='r'+Date.now()+Math.random().toString(36).slice(2,8), skin=currentDiceSkin();
    playPlayerDice(d.sides,label,total,{dice,pick,mode:rollMode,natural:outcome.natural,critical:outcome.critical,skin,interrupt:true,visibility:isPublic?'public':'private'});
    if(!isPublic)return;
    localRolls.add(rid); if(localRolls.size>30)localRolls.delete(localRolls.values().next().value); addRoll(myName||'我',label,detail,total);
    requestAction({op:'roll',rid,name:myName||'玩家',expr:label,detail,total,sides:d.sides,dice,pick,mode:rollMode,natural:outcome.natural,critical:outcome.critical,skin,visibility:'public'}).then(r=>{if(!r.ok||r.data?.ok===false){localRolls.delete(rid);toast('⚠ '+(r.data?.error||'掷骰未送达'));}}).catch(()=>{localRolls.delete(rid);toast('⚠ 掷骰未送达');});
  }
  function addRoll(who,expr,detail,total) { const row=document.createElement('div'); row.className='roll-line'; row.innerHTML='<span class="roll-who">'+esc(who)+'</span><span>'+esc(expr)+'</span><span>'+esc(detail)+'</span><span class="roll-total">'+total+'</span>'; $('#dice-log').prepend(row); while($('#dice-log').children.length>30) $('#dice-log').lastChild.remove(); $('#dice-result').textContent=expr+' → '+total; }
  function applyAction(a) {
    if(a?.campaignId!=null && a.campaignId!==state?.campaignId)return;
    if(a?._sessionId && a._sessionId!==state?._sessionId)return;
    if (!a) return;
    if(a.characterUpdates)for(const update of a.characterUpdates)applyAction(update);
    if(a.op==='characterState'){for(const m of state?.maps||[])for(const t of m.tokens||[])if(t.ownedPieceId===a.characterId&&t.ownerPlayerId===a.ownerPlayerId&&(t.characterRevision||0)<a.patch.characterRevision){Object.assign(t,a.patch);const form=Number.isInteger(a.patch.portraitVariant)?normalizePlayerPortraitVariants(t.portraitVariants)[a.patch.portraitVariant]:null;if(form)for(const key of ['iconImgPath','iconImg','iconImgHd','iconImgId'])t[key]=form[key]||null;SundollDownedPortrait.sync(t);}if(currentMap)renderTokens(currentMap);if(selectedId)openDetail(selectedId);return;}
    if(a.op==='journalEdit'){if(state&&state.campaignId===a.campaignId){const journal=CampaignJournal.normalize(a.journal,state.campaignId);if((state.journal?.revision||0)<journal.revision)state.journal=journal;CampaignJournal.refresh();}return;}
    if(a.op==='danmaku'){danmaku.receive(a);return;}
    if(a.op==='restTransition'){playRestTransition(a);return;}
    if(a.op==='mapReaction'){
      if(a.reactionId&&localReactionIds.has(a.reactionId)){localReactionIds.delete(a.reactionId);return;}
      showMapReaction(a);return;
    }
    if(a.op==='doodleAdd'){
      const map=doodleMap(a.mapId);if(!map||!a.stroke||!a.stroke.id)return;if(!Array.isArray(map.doodles))map.doodles=[];const stroke=cloneDoodleStroke(a.stroke),index=map.doodles.findIndex(item=>item&&item.id===stroke.id);if(index>=0)map.doodles[index]=stroke;else map.doodles.push(stroke);if(currentMap&&currentMap.id===map.id)renderDoodles();return;
    }
    if(a.op==='doodleDelete'){
      const map=doodleMap(a.mapId);if(!map||!a.doodleId)return;map.doodles=(map.doodles||[]).filter(stroke=>stroke&&stroke.id!==a.doodleId);if(currentMap&&currentMap.id===map.id)renderDoodles();return;
    }
    if(a.op==='doodleClear'){
      const map=doodleMap(a.mapId);if(!map)return;map.doodles=[];if(currentMap&&currentMap.id===map.id)renderDoodles();return;
    }
    if(a.op==='bindOwnedPiece'&&a.ownership){
      const token=(state?.maps||[]).flatMap(map=>map.tokens||[]).find(t=>t.id===a.tokenId);
      if(token){Object.assign(token,a.ownership);if(currentMap)renderTokens(currentMap);}return;
    }
    if(a.op==='recallOwnedPiece'){
      for(const map of state?.maps||[]){
        const removed=(map.tokens||[]).find(t=>t.ownedPieceId===a.ownedPieceId);
        map.tokens=(map.tokens||[]).filter(t=>t.ownedPieceId!==a.ownedPieceId);
        if(removed){map.tokens.forEach(t=>{if(t.mountId===removed.id)t.mountId=null;});if(selectedId===removed.id)closeDetail();}
      }
      if(a.encounter)state.encounter=a.encounter;
      if(currentMap){renderTokens(currentMap);renderTurnPath();requestSpellRangeRender();}renderFlow(state);updateEndTurnUi();return;
    }
    if(a.op==='releaseOwnedPiece'){
      const maps=state&&Array.isArray(state.maps)?state.maps:[],map=maps.find(item=>item.id===a.mapId),raw=a.token,ownedPieceId=String(a.ownedPieceId||'');if(!map||!raw||!raw.id||raw.ownedPieceId!==ownedPieceId)return;
      let removedSelected=false,touchedCurrent=false;maps.forEach(item=>{if(!Array.isArray(item.tokens))item.tokens=[];const removed=item.tokens.find(token=>token&&token.ownedPieceId===ownedPieceId);if(removed){removedSelected=selectedId===removed.id;touchedCurrent=touchedCurrent||item===currentMap;item.tokens=item.tokens.filter(token=>!token||token.ownedPieceId!==ownedPieceId);item.tokens.forEach(token=>{if(token&&token.mountId===removed.id)token.mountId=null;});}});
      const token={...raw,spellRange:normalizeSpellRange(raw.spellRange),conditions:Array.isArray(raw.conditions)?raw.conditions.map(normalizePlayerCondition):[]};map.tokens.push(token);if(state.parkedOwnedPieces&&typeof state.parkedOwnedPieces==='object')delete state.parkedOwnedPieces[ownedPieceId];
      if(touchedCurrent||map===currentMap){renderTokens(currentMap);renderTurnPath();requestSpellRangeRender();}
      if(mine(token)&&map===currentMap){selectedId=token.id;openDetail(token.id);}else if(removedSelected){closeDetail();}
      toast((a.actor===myPlayerId?'已释放「':'♟ '+(displayPlayerName(a.displayName||a.name||a.actor))+' 释放了「')+(token.name||'棋子')+'」');return;
    }
    if(a.op==='spawnToken'){
      const map=state&&(state.maps||[]).find(item=>item.id===a.mapId),raw=a.token;if(!map||!raw||!raw.id)return;
      let token=(map.tokens||[]).find(item=>item.id===raw.id);
      if(!token){token={...raw,spellRange:normalizeSpellRange(raw.spellRange),conditions:[]};if(!Array.isArray(map.tokens))map.tokens=[];map.tokens.push(token);}
      if(currentMap&&currentMap.id===map.id)renderTokens(map);
      if(mine(token)){selectedId=token.id;openDetail(token.id);updatePlayerPlaceUi('已放置「'+token.name+'」');}
      toast('♟ '+(displayPlayerName(a.displayName||a.actor,tokenOwnerName(token)))+' 放置了「'+token.name+'」');return;
    }
    if(a.op==='deletePlayerToken'){
      const map=state&&(state.maps||[]).find(item=>item.id===a.mapId);if(!map)return;const token=(map.tokens||[]).find(item=>item.id===a.tokenId),tokenName=a.tokenName||(token&&token.name)||'临时棋子';
      (map.tokens||[]).forEach(item=>{if(item&&item.mountId===a.tokenId)item.mountId=null;});map.tokens=(map.tokens||[]).filter(item=>item&&item.id!==a.tokenId);
      const e=encounter(),removed=new Set(Array.isArray(a.removedEntryIds)?a.removedEntryIds:[]);if(Array.isArray(e.entries))e.entries=e.entries.filter(entry=>entry&&entry.tokenId!==a.tokenId&&!removed.has(entry.id));
      if(['free','prepare','turn'].includes(a.playMode))e.playMode=a.playMode;e.currentEntryId=a.currentEntryId||null;e.round=Math.max(1,Number(a.round)||1);e.turnSerial=Math.max(1,Number(a.turnSerial)||Number(e.turnSerial)||1);e.turnPath={mapId:null,tokenId:null,points:[],segmentEnds:[]};
      const wasSelected=selectedId===a.tokenId;if(map===currentMap){renderTokens(map);renderTurnPath();requestSpellRangeRender();}renderFlow(state);updateEndTurnUi();if(wasSelected)closeDetail();else if(selectedId)openDetail(selectedId);
      toast((a.actor===myPlayerId?'已删除「':'♟ '+(a.displayName||'玩家')+' 删除了「')+tokenName+'」');return;
    }
    if(a.op==='mountToken'){
      const map=state&&(state.maps||[]).find(item=>item.id===a.mapId),rider=map&&(map.tokens||[]).find(item=>item.id===a.tokenId),mount=map&&(map.tokens||[]).find(item=>item.id===a.mountId);if(!map||!rider||!mount)return;
      if(!rider.mountId||rider.mountId===mount.id)rider.mountId=mount.id;rider.x=Number.isFinite(Number(a.x))?Number(a.x):mount.x;rider.y=Number.isFinite(Number(a.y))?Number(a.y):mount.y;syncMountedCoordinates(mount,map);
      const e=encounter();if(Array.isArray(a.initiativeEntries))e.entries=a.initiativeEntries.map(entry=>({...entry}));if(['free','prepare','turn'].includes(a.encounterPlayMode))e.playMode=a.encounterPlayMode;e.currentEntryId=a.currentEntryId||null;e.round=Math.max(1,Number(a.round)||1);e.turnSerial=Math.max(1,Number(a.turnSerial)||Number(e.turnSerial)||1);if(a.turnPath&&typeof a.turnPath==='object'){const points=Array.isArray(a.turnPath.points)?a.turnPath.points.map(point=>({x:Number(point.x),y:Number(point.y)})).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)):[];e.turnPath={mapId:a.turnPath.mapId||null,tokenId:a.turnPath.tokenId||null,points,segmentEnds:normalizeTurnPathSegmentEnds(a.turnPath.segmentEnds,points.length)};}
      if(map===currentMap){renderTokens(map);renderTurnPath();requestSpellRangeRender();}renderFlow(state);updateEndTurnUi();if(selectedId)openDetail(selectedId);
      toast((a.actor===myPlayerId?'你':a.displayName||'玩家')+'让「'+(a.riderName||rider.name||'骑手')+'」骑上了「'+(a.mountName||mount.name||'坐骑')+'」');return;
    }
    if(a.op==='dismountToken'){
      const map=state&&(state.maps||[]).find(item=>item.id===a.mapId),rider=map&&(map.tokens||[]).find(item=>item.id===a.tokenId);if(!map||!rider)return;
      if(!rider.mountId||rider.mountId===a.mountId)rider.mountId=null;
      if(Number.isFinite(a.x)&&Number.isFinite(a.y)){rider.x=a.x;rider.y=a.y;}
      const e=encounter(),entryIds=new Set(Array.isArray(a.initiativeEntryIds)?a.initiativeEntryIds.map(String):[]);(e.entries||[]).forEach(entry=>{if(entry&&entryIds.has(String(entry.id))){entry.tokenId=rider.id;entry.name=rider.name||entry.name;entry.color=a.riderColor||(TYPE[rider.type]||TYPE.npc).ring;}});
      if(a.turnPathTransferred===true&&e.turnPath&&e.turnPath.mapId===map.id&&e.turnPath.tokenId===a.mountId)e.turnPath.tokenId=rider.id;
      if(map===currentMap){renderTokens(map);renderTurnPath();requestSpellRangeRender();}renderFlow(state);updateEndTurnUi();if(selectedId)openDetail(selectedId);
      toast((a.actor===myPlayerId?'你':a.displayName||'玩家')+'让「'+(a.riderName||rider.name||'骑手')+'」解除了骑乘');return;
    }
    if(a.op==='initiativeSwap'){
      if(!applyFlowInitiativeAction(encounter(),a))return;
      renderFlow(state);updateEndTurnUi();return;
    }
    if(a.op==='turnPathUndo'||a.op==='turnPathReset'){
      const e=encounter(),currentMode=e.playMode==='turn'?'turn':'free';
      if(currentMode!=='turn'||a.playMode!=='turn'||Number(a.turnSerial)!==Number(e.turnSerial)||!Array.isArray(a.path)||!a.path.length)return;
      const m=state&&(state.maps||[]).find(x=>x.id===a.mapId),t=m&&(m.tokens||[]).find(x=>x.id===a.tokenId);if(!t)return;
      const points=a.path.slice(0,MAX_TURN_PATH_POINTS).map(p=>({x:Number(p&&p.x),y:Number(p&&p.y)})).filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));if(!points.length)return;
      setTokenPosition(t,Number(a.x),Number(a.y));e.turnPath={mapId:m.id,tokenId:t.id,points,segmentEnds:normalizeTurnPathSegmentEnds(a.segmentEnds,points.length)};
      if(m===currentMap)renderTokens(m);renderTurnPath();updateEndTurnUi();if(a.actor===myPlayerId)toast(a.op==='turnPathUndo'?'↶ 已撤销上一次移动':'⟲ 已重置到本回合起点');return;
    }
    if (a.op==='endTurn') {
      const e=encounter(); if(Number(e.turnSerial)!==Number(a.turnSerial))return; decrementCurrentTokenConditions(); e.currentEntryId=a.nextEntryId; e.round=Number(a.round)||e.round; e.turnSerial=Number(a.nextTurnSerial)||e.turnSerial+1; e.turnPath={mapId:null,tokenId:null,points:[],segmentEnds:[]}; if(e.worldTime){if(Number.isFinite(Number(a.worldTimeSeconds)))e.worldTime.totalSeconds=Math.max(0,Math.trunc(Number(a.worldTimeSeconds)));e.worldTime.runningSince=null;}if(a.weather&&typeof a.weather==='object')e.weather=Object.assign({},e.weather||{},a.weather); renderFlow(state); renderTokens(currentMap); renderTurnPath(); if(selectedId)openDetail(selectedId); toast((displayPlayerName(a.displayName||a.name||a.actor))+' 已结束回合'); return;
    }
    if (a.op==='roll') { if(a.rid && localRolls.has(a.rid)){localRolls.delete(a.rid);return;} addRoll(displayPlayerName(a.displayName||a.name||a.actor),a.expr||'',a.detail||'',a.total); playPlayerDice(a.sides||20,a.expr||'',a.total,{dice:a.dice,extraDice:a.extraDice,detail:a.detail,pick:a.pick,mode:a.mode,natural:a.natural,critical:a.critical,skin:a.skin,interrupt:a.rollSequence!==true,visibility:'public'}); return; }
    if (a.op==='announce') { toast('📣 '+(a.text||'GM 发布了一条公告')); return; }
    if(a.op==='moveToken'||a.op==='patchToken'){
      const e=encounter(),currentMode=e.playMode==='turn'?'turn':'free',actionMode=a.playMode==='turn'?'turn':a.playMode==='free'?'free':null;
      if(actionMode&&actionMode!==currentMode)return;
      if(currentMode==='turn'&&Number(a.turnSerial)!==Number(e.turnSerial))return;
    }
    const m=state && (state.maps||[]).find(x=>x.id===(a.mapId||currentMap&&currentMap.id)); const t=m && (m.tokens||[]).find(x=>x.id===a.tokenId); if(!t) return;
    if (a.op==='moveToken') {
      setTokenPosition(t,a.x,a.y);
      const e=encounter();
      if(e.playMode==='turn'&&Number(a.turnSerial)===Number(e.turnSerial)&&Array.isArray(a.path)) appendTurnPath(m.id,t.id,a.path);
      renderTurnPath();updateEndTurnUi();
    }
    if (a.op==='patchToken') {
      const patch=a.patch||{};
      const portraitVariantsChanged=Array.isArray(patch.portraitVariants);if(portraitVariantsChanged)t.portraitVariants=normalizePlayerPortraitVariants(patch.portraitVariants);
      const portraitChanged=Number.isInteger(patch.portraitVariant)&&!!t.portraitVariants?.[patch.portraitVariant];
      if(portraitChanged){const v=t.portraitVariants[patch.portraitVariant];for(const k of ['iconImgPath','iconImg','iconImgHd','iconImgId'])t[k]=v[k]||null;t.portraitVariant=patch.portraitVariant;}
      else if(Object.prototype.hasOwnProperty.call(patch,'portraitVariant'))delete t.portraitVariant;
      const conditionsChanged=Array.isArray(patch.conditions);['hp','hpMax','tempHp','tempHpMax','ac'].forEach(k=>{if(k in patch)t[k]=patch[k];});if('spellRange' in patch)t.spellRange=normalizeSpellRange(patch.spellRange);if(conditionsChanged)t.conditions=patch.conditions.slice(0,MAX_TOKEN_CONDITIONS).map(normalizePlayerCondition);
      if('portraitBeforeDowned' in patch)t.portraitBeforeDowned=patch.portraitBeforeDowned||null;
      const automaticPortraitChanged=SundollDownedPortrait.sync(t);
      if(m===currentMap){if(conditionsChanged||portraitChanged||portraitVariantsChanged||automaticPortraitChanged)renderTokens(currentMap);else renderNamesLayer(currentMap);requestSpellRangeRender();}
      const selected=currentMap&&selectedId&&(currentMap.tokens||[]).find(token=>token.id===selectedId);if(selected&&tokenControlGroup(selected).has(t.id))openDetail(selected.id);refreshTokenPeek(t);
      refreshTokenInvestigation(t);if(playerPortraitManagerTokenId===t.id)renderPlayerPortraitManager();
    }
  }

  board.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    hideTokenContextMenu();hideTokenInvestigation();
    if(e.target.closest('button')) return;
    e.preventDefault();
    if(pendingMapReaction&&placePlayerReactionAt(e))return;
    if(spellAimTokenId&&beginPlayerSpellAim(e))return;
    if(doodleTool&&currentMap){
      if(!sessionToken){toast('请先加入房间');return;}hideTokenPeek();const p=boundedDoodlePoint(point(e));board.setPointerCapture(e.pointerId);
      if(doodleTool==='eraser'){drag={kind:'doodle-erase',mapId:currentMap.id,erased:new Set()};eraseDoodleAt(p,drag.erased);}else{startDoodleAt(p);drag={kind:'doodle',mapId:currentMap.id};}return;
    }
    if(measureMode&&currentMap){ const p=snapMeasurePoint(point(e)); measureDraft={mapId:currentMap.id,from:p,to:p}; drag={kind:'measure'}; board.setPointerCapture(e.pointerId); renderTurnPath(); return; }
    const riderEl=e.target.closest('.rider'), token=e.target.closest('.token');
    if(token){
      const selected=currentMap && currentMap.tokens.find(x=>x.id===(riderEl?riderEl.dataset.id:token.dataset.id));
      if(!selected)return;
      const mover=movementAnchor(selected,currentMap);
      if(ownedToken(selected)&&Number.isFinite(Number(selected.hp))){activatePlayerDetailTab('status');openDetail(selected.id);}
      else if(friendly(selected)&&Number.isFinite(Number(selected.hp)))showTokenPeek(selected,e.clientX,e.clientY);
      else hideTokenPeek();
      if(!canMoveToken(mover)){
        if(ownedToken(mover)&&encounter().playMode==='turn') toast('⚠ 尚未轮到该角色');
        return;
      }
      board.setPointerCapture(e.pointerId);
      drag={kind:'token',id:mover.id,mapId:currentMap.id,startX:e.clientX,startY:e.clientY,startXWorld:mover.x,startYWorld:mover.y,turnMode:encounter().playMode==='turn',turnSerial:Number(encounter().turnSerial)||1,pathRecording:encounter().playMode==='turn',pathPoints:[{x:mover.x,y:mover.y}]};
      token.classList.add('dragging');
      return;
    }
    hideTokenPeek();
    drag={kind:'pan',x:e.clientX,y:e.clientY,ox:view.ox,oy:view.oy}; board.setPointerCapture(e.pointerId);
  });
  board.addEventListener('contextmenu',e=>{
    const rider=e.target.closest('.rider'),token=e.target.closest('.token');if(!token)return;e.preventDefault();
    const selected=tokenById(rider?rider.dataset.id:token.dataset.id);if(!selected)return;hideTokenPeek();hideTokenInvestigation();showTokenContextMenu(selected,e.clientX,e.clientY);
  });
  board.addEventListener('pointermove',e=>{
    if(!drag || !currentMap) return;
    if(drag.kind==='token')window.TravelBasket?.hover(e.clientX,e.clientY);
    if(drag.kind==='spell-aim'){previewPlayerSpellAimAt(e);return;}
    if(drag.kind==='doodle'){continueDoodleAt(point(e));return;}
    if(drag.kind==='doodle-erase'){eraseDoodleAt(point(e),drag.erased);return;}
    if(drag.kind==='pan'){view.ox=drag.ox+e.clientX-drag.x;view.oy=drag.oy+e.clientY-drag.y;applyView();return;}
    if(drag.kind==='measure'){ if(measureDraft){measureDraft.to=snapMeasurePoint(point(e));renderTurnPath();} return; }
    if(drag.kind==='token'){
      const t=currentMap.tokens.find(x=>x.id===drag.id);if(!t)return;
      const p=point(e), q=state.snap===false?p:snap(p.x,p.y,t);setTokenPosition(t,q.x,q.y);
      if(drag.pathRecording){
        recordTurnDragPoint(drag,{x:t.x,y:t.y},currentMap.gridSize,state.snap!==false,p);
        renderTurnPath(drag.pathPoints);
      }
      return;
    }
  });
  function finish(e){
    if(!drag)return;
    const finished=drag;
    if(finished.kind==='spell-aim'){finishPlayerSpellAim(e,e.type==='pointercancel');return;}
    if(finished.kind==='doodle'){endDoodle();drag=null;return;}
    if(finished.kind==='doodle-erase'){drag=null;return;}
    if(finished.kind==='measure'){ renderTurnPath(); drag=null; return; }
    if(finished.kind==='token'){
      const t=currentMap&&currentMap.tokens.find(x=>x.id===finished.id);
      if(t && e.type!=='pointercancel' && window.TravelBasket?.containsPoint(e.clientX,e.clientY)){
        setTokenPosition(t,finished.startXWorld,finished.startYWorld);
        document.querySelector('.token[data-id="'+finished.id+'"]')?.classList.remove('dragging');
        drag=null;renderTurnPath();window.TravelBasket.drop(t,e.clientX,e.clientY);return;
      }
      if(t){sendMove(t,finished);const el=document.querySelector('.token[data-id="'+finished.id+'"]');if(el)el.classList.remove('dragging');}
      renderTurnPath();
    }
    drag=null;window.TravelBasket?.hover(-1,-1);
  }
  board.addEventListener('pointerup',finish); board.addEventListener('pointercancel',finish);
  board.addEventListener('wheel',e=>{e.preventDefault();if(!currentMap)return;const r=world.getBoundingClientRect(),wx=(e.clientX-r.left)/view.scale,wy=(e.clientY-r.top)/view.scale,ns=clamp(view.scale*Math.exp(-e.deltaY*.0012),.2,6);view.ox+=e.clientX-r.left-wx*ns;view.oy+=e.clientY-r.top-wy*ns;view.scale=ns;applyView();},{passive:false});
  $('#zoom-in').onclick=()=>{view.scale=clamp(view.scale*1.25,.2,6);applyView();}; $('#zoom-out').onclick=()=>{view.scale=clamp(view.scale/1.25,.2,6);applyView();}; $('#fit').onclick=fit;
  $('#player-place-token').addEventListener('click',placePlayerDraftToken);
  $('#player-token-image-pick').addEventListener('click',()=>$('#player-token-image').click());
  $('#player-token-image').addEventListener('change',event=>{const file=event.target.files&&event.target.files[0];event.target.value='';choosePlayerDraftPortrait(file);});
  $('#player-token-image-clear').addEventListener('click',()=>{playerDraftPortrait='';renderPlayerDraftPortrait();toast('已移除自带图片');});
  $('#player-delete-token').addEventListener('click',deleteOwnedTemporaryToken);
  $('#player-token-name').addEventListener('keydown',event=>{if(event.key==='Enter')placePlayerDraftToken();});
  $('#player-token-icon').addEventListener('keydown',event=>{if(event.key==='Enter')placePlayerDraftToken();});
  $('#detail-close').onclick=closeDetail;
  $('#token-investigate').addEventListener('click',()=>{const t=tokenById(contextTokenId);hideTokenContextMenu();if(t)showTokenInvestigation(t);});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#token-context-menu')&&!event.target.closest('#token-investigation'))hideTokenContextMenu();});
  $('#token-investigation').addEventListener('click',event=>{if(event.target===$('#token-investigation'))hideTokenInvestigation();});
  $('#player-portrait-manager-open').addEventListener('click',openPlayerPortraitManager);
  $('#player-portrait-manager-close').addEventListener('click',closePlayerPortraitManager);$('#player-portrait-manager-done').addEventListener('click',closePlayerPortraitManager);$('#player-portrait-save-current').addEventListener('click',savePlayerCurrentPortraitVariant);
  $('#player-portrait-manager-modal').addEventListener('click',event=>{if(event.target===$('#player-portrait-manager-modal'))closePlayerPortraitManager();});
  $('#player-portrait-strip').addEventListener('scroll',updatePlayerPortraitScrollButtons,{passive:true});
  $('#player-portrait-scroll-left').addEventListener('click',()=>$('#player-portrait-strip').scrollBy({left:-330,behavior:'smooth'}));$('#player-portrait-scroll-right').addEventListener('click',()=>$('#player-portrait-strip').scrollBy({left:330,behavior:'smooth'}));
  $('#player-portrait-strip').addEventListener('click',event=>{const action=event.target.closest('[data-player-portrait-action]');if(action){const index=Number(action.dataset.playerPortraitIndex),kind=action.dataset.playerPortraitAction;if(kind==='left')movePlayerPortraitVariant(index,-1);if(kind==='right')movePlayerPortraitVariant(index,1);if(kind==='rename')renamePlayerPortraitVariant(index);if(kind==='delete')deletePlayerPortraitVariant(index);return;}const select=event.target.closest('[data-player-portrait-select]');if(select){const t=playerPortraitManagerToken(),index=Number(select.dataset.playerPortraitSelect);if(t&&canActWithToken(t)&&playerPortraitVariants(t)[index])sendPatch(t.id,{portraitVariant:index,portraitVariantSource:playerPortraitVariants(t)[index]},{});}});
  document.querySelectorAll('[data-player-detail-tab]').forEach(button=>button.addEventListener('click',()=>activatePlayerDetailTab(button.dataset.playerDetailTab)));
  $('#hp').addEventListener('input',()=>updateOwned('hp',clamp(parseInt($('#hp').value,10)||0,0,99999)));
  $('#hp-max').addEventListener('input',()=>updateOwned('hpMax',clamp(parseInt($('#hp-max').value,10)||1,1,99999)));
  $('#ac').addEventListener('input',()=>updateOwned('ac',clamp(parseInt($('#ac').value,10)||0,0,99)));
  $('#temp-hp').addEventListener('change',()=>{const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId);if(t)commitPlayerTempHp(t,clamp(parseInt($('#temp-hp').value,10)||0,0,99999),t.tempHpMax??t.tempHp??0);});
  $('#temp-hp-max').addEventListener('change',()=>{const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId);if(t)commitPlayerTempHp(t,t.tempHp||0,clamp(parseInt($('#temp-hp-max').value,10)||0,0,99999));});
  document.querySelectorAll('[data-temp-hp]').forEach(button=>button.addEventListener('click',()=>adjustPlayerTempHp(button.dataset.tempHp)));
  $('#temp-hp-undo').addEventListener('click',undoPlayerTempHp);
  document.querySelectorAll('[data-hp]').forEach(b=>b.onclick=()=>{const t=currentMap&&currentMap.tokens.find(x=>x.id===selectedId);if(!t||!ownedToken(t))return;const v=b.dataset.hp,delta=parseInt(v,10)||0,absorbed=delta<0?Math.min(t.tempHp||0,-delta):0,previous={hp:t.hp,tempHp:t.tempHp||0};t.hp=v==='full'?t.hpMax:clamp(t.hp+delta+absorbed,0,t.hpMax);t.tempHp=(t.tempHp||0)-absorbed;sendPatch(t.id,{hp:t.hp,tempHp:t.tempHp},previous);renderNamesLayer(currentMap);openDetail(t.id);});
  try{setDiceVisibility(localStorage.getItem('sundoll-dice-visibility-v1')||'public',false);}catch(e){setDiceVisibility('public',false);}
  document.querySelectorAll('[data-dice-visibility]').forEach(button=>button.onclick=()=>setDiceVisibility(button.dataset.diceVisibility));
  document.querySelectorAll('[data-die]').forEach(b=>b.onclick=()=>roll(b.dataset.die)); $('#dice-adv').onclick=()=>roll('d20',1); $('#dice-dis').onclick=()=>roll('d20',-1); $('#dice-roll').onclick=()=>roll($('#dice-expr').value); $('#dice-expr').addEventListener('keydown',e=>{if(e.key==='Enter')roll($('#dice-expr').value);});
  $('#flow-toggle').onclick=()=>{const bar=$('#flowbar');bar.dataset.collapsed=bar.dataset.collapsed==='false'?'true':'false';renderFlow(state);};
  document.querySelectorAll('[data-flow-panel]').forEach(tab=>tab.onclick=()=>{flowPanel=tab.dataset.flowPanel==='time'?'time':'initiative';renderFlow(state);});
  function bindToolButton(id,fn){const el=$(id);if(el)el.onclick=fn;}
  bindToolButton('#player-map-browser-close',closePlayerMapBrowser);
  $('#player-map-browser-modal').addEventListener('click',event=>{if(event.target===$('#player-map-browser-modal'))closePlayerMapBrowser();});
  $('#player-map-chapter-tabs').addEventListener('click',event=>{const button=event.target.closest('[data-player-map-chapter]');if(!button)return;playerMapBrowserChapterId=button.dataset.playerMapChapter;renderPlayerMapBrowser();});
  $('#player-map-location-columns').addEventListener('click',event=>{const button=event.target.closest('[data-player-map-open]');if(button)switchPlayerMap(button.dataset.playerMapOpen);});
  bindToolButton('#btn-measure',toggleMeasure); bindToolButton('#dock-measure',toggleMeasure);
  bindToolButton('#btn-reaction',toggleReactionPalette);bindToolButton('#dock-reaction',toggleReactionPalette);
  document.querySelectorAll('#reaction-palette [data-map-reaction]').forEach(button=>button.addEventListener('click',()=>selectMapReaction(button.dataset.mapReaction)));
  document.querySelectorAll('[data-spell-shape]').forEach(button=>button.addEventListener('click',()=>updateOwnedSpellRange({shape:button.dataset.spellShape})));
  $('#spell-feet').addEventListener('input',event=>updateOwnedSpellRange({feet:Number(event.target.value)}));
  document.querySelectorAll('[data-spell-feet]').forEach(button=>button.addEventListener('click',()=>updateOwnedSpellRange({feet:Number(button.dataset.spellFeet)})));
  $('#spell-direction').addEventListener('input',event=>updateOwnedSpellRange({direction:Number(event.target.value)}));
  $('#spell-aim').addEventListener('click',toggleSpellAim);
  $('#player-condition-open').addEventListener('click',()=>openPlayerConditionEditor());
  $('#player-condition-close').addEventListener('click',closePlayerConditionEditor);$('#player-condition-cancel').addEventListener('click',closePlayerConditionEditor);$('#player-condition-save').addEventListener('click',savePlayerCondition);
  $('#player-condition-select').addEventListener('change',syncPlayerConditionCustomFields);$('#player-condition-turns').addEventListener('input',syncPlayerConditionDuration);
  document.querySelectorAll('[data-player-condition-duration]').forEach(button=>button.addEventListener('click',()=>setPlayerConditionDuration(button.dataset.playerConditionDuration)));
  $('#player-condition-custom-name').addEventListener('keydown',event=>{if(event.key==='Enter')savePlayerCondition();});$('#player-condition-turns').addEventListener('keydown',event=>{if(event.key==='Enter')savePlayerCondition();});
  document.querySelectorAll('[data-doodle-tool]').forEach(button=>button.addEventListener('click',()=>toggleDoodleTool(button.dataset.doodleTool)));
  document.querySelectorAll('[data-doodle-color]').forEach(button=>button.addEventListener('click',()=>{doodleColor=button.dataset.doodleColor;document.querySelectorAll('[data-doodle-color]').forEach(item=>item.classList.toggle('active',item===button));}));
  $('#player-doodle-width').addEventListener('change',event=>{doodleWidth=parseInt(event.target.value,10)||6;});
  $('#player-doodle-undo').addEventListener('click',undoSharedDoodle);$('#player-doodle-clear').addEventListener('click',clearSharedDoodles);
  bindToolButton('#btn-ready',()=>{presenceStatus=presenceStatus==='ready'?'online':'ready';sendPresence(presenceStatus);updateToolButtons();}); bindToolButton('#dock-ready',()=>$('#btn-ready').click());
  bindToolButton('#turn-path-undo',()=>runTurnPathAction('turnPathUndo'));bindToolButton('#turn-path-reset',()=>runTurnPathAction('turnPathReset'));
  bindToolButton('#end-turn',async()=>{
    if(endTurnPending)return;
    let e=encounter(),current=currentTurnToken();if(e.playMode!=='turn'||!current||!canActWithToken(current)){updateEndTurnUi();toast('🔒 还没有轮到你的角色');return;}
    endTurnPending=true;updateEndTurnUi();
    if(await dispatchPendingPatch()===false){endTurnPending=false;updateEndTurnUi();return;}
    e=encounter();current=currentTurnToken();if(e.playMode!=='turn'||!current||!canActWithToken(current)){endTurnPending=false;updateEndTurnUi();toast('⚠ 回合已经变化，请重新操作');return;}
    try{const r=await requestAction({op:'endTurn',turnSerial:Number(e.turnSerial)||1});if(!r.ok||r.data?.ok===false)toast('⚠ '+(r.data?.error||'结束回合失败'));await syncRoomState();}
    catch(error){toast('⚠ 结束回合未送达');await syncRoomState();}
    finally{endTurnPending=false;updateEndTurnUi();}
  });
  bindToolButton('#btn-left-panel',()=>$('#left-panel').classList.toggle('mobile-open'));
  bindToolButton('#btn-join',leaveSession);
  $('#player-name').addEventListener('change',savePlayerName);
  $('#player-name').addEventListener('blur',savePlayerName);
  $('#player-name').addEventListener('keydown',event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();savePlayerName();$('#player-name').blur();}else if(event.key==='Escape'){$('#player-name').value=myName;$('#player-name').blur();}});
  $('#join-mode-login').addEventListener('click',()=>setJoinMode(false));
  $('#join-mode-register').addEventListener('click',()=>setJoinMode(true));
  $('#join-form').addEventListener('submit',async e=>{e.preventDefault();if(joinPending)return;joinPending=true;const err=$('#join-error');err.dataset.state='';err.textContent='正在加入…';setJoinHomeBusy(true);try{await joinSession($('#join-name').value,$('#join-room').value,!!sessionToken);connectStream();}catch(error){err.textContent=error.message||'无法加入房间';setJoinHomeStatus('加入失败','error');}finally{joinPending=false;setJoinHomeBusy(false);}});
  $('#join-refresh').addEventListener('click',async()=>{const err=$('#join-error');err.textContent='正在刷新…';setJoinHomeBusy(true);try{await refreshPlayerHome();err.dataset.state='ok';err.textContent='房间状态已更新';}catch(error){setJoinHomeStatus('服务器未连接','error');err.dataset.state='';err.textContent=error.message||'刷新失败';}finally{setJoinHomeBusy(false);}});
  window.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!$('#player-map-browser-modal').hidden){closePlayerMapBrowser();return;}if(!$('#player-portrait-manager-modal').hidden){closePlayerPortraitManager();return;}hideTokenContextMenu();hideTokenInvestigation();if(pendingMapReaction||!$('#reaction-palette').hidden){cancelMapReaction();toast('已取消地图表情');}if(spellAimTokenId){cancelSpellAim();toast('已取消锥形瞄准');}});
  initPlayerWorkspaceTabs();activatePlayerDetailTab('status',false);populatePlayerConditionSelect();updateToolButtons();
  for(const event of ['pointerenter','focusin'])document.querySelector('.dice-grid')?.addEventListener(event,()=>ensurePlayerDice().catch(()=>{}),{once:true});
  window.addEventListener('resize',()=>{hideTokenContextMenu();hideTokenInvestigation();fit();});

  const playerMusic=SundollPlayerMusic.create({
    $,session:()=>sessionToken,playerId:()=>myPlayerId,
    serverNow:()=>flowClockAnchor.serverNow+(performance.now()-flowClockAnchor.localNow),
  });
  function applyBgm(action){return playerMusic.apply(action);}
  function applyPlayerWebRtcSignal(event){return playerMusic.signal(event);}
  function sendPlayerWebRtcSignal(signal){return playerMusic.send(signal);}
  function closePlayerLiveAudio(){playerMusic.reset();}
  async function syncMusicState(){
    const token=sessionToken;
    try{const response=await fetch('/api/music-state',{cache:'no-store'}),data=await response.json();
      if(token!==sessionToken)return;
      if(Number(data.serverNow))flowClockAnchor={localNow:performance.now(),serverNow:Number(data.serverNow)};
      if(response.ok&&data.bgm)applyBgm(data.bgm);
    }catch(_){}
  }
  async function syncRoomState(){try{const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok)return;render(await res.json());}catch(e){/* SSE 会继续自动重试 */}}
  function connectStream(){
    if(streamES){try{streamES.close();}catch(e){}}
    const source=new EventSource('/api/events');streamES=source;let initialStateTimer=null;
    source.onopen=()=>{
      if(streamES!==source)return;
      setConnection('已连接',true);sendPresence(presenceStatus);sendPlayerWebRtcSignal({type:'ready'}).catch(()=>{});
      clearTimeout(initialStateTimer);
      // SSE supplies the snapshot. Use HTTP only if that first snapshot is absent.
      initialStateTimer=setTimeout(()=>{if(streamES===source){syncRoomState();syncMusicState();}},8000);
    };
    source.onerror=()=>{clearTimeout(initialStateTimer);if(streamES===source)setConnection('重连中…',false);};
    source.onmessage=e=>{if(streamES!==source)return;try{
      const ev=JSON.parse(e.data),seq=Number(e.lastEventId)||Number(ev.seq)||0,instant=ev.type==='action'&&ev.action&&['roll','bgm','announce','mapReaction','restTransition','danmaku'].includes(ev.action.op);
      if(ev.type==='readingInvite'){PlayerBackpack.receiveReadingInvite(ev);return;}
      if(ev.type==='sessionRevoked'){handleSessionRevoked(ev);return;}
      if(ev.type==='webrtcSignal'){applyPlayerWebRtcSignal(ev);return;}
      if(ev.type==='state'){clearTimeout(initialStateTimer);render(ev.state);return;}
      if(ev.type==='action'&&((ev.action?.campaignId!=null&&ev.action.campaignId!==state?.campaignId)||(ev.action?._sessionId&&ev.action._sessionId!==state?._sessionId)))return;
      if(!instant&&seq&&seq<=streamAppliedSeq&&ev.type==='action')return;
      if(seq&&!instant)streamAppliedSeq=Math.max(streamAppliedSeq,seq);
      if(ev.type==='presence')renderPlayers(ev.players);
      else if(ev.type==='action'){if(ev.action&&ev.action.op==='bgm')applyBgm(ev.action);else applyAction(ev.action);}
    }catch(err){}};
  }

  initJoinHomeThemePicker();
  window.journalBridge={
    isDM:false,
    actorName:()=>myName||'玩家',
    canEdit:entry=>!!entry&&String(entry.author||'').trim()===String(myName||'').trim(),
    canDelete:entry=>!!entry&&String(entry.author||'').trim()===String(myName||'').trim(),
    worldTime:()=>state?.encounter ? flowWorldTotal(state.encounter) : null,
    read:()=>state?.journal,
    campaign:()=>state?.campaignId,
    mutate:async(mutation,revision,campaignId)=>{
    if(!sessionToken)throw new Error('请先加入房间');
    const response=await fetch('/api/journal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...mutation,revision,campaignId,sessionToken})});
    const data=await CampaignJournal.readSaveResponse(response);
    if(state?.campaignId!==campaignId)throw new Error('战役已切换');
    if((state.journal?.revision||0)<=data.journal.revision)state.journal=CampaignJournal.normalize(data.journal,campaignId);
    return {journal:state.journal,entryId:data.entryId};
  }};
  bootstrapSession();
  presenceTimer=setInterval(()=>sendPresence(presenceStatus),15000);
  flowTimer=setInterval(()=>{if(state?.encounter?.worldTime?.runningSince)refreshPlayerClock();},1000);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){clearTimeout(mapPreloadTimer);mapPreloadTimer=null;if(mapPreloadController)mapPreloadController.abort();}
    else{refreshPlayerClock();scheduleNextMapPreload();}
  });

  const playedLockChecks=new Set();
  async function playLockCheck(check,surface){
    const eventId=check.eventId||check.id;if(playedLockChecks.has(eventId))return;playedLockChecks.add(eventId);if(playedLockChecks.size>100)playedLockChecks.delete(playedLockChecks.values().next().value);
    const outcome=check.critical==='success'?'大成功':check.critical==='fail'?'大失败':check.success?'成功':'未成功',detail=MapItems.checkSummary(check),skin=currentDiceSkin();
    const steps=check.stage==='inspiration'
      ?[{sides:check.inspirationDie,dice:[check.inspirationRoll],total:check.total,label:'诗人激励 · '+outcome}]
      :[{sides:20,dice:check.dice||[check.natural],mode:check.mode||0,pick:check.pick||0,natural:check.natural,critical:check.critical,total:check.total,label:'巧手开锁 · '+outcome,extraDice:check.guidanceRoll?[{sides:4,value:check.guidanceRoll}]:[]}];
    steps.forEach((step,index)=>{
      const rid='lock-'+eventId+'-'+index;
      localRolls.add(rid);addRoll(myName||'我',step.label,detail,step.total);
      playPlayerDice(step.sides,step.label,step.total,{...step,detail,surface,sizeScale:3,skin,interrupt:check.stage!=='inspiration'&&index===0,visibility:'public'});
    });
    for(const [index,step] of steps.entries()){
      const rid='lock-'+eventId+'-'+index;
      await requestAction({op:'roll',rid,expr:step.label,detail,total:step.total,sides:step.sides,dice:step.dice,extraDice:step.extraDice,mode:step.mode,pick:step.pick,skin,checkType:'sleight',rollSequence:true,visibility:'public'}).then(r=>{if(!r.ok||r.data?.ok===false)toast('检定已保存，公开骰点暂未送达');}).catch(()=>toast('检定已保存，公开骰点暂未送达'));
    }
  }
  MapItems.configure({host:false,playCheck:playLockCheck,map:()=>currentMap,campaign:()=>state?.campaignId,world:()=>world,board:()=>document.getElementById('board'),zoom:()=>view.scale,session:()=>sessionToken,toast});
