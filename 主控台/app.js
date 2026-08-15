'use strict';

/* ==================== 常量 ==================== */

const STORAGE_KEY = 'dnd-board-state-v1';
const LIBRARY_KEY = 'dnd-board-library-v1';
const APP_VERSION = 'v1.2';

const TYPE_META = {
  pc:    { label: '玩家角色', ring: '#5b8cff', glow: 'rgba(91,140,255,.45)', defaultIcon: '🧙' },
  enemy: { label: '敌人',     ring: '#ef476f', glow: 'rgba(239,71,111,.45)', defaultIcon: '👹' },
  npc:   { label: '中立NPC',   ring: '#f4a261', glow: 'rgba(244,162,97,.45)', defaultIcon: '🧑‍🌾' },
  ally:  { label: '友好NPC',   ring: '#2ecc71', glow: 'rgba(46,204,113,.45)', defaultIcon: '🧑‍🤝‍🧑' },
};

// 状态：官方名称以《玩家手册2024》为准（目盲/受擒/麻痹/隐形/力竭等），
// cat 用于状态栏的轻分类：感官 / 心智 / 控制 / 消耗 / 标记
const STATUSES = [
  { key: 'blinded',       label: '目盲', emoji: '🙈', color: '#9aa0a8', cat: '感官' },
  { key: 'deafened',      label: '耳聋', emoji: '🙉', color: '#9aa0a8', cat: '感官' },
  { key: 'invisible',     label: '隐形', emoji: '👻', color: '#c8d0e0', cat: '感官' },
  { key: 'charmed',       label: '魅惑', emoji: '💘', color: '#ff7ab8', cat: '心智' },
  { key: 'frightened',    label: '恐慌', emoji: '😨', color: '#8e7cc3', cat: '心智' },
  { key: 'stunned',       label: '震慑', emoji: '💢', color: '#ff7a18', cat: '心智' },
  { key: 'incapacitated', label: '失能', emoji: '🚫', color: '#6d7686', cat: '心智' },
  { key: 'taunt',         label: '嘲讽', emoji: '😤', color: '#ff8a5c', cat: '心智' },
  { key: 'paralyze',      label: '麻痹', emoji: '⚡', color: '#ffd23f', cat: '控制' },
  { key: 'uncon',         label: '昏迷', emoji: '💫', color: '#8d99ae', cat: '控制' },
  { key: 'petrified',     label: '石化', emoji: '🗿', color: '#8d8d96', cat: '控制' },
  { key: 'restrain',      label: '束缚', emoji: '🔗', color: '#4cc9f0', cat: '控制' },
  { key: 'grappled',      label: '受擒', emoji: '🤝', color: '#c9a84f', cat: '控制' },
  { key: 'prone',         label: '倒地', emoji: '🙃', color: '#b388ff', cat: '控制' },
  { key: 'poison',        label: '中毒', emoji: '☠️', color: '#3fa34d', cat: '消耗' },
  { key: 'exhaust',       label: '力竭', emoji: '🥵', color: '#e76f51', cat: '消耗', stackable: true, max: 6 },
  { key: 'burn',          label: '燃烧', emoji: '🔥', color: '#ff7a18', cat: '消耗' },
  { key: 'bleed',         label: '流血', emoji: '🩸', color: '#e63946', cat: '消耗' },
  { key: 'concentrate',   label: '专注', emoji: '✨', color: '#b388ff', cat: '标记' },
  { key: 'rage',          label: '狂暴', emoji: '😡', color: '#ef476f', cat: '标记' },
  { key: 'dead',          label: '死亡', emoji: '💀', color: '#2b2d42', cat: '标记' },
];

const STATUS_CATS = ['感官', '心智', '控制', '消耗', '标记'];
const SKILLS = [
  { key: 'athletics',    label: '运动', attr: 'str' },
  { key: 'acrobatics',   label: '杂技', attr: 'dex' },
  { key: 'sleight',      label: '巧手', attr: 'dex' },
  { key: 'stealth',      label: '隐匿', attr: 'dex' },
  { key: 'arcana',       label: '奥秘', attr: 'int' },
  { key: 'history',      label: '历史', attr: 'int' },
  { key: 'investigation', label: '调查', attr: 'int' },
  { key: 'nature',       label: '自然', attr: 'int' },
  { key: 'religion',     label: '宗教', attr: 'int' },
  { key: 'animal',       label: '驯兽', attr: 'wis' },
  { key: 'insight',      label: '洞察', attr: 'wis' },
  { key: 'medicine',     label: '医药', attr: 'wis' },
  { key: 'perception',   label: '察觉', attr: 'wis' },
  { key: 'survival',     label: '生存', attr: 'wis' },
  { key: 'deception',    label: '欺瞒', attr: 'cha' },
  { key: 'intimidation', label: '威吓', attr: 'cha' },
  { key: 'performance',  label: '表演', attr: 'cha' },
  { key: 'persuasion',   label: '说服', attr: 'cha' },
];
const PROF_BY_LEVEL = { 1:2, 2:2, 3:2, 4:2, 5:3, 6:3, 7:3, 8:3, 9:4, 10:4, 11:4, 12:4, 13:5, 14:5, 15:5, 16:5, 17:6, 18:6, 19:6, 20:6 };

// 可叠加状态（如力竭）的等级存取
function statusLevel(t, key) {
  return (t.statusLevels && typeof t.statusLevels[key] === 'number') ? t.statusLevels[key] : 0;
}

function setStatusLevel(t, key, level) {
  if (!t.statusLevels || typeof t.statusLevels !== 'object') t.statusLevels = {};
  if (level <= 0) delete t.statusLevels[key];
  else t.statusLevels[key] = Math.min(level, 6);
}

function statusTitle(s, level) {
  if (!s.stackable || level <= 0) return s.label;
  let tip = s.label + ' ' + level + ' 级';
  if (s.key === 'exhaust') {
    tip += `（D20 检定 -${level * 2}，速度 -${level * 5} 尺${level >= 6 ? '，死亡' : ''}）`;
  }
  return tip;
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABILITY_LABELS = {
  str: '力量 STR', dex: '敏捷 DEX', con: '体质 CON',
  int: '智力 INT', wis: '感知 WIS', cha: '魅力 CHA',
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

// 内置常用装备字典（护甲/盾牌/武器），不够用时可以自定义
const EQUIPMENT_PRESETS = [
  { name: '皮甲', type: 'armor', baseAC: 11, dexCap: null },
  { name: '镶嵌皮甲', type: 'armor', baseAC: 12, dexCap: null },
  { name: '链甲衫', type: 'armor', baseAC: 13, dexCap: 2 },
  { name: '鳞甲', type: 'armor', baseAC: 14, dexCap: 2 },
  { name: '胸甲', type: 'armor', baseAC: 14, dexCap: 2 },
  { name: '半身板甲', type: 'armor', baseAC: 15, dexCap: 2 },
  { name: '环甲', type: 'armor', baseAC: 14, dexCap: 0 },
  { name: '链甲', type: 'armor', baseAC: 16, dexCap: 0 },
  { name: '板甲', type: 'armor', baseAC: 18, dexCap: 0 },
  { name: '盾牌', type: 'shield', acBonus: 2 },
  { name: '匕首', type: 'weapon', dice: '1d4', attr: 'dex' },
  { name: '短剑', type: 'weapon', dice: '1d6', attr: 'dex' },
  { name: '长剑', type: 'weapon', dice: '1d8', attr: 'str' },
  { name: '巨剑', type: 'weapon', dice: '2d6', attr: 'str' },
  { name: '战斧', type: 'weapon', dice: '1d8', attr: 'str' },
  { name: '短弓', type: 'weapon', dice: '1d6', attr: 'dex' },
  { name: '长弓', type: 'weapon', dice: '1d8', attr: 'dex' },
  { name: '轻弩', type: 'weapon', dice: '1d8', attr: 'dex' },
  { name: '木杖', type: 'weapon', dice: '1d6', attr: 'str' },
];

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
  init: [],
  initCurrent: null,
  round: 1,
  selectedId: null,
};

let uid = 1;
let drag = null;
let toastTimer = null;
let autosaveTimer = null;
let campaignSaveTimer = null;
let streamOn = false;
let streamTimer = null;
let streamFailToastAt = 0;
let streamDirty = false;
let streamLastPushAt = 0;
let streamPushing = false;
let streamES = null;
let streamAppliedSeq = 0;
let streamInfo = null;
let tokenAvatar = null;
let boardTool = null;
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
let editTile = 'grass';
let mapEditHistory = [];

/* ==================== 地图（多楼层） ==================== */

function activeMap() {
  return state.maps.find((m) => m.id === state.activeMapId) || state.maps[0] || null;
}

function activeTokens() {
  const m = activeMap();
  return m ? m.tokens : [];
}

function mapById(id) {
  return state.maps.find((m) => m.id === id);
}

function makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates) {
  return {
    id: 'm' + (uid++),
    name: name || '未命名地图',
    mapData: dataUrl || null,
    mapW: w || 1400,
    mapH: h || 900,
    gridSize: gridSize || 50,
    cells: Array.isArray(cells) ? cells.map((r) => r.slice()) : null,
    cellStates: cellStates && typeof cellStates === 'object' ? { ...cellStates } : {},
    // 原始底图快照：编辑器橡皮只还原到这份快照，不破坏原地图
    baseCells: Array.isArray(cells) ? cells.map((r) => r.slice()) : null,
    baseCellStates: cellStates && typeof cellStates === 'object' ? { ...cellStates } : {},
    doodles: [],
    fog: {},
    tokens: [],
    cam: { x: 0, y: 0, zoom: 1 },
  };
}

function addMap(name, dataUrl, w, h, gridSize, cells, cellStates) {
  const m = makeMapEntry(name, dataUrl, w, h, gridSize, cells, cellStates);
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
  state.maps = state.maps.filter((x) => x.id !== m.id);
  state.activeMapId = state.maps[0].id;
  state.selectedId = null;
  syncMapSelect();
  applyActiveMap();
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
const AVATAR_SOURCE_MAP = window.__PORTRAIT_PATHS__ || {
  '地精喽啰':'立绘/妖精/地精/地精喽啰.png','地精老大':'立绘/妖精/地精/地精老大.png',
  '地精咒术师':'立绘/妖精/地精/地精咒术师.png','地精武者':'立绘/妖精/地精/地精武者.png',
  '大地精长官':'立绘/妖精/大地精/大地精长官.png','座狼':'立绘/妖精/座狼/座狼.png',
  '青年红龙':'立绘/龙类/红龙/青年红龙.png','巨魔':'立绘/巨人/巨魔/巨魔.png',
  '巨魔断肢':'立绘/巨人/巨魔/巨魔断肢.png','酒馆老板-马库斯':'立绘/NPC/短团·烬鳞讨伐/酒馆老板-马库斯.png',
  '难民-莉娅':'立绘/NPC/短团·烬鳞讨伐/难民-莉娅.png','地精幼崽':'立绘/NPC/短团·烬鳞讨伐/地精幼崽.png',
  '熔岩魔蝠':'立绘/元素/魔蝠/熔岩魔蝠.png','火蜥蜴火蛇':'立绘/元素/火蜥蜴/火蜥蜴火蛇.png',
  '吉斯洋基龙巫':'立绘/异怪/吉斯洋基龙巫.png',
  '吉斯洋基武者':'立绘/异怪/吉斯洋基武者.png',
  '吉斯洋基骑士':'立绘/异怪/吉斯洋基骑士.png'
};
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
  return /^(?:data:|blob:|https?:|\/)/.test(path) ? path : '../棋子库/' + String(path).replace(/^棋子库\//, '');
}

function applyAvatar(el, iconImg, iconImgId, iconImgHd, iconImgPath) {
  if (iconImg) el.style.backgroundImage = `url("${iconImg}")`;
  if (hdEnabled && iconImgHd) el.style.backgroundImage = `url("${iconImgHd}")`;
  if (hdEnabled && iconImgPath) {
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

// 自适应画质：关闭高清时使用 128px 缩略图；开启后换项目原图或 512px 显示版
function applyTokenAvatar(el, t) {
  if (t.iconImg) el.style.backgroundImage = `url("${t.iconImg}")`;
  if (hdEnabled && t.iconImgHd) el.style.backgroundImage = `url("${t.iconImgHd}")`;
  if (hdEnabled && t.iconImgPath) el.style.backgroundImage = `url("${portraitAssetUrl(t.iconImgPath)}")`;
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
  toast(hdEnabled ? '高清：开（所有棋子立即渲染高清）' : '高清：关（已全部切换为缩略图）');
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

/* ==================== 战役管理 ==================== */

const CAMPAIGN_DB = 'dnd-board-campaigns';

function campaignIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CAMPAIGN_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('campaigns')) req.result.createObjectStore('campaigns');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function campaignPut(id, name, snap) {
  return campaignIdbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('campaigns', 'readwrite');
    const rec = { id, name, savedAt: Date.now(), state: snap };
    tx.objectStore('campaigns').put(rec, id);
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
  })).then((rec) => {
    // 绑定项目文件夹后，每个战役同步一份到 主控台/状态/战役/<战役名>/存档.json
    if (projectDirHandle && rec) writeCampaignFile(rec);
    return rec;
  });
}

function campaignGet(id) {
  return campaignIdbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('campaigns', 'readonly');
    const req = tx.objectStore('campaigns').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function campaignList() {
  return campaignIdbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('campaigns', 'readonly');
    const req = tx.objectStore('campaigns').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function campaignDelete(id) {
  return campaignIdbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('campaigns', 'readwrite');
    tx.objectStore('campaigns').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function openCampaignModal() {
  $('#campaign-modal').hidden = false;
  // 与项目文件夹双向同步：两种打开方式绑同一个文件夹时，战役就是同一批
  await syncCampaignsFromFiles();
  await syncCampaignsToFiles();
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
    d.textContent = '还没有战役，点「＋ 新建战役」开始';
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
    const savedAt = c.savedAt ? new Date(c.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
    info.textContent = `${maps} 地图 · ${tokens} 棋子 · 保存于 ${savedAt}`;
    const open = document.createElement('button');
    open.className = 'primary';
    open.textContent = '打开';
    open.addEventListener('click', () => openCampaign(c.id));
    const save = document.createElement('button');
    save.textContent = '保存';
    save.addEventListener('click', () => saveToCampaign(c.id));
    const rename = document.createElement('button');
    rename.textContent = '重命名';
    rename.addEventListener('click', async () => {
      const n = prompt('战役名称', c.name);
      if (n === null || !n.trim()) return;
      const oldName = c.name;
      const cur = await campaignGet(c.id);
      if (cur) {
        cur.name = n.trim();
        await campaignPut(c.id, cur.name, cur.state);
        if (projectDirHandle && oldName !== cur.name) await deleteCampaignFolder(oldName);
        if (c.id === state.campaignId) state.campaignName = cur.name;
        await renderCampaignList();
      }
    });
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!confirm(`删除战役「${c.name}」？存档将无法恢复。`)) return;
      if (projectDirHandle) await deleteCampaignFolder(c.name);
      await campaignDelete(c.id);
      if (state.campaignId === c.id) {
        state.campaignId = null;
        state.campaignName = '默认战役';
        scheduleAutosave();
      }
      await renderCampaignList();
    });
    const exp = document.createElement('button');
    exp.textContent = '导出';
    exp.addEventListener('click', () => exportCampaign(c.id));
    row.append(name, info, open, save, rename, exp, del);
    box.appendChild(row);
  });
}

async function saveToCampaign(id) {
  const cur = await campaignGet(id);
  if (!cur) { toast('战役不存在'); return; }
  await campaignPut(id, cur.name, JSON.parse(JSON.stringify(state)));
  state.campaignId = id;
  state.campaignName = cur.name;
  scheduleAutosave();
  await renderCampaignList();
  toast(`已保存到战役「${cur.name}」`);
}

// 当前战役自动保存：进入战役后，每次改动延迟 2 秒自动写入战役库（IndexedDB）
async function persistActiveCampaign() {
  if (!state.campaignId) return;
  const id = state.campaignId;
  const name = state.campaignName || '未命名战役';
  try {
    await campaignPut(id, name, JSON.parse(JSON.stringify(state)));
    if ($('#campaign-modal') && !$('#campaign-modal').hidden) renderCampaignList();
  } catch (e) {
    console.warn('战役自动保存失败', e);
  }
}

async function openCampaign(id) {
  const c = await campaignGet(id);
  if (!c) return;
  // 打开的就是当前战役：直接用当前最新状态，不回退到可能较旧的快照
  if (c.id === state.campaignId) {
    closeCampaignModal();
    hideCover();
    toast(`已在战役「${c.name}」中，保持当前进度`);
    return;
  }
  if (!confirm(`打开战役「${c.name}」？当前未保存的内容将被替换。`)) return;
  if (!applySavedState(c.state)) { toast('战役数据读取失败'); return; }
  await renderCampaignList();
  applyAllState();
  scheduleAutosave();
  persistToProject();
  closeCampaignModal();
  hideCover();
  toast(`已打开战役「${c.name}」`);
}

async function newCampaign() {
  const name = prompt('新战役名称', `战役 ${new Date().toLocaleDateString('zh-CN')}`);
  if (name === null || !name.trim()) return;
  const id = 'c' + (uid++);
  const snap = JSON.parse(JSON.stringify(state));
  snap.campaignId = id;
  snap.campaignName = name.trim();
  await campaignPut(id, name.trim(), snap);
  state.campaignId = id;
  state.campaignName = name.trim();
  scheduleAutosave();
  persistToProject();
  await renderCampaignList();
  hideCover();
  toast(`已新建战役「${name.trim()}」`);
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

// 全新战役：空白开始（不继承上次的地图/棋子/先攻）
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
    library: Array.isArray(state.library) ? state.library.map(normalizeLibPreset) : [],
    init: [],
    initCurrent: null,
    round: 1,
    selectedId: null,
  };
}

async function exportCampaign(id) {
  const c = await campaignGet(id);
  if (!c) return;
  const json = JSON.stringify({
    app: 'dnd-board',
    kind: 'campaign',
    campaignId: c.id,
    name: c.name,
    savedAt: c.savedAt,
    state: c.state,
  }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name}-战役.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (projectDirHandle) {
    await writeProjectText('主控台/状态/导出/' + safeCampaignFolderName(c.name) + '-战役.json', json);
    toast(`已导出战役「${c.name}」：已下载，并存入项目文件夹 主控台/状态/导出/`);
  } else {
    toast(`已导出战役「${c.name}」`);
  }
}

function importCampaign(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const s = JSON.parse(reader.result);
      let c = null;
      if (s && s.kind === 'campaign' && s.state && Array.isArray(s.state.maps)) {
        c = { id: s.campaignId || 'c' + (uid++), name: s.name || '导入战役', savedAt: s.savedAt || Date.now(), state: s.state };
      } else if (s && Array.isArray(s.maps)) {
        const name = prompt('导入的战役名称', s.campaignName || file.name.replace(/\.json$/i, ''));
        if (name === null || !name.trim()) return;
        c = { id: 'c' + (uid++), name: name.trim(), savedAt: Date.now(), state: s };
      }
      if (!c) throw new Error('bad');
      await campaignPut(c.id, c.name, c.state);
      await renderCampaignList();
      toast(`已导入战役「${c.name}」`);
    } catch (e) {
      toast('导入失败：不是有效的战役/存档文件');
    }
  };
  reader.readAsText(file);
}

/* ==================== DOM 引用 ==================== */

const world = $('#world');
const board = $('#board');

/* ==================== 地图 ==================== */

function setMap(dataUrl, w, h, cells, cellStates) {
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
      const dataUrl = cells ? renderCellsToDataUrl(cells, cellStates, s.gridSize) : s.mapData;
      const m = addMap(s.mapName || '导入地图', dataUrl, s.mapW, s.mapH, s.gridSize, cells, cellStates);
      if (m && Array.isArray(s.tokens)) {
        s.tokens.forEach((raw) => {
          if (!raw || typeof raw !== 'object') return;
          m.tokens.push({
            ...raw,
            id: 't' + (uid++),
            x: Number(raw.x) || 0,
            y: Number(raw.y) || 0,
            statuses: [],
            statusLevels: {},
            hidden: false,
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

function drawCell(g, px, py, s, id, state) {
  const cx = px + s / 2, cy = py + s / 2;
  const x = Math.round(px / s), y = Math.round(py / s);
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

function renderCellsToDataUrl(cells, cellStates, s) {
  const rows = cells.length, cols = cells[0].length;
  const c = document.createElement('canvas');
  c.width = cols * s;
  c.height = rows * s;
  const g = c.getContext('2d');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      drawCell(g, x * s, y * s, s, cells[y][x], cellStates[`${x},${y}`] || null);
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

/* ==================== 人物卡（属性 / 装备 / 联动） ==================== */

function defaultSheet() {
  return {
    stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    prof: 2,
    speed: 30,
    initBonus: 0,
    equipment: [],
    className: '无职业',
    classResources: {},
    level: 1,
    saveBonuses: {},
    skillProfs: {},
    hitDice: { die: 8, max: 1, used: 0 },
    spellSlots: defaultSpellSlots(),
  };
}

const CLASS_META = {
  '无职业': { slotType: 'none', resources: [], subclasses: [], saveProfs: [], skillCount: 0, hitDie: 8 },
  '野蛮人': { slotType: 'none', resources: [{ key: '狂暴次数', max: 2 }], subclasses: ['狂战士', '图腾战士', '世界树之魂'], saveProfs: ['str', 'con'], skillCount: 2, hitDie: 12 },
  '战士':   { slotType: 'none', resources: [], subclasses: ['勇士', '战斗大师', '奥法骑士', '灵能武士', '武士'], saveProfs: ['str', 'con'], skillCount: 2, hitDie: 10 },
  '武僧':   { slotType: 'none', resources: [{ key: '气点', max: 5 }], subclasses: ['四象宗', '暗影宗', '醉拳宗'], saveProfs: ['str', 'dex'], skillCount: 2, hitDie: 8 },
  '游荡者': { slotType: 'none', resources: [], subclasses: ['刺客', '诡术师', '魂刃', '神偷'], saveProfs: ['dex', 'int'], skillCount: 4, hitDie: 8 },
  '诗人':   { slotType: 'normal', resources: [{ key: '激励骰', max: 4 }], subclasses: ['学识学院', '英勇学院', '剑舞学院', '低语学院'], saveProfs: ['dex', 'cha'], skillCount: 3, hitDie: 8 },
  '牧师':   { slotType: 'normal', resources: [{ key: '引导神力', max: 2 }], subclasses: ['生命领域', '光明领域', '战争领域', '知识领域', '自然领域', '风暴领域', '诡术领域'], saveProfs: ['int', 'wis'], skillCount: 2, hitDie: 8 },
  '德鲁伊': { slotType: 'normal', resources: [{ key: '引导神力', max: 2 }], subclasses: ['月之结社', '大地结社', '星界结社', '野火结社'], saveProfs: ['int', 'wis'], skillCount: 2, hitDie: 8 },
  '游侠':   { slotType: 'normal', resources: [], subclasses: ['猎人', '兽王', '幽域行者', '林地漫游者'], saveProfs: ['dex', 'wis'], skillCount: 3, hitDie: 10 },
  '圣武士': { slotType: 'normal', resources: [{ key: '圣疗点数', max: 5 }, { key: '引导神力', max: 2 }], subclasses: ['奉献誓约', '守护誓约', '复仇誓约', '征服誓约'], saveProfs: ['wis', 'cha'], skillCount: 2, hitDie: 10 },
  '法师':   { slotType: 'normal', resources: [{ key: '奥术恢复', max: 1 }], subclasses: ['防护学派', '咒法学派', '预言学派', '附魔学派', '塑能学派', '幻术学派', '死灵学派', '变化学派'], saveProfs: ['int', 'wis'], skillCount: 2, hitDie: 6 },
  '术士':   { slotType: 'sorcerer', resources: [], subclasses: ['龙脉血统', '狂野魔法', '灵能之魂', '神圣之魂'], saveProfs: ['con', 'cha'], skillCount: 2, hitDie: 6 },
  '咒术师': { slotType: 'warlock', resources: [], subclasses: ['大妖精宗主', '邪魔宗主', '上古邪物宗主', '天界宗主'], saveProfs: ['int', 'cha'], skillCount: 2, hitDie: 8 },
};

const SUBCLASS_META = {
  '奥法骑士': { slotType: 'normal' },
  '诡术师': { slotType: 'normal' },
  '战斗大师': { resources: [{ key: '战技骰', max: 4 }] },
};

function classDef(t) {
  return CLASS_META[t.className] || CLASS_META['无职业'];
}

function subclassDef(t) {
  return (t.subClassName && SUBCLASS_META[t.subClassName]) ? SUBCLASS_META[t.subClassName] : null;
}

function effectiveSlotType(t) {
  const sub = subclassDef(t);
  if (sub && sub.slotType) return sub.slotType;
  return classDef(t).slotType;
}

function classResourceDefs(t) {
  const defs = classDef(t).resources.slice();
  const sub = subclassDef(t);
  if (sub && sub.resources) sub.resources.forEach((r) => defs.push(r));
  return defs;
}

function applyClassSlotType(t) {
  if (t.className && t.className !== '无职业') t.spellSlots.type = effectiveSlotType(t);
}

function profByLevel(lv) {
  return PROF_BY_LEVEL[Math.max(1, Math.min(20, parseInt(lv, 10) || 1))];
}

function autoResourceMaxes(t) {
  const lv = Math.max(1, Math.min(20, parseInt(t.level, 10) || 1));
  const out = {};
  const cls = t.className;
  if (cls === '野蛮人') out['狂暴次数'] = lv >= 17 ? 6 : lv >= 12 ? 5 : lv >= 6 ? 4 : lv >= 3 ? 3 : 2;
  if (cls === '武僧') out['气点'] = 4 + lv;
  if (cls === '诗人') out['激励骰'] = lv >= 17 ? 8 : lv >= 13 ? 7 : lv >= 9 ? 6 : lv >= 5 ? 5 : 4;
  if (cls === '牧师' || cls === '德鲁伊' || cls === '圣武士') out['引导神力'] = lv >= 17 ? 5 : lv >= 11 ? 4 : lv >= 6 ? 3 : 2;
  if (cls === '圣武士') out['圣疗点数'] = 5 * lv;
  if (cls === '法师') out['奥术恢复'] = 1;
  if (t.subClassName === '战斗大师') out['战技骰'] = lv >= 18 ? 8 : lv >= 15 ? 7 : lv >= 10 ? 6 : lv >= 7 ? 5 : 4;
  return out;
}

function applyLevel(t) {
  t.level = clamp(parseInt(t.level, 10) || 1, 1, 20);
  t.prof = profByLevel(t.level);
  const maxes = autoResourceMaxes(t);
  Object.keys(maxes).forEach((k) => {
    const cur = t.classResources[k] || (t.classResources[k] = { used: 0, max: maxes[k] });
    cur.max = maxes[k];
    if (cur.used > cur.max) cur.used = cur.max;
  });
  if (t.className === '咒术师' && t.spellSlots && t.spellSlots.warlock) {
    const w = t.spellSlots.warlock;
    w.level = t.level >= 9 ? 5 : t.level >= 7 ? 4 : t.level >= 5 ? 3 : t.level >= 3 ? 2 : 1;
    w.max = t.level >= 17 ? 4 : t.level >= 11 ? 3 : t.level >= 3 ? 2 : 1;
    if (w.used > w.max) w.used = w.max;
  }
  if (t.className === '术士' && t.spellSlots && t.spellSlots.sorcerer) {
    const p = t.spellSlots.sorcerer.points;
    p.max = t.level;
    if (p.used > p.max) p.used = p.max;
  }
  if (!t.hitDice || typeof t.hitDice !== 'object') t.hitDice = { die: classDef(t).hitDie, max: t.level, used: 0 };
  t.hitDice.die = classDef(t).hitDie;
  t.hitDice.max = t.level;
  if (t.hitDice.used > t.hitDice.max) t.hitDice.used = t.hitDice.max;
}

function saveValue(t, key) {
  return abilityMod(t.stats[key]) +
    ((classDef(t).saveProfs || []).includes(key) ? (t.prof || 2) : 0) +
    ((t.saveBonuses && t.saveBonuses[key]) || 0);
}

function skillValue(t, s) {
  const st = (t.skillProfs && t.skillProfs[s.key]) || '';
  const mult = st === 'expert' ? 2 : st === 'prof' ? 1 : 0;
  return abilityMod(t.stats[s.attr]) + mult * (t.prof || 2);
}

function defaultSpellSlots() {
  return {
    type: 'normal',
    normal: Array.from({ length: 9 }, (_, i) => ({ level: i + 1, used: 0, max: 0 })),
    none: { used: 0, max: 0 },
    sorcerer: {
      points: { used: 0, max: 0 },
      slots: Array.from({ length: 9 }, (_, i) => ({ level: i + 1, used: 0, max: 0 })),
    },
    warlock: { level: 1, used: 0, max: 0 },
  };
}

function normalizeSpellSlots(t) {
  const d = defaultSpellSlots();
  const old = t.spellSlots;
  const num = (v) => Math.max(0, Math.min(99, Number(v) || 0));
  const lvNum = (v) => Math.max(1, Math.min(9, parseInt(v, 10) || 1));
  const copyRows = (src, dst) => {
    (src || []).forEach((r, i) => {
      if (r && i < dst.length) {
        dst[i].used = num(r.used);
        dst[i].max = Math.min(20, num(r.max));
      }
    });
  };
  let hasType = false;
  if (Array.isArray(old)) {
    // 旧格式：Lv1~9 数组 → 归入「正常环位」
    copyRows(old, d.normal);
  } else if (old && typeof old === 'object') {
    hasType = ['normal', 'none', 'sorcerer', 'warlock'].includes(old.type);
    if (hasType) d.type = old.type;
    copyRows(old.normal, d.normal);
    if (old.none) {
      const n = Array.isArray(old.none) ? old.none[0] : old.none;
      if (n) { d.none.used = num(n.used); d.none.max = Math.min(20, num(n.max)); }
    }
    if (old.sorcerer && typeof old.sorcerer === 'object') {
      if (old.sorcerer.points) {
        d.sorcerer.points.used = num(old.sorcerer.points.used);
        d.sorcerer.points.max = Math.min(99, num(old.sorcerer.points.max));
      }
      copyRows(old.sorcerer.slots, d.sorcerer.slots);
    }
    if (Array.isArray(old.warlock)) {
      // 旧版咒术师多行 → 取等级最高的一行（升级即取代低级）
      let pick = null;
      old.warlock.forEach((r, i) => {
        if (r && (r.max > 0 || r.used > 0) && (!pick || i > pick.level - 1)) {
          pick = { level: i + 1, used: r.used, max: r.max };
        }
      });
      if (pick) {
        d.warlock.level = pick.level;
        d.warlock.used = num(pick.used);
        d.warlock.max = Math.min(20, num(pick.max));
      }
    } else if (old.warlock && typeof old.warlock === 'object') {
      d.warlock.level = lvNum(old.warlock.level);
      d.warlock.used = num(old.warlock.used);
      d.warlock.max = Math.min(20, num(old.warlock.max));
    }
    if (!hasType) {
      // 旧版“四类同时展开”的数据 → 自动推断角色用哪一类
      if (d.none.max > 0 || d.none.used > 0) d.type = 'none';
      else if (d.sorcerer.points.max > 0 || d.sorcerer.points.used > 0 || d.sorcerer.slots.some((r) => r.max > 0 || r.used > 0)) d.type = 'sorcerer';
      else if (d.warlock.max > 0 || d.warlock.used > 0) d.type = 'warlock';
    }
  }
  t.spellSlots = d;
}

function normalizeSheet(t) {
  if (!t.stats || typeof t.stats !== 'object') t.stats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  ABILITY_KEYS.forEach((k) => { if (typeof t.stats[k] !== 'number') t.stats[k] = 10; });
  if (typeof t.prof !== 'number') t.prof = 2;
  if (typeof t.speed !== 'number') t.speed = 30;
  if (typeof t.initBonus !== 'number') t.initBonus = 0;
  if (!Array.isArray(t.equipment)) t.equipment = [];
  if (typeof t.owner !== 'string') t.owner = '';
  if (typeof t.className !== 'string' || !t.className) t.className = '无职业';
  if (typeof t.subClassName !== 'string') t.subClassName = '';
  if (typeof t.level !== 'number') t.level = 1;
  if (!t.saveBonuses || typeof t.saveBonuses !== 'object') t.saveBonuses = {};
  if (!t.skillProfs || typeof t.skillProfs !== 'object') t.skillProfs = {};
  if (!t.hitDice || typeof t.hitDice !== 'object') t.hitDice = { die: 8, max: t.level || 1, used: 0 };
  const cls = classDef(t);
  if (t.subClassName && !cls.subclasses.includes(t.subClassName)) t.subClassName = '';
  if (!t.classResources || typeof t.classResources !== 'object') t.classResources = {};
  classResourceDefs(t).forEach((r) => {
    const cur = t.classResources[r.key];
    if (!cur || typeof cur !== 'object') t.classResources[r.key] = { used: 0, max: r.max };
  });
  normalizeSpellSlots(t);
  if (typeof t.level === 'number') applyLevel(t);
  applyClassSlotType(t);
}

function abilityMod(v) {
  return Math.floor((v - 10) / 2);
}

function modText(v) {
  const m = abilityMod(v);
  return (m >= 0 ? '+' : '') + m;
}

function modClass(v) {
  const m = abilityMod(v);
  return m > 0 ? 'mod-pos' : m < 0 ? 'mod-neg' : 'mod-zero';
}

// AC：无甲 = 10+敏捷；轻甲不设上限；中甲上限+2；重甲不加敏捷；盾牌/其他 +acBonus
function computeTokenAC(t) {
  normalizeSheet(t);
  const dexMod = abilityMod(t.stats.dex);
  const armor = t.equipment.find((e) => e.type === 'armor');
  const base = armor ? armor.baseAC : 10;
  let dexPart = 0;
  if (!armor) dexPart = dexMod;
  else if (armor.dexCap === 0) dexPart = 0;
  else if (armor.dexCap === 2) dexPart = Math.min(2, Math.max(0, dexMod));
  else dexPart = Math.max(0, dexMod);
  let ac = base + dexPart;
  t.equipment.forEach((e) => {
    if (e.type === 'shield' || e.type === 'other') ac += (e.acBonus || 0);
  });
  return ac;
}

// 配置了人物卡（属性/装备）→ 自动计算 AC；纯怪物保留预设 AC
function computeEffectiveAC(t) {
  normalizeSheet(t);
  const hasSheet = t.equipment.length > 0 || ABILITY_KEYS.some((k) => t.stats[k] !== 10);
  return hasSheet ? computeTokenAC(t) : t.ac;
}

function computeTokenInit(t) {
  normalizeSheet(t);
  return abilityMod(t.stats.dex) + (t.initBonus || 0);
}

function weaponAttrMod(t, w) {
  return w.attr === 'dex' ? abilityMod(t.stats.dex) : abilityMod(t.stats.str);
}

function weaponToHit(t, w) {
  return (t.prof || 0) + weaponAttrMod(t, w) + (w.bonus || 0);
}

function weaponDamageMod(t, w) {
  return weaponAttrMod(t, w) + (w.bonus || 0);
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

  const badges = document.createElement('div');
  badges.className = 'badges';
  (t.statuses || []).forEach((k) => {
    const s = STATUSES.find((x) => x.key === k);
    if (!s) return;
    const lv = s.stackable ? statusLevel(t, k) : 0;
    const b = document.createElement('span');
    b.className = 'badge';
    b.title = statusTitle(s, lv);
    b.textContent = s.emoji + (lv > 1 ? '×' + lv : '');
    b.style.background = s.color;
    badges.appendChild(b);
  });

  el.appendChild(circle);
  el.appendChild(badges);

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
  if (state.initCurrent) {
    const entry = state.init.find((i) => i.id === state.initCurrent);
    if (entry && entry.tokenId === t.id) el.classList.add('in-turn');
  }
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

function selectToken(id) {
  state.selectedId = id;
  renderTokens();
  updateDetail();
}

function moveToken(id, x, y) {
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
  scheduleAutosave();
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
  // 删除坐骑时，骑手自动下马（留在原地）
  if (m && t.size >= 2) m.tokens.forEach((r) => { if (r.mountId === id) r.mountId = null; });
  if (m) m.tokens = m.tokens.filter((x) => x.id !== id);
  if (m) renumberTokens(m);
  if (state.selectedId === id) state.selectedId = null;
  renderTokens();
  updateDetail();
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
  scheduleAutosave();
  toast(copy ? `已复制「${nt.name}」到「${target.name}」` : `已移动「${nt.name}」到「${target.name}」`);
}

/* ==================== 右侧详情 ==================== */

function updateDetail() {
  // 单位详情
  const t = state.selectedId ? findToken(state.selectedId) : null;
  $('#detail-empty').hidden = !!t;
  $('#detail').hidden = !t;
  if (!t) {
    lastSelId = null;
    return;
  }
  if (t.id !== lastSelId) $('#unit-card').classList.remove('collapsed');
  lastSelId = t.id;
  const effAc = computeEffectiveAC(t);
  const effInit = computeTokenInit(t);
  $('#detail-ac-tag').textContent = 'AC ' + effAc;
  $('#detail-init-tag').textContent = '先攻 ' + (effInit >= 0 ? '+' : '') + effInit;

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
  const classSel = $('#detail-class');
  if (classSel) classSel.value = t.className || '无职业';
  const subSel = $('#detail-subclass');
  if (subSel) {
    populateSubclassSelect(subSel, t.className || '无职业');
    subSel.value = t.subClassName || '';
  }
  const ownerInput = $('#detail-owner');
  if (ownerInput) ownerInput.value = t.owner || '';
  const dl = $('#owner-list');
  if (dl) {
    const owners = new Set();
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
  $('#detail-icon-input').value = t.icon || '';

  const pct = t.hpMax > 0 ? clamp((t.hp / t.hpMax) * 100, 0, 100) : 0;
  $('#detail-hp-bar').style.width = pct + '%';
  $('#detail-hp-bar').style.background = hpColor(pct);
  renderSheetHitDice(t);
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

  renderSheet();
}

/* ==================== 人物卡 ==================== */

function renderSheet() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  $('#sheet').hidden = !t;
  if (!t) return;
  normalizeSheet(t);

  const statsBox = $('#sheet-stats');
  statsBox.innerHTML = '';
  ABILITY_KEYS.forEach((k) => {
    const cell = document.createElement('div');
    cell.className = 'sheet-stat';
    cell.innerHTML =
      `<span class="sheet-stat-label">${ABILITY_LABELS[k]}</span>` +
      `<input type="number" data-stat="${k}" value="${t.stats[k]}" min="1" max="30">` +
      `<b class="sheet-stat-mod ${modClass(t.stats[k])}" data-mod="${k}">${modText(t.stats[k])}</b>`;
    statsBox.appendChild(cell);
  });

  $('#sheet-prof').value = t.prof;
  $('#sheet-speed').value = t.speed;
  $('#sheet-initbonus').value = t.initBonus;
  const levelInput = $('#sheet-level');
  if (levelInput) levelInput.value = t.level || 1;
  const lvTag = $('#sheet-level-tag');
  if (lvTag) lvTag.textContent = t.level || 1;
  const profInput = $('#sheet-prof');
  if (profInput) profInput.readOnly = true;

  renderSaves(t);
  renderSheetStatuses(t);
  renderSheetSpells(t);
  renderSkills(t);

  const sel = $('#sheet-eq-select');
  sel.innerHTML = '';
  EQUIPMENT_PRESETS.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${e.name}（${e.type === 'armor' ? '护甲 AC' + e.baseAC : e.type === 'shield' ? '盾 +' + e.acBonus : e.dice}）`;
    sel.appendChild(opt);
  });

  renderSheetEqList(t);
  updateSheet();
}

// 状态栏：普通状态用开关，可叠加状态（如力竭）用「点击循环等级」的药丸
function renderSheetStatuses(t) {
  const statusBox = $('#sheet-statuses');
  statusBox.innerHTML = '';
  STATUS_CATS.forEach((cat) => {
    const items = STATUSES.filter((s) => (s.cat || '标记') === cat);
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'status-cat';
    head.textContent = cat;
    statusBox.appendChild(head);
    items.forEach((s) => {
      if (s.stackable) {
        const lv = statusLevel(t, s.key);
        const pill = document.createElement('label');
        pill.className = 'status-pill' + (lv ? ' on' : '');
        pill.dataset.status = s.key;
        pill.title = statusTitle(s, lv) + ' · 左键升级，右键降级';
        const text = document.createElement('span');
        text.textContent = s.emoji + ' ' + s.label + (lv ? '×' + lv : '');
        pill.appendChild(text);
        statusBox.appendChild(pill);
        return;
      }
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = (t.statuses || []).includes(s.key);
      cb.dataset.status = s.key;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(s.emoji + ' ' + s.label));
      statusBox.appendChild(label);
    });
  });
}

function renderSaves(t) {
  const box = $('#sheet-saves');
  if (!box) return;
  box.innerHTML = '';
  ABILITY_KEYS.forEach((k) => {
    const v = saveValue(t, k);
    const trained = (classDef(t).saveProfs || []).includes(k);
    const cell = document.createElement('div');
    cell.className = 'save-cell' + (trained ? ' trained' : '');
    cell.title = (ABILITY_LABELS[k].split(' ')[0]) + '豁免' + (trained ? '（职业熟练）' : '');
    cell.innerHTML = `<span>${ABILITY_LABELS[k].split(' ')[0]}</span><b>${v >= 0 ? '+' : ''}${v}</b>`;
    box.appendChild(cell);
  });
}

function renderSkills(t) {
  const box = $('#sheet-skills');
  if (!box) return;
  box.innerHTML = '';
  SKILLS.forEach((s) => {
    const st = (t.skillProfs && t.skillProfs[s.key]) || '';
    const v = skillValue(t, s);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'skill-btn' + (st ? ' ' + st : '');
    b.dataset.skill = s.key;
    b.title = `${s.label}（${ABILITY_LABELS[s.attr].split(' ')[0]}）· ${st === 'expert' ? '精通' : st === 'prof' ? '熟练' : '未熟练'}`;
    b.innerHTML = `<span>${s.label}</span><b>${v >= 0 ? '+' : ''}${v}</b>`;
    box.appendChild(b);
  });
}

function renderSheetHitDice(t) {
  const box = $('#detail-hitdice');
  if (!box) return;
  const hd = t.hitDice || { die: classDef(t).hitDie, max: t.level || 1, used: 0 };
  const max = Math.max(0, hd.max || 0);
  const rem = Math.max(0, max - (hd.used || 0));
  box.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'hd-label';
  label.textContent = `生命骰 d${hd.die || 8}`;
  const cells = document.createElement('span');
  cells.className = 'slot-cells';
  for (let i = 0; i < max; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'slot-cell' + (i >= rem ? ' used' : '');
    c.title = '点击切换已用生命骰';
    cells.appendChild(c);
  }
  const count = document.createElement('span');
  count.className = 'slot-count';
  count.textContent = `${rem}/${max}`;
  const roll = document.createElement('button');
  roll.type = 'button';
  roll.className = 'small hd-roll';
  roll.textContent = '🎲 掷1颗';
  roll.title = `掷 d${hd.die || 8} + 体质调整，恢复生命并消耗 1 颗`;
  roll.addEventListener('click', () => rollHitDie(t));
  const full = document.createElement('button');
  full.type = 'button';
  full.className = 'small hd-full';
  full.textContent = '恢复全部';
  full.title = '长休后恢复所有生命骰';
  full.addEventListener('click', () => {
    hd.used = 0;
    renderSheetHitDice(t);
    scheduleAutosave();
    toast('生命骰已全部恢复');
  });
  box.append(label, cells, count, roll, full);
}

function rollHitDie(t) {
  const hd = t.hitDice || { die: classDef(t).hitDie, max: t.level || 1, used: 0 };
  const rem = Math.max(0, (hd.max || 0) - (hd.used || 0));
  if (rem <= 0) { toast('没有剩余生命骰，长休后才能恢复'); return; }
  const die = hd.die || 8;
  const roll = 1 + Math.floor(Math.random() * die);
  const con = Math.max(0, abilityMod(t.stats.con));
  const heal = roll + con;
  t.hp = Math.min(t.hpMax || t.hp, (t.hp || 0) + heal);
  hd.used = Math.min(hd.max || 0, (hd.used || 0) + 1);
  updateDetail();
  renderTokens();
  scheduleAutosave();
  toast(`生命骰掷出 ${roll} + 体质 ${con}，恢复 ${heal} 点生命`);
}

const SLOT_TYPES = [
  { key: 'normal', title: '正常环位' },
  { key: 'none', title: '无环位' },
  { key: 'sorcerer', title: '术士环位' },
  { key: 'warlock', title: '咒术师环位' },
];

function slotTypeLabel(type) {
  if (type === 'normal') return '正常环位';
  if (type === 'sorcerer') return '术士环位（术法点）';
  if (type === 'warlock') return '咒术师契约环位';
  return '无环位';
}

function renderSheetSpells(t) {
  const box = $('#sheet-spells');
  if (!box) return;
  normalizeSpellSlots(t);
  applyClassSlotType(t);
  box.innerHTML = '';
  const hasClass = !!(t.className && t.className !== '无职业');
  if (hasClass) {
    const hint = document.createElement('div');
    hint.className = 'slot-type-hint';
    const sub = subclassDef(t);
    hint.textContent = '环位类型：' + slotTypeLabel(effectiveSlotType(t)) +
      (sub && sub.slotType ? '（' + t.subClassName + '）' : '');
    box.appendChild(hint);
  } else {
    const picker = document.createElement('div');
    picker.className = 'slot-type-picker';
    SLOT_TYPES.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot-type-btn' + (t.spellSlots.type === s.key ? ' active' : '');
      b.dataset.slotType = s.key;
      b.textContent = s.title;
      b.addEventListener('click', () => {
        t.spellSlots.type = s.key;
        scheduleAutosave();
        renderSheetSpells(t);
      });
      picker.appendChild(b);
    });
    box.appendChild(picker);
  }
  const body = document.createElement('div');
  body.className = 'spell-body';
  box.appendChild(body);
  const type = t.spellSlots.type;
  if (type === 'normal') renderSlotRows(body, 'normal', t.spellSlots.normal, '正常环位', t, false);
  else if (type === 'none') renderSlotRows(body, 'none', [t.spellSlots.none], '无环位', t, true);
  else if (type === 'sorcerer') {
    const sec = document.createElement('div');
    sec.className = 'spell-sec';
    const head = document.createElement('div');
    head.className = 'spell-sec-head';
    head.textContent = '术士环位';
    sec.appendChild(head);
    const pts = t.spellSlots.sorcerer.points;
    if (pts.max > 0 || pts.used > 0) {
      sec.appendChild(slotRowEl('sorcerer', 'points', pts, '术法点'));
    } else {
      const addPts = document.createElement('button');
      addPts.className = 'spell-add-lv';
      addPts.textContent = '＋开启术法点';
      addPts.addEventListener('click', () => {
        pts.max = 1;
        scheduleAutosave();
        renderSheetSpells(t);
      });
      sec.appendChild(addPts);
    }
    renderSlotRows(sec, 'sorcerer', t.spellSlots.sorcerer.slots, '术士环位', t, false);
    body.appendChild(sec);
  } else if (type === 'warlock') {
    renderWarlockRow(body, t);
  }
  if (box.querySelector('.slot-cell')) {
    const legend = document.createElement('div');
    legend.className = 'slot-legend';
    legend.innerHTML = '<span class="slot-cell"></span> 剩余 <span class="slot-cell used"></span> 已用';
    box.appendChild(legend);
  }
  renderClassResources(box, t);
}

function renderClassResources(box, t) {
  const defs = classResourceDefs(t);
  if (!defs.length) return;
  const sec = document.createElement('div');
  sec.className = 'spell-sec class-resource-sec';
  const head = document.createElement('div');
  head.className = 'spell-sec-head';
  const title = document.createElement('span');
  title.textContent = '职业资源';
  head.appendChild(title);
  sec.appendChild(head);
  defs.forEach((r) => {
    const cur = t.classResources[r.key] || { used: 0, max: r.max };
    sec.appendChild(classResourceRowEl(t, r.key, cur));
  });
  box.appendChild(sec);
}

function classResourceRowEl(t, key, cur) {
  const el = document.createElement('div');
  el.className = 'slot-row res-row';
  el.dataset.res = key;
  const lv = document.createElement('span');
  lv.className = 'slot-lv';
  lv.textContent = key;
  const cells = document.createElement('div');
  cells.className = 'slot-cells';
  const max = Math.max(0, cur.max || 0);
  const rem = Math.max(0, max - (cur.used || 0));
  for (let i = 0; i < max; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'slot-cell' + (i >= rem ? ' used' : '');
    c.title = '点击切换已用数量';
    cells.appendChild(c);
  }
  const count = document.createElement('span');
  count.className = 'slot-count';
  count.textContent = `${rem}/${max}`;
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'slot-minus';
  minus.textContent = '−';
  minus.title = '减少数量';
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'slot-plus';
  plus.textContent = '＋';
  plus.title = '增加数量';
  el.append(lv, cells, count, minus, plus);
  return el;
}

function renderSlotRows(box, sec, rows, title, t, isNone) {
  if (!isNone) {
    const add = document.createElement('button');
    add.className = 'spell-add-lv';
    add.textContent = '＋新增一级';
    add.addEventListener('click', () => {
      const row = rows.find((r) => r.max === 0 && r.used === 0);
      if (row) { row.max = 1; scheduleAutosave(); renderSheetSpells(t); }
      else toast('所有环位级别都已开启');
    });
    box.appendChild(add);
  }
  if (isNone) {
    const row = rows[0];
    if (row.max > 0 || row.used > 0) box.appendChild(slotRowEl(sec, '0', row, '无环位'));
    else {
      const empty = document.createElement('div');
      empty.className = 'spell-sec-empty';
      empty.textContent = (t.className && t.className !== '无职业') ? '该职业无法术环位' : '未开启（点上方类型选择后这里可加数量）';
      box.appendChild(empty);
    }
    return;
  }
  rows.forEach((row) => {
    if (row.max > 0 || row.used > 0) box.appendChild(slotRowEl(sec, row.level, row, 'Lv' + row.level));
  });
  if (!box.querySelector('.slot-row')) {
    const empty = document.createElement('div');
    empty.className = 'spell-sec-empty';
    empty.textContent = '未开启，点「＋新增一级」开启';
    box.appendChild(empty);
  }
}

function renderWarlockRow(box, t) {
  const sec = document.createElement('div');
  sec.className = 'spell-sec';
  const head = document.createElement('div');
  head.className = 'spell-sec-head';
  head.textContent = '咒术师环位';
  sec.appendChild(head);
  const row = t.spellSlots.warlock;
  const el = document.createElement('div');
  el.className = 'slot-row';
  el.dataset.sec = 'warlock';
  el.dataset.level = 'warlock';
  const lv = document.createElement('span');
  lv.className = 'slot-lv';
  lv.textContent = '契约';
  const lvSel = document.createElement('select');
  lvSel.className = 'slot-level';
  for (let i = 1; i <= 9; i++) {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = 'Lv' + i;
    if (i === row.level) o.selected = true;
    lvSel.appendChild(o);
  }
  lvSel.addEventListener('change', () => {
    row.level = parseInt(lvSel.value, 10);
    scheduleAutosave();
    renderSheetSpells(t);
  });
  lv.appendChild(lvSel);
  const cells = document.createElement('div');
  cells.className = 'slot-cells';
  const rem = Math.max(0, row.max - (row.used || 0));
  for (let i = 0; i < row.max; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'slot-cell' + (i >= rem ? ' used' : '');
    c.title = '点击切换已用数量';
    cells.appendChild(c);
  }
  const count = document.createElement('span');
  count.className = 'slot-count';
  count.textContent = `${rem}/${row.max}`;
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'slot-minus';
  minus.textContent = '−';
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'slot-plus';
  plus.textContent = '＋';
  el.append(lv, cells, count, minus, plus);
  sec.appendChild(el);
  box.appendChild(sec);
}

function slotRowEl(sec, level, row, label) {
  const el = document.createElement('div');
  el.className = 'slot-row';
  el.dataset.sec = sec;
  el.dataset.level = String(level);
  const lv = document.createElement('span');
  lv.className = 'slot-lv';
  lv.textContent = label;
  const cells = document.createElement('div');
  cells.className = 'slot-cells';
  const max = row.max || 0;
  const rem = Math.max(0, max - (row.used || 0));
  for (let i = 0; i < max; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'slot-cell' + (i >= rem ? ' used' : '');
    c.title = '点击切换已用数量';
    cells.appendChild(c);
  }
  const count = document.createElement('span');
  count.className = 'slot-count';
  count.textContent = `${rem}/${max}`;
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'slot-minus';
  minus.textContent = '−';
  minus.title = '减少环位';
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'slot-plus';
  plus.textContent = '＋';
  plus.title = '增加环位';
  el.append(lv, cells, count, minus, plus);
  return el;
}

function findSpellRow(t, sec, level) {
  if (sec === 'normal') return t.spellSlots.normal.find((r) => String(r.level) === level);
  if (sec === 'none') return t.spellSlots.none;
  if (sec === 'sorcerer') {
    return level === 'points' ? t.spellSlots.sorcerer.points
      : t.spellSlots.sorcerer.slots.find((r) => String(r.level) === level);
  }
  if (sec === 'warlock') return t.spellSlots.warlock;
  return null;
}

$('#sheet-spells').addEventListener('click', (e) => {
  const rowEl = e.target.closest('.slot-row');
  if (!rowEl) return;
  const t = state.selectedId ? findToken(state.selectedId) : null;
  if (!t) return;
  if (rowEl.classList.contains('res-row')) {
    const key = rowEl.dataset.res;
    const def = classResourceDefs(t).find((x) => x.key === key);
    if (!def) return;
    const cur = t.classResources[key] || (t.classResources[key] = { used: 0, max: def.max });
    if (e.target.classList.contains('slot-cell')) {
      const idx = [...rowEl.querySelectorAll('.slot-cell')].indexOf(e.target);
      const rem = Math.max(0, (cur.max || 0) - (cur.used || 0));
      cur.used = idx < rem ? (cur.max || 0) - idx : (cur.max || 0) - (idx + 1);
    } else if (e.target.classList.contains('slot-plus')) {
      cur.max = Math.min(20, (cur.max || 0) + 1);
    } else if (e.target.classList.contains('slot-minus')) {
      cur.max = Math.max(0, (cur.max || 0) - 1);
      if (cur.used > cur.max) cur.used = cur.max;
    }
    scheduleAutosave();
    renderSheetSpells(t);
    return;
  }
  const row = findSpellRow(t, rowEl.dataset.sec, rowEl.dataset.level);
  if (!row) return;
  if (e.target.classList.contains('slot-cell')) {
    const idx = [...rowEl.querySelectorAll('.slot-cell')].indexOf(e.target);
    const rem = Math.max(0, (row.max || 0) - (row.used || 0));
    row.used = idx < rem ? (row.max || 0) - idx : (row.max || 0) - (idx + 1);
    scheduleAutosave();
    renderSheetSpells(t);
  } else if (e.target.classList.contains('slot-plus')) {
    row.max = Math.min(20, row.max + 1);
    scheduleAutosave();
    renderSheetSpells(t);
  } else if (e.target.classList.contains('slot-minus')) {
    row.max = Math.max(0, row.max - 1);
    if (row.used > row.max) row.used = row.max;
    scheduleAutosave();
    renderSheetSpells(t);
  }
});

function renderSheetEqList(t) {
  renderEqRows($('#sheet-eq-list'), t.equipment);
}

// 装备行编辑器和棋子库编辑器共用同一份渲染，保证两边完全一致
function renderEqRows(box, list) {
  box.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'eq-empty';
    d.textContent = '暂无装备';
    box.appendChild(d);
    return;
  }
  list.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'eq-row';
    row.dataset.idx = i;
    const name = `<input class="eq-name" value="${esc(e.name)}" data-f="name">`;
    const type = `<select class="eq-type" data-f="type">
      <option value="armor"${e.type === 'armor' ? ' selected' : ''}>护甲</option>
      <option value="shield"${e.type === 'shield' ? ' selected' : ''}>盾牌</option>
      <option value="weapon"${e.type === 'weapon' ? ' selected' : ''}>武器</option>
      <option value="other"${e.type === 'other' ? ' selected' : ''}>其他</option></select>`;
    let extra = '';
    if (e.type === 'armor') {
      extra =
        `<input class="eq-num" type="number" value="${e.baseAC}" data-f="baseAC" title="基础AC">` +
        `<select class="eq-cap" data-f="dexCap" title="敏捷上限">
          <option value="null"${e.dexCap === null ? ' selected' : ''}>敏捷不限</option>
          <option value="2"${e.dexCap === 2 ? ' selected' : ''}>上限+2</option>
          <option value="0"${e.dexCap === 0 ? ' selected' : ''}>不加敏捷</option></select>`;
    } else if (e.type === 'shield' || e.type === 'other') {
      extra = `<input class="eq-num" type="number" value="${e.acBonus || 0}" data-f="acBonus" title="AC加成">`;
    } else if (e.type === 'weapon') {
      extra =
        `<input class="eq-dice" value="${esc(e.dice || '1d6')}" data-f="dice" title="伤害骰">` +
        `<select class="eq-attr" data-f="attr" title="属性">
          <option value="str"${(e.attr || 'str') === 'str' ? ' selected' : ''}>力量</option>
          <option value="dex"${e.attr === 'dex' ? ' selected' : ''}>敏捷</option></select>`;
    }
    row.innerHTML = name + type + extra + `<button class="eq-del" title="移除">×</button>`;
    box.appendChild(row);
  });
}

// 编辑一行装备；返回 true 表示需要重绘整行
function applyEqRowChange(list, row, target) {
  const it = list[parseInt(row.dataset.idx, 10)];
  if (!it) return false;
  const f = target.dataset.f;
  if (f === 'baseAC') it.baseAC = parseInt(target.value, 10) || 10;
  else if (f === 'acBonus') it.acBonus = parseInt(target.value, 10) || 0;
  else if (f === 'dexCap') it.dexCap = target.value === 'null' ? null : parseInt(target.value, 10);
  else if (f === 'dice') it.dice = target.value;
  else if (f === 'name') it.name = target.value;
  else if (f === 'attr') it.attr = target.value;
  else if (f === 'type') {
    it.type = target.value;
    if (it.type === 'weapon') { if (!it.dice) { it.dice = '1d6'; it.attr = 'str'; } }
    else if (it.type === 'armor') { if (typeof it.baseAC !== 'number') { it.baseAC = 10; it.dexCap = null; } }
    else if (typeof it.acBonus !== 'number') it.acBonus = 0;
    return true;
  }
  else it[f] = target.value;
  return false;
}

function eqSummaryText(t) {
  const parts = [];
  const armor = t.equipment.find((e) => e.type === 'armor');
  if (armor) {
    const dexText = armor.dexCap === 0 ? '不加敏捷' : armor.dexCap === 2 ? '敏捷≤2' : '敏捷不限';
    parts.push(`${armor.name} ${armor.baseAC}（${dexText}）`);
  }
  t.equipment.forEach((e) => {
    if (e.type === 'shield' || e.type === 'other') parts.push(`${e.name} +${e.acBonus || 0}`);
  });
  let text = parts.length ? parts.join(' · ') : '无护甲（AC = 10 + 敏捷）';
  const weapons = t.equipment.filter((e) => e.type === 'weapon');
  if (weapons.length) text += ' · 武器：' + weapons.map((w) => w.name).join('、');
  return text;
}

function acBreakdownText(t) {
  const dexMod = abilityMod(t.stats.dex);
  const armor = t.equipment.find((e) => e.type === 'armor');
  const parts = [];
  parts.push(!armor ? '10' : `${armor.name} ${armor.baseAC}`);
  if (!armor || armor.dexCap !== 0) {
    parts.push(`敏捷${dexMod >= 0 ? '+' : ''}${dexMod}${armor && armor.dexCap === 2 ? '(≤2)' : ''}`);
  }
  t.equipment.forEach((e) => {
    if (e.type === 'shield' || e.type === 'other') parts.push(`${e.name} +${e.acBonus || 0}`);
  });
  return parts.join(' + ');
}

function updateSheet() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  if (!t) return;
  normalizeSheet(t);
  ABILITY_KEYS.forEach((k) => {
    const m = document.querySelector(`.sheet-stat-mod[data-mod="${k}"]`);
    if (m) {
      m.textContent = modText(t.stats[k]);
      m.className = `sheet-stat-mod ${modClass(t.stats[k])}`;
    }
  });
  const computed = computeTokenAC(t);
  const effective = computeEffectiveAC(t);
  const init = computeTokenInit(t);
  $('#sheet-ac').textContent = effective;
  $('#sheet-init').textContent = (init >= 0 ? '+' : '') + init;
  $('#sheet-eq-summary').textContent = eqSummaryText(t);
  $('#sheet-ac-detail').textContent = acBreakdownText(t);
  if ((t.equipment.length > 0 || ABILITY_KEYS.some((k) => t.stats[k] !== 10)) && t.ac !== computed) {
    t.ac = computed;
    renderTokens();
  }
  renderSheetAttacks(t);
}

function renderSheetAttacks(t) {
  const box = $('#sheet-attacks');
  box.innerHTML = '';
  const weapons = t.equipment.filter((e) => e.type === 'weapon');
  if (!weapons.length) {
    const d = document.createElement('div');
    d.className = 'atk-empty';
    d.textContent = '装备武器后自动显示';
    box.appendChild(d);
    return;
  }
  weapons.forEach((w, i) => {
    const hit = weaponToHit(t, w);
    const dmg = weaponDamageMod(t, w);
    const row = document.createElement('div');
    row.className = 'atk-row';
    row.innerHTML =
      `<span class="atk-name">${esc(w.name)}</span>` +
      `<span class="atk-hit">命中 ${hit >= 0 ? '+' : ''}${hit}</span>` +
      `<span class="atk-dmg">${esc(w.dice)}${dmg >= 0 ? '+' + dmg : dmg}</span>` +
      `<button class="small atk-roll" data-idx="${i}">🎲 掷</button>`;
    box.appendChild(row);
  });
}

function sheetSetInit() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  if (!t) return;
  const v = computeTokenInit(t);
  const entry = state.init.find((i) => i.tokenId === t.id);
  if (entry) {
    entry.value = v;
    updateInitList();
    toast(`已更新「${t.name}」先攻为 ${v}`);
  } else {
    const id = addInit(t.name, v, t.id);
    setCurrentInit(id);
    toast(`已添加「${t.name}」先攻 ${v}`);
  }
  scheduleAutosave();
}

function renderStatusCheckboxes() {
  const t = state.selectedId ? findToken(state.selectedId) : null;
  if (!t) return;
  $('#detail-statuses').querySelectorAll('input').forEach((cb) => {
    cb.checked = (t.statuses || []).includes(cb.dataset.status);
  });
}

/* ==================== 先攻 ==================== */

function getSortedInit() {
  return [...state.init].sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name), 'zh'));
}

function setCurrentInit(id) {
  state.initCurrent = id;
  updateInitList();
  renderTokens();
}

function updateInitList() {
  const box = $('#init-list');
  box.innerHTML = '';
  const sorted = getSortedInit();
  if (!sorted.length) {
    const d = document.createElement('div');
    d.className = 'init-empty';
    d.textContent = '暂无参与者，在左侧输入名称和数值添加';
    box.appendChild(d);
    return;
  }
  sorted.forEach((e) => {
    const chip = document.createElement('div');
    chip.className = 'init-chip' + (e.id === state.initCurrent ? ' current' : '');
    chip.dataset.id = e.id;
    const dot = document.createElement('span');
    dot.className = 'init-dot';
    dot.style.background = initTypeColor(e);
    chip.innerHTML = `<span class="init-chip-name">${esc(e.name)}</span><span class="init-chip-val">${e.value}</span><button class="init-chip-del" title="移除">×</button>`;
    chip.prepend(dot);
    chip.querySelector('.init-chip-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeInit(e.id);
    });
    chip.addEventListener('click', () => { setCurrentInit(e.id); });
    box.appendChild(chip);
  });
}

// 先攻条里与棋子关联的颜色圆点
function initTypeColor(e) {
  if (!e.tokenId) return '#9aa3b2';
  const t = state.maps.flatMap((m) => m.tokens).find((tk) => tk.id === e.tokenId);
  return t ? (TYPE_META[t.type] || TYPE_META.npc).ring : '#9aa3b2';
}

function addInit(name, value, tokenId) {
  const id = 'i' + (uid++);
  state.init.push({ id, name, value, tokenId: tokenId || null });
  updateInitList();
  scheduleAutosave();
  return id;
}

function removeInit(id) {
  state.init = state.init.filter((e) => e.id !== id);
  if (state.initCurrent === id) state.initCurrent = null;
  updateInitList();
  renderTokens();
  scheduleAutosave();
}

function nextTurn() {
  const sorted = getSortedInit();
  if (!sorted.length) {
    toast('先攻列表是空的，先添加参与者吧');
    return;
  }
  const idx = Math.max(0, sorted.findIndex((e) => e.id === state.initCurrent));
  if (idx + 1 >= sorted.length) state.round++; // 绕回第一人，进入下一回合
  const next = sorted[(idx + 1) % sorted.length];
  setCurrentInit(next.id);
  toast(`第 ${state.round} 回合：${next.name}`);
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

function doRoll(expr, mode) {
  const parsed = parseExpr(expr);
  if (!parsed) {
    toast('无法识别的骰子表达式，示例：2d6+3');
    return;
  }

  let chosen = rollSet(parsed.count, parsed.sides);
  const first = chosen;
  let note = '';
  let other = null;
  let pickedFirst = null;
  if (mode !== 0 && parsed.sides === 20) {
    const second = rollSet(parsed.count, parsed.sides);
    const sumA = first.reduce((a, b) => a + b, 0);
    const sumB = second.reduce((a, b) => a + b, 0);
    const pickMax = mode === 1;
    pickedFirst = pickMax ? sumA >= sumB : sumA <= sumB;
    chosen = pickedFirst ? first : second;
    other = pickedFirst ? second : first;
    note = `（两次 ${sumA} / ${sumB}，取${pickMax ? '大' : '小'}）`;
  }

  const sum = chosen.reduce((a, b) => a + b, 0) + parsed.mod;
  const label = parsed.label + (mode === 1 ? '⚖️优势' : mode === -1 ? '⬇️劣势' : '');
  const detail = chosen.join(' + ') + (parsed.mod ? (parsed.mod > 0 ? ` + ${parsed.mod}` : ` ${parsed.mod}`) : '') + note;
  // DM 自己的骰子动画：只在本机显示，不广播
  const dicePayload = other ? [chosen[0], other[0]] : chosen.slice();
  playDiceFx(parsed.sides, label, sum, {
    dice: dicePayload,
    pick: pickedFirst === null ? undefined : (pickedFirst ? 0 : 1),
    mode,
  });
  addLogLine(label, detail, sum);
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

function scheduleAutosave() {
  streamDirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveNow, 600);
  clearTimeout(campaignSaveTimer);
  campaignSaveTimer = setTimeout(persistActiveCampaign, 1200);
}

function saveNow() {
  try {
    // 棋子库有独立存档；主控台状态不再重复保存整库及有原图路径的内嵌图片。
    const compact = JSON.stringify(state, function (key, value) {
      if (key === 'library' && this === state) return [];
      if ((key === 'iconImgHd' || key === 'iconImg') && this && this.iconImgPath) return null;
      return value;
    });
    localStorage.setItem(STORAGE_KEY, compact);
    if (projectDirHandle) persistToProject();
    return true;
  } catch (e) {
    toast('⚠ 自动保存失败：地图图片可能太大（>5MB）');
    return false;
  }
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
    state.init = Array.isArray(s.init) ? s.init : [];
    state.initCurrent = s.initCurrent || null;
    state.round = s.round || 1;
    state.selectedId = null;
    if (!loadLibrary().length && Array.isArray(s.library) && s.library.length) {
      // 旧版本：棋子库曾存在主存档里，迁移到共享存储
      state.library = s.library.map(normalizeLibPreset);
      saveLibrary();
    }

    const normalizeToken = (t) => {
      const mappedPath = canonicalPortraitPath(AVATAR_SOURCE_MAP[t.name] || t.iconImgPath);
      if (mappedPath) {
        t.iconImgPath = mappedPath;
        t.iconImgHd = null;
      }
      t.statuses = Array.isArray(t.statuses) ? t.statuses : [];
      t.statusLevels = t.statusLevels && typeof t.statusLevels === 'object' ? { ...t.statusLevels } : {};
      Object.keys(t.statusLevels).forEach((k) => {
        const lv = parseInt(t.statusLevels[k], 10);
        if (!(lv >= 1 && lv <= 6)) delete t.statusLevels[k];
        else t.statusLevels[k] = lv;
      });
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
        baseCells: Array.isArray(m.baseCells) ? m.baseCells.map((r) => r.slice()) : (Array.isArray(m.cells) ? m.cells.map((r) => r.slice()) : null),
        baseCellStates: m.baseCellStates && typeof m.baseCellStates === 'object' ? { ...m.baseCellStates } : (m.cellStates && typeof m.cellStates === 'object' ? { ...m.cellStates } : {}),
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
      legacy.baseCells = null;
      legacy.baseCellStates = {};
      legacy.doodles = [];
      legacy.fog = {};
      legacy.cam = s.cam || legacy.cam;
      state.maps = [legacy];
      state.activeMapId = legacy.id;
    }

    const ids = state.maps.flatMap((m) => [m.id, ...m.tokens.map((t) => t.id)])
      .map((id) => parseInt(String(id).replace(/\D/g, ''), 10) || 0)
      .concat(state.init.map((i) => parseInt(String(i.id).replace(/\D/g, ''), 10) || 0))
      .concat(state.library.map((p) => parseInt(String(p.id).replace(/\D/g, ''), 10) || 0));
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
  syncMapSelect();
  applyActiveMap();
  updateInitList();
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
  updateWorldBackground();
  $('#drop-hint').classList.toggle('hidden', !!m.mapData);
  applyCamera();
  clampAllTokens();
  renderTokens();
  renderDoodles();
  renderFog();
  updateDetail();
}

function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '完整存档备份.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出存档文件');
}

function importState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const s = JSON.parse(reader.result);
      if (!Array.isArray(s.maps) && !Array.isArray(s.tokens)) throw new Error('缺少数据');
      if (Array.isArray(s.library)) {
        state.library = s.library.map(normalizeLibPreset);
        saveLibrary();
      }
      if (applySavedState(s)) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        applyAllState();
        toast('备份已导入');
      } else {
        toast('导入失败：文件格式不正确');
      }
    } catch (e) {
      toast('导入失败：文件格式不正确');
    }
  };
  reader.readAsText(file);
}

/* ==================== 完整备份 / 恢复（全部数据一套带走） ==================== */

async function exportFullBackup() {
  const campaigns = await campaignList();
  const initTime = {};
  Object.keys(localStorage).forEach((k) => {
    if (k.indexOf('sangduoer-init-time') === 0) initTime[k] = localStorage.getItem(k);
  });
  let links = null;
  try { links = JSON.parse(localStorage.getItem('sangduoer-links-v1')); } catch (e) { /* 忽略 */ }
  const data = {
    app: 'sangduoer-full-backup',
    version: 1,
    savedAt: Date.now(),
    state,
    library: loadLibrary(),
    initTime,
    links,
    campaigns,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '桑哆尔完整备份.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出完整备份（主控台 / 战役 / 棋子库 / 先攻计时 / 常用网站）');
}

function importFullBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    (async () => {
      try {
        const d = JSON.parse(reader.result);
        if (!d || !d.state || !Array.isArray(d.campaigns)) throw new Error('bad');
        if (!confirm('用备份替换当前全部数据（主控台状态、战役、棋子库、先攻计时、常用网站）？')) return;
        if (!applySavedState(d.state)) throw new Error('state');
        // 战役
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('dnd-board-campaigns', 1);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        await new Promise((res, rej) => {
          const tx = db.transaction('campaigns', 'readwrite');
          tx.objectStore('campaigns').clear();
          d.campaigns.forEach((c) => { if (c && c.id) tx.objectStore('campaigns').put(c, c.id); });
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        // 棋子库
        if (Array.isArray(d.library)) saveLibrary(d.library);
        // 先攻计时 / 常用网站
        if (d.initTime && typeof d.initTime === 'object') {
          Object.keys(d.initTime).forEach((k) => {
            try { localStorage.setItem(k, d.initTime[k]); } catch (e) { /* 忽略 */ }
          });
        }
        if (d.links) {
          try { localStorage.setItem('sangduoer-links-v1', JSON.stringify(d.links)); } catch (e) { /* 忽略 */ }
        }
        applyAllState();
        renderLibrary();
        toast('完整备份已恢复');
      } catch (e) {
        toast('恢复失败：文件格式不正确');
      }
    })();
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm('确定清空所有数据（地图、棋子、先攻列表）？')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
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

function populateClassSelects() {
  const sels = [$('#detail-class'), $('#lib-class')].filter(Boolean);
  sels.forEach((sel) => {
    sel.innerHTML = '';
    Object.keys(CLASS_META).forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
  });
  [$('#detail-subclass'), $('#lib-subclass')].filter(Boolean).forEach((sel) => {
    populateSubclassSelect(sel, '无职业');
  });
}

function populateSubclassSelect(sel, className) {
  if (!sel) return;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '无子职业';
  sel.appendChild(none);
  (CLASS_META[className] || CLASS_META['无职业']).subclasses.forEach((name) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });
}

function bindEvents() {
  populateClassSelects();
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

  // 战役管理
  $('#btn-campaign-new').addEventListener('click', newCampaign);
  $('#btn-campaign-import').addEventListener('click', () => $('#file-map-folder').click());
  $('#btn-campaign-import-backup').addEventListener('click', () => $('#file-campaign-import').click());
  // 封面页
  $('#cover-continue').addEventListener('click', () => {
    hideCover();
    toast(state.campaignId ? `已继续战役「${state.campaignName || ''}」` : '已继续上次临时进度');
  });
  $('#cover-new').addEventListener('click', async () => {
    const name = prompt('新战役名称', `战役 ${new Date().toLocaleDateString('zh-CN')}`);
    if (name === null || !name.trim()) return;
    const id = 'c' + (uid++);
    const snap = newCampaignState(name.trim(), id);
    await campaignPut(id, name.trim(), snap);
    state.maps = [];
    state.activeMapId = null;
    state.campaignId = id;
    state.campaignName = name.trim();
    state.init = [];
    state.initCurrent = null;
    state.round = 1;
    state.selectedId = null;
    state.snap = true;
    state.showGrid = true;
    state.showNames = true;
    state.markMode = false;
    state.fogOn = false;
    applyAllState();
    scheduleAutosave();
    persistToProject();
    hideCover();
    toast(`已新建战役「${name.trim()}」，从空白地图开始`);
  });
  $('#cover-load').addEventListener('click', () => openCampaignModal());
  $('#cover-temp').addEventListener('click', () => {
    hideCover();
    toast('已进入临时战役（不写入战役存档）');
  });
  $('#file-campaign-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importCampaign(e.target.files[0]);
    e.target.value = '';
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
      if (mountId) drag = { mode: 'token', id: mountId, startX: e.clientX, startY: e.clientY };
      return;
    }
    const tokenEl = e.target.closest('.token');
    board.setPointerCapture(e.pointerId);
    if (tokenEl) {
      const id = tokenEl.dataset.id;
      selectToken(id);
      drag = { mode: 'token', id, startX: e.clientX, startY: e.clientY };
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
      moveToken(drag.id, x, y);
    }
  });

  const endDrag = (e) => {
    if (drag && drag.mode === 'doodle-move') scheduleAutosave();
    if (drag && drag.mode === 'doodle') endDoodle();
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

  // 右键：快速标记死亡 / 取消
  board.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tokenEl = e.target.closest('.token');
    if (tokenEl) {
      const t = findToken(tokenEl.dataset.id);
      if (!t) return;
      if ((t.statuses || []).includes('dead')) {
        t.statuses = t.statuses.filter((k) => k !== 'dead');
      } else {
        t.statuses = [...(t.statuses || []), 'dead'];
      }
      selectToken(t.id);
      renderTokens();
      scheduleAutosave();
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
  $('#detail-class').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.className = e.target.value;
    t.subClassName = '';
    const subSel = $('#detail-subclass');
    if (subSel) {
      populateSubclassSelect(subSel, t.className);
      subSel.value = '';
    }
    normalizeSheet(t);
    applyLevel(t);
    renderSheet();
    updateDetail();
    renderTokens();
    scheduleAutosave();
    toast('职业已设为：' + t.className);
  });
  $('#detail-subclass').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.subClassName = e.target.value;
    normalizeSheet(t);
    applyLevel(t);
    renderSheet();
    updateDetail();
    renderTokens();
    scheduleAutosave();
    toast(e.target.value ? `子职业已设为：${t.className} · ${t.subClassName}` : '已清除子职业');
  });
  $('#detail-owner').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.owner = e.target.value.trim();
    updateDetail();
    scheduleAutosave();
    toast(t.owner ? `「${t.name}」现在归「${t.owner}」操作` : `「${t.name}」改回 GM 控制`);
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
  $('#detail-hitdice').addEventListener('click', (e) => {
    const cell = e.target.closest('.slot-cell');
    const t = state.selectedId && findToken(state.selectedId);
    if (!cell || !t) return;
    const hd = t.hitDice || { die: classDef(t).hitDie, max: t.level || 1, used: 0 };
    const max = hd.max || 0;
    const rem = Math.max(0, max - (hd.used || 0));
    const idx = [...cell.parentElement.querySelectorAll('.slot-cell')].indexOf(cell);
    hd.used = idx < rem ? max - idx : max - (idx + 1);
    renderSheetHitDice(t);
    scheduleAutosave();
  });
  $('#sheet-statuses').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t || !e.target.dataset.status) return;
    const key = e.target.dataset.status;
    t.statuses = t.statuses || [];
    if (e.target.checked && !t.statuses.includes(key)) t.statuses.push(key);
    if (!e.target.checked) t.statuses = t.statuses.filter((k) => k !== key);
    renderTokens();
    scheduleAutosave();
  });
  $('#sheet-statuses').addEventListener('click', (e) => {
    const pill = e.target.closest('.status-pill');
    if (!pill) return;
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    const key = pill.dataset.status;
    const s = STATUSES.find((x) => x.key === key);
    if (!s || !s.stackable) return;
    const cur = statusLevel(t, key);
    const next = cur >= s.max ? 0 : cur + 1;
    setStatusLevel(t, key, next);
    if (next === 0) t.statuses = (t.statuses || []).filter((k) => k !== key);
    else if (!(t.statuses || []).includes(key)) { t.statuses = t.statuses || []; t.statuses.push(key); }
    renderSheetStatuses(t);
    renderTokens();
    updateDetail();
    scheduleAutosave();
  });
  $('#sheet-statuses').addEventListener('contextmenu', (e) => {
    const pill = e.target.closest('.status-pill');
    if (!pill) return;
    e.preventDefault();
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    const key = pill.dataset.status;
    const s = STATUSES.find((x) => x.key === key);
    if (!s || !s.stackable) return;
    const cur = statusLevel(t, key);
    const next = cur <= 1 ? 0 : cur - 1; // 右键降级：1 级再降即清除（相当于长休后降级）
    setStatusLevel(t, key, next);
    if (next === 0) t.statuses = (t.statuses || []).filter((k) => k !== key);
    else if (!(t.statuses || []).includes(key)) { t.statuses = t.statuses || []; t.statuses.push(key); }
    renderSheetStatuses(t);
    renderTokens();
    updateDetail();
    scheduleAutosave();
  });
  $('#sheet-skills').addEventListener('click', (e) => {
    const btn = e.target.closest('.skill-btn');
    const t = state.selectedId && findToken(state.selectedId);
    if (!btn || !t) return;
    const key = btn.dataset.skill;
    t.skillProfs = t.skillProfs || {};
    const cur = t.skillProfs[key] || '';
    t.skillProfs[key] = cur === '' ? 'prof' : cur === 'prof' ? 'expert' : '';
    renderSkills(t);
    scheduleAutosave();
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

  // 人物卡
  $('#sheet-stats').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t || !e.target.dataset.stat) return;
    t.stats[e.target.dataset.stat] = clamp(parseInt(e.target.value, 10) || 10, 1, 30);
    updateSheet();
    scheduleAutosave();
  });
  $('#sheet-prof').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.prof = clamp(parseInt(e.target.value, 10) || 2, 0, 12);
    updateSheet();
    scheduleAutosave();
  });
  $('#sheet-level').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.level = clamp(parseInt(e.target.value, 10) || 1, 1, 20);
    applyLevel(t);
    renderSheet();
    updateSheet();
    renderTokens();
    scheduleAutosave();
    toast(`等级已设为 ${t.level}，熟练 +${t.prof}`);
  });
  $('#sheet-speed').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.speed = clamp(parseInt(e.target.value, 10) || 30, 0, 120);
    scheduleAutosave();
  });
  $('#sheet-initbonus').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    t.initBonus = parseInt(e.target.value, 10) || 0;
    updateSheet();
    scheduleAutosave();
  });
  $('#btn-sheet-eq-add').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    const p = EQUIPMENT_PRESETS[parseInt($('#sheet-eq-select').value, 10) || 0];
    if (p) t.equipment.push({ ...p });
    renderSheet();
    scheduleAutosave();
  });
  $('#btn-sheet-eq-custom').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    const name = prompt('新装备名称', '新装备');
    if (name === null || !name.trim()) return;
    t.equipment.push({ name: name.trim(), type: 'other', acBonus: 0, baseAC: 10, dexCap: null, dice: '1d6', attr: 'str' });
    renderSheet();
    scheduleAutosave();
  });
  $('#sheet-eq-list').addEventListener('change', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    const row = e.target.closest('.eq-row');
    if (!t || !row) return;
    if (applyEqRowChange(t.equipment, row, e.target)) renderSheetEqList(t);
    updateSheet();
    scheduleAutosave();
  });
  $('#sheet-eq-list').addEventListener('click', (e) => {
    const t = state.selectedId && findToken(state.selectedId);
    const del = e.target.closest('.eq-del');
    if (!t || !del) return;
    const row = del.closest('.eq-row');
    t.equipment.splice(parseInt(row.dataset.idx, 10), 1);
    renderSheet();
    scheduleAutosave();
  });
  $('#btn-sheet-init').addEventListener('click', sheetSetInit);
  $('#sheet-attacks').addEventListener('click', (e) => {
    const btn = e.target.closest('.atk-roll');
    const t = state.selectedId && findToken(state.selectedId);
    if (!btn || !t) return;
    const w = t.equipment.filter((x) => x.type === 'weapon')[parseInt(btn.dataset.idx, 10)];
    if (!w) return;
    const dmg = weaponDamageMod(t, w);
    doRoll(`${w.dice}${dmg >= 0 ? '+' + dmg : dmg}`, 0);
  });

  // 棋子库
  $('#lib-search').addEventListener('input', (e) => { libSearch = e.target.value; renderLibrary(); });
  $('#lib-filter').addEventListener('change', (e) => { libFilter = e.target.value; renderLibrary(); });
  $('#lib-cat').addEventListener('change', (e) => { libCategory = e.target.value; renderLibrary(); });
  $('#lib-class').addEventListener('change', (e) => {
    const sel = $('#lib-subclass');
    if (sel) {
      populateSubclassSelect(sel, e.target.value);
      sel.value = '';
    }
  });
  $('#btn-lib-add').addEventListener('click', () => openLibEditor('new'));
  $('#btn-lib-save').addEventListener('click', saveLibEditor);
  $('#btn-lib-cancel').addEventListener('click', closeLibEditor);
  $('#btn-lib-persist').addEventListener('click', persistLibraryButton);
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
  $('#lib-sheet-stats').addEventListener('change', (e) => {
    if (e.target.dataset.stat) updateLibStatMods();
  });
  $('#btn-lib-eq-add').addEventListener('click', () => {
    const p = EQUIPMENT_PRESETS[parseInt($('#lib-eq-select').value, 10) || 0];
    if (p) { libEqDraft.push({ ...p }); renderLibEqList(); }
  });
  $('#lib-eq-list').addEventListener('change', (e) => {
    const row = e.target.closest('.eq-row');
    if (!row) return;
    if (applyEqRowChange(libEqDraft, row, e.target)) renderLibEqList();
  });
  $('#lib-eq-list').addEventListener('click', (e) => {
    const del = e.target.closest('.eq-del');
    if (!del) return;
    libEqDraft.splice(parseInt(del.closest('.eq-row').dataset.idx, 10), 1);
    renderLibEqList();
  });
  $('#btn-save-to-lib').addEventListener('click', () => {
    const t = state.selectedId && findToken(state.selectedId);
    if (!t) return;
    state.library.push({
      id: 'l' + (uid++),
      name: t.name,
      type: t.type,
      category: '其他',
      className: t.className || '无职业',
      subClassName: t.subClassName || '',
      classResources: t.classResources && typeof t.classResources === 'object' ? JSON.parse(JSON.stringify(t.classResources)) : {},
      spellSlots: t.spellSlots ? JSON.parse(JSON.stringify(t.spellSlots)) : defaultSpellSlots(),
      level: typeof t.level === 'number' ? t.level : 1,
      saveBonuses: t.saveBonuses && typeof t.saveBonuses === 'object' ? { ...t.saveBonuses } : {},
      skillProfs: t.skillProfs && typeof t.skillProfs === 'object' ? { ...t.skillProfs } : {},
      hitDice: t.hitDice && typeof t.hitDice === 'object' ? { ...t.hitDice } : { die: 8, max: t.level || 1, used: 0 },
      icon: t.icon || '',
      iconImg: t.iconImg || null,
      iconImgHd: (AVATAR_SOURCE_MAP[t.name] || t.iconImgPath) ? null : (t.iconImgHd || null),
      iconImgPath: canonicalPortraitPath(AVATAR_SOURCE_MAP[t.name] || t.iconImgPath),
      iconImgId: t.iconImgId || null,
      size: t.size || 1,
      hpMax: t.hpMax || 10,
      ac: typeof t.ac === 'number' ? t.ac : 10,
      stats: t.stats && typeof t.stats === 'object' ? { ...t.stats } : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      prof: typeof t.prof === 'number' ? t.prof : 2,
      speed: typeof t.speed === 'number' ? t.speed : 30,
      initBonus: typeof t.initBonus === 'number' ? t.initBonus : 0,
      equipment: Array.isArray(t.equipment) ? t.equipment.map((e) => ({ ...e })) : [],
    });
    renderLibrary();
    saveLibrary();
    scheduleAutosave();
    toast(`「${t.name}」已存入棋子库`);
  });
  $('#btn-lib-sync').addEventListener('click', () => {
    state.library = loadLibrary();
    renderLibrary();
    toast('棋子库已同步');
  });
  window.addEventListener('focus', () => {
    const fresh = loadLibrary();
    if (JSON.stringify(fresh) !== JSON.stringify(state.library)) {
      state.library = fresh;
      renderLibrary();
      toast('棋子库已自动同步');
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

  // 轻便地图编辑
  buildEditPalettes();
  $('#btn-map-edit-undo').addEventListener('click', mapPaintUndo);
  $('#btn-map-edit-exit').addEventListener('click', () => { boardTool = null; syncBoardTools(); });

  // 左侧卡片折叠/展开
  document.querySelectorAll('.card').forEach((card) => {
    const head = card.querySelector('h2') || card.querySelector('.card-head');
    if (!head) return;
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      card.classList.toggle('collapsed');
    });
  });

  // 先攻
  $('#btn-init-add').addEventListener('click', () => {
    let name = $('#init-name').value.trim();
    const sel = state.selectedId && findToken(state.selectedId);
    if (!name && sel) name = sel.name;
    if (!name) name = '无名氏';
    const v = parseInt($('#init-value').value, 10);
    if (isNaN(v)) { toast('请填写先攻数值'); return; }
    const id = addInit(name, v, sel ? sel.id : null);
    setCurrentInit(id);
    $('#init-name').value = '';
    $('#init-value').value = '';
  });
  $('#btn-next-turn').addEventListener('click', nextTurn);
  $('#btn-init-clear').addEventListener('click', () => {
    state.init = [];
    state.initCurrent = null;
    state.round = 1;
    updateInitList();
    renderTokens();
    scheduleAutosave();
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

  $('#file-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importState(e.target.files[0]);
    e.target.value = '';
  });
  $('#file-backup-all').addEventListener('change', (e) => {
    if (e.target.files[0]) importFullBackup(e.target.files[0]);
    e.target.value = '';
  });

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
      case 'save': toast(saveNow() ? '已保存到本机浏览器' : '保存失败'); break;
      case 'export': exportState(); break;
      case 'import': $('#file-import').click(); break;
      case 'backup-all': exportFullBackup(); break;
      case 'restore-all': $('#file-backup-all').click(); break;
      case 'bind-folder': bindProjectFolder(); break;
      case 'perf-diag': openPerfDiag(); break;
      case 'stream': toggleStream(); break;
      case 'stream-copy': copyStreamUrl(); break;
      case 'server-check': serverCheck(); break;
      case 'server-copy': copyServerCmd(); break;
      case 'stream-push': streamPushData(); break;
      case 'campaigns': openCampaignModal(); break;
      case 'reset': resetAll(); break;
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
    stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    prof: 2,
    speed: 30,
    initBonus: 0,
    equipment: [],
    spellSlots: defaultSpellSlots(),
    x: clamp(finalX, margin, m.mapW - margin),
    y: clamp(finalY, margin, m.mapH - margin),
    statuses: [],
    statusLevels: {},
    hidden: false,
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

function loadLinks() {
  try {
    const raw = localStorage.getItem(LINKS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        userLinks = arr.filter((l) => l && l.name && l.url).map((l) => ({ name: String(l.name), url: String(l.url) }));
      }
    }
  } catch (e) { /* 忽略 */ }
  if (!userLinks) {
    userLinks = [{ name: '5E 不全书', url: 'https://5echm.kagangtuya.top/' }];
    try { localStorage.setItem(LINKS_KEY, JSON.stringify(userLinks)); } catch (e) { /* 忽略 */ }
  }
}

function saveLinks() {
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(userLinks || [])); } catch (e) { /* 忽略 */ }
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
    a.rel = 'noopener';
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

function addLink(name, url) {
  const n = (name || '').trim();
  let u = (url || '').trim();
  if (!n || !u) { toast('请填写网站名称和网址'); return; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  userLinks.push({ name: n, url: u });
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
    const res = await fetch('/api/music?name=' + encodeURIComponent(it.name), {
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
  fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      player: 'dm',
      action: { op: 'bgm', action, track: bgmList[bgmIndex].name, url, time: Math.round(bgmAudio.currentTime || 0) },
    }),
  }).catch(() => {});
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

function buildStreamPayload() {
  const p = { ...state };
  delete p.library;
  p._links = (userLinks || []).map((l) => ({ name: l.name, url: l.url }));
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

// 玩家动作到达主机：原地应用并触发下一次推送
function applyRemoteAction(a) {
  if (!a) return;
  if (a.op === 'roll') {
    // 玩家掷骰：进主控台骰子记录，并弹提示
    const who = a.name || '玩家';
    playDiceFx(a.sides || 20, a.expr || '', a.total, { dice: a.dice, pick: a.pick, mode: a.mode });
    addLogLine(`${who} · ${a.expr || ''}`, a.detail || '', a.total);
    toast(`🎲 ${who} 掷出 ${a.total}（${a.expr || ''}）`);
    return;
  }
  if (a.op === 'doodle') {
    // 玩家涂鸦：直接合并进当前地图，并随下次推送同步给所有人
    const mm = (state.maps || []).find((x) => x.id === (a.mapId || state.activeMapId));
    if (mm && Array.isArray(a.doodles)) {
      mm.doodles = a.doodles.map((s) => ({ ...s }));
      renderDoodles();
      scheduleAutosave();
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
    if (state.selectedId === t.id) updateDetail();
  } else if (a.op === 'setStatus') {
    if (!Array.isArray(t.statuses)) t.statuses = [];
    t.statuses = t.statuses.filter((k) => k !== a.status);
    if (a.level !== undefined && a.level !== null) {
      setStatusLevel(t, a.status, parseInt(a.level, 10) || 0);
      if (a.level > 0) t.statuses.push(a.status);
    } else if (a.on) {
      t.statuses.push(a.status);
    }
    renderTokens();
    if (state.selectedId === t.id) {
      updateDetail();
      renderStatusCheckboxes();
    }
  } else if (a.op === 'patchToken') {
    const p = a.patch || {};
    const allowed = ['hp', 'hpMax', 'stats', 'prof', 'speed', 'initBonus', 'equipment', 'classResources', 'spellSlots', 'hitDice'];
    allowed.forEach((k) => { if (k in p) t[k] = p[k]; });
    normalizeSheet(t);
    renderTokens();
    if (state.selectedId === t.id) {
      const ae = document.activeElement;
      const editing = ae && (($('#sheet') && $('#sheet').contains(ae)) || ($('#detail') && $('#detail').contains(ae)));
      if (editing) {
        updateSheet();
        renderSaves(t);
        renderSkills(t);
        renderSheetSpells(t);
        renderSheetHitDice(t);
      } else {
        updateDetail();
        renderSheet();
      }
    }
  }
  scheduleAutosave();
}

async function mergePlayerStateFromServer() {
  try {
    const res = await fetch('http://localhost:8090/api/state');
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
        t.statuses = Array.isArray(rs.statuses) ? [...rs.statuses] : [];
        if (rs.statusLevels && typeof rs.statusLevels === 'object') t.statusLevels = { ...rs.statusLevels };
        ['hp', 'hpMax', 'stats', 'prof', 'speed', 'initBonus', 'equipment', 'classResources', 'spellSlots', 'hitDice'].forEach((k) => {
          if (k in rs) t[k] = rs[k];
        });
        if (t.size >= 2) syncRiderData(t);
        changed = true;
      }
    }));
    if (changed) {
      renderTokens();
      scheduleAutosave();
    }
  } catch (e) { /* 服务器暂不可用，SSE 重连后会自动再拉 */ }
}

function startStreamClient() {
  if (streamES) {
    try { streamES.close(); } catch (e) { /* 忽略 */ }
  }
  streamES = new EventSource('http://localhost:8090/api/events');
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
    const res = await fetch('http://localhost:8090/api/state', {
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
  // 有改动就尽快推；没改动时每 2.5 秒保活一次，兜底漏推的改动
  if (!streamDirty && now - streamLastPushAt < 2500) return;
  if (now - streamLastPushAt < 300) return;
  streamDirty = false;
  streamPush();
}

function updateStreamUi() {
  const toggleBtn = $('#btn-stream-toggle');
  if (toggleBtn) toggleBtn.textContent = streamOn ? '⛔ 关闭玩家模式' : '📡 开启玩家模式（主机推送）';
  const dd = $('#btn-stream-dd');
  if (dd) dd.textContent = streamOn ? '📡 联机已开 ▾' : '📡 联机 ▾';
}

async function copyStreamUrl() {
  if (!streamOn || !streamInfo) {
    toast('请先开启玩家模式');
    return;
  }
  const url = `http://${streamInfo.ip}:${streamInfo.port || 8090}/主控台/观战.html?v=23`;
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
    const res = await fetch('http://localhost:8090/api/info', { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    const ip = (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost';
    toast(`✅ 服务器在线：玩家打开 http://${ip}:${info.port || 8090}/主控台/观战.html?v=23`);
  } catch (e) {
    toast('❌ 服务器未启动：请双击项目里的「启动桑哆尔」一键启动');
  }
}

// 复制启动命令（Windows / macOS 自动识别）
async function copyServerCmd() {
  const isWin = /Windows/i.test(navigator.userAgent);
  const cmd = isWin ? 'python 主控台\\联机服务器.py' : 'python3 主控台/联机服务器.py';
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
    const res = await fetch('http://localhost:8090/api/info', { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    streamOn = true;
    try { localStorage.setItem('sangduoer-stream-on', '1'); } catch (e) { /* 忽略 */ }
    clearInterval(streamTimer);
    streamTimer = setInterval(streamTick, 250);
    startStreamClient();
    streamPush();
    const ip = (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost';
    streamInfo = { ip, port: info.port || 8090 };
    updateStreamUi();
    toast(`📡 玩家模式已开启：改动最快约0.3秒推送，玩家打开 http://${ip}:${info.port || 8090}/主控台/观战.html?v=23`);
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
  streamPush();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch('http://localhost:8090/api/info', { signal: ctl.signal });
    clearTimeout(t);
    const info = await res.json();
    const ip = (info.ips || []).find((x) => x !== '127.0.0.1') || 'localhost';
    streamInfo = { ip, port: info.port || 8090 };
    updateStreamUi();
    toast(`📡 已自动恢复玩家模式：玩家打开 http://${ip}:${info.port || 8090}/主控台/观战.html?v=23`);
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
  // 清理旧版高清修复写入的重复 data URL；有项目文件时以原图路径为准。
  const portraitPath = canonicalPortraitPath(AVATAR_SOURCE_MAP[p.name] || p.iconImgPath);
  return {
    id: p.id || 'l' + (uid++),
    name: p.name || '未命名',
    type: ['pc', 'enemy', 'npc', 'ally'].includes(p.type) ? p.type : 'npc',
    category: (p.category || '').trim() || '其他',
    className: typeof p.className === 'string' && CLASS_META[p.className] ? p.className : '无职业',
    subClassName: typeof p.subClassName === 'string' ? p.subClassName : '',
    classResources: p.classResources && typeof p.classResources === 'object' ? { ...p.classResources } : {},
    spellSlots: p.spellSlots && typeof p.spellSlots === 'object' ? JSON.parse(JSON.stringify(p.spellSlots)) : null,
    level: typeof p.level === 'number' ? Math.max(1, Math.min(20, p.level)) : 1,
    saveBonuses: p.saveBonuses && typeof p.saveBonuses === 'object' ? { ...p.saveBonuses } : {},
    skillProfs: p.skillProfs && typeof p.skillProfs === 'object' ? { ...p.skillProfs } : {},
    hitDice: p.hitDice && typeof p.hitDice === 'object' ? { ...p.hitDice } : null,
    icon: p.icon || '',
    iconImg: p.iconImg || null,
    iconImgHd: portraitPath ? null : (p.iconImgHd || null),
    iconImgPath: portraitPath,
    iconImgId: p.iconImgId || null,
    size: p.size === 2 ? 2 : 1,
    hpMax: Math.max(1, parseInt(p.hpMax, 10) || 10),
    ac: typeof p.ac === 'number' ? p.ac : 10,
    stats: p.stats && typeof p.stats === 'object' ? { ...p.stats } : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    prof: typeof p.prof === 'number' ? p.prof : 2,
    speed: typeof p.speed === 'number' ? p.speed : 30,
    initBonus: typeof p.initBonus === 'number' ? p.initBonus : 0,
    equipment: Array.isArray(p.equipment) ? p.equipment.map((e) => ({ ...e })) : [],
  };
}

/* ============ 棋子库永久保存到文件（File System Access API） ============ */

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

/* ==================== 项目文件夹绑定（自动写盘） ==================== */

let projectDirHandle = null;

async function loadProjectDirHandle() {
  try { projectDirHandle = await idbFilesGet('project-dir'); } catch (e) { projectDirHandle = null; }
  return projectDirHandle;
}

async function bindProjectFolder() {
  if (!window.showDirectoryPicker) { toast('当前浏览器不支持文件夹绑定，请用 Chrome / Edge'); return; }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbFilesSet('project-dir', handle);
    projectDirHandle = handle;
    await persistToProject();
    await syncCampaignsToFiles();
    toast('✅ 已绑定项目文件夹，之后每次改动都会自动写盘');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('绑定失败：' + (e.message || e));
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

async function queryProjectPerm() {
  if (!projectDirHandle) return false;
  try {
    let perm = await projectDirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await projectDirHandle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted';
  } catch (e) {
    return false;
  }
}

async function readProjectText(relPath) {
  if (!projectDirHandle || !(await queryProjectPerm())) return null;
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

async function listProjectDir(relPath) {
  if (!projectDirHandle || !(await queryProjectPerm())) return [];
  try {
    const dir = relPath ? await getDirHandle(projectDirHandle, relPath, false) : projectDirHandle;
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') out.push(name);
    }
    return out;
  } catch (e) {
    return [];
  }
}

async function writeProjectText(relPath, text) {
  if (!projectDirHandle) return false;
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

function safeCampaignFolderName(name) {
  return String(name || '未命名战役').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名战役';
}

/* ==================== 战役文件夹存档（绑定项目文件夹后生效） ==================== */

const CAMPAIGN_DIR = '主控台/状态/战役';

async function writeCampaignFile(record) {
  if (!projectDirHandle || !record) return;
  try {
    const text = JSON.stringify({
      app: 'dnd-board',
      kind: 'campaign',
      campaignId: record.id,
      name: record.name,
      savedAt: record.savedAt,
      state: record.state,
    }, null, 2);
    await writeProjectText(CAMPAIGN_DIR + '/' + safeCampaignFolderName(record.name) + '/存档.json', text);
  } catch (e) {
    console.warn('写战役文件夹失败', e);
  }
}

async function deleteCampaignFolder(name) {
  if (!projectDirHandle) return;
  try {
    const dir = await getDirHandle(projectDirHandle, CAMPAIGN_DIR, false);
    await dir.removeEntry(safeCampaignFolderName(name), { recursive: true });
  } catch (e) { /* 文件夹可能不存在，忽略 */ }
}

async function readCampaignsFromFiles() {
  const out = [];
  const names = await listProjectDir(CAMPAIGN_DIR);
  for (const n of names) {
    const text = await readProjectText(CAMPAIGN_DIR + '/' + n + '/存档.json');
    if (!text) continue;
    try {
      const d = JSON.parse(text);
      if (d && d.kind === 'campaign' && d.state && Array.isArray(d.state.maps)) {
        out.push({ id: d.campaignId || n, name: d.name || n, savedAt: d.savedAt || 0, state: d.state });
      } else if (d && Array.isArray(d.maps)) {
        // 兼容旧格式：文件夹里直接放的是主控台状态
        out.push({ id: d.campaignId || n, name: d.campaignName || n, savedAt: 0, state: d });
      }
    } catch (e) { /* 跳过损坏文件 */ }
  }
  return out;
}

async function syncCampaignsFromFiles() {
  if (!projectDirHandle) return 0;
  const files = await readCampaignsFromFiles();
  const idb = await campaignList();
  const byId = new Map(idb.map((c) => [c.id, c]));
  let n = 0;
  for (const fc of files) {
    if (!fc.id) continue;
    const ex = byId.get(fc.id);
    if (!ex || (fc.savedAt || 0) > (ex.savedAt || 0)) {
      await campaignPut(fc.id, fc.name, fc.state);
      n++;
    }
  }
  if (n) toast(`已从项目文件夹同步 ${n} 个战役`);
  return n;
}

async function syncCampaignsToFiles() {
  if (!projectDirHandle) return 0;
  const idb = await campaignList();
  for (const c of idb) await writeCampaignFile(c);
  return idb.length;
}

// 把主控台状态写入项目文件夹：当前状态 + 当前战役快照（绑定根目录后）
async function persistToProject() {
  if (!projectDirHandle) return;
  const text = JSON.stringify(state, null, 2);
  await writeProjectText('主控台/状态/当前状态.json', text);
  if (state.campaignId) {
    await writeProjectText('主控台/状态/战役/' + safeCampaignFolderName(state.campaignName) + '/存档.json', text);
  }
}

function libraryFileContent(list) {
  return '// 桑哆尔的世界 · 棋子库数据文件（程序自动写入，请勿手改）\nwindow.__LIBRARY_FILE__ = ' +
    JSON.stringify(list, null, 1) + ';\n';
}

async function writeLibraryFile(list) {
  try {
    const handle = await idbFilesGet('library-file');
    if (!handle) return 'unset';
    // 后台自动保存只检查权限，不反复请求权限。
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return 'denied';
    const w = await handle.createWritable();
    await w.write(libraryFileContent(list));
    await w.close();
    return 'ok';
  } catch (e) {
    console.warn('写入棋子库文件失败', e);
    return 'error';
  }
}

function scheduleLibraryFileWrite() {
  clearTimeout(libFileTimer);
  libFileTimer = setTimeout(async () => {
    const list = typeof presets !== 'undefined' ? presets : state.library;
    const r = await writeLibraryFile(list);
    updateLibPersistStatus(r);
  }, 400);
}

function updateLibPersistStatus(st) {
  const el = $('#lib-persist-status') || $('#persist-status');
  if (!el) return;
  if (st === 'ok') { el.textContent = '已固定 · 自动保存中'; el.classList.add('on'); }
  else if (st === 'denied') { el.textContent = '权限被拒 · 点📌重新固定'; el.classList.remove('on'); }
  else if (st === 'error') { el.textContent = '写入失败 · 点📌重新固定'; el.classList.remove('on'); }
  else { el.textContent = '未固定'; el.classList.remove('on'); }
}

async function persistLibraryButton() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: '棋子库数据.js',
      types: [{ description: 'JavaScript 数据文件', accept: { 'text/javascript': ['.js'] } }],
    });
    await idbFilesSet('library-file', handle);
    const list = typeof presets !== 'undefined' ? presets : state.library;
    const r = await writeLibraryFile(list);
    updateLibPersistStatus(r);
    toast(r === 'ok' ? '✅ 已永久保存：以后每次修改棋子库都会自动写入这个文件' : '保存失败，请重试');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('未能选择保存位置：' + (e.message || e));
  }
}

async function initLibPersistStatus() {
  try {
    const handle = await idbFilesGet('library-file');
    if (!handle) { updateLibPersistStatus('unset'); return; }
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    updateLibPersistStatus(perm === 'granted' ? 'ok' : 'unset');
  } catch (e) {
    updateLibPersistStatus('unset');
  }
}

const LIBRARY_EXPANSION_KEY = 'sangduoer-library-expansion-familiars-v4';
const LIBRARY_EXPANSION_NAMES = new Set(['法师之手','滚珠袋','铁蒺藜','捕兽夹','炼金火','酸液瓶','妖精马','天马','梦魇','巨鹿坐骑','忒修斯','黑胡桃','潘塞尔','拉斐尔','猫头鹰','猫','渡鸦','蝙蝠','鼠','蜘蛛','蛙','蜥蜴','蟹','隼','章鱼','毒蛇','食人鱼','海马','鼬']);

function mergeBundledLibraryExpansion(list) {
  if (localStorage.getItem(LIBRARY_EXPANSION_KEY) === '1') return list;
  list = list.filter((p) => !(p.category === '魔宠/寻找魔宠' && (p.name === '老鼠' || p.name === '蟾蜍')));
  const names = new Set(list.map((p) => p.name));
  (window.__LIBRARY_FILE__ || []).forEach((p) => {
    if (LIBRARY_EXPANSION_NAMES.has(p.name) && !names.has(p.name)) list.push(normalizeLibPreset(p));
  });
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
    localStorage.setItem(LIBRARY_EXPANSION_KEY, '1');
  } catch (e) { /* 仍可在本次会话使用 */ }
  return list;
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr) && arr.length) return mergeBundledLibraryExpansion(arr.map(normalizeLibPreset));
  } catch (e) { /* 损坏则回退到文件 */ }
  if (Array.isArray(window.__LIBRARY_FILE__) && window.__LIBRARY_FILE__.length) {
    const arr = window.__LIBRARY_FILE__.map(normalizeLibPreset);
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
    try { localStorage.setItem(LIBRARY_EXPANSION_KEY, '1'); } catch (e) { /* ignore */ }
    return arr;
  }
  return [];
}

function saveLibrary(list) {
  const data = (list || state.library).map(normalizeLibPreset);
  state.library = data;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(data));
  } catch (e) {
    toast('⚠ 棋子库保存失败：浏览器存储空间不足');
  }
  window.__LIBRARY_FILE__ = data;
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
    catTag.textContent = `${p.category || '其他'}${p.className && p.className !== '无职业' ? ' · ' + p.className : ''} · AC ${typeof p.ac === 'number' ? p.ac : 10}`;
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
    iconImgHd: (AVATAR_SOURCE_MAP[p.name] || p.iconImgPath) ? null : (p.iconImgHd || null),
    iconImgPath: canonicalPortraitPath(AVATAR_SOURCE_MAP[p.name] || p.iconImgPath),
    iconImgId: p.iconImgId || null,
    size: p.size,
    hpMax: p.hpMax,
    hp: p.hpMax,
    ac: typeof p.ac === 'number' ? p.ac : 10,
    stats: p.stats && typeof p.stats === 'object' ? { ...p.stats } : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    prof: typeof p.prof === 'number' ? p.prof : 2,
    speed: typeof p.speed === 'number' ? p.speed : 30,
    initBonus: typeof p.initBonus === 'number' ? p.initBonus : 0,
    equipment: Array.isArray(p.equipment) ? p.equipment.map((e) => ({ ...e })) : [],
    className: typeof p.className === 'string' && CLASS_META[p.className] ? p.className : '无职业',
    subClassName: typeof p.subClassName === 'string' ? p.subClassName : '',
    classResources: p.classResources && typeof p.classResources === 'object' ? { ...p.classResources } : {},
    spellSlots: p.spellSlots && typeof p.spellSlots === 'object' ? JSON.parse(JSON.stringify(p.spellSlots)) : defaultSpellSlots(),
    level: typeof p.level === 'number' ? Math.max(1, Math.min(20, p.level)) : 1,
    saveBonuses: p.saveBonuses && typeof p.saveBonuses === 'object' ? { ...p.saveBonuses } : {},
    skillProfs: p.skillProfs && typeof p.skillProfs === 'object' ? { ...p.skillProfs } : {},
    hitDice: p.hitDice && typeof p.hitDice === 'object' ? { ...p.hitDice } : null,
    x: clamp(finalX, margin, m.mapW - margin),
    y: clamp(finalY, margin, m.mapH - margin),
    statuses: [],
    statusLevels: {},
    hidden: false,
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

// 跑团台内的「棋子库」编辑器：与独立「棋子库」程序字段一一对应
function renderLibSheetStats(p) {
  const box = $('#lib-sheet-stats');
  if (!box) return;
  box.innerHTML = '';
  const stats = (p && p.stats && typeof p.stats === 'object') ? p.stats : {};
  ABILITY_KEYS.forEach((k) => {
    const v = typeof stats[k] === 'number' ? stats[k] : 10;
    const cell = document.createElement('div');
    cell.className = 'sheet-stat';
    cell.innerHTML =
      `<span class="sheet-stat-label">${ABILITY_LABELS[k]}</span>` +
      `<input type="number" data-stat="${k}" value="${v}" min="1" max="30">` +
      `<b class="sheet-stat-mod ${modClass(v)}" data-mod="${k}">${modText(v)}</b>`;
    box.appendChild(cell);
  });
}

function updateLibStatMods() {
  const box = $('#lib-sheet-stats');
  if (!box) return;
  box.querySelectorAll('input[data-stat]').forEach((inp) => {
    const k = inp.dataset.stat;
    if (!k) return;
    const v = clamp(parseInt(inp.value, 10) || 10, 1, 30);
    const m = box.querySelector(`.sheet-stat-mod[data-mod="${k}"]`);
    if (m) {
      m.textContent = modText(v);
      m.className = `sheet-stat-mod ${modClass(v)}`;
    }
  });
}

function initLibEqSelect() {
  const sel = $('#lib-eq-select');
  if (!sel) return;
  sel.innerHTML = '';
  EQUIPMENT_PRESETS.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${e.name}（${e.type === 'armor' ? '护甲 AC' + e.baseAC : e.type === 'shield' ? '盾 +' + e.acBonus : e.dice}）`;
    sel.appendChild(opt);
  });
}

function renderLibEqList() {
  renderEqRows($('#lib-eq-list'), libEqDraft);
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
  libEqDraft = [];
  $('#lib-editor').hidden = false;
  populateLibCatSelects();
  const p = id === 'new' ? null : state.library.find((x) => x.id === id);
  if (id === 'new') {
    $('#lib-name').value = '';
    $('#lib-type').value = 'enemy';
    $('#lib-class').value = '无职业';
    const subNew = $('#lib-subclass');
    if (subNew) { populateSubclassSelect(subNew, '无职业'); subNew.value = ''; }
    $('#lib-hp').value = 10;
    $('#lib-ac').value = 10;
    $('#lib-size').value = '1';
    $('#lib-prof').value = 2;
    $('#lib-speed').value = 30;
    $('#lib-initbonus').value = 0;
    $('#lib-icon').value = '';
    libEdCatPrev = '';
    $('#lib-cat1').value = '其他';
    fillLibCat2();
  } else {
    if (!p) { closeLibEditor(); return; }
    $('#lib-name').value = p.name;
    $('#lib-type').value = p.type;
    $('#lib-class').value = (p.className && CLASS_META[p.className]) ? p.className : '无职业';
    const subEdit = $('#lib-subclass');
    if (subEdit) {
      populateSubclassSelect(subEdit, (p.className && CLASS_META[p.className]) ? p.className : '无职业');
      subEdit.value = p.subClassName || '';
    }
    $('#lib-hp').value = p.hpMax;
    $('#lib-ac').value = typeof p.ac === 'number' ? p.ac : 10;
    $('#lib-size').value = String(p.size);
    $('#lib-prof').value = typeof p.prof === 'number' ? p.prof : 2;
    $('#lib-speed').value = typeof p.speed === 'number' ? p.speed : 30;
    $('#lib-initbonus').value = typeof p.initBonus === 'number' ? p.initBonus : 0;
    libEqDraft = Array.isArray(p.equipment) ? p.equipment.map((e) => ({ ...e })) : [];
    $('#lib-icon').value = p.icon || '';
    const editPath = canonicalPortraitPath(AVATAR_SOURCE_MAP[p.name] || p.iconImgPath);
    libAvatar = p.iconImg || p.iconImgHd || editPath || p.iconImgId
      ? { iconImgId: p.iconImgId || null, iconImg: p.iconImg || null, iconImgHd: editPath ? null : (p.iconImgHd || null), iconImgPath: editPath }
      : null;
    const parts = catParts(p.category || '其他');
    if (parts[0] && [...$('#lib-cat1').options].some((o) => o.value === parts[0])) $('#lib-cat1').value = parts[0];
    fillLibCat2(p.category);
  }
  renderLibSheetStats(p);
  renderLibEqList();
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
  const oldPreset = state.library.find((x) => x.id === libEditorId);
  const stats = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  $('#lib-sheet-stats').querySelectorAll('input[data-stat]').forEach((inp) => {
    if (inp.dataset.stat) stats[inp.dataset.stat] = clamp(parseInt(inp.value, 10) || 10, 1, 30);
  });
  const preset = {
    id: libEditorId === 'new' ? 'l' + (uid++) : libEditorId,
    name,
    type: $('#lib-type').value,
    category: readLibCatSelects(),
    className: $('#lib-class').value,
    subClassName: $('#lib-subclass').value,
    classResources: oldPreset && oldPreset.classResources ? JSON.parse(JSON.stringify(oldPreset.classResources)) : {},
    spellSlots: oldPreset && oldPreset.spellSlots ? JSON.parse(JSON.stringify(oldPreset.spellSlots)) : null,
    level: oldPreset && typeof oldPreset.level === 'number' ? oldPreset.level : 1,
    saveBonuses: oldPreset && oldPreset.saveBonuses ? { ...oldPreset.saveBonuses } : {},
    skillProfs: oldPreset && oldPreset.skillProfs ? { ...oldPreset.skillProfs } : {},
    hitDice: oldPreset && oldPreset.hitDice ? { ...oldPreset.hitDice } : null,
    icon: $('#lib-icon').value.trim(),
    iconImg: libAvatar ? libAvatar.iconImg : null,
    iconImgHd: libAvatar ? libAvatar.iconImgHd : null,
    iconImgPath: libAvatar ? libAvatar.iconImgPath || null : null,
    iconImgId: libAvatar ? libAvatar.iconImgId : null,
    size: parseInt($('#lib-size').value, 10) === 2 ? 2 : 1,
    hpMax: Math.max(1, parseInt($('#lib-hp').value, 10) || 10),
    ac: Math.max(0, parseInt($('#lib-ac').value, 10) || 10),
    stats,
    prof: clamp(parseInt($('#lib-prof').value, 10) || 2, 0, 12),
    speed: clamp(parseInt($('#lib-speed').value, 10) || 30, 0, 120),
    initBonus: parseInt($('#lib-initbonus').value, 10) || 0,
    equipment: libEqDraft.map((e) => ({ ...e })),
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
    m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize);
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
  m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize);
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
  if (m.cells[row][col] === target) {
    // 涂同样的格子：无变化则跳过；橡皮在底图已一致时也跳过（不产生撤销记录）
    if (!isErase || cellMatchesBase(m, col, row)) return;
  }
  mapEditHistory.push({
    id: m.id,
    col,
    row,
    old: m.cells[row][col],
    oldState: Object.prototype.hasOwnProperty.call(m.cellStates || {}, key) ? m.cellStates[key] : undefined,
  });
  if (mapEditHistory.length > 200) mapEditHistory.shift();
  m.cells[row][col] = target;
  if (isErase) restoreCellState(m, col, row);
  else delete (m.cellStates || {})[key];
  m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize);
  updateWorldBackground();
  scheduleAutosave();
}

function cellMatchesBase(m, col, row) {
  const key = `${col},${row}`;
  const cur = m.cellStates || {};
  const base = m.baseCellStates || {};
  const curHas = Object.prototype.hasOwnProperty.call(cur, key);
  const baseHas = Object.prototype.hasOwnProperty.call(base, key);
  return curHas === baseHas && (!curHas || cur[key] === base[key]);
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
    m.mapData = renderCellsToDataUrl(m.cells, m.cellStates, m.gridSize);
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
    group.tiles.forEach((id) => {
      const b = document.createElement('button');
      b.className = 'tile-btn';
      b.dataset.tile = id;
      b.title = TILE_LABELS[id] || id;
      const cv = document.createElement('canvas');
      cv.width = 40;
      cv.height = 40;
      drawCell(cv.getContext('2d'), 2, 2, 36, id, null);
      const label = document.createElement('span');
      label.className = 'tile-label';
      label.textContent = TILE_LABELS[id] || id;
      b.append(cv, label);
      b.addEventListener('click', () => {
        if (editTile === id && boardTool === 'tile-paint') boardTool = null;
        else { editTile = id; boardTool = 'tile-paint'; }
        syncBoardTools();
      });
      row.appendChild(b);
    });
    tileBox.appendChild(row);
  });
}

function syncPalettes() {
  document.querySelectorAll('#map-edit-tiles .tile-btn').forEach((b) => {
    b.classList.toggle('active', boardTool === 'tile-paint' && b.dataset.tile === editTile);
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
  g.fillStyle = 'rgba(8,10,16,.92)';
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
loadProjectDirHandle();
(async () => {
  await loadProjectDirHandle();
  if (projectDirHandle) {
    try {
      if (await projectDirHandle.queryPermission({ mode: 'readwrite' }) === 'granted') {
        await syncCampaignsFromFiles();
      }
    } catch (e) { /* 未授权就等用户打开战役管理时再同步 */ }
  }
})();
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
window.addEventListener('pagehide', () => {
  if (campaignSaveTimer) { clearTimeout(campaignSaveTimer); persistActiveCampaign(); }
  if (streamOn) streamPush();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && campaignSaveTimer) {
    clearTimeout(campaignSaveTimer);
    persistActiveCampaign();
  }
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
initLibEqSelect();
initLibPersistStatus();
restoreStreamFromStorage();
// 左侧面板默认全部折叠
document.querySelectorAll('#left-panel .card').forEach((c) => c.classList.add('collapsed'));
loadLinks();
renderLinks();
// 人物卡默认收起，选中棋子时自动展开
const unitCard = document.querySelector('#unit-card');
if (unitCard) unitCard.classList.add('collapsed');
updateCoverContinue();
setTimeout(() => { prewarmAvatarCache(); }, 1000);
