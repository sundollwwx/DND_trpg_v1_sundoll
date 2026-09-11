const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const host=fs.readFileSync('主控台/app.js','utf8'),player=fs.readFileSync('主控台/玩家.html','utf8');
function extract(s,name){const start=s.indexOf('function '+name+'(');const end=s.indexOf('\n}',start); if(end<0) throw Error(name);return s.slice(start,end+2);}
function playerFn(name,next){return player.slice(player.indexOf('  function '+name+'('),player.indexOf('  function '+next+'('));}
test('host and player render identical offset and width without shifting artwork',()=>{
 const m={gridSize:25.6,gridLineWidth:1.5,gridOffsetX:13,gridOffsetY:-7,mapData:'data:test',mapW:1536,mapH:1024,gridVisible:true};
 const a={world:{style:{}},activeMap:()=>m,mapGridVisible:()=>m.gridVisible,clamp:(v,a,b)=>Math.min(b,Math.max(a,v))};
 vm.createContext(a);vm.runInContext(extract(host,'updateWorldBackground'),a);vm.runInContext('updateWorldBackground()',a);
 const b={world:{style:{}},state:{},m};vm.createContext(b);vm.runInContext(playerFn('renderMap','cloneDoodleStroke'),b);vm.runInContext('renderMap(m)',b);
 assert.equal(a.world.style.backgroundPosition.replaceAll(' ',''),b.world.style.backgroundPosition.replaceAll(' ',''));
 assert.match(a.world.style.backgroundPosition,/0 0$/);assert.match(a.world.style.backgroundImage,/1.5px/);
 m.gridVisible=false;vm.runInContext('updateWorldBackground()',a);vm.runInContext('renderMap(m)',b);
 assert.equal(a.world.style.backgroundPosition,'0 0');assert.equal(b.world.style.backgroundPosition,'0 0');
});
test('offset snapping follows rendered grid for small and large tokens, including negative offsets',()=>{
 const code=host.slice(host.indexOf('const snapToCell ='),host.indexOf('const esc ='));
 const c={};vm.createContext(c);vm.runInContext(code,c);
 for(const [v,g,size,offset,want] of [[77,50,1,10,85],[77,50,2,10,60],[30,25.6,1,-7,31.4]]) {
  assert.ok(Math.abs(vm.runInContext(`snapTokenCenter(${v},${g},${size},${offset})`,c)-want)<1e-9);
 }
});
