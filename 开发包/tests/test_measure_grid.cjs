const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=readClientSource('主控台/玩家.html','utf8');
const c=require(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/rules.js'));
const feet=(x,y,g=50)=>c.measureGridFeet({x:0,y:0},{x:x*g,y:y*g},g);
test('successive diagonal squares cost 5, 10, 5, 10 feet',()=>{
 assert.deepEqual([0,1,2,3,4,5,6].map(n=>feet(n,n)),[0,5,15,20,30,35,45]);
});
test('straight and mixed directions count shortest grid route in every quadrant',()=>{
 for(const sx of [-1,1])for(const sy of [-1,1]){
 assert.equal(feet(4*sx,0),20);assert.equal(feet(0,3*sy),15);
 assert.equal(feet(5*sx,2*sy),30);assert.equal(feet(3*sx,5*sy),30);
 }
});
test('distance is symmetric and independent of grid size and origin offset',()=>{
 for(const g of [25,50,100]){
 const a={x:13,y:-29},b={x:13+2*g,y:-29+2*g};
 assert.equal(c.measureGridFeet(a,b,g),15);assert.equal(c.measureGridFeet(b,a,g),15);
 }
});
test('partial squares interpolate their current 5 or 10 foot step',()=>{
 assert.equal(feet(.5,.5),2.5);assert.equal(feet(1.5,1.5),10);assert.equal(feet(2.5,2.5),17.5);
});
test('ruler display uses grid rule instead of Euclidean distance',()=>{
 const body=source.slice(source.indexOf('  function renderTurnPath('),source.indexOf('  function updateToolButtons('));
 assert.match(body,/feet=measureGridFeet\(measureDraft.from,measureDraft.to,currentMap.gridSize\)/);
 assert.doesNotMatch(body,/feet=Math.hypot/);
});

test('both rulers snap to grid intersections and centers, including shifted grids',()=>{
 const map={gridSize:50,gridOffsetX:10,gridOffsetY:20};
 assert.deepEqual(c.snapMeasurePoint({x:12,y:18},map,1),{x:10,y:20});
 assert.deepEqual(c.snapMeasurePoint({x:34,y:46},map,1),{x:35,y:45});
 assert.deepEqual(c.snapMeasurePoint({x:23,y:21},map,1),{x:10,y:20});
 assert.deepEqual(c.snapMeasurePoint({x:23,y:21},map,2),{x:23,y:21});
 assert.deepEqual(c.snapMeasurePoint({x:-38,y:-29},map,1),{x:-40,y:-30});
});
