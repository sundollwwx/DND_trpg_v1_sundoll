/* Host-only campaign preparation. Never included in the player stream. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SundollPrepHandbook=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function normalize(raw){
 const seen=new Set();return (Array.isArray(raw)?raw:[]).filter(x=>x&&typeof x==='object').slice(0,80).map((x,i)=>{
 let id=String(x.id||'area-'+i).slice(0,100);while(seen.has(id))id+='-'+i;seen.add(id);
 return {id,title:String(x.title||'未命名地块').slice(0,120),summary:String(x.summary||'').slice(0,4000),mapIds:[...new Set((Array.isArray(x.mapIds)?x.mapIds:[]).filter(v=>typeof v==='string'))].slice(0,80),notes:String(x.notes||'').slice(0,20000),sections:(Array.isArray(x.sections)?x.sections:[]).slice(0,60).map((v,j)=>({id:String(v?.id||'section-'+j).slice(0,100),title:String(v?.title||'准备事项').slice(0,120),body:String(v?.body||'').slice(0,30000),done:v?.done===true}))};});
}
function create({getState,save,saveImmediately,viewMap,toast}){
 const $=id=>document.getElementById(id);let campaign=null,selected='',query='';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function areas(){return getState().prepHandbook||[];}
 function guard(){if(campaign!==getState().campaignId){toast('战役已切换，请重新打开备团手册');$('prep-dialog').close();return false;}return true;}
 function update(fn){if(!guard())return;fn();save();}
 function render(){
  if(!guard())return;const list=$('prep-areas');list.replaceChildren();const matches=areas().filter(a=>[a.title,a.summary,a.notes,...a.sections.map(s=>s.title+' '+s.body)].join('\n').toLowerCase().includes(query));
  if(!matches.some(a=>a.id===selected))selected=matches[0]?.id||'';
  for(const a of matches){const b=el('button',`${a.title} · ${a.sections.filter(s=>s.done).length}/${a.sections.length}`);b.dataset.areaId=a.id;b.type='button';b.setAttribute('aria-pressed',String(a.id===selected));b.onclick=()=>{selected=a.id;render();};list.append(b);}
  const main=$('prep-content');main.replaceChildren();const a=matches.find(x=>x.id===selected);if(!a){main.append(el('p',query?'没有匹配内容。':'还没有备团地块，可在左侧新建。'));return;}
  main.append(el('h2',a.title),el('p',a.summary));const maps=el('div');maps.className='prep-map-links';
  for(const id of a.mapIds){const m=getState().maps.find(m=>m.id===id);const b=el('button',m?'预览：'+(m.floorLabel||m.name):'地图已移除');b.type='button';b.disabled=!m;b.onclick=()=>{if(guard()){$('prep-dialog').close();viewMap(id);}};maps.append(b);}main.append(maps);
  for(const s of a.sections){const section=el('section');section.className='prep-section';const label=el('label');const cb=el('input');cb.type='checkbox';cb.checked=s.done;cb.setAttribute('aria-label','已准备：'+s.title);cb.onchange=()=>update(()=>{s.done=cb.checked;const b=Array.from($('prep-areas').children).find(b=>b.dataset.areaId===a.id);if(b)b.textContent=`${a.title} · ${a.sections.filter(s=>s.done).length}/${a.sections.length}`;});label.append(cb,el('strong',s.title));section.append(label);const body=el('div',s.body);body.className='prep-prose';section.append(body);const edit=el('details');edit.append(el('summary','编辑本节'));const field=el('textarea');field.value=s.body;field.maxLength=30000;field.setAttribute('aria-label','编辑：'+s.title);field.oninput=()=>update(()=>{s.body=field.value;body.textContent=s.body;});edit.append(field);section.append(edit);main.append(section);}
  const notesLabel=el('label','临场备注');notesLabel.htmlFor='prep-notes';const notes=el('textarea');notes.id='prep-notes';notes.value=a.notes;notes.maxLength=20000;notes.oninput=()=>update(()=>{a.notes=notes.value;});main.append(notesLabel,notes,el('p','修改随战役在一分钟内自动保存，也可立即保存；写入结果请查看主控台顶部存档状态。'));
 }
 function open(){campaign=getState().campaignId;if(!campaign){toast('请先创建或读取正式战役');return;}getState().prepHandbook=normalize(getState().prepHandbook);query='';$('prep-search').value='';$('prep-campaign').textContent=getState().campaignName+' · 主持人专用';render();if(!$('prep-dialog').open)$('prep-dialog').showModal();}
 function init(){$('btn-prep-open').onclick=open;$('prep-save').onclick=()=>{if(guard())saveImmediately();};$('prep-close').onclick=()=>$('prep-dialog').close();$('prep-search').oninput=e=>{query=e.target.value.toLowerCase();render();};$('prep-add').onclick=()=>{const title=$('prep-new-title').value.trim();if(!title||!guard())return;update(()=>{const a=normalize([{id:'prep-'+Date.now(),title,sections:['目标与开场','路线与地图','棋子摆放','线索与检定','分支与战斗','收尾与奖励'].map((title,i)=>({id:'s'+i,title,body:''}))}])[0];getState().prepHandbook.push(a);selected=a.id;});query='';$('prep-search').value='';$('prep-new-title').value='';render();};}
 return {init,open};
}
return {normalize,create};
});
