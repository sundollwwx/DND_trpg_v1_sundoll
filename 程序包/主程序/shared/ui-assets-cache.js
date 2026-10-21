/* Install the public artwork cache without delaying the page or its login. */
(() => {
  'use strict';
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const warmed = new WeakSet();
  const warm = worker => {
    const connection = navigator.connection;
    if (!worker || warmed.has(worker) || document.hidden || connection?.saveData ||
        /^(slow-)?2g$/.test(connection?.effectiveType || '')) return;
    warmed.add(worker);
    const send = () => {
      if (!document.hidden) worker.postMessage({type: 'warm-ui-assets'});
      else warmed.delete(worker);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(send, {timeout: 5000});
    else setTimeout(send, 2000);
  };
  const start = async () => {
    try {
      await navigator.serviceWorker.register('/ui-assets-sw.js', {scope: '/', updateViaCache: 'none'});
      const ready = await navigator.serviceWorker.ready;
      warm(ready.active);
      navigator.serviceWorker.addEventListener('controllerchange', () => warm(navigator.serviceWorker.controller));
      document.addEventListener('visibilitychange', () => warm(navigator.serviceWorker.controller));
    } catch { /* Private browsing, storage limits and old browsers keep normal loading. */ }
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, {once: true});
})();
