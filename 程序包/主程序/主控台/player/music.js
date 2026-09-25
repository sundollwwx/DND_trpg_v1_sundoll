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
