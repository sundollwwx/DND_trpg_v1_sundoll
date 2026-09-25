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
