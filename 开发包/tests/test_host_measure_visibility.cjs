const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readClientSource}=require('./client_sources.cjs');
const source=readClientSource('主控台/host/app.js');
const code=source.slice(source.indexOf('function renderHostMeasure('),source.indexOf('\nfunction syncBoardTools('));
test('measurement removes the SVG hidden attribute and restores it when disabled or on another map',()=>{
 const line={setAttribute(k,v){this[k]=v;}},circles=[{setAttribute(k,v){this[k]=v;}},{setAttribute(k,v){this[k]=v;}}];
 // SVG has no reflected HTMLElement.hidden setter: only attributes govern CSS visibility.
 const attrs=new Set(['hidden']);
 const overlay={toggleAttribute(k,force){force?attrs.add(k):attrs.delete(k);},querySelector:()=>line,querySelectorAll:()=>circles};
 const label={hidden:true,style:{}},map={id:'m',gridSize:50,cam:{x:10,y:20,zoom:2}};
 const c=vm.createContext({activeMap:()=>map,$:id=>id==='#host-measure-overlay'?overlay:label,boardTool:'measure',hostMeasureDraft:{mapId:'m',from:{x:25,y:25},to:{x:125,y:75}},SundollRules:{measureGridFeet:()=>10}});
 vm.runInContext(code,c);c.renderHostMeasure();
 assert.equal(attrs.has('hidden'),false);assert.equal(label.hidden,false);
 assert.deepEqual([line.x1,line.y1,line.x2,line.y2],[60,70,260,170]);assert.equal(label.textContent,'10 尺');
 c.boardTool=null;c.renderHostMeasure();assert.equal(attrs.has('hidden'),true);assert.equal(label.hidden,true);
 c.boardTool='measure';c.hostMeasureDraft.mapId='other';c.renderHostMeasure();assert.equal(attrs.has('hidden'),true);
});
