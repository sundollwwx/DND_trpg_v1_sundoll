const { readClientSource } = require('./client_sources.cjs');
const { APP_ROOT } = require('./project_paths.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const host = readClientSource('主控台/host/app.js');
const html = fs.readFileSync(path.join(APP_ROOT, '主控台/主控台.html'), 'utf8');

function extract(name) {
  const start = host.indexOf(`function ${name}(`);
  const lineEnd = host.indexOf('\n', start);
  const end = host.slice(start, lineEnd).trimEnd().endsWith('}')
    ? lineEnd : host.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, `Missing production function ${name}`);
  return host.slice(start, end);
}

class Element {
  constructor() {
    this.dataset = {}; this.value = ''; this.hidden = true;
    this.listeners = new Map(); this.disabled = false; this.textContent = '';
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, contains() { return false; } };
  }
  addEventListener(type, callback) {
    const list = this.listeners.get(type) || [];
    list.push(callback); this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    event.type = type; event.target ||= this;
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  setCustomValidity(message) { this.validationMessage = message; }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  contains(node) { return node === this; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }; }
}

function fixture({ mode = 'prepare', entries = [], tokens } = {}) {
  tokens ||= [
    { id: 'a', name: '玩家甲', type: 'pc', owner: 'owner-a', x: 100, y: 100 },
    { id: 'b', name: '敌人乙', type: 'enemy', x: 200, y: 100 },
  ];
  const encounter = { playMode: mode, entries, currentEntryId: mode === 'turn' ? entries[0]?.id : null,
    round: 4, turnSerial: 29, turnPath: { mapId: 'm1', tokenId: 'a', points: [{ x: 1, y: 2 }], segmentEnds: [1] } };
  const state = { campaignId: 'campaign-a', activeMapId: 'm1', selectedId: 'a', maps: [
    { id: 'm1', tokens, gridSize: 50, cam: { x: 0, y: 0, zoom: 1 } },
    { id: 'm2', tokens: [{ id: 'a', name: '另一地图甲', type: 'npc' }], gridSize: 50, cam: { x: 0, y: 0, zoom: 1 } },
  ] };
  const elements = Object.fromEntries(['map-initiative-popover', 'board-wrap', 'board', 'world', 'initiative-manager-modal', 'init-value',
    'init-selected-token', 'init-selected-icon', 'init-selected-name', 'init-selected-meta',
    'btn-init-add', 'btn-map-initiative-close'].map(id => [`#${id}`, new Element()]));
  const popover = elements['#map-initiative-popover'];
  popover.offsetWidth = 160; popover.offsetHeight = 100;
  popover.hidden = false; popover.dataset.mapId = 'm1'; popover.dataset.tokenId = 'a';
  const calls = { saves: 0, renders: 0, events: [], toasts: [], bumps: 0 };
  const context = vm.createContext({ state, uid: 100,
    mapInitiativePopoverKey: JSON.stringify(['campaign-a', 'm1', 'a']),
    mapInitiativeDismissedKey: null, mapInitiativeValueDrafts: new Map(),
    hostInitiativeValueDrafts: new Map(),
    $: selector => elements[selector], document: { activeElement: null },
    board: elements['#board'], world: elements['#world'], window: new Element(),
    TYPE_META: { pc: { ring: '#58a5ff', label: '玩家', defaultIcon: '◎' },
      enemy: { ring: '#ed6d72', label: '敌人', defaultIcon: '◎' },
      npc: { ring: '#e0b34c', label: '中立', defaultIcon: '◎' } },
    encounterState: () => encounter,
    clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),
    toast: message => calls.toasts.push(message),
    bumpEncounterTurn: () => { calls.bumps++; throw new Error('Arrangement must not advance or reset the turn'); },
    setEncounterEvent: (_e, message) => calls.events.push(message),
    renderEncounter: () => calls.renders++, scheduleAutosave: () => calls.saves++,
  });
  vm.runInContext(fs.readFileSync(path.join(APP_ROOT, 'shared/token-size.js'), 'utf8'), context);
  for (const name of ['activeMap', 'activeTokens', 'findToken', 'tokenControlGroup',
    'mountedInitiativeGroup', 'initiativeGroupLabel', 'initiativeEntryToken', 'initiativeEntryForToken',
    'initiativeRepresentativeForSelection', 'sortInitiativeEntries', 'addInitiativeEntry',
    'mapInitiativeSelection', 'closeMapInitiativePopover', 'positionMapInitiativePopover', 'renderMapInitiativePopover',
    'bindMapInitiativePopoverEvents', 'upsertSelectedInitiativeEntry']) vm.runInContext(extract(name), context);
  return { encounter, state, calls, context, elements, popover, input: elements['#init-value'] };
}

function turnIdentity(e) {
  return JSON.stringify({ currentEntryId: e.currentEntryId, round: e.round,
    turnSerial: e.turnSerial, turnPath: e.turnPath });
}

function markupElements(markup) {
  const records = [], stack = [], voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source']);
  for (const token of markup.match(/<!--[^]*?-->|<\/?[A-Za-z][^>]*>/g) || []) {
    if (token.startsWith('<!--')) continue;
    const match = token.match(/^<(\/?)([\w:-]+)/), tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex(record => record.tag === tag);
      if (index >= 0) stack.length = index;
      continue;
    }
    const id = token.match(/\bid="([^"]+)"/)?.[1];
    const record = { id, tag, token, ancestors: [...stack] };
    records.push(record);
    if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(record);
  }
  return records;
}

test('the numeric form is a single map overlay outside the map drag surface and manager mask', () => {
  const records = markupElements(html), byId = id => records.filter(record => record.id === id);
  for (const id of ['map-initiative-popover', 'init-selected-icon', 'init-selected-name', 'init-selected-meta', 'init-value', 'btn-init-add']) {
    assert.equal(byId(id).length, 1, `${id} has one owner`);
  }
  const popover = byId('map-initiative-popover')[0];
  assert.ok(popover.ancestors.some(parent => parent.id === 'board-wrap'));
  assert.ok(!popover.ancestors.some(parent => ['board', 'initiative-manager-modal'].includes(parent.id)),
    'pointer interactions on the numeric form must not originate inside the board or its blocking manager');
  for (const id of ['init-selected-icon', 'init-selected-name', 'init-selected-meta', 'init-value', 'btn-init-add']) {
    assert.ok(byId(id)[0].ancestors.includes(popover), `${id} is owned by the map popover`);
  }
  assert.match(byId('init-value')[0].token, /min="-999"/);
  assert.match(byId('init-value')[0].token, /max="999"/);
  assert.match(byId('init-value')[0].token, /step="1"/);
});

test('map popover adds the selected map token with its real identity and persists it', () => {
  const { context, encounter, input, calls } = fixture();
  input.value = '18';
  context.upsertSelectedInitiativeEntry();
  assert.equal(encounter.entries.length, 1);
  assert.equal(encounter.entries[0].tokenId, 'a');
  assert.equal(encounter.entries[0].name, '玩家甲');
  assert.equal(encounter.entries[0].value, 18);
  assert.equal(calls.saves, 1); assert.equal(calls.renders, 1);
});

test('stale map or selection binding cannot add initiative to a different token', () => {
  for (const change of [f => { f.state.selectedId = 'b'; },
    f => { f.state.activeMapId = 'm2'; },
    f => { f.state.selectedId = null; },
    f => { f.state.maps[0].tokens = []; },
    f => { f.popover.hidden = true; },
    f => { f.state.campaignId = 'campaign-b'; }]) {
    const f = fixture(); f.input.value = '20'; change(f);
    const before = JSON.stringify(f.encounter);
    f.context.upsertSelectedInitiativeEntry();
    assert.equal(JSON.stringify(f.encounter), before);
    assert.equal(f.calls.saves, 0); assert.equal(f.calls.renders, 0);
  }
});

test('integer endpoints and zero are valid without coercing the selected token identity', () => {
  for (const value of [-999, 0, 999]) {
    const f = fixture(); f.input.value = String(value);
    assert.equal(f.context.upsertSelectedInitiativeEntry(), true);
    assert.equal(f.encounter.entries[0].value, value);
    assert.equal(f.encounter.entries[0].tokenId, 'a');
    assert.equal(f.calls.saves, 1);
  }
});

test('blank, nonfinite, fractional and out-of-range drafts cannot change the encounter', () => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '1.5', '1000', '-1000']) {
    const f = fixture(); f.input.value = value;
    const before = JSON.stringify(f.encounter);
    f.context.upsertSelectedInitiativeEntry();
    assert.equal(JSON.stringify(f.encounter), before, `Invalid draft ${JSON.stringify(value)}`);
    assert.equal(f.calls.saves, 0); assert.equal(f.calls.renders, 0);
    assert.equal(f.popover.hidden, false, 'a rejected input stays open so the value can be corrected');
    assert.equal(f.input.value, value, 'validation must not erase the draft');
    assert.equal(f.input.focusCalls, 1);
    assert.equal(f.context.mapInitiativeDismissedKey, null);
  }
});

test('updating initiative during preparation retains round, serial and movement path', () => {
  const existing = { id: 'entry-a', name: '旧名字', value: 10, order: 2, tokenId: 'a' };
  const f = fixture({ entries: [existing,
    { id: 'entry-b', name: '敌人乙', value: 15, order: 1, tokenId: 'b' }] });
  f.input.value = '22'; const before = turnIdentity(f.encounter);
  f.context.upsertSelectedInitiativeEntry();
  assert.equal(f.encounter.entries.length, 2);
  assert.equal(f.encounter.entries[0].id, 'entry-a');
  assert.equal(f.encounter.entries[0].value, 22);
  assert.equal(turnIdentity(f.encounter), before);
  assert.equal(f.calls.bumps, 0); assert.equal(f.calls.saves, 1);
});

test('adding a higher initiative during preparation retains round, serial and movement path', () => {
  const f = fixture({ entries: [{ id: 'entry-b', name: '敌人乙', value: 15, order: 1, tokenId: 'b' }] });
  f.input.value = '22'; const before = turnIdentity(f.encounter);
  f.context.upsertSelectedInitiativeEntry();
  assert.equal(f.encounter.entries.length, 2);
  assert.equal(f.encounter.entries[0].tokenId, 'a');
  assert.equal(turnIdentity(f.encounter), before);
  assert.equal(f.calls.bumps, 0);
});

test('free and turn modes cannot add or update initiative even when the old numeric form remains visible', () => {
  for (const mode of ['free', 'turn']) {
    for (const alreadyAdded of [false, true]) {
      const entries = [{ id: 'entry-b', name: '敌人乙', value: 15, order: 1, tokenId: 'b' }];
      if (alreadyAdded) entries.push({ id: 'entry-a', name: '玩家甲', value: 10, order: 2, tokenId: 'a' });
      const f = fixture({ mode, entries });
      f.input.value = '22';
      assert.equal(f.popover.hidden, false, 'simulate a form left visible until the next render');
      const before = JSON.stringify(f.encounter);
      assert.equal(f.context.upsertSelectedInitiativeEntry(), false, `${mode} rejects ${alreadyAdded ? 'update' : 'add'}`);
      assert.equal(JSON.stringify(f.encounter), before, 'a blocked submit preserves the complete encounter');
      assert.equal(f.calls.saves, 0); assert.equal(f.calls.renders, 0);
      assert.equal(f.calls.events.length, 0); assert.equal(f.calls.bumps, 0);
    }
  }
});

test('a queued click or Enter after leaving preparation cannot commit a stale initiative draft', () => {
  for (const mode of ['free', 'turn']) {
    for (const submit of ['click', 'Enter']) {
      const f = fixture({ entries: [{ id: 'entry-a', name: '玩家甲', value: 10, order: 0, tokenId: 'a' }] });
      f.context.bindMapInitiativePopoverEvents(); f.context.renderMapInitiativePopover();
      f.input.value = '22'; f.input.dispatch('input');
      f.encounter.playMode = mode;
      const before = JSON.stringify(f.encounter);
      if (submit === 'click') f.elements['#btn-init-add'].dispatch('click');
      else f.popover.dispatch('keydown', { key: 'Enter', target: f.input, stopPropagation() {}, preventDefault() {} });
      assert.equal(JSON.stringify(f.encounter), before, `${mode} rejects a ${submit} from the previous mode`);
      assert.equal(f.calls.saves, 0); assert.equal(f.calls.renders, 0);
      assert.equal(f.calls.events.length, 0); assert.equal(f.calls.bumps, 0);
    }
  }
});

test('rendering and later geometry callbacks hide the editor outside preparation and restore it on returning', () => {
  for (const mode of ['free', 'turn']) {
    const f = fixture(); f.popover.offsetWidth = 160; f.popover.offsetHeight = 100;
    vm.runInContext(extract('positionMapInitiativePopover'), f.context);
    f.context.bindMapInitiativePopoverEvents(); f.context.renderMapInitiativePopover();
    assert.equal(f.popover.hidden, false, 'the selected map piece is editable while preparing');
    f.input.value = '22'; f.input.dispatch('input');
    f.encounter.playMode = mode;
    const before = JSON.stringify(f.encounter);
    // A resize or native scroll can run before the next full encounter render.
    f.context.positionMapInitiativePopover();
    assert.equal(f.popover.hidden, true, `${mode} immediately hides the old editor during positioning`);
    f.popover.hidden = false;
    f.context.renderMapInitiativePopover();
    assert.equal(f.popover.hidden, true, `${mode} hides the selected piece's editor during rendering`);
    f.context.window.dispatch('resize'); f.elements['#board'].dispatch('scroll');
    assert.equal(f.popover.hidden, true, 'later camera/viewport callbacks cannot reopen the editor');
    f.state.selectedId = 'b'; f.context.renderMapInitiativePopover();
    assert.equal(f.popover.hidden, true, 'selecting another piece cannot reveal a forbidden form');
    assert.equal(JSON.stringify(f.encounter), before);
    assert.equal(f.calls.saves, 0); assert.equal(f.calls.renders, 0);
    f.encounter.playMode = 'prepare'; f.state.selectedId = 'a';
    f.context.renderMapInitiativePopover();
    assert.equal(f.popover.hidden, false, 'returning to preparation enables the selected piece again');
    assert.equal(f.input.value, '22', 'mode changes retain the token draft without submitting it');
    assert.equal(f.context.upsertSelectedInitiativeEntry(), true);
    assert.equal(f.encounter.entries[0].value, 22);
    assert.equal(f.calls.saves, 1);
  }
});

test('rider and mount share one initiative entry while ownership remains on the rider', () => {
  const tokens = [{ id: 'mount', name: '战马', type: 'npc', sizeCategory: 'large' },
    { id: 'rider', name: '骑手', type: 'pc', owner: 'owner-a', mountId: 'mount' }];
  const f = fixture({ tokens });
  f.state.selectedId = 'mount'; f.context.renderMapInitiativePopover(); f.input.value = '16';
  f.context.upsertSelectedInitiativeEntry();
  assert.equal(f.encounter.entries.length, 1);
  assert.equal(f.encounter.entries[0].tokenId, 'rider');
  const entryId = f.encounter.entries[0].id;
  f.state.selectedId = 'rider'; f.context.renderMapInitiativePopover(); f.input.value = '19';
  f.context.upsertSelectedInitiativeEntry();
  assert.equal(f.encounter.entries.length, 1);
  assert.equal(f.encounter.entries[0].id, entryId);
  assert.equal(f.encounter.entries[0].tokenId, 'rider');
  assert.equal(f.encounter.entries[0].value, 19);
});

test('a mount shared by different players requires an explicit representative rider', () => {
  const tokens = [{ id: 'mount', name: '多人坐骑', type: 'npc', sizeCategory: 'large' },
    { id: 'rider-a', name: '骑手甲', type: 'pc', owner: 'owner-a', mountId: 'mount' },
    { id: 'rider-b', name: '骑手乙', type: 'pc', owner: 'owner-b', mountId: 'mount' }];
  const f = fixture({ tokens }); f.state.selectedId = 'mount';
  f.context.renderMapInitiativePopover(); f.input.value = '16';
  assert.equal(f.elements['#btn-init-add'].disabled, true);
  const before = JSON.stringify(f.encounter);
  assert.equal(f.context.upsertSelectedInitiativeEntry(), false);
  assert.equal(JSON.stringify(f.encounter), before); assert.equal(f.calls.saves, 0);
  assert.equal(f.popover.hidden, false, 'an unresolved representative remains available for correction');
  f.state.selectedId = 'rider-b'; f.context.renderMapInitiativePopover(); f.input.value = '16';
  assert.equal(f.context.upsertSelectedInitiativeEntry(), true);
  assert.equal(f.encounter.entries[0].tokenId, 'rider-b');
});

test('input drafts stay with their campaign, map and token and survive ordinary snapshot renders', () => {
  const f = fixture({ entries: [{ id: 'entry-a', name: '玩家甲', value: 10, order: 0, tokenId: 'a' }] });
  f.context.bindMapInitiativePopoverEvents();
  f.context.renderMapInitiativePopover(); assert.equal(f.input.value, '10');
  f.context.document.activeElement = f.input;
  f.input.value = '-17'; f.input.dispatch('input');
  f.encounter.entries[0].value = 12;
  f.context.renderMapInitiativePopover(); assert.equal(f.input.value, '-17', 'an incoming snapshot cannot erase ongoing input');
  f.state.selectedId = 'b'; f.context.renderMapInitiativePopover();
  assert.equal(f.input.value, '', 'a different token starts with its own value');
  f.input.value = '8'; f.input.dispatch('input');
  f.state.selectedId = 'a'; f.context.renderMapInitiativePopover();
  assert.equal(f.input.value, '-17', 'returning to a token restores its own draft');
  f.state.activeMapId = 'm2'; f.context.renderMapInitiativePopover();
  assert.notEqual(f.input.value, '-17', 'a repeated token ID on another map cannot inherit a draft');
  f.state.activeMapId = 'm1'; f.state.campaignId = 'campaign-b'; f.context.renderMapInitiativePopover();
  assert.notEqual(f.input.value, '-17', 'another campaign cannot inherit a prior draft');
  assert.equal(f.calls.saves, 0);
});

test('successful submission closes the form, clears only its own draft and retains the committed value', () => {
  const f = fixture(); f.context.bindMapInitiativePopoverEvents(); f.context.renderMapInitiativePopover();
  f.input.value = '18'; f.input.dispatch('input');
  const keyA = f.context.mapInitiativeSelection().key;
  const keyB = JSON.stringify(['campaign-a', 'm1', 'b']);
  f.context.mapInitiativeValueDrafts.set(keyB, '9');
  f.context.upsertSelectedInitiativeEntry();
  assert.equal(f.popover.hidden, true);
  assert.equal(f.context.mapInitiativeDismissedKey, keyA);
  assert.equal(f.context.mapInitiativeValueDrafts.has(keyA), false);
  assert.equal(f.context.mapInitiativeValueDrafts.get(keyB), '9');
  f.context.renderMapInitiativePopover();
  assert.equal(f.input.value, '18');
  assert.equal(f.popover.hidden, true, 'the committed value does not reopen its dismissed editor');
  assert.equal(f.encounter.entries.length, 1);
});

test('successful add and update stay closed through renders and geometry until the map piece is clicked again', () => {
  for (const alreadyAdded of [false, true]) {
    const f = fixture({ entries: alreadyAdded ? [{ id: 'entry-a', name: '玩家甲', value: 10, order: 0, tokenId: 'a' }] : [] });
    f.context.bindMapInitiativePopoverEvents(); f.context.renderMapInitiativePopover();
    f.input.value = '18'; f.input.dispatch('input');
    const key = f.context.mapInitiativeSelection().key;
    const mapBefore = JSON.stringify(f.state.maps);
    f.elements['#btn-init-add'].dispatch('click');
    assert.equal(f.encounter.entries.length, 1);
    assert.equal(f.encounter.entries[0].value, 18);
    assert.equal(f.popover.hidden, true, `successful ${alreadyAdded ? 'update' : 'add'} dismisses the numeric form`);
    assert.equal(f.context.mapInitiativeDismissedKey, key);
    assert.equal(f.state.selectedId, 'a', 'closing the form keeps the map piece selected');
    assert.equal(JSON.stringify(f.state.maps), mapBefore, 'closing the form cannot move the map piece');
    f.context.renderMapInitiativePopover(); f.context.positionMapInitiativePopover();
    f.context.window.dispatch('resize'); f.elements['#board'].dispatch('scroll');
    assert.equal(f.popover.hidden, true, 'routine renders, zoom/position and viewport callbacks cannot undo dismissal');
    // Exercise the actual map selection handler; its unrelated unit panel work is outside this test.
    f.context.document.querySelector = () => null;
    f.context.renderTokens = () => f.context.renderMapInitiativePopover();
    f.context.updateDetail = () => {};
    vm.runInContext(extract('selectToken'), f.context);
    f.context.selectToken('a');
    assert.equal(f.popover.hidden, false, 'clicking the same map piece again explicitly reopens its editor');
    assert.equal(f.input.value, '18');
    assert.equal(f.elements['#btn-init-add'].textContent, '更新先攻');
    assert.equal(f.calls.saves, 1, 'reopening does not submit a second update');
  }
});

test('the popover stops pointer, wheel and keyboard propagation; Enter submits once and Escape closes', () => {
  const f = fixture(); f.context.bindMapInitiativePopoverEvents();
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'click', 'dblclick', 'contextmenu', 'wheel']) {
    let stopped = 0;
    f.popover.dispatch(type, { stopPropagation() { stopped++; }, preventDefault() { throw new Error('Text interaction should remain usable'); } });
    assert.equal(stopped, 1, `${type} cannot reach map selection, drag or zoom handlers`);
  }
  f.input.value = '18'; let stopped = 0, prevented = 0;
  const event = key => ({ key, target: f.input, stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
  f.popover.dispatch('keydown', event('ArrowUp'));
  assert.equal(stopped, 1); assert.equal(prevented, 0); assert.equal(f.calls.saves, 0);
  f.popover.dispatch('keydown', event('Enter'));
  assert.equal(stopped, 2); assert.equal(prevented, 1); assert.equal(f.calls.saves, 1);
  assert.equal(f.popover.hidden, true, 'a successful Enter submission closes the form too');
  f.popover.dispatch('keydown', event('Escape'));
  assert.equal(stopped, 3); assert.equal(prevented, 2); assert.equal(f.popover.hidden, true);
  assert.equal(f.calls.saves, 1, 'Escape does not submit or mutate the encounter');
});

test('map positioning follows the rendered world through native scroll and zoom, clamps edges and hides blocked anchors', () => {
  const f = fixture(), map = f.state.maps[0], token = map.tokens[0];
  map.cam = { x: 24, y: 32, zoom: 2 };
  token.size = 1;
  const boardRect = { left: 100, top: 80, right: 700, bottom: 480, width: 600, height: 400 };
  const wrapRect = { left: 80, top: 50, right: 720, bottom: 490, width: 640, height: 440 };
  // Camera translation plus native scrollLeft=10 and scrollTop=68.5 produce the actual rendered origin.
  const worldRect = { left: 114, top: 43.5 };
  f.elements['#board'].getBoundingClientRect = () => boardRect;
  f.elements['#board-wrap'].getBoundingClientRect = () => wrapRect;
  f.elements['#world'].getBoundingClientRect = () => worldRect;
  f.popover.offsetWidth = 160; f.popover.offsetHeight = 100;
  vm.runInContext(extract('positionMapInitiativePopover'), f.context);
  f.context.bindMapInitiativePopoverEvents();
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.hidden, false);
  assert.equal(f.popover.style.left, '294px', 'position includes zoom, horizontal scrolling and the board-to-wrapper offset');
  assert.equal(f.popover.style.top, '143.5px', 'native scrolling must not leave the popover 68.5px below its piece');

  worldRect.top -= 40;
  f.elements['#board'].dispatch('scroll');
  assert.equal(f.popover.style.top, '103.5px', 'native board scroll repositions the already-open popover');

  worldRect.top = 43.5;
  token.x = 280; token.y = 230;
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.hidden, false, 'a partly visible edge piece retains its editor');
  assert.equal(f.popover.style.left, '374px', 'right-edge pieces place the popover on their left');
  assert.equal(f.popover.style.top, '322px', 'the editor fits above the board bottom with an eight-pixel margin');

  token.x = 150; token.y = 25; f.popover.offsetWidth = 550;
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.style.left, '28px', 'a wide editor clamps to the board left margin rather than leaving the map');
  assert.equal(f.popover.style.top, '38px', 'the editor clamps to the board top margin');

  f.elements['#initiative-manager-modal'].hidden = false;
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.hidden, true, 'the modal arrangement editor blocks its map popover');
  f.elements['#initiative-manager-modal'].hidden = true;
  token.x = 400;
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.hidden, true, 'fully offscreen pieces do not leave a detached editor at the map edge');
  token.x = 100; token.y = -100;
  f.context.positionMapInitiativePopover();
  assert.equal(f.popover.hidden, true, 'vertical offscreen anchors are hidden too');
  assert.equal(f.calls.saves, 0, 'geometry and scrolling cannot mutate campaign state');
});

test('entering preparation through the flow bar keeps map selection available instead of opening its manager', () => {
  const prepare = new Element(), free = new Element(), encounter = { playMode: 'free' };
  prepare.dataset.playMode = 'prepare'; free.dataset.playMode = 'free';
  let entered = 0;
  const context = vm.createContext({ document: { querySelectorAll: () => [prepare, free] },
    encounterState: () => encounter,
    enterCombatPreparation() { entered++; encounter.playMode = 'prepare'; },
    leaveCombatForFreeMode() { encounter.playMode = 'free'; },
    openHostInitiativeManager() { throw new Error('Preparing should leave the map interactive'); },
  });
  const start = host.indexOf("document.querySelectorAll('[data-play-mode]')");
  const end = host.indexOf("$('#btn-combat-start').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(host.slice(start, end), context);
  prepare.dispatch('click'); assert.equal(encounter.playMode, 'prepare'); assert.equal(entered, 1);
  prepare.dispatch('click'); assert.equal(entered, 1, 'selecting the active preparation mode does not reopen a blocking manager');
  free.dispatch('click'); assert.equal(encounter.playMode, 'free');
});
