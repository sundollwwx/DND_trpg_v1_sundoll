/* Structured shared campaign journal. User-authored values are rendered with textContent only. */
window.CampaignJournal = (() => {
  const MAX_ENTRIES = 100;
  const MAX_TITLE = 80;
  const MAX_TOTAL_TEXT = 20000;
  const FALLBACK_PAGE_CHAR_LIMIT = 224;
  const MAX_PAGE_MEASURE_CHARS = 720;
  const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,96}$/;
  let dialog, directory, directoryToggle, directoryClose, closeButton, title, leftText, rightText, meta, date, status, save, create, remove;
  let pagePrevious, pageNext, entryPrevious, entryNext, pageNumber, entryNumber;
  let base, campaign, selectedId, selectedEntry, draft, draftPages = ['', ''], draftPageIndex = 0, busy = false;

  function worldDate(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '未记录';
    const total = Math.max(0, Math.floor(Number(seconds))), day = Math.floor(total / 86400);
    return `第 ${Math.floor(day / 364) + 1} 年 · 第 ${Math.floor(day % 364 / 7) + 1} 周 · 第 ${day % 7 + 1} 天`;
  }

  function cleanTitle(value, fallback = '') {
    const result = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, MAX_TITLE);
    return result || fallback;
  }

  function cleanText(value) { return String(value ?? '').slice(0, MAX_TOTAL_TEXT); }

  function entryIdFor(value, index, seen) {
    let id = String(value?.id || '');
    if (!ENTRY_ID.test(id) || seen.has(id)) id = `legacy-${index + 1}`;
    let suffix = 2, candidate = id;
    while (seen.has(candidate)) candidate = `${id}-${suffix++}`;
    seen.add(candidate);
    return candidate;
  }

  function normalizeEntry(raw, index, seen, legacy = false) {
    const entry = raw && typeof raw === 'object' ? raw : { text: raw };
    const author = cleanTitle(entry.author || entry.createdBy || '', '未知作者').slice(0, 24);
    const updatedBy = cleanTitle(entry.updatedBy || entry.editor || author, author).slice(0, 24);
    return {
      id: entryIdFor(entry, index, seen),
      title: cleanTitle(entry.title, `未命名日志 ${index + 1}`),
      text: cleanText(entry.text),
      author,
      createdAt: Math.max(0, Math.floor(Number(entry.createdAt ?? entry.at) || 0)),
      createdWorldSeconds: Number.isFinite(Number(entry.createdWorldSeconds ?? entry.worldSeconds)) ? Math.max(0, Math.floor(Number(entry.createdWorldSeconds ?? entry.worldSeconds))) : null,
      updatedBy,
      updatedAt: Math.max(0, Math.floor(Number(entry.updatedAt ?? entry.at) || 0)),
      updatedWorldSeconds: Number.isFinite(Number(entry.updatedWorldSeconds ?? entry.worldSeconds)) ? Math.max(0, Math.floor(Number(entry.updatedWorldSeconds ?? entry.worldSeconds))) : null,
      legacy,
    };
  }

  function normalize(value, expectedCampaignId = '') {
    const incoming = value && typeof value === 'object' ? value : {};
    const requestedCampaignId = String(expectedCampaignId || '').trim();
    const storedCampaignId = String(incoming.campaignId || '').trim();
    // 一份日志不能被另一个战役的存档或联机快照带过去。旧存档没有标记时，
    // 会在第一次读取当前战役时平滑补上，而不会丢失原有内容。
    const source = requestedCampaignId && storedCampaignId && requestedCampaignId !== storedCampaignId ? {} : incoming;
    const seen = new Set();
    let entries;
    if (Array.isArray(source.entries)) {
      entries = source.entries.slice(0, MAX_ENTRIES).map((entry, index) => normalizeEntry(entry, index, seen));
    } else {
      const legacyText = cleanText(source.text);
      const author = cleanTitle(source.author || source.history?.at(-1)?.author || '', 'DM').slice(0, 24);
      entries = (legacyText ? legacyText.split('\f') : []).slice(0, MAX_ENTRIES).map((body, index) => normalizeEntry({
        id: `legacy-${index + 1}`, title: `未命名日志 ${index + 1}`, text: body, author,
        createdAt: source.at, createdWorldSeconds: source.worldSeconds, updatedBy: author,
        updatedAt: source.at, updatedWorldSeconds: source.worldSeconds,
      }, index, seen, true));
    }
    return {
      schemaVersion: 2,
      campaignId: requestedCampaignId || storedCampaignId || null,
      revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
      entries,
      // 保留旧字段，确保旧版存档及恢复工具仍能读取正文。
      text: entries.map(entry => entry.text).join('\f'),
      author: cleanTitle(source.author || '', ''),
      worldSeconds: Number.isFinite(Number(source.worldSeconds)) ? Math.max(0, Math.floor(Number(source.worldSeconds))) : null,
      history: Array.isArray(source.history) ? source.history.filter(item => item && typeof item === 'object').slice(-50) : [],
    };
  }

  function newEntry() {
    const bridge = window.journalBridge || {};
    const actor = cleanTitle(bridge.actorName?.() || (bridge.isDM ? 'DM' : '玩家'), '玩家').slice(0, 24);
    const now = bridge.worldTime?.();
    return { id: null, title: '未命名日志', text: '', author: actor, createdAt: Date.now(), createdWorldSeconds: now, updatedBy: actor, updatedAt: Date.now(), updatedWorldSeconds: now };
  }

  function textFitsPage(field, value) {
    if (!field || field.clientHeight <= 0) return value.length <= FALLBACK_PAGE_CHAR_LIMIT;
    field.value = value;
    // Do not tolerate even a one-pixel overflow: textarea scroll metrics are
    // rounded differently while the dialog is being laid out, and that small
    // allowance can admit a whole extra ruled line after the metadata renders.
    return field.scrollHeight <= field.clientHeight;
  }

  function measuredPageCut(remaining, pageIndex) {
    if (!remaining) return 0;
    // Only page one carries the title/author/date block. Every continuation
    // page uses the roomier continuation-page geometry.
    const field = pageIndex === 0 ? leftText : rightText;
    if (!field || field.clientHeight <= 0) return Math.min(remaining.length, FALLBACK_PAGE_CHAR_LIMIT);
    const sample = remaining.slice(0, MAX_PAGE_MEASURE_CHARS);
    let low = 1, high = sample.length, best = 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (textFitsPage(field, sample.slice(0, middle))) {
        best = middle; low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  function splitEntryPages(value, startPageIndex = 0) {
    let remaining = cleanText(value);
    if (!remaining) return [''];
    const pages = [];
    const oldLeft = leftText?.value, oldRight = rightText?.value;
    try {
      while (remaining) {
        const pageIndex = startPageIndex + pages.length;
        const cut = measuredPageCut(remaining, pageIndex);
        pages.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
    } finally {
      if (leftText && oldLeft !== undefined) leftText.value = oldLeft;
      if (rightText && oldRight !== undefined) rightText.value = oldRight;
    }
    return pages;
  }

  function resetDraftPages() {
    dialog?.classList.remove('journal-continuation-spread');
    draftPages = splitEntryPages(draft?.text || '');
    if (draftPages.length % 2) draftPages.push('');
    draftPageIndex = 0;
  }

  function commitDraftPages() {
    if (!draft || !leftText || !rightText) return;
    draftPages[draftPageIndex] = cleanText(leftText.value);
    draftPages[draftPageIndex + 1] = cleanText(rightText.value);
    draft.text = cleanText(draftPages.join(''));
  }

  function currentPageText(offset = 0) {
    return draftPages[draftPageIndex + offset] || '';
  }

  function pageCountForText(value) {
    const count = splitEntryPages(value).length;
    return count % 2 ? count + 1 : count;
  }

  function repaginateDraftFrom(startPageIndex = 0) {
    const start = Math.max(0, Math.min(startPageIndex, draftPages.length - 1));
    const prefix = draftPages.slice(0, start);
    const tail = cleanText(draftPages.slice(start).join(''));
    const flowed = splitEntryPages(tail, start);
    draftPages = [...prefix, ...flowed];
    if (draftPages.length % 2) draftPages.push('');
    draft.text = cleanText(draftPages.join(''));
    return flowed;
  }

  function pageForOffset(pages, offset) {
    let remaining = Math.max(0, offset);
    for (let index = 0; index < pages.length; index += 1) {
      if (remaining <= pages[index].length) return { index, offset: remaining };
      remaining -= pages[index].length;
    }
    const last = Math.max(0, pages.length - 1);
    return { index: last, offset: pages[last]?.length || 0 };
  }

  function bookPageMetrics() {
    const entries = [];
    let nextPage = 1;
    for (const entry of base?.entries || []) {
      const count = entry.id === selectedId && draft ? draftPages.length : pageCountForText(entry.text);
      entries.push({ id: entry.id, start: nextPage, end: nextPage + count - 1, count });
      nextPage += count;
    }
    let current = entries.find(item => item.id === selectedId) || null;
    if (!selectedEntry && draft) {
      current = { id: null, start: nextPage, end: nextPage + draftPages.length - 1, count: draftPages.length };
      nextPage += draftPages.length;
    }
    return { entries, current, total: Math.max(2, nextPage - 1) };
  }

  function entryAt(id) { return base.entries.find(entry => entry.id === id) || null; }
  function selectedIndex() { return selectedEntry ? base.entries.findIndex(entry => entry.id === selectedEntry.id) : -1; }
  function readDraft() {
    if (!draft) return null;
    commitDraftPages();
    return { ...draft, title: cleanTitle(title.value, ''), text: cleanText(draftPages.join('')) };
  }
  function isDirty() {
    const current = readDraft();
    if (!current) return false;
    if (!selectedEntry) return current.title !== '未命名日志' || Boolean(current.text);
    return current.title !== selectedEntry.title || current.text !== selectedEntry.text;
  }
  function canEdit(entry = selectedEntry) {
    const bridge = window.journalBridge || {};
    return Boolean(bridge.isDM || (entry && bridge.canEdit?.(entry)) || !entry);
  }
  function canDelete(entry = selectedEntry) {
    const bridge = window.journalBridge || {};
    return Boolean(entry && (bridge.isDM || bridge.canDelete?.(entry) || bridge.canEdit?.(entry)));
  }
  function byline(entry) {
    if (!entry) return '新日志 · 保存后会标记作者与战役日期';
    const changed = entry.updatedBy && entry.updatedBy !== entry.author ? ` · 最近编辑：${entry.updatedBy}` : '';
    return `作者：${entry.author}${changed}`;
  }
  function entryDate(entry) { return entry ? (entry.updatedWorldSeconds ?? entry.createdWorldSeconds) : window.journalBridge?.worldTime?.(); }
  function setStatus(message = '') { status.textContent = message; }

  function renderDirectory() {
    if (!directory) return;
    directory.replaceChildren();
    if (!base.entries.length) {
      const empty = document.createElement('li'); empty.className = 'journal-directory-empty'; empty.textContent = '还没有已保存的日志。'; directory.append(empty); return;
    }
    const metrics = bookPageMetrics();
    for (const entry of base.entries) {
      const span = metrics.entries.find(item => item.id === entry.id);
      const li = document.createElement('li');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'journal-directory-entry';
      button.classList.toggle('active', entry.id === selectedId); button.setAttribute('aria-current', entry.id === selectedId ? 'page' : 'false');
      const heading = document.createElement('strong'); heading.textContent = entry.title;
      const details = document.createElement('span'); details.textContent = `${entry.author} · 第 ${span.start}–${span.end} 页`;
      button.append(heading, details); button.addEventListener('click', () => chooseEntry(entry.id)); li.append(button); directory.append(li);
    }
  }

  function directoryDrawer() {
    return directory?.closest('.journal-directory-drawer') || null;
  }

  function setDirectoryOpen(open) {
    const drawer = directoryDrawer();
    if (!drawer || !directoryToggle) return;
    // `directory` is the <ol>; the surrounding <aside> is what CSS actually
    // hides. Toggling the list alone leaves a seemingly clicked but invisible
    // catalogue.
    drawer.hidden = !open;
    directoryToggle.setAttribute('aria-expanded', String(open));
    if (open) renderDirectory();
  }

  function requestCloseBook() {
    if (!dialog || busy || !confirmDiscard('合上书本将放弃未保存的标题和正文，继续吗？')) return;
    setDirectoryOpen(false);
    dialog.close();
  }

  function preparePageTurn(direction) {
    if (!direction || !dialog || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const pages = dialog.querySelector('.journal-pages');
    const source = dialog.querySelector(direction > 0 ? '.journal-right-page' : '.journal-left-page');
    const stationarySource = dialog.querySelector(direction > 0 ? '.journal-left-page' : '.journal-right-page');
    if (!pages || !source || !stationarySource) return null;
    pages.querySelectorAll('.journal-page-turn-sheet,.journal-page-stationary-sheet').forEach(node => node.remove());
    // renderEditor 会立即写入目标双页，因此先固定没有翻动的旧页面。
    // 翻动纸张落下后，它与目标页面内容完全重合，再一起移除快照，
    // 避免动画开始时另一侧正文提前跳成新内容。
    const stationary = clonePageSnapshot(stationarySource, 'journal-page-stationary-sheet');
    stationary.setAttribute('aria-hidden', 'true');
    pages.append(stationary);
    const sheet = document.createElement('div');
    sheet.className = `journal-page-turn-sheet journal-page-turn-takeoff ${direction > 0 ? 'turn-forward' : 'turn-backward'}`;
    sheet.setAttribute('aria-hidden', 'true');
    sheet.append(clonePageFace(source, 'journal-page-turn-takeoff-face'));
    pages.append(sheet);
    return sheet;
  }

  function clonePageSnapshot(source, ...classes) {
    const face = source.cloneNode(true);
    face.classList.add(...classes);
    const sourceFields = source.querySelectorAll('input, textarea');
    face.querySelectorAll('input, textarea').forEach((field, index) => {
      const sourceField = sourceFields[index];
      field.value = sourceField?.value || '';
      if (sourceField?.id === 'journal-title') field.classList.add('journal-title-snapshot');
      field.tabIndex = -1;
    });
    const sourceTitle = source.querySelector('#journal-title');
    if (sourceTitle && getComputedStyle(sourceTitle).display === 'none') face.classList.add('journal-snapshot-continuation');
    face.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    face.querySelectorAll('[for]').forEach(node => node.removeAttribute('for'));
    return face;
  }

  function clonePageFace(source, faceClass) {
    return clonePageSnapshot(source, 'journal-page-turn-face', faceClass);
  }

  function playPageTurn(sheet, direction) {
    if (!sheet) return;
    const pages = sheet.parentElement;
    const stationary = pages?.querySelector('.journal-page-stationary-sheet');
    const destination = dialog.querySelector(direction > 0 ? '.journal-left-page' : '.journal-right-page');
    if (!pages || !destination) { stationary?.remove(); sheet.remove(); return; }
    const landing = document.createElement('div');
    landing.className = `journal-page-turn-sheet journal-page-turn-landing ${direction > 0 ? 'land-forward' : 'land-backward'}`;
    landing.setAttribute('aria-hidden', 'true');
    landing.append(clonePageFace(destination, 'journal-page-turn-landing-face'));
    pages.append(landing);
    const takeoffRotation = direction > 0 ? -89.5 : 89.5;
    const landingRotation = direction > 0 ? 89.5 : -89.5;
    const takeoffShadow = direction > 0 ? '-30px 3px 38px #2c170899' : '30px 3px 38px #2c170899';
    const landingShadow = direction > 0 ? '28px 3px 36px #2c170888' : '-28px 3px 36px #2c170888';
    const takeoff = sheet.animate([
      { transform: 'rotateY(0deg)', filter: 'brightness(1)', boxShadow: '0 0 3px #2c170811' },
      { transform: `rotateY(${takeoffRotation}deg)`, filter: 'brightness(.74)', boxShadow: takeoffShadow },
    ], { duration: 380, easing: 'cubic-bezier(.55,.06,.68,.19)', fill: 'forwards' });
    const settle = landing.animate([
      { transform: `rotateY(${landingRotation}deg)`, filter: 'brightness(.74)', boxShadow: landingShadow },
      { transform: 'rotateY(0deg)', filter: 'brightness(1)', boxShadow: '0 0 3px #2c170811' },
    ], { duration: 420, delay: 350, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' });
    Promise.all([takeoff.finished.catch(() => {}), settle.finished.catch(() => {})]).finally(() => {
      stationary?.remove(); sheet.remove(); landing.remove();
    });
  }

  function renderEditor(direction = 0) {
    const turnSheet = preparePageTurn(direction);
    const entry = selectedEntry || draft;
    const editable = canEdit();
    draftPageIndex = Math.max(0, Math.min(draftPageIndex - draftPageIndex % 2, draftPages.length - 2));
    dialog.classList.toggle('journal-continuation-spread', draftPageIndex >= 2);
    title.value = entry?.title || ''; leftText.value = currentPageText(); rightText.value = currentPageText(1);
    title.disabled = busy || !editable; leftText.disabled = busy || !editable; rightText.disabled = busy || !editable; save.disabled = busy || !editable;
    create.disabled = busy || base.entries.length >= MAX_ENTRIES;
    remove.hidden = !canDelete(selectedEntry); remove.disabled = busy || !canDelete(selectedEntry);
    const index = selectedIndex();
    const hasPreviousEntry = selectedEntry ? index > 0 : base.entries.length > 0;
    const hasNextEntry = Boolean(selectedEntry && index >= 0 && index < base.entries.length - 1);
    pagePrevious.disabled = busy || (draftPageIndex <= 0 && !hasPreviousEntry);
    pageNext.disabled = busy || (draftPageIndex >= draftPages.length - 2 && !hasNextEntry);
    entryPrevious.disabled = busy || !hasPreviousEntry;
    entryNext.disabled = busy || index < 0 || index >= base.entries.length - 1;
    const book = bookPageMetrics(), pageStart = (book.current?.start || 1) + draftPageIndex;
    pageNumber.textContent = `第 ${pageStart}–${pageStart + 1} 页 · 全书共 ${book.total} 页`;
    entryNumber.hidden = true;
    meta.textContent = byline(entry); date.textContent = `日期 · ${worldDate(entryDate(entry))}`;
    if (!editable && entry) setStatus(`「${entry.title}」只能由作者或 DM 修改。`);
    playPageTurn(turnSheet, direction);
    if (directory && !directoryDrawer()?.hidden) renderDirectory();
  }

  function replaceSelection(entryId) {
    selectedId = entryId || null; selectedEntry = selectedId ? entryAt(selectedId) : null;
    draft = selectedEntry ? { ...selectedEntry } : newEntry();
    resetDraftPages();
  }
  function confirmDiscard(message) { return !isDirty() || confirm(message); }
  function chooseEntry(id, direction = 0, destination = 'first') {
    if (busy || id === selectedId) return;
    if (!confirmDiscard('切换日志会放弃尚未保存的标题和正文，继续吗？')) return;
    setDirectoryOpen(false); replaceSelection(id);
    if (destination === 'last') draftPageIndex = Math.max(0, draftPages.length - 2);
    setStatus(''); renderEditor(direction);
  }
  function beginNew() {
    if (busy || base.entries.length >= MAX_ENTRIES) return;
    if (!confirmDiscard('新建日志会放弃当前未保存的标题和正文，继续吗？')) return;
    setDirectoryOpen(false); selectedId = null; selectedEntry = null; draft = newEntry(); resetDraftPages(); setStatus('为这篇日志填写标题和正文后保存。'); renderEditor(1); title.focus(); title.select();
  }
  function choosePage(target, direction = 0) {
    if (busy || !draft) return;
    commitDraftPages();
    const index = selectedIndex();
    if (target < 0) {
      const previousIndex = selectedEntry ? index - 1 : base.entries.length - 1;
      if (previousIndex >= 0) chooseEntry(base.entries[previousIndex].id, -1, 'last');
      return;
    }
    if (target >= draftPages.length) {
      if (selectedEntry && index >= 0 && index < base.entries.length - 1) chooseEntry(base.entries[index + 1].id, 1, 'first');
      return;
    }
    draftPageIndex = target; setStatus(''); renderEditor(direction);
  }
  function totalTextAfter(candidate) {
    return base.entries.reduce((total, entry) => total + (entry.id === selectedEntry?.id ? candidate.text.length : entry.text.length), selectedEntry ? 0 : candidate.text.length);
  }

  async function saveCurrent() {
    const bridge = window.journalBridge;
    if (busy || !bridge || !draft || !canEdit()) return;
    if (bridge.campaign() !== campaign) { setStatus('战役已切换，请重新打开日志；草稿仍在此页。'); return; }
    const candidate = readDraft();
    if (!candidate.title) { setStatus('请先为日志填写标题。'); title.focus(); return; }
    if (totalTextAfter(candidate) > MAX_TOTAL_TEXT) { setStatus(`所有日志正文合计最多 ${MAX_TOTAL_TEXT} 字；草稿已保留。`); return; }
    const mutation = selectedEntry
      ? { operation: 'update', entryId: selectedEntry.id, entry: { title: candidate.title, text: candidate.text } }
      : { operation: 'create', entry: { title: candidate.title, text: candidate.text } };
    busy = true; renderEditor(); setStatus('正在保存…');
    try {
      const result = await bridge.mutate(mutation, base.revision, campaign);
      base = normalize(result.journal || result, campaign); replaceSelection(result.entryId || selectedEntry?.id || base.entries.at(-1)?.id); setStatus(result.saveNotice || `已保存 · ${selectedEntry?.updatedBy || selectedEntry?.author || ''}`); renderEditor();
    } catch (error) { setStatus(error.message || '保存失败，草稿已保留'); }
    finally { busy = false; renderEditor(); }
  }

  async function deleteCurrent() {
    const bridge = window.journalBridge;
    if (busy || !bridge || !canDelete(selectedEntry) || !selectedEntry) return;
    if (!confirm(`确定删除日志「${selectedEntry.title}」吗？这会同步给所有玩家。`)) return;
    const index = selectedIndex(), deletedTitle = selectedEntry.title;
    busy = true; renderEditor(); setStatus('正在删除…');
    try {
      const result = await bridge.mutate({ operation: 'delete', entryId: selectedEntry.id }, base.revision, campaign);
      base = normalize(result.journal || result, campaign); replaceSelection(base.entries[Math.min(index, base.entries.length - 1)]?.id); setStatus(`已删除「${deletedTitle}」。`); renderEditor(-1);
    } catch (error) { setStatus(error.message || '删除失败，日志仍保留'); }
    finally { busy = false; renderEditor(); }
  }

  function open() {
    const bridge = window.journalBridge;
    if (!bridge) return;
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'journal-book'; dialog.setAttribute('aria-label', '冒险日志');
      dialog.innerHTML = '<form class="journal-heading"><strong>冒险日志</strong><div class="journal-heading-actions"><button type="button" class="journal-directory-toggle" aria-expanded="false">目录</button><button type="button" class="journal-new">＋ 新建</button><button type="button" class="journal-delete">删除此篇</button><button type="button" class="journal-save">保存日志</button><button type="button" class="journal-close" aria-label="合上日志">合上书本 ×</button></div></form><div class="journal-pages"><section class="journal-entry-page journal-left-page"><label class="journal-title-label" for="journal-title">日志标题</label><input id="journal-title" maxlength="80" placeholder="例如：抵达风骸岛" autocomplete="off"><div class="journal-entry-meta"></div><div class="journal-date"></div><label class="journal-body-label" for="journal-text-left">正文</label><textarea id="journal-text-left" maxlength="20000" placeholder="写下今天的冒险、线索与约定……"></textarea></section><section class="journal-entry-page journal-right-page"><div class="journal-continuation">续页</div><label class="journal-body-label" for="journal-text-right">正文</label><textarea id="journal-text-right" maxlength="20000" placeholder="继续书写……"></textarea><footer><span role="status"></span></footer></section></div><aside class="journal-directory-drawer" hidden><header><h2>日志目录</h2><button type="button" class="journal-directory-close">返回日志</button></header><ol class="journal-entry-list"></ol></aside><nav class="journal-navigation" aria-label="日志翻页"><button type="button" class="journal-entry-previous">‹ 上一篇</button><button type="button" class="journal-page-previous">‹ 上一页</button><span class="journal-page-number" aria-live="polite"></span><button type="button" class="journal-page-next">下一页 ›</button><button type="button" class="journal-entry-next">下一篇 ›</button><span class="journal-entry-number" hidden></span></nav>';
      document.body.append(dialog);
      directory = dialog.querySelector('.journal-entry-list'); directoryToggle = dialog.querySelector('.journal-directory-toggle'); directoryClose = dialog.querySelector('.journal-directory-close'); closeButton = dialog.querySelector('.journal-close'); title = dialog.querySelector('#journal-title'); leftText = dialog.querySelector('#journal-text-left'); rightText = dialog.querySelector('#journal-text-right'); meta = dialog.querySelector('.journal-entry-meta'); date = dialog.querySelector('.journal-date'); status = dialog.querySelector('[role=status]'); save = dialog.querySelector('.journal-save'); create = dialog.querySelector('.journal-new'); remove = dialog.querySelector('.journal-delete'); pagePrevious = dialog.querySelector('.journal-page-previous'); pageNext = dialog.querySelector('.journal-page-next'); entryPrevious = dialog.querySelector('.journal-entry-previous'); entryNext = dialog.querySelector('.journal-entry-next'); pageNumber = dialog.querySelector('.journal-page-number'); entryNumber = dialog.querySelector('.journal-entry-number');
      create.addEventListener('click', beginNew); pagePrevious.addEventListener('click', () => choosePage(draftPageIndex - 2, -1)); pageNext.addEventListener('click', () => choosePage(draftPageIndex + 2, 1)); entryPrevious.addEventListener('click', () => { const index = selectedIndex(); if (index > 0) chooseEntry(base.entries[index - 1].id, -1); }); entryNext.addEventListener('click', () => { const index = selectedIndex(); if (index >= 0 && index < base.entries.length - 1) chooseEntry(base.entries[index + 1].id, 1); }); save.addEventListener('click', saveCurrent); remove.addEventListener('click', deleteCurrent);
      directoryToggle.addEventListener('click', () => setDirectoryOpen(directory.parentElement.hidden)); directoryClose.addEventListener('click', () => setDirectoryOpen(false));
      closeButton.addEventListener('click', requestCloseBook);
      const syncSpreadAfterInput = (side) => {
        const field = side === 'left' ? leftText : rightText;
        const editedPageIndex = draftPageIndex + (side === 'right' ? 1 : 0);
        const caretInTail = field.selectionStart ?? field.value.length;
        commitDraftPages();
        const flowed = repaginateDraftFrom(editedPageIndex);
        const caret = pageForOffset(flowed, caretInTail);
        const targetPageIndex = editedPageIndex + caret.index;
        const oldSpread = draftPageIndex;
        draftPageIndex = Math.floor(targetPageIndex / 2) * 2;
        renderEditor(draftPageIndex === oldSpread ? 0 : 1);
        const targetField = targetPageIndex % 2 ? rightText : leftText;
        targetField.focus();
        targetField.setSelectionRange(caret.offset, caret.offset);
      };
      leftText.addEventListener('input', () => syncSpreadAfterInput('left')); rightText.addEventListener('input', () => syncSpreadAfterInput('right'));
      dialog.addEventListener('cancel', event => { event.preventDefault(); requestCloseBook(); });
      dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); requestCloseBook(); });
    }
    if (dialog.open) return;
    dialog.showModal();
    campaign = bridge.campaign(); base = normalize(bridge.read(), campaign); replaceSelection(base.entries[0]?.id); setStatus(''); renderEditor();
    // The first render establishes the real height of the title, author and
    // campaign-date rows. Paginate once more against that final geometry so
    // the last ruled line can never be clipped on initial open.
    resetDraftPages(); renderEditor();
  }

  function refresh() {
    if (!dialog?.open || busy) return;
    const bridge = window.journalBridge;
    if (bridge.campaign() !== campaign) { setStatus('战役已切换，请合上并重新打开。'); return; }
    const nextJournal = normalize(bridge.read(), campaign);
    if (nextJournal.revision === base.revision) { date.textContent = `日期 · ${worldDate(entryDate(selectedEntry || draft))}`; return; }
    if (isDirty()) { setStatus('有人更新了日志。请复制当前标题和正文，重新打开后合并。'); return; }
    const keepId = selectedId; base = nextJournal; replaceSelection(entryAt(keepId)?.id || base.entries[0]?.id); setStatus('已同步最新日志。'); renderEditor();
  }

  function localMutation(journal, mutation, context = {}) {
    const requestedCampaignId = String(context.campaignId || '').trim();
    const next = normalize(journal, requestedCampaignId), operation = mutation?.operation;
    if (!['create', 'update', 'delete'].includes(operation)) throw new Error('日志操作无效');
    const author = cleanTitle(context.author || (context.isDM ? 'DM' : '玩家'), '玩家').slice(0, 24);
    const at = Math.max(0, Math.floor(Number(context.at) || Date.now()));
    const worldSeconds = Number.isFinite(Number(context.worldSeconds)) ? Math.max(0, Math.floor(Number(context.worldSeconds))) : null;
    let entry, entryId = String(mutation?.entryId || '');
    if (operation === 'create') {
      if (next.entries.length >= MAX_ENTRIES) throw new Error(`最多可建立 ${MAX_ENTRIES} 篇日志`);
      const incoming = mutation.entry || {}, titleText = cleanTitle(incoming.title, ''), body = cleanText(incoming.text);
      if (!titleText) throw new Error('请给日志填写标题');
      if (next.entries.reduce((sum, item) => sum + item.text.length, body.length) > MAX_TOTAL_TEXT) throw new Error(`所有日志正文合计最多 ${MAX_TOTAL_TEXT} 字`);
      do { entryId = `journal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; } while (next.entries.some(item => item.id === entryId));
      entry = { id: entryId, title: titleText, text: body, author, createdAt: at, createdWorldSeconds: worldSeconds, updatedBy: author, updatedAt: at, updatedWorldSeconds: worldSeconds };
      next.entries.push(entry);
    } else {
      entry = next.entries.find(item => item.id === entryId);
      if (!entry) throw new Error('这篇日志已不存在，请重新打开日志。');
      if (operation === 'delete') {
        if (!context.isDM && entry.author !== author) throw new Error('只能删除自己创建的日志。');
        next.entries = next.entries.filter(item => item.id !== entryId);
      } else {
        if (!context.isDM && entry.author !== author) throw new Error('只能修改自己创建的日志。');
        const incoming = mutation.entry || {}, titleText = cleanTitle(incoming.title, ''), body = cleanText(incoming.text);
        if (!titleText) throw new Error('请给日志填写标题');
        const total = next.entries.reduce((sum, item) => sum + (item.id === entryId ? body.length : item.text.length), 0);
        if (total > MAX_TOTAL_TEXT) throw new Error(`所有日志正文合计最多 ${MAX_TOTAL_TEXT} 字`);
        Object.assign(entry, { title: titleText, text: body, updatedBy: author, updatedAt: at, updatedWorldSeconds: worldSeconds });
      }
    }
    next.campaignId = requestedCampaignId || next.campaignId || null;
    next.revision += 1; next.author = author; next.worldSeconds = worldSeconds; next.text = next.entries.map(item => item.text).join('\f');
    next.history = [...next.history, { author, at, worldSeconds, revision: next.revision, action: operation, entryId, title: entry?.title || '' }].slice(-50);
    return { journal: next, entryId };
  }

  async function readSaveResponse(response) {
    if ([404, 405, 501].includes(response.status)) throw new Error('当前联机服务尚未支持新版日志。请先保存战役，再关闭旧联机程序并重新启动，然后刷新双方页面；草稿请先复制保留。');
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('联机服务返回异常，日志尚未提交；请保留草稿并检查连接。'); }
    if (!response.ok) throw new Error(data.error || '保存失败，草稿已保留');
    if (!data.journal || typeof data.journal !== 'object') throw new Error('未收到有效日志确认，草稿已保留');
    return data;
  }

  return { open, refresh, normalize, localMutation, readSaveResponse, worldDate };
})();
