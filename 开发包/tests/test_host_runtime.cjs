const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {APP_ROOT}=require('./project_paths.cjs');
const helper=fs.readFileSync(path.join(APP_ROOT,'主控台/host/encounter-ui.js'),'utf8');
const {readClientSource}=require('./client_sources.cjs');
const app=readClientSource('主控台/host/app.js');
function fn(name){const start=app.indexOf('function '+name+'('),body=app.indexOf('{',start);assert.ok(start>=0,name);let depth=0;for(let i=body;i<app.length;i++){if(app[i]==='{')depth++;else if(app[i]==='}'&&--depth===0)return app.slice(start,i+1);}throw Error(name);}
const tick=()=>new Promise(setImmediate);
function clockFixture(){
 const nodes=new Map(),calls={weather:0,save:0,render:0,world:0},e={playMode:'free',secondsPerRound:6,worldTime:{runningSince:1},weather:{},lastEvent:{label:'previous'}};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'draft',textContent:'',disabled:false});return nodes.get(id);};
 const world={year:2030,week:2,day:3,hour:4,minute:5,second:6};const weather={climate:'tropical',condition:'clear',temperature:21,wind:'light',season:{icon:'☀',label:'夏'},conditionIcon:'☼',conditionLabel:'晴',detail:'21°C'};
 let automatic=null;const c=vm.createContext({window:{SundollWorldUI:{editingDate:false,editingWeather:false,editingLocation:false,render:()=>calls.world++}},document:{hidden:false,activeElement:null},$,CLIMATE_AVAILABLE:true,encounterState:()=>e,worldTimeNow:()=>12345,worldTimeParts:()=>world,weatherPresentation:()=>weather,formatWorldClock:w=>`${w.hour}:${w.minute}:${w.second}`,formatWorldDate:w=>`${w.year}/${w.week}/${w.day}`,refreshScheduledWeather:()=>{calls.weather++;return automatic;},setEncounterEvent:(encounter,label)=>encounter.lastEvent={label},scheduleAutosave:()=>calls.save++});
 vm.runInContext(helper,c);c.renderEncounter=()=>{calls.render++;};return{c,e,world,weather,$,calls,setAutomatic:v=>automatic=v};
}
test('running clock updates date/weather but never rebuilds initiative DOM; paused clock does no work',()=>{
 const f=clockFixture();for(let i=0;i<100;i++)f.c.tickHostClock();
 assert.equal(f.calls.render,0);assert.equal(f.calls.weather,100);assert.equal(f.$('#world-clock-display').textContent,'4:5:6');assert.equal(f.$('#time-event').textContent,'previous');
 assert.equal(f.$('#weather-temperature').value,21);assert.equal(f.$('#time-clock').value,'4:5:6');
 f.e.worldTime.runningSince=null;f.c.tickHostClock();assert.equal(f.calls.weather,100);
});
test('hidden clock keeps weather persistence working without touching the DOM',()=>{
 const f=clockFixture();f.c.document.hidden=true;f.setAutomatic({conditionLabel:'雷暴',temperature:18});
 f.c.$=()=>{throw new Error('hidden UI must not update');};f.c.tickHostClock();
 assert.equal(f.calls.weather,1);assert.equal(f.calls.save,1);assert.equal(f.calls.render,0);assert.equal(f.calls.world,0);assert.match(f.e.lastEvent.label,/雷暴/);
});
test('clock protects date, weather and location drafts independently and preserves focused inputs',()=>{
 const groups=[
  {flag:'editingDate',values:[['#time-year',2030],['#time-week',2],['#time-day',3],['#time-clock','4:5:6']]},
  {flag:'editingWeather',values:[['#weather-condition','clear'],['#weather-temperature',21],['#weather-wind','light']]},
  {flag:'editingLocation',values:[['#weather-climate','tropical']]},
 ];
 // Check every combination: each edit flag protects only its own draft group.
 for(let mask=0;mask<8;mask++){
  const f=clockFixture();
  groups.forEach((group,index)=>{
   f.c.window.SundollWorldUI[group.flag]=Boolean(mask&(1<<index));
   for(const [id] of group.values)f.$(id).value='draft '+id;
  });
  f.c.tickHostClock();
  groups.forEach((group,index)=>{
   for(const [id,current] of group.values)assert.equal(f.$(id).value,mask&(1<<index)?'draft '+id:current,`${group.flag}, mask ${mask}, ${id}`);
  });
  assert.equal(f.$('#world-clock-display').textContent,'4:5:6','readouts continue while drafts are protected');
 }
 // Focus protects each individual input without freezing unrelated controls.
 const inputs=groups.flatMap(group=>group.values);
 for(const [focused] of inputs){
  const f=clockFixture();f.$(focused).value='focused draft';f.c.document.activeElement=f.$(focused);f.c.tickHostClock();
  for(const [id,current] of inputs)assert.equal(f.$(id).value,id===focused?'focused draft':current,`focus ${focused}, ${id}`);
 }
});
test('initiative ribbon indexes all map tokens once, preserving entry portraits and order',()=>{
 let scans=0,result;const tokens=Array.from({length:1000},(_,i)=>({id:'t'+i,type:'npc',icon:'x',image:'img'+i})),maps=[{tokens}];
 const flatMap=maps.flatMap.bind(maps);maps.flatMap=fn=>{scans++;return flatMap(fn);};const entries=Array.from({length:40},(_,i)=>({id:'e'+i,tokenId:'t'+i}));
 const c=vm.createContext({window:{SundollInitiativeRibbon:{render:(container,data)=>result=data}},$:()=>({}),encounterState:()=>({entries,playMode:'turn',round:1,currentEntryId:'e0'}),state:{maps},initiativeEntryLabel:e=>e.id,initiativePortraitForToken:t=>t,initiativePortraitImageUrl:t=>t?.image||'',focusHostInitiativeEntry(){},openHostInitiativeManager(){}});
 vm.runInContext(helper,c);c.renderHostInitiativeRibbon();assert.equal(scans,1);assert.equal(result.entries.length,40);assert.equal(result.entries[39].imageUrl,'img39');assert.equal(result.entries[39].name,'e39');
});
function diceFixture(){
 const scripts=[],rolls=[],notices=[],listeners={};const window={},document={createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)},querySelector:selector=>({addEventListener:(type,handler)=>listeners[selector+type]=handler})};
 const c=vm.createContext({window,document,AbortController,setTimeout,clearTimeout,localStorage:{getItem:()=> 'saved'},toast:text=>notices.push(text)});
 vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'主控台/shared/client-runtime.js'),'utf8'),c);c.SundollClientRuntime=window.SundollClientRuntime;vm.runInContext(helper+'\n'+fn('playDiceFx')+'\n'+fn('currentDiceSkin'),c);
 return{c,window,scripts,rolls,notices,listeners};
}
test('host startup stays light; first public/private dice imports once and preserves every animation argument',async()=>{
 const f=diceFixture();f.c.initHostDiceLoading();assert.equal(f.scripts.length,0);assert.equal(f.c.currentDiceSkin(),'saved');
 const opts1={dice:[3,20],pick:1,mode:1,natural:20,critical:'success',skin:'gold',visibility:'private',interrupt:true},opts2={dice:[4,5],visibility:'public',skin:'silver'};
 const one=f.c.playDiceFx(20,'advantage',24,opts1),two=f.c.playDiceFx(6,'damage',9,opts2);await tick();assert.equal(f.scripts.length,1);assert.equal(f.scripts[0].src,'vendor/three.min.js');
 f.window.THREE={};f.scripts[0].onload();await tick();assert.equal(f.scripts.length,2);assert.match(f.scripts[1].src,/shared\/dice.js/);
 f.window.SundollDiceSkins={get:()=> 'loaded'};f.window.playDieAnimation=(...args)=>f.rolls.push(args);f.scripts[1].onload();await Promise.all([one,two]);
 assert.deepEqual(f.rolls,[[20,'advantage',24,opts1],[6,'damage',9,opts2]]);assert.equal(f.c.currentDiceSkin(),'loaded');
 const html=fs.readFileSync(path.join(APP_ROOT,'主控台/主控台.html'),'utf8');assert.doesNotMatch(html,/<script[^>]+src="(?:vendor\/three\.min|shared\/dice)\.js/);assert.match(html,/host\/encounter-ui\.js/);
});
test('failed host dice retains the result and retries on the next roll',async()=>{
 const f=diceFixture(),first=f.c.playDiceFx(20,'roll',17,{visibility:'private'});await tick();f.scripts[0].onerror();await first;assert.match(f.notices[0],/17/);
 const retry=f.c.playDiceFx(20,'retry',3,{});await tick();assert.equal(f.scripts.length,2);f.scripts[1].onerror();await retry;assert.match(f.notices[1],/3/);
});
