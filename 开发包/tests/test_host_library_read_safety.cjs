const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(require('./project_paths.cjs').APP_ROOT, '主控台/host/app.js'), 'utf8');
const source = app.slice(app.indexOf('async function readLibraryFile()'), app.indexOf('function scheduleLibraryFileWrite()'));
function client(text) {
  const writes = [], statuses = [];
  const context = vm.createContext({
    projectDirHandle: {}, modularStorage: true, state: {library:[{id:'cached'}]},
    SAVE_LIBRARY_FILE:'library', LIBRARY_KEY:'library', LIBRARY_SAVED_AT_KEY:'stamp',
    readBoundText: async () => { if (text instanceof Error) throw text; return text; },
    writeBoundText: async (...args) => {writes.push(args); return true;},
    hasSaveFolderPermission: async () => true,
    normalizeLibPreset: v => v,
    localStorage: {getItem:()=>null,setItem(){}},
    updateLibPersistStatus: s => statuses.push(s),
    $:()=>null, console:{warn(){}},
  });
  vm.runInContext(source,context);
  return {context,writes,statuses, sync:()=>vm.runInContext('syncLibraryWithFolder()',context)};
}
for (const [name,value] of [['missing',null],['empty',''],['malformed','{oops'],['wrong format','{"presets":[]}'],['read failure',new Error('offline')]]) {
  test(`host preserves catalog and cache after ${name} read`,async()=>{
    const c=client(value);
    assert.equal(await c.sync(),false);
    assert.equal(c.writes.length,0);
    assert.equal(c.context.state.library[0].id,'cached');
    assert.equal(c.statuses.at(-1),'error');
  });
}
test('host loads valid restored catalog without writing it back',async()=>{
  const c=client(JSON.stringify({format:'sangduoer-library',savedAt:42,presets:[{id:'restored'}]}));
  assert.equal(await c.sync(),true);
  assert.equal(c.context.state.library[0].id,'restored');
  assert.equal(c.writes.length,0);
});
