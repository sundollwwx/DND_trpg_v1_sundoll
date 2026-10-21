'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const root=path.resolve(__dirname,'../../网站/主站');
const source=fs.readFileSync(path.join(root,'site-account.js'),'utf8');
const A={id:'board_'+'a'.repeat(32),name:'木木'},B={id:'board_'+'b'.repeat(32),name:'另一位'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};

function setup({url='https://sundollworld.com/',accountBase,identity=null,api,adventure=false}={}){
 const events={},documentEvents={},calls=[],images=[],scriptNavigations=[],timers=new Map();let current=identity,active=null,serial=0;
 const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
 function matches(node,selector){
  const attr=selector.match(/^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if(attr)return(!attr[1]||node.tagName===attr[1].toUpperCase())&&node.hasAttribute(attr[2])&&(attr[3]===undefined||node.getAttribute(attr[2])===attr[3]);
  return node.tagName===selector.toUpperCase();
 }
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.handlers={};this.open=false;this.disabled=false;this._text='';this._hidden=false;}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  contains(node){return node===this||descendants(this).includes(node);}
  get hidden(){return this._hidden;}
  set hidden(value){this._hidden=Boolean(value);if(value&&this.contains(active))active=null;}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set textContent(value){this._text=String(value);this.children=[];}
  setAttribute(key,value){this.attrs[key]=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  hasAttribute(key){return Object.hasOwn(this.attrs,key);}
  get classList(){return{contains:value=>(this.attrs.class||'').split(/\s+/).includes(value)};}
  removeAttribute(key){delete this.attrs[key];}
  querySelector(selector){return descendants(this).find(node=>matches(node,selector))||null;}
  addEventListener(type,handler){(this.handlers[type]||=[]).push(handler);}
  focus(){active=this;}
  fire(type,properties={}){
   const event={target:this,button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};
   event.done=this.disabled?Promise.resolve():Promise.all((this.handlers[type]||[]).map(handler=>handler(event)));
   return event;
  }
 }
 const node=(tag,attrs={})=>{const value=new Element(tag);for(const[key,entry]of Object.entries(attrs))value.setAttribute(key,entry);return value;};
 const header=node('header'),signedOut=node('a',{'data-sundoll-entry':'account','data-site-account-signedout':''}),signedOutIcon=node('svg'),signedOutLabel=node('span',{'data-site-account-link-label':''});signedOutLabel.textContent='登录 / 注册';signedOut.append(signedOutIcon,signedOutLabel);
 const menu=node('details',{'data-site-account-menu':''}),summary=node('summary'),initial=node('span',{'data-site-account-initial':''}),name=node('span',{'data-site-account-name':''}),chevron=node('svg');summary.append(initial,name,chevron);menu.hidden=true;
 const popover=node('div'),popoverName=node('strong',{'data-site-account-name':''}),profile=node('a',{'data-sundoll-entry':'account',class:'account-popover-link'}),profileIcon=node('svg'),profileLabel=node('span',{'data-site-account-link-label':''});profileLabel.textContent='我的主页';profile.append(profileIcon,profileLabel);
 const logout=node('button',{'data-site-account-logout':''}),logoutIcon=node('svg'),logoutLabel=node('span',{'data-site-account-logout-label':''});logoutLabel.textContent='退出登录';logout.append(logoutIcon,logoutLabel);popover.append(popoverName,profile,logout);menu.append(summary,popover);
 const administrator=node('a',{'data-sundoll-entry':'administrator'});administrator.href='https://dm.sundollworld.com/login';header.append(signedOut,menu,administrator);
 const adventureEntry=node('a',{'data-sundoll-entry':'account','data-site-adventure-entry':''}),adventureIcon=node('svg'),adventureLabel=node('span',{'data-site-account-link-label':''}),greeting=node('p',{'data-site-adventure-greeting':''});adventureEntry.append(adventureIcon,adventureLabel);if(adventure)header.append(adventureEntry,greeting);
 const document={get activeElement(){return active;},querySelector(selector){if(selector==='meta[name="account-api"]')return accountBase===undefined?null:{content:accountBase};return descendants(header).find(n=>matches(n,selector))||null;},querySelectorAll:selector=>descendants(header).filter(n=>matches(n,selector)),addEventListener(name,handler){(documentEvents[name]||=[]).push(handler);}};
 const location=new URL(url);location.assign=value=>scriptNavigations.push(value);
 const window={location,addEventListener(name,handler){(events[name]||=[]).push(handler);}};
 const fetch=async(url,options={})=>{
  const call={url:new URL(url),options,body:options.body?JSON.parse(options.body):null};calls.push(call);
  let result=api?await api(call):undefined;
  if(result===undefined)result=call.url.pathname.endsWith('/logout')?{ok:true}:current?{ok:true,identity:current,ticket:'validated-ticket',expiresAt:Math.floor(Date.now()/1000)+300}:{ok:false,httpStatus:401};
  return{ok:!result.httpStatus||result.httpStatus<400,status:result.httpStatus||200,json:async()=>result};
 };
 class Image{constructor(){images.push(this);throw new Error('Navigation must not probe an image');}}
 vm.runInNewContext(source,{window,document,location,URL,Image,Date,AbortController,fetch,setTimeout(fn){timers.set(++serial,fn);return serial;},clearTimeout:key=>timers.delete(key),localStorage:{setItem(){}}});
 return{account:window.SundollSiteAccount,calls,images,scriptNavigations,signedOut,signedOutIcon,signedOutLabel,menu,summary,initial,name,popoverName,profile,profileIcon,profileLabel,logout,logoutIcon,logoutLabel,administrator,adventureEntry,adventureIcon,adventureLabel,greeting,active:()=>active,setCookie:value=>{current=value;},emitDocument(type,properties={}){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...properties};for(const handler of documentEvents[type]||[])handler(event);return event;}};
}

test('home adventure entry keeps dashboard intent across anonymous, validated and logout states',async()=>{
 const p=setup({adventure:true,url:'https://sundollworld.com/#adventure'});await settle();
 const checkTarget=()=>{const target=new URL(p.adventureEntry.href);assert.equal(target.hash,'#dashboard');assert.equal(target.searchParams.get('return'),'https://sundollworld.com/#adventure');assert.equal(p.adventureEntry.hidden,false);assert.equal(p.profile.hidden,true);assert.equal(p.adventureEntry.children[0],p.adventureIcon);};
 checkTarget();assert.equal(p.adventureLabel.textContent,'开始冒险');assert.equal(p.greeting.textContent,'创建房间，或加入朋友的冒险。');assert.equal(new URL(p.signedOut.href).hash,'');
 for(const flags of [{},{ctrlKey:true},{metaKey:true},{button:1}])assert.equal(p.adventureEntry.fire('click',flags).defaultPrevented,false);
 p.adventureEntry.focus();p.setCookie({...A,name:'<木木>'});await p.account.refresh(true);checkTarget();assert.equal(p.adventureLabel.textContent,'进入我的冒险');assert.equal(p.greeting.textContent,'欢迎回来，<木木>。');assert.equal(p.greeting.children.length,0);assert.equal(p.active(),p.adventureEntry);
 await p.account.logout();checkTarget();assert.equal(p.adventureLabel.textContent,'开始冒险');assert.equal(p.greeting.textContent,'创建房间，或加入朋友的冒险。');assert.equal(p.calls.length,4);assert.equal(p.images.length,0);assert.equal(p.scriptNavigations.length,0);
});

test('failed home identity lookup leaves anonymous copy and secondary pages keep their profile entry',async()=>{
 const p=setup({adventure:true,api:()=>({ok:false,httpStatus:503})});await settle();assert.equal(p.adventureLabel.textContent,'开始冒险');assert.equal(p.greeting.textContent,'创建房间，或加入朋友的冒险。');
 for(const page of ['about.html','news.html']){const secondary=setup({url:'https://sundollworld.com/'+page,identity:A});await settle();assert.equal(secondary.profile.hidden,false);assert.equal(secondary.profileLabel.textContent,'我的主页');}
});

test('portal probe code is removed and account links navigate by normal browser clicks immediately',async()=>{
 assert.equal(fs.existsSync(path.join(root,'portal.js')),false);
 const pending=deferred(),p=setup({api:()=>pending.promise});
 for(const flags of [{},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])assert.equal(p.signedOut.fire('click',flags).defaultPrevented,false);
 assert.equal(p.signedOut.hidden,false);assert.equal(p.menu.hidden,true);assert.equal(p.images.length,0);assert.equal(p.scriptNavigations.length,0);
 assert.equal(p.calls.length,1);assert.equal(p.calls[0].url.pathname,'/api/account/site-session');
 assert.equal(new URL(p.signedOut.href).hash,'');assert.equal(new URL(p.signedOut.href).searchParams.get('return'),'https://sundollworld.com/');
 pending.resolve({ok:false,httpStatus:401});await settle();
});

test('all loopback pages preserve the local return intent without a tunnel or an image request',async()=>{
 for(const hostname of ['127.0.0.1','localhost','[::1]']){
  const pageUrl='http://'+hostname+':54320/about.html#credits';const p=setup({url:pageUrl,accountBase:'http://127.0.0.1:54321'});await settle();
  const target=new URL(p.signedOut.href);assert.equal(target.origin,'http://127.0.0.1:54321');assert.equal(target.pathname,'/account');assert.equal(target.hash,'');assert.equal(target.searchParams.get('return'),pageUrl);
  assert.equal(decodeURI(new URL(p.administrator.href).pathname),'/主控台/主控台.html');assert.equal(p.images.length,0);
 }
});

test('a production default meta on a local preview uses the local service before and after identity lookup',async()=>{
 const p=setup({url:'http://localhost:54320/about.html',accountBase:'https://pl.sundollworld.com',identity:A});
 assert.equal(new URL(p.signedOut.href).origin,'http://127.0.0.1:8090');assert.equal(p.calls[0].url.origin,'http://127.0.0.1:8090');await settle();
 assert.equal(new URL(p.profile.href).origin,'http://127.0.0.1:8090');assert.equal(new URL(p.profile.href).hash,'#dashboard');assert.equal(new URL(p.profile.href).searchParams.get('return'),'http://localhost:54320/about.html');
});

test('validated identity shows one profile menu with safe name leaves and a dashboard URL',async()=>{
 const identity={...A,name:'🧙<木木>'},p=setup({identity,url:'https://sundollworld.com/about.html#game'});await settle();
 assert.equal(p.signedOut.hidden,true);assert.equal(p.menu.hidden,false);assert.equal(p.name.textContent,identity.name);assert.equal(p.popoverName.textContent,identity.name);assert.equal(p.initial.textContent,'🧙');
 assert.equal(p.name.getAttribute('title'),identity.name);assert.equal(p.summary.getAttribute('aria-label'),identity.name+'的账号菜单');
 assert.equal(p.name.children.length,0);assert.equal(p.profile.children[0],p.profileIcon);assert.equal(p.signedOut.children[0],p.signedOutIcon);assert.equal(p.summary.children[2].tagName,'SVG');
 const target=new URL(p.profile.href);assert.equal(target.hash,'#dashboard');assert.equal(target.searchParams.get('return'),'https://sundollworld.com/about.html#game');assert.equal(new URL(p.signedOut.href).hash,'');
 assert.equal(p.profile.fire('click').defaultPrevented,false);assert.equal(p.images.length,0);assert.equal(p.scriptNavigations.length,0);
});

test('same-account refresh keeps the native menu open while identity change closes it',async()=>{
 const p=setup({identity:A});await settle();p.menu.open=true;p.profile.focus();await p.account.refresh(true);
 assert.equal(p.menu.open,true);assert.equal(p.active(),p.profile);p.setCookie(B);await p.account.refresh(true);
 assert.equal(p.menu.open,false);assert.equal(p.active(),p.summary);assert.equal(p.name.textContent,B.name);assert.equal(p.popoverName.textContent,B.name);
});

test('outside click closes without stealing focus and Escape restores the summary focus',async()=>{
 const p=setup({identity:A});await settle();p.menu.open=true;p.profile.focus();p.emitDocument('click',{target:p.profile});assert.equal(p.menu.open,true);
 p.emitDocument('click',{target:p.signedOut});assert.equal(p.menu.open,false);assert.equal(p.active(),p.profile);
 p.menu.open=true;const event=p.emitDocument('keydown',{key:'Escape'});assert.equal(event.defaultPrevented,true);assert.equal(p.menu.open,false);assert.equal(p.active(),p.summary);
});

test('expired identity hides controls and moves focus out before browser hidden-node fixup loses it',async()=>{
 const p=setup({identity:A});await settle();p.menu.open=true;p.logout.focus();p.setCookie(null);await p.account.refresh(true);
 assert.equal(p.menu.hidden,true);assert.equal(p.menu.open,false);assert.equal(p.signedOut.hidden,false);assert.equal(p.active(),p.signedOut);assert.equal(p.name.textContent,'');assert.equal(p.popoverName.textContent,'');assert.equal(p.initial.textContent,'');
});

test('anonymous entry focus transfers to the validated menu while unrelated focus is not stolen',async()=>{
 for(const focusEntry of [true,false]){
  const pending=deferred(),p=setup({api:()=>pending.promise});if(focusEntry)p.signedOut.focus();else p.administrator.focus();
  pending.resolve({ok:true,identity:A,ticket:'validated',expiresAt:Math.floor(Date.now()/1000)+300});await settle();
  assert.equal(p.active(),focusEntry?p.summary:p.administrator);assert.equal(p.signedOut.hidden,true);
 }
});

test('logout busy and failure labels preserve the SVG and prevent duplicate clicks',async()=>{
 const pending=deferred(),p=setup({identity:A,api:call=>call.url.pathname.endsWith('/logout')?pending.promise:undefined});await settle();
 const first=p.logout.fire('click');await settle();assert.equal(p.logout.disabled,true);assert.equal(p.logoutLabel.textContent,'正在退出…');assert.equal(p.logout.children[0],p.logoutIcon);
 p.logout.fire('click');assert.equal(p.calls.filter(call=>call.url.pathname.endsWith('/logout')).length,1);pending.resolve({ok:false,httpStatus:503});await first.done;
 assert.equal(p.logout.disabled,false);assert.equal(p.logoutLabel.textContent,'重试退出');assert.equal(p.logout.children[0],p.logoutIcon);assert.equal(p.account.identity().id,A.id);assert.match(p.logout.getAttribute('title'),/账号已变化/);
});

test('successful logout restores the plain sign-in link and retains its icon and return path',async()=>{
 const p=setup({identity:A});await settle();p.menu.open=true;p.logout.focus();await p.logout.fire('click').done;
 assert.equal(p.account.identity(),null);assert.equal(p.menu.hidden,true);assert.equal(p.menu.open,false);assert.equal(p.active(),p.signedOut);assert.equal(p.signedOut.hidden,false);assert.equal(p.logoutLabel.textContent,'退出登录');assert.equal(p.logout.children[0],p.logoutIcon);
 assert.equal(new URL(p.signedOut.href).hash,'');assert.equal(p.signedOut.children[0],p.signedOutIcon);assert.equal(p.images.length,0);
});

test('malformed or failed identity cannot turn a stored-looking nickname into authorization',async()=>{
 for(const result of [{ok:false,httpStatus:503},{ok:true,identity:{id:'unverified',name:'缓存昵称'},ticket:'guess',expiresAt:Math.floor(Date.now()/1000)+300}]){
  const p=setup({api:()=>result});await settle();assert.equal(p.account.identity(),null);assert.equal(p.menu.hidden,true);assert.equal(p.signedOut.hidden,false);assert.equal(p.name.textContent,'');assert.equal(p.profileLabel.textContent,'我的主页');assert.equal(p.signedOut.fire('click').defaultPrevented,false);
 }
});
