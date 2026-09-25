/* ==================== 持久化 ==================== */

function stateStorageReplacer(key, value) {
  if (key === 'turnPath' && this === state.encounter) return undefined;
  // 棋子 GM 私密备注功能已经移除；旧存档中的字段在下一次保存时一并清理。
  if (key === 'gmNote') return undefined;
  // 棋子库是全局数据，只写入“存档/棋子库/棋子库.json”。
  if (key === 'library' && this === state) return undefined;
  // 已移除的旧全局地图显示功能不再写回；每张地图的 gridVisible 继续保存。
  if ((key === 'showGrid' || key === 'markMode' || key === 'fogOn') && this === state) return undefined;
  if (key === 'fog' && this && Array.isArray(this.tokens)) return undefined;
  if (['cellStates', 'baseCells', 'baseCellStates', 'baseCellVariants'].includes(key) && this && Array.isArray(this.tokens)) return undefined;
  if ((key === 'iconImgHd' || key === 'iconImg') && this && this.iconImgPath) return null;
  return value;
}

function stateStorageJson(space) {
  return JSON.stringify(state, stateStorageReplacer, space);
}

function stateStorageSnapshot() {
  return JSON.parse(stateStorageJson());
}

function browserStorageIssue(error) {
  const quotaExceeded = error && (
    error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014
  );
  return quotaExceeded ? '浏览器恢复缓存已满' : '浏览器恢复缓存不可用';
}

function cacheLoadedStateInBrowser(savedAt = 0) {
  try { if (state.campaignId) localStorage.setItem(typeof modularStorage !== 'undefined' && modularStorage ? STORAGE_KEY + ':last-campaign' : 'dnd-board-last-campaign-id', state.campaignId); } catch (e) { /* 正式存档仍可读取 */ }
  try {
    localStorage.setItem(STORAGE_KEY, stateStorageJson());
    localStorage.setItem('dnd-board-local-save-at', String(Number(savedAt) || 0));
    browserStateCacheFailed = false;
    return { ok: true, issue: '' };
  } catch (error) {
    browserStateCacheFailed = true;
    console.warn('正式存档已读取，但浏览器恢复缓存写入失败', error);
    return { ok: false, issue: browserStorageIssue(error) };
  }
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

function queryPublicBase() {
  try {
    const base = normalizeServerBase(new URLSearchParams(location.search).get('public'));
    if (!base) return '';
    const url = new URL(base);
    return isLoopbackHost(url.hostname) ? '' : base;
  } catch (e) {
    return '';
  }
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
  const publicBase = streamInfo && Object.prototype.hasOwnProperty.call(streamInfo, 'publicBase')
    ? normalizeServerBase(streamInfo.publicBase) : queryPublicBase();
  if (publicBase) return `${publicBase}/主控台/玩家.html${room}`;
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

let pendingFolderSave = null;
function queueCurrentFolderSave(options = {}) {
  if (campaignLoadInProgress) return Promise.resolve(false);
  const campaignId = state.campaignId;
  if (!campaignId) {
    updateSaveStatus('临时进度 · 仅浏览器缓存', 'error');
    return Promise.resolve(false);
  }
  const campaignName = state.campaignName || '未命名战役';
  const snapshot = folderSaveSnapshot();
  const makeBackup = options.backup === true;
  if (pendingFolderSave?.campaignId === campaignId) {
    pendingFolderSave.snapshot = snapshot;
    pendingFolderSave.campaignName = campaignName;
    pendingFolderSave.makeBackup ||= makeBackup;
    return folderSaveQueue;
  }
  const job = { campaignId, campaignName, snapshot, makeBackup };
  pendingFolderSave = job;
  folderSaveQueue = folderSaveQueue.catch(() => false).then(async () => {
    if (pendingFolderSave === job) pendingFolderSave = null;
    const { campaignId, campaignName, snapshot, makeBackup } = job;
    if (!projectDirHandle || !(await hasSaveFolderPermission())) {
      updateSaveStatus('未写入“存档”文件夹 · 请重新授权', 'error');
      return false;
    }
    updateSaveStatus('正在写入存档文件夹…', 'busy');
    try {
      const record = await campaignPut(campaignId, campaignName, snapshot, { backup: makeBackup });
      await rememberCampaignSelection(campaignId);
      lastFolderSaveAt = Number(record?.savedAt) || Date.now();
      try { localStorage.setItem('dnd-board-last-folder-save-at', String(lastFolderSaveAt)); } catch (e) { /* 忽略 */ }
      updateSaveStatus(`文件夹已保存 ${new Date(lastFolderSaveAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ok');
      if ($('#campaign-modal') && !$('#campaign-modal').hidden) renderCampaignList();
      if ($('#cover') && !$('#cover').hidden) refreshHostHome({ forceRecords: true });
      return true;
    } catch (error) {
      console.warn('写入存档文件夹失败', error);
      updateSaveStatus(`保存未完成：${error.message || '写入失败'} · 请保留当前页面`, 'error');
      return false;
    }
  });
  return folderSaveQueue;
}

async function loadFolderSave(item, confirmLoad = true) {
  if (!item?.path) return false;
  if (campaignLoadInProgress) { toast('正在读取存档，请稍候'); return false; }
  campaignLoadInProgress = true;
  let applied = false;
  const hadPendingAutosave = Boolean(autosaveTimer);
  try {
    flushDetailTextSave();
    await folderSaveQueue;
    const compactRead = usingLocalSaveBridge() ? await localSaveApiRequest('read-campaign', { path: item.path }) : null;
    const text = compactRead ? compactRead.text : await readBoundText(item.path);
    const data = parseCampaignFile(text, item.folderName || '');
    if (!data?.state) {
      toast('存档文件无效或已经损坏');
      return false;
    }
    if (confirmLoad && !confirm(`读取存档「${item.name}」？当前未保存内容会被替换。`)) return false;
    if (state.campaignId) await writeRecoverySnapshot('读取前恢复点', folderSaveSnapshot());
    const loadedHash = compactRead ? compactRead.sourceHash : await campaignTextHash(text);
    if (!applySavedState(data.state)) throw new Error('存档结构无效，当前战役未修改');
    campaignLoadedHashes.set(data.id || data.state.campaignId, loadedHash);
    applied = true;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
    applyAllState();
    loadLinks();
    renderLinks();
    const browserCache = cacheLoadedStateInBrowser(data.savedAt);
    try { await rememberCampaignSelection(state.campaignId); } catch (e) {
      toast(`战役已读取，但上次打开记录未保存：${e.message}`);
    }
    if (browserCache.ok) {
      updateSaveStatus(`已读取 ${item.name}`, 'ok');
      toast(`已读取存档「${item.name}」`);
    } else {
      updateSaveStatus(`已读取 ${item.name} · ${browserCache.issue}`, 'error');
      toast(`已读取存档「${item.name}」；${browserCache.issue}，正式文件仍可使用`);
    }
    streamDirty = true;
    return true;
  } catch (error) {
    console.warn('读取文件夹存档失败', error);
    toast(`${applied ? '存档已读取，但界面刷新失败' : '读取存档失败'}：${error.message || '无法读取文件'}`);
    return false;
  } finally {
    campaignLoadInProgress = false;
    if (!applied && hadPendingAutosave && !autosaveTimer) scheduleAutosave(false);
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
  let lastCampaignId = '';
  try { lastCampaignId = localStorage.getItem(typeof modularStorage !== 'undefined' && modularStorage ? STORAGE_KEY + ':last-campaign' : 'dnd-board-last-campaign-id') || ''; } catch (e) { /* 使用当前进度 */ }
  try { const index = JSON.parse(await readBoundText(SAVE_INDEX_FILE) || '{}'); lastCampaignId = index.lastCampaignId || lastCampaignId; } catch (e) { /* 兼容旧索引 */ }
  // 每次恢复都重读磁盘；读取过缓存的时间不能证明缓存比正式文件更新。
  const records = await readCampaignRecords(true);
  const requestedId = lastCampaignId || state.campaignId;
  const record = requestedId ? records.find(item => item.id === requestedId) : records[0];
  if (!record) {
    updateSaveStatus(requestedId ? '上次战役未找到或无法读取 · 请手动选择存档' : '文件夹已连接 · 尚无正式存档', requestedId ? 'error' : 'ok');
    return !requestedId;
  }
  // loadFolderSave 在替换前保存恢复点，保留浏览器中可能尚未落盘的进度。
  return loadFolderSave({ ...record, path: record._path, folderName: record._folderName }, false);
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
  if (campaignLoadInProgress) return false;
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
  flushDetailTextSave();
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
  toast(ok ? `✅ 已保存「${state.campaignName}」` : ($('#save-status')?.textContent || '保存未完成，请保留当前页面'));
}

function loadSaved() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  if (!raw) return false;
  try { return applySavedState(JSON.parse(raw)); } catch (e) {
    console.warn('浏览器恢复点损坏，将尝试读取正式存档', e);
    return false;
  }
}

function nextSafeCounter(ids) {
  // 时间戳加随机后缀不是递增编号；拼接其数字会超过安全整数范围。
  return ids.reduce((max, id) => {
    const match = /^[a-z]+(\d+)$/i.exec(String(id));
    const n = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(n) && n < 1e12 ? Math.max(max, n + 1) : max;
  }, 1);
}

function repairDuplicateTokenIds(maps) {
  const used = new Set(maps.flatMap((m) => m.tokens.map((t) => t.id)));
  const seen = new Set();
  for (const m of maps) {
    for (const t of m.tokens) {
      if (!t.id || seen.has(t.id)) {
        let id;
        do { id = 't-' + crypto.randomUUID(); } while (used.has(id));
        t.id = id;
        used.add(id);
      }
      seen.add(t.id);
    }
  }
}

function applySavedState(s) {
  const previousState = { ...state };
  const previousLinks = userLinks;
  const previousUid = uid;
  const previousMigrations = pendingLegacyPortraitMigrations;
  try {
    if (!s || typeof s !== 'object' || Array.isArray(s)
      || (!Array.isArray(s.maps) && !Array.isArray(s.tokens) && !Object.hasOwn(s, 'mapData'))) {
      throw new Error('存档缺少地图数据');
    }
    // 加载时的标准化不得污染目录缓存或调用方持有的原始存档。
    s = JSON.parse(JSON.stringify(s));
    // Reject ambiguous imported identities before mutating the open campaign.
    const ownedIds = new Set();
    for (const map of (Array.isArray(s.maps) ? s.maps : [])) {
      for (const token of (Array.isArray(map.tokens) ? map.tokens : [])) {
        if (!token?.ownedPieceId) continue;
        if (ownedIds.has(token.ownedPieceId)) throw new Error('存档包含重复的个人棋子身份，请检查原存档；当前战役未修改');
        ownedIds.add(token.ownedPieceId);
      }
    }

    const parkedTokens = Object.values(s.parkedOwnedPieces || {});
    const travelTokens = s.travelBasketTokens === undefined ? [] : s.travelBasketTokens;
    if (!Array.isArray(travelTokens) || travelTokens.some(t=>!t || typeof t!=='object' || !t.id || t.ownedPieceId)) throw new Error('旅行篮子存档无效，当前战役未修改');
    const travelIds = new Set((s.maps||[]).flatMap(m=>(m.tokens||[]).map(t=>t.id)));
    for (const token of [...parkedTokens,...travelTokens]) {
      if (!token || !token.id || travelIds.has(token.id) || (token.ownedPieceId && ownedIds.has(token.ownedPieceId))) throw new Error('旅行篮子与地图包含重复的棋子身份，当前战役未修改');
      travelIds.add(token.id);
      if(token.ownedPieceId)ownedIds.add(token.ownedPieceId);
    }

    state.snap = s.snap !== false;
    state.showNames = s.showNames !== false;
    state.campaignId = s.campaignId || null;
    state.travelBasketSkin = ['stone-road','travel-wagon','star-portal','forest-path','snow-trail','voyage-ship','country-road','desert-sand','mountain-trail','swamp-path','coastal-beach','cavern-floor','dungeon-stone','wood-boardwalk','volcanic-ground'].includes(s.travelBasketSkin)?s.travelBasketSkin:(s.travelBasketSkin==='road'?'stone-road':s.travelBasketSkin==='ship'?'voyage-ship':'travel-wagon');
    // Opening a campaign always starts with the travel basket closed.
    state.travelBasketOpen = false;
    state.travelBasketTokens = Array.isArray(s.travelBasketTokens) ? JSON.parse(JSON.stringify(s.travelBasketTokens)) : [];
    state.parkedOwnedPieces = s.parkedOwnedPieces && typeof s.parkedOwnedPieces === 'object' ? JSON.parse(JSON.stringify(s.parkedOwnedPieces)) : {};
    state.campaignName = s.campaignName || '默认战役';
    state.sharedResources = Array.isArray(s.sharedResources)
      ? s.sharedResources.map(normalizeLink).filter(Boolean) : [];
    state.sharedNotes = typeof s.sharedNotes === 'string' ? s.sharedNotes.slice(0, 4000) : '';
    state.prepHandbook = typeof SundollPrepHandbook !== 'undefined' ? SundollPrepHandbook.normalize(s.prepHandbook) : (Array.isArray(s.prepHandbook) ? s.prepHandbook : []);
    state.journal = CampaignJournal.normalize(s.journal, state.campaignId);
    state.mapChapters = Array.isArray(s.mapChapters)
      ? s.mapChapters.map((chapter) => ({ id: chapter?.id, name: chapter?.name })) : [];
    state.mapLocations = Array.isArray(s.mapLocations)
      ? s.mapLocations.map((location) => ({ id: location?.id, chapterId: location?.chapterId, name: location?.name })) : [];
    userLinks = state.sharedResources.slice();
    state.selectedId = null;
    state.encounter = normalizeEncounter(s.encounter);
    if (!loadLibrary().length && Array.isArray(s.library) && s.library.length) {
      // 旧版本：棋子库曾存在主存档里，迁移到共享存储
      state.library = s.library.map(normalizeLibPreset);
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
      } else if (!t.ownedPieceId && migrateLegacyTokenPortrait(t, portraitLibrary)) {
        migratedPortraits++;
      }
      Object.assign(t, SundollSize.normalize(t));
      if (typeof t.hp !== 'number') t.hp = t.hpMax || 10;
      t.tempHp = clamp(parseInt(t.tempHp, 10) || 0, 0, 99999);
      if (typeof t.ac !== 'number') t.ac = 10;
      normalizeSheet(t);
      return t;
    };

    if (Array.isArray(s.maps)) {
      state.maps = s.maps.map((m) => ({
        id: m.id,
        name: m.name || '未命名地图',
        chapterId: m.chapterId || null,
        locationId: m.locationId || null,
        floorLabel: m.floorLabel || m.name || '地图',
        playerAccessible: typeof m.playerAccessible === 'boolean' ? m.playerAccessible : undefined,
        mapData: m.mapData || null,
        mapW: m.mapW || 1400,
        mapH: m.mapH || 900,
        gridSize: m.gridSize || 50,
        gridLineWidth: clamp(Number(m.gridLineWidth) || 2, .5, 8),
        gridOffsetX: clamp(Number(m.gridOffsetX) || 0, -3000, 3000),
        gridOffsetY: clamp(Number(m.gridOffsetY) || 0, -3000, 3000),
        gridVisible: typeof m.gridVisible === 'boolean' ? m.gridVisible : s.showGrid !== false,
        cells: Array.isArray(m.cells) ? m.cells.map((r) => r.slice()) : null,
        cellVariants: m.cellVariants && typeof m.cellVariants === 'object' ? { ...m.cellVariants } : {},
        doodles: Array.isArray(m.doodles) ? m.doodles : [],
        tokens: Array.isArray(m.tokens) ? m.tokens.map(normalizeToken) : [],
        cam: m.cam || { x: 0, y: 0, zoom: 1 },
      }));
      state.activeMapId = mapById(s.activeMapId) ? s.activeMapId : state.maps[0]?.id || null;
      state.presentedMapId = mapById(s.presentedMapId) ? s.presentedMapId : state.activeMapId;
      ensureMapNavigation();
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
        s.showGrid !== false
      );
      legacy.tokens = Array.isArray(s.tokens) ? s.tokens.map(normalizeToken) : [];
      legacy.cells = null;
      legacy.cellVariants = {};
      legacy.doodles = [];
      legacy.cam = s.cam || legacy.cam;
      state.maps = [legacy];
      state.activeMapId = legacy.id;
      state.presentedMapId = legacy.id;
      ensureMapNavigation();
    }
    repairDuplicateTokenIds(state.maps);
    // 旧版手动先攻只有名字；仅在当前地图存在唯一同名棋子时自动补上关联。
    // 骑手和坐骑若曾分别存在，也会在这里安全合并为同一个先攻项。
    reconcileInitiativeEntries({ linkLegacyNames: true });
    const unlinkedInitiativeEntries = state.encounter.entries.filter((entry) => !initiativeEntryToken(entry));
    if (state.encounter.playMode === 'turn' && unlinkedInitiativeEntries.length) {
      state.encounter.playMode = 'prepare';
      state.encounter.currentEntryId = null;
      bumpEncounterTurn(state.encounter);
      setEncounterEvent(state.encounter, `旧先攻中有 ${unlinkedInitiativeEntries.length} 项未关联棋子，请重新加入后开始战斗`);
    }

    const ids = state.maps.flatMap((m) => [m.id, ...m.tokens.map((t) => t.id)])
      .concat((state.travelBasketTokens||[]).map(t=>t.id),Object.values(state.parkedOwnedPieces||{}).map(t=>t.id))
      .concat(state.library.map((p) => p.id))
      .concat(state.encounter.entries.map((entry) => entry.id));
    uid = nextSafeCounter(ids);
    renumberAllMaps();
    pendingLegacyPortraitMigrations = migratedPortraits;
    return true;
  } catch (e) {
    for (const key of Object.keys(state)) {
      if (!Object.hasOwn(previousState, key)) delete state[key];
    }
    Object.assign(state, previousState);
    userLinks = previousLinks;
    uid = previousUid;
    pendingLegacyPortraitMigrations = previousMigrations;
    console.warn('读取存档失败', e);
    return false;
  }
}


const SAVE_ROOT_DIR = '存档';
const SAVE_CAMPAIGN_DIR = '战役';
const SAVE_LIBRARY_DIR = '棋子库';
const SAVE_LIBRARY_FILE = SAVE_LIBRARY_DIR + '/棋子库.json';
const SAVE_INDEX_FILE = '存档索引.json';
const CAMPAIGN_COVER_FILES = ['封面.webp', '封面.jpg', '封面.jpeg', '封面.png'];
const CAMPAIGN_COVER_WIDTH = 1600;
const CAMPAIGN_COVER_HEIGHT = 900;
const MAX_CAMPAIGN_COVER_UPLOAD_BYTES = 25 * 1024 * 1024;
const LOCAL_SAVE_API_PATH = '/api/local-save';
const LOCAL_SAVE_API_HEADER = 'X-Sundoll-Local-Save';
const LOCAL_SAVE_BRIDGE_HANDLE = Object.freeze({ kind: 'directory', name: SAVE_ROOT_DIR, source: 'local-server' });
let projectDirHandle = null; // 兼容旧变量名：现在始终代表用户选中的“存档”文件夹本身。
let campaignRecordsCache = null;
const campaignCoverCache = new Map();
const campaignLoadedHashes = new Map();
let localSaveApiAvailable = false;
let modularStorage = false;
let loadedCatalogHash = null;

function usingLocalSaveBridge() {
  return projectDirHandle === LOCAL_SAVE_BRIDGE_HANDLE;
}

async function localSaveApiRequest(op, payload = {}) {
  const response = await fetch(LOCAL_SAVE_API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [LOCAL_SAVE_API_HEADER]: '1' },
    body: JSON.stringify({ op, ...payload, ...(payload.path === '棋子库/棋子库.json' && op === 'write' ? {catalogHash:loadedCatalogHash}:{}), protocolVersion: globalThis.SundollProtocol?.version }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || '本机存档服务不可用');
  if (payload.path === '棋子库/棋子库.json' && 'catalogHash' in data) loadedCatalogHash=data.catalogHash;
  return data;
}

async function loadProjectDirHandle() {
  localSaveApiAvailable = false;
  try {
    const info = await localSaveApiRequest('status');
    if (info.mode === 'local-project' && info.name === SAVE_ROOT_DIR) {
      localSaveApiAvailable = true;
      modularStorage = info.modular === true;
      if (modularStorage) {
        const suffix = ':' + info.storageId;
        STORAGE_KEY = 'dnd-board-state-v3' + suffix;
        LIBRARY_KEY = 'dnd-board-library-v3' + suffix;
        LIBRARY_SAVED_AT_KEY = 'dnd-board-library-saved-at-v3' + suffix;
        LIBRARY_RECENT_KEY = 'dnd-board-library-recent-v3' + suffix;
        LINKS_KEY = 'sangduoer-links-v3' + suffix;
      }
      projectDirHandle = LOCAL_SAVE_BRIDGE_HANDLE;
      campaignRecordsCache = null;
      clearCampaignCoverCache();
      return projectDirHandle;
    }
  } catch (e) {
    if (location.protocol !== 'file:') {
      projectDirHandle = null;
      throw new Error('本机工作区服务不可用，请重新启动程序后刷新；未载入旧目录缓存');
    }
  }
  try {
    projectDirHandle = await idbFilesGet(SAVE_HANDLE_KEY);
    if (projectDirHandle?.name !== SAVE_ROOT_DIR) projectDirHandle = null;
  } catch (e) {
    projectDirHandle = null;
  }
  campaignRecordsCache = null;
  clearCampaignCoverCache();
  return projectDirHandle;
}

async function hasSaveFolderPermission() {
  if (!projectDirHandle) return false;
  if (usingLocalSaveBridge()) return localSaveApiAvailable;
  try { return await projectDirHandle.queryPermission({ mode: 'readwrite' }) === 'granted'; }
  catch (e) { return false; }
}

async function ensureSaveFolderAccess(requestPermission = false) {
  if (usingLocalSaveBridge()) {
    try {
      await localSaveApiRequest('status');
      localSaveApiAvailable = true;
      return true;
    } catch (e) {
      localSaveApiAvailable = false;
      updateSaveStatus('本机存档服务不可用', 'error');
      return false;
    }
  }
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
  if (modularStorage) { await SundollModules.open('backups'); return false; }
  if (!window.showDirectoryPicker) {
    toast('当前浏览器不支持文件夹存档，请在主机上使用 Chrome / Edge');
    return false;
  }
  try {
    alert('请选择“程序包/运行数据/存档”文件夹。\n\n程序会直接使用该文件夹，不会再额外创建嵌套目录。');
    const handle = await window.showDirectoryPicker({ id: 'sangduoer-save-root-v2', mode: 'readwrite' });
    if (handle.name !== SAVE_ROOT_DIR) {
      toast('请选择名称正好为“存档”的文件夹');
      return false;
    }
    projectDirHandle = handle;
    localSaveApiAvailable = false;
    campaignRecordsCache = null;
    clearCampaignCoverCache();
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
  if (usingLocalSaveBridge()) {
    await localSaveApiRequest('status');
    return true;
  }
  await getDirHandle(projectDirHandle, SAVE_CAMPAIGN_DIR);
  await getDirHandle(projectDirHandle, SAVE_LIBRARY_DIR);
  return true;
}

async function readBoundText(relPath) {
  if (usingLocalSaveBridge()) {
    try {
      const data = await localSaveApiRequest('read', { path: relPath });
      return typeof data.text === 'string' ? data.text : null;
    } catch (e) {
      return null;
    }
  }
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
  if (usingLocalSaveBridge()) {
    try {
      const data = await localSaveApiRequest('list', { path: relPath, kind });
      return Array.isArray(data.entries) ? data.entries : [];
    } catch (e) {
      return [];
    }
  }
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
  if (usingLocalSaveBridge()) {
    try {
      await localSaveApiRequest('write', { path: relPath, text });
      return true;
    } catch (e) {
      console.warn('写入本机存档失败', e);
      return false;
    }
  }
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

async function readBoundBlob(relPath) {
  if (usingLocalSaveBridge()) {
    try {
      const data = await localSaveApiRequest('read-binary', { path: relPath });
      if (!data.base64) return null;
      const binary = atob(data.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: data.mime || 'application/octet-stream' });
    } catch (e) {
      return null;
    }
  }
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return null;
  try {
    const idx = relPath.lastIndexOf('/');
    const dirPath = idx >= 0 ? relPath.slice(0, idx) : '';
    const name = idx >= 0 ? relPath.slice(idx + 1) : relPath;
    const dir = dirPath ? await getDirHandle(projectDirHandle, dirPath, false) : projectDirHandle;
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch (e) {
    return null;
  }
}

async function writeBoundBlob(relPath, blob) {
  if (!(blob instanceof Blob)) return false;
  if (usingLocalSaveBridge()) {
    try {
      const dataUrl = await readFileAsDataUrl(blob);
      const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await localSaveApiRequest('write-binary', { path: relPath, base64: encoded });
      return true;
    } catch (e) {
      console.warn('写入本机战役封面失败', e);
      return false;
    }
  }
  if (!projectDirHandle || !(await hasSaveFolderPermission())) return false;
  try {
    const idx = relPath.lastIndexOf('/');
    const dirPath = idx >= 0 ? relPath.slice(0, idx) : '';
    const name = idx >= 0 ? relPath.slice(idx + 1) : relPath;
    const dir = dirPath ? await getDirHandle(projectDirHandle, dirPath) : projectDirHandle;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    console.warn('写入战役封面失败', e);
    return false;
  }
}

function clearCampaignCoverCache(folderName = '') {
  if (folderName) campaignCoverCache.delete(folderName);
  else campaignCoverCache.clear();
}

async function readCampaignCover(folderName) {
  const directory = `${SAVE_CAMPAIGN_DIR}/${folderName}`;
  const files = await listBoundFiles(directory);
  const file = CAMPAIGN_COVER_FILES
    .map((name) => files.find((entry) => entry.name === name))
    .find(Boolean);
  if (!file) {
    clearCampaignCoverCache(folderName);
    return null;
  }
  const cacheKey = `${file.name}:${file.lastModified || 0}:${file.size || 0}`;
  const cached = campaignCoverCache.get(folderName);
  if (cached?.cacheKey === cacheKey) return cached;
  const blob = await readBoundBlob(`${directory}/${file.name}`);
  if (!blob) return null;
  const cover = {
    cacheKey,
    fileName: file.name,
    url: await readFileAsDataUrl(blob),
  };
  campaignCoverCache.set(folderName, cover);
  return cover;
}

async function deleteBoundEntry(relPath, recursive = false) {
  if (usingLocalSaveBridge()) {
    try {
      await localSaveApiRequest('delete', { path: relPath, recursive });
      return true;
    } catch (e) {
      return false;
    }
  }
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
      return { id, name, savedAt: Number(data.savedAt) || 0, state: { ...data.state, campaignId: id, campaignName: name } };
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

function campaignRecordSummary(record) {
  const saved = record.state || {};
  return { ...record, hasLegacyLibrary: Boolean(record.hasLegacyLibrary || saved.library?.length), state: {
    activeMapId: saved.activeMapId,
    maps: (saved.maps || []).map(m => ({ id: m.id, name: m.name, tokenCount: m.tokenCount ?? m.tokens?.length ?? 0 })),
  } };
}

async function readCampaignRecords(force = false) {
  if (!force && Array.isArray(campaignRecordsCache)) return campaignRecordsCache.slice();
  if (usingLocalSaveBridge()) {
    const data = await localSaveApiRequest('campaign-catalog');
    const byId = new Map();
    for (const item of data.records || []) {
      const cover = await readCampaignCover(item._folderName);
      const record = { ...item, coverFile: cover?.fileName || '', coverUrl: cover?.url || '' };
      if (!byId.has(record.id) || record.savedAt > byId.get(record.id).savedAt) byId.set(record.id, record);
    }
    campaignRecordsCache = [...byId.values()].sort((a,b) => b.savedAt-a.savedAt);
    return campaignRecordsCache.slice();
  }
  const folders = await listBoundDirs(SAVE_CAMPAIGN_DIR);
  const byId = new Map();
  for (const folderName of folders) {
    if (await readBoundText(`${SAVE_CAMPAIGN_DIR}/${folderName}/已删除.json`)) continue;
    const path = `${SAVE_CAMPAIGN_DIR}/${folderName}/当前存档.json`;
    const parsed = parseCampaignFile(await readBoundText(path), folderName);
    if (!parsed) continue;
    const cover = await readCampaignCover(folderName);
    const record = {
      ...campaignRecordSummary(parsed),
      coverFile: cover?.fileName || '',
      coverUrl: cover?.url || '',
      _folderName: folderName,
      _path: path,
    };
    const previous = byId.get(record.id);
    if (!previous || record.savedAt >= previous.savedAt) byId.set(record.id, record);
  }
  campaignRecordsCache = [...byId.values()].sort((a, b) => b.savedAt - a.savedAt);
  return campaignRecordsCache.slice();
}

async function trimAutomaticBackups(folderName) {
  const dir = `${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份`;
  // 只轮换程序生成的时间戳备份；恢复点和人工备份长期保留。
  const files = (await listBoundFiles(dir)).filter((item) => /^\d+\.json$/.test(item.name));
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
  const cover = await readCampaignCover(sourceFolder);
  if (cover?.fileName) {
    const blob = await readBoundBlob(`${SAVE_CAMPAIGN_DIR}/${sourceFolder}/${cover.fileName}`);
    if (blob) await writeBoundBlob(`${SAVE_CAMPAIGN_DIR}/${targetFolder}/${cover.fileName}`, blob);
    clearCampaignCoverCache(sourceFolder);
    clearCampaignCoverCache(targetFolder);
  }
}

async function writeSaveIndex(records) {
  let previous = {};
  try { previous = JSON.parse(await readBoundText(SAVE_INDEX_FILE) || '{}'); } catch (e) { /* 旧索引 */ }
  const campaigns = Array.isArray(records) ? records : await readCampaignRecords();
  const data = {
    format: 'sangduoer-save-index',
    schemaVersion: 2,
    lastCampaignId: previous.lastCampaignId || null,
    updatedAt: Date.now(),
    campaigns: campaigns.map((item) => ({
      id: item.id,
      name: item.name,
      savedAt: item.savedAt,
      folder: item._folderName,
      cover: item.coverFile || null,
    })),
  };
  if (!(await writeBoundText(SAVE_INDEX_FILE, JSON.stringify(data, null, 2)))) throw new Error('存档索引写入失败');
}

async function writeVerifiedCampaign(path, packageData) {
  const expected = JSON.stringify(packageData, null, 2);
  if (!(await writeBoundText(path, expected))) throw new Error('战役文件写入失败');
  const actual = await readBoundText(path);
  if (actual !== expected) throw new Error('存档回读校验失败：文件未更新或被其他窗口改写');
}

async function rememberCampaignSelection(id) {
  if (!id) return;
  const raw = await readBoundText(SAVE_INDEX_FILE);
  const index = raw ? JSON.parse(raw) : {format:'sangduoer-save-index',schemaVersion:2,campaigns:[]};
  index.lastCampaignId = id;
  index.lastOpenedAt = Date.now();
  await writeVerifiedCampaign(SAVE_INDEX_FILE, index);
  try { localStorage.setItem(typeof modularStorage !== 'undefined' && modularStorage ? STORAGE_KEY + ':last-campaign' : 'dnd-board-last-campaign-id', id); } catch (e) { /* 磁盘记录为准 */ }
}

async function campaignTextHash(text) {
  if (text == null) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function writeCurrentCampaign(path, packageData, expectedHash) {
  const text = JSON.stringify(packageData, null, 2);
  if (usingLocalSaveBridge()) {
    const result = await localSaveApiRequest('write-campaign', { path, text, expectedHash });
    // Do not replace an image the user changed while this save was in flight.
    if (state.campaignId === packageData.campaignId && result.mapAssets) {
      for (const saved of packageData.state.maps || []) {
        const live = state.maps.find(m => m.id === saved.id);
        if (live && live.mapData === saved.mapData && result.mapAssets[saved.id]) live.mapData = result.mapAssets[saved.id];
      }
    }
    // Preserve edits made during the request; advance their base revision for the next save.
    if (state.campaignId === packageData.campaignId) {
      const savedTokens = [...(packageData.state.maps || []).flatMap(m => m.tokens || []), ...Object.values(packageData.state.parkedOwnedPieces || {})];
      const liveTokens = [...state.maps.flatMap(m => m.tokens || []), ...Object.values(state.parkedOwnedPieces || {})];
      for (const update of result.characterUpdates || []) {
        const saved = savedTokens.find(t => t.ownedPieceId === update.characterId && t.ownerPlayerId === update.ownerPlayerId);
        for (const live of liveTokens.filter(t => t.ownedPieceId === update.characterId && t.ownerPlayerId === update.ownerPlayerId)) {
          if (!saved || live.characterRevision !== saved.characterRevision || live.characterRevision > update.patch.characterRevision) continue;
          for (const [key, value] of Object.entries(update.patch)) {
            if (key === 'characterRevision' || JSON.stringify(live[key]) === JSON.stringify(saved[key])) live[key] = value;
          }
        }
      }
    }
    return result.hash;
  }
  // 文件夹模式也核对版本；同源标签页通过 Web Locks 串行提交。
  const commit = async () => {
    if (await readBoundText(path.replace(/当前存档\.json$/, '已删除.json'))) {
      throw new Error('该战役已删除，请读取其他战役');
    }
    if (await campaignTextHash(await readBoundText(path)) !== expectedHash) {
      await writeRecoverySnapshot('保存冲突', packageData.state);
      throw new Error('正式存档已更新，本次进度已保留为恢复点，请重新读取');
    }
    await writeVerifiedCampaign(path, packageData);
    return campaignTextHash(text);
  };
  if (!navigator.locks) throw new Error('此浏览器无法安全协调文件夹保存，请使用本机服务器连接存档');
  return navigator.locks.request('sundoll-campaign:' + path, commit);
}

async function writeCampaignRecord(id, name, snapshot, options = {}) {
  if (!(await ensureSaveFolderAccess(false))) throw new Error('save folder unavailable');
  const cleanId = safeCampaignId(id);
  const cleanName = String(name || '未命名战役').trim().slice(0, 120) || '未命名战役';
  const existing = await campaignGet(cleanId);
  // 目录是持久身份，改显示名称无需迁移或删除历史文件。
  const folderName = existing?._folderName || campaignFolderName(cleanId, cleanName);
  const currentPath = `${SAVE_CAMPAIGN_DIR}/${folderName}/当前存档.json`;
  const previousText = existing ? await readBoundText(existing._path) : await readBoundText(currentPath);
  const savedAt = Number(options.savedAt) || Date.now();
  if (options.backup === true && previousText) {
    const backupPath = `${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份/${savedAt}.json`;
    if (!(await writeBoundText(backupPath, previousText)) || await readBoundText(backupPath) !== previousText) {
      throw new Error('备份未能完整写入，正式存档未覆盖');
    }
  }
  const packageData = campaignPackage(cleanId, cleanName, snapshot, savedAt);
  const savedHash = await writeCurrentCampaign(currentPath, packageData, campaignLoadedHashes.get(cleanId) ?? null);
  campaignLoadedHashes.set(cleanId, savedHash);
  await trimAutomaticBackups(folderName);
  const record = {
    id: cleanId,
    name: cleanName,
    savedAt,
    state: campaignRecordSummary({ state: packageData.state }).state,
    coverFile: existing?.coverFile || '',
    coverUrl: existing?.coverUrl || '',
    _folderName: folderName,
    _path: currentPath,
  };
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
  await writeVerifiedCampaign(`${SAVE_CAMPAIGN_DIR}/${folderName}/自动备份/${fileName}`, packageData);
  await trimAutomaticBackups(folderName);
  return true;
}

async function migrateLegacyCampaigns() {
  if (modularStorage) return 0;
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
