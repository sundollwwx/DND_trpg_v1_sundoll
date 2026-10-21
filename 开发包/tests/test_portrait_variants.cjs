const {readClientSource}=require('./client_sources.cjs');
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const library = readClientSource('asset/棋子库/棋子库.html', 'utf8');
const host = readClientSource('主控台/host/app.js', 'utf8');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const SundollRules = require(require('node:path').join(require('./project_paths.cjs').APP_ROOT,'shared/rules.js'));
const variant = { name: '常态', iconImgPath: '立绘/玩家/测试.png' };
for (const [source, name] of [[library, 'normalize'], [host, 'normalizeLibPreset']]) {
  const context = { SundollRules, uid: 1, canonicalPortraitPath: v => v || null, normalizeSpellRange: v => v || {} };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),context);vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),context);
  if (source === host) vm.runInContext(extract(host, 'normalizePortraitVariants'), context);
  vm.runInContext(extract(source, name), context);
  const result = context[name]({ name: '角色', portraitVariants: [variant, null, {name: '无图片'}] });
  assert.equal(result.portraitVariants.length, 1);
  assert.equal(result.portraitVariants[0].iconImgPath, variant.iconImgPath);
  result.portraitVariants[0].name = '修改';
  assert.equal(variant.name, '常态');
  assert.equal(context[name]({}).portraitVariants.length, 0);
  const again = context[name](JSON.parse(JSON.stringify(result)));
  assert.equal(again.portraitVariants[0].name, '修改');
}

{
  const context = {
    SundollRules,
    uid: 1,
    TYPE_META: { pc: {}, enemy: {}, npc: {}, ally: {} },
    canonicalPortraitPath: v => v || null,
    normalizeSpellRange: v => v || {},
    normalizeCondition: v => v,
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),context);vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),context);
  vm.runInContext(extract(host, 'normalizePortraitVariants'), context);
  vm.runInContext(extract(host, 'archiveLegacyGmNote'), context);
  vm.runInContext(extract(host, 'normalizeSheet'), context);
  const token = {
    id: 't-form', name: '多形态角色', type: 'pc', presetId: 'l-form', hp: 8, hpMax: 10,
    portraitVariants: [
      { name: '常态', iconImgPath: '立绘/玩家/常态.png' },
      { name: '战斗', iconImgPath: '立绘/玩家/战斗.png' },
    ],
    portraitVariant: 1,
  };
  context.normalizeSheet(token);
  assert.equal(token.presetId, 'l-form');
  assert.equal(token.portraitVariants.length, 2);
  assert.equal(token.portraitVariant, 1);
  assert.equal(token.portraitVariants[1].name, '战斗');

  const explicitlyEmpty = { id: 't-empty', name: '无形态角色', type: 'pc', portraitVariants: [] };
  context.normalizeSheet(explicitlyEmpty);
  assert.ok(Object.hasOwn(explicitlyEmpty, 'portraitVariants'));
  assert.deepEqual(explicitlyEmpty.portraitVariants, []);
  assert.equal(Object.hasOwn(explicitlyEmpty, 'portraitVariant'), false);
}
const handlers = {};
const select = { value: '', replaceChildren() {}, add() {} };
const context = { editorPortraitVariants: [variant], avatar: null, syncIconPreview() {}, Option: function() {},
  $: id => ({ addEventListener: (_, fn) => { handlers[id] = fn; } }), prompt: () => null, toast() {} };
vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),context);vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),context);vm.runInContext(readClientSource('主控台/shared/downed-portrait.js'),context);
const start = library.indexOf("$('#ed-portrait-variant').addEventListener");
const end = library.indexOf("$('#btn-portrait-snapshot').addEventListener", start);
vm.runInContext(library.slice(start, end), context);
handlers['#ed-portrait-variant']({target: {value: '0'}});
assert.equal(context.avatar.iconImgPath, variant.iconImgPath);
assert.equal(context.avatar.iconImg, null);
console.log('Portrait variant normalization, round-trip and selection checks passed.');

// Empty legacy snapshots inherit only an unambiguous library binding.
{
 const c={SundollRules,state:{library:[
  {id:'one',name:'同名',type:'pc',iconImgPath:'first.png',portraitVariants:[{name:'战斗',iconImgPath:'fight.png'}]},
  {id:'two',name:'同名',type:'pc',iconImgPath:'second.png',portraitVariants:[]}
 ]},canonicalPortraitPath:v=>v||null};
 vm.createContext(c);vm.runInContext(fs.readFileSync(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/token-size.js'),'utf8'),c);vm.runInContext(readClientSource('主控台/shared/portrait-view.js'),c);
 for(const n of ['normalizePortraitVariants','portraitAssetIdentity','portraitLibraryPresetForToken','tokenPortraitVariants','currentTokenPortraitVariantIndex','mergeOwnedPortraitForms'])vm.runInContext(extract(host,n),c);
 assert.equal(c.portraitLibraryPresetForToken({name:'同名',type:'pc'}),null);
 assert.equal(c.tokenPortraitVariants({presetId:'one',portraitVariants:[]}).length,1);
 assert.equal(c.tokenPortraitVariants({presetId:'one',portraitVariants:[],portraitVariantsCustomized:true}).length,0);
 assert.equal(c.tokenPortraitVariants({ownedPieceId:'owned',presetId:'one',portraitVariants:[]}).length,0);
 const token={hp:4,conditions:['poison'],iconImgPath:'fight.png',portraitVariants:[]};
 c.mergeOwnedPortraitForms(token,{revision:3,sourcePresetId:'one',portraitVariants:c.state.library[0].portraitVariants});
 assert.equal(token.hp,4);assert.equal(token.conditions[0],'poison');assert.equal(token.portraitVariant,0);
 c.mergeOwnedPortraitForms(token,{revision:3,portraitVariants:c.state.library[0].portraitVariants});
 assert.equal(token.portraitVariants.length,1);
 const first={scale:1,offsetX:0,offsetY:0},second={scale:1.5,offsetX:.1,offsetY:0};
 const sameImage={iconImgPath:'shared.png',portraitView:second,portraitVariants:[{name:'常态',iconImgPath:'shared.png',portraitView:first}]};
 c.mergeOwnedPortraitForms(sameImage,{revision:4,portraitVariants:[{name:'倒地',iconImgPath:'shared.png',portraitView:second}]});
 assert.equal(sameImage.portraitVariants.length,2,'merging collections retains same-image forms with independent views');
 assert.equal(sameImage.portraitVariant,1);
}
