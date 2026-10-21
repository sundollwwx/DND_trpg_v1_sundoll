const {readClientSource}=require('./client_sources.cjs');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = readClientSource('主控台/host/app.js','utf8');
function fn(name) {
 const start=source.indexOf(`function ${name}(`);
 return source.slice(start,source.indexOf('\n}',start)+2);
}
function fixture() {
 const state={campaignId:'old',campaignName:'原战役',library:[],maps:[{id:'old-map',tokens:[{id:'old-token',hp:7}]}],sharedNotes:'保留'};
 const c=vm.createContext({SundollRules:require(require("node:path").join(require("./project_paths.cjs").APP_ROOT,"shared/rules.js")),SundollMapForms:require(require("node:path").join(require("./project_paths.cjs").APP_ROOT,"shared/map-forms.js")),state,userLinks:[{name:'原链接'}],uid:9,pendingLegacyPortraitMigrations:2,
  console:{warn(){}},loadLibrary:()=>[],BUNDLED_LIBRARY:[],normalizeLibPreset:v=>v,
  normalizeLink:v=>v,CampaignJournal:{normalize:v=>v||{}},normalizeEncounter:()=>({entries:[]}),
  canonicalPortraitPath:v=>v,migrateLegacyTokenPortrait:()=>false,clamp:(v,a,b)=>Math.min(b,Math.max(a,v)),
  normalizeSheet:t=>{t.normalized=true;},mapById:id=>state.maps.find(m=>m.id===id),
  ensureMapNavigation(){},repairDuplicateTokenIds(){},reconcileInitiativeEntries(){},renumberAllMaps(){}});
vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),c);
 for(const n of ['nextSafeCounter','applySavedState','loadSaved','parseCampaignFile'])vm.runInContext(fn(n),c);
 return c;
}
test('invalid token after partial normalization rolls back state and leaves source untouched',()=>{
 const c=fixture();const old=JSON.stringify(c.state);const maps=c.state.maps;const links=c.userLinks;
 const incoming={campaignId:'new',maps:[{id:'m',tokens:[{id:'valid',iconImgPath:'a.png'},null]}]};
 const before=JSON.stringify(incoming);
 assert.equal(c.applySavedState(incoming),false);
 assert.equal(JSON.stringify(c.state),old);assert.equal(c.state.maps,maps);
 assert.equal(c.userLinks,links);assert.equal(c.uid,9);assert.equal(c.pendingLegacyPortraitMigrations,2);
 assert.equal(JSON.stringify(incoming),before);
});
test('unrecognized object is rejected instead of generating an empty campaign',()=>{
 const c=fixture();const old=JSON.stringify(c.state);
 for(const data of [null,{},[],{campaignId:'bad'}])assert.equal(c.applySavedState(data),false);
 assert.equal(JSON.stringify(c.state),old);
});
test('valid load preserves original snapshot and empty maps stay empty',()=>{
 const c=fixture();const data={campaignId:'new',maps:[{id:'m',tokens:[{id:'t',hp:3}]}]};
 const before=JSON.stringify(data);
 assert.equal(c.applySavedState(data),true);assert.equal(c.state.maps[0].tokens[0].hp,3);
 assert.equal(JSON.stringify(data),before);
 assert.equal(c.applySavedState({campaignId:'empty',maps:[]}),true);
 assert.equal(c.state.maps.length,0);assert.equal(c.state.activeMapId,null);
});
test('corrupt browser JSON does not abort startup',()=>{
 const c=fixture();c.STORAGE_KEY='state';c.localStorage={getItem:()=>'{broken'};
 assert.equal(c.loadSaved(),false);assert.equal(c.state.campaignId,'old');
});
test('package identity is carried into legacy state with missing identity',()=>{
 const c=fixture();const record=c.parseCampaignFile(JSON.stringify({campaignId:'c1',campaignName:'战役',state:{maps:[]}}));
 assert.equal(record.state.campaignId,'c1');assert.equal(record.state.campaignName,'战役');
});
