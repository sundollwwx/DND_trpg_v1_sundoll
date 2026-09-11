const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'../主控台');
test('host sidebar reserves scrollbar space and stays fixed until explicitly hidden',()=>{
 const css=fs.readFileSync(path.join(root,'style.css'),'utf8');
 const sidebar=css.match(/#left-panel\s*\{([^}]+)\}/)[1];
 for(const rule of ['width: 340px','min-width: 340px','max-width: 340px','flex-shrink: 0','scrollbar-gutter: stable']) assert.ok(sidebar.includes(rule));
 assert.match(css,/#layout\.focus-map #left-panel\s*\{[^}]*max-width: 0/);
});
test('player sidebar also reserves scrollbar space',()=>{
 const html=fs.readFileSync(path.join(root,'玩家.html'),'utf8');
 assert.match(html,/#left-panel\s*\{[^}]*scrollbar-gutter:stable/);
});
