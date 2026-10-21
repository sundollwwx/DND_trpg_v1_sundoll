const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const {APP_ROOT}=require('./project_paths.cjs');
const path=require('node:path');
const rules=require(path.join(APP_ROOT,'shared/rules.js'));
const source=readClientSource('主控台/host/app.js');
function extract(name){const a=source.indexOf(`function ${name}(`),b=source.indexOf('\n}',a)+2;assert.ok(a>=0);return source.slice(a,b);}
function setup(mode='prepare'){
 const e={playMode:mode,entries:[{id:'actor',tokenId:'token',name:'勇者',value:12,order:0}],round:1,turnSerial:4,currentEntryId:null,secondsPerRound:6,worldTime:{totalSeconds:100,runningSince:null},turnPath:{mapId:'m',tokenId:'token',points:[{x:1,y:2}]}};
 const calls={saves:0,events:[],toasts:[]};
 const c=vm.createContext({uid:100,encounterState:()=>e,SundollRules:rules,hostInitiativeValueDrafts:new Map(),
  toast:x=>calls.toasts.push(x),initiativeEntryLabel:x=>x.name,setEncounterEvent:(_,x)=>calls.events.push(x),renderEncounter(){},renderTokens(){},scheduleAutosave:()=>calls.saves++,
  normalizeTurnPathSegmentEnds:()=>[],emptyTurnPath:()=>({mapId:null,tokenId:null,points:[],segmentEnds:[]}),reconcileInitiativeEntries(){},initiativeEntryToken:x=>x.tokenId?{id:x.tokenId}:null,
  materializeWorldTime(){},refreshScheduledWeather:()=>null,currentInitiativeEntry:()=>e.entries.find(x=>x.id===e.currentEntryId),findToken:()=>null});
 for(const n of ['sortInitiativeEntries','commitHostInitiativeArrangement','addEnvironmentInitiativeEntry','setHostInitiativeValue','bumpEncounterTurn','startCombat','decrementCurrentTokenConditions','advanceEncounter','moveHostTiedInitiativeEntry','publicEncounterState'])vm.runInContext(extract(n),c);
 return {e,c,calls};
}
test('environment is added once in preparation at zero without creating a map token',()=>{
 const {e,c,calls}=setup();assert.equal(c.addEnvironmentInitiativeEntry(),true);const env=e.entries[1];assert.equal(env.kind,'environment');assert.equal(env.tokenId,null);assert.equal(env.value,0);
 assert.equal(c.addEnvironmentInitiativeEntry(),false);assert.equal(e.entries.length,2);assert.equal(calls.saves,1);
 e.entries.pop();for(const mode of ['free','turn']){e.playMode=mode;assert.equal(c.addEnvironmentInitiativeEntry(),false);assert.equal(e.entries.length,1);}
});
test('environment joins real combat and wrapping its turn advances exactly one round and six seconds',()=>{
 const {e,c}=setup();c.addEnvironmentInitiativeEntry();c.startCombat();assert.equal(e.playMode,'turn');assert.equal(e.currentEntryId,'actor');
 c.advanceEncounter();assert.equal(e.currentEntryId,e.entries[1].id);assert.equal(e.round,1);assert.equal(e.worldTime.totalSeconds,100);assert.equal(e.turnPath.tokenId,null);
 c.advanceEncounter();assert.equal(e.currentEntryId,'actor');assert.equal(e.round,2);assert.equal(e.worldTime.totalSeconds,106);assert.equal(e.turnPath.tokenId,null);
});
test('DM can edit environment only in preparation and decide its tie order with a character',()=>{
 const {e,c}=setup();c.addEnvironmentInitiativeEntry();const id=e.entries[1].id;assert.equal(c.setHostInitiativeValue(id,'12'),true);assert.equal(c.moveHostTiedInitiativeEntry(id,-1),true);assert.equal(e.entries[0].id,id);
 c.startCombat();assert.equal(e.currentEntryId,id);assert.equal(c.setHostInitiativeValue(id,'0'),false);assert.equal(e.entries[0].value,12);
});
test('public encounter includes environment kind and zero but omits hidden character identity',()=>{
 const {e,c}=setup();c.addEnvironmentInitiativeEntry();e.turnPath={points:[]};const publicState=c.publicEncounterState(new Set());assert.equal(publicState.entries.length,1);assert.equal(publicState.entries[0].kind,'environment');assert.equal(publicState.entries[0].value,0);assert.equal(publicState.allowInitiativeSwap,false);
});
test('saving and normalizing preserve one independent environment and cannot attach it to a same-name map token',()=>{
 const {e,c}=setup();c.addEnvironmentInitiativeEntry();const saved=JSON.parse(JSON.stringify(e));saved.entries.push({...saved.entries[1],id:'duplicate',tokenId:'fake'});
 Object.assign(c,{defaultEncounterState:()=>({worldTime:{totalSeconds:0},secondsPerRound:6}),clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),normalizeWeather:()=>({}),worldTimeNow:()=>0,MAX_TURN_PATH_POINTS:256,normalizeTurnPathSegmentEnds:()=>[]});
 vm.runInContext(extract('normalizeEncounter'),c);const restored=c.normalizeEncounter(saved);assert.equal(restored.entries.length,2);assert.equal(restored.entries[1].kind,'environment');assert.equal(restored.entries[1].tokenId,null);assert.equal(restored.entries[1].value,0);assert.equal(restored.allowInitiativeSwap,false);
});

function portraitDefaults(config) {
 const fs=require('node:fs');const c=vm.createContext({window:{},document:{getElementById:()=>config===undefined?null:{textContent:typeof config==='string'?config:JSON.stringify(config)}}});
 vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'主控台/host/initiative-portrait-defaults.js'),'utf8'),c);
 return c.window.SundollInitiativePortraitDefaults;
}
test('clean installs and invalid optional configuration have no private portrait defaults',()=>{
 for(const config of [undefined,'invalid json',null,{}]) {
  const defaults=portraitDefaults(config);
  assert.equal(defaults.assign({ownedPieceId:'synthetic-role'}),false);
  assert.equal(defaults.assign({presetId:'synthetic-preset'}),false);
 }
});
test('room defaults bind by synthetic identity, preserve explicit art and never undo a manual clear',()=>{
 const source='/api/module-assets/'+'1'.repeat(64),presetSource='/api/module-assets/'+'2'.repeat(64);
 const defaults=portraitDefaults({owned:{'synthetic-role':source},presets:{'synthetic-preset':presetSource}});
 const token={ownedPieceId:'synthetic-role'};assert.equal(defaults.assign(token),true);assert.equal(token.initiativePortrait.iconImgPath,source);
 token.initiativePortrait=null;assert.equal(defaults.assign(token),false);assert.equal(token.initiativePortrait,null);
 assert.equal(defaults.assign({ownedPieceId:'unrelated',presetId:'synthetic-preset'}),false);
 const explicit={presetId:'synthetic-preset',initiativePortrait:{iconImgPath:'立绘/custom.png'}};
 assert.equal(defaults.assign(explicit),true);assert.equal(explicit.initiativePortrait.iconImgPath,'立绘/custom.png');
 const preset={sourcePresetId:'synthetic-preset'};assert.equal(defaults.assign(preset),true);assert.equal(preset.initiativePortrait.iconImgPath,presetSource);
});
test('optional defaults reject foreign or broken paths and inherited object keys',()=>{
 const defaults=portraitDefaults({owned:{external:'https://example.test/private.png',legacy:'立绘/missing.png'},presets:{}});
 for(const ownedPieceId of ['external','legacy','toString','__proto__'])assert.equal(defaults.assign({ownedPieceId}),false);
});
