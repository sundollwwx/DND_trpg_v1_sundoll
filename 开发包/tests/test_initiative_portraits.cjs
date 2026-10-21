const assert = require('node:assert/strict');
const path = require('node:path');
const { APP_ROOT } = require('./project_paths.cjs');
const { normalizeInitiativePortrait } = require(path.join(APP_ROOT, 'shared/rules.js'));
const image = 'data:image/png;base64,iVBORw0KGgo=';
const original = { iconImg: image, secret: 'never copy' };
const normalized = normalizeInitiativePortrait(original);
assert.equal(normalized.iconImg, image);
assert.equal(Object.hasOwn(normalized, 'secret'), false);
assert.equal(original.secret, 'never copy');
assert.equal(normalizeInitiativePortrait(null), null);
assert.equal(normalizeInitiativePortrait({}), null);
for (const source of ['file:///Users/private.png', '/Users/private.png', 'javascript:alert(1)',
  '立绘/../../private.png', '立绘/%2e%2e/%2e%2e/private.png', '立绘/%5c..%5c..%5cprivate.png',
  'data:text/html;base64,SGk=', 'https://user:password@example.test/head.png']) {
  assert.equal(normalizeInitiativePortrait({ iconImgPath: source }), null, source);
}
assert.equal(normalizeInitiativePortrait({ iconImgPath: '../asset/棋子库/立绘/头肩.png', iconImg: image }).iconImgPath, '立绘/头肩.png');
assert.equal(normalizeInitiativePortrait({ iconImgPath: '立绘/头肩.png', iconImg: image }).iconImg, null);
assert.equal(normalizeInitiativePortrait({ iconImgPath: '/api/module-assets/' + 'a'.repeat(64) }).iconImgPath, '/api/module-assets/' + 'a'.repeat(64));
assert.equal(normalizeInitiativePortrait({ iconImgId: 'a233' }).iconImgId, 'a233');
console.log('Initiative portrait source normalization and private-path rejection passed.');
