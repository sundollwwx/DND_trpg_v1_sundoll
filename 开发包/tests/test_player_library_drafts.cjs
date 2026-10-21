const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, '主控台/shared/player-library.js'),'utf8');
class Element {
 checkValidity(){return Number.isInteger(Number(this.value)) && Number(this.value)>=Number(this.min) && Number(this.value)<=Number(this.max);}
 constructor(tag,text=''){this.tag=tag;this.tagName=tag.toUpperCase();this.textContent=text;this.children=[];this.dataset={};this.attributes={};this.files=[];this.value='';this.events={};this.style={};}
 append(...nodes){for(const n of nodes)n.parentElement=this;this.children.push(...nodes);}replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 get nextElementSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1];}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(name,fn){this.events[name]=fn;}showModal(){this.open=true;}close(){this.open=false;this.events.close?.();}
}
function setup(options={}){
 const body=new Element('body');let lib={revision:1,pieces:['甲','乙'].map((name,i)=>({name,ownedPieceId:String(i),revision:1}))};let pending,release,fail=false,denied=false;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const fixtureImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOQAAAABJRU5ErkJggg==';
 const context={window:{addEventListener(){}},document:{body,head:new Element('head'),createElement:t=>new Element(t)},location:{protocol:'http:'},confirm:()=>true,Option:Element,
  FileReader:class{readAsDataURL(){this.result=fixtureImage;queueMicrotask(()=>this.onload?.());}},
  Image:class{constructor(){this.naturalWidth=this.naturalHeight=1;}set src(value){this.currentSrc=value;queueMicrotask(()=>this.onload?.());}},fetch:async(url,args)=>{
  if(fail)throw new Error('network unavailable');
  const data=JSON.parse(args.body);if(data.op==='get'&&options.beforeGet)await options.beforeGet();if(denied&&data.op==='get')return {ok:false,status:403,json:async()=>({error:'需要玩家凭证'})};if(data.op==='edit'){
   if(pending)await new Promise(r=>release=r);
   const p=lib.pieces.find(p=>p.ownedPieceId===data.ownedPieceId);
   if(p.revision!==data.pieceRevision)return {ok:false,status:409,json:async()=>({error:'conflict'})};
   Object.assign(p,data.patch);p.revision++;lib.revision++;
  }
  return {ok:true,status:200,json:async()=>({ok:true,players:[{playerId:'p',name:'玩家',accountId:options.room?'a':undefined,characters:lib.pieces.map(p=>({characterId:p.ownedPieceId,name:p.name}))}],profile:{playerId:'p',name:'玩家'},library:clone(lib),deployments:options.deployments,campaignId:'c1'})};
 }};if(options.room)context.window.SundollRoom={id:'room'};vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, '主控台/shared/portrait-view.js'),'utf8'),context);context.SundollPortraitView=context.window.SundollPortraitView;
 vm.runInContext(source,context);context.window.PlayerLibrary.configure({session:()=> 'test',...options});
 function all(n=body){return [n,...n.children.flatMap(all)];}
 return {context,ui:context.window.PlayerLibrary,all,button:text=>all().find(n=>n.tag==='button'&&n.textContent===text),buttons:text=>all().filter(n=>n.tag==='button'&&n.textContent===text),names:()=>all().filter(n=>n.tag==='input'&&!n.type),lib,deny(){denied=true;},fail(){fail=true;},pause(){pending=true;},release(){pending=false;release();}};
}
function type(input,value){input.value=value;input.oninput();}
test('editing an inactive same-image collection form preserves the default view',async()=>{
 const c=setup(),normal={scale:1,offsetX:0,offsetY:0},down={scale:1.5,offsetX:.1,offsetY:0},next={scale:2,offsetX:.2,offsetY:-.1};
 Object.assign(c.lib.pieces[0],{iconImgPath:'shared.png',portraitView:normal,portraitVariant:0,portraitVariants:[{name:'常态',iconImgPath:'shared.png',portraitView:normal},{name:'倒地',iconImgPath:'shared.png',portraitView:down}]});
 c.context.SundollPortraitView.edit=async()=>next;
 await c.ui.open();
 assert.ok(c.button('默认 · 常态'));
 assert.ok(c.button('倒地'));assert.equal(c.button('默认 · 倒地'),undefined);
 await c.button('调整「倒地」显示范围').onclick();
 assert.deepEqual(c.lib.pieces[0].portraitView,normal);
 assert.deepEqual(c.lib.pieces[0].portraitVariants[0].portraitView,normal);
 assert.deepEqual(c.lib.pieces[0].portraitVariants[1].portraitView,next);
});
test('host edited stats update owned map and parked tokens without resetting runtime',()=>{
 const bootstrap=fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, '主控台/host/bootstrap.js'),'utf8');
 const callback=bootstrap.match(/onPieceEdited:(\(playerId, ownedPieceId, patch\)=>\{[\s\S]*?\n  \}),/)[1];
 const live={ownerPlayerId:'p',ownedPieceId:'0',hp:7,hpMax:10,conditions:['poisoned']};
 const unrelated={ownerPlayerId:'other',ownedPieceId:'0',ac:10};
 const parked={ownerPlayerId:'p',ownedPieceId:'0',hp:4};
 let saves=0,dirty=0;
 const context={state:{maps:[{tokens:[live,unrelated]}],parkedOwnedPieces:{'0':parked}},renderTokens(){},updateDetail(){},renderEncounter(){},scheduleAutosave(){dirty++;},saveNow(){saves++;}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);const edit=vm.runInContext('('+callback+')',context);
 edit('p','0',{hpMax:35,ac:16});
 assert.equal(live.hpMax,35);assert.equal(live.hp,7);assert.deepEqual(live.conditions,['poisoned']);
 assert.equal(parked.ac,16);assert.equal(parked.hp,4);assert.equal(unrelated.ac,10);
 assert.equal(saves,1);assert.equal(dirty,1);
});
test('host stat draft survives refresh and syncs only submitted changes',async()=>{
 let synced;
 const c=setup({host:true,onPieceEdited:(pid,oid,patch)=>{synced={pid,oid,patch};}});
 await c.ui.open({playerId:'p'}); await c.button('角色名册').onclick();
 const numbers=()=>c.all().filter(n=>n.tag==='input'&&n.type==='number');
 type(numbers()[0],'35'); type(numbers()[1],'16');
 await c.button('刷新').onclick(); assert.equal(numbers()[0].value,'35');
 await c.buttons('保存收藏资料')[0].onclick();
 assert.equal(c.lib.pieces[0].hpMax,35);assert.equal(c.lib.pieces[0].ac,16);
 assert.equal(synced.oid,'0');assert.equal(synced.patch.hpMax,35);
 type(numbers()[0],'0');await c.buttons('保存收藏资料')[0].onclick();
 assert.equal(c.lib.pieces[0].hpMax,35);
});
test('saving one card preserves another card draft through refresh',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'甲修改');type(c.names()[1],'乙草稿');await c.buttons('保存收藏资料')[0].onclick();
 assert.deepEqual(c.names().map(n=>n.value),['甲修改','乙草稿']);assert.equal(c.lib.pieces[1].name,'乙');
 await c.button('刷新').onclick();assert.equal(c.names()[1].value,'乙草稿');
});
test('typing while save is pending preserves the newer edit',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'提交内容');c.pause();const save=c.buttons('保存收藏资料')[0].onclick();
 type(c.names()[0],'提交后继续输入');c.release();await save;assert.equal(c.names()[0].value,'提交后继续输入');assert.equal(c.lib.pieces[0].name,'提交内容');
 await c.buttons('保存收藏资料')[0].onclick();assert.equal(c.lib.pieces[0].name,'提交后继续输入');
});
test('conflict rebase retains edits typed after rendering conflict',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'旧草稿');c.lib.pieces[0].revision++;c.lib.pieces[0].name='其他窗口';
 await c.button('刷新').onclick();type(c.names()[0],'冲突后继续编辑');
 await c.button('基于最新版本继续编辑').onclick();await c.buttons('保存收藏资料')[0].onclick();
 assert.equal(c.lib.pieces[0].name,'冲突后继续编辑');assert.equal(c.lib.pieces[0].revision,3);
});
test('player collection exposes release action when configured',async()=>{
 let released='';const c=setup({place:async piece=>{released=piece.ownedPieceId;},placeLabel:'释放到当前地图'});await c.ui.open();
 const buttons=c.buttons('释放到当前地图');assert.equal(buttons.length,2);await buttons[0].onclick();assert.equal(released,'0');
});

test('typing while a chosen image loads then cancelling cannot save that unconfirmed image',async()=>{
 const c=setup();await c.ui.open();
 const input=c.all().find(n=>n.type==='file');input.files=[{name:'cancelled.png',size:10,type:'image/png'}];
 const preparing=input.onchange();type(c.names()[0],'只保存文字');
 await new Promise(setImmediate);await c.button('取消').onclick();await preparing;
 await c.buttons('保存收藏资料')[0].onclick();
 assert.equal(c.lib.pieces[0].name,'只保存文字');
 assert.equal(Object.hasOwn(c.lib.pieces[0],'iconImg'),false);
 assert.equal(Object.hasOwn(c.lib.pieces[0],'portraitView'),false);
});

test('reverting to original text during save preserves newer intent',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'提交内容');c.pause();const save=c.buttons('保存收藏资料')[0].onclick();
 type(c.names()[0],'甲');c.release();await save;assert.equal(c.names()[0].value,'甲');assert.equal(c.lib.pieces[0].name,'提交内容');
 await c.buttons('保存收藏资料')[0].onclick();assert.equal(c.lib.pieces[0].name,'甲');
});
test('dirty collection cannot release and reverting edits is a no-op save',async()=>{
 let count=0;const c=setup({place:async()=>count++});await c.ui.open();
 type(c.names()[0],'草稿');await c.buttons('释放到当前地图')[0].onclick();assert.equal(count,0);
 type(c.names()[0],'甲');await c.buttons('保存收藏资料')[0].onclick();assert.equal(c.lib.revision,1);
 assert.equal(c.buttons('放弃未保存修改')[0].disabled,true);
 await c.buttons('释放到当前地图')[0].onclick();assert.equal(count,1);
});
test('search retains drafts and query across refresh',async()=>{
 const c=setup();await c.ui.open();type(c.names()[1],'乙草稿');
 const search=c.all().find(n=>n.type==='search');type(search,'甲');
 assert.deepEqual(c.all().filter(n=>n.tag==='article').map(n=>n.hidden),[false,true]);
 await c.button('刷新').onclick();assert.equal(c.all().find(n=>n.type==='search').value,'甲');
 type(c.all().find(n=>n.type==='search'),'');assert.equal(c.names()[1].value,'乙草稿');
});
test('failed refresh retains editable content and draft',async()=>{
 const c=setup();await c.ui.open();const original=c.names()[0];type(original,'保留草稿');c.fail();await c.button('刷新').onclick();
 assert.equal(c.names()[0],original);assert.equal(original.value,'保留草稿');
});
test('discard restores values and disables itself',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'草稿');await c.buttons('放弃未保存修改')[0].onclick();
 assert.equal(c.names()[0].value,'甲');assert.equal(c.buttons('放弃未保存修改')[0].disabled,true);
});
test('repeated release clicks during a request only release once',async()=>{
 let count=0,done;const c=setup({place:async()=>{count++;await new Promise(r=>done=r);}});await c.ui.open();
 const b=c.buttons('释放到当前地图')[0];const first=b.onclick();await b.onclick();await new Promise(setImmediate);assert.equal(count,1);done();await first;
});

test('refresh during save keeps current editor until save completes',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'提交');const original=c.names()[0];
 c.pause();const save=c.buttons('保存收藏资料')[0].onclick();await c.button('刷新').onclick();
 assert.equal(c.names()[0],original);type(original,'继续输入');c.release();await save;assert.equal(c.names()[0].value,'继续输入');
});
test('conflicting save automatically presents latest data and preserves draft',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'我的草稿');c.lib.pieces[0].revision++;c.lib.pieces[0].name='远程修改';
 await c.buttons('保存收藏资料')[0].onclick();assert.equal(c.names()[0].value,'我的草稿');
 assert.ok(c.button('基于最新版本继续编辑'));assert.equal(c.lib.pieces[0].name,'远程修改');
});
test('search matches unsaved names and clear restores all cards',async()=>{
 const c=setup();await c.ui.open();type(c.names()[1],'草稿游侠');
 type(c.all().find(n=>n.type==='search'),'游侠');
 assert.deepEqual(c.all().filter(n=>n.tag==='article').map(n=>n.hidden),[true,false]);
 await c.button('清空搜索').onclick();assert.deepEqual(c.all().filter(n=>n.tag==='article').map(n=>n.hidden),[false,false]);
});
test('portrait cancellation retains text and allows choosing another image',async()=>{
 const c=setup();await c.ui.open();type(c.names()[0],'新名字');const input=c.all().find(n=>n.type==='file');
 const file={name:'one.png',size:10,type:'image/png'};
 async function choose(){input.files=[file];const preparing=input.onchange();await new Promise(setImmediate);assert.ok(c.all().some(n=>n.className==='pv-dialog'&&n.open));await c.button('使用这个范围').onclick();await preparing;}
 await choose();
 assert.equal(c.buttons('取消更换立绘')[0].disabled,false);
 // The browser clears FileList when the input value is cleared.
 input.files=[];await c.buttons('取消更换立绘')[0].onclick();assert.equal(c.names()[0].value,'新名字');
 assert.equal(c.buttons('取消更换立绘')[0].disabled,true);
 await choose();assert.equal(c.buttons('取消更换立绘')[0].disabled,false);
});
test('release error is displayed beside the affected collection',async()=>{
 const c=setup({place:async()=>{throw new Error('地图不可用');}});await c.ui.open();
 await c.buttons('释放到当前地图')[0].onclick();
 assert.ok(c.all().some(n=>n.className==='pl-card-feedback'&&n.textContent==='地图不可用'));
});

test('successful placement returns to map by default',async()=>{
 const c=setup({place:async()=>{}});await c.ui.open();await c.buttons('释放到当前地图')[0].onclick();
 assert.equal(c.all().find(n=>n.tag==='dialog').open,false);
});
test('batch placement can keep library open and remembers preference',async()=>{
 const c=setup({place:async()=>{}});await c.ui.open();const checkbox=c.all().find(n=>n.type==='checkbox');checkbox.checked=false;checkbox.onchange();
 await c.buttons('释放到当前地图')[0].onclick();assert.equal(c.all().find(n=>n.tag==='dialog').open,true);
 await c.button('刷新').onclick();assert.equal(c.all().find(n=>n.type==='checkbox').checked,false);
});
test('unavailable destination gives a local reason without placing or closing',async()=>{
 let count=0;const c=setup({place:async()=>count++,describePlacement:()=>({blocked:true,hint:'等待主控开放地图'})});await c.ui.open();
 assert.equal(c.buttons('释放到当前地图')[0].disabled,true);
 await c.buttons('释放到当前地图')[0].onclick();assert.equal(count,0);assert.equal(c.all().find(n=>n.tag==='dialog').open,true);
 assert.ok(c.all().some(n=>n.className==='pl-panel-copy'&&n.textContent==='等待主控开放地图'));
});
test('placement labels reflect context and recheck availability on click',async()=>{
 let blocked=false,count=0;const c=setup({mapName:()=> '龙眠寺',place:async()=>count++,describePlacement:()=>({label:'选中地图中的棋子',blocked,hint:'地图已关闭'})});await c.ui.open();
 assert.ok(c.all().some(n=>n.textContent==='当前地图：龙眠寺'));blocked=true;await c.buttons('选中地图中的棋子')[0].onclick();assert.equal(count,0);
});
test('linking old tokens lives in a collapsed section',async()=>{
 const c=setup({bind:async()=>true});await c.ui.open();
 const sections=c.all().filter(n=>n.tag==='details'&&n.children.some(x=>x.textContent==='关联已有棋子'));
 assert.equal(sections.length,2);assert.ok(sections.every(n=>!n.open));
});

test('expired access hides previous collection and offers credential login',async()=>{
 let prompted=false;const c=setup({signIn:()=>{prompted=true;}});await c.ui.open();c.deny();await c.button('刷新').onclick();
 assert.equal(c.names().length,0);assert.ok(c.button('使用名字登录'));
 await c.button('使用名字登录').onclick();assert.equal(prompted,true);assert.equal(c.all().find(n=>n.tag==='dialog').open,false);
});

test('targeted opening brings the requested collection first and expands it',async()=>{
 const c=setup();await c.ui.open({ownedPieceId:'1'});
 assert.equal(c.names()[0].value,'乙');
 const editors=c.all().filter(n=>n.tag==='details'&&n.className==='pl-editor'&&n.children.some(x=>x.textContent.startsWith('编辑收藏资料')));
 assert.equal(editors[0].open,true);assert.equal(editors[1].open,false);
});
test('irrelevant cancellation and search controls stay hidden',async()=>{
 const c=setup();await c.ui.open();
 assert.equal(c.button('清空搜索').hidden,true);assert.equal(c.buttons('取消更换立绘')[0].hidden,true);assert.equal(c.buttons('放弃未保存修改')[0].hidden,true);
 type(c.names()[0],'草稿');assert.equal(c.buttons('放弃未保存修改')[0].hidden,false);
 type(c.all().find(n=>n.type==='search'),'甲');assert.equal(c.button('清空搜索').hidden,false);
});
test('map switch while retrieving collection prevents placement to a different destination',async()=>{
 let map='a',reads=0,count=0;
 const c=setup({mapId:()=>map,describePlacement:()=>{if(++reads===3)map='b';return {};},place:async()=>count++});
 // two cards read context during render; the action rechecks after capturing destination.
 await c.ui.open();await c.buttons('释放到当前地图')[0].onclick();assert.equal(count,0);
 assert.ok(c.all().some(n=>n.textContent==='地图已切换，请核对目标地图后重试'));
});
test('placement locks linking and refresh for the same collection',async()=>{
 let release,links=0;const c=setup({place:async()=>new Promise(r=>release=r),bind:async()=>{links++;}});
 await c.ui.open();const original=c.names()[0];const placement=c.buttons('释放到当前地图')[0].onclick();
 await new Promise(setImmediate);await c.buttons('关联地图上选中的旧棋子')[0].onclick();await c.button('刷新').onclick();
 assert.equal(links,0);assert.equal(c.names()[0],original);release();await placement;
});
test('batch placement updates the contextual button after success',async()=>{
 let placed=false;const c=setup({place:async()=>{placed=true;},describePlacement:()=>({label:placed?'选中地图中的棋子':'释放到当前地图'})});
 await c.ui.open();const check=c.all().find(n=>n.type==='checkbox');check.checked=false;check.onchange();
 await c.buttons('释放到当前地图')[0].onclick();assert.ok(c.button('选中地图中的棋子'));
});

test('completed old placement cannot close a reopened library',async()=>{
 let finish;const c=setup({place:async()=>new Promise(r=>finish=r)});await c.ui.open();
 const placement=c.buttons('释放到当前地图')[0].onclick();await new Promise(setImmediate);
 await c.button('关闭').onclick();await c.ui.open();finish();await placement;
 assert.equal(c.all().find(n=>n.tag==='dialog').open,true);
});
test('link request rejects a changed selected map token',async()=>{
 let target='old',count=0,reads=0;
 const c=setup({beforeGet:()=>{if(++reads===2)target='new';},bindingTarget:()=>target,bind:async()=>count++});
 await c.ui.open();await c.buttons('关联地图上选中的旧棋子')[0].onclick();assert.equal(count,0);
 assert.ok(c.all().some(n=>n.textContent==='选中的地图棋子已变化，请核对后重试'));
});
test('link request rejects edits typed while retrieving the collection',async()=>{
 let pause=false,finish,count=0;
 const c=setup({beforeGet:async()=>{if(pause)await new Promise(r=>finish=r);},bind:async()=>{count++;return true;}});
 await c.ui.open();pause=true;const linking=c.buttons('关联地图上选中的旧棋子')[0].onclick();
 type(c.names()[0],'新草稿');finish();await linking;assert.equal(count,0);assert.equal(c.names()[0].value,'新草稿');
});
test('successful batch link refreshes contextual labels',async()=>{
 let linked=false;const c=setup({bind:async()=>{linked=true;return true;},place:async()=>{},describePlacement:()=>({label:linked?'选中地图中的棋子':'释放到当前地图'})});
 await c.ui.open();const check=c.all().find(n=>n.type==='checkbox');check.checked=false;check.onchange();
 await c.buttons('关联地图上选中的旧棋子')[0].onclick();assert.ok(c.button('选中地图中的棋子'));
});

test('host profile separates collection and folds login actions; return preserves drafts',async()=>{
 const c=setup({host:true,backpack:()=>{}});await c.ui.open({playerId:'p'});
 assert.ok(c.button('角色名册'));assert.ok(c.button('🎒 查看背包 / 发放物品'));
 assert.equal(c.buttons('保存收藏资料').length,0);
 const more=c.all().find(n=>n.tag==='details'&&n.children.some(x=>x.textContent==='更多操作'));
 assert.ok(more);assert.equal(c.buttons('复制登录码').length,0);
 assert.equal(c.buttons('修改登录码').length,0);
 await c.button('角色名册').onclick();type(c.names()[0],'待保存草稿');
 await c.button('← 返回角色列表').onclick();assert.ok(c.button('角色名册'));
 await c.button('角色名册').onclick();assert.equal(c.names()[0].value,'待保存草稿');
});

test('empty library hides map actions and duplicate status while retaining navigation',async()=>{
 const c=setup({host:true,place:async()=>{},mapName:()=> '测试地图'});c.lib.pieces=[];
 await c.ui.open({playerId:'p',page:'library'});
 assert.ok(c.all().some(n=>n.tag==='h2'&&n.textContent==='玩家的角色与伙伴'));
 assert.equal(c.button('← 返回角色列表').hidden,false);
 assert.equal(c.all().filter(n=>n.type==='checkbox').length,0);
 assert.equal(c.all().find(n=>n.type==='search').disabled,true);
 assert.equal(c.all().find(n=>n.className==='pl-status').textContent,'');
 assert.ok(c.all().some(n=>n.textContent==='暂无棋子'));
 await c.button('← 返回角色列表').onclick();assert.ok(c.button('角色名册'));
});

test('remote recall is available independently of current map and prevents duplicate clicks',async()=>{
 let count=0,done;const deployments={'0':{status:'placed',mapId:null,mapName:null}};
 const c=setup({deployments,recall:async()=>{count++;await new Promise(resolve=>done=resolve);deployments['0']={status:'stored'};}});
 await c.ui.open();const recall=c.button('远程收回');assert.ok(recall);
 const first=recall.onclick();await recall.onclick();assert.equal(count,1);done();await first;
 assert.equal(c.button('远程收回'),undefined);assert.ok(c.all().some(e=>e.textContent==='已收起'));
});
test('character cards omit cross-map transfer even when a callback is configured',async()=>{
 const c=setup({destinations:()=>[{id:'open',name:'开放地图'}],transfer:async()=>{throw new Error('transfer should not be invoked');}});
 await c.ui.open();
 assert.equal(c.button('移至地图'),undefined);
 assert.equal(c.button('放入地图'),undefined);
 assert.equal(c.all().find(n=>n.tag==='select'),undefined);
});

test('personal library returns to backpack only when opened from it',async()=>{
 let returns=0;const c=setup();await c.ui.open({onBack:()=>{returns++;}});
 assert.equal(c.button('← 返回背包').hidden,false);await c.button('← 返回背包').onclick();assert.equal(returns,1);
 await c.ui.open();assert.equal(c.button('← 返回角色列表').hidden,true);
});

test('collection roles are filterable and main selection is saved',async()=>{
 const c=setup();c.lib.pieces[0].collectionRole='main';c.lib.pieces[1].collectionRole='companion';await c.ui.open();
 await c.button('伙伴').onclick();assert.equal(c.all().filter(n=>n.className==='pl-piece-card'&&!n.hidden).length,1);
 await c.button('设为主角色').onclick();assert.equal(c.lib.pieces[1].collectionRole,'main');
});

test('room DM chooses a character directly without a profile page and refresh keeps that character',async()=>{
 const c=setup({host:true,room:true});await c.ui.open();
 assert.equal(c.button('角色名册'),undefined);
 assert.equal(c.names().length,1);
 const second=c.all().find(n=>n.attributes?.['aria-label']==='查看角色 乙');await second.onclick();
 assert.equal(c.names()[0].value,'乙');
 await c.button('刷新').onclick();assert.equal(c.names()[0].value,'乙');
 assert.equal(c.all().find(n=>n.className==='pl-search-row').hidden,true);
 assert.equal(c.button('← 返回角色列表').hidden,true);
});

test('targeted browse keeps editors folded but preserves and reopens an existing draft',async()=>{
 const c=setup();await c.ui.open({ownedPieceId:'1',edit:false});
 const editors=()=>c.all().filter(n=>n.tag==='details'&&n.className==='pl-editor'&&n.children.some(x=>x.textContent.startsWith('编辑收藏资料')));
 assert.equal(c.names()[0].value,'乙');assert.ok(editors().every(n=>!n.open));
 type(c.names()[0],'乙的未存修改');await c.ui.open({ownedPieceId:'1',edit:false});
 assert.equal(c.names()[0].value,'乙的未存修改');assert.equal(editors()[0].open,true);assert.equal(editors()[1].open,false);assert.equal(c.lib.pieces[1].name,'乙');
});
