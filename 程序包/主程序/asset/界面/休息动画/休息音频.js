(function (global) {
  'use strict';
  let context = null, active = null;
  const buffers = new Map();
  const level = (value) => Math.max(0, Math.min(1, Number(value) || 0));

  function audioContext() {
    const Constructor = global.AudioContext || global.webkitAudioContext;
    if (!context && Constructor) context = new Constructor();
    return context;
  }

  async function unlock() {
    try {
      const ctx = audioContext();
      if (!ctx) return false;
      if (ctx.state !== 'running') await ctx.resume();
      return ctx.state === 'running';
    } catch (error) { return false; }
  }

  function load(scene) {
    if (!scene?.audio) return Promise.reject(new Error('缺少休息音频'));
    if (!buffers.has(scene.audio)) {
      const pending = (async () => {
        const ctx = audioContext();
        if (!ctx) throw new Error('浏览器不支持休息音频');
        const response = await fetch(scene.audio, { cache: 'force-cache' });
        if (!response.ok) throw new Error('休息音频加载失败');
        return ctx.decodeAudioData(await response.arrayBuffer());
      })();
      buffers.set(scene.audio, pending);
      pending.catch(() => { if (buffers.get(scene.audio) === pending) buffers.delete(scene.audio); });
    }
    return buffers.get(scene.audio);
  }

  function stop() {
    const previous = active;
    active = null;
    if (!previous) return;
    clearTimeout(previous.timer);
    clearInterval(previous.tick);
    if (previous.source) {
      previous.source.onended = null;
      try { previous.source.stop(); } catch (error) { /* 已自然结束 */ }
      previous.source.disconnect();
      previous.gain.disconnect();
    }
    for (const [audio, volume] of previous.ducked) {
      audio.volume = previous.options.backgroundVolume ? level(previous.options.backgroundVolume()) : volume;
    }
  }

  async function play(scene, duration, options = {}) {
    stop();
    if (!scene?.audio) return false;
    const ms = Math.max(100, Math.min(8000, Number(duration) || 2200));
    const run = { options, started: performance.now(), ducked: new Map(), source: null, tick: null };
    active = run;
    run.timer = setTimeout(() => { if (active === run) stop(); }, ms);
    try {
      // Resume is called immediately inside the host's click handler when possible.
      const permission = unlock();
      const pending = load(scene);
      const [allowed, buffer] = await Promise.all([permission, pending]);
      if (active !== run) return false;
      if (!allowed) {
        stop();
        options.onBlocked?.();
        return false;
      }
      const elapsed = (performance.now() - run.started) / 1000;
      const remaining = Math.min(ms / 1000, buffer.duration) - elapsed;
      if (remaining <= .04) { stop(); return false; }
      const ctx = audioContext(), source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = buffer;
      source.loop = false;
      source.connect(gain); gain.connect(ctx.destination);
      run.source = source; run.gain = gain;
      const end = run.started + ms;
      const update = () => {
        if (active !== run) return;
        const now = performance.now();
        const fade = Math.min(1, (now - run.started) / 60, Math.max(0, end - now) / Math.min(400, ms * .25));
        gain.gain.setTargetAtTime(level(options.volume ? options.volume() : .7) * Math.max(0, fade), ctx.currentTime, .02);
        for (const audio of options.backgrounds?.() || []) {
          if (!audio) continue;
          if (!run.ducked.has(audio)) run.ducked.set(audio, audio.volume);
          const original = options.backgroundVolume ? level(options.backgroundVolume()) : run.ducked.get(audio);
          audio.volume = original * (1 - .78 * Math.max(0, fade));
        }
      };
      source.onended = () => { if (active === run) stop(); };
      update(); run.tick = setInterval(update, 30);
      source.start(0, elapsed, remaining);
      return true;
    } catch (error) {
      if (active === run) { stop(); options.onError?.(error); }
      return false;
    }
  }

  function preload() {
    for (const scene of Object.values(global.SundollRestScenes?.SCENES || {})) load(scene).catch(() => {});
  }
  global.SundollRestAudio = Object.freeze({ play, stop, unlock, preload });
  // A gesture unlocks later transient player events; expired rests are never replayed.
  global.addEventListener('pointerdown', unlock, { passive: true });
  global.addEventListener('keydown', unlock, { passive: true });
  global.addEventListener('pagehide', stop);
  // play() loads only the requested scene; keep startup bandwidth for the map.
})(window);
