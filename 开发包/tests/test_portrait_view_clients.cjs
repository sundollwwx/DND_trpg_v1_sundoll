const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const host=readClientSource('主控台/host/app.js'),player=readClientSource('主控台/player/player.js');
function extract(source,name,indent=''){
 const start=source.indexOf(`function ${name}(`),end=source.indexOf('\n'+indent+'}',start)+indent.length+2;
 assert.ok(start>=0&&end>start,name);return source.slice(start,end);
}
const view={scale:1.65,offsetX:-.2,offsetY:.15};
const tasks=[];
function context(extra={}){
 const calls=[];
 const c={SundollPortraitView:{normalize:v=>v&&typeof v==='object'?{scale:v.scale,offsetX:v.offsetX,offsetY:v.offsetY}:undefined,apply:(el,source,options)=>calls.push({el,source,options})},SundollRules:{normalizeInitiativePortrait:()=>undefined},SundollSize:{normalize:()=>({size:1})},SundollDownedPortrait:{sync:()=>false},canonicalPortraitPath:v=>v||null,normalizeSpellRange:v=>v||{},normalizeCondition:v=>v,uid:1,TYPE_META:{pc:{},npc:{}},calls,...extra};
 vm.createContext(c);vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),c);c.SundollPortraitView.apply=(el,source,options)=>calls.push({el,source,options});return c;
}
function plain(value){return JSON.parse(JSON.stringify(value));}
{
 const c=context();
 for(const fn of ['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex'])vm.runInContext(extract(host,fn),c);
 for(const fn of ['normalizePlayerPortraitVariants','portraitIdentity','currentPortraitVariantIndex'])vm.runInContext(extract(player,fn,'  '),c);
 const forms=[{name:'常态',iconImgPath:'shared.png',portraitView:{scale:1,offsetX:0,offsetY:0}},{name:'战斗',iconImgPath:'shared.png',portraitView:view}];
 const token={iconImgPath:'shared.png',portraitView:view,portraitVariant:0,portraitVariants:forms};
 assert.equal(c.currentTokenPortraitVariantIndex(token,forms),1,'host ignores an image-only stale form hint');
 assert.equal(c.currentPortraitVariantIndex(token),1,'player resolves same-image forms by display range');
 delete token.portraitView;
 assert.equal(c.currentTokenPortraitVariantIndex(token,forms),-1,'legacy framing is not explicit 100% framing');
 assert.equal(c.currentPortraitVariantIndex(token),-1);
}
{
 const forms=[{name:'常态',iconImgPath:'shared.png',portraitView:{scale:1,offsetX:0,offsetY:0}}];
 const token={iconImgPath:'shared.png',portraitView:view,portraitVariants:forms},saved=[];
 const c=context({playerPortraitManagerToken:()=>token,canActWithToken:()=>true,portraitIdentity:t=>t?.iconImgPath||'',playerPortraitVariants:()=>forms.map(v=>({...v})),prompt:()=> '新取景形态',commitPlayerPortraitVariants:(t,variants,index)=>saved.push({variants,index}),toast(){}});
 vm.runInContext(extract(player,'savePlayerCurrentPortraitVariant','  '),c);
 c.savePlayerCurrentPortraitVariant();
 assert.equal(saved[0].variants.length,2,'saving another range of the same image creates a separate form');
 assert.equal(saved[0].variants[0].name,'常态');assert.equal(saved[0].index,1);
}
{
 const c=context();
 for(const fn of ['normalizePortraitVariants','archiveLegacyGmNote','normalizeSheet','normalizeLibPreset','snapshotTokenPortrait','applyTokenPortrait','publicStreamToken'])vm.runInContext(extract(host,fn),c);
 c.portraitLibraryPresetForToken=()=>null;c.tokenHasPortrait=t=>!!t.iconImgPath;c.tokenPortraitVariants=()=>[];c.currentTokenPortraitVariantIndex=()=>-1;
 const normal={name:'常态',iconImgPath:'normal.png',portraitView:view},legacy={name:'倒地',iconImgPath:'down.png'};
 const token={name:'玩家',type:'pc',iconImgPath:normal.iconImgPath,portraitView:view,portraitVariants:[normal,legacy],portraitVariant:0};
 c.normalizeSheet(token);
 assert.deepEqual(plain(token.portraitView),view);assert.deepEqual(plain(token.portraitVariants[0].portraitView),view);
 token.portraitVariants[0].portraitView.scale=2;assert.equal(view.scale,1.65,'normalization isolates per-form views');
 const snapshot=c.snapshotTokenPortrait(token,'原姿态');assert.deepEqual(plain(snapshot.portraitView),view);
 assert.deepEqual(plain(c.publicStreamToken(token).portraitView),view,'player projection retains the current display range');
 c.applyTokenPortrait(token,legacy);assert.equal(Object.hasOwn(token,'portraitView'),false,'a legacy form clears the previous view');
 c.applyTokenPortrait(token,normal);assert.deepEqual(plain(token.portraitView),view);
 const preset=c.normalizeLibPreset({...token,portraitVariants:[normal,legacy]});
 assert.deepEqual(plain(c.normalizeLibPreset(JSON.parse(JSON.stringify(preset))).portraitView),view,'library JSON round trip');
 assert.equal(Object.hasOwn(c.normalizeLibPreset({portraitView:null}),'portraitView'),false);
}
{
 const c=context({hdEnabled:false,AVATAR_LOW_MAX:192,applyPortraitBackground(){}});
 vm.runInContext(extract(host,'applyAvatar'),c);vm.runInContext(extract(host,'applyTokenAvatar'),c);
 const el={style:{}};
 c.applyAvatar(el,null,null,null,'legacy.png',192,{portraitView:view});
 assert.deepEqual(plain(c.calls[0].source.portraitView),view);assert.equal(c.calls[0].options.legacyScale,1.163);
 c.applyTokenAvatar(el,{portraitView:view});assert.deepEqual(plain(c.calls.at(-1).source.portraitView),view);
}
{
 const c=context({assetUrl:t=>t.iconImgPath||t.iconImg,originalPortraitUrl:t=>t.iconImgPath||t.iconImg});
 for(const fn of ['normalizePlayerPortraitVariants','applyPlayerTokenPortrait','applyPlayerPortrait'])vm.runInContext(extract(player,fn,'  '),c);
 const forms=c.normalizePlayerPortraitVariants([{name:'战斗',iconImgPath:'fight.png',portraitView:view},{name:'旧常态',iconImgPath:'old.png'}]);
 const token={iconImgPath:'fight.png',portraitView:view};
 c.applyPlayerTokenPortrait(token,forms[1]);assert.equal(Object.hasOwn(token,'portraitView'),false);
 c.applyPlayerTokenPortrait(token,forms[0]);assert.deepEqual(plain(token.portraitView),view);
 const el={dataset:{},style:{}};assert.equal(c.applyPlayerPortrait(el,token),true);assert.deepEqual(plain(c.calls[0].source.portraitView),view);
 c.applyPlayerTokenPortrait(token,forms[1]);c.applyPlayerPortrait(el,token);assert.equal(c.calls[1].source.portraitView,undefined,'rendering clears a previous custom crop');
}
{
 const c=context();vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),c);
 const forms=[{name:'剑歌',iconImgPath:'song.png',portraitView:view},{name:'倒地',iconImgPath:'down.png',portraitView:{scale:1.1,offsetX:0,offsetY:0}}];
 const token={type:'pc',hp:0,iconImgPath:'song.png',portraitView:view,portraitVariants:forms};
 assert.equal(c.SundollDownedPortrait.sync(token),true);assert.equal(token.portraitView.scale,1.1);
 token.hp=4;assert.equal(c.SundollDownedPortrait.sync(token),true);assert.deepEqual(plain(token.portraitView),view);
 delete forms[1].portraitView;token.hp=0;c.SundollDownedPortrait.sync(token);assert.equal(Object.hasOwn(token,'portraitView'),false);
}
{
 const c=context();vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),c);
 for(const fn of ['normalizePortraitVariants','archiveLegacyGmNote','normalizeSheet'])vm.runInContext(extract(host,fn),c);
 const embedded='data:image/png;base64,'+'A'.repeat(16000),normal={scale:1,offsetX:0,offsetY:0},down={scale:2,offsetX:0,offsetY:.2};
 const forms=[{name:'同名形态',iconImg:embedded,portraitView:normal},{name:'同名形态',iconImg:embedded,portraitView:view},{name:'倒地',iconImg:embedded,portraitView:down}];
 const token={type:'pc',hp:0,hpMax:20,iconImg:embedded,portraitView:view,portraitVariant:1,portraitVariants:forms};
 assert.equal(c.SundollDownedPortrait.sync(token),true);
 const marker=token.portraitBeforeDowned;
 assert.ok(marker.length<1024,'embedded images use a compact marker that survives host snapshot limits');
 assert.match(JSON.parse(marker).image,/^iconImg:fnv64:[0-9a-f]{16}$/);
 const restored=JSON.parse(JSON.stringify(token));c.normalizeSheet(restored);
 assert.equal(restored.portraitBeforeDowned,marker,'save/load preserves the complete marker');
 restored.portraitVariants=[restored.portraitVariants[2],restored.portraitVariants[0],{...restored.portraitVariants[1],name:'重命名战斗形态'}];
 restored.hp=4;assert.equal(c.SundollDownedPortrait.sync(restored),true);
 assert.equal(restored.portraitVariant,2,'nondefault battle form survives reorder and rename despite duplicate original names');
 assert.deepEqual(plain(restored.portraitView),view);
 assert.equal(c.SundollDownedPortrait.memoryIdentity({iconImg:'a'}),'iconImg:fnv64:089be207b544f1e4');
 assert.equal(c.SundollDownedPortrait.memoryIdentity({iconImg:'木精灵🧝'}),'iconImg:fnv64:e1b1249d2054c5fb','Unicode fingerprints match the backend UTF-16LE protocol');
 assert.equal(c.SundollDownedPortrait.memoryIdentity({iconImgId:'cached-image',iconImg:embedded}),'iconImgId:cached-image','cached identities remain short without hashing embedded previews');
}
{
 const draw=[],canvases=[];
 const c=context({PLAYER_PORTRAIT_TARGET_BYTES:1000,dataUrlBytes:()=>10,document:{createElement:()=>{const canvas={getContext:()=>({drawImage:(...args)=>draw.push(args)}),toDataURL:()=> 'data:image/webp;base64,AA=='};canvases.push(canvas);return canvas;}},URL:{revokeObjectURL(){}}});
 vm.runInContext(extract(player,'compressPlayerDraftPortrait','  ').replace('function compressPlayerDraftPortrait','async function compressPlayerDraftPortrait'),c);
 const image={naturalWidth:1024,naturalHeight:2048};
 tasks.push(c.compressPlayerDraftPortrait(null,{src:'data:source',image}).then(data=>{
  assert.equal(canvases[0].width,256);assert.equal(canvases[0].height,512);
  assert.deepEqual(draw[0].slice(1),[0,0,1024,2048,0,0,256,512],'full original image survives compression');
  assert.ok(data.startsWith('data:image/webp'));
 }));
}

{
 const requests=[],token={id:'t-view',name:'玩家',iconImgPath:'fight.png',portraitView:view,portraitVariants:[{name:'战斗',iconImgPath:'fight.png',portraitView:view}]};
 const nextView={scale:2,offsetX:0,offsetY:-.1};let editable=true,opened=0;
 const c=context({playerPortraitManagerToken:()=>token,canActWithToken:()=>editable,tokenById:()=>token,portraitIdentity:t=>t?.iconImgPath||'',originalPortraitUrl:t=>t.iconImgPath,playerPortraitVariants:t=>JSON.parse(JSON.stringify(t.portraitVariants)),currentPortraitVariantIndex:()=>0,sendPatch:(id,patch,before)=>requests.push({id,patch,before}),renderTokens(){},openDetail(){},renderPlayerPortraitManager(){},toast(){},currentMap:{}});
 vm.runInContext(extract(player,'normalizePlayerPortraitVariants','  '),c);
 vm.runInContext(extract(player,'editPlayerTokenPortraitView','  ').replace('function editPlayerTokenPortraitView','async function editPlayerTokenPortraitView'),c);
 c.SundollPortraitView.edit=async()=>{opened++;return nextView;};
 tasks.push((async()=>{
  await c.editPlayerTokenPortraitView(0);assert.equal(requests.length,1);
  assert.deepEqual(plain(requests[0].patch.portraitView),nextView);assert.deepEqual(plain(requests[0].patch.portraitVariants[0].portraitView),nextView);
  assert.deepEqual(plain(requests[0].before.portraitView),view);
  editable=false;await c.editPlayerTokenPortraitView(0);assert.equal(opened,1,'locked turns cannot edit display range');assert.equal(requests.length,1);
 })());
}
{
 const normal={scale:1,offsetX:0,offsetY:0},next={scale:2,offsetX:.25,offsetY:0},requests=[];
 const token={id:'t-same',iconImgPath:'shared.png',portraitView:normal,portraitVariant:0,portraitVariants:[{name:'常态',iconImgPath:'shared.png',portraitView:normal},{name:'倒地',iconImgPath:'shared.png',portraitView:view}]};
 const c=context({playerPortraitManagerToken:()=>token,canActWithToken:()=>true,tokenById:()=>token,portraitIdentity:t=>t?.iconImgPath||'',originalPortraitUrl:t=>t.iconImgPath,playerPortraitVariants:t=>plain(t.portraitVariants),sendPatch:(id,patch)=>requests.push(patch),renderTokens(){},openDetail(){},renderPlayerPortraitManager(){},toast(){},currentMap:{}});
 vm.runInContext(extract(player,'currentPortraitVariantIndex','  '),c);
 vm.runInContext(extract(player,'normalizePlayerPortraitVariants','  '),c);
 vm.runInContext(extract(player,'editPlayerTokenPortraitView','  ').replace('function editPlayerTokenPortraitView','async function editPlayerTokenPortraitView'),c);
 c.SundollPortraitView.edit=async()=>next;
 tasks.push((async()=>{
  await c.editPlayerTokenPortraitView(1);
  assert.equal(requests.length,1);assert.equal(Object.hasOwn(requests[0],'portraitView'),false,'editing an inactive same-image form does not alter the current range');
  assert.deepEqual(plain(token.portraitView),normal);assert.deepEqual(plain(token.portraitVariants[1].portraitView),next);
 })());
}
{
 const normal={scale:1,offsetX:0,offsetY:0},next={scale:2,offsetX:.25,offsetY:0};
 const existing={id:'l1',iconImgPath:'shared.png',portraitView:normal,portraitVariants:[{name:'常态',iconImgPath:'shared.png',portraitView:normal},{name:'倒地',iconImgPath:'shared.png',portraitView:view}]};
 const values={'#lib-name':'角色','#lib-type':'pc','#lib-icon':'','#lib-size':'medium','#lib-hp':'20','#lib-ac':'15'};
 const c=context({state:{library:[existing]},libEditorId:'l1',libAvatar:{iconImgPath:'shared.png',portraitView:next},$:key=>({value:values[key]}),readLibCatSelects:()=>'',closeLibEditor(){},saveLibrary(){},scheduleAutosave(){},toast(){}});
 for(const fn of ['portraitAssetIdentity','currentTokenPortraitVariantIndex','saveLibEditor'])vm.runInContext(extract(host,fn),c);
 c.saveLibEditor();
 assert.deepEqual(plain(c.state.library[0].portraitVariants[0].portraitView),next);
 assert.deepEqual(plain(c.state.library[0].portraitVariants[1].portraitView),view,'host library edits keep the inactive same-image form independent');
}
{
 const normal={scale:1,offsetX:0,offsetY:0},next={scale:2,offsetX:.25,offsetY:0},handlers={};
 const forms=[{name:'常态',iconImgPath:'shared.png',portraitView:normal},{name:'倒地',iconImgPath:'shared.png',portraitView:view}],token={id:'t-host',iconImgPath:'shared.png',portraitView:normal};
 const c=context({portraitManagerTokenId:token.id,findToken:()=>token,tokenHasPortrait:()=>true,tokenPortraitVariants:t=>t.portraitVariants||forms,editHostPortraitView:async()=>next,$:key=>({addEventListener:(type,handler)=>handlers[key]=handler}),renderTokens(){},updateDetail(){},renderPortraitVariantManager(){},scheduleAutosave(){},toast(){}});
 for(const fn of ['normalizePortraitVariants','editableTokenPortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex'])vm.runInContext(extract(host,fn),c);
 const start=host.indexOf("  $('#btn-portrait-view').addEventListener('click', async () => {"),end=host.indexOf("  $('#btn-lib-portrait-view').addEventListener",start);
 assert.ok(start>=0&&end>start);vm.runInContext(host.slice(start,end),c);
 tasks.push((async()=>{
  await handlers['#btn-portrait-view']();
  assert.deepEqual(plain(token.portraitVariants[0].portraitView),next,'host resolves the current form before replacing its old display range');
  assert.deepEqual(plain(token.portraitVariants[1].portraitView),view);
 })());
}
{
 const c=context({playerPortraitPending:false,playerDraftPortrait:'old-image',playerDraftPortraitView:view,PLAYER_PORTRAIT_SOURCE_LIMIT:12*1024*1024,renderPlayerDraftPortrait(){},updatePlayerPlaceUi(){},toast(){},URL:{revokeObjectURL(){}}});
 vm.runInContext(extract(player,'choosePlayerDraftPortrait','  ').replace('function choosePlayerDraftPortrait','async function choosePlayerDraftPortrait'),c);
 c.SundollPortraitView.prepareFile=async()=>({src:'new-image',image:{naturalWidth:100,naturalHeight:200}});c.SundollPortraitView.edit=async()=>null;c.compressPlayerDraftPortrait=()=>{throw Error('cancelled uploads must not be compressed');};
 tasks.push((async()=>{await c.choosePlayerDraftPortrait({type:'image/png',size:20});assert.equal(c.playerDraftPortrait,'old-image');assert.deepEqual(plain(c.playerDraftPortraitView),view);assert.equal(c.playerPortraitPending,false);})());
}
{
 const library=readClientSource('asset/棋子库/棋子库.html');
 for(const client of ['host','player','library'])tasks.push((async()=>{
  const original='立绘/rect.png',cached='missing-cache.webp',probes=new Map(),calls=[];
  class PortraitImage {
   set src(url){this.naturalWidth=1024;this.naturalHeight=2048;queueMicrotask(()=>url===cached?this.onerror?.():this.onload?.());}
  }
  const c=context({Image:PortraitImage,hdEnabled:false,AVATAR_LOW_MAX:192,portraitLodProbes:probes,portraitProbes:probes,
   portraitAssetUrl:path=>path,portraitLodAssetUrl:()=>cached,freshPortraitUrl:path=>path,portraitLodUrl:()=>cached,
   assetUrl:()=>cached,originalPortraitUrl:()=>original});
  vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),c);
  const realApply=c.SundollPortraitView.apply;
  c.SundollPortraitView.apply=(el,source,options)=>{calls.push({source,options});realApply(el,source,options);};
  const el={tagName:'DIV',clientWidth:40,clientHeight:40,dataset:{},style:{},isConnected:true},token={iconImgPath:original,portraitView:view};
  if(client==='host') {
   for(const fn of ['setAvatarBackground','probePortraitLod','applyPortraitBackground','applyAvatar'])vm.runInContext(extract(host,fn),c);
   c.applyAvatar(el,null,null,null,original,192,token);
  } else if(client==='player') {
   vm.runInContext(extract(player,'applyPlayerPortrait','  '),c);c.applyPlayerPortrait(el,token);
  } else {
   for(const fn of ['applyPortraitBackground','applyAvatar'])vm.runInContext(extract(library,fn),c);
   c.applyAvatar(el,null,null,null,original,token);
  }
  await new Promise(setImmediate);
  assert.equal(el.style.backgroundImage,'url("'+original+'")',client+' falls back to the full original');
  const expected=c.SundollPortraitView.geometry(40,40,1024,2048,view);
  assert.equal(el.style.backgroundSize,expected.width+'px '+expected.height+'px',client+' recomputes framing from the nonsquare original dimensions');
  assert.equal(el.style.backgroundPosition,expected.left+'px '+expected.top+'px',client+' retains the requested offset after cache failure');
  assert.deepEqual(plain(calls.at(-1).source.portraitView),view);assert.equal(calls.at(-1).options.legacyScale,1.163);
  // A known failed cache must take the same path without waiting for a fresh probe.
  el.style.backgroundImage='';el.style.backgroundSize='';
  if(client==='host')c.applyAvatar(el,null,null,null,original,192,token);
  else if(client==='player')c.applyPlayerPortrait(el,token);
  else c.applyAvatar(el,null,null,null,original,token);
  await new Promise(setImmediate);
  assert.equal(el.style.backgroundSize,expected.width+'px '+expected.height+'px',client+' known-failure path keeps the original aspect ratio');
 })());
}
Promise.all(tasks).then(()=>console.log('Portrait view save, projection, per-form reset, downed restore, render handoff, full-image upload, cancellation, cache fallback and turn-permission checks passed.')).catch(error=>{console.error(error);process.exitCode=1;});
