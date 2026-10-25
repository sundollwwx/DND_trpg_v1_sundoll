const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const root=require('./project_paths.cjs').APP_ROOT;const prep=require(path.join(root,'主控台/host/prep-handbook.js'));
test('normalization preserves private edits and checks across a JSON save round trip',()=>{const raw=[{id:'wreck',title:'船骸',notes:'未向玩家透露的真相',mapIds:['m1','m1'],sections:[{id:'x',title:'线索',body:'<script>alert(1)</script>',done:true}]}];const saved=prep.normalize(JSON.parse(JSON.stringify(prep.normalize(raw))));assert.equal(saved[0].notes,raw[0].notes);assert.equal(saved[0].sections[0].body,raw[0].sections[0].body);assert.equal(saved[0].sections[0].done,true);assert.deepEqual(saved[0].mapIds,['m1']);assert.deepEqual(prep.normalize(undefined),[]);assert.equal(raw[0].mapIds.length,2);});
test('actual public stream excludes handbook secrets while shared notes remain shared',()=>{const app=fs.readFileSync(path.join(root,'主控台/host/app.js'),'utf8');const fn=app.slice(app.indexOf('function buildStreamPayload()'),app.indexOf('// 玩家动作到达主机'));const ctx={mapPresentationId:null,state:{maps:[],mapChapters:[],mapLocations:[],campaignId:'test',sharedNotes:'public',combatQuickCards:[{name:'SECRET',image:'SECRET'}],prepHandbook:[{title:'SECRET',notes:'SECRET'}]},ensureMapNavigation(){},presentedMap(){return null},publicStreamMap(){},publicStreamToken(){},mapGridVisible(){return false},publicEncounterState(){return {}},cachedStreamMapAssetUrl(){},userLinks:[],CampaignJournal:{normalize(){return {}}},hostMusic:{snapshot(){return null}},SundollProtocol:{version:1},streamAppliedSeq:0};vm.createContext(ctx);vm.runInContext(fn+';result=buildStreamPayload()',ctx);assert.equal(ctx.result.sharedNotes,'public');assert.equal(JSON.stringify(ctx.result).includes('SECRET'),false);assert.equal('prepHandbook' in ctx.result,false);assert.equal('combatQuickCards' in ctx.result,false);});
test('campaign initialization and load explicitly reset handbook instead of inheriting another campaign',()=>{const app=fs.readFileSync(path.join(root,'主控台/host/app.js'),'utf8');const fn=app.slice(app.indexOf('function newCampaignState('),app.indexOf('/* ==================== DOM 引用'));const ctx={state:{prepHandbook:[{title:'OLD'}]},CampaignJournal:{normalize(){return {}}},defaultEncounterState(){return {}}};vm.createContext(ctx);vm.runInContext(fn+';result=newCampaignState("New","new")',ctx);assert.equal(ctx.result.prepHandbook.length,0);assert.equal(ctx.result.combatQuickCards.length,0);const storage=fs.readFileSync(path.join(root,'主控台/host/storage.js'),'utf8');assert.ok(storage.includes('SundollPrepHandbook.normalize(s.prepHandbook)'));});

test('quick cards retain editable fields and images through save/load and reject active image URLs',()=>{const cards=prep.normalizeCards([{id:'a',name:'Deva',ac:'17',hp:'229',abilities:[{score:'18',modifier:'+4',save:'+4'}],actions:'圣锤。命中后造成伤害。'},{id:'a',kind:'image',image:'data:image/png;base64,aGVsbG8='},{kind:'image',image:'javascript:alert(1)'}]);assert.deepEqual(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),cards);assert.equal(cards[0].abilities[0].save,'+4');assert.equal(cards[0].actions,'圣锤。命中后造成伤害。');assert.notEqual(cards[0].id,cards[1].id);assert.ok(cards[1].image);assert.equal(cards[2].image,'');assert.deepEqual(prep.normalizeCards(null),[]);});
test('card library filters combine category tags CR format favorites and multiple words',()=>{const cards=prep.normalizeCards([{name:'天神 Deva',category:'天族',tags:['治疗','飞行','飞行'],challenge:'10 (XP5900)',actions:'圣锤攻击',favorite:true},{name:'幼龙',category:'龙',tags:['飞行'],challenge:'CR 1/2',kind:'image'},{name:'未知',category:'龙',challenge:''}]);assert.equal(cards[0].tags.length,2);assert.equal(prep.filterCards(cards,{query:'deva 圣锤',category:'天族',tag:'飞行',cr:'mid',favorite:true,kind:'manual'}).length,1);assert.equal(prep.filterCards(cards,{category:'龙',cr:'low'})[0].name,'幼龙');assert.equal(prep.filterCards(cards,{query:'不存在'}).length,0);assert.deepEqual(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),cards);assert.equal(prep.normalizeCards([{}])[0].category,'');});
test('campaign scene grouping preserves old cards and separates unassigned and scene cards',()=>{const cards=prep.normalizeCards([{name:'旧卡',category:'天族'},{name:'海岸敌人',sceneId:'coast'},{name:'洞穴敌人',sceneId:'cave'}]);assert.equal(cards[0].sceneId,'');assert.equal(cards[0].category,'天族');assert.deepEqual(prep.filterCards(cards,{sceneId:'coast'}).map(c=>c.name),['海岸敌人']);assert.deepEqual(prep.filterCards(cards,{sceneId:'__unassigned__'}).map(c=>c.name),['旧卡']);assert.deepEqual(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),cards);});
test('old map assignments migrate to chapter and explicit unassigned chapters stay unassigned',()=>{const state={maps:[{id:'a',chapterId:'chapter1'},{id:'b',chapterId:'chapter1'}]};const cards=prep.migrateCardChapters(prep.normalizeCards([{sceneId:'a'},{sceneId:'b'},{sceneId:'a',chapterId:''},{sceneId:'missing'}]),state);assert.deepEqual(cards.map(c=>c.chapterId),['chapter1','chapter1','','']);assert.equal(prep.filterCards(cards,{chapterId:'chapter1'}).length,2);assert.deepEqual(prep.migrateCardChapters(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),state),cards);});
test('location grouping uses actual locations and never treats chapter IDs as locations',()=>{const state={maps:[{id:'map-a',locationId:'coast',chapterId:'campaign-chapter'}],mapLocations:[{id:'coast',name:'海岸',chapterId:'campaign-chapter'}]};const cards=prep.migrateCardLocations(prep.normalizeCards([{sceneId:'map-a',chapterId:'campaign-chapter'},{chapterId:'campaign-chapter'},{sceneId:'map-a',locationId:''}]),state);assert.deepEqual(cards.map(c=>c.locationId),['coast','','']);assert.equal(prep.filterCards(cards,{locationId:'coast'}).length,1);assert.equal(prep.filterCards(cards,{locationId:'__unassigned__'}).length,2);assert.deepEqual(prep.migrateCardLocations(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),state),cards);});

test('oversized imported content survives normalization and repeated JSON round trips',()=>{
 const long='剧情原文'.repeat(9000),id='id'.repeat(80);
 const areas=Array.from({length:81},(_,i)=>({id:id+i,title:long,summary:long,notes:long,extra:{keep:true},mapIds:Array.from({length:81},(_,j)=>'map-'+j),sections:Array.from({length:61},(_,j)=>({id:id+j,title:long,body:i===0&&j===0?long:'正文',done:true,custom:'keep'}))}));
 const cards=Array.from({length:41},(_,i)=>({id:id+i,name:long,actions:long,category:long,tags:Array.from({length:21},(_,j)=>long+j),extra:'keep',sceneId:id,abilities:[{score:long,modifier:long,save:long,custom:'keep'}]}));
 const savedAreas=prep.normalize(JSON.parse(JSON.stringify(prep.normalize(areas))));
 assert.deepEqual(savedAreas,areas);
 const savedCards=prep.normalizeCards(JSON.parse(JSON.stringify(prep.normalizeCards(cards))));
 assert.equal(savedCards.length,41);assert.equal(savedCards[40].actions,long);assert.equal(savedCards[0].name,long);assert.equal(savedCards[0].id,id+'0');assert.equal(savedCards[0].tags.length,21);assert.equal(savedCards[0].tags[20],long+'20');assert.equal(savedCards[0].abilities[0].score,long);assert.equal(savedCards[0].abilities[0].custom,'keep');assert.equal(savedCards[0].extra,'keep');
});

class PrepElement {
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.events={};this.value='';this.textContent='';this.open=false;this.disabled=false;this.classList={toggle(){}};}
 append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
 prepend(...items){this.children.unshift(...items);}
 replaceChildren(...items){this.children=[];this.append(...items);}
 setAttribute(k,v){this.attrs[k]=String(v);}
 addEventListener(k,fn){this.events[k]=fn;}
 showModal(){this.open=true;}
 close(){this.open=false;this.events.close?.();}
 all(){return [this,...this.children.flatMap(c=>c.all())];}
}
function prepFixture(saveImmediately){
 const elements=new Map(),body=new PrepElement('body'),header=new PrepElement('header'),nav=new PrepElement('nav');
 for(const id of ['prep-dialog','prep-save','prep-close','prep-search','prep-new-title','prep-add','prep-areas','prep-content','prep-campaign','prep-heading','btn-prep-open','btn-quick-cards-open']){const e=new PrepElement();e.id=id;elements.set(id,e);}
 header.append(elements.get('prep-save'));body.append(header,...[...elements.values()].filter(e=>e.id!=='prep-save'),nav);
 const state={campaignId:'a',campaignName:'A',maps:[{id:'m1',name:'现有地图'}],mapLocations:[],prepHandbook:prep.normalize([{id:'area',title:'手册',mapIds:['m1','deleted'],notes:'',sections:[{id:'s',title:'剧情',body:'保留剧情'}]}]),combatQuickCards:[]};
 const messages=[],views=[],saves=[];
 const context={module:{exports:{}},crypto:{randomUUID:()=> 'unique-id'},document:{body,createElement:tag=>new PrepElement(tag),getElementById:id=>elements.get(id)||body.all().find(e=>e.id===id),querySelector:selector=>selector==='#prep-dialog nav'?nav:null}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'主控台/host/prep-handbook.js'),'utf8'),context);
 const controller=context.module.exports.create({getState:()=>state,save:()=>saves.push(true),saveImmediately,viewMap:id=>views.push(id),toast:s=>messages.push(s)});
 controller.init();controller.open();
 return {controller,state,body,messages,views,saves,get:id=>elements.get(id),statuses:()=>body.all().filter(e=>e.attrs.role==='status')};
}

test('save buttons await the real commit, block duplicates, and report success in both dialogs',async()=>{
 let finish,calls=0;const f=prepFixture(()=>{calls++;return new Promise(resolve=>finish=resolve);});
 const pending=f.get('prep-save').onclick();
 assert.equal(calls,1);assert.equal(f.get('prep-save').disabled,true);assert.ok(f.statuses().every(e=>e.dataset.state==='busy'));
 const other=f.body.all().find(e=>e.tag==='button'&&e.textContent==='立即保存');assert.equal(other.disabled,true);
 assert.equal(await other.onclick(),false);assert.equal(calls,1);
 finish(true);assert.equal(await pending,true);assert.equal(f.get('prep-save').disabled,false);assert.ok(f.statuses().every(e=>e.textContent==='已写入正式存档'));
});

test('a rejected, false, or merely queued save never claims a successful formal commit',async()=>{
 for(const callback of [()=>Promise.resolve(false),()=>Promise.reject(new Error('版本冲突')),()=>true,()=>Promise.resolve(undefined)]){
  const f=prepFixture(callback);assert.equal(await f.get('prep-save').onclick(),false);
  assert.equal(f.get('prep-save').disabled,false);assert.ok(f.statuses().every(e=>e.dataset.state==='error'));assert.ok(f.messages.some(s=>s.includes('保存未完成')));
 }
});

test('save completion does not mark a new campaign or subsequent edits as already saved',async()=>{
 let finish;const f=prepFixture(()=>new Promise(resolve=>finish=resolve));
 let pending=f.get('prep-save').onclick();const notes=f.body.all().find(e=>e.id==='prep-notes');notes.value='保存途中新增';notes.oninput();finish(true);await pending;
 assert.ok(f.statuses().every(e=>e.textContent.includes('后续修改仍待保存')));
 pending=f.get('prep-save').onclick();f.state.campaignId='b';finish(true);assert.equal(await pending,false);
 assert.ok(f.statuses().every(e=>e.dataset.state!=='ok'));
});

test('missing map links remain disabled and preserve references without rebuilding deleted maps',()=>{
 const f=prepFixture(()=>Promise.resolve(true));const before=JSON.stringify(f.state);
 const missing=f.body.all().find(e=>e.tag==='button'&&e.textContent==='地图已移除');assert.ok(missing);assert.equal(missing.disabled,true);assert.match(missing.title,/原地图已删除/);
 assert.ok(f.body.all().some(e=>e.textContent.includes('取消勾选以解除关联')));
 const live=f.body.all().find(e=>e.textContent==='预览：现有地图');live.onclick();assert.deepEqual(f.views,['m1']);assert.equal(JSON.stringify(f.state),before);
});


test('a map removed while the handbook is open cannot be previewed by a stale button',()=>{
 const f=prepFixture(()=>Promise.resolve(true));const live=f.body.all().find(e=>e.textContent==='预览：现有地图');f.state.maps=[];live.onclick();assert.deepEqual(f.views,[]);assert.equal(f.get('prep-dialog').open,true);assert.match(f.messages.at(-1),/已移除/);assert.deepEqual(Array.from(f.state.prepHandbook[0].mapIds),['m1','deleted']);
});

test('previewing the already active map only closes the handbook without another save or switch',()=>{
 const f=prepFixture(()=>Promise.resolve(true));f.state.activeMapId='m1';
 f.body.all().find(e=>e.textContent==='预览：现有地图').onclick();
 assert.equal(f.get('prep-dialog').open,false);assert.deepEqual(f.views,[]);assert.deepEqual(f.saves,[]);
});

test('area metadata edits persist without rebuilding focused inputs or losing preparation',()=>{
 const f=prepFixture(()=>Promise.resolve(true));
 const find=id=>f.body.all().find(e=>e.id===id),title=find('prep-area-title'),summary=find('prep-area-summary');
 title.value='Revised location';title.oninput();summary.value='Opening scene';summary.oninput();
 assert.equal(find('prep-area-title'),title);assert.equal(find('prep-area-summary'),summary);
 assert.equal(f.state.prepHandbook[0].title,'Revised location');
 assert.equal(f.state.prepHandbook[0].summary,'Opening scene');
 assert.equal(f.state.prepHandbook[0].sections[0].body,'保留剧情');
 const saved=prep.normalize(JSON.parse(JSON.stringify(f.state.prepHandbook)));
 assert.deepEqual(saved,JSON.parse(JSON.stringify(f.state.prepHandbook)));assert.equal(f.saves.length,2);
});

test('map association edits keep missing references until explicitly removed and never present a map',()=>{
 const f=prepFixture(()=>Promise.resolve(true));
 const live=f.body.all().find(e=>e.attrs['aria-label']==='关联地图：现有地图');
 live.checked=false;live.onchange();assert.deepEqual(Array.from(f.state.prepHandbook[0].mapIds),['deleted']);
 live.checked=true;live.onchange();live.onchange();
 assert.deepEqual(Array.from(f.state.prepHandbook[0].mapIds),['deleted','m1']);
 const missing=f.body.all().find(e=>e.attrs['aria-label']==='关联地图：已移除的地图');
 missing.checked=false;missing.onchange();assert.deepEqual(Array.from(f.state.prepHandbook[0].mapIds),['m1']);
 assert.deepEqual(f.views,[]);assert.equal(f.state.maps.length,1);
 assert.ok(f.body.all().some(e=>e.textContent==='预览：现有地图'));
});

test('a removed map cannot be reattached and an old editor cannot mutate a different campaign',()=>{
 const f=prepFixture(()=>Promise.resolve(true));
 const live=f.body.all().find(e=>e.attrs['aria-label']==='关联地图：现有地图');
 f.state.maps=[];live.checked=true;live.onchange();assert.equal(f.saves.length,0);
 assert.match(f.messages.at(-1),/地图已移除/);
 const title=f.body.all().find(e=>e.id==='prep-area-title'),before=JSON.stringify(f.state.prepHandbook);
 f.state.campaignId='another';title.value='Do not apply';title.oninput();
 assert.equal(JSON.stringify(f.state.prepHandbook),before);assert.equal(f.get('prep-dialog').open,false);
});

test('oversized safe image sources and unreadable originals are retained without active URL rendering',()=>{
 const source='data:image/png;base64,'+'a'.repeat(6*1024*1024+4);
 const cards=prep.normalizeCards([{kind:'image',image:source},{kind:'image',image:'javascript:alert(1)'}]);
 assert.equal(cards[0].image,source);assert.equal(cards[1].image,'');assert.equal(cards[1].unavailableImage,'javascript:alert(1)');assert.deepEqual(prep.normalizeCards(JSON.parse(JSON.stringify(cards))),cards);
});
