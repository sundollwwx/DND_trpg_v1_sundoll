/* 桑哆尔 · 3D 骰子动画（three.js）
   支持一次掷多个骰子：优势/劣势掷两颗，4d6 掷四颗。
   数字面正对屏幕；D4 按“尖角”规则，每个面三个角标数字。
   用法：playDieAnimation(sides, label, total, { dice, pick, mode }) */
(function () {
  'use strict';

  // 大成功 / 大失败特效样式（一次性注入）
  if (!document.getElementById('dice-crit-style')) {
    const st = document.createElement('style');
    st.id = 'dice-crit-style';
    st.textContent = `
.dice-crit { position:fixed; left:50%; top:32%; transform:translate(-50%,-50%); z-index:250; pointer-events:none; text-align:center; }
.dice-crit .crit-icon { display:block; font-size:76px; animation:critPop .5s ease-out; }
.dice-crit .crit-text { font:italic 800 34px Didot,Georgia,serif; text-shadow:0 4px 18px rgba(0,0,0,.9); }
.dice-crit.success .crit-text { color:#ffd76a; }
.dice-crit.fail .crit-text { color:#ff6b6b; }
.dice-crit::before, .dice-crit::after { content:''; position:absolute; left:50%; top:50%; width:190px; height:190px; margin:-95px 0 0 -95px; border-radius:50%; border:4px solid; animation:critRing .75s ease-out forwards; }
.dice-crit.success::before { border-color:#ffd76a; }
.dice-crit.success::after { border-color:#fff3c4; animation-delay:.12s; }
.dice-crit.fail::before { border-color:#ff6b6b; }
.dice-crit.fail::after { border-color:#ffb0b0; animation-delay:.12s; }
@keyframes critRing { 0%{transform:scale(.25); opacity:.95;} 100%{transform:scale(1.65); opacity:0;} }
@keyframes critPop { 0%{transform:scale(.2) rotate(-20deg); opacity:0;} 60%{transform:scale(1.25) rotate(8deg); opacity:1;} 100%{transform:scale(1) rotate(0);} }
`;
    document.head.appendChild(st);
  }

  const PHI = (1 + Math.sqrt(5)) / 2;

  function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function scale(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function centroid(verts, face) {
    const c = [0, 0, 0];
    face.forEach((i) => { c[0] += verts[i][0]; c[1] += verts[i][1]; c[2] += verts[i][2]; });
    return scale(c, 1 / face.length);
  }
  function easeInOut(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function icosa() {
    const verts = [
      [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
      [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
      [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
    ].map(norm);
    const faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    return { verts, faces };
  }

  function dodeca() {
    const ic = icosa();
    const centers = ic.faces.map((f) => centroid(ic.verts, f));
    const faces = ic.verts.map((v, vi) => {
      const idxs = [];
      ic.faces.forEach((f, fi) => { if (f.indexOf(vi) >= 0) idxs.push(fi); });
      const avg = [0, 0, 0];
      idxs.forEach((i) => { avg[0] += centers[i][0]; avg[1] += centers[i][1]; avg[2] += centers[i][2]; });
      scale(avg, 1 / idxs.length);
      let ref = cross(avg, [0, 1, 0]);
      if (Math.hypot(ref[0], ref[1], ref[2]) < 1e-4) ref = cross(avg, [1, 0, 0]);
      ref = norm(ref);
      const u = norm(cross(avg, ref));
      idxs.sort((a, b) => {
        const da = sub(centers[a], avg);
        const db = sub(centers[b], avg);
        return Math.atan2(dot(da, u), dot(da, ref)) - Math.atan2(dot(db, u), dot(db, ref));
      });
      return idxs.slice();
    });
    const maxR = Math.max.apply(null, centers.map((c) => Math.hypot(c[0], c[1], c[2])));
    return { verts: centers.map((c) => scale(c, 1 / maxR)), faces };
  }

  function outwardNormals(verts, faces) {
    return faces.map((f) => {
      const a = verts[f[0]], b = verts[f[1]], c = verts[f[2]];
      let n = cross(sub(b, a), sub(c, a));
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = scale(n, 1 / l);
      if (dot(n, centroid(verts, f)) < 0) n = scale(n, -1);
      return n;
    });
  }

  function withMeta(poly) {
    poly.normals = outwardNormals(poly.verts, poly.faces);
    poly.labels = poly.faces.map((f, i) => i + 1);
    return poly;
  }

  const POLY = {
    d4: withMeta({
      verts: [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(norm),
      faces: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
    }),
    d6: withMeta({
      verts: [
        [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
        [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
      ].map(norm),
      faces: [[4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3], [5, 1, 2, 6], [3, 7, 6, 2], [0, 1, 5, 4]],
    }),
    d8: withMeta({
      verts: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
      faces: [
        [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
        [0, 3, 5], [3, 1, 5], [1, 2, 5], [2, 0, 5],
      ],
    }),
    d10: withMeta((function () {
      const mid = [];
      for (let i = 0; i < 5; i++) {
        const a = Math.PI / 2 + i * 2 * Math.PI / 5;
        mid.push([Math.cos(a), 0, Math.sin(a)]);
      }
      const verts = [[0, 1.25, 0], [0, -1.25, 0]].concat(mid).map(norm);
      const faces = [];
      for (let i = 0; i < 5; i++) {
        faces.push([0, 2 + i, 2 + ((i + 1) % 5)]);
        faces.push([1, 2 + ((i + 1) % 5), 2 + i]);
      }
      return { verts, faces };
    })()),
    d12: withMeta(dodeca()),
    d20: withMeta(icosa()),
  };

  function dieKey(sides) {
    if (sides === 100) return 'd10';
    if (sides <= 4) return 'd4';
    if (sides <= 6) return 'd6';
    if (sides <= 8) return 'd8';
    if (sides <= 10) return 'd10';
    if (sides <= 12) return 'd12';
    return 'd20';
  }

  function resultLabel(poly, total) {
    const n = poly.faces.length;
    let lab = total;
    if (lab > n) lab = ((lab - 1) % n) + 1;
    if (lab < 1) lab = 1;
    return lab;
  }

  function buildGeometry(poly) {
    const positions = [], uvs = [], groups = [];
    poly.faces.forEach((face, fi) => {
      const n = face.length;
      const center = centroid(poly.verts, face);
      const cornerUv = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        cornerUv.push([0.5 + 0.42 * Math.cos(a), 0.5 + 0.42 * Math.sin(a)]);
      }
      const start = positions.length / 3;
      for (let i = 0; i < n; i++) {
        const v0 = center;
        const v1 = poly.verts[face[i]];
        const v2 = poly.verts[face[(i + 1) % n]];
        let tri = [v0, v1, v2];
        const nrm = cross(sub(v1, v0), sub(v2, v0));
        const c = centroid(tri, [0, 1, 2]);
        const swapped = dot(nrm, c) < 0;
        if (swapped) tri = [v0, v2, v1];
        tri.forEach((v) => positions.push(v[0], v[1], v[2]));
        const u0 = [0.5, 0.5], u1 = cornerUv[i], u2 = cornerUv[(i + 1) % n];
        const uvTri = swapped ? [u0, u2, u1] : [u0, u1, u2];
        uvTri.forEach((u) => uvs.push(u[0], u[1]));
      }
      groups.push({ start, count: n * 3, materialIndex: fi });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    groups.forEach((g) => geo.addGroup(g.start, g.count, g.materialIndex));
    return geo;
  }

  // D4 专用：每个面就是完整的一个三角形，三个角对应纹理上的三个数字
  function buildD4Geometry(poly) {
    const positions = [], uvs = [], groups = [];
    const triUv = [[0.12, 0.12], [0.88, 0.12], [0.5, 0.92]];
    poly.faces.forEach((face, fi) => {
      const a = poly.verts[face[0]], b = poly.verts[face[1]], c = poly.verts[face[2]];
      let nrm = cross(sub(b, a), sub(c, a));
      const cc = centroid([a, b, c], [0, 1, 2]);
      let order = [a, b, c];
      let uvOrder = [triUv[0], triUv[1], triUv[2]];
      if (dot(nrm, cc) < 0) { order = [a, c, b]; uvOrder = [triUv[0], triUv[2], triUv[1]]; }
      const start = positions.length / 3;
      order.forEach((v) => positions.push(v[0], v[1], v[2]));
      uvOrder.forEach((u) => uvs.push(u[0], u[1]));
      groups.push({ start, count: 3, materialIndex: fi });
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    groups.forEach((g) => geo.addGroup(g.start, g.count, g.materialIndex));
    return geo;
  }

  const FANCY_FONT = 'italic 800 ${size}px Didot, "Bodoni 72", Georgia, "Times New Roman", serif';

  function faceBase(g, highlight) {
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, highlight ? '#262a33' : '#1a1d24');
    grad.addColorStop(0.5, highlight ? '#14161b' : '#0e1014');
    grad.addColorStop(1, highlight ? '#050507' : '#030304');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const sheen = g.createRadialGradient(82, 58, 8, 128, 128, 220);
    sheen.addColorStop(0, 'rgba(190,215,255,.20)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, 256, 256);
    const vignette = g.createRadialGradient(128, 128, 70, 128, 128, 170);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,.30)');
    g.fillStyle = vignette;
    g.fillRect(0, 0, 256, 256);
  }

  // 沿面轮廓描一圈金边（三角形/四边形/五边形都适用）
  function strokeFaceOutline(g, n, highlight) {
    g.strokeStyle = highlight ? 'rgba(255,215,106,.95)' : 'rgba(217,164,65,.8)';
    g.lineWidth = highlight ? 7 : 5;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = 128 + Math.cos(a) * 107;
      const y = 128 + Math.sin(a) * 107;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
  }

  function drawNum(g, num, x, y, size, highlight) {
    g.font = FANCY_FONT.replace('${size}', size);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(7, size * 0.16);
    g.strokeStyle = 'rgba(8,14,32,.95)';
    g.strokeText(String(num), x, y);
    const ng = g.createLinearGradient(0, y - size * 0.55, 0, y + size * 0.55);
    ng.addColorStop(0, highlight ? '#ffdf96' : '#ecc265');
    ng.addColorStop(0.55, highlight ? '#f0c35e' : '#d9a845');
    ng.addColorStop(1, highlight ? '#c98f2e' : '#ad7f28');
    g.fillStyle = ng;
    g.fillText(String(num), x, y);
  }

  function faceTexture(isResult, n) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    faceBase(g, isResult);
    strokeFaceOutline(g, n || 4, isResult);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.anisotropy = 4;
    return new THREE.MeshPhysicalMaterial({
      map: tex,
      metalness: 0.55,
      roughness: 0.28,
      clearcoat: 0.45,
      clearcoatRoughness: 0.25,
    });
  }

  // D4：每个面一个完整三角形（数字由 Sprite 显示，保证永不镜像）
  function d4BodyTexture(face, tipIdx) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const highlight = face.indexOf(tipIdx) >= 0;
    faceBase(g, highlight);
    const triUv = [[0.12, 0.12], [0.88, 0.12], [0.5, 0.92]];
    g.strokeStyle = highlight ? 'rgba(255,215,106,.95)' : 'rgba(217,164,65,.8)';
    g.lineWidth = highlight ? 6 : 4;
    g.beginPath();
    triUv.forEach((u, i) => {
      const px = u[0] * 256, py = u[1] * 256;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.anisotropy = 4;
    return new THREE.MeshPhysicalMaterial({
      map: tex,
      metalness: 0.55,
      roughness: 0.28,
      clearcoat: 0.45,
      clearcoatRoughness: 0.25,
    });
  }

  // 数字用 Sprite：始终面向镜头，永不镜像、永不倒置
  function makeNumSprite(text, highlight, scaleBase) {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 160, 160);
    const size = highlight ? 96 : 78;
    drawNum(g, text, 80, 82, size, highlight);
    if (text === '6' || text === '9') {
      g.fillStyle = highlight ? '#ffe9a8' : '#d9b354';
      g.fillRect(80 - size * 0.4, 82 + size * 0.52 + 6, size * 0.8, 5);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    const s = scaleBase * (highlight ? 1.22 : 1);
    sp.scale.set(s, s, 1);
    return sp;
  }

  let rafId = null;
  let cleanupTimer = null;
  let rootEl = null;
  let renderer = null;
  let disposeQueue = [];

  function cleanup() {
    if (rafId) cancelAnimationFrame(rafId);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (renderer) {
      try { renderer.dispose(); } catch (e) { /* 忽略 */ }
      renderer = null;
    }
    disposeQueue.forEach((o) => {
      try {
        if (o && o.map) o.map.dispose();
        if (o && o.dispose) o.dispose();
      } catch (e) { /* 忽略 */ }
    });
    disposeQueue = [];
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rafId = null; cleanupTimer = null; rootEl = null;
  }

  function showFallback(total, label) {
    cleanup();
    const root = document.createElement('div');
    root.className = 'dice-fx-root';
    root.style.cssText = 'position:fixed;left:50%;top:34%;transform:translate(-50%,-50%);z-index:200;pointer-events:none;text-align:center;';
    root.innerHTML = `<div style="width:240px;height:200px;display:flex;align-items:center;justify-content:center;font:italic 800 80px Didot,Georgia,serif;color:#ffe08a;text-shadow:0 4px 14px rgba(0,0,0,.8);">${total}</div>`;
    document.body.appendChild(root);
    rootEl = root;
    window.__DICE_LAST__ = { frontLabels: [total], total };
    cleanupTimer = setTimeout(cleanup, 1600);
  }

  function showCrit(root, type, text) {
    const el = document.createElement('div');
    el.className = 'dice-crit ' + type;
    el.innerHTML = `<span class="crit-icon">${type === 'success' ? '⚡' : '💥'}</span><span class="crit-text">${text}</span>`;
    root.appendChild(el);
  }

  // 多骰子团簇布局（x = 左右，z = 前后纵深）
  function clusterPos(i, N) {
    if (N === 1) return [0, 0];
    if (N === 2) return [i === 0 ? -1.05 : 1.05, 0];
    if (N <= 7) {
      if (i === 0) return [0, 0];
      const a = ((i - 1) / 6) * Math.PI * 2 + Math.PI / 6;
      return [Math.cos(a) * 1.75, Math.sin(a) * 1.35];
    }
    if (i === 0) return [0, 0];
    if (i <= 6) {
      const a = ((i - 1) / 6) * Math.PI * 2 + Math.PI / 6;
      return [Math.cos(a) * 1.75, Math.sin(a) * 1.35];
    }
    const a = ((i - 7) / 3) * Math.PI * 2 + Math.PI / 6;
    return [Math.cos(a) * 2.9, Math.sin(a) * 2.2];
  }

  const SPRITE_SCALE = { d4: 0.30, d6: 0.52, d8: 0.46, d10: 0.44, d12: 0.38, d20: 0.32 };

  function playDieAnimation(sides, label, total, opts) {
    if (!window.THREE) { showFallback(total, label); return; }
    opts = opts || {};
    const key = dieKey(sides || 20);
    const poly = POLY[key] || POLY.d20;
    const isD4 = key === 'd4';
    const rawDice = Array.isArray(opts.dice) && opts.dice.length
      ? opts.dice.map((v) => Math.max(1, Math.round(v) || 1))
      : [Math.max(1, Math.round(total) || 1)];
    const mode = opts.mode || 0;
    const pick = (mode === 1 || mode === -1) ? (opts.pick === 0 || opts.pick === 1 ? opts.pick : 0) : null;
    // 每颗骰子要显示的内容：d100 拆成「十位 + 个位」两颗骰子
    let display;
    if (sides === 100) {
      display = [];
      rawDice.forEach((v) => {
        const tens = Math.floor(v / 10) % 10;
        const ones = v % 10;
        display.push({ faceIdx: tens + 1, text: String(tens * 10).padStart(2, '0') });
        display.push({ faceIdx: ones + 1, text: String(ones) });
      });
    } else {
      display = rawDice.map((v) => ({ faceIdx: resultLabel(poly, v), text: String(v) }));
    }
    const N = Math.min(10, display.length);
    display = display.slice(0, N);

    let rendererTest = null;
    try { rendererTest = new THREE.WebGLRenderer({ antialias: true }); rendererTest.dispose(); }
    catch (e) { rendererTest = null; }
    if (!rendererTest) { showFallback(total, label); return; }

    cleanup();
    const root = document.createElement('div');
    root.className = 'dice-fx-root';
    root.style.cssText = 'position:fixed;left:50%;top:32%;transform:translate(-50%,-50%);z-index:200;pointer-events:none;text-align:center;';
    const holder = document.createElement('div');
    holder.style.cssText = 'position:relative;width:400px;height:340px;margin:0 auto;';
    const glow = document.createElement('div');
    glow.style.cssText = 'position:absolute;left:50%;top:50%;width:340px;height:300px;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;background:radial-gradient(circle, rgba(34,60,130,.32), rgba(210,165,80,.09) 52%, rgba(0,0,0,0) 72%);';
    holder.appendChild(glow);
    const resultDiv = document.createElement('div');
    resultDiv.style.cssText = 'font:italic 700 20px Didot,Georgia,serif;color:#ffd76a;text-shadow:0 2px 8px rgba(0,0,0,.85);opacity:0;transition:opacity .25s;margin-top:2px;';
    root.appendChild(holder);
    root.appendChild(resultDiv);
    document.body.appendChild(root);
    rootEl = root;

    const canvasW = Math.min(960, 400 + Math.max(0, N - 1) * 72);
    const canvasH = Math.min(540, 340 + Math.max(0, N - 5) * 52);
    holder.style.width = canvasW + 'px';
    holder.style.height = canvasH + 'px';
    const glowSize = Math.min(canvasW, canvasH) * 0.92;
    glow.style.width = glowSize + 'px';
    glow.style.height = glowSize + 'px';
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(canvasW, canvasH);
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputEncoding = THREE.sRGBEncoding;
    holder.appendChild(renderer.domElement);

    const camDist = 1 + Math.max(0, N - 6) * 0.06;
    const camera = new THREE.PerspectiveCamera(32, canvasW / canvasH, 0.1, 50);
    if (isD4) {
      // D4：俯视镜头，尖角朝上时能看到经典的三面环绕
      camera.position.set(0.9 * camDist, 5.6 * camDist, 2.2 * camDist);
      camera.lookAt(0, 1.0, 0);
    } else {
      camera.position.set(3.8 * camDist, 4.8 * camDist, 5.6 * camDist);
      camera.lookAt(0, 0.9, 0);
    }

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xcfdcff, 0x141a2a, 0.7));
    const sun = new THREE.DirectionalLight(0xeaf0ff, 1.25);
    sun.position.set(4, 8, 5);
    scene.add(sun);
    const rimLight = new THREE.PointLight(0xd8a94c, 0.8, 18);
    rimLight.position.set(-3.8, 2.6, -2.8);
    scene.add(rimLight);
    const fill = new THREE.PointLight(0x7fa8ff, 0.25, 15);
    fill.position.set(-2, 1.5, 4);
    scene.add(fill);

    // 柔软接触阴影
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 64;
    const sg = shadowCanvas.getContext('2d');
    const sgRad = sg.createRadialGradient(64, 32, 4, 64, 32, 56);
    sgRad.addColorStop(0, 'rgba(0,0,0,.5)');
    sgRad.addColorStop(0.7, 'rgba(0,0,0,.25)');
    sgRad.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = sgRad;
    sg.fillRect(0, 0, 128, 64);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    disposeQueue.push(shadowTex);

    const geo = isD4 ? buildD4Geometry(poly) : buildGeometry(poly);
    disposeQueue.push(geo);
    let restY = geo.boundingSphere ? geo.boundingSphere.radius : 1.05;
    if (isD4) {
      // D4 尖角朝上时是“底面着地”：中心高度 = 内切球半径（外接球半径的 1/3）
      restY = restY / 3;
      camera.lookAt(0, restY, 0);
    }
    const dieCenter = new THREE.Vector3(0, restY, 0);
    const viewDir = new THREE.Vector3().subVectors(camera.position, dieCenter).normalize();
    const perScale = N === 1 ? 1 : N <= 2 ? 0.98 : N <= 4 ? 0.92 : N <= 6 ? 0.85 : N <= 8 ? 0.8 : 0.75;
    const layout = display.map((d, i) => clusterPos(i, N));

    const diceData = display.map((d, i) => {
      const res = d.faceIdx;
      // 每颗骰子每个面的文字：普通骰 1..N；d100 十位骰 00/10/…90、个位骰 0-9
      const faceTexts = sides === 100
        ? (i % 2 === 0
          ? poly.labels.map((lab, fi) => String((fi) * 10).padStart(2, '0'))
          : poly.labels.map((lab, fi) => String(fi)))
        : poly.labels.map((lab) => String(lab));
      let alignVec, targetVec;
      if (isD4) {
        const v = poly.verts[res - 1];
        alignVec = new THREE.Vector3(v[0], v[1], v[2]).normalize();
        // 真 D4：尖角朝上，骰子立在底面上
        targetVec = new THREE.Vector3(0, 1, 0);
      } else {
        const n = poly.normals[res - 1];
        alignVec = new THREE.Vector3(n[0], n[1], n[2]);
        targetVec = viewDir;
      }
      let mats;
      if (isD4) {
        mats = poly.faces.map((f) => d4BodyTexture(f, res - 1));
      } else {
        mats = poly.faces.map((f, fi) => faceTexture(fi === res - 1, f.length));
      }
      mats.forEach((m) => disposeQueue.push(m));
      const mesh = new THREE.Mesh(geo, mats);
      const pos = layout[i];
      mesh.position.set(pos[0], restY, pos[1]);
      mesh.scale.setScalar(perScale);
      scene.add(mesh);
      // 数字 Sprite：始终面向镜头
      let numSprites = 0;
      const faceSprites = [];
      if (isD4) {
        poly.faces.forEach((f, fi) => {
          const fc = centroid(poly.verts, f);
          f.forEach((vi) => {
            const isTip = vi === res - 1;
            const vd = poly.verts[vi];
            // 数字收在面内：从角向面心收 0.38，再沿面法线抬离表面
            const facePt = norm([vd[0] * 0.62 + fc[0] * 0.38, vd[1] * 0.62 + fc[1] * 0.38, vd[2] * 0.62 + fc[2] * 0.38]);
            const n = poly.normals[fi];
            const sp = makeNumSprite(String(vi + 1), isTip, isTip ? 0.34 : 0.26);
            sp.position.set(facePt[0] * 0.97 + n[0] * 0.06, facePt[1] * 0.97 + n[1] * 0.06, facePt[2] * 0.97 + n[2] * 0.06);
            sp.userData.nLocal = new THREE.Vector3(n[0], n[1], n[2]);
            mesh.add(sp);
            disposeQueue.push(sp.material);
            faceSprites.push(sp);
            numSprites++;
          });
        });
      } else {
        poly.faces.forEach((f, fi) => {
          const c = centroid(poly.verts, f);
          const dir = norm(c);
          const n = poly.normals[fi];
          const sp = makeNumSprite(faceTexts[fi], fi === res - 1, SPRITE_SCALE[key] || 0.4);
          sp.position.set(dir[0] * 0.97 + n[0] * 0.06, dir[1] * 0.97 + n[1] * 0.06, dir[2] * 0.97 + n[2] * 0.06);
          sp.userData.nLocal = new THREE.Vector3(n[0], n[1], n[2]);
          mesh.add(sp);
          disposeQueue.push(sp.material);
          faceSprites.push(sp);
          numSprites++;
        });
      }
      const shadowBlob = new THREE.Mesh(
        new THREE.PlaneGeometry(2.5 * perScale, 1.0 * perScale),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
      );
      shadowBlob.rotation.x = -Math.PI / 2;
      shadowBlob.position.y = 0.02;
      shadowBlob.position.x = pos[0];
      shadowBlob.position.z = pos[1];
      scene.add(shadowBlob);
      disposeQueue.push(shadowBlob.material);
      return {
        mesh,
        shadowBlob,
        res,
        text: d.text,
        faceTexts,
        numSprites,
        sprites: faceSprites,
        opacity: mats[0] ? mats[0].opacity : 1,
        qFinal: new THREE.Quaternion().setFromUnitVectors(alignVec, targetVec),
        qStart: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)
        ),
        spin: (0.8 + Math.random() * 1.2) * Math.PI * 2,
        baseX: pos[0],
        baseZ: pos[1],
      };
    });
    const upAxis = new THREE.Vector3(0, 1, 0);

    const t0 = performance.now();
    const dur = 1600;
    const K1 = 0.62;
    const K2 = 0.82;

    function frame(now) {
      const k = Math.min(1, (now - t0) / dur);
      const rollE = easeOut(Math.min(1, k / K1));
      const dx = -3.6 * (1 - rollE);
      let hop = 0.55 * Math.sin(Math.min(1, k / 0.5) * Math.PI);
      let sc = 0.92 + 0.08 * easeOut(Math.min(1, k / K2));
      if (k > K1) {
        const b = (k - K1) / (K2 - K1);
        hop += 0.26 * Math.sin(b * Math.PI) * (1 - b);
        sc += 0.04 * Math.sin(b * Math.PI) * (1 - b);
      }
      const e = easeInOut(Math.min(1, k / K2));
      diceData.forEach((d) => {
        d.mesh.position.set(d.baseX + dx, restY + hop, d.baseZ);
        d.mesh.scale.setScalar(perScale * sc);
        const q = d.qStart.clone().slerp(d.qFinal, e);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(upAxis, d.spin * (1 - e)));
        d.mesh.quaternion.copy(q);
        // 只显示当前朝向镜头的面：数字只在“你看得到的面”上出现
        d.sprites.forEach((sp) => {
          const nw = sp.userData.nLocal.clone().applyQuaternion(q);
          sp.visible = nw.dot(viewDir) > 0.22;
        });
        d.shadowBlob.position.x = d.baseX + dx;
        const shadowS = Math.max(0.5, 1 - hop * 0.55) * perScale;
        d.shadowBlob.scale.setScalar(shadowS);
        d.shadowBlob.material.opacity = Math.max(0.18, 0.5 - hop * 0.22);
      });
      renderer.render(scene, camera);
      if (k < 1) {
        rafId = requestAnimationFrame(frame);
      } else {
        window.__DICE_LAST__ = {
          frontLabels: diceData.map((d) => d.res),
          labels: diceData.map((d) => d.text),
          faceTexts: diceData[0] ? diceData[0].faceTexts : [],
          opacities: diceData.map((d) => d.opacity),
          diceScale: perScale,
          numSprites: diceData.reduce((s, d) => s + d.numSprites, 0),
          visibleSprites: diceData.reduce((s, d) => s + d.sprites.filter((sp) => sp.visible).length, 0),
          canvasSize: [canvasW, canvasH],
          layout: layout.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
          total,
          pick,
          N,
          crit: (sides === 20 && rawDice.length) ? (rawDice[0] === 20 ? 'success' : rawDice[0] === 1 ? 'fail' : null) : null,
        };
        if (isD4) {
          const r0 = diceData[0].res;
          const v = new THREE.Vector3(poly.verts[r0 - 1][0], poly.verts[r0 - 1][1], poly.verts[r0 - 1][2]).normalize();
          window.__DICE_LAST__.apexUpScore = v.applyQuaternion(diceData[0].qFinal).y;
        }
        if (isD4) {
          window.__DICE_LAST__.d4Corners = POLY.d4.faces.map((f) => f.map((vi) => vi + 1));
          window.__DICE_LAST__.d4Faces = POLY.d4.faces.map((f) => f.slice());
        }
        let text = `${label || '掷骰'} → ${total}`;
        if (sides === 100) text += `（${diceData.map((d) => d.text).join(' + ')}）`;
        else if (mode !== 0) text += `（两次 ${diceData.map((d) => d.text).join(' / ')}）`;
        else if (N > 1) text += `（${diceData.map((d) => d.text).join(' + ')}）`;
        if (window.__DICE_LAST__.crit === 'success') {
          showCrit(root, 'success', '大成功！');
          text = '⚡ 大成功！' + text;
        } else if (window.__DICE_LAST__.crit === 'fail') {
          showCrit(root, 'fail', '大失败！');
          text = '💥 大失败！' + text;
        }
        resultDiv.textContent = text;
        resultDiv.style.opacity = '1';
        cleanupTimer = setTimeout(cleanup, 1900);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  window.playDieAnimation = playDieAnimation;
  window.__DICE_POLY__ = POLY;
  window.__DICE_LAST__ = null;
})();
