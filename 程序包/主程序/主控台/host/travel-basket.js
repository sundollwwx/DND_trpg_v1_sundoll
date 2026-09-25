/* Host adapter: stored player pieces share the existing parked state; NPCs stay private. */
function travelTokenRow(token) {
  return {id:token.id,ownedPieceId:token.ownedPieceId,name:token.name,icon:token.icon,image:token.iconImgPath?portraitLodAssetUrl(token.iconImgPath,128):(token.iconImg||'')};
}
function collectTravelToken(row) {
  const map=activeMap(),token=map?.tokens.find(t=>t.id===row.id);
  if(!token)throw new Error('请先选择当前地图上的棋子');
  if(!token.ownedPieceId){
    state.travelBasketTokens ||= [];
    if(state.travelBasketTokens.some(t=>t.id===token.id))throw new Error('篮子里已有这枚棋子，请检查存档');
    state.travelBasketTokens.push({...JSON.parse(JSON.stringify(token)),mountId:null});
  }
  deleteToken(token.id,true,true);
}
function releaseTravelToken(row,position) {
  const map=activeMap();if(!map)throw new Error('请先打开目标地图');
  const source=row.ownedPieceId?state.parkedOwnedPieces?.[row.ownedPieceId]:(state.travelBasketTokens||[]).find(t=>t.id===row.id);
  if(!source||(row.ownedPieceId&&source.travelBasketStored!==true))throw new Error('这枚棋子已经离开篮子');
  if(state.maps.some(m=>m.tokens.some(t=>t.id===source.id||(source.ownedPieceId&&t.ownedPieceId===source.ownedPieceId))))throw new Error('地图上已有这枚棋子，请刷新核对');
  const token=normalizeSheet(JSON.parse(JSON.stringify(source)));
  const rect=board.getBoundingClientRect(),grid=map.gridSize||50;
  const center=position||{x:(rect.width/2-map.cam.x)/map.cam.zoom,y:(rect.height/2-map.cam.y)/map.cam.zoom};
  let point;
  // Spread arriving pieces into free nearby cells, respecting tiny and larger sizes.
  const offsets=[];for(let x=-7;x<=7;x++)for(let y=-7;y<=7;y++)offsets.push([x,y]);
  offsets.sort((a,b)=>a[0]**2+a[1]**2-b[0]**2-b[1]**2);
  for(const [dx,dy] of offsets){
    const candidate=SundollSize.point(map,token,center.x+dx*grid,center.y+dy*grid,state.snap);
    if(!map.tokens.some(t=>Math.abs(t.x-candidate.x)<((Number(t.size)||1)+(Number(token.size)||1))*grid/2&&Math.abs(t.y-candidate.y)<((Number(t.size)||1)+(Number(token.size)||1))*grid/2)){point=candidate;break;}
  }
  if(!point)throw new Error('视野附近没有空位，请移动视野后重试');
  Object.assign(token,point,{mountId:null});map.tokens.push(token);
  if(row.ownedPieceId)delete state.parkedOwnedPieces[row.ownedPieceId];
  else state.travelBasketTokens=state.travelBasketTokens.filter(t=>t.id!==row.id);
  state.selectedId=token.id;renderTokens();updateDetail();renderEncounter();scheduleAutosave();
}
window.TravelBasket.configure({
  board,mapPoint:(x,y)=>{const m=activeMap(),r=board.getBoundingClientRect();return m?{x:(x-r.left-m.cam.x)/m.cam.zoom,y:(y-r.top-m.cam.y)/m.cam.zoom}:null;},
  open:()=>state.travelBasketOpen===true,
  setOpen:value=>{state.travelBasketOpen=value;scheduleAutosave();},
  skin:()=>state.travelBasketSkin||'travel-wagon',
  setSkin:value=>{state.travelBasketSkin=value;scheduleAutosave();},
  local:true,parent:document.getElementById('board-wrap'),
  key:()=>[state.campaignId,state.activeMapId].join('|'),
  list:async()=>({stored:[...Object.values(state.parkedOwnedPieces||{}).filter(t=>t.travelBasketStored===true),...(state.travelBasketTokens||[])].map(travelTokenRow),available:(activeMap()?.tokens||[]).map(travelTokenRow),canPlace:Boolean(activeMap())}),
  collect:collectTravelToken,release:releaseTravelToken
});

// 弹幕与旅行篮子共用左下角入口，输入框在按钮上方展开。
{
  const basket=document.querySelector('#board-wrap > .travel-basket');
  const toggle=document.getElementById('host-danmaku');
  const controls=document.querySelector('#board > .danmaku-controls');
  if(basket&&toggle&&controls){
    const measure=document.createElement('button');
    measure.id='host-quick-measure';measure.type='button';measure.className='travel-toggle host-map-shortcut';measure.textContent='📏 测距';measure.setAttribute('aria-pressed','false');
    measure.addEventListener('click',()=>document.getElementById('btn-host-measure').click());
    const reaction=document.createElement('button');
    reaction.id='host-quick-reaction';reaction.type='button';reaction.className='travel-toggle host-map-shortcut';reaction.textContent='😊 表情';reaction.setAttribute('aria-pressed','false');
    reaction.addEventListener('click',toggleMapReactionPalette);
    basket.append(measure,reaction,toggle,controls);
    syncBoardTools();syncMapReactionUi();
    toggle.hidden=false;
    controls.classList.add('danmaku-at-basket');
  }
}
