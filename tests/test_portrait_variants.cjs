const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const library = fs.readFileSync('asset/棋子库/棋子库.html', 'utf8');
const host = fs.readFileSync('主控台/app.js', 'utf8');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
const variant = { name: '常态', iconImgPath: '立绘/玩家/测试.png' };
for (const [source, name] of [[library, 'normalize'], [host, 'normalizeLibPreset']]) {
  const context = { uid: 1, canonicalPortraitPath: v => v || null, normalizeSpellRange: v => v || {} };
  vm.createContext(context);
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
    uid: 1,
    TYPE_META: { pc: {}, enemy: {}, npc: {}, ally: {} },
    canonicalPortraitPath: v => v || null,
    normalizeSpellRange: v => v || {},
    normalizeCondition: v => v,
  };
  vm.createContext(context);
  vm.runInContext(extract(host, 'normalizePortraitVariants'), context);
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
vm.createContext(context);
const start = library.indexOf("$('#ed-portrait-variant').addEventListener");
const end = library.indexOf("$('#btn-portrait-snapshot').addEventListener", start);
vm.runInContext(library.slice(start, end), context);
handlers['#ed-portrait-variant']({target: {value: '0'}});
assert.equal(context.avatar.iconImgPath, variant.iconImgPath);
assert.equal(context.avatar.iconImg, null);
console.log('Portrait variant normalization, round-trip and selection checks passed.');
