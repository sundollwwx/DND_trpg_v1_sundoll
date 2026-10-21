const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
/* Load and serialize actual campaign data without browser or disk writes. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {APP_ROOT,PACKAGE_ROOT}=require('./project_paths.cjs');
const app=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const storage=fs.readFileSync(path.join(APP_ROOT,'主控台/host/storage.js'),'utf8');
function functionSource(source,name){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,`Missing real function: ${name}`);
  const lineEnd=source.indexOf('\n',start);if(source.slice(start,lineEnd).trimEnd().endsWith('}'))return source.slice(start,lineEnd);
  const end=source.indexOf('\n}',start);assert.ok(end>=0,`Unclosed real function: ${name}`);return source.slice(start,end+2);
}
function plain(value){return JSON.parse(JSON.stringify(value));}
function fixture(){
  const state={maps:[],library:[]},warnings=[];
  const context=vm.createContext({state,window:{SundollClimateConfig:JSON.parse(fs.readFileSync(path.join(DAILY_LIFE_FIXTURE, '资料/climate.json'),'utf8'))},
    crypto:require('node:crypto').webcrypto,Date,Math,URL,console:{warn:(...args)=>warnings.push(args.map(String).join(' '))},
    uid:1,userLinks:[],pendingLegacyPortraitMigrations:0,mapBrowserChapterId:null,mapBrowserLocationId:null,
    MAX_TURN_PATH_POINTS:1000,BUNDLED_LIBRARY:[],loadLibrary:()=>[],normalizeLibPreset:v=>v,
    clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),
    SundollRules:require(path.join(APP_ROOT,'shared/rules.js')),SundollMapForms:require(path.join(APP_ROOT,'shared/map-forms.js')),
    SundollPrepHandbook:require(path.join(APP_ROOT,'主控台/host/prep-handbook.js'))});
  for(const file of ['shared/token-size.js','主控台/shared/portrait-view.js','主控台/shared/downed-portrait.js','主控台/shared/journal.js','主控台/host/initiative-portrait-defaults.js']){
    vm.runInContext(fs.readFileSync(path.join(APP_ROOT,file),'utf8'),context);
  }
  context.CampaignJournal=context.window.CampaignJournal;
  context.SundollPortraitView=context.window.SundollPortraitView;
  context.SundollDownedPortrait=context.window.SundollDownedPortrait;
  context.SundollInitiativePortraitDefaults=context.window.SundollInitiativePortraitDefaults;
  vm.runInContext(app.slice(app.indexOf('const TYPE_META ='),app.indexOf('// 两级分类树')),context);
  vm.runInContext(app.slice(app.indexOf('const CLIMATE_CONFIG ='),app.indexOf('function defaultEncounterState()')),context);
  vm.runInContext(app.slice(app.indexOf('const LEGACY_PORTRAIT_PATH_BY_ID ='),app.indexOf('function portraitNameKey(')),context);
  const functions=['defaultEncounterState','normalizeEncounter','encounterState','worldTimeNow','weatherHourIndex','emptyTurnPath',
    'normalizeTurnPathSegmentEnds','bumpEncounterTurn','setEncounterEvent','returnToCombatPreparationIfEmpty',
    'activeMap','activeTokens','mapById','findToken','mapStructureName','mapChapterById','mapLocationById','createMapChapter','createMapLocation','ensureMapNavigation','rememberWorldWeather',
    'canonicalPortraitPath','portraitNameKey','libraryPortraitPathForToken','migrateLegacyTokenPortrait','normalizeLink',
    'normalizeCondition','normalizeSpellRange','normalizePortraitVariants','archiveLegacyGmNote','normalizeSheet',
    'portraitAssetIdentity','portraitLibraryPresetForToken','tokenPortraitVariants','publicStreamToken',
    'mountedInitiativeGroup','initiativeGroupLabel','initiativeEntryToken','initiativeRepresentativeForSelection','tokenControlGroup','sortInitiativeEntries','reconcileInitiativeEntries',
    'splitGroupName','tokenGroupKey','renumberTokens','renumberAllMaps'];
  for(const name of functions)vm.runInContext(functionSource(app,name),context);
  for(const name of ['stateStorageReplacer','stateStorageJson','stateStorageSnapshot','nextSafeCounter','repairDuplicateTokenIds','applySavedState']){
    vm.runInContext(functionSource(storage,name),context);
  }
  return{context,state,warnings};
}
module.exports={fixture,plain,functionSource};
