const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
class Element{
  constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.attributes={};this.dataset={};}
  append(...children){this.children.push(...children);} replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=value;} removeAttribute(key){delete this.attributes[key];}
  all(){return [this,...this.children.flatMap(c=>c.all())];}
  querySelectorAll(tag){return this.all().slice(1).filter(c=>c.tag===tag);} showModal(){this.open=true;} close(){this.open=false;}
}
function fixture(){
  const body=new Element('body'),calls=[],confirmations=[];let lost=false,allowConfirm=true;
  const old={id:'b'+'1'.repeat(32),name:'旧备份',createdAt:100,bytes:1024,canTogglePin:true};
  const latest={id:'b'+'2'.repeat(32),name:'最新备份',createdAt:200,bytes:2048,protected:true,protectionReasons:['最新备份'],canTogglePin:false};
  const view={backups:[latest,old],storage:{count:2,totalBytes:3072,protectedCount:1},policy:{keepCount:1,keepDays:0},plan:{previewToken:'preview-token',candidates:[old],reclaimableBytes:1024}};
  const context={window:{},document:{body,createElement:tag=>new Element(tag)},state:{},File:class{},crypto:{randomUUID:()=> 'stable-cleanup-request'},confirm:message=>{confirmations.push(message);return allowConfirm;},fetch:async(_url,args)=>{
    const command=JSON.parse(args.body);calls.push(command);
    if(command.op==='backup-cleanup'&&lost){lost=false;throw new Error('connection lost');}
    let result=command.op==='backups'?view:command.op==='backup-cleanup'?{deletedIds:command.backupIds,reclaimedBytes:1024}:{};
    return {ok:true,status:200,json:async()=>({ok:true,...JSON.parse(JSON.stringify(result))})};
  }};
  vm.createContext(context);vm.runInContext(readClientSource('主控台/host/modules.js'),context);
  return {api:context.window.SundollModules,calls,confirmations,body,button:text=>body.all().find(e=>e.tag==='button'&&e.textContent===text),input:name=>body.all().find(e=>e.attributes['aria-label']===name),loseReply(){lost=true;},cancel(){allowConfirm=false;}};
}
test('backup space and policy editing never delete without explicit preview confirmation',async()=>{
  const f=fixture();await f.api.open('backups');
  assert.equal(f.calls.some(c=>c.op==='overview'),false);
  assert.equal(f.calls.some(c=>c.op==='backup-cleanup'),false);
  assert.ok(f.body.all().some(e=>e.textContent.includes('2 份备份')));
  f.input('保留最近份数').value='3';f.input('保留最近天数').value='7';
  await f.button('保存保留策略').onclick();
  assert.deepEqual(f.calls.find(c=>c.op==='backup-policy'),{op:'backup-policy',keepCount:3,keepDays:7});
  assert.equal(f.calls.some(c=>c.op==='backup-cleanup'),false);
  await f.button('预览可清理备份').onclick();f.cancel();await f.button('删除选中的备份').onclick();
  assert.equal(f.calls.some(c=>c.op==='backup-cleanup'),false);
});
test('cleanup only sends preview candidates and keeps original request after lost reply',async()=>{
  const f=fixture();await f.api.open('backups');await f.button('预览可清理备份').onclick();
  assert.equal(f.input('清理备份：最新备份'),undefined);
  f.loseReply();await f.button('删除选中的备份').onclick();
  assert.equal(f.input('清理备份：旧备份').disabled,true);
  await f.button('核对并重试原清理').onclick();
  const writes=f.calls.filter(c=>c.op==='backup-cleanup');
  assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].previewToken,'preview-token');
  assert.deepEqual(writes[0].backupIds,['b'+'1'.repeat(32)]);
  assert.equal(f.confirmations.length,1);
});
