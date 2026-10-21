/* Keep DM authentication separate from player identities and browser save caches. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  let remoteDM = false, banner;
  function showLoginRequired() {
    if (banner) return;
    banner = document.createElement('aside');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:14px;background:#49382b;color:#fff;text-align:center';
    banner.textContent = window.SundollRoom ? '账号登录或战役权限已变化，当前页面暂时无法保存。' : 'DM 登录已失效，当前页面暂时无法保存。';
    const link = document.createElement('a');
    link.href = window.SundollRoom ? '/account#dashboard' : '/login'; link.target = '_blank'; link.rel = 'noopener';
    link.textContent = ' 在新标签页重新登录'; link.style.color = '#cde3ff';
    banner.appendChild(link); document.body.appendChild(banner);
  }
  window.fetch = async (input, options) => {
    const response = await nativeFetch(input, options);
    const url = new URL(typeof input === 'object' && input && 'url' in input ? input.url : input, location.href);
    if (remoteDM && (response.status === 401 || (window.SundollRoom && [403,404].includes(response.status))) && url.origin === location.origin && url.pathname.startsWith('/api/')) showLoginRequired();
    return response;
  };
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const response = await nativeFetch('/api/dm/session', {cache: 'no-store'});
      if (!response.ok) return;
      remoteDM = (await response.json()).authenticated === true;
      if (!remoteDM) return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'small'; button.textContent = window.SundollRoom ? '我的主页' : '退出 DM';
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          if (!(typeof hostCampaignDeferred !== 'undefined' && hostCampaignDeferred) && typeof state !== 'undefined' && state.campaignId) {
            if (typeof queueCurrentFolderSave === 'function') {
              if (typeof flushDetailTextSave === 'function') flushDetailTextSave();
              if (!await queueCurrentFolderSave({backup:true})) {
                if (typeof toast === 'function') toast('当前战役尚未保存，请检查连接后重试。');
                return;
              }
              // A later edit may enqueue a new job while the first write awaits.
              while (typeof folderSaveQueue !== 'undefined') {
                const latest = folderSaveQueue;
                if (!await latest) {
                  if (typeof toast === 'function') toast('当前战役尚未保存，请检查连接后重试。');
                  return;
                }
                if (latest === folderSaveQueue) break;
              }
            } else if (typeof saveNowWithFeedback === 'function') {
              await saveNowWithFeedback();
              if (!await folderSaveQueue) return;
            }
          }
          if (window.SundollRoom) { location.assign('/account#dashboard'); return; }
          const result = await fetch('/api/dm/logout', {method: 'POST'});
          if (result.ok) location.replace('/login');
        } catch (error) {
          if (typeof toast === 'function') toast(error.message || '保存未完成，请稍后重试。');
        } finally {
          button.disabled = false;
        }
      });
      const cover = document.querySelector('#cover');
      const coverActions = document.querySelector('.cover-global-actions');
      const playActions = document.querySelector('.topbar-session-controls') || document.querySelector('#topbar');
      const placeReturn = () => {
        const onHome = cover && !cover.hidden && getComputedStyle(cover).display !== 'none';
        (onHome && coverActions ? coverActions : playActions || coverActions).appendChild(button);
      };
      placeReturn();
      if (cover && typeof MutationObserver === 'function') {
        new MutationObserver(placeReturn).observe(cover, {attributes:true, attributeFilter:['style','class','hidden']});
      }
      window.setInterval(async () => {
        try {
          const check = await nativeFetch('/api/dm/session', {cache: 'no-store'});
          if (check.ok && banner) { banner.remove(); banner = null; }
          else if (check.status === 401 || (window.SundollRoom && [403,404].includes(check.status))) showLoginRequired();
        } catch (_) { /* Normal connection recovery remains with the host client. */ }
      }, 15000);
    } catch (_) { /* Local hosts do not require a DM password. */ }
  });
})();
