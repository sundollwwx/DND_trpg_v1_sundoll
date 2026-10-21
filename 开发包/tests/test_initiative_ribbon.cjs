const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const {createPortraitContext}=require('./portrait_view_fixture.cjs');

function extract(source,name){
  let start=source.indexOf(`function ${name}(`);
  if(start>=6&&source.slice(start-6,start)==='async ')start-=6;
  const lineEnd=source.indexOf('\n',start);
  if(start>=0&&source.slice(start,lineEnd).trimEnd().endsWith('}'))return source.slice(start,lineEnd);
  const indent=source.slice(source.lastIndexOf('\n',start)+1,start);
  const end=source.indexOf('\n'+indent+'}',start)+2+indent.length;
  assert.ok(start>=0&&end>start,`Missing production function ${name}`);
  return source.slice(start,end);
}

test('the initiative snapshot excludes hidden units and their current-turn identity',()=>{
  const host=readClientSource('主控台/host/app.js');
  const encounter={playMode:'turn',round:3,secondsPerRound:6,currentEntryId:'hidden-entry',turnSerial:8,
    turnPath:{mapId:'map',tokenId:'hidden-token',points:[{x:10,y:20}],segmentEnds:[1]},
    entries:[{id:'visible-entry',tokenId:'visible-token',name:'公开角色',value:18,order:0},
      {id:'hidden-entry',tokenId:'hidden-token',name:'秘密伏兵',value:14,order:1},
      {id:'manual-entry',tokenId:null,name:'环境事件',value:10,order:2}],
    worldTime:{totalSeconds:42,runningSince:null,rate:1},weather:{},lastEvent:{label:'秘密伏兵行动',at:100}};
  const ctx={encounterState:()=>encounter,initiativeEntryLabel:e=>e.name,
    normalizeTurnPathSegmentEnds:(ends)=>ends||[]};
  vm.createContext(ctx);
  vm.runInContext(extract(host,'publicEncounterState'),ctx);
  const projected=ctx.publicEncounterState(new Set(['visible-token']));
  assert.deepEqual(Array.from(projected.entries,e=>e.id),['visible-entry','manual-entry']);
  assert.equal(projected.currentEntryId,null);
  assert.equal(projected.turnPath.tokenId,null);
  assert.equal(projected.turnPath.mapId,null);
  assert.equal(projected.turnPath.points.length,0);
  assert.equal(JSON.stringify(projected).includes('秘密伏兵'),false);
  assert.equal(encounter.currentEntryId,'hidden-entry','projection must not advance or otherwise mutate the host turn');
});

test('public token portraits include visible defaults while hidden characters remain omitted',()=>{
  const host=readClientSource('主控台/host/app.js');
  const rules=require(path.join(APP_ROOT,'shared/rules.js'));
  const defaultPortrait={iconImgPath:'立绘/先攻/默认.png'};
  const ctx={SundollRules:rules,SundollSize:{normalize:()=>({size:1})},normalizeSpellRange:()=>({}),
    tokenPortraitVariants:t=>t.portraitVariants||[],portraitLibraryPresetForToken:()=>({initiativePortrait:defaultPortrait})};
  vm.createContext(ctx);vm.runInContext(extract(host,'publicStreamToken'),ctx);
  const token={id:'visible',type:'pc',name:'公开角色',conditions:[{key:'secret',visibility:'gm'}],
    portraitVariants:[{name:'显翼',iconImgPath:'立绘/角色/显翼.png',initiativePortrait:{iconImgPath:'立绘/先攻/显翼.png'}}]};
  const projected=ctx.publicStreamToken(token);
  assert.equal(projected.initiativePortrait.iconImgPath,'立绘/先攻/默认.png');
  assert.equal(projected.portraitVariants[0].initiativePortrait.iconImgPath,'立绘/先攻/显翼.png');
  assert.equal(projected.conditions.length,0);
  assert.equal(ctx.publicStreamToken({...token,hiddenFromPlayers:true,name:'秘密伏兵'}),null);
  assert.equal(ctx.publicStreamToken({...token,ownedPieceId:'owned'}).initiativePortrait,null,'owned characters never inherit an unrelated host-library default');
});

test('host and player choose the current form portrait, then its default, then the current existing portrait',()=>{
  const rules=require(path.join(APP_ROOT,'shared/rules.js'));
  const host=readClientSource('主控台/host/app.js');
  const player=fs.readFileSync(path.join(APP_ROOT,'主控台/player/player.js'),'utf8');
  const preset={id:'preset',name:'角色',type:'pc',initiativePortrait:{iconImgPath:'立绘/先攻/资料库默认.png'},portraitVariants:[]};
  const ctx={SundollRules:rules,state:{library:[preset]},canonicalPortraitPath:v=>v||null,
    portraitAssetUrl:v=>'/assets/'+v,avatarCache:new Map([['cached','data:image/png;base64,YQ==']])};
  createPortraitContext(ctx);
  for(const name of ['normalizePortraitVariants','portraitAssetIdentity','portraitLibraryPresetForToken','tokenPortraitVariants',
    'currentTokenPortraitVariantIndex','initiativePortraitForToken','initiativePortraitImageUrl'])vm.runInContext(extract(host,name),ctx);
  const pctx={SundollRules:rules};createPortraitContext(pctx);
  for(const name of ['normalizePlayerPortraitVariants','portraitIdentity','currentPortraitVariantIndex','playerInitiativePortraitForToken'])vm.runInContext(extract(player,name),pctx);
  const variants=[{name:'常态',iconImgPath:'立绘/角色/常态.png',initiativePortrait:{iconImgPath:'立绘/先攻/常态.png'}},
    {name:'显翼',iconImgPath:'立绘/角色/显翼.png',initiativePortrait:{iconImgPath:'立绘/先攻/显翼.png'}}];
  const token={id:'t',type:'pc',name:'角色',presetId:'preset',iconImgPath:'立绘/角色/显翼.png',portraitVariant:1,
    portraitVariants:variants,initiativePortrait:{iconImgPath:'立绘/先攻/角色默认.png'}};
  for(const [context,name] of [[ctx,'initiativePortraitForToken'],[pctx,'playerInitiativePortraitForToken']]){
    assert.equal(context[name](token).iconImgPath,'立绘/先攻/显翼.png');
    assert.equal(context[name]({...token,portraitVariant:0}).iconImgPath,'立绘/先攻/显翼.png','a stale variant hint follows actual image identity');
    assert.equal(context[name]({...token,portraitVariants:[]}).iconImgPath,'立绘/先攻/角色默认.png');
    const fallback={...token,portraitVariants:[],initiativePortrait:null,presetId:null,ownedPieceId:'own'};
    assert.equal(context[name](fallback),fallback,'an unconfigured character keeps the current existing portrait');
    assert.equal(context[name](null),null);
  }
  const libraryFallback={...token,portraitVariants:[],initiativePortrait:null};
  assert.equal(ctx.initiativePortraitForToken(libraryFallback).iconImgPath,'立绘/先攻/资料库默认.png');
  assert.equal(ctx.initiativePortraitImageUrl({iconImgPath:'立绘/先攻/常态.png'}),'/assets/立绘/先攻/常态.png');
  assert.equal(ctx.initiativePortraitImageUrl({iconImgId:'cached'}),'data:image/png;base64,YQ==');
});

test('actual host and player portrait selection centers the map without advancing combat',()=>{
  const token={id:'rider',x:100,y:80,mountId:'mount',type:'pc'},mount={id:'mount',x:220,y:160};
  const map={id:'map',tokens:[token,mount],cam:{x:0,y:0,zoom:2}};
  const encounter={currentEntryId:'other',round:4,turnSerial:7};
  const host=readClientSource('主控台/host/app.js');
  let selected=null,hostCameraApplied=0;
  const ctx={state:{maps:[map],activeMapId:'other-map',encounter},board:{getBoundingClientRect:()=>({width:1000,height:700})},
    switchMap:id=>{ctx.state.activeMapId=id;},applyCamera:()=>hostCameraApplied++,selectToken:id=>{selected=id;},toast:()=>{}};
  vm.createContext(ctx);vm.runInContext(extract(host,'focusHostInitiativeEntry'),ctx);
  ctx.focusHostInitiativeEntry({id:'rider-entry',tokenId:'rider'});
  assert.equal(ctx.state.activeMapId,'map');assert.equal(selected,'rider');assert.equal(hostCameraApplied,1);
  assert.equal(map.cam.x,60);assert.equal(map.cam.y,30,'mounted actors focus their visible mount position');
  assert.deepEqual(encounter,{currentEntryId:'other',round:4,turnSerial:7});
  const player=fs.readFileSync(path.join(APP_ROOT,'主控台/player/player.js'),'utf8');
  let owned=true,opened=null,investigated=null,playerCameraApplied=0;
  const pctx={state:{encounter},currentMap:{id:'old'},flowEncounterMap:()=>map,
    switchPlayerMap:()=>{pctx.currentMap=map;},board:ctx.board,view:{ox:0,oy:0,scale:2},
    applyView:()=>playerCameraApplied++,ownedToken:()=>owned,renderTokens:()=>{},openDetail:id=>{opened=id;},
    showTokenInvestigation:t=>{investigated=t;},toast:()=>{}};
  vm.createContext(pctx);vm.runInContext(extract(player,'focusPlayerInitiativeEntry'),pctx);
  pctx.focusPlayerInitiativeEntry({tokenId:'rider'});
  assert.equal(pctx.currentMap,map);assert.equal(opened,'rider');assert.equal(pctx.selectedId,'rider');
  assert.equal(pctx.view.ox,60);assert.equal(pctx.view.oy,30);
  owned=false;pctx.focusPlayerInitiativeEntry({tokenId:'mount'});
  assert.equal(investigated,mount);assert.equal(playerCameraApplied,2);
  assert.deepEqual(encounter,{currentEntryId:'other',round:4,turnSerial:7});
});

class Element {
  constructor(tag,doc){
    this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.attributes={};
    this.dataset={};this.events={};this.style={setProperty(k,v){this[k]=String(v);},removeProperty(k){delete this[k];}};
    this.hidden=false;this._text='';this.parentElement=null;this.scrollLeft=0;
    this.classList={add:(...names)=>{const c=new Set(this.className.split(/\s+/).filter(Boolean));names.forEach(n=>c.add(n));this.className=[...c].join(' ');},
      remove:(...names)=>{this.className=this.className.split(/\s+/).filter(n=>!names.includes(n)).join(' ');},
      contains:n=>this.className.split(/\s+/).includes(n),toggle:(n,force)=>{const on=force===undefined?!this.classList.contains(n):force;if(on)this.classList.add(n);else this.classList.remove(n);return on;}};
  }
  get className(){return this.attributes.class||'';}
  set className(v){this.attributes.class=String(v);}
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  setAttribute(k,v){this.attributes[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,l)=>l.toUpperCase())]=String(v);}
  getAttribute(k){if(k.startsWith('data-'))return this.dataset[k.slice(5).replace(/-([a-z])/g,(_,l)=>l.toUpperCase())]??null;return Object.hasOwn(this.attributes,k)?this.attributes[k]:null;}
  removeAttribute(k){delete this.attributes[k];}
  toggleAttribute(k,on){if(on??!Object.hasOwn(this.attributes,k))this.setAttribute(k,'');else this.removeAttribute(k);}
  append(...nodes){for(const n of nodes){if(typeof n!=='string')n.parentElement=this;this.children.push(n);}}
  appendChild(n){this.append(n);return n;}
  get firstElementChild(){return this.children.find(c=>typeof c!=='string')||null;}
  get nextElementSibling(){if(!this.parentElement)return null;const children=this.parentElement.children.filter(c=>typeof c!=='string');return children[children.indexOf(this)+1]||null;}
  get offsetWidth(){return this._offsetWidth??(this.classList.contains('initiative-ribbon-item')?78:0);}
  set offsetWidth(v){this._offsetWidth=v;}
  get offsetLeft(){return this._offsetLeft??(this.parentElement?this.parentElement.children.indexOf(this)*88:0);}
  set offsetLeft(v){this._offsetLeft=v;}
  get clientWidth(){return this._clientWidth??(this.classList.contains('initiative-ribbon-viewport')?420:0);}
  set clientWidth(v){this._clientWidth=v;}
  get scrollWidth(){return this._scrollWidth??(this.classList.contains('initiative-ribbon-viewport')?Math.max(this.clientWidth,(this.firstElementChild?.children.length||0)*88+8):0);}
  set scrollWidth(v){this._scrollWidth=v;}
  insertBefore(n,cursor){n.remove();n.parentElement=this;const index=cursor?this.children.indexOf(cursor):-1;if(index<0)this.children.push(n);else this.children.splice(index,0,n);}
  remove(){if(this.parentElement){const i=this.parentElement.children.indexOf(this);if(i>=0)this.parentElement.children.splice(i,1);}this.parentElement=null;}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  addEventListener(type,handler){(this.events[type]??=[]).push(handler);}
  dispatch(type){const e={target:this,currentTarget:this,stopped:false,preventDefault(){},stopPropagation(){this.stopped=true;}};let current=this;while(current){e.currentTarget=current;for(const fn of current.events[type]||[])fn(e);if(e.stopped)break;current=current.parentElement;}}
  click(){if(!this.disabled)this.dispatch('click');}
  contains(n){return n===this||this.children.some(c=>typeof c!=='string'&&c.contains(n));}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  scrollBy(options){this.scrollLeft=Math.max(0,Math.min(this.scrollWidth-this.clientWidth,this.scrollLeft+options.left));this.dispatch('scroll');}
  scrollIntoView(options){this.scrollOptions=options;this.scrollCount=(this.scrollCount||0)+1;const viewport=this.closest('.initiative-ribbon-viewport');if(viewport){const left=this.offsetLeft+4,right=left+this.offsetWidth;if(left<viewport.scrollLeft)viewport.scrollLeft=left;else if(right>viewport.scrollLeft+viewport.clientWidth)viewport.scrollLeft=right-viewport.clientWidth;viewport.dispatch('scroll');}}
  querySelectorAll(selector){const found=[];for(const c of this.children){if(typeof c==='string')continue;if(c.matches(selector))found.push(c);found.push(...c.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  matches(selector){
    if(selector.startsWith('#'))return this.getAttribute('id')===selector.slice(1);
    if(selector.startsWith('.'))return selector.slice(1).split('.').every(c=>this.classList.contains(c));
    if(selector.startsWith('[')){const match=selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);return Boolean(match&&(match[2]===undefined?this.getAttribute(match[1])!==null:this.getAttribute(match[1])===match[2]));}
    return this.tagName===selector.toUpperCase();
  }
}
function loadRibbon(){
  const frames=new Map();let serial=0;
  const doc={createElement(tag){return new Element(tag,this);},createDocumentFragment(){return new Element('fragment',this);}};
  const window={requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id)};
  doc.defaultView=window;
  const context={window,document:doc};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'主控台/shared/initiative-ribbon.js'),'utf8'),context);
  return {ribbon:context.window.SundollInitiativeRibbon,container:doc.createElement('div'),flushFrames(){for(const [id,fn] of frames){frames.delete(id);fn();}}};
}

test('portrait cards show all four factions and clicking only selects a map subject',()=>{
  const {ribbon,container,flushFrames}=loadRibbon();
  const entries=[{id:'pc',name:'试修斯',value:20,type:'pc',icon:'🧙',imageUrl:'pc.png'},
    {id:'ally',name:'艾卓恩',value:18,type:'ally',icon:'🐉',imageUrl:'ally.png'},
    {id:'enemy',name:'斯帕克伦德（本团强化）',value:14,type:'enemy',icon:'👹',imageUrl:'enemy.png'},
    {id:'npc',name:'中立向导',value:10,type:'npc',icon:'🧭'}];
  const encounter={currentEntryId:'pc',round:2};let selected=null;
  ribbon.render(container,{entries,mode:'turn',...encounter,onSelect:e=>{selected=e;}});flushFrames();
  const buttons=container.querySelectorAll('.initiative-ribbon-card');assert.equal(buttons.length,4);
  const expected={pc:'#5b8cff',ally:'#2ecc71',enemy:'#ef476f',npc:'#e5be54'};
  buttons.forEach((button,index)=>{
    assert.equal(button.dataset.faction,entries[index].type);
    assert.equal(button.style['--initiative-ribbon-faction'],expected[entries[index].type]);
    assert.ok(button.getAttribute('aria-label').includes(entries[index].name));
    assert.equal(button.querySelector('.initiative-ribbon-name').textContent,entries[index].name,'long names remain complete');
  });
  assert.equal(buttons[0].getAttribute('aria-current'),'step');
  assert.equal(buttons[1].getAttribute('aria-current'),null);
  buttons[2].querySelector('.initiative-ribbon-name').click();
  assert.equal(selected,entries[2]);assert.equal(encounter.currentEntryId,'pc');assert.equal(encounter.round,2);
});

test('the map ribbon contains portraits and navigation without a status or arrangement header',()=>{
  const {ribbon,container,flushFrames}=loadRibbon();let selected=0,managed=0;
  const entries=[{id:'one',type:'pc',name:'当前行动者',value:20},{id:'two',type:'enemy',name:'敌人',value:16}];
  for(const mode of ['prepare','turn']){
    ribbon.render(container,{mode,round:3,currentEntryId:'one',entries,onSelect:()=>selected++,onManage:()=>managed++});
    flushFrames();
    assert.equal(container.querySelector('.initiative-ribbon-header'),null);
    assert.equal(container.querySelector('.initiative-ribbon-heading'),null);
    assert.equal(container.querySelector('.initiative-ribbon-manage'),null);
    assert.equal(container.querySelectorAll('.initiative-ribbon-card').length,2);
  }
  container.querySelector('.initiative-ribbon-card').click();
  assert.equal(selected,1);assert.equal(managed,0);
});

function parseMarkup(markup){
  const doc={createElement:tag=>new Element(tag,doc)},root=doc.createElement('document'),stack=[root];
  const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for(const token of markup.match(/<!--[^]*?-->|<\/?[A-Za-z][^>]*>/g)||[]){
    if(token.startsWith('<!--'))continue;
    const match=token.match(/^<(\/?)([\w:-]+)/);if(!match)continue;
    const tag=match[2].toLowerCase();
    if(match[1]){const index=stack.findLastIndex(el=>el.tagName===tag.toUpperCase());if(index>0)stack.length=index;continue;}
    const node=doc.createElement(tag);
    const attrs=token.slice(match[0].length,-1);
    for(const attr of attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))node.setAttribute(attr[1],attr[2]??attr[3]??attr[4]??'');
    stack[stack.length-1].append(node);
    if(!voidTags.has(tag)&&!token.endsWith('/>'))stack.push(node);
  }
  return root;
}

test('host and player initiative lists live once in an independent dialog, outside their lower dock',()=>{
  const variants=[{file:'主控台.html',modal:'initiative-manager-modal',dock:'init-bar',list:'init-bar-list',panel:'init-panel-initiative',title:'initiative-manager-title'},
    {file:'玩家.html',modal:'player-initiative-manager-modal',dock:'flowbar',list:'flow-init-list',panel:'flow-panel-initiative',title:'player-initiative-manager-title'}];
  for(const spec of variants){
    const tree=parseMarkup(fs.readFileSync(path.join(APP_ROOT,'主控台',spec.file),'utf8'));
    const modal=tree.querySelector('#'+spec.modal),dock=tree.querySelector('#'+spec.dock),list=tree.querySelector('#'+spec.list);
    assert.ok(modal&&dock&&list,spec.file+' has a modal, dock and queue');
    for(const id of [spec.modal,spec.dock,spec.list,spec.panel,spec.title])assert.equal(tree.querySelectorAll('#'+id).length,1,spec.file+' uniquely owns '+id);
    assert.equal(modal.getAttribute('hidden'),'');assert.ok(modal.contains(list));assert.equal(dock.contains(list),false);
    assert.equal(modal.querySelector('[role="dialog"]').getAttribute('aria-labelledby'),spec.title);
    assert.ok(modal.contains(tree.querySelector('#'+spec.panel)));
  }
});

test('the actual player ribbon remains navigation only even with a legacy swap flag',()=>{
  const source=fs.readFileSync(path.join(APP_ROOT,'主控台/player/player.js'),'utf8');
  for(const playMode of ['free','prepare','turn']){
    const {ribbon,container}=loadRibbon(),selected=[];
    const next={encounter:{playMode,allowInitiativeSwap:true,turnSerial:8,currentEntryId:'one',
      entries:[{id:'one',tokenId:'token',name:'actor',value:12},{id:'two',name:'another',value:12}]},
      maps:[{id:'map',tokens:[{id:'token',type:'pc',icon:'🧙'}]}],activeMapId:'map'};
    const before=JSON.stringify(next),context={$:()=>container,window:{SundollInitiativeRibbon:ribbon},
      playerInitiativePortraitForToken:()=>null,originalPortraitUrl:()=>'',
      focusPlayerInitiativeEntry:entry=>selected.push(entry.id),openPlayerInitiativeManager(){},
      requestAction:()=>assert.fail('navigation must not submit an initiative action')};
    vm.createContext(context);vm.runInContext(extract(source,'flowEncounterMap')+'\n'+extract(source,'renderPlayerInitiativeRibbon'),context);
    context.renderPlayerInitiativeRibbon(next);
    container.querySelector('.initiative-ribbon-card').click();
    assert.deepEqual(selected,['one']);assert.equal(JSON.stringify(next),before);
  }
});

test('missing or failed portraits fall back without losing the visible identity',()=>{
  const {ribbon,container}=loadRibbon();
  const entry={id:'one',name:'无图角色',type:'pc',value:0,icon:'🧙',imageUrl:''};
  ribbon.render(container,{entries:[entry],mode:'prepare'});
  const card=container.querySelector('.initiative-ribbon-card'),image=card.querySelector('img'),icon=card.querySelector('.initiative-ribbon-icon');
  assert.equal(image.hidden,true);assert.equal(icon.hidden,false);assert.equal(icon.textContent,'🧙');
  assert.equal(card.querySelector('.initiative-ribbon-value').textContent,'0');
  ribbon.render(container,{entries:[{...entry,imageUrl:'missing.png'}],mode:'prepare'});
  assert.equal(image.hidden,false);assert.equal(icon.hidden,true);
  image.dispatch('error');assert.equal(image.hidden,true);assert.equal(icon.hidden,false);
  ribbon.render(container,{entries:[{...entry,imageUrl:'new-form.png'}],mode:'prepare'});
  assert.equal(image.src,'new-form.png');assert.equal(image.hidden,false);assert.equal(icon.hidden,true);
});

test('turn changes reveal the current entry while routine updates preserve card and scroll state',()=>{
  const {ribbon,container,flushFrames}=loadRibbon();
  const entries=Array.from({length:18},(_,i)=>({id:'entry-'+i,name:'角色 '+i,type:i%2?'enemy':'pc',value:20-i}));
  ribbon.render(container,{entries,mode:'turn',round:1,currentEntryId:'entry-15'});flushFrames();
  const before=container.querySelectorAll('.initiative-ribbon-card'),current=before[15],item=current.parentElement;
  assert.equal(item.scrollCount,1);assert.equal(current.getAttribute('aria-current'),'step');
  ribbon.render(container,{entries:entries.map(e=>({...e,imageUrl:'updated.png'})),mode:'turn',round:1,currentEntryId:'entry-15'});flushFrames();
  assert.equal(container.querySelectorAll('.initiative-ribbon-card')[15],current,'periodic map snapshots retain the portrait DOM');
  assert.equal(item.scrollCount,1,'routine snapshots must not pull a user-scrolled queue back to the current turn');
  ribbon.render(container,{entries:[entries[2],entries[0]],mode:'prepare'});flushFrames();
  assert.deepEqual(container.querySelectorAll('.initiative-ribbon-card').map(e=>e.dataset.entryId),['entry-2','entry-0']);
  assert.ok(container.querySelectorAll('.initiative-ribbon-card').every(e=>e.getAttribute('aria-current')===null));
  assert.equal(container.hidden,false);
  ribbon.render(container,{entries,mode:'free'});assert.equal(container.hidden,true);
  ribbon.render(container,{entries:[],mode:'turn'});assert.equal(container.hidden,true);
});

test('overflow counts and paging browse the queue while keeping combat and selected token unchanged',()=>{
  const {ribbon,container,flushFrames}=loadRibbon();let selected=0;
  const entries=Array.from({length:18},(_,i)=>({id:'entry-'+i,name:'角色 '+i,type:'pc',value:20-i}));
  const options={entries,mode:'turn',round:1,currentEntryId:'entry-15',onSelect:()=>selected++};
  ribbon.render(container,options);flushFrames();
  const viewport=container.querySelector('.initiative-ribbon-viewport');
  const previous=container.querySelector('[data-direction="previous"]'),next=container.querySelector('[data-direction="next"]');
  assert.equal(container.dataset.initiativeOverflow,'true');assert.equal(previous.hidden,false);assert.equal(next.hidden,false);
  const current=container.querySelectorAll('.initiative-ribbon-card')[15].parentElement;
  assert.ok(current.offsetLeft+4>=viewport.scrollLeft);
  assert.ok(current.offsetLeft+4+current.offsetWidth<=viewport.scrollLeft+viewport.clientWidth);
  assert.ok(Number(previous.querySelector('.initiative-ribbon-nav-count').textContent)>0);
  assert.ok(Number(next.querySelector('.initiative-ribbon-nav-count').textContent)>0);
  next.click();assert.equal(selected,0);assert.equal(options.currentEntryId,'entry-15');assert.equal(options.round,1);
  assert.equal(next.disabled,true);assert.equal(next.querySelector('.initiative-ribbon-nav-count').textContent,'0');
  previous.click();const browsed=viewport.scrollLeft;
  ribbon.render(container,{...options,entries:entries.map(e=>({...e,imageUrl:'refresh.png'}))});flushFrames();
  assert.equal(viewport.scrollLeft,browsed,'routine refresh must preserve the browsed page');
  assert.equal(current.scrollCount,1,'paging must not cause an automatic return to the active card');
  for(let i=0;i<10;i++)previous.click();
  assert.equal(viewport.scrollLeft,0);assert.equal(previous.disabled,true);assert.equal(previous.querySelector('.initiative-ribbon-nav-count').textContent,'0');
  ribbon.render(container,{entries:entries.slice(0,2),mode:'prepare'});
  assert.equal(previous.hidden,true);assert.equal(next.hidden,true);
});

function playerLibraryContext(context,{host,piece,edit}={}){
  const requests=[];
  Object.assign(context,{window:{},location:{protocol:'http:'},fetch:async(url,args)=>{
    const body=JSON.parse(args.body);requests.push({url,headers:args.headers,body});
    if(body.op==='get')return {ok:true,json:async()=>({ok:true,library:{revision:7,pieces:[piece]}})};
    const saved=edit?edit(body):{...piece,...body.patch,revision:piece.revision+1};
    return {ok:true,json:async()=>({ok:true,library:{revision:8,pieces:[saved]}})};
  }});
  createPortraitContext(context);
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'主控台/shared/player-library.js'),'utf8'),context);
  context.PlayerLibrary=context.window.PlayerLibrary;
  context.PlayerLibrary.configure({host,session:()=> 'player-session'});
  return requests;
}

test('saving default and form initiative portraits uses the versioned official profile API and its returned media',async()=>{
  const host=readClientSource('主控台/host/app.js');
  const rules=require(path.join(APP_ROOT,'shared/rules.js'));
  const cached='/api/assets/'+ 'a'.repeat(64);
  for(const scope of ['default','variant']){
    const token={id:'live',ownedPieceId:'owned',ownerPlayerId:'player',hp:8,conditions:['poisoned'],
      initiativePortrait:{iconImgPath:'立绘/先攻/旧默认.png'},portraitVariants:[{name:'显翼',iconImgPath:'立绘/角色/显翼.png'}]};
    const piece={...JSON.parse(JSON.stringify(token)),revision:3};let autosaves=0,renders=0;
    const context={state:{maps:[{tokens:[token]}]},SundollRules:rules,canonicalPortraitPath:v=>v||null,
      tokenPortraitVariants:t=>t.portraitVariants,avatarGet:async()=>null,renderTokens:()=>{},updateDetail:()=>{},
      renderHostInitiativeRibbon:()=>renders++,renderPortraitVariantManager:()=>{},scheduleAutosave:()=>autosaves++};
    const requests=playerLibraryContext(context,{host:true,piece,edit:body=>{
      const saved={...piece,...body.patch,revision:4};
      if(scope==='default')saved.initiativePortrait={iconImgPath:cached};
      else saved.portraitVariants=saved.portraitVariants.map(v=>({...v,initiativePortrait:{iconImgPath:cached}}));
      return saved;
    }});
    for(const name of ['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex','applyTokenPortrait','commitInitiativePortrait'])vm.runInContext(extract(host,name),context);
    const source={iconImgPath:'立绘/先攻/新专用.png'};
    await context.commitInitiativePortrait(token,source,{scope,identity:'path:立绘/角色/显翼.png'});
    assert.deepEqual(requests.map(r=>r.url),['/api/player-profiles','/api/player-profiles']);
    assert.equal(requests[0].body.op,'get');assert.equal(requests[1].body.op,'edit');
    assert.equal(requests[1].headers['X-Sundoll-Local-Save'],'1');
    assert.equal(requests[1].body.revision,7);assert.equal(requests[1].body.pieceRevision,3);
    assert.equal(requests[1].body.ownedPieceId,'owned');assert.equal(requests[1].body.playerId,'player');
    if(scope==='default')assert.equal(token.initiativePortrait.iconImgPath,cached);
    else{assert.equal(token.portraitVariants[0].initiativePortrait.iconImgPath,cached);assert.equal(token.initiativePortrait.iconImgPath,'立绘/先攻/旧默认.png');}
    assert.equal(token.hp,8);assert.deepEqual(token.conditions,['poisoned']);assert.equal(autosaves,1);assert.equal(renders,1);
  }
});

test('saving a locally created owned form keeps that active form after the server rewrites its image identity',async()=>{
  const host=readClientSource('主控台/host/app.js');
  const rules=require(path.join(APP_ROOT,'shared/rules.js'));
  const body='data:image/png;base64,Ym9keQ==';
  const art='/api/player-art/'+ 'b'.repeat(64),other='/api/player-art/'+ 'c'.repeat(64);
  for(const [storage,offset,scope] of [['inline',0,'variant'],['cache',1,'variant'],['inline',1,'default']]){
    const image=storage==='cache'?{iconImgId:'new-body'}:{iconImg:body};
    const token={id:'live',ownedPieceId:'owned',ownerPlayerId:'player',name:'勇者',type:'pc',hp:8,conditions:['poisoned'],
      initiativePortrait:{iconImgPath:'立绘/先攻/旧默认.png'},...image,portraitVariant:0,
      portraitVariants:[{name:'显翼',...image}]};
    const piece={ownedPieceId:'owned',revision:3,iconImgPath:other,portraitVariant:0,
      portraitVariants:[{name:'收藏当前形态',iconImgPath:other}]};
    let renders=0,details=0,autosaves=0;
    const context={state:{maps:[{tokens:[token]}],selectedId:'live'},SundollRules:rules,canonicalPortraitPath:v=>v||null,
      tokenPortraitVariants:t=>t.portraitVariants,avatarGet:async id=>id==='new-body'?body:null,avatarGetDisplay:async()=>null,
      renderTokens:()=>renders++,updateDetail:()=>details++,renderHostInitiativeRibbon:()=>{},renderPortraitVariantManager:()=>{},scheduleAutosave:()=>autosaves++};
    const requests=playerLibraryContext(context,{host:true,piece,edit:request=>{
      assert.equal(request.patch.portraitVariants[0].iconImg,body,'ID cache contents must resolve before the server snapshot');
      const form={...request.patch.portraitVariants[0],iconImg:null,iconImgHd:null,iconImgId:null,iconImgPath:art};
      return {...piece,initiativePortrait:request.patch.initiativePortrait,
        portraitVariants:offset?[{name:'收藏当前形态',iconImgPath:other},form]:[form],portraitVariant:0};
    }});
    for(const name of ['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex','applyTokenPortrait','commitInitiativePortrait'])vm.runInContext(extract(host,name),context);
    await context.commitInitiativePortrait(token,{iconImgPath:'立绘/先攻/新显翼.png'},{scope,identity:storage==='cache'?'id:new-body':'img:'+body});
    assert.equal(requests[1].body.op,'edit');assert.equal(token.iconImgPath,art,`${storage}/${scope} keeps the local active body`);
    assert.equal(token.portraitVariant,offset);assert.equal(context.currentTokenPortraitVariantIndex(token,token.portraitVariants),offset);
    assert.equal(token.portraitVariants[offset].name,'显翼');assert.equal(token.iconImg,null);assert.equal(token.iconImgId,null);
    if(scope==='variant')assert.equal(token.portraitVariants[offset].initiativePortrait.iconImgPath,'立绘/先攻/新显翼.png');
    else assert.equal(token.initiativePortrait.iconImgPath,'立绘/先攻/新显翼.png');
    assert.equal(token.hp,8);assert.deepEqual(token.conditions,['poisoned']);assert.equal(renders,1);assert.equal(details,1);assert.equal(autosaves,1);
  }
});

test('a failed owned-portrait save leaves the active body and both portrait assignments untouched',async()=>{
  const host=readClientSource('主控台/host/app.js');
  const body='data:image/png;base64,Ym9keQ==';
  const token={id:'live',ownedPieceId:'owned',ownerPlayerId:'player',iconImgId:'new-body',hp:8,
    portraitVariant:0,initiativePortrait:{iconImgPath:'立绘/先攻/旧默认.png'},portraitVariants:[{name:'显翼',iconImgId:'new-body',initiativePortrait:{iconImgPath:'立绘/先攻/旧显翼.png'}}]};
  const before=JSON.stringify(token);let renders=0,saves=0;
  const context={state:{maps:[{tokens:[token]}]},SundollRules:require(path.join(APP_ROOT,'shared/rules.js')),
    canonicalPortraitPath:v=>v||null,tokenPortraitVariants:t=>t.portraitVariants,avatarGet:async()=>body,
    renderTokens:()=>renders++,updateDetail:()=>renders++,renderHostInitiativeRibbon:()=>renders++,renderPortraitVariantManager:()=>renders++,scheduleAutosave:()=>saves++,
    PlayerLibrary:{api:async data=>{if(data.op==='get')return {library:{revision:7,pieces:[{ownedPieceId:'owned',revision:3}]}};throw new Error('版本冲突');}}};
  createPortraitContext(context);
  for(const name of ['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex','applyTokenPortrait','commitInitiativePortrait'])vm.runInContext(extract(host,name),context);
  await assert.rejects(context.commitInitiativePortrait(token,{iconImgPath:'立绘/先攻/新显翼.png'},{scope:'variant',identity:'id:new-body'}),/版本冲突/);
  assert.equal(JSON.stringify(token),before);assert.equal(renders,0);assert.equal(saves,0);
});

test('source-form synchronization updates assigned portraits without duplicating bodies or resetting runtime',()=>{
  const host=readClientSource('主控台/host/app.js');
  const context={SundollRules:require(path.join(APP_ROOT,'shared/rules.js')),canonicalPortraitPath:v=>v||null};
  createPortraitContext(context);
  for(const name of ['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex','mergeOwnedPortraitForms'])vm.runInContext(extract(host,name),context);
  const token={id:'live',hp:3,conditions:['poisoned'],x:120,y:180,iconImgPath:'立绘/角色/显翼.png',
    initiativePortrait:{iconImgPath:'立绘/先攻/旧默认.png'},portraitVariants:[{name:'显翼',iconImgPath:'立绘/角色/显翼.png',initiativePortrait:{iconImgPath:'立绘/先攻/旧显翼.png'}}]};
  const piece={revision:4,sourcePresetId:'preset',initiativePortrait:{iconImgPath:'立绘/先攻/新默认.png'},
    portraitVariants:[{name:'显翼',iconImgPath:'立绘/角色/显翼.png',initiativePortrait:{iconImgPath:'立绘/先攻/新显翼.png'}},
      {name:'常态',iconImgPath:'立绘/角色/常态.png',initiativePortrait:{iconImgPath:'立绘/先攻/常态.png'}}]};
  context.mergeOwnedPortraitForms(token,piece);
  assert.equal(token.portraitVariants.length,2);assert.equal(token.portraitVariants[0].initiativePortrait.iconImgPath,'立绘/先攻/新显翼.png');
  assert.equal(token.initiativePortrait.iconImgPath,'立绘/先攻/新默认.png');assert.equal(token.portraitVariant,0);assert.equal(token.ownedPieceRevision,4);
  assert.equal(token.hp,3);assert.deepEqual(token.conditions,['poisoned']);assert.equal(token.x,120);assert.equal(token.y,180);
  context.mergeOwnedPortraitForms(token,{...piece,revision:5,initiativePortrait:null,portraitVariants:piece.portraitVariants.map(v=>({...v,initiativePortrait:null}))});
  assert.equal(token.portraitVariants.length,2);assert.equal(token.initiativePortrait,null);assert.equal(token.portraitVariants[0].initiativePortrait,null);
  assert.equal(token.portraitVariant,0);assert.equal(token.hp,3);
});

test('player saveForms omits the DM-only default portrait while host saveForms explicitly saves or clears it',async()=>{
  for(const host of [false,true]){
    const token={ownedPieceId:'owned',ownerPlayerId:'player',iconImgPath:'立绘/角色/显翼.png',
      initiativePortrait:{iconImgPath:'立绘/先攻/默认.png'},portraitVariants:[{name:'显翼',iconImgPath:'立绘/角色/显翼.png',initiativePortrait:{iconImgPath:'立绘/先攻/显翼.png'}}]};
    const context={},requests=playerLibraryContext(context,{host,piece:{ownedPieceId:'owned',revision:3}});
    await context.PlayerLibrary.saveForms(token);
    const edit=requests[1];assert.equal(edit.body.op,'edit');assert.equal(edit.body.revision,7);assert.equal(edit.body.pieceRevision,3);
    assert.equal(edit.body.patch.portraitVariant,0);assert.equal(edit.body.patch.portraitVariants[0].name,'显翼');
    assert.equal(Object.hasOwn(edit.body.patch,'initiativePortrait'),host);
    if(host){assert.equal(edit.body.patch.initiativePortrait.iconImgPath,'立绘/先攻/默认.png');assert.equal(edit.headers['X-Sundoll-Local-Save'],'1');}
    else{assert.equal(edit.body.sessionToken,'player-session');assert.equal(Object.hasOwn(edit.headers,'X-Sundoll-Local-Save'),false);}
    await context.PlayerLibrary.saveForms({...token,initiativePortrait:null});
    assert.equal(Object.hasOwn(requests[3].body.patch,'initiativePortrait'),host);
    if(host)assert.equal(requests[3].body.patch.initiativePortrait,null);
  }
});
