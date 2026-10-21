const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const source=readClientSource('主控台/host/app.js');
const block=source.slice(source.indexOf("  if (a.op === 'recallOwnedPiece'"),source.indexOf("  if (m && a.op === 'releaseOwnedPiece'"));
test('recall retains hidden host initiative and private conditions while applying authoritative hp',()=>{
 const state={selectedId:'t',maps:[{tokens:[{id:'t',ownedPieceId:'o',hp:10,conditions:[{visibility:'gm',key:'secret'}]}]}],encounter:{entries:[{id:'own',tokenId:'t'},{id:'hidden',tokenId:'enemy'}],currentEntryId:'own',playMode:'turn',turnSerial:1,turnPath:{tokenId:'t'}}};
 let parked;
 const ctx={state,a:{op:'recallOwnedPiece',ownedPieceId:'o',tokenId:'t',token:{id:'t',ownedPieceId:'o',hp:4,conditions:[]},encounter:{entries:[],currentEntryId:null,playMode:'prepare',turnSerial:2}},parkOwnedPiece:t=>{parked=t;},encounterState:()=>state.encounter,emptyTurnPath:()=>({}),renderTokens(){},updateDetail(){},renderEncounter(){},renderTurnPath(){},scheduleAutosave(){}};
 vm.createContext(ctx);vm.runInContext('(function(){'+block+'})()',ctx);
 assert.equal(state.maps[0].tokens.length,0);assert.equal(parked.hp,4);assert.equal(parked.conditions[0].key,'secret');
 assert.equal(state.encounter.entries[0].id,'hidden');assert.equal(state.encounter.currentEntryId,'hidden');assert.equal(state.encounter.playMode,'turn');
});
