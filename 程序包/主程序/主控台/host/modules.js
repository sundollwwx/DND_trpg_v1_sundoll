/* One entry for live adventures, players, content sources and private backups. */
window.SundollModules = (() => {
  let dialog,content,status,tabs,busy=false,current='campaigns';
  const requests=new Map();
  const labels={general:'通用内容','campaign-content':'战役内容','campaign-progress':'战役进度',player:'玩家档案'};
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=()=>run(fn);return b;};
  async function api(body,path='/api/modules'){
    const file=body instanceof File;
    const response=await fetch(path,{method:'POST',headers:{'X-Sundoll-Local-Save':'1',...(file?{}:{'Content-Type':'application/json'})},body:file?body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||!result.ok)throw new Error(result.error||'操作未完成，请检查服务连接');return result;
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
  async function importModule(file){
    const p=await api(file,'/api/modules/preview');const m=p.module;
    const decision=`${p.update?'更新':'导入'}「${m.name}」\n${labels[m.kind]} · ${m.assets.length} 份素材\n${p.update?'将替换已安装的来源版本。':''}已有战役进度和玩家成长保持当前状态。通用内容需点击“启用／更新通用库”才会应用。`;
    if(!confirm(decision)){status.textContent='已取消导入';return;}
    await api({op:'confirm-import',ticket:p.ticket});current='content';await refresh();status.textContent='来源模块已安装，请选择启用或新开冒险。';
  }
  async function exportCampaign(cid,kind){await flush();download(await api({op:'export-campaign',campaignId:cid,kind}));}
  function ensure(){
    if(dialog)return;
    dialog=el('dialog',undefined,'module-dialog');dialog.setAttribute('aria-label','冒险管理');
    const header=el('header'),title=el('div');title.append(el('small','ADVENTURE WORKSPACE'),el('h2','冒险管理'));header.append(title,button('关闭',()=>dialog.close()));
    const intro=el('p','战役记录旅程，玩家保留成长，通用内容供各场冒险共享。主程序独立更新。','module-intro');
    tabs=el('nav',undefined,'module-tabs');tabs.setAttribute('aria-label','管理分类');
    for(const [id,name] of [['campaigns','战役'],['players','玩家'],['content','通用与模块'],['backups','备份与恢复']]){const b=button(name,async()=>{current=id;await refresh();});b.dataset.tab=id;tabs.append(b);}
    content=el('div',undefined,'module-list');status=el('p','','module-status');status.setAttribute('role','status');
    dialog.append(header,intro,tabs,content,status);document.body.append(dialog);
  }
  async function refresh(){
    const r=await api({op:'overview'});content.replaceChildren();
    tabs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===current?'page':'false'));
    if(current==='campaigns'){
      content.append(el('p','打开旧战役时，角色仍使用玩家包中的当前成长、背包和剩余资源。'));
      content.append(actions(button('新建战役',()=>{dialog.close();showCover();document.querySelector('#cover-new').click();}),button('导入战役模块',()=>picker('.sundoll,.zip',importModule)),button('战役封面与管理',()=>{dialog.close();openCampaignModal();})));
      for(const c of r.campaigns){
        const maps=c.state?.maps||[];
        card(c.name,`${maps.length} 张地图 · ${c.savedAt?new Date(c.savedAt).toLocaleString():'尚未记录时间'}${state.campaignId===c.id?' · 当前战役':''}`,
          button('打开',async()=>{await flush();dialog.close();await openCampaign(c.id);}),
          button('分享内容',()=>exportCampaign(c.id,'campaign-content')),button('导出进度',()=>exportCampaign(c.id,'campaign-progress')),
          button('归档',async()=>{if(state.campaignId===c.id)throw new Error('请先打开其他战役或新建战役，再归档当前战役');if(!confirm(`归档「${c.name}」？可在下方恢复。玩家档案不会删除。`))return;await localSaveApiRequest('archive-campaign',{path:c._path,campaignId:c.id});await changed();}));
      }
      if(!r.campaigns.length)content.append(el('p','这里还没有冒险。新建空白战役，或导入战役内容包后另开一场。','module-empty'));
      if(r.archivedCampaigns.length){content.append(el('h3','已归档'));for(const c of r.archivedCampaigns)card(c.name,'保留地图、布置和进度',button('恢复战役',async()=>{await api({op:'restore-campaign',campaignId:c.id,path:c.path});await changed();}));}
      content.append(el('p','分享内容会移除真实玩家身份、日志和遭遇记录。跨机器续团需配套导出进度与各玩家包；整套迁移可使用私人备份。','module-footnote'));
    }else if(current==='players'){
      content.append(el('p','角色与持久伙伴随玩家跨战役使用；各角色有独立背包，物品直接发放给指定角色。角色不会自动进入大棋子库。'));
      content.append(actions(button('角色名册与登录管理',()=>{dialog.close();document.querySelector('#btn-player-profiles').click();}),button('导入玩家包',()=>picker('.sundoll,.zip',importModule))));
      for(const p of r.players)card(p.name,`${p.characters} 个角色／伙伴 · 以玩家名字登录`,button('导出玩家包',async()=>{await flush();download(await api({op:'export-player',playerId:p.playerId}));}));
      if(!r.players.length)content.append(el('p','还没有玩家。通过角色名册创建账号，或导入玩家包。','module-empty'));
    }else if(current==='content'){
      content.append(actions(button('棋子库',()=>{dialog.close();window.open('../asset/棋子库/棋子库.html','_blank');}),button('物品库',()=>{dialog.close();ItemLibrary.open();}),button('导入／更新模块',()=>picker('.sundoll,.zip',importModule))));
      content.append(el('h3','本机通用收藏'));
      for(const g of r.general)card(g.name,`${g.templates} 个棋子模板 · ${g.items} 个物品模板`,button('导出收藏',async()=>{await flush();download(await api({op:'export-general',owner:g.id}));}));
      if(!r.general.length)content.append(el('p','通用库目前为空，可以自行制作或导入通用包。'));
      content.append(el('h3','已安装的来源模块'));
      for(const m of r.modules){
        const buttons=[];
        if(m.archived)buttons.push(button('恢复模块',async()=>{await api({op:'restore-module',moduleId:m.moduleId});await refresh();}));
        else{
          const op=m.kind==='general'?'activate-general':m.kind==='player'?'activate-player':'create-run';
          const label=m.kind==='general'?'启用／更新通用库':m.kind==='player'?'加入玩家档案':m.kind==='campaign-progress'?'载入进度':'新开一场冒险';
          buttons.push(button(label,async()=>{
            await flush();if(!requests.has(m.moduleId))requests.set(m.moduleId,crypto.randomUUID());
            const v=await api({op,moduleId:m.moduleId,requestId:requests.get(m.moduleId)});requests.delete(m.moduleId);await changed();
            status.textContent=v.kept?.length?`已应用；保留 ${v.kept.length} 项本机修改：${v.kept.map(x=>x.name).join('、')}`:v.campaignId?'战役已加入列表，可到“战役”打开。':v.playerId?'玩家已加入名册，可以使用玩家名字登录。':'通用内容已应用。';
          }),button('卸载来源',async()=>{if(!confirm(`卸载「${m.name}」的来源？\n已开团的战役、玩家角色、已放置棋子和已发放物品保留。通用库中未改动的来源模板会移除，手动修改项保留。可在此恢复模块。`))return;await flush();const v=await api({op:'uninstall',moduleId:m.moduleId});await changed();status.textContent=`来源已卸载${v.kept?.length?'；保留 '+v.kept.length+' 项本机修改':''}。`;}));
        }
        card(m.name,`${labels[m.kind]} · ${m.assets.length} 份素材${m.archived?' · 已卸载':''}`,...buttons);
      }
      if(!r.modules.length)content.append(el('p','尚未安装外部模块。已有战役、玩家和本机收藏仍正常使用。'));
    }else{
      content.append(el('p','整套备份同时保存战役、玩家、背包、通用库、素材和本机登录资料。恢复会将它们一起回到所选时间，并自动重启服务。','module-backup-note'));
      content.append(el('p','这类备份是私人存档，含登录凭证；分享冒险或角色请使用各自的模块导出。'));
      content.append(actions(button('备份整套工作区',async()=>{await flush();const v=await api({op:'backup-create'});await refresh();status.textContent=`已完成「${v.backup.name}」，共 ${v.backup.fileCount} 个文件。`;}),button('导入私人备份',()=>picker('.zip',async f=>{await api(f,'/api/workspace-backups/import');await refresh();status.textContent='备份已校验并加入列表，尚未恢复。';}))));
      const {backups}=await api({op:'backups'});
      for(const b of backups)card(b.name,`${new Date(b.createdAt).toLocaleString()} · ${(b.bytes/1048576).toFixed(1)} MiB`,
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
  async function open(tab='campaigns'){ensure();current=tab;if(!dialog.open)dialog.showModal();await run(refresh);}
  return {open};
})();
