'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../网站/主站');
const guestSource=fs.readFileSync(path.join(root,'guestbook.js'),'utf8');
const accountSource=fs.readFileSync(path.join(root,'site-account.js'),'utf8');
const A={id:'board_'+'a'.repeat(32),name:'甲'},B={id:'board_'+'b'.repeat(32),name:'乙'};
const messageId='11111111-1111-4111-8111-111111111111',replyId='22222222-2222-4222-8222-222222222222';
function record(id=messageId,overrides={}) {return {id,nickname:'甲',body:'已发布的留言',createdAt:'2026-10-11T12:00:00Z',status:'published',authorId:A.id,owned:true,liked:false,likeCount:0,replyCount:0,...overrides};}
const reply=(overrides={})=>record(replyId,{parentId:messageId,targetReplyId:null,targetNickname:null,...overrides});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function settle(){for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));}
function page({identity=A,ready=Promise.resolve(),messages=[record()],replies=[],api,realAccount=false,guest=true,url='https://sundollworld.com/',accountBase='https://pl.sundollworld.com'}={}) {
  let now=Date.now(),timerId=0,id=0,current=identity;
  const timers=new Map(),nodes=new Map(),calls=[],authCalls=[],listeners=new Set(),events={},documentEvents={},memory=new Map();let activeElement=null;
  class Element {
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.events={};this.hidden=false;this.disabled=false;this.value='';this.className='';this._text='';this.style={setProperty(){}};this.scrollHeight=20;this.offsetHeight=20;
      this.classList={contains:name=>this.className.split(/\s+/).includes(name),toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));if(on)set.add(name);else set.delete(name);this.className=[...set].join(' ');}};
    }
    get isConnected(){return this.root||Boolean(this.parentNode?.isConnected);}
    get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    set textContent(value){this._text=String(value);for(const child of this.children)child.parentNode=null;this.children=[];}
    append(...children){for(const child of children){if(child.fragment){this.append(...[...child.children]);continue;}child.remove();child.parentNode=this;this.children.push(child);}}
    replaceChildren(...children){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...children);}
    remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.parentNode=null;}
    setAttribute(name,value){this.attrs[name]=String(value);if(name==='class')this.className=String(value);}
    getAttribute(name){return this.attrs[name]??null;}
    hasAttribute(name){return Object.hasOwn(this.attrs,name);}
    removeAttribute(name){delete this.attrs[name];}
    addEventListener(name,fn){(this.events[name]||=[]).push(fn);}
    async fire(name){if(this.disabled)return;await Promise.all((this.events[name]||[]).map(fn=>fn({preventDefault(){}})));}
    focus(){this.focused=true;activeElement=this;}
    contains(node){return node===this||walk(this).includes(node);}
    querySelector(selector){return walk(this).find(n=>matches(n,selector))||null;}
  }
  function walk(node){return node.children.flatMap(child=>[child,...walk(child)]);}
  function matches(node,selector){
    const attribute=selector.match(/^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if(attribute)return(!attribute[1]||node.tagName===attribute[1].toUpperCase())&&node.hasAttribute(attribute[2])&&(attribute[3]===undefined||node.getAttribute(attribute[2])===attribute[3]);
    if(selector.startsWith('.'))return node.classList.contains(selector.slice(1));
    return node.tagName===selector.toUpperCase();
  }
  const section=new Element('section');section.root=true;
  for(const name of ['section','form','account-status','identity','body','submit','feedback','list','refresh','more','compose','compose-toggle']) {
    const node=name==='section'?section:new Element(name==='form'?'form':name==='body'?'textarea':['submit','refresh','more','compose-toggle'].includes(name)?'button':'div');node.id='guestbook-'+name;nodes.set(node.id,node);if(node!==section)section.append(node);
  }
  nodes.get('guestbook-compose').append(nodes.get('guestbook-form'));nodes.get('guestbook-form').append(nodes.get('guestbook-body'),nodes.get('guestbook-submit'),nodes.get('guestbook-feedback'));
  const header=new Element('header');header.root=true;
  const link=new Element('a'),label=new Element('span'),menu=new Element('details'),summary=new Element('summary'),initial=new Element('span'),nickname=new Element('span'),profileName=new Element('strong'),profileLink=new Element('a'),profileLabel=new Element('span'),logout=new Element('button'),logoutIcon=new Element('svg'),logoutLabel=new Element('span');
  link.setAttribute('data-sundoll-entry','account');link.setAttribute('data-site-account-signedout','');label.setAttribute('data-site-account-link-label','');link.append(label);
  menu.setAttribute('data-site-account-menu','');menu.hidden=true;menu.open=false;initial.setAttribute('data-site-account-initial','');nickname.setAttribute('data-site-account-name','');profileName.setAttribute('data-site-account-name','');summary.append(initial,nickname);menu.append(summary,profileName);
  profileLink.setAttribute('data-sundoll-entry','account');profileLabel.setAttribute('data-site-account-link-label','');profileLink.append(profileLabel);menu.append(profileLink);
  logout.setAttribute('data-site-account-logout','');logoutLabel.setAttribute('data-site-account-logout-label','');logoutLabel.textContent='退出';logout.append(logoutIcon,logoutLabel);menu.append(logout);header.append(link,menu);
  const document={get activeElement(){return activeElement;},getElementById:key=>nodes.get(key),createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag),createDocumentFragment(){const n=new Element('fragment');n.fragment=true;return n;},addEventListener(name,fn){(documentEvents[name]||=[]).push(fn);},querySelector(selector){if(selector==='meta[name="guestbook-api"]')return {content:'https://board.example.test'};if(selector==='meta[name="account-api"]')return {content:accountBase};return walk(header).find(node=>matches(node,selector))||null;},querySelectorAll(selector){return walk(header).filter(node=>matches(node,selector));}};
  const setTimer=(fn,delay)=>{const key=++timerId;timers.set(key,{fn,at:now+delay});return key;};
  class ClockDate extends Date {static now(){return now;}}
  const stub={identity:()=>current,ready,async refresh(){return current;},async authorization(force=true){authCalls.push(force);if(stub.onAuthorize)await stub.onAuthorize(force);if(!current)throw Object.assign(new Error('登录'),{status:401});return {ticket:'ticket-'+current.id,identityId:current.id};},subscribe(fn){listeners.add(fn);fn(current,'');}};
  function switchIdentity(next){const previous=current?.id||'';current=next;for(const fn of listeners)fn(next,previous);}
  const fetch=async(url,options={})=>{
    const parsed=new URL(url),method=options.method||'GET',data=options.body?JSON.parse(options.body):undefined;
    const call={url:parsed,method,data,options};calls.push(call);
    let value=api?await api(call):undefined;
    if(value===undefined){
      if(parsed.pathname==='/api/account/site-session')value={ok:true,identity:current,ticket:'ticket-'+current?.id,expiresAt:Math.floor(now/1000)+300};
      else if(parsed.pathname==='/api/account/site-session/logout')value={ok:true};
      else if(method==='GET'&&parsed.pathname.endsWith('/replies'))value={ok:true,replies:JSON.parse(JSON.stringify(replies)),nextCursor:null};
      else if(method==='GET')value={ok:true,messages:JSON.parse(JSON.stringify(messages)),nextCursor:null};
      else value={ok:true};
    }
    return {ok:!value.httpStatus||value.httpStatus<400,status:value.httpStatus||200,headers:{get:()=>null},json:async()=>value.json?await value.json():value};
  };
  const window={crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`},setTimeout:setTimer,clearTimeout:key=>timers.delete(key),requestAnimationFrame:fn=>fn(),addEventListener(name,fn){(events[name]||=[]).push(fn);},SundollSiteAccount:stub};
  const context={window,document,location:new URL(url),URL,Date:ClockDate,Intl,Uint8Array,AbortController,fetch,setTimeout:setTimer,clearTimeout:window.clearTimeout,getComputedStyle:()=>({lineHeight:'20px'}),localStorage:{setItem:(k,v)=>memory.set(k,v)},console};
  if(realAccount)vm.runInNewContext(accountSource,context);
  if(guest)vm.runInNewContext(guestSource,context);
  return {calls,authCalls,account:window.SundollSiteAccount,stub,switchIdentity,setCookie(next){current=next;},get:key=>nodes.get('guestbook-'+key),nodes,link,label,nickname,profileName,profileLink,profileLabel,menu,summary,initial,logout,logoutIcon,logoutLabel,active:()=>activeElement,find:(node,cls)=>walk(node).filter(n=>n.classList.contains(cls)),attribute:(node,key,value)=>walk(node).find(n=>n.attrs[key]===value),emit(name,value){for(const fn of events[name]||[])fn(value);},emitDocument(name,value){for(const fn of documentEvents[name]||[])fn(value);},advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;}};
}
const writes=p=>p.calls.filter(c=>c.method!=='GET');
const entry=p=>p.find(p.get('list'),'guestbook-entry')[0];

test('anonymous visitors read without a ticket and have no active write controls',async()=>{
  const p=page({identity:null});await settle();assert.equal(p.calls[0].options.headers.Authorization,undefined);assert.equal(p.get('compose-toggle').hidden,true);
  assert.equal(p.find(entry(p),'guestbook-like')[0].hidden,true);assert.equal(p.find(entry(p),'guestbook-reply-toggle')[0].hidden,true);
  p.get('body').value='匿名草稿';await p.get('form').fire('submit');assert.equal(writes(p).length,0);
});

test('message writes force fresh authorization and only send content and request identity',async()=>{
  let stored=[];
  const p=page({api:c=>{if(c.method==='POST'){stored.push(record(messageId,{body:c.data.body}));return {ok:true,status:'published',message:stored[0]};}if(c.method==='GET')return {ok:true,messages:stored,nextCursor:null};}});await settle();
  p.get('body').value='  新留言  ';await p.get('form').fire('submit');assert.deepEqual(Object.keys(writes(p)[0].data),['body','requestId']);assert.equal(writes(p)[0].data.body,'新留言');
  assert.equal(writes(p)[0].options.headers.Authorization,'Bearer ticket-'+A.id);assert.equal(p.authCalls.includes(true),true);assert.equal(p.authCalls[0],false);assert.equal(p.get('body').value,'');
});

test('compose and publish controls describe their distinct actions',async()=>{
  const p=page();await settle();assert.equal(p.get('compose-toggle').textContent,'留言');assert.equal(p.get('submit').textContent,'发布');
  await p.get('compose-toggle').fire('click');assert.equal(p.get('compose-toggle').textContent,'收起');assert.equal(p.get('compose').hidden,false);
  await p.get('compose-toggle').fire('click');assert.equal(p.get('compose-toggle').textContent,'留言');assert.equal(p.get('compose').hidden,true);
});

test('an unknown write outcome keeps draft and requestId for a content-identical retry',async()=>{
  let count=0;
  const p=page({api:c=>c.method==='POST'?++count===1?{ok:false,httpStatus:500}:{ok:true,status:'pending',message:record(messageId,{status:'pending',body:c.data.body})}:undefined});await settle();
  p.get('body').value='原草稿';await p.get('form').fire('submit');assert.equal(p.get('body').value,'原草稿');p.get('body').value=' 原草稿 ';await p.get('body').fire('input');await p.get('form').fire('submit');
  assert.equal(writes(p)[0].data.requestId,writes(p)[1].data.requestId);assert.equal(p.get('body').value,'');
});

test('draft text and request IDs are isolated by account and restored only for the original account',async()=>{
  const p=page({api:c=>c.method==='POST'?{ok:false,httpStatus:500}:undefined});await settle();p.get('body').value='甲的草稿';await p.get('form').fire('submit');
  const original=writes(p)[0].data.requestId;p.switchIdentity(B);await settle();assert.equal(p.get('body').value,'');p.get('body').value='乙的草稿';await p.get('form').fire('submit');
  assert.notEqual(writes(p)[1].data.requestId,original);p.switchIdentity(A);await settle();assert.equal(p.get('body').value,'甲的草稿');await p.get('form').fire('submit');assert.equal(writes(p)[2].data.requestId,original);
});

test('a cookie switch found during fresh authorization never posts the previous account draft',async()=>{
  const p=page();await settle();p.get('body').value='甲的草稿';p.stub.onAuthorize=force=>{if(force){p.stub.onAuthorize=null;p.switchIdentity(B);}};
  await p.get('form').fire('submit');await settle();assert.equal(writes(p).length,0);assert.equal(p.get('body').value,'');p.switchIdentity(A);await settle();assert.equal(p.get('body').value,'甲的草稿');
});

test('late write results do not clear a replacement account draft or insert its predecessor message',async()=>{
  const pending=deferred();const p=page({api:c=>c.method==='POST'?pending.promise:undefined});await settle();p.get('body').value='甲的提交';const job=p.get('form').fire('submit');await settle();
  p.switchIdentity(B);await settle();p.get('body').value='乙的新草稿';pending.resolve({ok:true,status:'published',message:record(messageId,{body:'甲的提交'})});await job;await settle();
  assert.equal(p.get('body').value,'乙的新草稿');assert.equal(p.get('submit').disabled,false);assert.doesNotMatch(p.get('feedback').textContent,/已留下|保存/);
});

test('initial list reads from the old account are discarded and the replacement gets a fresh list',async()=>{
  const old=deferred();let reads=0;const p=page({api:c=>c.method==='GET'&&++reads===1?old.promise:{ok:true,messages:[record(messageId,{owned:false,nickname:'乙视图'})],nextCursor:null}});await settle();p.switchIdentity(B);await settle();
  old.resolve({ok:true,messages:[record(messageId,{nickname:'旧回执'})],nextCursor:null});await settle();assert.match(p.get('list').textContent,/乙视图/);assert.doesNotMatch(p.get('list').textContent,/旧回执/);assert.equal(p.get('refresh').disabled,false);
});

test('ownership refresh updates delete control records instead of retaining initial owned state',async()=>{
  let reads=0;const p=page({api:c=>c.method==='GET'?{ok:true,messages:[record(messageId,{owned:++reads>1})],nextCursor:null}:c.method==='DELETE'?{ok:true,deletedId:messageId,kind:'message'}:undefined});await settle();await p.get('refresh').fire('click');await settle();
  const confirm=p.attribute(entry(p),'aria-label','确认删除留言');await confirm.fire('click');assert.equal(writes(p)[0].method,'DELETE');assert.deepEqual(writes(p)[0].data,{});
});

test('delete acknowledgments must match the actual record and kind before removing content',async()=>{
  const p=page({api:c=>c.method==='DELETE'?{ok:true,deletedId:replyId,kind:'reply'}:undefined});await settle();await p.attribute(entry(p),'aria-label','确认删除留言').fire('click');assert.equal(p.find(p.get('list'),'guestbook-entry').length,1);assert.match(p.get('list').textContent,/还没确认删除/);
});

test('likes send only desired state and reject a response for a different reply',async()=>{
  const p=page({api:c=>c.method==='POST'?{ok:true,messageId,replyId,liked:true,likeCount:8}:undefined});await settle();const like=p.find(entry(p),'guestbook-like')[0];await like.fire('click');assert.deepEqual(writes(p)[0].data,{liked:true});assert.equal(like.getAttribute('aria-pressed'),'false');
});

test('reply target, draft and retry identity remain attached to their actual thread and account',async()=>{
  const p=page({messages:[record(messageId,{replyCount:1})],replies:[reply()],api:c=>c.method==='POST'?{ok:false,httpStatus:500}:undefined});await settle();const article=entry(p),row=p.find(article,'guestbook-reply-entry')[0];await p.find(row,'guestbook-reply-toggle')[0].fire('click');
  const textarea=p.find(article,'guestbook-reply-form')[0].children.find(n=>n.tagName==='LABEL').children[0],form=p.find(article,'guestbook-reply-form')[0];textarea.value='甲的回复草稿';await form.fire('submit');const requestId=writes(p)[0].data.requestId;
  assert.deepEqual(Object.keys(writes(p)[0].data),['body','requestId','targetReplyId']);assert.equal(writes(p)[0].data.targetReplyId,replyId);
  p.switchIdentity(B);await settle();assert.equal(textarea.value,'');p.switchIdentity(A);await settle();assert.equal(textarea.value,'甲的回复草稿');await form.fire('submit');assert.equal(writes(p)[1].data.requestId,requestId);
});

test('reply confirmations for the wrong target do not consume drafts',async()=>{
  const p=page({api:c=>c.method==='POST'?{ok:true,status:'published',reply:reply({body:c.data.body,targetReplyId:replyId,targetNickname:'另一目标'})}:undefined});await settle();const article=entry(p);await p.find(article,'guestbook-reply-toggle')[0].fire('click');const form=p.find(article,'guestbook-reply-form')[0],textarea=form.children.find(n=>n.tagName==='LABEL').children[0];textarea.value='回复留言';await form.fire('submit');assert.equal(textarea.value,'回复留言');
});

test('fresh site account requests cancel stale refreshes and old completion cannot overwrite new identity',async()=>{
  const old=deferred();let reads=0;const p=page({realAccount:true,guest:false,api:c=>c.url.pathname.endsWith('/site-session')?++reads===1?old.promise:{ok:true,identity:B,ticket:'b',expiresAt:Math.floor(Date.now()/1000)+300}:undefined});await settle();await p.account.refresh(true);old.resolve({ok:true,identity:A,ticket:'a',expiresAt:Math.floor(Date.now()/1000)+300});await settle();assert.equal(p.account.identity().id,B.id);assert.equal(p.calls[0].options.signal.aborted,true);assert.equal(p.profileLabel.textContent,'我的主页');assert.equal(p.menu.hidden,false);assert.equal(p.link.hidden,true);
});

test('a canceled refresh finalizer cannot discard a newer pending authorization job',async()=>{
  const first=deferred(),second=deferred();let reads=0;const p=page({realAccount:true,guest:false,api:()=>++reads===1?first.promise:second.promise});await settle();const fresh=p.account.refresh(true);await settle();first.resolve({ok:true,identity:A,ticket:'a',expiresAt:Math.floor(Date.now()/1000)+300});await settle();const cached=p.account.refresh();assert.equal(p.calls.length,2);second.resolve({ok:true,identity:B,ticket:'b',expiresAt:Math.floor(Date.now()/1000)+300});await Promise.all([fresh,cached]);assert.equal(p.account.identity().id,B.id);
});

test('authorization canceled by a newer completed refresh follows the newest validated identity',async()=>{
  const old=deferred();let reads=0;const p=page({realAccount:true,guest:false,api:c=>c.url.pathname.endsWith('/site-session')&&++reads===2?old.promise:undefined});await settle();const authorization=p.account.authorization();await settle();p.setCookie(B);await p.account.refresh(true);
  old.resolve({ok:true,identity:A,ticket:'a',expiresAt:Math.floor(Date.now()/1000)+300});const result=await authorization;assert.equal(result.identityId,B.id);assert.equal(p.account.identity().id,B.id);
});

test('logout cannot clear a replacement login after a late response',async()=>{
  const old=deferred();const p=page({realAccount:true,guest:false,api:c=>c.url.pathname.endsWith('/logout')?old.promise:undefined});await settle();const job=p.account.logout().catch(e=>e);await settle();p.setCookie(B);await p.account.refresh(true);old.resolve({ok:true});const result=await job;assert.match(result.message,/账号已变化/);assert.equal(p.account.identity().id,B.id);
});

test('logout rechecks identity after a slow JSON body and does not accept a malformed success',async()=>{
  const body=deferred();const p=page({realAccount:true,guest:false,api:c=>c.url.pathname.endsWith('/logout')?{ok:true,json:()=>body.promise}:undefined});await settle();const job=p.account.logout().catch(e=>e);await settle();p.setCookie(B);await p.account.refresh(true);body.resolve({ok:true});await job;assert.equal(p.account.identity().id,B.id);
  const bad=page({realAccount:true,guest:false,api:c=>c.url.pathname.endsWith('/logout')?{ok:false}:undefined});await settle();await assert.rejects(bad.account.logout(),/账号已变化/);assert.equal(bad.account.identity().id,A.id);
});

test('account API meta accepts only the production issuer or a precise loopback preview origin',async()=>{
  for(const [url,base,expected]of [
    ['https://sundollworld.com/','https://evil.test','https://pl.sundollworld.com'],
    ['https://sundollworld.com/','http://127.0.0.1:54321','https://pl.sundollworld.com'],
    ['http://localhost:54320/','https://pl.sundollworld.com','http://127.0.0.1:8090'],
    ['http://127.0.0.1:54320/','http://127.0.0.1:54321','http://127.0.0.1:54321'],
    ['http://localhost:54320/','http://[::1]:54321','http://[::1]:54321'],
    ['http://localhost/','http://user@localhost:54321','http://127.0.0.1:8090'],
    ['http://localhost/','http://localhost:54321/path','http://127.0.0.1:8090'],
    ['http://localhost/','http://localhost:54321/?token=x','http://127.0.0.1:8090'],
  ]){const p=page({realAccount:true,guest:false,url,accountBase:base});await settle();assert.equal(p.calls[0].url.origin,expected);}
});

test('real account bridge detects a cookie switch before posting any old account draft',async()=>{
  const p=page({realAccount:true});await settle();p.get('body').value='旧账号的草稿';p.setCookie(B);await p.get('form').fire('submit');await settle();assert.equal(p.calls.some(c=>c.method==='POST'&&c.url.pathname==='/api/messages'),false);assert.equal(p.get('body').value,'');assert.equal(p.account.identity().id,B.id);
});

test('a temporary issuer failure offers manual refresh and restores the original account draft',async()=>{
  let offline=false;
  const p=page({realAccount:true,api:c=>offline&&c.url.pathname.endsWith('/site-session')?{ok:false,httpStatus:503}:undefined});await settle();p.get('body').value='连接失败前的草稿';offline=true;await p.get('form').fire('submit');await settle();
  assert.equal(p.account.identity(),null);assert.match(p.get('account-status').textContent,/连接暂不可用.*刷新/);assert.equal(p.calls.some(c=>c.method==='POST'),false);
  offline=false;await p.get('refresh').fire('click');await settle();assert.equal(p.account.identity().id,A.id);assert.equal(p.get('body').value,'连接失败前的草稿');assert.equal(p.get('submit').disabled,false);
});

test('late like and delete results cannot alter the replacement account view',async()=>{
  for(const kind of ['like','delete']){
    const old=deferred();const p=page({api:c=>c.method!=='GET'?old.promise:undefined});await settle();const article=entry(p);
    const job=kind==='like'?p.find(article,'guestbook-like')[0].fire('click'):p.attribute(article,'aria-label','确认删除留言').fire('click');await settle();p.switchIdentity(B);await settle();
    old.resolve(kind==='like'?{ok:true,messageId,liked:true,likeCount:8}:{ok:true,deletedId:messageId,kind:'message'});await job;await settle();
    assert.equal(p.find(p.get('list'),'guestbook-entry').length,1);assert.equal(p.find(entry(p),'guestbook-like')[0].getAttribute('aria-pressed'),'false');assert.equal(p.get('refresh').disabled,false);
  }
});

test('reply deletion and like acknowledgments must match both thread and reply IDs',async()=>{
  for(const kind of ['like','delete']){
    const p=page({messages:[record(messageId,{replyCount:1})],replies:[reply()],api:c=>c.method!=='GET'?kind==='like'?{ok:true,messageId:replyId,replyId,liked:true,likeCount:5}:{ok:true,deletedId:replyId,kind:'reply',parentId:replyId}:undefined});await settle();
    const row=p.find(entry(p),'guestbook-reply-entry')[0];if(kind==='like')await p.find(row,'guestbook-like')[0].fire('click');else await p.attribute(row,'aria-label','确认删除回复').fire('click');
    assert.equal(p.find(entry(p),'guestbook-reply-entry').length,1);assert.equal(p.find(row,'guestbook-like')[0].getAttribute('aria-pressed'),'false');
    assert.deepEqual(writes(p)[0].data,kind==='like'?{liked:true}:{});
  }
});

test('public messages and replies load immediately even when account readiness never settles',async()=>{
  const p=page({identity:null,ready:new Promise(()=>{}),messages:[record(messageId,{replyCount:1,liked:true})],replies:[reply({liked:true})]});await settle();
  assert.match(p.get('list').textContent,/已发布的留言/);assert.equal(p.find(entry(p),'guestbook-reply-entry').length,1);
  assert.equal(p.calls.length,2);assert.equal(p.calls.every(c=>c.method==='GET'&&!c.options.headers.Authorization),true);assert.equal(p.authCalls.length,0);
  assert.equal(p.find(entry(p),'guestbook-like')[0].getAttribute('aria-pressed'),'false');
  p.get('body').value='匿名不能写';await p.get('form').fire('submit');assert.equal(writes(p).length,0);
});

test('signed GET authorization failures downgrade to public reads with ownership and liked state cleared',async()=>{
  for(const status of [401,503]){
    const p=page({messages:[record(messageId,{replyCount:1,liked:true})],replies:[reply({liked:true})]});p.stub.onAuthorize=()=>{throw Object.assign(new Error('issuer offline'),{status});};await settle();
    await p.get('refresh').fire('click');await settle();assert.match(p.get('list').textContent,/已发布的留言/);
    assert.equal(p.calls.every(c=>!c.options.headers.Authorization),true);
    for(const node of p.find(entry(p),'guestbook-like'))assert.equal(node.getAttribute('aria-pressed'),'false');
    for(const slot of p.find(entry(p),'guestbook-delete-slot'))assert.equal(slot.hidden,true);
    p.get('body').value='原账号故障草稿';await p.get('form').fire('submit');assert.equal(writes(p).length,0);assert.equal(p.get('body').value,'原账号故障草稿');
  }
});

test('writes never bypass unresolved account readiness despite a cached visible identity',async()=>{
  const p=page({ready:new Promise(()=>{})});await settle();assert.match(p.get('list').textContent,/已发布的留言/);
  p.get('body').value='等待验证的草稿';void p.get('form').fire('submit');await settle();
  assert.equal(writes(p).length,0);assert.equal(p.get('body').value,'等待验证的草稿');assert.equal(p.authCalls.length,0);
});

test('a resolved identity refreshes anonymous metadata without changing the public content',async()=>{
  const ready=deferred();const p=page({identity:null,ready:ready.promise,messages:[record(messageId,{liked:true})]});await settle();
  assert.equal(p.find(entry(p),'guestbook-delete-slot')[0].hidden,true);p.switchIdentity(A);ready.resolve();await settle();
  assert.equal(p.find(entry(p),'guestbook-delete-slot')[0].hidden,false);assert.equal(p.find(entry(p),'guestbook-like')[0].getAttribute('aria-pressed'),'true');
  assert.equal(p.calls.some(c=>c.options.headers.Authorization==='Bearer ticket-'+A.id),true);
});

test('manual public refresh completes even while the account refresh remains pending',async()=>{
  let reads=0;const p=page({ready:new Promise(()=>{}),api:c=>c.method==='GET'?{ok:true,messages:[record(messageId,{body:++reads>1?'公开列表已更新':'首轮列表'})],nextCursor:null}:undefined});await settle();
  p.stub.refresh=()=>new Promise(()=>{});await p.get('refresh').fire('click');await settle();assert.match(p.get('list').textContent,/公开列表已更新/);assert.equal(p.get('refresh').disabled,false);assert.equal(p.calls.every(c=>!c.options.headers.Authorization),true);
});
