const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {APP_ROOT} = require('./project_paths.cjs');
const librarySource = fs.readFileSync(path.join(APP_ROOT, '主控台/shared/player-library.js'), 'utf8');
const templateSource = fs.readFileSync(path.join(APP_ROOT, 'asset/棋子库/棋子库.html'), 'utf8');
const viewSource = fs.readFileSync(path.join(APP_ROOT, '主控台/shared/portrait-view.js'), 'utf8');
const moduleUrl = digit => '/api/module-assets/' + digit.repeat(64);
const view = scale => ({scale, offsetX:0, offsetY:0});
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
function extract(source, name) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end + 2);
}
function sharedContext(extra = {}) {
  const context = vm.createContext({...extra});
  context.window = context;
  vm.runInContext(viewSource, context);
  return context;
}
async function saveFormsFixture(token, host = false) {
  const calls = [];
  const context = sharedContext({location:{protocol:'http:'}, fetch:async (url, options) => {
    assert.equal(url, '/api/player-profiles');
    const data = JSON.parse(options.body); calls.push(data);
    return {ok:true, json:async () => data.op === 'get'
      ? {ok:true, library:{revision:7, pieces:[{ownedPieceId:'owned-test', revision:3}]}}
      : {ok:true}};
  }});
  vm.runInContext(librarySource, context);
  context.PlayerLibrary.configure({host, session:() => 'isolated-test-session'});
  const before = plain(token);
  await context.PlayerLibrary.saveForms(token);
  assert.deepEqual(plain(token), before, 'collection saves do not mutate the map token');
  assert.equal(calls[1].revision, 7);
  assert.equal(calls[1].pieceRevision, 3);
  assert.equal(calls[1].playerId, 'player-test');
  assert.equal(calls[1].ownedPieceId, 'owned-test');
  assert.equal('hp' in calls[1].patch, false);
  assert.equal('conditions' in calls[1].patch, false);
  return calls[1].patch;
}
function tokenFixture(forms, index = 1) {
  return {...forms[index], ownedPieceId:'owned-test', ownerPlayerId:'player-test',
    hp:0, conditions:[{name:'昏迷'}], portraitVariant:index, portraitVariants:forms};
}
test('same-image collection saves preserve the selected framing and form metadata', async () => {
  const forms = [
    {name:'全身', formId:'form-full', iconImgPath:moduleUrl('a'), portraitView:view(1)},
    {name:'近景', formId:'form-close', iconImgPath:moduleUrl('a'), portraitView:view(2), initiativePortrait:{iconImgPath:moduleUrl('b')}},
  ];
  const token = tokenFixture(forms); token.portraitVariant = 0;
  const patch = await saveFormsFixture(token);
  assert.equal(patch.portraitVariant, 1, 'a stale image-only hint cannot select the other crop');
  assert.deepEqual(patch.portraitVariants, forms);
  assert.equal('initiativePortrait' in patch, false, 'players do not gain a host-only field');
});
test('a valid hint preserves distinct forms with identical image and framing', async () => {
  const forms = [
    {name:'常态', iconImgPath:moduleUrl('a'), portraitView:view(1)},
    {name:'战斗', iconImgPath:moduleUrl('a'), portraitView:view(1)},
  ];
  const token = tokenFixture(forms); token.initiativePortrait = {iconImgPath:moduleUrl('c')};
  const patch = await saveFormsFixture(token, true);
  assert.equal(patch.portraitVariant, 1);
  assert.deepEqual(patch.initiativePortrait, token.initiativePortrait);
});
test('implicit legacy framing does not match an explicit default crop', async () => {
  const forms = [{name:'显式取景', iconImgPath:moduleUrl('a'), portraitView:view(1)},
    {name:'旧取景', iconImgPath:moduleUrl('a')}];
  assert.equal((await saveFormsFixture(tokenFixture(forms))).portraitVariant, 1);
});
test('an unmatched custom portrait is not forced into the first saved form', async () => {
  const forms = [{name:'常态', iconImgPath:moduleUrl('a'), portraitView:view(1)}];
  const token = {...tokenFixture(forms, 0), iconImgPath:moduleUrl('b')};
  assert.equal('portraitVariant' in await saveFormsFixture(token), false);
});

function templateContext(presets, extra = {}) {
  const controls = new Map(), messages = [], rows = [], cacheWrites = [];
  const $ = id => {
    if (!controls.has(id)) controls.set(id, {hidden:true, disabled:false, innerHTML:'', textContent:'', classList:{add(){}, remove(){}}});
    return controls.get(id);
  };
  const memory = new Map();
  const context = sharedContext({presets:plain(presets), uid:1, libEditRevision:0,
    libWriteQueue:Promise.resolve(), libFileTimer:null, libraryLoadedHash:'source-hash', libraryReadHash:null,
    LIBRARY_KEY:'test-library', LIBRARY_PENDING_KEY:'test-pending', LIBRARY_SAVED_AT_KEY:'test-saved',
    SAVE_LIBRARY_DIR:'棋子库', SAVE_LIBRARY_FILE:'棋子库.json', location:{protocol:'http:'},
    AVATAR_HD_MAX:2048, AVATAR_DISPLAY_MAX:512, AVATAR_LOW_MAX:192,
    localStorage:{getItem:key=>memory.get(key)||null, setItem:(key,value)=>memory.set(key,value), removeItem:key=>memory.delete(key)},
    canonicalPortraitPath:value=>value||null, $, messages, rows, controls, memory, cacheWrites,
    toast:message=>messages.push(message), hdAddRow:(...row)=>rows.push(row), esc:value=>value,
    clearTimeout(){}, setTimeout:()=>1, renderAll(){}, updateHdBadge(){}, updateLibPersistStatus(){},
    console:{warn(){}}, storeAvatar:async (id,data)=>cacheWrites.push({id,data}),
    ...extra});
  for (const name of ['normalize','libraryUsesLocalSaveBridge','librarySaveRequest','libraryPackage',
    'writeLibraryFile','flushLibraryFileWrite','scheduleLibraryFileWrite','saveLibrary',
    'hdNormPath','modulePortraitUrls','checkModulePortraitCache','runHdRepair','importPortraitFile']) {
    vm.runInContext(extract(templateSource, name), context);
  }
  return context;
}
function imageResponse(mime = 'image/webp', size = 300) {
  return {ok:true, headers:{get:()=>mime}, blob:async()=>({size})};
}
const legacyFile = relative => ({name:'测试.png', webkitRelativePath:'棋子库/' + relative});
test('module cache checks preserve formal records despite a same-named old file', async () => {
  const presets = [{id:'npc-test', name:'测试', moduleId:'私人收藏', revision:8, iconImgPath:moduleUrl('a'),
    portraitView:view(.75), portraitVariant:0, portraitVariants:[{name:'战斗', iconImgPath:moduleUrl('a'), formId:'form-battle'}],
    initiativePortrait:{iconImgPath:moduleUrl('b')}, hpMax:100, ac:18}];
  const reads = [];
  const context = templateContext(presets, {fetch:async (url, options)=>{reads.push({url, options});return imageResponse();},
    processAvatarFile:()=>assert.fail('A selected old file must not replace a module original')});
  await context.runHdRepair([legacyFile('立绘/旧目录/测试.png')]);
  assert.deepEqual(plain(context.presets), presets);
  assert.deepEqual(reads.map(r=>r.url), [moduleUrl('a')+'?variant=token-192', moduleUrl('a')+'?variant=token-512',
    moduleUrl('b')+'?variant=token-192', moduleUrl('b')+'?variant=token-512']);
  assert.ok(reads.every(r=>r.options.cache === 'reload' && !r.options.method));
  assert.equal(context.memory.size, 0, 'cache checks must not schedule catalog persistence');
  assert.equal(context.cacheWrites.length, 0);
});
test('duplicate module references share display requests within a cache check', async () => {
  let requests = 0;
  const context = templateContext([{name:'甲',iconImgPath:moduleUrl('a')},{name:'乙',iconImgPath:moduleUrl('a')}],
    {fetch:async()=>{requests++;return imageResponse();}});
  await context.runHdRepair();
  assert.equal(requests, 2);
});
test('original fallback still waits for every other asset and reports a later failure', async () => {
  const presets = [{name:'测试',iconImgPath:moduleUrl('a'),initiativePortrait:{iconImgPath:moduleUrl('b')}}];
  const reads = [];
  const context = templateContext(presets, {fetch:async url=>{
    reads.push(url);if(url.includes(moduleUrl('b')))throw new Error('missing head');return imageResponse('image/png');
  }});
  await context.runHdRepair();
  assert.equal(reads.length, 3, 'a fallback result must not short-circuit the next awaited asset');
  assert.match(context.$('#hd-status').textContent, /失败 1/);
  assert.equal(context.$('#btn-hd-modules').disabled, false);
  assert.deepEqual(plain(context.presets), presets);
});
test('missing module originals are reported without creating or relinking anything', async () => {
  const presets = [{name:'测试',iconImgPath:moduleUrl('a')}];
  const context = templateContext(presets, {fetch:async()=>({ok:false,headers:{get:()=> 'text/html'}}),
    processAvatarFile:()=>assert.fail('No original may be invented')});
  await context.runHdRepair([legacyFile('立绘/测试.png')]);
  assert.deepEqual(plain(context.presets), presets);
  assert.match(context.$('#hd-status').textContent, /失败 1/);
});
test('legacy repair matches exact paths and updates only the already recorded cache ID', async () => {
  const presets = [{name:'测试',iconImgPath:'立绘/正确目录/测试.png',iconImgId:'existing-cache',iconImg:'old-thumb',portraitView:view(1)}];
  const context = templateContext(presets, {processAvatarFile:(file,done)=>done({hd:'decoded-source',thumb:'new-thumb',display:'new-display'})});
  await context.runHdRepair([legacyFile('立绘/正确目录/测试.png'),legacyFile('立绘/其他目录/测试.png')]);
  assert.deepEqual(context.cacheWrites, [{id:'existing-cache',data:'decoded-source'}]);
  assert.deepEqual(plain(context.presets), presets);
  assert.equal(context.memory.size, 0);
});
test('a basename collision or absent cache ID cannot create a new portrait association', async () => {
  const presets = [{name:'测试',iconImgPath:'立绘/正确目录/测试.png',iconImgId:'existing-cache'},
    {name:'未绑定',iconImgPath:'立绘/正确目录/测试.png'}];
  const context = templateContext(presets, {processAvatarFile:()=>assert.fail('Only an exact existing cache may be repaired')});
  await context.runHdRepair([legacyFile('立绘/其他目录/测试.png')]);
  assert.deepEqual(plain(context.presets), presets);
  assert.equal(context.cacheWrites.length, 0);
  assert.match(context.$('#hd-status').textContent, /跳过 2/);
});
test('legacy browser-only caches use their existing bytes without changing formal metadata', async () => {
  const presets = [{name:'缓存角色',iconImgId:'old-cache',iconImg:'kept-preview'}];
  const context = templateContext(presets, {avatarGet:async id=>{assert.equal(id,'old-cache');return 'existing-bytes';}});
  await context.runHdRepair();
  assert.deepEqual(context.cacheWrites,[{id:'old-cache',data:'existing-bytes'}]);
  assert.deepEqual(plain(context.presets), presets);
});

function importFixture() {
  const response = defer(), started = defer(), requests = [];
  let callback;
  const preset = {id:'npc-test',name:'测试',type:'npc',category:'城主/通用角色',moduleId:'私人收藏',
    hpMax:100,ac:18,iconImgPath:moduleUrl('a'),portraitVariants:[{name:'旧形态',iconImgPath:moduleUrl('a'),formId:'form-old'}]};
  const context = templateContext([preset], {archivePortraitFile:async()=>null,
    processAvatarFile:(file,cb)=>{callback=cb;}, fetch:async (url,options)=>{
      assert.equal(url,'/api/local-save');requests.push(JSON.parse(options.body));started.resolve();return response.promise;
    }});
  context.portraitSelectedPreset = ()=>context.presets[0];
  context.importPortraitFile({name:'隔离候选.png',type:'image/png'});
  const finished = callback({hd:'isolated-hd',display:'isolated-display',thumb:'isolated-thumb',portraitView:view(1.3)});
  return {context,response,started,requests,finished,preset};
}
test('portrait import success waits for the formal write acknowledgement', async () => {
  const fixture = importFixture();await fixture.started.promise;
  assert.equal(fixture.context.messages.some(m=>m.includes('✅')),false);
  assert.equal(fixture.context.$('#portrait-preview-row').hidden,true);
  assert.equal(fixture.requests[0].catalogHash,'source-hash');
  assert.equal(fixture.requests[0].path,'棋子库/棋子库.json');
  const saved = JSON.parse(fixture.requests[0].text).presets[0];
  assert.equal(saved.hpMax,fixture.preset.hpMax);assert.equal(saved.ac,fixture.preset.ac);
  assert.equal(saved.moduleId,fixture.preset.moduleId);
  assert.deepEqual(saved.portraitVariants,fixture.preset.portraitVariants);
  fixture.response.resolve({ok:true,json:async()=>({ok:true,catalogHash:'updated-hash'})});
  await fixture.finished;
  assert.ok(fixture.context.messages.some(m=>m.includes('✅')));
  assert.match(fixture.context.$('#portrait-preview-status').textContent,/已保存到所属模块/);
  assert.equal(fixture.context.memory.has('test-pending'),false);
});
test('formal save conflicts retain the draft and cannot display an import success', async () => {
  const fixture=importFixture();await fixture.started.promise;
  fixture.response.resolve({ok:false,json:async()=>({ok:false,error:'棋子库已被其他页面更新'})});
  await fixture.finished;
  assert.equal(fixture.context.messages.some(m=>m.includes('✅')),false);
  assert.match(fixture.context.$('#portrait-preview-status').textContent,/尚未完成正式保存/);
  assert.equal(fixture.context.presets[0].iconImgHd,'isolated-display');
  assert.equal(fixture.context.memory.has('test-pending'),true);
  assert.equal(fixture.context.presets[0].hpMax,fixture.preset.hpMax);
});
test('import uses the current preset when another edit replaces objects during image preparation', async () => {
  const fixture=importFixture();
  fixture.context.presets=fixture.context.presets.map(piece=>({...piece,name:'读取图片期间改名'}));
  await fixture.started.promise;
  const submitted=JSON.parse(fixture.requests[0].text).presets[0];
  assert.equal(submitted.name,'读取图片期间改名');
  assert.equal(submitted.iconImgHd,'isolated-display','the import must not mutate a discarded object');
  fixture.response.resolve({ok:true,json:async()=>({ok:true,catalogHash:'fresh-hash'})});
  await fixture.finished;
});
test('an import cannot report success after its target preset has been removed', async () => {
  const fixture=importFixture();fixture.context.presets=[];
  await fixture.finished;
  assert.equal(fixture.requests.length,0,'a removed preset must not be recreated or persisted');
  assert.equal(fixture.context.messages.some(m=>m.includes('✅')),false);
  assert.ok(fixture.context.messages.some(m=>m.includes('已移除')));
});
test('an edit made during import persistence remains pending after the older write completes', async () => {
  const fixture=importFixture();await fixture.started.promise;
  fixture.context.presets[0].name='保存期间的新名字';fixture.context.saveLibrary();
  fixture.response.resolve({ok:true,json:async()=>({ok:true,catalogHash:'older-write-hash'})});
  await fixture.finished;
  assert.equal(fixture.context.messages.some(m=>m.includes('✅')),false);
  assert.equal(fixture.context.memory.has('test-pending'),true);
  assert.equal(fixture.context.presets[0].name,'保存期间的新名字');
});
test('a network failure keeps imported content as an unsaved draft', async () => {
  const fixture=importFixture();await fixture.started.promise;
  fixture.response.reject(new Error('isolated network failure'));await fixture.finished;
  assert.equal(fixture.context.messages.some(m=>m.includes('✅')),false);
  assert.equal(fixture.context.memory.has('test-pending'),true);
  assert.equal(fixture.context.presets[0].iconImgHd,'isolated-display');
});
