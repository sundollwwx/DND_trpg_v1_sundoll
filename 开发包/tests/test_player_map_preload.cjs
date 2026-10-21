const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const source=readClientSource('主控台/玩家.html');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert.ok(start>=0,name);let level=0;const body=source.indexOf('{',start);for(let i=body;i<source.length;i++){if(source[i]==='{')level++;if(source[i]==='}'&&--level===0)return source.slice(start,i+1);}throw Error(name);}
const tick=()=>new Promise(setImmediate),url=(c)=>'/api/module-assets/'+c.repeat(64),absolute=(c)=>'https://table.example'+url(c)+'?variant=map';
function fixture(active=url('a')){
 const requests=[],timers=new Map();let serial=0;
 class Image{set src(value){this.value=value;if(value)requests.push(this);}get src(){return this.value;}load(){this.onload?.();}fail(){this.onerror?.();}}
 const context=vm.createContext({renderGridCover(){},URL,Image,AbortController,document:{hidden:false},navigator:{},location:{href:'https://table.example/主控台/玩家.html'},currentMap:{id:'a',mapData:active,mapW:100,mapH:100},state:{},world:{style:{}},setTimeout:(fn)=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(`const mapPreloadCached=new Set(),mapPreloadQueued=new Set(),mapPreloadAttempts=new Map(),mapAssetLoads=new Map(),mapVariantFailures=new Set();let mapPreloadQueue=[],mapPreloadTimer=null,mapPreloadController=null,mapPreloadActiveUrl='',activeMapAssetSource='',activeMapAssetReady=false,lastMapPaintKey='';`+['mapDisplayUrl','normalizedMapPreloadUrl','loadPlayerMapAsset','watchCurrentMapAsset','playerMayPreloadMaps','scheduleNextMapPreload','preloadNextMapAsset','queueMapAssetPreloads','renderMap'].map(fn).join('\n'),context);
 return {context,requests,timers,queue(candidates){context.queueMapAssetPreloads(candidates,context.currentMap.mapData);}};
}
test('visible map finishes before any speculative request; only published local hashes queue',async()=>{
 const f=fixture();f.queue([url('a'),url('b'),url('c'),url('d'),'https://evil.example/map.png']);
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].src,absolute('a'));assert.equal(f.requests[0].fetchPriority,'high');
 assert.equal(vm.runInContext('mapPreloadQueue.length',f.context),2);await f.context.preloadNextMapAsset();assert.equal(f.requests.length,1);
 f.requests[0].load();await tick();const task=f.context.preloadNextMapAsset();assert.equal(f.requests[1].src,absolute('b'));assert.equal(f.requests[1].fetchPriority,'low');f.requests[1].load();await task;
 assert.equal(vm.runInContext('mapPreloadCached.size',f.context),1);
});
test('switching into an in-flight preloaded map reuses and promotes its image',async()=>{
 const f=fixture();f.queue([url('b')]);f.requests[0].load();await tick();const task=f.context.preloadNextMapAsset();
 f.context.currentMap={id:'b',mapData:url('b')};f.queue([url('a')]);assert.equal(f.requests.length,2);assert.equal(f.requests[1].fetchPriority,'high');
 vm.runInContext('mapPreloadController.abort()',f.context);assert.equal(f.requests[1].src,absolute('b'));f.requests[1].load();await task;await tick();assert.equal(vm.runInContext('activeMapAssetReady',f.context),true);
 f.context.currentMap={id:'a',mapData:url('a')};f.queue([]);await tick();assert.equal(f.requests.length,2);
});
test('failed derived map falls back without changing saved map source; failed hidden preloads stop',async()=>{
 const f=fixture();f.context.renderMap(f.context.currentMap);f.queue([url('b')]);f.requests[0].fail();await tick();
 assert.equal(f.requests[1].src,'https://table.example'+url('a'));assert.equal(f.context.currentMap.mapData,url('a'));assert.ok(!f.context.world.style.backgroundImage.includes('?variant='));
 f.requests[1].load();await tick();const task=f.context.preloadNextMapAsset();f.context.document.hidden=true;vm.runInContext('mapPreloadController.abort()',f.context);await task;
 assert.equal(f.requests[2].src,'');const count=f.requests.length;await f.context.preloadNextMapAsset();assert.equal(f.requests.length,count);
});
test('legacy /api/assets maps retain their original URL and data URLs never become preload candidates',async()=>{
 const legacy='/api/assets/'+'a'.repeat(64),f=fixture(legacy);f.queue(['data:image/png;base64,A',url('b')]);
 assert.equal(f.requests[0].src,'https://table.example'+legacy);assert.equal(vm.runInContext('mapPreloadQueue.length',f.context),1);assert.equal(f.context.mapDisplayUrl('data:image/png;base64,A'),'data:image/png;base64,A');
});

test('a visible map can recover on the next snapshot after both image requests fail',async()=>{
 const f=fixture();f.queue([]);f.requests[0].fail();await tick();f.requests[1].fail();await tick();
 assert.equal(vm.runInContext('activeMapAssetSource',f.context),'');
 f.queue([]);assert.equal(f.requests.length,3);f.requests[2].load();await tick();
 assert.equal(vm.runInContext('activeMapAssetReady',f.context),true);
});
