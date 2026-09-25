/* A map-independent travel tray. All ownership and placement mutations stay in adapters. */
window.TravelBasket = (() => {
  const skins = {
    'stone-road': {category:'路面',name:'古城石道',icon:'⌁',in:'加入队伍',out:'抵达',image:'stone-road-v1.webp'},
    'travel-wagon': {category:'载具',name:'旅行马车',icon:'♞',in:'上车',out:'下车',image:'travel-wagon-v1.webp'},
    'star-portal': {category:'传送门',name:'奥术星环',icon:'✧',in:'进入传送门',out:'传送抵达',image:'star-portal-v1.webp',round:true},
    'forest-path': {category:'路面',name:'林间小径',icon:'⌁',in:'加入队伍',out:'抵达',image:'forest-path-v1.webp'},
    'snow-trail': {category:'路面',name:'雪地足迹',icon:'❄',in:'加入队伍',out:'抵达',image:'snow-trail-v1.webp'},
    'voyage-ship': {category:'载具',name:'远航帆船',icon:'⚓',in:'登船',out:'靠岸',image:'voyage-ship-v1.webp'},
    'country-road': {category:'路面',name:'乡野土路',icon:'⌁',in:'加入队伍',out:'抵达',image:'country-road-v1.webp'},
    'desert-sand': {category:'路面',name:'荒漠沙地',icon:'⌁',in:'加入队伍',out:'抵达',image:'desert-sand-v1.webp'},
    'mountain-trail': {category:'路面',name:'山地险径',icon:'⌁',in:'加入队伍',out:'抵达',image:'mountain-trail-v1.webp'},
    'swamp-path': {category:'路面',name:'沼泽泥径',icon:'⌁',in:'加入队伍',out:'抵达',image:'swamp-path-v1.webp'},
    'coastal-beach': {category:'路面',name:'海岸沙滩',icon:'⌁',in:'加入队伍',out:'抵达',image:'coastal-beach-v1.webp'},
    'cavern-floor': {category:'路面',name:'洞窟岩地',icon:'⌁',in:'加入队伍',out:'抵达',image:'cavern-floor-v1.webp'},
    'dungeon-stone': {category:'路面',name:'地牢石板',icon:'⌁',in:'加入队伍',out:'抵达',image:'dungeon-stone-v1.webp'},
    'wood-boardwalk': {category:'路面',name:'木质栈道',icon:'⌁',in:'加入队伍',out:'抵达',image:'wood-boardwalk-v1.webp'},
    'volcanic-ground': {category:'路面',name:'火山焦土',icon:'⌁',in:'加入队伍',out:'抵达',image:'volcanic-ground-v1.webp'}
  };
  let config, root, toggle, panel, status, art, deck, picker, skin='travel-wagon', opened=false, busy=false, ticket=0, timer, lastKey='', cached=null, outgoing=null, silhouette=null;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function normalizeSkin(value){return skins[value]?value:({'road':'stone-road','wagon':'travel-wagon','ship':'voyage-ship'}[value]||'travel-wagon');}
  function context(){return String(config?.key?.()||'');}
  function skinUrl(id){return new URL('../asset/界面/旅行篮子/'+skins[id].image,window.location.href).href;}
  function applySkin(){cancelOutgoing();silhouette=null;const s=skins[skin];root.dataset.skin=skin;root.dataset.category=s.category;toggle.textContent=s.icon+' 旅行篮子';const image=el('img');image.onload=()=>readSilhouette(image);image.src=skinUrl(skin);image.alt=s.name;art.replaceChildren(image,deck);if(cached)draw(cached);}
  function readSilhouette(image){
    if(art.children[0]!==image)return;
    try{const canvas=document.createElement('canvas');canvas.width=128;canvas.height=Math.max(1,Math.round(128*image.naturalHeight/image.naturalWidth));const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,canvas.width,canvas.height);silhouette={width:canvas.width,height:canvas.height,data:ctx.getImageData(0,0,canvas.width,canvas.height).data};}catch{silhouette=null;}
  }
  function outgoingPoint(x,y){
    if(containsPoint(x,y))return null;
    const hits=document.elementsFromPoint?document.elementsFromPoint(x,y):[document.elementFromPoint(x,y)];
    // Basket controls still block drops; transparent image margins do not.
    const top=hits[0];if(top?.closest?.('button,select,input,textarea,[role=button],dialog'))return null;
    const target=hits.find(node=>!root.contains(node)&&!node?.classList?.contains?.('travel-ghost'));
    if(!config.board?.contains(target))return null;
    const point=config.mapPoint?.(x,y);return point&&Number.isFinite(point.x)&&Number.isFinite(point.y)?point:null;
  }
  function configure(options){
    config=options;if(root)return;
    skin=normalizeSkin(config.skin?.());
    root=el('aside',undefined,'travel-basket');root.setAttribute('aria-label','旅行篮子');
    toggle=el('button');toggle.type='button';toggle.className='travel-toggle';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls','travel-panel');
    panel=el('section',undefined,'travel-panel');panel.id='travel-panel';panel.hidden=true;
    if(config.setSkin){
      picker=el('dialog',undefined,'travel-skin-dialog');picker.id='travel-skin-dialog';picker.setAttribute('aria-labelledby','travel-skin-title');
      const header=el('header'),title=el('h2','旅行篮子皮肤');title.id='travel-skin-title';
      const back=el('button','返回','travel-skin-back');back.type='button';back.onclick=()=>picker.close();header.append(title,back);
      const groups=el('div',undefined,'travel-skin-groups');
      for(const category of ['路面','载具','传送门']){
      const section=el('section',undefined,'travel-skin-group');section.setAttribute('aria-label',category);
      const heading=el('h3',category),gallery=el('div',undefined,'travel-skin-gallery');
      for(const [id,s] of Object.entries(skins).filter(([,s])=>s.category===category)){
        const card=el('button',undefined,'travel-skin-card');card.type='button';card.dataset.skin=id;card.setAttribute('aria-label',s.name);
        const preview=el('img');preview.src=skinUrl(id);preview.alt='';preview.loading='lazy';
        card.append(preview,el('span',s.name));
        card.onclick=()=>{if(busy)return;config.setSkin(id);skin=id;applySkin();setOpen(true);picker.close();};gallery.append(card);
      }
      section.append(heading,gallery);groups.append(section);
      }
      picker.append(header,groups);document.body.append(picker);
      for(const name of ['pointerdown','pointerup','click','keydown','wheel'])picker.addEventListener(name,e=>e.stopPropagation());
      picker.addEventListener('click',e=>{if(e.target===picker){const r=picker.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)picker.close();}});
      picker.addEventListener('close',()=>toggle.focus());
    }
    art=el('div',undefined,'travel-scene');deck=el('div',undefined,'travel-deck');deck.setAttribute('aria-label','旅途中的棋子');status=el('p','','travel-status');status.setAttribute('role','status');
    panel.append(art,status);root.append(panel,toggle);if(config.followOpen)toggle.hidden=true;
    if(picker){const fold=el('button','⌃','travel-fold');fold.type='button';fold.setAttribute('aria-label','展开或收起旅行篮子');fold.onclick=()=>setOpen(!opened);root.append(fold);toggle.setAttribute('aria-haspopup','dialog');toggle.setAttribute('aria-controls','travel-skin-dialog');}(config.parent||document.body).append(root);
    for(const name of ['pointerdown','mousedown','touchstart','wheel','click','dblclick','keydown'])root.addEventListener(name,e=>{e.stopPropagation();if(name==='keydown'&&e.key==='Escape'){e.preventDefault();setOpen(false);}});
    toggle.onclick=()=>{if(config.followOpen)return;if(!picker){setOpen(!opened);return;}if(busy)return;cancelOutgoing();for(const card of picker.querySelectorAll('.travel-skin-card')){card.setAttribute('aria-pressed',String(card.dataset.skin===skin));}picker.showModal();};applySkin();if(config.open)setOpen(config.open()===true,true);
    window.addEventListener('focus',()=>{if(opened)refresh();});
  }
  function setOpen(value,fromHost=false){
    if(config.followOpen&&!fromHost)return;
    value=Boolean(value);if(config.followOpen)root.hidden=!value;
    if(opened===value)return;
    cancelOutgoing();opened=value;panel.hidden=!value;toggle.setAttribute('aria-expanded',String(value));clearInterval(timer);++ticket;
    if(value){refresh();timer=setInterval(()=>{if(!document.hidden)refresh(true);},12000);}else if(!config.followOpen)toggle.focus();
    if(!fromHost)config.setOpen?.(value);
  }

  function draw(data){
    deck.replaceChildren();const s=skins[skin];
    toggle.textContent=s.icon+' 旅行篮子 · '+data.stored.length;
    for(const item of data.stored){
      const token=el('button',undefined,'travel-passenger');token.type='button';token.disabled=busy||!data.canPlace;
      token.title=(item.name||'棋子')+' · '+s.out;token.setAttribute('aria-label',s.out+'：'+(item.name||'棋子'));
      const portrait=el('span',item.icon||s.icon,'travel-portrait');if(item.image){const image=el('img');image.src=item.image;image.alt='';image.loading='lazy';image.onerror=()=>image.remove();portrait.replaceChildren(image);}
      token.append(portrait,el('small',item.name||'棋子'));token.onclick=e=>e.preventDefault();
      token.onpointerdown=e=>beginOutgoing(e,token,item);token.onpointermove=moveOutgoing;token.onpointerup=finishOutgoing;token.onpointercancel=cancelOutgoing;token.onlostpointercapture=cancelOutgoing;
      token.ondragstart=e=>e.preventDefault();deck.append(token);
    }
    if(picker)for(const card of picker.querySelectorAll('.travel-skin-card'))card.disabled=busy;
  }

  async function run(action){if(busy)return;if(lastKey!==context())lastKey=context();busy=true;if(cached)draw(cached);status.textContent='正在安顿同行者…';const key=context();try{await action();if(key===context())status.textContent='';}catch(e){if(key===context())status.textContent=e.message||'操作未完成，请重试';}finally{busy=false;await refresh(true);}}
  async function refresh(quiet=false){
    if(!root||!opened||busy||outgoing)return;const key=context(),seq=++ticket;
    if(lastKey!==key){cached=null;deck.replaceChildren();status.textContent='';lastKey=key;}
    if(!quiet)status.textContent='正在查看队伍…';
    try{const data=await config.list();if(seq!==ticket||key!==context()||!opened)return;cached=data;draw(data);if(!quiet)status.textContent='';}
    catch(e){if(seq===ticket&&key===context()){cached=null;deck.replaceChildren();status.textContent=e.message||'队伍暂时无法同步';}}
  }
  function changed(){if(!root)return;if(config.open)setOpen(config.open()===true,true);const next=normalizeSkin(config.skin?.());if(next!==skin){skin=next;applySkin();}const different=lastKey!==context();if(different){cancelOutgoing();if(picker?.open)picker.close();++ticket;cached=null;deck.replaceChildren();status.textContent='';}if(opened&&!busy&&(different||config.local))refresh(true);}
  function cancelOutgoing(){
    const drag=outgoing;outgoing=null;if(!drag)return;
    drag.ghost?.remove();drag.token.classList.remove('travel-dragging');
    if(drag.token.hasPointerCapture?.(drag.pointerId))drag.token.releasePointerCapture(drag.pointerId);
  }
  function beginOutgoing(e,token,item){
    if(e.button!==0||busy||outgoing||!cached?.canPlace)return;
    e.preventDefault();e.stopPropagation();++ticket;
    outgoing={token,item,pointerId:e.pointerId,x:e.clientX,y:e.clientY,key:context(),moved:false};
    token.setPointerCapture(e.pointerId);
  }
  function moveOutgoing(e){
    const drag=outgoing;if(!drag||e.pointerId!==drag.pointerId)return;e.stopPropagation();
    if(drag.key!==context()){cancelOutgoing();return;}
    if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
    if(!drag.moved){drag.moved=true;drag.ghost=drag.token.cloneNode(true);drag.ghost.className='travel-passenger travel-ghost';drag.ghost.setAttribute('aria-hidden','true');drag.ghost.removeAttribute('aria-label');document.body.append(drag.ghost);drag.token.classList.add('travel-dragging');}
    drag.ghost.style.left=e.clientX+'px';drag.ghost.style.top=e.clientY+'px';drag.ghost.dataset.valid=String(Boolean(outgoingPoint(e.clientX,e.clientY)));
  }
  function finishOutgoing(e){
    const drag=outgoing;if(!drag||e.pointerId!==drag.pointerId)return;e.preventDefault();e.stopPropagation();
    const point=drag.moved&&drag.key===context()?outgoingPoint(e.clientX,e.clientY):null;
    cancelOutgoing();
    if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y))return run(()=>config.release(drag.item,point));
  }
  function containsPoint(x,y){
    if(!root||(config.followOpen&&!opened))return false;const rect=(opened?art:toggle).getBoundingClientRect();
    if(x<rect.left||x>rect.right||y<rect.top||y>rect.bottom)return false;
    if(opened&&silhouette){
      const sw=silhouette.width,sh=silhouette.height,w=rect.right-rect.left,h=rect.bottom-rect.top;
      const scale=(skin==='voyage-ship'?Math.max:Math.min)(w/sw,h/sh);
      const sx=Math.floor((x-rect.left-(w-sw*scale)/2)/scale),sy=Math.floor((y-rect.top-(h-sh*scale)/2)/scale);
      return sx>=0&&sx<sw&&sy>=0&&sy<sh&&silhouette.data[(sy*sw+sx)*4+3]>32;
    }
    if(opened&&skins[skin].round){const rx=(rect.right-rect.left)/2,ry=(rect.bottom-rect.top)/2;return rx>0&&ry>0&&((x-rect.left-rx)/rx)**2+((y-rect.top-ry)/ry)**2<=1;}
    return true;
  }
  function hover(x,y){const inside=containsPoint(x,y);if(root)root.classList.toggle('travel-drop-hover',inside);return inside;}
  function drop(item,x,y){
    if(!containsPoint(x,y))return false;
    root.classList.remove('travel-drop-hover');
    if(!opened)setOpen(true);
    if(!busy)run(()=>config.collect(item));
    return true;
  }
  return Object.freeze({configure,changed,refresh,containsPoint,hover,drop});
})();
