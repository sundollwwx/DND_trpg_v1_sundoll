const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../主控台/app.js'),'utf8');
const body = source.slice(source.indexOf('function applyDetailHpChange('), source.indexOf('function closeDetailPanel('));
function fixture(hp,tempHp,amount){
 const token={id:'t1',hp,hpMax:10,tempHp,tempHpMax:tempHp};
 const ctx=vm.createContext({$:()=>({value:amount}),state:{selectedId:'t1'},findToken:()=>token,detailHpAmount:()=>amount,clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),detailHpUndo:null,updateDetailVitals(){},renderTokens(){},scheduleAutosave(){},toast(){}});
 ctx.rememberDetailHp=t=>{ctx.detailHpUndo={tokenId:t.id,hp:t.hp,hpMax:t.hpMax,tempHp:t.tempHp,tempHpMax:t.tempHpMax};};
 vm.runInContext(body,ctx);return {token,ctx};
}
test('damage consumes temporary HP first and undo restores both pools',()=>{
 const {token,ctx}=fixture(10,3,5);ctx.applyDetailHpChange('damage');assert.equal(token.hp,8);assert.equal(token.tempHp,0);ctx.undoDetailHpChange();assert.equal(token.hp,10);assert.equal(token.tempHp,3);
});
test('fully absorbed damage does not lower ordinary HP',()=>{const {token,ctx}=fixture(10,8,5);ctx.applyDetailHpChange('damage');assert.equal(token.hp,10);assert.equal(token.tempHp,3);});
test('independent temporary controls affect only temporary HP within capacity',()=>{const {token,ctx}=fixture(10,8,5);ctx.adjustTemporaryHp('decrease');assert.equal(token.tempHp,3);ctx.adjustTemporaryHp('increase');assert.equal(token.tempHp,8);ctx.adjustTemporaryHp('decrease');ctx.adjustTemporaryHp('full');assert.equal(token.tempHp,8);assert.equal(token.hp,10);assert.equal(token.tempHpMax,8);});
test('damage leaves temporary capacity intact and undo restores it',()=>{const {token,ctx}=fixture(10,8,5);ctx.applyDetailHpChange('damage');assert.equal(token.tempHpMax,8);ctx.undoDetailHpChange();assert.equal(token.tempHpMax,8);assert.equal(token.tempHp,8);});
test('healing and full recovery do not change temporary HP',()=>{const {token,ctx}=fixture(2,8,3);ctx.applyDetailHpChange('heal');assert.equal(token.hp,5);assert.equal(token.tempHp,8);ctx.applyDetailHpChange('full');assert.equal(token.hp,10);assert.equal(token.tempHp,8);});
test('temporary quick amounts change their own input and highlight only the selected amount',()=>{
 const input={value:5,addEventListener(_,fn){this.oninput=fn;}};
 const buttons=[1,5,10].map(n=>({dataset:{tempHpAmount:String(n)},classList:{toggle(_,active){this.active=active;}},addEventListener(_,fn){this.onclick=fn;}}));
 const ctx=vm.createContext({$:()=>input,document:{querySelectorAll:()=>buttons}});
 const start=source.indexOf('  const syncTempHpAmount = () => {');
 const end=source.indexOf("  $('#detail-temp-hp-delta').addEventListener('input', syncTempHpAmount);",start);
 vm.runInContext(source.slice(start,end)+"\n$('#detail-temp-hp-delta').addEventListener('input', syncTempHpAmount);",ctx);
 buttons[2].onclick();assert.equal(input.value,'10');assert.deepEqual(buttons.map(b=>b.classList.active),[false,false,true]);
 input.value=7;input.oninput();assert.deepEqual(buttons.map(b=>b.classList.active),[false,false,false]);
});
test('temporary adjustment is undoable without changing normal HP',()=>{const {token,ctx}=fixture(4,8,5);ctx.adjustTemporaryHp('decrease');ctx.undoDetailHpChange();assert.equal(token.tempHp,8);assert.equal(token.hp,4);assert.equal(ctx.detailHpUndo,null);});
