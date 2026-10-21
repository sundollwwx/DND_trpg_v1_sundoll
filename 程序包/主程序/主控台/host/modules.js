/* One entry for live adventures, players, content sources and private backups. */
window.SundollModules = (() => {
  let dialog,content,status,tabs,busy=false,current='campaigns',pendingBackupCleanup=null;
  let capabilities={emailAccounts:!!window.SundollRoom,spaceAccounts:!!window.SundollRoom,roomWorkspace:!!window.SundollRoom,manageMembers:false,workspaceBackups:!window.SundollRoom};
  let capabilitiesLoaded=false;
  const requests=new Map(),packageWrites=new Map(),recoveryCopies=new Map();
  let recoveryScope='';
  function persistRecoveryCopies(){
    if(!recoveryScope||typeof localStorage==='undefined')return;
    try{localStorage.setItem(recoveryScope,JSON.stringify([...recoveryCopies]));}catch(_){/* Kept in this page if browser storage is unavailable. */}
  }
  function restoreRecoveryCopies(){
    const scope=(typeof STORAGE_KEY==='string'?STORAGE_KEY:'dnd-board-state-v3')+':recovery-copy';
    if(recoveryScope===scope)return;recoveryScope=scope;recoveryCopies.clear();
    if(typeof localStorage==='undefined')return;
    try{for(const [key,task] of JSON.parse(localStorage.getItem(scope)||'[]'))if(typeof key==='string'&&task&&typeof task.recoveryId==='string'&&/^[a-f0-9]{64}$/.test(task.expectedHash)&&typeof task.requestId==='string')recoveryCopies.set(key,task);}catch(_){/* An unreadable cache cannot authorize a restore. */}
  }
  const labels={general:'通用内容','campaign-content':'战役内容','campaign-progress':'战役进度',player:'玩家档案'};
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=()=>run(fn);return b;};
  async function api(body,path='/api/modules'){
    const file=body instanceof File;
    const response=await fetch(path,{method:'POST',headers:{'X-Sundoll-Local-Save':'1',...(file?{}:{'Content-Type':'application/json'})},body:file?body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.ok){const error=new Error(result.error||'操作未完成，请检查服务连接');error.status=response.status;throw error;}return result;
  }
  async function run(fn){
    if(busy)return;busy=true;status.textContent='正在处理，请保留页面…';dialog.setAttribute('aria-busy','true');
    try{await fn();if(status.textContent==='正在处理，请保留页面…')status.textContent='已更新';}
    catch(error){status.textContent=error.message;}
    finally{busy=false;dialog.removeAttribute('aria-busy');}
  }
  async function flush(){if(state.campaignId&&!await queueCurrentFolderSave({backup:true}))throw new Error('当前战役尚未保存，操作已停止');}
  function download(result){
    const a=el('a','下载文件');a.href=result.downloadUrl;a.download=result.filename||(result.module.name+'.sundoll');
    status.replaceChildren(el('span','导出完成。'),a);a.click();
  }
  function picker(accept,callback){const input=el('input');input.type='file';input.accept=accept;input.hidden=true;document.body.append(input);input.onchange=()=>{const f=input.files[0];input.remove();if(f)run(()=>callback(f));};input.oncancel=()=>input.remove();input.click();}
  function actions(...buttons){const box=el('div',undefined,'module-actions');box.append(...buttons);return box;}
  function card(name,detail,...buttons){const c=el('article',undefined,'module-card'),copy=el('div');copy.append(el('h3',name),el('p',detail));c.append(copy,actions(...buttons));content.append(c);return c;}
  async function changed(){campaignRecordsCache=null;await syncLibraryWithFolder();await refreshHostHome({forceRecords:true});await refresh();}
  function recoverySection(){
    restoreRecoveryCopies();
    const section=el('details',undefined,'module-recovery'),list=el('div',undefined,'module-recovery-list');
    section.append(el('summary','恢复点与待确认进度'),list);content.append(section);
    let loaded=false,records=[],notice='',warnings=[],page=0;
    const size=20;
    function render(){
      list.replaceChildren(el('p',notice,'module-footnote'));
      for(const warning of warnings)list.append(el('p',(warning.path?warning.path+'：':'')+(warning.warning||String(warning)),'module-recovery-warning'));
      if(!records.length){list.append(el('p','没有可读取的战役恢复点。','module-empty'));return;}
      for(const record of records.slice(page*size,(page+1)*size)){
        const key=record.id+':'+record.sha256,row=el('article',undefined,'module-card'),copy=el('div');
        copy.append(el('h3',record.campaignName||'未命名战役'),el('p',`${record.reason||'恢复点'} · ${record.createdAt?new Date(record.createdAt).toLocaleString():'时间未知'}${record.mapCount!==null&&record.mapCount!==undefined?' · '+record.mapCount+' 张地图':''}`),el('small',record.path));
        for(const warning of record.warnings||[])copy.append(el('p',warning,'module-recovery-warning'));
        const buttons=[];
        if(record.sha256)buttons.push(button('下载原件',async()=>{
          const result=await localSaveApiRequest('recovery-read',{recoveryId:record.id,expectedHash:record.sha256});
          const url=URL.createObjectURL(new Blob([result.text],{type:'application/json'})),link=el('a');
          link.href=url;link.download=(record.path||record.id).split('/').pop();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
          status.textContent='恢复点原件已生成下载。'+(result.notice||'');
        }));
        if(record.valid&&record.sha256)buttons.push(button(recoveryCopies.has(key)?'核对原副本操作':'恢复为独立副本',async()=>{
          if(!recoveryCopies.has(key)){
            if(!confirm(`将「${record.campaignName||'战役'}」恢复为独立副本？\n${notice}\n当前战役不会被替换。`))return;
            recoveryCopies.set(key,{recoveryId:record.id,expectedHash:record.sha256,requestId:crypto.randomUUID()});persistRecoveryCopies();
          }
          try{
            const result=await localSaveApiRequest('recovery-copy',recoveryCopies.get(key));recoveryCopies.delete(key);persistRecoveryCopies();
            await changed();status.textContent='独立副本已加入战役列表，请核对后选择打开。'+(result.notice||notice)+(result.warnings?.length?' '+result.warnings.join('；'):'');
          }catch(error){
            if(error.status&&error.status<500){recoveryCopies.delete(key);persistRecoveryCopies();}
            else error.message+='；副本结果尚未确认，再次点击将核对同一操作。';
            render();throw error;
          }
        }));
        row.append(copy,actions(...buttons));list.append(row);
      }
      const previous=button('上一页',async()=>{page--;render();}),next=button('下一页',async()=>{page++;render();});
      previous.disabled=page===0;next.disabled=(page+1)*size>=records.length;
      list.append(actions(button('刷新恢复点',load),...(records.length>size?[previous,el('span',`${page+1} / ${Math.ceil(records.length/size)}`),next]:[])));
    }
    async function load(){
      const result=await localSaveApiRequest('recovery-list');records=result.records||[];notice=result.notice||'恢复为独立战役副本，原存档与恢复点保留。';warnings=result.warnings||[];page=0;loaded=true;render();
    }
    section.ontoggle=()=>{if(section.open&&!loaded)return run(load);};
  }
  async function importModule(file){
    const p=await api(file,'/api/modules/preview');const m=p.module;
    const decision=`${p.update?'更新':'导入'}「${m.name}」\n${labels[m.kind]} · ${m.assets.length} 份素材\n${p.update?'将替换已安装的来源版本。':''}已有战役进度和玩家成长保持当前状态。通用内容需点击“启用／更新通用库”才会应用。`;
    if(!confirm(decision)){status.textContent='已取消导入';return;}
    await api({op:'confirm-import',ticket:p.ticket});current='content';await refresh();status.textContent='来源模块已安装，请选择启用或新开冒险。';
  }
  async function exportCampaign(cid,kind){await flush();download(await api({op:'export-campaign',campaignId:cid,kind}));}
  async function activateMigration(source){
    if(!['campaign-progress','player'].includes(source.kind))throw new Error('旧存档迁移只使用战役进度包和玩家包');
    await flush();
    if(!requests.has(source.moduleId))requests.set(source.moduleId,crypto.randomUUID());
    const result=await api({op:source.kind==='player'?'activate-player':'create-run',moduleId:source.moduleId,requestId:requests.get(source.moduleId)});
    requests.delete(source.moduleId);current='migration';await changed();
    status.textContent=result.playerId?'玩家包已载入。请到账号页连接对应邮箱；身份、角色和背包保留。':'战役进度已载入，身份保持原样。请核对下面的玩家和邮箱连接清单。';
  }
  async function importMigration(file){
    const preview=await api(file,'/api/modules/preview'),source=preview.module;
    if(!['campaign-progress','player'].includes(source.kind))throw new Error('请选择已导出的战役进度包或玩家包；分享内容包用于新冒险，不能接续旧角色');
    if(!confirm(`导入并载入「${source.name}」？\n${labels[source.kind]}。保留原身份与进度，已有同身份存档不会被覆盖；邮箱归属仍需创建者明确连接。`))return;
    await flush();await api({op:'confirm-import',ticket:preview.ticket});
    try{await activateMigration(source);}
    catch(error){current='migration';await refresh();throw new Error('来源已安装，载入尚未完成：'+error.message);}
  }
  function migrationGuide(view){
    const snapshot=view.migration||{campaigns:view.campaigns,profiles:view.players,sources:[]},room=capabilities.roomWorkspace;
    content.append(el('h3',room?'旧存档迁移清单':'迁移到邮箱账号空间'),el('p',room?'查看本房间已导入的旧资料和角色归属；已有账号角色不会被覆盖。':'按同一条流程导出、导入并连接邮箱。战役进度包记录旅程，玩家包保留角色与背包；账号归属在目标空间明确选择。','module-footnote'));
    const steps=el('ol',undefined,'migration-steps');
    for(const text of (room ? ['选择已导出的进度包或玩家包，核对来源与角色身份。','房主在个人主页核对成员，并将待认领角色交还对应账号。'] : ['从此隔离工作区导出所需进度包或玩家包。','在目标房间导入，再由房主确认角色归属。']))steps.append(el('li',text));
    content.append(steps);
    if(!room){
      content.append(el('h3','从此工作区导出'));
      for(const campaign of view.campaigns)card(campaign.name,'战役身份：'+campaign.id,button('导出进度',()=>exportCampaign(campaign.id,'campaign-progress')));
      for(const profile of view.players)card(profile.name,'玩家身份：'+profile.playerId+' · '+profile.characters+' 个角色／伙伴',button('导出玩家包',async()=>{await flush();download(await api({op:'export-player',playerId:profile.playerId}));}));
      content.append(actions(button('前往账号页创建或选择空间',async()=>{await flush();location.assign('/account');})),el('p','源工作区和原文件保留。导出成功只表示文件已生成；目标空间的载入和邮箱连接需在目标空间清单确认。','module-footnote'));
      return;
    }
    content.append(actions(button('导入进度包或玩家包',()=>picker('.sundoll,.zip',importMigration)),button('刷新迁移清单',refresh),...(capabilities.manageMembers?[button('前往邮箱连接与完整清单',async()=>{await flush();location.assign('/account#manage='+window.SundollRoom.id);})]:[])));
    if(!capabilities.manageMembers)content.append(el('p','邮箱连接由此空间创建者完成。普通 DM 可以载入文件，旧玩家可先等待连接。','module-footnote'));
    content.append(el('h3','战役'));
    for(const campaign of snapshot.campaigns)card(campaign.name,(campaign.importedProgress?'进度包已载入':'本空间已保存战役')+' · '+campaign.id);
    if(!snapshot.campaigns.length)content.append(el('p','还没有已载入的战役。请导入战役进度包。','module-empty'));
    content.append(el('h3','玩家与邮箱连接'));
    for(const profile of snapshot.profiles)card(profile.name,(profile.imported?'玩家包已载入':'本空间已有档案')+' · '+(!profile.enabled?'已停用':profile.accountId||profile.linked?'已连接邮箱账号':'等待连接邮箱')+' · '+profile.playerId);
    if(!snapshot.profiles.length)content.append(el('p','尚未载入玩家包。旧玩家不会因为打开页面而自动建立空白档案。','module-empty'));
    const pending=(snapshot.sources||[]).filter(source=>source.state==='pending');
    if(pending.length){content.append(el('h3','已安装，待载入'));for(const source of pending)card(source.name,labels[source.kind]+' · 来源已安装，实际存档尚未确认',button('继续载入',()=>activateMigration(source)));}
  }
  async function packageSelection(c){
    const response=await api({op:'content-packages',campaignId:c.id}),context=response.packageContext;
    if(!context||!Array.isArray(context.packages))throw new Error('暂时无法读取战役的内容包');
    content.replaceChildren();
    content.append(actions(button('← 返回战役',refresh)),el('h3',c.name+' · 启用内容包'),el('p','角色持有的物品仍保存在各自背包中。通用和战役物品随来源包启用或暂停；重新启用后保留原来的数量和状态。角色专属物品随角色跨战役使用。','module-footnote'));
    const choices=el('div',undefined,'module-package-choices'),selected=new Set(context.enabledPackageIds||[]),inputs=[];
    const packages=[...context.packages];
    for(const id of context.missingPackageIds||[])if(!packages.some(p=>p.id===id))packages.push({id,name:id,available:false,scope:'campaign'});
    for(const item of packages){
      const row=el('label',undefined,'module-package-choice'),check=el('input');check.type='checkbox';check.value=item.id;check.checked=selected.has(item.id)||item.id===context.sourcePackageId;check.disabled=item.id===context.sourcePackageId||item.available===false&&!check.checked;check.setAttribute('aria-label','启用内容包：'+item.name);
      const copy=el('span');copy.append(el('strong',item.name),el('small',item.id===context.sourcePackageId?'本战役来源 · 始终启用':item.available===false?'来源缺失 · 对应物品暂停使用':item.scope==='general'?'通用内容':'其他战役内容'));
      row.append(check,copy);choices.append(row);inputs.push(check);
    }
    const hint=el('p','','module-status');hint.setAttribute('role','status');
    const save=button(packageWrites.has(c.id)?'核对并重试原操作':'保存启用内容包',async()=>{
      const task=packageWrites.get(c.id)||{op:'set-content-packages',campaignId:c.id,enabledPackageIds:inputs.filter(i=>i.checked).map(i=>i.value),revision:context.selectionRevision,requestId:crypto.randomUUID()};
      packageWrites.set(c.id,task);for(const input of inputs)input.disabled=true;
      try{
        await flush();const result=await api(task);packageWrites.delete(c.id);
        if(state.campaignId===c.id){state.packageContextRevision=result.packageContext.revision;streamDirty=true;window.PlayerBackpack?.contextChanged();window.ItemLibrary?.contextChanged();window.MapItems?.contextChanged();}
        await packageSelection(c);status.textContent='内容包已更新；未启用的来源已隐藏，物品记录仍然保留。';
      }catch(error){
        if(error.status&&error.status<500){packageWrites.delete(c.id);await packageSelection(c);}
        else{save.textContent='核对并重试原操作';hint.textContent='保存结果尚未确认。重试会核对同一操作，不会重复变更。';}
        throw error;
      }
    });
    if(packageWrites.has(c.id)){for(const input of inputs)input.disabled=true;hint.textContent='上次保存结果尚未确认，请先核对原操作。';}
    content.append(choices,actions(save),hint);
  }
  function ensure(){
    if(dialog)return;
    dialog=el('dialog',undefined,'module-dialog');dialog.setAttribute('aria-label','冒险管理');
    const header=el('header'),title=el('div');title.append(el('small','ADVENTURE WORKSPACE'),el('h2','冒险管理'));header.append(title,button('关闭',()=>dialog.close()));
    const intro=el('p','战役记录旅程，玩家保留成长，通用内容供各场冒险共享。','module-intro');
    tabs=el('nav',undefined,'module-tabs');tabs.setAttribute('aria-label','管理分类');
    for(const [id,name] of [['campaigns','战役'],['players','玩家'],['content','通用与模块'],['migration','旧资料导入'],['backups','备份与恢复']]){const b=button(name,async()=>{current=id;await refresh();});b.dataset.tab=id;tabs.append(b);}
    content=el('div',undefined,'module-list');status=el('p','','module-status');status.setAttribute('role','status');
    dialog.append(header,intro,tabs,content,status);document.body.append(dialog);
  }
  async function refresh(){
    const r=current==='backups'?null:await api({op:'overview'});content.replaceChildren();
    if(r?.capabilities)capabilities={...capabilities,...r.capabilities};
    tabs.querySelectorAll('button').forEach(b=>{b.hidden=b.dataset.tab==='backups'&&!capabilities.workspaceBackups||b.dataset.tab==='migration'&&!capabilities.spaceAccounts;b.setAttribute('aria-current',b.dataset.tab===current?'page':'false');});
    if(current==='migration')migrationGuide(r);
    else if(current==='campaigns'){
      content.append(el('p','打开旧战役时，角色仍使用玩家包中的当前成长、背包和剩余资源。'));
      content.append(actions(button('新建战役',()=>{dialog.close();showCover();document.querySelector('#cover-new').click();}),button('导入战役模块',()=>picker('.sundoll,.zip',importModule)),button('返回战役总览',()=>{dialog.close();showCover();})));
      for(const c of r.campaigns){
        const maps=c.state?.maps||[];
        card(c.name,`${maps.length} 张地图 · ${c.savedAt?new Date(c.savedAt).toLocaleString():'尚未记录时间'}${state.campaignId===c.id?' · 当前战役':''}`,
          button('打开',async()=>{await flush();dialog.close();await openCampaign(c.id);}),
          button('启用内容包',()=>packageSelection(c)),button('分享内容',()=>exportCampaign(c.id,'campaign-content')),button('导出进度',()=>exportCampaign(c.id,'campaign-progress')),
          button('归档',async()=>{if(state.campaignId===c.id)throw new Error('请先打开其他战役或新建战役，再归档当前战役');if(!confirm(`归档「${c.name}」？可在下方恢复。账号角色与背包不会删除。`))return;await localSaveApiRequest('archive-campaign',{path:c._path,campaignId:c.id});await changed();}));
      }
      if(!r.campaigns.length)content.append(el('p','这里还没有冒险。新建空白战役，或导入战役内容包后另开一场。','module-empty'));
      if(r.archivedCampaigns.length){content.append(el('h3','已归档'));for(const c of r.archivedCampaigns)card(c.name,'保留地图、布置和进度',button('恢复战役',async()=>{await api({op:'restore-campaign',campaignId:c.id,path:c.path});await changed();}));}
      recoverySection();
      content.append(el('p',capabilities.emailAccounts?'分享内容会移除真实玩家身份、日志和遭遇记录。迁移已有冒险请导出进度与各玩家包，导入目标空间后，由创建者在“我的主页 → 房间管理 → 邀请与成员”确认成员邮箱与旧角色归属。':'分享内容会移除真实玩家身份、日志和遭遇记录。跨机器续团需配套导出进度与各玩家包；整套迁移可使用私人备份。','module-footnote'));
    }else if(current==='players'){
      content.append(el('p','角色与持久伙伴随玩家跨战役使用；各角色有独立背包，物品直接发放给指定角色。角色不会自动进入大棋子库。'));
      content.append(actions(button('参团角色',()=>{dialog.close();document.querySelector('#btn-player-profiles').click();}),button('导入玩家包',()=>picker('.sundoll,.zip',importModule)),...(capabilities.manageMembers?[button('成员与角色归属',async()=>{await flush();location.assign('/account#manage='+window.SundollRoom.id);})]:[])));
      for(const p of r.players){const profile=r.migration?.profiles.find(entry=>entry.playerId===p.playerId);card(p.name,`${p.characters} 个角色／伙伴 · ${capabilities.emailAccounts?(profile?.accountId||profile?.linked?'已连接邮箱账号':'等待连接邮箱'):'以玩家名字登录'}`,button('导出玩家包',async()=>{await flush();download(await api({op:'export-player',playerId:p.playerId}));}));}
      if(!r.players.length)content.append(el('p',capabilities.emailAccounts?'还没有玩家。新玩家可在个人主页创建角色；旧玩家可以等待导入和邮箱连接，不会因打开页面自动新建。':'还没有玩家。请在玩家入口注册，或导入玩家包。','module-empty'));
    }else if(current==='content'){
      content.append(actions(button('棋子库',()=>{dialog.close();window.open('../asset/棋子库/棋子库.html','_blank');}),button('物品库',()=>{dialog.close();ItemLibrary.open();}),button('导入／更新模块',()=>picker('.sundoll,.zip',importModule))));
      content.append(el('h3','本机通用收藏'));
      for(const g of r.general)card(g.name,g.files!=null?`日常资料 · ${g.files} 个文件`:`${g.templates} 个棋子模板 · ${g.items} 个物品模板`,button('导出收藏',async()=>{await flush();download(await api({op:'export-general',owner:g.id}));}));
      if(!r.general.length)content.append(el('p','通用库目前为空，可以自行制作或导入通用包。'));
      content.append(el('h3','已安装的来源模块'),el('p','启停或更新日常资料后，主控会重新载入；已打开的玩家页也需刷新，以使用相同的资料和天气配置。','module-footnote'));
      for(const m of r.modules){
        const buttons=[],daily=m.local||m.dailyLife||m.files>0;
        if(m.available===false){card(m.name,'日常资料暂不可用：'+(m.error||'请重新导入完整资料'),button('重新检查',refresh));continue;}
        if(m.archived)buttons.push(button(daily?'恢复日常资料':'恢复模块',async()=>{if(daily)await flush();await api({op:'restore-module',moduleId:m.moduleId});if(daily){location.reload();return;}await refresh();}));
        else{
          const op=m.kind==='general'?'activate-general':m.kind==='player'?'activate-player':'create-run';
          const label=daily?'启用／更新日常资料':m.kind==='general'?'启用／更新通用库':m.kind==='player'?'载入待认领角色':m.kind==='campaign-progress'?'载入进度':'新开一场冒险';
          buttons.push(button(label,async()=>{
            await flush();if(!requests.has(m.moduleId))requests.set(m.moduleId,crypto.randomUUID());
            const v=await api({op,moduleId:m.moduleId,requestId:requests.get(m.moduleId)});requests.delete(m.moduleId);if(daily){location.reload();return;}await changed();
            status.textContent=v.kept?.length?`已应用；保留 ${v.kept.length} 项本机修改：${v.kept.map(x=>x.name).join('、')}`:v.campaignId?'战役已加入列表，可到“战役”打开。':v.playerId?(capabilities.emailAccounts?'玩家档案已导入。创建者需在“我的主页 → 房间管理 → 邀请与成员”逐个确认角色的所属邮箱，原角色与背包会保留。':'玩家已加入名册，可以使用玩家名字登录。'):'通用内容已应用。';
          }),button(daily?'停用日常资料':'卸载来源',async()=>{if(!confirm(daily?`停用「${m.name}」？\n日常资料仍保留，可在此恢复；日常玩法与天气将暂停。`:`卸载「${m.name}」的来源？\n已开团的战役、玩家角色、已放置棋子和已发放物品保留。通用库中未改动的来源模板会移除，手动修改项保留。可在此恢复模块。`))return;await flush();const v=await api({op:'uninstall',moduleId:m.moduleId});if(daily){location.reload();return;}await changed();status.textContent=`来源已卸载${v.kept?.length?'；保留 '+v.kept.length+' 项本机修改':''}。`;}));
        }
        card(m.name,`${daily?'日常资料':labels[m.kind]} · ${daily?(m.files||0)+' 个文件':m.assets.length+' 份素材'}${m.archived?(daily?' · 已停用':' · 已卸载'):''}`,...buttons);
      }
      if(!r.modules.length)content.append(el('p','尚未安装外部模块。已有战役、玩家和本机收藏仍正常使用。'));
    }else{
      content.append(el('p','整套备份同时保存战役、玩家、背包、通用库、素材和本机登录资料。恢复会将它们一起回到所选时间，并自动重启服务。','module-backup-note'));
      content.append(el('p','这类备份是私人存档，含登录凭证；分享冒险或角色请使用各自的模块导出。'));
      content.append(actions(button('备份整套工作区',async()=>{await flush();const v=await api({op:'backup-create'});await refresh();status.textContent=`已完成「${v.backup.name}」，共 ${v.backup.fileCount} 个文件。`;}),button('导入私人备份',()=>picker('.zip',async f=>{await api(f,'/api/workspace-backups/import');await refresh();status.textContent='备份已校验并加入列表，尚未恢复。';}))));
      const backupView=await api({op:'backups'}),backups=backupView.backups;
      renderBackupMaintenance(backupView);
      for(const b of backups)card(b.name,`${new Date(b.createdAt).toLocaleString()} · ${formatBytes(b.bytes)}${b.protectionReasons?.length?' · 保留：'+b.protectionReasons.join('、'):''}`,
        ...(b.canTogglePin?[button(b.pinned?'取消手动保留':'手动保留',async()=>{await api({op:'backup-pin',backupId:b.id,pinned:!b.pinned});await refresh();})]:[]),
        button('下载备份',async()=>download(await api({op:'backup-export',backupId:b.id}))),
        button('恢复到此时',async()=>{
          if(!confirm(`将全部战役、玩家成长、背包与登录资料恢复到 ${new Date(b.createdAt).toLocaleString()}。\n请让玩家停止操作，并关闭其他主控及棋子库页面。系统会先自动备份当前状态，再重启服务。确认恢复？`))return;
          await flush();const before=await fetch('/api/workspace-epoch',{cache:'no-store'}).then(x=>x.json());
          await api({op:'backup-restore',backupId:b.id});
          status.textContent='恢复前备份已完成，正在重启。完成后本页会刷新，其他页面也需要刷新并重新登录。';
          for(let n=0;n<45;n++){await new Promise(r=>setTimeout(r,1000));try{const v=await fetch('/api/workspace-epoch',{cache:'no-store'}).then(x=>x.json());if(v.epoch!==before.epoch){location.reload();return;}}catch(_){}}
          throw new Error('恢复已安排，服务尚未重新连接。请重新运行启动器；恢复会在启动时继续完成。');
        }));
      if(!backups.length)content.append(el('p','还没有整套备份。日常自动保存仍保存当前战役。','module-empty'));
    }
  }
  function formatBytes(bytes){return bytes>=1073741824?(bytes/1073741824).toFixed(2)+' GiB':(bytes/1048576).toFixed(1)+' MiB';}
  function renderBackupMaintenance(view){
    if(!view.storage||!view.policy||!view.plan)return;
    const summary=el('section',undefined,'module-backup-maintenance'),storage=view.storage;
    summary.append(el('h3','备份空间'),el('p',`${storage.count} 份备份 · 内容占用 ${formatBytes(storage.totalBytes)} · ${storage.protectedCount} 份受保护`));
    const fields=el('div',undefined,'module-backup-policy');
    const count=el('input'),days=el('input');
    for(const [input,name,value,min,max] of [[count,'保留最近份数',view.policy.keepCount,1,1000],[days,'保留最近天数',view.policy.keepDays,0,3650]]){
      const label=el('label',name);input.type='number';input.min=min;input.max=max;input.step=1;input.value=value;input.setAttribute('aria-label',name);label.append(input);fields.append(label);
    }
    fields.append(button('保存保留策略',async()=>{await api({op:'backup-policy',keepCount:Number(count.value),keepDays:Number(days.value)});await refresh();status.textContent='保留策略已保存，现有备份未删除。';}));
    summary.append(fields,el('p','保留最近指定份数，以及指定天数内的全部备份。最新备份、重要恢复点和手动保留项始终保留；0 天表示只按份数。不会自动删除备份。','module-footnote'),
      actions(button(pendingBackupCleanup?'核对未完成的清理':'预览可清理备份',async()=>renderBackupCleanup(await api({op:'backups'})))));
    content.append(summary);
  }
  function renderBackupCleanup(view){
    content.replaceChildren();
    content.append(actions(button('← 返回备份',refresh)),el('h3','清理预览'));
    const previous=pendingBackupCleanup,candidates=previous?previous.selected:view.plan.candidates;
    content.append(el('p',previous?'上次清理结果尚未确认。重试只核对并完成原来的选择。':`可选择 ${candidates.length} 份备份，最多释放 ${formatBytes(view.plan.reclaimableBytes)}。当前存档与保留项不在清理范围内。`));
    if(!candidates.length){content.append(el('p','没有符合当前保留策略的备份。','module-empty'));return;}
    const checks=[];
    for(const backup of candidates){
      const label=el('label',undefined,'module-backup-candidate'),input=el('input');input.type='checkbox';input.checked=true;input.disabled=!!previous;input.value=backup.id;input.setAttribute('aria-label','清理备份：'+backup.name);
      const copy=el('span');copy.append(el('strong',backup.name),el('small',`${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.bytes)}`));label.append(input,copy);content.append(label);checks.push(input);
    }
    content.append(actions(button(previous?'核对并重试原清理':'删除选中的备份',async()=>{
      const selected=previous?previous.selected:candidates.filter((_,index)=>checks[index].checked);
      if(!selected.length)throw new Error('请先选择要清理的备份');
      if(!previous&&!confirm(`将永久删除选中的 ${selected.length} 份旧备份，释放约 ${formatBytes(selected.reduce((sum,b)=>sum+b.bytes,0))}。\n当前存档、最新备份和重要恢复点均保留。确认清理？`))return;
      const task=previous||{command:{op:'backup-cleanup',previewToken:view.plan.previewToken,backupIds:selected.map(b=>b.id),requestId:crypto.randomUUID()},selected};
      pendingBackupCleanup=task;
      try{const result=await api(task.command);pendingBackupCleanup=null;await refresh();status.textContent=`已清理 ${result.deletedIds.length} 份备份，释放 ${formatBytes(result.reclaimedBytes)}。`;}
      catch(error){if(error.status&&error.status<500)pendingBackupCleanup=null;else{renderBackupCleanup(view);error.message+='；结果尚未确认，请核对并重试原清理。';}throw error;}
    })));
  }
  async function open(tab='campaigns'){
    ensure();
    if(!capabilitiesLoaded){
      try{const response=await fetch('/api/account/config',{cache:'no-store'});if(response.ok){const data=await response.json();capabilities.emailAccounts=data.enabled===true;capabilities.spaceAccounts=data.enabled===true&&data.roomsEnabled===true;capabilities.workspaceBackups=!(data.enabled&&data.roomsEnabled);capabilitiesLoaded=true;}}
      catch(_){/* The room scope still hides service-wide operations during an outage. */}
    }
    current=tab==='backups'&&!capabilities.workspaceBackups||tab==='migration'&&!capabilities.spaceAccounts?'campaigns':tab;
    if(!dialog.open)dialog.showModal();await run(refresh);
  }
  if(window.addEventListener)window.addEventListener('load',()=>{if(location.hash==='#migration')open('migration');});
  return {open};
})();
