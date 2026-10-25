const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {APP_ROOT} = require('./project_paths.cjs');
const source = fs.readFileSync(path.join(APP_ROOT, 'web/account.js'), 'utf8');
const html = fs.readFileSync(path.join(APP_ROOT, 'web/account.html'), 'utf8');

function page({hash = '', url = 'http://127.0.0.1:8090/account', mainUrl = 'https://sundollworld.com/', memory = new Map(), localMemory = new Map(), api = {}, now:startedAt = Date.now()} = {}) {
  const all = [], nodes = new Map(), calls = [];
  const windowEvents = {};
  let now = startedAt, timerId = 0;
  const timers = new Map();
  class ClockDate extends Date { static now() { return now; } }
  const setTimer = (callback, delay) => { const id = ++timerId; timers.set(id, {callback, at:now + delay}); return id; };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.events = {}; this.attrs = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; all.push(this); }
    addEventListener(name, action) { (this.events[name] ||= []).push(action); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
    querySelector(tag) { return descendants(this).find(child=>child.tagName===tag.toUpperCase()) || null; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    focus() { this.focused = true; }
    scrollIntoView(options) { this.scrolled = options; }
    select() { this.selected = true; }
    fire(name) { for (const action of this.events[name] || []) action({preventDefault() {}}); }
  }
  for (const match of html.replaceAll('{{mainUrl}}', mainUrl).matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]); element.id = match[3]; element.hidden = /\bhidden\b/.test(match[2]); nodes.set(element.id, element);
    const href = match[2].match(/\bhref="([^"]+)"/); if (href) element.href = href[1];
  }
  const location = new URL(url + hash);
  location.reload = () => calls.push({reload:true});
  location.assign = url => calls.push({navigate:url});
  const sessionStorage = {getItem:key => memory.get(key) ?? null, setItem:(key,value) => memory.set(key,String(value)), removeItem:key => memory.delete(key)};
  const localStorage = {getItem:key => localMemory.get(key) ?? null, setItem:(key,value) => localMemory.set(key,String(value)), removeItem:key => localMemory.delete(key)};
  const fetch = async (url, options = {}) => {
    const action = String(url).split('/').at(-1), data = options.body && JSON.parse(options.body);
    calls.push({action, data, headers:options.headers});
    let result = api[action];
    if (typeof result === 'function') result = await result(data, options);
    if (result === undefined && action === 'characters') result={ok:true,characters:[]};
    if (result === undefined && action === 'room-create') result={ok:true,room:{id:'r'+'1'.repeat(32)}};
    if (result === undefined && action === 'room-onboarding') {
      const members=typeof api['room-members']==='function'?await api['room-members'](data):api['room-members'];
      const profiles=typeof api['room-profiles']==='function'?await api['room-profiles'](data):api['room-profiles'];
      result={ok:true,player:{state:'unbound',profile:null},characters:[],migration:{campaigns:[],profiles:profiles?.profiles||[],characters:(profiles?.profiles||[]).filter(p=>p.enabled).map(p=>({...p,characterId:p.playerId})),members:members?.members||[],sources:[]}};
    }
    if (result === undefined) result = action === 'config' ? {ok:true,enabled:true,emailReady:true,roomsEnabled:true} : action === 'session' ? {ok:false,error:'请先登录',status:401} : {ok:true};
    return {ok:!result.status || result.status < 400, status:result.status || 200, json:async () => result};
  };
  const body = new Element('body');
  const context = {window:{addEventListener(name,handler) { (windowEvents[name] ||= []).push(handler); }}, document:{body, getElementById:id => nodes.get(id), createElement:tag => new Element(tag), querySelectorAll:tag => all.filter(node => node.tagName === tag.toUpperCase())}, location, history:{replaceState(_state,_title,url) { location.href = new URL(url,location.href).href; }}, sessionStorage, localStorage, URL, URLSearchParams, fetch, AbortController, setTimeout:setTimer, clearTimeout:id => timers.delete(id), Date:ClockDate, crypto:require('node:crypto').webcrypto, console};
  vm.runInNewContext(source, context);
  return {nodes, calls, memory, localMemory, location, body, now:()=>now, get:id => nodes.get(id), advance(ms) { const end=now+ms; for (;;) { const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if (!next) break; now=next[1].at; timers.delete(next[0]); next[1].callback(); } now=end; }, changeHash(hash) { const oldURL=location.href;location.hash=hash;for(const handler of windowEvents.hashchange||[]) handler({oldURL,newURL:location.href}); }, emitStorage(key,newValue) {for(const handler of windowEvents.storage||[]) handler({key,newValue});}};
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }
const account = {accountId:'a-owner', name:'主持人', email:'owner@example.test', emailVerified:true, playerId:''};
const room = {id:'r' + '1'.repeat(32), name:'周五小队', role:'owner'};
function descendants(node) { return node.children.flatMap(child => [child,...descendants(child)]); }
const roomAction = (p, text, index = 0) => descendants(p.get('room-list').children[index]).find(node => node.textContent === text);
const manage = (p, index = 0) => roomAction(p,'邀请与成员',index);

test('initial session lookup never flashes a signed-out form for an authenticated user', async () => {
  let resolveSession;
  const p=page({api:{session:()=>new Promise(resolve=>{resolveSession=resolve;}),rooms:{ok:true,rooms:[room]}}});
  await settle();
  assert.equal(p.get('account-auth').hidden,true);
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.equal(p.get('account-title').textContent,'我的冒险');
  assert.equal(p.get('account-app').attrs['aria-busy'],'true');
  resolveSession({ok:true,account});await settle();
  assert.equal(p.get('account-auth').hidden,true);
  assert.equal(p.get('account-dashboard').hidden,false);
  assert.equal(p.get('account-app').attrs['aria-busy'],'false');
});

test('an unknown session caused by a network failure has an explicit retry without claiming logout', async () => {
  let attempts=0;
  const p=page({api:{session:()=>{if(++attempts===1)throw new Error('Offline');return {ok:true,account};},rooms:{ok:true,rooms:[room]}}});
  await settle();
  assert.equal(p.get('account-auth').hidden,true);
  assert.equal(p.get('account-retry').hidden,false);
  assert.equal(p.get('account-title').textContent,'暂时无法连接');
  p.get('account-retry').fire('click');await settle();
  assert.equal(attempts,2);assert.equal(p.get('account-retry').hidden,true);
  assert.equal(p.get('account-dashboard').hidden,false);
});

test('room authentication continuation survives refresh and returns to the original DM page', async () => {
  const target='/rooms/'+room.id+'/主控台/主控台.html',memory=new Map();
  page({hash:'#continue='+encodeURIComponent(target),memory}); await settle();
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).resume,target);
  const p=page({memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}}); await settle();
  p.get('account-email').value=account.email; p.get('account-password').value='password';p.get('account-form').fire('submit'); await settle();
  assert.equal(p.calls.find(call=>call.navigate)?.navigate,target);
  assert.equal(memory.has('sundoll-account-pending'),false);
  assert.equal(p.get('account-home').href,'https://sundollworld.com/');
});

test('an already authenticated player continuation checks onboarding before navigation', async () => {
  const target='/rooms/'+room.id+'/主控台/玩家.html';
  for(const ready of [true,false]) {
    const p=page({hash:'#continue='+encodeURIComponent(target),api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-onboarding':{ok:true,player:{state:ready?'ready':'unbound'}}}});
    await settle();
    assert.equal(p.calls.find(call=>call.navigate)?.navigate,undefined);
    assert.equal(p.get('player-onboarding').hidden,false);
    assert.equal(p.calls.some(call=>call.action==='room-start-player'),false);
  }
});

test('room continuation rejects foreign origins, APIs and a DM target for a player', async () => {
  const root='/rooms/'+room.id;
  for(const target of ['https://evil.test'+root+'/',root+'/api/state',root+'/主控台/玩家.html?next=evil',root+'/../../account']) {
    const p=page({hash:'#continue='+encodeURIComponent(target),api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]}}}); await settle();
    assert.equal(p.calls.some(call=>call.navigate),false);
  }
  const p=page({hash:'#continue='+encodeURIComponent(root+'/主控台/主控台.html'),api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]}}}); await settle();
  assert.equal(p.calls.some(call=>call.navigate),false);
  assert.match(p.get('account-status').textContent,/进入权限/);
});

test('a new main-site login supersedes an abandoned room continuation', async () => {
  const memory=new Map([['sundoll-account-pending',JSON.stringify({at:Date.now(),resume:'/rooms/'+room.id+'/'})]]);
  const p=page({url:'http://127.0.0.1:8090/account?return='+encodeURIComponent('https://sundollworld.com/'),memory,api:{login:{ok:true,account}}}); await settle();
  p.get('account-email').value=account.email;p.get('account-password').value='password';p.get('account-form').fire('submit');await settle();
  assert.equal(p.calls.find(call=>call.navigate)?.navigate,'https://sundollworld.com/');
});

test('an existing login opens its spaces even from the register link', async () => {
  const p = page({hash:'#register', api:{session:{ok:true,account}, rooms:{ok:true,rooms:[room]}}});
  await settle();
  assert.equal(p.get('account-auth').hidden, true);
  assert.equal(p.get('account-dashboard').hidden, false);
  assert.equal(p.get('room-list').children[0].children[2].href, '/rooms/' + room.id + '/');
  assert.equal(p.get('room-list').attrs['aria-busy'], 'false');
});

test('a pending room invitation survives refresh and is consumed only after acceptance', async () => {
  const memory = new Map();
  const first = page({hash:'#room=invitation-123', memory}); await settle();
  assert.equal(first.get('account-invitation-notice').hidden, false);
  const p = page({memory, api:{login:{ok:true,account}, rooms:{ok:true,rooms:[]}}}); await settle();
  assert.equal(p.get('account-invitation-notice').hidden, false);
  p.get('account-email').value = account.email; p.get('account-password').value = 'a long test passphrase';
  p.get('account-form').fire('submit'); await settle();
  assert.equal(p.get('accept-room').hidden, false);
  assert.equal(p.calls.some(call => call.action === 'room-accept'), false);
  p.get('accept-room').fire('click'); await settle();
  assert.deepEqual(p.calls.find(call => call.action === 'room-accept').data, {token:'invitation-123'});
  assert.equal(p.get('accept-room').hidden, true);
  assert.equal(memory.has('sundoll-account-pending'), false);
});

test('email verification survives a reload and retains the invitation for the next login', async () => {
  const memory = new Map();
  page({hash:'#room=invitation-123', memory}); await settle();
  page({hash:'#verify=verify-123', memory}); await settle();
  const p = page({memory, api:{verify:{ok:true,message:'邮箱验证成功，现在可以登录了。'}}}); await settle();
  assert.equal(p.get('account-title').textContent, '验证邮箱');
  p.get('account-password').value = 'a long test passphrase'; p.get('account-form').fire('submit'); await settle();
  assert.deepEqual(p.calls.find(call => call.action === 'verify').data.token, 'verify-123');
  assert.equal(p.get('account-title').textContent, '登录账号');
  const pending = JSON.parse(memory.get('sundoll-account-pending'));
  assert.equal(pending.verify, ''); assert.equal(pending.room, 'invitation-123');
});

test('new invitations do not reopen an unrelated pending verification challenge', async () => {
  const memory = new Map([['sundoll-account-pending', JSON.stringify({at:Date.now(),verify:'old-verify'})]]);
  const p = page({hash:'#room=new-invite', memory}); await settle();
  assert.equal(p.get('account-title').textContent, '登录账号');
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).verify, '');
});

test('a failed space read offers retry and an expired session removes stale private controls', async () => {
  let reads = 0;
  const p = page({api:{session:{ok:true,account}, rooms:() => ++reads === 1 ? {ok:false,status:503,error:'暂时不可用'} : reads === 2 ? {ok:true,rooms:[room]} : {ok:false,status:401,error:'请先登录'}}}); await settle();
  assert.equal(p.get('room-status').dataset.error, 'true');
  assert.equal(p.get('room-refresh').disabled, false);
  p.get('room-refresh').fire('click'); await settle();
  assert.equal(p.get('room-list').children.length, 1);
  p.get('room-refresh').fire('click'); await settle();
  assert.equal(p.get('account-dashboard').hidden, true);
  assert.equal(p.get('room-list').children.length, 0);
  assert.equal(p.get('identity-email').textContent, '');
  assert.match(p.get('account-status').textContent, /登录已失效/);
});

test('owner profile binding requires two explicit choices and never preselects a matching name', async () => {
  let bound = false;
  const p = page({api:{session:{ok:true,account}, rooms:{ok:true,rooms:[room]}, 'room-members':{ok:true,members:[{accountId:'a-owner',name:'主持人',email:account.email,role:'owner'},{accountId:'a-member',name:'旧名字',email:'member@example.test',role:'player'}]}, 'room-profiles':() => ({ok:true,profiles:[{playerId:'p-linked',name:'主持人',enabled:true,accountId:'a-owner'},{playerId:'p-legacy',name:'旧名字',enabled:true,...(bound ? {accountId:'a-member'} : {})},{playerId:'p-disabled',name:'停用',enabled:false}]}), 'room-bind-player':data => { bound = true; return {ok:true,profile:{playerId:data.playerId,accountId:data.accountId,enabled:true,name:'旧名字'}}; }}}); await settle();
  manage(p).fire('click'); await settle();
  assert.equal(p.get('bind-member').value, ''); assert.equal(p.get('bind-player').value, '');
  assert.equal(p.get('room-bind-submit').disabled, true);
  assert.equal(p.get('bind-member').children.length, 3);
  assert.equal(p.get('bind-player').children.length, 2);
  assert.equal(p.calls.some(call => call.action === 'room-bind-player'), false);
  p.get('bind-member').value = 'a-member'; p.get('bind-member').fire('change');
  p.get('bind-player').value = 'p-legacy'; p.get('bind-player').fire('change');
  assert.equal(p.get('room-bind-submit').disabled, false);
  p.get('room-bind-form').fire('submit'); await settle();
  assert.deepEqual(p.calls.find(call => call.action === 'room-bind-player').data, {roomId:room.id,accountId:'a-member',characterId:'p-legacy'});
  assert.equal(p.get('room-bind-form').hidden, true);
  assert.equal(p.get('room-bind-submit').disabled, true);
});

test('switching owner spaces clears invitation links from the previous space', async () => {
  const second = {...room,id:'r'+'2'.repeat(32),name:'另一小队'};
  const p = page({api:{session:{ok:true,account}, rooms:{ok:true,rooms:[room,second]}, 'room-members':{ok:true,members:[]}, 'room-profiles':{ok:true,profiles:[]}, 'room-invite':{ok:true,invitationUrl:'https://example.test/account#room=secret'}}}); await settle();
  manage(p).fire('click'); await settle();
  p.get('room-invite-form').fire('submit'); await settle();
  assert.equal(p.get('room-invitation').value, 'https://example.test/account#room=secret');
  manage(p,1).fire('click'); await settle();
  assert.equal(p.get('room-invitation').hidden, true);
  assert.equal(p.get('room-invitation').value, '');
  assert.equal(p.get('room-management-title').textContent, '另一小队 · 成员');
  p.get('room-management-close').fire('click');
  assert.equal(p.get('room-management').hidden, true);
});

test('player membership never exposes owner member or profile binding controls', async () => {
  const p = page({api:{session:{ok:true,account}, rooms:{ok:true,rooms:[{...room,role:'player'}]}}}); await settle();
  assert.equal(manage(p), undefined);
  assert.equal(p.get('room-management').hidden, true);
  assert.equal(p.calls.some(call => call.action === 'room-profiles'), false);
  assert.equal(p.get('room-list').children[0].children[2].textContent, '进入玩家端 →');
});

test('legacy single-workspace account binding remains available when spaces are disabled', async () => {
  const p = page({hash:'#bind=legacy-invite', api:{config:{ok:true,enabled:true,emailReady:true,roomsEnabled:false}, session:{ok:true,account:{...account,playerId:'p-existing'}}}}); await settle();
  assert.equal(p.get('campaign-rooms').hidden, true);
  assert.equal(p.get('profile-ready').hidden, false);
  assert.equal(p.get('bind-profile').hidden, true);
  assert.match(p.get('account-status').textContent, /不能覆盖绑定/);
  assert.equal(p.calls.some(call => call.action === 'rooms'), false);
});

test('password recovery clears a previous password and sends only the email', async () => {
  const p = page({api:{forgot:{ok:true,challenge:'reset-code-1',purpose:'reset',resendAfter:60,expiresIn:600}}}); await settle();
  p.get('account-password').value = 'previous secret'; p.get('account-email').value = account.email;
  p.get('mode-forgot').fire('click');
  assert.equal(p.get('account-password').value, '');
  p.get('account-form').fire('submit'); await settle();
  assert.deepEqual(p.calls.find(call => call.action === 'forgot').data, {email:account.email,delivery:'code'});
  assert.equal(p.get('code-field').hidden,false);
});

test('the DM profile shortcut opens owner management after login and clears the pending intent', async () => {
  const memory = new Map();
  page({hash:'#manage='+room.id,memory}); await settle();
  const p = page({memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-members':{ok:true,members:[]},'room-profiles':{ok:true,profiles:[]}}}); await settle();
  p.get('account-form').fire('submit'); await settle();
  assert.equal(p.get('room-management').hidden, false);
  assert.equal(p.get('room-management-title').textContent, room.name+' · 成员');
  assert.equal(memory.has('sundoll-account-pending'), false);
});

test('the DM profile shortcut never grants management to a regular DM or player', async () => {
  const p = page({hash:'#manage='+room.id,api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'dm'}]}}}); await settle();
  assert.equal(p.get('room-management').hidden, true);
  assert.equal(p.calls.some(call => call.action === 'room-members' || call.action === 'room-profiles'), false);
  assert.match(p.get('account-status').textContent, /只有房主/);
});

test('account login and logout publish identity changes without erasing recovery caches', async () => {
  const localMemory = new Map([['room:old:account:private:campaign','saved recovery']]);
  const p = page({localMemory,api:{session:{ok:true,account},rooms:{ok:true,rooms:[]}}}); await settle();
  assert.equal(localMemory.get('sundoll-active-account'), account.accountId);
  p.get('account-logout').fire('click'); await settle();
  assert.equal(localMemory.get('sundoll-active-account'), '');
  assert.equal(localMemory.get('room:old:account:private:campaign'), 'saved recovery');
  const next = {...account,accountId:'a-other',email:'other@example.test'};
  page({localMemory,api:{session:{ok:true,account:next},rooms:{ok:true,rooms:[]}}}); await settle();
  assert.equal(localMemory.get('sundoll-active-account'),next.accountId);
});

test('a previous account dashboard hides stale identity after a different tab logs in', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]}}}); await settle();
  p.localMemory.set('sundoll-active-account','a-other');
  p.emitStorage('sundoll-active-account','a-other');
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.equal(p.get('identity-email').textContent,'');
  assert.equal(p.get('room-list').children.length,0);
  assert.equal(p.localMemory.get('sundoll-active-account'),'a-other');
  assert.match(p.get('account-status').textContent,/其他页面切换/);
});

test('late private responses cannot restore the old account dashboard after a tab switch', async () => {
  let complete;
  const p=page({api:{session:() => new Promise(resolve => { complete=resolve; }),rooms:{ok:true,rooms:[room]}}}); await settle();
  p.localMemory.set('sundoll-active-account','a-other');
  complete({ok:true,account}); await settle();
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.equal(p.get('identity-email').textContent,'');
  assert.equal(p.localMemory.get('sundoll-active-account'),'a-other');
  assert.equal(p.calls.some(call=>call.action==='rooms'),false);
});

test('password reset invalidates the browser identity marker', async () => {
  const localMemory=new Map([['sundoll-active-account','a-previous']]);
  const p=page({hash:'#reset=reset-challenge',localMemory,api:{reset:{ok:true,message:'密码已更新'}}}); await settle();
  p.get('account-password').value=p.get('account-confirm').value='new test passphrase';
  p.get('account-form').fire('submit'); await settle();
  assert.equal(localMemory.get('sundoll-active-account'),'');
  assert.equal(p.get('account-title').textContent,'登录账号');
});

test('private account requests carry the displayed identity and server mismatches hide stale controls', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-create':{ok:false,status:409,error:'邮箱账号已变化，请重新进入'}}}); await settle();
  assert.equal(p.calls.find(call=>call.action==='rooms').headers['X-Sundoll-Expected-Account'],account.accountId);
  assert.equal(p.calls.find(call=>call.action==='config').headers['X-Sundoll-Expected-Account'],undefined);
  p.get('room-name').value='Old account draft';
  p.get('room-create-form').fire('submit'); await settle();
  assert.equal(p.calls.find(call=>call.action==='room-create').headers['X-Sundoll-Expected-Account'],account.accountId);
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.equal(p.get('room-list').children.length,0);
  assert.match(p.get('account-status').textContent,/邮箱账号已变化/);
});

test('an unbound player can wait for old roles without creating or claiming a profile', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},'room-onboarding':{ok:true,player:{state:'unbound',profile:null}}}});await settle();
  p.get('room-list').children[0].children[2].fire('click');await settle();
  assert.equal(p.get('player-onboarding').hidden,false);
  assert.equal(p.calls.some(call=>call.action==='room-start-player'),false);
  p.get('player-wait').fire('click');await settle();
  assert.match(p.get('account-status').textContent,/确认旧角色归属/);
  assert.equal(p.calls.some(call=>call.action==='room-start-player'),false);
  assert.equal(p.calls.some(call=>call.navigate),false);
});

test('only an explicit character selection enters the player page',async()=>{
  let started=false;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},'room-onboarding':()=>({ok:true,player:{state:started?'ready':'unbound',profile:started?{playerId:'p-new'}:null},characters:[{characterId:'o-hero',name:'旅人',level:1,activeRoomId:null}]}),'room-start-player':data=>{started=true;return {ok:true,profile:{playerId:'p-new'}};}}});await settle();
  p.get('room-list').children[0].children[2].fire('click');await settle();
  p.get('player-start').fire('click');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='room-start-player').data,{roomId:room.id,characterId:'o-hero',expectedRoomId:null});
  assert.equal(p.calls.at(-1).navigate,'/rooms/'+room.id+'/主控台/玩家.html');
});

test('legacy binding readiness is rechecked from the server and disabled profiles cannot start over',async()=>{
  let state='unbound';
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},'room-onboarding':()=>({ok:true,player:{state,profile:state==='unbound'?null:{playerId:'p-legacy'}},characters:state==='unbound'?[]:[{characterId:'o-legacy',name:'旧角色',enabled:state==='ready',level:2,activeRoomId:room.id}]})}});await settle();
  p.get('room-list').children[0].children[2].fire('click');await settle();
  state='disabled';p.get('player-recheck').fire('click');await settle();
  assert.equal(p.get('player-start').hidden,true);
  state='ready';p.get('player-recheck').fire('click');await settle();
  assert.equal(p.get('player-start').hidden,false);
  assert.equal(p.calls.some(call=>call.navigate),false);
  assert.equal(p.calls.some(call=>call.action==='room-start-player'),false);
});

test('owner migration lists individual characters and allows multiple roles for one account',async()=>{
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-onboarding':{ok:true,player:{state:'ready'},characters:[],migration:{profiles:[],characters:[{characterId:'o-old',name:'旧角色',accountId:null},{characterId:'o-linked',name:'已认领角色',accountId:account.accountId}],members:[{accountId:account.accountId,name:'创建者',email:account.email,role:'owner'}]}}}});await settle();
  manage(p).fire('click');await settle();
  const texts=p.get('room-migration-list').children.map(node=>node.textContent).join('\n');
  assert.match(texts,/旧角色 · 等待认领/);assert.match(texts,/已认领角色 · 创建者/);
  assert.match(p.get('room-migration-summary').textContent,/待认领 1 个/);
  assert.equal(p.get('bind-member').children.length,2);
  assert.equal(p.get('room-migration-continue').href,'/rooms/'+room.id+'/主控台/主控台.html');
});

test('logout carries the displayed identity and cannot clear a replacement login after a late response', async () => {
  let complete;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},logout:()=>new Promise(resolve=>{complete=resolve;})}});
  await settle();
  p.get('account-logout').fire('click'); await settle();
  assert.equal(p.calls.find(call=>call.action==='logout').headers['X-Sundoll-Expected-Account'],account.accountId);
  p.localMemory.set('sundoll-active-account','a-new-account');
  complete({ok:true}); await settle();
  assert.equal(p.localMemory.get('sundoll-active-account'),'a-new-account');
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.match(p.get('account-status').textContent,/其他页面切换/);
});

const signupChallenge = {ok:true,challenge:'signup-1',purpose:'verify',expiresIn:600,resendAfter:60};
async function registerDraft(p, password='ab') {
  p.get('account-name').value='测试冒险者'; p.get('account-email').value='new@example.test';
  p.get('account-password').value=p.get('account-confirm').value=password;
  p.get('account-form').fire('submit'); await settle();
}

test('ordinary login returns to the main page without reading all rooms first', async () => {
  const p=page({api:{login:{ok:true,account}}});await settle();
  p.get('account-form').fire('submit');await settle();
  assert.equal(p.calls.at(-1).navigate,'https://sundollworld.com/');
  assert.equal(p.calls.some(call=>call.action==='rooms'),false);
  assert.equal(p.localMemory.get('sundoll-active-account'),account.accountId);
});

test('explicit personal homepage keeps login in the room dashboard', async () => {
  const p=page({hash:'#dashboard',api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
  p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('account-title').textContent,'我的主页');
  assert.equal(p.get('account-dashboard').hidden,false);
  assert.equal(p.calls.some(call=>call.navigate),false);
  assert.equal(p.get('account-home').href,'https://sundollworld.com/');
  assert.equal(p.get('room-list').children[0].children[1].textContent,'房主 · DM');
  assert.equal(p.get('room-list').children[0].children[3].tagName,'DETAILS');
});

test('return targets allow main-site paths and reject unrelated origins or credentials', async () => {
  for (const [target,expected] of [
    ['/#guestbook-section','https://sundollworld.com/#guestbook-section'],
    ['https://sundollworld.com/about.html','https://sundollworld.com/about.html'],
    ['https://evil.example/account','https://sundollworld.com/'],
    ['https://user@sundollworld.com/about.html','https://sundollworld.com/'],
    ['javascript:alert(1)','https://sundollworld.com/'],
    ['http://sundollworld.com/','https://sundollworld.com/'],
    ['https://sundollworld.com.evil.example/','https://sundollworld.com/'],
  ]) {
    const p=page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),api:{login:{ok:true,account}}});await settle();
    p.get('account-form').fire('submit');await settle();
    assert.equal(p.calls.at(-1).navigate,expected);
  }
});

test('HTTP loopback return is only available from a loopback account page', async () => {
  for (const [origin,expected] of [['http://127.0.0.1:8090','http://localhost:9000/'],['https://pl.sundollworld.com','https://sundollworld.com/']]) {
    const p=page({url:origin+'/account?return='+encodeURIComponent('http://localhost:9000/'),api:{login:{ok:true,account}}});await settle();
    p.get('account-form').fire('submit');await settle();assert.equal(p.calls.at(-1).navigate,expected);
  }
});

test('registration advances to an inline code step and logs in without storing the password', async () => {
  const p=page({hash:'#register',api:{register:signupChallenge,'verify-code':{ok:true,account}}});await settle();await registerDraft(p);
  assert.deepEqual(p.calls.find(call=>call.action==='register').data,{email:'new@example.test',name:'测试冒险者',password:'ab',delivery:'code'});
  assert.equal(p.get('code-field').hidden,false);assert.equal(p.get('password-field').hidden,true);
  assert.match(p.get('code-destination').textContent,/new@example.test/);
  assert.equal(p.get('account-password').value,'ab');
  assert.equal([...p.memory.values()].some(value=>value.includes('"password"')),false);
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='verify-code').data,{challenge:'signup-1',code:'123456'});
  assert.equal(p.calls.at(-1).navigate,'https://sundollworld.com/');
  assert.equal(p.get('account-password').value,'');
});

test('wrong or expired codes retain registration drafts and allow a deliberate resend', async () => {
  for (const errorCode of ['code_invalid','code_attempts','code_expired']) {
    const p=page({hash:'#register',api:{register:signupChallenge,'verify-code':{ok:false,status:400,error:'验证码不可用，请重试',errorCode},'resend-code':{...signupChallenge,challenge:'signup-2'}}});await settle();await registerDraft(p);
    p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();
    assert.equal(p.get('account-password').value,'ab');assert.equal(p.get('account-code').value,'123456');
    assert.equal(p.get('code-field').hidden,false);assert.equal(p.calls.some(call=>call.navigate),false);
    p.advance(60000);p.get('code-resend').fire('click');await settle();
    assert.deepEqual(p.calls.find(call=>call.action==='resend-code').data,{challenge:'signup-1'});
    assert.equal(p.get('account-code').value,'');
  }
});

test('resending observes the countdown and uses only the newly returned challenge', async () => {
  const p=page({hash:'#register',api:{register:signupChallenge,'resend-code':{...signupChallenge,challenge:'signup-2'},'verify-code':{ok:true,account}}});await settle();await registerDraft(p);
  assert.equal(p.get('code-resend').disabled,true);assert.match(p.get('code-resend').textContent,/60/);
  p.get('code-resend').fire('click');await settle();assert.equal(p.calls.filter(call=>call.action==='resend-code').length,0);
  p.advance(59000);assert.match(p.get('code-resend').textContent,/1 秒/);p.advance(1000);assert.equal(p.get('code-resend').disabled,false);
  p.get('code-resend').fire('click');await settle();assert.equal(p.get('code-resend').disabled,true);
  p.get('account-code').value='654321';p.get('account-form').fire('submit');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='verify-code').data,{challenge:'signup-2',code:'654321'});
});

test('server resend cooldown is shown without discarding a usable challenge or password', async () => {
  let sends=0;
  const p=page({hash:'#register',api:{register:signupChallenge,'resend-code':()=>++sends===1?{ok:false,status:429,error:'请稍后重发',errorCode:'code_cooldown',retryAfter:30}:{...signupChallenge,challenge:'signup-2'}}});await settle();await registerDraft(p);p.advance(60000);
  p.get('code-resend').fire('click');await settle();assert.equal(p.get('account-password').value,'ab');assert.match(p.get('code-resend').textContent,/30 秒/);
  p.advance(30000);p.get('code-resend').fire('click');await settle();
  assert.deepEqual(p.calls.filter(call=>call.action==='resend-code').map(call=>call.data),[{challenge:'signup-1'},{challenge:'signup-1'}]);
});

test('editing the email returns to the draft and failed sends never clear it', async () => {
  let sends=0;
  const p=page({hash:'#register',api:{register:()=>++sends===1?signupChallenge:{ok:false,status:503,error:'发信失败'}}});await settle();await registerDraft(p);
  p.get('code-back').fire('click');assert.equal(p.get('email-field').hidden,false);
  assert.equal(p.get('account-name').value,'测试冒险者');assert.equal(p.get('account-password').value,'ab');
  p.get('account-email').value='changed@example.test';p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('account-password').value,'ab');assert.equal(p.get('account-email').value,'changed@example.test');
  assert.equal(p.get('code-field').hidden,true);assert.match(p.get('account-status').textContent,/发信失败/);
});

test('new registration and reset enforce 2–256 characters and require matching confirmation', async () => {
  const p=page({hash:'#register',api:{register:signupChallenge}});await settle();
  await registerDraft(p,'a');assert.equal(p.calls.some(call=>call.action==='register'),false);
  await registerDraft(p,'🧙');assert.equal(p.calls.some(call=>call.action==='register'),false);
  await registerDraft(p,'a'.repeat(257));assert.equal(p.calls.some(call=>call.action==='register'),false);
  p.get('account-password').value='ab';p.get('account-confirm').value='ac';p.get('account-form').fire('submit');await settle();
  assert.equal(p.calls.some(call=>call.action==='register'),false);
  await registerDraft(p,'a'.repeat(256));assert.equal(p.get('code-field').hidden,false);
  p.get('account-code').value='abc123';p.get('account-form').fire('submit');await settle();assert.equal(p.calls.some(call=>call.action==='verify-code'),false);
});

test('inline reset submits code and new password, preserves errors, and returns to login', async () => {
  let resets=0;
  const localMemory=new Map([['sundoll-active-account','a-old']]);
  const p=page({localMemory,api:{forgot:{...signupChallenge,challenge:'reset-1',purpose:'reset'},'reset-code':()=>++resets===1?{ok:false,status:400,error:'验证码错误',errorCode:'code_invalid'}:{ok:true,message:'密码已更新'}}});await settle();
  p.get('mode-forgot').fire('click');p.get('account-email').value=account.email;p.get('account-form').fire('submit');await settle();
  p.get('account-code').value='123456';p.get('account-password').value=p.get('account-confirm').value='xy';
  p.get('account-form').fire('submit');await settle();assert.equal(p.get('account-password').value,'xy');
  p.get('account-form').fire('submit');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='reset-code').data,{challenge:'reset-1',code:'123456',password:'xy'});
  assert.equal(p.get('account-title').textContent,'登录账号');assert.equal(p.localMemory.get('sundoll-active-account'),'');
  assert.equal(p.calls.some(call=>call.navigate),false);
});

test('a timed-out verification write is not automatically retried or reported as a definite failure', async () => {
  const p=page({hash:'#register',api:{register:signupChallenge,'verify-code':(data,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{name:'AbortError'}))))}});await settle();await registerDraft(p);
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();p.advance(20000);await settle();
  assert.match(p.get('account-status').textContent,/可能已完成/);assert.equal(p.get('account-password').value,'ab');
  p.advance(120000);await settle();assert.equal(p.calls.filter(call=>call.action==='verify-code').length,1);
});

test('late authentication cannot publish or redirect over an account switched in another tab', async () => {
  let complete;
  const p=page({api:{login:()=>new Promise(resolve=>{complete=resolve;})}});await settle();
  p.get('account-form').fire('submit');await settle();p.localMemory.set('sundoll-active-account','a-new');complete({ok:true,account});await settle();
  assert.equal(p.localMemory.get('sundoll-active-account'),'a-new');assert.equal(p.calls.some(call=>call.navigate),false);
  assert.match(p.get('account-status').textContent,/其他页面切换/);
});

test('shared invites survive registration and require one explicit join confirmation', async () => {
  const memory=new Map();page({hash:'#join=share-1',memory});await settle();
  const p=page({hash:'#register',memory,api:{register:signupChallenge,'verify-code':{ok:true,account},rooms:{ok:true,rooms:[]},'room-join':{ok:true,room:{...room,role:'player'}}}});await settle();await registerDraft(p);
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('account-title').textContent,'我的主页');assert.equal(p.get('accept-room').hidden,false);
  assert.equal(p.calls.some(call=>call.action==='room-join'),false);assert.equal(p.calls.some(call=>call.navigate),false);
  p.get('accept-room').fire('click');await settle();assert.deepEqual(p.calls.find(call=>call.action==='room-join').data,{token:'share-1'});
  assert.equal(memory.has('sundoll-account-pending'),false);assert.equal(p.get('accept-room').hidden,true);
});

test('shared and directed invitations reuse one confirmation and new links replace the other kind', async () => {
  const memory=new Map([['sundoll-account-pending',JSON.stringify({at:Date.now(),room:'old-directed',verify:'old-verify'})]]);
  const p=page({hash:'#join=new-share',memory,api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-join':{ok:false,status:410,error:'链接已过期'}}});await settle();
  p.get('accept-room').fire('click');await settle();
  assert.equal(p.calls.some(call=>call.action==='room-accept'),false);assert.equal(p.get('accept-room').hidden,false);
  const pending=JSON.parse(memory.get('sundoll-account-pending'));assert.equal(pending.room,'');assert.equal(pending.verify,'');assert.equal(pending.join,'new-share');
});

test('pasted player invitation links only accept the current account origin and path', async () => {
  const p=page({url:'https://pl.sundollworld.com/account',api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-join':{ok:true,room}}});await settle();
  for(const link of ['https://evil.example/account#join=t','https://user@pl.sundollworld.com/account#join=t','https://pl.sundollworld.com/other#join=t','https://pl.sundollworld.com/account?x=1#join=t','https://pl.sundollworld.com/account#room=t','http://pl.sundollworld.com/account#join=t','https://pl.sundollworld.com/account#join=t&extra=x']) {
    p.get('room-join-url').value=link;p.get('room-join-form').fire('submit');await settle();
    assert.equal(p.calls.some(call=>call.action==='room-join'),false);assert.equal(p.get('room-join-url').value,link);
  }
  p.get('room-join-url').value='https://pl.sundollworld.com/account#join=valid-token';p.get('room-join-form').fire('submit');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='room-join').data,{token:'valid-token'});assert.equal(p.get('room-join-url').value,'');
});

test('loopback shared link preview uses the same strict account origin rule', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-join':{ok:true,room}}});await settle();
  p.get('room-join-url').value='http://localhost:8090/account#join=wrong-origin';p.get('room-join-form').fire('submit');await settle();assert.equal(p.calls.some(call=>call.action==='room-join'),false);
  p.get('room-join-url').value='http://127.0.0.1:8090/account#join=local-token';p.get('room-join-form').fire('submit');await settle();assert.deepEqual(p.calls.find(call=>call.action==='room-join').data,{token:'local-token'});
});

test('only owners can share, copy with a fallback, and revoke a player invitation', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room,{...room,id:'r-dm',role:'dm'},{...room,id:'r-player',role:'player'}]},'room-share':{ok:true,invitationUrl:'http://127.0.0.1:8090/account#join=shared-token',expiresAt:1}}});await settle();
  assert.equal(roomAction(p,'分享玩家邀请',1),undefined);assert.equal(roomAction(p,'分享玩家邀请',2),undefined);
  roomAction(p,'分享玩家邀请').fire('click');await settle();assert.deepEqual(p.calls.find(call=>call.action==='room-share').data,{roomId:room.id});
  assert.equal(p.get('room-share-panel').hidden,false);p.get('room-share-copy').fire('click');await settle();assert.equal(p.get('room-share-url').selected,true);
  p.get('room-share-revoke').fire('click');await settle();assert.deepEqual(p.calls.find(call=>call.action==='room-share-revoke').data,{roomId:room.id});
  assert.equal(p.get('room-share-panel').hidden,true);assert.equal(p.get('room-share-url').value,'');
});

test('failed join or share keeps a clear retry path without changing membership optimistically', async () => {
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-share':{ok:false,status:503,error:'分享暂不可用'},'room-join':{ok:false,status:403,error:'请让创建者定向邀请'}}});await settle();
  roomAction(p,'分享玩家邀请').fire('click');await settle();assert.equal(p.get('room-share-panel').hidden,true);
  assert.equal(roomAction(p,'分享玩家邀请').disabled,false);
  p.get('room-join-url').value='http://127.0.0.1:8090/account#join=blocked-token';p.get('room-join-form').fire('submit');await settle();
  assert.match(p.get('account-status').textContent,/定向邀请/);assert.equal(p.get('room-join-url').value,'http://127.0.0.1:8090/account#join=blocked-token');
  assert.equal(p.get('room-list').children.length,1);
});

test('registration preserves a safe return even while removing the register fragment from the address', async () => {
  const p=page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent('/#guestbook-section'),hash:'#register',api:{register:signupChallenge,'verify-code':{ok:true,account}}});await settle();await registerDraft(p);
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();
  assert.equal(p.calls.at(-1).navigate,'https://sundollworld.com/#guestbook-section');
});

test('an explicit personal homepage intent survives a reload until authentication completes', async () => {
  const memory=new Map();page({hash:'#dashboard',memory});await settle();
  const p=page({memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[]}}});await settle();p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('account-dashboard').hidden,false);assert.equal(p.calls.some(call=>call.navigate),false);
  assert.equal(memory.has('sundoll-account-pending'),false);
});

test('a failed resend preserves the original challenge until a new send actually succeeds', async () => {
  const p=page({hash:'#register',api:{register:signupChallenge,'resend-code':{ok:false,status:503,error:'发信失败'},'verify-code':{ok:true,account}}});await settle();await registerDraft(p);p.advance(60000);
  p.get('code-resend').fire('click');await settle();assert.equal(p.get('account-password').value,'ab');
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();
  assert.deepEqual(p.calls.find(call=>call.action==='verify-code').data,{challenge:'signup-1',code:'123456'});
});

test('a late successful code verification cannot redirect or publish over a replacement account', async () => {
  let complete;
  const p=page({hash:'#register',api:{register:signupChallenge,'verify-code':()=>new Promise(resolve=>{complete=resolve;})}});await settle();await registerDraft(p);
  p.get('account-code').value='123456';p.get('account-form').fire('submit');await settle();p.localMemory.set('sundoll-active-account','a-replacement');complete({ok:true,account});await settle();
  assert.equal(p.localMemory.get('sundoll-active-account'),'a-replacement');assert.equal(p.calls.some(call=>call.navigate),false);
  assert.equal(p.get('account-password').value,'');assert.equal(p.get('account-title').textContent,'登录账号');
});

test('an expired pending invitation offers a single confirmation and can return to pasting another link', async () => {
  const memory=new Map();
  const p=page({hash:'#join=expired-token',memory,api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-join':{ok:false,status:410,error:'邀请已过期'}}});await settle();
  assert.equal(p.get('room-join-form').hidden,true);p.get('accept-room').fire('click');await settle();
  assert.equal(p.get('room-join-confirm').hidden,false);assert.match(p.get('account-status').textContent,/过期/);
  p.get('room-invite-change').fire('click');assert.equal(p.get('room-join-form').hidden,false);assert.equal(p.get('room-join-confirm').hidden,true);
  assert.equal(memory.has('sundoll-account-pending'),false);
});

test('registration code refresh restores only verification metadata and its remaining resend budget', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({hash:'#register',memory,now,api:{register:signupChallenge}});await settle();await registerDraft(first,'PRIVATE_PASSWORD');
  first.get('account-code').value='987654';
  const stored=JSON.parse(memory.get('sundoll-account-pending')).code;
  assert.deepEqual(Object.keys(stored).sort(),['codeExpiresAt','email','expiresAt','purpose','resendAt','token']);
  assert.equal(stored.email,'new@example.test');assert.equal(stored.purpose,'verify');
  assert.equal(stored.expiresAt,now+3600000);assert.equal(stored.codeExpiresAt,now+600000);
  assert.equal([...memory.values()].some(value=>value.includes('PRIVATE_PASSWORD')||value.includes('987654')),false);
  const restored=page({memory,now:now+30000});await settle();
  assert.equal(restored.get('account-title').textContent,'验证邮箱');assert.equal(restored.get('code-field').hidden,false);
  assert.equal(restored.get('account-password').value,'');assert.equal(restored.get('account-confirm').value,'');assert.equal(restored.get('account-code').value,'');
  assert.equal(restored.get('account-email').value,'new@example.test');assert.match(restored.get('code-resend').textContent,/30 秒/);
  assert.equal(restored.calls.some(call=>['register','forgot','resend-code','verify-code'].includes(call.action)),false);
});

test('inline reset refresh restores the code step but never the new password or entered code', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({memory,now,api:{forgot:{...signupChallenge,challenge:'reset-refresh',purpose:'reset'}}});await settle();
  first.get('mode-forgot').fire('click');first.get('account-email').value=account.email;first.get('account-form').fire('submit');await settle();
  first.get('account-password').value=first.get('account-confirm').value='PRIVATE_NEW_PASSWORD';first.get('account-code').value='987654';
  const restored=page({memory,now:now+60000,api:{'reset-code':{ok:true,message:'密码已更新'}}});await settle();
  assert.equal(restored.get('account-title').textContent,'重设密码');assert.equal(restored.get('password-field').hidden,false);
  assert.equal(restored.get('account-email').value,account.email);assert.equal(restored.get('account-password').value,'');assert.equal(restored.get('account-code').value,'');
  assert.equal([...memory.values()].some(value=>value.includes('PRIVATE_NEW_PASSWORD')||value.includes('987654')),false);
  restored.get('account-password').value=restored.get('account-confirm').value='xy';restored.get('account-code').value='123456';restored.get('account-form').fire('submit');await settle();
  assert.deepEqual(restored.calls.find(call=>call.action==='reset-code').data,{challenge:'reset-refresh',code:'123456',password:'xy'});
  assert.equal(memory.has('sundoll-account-pending'),false);assert.equal(restored.get('account-title').textContent,'登录账号');
});

test('code expiry still allows same-page resend while one-hour handle expiry clears the stored step', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({hash:'#register',memory,now,api:{register:signupChallenge}});await settle();await registerDraft(first);
  const tenMinutes=page({memory,now:now+600000});await settle();
  assert.equal(tenMinutes.get('code-field').hidden,false);assert.equal(tenMinutes.get('code-resend').disabled,false);
  tenMinutes.advance(3000000);await settle();
  assert.equal(tenMinutes.get('code-field').hidden,true);assert.equal(tenMinutes.get('account-title').textContent,'创建账号');
  assert.equal(memory.has('sundoll-account-pending'),false);assert.match(tenMinutes.get('account-status').textContent,/过期/);
  const expired=new Map([['sundoll-account-pending',JSON.stringify({at:now,join:'valid-invite',returnTarget:'https://sundollworld.com/#guestbook-section',code:{token:'old-handle',email:account.email,purpose:'verify',expiresAt:now+3600000,codeExpiresAt:now+600000,resendAt:now+60000}})]]);
  const afterHour=page({memory:expired,now:now+3600000});await settle();
  const saved=JSON.parse(expired.get('sundoll-account-pending'));
  assert.equal(saved.code,undefined);assert.equal(saved.join,'valid-invite');assert.equal(saved.returnTarget,'https://sundollworld.com/#guestbook-section');
  assert.equal(afterHour.get('account-title').textContent,'登录账号');
});

test('server resend cooldown survives refresh and failed or malformed resends keep the previous handle', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({hash:'#register',memory,now,api:{register:signupChallenge,'resend-code':{ok:false,status:429,error:'稍后重发',retryAfter:45}}});await settle();await registerDraft(first);first.advance(60000);
  first.get('code-resend').fire('click');await settle();
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).code.resendAt,now+105000);
  const restored=page({memory,now:now+61000,api:{'resend-code':{...signupChallenge,purpose:'reset'},'verify-code':{ok:true,account}}});await settle();
  assert.match(restored.get('code-resend').textContent,/44 秒/);
  restored.get('code-resend').fire('click');await settle();assert.equal(restored.calls.some(call=>call.action==='resend-code'),false);
  restored.advance(44000);restored.get('code-resend').fire('click');await settle();
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).code.token,'signup-1');
  restored.get('account-code').value='123456';restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.calls.find(call=>call.action==='verify-code').data.challenge,'signup-1');assert.equal(memory.has('sundoll-account-pending'),false);
});

test('changing email or choosing login clears the code while preserving safe return and invitations', async () => {
  for(const action of ['code-back','mode-login']) {
    const memory=new Map();
    const p=page({hash:'#register&join=valid-invite',url:'https://pl.sundollworld.com/account?return='+encodeURIComponent('/#guestbook-section'),memory,api:{register:signupChallenge}});await settle();await registerDraft(p);
    p.get(action).fire('click');await settle();
    const saved=JSON.parse(memory.get('sundoll-account-pending'));
    assert.equal(saved.code,undefined);assert.equal(saved.join,'valid-invite');assert.equal(saved.returnTarget,'https://sundollworld.com/#guestbook-section');
    assert.equal(p.get('account-code').value,'');assert.equal(p.get('code-field').hidden,true);
  }
});

test('an authoritative restored session clears stale code state before logout without losing invitations', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({hash:'#register&join=valid-invite',memory,now,api:{register:signupChallenge}});await settle();await registerDraft(first);
  const restored=page({memory,now:now+60000,api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},logout:{ok:true}}});await settle();
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).code,undefined);
  restored.get('account-logout').fire('click');await settle();
  const saved=JSON.parse(memory.get('sundoll-account-pending'));
  assert.equal(saved.code,undefined);assert.equal(saved.join,'valid-invite');assert.equal(restored.get('account-title').textContent,'登录账号');
});

test('safe return survives fragment removal and refresh through registration before navigation', async () => {
  const memory=new Map(), now=1800000000000;
  const first=page({hash:'#register',url:'https://pl.sundollworld.com/account?return='+encodeURIComponent('/#guestbook-section'),memory,now,api:{register:signupChallenge}});await settle();await registerDraft(first);
  assert.equal(first.location.search,'');assert.equal(first.location.hash,'');
  const restored=page({url:first.location.href,memory,now:now+30000,api:{'verify-code':{ok:true,account}}});await settle();
  restored.get('account-code').value='123456';restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.calls.at(-1).navigate,'https://sundollworld.com/#guestbook-section');
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).code,undefined);
});

test('restored return is revalidated against the current origin rather than trusting session storage', async () => {
  const now=1800000000000;
  for(const target of ['https://evil.example/','https://user@sundollworld.com/','javascript:alert(1)','http://localhost:9000/','https://sundollworld.com.evil.example/']) {
    const memory=new Map([['sundoll-account-pending',JSON.stringify({at:now,returnTarget:target})]]);
    const p=page({url:'https://pl.sundollworld.com/account',memory,now,api:{login:{ok:true,account}}});await settle();
    p.get('account-form').fire('submit');await settle();assert.equal(p.calls.at(-1).navigate,'https://sundollworld.com/');
    assert.equal(memory.has('sundoll-account-pending'),false);
  }
  const memory=new Map([['sundoll-account-pending',JSON.stringify({at:now,returnTarget:'https://previous-main.example/'})]]);
  const p=page({url:'https://pl.sundollworld.com/account',mainUrl:'https://new-main.example/',memory,now,api:{login:{ok:true,account}}});await settle();
  p.get('account-form').fire('submit');await settle();assert.equal(p.calls.at(-1).navigate,'https://new-main.example/');
});

test('return links retain the initiating main-site path before login and after a code refresh', async () => {
  const memory = new Map();
  const target = 'https://sundollworld.com/about.html#game';
  const first = page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),hash:'#register',memory,api:{register:signupChallenge}});await settle();
  assert.equal(first.get('account-home').href,target);
  await registerDraft(first);
  const restored = page({url:first.location.href,memory,api:{'verify-code':{ok:true,account}}});await settle();
  assert.equal(restored.get('account-home').href,target);
  restored.get('account-code').value='123456';restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.calls.at(-1).navigate,target);
});

test('a fresh main-site sign-in supersedes an abandoned dashboard intent in the same tab', async () => {
  const memory = new Map();
  page({hash:'#dashboard',memory});await settle();
  const target = 'https://sundollworld.com/#guestbook-section';
  const p = page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),memory,api:{login:{ok:true,account}}});await settle();
  p.get('account-form').fire('submit');await settle();
  assert.equal(p.calls.at(-1).navigate,target);
  assert.equal(p.calls.some(call=>call.action==='rooms'),false);
});

test('dashboard and room intents take precedence over a safe main-site return without joining automatically', async () => {
  for (const intent of ['dashboard','join=shared-token','room=directed-token','manage='+room.id]) {
    const target = 'https://sundollworld.com/#announcements';
    const p = page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),hash:'#'+intent,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
    p.get('account-form').fire('submit');await settle();
    assert.equal(p.get('account-dashboard').hidden,false,intent);
    assert.equal(p.get('account-home').href,target,intent);
    assert.equal(p.calls.some(call=>call.navigate),false,intent);
    assert.equal(p.calls.some(call=>call.action==='room-join'||call.action==='room-accept'),false,intent);
    assert.equal(p.get('room-management').hidden,!intent.startsWith('manage='),intent);
  }
});

test('logging out of a personal homepage keeps its destination for a replacement login and clears all private panels', async () => {
  const next = {...account,accountId:'a-next',name:'下一位冒险者',email:'next@example.test'};
  const memory = new Map();
  const p = page({hash:'#dashboard',memory,api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},login:{ok:true,account:next},'room-share':{ok:true,invitationUrl:'http://127.0.0.1:8090/account#join=private-token'}}});await settle();
  roomAction(p,'分享玩家邀请').fire('click');await settle();
  assert.equal(p.get('room-share-panel').hidden,false);
  p.get('account-logout').fire('click');await settle();
  assert.equal(p.get('account-dashboard').hidden,true);
  assert.equal(p.get('identity-name').textContent,'');
  assert.equal(p.get('identity-email').textContent,'');
  assert.equal(p.get('room-list').children.length,0);
  assert.equal(p.get('room-share-panel').hidden,true);
  assert.equal(p.get('room-share-url').value,'');
  assert.equal(JSON.parse(memory.get('sundoll-account-pending')).dashboard,true);
  p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('account-dashboard').hidden,false);
  assert.equal(p.get('identity-name').textContent,next.name);
  assert.equal(p.calls.some(call=>call.navigate),false);
});

test('an expired dashboard session survives a login-form refresh and returns to the same personal homepage', async () => {
  const memory = new Map();let reads=0;
  const p = page({memory,api:{session:{ok:true,account},rooms:()=>++reads===1?{ok:true,rooms:[room]}:{ok:false,status:401,error:'请先登录'}}});await settle();
  p.get('room-refresh').fire('click');await settle();
  assert.equal(p.get('account-dashboard').hidden,true);
  const restored = page({memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
  restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.get('account-dashboard').hidden,false);
  assert.equal(restored.calls.some(call=>call.navigate),false);
});

test('registering or resetting from an explicit personal-homepage entry preserves dashboard precedence', async () => {
  const url = 'https://pl.sundollworld.com/account?return='+encodeURIComponent('https://sundollworld.com/#adventure');
  const signup = page({url,hash:'#dashboard&register',api:{register:signupChallenge,'verify-code':{ok:true,account},rooms:{ok:true,rooms:[]}}});await settle();await registerDraft(signup);
  signup.get('account-code').value='123456';signup.get('account-form').fire('submit');await settle();
  assert.equal(signup.get('account-dashboard').hidden,false);
  assert.equal(signup.calls.some(call=>call.navigate),false);
  const reset = page({url,hash:'#dashboard',api:{forgot:{...signupChallenge,purpose:'reset'},'reset-code':{ok:true},login:{ok:true,account},rooms:{ok:true,rooms:[]}}});await settle();
  reset.get('mode-forgot').fire('click');reset.get('account-email').value=account.email;reset.get('account-form').fire('submit');await settle();
  reset.get('account-password').value=reset.get('account-confirm').value='xy';reset.get('account-code').value='123456';reset.get('account-form').fire('submit');await settle();
  assert.equal(reset.get('account-title').textContent,'登录账号');
  reset.get('account-password').value='xy';reset.get('account-form').fire('submit');await settle();
  assert.equal(reset.get('account-dashboard').hidden,false);
  assert.equal(reset.calls.some(call=>call.navigate),false);
});

test('auth and dashboard layout state follows restored sessions, logout and cross-tab account changes', async () => {
  const p = page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]}}});await settle();
  assert.equal(p.body.dataset.view,'dashboard');assert.equal(p.get('account-app').dataset.view,'dashboard');
  p.get('account-logout').fire('click');await settle();
  assert.equal(p.body.dataset.view,'auth');assert.equal(p.get('account-app').dataset.view,'auth');
  const switched = page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]}}});await settle();
  switched.localMemory.set('sundoll-active-account','a-replacement');switched.emitStorage('sundoll-active-account','a-replacement');
  assert.equal(switched.body.dataset.view,'auth');assert.equal(switched.get('account-app').dataset.view,'auth');
  assert.equal(switched.get('account-dashboard').hidden,true);
});

test('using the skip-to-content link preserves login, registration and personal-homepage state without a reload', async () => {
  for (const entry of [{},{hash:'#register'},{api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]}}}]) {
    const p = page(entry);await settle();
    const title = p.get('account-title').textContent, dashboardHidden = p.get('account-dashboard').hidden, requests = p.calls.length;
    p.changeHash('#account-app');await settle();
    assert.equal(p.calls.length,requests);
    assert.equal(p.get('account-title').textContent,title);
    assert.equal(p.get('account-dashboard').hidden,dashboardHidden);
    assert.equal(p.location.hash,'#account-app');
  }
});

test('account and invitation links still trigger their navigation after skipping to the content', async () => {
  for (const fragment of ['#register','#dashboard','#join=shared-token','#room=directed-token','#manage='+room.id,'#bind=legacy-token','#verify=verification-token','#reset=reset-token']) {
    const p = page();await settle();
    p.changeHash('#account-app');
    assert.equal(p.calls.some(call=>call.reload),false);
    p.changeHash(fragment);
    assert.equal(p.calls.filter(call=>call.reload).length,1,fragment);
  }
});

test('logout and a refresh of a return-bearing dashboard retain the personal homepage and its main-site return', async () => {
  const memory = new Map(), target = 'https://sundollworld.com/about.html#game';
  const first = page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),memory,api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
  assert.equal(first.get('account-dashboard').hidden,false);
  first.get('account-logout').fire('click');await settle();
  const restored = page({url:first.location.href,memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
  restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.get('account-dashboard').hidden,false);
  assert.equal(restored.get('account-home').href,target);
  assert.equal(restored.calls.some(call=>call.navigate),false);
});

test('a return-bearing dashboard preserves its destination after session expiry and a login-form refresh', async () => {
  const memory = new Map(), target = 'https://sundollworld.com/#announcements';let reads = 0;
  const first = page({url:'https://pl.sundollworld.com/account?return='+encodeURIComponent(target),memory,api:{session:{ok:true,account},rooms:()=>++reads===1?{ok:true,rooms:[room]}:{ok:false,status:401,error:'请先登录'}}});await settle();
  first.get('room-refresh').fire('click');await settle();
  assert.equal(first.get('account-dashboard').hidden,true);
  const restored = page({url:first.location.href,memory,api:{login:{ok:true,account},rooms:{ok:true,rooms:[room]}}});await settle();
  restored.get('account-form').fire('submit');await settle();
  assert.equal(restored.get('account-dashboard').hidden,false);
  assert.equal(restored.get('account-home').href,target);
  assert.equal(restored.calls.some(call=>call.navigate),false);
});


test('room actions reveal and focus one panel, and closing returns to room list', async () => {
 const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},'room-share':{ok:true,invitationUrl:'https://example.test/account#join=preview'}}});await settle();
 roomAction(p,'分享玩家邀请').fire('click');await settle();
 assert.equal(p.get('room-share-panel').hidden,false);assert.equal(p.get('room-share-panel').focused,true);assert.equal(p.get('room-share-panel').scrolled.block,'start');
 manage(p).fire('click');await settle();
 assert.equal(p.get('room-share-panel').hidden,true);assert.equal(p.get('room-management').hidden,false);assert.equal(p.get('room-management').focused,true);
 roomAction(p,'以玩家身份进入').fire('click');await settle();
 assert.equal(p.get('room-management').hidden,true);assert.equal(p.get('player-onboarding').hidden,false);assert.equal(p.get('player-onboarding').focused,true);
 p.get('player-onboarding-close').fire('click');assert.equal(p.get('player-onboarding').hidden,true);assert.equal(p.get('room-list').focused,true);
 assert.equal(p.calls.some(call=>call.action==='room-start-player'),false);
});


test('cross-room character switch requires explicit confirmation and carries the former room',async()=>{
  const other='r'+'2'.repeat(32),hero={characterId:'o-hero',name:'旅人',level:3,activeRoomId:other};
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},characters:{ok:true,characters:[hero]},'room-onboarding':{ok:true,player:{state:'unbound'},characters:[hero]}}});await settle();
  roomAction(p,'进入玩家端 →').fire('click');await settle();
  assert.equal(p.get('character-switch-label').hidden,false);
  p.get('player-start').fire('click');await settle();
  assert.equal(p.calls.some(c=>c.action==='room-start-player'),false);
  p.get('character-switch').checked=true;p.get('player-start').fire('click');await settle();
  assert.deepEqual(p.calls.find(c=>c.action==='room-start-player').data,{roomId:room.id,characterId:hero.characterId,expectedRoomId:other});
});

test('new character retries reuse request identity and logout clears the character list',async()=>{
  let attempts=0;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'character-create':()=>++attempts===1?{ok:false,status:503,error:'重试'}:{ok:true,character:{}}}});await settle();
  p.get('character-name').value='新角色';p.get('character-level').value='1';p.get('character-hp').value='12';p.get('character-ac').value='13';
  p.get('character-create-form').fire('submit');await settle();p.get('character-create-form').fire('submit');await settle();
  const writes=p.calls.filter(c=>c.action==='character-create');assert.equal(writes.length,2);assert.equal(writes[0].data.requestId,writes[1].data.requestId);
  p.get('account-logout').fire('click');await settle();assert.equal(p.get('character-list').children.length,0);
});

test('creating joining and refreshing rooms also updates character room choices',async()=>{
  for (const action of ['room-create','room-join','room-refresh']) {
    let rooms=[room];const next={...room,id:'r'+'2'.repeat(32),name:'新房间'};
    const hero={characterId:'o-hero',name:'旅人',level:1,activeRoomId:room.id};
    const api={session:{ok:true,account},rooms:()=>({ok:true,rooms}),characters:{ok:true,characters:[hero]}};
    api[action]=()=>{rooms=[room,next];return {ok:true,room:next};};
    const p=page({api});await settle();
    if (action==='room-refresh') {rooms=[room,next];p.get(action).fire('click');}
    else if (action==='room-create') {p.get('room-name').value='新房间';p.get('room-create-form').fire('submit');}
    else {p.get('room-join-url').value='http://127.0.0.1:8090/account#join=new-token';p.get('room-join-form').fire('submit');}
    await settle();
    let choice=descendants(p.get('character-list')).find(n=>n.tagName==='SELECT');
    assert.deepEqual(choice.children.map(n=>n.value),[room.id,next.id],action);
    choice.value=next.id;p.get('room-refresh').fire('click');await settle();
    choice=descendants(p.get('character-list')).find(n=>n.tagName==='SELECT');
    assert.equal(choice.value,next.id,action);
    rooms=[room];p.get('room-refresh').fire('click');await settle();
    choice=descendants(p.get('character-list')).find(n=>n.tagName==='SELECT');
    assert.equal(choice.value,room.id,action);
  }
});

test('rechecking onboarding keeps the selected character and resets switch confirmation',async()=>{
  const heroes=[{characterId:'o-one',name:'第一位',level:1},{characterId:'o-two',name:'第二位',level:2,activeRoomId:'another-room'}];
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},characters:{ok:true,characters:heroes},'room-onboarding':{ok:true,characters:heroes}}});await settle();
  roomAction(p,'进入玩家端 →').fire('click');await settle();
  p.get('player-character').value='o-two';p.get('player-character').fire('change');p.get('character-switch').checked=true;
  p.get('player-recheck').fire('click');await settle();
  assert.equal(p.get('player-character').value,'o-two');assert.equal(p.get('character-switch').checked,false);
});

test('refreshing dashboard characters cannot silently alter an open switch confirmation',async()=>{
  const hero={characterId:'o-hero',name:'旅人',level:1,activeRoomId:'old-room'};let latest=hero;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},characters:()=>({ok:true,characters:[latest]}),'room-onboarding':{ok:true,characters:[hero]}}});await settle();
  roomAction(p,'进入玩家端 →').fire('click');await settle();p.get('character-switch').checked=true;
  latest={...hero,activeRoomId:'changed-room'};p.get('character-refresh').fire('click');await settle();
  p.get('player-start').fire('click');await settle();
  assert.equal(p.calls.find(c=>c.action==='room-start-player').data.expectedRoomId,'old-room');
});

test('successful creation with failed list reload is reported as created and has a read-only retry',async()=>{
  let fail=false;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},characters:()=>fail?{ok:false,status:503,error:'断线'}:{ok:true,characters:[]},'character-create':()=>{fail=true;return {ok:true,character:{characterId:'new'}};}}});await settle();
  p.get('character-name').value='新角色';p.get('character-level').value='1';p.get('character-hp').value='12';p.get('character-ac').value='13';
  p.get('character-create-form').fire('submit');await settle();
  assert.match(p.get('account-status').textContent,/角色已创建/);assert.match(p.get('account-status').textContent,/无需再次创建/);
  fail=false;p.get('character-refresh').fire('click');await settle();
  assert.equal(p.calls.filter(c=>c.action==='character-create').length,1);
});

test('stale switch failure refreshes current room and requires a new confirmation',async()=>{
  const hero={characterId:'o-hero',name:'旅人',level:1,activeRoomId:'old-room'};let current=hero;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[{...room,role:'player'}]},characters:{ok:true,characters:[hero]},'room-onboarding':()=>({ok:true,characters:[current]}),'room-start-player':()=>{current={...hero,activeRoomId:'new-room'};return {ok:false,status:409,error:'角色所在房间已变化'};}}});await settle();
  roomAction(p,'进入玩家端 →').fire('click');await settle();p.get('character-switch').checked=true;
  p.get('player-start').fire('click');await settle();
  assert.equal(p.get('character-switch').checked,false);assert.equal(p.calls.filter(c=>c.action==='room-onboarding').length,2);
  assert.equal(p.calls.some(c=>c.navigate),false);assert.match(p.get('account-status').textContent,/已变化/);
});

test('switching accounts cannot repopulate cached characters when the new list fails',async()=>{
  let failed=false;const next={...account,accountId:'a-other',name:'另一账号'};
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},characters:()=>failed?{ok:false,status:503,error:'角色读取失败'}:{ok:true,characters:[{characterId:'private-character',name:'私人的角色',level:1}]},login:{ok:true,account:next}}});await settle();
  p.get('character-name').value='未提交的角色草稿';p.get('account-logout').fire('click');await settle();
  assert.equal(p.get('character-name').value,'');
  failed=true;p.get('account-email').value='other@example.test';p.get('account-password').value='password';p.get('account-form').fire('submit');await settle();
  assert.equal(descendants(p.get('character-list')).some(n=>n.textContent==='私人的角色'),false);
  assert.equal(p.calls.some(c=>c.action==='character-create'),false);
});

test('character onboarding returns focus to the role card after rechecking',async()=>{
  const hero={characterId:'o-hero',name:'旅人',level:1,activeRoomId:room.id};
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},characters:{ok:true,characters:[hero]},'room-onboarding':{ok:true,characters:[hero]}}});await settle();
  descendants(p.get('character-list')).find(n=>n.textContent==='使用此角色参团').fire('click');await settle();
  assert.equal(p.get('player-wait').hidden,true);
  p.get('player-recheck').fire('click');await settle();p.get('player-onboarding-close').fire('click');
  assert.equal(p.get('character-list').focused,true);assert.equal(p.get('player-onboarding').hidden,true);
});

test('character reads and writes freeze the displayed account and reject delayed switched-account results',async()=>{
  for(const action of ['characters','character-create']) {
    let release,delay=false;
    const hero={characterId:'o-private',name:'原账号的角色',level:1};
    const api={session:{ok:true,account},rooms:{ok:true,rooms:[room]},
      characters:()=>delay&&action==='characters'?new Promise(resolve=>{release=resolve;}):{ok:true,characters:[hero]},
      'character-create':()=>new Promise(resolve=>{release=resolve;})};
    const p=page({api});await settle();delay=true;
    if(action==='characters')p.get('character-refresh').fire('click');
    else {p.get('character-name').value='新角色';p.get('character-level').value='1';p.get('character-hp').value='12';p.get('character-ac').value='13';p.get('character-create-form').fire('submit');}
    await settle();
    const request=p.calls.filter(call=>call.action===action).at(-1);
    assert.equal(request.headers['X-Sundoll-Expected-Account'],account.accountId,action);
    p.localMemory.set('sundoll-active-account','a-replacement');
    p.emitStorage('sundoll-active-account','a-replacement');
    const readsBefore=p.calls.filter(call=>call.action==='characters').length;
    release({ok:true,characters:[hero],character:hero});await settle();
    assert.equal(p.get('account-dashboard').hidden,true,action);
    assert.equal(p.get('character-list').children.length,0,action);
    assert.equal(p.calls.filter(call=>call.action==='characters').length,readsBefore,action);
    assert.match(p.get('account-status').textContent,/其他页面切换/,action);
  }
});

test('room failure does not hide characters and the two sections can recover independently',async()=>{
  let failRooms=true;
  const hero={characterId:'o-hero',name:'保留的角色',level:2};
  const p=page({api:{session:{ok:true,account},rooms:()=>failRooms?{ok:false,status:503,error:'房间暂不可用'}:{ok:true,rooms:[room]},characters:{ok:true,characters:[hero]}}});await settle();
  assert.equal(p.get('my-characters').hidden,false);
  assert.equal(p.get('character-status').hidden,true);
  assert.equal(descendants(p.get('character-list')).some(n=>n.textContent===hero.name),true);
  assert.equal(p.get('room-status').dataset.error,'true');
  assert.equal(descendants(p.get('character-list')).some(n=>n.textContent==='先加入或创建房间'),false);
  failRooms=false;descendants(p.get('character-list')).find(n=>n.textContent==='刷新房间列表').fire('click');await settle();
  assert.equal(p.get('room-status').hidden,true);
  assert.equal(descendants(p.get('character-list')).find(n=>n.tagName==='SELECT').children[0].value,room.id);
  assert.equal(p.calls.filter(call=>call.action==='characters').length,1);
});

test('character retry clears its failure and processing copy while keeping available rooms',async()=>{
  let failCharacters=true;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[room]},characters:()=>failCharacters?{ok:false,status:503,error:'角色暂不可用'}:{ok:true,characters:[]}}});await settle();
  assert.equal(p.get('my-characters').hidden,false);
  assert.equal(p.get('character-status').hidden,false);
  assert.equal(p.get('character-status').dataset.error,'true');
  assert.equal(p.get('character-list').children.length,0);
  assert.equal(p.get('room-list').children.length,1);
  failCharacters=false;p.get('character-refresh').fire('click');await settle();
  assert.equal(p.get('character-status').hidden,true);
  assert.equal(p.get('character-list').attrs['aria-busy'],'false');
  assert.equal(p.get('account-status').textContent,'');
  assert.match(p.get('character-list').children[0].textContent,/还没有角色/);
});

test('confirmed create and join operations keep success when the following room read fails',async()=>{
  for(const action of ['room-create','room-join','room-accept']) {
    let fail=false;
    const api={session:{ok:true,account},rooms:()=>fail?{ok:false,status:503,error:'断线'}:{ok:true,rooms:[]}};
    api[action]=()=>{fail=true;return {ok:true,room};};
    const p=page({hash:action==='room-accept'?'#room=email-invite':'',api});await settle();
    if(action==='room-create'){p.get('room-name').value='新房间';p.get('room-create-form').fire('submit');}
    else if(action==='room-join'){p.get('room-join-url').value='http://127.0.0.1:8090/account#join=share-invite';p.get('room-join-form').fire('submit');}
    else p.get('accept-room').fire('click');
    await settle();
    assert.match(p.get('account-status').textContent,action==='room-create'?/房间已创建/:/已加入房间/);
    assert.match(p.get('account-status').textContent,/无需再次提交/);
    fail=false;p.get('room-refresh').fire('click');await settle();
    assert.equal(p.calls.filter(call=>call.action===action).length,1);
    assert.equal(p.get('account-status').textContent,'');
  }
});

test('room creation reuses a persisted receipt after server success with a lost response, including refresh',async()=>{
  for(const refresh of [false,true]) {
    const memory=new Map(),localMemory=new Map(),receipts=new Map();
    let loseResponse=true,created=0;
    const api={session:{ok:true,account},rooms:()=>({ok:true,rooms:[...receipts.values()]}),
      'room-create':(data,options)=>{
        if(!receipts.has(data.requestId)){created++;receipts.set(data.requestId,{...room,name:data.name});}
        if(loseResponse){
          loseResponse=false;
          return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('lost response'),{name:'AbortError'})),{once:true}));
        }
        return {ok:true,room:receipts.get(data.requestId)};
      }};
    let p=page({memory,localMemory,api});await settle();
    p.get('room-name').value='  旅人１号  ';p.get('room-create-form').fire('submit');await settle();
    const first=p.calls.find(call=>call.action==='room-create');
    assert.equal(first.data.name,'旅人1号');
    assert.equal(first.headers['X-Sundoll-Expected-Account'],account.accountId);
    p.advance(20000);await settle();
    assert.match(p.get('account-status').textContent,/可能已完成/);
    assert.equal(p.get('room-create-status').hidden,false);
    assert.equal(created,1);
    if(refresh){
      p=page({memory,localMemory,api});await settle();
      assert.equal(p.get('room-name').value,'旅人1号');
      assert.equal(p.get('room-create-status').hidden,false);
    }
    p.get('room-create-form').fire('submit');await settle();
    const retried=p.calls.filter(call=>call.action==='room-create').at(-1);
    assert.equal(retried.data.requestId,first.data.requestId);
    assert.equal(created,1);
    assert.equal(memory.has('sundoll-room-create:'+account.accountId),false);
    assert.equal(p.get('room-name').value,'');
    assert.equal(p.get('room-create-status').hidden,true);
    // An explicitly requested second room with the same name is a new operation.
    p.get('room-name').value='旅人1号';p.get('room-create-form').fire('submit');await settle();
    assert.notEqual(p.calls.filter(call=>call.action==='room-create').at(-1).data.requestId,first.data.requestId);
    assert.equal(created,2);
  }
});

test('changing a pending room name starts a new operation rather than replaying the old name',async()=>{
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-create':{ok:false,status:503,error:'响应未确认'}}});await settle();
  p.get('room-name').value='第一次';p.get('room-create-form').fire('submit');await settle();
  p.get('room-name').value='第二次';p.get('room-name').fire('input');
  assert.equal(p.get('room-create-status').hidden,true);
  p.get('room-create-form').fire('submit');await settle();
  const calls=p.calls.filter(call=>call.action==='room-create');
  assert.notEqual(calls[0].data.requestId,calls[1].data.requestId);
  assert.equal(calls[1].data.name,'第二次');
});

test('unconfirmed room creation stays scoped to its account across logout and replacement login',async()=>{
  const next={...account,accountId:'a-next',email:'next@example.test'};
  let failed=true;
  const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},login:{ok:true,account:next},
    'room-create':()=>failed?{ok:false,status:503,error:'响应未确认'}:{ok:true,room}}});await settle();
  p.get('room-name').value='同名房间';p.get('room-create-form').fire('submit');await settle();
  const previous=p.calls.find(call=>call.action==='room-create').data.requestId;
  p.get('account-logout').fire('click');await settle();
  assert.equal(p.get('room-name').value,'');
  p.get('account-email').value=next.email;p.get('account-password').value='password';p.get('account-form').fire('submit');await settle();
  assert.equal(p.get('room-name').value,'');
  assert.equal(p.get('room-create-status').hidden,true);
  failed=false;p.get('room-name').value='同名房间';p.get('room-create-form').fire('submit');await settle();
  const latest=p.calls.filter(call=>call.action==='room-create').at(-1);
  assert.notEqual(latest.data.requestId,previous);
  assert.equal(latest.headers['X-Sundoll-Expected-Account'],next.accountId);
  assert.equal(JSON.parse(p.memory.get('sundoll-room-create:'+account.accountId)).requestId,previous);
  assert.equal(p.memory.has('sundoll-room-create:'+next.accountId),false);
});

test('only a definite request-id conflict retires an unconfirmed room attempt',async()=>{
  for(const errorCode of ['ROOM_CREATE_REQUEST_CONFLICT','ROOM_LIMIT']) {
    const p=page({api:{session:{ok:true,account},rooms:{ok:true,rooms:[]},'room-create':{ok:false,status:409,error:'创建未完成',errorCode}}});await settle();
    p.get('room-name').value='原房间';p.get('room-create-form').fire('submit');await settle();
    p.get('room-create-form').fire('submit');await settle();
    const calls=p.calls.filter(call=>call.action==='room-create');
    assert.equal(calls[0].data.requestId===calls[1].data.requestId,errorCode!=='ROOM_CREATE_REQUEST_CONFLICT');
  }
});
