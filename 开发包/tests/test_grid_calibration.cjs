const {readClientSource}=require('./client_sources.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const {createMapDom,installPlayerMapRenderer}=require('./map_render_fixture.cjs');
const host=readClientSource('主控台/host/app.js','utf8');
function extract(s,name){const start=s.indexOf('function '+name+'(');const end=s.indexOf('\n}',start); if(end<0) throw Error(name);return s.slice(start,end+2);}
test('host and player render identical offset and width without shifting artwork',()=>{
 const m={gridSize:25.6,gridLineWidth:1.5,gridOffsetX:13,gridOffsetY:-7,mapData:'data:test',mapW:1536,mapH:1024,gridVisible:true};
 const a={world:{style:{}},activeMap:()=>m,mapGridVisible:()=>m.gridVisible,clamp:(v,a,b)=>Math.min(b,Math.max(a,v))};
 vm.createContext(a);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),a);vm.runInContext(extract(host,'updateWorldBackground'),a);vm.runInContext('updateWorldBackground()',a);
 const b={...createMapDom(),state:{},m};vm.createContext(b);installPlayerMapRenderer(b);vm.runInContext('renderMap(m)',b);
 assert.equal(a.world.style.backgroundPosition.replaceAll(' ',''),b.world.style.backgroundPosition.replaceAll(' ',''));
 assert.match(a.world.style.backgroundPosition,/0 0$/);assert.match(a.world.style.backgroundImage,/1.5px/);
 m.gridVisible=false;vm.runInContext('updateWorldBackground()',a);vm.runInContext('renderMap(m)',b);
 assert.equal(a.world.style.backgroundPosition,'0 0');assert.equal(b.world.style.backgroundPosition,'0 0');
});
test('offset snapping follows rendered grid for small and large tokens, including negative offsets',()=>{
 const code=host.slice(host.indexOf('const snapTokenCenter ='),host.indexOf('const esc ='));
 const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),c);vm.runInContext(code,c);
 for(const [v,g,size,offset,want] of [[77,50,1,10,85],[77,50,2,10,60],[30,25.6,1,-7,31.4]]) {
  assert.ok(Math.abs(vm.runInContext(`snapTokenCenter(${v},${g},${size},${offset})`,c)-want)<1e-9);
 }
});
