/* Bounded browser requests, coordinated reads, and private diagnostic metadata. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SundollClientRuntime = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  function deadline(task, { timeoutMs = 8000, message = '连接超时，请重试', signal, env = globalThis } = {}) {
    const controller = new env.AbortController();
    let timer, rejectDeadline;
    const expired = new Promise((_, reject) => { rejectDeadline = reject; });
    const fail = (name, text) => {
      const error = Object.assign(new Error(text), { name });
      rejectDeadline(error); controller.abort();
    };
    const abort = () => fail('AbortError', '读取已取消');
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timer = env.setTimeout(() => fail('TimeoutError', message), timeoutMs);
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw Object.assign(new Error('读取已取消'), { name: 'AbortError' });
      return task(controller.signal);
    });
    return Promise.race([work, expired]).finally(() => {
      env.clearTimeout(timer); signal?.removeEventListener('abort', abort);
    });
  }
  function requestJson(url, options = {}, settings = {}) {
    const env = settings.env || globalThis;
    return deadline(async signal => {
      const response = await env.fetch(url, { ...options, signal });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    }, { ...settings, signal: options.signal || settings.signal, env });
  }
  function createReadCoordinator(options) {
    let flight = null, queued = false, epoch = 0;
    function cancel() {
      epoch++; queued = false;
      flight?.controller.abort(); flight = null;
    }
    function request(quiet = false) {
      if (!options.canRead()) return Promise.resolve();
      const key = options.key();
      if (flight?.key === key) { queued = true; return flight.promise; }
      if (flight) cancel();
      const item = { key, epoch, controller: new (options.env || globalThis).AbortController(), promise: null };
      flight = item; options.started?.(quiet);
      const current = () => flight === item && epoch === item.epoch && options.key() === key && options.canRead();
      item.promise = deadline(signal => options.read(signal), {
        signal: item.controller.signal, timeoutMs: options.timeoutMs || 10000,
        message: options.timeoutMessage || '队伍读取超时，请重试', env: options.env || globalThis,
      }).then(data => { if (current()) options.apply(data, quiet); })
        .catch(error => { if (current()) options.error?.(error); })
        .finally(() => {
          if (flight !== item) return;
          flight = null;
          const again = queued; queued = false;
          if (again && options.canRead()) request(true);
        });
      return item.promise;
    }
    return Object.freeze({ request, cancel });
  }
  function createDiagnostics({ limit = 20, notify, now = Date.now } = {}) {
    const entries = []; let lastNotice = -Infinity;
    const allowedCodes = new Set(['stream-processing','state-refresh','script-load','script-runtime','unhandled-promise']);
    const allowedErrors = new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','EvalError','URIError','AbortError','TimeoutError','NetworkError']);
    const allowedTypes = new Set(['state', 'action', 'presence', 'backpackChanged', 'readingInvite', 'sessionRevoked', 'webrtcSignal']);
    return Object.freeze({
      report(code, error, type) {
        // Never retain messages, payloads, URLs, identities, names or tokens.
        const entry = { at: now(), code: allowedCodes.has(code) ? code : 'unknown',
          error: allowedErrors.has(error?.name) ? error.name : 'Error',
          type: allowedTypes.has(type) ? type : 'unknown' };
        entries.push(entry); if (entries.length > limit) entries.shift();
        if (entry.at - lastNotice >= 10000) { lastNotice = entry.at; notify?.(entry); }
        return entry;
      },
      snapshot: () => entries.map(entry => ({ ...entry })),
    });
  }
  const scriptJobs = new Map();
  const coverSnapshots = new WeakMap();
  function renderCover(world, map, { rules, document, host = false }) {
    let svg = world.querySelector('.map-cover-overlay');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('map-cover-overlay');
      svg.innerHTML = '<path fill-rule="evenodd"/>';
      svg.style.cssText = 'position:absolute;inset:0;z-index:90;pointer-events:none;overflow:hidden'; world.append(svg);
    }
    const signature = rules.mapCoverSignature(map), previous = coverSnapshots.get(world);
    if (!previous || previous.signature !== signature || previous.svg !== svg || previous.host !== host) {
      svg.setAttribute('width', map?.mapW || 1); svg.setAttribute('height', map?.mapH || 1);
      const shape = svg.firstChild; shape.setAttribute('d', rules.mapCoverPath(map));
      shape.setAttribute('fill', host ? 'rgba(5,10,20,.55)' : '#080b10');
      if (host) { shape.setAttribute('stroke', 'rgba(225,190,110,.55)'); shape.setAttribute('stroke-width', '1'); }
      coverSnapshots.set(world, { signature, svg, host });
    }
    return svg;
  }
  function loadScript(src, { env = globalThis, timeoutMs = 15000 } = {}) {
    if (scriptJobs.has(src)) return scriptJobs.get(src);
    const job = deadline(signal => new Promise((resolve, reject) => {
      const script = env.document.createElement('script'); let finished = false;
      const finish = error => {
        if (finished) return; finished = true;
        script.onload = script.onerror = null; signal.removeEventListener('abort', abort);
        if (error) { script.remove(); reject(error); } else resolve();
      };
      const abort = () => finish(Object.assign(new Error('动画组件加载超时，请重试'), { name: 'TimeoutError' }));
      signal.addEventListener('abort', abort, { once: true });
      script.src = src; script.onload = () => finish();
      script.onerror = () => finish(new Error('动画组件加载失败，请重试'));
      env.document.head.appendChild(script);
    }), { timeoutMs, message: '动画组件加载超时，请重试', env });
    scriptJobs.set(src, job); job.catch(() => { if (scriptJobs.get(src) === job) scriptJobs.delete(src); });
    return job;
  }
  function installLoadDiagnostics(env = globalThis) {
    if (env.SundollLoadDiagnostics) return env.SundollLoadDiagnostics;
    let pendingNotice = false;
    const show = () => {
      if (!env.document.body) { pendingNotice = true; return; }
      pendingNotice = false;
      if (env.document.getElementById('component-load-notice')) return;
      const box = env.document.createElement('aside'); box.id = 'component-load-notice'; box.setAttribute('role', 'status');
      box.style.cssText = 'position:fixed;z-index:20000;top:12px;left:50%;transform:translateX(-50%);max-width:90vw;padding:12px 16px;border:1px solid #c39b65;border-radius:12px;background:#241f19;color:#f4e7ce;font:14px system-ui;box-shadow:0 6px 24px #0007';
      box.textContent = '部分组件未能加载，请刷新重试。';
      const button = env.document.createElement('button'); button.textContent = '刷新'; button.type = 'button';
      button.style.cssText = 'margin-left:12px;padding:4px 10px;border:1px solid #c39b65;border-radius:6px;background:#3a3023;color:inherit';
      button.onclick = () => env.location.reload(); box.append(button); env.document.body.append(box);
    };
    const diagnostics = createDiagnostics({ notify: show }); env.SundollLoadDiagnostics = diagnostics;
    env.addEventListener('error', event => {
      if (event.target?.tagName === 'SCRIPT') diagnostics.report('script-load', event.error);
      else if (event.error) diagnostics.report('script-runtime', event.error);
    }, true);
    env.addEventListener('unhandledrejection', event => diagnostics.report('unhandled-promise', event.reason));
    env.document.addEventListener('DOMContentLoaded', () => { if (pendingNotice) show(); }, { once: true });
    return diagnostics;
  }
  return Object.freeze({ deadline, requestJson, createReadCoordinator, createDiagnostics, renderCover, loadScript, installLoadDiagnostics });
});
