const {readClientSource}=require('./client_sources.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const appSource = readClientSource('主控台/host/app.js', 'utf8');
const htmlSource = readClientSource('主控台/主控台.html', 'utf8');
const playerSource = readClientSource('主控台/玩家.html', 'utf8');

function functionBlock(startName, endName) {
  const start = appSource.indexOf(`function ${startName}`);
  const end = appSource.indexOf(`function ${endName}`, start);
  assert.ok(start >= 0 && end > start, `${startName} block should exist`);
  return appSource.slice(start, end);
}

function navigationFixture(initialState) {
  const context = vm.createContext({
    state: initialState,
    uid: 1,
    mapBrowserChapterId: null,
    mapBrowserLocationId: null,
  });
  vm.runInContext(`
    function mapById(id) { return state.maps.find((map) => map.id === id) || null; }
    function activeMap() { return mapById(state.activeMapId) || state.maps[0] || null; }
    ${functionBlock('mapStructureName', 'makeMapEntry')}
    this.api = { ensureMapNavigation, mapsForLocation, mapsInNavigationOrder, adjacentLocationMap, presentedMap };
  `, context);
  return context;
}

test('legacy flat maps migrate into one chapter and one vertical location without changing IDs', () => {
  const context = navigationFixture({
    maps: [{ id: 'm1', name: '一层' }, { id: 'm2', name: '二层' }],
    activeMapId: 'm2',
    presentedMapId: null,
    mapChapters: [],
    mapLocations: [],
  });
  context.api.ensureMapNavigation();
  assert.equal(context.state.mapChapters.length, 1);
  assert.equal(context.state.mapLocations.length, 1);
  assert.deepEqual(Array.from(context.state.maps, (map) => map.id), ['m1', 'm2']);
  assert.ok(context.state.maps.every((map) => map.chapterId === context.state.mapChapters[0].id));
  assert.ok(context.state.maps.every((map) => map.locationId === context.state.mapLocations[0].id));
  assert.equal(context.state.presentedMapId, 'm2');
  assert.equal(context.state.maps.find((map) => map.id === 'm1').playerAccessible, false);
  assert.equal(context.state.maps.find((map) => map.id === 'm2').playerAccessible, true);
  assert.equal(context.api.adjacentLocationMap('m1', 1).id, 'm2');
});

test('existing chapter, location and floor order survives normalization', () => {
  const context = navigationFixture({
    maps: [
      { id: 'roof', name: '屋顶图', chapterId: 'c1', locationId: 'tower', floorLabel: '屋顶' },
      { id: 'ground', name: '入口图', chapterId: 'c1', locationId: 'tower', floorLabel: '一层' },
    ],
    activeMapId: 'roof',
    presentedMapId: 'ground',
    mapChapters: [{ id: 'c1', name: '第一章' }],
    mapLocations: [{ id: 'tower', chapterId: 'c1', name: '灯塔' }],
  });
  context.api.ensureMapNavigation();
  assert.equal(context.state.mapChapters[0].name, '第一章');
  assert.equal(context.state.mapLocations[0].name, '灯塔');
  assert.deepEqual(Array.from(context.api.mapsForLocation('tower'), (map) => map.floorLabel), ['屋顶', '一层']);
  assert.equal(context.api.presentedMap().id, 'ground');
  assert.equal(context.state.maps.find((map) => map.id === 'roof').playerAccessible, false);
  assert.equal(context.state.maps.find((map) => map.id === 'ground').playerAccessible, true);
});

test('map shortcut arrows continue across locations and chapters', () => {
  const context = navigationFixture({
    maps: [
      { id: 'tower-2', name: '塔二层', chapterId: 'c1', locationId: 'tower' },
      { id: 'dock', name: '码头', chapterId: 'c1', locationId: 'harbor' },
      { id: 'cave', name: '洞穴', chapterId: 'c2', locationId: 'underground' },
      { id: 'tower-1', name: '塔一层', chapterId: 'c1', locationId: 'tower' },
    ],
    activeMapId: 'tower-1', presentedMapId: 'tower-1',
    mapChapters: [{id:'c1',name:'海岸'},{id:'c2',name:'地下'}],
    mapLocations: [
      {id:'tower',chapterId:'c1',name:'塔楼'},
      {id:'harbor',chapterId:'c1',name:'港口'},
      {id:'underground',chapterId:'c2',name:'洞穴'},
    ],
  });
  assert.deepEqual(Array.from(context.api.mapsInNavigationOrder(), map => map.id), ['tower-2','tower-1','dock','cave']);
  assert.equal(context.api.adjacentLocationMap('tower-1', 1).id, 'dock');
  assert.equal(context.api.adjacentLocationMap('dock', -1).id, 'tower-1');
  assert.equal(context.api.adjacentLocationMap('cave', 1).id, 'tower-2');
});

test('map browser exposes chapter, location, floor and explicit player presentation controls', () => {
  for (const id of [
    'map-chapter-tabs', 'btn-map-chapter-add', 'btn-map-location-add',
    'map-thumbnail-strip',
    'btn-map-browser-present', 'btn-map-chapter-delete',
  ]) assert.match(htmlSource, new RegExp(`id="${id}"`));
  assert.match(appSource, /dataset\.mapLocationDelete = location\.id/);
  const streamBlock = functionBlock('buildStreamPayload', 'applyRemoteAction');
  assert.match(streamBlock, /const m = presentedMap\(\)/);
  assert.match(streamBlock, /activeMapId: m\?\.id \|\| null/);
  assert.match(streamBlock, /mapChapters: state\.mapChapters/);
  assert.match(streamBlock, /mapLocations: state\.mapLocations/);
  assert.match(streamBlock, /_mapPreloads: state\.maps\.filter/);
});

test('map access is persisted, private map contents stay out of the public snapshot, and player has a locked atlas', () => {
  assert.match(appSource, /playerAccessible: typeof m\.playerAccessible === 'boolean'/);
  assert.match(appSource, /function setMapPlayerAccess\(/);
  const publicMapBlock = functionBlock('publicStreamMap', 'buildStreamPayload');
  assert.match(publicMapBlock, /name: accessible \? map\.name : null/);
  assert.match(publicMapBlock, /floorLabel: accessible \? \(map\.floorLabel \|\| map\.name\) : null/);
  assert.match(publicMapBlock, /if \(!accessible\) return \{ \.\.\.metadata, mapData: null, tokens: \[\], doodles: \[\] \}/);
  assert.match(publicMapBlock, /assetPending:/);
  const streamBlock = functionBlock('buildStreamPayload', 'applyRemoteAction');
  assert.match(streamBlock, /name: visibleChapterIds\.has\(chapter\.id\) \? chapter\.name : null/);
  assert.match(streamBlock, /name: visibleLocationIds\.has\(location\.id\) \? location\.name : null/);
  for (const id of [
    'btn-player-backpack', 'player-map-browser-modal',
    'player-map-chapter-tabs', 'player-map-location-columns',
  ]) assert.match(playerSource, new RegExp(`id="${id}"`));
  assert.match(playerSource, /id="btn-player-maps"/);
  assert.doesNotMatch(playerSource, /id="dock-player-maps"/);
  assert.match(playerSource, /function playerMapOpen\(/);
  assert.match(playerSource, /function playerMapGroupOpen\(/);
  assert.match(playerSource, /button\.textContent=revealed\?\(chapter\.name/);
  assert.match(playerSource, /heading\.textContent=revealed\?\(location\.name/);
  assert.match(playerSource, /title\.textContent=open\?\(map\.floorLabel\|\|map\.name\|\|'未命名地图'\):'\?'/);
  assert.match(playerSource, /button\.title=!open\?'这张地图尚未开放'/);
  assert.match(playerSource, /function switchPlayerMap\(/);
  assert.match(playerSource, /\.player-map-card\.locked/);
  assert.match(playerSource, /className='player-map-question'/);
});

function deletionFixture(initialState) {
  const context = vm.createContext({
    state: initialState,
    uid: 100,
    mapBrowserChapterId: initialState.mapChapters[0]?.id || null,
    mapBrowserLocationId: initialState.mapLocations[0]?.id || null,
    confirm: () => true,
    toast: () => {},
    syncMapSelect: () => {},
    renderMapFloorRail: () => {},
    scheduleAutosave: () => {},
  });
  vm.runInContext(`
    function mapById(id) { return state.maps.find((map) => map.id === id) || null; }
    function activeMap() { return mapById(state.activeMapId) || state.maps[0] || null; }
    ${functionBlock('mapStructureName', 'makeMapEntry')}
    ${functionBlock('rebuildNavigationMapOrder', 'reorderMapAround')}
    ${functionBlock('deleteMapChapter', 'moveMapLocationBy')}
    this.api = { deleteMapChapter, deleteMapLocation };
  `, context);
  return context;
}

test('deleting a chapter preserves its locations, maps, tokens and IDs', () => {
  const context = deletionFixture({
    maps: [
      { id: 'm1', chapterId: 'c1', locationId: 'l1', tokens: [] },
      { id: 'm2', chapterId: 'c2', locationId: 'l2', tokens: [{ id: 't1' }] },
    ],
    activeMapId: 'm2', presentedMapId: 'm2',
    mapChapters: [{ id: 'c1', name: '第一章' }, { id: 'c2', name: '第二章' }],
    mapLocations: [{ id: 'l1', chapterId: 'c1', name: '城镇' }, { id: 'l2', chapterId: 'c2', name: '高塔' }],
  });
  context.api.deleteMapChapter('c2');
  assert.deepEqual(Array.from(context.state.mapChapters, (item) => item.id), ['c1']);
  assert.equal(context.state.mapLocations.find((item) => item.id === 'l2').chapterId, 'c1');
  assert.equal(context.state.maps.find((item) => item.id === 'm2').chapterId, 'c1');
  assert.equal(context.state.maps.find((item) => item.id === 'm2').tokens[0].id, 't1');
});

test('deleting a location merges its floors into a neighboring location', () => {
  const context = deletionFixture({
    maps: [{ id: 'm1', chapterId: 'c1', locationId: 'l2', tokens: [{ id: 't1' }] }],
    activeMapId: 'm1', presentedMapId: 'm1',
    mapChapters: [{ id: 'c1', name: '第一章' }],
    mapLocations: [{ id: 'l1', chapterId: 'c1', name: '城镇' }, { id: 'l2', chapterId: 'c1', name: '高塔' }],
  });
  context.api.deleteMapLocation('l2');
  assert.deepEqual(Array.from(context.state.mapLocations, (item) => item.id), ['l1']);
  assert.equal(context.state.maps[0].id, 'm1');
  assert.equal(context.state.maps[0].locationId, 'l1');
  assert.equal(context.state.maps[0].tokens[0].id, 't1');
});
