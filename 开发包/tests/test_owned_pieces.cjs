const {readClientSource}=require('./client_sources.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createPortraitContext}=require('./portrait_view_fixture.cjs');
const source = readClientSource(require('node:path').join(require('./project_paths.cjs').APP_ROOT, '主控台/host/app.js'),'utf8');
function extract(name){const match=new RegExp('(?:async )?function '+name+'\\(').exec(source);const start=match.index;return source.slice(start,source.indexOf('\n}',start)+2);}
function setup(){
 const state={campaignId:'c1',activeMapId:'m1',maps:[{id:'m1',mapW:500,mapH:500,tokens:[]},{id:'m2',mapW:500,mapH:500,tokens:[]}],encounter:{entries:[]}};
 const c={SundollRules:require(require('node:path').join(require('./project_paths.cjs').APP_ROOT,'shared/rules.js')),state,uid:1,canonicalPortraitPath:v=>v||null,activeMap:()=>state.maps.find(m=>m.id===state.activeMapId),mapById:id=>state.maps.find(m=>m.id===id),normalizeSheet:t=>t,renderTokens(){},updateDetail(){},renderEncounter(){},scheduleAutosave(){},currentTurnIncludesToken:()=>false,encounterState:()=>state.encounter,renderTurnPath(){},clamp:(v,l,h)=>Math.max(l,Math.min(v,h)),toast(){},findToken:id=>state.maps.flatMap(m=>m.tokens).find(t=>t.id===id),pruneInitiativeTokenRefs:()=>({removed:false}),JSON};
 createPortraitContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),c);vm.runInContext(['normalizePortraitVariants','portraitAssetIdentity','currentTokenPortraitVariantIndex','mergeOwnedPortraitForms','parkOwnedPiece','placeOwnedPiece','transferTokensToMap','transferToken','renumberTokens','tokenGroupKey','splitGroupName','deleteToken'].map(extract).join('\n'),c);return c;
}
const piece={ownerPlayerId:'player-1',ownedPieceId:'owned-1',name:'勇者',hpMax:20,revision:1};const profile={playerId:'player-1',name:'甲'};
test('withdraw and replace preserves injury, conditions and identity without duplicates',async()=>{
 const c=setup();await c.placeOwnedPiece(piece,profile);const t=c.state.maps[0].tokens[0];t.hp=8;t.conditions=[{key:'poisoned'}];const id=t.id;
 c.deleteToken(id,true);assert.equal(c.state.maps[0].tokens.length,0);
 // Emulate JSON disk round trip, not a second mutable HP store.
 c.state.parkedOwnedPieces=JSON.parse(JSON.stringify(c.state.parkedOwnedPieces));
 await c.placeOwnedPiece(piece,profile);await c.placeOwnedPiece(piece,profile);
 assert.equal(c.state.maps[0].tokens.length,1);assert.equal(c.state.maps[0].tokens[0].hp,8);assert.equal(c.state.maps[0].tokens[0].id,id);assert.equal(c.state.maps[0].tokens[0].conditions[0].key,'poisoned');assert.equal(Object.keys(c.state.parkedOwnedPieces).length,0);
});
test('moving owned piece preserves ID and copying is rejected',async()=>{
 const c=setup();await c.placeOwnedPiece(piece,profile);const t=c.state.maps[0].tokens[0];t.hp=8;
 c.transferToken(t.id,'m2',true);assert.equal(c.state.maps[1].tokens.length,0);
 c.state.activeMapId='m2';await c.placeOwnedPiece(piece,profile);
 assert.equal(c.state.maps[0].tokens.length,0);assert.equal(c.state.maps[1].tokens[0].id,t.id);assert.equal(c.state.maps[1].tokens[0].hp,8);
});
test('same name does not renumber owned pieces; another campaign starts its own HP',async()=>{
 const c=setup();await c.placeOwnedPiece(piece,profile);await c.placeOwnedPiece({...piece,ownedPieceId:'owned-2'},profile);
 c.renumberTokens(c.state.maps[0]);assert.ok(c.state.maps[0].tokens.every(t=>t.name==='勇者'));
 c.state.maps[0].tokens[0].hp=8;const other=setup();other.state.campaignId='c2';await other.placeOwnedPiece(piece,profile);assert.equal(other.state.maps[0].tokens[0].hp,20);
});

test('foreign owner cannot place a collection',async()=>{
 const c=setup();await assert.rejects(c.placeOwnedPiece(piece,{playerId:'other'}));assert.equal(c.state.maps[0].tokens.length,0);
});
test('parked piece is clamped into a smaller map',async()=>{
 const c=setup();await c.placeOwnedPiece(piece,profile);const t=c.state.maps[0].tokens[0];t.x=480;t.y=470;t.hp=7;c.deleteToken(t.id,true);
 c.state.activeMapId='m2';c.state.maps[1].mapW=100;c.state.maps[1].mapH=80;await c.placeOwnedPiece(piece,profile);
 const restored=c.state.maps[1].tokens[0];assert.ok(restored.x<100 && restored.y<80);assert.equal(restored.hp,7);
});
