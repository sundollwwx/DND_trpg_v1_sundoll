'use strict';

/* ==================== 常量 ==================== */

const STORAGE_KEY = 'dnd-board-state-v1';
const LIBRARY_KEY = 'dnd-board-library-v1';
const LIBRARY_SAVED_AT_KEY = 'dnd-board-library-saved-at-v1';
// 只用于首次打开且尚未连接“存档”时的内置模板；绝不是当前棋子库的第二份存档。
const BUNDLED_LIBRARY = Array.isArray(window.__LIBRARY_SEED__) ? window.__LIBRARY_SEED__ : [];
const SERVER_URL_KEY = 'sangduoer-server-url-v1';
const APP_VERSION = 'v1.10';
const MAX_DOODLE_POINTS = 800;
const CONDITION_SPRITE_URL = '../asset/界面/状态图标-v1.png';
const REST_TRANSITION_DURATIONS = Object.freeze({ short: 2200, long: 4400 });

const TYPE_META = {
  pc:    { label: '玩家角色', ring: '#5b8cff', glow: 'rgba(91,140,255,.45)', defaultIcon: '🧙' },
  enemy: { label: '敌人',     ring: '#ef476f', glow: 'rgba(239,71,111,.45)', defaultIcon: '👹' },
  npc:   { label: '中立NPC',   ring: '#f4a261', glow: 'rgba(244,162,97,.45)', defaultIcon: '🧑‍🌾' },
  ally:  { label: '友好NPC',   ring: '#2ecc71', glow: 'rgba(46,204,113,.45)', defaultIcon: '🧑‍🤝‍🧑' },
};

const CONDITION_META = {
  prone:       { label: '倒地', icon: '🛌', color: '#f4a261' },
  unconscious: { label: '昏迷', icon: '💤', color: '#9b8cff' },
  incapacitated:{ label: '失能', icon: '🚫', color: '#b9c0cc' },
  blinded:     { label: '目盲', icon: '🙈', color: '#c6a97d' },
  deafened:    { label: '耳聋', icon: '🙉', color: '#c6a97d' },
  frightened:  { label: '恐慌', icon: '😨', color: '#d879ff' },
  charmed:     { label: '魅惑', icon: '💗', color: '#ff8fb3' },
  poisoned:    { label: '中毒', icon: '☠️', color: '#79c267' },
  grappled:    { label: '擒抱', icon: '✊', color: '#d99b62' },
  restrained:  { label: '束缚', icon: '⛓️', color: '#d99b62' },
  stunned:     { label: '眩晕', icon: '💫', color: '#ffd166' },
  petrified:   { label: '石化', icon: '🗿', color: '#a9b3bf' },
  invisible:   { label: '隐形', icon: '👻', color: '#8fbaff' },
  concentrating:{ label: '专注', icon: '🎯', color: '#68d9c0' },
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

function preloadConditionPixels() {
  const image = new Image();
  image.onload = () => document.documentElement.classList.add('condition-pixels-ready');
  image.onerror = () => document.documentElement.classList.remove('condition-pixels-ready');
  image.src = CONDITION_SPRITE_URL;
}

const WORLD_MINUTES_PER_DAY = 24 * 60;
const WORLD_DAYS_PER_WEEK = 7;
const WORLD_WEEKS_PER_YEAR = 52;
const WORLD_MINUTES_PER_YEAR = WORLD_MINUTES_PER_DAY * WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR;
const MAX_MOVE_POINTS = 60;
const MAX_TURN_PATH_POINTS = 200;
const SPELL_RANGE_MIN_FEET = 5;
const SPELL_RANGE_MAX_FEET = 180;
const SPELL_RANGE_STEP_FEET = 5;
const SPELL_CONE_HALF_ANGLE = Math.atan(0.5);
const MAP_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '🔥', '✨', '❓', '⚔️', '🎯', '👏']);
const MAP_THUMBNAIL_WIDTH = 400;
const MAP_THUMBNAIL_HEIGHT = 225;
const MAX_DIRECT_MAP_IMPORTS = 30;
const AUTOSAVE_INTERVAL_MS = 60 * 1000;
const WORLD_SECONDS_PER_DAY = WORLD_MINUTES_PER_DAY * 60;
const WEATHER_ROLLOVER_SECONDS = 8 * 60 * 60;
// 08:00 为当天基准温度；凌晨最低，午后最高，每个整点更新一次。
const HOURLY_TEMPERATURE_CURVE = [
  -0.60, -0.72, -0.82, -0.90, -1.00, -0.95,
  -0.70, -0.35, 0, 0.25, 0.50, 0.70,
  0.85, 0.95, 1.00, 0.95, 0.80, 0.55,
  0.25, 0, -0.15, -0.30, -0.42, -0.52,
];

const SEASON_META = [
  { key: 'spring', label: '春季', icon: '🌱', firstWeek: 1, lastWeek: 13 },
  { key: 'summer', label: '夏季', icon: '☀️', firstWeek: 14, lastWeek: 26 },
  { key: 'autumn', label: '秋季', icon: '🍂', firstWeek: 27, lastWeek: 39 },
  { key: 'winter', label: '冬季', icon: '❄️', firstWeek: 40, lastWeek: 52 },
];

const WEATHER_META = {
  clear: { label: '晴朗', icon: '☀️', temperatureDelta: 2 },
  cloudy: { label: '多云', icon: '☁️', temperatureDelta: 0 },
  rain: { label: '降雨', icon: '🌧️', temperatureDelta: -3 },
  storm: { label: '雷暴', icon: '⛈️', temperatureDelta: -5 },
  fog: { label: '浓雾', icon: '🌫️', temperatureDelta: -2 },
  snow: { label: '降雪', icon: '🌨️', temperatureDelta: -7 },
  wind: { label: '强风', icon: '💨', temperatureDelta: -2 },
  heat: { label: '酷热', icon: '🏜️', temperatureDelta: 7 },
};

const WIND_META = {
  calm: { label: '无风', icon: '·' },
  breeze: { label: '微风', icon: '〰' },
  strong: { label: '强风', icon: '≋' },
  gale: { label: '烈风', icon: '➰' },
};

const CLIMATE_META = {
  temperate: {
    label: '温带', icon: '🌿', diurnalRange: 5, temperatures: { spring: 14, summer: 25, autumn: 15, winter: 3 },
    weather: {
      spring: ['clear', 'cloudy', 'rain', 'rain', 'fog', 'wind'],
      summer: ['clear', 'clear', 'cloudy', 'rain', 'storm', 'heat'],
      autumn: ['clear', 'cloudy', 'rain', 'fog', 'wind', 'wind'],
      winter: ['clear', 'cloudy', 'snow', 'snow', 'fog', 'wind'],
    },
  },
  cold: {
    label: '寒带', icon: '🧊', diurnalRange: 6, temperatures: { spring: 0, summer: 12, autumn: 2, winter: -15 },
    weather: {
      spring: ['cloudy', 'snow', 'rain', 'wind', 'fog'],
      summer: ['clear', 'cloudy', 'rain', 'fog', 'wind'],
      autumn: ['cloudy', 'rain', 'snow', 'wind', 'fog'],
      winter: ['snow', 'snow', 'clear', 'wind', 'fog'],
    },
  },
  tropical: {
    label: '热带', icon: '🌴', diurnalRange: 3, temperatures: { spring: 27, summer: 29, autumn: 28, winter: 26 },
    weather: {
      spring: ['clear', 'rain', 'rain', 'storm', 'fog'],
      summer: ['clear', 'heat', 'rain', 'storm', 'storm'],
      autumn: ['clear', 'rain', 'rain', 'storm', 'cloudy'],
      winter: ['clear', 'clear', 'cloudy', 'rain', 'fog'],
    },
  },
  arid: {
    label: '干旱', icon: '🏜️', diurnalRange: 9, temperatures: { spring: 22, summer: 36, autumn: 25, winter: 14 },
    weather: {
      spring: ['clear', 'clear', 'heat', 'wind', 'cloudy'],
      summer: ['clear', 'heat', 'heat', 'wind', 'storm'],
      autumn: ['clear', 'clear', 'heat', 'wind', 'cloudy'],
      winter: ['clear', 'clear', 'cloudy', 'wind', 'rain'],
    },
  },
  coastal: {
    label: '海洋', icon: '🌊', diurnalRange: 3, temperatures: { spring: 15, summer: 23, autumn: 17, winter: 9 },
    weather: {
      spring: ['cloudy', 'rain', 'fog', 'wind', 'clear'],
      summer: ['clear', 'cloudy', 'rain', 'fog', 'storm'],
      autumn: ['cloudy', 'rain', 'wind', 'storm', 'fog'],
      winter: ['cloudy', 'rain', 'wind', 'fog', 'snow'],
    },
  },
  highland: {
    label: '高山', icon: '⛰️', diurnalRange: 7, temperatures: { spring: 5, summer: 16, autumn: 7, winter: -6 },
    weather: {
      spring: ['clear', 'cloudy', 'fog', 'rain', 'snow'],
      summer: ['clear', 'cloudy', 'rain', 'storm', 'wind'],
      autumn: ['cloudy', 'fog', 'rain', 'snow', 'wind'],
      winter: ['snow', 'snow', 'clear', 'fog', 'wind'],
    },
  },
};

function seasonForWeek(week) {
  const safeWeek = clamp(Math.trunc(Number(week) || 1), 1, WORLD_WEEKS_PER_YEAR);
  return SEASON_META.find((season) => safeWeek >= season.firstWeek && safeWeek <= season.lastWeek) || SEASON_META[0];
}

function defaultWeatherState() {
  return { climate: 'temperate', condition: 'clear', temperature: 18, wind: 'breeze', generatedDay: 0 };
}

function normalizeWeather(raw) {
  const defaults = defaultWeatherState();
  const source = raw && typeof raw === 'object' ? raw : {};
  const climate = CLIMATE_META[source.climate] ? source.climate : defaults.climate;
  const condition = WEATHER_META[source.condition] ? source.condition : defaults.condition;
  const wind = WIND_META[source.wind] ? source.wind : defaults.wind;
  const numericTemperature = Number(source.temperature);
  const numericGeneratedDay = source.generatedDay === null || source.generatedDay === ''
    ? NaN : Number(source.generatedDay);
  return {
    climate,
    condition,
    temperature: Number.isFinite(numericTemperature) ? clamp(Math.round(numericTemperature), -100, 100) : defaults.temperature,
    wind,
    generatedDay: Number.isFinite(numericGeneratedDay) ? Math.trunc(numericGeneratedDay) : null,
  };
}

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
    weather: defaultWeatherState(),
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
let restAnimationTimer = null;
let restAnimationActive = false;
let browserStateCacheFailed = false;
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
let pendingLegacyPortraitMigrations = 0;
let streamPlayers = [];
let sharedNoteTimer = null;
let hostLocalRolls = new Set();
let tokenAvatar = null;
let boardTool = null;
let editTile = 'floor';
let editVariant = 0;
let mapEditHistory = [];
const mapThumbnailCache = new Map();
let mapBrowserRenderToken = 0;
let mapBrowserPointerDrag = null;
let mapBrowserSuppressClickUntil = 0;
let pendingMapImageImports = [];
let mapImageImportBusy = false;
let doodleTool = 'pen';
let doodleColor = '#ff4d4f';
let doodleWidth = 6;
let doodleDraft = null;
let selectedDoodleId = null;
let fogBrush = 3;
let lastSelId = null;
let detailActiveTab = 'status';
let editingConditionId = null;
let detailHpUndo = null;
let detailTextSaveTimer = null;
let detailTextSaveMarksStream = false;
let libFilter = 'all';
let libSearch = '';
let libCategory = 'all';
let libEditorId = null;
let libAvatar = null;
let libEqDraft = [];
let encounterClockTimer = null;
let spellAimTokenId = null;
let pendingMapReaction = null;
let spellRangeRaf = null;
let lastInitiativeScrollEntryId = null;
const localReactionIds = new Set();

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

  const playMode = source.playMode === 'turn' ? 'turn' : (source.playMode === 'prepare' ? 'prepare' : 'free');
  let currentEntryId = source.currentEntryId && usedIds.has(String(source.currentEntryId))
    ? String(source.currentEntryId)
    : null;
  if (!currentEntryId && legacyCurrentId && usedIds.has(legacyCurrentId)) currentEntryId = legacyCurrentId;
  if (!currentEntryId && entries.length && playMode === 'turn') currentEntryId = entries[0].id;
  if (playMode !== 'turn') currentEntryId = null;

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
  const weather = normalizeWeather(source.weather);
  if (!Number.isInteger(weather.generatedDay)) {
    weather.generatedDay = weatherDayIndex(worldTimeNow({ worldTime }));
  }
  const panel = source.panel === 'time' ? 'time' : 'initiative';
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
    weather,
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
  if (!['free', 'prepare', 'turn'].includes(e.playMode)) e.playMode = 'free';
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
  if (e.playMode === 'turn' && !e.entries.some((entry) => entry.id === e.currentEntryId)) e.currentEntryId = e.entries[0]?.id || null;
  if (e.playMode !== 'turn') e.currentEntryId = null;
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
  e.weather = normalizeWeather(e.weather);
  if (!Number.isInteger(e.weather.generatedDay)) {
    e.weather.generatedDay = weatherDayIndex(worldTimeNow(e));
  }
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

function weatherDayIndex(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return Math.floor((total - WEATHER_ROLLOVER_SECONDS) / WORLD_SECONDS_PER_DAY);
}

function hourlyTemperatureOffset(climateKey, hour) {
  const climate = CLIMATE_META[climateKey] || CLIMATE_META.temperate;
  const safeHour = clamp(Math.trunc(Number(hour) || 0), 0, 23);
  return Math.round((Number(climate.diurnalRange) || 0) * HOURLY_TEMPERATURE_CURVE[safeHour]);
}

function currentWeatherTemperature(weather, hour) {
  const normalized = normalizeWeather(weather);
  return clamp(normalized.temperature + hourlyTemperatureOffset(normalized.climate, hour), -100, 100);
}

function weatherPresentation(weather, worldParts) {
  const normalized = normalizeWeather(weather);
  const climate = CLIMATE_META[normalized.climate];
  const condition = WEATHER_META[normalized.condition];
  const wind = WIND_META[normalized.wind];
  const world = worldParts && typeof worldParts === 'object'
    ? worldParts : { week: Number(worldParts) || 1, hour: 8 };
  const season = seasonForWeek(world.week);
  const temperature = currentWeatherTemperature(normalized, world.hour);
  return {
    ...normalized,
    baseTemperature: normalized.temperature,
    temperature,
    climateLabel: climate.label,
    climateIcon: climate.icon,
    conditionLabel: condition.label,
    conditionIcon: condition.icon,
    windLabel: wind.label,
    season,
    compact: `${condition.icon} ${condition.label} · ${temperature}°C`,
    detail: `${climate.icon} ${climate.label} · ${season.icon} ${season.label} · ${temperature}°C · ${wind.label}`,
  };
}

function generateClimateWeather(e = encounterState(), climateKey = null, totalSeconds = worldTimeNow(e)) {
  const world = worldTimeParts(totalSeconds);
  const season = seasonForWeek(world.week);
  const climate = CLIMATE_META[climateKey] ? climateKey : e.weather.climate;
  const profile = CLIMATE_META[climate];
  const pool = profile.weather[season.key] || profile.weather.spring;
  const condition = pool[Math.floor(Math.random() * pool.length)] || 'clear';
  const weatherMeta = WEATHER_META[condition];
  const temperature = clamp(
    Math.round(profile.temperatures[season.key] + weatherMeta.temperatureDelta + (Math.random() * 6 - 3)),
    -100,
    100,
  );
  let wind = 'breeze';
  if (condition === 'storm') wind = 'gale';
  else if (condition === 'wind') wind = 'strong';
  else if (Math.random() < 0.2) wind = 'calm';
  e.weather = { climate, condition, temperature, wind, generatedDay: weatherDayIndex(world.totalSeconds) };
  return weatherPresentation(e.weather, world);
}

function refreshScheduledWeather(e = encounterState(), totalSeconds = worldTimeNow(e)) {
  e.weather = normalizeWeather(e.weather);
  const currentDay = weatherDayIndex(totalSeconds);
  if (!Number.isInteger(e.weather.generatedDay)) {
    e.weather.generatedDay = currentDay;
    return null;
  }
  if (currentDay > e.weather.generatedDay) {
    return generateClimateWeather(e, e.weather.climate, totalSeconds);
  }
  // 回退时间后同步天气日标记；再次向前经过 08:00 时会重新生成。
  if (currentDay < e.weather.generatedDay) e.weather.generatedDay = currentDay;
  return null;
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

function applyInitiativeRemoteAction(e, action) {
  if (!e || e.playMode !== 'prepare' || !action) return false;
  const serial = Math.max(1, Math.trunc(Number(action.turnSerial) || 1));
  const nextSerial = Math.max(serial + 1, Math.trunc(Number(action.nextTurnSerial) || (serial + 1)));
  if (Number(e.turnSerial) === nextSerial) return true;
  if (Number(e.turnSerial) !== serial) return false;
  const entry = e.entries.find((item) => item.id === action.entryId);
  if (!entry) return false;
  if (action.op === 'initiativeSwap') {
    const target = e.entries.find((item) => item.id === action.targetEntryId);
    const entryOrder = Number(action.entryOrder);
    const targetOrder = Number(action.targetOrder);
    if (!target || Number(entry.value) !== Number(target.value) || !Number.isFinite(entryOrder) || !Number.isFinite(targetOrder)) return false;
    entry.order = entryOrder;
    target.order = targetOrder;
  } else return false;
  sortInitiativeEntries(e);
  e.turnSerial = nextSerial;
  e.turnPath = emptyTurnPath();
  return true;
}

function scrollCurrentInitiativeIntoView(list, e) {
  const targetId = e.playMode === 'turn' ? e.currentEntryId : null;
  if (!targetId) {
    const leftTurnMode = Boolean(lastInitiativeScrollEntryId);
    lastInitiativeScrollEntryId = null;
    if (leftTurnMode) requestAnimationFrame(() => list.scrollTo({ top: 0, behavior: 'smooth' }));
    return;
  }
  if (targetId === lastInitiativeScrollEntryId) return;
  lastInitiativeScrollEntryId = targetId;
  requestAnimationFrame(() => {
    const current = list.querySelector('.init-chip.current');
    if (!current || !list.isConnected) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = current.getBoundingClientRect();
    const top = list.scrollTop + itemRect.top - listRect.top - (listRect.height - itemRect.height) / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
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

function pruneInitiativeTokenRefs(tokenIds) {
  const ids = tokenIds instanceof Set ? tokenIds : new Set(tokenIds || []);
  if (!ids.size) return { removed: 0, currentChanged: false };
  const e = encounterState();
  const oldEntries = e.entries.slice();
  const oldCurrentIndex = oldEntries.findIndex((entry) => entry.id === e.currentEntryId);
  const oldCurrent = oldCurrentIndex >= 0 ? oldEntries[oldCurrentIndex] : null;
  e.entries = oldEntries.filter((entry) => !entry.tokenId || !ids.has(entry.tokenId));
  const removed = oldEntries.length - e.entries.length;
  const currentChanged = Boolean(oldCurrent && !e.entries.some((entry) => entry.id === oldCurrent.id));
  if (currentChanged) {
    const nextIndex = e.entries.length ? Math.min(Math.max(0, oldCurrentIndex), e.entries.length - 1) : -1;
    e.currentEntryId = nextIndex >= 0 ? e.entries[nextIndex].id : null;
  } else if (!e.entries.some((entry) => entry.id === e.currentEntryId)) {
    e.currentEntryId = e.entries[0]?.id || null;
  }
  return { removed, currentChanged };
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
      order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
    })),
    worldTime: {
      // 运行中的时钟必须发送“起跑基数 + 起跑时间”，玩家端再用服务器锚点持续推算。
      totalSeconds: e.worldTime.totalSeconds,
      runningSince: e.worldTime.runningSince,
      rate: e.worldTime.rate,
    },
    weather: { ...e.weather },
    // 事件文本可能包含被隐藏单位名称，玩家端只需要知道状态已更新。
    lastEvent: e.lastEvent ? { at: e.lastEvent.at, label: '流程状态已更新' } : null,
  };
}

function renderEncounter() {
  const bar = $('#init-bar');
  if (!bar) return;
  const e = encounterState();
  const world = worldTimeParts(worldTimeNow(e));
  const current = currentInitiativeEntry(e);
  const currentIndex = e.entries.findIndex((entry) => entry.id === e.currentEntryId);
  const nextEntry = e.entries.length && currentIndex >= 0 ? e.entries[(currentIndex + 1) % e.entries.length] : e.entries[0] || null;
  const weather = weatherPresentation(e.weather, world);
  const preparing = e.playMode === 'prepare';
  const inTurn = e.playMode === 'turn';
  bar.classList.toggle('collapsed', Boolean(e.collapsed));
  $('#btn-init-collapse').setAttribute('aria-expanded', String(!e.collapsed));
  $('#btn-init-collapse').textContent = `${e.collapsed ? '▸' : '▾'} 游戏流程`;
  $('#init-round-readout').textContent = inTurn ? `第 ${e.round} 轮` : (preparing ? '战斗准备' : '自由模式');
  $('#init-time-readout').textContent = `${formatWorldDate(world)} ${formatWorldClock(world)}`;
  $('#init-current-readout').textContent = current && inTurn ? initiativeEntryLabel(current) : (preparing ? '等待战斗开始' : '所有单位可行动');
  $('#init-weather-readout').textContent = weather.compact;
  $('#init-focus-current').textContent = current && inTurn ? initiativeEntryLabel(current) : (preparing ? '调整先攻，准备开战' : '所有单位自由行动');
  $('#init-focus-round').textContent = inTurn ? `第 ${e.round} 轮` : (preparing ? '战斗准备阶段' : '自由模式');
  $('#init-focus-next').textContent = inTurn && nextEntry ? `下一位：${initiativeEntryLabel(nextEntry)}` : (preparing ? '先攻相同的玩家可以互换顺序' : '点击“准备战斗”整理先攻顺序');
  $('#init-mode-free').classList.toggle('active', e.playMode === 'free');
  $('#init-mode-turn').classList.toggle('active', preparing || inTurn);
  $('#init-mode-free').setAttribute('aria-pressed', String(e.playMode === 'free'));
  $('#init-mode-turn').setAttribute('aria-pressed', String(preparing || inTurn));
  $('#init-mode-turn').textContent = inTurn ? '回合制' : (preparing ? '战斗准备' : '准备战斗');
  document.querySelectorAll('[data-encounter-panel]').forEach((tab) => {
    const active = tab.dataset.encounterPanel === e.panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#init-panel-initiative').hidden = e.panel !== 'initiative';
  $('#init-panel-time').hidden = e.panel !== 'time';
  $('#btn-combat-start').hidden = !preparing;
  $('#btn-combat-start').disabled = !e.entries.length;
  $('#btn-init-next').hidden = !inTurn;
  $('#btn-init-next').disabled = !inTurn || !e.entries.length;
  $('#btn-init-next').textContent = inTurn && nextEntry ? `结束当前回合 → ${initiativeEntryLabel(nextEntry)}` : '结束当前回合';
  $('#btn-init-timer').textContent = inTurn
    ? '⏱ 按战斗轮推进' : (e.worldTime.runningSince ? '❚❚ 暂停时间' : '▶ 开始时间');
  $('#btn-init-timer').disabled = inTurn;
  $('#btn-time-short-rest').disabled = inTurn || restAnimationActive;
  $('#btn-time-long-rest').disabled = inTurn || restAnimationActive;
  const timeInputs = {
    year: $('#time-year'), week: $('#time-week'), day: $('#time-day'), clock: $('#time-clock'),
    climate: $('#weather-climate'), condition: $('#weather-condition'), temperature: $('#weather-temperature'), wind: $('#weather-wind'),
  };
  if (timeInputs.year && document.activeElement !== timeInputs.year) timeInputs.year.value = world.year;
  if (timeInputs.week && document.activeElement !== timeInputs.week) timeInputs.week.value = world.week;
  if (timeInputs.day && document.activeElement !== timeInputs.day) timeInputs.day.value = world.day;
  if (timeInputs.clock && document.activeElement !== timeInputs.clock) timeInputs.clock.value = formatWorldClock(world);
  if (timeInputs.climate && document.activeElement !== timeInputs.climate) timeInputs.climate.value = weather.climate;
  if (timeInputs.condition && document.activeElement !== timeInputs.condition) timeInputs.condition.value = weather.condition;
  if (timeInputs.temperature && document.activeElement !== timeInputs.temperature) timeInputs.temperature.value = weather.temperature;
  if (timeInputs.wind && document.activeElement !== timeInputs.wind) timeInputs.wind.value = weather.wind;
  $('#world-date-display').textContent = formatWorldDate(world);
  $('#world-clock-display').textContent = formatWorldClock(world);
  $('#world-season-display').textContent = `${weather.season.icon} ${weather.season.label}`;
  $('#weather-icon-display').textContent = weather.conditionIcon;
  $('#weather-name-display').textContent = weather.conditionLabel;
  $('#weather-detail-display').textContent = weather.detail;
  $('#time-running-state').textContent = inTurn
    ? `战斗轮推进：每轮 +${e.secondsPerRound} 秒`
    : (e.worldTime.runningSince ? '时间运行中' : '时间已暂停');
  $('#time-event').textContent = e.lastEvent?.label || '—';
  const list = $('#init-bar-list');
  const previousScrollTop = list.scrollTop;
  list.innerHTML = '';
  if (!e.entries.length) {
    list.innerHTML = '<span class="init-empty">添加单位后开始回合</span>';
  } else {
    e.entries.forEach((entry, index) => {
      const chip = document.createElement('div');
      const currentClass = inTurn && entry.id === e.currentEntryId ? ' current' : '';
      chip.className = `init-chip${currentClass}`;
      chip.dataset.entryId = entry.id;
      chip.innerHTML = `<span class="init-chip-order">${index + 1}</span><span class="init-dot" style="background:${entry.color || '#e0b34c'}"></span><span class="init-chip-name">${esc(initiativeEntryLabel(entry))}</span><span class="init-chip-val">${entry.value}</span>${currentClass ? '<span class="init-chip-current">行动中</span>' : ''}`;
      chip.title = inTurn ? '设为当前行动单位' : (preparing ? '战斗准备中' : '进入战斗后可指定当前行动单位');
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
        }
        if (e.playMode !== 'free') bumpEncounterTurn(e);
        setEncounterEvent(e, `移除先攻单位：${initiativeEntryLabel(entry)}`);
        renderEncounter(); scheduleAutosave();
      });
      chip.appendChild(del);
      list.appendChild(chip);
    });
  }
  list.scrollTop = previousScrollTop;
  scrollCurrentInitiativeIntoView(list, e);
  renderTurnPath();
  const selected = state.selectedId ? findToken(state.selectedId) : null;
  if (selected) updateDetailContext(selected);
}

function decrementCurrentTokenConditions(e) {
  const current = currentInitiativeEntry(e);
  const token = current?.tokenId ? findToken(current.tokenId) : null;
  if (!token || !Array.isArray(token.conditions)) return;
  let changed = false;
  token.conditions = token.conditions.flatMap((condition) => {
    const rawRemaining = condition?.remainingTurns;
    const turns = Number(rawRemaining);
    if (rawRemaining == null || !Number.isFinite(turns) || turns <= 0) return [condition];
    const remaining = Math.max(0, Math.trunc(turns) - 1);
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
  let automaticWeather = null;
  if (nextIndex === 0) {
    e.round += 1;
    materializeWorldTime(e);
    e.worldTime.totalSeconds += e.secondsPerRound;
    automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
  }
  e.currentEntryId = e.entries[nextIndex].id;
  bumpEncounterTurn(e);
  setEncounterEvent(e, nextIndex === 0
    ? `第 ${e.round} 轮开始：世界时间 +${e.secondsPerRound} 秒${automaticWeather ? `；天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C` : ''}`
    : `当前单位：${initiativeEntryLabel(e.entries[nextIndex])}`);
  renderEncounter(); scheduleAutosave();
}

function enterCombatPreparation() {
  const e = encounterState();
  if (e.playMode === 'turn') { toast('请先切换到自由模式来结束当前战斗'); return; }
  if (e.playMode === 'prepare') return;
  e.playMode = 'prepare';
  e.round = 1;
  e.currentEntryId = null;
  e.panel = 'initiative';
  e.collapsed = false;
  bumpEncounterTurn(e);
  setEncounterEvent(e, '进入战斗准备：等待玩家确认先攻顺序');
  renderEncounter(); scheduleAutosave();
}

function startCombat() {
  const e = encounterState();
  if (e.playMode !== 'prepare') return;
  if (!e.entries.length) { toast('请先把单位加入先攻列表'); return; }
  sortInitiativeEntries(e);
  const wasRunning = Boolean(e.worldTime.runningSince);
  materializeWorldTime(e);
  const automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
  e.worldTime.resumeAfterTurn = wasRunning;
  e.worldTime.runningSince = null;
  e.playMode = 'turn';
  e.round = 1;
  e.currentEntryId = e.entries[0].id;
  bumpEncounterTurn(e);
  setEncounterEvent(e, `战斗开始：${initiativeEntryLabel(e.entries[0])} 先行动${automaticWeather ? `；天气变为${automaticWeather.conditionLabel}` : ''}`);
  renderEncounter(); renderTokens(); scheduleAutosave();
}

function leaveCombatForFreeMode() {
  const e = encounterState();
  if (e.playMode === 'free') return;
  if (e.playMode === 'turn' && e.worldTime.resumeAfterTurn) e.worldTime.runningSince = Date.now();
  e.worldTime.resumeAfterTurn = false;
  e.playMode = 'free';
  e.currentEntryId = null;
  e.round = 1;
  bumpEncounterTurn(e);
  setEncounterEvent(e, '已切换为自由模式');
  renderEncounter(); renderTokens(); scheduleAutosave();
}

function setWorldClockRunning() {
  const e = encounterState();
  if (e.playMode === 'turn') {
    toast('回合制按完整战斗轮推进时间，请使用“下一位”');
    return;
  }
  let automaticWeather = null;
  if (e.worldTime.runningSince) {
    materializeWorldTime(e);
    automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
  } else {
    e.worldTime.runningSince = Date.now();
  }
  setEncounterEvent(e, automaticWeather
    ? `每日 08:00：天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C`
    : (e.worldTime.runningSince ? '世界时间开始运行' : '世界时间已暂停'));
  renderEncounter(); scheduleAutosave();
}

function shiftWorldTime(seconds, label) {
  const e = encounterState();
  const wasRunning = Boolean(e.worldTime.runningSince);
  materializeWorldTime(e);
  const before = e.worldTime.totalSeconds;
  e.worldTime.totalSeconds = Math.max(0, before + Math.trunc(Number(seconds) || 0));
  if (wasRunning && e.playMode !== 'turn') e.worldTime.runningSince = Date.now();
  const world = worldTimeParts(e.worldTime.totalSeconds);
  const automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
  setEncounterEvent(e, `${label}：${formatWorldDate(world)} ${formatWorldClock(world)}${automaticWeather ? `；天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C` : ''}`);
  renderEncounter(); scheduleAutosave();
}

function advanceWorldTime(seconds, label) {
  shiftWorldTime(Math.max(0, Math.trunc(Number(seconds) || 0)), label);
}

function playRestTransition(kind, requestedDuration = null) {
  const isLong = kind === 'long';
  const layer = $('#rest-transition');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const fallbackDuration = REST_TRANSITION_DURATIONS[isLong ? 'long' : 'short'];
  const networkDuration = clamp(Math.trunc(Number(requestedDuration) || fallbackDuration), 1000, 8000);
  const duration = reducedMotion ? (isLong ? 900 : 600) : networkDuration;
  restAnimationActive = true;
  clearTimeout(restAnimationTimer);
  if (layer) {
    layer.hidden = false;
    layer.className = `rest-transition ${isLong ? 'is-long' : 'is-short'}`;
    layer.style.setProperty('--rest-duration', `${duration}ms`);
    layer.setAttribute('aria-label', isLong ? '长休进行中' : '短休进行中');
    $('#rest-transition-icon').textContent = isLong ? '🌙' : '🔥';
    $('#rest-transition-title').textContent = isLong ? '长休' : '短休';
    $('#rest-transition-subtitle').textContent = isLong ? '夜色流转，晨光将至' : '围火喘息，片刻整备';
    // 重新触发布局，让连续两次休息都从动画第一帧开始。
    void layer.offsetWidth;
  }
  restAnimationTimer = setTimeout(() => {
    restAnimationTimer = null;
    restAnimationActive = false;
    if (layer) {
      layer.hidden = true;
      layer.className = 'rest-transition';
      layer.removeAttribute('aria-label');
    }
    renderEncounter();
  }, duration);
}

function takeRest(kind) {
  if (restAnimationActive) return;
  const isLong = kind === 'long';
  const normalizedKind = isLong ? 'long' : 'short';
  const duration = REST_TRANSITION_DURATIONS[normalizedKind];
  const restId = `rest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  playRestTransition(normalizedKind, duration);
  if (streamOn) {
    sendHostAction({ op: 'restTransition', restId, kind: normalizedKind, duration })
      .then((result) => {
        if (!result.ok || result.data?.ok === false) toast('⚠ 玩家端休息动画未广播');
      })
      .catch(() => toast('⚠ 玩家端休息动画未广播'));
  }
  advanceWorldTime(isLong ? 8 * 60 * 60 : 60 * 60, isLong
    ? '完成长休：世界时间 +8 小时'
    : '完成短休：世界时间 +1 小时');
}

function applyWeatherFromInputs() {
  const e = encounterState();
  const world = worldTimeParts(worldTimeNow(e));
  const climate = CLIMATE_META[$('#weather-climate').value] ? $('#weather-climate').value : 'temperate';
  const displayedTemperature = Number($('#weather-temperature').value);
  const baseTemperature = Number.isFinite(displayedTemperature)
    ? displayedTemperature - hourlyTemperatureOffset(climate, world.hour)
    : defaultWeatherState().temperature;
  e.weather = normalizeWeather({
    climate,
    condition: $('#weather-condition').value,
    temperature: baseTemperature,
    wind: $('#weather-wind').value,
    generatedDay: weatherDayIndex(world.totalSeconds),
  });
  const presentation = weatherPresentation(e.weather, world);
  setEncounterEvent(e, `气候更新：${presentation.detail}`);
  renderEncounter(); scheduleAutosave();
}

function generateWeatherFromClimate() {
  const e = encounterState();
  const presentation = generateClimateWeather(e, $('#weather-climate').value, worldTimeNow(e));
  setEncounterEvent(e, `按气候生成：${presentation.detail}`);
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
  const wasRunning = Boolean(e.worldTime.runningSince);
  materializeWorldTime(e);
  e.worldTime.totalSeconds = ((year - 1) * WORLD_MINUTES_PER_YEAR * 60)
    + ((week - 1) * WORLD_DAYS_PER_WEEK * WORLD_MINUTES_PER_DAY * 60)
    + ((day - 1) * WORLD_MINUTES_PER_DAY * 60)
    + (hour * 3600) + (minute * 60) + second;
  if (wasRunning && e.playMode !== 'turn') e.worldTime.runningSince = Date.now();
  const world = worldTimeParts(e.worldTime.totalSeconds);
  const automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
  setEncounterEvent(e, `时间调整为：${formatWorldDate(world)} ${formatWorldClock(world)}${automaticWeather ? `；天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C` : ''}`);
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

function mapGridVisible(map = activeMap()) {
  return map ? map.gridVisible !== false : state.showGrid !== false;
}

function syncActiveMapGridSetting() {
  const visible = mapGridVisible();
  state.showGrid = visible;
  const toggle = $('#grid-toggle');
  if (toggle) toggle.checked = visible;
}

function makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants, gridVisible = true) {
  return {
    id: 'm' + (uid++),
    name: name || '未命名地图',
    mapData: dataUrl || null,
    mapW: w || 1400,
    mapH: h || 900,
    gridSize: gridSize || 50,
    gridVisible: gridVisible !== false,
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

function addMap(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants, gridVisible = true) {
  const m = makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates, cellVariants, gridVisible);
  state.maps.push(m);
  switchMap(m.id);
  fitView();
  return m;
}

function switchMap(id) {
  const m = mapById(id);
  if (!m) return;
  state.activeMapId = id;
  syncActiveMapGridSetting();
  state.selectedId = null;
  spellAimTokenId = null;
  cancelMapReaction();
  const reactionLayer = $('#reaction-layer');
  if (reactionLayer) reactionLayer.innerHTML = '';
  boardTool = null;
  syncBoardTools();
  syncMapSelect();
  applyActiveMap();
  scheduleAutosave();
}

function deleteMapById(mapId) {
  if (state.maps.length <= 1) {
    toast('至少保留一张地图');
    return;
  }
  const m = mapById(mapId);
  if (!m || !confirm(`确定删除地图「${m.name}」？该地图上的棋子会一并删除。`)) return;
  const mapIndex = state.maps.findIndex((map) => map.id === m.id);
  const wasActive = m.id === state.activeMapId;
  const invalidatesTurn = m.tokens.some((token) => currentTurnIncludesToken(token.id));
  const pruned = pruneInitiativeTokenRefs(new Set(m.tokens.map((token) => token.id)));
  state.maps = state.maps.filter((x) => x.id !== m.id);
  if (wasActive) {
    state.activeMapId = state.maps[Math.min(mapIndex, state.maps.length - 1)].id;
    state.selectedId = null;
    syncActiveMapGridSetting();
  }
  syncMapSelect();
  if (wasActive) applyActiveMap();
  else renderMapBrowser();
  if (encounterState().playMode === 'turn' && (invalidatesTurn || pruned.removed)) bumpEncounterTurn(encounterState());
  if (pruned.removed) renderEncounter();
  renderTurnPath();
  scheduleAutosave();
  toast(`已删除地图「${m.name}」`);
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
  const browserModal = $('#map-browser-modal');
  if (browserModal && !browserModal.hidden) renderMapBrowser();
}

function mapNameFromFile(fileName) {
  return String(fileName || '导入地图')
    .replace(/\.[^.]+$/, '')
    .trim()
    .slice(0, 60) || '导入地图';
}

function uniqueMapName(rawName, usedNames = null) {
  const used = usedNames || new Set(state.maps.map((map) => String(map.name || '').toLocaleLowerCase('zh-CN')));
  const base = String(rawName || '导入地图').trim().slice(0, 60) || '导入地图';
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLocaleLowerCase('zh-CN'))) {
    candidate = `${base} ${suffix++}`;
  }
  used.add(candidate.toLocaleLowerCase('zh-CN'));
  return candidate;
}

function drawMapThumbnailBase(canvas, map) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = g.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#202633');
  gradient.addColorStop(1, '#0e1118');
  g.fillStyle = gradient;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(255,255,255,.055)';
  g.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 48) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, canvas.height); g.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 48) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(canvas.width, y); g.stroke();
  }
  if (!map?.mapData) {
    g.fillStyle = 'rgba(224,179,76,.85)';
    g.font = '700 42px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('空白地图', canvas.width / 2, canvas.height / 2);
  }
}

function paintMapThumbnail(canvas, map, renderToken) {
  if (!canvas || !map) return;
  canvas.dataset.renderToken = String(renderToken);
  drawMapThumbnailBase(canvas, map);
  if (!map.mapData) return;
  const cached = mapThumbnailCache.get(map.id);
  const cacheValid = cached
    && cached.source === map.mapData
    && cached.mapW === map.mapW
    && cached.mapH === map.mapH;
  const img = new Image();
  img.onload = () => {
    if (!canvas.isConnected || canvas.dataset.renderToken !== String(renderToken)) return;
    const g = canvas.getContext('2d');
    drawMapThumbnailBase(canvas, { ...map, mapData: null });
    const imageW = img.naturalWidth || img.width;
    const imageH = img.naturalHeight || img.height;
    if (!imageW || !imageH) return;
    const scale = Math.min(canvas.width / imageW, canvas.height / imageH);
    const drawW = imageW * scale;
    const drawH = imageH * scale;
    const drawX = (canvas.width - drawW) / 2;
    const drawY = (canvas.height - drawH) / 2;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, drawX, drawY, drawW, drawH);
    if (!cacheValid) {
      try {
        mapThumbnailCache.set(map.id, {
          source: map.mapData,
          mapW: map.mapW,
          mapH: map.mapH,
          preview: canvas.toDataURL('image/jpeg', .76),
        });
      } catch (e) { /* 跨域图片仍能显示，只是不写缩略图缓存 */ }
    }
  };
  img.onerror = () => {
    if (!canvas.isConnected || canvas.dataset.renderToken !== String(renderToken)) return;
    const g = canvas.getContext('2d');
    g.fillStyle = '#9aa3b2';
    g.font = '24px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('预览不可用', canvas.width / 2, canvas.height / 2);
  };
  img.src = cacheValid ? cached.preview : map.mapData;
}

function updateMapBrowserScrollButtons() {
  const strip = $('#map-thumbnail-strip');
  const left = $('#btn-map-scroll-left');
  const right = $('#btn-map-scroll-right');
  if (!strip || !left || !right) return;
  const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);
  left.disabled = strip.scrollLeft <= 2;
  right.disabled = strip.scrollLeft >= maxScroll - 2;
}

function renderMapBrowser(focusActive = false) {
  const strip = $('#map-thumbnail-strip');
  if (!strip) return;
  const liveMapIds = new Set(state.maps.map((map) => map.id));
  for (const cachedId of mapThumbnailCache.keys()) {
    if (!liveMapIds.has(cachedId)) mapThumbnailCache.delete(cachedId);
  }
  const previousScroll = strip.scrollLeft;
  const renderToken = ++mapBrowserRenderToken;
  const count = $('#map-browser-count');
  if (count) count.textContent = `${state.maps.length} 张地图`;
  strip.innerHTML = '';
  if (!state.maps.length) {
    const empty = document.createElement('div');
    empty.className = 'map-thumbnail-empty';
    empty.textContent = '当前还没有地图，点击“载入地图”添加第一张地图。';
    strip.appendChild(empty);
    requestAnimationFrame(updateMapBrowserScrollButtons);
    return;
  }

  state.maps.forEach((map, index) => {
    const card = document.createElement('article');
    card.className = `map-thumb-card${map.id === state.activeMapId ? ' active' : ''}`;
    card.dataset.mapId = map.id;

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'map-thumb-open';
    open.dataset.mapOpen = map.id;
    open.setAttribute('aria-label', `切换到地图 ${map.name}`);

    const preview = document.createElement('div');
    preview.className = 'map-thumb-preview';
    const canvas = document.createElement('canvas');
    canvas.width = MAP_THUMBNAIL_WIDTH;
    canvas.height = MAP_THUMBNAIL_HEIGHT;
    canvas.setAttribute('aria-hidden', 'true');
    preview.appendChild(canvas);

    const orderBadge = document.createElement('span');
    orderBadge.className = 'map-thumb-order-badge';
    orderBadge.textContent = `#${index + 1}`;
    preview.appendChild(orderBadge);
    if (map.id === state.activeMapId) {
      const activeBadge = document.createElement('span');
      activeBadge.className = 'map-thumb-active-badge';
      activeBadge.textContent = '当前';
      preview.appendChild(activeBadge);
    }

    const copy = document.createElement('span');
    copy.className = 'map-thumb-copy';
    const name = document.createElement('span');
    name.className = 'map-thumb-name';
    name.textContent = map.name || '未命名地图';
    name.title = map.name || '未命名地图';
    const meta = document.createElement('span');
    meta.className = 'map-thumb-meta';
    meta.textContent = `${map.mapW || 0} × ${map.mapH || 0} · ${mapGridVisible(map) ? `网格 ${map.gridSize || 50}px` : `无网格 · ${map.gridSize || 50}px/5尺`}`;
    copy.append(name, meta);
    open.append(preview, copy);

    const management = document.createElement('div');
    management.className = 'map-thumb-management';
    const gridToggleLabel = document.createElement('label');
    gridToggleLabel.className = 'map-thumb-grid-toggle';
    gridToggleLabel.title = '只控制这张地图是否显示网格';
    const gridToggle = document.createElement('input');
    gridToggle.type = 'checkbox';
    gridToggle.checked = mapGridVisible(map);
    gridToggle.dataset.mapGridVisible = map.id;
    const gridToggleText = document.createElement('span');
    gridToggleText.textContent = '显示网格';
    gridToggleLabel.append(gridToggle, gridToggleText);
    const gridSize = document.createElement('input');
    gridSize.className = 'map-thumb-grid-size';
    gridSize.type = 'number';
    gridSize.min = '10';
    gridSize.max = '300';
    gridSize.step = '1';
    gridSize.value = String(map.gridSize || 50);
    const workshopGrid = Array.isArray(map.cells);
    gridSize.disabled = workshopGrid;
    gridSize.dataset.mapGridSize = map.id;
    gridSize.title = workshopGrid ? '地图工坊的网格大小由地图文件决定' : '每格像素（每格代表 5 尺）';
    gridSize.setAttribute('aria-label', `${map.name} 的每格像素`);
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.dataset.mapRename = map.id;
    rename.title = '重命名地图';
    rename.setAttribute('aria-label', `重命名 ${map.name}`);
    rename.textContent = '✎';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'map-thumb-delete';
    remove.dataset.mapDelete = map.id;
    remove.title = state.maps.length > 1 ? '删除地图' : '至少保留一张地图';
    remove.setAttribute('aria-label', `删除 ${map.name}`);
    remove.textContent = '×';
    remove.disabled = state.maps.length <= 1;
    management.append(gridToggleLabel, gridSize, rename, remove);

    const actions = document.createElement('div');
    actions.className = 'map-thumb-actions';
    const moveLeft = document.createElement('button');
    moveLeft.type = 'button';
    moveLeft.dataset.mapStep = '-1';
    moveLeft.dataset.mapId = map.id;
    moveLeft.title = '向前移动';
    moveLeft.setAttribute('aria-label', `将 ${map.name} 向前移动`);
    moveLeft.textContent = '←';
    moveLeft.disabled = index === 0;
    const dragHint = document.createElement('span');
    dragHint.className = 'map-thumb-drag-hint';
    dragHint.dataset.mapDragHandle = map.id;
    dragHint.title = state.maps.length > 1 ? '按住并拖动以调整顺序' : '';
    dragHint.textContent = state.maps.length > 1 ? '⠿ 拖动排序' : '仅一张地图';
    const moveRight = document.createElement('button');
    moveRight.type = 'button';
    moveRight.dataset.mapStep = '1';
    moveRight.dataset.mapId = map.id;
    moveRight.title = '向后移动';
    moveRight.setAttribute('aria-label', `将 ${map.name} 向后移动`);
    moveRight.textContent = '→';
    moveRight.disabled = index === state.maps.length - 1;
    actions.append(moveLeft, dragHint, moveRight);
    card.append(open, management, actions);
    strip.appendChild(card);
    paintMapThumbnail(canvas, map, renderToken);
  });

  requestAnimationFrame(() => {
    if (focusActive) {
      strip.querySelector('.map-thumb-card.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    } else {
      strip.scrollLeft = previousScroll;
    }
    updateMapBrowserScrollButtons();
  });
}

function openMapBrowser() {
  const modal = $('#map-browser-modal');
  if (!modal) return;
  modal.hidden = false;
  renderMapBrowser(true);
}

function closeMapBrowser() {
  const modal = $('#map-browser-modal');
  if (modal) modal.hidden = true;
  mapBrowserPointerDrag = null;
  clearMapDropIndicators();
  document.querySelectorAll('.map-thumb-card.dragging').forEach((card) => card.classList.remove('dragging'));
}

function clearMapDropIndicators() {
  document.querySelectorAll('.map-thumb-card.drop-before,.map-thumb-card.drop-after')
    .forEach((card) => card.classList.remove('drop-before', 'drop-after'));
}

function moveMapBy(mapId, step) {
  const from = state.maps.findIndex((map) => map.id === mapId);
  const to = clamp(from + Number(step || 0), 0, Math.max(0, state.maps.length - 1));
  if (from < 0 || from === to) return;
  const [map] = state.maps.splice(from, 1);
  state.maps.splice(to, 0, map);
  syncMapSelect();
  scheduleAutosave();
  toast(`已将「${map.name}」移到第 ${to + 1} 位`);
}

function reorderMapAround(mapId, targetId, placeAfter) {
  if (!mapId || !targetId || mapId === targetId) return;
  const from = state.maps.findIndex((map) => map.id === mapId);
  if (from < 0) return;
  const [map] = state.maps.splice(from, 1);
  let targetIndex = state.maps.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) {
    state.maps.splice(from, 0, map);
    return;
  }
  if (placeAfter) targetIndex += 1;
  state.maps.splice(targetIndex, 0, map);
  syncMapSelect();
  scheduleAutosave();
  toast(`地图顺序已更新：「${map.name}」现在是第 ${targetIndex + 1} 张`);
}

function renameMapById(mapId) {
  const map = mapById(mapId);
  if (!map) return;
  const name = prompt('地图名称', map.name || '未命名地图');
  if (name === null || !name.trim()) return;
  map.name = name.trim().slice(0, 60);
  syncMapSelect();
  scheduleAutosave();
}

function setMapGridVisibility(mapId, visible) {
  const map = mapById(mapId);
  if (!map) return;
  map.gridVisible = Boolean(visible);
  if (map.id === state.activeMapId) {
    syncActiveMapGridSetting();
    updateWorldBackground();
  }
  renderMapBrowser();
  scheduleAutosave();
}

function setMapGridSize(mapId, value) {
  const map = mapById(mapId);
  if (!map || Array.isArray(map.cells)) return;
  const next = clamp(Math.round(Number(value) || map.gridSize || 50), 10, 300);
  if (next === map.gridSize) {
    renderMapBrowser();
    return;
  }
  map.gridSize = next;
  if (map.id === state.activeMapId) applyActiveMap();
  renderMapBrowser();
  scheduleAutosave();
  toast(`「${map.name}」网格已调整为 ${next}px/格`);
}

/* ==================== 高清头像（IndexedDB 存储） ==================== */

const AVATAR_DB = 'dnd-board-assets';
const AVATAR_HD_MAX = 2048;      // 高清上限：上传图最高保留 2048px
const AVATAR_DISPLAY_MAX = 512;  // 显示上限：地图/卡片渲染时自动降到 512px，避免大纹理拖图卡顿
const AVATAR_LOW_MAX = 192;      // 常规显示版：足够覆盖高分屏小棋子，同时维持轻量纹理
const AVATAR_LOW_CACHE_SUFFIX = '@s192';
const PORTRAIT_LOD_SWITCH_UP = 168;
const PORTRAIT_LOD_SWITCH_DOWN = 136;
const avatarCache = new Map();
const avatarLowCache = new Map(); // iconImgId -> 192px 常规显示版
const avatarLodEls = new Map();  // iconImgId -> Set<DOM元素>，用于缩放时切换画质
const portraitLodProbes = new Map(); // 静态显示缓存 URL -> boolean | Promise<boolean>
let lastAvatarZoom = null;
let avatarLodFrame = 0;
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

function portraitLodRelativePath(path, tier) {
  const normalized = canonicalPortraitPath(path);
  if (!normalized || /^(?:data:|blob:|https?:|\/)/.test(normalized)) return null;
  const sourceRelative = normalized.replace(/^立绘\//, '');
  if (sourceRelative === normalized) return null;
  const webpRelative = sourceRelative.replace(/\.[^./]+$/, '.webp');
  return `显示缓存/${tier === AVATAR_DISPLAY_MAX ? AVATAR_DISPLAY_MAX : AVATAR_LOW_MAX}/${webpRelative}`;
}

function portraitLodAssetUrl(path, tier) {
  const relative = portraitLodRelativePath(path, tier);
  return relative ? portraitAssetUrl(relative) : portraitAssetUrl(path);
}

function setAvatarBackground(el, url) {
  if (!url || el.dataset.lodUrl === url) return;
  el.dataset.lodUrl = url;
  el.style.backgroundImage = `url("${url}")`;
}

function probePortraitLod(url) {
  const known = portraitLodProbes.get(url);
  if (known === true || known === false) return Promise.resolve(known);
  if (known) return known;
  const pending = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  }).then((ok) => {
    portraitLodProbes.set(url, ok);
    return ok;
  });
  portraitLodProbes.set(url, pending);
  return pending;
}

function applyPortraitBackground(el, path, tier) {
  const original = portraitAssetUrl(path);
  const candidate = portraitLodAssetUrl(path, tier);
  el.dataset.portraitTier = String(tier);
  if (!candidate || candidate === original) {
    setAvatarBackground(el, original);
    return;
  }
  const known = portraitLodProbes.get(candidate);
  if (known === false) {
    setAvatarBackground(el, original);
    return;
  }
  setAvatarBackground(el, candidate);
  if (known === true) return;
  probePortraitLod(candidate).then((ok) => {
    if (!ok && el.isConnected && el.dataset.lodUrl === candidate) setAvatarBackground(el, original);
  });
}

function applyPortraitImage(el, path, tier = AVATAR_DISPLAY_MAX) {
  const original = portraitAssetUrl(path);
  const candidate = portraitLodAssetUrl(path, tier);
  el.dataset.portraitUrl = candidate;
  el.onerror = () => {
    if (el.dataset.portraitUrl !== candidate) return;
    el.dataset.portraitUrl = original;
    el.onerror = null;
    el.src = original;
  };
  el.src = candidate;
}

function applyAvatar(el, iconImg, iconImgId, iconImgHd, iconImgPath, portraitTier = AVATAR_LOW_MAX) {
  if (iconImg) el.style.backgroundImage = `url("${iconImg}")`;
  if (hdEnabled && iconImgHd) el.style.backgroundImage = `url("${iconImgHd}")`;
  if (iconImgPath) {
    el.style.backgroundSize = '116.3% 116.3%';
    el.style.backgroundPosition = 'center';
    applyPortraitBackground(el, iconImgPath, portraitTier);
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

// 高清入库时顺便生成 512/192 显示版并永久存入高清库，以后读取零计算
async function storeAvatar(id, hd) {
  await avatarPut(id, hd);
  try {
    const [disp, low] = await Promise.all([
      avatarDisplayDataUrl(hd, AVATAR_DISPLAY_MAX),
      avatarDisplayDataUrl(hd, AVATAR_LOW_MAX),
    ]);
    await Promise.all([avatarPut(id + '@d', disp), avatarPut(id + AVATAR_LOW_CACHE_SUFFIX, low)]);
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

// 常规显示版（192px）：高分屏小棋子足够清楚，同时保持纹理轻量
async function avatarGetLow(id) {
  const cached = avatarLowCache.get(id);
  if (cached) return cached;
  const low = await avatarGet(id + AVATAR_LOW_CACHE_SUFFIX);
  if (low) { avatarLowCache.set(id, low); return low; }
  const disp = await avatarGet(id + '@d');
  if (disp) {
    const made = await avatarDisplayDataUrl(disp, AVATAR_LOW_MAX);
    avatarLowCache.set(id, made);
    try { await avatarPut(id + AVATAR_LOW_CACHE_SUFFIX, made); } catch (e) { /* 忽略 */ }
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
    try { await Promise.all([avatarPut(id + '@d', disp2), avatarPut(id + AVATAR_LOW_CACHE_SUFFIX, low2)]); } catch (e) { /* 忽略 */ }
    return low2;
  }
  return null;
}

function tokenPortraitTier(el) {
  if (!hdEnabled) return AVATAR_LOW_MAX;
  const m = activeMap();
  const zoom = m ? m.cam.zoom : 1;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const mapPixels = Math.max(el.offsetWidth || 0, el.offsetHeight || 0);
  const requiredPixels = mapPixels * zoom * dpr * 1.16;
  const currentTier = Number(el.dataset.portraitTier) || AVATAR_LOW_MAX;
  if (currentTier === AVATAR_DISPLAY_MAX) {
    return requiredPixels < PORTRAIT_LOD_SWITCH_DOWN ? AVATAR_LOW_MAX : AVATAR_DISPLAY_MAX;
  }
  return requiredPixels > PORTRAIT_LOD_SWITCH_UP ? AVATAR_DISPLAY_MAX : AVATAR_LOW_MAX;
}

// 自适应画质：小棋子读 192px，放大或大体型时才切换到 512px。
function applyTokenAvatar(el, t) {
  if (t.iconImg) el.style.backgroundImage = `url("${t.iconImg}")`;
  if (hdEnabled && t.iconImgHd) el.style.backgroundImage = `url("${t.iconImgHd}")`;
  const assetKey = t.iconImgId || (t.iconImgPath ? 'path:' + t.iconImgPath : (t.iconImgHd ? 'embedded:' + t.id : ''));
  if (!assetKey) return;
  el.dataset.avatarId = assetKey;
  el.dataset.lod = 'low';
  if (!avatarLodEls.has(assetKey)) avatarLodEls.set(assetKey, new Set());
  avatarLodEls.get(assetKey).add(el);
  refreshAvatarLodElement(el, t);
}

function refreshAvatarLodElement(el, t) {
  if (t.iconImgPath) {
    const tier = tokenPortraitTier(el);
    el.dataset.lod = tier === AVATAR_DISPLAY_MAX ? 'high' : 'low';
    el.style.backgroundSize = '116.3% 116.3%';
    el.style.backgroundPosition = 'center';
    applyPortraitBackground(el, t.iconImgPath, tier);
    return;
  }
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
    if (t.iconImg) el.style.backgroundImage = `url("${t.iconImg}")`;
    if (t.iconImgId && !avatarLowCache.has(t.iconImgId)) {
      avatarGetLow(t.iconImgId).then((lv) => {
        if (lv && el.isConnected && el.dataset.lod === 'low') {
          el.dataset.lodUrl = lv;
          el.style.backgroundImage = `url("${lv}")`;
        }
      }).catch(() => {});
    }
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

function scheduleAvatarLODRefresh() {
  if (avatarLodFrame) return;
  avatarLodFrame = requestAnimationFrame(() => {
    avatarLodFrame = 0;
    refreshAvatarLOD();
  });
}

function syncHdUi() {
  const cb = $('#hd-toggle-check');
  if (cb) cb.checked = hdEnabled;
}

function setHd(on) {
  hdEnabled = !!on;
  try { localStorage.setItem('sangduoer-hd-toggle', hdEnabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
  syncHdUi();
  toast(hdEnabled ? '高清：开（放大时自动切到 512px）' : '高清：关（固定使用 192px 流畅档）');
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
        const low = await avatarGet(id + AVATAR_LOW_CACHE_SUFFIX);
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
const spellRangeCanvas = $('#spell-range-canvas');
const spellRangeCtx = spellRangeCanvas ? spellRangeCanvas.getContext('2d') : null;
const turnPathCanvas = $('#turn-path-canvas');
const turnPathCtx = turnPathCanvas ? turnPathCanvas.getContext('2d') : null;

function spellDirectionLabel(degrees) {
  const labels = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  return `${labels[Math.round((((Number(degrees) || 0) % 360) + 360) % 360 / 45) % 8]} · ${Math.round(Number(degrees) || 0)}°`;
}

function spellRangeSummary(range) {
  const r = normalizeSpellRange(range);
  if (r.shape === 'off') return '未显示';
  return `${r.shape === 'cone' ? '锥形' : '环形'} · ${r.feet} 尺`;
}

function drawSpellRangeForToken(ctx, token, map, selected = false) {
  const range = normalizeSpellRange(token.spellRange);
  if (range.shape === 'off') return;
  const radius = range.feet / 5 * map.gridSize;
  if (!Number.isFinite(radius) || radius <= 0) return;
  const meta = TYPE_META[token.type] || TYPE_META.npc;
  const color = meta.ring || '#6fa4ed';
  const alpha = selected ? .25 : .12;
  const strokeAlpha = selected ? .94 : .56;
  ctx.save();
  ctx.lineWidth = Math.max(2, map.gridSize * (selected ? .055 : .038));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (range.shape === 'cone') {
    const angle = range.direction * Math.PI / 180;
    ctx.moveTo(token.x, token.y);
    ctx.arc(token.x, token.y, radius, angle - SPELL_CONE_HALF_ANGLE, angle + SPELL_CONE_HALF_ANGLE);
    ctx.closePath();
  } else {
    ctx.arc(token.x, token.y, radius, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.globalAlpha = strokeAlpha;
  ctx.setLineDash(selected ? [] : [Math.max(7, map.gridSize * .18), Math.max(5, map.gridSize * .12)]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = selected ? .45 : .23;
  ctx.lineWidth = Math.max(1, map.gridSize * .018);
  if (range.shape === 'radius') {
    const rings = Math.min(6, Math.floor(range.feet / 30));
    for (let i = 1; i <= rings; i++) {
      const ringRadius = radius * i / (rings + 1);
      ctx.beginPath(); ctx.arc(token.x, token.y, ringRadius, 0, Math.PI * 2); ctx.stroke();
    }
  } else {
    const angle = range.direction * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(token.x, token.y); ctx.lineTo(token.x + Math.cos(angle) * radius, token.y + Math.sin(angle) * radius); ctx.stroke();
  }
  const labelAngle = range.shape === 'cone' ? range.direction * Math.PI / 180 : -Math.PI / 2;
  const labelX = token.x + Math.cos(labelAngle) * Math.min(radius * .82, radius - 12);
  const labelY = token.y + Math.sin(labelAngle) * Math.min(radius * .82, radius - 12);
  const fontSize = clamp(map.gridSize * .23, 10, 18);
  ctx.globalAlpha = selected ? .95 : .68;
  ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(3, fontSize * .26); ctx.strokeStyle = 'rgba(9,12,18,.84)';
  ctx.strokeText(`${range.feet} 尺`, labelX, labelY);
  ctx.fillStyle = '#f4f8ff'; ctx.fillText(`${range.feet} 尺`, labelX, labelY);
  ctx.restore();
}

function renderSpellRanges() {
  if (!spellRangeCanvas || !spellRangeCtx) return;
  const map = activeMap();
  if (!map) {
    spellRangeCtx.clearRect(0, 0, spellRangeCanvas.width, spellRangeCanvas.height);
    return;
  }
  if (spellRangeCanvas.width !== map.mapW) spellRangeCanvas.width = map.mapW;
  if (spellRangeCanvas.height !== map.mapH) spellRangeCanvas.height = map.mapH;
  spellRangeCtx.clearRect(0, 0, map.mapW, map.mapH);
  const enabled = map.tokens.filter((token) => normalizeSpellRange(token.spellRange).shape !== 'off');
  enabled.filter((token) => token.id !== state.selectedId).forEach((token) => drawSpellRangeForToken(spellRangeCtx, token, map, false));
  const selected = enabled.find((token) => token.id === state.selectedId);
  if (selected) drawSpellRangeForToken(spellRangeCtx, selected, map, true);
}

function requestSpellRangeRender() {
  if (spellRangeRaf != null) return;
  spellRangeRaf = requestAnimationFrame(() => {
    spellRangeRaf = null;
    renderSpellRanges();
  });
}

function makeReactionId(prefix = 'gm') {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function showMapReaction(action) {
  const map = activeMap();
  const layer = $('#reaction-layer');
  if (!map || !layer || action?.mapId !== map.id || !MAP_REACTION_EMOJIS.has(action.emoji)) return;
  const x = clamp(Number(action.x) || 0, 0, map.mapW);
  const y = clamp(Number(action.y) || 0, 0, map.mapH);
  const item = document.createElement('div');
  item.className = 'map-reaction';
  item.dataset.reactionId = String(action.reactionId || '');
  item.style.left = `${x}px`;
  item.style.top = `${y}px`;
  item.style.setProperty('--reaction-scale', String(1 / clamp(Number(map.cam?.zoom) || 1, .2, 4)));
  const bubble = document.createElement('div');
  bubble.className = 'map-reaction-bubble';
  const emoji = document.createElement('span');
  emoji.className = 'map-reaction-emoji';
  emoji.textContent = action.emoji;
  const author = document.createElement('span');
  author.className = 'map-reaction-author';
  author.textContent = String(action.name || 'GM').slice(0, 24);
  bubble.append(emoji, author);
  item.appendChild(bubble);
  layer.appendChild(item);
  setTimeout(() => item.remove(), 2850);
}

function syncMapReactionUi() {
  const palette = $('#map-reaction-palette');
  const trigger = $('#btn-map-reaction');
  const placing = Boolean(pendingMapReaction);
  if (trigger) trigger.classList.toggle('active', placing || (palette && !palette.hidden));
  board.classList.toggle('reaction-placing', placing);
  palette?.querySelectorAll('[data-map-reaction]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mapReaction === pendingMapReaction);
  });
}

function toggleMapReactionPalette() {
  const palette = $('#map-reaction-palette');
  if (!palette) return;
  if (!palette.hidden) {
    palette.hidden = true;
    pendingMapReaction = null;
  } else {
    cancelSpellAim();
    palette.hidden = false;
  }
  syncMapReactionUi();
}

function selectMapReaction(emoji) {
  if (!MAP_REACTION_EMOJIS.has(emoji)) return;
  cancelSpellAim();
  pendingMapReaction = emoji;
  const palette = $('#map-reaction-palette');
  if (palette) palette.hidden = true;
  syncMapReactionUi();
  toast('点击地图发送表情；按 Esc 取消');
}

function cancelMapReaction() {
  pendingMapReaction = null;
  const palette = $('#map-reaction-palette');
  if (palette) palette.hidden = true;
  syncMapReactionUi();
}

function placeHostReactionAt(clientX, clientY) {
  const map = activeMap();
  if (!map || !pendingMapReaction) return false;
  const rect = board.getBoundingClientRect();
  const action = {
    op: 'mapReaction',
    reactionId: makeReactionId('gm'),
    mapId: map.id,
    x: clamp((clientX - rect.left - map.cam.x) / map.cam.zoom, 0, map.mapW),
    y: clamp((clientY - rect.top - map.cam.y) / map.cam.zoom, 0, map.mapH),
    emoji: pendingMapReaction,
    name: 'GM',
  };
  localReactionIds.add(action.reactionId);
  setTimeout(() => localReactionIds.delete(action.reactionId), 5000);
  showMapReaction(action);
  cancelMapReaction();
  sendHostAction(action).then((result) => {
    if (!result.ok || result.data?.ok === false) toast(`⚠ 表情只在本机显示：${result.data?.error || '服务器未连接'}`);
  }).catch(() => toast('⚠ 表情只在本机显示：服务器未连接'));
  return true;
}

/* ==================== 地图载入 ==================== */

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
      const gridVisible = typeof s.gridVisible === 'boolean' ? s.gridVisible : s.showGrid !== false;
      const m = addMap(s.mapName || '导入地图', dataUrl, s.mapW, s.mapH, s.gridSize, cells, cellStates, cellVariants, gridVisible);
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

function isSupportedDirectMapImage(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name || '');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('bad image data'));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function inspectDirectMapImage(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('empty image'));
        return;
      }
      resolve({
        file,
        objectUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        name: mapNameFromFile(file.name),
        gridSize: clamp(Number(activeMap()?.gridSize) || 50, 10, 300),
        gridVisible: true,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('bad image'));
    };
    img.src = objectUrl;
  });
}

function releasePendingMapImageImports() {
  pendingMapImageImports.forEach((item) => {
    try { URL.revokeObjectURL(item.objectUrl); } catch (e) { /* 忽略 */ }
  });
  pendingMapImageImports = [];
}

function renderMapImageImportList() {
  const list = $('#map-image-import-list');
  const confirmButton = $('#btn-map-image-import-confirm');
  const sizeLabel = $('#map-image-import-size');
  if (!list || !confirmButton || !sizeLabel) return;
  list.innerHTML = '';
  if (!pendingMapImageImports.length) {
    const empty = document.createElement('div');
    empty.className = 'map-image-import-empty';
    empty.textContent = '还没有选择图片。点击“继续选择”添加地图。';
    list.appendChild(empty);
  }

  pendingMapImageImports.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'map-image-import-row';
    const preview = document.createElement('img');
    preview.className = 'map-image-import-preview';
    preview.src = item.objectUrl;
    preview.alt = '';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'map-image-import-name';
    nameLabel.textContent = '地图名称';
    const nameInput = document.createElement('input');
    nameInput.value = item.name;
    nameInput.maxLength = 60;
    nameInput.dataset.mapImportName = String(index);
    const fileMeta = document.createElement('span');
    fileMeta.className = 'map-image-import-file-meta';
    fileMeta.textContent = `${item.width} × ${item.height} · ${(item.file.size / 1024 / 1024).toFixed(1)} MB`;
    fileMeta.title = item.file.name || '';
    nameLabel.append(nameInput, fileMeta);

    const gridLabel = document.createElement('div');
    gridLabel.className = 'map-image-import-grid';
    gridLabel.classList.toggle('no-grid', !item.gridVisible);
    const gridHead = document.createElement('label');
    gridHead.className = 'map-image-import-grid-head';
    const gridToggle = document.createElement('input');
    gridToggle.type = 'checkbox';
    gridToggle.checked = item.gridVisible !== false;
    gridToggle.dataset.mapImportGridVisible = String(index);
    const gridHeadText = document.createElement('span');
    gridHeadText.textContent = '显示网格';
    gridHead.append(gridToggle, gridHeadText);
    const gridSizeWrap = document.createElement('label');
    gridSizeWrap.className = 'map-image-import-grid-size';
    const gridSizeText = document.createElement('span');
    gridSizeText.textContent = '每格像素';
    const gridInput = document.createElement('input');
    gridInput.type = 'number';
    gridInput.min = '10';
    gridInput.max = '300';
    gridInput.step = '1';
    gridInput.value = String(item.gridSize);
    gridInput.dataset.mapImportGrid = String(index);
    gridSizeWrap.append(gridSizeText, gridInput);
    gridLabel.append(gridHead, gridSizeWrap);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'map-image-import-remove';
    remove.dataset.mapImportRemove = String(index);
    remove.setAttribute('aria-label', `移除 ${item.name}`);
    remove.title = '移除这张图片';
    remove.textContent = '✕';
    row.append(preview, nameLabel, gridLabel, remove);
    list.appendChild(row);
  });

  const totalBytes = pendingMapImageImports.reduce((sum, item) => sum + (Number(item.file.size) || 0), 0);
  sizeLabel.textContent = pendingMapImageImports.length
    ? `准备导入 ${pendingMapImageImports.length} 张，原文件合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
    : '';
  sizeLabel.classList.toggle('warning', totalBytes > 10 * 1024 * 1024);
  confirmButton.disabled = mapImageImportBusy || !pendingMapImageImports.length;
  $('#btn-map-image-import-more').disabled = mapImageImportBusy || pendingMapImageImports.length >= MAX_DIRECT_MAP_IMPORTS;
  $('#btn-map-image-import-cancel').disabled = mapImageImportBusy;
}

async function appendDirectMapImages(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const available = Math.max(0, MAX_DIRECT_MAP_IMPORTS - pendingMapImageImports.length);
  const selected = files.filter(isSupportedDirectMapImage).slice(0, available);
  const rejected = files.length - selected.length;
  $('#map-image-import-modal').hidden = false;
  renderMapImageImportList();
  for (const file of selected) {
    try {
      pendingMapImageImports.push(await inspectDirectMapImage(file));
      renderMapImageImportList();
    } catch (e) {
      toast(`无法读取地图图片：${file.name || '未知文件'}`);
    }
  }
  if (rejected > 0) toast(`已忽略 ${rejected} 个不支持的文件或超出数量上限的文件`);
}

async function loadSelectedMapFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const images = files.filter(isSupportedDirectMapImage);
  const workshopFiles = files.filter((file) => !isSupportedDirectMapImage(file)
    && (/\.json$/i.test(file.name || '') || String(file.type || '').toLowerCase() === 'application/json'));
  const unsupported = files.length - images.length - workshopFiles.length;
  workshopFiles.forEach(importMapFile);
  if (images.length) await appendDirectMapImages(images);
  if (unsupported > 0) toast(`已忽略 ${unsupported} 个不支持的文件`);
}

function closeDirectMapImport() {
  if (mapImageImportBusy) return;
  releasePendingMapImageImports();
  $('#map-image-import-modal').hidden = true;
  renderMapImageImportList();
}

async function confirmDirectMapImport() {
  if (mapImageImportBusy || !pendingMapImageImports.length) return;
  mapImageImportBusy = true;
  const button = $('#btn-map-image-import-confirm');
  const originalLabel = button.textContent;
  button.textContent = '正在导入…';
  renderMapImageImportList();
  try {
    const prepared = [];
    for (const item of pendingMapImageImports) {
      prepared.push({
        ...item,
        dataUrl: await readFileAsDataUrl(item.file),
        name: String(item.name || '').trim().slice(0, 60) || mapNameFromFile(item.file.name),
        gridSize: clamp(Math.round(Number(item.gridSize) || 50), 10, 300),
        gridVisible: item.gridVisible !== false,
      });
    }
    const usedNames = new Set(state.maps.map((map) => String(map.name || '').toLocaleLowerCase('zh-CN')));
    const added = prepared.map((item) => makeMapEntry(
      uniqueMapName(item.name, usedNames),
      item.dataUrl,
      item.width,
      item.height,
      item.gridSize,
      null,
      null,
      null,
      item.gridVisible
    ));
    state.maps.push(...added);
    if (added.length) {
      state.activeMapId = added[0].id;
      syncActiveMapGridSetting();
      state.selectedId = null;
      boardTool = null;
      syncBoardTools();
      syncMapSelect();
      applyActiveMap();
      fitView();
      scheduleAutosave();
    }
    releasePendingMapImageImports();
    $('#map-image-import-modal').hidden = true;
    if (!$('#map-browser-modal').hidden) renderMapBrowser(true);
    toast(`已导入 ${added.length} 张地图，当前打开「${added[0]?.name || ''}」`);
  } catch (e) {
    console.warn('导入地图图片失败', e);
    toast('导入失败：至少有一张图片无法读取');
  } finally {
    mapImageImportBusy = false;
    button.textContent = originalLabel;
    renderMapImageImportList();
  }
}

function updateWorldBackground() {
  const m = activeMap();
  const g = m ? m.gridSize : 50;
  const hasMap = !!m && !!m.mapData;
  const showGrid = mapGridVisible(m);
  const gridLayer =
    `repeating-linear-gradient(to right, rgba(255,255,255,.78) 0, rgba(255,255,255,.78) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to bottom, rgba(255,255,255,.78) 0, rgba(255,255,255,.78) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to right, rgba(0,0,0,.16) 0, rgba(0,0,0,.16) 2px, transparent 2px, transparent ${g}px),` +
    `repeating-linear-gradient(to bottom, rgba(0,0,0,.16) 0, rgba(0,0,0,.16) 2px, transparent 2px, transparent ${g}px)`;

  world.style.backgroundColor = hasMap ? 'transparent' : (showGrid ? '#ddd6c2' : '#0f1116');

  if (hasMap) {
    world.style.backgroundImage = showGrid
      ? `${gridLayer}, url("${m.mapData}")`
      : `url("${m.mapData}")`;
    world.style.backgroundSize = showGrid
      ? `${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, 100% 100%`
      : '100% 100%';
  } else {
    world.style.backgroundImage = showGrid ? gridLayer : 'none';
    world.style.backgroundSize = showGrid ? `${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px, ${g}px ${g}px` : '';
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
    scheduleAvatarLODRefresh();
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

function normalizeSpellRange(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const shape = source.shape === 'radius' || source.shape === 'cone' ? source.shape : 'off';
  const rawFeet = Number(source.feet);
  const feet = clamp(
    Math.round((Number.isFinite(rawFeet) ? rawFeet : 30) / SPELL_RANGE_STEP_FEET) * SPELL_RANGE_STEP_FEET,
    SPELL_RANGE_MIN_FEET,
    SPELL_RANGE_MAX_FEET,
  );
  const rawDirection = Number(source.direction);
  const direction = Number.isFinite(rawDirection)
    ? ((Math.round(rawDirection / 5) * 5) % 360 + 360) % 360
    : 0;
  return { shape, feet, direction };
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
    spellRange: normalizeSpellRange(t.spellRange),
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

function appendConditionBadges(container, rawConditions, includeGm = false) {
  const conditions = (Array.isArray(rawConditions) ? rawConditions : [])
    .filter((condition) => includeGm || condition.visibility !== 'gm');
  if (!conditions.length) return;
  const badges = document.createElement('div');
  badges.className = 'token-condition-badges';
  conditions.slice(0, 3).forEach((condition) => {
    const badge = document.createElement('span');
    badge.className = 'token-condition-badge';
    badge.style.setProperty('--condition-color', condition.color || '#a8b3c7');
    if (CONDITION_META[condition.key]) badge.dataset.conditionIcon = condition.key;
    badge.textContent = condition.icon || '◆';
    badge.title = `${condition.label || '状态'}${condition.remainingTurns ? ` · 剩余 ${condition.remainingTurns} 回合` : ''}${condition.visibility === 'gm' ? ' · 仅 GM' : ''}`;
    badges.appendChild(badge);
  });
  if (conditions.length > 3) {
    const more = document.createElement('span');
    more.className = 'token-condition-badge more';
    more.textContent = `+${conditions.length - 3}`;
    more.title = `另有 ${conditions.length - 3} 个状态`;
    badges.appendChild(more);
  }
  container.appendChild(badges);
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
  el.style.setProperty('--ring', meta.ring);

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
  // 主控台能看到公开与仅 GM 状态；玩家端会继续过滤仅 GM 状态。
  appendConditionBadges(el, t.conditions, true);

  // 骑乘：坐骑上叠加骑手小圆 + 🐎 标记
  if (m && t.size >= 2) {
    const riders = m.tokens.filter((r) => r.mountId === t.id);
    if (riders.length) {
      const chainBadge = document.createElement('span');
      chainBadge.className = 'mount-chain-badge';
      chainBadge.textContent = riders.length > 1 ? `🔗${riders.length}` : '🔗';
      chainBadge.title = `骑乘联动：${t.name} + ${riders.map((r) => r.name).join('、')}`;
      chainBadge.setAttribute('aria-label', chainBadge.title);
      el.appendChild(chainBadge);
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
        appendConditionBadges(rd, r.conditions, true);
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
  renderSpellRanges();
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
  const changed = state.selectedId !== id;
  state.selectedId = id;
  const unitCard = document.querySelector('#unit-card');
  if (unitCard) unitCard.classList.remove('collapsed');
  if (changed) {
    detailActiveTab = 'status';
    closeConditionEditor();
  }
  renderTokens();
  updateDetail();
  if (changed) requestAnimationFrame(() => {
    const scroll = $('#detail-scroll');
    if (scroll) scroll.scrollTop = 0;
  });
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
  requestSpellRangeRender();
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
  const pruned = pruneInitiativeTokenRefs(new Set([id]));
  // 删除坐骑时，骑手自动下马（留在原地）
  if (m && t.size >= 2) m.tokens.forEach((r) => { if (r.mountId === id) r.mountId = null; });
  if (m) m.tokens = m.tokens.filter((x) => x.id !== id);
  if (m) renumberTokens(m);
  if (state.selectedId === id) state.selectedId = null;
  renderTokens();
  updateDetail();
  if (encounterState().playMode === 'turn' && (invalidatesTurn || pruned.removed)) bumpEncounterTurn(encounterState());
  if (pruned.removed) renderEncounter();
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
  const invalidatesTurn = currentTurnIncludesToken(rider.id) || currentTurnIncludesToken(mount.id);
  rider.mountId = mount.id;
  rider.x = mount.x;
  rider.y = mount.y;
  if (encounterState().playMode === 'turn' && invalidatesTurn) bumpEncounterTurn(encounterState());
  renderTokens();
  renderEncounter();
  updateDetail();
  scheduleAutosave();
  toast(`「${rider.name}」骑上了「${mount.name}」`);
}

function dismountRider(riderId) {
  const rider = findToken(riderId);
  if (!rider || !rider.mountId) return;
  const mount = findToken(rider.mountId);
  const invalidatesTurn = currentTurnIncludesToken(rider.id) || (mount && currentTurnIncludesToken(mount.id));
  rider.mountId = null;
  if (encounterState().playMode === 'turn' && invalidatesTurn) bumpEncounterTurn(encounterState());
  renderTokens();
  renderEncounter();
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
  box.innerHTML = '';
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
  const transferredIds = new Map([[t.id, nt.id]]);
  if (!copy) {
    // 移动坐骑时，骑手跟随；移动骑手时，骑手在目的地自动下马
    if (t.size >= 2) {
      m.tokens.filter((r) => r.mountId === id).forEach((r) => {
        const riderCopy = { ...r, id: 't' + (uid++), mountId: nt.id, x: clamp(r.x, 0, target.mapW), y: clamp(r.y, 0, target.mapH) };
        transferredIds.set(r.id, riderCopy.id);
        target.tokens.push(riderCopy);
      });
    } else if (t.mountId) {
      nt.mountId = null;
    }
    m.tokens = m.tokens.filter((x) => x.id !== id && (t.size < 2 || x.mountId !== id));
    if (state.selectedId === id) state.selectedId = null;
  } else if (t.mountId) {
    // 复制一个骑手 → 副本自动下马
    nt.mountId = null;
  }
  target.tokens.push(nt);
  let relinkedInitiative = false;
  if (!copy) {
    const e = encounterState();
    e.entries.forEach((entry) => {
      const nextId = entry.tokenId ? transferredIds.get(entry.tokenId) : null;
      if (!nextId) return;
      entry.tokenId = nextId;
      relinkedInitiative = true;
    });
    if (e.playMode === 'turn' && (invalidatesTurn || relinkedInitiative)) bumpEncounterTurn(e);
  }
  renumberTokens(target);
  if (!copy) renumberTokens(m);
  switchMap(target.id);
  selectToken(nt.id);
  if (relinkedInitiative) renderEncounter();
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
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'condition-main';
    edit.textContent = `${condition.icon || '◆'} ${condition.label} · ${condition.remainingTurns ? `${condition.remainingTurns} 回合` : '永久'}`;
    edit.title = '编辑状态与持续时间';
    edit.addEventListener('click', () => openConditionEditor(condition.id));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'condition-visibility';
    toggle.textContent = condition.visibility === 'gm' ? '🔒' : '👁';
    toggle.title = condition.visibility === 'gm' ? '仅 GM 可见；点击改为玩家可见' : '玩家可见；点击改为仅 GM';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => {
      condition.visibility = condition.visibility === 'gm' ? 'public' : 'gm';
      if (editingConditionId === condition.id) setConditionVisibilityDraft(condition.visibility);
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
      if (editingConditionId === condition.id) closeConditionEditor();
      renderDetailConditions(t);
      renderTokens();
      scheduleAutosave();
    });
    chip.append(edit, toggle, remove);
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

function syncConditionCustomFields() {
  const custom = $('#detail-condition-custom-fields');
  if (custom) custom.hidden = $('#detail-condition-select')?.value !== 'custom';
}

function setConditionDurationDraft(value) {
  const normalized = value == null ? '' : String(value);
  const input = $('#detail-condition-turns');
  if (input) input.value = normalized;
  document.querySelectorAll('[data-condition-duration]').forEach((button) => {
    button.classList.toggle('active', button.dataset.conditionDuration === normalized);
  });
}

function syncConditionDurationButtons() {
  const value = String($('#detail-condition-turns')?.value || '');
  document.querySelectorAll('[data-condition-duration]').forEach((button) => {
    button.classList.toggle('active', button.dataset.conditionDuration === value);
  });
}

function setConditionVisibilityDraft(value) {
  const normalized = value === 'gm' ? 'gm' : 'public';
  document.querySelectorAll('[data-condition-visibility]').forEach((button) => {
    const active = button.dataset.conditionVisibility === normalized;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function closeConditionEditor() {
  editingConditionId = null;
  const editor = $('#detail-condition-editor');
  if (editor) editor.hidden = true;
}

function openConditionEditor(conditionId = null) {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  const editor = $('#detail-condition-editor');
  if (!t || !editor) return;
  const condition = conditionId ? (t.conditions || []).find((item) => item.id === conditionId) : null;
  editingConditionId = condition?.id || null;
  editor.hidden = false;
  $('#detail-condition-editor-title').textContent = condition ? '编辑状态' : '添加状态';
  $('#btn-detail-condition-add').textContent = condition ? '保存状态' : '添加状态';
  const select = $('#detail-condition-select');
  const knownKey = condition && CONDITION_META[condition.key] ? condition.key : 'custom';
  select.value = condition ? knownKey : '';
  $('#detail-condition-custom-name').value = condition && knownKey === 'custom' ? condition.label : '';
  $('#detail-condition-custom-icon').value = condition && knownKey === 'custom' ? (condition.icon || '◆') : '◆';
  syncConditionCustomFields();
  setConditionDurationDraft(condition ? (condition.remainingTurns ?? '') : '1');
  setConditionVisibilityDraft(condition?.visibility || 'public');
  requestAnimationFrame(() => {
    if (select.value) {
      const target = select.value === 'custom' ? $('#detail-condition-custom-name') : select;
      target?.focus();
    } else select.focus();
  });
}

function addSelectedCondition() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  const select = $('#detail-condition-select');
  if (!t || !select || !select.value) {
    toast('请先选择一个状态');
    return;
  }
  const key = select.value;
  const meta = CONDITION_META[key] || {};
  let label = meta.label || '';
  let icon = meta.icon || '◆';
  if (key === 'custom') {
    label = $('#detail-condition-custom-name').value.trim().slice(0, 24);
    icon = $('#detail-condition-custom-icon').value.trim().slice(0, 4) || '◆';
    if (!label) {
      toast('请输入自定义状态名称');
      $('#detail-condition-custom-name').focus();
      return;
    }
  }
  const rawTurnsText = $('#detail-condition-turns').value.trim();
  const rawTurns = rawTurnsText === '' ? null : Number(rawTurnsText);
  if (rawTurns !== null && (!Number.isFinite(rawTurns) || rawTurns < 1)) {
    toast('持续回合数必须是 1–999，留空表示永久');
    return;
  }
  const editing = editingConditionId
    ? (t.conditions || []).find((condition) => condition.id === editingConditionId)
    : null;
  const existing = editing || (t.conditions || []).find((condition) => condition.key === key && condition.label === label);
  const visibilityDraft = document.querySelector('[data-condition-visibility].active')?.dataset.conditionVisibility || 'public';
  const visibility = existing && !editing ? existing.visibility : visibilityDraft;
  const condition = normalizeCondition({
    ...(existing || {}), key, label, icon,
    color: meta.color || existing?.color,
    remainingTurns: rawTurns === null ? null : clamp(Math.trunc(rawTurns), 1, 999),
    visibility,
  });
  if (existing) Object.assign(existing, condition);
  else {
    if (!Array.isArray(t.conditions)) t.conditions = [];
    t.conditions.push(condition);
  }
  closeConditionEditor();
  renderDetailConditions(t);
  renderTokens();
  scheduleAutosave();
  toast(existing ? `已更新状态：${condition.label}` : `已添加状态：${condition.label}`);
}

function updateSpellRangeEditor(t) {
  const range = normalizeSpellRange(t.spellRange);
  t.spellRange = range;
  $('#detail-spell-summary').textContent = spellRangeSummary(range);
  document.querySelectorAll('#detail-spell-range [data-spell-shape]').forEach((button) => {
    const active = button.dataset.spellShape === range.shape;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#detail-spell-controls').hidden = range.shape === 'off';
  $('#detail-spell-feet').value = range.feet;
  $('#detail-spell-feet-output').textContent = `${range.feet} 尺`;
  $('#detail-spell-grid-output').textContent = `${range.feet / 5} 格`;
  document.querySelectorAll('#detail-spell-range [data-spell-feet]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.spellFeet) === range.feet);
  });
  $('#detail-spell-direction-row').hidden = range.shape !== 'cone';
  $('#detail-spell-direction').value = range.direction;
  $('#detail-spell-direction-output').textContent = spellDirectionLabel(range.direction);
  const aimButton = $('#btn-detail-spell-aim');
  const aiming = spellAimTokenId === t.id;
  aimButton.classList.toggle('active', aiming);
  aimButton.textContent = aiming ? '按住左键旋转…' : '⌖ 在地图上瞄准';
  board.classList.toggle('spell-aiming', Boolean(spellAimTokenId));
}

function updateSelectedSpellRange(patch) {
  const token = state.selectedId ? findToken(state.selectedId) : null;
  if (!token) return;
  token.spellRange = normalizeSpellRange({ ...token.spellRange, ...patch });
  if (token.spellRange.shape !== 'cone' && spellAimTokenId === token.id) cancelSpellAim({ restore: false });
  updateSpellRangeEditor(token);
  renderSpellRanges();
  scheduleAutosave();
}

function spellDirectionAtClientPoint(token, map, clientX, clientY) {
  if (!token || !map) return null;
  const rect = board.getBoundingClientRect();
  const x = (clientX - rect.left - map.cam.x) / map.cam.zoom;
  const y = (clientY - rect.top - map.cam.y) / map.cam.zoom;
  return ((Math.atan2(y - token.y, x - token.x) * 180 / Math.PI) + 360) % 360;
}

function previewSelectedSpellAimAt(clientX, clientY) {
  const token = spellAimTokenId ? findToken(spellAimTokenId) : null;
  const map = activeMap();
  if (!token || !map) return false;
  const direction = spellDirectionAtClientPoint(token, map, clientX, clientY);
  if (direction == null) return false;
  token.spellRange = normalizeSpellRange({ ...token.spellRange, shape: 'cone', direction });
  updateSpellRangeEditor(token);
  renderSpellRanges();
  return true;
}

function beginSelectedSpellAim(e) {
  const token = spellAimTokenId ? findToken(spellAimTokenId) : null;
  const map = activeMap();
  if (!token || !map) { cancelSpellAim(); return false; }
  drag = {
    mode: 'spell-aim',
    id: token.id,
    mapId: map.id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    previous: { ...normalizeSpellRange(token.spellRange) },
  };
  try { board.setPointerCapture(e.pointerId); } catch (error) { /* 浏览器不支持时仍继续 */ }
  previewSelectedSpellAimAt(e.clientX, e.clientY);
  return true;
}

function finishSelectedSpellAim(e, cancelled = false) {
  const aimDrag = drag && drag.mode === 'spell-aim' ? drag : null;
  if (!aimDrag) return false;
  try {
    if (board.hasPointerCapture?.(aimDrag.pointerId)) board.releasePointerCapture(aimDrag.pointerId);
  } catch (error) { /* 指针捕获可能已由浏览器释放 */ }
  const token = findToken(aimDrag.id);
  const map = activeMap();
  if (!cancelled && token && map && map.id === aimDrag.mapId) {
    previewSelectedSpellAimAt(e.clientX, e.clientY);
  } else if (token) {
    token.spellRange = { ...aimDrag.previous };
  }
  drag = null;
  spellAimTokenId = null;
  board.classList.remove('spell-aiming');
  if (token) {
    updateSpellRangeEditor(token);
    renderSpellRanges();
  }
  if (!cancelled && token && map && map.id === aimDrag.mapId) {
    scheduleAutosave();
    toast(`锥形方向：${spellDirectionLabel(token.spellRange.direction)}`);
  }
  return true;
}

function cancelSpellAim(options = {}) {
  const restore = options.restore !== false;
  const aimDrag = drag && drag.mode === 'spell-aim' ? drag : null;
  const aimingId = aimDrag?.id || spellAimTokenId;
  if (aimDrag) {
    const aimedToken = findToken(aimDrag.id);
    if (restore && aimedToken) aimedToken.spellRange = { ...aimDrag.previous };
    try {
      if (board.hasPointerCapture?.(aimDrag.pointerId)) board.releasePointerCapture(aimDrag.pointerId);
    } catch (error) { /* 指针捕获可能已由浏览器释放 */ }
    drag = null;
  }
  spellAimTokenId = null;
  board.classList.remove('spell-aiming');
  const token = aimingId ? findToken(aimingId) : (state.selectedId ? findToken(state.selectedId) : null);
  if (token) {
    updateSpellRangeEditor(token);
    renderSpellRanges();
  }
}

function setDetailTab(tab, options = {}) {
  const normalized = ['status', 'tactics', 'manage'].includes(tab) ? tab : 'status';
  detailActiveTab = normalized;
  document.querySelectorAll('[data-detail-tab]').forEach((button) => {
    const active = button.dataset.detailTab === normalized;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-detail-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.detailPanel !== normalized;
  });
  if (options.resetScroll !== false) {
    const scroll = $('#detail-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  if (options.focus) $(`[data-detail-tab="${normalized}"]`)?.focus();
}

function syncDetailDraftInput(input, value, tokenId) {
  if (!input) return;
  input.dataset.tokenId = tokenId;
  if (document.activeElement === input && input.dataset.dirty === 'true') return;
  input.value = value;
  input.dataset.dirty = 'false';
}

function updateDetailVitals(t) {
  syncDetailDraftInput($('#detail-hp-current'), t.hp, t.id);
  syncDetailDraftInput($('#detail-hp-max'), t.hpMax, t.id);
  syncDetailDraftInput($('#detail-ac-input'), t.ac, t.id);
  const pct = t.hpMax > 0 ? clamp((t.hp / t.hpMax) * 100, 0, 100) : 0;
  const bar = $('#detail-hp-bar');
  bar.style.width = pct + '%';
  bar.style.background = hpColor(pct);
  const percent = $('#detail-hp-percent');
  percent.textContent = `${Math.round(pct)}%`;
  percent.style.color = hpColor(pct);
  percent.style.borderColor = `${hpColor(pct)}66`;
  const undo = $('#btn-detail-hp-undo');
  undo.disabled = !detailHpUndo || detailHpUndo.tokenId !== t.id;
}

function updateDetailContext(t) {
  const encounter = encounterState();
  const turn = $('#detail-turn-summary');
  if (encounter.playMode === 'turn') {
    const current = isCurrentTurnToken(t);
    turn.textContent = current ? '当前回合' : '等待回合';
    turn.className = `detail-context-badge${current ? ' current' : ''}`;
  } else if (encounter.playMode === 'prepare') {
    turn.textContent = '战斗准备';
    turn.className = 'detail-context-badge';
  } else {
    turn.textContent = '自由模式';
    turn.className = 'detail-context-badge';
  }
  const visibility = $('#detail-visibility-summary');
  visibility.textContent = t.hiddenFromPlayers ? '已对玩家隐藏' : '玩家可见';
  visibility.className = `detail-context-badge ${t.hiddenFromPlayers ? 'hidden' : 'public'}`;
}

function updateDetailHeader(t) {
  const meta = TYPE_META[t.type] || TYPE_META.npc;
  const iconEl = $('#detail-icon');
  if (t.iconImg || t.iconImgHd || t.iconImgPath || t.iconImgId) {
    iconEl.textContent = '';
    iconEl.style.backgroundSize = 'cover';
    iconEl.style.backgroundPosition = 'center';
    applyAvatar(iconEl, t.iconImg, t.iconImgId, t.iconImgHd, t.iconImgPath, AVATAR_DISPLAY_MAX);
  } else {
    iconEl.textContent = t.icon || meta.defaultIcon;
    iconEl.style.backgroundImage = 'none';
  }
  $('#btn-detail-icon-remove').hidden = !(t.iconImg || t.iconImgHd || t.iconImgPath || t.iconImgId);
  const name = $('#detail-name');
  if (document.activeElement !== name) name.value = t.name;
  const typeSel = $('#detail-type-select');
  typeSel.value = t.type;
  typeSel.className = 'type-tag type-select type-' + t.type;
  const iconInput = $('#detail-icon-input');
  if (document.activeElement !== iconInput) iconInput.value = t.icon || '';
  updateDetailContext(t);
}

function populateDetailOwnerOptions(t) {
  const select = $('#detail-owner');
  if (!select) return;
  if (document.activeElement === select) return;
  const online = new Set(streamPlayers
    .filter((player) => player && player.online && String(player.name || '').trim())
    .map((player) => String(player.name).trim()));
  const known = new Set(online);
  (state.maps || []).forEach((m) => (m.tokens || []).forEach((token) => {
    const owner = String(token.owner || '').trim();
    if (owner) known.add(owner);
  }));
  const current = String(t.owner || '').trim();
  if (current) known.add(current);
  const names = [...known].sort((a, b) => {
    if (online.has(a) !== online.has(b)) return online.has(a) ? -1 : 1;
    return a.localeCompare(b, 'zh-CN');
  });
  select.innerHTML = '';
  const gm = document.createElement('option');
  gm.value = '';
  gm.textContent = 'GM 控制';
  select.appendChild(gm);
  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = online.has(name) ? `${name} · 在线` : `${name} · 已记录`;
    select.appendChild(option);
  });
  select.value = current;
}

function updateDetailNotes(t) {
  const publicNote = $('#detail-public-note');
  const gmNote = $('#detail-gm-note');
  if (document.activeElement !== publicNote) publicNote.value = t.publicNote || '';
  if (document.activeElement !== gmNote) gmNote.value = t.gmNote || '';
  $('#detail-public-note-summary').textContent = t.publicNote ? `已填写 ${t.publicNote.length} 字` : '未填写';
  $('#detail-gm-note-summary').textContent = t.gmNote ? `已填写 ${t.gmNote.length} 字` : '未填写';
}

function updateDetailMapOptions() {
  const select = $('#detail-map-move');
  const move = $('#btn-token-move');
  const copy = $('#btn-token-copy');
  if (!select) return;
  const previous = select.value;
  const targets = state.maps.filter((m) => m.id !== state.activeMapId);
  select.innerHTML = '';
  if (!targets.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '没有其他地图';
    select.appendChild(option);
  } else {
    targets.forEach((m) => {
      const option = document.createElement('option');
      option.value = m.id;
      option.textContent = m.name;
      select.appendChild(option);
    });
    if (targets.some((m) => m.id === previous)) select.value = previous;
  }
  select.disabled = !targets.length;
  move.disabled = !targets.length;
  copy.disabled = !targets.length;
}

function scheduleDetailTextSave(markStream = true) {
  detailTextSaveMarksStream = detailTextSaveMarksStream || markStream;
  clearTimeout(detailTextSaveTimer);
  detailTextSaveTimer = setTimeout(() => {
    detailTextSaveTimer = null;
    const shouldStream = detailTextSaveMarksStream;
    detailTextSaveMarksStream = false;
    scheduleAutosave(shouldStream);
  }, 400);
}

function flushDetailTextSave() {
  if (!detailTextSaveTimer) return;
  clearTimeout(detailTextSaveTimer);
  detailTextSaveTimer = null;
  const shouldStream = detailTextSaveMarksStream;
  detailTextSaveMarksStream = false;
  scheduleAutosave(shouldStream);
}

function rememberDetailHp(t) {
  detailHpUndo = { tokenId: t.id, hp: t.hp, hpMax: t.hpMax };
}

function commitDetailNumberInput(input, property, min, max) {
  if (!input || input.dataset.dirty !== 'true') return false;
  const t = input.dataset.tokenId ? findToken(input.dataset.tokenId) : null;
  input.dataset.dirty = 'false';
  if (!t) return false;
  const raw = input.value.trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) {
    input.value = t[property];
    return false;
  }
  const next = clamp(Math.trunc(parsed), min, max);
  if (next === t[property]) {
    input.value = next;
    return false;
  }
  if (property === 'hp' || property === 'hpMax') rememberDetailHp(t);
  t[property] = next;
  input.value = next;
  if (state.selectedId === t.id) updateDetailVitals(t);
  if (property === 'hp' || property === 'hpMax') renderTokens();
  scheduleAutosave();
  return true;
}

function cancelDetailNumberInput(input, property) {
  const t = input?.dataset.tokenId ? findToken(input.dataset.tokenId) : null;
  if (!input || !t) return;
  input.dataset.dirty = 'false';
  input.value = t[property];
}

function detailHpAmount() {
  const input = $('#detail-hp-delta');
  const numeric = Number(input.value);
  const value = Number.isFinite(numeric) && numeric > 0 ? clamp(Math.trunc(numeric), 1, 99999) : 5;
  input.value = value;
  return value;
}

function setDetailHpAmount(value) {
  $('#detail-hp-delta').value = value;
  document.querySelectorAll('[data-hp-amount]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.hpAmount) === Number(value));
  });
}

function applyDetailHpChange(mode) {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  if (!t) return;
  const amount = mode === 'full' ? 0 : detailHpAmount();
  const next = mode === 'full'
    ? t.hpMax
    : clamp(t.hp + (mode === 'heal' ? amount : -amount), 0, t.hpMax);
  if (next === t.hp) return;
  rememberDetailHp(t);
  t.hp = next;
  updateDetailVitals(t);
  renderTokens();
  scheduleAutosave();
}

function undoDetailHpChange() {
  if (!detailHpUndo) return;
  const t = findToken(detailHpUndo.tokenId);
  if (!t) {
    detailHpUndo = null;
    return;
  }
  t.hp = detailHpUndo.hp;
  t.hpMax = detailHpUndo.hpMax;
  detailHpUndo = null;
  if (state.selectedId === t.id) updateDetailVitals(t);
  renderTokens();
  scheduleAutosave();
  toast(`已撤销「${t.name}」上一次生命值变化`);
}

function closeDetailPanel() {
  cancelSpellAim();
  closeConditionEditor();
  state.selectedId = null;
  lastSelId = null;
  renderTokens();
  updateDetail();
  $('#unit-card')?.classList.add('collapsed');
}

function updateDetail() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  $('#detail-empty').hidden = !!t;
  $('#detail').hidden = !t;
  if (!t) {
    lastSelId = null;
    return;
  }
  const changed = t.id !== lastSelId;
  if (changed) {
    $('#unit-card').classList.remove('collapsed');
    detailActiveTab = 'status';
    closeConditionEditor();
  }
  lastSelId = t.id;
  updateDetailHeader(t);
  updateDetailVitals(t);
  populateDetailOwnerOptions(t);
  updateDetailNotes(t);
  $('#detail-hidden-players').checked = t.hiddenFromPlayers === true;
  renderDetailConditions(t);
  updateSpellRangeEditor(t);
  renderMountBox(t);
  updateDetailMapOptions();
  setDetailTab(detailActiveTab, { resetScroll: false });
  if (changed) requestAnimationFrame(() => {
    const scroll = $('#detail-scroll');
    if (scroll) scroll.scrollTop = 0;
  });
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

function d20CriticalOutcome(parsed, chosen, rollMode, pick, dicePayload) {
  // 只有一次 d20 检定会触发大成功/大失败；加值和未被选中的优势骰都不参与判断。
  if (!parsed || parsed.sides !== 20 || parsed.count !== 1) return { natural: null, critical: null };
  const natural = rollMode ? Number(dicePayload[pick === 1 ? 1 : 0]) : Number(chosen[0]);
  return {
    natural,
    critical: natural === 20 ? 'success' : natural === 1 ? 'fail' : null,
  };
}

function doRoll(expr, mode = 0) {
  const parsed = parseExpr(expr);
  if (!parsed) {
    toast('无法识别的骰子表达式，示例：2d6+3');
    return;
  }

  const rollMode = (mode === 1 || mode === -1) && parsed.count === 1 && parsed.sides === 20 ? mode : 0;
  const first = rollSet(parsed.count, parsed.sides);
  let second = null;
  let chosen = first;
  let pick;
  if (rollMode) {
    second = rollSet(parsed.count, parsed.sides);
    const sumA = first.reduce((a, b) => a + b, 0);
    const sumB = second.reduce((a, b) => a + b, 0);
    pick = rollMode === 1 ? (sumA >= sumB ? 0 : 1) : (sumA <= sumB ? 0 : 1);
    chosen = pick === 0 ? first : second;
  }
  const sum = chosen.reduce((a, b) => a + b, 0) + parsed.mod;
  const label = parsed.label + (rollMode === 1 ? ' ⚖️优势' : rollMode === -1 ? ' ⬇️劣势' : '');
  const note = second
    ? `（两次 ${first.reduce((a, b) => a + b, 0)} / ${second.reduce((a, b) => a + b, 0)}，取${rollMode === 1 ? '大' : '小'}）`
    : '';
  const dicePayload = second ? [first[0], second[0]] : chosen.slice();
  const outcome = d20CriticalOutcome(parsed, chosen, rollMode, pick, dicePayload);
  const criticalText = outcome.critical === 'success' ? ' · 天然 20，大成功！' : outcome.critical === 'fail' ? ' · 天然 1，大失败！' : '';
  const detail = chosen.join(' + ') + (parsed.mod ? (parsed.mod > 0 ? ` + ${parsed.mod}` : ` ${parsed.mod}`) : '') + note + criticalText;
  // GM 默认只在本机显示；勾选“广播结果”后才发送给玩家。
  playDiceFx(parsed.sides, label, sum, { dice: dicePayload, pick, mode: rollMode, natural: outcome.natural, critical: outcome.critical });
  addLogLine(label, detail, sum);
  const broadcastBox = $('#dice-broadcast');
  if (broadcastBox && broadcastBox.checked) {
    const rid = `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    hostLocalRolls.add(rid);
    sendHostAction({
      op: 'roll', rid, expr: label, detail, total: sum, sides: parsed.sides,
      dice: dicePayload, pick, mode: rollMode, natural: outcome.natural, critical: outcome.critical,
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
  // 第一处修改启动一分钟窗口；后续操作会一并写入，不会无限延后保存。
  if (autosaveTimer) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveNow();
  }, AUTOSAVE_INTERVAL_MS);
}

function saveNow(options = {}) {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  let compact;
  try {
    // 棋子库有独立存档；本回合路径属于联机临时显示，不写入战役存档。
    compact = stateStorageJson();
  } catch (e) {
    toast('⚠ 无法生成存档数据');
    return false;
  }

  let browserSaved = false;
  try {
    localStorage.setItem(STORAGE_KEY, compact);
    localStorage.setItem('dnd-board-local-save-at', String(Date.now()));
    browserSaved = true;
    browserStateCacheFailed = false;
  } catch (e) {
    if (!browserStateCacheFailed) {
      toast(projectDirHandle
        ? '浏览器临时缓存已满，将继续写入“存档”文件夹'
        : '⚠ 地图较大，请连接“存档”文件夹后保存');
    }
    browserStateCacheFailed = true;
  }

  if (projectDirHandle) {
    if (!browserSaved) updateSaveStatus('浏览器缓存已满 · 正在写入存档文件夹', 'busy');
    queueCurrentFolderSave({ backup: options.backup === true });
    return true;
  }
  updateSaveStatus(browserSaved ? '仅浏览器缓存 · 请连接“存档”文件夹' : '地图较大且未连接“存档”文件夹', 'error');
  if (!browserSaved) {
    return false;
  }
  return true;
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

    const portraitLibrary = [
      ...loadLibrary(),
      ...BUNDLED_LIBRARY.map(normalizeLibPreset),
    ];
    let migratedPortraits = 0;
    const normalizeToken = (t) => {
      const portraitPath = canonicalPortraitPath(t.iconImgPath);
      if (portraitPath) {
        t.iconImgPath = portraitPath;
        t.iconImg = null;
        t.iconImgHd = null;
        t.iconImgId = null;
      } else if (migrateLegacyTokenPortrait(t, portraitLibrary)) {
        migratedPortraits++;
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
        gridVisible: typeof m.gridVisible === 'boolean' ? m.gridVisible : s.showGrid !== false,
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
        s.gridSize || 50,
        null,
        null,
        null,
        s.showGrid !== false
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
    state.showGrid = mapGridVisible(mapById(state.activeMapId));

    const ids = state.maps.flatMap((m) => [m.id, ...m.tokens.map((t) => t.id)])
      .map((id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0)
      .concat(state.library.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10) || 0))
      .concat(state.encounter.entries.map((entry) => parseInt(String(entry.id).replace(/\D/g, ''), 10) || 0));
    uid = Math.max(1, ...ids) + 1;
    renumberAllMaps();
    pendingLegacyPortraitMigrations = migratedPortraits;
    return true;
  } catch (e) {
    console.warn('读取存档失败', e);
    return false;
  }
}

function applyAllState() {
  syncActiveMapGridSetting();
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
  syncActiveMapGridSetting();
  world.style.width = m.mapW + 'px';
  world.style.height = m.mapH + 'px';
  $('#fog-canvas').width = m.mapW;
  $('#fog-canvas').height = m.mapH;
  $('#doodle-canvas').width = m.mapW;
  $('#doodle-canvas').height = m.mapH;
  if (spellRangeCanvas) {
    spellRangeCanvas.width = m.mapW;
    spellRangeCanvas.height = m.mapH;
  }
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
  // 所有地图格式共用一个载入入口
  $('#file-map-load').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await loadSelectedMapFiles(files);
  });

  // 地图缩略图浏览、横向滑动与排序
  $('#btn-map-browser-top').addEventListener('click', openMapBrowser);
  $('#btn-map-browser-close').addEventListener('click', closeMapBrowser);
  $('#btn-map-browser-load').addEventListener('click', () => $('#file-map-load').click());
  $('#map-browser-modal').addEventListener('click', (e) => {
    if (e.target === $('#map-browser-modal')) closeMapBrowser();
  });
  const mapStrip = $('#map-thumbnail-strip');
  mapStrip.addEventListener('click', (e) => {
    if (performance.now() < mapBrowserSuppressClickUntil) return;
    const deleteButton = e.target.closest('[data-map-delete]');
    if (deleteButton) {
      deleteMapById(deleteButton.dataset.mapDelete);
      return;
    }
    const renameButton = e.target.closest('[data-map-rename]');
    if (renameButton) {
      renameMapById(renameButton.dataset.mapRename);
      return;
    }
    const stepButton = e.target.closest('[data-map-step]');
    if (stepButton) {
      moveMapBy(stepButton.dataset.mapId, Number(stepButton.dataset.mapStep));
      return;
    }
    const openButton = e.target.closest('[data-map-open]');
    if (openButton) {
      switchMap(openButton.dataset.mapOpen);
      closeMapBrowser();
    }
  });
  mapStrip.addEventListener('change', (e) => {
    const visibilityMapId = e.target.dataset.mapGridVisible;
    if (visibilityMapId !== undefined) {
      setMapGridVisibility(visibilityMapId, e.target.checked);
      return;
    }
    const sizeMapId = e.target.dataset.mapGridSize;
    if (sizeMapId !== undefined) setMapGridSize(sizeMapId, e.target.value);
  });
  mapStrip.addEventListener('scroll', updateMapBrowserScrollButtons, { passive: true });
  mapStrip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    mapStrip.scrollBy({ left: e.deltaY, behavior: 'auto' });
  }, { passive: false });
  $('#btn-map-scroll-left').addEventListener('click', () => {
    mapStrip.scrollBy({ left: -Math.max(280, mapStrip.clientWidth * .72), behavior: 'smooth' });
  });
  $('#btn-map-scroll-right').addEventListener('click', () => {
    mapStrip.scrollBy({ left: Math.max(280, mapStrip.clientWidth * .72), behavior: 'smooth' });
  });
  mapStrip.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-map-drag-handle]');
    if (!handle || state.maps.length < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const card = handle.closest('.map-thumb-card');
    if (!card) return;
    mapBrowserPointerDrag = {
      pointerId: e.pointerId,
      mapId: card.dataset.mapId,
      startX: e.clientX,
      startY: e.clientY,
      card,
      handle,
      active: false,
      targetId: null,
      placeAfter: false,
    };
    try { handle.setPointerCapture(e.pointerId); } catch (error) { /* 浏览器不支持时仍继续 */ }
    e.preventDefault();
  });
  mapStrip.addEventListener('pointermove', (e) => {
    const pending = mapBrowserPointerDrag;
    if (!pending || pending.pointerId !== e.pointerId) return;
    if (!pending.active && Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) < 6) return;
    if (!pending.active) {
      pending.active = true;
      pending.card.classList.add('dragging');
    }
    e.preventDefault();
    const stripRect = mapStrip.getBoundingClientRect();
    if (e.clientX < stripRect.left + 44) mapStrip.scrollLeft -= 18;
    if (e.clientX > stripRect.right - 44) mapStrip.scrollLeft += 18;
    clearMapDropIndicators();
    pending.targetId = null;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.map-thumb-card');
    if (!target || target.dataset.mapId === pending.mapId || !mapStrip.contains(target)) return;
    const rect = target.getBoundingClientRect();
    pending.targetId = target.dataset.mapId;
    pending.placeAfter = e.clientX > rect.left + rect.width / 2;
    target.classList.add(pending.placeAfter ? 'drop-after' : 'drop-before');
  });
  const finishMapPointerDrag = (e, cancelled = false) => {
    const pending = mapBrowserPointerDrag;
    if (!pending || pending.pointerId !== e.pointerId) return;
    try {
      if (pending.handle.hasPointerCapture(e.pointerId)) pending.handle.releasePointerCapture(e.pointerId);
    } catch (error) { /* 忽略 */ }
    const shouldReorder = !cancelled && pending.active && pending.targetId;
    const mapId = pending.mapId;
    const targetId = pending.targetId;
    const placeAfter = pending.placeAfter;
    pending.card.classList.remove('dragging');
    mapBrowserPointerDrag = null;
    clearMapDropIndicators();
    if (!shouldReorder) return;
    mapBrowserSuppressClickUntil = performance.now() + 300;
    reorderMapAround(mapId, targetId, placeAfter);
  };
  mapStrip.addEventListener('pointerup', (e) => finishMapPointerDrag(e));
  mapStrip.addEventListener('pointercancel', (e) => finishMapPointerDrag(e, true));

  // 普通图片直接导入为独立地图
  $('#btn-map-image-import-more').addEventListener('click', () => $('#file-map-load').click());
  $('#btn-map-image-import-cancel').addEventListener('click', closeDirectMapImport);
  $('#btn-map-image-import-confirm').addEventListener('click', confirmDirectMapImport);
  $('#map-image-import-modal').addEventListener('click', (e) => {
    if (e.target === $('#map-image-import-modal')) closeDirectMapImport();
  });
  $('#map-image-import-list').addEventListener('input', (e) => {
    const nameIndex = e.target.dataset.mapImportName;
    const gridIndex = e.target.dataset.mapImportGrid;
    const visibilityIndex = e.target.dataset.mapImportGridVisible;
    if (nameIndex !== undefined && pendingMapImageImports[Number(nameIndex)]) {
      pendingMapImageImports[Number(nameIndex)].name = e.target.value;
    }
    if (gridIndex !== undefined && pendingMapImageImports[Number(gridIndex)]) {
      pendingMapImageImports[Number(gridIndex)].gridSize = e.target.value;
    }
    if (visibilityIndex !== undefined && pendingMapImageImports[Number(visibilityIndex)]) {
      pendingMapImageImports[Number(visibilityIndex)].gridVisible = e.target.checked;
      renderMapImageImportList();
    }
  });
  $('#map-image-import-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-map-import-remove]');
    if (!remove || mapImageImportBusy) return;
    const index = Number(remove.dataset.mapImportRemove);
    const item = pendingMapImageImports[index];
    if (!item) return;
    try { URL.revokeObjectURL(item.objectUrl); } catch (error) { /* 忽略 */ }
    pendingMapImageImports.splice(index, 1);
    renderMapImageImportList();
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
    loadSelectedMapFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) appendDirectMapImages([item.getAsFile()]);
  });

  // 网格与吸附
  $('#grid-toggle').addEventListener('change', (e) => {
    state.showGrid = e.target.checked;
    const map = activeMap();
    if (map) map.gridVisible = e.target.checked;
    updateWorldBackground();
    if (!$('#map-browser-modal')?.hidden) renderMapBrowser();
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
    if (pendingMapReaction) {
      e.preventDefault();
      placeHostReactionAt(e.clientX, e.clientY);
      return;
    }
    if (spellAimTokenId) {
      e.preventDefault();
      beginSelectedSpellAim(e);
      return;
    }
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
        } else if (boardTool === 'doodle-eraser') {
          drag = { mode: 'doodle-erase', erased: new Set() };
          eraseDoodleAt(wx, wy, drag.erased);
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
    if (drag.mode === 'spell-aim') {
      previewSelectedSpellAimAt(e.clientX, e.clientY);
      return;
    }
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
    if (drag.mode === 'doodle-erase') {
      const m = activeMap();
      if (m) {
        const rect = board.getBoundingClientRect();
        eraseDoodleAt(
          (e.clientX - rect.left - m.cam.x) / m.cam.zoom,
          (e.clientY - rect.top - m.cam.y) / m.cam.zoom,
          drag.erased
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
    if (drag && drag.mode === 'spell-aim') {
      finishSelectedSpellAim(e, e.type === 'pointercancel');
      return;
    }
    if (drag && drag.mode === 'doodle-move') scheduleAutosave();
    if (drag && drag.mode === 'doodle') endDoodle();
    if (drag && drag.mode === 'doodle-erase' && drag.erased.size) scheduleAutosave();
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
    if (e.key === 'Escape' && (pendingMapReaction || spellAimTokenId)) {
      cancelMapReaction();
      cancelSpellAim();
      toast('已取消地图操作');
      return;
    }
    if (e.key === 'Escape' && !$('#map-image-import-modal').hidden) {
      closeDirectMapImport();
      return;
    }
    if (e.key === 'Escape' && !$('#map-browser-modal').hidden) {
      closeMapBrowser();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && boardTool === 'doodle-select' && selectedDoodleId) {
      e.preventDefault();
      const m = activeMap();
      if (m) {
        deleteDoodleById(selectedDoodleId);
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
  $('#btn-detail-close').addEventListener('click', closeDetailPanel);
  document.querySelectorAll('[data-detail-tab]').forEach((button) => {
    button.addEventListener('click', () => setDetailTab(button.dataset.detailTab));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[data-detail-tab]')];
      const current = tabs.indexOf(button);
      let next = current;
      if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      setDetailTab(tabs[next].dataset.detailTab, { focus: true });
    });
  });
  $('#detail-name').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.name = e.target.value.slice(0, 24);
    // 手动改名后退出自动编号组，不再被自动重排覆盖
    t.groupKey = null;
    renumberTokens(activeMap());
    renderTokens();
    scheduleDetailTextSave();
  });
  $('#detail-name').addEventListener('blur', flushDetailTextSave);
  $('#detail-type-select').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.type = e.target.value;
    renderTokens();
    updateDetail();
    scheduleAutosave();
    toast('类型已改为：' + ((TYPE_META[t.type] || {}).label || t.type));
  });
  const commitTokenOwner = (tokenId, rawValue, announce = false) => {
    const t = tokenId && findToken(tokenId);
    if (!t) return;
    const nextOwner = String(rawValue || '').trim().slice(0, 24);
    const changed = t.owner !== nextOwner;
    if (changed) {
      const invalidatesTurn = currentTurnIncludesToken(t.id);
      t.owner = nextOwner;
      if (encounterState().playMode === 'turn' && invalidatesTurn) bumpEncounterTurn(encounterState());
      updateDetail();
      if (invalidatesTurn) renderEncounter();
      scheduleAutosave();
    }
    if (announce) toast(t.owner ? `「${t.name}」现在归「${t.owner}」操作` : `「${t.name}」改回 GM 控制`);
  };
  $('#detail-owner').addEventListener('change', (e) => {
    commitTokenOwner(state.selectedId, e.target.value, true);
  });
  $('#btn-detail-condition-open').addEventListener('click', () => openConditionEditor());
  $('#btn-detail-condition-close').addEventListener('click', closeConditionEditor);
  $('#btn-detail-condition-cancel').addEventListener('click', closeConditionEditor);
  $('#btn-detail-condition-add').addEventListener('click', addSelectedCondition);
  $('#detail-condition-select').addEventListener('change', syncConditionCustomFields);
  document.querySelectorAll('[data-condition-duration]').forEach((button) => {
    button.addEventListener('click', () => setConditionDurationDraft(button.dataset.conditionDuration));
  });
  $('#detail-condition-turns').addEventListener('input', syncConditionDurationButtons);
  $('#detail-condition-turns').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSelectedCondition();
  });
  document.querySelectorAll('[data-condition-visibility]').forEach((button) => {
    button.addEventListener('click', () => setConditionVisibilityDraft(button.dataset.conditionVisibility));
  });
  document.querySelectorAll('#detail-spell-range [data-spell-shape]').forEach((button) => {
    button.addEventListener('click', () => updateSelectedSpellRange({ shape: button.dataset.spellShape }));
  });
  $('#detail-spell-feet').addEventListener('input', (e) => updateSelectedSpellRange({ feet: Number(e.target.value) }));
  document.querySelectorAll('#detail-spell-range [data-spell-feet]').forEach((button) => {
    button.addEventListener('click', () => updateSelectedSpellRange({ feet: Number(button.dataset.spellFeet) }));
  });
  $('#detail-spell-direction').addEventListener('input', (e) => updateSelectedSpellRange({ direction: Number(e.target.value) }));
  $('#btn-detail-spell-aim').addEventListener('click', () => {
    const token = state.selectedId ? findToken(state.selectedId) : null;
    if (!token) return;
    if (normalizeSpellRange(token.spellRange).shape !== 'cone') token.spellRange = normalizeSpellRange({ ...token.spellRange, shape: 'cone' });
    spellAimTokenId = spellAimTokenId === token.id ? null : token.id;
    cancelMapReaction();
    updateSpellRangeEditor(token);
    renderSpellRanges();
    if (spellAimTokenId) toast('在地图上按住左键旋转锥形，松开确定；Esc 取消');
  });
  $('#btn-map-reaction').addEventListener('click', toggleMapReactionPalette);
  document.querySelectorAll('#map-reaction-palette [data-map-reaction]').forEach((button) => {
    button.addEventListener('click', () => selectMapReaction(button.dataset.mapReaction));
  });
  $('#detail-public-note').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.publicNote = e.target.value.slice(0, 240);
    $('#detail-public-note-summary').textContent = t.publicNote ? `已填写 ${t.publicNote.length} 字` : '未填写';
    scheduleDetailTextSave();
  });
  $('#detail-public-note').addEventListener('blur', flushDetailTextSave);
  $('#detail-gm-note').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.gmNote = e.target.value.slice(0, 500);
    $('#detail-gm-note-summary').textContent = t.gmNote ? `已填写 ${t.gmNote.length} 字` : '未填写';
    scheduleDetailTextSave(false);
  });
  $('#detail-gm-note').addEventListener('blur', flushDetailTextSave);
  $('#detail-hidden-players').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.hiddenFromPlayers = e.target.checked;
    const encounter = encounterState();
    const affectsInitiative = currentTurnIncludesToken(t.id) || encounter.entries.some((entry) => entry.tokenId === t.id);
    if (encounter.playMode === 'turn' && affectsInitiative) bumpEncounterTurn(encounter);
    renderTokens();
    renderEncounter();
    updateDetailContext(t);
    scheduleAutosave();
    toast(t.hiddenFromPlayers ? `「${t.name}」已对玩家隐藏` : `「${t.name}」已对玩家显示`);
  });
  [
    ['detail-hp-current', 'hp', 0, 99999],
    ['detail-hp-max', 'hpMax', 1, 99999],
    ['detail-ac-input', 'ac', 0, 99],
  ].forEach(([id, property, min, max]) => {
    const input = $(`#${id}`);
    input.addEventListener('input', () => { input.dataset.dirty = 'true'; });
    input.addEventListener('blur', () => commitDetailNumberInput(input, property, min, max));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitDetailNumberInput(input, property, min, max);
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelDetailNumberInput(input, property);
        input.blur();
      }
    });
  });
  $('#detail-icon-input').addEventListener('input', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.icon = e.target.value.slice(0, 4);
    $('#detail-icon').textContent = t.icon || TYPE_META[t.type].defaultIcon;
    renderTokens();
    scheduleAutosave();
  });
  document.querySelectorAll('[data-hp-amount]').forEach((button) => {
    button.addEventListener('click', () => setDetailHpAmount(Number(button.dataset.hpAmount)));
  });
  $('#detail-hp-delta').addEventListener('input', () => setDetailHpAmount($('#detail-hp-delta').value));
  $('#btn-detail-damage').addEventListener('click', () => applyDetailHpChange('damage'));
  $('#btn-detail-heal').addEventListener('click', () => applyDetailHpChange('heal'));
  $('#btn-detail-hp-full').addEventListener('click', () => applyDetailHpChange('full'));
  $('#btn-detail-hp-undo').addEventListener('click', undoDetailHpChange);
  $('#btn-detail-delete').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    if (confirm(`确定删除「${t.name}」？`)) deleteToken(t.id);
  });
  $('#btn-token-move').addEventListener('click', () => {
    if (!state.selectedId || !$('#detail-map-move').value) return;
    const t = findToken(state.selectedId);
    const target = mapById($('#detail-map-move').value);
    if (!t || !target || !confirm(`把「${t.name}」移动到「${target.name}」？\n当前地图上的原棋子会被移除。`)) return;
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
      spellRange: normalizeSpellRange(t.spellRange),
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
      if (button.dataset.playMode === 'prepare') enterCombatPreparation();
      else leaveCombatForFreeMode();
    });
  });
  $('#btn-combat-start').addEventListener('click', startCombat);
  $('#btn-init-add').addEventListener('click', () => {
    const name = $('#init-name').value.trim();
    if (!name) { toast('请输入单位名称'); return; }
    const e = encounterState();
    const entry = addInitiativeEntry(e, { name, value: parseInt($('#init-value').value, 10) || 0 });
    if (e.playMode === 'turn' && !e.currentEntryId) e.currentEntryId = entry.id;
    if (e.playMode !== 'free') bumpEncounterTurn(e);
    $('#init-name').value = ''; $('#init-value').value = '';
    setEncounterEvent(e, `加入先攻单位：${entry.name}`);
    renderEncounter(); scheduleAutosave();
  });
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
  $('#btn-time-short-rest').addEventListener('click', () => takeRest('short'));
  $('#btn-time-long-rest').addEventListener('click', () => takeRest('long'));
  document.querySelectorAll('[data-time-shift]').forEach((button) => {
    button.addEventListener('click', () => {
      const seconds = Math.trunc(Number(button.dataset.timeShift) || 0);
      if (!seconds) return;
      shiftWorldTime(seconds, button.dataset.timeLabel || button.textContent.trim());
    });
  });
  $('#btn-time-apply').addEventListener('click', setWorldTimeFromInputs);
  $('#btn-weather-apply').addEventListener('click', applyWeatherFromInputs);
  $('#btn-weather-generate').addEventListener('click', generateWeatherFromClimate);
  $('#weather-temperature').addEventListener('keydown', (event) => { if (event.key === 'Enter') applyWeatherFromInputs(); });
  ['time-year', 'time-week', 'time-day', 'time-clock'].forEach((id) => {
    $(`#${id}`).addEventListener('keydown', (event) => { if (event.key === 'Enter') setWorldTimeFromInputs(); });
  });
  $('#btn-time-reset').addEventListener('click', () => {
    const e = encounterState();
    materializeWorldTime(e);
    e.worldTime.totalSeconds = 8 * 60 * 60;
    e.worldTime.runningSince = null;
    refreshScheduledWeather(e, e.worldTime.totalSeconds);
    setEncounterEvent(e, '世界时间已重置');
    renderEncounter(); scheduleAutosave();
  });

  // 左侧卡片折叠/展开
  document.querySelectorAll('.card:not([data-no-collapse])').forEach((card) => {
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
  $('#btn-adv').addEventListener('click', () => doRoll('d20', 1));
  $('#btn-dis').addEventListener('click', () => doRoll('d20', -1));
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
      case 'save': saveNowWithFeedback(); break;
      case 'load': openCampaignModal(); break;
      case 'stream': toggleStream(); break;
      case 'stream-copy': copyStreamUrl(); break;
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
    spellRange: normalizeSpellRange(null),
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
        spellRange: normalizeSpellRange(token.spellRange),
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
    gridVisible: mapGridVisible(m),
    doodles: ensureDoodleIds(m).map((stroke) => ({ ...stroke })),
    fog: m.fog && typeof m.fog === 'object' ? { ...m.fog } : {},
    tokens: publicTokenEntries,
  } : null;
  const p = {
    maps: publicMap ? [publicMap] : [],
    activeMapId: state.activeMapId,
    snap: state.snap,
    showGrid: mapGridVisible(m),
    showNames: state.showNames,
    fogOn: state.fogOn,
    campaignName: state.campaignName,
    sharedResources: (userLinks || []).map((link) => ({ ...link })),
    sharedNotes: String(state.sharedNotes || '').slice(0, 4000),
    encounter: publicEncounterState(visibleTokenIds),
  };
  // 兼容旧版玩家页面；新页面使用 sharedResources。
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
    const endedEntry = currentInitiativeEntry(e);
    decrementCurrentTokenConditions(e);
    e.currentEntryId = a.nextEntryId || e.currentEntryId;
    e.round = Math.max(1, Number(a.round) || e.round);
    e.turnSerial = Math.max(1, Number(a.nextTurnSerial) || (e.turnSerial + 1));
    e.turnPath = emptyTurnPath();
    materializeWorldTime(e);
    if (Number.isFinite(Number(a.worldTimeSeconds))) e.worldTime.totalSeconds = Math.max(0, Math.trunc(Number(a.worldTimeSeconds)));
    e.worldTime.runningSince = null;
    const automaticWeather = refreshScheduledWeather(e, e.worldTime.totalSeconds);
    setEncounterEvent(e, `玩家结束回合：${initiativeEntryLabel(endedEntry)}${automaticWeather ? `；天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C` : ''}`);
    renderEncounter();
    renderTokens();
    renderTurnPath();
    scheduleAutosave(Boolean(automaticWeather));
    return;
  }
  if (a.op === 'initiativeSwap') {
    const e = encounterState();
    if (!applyInitiativeRemoteAction(e, a)) return;
    setEncounterEvent(e, `${a.name || '玩家'} 调整了同先攻角色的顺序`);
    renderEncounter();
    renderTokens();
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
    playDiceFx(a.sides || 20, a.expr || '', a.total, { dice: a.dice, pick: a.pick, mode: a.mode, natural: a.natural, critical: a.critical });
    addLogLine(`${who} · ${a.expr || ''}`, a.detail || '', a.total);
    toast(`🎲 ${who} 掷出 ${a.total}（${a.expr || ''}）`);
    return;
  }
  if (a.op === 'announce') {
    toast(`📣 ${a.text || 'GM 发布了一条公告'}`);
    return;
  }
  if (a.op === 'mapReaction') {
    if (a.reactionId && localReactionIds.has(a.reactionId)) {
      localReactionIds.delete(a.reactionId);
      return;
    }
    showMapReaction(a);
    return;
  }
  const m = (state.maps || []).find((x) => x.id === (a.mapId || state.activeMapId));
  if (m && a.op === 'doodleAdd' && a.stroke && a.stroke.id) {
    if (!Array.isArray(m.doodles)) m.doodles = [];
    if (!m.doodles.some((stroke) => stroke && stroke.id === a.stroke.id)) {
      m.doodles.push({ ...a.stroke, points: Array.isArray(a.stroke.points) ? a.stroke.points.map((point) => ({ ...point })) : undefined });
    }
    if (m.id === state.activeMapId) renderDoodles();
    scheduleAutosave(false);
    return;
  }
  if (m && a.op === 'doodleDelete' && a.doodleId) {
    m.doodles = (m.doodles || []).filter((stroke) => stroke && stroke.id !== a.doodleId);
    if (selectedDoodleId === a.doodleId) selectedDoodleId = null;
    if (m.id === state.activeMapId) renderDoodles();
    scheduleAutosave(false);
    return;
  }
  if (m && a.op === 'doodleClear') {
    m.doodles = [];
    selectedDoodleId = null;
    if (m.id === state.activeMapId) renderDoodles();
    scheduleAutosave(false);
    return;
  }
  if (!m || !a || !a.tokenId) return;
  const t = m.tokens.find((x) => x.id === a.tokenId);
  if (!t) return;
  const encounter = encounterState();
  const encounterActionMode = encounter.playMode === 'turn' ? 'turn' : 'free';
  if ((a.op === 'moveToken' || a.op === 'patchToken') && a.playMode && a.playMode !== encounterActionMode) return;
  if ((a.op === 'moveToken' || a.op === 'patchToken') && a.turnSerial != null
    && (encounter.playMode !== 'turn' || Number(a.turnSerial) !== encounter.turnSerial)) return;
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
    requestSpellRangeRender();
    if (encounter.playMode === 'turn' && Number(a.turnSerial) === encounter.turnSerial && Array.isArray(a.path)) {
      appendTurnPath(encounter, m.id, t.id, a.path);
      renderTurnPath();
    }
    if (state.selectedId === t.id) updateDetail();
  } else if (a.op === 'patchToken') {
    const p = a.patch || {};
    const allowed = ['hp', 'hpMax', 'ac', 'spellRange'];
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
    streamAppliedSeq = Math.max(streamAppliedSeq, Number(s._streamSeq) || 0);
    // 只把「玩家控制组」的服务器最新状态合并回主机，不覆盖 GM 自己改的东西。
    const remote = {};
    const remoteControlledIds = new Set();
    s.maps.forEach((m) => {
      const tokens = m.tokens || [];
      tokens.forEach((t) => { remote[t.id] = t; });
      tokens.filter((t) => (t.owner || '').trim()).forEach((owned) => {
        const ids = new Set([owned.id]);
        if (owned.mountId) ids.add(owned.mountId);
        let expanded = true;
        while (expanded) {
          expanded = false;
          tokens.forEach((candidate) => {
            if (candidate.mountId && ids.has(candidate.mountId) && !ids.has(candidate.id)) {
              ids.add(candidate.id);
              expanded = true;
            }
          });
        }
        ids.forEach((id) => remoteControlledIds.add(id));
      });
    });
    let changed = false;
    const remoteMaps = new Map(s.maps.map((map) => [map.id, map]));
    (state.maps || []).forEach((map) => {
      const remoteMap = remoteMaps.get(map.id);
      if (!remoteMap || !Array.isArray(remoteMap.doodles)) return;
      const remoteDoodles = remoteMap.doodles.map((stroke) => ({
        ...stroke,
        points: Array.isArray(stroke.points) ? stroke.points.map((point) => ({ ...point })) : undefined,
      }));
      if (JSON.stringify(map.doodles || []) !== JSON.stringify(remoteDoodles)) {
        map.doodles = remoteDoodles;
        if (map.id === state.activeMapId) renderDoodles();
        changed = true;
      }
    });
    (state.maps || []).forEach((m) => (m.tokens || []).forEach((t) => {
      const rs = remote[t.id];
      // 骑手归属玩家时，未单独分配 owner 的坐骑也属于同一控制组，重连后必须一起回收坐标。
      if (rs && remoteControlledIds.has(rs.id)) {
        t.x = rs.x;
        t.y = rs.y;
        ['hp', 'hpMax', 'ac', 'spellRange'].forEach((k) => {
          if (k in rs) t[k] = rs[k];
        });
        t.spellRange = normalizeSpellRange(t.spellRange);
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
        if (ev.action && (ev.action.op === 'roll' || ev.action.op === 'mapReaction')) {
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
  if (toggleBtn) {
    toggleBtn.textContent = streamOn ? '关闭联机' : '开启联机';
    toggleBtn.classList.toggle('primary', !streamOn);
    toggleBtn.classList.toggle('danger', streamOn);
  }
  const dd = $('#btn-stream-dd');
  if (dd) dd.textContent = streamOn
    ? `📡 联机${streamInfo ? ` · ${streamInfo.playerCount || 0}` : '中'} ▾`
    : '📡 联机 ▾';
  const netInfo = $('#net-info');
  if (netInfo) {
    netInfo.classList.toggle('online', streamOn && Boolean(streamInfo));
    if (!streamOn) netInfo.textContent = '● 联机未开启';
    else if (!streamInfo) netInfo.textContent = '○ 正在连接服务器…';
    else netInfo.textContent = `● 已联机\n房间 ${streamInfo.roomCode || '—'} · ${streamInfo.playerCount || 0} 人在线 · ${streamInfo.readyCount || 0} 人已准备`;
  }
  const copyButton = $('#btn-stream-copy');
  if (copyButton) copyButton.disabled = !streamOn || !streamInfo;
}

async function refreshStreamPlayers() {
  if (!streamOn) return;
  try {
    const res = await fetch(`${serverApiBase()}/api/players`);
    if (!res.ok) return;
    const data = await res.json();
    streamPlayers = Array.isArray(data.players) ? data.players : [];
    if (state.selectedId) updateDetail();
    const onlinePlayers = (data.players || []).filter((player) => player.online);
    const onlineCount = onlinePlayers.length;
    const readyCount = onlinePlayers.filter((player) => player.status === 'ready').length;
    if (streamInfo) streamInfo = { ...streamInfo, playerCount: onlineCount, readyCount };
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

/* ==================== 棋子库 ==================== */

function canonicalPortraitPath(value) {
  if (!value) return null;
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^(?:\.\.\/)?(?:(?:asset|assets)\/)?棋子库\//, '')
    .replace('立绘/NPC/短团-烬鳞讨伐/', '立绘/NPC/短团·烬鳞讨伐/');
}

// 早期浏览器缓存 ID 曾被复用，因此先按当前棋子库名称匹配；这里只保留
// 当前历史战役中确实需要的、且可确认来源的 ID 作为自定义名称兜底。
const LEGACY_PORTRAIT_PATH_BY_ID = Object.freeze({
  a13: '立绘/妖精/地精/地精喽啰.png',
  a14: '立绘/妖精/地精/地精老大.png',
  a15: '立绘/妖精/地精/地精咒术师.png',
  a16: '立绘/妖精/地精/地精武者.png',
  a21: '立绘/NPC/短团·烬鳞讨伐/酒馆老板-马库斯.png',
  a22: '立绘/NPC/短团·烬鳞讨伐/难民-莉娅.png',
  a24: '立绘/妖精/座狼/座狼.png',
  a26: '立绘/龙类/红龙/青年红龙.png',
  a27: '立绘/妖精/大地精/大地精长官.png',
  a30: '立绘/巨人/巨魔/巨魔.png',
  a31: '立绘/巨人/巨魔/巨魔断肢.png',
  a32: '立绘/元素/魔蝠/熔岩魔蝠.png',
  a33: '立绘/元素/火蜥蜴/火蜥蜴火蛇.png',
  a34: '立绘/NPC/短团·烬鳞讨伐/地精幼崽.png',
  a233: '立绘/异怪/吉斯洋基龙巫.png',
});

function portraitNameKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・_—–-]+/g, '');
}

function libraryPortraitPathForToken(token, library) {
  const tokenKey = portraitNameKey(token?.name);
  let best = null;
  (library || []).forEach((preset) => {
    const path = canonicalPortraitPath(preset?.iconImgPath);
    const presetKey = portraitNameKey(preset?.name);
    if (!path || !presetKey) return;
    let score = 0;
    if (tokenKey === presetKey) score = 10000 + presetKey.length;
    else if (presetKey.length >= 2 && tokenKey.startsWith(presetKey)) score = 1000 + presetKey.length;
    else if (presetKey.length >= 3 && tokenKey.includes(presetKey)) score = 500 + presetKey.length;
    if (score && (!best || score > best.score)) best = { path, score };
  });
  return best?.path || null;
}

function migrateLegacyTokenPortrait(token, library) {
  if (!token || canonicalPortraitPath(token.iconImgPath) || !token.iconImgId) return false;
  const matchedPath = libraryPortraitPathForToken(token, library)
    || LEGACY_PORTRAIT_PATH_BY_ID[token.iconImgId]
    || null;
  if (!matchedPath) return false;
  token.iconImgPath = canonicalPortraitPath(matchedPath);
  token.iconImg = null;
  token.iconImgHd = null;
  token.iconImgId = null;
  return true;
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
    spellRange: normalizeSpellRange(p.spellRange),
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
    spellRange: normalizeSpellRange(p.spellRange),
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
    if (libAvatar.iconImgPath) applyPortraitImage($('#lib-icon-preview'), libAvatar.iconImgPath);
    else $('#lib-icon-preview').src = libAvatar.iconImgHd || libAvatar.iconImg;
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
  const existingPreset = libEditorId === 'new' ? null : state.library.find((item) => item.id === libEditorId);
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
    spellRange: normalizeSpellRange(existingPreset?.spellRange),
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

function makeDoodleId(prefix = 'd') {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureDoodleIds(m) {
  if (!m) return [];
  if (!Array.isArray(m.doodles)) m.doodles = [];
  m.doodles.forEach((stroke) => {
    if (stroke && !stroke.id) stroke.id = makeDoodleId('d-legacy');
  });
  return m.doodles;
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
  ensureDoodleIds(m).forEach((s) => drawDoodleStroke(g, s));
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
    if (doodleDraft.points.length >= MAX_DOODLE_POINTS) return;
    const last = doodleDraft.points[doodleDraft.points.length - 1];
    const dx = wx - last.x, dy = wy - last.y;
    const dist = Math.hypot(dx, dy);
    const step = 6;
    const n = Math.min(MAX_DOODLE_POINTS - doodleDraft.points.length, Math.max(1, Math.ceil(dist / step)));
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
      doodleDraft.id = makeDoodleId('d');
      doodleDraft.author = 'GM';
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
  deleteDoodleById(m.doodles[m.doodles.length - 1].id);
}

function clearDoodles() {
  const m = activeMap();
  if (!m || !m.doodles.length) return;
  m.doodles = [];
  selectedDoodleId = null;
  renderDoodles();
  scheduleAutosave();
  toast('已一键清空共享标注');
}

function deleteDoodleById(doodleId, persist = true) {
  const m = activeMap();
  if (!m || !doodleId) return false;
  const before = m.doodles.length;
  m.doodles = m.doodles.filter((stroke) => stroke && stroke.id !== doodleId);
  if (m.doodles.length === before) return false;
  if (selectedDoodleId === doodleId) selectedDoodleId = null;
  renderDoodles();
  if (persist) scheduleAutosave();
  return true;
}

function eraseDoodleAt(wx, wy, erased = null) {
  const stroke = doodleHitTest(wx, wy);
  if (!stroke || (erased && erased.has(stroke.id))) return false;
  if (erased) erased.add(stroke.id);
  return deleteDoodleById(stroke.id, false);
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

/* ==================== 启动 ==================== */

preloadConditionPixels();
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
syncHdUi();
const appVersionEl = $('#app-version');
if (appVersionEl) appVersionEl.textContent = APP_VERSION;
updateStreamUi();
function flushPendingAutosave() {
  flushDetailTextSave();
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
  if (pendingLegacyPortraitMigrations > 0) {
    // 只刷新浏览器恢复数据，不伪造新的保存时间；下一次正常保存会同步到正式文件夹。
    try { localStorage.setItem(STORAGE_KEY, stateStorageJson()); } catch (e) { /* 浏览器缓存不可写时仍保留本次会话 */ }
    console.info(`已恢复 ${pendingLegacyPortraitMigrations} 个旧棋子的正式立绘路径`);
  }
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
  const e = encounterState();
  if (!e.worldTime.runningSince) return;
  const totalSeconds = worldTimeNow(e);
  const automaticWeather = refreshScheduledWeather(e, totalSeconds);
  if (automaticWeather) {
    setEncounterEvent(e, `每日 08:00：天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C`);
    scheduleAutosave();
  }
  renderEncounter();
}, 500);
updateCoverContinue();
setTimeout(() => { prewarmAvatarCache(); }, 1000);
