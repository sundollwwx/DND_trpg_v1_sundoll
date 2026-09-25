/* Persistent map loot. The server owns quantities; uncertain writes retain their request ID. */
window.MapItems=(()=>{
  let cfg={},cache=null,key='',pending=null,busy=false,refreshJob=null,dialog=null,selected='',selectedContent='',drag=null,armed=null,banner=null,signature='',timer=null,syncEpoch=0,visibilityBound=false;
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const context=()=>{const m=cfg.map?.();return {campaignId:cfg.campaign?.()||'',mapId:m?.id||'',...(cfg.host&&m?{hostMap:{id:m.id,mapW:m.mapW||10000,mapH:m.mapH||10000}}:{})};};
  const contextKey=c=>JSON.stringify([c.campaignId,c.mapId]);
  const note=text=>cfg.toast?.(text);
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>{note(e.message);error(e.message);});return b;};
  function error(text){const box=dialog?.querySelector('.mi-status');if(box)box.textContent=text;}
  async function api(command){
    const response=await fetch('/api/map-items',{method:'POST',headers:{'Content-Type':'application/json',...(cfg.host?{'X-Sundoll-Local-Save':'1'}:{})},body:JSON.stringify({...command,...(!cfg.host?{sessionToken:command.sessionToken||cfg.session?.()}: {})})});
    const result=await response.json().catch(()=>({}));if(!response.ok||!result.ok){const e=new Error(response.status===404&&(!result.error||result.error==='not found')?'当前联机服务尚未加载地图物品功能，请重启启动器后刷新页面。':result.error||'地图物品暂时无法连接');e.status=response.status;throw e;}return result;
  }
  function lock(){if(dialog)for(const b of dialog.querySelectorAll('button,input,select'))b.disabled=(busy||!!pending)&&b.dataset.allowClose!=='true';}
  function retryButton(){if(!dialog?.open)return;const b=button('核对并重试原操作',retry);dialog.querySelector('.mi-status')?.append(b);b.disabled=false;}
  async function retry(){
    if(busy||!pending)return;busy=true;syncEpoch++;lock();const task=pending;
    try{const result=await api(task);pending=null;if(!cfg.host&&task.sessionToken!==cfg.session?.())return false;if(contextKey(task)===contextKey(context())){key=contextKey(task);cache=result;render();if(dialog?.open)show(selected);}if(['pickLock','inspireLock'].includes(task.op)&&result.check){cfg.playCheck?.(result.check,dialog);note(result.check.success?'开锁成功，可以查看箱内物品。':'开锁未成功，宝箱仍然上锁。');}else note('地图物品已保存');return true;}
    catch(e){if(e.status&&e.status<500)pending=null;if(pending&&!dialog?.open)open(selected);error(e.message);note(e.message);if(!pending)await refresh(true);return false;}
    finally{syncEpoch++;busy=false;lock();if(pending)retryButton();else if(contextKey(task)===contextKey(context()))refresh().catch(()=>{});}
  }
  async function mutate(op,fields={},at=context()){
    if(busy||pending){note('请先核对上次操作');open(selected);return false;}
    if(contextKey(at)!==key||!cache)throw new Error('地图已切换，请重新打开物品');
    pending={...at,op,...fields,...(!cfg.host?{sessionToken:cfg.session?.()}:{}),revision:cache.revision,requestId:crypto.randomUUID?.()||('loot-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''))};return retry();
  }
  function clear(){syncEpoch++;cfg.world?.()?.querySelectorAll('.map-item-marker').forEach(e=>e.remove());signature='';cache=null;selected='';selectedContent='';drag=null;if(dialog?.open)dialog.close();cancelPlacement();}
  async function refresh(force=false){
    const at=context(),nextKey=contextKey(at);
    if(nextKey!==key){clear();key=nextKey;}
    if(!at.mapId||!at.campaignId||(!cfg.host&&!cfg.session?.())){clear();return;}
    if(document.hidden&&!force)return;
    if(refreshJob){await refreshJob;if(force)return refresh(true);return;}
    const epoch=syncEpoch,readSession=cfg.session?.();
    refreshJob=(async()=>{
      try{const data=await api({...at,op:'get'});if(contextKey(context())!==nextKey||epoch!==syncEpoch||(!cfg.host&&readSession!==cfg.session?.()))return;
        if(!busy&&!pending&&!drag){const changed=JSON.stringify(data)!==JSON.stringify(cache);cache=data;if(changed||force){render();if(dialog?.open&&!pending){if(!cfg.host)show(selected);else error('地图物品已更新；操作前会再次核对数量。');}}}
      }catch(e){if(contextKey(context())!==nextKey||epoch!==syncEpoch||(!cfg.host&&readSession!==cfg.session?.()))return;if(!cfg.host&&!busy&&!pending&&!drag&&(e.status===401||e.status===403)){clear();}if(force)throw e;}
    })();
    try{await refreshJob;}finally{refreshJob=null;}
  }
  function zoom(){const z=Number(cfg.zoom?.());return Number.isFinite(z)&&z>0?z:1;}
  function point(event){const w=cfg.world().getBoundingClientRect(),m=cfg.map();return{x:Math.max(0,Math.min(m.mapW||10000,(event.clientX-w.left)/zoom())),y:Math.max(0,Math.min(m.mapH||10000,(event.clientY-w.top)/zoom()))};}
  function resize(){const grid=cfg.map()?.gridSize||50;for(const b of cfg.world?.()?.querySelectorAll('.map-item-marker')||[]){const side=grid*Number(b.dataset.size);b.style.width=b.style.height=side+'px';b.style.fontSize=side*.72+'px';const count=b.querySelector('small');if(count)count.style.fontSize=side*.28+'px';}}
  function icon(marker){return marker.kind==='container'?'🧰':marker.items[0]?.category==='document'?(marker.items[0]?.documentType==='book'?'▥':'✉'):({potion:'🧪',scroll:'📜',wondrous:'💎',gear:'🗝️'}[marker.items[0]?.category]||'📦');}
  const chestArt=marker=>'/asset/界面/物品/宝箱/chest-'+(marker.locked?(marker.lockType==='arcane'?'arcane':'locked'):'unlocked')+'-v2.png';
  const chestStatus=marker=>!marker.locked?'未上锁':marker.lockType==='arcane'?'秘法锁':'普通锁';
  function render(){
    if(!cfg.world?.()||drag)return;const next=JSON.stringify([key,cache?.markers]);if(next===signature){resize();return;}signature=next;
    cfg.world().querySelectorAll('.map-item-marker').forEach(e=>e.remove());
    for(const marker of cache?.markers||[]){
      const b=el('button',undefined,'map-item-marker'+(!marker.visible?' mi-hidden':'')+(!marker.items.length&&!marker.locked?' mi-empty':''));b.type='button';b.dataset.markerId=marker.id;b.dataset.size=marker.size;const position=pending?.op==='move'&&pending.markerId===marker.id&&contextKey(pending)===key?pending:marker;b.style.left=position.x+'px';b.style.top=position.y+'px';b.title=marker.name+(!marker.visible?' · 仅主控可见':'')+(marker.kind==='container'?' · '+chestStatus(marker):'')+(!marker.items.length&&!marker.locked?' · 已搜空':'');b.setAttribute('aria-label',b.title);
      const placedItem=marker.items[0],fallback=placedItem?.category==='document'?'/asset/界面/物品/文书/'+(placedItem.documentType==='book'?'book':'letter')+'-v2.png':({potion:'/asset/界面/物品/通用/potion-v1.png',scroll:'/asset/界面/物品/通用/scroll-v1.png',wondrous:'/asset/界面/物品/通用/wondrous-v1.png',gear:'/asset/界面/物品/通用/gear-v1.png'}[placedItem?.category]||''),image=marker.kind==='container'?chestArt(marker):placedItem?.image||fallback;
      if(image){const img=el('img');img.src=image;img.alt='';img.draggable=false;img.onerror=()=>{img.remove();b.prepend(el('span',icon(marker)));};b.append(img);}else b.append(el('span',icon(marker)));
      const count=marker.items.reduce((sum,i)=>sum+i.quantity,0);if(count>1)b.append(el('small','×'+count));
      b.addEventListener('mousedown',e=>e.stopPropagation());b.addEventListener('dblclick',e=>e.stopPropagation());
      b.onclick=e=>{e.stopPropagation();if(e.detail===0&&!busy&&!pending)open(marker.id);};
      b.onpointerdown=e=>{
        e.stopPropagation();if(e.button!==0||busy||pending||armed)return;e.preventDefault();b.setPointerCapture(e.pointerId);
        syncEpoch++;drag={b,marker,at:context(),clientX:e.clientX,clientY:e.clientY,zoom:zoom(),x:marker.x,y:marker.y,moved:false,pointerId:e.pointerId};
      };
      const move=e=>{if(drag?.b!==b||e.pointerId!==drag.pointerId)return;const dx=e.clientX-drag.clientX,dy=e.clientY-drag.clientY;if(Math.hypot(dx,dy)>6)drag.moved=true;if(!drag.moved)return;const m=cfg.map();drag.x=Math.max(0,Math.min(m.mapW||10000,marker.x+dx/drag.zoom));drag.y=Math.max(0,Math.min(m.mapH||10000,marker.y+dy/drag.zoom));b.style.left=drag.x+'px';b.style.top=drag.y+'px';};
      b.onpointermove=move;
      // Capture loss and pointercancel can follow native browser gestures. Keep the
      // last measured destination instead of silently restoring the cached origin.
      const finish=(e,interrupted=false)=>{
        if(drag?.b!==b||(e?.pointerId!=null&&e.pointerId!==drag.pointerId))return;
        e?.stopPropagation?.();if(!interrupted)move(e);const d=drag;drag=null;
        if(d.moved){mutate('move',{markerId:marker.id,markerRevision:marker.revision||0,x:d.x,y:d.y},d.at).catch(err=>note(err.message)).finally(()=>{signature='';render();});}
        else if(!interrupted)open(marker.id);
      };
      b.draggable=false;b.ondragstart=e=>{e.preventDefault();e.stopPropagation();};
      b.onpointerup=e=>finish(e);b.onpointercancel=e=>finish(e,true);b.onlostpointercapture=e=>finish(e,true);cfg.world().append(b);
    }resize();
  }
  function ensureDialog(){if(dialog)return;dialog=el('dialog',undefined,'map-items-dialog');dialog.setAttribute('aria-label','地图物品');document.body.append(dialog);}
  function open(id,contentId=''){ensureDialog();selected=id;selectedContent=contentId;if(!dialog.open)dialog.showModal();show(id);}
  const categoryName=item=>item?.category==='document'?(item.documentType==='book'?'书籍':item.documentType==='letter'?'信件':'文书'):({potion:'药水',scroll:'卷轴',wondrous:'奇物',gear:'普通物品',container:'容器'}[item?.category]||'物品');
  function action(text,fn,kind='quiet'){const b=button(text,fn);b.className='mi-button mi-'+kind;return b;}
  function labeled(text,input){const label=el('label',undefined,'mi-field');label.append(el('span',text),input);input.setAttribute('aria-label',text);return label;}
  function description(parent,item,markerId){
    if(item.effect)parent.append(el('p',item.effect,'mi-effect'));
    if(item.description)parent.append(el('p',item.description,'mi-description'));
    if(item.category==='document'&&item.body)parent.append(action(item.documentType==='book'?'翻阅书籍':'阅读正文',()=>PlayerBackpack.openDocument(item,{shareSource:{mapId:context().mapId,markerId}}),'primary'));
  }
  function checkSummary(check){
    const dice=check.dice||[check.natural],mode=check.mode||0;
    const parts=[mode?`${mode===1?'优势取高':'劣势取低'} [${dice.join(' / ')}] → ${check.natural}`:`d20 ${check.natural}`];
    parts.push(`${check.modifier>=0?'+':'−'} ${Math.abs(check.modifier)} 巧手`);
    if(check.guidanceRoll)parts.push(`+ ${check.guidanceRoll} 神导术`);
    if(check.inspirationRoll)parts.push(`+ ${check.inspirationRoll} 诗人激励`);
    return parts.join(' ')+` = ${check.total}`;
  }
  function lockPanel(marker,change){
    const panel=el('section',undefined,'mi-lock-panel'),attempt=marker.lockAttempt;
    panel.append(el('h3','锁扣紧闭'));
    if(attempt){
      panel.append(el('p',checkSummary(attempt),'mi-lock-result'));
      const canInspire=!attempt.success&&attempt.critical!=='fail'&&!attempt.inspirationUsed&&!attempt.finished;
      if(canInspire){
        panel.append(el('p','尚未成功。若角色已有有效的诗人激励，可以现在消耗它追加点数。'));
        const die=el('select');for(const v of [6,8,10,12])die.append(new Option('d'+v,v));die.value=attempt.inspirationDie||6;
        if(!attempt.inspirationDie)panel.append(labeled('已有的诗人激励骰',die));
        const actions=el('div',undefined,'mi-bonus-actions');actions.append(action(attempt.inspirationDie?`使用诗人激励 d${attempt.inspirationDie}`:'使用诗人激励',()=>change('inspireLock',{checkId:attempt.id,...(!attempt.inspirationDie?{inspirationDie:Number(die.value)}:{})}),'primary'),action('保留激励，结束检定',()=>change('finishLock',{checkId:attempt.id})));panel.append(actions);
      }else panel.append(el('p',attempt.critical==='fail'?'天然 1 · 大失败。按本团规则，加成不能改变此次结果。':attempt.inspirationUsed?'诗人激励已使用，仍未成功。请在角色卡记录此次消耗。':'本次检定已结束，主控可重置尝试机会。'));
      return panel;
    }
    panel.append(el('p','选择检定方式，投掷后保留宝箱页面。'));
    const mode=el('select');for(const [v,t] of [[0,'普通 · 1d20'],[1,'优势 · 2d20 取高'],[-1,'劣势 · 2d20 取低']])mode.append(new Option(t,v));mode.value=0;
    const modifier=el('input');modifier.type='number';modifier.min=-10;modifier.max=30;modifier.value=0;
    const fields=el('div',undefined,'mi-check-fields');fields.append(labeled('检定方式',mode),labeled('巧手加值',modifier));panel.append(fields);
    const bonuses=el('details',undefined,'mi-check-bonuses');bonuses.append(el('summary','额外加成'));
    const guidance=el('input');guidance.type='checkbox';const guideLabel=el('label',undefined,'mi-bonus-check');guideLabel.append(guidance,el('span','神导术 · +1d4'));guidance.setAttribute('aria-label','神导术');
    const inspiration=el('select');for(const [v,t] of [[0,'无'],[6,'已有 d6'],[8,'已有 d8'],[10,'已有 d10'],[12,'已有 d12']])inspiration.append(new Option(t,v));inspiration.value=0;
    bonuses.append(guideLabel,labeled('已获得的诗人激励',inspiration),el('p','神导术需已生效并选择巧手；诗人激励仅在失败后由你决定是否使用。请按角色卡确认加成与消耗。','mi-hint'));panel.append(bonuses);
    panel.append(el('p','优势与劣势同时存在时请选择普通。','mi-hint'),action('⚄ 尝试开锁',()=>{const bonus=Number(modifier.value);if(!Number.isInteger(bonus)||bonus< -10||bonus>30)throw new Error('请填写有效的巧手加值');return change('pickLock',{modifier:bonus,mode:Number(mode.value),guidance:guidance.checked===true,inspirationDie:Number(inspiration.value)});},'primary'));
    panel.querySelector('.mi-primary')?.classList.add('mi-lock-start');
    return panel;
  }
  function show(id){
    ensureDialog();const marker=cache?.markers.find(v=>v.id===id);for(const child of Array.from(dialog.children)){if(!child.classList.contains('dice-fx-root'))child.remove();}
    const head=el('header',undefined,'mi-header'),close=action('×',()=>dialog.close(),'close');close.setAttribute('aria-label','关闭物品');close.dataset.allowClose='true';
    head.append(el('span',selectedContent?'箱内物品':marker?.kind==='container'?'地图容器':'地图物品','mi-eyebrow'),close);dialog.append(head);
    const status=el('div','','mi-status');status.setAttribute('role','status');dialog.append(status);
    if(pending){error('上次操作结果待核对，请重试同一操作。');lock();retryButton();return;}
    if(!marker){dialog.append(el('p','物品已被拿走或隐藏。','mi-missing'));return;}
    if(selectedContent&&!marker.items.some(v=>v.id===selectedContent))selectedContent='';
    const child=marker.items.find(v=>v.id===selectedContent),isContainer=marker.kind==='container'&&!child,item=child||(isContainer?(marker.containerItem||{name:marker.name,category:'container'}):marker.items[0]);
    dialog.classList.toggle('mi-container-view',isContainer);
    if(child)head.prepend(action('‹ 返回宝箱',()=>open(id)));
    const at=context(),revision=cache.revision,markerRevision=marker.revision||0;
    const change=(op,fields)=>{if(cache?.revision!==revision||(cache?.markers.find(v=>v.id===id)?.revision||0)!==markerRevision||contextKey(at)!==key){show(id);throw new Error('地图物品已更新，请重新核对');}return mutate(op,{markerId:id,markerRevision,...fields},at);};
    const body=el('div',undefined,'mi-body'),hero=el('div',undefined,'mi-hero'),copy=el('div',undefined,'mi-hero-copy');
    const art=PlayerBackpack.art(isContainer?{...item,image:chestArt(marker)}:(item||{category:'gear'}));hero.append(art);
    const meta=el('div',undefined,'mi-meta');meta.append(el('span',categoryName(item)),el('span',isContainer?(marker.locked?chestStatus(marker):`${marker.items.length} 种物品 · 未上锁`):`持有 ×${item?.quantity||0}`));
    if(item?.rarity)meta.append(el('span',item.rarity));
    copy.append(el('h2',child?item.name:marker.name),meta);hero.append(copy);body.append(hero);
    if(!isContainer&&item)description(body,item,id);
    const lockedForPlayer=isContainer&&marker.locked&&!cfg.host;
    if(lockedForPlayer){
      if(marker.lockType==='arcane'){
        const panel=el('section',undefined,'mi-lock-panel');panel.append(el('h3','秘法锁封印'),el('p','2024 版秘法锁无法通过普通巧手检定解开。寻找施法者设定的口令，或请主控裁定解除魔法、敲击术等方式。'));body.append(panel);
      }else body.append(lockPanel(marker,change));
    }
    if(isContainer&&!cfg.host&&marker.lockAttempt?.success)body.append(el('p',checkSummary(marker.lockAttempt)+' · '+(marker.lockAttempt.critical==='success'?'大成功':'开锁成功'),'mi-lock-result'));
    if(isContainer&&!lockedForPlayer){
      const inventoryHead=el('div',undefined,'mi-section-head');inventoryHead.append(el('h3','箱内物品'));
      if(cfg.host)inventoryHead.append(action('＋ 装入物品',()=>{dialog.close();window.ItemLibrary.open({mapContainer:id});}));body.append(inventoryHead);
      if(!marker.items.length){const empty=el('div',undefined,'mi-empty-state');empty.append(el('strong','宝箱是空的'),el('p',cfg.host?'从物品库装入药水、装备或线索。':'里面暂时没有物品。'));body.append(empty);}
      const grid=el('div',undefined,'mi-inventory-grid');
      for(const content of marker.items){
        const cell=action('',()=>open(id,content.id));cell.className='mi-item-cell';cell.setAttribute('aria-label','查看箱内物品：'+content.name);cell.title=content.name;
        cell.append(PlayerBackpack.art(content),el('span',content.name,'mi-cell-name'),el('small','×'+content.quantity,'mi-cell-count'));grid.append(cell);
      }body.append(grid);
    }
    if(cfg.host&&child){
      const controls=el('div',undefined,'mi-settings-actions');controls.append(action('取出到地图',()=>change('unpack',{itemId:item.id})));
      controls.append(action('删除箱内物品',()=>{body.querySelector('.mi-confirm')?.remove();const confirm=el('div',undefined,'mi-confirm');confirm.append(el('p',`删除箱内的 ${item.name} ×${item.quantity}？`),action('确认删除',()=>change('deleteContent',{itemId:item.id}),'danger'),action('取消',()=>confirm.remove()));body.append(confirm);},'danger'));body.append(controls);
    }
    if(cfg.host&&!child){
      const settings=el('details',undefined,'mi-settings');settings.append(el('summary','设置'));
      const fields=el('div',undefined,'mi-settings-fields'),name=el('input');name.value=marker.name;name.maxLength=60;
      const size=el('select');for(const [v,t] of [[.25,'¼ 格'],[.5,'½ 格'],[.75,'¾ 格'],[1,'1 格'],[2,'2 格'],[4,'4 格']])size.append(new Option(t,v));size.value=marker.size;
      fields.append(labeled('显示名称',name),labeled('标记大小',size));settings.append(fields);
      const controls=el('div',undefined,'mi-settings-actions');controls.append(action('保存设置',()=>change('update',{name:name.value,size:Number(size.value)})));
      controls.append(action('移除标记',()=>{settings.querySelector('.mi-confirm')?.remove();const confirm=el('div',undefined,'mi-confirm');confirm.append(el('p',isContainer?'移除宝箱及箱内剩余物品？已发放的物品不受影响。':'移除地图上的这件物品？已发放的物品不受影响。'),action('确认移除',()=>change('remove',{}),'danger'),action('取消',()=>confirm.remove()));settings.append(confirm);},'danger'));settings.append(controls);
      if(isContainer){const lockSettings=el('section',undefined,'mi-lock-settings'),dc=el('input');dc.type='number';dc.min=1;dc.max=40;dc.value=marker.lockDC||15;
        const lockState=el('select');for(const [value,label] of [['none','未上锁'],['normal','普通锁'],['arcane','秘法锁']])lockState.append(new Option(label,value));lockState.value=marker.locked?(marker.lockType==='arcane'?'arcane':'normal'):'none';
        lockSettings.append(el('h3','宝箱锁'),labeled('锁的状态',lockState),labeled('普通锁开锁难度 DC',dc));const actions=el('div',undefined,'mi-settings-actions');
        actions.append(action('保存锁状态',()=>change('update',{locked:lockState.value!=='none',lockType:lockState.value==='arcane'?'arcane':'normal',lockDC:Number(dc.value)})),action('重置尝试机会',()=>change('update',{resetLockAttempts:true})));lockSettings.append(actions,el('p','普通锁可用巧手检定。秘法锁不能被普通开锁检定解除；由主控按法术规则裁定口令、解除魔法或敲击术。','mi-hint'));settings.append(lockSettings);}
      body.append(settings);
    }
    dialog.append(body);
    const footer=el('footer',undefined,'mi-footer'),visibility=el('span',marker.visible?'玩家可见':'仅主控可见','mi-visibility'+(marker.visible?' is-visible':''));footer.append(visibility);
    if(cfg.host){
      if(!child)footer.append(action(marker.visible?'隐藏':'展示给玩家',()=>change('update',{visible:!marker.visible})));
      if(!isContainer&&item)footer.append(action('发给玩家',()=>grantForm(body,marker,item,change),'primary'));
    }else if(!isContainer&&item)footer.append(action('领取到背包',()=>takeForm(body,item,change),'primary'));
    else if(lockedForPlayer&&body.querySelector('.mi-lock-start'))footer.append(body.querySelector('.mi-lock-start'));
    else footer.append(el('span',lockedForPlayer?(marker.lockType==='arcane'?'由主控裁定解除秘法锁':'解锁后查看箱内物品'):'点击物品查看并领取','mi-hint'));
    dialog.append(footer);
  }
  function takeForm(body,item,change){
    body.querySelector('.mi-grant')?.remove();const form=el('div',undefined,'mi-grant'),count=el('input');count.type='number';count.min=1;count.max=item.quantity;count.value=1;
    const recipients=cache?.recipients||[],character=recipientPicker(recipients);
    form.append(el('h3','领取 '+item.name),labeled('接收角色',character),labeled('领取数量',count),el('p',recipients.length?'领取后直接放入所选角色的背包。':'请先创建角色，再领取物品。','mi-hint'));
    const controls=el('div',undefined,'mi-form-actions');controls.append(action('取消',()=>form.remove()),action('确认领取',()=>{const quantity=Number(count.value);if(!character.value)throw new Error('请选择接收角色');if(!Number.isInteger(quantity)||quantity<1||quantity>item.quantity)throw new Error('请核对领取数量');return change('take',{itemId:item.id,characterId:character.value,quantity});},'primary'));form.append(controls);body.append(form);form.scrollIntoView({block:'nearest'});count.focus();
  }
  function recipientPicker(recipients){
    const input=el('select');input.setAttribute('aria-label','接收角色');input.append(new Option('请选择角色',''));
    for(const c of recipients)input.append(new Option(`${c.playerName?c.playerName+' / ':''}${c.name} · HP 上限 ${c.hpMax} · AC ${c.ac}`,c.id));
    if(recipients.length===1)input.value=recipients[0].id;
    return input;
  }
  async function grantForm(card,marker,item,change){
    if(busy||pending)return;const at=context(),id=selected;
    await refresh(true);
    if(!dialog?.open||selected!==id||contextKey(at)!==contextKey(context())||!card.isConnected)return;
    dialog.querySelector('.mi-grant')?.remove();
    const form=el('div',undefined,'mi-grant');form.append(el('h3','发放 '+item.name));
    const recipients=cache?.recipients||[],character=recipientPicker(recipients),fields=el('div',undefined,'mi-grant-fields');
    const count=el('input');count.type='number';count.min=1;count.max=item.quantity;count.value=1;
    fields.append(labeled('接收角色',character),labeled('发放数量',count));form.append(fields,el('p',`地图剩余 ${item.quantity} 件，确认后直接放入所选角色背包。`,'mi-hint'));
    const actions=el('div',undefined,'mi-form-actions');actions.append(action('取消',()=>form.remove()),action('确认发放',()=>{const quantity=Number(count.value),recipient=recipients.find(c=>c.id===character.value);if(!recipient||!Number.isInteger(quantity)||quantity<1||quantity>item.quantity)throw new Error('请选择角色并核对数量');return change('grant',{itemId:item.id,playerId:recipient.playerId,characterId:recipient.id,quantity});},'primary'));form.append(actions);card.append(form);form.scrollIntoView({block:'nearest',behavior:'smooth'});character.focus();
  }
  function cancelPlacement(){armed=null;banner?.remove();banner=null;cfg.board?.()?.classList.remove('mi-placing');}
  async function place(template,quantity=1,containerId=''){
    if(pending||busy){open(selected);return false;}
    const at=context();if(!at.mapId||!at.campaignId)throw new Error('请先打开一张地图，再放置物品或宝箱');
    await refresh(true);if(contextKey(at)!==contextKey(context())||!cache)throw new Error('地图已切换，请重新选择物品');
    if(containerId){const saved=await mutate('add',{markerId:containerId,templateId:template.id,templateVersion:template.version,quantity});if(saved)open(containerId);return saved;}
    cancelPlacement();armed={at:context(),op:template?'place':'container',fields:template?{templateId:template.id,templateVersion:template.version,quantity}:{}};
    banner=el('div',undefined,'mi-placement-banner');banner.append(el('span','点击地图放置'+(template?.name||'宝箱')+' · 默认仅主控可见'),button('取消',cancelPlacement));document.body.append(banner);cfg.board().classList.add('mi-placing');note('点击地图选择位置；Esc 取消');return true;
  }
  function updatePolling(){
    if(timer)clearInterval(timer);timer=null;
    if(document.hidden)return;
    timer=setInterval(()=>refresh().catch(()=>{}),1800);refresh().catch(()=>{});
  }
  function configure(options){
    cfg=options;
    const board=cfg.board?.();if(cfg.host&&board){
      board.addEventListener('pointerdown',e=>{if(!armed)return;e.preventDefault();e.stopImmediatePropagation();if(e.button!==0)return;const task=armed,p=point(e);cancelPlacement();mutate(task.op,{...task.fields,...p},task.at).catch(err=>note(err.message));},true);
      document.addEventListener('keydown',e=>{if(e.key==='Escape')cancelPlacement();});
    }
    const world=cfg.world?.();if(world)new MutationObserver(resize).observe(world,{attributes:true,attributeFilter:['style']});
    if(!visibilityBound){document.addEventListener('visibilitychange',updatePolling);visibilityBound=true;}
    updatePolling();
  }
  async function containers(){await refresh(true);return (cache?.markers||[]).filter(marker=>marker.kind==='container').map(marker=>({id:marker.id,name:marker.name||'宝箱'}));}
  return {configure,place,container:()=>place(null),containers,refresh,resize,checkSummary};
})();
