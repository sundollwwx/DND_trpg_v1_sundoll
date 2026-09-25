(function(root){
  'use strict';
  function mount({board,canSend,send,unavailable,toggleButton}){
    const layer=document.createElement('div');layer.className='danmaku-layer';layer.setAttribute('aria-hidden','true');
    const controls=document.createElement('div');controls.className='danmaku-controls';
    controls.innerHTML=(toggleButton?'':'<div class="danmaku-buttons"><button type="button" class="danmaku-toggle" aria-expanded="false">弹幕</button></div>')+'<form class="danmaku-form" hidden><label>发送弹幕<input type="text" maxlength="120" placeholder="说点什么…" autocomplete="off" aria-label="弹幕内容"></label><div class="danmaku-footer"><span class="danmaku-count">0 / 120</span><button type="submit">发送</button></div><p class="danmaku-status" role="status" aria-live="polite">自动显示发送者名字</p></form>';
    board.append(layer,controls);
    if(toggleButton)controls.classList.add('danmaku-docked');
    const toggle=toggleButton||controls.querySelector('.danmaku-toggle'),form=controls.querySelector('form'),input=controls.querySelector('input'),submit=controls.querySelector('[type="submit"]'),status=controls.querySelector('.danmaku-status'),count=controls.querySelector('.danmaku-count');
    let busy=false,timer=null;
    const seen=new Set(),queue=[],lanes=new Map();
    function clear(){queue.length=0;lanes.clear();layer.replaceChildren();clearTimeout(timer);timer=null;}
    function pump(){
      clearTimeout(timer);timer=null;
      const total=Math.max(1,Math.min(5,Math.floor((board.clientHeight-110)/42)));
      for(let lane=0;lane<total&&queue.length;lane++){
        if(lanes.has(lane))continue;
        const message=queue.shift();
        if(Date.now()-message.issuedAt>20000)continue;
        const item=document.createElement('div');item.className='danmaku-message'+(message.role==='dm'?' danmaku-dm':'');
        item.textContent=message.name+'：'+message.text;item.style.top=(58+lane*42)+'px';
        layer.append(item);lanes.set(lane,item);
        const width=board.clientWidth,distance=width+item.offsetWidth+32;
        const duration=Math.max(5500,Math.min(14000,distance/120*1000));
        item.style.setProperty('--danmaku-distance',-distance+'px');item.style.animationDuration=duration+'ms';
        item.addEventListener('animationend',()=>{item.remove();if(lanes.get(lane)===item)lanes.delete(lane);pump();},{once:true});
      }
      if(queue.length&&!timer)timer=setTimeout(pump,700);
    }
    function receive(message){
      if(!message||!message.messageId||seen.has(message.messageId))return;
      seen.add(message.messageId);if(seen.size>300)seen.delete(seen.values().next().value);
      if(Date.now()-message.issuedAt>20000)return;
      if(typeof message.text!=='string'||typeof message.name!=='string')return;
      if(queue.length>=30)queue.shift();queue.push(message);pump();
    }
    toggle.addEventListener('click',()=>{form.hidden=!form.hidden;toggle.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)input.focus();});
    controls.addEventListener('pointerdown',event=>event.stopPropagation());
    controls.addEventListener('click',event=>event.stopPropagation());
    controls.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Escape'){form.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}});
    input.addEventListener('input',()=>{count.textContent=Array.from(input.value).length+' / 120';});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.isComposing)event.preventDefault();});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy)return;
      const text=input.value.trim();if(!text){status.textContent='先写一句弹幕吧';return;}
      if(!canSend()){status.textContent=unavailable;return;}
      busy=true;submit.disabled=true;status.textContent='正在发送…';
      try{
        const result=await send(text);
        if(!result.ok||result.data?.ok===false)throw Error(result.data?.error||'弹幕未送达，请重试');
        receive(result.data?.action);
        if(input.value.trim()===text){input.value='';count.textContent='0 / 120';}
        status.textContent='已发送';
        form.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();
      }catch(error){status.textContent=error.message||'弹幕未送达，请重试';}
      finally{busy=false;submit.disabled=false;}
    });
    return{receive,clear};
  }
  root.SundollDanmaku={mount};
})(window);
