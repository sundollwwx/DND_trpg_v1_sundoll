/* 主持人日常资料：纯查表，不修改战役或玩家资源。 */
(() => {
  'use strict';
  const trigger = document.getElementById('btn-fishing-open');
  if (!trigger) return;
  const dataUrl = new URL('/api/daily-life/fishing-tables', window.location.origin);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const dialog = node('dialog', '', 'daily-life-dialog');
  dialog.id = 'fishing-dialog';
  dialog.setAttribute('aria-labelledby', 'fishing-title');
  const header = node('header', '', 'fishing-header');
  const titles = node('div');
  titles.append(node('span', '世界', 'fishing-eyebrow'));
  const title = node('h2', '钓鱼 · 自定义扩展'); title.id = 'fishing-title'; titles.append(title);
  const close = node('button', '关闭 ×'); close.type = 'button'; close.setAttribute('aria-label', '关闭钓鱼表');
  close.addEventListener('click', () => dialog.close());
  header.append(titles, close);
  const status = node('p', '', 'fishing-status'); status.setAttribute('role', 'status');
  const retry = node('button', '重新加载'); retry.type = 'button'; retry.hidden = true;
  const filters = node('div', '', 'fishing-filters');
  function makeSelect(label, id) {
    const wrap = node('label', label);
    const select = node('select'); select.id = id;
    wrap.append(select); filters.append(wrap); return select;
  }
  const location = makeSelect('地点', 'fishing-location');
  const time = makeSelect('时间', 'fishing-time');
  const weather = makeSelect('天气', 'fishing-weather');
  const body = node('div', '', 'fishing-body');
  const boundary = node('p', '以下是此前设计的可选房规。使用 D&D 规则捕鱼时，先在「食宿生活 → 休整 → 觅食」查看求生检定与地形 DC；本表的 1／20 奖惩不是官方属性检定规则。', 'fishing-boundary');
  const summary = node('div', '', 'fishing-summary');
  const heading = node('h3'); heading.id = 'fishing-table-title';
  const scene = node('p'); const gear = node('p', '', 'fishing-gear');
  summary.append(heading, scene, gear);
  const table = node('table', '', 'fishing-table'); table.setAttribute('aria-labelledby', heading.id);
  const thead = node('thead'); const headRow = node('tr');
  ['d20', '结果', '事件与奖惩'].forEach(text => {const th = node('th', text); th.scope = 'col'; headRow.append(th);});
  thead.append(headRow); const tbody = node('tbody'); table.append(thead, tbody);
  const rules = node('details', '', 'fishing-rules'); rules.append(node('summary', '垂钓与遭遇规则'));
  const rulesList = node('ul'); rules.append(rulesList);
  body.append(boundary, summary, table, rules);
  const foot = node('footer', '每次 30 分钟 · 8 空手 · 9 起有收获 · 1 大失败／20 大成功', 'fishing-footer');
  dialog.append(header, status, retry, filters, body, foot); document.body.append(dialog);
  let data = null; let loading = false;
  function render() {
    const place = data.locations.find(x => x.id === location.value);
    const selected = data.tables.find(x => x.location === location.value && x.time === time.value && x.weather === weather.value);
    if (!place || !selected) return;
    heading.textContent = `${place.name} · ${time.value} · ${weather.value}`;
    scene.textContent = `环境风险：${place.risk}。${place.scene}`;
    gear.textContent = place.gear;
    tbody.replaceChildren(...selected.rows.map(row => {
      const tr = node('tr'); tr.dataset.roll = row.roll;
      tr.className = row.roll === 1 ? 'fishing-danger' : row.roll === 20 ? 'fishing-jackpot' : row.roll === 8 ? 'fishing-empty' : '';
      const number = node('th', String(row.roll)); number.scope = 'row';
      tr.append(number, node('td', row.name), node('td', row.effect));
      return tr;
    }));
    status.textContent = `当前 20 项 · 共 24 张表 · 早中晚与晴雨分别查表`;
    body.scrollTop = 0;
  }
  function options(select, values) {
    select.replaceChildren(...values.map(([value, label]) => {const option = node('option', label); option.value = value; return option;}));
  }
  async function load() {
    if (loading) return;
    if (data) {render(); return;}
    loading = true; retry.hidden = true; filters.hidden = true; body.hidden = true;
    status.textContent = '正在读取钓鱼表…';
    try {
      const response = await fetch(dataUrl, {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const loaded = await response.json();
      if (loaded.tables?.length !== 24 || !loaded.locations?.length || !loaded.tables.every(t => t.rows?.length === 20)) throw new Error('表格不完整');
      data = loaded;
      options(location, data.locations.map(x => [x.id, x.name]));
      options(time, data.times.map(x => [x, x])); options(weather, data.weathers.map(x => [x, x]));
      rulesList.replaceChildren(...data.rules.map(x => node('li', x)));
      filters.hidden = false; body.hidden = false; render();
    } catch (error) {
      data = null; status.textContent = '钓鱼表暂时无法读取，请重新加载。'; retry.hidden = false;
      console.warn('钓鱼表读取失败', error);
    } finally {loading = false;}
  }
  [location, time, weather].forEach(select => select.addEventListener('change', render));
  retry.addEventListener('click', load);
  trigger.addEventListener('click', () => {if (!dialog.open) dialog.showModal(); void load();});
  dialog.addEventListener('close', () => trigger.focus());
})();

// 与钓鱼查表并列的玩家可见菜单。
if (window.SundollDining && document.getElementById('btn-dining-open')) {
  SundollDining.initHost({
    trigger: document.getElementById('btn-dining-open'),
    campaign: () => state.campaignId,
    ready: () => Boolean(state.campaignId && streamOn && !campaignLoadInProgress),
    push: () => {streamDirty = true; void streamPush();}
  });
}
