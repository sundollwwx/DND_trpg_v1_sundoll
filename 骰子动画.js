/* 桑哆尔 · 全地图 3D 骰子动画（three.js）
   支持多骰、优势/劣势、天然 1/20；轻量物理积分负责滚动与碰撞，
   最后再把预先生成的逻辑结果平滑校准为真实朝上的落面。 */
(function () {
  'use strict';

  // 大成功 / 大失败特效样式（一次性注入）
  if (!document.getElementById('dice-crit-style')) {
    const st = document.createElement('style');
    st.id = 'dice-crit-style';
    st.textContent = `
.dice-fx-root { position:fixed; z-index:200; overflow:hidden; pointer-events:none; contain:layout paint; }
.dice-fx-root canvas { position:absolute; inset:0; width:100%; height:100%; filter:drop-shadow(0 8px 12px rgba(0,0,0,.28)); }
.dice-result-card { position:absolute; left:50%; bottom:18px; transform:translateX(-50%) translateY(8px); z-index:3; min-width:190px; max-width:min(680px,calc(100% - 28px)); padding:9px 16px 10px; border:1px solid var(--dice-accent-soft,rgba(255,218,130,.5)); border-radius:13px; background:linear-gradient(180deg,rgba(18,23,34,.93),rgba(7,9,15,.92)); color:var(--dice-accent,#ffe08a); font:italic 700 19px Didot,Georgia,serif; line-height:1.3; text-align:center; text-shadow:0 2px 8px rgba(0,0,0,.85); box-shadow:0 12px 36px rgba(0,0,0,.45),inset 0 1px rgba(255,255,255,.09); opacity:0; transition:opacity .24s,transform .28s cubic-bezier(.2,.8,.2,1); backdrop-filter:blur(7px); }
.dice-result-card.show { opacity:1; transform:translateX(-50%) translateY(0); }
.dice-result-card small { display:block; margin-top:2px; color:#b7c4dc; font:600 11px system-ui,sans-serif; font-style:normal; }
.dice-crit { position:absolute; left:50%; top:35%; transform:translate(-50%,-50%); z-index:4; pointer-events:none; text-align:center; }
.dice-crit .crit-icon { display:block; font-size:76px; animation:critPop .5s ease-out; }
.dice-crit .crit-text { font:italic 800 34px Didot,Georgia,serif; text-shadow:0 4px 18px rgba(0,0,0,.9); }
.dice-crit.success .crit-text { color:#ffd76a; }
.dice-crit.fail .crit-text { color:#ff6b6b; }
.dice-crit::before, .dice-crit::after { content:''; position:absolute; left:50%; top:50%; width:190px; height:190px; margin:-95px 0 0 -95px; border-radius:50%; border:4px solid; animation:critRing .75s ease-out forwards; }
.dice-crit.success::before { border-color:#ffd76a; }
.dice-crit.success::after { border-color:#fff3c4; animation-delay:.12s; }
.dice-crit.fail::before { border-color:#ff6b6b; }
.dice-crit.fail::after { border-color:#ffb0b0; animation-delay:.12s; }
.dice-skin-picker { display:grid; grid-template-columns:auto minmax(0,1fr) 20px; align-items:center; gap:7px; margin-top:6px; padding:5px 7px; border:1px solid rgba(128,145,176,.25); border-radius:8px; background:rgba(12,16,24,.48); }
.dice-skin-picker > span { color:#929eb4; font:600 10px system-ui,sans-serif; white-space:nowrap; }
.dice-skin-picker select { min-width:0; width:100%; height:27px; padding:2px 24px 2px 7px; border:1px solid rgba(128,145,176,.28); border-radius:6px; outline:none; background:#171c27; color:#e7ebf3; font:600 11px system-ui,sans-serif; }
.dice-skin-picker select:focus { border-color:var(--skin-accent,#e0b34c); box-shadow:0 0 0 2px color-mix(in srgb,var(--skin-accent,#e0b34c) 22%,transparent); }
.dice-skin-swatch { width:18px; height:18px; border:1px solid rgba(255,255,255,.24); border-radius:50%; background:linear-gradient(135deg,var(--skin-face,#151923) 0 48%,var(--skin-accent,#e0b34c) 52% 100%); box-shadow:0 2px 8px rgba(0,0,0,.38); }
@keyframes critRing { 0%{transform:scale(.25); opacity:.95;} 100%{transform:scale(1.65); opacity:0;} }
@keyframes critPop { 0%{transform:scale(.2) rotate(-20deg); opacity:0;} 60%{transform:scale(1.25) rotate(8deg); opacity:1;} 100%{transform:scale(1) rotate(0);} }
@media (prefers-reduced-motion:reduce) { .dice-crit .crit-icon,.dice-crit::before,.dice-crit::after { animation-duration:.16s; } .dice-result-card { transition-duration:.1s; } }
`;
    document.head.appendChild(st);
  }

  const PHI = (1 + Math.sqrt(5)) / 2;
  const DICE_SKIN_STORAGE_KEY = 'sundoll-dice-skin-v1';
  const DICE_SIZE_MULTIPLIER = 1.45;
  const DICE_SKINS = Object.freeze({
    obsidian: {
      key: 'obsidian', label: '黑曜金', swatch: '#11151d', accent: '#ffe08a', accentSoft: 'rgba(255,224,138,.55)',
      face: ['#1a1d24', '#0e1014', '#030304'], faceHighlight: ['#303640', '#171a20', '#050507'],
      sheen: 'rgba(190,215,255,.20)', edge: '#d9a441', edgeHighlight: '#ffe08a',
      number: ['#ecc265', '#d9a845', '#ad7f28'], numberHighlight: ['#ffdf96', '#f0c35e', '#c98f2e'], numberStroke: 'rgba(8,14,32,.95)',
      metalness: .55, roughness: .28, clearcoat: .45, rimLight: 0xe0ad4e, fillLight: 0x78a7ff,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(32,62,130,.18),rgba(210,165,80,.06) 48%,rgba(0,0,0,0) 76%)',
    },
    dragon: {
      key: 'dragon', label: '龙血赤铜', swatch: '#3b0d12', accent: '#ffb36d', accentSoft: 'rgba(255,179,109,.55)',
      face: ['#42171b', '#24090d', '#090203'], faceHighlight: ['#6a2529', '#351014', '#100304'],
      sheen: 'rgba(255,153,112,.23)', edge: '#c66b3e', edgeHighlight: '#ffc184',
      number: ['#ffc28d', '#e58a51', '#a9472c'], numberHighlight: ['#ffe2bd', '#ffb46f', '#d86b3d'], numberStroke: 'rgba(38,3,7,.96)',
      metalness: .5, roughness: .3, clearcoat: .42, rimLight: 0xff713f, fillLight: 0xffb06e,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(153,28,37,.22),rgba(215,91,44,.08) 48%,rgba(0,0,0,0) 76%)',
    },
    arcane: {
      key: 'arcane', label: '秘法星蓝', swatch: '#071b3d', accent: '#91ddff', accentSoft: 'rgba(145,221,255,.55)',
      face: ['#16325a', '#08172f', '#020711'], faceHighlight: ['#24558a', '#102846', '#040b18'],
      sheen: 'rgba(133,219,255,.25)', edge: '#55bce9', edgeHighlight: '#b7ecff',
      number: ['#b5e9ff', '#6fc7ec', '#3586b9'], numberHighlight: ['#e2f7ff', '#9ae2ff', '#51addd'], numberStroke: 'rgba(2,15,39,.96)',
      metalness: .48, roughness: .24, clearcoat: .58, rimLight: 0x4fc8ff, fillLight: 0x6e78ff,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(40,103,216,.24),rgba(71,200,255,.08) 48%,rgba(0,0,0,0) 76%)',
    },
    jade: {
      key: 'jade', label: '翡翠森语', swatch: '#092b23', accent: '#8ce5bd', accentSoft: 'rgba(140,229,189,.52)',
      face: ['#17483a', '#08271f', '#020d0a'], faceHighlight: ['#256b55', '#0e3a2f', '#041611'],
      sheen: 'rgba(151,255,218,.22)', edge: '#52bd91', edgeHighlight: '#b0f2d6',
      number: ['#b1efd4', '#72cca5', '#35886b'], numberHighlight: ['#e0fff1', '#9ce7c5', '#55ae89'], numberStroke: 'rgba(2,27,21,.96)',
      metalness: .38, roughness: .3, clearcoat: .62, rimLight: 0x50d09a, fillLight: 0x7ec5ff,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(28,133,97,.22),rgba(83,202,150,.07) 48%,rgba(0,0,0,0) 76%)',
    },
    royal: {
      key: 'royal', label: '皇家紫晶', swatch: '#241039', accent: '#d8b2ff', accentSoft: 'rgba(216,178,255,.54)',
      face: ['#3a2354', '#1b0d2e', '#07030d'], faceHighlight: ['#5a367b', '#2c1647', '#0e0618'],
      sheen: 'rgba(222,184,255,.24)', edge: '#a976df', edgeHighlight: '#ead3ff',
      number: ['#e0c2ff', '#bb8ce7', '#7a4aa6'], numberHighlight: ['#f6ebff', '#d8b0ff', '#a66ed2'], numberStroke: 'rgba(24,5,42,.96)',
      metalness: .46, roughness: .26, clearcoat: .56, rimLight: 0xc080ff, fillLight: 0x698dff,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(112,51,182,.24),rgba(188,112,255,.08) 48%,rgba(0,0,0,0) 76%)',
    },
    ivory: {
      key: 'ivory', label: '古典象牙', swatch: '#dfd0ac', accent: '#7b4d20', accentSoft: 'rgba(123,77,32,.5)',
      face: ['#efe3c6', '#c8b996', '#776b53'], faceHighlight: ['#fff8e8', '#ded0ad', '#8f7d5d'],
      sheen: 'rgba(255,255,255,.38)', edge: '#8c5a28', edgeHighlight: '#c58a3e',
      number: ['#55351d', '#382113', '#1e1009'], numberHighlight: ['#75461f', '#4a2a13', '#251107'], numberStroke: 'rgba(255,246,221,.92)',
      metalness: .2, roughness: .36, clearcoat: .62, rimLight: 0xe0a85f, fillLight: 0xbfd9ff,
      glow: 'radial-gradient(ellipse at 50% 55%,rgba(238,212,157,.18),rgba(153,101,47,.06) 48%,rgba(0,0,0,0) 76%)',
    },
  });
  let activeSkinKey = 'obsidian';
  try {
    const savedSkin = localStorage.getItem(DICE_SKIN_STORAGE_KEY);
    if (savedSkin && DICE_SKINS[savedSkin]) activeSkinKey = savedSkin;
  } catch (e) { /* 浏览器禁用本地存储时使用默认皮肤 */ }

  function resolveDiceSkin(key) { return DICE_SKINS[key] || DICE_SKINS[activeSkinKey] || DICE_SKINS.obsidian; }

  function syncSkinPicker(picker, skin) {
    const select = picker.querySelector('select');
    if (select) select.value = skin.key;
    picker.style.setProperty('--skin-face', skin.swatch);
    picker.style.setProperty('--skin-accent', skin.accent);
  }

  function setDiceSkin(key, persist) {
    const skin = DICE_SKINS[key] || DICE_SKINS.obsidian;
    activeSkinKey = skin.key;
    if (persist !== false) {
      try { localStorage.setItem(DICE_SKIN_STORAGE_KEY, activeSkinKey); } catch (e) { /* 忽略 */ }
    }
    document.querySelectorAll('.dice-skin-picker').forEach((picker) => syncSkinPicker(picker, skin));
    return skin.key;
  }

  function installDiceSkinPickers() {
    document.querySelectorAll('.dice-grid').forEach((grid) => {
      if (grid.nextElementSibling && grid.nextElementSibling.classList.contains('dice-skin-picker')) return;
      const picker = document.createElement('label');
      picker.className = 'dice-skin-picker';
      const title = document.createElement('span');
      title.textContent = '骰子皮肤';
      const select = document.createElement('select');
      select.setAttribute('aria-label', '骰子皮肤');
      Object.values(DICE_SKINS).forEach((skin) => {
        const option = document.createElement('option');
        option.value = skin.key;
        option.textContent = skin.label;
        select.appendChild(option);
      });
      const swatch = document.createElement('i');
      swatch.className = 'dice-skin-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      picker.append(title, select, swatch);
      grid.insertAdjacentElement('afterend', picker);
      select.addEventListener('change', () => setDiceSkin(select.value, true));
      syncSkinPicker(picker, resolveDiceSkin(activeSkinKey));
    });
  }

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
  function clampNumber(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }

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

  function faceBase(g, highlight, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const faceColors = highlight ? skin.faceHighlight : skin.face;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, faceColors[0]);
    grad.addColorStop(0.5, faceColors[1]);
    grad.addColorStop(1, faceColors[2]);
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const sheen = g.createRadialGradient(82, 58, 8, 128, 128, 220);
    sheen.addColorStop(0, skin.sheen);
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, 256, 256);
    const vignette = g.createRadialGradient(128, 128, 70, 128, 128, 170);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,.30)');
    g.fillStyle = vignette;
    g.fillRect(0, 0, 256, 256);
  }

  // 沿面轮廓描一圈皮肤强调色（三角形/四边形/五边形都适用）
  function strokeFaceOutline(g, n, highlight, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    g.save();
    g.globalAlpha = highlight ? .96 : .82;
    g.strokeStyle = highlight ? skin.edgeHighlight : skin.edge;
    g.lineWidth = highlight ? 7 : 5;
    g.lineJoin = 'round';
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
    g.restore();
  }

  function drawNum(g, num, x, y, size, highlight, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const numberColors = highlight ? skin.numberHighlight : skin.number;
    g.font = FANCY_FONT.replace('${size}', size);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(7, size * 0.16);
    g.strokeStyle = skin.numberStroke;
    g.strokeText(String(num), x, y);
    const ng = g.createLinearGradient(0, y - size * 0.55, 0, y + size * 0.55);
    ng.addColorStop(0, numberColors[0]);
    ng.addColorStop(0.55, numberColors[1]);
    ng.addColorStop(1, numberColors[2]);
    g.fillStyle = ng;
    g.fillText(String(num), x, y);
  }

  function faceTexture(isResult, n, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    faceBase(g, isResult, skin);
    strokeFaceOutline(g, n || 4, isResult, skin);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.anisotropy = 4;
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    return new THREE.MeshPhysicalMaterial({
      map: tex,
      metalness: skin.metalness,
      roughness: skin.roughness,
      clearcoat: skin.clearcoat,
      clearcoatRoughness: 0.25,
    });
  }

  // D4：每个面一个完整三角形（数字由 Sprite 显示，保证永不镜像）
  function d4BodyTexture(face, tipIdx, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const highlight = face.indexOf(tipIdx) >= 0;
    faceBase(g, highlight, skin);
    const triUv = [[0.12, 0.12], [0.88, 0.12], [0.5, 0.92]];
    g.save();
    g.globalAlpha = highlight ? .96 : .82;
    g.strokeStyle = highlight ? skin.edgeHighlight : skin.edge;
    g.lineWidth = highlight ? 6 : 4;
    g.beginPath();
    triUv.forEach((u, i) => {
      const px = u[0] * 256, py = u[1] * 256;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.stroke();
    g.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.anisotropy = 4;
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    return new THREE.MeshPhysicalMaterial({
      map: tex,
      metalness: skin.metalness,
      roughness: skin.roughness,
      clearcoat: skin.clearcoat,
      clearcoatRoughness: 0.25,
    });
  }

  // 数字用 Sprite：始终面向镜头，永不镜像、永不倒置
  function makeNumSprite(text, highlight, scaleBase, materialCache, dimmed, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const cacheKey = `${skin.key}|${text}|${highlight ? 1 : 0}|${dimmed ? 1 : 0}`;
    let mat = materialCache && materialCache.get(cacheKey);
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 192, 192);
      const size = highlight ? 108 : 88;
      drawNum(g, text, 96, 98, size, highlight, skin);
      if (text === '6' || text === '9') {
        g.fillStyle = (highlight ? skin.numberHighlight : skin.number)[1];
        g.fillRect(96 - size * 0.4, 98 + size * 0.52 + 6, size * 0.8, 5);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: dimmed ? .38 : 1 });
      if (materialCache) materialCache.set(cacheKey, mat);
      disposeQueue.push(mat);
    }
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

  function applySkinTheme(root, skin) {
    root.dataset.diceSkin = skin.key;
    root.style.setProperty('--dice-accent', skin.accent);
    root.style.setProperty('--dice-accent-soft', skin.accentSoft);
  }

  function showFallback(total, label, opts) {
    cleanup();
    opts = opts || {};
    const skin = resolveDiceSkin(opts.skin);
    const board = document.getElementById('board');
    const rect = board ? board.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const root = document.createElement('div');
    root.className = 'dice-fx-root';
    root.style.cssText = `left:${Math.max(0,rect.left)}px;top:${Math.max(0,rect.top)}px;width:${Math.max(220,rect.width)}px;height:${Math.max(180,rect.height)}px;`;
    applySkinTheme(root, skin);
    const totalEl = document.createElement('div');
    totalEl.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:italic 800 96px Didot,Georgia,serif;color:${skin.accent};text-shadow:0 4px 14px rgba(0,0,0,.8);`;
    totalEl.textContent = total;
    const resultEl = document.createElement('div');
    resultEl.className = 'dice-result-card show';
    resultEl.textContent = `${label || '掷骰'} → ${total}`;
    root.append(totalEl, resultEl);
    document.body.appendChild(root);
    rootEl = root;
    if (opts.critical === 'success') showCrit(root, 'success', '大成功！');
    else if (opts.critical === 'fail') showCrit(root, 'fail', '大失败！');
    window.__DICE_LAST__ = { frontLabels: [total], topLabels: [String(total)], topScores: [1], faceLockPassed: true, total, natural: opts.natural ?? null, crit: opts.critical || null, fallback: true, skin: skin.key };
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
    const columns = 4;
    const rows = Math.ceil(N / columns);
    const row = Math.floor(i / columns);
    const rowStart = row * columns;
    const rowCount = Math.min(columns, N - rowStart);
    const column = i - rowStart;
    const stagger = rowCount === columns && row % 2 ? .12 : 0;
    return [(column - (rowCount - 1) / 2) * 1.52 + stagger, (row - (rows - 1) / 2) * 1.46];
  }

  const SPRITE_SCALE = { d4: 0.30, d6: 0.52, d8: 0.46, d10: 0.44, d12: 0.38, d20: 0.32 };

  function playDieAnimation(sides, label, total, opts) {
    opts = opts || {};
    if (!window.THREE) { showFallback(total, label, opts); return; }
    const skin = resolveDiceSkin(opts.skin);
    const key = dieKey(sides || 20);
    const poly = POLY[key] || POLY.d20;
    const isD4 = key === 'd4';
    const rawDice = Array.isArray(opts.dice) && opts.dice.length
      ? opts.dice.map((v) => Math.max(1, Math.round(v) || 1))
      : [Math.max(1, Math.round(total) || 1)];
    const mode = opts.mode === 1 || opts.mode === -1 ? opts.mode : 0;
    const pick = (mode === 1 || mode === -1) ? (opts.pick === 0 || opts.pick === 1 ? opts.pick : 0) : null;
    const critical = opts.critical === 'success' || opts.critical === 'fail' ? opts.critical : null;
    const natural = Number.isFinite(Number(opts.natural)) ? Number(opts.natural) : null;
    // 每颗骰子要显示的内容：d100 拆成「十位 + 个位」两颗骰子。
    let display;
    if (sides === 100) {
      display = [];
      rawDice.forEach((v, rollIndex) => {
        const tens = Math.floor(v / 10) % 10;
        const ones = v % 10;
        display.push({ faceIdx: tens + 1, text: String(tens * 10).padStart(2, '0'), rollIndex });
        display.push({ faceIdx: ones + 1, text: String(ones), rollIndex });
      });
    } else {
      display = rawDice.map((v, rollIndex) => ({ faceIdx: resultLabel(poly, v), text: String(v), rollIndex }));
    }
    const N = Math.min(10, display.length);
    display = display.slice(0, N);

    cleanup();
    const board = document.getElementById('board');
    const sourceRect = board ? board.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const viewportW = Math.max(320, document.documentElement.clientWidth || innerWidth || 320);
    const viewportH = Math.max(240, document.documentElement.clientHeight || innerHeight || 240);
    const left = clampNumber(sourceRect.left, 0, viewportW - 1);
    const top = clampNumber(sourceRect.top, 0, viewportH - 1);
    const right = clampNumber(sourceRect.right == null ? sourceRect.left + sourceRect.width : sourceRect.right, left + 1, viewportW);
    const bottom = clampNumber(sourceRect.bottom == null ? sourceRect.top + sourceRect.height : sourceRect.bottom, top + 1, viewportH);
    const canvasW = Math.max(220, Math.round(right - left));
    const canvasH = Math.max(180, Math.round(bottom - top));
    const root = document.createElement('div');
    root.className = 'dice-fx-root';
    root.style.cssText = `left:${left}px;top:${top}px;width:${canvasW}px;height:${canvasH}px;`;
    applySkinTheme(root, skin);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    const glow = document.createElement('div');
    glow.style.cssText = `position:absolute;inset:0;pointer-events:none;background:${skin.glow};`;
    holder.appendChild(glow);
    const resultDiv = document.createElement('div');
    resultDiv.className = 'dice-result-card';
    root.appendChild(holder);
    root.appendChild(resultDiv);
    document.body.appendChild(root);
    rootEl = root;

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      cleanup();showFallback(total, label, opts);return;
    }
    renderer.setSize(canvasW, canvasH);
    const pixelBudgetRatio = Math.sqrt(2200000 / Math.max(1, canvasW * canvasH));
    renderer.setPixelRatio(Math.max(1, Math.min(1.65, window.devicePixelRatio || 1, pixelBudgetRatio)));
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    renderer.outputEncoding = THREE.sRGBEncoding;
    holder.appendChild(renderer.domElement);

    const aspect = canvasW / canvasH;
    const halfDepth = 4.8;
    const halfWidth = halfDepth * aspect;
    const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfDepth, -halfDepth, .1, 50);
    camera.position.set(0, 11.5, 7.2);
    camera.lookAt(0, .25, 0);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xd9e6ff, 0x101522, .82));
    const sun = new THREE.DirectionalLight(0xf4f7ff, 1.34);
    sun.position.set(-3, 9, 6);
    scene.add(sun);
    const rimLight = new THREE.PointLight(skin.rimLight, .95, 22);
    rimLight.position.set(halfWidth * .6, 3.4, -2.6);
    scene.add(rimLight);
    const fill = new THREE.PointLight(skin.fillLight, .34, 20);
    fill.position.set(-halfWidth * .45, 2.4, 3.8);
    scene.add(fill);

    // 一张共享阴影纹理服务所有骰子，避免多骰时重复分配 GPU 资源。
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
    const shadowGeo = new THREE.PlaneGeometry(2.5, 1.0);
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: .42 });
    disposeQueue.push(shadowGeo, shadowMat);

    const geo = isD4 ? buildD4Geometry(poly) : buildGeometry(poly);
    geo.computeBoundingSphere();
    disposeQueue.push(geo);
    let restRatio = geo.boundingSphere ? geo.boundingSphere.radius : 1.05;
    if (isD4) {
      restRatio /= 3;
    }
    const screenScale = Math.max(.72, Math.min(1.12, Math.min(canvasW, canvasH) / 580));
    const perScale = (N === 1 ? .95 : N <= 2 ? .88 : N <= 4 ? .78 : N <= 6 ? .69 : .6) * screenScale * DICE_SIZE_MULTIPLIER;
    const restY = restRatio * perScale;
    const dieCenter = new THREE.Vector3(0, restY, 0);
    const viewDir = new THREE.Vector3().subVectors(camera.position, dieCenter).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const margin = Math.max(.72, perScale * 1.18);
    const xBound = Math.max(1.2, halfWidth - margin);
    const zBound = Math.max(1.15, halfDepth * .82 - margin * .45);
    const rawLayout = display.map((d, i) => clusterPos(i, N));
    const rawExtentX = rawLayout.reduce((m, p) => Math.max(m, Math.abs(p[0])), 0);
    const rawExtentZ = rawLayout.reduce((m, p) => Math.max(m, Math.abs(p[1])), 0);
    let layoutSpread = perScale * 1.54;
    if (rawExtentX) layoutSpread = Math.min(layoutSpread, (xBound - perScale * .08) / rawExtentX);
    if (rawExtentZ) layoutSpread = Math.min(layoutSpread, (zBound - perScale * .08) / rawExtentZ);
    const layoutExtentX = rawExtentX * layoutSpread;
    const layoutExtentZ = rawExtentZ * layoutSpread;
    const centerRoomX = Math.max(0, xBound - layoutExtentX);
    const centerRoomZ = Math.max(0, zBound - layoutExtentZ);
    const centerX = (Math.random() * 2 - 1) * centerRoomX * .62;
    const centerZ = (Math.random() * 2 - 1) * centerRoomZ * .52;
    const layout = rawLayout.map((p) => [centerX + p[0] * layoutSpread, centerZ + p[1] * layoutSpread]);
    const bodyMaterialCache = new Map();
    const spriteMaterialCache = new Map();
    function bodyMaterial(faceLength, highlighted, dimmed) {
      const cacheKey = `${skin.key}|${faceLength}|${highlighted ? 1 : 0}|${dimmed ? 1 : 0}`;
      if (bodyMaterialCache.has(cacheKey)) return bodyMaterialCache.get(cacheKey);
      const material = faceTexture(highlighted, faceLength, skin);
      if (dimmed) { material.transparent = true;material.opacity = .38;material.depthWrite = false;material.metalness = .28; }
      bodyMaterialCache.set(cacheKey, material);disposeQueue.push(material);return material;
    }
    // 一次投掷只选一个入场方向；多颗骰子在同一侧排成错位队列，避免出生时挤在一起。
    const sharedThrowEdge = Math.floor(Math.random() * 4);
    const throwEdgeName = ['left', 'right', 'far', 'near'][sharedThrowEdge];
    root.dataset.throwEdge = throwEdgeName;
    const spawnColumns = N <= 1 ? 1 : N <= 4 ? 2 : N <= 8 ? 3 : 4;
    const spawnRows = Math.ceil(N / spawnColumns);
    const tangentBound = sharedThrowEdge <= 1 ? zBound : xBound;
    const depthBound = sharedThrowEdge <= 1 ? xBound : zBound;
    const tangentSpacing = spawnColumns <= 1
      ? 0
      : Math.min(perScale * 2.34, (tangentBound * 2 - perScale * .22) / (spawnColumns - 1));
    const depthSpacing = spawnRows <= 1
      ? 0
      : Math.min(perScale * 2.18, (depthBound * 2 - perScale * .22) / (spawnRows - 1));
    function sharedEdgeStart(index) {
      const row = Math.floor(index / spawnColumns);
      const rowStart = row * spawnColumns;
      const rowCount = Math.min(spawnColumns, N - rowStart);
      const column = index - rowStart;
      const stagger = rowCount === spawnColumns && row % 2 ? perScale * .12 : 0;
      const tangent = (column - (rowCount - 1) / 2) * tangentSpacing + stagger;
      const depth = row * depthSpacing;
      const jitter = (Math.random() * 2 - 1) * perScale * .035;
      if (sharedThrowEdge <= 1) {
        return [sharedThrowEdge === 0 ? -xBound + depth : xBound - depth, clampNumber(tangent + jitter, -zBound, zBound), row];
      }
      return [clampNumber(tangent + jitter, -xBound, xBound), sharedThrowEdge === 2 ? -zBound + depth : zBound - depth, row];
    }

    const diceData = display.map((d, i) => {
      const res = d.faceIdx;
      const selected = !mode || d.rollIndex === pick;
      const dimmed = !!mode && !selected;
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
        targetVec = worldUp;
      } else {
        const n = poly.normals[res - 1];
        alignVec = new THREE.Vector3(n[0], n[1], n[2]);
        targetVec = worldUp;
      }
      const mats = poly.faces.map((f, fi) => bodyMaterial(f.length, isD4 ? f.indexOf(res - 1) >= 0 : fi === res - 1, dimmed));
      const mesh = new THREE.Mesh(geo, mats);
      const finalPos = layout[i];
      const startPos = sharedEdgeStart(i);
      mesh.position.set(startPos[0], restY + 1.62 + startPos[2] * .1 + Math.random() * .2, startPos[1]);
      mesh.scale.setScalar(perScale);
      mesh.quaternion.setFromEuler(new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2));
      scene.add(mesh);
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
            const sp = makeNumSprite(String(vi + 1), isTip, isTip ? 0.34 : 0.26, spriteMaterialCache, dimmed, skin);
            sp.position.set(facePt[0] * 0.97 + n[0] * 0.06, facePt[1] * 0.97 + n[1] * 0.06, facePt[2] * 0.97 + n[2] * 0.06);
            sp.userData.nLocal = new THREE.Vector3(n[0], n[1], n[2]);
            mesh.add(sp);
            faceSprites.push(sp);
            numSprites++;
          });
        });
      } else {
        poly.faces.forEach((f, fi) => {
          const c = centroid(poly.verts, f);
          const dir = norm(c);
          const n = poly.normals[fi];
          const sp = makeNumSprite(faceTexts[fi], fi === res - 1, SPRITE_SCALE[key] || 0.4, spriteMaterialCache, dimmed, skin);
          sp.position.set(dir[0] * 0.97 + n[0] * 0.06, dir[1] * 0.97 + n[1] * 0.06, dir[2] * 0.97 + n[2] * 0.06);
          sp.userData.nLocal = new THREE.Vector3(n[0], n[1], n[2]);
          mesh.add(sp);
          faceSprites.push(sp);
          numSprites++;
        });
      }
      const shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
      shadowBlob.rotation.x = -Math.PI / 2;
      shadowBlob.position.y = 0.02;
      shadowBlob.position.x = startPos[0];
      shadowBlob.position.z = startPos[1];
      shadowBlob.scale.setScalar(perScale);
      scene.add(shadowBlob);
      let selectionRing = null;
      if (mode && selected) {
        const ringGeo = new THREE.RingGeometry(.94, 1.16, 48);
        const ringMat = new THREE.MeshBasicMaterial({ color: skin.accent, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
        selectionRing = new THREE.Mesh(ringGeo, ringMat);selectionRing.rotation.x = -Math.PI / 2;selectionRing.position.set(finalPos[0], .035, finalPos[1]);selectionRing.scale.setScalar(perScale * 1.18);scene.add(selectionRing);disposeQueue.push(ringGeo, ringMat);
      }
      // 先把真实结果面锁到世界上方，再绕竖轴随机转动；后者不会改变朝上的数字。
      const qAlign = new THREE.Quaternion().setFromUnitVectors(alignVec, targetVec);
      const qYaw = new THREE.Quaternion().setFromAxisAngle(worldUp, Math.random() * Math.PI * 2);
      const qFinal = qYaw.multiply(qAlign).normalize();
      const travelSeconds = 1.55 + Math.random() * .18;
      const velocity = new THREE.Vector3((finalPos[0] - startPos[0]) / travelSeconds, 5.4 + Math.random() * 2.1, (finalPos[1] - startPos[1]) / travelSeconds);
      // 只在入场边缘的平行方向加入散射，避免某颗骰子突然逆着整组飞行。
      if (sharedThrowEdge <= 1) velocity.z += (Math.random() * 2 - 1) * 1.0;
      else velocity.x += (Math.random() * 2 - 1) * 1.2;
      const angularVelocity = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(10 + Math.random() * 8);
      const finalScale = perScale * (mode ? (selected ? 1.09 : .77) : 1);
      return {
        mesh,
        shadowBlob,
        selectionRing,
        res,
        text: d.text,
        faceTexts,
        numSprites,
        sprites: faceSprites,
        opacity: dimmed ? .38 : 1,
        selected,
        dimmed,
        finalScale,
        finalPosition: new THREE.Vector3(finalPos[0], restRatio * finalScale, finalPos[1]),
        startPosition: mesh.position.clone(),
        velocity,
        angularVelocity,
        qFinal,
        settlePosition: null,
        settleQuaternion: null,
        settleScale: perScale,
        bounces: 0,
      };
    });
    const collisionDiameter = perScale * 2.04;
    let diceCollisionCount = 0;
    function minimumPlanarDistance(points) {
      if (points.length < 2) return null;
      let minimum = Infinity;
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        for (let j = i + 1; j < points.length; j++) {
          const b = points[j];
          const ax = Array.isArray(a) ? a[0] : a.x;
          const az = Array.isArray(a) ? a[1] : a.z;
          const bx = Array.isArray(b) ? b[0] : b.x;
          const bz = Array.isArray(b) ? b[1] : b.z;
          minimum = Math.min(minimum, Math.hypot(bx - ax, bz - az));
        }
      }
      return Number.isFinite(minimum) ? minimum : null;
    }
    const startMinDistance = minimumPlanarDistance(diceData.map((d) => d.startPosition));
    const finalMinDistance = minimumPlanarDistance(layout);
    root.dataset.diceScale = perScale.toFixed(3);
    root.dataset.spawnGrid = `${spawnColumns}x${spawnRows}`;
    root.dataset.collisionDistance = collisionDiameter.toFixed(3);
    root.dataset.startMinDistance = startMinDistance == null ? '' : startMinDistance.toFixed(3);
    root.dataset.finalMinDistance = finalMinDistance == null ? '' : finalMinDistance.toFixed(3);
    function resolveDiceCollisions() {
      // 最大只显示 10 颗；两轮 O(N²) 分离足以防穿模，成本远低于完整刚体引擎。
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < diceData.length; i++) {
          const a = diceData[i];
          for (let j = i + 1; j < diceData.length; j++) {
            const b = diceData[j];
            let dx = b.mesh.position.x - a.mesh.position.x;
            let dz = b.mesh.position.z - a.mesh.position.z;
            let distance = Math.hypot(dx, dz);
            if (distance >= collisionDiameter) continue;
            if (distance < .0001) {
              const angle = ((i + 1) * 2.399 + (j + 1) * .73) % (Math.PI * 2);
              dx = Math.cos(angle);dz = Math.sin(angle);distance = 1;
            }
            const nx = dx / distance;
            const nz = dz / distance;
            const correction = (collisionDiameter - distance) * .52 + .001;
            a.mesh.position.x = clampNumber(a.mesh.position.x - nx * correction, -xBound, xBound);
            a.mesh.position.z = clampNumber(a.mesh.position.z - nz * correction, -zBound, zBound);
            b.mesh.position.x = clampNumber(b.mesh.position.x + nx * correction, -xBound, xBound);
            b.mesh.position.z = clampNumber(b.mesh.position.z + nz * correction, -zBound, zBound);
            const closingSpeed = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
            if (closingSpeed < 0) {
              const impulse = -(1 + .38) * closingSpeed * .5;
              a.velocity.x -= nx * impulse;a.velocity.z -= nz * impulse;
              b.velocity.x += nx * impulse;b.velocity.z += nz * impulse;
              a.angularVelocity.y -= impulse * .08;b.angularVelocity.y += impulse * .08;
            }
            diceCollisionCount++;
          }
        }
      }
    }
    const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const physicsDuration = reducedMotion ? 120 : 1820;
    const settleDuration = reducedMotion ? 260 : 520;
    const t0 = performance.now();
    let lastFrame = t0;
    let physicsSteps = 0;
    const spinAxis = new THREE.Vector3();
    const spinDelta = new THREE.Quaternion();
    const spriteNormalWorld = new THREE.Vector3();

    function frame(now) {
      const elapsed = now - t0;
      const inPhysics = elapsed < physicsDuration;
      const dt = Math.min(.034, Math.max(.001, (now - lastFrame) / 1000));
      lastFrame = now;
      diceData.forEach((d) => {
        if (inPhysics) {
          d.velocity.y -= 14.2 * dt;
          d.mesh.position.addScaledVector(d.velocity, dt);
          const horizontalDrag = Math.exp(-.48 * dt);
          d.velocity.x *= horizontalDrag;d.velocity.z *= horizontalDrag;
          if (d.mesh.position.y <= restY) {
            d.mesh.position.y = restY;
            if (d.velocity.y < -.35) {d.velocity.y = -d.velocity.y * (.42 + Math.random() * .12);d.bounces++;}
            else d.velocity.y = 0;
            const floorGrip = Math.exp(-2.0 * dt);d.velocity.x *= floorGrip;d.velocity.z *= floorGrip;d.angularVelocity.multiplyScalar(Math.exp(-1.4 * dt));
          }
          if (d.mesh.position.x < -xBound || d.mesh.position.x > xBound) {
            d.mesh.position.x = clampNumber(d.mesh.position.x, -xBound, xBound);d.velocity.x *= -.68;d.angularVelocity.z += d.velocity.x * .45;
          }
          if (d.mesh.position.z < -zBound || d.mesh.position.z > zBound) {
            d.mesh.position.z = clampNumber(d.mesh.position.z, -zBound, zBound);d.velocity.z *= -.68;d.angularVelocity.x -= d.velocity.z * .45;
          }
          const spinSpeed = d.angularVelocity.length();
          if (spinSpeed > .001) {spinAxis.copy(d.angularVelocity).normalize();spinDelta.setFromAxisAngle(spinAxis, spinSpeed * dt);d.mesh.quaternion.premultiply(spinDelta).normalize();}
        } else {
          if (!d.settlePosition) {d.settlePosition = d.mesh.position.clone();d.settleQuaternion = d.mesh.quaternion.clone();d.settleScale = d.mesh.scale.x;}
          const settleT = clampNumber((elapsed - physicsDuration) / settleDuration, 0, 1);
          const eased = easeInOut(settleT);
          d.mesh.position.lerpVectors(d.settlePosition, d.finalPosition, eased);
          d.mesh.position.y += Math.sin(settleT * Math.PI) * .18 * (1 - settleT);
          d.mesh.quaternion.slerpQuaternions(d.settleQuaternion, d.qFinal, eased);
          d.mesh.scale.setScalar(d.settleScale + (d.finalScale - d.settleScale) * easeOut(settleT));
          if (d.selectionRing) d.selectionRing.material.opacity = .74 * easeOut(settleT);
        }
      });
      if (inPhysics) resolveDiceCollisions();
      diceData.forEach((d) => {
        d.sprites.forEach((sp) => {
          spriteNormalWorld.copy(sp.userData.nLocal).applyQuaternion(d.mesh.quaternion);
          sp.visible = spriteNormalWorld.dot(viewDir) > 0.22;
        });
        d.shadowBlob.position.x = d.mesh.position.x;d.shadowBlob.position.z = d.mesh.position.z;
        const height = Math.max(0, d.mesh.position.y - restY), shadowS = Math.max(.5, 1 - height * .18) * d.mesh.scale.x;
        d.shadowBlob.scale.setScalar(shadowS);
      });
      if (inPhysics) physicsSteps++;
      renderer.render(scene, camera);
      if (elapsed < physicsDuration + settleDuration) {
        rafId = requestAnimationFrame(frame);
      } else {
        const topObservations = diceData.map((d) => {
          let bestIndex = 0;
          let bestScore = -Infinity;
          const candidates = isD4 ? poly.verts : poly.normals;
          candidates.forEach((candidate, index) => {
            const score = new THREE.Vector3(candidate[0], candidate[1], candidate[2])
              .normalize()
              .applyQuaternion(d.mesh.quaternion).y;
            if (score > bestScore) { bestScore = score; bestIndex = index; }
          });
          return {
            label: isD4 ? String(bestIndex + 1) : String(d.faceTexts[bestIndex]),
            score: bestScore,
          };
        });
        root.dataset.expectedLabels = diceData.map((d) => String(d.text)).join(',');
        root.dataset.topLabels = topObservations.map((item) => item.label).join(',');
        root.dataset.faceLockPassed = String(topObservations.every((item, index) => item.label === String(diceData[index].text)));
        window.__DICE_LAST__ = {
          frontLabels: diceData.map((d) => d.res),
          labels: diceData.map((d) => d.text),
          topLabels: topObservations.map((item) => item.label),
          topScores: topObservations.map((item) => Math.round(item.score * 10000) / 10000),
          faceLockPassed: topObservations.every((item, index) => item.label === String(diceData[index].text)),
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
          natural,
          crit: critical,
          physics: true,
          physicsSteps,
          duration: physicsDuration + settleDuration,
          throwEdge: throwEdgeName,
          skin: skin.key,
          sizeMultiplier: DICE_SIZE_MULTIPLIER,
          spawnGrid: [spawnColumns, spawnRows],
          collisionDistance: Math.round(collisionDiameter * 100) / 100,
          collisionCount: diceCollisionCount,
          startMinDistance: startMinDistance == null ? null : Math.round(startMinDistance * 100) / 100,
          finalMinDistance: finalMinDistance == null ? null : Math.round(finalMinDistance * 100) / 100,
          startPositions: diceData.map((d) => d.startPosition.toArray().map((v) => Math.round(v * 100) / 100)),
          endPositions: diceData.map((d) => d.finalPosition.toArray().map((v) => Math.round(v * 100) / 100)),
          chosenIndex: pick,
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
        else if (mode !== 0) text += `（取 ${rawDice[pick]}）`;
        else if (N > 1) text += `（${diceData.map((d) => d.text).join(' + ')}）`;
        if (critical === 'success') {
          showCrit(root, 'success', '大成功！');
          text = '⚡ 大成功！' + text;
        } else if (critical === 'fail') {
          showCrit(root, 'fail', '大失败！');
          text = '💥 大失败！' + text;
        }
        resultDiv.textContent = text;
        if (mode !== 0 && rawDice.length >= 2) {
          const detail = document.createElement('small');detail.textContent = `${mode === 1 ? '优势' : '劣势'}：取 ${rawDice[pick]} · 舍 ${rawDice[pick === 0 ? 1 : 0]}`;resultDiv.appendChild(detail);
        }
        resultDiv.classList.add('show');
        cleanupTimer = setTimeout(cleanup, reducedMotion ? 1250 : 2200);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  window.playDieAnimation = playDieAnimation;
  window.SundollDiceSkins = Object.freeze({
    skins: DICE_SKINS,
    list: () => Object.values(DICE_SKINS).map((skin) => ({ key: skin.key, label: skin.label, swatch: skin.swatch, accent: skin.accent })),
    get: () => activeSkinKey,
    set: (key) => setDiceSkin(key, true),
  });
  window.__DICE_POLY__ = POLY;
  window.__DICE_LAST__ = null;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installDiceSkinPickers, { once: true });
  else installDiceSkinPickers();
})();
