const {readClientSource}=require('./client_sources.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=readClientSource(require('node:path').join(require('./project_paths.cjs').APP_ROOT, '主控台/玩家.html'),'utf8');
const source=html.slice(html.indexOf('  async function releaseOwnedPiece('),html.indexOf('  window.TravelBasket.configure('));
function setup({missing=false,offline=false,switchMap=false}={}){
 const token={id:'t1',ownedPieceId:'o1',x:900,y:600};
 const map={id:'m1',tokens:[]};let selected,drawn=0,moved=0,requests=0;
 const ctx={dispatchPendingPatch:async()=>true,sessionToken:'s',currentMap:map,state:{maps:[map]},playerMapOpen:()=>true,
 requestAction:async()=>{requests++;return {ok:true,data:{ok:true}};},
 fetch:async()=>{if(offline)throw Error('offline');return {ok:true,json:async()=>({maps:[{id:'m1',tokens:missing?[]:[token]}]})};},
 render:next=>{ctx.state=next;ctx.currentMap=switchMap?{id:'m2'}:next.maps[0];},
 renderTokens:()=>drawn++,openDetail:id=>selected=id,board:{getBoundingClientRect:()=>({width:1000,height:800})},
 view:{scale:1,ox:0,oy:0},applyView:()=>moved++};
 vm.createContext(ctx);vm.runInContext(source,ctx);return {ctx,run:()=>ctx.releaseOwnedPiece({ownedPieceId:'o1'}),stats:()=>({selected,drawn,moved,requests})};
}
test('successful release renders and focuses confirmed token without SSE',async()=>{
 const c=setup();await c.run();assert.deepEqual(c.stats(),{selected:'t1',drawn:1,moved:1,requests:1});
 assert.equal(c.ctx.view.ox,-400);assert.equal(c.ctx.view.oy,-200);
});
test('accepted action with missing token is not reported as successful placement',async()=>{
 const c=setup({missing:true});await assert.rejects(c.run(),/未找到棋子/);assert.equal(c.stats().moved,0);
});
test('failed state fetch explains acknowledgement without claiming visible success',async()=>{
 const c=setup({offline:true});await assert.rejects(c.run(),/地图同步失败/);assert.equal(c.stats().requests,1);
});
test('map changed during release does not focus wrong map',async()=>{
 const c=setup({switchMap:true});await assert.rejects(c.run(),/当前地图已切换/);assert.equal(c.stats().moved,0);
});

test('release waits for pending map edits and aborts on save failure',async()=>{
 const c=setup();let finish;c.ctx.dispatchPendingPatch=()=>new Promise(resolve=>finish=resolve);
 const result=c.run();assert.equal(c.stats().requests,0);finish(false);
 await assert.rejects(result,/等待角色修改保存/);assert.equal(c.stats().requests,0);
});
