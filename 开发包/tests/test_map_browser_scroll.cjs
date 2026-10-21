const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {webcrypto}=require('node:crypto');
const { readClientSource } = require('./client_sources.cjs');
const source = readClientSource('主控台/host/app.js');
function block(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}

// Small DOM double: removing children resets scroll, like rebuilding the atlas.
class Element {
  constructor() { this.children = []; this.dataset = {}; this.scrollLeft = 0; this.scrollTop = 0; this.className = ''; }
  set innerHTML(value) { this.children = []; this.scrollLeft = 0; this.scrollTop = 0; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    if (selector === '[data-map-location-list]') return all.filter(node => node.dataset.mapLocationList);
    return all;
  }
  querySelector() { return { scrollIntoView: () => { this.focusCalls = (this.focusCalls || 0) + 1; } }; }
}
function fixture() {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const frames = [], painted = [];
  const state = {
    activeMapId: 'a', presentedMapId: 'a',
    mapChapters: [{ id: 'c', name: '章' }],
    mapLocations: [{ id: 'l1', chapterId: 'c', name: '地点一' }, { id: 'l2', chapterId: 'c', name: '地点二' }],
    maps: [{ id: 'a', locationId: 'l1', name: '一楼', playerAccessible: true }, { id: 'b', locationId: 'l2', name: '二楼', playerAccessible: true }],
  };
  const context = vm.createContext({
    $, state, crypto:webcrypto, mapPresentationId:null, document: { createElement: () => new Element() },
    mapThumbnailCache: new Map(), mapBrowserRenderToken: 0,
    mapBrowserChapterId: 'c', mapBrowserLocationId: 'l1',
    MAP_THUMBNAIL_WIDTH: 200, MAP_THUMBNAIL_HEIGHT: 120,
    ensureMapNavigation() {}, mapGridVisible: () => true, drawMapThumbnailBase() {},
    activeMap: () => state.maps.find(m => m.id === state.activeMapId),
    presentedMap: () => state.maps.find(m => m.id === state.presentedMapId),
    mapById: id => state.maps.find(m => m.id === id),
    mapsForLocation: id => state.maps.filter(m => m.locationId === id),
    requestAnimationFrame: callback => frames.push(callback),
    paintVisibleMapThumbnails: list => painted.push([list.dataset.mapLocationList, list.scrollTop]),
    encounterState: () => ({ playMode: 'free' }), renderMapFloorRail() {},
    scheduleAutosave() {}, toast() {}, streamOn: false,
  });
  vm.runInContext(block('renderMapBrowser', 'openMapBrowser') + '\n' +
    block('presentMapToPlayers', 'deleteMapById') + '\n' +
    'function syncMapSelect() { renderMapBrowser(); }', context);
  const strip = $('#map-thumbnail-strip');
  const lists = () => strip.querySelectorAll('[data-map-location-list]');
  const flush = () => { while (frames.length) frames.shift()(); };
  context.renderMapBrowser(); flush(); painted.length = 0;
  strip.scrollLeft = 254;
  lists()[0].scrollTop = 730; lists()[1].scrollTop = 420;
  return { context, state, strip, lists, flush, painted };
}

test('closing/reopening player access retains horizontal and each location vertical position', () => {
  const f = fixture();
  f.context.setMapPlayerAccess('b', false);
  assert.equal(f.state.maps[1].playerAccessible, false);
  assert.equal(f.strip.scrollLeft, 254);
  assert.deepEqual(f.lists().map(n => n.scrollTop), [730, 420]);
  f.context.setMapPlayerAccess('b', true); // before the next animation frame
  f.flush();
  assert.equal(f.state.maps[1].playerAccessible, true);
  assert.equal(f.strip.scrollLeft, 254);
  assert.deepEqual(f.lists().map(n => n.scrollTop), [730, 420]);
  assert.ok(f.painted.every(([id, top]) => top === (id === 'l1' ? 730 : 420)));
});

test('presentation updates and closing the presented map retain position and choose an accessible fallback', () => {
  const f = fixture();
  f.context.presentMapToPlayers('b');
  f.flush();
  assert.equal(f.state.presentedMapId, 'b');
  assert.match(f.context.mapPresentationId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.strip.scrollLeft, 254);
  assert.deepEqual(f.lists().map(n => n.scrollTop), [730, 420]);
  f.context.setMapPlayerAccess('b', false);
  f.flush();
  assert.equal(f.state.presentedMapId, 'a');
  assert.deepEqual(f.lists().map(n => n.scrollTop), [730, 420]);
  f.context.setMapPlayerAccess('a', false);
  assert.equal(f.state.maps[0].playerAccessible, true); // last open map stays open
});

test('delayed frames do not override a newer manual scroll or an intervening render', () => {
  const f = fixture();
  f.context.renderMapBrowser(true);
  f.context.renderMapBrowser();
  f.strip.scrollLeft = 507;
  f.lists()[1].scrollTop = 950;
  f.flush();
  assert.equal(f.strip.scrollLeft, 507);
  assert.equal(f.lists()[1].scrollTop, 950);
  assert.equal(f.strip.focusCalls || 0, 0);
});

test('location scroll follows its ID when reordered and explicit focus still works', () => {
  const f = fixture();
  f.state.mapLocations.reverse();
  f.context.renderMapBrowser(); f.flush();
  assert.deepEqual(f.lists().map(n => [n.dataset.mapLocationList, n.scrollTop]), [['l2', 420], ['l1', 730]]);
  f.context.renderMapBrowser(true); f.flush();
  assert.equal(f.strip.focusCalls, 1);
});
