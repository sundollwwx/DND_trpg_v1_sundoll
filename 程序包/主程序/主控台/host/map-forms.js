/* Host-only map form preview and editor. No form catalog enters the player stream. */
function openMapForms(mapId) {
  const map=mapById(mapId);
  if(!map) return;
  if(!map.mapData || map.cells){toast('请为图片地图设置形态');return;}
  const originalData=map.mapData;
  const draft={...map,mapForms:SundollMapForms.list(map)};
  SundollMapForms.ensure(draft);
  let selected=draft.activeMapFormId,dirty=false,importing=false;
  const dialog=document.createElement('dialog');dialog.className='map-forms-dialog';
  dialog.innerHTML='<header><div><h2>地图形态</h2><p class="map-forms-mapname"></p></div><button type="button" data-close aria-label="关闭形态窗口">✕</button></header><p class="map-forms-hint">先预览，再应用。玩家只看当前形态；棋子、物品和战斗状态保持不变。</p><div class="map-forms-body"><aside><label>形态<select size="7" aria-label="选择地图形态"></select></label><div class="map-forms-tools"><button type="button" data-add>＋ 导入图片</button><button type="button" data-rename>改名</button><button type="button" data-remove>删除形态</button></div><input type="file" accept="image/png,image/jpeg,image/webp" hidden></aside><figure><img alt="形态预览"><figcaption></figcaption></figure></div><p class="map-forms-error" role="status"></p><footer><button type="button" data-save>保存形态列表</button><button type="button" class="primary" data-apply>应用此形态</button></footer>';
  const q=s=>dialog.querySelector(s),select=q('select');
  q('.map-forms-mapname').textContent=map.floorLabel||map.name;
  const error=message=>{q('.map-forms-error').textContent=message;};
  function render(){
    select.replaceChildren(...draft.mapForms.map(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=f.name+(f.id===draft.activeMapFormId?' · 当前':'');return o;}));
    select.value=selected;
    const f=draft.mapForms.find(f=>f.id===selected);
    q('img').src=f.mapData;q('figcaption').textContent=f.name+' · '+map.mapW+' × '+map.mapH;
    q('[data-remove]').disabled=selected===draft.activeMapFormId||draft.mapForms.length<=1;
    q('[data-apply]').disabled=importing;
    q('[data-save]').disabled=importing;
  }
  function close(){if(dirty&&!confirm('关闭并放弃尚未保存的形态修改？'))return;dialog.close();}
  dialog.addEventListener('close',()=>dialog.remove());
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});q('[data-close]').onclick=close;
  select.onchange=()=>{selected=select.value;error('');render();};
  q('[data-add]').onclick=()=>q('input').click();
  q('input').onchange=async()=>{
    const file=q('input').files[0];if(!file)return;
    importing=true;render();error('正在读取图片…');
    try{
      const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('图片读取失败'));r.readAsDataURL(file);});
      const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('图片无法解码'));i.src=url;});
      const form={id:'form-'+crypto.randomUUID(),name:file.name.replace(/\.[^.]+$/,''),mapData:url};
      SundollMapForms.add(draft,form,img.naturalWidth,img.naturalHeight);selected=form.id;dirty=true;error('已加入预览，保存或应用后生效。');
    }catch(e){error(e.message);}finally{importing=false;q('input').value='';render();}
  };
  q('[data-rename]').onclick=()=>{const f=draft.mapForms.find(f=>f.id===selected),name=prompt('形态名称',f.name);if(name?.trim()){f.name=name.trim();dirty=true;render();}};
  q('[data-remove]').onclick=()=>{if(selected===draft.activeMapFormId)return;const f=draft.mapForms.find(f=>f.id===selected);if(!confirm('移除形态「'+f.name+'」？'))return;draft.mapForms=draft.mapForms.filter(f=>f.id!==selected);selected=draft.activeMapFormId;dirty=true;render();};
  function commit(apply){
    const live=mapById(mapId);
    if(live!==map||live.mapData!==originalData){error('地图已在其他操作中变化，请关闭后重新打开。');return;}
    live.mapForms=SundollMapForms.list(draft);live.activeMapFormId=draft.activeMapFormId;
    if(apply)SundollMapForms.apply(live,selected);
    mapThumbnailCache.delete(mapId);
    if(live.id===state.activeMapId)updateWorldBackground();
    renderMapBrowser();scheduleAutosave();
    if(streamOn){streamDirty=true;streamPush();scheduleStreamMapPreloads(0);}
    dirty=false;dialog.close();toast(apply?'形态已应用，棋子和场景状态保持不变':'形态列表已保存，当前背景未改变');
  }
  q('[data-save]').onclick=()=>commit(false);q('[data-apply]').onclick=()=>commit(true);
  document.body.appendChild(dialog);render();dialog.showModal();
}
