const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
function sliceFunction(source,name,ending){const start=source.indexOf('function '+name+'(');assert.ok(start>=0);return source.slice(start,source.indexOf(ending,start)+ending.length);}
const hostSource=readClientSource('主控台/host/app.js'),playerSource=readClientSource('主控台/player/player.js');
function host(){
 const token={id:'t',ownedPieceId:'o',ownerPlayerId:'p',hp:4,hpMax:20,x:88,characterRevision:1,conditions:[{visibility:'gm',label:'秘密'}]};
 const state={campaignId:'c',maps:[{tokens:[token]}],parkedOwnedPieces:{parked:{ownedPieceId:'o2',ownerPlayerId:'p',hp:2,characterRevision:1}}};
 const ctx={state,renderTokens(){},updateDetail(){},scheduleAutosave(){}};vm.createContext(ctx);vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),ctx);
 const start=hostSource.indexOf("  if(a.op==='characterState')"),end=hostSource.indexOf('\n  const m =',start);
 vm.runInContext('function apply(a){'+hostSource.slice(start,end)+'}',ctx);return{ctx,state,token};
}
test('host projection updates HP across maps and parked records while retaining position and private conditions',()=>{
 const {ctx,state,token}=host();ctx.apply({op:'characterState',characterId:'o',ownerPlayerId:'p',patch:{hp:12,characterRevision:2}});
 assert.equal(token.hp,12);assert.equal(token.x,88);assert.equal(token.conditions[0].visibility,'gm');
 ctx.apply({op:'characterState',characterId:'o2',ownerPlayerId:'p',patch:{hp:7,characterRevision:2}});assert.equal(state.parkedOwnedPieces.parked.hp,7);
 ctx.apply({op:'characterState',characterId:'o',ownerPlayerId:'p',patch:{hp:4,characterRevision:1}});assert.equal(token.hp,12);
 ctx.apply({op:'characterState',characterId:'o',ownerPlayerId:'foreign',patch:{hp:20,characterRevision:9}});assert.equal(token.hp,12);
});
test('player projection ignores stale updates and preserves local token identity',()=>{
 const token={id:'t',ownedPieceId:'o',ownerPlayerId:'p',hp:4,characterRevision:1};const state={maps:[{tokens:[token]}]};
 const ctx={state,currentMap:state.maps[0],selectedId:'t',renderTokens(){},openDetail(){}};vm.createContext(ctx);vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),ctx);
 const start=playerSource.indexOf("    if(a.op==='characterState')"),end=playerSource.indexOf("    if(a.op==='journalEdit')",start);
 vm.runInContext('function apply(a){'+playerSource.slice(start,end)+'}',ctx);
 ctx.apply({op:'characterState',characterId:'o',ownerPlayerId:'p',patch:{hp:11,characterRevision:3}});
 ctx.apply({op:'characterState',characterId:'o',ownerPlayerId:'p',patch:{hp:8,characterRevision:2}});
 assert.equal(token.hp,11);assert.equal(token.id,'t');assert.equal(token.characterRevision,3);
});
