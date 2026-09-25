// BEGIN BUNDLED MUSIC MODULE
/* Audio capture and peer connections have one lifecycle, independent of the file queue. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.SundollLiveAudio = { create: factory };
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLiveAudio(options) {
  'use strict';
  const env = options.env || globalThis;
  const peers = new Map();
  const rtcConfig = {iceServers:[{urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']}]};
  let request = 0, pending = false, capture = null, paused = false, label = '', error = '';
  const changed = () => options.changed?.();
  const isCurrent = (id, entry) => peers.get(id) === entry;
  const release = stream => stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  function status() {
    return {active:!!capture,pending,paused,label,error,connected:[...peers.values()].filter(e=>e.pc.connectionState==='connected').length,total:peers.size};
  }
  function closePeer(id, notify = false) {
    const entry = peers.get(id); if (!entry) return;
    peers.delete(id);
    entry.pc.onconnectionstatechange = null; entry.pc.onicecandidate = null;
    entry.pc.close();
    if (notify) options.signal(id,{type:'stop'}).catch(()=>{});
    changed();
  }
  async function createPeer(id) {
    if (!capture || !options.online() || !id || peers.has(id)) return;
    const stream = capture, pc = new env.RTCPeerConnection(rtcConfig), entry = {pc,ice:[]};
    peers.set(id,entry);
    // Display capture may include video; only audio tracks are ever sent to players.
    stream.getAudioTracks().forEach(track=>pc.addTrack(track,stream));
    pc.onicecandidate = event => {
      if (!isCurrent(id,entry) || !event.candidate) return;
      const candidate=event.candidate.toJSON?event.candidate.toJSON():event.candidate;
      options.signal(id,{type:'ice',...candidate}).catch(()=>{});
    };
    pc.onconnectionstatechange = () => {
      if (!isCurrent(id,entry)) return;
      if (pc.connectionState==='failed') { error='部分玩家连接失败，可点击重新连接'; closePeer(id); }
      changed();
    };
    try {
      const offer=await pc.createOffer(); if (!isCurrent(id,entry)) return;
      await pc.setLocalDescription(offer); if (!isCurrent(id,entry)) return;
      const result=await options.signal(id,{type:'offer',sdp:pc.localDescription.sdp});
      if (isCurrent(id,entry) && (!result.ok || result.data?.ok===false)) closePeer(id);
    } catch (_) { if (isCurrent(id,entry)) { error='连接玩家失败，可点击重新连接'; closePeer(id); } }
    changed();
  }
  function sync(players=options.players(), restart=false) {
    const ids=new Set((players||[]).filter(p=>p.online&&p.playerId).map(p=>p.playerId));
    for (const id of peers.keys()) if(restart||!ids.has(id)) closePeer(id);
    if(capture) ids.forEach(id=>createPeer(id));
    changed();
  }
  async function signal(event) {
    if(!capture || event?.target!=='host') return;
    const id=event.senderPlayerId, msg=event.signal||{};
    if(msg.type==='ready'){closePeer(id);await createPeer(id);return;}
    const entry=peers.get(id); if(!entry) return;
    try {
      if(msg.type==='answer'){
        await entry.pc.setRemoteDescription({type:'answer',sdp:msg.sdp});
        if(!isCurrent(id,entry))return;
        for(const candidate of entry.ice.splice(0))await entry.pc.addIceCandidate(candidate);
      }else if(msg.type==='ice'){
        const candidate={candidate:msg.candidate,sdpMid:msg.sdpMid??null,sdpMLineIndex:msg.sdpMLineIndex??null};
        if(entry.pc.remoteDescription)await entry.pc.addIceCandidate(candidate);else entry.ice.push(candidate);
      }else if(msg.type==='stop')closePeer(id);
    }catch(_){if(isCurrent(id,entry)){error='音频连接未完成，可点击重新连接';changed();}}
  }
  function cancelPending(){++request;pending=false;changed();}
  function stop({broadcast=true}={}) {
    ++request;pending=false;
    const wasActive=!!capture, stream=capture;capture=null;paused=false;
    release(stream);
    [...peers.keys()].forEach(id=>closePeer(id,true));
    if(wasActive)options.stopped?.(broadcast);
    changed();
  }
  async function start(kind='tab',deviceId='',deviceLabel='') {
    if(pending||capture)return;
    if(!options.online())throw new Error('请先开启联机');
    const media=env.navigator?.mediaDevices;
    if(!env.RTCPeerConnection||!media)throw new Error('请通过 localhost 或 HTTPS，在 Chrome / Edge 中打开主控台');
    if(kind==='device'&&!deviceId)throw new Error('请先选择接收音乐的输入设备');
    const token=++request;pending=true;error='';changed();
    let stream;
    try {
      if(kind==='device'){
        stream=await media.getUserMedia({video:false,audio:{deviceId:{exact:deviceId},echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:2}}});
      }else{
        if(!media.getDisplayMedia)throw new Error('此浏览器不支持声音共享，请使用 Chrome / Edge');
        stream=await media.getDisplayMedia({video:{displaySurface:kind==='system'?'monitor':'browser'},audio:true,
          systemAudio:kind==='system'?'include':'exclude',selfBrowserSurface:'exclude',surfaceSwitching:'exclude'});
      }
      if(token!==request||!options.online()){release(stream);if(token===request){pending=false;changed();}return;}
      if(!stream.getAudioTracks().length)throw new Error(kind==='device'?'所选设备没有可用音频':'没有取得声音。请勾选共享音频；若没有此选项，请使用音频输入设备。');
      capture=stream;pending=false;paused=false;
      label=kind==='device'?`外部音源 · ${deviceLabel||'音频输入'}`:kind==='system'?'系统声音直播':'标签页声音直播';
      stream.getTracks().forEach(track=>{track.onended=()=>{if(capture===stream)stop();};});
      options.started?.();
      sync();changed();
    }catch(e){
      release(stream);
      if(token!==request)return;
      capture=null;pending=false;
      error=e.name==='NotAllowedError'?'未获得声音共享权限':e.name==='AbortError'?'已取消选择音源':e.message||'音源连接失败';
      changed();throw new Error(error);
    }
  }
  function togglePause(){
    if(!capture)return;
    paused=!paused;capture.getAudioTracks().forEach(track=>{track.enabled=!paused;});
    options.command?.(paused?'pause':'play');changed();
  }
  async function inputs(authorize=false){
    const media=env.navigator?.mediaDevices;if(!media?.enumerateDevices)throw new Error('此浏览器无法列出输入设备，请使用 localhost 或 HTTPS');
    // Only the explicit device-permission button may request microphone access.
    if(authorize){const probe=await media.getUserMedia({audio:true,video:false});release(probe);}
    return (await media.enumerateDevices()).filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications');
  }
  return Object.freeze({status,start,stop,cancelPending,sync,signal,togglePause,inputs});
});

// END BUNDLED MUSIC MODULE

/* Music controller owns its queue, playback requests and live-audio peers.
 * The host supplies current campaign/room state through callbacks, never copied globals.
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.SundollHostMusic = { create: factory };
})(typeof globalThis !== 'undefined' ? globalThis : this, function createHostMusic(dependencies) {
  'use strict';
  const { $, toast, getState, isStreaming, getPlayers, serverApiBase, sendHostAction } = dependencies;
// BEGIN MUSIC IMPLEMENTATION
/* ==================== BGM 音乐 ==================== */

let bgmList = [];
let bgmIndex = -1;
let bgmSelectedKey = '';
let bgmServerUrl = null;
let bgmPlaying = false;
let bgmCatalogKey = '';
let bgmCatalogRequest = 0;
let bgmPlayRequest = 0;
let bgmBroadcastRequest = 0;
let bgmSendChain = Promise.resolve();
let bgmPendingAudio = null;
let bgmPendingKey = '';
let bgmLoading = false;
let bgmError = '';
let bgmSyncStatus = '尚未广播';
let bgmMode = 'loop';
let bgmQueue = [];
let bgmSeeking = false;
let bgmAudio = new Audio();
const bgmPreviewAudio = new Audio();
let bgmPreviewKey = '';
let bgmPreviewRequest = 0;
let liveAudioActive = false;
const liveAudio = SundollLiveAudio.create({
  online: isStreaming, players: getPlayers, signal: postHostWebRtcSignal,
  changed: () => { liveAudioActive = liveAudio.status().active; updateLiveAudioUi(); },
  started: () => {
    cancelPendingBgm(); stopBgmPreview(); stopBgmAudio(false);
    liveAudioActive = true; bgmError = ''; broadcastLiveBgm('play');
  },
  stopped: broadcast => { liveAudioActive = false; if(broadcast)broadcastLiveBgm('stop'); },
  command: action => broadcastLiveBgm(action),
});
const BGM_SCENES = ['主题', '城镇', '探索', '悬疑', '战斗', '首领', '休息', '剧情'];

function bgmAudioExt(name) {
  return /\.(mp3|m4a|wav|ogg|flac|aac|opus|webm)$/i.test(String(name || ''));
}

function bgmKey(item) { return item?.id || item?.url || ''; }

function bgmScene(item) {
  if (item.source === 'temporary') return '临时';
  const parts = String(item.category || '').split(/\s*\/\s*/).filter((part) => part && part !== '通用');
  const aliases = { Boss: '首领', boss: '首领', BOSS: '首领', 环境: '探索' };
  return parts.length ? (aliases[parts[0]] || parts[0]) : '未分类';
}

function currentBgmCatalogKey() {
  return `${getState().campaignId || ''}|${getState().campaignName || ''}`;
}

async function loadProjectMusicLibrary(options = {}) {
  const request = ++bgmCatalogRequest;
  const requestedKey = currentBgmCatalogKey();
  $('#btn-bgm-refresh').disabled = true;
  $('#bgm-results-count').textContent = '正在读取…';
  try {
    const query = new URLSearchParams({ campaignId: getState().campaignId || '', campaignName: getState().campaignName || '' });
    const res = await fetch(`${serverApiBase()}/api/music-library?${query}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (request !== bgmCatalogRequest || requestedKey !== currentBgmCatalogKey()) return;
    if (!res.ok || data.ok === false || !Array.isArray(data.tracks)) throw new Error(data.error || '服务器未响应');
    const previousKey = bgmKey(bgmList[bgmIndex]);
    const temporary = bgmList.filter((item) => item.source === 'temporary');
    const next = data.tracks.map((track) => ({
      id: track.id, name: track.title || track.fileName || '未命名音乐', fileName: track.fileName || '',
      url: track.url?.startsWith('/') ? `${serverApiBase()}${track.url}` : track.url,
      serverUrl: track.url, source: 'library', scope: track.scope === 'campaign' ? 'campaign' : 'general',
      collection: track.collection || (track.scope === 'campaign' ? '当前战役' : '通用'),
      category: track.category || '未分类',
    })).concat(temporary);
    const missingCurrent = previousKey && !next.some((item) => bgmKey(item) === previousKey);
    if (missingCurrent) stopBgmAudio(!liveAudioActive);
    // A pending load belongs to the old catalog. Never commit it against new indices.
    cancelPendingBgm();
    if (bgmPreviewKey && !next.some((item) => bgmKey(item) === bgmPreviewKey)) stopBgmPreview();
    bgmList = next;
    bgmIndex = previousKey ? bgmList.findIndex((item) => bgmKey(item) === previousKey) : -1;
    bgmQueue = bgmQueue.filter((key) => bgmList.some((item) => bgmKey(item) === key));
    if (!bgmList.some((item) => bgmKey(item) === bgmSelectedKey)) bgmSelectedKey = '';
    bgmCatalogKey = requestedKey;
    if (missingCurrent && !liveAudioActive) bgmError = '当前曲目已移除，播放已停止';
    renderBgmList();
    updateBgmStatus();
    if (!options.silent) toast(`项目曲库已刷新：${data.tracks.length} 首`);
  } catch (error) {
    if (request !== bgmCatalogRequest) return;
    renderBgmList();
    $('#bgm-results-count').textContent = '曲库读取失败 · 请启动联机程序后刷新';
    if (!options.silent) toast('曲库刷新失败：' + (error.message || error));
  } finally {
    if (request === bgmCatalogRequest) $('#btn-bgm-refresh').disabled = false;
  }
}

function ensureBgmLibraryForCampaign() {
  if (currentBgmCatalogKey() !== bgmCatalogKey) loadProjectMusicLibrary({ silent: true });
}

function pickBgmFiles(files) {
  const previousKey = bgmKey(bgmList[bgmIndex]);
  [...files].filter((file) => bgmAudioExt(file.name)).forEach((file) => {
    bgmList.push({ name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, file,
      url: URL.createObjectURL(file), source: 'temporary', collection: '临时音乐', category: '临时' });
  });
  bgmIndex = previousKey ? bgmList.findIndex((item) => bgmKey(item) === previousKey) : -1;
  renderBgmList();
  toast('已加入临时音乐，本次页面会话内可用');
}

function visibleBgmTracks() {
  const scene = $('#bgm-scene').value || 'all';
  const scope = $('#bgm-scope').value;
  const search = $('#bgm-search').value.trim().toLocaleLowerCase();
  return bgmList.filter((item) => (scene === 'all' || bgmScene(item) === scene)
    && (scope === 'all' || (scope === 'temporary' ? item.source === 'temporary' : item.source === 'library' && item.scope === scope))
    && item.name.toLocaleLowerCase().includes(search));
}

function renderBgmList() {
  const sceneSelect = $('#bgm-scene');
  const previousScene = sceneSelect.value || 'all';
  const scenes = [...new Set([...BGM_SCENES, ...bgmList.map(bgmScene)])];
  sceneSelect.replaceChildren();
  [['all', '全部场景'], ...scenes.map((scene) => [scene, scene])].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${label} · ${value === 'all' ? bgmList.length : bgmList.filter((item) => bgmScene(item) === value).length}`;
    sceneSelect.append(option);
  });
  sceneSelect.value = scenes.includes(previousScene) ? previousScene : 'all';
  const tracks = visibleBgmTracks();
  const box = $('#bgm-list');
  box.replaceChildren();
  $('#bgm-results-count').textContent = `${tracks.length} 首`;
  if (!tracks.length) {
    const empty = document.createElement('p');
    empty.className = 'bgm-empty';
    empty.textContent = bgmList.length ? '没有匹配的曲目' : '曲库为空';
    box.append(empty);
  }
  tracks.forEach((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'bgm-item';
    row.dataset.key = bgmKey(item);
    const name = document.createElement('span');
    name.className = 'bgm-item-title';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'bgm-item-scope';
    meta.textContent = `${bgmScene(item)} · ${item.collection}`;
    row.append(name, meta);
    row.addEventListener('click', () => {
      const key = bgmKey(item);
      const switching = !liveAudioActive && Boolean(bgmAudio.src)
        && key !== bgmKey(bgmList[bgmIndex]);
      bgmSelectedKey = key;
      if (switching) {
        playBgm(bgmList.findIndex((entry) => bgmKey(entry) === key));
        return;
      }
      updateBgmStatus();
    });
    box.append(row);
  });
  updateBgmStatus();
}

function updateBgmProgress() {
  const duration = Number.isFinite(bgmAudio.duration) ? bgmAudio.duration : 0;
  const time = bgmAudio.currentTime || 0;
  const format = (seconds) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  if (!bgmSeeking) {
    $('#bgm-seek').max = duration || 100;
    $('#bgm-seek').value = time;
    $('#bgm-time').textContent = `${format(time)} / ${duration ? format(duration) : '--:--'}`;
  }
  $('#bgm-seek').disabled = liveAudioActive || !duration || !bgmAudio.src || bgmLoading;
}

function updateBgmStatus() {
  const current = bgmList[bgmIndex];
  const pending = bgmLoading ? bgmList.find((item) => bgmKey(item) === bgmPendingKey) : null;
  const selected = bgmList.find((item) => bgmKey(item) === bgmSelectedKey);
  const title = liveAudioActive ? liveAudio.status().label : (pending?.name || current?.name || '尚未播放');
  const status = liveAudioActive ? (liveAudio.status().paused ? '广播已暂停' : '直播中') : pending ? '正在切换' : bgmPlaying ? '播放中' : bgmAudio.src ? '已暂停' : '已停止';
  $('#bgm-now-title').textContent = title;
  $('#bgm-status').textContent = bgmError || `${bgmLoading ? '新曲加载中 · ' : ''}${status} · ${isStreaming() ? bgmSyncStatus : '仅本机播放'}`;
  $('#bgm-now').dataset.state = liveAudioActive ? (liveAudio.status().paused?'paused':'playing') : bgmPlaying ? 'playing' : bgmAudio.src ? 'paused' : 'stopped';
  $('#bgm-mini-title').textContent = current || pending || liveAudioActive ? title : '音乐';
  $('#btn-bgm-open').title = `打开音乐播放器 · ${title} · ${status}`;
  $('#btn-bgm-open').classList.toggle('active', bgmPlaying || liveAudioActive);
  $('#btn-bgm-mini-play').hidden = !liveAudioActive && !current;
  $('#btn-bgm-mini-stop').hidden = !current && !liveAudioActive && !liveAudio.status().pending && !bgmLoading;
  const playing = liveAudioActive ? !liveAudio.status().paused : bgmPlaying;
  $('#btn-bgm-mini-play').textContent = playing ? '⏸' : '▶';
  $('#btn-bgm-mini-play').setAttribute('aria-label', playing ? '暂停音乐' : '继续音乐');
  $('#btn-bgm-play').textContent = liveAudioActive ? (playing ? '暂停广播' : '继续广播') : bgmPlaying ? '暂停' : bgmAudio.src ? '继续' : '重新播放';
  $('#btn-bgm-play').disabled = (!liveAudioActive && !current) || bgmLoading;
  $('#btn-bgm-mini-play').disabled = bgmLoading;
  $('#btn-bgm-stop').disabled = !liveAudioActive && !liveAudio.status().pending && !bgmAudio.src && !bgmLoading;
  $('#btn-bgm-mini-stop').disabled = $('#btn-bgm-stop').disabled;
  const queue = bgmQueue.filter((key) => bgmList.some((item) => bgmKey(item) === key));
  $('#btn-bgm-prev').disabled = $('#btn-bgm-next').disabled = liveAudioActive || bgmLoading || queue.length < 2;
  $('#bgm-mode').disabled = liveAudioActive;
  $('#bgm-mode').value = bgmMode;
  $('#bgm-volume').disabled = liveAudioActive;
  $('#bgm-selected-title').textContent = selected?.name || '未选择';
  $('#bgm-selected-meta').textContent = selected ? `${bgmScene(selected)} · ${selected.collection}` : '';
  $('#btn-bgm-preview').disabled = !selected || liveAudioActive;
  $('#btn-bgm-preview').textContent = bgmPreviewKey && bgmPreviewKey === bgmSelectedKey ? '结束试听' : '试听';
  $('#btn-bgm-selected-play').disabled = !selected;
  $('#btn-bgm-selected-play').textContent = isStreaming() ? '给全员播放' : '在本机播放';
  $('#bgm-broadcast-hint').textContent = isStreaming() ? '播放会同步给房间；各自调节音量。' : '未开启联机，播放仅在本机。';
  document.querySelectorAll('#bgm-list .bgm-item').forEach((row) => {
    row.classList.toggle('current', row.dataset.key === bgmKey(current));
    row.setAttribute('aria-pressed', String(row.dataset.key === bgmSelectedKey));
  });
  updateBgmProgress();
}

function openBgmPlayer() {
  const dialog = $('#bgm-player');
  if (!dialog.open) dialog.showModal();
  updateBgmStatus();
}

function closeBgmPlayer() { $('#bgm-player').close(); }

function stopBgmPreview() {
  ++bgmPreviewRequest;
  bgmPreviewKey = '';
  bgmPreviewAudio.pause();
  bgmPreviewAudio.removeAttribute('src');
  bgmPreviewAudio.load();
  bgmAudio.muted = false;
  $('#bgm-preview-status').textContent = '';
  updateBgmStatus();
}

async function previewSelectedBgm() {
  if (liveAudioActive) return;
  if (bgmPreviewKey === bgmSelectedKey && bgmPreviewKey) { stopBgmPreview(); return; }
  const selected = bgmList.find((item) => bgmKey(item) === bgmSelectedKey);
  if (!selected) return;
  stopBgmPreview();
  const request = ++bgmPreviewRequest;
  bgmPreviewKey = bgmKey(selected);
  bgmAudio.muted = true;
  bgmPreviewAudio.src = selected.url;
  bgmPreviewAudio.volume = bgmAudio.volume;
  $('#bgm-preview-status').textContent = '正在加载试听…';
  updateBgmStatus();
  try {
    await bgmPreviewAudio.play();
    if (request !== bgmPreviewRequest) return;
    $('#bgm-preview-status').textContent = `正在试听 · ${selected.name}`;
  } catch (error) {
    if (request !== bgmPreviewRequest) return;
    stopBgmPreview();
    $('#bgm-preview-status').textContent = '试听失败：' + (error.message || error);
  }
}

function cancelPendingBgm() {
  ++bgmPlayRequest;
  if (bgmPendingAudio) {
    bgmPendingAudio.pause();
    bgmPendingAudio.removeAttribute('src');
    bgmPendingAudio.load();
    bgmPendingAudio = null;
  }
  bgmPendingKey = '';
  bgmLoading = false;
}

function bindBgmAudioEvents(audio) {
  ['timeupdate', 'loadedmetadata', 'durationchange'].forEach((event) => audio.addEventListener(event, () => {
    if (audio === bgmAudio) updateBgmProgress();
  }));
  audio.addEventListener('ended', () => {
    if (audio !== bgmAudio || liveAudioActive) return;
    if (bgmMode === 'category' && bgmQueue.length) nextBgm();
    else stopBgmAudio();
  });
  audio.addEventListener('error', () => {
    if (audio !== bgmAudio || !audio.src) return;
    stopBgmAudio();
    bgmError = '播放失败 · 文件可能已移动或浏览器不支持此格式';
    updateBgmStatus();
  });
}

async function playBgm(i, keepQueue = false) {
  const item = bgmList[i];
  if (!item?.url) return;
  liveAudio.cancelPending();
  cancelPendingBgm();
  stopBgmPreview();
  const request = bgmPlayRequest;
  const audio = new Audio(item.url);
  audio.volume = bgmAudio.volume;
  audio.loop = bgmMode === 'loop';
  audio.muted = true;
  bgmPendingAudio = audio;
  bgmPendingKey = bgmKey(item);
  bgmLoading = true;
  bgmError = '';
  updateBgmStatus();
  try {
    await audio.play();
    if (request !== bgmPlayRequest) return;
    if (liveAudioActive) await stopLiveAudioBroadcast({broadcast:false});
    if (request !== bgmPlayRequest) return;
    bgmAudio.pause();
    bgmAudio.removeAttribute('src');
    bgmAudio.load();
    bgmAudio = audio;
    bgmPendingAudio = null;
    bgmPendingKey = '';
    bgmLoading = false;
    bgmIndex = bgmList.findIndex((entry) => bgmKey(entry) === bgmKey(item));
    bgmSelectedKey = bgmKey(item);
    if (!keepQueue) bgmQueue = bgmList.filter((entry) => bgmScene(entry) === bgmScene(item)).map(bgmKey);
    audio.loop = bgmMode === 'loop';
    audio.volume = Number($('#bgm-volume').value) / 100;
    audio.muted = Boolean(bgmPreviewKey);
    bindBgmAudioEvents(audio);
    bgmPlaying = true;
    updateBgmStatus();
    broadcastBgm('play');
  } catch (error) {
    if (request !== bgmPlayRequest) return;
    cancelPendingBgm();
    bgmError = '播放失败：' + (error.message || error);
    updateBgmStatus();
    toast(bgmError);
  }
}

function stopBgmAudio(shouldBroadcast = true) {
  cancelPendingBgm();
  bgmAudio.pause();
  bgmAudio.removeAttribute('src');
  bgmAudio.load();
  bgmPlaying = false;
  bgmSeeking = false;
  bgmError = '';
  if (shouldBroadcast) broadcastBgm('stop');
  bgmServerUrl = null;
  updateBgmStatus();
}

async function toggleBgm() {
  if (liveAudioActive) { liveAudio.togglePause(); return; }
  if (bgmIndex < 0) return;
  if (!bgmAudio.src) { playBgm(bgmIndex, true); return; }
  cancelPendingBgm();
  const request = bgmPlayRequest;
  if (!bgmAudio.paused) {
    bgmAudio.pause();
    bgmPlaying = false;
    broadcastBgm('pause');
    updateBgmStatus();
    return;
  }
  try {
    await bgmAudio.play();
    if (request !== bgmPlayRequest) return;
    bgmPlaying = true;
    bgmError = '';
    broadcastBgm('play');
    updateBgmStatus();
  } catch (error) {
    if (request !== bgmPlayRequest) return;
    bgmError = '播放失败：' + (error.message || error);
    updateBgmStatus();
  }
}

function stepBgm(direction) {
  const keys = bgmQueue.filter((key) => bgmList.some((item) => bgmKey(item) === key));
  const at = keys.indexOf(bgmKey(bgmList[bgmIndex]));
  if (at < 0 || !keys.length) return;
  const key = keys[(at + direction + keys.length) % keys.length];
  playBgm(bgmList.findIndex((item) => bgmKey(item) === key), true);
}
function nextBgm() { stepBgm(1); }
function prevBgm() { stepBgm(-1); }

async function ensureBgmServerUrl(i) {
  const it = bgmList[i];
  if (!it) return null;
  if (it.serverUrl) return it.serverUrl;
  try {
    const file = it.file;
    if (!file) return null;
    const buf = await file.arrayBuffer();
    const res = await fetch(`${serverApiBase()}/api/music?name=` + encodeURIComponent(it.fileName || it.name), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    const data = await res.json();
    if (res.ok && data?.ok) { it.serverUrl = data.url; return data.url; }
  } catch (error) { /* 由广播状态报告上传失败 */ }
  return null;
}

async function broadcastBgm(action) {
  const request = ++bgmBroadcastRequest;
  if (!isStreaming()) { updateBgmStatus(); return; }
  const item = bgmList[bgmIndex];
  if (!item && action !== 'stop') return;
  const payload = { op: 'bgm', action, mode: item?.source === 'temporary' ? 'upload' : 'library',
    trackId: item?.id || '', track: item?.name || '', url: '', time: 0, loop: bgmAudio.loop };
  bgmSyncStatus = '正在发送…';
  updateBgmStatus();
  const url = action === 'stop' ? '' : await ensureBgmServerUrl(bgmIndex);
  if (request !== bgmBroadcastRequest || !isStreaming()) return;
  if (!url && action !== 'stop') {
    bgmSyncStatus = '广播失败 · 请重试播放';
    updateBgmStatus();
    return;
  }
  payload.url = url || '';
  bgmServerUrl = action === 'stop' ? null : url;
  await sendRoomMusic(request, payload, () => action === 'stop' ? 0 : Number((bgmAudio.currentTime || 0).toFixed(3)));
}

// File uploads and live commands share one ordering boundary.
function sendRoomMusic(request, payload, position = () => 0) {
  bgmSendChain = bgmSendChain.catch(() => {}).then(async () => {
    if (request !== bgmBroadcastRequest || !isStreaming()) return;
    payload.time = position();
    try {
      const result = await sendHostAction(payload);
      if (request !== bgmBroadcastRequest) return;
      bgmSyncStatus = result.ok && result.data?.ok !== false ? '已发送房间指令' : '广播失败 · 点击重新同步';
    } catch (_) {
      if (request === bgmBroadcastRequest) bgmSyncStatus = '广播失败 · 点击重新同步';
    }
    updateBgmStatus();
  });
  return bgmSendChain;
}

function broadcastLiveBgm(action) {
  const request = ++bgmBroadcastRequest;
  if (!isStreaming()) return Promise.resolve();
  bgmSyncStatus = '正在发送…';
  return sendRoomMusic(request, {op:'bgm',action,mode:'live',track:liveAudio.status().label||'外部音源',url:'',time:0,loop:false});
}

function postHostWebRtcSignal(playerId, signal) {
  return fetch(`${serverApiBase()}/api/webrtc-signal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetPlayerId: playerId, signal }),
  }).then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => ({})) }));
}

function applyHostWebRtcSignal(event) { return liveAudio.signal(event); }
function syncLiveAudioPeers(players = getPlayers()) { liveAudio.sync(players); }
function updateLiveAudioUi() {
  const state = liveAudio.status();
  $('#btn-bgm-live').classList.toggle('active', state.active);
  $('#btn-bgm-live').textContent = state.pending ? '取消连接' : state.active ? '断开音源' : ({tab:'连接浏览器',system:'连接系统声音',device:'连接输入设备'}[$('#bgm-live-source').value] || '连接音源');
  $('#bgm-live-status').textContent = state.error || (state.pending ? '等待选择音源…' : state.active ? `${state.paused?'已暂停 · ':''}${state.connected}/${state.total} 名玩家已连接` : '未连接');
  $('#bgm-live-source').disabled = state.active || state.pending;
  $('#bgm-live-device').disabled = state.active || state.pending;
  $('#btn-bgm-devices').disabled = state.active || state.pending;
  $('#bgm-device-controls').hidden = $('#bgm-live-source').value !== 'device';
  document.querySelectorAll('[data-bgm-source]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.bgmSource === $('#bgm-live-source').value));
    button.disabled = state.active || state.pending;
  });
  updateBgmStatus();
}
async function refreshLiveDevices() {
  try {
    const devices = await liveAudio.inputs(true), select = $('#bgm-live-device'), previous = select.value;
    select.replaceChildren();
    const empty = document.createElement('option'); empty.value=''; empty.textContent='选择音乐输入设备'; select.append(empty);
    devices.forEach((device,index)=>{const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`音频输入 ${index+1}`;select.append(option);});
    select.value = devices.some(device=>device.deviceId===previous) ? previous : '';
    $('#bgm-live-status').textContent = devices.length ? '设备已就绪' : '没有可用输入设备';
  } catch (error) { toast('读取输入设备失败：'+(error.message||error)); }
}
async function startLiveAudioBroadcast() {
  const status=liveAudio.status();
  if(status.active||status.pending){await stopLiveAudioBroadcast();return;}
  const select=$('#bgm-live-device');
  try { await liveAudio.start($('#bgm-live-source').value||'tab', select.value, select.selectedOptions?.[0]?.textContent||'音频输入'); }
  catch(error){toast(error.message||'连接音源失败');}
}
function stopLiveAudioBroadcast(options = {}) { liveAudio.stop(options); }

bindBgmAudioEvents(bgmAudio);
bgmAudio.volume = 0.7;
try {
  const saved = parseFloat(localStorage.getItem('sangduoer-bgm-volume'));
  if (Number.isFinite(saved)) bgmAudio.volume = Math.max(0, Math.min(1, saved > 1 ? saved / 100 : saved));
  const mode = localStorage.getItem('sangduoer-bgm-mode');
  if (['loop', 'once', 'category'].includes(mode)) bgmMode = mode;
} catch (error) { /* 本机设置不可用时使用默认值 */ }
bgmAudio.loop = bgmMode === 'loop';
$('#bgm-volume').value = Math.round(bgmAudio.volume * 100);
$('#bgm-volume-value').textContent = `${$('#bgm-volume').value}%`;
$('#bgm-mode').value = bgmMode;
$('#btn-bgm-open').addEventListener('click', openBgmPlayer);
$('#btn-bgm-resource-open').addEventListener('click', openBgmPlayer);
$('#btn-bgm-close').addEventListener('click', closeBgmPlayer);
$('#bgm-player').addEventListener('close', stopBgmPreview);
$('#bgm-player').addEventListener('click', (event) => {
  if (event.target !== $('#bgm-player')) return;
  const box = event.target.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeBgmPlayer();
});
$('#btn-bgm-refresh').addEventListener('click', () => loadProjectMusicLibrary());
$('#btn-bgm-pick').addEventListener('click', () => $('#file-bgm').click());
$('#file-bgm').addEventListener('change', (event) => { pickBgmFiles(event.target.files); event.target.value = ''; });
['#bgm-scene', '#bgm-scope', '#bgm-search'].forEach((selector) => $(selector).addEventListener('input', renderBgmList));
['#btn-bgm-play', '#btn-bgm-mini-play'].forEach((selector) => $(selector).addEventListener('click', toggleBgm));
['#btn-bgm-stop', '#btn-bgm-mini-stop'].forEach((selector) => $(selector).addEventListener('click', () => {
  stopBgmPreview();
  const active=liveAudioActive;
  stopLiveAudioBroadcast();
  if(!active)stopBgmAudio();
}));
$('#btn-bgm-selected-play').addEventListener('click', () => playBgm(bgmList.findIndex((item) => bgmKey(item) === bgmSelectedKey)));
$('#btn-bgm-preview').addEventListener('click', previewSelectedBgm);
bgmPreviewAudio.addEventListener('ended', stopBgmPreview);
bgmPreviewAudio.addEventListener('error', () => {
  if (!bgmPreviewKey) return;
  stopBgmPreview();
  $('#bgm-preview-status').textContent = '试听失败 · 文件可能已移动或不支持此格式';
});
$('#btn-bgm-next').addEventListener('click', nextBgm);
$('#btn-bgm-prev').addEventListener('click', prevBgm);
$('#btn-bgm-live').addEventListener('click', startLiveAudioBroadcast);
$('#bgm-live-source').addEventListener('change', updateLiveAudioUi);
document.querySelectorAll('[data-bgm-source]').forEach(button => button.addEventListener('click', () => {
  $('#bgm-live-source').value = button.dataset.bgmSource;
  updateLiveAudioUi();
}));
$('#btn-bgm-devices').addEventListener('click', refreshLiveDevices);
$('#btn-bgm-resync').addEventListener('click', resync);
$('#bgm-mode').addEventListener('change', (event) => {
  bgmMode = event.target.value;
  bgmAudio.loop = bgmMode === 'loop';
  try { localStorage.setItem('sangduoer-bgm-mode', bgmMode); } catch (error) { /* 忽略 */ }
  if (bgmAudio.src && !liveAudioActive) broadcastBgm(bgmAudio.paused ? 'pause' : 'play');
});
$('#bgm-volume').addEventListener('input', (event) => {
  bgmAudio.volume = Number(event.target.value) / 100;
  bgmPreviewAudio.volume = bgmAudio.volume;
  $('#bgm-volume-value').textContent = `${event.target.value}%`;
  try { localStorage.setItem('sangduoer-bgm-volume', String(bgmAudio.volume)); } catch (error) { /* 忽略 */ }
});
$('#bgm-seek').addEventListener('input', (event) => {
  bgmSeeking = true;
  const time = Number(event.target.value);
  $('#bgm-time').textContent = `${Math.floor(time / 60).toString().padStart(2, '0')}:${Math.floor(time % 60).toString().padStart(2, '0')} · 松手跳转`;
});
$('#bgm-seek').addEventListener('change', (event) => {
  bgmSeeking = false;
  if (!liveAudioActive && bgmAudio.src && Number.isFinite(bgmAudio.duration)) {
    bgmAudio.currentTime = Math.max(0, Math.min(bgmAudio.duration, Number(event.target.value)));
    broadcastBgm(bgmAudio.paused ? 'pause' : 'play');
  }
  updateBgmProgress();
});

function snapshot() {
  if(liveAudioActive)return {action:liveAudio.status().paused?'pause':'play',mode:'live',track:liveAudio.status().label,url:'',time:0,loop:false};
  const current = bgmList[bgmIndex];
  return bgmServerUrl && current ? {
    action: bgmPlaying ? 'play' : 'pause', mode: current.source==='temporary'?'upload':'library', trackId:current.id||'', loop:bgmAudio.loop, track: current.name,
    url: bgmServerUrl, time: Math.round(bgmAudio.currentTime || 0),
  } : null;
}
function resync() {
  if(liveAudioActive){liveAudio.sync(getPlayers(),true);return broadcastLiveBgm(liveAudio.status().paused?'pause':'play');}
  if (bgmIndex >= 0 && bgmAudio.src) return broadcastBgm(bgmAudio.paused ? 'pause' : 'play');
  return broadcastBgm('stop');
}

updateLiveAudioUi();

// END MUSIC IMPLEMENTATION

return Object.freeze({
  loadProjectMusicLibrary,
  ensureBgmLibraryForCampaign,
  updateBgmStatus,
  applyHostWebRtcSignal,
  syncLiveAudioPeers,
  stopLiveAudioBroadcast,
  snapshot, resync,
  backgrounds: () => [bgmAudio, bgmPreviewAudio],
});
});
