const {test}=require('node:test'),assert=require('node:assert/strict');
const rules=require(require('node:path').join(require('./project_paths.cjs').APP_ROOT, 'shared/rules.js'));
test('spell range normalization is bounded, rounded and side-effect free',()=>{
 const raw={shape:'cone',feet:999,direction:-5};assert.deepEqual(rules.normalizeSpellRange(raw),{shape:'cone',feet:180,direction:355});
 assert.equal(raw.direction,-5);assert.deepEqual(rules.normalizeSpellRange(null),{shape:'off',feet:30,direction:0});
});
test('turn paths normalize boundaries and count shared edges in both directions',()=>{
 assert.deepEqual(rules.normalizeTurnPathSegmentEnds([2,2,1,99],5),[2,4]);
 const a={x:0,y:0},b={x:50,y:50};assert.equal(rules.turnPathEdgeKey(a,b),rules.turnPathEdgeKey(b,a));
 assert.equal(rules.turnPathEdgeCounts([a,b,a]).get(rules.turnPathEdgeKey(a,b)),2);
 assert.equal(rules.sameTurnPoint(a,{x:.001,y:.001}),true);
});
test('initiative permission preserves legacy defaults and honors only explicit false',()=>{
 assert.equal(rules.initiativeSwapAllowed(null),true);
 assert.equal(rules.initiativeSwapAllowed({}),true);
 assert.equal(rules.initiativeSwapAllowed({allowInitiativeSwap:true}),true);
 assert.equal(rules.initiativeSwapAllowed({allowInitiativeSwap:false}),false);
});
test('initiative orders repair duplicates and missing ranks without mutating input',()=>{
 const original=[{id:'a',order:0},{id:'b',order:0},{id:'c',order:0}];
 assert.deepEqual(rules.normalizeInitiativeEntryOrders(original).map(entry=>entry.order),[0,1,2]);
 assert.deepEqual(original.map(entry=>entry.order),[0,0,0]);
 assert.deepEqual(rules.normalizeInitiativeEntryOrders([{order:10},{},{order:30}]).map(entry=>entry.order),[0,1,2]);
 assert.deepEqual(rules.normalizeInitiativeEntryOrders([{order:'10'},{order:20},{order:30}]).map(entry=>entry.order),[10,20,30]);
 assert.deepEqual(rules.normalizeInitiativeEntryOrders([{order:false},{order:2}]).map(entry=>entry.order),[0,1]);
});
