/* Receive bounded PCM packets from the player's room origin, never from a host LAN address. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory;
  else root.SundollPlayerRelay={create:factory};
})(typeof globalThis!=='undefined'?globalThis:this,function(options){
  const env=options.env||globalThis;
  let current=null;
  const changed=()=>options.changed?.();
  function stop(){
    const item=current;current=null;if(!item)return;
    env.clearTimeout(item.timer);item.abort?.abort();
    item.sources.forEach(source=>{try{source.stop();}catch(_){}source.disconnect();});
    item.ctx.onstatechange=null;item.ctx.close().catch(()=>{});
  }
  function resume(){if(current)current.ctx.resume().catch(()=>{});}
  function start(url){
    if(current?.url===url){resume();return current.destination.stream;}
    stop();
    if(!/^\/api\/music-live\?id=[a-f0-9]{32}$/.test(url))throw Error('无效的音频中转地址');
    const ctx=new env.AudioContext(),destination=ctx.createMediaStreamDestination();
    const item={url,ctx,destination,cursor:-1,nextTime:0,sources:new Set(),error:'',timer:null,abort:null,received:false,silent:false};current=item;
    ctx.onstatechange=changed;resume();
    function flush(){item.sources.forEach(source=>{try{source.stop();}catch(_){}source.disconnect();});item.sources.clear();item.nextTime=0;}
    async function poll(){
      if(current!==item||!options.session())return;
      item.abort=new env.AbortController();const deadline=env.setTimeout(()=>item.abort?.abort(),6000);
      try{
        const r=await env.fetch(url+'&after='+item.cursor,{headers:{'X-Sundoll-Session':options.session()},cache:'no-store',signal:item.abort.signal});
        if(!r.ok){item.received=false;throw Error(r.status===401?'登录已失效':'音频连接中断');}
        const data=await r.json();if(current!==item)return;
        if(!data.active){flush();throw Error('音源已断开');}
        if(data.reset)flush();
        for(const packet of data.packets){
          if(packet.seq<=item.cursor&&!data.reset)continue;
          item.cursor=packet.seq;
          // While autoplay is blocked, discard old packets and remain at the live edge.
          if(ctx.state!=='running')continue;
          const binary=env.atob(packet.pcm),bytes=new Uint8Array(binary.length);
          for(let i=0;i<bytes.length;i++)bytes[i]=binary.charCodeAt(i);
          const pcm=new DataView(bytes.buffer),frames=bytes.length/4,buffer=ctx.createBuffer(2,frames,packet.rate);
          item.received=true;item.silent=!new Int16Array(bytes.buffer).some(value=>Math.abs(value)>16);
          for(let ch=0;ch<2;ch++){const channel=buffer.getChannelData(ch);for(let i=0;i<frames;i++)channel[i]=pcm.getInt16(i*4+ch*2,true)/32768;}
          if(item.nextTime<ctx.currentTime||item.nextTime>ctx.currentTime+2)flush();
          if(!item.nextTime)item.nextTime=ctx.currentTime+.7;
          const source=ctx.createBufferSource();source.buffer=buffer;source.connect(destination);item.sources.add(source);
          source.onended=()=>{item.sources.delete(source);source.disconnect();};source.start(item.nextTime);item.nextTime+=buffer.duration;
        }
        item.error='';
      }catch(e){if(current===item)item.error=e.name==='AbortError'?'音频连接超时，正在重试':e.message;}
      finally{env.clearTimeout(deadline);if(current===item){changed();item.timer=env.setTimeout(poll,item.error?1000:250);}}
    }
    poll();return destination.stream;
  }
  return {start,stop,resume,blocked:()=>!!current&&current.ctx.state!=='running',error:()=>current?.error||'',receiving:()=>!!current?.received,silent:()=>!!current?.silent};
});
