// Load the production crop/view identity module into source-extraction tests.
// This preserves view-sensitive form matching instead of replacing it with an
// unconditional equality helper.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP_ROOT } = require('./project_paths.cjs');

function createPortraitContext(value) {
  const context = vm.isContext(value) ? value : vm.createContext(value);
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT, '主控台/shared/portrait-view.js'), 'utf8'), context);
  if (context.window) context.SundollPortraitView = context.window.SundollPortraitView;
  return context;
}

module.exports = { createPortraitContext };
