const assert = require('node:assert/strict');
require('../../程序包/主程序/主控台/shared/portrait-view.js');
require('../../程序包/主程序/主控台/shared/downed-portrait.js');

const forms = [
  {name: '忒修斯', iconImgPath: '/art/normal'},
  {name: '剑歌', iconImgPath: '/art/song'},
  {name: '倒地失能', iconImgPath: '/art/down'},
];
const token = {type: 'pc', hp: 5, portraitVariants: forms, iconImgPath: '/art/song', portraitVariant: 1};
const sync = globalThis.SundollDownedPortrait.sync;
token.hp = 0;
assert.equal(sync(token), true);
assert.equal(token.iconImgPath, '/art/down');
assert.equal(token.portraitBeforeDowned, 'iconImgPath:/art/song');
token.portraitVariants = [forms[2], forms[0], forms[1]];
token.hp = 4;
assert.equal(sync(token), true);
assert.equal(token.iconImgPath, '/art/song');
assert.equal(token.portraitVariant, 2);
assert.equal(token.portraitBeforeDowned, undefined);

// One original image can represent different saved display ranges.
const normalView = {scale:1, offsetX:0, offsetY:0};
const battleView = {scale:1.4, offsetX:.15, offsetY:-.05};
const downView = {scale:1.8, offsetX:-.1, offsetY:.2};
const sharedForms = [
  {name:'常态', iconImgPath:'/art/shared', portraitView:normalView},
  {name:'剑歌', iconImgPath:'/art/shared', portraitView:battleView},
  {name:'倒地', iconImgPath:'/art/shared', portraitView:downView},
];
const shared = {type:'pc',hp:0,iconImgPath:'/art/shared',portraitView:{...battleView},portraitVariant:1,portraitVariants:sharedForms};
assert.equal(sync(shared),true,'same image with a different downed range still switches');
assert.deepEqual(shared.portraitView,downView);
assert.equal(shared.portraitVariant,2);
assert.equal(sync(shared),false,'repeated zero HP synchronization preserves the previous form');
shared.portraitVariants=[sharedForms[2],sharedForms[0],sharedForms[1]];
shared.hp=5;
assert.equal(sync(shared),true,'healing restores the exact display range after form reordering');
assert.deepEqual(shared.portraitView,battleView);
assert.equal(shared.portraitVariant,2);

// Legacy image-only markers remain readable after introducing per-form views.
const legacyMarker = {type:'pc',hp:4,iconImgPath:'/art/down',portraitBeforeDowned:'iconImgPath:/art/song',portraitVariants:forms};
assert.equal(sync(legacyMarker),true);
assert.equal(legacyMarker.iconImgPath,'/art/song');

const legacyAndExplicit = {type:'pc',hp:0,iconImgPath:'/art/shared',portraitVariants:[
  {name:'常态',iconImgPath:'/art/shared'},
  {name:'倒地',iconImgPath:'/art/shared',portraitView:normalView},
]};
assert.equal(sync(legacyAndExplicit),true,'an explicit 100% range differs from the legacy framing');
legacyAndExplicit.hp=1;
assert.equal(sync(legacyAndExplicit),true);
assert.equal(Object.hasOwn(legacyAndExplicit,'portraitView'),false);
console.log('downed portrait transitions ok');
