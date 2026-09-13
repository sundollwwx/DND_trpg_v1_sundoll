'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '主控台', 'app.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, '主控台', '主控台.html'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} should exist`);
  const paramsEnd = source.indexOf(') {', start);
  assert.notStrictEqual(paramsEnd, -1, `${name} parameter list should end before its body`);
  const bodyStart = paramsEnd + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} is not balanced`);
}

function makeSandbox() {
  const maps = [
    {
      id: 'source', name: '起点', mapW: 1000, mapH: 700,
      tokens: [
        { id: 'horse', name: '坐骑', type: 'ally', owner: '', size: 2, x: 700, y: 600, mountId: null },
        { id: 'rider', name: '骑手', type: 'pc', owner: 'Alice', size: 1, x: 700, y: 600, mountId: 'horse' },
        { id: 'pc2', name: '法师', type: 'pc', owner: '', size: 1, x: 200, y: 100, mountId: null },
        { id: 'ally', name: '魔宠', type: 'ally', owner: 'Bob', size: 1, x: 100, y: 100, mountId: null },
        { id: 'enemy', name: '敌人', type: 'enemy', owner: '', size: 1, x: 300, y: 300, mountId: null },
      ],
    },
    { id: 'target', name: '终点', mapW: 500, mapH: 400, tokens: [] },
  ];
  const state = { maps, activeMapId: 'source', selectedId: 'rider' };
  const encounter = { playMode: 'turn', entries: [{ id: 'i1', tokenId: 'rider' }] };
  const calls = { renderTokens: 0, updateDetail: 0, renderEncounter: 0, renderTurnPath: 0, save: 0, toast: [] };
  const sandbox = { state, calls };
  vm.createContext(sandbox);
  vm.runInContext(`
    let uid = 100;
    const state = globalThis.state;
    const calls = globalThis.calls;
    function activeMap(){return state.maps.find(map=>map.id===state.activeMapId)||null;}
    function activeTokens(){return activeMap()?.tokens||[];}
    function findToken(id){return activeTokens().find(token=>token.id===id);}
    function mapById(id){return state.maps.find(map=>map.id===id)||null;}
    function clamp(value,min,max){return Math.min(max,Math.max(min,Number(value)||0));}
    function currentTurnIncludesToken(id){return id==='rider'||id==='horse';}
    function encounterState(){return globalThis.encounter;}
    function bumpEncounterTurn(e){e.bumped=true;}
    function renumberTokens(){}
    function renderTokens(){calls.renderTokens+=1;}
    function updateDetail(){calls.updateDetail+=1;}
    function renderEncounter(){calls.renderEncounter+=1;}
    function renderTurnPath(){calls.renderTurnPath+=1;}
    function scheduleAutosave(){calls.save+=1;}
    function toast(message){calls.toast.push(message);}
    globalThis.encounter=${JSON.stringify(encounter)};
    ${extractFunction('playerControlledMapTokens')}
    ${extractFunction('transferTokensToMap')}
    ${extractFunction('transferToken')}
    ${extractFunction('transferAllPlayerTokens')}
    globalThis.api={transferToken,transferAllPlayerTokens};
  `, sandbox);
  return sandbox;
}

{
  const sandbox = makeSandbox();
  const moved = sandbox.api.transferAllPlayerTokens('target');
  assert.strictEqual(sandbox.state.activeMapId, 'source', 'bulk transfer must not switch the visible map');
  assert.deepStrictEqual(sandbox.state.maps[0].tokens.map((token) => token.id), ['enemy']);
  assert.strictEqual(moved.length, 4, 'PCs, assigned pieces and their mount should move together');
  const target = sandbox.state.maps[1];
  const rider = target.tokens.find((token) => token.name === '骑手');
  const horse = target.tokens.find((token) => token.name === '坐骑');
  assert.ok(rider && horse);
  assert.strictEqual(rider.mountId, horse.id, 'bulk transfer should preserve riding relationships');
  assert.ok(rider.x <= target.mapW && rider.y <= target.mapH, 'positions should be clamped to the target map');
  assert.strictEqual(sandbox.encounter.entries[0].tokenId, rider.id, 'initiative should follow the transferred token ID');
  assert.strictEqual(sandbox.state.selectedId, null, 'a moved selection should be cleared on the source map');
}

{
  const sandbox = makeSandbox();
  sandbox.api.transferToken('rider', 'target', false);
  assert.strictEqual(sandbox.state.activeMapId, 'source', 'single move must not switch the visible map');
  assert.ok(sandbox.state.maps[0].tokens.some((token) => token.id === 'horse'), 'moving only a rider should leave its mount behind');
  const rider = sandbox.state.maps[1].tokens.find((token) => token.name === '骑手');
  assert.ok(rider);
  assert.strictEqual(rider.mountId, null, 'a rider moved alone should dismount');
}

{
  const sandbox = makeSandbox();
  sandbox.api.transferToken('rider', 'target', true);
  assert.strictEqual(sandbox.state.activeMapId, 'source', 'copy must not switch the visible map');
  assert.ok(sandbox.state.maps[0].tokens.some((token) => token.id === 'rider'), 'copy should preserve the source token');
  assert.strictEqual(sandbox.state.maps[1].tokens[0].mountId, null, 'a copied rider should not point to a mount on another map');
}

assert.match(markup, /id="btn-player-tokens-move"/, 'bulk player transfer control should exist');
console.log('map token transfer checks passed');
