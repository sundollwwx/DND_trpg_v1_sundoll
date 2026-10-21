const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createMapDom,installPlayerMapRenderer}=require('./map_render_fixture.cjs');
const source=readClientSource('主控台/玩家.html','utf8');
function fn(n){const a=source.indexOf(`  function ${n}(`);return source.slice(a,source.indexOf('\n  }',a)+4);}
test('unchanged map snapshots perform no repeated background style writes',()=>{
 let writes=0;const c=vm.createContext({state:{},...createMapDom(new Proxy({},{set(o,k,v){writes++;o[k]=v;return true;}}))});
 installPlayerMapRenderer(c);
 const m={id:'m',mapW:100,mapH:100,mapData:'art',gridSize:50};c.renderMap(m);const first=writes;
 for(let i=0;i<100;i++)c.renderMap({...m});assert.equal(writes,first);
 const overlay=c.world.querySelector('.map-cover-overlay');
 assert.equal(c.world.children.length,1);assert.equal(overlay.firstChild.getAttribute('d'),'');
 c.renderMap({...m,gridCover:{all:true,cells:{}}});
 assert.equal(writes,first,'cover-only updates must retain the cached background');
 assert.match(overlay.firstChild.getAttribute('d'),/^M0 0H100V100H0Z/,'real cover rendering remains active on cached maps');
 c.renderMap({...m,gridVisible:false});assert.ok(writes>first);
});
test('empty large map uses one pixel; changed doodles redraw once and clearing releases bitmap',()=>{
 let clears=0,draws=0;const elements={};const c=vm.createContext({
 currentMap:{id:'m',mapW:8000,mapH:8000,doodles:[]},doodleDraft:null,doodle:{width:8000,height:8000},
 doodleCtx:{clearRect(){clears++;}},drawStroke(){draws++;},$:id=>elements[id]??(elements[id]={})});
 vm.runInContext("let lastDoodlePaintKey='';"+fn('renderDoodles'),c);
 c.renderDoodles();assert.equal(c.doodle.width*c.doodle.height,1);
 c.currentMap.doodles=[{id:'line',points:[{x:1,y:1}]}];c.renderDoodles();assert.equal(c.doodle.width,8000);
 for(let i=0;i<100;i++)c.renderDoodles();assert.equal(clears,1);assert.equal(draws,1);
 c.currentMap.doodles[0].points.push({x:3,y:4});c.renderDoodles();assert.equal(draws,2);
 c.currentMap.doodles=[];c.renderDoodles();assert.equal(c.doodle.width*c.doodle.height,1);
});
test('clock refresh updates text only and does no DOM work while hidden',()=>{
 let lookups=0;const elements={};const c=vm.createContext({document:{hidden:false},state:{encounter:{}},
 flowWorldTotal:()=>1,flowWorldParts:()=>({}),flowWeatherPresentation:()=>({compact:'晴',detail:'晴 20'}),
 flowDateLabel:()=> '日期',flowClockLabel:()=> '10:00:01',$:id=>{lookups++;return elements[id]??(elements[id]={});}});
 vm.runInContext(fn('refreshPlayerClock'),c);c.refreshPlayerClock();assert.equal(elements['#flow-time-clock'].textContent,'10:00:01');
 c.document.hidden=true;const count=lookups;c.refreshPlayerClock();assert.equal(lookups,count);
 assert.ok(!Object.keys(elements).includes('#flow-init-list'));
});
test('speculative downloads skip background, low memory and metered clients',()=>{
 const c=vm.createContext({document:{hidden:false},navigator:{}});vm.runInContext(fn('playerMayPreloadMaps'),c);
 assert.equal(c.playerMayPreloadMaps(),true);c.navigator.deviceMemory=4;assert.equal(c.playerMayPreloadMaps(),false);
 c.navigator.deviceMemory=8;c.navigator.connection={saveData:true};assert.equal(c.playerMayPreloadMaps(),false);
 c.navigator.connection={effectiveType:'2g'};assert.equal(c.playerMayPreloadMaps(),false);
 c.navigator.connection={};c.document.hidden=true;assert.equal(c.playerMayPreloadMaps(),false);
});
test('spell and path layers allocate full resolution only when needed',()=>{
 const c=vm.createContext({currentMap:{id:'m',mapW:8000,mapH:8000,tokens:[]},selectedId:null,
 spellRangeCanvas:{width:8000,height:8000},spellRangeCtx:{clearRect(){}},normalizeSpellRange:r=>r||{shape:'off'},drawSpellRangeForToken(){},
 turnPath:{width:8000,height:8000},turnPathCtx:{clearRect(){}},measureDraft:null,encounter:()=>({playMode:'free'}),drawTurnPath(){},$:()=>({})});
 for(const n of ['renderSpellRanges','renderTurnPath'])vm.runInContext(fn(n),c);
 c.renderSpellRanges();c.renderTurnPath();assert.equal(c.spellRangeCanvas.width*c.spellRangeCanvas.height,1);assert.equal(c.turnPath.width*c.turnPath.height,1);
 c.currentMap.tokens=[{id:'t',spellRange:{shape:'circle'}}];c.renderSpellRanges();assert.equal(c.spellRangeCanvas.width,8000);
 c.renderTurnPath([{x:1,y:1},{x:2,y:2}]);assert.equal(c.turnPath.width,8000);
 c.currentMap.tokens=[];c.renderSpellRanges();c.renderTurnPath();assert.equal(c.spellRangeCanvas.width,1);assert.equal(c.turnPath.width,1);
});
