(function (root) {
  'use strict';

  const views = new WeakMap();
  const factions = {
    pc: { label: '玩家', color: '#5b8cff' },
    ally: { label: '友方', color: '#2ecc71' },
    enemy: { label: '敌方', color: '#ef476f' },
    npc: { label: '中立', color: '#e5be54' },
  };

  function element(document, tag, className) {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function updateOverflow(view) {
    const viewport = view.viewport;
    const overflow = !view.container.hidden && viewport.scrollWidth > viewport.clientWidth + 1;
    let before = 0;
    let after = 0;
    if (overflow) {
      const left = viewport.scrollLeft;
      const right = left + viewport.clientWidth;
      for (const card of view.cards.values()) {
        // The positioned list gives each card a content-relative offset.
        const start = card.item.offsetLeft + 4;
        const end = start + card.item.offsetWidth;
        if (start < left - 1) before += 1;
        if (end > right + 1) after += 1;
      }
    }
    view.container.dataset.initiativeOverflow = String(overflow);
    view.previous.hidden = !overflow;
    view.next.hidden = !overflow;
    view.previous.disabled = before === 0;
    view.next.disabled = after === 0;
    view.previousCount.textContent = String(before);
    view.nextCount.textContent = String(after);
    view.previous.setAttribute('aria-label', `向前浏览先攻，前方还有 ${before} 人未完整显示`);
    view.next.setAttribute('aria-label', `向后浏览先攻，后方还有 ${after} 人未完整显示`);
  }

  function navigationButton(document, direction, symbol) {
    const rail = element(document, 'div', 'initiative-ribbon-nav-rail');
    const button = element(document, 'button', 'initiative-ribbon-nav');
    const arrow = element(document, 'span', 'initiative-ribbon-nav-arrow');
    const count = element(document, 'span', 'initiative-ribbon-nav-count');
    button.type = 'button';
    button.dataset.direction = direction;
    button.hidden = true;
    arrow.setAttribute('aria-hidden', 'true');
    count.setAttribute('aria-hidden', 'true');
    arrow.textContent = symbol;
    button.append(arrow, count);
    rail.append(button);
    return { rail, button, count };
  }

  function mount(container) {
    const document = container.ownerDocument;
    const navigation = element(document, 'div', 'initiative-ribbon-navigation');
    const viewport = element(document, 'div', 'initiative-ribbon-viewport');
    const list = element(document, 'ol', 'initiative-ribbon-list');
    const previous = navigationButton(document, 'previous', '‹');
    const next = navigationButton(document, 'next', '›');
    const view = {
      container, viewport, list,
      previous: previous.button, previousCount: previous.count,
      next: next.button, nextCount: next.count,
      cards: new Map(), entries: new Map(), currentId: null, onSelect: null, scrollFrame: null,
    };
    container.classList.add('initiative-ribbon');
    container.setAttribute('aria-label', '头像先攻顺序');
    container.setAttribute('role', 'region');
    viewport.append(list);
    navigation.append(previous.rail, viewport, next.rail);
    container.append(navigation);

    function browse(direction) {
      const distance = Math.max(1, Math.floor(viewport.clientWidth * .85)) * direction;
      if (typeof viewport.scrollBy === 'function') viewport.scrollBy({ left: distance, behavior: 'smooth' });
      else viewport.scrollLeft += distance;
      updateOverflow(view);
    }
    previous.button.addEventListener('click', () => browse(-1));
    next.button.addEventListener('click', () => browse(1));
    viewport.addEventListener('scroll', () => updateOverflow(view), { passive: true });
    const window = document.defaultView || root;
    if (typeof window.ResizeObserver === 'function') {
      view.resizeObserver = new window.ResizeObserver(() => updateOverflow(view));
      view.resizeObserver.observe(viewport);
    } else if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => updateOverflow(view));
    }

    // Map controls may listen outside the ribbon. Keep interaction inside it.
    for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu', 'keydown']) {
      container.addEventListener(eventName, event => event.stopPropagation());
    }
    container.addEventListener('wheel', event => {
      event.stopPropagation();
      const delta = event.deltaX || event.deltaY;
      if (!event.ctrlKey && delta && viewport.scrollWidth > viewport.clientWidth) {
        event.preventDefault();
        const distance = event.deltaMode === 1 ? delta * 24 : (event.deltaMode === 2 ? delta * viewport.clientWidth : delta);
        viewport.scrollLeft += distance;
        updateOverflow(view);
      }
    }, { passive: false });
    list.addEventListener('click', event => {
      const button = event.target.closest('.initiative-ribbon-card');
      if (!button || !list.contains(button)) return;
      const entry = view.entries.get(button.dataset.entryId);
      if (entry && typeof view.onSelect === 'function') view.onSelect(entry);
    });
    views.set(container, view);
    return view;
  }

  function makeCard(view) {
    const document = view.container.ownerDocument;
    const item = element(document, 'li', 'initiative-ribbon-item');
    const button = element(document, 'button', 'initiative-ribbon-card');
    const frame = element(document, 'span', 'initiative-ribbon-portrait');
    const image = element(document, 'img', 'initiative-ribbon-image');
    const fallback = element(document, 'span', 'initiative-ribbon-icon');
    const value = element(document, 'span', 'initiative-ribbon-value');
    const name = element(document, 'span', 'initiative-ribbon-name');
    const current = element(document, 'span', 'initiative-ribbon-current');
    button.type = 'button';
    image.alt = '';
    image.draggable = false;
    frame.setAttribute('aria-hidden', 'true');
    value.setAttribute('aria-hidden', 'true');
    current.setAttribute('aria-hidden', 'true');
    current.textContent = '行动中';
    frame.append(image, fallback);
    button.append(frame, value, name, current);
    item.append(button);
    const card = { item, button, image, fallback, value, name, current, imageUrl: null };
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.hidden = false;
    });
    return card;
  }

  /**
   * entries: [{id, name, value, type: 'pc'|'ally'|'enemy'|'npc', icon, imageUrl}].
   * mode: 'free' hides the ribbon; 'prepare' and 'turn' show the queue.
   * onSelect receives the original entry and should only focus its map token.
   */
  function render(container, options = {}) {
    if (!container || !container.ownerDocument) return;
    const view = views.get(container) || mount(container);
    const entries = Array.isArray(options.entries) ? options.entries.filter(entry => entry && entry.id != null) : [];
    const mode = options.mode || 'free';
    const hidden = mode === 'free' || !entries.length;
    container.hidden = hidden;
    container.dataset.initiativeMode = mode;
    view.onSelect = options.onSelect;
    view.entries = new Map(entries.map(entry => [String(entry.id), entry]));

    const currentId = mode === 'turn'
      ? String(options.currentEntryId ?? entries.find(entry => entry.current)?.id ?? '')
      : '';
    const currentChanged = currentId !== view.currentId;
    view.currentId = currentId;

    for (const [id, card] of view.cards) {
      if (!view.entries.has(id)) {
        card.item.remove();
        view.cards.delete(id);
      }
    }
    let cursor = view.list.firstElementChild;
    for (const entry of entries) {
      const id = String(entry.id);
      let card = view.cards.get(id);
      if (!card) {
        card = makeCard(view);
        view.cards.set(id, card);
      }
      const environmental = entry.kind === 'environment';
      const faction = environmental ? { color: factions.npc.color, label: '环境' } : factions[entry.type] || factions.npc;
      const isCurrent = mode === 'turn' && id === currentId;
      const name = String(entry.name || '未命名单位');
      const hasValue = entry.value !== null && entry.value !== undefined && entry.value !== '';
      const value = hasValue ? String(entry.value) : '—';
      card.button.dataset.entryId = id;
      card.button.dataset.faction = factions[entry.type] ? entry.type : 'npc';
      card.button.style.setProperty('--initiative-ribbon-faction', faction.color);
      card.button.classList.toggle('initiative-ribbon-active', isCurrent);
      if (isCurrent) card.button.setAttribute('aria-current', 'step');
      else card.button.removeAttribute('aria-current');
      card.button.setAttribute('aria-label', `${name}，${faction.label}，先攻 ${value}${isCurrent ? '，行动中' : ''}${environmental ? '，打开先攻安排' : '，定位地图棋子'}`);
      card.button.title = `${name} · ${faction.label} · 先攻 ${value}${isCurrent ? ' · 行动中' : ''}`;
      card.name.textContent = name;
      card.value.textContent = value;
      card.fallback.textContent = String(entry.icon || '♟');
      card.current.hidden = !isCurrent;
      const imageUrl = environmental ? 'shared/assets/environment-initiative.png?v=20261002' : typeof entry.imageUrl === 'string' ? entry.imageUrl.trim() : '';
      if (card.imageUrl !== imageUrl) {
        card.imageUrl = imageUrl;
        card.image.hidden = !imageUrl;
        card.fallback.hidden = Boolean(imageUrl);
        if (imageUrl) card.image.src = imageUrl;
        else card.image.removeAttribute('src');
      }
      if (card.item !== cursor) view.list.insertBefore(card.item, cursor);
      cursor = card.item.nextElementSibling;
    }

    updateOverflow(view);

    if (currentChanged) {
      const window = container.ownerDocument.defaultView || root;
      if (view.scrollFrame != null) window.cancelAnimationFrame(view.scrollFrame);
      view.scrollFrame = null;
      if (!hidden && currentId && view.cards.has(currentId)) {
        view.scrollFrame = window.requestAnimationFrame(() => {
          view.scrollFrame = null;
          const card = view.cards.get(view.currentId);
          if (!view.container.hidden && card) card.item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
          updateOverflow(view);
        });
      }
    }
  }

  root.SundollInitiativeRibbon = { render };
})(window);
