'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const clients = [
  { name: 'host', source: fs.readFileSync(path.join(root, '主控台', 'app.js'), 'utf8') },
  { name: 'player', source: fs.readFileSync(path.join(root, '主控台', '玩家.html'), 'utf8') },
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
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

for (const client of clients) {
  const sandbox = { currentEncounter: null };
  const names = [
    'normalizeTurnPathSegmentEnds',
    'sameTurnPoint',
    'turnPathEdgeKey',
    'turnPathEdgeCounts',
    'recordTurnDragPoint',
    'appendTurnPath',
  ];
  const functions = names.map((name) => extractFunction(client.source, name)).join('\n');
  const expose = client.name === 'host'
    ? 'globalThis.api={normalizeTurnPathSegmentEnds,recordTurnDragPoint,appendTurnPath,turnPathEdgeKey,turnPathEdgeCounts};'
    : 'function encounter(){return globalThis.currentEncounter;} globalThis.api={normalizeTurnPathSegmentEnds,recordTurnDragPoint,appendTurnPath,turnPathEdgeKey,turnPathEdgeCounts};';
  vm.runInNewContext(
    `const MAX_MOVE_POINTS=60,MAX_TURN_PATH_POINTS=200,TURN_DIAGONAL_MIN_STEP=.55,TURN_DIAGONAL_MAX_STEP=1.45,TURN_DIAGONAL_INTENT_RATIO=.35;\n${functions}\n${expose}`,
    sandbox,
  );

  const move = { pathPoints: [{ x: 0, y: 0 }], diagonalCornerIntent: null };
  sandbox.api.recordTurnDragPoint(move, { x: 50, y: 0 }, 50, true, { x: 50, y: 0 });
  sandbox.api.recordTurnDragPoint(move, { x: 100, y: 0 }, 50, true, { x: 100, y: 0 });
  sandbox.api.recordTurnDragPoint(move, { x: 50, y: 0 }, 50, true, { x: 50, y: 0 });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(move.pathPoints)),
    [{ x: 0, y: 0 }, { x: 50, y: 0 }],
    `${client.name}: retracing while held should trim only the active drag`,
  );

  const nextMove = { pathPoints: [{ x: 50, y: 0 }], diagonalCornerIntent: null };
  sandbox.api.recordTurnDragPoint(nextMove, { x: 0, y: 0 }, 50, true, { x: 0, y: 0 });
  assert.strictEqual(nextMove.pathPoints.length, 2, `${client.name}: a new drag must retain its reverse route`);

  const encounterState = {
    playMode: 'turn',
    turnPath: { mapId: null, tokenId: null, points: [], segmentEnds: [] },
  };
  sandbox.currentEncounter = encounterState;
  if (client.name === 'host') {
    sandbox.api.appendTurnPath(encounterState, 'map-1', 'token-1', [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    sandbox.api.appendTurnPath(encounterState, 'map-1', 'token-1', [{ x: 50, y: 0 }, { x: 0, y: 0 }]);
  } else {
    sandbox.api.appendTurnPath('map-1', 'token-1', [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    sandbox.api.appendTurnPath('map-1', 'token-1', [{ x: 50, y: 0 }, { x: 0, y: 0 }]);
  }
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(encounterState.turnPath.segmentEnds)),
    [1, 2],
    `${client.name}: every released drag should create one segment boundary`,
  );
  assert.strictEqual(encounterState.turnPath.points.length, 3, `${client.name}: a later reverse drag must not erase committed points`);
  const key = sandbox.api.turnPathEdgeKey({ x: 0, y: 0 }, { x: 50, y: 0 });
  const counts = sandbox.api.turnPathEdgeCounts(encounterState.turnPath.points);
  assert.strictEqual(counts.get(key), 2, `${client.name}: a repeated edge should be counted twice for thicker drawing`);
}

console.log('turn path behavior checks passed for host and player');
