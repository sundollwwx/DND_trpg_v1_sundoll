const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const player=readClientSource('主控台/玩家.html','utf8'),host=readClientSource('主控台/host/app.js','utf8');
function extract(src,n){const start=src.indexOf(`function ${n}(`),indent=src===player?'  ':'';return src.slice(start,src.indexOf('\n'+indent+'}',start)+indent.length+2);}
test('server restart resets stale counters and late old-server responses are discarded',()=>{
 const c=vm.createContext({playerMusic:{reset(){}},state:{_sessionId:'old'},retiredServerSessions:new Set(),lastStateRevision:100,streamAppliedSeq:99,playerMapId:'m1',lastPresentedMapId:'m1',lastMapViewKey:'m1',drag:{},measureDraft:{},doodleDraft:{},patchTimer:1,pendingPatch:{},clearTimeout(){}});
 vm.runInContext(extract(player,'acceptPlayerStreamSession'),c);
 assert.equal(c.acceptPlayerStreamSession({_sessionId:'new'}),true);assert.equal(c.lastStateRevision,0);assert.equal(c.streamAppliedSeq,0);assert.equal(c.pendingPatch,null);assert.equal(c.playerMapId,null);
 c.state={_sessionId:'new'};c.lastStateRevision=3;
 assert.equal(c.acceptPlayerStreamSession({_sessionId:'old'}),false);assert.equal(c.lastStateRevision,3);
 assert.equal(c.acceptPlayerStreamSession({_sessionId:'new'}),true);assert.equal(c.lastStateRevision,3);
});
class Element {
 constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};}
 insertBefore(el,before){const old=this.children.indexOf(el);if(old>=0)this.children.splice(old,1);const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,el);el.parent=this;}
 append(...els){els.forEach(el=>this.appendChild(el));}
 appendChild(el){this.children.push(el);el.parent=this;}
 replaceWith(el){const i=this.parent.children.indexOf(this);this.parent.children[i]=el;el.parent=this.parent;}
 remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);}
}
test('unchanged token DOM survives snapshots; changed/deleted/added tokens update independently',()=>{
 const box=new Element();let portraits=0;
 // The ribbon is outside this token-layer fixture; load its actual optional
 // renderer and let its missing-container guard run, rather than stubbing it.
 const c=vm.createContext({$:selector=>selector==='#tokens'?box:null,window:{},state:{},document:{createElement:()=>new Element()},TYPE:{npc:{ring:'red'}},currentTurnToken:()=>null,
 syncMountedCoordinates(){},ownedToken:()=>false,canMoveToken:()=>true,tokenControlGroup:()=>new Set(),
 ridersOfToken:()=>[],myPlayerId:'p',myName:'player',applyPlayerPortrait(){portraits++;return false;},appendConditionBadges(){},renderNamesLayer(){},updateEndTurnUi(){}});
vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),c);
 vm.runInContext(extract(player,'renderPlayerInitiativeRibbon'),c);
 vm.runInContext(extract(player,'renderTokens'),c);
 const a={id:'a',x:1,y:1,hp:10},b={id:'b',x:2,y:2,hp:10};
 c.renderTokens({gridSize:50,tokens:[a,b]});const first=box.children.slice();
 for(let i=0;i<100;i++)c.renderTokens({gridSize:50,tokens:[{...a},{...b}]});
 assert.equal(portraits,2);assert.equal(box.children[0],first[0]);assert.equal(box.children[1],first[1]);
 c.renderTokens({gridSize:50,tokens:[b,a]});assert.deepEqual(box.children.map(el=>el.dataset.id),['b','a']);
 c.renderTokens({gridSize:50,tokens:[{...a,hp:5},b]});assert.notEqual(box.children[0],first[0]);assert.equal(box.children[1],first[1]);
 c.renderTokens({gridSize:50,tokens:[b,{id:'c',x:3,y:3}]});assert.deepEqual(box.children.map(el=>el.dataset.id),['b','c']);
});
test('save API receives original loaded hash and propagates conflicts without retrying overwrite',async()=>{
 let request;const c=vm.createContext({usingLocalSaveBridge:()=>true,localSaveApiRequest:async(op,payload)=>{request={op,...payload};throw Error('conflict');}});
 vm.runInContext('async '+extract(host,'writeCurrentCampaign'),c);
 await assert.rejects(c.writeCurrentCampaign('战役/c1/当前存档.json',{state:{maps:[]}},'loaded-hash'),/conflict/);
 assert.equal(request.op,'write-campaign');assert.equal(request.expectedHash,'loaded-hash');
});
