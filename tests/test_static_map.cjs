// Run with node --test tests/test_static_map.cjs. No browser or live saves required.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const host = fs.readFileSync(path.join(root, '主控台/app.js'), 'utf8');
const player = fs.readFileSync(path.join(root, '主控台/玩家.html'), 'utf8');

function functionSource(source, name, nextName, indent = '') {
  const start = source.indexOf(`${indent}function ${name}(`);
  const end = source.indexOf(`\n${indent}function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Find ${name}`);
  return source.slice(start, end);
}

function importFixture(data) {
  let imported, rerenders = 0;
  const ctx = vm.createContext({
    FileReader: class {
      readAsText() { this.result = JSON.stringify(data); this.onload(); }
    },
    addMap(...args) { imported = args; return { tokens: [] }; },
    renderCellsToDataUrl() { rerenders++; return 'legacy-fallback'; },
    toast(message) { assert.ok(!message.startsWith('导入失败'), message); },
    renderTokens() {},
  });
  vm.runInContext(functionSource(host, 'cleanCellStates', 'makeMapEntry'), ctx);
  vm.runInContext(functionSource(host, 'importMapFile', 'isSupportedDirectMapImage'), ctx);
  vm.runInContext('importMapFile({})', ctx);
  return { imported, rerenders };
}

test('workshop image is preserved exactly, including object overlays and authored variants', () => {
  const data = {
    mapW: 100, mapH: 50, gridSize: 50, mapData: 'data:image/png;base64,original-art',
    grid: [['chest', 'floor']], cellStates: { '0,0': 'open' },
    cellVariants: { '1,0': 1 }, objects: { '0,0': { id: 'chest' } },
  };
  const { imported, rerenders } = importFixture(data);
  assert.equal(imported[1], data.mapData);
  assert.equal(imported[6]['1,0'], 1);
  assert.equal(rerenders, 0);
});

test('legacy grid-only map can still be imported once', () => {
  const { imported, rerenders } = importFixture({ mapW: 50, mapH: 50, gridSize: 50, grid: [['chest']] });
  assert.equal(imported[1], 'legacy-fallback');
  assert.equal(rerenders, 1);
});

test('map import preserves per-map visibility and falls back to the old global flag', () => {
  const base = { mapW: 100, mapH: 50, gridSize: 50, mapData: 'art' };
  const explicit = importFixture({ ...base, gridVisible: false, showGrid: true });
  assert.equal(explicit.imported[7], false);
  const legacy = importFixture({ ...base, showGrid: false });
  assert.equal(legacy.imported[7], false);
  const missing = importFixture(base);
  assert.equal(missing.imported[7], true);
});

function boardFixture(tile) {
  const listeners = {};
  const map = { id: 'm', mapData: 'original-art', gridSize: 50, mapW: 50, mapH: 50,
    cells: [[tile]], cellStates: { '0,0': 'marked' }, cam: { x: 0, y: 0, zoom: 1 } };
  const ctx = vm.createContext({
    board: {
      addEventListener(type, callback) { listeners[type] = callback; },
      setPointerCapture() {}, classList: { add() {}, remove() {} },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
    activeMap: () => map, drag: null, pendingMapReaction: null, spellAimTokenId: null,
    boardTool: null, applyCamera() {},
    scheduleAutosave() { assert.fail('Map click must not save a changed map'); },
    renderCellsToDataUrl() { assert.fail('Map click must not redraw terrain'); },
    selectToken(id) { ctx.selected = id; },
    findToken: id => ({ id }),
  });
  const start = host.indexOf('  // 拖拽：棋子 / 平移');
  const end = host.indexOf('  // 键盘', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(host.slice(start, end), ctx);
  const event = (overrides = {}) => ({ button: 0, pointerId: 1, clientX: 25, clientY: 25,
    target: { closest: () => null }, preventDefault() {}, ...overrides });
  return { listeners, map, event, ctx };
}

for (const tile of ['chest', 'trap', 'door', 'torch', 'gate', 'portal']) {
  test(`${tile}: left/right clicks and cancellation never change the map`, () => {
    const { listeners, map, event } = boardFixture(tile);
    const before = JSON.stringify(map);
    listeners.pointerdown(event());
    listeners.pointerup(event({ type: 'pointerup' }));
    listeners.contextmenu(event({ button: 2 }));
    listeners.pointerdown(event());
    listeners.pointercancel(event({ type: 'pointercancel' }));
    assert.equal(JSON.stringify(map), before);
  });
}

test('map panning and right-click token selection remain usable', () => {
  const { listeners, map, event, ctx } = boardFixture('chest');
  listeners.pointerdown(event());
  listeners.pointermove(event({ clientX: 75, clientY: 60 }));
  listeners.pointerup(event({ clientX: 75, clientY: 60, type: 'pointerup' }));
  assert.equal(map.cam.x, 50);
  assert.equal(map.cam.y, 35);
  assert.equal(map.mapData, 'original-art');
  listeners.contextmenu(event({ button: 2, target: { closest: () => ({ dataset: { id: 't1' } }) } }));
  assert.equal(ctx.selected, 't1');
});

test('old interaction and editor state is removed from saves without changing artwork or tokens', () => {
  const ctx = vm.createContext({ state: { showGrid: false, encounter: {}, maps: [{
    mapData: 'original-art', gridSize: 50, gridVisible: false, tokens: [{ id: 't1' }],
    cellStates: { '0,0': 'open' }, baseCells: [['chest']], baseCellStates: {}, baseCellVariants: {},
  }] } });
  vm.runInContext(functionSource(host, 'stateStorageReplacer', 'stateStorageJson'), ctx);
  const saved = JSON.parse(vm.runInContext('JSON.stringify(state, stateStorageReplacer)', ctx));
  assert.equal(saved.showGrid, undefined);
  assert.deepEqual(saved.maps[0], { mapData: 'original-art', gridSize: 50, gridVisible: false, tokens: [{ id: 't1' }] });
});

test('player hides a map grid when the host sends gridVisible false', () => {
  const ctx = vm.createContext({ world: { style: {} }, state: {} });
  vm.runInContext(functionSource(player, 'renderMap', 'cloneDoodleStroke', '  '), ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,gridVisible:false,mapW:100,mapH:50})", ctx);
  assert.equal(ctx.world.style.backgroundImage, 'url("original-art")');
  assert.equal(ctx.world.style.backgroundSize, '100% 100%');
  assert.equal(ctx.world.style.backgroundRepeat, 'no-repeat');
});

test('player defaults missing visibility fields to showing the grid', () => {
  const ctx = vm.createContext({ world: { style: {} }, state: {} });
  vm.runInContext(functionSource(player, 'renderMap', 'cloneDoodleStroke', '  '), ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,mapW:100,mapH:50})", ctx);
  assert.ok(ctx.world.style.backgroundImage.includes('url("original-art")'));
  assert.ok(ctx.world.style.backgroundImage.includes('repeating-linear-gradient'));
  assert.ok(ctx.world.style.backgroundSize.endsWith('100% 100%'));
});

test('player still understands the old global showGrid field', () => {
  const ctx = vm.createContext({ world: { style: {} }, state: { showGrid: false } });
  vm.runInContext(functionSource(player, 'renderMap', 'cloneDoodleStroke', '  '), ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,mapW:100,mapH:50})", ctx);
  assert.equal(ctx.world.style.backgroundImage, 'url("original-art")');
});
