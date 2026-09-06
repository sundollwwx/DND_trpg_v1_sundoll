const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('主控台/app.js', 'utf8');
const ctx = {crypto};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function nextSafeCounter('), source.indexOf('function applySavedState(')), ctx);
test('timestamp and UUID IDs cannot overflow the sequential counter', () => {
  let uid = ctx.nextSafeCounter(['m12', 'l89', 't1788701100416470000', 'm1788701100416-470000']);
  assert.equal(uid, 90);
  assert.equal(new Set(Array.from({length:4}, ()=>'t'+uid++)).size, 4);
});
test('duplicate token repair preserves portraits, positions and first ID', () => {
  const maps = [{tokens: ['paladin','bard','warlock','robot'].map((name,i)=>({id:'t1788701100416470000', name, iconImgPath:name+'.png', x:i*50, y:25}))}];
  ctx.repairDuplicateTokenIds(maps);
  assert.equal(new Set(maps[0].tokens.map(t=>t.id)).size,4);
  assert.equal(maps[0].tokens[0].id,'t1788701100416470000');
  maps[0].tokens.forEach((t,i)=>{assert.equal(t.x,i*50);assert.equal(t.iconImgPath,t.name+'.png');});
  const ids=maps[0].tokens.map(t=>t.id);
  ctx.repairDuplicateTokenIds(maps);
  assert.deepEqual(maps[0].tokens.map(t=>t.id),ids);
});
