const { readClientSource } = require('./client_sources.cjs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = readClientSource('主控台/host/app.js');
const block = source.slice(source.indexOf('function deleteMapById('), source.indexOf('function syncMapSelect('));

function fixture(count = 1, confirmed = true) {
  const calls = [];
  const state = { maps: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, name: `Map ${i}`, tokens: [{ id: `t${i}`, ownedPieceId: `p${i}` }] })), activeMapId: 'm0', presentedMapId: 'm0', selectedId: 't0' };
  const encounter = { playMode: 'turn' };
  const layer = { innerHTML: 'old reaction' };
  const context = { state, confirm: () => confirmed, mapById: id => state.maps.find(m => m.id === id),
    parkOwnedPiece: t => calls.push(`park:${t.ownedPieceId}`), currentTurnIncludesToken: () => true,
    pruneInitiativeTokenRefs: () => ({ removed: 1 }), encounterState: () => encounter,
    leaveCombatForFreeMode: () => { encounter.playMode = 'free'; },
    $: () => layer, spellAimTokenId: 't0', selectedDoodleId: 'd0', boardTool: 'doodle', streamOn: true };
  for (const name of ['closeTokenPortraitPreview', 'closePortraitVariantManager', 'cancelMapReaction', 'syncBoardTools', 'syncMapSelect', 'applyActiveMap', 'renderMapBrowser', 'renderMapFloorRail', 'bumpEncounterTurn', 'renderEncounter', 'renderTurnPath', 'scheduleAutosave', 'streamPush', 'toast']) context[name] = () => calls.push(name);
  vm.createContext(context); vm.runInContext(block, context);
  return { context, state, encounter, calls, layer };
}

test('last map deletion clears pointers and tools, parks owned pieces and saves and publishes empty state', () => {
  const f = fixture(); f.context.deleteMapById('m0');
  assert.equal(f.state.maps.length, 0);
  assert.equal(f.state.activeMapId, null); assert.equal(f.state.presentedMapId, null); assert.equal(f.state.selectedId, null);
  assert.equal(f.encounter.playMode, 'free'); assert.equal(f.context.boardTool, null);
  assert.equal(f.context.spellAimTokenId, null); assert.equal(f.context.selectedDoodleId, null);
  assert.equal(f.layer.innerHTML, '');
  for (const call of ['park:p0', 'applyActiveMap', 'scheduleAutosave', 'streamPush']) assert.ok(f.calls.includes(call), call);
});

test('cancelling last map deletion leaves state and side effects untouched', () => {
  const f = fixture(1, false); const before = JSON.stringify(f.state);
  f.context.deleteMapById('m0'); assert.equal(JSON.stringify(f.state), before); assert.equal(f.calls.length, 0);
});

test('deleting an active map with a remaining map selects its neighbor', () => {
  const f = fixture(2); f.context.deleteMapById('m0');
  assert.equal(f.state.maps.length, 1); assert.equal(f.state.activeMapId, 'm1');
  assert.equal(f.state.presentedMapId, 'm1'); assert.equal(f.state.maps[0].playerAccessible, true);
});
