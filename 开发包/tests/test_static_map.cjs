const {readClientSource}=require('./client_sources.cjs');
// Run with node --test tests/test_static_map.cjs. No browser or live saves required.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {MapElement,createMapDom,installPlayerMapRenderer,rules}=require('./map_render_fixture.cjs');
const root = require('./project_paths.cjs').APP_ROOT;
const host = readClientSource(path.join(root, '主控台/host/app.js'), 'utf8');

function functionSource(source, name, nextName, indent = '') {
  const start = source.indexOf(`${indent}function ${name}(`);
  const end = source.indexOf(`\n${indent}function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `Find ${name}`);
  return source.slice(start, end);
}

function importFixture(data) {
  let imported, importedMap, rerenders = 0, saves = 0;
  const ctx = vm.createContext({
    FileReader: class {
      readAsText() { this.result = JSON.stringify(data); this.onload(); }
    },
    addMap(...args) { imported = args; return importedMap = { tokens: [] }; },
    renderCellsToDataUrl() { rerenders++; return 'legacy-fallback'; },
    toast(message) { assert.ok(!message.startsWith('导入失败'), message); },
    renderTokens() {}, scheduleAutosave() { saves++; }, uid: 1,
  });
  vm.runInContext(functionSource(host, 'cleanCellStates', 'makeMapEntry'), ctx);
  vm.runInContext(functionSource(host, 'mapImportToken', 'importMapFile'), ctx);
  vm.runInContext(functionSource(host, 'importMapFile', 'isSupportedDirectMapImage'), ctx);
  vm.runInContext('importMapFile({})', ctx);
  assert.equal(saves, 1, 'successful imports schedule formal persistence');
  return { imported, importedMap, rerenders };
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

test('map import retains layout and values while removing persistent personal identities', () => {
  const original = { id:'old-token', name:'角色', hp:13, x:20, y:30, ownedPieceId:'owned-1', ownerPlayerId:'player-1', characterRevision:9, owner:'旧玩家', playerCreated:true, mountId:'old-mount' };
  const { importedMap } = importFixture({mapW:100,mapH:100,gridSize:50,mapData:'art',tokens:[original]});
  const token = importedMap.tokens[0];
  assert.equal(token.hp,13);assert.equal(token.x,20);assert.equal(token.y,30);assert.equal(token.owner,'');
  assert.notEqual(token.id,original.id);
  for(const key of ['ownedPieceId','ownerPlayerId','characterRevision','playerCreated','mountId']) assert.equal(Object.hasOwn(token,key),false);
  assert.equal(original.ownedPieceId,'owned-1', 'import never changes the source document');
});

function boardFixture(tile) {
  const listeners = {};
  const handlers = new Map(), controls = new Map();
  const dom = createMapDom();
  const sizes = [1,3].map(size=>{const el=new MapElement('button');el.dataset.coverSize=String(size);return el;});
  const tools = ['cover','reveal'].map(tool=>{const el=new MapElement('button');el.dataset.coverTool=tool;return el;});
  dom.document.querySelectorAll=selector=>{
    if(selector==='[data-cover-size]')return sizes;
    if(selector==='[data-cover-tool]')return tools;
    assert.equal(selector,'#map-cover-tools button');return [...sizes,...tools,...controls.values()];
  };
  const map = { id: 'm', mapData: 'original-art', gridSize: 50, mapW: 50, mapH: 50,
    cells: [[tile]], cellStates: { '0,0': 'marked' }, cam: { x: 0, y: 0, zoom: 1 } };
  const ctx = vm.createContext({
    window: {}, ...dom, SundollRules:rules, SundollClientRuntime:require(path.join(root,'主控台/shared/client-runtime.js')),
    $:selector=>{if(!controls.has(selector))controls.set(selector,new MapElement('button'));return controls.get(selector);},
    board: {
      addEventListener(type, callback, capture=false) {
        if(!handlers.has(type))handlers.set(type,[]);
        handlers.get(type).push({callback,capture:capture===true||capture?.capture===true});
        listeners[type]=event=>{
          event.immediateStopped=false;
          // Cover handlers register in the capture phase; consuming a stroke
          // must prevent the ordinary pan handler from seeing the same event.
          for(const handler of handlers.get(type).slice().sort((a,b)=>Number(b.capture)-Number(a.capture))){
            handler.callback(event);if(event.immediateStopped)break;
          }
        };
      },
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
  const coverStart=host.indexOf('let coverStroke='),coverEnd=host.indexOf('function applyCamera()',coverStart);
  assert.ok(coverStart>=0&&coverEnd>coverStart,'load production cover handlers and their local state');
  vm.runInContext(host.slice(coverStart,coverEnd),ctx);
  vm.runInContext(host.slice(start, end), ctx);
  const event = (overrides = {}) => ({ button: 0, pointerId: 1, clientX: 25, clientY: 25,
    target: { closest: () => null }, preventDefault() {},
    stopImmediatePropagation(){this.immediateStopped=true;}, ...overrides });
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

test('a real cover stroke consumes pointer capture without panning or changing the artwork',()=>{
  const {listeners,map,event,ctx}=boardFixture('chest');let saves=0;
  ctx.boardTool='cover-cover';ctx.scheduleAutosave=()=>saves++;
  listeners.pointerdown(event());
  assert.equal(ctx.drag,null,'the cover capture handler blocks normal panning');
  assert.equal(map.gridCover.cells['0,0'],true);
  listeners.pointerup(event({type:'pointerup'}));
  assert.equal(saves,1,'the completed stroke is saved once');
  assert.deepEqual(map.cam,{x:0,y:0,zoom:1});assert.equal(map.mapData,'original-art');
  assert.ok(ctx.world.querySelector('.map-cover-overlay').firstChild.getAttribute('d'));
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
  const ctx = vm.createContext({ ...createMapDom(), state: {} });installPlayerMapRenderer(ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,gridVisible:false,mapW:100,mapH:50})", ctx);
  assert.equal(ctx.world.style.backgroundImage, 'url("original-art")');
  assert.equal(ctx.world.style.backgroundSize, '100% 100%');
  assert.equal(ctx.world.style.backgroundRepeat, 'no-repeat');
});

test('player defaults missing visibility fields to showing the grid', () => {
  const ctx = vm.createContext({ ...createMapDom(), state: {} });installPlayerMapRenderer(ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,mapW:100,mapH:50})", ctx);
  assert.ok(ctx.world.style.backgroundImage.includes('url("original-art")'));
  assert.ok(ctx.world.style.backgroundImage.includes('repeating-linear-gradient'));
  assert.ok(ctx.world.style.backgroundSize.endsWith('100% 100%'));
});

test('player still understands the old global showGrid field', () => {
  const ctx = vm.createContext({ ...createMapDom(), state: { showGrid: false } });installPlayerMapRenderer(ctx);
  vm.runInContext("renderMap({mapData:'original-art',gridSize:50,mapW:100,mapH:50})", ctx);
  assert.equal(ctx.world.style.backgroundImage, 'url("original-art")');
});
