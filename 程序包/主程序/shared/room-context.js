/* Scope legacy URLs and browser recovery data to the current room and account. */
(() => {
  'use strict';
  const match = location.pathname.match(/^\/rooms\/(r[0-9a-f]{32})(?:\/|$)/);
  if (!match) return;
  const id = match[1], prefix = '/rooms/' + id;
  const accountId = document.querySelector('meta[name="sundoll-account-id"]')?.content || '';
  const activeAccountKey = 'sundoll-active-account';
  const validAccount = /^a[0-9a-f]{32}$/.test(accountId);
  const namespace = 'room:' + id + ':account:' + accountId + ':';
  const nativeGet = Storage.prototype.getItem, nativeSet = Storage.prototype.setItem;
  let invalidated = !validAccount;
  let invalidationMessage = validAccount ? '邮箱账号已切换或退出。请从账号页重新进入战役，当前页面已停止操作。' : '此战役页面缺少账号信息，请从账号页重新进入。';
  const sources = new Set();
  window.SundollRoom = Object.freeze({id, prefix, accountId});
  function showAccountChange() {
    const render = () => {
      if (!document.body) return;
      const panel = document.createElement('main');
      panel.setAttribute('role', 'alert');
      panel.style.cssText = 'max-width:540px;margin:12vh auto;padding:24px;font:16px/1.8 system-ui;color:#eee;background:#161d25;border-radius:12px';
      const message = document.createElement('p');
      message.textContent = invalidationMessage;
      const link = document.createElement('a'); link.href = '/account#dashboard'; link.textContent = '返回我的主页'; link.style.color = '#e8cb98';
      panel.append(message, link); document.body.replaceChildren(panel);
    };
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render, {once:true});
  }
  function invalidate(message) {
    if (invalidated) return;
    if (message) invalidationMessage = message;
    invalidated = true;
    for (const source of sources) source.close();
    showAccountChange();
  }
  function assertAccount() {
    try {
      const active = nativeGet.call(window.localStorage, activeAccountKey);
      if (active !== null && active !== accountId) invalidate();
    } catch { /* The server-provided identity still scopes unavailable storage. */ }
    if (invalidated) throw new Error('邮箱账号已变化，请从账号页重新进入战役');
  }
  try {
    const active = nativeGet.call(window.localStorage, activeAccountKey);
    if (active === null && validAccount) nativeSet.call(window.localStorage, activeAccountKey, accountId);
    else if (active !== null && active !== accountId) invalidate();
  } catch { /* Storage may be disabled in private browsing. */ }
  window.addEventListener('storage', event => {
    if (event.key === activeAccountKey && event.newValue !== accountId) invalidate();
  });
  if (!validAccount) showAccountChange();
  const roomApi = /^\/rooms\/r[0-9a-f]{32}\/api\//;
  const isApi = url => url.origin === location.origin && (url.pathname.startsWith('/api/') || roomApi.test(url.pathname));
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (isApi(url)) {
      assertAccount();
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : {}));
      if (url.pathname.startsWith('/api/')) headers.set('X-Sundoll-Room', id);
      headers.set('X-Sundoll-Expected-Account', accountId);
      options = {...options, headers};
    }
    const response = originalFetch(input, options);
    if (!isApi(url)) return response;
    return Promise.resolve(response).then(async result => {
      // A response may finish after another tab has replaced the account.
      // Stop it before old private state can be consumed by the current page.
      assertAccount();
      if (result.status === 409 && typeof result.clone === 'function') {
        try {
          const data = await result.clone().json();
          if (/邮箱账号.*(?:变化|切换|不一致)/.test(data.error || '')) invalidate();
        } catch { /* Non-JSON conflicts still belong to their original caller. */ }
      }
      return result;
    });
  };
  const NativeEventSource = window.EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(input, options) {
      const url = new URL(input, location.href);
      const scoped = isApi(url);
      if (scoped) {
        assertAccount();
        if (url.pathname.startsWith('/api/')) url.pathname = prefix + url.pathname;
        url.searchParams.set('sundollAccount', accountId);
      }
      super(url.href, options);
      if (scoped) {
        sources.add(this);
        let checkingAccess = false, nextAccessCheck = 0, retryDelay = 1000;
        // Native SSE does not expose its HTTP status. Recheck the frozen account
        // when a stream fails, while leaving temporary network failures alone.
        this.addEventListener('error', async () => {
          if (invalidated || checkingAccess || Date.now() < nextAccessCheck) return;
          checkingAccess = true;
          let temporaryFailure = true;
          try {
            const response = await originalFetch('/api/account/session', {cache:'no-store',credentials:'same-origin',headers:{'X-Sundoll-Expected-Account':accountId}});
            if (response.status === 401) invalidate();
            else if (response.status === 409) {
              const data = await response.json();
              if (/邮箱账号.*(?:变化|切换|不一致)/.test(data.error || '')) invalidate();
            } else if (response.status === 200) {
              assertAccount();
              const access = await originalFetch(prefix + '/api/info', {cache:'no-store',credentials:'same-origin',headers:{'X-Sundoll-Expected-Account':accountId}});
              assertAccount();
              if (access.status === 200) temporaryFailure = false;
              if (access.status === 403 || access.status === 404) invalidate('战役权限已变化，或此空间已不可用。请从账号页重新选择战役，当前页面已停止操作。');
              else if (access.status === 401) invalidate();
              else if (access.status === 409) {
                const data = await access.json();
                if (/邮箱账号.*(?:变化|切换|不一致)/.test(data.error || '')) invalidate();
              }
            }
          } catch { /* Reconnection remains available after a transient outage. */ }
          finally {
            checkingAccess = false;
            nextAccessCheck = Date.now() + (temporaryFailure ? retryDelay : 1000);
            retryDelay = temporaryFailure ? Math.min(retryDelay * 2, 60000) : 1000;
          }
        });
      }
    }
    close() { sources.delete(this); super.close(); }
  };
  for (const name of ['getItem', 'setItem', 'removeItem']) {
    const original = Storage.prototype[name];
    Storage.prototype[name] = function(key, ...args) {
      assertAccount();
      return original.call(this, namespace + key, ...args);
    };
  }
  // Portrait and legacy campaign caches also use IndexedDB on the shared origin.
  if (window.IDBFactory) for (const name of ['open', 'deleteDatabase']) {
    const original = IDBFactory.prototype[name];
    IDBFactory.prototype[name] = function(database, ...args) {
      assertAccount();
      return original.call(this, namespace + database, ...args);
    };
  }
})();
