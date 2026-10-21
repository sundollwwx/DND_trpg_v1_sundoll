const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const path=require('node:path');
const host=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
const player=fs.readFileSync(path.join(APP_ROOT,'主控台/player/player.js'),'utf8');
const selection=player.slice(player.indexOf('  function mapForPlayerSnapshot('),player.indexOf('  const retiredServerSessions'));
const presentation=host.slice(host.indexOf('let mapPresentationId = null;'),host.indexOf('function setMapPlayerAccess('));
function fixture(){
 const maps=[{id:'a',mapData:'a.png',playerAccessible:true},{id:'b',mapData:'b.png',playerAccessible:true}];
 const c=vm.createContext({state:{maps},playerMapId:null,lastPresentedMapId:null,lastMapPresentationId:null,playerMapOpen:m=>m.playerAccessible===true});
 vm.runInContext(selection,c);
 return {c,receive:(id='a',command=null,items=maps)=>{const next={activeMapId:id,mapPresentationId:command,maps:structuredClone(items)};const chosen=c.mapForPlayerSnapshot(next);c.state=next;return chosen?.id;}};
}
test('repeated DM presentation returns a browsing player, ordinary snapshots preserve browsing',()=>{
 const f=fixture();assert.equal(f.receive('a','one'),'a');f.c.playerMapId='b';
 assert.equal(f.receive('a','one'),'b');assert.equal(f.receive('a','two'),'a');
 f.c.playerMapId='b';assert.equal(f.receive('a','two'),'b');
});
test('legacy hosts still switch players on a new presented map',()=>{
 const f=fixture();assert.equal(f.receive('a'),'a');assert.equal(f.receive('b'),'b');
});
test('a presentation remains targeted while its image is pending',()=>{
 const f=fixture();f.receive('b','one');
 const maps=[{id:'a',mapData:null,playerAccessible:true},{id:'b',mapData:'b.png',playerAccessible:true}];
 f.c.state={maps:[maps[1]]};assert.equal(f.receive('a','two',maps),'b');
 assert.equal(f.c.playerMapId,'a');maps[0].mapData='a.png';assert.equal(f.receive('a','two',maps),'a');
});
test('each explicit presentation creates a distinct streamed command; combat guard remains',()=>{
 let serial=0,pushes=0,mode='free';const map={id:'a',name:'A'};
 const c=vm.createContext({state:{activeMapId:'a',presentedMapId:'a'},crypto:{randomUUID:()=>String(++serial)},mapById:()=>map,encounterState:()=>({playMode:mode}),syncMapSelect(){},scheduleAutosave(){},streamOn:true,streamPush(){pushes++},scheduleStreamMapPreloads(){},toast(){}});
 vm.runInContext(presentation,c);c.presentMapToPlayers();const first=vm.runInContext('mapPresentationId',c);c.presentMapToPlayers();assert.notEqual(vm.runInContext('mapPresentationId',c),first);assert.equal(pushes,2);
 mode='turn';c.state.presentedMapId='b';c.presentMapToPlayers();assert.equal(pushes,2);
 assert.match(host,/activeMapId: m\?\.id \|\| null,\s*mapPresentationId,/);
 assert.doesNotMatch(host,/present\.disabled = map\.id === state\.presentedMapId/);
});
