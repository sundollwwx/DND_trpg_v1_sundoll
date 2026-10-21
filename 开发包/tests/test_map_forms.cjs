const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {APP_ROOT}=require('./project_paths.cjs');
const forms=require(path.join(APP_ROOT,'shared/map-forms.js'));
function fixture(){return {id:'tower',mapW:1200,mapH:1200,mapData:'/closed',tokens:[{id:'hero',hp:3,x:20,y:40}],doodles:[{id:'d1'}],cam:{x:12,y:30,zoom:2},playerAccessible:true,mapItems:[{id:'chest'}]};}
test('form switch preserves every scene field and supports save/reload',()=>{
 const m=fixture(),before=structuredClone(m),tokens=m.tokens;
 forms.add(m,{id:'open',name:'桥开启',mapData:'/open'},1200,1200);
 assert.equal(m.mapData,'/closed');
 forms.apply(m,'open');
 assert.equal(m.mapData,'/open');assert.equal(m.tokens,tokens);
 for(const k of Object.keys(before))if(k!=='mapData')assert.deepEqual(m[k],before[k]);
 const saved=JSON.parse(JSON.stringify(m));assert.equal(forms.fields(saved).activeMapFormId,'open');assert.equal(forms.fields(saved).mapData,'/open');
 forms.apply(m,'original');assert.equal(m.mapData,'/closed');
});
test('wrong dimensions and unknown forms cannot change live scene',()=>{
 const m=fixture(),before=structuredClone(m);
 assert.throws(()=>forms.add(m,{id:'bad',mapData:'/bad'},500,500),/尺寸/);
 assert.throws(()=>forms.apply(m,'missing'),/不存在/);assert.deepEqual(m,before);
});
test('normalization strips any per-form scene data',()=>{
 const m=fixture();m.mapForms=[{id:'f',mapData:'/f',name:'F',tokens:[{id:'hidden'}]}];
 assert.deepEqual(forms.fields(m).mapForms,[{id:'f',name:'F',mapData:'/f'}]);
 assert.deepEqual(forms.fields(fixture()),{});
});
test('player projection includes only applied background, never inactive forms',()=>{
 const src=fs.readFileSync(path.join(APP_ROOT,'主控台/host/app.js'),'utf8');
 const start=src.indexOf('function publicStreamMap('),end=src.indexOf('\nfunction ',start+1);
 const ctx=vm.createContext({SundollRules:require(path.join(APP_ROOT,'shared/rules.js')),cachedStreamMapAssetUrl:()=>'',publicStreamToken:t=>t,mapGridVisible:()=>true,ensureDoodleIds:m=>m.doodles});
 vm.runInContext(src.slice(start,end),ctx);
 const m=fixture();forms.add(m,{id:'secret',name:'秘密形态',mapData:'/secret'},1200,1200);
 const publicMap=ctx.publicStreamMap(m,true,new Set());
 assert.ok(!JSON.stringify(publicMap).includes('/secret'));assert.ok(!('mapForms' in publicMap));
 forms.apply(m,'secret');const switched=ctx.publicStreamMap(m,true,new Set());
 assert.equal(switched.mapData,'/secret');assert.ok(!JSON.stringify(switched).includes('/closed'));
 m.playerAccessible=false;assert.equal(ctx.publicStreamMap(m,false,new Set()).mapData,null);
});
test('host HTML loads form rules before storage and editor before bootstrap',()=>{
 const html=fs.readFileSync(path.join(APP_ROOT,'主控台/主控台.html'),'utf8');
 assert.ok(html.indexOf('../shared/map-forms.js')<html.indexOf('host/storage.js'));
 assert.ok(html.indexOf('host/map-forms.js')<html.indexOf('host/bootstrap.js'));
});
