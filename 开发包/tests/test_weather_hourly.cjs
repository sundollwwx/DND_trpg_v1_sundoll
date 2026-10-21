const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{spawnSync}=require('node:child_process');
const {APP_ROOT,PACKAGE_ROOT}=require('./project_paths.cjs');
const config=JSON.parse(fs.readFileSync(path.join(DAILY_LIFE_FIXTURE, '资料/climate.json'),'utf8'));
const src=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
function host(configSnapshot=config,worldState={mapLocations:[],worldWeatherLocationId:null,worldWeatherDefault:null}){
  const ctx={window:{SundollClimateConfig:structuredClone(configSnapshot)},state:worldState,clamp:(x,a,b)=>Math.min(b,Math.max(a,x)),console};
  const segments=[src.slice(src.indexOf('const CLIMATE_CONFIG ='),src.indexOf('function defaultEncounterState()')),src.slice(src.indexOf('function worldTimeNow('),src.indexOf('function materializeWorldTime(')),src.slice(src.indexOf('function mapLocationById('),src.indexOf('function mapsForLocation('))];
  vm.createContext(ctx);vm.runInContext(segments.join('\n')+'\nthis.api={normalizeWeather,refreshScheduledWeather,generateClimateWeather,weatherPresentation,worldTimeParts,effectiveWeatherTemperature,climateWeatherWeights,weatherWindWeights,weightedWeatherChoice,weatherEnvironmentEffects,rememberWorldWeather,arriveAtWorldLocation};',ctx);
  return ctx.api;
}
function encounter(hour=8,auto=true){return{worldTime:{totalSeconds:hour*3600},weather:{...config.defaultWeather,generatedHour:hour,auto}};}
function plain(value){return JSON.parse(JSON.stringify(value));}
const playerSrc=fs.readFileSync(path.join(APP_ROOT,'主控台/player/player.js'),'utf8');
function player(configSnapshot=config){const ctx={window:{SundollClimateConfig:structuredClone(configSnapshot)}};vm.createContext(ctx);vm.runInContext(playerSrc.slice(playerSrc.indexOf('  const FLOW_CLIMATE_CONFIG='),playerSrc.indexOf('  function flowWorldParts('))+'\nthis.api=flowWeatherPresentation;',ctx);return ctx.api;}
test('module default fixed weather applies until an explicit saved auto mode overrides it',()=>{
 const fixed=structuredClone(config);fixed.defaultWeather.auto=false;
 const h=host(fixed),p=player(fixed),parts={hour:8,week:1};
 for(const source of [null,{}, {auto:'true'}]){
  assert.equal(h.normalizeWeather(source,8*3600).auto,false);
  assert.equal(p(source,parts).auto,false);
 }
 for(const auto of [true,false]){
  assert.equal(h.normalizeWeather({auto},8*3600).auto,auto);
  assert.equal(p({auto},parts).auto,auto);
 }
 const state={weather:{...fixed.defaultWeather,generatedHour:8}};delete state.weather.auto;
 h.refreshScheduledWeather(state,11*3600,()=>assert.fail('fixed module default cannot roll'));
 assert.equal(state.weather.auto,false);assert.equal(state.weather.generatedHour,11);
});
test('exact crossed-hour generation, persistent repeat protection, old-save migration',()=>{
 const api=host(),state=encounter();let rolls=0;const random=()=>{rolls++;return .42;};
 api.refreshScheduledWeather(state,11*3600+12,random);assert.equal(rolls,9);assert.equal(state.weather.generatedHour,11);
 api.refreshScheduledWeather(state,11*3600+100,random);assert.equal(rolls,9);
 const legacy={weather:{...config.defaultWeather,generatedDay:-5000}};
 api.refreshScheduledWeather(legacy,999999*3600,()=>assert.fail('migration cannot roll'));assert.equal(legacy.weather.generatedHour,999999);assert.equal('generatedDay'in legacy.weather,false);
});
test('manual and backwards time retain the sky while updating the hourly anchor',()=>{
 const api=host(),manual=encounter(8,false),before=plain(manual.weather);
 api.refreshScheduledWeather(manual,200*3600,()=>assert.fail('manual must not roll'));
 assert.deepEqual(plain(manual.weather),{...before,generatedHour:200});
 manual.weather.auto=true;api.refreshScheduledWeather(manual,3*3600,()=>assert.fail('rewind must not roll'));
 assert.deepEqual(plain(manual.weather),{...before,auto:true,generatedHour:3});
});
test('host and player presentation use one common hourly curve across climates and seasons',()=>{
 const h=host(),p=player();
 for(const climate of Object.keys(config.climates))for(const hour of [0,4,8,14,19,23])for(const week of [1,14,27,40]){
  const weather={...config.defaultWeather,climate,temperature:15.7,condition:'rain',wind:'strong'};
  const host=h.weatherPresentation(weather,{hour,week}),player=p(weather,{hour,week});
  assert.equal(player.compact,host.compact);assert.equal(player.detail,host.detail);assert.equal(player.temperature,host.temperature);assert.equal(player.effectiveTemperature,host.effectiveTemperature);
 }
});
test('Python authority and host preview produce identical deterministic hourly states',()=>{
 const h=host(),states=[];
 const sequence=[.001,.2,.9,.5,.73,.99,.37,.45,.61];
 for(const climate of Object.keys(config.climates))for(const week of [1,14,27,40]){
  const hour=(week-1)*7*24+8,state=encounter(hour);state.weather.climate=climate;state.weather.temperature=20.7;
  let i=0;const random=()=>sequence[i++%sequence.length];h.refreshScheduledWeather(state,(hour+30)*3600,random);states.push({initial:{...encounter(hour),weather:{...encounter(hour).weather,climate,temperature:20.7}},total:(hour+30)*3600,result:plain(state.weather)});
 }
 const input={appRoot:APP_ROOT,config,sequence,states};
 const code=`import json,sys\ndata=json.load(sys.stdin)\nsys.path.insert(0,data['appRoot'])\nfrom server.domain import weather\nresults=[]\nfor case in data['states']:\n i=[0]\n def sample():\n  value=data['sequence'][i[0]%len(data['sequence'])];i[0]+=1;return value\n weather.refresh_scheduled_weather(case['initial'],case['total'],sample,config=data['config'])\n results.append(case['initial']['weather'])\nprint(json.dumps(results))\n`;
 const python=process.env.SUNDOLL_PYTHON||(process.platform==='win32'?'python':'python3');
 const result=spawnSync(python,['-c',code],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),states.map(s=>s.result));
});
test('unavailable common climate pauses weather, preserves saved fields and keeps the clock usable',()=>{
 const h=host(null),p=player(null),state=encounter();
 state.weather.customSceneNote='preserve the saved sky';const before=plain(state.weather);
 assert.equal(h.refreshScheduledWeather(state,999999*3600,()=>assert.fail('unavailable climate cannot roll')),null);
 assert.deepEqual(plain(state.weather),before);
 assert.deepEqual(plain(h.normalizeWeather(state.weather,999999*3600)),before);
 assert.deepEqual(plain(h.normalizeWeather(null)),{});
 assert.equal(h.generateClimateWeather(state,'coastal',999999*3600,()=>assert.fail('unavailable climate cannot roll')).available,false);
 assert.deepEqual(plain(state.weather),before);
 assert.equal(h.weatherPresentation(state.weather,{hour:8,week:1}).compact,'天气已暂停');
 assert.equal(p(state.weather,{hour:8,week:1}).compact,'天气已暂停');
 assert.deepEqual(plain(state.weather),before);
 const time=h.worldTimeParts(86400+6);assert.equal(time.day,2);assert.equal(time.hour,0);assert.equal(time.second,6);
});

test('environment thresholds retain tenths consistently in Python, host, and player',()=>{
 const h=host(),p=player(),cases=[];
 for(const base of [37.7,37.8,-17.7,-17.8]){
  const w={...config.defaultWeather,temperature:base},parts={hour:8,week:1};
  const host=h.weatherPresentation(w,parts),player=p(w,parts);
  assert.equal(host.effectiveTemperature,base);assert.equal(player.effectiveTemperature,base);
  assert.equal(host.temperature,base);assert.equal(player.temperature,base);
  assert.equal(host.effectiveTemperature>=(100-32)*5/9,base===37.8);
  assert.equal(host.effectiveTemperature<=(0-32)*5/9,base===-17.8);
  cases.push({weather:w,hour:8,result:host.effectiveTemperature});
 }
 const code=`import json,sys\ndata=json.load(sys.stdin)\nsys.path.insert(0,data['appRoot'])\nfrom server.domain import weather\nprint(json.dumps([weather.effective_weather_temperature(case['weather'],case['hour'],config=data['config']) for case in data['cases']]))\n`;
 const python=process.env.SUNDOLL_PYTHON||(process.platform==='win32'?'python':'python3');
 const result=spawnSync(python,['-c',code],{input:JSON.stringify({appRoot:APP_ROOT,config,cases}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),cases.map(c=>c.result));
});

test('automatic precipitation respects the shared snow cutoff without extra rolls or thermal jumps',()=>{
 const api=host(),profile=config.climates.coastal;
 const total=(40-1)*7*86400+14*3600,weights=api.climateWeatherWeights(profile,'winter','snow');
 let preceding=0;for(const [key,value]of Object.entries(weights)){if(key==='snow')break;preceding+=value;}
 const pick=(preceding+weights.snow/2)/Object.values(weights).reduce((sum,n)=>sum+n,0);
 for(const [temperature,condition]of [[2,'snow'],[2.1,'rain'],[15,'rain']]){
  const e=encounter(total/3600);e.weather={...e.weather,climate:'coastal',condition:'snow',temperature};
  const sequence=[pick,.5,.5];let calls=0;const presentation=api.generateClimateWeather(e,'coastal',total,()=>sequence[calls++]);
  assert.equal(e.weather.condition,condition);assert.equal(calls,3);
  assert.ok(Math.abs(e.weather.temperature-temperature)<=config.temperature.maxHourlyStep+.051);
  assert.equal(presentation.effectiveTemperature>config.temperature.maxSnowTemperature,condition==='rain');
 }
});

test('automatic fog only receives calm or breeze while a manual DM scene remains intact',()=>{
 const api=host();
 for(const previous of Object.keys(config.winds)){
  const weights=api.weatherWindWeights('fog',previous);assert.equal(weights.strong,0);assert.equal(weights.gale,0);
  for(const sample of [0,.5,.999999])assert.ok(['calm','breeze'].includes(api.weightedWeatherChoice(weights,()=>sample)));
 }
 const e=encounter(8,false);e.weather.condition='fog';e.weather.wind='gale';
 api.refreshScheduledWeather(e,14*3600,()=>assert.fail('manual scene cannot roll'));
 assert.equal(e.weather.condition,'fog');assert.equal(e.weather.wind,'gale');
});

test('regional matrices change both weather and wind without affecting other regions',()=>{
 const api=host(),arid=api.climateWeatherWeights(config.climates.arid,'spring','rain'),coast=api.climateWeatherWeights(config.climates.coastal,'spring','rain');
 const probability=(weights,key)=>weights[key]/Object.values(weights).reduce((sum,n)=>sum+n,0);
 assert.ok(probability(arid,'clear')>.7);assert.ok(probability(coast,'clear')<.01);
 assert.notDeepEqual(plain(api.weatherWindWeights('rain','breeze',config.climates.highland)),plain(api.weatherWindWeights('rain','breeze',config.climates.temperate)));
 const changed=structuredClone(config);changed.climates.arid.transitions.weather.rain.clear*=100;
 const modified=host(changed);
 assert.notDeepEqual(plain(modified.climateWeatherWeights(changed.climates.arid,'spring','rain')),plain(arid));
 assert.deepEqual(plain(modified.climateWeatherWeights(changed.climates.coastal,'spring','rain')),plain(coast));
 for(const profile of Object.values(config.climates))for(const fog of ['fog','lightFog'])for(const prior of Object.keys(config.winds)){
  const weights=api.weatherWindWeights(fog,prior,profile);assert.equal(weights.strong,0);assert.equal(weights.gale,0);
 }
});

test('confirmed locations retain separate manual skies and the unspecified old-campaign backup',()=>{
 const world={mapLocations:[{id:'shore',climateKey:'coastal'},{id:'peak',climateKey:'highland'}],worldWeatherLocationId:null,worldWeatherDefault:null,activeMapId:'shore-floor-1'};
 const api=host(config,world),e=encounter(8,false),original=plain(e.weather);let rolls=0;
 const random=()=>{rolls++;return .42;};
 assert.equal(api.arriveAtWorldLocation('shore',null,e,8*3600,random),true);assert.equal(rolls,3);assert.equal(e.weather.climate,'coastal');
 e.weather={...e.weather,condition:'fog',temperature:13.1,wind:'calm',auto:false};api.rememberWorldWeather(e);const shore=plain(e.weather);
 world.activeMapId='peak-floor-1';assert.equal(world.worldWeatherLocationId,'shore');assert.equal(e.weather.condition,'fog');
 assert.equal(api.arriveAtWorldLocation('shore','coastal',e,8*3600,random),true);assert.equal(rolls,3);
 api.arriveAtWorldLocation('peak',null,e,8*3600,random);assert.equal(rolls,6);assert.equal(e.weather.climate,'highland');
 api.arriveAtWorldLocation('shore',null,e,8*3600,random);assert.equal(rolls,6);assert.deepEqual(plain(e.weather),shore);
 api.arriveAtWorldLocation(null,null,e,8*3600,random);assert.equal(rolls,6);assert.deepEqual(plain(e.weather),original);assert.equal(world.worldWeatherLocationId,null);
 assert.equal(api.arriveAtWorldLocation('missing','cold',e,8*3600,()=>assert.fail('invalid location cannot roll')),false);assert.deepEqual(plain(e.weather),original);
});

test('returning automatic locations catch up once while rewinds only reanchor',()=>{
 const world={mapLocations:[{id:'a',climateKey:'arid'},{id:'b',climateKey:'cold'}],worldWeatherLocationId:null,worldWeatherDefault:null};
 const api=host(config,world),e=encounter();let rolls=0;const random=()=>{rolls++;return .42;};
 api.arriveAtWorldLocation('a',null,e,8*3600,random);api.arriveAtWorldLocation('b',null,e,8*3600,random);assert.equal(rolls,6);
 e.worldTime.totalSeconds=11*3600;api.refreshScheduledWeather(e,e.worldTime.totalSeconds,random);assert.equal(rolls,15);
 api.arriveAtWorldLocation('a',null,e,e.worldTime.totalSeconds,random);assert.equal(rolls,24);assert.equal(e.weather.generatedHour,11);
 api.arriveAtWorldLocation('a',null,e,e.worldTime.totalSeconds,random);api.arriveAtWorldLocation('b',null,e,e.worldTime.totalSeconds,random);assert.equal(rolls,24);
 e.worldTime.totalSeconds=3*3600;api.arriveAtWorldLocation('a',null,e,e.worldTime.totalSeconds,()=>assert.fail('rewind cannot roll'));assert.equal(e.weather.generatedHour,3);
 assert.equal(world.mapLocations[0].weather.generatedHour,3);
 const copy=plain(world.mapLocations[0].weather);e.weather.temperature+=1;assert.deepEqual(plain(world.mapLocations[0].weather),copy);
});

test('a first visit starts at the local season temperature even for the default climate',()=>{
 const total=(40-1)*7*86400+8*3600,world={mapLocations:[{id:'winter-town',climateKey:'temperate'}],worldWeatherLocationId:null,worldWeatherDefault:null};
 const api=host(config,world),e=encounter(total/3600,false),old=plain(e.weather);e.weather.temperature=41.3;
 api.arriveAtWorldLocation('winter-town',null,e,total,()=>.42);
 assert.ok(Math.abs(e.weather.temperature-config.climates.temperate.temperatures.winter)<=config.temperature.maxHourlyStep+.051);
 assert.equal(world.worldWeatherDefault.temperature,41.3);assert.equal(world.worldWeatherDefault.auto,old.auto);
});

test('environment effects distinguish vision, heavy rain and actual exposure conditions',()=>{
 const api=host(),parts={hour:8,week:1},effects=condition=>api.weatherEnvironmentEffects({...config.defaultWeather,condition},parts);
 assert.equal(effects('lightFog')[0].detail,'仅依赖视觉的感知（察觉）检定有劣势。');
 assert.match(effects('fog')[0].detail,/黑暗视觉不能透视浓雾/);assert.equal(effects('fog')[0].sourceId,'vision');
 assert.match(effects('heavyRain')[0].detail,/所有感知（察觉）检定有劣势/);assert.match(effects('rain')[0].detail,/没有暴雨的统一检定劣势/);
 assert.match(effects('storm').at(-1).detail,/不自动产生雷击伤害/);
 for(const temperature of [37.8,-17.8]){
  const result=api.weatherEnvironmentEffects({...config.defaultWeather,temperature},parts),rule=result.at(-1);
  assert.equal(rule.pending,true);assert.match(rule.when,/待主持人确认/);assert.equal(rule.sourceId,'environment');
 }
 assert.equal(api.weatherEnvironmentEffects(config.defaultWeather,parts).some(rule=>rule.pending),false);
});
