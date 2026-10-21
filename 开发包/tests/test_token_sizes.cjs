const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const context={};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);
const S=context.SundollSize;
test('six creature ranks keep small and medium distinct and migrate legacy footprints',()=>{
 assert.equal(S.category({size:1}),'medium');assert.equal(S.category({size:2}),'large');
 S.categories.forEach((category,i)=>assert.equal(S.footprint({sizeCategory:category}),[.5,1,1,2,3,4][i]));
 for(let r=0;r<6;r++)for(let m=0;m<6;m++)assert.equal(S.canRide({sizeCategory:S.categories[r]},{sizeCategory:S.categories[m]}),m>r);
});
test('tiny snaps to all four quarter-cell centers with grid offsets',()=>{
 for(const offset of [0,7,-19])for(const x of [12.5,37.5])for(const y of [12.5,37.5]){
  assert.equal(S.snap(x+offset+2,50,.5,offset),x+offset);
  assert.equal(S.snap(y+offset-2,50,.5,offset),y+offset);
 }
 assert.equal(S.snap(84,50,3),75);assert.equal(S.snap(84,50,4),100);
});
test('mounted chains follow root and invalid links detach after size change',()=>{
 const tiny={id:'t',sizeCategory:'tiny',mountId:'s'},small={id:'s',sizeCategory:'small',mountId:'m'},medium={id:'m',sizeCategory:'medium',x:75,y:125};
 const map={tokens:[tiny,small,medium]};S.repair(map);
 assert.equal(tiny.x,75);assert.equal(small.y,125);assert.equal(S.riders(medium,map).length,2);
 medium.sizeCategory='tiny';S.repair(map);assert.equal(small.mountId,null);
});
test('edge snapping stays on the offset half-grid and large units stay inside the map',()=>{
 const map={gridSize:50,gridOffsetX:7,gridOffsetY:-3,mapW:500,mapH:500};
 for(const x of [-100,0,499,900]) {
  const p=S.point(map,{sizeCategory:'tiny'},x,x);
  assert.equal((p.x-7-12.5)%25,0);assert.equal((p.y+3-12.5)%25,0);
  assert.ok(p.x>=12.5&&p.x<=487.5);
 }
 const p=S.point(map,{sizeCategory:'gargantuan'},999,999);
 assert.ok(p.x<=400&&p.y<=400);
});
