const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
for(const [file,roster] of [['host/app.js','streamPlayers'],['player/player.js','players']]) {
 test(file+' resolves identities and old truncated IDs without displaying unknown codes',()=>{
  const source=fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT, '主控台',file),'utf8');
  const start=source.indexOf('function displayPlayerName('),end=source.indexOf('function showMapReaction(',start);
  const id='p'+'a'.repeat(32),context={[roster]:[{playerId:id,name:'桑哆尔'}]};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  assert.equal(context.displayPlayerName(id),'桑哆尔');
  assert.equal(context.displayPlayerName(id.slice(0,24)),'桑哆尔');
  assert.equal(context.displayPlayerName('游客甲'),'游客甲');
  assert.equal(context.displayPlayerName('p'+'b'.repeat(32)),'玩家');
  assert.equal(context.tokenOwnerName({ownerPlayerId:id,owner:'旧名字'}),'桑哆尔');
  context[roster][0].name='改名后';assert.equal(context.displayPlayerName(id),'改名后');
 });
}
