"use strict";

(() => {
  const section = document.getElementById("guestbook-section");
  const form = document.getElementById("guestbook-form");
  const account = window.SundollSiteAccount;
  const accountStatus = document.getElementById("guestbook-account-status");
  const identityLabel = document.getElementById("guestbook-identity");
  const body = document.getElementById("guestbook-body");
  const submit = document.getElementById("guestbook-submit");
  const feedback = document.getElementById("guestbook-feedback");
  const list = document.getElementById("guestbook-list");
  const refresh = document.getElementById("guestbook-refresh");
  const more = document.getElementById("guestbook-more");
  const compose = document.getElementById("guestbook-compose");
  const composeToggle = document.getElementById("guestbook-compose-toggle");
  if (![section, form, account, body, submit, feedback, list, refresh, more, compose, composeToggle].every(Boolean)) return;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const random = window.crypto;
  const canCreateId = Boolean(random && (typeof random.randomUUID === "function" || typeof random.getRandomValues === "function"));
  const timeFormat = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const origin = configuredOrigin();
  const views = new Map();
  const deletionControls = new Set();
  const excerptViews = new WeakMap();
  const excerptObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const entry of entries) {
      const view = excerptViews.get(entry.target);
      if (view) syncExcerpt(view);
    }
  }) : null;
  const mainDraft = { form, body, submit, feedback, request: null, path: "/api/messages", kind: "message" };
  let messages = [];
  let hasLoaded = false;
  let emptyState = origin ? "正在看看酒馆的留言。" : "留言暂时无法显示。";
  let listFeedback = "";
  let nextCursor = null;
  let loading = false;
  let writing = null;
  let replyLoads = 0;
  let requestSequence = 0;
  let viewSequence = 0;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let identityEpoch = 0;
  let draftAccount = account.identity()?.id || "";
  const accountDrafts = new Map();
  const activeRequests = new Set();

  function configuredOrigin() {
    const value = document.querySelector('meta[name="guestbook-api"]')?.content?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function createRequestId() {
    if (typeof random?.randomUUID === "function") {
      try {
        const id = random.randomUUID();
        if (uuidPattern.test(id)) return id;
      } catch {}
    }
    if (typeof random?.getRandomValues !== "function") throw new Error("Secure randomness unavailable");
    const bytes = random.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(className, text) {
    const button = make("button", className, text);
    button.type = "button";
    return button;
  }

  function iconAction(className, shape) {
    const button = actionButton(className);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "guestbook-action-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.7");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", shape === "trash" ? "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" : shape === "heart" ? "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" : "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z");
    icon.append(path);
    const count = make("span", "guestbook-action-count", "0");
    count.setAttribute("aria-hidden", "true");
    button.append(icon, count);
    return { button, icon, count };
  }

  function syncControls() {
    const busy = loading || Boolean(writing) || replyLoads > 0;
    const resting = Date.now() < cooldownUntil;
    const writeDisabled = !origin || !canCreateId || !account.identity() || busy || resting;
    composeToggle.hidden = !account.identity();
    composeToggle.textContent = compose.hidden ? "留言" : "收起";
    submit.textContent = "发布";
    if (accountStatus) { accountStatus.hidden = !!account.identity(); accountStatus.textContent = account.connectionError?.() ? "账号连接暂不可用，点“刷新”重试。" : "登录后即可留言。"; }
    if (identityLabel) identityLabel.textContent = account.identity() ? account.identity().name : "";
    submit.disabled = writeDisabled;
    refresh.disabled = !origin || busy || resting;
    more.disabled = !origin || busy || resting;
    more.hidden = !nextCursor;
    form.setAttribute("aria-busy", String(writing === mainDraft));
    submit.setAttribute("aria-busy", String(writing === mainDraft));
    refresh.setAttribute("aria-busy", String(loading));
    more.setAttribute("aria-busy", String(loading));
    list.setAttribute("aria-busy", String(loading));
    section.classList.toggle("is-loading", busy);
    for (const view of views.values()) {
      view.like.disabled = !account.identity() || !origin || busy || resting;
      view.like.hidden = !account.identity();
      view.like.setAttribute("aria-busy", String(writing?.likeView === view));
      view.replyToggle.disabled = !account.identity() || !origin || busy || resting;
      view.replyToggle.hidden = !account.identity();
      view.draft.submit.disabled = writeDisabled;
      view.draft.form.setAttribute("aria-busy", String(writing === view.draft));
      view.draft.submit.setAttribute("aria-busy", String(writing === view.draft));
      view.replyMore.disabled = !origin || busy || resting;
      view.replyMore.hidden = !view.state.nextCursor;
      view.replyList.setAttribute("aria-busy", String(view.state.loading));
      for (const row of view.replyRows.values()) {
        row.like.disabled = !account.identity() || !origin || busy || resting;
        row.like.hidden = !account.identity();
        row.replyButton.disabled = !account.identity() || !origin || busy || resting;
        row.replyButton.hidden = !account.identity();
      }
    }
    for (const control of deletionControls) {
      if (!control.slot.isConnected) { deletionControls.delete(control); continue; }
      control.button.disabled = !origin || !account.identity() || !control.record.owned || busy || resting;
      control.confirm.disabled = control.button.disabled;
      control.button.setAttribute("aria-busy", String(writing?.deleteControl === control));
    }
  }

  function makeDeleteControls(record, kind, parentId, view, status) {
    const slot = make("span", "guestbook-delete-slot");
    const action = iconAction("quiet-button guestbook-delete", "trash");
    action.count.remove();
    const label = kind === "reply" ? "回复" : "留言";
    action.button.setAttribute("aria-label", `删除自己的${label}`);
    action.button.setAttribute("title", `删除${label}`);
    const panel = make("span", "guestbook-delete-confirm");
    panel.hidden = true;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "删除确认");
    panel.append(make("span", "guestbook-delete-question", kind === "reply" ? "删除这条回复？" : "删除留言及回复？"));
    const confirm = actionButton("quiet-button", "删除");
    const cancel = actionButton("quiet-button", "取消");
    confirm.setAttribute("aria-label", `确认删除${label}`);
    cancel.setAttribute("aria-label", `取消删除${label}`);
    panel.append(cancel, confirm);
    slot.append(action.button, panel);
    slot.hidden = !record.owned;
    const control = { slot, button: action.button, panel, confirm, cancel, record, kind, parentId, view, status };
    deletionControls.add(control);
    action.button.addEventListener("click", () => { panel.hidden = false; });
    cancel.addEventListener("click", () => { panel.hidden = true; action.button.focus(); });
    confirm.addEventListener("click", () => deleteOwned(control));
    return control;
  }

  function validTextRecord(value, status = "published") {
    if (!value || typeof value !== "object" || value.status !== status) return null;
    if (typeof value.id !== "string" || !value.id.trim()) return null;
    if (typeof value.nickname !== "string" || typeof value.body !== "string" || typeof value.createdAt !== "string") return null;
    const nameLength = Array.from(value.nickname.trim()).length;
    const bodyLength = Array.from(value.body.trim()).length;
    if (nameLength < 1 || nameLength > 24 || bodyLength < 1 || bodyLength > 500) return null;
    if (!Number.isFinite(new Date(value.createdAt).getTime())) return null;
    return { id: value.id, nickname: value.nickname, body: value.body, createdAt: value.createdAt, status: value.status, authorId: value.authorId || null, owned: value.owned === true && value.authorId === account.identity()?.id };
  }

  function validMessage(value, status = "published", enriched = true) {
    const record = validTextRecord(value, status);
    if (!record) return null;
    const count = (name) => Number.isSafeInteger(value[name]) && value[name] >= 0;
    if (enriched && (!count("likeCount") || !count("replyCount") || typeof value.liked !== "boolean")) return null;
    return { ...record, likeCount: count("likeCount") ? value.likeCount : 0, replyCount: count("replyCount") ? value.replyCount : 0, liked: value.liked === true };
  }

  function validReply(value, parentId, status = "published") {
    const record = validTextRecord(value, status);
    if (!record || value.parentId !== parentId) return null;
    if (value.targetReplyId != null && (!uuidPattern.test(value.targetReplyId) || typeof value.targetNickname !== "string" || !value.targetNickname.trim() || Array.from(value.targetNickname).length > 24)) return null;
    return { ...record, parentId, targetReplyId: value.targetReplyId || null, targetNickname: value.targetNickname || null, likeCount: Number.isSafeInteger(value.likeCount) && value.likeCount >= 0 ? value.likeCount : 0, liked: value.liked === true };
  }

  function uniqueRecords(items) {
    const byId = new Map();
    for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
    return Array.from(byId.values());
  }

  function orderedReplies(items) {
    return uniqueRecords(items).sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id.localeCompare(right.id));
  }

  function appendRecord(article, record, heading = "h3", interactive = false) {
    const header = make("header", "guestbook-entry-head");
    const name = make(heading, "", record.nickname);
    const time = make("time");
    time.setAttribute("datetime", record.createdAt);
    time.textContent = timeFormat.format(new Date(record.createdAt));
    const text = make(interactive ? "button" : "p", interactive ? "guestbook-message guestbook-message-toggle" : "guestbook-message", interactive ? undefined : record.body);
    let excerptText;
    let excerptMore;
    if (interactive) {
      text.type = "button";
      text.setAttribute("aria-expanded", "false");
      text.setAttribute("title", record.body);
      excerptText = make("span", "guestbook-message-text", record.body);
      excerptMore = make("span", "guestbook-message-more", "…");
      excerptMore.append(make("strong", "", "展开"));
      excerptMore.hidden = true;
      excerptMore.setAttribute("aria-hidden", "true");
      text.append(excerptText, excerptMore);
    }
    header.append(name, time);
    article.append(header, text);
    return { name, time, text, excerptText, excerptMore };
  }

  function syncExcerpt(view) {
    if (!view.text.isConnected) return;
    const lineHeight = Number.parseFloat(getComputedStyle(view.excerptText).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    const fullHeight = view.excerptText.scrollHeight;
    const truncated = fullHeight > lineHeight * 3 + 1;
    view.excerptMore.hidden = !truncated || view.state.expanded;
    view.text.disabled = !truncated;
    view.text.setAttribute("aria-label", truncated ? `${view.message.body}，${view.state.expanded ? "收起全文" : "展开全文"}` : view.message.body);
    const offset = Math.max(0, Math.min(fullHeight, lineHeight * 3) - view.actions.offsetHeight);
    view.article.style.setProperty("--guestbook-action-offset", `${offset}px`);
  }

  function queueExcerpt(view) {
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => syncExcerpt(view));
    else setTimeout(() => syncExcerpt(view), 0);
  }

  function createReplyDraft(view, panel) {
    const prefix = `guestbook-reply-${++viewSequence}`;
    const replyForm = make("form", "guestbook-form guestbook-reply-form");
    replyForm.hidden = true;
    const targetLabel = make("p", "guestbook-reply-target");
    const cancel = actionButton("quiet-button", "取消");
    cancel.addEventListener("click", () => {
      replyForm.hidden = true;
      view.replyToggle.setAttribute("aria-expanded", "false");
      updateView(view, view.message);
    });
    const bodyField = make("label", "guestbook-field", "回复");
    const bodyInput = make("textarea");
    bodyInput.id = `${prefix}-body`;
    bodyInput.name = "body";
    bodyInput.rows = 3;
    bodyInput.maxLength = 500;
    bodyInput.required = true;
    bodyInput.placeholder = "写下你的回复";
    bodyField.setAttribute("for", bodyInput.id);
    bodyField.append(bodyInput);
    const actions = make("div", "guestbook-form-actions");
    const status = make("p", "guestbook-feedback");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const send = make("button", "quiet-button guestbook-submit", "发送 ↗");
    send.type = "submit";
    actions.append(status, cancel, send);
    replyForm.append(targetLabel, bodyField, actions);
    panel.append(replyForm);
    const draft = { targetReplyId: null, targetLabel, form: replyForm, body: bodyInput, submit: send, feedback: status, request: null, path: `/api/messages/${encodeURIComponent(view.message.id)}/replies`, kind: "reply", view };
    attachDraft(draft);
    return draft;
  }

  function createView(message) {
    const article = make("article", "guestbook-entry");
    const recordNodes = appendRecord(article, message, "h3", true);
    const actions = make("div", "guestbook-actions");
    const likeAction = iconAction("quiet-button guestbook-like", "heart");
    const like = likeAction.button;
    like.setAttribute("aria-pressed", "false");
    const replyAction = iconAction("quiet-button guestbook-reply-toggle", "reply");
    const replyToggle = replyAction.button;
    replyToggle.setAttribute("aria-expanded", "false");
    actions.append(like, replyToggle);
    const actionFeedback = make("p", "guestbook-action-feedback");
    actionFeedback.setAttribute("role", "status");
    actionFeedback.setAttribute("aria-live", "polite");
    const panel = make("div", "guestbook-replies");
    panel.hidden = message.replyCount === 0;
    const view = { article, ...recordNodes, actions, like, likeIcon: likeAction.icon, likeCount: likeAction.count, replyToggle, replyCount: replyAction.count, actionFeedback, panel, message, replyRows: new Map(), state: { replies: [], loaded: false, loading: false, nextCursor: null, error: "", open: false, expanded: false } };
    view.deleteControls = makeDeleteControls(message, "message", null, view, actionFeedback);
    actions.append(view.deleteControls.slot);
    view.draft = createReplyDraft(view, panel);
    panel.id = `guestbook-replies-${viewSequence}`;
    replyToggle.setAttribute("aria-controls", panel.id);
    view.replyList = make("div", "guestbook-reply-list");
    view.replyMore = actionButton("quiet-button guestbook-reply-more", "更多回复");
    view.replyMore.hidden = true;
    panel.append(view.replyList, view.replyMore, view.draft.form);
    article.append(actions, actionFeedback, panel);
    excerptViews.set(view.text, view);
    excerptObserver?.observe(view.text);
    view.text.addEventListener("click", () => {
      view.state.expanded = !view.state.expanded;
      updateView(view, view.message);
    });
    like.addEventListener("click", () => toggleLike(view));
    replyToggle.addEventListener("click", () => openReplyDraft(view));
    view.replyMore.addEventListener("click", () => loadReplies(view, { append: true }));
    renderReplies(view);
    return view;
  }

  function updateView(view, message) {
    view.message = message;
    view.deleteControls.record = message;
    view.name.textContent = message.nickname;
    view.excerptText.textContent = message.body;
    view.text.setAttribute("title", message.body);
    view.text.setAttribute("aria-expanded", String(view.state.expanded));
    view.article.classList.toggle("guestbook-entry-expanded", view.state.expanded);
    view.time.setAttribute("datetime", message.createdAt);
    view.time.textContent = timeFormat.format(new Date(message.createdAt));
    view.likeCount.textContent = String(message.likeCount);
    view.like.setAttribute("aria-pressed", String(message.liked));
    view.like.setAttribute("aria-label", `${message.liked ? "取消点赞" : "点赞"}，${message.likeCount}`);
    view.like.setAttribute("title", message.liked ? "取消点赞" : "点赞");
    view.likeIcon.setAttribute("fill", message.liked ? "currentColor" : "none");
    view.replyCount.textContent = String(message.replyCount);
    view.replyToggle.setAttribute("aria-label", `回复 ${message.nickname}，${message.replyCount}`);
    view.replyToggle.setAttribute("title", `回复 ${message.nickname}`);
    view.panel.hidden = message.replyCount === 0 && !view.state.replies.length && view.draft.form.hidden;
    view.deleteControls.slot.hidden = !message.owned;
    queueExcerpt(view);
  }

  function render() {
    const fragment = document.createDocumentFragment();
    if (listFeedback) {
      const status = make("p", "guestbook-feedback", listFeedback);
      status.setAttribute("role", "status");
      fragment.append(status);
    }
    if (!messages.length) fragment.append(make("p", "guestbook-empty", hasLoaded ? "还没有留言" : emptyState));
    for (const message of messages) {
      let view = views.get(message.id);
      if (!view) {
        view = createView(message);
        views.set(message.id, view);
      }
      updateView(view, message);
      fragment.append(view.article);
    }
    list.replaceChildren(fragment);
    syncControls();
  }

  function openReplyDraft(view, reply = null) {
    if (!account.identity() || writing || loading || replyLoads) return;
    const target = reply?.nickname || view.message.nickname;
    if (view.draft.targetReplyId !== (reply?.id || null)) view.draft.request = null;
    view.draft.targetReplyId = reply?.id || null;
    view.draft.targetLabel.textContent = `回复 ${target}`;
    view.draft.body.placeholder = `回复 ${target}`;
    view.draft.form.hidden = false;
    view.panel.hidden = false;
    view.replyToggle.setAttribute("aria-expanded", "true");
    view.draft.body.focus();
  }

  function renderReplies(view) {
    const fragment = document.createDocumentFragment();
    if (view.state.error) fragment.append(make("p", "guestbook-feedback", view.state.error));
    if (!view.state.replies.length && view.message.replyCount > 0 && !view.state.loaded && !view.state.error) fragment.append(make("p", "guestbook-empty", "正在看看回复。"));
    for (const reply of view.state.replies) {
      let row = view.replyRows.get(reply.id);
      if (!row) {
        const article = make("article", "guestbook-reply-entry");
        const nodes = appendRecord(article, reply, "h4", true);
        const actions = make("div", "guestbook-reply-actions");
        const like = iconAction("quiet-button guestbook-like", "heart");
        const replyAction = iconAction("quiet-button guestbook-reply-toggle", "reply");
        replyAction.count.remove();
        const status = make("p", "guestbook-action-feedback");
        status.setAttribute("role", "status");
        row = { article, ...nodes, actions, like: like.button, likeIcon: like.icon, likeCount: like.count, replyButton: replyAction.button, actionFeedback: status, message: reply, state: { expanded: false } };
        row.deleteControls = makeDeleteControls(reply, "reply", view.message.id, view, status);
        actions.append(row.like, row.replyButton, row.deleteControls.slot);
        article.append(actions, status);
        row.text.addEventListener("click", () => {
          row.state.expanded = !row.state.expanded;
          renderReplies(view);
        });
        row.like.addEventListener("click", () => toggleLike(view, row));
        row.replyButton.addEventListener("click", () => openReplyDraft(view, row.message));
        excerptViews.set(row.text, row);
        excerptObserver?.observe(row.text);
        view.replyRows.set(reply.id, row);
      }
      row.message = reply;
      row.deleteControls.record = reply;
      row.name.textContent = `${reply.nickname} 回复 ${reply.targetNickname || view.message.nickname}`;
      row.name.setAttribute("title", row.name.textContent);
      row.excerptText.textContent = reply.body;
      row.text.setAttribute("title", reply.body);
      row.text.setAttribute("aria-expanded", String(row.state.expanded));
      row.article.classList.toggle("guestbook-entry-expanded", row.state.expanded);
      row.time.textContent = timeFormat.format(new Date(reply.createdAt));
      row.time.setAttribute("datetime", reply.createdAt);
      row.likeCount.textContent = String(reply.likeCount);
      row.like.setAttribute("aria-pressed", String(reply.liked));
      row.like.setAttribute("aria-label", `${reply.liked ? "取消点赞" : "点赞"} ${reply.nickname}的回复，${reply.likeCount}`);
      row.like.setAttribute("title", reply.liked ? "取消点赞" : "点赞");
      row.likeIcon.setAttribute("fill", reply.liked ? "currentColor" : "none");
      row.replyButton.setAttribute("aria-label", `回复 ${reply.nickname}`);
      row.replyButton.setAttribute("title", `回复 ${reply.nickname}`);
      row.deleteControls.slot.hidden = !reply.owned;
      fragment.append(row.article);
      queueExcerpt(row);
    }
    for (const [id, row] of view.replyRows) if (!view.state.replies.some(reply => reply.id === id)) {
      excerptObserver?.unobserve(row.text);
      view.replyRows.delete(id);
    }
    view.replyList.replaceChildren(fragment);
    view.replyMore.hidden = !view.state.nextCursor;
    view.panel.hidden = !view.message.replyCount && !view.state.replies.length && view.draft.form.hidden;
  }

  function retrySeconds(response, data) {
    const fromBody = Number(data?.retryAfter);
    const raw = response.headers.get("Retry-After");
    const fromHeader = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : NaN;
    const value = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : fromHeader;
    return Number.isFinite(value) && value > 0 ? Math.min(300, Math.ceil(value)) : 0;
  }

  function restFor(seconds) {
    if (!seconds) return;
    if (cooldownTimer !== null) window.clearTimeout(cooldownTimer);
    cooldownUntil = Date.now() + seconds * 1000;
    cooldownTimer = window.setTimeout(() => {
      cooldownUntil = 0;
      cooldownTimer = null;
      syncControls();
    }, seconds * 1000);
  }

  async function request({ path = "/api/messages", method = "GET", cursor = null, value = null, anonymous = false }) {
    const epoch = identityEpoch;
    const expectedActor = account.identity()?.id || "";
    const controller = new AbortController();
    const url = new URL(path, origin);
    if (method === "GET") {
      if (cursor !== null) url.searchParams.set("cursor", cursor);
      url.searchParams.set("_guestbook", `${Date.now()}-${++requestSequence}`);
    }
    let auth = null;
    if (method === "GET") {
      if (!anonymous && account.identity()) {
        try { auth = await account.authorization(false); }
        catch { /* Public reads remain available when the account issuer is offline. */ }
      }
    } else {
      await account.ready;
      auth = await account.authorization();
    }
    const actor = auth?.identityId || "";
    if (epoch !== identityEpoch || ((method !== "GET" || auth) && actor !== expectedActor)) throw Object.assign(new Error("账号已切换，请重试。"), {status:409, accountChanged:true});
    const options = { method, credentials: "omit", cache: "no-store", signal: controller.signal, headers:auth ? {Authorization:"Bearer " + auth.ticket} : {} };
    if (method === "POST" || method === "DELETE") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(value);
    }
    const timer = window.setTimeout(() => controller.abort(), method === "GET" ? 8000 : 12000);
    activeRequests.add(controller);
    try {
      const response = await fetch(url.href, options);
      let data;
      try { data = await response.json(); } catch {
        const error = new Error("Invalid response");
        error.status = response.status;
        throw error;
      }
      if (!response.ok || data?.ok !== true) {
        const error = new Error("Request was not confirmed");
        error.status = response.status;
        error.code = typeof data?.error === "object" ? data.error?.code : data?.code;
        error.retryAfter = retrySeconds(response, data);
        throw error;
      }
      if (epoch !== identityEpoch || ((method !== "GET" || auth) && actor !== (account.identity()?.id || ""))) throw Object.assign(new Error("账号已切换，请重试。"), {status:409, accountChanged:true});
      if (method === "GET" && !auth) {
        const publicRecord = value => ({...value, owned:false, liked:false});
        if (Array.isArray(data.messages)) data.messages = data.messages.map(publicRecord);
        if (Array.isArray(data.replies)) data.replies = data.replies.map(publicRecord);
      }
      return data;
    } finally {
      window.clearTimeout(timer);
      activeRequests.delete(controller);
    }
  }

  function failureText(error, kind = "read") {
    if (error.status === 401) { account.refresh(true); return "请先登录账号，文字会保留。"; }
    if (error.accountChanged) return "账号已切换，请确认后重试。";
    if (error.status === 429) {
      const seconds = error.retryAfter || 5;
      restFor(seconds);
      return `操作有点密，${seconds}秒后再试吧。`;
    }
    if (error.status === 503) {
      restFor(error.retryAfter || 3);
      return kind === "write" ? "酒馆暂时休息，文字还在，稍后再试吧。" : "暂时没能确认，稍后再试吧。";
    }
    if (error.status === 404) return "这条留言暂时无法查看，请刷新后再试。";
    if (kind === "write" && error.status >= 400 && error.status < 500) return "还没能留下，检查一下再试吧。";
    if (kind === "write") return "还没确认保存，文字还在。再试一次吧。";
    if (kind === "like") return "还没确认点赞，再试一次吧。";
    if (kind === "delete") return error.status === 403 ? "只有作者可以删除这条内容。" : "还没确认删除，内容仍保留着，再试一次吧。";
    return "暂时看不到留言，稍后再试吧。";
  }

  async function loadMessages({ append = false, confirmed = null, keepFeedback = false, anonymous = false } = {}) {
    if (!origin || loading || writing || replyLoads || Date.now() < cooldownUntil || (append && !nextCursor)) return;
    const cursor = append ? nextCursor : null;
    const epoch = identityEpoch;
    loading = true;
    listFeedback = "";
    if (!hasLoaded) emptyState = "正在看看酒馆的留言。";
    render();
    try {
      const data = await request({ cursor, anonymous });
      if (!Array.isArray(data.messages) || !(data.nextCursor === null || typeof data.nextCursor === "string")) throw new Error("Invalid page");
      const page = data.messages.map((item) => validMessage(item));
      if (page.some((item) => !item)) throw new Error("Invalid message");
      hasLoaded = true;
      messages = uniqueRecords(append ? [...messages, ...page] : page);
      nextCursor = data.nextCursor || null;
      if (!keepFeedback) feedback.textContent = canCreateId ? "" : "暂时无法留下留言，你可以先看看。";
    } catch (error) {
      if (epoch !== identityEpoch) return;
      if (confirmed) {
        messages = uniqueRecords([confirmed, ...messages]);
        feedback.textContent = "留言已留下，列表稍后再更新。";
      }
      if (!hasLoaded) emptyState = "留言暂时无法显示。";
      listFeedback = failureText(error);
    } finally {
      if (epoch === identityEpoch) { loading = false; render(); }
    }
    if (epoch !== identityEpoch) return;
    // Refresh the visible threads as well as their counts; preserve open drafts.
    await Promise.all(messages.filter(message => message.replyCount > 0 || views.get(message.id)?.state.loaded).map(message => loadReplies(views.get(message.id), {anonymous})));
  }

  async function loadReplies(view, { append = false, confirmed = null, anonymous = false } = {}) {
    if (!origin || loading || writing || view.state.loading || Date.now() < cooldownUntil || (append && !view.state.nextCursor)) return;
    const cursor = append ? view.state.nextCursor : null;
    const epoch = identityEpoch;
    view.state.loading = true;
    view.state.error = "";
    replyLoads += 1;
    renderReplies(view);
    syncControls();
    try {
      const data = await request({ path: view.draft.path, cursor, anonymous });
      if (!Array.isArray(data.replies) || !(data.nextCursor === null || typeof data.nextCursor === "string")) throw new Error("Invalid reply page");
      const page = data.replies.map((item) => validReply(item, view.message.id));
      if (page.some((item) => !item)) throw new Error("Invalid reply");
      view.state.loaded = true;
      view.state.replies = orderedReplies(append ? [...view.state.replies, ...page] : page);
      view.state.nextCursor = data.nextCursor || null;
    } catch (error) {
      if (epoch !== identityEpoch) return;
      if (confirmed) view.state.replies = orderedReplies([confirmed, ...view.state.replies]);
      view.state.error = failureText(error);
    } finally {
      if (epoch === identityEpoch) {
        view.state.loading = false; replyLoads -= 1; renderReplies(view); syncControls();
      }
    }
  }

  function fingerprint(draft) {
    return JSON.stringify([account.identity()?.id || "", draft.body.value.trim(), draft.targetReplyId || null]);
  }

  function attachDraft(draft) {
    const changed = () => {
      if (draft.request && draft.request.fingerprint !== fingerprint(draft)) draft.request = null;
    };
    draft.body.addEventListener("input", changed);
    draft.form.addEventListener("submit", (event) => {
      event.preventDefault();
      return saveDraft(draft);
    });
  }

  async function saveDraft(draft) {
    if (!origin || !canCreateId || loading || writing || replyLoads || Date.now() < cooldownUntil) return;
    if (!account.identity()) { draft.feedback.textContent = "请先登录账号。"; return; }
    const epoch = identityEpoch;
    const text = draft.body.value.trim();
    if (!text || Array.from(text).length > 500) {
      draft.feedback.textContent = text ? "最多500个字。" : "写几句话再留下吧。";
      return;
    }
    const captured = fingerprint(draft);
    try {
      if (!draft.request || draft.request.fingerprint !== captured) draft.request = { fingerprint: captured, requestId: createRequestId() };
    } catch {
      draft.feedback.textContent = "暂时无法留下留言，请稍后再试。";
      return;
    }
    const requestId = draft.request.requestId;
    writing = draft;
    draft.feedback.textContent = draft.kind === "reply" ? "正在留下这条回复。" : "正在留下这条留言。";
    syncControls();
    try {
      const data = await request({ path: draft.path, method: "POST", value: { body: text, requestId, ...(draft.kind === "reply" ? { targetReplyId: draft.targetReplyId } : {}) } });
      const status = ["published", "pending"].includes(data.status) ? data.status : null;
      const confirmed = !status ? null : draft.kind === "reply" ? validReply(data.reply, draft.view.message.id, status) : validMessage(data.message, status, false);
      if (!confirmed || confirmed.authorId !== account.identity()?.id || confirmed.body !== text || (draft.kind === "reply" && confirmed.targetReplyId !== draft.targetReplyId)) throw new Error("Write was not confirmed");
      if (fingerprint(draft) === captured) {
        draft.body.value = "";
        draft.request = null;
      }
      if (status === "pending") {
        draft.feedback.textContent = "已收到，审核后会显示。";
      } else {
        if (draft.kind === "reply") {
          draft.view.state.replies = orderedReplies([confirmed, ...draft.view.state.replies]);
          renderReplies(draft.view);
        } else {
          messages = uniqueRecords([confirmed, ...messages]);
          render();
        }
        draft.feedback.textContent = draft.kind === "reply" ? "回复已留下。" : "留言已留下。";
        writing = null;
        await loadMessages({ confirmed: draft.kind === "message" ? confirmed : null, keepFeedback: true });
        if (draft.kind === "reply") await loadReplies(draft.view, { confirmed });
      }
    } catch (error) {
      if (epoch !== identityEpoch) return;
      draft.feedback.textContent = failureText(error, "write");
    } finally {
      if (epoch === identityEpoch) { writing = null; syncControls(); }
    }
  }

  async function toggleLike(view, replyRow = null) {
    if (!origin || !account.identity() || loading || writing || replyLoads || Date.now() < cooldownUntil) return;
    const record = replyRow?.message || view.message;
    const epoch = identityEpoch;
    const status = replyRow?.actionFeedback || view.actionFeedback;
    const desired = !record.liked;
    writing = { likeView: view };
    status.textContent = "";
    syncControls();
    try {
      const data = await request({ path: replyRow ? `/api/messages/${encodeURIComponent(view.message.id)}/replies/${encodeURIComponent(record.id)}/like` : `/api/messages/${encodeURIComponent(view.message.id)}/like`, method: "POST", value: { liked: desired } });
      if (data.messageId !== view.message.id || (replyRow ? data.replyId !== record.id : data.replyId != null) || data.liked !== desired || !Number.isSafeInteger(data.likeCount) || data.likeCount < 0) throw new Error("Like was not confirmed");
      record.likeCount = data.likeCount;
      record.liked = data.liked;
      if (replyRow) renderReplies(view);
      else updateView(view, view.message);
    } catch (error) {
      if (epoch !== identityEpoch) return;
      status.textContent = failureText(error, "like");
    } finally {
      if (epoch === identityEpoch) { writing = null; syncControls(); }
    }
  }

  async function deleteOwned(control) {
    if (!origin || loading || writing || replyLoads || Date.now() < cooldownUntil || !account.identity() || !control.record.owned || control.record.authorId !== account.identity().id) return;
    const epoch = identityEpoch;
    writing = { deleteControl: control };
    control.status.textContent = "正在删除。";
    syncControls();
    try {
      const path = control.kind === "reply" ? `/api/messages/${encodeURIComponent(control.parentId)}/replies/${encodeURIComponent(control.record.id)}` : `/api/messages/${encodeURIComponent(control.record.id)}`;
      const data = await request({ path, method: "DELETE", value: {} });
      if (data.deletedId !== control.record.id || data.kind !== control.kind || (control.kind === "reply" && data.parentId !== control.parentId)) throw new Error("Deletion was not confirmed");
      if (control.kind === "message") {
        messages = messages.filter((message) => message.id !== control.record.id);
        excerptObserver?.unobserve(control.view.text);
        views.delete(control.record.id);
      } else {
        control.view.state.replies = control.view.state.replies.filter((reply) => reply.id !== control.record.id);
        control.view.message.replyCount = Math.max(0, control.view.message.replyCount - 1);
        updateView(control.view, control.view.message);
        renderReplies(control.view);
      }
      control.panel.hidden = true;
      control.status.textContent = "";
      writing = null;
      render();
      await loadMessages({ keepFeedback: true });
      if (control.kind === "reply" && messages.some((message) => message.id === control.parentId)) await loadReplies(control.view);
    } catch (error) {
      if (epoch !== identityEpoch) return;
      control.status.textContent = failureText(error, "delete");
    } finally {
      if (epoch === identityEpoch) { writing = null; syncControls(); }
    }
  }

  compose.hidden = true;
  composeToggle.setAttribute("aria-expanded", "false");
  composeToggle.addEventListener("click", () => {
    if (!account.identity()) return;
    compose.hidden = !compose.hidden;
    composeToggle.setAttribute("aria-expanded", String(!compose.hidden));
    if (!compose.hidden) body.focus();
    syncControls();
  });
  attachDraft(mainDraft);
  refresh.addEventListener("click", () => {
    const publicRead = loadMessages({anonymous:true});
    account.refresh(true).then(() => publicRead).then(() => { if (account.identity()) loadMessages(); }).catch(() => {});
    return publicRead;
  });
  more.addEventListener("click", () => loadMessages({ append: true }));
  render();
  if (!origin) feedback.textContent = "酒馆暂时休息，稍后再来吧。";
  else {
    if (!canCreateId) feedback.textContent = "暂时无法留下留言，你可以先看看。";
    const publicRead = loadMessages({anonymous:true});
    account.ready.then(() => publicRead).then(() => { if (account.identity()) loadMessages(); }).catch(() => {});
  }
  account.subscribe((identity, previousId) => {
    const nextId = identity?.id || "";
    if (nextId !== draftAccount) {
      const snapshot = draft => ({body:draft.body.value,request:draft.request,targetReplyId:draft.targetReplyId || null,targetLabel:draft.targetLabel?.textContent || "",open:!draft.form.hidden});
      accountDrafts.set(draftAccount,{main:snapshot(mainDraft),composeOpen:!compose.hidden,replies:new Map([...views].map(([id,view])=>[id,snapshot(view.draft)]))});
      const saved = accountDrafts.get(nextId);
      const restore = (draft, value) => {
        draft.body.value = value?.body || ""; draft.request = value?.request || null; draft.feedback.textContent = "";
        if (draft.kind === "reply") { draft.targetReplyId = value?.targetReplyId || null; draft.targetLabel.textContent = value?.targetLabel || ""; draft.form.hidden = !identity || !value?.open; }
      };
      identityEpoch += 1;
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
      loading = false; writing = null; replyLoads = 0;
      cooldownUntil = 0; window.clearTimeout(cooldownTimer); cooldownTimer = null;
      restore(mainDraft,saved?.main);
      compose.hidden = !identity || !saved?.composeOpen; composeToggle.setAttribute("aria-expanded",String(!compose.hidden));
      draftAccount = nextId;
      for (const message of messages) { message.owned = false; message.liked = false; }
      for (const view of views.values()) {
        restore(view.draft,saved?.replies.get(view.message.id));
        view.actionFeedback.textContent = ""; view.deleteControls.panel.hidden = true; view.state.loading = false;
        view.state.replies.forEach(reply => { reply.owned = false; reply.liked = false; });
        for (const row of view.replyRows.values()) { row.actionFeedback.textContent = ""; row.deleteControls.panel.hidden = true; }
        renderReplies(view);
      }
      render();
      if (origin) loadMessages();
    }
    syncControls();
  });
})();
