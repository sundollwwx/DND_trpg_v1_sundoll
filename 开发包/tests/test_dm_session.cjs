const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
function fixture(room=true){
 const body={children:[],appendChild(node){this.children.push(node);}},topbar={children:[],appendChild(node){this.children.push(node);}};
 const navigation=[],calls=[];let loaded,allowSave=true,status=200,releaseSave;
 const context={window:{fetch:async(input,options)=>{calls.push({input,options});return {ok:status===200,status,json:async()=>({authenticated:true})};},setInterval(){},...(room?{SundollRoom:{id:'r'+ '1'.repeat(32)}}:{})},
 document:{body,addEventListener:(_name,fn)=>loaded=fn,querySelector:s=>s==='.topbar-session-controls'?topbar:null,createElement:tag=>({tag,children:[],style:{},appendChild(node){this.children.push(node);},addEventListener:(_name,fn)=>this.click=fn})},
 location:{href:'https://pl.example.com/rooms/r'+ '1'.repeat(32)+'/主控台/主控台.html',origin:'https://pl.example.com',assign:url=>navigation.push(url),replace:url=>navigation.push(url)},URL,state:{campaignId:'test'},folderSaveQueue:Promise.resolve(true)};
 context.document.createElement=tag=>{const node={tag,children:[],style:{},appendChild(child){this.children.push(child);},addEventListener(_name,fn){this.click=fn;}};return node;};
 context.saveNowWithFeedback=async()=>{context.folderSaveQueue=Promise.resolve(allowSave);if(releaseSave)await new Promise(r=>releaseSave=r);};
 vm.createContext(context);vm.runInContext(readClientSource('shared/dm-session.js'),context);context.fetch=context.window.fetch;
 return{context,body,topbar,calls,navigation,load:()=>loaded(),failSave(){allowSave=false;},blockSave(){releaseSave=true;return()=>releaseSave();},deny(code){status=code;}};
}
test('DM return is visible during play and a failed save prevents navigation',async()=>{
 const f=fixture();await f.load();const button=f.topbar.children[0];assert.equal(button.textContent,'我的主页');
 f.failSave();await button.click();assert.deepEqual(f.navigation,[]);assert.equal(f.calls.some(c=>c.input==='/api/dm/logout'),false);
});
test('DM waits for saving before returning to the account dashboard',async()=>{
 const f=fixture();await f.load();const release=f.blockSave(),leaving=f.topbar.children[0].click();
 await Promise.resolve();assert.deepEqual(f.navigation,[]);release();await leaving;assert.deepEqual(f.navigation,['/account#dashboard']);
});
test('revoked room membership produces a login banner on the next API response',async()=>{
 const f=fixture();await f.load();f.deny(404);await f.context.window.fetch('/api/local-save');
 assert.equal(f.body.children.length,1);assert.match(f.body.children[0].textContent,/暂时无法保存/);
 assert.equal(f.body.children[0].children[0].href,'/account#dashboard');
});
test('catalog-only DM return does not try to save an unloaded campaign',async()=>{
 const f=fixture();f.context.hostCampaignDeferred=true;
 f.context.queueCurrentFolderSave=()=>{throw Error('unloaded campaign must not be saved');};
 await f.load();await f.topbar.children[0].click();assert.deepEqual(f.navigation,['/account#dashboard']);
});
test('formal-save failure keeps the room open and allows retry',async()=>{
 const f=fixture();let calls=0;f.context.queueCurrentFolderSave=async()=>++calls>1;
 await f.load();const button=f.topbar.children[0];await button.click();assert.deepEqual(f.navigation,[]);
 await button.click();assert.deepEqual(f.navigation,['/account#dashboard']);assert.equal(calls,2);
});
test('DM departure also waits for a newer save queued during the first write',async()=>{
 const f=fixture();let firstDone,newestDone;
 f.context.queueCurrentFolderSave=()=>new Promise(resolve=>firstDone=resolve);
 await f.load();const leaving=f.topbar.children[0].click();
 f.context.folderSaveQueue=new Promise(resolve=>newestDone=resolve);
 firstDone(true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.navigation,[]);
 newestDone(true);await leaving;assert.deepEqual(f.navigation,['/account#dashboard']);
});
