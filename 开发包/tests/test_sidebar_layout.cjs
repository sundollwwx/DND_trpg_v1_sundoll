const {readClientSource}=require('./client_sources.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(require('./project_paths.cjs').APP_ROOT, '主控台');
test('host sidebar reserves scrollbar space and uses the approved compact width',()=>{
 const css=readClientSource(path.join(root,'host/style.css'),'utf8');
 const sidebar=css.match(/#left-panel\s*\{([^}]+)\}/)[1];
 for(const rule of ['width: 340px','min-width: 340px','max-width: 340px','flex-shrink: 0','scrollbar-gutter: stable']) assert.ok(sidebar.includes(rule));
 assert.match(css,/#left-panel\s*\{width:290px;min-width:290px;max-width:290px\}/);
});
test('player sidebar also reserves scrollbar space',()=>{
 const html=readClientSource(path.join(root,'玩家.html'),'utf8');
 assert.match(html,/#left-panel\s*\{[^}]*scrollbar-gutter:stable/);
});
