const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
class Element{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.attributes={};this.value='';this.events={};}
 append(...children){for(const c of children){if(c.parentElement)c.parentElement.children=c.parentElement.children.filter(x=>x!==c);c.parentElement=this;this.children.push(c);}}prepend(...children){for(const c of [...children].reverse()){if(c.parentElement)c.parentElement.children=c.parentElement.children.filter(x=>x!==c);c.parentElement=this;this.children.unshift(c);}}replaceChildren(...children){this.children=[];this.append(...children);}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,v){this.events[k]=v;}all(){return[this,...this.children.flatMap(c=>c.all())];}
 querySelectorAll(s){return this.all().slice(1).filter(e=>s.split(',').includes(e.tag));}showModal(){this.open=true;}close(){this.open=false;this.events.close?.();}
}
function setup(){
 const body=new Element('body');let campaign='c1',packageRevision='pkg-1',counter=0,fail=false,paused=false,release,pauseGet=false,releaseGet;
 let lib={revision:1,templates:[{id:'healing',version:1,name:'治疗药水',category:'potion',rarity:'普通',effect:'治疗',consumable:true,scope:'general',archived:false,usedIn:[]}]};
 const mapCalls=[],mapItems={place:async(...args)=>{mapCalls.push(args);return true;},container:async()=>{mapCalls.push(['container']);return true;},containers:async()=>[{id:'chest-1',name:'测试宝箱'}]};
 const receipts=new Map(),calls=[],backpack={facts:()=>'',art:()=>new Element('div'),extraFields:()=>({wrap:new Element('div'),body:new Element('textarea'),read:()=>({})})};
 const context={window:{},document:{body,createElement:tag=>new Element(tag)},Option:class extends Element{constructor(text,value){super('option',text);this.value=value;}},PlayerBackpack:backpack,MapItems:mapItems,structuredClone:x=>JSON.parse(JSON.stringify(x)),crypto:{randomUUID:()=>`request-${++counter}-unique-0001`},fetch:async(path,args)=>{
  const cmd=JSON.parse(args.body);calls.push({path,cmd});if(paused&&cmd.op!=='get')await new Promise(resolve=>release=resolve);
  if(cmd.op==='get'){const result={ok:true,packageContext:{revision:packageRevision},library:JSON.parse(JSON.stringify(lib))};if(pauseGet)await new Promise(resolve=>releaseGet=resolve);return{ok:true,json:async()=>result};}
  if(!receipts.has(cmd.requestId)){lib.revision++;if(cmd.op==='duplicate')lib.templates.push({...lib.templates[0],id:'copy',version:1,name:'副本'});if(cmd.op==='create')lib.templates.push({...cmd.item,id:'created',version:1,archived:false});receipts.set(cmd.requestId,{templateId:cmd.op==='create'?'created':'copy'});}
  if(fail){fail=false;throw new Error('lost reply');}
  return{ok:true,json:async()=>({ok:true,library:JSON.parse(JSON.stringify(lib)),...receipts.get(cmd.requestId)})};
 }};vm.createContext(context);vm.runInContext(readClientSource('主控台/host/item-library.js'),context);
 const api=context.window.ItemLibrary;api.configure({campaign:()=>({id:campaign,name:'海岛'}),packageContextRevision:()=>packageRevision});
 return {api,body,calls,lib,campaign:value=>{campaign=value;},package:value=>{packageRevision=value;},mapCalls,mapItems,backpack,button:text=>body.all().find(x=>x.tag==='button'&&x.textContent===text),pauseGet(){pauseGet=true;},releaseGet(){pauseGet=false;releaseGet();},fail(){fail=true;},pause(){paused=true;},release(){paused=false;release();}};
}
test('template copy locks duplicate clicks and keeps immutable retry after lost reply',async()=>{
 const t=setup();await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();
 const copy=t.button('复制为新模板');t.pause();t.fail();const sending=copy.onclick();await copy.onclick();assert.equal(t.calls.filter(x=>x.cmd.op==='duplicate').length,1);t.release();await sending;
 assert.equal(t.lib.templates.length,2);const original=t.calls.find(x=>x.cmd.op==='duplicate').cmd;
 await t.button('核对并重试原操作').onclick();assert.equal(t.lib.templates.length,2);assert.deepEqual(t.calls.filter(x=>x.cmd.op==='duplicate').map(x=>x.cmd),[original,original]);
});
test('archive requires visible confirmation before sending mutation',async()=>{
 const t=setup();await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();
 await t.button('归档模板').onclick();assert.equal(t.calls.filter(x=>x.cmd.op==='archive').length,0);
 await t.button('确认归档').onclick();assert.equal(t.calls.filter(x=>x.cmd.op==='archive').length,1);
});

test('every active category has visible placement actions and an isolated quantity form',async()=>{
 const t=setup();for(const category of ['potion','scroll','wondrous','gear','document'])t.lib.templates.push({...t.lib.templates[0],id:category,name:category,category,description:'long description '.repeat(300),body:category==='document'?'letter '.repeat(300):''});
 await t.api.open();
 for(const category of ['potion','scroll','wondrous','gear','document']){
  await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：'+category).onclick();
  const detail=t.body.all().find(e=>e.attributes['aria-label']==='物品模板详情');
  const actions=detail.children.find(e=>(e.className||'').includes('il-primary-actions'));
  assert.ok(detail.children.indexOf(actions)>detail.children.findIndex(e=>e.tag==='h3'));
  assert.deepEqual(actions.children.map(e=>e.textContent),['放到地图','放到宝箱','发给玩家']);
  await t.button('放到地图').onclick();assert.equal(detail.children[0].textContent,'放到地图');
  const count=t.body.all().find(e=>e.attributes['aria-label']==='放置数量');count.value='4';
  await t.button('确认放置').onclick();assert.equal(t.mapCalls.at(-1)[0].category,category);assert.equal(t.mapCalls.at(-1)[1],4);
  await t.api.open();
 }
});
test('treasure chest is a library item and always places one independent container',async()=>{
 const t=setup();t.lib.templates.push({...t.lib.templates[0],id:'treasure-chest',name:'宝箱',category:'container'});await t.api.open();
 assert.equal(t.button('＋ 放置宝箱'),undefined);
 await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：宝箱').onclick();await t.button('放到地图').onclick();await t.button('确认放置').onclick();
 assert.equal(t.mapCalls[0][0].category,'container');assert.equal(t.mapCalls[0][1],1);
});
test('failed placement keeps quantity and dialog visible',async()=>{
 const t=setup();t.mapItems.place=async()=>{throw new Error('请重启启动器后刷新页面');};await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();await t.button('放到地图').onclick();
 const count=t.body.all().find(e=>e.attributes['aria-label']==='放置数量');count.value='7';await t.button('确认放置').onclick();
 assert.equal(count.value,'7');assert.equal(t.body.all().find(e=>e.tag==='dialog').open,true);assert.equal(t.button('确认放置').disabled,false);
});
test('story creation lives in the item grid and defaults to the current campaign',async()=>{
 const t=setup();await t.api.open();await t.button('模板').onclick();assert.equal(t.button('＋ 写信件'),undefined);assert.equal(t.button('＋ 编书籍'),undefined);
 for(const label of ['信件','书籍']){
  const card=t.body.all().find(e=>e.attributes['aria-label']==='新建战役'+label);assert.ok(card);await card.onclick();
  const field=name=>t.body.all().find(e=>e.attributes['aria-label']===name);
  assert.equal(field('物品类型'),undefined);assert.equal(field('文书形式'),undefined);assert.equal(field('归属与战役').value,'campaign:c1');
 }
});
test('compact story editor saves a letter and then offers map placement',async()=>{
 const t=setup();await t.api.open();await t.button('模板').onclick();await t.body.all().find(e=>e.attributes['aria-label']==='新建战役信件').onclick();
 const field=name=>t.body.all().find(e=>e.attributes['aria-label']===name);
 field('物品名称').value='测试信';field('简短说明').value='阅读线索';
 assert.equal(field('场景或地点'),undefined);assert.equal(field('物品描述'),undefined);assert.equal(field('物品图片'),undefined);
 await t.button('放到地图').onclick();
 const create=t.calls.find(x=>x.cmd.op==='create');assert.equal(create.cmd.item.category,'document');assert.equal(create.cmd.item.documentType,undefined);assert.equal(create.cmd.item.scope,'campaign');assert.equal(create.cmd.item.campaignId,'c1');
 assert.equal(t.body.all().find(e=>e.attributes['aria-label']==='物品模板详情').children[0].textContent,'放到地图');
});
test('compact item creation chooses type from the left and can fill a chest',async()=>{
 const t=setup();await t.api.open();await t.button('模板').onclick();await t.body.all().find(e=>e.attributes['aria-label']==='新建药水').onclick();
 assert.equal(t.body.all().find(e=>e.attributes['aria-label']==='物品类型'),undefined);
 await t.button('放到宝箱').onclick();const create=t.calls.find(x=>x.cmd.op==='create');assert.equal(create.cmd.item.category,'potion');
 assert.equal(t.body.all().find(e=>e.attributes['aria-label']==='选择宝箱').value,'chest-1');
 await t.button('确认装入').onclick();assert.equal(t.mapCalls.at(-1)[2],'chest-1');
});
test('wine is a creation card only and creates independent items with its approved art',async()=>{
 const t=setup(),seeds=[];
 t.backpack.extraFields=base=>{seeds.push(structuredClone(base));return{wrap:new Element('div'),body:new Element('textarea'),read:()=>({image:base.image,description:base.description})};};
 await t.api.open();assert.equal(t.body.all().some(e=>e.attributes['aria-label']==='新建酒'),false);
 await t.button('模板').onclick();
 const field=name=>t.body.all().find(e=>e.attributes['aria-label']===name);
 field('搜索物品库').value='酒';field('搜索物品库').oninput();
 const card=t.body.all().find(e=>e.attributes['aria-label']==='新建酒');assert.ok(card);await card.onclick();
 assert.equal(field('物品名称').value,'');assert.equal(field('归属与战役').value,'general');assert.equal(field('消耗品').checked,true);
 assert.equal(t.calls.some(c=>c.cmd.op!=='get'),false);
 field('物品名称').value='船上红葡萄酒';field('归属与战役').value='campaign:c1';
 await t.button('放到地图').onclick();
 const cmd=t.calls.find(c=>c.cmd.op==='create').cmd;
 assert.equal(cmd.item.name,'船上红葡萄酒');assert.equal(cmd.item.scope,'campaign');assert.equal(cmd.item.campaignId,'c1');assert.equal(cmd.item.category,'gear');assert.equal(cmd.templateId,undefined);
 assert.match(cmd.item.image,/f655ae9634c1052334ac4243bd47a2ec6f448acfbd52b8c785bb436c8707e7e6$/);
 await t.button('模板').onclick();await t.body.all().find(e=>e.attributes['aria-label']==='新建酒').onclick();
 assert.equal(field('物品名称').value,'');assert.equal(field('归属与战役').value,'general');assert.equal(seeds.at(-1).weightLb,undefined);assert.equal(seeds.at(-1).valueCp,undefined);
 field('筛选类型').value='potion';field('筛选类型').oninput();assert.equal(t.body.all().some(e=>e.attributes['aria-label']==='新建酒'),false);
});

test('editing a template saves independently without placing or distributing it',async()=>{
 const t=setup();await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();await t.button('编辑模板').onclick();
 const name=t.body.all().find(e=>e.attributes['aria-label']==='物品名称');name.value='修改后的药水';
 await t.button('保存').onclick();const command=t.calls.find(c=>c.cmd.op==='edit').cmd;
 assert.equal(command.item.name,'修改后的药水');assert.equal(t.mapCalls.length,0);assert.equal(t.calls.some(c=>c.path==='/api/backpack'),false);
});
test('archived template permanent deletion requires explicit confirmation',async()=>{
 const t=setup();t.lib.templates[0].archived=true;await t.api.open();await t.button('已归档').onclick();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();
 await t.button('彻底删除').onclick();assert.equal(t.calls.some(c=>c.cmd.op==='purge'),false);await t.button('确认删除').onclick();assert.equal(t.calls.filter(c=>c.cmd.op==='purge').length,1);
});


test('disabled package templates remain editable but cannot be distributed or placed',async()=>{
 const t=setup();t.lib.templates[0].availableInCampaign=false;t.lib.templates[0].availabilityReason='当前战役未启用来源包';await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();
 for(const name of ['放到地图','放到宝箱','发给玩家']){assert.equal(t.button(name).disabled,true);await t.button(name).onclick();}
 assert.equal(t.mapCalls.length,0);assert.equal(t.calls.some(c=>c.path==='/api/player-profiles'),false);assert.equal(!!t.button('编辑模板').disabled,false);
});
test('old item library placement cannot cross a package context change',async()=>{
 const t=setup();await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();await t.button('放到地图').onclick();const place=t.button('确认放置');
 t.package('pkg-2');t.lib.templates[0].availableInCampaign=false;t.api.contextChanged();await place.onclick();assert.equal(t.mapCalls.length,0);assert.equal(t.calls[0].cmd.campaignId,'c1');
});


test('item library retains an accessible exact retry after its campaign context changes',async()=>{
 const t=setup();await t.api.open();await t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水').onclick();t.fail();await t.button('复制为新模板').onclick();const original=t.calls.find(c=>c.cmd.op==='duplicate').cmd;
 t.package('pkg-2');t.api.contextChanged();const retry=t.button('核对并重试原操作');assert.ok(retry);assert.equal(retry.disabled,false);await retry.onclick();await new Promise(r=>setImmediate(r));
 assert.deepEqual(t.calls.filter(c=>c.cmd.op==='duplicate').map(c=>c.cmd),[original,original]);assert.equal(t.lib.templates.length,2);assert.ok(t.body.all().find(e=>e.attributes['aria-label']==='查看模板：治疗药水'));
});
test('a context change during an item library read discards old data and automatically reads the new context',async()=>{
 const t=setup();t.pauseGet();const opening=t.api.open();t.campaign('c2');t.package('pkg-2');t.lib.templates[0].name='新战役物品';t.api.contextChanged();t.releaseGet();await opening;await new Promise(r=>setImmediate(r));
 assert.deepEqual(t.calls.filter(c=>c.cmd.op==='get').map(c=>c.cmd.campaignId),['c1','c2']);assert.equal(t.body.all().some(e=>e.attributes['aria-label']==='查看模板：治疗药水'),false);assert.ok(t.body.all().some(e=>e.attributes['aria-label']==='查看模板：新战役物品'));
});
