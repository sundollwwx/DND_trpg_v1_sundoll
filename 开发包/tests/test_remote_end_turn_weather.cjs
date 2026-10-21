const { DAILY_LIFE_FIXTURE } = require('./project_paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { APP_ROOT, PACKAGE_ROOT } = require('./project_paths.cjs');

const source = fs.readFileSync(path.join(APP_ROOT, '主控台/host/app.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(DAILY_LIFE_FIXTURE, '资料/climate.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `production function ${name} exists`);
  return source.slice(start, end + 2);
}

function fixture(climateConfig = config) {
  const weather = { ...config.defaultWeather, temperature: 11.2, generatedHour: 8, auto: true };
  const encounter = {
    playMode: 'turn', currentEntryId: 'first', round: 2, turnSerial: 10,
    entries: [{ id: 'first', tokenId: null, name: '甲' }, { id: 'second', tokenId: null, name: '乙' }],
    turnPath: { mapId: 'map', tokenId: 'previous', points: [{ x: 10, y: 10 }], segmentEnds: [0] },
    worldTime: { totalSeconds: 8 * 3600 + 10, runningSince: null, rate: 1 },
    weather,
  };
  const state = { campaignId: 'campaign', maps: [], encounter };
  const renders = { encounter: 0, tokens: 0, path: 0 }, saves = [];
  const context = vm.createContext({
    window: { SundollClimateConfig: structuredClone(climateConfig) }, state,
    streamServerSessionId: null, clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    encounterState: () => encounter,
    renderEncounter() { renders.encounter++; }, renderTokens() { renders.tokens++; }, renderTurnPath() { renders.path++; },
    scheduleAutosave(sync) { saves.push({ sync, encounter: plain(encounter) }); },
  });
  // Run the real optional-climate initialization, weather normalization,
  // presentation, clock handling, and remote action dispatcher together.
  vm.runInContext([
    source.slice(source.indexOf('const CLIMATE_CONFIG ='), source.indexOf('function defaultEncounterState()')),
    source.slice(source.indexOf('function worldTimeParts('), source.indexOf('function materializeWorldTime(')),
    ...['emptyTurnPath', 'materializeWorldTime', 'currentInitiativeEntry', 'initiativeEntryLabel',
      'decrementCurrentTokenConditions', 'setEncounterEvent', 'applyRemoteAction'].map(functionSource),
  ].join('\n'), context);
  const action = {
    op: 'endTurn', campaignId: 'campaign', turnSerial: 10, nextEntryId: 'second',
    round: 3, nextTurnSerial: 11, worldTimeSeconds: 8 * 3600 + 16,
  };
  return { context, state, encounter, renders, saves, action };
}

function assertAdvancedAndSaved(f, expectedWeather, expectedWeatherNotice) {
  assert.equal(f.encounter.currentEntryId, 'second');
  assert.equal(f.encounter.round, 3); assert.equal(f.encounter.turnSerial, 11);
  assert.deepEqual(plain(f.encounter.turnPath), { mapId: null, tokenId: null, points: [], segmentEnds: [] });
  assert.equal(f.encounter.worldTime.totalSeconds, 8 * 3600 + 16);
  assert.equal(f.encounter.worldTime.runningSince, null);
  assert.deepEqual(plain(f.encounter.weather), expectedWeather);
  assert.deepEqual(f.renders, { encounter: 1, tokens: 1, path: 1 });
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].sync, expectedWeatherNotice);
  assert.deepEqual(f.saves[0].encounter.weather, expectedWeather, 'the complete received sky is saved');
  assert.equal(f.saves[0].encounter.turnSerial, 11);
  if (!expectedWeatherNotice) assert.equal(f.encounter.lastEvent.label, '玩家结束回合：甲');
  else assert.match(f.encounter.lastEvent.label, /^玩家结束回合：甲；天气变为.+°C$/);
  assert.ok(!f.encounter.lastEvent.label.includes('天气变为天气已暂停'));
}

test('remote end turn without climate config preserves the saved sky and advances without a false weather notice', () => {
  const f = fixture(null);
  const received = { ...f.encounter.weather, regionalNote: '海风记录', generatedHour: 9 };
  f.context.applyRemoteAction({ ...f.action, weather: received });
  assertAdvancedAndSaved(f, received, false);
});

test('an unchanged normalized sky only updates the generation marker and auto mode without a weather-change notice', () => {
  const f = fixture();
  f.encounter.weather.temperature = '11.2';
  const received = { ...f.encounter.weather, temperature: 11.2, generatedHour: 9, auto: false };
  f.context.applyRemoteAction({ ...f.action, weather: received });
  assertAdvancedAndSaved(f, received, false);
});

for (const field of ['climate', 'condition', 'temperature', 'wind']) {
  test(`a changed ${field} in the authoritative sky advances and saves the real weather-change notice`, () => {
    const f = fixture();
    const choices = field === 'climate' ? config.climates : field === 'condition' ? config.conditions : config.winds;
    const changed = field === 'temperature' ? 12.3 : Object.keys(choices).find(value => value !== f.encounter.weather[field]);
    assert.notEqual(changed, undefined, `${field} has an alternate value`);
    const received = { ...f.encounter.weather, [field]: changed, generatedHour: 9 };
    f.context.applyRemoteAction({ ...f.action, weather: received });
    assertAdvancedAndSaved(f, received, true);
    const presentation = f.context.weatherPresentation(received, f.context.worldTimeParts(f.action.worldTimeSeconds));
    assert.equal(f.encounter.lastEvent.label, `玩家结束回合：甲；天气变为${presentation.conditionLabel} ${presentation.temperature}°C`);
  });
}
