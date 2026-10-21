const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const dining=require(path.resolve(__dirname,'../../程序包/主程序/主控台/shared/dining.js'));
const fs=require('node:fs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(DAILY_LIFE_FIXTURE,'资料/menus.json'),'utf8'));
dining.setMenus(catalog);
test('compact menus include prices, portions, alcohol labels and no encounter rewards',()=>{
 assert.equal(dining.menus.length,6);
 assert.deepEqual(dining.menus.slice(0,2).map(m=>m.sections.flatMap(s=>s.items).length),[7,8]);
 for(const m of dining.menus)for(const s of m.sections)for(const item of s.items){assert.ok(item.name&&item.price&&item.detail&&item.tag);assert.doesNotMatch(item.detail,/毒师|盗贼工会|生命值|护甲等级|1d20/);}
 assert.ok(dining.find('dragon-monastery').intro.includes('不留也一样欢迎'));
});
test('preview does not publish; host channel publishes and retracts without editing menu data',()=>{
 const c=dining.createHostChannel(); assert.equal(c.snapshot('a'),null);
 const s=c.show('dragon-monastery','token-1','a'); assert.deepEqual(s,{id:'dragon-monastery',token:'token-1'});
 s.id='bad'; assert.equal(c.snapshot('a').id,'dragon-monastery');
 c.hide('a'); assert.equal(c.snapshot('a'),null);
 assert.throws(()=>c.show('secret','1','a'));
});
test('campaign switching clears menu and does not resurrect earlier selection',()=>{
 const c=dining.createHostChannel(); c.show('sundoll-tavern','x','a');
 assert.equal(c.snapshot('b'),null);assert.equal(c.snapshot('a'),null);
});
test('late joining player sees selected menu but repeated snapshots do not reopen it',()=>{
 const c=dining.createPlayerChannel(), value={id:'sundoll-tavern',token:'x'};
 assert.equal(c.receive(value,'a:server1').open,true);
 assert.equal(c.receive(value,'a:server1').open,false);
 assert.equal(c.receive({...value,token:'y'},'a:server1').open,true);
});
test('withdrawal, invalid ids, and new server sessions reset player display',()=>{
 const c=dining.createPlayerChannel(), value={id:'dragon-monastery',token:'x'};
 c.receive(value,'a:s1'); assert.equal(c.receive(null,'a:s1').menu,null);
 assert.equal(c.receive(value,'a:s1').open,true);
 assert.equal(c.receive(value,'a:s2').open,true);
 assert.equal(c.receive({id:'secret',token:'x'},'a:s2').menu,null);
 assert.equal(c.receive({id:'sundoll-tavern',token:[]},'a:s2').menu,null);
});
test('old network acknowledgements do not confirm a newer menu',()=>{
 const c=dining.createHostChannel();const old=c.show('sundoll-tavern','x','a');
 const next=c.show('dragon-monastery','y','a');assert.equal(c.matches(old),false);assert.equal(c.matches(next),true);
 c.hide('a');assert.equal(c.matches(next),false);assert.equal(c.matches(null),true);
});
