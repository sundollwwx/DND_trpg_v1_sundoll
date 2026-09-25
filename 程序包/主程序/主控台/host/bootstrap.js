'use strict';

(async () => {
await loadProjectDirHandle();

/* ==================== 启动 ==================== */

preloadConditionPixels();
bindEvents();
initCoverThemePicker();
hostDocuments.init();
hostPrep.init();
hostDocuments.ensureCampaign();
hostMusic.loadProjectMusicLibrary({ silent: true });
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
libRecentIds = loadLibraryRecentIds();
setUnitSource('library', false);
renderLibrary();
// 等正式存档恢复完成后再联机，避免把启动时的旧浏览器缓存推到房间。
// 可折叠卡片默认收起；固定操作卡保持可见。
document.querySelectorAll('#left-panel .card:not([data-no-collapse])').forEach((c) => c.classList.add('collapsed'));
document.querySelectorAll('#left-panel .card[data-no-collapse]').forEach((c) => c.classList.remove('collapsed'));
loadLinks();
renderLinks();
(async () => {
  if (projectDirHandle && await hasSaveFolderPermission()) {
    try {
      await ensureSaveFolderStructure();
      await migrateLegacyCampaigns();
      await syncLibraryWithFolder();
      if (await restoreFolderIfAvailable() === false) {
        updateSaveStatus('正式存档读取未完成 · 请重新选择存档，联机同步尚未启动', 'error');
        await refreshHostHome({ forceRecords: true });
        return;
      }
      await initLibPersistStatus();
    } catch (e) {
      console.warn('初始化存档文件夹失败', e);
      updateSaveStatus(`正式存档初始化失败：${e.message || '读取失败'} · 联机同步尚未启动`, 'error');
      await refreshHostHome({ forceRecords: true });
      return;
    }
  } else {
    updateLibPersistStatus(projectDirHandle ? 'denied' : 'unset');
    updateSaveStatus(projectDirHandle ? '“存档”文件夹待授权' : '仅浏览器缓存 · 请连接“存档”文件夹', 'error');
  }
  await refreshHostHome({ forceRecords: true });
  await restoreStreamFromStorage();
})();
// 棋子状态栏默认显示，未选择时保留空状态提示。
const unitCard = document.querySelector('#unit-card');
if (unitCard) unitCard.classList.remove('collapsed');
initWorkspaceTabs();
initMapQuickTools();
syncActiveMapGridSetting();
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
window.journalBridge = {
  isDM: true,
  actorName: () => 'DM',
  worldTime: () => worldTimeNow(),
  read: () => state.journal,
  campaign: () => state.campaignId,
  mutate: async (mutation, revision, campaignId) => {
    if (!campaignId) throw new Error('请先建立或读取战役');
    let result;
    if (streamOn) {
      const response = await fetch(`${serverApiBase()}/api/journal`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({...mutation, revision, campaignId}),
      });
      const data = await CampaignJournal.readSaveResponse(response);
      if (state.campaignId !== campaignId) throw new Error('战役已切换');
      if ((state.journal?.revision || 0) <= data.journal.revision) state.journal = CampaignJournal.normalize(data.journal, campaignId);
      result = {journal: state.journal, entryId: data.entryId};
    } else {
      const current = CampaignJournal.normalize(state.journal, campaignId);
      if (revision !== current.revision) throw new Error('日志已更新，请重新打开');
      result = CampaignJournal.localMutation(current, mutation, {
        author: 'DM', isDM: true, campaignId, at: Date.now(), worldSeconds: worldTimeNow(),
      });
      state.journal = CampaignJournal.normalize(result.journal, campaignId);
      result.journal = state.journal;
    }
    const cached = saveNow();
    const diskSaved = projectDirHandle ? await folderSaveQueue : false;
    const saveNotice = diskSaved ? '' : cached
      ? '日志已更新，仅保留浏览器恢复点；请连接存档文件夹。'
      : '日志已更新，但未写入存档；请立即检查存档文件夹。';
    return {...result, journal: state.journal, saveNotice};
  }
};


// Only withdrawn pieces live here; active tokens remain the sole writable campaign state.






ItemLibrary.configure({campaign:()=>({id:state.campaignId||'',name:state.campaignName||''})});
PlayerBackpack.configure({host:true,roll:(...args)=>playDiceFx(...args),campaignId:()=>state.campaignId||'',characters:(chars,campaign)=>{if(campaign!==state.campaignId)return;for(const c of chars)applyRemoteAction({op:'characterState',characterId:c.id,ownerPlayerId:c.ownerPlayerId,patch:{...c.base,...c.runtime,characterRevision:c.revision}});}});
PlayerLibrary.configure({
  host:true, place:placeOwnedPiece, bind:bindSelectedOwnedPiece,
  onPieceEdited:(playerId, ownedPieceId, patch)=>{
    let changed = false;
    const tokens = [...state.maps.flatMap(map=>map.tokens || []), ...Object.values(state.parkedOwnedPieces || {})];
    for (const token of tokens) {
      if (token.ownedPieceId !== ownedPieceId || token.ownerPlayerId !== playerId) continue;
      for (const field of ['name','publicNote','hpMax','ac','level','size','sizeCategory']) {
        if (Object.hasOwn(patch, field)) { token[field] = patch[field]; changed = true; }
      }
    }
    if (changed) {
      state.maps.forEach(map => {
        SundollSize.repair(map);
        if (Object.hasOwn(patch, 'sizeCategory') || Object.hasOwn(patch, 'size')) {
          for (const token of map.tokens || []) {
            if (token.ownedPieceId === ownedPieceId && token.ownerPlayerId === playerId && !token.mountId) {
              Object.assign(token, SundollSize.point(map, token, token.x, token.y, state.snap));
            }
          }
          SundollSize.repair(map);
        }
      });
      renderTokens(); updateDetail(); renderEncounter(); scheduleAutosave(); saveNow();
    }
  },
  backpack:profile=>PlayerBackpack.open({playerId:profile.playerId,onBack:()=>PlayerLibrary.open({playerId:profile.playerId})}),
  bindingTarget:()=>String(state.campaignId || '') + ':' + String(state.activeMapId || '') + ':' + String(state.selectedId || ''),
  mapId:()=>activeMap()?.id || '',
  mapName:()=>activeMap()?.name || '',
  describePlacement:piece=>{
    const target=activeMap();
    if(!target || !state.campaignId) return {hint:'先打开战役和地图，再带入收藏棋子。',blocked:true};
    const source=state.maps.find(m=>m.tokens.some(t=>t.ownedPieceId===piece.ownedPieceId));
    if(source?.id===target.id) return {label:'选中地图中的棋子',hint:'已在当前地图，点击即可选中，不会重复创建。'};
    if(source) return {label:'带到当前地图',hint:`当前位于「${source.name}」，带入后保留血量与状态。`};
    if(state.parkedOwnedPieces?.[piece.ownedPieceId]) return {label:'重新带入地图',hint:'已暂时收起，重新带入会保留本战役状态。'};
    return {label:'释放到当前地图',hint:'首次加入本战役，将使用收藏的初始属性。'};
  }
});
const playerLibraryEntry = document.querySelector('#btn-player-profiles');
playerLibraryEntry.onclick = () => PlayerLibrary.open();

MapItems.configure({host:true,map:()=>activeMap(),campaign:()=>state.campaignId,world:()=>world,board:()=>board,zoom:()=>activeMap()?.cam?.zoom||1,toast});

})().catch(error => { console.error(error); updateSaveStatus("启动未完成，请保留页面并检查本机存档服务", "error"); });
