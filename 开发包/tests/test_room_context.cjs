const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../../程序包/主程序/shared/room-context.js'),'utf8');

const ACCOUNT_A='a'+'a'.repeat(32), ACCOUNT_B='a'+'b'.repeat(32);
function page(id, memory=new Map(), accountId=ACCOUNT_A, response={ok:true}, clock=Date) {
  class Storage {
    getItem(key) { return memory.get(key) ?? null; }
    setItem(key,value) { memory.set(key,String(value)); }
    removeItem(key) { memory.delete(key); }
  }
  class IDBFactory { open(name) { return name; } deleteDatabase(name) { return name; } }
  class EventSource { constructor(url) { this.url=url;this.closed=false;this.events={}; } close() { this.closed=true; } addEventListener(name,handler) {(this.events[name] ||= []).push(handler);} fire(name) {return Promise.all((this.events[name]||[]).map(handler=>handler()));} }
  const requests=[];
  const events={};
  const location=new URL('https://pl.example.com'+(id?'/rooms/'+id+'/主控台/主控台.html':'/account'));
  const window={fetch:(input,options)=>{requests.push({input,options});return Promise.resolve(typeof response==='function'?response(input,options):response);},EventSource,IDBFactory,localStorage:new Storage(),addEventListener(name,handler) { (events[name] ||= []).push(handler); }};
  function element() { return {style:{},children:[],setAttribute() {},append(...nodes) {this.children.push(...nodes);},replaceChildren(...nodes) {this.children=nodes;}}; }
  const document={body:element(),querySelector:() => accountId ? {content:accountId} : null,createElement:element,addEventListener() {}};
  vm.runInNewContext(source,{window,document,location,Storage,IDBFactory,URL,Request,Headers,Date:clock});
  return {window,document,requests,storage:new Storage(),db:new IDBFactory(),emitStorage(key,newValue) {for(const event of events.storage||[]) event({key,newValue});}};
}

test('two rooms keep recovery data and indexed databases separate',()=>{
  const memory=new Map();
  const first=page('r'+'1'.repeat(32),memory),second=page('r'+'2'.repeat(32),memory);
  first.storage.setItem('campaign','private first campaign');
  assert.equal(second.storage.getItem('campaign'),null);
  second.storage.setItem('campaign','second campaign');
  second.storage.removeItem('campaign');
  assert.equal(first.storage.getItem('campaign'),'private first campaign');
  assert.notEqual(first.db.open('portraits'),second.db.open('portraits'));
});

test('API requests preserve payloads and credentials while scoping the room',async()=>{
  const id='r'+'3'.repeat(32),p=page(id);
  const payload=new Request('https://pl.example.com/api/local-save',{method:'POST',body:'saved data',headers:{'Content-Type':'text/plain'}});
  await p.window.fetch(payload);
  const sent=p.requests[0];
  assert.equal(sent.input,payload);
  assert.equal(sent.options.headers.get('X-Sundoll-Room'),id);
  assert.equal(sent.options.headers.get('Content-Type'),'text/plain');
  assert.equal(sent.options.headers.get('X-Sundoll-Expected-Account'),ACCOUNT_A);
  await p.window.fetch('https://external.example/api/anything',{credentials:'omit'});
  assert.equal(p.requests[1].options.headers,undefined);
  const events=new URL(new p.window.EventSource('/api/events?last=12').url);
  assert.equal(events.pathname,'/rooms/'+id+'/api/events');
  assert.equal(events.searchParams.get('last'),'12');
  assert.equal(events.searchParams.get('sundollAccount'),ACCOUNT_A);
});

test('the account centre does not acquire a room scope',async()=>{
  const p=page(null);
  p.storage.setItem('original','unchanged');
  assert.equal(p.db.open('original'),'original');
  assert.equal(p.window.SundollRoom,undefined);
});

test('switching email accounts in the same room cannot read the previous account cache',()=>{
  const id='r'+'4'.repeat(32),memory=new Map([['room:'+id+':campaign','old shared recovery'],['campaign','administrator recovery']]);
  const first=page(id,memory,ACCOUNT_A);
  first.storage.setItem('watch-name','private A character');
  first.storage.setItem('campaign','A unsaved campaign');
  const firstDb=first.db.open('portraits');
  memory.set('sundoll-active-account',ACCOUNT_B);
  const second=page(id,memory,ACCOUNT_B);
  assert.equal(second.storage.getItem('watch-name'),null);
  assert.equal(second.storage.getItem('campaign'),null);
  second.storage.setItem('watch-name','B character');
  assert.notEqual(second.db.open('portraits'),firstDb);
  assert.equal(memory.get('room:'+id+':campaign'),'old shared recovery');
  assert.equal(memory.get('campaign'),'administrator recovery');
  assert.throws(()=>first.storage.getItem('watch-name'),/账号已变化/);
  memory.set('sundoll-active-account',ACCOUNT_A);
  const returned=page(id,memory,ACCOUNT_A);
  assert.equal(returned.storage.getItem('campaign'),'A unsaved campaign');
  assert.equal(returned.storage.getItem('watch-name'),'private A character');
});

test('logout or another login closes old SSE and blocks stale API mutations',async()=>{
  const id='r'+'5'.repeat(32),memory=new Map(),p=page(id,memory,ACCOUNT_A);
  const stream=new p.window.EventSource('/api/events');
  memory.set('sundoll-active-account',ACCOUNT_B);
  p.emitStorage('sundoll-active-account',ACCOUNT_B);
  assert.equal(stream.closed,true);
  assert.throws(()=>p.window.fetch('/api/state',{method:'POST',body:'old draft'}),/账号已变化/);
  assert.throws(()=>p.window.fetch('/rooms/'+id+'/api/state',{method:'POST',body:'old draft'}),/账号已变化/);
  assert.throws(()=>new p.window.EventSource('/api/events'),/账号已变化/);
  assert.throws(()=>p.db.open('portraits'),/账号已变化/);
  assert.equal(p.requests.length,0);
  assert.match(p.document.body.children[0].children[0].textContent,/账号已切换或退出/);
  await p.window.fetch('https://external.example/api/public');
  assert.equal(p.requests.length,1);
});

test('missing or malformed server account context never falls back to shared room recovery',()=>{
  const id='r'+'6'.repeat(32),memory=new Map([['room:'+id+':campaign','private legacy recovery']]);
  for(const accountId of ['', 'untrusted']) {
    const p=page(id,memory,accountId);
    assert.throws(()=>p.storage.getItem('campaign'),/账号已变化/);
    assert.throws(()=>p.window.fetch('/api/state'),/账号已变化/);
    assert.match(p.document.body.children[0].children[0].textContent,/缺少账号信息/);
  }
  assert.equal(memory.get('room:'+id+':campaign'),'private legacy recovery');
});

test('unrelated storage events do not stop the current account or room',async()=>{
  const p=page('r'+'7'.repeat(32));
  p.emitStorage('some-preference','changed');
  p.emitStorage('sundoll-active-account',ACCOUNT_A);
  await p.window.fetch('/api/info');
  assert.equal(p.requests.length,1);
});

test('a server account mismatch locks stale room pages even without a browser storage event',async()=>{
  const response=new Response(JSON.stringify({ok:false,error:'邮箱账号已变化，请重新进入'}),{status:409,headers:{'Content-Type':'application/json'}});
  const p=page('r'+'8'.repeat(32),new Map(),ACCOUNT_A,response);
  const stream=new p.window.EventSource('/api/events');
  const original=await p.window.fetch('/api/state',{method:'POST'});
  assert.equal(original.status,409);
  assert.equal((await original.json()).error,'邮箱账号已变化，请重新进入');
  assert.equal(stream.closed,true);
  assert.throws(()=>p.window.fetch('/api/state',{method:'POST'}),/账号已变化/);
});

test('ordinary save conflicts preserve the active account and leave SSE running',async()=>{
  const response=new Response(JSON.stringify({ok:false,error:'存档已经被其他页面修改'}),{status:409});
  const p=page('r'+'9'.repeat(32),new Map(),ACCOUNT_A,response),stream=new p.window.EventSource('/api/events');
  await p.window.fetch('/api/local-save',{method:'POST'});
  assert.equal(stream.closed,false);
  p.storage.setItem('campaign','own recovery');
  assert.equal(p.storage.getItem('campaign'),'own recovery');
});

test('a rejected SSE checks its frozen account instead of reconnecting under a new cookie',async()=>{
  const response=new Response(JSON.stringify({ok:false,error:'邮箱账号已变化，请重新进入'}),{status:409});
  const p=page('r'+'a'.repeat(32),new Map(),ACCOUNT_A,response),stream=new p.window.EventSource('/api/events');
  await stream.fire('error');
  assert.equal(stream.closed,true);
  assert.equal(p.requests[0].input,'/api/account/session');
  assert.equal(p.requests[0].options.headers['X-Sundoll-Expected-Account'],ACCOUNT_A);
  assert.match(p.document.body.children[0].children[0].textContent,/账号已切换或退出/);
});

test('an SSE error during a temporary server outage preserves this account recovery data',async()=>{
  const p=page('r'+'b'.repeat(32),new Map(),ACCOUNT_A,{status:503}),stream=new p.window.EventSource('/api/events');
  p.storage.setItem('campaign','saved recovery');
  await stream.fire('error');
  assert.equal(stream.closed,false);
  assert.equal(p.storage.getItem('campaign'),'saved recovery');
});

test('a delayed room response is rejected after account switching even without a storage event',async()=>{
  const memory=new Map();let complete;
  const p=page('r'+'c'.repeat(32),memory,ACCOUNT_A,()=>new Promise(resolve=>{complete=resolve;}));
  const pending=p.window.fetch('/api/state');
  memory.set('sundoll-active-account',ACCOUNT_B);
  complete(new Response(JSON.stringify({campaignName:'previous private response'})));
  await assert.rejects(pending,/账号已变化/);
  assert.equal(p.document.body.children.length,1);
  assert.match(p.document.body.children[0].children[0].textContent,/账号已切换或退出/);
});

test('revoked room membership closes SSE after its account remains valid',async()=>{
  const id='r'+'d'.repeat(32);
  const p=page(id,new Map(),ACCOUNT_A,url=>url==='/api/account/session'?{status:200}:new Response(JSON.stringify({ok:false,error:'战役不存在或无权访问'}),{status:404}));
  const stream=new p.window.EventSource('/api/events');
  await stream.fire('error');
  assert.equal(stream.closed,true);
  assert.equal(p.requests[1].input,'/rooms/'+id+'/api/info');
  assert.match(p.document.body.children[0].children[0].textContent,/战役权限已变化/);
  assert.throws(()=>p.window.fetch('/api/state',{method:'POST'}),/账号已变化|权限已变化/);
});

test('SSE checks back off after temporary failures without consuming a new player session',async()=>{
  let now=0;
  const p=page('r'+'e'.repeat(32),new Map(),ACCOUNT_A,{status:503},{now:()=>now});
  p.storage.setItem('campaign','recoverable current draft');
  const stream=new p.window.EventSource('/api/events');
  await stream.fire('error');await stream.fire('error');
  assert.equal(p.requests.length,1);
  now=1001;await stream.fire('error');
  assert.equal(p.requests.length,2);
  now=2002;await stream.fire('error');
  assert.equal(p.requests.length,2);
  now=3002;await stream.fire('error');
  assert.equal(p.requests.length,3);
  assert.equal(stream.closed,false);
  assert.equal(p.storage.getItem('campaign'),'recoverable current draft');
  assert.equal(p.requests.every(request=>request.input==='/api/account/session'),true);
});

test('temporary room 429 or 503 responses preserve SSE and account recovery',async()=>{
  for(const status of [429,503]) {
    const p=page('r'+'f'.repeat(32),new Map(),ACCOUNT_A,url=>url==='/api/account/session'?{status:200}:{status});
    const stream=new p.window.EventSource('/api/events');
    p.storage.setItem('campaign','current recoverable draft');
    await stream.fire('error');
    assert.equal(stream.closed,false);
    assert.equal(p.storage.getItem('campaign'),'current recoverable draft');
    assert.equal(p.requests.length,2);
  }
});
