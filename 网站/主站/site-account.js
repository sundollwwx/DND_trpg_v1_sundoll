"use strict";

(() => {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const base = configuredBase();
  const listeners = new Set();
  let state = null, pending = null, sequence = 0, lastFailure = null;
  const signalKey = "sundoll-site-account-change";

  function configuredBase() {
    const fallback = local ? "http://127.0.0.1:8090" : "https://pl.sundollworld.com";
    try {
      const value = document.querySelector('meta[name="account-api"]')?.content?.trim();
      if (!value) return fallback;
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return fallback;
      if (url.origin === "https://pl.sundollworld.com") return local ? fallback : url.origin;
      return local && loopback && url.protocol === "http:" ? url.origin : fallback;
    } catch { return fallback; }
  }

  function accountUrl(dashboard = false) {
    const url = new URL("/account", base);
    url.searchParams.set("return", location.href);
    if (dashboard) url.hash = "dashboard";
    return url.href;
  }

  function render() {
    const hasAdventureEntry = Boolean(document.querySelector('a[data-site-adventure-entry]'));
    for (const link of document.querySelectorAll('[data-sundoll-entry="account"]')) {
      const signedOut = link.hasAttribute("data-site-account-signedout");
      const adventure = link.hasAttribute("data-site-adventure-entry");
      link.href = accountUrl(!signedOut);
      if (signedOut) link.hidden = Boolean(state);
      else if (link.classList.contains("account-popover-link")) link.hidden = hasAdventureEntry;
      const label = link.querySelector('[data-site-account-link-label]');
      if (label) label.textContent = adventure ? state ? "进入我的冒险" : "开始冒险" : signedOut ? "登录 / 注册" : "我的主页";
      link.setAttribute("aria-label", adventure ? state ? "进入我的冒险" : "开始冒险" : signedOut ? "登录或注册账号" : state ? `${state.identity.name}的主页` : "我的主页");
    }
    for (const greeting of document.querySelectorAll('[data-site-adventure-greeting]')) {
      greeting.textContent = state ? `欢迎回来，${state.identity.name}。` : "创建房间，或加入朋友的冒险。";
    }
    for (const menu of document.querySelectorAll('[data-site-account-menu]')) {
      menu.hidden = !state;
      menu.querySelector("summary")?.setAttribute("aria-label", state ? `${state.identity.name}的账号菜单` : "账号菜单");
    }
    for (const label of document.querySelectorAll('[data-site-account-name]')) {
      label.hidden = !state;
      label.textContent = state?.identity.name || "";
      if (state) label.setAttribute("title", state.identity.name);
      else label.removeAttribute("title");
    }
    for (const initial of document.querySelectorAll('[data-site-account-initial]')) {
      initial.textContent = state ? Array.from(state.identity.name.trim())[0] : "";
    }
    for (const button of document.querySelectorAll('[data-site-account-logout]')) button.hidden = !state;
  }

  function closeAccountMenus({restoreFocus = false, identityChanged = false, focused = document.activeElement} = {}) {
    for (const menu of document.querySelectorAll('[data-site-account-menu]')) {
      const wasOpen = menu.open;
      const heldFocus = menu.contains(focused);
      menu.open = false;
      if (identityChanged && heldFocus) {
        const target = state ? menu.querySelector("summary") : document.querySelector('[data-site-account-signedout]');
        target?.focus();
      } else if (restoreFocus && wasOpen) menu.querySelector("summary")?.focus();
    }
  }

  function publish(next) {
    const previousId = state?.identity.id || "";
    const previousFocus = document.activeElement;
    state = next;
    render();
    if (previousId !== (state?.identity.id || "")) {
      closeAccountMenus({identityChanged:true,focused:previousFocus});
      if (state && previousFocus === document.querySelector('[data-site-account-signedout]')) {
        document.querySelector('[data-site-account-menu]')?.querySelector("summary")?.focus();
      }
    }
    for (const listener of listeners) listener(state?.identity || null, previousId);
  }

  async function refresh(force = false) {
    if (pending && !force) return pending.promise;
    if (!force && state && state.expiresAt * 1000 - Date.now() > 60_000) return state;
    if (pending) pending.controller.abort();
    const ticket = ++sequence;
    const controller = new AbortController();
    const job = {controller, promise:null};
    pending = job;
    const timer = setTimeout(() => controller.abort(), 8000);
    job.promise = (async () => {
      try {
        const response = await fetch(base + "/api/account/site-session", {credentials:"include", cache:"no-store", signal:controller.signal});
        const data = await response.json();
        if (ticket !== sequence) return null;
        if (response.status === 401) { lastFailure = null; publish(null); return null; }
        if (!response.ok || data.ok !== true || !/^board_[0-9a-f]{32}$/.test(data.identity?.id)
            || typeof data.identity.name !== "string" || !data.identity.name.trim() || Array.from(data.identity.name).length > 24
            || typeof data.ticket !== "string" || !data.ticket || !Number.isFinite(data.expiresAt) || data.expiresAt * 1000 <= Date.now()) {
          throw Object.assign(new Error("账号连接暂不可用"), {status:response.status || 503});
        }
        lastFailure = null;
        publish(data);
        return state;
      } catch (error) {
        if (ticket === sequence) { lastFailure = error; publish(null); }
        return null;
      } finally { clearTimeout(timer); if (pending === job) pending = null; }
    })();
    return job.promise;
  }

  async function authorization(force = true) {
    let current = await refresh(force);
    if (!current) current = pending ? await pending.promise : state;
    if (!current) throw Object.assign(new Error(lastFailure ? "账号连接暂不可用，请稍后再试。" : "请先登录账号。"), {status:lastFailure ? 503 : 401});
    return {ticket:current.ticket, identityId:current.identity.id};
  }

  async function logout() {
    const expectedId = state?.identity.id;
    const current = await refresh(true);
    if (!current) return;
    if (current.identity.id !== expectedId) throw new Error("账号已变化，请确认后重试退出。");
    const snapshot = sequence;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(base + "/api/account/site-session/logout", {
        method:"POST", credentials:"include", cache:"no-store", signal:controller.signal,
        headers:{"Content-Type":"application/json", "X-Sundoll-Account":"1"},
        body:JSON.stringify({identityId:current.identity.id}),
      });
    } finally { clearTimeout(timer); }
    if (snapshot !== sequence || state?.identity.id !== expectedId) throw new Error("账号已变化，请确认后重试退出。");
    let result;
    try { result = await response.json(); } catch { throw new Error("退出结果尚未确认，请刷新查看账号状态。"); }
    if (snapshot !== sequence || state?.identity.id !== expectedId) throw new Error("账号已变化，请确认后重试退出。");
    if (!response.ok || result?.ok !== true) { await refresh(true); throw new Error("账号已变化，请刷新后重试。"); }
    sequence += 1;
    lastFailure = null;
    publish(null);
    try { localStorage.setItem(signalKey, String(Date.now())); } catch {}
  }

  window.SundollSiteAccount = {
    identity: () => state?.identity || null,
    connectionError: () => Boolean(lastFailure),
    accountUrl,
    refresh,
    authorization,
    logout,
    subscribe(listener) { listeners.add(listener); listener(state?.identity || null, ""); return () => listeners.delete(listener); },
    ready: null,
  };
  if (local) {
    const accountBase = new URL(base);
    const administratorBase = ["localhost", "127.0.0.1", "[::1]"].includes(accountBase.hostname) ? base : "http://127.0.0.1:8090";
    for (const link of document.querySelectorAll('[data-sundoll-entry="administrator"]')) {
      link.href = new URL("/主控台/主控台.html", administratorBase).href;
    }
  }
  for (const button of document.querySelectorAll('[data-site-account-logout]')) {
    const label = button.querySelector('[data-site-account-logout-label]');
    const normalLabel = label?.textContent || "退出";
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      if (label) label.textContent = "正在退出…";
      button.removeAttribute("title");
      try { await logout(); if (label) label.textContent = normalLabel; }
      catch (error) { if (label) label.textContent = "重试退出"; button.setAttribute("title", error.message); }
      finally { button.disabled = false; }
    });
  }
  document.addEventListener("click", event => {
    for (const menu of document.querySelectorAll('[data-site-account-menu]')) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !Array.from(document.querySelectorAll('[data-site-account-menu]')).some(menu => menu.open)) return;
    event.preventDefault();
    closeAccountMenus({restoreFocus:true});
  });
  window.addEventListener("focus", () => refresh(true));
  window.addEventListener("storage", event => { if (event.key === signalKey) refresh(true); });
  render();
  window.SundollSiteAccount.ready = refresh(true);
})();
