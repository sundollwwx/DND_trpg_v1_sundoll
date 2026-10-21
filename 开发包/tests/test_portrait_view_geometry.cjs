const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function helper(){
  const context={Image:class{constructor(){this.naturalWidth=200;this.naturalHeight=100;}set src(value){queueMicrotask(()=>this.onload());}},queueMicrotask};
  context.window={getComputedStyle:el=>el.computedStyle||{}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT,'主控台/shared/portrait-view.js'),'utf8'),context);
  return context.window.SundollPortraitView;
}
test('hidden 40px form preview uses frame dimensions without feeding image width back into zoom',async()=>{
  const h=helper(),frame={clientWidth:0,clientHeight:0,style:{width:'40px',height:'40px'}};
  const image={tagName:'IMG',clientWidth:0,clientHeight:0,style:{},src:'wide.png',parentElement:frame};
  const source={portraitView:{scale:1.5,offsetX:.1,offsetY:0}};
  h.apply(image,source);await new Promise(setImmediate);
  const near=(value,target)=>assert.ok(Math.abs(parseFloat(value)-target)<1e-9,`${value} is close to ${target}px`);
  near(image.style.width,120);near(image.style.height,60);
  near(image.style.left,-36);near(image.style.top,-10);
  h.apply(image,source);await new Promise(setImmediate);
  near(image.style.width,120);
  frame.clientWidth=frame.clientHeight=40;
  h.apply(image,source);await new Promise(setImmediate);
  near(image.style.left,-36);
});
test('hidden CSS-sized circle keeps cover geometry for a rectangular original',async()=>{
  const h=helper(),el={tagName:'DIV',clientWidth:0,clientHeight:0,style:{backgroundImage:'url("wide.png")'},computedStyle:{width:'36px',height:'36px'}};
  h.apply(el,{portraitView:{scale:1,offsetX:0,offsetY:0}});await new Promise(setImmediate);
  assert.equal(el.style.backgroundSize,'72px 36px');assert.equal(el.style.backgroundPosition,'-18px 0px');
});
