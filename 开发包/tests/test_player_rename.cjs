const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const src=readClientSource('主控台/player/player.js');
function setup(){
 const input={value:'新名字'},badge={},messages=[],calls=[];let resolve,reject=false;
 const c={emailAccountMode:false,myName:'原名',sessionToken:'own-token',roomCode:'ROOM',localStorage:{setItem(){}},sessionMemory:{remember(){}},document:{activeElement:input},$:s=>s==='#player-name'?input:badge,toast:s=>messages.push(s),fetch:async(url,opts)=>{calls.push(JSON.parse(opts.body));await new Promise(r=>resolve=r);return{ok:!reject,status:reject?409:200,json:async()=>reject?{error:'名字已被使用'}:{ok:true,session:{name:'新名字'}}};}};
 vm.createContext(c);vm.runInContext(src.slice(src.indexOf('  let playerNameSaving='),src.indexOf('  function renderPlayers('))+';this.save=savePlayerName;',c);
 return{c,input,messages,calls,finish(fail=false){reject=fail;resolve();}};
}
test('rename sends once and preserves identity on success',async()=>{
 const f=setup();const saved=f.c.save();await f.c.save();assert.equal(f.calls.length,1);assert.equal(f.calls[0].expectedName,'原名');f.finish();await saved;
 assert.equal(f.c.myName,'新名字');assert.equal(f.c.sessionToken,'own-token');assert.equal(f.input.readOnly,false);
});
test('rejected rename restores old display name',async()=>{
 const f=setup();const saved=f.c.save();f.finish(true);await saved;assert.equal(f.input.value,'原名');assert.equal(f.c.myName,'原名');
});
test('late rename cannot overwrite a switched identity',async()=>{
 const f=setup();const saved=f.c.save();f.c.sessionToken='other';f.c.myName='另一个玩家';f.finish();await saved;assert.equal(f.c.myName,'另一个玩家');
});
