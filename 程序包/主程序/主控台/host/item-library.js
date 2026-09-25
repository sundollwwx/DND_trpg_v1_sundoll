/* Host template library. Backpacks contain independent copies, never live links. */
window.ItemLibrary=(()=>{
  let config={},dialog,list,detail,status,search,scope,campaign,type,rarity,library=null,selected='',busy=false,pending=null,epoch=0,mapContainer='';
  const categories={potion:'药水',scroll:'卷轴',wondrous:'奇物',gear:'普通物品',document:'信件与书籍',container:'容器'};
  const n=(tag,text,cls='')=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
  const msg=text=>{status.textContent=text;};
  const b=(text,action,cls='bp-quiet')=>{const el=n('button',text,cls);el.type='button';el.onclick=async()=>{try{await action();}catch(e){msg(e.message);}};return el;};
  const field=(label,input)=>{const wrap=n('label',label,'bp-label');input.setAttribute('aria-label',label);wrap.append(input);return wrap;};
  const select=(entries,value)=>{const el=n('select');for(const [id,text] of entries)el.append(new Option(text,id));el.value=value;return el;};
  const current=()=>config.campaign?.()||{id:'',name:''};
  const id=()=>crypto.randomUUID();
  async function api(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Sundoll-Local-Save':'1'},body:JSON.stringify(body)});const result=await response.json().catch(()=>({}));if(!response.ok||!result.ok){const e=new Error(result.error||'暂时无法连接，请重试原操作');e.status=response.status;throw e;}return result;}
  function lock(){for(const el of dialog.querySelectorAll('button,input,select,textarea'))el.disabled=busy||!!pending||el.dataset.permanentDisabled==='true';}
  async function run(path,command,kind='library',afterSave=''){if(busy||pending)return;pending={path,command:JSON.parse(JSON.stringify(command)),kind,afterSave};await retry();}
  async function retry(){
    if(busy||!pending)return;busy=true;lock();const task=pending;let next=null;
    try{const result=await api(task.path,task.command);pending=null;
      if(task.kind==='library'){library=result.library;selected=result.templateId||selected;render();show();msg('已保存到物品库。已发放的背包物品保持原样。');if(task.afterSave)next={action:task.afterSave,template:library.templates.find(t=>t.id===selected)};}
      else{show();msg(`已发放 ${result.event.name} ×${task.command.quantity}。角色背包已保存。`);}
    }catch(e){
      if(e.status&&e.status<500)pending=null;
      msg(e.message+(e.status===409?'；请刷新后重新核对。':''));
    }finally{busy=false;lock();if(pending){const retryButton=b('核对并重试原操作',retry,'bp-primary');status.append(retryButton);retryButton.disabled=false;}}
    if(next?.template){try{if(next.action==='map')placement(next.template,'map');else if(next.action==='chest')await chestPlacement(next.template);else if(next.action==='grant')await grant(next.template);}catch(e){msg('模板已保存；下一步暂未完成：'+e.message);}}
  }
  function ensure(){if(dialog)return;
    dialog=n('dialog',undefined,'backpack-dialog item-library-dialog');dialog.setAttribute('aria-label','物品库');
    const header=n('header',undefined,'bp-header'),heading=n('div');heading.append(n('span','THE QUARTERMASTER’S ARCHIVE','bp-eyebrow'),n('h2','物品库'),n('p','为旅程准备物品，将独立副本交给玩家。','bp-hint'));
    header.append(heading,b('关闭',()=>dialog.close(),'bp-close'));
    const tools=n('div',undefined,'il-tools');search=n('input');search.type='search';search.placeholder='搜索物品或剧情内容';search.setAttribute('aria-label','搜索物品库');
    scope=select([['active','全部物品'],['general','通用模板'],['campaign','战役专属'],['archived','已归档']], 'active');scope.setAttribute('aria-label','物品归属');
    campaign=select([['','所有战役']], '');campaign.setAttribute('aria-label','筛选战役');
    type=select([['','全部类型'],...Object.entries(categories)],'');type.setAttribute('aria-label','筛选类型');
    rarity=select([['','全部稀有度'],...['普通','非普通','珍稀','极珍稀','传说'].map(x=>[x,x])],'');rarity.setAttribute('aria-label','筛选稀有度');
    tools.append(search,scope,campaign,type,rarity,b('刷新',refresh));
    for(const el of [search,scope,campaign,type,rarity]){el.oninput=render;el.onchange=render;}
    const body=n('div',undefined,'il-body');list=n('section',undefined,'il-list bp-grid');list.setAttribute('aria-label','物品模板');detail=n('section',undefined,'il-detail bp-detail');detail.setAttribute('aria-label','物品模板详情');body.append(list,detail);
    status=n('div','','bp-status');status.setAttribute('role','status');dialog.append(header,tools,body,status);document.body.append(dialog);
    dialog.addEventListener('close',()=>{epoch++;});
  }
  function campaignChoices(){const choices=new Map();const c=current();if(c.id)choices.set(c.id,c.name||'当前战役');for(const t of library?.templates||[]){if(t.campaignId)choices.set(t.campaignId,t.campaignName||t.campaignId);for(const r of t.usedIn||[])choices.set(r.id,r.name||r.id);}return [...choices];}
  async function refresh(){if(busy||pending)return;const ticket=++epoch;busy=true;lock();msg('正在读取物品库…');try{const result=await api('/api/item-library',{op:'get'});if(ticket!==epoch)return;library=result.library;render();show();msg('物品库已更新');}finally{busy=false;lock();}}
  function render(){
    if(!library)return;const previous=campaign.value;campaign.replaceChildren(new Option('所有战役',''));for(const [key,name] of campaignChoices())campaign.append(new Option(name,key));campaign.value=previous;
    const q=search.value.trim().toLowerCase();list.replaceChildren();
    if(scope.value!=='archived'&&scope.value!=='general'&&(!type.value||type.value==='document')&&!rarity.value){
      for(const [kind,label] of [['letter','信件'],['book','书籍']]){
        if(q&&!label.includes(q))continue;
        const card=b('',()=>editor(null,null,kind),'bp-item il-create-document');card.setAttribute('aria-label','新建战役'+label);
        card.append(PlayerBackpack.art({category:'document',documentType:kind}),n('span','战役物品','bp-rarity'),n('strong',label),n('small','＋ 新建'+label,'bp-item-meta'));list.append(card);
      }
    }
    if(scope.value!=='archived'&&(!type.value||type.value!=='document')&&!rarity.value){
      for(const [kind,label] of Object.entries(categories).filter(([kind])=>kind!=='document'&&(!mapContainer||kind!=='container')&&(!type.value||type.value===kind))){
        if(q&&!label.includes(q))continue;
        const card=b('',()=>editor(null,null,'',kind),'bp-item il-create-document');card.setAttribute('aria-label','新建'+label);
        card.append(PlayerBackpack.art({category:kind}),n('span','新物品','bp-rarity'),n('strong',label),n('small','＋ 新建'+label,'bp-item-meta'));list.append(card);
      }
    }
    const matches=[...library.templates].sort((a,b)=>Number(b.category==='container')-Number(a.category==='container')).filter(t=>(!mapContainer||t.category!=='container')&&(scope.value==='archived'?t.archived:!t.archived)&&(scope.value!=='general'&&scope.value!=='campaign'||t.scope===scope.value)&&(!campaign.value||t.campaignId===campaign.value||(t.usedIn||[]).some(r=>r.id===campaign.value))&&(!type.value||t.category===type.value)&&(!rarity.value||t.rarity===rarity.value)&&[t.name,t.effect,t.description,t.body,t.campaignName].join(' ').toLowerCase().includes(q));
    for(const t of matches){const card=b('',()=>{selected=t.id;render();show();},'bp-item'+(selected===t.id?' selected':''));card.dataset.rarity=t.rarity;card.setAttribute('aria-label','查看模板：'+t.name);card.setAttribute('aria-pressed',String(selected===t.id));card.append(PlayerBackpack.art(t),n('span',t.rarity||'随身物品','bp-rarity'),n('strong',t.name),n('small',t.scope==='general'?'通用':t.campaignName||'战役','bp-item-meta'));list.append(card);}
    if(!matches.length)list.append(n('p','没有符合筛选的物品。可以修改筛选，或制作一件新物品。','bp-hint'));
  }
  const command=(op,t)=>({op,revision:library.revision,requestId:id(),...(t?{templateId:t.id,templateVersion:t.version}:{})});
  function show(){
    detail.replaceChildren();detail.scrollTop=0;const t=library?.templates.find(x=>x.id===selected);detail.dataset.rarity=t?.rarity||'';
    if(!t){detail.append(n('h3',mapContainer?'装入宝箱':'把故事装进行囊'),n('p',mapContainer?'选择一种物品，再确认装入数量。':'选择左侧信件或书籍卡片准备剧情正文；默认保存在当前战役，之后可放到地图、装入宝箱或发给玩家。','bp-hint'));return;}
    detail.append(PlayerBackpack.art(t,true),n('span',(t.rarity||categories[t.category])+(t.archived?' · 已归档':''),'bp-rarity'),n('h3',t.name),n('p',t.effect,'bp-effect'),n('p',PlayerBackpack.facts(t),'bp-item-facts'));
    if(t.description)detail.append(n('p',t.description,'bp-effect'));
    if(t.category==='document'&&t.body)detail.append(b(t.documentType==='book'?'翻阅书籍':'阅读正文',()=>PlayerBackpack.openDocument(t),'bp-primary'));
    detail.append(n('p',t.scope==='general'?'通用模板':t.campaignName||'战役专属','bp-hint'));
    if(t.usedIn?.length)detail.append(n('p','引用战役：'+t.usedIn.map(r=>r.name||r.id).join('、'),'bp-hint'));
    const actions=n('div',undefined,'il-actions il-primary-actions');
    if(!t.archived){const chest=b('放到宝箱',()=>chestPlacement(t),'il-action-button');if(t.category==='container'){chest.disabled=true;chest.dataset.permanentDisabled='true';chest.title='宝箱需要单独放到地图上';}actions.append(b('放到地图',()=>placement(t,'map'),'il-action-button'),chest,b('发给玩家',()=>grant(t),'il-action-button'));}
    const management=n('div',undefined,'il-management-actions');management.append(b('编辑模板',()=>editor(t)),b('复制为新模板',()=>run('/api/item-library',command('duplicate',t))));
    const archive=b(t.archived?'恢复模板':'归档模板',()=>{
      if(t.archived)return run('/api/item-library',command('restore',t));
      const confirm=n('div',undefined,'il-confirm');confirm.append(n('p','归档后停止新发放，玩家已有的物品继续保留。'),b('确认归档',()=>run('/api/item-library',command('archive',t)),'bp-danger'),b('取消',show));detail.append(confirm);archive.disabled=true;
    });management.append(archive);detail.append(actions,management,n('p',`模板版本 ${t.version} · 修改仅用于以后的发放`,'bp-hint'));
  }
  function placement(t,target=''){
    detail.replaceChildren();detail.scrollTop=0;
    const count=n('input');count.type='number';count.min='1';count.max='999';count.step='1';count.value='1';
    const container=target==='map'?'':target||mapContainer;
    if(t.category==='container'){count.max='1';count.disabled=true;count.dataset.permanentDisabled='true';}
    detail.append(n('h3',container?'装入宝箱':'放到地图'),n('strong',t.name),t.category==='container'?n('p','放置 1 个宝箱 · 每个宝箱独立存放物品。','bp-hint'):field('放置数量',count),n('p',container?'确认后加入所选宝箱。':'确认后点击地图选择位置；物品默认仅主控可见。','bp-hint'),
      b('确认放置',async()=>{if(busy||pending)return;const quantity=Number(count.value);if(!Number.isInteger(quantity)||quantity<1||quantity>999)throw new Error('数量应为 1–999');busy=true;lock();try{if(await MapItems.place(t,quantity,container))dialog.close();}finally{busy=false;lock();}},'bp-primary'),b('返回物品',show));
  }
  async function chestPlacement(t){
    const boxes=mapContainer?[{id:mapContainer,name:'当前宝箱'}]:await MapItems.containers();
    detail.replaceChildren();detail.scrollTop=0;
    detail.append(n('h3','放到宝箱'),n('strong',t.name));
    if(!boxes.length){detail.append(n('p','当前地图还没有宝箱。先在地图上放置一个宝箱，再回来装入物品。','bp-hint'),b('返回物品',show));return;}
    const choice=select(boxes.map(box=>[box.id,box.name]),boxes[0].id),count=n('input');count.type='number';count.min='1';count.max='999';count.step='1';count.value='1';
    detail.append(field('选择宝箱',choice),field('装入数量',count),b('确认装入',async()=>{if(busy||pending)return;const quantity=Number(count.value);if(!Number.isInteger(quantity)||quantity<1||quantity>999)throw new Error('数量应为 1–999');busy=true;lock();try{if(await MapItems.place(t,quantity,choice.value))dialog.close();}finally{busy=false;lock();}},'bp-primary'),b('返回物品',show));
  }
  function editor(t=null,fromBag=null,newDocumentType='',newCategory=''){
    if(!library||busy||pending)return;
    const base=t||{name:'',category:newDocumentType?'document':newCategory||'wondrous',documentType:newDocumentType||undefined,rarity:'普通',effect:newDocumentType==='book'?'可以翻阅其中的内容。':newDocumentType==='letter'?'可以阅读其中的内容。':'',scope:newDocumentType?'campaign':'general'},c=current(),expectedRevision=library.revision;
    detail.replaceChildren();detail.dataset.rarity=base.rarity||'';detail.append(n('h3',fromBag?'另存为物品模板':t?'编辑物品模板':'制作新物品'));
    const name=n('input');name.value=base.name;name.maxLength=60;
    const category=select(Object.entries(categories),base.category),quality=select(['普通','非普通','珍稀','极珍稀','传说'].map(x=>[x,x]),base.rarity||'普通');
    const effect=n('textarea');effect.value=base.effect;effect.maxLength=1200;
    const consume=n('input');consume.type='checkbox';consume.checked=!!base.consumable;
    const extra=PlayerBackpack.extraFields(base,msg,{compact:true,title:()=>name.value});
    const ownership=select([['general','通用模板'],...campaignChoices().map(([key,label])=>['campaign:'+key,label])],base.scope==='campaign'?'campaign:'+(base.campaignId||c.id):newDocumentType?'campaign:'+c.id:'general');
    const refs=structuredClone(base.usedIn||[]);
    const rule=select([['','由主控裁定'],['healing','治疗 2d4+2'],['greater-healing','治疗 4d4+4'],['superior-healing','治疗 8d4+8'],['supreme-healing','治疗 10d4+20']],base.ruleId||'');
    const qualityField=field('稀有度',quality),consumeField=field('使用后消耗一件',consume),ruleField=field('使用联动',rule);
    const update=()=>{const mundane=['gear','document','container'].includes(category.value);qualityField.hidden=mundane;consumeField.hidden=['document','container'].includes(category.value);extra.body.hidden=category.value!=='document';ruleField.hidden=category.value!=='potion';effect.placeholder=category.value==='document'?'例如：给玩家看的简短提示（正文写在下方）':'';};
    category.onchange=()=>{if(!t&&category.value==='document'&&c.id)ownership.value='campaign:'+c.id;update();};
    const basics=n('div',undefined,'il-editor-basics');basics.append(field('物品名称',name));
    basics.append(field('归属与战役',ownership),qualityField);
    detail.append(basics,field('简短说明',effect),consumeField,ruleField,extra.wrap);
    const save=action=>{
      const campaignId=ownership.value.startsWith('campaign:')?ownership.value.slice(9):'';
      if(ownership.value!=='general'&&!campaignId){msg('请先选择所属战役');return;}
      const metadata={scope:campaignId?'campaign':'general',campaignId,campaignName:campaignChoices().find(([key])=>key===campaignId)?.[1]||'',location:'',usedIn:refs};
      const item=fromBag?metadata:{name:name.value,category:category.value,rarity:quality.value,effect:effect.value,consumable:['document','container'].includes(category.value)?false:consume.checked,...extra.read(category.value==='document'),...metadata};
      if(!fromBag&&category.value==='potion'&&rule.value){item.ruleId=rule.value;item.ruleVersion=1;}
      const cmd={op:fromBag?'fromBag':t?'edit':'create',revision:expectedRevision,requestId:id(),item,...(fromBag||{}),...(!fromBag&&t?{templateId:t.id,templateVersion:t.version}:{})};
      return run('/api/item-library',cmd,'library',action);
    };
    if(fromBag){for(const el of [name,category,quality,effect,consume,rule,...extra.wrap.querySelectorAll('input,textarea,select,button')]){el.disabled=true;el.dataset.permanentDisabled='true';}detail.append(n('p','复制背包中这件物品的资料；备注、数量与角色归属不会写进模板。','bp-hint'));}
    const actions=n('div',undefined,'il-primary-actions il-save-actions');
    const chest=b('放到宝箱',()=>save('chest'),'il-action-button');if(category.value==='container'){chest.disabled=true;chest.dataset.permanentDisabled='true';chest.title='宝箱需要单独放到地图上';}
    actions.append(b('放到地图',()=>save('map'),'il-action-button'),chest,b('发给玩家',()=>save('grant'),'il-action-button'));
    detail.append(actions,b('取消',show));update();detail.scrollTop=0;
  }
  async function grant(t){
    if(busy||pending)return;const ticket=++epoch;busy=true;lock();
    try{const result=await api('/api/player-profiles',{op:'list'});if(ticket!==epoch||!dialog.open)return;
      detail.replaceChildren();detail.append(n('h3','发给玩家'),n('strong',t.name),n('p',PlayerBackpack.facts(t),'bp-item-facts'));
      const recipient=select([['','请选择玩家'],...result.players.filter(p=>p.enabled!==false).map(p=>[p.playerId,p.name])],'');
      const character=select([['','请先选择玩家']],'');character.setAttribute('aria-label','接收角色');
      let loadedPlayer='';
      recipient.onchange=async()=>{
        const pid=recipient.value;loadedPlayer='';character.replaceChildren(new Option('正在读取角色',''));
        if(!pid){character.replaceChildren(new Option('请先选择玩家',''));return;}
        try{
          const bag=await api('/api/backpack',{op:'get',playerId:pid,campaignId:current().id});
          if(ticket!==epoch||!dialog.open||recipient.value!==pid)return;
          const own=(bag.characters||[]).filter(c=>c.ownerPlayerId===pid);
          character.replaceChildren(new Option(own.length?'请选择角色':'该玩家尚无角色',''));
          for(const c of own)character.append(new Option(`${c.name} · HP 上限 ${c.base.hpMax} · AC ${c.base.ac}`,c.id));
          if(own.length===1)character.value=own[0].id;loadedPlayer=pid;
        }catch(e){if(ticket===epoch&&recipient.value===pid){character.replaceChildren(new Option('角色读取失败，请重新选择玩家',''));msg(e.message);}}
      };
      const count=n('input');count.type='number';count.min='1';count.max='999';count.step='1';count.value='1';
      const campaignId=current().id;
      const send=b('确认发放',async()=>{
        if(busy||pending)return;const pid=recipient.value,characterId=character.value,quantity=Number(count.value);if(!pid||loadedPlayer!==pid||!characterId||!Number.isInteger(quantity)||quantity<1||quantity>999){msg('请选择玩家及接收角色，并填写 1–999 的数量');return;}
        busy=true;lock();let bag;
        try{bag=(await api('/api/backpack',{op:'get',playerId:pid,campaignId})).backpack;}finally{busy=false;lock();}
        await run('/api/backpack',{op:'grant',playerId:pid,characterId,campaignId,revision:bag.revision,requestId:id(),templateId:t.id,templateVersion:t.version,quantity},'grant');
      },'bp-primary');
      detail.append(field('接收玩家',recipient),field('接收角色',character),field('发放数量',count),n('p','确认后直接放入所选角色的背包。','bp-hint'),send,b('取消',show));
    }finally{busy=false;lock();}
  }
  async function open(options={}){mapContainer=options.mapContainer||'';ensure();if(!dialog.open)dialog.showModal();if(pending){msg('上次操作结果待核对，请先重试原操作。');lock();const retryButton=b('核对并重试原操作',retry,'bp-primary');retryButton.disabled=false;status.append(retryButton);return;}try{await refresh();if(options.fromBag)editor(options.item,options.fromBag);}catch(e){msg(e.message);}}
  return {configure:options=>{config=options;},open};
})();
