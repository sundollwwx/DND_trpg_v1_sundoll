// Compatibility loader for existing integration/source-contract tests.
// Pure rules are tested by importing shared/rules.js directly.
const fs=require('node:fs'),path=require('node:path');
const {APP_ROOT}=require('./project_paths.cjs');
function readClientSource(file,encoding='utf8') {
 const absolute=path.resolve(APP_ROOT,file),dir=path.basename(absolute)==='app.js'?path.dirname(path.dirname(absolute)):path.dirname(absolute);
 let source=fs.readFileSync(absolute,encoding);
 if(path.basename(absolute)==='玩家.html') {
  source += '\n'+fs.readFileSync(path.join(dir,'player/player.css'),'utf8')+'\n'+fs.readFileSync(path.join(dir,'player/player.js'),'utf8');
 } else if(path.basename(absolute)==='app.js') {
  const encounterUi=fs.readFileSync(path.join(dir,'host/encounter-ui.js'),'utf8');
  source=source.replace('// Initiative ribbon rendering is implemented in host/encounter-ui.js.',encounterUi.split('// BEGIN RIBBON IMPLEMENTATION')[1].split('// END RIBBON IMPLEMENTATION')[0])
   .replace('// Encounter rendering is implemented in host/encounter-ui.js.',encounterUi.split('// BEGIN ENCOUNTER IMPLEMENTATION')[1].split('// END ENCOUNTER IMPLEMENTATION')[0]);
  const storage=fs.readFileSync(path.join(dir,'host/storage.js'),'utf8'),split=storage.indexOf("const SAVE_ROOT_DIR =");
  source=source.replace('// Persistence is implemented in host/storage.js.',storage.slice(0,split))
   .replace('// Folder bridge and campaign catalog are implemented in host/storage.js.',storage.slice(split))
   .replace('// Campaign documents UI is implemented in host/documents.js.',fs.readFileSync(path.join(dir,'host/documents.js'),'utf8').split('// BEGIN DOCUMENT IMPLEMENTATION')[1].split('// END DOCUMENT IMPLEMENTATION')[0]);
 }
 if(path.basename(absolute)==='app.js') {
  source=source.replace('// Page initialization is implemented in host/bootstrap.js.',fs.readFileSync(path.join(dir,'host/bootstrap.js'),'utf8'));
  source=source.replace('// Music is implemented in host/music.js.',fs.readFileSync(path.join(dir,'host/music.js'),'utf8').split('// BEGIN MUSIC IMPLEMENTATION')[1].split('// END MUSIC IMPLEMENTATION')[0]);
 }
 return source;
}
module.exports={readClientSource};
