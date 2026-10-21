const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
/* Exercise real save loading, navigation normalization, and serialization. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {APP_ROOT,PACKAGE_ROOT}=require('./project_paths.cjs');
const app=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const storage=fs.readFileSync(path.join(APP_ROOT,'主控台/host/storage.js'),'utf8');
const config=JSON.parse(fs.readFileSync(path.join(DAILY_LIFE_FIXTURE, '资料/climate.json'),'utf8'));
const rules=require(path.join(APP_ROOT,'shared/rules.js'));
const forms=require(path.join(APP_ROOT,'shared/map-forms.js'));

function functionSource(source,name){
  const start=source.indexOf(`function ${name}(`);
  assert.ok(start>=0,`Missing real function: ${name}`);
  const lineEnd=source.indexOf('\n',start);
  if(source.slice(start,lineEnd).trimEnd().endsWith('}'))return source.slice(start,lineEnd);
  const end=source.indexOf('\n}',start);
  assert.ok(end>=0,`Unclosed real function: ${name}`);
  return source.slice(start,end+2);
}
function plain(value){return JSON.parse(JSON.stringify(value));}
function sky(climate='coastal',temperature=12.3,hour=9){
  return{...config.defaultWeather,climate,temperature,condition:'rain',wind:'strong',generatedHour:hour,auto:false};
}
function saved(){
  return{campaignId:'weather-storage',campaignName:'天气缓存',maps:[{
    id:'m1',chapterId:'c1',locationId:'l1',name:'码头',tokens:[],
  }],activeMapId:'m1',presentedMapId:'m1',mapChapters:[{id:'c1',name:'海岸'}],mapLocations:[
    {id:'l1',chapterId:'c1',name:'码头',climateKey:'coastal',weather:sky('coastal',8.1,4)},
    {id:'l2',chapterId:'c1',name:'山地',climateKey:'highland',weather:sky('highland',-5.2,3)},
  ],worldWeatherLocationId:'l1',worldWeatherDefault:sky('temperate',20.1,2),
    encounter:{entries:[],playMode:'free',worldTime:{totalSeconds:9*3600,runningSince:null,rate:1},weather:sky()}};
}
function fixture(available=true){
  const state={maps:[],mapChapters:[],mapLocations:[],library:[]};
  const browser=new Map();
  const random=Object.create(Math);
  random.random=()=>assert.fail('Loading or saving must not regenerate weather');
  const now=1700000000000;
  class FixedDate extends Date{static now(){return now;}}
  const context=vm.createContext({state,window:{SundollClimateConfig:available?structuredClone(config):null},
    Math:random,Date:FixedDate,crypto:require('node:crypto').webcrypto,
    userLinks:[],uid:1,pendingLegacyPortraitMigrations:0,mapBrowserChapterId:null,mapBrowserLocationId:null,
    SundollRules:rules,SundollMapForms:forms,CampaignJournal:{normalize:()=>({entries:[]})},
    console:{warn(){}},loadLibrary:()=>[],BUNDLED_LIBRARY:[],normalizeLibPreset:v=>v,
    normalizeLink:v=>v,canonicalPortraitPath:()=>null,migrateLegacyTokenPortrait:()=>false,
    normalizeSheet(){},reconcileInitiativeEntries(){},renumberAllMaps(){},
    initiativeEntryToken:()=>null,clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),
    STORAGE_KEY:'test-state',modularStorage:false,browserStateCacheFailed:false,
    localStorage:{setItem:(key,value)=>browser.set(key,String(value))}});
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT,'shared/token-size.js'),'utf8'),context);
  vm.runInContext(app.slice(app.indexOf('const CLIMATE_CONFIG ='),app.indexOf('function defaultEncounterState()')),context);
  const hostFunctions=['defaultEncounterState','normalizeEncounter','encounterState','worldTimeNow',
    'weatherHourIndex','emptyTurnPath','normalizeTurnPathSegmentEnds','mapById','mapStructureName',
    'mapChapterById','mapLocationById','createMapChapter','createMapLocation','ensureMapNavigation','rememberWorldWeather'];
  for(const name of hostFunctions)vm.runInContext(functionSource(app,name),context);
  for(const name of ['stateStorageReplacer','stateStorageJson','stateStorageSnapshot','browserStorageIssue',
    'cacheLoadedStateInBrowser','nextSafeCounter','repairDuplicateTokenIds','applySavedState']){
    vm.runInContext(functionSource(storage,name),context);
  }
  return{context,state,browser,now};
}

test('reopening preserves independent location caches, default backup, and current sky',()=>{
  const f=fixture(),input=saved(),original=plain(input);
  assert.equal(f.context.applySavedState(input),true);
  assert.equal(f.state.worldWeatherLocationId,'l1');
  assert.deepEqual(plain(f.state.worldWeatherDefault),input.worldWeatherDefault);
  for(const location of input.mapLocations){
    const loaded=f.state.mapLocations.find(item=>item.id===location.id);
    assert.equal(loaded.climateKey,location.climateKey);
    assert.deepEqual(plain(loaded.weather),location.weather);
  }
  assert.deepEqual(plain(f.state.encounter.weather),input.encounter.weather);
  assert.deepEqual(input,original,'Loading must not mutate the source snapshot');
});

test('snapshot and browser cache remember the newest current-location sky before serializing',()=>{
  const f=fixture();assert.equal(f.context.applySavedState(saved()),true);
  const other=plain(f.state.mapLocations.find(item=>item.id==='l2').weather);
  f.state.encounter.weather.temperature=16.7;
  const snapshot=plain(f.context.stateStorageSnapshot());
  assert.equal(snapshot.mapLocations.find(item=>item.id==='l1').weather.temperature,16.7);
  assert.deepEqual(snapshot.mapLocations.find(item=>item.id==='l2').weather,other);
  f.state.encounter.weather.temperature=17.8;
  assert.equal(f.context.cacheLoadedStateInBrowser(123).ok,true);
  const cached=JSON.parse(f.browser.get('test-state'));
  assert.equal(cached.mapLocations.find(item=>item.id==='l1').weather.temperature,17.8);
  assert.equal(f.browser.get('dnd-board-local-save-at'),'123');
  const reopened=fixture();assert.equal(reopened.context.applySavedState(cached),true);
  assert.equal(reopened.state.worldWeatherLocationId,'l1');
  assert.equal(reopened.state.mapLocations.find(item=>item.id==='l1').weather.temperature,17.8);
});

test('a nonexistent saved location clears only its reference and keeps the current weather',()=>{
  const f=fixture(),input=saved();input.worldWeatherLocationId='removed-location';
  assert.equal(f.context.applySavedState(input),true);
  assert.equal(f.state.worldWeatherLocationId,null);
  assert.deepEqual(plain(f.state.encounter.weather),input.encounter.weather);
  assert.deepEqual(plain(f.state.worldWeatherDefault),input.worldWeatherDefault);
  f.state.encounter.weather.temperature=24.6;
  const snapshot=plain(f.context.stateStorageSnapshot());
  assert.equal(snapshot.worldWeatherLocationId,null);
  assert.equal(snapshot.worldWeatherDefault.temperature,24.6);
  assert.deepEqual(snapshot.mapLocations[0].weather,input.mapLocations[0].weather);
});

test('old weather caches anchor at the current saved clock without generating a sky',()=>{
  const f=fixture(),input=saved();
  input.encounter.worldTime.runningSince=f.now-2*3600*1000;
  const old={...sky(),generatedDay:0};delete old.generatedHour;
  input.mapLocations[0].weather=old;input.worldWeatherDefault={...old};
  assert.equal(f.context.applySavedState(input),true);
  assert.equal(f.state.mapLocations[0].weather.generatedHour,11);
  assert.equal(f.state.worldWeatherDefault.generatedHour,11);
  assert.equal('generatedDay'in f.state.mapLocations[0].weather,false);
  assert.equal(f.state.encounter.weather.generatedHour,9,'Existing generation markers are not changed');
});

test('an absent climate module preserves authored associations and all weather fields through reopening',()=>{
  const f=fixture(false),input=saved();
  input.mapLocations[0].climateKey='custom-region';
  for(const weather of [input.encounter.weather,input.worldWeatherDefault,...input.mapLocations.map(item=>item.weather)]){
    weather.customScene='保留实际场景';weather.generatedDay=17;weather.climate='custom-region';
  }
  assert.equal(f.context.applySavedState(input),true);
  assert.equal(f.state.mapLocations[0].climateKey,'custom-region');
  assert.deepEqual(plain(f.state.encounter.weather),input.encounter.weather);
  assert.deepEqual(plain(f.state.worldWeatherDefault),input.worldWeatherDefault);
  assert.deepEqual(plain(f.state.mapLocations[1].weather),input.mapLocations[1].weather);
  const reopened=fixture(false);assert.equal(reopened.context.applySavedState(plain(f.context.stateStorageSnapshot())),true);
  assert.equal(reopened.state.worldWeatherLocationId,'l1');
  assert.equal(reopened.state.mapLocations[0].climateKey,'custom-region');
  assert.deepEqual(plain(reopened.state.encounter.weather),input.encounter.weather);
  assert.deepEqual(plain(reopened.state.mapLocations[0].weather),input.encounter.weather);
  const installed=fixture();assert.equal(installed.context.applySavedState(input),true);
  assert.equal(installed.state.mapLocations[0].climateKey,null,'Available models reject unknown associations');
});

test('legacy missing caches stay null and malformed cache values do not invent weather',()=>{
  for(const available of [true,false]){
    const f=fixture(available),input=saved();
    delete input.worldWeatherLocationId;delete input.worldWeatherDefault;
    input.mapLocations=[{id:'l1',chapterId:'c1',name:'旧地点'}];
    assert.equal(f.context.applySavedState(input),true);
    assert.equal(f.state.worldWeatherLocationId,null);
    assert.equal(f.state.worldWeatherDefault,null);
    assert.equal(f.state.mapLocations[0].climateKey,null);
    assert.equal(f.state.mapLocations[0].weather,null);
    const current=plain(f.state.encounter.weather);
    for(const invalid of [[],false,'weather',42]){
      input.worldWeatherDefault=invalid;input.mapLocations[0].weather=invalid;
      assert.equal(f.context.applySavedState(input),true);
      assert.equal(f.state.worldWeatherDefault,null);assert.equal(f.state.mapLocations[0].weather,null);
      assert.deepEqual(plain(f.state.encounter.weather),current);
    }
    for(const invalid of ['','   ','x'.repeat(65),42]){
      input.mapLocations[0].climateKey=invalid;
      assert.equal(f.context.applySavedState(input),true);
      assert.equal(f.state.mapLocations[0].climateKey,null);
    }
  }
});

test('failed loading rolls back the location caches and leaves the source untouched',()=>{
  const f=fixture();assert.equal(f.context.applySavedState(saved()),true);
  const previous=plain(f.state),input=saved();input.maps[0].tokens=[null];
  const original=plain(input),locations=f.state.mapLocations,backup=f.state.worldWeatherDefault;
  assert.equal(f.context.applySavedState(input),false);
  assert.deepEqual(plain(f.state),previous);assert.equal(f.state.mapLocations,locations);
  assert.equal(f.state.worldWeatherDefault,backup);assert.deepEqual(input,original);
});

test('the serializer remains usable when the optional memory hook is not installed',()=>{
  const f=fixture();assert.equal(f.context.applySavedState(saved()),true);
  f.context.rememberWorldWeather=undefined;
  assert.equal(JSON.parse(f.context.stateStorageJson()).worldWeatherLocationId,'l1');
});
