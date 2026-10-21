const {readClientSource}=require('./client_sources.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP_ROOT } = require('./project_paths.cjs');
const host = readClientSource('主控台/host/app.js');
const html = fs.readFileSync(path.join(APP_ROOT, '主控台/主控台.html'), 'utf8');
const SundollRules = require(path.join(APP_ROOT, 'shared/rules.js'));

function extract(name) {
  const start = host.indexOf(`function ${name}(`);
  const end = host.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, `Missing production function ${name}`);
  return host.slice(start, end);
}

function arrange(entries, mode = 'turn') {
  const e = { entries, playMode: mode, currentEntryId: mode === 'turn' ? entries[1]?.id : null,
    round: 4, turnSerial: 18, allowInitiativeSwap: false,
    turnPath: { mapId: 'm', tokenId: 't', points: [{ x: 10, y: 20 }], segmentEnds: [] } };
  const calls = { renders: 0, saves: 0, events: [], toasts: [] };
  const context = vm.createContext({ encounterState: () => e, SundollRules,
    emptyTurnPath: () => ({ mapId: null, tokenId: null, points: [], segmentEnds: [] }),
    hostInitiativeValueDrafts: new Map(), initiativeEntryLabel: entry => entry.name,
    setEncounterEvent: (_e, label) => calls.events.push(label),
    renderEncounter: () => calls.renders++, scheduleAutosave: () => calls.saves++,
    toast: message => calls.toasts.push(message) });
  for (const name of ['sortInitiativeEntries', 'commitHostInitiativeArrangement',
    'setHostInitiativeValue', 'swapHostInitiativeValues', 'moveHostTiedInitiativeEntry', 'applyInitiativeRemoteAction']) {
    vm.runInContext(extract(name), context);
  }
  return { e, calls, context };
}

function turnIdentity(e) {
  return JSON.stringify({ currentEntryId: e.currentEntryId, round: e.round,
    turnSerial: e.turnSerial, turnPath: e.turnPath });
}

test('DM swaps arbitrary initiative numbers and sorts without advancing the active turn', () => {
  const { e, calls, context } = arrange([
    { id: 'a', name: '玩家', value: 20, order: 4 },
    { id: 'b', name: '敌人', value: 16, order: 9 },
    { id: 'c', name: '中立', value: 8, order: 16 },
  ]);
  const before = turnIdentity(e);
  assert.equal(context.swapHostInitiativeValues('a', 'c'), true);
  assert.deepEqual(e.entries.map(x => x.id), ['c', 'b', 'a']);
  assert.deepEqual(e.entries.map(x => x.value), [20, 16, 8]);
  assert.equal(turnIdentity(e), before);
  assert.equal(calls.saves, 1); assert.equal(calls.renders, 1);
  assert.match(calls.events[0], /交换先攻/);
  assert.equal(context.swapHostInitiativeValues('a', 'a'), false);
  assert.equal(calls.saves, 1);
});

function pendingPlayerSwap() {
  return { op: 'initiativeSwap', entryId: 'a', targetEntryId: 'b',
    turnSerial: 18, nextTurnSerial: 19, previousEntryOrder: 0, previousTargetOrder: 1,
    entryOrder: 1, targetOrder: 0 };
}

function preparingTies() {
  const result = arrange([
    { id: 'a', name: '玩家甲', value: 12, order: 0 },
    { id: 'b', name: '玩家乙', value: 12, order: 1 },
    { id: 'c', name: '敌人', value: 12, order: 2 },
  ], 'prepare');
  result.e.allowInitiativeSwap = true;
  return result;
}

test('a delayed player swap cannot overwrite DM sorting or create duplicate orders', () => {
  const { e, context } = preparingTies();
  assert.equal(context.moveHostTiedInitiativeEntry('c', -1), true);
  const before = JSON.stringify(e);
  assert.equal(context.applyInitiativeRemoteAction(e, pendingPlayerSwap()), false);
  assert.equal(JSON.stringify(e), before);
  assert.deepEqual(e.entries.map(entry => entry.id), ['a', 'c', 'b']);
  assert.equal(new Set(e.entries.map(entry => entry.order)).size, 3);
});

test('a delayed player swap also rejects changed previous orders while entries remain adjacent', () => {
  const { e, context } = preparingTies();
  assert.equal(context.moveHostTiedInitiativeEntry('a', 1), true);
  const before = JSON.stringify(e);
  assert.equal(context.applyInitiativeRemoteAction(e, pendingPlayerSwap()), false);
  assert.equal(JSON.stringify(e), before);
});

test('a current player swap applies once and verifies the exact result before accepting replay', () => {
  const { e, context } = preparingTies();
  const action = pendingPlayerSwap();
  assert.equal(context.applyInitiativeRemoteAction(e, action), true);
  assert.deepEqual(e.entries.map(entry => entry.id), ['b', 'a', 'c']);
  assert.equal(e.turnSerial, 19);
  const applied = JSON.stringify(e);
  assert.equal(context.applyInitiativeRemoteAction(e, action), true);
  assert.equal(JSON.stringify(e), applied);
  context.moveHostTiedInitiativeEntry('c', -1);
  const rearranged = JSON.stringify(e);
  assert.equal(context.applyInitiativeRemoteAction(e, action), false);
  assert.equal(JSON.stringify(e), rearranged);
});

test('a canonical player swap upgrades legacy duplicate orders without moving a third tied unit', () => {
  const { e, context } = preparingTies();
  e.entries.forEach(entry => { entry.order = 0; });
  assert.equal(context.applyInitiativeRemoteAction(e, pendingPlayerSwap()), true);
  assert.deepEqual(e.entries.map(entry => entry.id), ['b', 'a', 'c']);
  assert.deepEqual(e.entries.map(entry => entry.order), [0, 1, 2]);
});

test('remote swaps reject locked phases, disabled permission, and malformed canonical orders without mutation', () => {
  const { e, context } = preparingTies();
  const action = pendingPlayerSwap();
  for (const patch of [{ turnSerial: 18.5 }, { nextTurnSerial: 20 }, { previousEntryOrder: null },
    { targetOrder: 2 }, { entryOrder: true }, { targetEntryId: 'a' }, { op: 'unknown' }]) {
    const before = JSON.stringify(e);
    assert.equal(context.applyInitiativeRemoteAction(e, { ...action, ...patch }), false);
    assert.equal(JSON.stringify(e), before);
  }
  for (const mode of ['free', 'turn']) {
    e.playMode = mode;
    const before = JSON.stringify(e);
    assert.equal(context.applyInitiativeRemoteAction(e, action), false);
    assert.equal(JSON.stringify(e), before);
  }
  e.playMode = 'prepare'; e.allowInitiativeSwap = false;
  const before = JSON.stringify(e);
  assert.equal(context.applyInitiativeRemoteAction(e, action), false);
  assert.equal(JSON.stringify(e), before);
});

test('DM ties reorder every faction, repair duplicate order, and survive subsequent sorting', () => {
  const { e, calls, context } = arrange([
    { id: 'a', name: '玩家', type: 'pc', value: 12, order: 0 },
    { id: 'b', name: '敌人', type: 'enemy', value: 12, order: 0 },
    { id: 'c', name: '中立', type: 'npc', value: 12, order: 0 },
    { id: 'd', name: '盟友', type: 'ally', value: 4, order: 0 },
  ]);
  const before = turnIdentity(e);
  assert.equal(context.moveHostTiedInitiativeEntry('c', -1), true);
  assert.deepEqual(e.entries.map(x => x.id), ['a', 'c', 'b', 'd']);
  context.sortInitiativeEntries(e);
  assert.deepEqual(e.entries.map(x => x.id), ['a', 'c', 'b', 'd']);
  assert.equal(turnIdentity(e), before);
  assert.equal(new Set(e.entries.map(x => x.order)).size, 4);
  assert.equal(context.moveHostTiedInitiativeEntry('b', 1), false);
  assert.equal(context.moveHostTiedInitiativeEntry('a', -1), false);
  assert.equal(calls.saves, 1);
});

test('editing one initiative value retains same-value order and rejects invalid drafts', () => {
  const { e, calls, context } = arrange([
    { id: 'a', name: '第一位', value: 20, order: 0 },
    { id: 'b', name: '第二位', value: 15, order: 1 },
    { id: 'c', name: '第三位', value: 10, order: 2 },
  ]);
  const before = turnIdentity(e);
  context.hostInitiativeValueDrafts.set('c', '15');
  assert.equal(context.setHostInitiativeValue('c', '15'), true);
  assert.deepEqual(e.entries.map(x => x.id), ['a', 'b', 'c']);
  assert.equal(context.hostInitiativeValueDrafts.has('c'), false);
  assert.equal(turnIdentity(e), before);
  const snapshot = JSON.stringify(e);
  for (const value of ['', 'NaN', '1.5', '1000', '-1000']) assert.equal(context.setHostInitiativeValue('a', value), false);
  assert.equal(JSON.stringify(e), snapshot); assert.equal(calls.saves, 1);
});

test('initiative management lives in the independent dialog and compact dock remains usable', () => {
  const dockStart = html.indexOf('<section id="init-bar"');
  const dockEnd = html.indexOf('\n    </section>', dockStart);
  const dock = html.slice(dockStart, dockEnd);
  assert.match(dock, /id="btn-init-collapse"[^>]+aria-controls="initiative-manager-modal"/);
  assert.match(dock, /id="btn-init-next-dock"/);
  assert.doesNotMatch(dock, /init-panel-initiative|init-bar-list|init-value/);
  const managerStart = html.indexOf('<div id="initiative-manager-modal"');
  const managerEnd = html.indexOf('<div id="portrait-preview-modal"', managerStart);
  const manager = html.slice(managerStart, managerEnd);
  assert.match(manager, /role="dialog" aria-modal="true" aria-labelledby="initiative-manager-title"/);
  for (const id of ['init-panel-initiative', 'init-bar-list', 'btn-combat-start', 'btn-combat-end',
    'btn-init-next', 'btn-init-environment', 'init-swap-first', 'init-swap-second',
    'btn-turn-path-toggle', 'btn-turn-path-undo', 'btn-turn-path-reset']) assert.match(manager, new RegExp(`id="${id}"`));
  assert.doesNotMatch(manager, /id="(?:init-selected-token|init-value|btn-init-add)"/,
    'selection and numeric entry stay beside the map token, outside the blocking manager');
  assert.doesNotMatch(extract('renderEncounter'), /init-chip-value-input/,
    'the arrangement queue displays values; map popovers handle individual edits');
  assert.match(host, /onManage: openHostInitiativeManager/);
  assert.match(host, /\$\('#btn-init-next-dock'\)\.addEventListener\('click', advanceEncounter\)/);
});

test('all saves reserve same-initiative ordering for the DM', () => {
  assert.match(extract('defaultEncounterState'), /allowInitiativeSwap: false/);
  assert.match(extract('normalizeEncounter'), /allowInitiativeSwap: false/);
  assert.match(extract('publicEncounterState'), /allowInitiativeSwap: false/);
  assert.match(extract('normalizeEncounter'), /normalizeInitiativeEntryOrders/);
  assert.match(extract('applyInitiativeRemoteAction'), /normalizeInitiativeEntryOrders/);
});

test('current-row scrolling moves only the initiative list and preserves dialog-body position', () => {
  const body = { scrollTop: 73 }, frames = [], scrolls = [];
  const current = { getBoundingClientRect: () => ({ top: 150, bottom: 200 }) };
  const list = { scrollTop: 70, isConnected: true,
    querySelector: () => current, closest: () => body,
    getBoundingClientRect: () => ({ top: 100, bottom: 180 }),
    scrollTo(options) { scrolls.push(options); this.scrollTop = options.top; body.scrollTop = 99; } };
  const context = vm.createContext({ lastInitiativeScrollEntryId: null,
    requestAnimationFrame: callback => frames.push(callback) });
  vm.runInContext(extract('scrollCurrentInitiativeIntoView'), context);
  context.scrollCurrentInitiativeIntoView(list, { playMode: 'turn', currentEntryId: 'a' });
  frames.shift()();
  assert.equal(scrolls[0].top, 90); assert.equal(scrolls[0].behavior, 'auto');
  assert.equal(body.scrollTop, 73);
  context.scrollCurrentInitiativeIntoView(list, { playMode: 'turn', currentEntryId: 'a' });
  assert.equal(frames.length, 0, 'ordinary refresh preserves manual list scrolling');
});

test('opening the manager resets body position without focus scrolling or resetting an already-open view', () => {
  const body = { scrollTop: 120 }, panel = { scrollTop: 60 }, focusOptions = [];
  const modal = { hidden: true, querySelector: () => body }, popover = { hidden: false };
  const close = { focus: options => focusOptions.push(options) };
  const elements = { '#initiative-manager-modal': modal, '#init-panel-initiative': panel,
    '#btn-initiative-manager-close': close, '#map-initiative-popover': popover };
  const previous = {};
  const context = vm.createContext({ $: selector => elements[selector], document: { activeElement: previous },
    initiativeManagerReturnFocus: null, lastInitiativeScrollEntryId: 'old', renderEncounter() {} });
  vm.runInContext(extract('openHostInitiativeManager'), context);
  context.openHostInitiativeManager();
  assert.equal(modal.hidden, false); assert.equal(body.scrollTop, 0); assert.equal(panel.scrollTop, 0);
  assert.equal(popover.hidden, true, 'the arrangement manager hides the map editor while its mask is open');
  assert.equal(context.lastInitiativeScrollEntryId, null);
  assert.equal(focusOptions[0].preventScroll, true);
  body.scrollTop = 88; context.lastInitiativeScrollEntryId = 'current';
  context.openHostInitiativeManager();
  assert.equal(body.scrollTop, 88); assert.equal(context.lastInitiativeScrollEntryId, 'current');
});
