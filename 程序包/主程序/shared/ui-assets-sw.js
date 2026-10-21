/* Generated manifests contain only public interface images and fonts. */
'use strict';
const UI_ASSETS = /*__UI_ASSETS__*/ [];
const CACHE_NAME = 'sundoll-public-ui-v1';
const assets = new Map();
const inFlight = new Map();
let canWarm = true;
for (const entry of UI_ASSETS) {
  assets.set(new URL(entry.url, self.location.origin).pathname, entry);
  assets.set(new URL(entry.cacheUrl, self.location.origin).pathname, entry);
}
function assetFor(request) {
  if (request.method !== 'GET' || request.mode === 'navigate' || request.headers.has('Range')) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  const path = url.pathname.replace(/^\/rooms\/r[0-9a-f]{32}(?=\/)/, '');
  return assets.get(path) || null;
}
async function loadAsset(entry) {
  const key = new URL(entry.cacheUrl, self.location.origin).href;
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch { canWarm = false; /* Keep normal loading when storage is unavailable. */ }
  if (!inFlight.has(key)) {
    const pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(key, {credentials: 'omit', redirect: 'error', signal: controller.signal, priority: 'low'});
        if (response.status !== 200 || !/^(image\/|font\/|application\/(?:font|x-font))/.test(response.headers.get('Content-Type') || '')) {
          throw new Error('Public artwork unavailable');
        }
        const bytes = await response.clone().arrayBuffer();
        if (bytes.byteLength !== entry.size) throw new Error('Artwork size changed');
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        if (digest !== entry.digest) throw new Error('Artwork version changed');
        try { if (cache) await cache.put(key, response.clone()); } catch { canWarm = false; /* Serve the image even at quota. */ }
        return response;
      } finally { clearTimeout(timer); }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return (await inFlight.get(key)).clone();
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  try {
    const cache = await caches.open(CACHE_NAME);
    const current = new Set(UI_ASSETS.map(entry => new URL(entry.cacheUrl, self.location.origin).href));
    for (const key of await cache.keys()) if (!current.has(key.url)) await cache.delete(key);
  } catch { /* Storage is optional. */ }
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const entry = assetFor(event.request);
  if (entry) event.respondWith(loadAsset(entry).catch(() => fetch(event.request)));
});
let warming;
self.addEventListener('message', event => {
  if (event.data?.type !== 'warm-ui-assets') return;
  if (!canWarm) return;
  if (!warming) warming = (async () => {
    // One download at a time; do not let one missing file prevent other artwork.
    for (const entry of UI_ASSETS) {
      if (!canWarm) break;
      try { await loadAsset(entry); } catch { /* Retry on demand or the next visit. */ }
    }
  })().finally(() => { warming = null; });
  event.waitUntil(warming);
});
