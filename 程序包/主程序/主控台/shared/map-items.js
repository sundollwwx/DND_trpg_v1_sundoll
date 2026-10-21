/* Persistent map loot. The server owns quantities; uncertain writes retain their request ID. */
window.MapItems=(()=>{
  let cfg={},cache=null,key='',audience='',pending=null,busy=false,refreshJob=null,dialog=null,dialogEditing=false,selected='',selectedContent='',drag=null,armed=null,banner=null,signature='',timer=null,syncEpoch=0,visibilityBound=false;
  const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  const context=()=>{const m=cfg.map?.();return {campaignId:cfg.campaign?.()||'',packageContextRevision:cfg.packageContextRevision?.()||'',mapId:m?.id||'',...(cfg.host&&m?{hostMap:{id:m.id,mapW:m.mapW||10000,mapH:m.mapH||10000}}:{})};};
  const contextKey=c=>JSON.stringify([c.campaignId,c.mapId,c.packageContextRevision||'']);
  const audienceKey=()=>cfg.host?'host':'player:'+String(cfg.session?.()||'');
  const writeKey=(at=context(),who=audienceKey())=>JSON.stringify([at.campaignId,at.mapId,who]);
  const pendingWrites=new Map();
  const pendingTickets=new Map(),restoredWrites=new Set();let pendingOutbox=null,pendingStorageIssue='';
  function outbox(){
    if(!window.SundollPendingRequests)throw new Error('待核对请求组件尚未加载，请刷新完整页面；本次操作未发送');
    return pendingOutbox||=window.SundollPendingRequests.create({channel:'map-items',context:()=>({...context(),host:!!cfg.host,sessionToken:cfg.host?'':cfg.session?.()||''})});
  }
  function clearPending(scope){
    let warning='';try{const ticket=pendingTickets.get(scope);if(ticket)outbox().complete(ticket);}catch(error){warning=error.message;}
    pendingWrites.delete(scope);pendingTickets.delete(scope);restoredWrites.delete(scope);return warning;
  }
  // Moving a marker does not change its contents or permissions. Preserve open
  // forms across those moves while still checking every other field at submit.
  const actionState=marker=>{if(!marker)return '';const {x,y,revision,...state}=marker;return JSON.stringify(state);};
  const note=text=>cfg.toast?.(text);
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>{note(e.message);error(e.message);});return b;};
  function error(text){const box=dialog?.querySelector('.mi-status');if(box)box.textContent=text;}
  async function api(command){
    const response=await fetch('/api/map-items',{method:'POST',headers:{'Content-Type':'application/json',...(cfg.host?{'X-Sundoll-Local-Save':'1'}:{})},body:JSON.stringify({...command,...(!cfg.host?{sessionToken:command.sessionToken||cfg.session?.()}: {})})});
    const result=await response.json().catch(()=>({}));if(!response.ok||!result.ok){const e=new Error(response.status===404&&(!result.error||result.error==='not found')?'当前联机服务尚未加载地图物品功能，请重启启动器后刷新页面。':result.error||'地图物品暂时无法连接');if(response.status>=400)e.status=response.status;throw e;}return result;
  }
  function lock(){if(dialog)for(const b of dialog.querySelectorAll('button,input,select'))b.disabled=(busy||!!pending)&&b.dataset.allowClose!=='true';}
  function retryButton(){if(!dialog?.open)return;const b=button('核对并重试原操作',retry);dialog.querySelector('.mi-status')?.append(b);b.disabled=false;}
  async function retry(){
    if(busy||!pending)return;const task=pending,scope=writeKey(task,task.sessionToken?'player:'+task.sessionToken:'host');if(scope!==writeKey())return false;busy=true;syncEpoch++;lock();
    const restored=restoredWrites.has(scope);let cleanupWarning='';
    try{
      const authorized=await outbox().authorize(pendingTickets.get(scope));
      if(scope!==writeKey())return false;
      const result=await api(authorized);cleanupWarning=clearPending(scope);if(pending===task)pending=null;
      if(scope!==writeKey()||contextKey(task)!==contextKey(context())||(result.packageContextRevision&&cfg.packageContextRevision?.()&&result.packageContextRevision!==cfg.packageContextRevision()))return false;
      key=contextKey(context());cache=result;render();if(dialog?.open)show(selected);
      if(!restored&&['pickLock','inspireLock'].includes(task.op)&&result.check){cfg.playCheck?.(result.check,dialog);note(result.check.success?'开锁成功':'开锁失败');}else note(restored?'已核对原操作，地图物品已同步':'地图物品已保存');if(cleanupWarning)note(cleanupWarning);return true;
    }
    catch(e){
      if(e.status>=400&&e.status<500&&!e.pendingVerification){cleanupWarning=clearPending(scope);if(pending===task)pending=null;}
      if(scope!==writeKey())return false;
      if(pending&&!dialog?.open)open(selected);error(cleanupWarning||e.message);note(cleanupWarning||e.message);if(!pending)await refresh(true);return false;
    }
    finally{syncEpoch++;busy=false;lock();if(pending)retryButton();refresh().catch(()=>{});}
  }
  async function mutate(op,fields={},at=context()){
    if(busy||pending){note('请先核对上次操作');open(selected);return false;}
    if(contextKey(at)!==key||audience!==audienceKey()||!cache)throw new Error('地图已切换，请重新打开物品');
    const scope=writeKey(),original={...at,op,...fields,packageContextRevision:cache.packageContextRevision||at.packageContextRevision||'',...(!cfg.host?{sessionToken:cfg.session?.()}:{}),revision:cache.revision,requestId:crypto.randomUUID?.()||('loot-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''))};
    busy=true;syncEpoch++;lock();
    try{const saved=await outbox().prepare(original);if(scope!==writeKey()||contextKey(at)!==contextKey(context())){outbox().complete(saved.ticket);return false;}pending=saved.command;pendingWrites.set(scope,pending);pendingTickets.set(scope,saved.ticket);}finally{busy=false;lock();}
    return retry();
  }
  function clear(){syncEpoch++;cfg.world?.()?.querySelectorAll('.map-item-marker').forEach(e=>e.remove());signature='';cache=null;audience='';pending=null;selected='';selectedContent='';drag=null;if(dialog?.open)dialog.close();cancelPlacement();}
  async function refresh(force=false){
    const at=context(),nextKey=contextKey(at),nextAudience=audienceKey();
    if(nextKey!==key||nextAudience!==audience){clear();key=nextKey;audience=nextAudience;pending=pendingWrites.get(writeKey(at,nextAudience))||null;}
    if(!at.mapId||!at.campaignId||(!cfg.host&&!cfg.session?.())){clear();return;}
    if(document.hidden&&!force)return;
    if(refreshJob){await refreshJob;if(force)return refresh(true);return;}
    const epoch=syncEpoch,readSession=cfg.session?.();
    refreshJob=(async()=>{
      try{const data=await api({...at,op:'get'});if(contextKey(context())!==nextKey||epoch!==syncEpoch||(!cfg.host&&readSession!==cfg.session?.()))return;
        if(!pending&&!busy){const scope=writeKey(at,nextAudience);let saved;
          try{saved=await outbox().load();pendingStorageIssue='';}catch(error){if(pendingStorageIssue!==error.message)note(error.message);pendingStorageIssue=error.message;}
          if(contextKey(context())!==nextKey||epoch!==syncEpoch||nextAudience!==audienceKey())return;if(saved){pending=saved.command;pendingWrites.set(scope,pending);pendingTickets.set(scope,saved.ticket);restoredWrites.add(scope);}}
        if(data.packageContextRevision&&cfg.packageContextRevision?.()&&data.packageContextRevision!==cfg.packageContextRevision()){clear();return;}
        if(!busy&&!drag&&(!pending||!cache)){
          const changed=JSON.stringify(data)!==JSON.stringify(cache),previous=cache?.markers.find(v=>v.id===selected),recipientsChanged=JSON.stringify(data.recipients||[])!==JSON.stringify(cache?.recipients||[]);
          cache=data;
          if(changed||force){
            render();
            if(pending){open(pending.markerId||'');return;}
            if(dialog?.open&&(actionState(previous)!==actionState(cache.markers.find(v=>v.id===selected))||recipientsChanged)){
              if(cfg.host&&dialogEditing){error(actionState(previous)!==actionState(cache.markers.find(v=>v.id===selected))?'物品已更新':'角色已更新');dialog.querySelector('.mi-status')?.append(action('载入更新',()=>show(selected)));}
              else show(selected);
            }
          }
        }
      }catch(e){if(contextKey(context())!==nextKey||epoch!==syncEpoch||(!cfg.host&&readSession!==cfg.session?.()))return;if(!cfg.host&&!busy&&!pending&&!drag&&(e.status===401||e.status===403)){clear();}if(force)throw e;}
    })();
    try{await refreshJob;}finally{refreshJob=null;}
  }
  function zoom(){const z=Number(cfg.zoom?.());return Number.isFinite(z)&&z>0?z:1;}
  function point(event){const w=cfg.world().getBoundingClientRect(),m=cfg.map();return{x:Math.max(0,Math.min(m.mapW||10000,(event.clientX-w.left)/zoom())),y:Math.max(0,Math.min(m.mapH||10000,(event.clientY-w.top)/zoom()))};}
  function resize(){const grid=cfg.map()?.gridSize||50;for(const b of cfg.world?.()?.querySelectorAll('.map-item-marker')||[]){const side=grid*Number(b.dataset.size);b.style.width=b.style.height=side+'px';b.style.fontSize=side*.72+'px';const count=b.querySelector('small');if(count)count.style.fontSize=side*.28+'px';}}
  function icon(marker){return marker.kind==='container'?'🧰':marker.items[0]?.category==='document'?(marker.items[0]?.documentType==='book'?'▥':'✉'):({potion:'🧪',scroll:'📜',wondrous:'💎',gear:'◇'}[marker.items[0]?.category]||'📦');}
  // Built-in chests keep their three lock-state illustrations. Other containers
  // retain their own artwork, including player projections without template IDs.
  const standardChestImages=new Set([
    '2313b3ce86c47ed09283432b8d42c52abc74172b36545bb605cc9917395e4083',
    'f4fddba09721e344643e4e742816dea1412e02059e125a894ca1ee199a32275f',
    '44cd31473073cb50da878d46bb95b3f64a242995808fe7658facb7cea6b7f3f9'
  ].map(hash=>'/api/module-assets/'+hash));
  const chestArt=marker=>{
    const image=marker.containerItem?.image;
    if(image&&/^(\/api\/module-assets\/|https:\/\/|data:image\/)/.test(image)&&!standardChestImages.has(image))return image;
    return '/asset/界面/物品/宝箱/chest-'+(marker.locked?(marker.lockType==='arcane'?'arcane':'locked'):'unlocked')+'-v2.png';
  };
  const chestStatus=marker=>!marker.locked?'未上锁':marker.lockType==='arcane'?'秘法锁':'普通锁';
  function render(){
    if(!cfg.world?.()||drag)return;const next=JSON.stringify([key,cache?.markers]);if(next===signature){resize();return;}signature=next;
    cfg.world().querySelectorAll('.map-item-marker').forEach(e=>e.remove());
    for(const marker of cache?.markers||[]){
      const b=el('button',undefined,'map-item-marker'+(!marker.visible?' mi-hidden':'')+(!marker.items.length&&!marker.locked?' mi-empty':''));b.style.cursor=marker.positionLocked?'pointer':'grab';b.type='button';b.dataset.markerId=marker.id;b.dataset.size=marker.size;const position=pending?.op==='move'&&pending.markerId===marker.id&&contextKey(pending)===key?pending:marker;b.style.left=position.x+'px';b.style.top=position.y+'px';b.title=marker.name+(marker.positionLocked?' · 位置已固定':'')+(!marker.visible?' · 仅主控可见':'')+(marker.kind==='container'?' · '+chestStatus(marker):'')+(!marker.items.length&&!marker.locked?' · 已搜空':'');b.setAttribute('aria-label',b.title);
      const placedItem=marker.items[0],fallback=placedItem?.category==='document'?'/asset/界面/物品/文书/'+(placedItem.documentType==='book'?'book':'letter')+'-v2.png':({potion:'/asset/界面/物品/通用/potion-v1.png',scroll:'/asset/界面/物品/通用/scroll-v1.png',wondrous:'/asset/界面/物品/通用/wondrous-v1.png',gear:'/asset/界面/物品/通用/gear-v1.png'}[placedItem?.category]||''),image=marker.kind==='container'?chestArt(marker):placedItem?.image||fallback;
      if(image){const img=el('img');img.src=image;img.alt='';img.draggable=false;img.onerror=()=>{img.remove();b.prepend(el('span',icon(marker)));};b.append(img);}else b.append(el('span',icon(marker)));
      const count=marker.items.reduce((sum,i)=>sum+i.quantity,0);if(marker.kind!=='container'&&count>1)b.append(el('small','×'+count));
      b.addEventListener('mousedown',e=>e.stopPropagation());b.addEventListener('dblclick',e=>e.stopPropagation());
      b.onclick=e=>{e.stopPropagation();if(e.detail===0&&!busy&&!pending)open(marker.id);};
      b.onpointerdown=e=>{
        e.stopPropagation();if(e.button!==0||busy||pending||armed)return;e.preventDefault();b.setPointerCapture(e.pointerId);
        syncEpoch++;drag={b,marker,at:context(),clientX:e.clientX,clientY:e.clientY,zoom:zoom(),x:marker.x,y:marker.y,moved:false,pointerId:e.pointerId};
      };
      const move=e=>{if(drag?.b!==b||e.pointerId!==drag.pointerId)return;const dx=e.clientX-drag.clientX,dy=e.clientY-drag.clientY;if(Math.hypot(dx,dy)>6)drag.moved=true;if(!drag.moved||marker.positionLocked)return;const m=cfg.map();drag.x=Math.max(0,Math.min(m.mapW||10000,marker.x+dx/drag.zoom));drag.y=Math.max(0,Math.min(m.mapH||10000,marker.y+dy/drag.zoom));b.style.left=drag.x+'px';b.style.top=drag.y+'px';};
      b.onpointermove=move;
      // Capture loss and pointercancel can follow native browser gestures. Keep the
      // last measured destination instead of silently restoring the cached origin.
      const finish=(e,interrupted=false)=>{
        if(drag?.b!==b||(e?.pointerId!=null&&e.pointerId!==drag.pointerId))return;
        e?.stopPropagation?.();if(!interrupted)move(e);const d=drag;drag=null;
        if(d.moved&&!marker.positionLocked){mutate('move',{markerId:marker.id,markerRevision:marker.revision||0,x:d.x,y:d.y},d.at).catch(err=>note(err.message)).finally(()=>{signature='';render();});}
        else if(!interrupted&&!d.moved)open(marker.id);
      };
      b.draggable=false;b.ondragstart=e=>{e.preventDefault();e.stopPropagation();};
      b.onpointerup=e=>finish(e);b.onpointercancel=e=>finish(e,true);b.onlostpointercapture=e=>finish(e,true);cfg.world().append(b);
    }resize();
  }
  function ensureDialog(){if(dialog)return;dialog=el('dialog',undefined,'map-items-dialog');dialog.setAttribute('aria-label','地图物品');dialog.addEventListener('input',()=>{if(cfg.host)dialogEditing=true;});dialog.addEventListener('change',()=>{if(cfg.host)dialogEditing=true;});document.body.append(dialog);}
  function open(id,contentId=''){ensureDialog();selected=id;selectedContent=contentId;if(!dialog.open)dialog.showModal();show(id);}
  const categoryName=item=>item?.category==='document'?(item.documentType==='book'?'书籍':item.documentType==='letter'?'信件':'文书'):({potion:'药水',scroll:'卷轴',wondrous:'奇物',gear:'普通物品',container:'容器'}[item?.category]||'物品');
  function action(text,fn,kind='quiet'){const b=button(text,fn);b.className='mi-button mi-'+kind;return b;}
  function labeled(text,input){const label=el('label',undefined,'mi-field');label.append(el('span',text),input);input.setAttribute('aria-label',text);return label;}
  function description(parent,item){
    if(item.effect)parent.append(el('p',item.effect,'mi-effect'));
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

        const die=el('select');for(const v of [6,8,10,12])die.append(new Option('d'+v,v));die.value=attempt.inspirationDie||6;
        if(!attempt.inspirationDie)panel.append(labeled('已有的诗人激励骰',die));
        const actions=el('div',undefined,'mi-bonus-actions');actions.append(action(attempt.inspirationDie?`使用诗人激励 d${attempt.inspirationDie}`:'使用诗人激励',()=>change('inspireLock',{checkId:attempt.id,...(!attempt.inspirationDie?{inspirationDie:Number(die.value)}:{})}),'primary'),action('保留激励，结束检定',()=>change('finishLock',{checkId:attempt.id})));panel.append(actions);
      }else panel.append(el('p',attempt.critical==='fail'?'大失败':attempt.inspirationUsed?'开锁失败':'本次检定已结束'));
      return panel;
    }

    const mode=el('select');for(const [v,t] of [[0,'普通 · 1d20'],[1,'优势 · 2d20 取高'],[-1,'劣势 · 2d20 取低']])mode.append(new Option(t,v));mode.value=0;
    const modifier=el('input');modifier.type='number';modifier.min=-10;modifier.max=30;modifier.value=0;
    const fields=el('div',undefined,'mi-check-fields');fields.append(labeled('检定方式',mode),labeled('巧手加值',modifier));panel.append(fields);
    const bonuses=el('details',undefined,'mi-check-bonuses');bonuses.append(el('summary','额外加成'));
    const guidance=el('input');guidance.type='checkbox';const guideLabel=el('label',undefined,'mi-bonus-check');guideLabel.append(guidance,el('span','神导术 · +1d4'));guidance.setAttribute('aria-label','神导术');
    const inspiration=el('select');for(const [v,t] of [[0,'无'],[6,'已有 d6'],[8,'已有 d8'],[10,'已有 d10'],[12,'已有 d12']])inspiration.append(new Option(t,v));inspiration.value=0;
    bonuses.append(guideLabel,labeled('诗人激励',inspiration));panel.append(bonuses);
    panel.append(action('⚄ 尝试开锁',()=>{const bonus=Number(modifier.value);if(!Number.isInteger(bonus)||bonus< -10||bonus>30)throw new Error('请填写有效的巧手加值');return change('pickLock',{modifier:bonus,mode:Number(mode.value),guidance:guidance.checked===true,inspirationDie:Number(inspiration.value)});},'primary'));
    panel.querySelector('.mi-primary')?.classList.add('mi-lock-start');
    return panel;
  }
  function show(id){
    ensureDialog();dialogEditing=false;const marker=cache?.markers.find(v=>v.id===id);for(const child of Array.from(dialog.children)){if(!child.classList.contains('dice-fx-root'))child.remove();}
    const head=el('header',undefined,'mi-header'),close=action('×',()=>dialog.close(),'close');close.setAttribute('aria-label','关闭物品');close.dataset.allowClose='true';
    head.append(el('span',selectedContent?'箱内物品':marker?.kind==='container'?'地图容器':'地图物品','mi-eyebrow'),close);dialog.append(head);
    const status=el('div','','mi-status');status.setAttribute('role','status');dialog.append(status);
    if(pending){error('上次操作结果待核对，请重试同一操作。');lock();retryButton();return;}
    if(!marker){dialog.append(el('p','物品已被拿走或隐藏。','mi-missing'));return;}
    if(selectedContent&&!marker.items.some(v=>v.id===selectedContent))selectedContent='';
    const child=marker.items.find(v=>v.id===selectedContent),isContainer=marker.kind==='container'&&!child,item=child||(isContainer?(marker.containerItem||{name:marker.name,category:'container',rarity:'',effect:'容器',consumable:false}):marker.items[0]);
    dialog.classList.toggle('mi-container-view',isContainer);
    const headerTools=el('div',undefined,'mi-header-tools');
    if(child)headerTools.append(action('‹ 返回宝箱',()=>open(id)));
    if(item)headerTools.append(action(item.category==='document'?'阅读':'查看详情',()=>item.category==='document'?PlayerBackpack.openDocument(item,{shareSource:{mapId:context().mapId,markerId:id}}):PlayerBackpack.openItemDetail(item)));
    head.replaceChildren(headerTools,close);
    const at=context(),originalState=actionState(marker),viewAudience=audience,originalRecipients=cache?.recipients||[];
    const change=(op,fields)=>{
      const latest=cache?.markers.find(v=>v.id===id);
      if(!latest||actionState(latest)!==originalState||contextKey(at)!==key||viewAudience!==audienceKey())throw new Error('地图物品已更新，请重新核对');
      if(['take','grant'].includes(op)&&JSON.stringify(originalRecipients.find(v=>v.id===fields.characterId))!==JSON.stringify(cache?.recipients?.find(v=>v.id===fields.characterId)))throw new Error('角色已更新');
      return mutate(op,{markerId:id,markerRevision:latest.revision||0,...fields},at);
    };
    const body=el('div',undefined,'mi-body'),hero=el('div',undefined,'mi-hero'),copy=el('div',undefined,'mi-hero-copy');
    const art=PlayerBackpack.art(isContainer?{...item,image:chestArt(marker)}:(item||{category:'gear'}));hero.append(art);
    const meta=el('div',undefined,'mi-meta');meta.append(el('span',categoryName(item)),el('span',isContainer?(marker.locked?chestStatus(marker):`${marker.items.length} 种物品 · 未上锁`):`持有 ×${item?.quantity||0}`));
    if(item?.rarity)meta.append(el('span',item.rarity));
    if(!isContainer&&item?.category!=='document')meta.append(el('span',item?.consumable?'消耗品':'持有物品'));
    copy.append(el('h2',child?item.name:marker.name),meta);hero.append(copy);body.append(hero);
    if(!isContainer&&item)description(body,item);
    const lockedForPlayer=isContainer&&marker.locked&&!cfg.host;
    if(lockedForPlayer){
      if(marker.lockType==='arcane'){
        const panel=el('section',undefined,'mi-lock-panel');panel.append(el('h3','秘法锁封印'),el('span','秘法锁'));body.append(panel);
      }else body.append(lockPanel(marker,change));
    }
    if(isContainer&&!cfg.host&&marker.lockAttempt?.success)body.append(el('p',checkSummary(marker.lockAttempt)+' · '+(marker.lockAttempt.critical==='success'?'大成功':'开锁成功'),'mi-lock-result'));
    if(isContainer&&!lockedForPlayer){
      const inventoryHead=el('div',undefined,'mi-section-head');inventoryHead.append(el('h3','箱内物品'));
      if(cfg.host)inventoryHead.append(action('＋ 装入物品',()=>{dialog.close();window.ItemLibrary.open({mapContainer:id});}));body.append(inventoryHead);
      if(!marker.items.length){const empty=el('div',undefined,'mi-empty-state');empty.append(el('strong','空空如也'));body.append(empty);}
      const grid=el('div',undefined,'mi-inventory-grid');
      for(const content of marker.items){
        const cell=action('',()=>open(id,content.id));cell.className='mi-item-cell';cell.setAttribute('aria-label','查看箱内物品：'+content.name);cell.title=content.name;
        cell.append(PlayerBackpack.art(content),el('span',content.name,'mi-cell-name'),el('small','×'+content.quantity,'mi-cell-count'));grid.append(cell);
      }body.append(grid);
    }
    if(cfg.host&&item){
      body.append(action('编辑物品',()=>{
        dialogEditing=true;
        const editor=PlayerBackpack.definitionEditor(item),panel=el('section',undefined,'mi-edit-panel');
        const count=el('input');count.type='number';count.min=1;count.max=999;count.value=item.quantity||1;
        panel.append(editor.form);if(!isContainer)panel.append(labeled('数量',count));
        panel.append(action('保存',()=>change('editContent',{itemId:isContainer?'@container':item.id,item:editor.read(),...(!isContainer?{quantity:Number(count.value)}:{})}),'primary'),action('取消',()=>show(id)));
        body.replaceChildren(panel);
      }));
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
      const fixed=action(marker.positionLocked?'解除位置固定':'固定位置',()=>change('update',{positionLocked:!marker.positionLocked}));fixed.setAttribute('aria-pressed',String(!!marker.positionLocked));settings.append(fixed);const pickup=action(marker.pickupAllowed===false?'允许拾取':'禁止拾取',()=>change('update',{pickupAllowed:marker.pickupAllowed===false}));pickup.setAttribute('aria-pressed',String(marker.pickupAllowed!==false));settings.append(pickup);
      const controls=el('div',undefined,'mi-settings-actions');controls.append(action('保存设置',()=>change('update',{name:name.value,size:Number(size.value)})));
      controls.append(action('移除标记',()=>{settings.querySelector('.mi-confirm')?.remove();const confirm=el('div',undefined,'mi-confirm');confirm.append(el('p',isContainer?'移除宝箱及箱内剩余物品？已发放的物品不受影响。':'移除地图上的这件物品？已发放的物品不受影响。'),action('确认移除',()=>change('remove',{}),'danger'),action('取消',()=>confirm.remove()));settings.append(confirm);},'danger'));settings.append(controls);
      if(isContainer){const lockSettings=el('section',undefined,'mi-lock-settings'),dc=el('input');dc.type='number';dc.min=1;dc.max=40;dc.value=marker.lockDC||15;
        const lockState=el('select');for(const [value,label] of [['none','未上锁'],['normal','普通锁'],['arcane','秘法锁']])lockState.append(new Option(label,value));lockState.value=marker.locked?(marker.lockType==='arcane'?'arcane':'normal'):'none';
        lockSettings.append(el('h3','宝箱锁'),labeled('锁的状态',lockState),labeled('普通锁开锁难度 DC',dc));const actions=el('div',undefined,'mi-settings-actions');
        actions.append(action('保存锁状态',()=>change('update',{locked:lockState.value!=='none',lockType:lockState.value==='arcane'?'arcane':'normal',lockDC:Number(dc.value)})),action('重置尝试机会',()=>change('update',{resetLockAttempts:true})));lockSettings.append(actions);settings.append(lockSettings);}
      body.append(settings);
    }
    dialog.append(body);
    const footer=el('footer',undefined,'mi-footer'),visibility=el('span',marker.visible?'玩家可见':'仅主控可见','mi-visibility'+(marker.visible?' is-visible':''));footer.append(visibility);
    if(cfg.host){
      if(!child)footer.append(action(marker.visible?'隐藏':'展示给玩家',()=>change('update',{visible:!marker.visible})));
      if(!isContainer&&item)footer.append(action('发给玩家',()=>grantForm(body,marker,item,change),'primary'));
    }else if(!isContainer&&item&&marker.pickupAllowed!==false){
      const recipients=cache?.recipients||[],main=recipients.find(c=>c.collectionRole==='main')||recipients.find(c=>c.collectionRole!=='companion')||recipients[0];
      const take=action('领取',()=>{if(!main)throw new Error('请先创建角色');return change('take',{itemId:item.id,characterId:main.id,quantity:1});},'primary');take.disabled=!main;footer.append(take,action('领取选项',()=>takeForm(body,item,change)));
    }else if(!isContainer&&marker.pickupAllowed===false)footer.append(el('span','仅供查看','mi-visibility'));
    else if(lockedForPlayer&&body.querySelector('.mi-lock-start'))footer.append(body.querySelector('.mi-lock-start'));
    else if(lockedForPlayer)footer.append(el('span',marker.lockType==='arcane'?'秘法锁':'待解锁','mi-visibility'));
    dialog.append(footer);
  }
  function takeForm(body,item,change){
    body.querySelector('.mi-grant')?.remove();const form=el('div',undefined,'mi-grant'),count=el('input');count.type='number';count.min=1;count.max=item.quantity;count.value=1;
    const recipients=cache?.recipients||[],character=recipientPicker(recipients);
    form.append(el('h3','领取 '+item.name),labeled('接收角色',character),labeled('领取数量',count),el('span',''));
    const controls=el('div',undefined,'mi-form-actions');controls.append(action('取消',()=>form.remove()),action('确认领取',()=>{const quantity=Number(count.value);if(!character.value)throw new Error('请选择接收角色');if(!Number.isInteger(quantity)||quantity<1||quantity>item.quantity)throw new Error('请核对领取数量');return change('take',{itemId:item.id,characterId:character.value,quantity});},'primary'));form.append(controls);body.append(form);form.scrollIntoView({block:'nearest'});count.focus();
  }
  function recipientPicker(recipients){
    const input=el('select');input.setAttribute('aria-label','接收角色');input.append(new Option('请选择角色',''));
    for(const c of recipients)input.append(new Option(c.name,c.id));
    input.value=(recipients.find(c=>c.collectionRole==='main')||recipients.find(c=>c.collectionRole!=='companion')||recipients[0])?.id||'';
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
    fields.append(labeled('接收角色',character),labeled('发放数量',count));form.append(fields);
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
  function contextChanged(){if(key!==contextKey(context())||audience!==audienceKey())clear();return refresh(true).catch(()=>{});}
  return {configure,place,container:()=>place(null),containers,refresh,contextChanged,resize,checkSummary};
})();
