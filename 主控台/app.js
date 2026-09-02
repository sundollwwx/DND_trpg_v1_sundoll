'use strict';

/* ==================== 常量 ==================== */

const STORAGE_KEY = 'dnd-board-state-v1';
const LIBRARY_KEY = 'dnd-board-library-v1';
const LIBRARY_SAVED_AT_KEY = 'dnd-board-library-saved-at-v1';
// 只用于首次打开且尚未连接“存档”时的内置模板；绝不是当前棋子库的第二份存档。
const BUNDLED_LIBRARY = Array.isArray(window.__LIBRARY_SEED__) ? window.__LIBRARY_SEED__ : [];
const SERVER_URL_KEY = 'sangduoer-server-url-v1';
const APP_VERSION = 'v1.7';

const TYPE_META = {
  pc:    { label: '玩家角色', ring: '#5b8cff', glow: 'rgba(91,140,255,.45)', defaultIcon: '🧙' },
  enemy: { label: '敌人',     ring: '#ef476f', glow: 'rgba(239,71,111,.45)', defaultIcon: '👹' },
  npc:   { label: '中立NPC',   ring: '#f4a261', glow: 'rgba(244,162,97,.45)', defaultIcon: '🧑‍🌾' },
  ally:  { label: '友好NPC',   ring: '#2ecc71', glow: 'rgba(46,204,113,.45)', defaultIcon: '🧑‍🤝‍🧑' },
};

const CONDITION_META = {
  prone:       { label: '倒地', icon: '↘', color: '#f4a261' },
  unconscious: { label: '昏迷', icon: '💤', color: '#9b8cff' },
  incapacitated:{ label: '失能', icon: '⛔', color: '#b9c0cc' },
  blinded:     { label: '目盲', icon: '◌', color: '#c6a97d' },
  deafened:    { label: '耳聋', icon: '耳', color: '#c6a97d' },
  frightened:  { label: '恐慌', icon: '!', color: '#d879ff' },
  charmed:     { label: '魅惑', icon: '♡', color: '#ff8fb3' },
  poisoned:    { label: '中毒', icon: '☠', color: '#79c267' },
  grappled:    { label: '擒抱', icon: '⚓', color: '#d99b62' },
  restrained:  { label: '束缚', icon: '⛓', color: '#d99b62' },
  stunned:     { label: '眩晕', icon: '✦', color: '#ffd166' },
  petrified:   { label: '石化', icon: '◆', color: '#a9b3bf' },
  invisible:   { label: '隐形', icon: '◇', color: '#8fbaff' },
  concentrating:{ label: '专注', icon: '◎', color: '#68d9c0' },
  burning:     { label: '燃烧', icon: '🔥', color: '#ef6c45' },
};

// 两级分类树：一级＝生物类型，二级＝族群，与《怪物图鉴2025》结构一致
const LIB_CATEGORY_TREE = {
  '玩家': ['战役-烬鳞讨伐'],
  '魔宠': ['寻找魔宠'],
  '妖精': ['地精', '熊地精', '大地精', '啵灵蛙', '皮克精', '半羊人', '座狼', '人马', '小仙灵', '闪现犬', '树精'],
  '龙类': ['红龙', '白龙', '黑龙', '绿龙', '蓝龙', '黄铜龙', '赤铜龙', '青铜龙', '银龙', '金龙', '幽影龙', '狗头人', '妖精龙'],
  '巨人': ['巨魔', '食人魔', '序位巨人', '独眼巨人'],
  '类人': ['平民', '警卫', '匪徒', '贵族', '武者', '邪教徒', '祭司', '斥候', '打手', '演艺者', '间谍', '海盗', '狂战士', '魔法师', '骑士', '德鲁伊', '角斗士', '刺客'],
  '怪兽': ['兽化人', '蛇人', '枭熊', '雪怪', '鲨蜥', '螳螂人', '蛇鸡', '百足魔兽', '蚊蝠', '斧嘴鸟', '幽邃熊怪', '天狗'],
  '亡灵': ['骷髅', '丧尸', '食尸鬼', '妖鬼', '木乃伊', '还魂鬼', '死亡骑士', '幽影', '尸妖', '巫妖', '龙巫妖'],
  '邪魔': ['恶魔', '魔鬼', '尤格罗斯魔', '鬣狗人', '鲨华鱼人'],
  '构装': ['魔像', '魔冢', '活化物件', '石化铁牛'],
  '元素': ['魔蝠', '火蜥蜴', '蜥蜴人', '火矮人', '人鱼', '鸟羽人', '四元素', '巨灵'],
  '异怪': ['夺心魔', '寇涛', '史拉蟾', '吉斯人', '穴居攫怪'],
  '天族': ['天使', '斯芬克斯'],
  '泥怪': ['灰泥怪'],
  '植物': ['蕈人', '枯萎怪', '真菌', '启蒙植物'],
  '多类型': ['鬼婆', '眼魔', '纳迦', '吸血鬼', '泰坦'],
  '野兽': ['狼', '熊', '马', '蛇', '蜘蛛', '鸟', '鱼', '恐龙'],
  '法术造物': ['奥术'],
  '物件': ['冒险装备'],
  '坐骑': ['妖精', '天界', '邪魔', '野兽'],
  'NPC': [],
  '角色': [],
  '其他': [],
};

function catParts(c) {
  return String(c || '').split('/').map((s) => s.trim()).filter(Boolean);
}

const INTERACT_TYPES = {
  door: {
    name: '门',
    states: [
      { key: 'closed', label: '关闭', icon: '🚪' },
      { key: 'open', label: '打开', icon: '🚪' },
      { key: 'locked', label: '上锁', icon: '🔒' },
    ],
  },
  chest: {
    name: '宝箱',
    states: [
      { key: 'closed', label: '关闭', icon: '📦' },
      { key: 'open', label: '打开', icon: '🎁' },
    ],
  },
  trap: {
    name: '陷阱',
    states: [
      { key: 'untripped', label: '未触发', icon: '⚠️' },
      { key: 'tripped', label: '已触发', icon: '💥' },
    ],
  },
  torch: {
    name: '火把',
    states: [
      { key: 'off', label: '熄灭', icon: '🕯️' },
      { key: 'on', label: '点燃', icon: '🔥' },
    ],
  },
  gate: {
    name: '铁门',
    states: [
      { key: 'closed', label: '关闭', icon: '⚙️' },
      { key: 'open', label: '打开', icon: '⚙️' },
    ],
  },
  portal: {
    name: '传送门',
    states: [
      { key: 'off', label: '熄灭', icon: '🌀' },
      { key: 'on', label: '开启', icon: '🌀' },
    ],
  },
};

const $ = (sel) => document.querySelector(sel);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const snapToCell = (v, grid) => Math.round(v / grid - 0.5) * grid + grid / 2;
// 1×1 吸附到格心；2×2 及更大吸附到网格线交点（正好占 4 格）
const snapTokenCenter = (v, grid, size) => (size >= 2 ? Math.round(v / grid) * grid : snapToCell(v, grid));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const WORLD_MINUTES_PER_DAY = 24 * 60;
const WORLD_DAYS_PER_WEEK = 7;
const WORLD_WEEKS_PER_YEAR = 52;
const WORLD_MINUTES_PER_YEAR = WORLD_MINUTES_PER_DAY * WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR;
const MAX_MOVE_POINTS = 60;
const MAX_TURN_PATH_POINTS = 200;

function defaultEncounterState() {
  return {
    collapsed: true,
    panel: 'initiative',
    playMode: 'free',
    round: 1,
    currentEntryId: null,
    turnSerial: 1,
    turnPath: {
      mapId: null,
      tokenId: null,
      points: [],
    },
    entries: [],
    worldTime: {
      totalSeconds: 8 * 60 * 60,
      runningSince: null,
      rate: 1,
      resumeAfterTurn: false,
    },
    secondsPerRound: 6,
    lastEvent: null,
  };
}

/* ==================== 状态 ==================== */

const state = {
  maps: [],
  activeMapId: null,
  snap: true,
  showGrid: true,
  showNames: true,
  markMode: false,
  fogOn: false,
  campaignId: null,
  campaignName: '默认战役',
  library: [],
  sharedResources: [],
  sharedNotes: '',
  selectedId: null,
  encounter: defaultEncounterState(),
};

let uid = 1;
let drag = null;
let toastTimer = null;
let autosaveTimer = null;
let folderSaveQueue = Promise.resolve();
let lastFolderSaveAt = 0;
let streamOn = false;
let streamTimer = null;
let streamFailToastAt = 0;
let streamDirty = false;
let streamLastPushAt = 0;
let streamPushing = false;
let streamES = null;
let streamAppliedSeq = 0;
let streamInfo = null;
let streamPlayersTimer = null;
let streamPlayers = [];
let sharedNoteTimer = null;
let hostLocalRolls = new Set();
let tokenAvatar = null;
let boardTool = null;
let editTile = 'floor';
let editVariant = 0;
let mapEditHistory = [];
let doodleTool = 'pen';
let doodleColor = '#ff4d4f';
let doodleWidth = 6;
let doodleDraft = null;
let selectedDoodleId = null;
let fogBrush = 3;
let lastSelId = null;
let libFilter = 'all';
let libSearch = '';
let libCategory = 'all';
let libEditorId = null;
let libAvatar = null;
let libEqDraft = [];
let encounterClockTimer = null;

/* ==================== 地图（多楼层） ==================== */

function activeMap() {
  return state.maps.find((m) => m.id === state.activeMapId) || state.maps[0] || null;
}

function activeTokens() {
  const m = activeMap();
  return m ? m.tokens : [];
}

function normalizeEncounter(raw) {
  const defaults = defaultEncounterState();
  const source = raw && typeof raw === 'object' ? raw : {};
  const usedIds = new Set();
  const sourceEntries = Array.isArray(source.entries) ? source.entries : [];
  const entries = sourceEntries.map((entry, index) => {
    const candidateId = String(entry && entry.id || '').trim();
    let id = candidateId || `i${uid++}`;
    while (usedIds.has(id)) id = `i${uid++}`;
    usedIds.add(id);
    const numericValue = Number(entry && entry.value);
    const order = Number.isFinite(Number(entry && entry.order)) ? Number(entry.order) : index;
    return {
      id,
      name: String(entry && entry.name || '未命名单位').trim().slice(0, 24) || '未命名单位',
      value: Number.isFinite(numericValue) ? clamp(Math.trunc(numericValue), -999, 999) : 0,
      color: String(entry && entry.color || '#e0b34c'),
      tokenId: entry && entry.tokenId ? String(entry.tokenId) : null,
      order,
    };
  });
  const legacyCurrentIndex = Number.isFinite(Number(source.current)) && entries.length
    ? clamp(Math.trunc(Number(source.current)), 0, entries.length - 1) : null;
  const legacyCurrentId = legacyCurrentIndex === null ? null : entries[legacyCurrentIndex].id;
  entries.sort((a, b) => b.value - a.value || a.order - b.order);

  let currentEntryId = source.currentEntryId && usedIds.has(String(source.currentEntryId))
    ? String(source.currentEntryId)
    : null;
  if (!currentEntryId && legacyCurrentId && usedIds.has(legacyCurrentId)) currentEntryId = legacyCurrentId;
  if (!currentEntryId && entries.length && source.playMode === 'turn') currentEntryId = entries[0].id;

  const worldSource = source.worldTime && typeof source.worldTime === 'object' ? source.worldTime : {};
  const rawSeconds = Number(worldSource.totalSeconds);
  const rawMinutes = Number(worldSource.totalMinutes);
  const rawRate = Number(worldSource.rate);
  const runningSince = Number(worldSource.runningSince);
  const worldTime = {
    totalSeconds: Number.isFinite(rawSeconds)
      ? Math.max(0, Math.floor(rawSeconds))
      : (Number.isFinite(rawMinutes) ? Math.max(0, Math.floor(rawMinutes * 60)) : defaults.worldTime.totalSeconds),
    runningSince: Number.isFinite(runningSince) && runningSince > 0 ? runningSince : null,
    rate: Number.isFinite(rawRate) && rawRate > 0 ? clamp(rawRate, 0.01, 60) : 1,
    resumeAfterTurn: worldSource.resumeAfterTurn === true,
  };
  const panel = source.panel === 'time' ? 'time' : 'initiative';
  const playMode = source.playMode === 'turn' ? 'turn' : 'free';
  const rawTurnSerial = Number(source.turnSerial);
  const turnSerial = Number.isFinite(rawTurnSerial) ? Math.max(1, Math.trunc(rawTurnSerial)) : 1;
  const rawSecondsPerRound = Number(source.secondsPerRound);
  const secondsPerRound = Number.isFinite(rawSecondsPerRound) && rawSecondsPerRound > 0
    ? clamp(Math.trunc(rawSecondsPerRound), 1, 3600) : 6;
  const rawTurnPath = source.turnPath && typeof source.turnPath === 'object' ? source.turnPath : {};
  const turnPoints = Array.isArray(rawTurnPath.points) ? rawTurnPath.points.slice(0, MAX_TURN_PATH_POINTS).reduce((out, point) => {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
    return out;
  }, []) : [];
  const turnPath = {
    mapId: rawTurnPath.mapId ? String(rawTurnPath.mapId) : null,
    tokenId: rawTurnPath.tokenId ? String(rawTurnPath.tokenId) : null,
    points: turnPoints,
  };
  const lastEvent = source.lastEvent && typeof source.lastEvent === 'object'
    ? { label: String(source.lastEvent.label || '').slice(0, 80), at: Number(source.lastEvent.at) || Date.now() }
    : null;

  return {
    collapsed: source.collapsed !== false,
    panel,
    playMode,
    round: Math.max(1, Math.trunc(Number(source.round)) || 1),
    currentEntryId,
    turnSerial,
    secondsPerRound,
    turnPath: playMode === 'turn' ? turnPath : { mapId: null, tokenId: null, points: [] },
    entries,
    worldTime,
    lastEvent,
  };
}

function encounterState() {
  if (!state.encounter || typeof state.encounter !== 'object') {
    state.encounter = defaultEncounterState();
  }
  const e = state.encounter;
  if (!Array.isArray(e.entries)) e.entries = [];
  if (e.panel !== 'time') e.panel = 'initiative';
  if (e.playMode !== 'turn') e.playMode = 'free';
  e.round = Math.max(1, parseInt(e.round, 10) || 1);
  e.turnSerial = Math.max(1, parseInt(e.turnSerial, 10) || 1);
  e.secondsPerRound = clamp(Math.trunc(Number(e.secondsPerRound) || 6), 1, 3600);
  if (!e.turnPath || typeof e.turnPath !== 'object') e.turnPath = { mapId: null, tokenId: null, points: [] };
  e.turnPath.mapId = e.turnPath.mapId ? String(e.turnPath.mapId) : null;
  e.turnPath.tokenId = e.turnPath.tokenId ? String(e.turnPath.tokenId) : null;
  e.turnPath.points = Array.isArray(e.turnPath.points) ? e.turnPath.points.filter((point) => (
    point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
  )).slice(0, MAX_TURN_PATH_POINTS).map((point) => ({ x: Number(point.x), y: Number(point.y) })) : [];
  if (e.playMode !== 'turn') e.turnPath = { mapId: null, tokenId: null, points: [] };
  e.entries = e.entries.filter((entry) => entry && entry.id);
  if (!e.entries.some((entry) => entry.id === e.currentEntryId)) e.currentEntryId = e.entries[0]?.id || null;
  if (!e.worldTime || typeof e.worldTime !== 'object') e.worldTime = defaultEncounterState().worldTime;
  const totalSeconds = Number(e.worldTime.totalSeconds);
  const legacyMinutes = Number(e.worldTime.totalMinutes);
  e.worldTime.totalSeconds = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : (Number.isFinite(legacyMinutes) ? Math.max(0, Math.floor(legacyMinutes * 60)) : 8 * 60 * 60);
  delete e.worldTime.totalMinutes;
  e.worldTime.rate = Number.isFinite(Number(e.worldTime.rate)) && Number(e.worldTime.rate) > 0
    ? clamp(Number(e.worldTime.rate), 0.01, 60) : 1;
  e.worldTime.runningSince = Number.isFinite(Number(e.worldTime.runningSince)) && Number(e.worldTime.runningSince) > 0
    ? Number(e.worldTime.runningSince) : null;
  e.worldTime.resumeAfterTurn = e.worldTime.resumeAfterTurn === true;
  return e;
}

function emptyTurnPath() {
  return { mapId: null, tokenId: null, points: [] };
}

function bumpEncounterTurn(e) {
  e.turnSerial = Math.max(1, parseInt(e.turnSerial, 10) || 1) + 1;
  e.turnPath = emptyTurnPath();
}

function sameTurnPoint(a, b) {
  return Math.abs(Number(a?.x) - Number(b?.x)) < 0.01 && Math.abs(Number(a?.y) - Number(b?.y)) < 0.01;
}

function appendTurnPath(e, mapId, tokenId, points) {
  if (!e || e.playMode !== 'turn' || !mapId || !tokenId || !Array.isArray(points)) return;
  const valid = points.filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
    .slice(0, MAX_MOVE_POINTS).map((point) => ({ x: Number(point.x), y: Number(point.y) }));
  if (!valid.length) return;
  const samePath = e.turnPath && e.turnPath.mapId === String(mapId) && e.turnPath.tokenId === String(tokenId);
  const combined = samePath && Array.isArray(e.turnPath.points) ? e.turnPath.points.slice() : [];
  valid.forEach((point) => {
    if (!combined.length || !sameTurnPoint(combined[combined.length - 1], point)) combined.push(point);
  });
  e.turnPath = {
    mapId: String(mapId),
    tokenId: String(tokenId),
    points: combined.length > MAX_TURN_PATH_POINTS
      ? combined.slice(0, MAX_TURN_PATH_POINTS - 1).concat(combined[combined.length - 1])
      : combined,
  };
}

function worldTimeNow(e = encounterState(), now = Date.now()) {
  const w = e.worldTime;
  if (!w.runningSince) return w.totalSeconds;
  const elapsed = Math.max(0, now - w.runningSince) * w.rate / 1000;
  return Math.floor(w.totalSeconds + elapsed);
}

function worldTimeParts(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const secondsPerDay = WORLD_MINUTES_PER_DAY * 60;
  const dayIndex = Math.floor(total / secondsPerDay);
  const dayOfYear = dayIndex % (WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR);
  const inDay = total % secondsPerDay;
  return {
    year: Math.floor(dayIndex / (WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR)) + 1,
    week: Math.floor(dayOfYear / WORLD_DAYS_PER_WEEK) + 1,
    day: (dayOfYear % WORLD_DAYS_PER_WEEK) + 1,
    hour: Math.floor(inDay / 3600),
    minute: Math.floor((inDay % 3600) / 60),
    second: inDay % 60,
    totalSeconds: total,
  };
}

function formatWorldDate(parts) {
  return `第 ${parts.year} 年 · 第 ${parts.week} 周 · 第 ${parts.day} 天`;
}

function formatWorldClock(parts) {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

function materializeWorldTime(e = encounterState(), now = Date.now()) {
  if (!e.worldTime.runningSince) return e.worldTime.totalSeconds;
  e.worldTime.totalSeconds = worldTimeNow(e, now);
  e.worldTime.runningSince = null;
  return e.worldTime.totalSeconds;
}

function currentInitiativeEntry(e = encounterState()) {
  return e.entries.find((entry) => entry.id === e.currentEntryId) || null;
}

function sortInitiativeEntries(e) {
  e.entries.sort((a, b) => b.value - a.value || (a.order || 0) - (b.order || 0));
}

function addInitiativeEntry(e, { name, value, color = '#e0b34c', tokenId = null }) {
  const entry = {
    id: `i${uid++}`,
    name: String(name || '未命名单位').trim().slice(0, 24) || '未命名单位',
    value: clamp(Math.trunc(Number(value) || 0), -999, 999),
    color,
    tokenId: tokenId ? String(tokenId) : null,
    order: Date.now() + e.entries.length,
  };
  e.entries.push(entry);
  sortInitiativeEntries(e);
  if (e.playMode === 'turn' && !e.currentEntryId) e.currentEntryId = entry.id;
  return entry;
}

function addActiveTokensToEncounter() {
  const e = encounterState();
  const existing = new Set(e.entries.map((entry) => entry.tokenId).filter(Boolean));
  const candidates = activeTokens().filter((token) => token && token.id && !existing.has(token.id));
  if (!candidates.length) { toast('当前地图的棋子都已在先攻列表中'); return; }
  candidates.forEach((token) => addInitiativeEntry(e, {
    name: token.name,
    value: 0,
    color: (TYPE_META[token.type] || TYPE_META.npc).ring,
    tokenId: token.id,
  }));
  setEncounterEvent(e, `加入 ${candidates.length} 个地图棋子`);
  renderEncounter(); scheduleAutosave();
}

function initiativeEntryLabel(entry) {
  if (entry && entry.tokenId) {
    const token = activeTokens().find((candidate) => candidate.id === entry.tokenId);
    if (token && token.name) return token.name;
  }
  return entry?.name || '未命名单位';
}

function setEncounterEvent(e, label) {
  e.lastEvent = { label: String(label || '').slice(0, 80), at: Date.now() };
}

function publicEncounterState(visibleTokenIds = null) {
  const e = encounterState();
  const visible = (tokenId) => !tokenId || !visibleTokenIds || visibleTokenIds.has(tokenId);
  const currentEntry = e.entries.find((entry) => entry.id === e.currentEntryId);
  const currentVisible = visible(currentEntry?.tokenId);
  return {
    playMode: e.playMode,
    round: e.round,
    secondsPerRound: e.secondsPerRound,
    currentEntryId: currentVisible ? e.currentEntryId : null,
    turnSerial: e.turnSerial,
    turnPath: {
      mapId: visible(e.turnPath?.tokenId) ? (e.turnPath?.mapId || null) : null,
      tokenId: visible(e.turnPath?.tokenId) ? (e.turnPath?.tokenId || null) : null,
      points: visible(e.turnPath?.tokenId) && Array.isArray(e.turnPath?.points)
        ? e.turnPath.points.map((point) => ({ x: point.x, y: point.y })) : [],
    },
    entries: e.entries.filter((entry) => visible(entry.tokenId)).map((entry) => ({
      id: entry.id,
      name: initiativeEntryLabel(entry),
      value: entry.value,
      color: entry.color,
      tokenId: entry.tokenId,
    })),
    worldTime: {
      totalSeconds: worldTimeNow(e),
      runningSince: e.worldTime.runningSince,
      rate: e.worldTime.rate,
    },
    // 事件文本可能包含被隐藏单位名称，观战端只需要知道状态已更新。
    lastEvent: e.lastEvent ? { at: e.lastEvent.at, label: '流程状态已更新' } : null,
  };
}

function renderEncounter() {
  const bar = $('#init-bar');
  if (!bar) return;
  const e = encounterState();
  const world = worldTimeParts(worldTimeNow(e));
  const current = currentInitiativeEntry(e);
  bar.classList.toggle('collapsed', Boolean(e.collapsed));
  $('#btn-init-collapse').setAttribute('aria-expanded', String(!e.collapsed));
  $('#btn-init-collapse').textContent = `${e.collapsed ? '▸' : '▾'} 游戏流程`;
  $('#init-round-readout').textContent = e.playMode === 'turn' ? `第 ${e.round} 轮` : '自由行动';
  $('#init-time-readout').textContent = `${formatWorldDate(world)} ${formatWorldClock(world)}`;
  $('#init-current-readout').textContent = current && e.playMode === 'turn' ? `当前：${initiativeEntryLabel(current)}` : '未锁定行动单位';
  $('#init-mode-free').classList.toggle('active', e.playMode === 'free');
  $('#init-mode-turn').classList.toggle('active', e.playMode === 'turn');
  $('#init-mode-free').setAttribute('aria-pressed', String(e.playMode === 'free'));
  $('#init-mode-turn').setAttribute('aria-pressed', String(e.playMode === 'turn'));
  document.querySelectorAll('[data-encounter-panel]').forEach((tab) => {
    const active = tab.dataset.encounterPanel === e.panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#init-panel-initiative').hidden = e.panel !== 'initiative';
  $('#init-panel-time').hidden = e.panel !== 'time';
  $('#btn-init-next').disabled = e.playMode !== 'turn' || !e.entries.length;
  $('#btn-init-timer').textContent = e.playMode === 'turn'
    ? '⏱ 按战斗轮推进' : (e.worldTime.runningSince ? '❚❚ 暂停时间' : '▶ 开始时间');
  $('#btn-init-timer').disabled = e.playMode === 'turn';
  $('#btn-time-short-rest').disabled = e.playMode === 'turn';
  $('#btn-time-long-rest').disabled = e.playMode === 'turn';
  const timeInputs = {
    year: $('#time-year'), week: $('#time-week'), day: $('#time-day'), clock: $('#time-clock'),
  };
  if (timeInputs.year && document.activeElement !== timeInputs.year) timeInputs.year.value = world.year;
  if (timeInputs.week && document.activeElement !== timeInputs.week) timeInputs.week.value = world.week;
  if (timeInputs.day && document.activeElement !== timeInputs.day) timeInputs.day.value = world.day;
  if (timeInputs.clock && document.activeElement !== timeInputs.clock) timeInputs.clock.value = formatWorldClock(world);
  $('#world-date-display').textContent = formatWorldDate(world);
  $('#world-clock-display').textContent = formatWorldClock(world);
  $('#time-running-state').textContent = e.playMode === 'turn'
    ? `战斗轮推进：每轮 +${e.secondsPerRound} 秒`
    : (e.worldTime.runningSince ? '时间运行中' : '时间已暂停');
  $('#time-event').textContent = e.lastEvent?.label || '—';
  const list = $('#init-bar-list');
  list.innerHTML = '';
  if (!e.entries.length) {
    list.innerHTML = '<span class="init-empty">添加单位后开始回合</span>';
  } else {
    e.entries.forEach((entry) => {
      const chip = document.createElement('div');
      const currentClass = e.playMode === 'turn' && entry.id === e.currentEntryId ? ' current' : '';
      chip.className = `init-chip${currentClass}`;
      chip.innerHTML = `<span class="init-dot" style="background:${entry.color || '#e0b34c'}"></span><span class="init-chip-name">${esc(initiativeEntryLabel(entry))}</span><span class="init-chip-val">${entry.value}</span>`;
      chip.title = e.playMode === 'turn' ? '设为当前行动单位' : '回合制下可指定当前行动单位';
      chip.addEventListener('click', () => {
        if (e.playMode !== 'turn') { toast('切换到回合制后才能指定当前行动单位'); return; }
        if (e.currentEntryId === entry.id) return;
        e.currentEntryId = entry.id;
        bumpEncounterTurn(e);
        setEncounterEvent(e, `当前单位：${initiativeEntryLabel(entry)}`);
        renderEncounter(); scheduleAutosave();
      });
      const del = document.createElement('button');
      del.className = 'init-chip-del'; del.type = 'button'; del.textContent = '×'; del.title = '移除';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        const index = e.entries.findIndex((item) => item.id === entry.id);
        const wasCurrent = e.currentEntryId === entry.id;
        e.entries.splice(index, 1);
        if (wasCurrent) {
          e.currentEntryId = e.entries[index]?.id || e.entries[index - 1]?.id || null;
          bumpEncounterTurn(e);
        }
        setEncounterEvent(e, `移除先攻单位：${initiativeEntryLabel(entry)}`);
        renderEncounter(); scheduleAutosave();
      });
      chip.appendChild(del);
      list.appendChild(chip);
    });
  }
  renderTurnPath();
}

function decrementCurrentTokenConditions(e) {
  const current = currentInitiativeEntry(e);
  const token = current?.tokenId ? findToken(current.tokenId) : null;
  if (!token || !Array.isArray(token.conditions)) return;
  let changed = false;
  token.conditions = token.conditions.flatMap((condition) => {
    if (!Number.isFinite(Number(condition.remainingTurns))) return [condition];
    const remaining = Math.max(0, Math.trunc(Number(condition.remainingTurns)) - 1);
    changed = true;
    if (!remaining) return [];
    return [{ ...condition, remainingTurns: remaining }];
  });
  if (changed) normalizeSheet(token);
}

function advanceEncounter() {
  const e = encounterState();
  if (e.playMode !== 'turn' || !e.entries.length) return;
  const currentIndex = e.entries.findIndex((entry) => entry.id === e.currentEntryId);
  if (currentIndex < 0) {
    e.currentEntryId = e.entries[0].id;
    bumpEncounterTurn(e);
    setEncounterEvent(e, `当前单位：${initiativeEntryLabel(e.entries[0])}`);
    renderEncounter(); scheduleAutosave();
    return;
  }
  decrementCurrentTokenConditions(e);
  const index = currentIndex;
  const nextIndex = (index + 1) % e.entries.length;
  if (nextIndex === 0) {
    e.round += 1;
    materializeWorldTime(e);
    e.worldTime.totalSeconds += e.secondsPerRound;
  }
  e.currentEntryId = e.entries[nextIndex].id;
  bumpEncounterTurn(e);
  setEncounterEvent(e, nextIndex === 0
    ? `第 ${e.round} 轮开始：世界时间 +${e.secondsPerRound} 秒`
    : `当前单位：${initiativeEntryLabel(e.entries[nextIndex])}`);
  renderEncounter(); scheduleAutosave();
}

function setWorldClockRunning() {
  const e = encounterState();
  if (e.playMode === 'turn') {
    toast('回合制按完整战斗轮推进时间，请使用“下一位”');
    return;
  }
  if (e.worldTime.runningSince) materializeWorldTime(e);
  else e.worldTime.runningSince = Date.now();
  setEncounterEvent(e, e.worldTime.runningSince ? '世界时间开始运行' : '世界时间已暂停');
  renderEncounter(); scheduleAutosave();
}

function advanceWorldTime(seconds, label) {
  const e = encounterState();
  materializeWorldTime(e);
  e.worldTime.totalSeconds += Math.max(0, Math.trunc(seconds));
  setEncounterEvent(e, label);
  renderEncounter(); scheduleAutosave();
}

function setWorldTimeFromInputs() {
  const e = encounterState();
  const year = clamp(Math.trunc(Number($('#time-year').value) || 1), 1, 99999);
  const week = clamp(Math.trunc(Number($('#time-week').value) || 1), 1, WORLD_WEEKS_PER_YEAR);
  const day = clamp(Math.trunc(Number($('#time-day').value) || 1), 1, WORLD_DAYS_PER_WEEK);
  const timeMatch = String($('#time-clock').value || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const hour = timeMatch ? clamp(Number(timeMatch[1]), 0, 23) : 8;
  const minute = timeMatch ? clamp(Number(timeMatch[2]), 0, 59) : 0;
  const second = timeMatch ? clamp(Number(timeMatch[3] || 0), 0, 59) : 0;
  materializeWorldTime(e);
  e.worldTime.totalSeconds = ((year - 1) * WORLD_MINUTES_PER_YEAR * 60)
    + ((week - 1) * WORLD_DAYS_PER_WEEK * WORLD_MINUTES_PER_DAY * 60)
    + ((day - 1) * WORLD_MINUTES_PER_DAY * 60)
    + (hour * 3600) + (minute * 60) + second;
  setEncounterEvent(e, `时间调整为：${formatWorldDate(worldTimeParts(e.worldTime.totalSeconds))}`);
  renderEncounter(); scheduleAutosave();
}

function resetEncounterRound() {
  const e = encounterState();
  e.round = 1;
  e.currentEntryId = e.entries[0]?.id || null;
  bumpEncounterTurn(e);
  setEncounterEvent(e, '战斗轮次已重置');
  renderEncounter(); scheduleAutosave();
}

function mapById(id) {
  return state.maps.find((m) => m.id === id);
}

function makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants) {
  return {
    id: 'm' + (uid++),
    name: name || '未命名地图',
    mapData: dataUrl || null,
    mapW: w || 1400,
    mapH: h || 900,
    gridSize: gridSize || 50,
    cells: Array.isArray(cells) ? cells.map((r) => r.slice()) : null,
    cellStates: cellStates && typeof cellStates === 'object' ? { ...cellStates } : {},
    cellVariants: cellVariants && typeof cellVariants === 'object' ? { ...cellVariants } : {},
    // 原始底图快照：编辑器橡皮只还原到这份快照，不破坏原地图
    baseCells: Array.isArray(cells) ? cells.map((r) => r.slice()) : null,
    baseCellStates: cellStates && typeof cellStates === 'object' ? { ...cellStates } : {},
    baseCellVariants: cellVariants && typeof cellVariants === 'object' ? { ...cellVariants } : {},
    doodles: [],
    fog: {},
    tokens: [],
    cam: { x: 0, y: 0, zoom: 1 },
  };
}

function addMap(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants) {
  const m = makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants);
  state.maps.push(m);
  switchMap(m.id);
  fitView();
  return m;
}

function switchMap(id) {
  const m = mapById(id);
  if (!m) return;
  state.activeMapId = id;
  state.selectedId = null;
  boardTool = null;
  syncBoardTools();
  syncMapSelect();
  applyActiveMap();
  scheduleAutosave();
}

function deleteActiveMap() {
  if (state.maps.length <= 1) {
    toast('至少保留一张地图');
    return;
  }
  const m = activeMap();
  if (!m || !confirm(`确定删除地图「${m.name}」？该地图上的棋子会一并删除。`)) return;
  const invalidatesTurn = m.tokens.some((token) => currentTurnIncludesToken(token.id));
  state.maps = state.maps.filter((x) => x.id !== m.id);
  state.activeMapId = state.maps[0].id;
  state.selectedId = null;
  syncMapSelect();
  applyActiveMap();
  if (invalidatesTurn) bumpEncounterTurn(encounterState());
  renderTurnPath();
  scheduleAutosave();
}

function syncMapSelect() {
  const sel = $('#map-select');
  if (!sel) return;
  sel.innerHTML = '';
  state.maps.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
  sel.value = state.activeMapId;
}

/* ==================== 高清头像（IndexedDB 存储） ==================== */

const AVATAR_DB = 'dnd-board-assets';
const AVATAR_HD_MAX = 2048;      // 高清上限：上传图最高保留 2048px
const AVATAR_DISPLAY_MAX = 512;  // 显示上限：地图/卡片渲染时自动降到 512px，避免大纹理拖图卡顿
const AVATAR_LOW_MAX = 128;      // 低清显示版：关高清时地图棋子使用，恢复以前的轻量纹理
const avatarCache = new Map();
const avatarLowCache = new Map(); // iconImgId -> 128px 低清版
const avatarLodEls = new Map();  // iconImgId -> Set<DOM元素>，用于缩放时切换画质
let lastAvatarZoom = null;
let hdEnabled = false;           // 高清立绘总开关（顶栏 🖼️ 高清），默认关＝最流畅

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AVATAR_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('avatars')) req.result.createObjectStore('avatars');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function avatarPut(id, dataUrl) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('avatars', 'readwrite');
    tx.objectStore('avatars').put(dataUrl, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function avatarGet(id) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('avatars', 'readonly');
    const req = tx.objectStore('avatars').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function canvasHasAlpha(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 255) return true;
  }
  return false;
}

function scaleToDataUrl(img, max, preferJpeg) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  if (preferJpeg && !canvasHasAlpha(c)) return c.toDataURL('image/jpeg', 0.92);
  return c.toDataURL('image/png');
}

function processAvatarFile(file, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => cb({
      hd: scaleToDataUrl(img, AVATAR_HD_MAX, true),
      display: scaleToDataUrl(img, AVATAR_DISPLAY_MAX, true),
      thumb: scaleToDataUrl(img, AVATAR_LOW_MAX, true),
    });
    img.onerror = () => cb(null);
    img.src = reader.result;
  };
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}

// 把头像应用到元素：先显示缩略图，再异步从 IndexedDB 换成高清图
function portraitAssetUrl(path) {
  if (!path) return '';
  if (/^(?:data:|blob:|https?:|\/)/.test(path)) return path;
  const relativePath = String(path).replace(/^(?:\.\.\/)?(?:(?:asset|assets)\/)?棋子库\//, '');
  return '../asset/棋子库/' + relativePath;
}

function applyAvatar(el, iconImg, iconImgId, iconImgHd, iconImgPath) {
  if (iconImg) el.style.backgroundImage = `url("${iconImg}")`;
  if (hdEnabled && iconImgHd) el.style.backgroundImage = `url("${iconImgHd}")`;
  if (iconImgPath) {
    el.style.backgroundSize = '116.3% 116.3%';
    el.style.backgroundPosition = 'center';
    el.style.backgroundImage = `url("${portraitAssetUrl(iconImgPath)}")`;
    return;
  }
  if (iconImgId && hdEnabled) {
    const cached = avatarCache.get(iconImgId);
    if (cached) {
      el.style.backgroundImage = `url("${cached}")`;
    } else {
      avatarGetDisplay(iconImgId).then((disp) => {
        if (!disp || !hdEnabled || !el.isConnected) return;
        if (el.isConnected) el.style.backgroundImage = `url("${disp}")`;
      }).catch(() => {});
    }
  }
}

// 图片降到指定上限：用 createImageBitmap 离主线程解码，不卡界面
function avatarDisplayDataUrl(hdDataUrl, max = AVATAR_DISPLAY_MAX) {
  return (async () => {
    try {
      const blob = await (await fetch(hdDataUrl)).blob();
      const bmp1 = await createImageBitmap(blob);
      if (bmp1.width <= max && bmp1.height <= max) {
        const c = document.createElement('canvas');
        c.width = bmp1.width;
        c.height = bmp1.height;
        const g = c.getContext('2d');
        g.drawImage(bmp1, 0, 0);
        bmp1.close();
        return canvasHasAlpha(c) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
      }
      const scale = max / Math.max(bmp1.width, bmp1.height);
      const w = Math.max(1, Math.round(bmp1.width * scale));
      const h = Math.max(1, Math.round(bmp1.height * scale));
      bmp1.close();
      const bmp2 = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const c = document.createElement('canvas');
      c.width = bmp2.width;
      c.height = bmp2.height;
      const g = c.getContext('2d');
      g.drawImage(bmp2, 0, 0);
      bmp2.close();
      return canvasHasAlpha(c) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
    } catch (e) {
      // 回退：Image + canvas
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = true;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, w, h);
          resolve(canvasHasAlpha(c) ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9));
        };
        img.onerror = () => resolve(hdDataUrl);
        img.src = hdDataUrl;
      });
    }
  })();
}

// 高清入库时顺便生成 512 显示版并永久存入高清库（键 id@d），以后读取零计算
async function storeAvatar(id, hd) {
  await avatarPut(id, hd);
  try {
    const [disp, low] = await Promise.all([
      avatarDisplayDataUrl(hd, AVATAR_DISPLAY_MAX),
      avatarDisplayDataUrl(hd, AVATAR_LOW_MAX),
    ]);
    await Promise.all([avatarPut(id + '@d', disp), avatarPut(id + '@s', low)]);
    avatarCache.set(id, disp);
    avatarLowCache.set(id, low);
  } catch (e) { /* 显示版失败不影响原图 */ }
}

// 优先读显示版（id@d）；没有就现场生成并写回永久库
async function avatarGetDisplay(id) {
  const cached = avatarCache.get(id);
  if (cached) return cached;
  const disp = await avatarGet(id + '@d');
  if (disp) { avatarCache.set(id, disp); return disp; }
  const hd = await avatarGet(id);
  if (!hd) return null;
  const made = await avatarDisplayDataUrl(hd);
  avatarCache.set(id, made);
  try { await avatarPut(id + '@d', made); } catch (e) { /* 忽略 */ }
  return made;
}

// 低清显示版（128px）：关高清时地图棋子用，纹理轻，恢复以前的流畅度
async function avatarGetLow(id) {
  const cached = avatarLowCache.get(id);
  if (cached) return cached;
  const low = await avatarGet(id + '@s');
  if (low) { avatarLowCache.set(id, low); return low; }
  const disp = await avatarGet(id + '@d');
  if (disp) {
    const made = await avatarDisplayDataUrl(disp, AVATAR_LOW_MAX);
    avatarLowCache.set(id, made);
    try { await avatarPut(id + '@s', made); } catch (e) { /* 忽略 */ }
    return made;
  }
  const hd = await avatarGet(id);
  if (hd) {
    const [disp2, low2] = await Promise.all([
      avatarDisplayDataUrl(hd, AVATAR_DISPLAY_MAX),
      avatarDisplayDataUrl(hd, AVATAR_LOW_MAX),
    ]);
    avatarCache.set(id, disp2);
    avatarLowCache.set(id, low2);
    try { await Promise.all([avatarPut(id + '@d', disp2), avatarPut(id + '@s', low2)]); } catch (e) { /* 忽略 */ }
    return low2;
  }
  return null;
}

// 自适应画质：关闭高清时优先使用 128px 缓存；没有缓存则直接使用项目原图。
function applyTokenAvatar(el, t) {
  if (t.iconImg) el.style.backgroundImage = `url("${t.iconImg}")`;
  if (hdEnabled && t.iconImgHd) el.style.backgroundImage = `url("${t.iconImgHd}")`;
  if (t.iconImgPath) el.style.backgroundImage = `url("${portraitAssetUrl(t.iconImgPath)}")`;
  const assetKey = t.iconImgId || (t.iconImgPath ? 'path:' + t.iconImgPath : (t.iconImgHd ? 'embedded:' + t.id : ''));
  if (!assetKey) return;
  el.dataset.avatarId = assetKey;
  el.dataset.lod = 'low';
  if (!avatarLodEls.has(assetKey)) avatarLodEls.set(assetKey, new Set());
  avatarLodEls.get(assetKey).add(el);
  refreshAvatarLodElement(el, t);
}

function refreshAvatarLodElement(el, t) {
  if (!hdEnabled) {
    el.dataset.lod = 'low';
    const low = t.iconImgId ? avatarLowCache.get(t.iconImgId) : null;
    if (low) {
      if (el.dataset.lodUrl !== low) {
        el.dataset.lodUrl = low;
        el.style.backgroundImage = `url("${low}")`;
      }
      return;
    }
    // 正式棋子库只保存项目内路径；若没有低清缓存，直接回退到原图。
    if (t.iconImgPath) {
      const src = portraitAssetUrl(t.iconImgPath);
      el.dataset.lodUrl = src;
      el.style.backgroundSize = '116.3% 116.3%';
      el.style.backgroundPosition = 'center';
      el.style.backgroundImage = `url("${src}")`;
      return;
    } else {
      if (t.iconImg) el.style.backgroundImage = `url("${t.iconImg}")`;
      if (t.iconImgId && !avatarLowCache.has(t.iconImgId)) {
        avatarGetLow(t.iconImgId).then((lv) => {
          if (lv && el.isConnected && el.dataset.lod === 'low') {
            el.dataset.lodUrl = lv;
            el.style.backgroundImage = `url("${lv}")`;
          }
        }).catch(() => {});
      }
    }
    return;
  }
  if (t.iconImgPath) {
    const src = portraitAssetUrl(t.iconImgPath);
    el.dataset.lod = 'high';
    el.dataset.lodUrl = src;
    // 原图有效圆直径约为方图的 86%，放大 1/0.86 后正好铺满棋子圆片。
    el.style.backgroundSize = '116.3% 116.3%';
    el.style.backgroundPosition = 'center';
    el.style.backgroundImage = `url("${src}")`;
    return;
  }
  if (t.iconImgHd) {
    el.dataset.lod = 'high';
    el.dataset.lodUrl = t.iconImgHd;
    el.style.backgroundImage = `url("${t.iconImgHd}")`;
    return;
  }
  if (el.dataset.lod === 'high') return;
  if (!t.iconImgId) { el.dataset.lod = 'low'; return; }
  const cached = avatarCache.get(t.iconImgId);
  if (cached) {
    el.dataset.lod = 'high';
    if (el.dataset.lodUrl !== cached) {
      el.dataset.lodUrl = cached;
      el.style.backgroundImage = `url("${cached}")`;
    }
    return;
  }
  el.dataset.lodUrl = '';
  el.dataset.lod = 'loading';
  avatarGetDisplay(t.iconImgId).then((disp) => {
    if (!disp) { el.dataset.lod = 'low'; return; }
    const els = avatarLodEls.get(t.iconImgId);
    if (!els) return;
    els.forEach((e) => {
      if (e.isConnected && e.dataset.lod === 'loading') {
        e.dataset.lod = 'high';
        e.style.backgroundImage = `url("${disp}")`;
      }
    });
  }).catch(() => {});
}

function refreshAvatarLOD() {
  const m = activeMap();
  const byId = m ? new Map(m.tokens.map((t) => [t.id, t])) : new Map();
  avatarLodEls.forEach((els, id) => {
    els.forEach((el) => {
      if (!el.isConnected) { els.delete(el); return; }
      const t = el.dataset.tokenId ? byId.get(el.dataset.tokenId) : null;
      if (t) refreshAvatarLodElement(el, t);
    });
    if (!els.size) avatarLodEls.delete(id);
  });
}

function setHd(on) {
  hdEnabled = !!on;
  try { localStorage.setItem('sangduoer-hd-toggle', hdEnabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
  const cb = $('#hd-toggle-check');
  if (cb) cb.checked = hdEnabled;
  toast(hdEnabled ? '高清：开（所有棋子立即渲染高清）' : '高清：关（优先使用低清缓存）');
  refreshAvatarLOD();
  renderLibrary();
  updateDetail();
}

$('#hd-toggle-check').addEventListener('change', (e) => setHd(e.target.checked));

// 后台预生成高清显示版缓存：启动后空闲时逐张处理，开关按下时零延迟
async function prewarmAvatarCache() {
  const ids = [...new Set((state.library || []).map((p) => p.iconImgId).filter(Boolean))];
  for (const id of ids) {
    // 只读已经生成好的显示版/低清版，绝不现场计算，避免启动卡顿
    try {
      if (!avatarCache.has(id)) {
        const disp = await avatarGet(id + '@d');
        if (disp) avatarCache.set(id, disp);
      }
      if (!avatarLowCache.has(id)) {
        const low = await avatarGet(id + '@s');
        if (low) avatarLowCache.set(id, low);
      }
    } catch (e) { /* 忽略单张失败 */ }
  }
}

/* ==================== 战役保存与读取 ==================== */

// 旧版浏览器战役库只用于首次迁移；正式战役全部读取绑定文件夹。
const LEGACY_CAMPAIGN_DB = 'dnd-board-campaigns';

function legacyCampaignIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_CAMPAIGN_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('campaigns')) req.result.createObjectStore('campaigns');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function legacyCampaignList() {
  return legacyCampaignIdbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('campaigns', 'readonly');
    const req = tx.objectStore('campaigns').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

async function campaignPut(id, name, snap, options) {
  return writeCampaignRecord(id, name, snap, options);
}

async function campaignGet(id) {
  const list = await campaignList();
  return list.find((item) => item.id === id) || null;
}

async function campaignList() {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return [];
  return readCampaignRecords();
}

async function openCampaignModal() {
  if (!(await ensureSaveFolderAccess(true))) return;
  await readCampaignRecords(true);
  $('#campaign-modal').hidden = false;
  await renderCampaignList();
}

function closeCampaignModal() {
  $('#campaign-modal').hidden = true;
}

async function renderCampaignList() {
  const box = $('#campaign-list');
  $('#campaign-current').textContent = `当前战役：${state.campaignName || '默认战役'}`;
  box.innerHTML = '';
  const list = await campaignList();
  list.sort((a, b) => b.savedAt - a.savedAt);
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'campaign-empty';
    d.textContent = '这个“存档”文件夹中还没有战役。';
    box.appendChild(d);
    return;
  }
  list.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'campaign-row' + (c.id === state.campaignId ? ' current' : '');
    const maps = (c.state && c.state.maps) ? c.state.maps.length : 0;
    const tokens = (c.state && c.state.maps)
      ? c.state.maps.reduce((n, m) => n + (m.tokens ? m.tokens.length : 0), 0)
      : 0;
    const name = document.createElement('span');
    name.className = 'campaign-name';
    name.textContent = c.name;
    const info = document.createElement('span');
    info.className = 'campaign-info';
    const savedAt = c.savedAt ? new Date(c.savedAt).toLocaleString('zh-CN') : '—';
    info.textContent = `${maps} 地图 · ${tokens} 棋子 · 保存于 ${savedAt}`;
    const open = document.createElement('button');
    open.className = 'primary';
    open.textContent = '读取';
    open.addEventListener('click', () => openCampaign(c.id));
    row.append(name, info, open);
    box.appendChild(row);
  });
}

async function openCampaign(id) {
  const c = await campaignGet(id);
  if (!c) return;
  const loaded = await loadFolderSave({
    name: c.name,
    path: c._path,
    folderName: c._folderName,
  });
  if (!loaded) return;
  closeCampaignModal();
  hideCover();
}

function hideCover() {
  const el = $('#cover');
  if (el) el.hidden = true;
}

// 封面「继续战役」：读取上次关闭时自动保存的进度（含当前战役）
function updateCoverContinue() {
  const btn = $('#cover-continue');
  if (!btn) return;
  let raw = null;
  try { raw = localStorage.getItem('dnd-board-state-v1'); } catch (e) { /* 忽略 */ }
  if (!raw) { btn.hidden = true; return; }
  btn.textContent = state.campaignId
    ? '⏯ 继续战役：' + (state.campaignName || '未命名战役')
    : '⏯ 继续上次（临时进度）';
  btn.hidden = false;
}

// 全新战役：空白开始（不继承上次的地图/棋子）
function newCampaignState(name, id) {
  return {
    maps: [],
    activeMapId: null,
    snap: true,
    showGrid: true,
    showNames: true,
    markMode: false,
    fogOn: false,
    campaignId: id,
    campaignName: name,
    sharedResources: Array.isArray(state.sharedResources) ? state.sharedResources.map((link) => ({ ...link })) : [],
    sharedNotes: typeof state.sharedNotes === 'string' ? state.sharedNotes.slice(0, 4000) : '',
    selectedId: null,
    encounter: defaultEncounterState(),
  };
}

/* ==================== DOM 引用 ==================== */

const world = $('#world');
const board = $('#board');
const turnPathCanvas = $('#turn-path-canvas');
const turnPathCtx = turnPathCanvas ? turnPathCanvas.getContext('2d') : null;

/* ==================== 地图 ==================== */

function setMap(dataUrl, w, h, cells, cellStates, cellVariants) {
  const m = activeMap();
  if (!m) return;
  m.mapData = dataUrl;
  m.mapW = w;
  m.mapH = h;
  if (Array.isArray(cells)) {
    m.cells = cells.map((r) => r.slice());
    m.baseCells = m.cells.map((r) => r.slice());
  }
  if (cellStates && typeof cellStates === 'object') {
    m.cellStates = { ...cellStates };
    m.baseCellStates = { ...cellStates };
  }
  if (cellVariants && typeof cellVariants === 'object') {
    m.cellVariants = { ...cellVariants };
    m.baseCellVariants = { ...cellVariants };
  }
  world.style.width = w + 'px';
  world.style.height = h + 'px';
  updateWorldBackground();
  $('#drop-hint').classList.add('hidden');
  fitView();
  clampAllTokens();
  renderTokens();
  scheduleAutosave();
}

function loadMapFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => setMap(reader.result, img.naturalWidth, img.naturalHeight);
    img.onerror = () => toast('图片读取失败，请换一张试试');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function importMapFile(f) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!s.mapW || !s.mapH || !s.gridSize || (!s.mapData && !Array.isArray(s.grid))) throw new Error('bad format');
      const cells = Array.isArray(s.grid) ? s.grid.map((r) => r.slice()) : null;
      const cellStates = s.cellStates && typeof s.cellStates === 'object' ? { ...s.cellStates } : {};
      const cellVariants = s.cellVariants && typeof s.cellVariants === 'object' ? { ...s.cellVariants } : {};
      const dataUrl = cells ? renderCellsToDataUrl(cells, cellStates, s.gridSize, cellVariants) : s.mapData;
      const m = addMap(s.mapName || '导入地图', dataUrl, s.mapW, s.mapH, s.gridSize, cells, cellStates, cellVariants);
      if (m && Array.isArray(s.tokens)) {
        s.tokens.forEach((raw) => {
          if (!raw || typeof raw !== 'object') return;
          m.tokens.push({
            ...raw,
            id: 't' + (uid++),
            x: Number(raw.x) || 0,
            y: Number(raw.y) || 0,
            owner: '',
            groupKey: raw.name || '',
          });
        });
        renderTokens();
      }
      toast(`已添加地图「${s.mapName || '未命名'}」（每格 = 5 尺）`);
    } catch (err) {
      toast('导入失败：这不是地图文件');
    }
  };
  reader.readAsText(f);
}

function updateWorldBackground() {
  const m = activeMap();
  const g = m ? m.gridSize : 50;
  const hasMap = !!m && !!m.mapData;
  const gridLayer =
    `repeating-linear-gradient(to right, rgba(255,255,255,.78) 0, rgba(255,255,255,.78) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to bottom, rgba(255,255,255,.78) 0, rgba(255,255,255,.78) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to right, rgba(0,0,0,.16) 0, rgba(0,0,0,.16) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to bottom, rgba(0,0,0,.16) 0, rgba(0,0,0,.16) 2px, transparent 2px, transparent ${g}px)`;

  world.style.backgroundColor = hasMap ? 'transparent' : (state.showGrid ? '#ddd6c2' : '#0f1116');

  if (hasMap) {
    world.style.backgroundImage = state.showGrid
      ? `${gridLayer}, url("${m.mapData}")`
      : `url("${m.mapData}")`;
    world.style.backgroundSize = state.showGrid
      ? `${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, 100% 100%`
      : '100% 100%';
  } else {
    world.style.backgroundImage = state.showGrid ? gridLayer : 'none';
    world.style.backgroundSize = state.showGrid ? `${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px` : '';
  }
}

function fitView() {
  const m = activeMap();
  if (!m) return;
  const rect = board.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const zoom = clamp(Math.min((rect.width - 100) / m.mapW, (rect.height - 100) / m.mapH), 0.2, 2);
  m.cam.zoom = zoom;
  m.cam.x = (rect.width - m.mapW * zoom) / 2;
  m.cam.y = (rect.height - m.mapH * zoom) / 2;
  applyCamera();
}

function applyCamera() {
  const m = activeMap();
  if (!m) return;
  world.style.transform = `translate(${m.cam.x}px, ${m.cam.y}px) scale(${m.cam.zoom})`;
  if (m.cam.zoom !== lastAvatarZoom) {
    lastAvatarZoom = m.cam.zoom;
    refreshAvatarLOD();
  }
}

function zoomAt(cx, cy, factor) {
  const m = activeMap();
  if (!m) return;
  const rect = board.getBoundingClientRect();
  const px = (cx ?? rect.left + rect.width / 2) - rect.left;
  const py = (cy ?? rect.top + rect.height / 2) - rect.top;
  const newZoom = clamp(m.cam.zoom * factor, 0.2, 4);
  const worldX = (px - m.cam.x) / m.cam.zoom;
  const worldY = (py - m.cam.y) / m.cam.zoom;
  m.cam.zoom = newZoom;
  m.cam.x = px - worldX * newZoom;
  m.cam.y = py - worldY * newZoom;
  applyCamera();
}

/* ==================== 格子渲染（交互式地图） ==================== */

const CELL_BASE = {
  void: '#181b21', floor: '#8f8574', wood: '#a97c50', grass: '#7da05c',
  water: '#4f8fc2', wall: '#5c6068', woodwall: '#6f4f2e', door: '#8a5a2b',
  rock: '#6e6a63', tree: '#3f6b3a', road: '#c4a46f', stairs: '#9a8a70',
  chest: '#9c6b2f', table: '#7a5a35', torch: '#8a7a5a', rubble: '#777168',
  trap: '#8d6e63', sand: '#d9c27a', ice: '#bcd9e8', bars: '#6d7a8a',
  fence: '#8a6a3b', pillar: '#8d8d96', hedge: '#4a7a3a', gate: '#4a5a6a',
  bridge: '#9c6b3a', portal: '#6f5bd9', bed: '#c98f6a', bookshelf: '#7a4a2b',
  altar: '#9a9ab0', throne: '#b08d57', barrel: '#8a5a2b', crate: '#a97c50',
  fountain: '#7fa8c9', statue: '#9aa0a8', lava: '#d94f2b', spikes: '#9aa0a8',
  pit: '#1e2126', bush: '#4a7a3a', mushroom: '#6a6f4a',
};

// 轻便地图编辑：完整地块库（分门别类，每块带名字）
const EDIT_GROUPS = [
  { name: '🟫 地面', tiles: ['grass', 'floor', 'wood', 'sand', 'road', 'water', 'ice', 'lava', 'void'] },
  { name: '🧱 墙与障碍', tiles: ['wall', 'woodwall', 'fence', 'hedge', 'bars', 'pillar', 'rock'] },
  { name: '🚪 门与通道', tiles: ['door', 'gate', 'stairs', 'bridge', 'portal'] },
  { name: '🪑 家具物品', tiles: ['table', 'chest', 'bed', 'bookshelf', 'altar', 'throne', 'barrel', 'crate', 'fountain', 'statue', 'torch'] },
  { name: '⚠️ 机关与自然', tiles: ['rubble', 'trap', 'spikes', 'pit', 'bush', 'tree', 'mushroom'] },
];
const EDIT_TILES = EDIT_GROUPS.flatMap((g) => g.tiles);
const TILE_LABELS = {
  void: '清除', grass: '草地', floor: '石板', wood: '木地板', sand: '沙地', road: '道路',
  water: '水面', ice: '冰面', lava: '岩浆', wall: '石墙', woodwall: '木墙', fence: '栅栏',
  hedge: '树篱', bars: '铁栏', pillar: '石柱', rock: '岩石', door: '木门', gate: '铁门',
  stairs: '楼梯', bridge: '木桥', portal: '传送门', table: '桌子', chest: '宝箱', bed: '床',
  bookshelf: '书架', altar: '祭坛', throne: '王座', barrel: '木桶', crate: '板条箱',
  fountain: '喷泉', statue: '雕像', torch: '火把', rubble: '碎石', trap: '陷阱',
  spikes: '尖刺', pit: '深坑', bush: '灌木', tree: '树', mushroom: '蘑菇',
};

function materialVariantsFor(id) {
  const variants = window.SundollTileRenderer?.getVariants?.(id);
  return Array.isArray(variants) ? variants : [];
}

function normalizeMaterialVariant(id, value) {
  const variants = materialVariantsFor(id);
  if (!variants.length) return null;
  const index = Number.parseInt(value, 10);
  // 旧地图没有记录此字段时，固定使用样式 I，不再由坐标随机决定。
  return Number.isInteger(index) && index >= 0 && index < variants.length ? index : 0;
}

function editTileOptions(id) {
  const variants = materialVariantsFor(id);
  if (!variants.length) return [{ id, variant: null, label: TILE_LABELS[id] || id }];
  return variants.map((variant) => ({ id, variant: variant.index, label: variant.label }));
}

function cellStateDefs(tile) {
  return INTERACT_TYPES[tile] ? INTERACT_TYPES[tile].states : null;
}

// 基于格子坐标的稳定伪随机：同一格子的装饰每次绘制都一致
function stableRand(x, y, salt) {
  let h = (Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263) + Math.imul(salt + 1, 1274126177)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function drawCell(g, px, py, s, id, state, options = {}) {
  const x = Math.round(px / s), y = Math.round(py / s);
  if (window.SundollTileRenderer?.drawMaterial(g, px, py, s, id, {
    x,
    y,
    neighbors: options.neighbors,
    variant: options.variant,
  })) return;
  const cx = px + s / 2, cy = py + s / 2;
  g.fillStyle = CELL_BASE[id] || CELL_BASE.floor;
  g.fillRect(px, py, s, s);
  switch (id) {
    case 'floor':
      g.fillStyle = 'rgba(0,0,0,.10)';
      g.fillRect(px + s * .16, py + s * .26, s * .18, s * .12);
      g.fillRect(px + s * .62, py + s * .58, s * .16, s * .1);
      g.fillRect(px + s * .38, py + s * .78, s * .12, s * .08);
      break;
    case 'wall':
      g.strokeStyle = 'rgba(0,0,0,.28)';
      g.lineWidth = Math.max(1.5, s * .05);
      for (let r = 0; r < 3; r++) {
        const y = py + s * r / 3 + s / 6;
        g.beginPath(); g.moveTo(px, y); g.lineTo(px + s, y); g.stroke();
        const off = r % 2 ? s / 2 : 0;
        for (let x2 = off; x2 < s; x2 += s / 2) {
          g.beginPath(); g.moveTo(px + x2, py + s * r / 3); g.lineTo(px + x2, py + s * (r + 1) / 3); g.stroke();
        }
      }
      break;
    case 'door':
      if (state === 'open') {
        g.fillStyle = '#2a2d36';
        g.fillRect(px + s * .12, py + s * .12, s * .76, s * .76);
        g.fillStyle = '#6f4520';
        g.fillRect(px + s * .12, py + s * .12, s * .12, s * .76);
        g.fillStyle = 'rgba(255,255,255,.18)';
        g.fillRect(px + s * .15, py + s * .15, s * .06, s * .7);
      } else {
        g.fillStyle = '#6f4520';
        g.fillRect(px + s * .08, py + s * .08, s * .84, s * .84);
        g.fillStyle = 'rgba(0,0,0,.35)';
        g.fillRect(px + s * .47, py + s * .08, s * .06, s * .84);
        g.fillStyle = 'rgba(255,255,255,.25)';
        g.fillRect(px + s * .12, py + s * .12, s * .76, s * .08);
        if (state === 'locked') {
          g.fillStyle = '#ffd23f';
          g.beginPath(); g.arc(cx, cy, s * .14, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#2b2d42';
          g.fillRect(cx - s * .03, cy - s * .04, s * .06, s * .1);
        }
      }
      break;
    case 'chest':
      g.fillStyle = '#5d3a15';
      g.fillRect(px + s * .2, py + s * .55, s * .6, s * .3);
      if (state === 'open') {
        g.fillStyle = '#b98a3e';
        g.fillRect(px + s * .14, py + s * .28, s * .72, s * .18);
        g.fillStyle = '#ffd23f';
        g.beginPath(); g.arc(cx - s * .12, py + s * .26, s * .07, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(cx + s * .14, py + s * .18, s * .06, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = '#b98a3e';
        g.fillRect(px + s * .18, py + s * .4, s * .64, s * .2);
        g.fillStyle = '#8a6426';
        g.fillRect(px + s * .2, py + s * .44, s * .6, s * .1);
        g.fillStyle = '#ffd23f';
        g.fillRect(cx - s * .04, py + s * .5, s * .08, s * .12);
      }
      break;
    case 'torch':
      g.fillStyle = '#5d4a2a';
      g.fillRect(px + s * .46, py + s * .4, s * .08, s * .45);
      if (state === 'on') {
        g.fillStyle = '#ff9d2e';
        g.beginPath(); g.arc(cx, py + s * .28, s * .13, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffe08a';
        g.beginPath(); g.arc(cx, py + s * .28, s * .06, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = '#5f5341';
        g.beginPath(); g.arc(cx, py + s * .28, s * .08, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#7a4a2b';
        g.fillRect(px + s * .42, py + s * .3, s * .16, s * .08);
      }
      break;
    case 'trap':
      if (state === 'tripped') {
        g.fillStyle = '#c1121f';
        g.beginPath(); g.arc(cx, cy, s * .28, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#ffe08a';
        g.lineWidth = Math.max(1, s * .05);
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * s * .38, cy + Math.sin(a) * s * .38); g.stroke();
        }
      } else {
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.beginPath(); g.arc(cx, cy, s * .2, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.25)';
        g.lineWidth = Math.max(1, s * .04);
        g.beginPath(); g.arc(cx, cy, s * .2, 0, Math.PI * 2); g.stroke();
      }
      break;
    case 'sand':
      g.fillStyle = 'rgba(0,0,0,.12)';
      for (let i = 0; i < 4; i++) {
        g.fillRect(px + stableRand(x, y, i + 50) * s, py + stableRand(x, y, i + 60) * s, s * .07, s * .05);
      }
      break;
    case 'ice':
      g.strokeStyle = 'rgba(255,255,255,.7)';
      g.lineWidth = Math.max(1, s * .05);
      g.beginPath(); g.moveTo(px + s * .1, py + s * .3); g.lineTo(px + s * .6, py + s * .1); g.stroke();
      g.beginPath(); g.moveTo(px + s * .5, py + s * .7); g.lineTo(px + s * .9, py + s * .5); g.stroke();
      break;
    case 'bars':
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(px, py, s, s * .06);
      g.fillRect(px, py + s * .94, s, s * .06);
      g.fillStyle = '#8fa0b3';
      g.fillRect(px + s * .08, py + s * .06, s * .08, s * .88);
      g.fillRect(px + s * .46, py + s * .06, s * .08, s * .88);
      g.fillRect(px + s * .84, py + s * .06, s * .08, s * .88);
      break;
    case 'fence':
      g.fillStyle = '#6b4c28';
      g.fillRect(px + s * .06, py + s * .1, s * .12, s * .8);
      g.fillRect(px + s * .82, py + s * .1, s * .12, s * .8);
      g.fillRect(px + s * .12, py + s * .3, s * .76, s * .1);
      g.fillRect(px + s * .12, py + s * .62, s * .76, s * .1);
      break;
    case 'pillar':
      g.fillStyle = 'rgba(0,0,0,.3)';
      g.fillRect(px + s * .25, py + s * .08, s * .5, s * .84);
      g.fillStyle = '#b8bcc4';
      g.fillRect(px + s * .2, py + s * .08, s * .6, s * .84);
      g.fillStyle = 'rgba(255,255,255,.25)';
      g.fillRect(px + s * .2, py + s * .08, s * .15, s * .84);
      g.fillStyle = '#8d8d96';
      g.fillRect(px + s * .1, py + s * .02, s * .8, s * .1);
      g.fillRect(px + s * .1, py + s * .88, s * .8, s * .1);
      break;
    case 'hedge':
      g.fillStyle = '#2f552b';
      g.beginPath(); g.arc(px + s * .25, cy, s * .3, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + s * .75, cy, s * .3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4a7a3a';
      g.beginPath(); g.arc(px + s * .5, cy - s * .05, s * .32, 0, Math.PI * 2); g.fill();
      break;
    case 'gate':
      if (state === 'open') {
        g.fillStyle = '#2a2d36';
        g.fillRect(px + s * .1, py + s * .1, s * .8, s * .8);
        g.fillStyle = '#4a5a6a';
        g.fillRect(px + s * .1, py + s * .1, s * .12, s * .8);
        g.fillRect(px + s * .78, py + s * .1, s * .12, s * .8);
      } else {
        g.fillStyle = '#3c4c5c';
        g.fillRect(px + s * .08, py + s * .08, s * .84, s * .84);
        g.fillStyle = '#8fa0b3';
        for (let i = 0; i < 4; i++) {
          g.fillRect(px + s * (.12 + i * .2), py + s * .12, s * .06, s * .76);
        }
        g.fillStyle = '#2b2d42';
        g.fillRect(px + s * .3, py + s * .44, s * .4, s * .12);
      }
      break;
    case 'bridge':
      g.fillStyle = '#6b4c28';
      g.fillRect(px, py + s * .08, s, s * .84);
      g.fillStyle = '#9c6b3a';
      for (let i = 0; i < 5; i++) {
        g.fillRect(px + s * (.1 + i * .2), py + s * .16, s * .1, s * .7);
      }
      g.fillStyle = 'rgba(0,0,0,.2)';
      g.fillRect(px, py + s * .08, s, s * .08);
      g.fillRect(px, py + s * .84, s, s * .08);
      break;
    case 'portal':
      g.fillStyle = '#3a3550';
      g.beginPath(); g.arc(cx, cy, s * .4, 0, Math.PI * 2); g.fill();
      if (state === 'on') {
        g.fillStyle = '#9d7bff';
        g.beginPath(); g.arc(cx, cy, s * .32, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#d9c9ff';
        g.beginPath(); g.arc(cx, cy, s * .18, 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = '#5b5470';
        g.beginPath(); g.arc(cx, cy, s * .28, 0, Math.PI * 2); g.fill();
      }
      break;
    case 'bed':
      g.fillStyle = '#8a5a3b';
      g.fillRect(px + s * .08, py + s * .1, s * .84, s * .16);
      g.fillStyle = '#e3c9b8';
      g.fillRect(px + s * .1, py + s * .26, s * .8, s * .55);
      g.fillStyle = '#f5e6dc';
      g.fillRect(px + s * .1, py + s * .26, s * .3, s * .55);
      g.fillStyle = '#b08d57';
      g.fillRect(px + s * .08, py + s * .78, s * .84, s * .12);
      break;
    case 'bookshelf':
      g.fillStyle = '#5d3a15';
      g.fillRect(px + s * .1, py + s * .08, s * .8, s * .84);
      g.fillStyle = '#a97c50';
      g.fillRect(px + s * .14, py + s * .14, s * .72, s * .22);
      g.fillRect(px + s * .14, py + s * .42, s * .72, s * .22);
      g.fillRect(px + s * .14, py + s * .7, s * .72, s * .22);
      g.fillStyle = '#c94f4f';
      g.fillRect(px + s * .18, py + s * .18, s * .14, s * .14);
      g.fillStyle = '#4f7ac9';
      g.fillRect(px + s * .36, py + s * .18, s * .14, s * .14);
      g.fillStyle = '#4fc98a';
      g.fillRect(px + s * .54, py + s * .18, s * .14, s * .14);
      g.fillStyle = '#c9a84f';
      g.fillRect(px + s * .18, py + s * .46, s * .14, s * .14);
      g.fillStyle = '#8a4fc9';
      g.fillRect(px + s * .36, py + s * .46, s * .14, s * .14);
      g.fillStyle = '#4fc9c9';
      g.fillRect(px + s * .54, py + s * .46, s * .14, s * .14);
      break;
    case 'altar':
      g.fillStyle = '#6f6f86';
      g.fillRect(px + s * .15, py + s * .55, s * .7, s * .25);
      g.fillRect(px + s * .3, py + s * .8, s * .4, s * .1);
      g.fillStyle = '#9a9ab0';
      g.fillRect(px + s * .2, py + s * .25, s * .6, s * .32);
      g.fillStyle = '#c9a84f';
      g.fillRect(cx - s * .08, py + s * .35, s * .16, s * .12);
      break;
    case 'throne':
      g.fillStyle = '#7a5a35';
      g.fillRect(px + s * .55, py + s * .25, s * .18, s * .55);
      g.fillRect(px + s * .15, py + s * .7, s * .7, s * .14);
      g.fillRect(px + s * .22, py + s * .18, s * .5, s * .55);
      g.fillStyle = '#c9a84f';
      g.fillRect(px + s * .3, py + s * .05, s * .34, s * .18);
      g.fillStyle = '#8a3b3b';
      g.fillRect(px + s * .28, py + s * .4, s * .4, s * .28);
      break;
    case 'barrel':
      g.fillStyle = '#6b4c28';
      g.fillRect(px + s * .15, py + s * .08, s * .7, s * .84);
      g.fillStyle = '#8a5a2b';
      g.beginPath(); g.ellipse(cx, py + s * .08, s * .35, s * .08, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(cx, py + s * .92, s * .35, s * .08, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(0,0,0,.3)';
      g.fillRect(px + s * .12, py + s * .38, s * .76, s * .08);
      g.fillRect(px + s * .12, py + s * .55, s * .76, s * .08);
      break;
    case 'crate':
      g.fillStyle = '#8a5a2b';
      g.fillRect(px + s * .12, py + s * .12, s * .76, s * .76);
      g.fillStyle = 'rgba(0,0,0,.3)';
      g.fillRect(px + s * .12, py + s * .12, s * .76, s * .12);
      g.fillRect(px + s * .12, py + s * .12, s * .12, s * .76);
      g.strokeStyle = 'rgba(0,0,0,.35)';
      g.lineWidth = Math.max(1, s * .05);
      g.beginPath(); g.moveTo(px + s * .16, py + s * .16); g.lineTo(px + s * .84, py + s * .84); g.stroke();
      g.beginPath(); g.moveTo(px + s * .84, py + s * .16); g.lineTo(px + s * .16, py + s * .84); g.stroke();
      break;
    case 'fountain':
      g.fillStyle = '#5c6f7a';
      g.beginPath(); g.ellipse(cx, py + s * .78, s * .42, s * .14, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#7fa8c9';
      g.beginPath(); g.ellipse(cx, py + s * .68, s * .32, s * .12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4f8fc2';
      g.fillRect(cx - s * .05, py + s * .28, s * .1, s * .34);
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.beginPath(); g.arc(cx, py + s * .22, s * .08, 0, Math.PI * 2); g.fill();
      break;
    case 'statue':
      g.fillStyle = '#6f737c';
      g.fillRect(px + s * .3, py + s * .68, s * .4, s * .18);
      g.fillRect(px + s * .38, py + s * .4, s * .24, s * .3);
      g.beginPath(); g.arc(cx, py + s * .3, s * .14, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9aa0a8';
      g.fillRect(px + s * .42, py + s * .34, s * .16, s * .3);
      break;
    case 'lava':
      g.fillStyle = '#ff9d2e';
      g.fillRect(px + s * .05, py + s * .05, s * .9, s * .9);
      g.fillStyle = '#ff5a1f';
      g.beginPath(); g.arc(px + s * .3, py + s * .35, s * .2, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + s * .7, py + s * .65, s * .18, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffd23f';
      g.beginPath(); g.arc(px + s * .3, py + s * .35, s * .08, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + s * .7, py + s * .65, s * .07, 0, Math.PI * 2); g.fill();
      break;
    case 'spikes':
      g.fillStyle = '#b8bcc4';
      for (let i = 0; i < 4; i++) {
        const sx = px + s * (.1 + i * .24);
        g.beginPath();
        g.moveTo(sx - s * .08, py + s * .9);
        g.lineTo(sx + s * .12, py + s * .9);
        g.lineTo(sx + s * .02, py + s * .15);
        g.closePath(); g.fill();
      }
      break;
    case 'pit':
      g.fillStyle = '#0f1116';
      g.fillRect(px + s * .08, py + s * .08, s * .84, s * .84);
      g.strokeStyle = 'rgba(255,255,255,.3)';
      g.lineWidth = Math.max(1, s * .05);
      g.strokeRect(px + s * .08, py + s * .08, s * .84, s * .84);
      g.strokeStyle = 'rgba(255,255,255,.15)';
      g.beginPath(); g.moveTo(px + s * .15, py + s * .2); g.lineTo(px + s * .3, py + s * .5); g.lineTo(px + s * .18, py + s * .8); g.stroke();
      break;
    case 'bush':
      g.fillStyle = '#2f552b';
      g.beginPath(); g.arc(px + s * .3, py + s * .55, s * .28, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + s * .7, py + s * .55, s * .28, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#4a7a3a';
      g.beginPath(); g.arc(cx, py + s * .4, s * .3, 0, Math.PI * 2); g.fill();
      break;
    case 'mushroom':
      g.fillStyle = '#e3d9c9';
      g.fillRect(px + s * .42, py + s * .45, s * .16, s * .35);
      g.fillStyle = '#c94f4f';
      g.beginPath(); g.arc(cx, py + s * .4, s * .24, Math.PI, 0); g.fill();
      g.fillStyle = '#ffd9d9';
      g.beginPath(); g.arc(cx - s * .1, py + s * .38, s * .05, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + s * .08, py + s * .3, s * .04, 0, Math.PI * 2); g.fill();
      break;
    case 'water':
      g.strokeStyle = 'rgba(255,255,255,.35)';
      g.lineWidth = Math.max(1.5, s * .05);
      for (let i = 1; i <= 2; i++) {
        const y = py + s * i / 3;
        g.beginPath(); g.moveTo(px + s * .1, y); g.quadraticCurveTo(px + s * .5, y - s * .08, px + s * .9, y); g.stroke();
      }
      break;
    case 'wood':
      g.strokeStyle = 'rgba(0,0,0,.18)';
      g.lineWidth = Math.max(1, s * .04);
      for (let i = 1; i <= 2; i++) {
        g.beginPath(); g.moveTo(px, py + s * i / 3); g.lineTo(px + s, py + s * i / 3); g.stroke();
      }
      break;
    case 'woodwall':
      g.strokeStyle = 'rgba(0,0,0,.25)';
      g.lineWidth = Math.max(1, s * .05);
      for (let x2 = s * .33; x2 < s; x2 += s * .33) {
        g.beginPath(); g.moveTo(px + x2, py); g.lineTo(px + x2, py + s); g.stroke();
      }
      break;
    case 'grass':
      g.fillStyle = 'rgba(40,70,35,.35)';
      for (let i = 0; i < 5; i++) {
        const gx = stableRand(x, y, i + 30);
        const gy = stableRand(x, y, i + 40);
        g.fillRect(px + gx * s, py + gy * s, s * .06, s * .12);
      }
      break;
    case 'tree':
      g.fillStyle = '#4c331f';
      g.fillRect(cx - s * .07, cy, s * .14, s * .22);
      g.fillStyle = '#2f552b';
      g.beginPath(); g.arc(cx, cy - s * .12, s * .37, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#43753d';
      g.beginPath(); g.arc(cx - s * .2, cy - s * .25, s * .25, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + s * .2, cy - s * .15, s * .22, 0, Math.PI * 2); g.fill();
      break;
    case 'rock':
      g.fillStyle = 'rgba(0,0,0,.25)';
      g.beginPath();
      g.moveTo(cx - s * .5, cy + s * .3);
      g.lineTo(cx - s * .25, cy - s * .5);
      g.lineTo(cx + s * .25, cy - s * .35);
      g.lineTo(cx + s * .5, cy + s * .5);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.14)';
      g.beginPath();
      g.moveTo(cx - s * .25, cy - s * .5);
      g.lineTo(cx + s * .25, cy - s * .35);
      g.lineTo(cx + s * .08, cy + s * .05);
      g.closePath(); g.fill();
      break;
    case 'road':
      g.strokeStyle = 'rgba(0,0,0,.18)';
      g.lineWidth = Math.max(1.5, s * .06);
      for (let i = 0; i < 2; i++) {
        const y = py + s * (.35 + i * .3);
        g.beginPath(); g.moveTo(px, y); g.lineTo(px + s, y); g.stroke();
      }
      break;
    case 'stairs':
      g.strokeStyle = 'rgba(0,0,0,.28)';
      g.lineWidth = Math.max(1.5, s * .05);
      for (let i = 1; i <= 4; i++) {
        g.beginPath(); g.moveTo(px, py + s * i / 5); g.lineTo(px + s, py + s * i / 5); g.stroke();
      }
      break;
    case 'table':
      g.fillStyle = '#5d3a15';
      g.fillRect(px + s * .16, py + s * .68, s * .12, s * .22);
      g.fillRect(px + s * .72, py + s * .68, s * .12, s * .22);
      g.fillStyle = '#8a5f33';
      g.fillRect(px + s * .1, py + s * .3, s * .8, s * .42);
      break;
    case 'rubble':
      g.fillStyle = 'rgba(0,0,0,.22)';
      for (let i = 0; i < 4; i++) {
        const rx = stableRand(x, y, i);
        const ry = stableRand(x, y, i + 10);
        const rr = stableRand(x, y, i + 20);
        g.beginPath();
        g.arc(px + s * (.15 + rx * .7), py + s * (.15 + ry * .7), s * (.08 + rr * .1), 0, Math.PI * 2);
        g.fill();
      }
      break;
  }
  if (state === 'marked') {
    g.fillStyle = 'rgba(255,210,63,.22)';
    g.fillRect(px, py, s, s);
    g.strokeStyle = 'rgba(255,210,63,.9)';
    g.lineWidth = Math.max(2, s * .07);
    g.strokeRect(px + s * .05, py + s * .05, s * .9, s * .9);
  }
}

function renderCellsToDataUrl(cells, cellStates, s, cellVariants = {}) {
  const rows = cells.length, cols = cells[0].length;
  const c = document.createElement('canvas');
  c.width = cols * s;
  c.height = rows * s;
  const g = c.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const id = cells[y][x];
      const neighbors = {
        north: y > 0 ? cells[y - 1][x] : 'void',
        south: y < rows - 1 ? cells[y + 1][x] : 'void',
        west: x > 0 ? cells[y][x - 1] : 'void',
        east: x < cols - 1 ? cells[y][x + 1] : 'void',
      };
      const key = `${x},${y}`;
      drawCell(g, x * s, y * s, s, id, cellStates[key] || null, {
        neighbors,
        variant: normalizeMaterialVariant(id, cellVariants[key]),
      });
    }
  }
  return c.toDataURL('image/png');
}

/* ==================== 棋子 ==================== */

function findToken(id) {
  return activeTokens().find((t) => t.id === id);
}

function hpColor(pct) {
  if (pct > 50) return '#4cc38a';
  if (pct > 25) return '#f4a261';
  return '#e74c5e';
}

/* ==================== 棋子数据 ==================== */

function normalizeCondition(condition) {
  const source = condition && typeof condition === 'object' ? condition : {};
  const key = String(source.key || 'custom').slice(0, 32) || 'custom';
  const meta = CONDITION_META[key] || {};
  const rawTurns = Number(source.remainingTurns);
  return {
    id: String(source.id || 'cond' + (uid++)),
    key,
    label: String(source.label || meta.label || '自定义状态').slice(0, 24),
    icon: String(source.icon || meta.icon || '◆').slice(0, 4),
    color: String(source.color || meta.color || '#a8b3c7').slice(0, 24),
    remainingTurns: Number.isFinite(rawTurns) && rawTurns > 0 ? Math.min(999, Math.trunc(rawTurns)) : null,
    visibility: source.visibility === 'gm' ? 'gm' : 'public',
  };
}

function normalizeSheet(t) {
  const hpMax = Math.max(1, Math.min(99999, parseInt(t.hpMax, 10) || 10));
  const hp = Math.max(0, Math.min(99999, Number.isFinite(parseInt(t.hp, 10)) ? parseInt(t.hp, 10) : hpMax));
  const keep = {
    id: String(t.id || 't' + (uid++)),
    name: String(t.name || '无名单位').slice(0, 24),
    type: TYPE_META[t.type] ? t.type : 'npc',
    icon: String(t.icon || '').slice(0, 4),
    iconImg: t.iconImg || null,
    iconImgHd: t.iconImgHd || null,
    iconImgPath: t.iconImgPath || null,
    iconImgId: t.iconImgId || null,
    size: t.size >= 2 ? 2 : 1,
    hp,
    hpMax,
    ac: Math.max(0, Math.min(99, parseInt(t.ac, 10) || 10)),
    conditions: Array.isArray(t.conditions) ? t.conditions.slice(0, 20).map(normalizeCondition) : [],
    publicNote: typeof t.publicNote === 'string' ? t.publicNote.slice(0, 240) : '',
    gmNote: typeof t.gmNote === 'string' ? t.gmNote.slice(0, 500) : '',
    hiddenFromPlayers: t.hiddenFromPlayers === true,
    x: Number.isFinite(Number(t.x)) ? Number(t.x) : 0,
    y: Number.isFinite(Number(t.y)) ? Number(t.y) : 0,
    owner: typeof t.owner === 'string' ? t.owner.slice(0, 24) : '',
    mountId: t.mountId ? String(t.mountId) : null,
    groupKey: t.groupKey ? String(t.groupKey) : null,
  };
  Object.keys(t).forEach((key) => { delete t[key]; });
  Object.assign(t, keep);
  return t;
}

function createTokenEl(t) {
  const m = activeMap();
  const size = (m ? m.gridSize : 50) * t.size;
  const meta = TYPE_META[t.type] || TYPE_META.npc;
  const el = document.createElement('div');
  el.className = 'token';
  el.dataset.id = t.id;
  el.style.left = t.x + 'px';
  el.style.top = t.y + 'px';
  el.style.width = size + 'px';
  el.style.height = size + 'px';

  const circle = document.createElement('div');
  circle.className = 'circle';
  const d = size * 0.76;
  circle.style.width = d + 'px';
  circle.style.height = d + 'px';
  circle.style.setProperty('--ring', meta.ring);
  circle.style.setProperty('--glow', meta.glow);
  if (t.iconImg || t.iconImgHd || t.iconImgPath || t.iconImgId) {
    circle.style.background = 'rgba(20,23,32,.85)';
    circle.style.backgroundSize = t.iconImgPath ? '116.3% 116.3%' : 'cover';
    circle.style.backgroundPosition = 'center';
    circle.style.backgroundRepeat = 'no-repeat';
    circle.dataset.tokenId = t.id;
    applyTokenAvatar(circle, t);
  } else {
    circle.style.background = '#ffffff';
    circle.style.fontSize = (d * 0.42) + 'px';
    circle.textContent = t.icon || meta.defaultIcon;
  }

  el.appendChild(circle);
  if (t.hiddenFromPlayers) el.classList.add('gm-hidden-token');
  const visibleConditions = (t.conditions || []).filter((condition) => condition.visibility !== 'gm');
  if (visibleConditions.length) {
    const badges = document.createElement('div');
    badges.className = 'token-condition-badges';
    visibleConditions.slice(0, 3).forEach((condition) => {
      const badge = document.createElement('span');
      badge.className = 'token-condition-badge';
      badge.style.setProperty('--condition-color', condition.color || '#a8b3c7');
      badge.textContent = condition.icon || '◆';
      badge.title = `${condition.label}${condition.remainingTurns ? ` · 剩余 ${condition.remainingTurns} 回合` : ''}`;
      badges.appendChild(badge);
    });
    if (visibleConditions.length > 3) {
      const more = document.createElement('span');
      more.className = 'token-condition-badge more';
      more.textContent = `+${visibleConditions.length - 3}`;
      badges.appendChild(more);
    }
    el.appendChild(badges);
  }

  // 骑乘：坐骑上叠加骑手小圆 + 🐎 标记
  if (m && t.size >= 2) {
    const riders = m.tokens.filter((r) => r.mountId === t.id);
    if (riders.length) {
      riders.forEach((r, i) => {
        const rMeta = TYPE_META[r.type] || TYPE_META.npc;
        const rs = size * 0.4;
        const rd = document.createElement('div');
        rd.className = 'rider';
        rd.dataset.id = r.id;
        rd.title = r.name;
        rd.style.width = rs + 'px';
        rd.style.height = rs + 'px';
        rd.style.setProperty('--ring', rMeta.ring);
        rd.style.setProperty('--glow', rMeta.glow);
        const ox = (i % 2 === 0 ? 1 : -1) * size * 0.22;
        const oy = (i % 2 === 0 ? -1 : 1) * size * 0.22;
        rd.style.left = (size / 2 + ox - rs / 2) + 'px';
        rd.style.top = (size / 2 + oy - rs / 2) + 'px';
        if (r.iconImg || r.iconImgHd || r.iconImgPath || r.iconImgId) {
          rd.style.backgroundColor = 'rgba(20,23,32,.85)';
          rd.dataset.tokenId = r.id;
          applyTokenAvatar(rd, r);
        } else {
          rd.style.backgroundColor = '#ffffff';
          rd.style.fontSize = (rs * 0.45) + 'px';
          rd.textContent = r.icon || rMeta.defaultIcon;
        }
        el.appendChild(rd);
      });
    }
  }

  if (t.id === state.selectedId) el.classList.add('selected');
  return el;
}

function renderTokens() {
  world.querySelectorAll('.token').forEach((el) => el.remove());
  const frag = document.createDocumentFragment();
  const m = activeMap();
  const mountIds = m ? new Set(m.tokens.filter((x) => x.size >= 2).map((x) => x.id)) : new Set();
  activeTokens().forEach((t) => {
    if (t.mountId && mountIds.has(t.mountId)) return; // 骑手由坐骑绘制
    if (t.mountId && !mountIds.has(t.mountId)) t.mountId = null; // 悬空引用自动清除
    try {
      frag.appendChild(createTokenEl(t));
    } catch (e) {
      console.warn('渲染棋子失败：', t.name, e);
    }
  });
  world.appendChild(frag);
  renderNamesLayer();
  refreshAvatarLOD();
}

function drawTurnPath(ctx, points, color, dashed) {
  if (!ctx || !Array.isArray(points) || points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dashed) ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(points[0].x, points[0].y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = .9;
  const end = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(end.x, end.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderTurnPath(draftPoints = null) {
  if (!turnPathCanvas || !turnPathCtx) return;
  const m = activeMap();
  if (!m) {
    turnPathCtx.clearRect(0, 0, turnPathCanvas.width, turnPathCanvas.height);
    return;
  }
  turnPathCanvas.width = m.mapW;
  turnPathCanvas.height = m.mapH;
  turnPathCtx.clearRect(0, 0, m.mapW, m.mapH);
  const e = encounterState();
  const path = e.playMode === 'turn' && e.turnPath && e.turnPath.mapId === m.id ? e.turnPath.points : [];
  drawTurnPath(turnPathCtx, path, 'rgba(224, 179, 76, .82)', false);
  if (Array.isArray(draftPoints)) drawTurnPath(turnPathCtx, draftPoints, 'rgba(255, 232, 145, .95)', true);
}

// 名字放在独立图层：永远盖在图标之上，但仍在迷雾之下
function tokenNameGap(size) {
  // 名字底边离圆形图标顶边 3px（圆半径为 0.38 × 格子尺寸）
  return size * 0.38 + 3;
}

// 计算某个棋子需要显示的名字标签（坐骑名字在下方、骑手名字在上方居中/均分）
function tokenLabelPositions(t, m) {
  const size = m.gridSize * t.size;
  const out = [];
  const riders = m.tokens.filter((r) => r.mountId === t.id);
  if (t.size >= 2 && riders.length) {
    out.push({ id: t.id, text: t.name, x: t.x, y: t.y + size / 2 + 4, below: true });
    riders.forEach((r, i) => {
      let ox = 0;
      if (riders.length > 1) ox = (i - (riders.length - 1) / 2) * size * 0.34;
      const oy = size * 0.38 + 7;
      out.push({ id: r.id, text: r.name, x: t.x + ox, y: t.y - oy, below: false });
    });
  } else {
    out.push({ id: t.id, text: t.name, x: t.x, y: t.y - tokenNameGap(size), below: false });
  }
  return out;
}

function renderNamesLayer() {
  const layer = $('#names-layer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!state.showNames) return;
  const m = activeMap();
  if (!m) return;
  const mountIds = new Set(m.tokens.filter((x) => x.size >= 2).map((x) => x.id));
  activeTokens().forEach((t) => {
    try {
      if (t.mountId && mountIds.has(t.mountId)) return; // 骑手名字由坐骑统一绘制
      tokenLabelPositions(t, m).forEach((p) => {
        const label = document.createElement('div');
        label.className = 'token-name-label' + (p.below ? ' below' : '');
        label.dataset.id = p.id;
        label.textContent = p.text;
        label.style.left = p.x + 'px';
        label.style.top = p.y + 'px';
        label.style.fontSize = Math.max(7, m.gridSize * t.size * 0.15) + 'px';
        layer.appendChild(label);
      });
    } catch (e) {
      console.warn('渲染名字失败：', t.name, e);
    }
  });
}

// 拖动时同步更新该棋子（以及坐骑上的骑手）的名字位置，保证跟随不卡顿
function syncLabelsFor(t) {
  const layer = $('#names-layer');
  if (!layer || !state.showNames) return;
  const m = activeMap();
  if (!m) return;
  tokenLabelPositions(t, m).forEach((p) => {
    const label = layer.querySelector(`.token-name-label[data-id="${p.id}"]`);
    if (label) {
      label.style.left = p.x + 'px';
      label.style.top = p.y + 'px';
    }
  });
}

function tokenControlGroup(token) {
  const m = activeMap();
  if (!m || !token) return new Set();
  const ids = new Set([token.id]);
  if (token.mountId) ids.add(token.mountId);
  m.tokens.forEach((candidate) => {
    if (candidate.mountId && ids.has(candidate.mountId)) ids.add(candidate.id);
  });
  return ids;
}

function isCurrentTurnToken(token) {
  const e = encounterState();
  if (e.playMode !== 'turn' || !token) return false;
  const current = e.entries.find((entry) => entry.id === e.currentEntryId);
  const currentToken = current?.tokenId ? findToken(current.tokenId) : null;
  return !!currentToken && tokenControlGroup(token).has(currentToken.id);
}

function currentTurnIncludesToken(id) {
  const token = findToken(id);
  const e = encounterState();
  const current = e.entries.find((entry) => entry.id === e.currentEntryId);
  const currentToken = current?.tokenId ? findToken(current.tokenId) : null;
  return !!token && !!currentToken && tokenControlGroup(token).has(currentToken.id);
}

function selectToken(id) {
  state.selectedId = id;
  renderTokens();
  updateDetail();
}

function moveToken(id, x, y, { persist = true } = {}) {
  const m = activeMap();
  if (!m) return;
  const t = findToken(id);
  if (!t) return;
  x = clamp(x, 0, m.mapW);
  y = clamp(y, 0, m.mapH);
  if (state.snap) {
    x = snapTokenCenter(x, m.gridSize, t.size);
    y = snapTokenCenter(y, m.gridSize, t.size);
    const margin = t.size >= 2 ? m.gridSize : m.gridSize / 2;
    x = clamp(x, margin, m.mapW - margin);
    y = clamp(y, margin, m.mapH - margin);
  }
  t.x = x;
  t.y = y;
  if (t.size >= 2) syncRiderData(t);
  const el = world.querySelector(`.token[data-id="${id}"]`);
  if (el) {
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }
  syncLabelsFor(t);
  if (persist) scheduleAutosave();
}

function clampAllTokens() {
  const m = activeMap();
  if (!m) return;
  m.tokens.forEach((t) => {
    t.x = clamp(t.x, 0, m.mapW);
    t.y = clamp(t.y, 0, m.mapH);
  });
}

function deleteToken(id, silent) {
  const t = findToken(id);
  if (!t) return;
  const m = activeMap();
  const invalidatesTurn = currentTurnIncludesToken(id);
  // 删除坐骑时，骑手自动下马（留在原地）
  if (m && t.size >= 2) m.tokens.forEach((r) => { if (r.mountId === id) r.mountId = null; });
  if (m) m.tokens = m.tokens.filter((x) => x.id !== id);
  if (m) renumberTokens(m);
  if (state.selectedId === id) state.selectedId = null;
  renderTokens();
  updateDetail();
  if (invalidatesTurn) bumpEncounterTurn(encounterState());
  renderTurnPath();
  if (!silent) toast(`已删除「${t.name}」`);
  scheduleAutosave();
}

// 相同棋子自动编号：同组（groupKey）内按放置顺序自动编 1、2、3…
// 只放 1 个时名字不带编号；删掉某个后整组自动重新编号
function splitGroupName(name) {
  const s = String(name || '').trim();
  const m = /^(.*?)\s+(\d+)$/.exec(s);
  return m ? { base: m[1].trim(), no: parseInt(m[2], 10) } : { base: s, no: 0 };
}

function tokenGroupKey(t) {
  if (t.groupKey) return String(t.groupKey);
  return splitGroupName(t.name).base || '未命名';
}

function renumberTokens(m) {
  if (!m || !Array.isArray(m.tokens)) return;
  const groups = new Map();
  m.tokens.forEach((t) => {
    const k = tokenGroupKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  groups.forEach((list) => {
    const key = tokenGroupKey(list[0]);
    if (list.length >= 2) {
      list.forEach((t, i) => {
        t.groupKey = key;
        t.name = key + ' ' + (i + 1);
      });
    } else if (list[0].groupKey && list[0].name !== key) {
      // 只剩 1 个：去掉自动编号
      list[0].name = key;
    }
  });
}

function renumberAllMaps() {
  (state.maps || []).forEach(renumberTokens);
}

/* ==================== 骑乘系统 ==================== */

function ridersOf(mount) {
  const m = activeMap();
  return m ? m.tokens.filter((x) => x.mountId === mount.id) : [];
}

function mountOf(rider) {
  const m = activeMap();
  return m ? m.tokens.find((x) => x.id === rider.mountId) || null : null;
}

function syncRiderData(mount) {
  const m = activeMap();
  if (!m) return;
  m.tokens.forEach((r) => {
    if (r.mountId === mount.id) { r.x = mount.x; r.y = mount.y; }
  });
}

function mountRider(riderId, mountId) {
  const m = activeMap();
  if (!m) return;
  const rider = findToken(riderId);
  const mount = findToken(mountId);
  if (!rider || !mount || rider.id === mount.id) return;
  if (rider.size >= 2) { toast('只有 1×1 棋子可以骑乘'); return; }
  if (mount.size < 2) { toast('只能骑乘 2×2 的大型棋子'); return; }
  if (rider.mountId) { toast('「' + rider.name + '」已经在坐骑上'); return; }
  rider.mountId = mount.id;
  rider.x = mount.x;
  rider.y = mount.y;
  renderTokens();
  updateDetail();
  scheduleAutosave();
  toast(`「${rider.name}」骑上了「${mount.name}」`);
}

function dismountRider(riderId) {
  const rider = findToken(riderId);
  if (!rider || !rider.mountId) return;
  rider.mountId = null;
  renderTokens();
  updateDetail();
  scheduleAutosave();
  toast(`「${rider.name}」下马`);
}

function renderMountBox(t) {
  const box = $('#mount-box');
  box.innerHTML = '';
  const m = activeMap();
  if (t.mountId) {
    const mount = mountOf(t);
    box.innerHTML = mount
      ? `<div class="mount-info">骑乘中：<em>${esc(mount.name)}</em>（${mount.size}×${mount.size}）</div>`
      : '<div class="mount-info">骑乘中</div>';
    const actions = document.createElement('div');
    actions.className = 'mount-actions';
    const btn = document.createElement('button');
    btn.className = 'small danger';
    btn.textContent = '下马';
    btn.addEventListener('click', () => dismountRider(t.id));
    actions.appendChild(btn);
    box.appendChild(actions);
    return;
  }
  if (t.size >= 2 && m) {
    const riders = ridersOf(t);
    box.innerHTML = riders.length
      ? `<div class="mount-info">骑手：${riders.map((r) => esc(r.name)).join('、')}</div>`
      : '<div class="mount-info">还没有骑手</div>';
    if (riders.length) {
      const chips = document.createElement('div');
      riders.forEach((r) => {
        const c = document.createElement('span');
        c.className = 'rider-chip';
        c.textContent = r.name + ' ×';
        c.title = '点击选中骑手，再点一次下马';
        c.addEventListener('click', () => {
          if (state.selectedId === r.id) dismountRider(r.id);
          else selectToken(r.id);
        });
        chips.appendChild(c);
      });
      box.appendChild(chips);
    }
    return;
  }
  box.innerHTML = '<div class="mount-info">1×1 棋子可以骑乘 2×2 的大型棋子</div>';
  const actions = document.createElement('div');
  actions.className = 'mount-actions';
  const btn = document.createElement('button');
  btn.className = 'small';
  btn.textContent = '🐎 骑乘';
  btn.addEventListener('click', () => openMountPicker());
  actions.appendChild(btn);
  box.appendChild(actions);
}

function openMountPicker() {
  const m = activeMap();
  const t = state.selectedId ? findToken(state.selectedId) : null;
  const list = $('#mount-list');
  list.innerHTML = '';
  const mounts = m ? m.tokens.filter((x) => x.size >= 2 && x.id !== (t ? t.id : null)) : [];
  if (!mounts.length) {
    list.innerHTML = '<p class="hint">当前地图没有可用的 2×2 坐骑</p>';
  }
  mounts.forEach((mo) => {
    const el = document.createElement('div');
    el.className = 'mount-item';
    const riders = ridersOf(mo);
    el.innerHTML = `<span class="mi-name">${esc(mo.name)}</span><span class="mi-meta">${riders.length ? '骑手 ' + riders.length : '空闲'}</span>`;
    el.addEventListener('click', () => {
      if (t) mountRider(t.id, mo.id);
      $('#mount-modal').hidden = true;
    });
    list.appendChild(el);
  });
  $('#mount-modal').hidden = false;
}

// 把棋子移动/复制到另一张地图（楼层）
function transferToken(id, targetId, copy) {
  const m = activeMap();
  const t = findToken(id);
  const target = mapById(targetId);
  if (!m || !t || !target || target.id === m.id) return;
  const invalidatesTurn = !copy && currentTurnIncludesToken(id);
  const nt = {
    ...t,
    id: 't' + (uid++),
    x: clamp(t.x, 0, target.mapW),
    y: clamp(t.y, 0, target.mapH),
  };
  if (!copy) {
    // 移动坐骑时，骑手跟随；移动骑手时，骑手在目的地自动下马
    if (t.size >= 2) {
      m.tokens.filter((r) => r.mountId === id).forEach((r) => {
        target.tokens.push({ ...r, id: 't' + (uid++), mountId: nt.id, x: clamp(r.x, 0, target.mapW), y: clamp(r.y, 0, target.mapH) });
      });
    }
    m.tokens = m.tokens.filter((x) => x.id !== id && (t.size < 2 || x.mountId !== id));
    if (state.selectedId === id) state.selectedId = null;
  } else if (t.mountId) {
    // 复制一个骑手 → 副本自动下马
    nt.mountId = null;
  }
  target.tokens.push(nt);
  renumberTokens(target);
  if (!copy) renumberTokens(m);
  switchMap(target.id);
  selectToken(nt.id);
  if (invalidatesTurn) bumpEncounterTurn(encounterState());
  renderTurnPath();
  scheduleAutosave();
  toast(copy ? `已复制「${nt.name}」到「${target.name}」` : `已移动「${nt.name}」到「${target.name}」`);
}

/* ==================== 右侧详情 ==================== */

function renderDetailConditions(t) {
  const box = $('#detail-conditions');
  if (!box) return;
  box.innerHTML = '';
  if (!Array.isArray(t.conditions) || !t.conditions.length) {
    box.innerHTML = '<span class="condition-empty">暂无状态</span>';
    return;
  }
  t.conditions.forEach((condition) => {
    const chip = document.createElement('span');
    chip.className = 'condition-chip';
    chip.style.setProperty('--condition-color', condition.color || '#a8b3c7');
    chip.title = condition.visibility === 'gm' ? '仅 GM 可见' : '玩家可见';
    const label = document.createElement('span');
    label.textContent = `${condition.icon || '◆'} ${condition.label}${condition.remainingTurns ? ` · ${condition.remainingTurns}回合` : ''}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'condition-visibility';
    toggle.textContent = condition.visibility === 'gm' ? 'GM' : '公';
    toggle.title = '切换玩家可见性';
    toggle.addEventListener('click', () => {
      condition.visibility = condition.visibility === 'gm' ? 'public' : 'gm';
      renderDetailConditions(t);
      renderTokens();
      scheduleAutosave();
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'condition-remove';
    remove.textContent = '×';
    remove.title = '移除状态';
    remove.addEventListener('click', () => {
      t.conditions = t.conditions.filter((item) => item.id !== condition.id);
      renderDetailConditions(t);
      renderTokens();
      scheduleAutosave();
    });
    chip.append(label, toggle, remove);
    box.appendChild(chip);
  });
}

function populateConditionSelect() {
  const select = $('#detail-condition-select');
  if (!select || select.options.length) return;
  select.innerHTML = '<option value="">选择状态…</option>';
  Object.entries(CONDITION_META).forEach(([key, meta]) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${meta.icon} ${meta.label}`;
    select.appendChild(option);
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '◆ 自定义状态…';
  select.appendChild(custom);
}

function addSelectedCondition() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  const select = $('#detail-condition-select');
  if (!t || !select || !select.value) return;
  const key = select.value;
  const meta = CONDITION_META[key] || {};
  let label = meta.label || '';
  let icon = meta.icon || '◆';
  if (key === 'custom') {
    label = prompt('状态名称', '')?.trim() || '';
    if (!label) return;
    icon = prompt('状态图标（可留空）', '◆')?.slice(0, 4) || '◆';
  }
  const rawTurns = Number($('#detail-condition-turns').value);
  const existing = (t.conditions || []).find((condition) => condition.key === key && condition.label === label);
  const condition = normalizeCondition({
    ...(existing || {}), key, label, icon,
    remainingTurns: Number.isFinite(rawTurns) && rawTurns > 0 ? rawTurns : null,
    visibility: existing?.visibility || 'public',
  });
  if (existing) Object.assign(existing, condition);
  else {
    if (!Array.isArray(t.conditions)) t.conditions = [];
    t.conditions.push(condition);
  }
  $('#detail-condition-select').value = '';
  $('#detail-condition-turns').value = '';
  renderDetailConditions(t);
  renderTokens();
  scheduleAutosave();
}

function updateDetail() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  $('#detail-empty').hidden = !!t;
  $('#detail').hidden = !t;
  if (!t) {
    lastSelId = null;
    return;
  }
  if (t.id !== lastSelId) $('#unit-card').classList.remove('collapsed');
  lastSelId = t.id;
  const meta = TYPE_META[t.type] || TYPE_META.npc;
  const iconEl = $('#detail-icon');
  if (t.iconImg || t.iconImgHd || t.iconImgPath || t.iconImgId) {
    iconEl.textContent = '';
    iconEl.style.backgroundSize = 'cover';
    iconEl.style.backgroundPosition = 'center';
    applyAvatar(iconEl, t.iconImg, t.iconImgId, t.iconImgHd, t.iconImgPath);
  } else {
    iconEl.textContent = t.icon || meta.defaultIcon;
    iconEl.style.backgroundImage = 'none';
  }
  $('#btn-detail-icon-remove').hidden = !(t.iconImg || t.iconImgHd || t.iconImgPath || t.iconImgId);
  $('#detail-name').value = t.name;
  const ownerInput = $('#detail-owner');
  if (ownerInput) ownerInput.value = t.owner || '';
  const dl = $('#owner-list');
  if (dl) {
    const owners = new Set();
    streamPlayers.filter((player) => player && player.online).forEach((player) => {
      if (player.name) owners.add(player.name.trim());
    });
    (state.maps || []).forEach((m) => (m.tokens || []).forEach((x) => {
      if ((x.owner || '').trim()) owners.add(x.owner.trim());
    }));
    if ((t.owner || '').trim()) owners.add(t.owner.trim());
    dl.innerHTML = '';
    [...owners].filter(Boolean).forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      dl.appendChild(o);
    });
  }
  const typeSel = $('#detail-type-select');
  if (typeSel) {
    typeSel.value = t.type;
    typeSel.className = 'type-tag type-select type-' + t.type;
  }
  $('#detail-hp-current').value = t.hp;
  $('#detail-hp-max').value = t.hpMax;
  $('#detail-ac-input').value = t.ac;
  $('#detail-icon-input').value = t.icon || '';

  const pct = t.hpMax > 0 ? clamp((t.hp / t.hpMax) * 100, 0, 100) : 0;
  $('#detail-hp-bar').style.width = pct + '%';
  $('#detail-hp-bar').style.background = hpColor(pct);
  $('#detail-public-note').value = t.publicNote || '';
  $('#detail-gm-note').value = t.gmNote || '';
  $('#detail-hidden-players').checked = t.hiddenFromPlayers === true;
  renderDetailConditions(t);
  renderMountBox(t);

  // 移到其他地图的下拉框（不含当前地图）
  const sel = $('#detail-map-move');
  const prev = sel.value;
  sel.innerHTML = '';
  state.maps.forEach((m) => {
    if (m.id === state.activeMapId) return;
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/* ==================== 骰子 ==================== */

function parseExpr(expr) {
  const m = expr.trim().toLowerCase().match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod = m[3] ? parseInt(m[3], 10) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  return { count, sides, mod, label: expr.trim() };
}

function rollSet(count, sides) {
  return Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
}

function doRoll(expr) {
  const parsed = parseExpr(expr);
  if (!parsed) {
    toast('无法识别的骰子表达式，示例：2d6+3');
    return;
  }

  const chosen = rollSet(parsed.count, parsed.sides);
  const sum = chosen.reduce((a, b) => a + b, 0) + parsed.mod;
  const label = parsed.label;
  const detail = chosen.join(' + ') + (parsed.mod ? (parsed.mod > 0 ? ` + ${parsed.mod}` : ` ${parsed.mod}`) : '');
  // GM 默认只在本机显示；勾选“广播结果”后才发送给玩家。
  playDiceFx(parsed.sides, label, sum, { dice: chosen.slice() });
  addLogLine(label, detail, sum);
  const broadcastBox = $('#dice-broadcast');
  if (broadcastBox && broadcastBox.checked) {
    const rid = `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    hostLocalRolls.add(rid);
    sendHostAction({
      op: 'roll', rid, expr: label, detail, total: sum, sides: parsed.sides, dice: chosen.slice(),
    }).then((result) => {
      if (!result.ok || result.data?.ok === false) {
        hostLocalRolls.delete(rid);
        toast(`⚠ 公开骰子失败：${result.data?.error || '服务器未连接'}`);
      } else {
        toast(`🎲 已向玩家公开 ${label} = ${sum}`);
      }
    }).catch(() => {
      hostLocalRolls.delete(rid);
      toast('⚠ 公开骰子失败：服务器未连接');
    });
  }
}

function addLogLine(label, detail, total) {
  const box = $('#roll-log');
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-label">${esc(label)}</span><span class="log-detail">${esc(detail)}</span><span class="log-total">${total}</span>`;
  box.prepend(div);
  while (box.children.length > 30) box.lastChild.remove();
}

// 3D 骰子动画：玩家掷骰时所有端显示；DM 自己的骰子只在本机显示（保密）
function playDiceFx(sides, label, total, opts) {
  if (window.playDieAnimation) window.playDieAnimation(sides, label, total, opts);
}

/* ==================== 持久化 ==================== */

function stateStorageReplacer(key, value) {
  if (key === 'turnPath' && this === state.encounter) return undefined;
  // 棋子库是全局数据，只写入“存档/棋子库/棋子库.json”。
  if (key === 'library' && this === state) return undefined;
  if ((key === 'iconImgHd' || key === 'iconImg') && this && this.iconImgPath) return null;
  return value;
}

function stateStorageJson(space) {
  return JSON.stringify(state, stateStorageReplacer, space);
}

function stateStorageSnapshot() {
  return JSON.parse(stateStorageJson());
}

function normalizeServerBase(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch (e) {
    return '';
  }
}

function queryServerBase() {
  try {
    return normalizeServerBase(new URLSearchParams(location.search).get('server'));
  } catch (e) {
    return '';
  }
}

function savedServerBase() {
  try { return normalizeServerBase(localStorage.getItem(SERVER_URL_KEY)); } catch (e) { return ''; }
}

function configuredServerBase() {
  return queryServerBase() || savedServerBase();
}

function saveApiBase() {
  return configuredServerBase() || (location.protocol === 'file:' ? 'http://127.0.0.1:8090' : location.origin);
}

// 主控台可能由 file:// 打开，也可能由自定义端口/Tunnel 的同源地址打开。
// 所有联机请求都从同一个入口计算，避免写死 localhost:8090。
function serverApiBase() {
  return saveApiBase();
}

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function playerViewerUrl() {
  const room = streamInfo?.roomCode ? `?room=${encodeURIComponent(streamInfo.roomCode)}` : '';
  const pageIsHttp = location.protocol === 'http:' || location.protocol === 'https:';
  if (pageIsHttp && !isLoopbackHost(location.hostname)) {
    return `${location.origin}/主控台/玩家.html${room}`;
  }
  const configured = configuredServerBase();
  if (configured) {
    try {
      const configuredUrl = new URL(configured);
      if (!isLoopbackHost(configuredUrl.hostname)) return `${configured}/主控台/玩家.html${room}`;
    } catch (e) { /* 回退到局域网地址 */ }
  }
  const ip = streamInfo?.ip || '127.0.0.1';
  const port = streamInfo?.port || 8090;
  return `http://${ip}:${port}/主控台/玩家.html${room}`;
}

function updateServerUrlUi() {
  const input = $('#server-url-input');
  const hint = $('#server-url-hint');
  const override = queryServerBase() || savedServerBase();
  if (input && document.activeElement !== input) input.value = override;
  if (!hint) return;
  const base = serverApiBase();
  hint.textContent = location.protocol === 'file:' && !override
    ? `当前使用默认地址 ${base}；填写后会保存到本机。`
    : `当前 API：${base}${queryServerBase() ? '（来自 URL 参数）' : ''}`;
}

function applyServerUrlSetting() {
  const input = $('#server-url-input');
  const raw = input?.value.trim() || '';
  if (raw && !normalizeServerBase(raw)) {
    toast('服务器地址无效：请填写 http:// 或 https:// 地址');
    return;
  }
  try {
    if (raw) localStorage.setItem(SERVER_URL_KEY, normalizeServerBase(raw));
    else localStorage.removeItem(SERVER_URL_KEY);
  } catch (e) {
    toast('无法保存服务器地址，请检查浏览器存储权限');
    return;
  }
  // URL 参数优先级最高；清空时一并移除本页的 server 参数，避免继续连接旧地址。
  try {
    const url = new URL(location.href);
    if (!raw) url.searchParams.delete('server');
    window.location.href = url.toString();
  } catch (e) {
    window.location.reload();
  }
}

function sendHostAction(action) {
  return fetch(`${serverApiBase()}/api/host-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => ({})) }));
}

function updateSaveStatus(label, kind = '') {
  const el = $('#save-status');
  if (!el) return;
  el.textContent = label;
  el.className = `save-status${kind ? ` ${kind}` : ''}`;
}

function folderSaveSnapshot() {
  return stateStorageSnapshot();
}

function queueCurrentFolderSave(options = {}) {
  const campaignId = state.campaignId;
  if (!campaignId) {
    updateSaveStatus('临时进度 · 仅浏览器缓存', 'error');
    return Promise.resolve(false);
  }
  const campaignName = state.campaignName || '未命名战役';
  const snapshot = folderSaveSnapshot();
  const makeBackup = options.backup === true;
  folderSaveQueue = folderSaveQueue.catch(() => false).then(async () => {
    if (!projectDirHandle || !(await hasSaveFolderPermission())) {
      updateSaveStatus('未写入“存档”文件夹 · 请重新授权', 'error');
      return false;
    }
    updateSaveStatus('正在写入存档文件夹…', 'busy');
    try {
      await writeLibraryFile(loadLibrary());
      const record = await campaignPut(campaignId, campaignName, snapshot, { backup: makeBackup });
      lastFolderSaveAt = Number(record?.savedAt) || Date.now();
      try { localStorage.setItem('dnd-board-last-folder-save-at', String(lastFolderSaveAt)); } catch (e) { /* 忽略 */ }
      updateSaveStatus(`文件夹已保存 ${new Date(lastFolderSaveAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ok');
      if ($('#campaign-modal') && !$('#campaign-modal').hidden) renderCampaignList();
      return true;
    } catch (error) {
      console.warn('写入存档文件夹失败', error);
      updateSaveStatus('写入失败 · 浏览器恢复点已保存', 'error');
      return false;
    }
  });
  return folderSaveQueue;
}

async function loadFolderSave(item, confirmLoad = true) {
  if (!item?.path) return false;
  try {
    const text = await readBoundText(item.path);
    const data = parseCampaignFile(text, item.folderName || '');
    if (!data?.state) {
      toast('存档文件无效或已经损坏');
      return false;
    }
    if (confirmLoad && !confirm(`读取存档「${item.name}」？当前未保存内容会被替换。`)) return false;
    if (state.campaignId) await writeRecoverySnapshot('读取前恢复点', folderSaveSnapshot());
    if (!applySavedState(data.state)) throw new Error('invalid state');
    applyAllState();
    loadLinks();
    renderLinks();
    localStorage.setItem(STORAGE_KEY, stateStorageJson());
    localStorage.setItem('dnd-board-local-save-at', String(Date.now()));
    updateSaveStatus(`已读取 ${item.name}`, 'ok');
    toast(`已读取存档「${item.name}」`);
    streamDirty = true;
    return true;
  } catch (error) {
    console.warn('读取文件夹存档失败', error);
    toast('读取存档失败：请确认文件夹权限');
    return false;
  }
}

async function restoreFolderIfAvailable() {
  if (!projectDirHandle) {
    updateSaveStatus('仅浏览器缓存 · 请连接“存档”文件夹', 'error');
    return;
  }
  if (!(await hasSaveFolderPermission())) {
    updateSaveStatus('“存档”文件夹待授权', 'error');
    return;
  }
  if (!state.campaignId) {
    updateSaveStatus('存档文件夹已连接', 'ok');
    return;
  }
  const record = await campaignGet(state.campaignId);
  if (!record?.state) {
    updateSaveStatus('文件夹已连接 · 等待首次保存', 'ok');
    return;
  }
  let localSavedAt = 0;
  try { localSavedAt = Number(localStorage.getItem('dnd-board-local-save-at')) || 0; } catch (e) { /* 忽略 */ }
  if (!localStorage.getItem(STORAGE_KEY) || !state.maps.length) {
    applySavedState(record.state);
    applyAllState();
    loadLinks();
    renderLinks();
    updateSaveStatus(`已从文件夹恢复 ${new Date(record.savedAt).toLocaleTimeString('zh-CN')}`, 'ok');
    return;
  }
  if (record.savedAt > localSavedAt + 1000 && confirm('检测到更新的文件夹存档，是否读取？')) {
    await writeRecoverySnapshot('读取前恢复点', folderSaveSnapshot());
    applySavedState(record.state);
    applyAllState();
    loadLinks();
    renderLinks();
    localStorage.setItem(STORAGE_KEY, stateStorageJson());
    toast('已读取更新的文件夹存档');
    updateSaveStatus('已读取文件夹存档', 'ok');
  } else if (localSavedAt > record.savedAt + 1000) {
    if (confirm('浏览器恢复点比正式文件更新，是否补写到存档文件夹？')) {
      await queueCurrentFolderSave();
    } else {
      updateSaveStatus('浏览器恢复点较新 · 尚未写入文件夹', 'error');
    }
  } else {
    updateSaveStatus('存档文件夹已连接', 'ok');
  }
}

function scheduleAutosave(markStream = true) {
  if (markStream) streamDirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveNow, 600);
}

function saveNow(options = {}) {
  try {
    // 棋子库有独立存档；本回合路径属于联机临时显示，不写入战役存档。
    const compact = stateStorageJson();
    localStorage.setItem(STORAGE_KEY, compact);
    localStorage.setItem('dnd-board-local-save-at', String(Date.now()));
    if (projectDirHandle) queueCurrentFolderSave({ backup: options.backup === true });
    else updateSaveStatus('仅浏览器缓存 · 请连接“存档”文件夹', 'error');
    return true;
  } catch (e) {
    toast('⚠ 自动保存失败：地图图片可能太大（>5MB）');
    return false;
  }
}

async function saveNowWithFeedback() {
  if (!(await ensureSaveFolderAccess(true))) return;
  if (!state.campaignId) {
    const name = prompt('给这个存档起个名字', `战役 ${new Date().toLocaleDateString('zh-CN')}`);
    if (name === null || !name.trim()) return;
    state.campaignId = 'c' + (uid++);
    state.campaignName = name.trim();
  }
  if (!saveNow({ backup: true })) {
    toast('保存失败');
    return;
  }
  const ok = await folderSaveQueue;
  toast(ok ? `✅ 已保存「${state.campaignName}」` : '仅保存了浏览器恢复点；请重新授权“存档”文件夹');
}

function loadSaved() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  if (!raw) return false;
  return applySavedState(JSON.parse(raw));
}

function applySavedState(s) {
  try {
    state.snap = s.snap !== false;
    state.showGrid = s.showGrid !== false;
    state.showNames = s.showNames !== false;
    state.markMode = !!s.markMode;
    state.fogOn = !!s.fogOn;
    state.campaignId = s.campaignId || null;
    state.campaignName = s.campaignName || '默认战役';
    state.sharedResources = Array.isArray(s.sharedResources)
      ? s.sharedResources.map(normalizeLink).filter(Boolean) : [];
    state.sharedNotes = typeof s.sharedNotes === 'string' ? s.sharedNotes.slice(0, 4000) : '';
    userLinks = state.sharedResources.slice();
    state.selectedId = null;
    state.encounter = normalizeEncounter(s.encounter);
    if (!loadLibrary().length && Array.isArray(s.library) && s.library.length) {
      // 旧版本：棋子库曾存在主存档里，迁移到共享存储
      state.library = s.library.map(normalizeLibPreset);
      saveLibrary();
    }

    const normalizeToken = (t) => {
      const portraitPath = canonicalPortraitPath(t.iconImgPath);
      if (portraitPath) {
        t.iconImgPath = portraitPath;
        t.iconImg = null;
        t.iconImgHd = null;
        t.iconImgId = null;
      }
      if (typeof t.size !== 'number') t.size = 1;
      if (typeof t.hp !== 'number') t.hp = t.hpMax || 10;
      if (typeof t.ac !== 'number') t.ac = 10;
      normalizeSheet(t);
      return t;
    };

    if (Array.isArray(s.maps) && s.maps.length) {
      state.maps = s.maps.map((m) => ({
        id: m.id,
        name: m.name || '未命名地图',
        mapData: m.mapData || null,
        mapW: m.mapW || 1400,
        mapH: m.mapH || 900,
        gridSize: m.gridSize || 50,
        cells: Array.isArray(m.cells) ? m.cells.map((r) => r.slice()) : null,
        cellStates: m.cellStates && typeof m.cellStates === 'object' ? { ...m.cellStates } : {},
        cellVariants: m.cellVariants && typeof m.cellVariants === 'object' ? { ...m.cellVariants } : {},
        baseCells: Array.isArray(m.baseCells) ? m.baseCells.map((r) => r.slice()) : (Array.isArray(m.cells) ? m.cells.map((r) => r.slice()) : null),
        baseCellStates: m.baseCellStates && typeof m.baseCellStates === 'object' ? { ...m.baseCellStates } : (m.cellStates && typeof m.cellStates === 'object' ? { ...m.cellStates } : {}),
        baseCellVariants: m.baseCellVariants && typeof m.baseCellVariants === 'object' ? { ...m.baseCellVariants } : (m.cellVariants && typeof m.cellVariants === 'object' ? { ...m.cellVariants } : {}),
        doodles: Array.isArray(m.doodles) ? m.doodles : [],
        fog: m.fog && typeof m.fog === 'object' ? { ...m.fog } : {},
        tokens: Array.isArray(m.tokens) ? m.tokens.map(normalizeToken) : [],
        cam: m.cam || { x: 0, y: 0, zoom: 1 },
      }));
      state.activeMapId = mapById(s.activeMapId) ? s.activeMapId : state.maps[0].id;
    } else {
      // 旧版本存档迁移：单张地图
      const legacy = makeMapEntry(
        '地图 1',
        s.mapData || null,
        s.mapW || 1400,
        s.mapH || 900,
        s.gridSize || 50
      );
      legacy.tokens = Array.isArray(s.tokens) ? s.tokens.map(normalizeToken) : [];
      legacy.cells = null;
      legacy.cellStates = {};
      legacy.cellVariants = {};
      legacy.baseCells = null;
      legacy.baseCellStates = {};
      legacy.baseCellVariants = {};
      legacy.doodles = [];
      legacy.fog = {};
      legacy.cam = s.cam || legacy.cam;
      state.maps = [legacy];
      state.activeMapId = legacy.id;
    }

    const ids = state.maps.flatMap((m) => [m.id, ...m.tokens.map((t) => t.id)])
      .map((id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0)
      .concat(state.library.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10) || 0))
      .concat(state.encounter.entries.map((entry) => parseInt(String(entry.id).replace(/\D/g, ''), 10) || 0));
    uid = Math.max(1, ...ids) + 1;
    renumberAllMaps();
    return true;
  } catch (e) {
    console.warn('读取存档失败', e);
    return false;
  }
}

function applyAllState() {
  $('#grid-toggle').checked = state.showGrid;
  $('#names-toggle').checked = state.showNames;
  $('#mark-toggle').checked = state.markMode;
  $('#fog-toggle').checked = state.fogOn;
  $('#snap-toggle').checked = state.snap;
  renderLibrary();
  renderSharedNotes();
  syncMapSelect();
  applyActiveMap();
}

function applyActiveMap() {
  const m = activeMap();
  if (!m) return;
  world.style.width = m.mapW + 'px';
  world.style.height = m.mapH + 'px';
  $('#fog-canvas').width = m.mapW;
  $('#fog-canvas').height = m.mapH;
  $('#doodle-canvas').width = m.mapW;
  $('#doodle-canvas').height = m.mapH;
  if (turnPathCanvas) {
    turnPathCanvas.width = m.mapW;
    turnPathCanvas.height = m.mapH;
  }
  updateWorldBackground();
  $('#drop-hint').classList.toggle('hidden', !!m.mapData);
  applyCamera();
  clampAllTokens();
  renderTokens();
  renderDoodles();
  renderFog();
  renderTurnPath();
  updateDetail();
}

/* ==================== Toast ==================== */

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ==================== 事件 ==================== */

function bindEvents() {
  populateConditionSelect();
  // 地图
  $('#file-map').addEventListener('change', (e) => {
    if (e.target.files[0]) loadMapFromFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#file-map-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importMapFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#file-map-folder').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    files.forEach(importMapFile);
    toast(`已从地图文件夹加载 ${files.length} 张地图`);
  });

  // 拼接地图
  $('#stitch-layout').addEventListener('change', renderStitchSlots);
  $('#btn-stitch-cancel').addEventListener('click', closeStitchModal);
  $('#btn-stitch-go').addEventListener('click', stitchGo);
  $('#stitch-modal').addEventListener('click', (e) => {
    if (e.target === $('#stitch-modal')) closeStitchModal();
  });

  // 封面页
  $('#cover-continue').addEventListener('click', () => {
    hideCover();
    toast(state.campaignId ? `已继续战役「${state.campaignName || ''}」` : '已继续上次临时进度');
  });
  $('#cover-new').addEventListener('click', async () => {
    if (!(await ensureSaveFolderAccess(true))) return;
    const name = prompt('新战役名称', `战役 ${new Date().toLocaleDateString('zh-CN')}`);
    if (name === null || !name.trim()) return;
    const id = 'c' + (uid++);
    const snap = newCampaignState(name.trim(), id);
    await campaignPut(id, name.trim(), snap);
    state.maps = [];
    state.activeMapId = null;
    state.campaignId = id;
    state.campaignName = name.trim();
    state.selectedId = null;
    state.snap = true;
    state.showGrid = true;
    state.showNames = true;
    state.markMode = false;
    state.fogOn = false;
    state.encounter = defaultEncounterState();
    applyAllState();
    scheduleAutosave();
    hideCover();
    toast(`已新建战役「${name.trim()}」，从空白地图开始`);
  });
  $('#cover-load').addEventListener('click', () => openCampaignModal());
  $('#cover-temp').addEventListener('click', () => {
    hideCover();
    toast('已进入临时战役（不写入战役存档）');
  });
  $('#btn-save-folder-change').addEventListener('click', async () => {
    if (!(await bindProjectFolder())) return;
    await readCampaignRecords(true);
    await renderCampaignList();
  });
  $('#btn-campaign-close').addEventListener('click', closeCampaignModal);
  $('#btn-mount-cancel').addEventListener('click', () => { $('#mount-modal').hidden = true; });
  $('#mount-modal').addEventListener('click', (e) => {
    if (e.target === $('#mount-modal')) $('#mount-modal').hidden = true;
  });
  $('#btn-link-add').addEventListener('click', () => {
    addLink($('#link-name').value, $('#link-url').value);
    $('#link-name').value = '';
    $('#link-url').value = '';
  });
  $('#links-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-idx]');
    if (!del) return;
    const i = parseInt(del.dataset.idx, 10);
    if (!userLinks || !userLinks[i]) return;
    if (!confirm(`删除「${userLinks[i].name}」？`)) return;
    userLinks.splice(i, 1);
    saveLinks();
    renderLinks();
  });
  $('#shared-note').addEventListener('input', (e) => updateSharedNotes(e.target.value));
  $('#campaign-modal').addEventListener('click', (e) => {
    if (e.target === $('#campaign-modal')) closeCampaignModal();
  });

  // 拖拽与粘贴地图
  board.addEventListener('dragover', (e) => { e.preventDefault(); });
  board.addEventListener('dragenter', (e) => { e.preventDefault(); });
  board.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadMapFromFile(f);
  });
  document.addEventListener('paste', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadMapFromFile(item.getAsFile());
  });

  // 网格与吸附
  $('#grid-toggle').addEventListener('change', (e) => {
    state.showGrid = e.target.checked;
    updateWorldBackground();
    scheduleAutosave();
  });
  $('#names-toggle').addEventListener('change', (e) => {
    state.showNames = e.target.checked;
    renderTokens();
    scheduleAutosave();
  });
  $('#mark-toggle').addEventListener('change', (e) => {
    state.markMode = e.target.checked;
    scheduleAutosave();
  });
  $('#fog-toggle').addEventListener('change', (e) => {
    state.fogOn = e.target.checked;
    renderFog();
    scheduleAutosave();
  });
  $('#snap-toggle').addEventListener('change', (e) => {
    state.snap = e.target.checked;
    scheduleAutosave();
  });

  // 地图切换（楼层）
  $('#map-select').addEventListener('change', (e) => switchMap(e.target.value));
  $('#btn-map-prev').addEventListener('click', () => {
    if (!state.maps.length) return;
    const idx = state.maps.findIndex((m) => m.id === state.activeMapId);
    switchMap(state.maps[(idx - 1 + state.maps.length) % state.maps.length].id);
  });
  $('#btn-map-next').addEventListener('click', () => {
    if (!state.maps.length) return;
    const idx = state.maps.findIndex((m) => m.id === state.activeMapId);
    switchMap(state.maps[(idx + 1) % state.maps.length].id);
  });

  // 视图
  $('#btn-fit').addEventListener('click', fitView);
  $('#btn-zoom-in').addEventListener('click', () => zoomAt(null, null, 1.3));
  $('#btn-zoom-out').addEventListener('click', () => zoomAt(null, null, 1 / 1.3));
  $('#btn-zoom-fit').addEventListener('click', fitView);

  board.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });

  // 拖拽：棋子 / 平移
  board.addEventListener('pointerdown', (e) => {
    // 只处理左键（右键留给 contextmenu 反向切换等）
    if (e.button !== 0) return;
    // 按钮（如右下角缩放按钮）正常响应点击，不进入拖拽逻辑
    if (e.target.closest('button')) return;
    // 涂鸦 / 迷雾工具
    if (boardTool) {
      const m = activeMap();
      if (m) {
        board.setPointerCapture(e.pointerId);
        const rect = board.getBoundingClientRect();
        const wx = (e.clientX - rect.left - m.cam.x) / m.cam.zoom;
        const wy = (e.clientY - rect.top - m.cam.y) / m.cam.zoom;
        if (boardTool === 'fog-reveal' || boardTool === 'fog-hide') {
          paintFogAt(e);
          drag = { mode: 'fog' };
        } else if (boardTool === 'doodle-select') {
          const s = doodleHitTest(wx, wy);
          selectedDoodleId = s ? s.id : null;
          renderDoodles();
          if (s) drag = { mode: 'doodle-move', id: s.id, startX: wx, startY: wy };
        } else if (boardTool === 'tile-paint') {
          board.setPointerCapture(e.pointerId);
          paintCellAt(e);
          drag = { mode: 'tile-paint' };
        } else {
          startDoodle(wx, wy);
          drag = { mode: 'doodle' };
        }
      }
      return;
    }
    const riderEl = e.target.closest('.rider');
    if (riderEl) {
      // 点骑手：选中骑手，但拖动时移动整匹坐骑
      const mountEl = riderEl.closest('.token');
      const mountId = mountEl ? mountEl.dataset.id : null;
      selectToken(riderEl.dataset.id);
      const mount = mountId ? findToken(mountId) : null;
      if (mount) {
        board.setPointerCapture(e.pointerId);
        drag = {
          mode: 'token', id: mountId, startX: e.clientX, startY: e.clientY,
          startWorldX: mount.x, startWorldY: mount.y,
          pathRecording: isCurrentTurnToken(mount), pathPoints: [{ x: mount.x, y: mount.y }],
        };
      }
      return;
    }
    const tokenEl = e.target.closest('.token');
    board.setPointerCapture(e.pointerId);
    if (tokenEl) {
      const id = tokenEl.dataset.id;
      const token = findToken(id);
      selectToken(id);
      drag = {
        mode: 'token', id, startX: e.clientX, startY: e.clientY,
        startWorldX: token?.x, startWorldY: token?.y,
        pathRecording: isCurrentTurnToken(token), pathPoints: token ? [{ x: token.x, y: token.y }] : [],
      };
    } else {
      const m = activeMap();
      drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, startCamX: m.cam.x, startCamY: m.cam.y };
      board.classList.add('panning');
    }
  });

  board.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'fog') {
      paintFogAt(e);
      return;
    }
    if (drag.mode === 'doodle') {
      const m = activeMap();
      if (m) {
        const rect = board.getBoundingClientRect();
        continueDoodle(
          (e.clientX - rect.left - m.cam.x) / m.cam.zoom,
          (e.clientY - rect.top - m.cam.y) / m.cam.zoom
        );
      }
      return;
    }
    if (drag.mode === 'tile-paint') {
      paintCellAt(e);
      return;
    }
    if (drag.mode === 'doodle-move') {
      const m = activeMap();
      const s = m && m.doodles.find((d) => d.id === drag.id);
      if (s) {
        const rect = board.getBoundingClientRect();
        const wx = (e.clientX - rect.left - m.cam.x) / m.cam.zoom;
        const wy = (e.clientY - rect.top - m.cam.y) / m.cam.zoom;
        translateDoodle(s, wx - drag.startX, wy - drag.startY);
        drag.startX = wx;
        drag.startY = wy;
        renderDoodles();
      }
      return;
    }
    if (drag.mode === 'pan') {
      const m = activeMap();
      m.cam.x = drag.startCamX + (e.clientX - drag.startX);
      m.cam.y = drag.startCamY + (e.clientY - drag.startY);
      applyCamera();
    } else {
      const rect = board.getBoundingClientRect();
      const m = activeMap();
      const x = (e.clientX - rect.left - m.cam.x) / m.cam.zoom;
      const y = (e.clientY - rect.top - m.cam.y) / m.cam.zoom;
      moveToken(drag.id, x, y, { persist: false });
      const token = findToken(drag.id);
      if (token && drag.pathRecording) {
        const last = drag.pathPoints[drag.pathPoints.length - 1];
        const threshold = state.snap ? .01 : Math.max(3, m.gridSize * .08);
        if (!last || Math.hypot(token.x - last.x, token.y - last.y) >= threshold) {
          drag.pathPoints.push({ x: token.x, y: token.y });
          if (drag.pathPoints.length > MAX_MOVE_POINTS) {
            drag.pathPoints = drag.pathPoints.slice(0, MAX_MOVE_POINTS - 1).concat(drag.pathPoints[drag.pathPoints.length - 1]);
          }
        }
        renderTurnPath(drag.pathPoints);
      }
    }
  });

  const endDrag = (e) => {
    if (drag && drag.mode === 'doodle-move') scheduleAutosave();
    if (drag && drag.mode === 'doodle') endDoodle();
    if (drag && drag.mode === 'token') {
      const m = activeMap();
      const token = findToken(drag.id);
      if (token) {
        if (drag.pathRecording && drag.pathPoints.length > 1) appendTurnPath(encounterState(), m?.id, token.id, drag.pathPoints);
        renderTurnPath();
        scheduleAutosave();
      }
    }
    const wasPan = drag && drag.mode === 'pan';
    const moved = drag ? Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5 : true;
    drag = null;
    board.classList.remove('panning');
    // 短点击（没有拖动）时，切换所点格子的样子
    if (wasPan && !moved && (!e || e.button === 0)) {
      const m = activeMap();
      if (m && m.cells) {
        const cell = pointerToCell(e);
        if (cell) cycleCell(cell.col, cell.row);
      }
    }
  };
  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);

  // 右键仍保留给地图格子的反向切换；棋子本身不再带规则状态。
  board.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tokenEl = e.target.closest('.token');
    if (tokenEl) {
      const t = findToken(tokenEl.dataset.id);
      if (t) selectToken(t.id);
      return;
    }
    const m = activeMap();
    if (m && m.cells) {
      const cell = pointerToCell(e);
      if (cell) cycleCell(cell.col, cell.row, -1);
    }
  });

  // 键盘
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && boardTool === 'doodle-select' && selectedDoodleId) {
      e.preventDefault();
      const m = activeMap();
      if (m) {
        m.doodles = m.doodles.filter((d) => d.id !== selectedDoodleId);
        selectedDoodleId = null;
        renderDoodles();
        scheduleAutosave();
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
      e.preventDefault();
      deleteToken(state.selectedId);
    }
    if (e.key === 'Escape') {
      state.selectedId = null;
      boardTool = null;
      selectedDoodleId = null;
      syncBoardTools();
      renderTokens();
      updateDetail();
    }
    // 快捷切换地图（楼层）
    if (state.maps.length > 1) {
      const idx = state.maps.findIndex((m) => m.id === state.activeMapId);
      if (e.key === ']' || e.key === 'PageDown') {
        e.preventDefault();
        switchMap(state.maps[(idx + 1) % state.maps.length].id);
      }
      if (e.key === '[' || e.key === 'PageUp') {
        e.preventDefault();
        switchMap(state.maps[(idx - 1 + state.maps.length) % state.maps.length].id);
      }
    }
  });

  // 放置单位
  $('#btn-place').addEventListener('click', placeToken);
  $('#token-icon').addEventListener('keydown', (e) => { if (e.key === 'Enter') placeToken(); });
  $('#token-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') placeToken(); });

  // 图标上传（放置面板）
  $('#btn-icon-upload').addEventListener('click', () => $('#file-icon').click());
  $('#file-icon').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    processAvatarFile(f, (res) => {
      if (!res) { toast('图标读取失败，请换一张图片'); return; }
      const id = 'a' + (uid++);
      storeAvatar(id, res.hd).then(() => {
        tokenAvatar = { iconImgId: id, iconImg: res.thumb, iconImgHd: res.display };
        $('#token-icon-preview').src = res.thumb;
        $('#token-icon-preview-row').hidden = false;
        toast('图标已就绪（高清），放置单位时生效');
      });
    });
  });
  $('#btn-icon-clear').addEventListener('click', () => {
    tokenAvatar = null;
    $('#token-icon-preview').src = '';
    $('#token-icon-preview-row').hidden = true;
  });

  // 图标上传（详情面板）
  $('#btn-detail-icon-upload').addEventListener('click', () => $('#file-detail-icon').click());
  $('#file-detail-icon').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !t) return;
    processAvatarFile(f, (res) => {
      if (!res) { toast('图标读取失败，请换一张图片'); return; }
      const id = 'a' + (uid++);
      storeAvatar(id, res.hd).then(() => {
        t.iconImgId = id;
        t.iconImg = res.thumb;
        t.iconImgHd = res.display;
        t.iconImgPath = null;
        renderTokens();
        updateDetail();
        scheduleAutosave();
        toast('图标已更新（高清）');
      });
    });
  });
  $('#btn-detail-icon-remove').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.iconImg = null;
    t.iconImgHd = null;
    t.iconImgPath = null;
    t.iconImgId = null;
    renderTokens();
    updateDetail();
    scheduleAutosave();
    toast('已移除图片图标');
  });

  // 详情
  $('#detail-name').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.name = e.target.value;
    // 手动改名后退出自动编号组，不再被自动重排覆盖
    t.groupKey = null;
    renumberTokens(activeMap());
    renderTokens();
    scheduleAutosave();
  });
  $('#detail-type-select').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.type = e.target.value;
    renderTokens();
    updateDetail();
    scheduleAutosave();
    toast('类型已改为：' + ((TYPE_META[t.type] || {}).label || t.type));
  });
  $('#detail-owner').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.owner = e.target.value.trim();
    updateDetail();
    scheduleAutosave();
    toast(t.owner ? `「${t.name}」现在归「${t.owner}」操作` : `「${t.name}」改回 GM 控制`);
  });
  $('#btn-detail-condition-add').addEventListener('click', addSelectedCondition);
  $('#detail-condition-turns').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSelectedCondition();
  });
  $('#detail-public-note').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.publicNote = e.target.value.slice(0, 240);
    scheduleAutosave();
  });
  $('#detail-gm-note').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.gmNote = e.target.value.slice(0, 500);
    scheduleAutosave(false);
  });
  $('#detail-hidden-players').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.hiddenFromPlayers = e.target.checked;
    if (currentTurnIncludesToken(t.id)) bumpEncounterTurn(encounterState());
    renderTokens();
    renderEncounter();
    updateDetail();
    scheduleAutosave();
    toast(t.hiddenFromPlayers ? `「${t.name}」已对玩家隐藏` : `「${t.name}」已对玩家显示`);
  });
  $('#detail-hp-current').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.hp = clamp(parseInt(e.target.value, 10) || 0, 0, 99999);
    updateDetail();
    renderTokens();
    scheduleAutosave();
  });
  $('#detail-hp-max').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.hpMax = Math.max(1, parseInt(e.target.value, 10) || 1);
    updateDetail();
    renderTokens();
    scheduleAutosave();
  });
  $('#detail-ac-input').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.ac = clamp(parseInt(e.target.value, 10) || 0, 0, 99);
    scheduleAutosave();
  });
  $('#detail-icon-input').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.icon = e.target.value.slice(0, 4);
    $('#detail-icon').textContent = t.icon || TYPE_META[t.type].defaultIcon;
    renderTokens();
    scheduleAutosave();
  });
  document.querySelectorAll('.hp-btns button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = state.selectedId && findToken(state.selectedId);
      if (!t) return;
      const v = btn.dataset.hp;
      if (v === 'full') t.hp = t.hpMax;
      else t.hp = clamp(t.hp + parseInt(v, 10), 0, t.hpMax);
      updateDetail();
      renderTokens();
      scheduleAutosave();
    });
  });
  $('#btn-detail-delete').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    if (confirm(`确定删除「${t.name}」？`)) deleteToken(t.id);
  });
  $('#btn-token-move').addEventListener('click', () => {
    if (!state.selectedId || !$('#detail-map-move').value) return;
    transferToken(state.selectedId, $('#detail-map-move').value, false);
  });
  $('#btn-token-copy').addEventListener('click', () => {
    if (!state.selectedId || !$('#detail-map-move').value) return;
    transferToken(state.selectedId, $('#detail-map-move').value, true);
  });

  // 棋子库
  $('#lib-search').addEventListener('input', (e) => { libSearch = e.target.value; renderLibrary(); });
  $('#lib-filter').addEventListener('change', (e) => { libFilter = e.target.value; renderLibrary(); });
  $('#lib-cat').addEventListener('change', (e) => { libCategory = e.target.value; renderLibrary(); });
  $('#btn-lib-add').addEventListener('click', () => openLibEditor('new'));
  $('#btn-lib-save').addEventListener('click', saveLibEditor);
  $('#btn-lib-cancel').addEventListener('click', closeLibEditor);
  $('#btn-lib-icon').addEventListener('click', () => $('#file-lib-icon').click());
  $('#file-lib-icon').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    processAvatarFile(f, (res) => {
      if (!res) { toast('图标读取失败'); return; }
      const id = 'a' + (uid++);
      storeAvatar(id, res.hd).then(() => {
        libAvatar = { iconImgId: id, iconImg: res.thumb, iconImgHd: res.display };
        syncLibIconPreview();
      });
    });
  });
  $('#btn-lib-icon-clear').addEventListener('click', () => {
    libAvatar = null;
    syncLibIconPreview();
  });
  $('#btn-save-to-lib').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    const portraitPath = canonicalPortraitPath(t.iconImgPath);
    state.library.push({
      id: 'l' + (uid++),
      name: t.name,
      type: t.type,
      category: '其他',
      icon: t.icon || '',
      iconImg: t.iconImg || null,
      iconImgHd: portraitPath ? null : (t.iconImgHd || null),
      iconImgPath: portraitPath,
      iconImgId: portraitPath ? null : (t.iconImgId || null),
      size: t.size || 1,
      hpMax: t.hpMax || 10,
      ac: typeof t.ac === 'number' ? t.ac : 10,
    });
    renderLibrary();
    saveLibrary();
    scheduleAutosave();
    toast(`「${t.name}」已存入棋子库`);
  });
  $('#btn-lib-sync').addEventListener('click', async () => {
    const synced = await syncLibraryWithFolder();
    if (synced) {
      toast('已从“存档”中的棋子库同步');
      return;
    }
    state.library = loadLibrary();
    renderLibrary();
    toast('未连接正式存档，已使用浏览器恢复缓存');
  });
  window.addEventListener('focus', async () => {
    // 已连接正式存档时，焦点切回也只从全局文件同步，避免旧浏览器缓存反向覆盖。
    if (await syncLibraryWithFolder()) return;
    const fresh = loadLibrary();
    if (JSON.stringify(fresh) !== JSON.stringify(state.library)) {
      state.library = fresh;
      renderLibrary();
      toast('棋子库已从浏览器恢复缓存同步');
    }
  });

  // 涂鸦与迷雾工具
  document.querySelectorAll('.board-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      boardTool = boardTool === t ? null : t;
      if (boardTool && boardTool.startsWith('doodle-')) {
        const sub = boardTool.slice(7);
        if (['pen', 'line', 'arrow', 'circle'].includes(sub)) doodleTool = sub;
      }
      syncBoardTools();
    });
  });
  document.querySelectorAll('.doodle-color').forEach((btn) => {
    btn.addEventListener('click', () => {
      doodleColor = btn.dataset.color;
      document.querySelectorAll('.doodle-color').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  $('#doodle-width').addEventListener('change', (e) => { doodleWidth = parseInt(e.target.value, 10) || 6; });
  $('#btn-doodle-undo').addEventListener('click', undoDoodle);
  $('#btn-doodle-clear').addEventListener('click', clearDoodles);
  $('#fog-brush').addEventListener('change', (e) => { fogBrush = parseInt(e.target.value, 10) || 3; });
  $('#btn-fog-hide-all').addEventListener('click', () => fogSetAll(true));
  $('#btn-fog-show-all').addEventListener('click', () => fogSetAll(false));

  // 先攻与时间条
  $('#btn-init-collapse').addEventListener('click', () => {
    const e = encounterState(); e.collapsed = !e.collapsed; renderEncounter(); scheduleAutosave(false);
  });
  document.querySelectorAll('[data-encounter-panel]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const e = encounterState();
      e.panel = tab.dataset.encounterPanel === 'time' ? 'time' : 'initiative';
      renderEncounter(); scheduleAutosave(false);
    });
  });
  document.querySelectorAll('[data-play-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const e = encounterState();
      const mode = button.dataset.playMode === 'turn' ? 'turn' : 'free';
      if (e.playMode === mode) return;
      e.playMode = mode;
      if (mode === 'turn') {
        const wasRunning = !!e.worldTime.runningSince;
        materializeWorldTime(e);
        e.worldTime.resumeAfterTurn = wasRunning;
        e.worldTime.runningSince = null;
        if (!e.currentEntryId) e.currentEntryId = e.entries[0]?.id || null;
      } else if (e.worldTime.resumeAfterTurn) {
        e.worldTime.runningSince = Date.now();
        e.worldTime.resumeAfterTurn = false;
      }
      bumpEncounterTurn(e);
      setEncounterEvent(e, mode === 'turn' ? '已切换为回合制' : '已切换为自由模式');
      renderEncounter(); scheduleAutosave();
    });
  });
  $('#btn-init-add').addEventListener('click', () => {
    const name = $('#init-name').value.trim();
    if (!name) { toast('请输入单位名称'); return; }
    const e = encounterState();
    const entry = addInitiativeEntry(e, { name, value: parseInt($('#init-value').value, 10) || 0 });
    if (e.playMode === 'turn' && !e.currentEntryId) e.currentEntryId = entry.id;
    $('#init-name').value = ''; $('#init-value').value = '';
    setEncounterEvent(e, `加入先攻单位：${entry.name}`);
    renderEncounter(); scheduleAutosave();
  });
  $('#btn-init-add-token').addEventListener('click', addActiveTokensToEncounter);
  $('#init-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btn-init-add').click(); });
  $('#init-value').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#btn-init-add').click(); });
  $('#btn-init-next').addEventListener('click', advanceEncounter);
  $('#btn-init-reset-round').addEventListener('click', resetEncounterRound);
  $('#btn-init-clear').addEventListener('click', () => {
    if (!confirm('清空当前先攻列表？')) return;
    const e = encounterState();
    e.entries = [];
    e.currentEntryId = null;
    e.round = 1;
    bumpEncounterTurn(e);
    setEncounterEvent(e, '先攻列表已清空');
    renderEncounter(); scheduleAutosave();
  });
  $('#btn-init-timer').addEventListener('click', setWorldClockRunning);
  $('#btn-time-short-rest').addEventListener('click', () => advanceWorldTime(60 * 60, '完成短休：世界时间 +1 小时'));
  $('#btn-time-long-rest').addEventListener('click', () => advanceWorldTime(8 * 60 * 60, '完成长休：世界时间 +8 小时'));
  $('#btn-time-apply').addEventListener('click', setWorldTimeFromInputs);
  ['time-year', 'time-week', 'time-day', 'time-clock'].forEach((id) => {
    $(`#${id}`).addEventListener('keydown', (event) => { if (event.key === 'Enter') setWorldTimeFromInputs(); });
  });
  $('#btn-time-reset').addEventListener('click', () => {
    const e = encounterState();
    e.worldTime.totalSeconds = 8 * 60 * 60;
    e.worldTime.runningSince = null;
    setEncounterEvent(e, '世界时间已重置');
    renderEncounter(); scheduleAutosave();
  });

  // 左侧卡片折叠/展开
  document.querySelectorAll('.card').forEach((card) => {
    const head = card.querySelector('h2') || card.querySelector('.card-head');
    if (!head) return;
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      card.classList.toggle('collapsed');
    });
  });

  // 骰子
  document.querySelectorAll('.die').forEach((btn) => {
    btn.addEventListener('click', () => doRoll(btn.dataset.die, 0));
  });
  $('#btn-roll').addEventListener('click', () => {
    const expr = $('#dice-expr').value.trim();
    if (!expr) return;
    doRoll(expr, 0);
    $('#dice-expr').value = '';
  });
  $('#dice-expr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-roll').click(); });

  // 顶栏下拉菜单
  const closeAllMenus = () => {
    document.querySelectorAll('.dropdown-menu').forEach((m) => { m.hidden = true; });
  };
  const handleAction = (action) => {
    switch (action) {
      case 'upload': $('#file-map').click(); break;
      case 'import-file': $('#file-map-import').click(); break;
      case 'load-folder': $('#file-map-folder').click(); break;
      case 'stitch': openStitchModal(); break;
      case 'new-map': {
        const m = addMap(`地图 ${state.maps.length + 1}`);
        toast(`已新建「${m.name}」，可以用上传/导入给它放上地图`);
        break;
      }
      case 'rename-map': {
        const m = activeMap();
        if (!m) break;
        const name = prompt('给这张地图起个名字（如：地下1层）', m.name);
        if (name === null || !name.trim()) break;
        m.name = name.trim();
        syncMapSelect();
        scheduleAutosave();
        break;
      }
      case 'delete-map': deleteActiveMap(); break;
      case 'save': saveNowWithFeedback(); break;
      case 'load': openCampaignModal(); break;
      case 'perf-diag': openPerfDiag(); break;
      case 'stream': toggleStream(); break;
      case 'stream-copy': copyStreamUrl(); break;
      case 'server-check': serverCheck(); break;
      case 'server-copy': copyServerCmd(); break;
      case 'server-url-apply': applyServerUrlSetting(); break;
      case 'stream-push': streamPushData(); break;
    }
  };
  document.querySelectorAll('.dropdown-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.dropdown-menu');
      const isOpen = !menu.hidden;
      closeAllMenus();
      if (!isOpen) menu.hidden = false;
    });
  });
  document.querySelectorAll('.dropdown-menu').forEach((menu) => {
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      closeAllMenus();
      handleAction(btn.dataset.action);
    });
  });
  document.addEventListener('click', closeAllMenus);
}

/* ==================== 放置单位 ==================== */

function placeToken() {
  const m = activeMap();
  if (!m) return;
  const name = $('#token-name').value.trim() || '无名氏';
  const type = $('#token-type').value;
  const hpMax = Math.max(1, parseInt($('#token-hp').value, 10) || 10);
  const ac = Math.max(0, parseInt($('#token-ac').value, 10) || 10);
  const icon = $('#token-icon').value.trim();
  const size = parseInt($('#token-size').value, 10) === 2 ? 2 : 1;

  const rect = board.getBoundingClientRect();
  const px = rect.left + rect.width / 2;
  const py = rect.top + rect.height / 2;
  const x = clamp((px - rect.left - m.cam.x) / m.cam.zoom, 0, m.mapW);
  const y = clamp((py - rect.top - m.cam.y) / m.cam.zoom, 0, m.mapH);
  const finalX = state.snap ? snapTokenCenter(x, m.gridSize, size) : x;
  const finalY = state.snap ? snapTokenCenter(y, m.gridSize, size) : y;
  const margin = size >= 2 ? m.gridSize : m.gridSize / 2;

  const token = {
    id: 't' + (uid++),
    name,
    type,
    icon,
    iconImg: tokenAvatar ? tokenAvatar.iconImg : null,
    iconImgHd: tokenAvatar ? tokenAvatar.iconImgHd : null,
    iconImgPath: tokenAvatar ? tokenAvatar.iconImgPath || null : null,
    iconImgId: tokenAvatar ? tokenAvatar.iconImgId : null,
    size,
    hpMax,
    hp: hpMax,
    ac,
    conditions: [],
    publicNote: '',
    gmNote: '',
    hiddenFromPlayers: false,
    x: clamp(finalX, margin, m.mapW - margin),
    y: clamp(finalY, margin, m.mapH - margin),
    owner: '',
    groupKey: splitGroupName(name).base,
  };
  m.tokens.push(token);
  renumberTokens(m);
  selectToken(token.id);
  scheduleAutosave();
  toast(`已放置「${name}」`);
}

/* ==================== 常用网站（左侧底部，可折叠） ==================== */

const LINKS_KEY = 'sangduoer-links-v1';
let userLinks = null;

function normalizeLink(link) {
  if (!link || typeof link !== 'object') return null;
  const name = String(link.name || '').trim().slice(0, 60);
  const url = String(link.url || '').trim();
  if (!name || !/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch (e) {
    return null;
  }
  return { id: String(link.id || 'link' + (uid++)), name, url: url.slice(0, 500) };
}

function loadLinks() {
  const saved = Array.isArray(state.sharedResources) ? state.sharedResources.map(normalizeLink).filter(Boolean) : [];
  if (saved.length) {
    userLinks = saved;
    return;
  }
  try {
    const raw = localStorage.getItem(LINKS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        userLinks = arr.map(normalizeLink).filter(Boolean);
        state.sharedResources = userLinks.map((link) => ({ ...link }));
      }
    }
  } catch (e) { /* 忽略 */ }
  if (!userLinks) {
    userLinks = [normalizeLink({ name: '5E 不全书', url: 'https://5echm.kagangtuya.top/' })].filter(Boolean);
    state.sharedResources = userLinks.map((link) => ({ ...link }));
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(state.sharedResources)); } catch (e) { /* 忽略 */ }
  }
}

function saveLinks() {
  userLinks = (userLinks || []).map(normalizeLink).filter(Boolean);
  state.sharedResources = userLinks.map((link) => ({ ...link }));
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(state.sharedResources)); } catch (e) { /* 忽略 */ }
  scheduleAutosave();
}

function renderLinks() {
  const box = $('#links-list');
  if (!box) return;
  box.innerHTML = '';
  (userLinks || []).forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'link-row';
    const a = document.createElement('a');
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = l.name;
    a.title = l.url;
    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '×';
    del.title = '删除';
    del.dataset.idx = i;
    row.append(a, del);
    box.appendChild(row);
  });
}

function renderSharedNotes() {
  const editor = $('#shared-note');
  if (editor && document.activeElement !== editor) editor.value = state.sharedNotes || '';
  const count = $('#shared-note-count');
  if (count) count.textContent = `${(state.sharedNotes || '').length}/4000`;
}

function updateSharedNotes(value) {
  state.sharedNotes = String(value || '').slice(0, 4000);
  renderSharedNotes();
  clearTimeout(sharedNoteTimer);
  sharedNoteTimer = setTimeout(() => scheduleAutosave(), 180);
}

function addLink(name, url) {
  const n = (name || '').trim();
  let u = (url || '').trim();
  if (!n || !u) { toast('请填写网站名称和网址'); return; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const link = normalizeLink({ name: n, url: u });
  if (!link) { toast('网址必须以 http:// 或 https:// 开头'); return; }
  userLinks.push(link);
  saveLinks();
  renderLinks();
  toast(`已添加「${n}」`);
}

/* ==================== BGM 音乐 ==================== */

let bgmDirHandle = null;
let bgmList = [];
let bgmIndex = -1;
let bgmServerUrl = null;
let bgmPlaying = false;
const bgmAudio = new Audio();
bgmAudio.loop = false;

function bgmAudioExt(name) {
  return /\.(mp3|m4a|wav|ogg|flac|aac|opus|webm)$/i.test(String(name || ''));
}

async function loadBgmDirHandle() {
  try { bgmDirHandle = await idbFilesGet('bgm-dir'); } catch (e) { bgmDirHandle = null; }
  updateBgmStatus();
  if (bgmDirHandle) scanBgmFolder();
}

async function bindBgmFolder() {
  if (!window.showDirectoryPicker) { toast('当前浏览器不支持文件夹绑定，请用 Chrome / Edge'); return; }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    await idbFilesSet('bgm-dir', handle);
    bgmDirHandle = handle;
    await scanBgmFolder();
    toast('✅ 已绑定音乐文件夹');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('绑定失败：' + (e.message || e));
  }
}

async function scanBgmFolder() {
  if (!bgmDirHandle) return;
  stopBgmAudio();
  bgmList = [];
  bgmIndex = -1;
  for await (const entry of bgmDirHandle.values()) {
    if (entry.kind === 'file' && bgmAudioExt(entry.name)) {
      bgmList.push({ name: entry.name, handle: entry });
    }
  }
  bgmList.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  renderBgmList();
  updateBgmStatus();
  toast(`音乐文件夹：找到 ${bgmList.length} 首`);
}

function pickBgmFiles(files) {
  stopBgmAudio();
  bgmList = [];
  bgmIndex = -1;
  [...files].forEach((f) => {
    if (bgmAudioExt(f.name)) bgmList.push({ name: f.name, url: URL.createObjectURL(f) });
  });
  bgmList.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  renderBgmList();
  updateBgmStatus();
  toast(`已加载 ${bgmList.length} 首音乐（本次会话有效）`);
}

function updateBgmStatus() {
  const el = $('#bgm-status');
  if (!el) return;
  el.textContent = bgmDirHandle ? '已绑定音乐文件夹 · ' + bgmList.length + ' 首' : '未绑定 · 可临时选择音乐';
}

function renderBgmList() {
  const box = $('#bgm-list');
  if (!box) return;
  box.innerHTML = '';
  if (!bgmList.length) {
    box.innerHTML = '<div class="hint" style="font-size:11px;">暂无音乐，绑定「音乐」文件夹或选择音乐文件</div>';
    return;
  }
  bgmList.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'bgm-item' + (i === bgmIndex ? ' current' : '');
    row.textContent = (i === bgmIndex ? '♪ ' : '') + it.name;
    row.title = '点击播放：' + it.name;
    row.addEventListener('click', () => playBgm(i));
    box.appendChild(row);
  });
}

async function playBgm(i) {
  if (i < 0 || i >= bgmList.length) return;
  bgmIndex = i;
  try {
    let url = bgmList[i].url;
    if (!url && bgmList[i].handle) {
      const file = await bgmList[i].handle.getFile();
      url = URL.createObjectURL(file);
      bgmList[i].url = url;
    }
    if (!url) return;
    bgmAudio.src = url;
    await bgmAudio.play();
    renderBgmList();
    $('#btn-bgm-play').textContent = '⏸';
    broadcastBgm('play');
  } catch (e) {
    toast('播放失败：' + (e.message || e));
  }
}

function stopBgmAudio() {
  bgmAudio.pause();
  bgmAudio.removeAttribute('src');
  bgmAudio.load();
  const btn = $('#btn-bgm-play');
  if (btn) btn.textContent = '▶';
  broadcastBgm('stop');
}

function toggleBgm() {
  if (!bgmList.length) { toast('先选择或绑定音乐'); return; }
  if (bgmAudio.paused) {
    if (!bgmAudio.src) {
      if (bgmIndex < 0) bgmIndex = 0;
      playBgm(bgmIndex);
      return;
    }
    bgmAudio.play();
    $('#btn-bgm-play').textContent = '⏸';
    broadcastBgm('play');
  } else {
    bgmAudio.pause();
    $('#btn-bgm-play').textContent = '▶';
    broadcastBgm('pause');
  }
}

function nextBgm() {
  if (!bgmList.length) return;
  bgmIndex = (bgmIndex + 1) % bgmList.length;
  playBgm(bgmIndex);
}

function prevBgm() {
  if (!bgmList.length) return;
  bgmIndex = (bgmIndex - 1 + bgmList.length) % bgmList.length;
  playBgm(bgmIndex);
}

async function ensureBgmServerUrl(i) {
  const it = bgmList[i];
  if (!it) return null;
  if (it.serverUrl) return it.serverUrl;
  try {
    let file = null;
    if (it.handle) file = await it.handle.getFile();
    else if (it.url) file = await (await fetch(it.url)).blob();
    if (!file) return null;
    const buf = await file.arrayBuffer();
    const res = await fetch(`${serverApiBase()}/api/music?name=` + encodeURIComponent(it.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const d = await res.json();
    if (d && d.ok) { it.serverUrl = d.url; return d.url; }
  } catch (e) { /* 上传失败不广播 */ }
  return null;
}

async function broadcastBgm(action) {
  if (!streamOn || bgmIndex < 0 || !bgmList[bgmIndex]) return;
  const url = await ensureBgmServerUrl(bgmIndex);
  if (!url) return;
  bgmServerUrl = url;
  bgmPlaying = action !== 'pause' && action !== 'stop';
  sendHostAction({
    op: 'bgm',
    action,
    track: bgmList[bgmIndex].name,
    url,
    time: Math.round(bgmAudio.currentTime || 0),
  }).then((result) => {
    if (!result.ok || result.data?.ok === false) toast('⚠ BGM 未广播');
  }).catch(() => toast('⚠ BGM 未广播'));
}

bgmAudio.addEventListener('ended', () => nextBgm());
try {
  const v = parseFloat(localStorage.getItem('sangduoer-bgm-volume'));
  if (!isNaN(v)) { bgmAudio.volume = v; $('#bgm-volume').value = v * 100; }
} catch (e) { /* 忽略 */ }
try { bgmAudio.loop = localStorage.getItem('sangduoer-bgm-loop') === '1'; } catch (e) { /* 忽略 */ }
const bgmLoopEl = $('#bgm-loop');
if (bgmLoopEl) bgmLoopEl.checked = bgmAudio.loop;
$('#btn-bgm-bind').addEventListener('click', bindBgmFolder);
$('#btn-bgm-pick').addEventListener('click', () => $('#file-bgm').click());
$('#file-bgm').addEventListener('change', (e) => {
  pickBgmFiles(e.target.files);
  e.target.value = '';
});
$('#btn-bgm-play').addEventListener('click', toggleBgm);
$('#btn-bgm-next').addEventListener('click', nextBgm);
$('#btn-bgm-prev').addEventListener('click', prevBgm);
$('#bgm-loop').addEventListener('change', (e) => {
  bgmAudio.loop = e.target.checked;
  try { localStorage.setItem('sangduoer-bgm-loop', e.target.checked ? '1' : '0'); } catch (err) { /* 忽略 */ }
  toast(e.target.checked ? '单曲循环：开（当前歌曲无限循环）' : '单曲循环：关（顺序播放，列表循环）');
});
$('#bgm-volume').addEventListener('input', (e) => {
  bgmAudio.volume = parseInt(e.target.value, 10) / 100;
  try { localStorage.setItem('sangduoer-bgm-volume', String(e.target.value)); } catch (err) { /* 忽略 */ }
});

/* ==================== 简易联机（主机推送观战） ==================== */

function tokenIsFullyFogged(m, token) {
  if (!state.fogOn || !m || !m.fog || !Object.keys(m.fog).length) return false;
  const grid = Number(m.gridSize) || 50;
  const size = token.size >= 2 ? 2 : 1;
  const col = Math.floor(Number(token.x || 0) / grid);
  const row = Math.floor(Number(token.y || 0) / grid);
  const startCol = size >= 2 ? col - 1 : col;
  const startRow = size >= 2 ? row - 1 : row;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m.fog[`${startCol + x},${startRow + y}`]) return false;
    }
  }
  return true;
}

function buildStreamPayload() {
  // 玩家只需要当前地图；其余楼层和棋子库不应占用联机带宽。
  const m = activeMap();
  const publicTokenEntries = [];
  const visibleTokenIds = new Set();
  if (m) {
    (m.tokens || []).forEach((token) => {
      if (token.hiddenFromPlayers || tokenIsFullyFogged(m, token)) return;
      const friendly = token.type === 'pc' || token.type === 'ally';
      const publicToken = {
        id: token.id,
        name: token.name,
        type: token.type,
        icon: token.icon,
        iconImg: token.iconImg,
        iconImgHd: token.iconImgHd,
        iconImgPath: token.iconImgPath,
        size: token.size,
        x: token.x,
        y: token.y,
        owner: token.owner,
        mountId: token.mountId || null,
        conditions: (token.conditions || []).filter((condition) => condition.visibility !== 'gm').map((condition) => ({ ...condition })),
        publicNote: token.publicNote || '',
      };
      if (friendly) {
        publicToken.hp = token.hp;
        publicToken.hpMax = token.hpMax;
        publicToken.ac = token.ac;
      }
      publicTokenEntries.push(publicToken);
      visibleTokenIds.add(token.id);
    });
  }
  const visibleTokenSet = new Set(publicTokenEntries.map((token) => token.id));
  publicTokenEntries.forEach((token) => {
    if (!token.mountId || !visibleTokenSet.has(token.mountId)) delete token.mountId;
  });
  const publicMap = m ? {
    id: m.id,
    name: m.name,
    mapData: m.mapData || null,
    mapW: m.mapW,
    mapH: m.mapH,
    gridSize: m.gridSize,
    doodles: Array.isArray(m.doodles) ? m.doodles.map((stroke) => ({ ...stroke })) : [],
    fog: m.fog && typeof m.fog === 'object' ? { ...m.fog } : {},
    tokens: publicTokenEntries,
  } : null;
  const p = {
    maps: publicMap ? [publicMap] : [],
    activeMapId: state.activeMapId,
    snap: state.snap,
    showGrid: state.showGrid,
    showNames: state.showNames,
    fogOn: state.fogOn,
    campaignName: state.campaignName,
    sharedResources: (userLinks || []).map((link) => ({ ...link })),
    sharedNotes: String(state.sharedNotes || '').slice(0, 4000),
    encounter: publicEncounterState(visibleTokenIds),
  };
  // 兼容尚未更新的观战页面；新页面使用 sharedResources。
  p._links = p.sharedResources.map((l) => ({ name: l.name, url: l.url }));
  if (bgmServerUrl && bgmIndex >= 0 && bgmList[bgmIndex]) {
    p._bgm = {
      action: bgmPlaying ? 'play' : 'pause',
      track: bgmList[bgmIndex].name,
      url: bgmServerUrl,
      time: Math.round(bgmAudio.currentTime || 0),
    };
  }
  p._streamSeq = streamAppliedSeq;
  return p;
}

// 玩家动作到达主机：服务器已立即广播，不再回声式发送整张状态。
function applyRemoteAction(a) {
  if (!a) return;
  if (a.op === 'endTurn') {
    const e = encounterState();
    if (Number(e.turnSerial) !== Number(a.turnSerial)) return;
    e.currentEntryId = a.nextEntryId || e.currentEntryId;
    e.round = Math.max(1, Number(a.round) || e.round);
    e.turnSerial = Math.max(1, Number(a.nextTurnSerial) || (e.turnSerial + 1));
    e.turnPath = emptyTurnPath();
    materializeWorldTime(e);
    if (Number.isFinite(Number(a.worldTimeSeconds))) e.worldTime.totalSeconds = Math.max(0, Math.trunc(Number(a.worldTimeSeconds)));
    e.worldTime.runningSince = null;
    setEncounterEvent(e, `玩家结束回合：${initiativeEntryLabel(currentInitiativeEntry(e))}`);
    renderEncounter();
    renderTokens();
    renderTurnPath();
    scheduleAutosave(false);
    return;
  }
  if (a.op === 'roll') {
    if (a.rid && hostLocalRolls.has(a.rid)) {
      hostLocalRolls.delete(a.rid);
      return;
    }
    // 玩家掷骰：进主控台骰子记录，并弹提示
    const who = a.name || '玩家';
    playDiceFx(a.sides || 20, a.expr || '', a.total, { dice: a.dice, pick: a.pick, mode: a.mode });
    addLogLine(`${who} · ${a.expr || ''}`, a.detail || '', a.total);
    toast(`🎲 ${who} 掷出 ${a.total}（${a.expr || ''}）`);
    return;
  }
  if (a.op === 'announce') {
    toast(`📣 ${a.text || 'GM 发布了一条公告'}`);
    return;
  }
  if (a.op === 'doodle') {
    // 玩家涂鸦：直接合并进当前地图，并随下次推送同步给所有人
    const mm = (state.maps || []).find((x) => x.id === (a.mapId || state.activeMapId));
    if (mm && Array.isArray(a.doodles)) {
      mm.doodles = a.doodles.map((s) => ({ ...s }));
      renderDoodles();
      scheduleAutosave(false);
    }
    return;
  }
  const m = (state.maps || []).find((x) => x.id === (a.mapId || state.activeMapId));
  if (!m || !a || !a.tokenId) return;
  const t = m.tokens.find((x) => x.id === a.tokenId);
  if (!t) return;
  if (a.op === 'moveToken') {
    const grid = m.gridSize || 50;
    const margin = t.size >= 2 ? grid : grid / 2;
    t.x = clamp(a.x, margin, m.mapW - margin);
    t.y = clamp(a.y, margin, m.mapH - margin);
    if (t.size >= 2) syncRiderData(t);
    const el = world.querySelector(`.token[data-id="${t.id}"]`);
    if (el) {
      el.style.left = t.x + 'px';
      el.style.top = t.y + 'px';
    }
    syncLabelsFor(t);
    const e = encounterState();
    if (e.playMode === 'turn' && Number(a.turnSerial) === e.turnSerial && Array.isArray(a.path)) {
      appendTurnPath(e, m.id, t.id, a.path);
      renderTurnPath();
    }
    if (state.selectedId === t.id) updateDetail();
  } else if (a.op === 'patchToken') {
    const p = a.patch || {};
    const allowed = ['hp', 'hpMax', 'ac'];
    allowed.forEach((k) => { if (k in p) t[k] = p[k]; });
    normalizeSheet(t);
    renderTokens();
    if (state.selectedId === t.id) updateDetail();
  }
  scheduleAutosave(false);
}

async function mergePlayerStateFromServer() {
  try {
    const res = await fetch(`${serverApiBase()}/api/state`);
    if (!res.ok) return;
    const s = await res.json();
    if (!s || !Array.isArray(s.maps)) return;
    // 只把「玩家名下的棋子」的服务器最新状态合并回主机，不覆盖 GM 自己改的东西
    const remote = {};
    s.maps.forEach((m) => (m.tokens || []).forEach((t) => { remote[t.id] = t; }));
    let changed = false;
    (state.maps || []).forEach((m) => (m.tokens || []).forEach((t) => {
      const rs = remote[t.id];
      if (rs && (rs.owner || '').trim()) {
        t.x = rs.x;
        t.y = rs.y;
        ['hp', 'hpMax', 'ac'].forEach((k) => {
          if (k in rs) t[k] = rs[k];
        });
        if (t.size >= 2) syncRiderData(t);
        changed = true;
      }
    }));
    if (changed) {
      renderTokens();
      scheduleAutosave(false);
    }
    if (s.encounter && typeof s.encounter === 'object') {
      const localEncounter = encounterState();
      const remoteEncounter = normalizeEncounter(s.encounter);
      const localPathLength = localEncounter.turnPath?.points?.length || 0;
      const remotePathLength = remoteEncounter.turnPath?.points?.length || 0;
      if (remoteEncounter.turnSerial > localEncounter.turnSerial
        || (remoteEncounter.turnSerial === localEncounter.turnSerial && remotePathLength > localPathLength)) {
        state.encounter = remoteEncounter;
        renderEncounter();
        changed = true;
      }
    }
    if (changed) renderTurnPath();
  } catch (e) { /* 服务器暂不可用，SSE 重连后会自动再拉 */ }
}

function startStreamClient() {
  if (streamES) {
    try { streamES.close(); } catch (e) { /* 忽略 */ }
  }
  streamES = new EventSource(`${serverApiBase()}/api/events`);
  streamES.onopen = () => { mergePlayerStateFromServer(); };
  streamES.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'action') {
        if (ev.action && (ev.action.op === 'roll' || ev.action.op === 'doodle')) {
          applyRemoteAction(ev.action);
          return;
        }
        const seq = ev.seq || 0;
        if (seq > streamAppliedSeq) {
          streamAppliedSeq = seq;
          applyRemoteAction(ev.action);
        }
      }
    } catch (err) { /* 忽略坏数据 */ }
  };
  streamES.onerror = () => { /* EventSource 会自动重连 */ };
}

async function streamPush() {
  if (!streamOn || streamPushing) return;
  streamPushing = true;
  try {
    const res = await fetch(`${serverApiBase()}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildStreamPayload()),
    });
    if (!res.ok) throw new Error('bad');
    streamLastPushAt = Date.now();
  } catch (e) {
    // 失败后约 1.5 秒重试一次，不关闭联机
    streamLastPushAt = Date.now() - 1200;
    const now = Date.now();
    if (now - streamFailToastAt > 15000) {
      streamFailToastAt = now;
      toast('📡 服务器未连接：请双击项目里的「启动桑哆尔」一键启动（会自动重试）');
    }
  } finally {
    streamPushing = false;
  }
}

function streamTick() {
  if (!streamOn) return;
  const now = Date.now();
  // SSE 自身每 10 秒已有极小 ping；不再空闲时重复推送完整状态。
  if (!streamDirty) return;
  if (now - streamLastPushAt < 300) return;
  streamDirty = false;
  streamPush();
}

function updateStreamUi() {
  const toggleBtn = $('#btn-stream-toggle');
  if (toggleBtn) toggleBtn.textContent = streamOn ? '⛔ 关闭玩家模式' : '📡 开启玩家模式（主机推送）';
  const dd = $('#btn-stream-dd');
  if (dd) dd.textContent = streamOn ? '📡 联机已开 ▾' : '📡 联机 ▾';
  const netInfo = $('#net-info');
  const netPlayerList = $('#net-player-list');
  if (netInfo) {
    if (!streamInfo) {
      netInfo.textContent = '尚未连接服务器';
      if (netPlayerList) netPlayerList.textContent = '';
    }
    else netInfo.textContent = `房间码：${streamInfo.roomCode || '—'}\n在线玩家：${streamInfo.playerCount || 0}\n服务器：${serverApiBase()}\n玩家入口：${playerViewerUrl()}`;
  }
  updateServerUrlUi();
}

async function refreshStreamPlayers() {
  if (!streamOn) return;
  try {
    const res = await fetch(`${serverApiBase()}/api/players`);
    if (!res.ok) return;
    const data = await res.json();
    const list = $('#net-player-list');
    if (list) {
      streamPlayers = Array.isArray(data.players) ? data.players : [];
      list.innerHTML = '';
      streamPlayers.forEach((player) => {
        const row = document.createElement('div');
        row.className = `net-player-row${player.online ? ' online' : ''}`;
        row.textContent = `${player.online ? '●' : '○'} ${player.name || '未命名玩家'} · ${player.online ? (player.status === 'ready' ? '已准备' : '在线') : '离线'}`;
        list.appendChild(row);
      });
      if (!list.children.length) list.textContent = '暂无玩家加入';
      if (state.selectedId) updateDetail();
    }
    const onlineCount = (data.players || []).filter((player) => player.online).length;
    if (streamInfo) streamInfo = { ...streamInfo, playerCount: onlineCount };
    updateStreamUi();
  } catch (e) { /* 服务器断开时由主状态推送逻辑提示 */ }
}

async function copyStreamUrl() {
  if (!streamOn || !streamInfo) {
    toast('请先开启玩家模式');
    return;
  }
  const url = playerViewerUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('已复制玩家观看地址：' + url);
  } catch (e) {
    toast('玩家观看地址：' + url);
  }
}

// 检测服务器是否在线
async function serverCheck() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${serverApiBase()}/api/info`, { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    const oldInfo = streamInfo;
    streamInfo = { ...(oldInfo || {}), ip: (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost', port: info.port || 8090, roomCode: info.roomCode || '', playerCount: info.playerCount || 0 };
    toast(`✅ 服务器在线：玩家打开 ${playerViewerUrl()}`);
    if (!oldInfo) streamInfo = null;
  } catch (e) {
    toast('❌ 服务器未启动：请双击项目里的「启动桑哆尔」一键启动');
  }
}

// 复制启动命令（Windows / macOS 自动识别）
async function copyServerCmd() {
  const isWin = /Windows/i.test(navigator.userAgent);
  const cmd = isWin ? 'py -3 start_server.py' : 'python3 start_server.py';
  try {
    await navigator.clipboard.writeText(cmd);
    toast('已复制启动命令：' + cmd);
  } catch (e) {
    toast('启动命令：' + cmd);
  }
}

// 手动「更新数据」：先拉取玩家端最新改动，再立即推送
async function streamPushData() {
  if (!streamOn) { toast('请先开启玩家模式'); return; }
  await mergePlayerStateFromServer();
  streamPush();
  toast('🔄 已推送最新数据');
}

async function toggleStream() {
  if (streamOn) {
    streamOn = false;
    clearInterval(streamTimer);
    clearInterval(streamPlayersTimer);
    if (streamES) { streamES.close(); streamES = null; }
    try { localStorage.removeItem('sangduoer-stream-on'); } catch (e) { /* 忽略 */ }
    streamInfo = null;
    updateStreamUi();
    toast('📡 玩家模式已关闭');
    return;
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${serverApiBase()}/api/info`, { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    streamOn = true;
    try { localStorage.setItem('sangduoer-stream-on', '1'); } catch (e) { /* 忽略 */ }
    clearInterval(streamTimer);
    streamTimer = setInterval(streamTick, 250);
    clearInterval(streamPlayersTimer);
    streamPlayersTimer = setInterval(refreshStreamPlayers, 5000);
    startStreamClient();
    streamPush();
    const ip = (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost';
    streamInfo = { ip, port: info.port || 8090, roomCode: info.roomCode || '', playerCount: info.playerCount || 0 };
    updateStreamUi();
    refreshStreamPlayers();
    const room = info.roomCode ? `?room=${encodeURIComponent(info.roomCode)}` : '';
    toast(`📡 玩家模式已开启：改动最快约0.3秒推送，玩家打开 http://${ip}:${info.port || 8090}/主控台/玩家.html${room}`);
  } catch (e) {
    toast('📡 服务器未启动：请双击项目里的「启动桑哆尔」一键启动，再点一次开启');
  }
}

async function restoreStreamFromStorage() {
  let shouldRestore = false;
  try { shouldRestore = localStorage.getItem('sangduoer-stream-on') === '1'; } catch (e) { /* 忽略 */ }
  if (!shouldRestore || streamOn) return;
  streamOn = true;
  clearInterval(streamTimer);
  startStreamClient();
  await mergePlayerStateFromServer();
  streamTimer = setInterval(streamTick, 250);
  clearInterval(streamPlayersTimer);
  streamPlayersTimer = setInterval(refreshStreamPlayers, 5000);
  streamPush();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${serverApiBase()}/api/info`, { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    const ip = (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost';
    streamInfo = { ip, port: info.port || 8090, roomCode: info.roomCode || '', playerCount: info.playerCount || 0 };
    updateStreamUi();
    refreshStreamPlayers();
    const room = info.roomCode ? `?room=${encodeURIComponent(info.roomCode)}` : '';
    toast(`📡 已自动恢复玩家模式：玩家打开 http://${ip}:${info.port || 8090}/主控台/玩家.html${room}`);
  } catch (e) {
    updateStreamUi();
    toast('📡 已自动恢复玩家模式：正在等待联机服务器启动，启动后会自动推送');
  }
}

/* ==================== 性能诊断 ==================== */

let perfFpsTimer = null;
let perfLast = 0;
let perfFrames = 0;

function openPerfDiag() {
  const m = activeMap();
  const fog = $('#fog-canvas');
  const doodle = $('#doodle-canvas');
  let renderer = '未知';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      if (e) renderer = gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
    }
  } catch (err) { /* 忽略 */ }
  $('#perf-stats').textContent =
    `棋子数：${activeTokens().length} ｜ 名字标签：${document.querySelectorAll('#names-layer .token-name-label').length}\n` +
    `地图：${m ? m.mapW + '×' + m.mapH : '-'} ｜ 迷雾画布：${fog ? fog.width + '×' + fog.height : '-'} ｜ 涂鸦画布：${doodle ? doodle.width + '×' + doodle.height : '-'} ｜ 缩放：${m ? m.cam.zoom.toFixed(2) : '-'}\n` +
    `屏幕 DPR：${window.devicePixelRatio || 1} ｜ 渲染器：${renderer}\n` +
    `版本：${APP_VERSION}`;
  $('#perf-result').textContent = '';
  $('#perf-modal').hidden = false;
  perfLast = performance.now();
  perfFrames = 0;
  clearInterval(perfFpsTimer);
  perfFpsTimer = setInterval(() => {
    const now = performance.now();
    const fps = Math.round((perfFrames * 1000) / Math.max(1, now - perfLast));
    $('#perf-fps-num').textContent = fps;
    perfFrames = 0;
    perfLast = now;
  }, 500);
}

function closePerfDiag() {
  clearInterval(perfFpsTimer);
  const m = $('#perf-modal');
  if (m) m.hidden = true;
}

$('#btn-perf-run').addEventListener('click', () => {
  const m = activeMap();
  if (!m) return;
  $('#btn-perf-run').disabled = true;
  let long = 0;
  let maxLong = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { long++; maxLong = Math.max(maxLong, e.duration); }
  });
  try { obs.observe({ entryTypes: ['longtask'] }); } catch (e) { /* 忽略 */ }
  const t0 = performance.now();
  let frames = 0;
  let dir = 1;
  const iv = setInterval(() => {
    m.cam.x += 4 * dir;
    m.cam.y += 2 * dir;
    if (Math.abs(m.cam.x) > 250) dir = -dir;
    applyCamera();
  }, 0);
  const tick = () => {
    frames++;
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    else {
      clearInterval(iv);
      try { obs.disconnect(); } catch (e) { /* 忽略 */ }
      const dur = performance.now() - t0;
      const avg = dur / frames;
      const target = 16.67;
      $('#perf-result').textContent =
        `3 秒自动拖测：\n实际帧数 ${frames}（理想约 ${Math.round(dur / target)}）\n平均帧间隔 ${avg.toFixed(2)}ms（约 ${Math.round((target / avg) * 100)}% 速度）\n长任务 ${long} 次（最长 ${maxLong.toFixed(0)}ms）`;
      $('#btn-perf-run').disabled = false;
    }
  };
  requestAnimationFrame(tick);
});
$('#btn-perf-close').addEventListener('click', closePerfDiag);
$('#perf-modal').addEventListener('click', (e) => {
  if (e.target === $('#perf-modal')) closePerfDiag();
});

/* ==================== 棋子库 ==================== */

function canonicalPortraitPath(value) {
  return value ? String(value).replace('立绘/NPC/短团-烬鳞讨伐/', '立绘/NPC/短团·烬鳞讨伐/') : null;
}

function normalizeLibPreset(p) {
  // 棋子库与地图单位保持同一套极简字段。
  const portraitPath = canonicalPortraitPath(p.iconImgPath);
  const isPathBacked = !!portraitPath;
  return {
    id: p.id || 'l' + (uid++),
    name: p.name || '未命名',
    type: ['pc', 'enemy', 'npc', 'ally'].includes(p.type) ? p.type : 'npc',
    category: (p.category || '').trim() || '其他',
    icon: p.icon || '',
    // 已有项目原图时不再把缩略图和 IndexedDB id 重复写进正式棋子库。
    iconImg: isPathBacked ? null : (p.iconImg || null),
    iconImgHd: isPathBacked ? null : (p.iconImgHd || null),
    iconImgPath: portraitPath,
    iconImgId: isPathBacked ? null : (p.iconImgId || null),
    size: p.size === 2 ? 2 : 1,
    hpMax: Math.max(1, parseInt(p.hpMax, 10) || 10),
    ac: Math.max(0, Math.min(99, Number.isFinite(parseInt(p.ac, 10)) ? parseInt(p.ac, 10) : 10)),
  };
}

/* ============ 全局棋子库保存到“存档”文件夹 ============ */

const FILE_DB = 'dnd-board-files';
let libFileTimer = null;

function idbOpenFiles() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbFilesGet(key) {
  return idbOpenFiles().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const r = tx.objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function idbFilesSet(key, value) {
  return idbOpenFiles().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* ==================== “存档”文件夹（唯一正式存档） ==================== */

const SAVE_HANDLE_KEY = 'save-root-dir-v2';
const SAVE_ROOT_DIR = '存档';
const SAVE_CAMPAIGN_DIR = '战役';
const SAVE_LIBRARY_DIR = '棋子库';
const SAVE_LIBRARY_FILE = SAVE_LIBRARY_DIR + '/棋子库.json';
const SAVE_INDEX_FILE = '存档索引.json';
let projectDirHandle = null; // 兼容旧变量名：现在始终代表用户选中的“存档”文件夹本身。
let campaignRecordsCache = null;

async function loadProjectDirHandle() {
  try {
    projectDirHandle = await idbFilesGet(SAVE_HANDLE_KEY);
  } catch (e) {
    projectDirHandle = null;
  }
  campaignRecordsCache = null;
  return projectDirHandle;
}

async function hasSaveFolderPermission() {
  if (!projectDirHandle) return false;
  try { return await projectDirHandle.queryPermission({ mode: 'readwrite' }) === 'granted'; }
  catch (e) { return false; }
}

async function ensureSaveFolderAccess(requestPermission = false) {
  if (!projectDirHandle) {
    if (!requestPermission) return false;
    return bindProjectFolder();
  }
  try {
    let permission = await projectDirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted' && requestPermission) {
      permission = await projectDirHandle.requestPermission({ mode: 'readwrite' });
    }
    if (permission !== 'granted') {
      updateSaveStatus('“存档”文件夹待授权', 'error');
      if (requestPermission) toast('请重新授权存档文件夹');
      return false;
    }
    await ensureSaveFolderStructure();
    return true;
  } catch (e) {
    updateSaveStatus('“存档”文件夹不可用', 'error');
    return false;
  }
}

async function bindProjectFolder() {
  if (!window.showDirectoryPicker) {
    toast('当前浏览器不支持文件夹存档，请在主机上使用 Chrome / Edge');
    return false;
  }
  try {
    alert('请选择项目根目录中名为“存档”的文件夹。\n\n程序会直接使用该文件夹，不会再额外创建嵌套目录。');
    const handle = await window.showDirectoryPicker({ id: 'sangduoer-save-root-v2', mode: 'readwrite' });
    if (handle.name !== SAVE_ROOT_DIR) {
      toast('请选择名称正好为“存档”的文件夹');
      return false;
    }
    projectDirHandle = handle;
    campaignRecordsCache = null;
    await idbFilesSet(SAVE_HANDLE_KEY, handle);
    await ensureSaveFolderStructure();
    const migrated = await migrateLegacyCampaigns();
    await syncLibraryWithFolder();
    await restoreFolderIfAvailable();
    if (state.campaignId && !(await campaignGet(state.campaignId))) await campaignPut(state.campaignId, state.campaignName, folderSaveSnapshot(), { backup: false });
    updateSaveStatus('存档文件夹已连接', 'ok');
    toast(`✅ 已连接“存档”文件夹${migrated ? `；已迁移 ${migrated} 个旧战役` : ''}`);
    return true;
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('连接“存档”文件夹失败：' + (e.message || e));
    return false;
  }
}

async function getDirHandle(root, relPath, create = true) {
  let cur = root;
  for (const part of relPath.split('/')) {
    if (!part) continue;
    cur = create ? await cur.getDirectoryHandle(part, { create: true }) : await cur.getDirectoryHandle(part);
  }
  return cur;
}

async function ensureSaveFolderStructure() {
  if (!projectDirHandle) return false;
  await getDirHandle(projectDirHandle, SAVE_CAMPAIGN_DIR);
  await getDirHandle(projectDirHandle, SAVE_LIBRARY_DIR);
  return true;
}

async function readBoundText(relPath) {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return null;
  try {
    const idx = relPath.lastIndexOf('/');
    const dirPath = idx >= 0 ? relPath.slice(0, idx) : '';
    const name = idx >= 0 ? relPath.slice(idx + 1) : relPath;
    const dir = dirPath ? await getDirHandle(projectDirHandle, dirPath, false) : projectDirHandle;
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return await file.text();
  } catch (e) {
    return null;
  }
}

async function listBoundEntries(relPath, kind) {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return [];
  try {
    const dir = relPath ? await getDirHandle(projectDirHandle, relPath, false) : projectDirHandle;
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== kind) continue;
      if (kind === 'file') {
        const file = await handle.getFile();
        out.push({ name, lastModified: file.lastModified, size: file.size });
      } else {
        out.push({ name });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function listBoundDirs(relPath) {
  return (await listBoundEntries(relPath, 'directory')).map((entry) => entry.name);
}

async function listBoundFiles(relPath) {
  return listBoundEntries(relPath, 'file');
}

async function writeBoundText(relPath, text) {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return false;
  try {
    const idx = relPath.lastIndexOf('/');
    const dirPath = idx >= 0 ? relPath.slice(0, idx) : '';
    const name = idx >= 0 ? relPath.slice(idx + 1) : relPath;
    const dir = dirPath ? await getDirHandle(projectDirHandle, dirPath) : projectDirHandle;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return true;
  } catch (e) {
    console.warn('写项目文件失败', e);
    return false;
  }
}

async function deleteBoundEntry(relPath, recursive = false) {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return false;
  try {
    const idx = relPath.lastIndexOf('/');
    const dirPath = idx >= 0 ? relPath.slice(0, idx) : '';
    const name = idx >= 0 ? relPath.slice(idx + 1) : relPath;
    const dir = dirPath ? await getDirHandle(projectDirHandle, dirPath, false) : projectDirHandle;
    await dir.removeEntry(name, { recursive });
    return true;
  } catch (e) {
    return false;
  }
}

function safeCampaignFolderName(name) {
  return String(name || '未命名战役').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名战役';
}

function safeCampaignId(id) {
  return String(id || 'default').replace(/[^\w\-]/g, '').slice(0, 80) || 'default';
}

function campaignFolderName(id, name) {
  return `${safeCampaignId(id)}-${safeCampaignFolderName(name)}`;
}

function parseCampaignFile(text, folderName = '') {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (data && data.state && Array.isArray(data.state.maps)) {
      const id = data.campaignId || data.state.campaignId || folderName || 'default';
      const name = data.campaignName || data.name || data.state.campaignName || folderName || '默认战役';
      return { id, name, savedAt: Number(data.savedAt) || 0, state: data.state };
    }
    if (data && Array.isArray(data.maps)) {
      return {
        id: data.campaignId || folderName || 'default',
        name: data.campaignName || folderName || '默认战役',
        savedAt: Number(data.savedAt) || 0,
        state: data,
      };
    }
  } catch (e) { /* 损坏文件由调用方忽略 */ }
  return null;
}

function campaignPackage(id, name, snapshot, savedAt = Date.now()) {
  const stateCopy = JSON.parse(JSON.stringify(snapshot));
  stateCopy.campaignId = id;
  stateCopy.campaignName = name;
  delete stateCopy.library;
  return {
    format: 'sangduoer-campaign',
    schemaVersion: 4,
    savedAt,
    campaignId: id,
    campaignName: name,
    state: stateCopy,
  };
}

async function readCampaignRecords(force = false) {
  if (!force && Array.isArray(campaignRecordsCache)) return campaignRecordsCache.slice();
  const folders = await listBoundDirs(SAVE_CAMPAIGN_DIR);
  const byId = new Map();
  for (const folderName of folders) {
    const path = `${SAVE_CAMPAIGN_DIR}/${folderName}/当前存档.json`;
    const parsed = parseCampaignFile(await readBoundText(path), folderName);
    if (!parsed) continue;
    const record = { ...parsed, _folderName: folderName, _path: path };
    const previous = byId.get(record.id);
    if (!previous || record.savedAt >= previous.savedAt) byId.set(record.id, record);
  }
  campaignRecordsCache = [...byId.values()].sort((a, b) => b.savedAt - a.savedAt);
  return campaignRecordsCache.slice();
}

async function trimAutomaticBackups(folderName) {
  const dir = `${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份`;
  const files = (await listBoundFiles(dir)).filter((item) => item.name.endsWith('.json'));
  files.sort((a, b) => b.lastModified - a.lastModified);
  for (const old of files.slice(10)) await deleteBoundEntry(`${dir}/${old.name}`);
}

async function copyCampaignHistory(sourceFolder, targetFolder) {
  if (!sourceFolder || sourceFolder === targetFolder) return;
  for (const dirName of ['自动备份']) {
    const sourceDir = `${SAVE_CAMPAIGN_DIR}/${sourceFolder}/${dirName}`;
    const targetDir = `${SAVE_CAMPAIGN_DIR}/${targetFolder}/${dirName}`;
    const files = (await listBoundFiles(sourceDir)).filter((item) => item.name.endsWith('.json'));
    for (const file of files) {
      const text = await readBoundText(`${sourceDir}/${file.name}`);
      if (text) await writeBoundText(`${targetDir}/${file.name}`, text);
    }
  }
}

async function writeSaveIndex(records) {
  const campaigns = Array.isArray(records) ? records : await readCampaignRecords();
  const data = {
    format: 'sangduoer-save-index',
    schemaVersion: 2,
    updatedAt: Date.now(),
    campaigns: campaigns.map((item) => ({
      id: item.id,
      name: item.name,
      savedAt: item.savedAt,
      folder: item._folderName,
    })),
  };
  await writeBoundText(SAVE_INDEX_FILE, JSON.stringify(data, null, 2));
}

async function writeCampaignRecord(id, name, snapshot, options = {}) {
  if (!(await ensureSaveFolderAccess(false))) throw new Error('save folder unavailable');
  const cleanId = safeCampaignId(id);
  const cleanName = String(name || '未命名战役').trim().slice(0, 120) || '未命名战役';
  const existing = await campaignGet(cleanId);
  const folderName = campaignFolderName(cleanId, cleanName);
  const currentPath = `${SAVE_CAMPAIGN_DIR}/${folderName}/当前存档.json`;
  const previousText = existing ? await readBoundText(existing._path) : await readBoundText(currentPath);
  const savedAt = Number(options.savedAt) || Date.now();
  if (options.backup === true && previousText) {
    await writeBoundText(`${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份/${savedAt}.json`, previousText);
  }
  const packageData = campaignPackage(cleanId, cleanName, snapshot, savedAt);
  if (!(await writeBoundText(currentPath, JSON.stringify(packageData, null, 2)))) throw new Error('write failed');
  if (existing && existing._folderName !== folderName) {
    await copyCampaignHistory(existing._folderName, folderName);
    await deleteBoundEntry(`${SAVE_CAMPAIGN_DIR}/${existing._folderName}`, true);
  }
  await trimAutomaticBackups(folderName);
  const record = { id: cleanId, name: cleanName, savedAt, state: packageData.state, _folderName: folderName, _path: currentPath };
  campaignRecordsCache = [record, ...(campaignRecordsCache || []).filter((item) => item.id !== cleanId)]
    .sort((a, b) => b.savedAt - a.savedAt);
  await writeSaveIndex(campaignRecordsCache);
  return record;
}

async function writeRecoverySnapshot(label, snapshot) {
  if (!(await ensureSaveFolderAccess(false))) throw new Error('save folder unavailable');
  if (!state.campaignId) throw new Error('temporary campaign');
  const record = await campaignGet(state.campaignId);
  const folderName = record?._folderName || campaignFolderName(state.campaignId, state.campaignName);
  const savedAt = Date.now();
  const packageData = campaignPackage(state.campaignId, state.campaignName || '未命名战役', snapshot, savedAt);
  const fileName = `${safeCampaignFolderName(label)}-${savedAt}.json`;
  const ok = await writeBoundText(`${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份/${fileName}`, JSON.stringify(packageData, null, 2));
  if (!ok) throw new Error('write failed');
  await trimAutomaticBackups(folderName);
  return true;
}

async function migrateLegacyCampaigns() {
  const existingIds = new Set((await readCampaignRecords(true)).map((item) => item.id));
  const candidates = new Map();
  let legacy = [];
  try { legacy = await legacyCampaignList(); } catch (e) { /* 旧库不存在 */ }
  legacy.forEach((item) => {
    if (!item?.id || !item.state || !Array.isArray(item.state.maps) || existingIds.has(item.id)) return;
    const candidate = {
      id: item.id,
      name: item.name || item.state.campaignName || '迁移战役',
      savedAt: Number(item.savedAt) || 0,
      state: item.state,
    };
    const previous = candidates.get(candidate.id);
    if (!previous || candidate.savedAt > previous.savedAt) candidates.set(candidate.id, candidate);
  });
  let migrated = 0;
  for (const item of candidates.values()) {
    await writeCampaignRecord(item.id, item.name, item.state, { backup: false, savedAt: item.savedAt || Date.now() });
    migrated++;
  }
  return migrated;
}

function libraryPackage(list, savedAt = Date.now()) {
  return {
    format: 'sangduoer-library',
    schemaVersion: 1,
    savedAt,
    presets: (list || []).map(normalizeLibPreset),
  };
}

async function readLibraryFile() {
  const text = await readBoundText(SAVE_LIBRARY_FILE);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (!data || data.format !== 'sangduoer-library' || !Array.isArray(data.presets)) return null;
    return {
      savedAt: Number(data.savedAt) || 0,
      presets: data.presets.map(normalizeLibPreset),
    };
  } catch (e) {
    return null;
  }
}

async function writeLibraryFile(list, savedAt) {
  if (!projectDirHandle) return 'unset';
  if (!(await hasSaveFolderPermission())) return 'denied';
  try {
    const stamp = Number(savedAt) || Number(localStorage.getItem(LIBRARY_SAVED_AT_KEY)) || Date.now();
    const ok = await writeBoundText(SAVE_LIBRARY_FILE, JSON.stringify(libraryPackage(list, stamp), null, 2));
    return ok ? 'ok' : 'error';
  } catch (e) {
    console.warn('写入棋子库文件失败', e);
    return 'error';
  }
}

function setLibraryCache(list, savedAt) {
  const data = (list || []).map(normalizeLibPreset);
  state.library = data;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
    localStorage.setItem(LIBRARY_SAVED_AT_KEY, String(Number(savedAt) || Date.now()));
  } catch (e) { /* 浏览器缓存失败时仍保留本次会话 */ }
  return data;
}

async function syncLibraryWithFolder() {
  if (!projectDirHandle || !(await hasSaveFolderPermission())) {
    updateLibPersistStatus('unset');
    return false;
  }
  const disk = await readLibraryFile();
  let local = loadLibrary();
  let localSavedAt = Number(localStorage.getItem(LIBRARY_SAVED_AT_KEY)) || 0;
  if (disk) {
    // 绑定文件夹后，磁盘中的全局库是唯一正式来源。浏览器缓存仅用于文件缺失时的首次迁移，
    // 不能在重新连接或切换存档目录时反向覆盖另一份正式棋子库。
    setLibraryCache(disk.presets, disk.savedAt || Date.now());
  } else {
    if (!local.length) {
      const legacyCampaign = (await readCampaignRecords(true)).find((record) => Array.isArray(record.state?.library) && record.state.library.length);
      if (legacyCampaign) {
        local = legacyCampaign.state.library.map(normalizeLibPreset);
        localSavedAt = Number(legacyCampaign.savedAt) || Date.now();
        setLibraryCache(local, localSavedAt);
      }
    }
    if (!localSavedAt) {
      localSavedAt = Date.now();
      setLibraryCache(local, localSavedAt);
    }
    const result = await writeLibraryFile(local, localSavedAt);
    if (result !== 'ok') {
      updateLibPersistStatus(result);
      return false;
    }
  }
  if ($('#lib-list')) renderLibrary();
  updateLibPersistStatus('ok');
  return true;
}

function scheduleLibraryFileWrite() {
  clearTimeout(libFileTimer);
  libFileTimer = setTimeout(async () => {
    const list = typeof presets !== 'undefined' ? presets : state.library;
    const result = await writeLibraryFile(list);
    updateLibPersistStatus(result);
  }, 400);
}

function updateLibPersistStatus(st) {
  const el = $('#lib-persist-status') || $('#persist-status');
  if (!el) return;
  if (st === 'ok') { el.textContent = '已保存到“存档”'; el.classList.add('on'); }
  else if (st === 'denied') { el.textContent = '“存档”文件夹待授权'; el.classList.remove('on'); }
  else if (st === 'error') { el.textContent = '棋子库写入失败'; el.classList.remove('on'); }
  else { el.textContent = '随“存档”文件夹保存'; el.classList.remove('on'); }
}

async function initLibPersistStatus() {
  updateLibPersistStatus(projectDirHandle && await hasSaveFolderPermission() ? 'ok' : 'unset');
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr) && arr.length) return arr.map(normalizeLibPreset);
  } catch (e) { /* 损坏则回退到文件 */ }
  if (BUNDLED_LIBRARY.length) {
    const arr = BUNDLED_LIBRARY.map(normalizeLibPreset);
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
    return arr;
  }
  return [];
}

function saveLibrary(list) {
  const data = (list || state.library).map(normalizeLibPreset);
  state.library = data;
  const savedAt = Date.now();
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
    localStorage.setItem(LIBRARY_SAVED_AT_KEY, String(savedAt));
  } catch (e) {
    toast('⚠ 棋子库保存失败：浏览器存储空间不足');
  }
  scheduleLibraryFileWrite();
}

function renderLibrary() {
  const box = $('#lib-list');
  box.innerHTML = '';
  // 分类下拉框（两级树：一级=生物类型，二级=族群）
  const catSel = $('#lib-cat');
  const prevCat = catSel.value;
  const usedL1 = [];
  state.library.forEach((p) => {
    const n = catParts(p.category || '其他')[0] || '其他';
    if (!usedL1.includes(n)) usedL1.push(n);
  });
  const l1Order = [...Object.keys(LIB_CATEGORY_TREE), ...usedL1.filter((n) => !(n in LIB_CATEGORY_TREE))];
  let opts = '<option value="all">全部分类</option>';
  l1Order.forEach((l1) => {
    const l1Count = state.library.filter((p) => (catParts(p.category || '其他')[0] || '其他') === l1).length;
    if (!l1Count) return;
    opts += `<option value="${esc(l1)}">${esc(l1)} · 全部（${l1Count}）</option>`;
    const l2s = [...new Set(state.library
      .map((p) => catParts(p.category || '其他'))
      .filter((x) => x[0] === l1 && x[1])
      .map((x) => x[1]))].sort((a, b) => a.localeCompare(b, 'zh'));
    if (l2s.length) {
      opts += `<optgroup label="${esc(l1)}">` +
        l2s.map((l2) => `<option value="${esc(l1 + '/' + l2)}">　${esc(l2)}</option>`).join('') +
        '</optgroup>';
    }
  });
  catSel.innerHTML = opts;
  const allVals = [...catSel.options].map((o) => o.value);
  if (allVals.includes(prevCat)) catSel.value = prevCat;
  else catSel.value = 'all';
  libCategory = catSel.value;

  const q = libSearch.trim().toLowerCase();
  const items = state.library.filter((p) =>
    (libFilter === 'all' || p.type === libFilter) &&
    (libCategory === 'all' || (p.category || '其他') === libCategory || String(p.category || '').startsWith(libCategory + '/')) &&
    (!q || p.name.toLowerCase().includes(q)));
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'lib-empty';
    d.textContent = state.library.length ? '没有匹配的棋子' : '棋子库还是空的，点「新建预设」添加';
    box.appendChild(d);
    return;
  }
  items.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'lib-row';
    const meta = TYPE_META[p.type] || TYPE_META.npc;

    const thumb = document.createElement('span');
    thumb.className = 'lib-thumb';
    thumb.style.setProperty('--ring', meta.ring);
    if (p.iconImg || p.iconImgHd || p.iconImgPath || p.iconImgId) {
      thumb.style.backgroundSize = 'cover';
      thumb.style.backgroundPosition = 'center';
      applyAvatar(thumb, p.iconImg, p.iconImgId, p.iconImgHd, p.iconImgPath);
    } else {
      thumb.textContent = p.icon || meta.defaultIcon;
    }

    const info = document.createElement('div');
    info.className = 'lib-info';
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = `${p.name}${p.size === 2 ? '（2×2）' : ''}`;

    const catTag = document.createElement('span');
    catTag.className = 'lib-cat';
    catTag.textContent = `${p.category || '其他'} · HP ${p.hpMax || 10} · AC ${typeof p.ac === 'number' ? p.ac : 10}`;
    info.append(name, catTag);

    const place = document.createElement('button');
    place.className = 'small primary';
    place.textContent = '放到地图';
    place.addEventListener('click', () => placePresetOnMap(p.id));

    const edit = document.createElement('button');
    edit.className = 'small';
    edit.textContent = '✎';
    edit.title = '编辑';
    edit.addEventListener('click', () => openLibEditor(p.id));

    const del = document.createElement('button');
    del.className = 'small danger';
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', () => {
      if (!confirm(`删除预设「${p.name}」？`)) return;
      state.library = state.library.filter((x) => x.id !== p.id);
      if (libEditorId === p.id) closeLibEditor();
      renderLibrary();
      saveLibrary();
      scheduleAutosave();
    });

    row.append(thumb, info, place, edit, del);
    box.appendChild(row);
  });
}

function placePresetOnMap(id) {
  const m = activeMap();
  const p = state.library.find((x) => x.id === id);
  if (!m || !p) return;
  const portraitPath = canonicalPortraitPath(p.iconImgPath);
  const rect = board.getBoundingClientRect();
  const px = rect.left + rect.width / 2;
  const py = rect.top + rect.height / 2;
  const x = clamp((px - rect.left - m.cam.x) / m.cam.zoom, 0, m.mapW);
  const y = clamp((py - rect.top - m.cam.y) / m.cam.zoom, 0, m.mapH);
  const finalX = state.snap ? snapTokenCenter(x, m.gridSize, p.size) : x;
  const finalY = state.snap ? snapTokenCenter(y, m.gridSize, p.size) : y;
  const margin = p.size >= 2 ? m.gridSize : m.gridSize / 2;
  const token = {
    id: 't' + (uid++),
    name: p.name,
    type: p.type,
    icon: p.icon,
    iconImg: p.iconImg,
    iconImgHd: portraitPath ? null : (p.iconImgHd || null),
    iconImgPath: portraitPath,
    iconImgId: portraitPath ? null : (p.iconImgId || null),
    size: p.size,
    hpMax: p.hpMax,
    hp: p.hpMax,
    ac: typeof p.ac === 'number' ? p.ac : 10,
    x: clamp(finalX, margin, m.mapW - margin),
    y: clamp(finalY, margin, m.mapH - margin),
    owner: '',
    groupKey: p.name,
  };
  normalizeSheet(token);
  m.tokens.push(token);
  renumberTokens(m);
  selectToken(token.id);
  scheduleAutosave();
  toast(`已放置「${p.name}」`);
}

let libEdCatPrev = '';

function libCat1Values() {
  const set = new Set(Object.keys(LIB_CATEGORY_TREE));
  state.library.forEach((p) => { const n = catParts(p.category || '其他')[0] || '其他'; if (n) set.add(n); });
  return [...set];
}

function libCat2Values(cat1) {
  const set = new Set(LIB_CATEGORY_TREE[cat1] || []);
  state.library.forEach((p) => {
    const parts = catParts(p.category || '其他');
    if (parts[0] === cat1 && parts[1]) set.add(parts[1]);
  });
  return [...set];
}

function populateLibCatSelects() {
  const c1 = $('#lib-cat1');
  const c2 = $('#lib-cat2');
  c1.innerHTML = '';
  libCat1Values().forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    c1.appendChild(o);
  });
  c1.onchange = () => { libEdCatPrev = ''; fillLibCat2(); };
  fillLibCat2();
}

function fillLibCat2(prev) {
  const c1 = $('#lib-cat1');
  const c2 = $('#lib-cat2');
  if (typeof prev === 'string') libEdCatPrev = prev;
  const parts = catParts(libEdCatPrev);
  c2.innerHTML = '<option value="">（无二级）</option>';
  libCat2Values(c1.value).forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    c2.appendChild(o);
  });
  if (parts[0] === c1.value && parts[1] && [...c2.options].some((o) => o.value === parts[1])) c2.value = parts[1];
}

function readLibCatSelects() {
  const c1 = $('#lib-cat1').value;
  const c2 = $('#lib-cat2').value;
  return c1 ? (c2 ? c1 + '/' + c2 : c1) : '其他';
}

function openLibEditor(id) {
  libEditorId = id;
  libAvatar = null;
  $('#lib-editor').hidden = false;
  populateLibCatSelects();
  const p = id === 'new' ? null : state.library.find((x) => x.id === id);
  if (id === 'new') {
    $('#lib-name').value = '';
    $('#lib-type').value = 'enemy';
    $('#lib-hp').value = 10;
    $('#lib-ac').value = 10;
    $('#lib-size').value = '1';
    $('#lib-icon').value = '';
    libEdCatPrev = '';
    $('#lib-cat1').value = '其他';
    fillLibCat2();
  } else {
    if (!p) { closeLibEditor(); return; }
    $('#lib-name').value = p.name;
    $('#lib-type').value = p.type;
    $('#lib-hp').value = p.hpMax;
    $('#lib-ac').value = typeof p.ac === 'number' ? p.ac : 10;
    $('#lib-size').value = String(p.size);
    $('#lib-icon').value = p.icon || '';
    const editPath = canonicalPortraitPath(p.iconImgPath);
    libAvatar = p.iconImg || p.iconImgHd || editPath || p.iconImgId
      ? { iconImgId: p.iconImgId || null, iconImg: p.iconImg || null, iconImgHd: editPath ? null : (p.iconImgHd || null), iconImgPath: editPath }
      : null;
    const parts = catParts(p.category || '其他');
    if (parts[0] && [...$('#lib-cat1').options].some((o) => o.value === parts[0])) $('#lib-cat1').value = parts[0];
    fillLibCat2(p.category);
  }
  syncLibIconPreview();
  renderLibrary();
}

function closeLibEditor() {
  libEditorId = null;
  libAvatar = null;
  $('#lib-editor').hidden = true;
  syncLibIconPreview();
  renderLibrary();
}

function syncLibIconPreview() {
  if (libAvatar && (libAvatar.iconImg || libAvatar.iconImgHd || libAvatar.iconImgPath)) {
    $('#lib-icon-preview').src = libAvatar.iconImgPath ? portraitAssetUrl(libAvatar.iconImgPath) : (libAvatar.iconImgHd || libAvatar.iconImg);
    $('#lib-icon-preview-row').hidden = false;
    if (libAvatar.iconImgPath) return;
    if (libAvatar.iconImgId) {
      const cached = avatarCache.get(libAvatar.iconImgId);
      if (cached) {
        $('#lib-icon-preview').src = cached;
      } else {
        avatarGetDisplay(libAvatar.iconImgId).then((disp) => {
          if (disp) $('#lib-icon-preview').src = disp;
        }).catch(() => {});
      }
    }
  } else {
    $('#lib-icon-preview').src = '';
    $('#lib-icon-preview-row').hidden = true;
  }
}

function saveLibEditor() {
  const name = $('#lib-name').value.trim() || '未命名';
  const preset = {
    id: libEditorId === 'new' ? 'l' + (uid++) : libEditorId,
    name,
    type: $('#lib-type').value,
    category: readLibCatSelects(),
    icon: $('#lib-icon').value.trim(),
    iconImg: libAvatar ? libAvatar.iconImg : null,
    iconImgHd: libAvatar ? libAvatar.iconImgHd : null,
    iconImgPath: libAvatar ? libAvatar.iconImgPath || null : null,
    iconImgId: libAvatar ? libAvatar.iconImgId : null,
    size: parseInt($('#lib-size').value, 10) === 2 ? 2 : 1,
    hpMax: Math.max(1, parseInt($('#lib-hp').value, 10) || 10),
    ac: Math.max(0, parseInt($('#lib-ac').value, 10) || 10),
  };
  if (libEditorId === 'new') {
    state.library.push(preset);
  } else {
    const idx = state.library.findIndex((x) => x.id === libEditorId);
    if (idx >= 0) state.library[idx] = preset;
  }
  closeLibEditor();
  saveLibrary();
  scheduleAutosave();
  toast(`已保存「${name}」`);
}

/* ==================== 格子交互 ==================== */

function pointerToCell(e) {
  const m = activeMap();
  if (!m) return null;
  const rect = board.getBoundingClientRect();
  const wx = (e.clientX - rect.left - m.cam.x) / m.cam.zoom;
  const wy = (e.clientY - rect.top - m.cam.y) / m.cam.zoom;
  const col = Math.floor(wx / m.gridSize);
  const row = Math.floor(wy / m.gridSize);
  const maxCol = Math.floor(m.mapW / m.gridSize);
  const maxRow = Math.floor(m.mapH / m.gridSize);
  if (col < 0 || row < 0 || col >= maxCol || row >= maxRow) return null;
  return { col, row };
}

// 点击格子切换该格子的样子（门：关→开→锁；其他：默认↔标记）
function cycleCell(col, row, dir = 1) {
  const m = activeMap();
  if (!m || !m.cells) return;
  const tile = m.cells[row] && m.cells[row][col];
  if (!tile) return;
  const key = `${col},${row}`;
  // 标记模式：任意格子都可加/去黄色框
  if (state.markMode) {
    if (m.cellStates[key] === 'marked') delete m.cellStates[key];
    else m.cellStates[key] = 'marked';
    m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize, m.cellVariants);
    updateWorldBackground();
    scheduleAutosave();
    toast(m.cellStates[key] === 'marked' ? '已标记该格子' : '已取消标记');
    return;
  }
  const defs = cellStateDefs(tile);
  if (!defs || !defs.length) return; // 没有多状态的格子点击不变化
  const cur = m.cellStates[key] || defs[0].key;
  const idx = defs.findIndex((d) => d.key === cur);
  const next = defs[(idx + dir + defs.length) % defs.length];
  m.cellStates[key] = next.key;
  m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize, m.cellVariants);
  updateWorldBackground();
  scheduleAutosave();
  const def = INTERACT_TYPES[tile];
  toast(`${def ? def.name : '格子'}：${next.label}`);
}

/* ==================== 轻便地图编辑 ==================== */

function editableMap() {
  const m = activeMap();
  if (!m) return null;
  if (!Array.isArray(m.cells) || !m.cells.length) {
    toast('这张地图是图片地图，请到「地图工坊」重画后导出');
    return null;
  }
  return m;
}

function paintCellAt(e) {
  const m = editableMap();
  if (!m) return;
  const cell = pointerToCell(e);
  if (!cell) return;
  const { col, row } = cell;
  const key = `${col},${row}`;
  const isErase = editTile === 'void';
  // 清除 = 只还原编辑器涂过的格子：回到原始底图（没涂过的格子不动，不破坏原地图）
  const target = isErase
    ? ((m.baseCells && m.baseCells[row] && typeof m.baseCells[row][col] === 'string') ? m.baseCells[row][col] : 'void')
    : editTile;
  const currentVariant = normalizeMaterialVariant(m.cells[row][col], (m.cellVariants || {})[key]);
  const targetVariant = isErase
    ? normalizeMaterialVariant(target, (m.baseCellVariants || {})[key])
    : normalizeMaterialVariant(target, editVariant);
  const hasState = Object.prototype.hasOwnProperty.call(m.cellStates || {}, key);
  if (m.cells[row][col] === target && currentVariant === targetVariant) {
    // 同一地块也允许切换材质样式；只有样式和状态均未变化时才跳过。
    if ((!isErase && !hasState) || (isErase && cellMatchesBase(m, col, row))) return;
  }
  mapEditHistory.push({
    id: m.id,
    col,
    row,
    old: m.cells[row][col],
    oldState: Object.prototype.hasOwnProperty.call(m.cellStates || {}, key) ? m.cellStates[key] : undefined,
    oldVariant: Object.prototype.hasOwnProperty.call(m.cellVariants || {}, key) ? m.cellVariants[key] : undefined,
  });
  if (mapEditHistory.length > 200) mapEditHistory.shift();
  m.cells[row][col] = target;
  if (isErase) {
    restoreCellState(m, col, row);
    restoreCellVariant(m, col, row);
  } else {
    delete (m.cellStates || {})[key];
    setCellVariant(m, key, target, editVariant);
  }
  m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize, m.cellVariants);
  updateWorldBackground();
  scheduleAutosave();
}

function cellMatchesBase(m, col, row) {
  const key = `${col},${row}`;
  const cur = m.cellStates || {};
  const base = m.baseCellStates || {};
  const curHas = Object.prototype.hasOwnProperty.call(cur, key);
  const baseHas = Object.prototype.hasOwnProperty.call(base, key);
  const tile = m.cells[row] && m.cells[row][col];
  const currentVariant = normalizeMaterialVariant(tile, (m.cellVariants || {})[key]);
  const baseVariant = normalizeMaterialVariant(tile, (m.baseCellVariants || {})[key]);
  return curHas === baseHas && (!curHas || cur[key] === base[key]) && currentVariant === baseVariant;
}

function restoreCellState(m, col, row) {
  const key = `${col},${row}`;
  const bs = m.baseCellStates || {};
  if (Object.prototype.hasOwnProperty.call(bs, key)) {
    if (!m.cellStates) m.cellStates = {};
    m.cellStates[key] = bs[key];
  } else {
    delete (m.cellStates || {})[key];
  }
}

function setCellVariant(m, key, tile, variant) {
  const normalized = normalizeMaterialVariant(tile, variant);
  if (normalized === null) {
    delete (m.cellVariants || {})[key];
    return;
  }
  if (!m.cellVariants) m.cellVariants = {};
  m.cellVariants[key] = normalized;
}

function restoreCellVariant(m, col, row) {
  const key = `${col},${row}`;
  const tile = m.cells[row] && m.cells[row][col];
  setCellVariant(m, key, tile, (m.baseCellVariants || {})[key]);
}

function mapPaintUndo() {
  const m = activeMap();
  if (!m) return;
  while (mapEditHistory.length) {
    const h = mapEditHistory.pop();
    if (h.id !== m.id) continue;
    m.cells[h.row][h.col] = h.old;
    const key = `${h.col},${h.row}`;
    if (h.oldState !== undefined) {
      if (!m.cellStates) m.cellStates = {};
      m.cellStates[key] = h.oldState;
    } else {
      delete (m.cellStates || {})[key];
    }
    if (h.oldVariant !== undefined) {
      if (!m.cellVariants) m.cellVariants = {};
      m.cellVariants[key] = h.oldVariant;
    } else {
      delete (m.cellVariants || {})[key];
    }
    m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize, m.cellVariants);
    updateWorldBackground();
    scheduleAutosave();
    toast('已撤销一步');
    return;
  }
  toast('没有可撤销的修改');
}

function buildEditPalettes() {
  const tileBox = $('#map-edit-tiles');
  tileBox.innerHTML = '';
  EDIT_GROUPS.forEach((group) => {
    const head = document.createElement('div');
    head.className = 'tile-group-head';
    head.textContent = group.name;
    tileBox.appendChild(head);
    const row = document.createElement('div');
    row.className = 'tile-row';
    group.tiles.flatMap(editTileOptions).forEach((option) => {
      const { id, variant, label: optionLabel } = option;
      const b = document.createElement('button');
      b.className = 'tile-btn';
      b.dataset.tile = id;
      b.dataset.variant = variant ?? '';
      b.title = optionLabel;
      const cv = document.createElement('canvas');
      cv.width = 40;
      cv.height = 40;
      drawCell(cv.getContext('2d'), 2, 2, 36, id, null, { variant });
      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = option.label;
      b.append(cv, label);
      b.addEventListener('click', () => {
        if (editTile === id && editVariant === variant && boardTool === 'tile-paint') boardTool = null;
        else { editTile = id; editVariant = variant; boardTool = 'tile-paint'; }
        syncBoardTools();
      });
      row.appendChild(b);
    });
    tileBox.appendChild(row);
  });
}

function syncPalettes() {
  document.querySelectorAll('#map-edit-tiles .tile-btn').forEach((b) => {
    const variant = b.dataset.variant === '' ? null : Number(b.dataset.variant);
    b.classList.toggle('active', boardTool === 'tile-paint' && b.dataset.tile === editTile && variant === editVariant);
  });
}

/* ==================== 战术涂鸦 ==================== */

function doodleCtx() {
  return $('#doodle-canvas').getContext('2d');
}

function drawDoodleStroke(g, s) {
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (s.id === selectedDoodleId) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = s.width + 6;
    g.globalAlpha = 0.45;
    if (s.tool === 'pen') {
      g.beginPath();
      g.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) g.lineTo(s.points[i].x, s.points[i].y);
      g.stroke();
    } else if (s.tool === 'line' || s.tool === 'arrow') {
      g.beginPath();
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke();
    } else if (s.tool === 'circle') {
      g.beginPath();
      g.arc(s.x0, s.y0, Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = s.color;
    g.lineWidth = s.width;
  }
  if (s.tool === 'pen') {
    if (s.points.length < 2) return;
    g.beginPath();
    g.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) g.lineTo(s.points[i].x, s.points[i].y);
    g.stroke();
  } else if (s.tool === 'line' || s.tool === 'arrow') {
    g.beginPath();
    g.moveTo(s.x0, s.y0);
    g.lineTo(s.x1, s.y1);
    g.stroke();
    if (s.tool === 'arrow') {
      const a = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
      const h = Math.max(10, s.width * 2.2);
      g.beginPath();
      g.moveTo(s.x1, s.y1);
      g.lineTo(s.x1 - h * Math.cos(a - Math.PI / 6), s.y1 - h * Math.sin(a - Math.PI / 6));
      g.lineTo(s.x1 - h * Math.cos(a + Math.PI / 6), s.y1 - h * Math.sin(a + Math.PI / 6));
      g.closePath();
      g.fill();
    }
  } else if (s.tool === 'circle') {
    const r = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    g.beginPath();
    g.arc(s.x0, s.y0, r, 0, Math.PI * 2);
    g.globalAlpha = 0.15;
    g.fill();
    g.globalAlpha = 1;
    g.stroke();
  }
}

function renderDoodles() {
  const g = doodleCtx();
  g.clearRect(0, 0, $('#doodle-canvas').width, $('#doodle-canvas').height);
  const m = activeMap();
  if (!m) return;
  m.doodles.forEach((s) => drawDoodleStroke(g, s));
  if (doodleDraft) drawDoodleStroke(g, doodleDraft);
}

function startDoodle(wx, wy) {
  if (doodleTool === 'pen') {
    doodleDraft = { tool: 'pen', color: doodleColor, width: doodleWidth, points: [{ x: wx, y: wy }] };
  } else {
    doodleDraft = { tool: doodleTool, color: doodleColor, width: doodleWidth, x0: wx, y0: wy, x1: wx, y1: wy };
  }
  renderDoodles();
}

function continueDoodle(wx, wy) {
  if (!doodleDraft) return;
  if (doodleDraft.tool === 'pen') {
    const last = doodleDraft.points[doodleDraft.points.length - 1];
    const dx = wx - last.x, dy = wy - last.y;
    const dist = Math.hypot(dx, dy);
    const step = 6;
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      doodleDraft.points.push({ x: last.x + dx * i / n, y: last.y + dy * i / n });
    }
  } else {
    doodleDraft.x1 = wx;
    doodleDraft.y1 = wy;
  }
  renderDoodles();
}

function endDoodle() {
  if (!doodleDraft) return;
  const m = activeMap();
  if (m) {
    const isPen = doodleDraft.tool === 'pen';
    const tooShort = !isPen && Math.hypot(doodleDraft.x1 - doodleDraft.x0, doodleDraft.y1 - doodleDraft.y0) <= 4;
    if ((isPen && doodleDraft.points.length >= 2) || (!isPen && !tooShort)) {
      doodleDraft.id = 'd' + (uid++);
      m.doodles.push(doodleDraft);
    }
    scheduleAutosave();
  }
  doodleDraft = null;
  renderDoodles();
}

function undoDoodle() {
  const m = activeMap();
  if (!m || !m.doodles.length) return;
  m.doodles.pop();
  renderDoodles();
  scheduleAutosave();
}

function clearDoodles() {
  const m = activeMap();
  if (!m || !m.doodles.length) return;
  m.doodles = [];
  renderDoodles();
  scheduleAutosave();
  toast('已清除涂鸦');
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function doodleHitTest(wx, wy) {
  const m = activeMap();
  if (!m) return null;
  for (let i = m.doodles.length - 1; i >= 0; i--) {
    const s = m.doodles[i];
    const tol = Math.max(10, s.width + 6);
    if (s.tool === 'pen') {
      for (let j = 1; j < s.points.length; j++) {
        if (distToSegment(wx, wy, s.points[j - 1], s.points[j]) <= tol) return s;
      }
    } else if (s.tool === 'line' || s.tool === 'arrow') {
      if (distToSegment(wx, wy, { x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }) <= tol) return s;
    } else if (s.tool === 'circle') {
      const r = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      if (Math.abs(Math.hypot(wx - s.x0, wy - s.y0) - r) <= tol) return s;
    }
  }
  return null;
}

function translateDoodle(s, dx, dy) {
  if (s.tool === 'pen') {
    s.points.forEach((p) => { p.x += dx; p.y += dy; });
  } else {
    s.x0 += dx; s.y0 += dy;
    s.x1 += dx; s.y1 += dy;
  }
}

/* ==================== 迷雾 ==================== */

function fogCtx() {
  return $('#fog-canvas').getContext('2d');
}

function renderFog() {
  const g = fogCtx();
  g.clearRect(0, 0, $('#fog-canvas').width, $('#fog-canvas').height);
  const m = activeMap();
  if (!m || !state.fogOn) return;
  const cols = Math.floor(m.mapW / m.gridSize);
  const rows = Math.floor(m.mapH / m.gridSize);
  g.fillStyle = 'rgba(8,10,16,.985)';
  for (const key of Object.keys(m.fog)) {
    const [x, y] = key.split(',').map(Number);
    if (x >= 0 && y >= 0 && x < cols && y < rows) {
      g.fillRect(x * m.gridSize, y * m.gridSize, m.gridSize, m.gridSize);
    }
  }
}

function paintFogAt(e) {
  const m = activeMap();
  const cell = pointerToCell(e);
  if (!m || !cell) return;
  const r = Math.floor(fogBrush / 2);
  const cols = Math.floor(m.mapW / m.gridSize);
  const rows = Math.floor(m.mapH / m.gridSize);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cell.col + dx, y = cell.row + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const key = `${x},${y}`;
      if (boardTool === 'fog-hide') m.fog[key] = true;
      else delete m.fog[key];
    }
  }
  renderFog();
  scheduleAutosave();
}

function fogSetAll(hide) {
  const m = activeMap();
  if (!m) return;
  const cols = Math.floor(m.mapW / m.gridSize);
  const rows = Math.floor(m.mapH / m.gridSize);
  m.fog = {};
  if (hide) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) m.fog[`${x},${y}`] = true;
    }
  }
  renderFog();
  scheduleAutosave();
  toast(hide ? '已全部隐藏，用「揭开」逐步探索' : '已全部显示');
}

function syncBoardTools() {
  document.querySelectorAll('.board-tool').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === boardTool);
  });
  syncPalettes();
}

/* ==================== 拼接地图 ==================== */

let stitchFiles = [];

function renderStitchSlots() {
  const layout = $('#stitch-layout').value;
  const n = layout === 'grid' ? 4 : 2;
  const box = $('#stitch-slots');
  box.innerHTML = '';
  stitchFiles = Array.from({ length: n }, () => null);
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'stitch-slot';
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = `选择文件 ${i + 1}`;
    const label = document.createElement('span');
    label.className = 'stitch-file';
    label.textContent = '未选择';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.json,application/json';
    input.hidden = true;
    input.addEventListener('change', () => {
      const f = input.files[0];
      if (f) {
        stitchFiles[i] = f;
        label.textContent = f.name;
      }
    });
    btn.addEventListener('click', () => input.click());
    row.appendChild(btn);
    row.appendChild(label);
    row.appendChild(input);
    box.appendChild(row);
  }
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function stitchGo() {
  const layout = $('#stitch-layout').value;
  const need = layout === 'grid' ? 4 : 2;
  const chosen = stitchFiles.filter(Boolean);
  if (chosen.length !== need) {
    toast(`还需要选择 ${need - chosen.length} 张地图`);
    return;
  }
  try {
    const imgs = [];
    for (const f of stitchFiles) {
      if (/\.json$/i.test(f.name)) {
        const j = JSON.parse(await f.text());
        if (!j.mapData) throw new Error('bad json');
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = j.mapData;
        });
        imgs.push(img);
      } else {
        imgs.push(await loadImageFromFile(f));
      }
    }
    const gridSize = clamp(parseInt($('#stitch-grid').value, 10) || 50, 20, 120);
    const W = (i) => imgs[i].naturalWidth;
    const H = (i) => imgs[i].naturalHeight;
    let tw, th, slots;
    if (layout === 'lr') {
      tw = W(0) + W(1);
      th = Math.max(H(0), H(1));
      slots = [[0, 0], [W(0), 0]];
    } else if (layout === 'tb') {
      tw = Math.max(W(0), W(1));
      th = H(0) + H(1);
      slots = [[0, 0], [0, H(0)]];
    } else {
      tw = Math.max(W(0) + W(1), W(2) + W(3));
      th = Math.max(H(0) + H(2), H(1) + H(3));
      slots = [[0, 0], [W(0), 0], [0, H(0)], [W(2), H(0)]];
    }
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const g = c.getContext('2d');
    g.fillStyle = '#181b21';
    g.fillRect(0, 0, tw, th);
    imgs.forEach((img, i) => g.drawImage(img, slots[i][0], slots[i][1]));
    addMap('拼接地图', c.toDataURL('image/png'), tw, th, gridSize);
    closeStitchModal();
    toast('拼接完成，已加入为「拼接地图」');
  } catch (err) {
    toast('拼接失败：文件无法读取或格式不对');
  }
}

function openStitchModal() {
  renderStitchSlots();
  $('#stitch-modal').hidden = false;
}

function closeStitchModal() {
  $('#stitch-modal').hidden = true;
}

/* ==================== 启动 ==================== */

bindEvents();
loadBgmDirHandle();
try {
  const hdMigration = localStorage.getItem('sangduoer-hd-default-v2');
  if (!hdMigration) {
    // 新高清资源体系首次运行默认开启；之后尊重用户手动选择。
    hdEnabled = true;
    localStorage.setItem('sangduoer-hd-toggle', '1');
    localStorage.setItem('sangduoer-hd-default-v2', '1');
  } else {
    hdEnabled = localStorage.getItem('sangduoer-hd-toggle') !== '0';
  }
} catch (e) { hdEnabled = true; }
const hdToggleCheck = $('#hd-toggle-check');
if (hdToggleCheck) hdToggleCheck.checked = hdEnabled;
const appVersionEl = $('#app-version');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;
updateStreamUi();
function flushPendingAutosave() {
  if (!autosaveTimer) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  saveNow();
}
window.addEventListener('pagehide', () => {
  flushPendingAutosave();
  if (streamOn) streamPush();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingAutosave();
});
const loaded = loadSaved();
if (loaded) {
  applyAllState();
}
// 独立棋子库：与「棋子库」程序共用同一份数据
const sharedLib = loadLibrary();
if (sharedLib.length) {
  state.library = sharedLib;
  // 把 normalize 后的轻量版本写回，清除旧版遗留的大体积内嵌高清字段。
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(sharedLib)); } catch (e) { /* saveNow 仍会继续保存主控台状态 */ }
} else if (state.library.length) {
  saveLibrary();
}
renderLibrary();
restoreStreamFromStorage();
// 左侧面板默认全部折叠
document.querySelectorAll('#left-panel .card').forEach((c) => c.classList.add('collapsed'));
loadLinks();
renderLinks();
(async () => {
  await loadProjectDirHandle();
  if (projectDirHandle && await hasSaveFolderPermission()) {
    try {
      await ensureSaveFolderStructure();
      await migrateLegacyCampaigns();
      await syncLibraryWithFolder();
      await restoreFolderIfAvailable();
      await initLibPersistStatus();
    } catch (e) {
      console.warn('初始化存档文件夹失败', e);
      updateSaveStatus('存档文件夹不可用 · 仅浏览器缓存', 'error');
    }
  } else {
    updateLibPersistStatus(projectDirHandle ? 'denied' : 'unset');
    updateSaveStatus(projectDirHandle ? '“存档”文件夹待授权' : '仅浏览器缓存 · 请连接“存档”文件夹', 'error');
  }
})();
// 人物卡默认收起，选中棋子时自动展开
const unitCard = document.querySelector('#unit-card');
if (unitCard) unitCard.classList.add('collapsed');
const layoutEl = $('#layout');
const panelToggleButton = $('#btn-toggle-left-panel');
if (panelToggleButton && layoutEl) {
  panelToggleButton.addEventListener('click', () => {
    const compact = layoutEl.classList.toggle('focus-map');
    panelToggleButton.setAttribute('aria-pressed', String(compact));
  });
}

function initWorkspaceTabs() {
  const tabs = [...document.querySelectorAll('[data-workspace-tab]')];
  const cards = [...document.querySelectorAll('#left-panel .card[data-workspace]')];
  if (!tabs.length || !cards.length) return;
  const activate = (workspace) => {
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.workspaceTab === workspace));
    const visible = cards.filter((card) => card.dataset.workspace === workspace);
    cards.forEach((card) => { card.hidden = card.dataset.workspace !== workspace; });
    if (visible.length && visible.every((card) => card.classList.contains('collapsed'))) visible[0].classList.remove('collapsed');
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab.dataset.workspaceTab)));
  activate(tabs.find((tab) => tab.classList.contains('active'))?.dataset.workspaceTab || 'units');
}

function initMapQuickTools() {
  document.querySelectorAll('[data-toggle-target]').forEach((button) => {
    const target = document.getElementById(button.dataset.toggleTarget);
    if (!target) return;
    const sync = () => button.classList.toggle('active', target.checked);
    button.addEventListener('click', () => target.click());
    target.addEventListener('change', sync);
    sync();
  });
  const panel = $('#map-quick-tools');
  const handle = $('#map-quick-drag');
  if (!panel || !handle) return;
  try {
    const saved = JSON.parse(localStorage.getItem('sangduoer-map-quick-pos') || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      panel.style.left = `${saved.x}px`; panel.style.top = `${saved.y}px`;
    }
  } catch (e) {}
  let quickDrag = null;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault(); event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    quickDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!quickDrag) return;
    const parent = panel.parentElement.getBoundingClientRect();
    const x = clamp(event.clientX - parent.left - quickDrag.dx, 0, Math.max(0, parent.width - panel.offsetWidth));
    const y = clamp(event.clientY - parent.top - quickDrag.dy, 0, Math.max(0, parent.height - panel.offsetHeight));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
  });
  const saveQuickPosition = () => {
    if (!quickDrag) return;
    quickDrag = null;
    try { localStorage.setItem('sangduoer-map-quick-pos', JSON.stringify({ x: parseFloat(panel.style.left) || 14, y: parseFloat(panel.style.top) || 14 })); } catch (e) {}
  };
  handle.addEventListener('pointerup', saveQuickPosition);
  handle.addEventListener('pointercancel', saveQuickPosition);
}

initWorkspaceTabs();
initMapQuickTools();
renderEncounter();
clearInterval(encounterClockTimer);
encounterClockTimer = setInterval(() => {
  if (encounterState().worldTime.runningSince) renderEncounter();
}, 500);
updateCoverContinue();
setTimeout(() => { prewarmAvatarCache(); }, 1000);
