/* Player-owned inventory UI. Campaign changes do not change the inventory. */
window.PlayerBackpack = (() => {
  let config = {}, dialog, grid, detail, status, title, summary, search, filters, grantPanel, grantView=null;
  let playerId = '', snapshot = null, catalog = [], selected = '', filter = 'all', query = '', serial = 0, busy = false, timer;
  let removedSection, removedRows, totals, containerPicker, containerLabel, containerFilter='';
  const pending = new Map();
  const noteDrafts = new Map();
  const categories = {potion:'药水',scroll:'卷轴',wondrous:'奇物',gear:'普通物品',document:'信件与书籍',container:'容器'};
  let characters=[], recipients=[], transferQuantitySupported=false, walletSupported=false, walletBar, activeCampaign='';
  const node = (tag, text, cls='') => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  const button = (label, action, cls='') => {const n=node('button',label,cls); n.type='button';n.onclick=async()=>{try{return await action();}catch(e){message(e.message);}};return n;};
  const key = () => JSON.stringify([config.host ? playerId : config.playerId?.() || '', config.host ? 'host' : config.session?.() || '']);
  let loadedKey = '', returnAction = null, backButton, rarityFilter = '', magicFilter = '', setMagicFilter = () => {}, editing = false, resetRarity = () => {};
  const message = text => {status.textContent=text;};
  async function api(body) {
    const response=await fetch('/api/backpack',{method:'POST',headers:{'Content-Type':'application/json',...(config.host?{'X-Sundoll-Local-Save':'1'}:{})},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok || !result.ok){const error=new Error(result.error || '暂时无法连接背包，请重试');error.status=response.status;throw error;}
    return result;
  }
  function identity() {return {campaignId:config.campaignId?.()||'',playerId:config.host?playerId:config.playerId?.() || '',...(!config.host?{sessionToken:config.session?.() || ''}:{})};}
  function art(item, large=false) {
    const figure=node('div',undefined,'bp-art'+(large?' bp-art-large':''));figure.dataset.kind=item.category;
    figure.setAttribute('aria-hidden','true');
    const defaultArt=item.category==='document'?'/asset/界面/物品/文书/'+(item.documentType==='book'?'book':'letter')+'-v2.png':item.category==='container'?'/asset/界面/物品/宝箱/chest-unlocked-v2.png':({potion:'/asset/界面/物品/通用/potion-v1.png',scroll:'/asset/界面/物品/通用/scroll-v1.png',wondrous:'/asset/界面/物品/通用/wondrous-v1.png',gear:'/asset/界面/物品/通用/gear-v1.png'}[item.category]||'');
    if(item.image||defaultArt){const img=node('img');img.src=item.image||defaultArt;img.alt='';img.referrerPolicy='no-referrer';img.onerror=()=>{figure.replaceChildren(node('span',item.category==='document'?(item.documentType==='book'?'▥':'✉'):item.category==='scroll'?'▤':item.category==='gear'?'◇':item.category==='container'?'▣':'✧'));};figure.append(img);}
    else if(item.category==='container'){figure.append(node('i',undefined,'bp-chest'));}
    else if(item.category==='potion'){const bottle=node('i',undefined,'bp-bottle');bottle.append(node('i',undefined,'bp-liquid'));figure.append(bottle);}
    else figure.append(node('span',item.category==='document'?(item.documentType==='book'?'▥':'✉'):item.category==='scroll'?'▤':item.category==='gear'?'◇':'✧'));
    return figure;
  }
  function ensure() {
    if(dialog)return;
    dialog=node('dialog',undefined,'backpack-dialog');dialog.setAttribute('aria-labelledby','backpack-title');
    const header=node('header',undefined,'bp-header');
    const heading=node('div');heading.append(node('span','ADVENTURER’S SATCHEL','bp-eyebrow'));
    title=node('h2','冒险背包');title.id='backpack-title';heading.append(title);
    const navigation=node('div',undefined,'bp-header-actions');
    backButton=button('← 返回玩家档案',()=>{const action=returnAction;dialog.close();return action?.();},'bp-close');
    backButton.hidden=true;
    navigation.append(backButton,button('关闭',()=>dialog.close(),'bp-close'));
    header.append(heading,navigation);
    const tools=node('div',undefined,'bp-tools');search=node('input');search.type='search';search.placeholder='寻找物品…';search.setAttribute('aria-label','搜索背包物品');
    search.oninput=()=>{query=search.value;drawItems();};
    tools.append(search);
    if(config.host)tools.append(button('刷新',()=>load(false).catch(e=>message(e.message)),'bp-quiet'));
    if(config.host)tools.append(button('＋ 发放物品',()=>{grantPanel.hidden=false;dialog.dataset.mode='grant';if(!grantView||grantView.key!==key())renderGrant();else grantView.sync();},'bp-primary'));
    filters=node('div',undefined,'bp-filters');filters.setAttribute('aria-label','物品分类');
    for(const [id,label] of Object.entries({all:'全部',favorite:'★ 常用',...categories})){
      const b=button(label,()=>{filter=id;drawItems();});b.dataset.category=id;filters.append(b);
    }
    const rarityMenu=node('details',undefined,'bp-rarity-menu');
    const rarityLabel=node('summary');
    const gem=node('span',undefined,'bp-rarity-gem');gem.setAttribute('aria-hidden','true');
    const rarityCopy=node('span',undefined,'bp-rarity-copy');
    const rarityName=node('strong','全部稀有度');rarityCopy.append(node('small','物品品质'),rarityName);
    rarityLabel.append(gem,rarityCopy);
    const setRarityLabel=r=>{rarityName.textContent=r||'全部稀有度';rarityLabel.setAttribute('aria-label','按稀有度筛选：'+(r||'全部稀有度'));rarityMenu.dataset.rarity=r;};
    setRarityLabel('');
    const rarityOptions=node('div',undefined,'bp-rarity-options');rarityOptions.setAttribute('role','group');rarityOptions.setAttribute('aria-label','选择稀有度');
    for(const r of ['', '普通','非普通','珍稀','极珍稀','传说']){
      const option=button(r||'全部稀有度',()=>{rarityFilter=r;setRarityLabel(r);rarityMenu.open=false;rarityLabel.focus();for(const b of rarityOptions.children)b.setAttribute('aria-pressed',String(b.dataset.rarity===r));drawItems();});
      option.dataset.rarity=r;option.setAttribute('aria-pressed',String(r===''));rarityOptions.append(option);
    }
    rarityMenu.addEventListener('keydown',e=>{if(e.key==='Escape'&&rarityMenu.open){e.preventDefault();e.stopPropagation();rarityMenu.open=false;rarityLabel.focus();}});
    rarityMenu.addEventListener('focusout',e=>{if(!rarityMenu.contains(e.relatedTarget))rarityMenu.open=false;});
    resetRarity=()=>{rarityFilter='';setRarityLabel('');rarityMenu.open=false;for(const b of rarityOptions.children)b.setAttribute('aria-pressed',String(b.dataset.rarity===''));};
    const magicMenu=node('details',undefined,'bp-magic-menu'),magicSummary=node('summary');
    const magicCopy=node('span',undefined,'bp-magic-copy'),magicName=node('strong','全部物品');
    magicCopy.append(node('small','物品性质'),magicName);magicSummary.append(magicCopy);
    const magicOptions=node('div',undefined,'bp-magic-options');magicOptions.setAttribute('role','group');magicOptions.setAttribute('aria-label','选择物品性质');
    const magicLabels={'':'全部物品',magic:'魔法物品',mundane:'非魔法物品'};
    setMagicFilter=value=>{magicFilter=value;magicName.textContent=magicLabels[value];magicSummary.setAttribute('aria-label','物品性质：'+magicLabels[value]);magicMenu.open=false;
      for(const option of magicOptions.children)option.setAttribute('aria-pressed',String(option.dataset.magic===value));
      if(value==='mundane')resetRarity();rarityMenu.hidden=value==='mundane';drawItems();};
    for(const [value,label] of Object.entries(magicLabels)){
      const option=button(label,()=>{setMagicFilter(value);magicSummary.focus();});option.dataset.magic=value;option.setAttribute('aria-pressed',String(value===''));magicOptions.append(option);
    }
    magicSummary.setAttribute('aria-label','物品性质：全部物品');
    magicMenu.addEventListener('keydown',event=>{if(event.key==='Escape'&&magicMenu.open){event.preventDefault();event.stopPropagation();magicMenu.open=false;magicSummary.focus();}});
    magicMenu.addEventListener('focusout',event=>{if(!magicMenu.contains(event.relatedTarget))magicMenu.open=false;});
    magicMenu.append(magicSummary,magicOptions);tools.append(magicMenu);
    rarityMenu.append(rarityLabel,rarityOptions);tools.append(rarityMenu);
    summary=node('span','','bp-count');tools.append(summary);
    containerLabel=node('label','角色背包','bp-label bp-container-picker');containerPicker=node('select');containerPicker.setAttribute('aria-label','选择角色背包');
    containerPicker.onchange=()=>{containerFilter=containerPicker.value;selected='';draw();};
    containerLabel.append(containerPicker);containerLabel.hidden=true;
    grantPanel=node('section',undefined,'bp-grant');grantPanel.hidden=true;
    const body=node('div',undefined,'bp-body');const items=node('section',undefined,'bp-items');
    grid=node('div',undefined,'bp-grid');totals=node('p','','bp-totals');items.append(filters,totals,grid);
    if(config.host){removedSection=node('details',undefined,'bp-removed');removedSection.append(node('summary','已移除物品'));removedRows=node('div',undefined,'bp-removed-list');removedRows.id='bp-removed-rows';removedSection.append(removedRows);items.append(removedSection);}
    detail=node('aside',undefined,'bp-detail');detail.setAttribute('aria-label','物品详情');body.append(items,detail);
    status=node('div','','bp-status');status.setAttribute('role','status');
    const history=node('details',undefined,'bp-history');history.append(node('summary','最近的物品记录'));const rows=node('div');rows.id='bp-history-rows';history.append(rows);
    walletBar=node('section',undefined,'bp-wallet-bar');walletBar.setAttribute('aria-label','角色钱包');
    dialog.append(header,containerLabel,walletBar,tools,grantPanel,body,status,history);document.body.append(dialog);
    dialog.addEventListener('close',()=>{++serial;clearInterval(timer);});
    dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
    window.addEventListener('focus',()=>{if(dialog.open&&!busy&&!editing&&!pending.has(key()))load(true).catch(()=>{});});
  }
  async function load(quiet=false) {
    if(!dialog?.open || busy)return;
    const currentKey=key(),ticket=++serial;
    if(currentKey!==loadedKey){if(removedSection)removedSection.open=false;snapshot=null;selected='';loadedKey=currentKey;grantPanel.hidden=true;grantView=null;dialog.dataset.mode='backpack';draw();}
    if(!quiet)message('正在打开背包…');
    try{
      const result=await api({op:'get',...identity()});
      if(ticket!==serial || key()!==currentKey || !dialog.open)return;
      const firstLoad=!snapshot,changed=firstLoad || snapshot.revision!==result.backpack.revision;
      const characterChanged=JSON.stringify(characters)!==JSON.stringify(result.characters||[]);
      snapshot=result.backpack;transferQuantitySupported=result.transferQuantitySupported===true;walletSupported=result.walletCoinsSupported===true;catalog=result.catalog || catalog;characters=result.characters||[];recipients=result.recipients||characters;activeCampaign=result.campaignId||'';
      config.characters?.(characters,activeCampaign);
      title.textContent=config.host?`${result.profile.name}的背包`:'冒险背包';
      if(changed||characterChanged)draw();
      if(firstLoad&&!grantPanel.hidden)renderGrant();
      if(pending.has(currentKey))showRetry();else if(!quiet)message('物品已与主控存档同步');
    }catch(error){
      if(ticket!==serial || key()!==currentKey || !dialog.open)return;
      if(error.status===401 || error.status===403){snapshot=null;draw();}
      message(error.message);
      if(error.status===401 && config.signIn)status.append(button('使用名字登录',()=>{dialog.close();config.signIn();}));
    }
  }
  function inSelectedBackpack(item) {
    if(!snapshot?.modular)return true;
    if(config.host&&containerFilter==='__unassigned__')return !item.ownerCharacterId;
    return !!containerFilter&&item.ownerCharacterId===containerFilter;
  }
  function drawItems() {
    if(!grid)return;
    const top=grid.scrollTop;grid.replaceChildren();
    filters.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.category===filter)));
    const all=(snapshot?.items || []).filter(i=>i.quantity>0&&inSelectedBackpack(i));
    summary.textContent=`${all.length} 种 · ${all.reduce((sum,i)=>sum+i.quantity,0)} 件`;
    if(totals)totals.textContent=totalText(all);
    const matches=all.filter(i=>(filter==='all'||(filter==='favorite'?i.favorite:i.category===filter))&&(!magicFilter||(magicFilter==='magic'?!!i.rarity:!i.rarity))&&(!rarityFilter||i.rarity===rarityFilter)&&(`${i.name} ${i.effect} ${i.description||''} ${i.body||''} ${i.notes||''}`).toLowerCase().includes(query.trim().toLowerCase()));
    if(!matches.length&&snapshot?.modular&&!containerFilter){grid.append(node('p',ownCharacters().length?'请选择上方的角色背包。':'请先创建角色，再发放或领取物品。','bp-hint'));return;}
    if(!matches.length){const empty=node('div',undefined,'bp-empty');empty.append(node('span','✧'),node('h3',(query||rarityFilter||magicFilter||filter!=='all')?'没有符合筛选的物品':'旅程才刚刚开始'),node('p',(query||rarityFilter||magicFilter||filter!=='all')?'试试其他名称、分类或稀有度。':config.host?'从上方发放药水、卷轴或自定义奇物。':'主控发放的物品会出现在这里。'));grid.append(empty);}
    for(const item of matches){
      const card=button('',()=>{selected=item.id;draw();},'bp-item'+(item.id===selected?' selected':''));card.setAttribute('aria-label',`${item.name}，${item.quantity}件`);card.setAttribute('aria-pressed',String(item.id===selected));card.dataset.rarity=item.rarity;
      card.append(art(item),node('span',item.rarity||'随身物品','bp-rarity'),node('strong',(item.favorite?'★ ':'')+item.name),node('span',`${categories[item.category]} · ×${item.quantity}`,'bp-item-meta'));grid.append(card);
    }
    grid.scrollTop=top;
  }
  function draw() {
    if(!grid)return;
    editing=false;
    if(containerPicker){
      containerLabel.hidden=!snapshot?.modular;
      const own=ownCharacters(),hasLegacy=config.host&&snapshot?.items.some(i=>!i.ownerCharacterId&&i.quantity>0);
      containerPicker.replaceChildren(new Option(own.length?'请选择角色':'请先创建角色',''));
      for(const c of own)containerPicker.append(new Option(characterLabel(c),c.id));
      if(hasLegacy)containerPicker.append(new Option('待分配旧物品（需指定角色）','__unassigned__'));
      if(!own.some(c=>c.id===containerFilter)&&!(hasLegacy&&containerFilter==='__unassigned__'))containerFilter=own.length===1?own[0].id:'';
      containerPicker.value=containerFilter;
    }
    drawWallet();drawItems();detail.replaceChildren();detail.dataset.rarity='';
    const item=snapshot?.items.find(i=>i.id===selected && i.quantity>0 && inSelectedBackpack(i));
    if(!item){detail.append(node('span','✧','bp-detail-empty'),node('h3','留一点空间给奇遇'),node('p','选择一件物品，查看它的故事与效果。'));}
    else {
      detail.dataset.rarity=item.rarity;
      detail.append(button(item.category==='document'?'阅读':'查看详情',()=>item.category==='document'?openDocument(item):openItemDetail(item),'bp-detail-open'));
      detail.append(art(item,true),node('span',`${item.rarity?item.rarity+' · ':''}${categories[item.category]}`,'bp-rarity'),node('h3',item.name),node('p',item.effect,'bp-effect'),node('p',`持有 ${item.quantity} 件 · ${item.consumable?'使用后消耗':'可重复使用'}`,'bp-subtitle'));
      const quickActions=node('div',undefined,'bp-item-quick-actions');
      if(item.category!=='document'&&(item.ruleId||!config.host)){
        const use=button('使用',()=>item.ruleId?healingControls(item):mutate({op:'use',itemId:item.id}),'bp-primary');
        use.disabled=busy||pending.has(key())||loadedKey!==key();quickActions.append(use);
      }
      if(!config.host)quickActions.append(button('转移',()=>openTransfer(item),'bp-quiet'));
      const favorite=button('收藏',()=>mutate({op:'annotate',itemId:item.id,favorite:!item.favorite}),'bp-quiet');
      favorite.setAttribute('aria-pressed',String(!!item.favorite));quickActions.append(favorite);
      detail.append(quickActions,node('p',facts(item),'bp-item-facts'));
      if(item.description)detail.append(node('p',item.description,'bp-effect'));
      const management=node('details',undefined,'bp-item-management');management.append(node('summary','备注、角色归属与管理'));
      const notes=node('textarea');notes.value=noteDrafts.get(key()+'|'+item.id)??item.notes??'';notes.maxLength=2000;notes.setAttribute('aria-label','物品备注');notes.placeholder='记录来源、用途或需要提醒自己的事';notes.oninput=()=>{editing=true;noteDrafts.set(key()+'|'+item.id,notes.value);};
      management.append(node('label','物品备注（玩家与主持人可见）','bp-label'),notes,button('保存备注',()=>mutate({op:'annotate',itemId:item.id,notes:notes.value}),'bp-quiet'));
      if(config.host){management.append(button('编辑物品资料',()=>editItem(item),'bp-quiet'));if(window.ItemLibrary)management.append(button('另存为物品模板',()=>window.ItemLibrary.open({fromBag:{playerId,itemId:item.id,bagRevision:snapshot.revision},item}),'bp-quiet'));}
      if(config.host)characterControls(item,management);
      if(config.host) {
        const label=node('label','调整持有数量','bp-label');const number=node('input');number.type='number';number.min='0';number.max='999';number.value=String(item.quantity);number.setAttribute('aria-label','调整持有数量');label.append(number);management.append(label,button('保存数量',()=>mutate({op:'adjust',itemId:item.id,quantity:Number(number.value)}),'bp-primary'));
        management.append(node('small','设为 0 即收回物品，记录仍然保留。','bp-hint'));
      }
      detail.append(management);
      const remove=button(config.host?'删除物品':'弃置物品',()=>removalView(item),'bp-danger-link');remove.disabled=busy||pending.has(key());detail.append(remove);
    }
    const rows=dialog.querySelector('#bp-history-rows');rows.replaceChildren();
    for(const event of (snapshot?.history || []).slice(-12).reverse()){
      const row=node('p');const action=event.op==='grant'?'发放':event.op==='adjust'?'调整':event.op==='edit'?'编辑资料':event.op==='annotate'?'更新备注或收藏':event.op==='heal'?'治疗':event.op==='undo'?'撤销治疗':event.op==='assign'?'分配角色':event.op==='delete'?'删除':event.op==='discard'?'弃置':event.op==='restore'?'恢复':event.op==='purge'?'彻底删除':'使用';
      row.append(node('time',new Date(event.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})),node('span',`${event.actor}${action} ${event.name} · ${event.delta>0?'+':''}${event.delta}，剩余 ${event.remaining}`));
      if(event.op==='heal'){row.append(node('small',`${event.formula} [${event.dice.join('、')}] + ${event.bonus} = ${event.total} · ${event.effect}`));if(config.host&&!event.undone&&event.campaignId===activeCampaign)row.append(button('撤销这次治疗',()=>mutate({op:'undo',eventId:event.id}),'bp-quiet'));}
      rows.append(row);
    }
    if(!rows.children.length)rows.append(node('p','尚无物品记录。'));
    drawRemoved();
  }
  function drawRemoved(){
    if(!removedRows)return;
    removedRows.replaceChildren();
    const entries=snapshot?.removedItems||[];
    removedSection.children[0].textContent=`已移除物品 · ${entries.length} 条`;
    for(const entry of [...entries].reverse()){
      const row=node('div',undefined,'bp-removed-row'),copy=node('div');
      copy.append(node('strong',`${entry.item.name} ×${entry.item.quantity}`),node('small',`${entry.op==='delete'?'主控删除':'弃置'} · ${new Date(entry.at).toLocaleString()}`));
      const actions=node('div',undefined,'bp-removed-actions');
      const restore=button('恢复',()=>mutate({op:'restore',removalId:entry.id}),'bp-quiet');restore.setAttribute('aria-label',`恢复 ${entry.item.name} ×${entry.item.quantity}`);
      const purge=button('彻底删除',()=>{
        const reviewedKey=key(),reviewedRevision=snapshot?.revision;
        const hint=node('small','删除后无法从背包恢复；自动备份仍可能保留历史版本。','bp-removed-warning');
        const confirm=button('确认彻底删除',()=>{
          if(key()!==reviewedKey||snapshot?.revision!==reviewedRevision||!snapshot.removedItems.some(x=>x.id===entry.id)){drawRemoved();message('背包已更新，请重新核对这条记录');return;}
          return mutate({op:'purge',removalId:entry.id});
        },'bp-danger');
        confirm.setAttribute('aria-label',`确认彻底删除 ${entry.item.name} ×${entry.item.quantity}`);
        copy.append(hint);actions.replaceChildren(confirm,button('取消',drawRemoved,'bp-quiet'));
      },'bp-quiet');
      purge.setAttribute('aria-label',`彻底删除 ${entry.item.name} ×${entry.item.quantity}`);
      actions.append(restore,purge);for(const control of [restore,purge])control.disabled=busy||pending.has(key());row.append(copy,actions);removedRows.append(row);
    }
    if(!entries.length)removedRows.append(node('p','暂无删除或弃置的物品。','bp-hint'));
  }
  function removalView(item){
    if(busy||pending.has(key())){if(pending.has(key()))showRetry();return;}
    editing=true;const viewKey=key(),viewRevision=snapshot.revision;
    detail.replaceChildren();detail.scrollTop=0;
    const host=!!config.host,panel=node('section',undefined,'bp-removal-confirm');
    if(host)panel.append(node('span','背包整理','bp-eyebrow'),node('h3','删除物品'),node('strong',item.name),node('p',`当前持有 ${item.quantity} 件`,'bp-hint'));
    const quantity=node('input');quantity.type='number';quantity.min='1';quantity.max=String(item.quantity);quantity.step='1';quantity.value=host?String(item.quantity):'1';quantity.setAttribute('aria-label','弃置数量');
    const summary=node('p','','bp-removal-summary');summary.setAttribute('aria-live','polite');
    const confirm=button(host?'确认删除':'弃置',()=>{
      if(key()!==viewKey||snapshot?.revision!==viewRevision){draw();message('背包已更新，请核对最新物品后重新操作');return;}
      const count=Number(quantity.value);
      if(!Number.isInteger(count)||count<1||count>item.quantity){message('请填写有效的弃置数量');return;}
      return mutate({op:host?'delete':'discard',itemId:item.id,...(!host?{quantity:count}:{})});
    },'bp-danger');
    const sync=()=>{const count=Number(quantity.value),valid=Number.isInteger(count)&&count>=1&&count<=item.quantity;confirm.disabled=!valid||busy||pending.has(viewKey);summary.textContent=valid?`${host?'删除':'弃置'}「${item.name}」×${count}，剩余 ×${item.quantity-count}`:'数量应为 1 到当前持有数量';};
    quantity.oninput=sync;
    if(!host){const label=node('label','弃置数量','bp-label');label.append(quantity);panel.append(label);}
    if(host)panel.append(summary,node('p','这条物品将从该玩家背包移除。正文、备注与归属会保留，可在“已移除物品”恢复。','bp-hint'));
    const actions=node('div',undefined,'bp-removal-actions');
    actions.append(confirm,button('取消',draw,'bp-quiet'));panel.append(actions);
    detail.append(panel);sync();
  }
  function characterLabel(c){return c.name;}
  function ownCharacters(){return characters.filter(c=>c.ownerPlayerId===(config.host?playerId:config.playerId?.()));}
  function selectCharacters(label,list,value=''){
    const input=node('select');input.setAttribute('aria-label',label);input.append(new Option('请选择角色',''));
    for(const c of list)input.append(new Option(characterLabel(c),c.id));input.value=value;
    const wrap=node('label',label,'bp-label');wrap.append(input);return {wrap,input};
  }
  let transferDialog,transferContext;
  function openTransfer(item){
    if(transferDialog?.open)transferDialog.close();
    const currentKey=key(),view=node('dialog',undefined,'bp-transfer-dialog');transferDialog=view;transferContext=readingContext();
    view.setAttribute('aria-label','转移物品');
    const header=node('header',undefined,'bp-reader-header');header.append(node('strong','转移物品'),button('关闭',()=>view.close(),'bp-reader-close'));
    const content=node('div',undefined,'bp-transfer-content'),hint=node('p','','bp-hint');
    const candidates=recipients.filter(c=>c.id!==item.ownerCharacterId);
    const owner={input:{value:''},wrap:node('details',undefined,'bp-transfer-picker')};
    const choice=node('summary','选择接收玩家与角色');
    const options=node('div',undefined,'bp-transfer-options');
    for(const c of candidates)options.append(button(`${c.playerName||'玩家'} · ${c.name}`,()=>{owner.input.value=c.id;choice.textContent=`${c.playerName||'玩家'} · ${c.name}`;owner.wrap.open=false;}));
    owner.wrap.append(choice,options);
    const amount=node('input');amount.type='number';amount.min='1';amount.max=String(item.quantity);amount.step='1';amount.value='1';amount.setAttribute('aria-label','转移数量');
    const amountLabel=node('label','转移数量','bp-label');amountLabel.append(amount);
    const submit=button('确认转移',async()=>{
      if(currentKey!==key()){view.close();return;}
      if(!transferQuantitySupported){hint.textContent='数量转移需要更新联机服务，请主控重启后刷新页面';return;}
      if(!owner.input.value){hint.textContent='请选择接收角色';return;}
      const quantity=Number(amount.value);if(!Number.isInteger(quantity)||quantity<1||quantity>item.quantity){hint.textContent=`请输入 1 至 ${item.quantity} 的整数`;return;}
      submit.disabled=true;
      try{if(await mutate({op:'transfer',itemId:item.id,characterId:owner.input.value,quantity}))view.close();else hint.textContent=status.textContent;}
      finally{submit.disabled=false;}
    },'bp-reader-close');
    content.append(node('p',`${item.name} · 持有 ${item.quantity} 件`),owner.wrap,amountLabel,hint,submit);view.append(header,content);
    if(!transferQuantitySupported){hint.textContent='数量转移需要更新联机服务，请主控重启后刷新页面';submit.disabled=true;}
    if(!candidates.length){hint.textContent='暂无其他可接收的角色，请让接收玩家将角色带入公开地图';submit.disabled=true;}
    view.addEventListener('close',()=>{view.remove?.();if(transferDialog===view)transferDialog=null;});document.body.append(view);view.showModal();
  }
  function characterControls(item,container=detail){
    const own=ownCharacters();
    if(!snapshot?.modular&&(!activeCampaign||activeCampaign!==config.campaignId?.())){container.append(node('p','连接当前战役后，可以分配角色和使用治疗药水。','bp-hint'));return;}
    if(!own.length){container.append(node('p','先在玩家的个人棋子库中添加角色，再将棋子带入战役。','bp-hint'));return;}
    const owner=selectCharacters('移动到',own,item.ownerCharacterId||'');
    container.append(owner.wrap,button('转移物品',()=>{if(!owner.input.value){message('请选择接收角色');return;}return mutate({op:'assign',itemId:item.id,characterId:owner.input.value});},'bp-quiet'));
  }
  function walletText(wallet){return ['pp','gp','ep','sp','cp'].filter(u=>wallet?.coins?.[u]>0).map(u=>`${numberText(wallet.coins[u])} ${currencies[u][0]}`).join(' · ')||'空空如也';}
  const walletCharacter=()=>ownCharacters().find(c=>c.id===containerFilter)||(ownCharacters().length===1?ownCharacters()[0]:null);
  function drawWallet(){
    if(!walletBar)return;walletBar.replaceChildren();
    const c=walletCharacter();walletBar.hidden=!c||!snapshot;if(!c||!snapshot)return;
    const wallet=snapshot?.wallets?.[c.id];
    const copy=node('div');copy.append(node('small','钱包 · '+c.name),node('strong',walletSupported?walletText(wallet):'等待钱包服务更新'));
    const open=button('钱包',()=>openWallet(c),'bp-quiet');open.disabled=!walletSupported||busy||pending.has(key());
    walletBar.append(copy,open);
  }
  function openWallet(character){
    const view=node('dialog',undefined,'bp-transfer-dialog bp-wallet-dialog');view.setAttribute('aria-label','钱包');
    const context=readingContext(),currentKey=key(),cid=character.id;
    const wallet=snapshot?.wallets?.[cid]||{balanceCp:0,history:[]};
    const header=node('header',undefined,'bp-reader-header');header.append(node('strong',character.name+'的钱包'),button('关闭',()=>view.close(),'bp-reader-close'));
    const content=node('div',undefined,'bp-transfer-content');
    content.append(node('strong',walletText(wallet),'bp-wallet-balance'),node('p','普通币种自动找零；只有选择银金币时才会使用银金币。','bp-hint'));
    const form=node('div',undefined,'bp-wallet-form');
    const operation=node('select');operation.setAttribute('aria-label','钱包操作');
    for(const [id,label] of Object.entries(config.host?{credit:'发放',debit:'扣款',transfer:'转账'}:{debit:'支付',transfer:'转账'}))operation.append(new Option(label,id));operation.value=config.host?'credit':'debit';
    const amount=node('input');amount.type='number';amount.min='1';amount.step='1';amount.placeholder='金额';amount.setAttribute('aria-label','金额');
    const currency=node('select');currency.setAttribute('aria-label','币种');for(const [id,[name]] of Object.entries(currencies))currency.append(new Option(name+' · '+id.toUpperCase(),id));currency.value='gp';
    const target=node('select');target.setAttribute('aria-label','收款角色');target.append(new Option('选择收款角色',''));
    for(const c of recipients.filter(c=>c.id!==cid))target.append(new Option(`${c.playerName||'玩家'} · ${c.name}`,c.id));target.value='';target.hidden=true;
    operation.onchange=()=>{target.hidden=operation.value!=='transfer';};
    const note=node('input');note.placeholder='备注（选填）';note.maxLength=200;note.setAttribute('aria-label','收支备注');
    const hint=node('p','','bp-hint');
    const submit=button('确认',async()=>{
      if(currentKey!==key()||context!==readingContext()||!dialog.open){view.close();return;}
      const n=Number(amount.value);if(!Number.isSafeInteger(n)||n<=0){hint.textContent='请输入正整数金额';return;}
      if(operation.value==='transfer'&&!target.value){hint.textContent='请选择收款角色';return;}
      submit.disabled=true;
      try{if(await mutate({op:'wallet',characterId:cid,action:operation.value,amount:n,currency:currency.value,recipientId:operation.value==='transfer'?target.value:'',note:note.value||''}))view.close();else hint.textContent=status.textContent;}finally{submit.disabled=false;}
    },'bp-reader-close');
    form.append(operation,amount,currency,target,note);content.append(form,hint,submit);
    const history=node('details',undefined,'bp-wallet-history');history.append(node('summary','收支记录'));
    for(const record of [...wallet.history].reverse())history.append(node('p',`${record.deltaCp>0?'+':'−'}${record.currency?numberText(record.amount)+' '+currencies[record.currency][0]:numberText(Math.abs(record.deltaCp)/100)+' GP'} · ${record.effect}${record.note?' · '+record.note:''} · ${new Date(record.at).toLocaleString()}`));
    if(!wallet.history.length)history.append(node('p','暂无收支记录'));
    content.append(history);view.append(header,content);view.addEventListener('close',()=>view.remove?.());document.body.append(view);view.showModal();
  }
  function healingControls(item){
    const source=ownCharacters().find(c=>c.id===item.ownerCharacterId);
    if(!source){message('这件药水尚未归属有效角色，请主持人先指定背包归属。');return;}
    const context=readingContext(),currentKey=key();
    const view=node('dialog',undefined,'bp-transfer-dialog');view.setAttribute('aria-label','使用物品');
    const header=node('header',undefined,'bp-reader-header');header.append(node('strong',`使用 · ${item.name}`),button('关闭',()=>view.close(),'bp-reader-close'));
    const content=node('div',undefined,'bp-transfer-content');
    const target=selectCharacters('给谁使用',characters);
    const hint=node('p',`由 ${source.name} 使用，确认后消耗 1 件。`,'bp-hint');
    const use=button('确认使用',async()=>{
      if(context!==readingContext()||currentKey!==key()||!dialog.open){view.close();return;}
      const c=characters.find(c=>c.id===target.input.value);
      if(!c){hint.textContent='请选择治疗目标';return;}
      if(busy||pending.has(key())){hint.textContent='请先核对上一次操作结果';return;}
      view.close();
      return mutate({op:'heal',itemId:item.id,sourceCharacterId:source.id,characterId:c.id,targetRevision:c.revision});
    },'bp-reader-close');
    use.disabled=activeCampaign!==config.campaignId?.();
    content.append(target.wrap,hint,use);view.append(header,content);
    view.addEventListener('close',()=>view.remove?.());document.body.append(view);view.showModal();
  }
  let detailDialog,readerDialog,readerContext='',inviteDialog,inviteContext='';
  const readingInvites=[],seenReadingInvites=new Set();
  const readingContext=()=>JSON.stringify([config.session?.()||'',config.playerId?.()||'',config.campaignId?.()||'']);
  async function readingApi(command){
    const response=await fetch('/api/reading-share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...command,sessionToken:config.session?.()||'',campaignId:config.campaignId?.()||''})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.ok)throw new Error(response.status===404&&(!result.error||result.error==='not found')?'共享功能需要重启联机服务后使用':result.error||'共享暂时未成功，请重试');return result;
  }
  function clearReadingContext(){
    const context=readingContext();
    if(inviteContext!==context){readingInvites.length=0;seenReadingInvites.clear();inviteDialog?.close();inviteContext=context;}
    if(readerDialog?.open&&readerContext!==context)readerDialog.close();
  }
  function receiveReadingInvite(invite){
    clearReadingContext();
    const pid=config.playerId?.();
    if(config.host||!config.session?.()||!pid||invite.campaignId!==config.campaignId?.()||invite.senderId===pid||!Array.isArray(invite.recipients)||!invite.recipients.includes(pid)||typeof invite.shareId!=='string'||!Number.isFinite(invite.expiresAt)||invite.expiresAt<=Date.now()||seenReadingInvites.has(invite.shareId))return;
    seenReadingInvites.add(invite.shareId);if(seenReadingInvites.size>200)seenReadingInvites.delete(seenReadingInvites.values().next().value);
    if(readingInvites.length<8)readingInvites.push(invite);showReadingInvite();
  }
  function showReadingInvite(){
    if(inviteDialog?.open)return;
    let invite;while(readingInvites.length){const candidate=readingInvites.shift();if(candidate.expiresAt>Date.now()){invite=candidate;break;}}
    if(!invite)return;
    const context=readingContext(),view=node('dialog',undefined,'bp-reading-invite');inviteDialog=view;
    view.setAttribute('aria-label','阅读共享邀请');
    const hint=node('p',`${invite.senderName} 邀请你阅读《${invite.name}》`),feedback=node('p','','bp-hint');feedback.setAttribute('role','status');
    const actions=node('div',undefined,'bp-invite-actions');
    const decline=button('否，暂不阅读',()=>view.close(),'bp-reader-close');
    const accept=button('是，一起阅读',async()=>{
      if(accept.disabled)return;
      if(context!==readingContext()){view.close();return;}
      accept.disabled=true;
      try{
        const result=await readingApi({op:'accept',shareId:invite.shareId});
        if(view.open&&context===readingContext()){openDocument(result.item,{shared:true});view.close();}
      }catch(error){if(view.open){feedback.textContent=error.message;accept.disabled=Date.now()>=invite.expiresAt;}}
    },'bp-reader-close');
    actions.append(decline,accept);view.append(node('h2','是否接受阅读共享？'),hint,feedback,actions);
    let expiryTimer;
    view.addEventListener('close',()=>{if(typeof clearTimeout==='function')clearTimeout(expiryTimer);view.remove?.();if(inviteDialog===view)inviteDialog=null;showReadingInvite();});
    document.body.append(view);view.showModal();
    if(typeof setTimeout==='function')expiryTimer=setTimeout(()=>{if(view.open)view.close();},Math.max(0,invite.expiresAt-Date.now()));
  }
  function openItemDetail(item){
    if(detailDialog?.open)detailDialog.close();
    const view=node('dialog',undefined,'bp-item-detail-dialog');view.setAttribute('aria-label','查看详情：'+item.name);
    const header=node('header',undefined,'bp-item-detail-header');header.append(node('span','物品详情','bp-reader-kicker'),button('关闭',()=>view.close(),'bp-reader-close'));
    const content=node('div',undefined,'bp-item-detail-content');content.append(art(item,true),node('span',`${item.rarity?item.rarity+' · ':''}${categories[item.category]}`,'bp-rarity'),node('h2',item.name),node('p',item.effect,'bp-effect'));
    if(item.description)content.append(node('p',item.description,'bp-item-story'));
    content.append(node('p',facts(item),'bp-item-facts'));
    if(item.quantity!=null)content.append(node('p',`持有 ${item.quantity} 件 · ${item.consumable?'使用后消耗':'可重复使用'}`,'bp-hint'));
    view.append(header,content);view.addEventListener('click',event=>{if(event.target===view)view.close();});
    view.addEventListener('close',()=>{view.remove?.();if(detailDialog===view)detailDialog=null;});
    document.body.append(view);detailDialog=view;view.showModal();
  }
  function openDocument(item,options={}){
    if(readerDialog?.open)readerDialog.close();
    const editable=typeof options.onChange==='function',kind=item.documentType==='book'?'book':'letter';
    const pages=kind==='book'?(item.body||'').split('\f'):[item.body||(!editable?item.description||item.effect||'':'')];
    if(!pages.length)pages.push('');
    let spreadStart=0,activePage=0,animating=false,updateLetterProgress=null;
    const view=node('dialog',undefined,'bp-reader-dialog bp-reader-'+kind);view.setAttribute('aria-label',(editable?'编写':'阅读')+item.name);view.dataset.mode=editable?'edit':'read';
    const header=node('header',undefined,'bp-reader-header'),readingIdentity=readingContext();
    const readingStatus=node('span','','bp-reader-count');readingStatus.setAttribute('role','status');
    if(!editable&&!options.shared&&!config.host&&item.id&&config.session?.()){
      const share=button('共享',async()=>{
        if(share.disabled)return;
        if(readingIdentity!==readingContext()){readingStatus.textContent='身份或战役已切换，请重新打开';return;}
        share.disabled=true;
        try{const result=await readingApi({op:'invite',itemId:item.id,...(options.shareSource?{source:options.shareSource}:{})});if(readingIdentity===readingContext())readingStatus.textContent=`已邀请 ${result.recipientCount} 位玩家阅读`;}
        catch(error){readingStatus.textContent=error.message;}
        finally{share.disabled=false;}
      },'bp-reader-share');header.append(share);
    }
    header.append(node('span',kind==='book'?'书籍 · '+(editable?'编辑正文':'阅读'):'信件 · '+(editable?'编辑正文':'阅读'),'bp-reader-kicker'));
    header.append(button(editable?'完成':'关闭',()=>view.close(),'bp-reader-close'));
    const footer=node('footer',undefined,'bp-reader-footer');
    const changed=()=>options.onChange?.(kind==='book'?pages.join('\f'):pages[0]);
    if(kind==='letter'){
      const paper=node('article',undefined,'bp-letter-sheet');paper.append(node('h2',item.name||'未命名信件'));
      if(editable){const body=node('textarea');body.value=pages[0];body.maxLength=20000;body.placeholder='写下信件正文…';body.setAttribute('aria-label','信件正文');body.oninput=()=>{pages[0]=body.value;changed();};paper.append(body);}
      else paper.append(node('div',pages[0],'bp-document-body'));
      const progress=node('div',undefined,'bp-letter-progress'),progressFill=node('i');progress.setAttribute('aria-hidden','true');progress.append(progressFill);
      const stage=node('div',undefined,'bp-letter-stage');stage.append(paper);
      updateLetterProgress=()=>{const range=Math.max(0,(stage.scrollHeight||0)-(stage.clientHeight||0));if(progressFill.style)progressFill.style.width=(range?Math.round(100*stage.scrollTop/range):100)+'%';};
      stage.addEventListener('scroll',updateLetterProgress);view.append(header,progress,stage,footer);
      if(editable)footer.append(node('span','草稿会保留，完成后在物品库提交。','bp-reader-count'));
    }else{
      const spread=node('div',undefined,'bp-story-spread journal-pages');
      const left=node('section',undefined,'bp-story-page journal-left-page'),right=node('section',undefined,'bp-story-page journal-right-page');spread.append(left,right);
      const previous=button('← 上一页',()=>turn(spreadStart-2)),next=button('下一页 →',()=>turn(spreadStart+2)),counter=node('span',undefined,'bp-reader-count');
      const add=button('＋ 新增一页',()=>{if(pages.length>=24)return;pages.push('');activePage=pages.length-1;spreadStart=Math.floor(activePage/2)*2;render();changed();},'bp-reader-secondary');
      const remove=button('删除本页',()=>{pages.splice(activePage,1);if(!pages.length)pages.push('');activePage=Math.min(activePage,pages.length-1);spreadStart=Math.min(spreadStart,Math.floor((pages.length-1)/2)*2);render();changed();},'bp-reader-secondary');
      function pageContent(target,index){target.replaceChildren();target.append(node('small',index<pages.length?`第 ${index+1} 页`:'空白页','bp-story-page-number'));
        if(index===0)target.append(node('h2',item.name||'未命名书籍'));
        if(index>=pages.length){target.append(node('div','','bp-story-endpaper'));return;}
        if(editable){const body=node('textarea');body.value=pages[index];body.maxLength=20000;body.placeholder='写下这一页的故事…';body.setAttribute('aria-label',`第 ${index+1} 页正文`);body.onfocus=()=>{activePage=index;};body.oninput=()=>{pages[index]=body.value;activePage=index;changed();};target.append(body);}
        else target.append(node('div',pages[index],'bp-document-body'));
      }
      function render(){pageContent(left,spreadStart);pageContent(right,spreadStart+1);previous.disabled=spreadStart===0||animating;next.disabled=spreadStart+2>=pages.length||animating;counter.textContent=`${spreadStart+1}–${Math.min(spreadStart+2,pages.length)} / ${pages.length}`;if(editable)remove.disabled=pages.length===1&&pages[0]==='';}
      function snapshot(index,side,extra=''){const page=node('section',undefined,`bp-story-page journal-${side}-page ${extra}`);page.append(node('small',index<pages.length?`第 ${index+1} 页`:'空白页','bp-story-page-number'));if(index===0)page.append(node('h2',item.name||'未命名书籍'));page.append(node('div',pages[index]||'','bp-document-body'));page.setAttribute('aria-hidden','true');return page;}
      function turn(index){if(animating||index<0||index>=pages.length||index===spreadStart)return;
        const direction=index>spreadStart?1:-1,oldStart=spreadStart;
        const canAnimate=typeof spread.animate==='function'&&!(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
        spreadStart=index;activePage=index;render();if(!canAnimate)return;
        animating=true;previous.disabled=next.disabled=true;
        const fixedSide=direction>0?'left':'right',fromSide=direction>0?'right':'left';
        const stationary=snapshot(oldStart+(fixedSide==='right'?1:0),fixedSide,'journal-page-stationary-sheet');
        const sheet=node('div',undefined,`journal-page-turn-sheet journal-page-turn-takeoff ${direction>0?'turn-forward':'turn-backward'}`);
        sheet.append(snapshot(oldStart+(fromSide==='right'?1:0),fromSide,'journal-page-turn-face'));
        const landing=node('div',undefined,`journal-page-turn-sheet journal-page-turn-landing ${direction>0?'land-forward':'land-backward'}`);
        landing.append(snapshot(index+(fixedSide==='right'?1:0),fixedSide,'journal-page-turn-face'));
        spread.append(stationary,sheet,landing);
        const takeoffRotation=direction>0?-89.5:89.5,landingRotation=-takeoffRotation;
        const takeoff=sheet.animate([{transform:'rotateY(0deg)',filter:'brightness(1)',boxShadow:'0 0 3px #2c170811'},{transform:`rotateY(${takeoffRotation}deg)`,filter:'brightness(.74)',boxShadow:direction>0?'-30px 3px 38px #2c170899':'30px 3px 38px #2c170899'}],{duration:380,easing:'cubic-bezier(.55,.06,.68,.19)',fill:'forwards'});
        const settle=landing.animate([{transform:`rotateY(${landingRotation}deg)`,filter:'brightness(.74)',boxShadow:direction>0?'28px 3px 36px #2c170888':'-28px 3px 36px #2c170888'},{transform:'rotateY(0deg)',filter:'brightness(1)',boxShadow:'0 0 3px #2c170811'}],{duration:420,delay:350,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
        Promise.all([takeoff.finished.catch(()=>{}),settle.finished.catch(()=>{})]).finally(()=>{stationary.remove();sheet.remove();landing.remove();animating=false;render();});
      }
      footer.append(previous,counter,next);if(editable)footer.append(add,remove);
      view.append(header,spread,footer);render();
      view.addEventListener('keydown',event=>{if(event.target?.tagName==='TEXTAREA')return;if(event.key==='ArrowLeft')turn(spreadStart-2);if(event.key==='ArrowRight')turn(spreadStart+2);});
    }
    view.addEventListener('click',event=>{if(event.target===view)view.close();});
    view.addEventListener('close',()=>{view.remove?.();if(readerDialog===view)readerDialog=null;});
    footer.append(readingStatus);document.body.append(view);readerDialog=view;readerContext=readingIdentity;view.showModal();updateLetterProgress?.();return view;
  }
  function showRetry(){message('上次操作结果尚未确认。重试会核对原操作，不会重复扣除或发放。');status.append(button('核对并重试',()=>sendPending(key()),'bp-primary'));}
  function requestId(){
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function mutate(command){
    if(busy)return;
    if(loadedKey!==key()){await load();return;}
    if(!snapshot){message('请先连接背包');return;}
    if(pending.has(key())){showRetry();return;}
    pending.set(key(),{...command,...identity(),revision:snapshot.revision,requestId:requestId()});
    return await sendPending(key());
  }
  function animateItemRoll(event){
    const match=/^(\d+)d(\d+)(?:[+-]\d+)?$/i.exec(event?.formula||'');
    if(!match||!Array.isArray(event.dice)||event.dice.length!==Number(match[1])||!Number.isFinite(event.total))return;
    const sides=Number(match[2]);
    if(!event.dice.every(value=>Number.isInteger(value)&&value>=1&&value<=sides))return;
    // The server receipt is authoritative: never roll again for presentation.
    try{config.roll?.(sides,`${event.name} · ${event.formula}`,event.total,{dice:event.dice.slice(),surface:dialog,sizeScale:1.5,interrupt:true,detail:`${event.dice.join(' + ')} + ${event.bonus||0} = ${event.total}`});}catch(error){/* A visual failure must not turn a saved use into a retry. */}
  }
  async function sendPending(currentKey){
    const command=pending.get(currentKey);if(busy||!command||key()!==currentKey)return;
    let failed=false;busy=true;++serial;draw();if(grantView?.key===currentKey)grantView.sync();message('正在保存…');
    try{
      const result=await api(command);pending.delete(currentKey);if(command.op==='annotate'&&command.notes!==undefined)noteDrafts.delete(currentKey+'|'+command.itemId);
      if(key()!==currentKey || !dialog.open)return;
      snapshot=result.backpack;transferQuantitySupported=result.transferQuantitySupported===true;walletSupported=result.walletCoinsSupported===true;if(command.op==='grant')containerFilter=command.characterId||'';characters=result.characters||characters;recipients=result.recipients||recipients;activeCampaign=result.campaignId||activeCampaign;config.characters?.(characters,activeCampaign);if(command.op==='grant'&&grantView?.key===currentKey)grantView.complete(command,result.event);draw();message(command.op==='wallet'?result.event.effect:command.op==='delete'?`已删除「${result.event.name}」，可在已移除物品中恢复。`:command.op==='discard'?`已弃置「${result.event.name}」×${-result.event.delta}，剩余 ${result.event.remaining} 件。`:command.op==='restore'?`已恢复「${result.event.name}」×${result.event.delta}。`:command.op==='purge'?`已彻底删除「${result.event.name}」的移除记录。`:command.op==='heal'?`${result.event.formula}：${result.event.dice.join(' + ')} + ${result.event.bonus} = ${result.event.total}。${result.event.effect}，剩余 ${result.event.remaining} 件。`:command.op==='undo'?'已撤销治疗，药水已返还。':command.op==='use'?`已使用「${result.event.name}」。${result.event.effect}（剩余 ${result.event.remaining} 件）`:'物品已保存');
      animateItemRoll(result.event);
      return true;
    }catch(error){
      failed=true;
      if(error.status && error.status<500)pending.delete(currentKey);
      if(key()!==currentKey || !dialog.open)return;
      if(pending.has(currentKey))showRetry();else message(error.message);
      if(error.status===409){busy=false;await load(true);message(error.message);}
    }finally{busy=false;if(grantView?.key===key())grantView.sync();if(dialog.open){if(key()===currentKey){draw();if(failed&&command.op==='edit'){const item=snapshot?.items.find(i=>i.id===command.itemId);if(item)editItem({...item,...command.item});}}else load().catch(e=>message(e.message));}}
  }
  const currencies={cp:['铜币',1],sp:['银币',10],ep:['银金币',50],gp:['金币',100],pp:['铂金币',1000]};
  const numberText=n=>Number(n.toFixed(3)).toLocaleString('zh-CN',{maximumFractionDigits:3});
  function facts(item){const c=currencies[item.valueCurrency]||currencies.gp;return `单件参考价：${item.valueCp==null?'未知':numberText(item.valueCp/c[1])+' '+c[0]} · 重量：${item.weightLb==null?'未知':numberText(item.weightLb)+' 磅'}`;}
  function totalText(items){
    let cp=0,milli=0,unknownValue=0,unknownWeight=0;
    for(const i of items){if(i.quantity<=0)continue;if(i.valueCp==null)unknownValue++;else cp+=i.valueCp*i.quantity;if(i.weightLb==null)unknownWeight++;else milli+=Math.round(i.weightLb*1000)*i.quantity;}
    return `已知价值 ${numberText(cp/100)} 金币${unknownValue?'（另有 '+unknownValue+' 种未定价）':''} · 已知重量 ${numberText(milli/1000)} 磅${unknownWeight?'（另有 '+unknownWeight+' 种未填重量）':''}`;
  }
  function metricFields(item={}){
    const wrap=node('div',undefined,'bp-metrics');
    const value=node('input');value.type='number';value.min='0';value.placeholder='未知';value.setAttribute('aria-label','单件价值');
    const currency=node('select');currency.setAttribute('aria-label','价值币种');Object.entries(currencies).forEach(([id,c])=>currency.append(new Option(c[0],id)));currency.value=item.valueCurrency||'gp';
    value.value=item.valueCp==null?'':String(item.valueCp/currencies[currency.value][1]);value.step=String(1/currencies[currency.value][1]);
    let previousCurrency=currency.value;
    currency.onchange=()=>{if(value.value!=='')value.value=String(Number(value.value)*currencies[previousCurrency][1]/currencies[currency.value][1]);previousCurrency=currency.value;value.step=String(1/currencies[currency.value][1]);};
    const weight=node('input');weight.type='number';weight.min='0';weight.step='0.001';weight.max='1000000';weight.value=item.weightLb==null?'':String(item.weightLb);weight.placeholder='未知';weight.setAttribute('aria-label','单件重量（磅）');
    const priceLabel=node('label',undefined,'bp-label'),weightLabel=node('label',undefined,'bp-label');priceLabel.append(node('span','单件参考价'),value,currency);weightLabel.append(node('span','单件重量 · 磅'),weight);wrap.append(priceLabel,weightLabel);
    return {wrap,read:()=>{
      const cp=value.value===''?null:Number(value.value)*currencies[currency.value][1],lb=weight.value===''?null:Number(weight.value);
      if(value.validity?.badInput||weight.validity?.badInput||(cp!==null&&(!Number.isFinite(cp)||cp<0||cp>10000000000||Math.abs(cp-Math.round(cp))>0.00001)))throw new Error('价值不能为负，最小单位为 1 铜币');
      if(lb!==null&&(!Number.isFinite(lb)||lb<0||lb>1000000||Math.abs(lb*1000-Math.round(lb*1000))>0.00001))throw new Error('重量应为非负数，最多三位小数');
      return {valueCp:cp===null?null:Math.round(cp),valueCurrency:currency.value,weightLb:lb};
    }};
  }
  function extraFields(item={},report=message,options={}) {
    const wrap=node('div',undefined,'bp-custom');
    const description=node('textarea');description.value=item.description||'';description.maxLength=2000;description.placeholder='物品来历、外观与故事';description.setAttribute('aria-label','物品描述');
    const image=node('input');image.value=item.image||'';image.placeholder='HTTPS 图片地址，或上传图片';image.setAttribute('aria-label','物品图片');
    const upload=node('input');upload.type='file';upload.accept='image/png,image/jpeg,image/webp';upload.setAttribute('aria-label','上传物品图片');
    upload.onchange=()=>{const f=upload.files?.[0];if(!f)return;if(f.size>180000){report('请选择小于180KB的物品图片');return;}const reader=new FileReader();reader.onerror=()=>report('图片读取失败，请重新选择');reader.onload=()=>{image.value=String(reader.result);};reader.readAsDataURL(f);};
    const documentFields=node('section',undefined,'bp-document-fields');
    const kindLabel=node('label','文书形式','bp-label'),kind=node('select');kind.setAttribute('aria-label','文书形式');
    for(const [value,label] of [['letter','信件 · 单页'],['book','书籍 · 分页']])kind.append(new Option(label,value));
    kind.value=item.documentType==='book'?'book':'letter';kindLabel.append(kind);
    const body=node('textarea');body.value=item.body||'';body.maxLength=20000;body.placeholder='写给玩家阅读的信件正文';body.setAttribute('aria-label','文书正文');body.className='bp-document-input';
    const letterField=node('label','信件正文','bp-label');letterField.append(body);
    const bookEditor=node('div',undefined,'bp-book-editor'),pageControls=node('div',undefined,'bp-book-controls'),pageCount=node('span',undefined,'bp-book-page-count'),pageField=node('label',undefined,'bp-label'),pageHeading=node('span','第 1 页'),pageBody=node('textarea');
    pageBody.className='bp-document-input';pageBody.maxLength=20000;pageBody.setAttribute('aria-label','书籍当前页正文');pageBody.placeholder='写下这一页的故事…';pageField.append(pageHeading,pageBody);
    let pages=(item.body||'').split('\f'),pageIndex=0,currentKind=kind.value;
    const pageButton=(label,act)=>button(label,act,'bp-quiet bp-book-control');
    const previous=pageButton('← 上一页',()=>go(pageIndex-1)),next=pageButton('下一页 →',()=>go(pageIndex+1));
    const add=pageButton('＋ 新增一页',()=>{savePage();if(pages.length>=24){report('书籍最多 24 页');return;}pages.splice(pageIndex+1,0,'');go(pageIndex+1);});
    const remove=pageButton('删除本页',()=>{if(pages.length===1){pageBody.value='';pages[0]='';return;}pages.splice(pageIndex,1);showPage(Math.min(pageIndex,pages.length-1));});
    function savePage(){pages[pageIndex]=pageBody.value;}
    function showPage(index){pageIndex=Math.max(0,Math.min(pages.length-1,index));pageBody.value=pages[pageIndex]||'';pageHeading.textContent=`第 ${pageIndex+1} 页`;pageCount.textContent=`${pageIndex+1} / ${pages.length}`;previous.disabled=pageIndex===0;next.disabled=pageIndex===pages.length-1;}
    function go(index){savePage();showPage(index);}
    pageControls.append(previous,pageCount,next,add,remove);bookEditor.append(pageControls,pageField,node('p','每页分别保存，玩家阅读时可翻页。','bp-hint'));
    if(!options.compact)documentFields.append(kindLabel,letterField,bookEditor);
    function setKind(value){
      if(value==='book'&&currentKind!=='book')pages=[body.value||''];
      else if(value!=='book'&&currentKind==='book'){savePage();body.value=pages.join('\n\n');}
      currentKind=value==='book'?'book':'letter';kind.value=currentKind;documentFields.dataset.documentType=currentKind;letterField.hidden=currentKind==='book';bookEditor.hidden=currentKind!=='book';showPage(0);
    }
    kind.onchange=()=>setKind(kind.value);
    const metrics=metricFields(item);
    if(options.compact){
      const summary=node('p',undefined,'bp-compose-summary');
      const updateSummary=()=>{const text=kind.value==='book'?pages.join(''):body.value;summary.textContent=text.trim()?`${kind.value==='book'?pages.length+' 页 · ':''}${text.trim().length} 字 · 点击继续编辑`:'还没有正文，点击打开书写界面。';};
      const compose=button(kind.value==='book'?'打开书籍编辑页':'打开信件编辑页',()=>{
        const draft=kind.value==='book'?pages.join('\f'):body.value;
        openDocument({...item,name:options.title?.()||item.name||'未命名',documentType:kind.value,body:draft},{onChange:text=>{if(kind.value==='book')pages=text.split('\f');else body.value=text;updateSummary();}});
      },'bp-compose-open');
      documentFields.append(compose,summary);updateSummary();wrap.append(documentFields,metrics.wrap);
    }
    else wrap.append(metrics.wrap,description,image,upload,documentFields);
    setKind(kind.value);
    return {wrap,body:documentFields,metrics:metrics.wrap,setDocumentType:setKind,read:(isDocument=false)=>{
      if(!options.compact)savePage();const text=kind.value==='book'?pages.join('\f'):body.value;
      if(isDocument&&(!text.trim()||kind.value==='book'&&pages.some(page=>!page.trim())))throw new Error('请填写每一页的正文');
      if(isDocument&&text.length>20000)throw new Error('正文最多 20000 字');
      return {description:description.value,image:image.value.trim(),body:isDocument?text:body.value,...(isDocument?{documentType:kind.value}:{}),...metrics.read()};
    }};
  }
  function editItem(item){
    editing=true;
    detail.replaceChildren();detail.append(node('h3','编辑物品资料'));
    const name=node('input');name.value=item.name;name.maxLength=60;name.setAttribute('aria-label','编辑物品名称');
    const effect=node('textarea');effect.value=item.effect;effect.maxLength=1200;effect.setAttribute('aria-label','编辑使用说明');
    const extra=extraFields(item);
    extra.body.hidden=item.category!=='document';
    detail.append(name,effect,extra.wrap,node('p','资料修改会同步到该玩家背包。数量保持不变。','bp-hint'),button('保存资料',()=>mutate({op:'edit',itemId:item.id,item:{...item,name:name.value,effect:effect.value,...extra.read(item.category==='document')}}),'bp-primary'),button('取消编辑',draw));
  }
  function renderGrant(){
    grantPanel.replaceChildren();grantView=null;
    if(!snapshot){grantPanel.append(node('p','先连接玩家背包，再发放物品。'));return;}
    const viewKey=key(),recipient=title.textContent.replace(/的背包$/,'');
    const own=ownCharacters(),recipientCharacter=selectCharacters('接收角色',own,own.some(c=>c.id===containerFilter)?containerFilter:own.length===1?own[0].id:'');
    recipientCharacter.wrap.className+=' bp-recipient-picker';
    let mode='catalog',chosen='',chosenTemplate=null,issued=false;
    const heading=node('div',undefined,'bp-grant-heading');
    const headingCopy=node('div');headingCopy.append(node('h3','发放物品'),node('p','接收玩家 · '+recipient,'bp-grant-recipient'));
    heading.append(headingCopy,button('返回背包',()=>{grantPanel.hidden=true;dialog.dataset.mode='backpack';},'bp-quiet'));
    const modes=node('div',undefined,'bp-grant-modes');modes.setAttribute('role','group');modes.setAttribute('aria-label','物品来源');
    const fromLibrary=button('从物品库选择',()=>setMode('catalog'));
    const fromCustom=button('自定义物品',()=>setMode('custom'));modes.append(fromLibrary,fromCustom);
    const layout=node('div',undefined,'bp-grant-layout');
    const library=node('section',undefined,'bp-grant-library');
    const lookup=node('input');lookup.type='search';lookup.placeholder='搜索名称或使用说明';lookup.setAttribute('aria-label','搜索可发放物品');
    const resultCount=node('p','','bp-grant-count');resultCount.setAttribute('role','status');
    const results=node('div',undefined,'bp-grant-results');results.setAttribute('role','group');results.setAttribute('aria-label','可发放物品');
    library.append(lookup,resultCount,results);
    const preview=node('section',undefined,'bp-grant-preview');preview.setAttribute('aria-label','待发放物品详情');
    const custom=node('section',undefined,'bp-grant-custom');
    const field=(text,input)=>{const label=node('label',text,'bp-label');label.append(input);return label;};
    const name=node('input');name.placeholder='例如：月潮护符';name.maxLength=60;name.setAttribute('aria-label','物品名称');
    const type=node('select');type.setAttribute('aria-label','物品类型');Object.entries(categories).forEach(([id,label])=>type.append(new Option(label,id)));type.value='wondrous';
    const rarity=node('select');rarity.setAttribute('aria-label','物品稀有度');['普通','非普通','珍稀','极珍稀','传说'].forEach(v=>rarity.append(new Option(v,v)));rarity.value='普通';
    const properties=node('div',undefined,'bp-grant-properties');properties.append(field('类型',type),field('稀有度',rarity));
    const effect=node('textarea');effect.placeholder='写下玩家需要知道的使用方式';effect.maxLength=1200;effect.setAttribute('aria-label','物品效果');
    const consume=node('input');consume.type='checkbox';consume.checked=false;const consumeLabel=node('label','使用后消耗 1 件','bp-grant-consume');consumeLabel.prepend(consume);
    const extra=extraFields(),optional=node('details',undefined,'bp-grant-optional');optional.append(node('summary','添加图片与故事（可选）'),extra.wrap);
    custom.append(field('物品名称',name),properties,field('简短说明',effect),consumeLabel,extra.metrics,optional);
    layout.append(library,custom,preview);
    const footer=node('div',undefined,'bp-grant-footer');
    const quantity=node('input');quantity.type='number';quantity.min='1';quantity.max='999';quantity.step='1';quantity.value='1';quantity.setAttribute('aria-label','发放数量');
    const review=node('div',undefined,'bp-grant-review');review.setAttribute('aria-live','polite');
    const receipt=node('p','','bp-grant-receipt');receipt.setAttribute('role','status');receipt.hidden=true;
    const submit=button('确认发放',()=>{
      if(busy||pending.has(key())||issued||viewKey!==key())return;
      const qty=Number(quantity.value);
      if(!recipientCharacter.input.value){message('请选择接收角色；没有角色时请先创建角色');return;}
      if(!Number.isInteger(qty)||qty<1||qty>999){message('发放数量应为 1–999');return;}
      if(mode==='catalog'&&!chosen){message('请先选择要发放的物品');return;}
      if(mode==='custom'&&(!name.value.trim()||!effect.value.trim())){message('请填写物品名称与使用说明');return;}
      return mutate({op:'grant',characterId:recipientCharacter.input.value,quantity:qty,...(mode==='custom'?{item:{name:name.value,category:type.value,rarity:['gear','document','container'].includes(type.value)?'':rarity.value,effect:effect.value,consumable:consume.checked,...extra.read(type.value==='document')}}:chosenTemplate?.version?{templateId:chosen,templateVersion:chosenTemplate.version}:{presetId:chosen})});
    },'bp-primary');
    footer.append(field('数量',quantity),review,submit);
    function definition(){return mode==='custom'?{name:name.value.trim(),category:type.value,rarity:['gear','document','container'].includes(type.value)?'':rarity.value,effect:effect.value,consumable:consume.checked}:chosenTemplate;}
    function sync(){
      const locked=busy||pending.has(viewKey)||viewKey!==key();
      for(const input of grantPanel.querySelectorAll('input,select,textarea,button'))input.disabled=locked;
      const item=definition(),qty=Number(quantity.value),valid=Number.isInteger(qty)&&qty>=1&&qty<=999;
      submit.disabled=locked||issued||!recipientCharacter.input.value||!item||!item.name||!valid||(mode==='custom'&&!effect.value.trim());
      submit.textContent=busy?'正在发放…':pending.has(viewKey)?'等待核对结果':issued?'已发放':'确认发放';
      review.replaceChildren(node('strong',item?.name?`${item.name} × ${valid?qty:'—'}`:'尚未选择物品'),node('small','发放给 '+recipient+' / '+(own.find(c=>c.id===recipientCharacter.input.value)?.name||'请选择角色')));
      fromLibrary.setAttribute('aria-pressed',String(mode==='catalog'));fromCustom.setAttribute('aria-pressed',String(mode==='custom'));
    }
    function renderPreview(){
      const item=definition();preview.replaceChildren();preview.dataset.rarity=item?.rarity||'';
      if(!item||!item.name){preview.append(node('span','✧','bp-grant-preview-empty'),node('h4',mode==='custom'?'打造一件专属物品':'先选一件物品'),node('p',mode==='custom'?'填写名称和使用说明，图片与故事可以稍后补充。':'点击左侧物品查看说明，确认后再发放。','bp-hint'));return;}
      preview.append(art(item),node('span',`${item.rarity?item.rarity+' · ':''}${categories[item.category]}`,'bp-rarity'),node('h4',item.name),node('p',item.effect,'bp-effect'),node('small',item.consumable?'使用后消耗':'可重复使用','bp-hint'));
      if(mode==='catalog')preview.append(node('p',facts(item),'bp-item-facts'));
    }
    function resetIssued(){issued=false;receipt.hidden=true;}
    function renderResults(){
      const q=lookup.value.trim().toLowerCase(),matches=catalog.filter(i=>(i.name+' '+i.effect).toLowerCase().includes(q));
      if(chosen&&!matches.some(i=>i.id===chosen)){chosen='';chosenTemplate=null;}
      results.replaceChildren();resultCount.textContent=`${matches.length} 件可选物品`;
      for(const item of matches){
        const row=button('',()=>{if(busy||pending.has(key()))return;chosen=item.id;chosenTemplate={...item};resetIssued();for(const b of results.children)b.setAttribute('aria-pressed',String(b.dataset.presetId===chosen));renderPreview();sync();},'bp-grant-result');
        row.dataset.rarity=item.rarity;row.dataset.presetId=item.id;row.setAttribute('aria-label','选择物品：'+item.name);row.setAttribute('aria-pressed',String(item.id===chosen));
        const text=node('span',undefined,'bp-grant-result-copy');text.append(node('strong',item.name),node('small',categories[item.category]));
        row.append(text,node('span',item.rarity||'随身物品','bp-rarity'));results.append(row);
      }
      if(!matches.length)results.append(node('p','没有匹配物品。试试其他关键词，或切换到“自定义物品”。','bp-hint'));
    }
    function setMode(next){if(busy||pending.has(key()))return;mode=next;resetIssued();library.hidden=mode!=='catalog';custom.hidden=mode!=='custom';renderPreview();sync();}
    lookup.oninput=()=>{resetIssued();renderResults();renderPreview();sync();};
    quantity.oninput=()=>{resetIssued();sync();};
    recipientCharacter.input.onchange=()=>{resetIssued();sync();};
    for(const input of [name,effect,type,rarity,consume]){input.oninput=()=>{resetIssued();renderPreview();sync();};input.onchange=input.oninput;}
    type.onchange=type.oninput=()=>{const mundane=['gear','document','container'].includes(type.value);rarity.parentElement.hidden=mundane;consumeLabel.hidden=type.value==='document';if(mundane)consume.checked=false;extra.body.hidden=type.value!=='document';if(type.value==='document'){optional.open=true;effect.placeholder='例如：一封密信或一本旧书';}resetIssued();renderPreview();sync();};
    for(const input of custom.querySelectorAll('input,select,textarea'))input.addEventListener('input',()=>{resetIssued();sync();});
    extra.body.hidden=true;
    grantPanel.append(heading,recipientCharacter.wrap,modes,layout,receipt,footer);
    grantView={key:viewKey,sync,complete:(command,event)=>{issued=true;receipt.hidden=false;receipt.textContent=`已向 ${recipient} / ${own.find(c=>c.id===command.characterId)?.name||'角色'} 发放 ${event.name} × ${command.quantity}`;sync();}};
    renderResults();setMode('catalog');
  }
  async function open(options={}) {
    ensure();if(busy){if(!dialog.open)dialog.showModal();message('正在保存物品，请稍候再切换背包');return;}if(removedSection)removedSection.open=false;returnAction=typeof options.onBack==='function'?options.onBack:null;backButton.hidden=!returnAction;playerId=options.playerId || '';containerFilter=options.characterId||'';selected='';snapshot=null;loadedKey='';filter='all';query='';search.value='';resetRarity();setMagicFilter('');grantPanel.hidden=true;grantView=null;dialog.dataset.mode='backpack';
    if(!dialog.open)dialog.showModal();await load();clearInterval(timer);
    timer=setInterval(()=>{if(dialog.open&&!busy&&!editing&&!pending.has(key())&&grantPanel.hidden&&!detail.contains(document.activeElement))load(true).catch(()=>{});},12000);
  }
  function contextChanged(){clearReadingContext();if(transferDialog?.open&&transferContext!==readingContext())transferDialog.close();if(!dialog?.open)return;if(loadedKey!==key()){++serial;snapshot=null;characters=[];draw();load().catch(e=>message(e.message));}else if(activeCampaign!==config.campaignId?.()){characters=[];activeCampaign='';if(!busy&&!pending.has(key())&&!editing)load(true).catch(()=>{});}}
  return Object.freeze({configure:options=>{config=options;},open,contextChanged,extraFields,openDocument,receiveReadingInvite,art,facts,totalText});
})();
