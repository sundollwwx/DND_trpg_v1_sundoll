const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../asset/界面/休息动画/休息音频.js'),'utf8');
function fixture({blocked=false,delay=false,fail=false}={}) {
  let now=0,resolve;
  const sources=[],timers=new Map(),ticks=new Map();let id=0;
  class Context {
    constructor(){this.state=blocked?'suspended':'running';this.currentTime=0;}
    async resume(){if(!blocked)this.state='running';}
    async decodeAudioData(){return {duration:4.4};}
    createBufferSource(){const s={connect(){},disconnect(){},start(...args){this.args=args;},stop(){this.stopped=true;}};sources.push(s);return s;}
    createGain(){return {gain:{setTargetAtTime(v){this.value=v;}},connect(){},disconnect(){}};}
  }
  const global={AudioContext:Context,addEventListener(){},SundollRestScenes:{SCENES:{}}};
  const context=vm.createContext({window:global,performance:{now:()=>now},Map,Math,Number,Promise,
    fetch:async()=>{if(delay)await new Promise(r=>resolve=r);return {ok:!fail,arrayBuffer:async()=>new ArrayBuffer(1)};},
    setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    setInterval:fn=>{ticks.set(++id,fn);return id;},clearInterval:id=>ticks.delete(id)});
  vm.runInContext(source,context);
  return {api:global.SundollRestAudio,sources,resolve:()=>resolve(),advance(ms){now+=ms;for(const fn of ticks.values())fn();for(const [id,t] of [...timers])if(now>=t.at){timers.delete(id);t.fn();}}};
}
const scene={audio:'/cue.m4a'};
test('one-shot matches transition, ducks BGM without seeking and restores current volume',async()=>{
  const f=fixture(),bg={volume:.7,currentTime:31,paused:false};let volume=.7;
  assert.equal(await f.api.play(scene,2200,{volume:()=>volume,backgroundVolume:()=>volume,backgrounds:()=>[bg]}),true);
  assert.deepEqual(f.sources[0].args,[0,0,2.2]);assert.equal(f.sources[0].loop,false);
  f.advance(100);assert.ok(bg.volume<.2);assert.equal(bg.currentTime,31);assert.equal(bg.paused,false);
  volume=.3;f.advance(100);f.advance(2000);assert.equal(bg.volume,.3);assert.equal(f.sources[0].stopped,true);
});
test('shortened motion duration stops sound on time without speeding its pitch',async()=>{
  const f=fixture();await f.api.play(scene,600);assert.deepEqual(f.sources[0].args,[0,0,.6]);f.advance(600);assert.equal(f.sources[0].stopped,true);
});
test('new rest cancels previous source and explicit stop restores background',async()=>{
  const f=fixture(),bg={volume:.8};await f.api.play(scene,4400,{backgrounds:()=>[bg]});f.advance(100);
  await f.api.play(scene,2200);assert.equal(f.sources[0].stopped,true);assert.equal(bg.volume,.8);
  f.api.stop();assert.equal(f.sources[1].stopped,true);
});
test('blocked autoplay does not duck BGM or schedule delayed playback',async()=>{
  const f=fixture({blocked:true}),bg={volume:.7};let notified=0;
  assert.equal(await f.api.play(scene,2200,{backgrounds:()=>[bg],onBlocked:()=>notified++}),false);
  assert.equal(notified,1);assert.equal(bg.volume,.7);assert.equal(f.sources.length,0);
});
test('late decoding after the animation is discarded',async()=>{
  const f=fixture({delay:true}),pending=f.api.play(scene,2200);f.advance(2300);f.resolve();
  assert.equal(await pending,false);assert.equal(f.sources.length,0);
});
test('missing or failed files leave the rest flow usable',async()=>{
  const f=fixture({fail:true});let errors=0;
  assert.equal(await f.api.play({},2200),false);
  assert.equal(await f.api.play(scene,2200,{onError:()=>errors++}),false);assert.equal(errors,1);
});
