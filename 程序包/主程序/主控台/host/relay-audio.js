/* HTTP audio transport: one host upload, authenticated player downloads over the room origin. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.SundollHostRelay={create:factory};
})(typeof globalThis!=='undefined'?globalThis:this,function(options){
  const env=options.env||globalThis;
  let current=null,generation=0;
  const endpoint=()=>`${options.base()}/api/music-live`;
  async function post(data){
    const response=await env.fetch(endpoint(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:env.AbortSignal.timeout(6000)});
    const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'音频中转连接失败');return result;
  }
  async function prepare(){
    if(!env.AudioContext||!env.AudioWorkletNode)throw Error('请使用支持音频处理的 Chrome / Edge');
    const response=await env.fetch(endpoint(),{cache:'no-store',signal:env.AbortSignal.timeout(6000)});
    if(!response.ok)throw Error('音频中转服务尚未更新，请保存战役并重启服务');
    const data=await response.json();if(data.transport!=='https-pcm')throw Error('音频中转服务不可用');
  }
  function stop(){
    ++generation;const item=current;current=null;if(!item)return;
    if(item.node){item.node.port.onmessage=null;item.node.disconnect();}
    item.source?.disconnect();item.ctx.close().catch(()=>{});
    if(item.id)post({action:'stop',id:item.id}).catch(()=>{});
  }
  async function start(stream){
    stop();const token=++generation;
    const ctx=new env.AudioContext({sampleRate:48000}),item={ctx,id:'',url:'',seq:0,queue:[],sending:false,signal:'waiting',silentPackets:0};current=item;
    const valid=()=>current===item&&generation===token;
    try{
      await ctx.resume();
      const worklet=`class PacketAudio extends AudioWorkletProcessor {
        constructor(){super();this.data=new Int16Array(sampleRate/2*2);this.offset=0;}
        process(inputs){const channels=inputs[0];if(!channels?.length)return true;
          const left=channels[0],right=channels[1]||left;
          for(let i=0;i<left.length;i++){this.data[this.offset++]=Math.round(Math.max(-1,Math.min(1,left[i]))*32767);this.data[this.offset++]=Math.round(Math.max(-1,Math.min(1,right[i]))*32767);
            if(this.offset===this.data.length){this.port.postMessage({pcm:this.data.buffer,rate:sampleRate},[this.data.buffer]);this.data=new Int16Array(sampleRate/2*2);this.offset=0;}}
          return true;}}
        registerProcessor('room-audio-packets',PacketAudio);`;
      const url=env.URL.createObjectURL(new env.Blob([worklet],{type:'text/javascript'}));
      try{await ctx.audioWorklet.addModule(url);}finally{env.URL.revokeObjectURL(url);}
      if(!valid())return null;
      const info=await post({action:'start'});item.id=info.id;item.url=info.url;
      if(!valid()){post({action:'stop',id:info.id}).catch(()=>{});return null;}
      item.source=ctx.createMediaStreamSource(new env.MediaStream(stream.getAudioTracks()));
      item.node=new env.AudioWorkletNode(ctx,'room-audio-packets');
      // Worklet output is silence: the captured source is never locally echoed.
      item.source.connect(item.node);item.node.connect(ctx.destination);
      async function drain(){
        if(item.sending)return;item.sending=true;
        try{while(valid()&&item.queue.length){const packet=item.queue.shift();await post({action:'chunk',id:item.id,seq:++item.seq,...packet});}}
        catch(e){if(valid()){stop();options.failed(e.message);}}
        finally{item.sending=false;}
      }
      item.node.port.onmessage=event=>{
        if(!valid())return;
        const samples=new Int16Array(event.data.pcm);
        const audible=samples.some(value=>Math.abs(value)>16);
        item.silentPackets=audible?0:item.silentPackets+1;
        const signal=audible?'sound':item.silentPackets>=4?'silent':item.signal;
        if(signal!==item.signal){item.signal=signal;options.changed?.();}
        const bytes=new Uint8Array(event.data.pcm);let binary='';
        for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        if(item.queue.length>=6){stop();options.failed('音频上传过慢，请重新连接');return;}
        item.queue.push({rate:event.data.rate,pcm:env.btoa(binary)});drain();
      };
      return info.url;
    }catch(error){if(valid())stop();throw error;}
  }
  return {prepare,start,stop,url:()=>current?.url||'',signal:()=>current?.signal||'waiting'};
});
