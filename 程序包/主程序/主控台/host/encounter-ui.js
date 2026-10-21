/* DOM rendering and lazy visual dependencies; encounter mutations stay in app.js. */
// BEGIN RIBBON IMPLEMENTATION
function renderHostInitiativeRibbon() {
  const container = $('#host-initiative-ribbon');
  if (!container || !window.SundollInitiativeRibbon) return;
  const e = encounterState();
  const tokens = new Map(state.maps.flatMap(map => map.tokens || []).map(token=>[token.id,token]));
  const entries = e.entries.map(entry => {
    const token = tokens.get(entry.tokenId);
    return { ...entry, name: initiativeEntryLabel(entry), type: token?.type || 'npc',
      icon: token?.icon || '◎', imageUrl: initiativePortraitImageUrl(initiativePortraitForToken(token)) || initiativePortraitImageUrl(token) };
  });
  window.SundollInitiativeRibbon.render(container, {
    entries, mode: e.playMode, round: e.round, currentEntryId: e.currentEntryId,
    onSelect: focusHostInitiativeEntry,
    onManage: openHostInitiativeManager,
  });
}

// END RIBBON IMPLEMENTATION
// BEGIN ENCOUNTER IMPLEMENTATION
function refreshHostClock(e = encounterState(), world = worldTimeParts(worldTimeNow(e)), weather = weatherPresentation(e.weather, world)) {
  if(document.hidden)return;
  const inTurn=e.playMode==='turn';
  const timeInputs = {
    year: $('#time-year'), week: $('#time-week'), day: $('#time-day'), clock: $('#time-clock'),
    climate: $('#weather-climate'), condition: $('#weather-condition'), temperature: $('#weather-temperature'), wind: $('#weather-wind'),
  };
  for (const input of [timeInputs.climate, timeInputs.condition, timeInputs.temperature, timeInputs.wind]) {
    if (input) input.disabled = !CLIMATE_AVAILABLE;
  }
  for (const id of ['#btn-weather-apply', '#btn-weather-generate', '#btn-weather-auto']) {
    const control = $(id); if (control) control.disabled = !CLIMATE_AVAILABLE;
  }
  if (!window.SundollWorldUI?.editingDate && timeInputs.year && document.activeElement !== timeInputs.year) timeInputs.year.value = world.year;
  if (!window.SundollWorldUI?.editingDate && timeInputs.week && document.activeElement !== timeInputs.week) timeInputs.week.value = world.week;
  if (!window.SundollWorldUI?.editingDate && timeInputs.day && document.activeElement !== timeInputs.day) timeInputs.day.value = world.day;
  if (!window.SundollWorldUI?.editingDate && timeInputs.clock && document.activeElement !== timeInputs.clock) timeInputs.clock.value = formatWorldClock(world);
  if (!window.SundollWorldUI?.editingLocation && timeInputs.climate && document.activeElement !== timeInputs.climate) timeInputs.climate.value = weather.climate;
  if (!window.SundollWorldUI?.editingWeather && timeInputs.condition && document.activeElement !== timeInputs.condition) timeInputs.condition.value = weather.condition;
  if (!window.SundollWorldUI?.editingWeather && timeInputs.temperature && document.activeElement !== timeInputs.temperature) timeInputs.temperature.value = weather.temperature;
  if (!window.SundollWorldUI?.editingWeather && timeInputs.wind && document.activeElement !== timeInputs.wind) timeInputs.wind.value = weather.wind;
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
  window.SundollWorldUI?.render(e, world, weather);
}

function tickHostClock() {
  const e=encounterState();
  if(!e.worldTime.runningSince)return;
  const totalSeconds=worldTimeNow(e);
  const automaticWeather=refreshScheduledWeather(e,totalSeconds);
  if(automaticWeather){
    setEncounterEvent(e,`整点天气：天气变为${automaticWeather.conditionLabel} ${automaticWeather.temperature}°C`);
    scheduleAutosave();
  }
  if(!document.hidden)refreshHostClock(e,worldTimeParts(totalSeconds));
}

function renderEncounter() {
  renderHostInitiativeRibbon();
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
  bar.dataset.encounterMode = inTurn ? 'turn' : (preparing ? 'prepare' : 'free');
  bar.classList.add('collapsed');
  $('#btn-init-collapse').setAttribute('aria-expanded', String(!$('#initiative-manager-modal').hidden));
  $('#btn-init-collapse').textContent = '⚔ 先攻安排';
  $('#init-round-readout').textContent = inTurn ? `第 ${e.round} 轮` : (preparing ? '战斗准备' : '自由模式');
  $('#init-current-readout').textContent = current && inTurn ? initiativeEntryLabel(current) : (preparing ? '等待战斗开始' : '所有单位可行动');
  $('#init-focus-current').textContent = current && inTurn ? initiativeEntryLabel(current) : (preparing ? '调整先攻，准备开战' : '所有单位自由行动');
  $('#init-focus-round').textContent = inTurn ? `第 ${e.round} 轮` : (preparing ? '战斗准备阶段' : '自由模式');
  $('#init-focus-next').textContent = inTurn && nextEntry ? `下一位：${initiativeEntryLabel(nextEntry)}` : (preparing ? '地图点棋子输入先攻，在“先攻安排”中排序或开战' : '点击“准备战斗”，再在地图点棋子输入先攻');
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
  $('#init-panel-initiative').hidden = false;
  $('#init-panel-time').hidden = false;
  $('#btn-combat-start').hidden = inTurn;
  $('#btn-combat-start').textContent = preparing ? '⚔ 开始战斗' : '⚔ 准备战斗';
  $('#btn-combat-start').disabled = preparing && !e.entries.length;
  $('#initiative-turn-actions').hidden = !inTurn;
  $('#btn-init-next').disabled = !inTurn || !e.entries.length;
  $('#btn-init-next').textContent = '结束回合';
  $('#btn-init-next').title = inTurn && nextEntry ? `下一位：${initiativeEntryLabel(nextEntry)}` : '';
  $('#btn-init-next-dock').hidden = !inTurn;
  $('#btn-init-next-dock').disabled = !inTurn || !e.entries.length;
  $('#btn-init-next-dock').title = $('#btn-init-next').title;
  $('#btn-combat-end').disabled = !inTurn;
  updateHostTurnPathControls(e);
  $('#btn-init-timer').textContent = inTurn
    ? '⏱ 按战斗轮推进' : (e.worldTime.runningSince ? '❚❚ 暂停时间' : '▶ 开始时间');
  $('#btn-init-timer').disabled = inTurn;
  $('#btn-time-short-rest').disabled = restAnimationActive;
  $('#btn-time-long-rest').disabled = restAnimationActive;
  refreshHostClock(e, world, weather);
  renderHostInitiativeSwapControls(e);
  const environmentButton = $('#btn-init-environment');
  environmentButton.disabled = !preparing || e.entries.some(entry => entry.kind === 'environment');
  environmentButton.textContent = e.entries.some(entry => entry.kind === 'environment') ? '环境回合已加入' : '＋ 环境回合';
  environmentButton.title = preparing ? '加入每轮一次的环境回合，默认先攻 0' : '进入战斗准备后可加入环境回合';
  const list = $('#init-bar-list');
  const previousScrollTop = list.scrollTop;
  const managerBody = list.closest('.initiative-manager-body'), previousBodyScrollTop = managerBody?.scrollTop;
  for (const entryId of hostInitiativeValueDrafts.keys()) if (!e.entries.some(entry => entry.id === entryId)) hostInitiativeValueDrafts.delete(entryId);
  list.innerHTML = '';
  if (!e.entries.length) {
    list.innerHTML = '<span class="init-empty">添加单位后开始回合</span>';
  } else {
    e.entries.forEach((entry, index) => {
      const linkedToken = initiativeEntryToken(entry);
      const environmental = entry.kind === 'environment';
      const unlinked = !linkedToken && !environmental;
      const chip = document.createElement('div');
      const currentClass = inTurn && entry.id === e.currentEntryId ? ' current' : '';
      chip.className = `init-chip${currentClass}${unlinked ? ' unlinked' : ''}`;
      chip.dataset.entryId = entry.id;
      const status = unlinked
        ? '<span class="init-chip-warning">未关联</span>'
        : (currentClass ? '<span class="init-chip-current">行动中</span>' : '');
      chip.innerHTML = `<span class="init-chip-order">${index + 1}</span><span class="init-dot" style="background:${entry.color || '#e0b34c'}"></span><span class="init-chip-name">${esc(initiativeEntryLabel(entry))}</span>${status}`;
      chip.title = environmental ? '独立环境回合，由 DM 处理并结束；准备阶段可修改先攻' : unlinked
        ? '旧先攻项没有关联地图棋子，请移除后重新通过选中棋子加入'
        : '使用 ↑ ↓ 调整同先攻顺序；准备战斗时点击地图棋子可修改先攻值';
      const tools = document.createElement('div'); tools.className = 'init-chip-manager-tools';
      const value = document.createElement(environmental && preparing ? 'input' : 'span'); value.className = 'init-chip-value';
      if (environmental && preparing) {
        value.type = 'number'; value.min = '-999'; value.max = '999'; value.step = '1';
        value.value = hostInitiativeValueDrafts.get(entry.id) ?? String(entry.value);
        value.setAttribute('aria-label', '环境回合先攻');
        value.addEventListener('input', () => hostInitiativeValueDrafts.set(entry.id, value.value));
        value.addEventListener('change', () => setHostInitiativeValue(entry.id, value.value));
        value.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); setHostInitiativeValue(entry.id, value.value); } });
      } else { value.textContent = String(entry.value); value.setAttribute('aria-label', `先攻 ${entry.value}`); }
      const currentButton = document.createElement('button'); currentButton.type = 'button'; currentButton.className = 'init-chip-set-current';
      currentButton.textContent = currentClass ? '行动中' : '设为当前'; currentButton.disabled = unlinked || !inTurn || Boolean(currentClass);
      currentButton.addEventListener('click', () => {
        if (unlinked) { toast('这个先攻项没有关联棋子，请移除后重新加入'); return; }
        if (e.playMode !== 'turn') { toast('切换到回合制后才能指定当前行动单位'); return; }
        if (e.currentEntryId === entry.id) return;
        e.currentEntryId = entry.id;
        bumpEncounterTurn(e);
        setEncounterEvent(e, `当前单位：${initiativeEntryLabel(entry)}`);
        renderEncounter(); scheduleAutosave();
      });
      const makeTieButton = (direction, label) => {
        const target = e.entries[index + direction], button = document.createElement('button');
        button.type = 'button'; button.className = 'init-chip-tie-move'; button.textContent = label;
        button.title = direction < 0 ? '与上一位同先攻单位换位' : '与下一位同先攻单位换位';
        button.setAttribute('aria-label', `${initiativeEntryLabel(entry)}${direction < 0 ? '向前' : '向后'}调整同先攻顺序`);
        button.disabled = !target || Number(entry.value) !== Number(target.value);
        button.addEventListener('click', () => moveHostTiedInitiativeEntry(entry.id, direction));
        return button;
      };
      tools.append(value, makeTieButton(-1, '↑'), makeTieButton(1, '↓'), currentButton);
      const del = document.createElement('button');
      del.className = 'init-chip-del'; del.type = 'button'; del.textContent = '移除'; del.title = '移除先攻单位';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        const index = e.entries.findIndex((item) => item.id === entry.id);
        const wasCurrent = e.currentEntryId === entry.id;
        e.entries.splice(index, 1);
        if (wasCurrent) {
          e.currentEntryId = e.entries[index]?.id || e.entries[index - 1]?.id || null;
        }
        const returnedToPreparation = returnToCombatPreparationIfEmpty(e);
        if (e.playMode !== 'free') bumpEncounterTurn(e);
        setEncounterEvent(e, `移除先攻单位：${initiativeEntryLabel(entry)}${returnedToPreparation ? '；战斗已退回准备阶段' : ''}`);
        renderEncounter(); scheduleAutosave();
      });
      tools.appendChild(del); chip.appendChild(tools);
      list.appendChild(chip);
    });
  }
  list.scrollTop = previousScrollTop;
  if (managerBody) managerBody.scrollTop = previousBodyScrollTop;
  scrollCurrentInitiativeIntoView(list, e);
  renderTurnPath();
  renderInitiativeSelection();
  const selected = state.selectedId ? findToken(state.selectedId) : null;
  if (selected) updateDetailContext(selected);
}

// END ENCOUNTER IMPLEMENTATION
let hostDiceLoad=null;
function ensureHostDice() {
  if(window.playDieAnimation&&window.SundollDiceSkins)return Promise.resolve();
  if(!hostDiceLoad)hostDiceLoad=(async()=>{
    if(!window.THREE)await SundollClientRuntime.loadScript('vendor/three.min.js',{env:globalThis});
    await SundollClientRuntime.loadScript('shared/dice.js?v=20260922-mixed-dice-v14',{env:globalThis});
  })().catch(error=>{hostDiceLoad=null;throw error;});
  return hostDiceLoad;
}
function initHostDiceLoading() {
  const warm=()=>ensureHostDice().catch(()=>toast('骰子皮肤暂时无法加载，重新打开骰子工具可重试'));
  const panel=document.querySelector('[data-tool-panel="dice"]');
  panel?.addEventListener('pointerenter',warm);
  panel?.addEventListener('focusin',warm);
  document.querySelector('[data-workspace-tab="dice"]')?.addEventListener('click',warm);
}
