/* 桑多尔之歌 · 全地图 3D 骰子动画（three.js）
   支持多骰、优势/劣势、天然 1/20；轻量物理积分负责滚动与碰撞，
   预先生成的逻辑结果会在减速滚动中自然收敛为真实朝上的落面。 */
(function () {
  'use strict';

  // 大成功 / 大失败特效样式（一次性注入）
  if (!document.getElementById('dice-crit-style')) {
    const st = document.createElement('style');
    st.id = 'dice-crit-style';
    st.textContent = `
.dice-fx-root { position:fixed; z-index:200; overflow:hidden; pointer-events:none; contain:layout paint; }
.dice-fx-root canvas { position:absolute; inset:0; width:100%; height:100%; filter:drop-shadow(0 8px 12px rgba(0,0,0,.28)); }
.dice-result-card { position:absolute; left:50%; bottom:18px; transform:translateX(-50%) translateY(8px); z-index:3; min-width:210px; max-width:min(680px,calc(100% - 28px)); padding:9px 12px 10px; border:1px solid var(--dice-accent-soft,rgba(255,218,130,.5)); border-radius:13px; background:linear-gradient(180deg,rgba(18,23,34,.93),rgba(7,9,15,.92)); color:var(--dice-accent,#ffe08a); font:italic 700 19px Didot,Georgia,serif; line-height:1.3; text-align:center; text-shadow:0 2px 8px rgba(0,0,0,.85); box-shadow:0 12px 36px rgba(0,0,0,.45),inset 0 1px rgba(255,255,255,.09); opacity:0; pointer-events:none; user-select:none; -webkit-user-select:none; transition:opacity .24s,transform .28s cubic-bezier(.2,.8,.2,1); backdrop-filter:blur(7px); }
.dice-result-card.show { opacity:1; pointer-events:auto; transform:translateX(-50%) translateY(0); }
.dice-result-card small { display:block; margin-top:2px; color:#b7c4dc; font:600 11px system-ui,sans-serif; font-style:normal; }
.dice-result-actions { display:flex; align-items:center; justify-content:center; gap:9px; margin-top:7px; text-shadow:none; }
.dice-result-countdown { min-width:76px; color:#929eb4; font:600 10px system-ui,sans-serif; font-style:normal; text-align:right; }
.dice-result-confirm { min-width:76px; height:29px; padding:0 14px; border:1px solid var(--dice-accent-soft,rgba(255,218,130,.5)); border-radius:8px; outline:none; background:#202737; background:linear-gradient(180deg,color-mix(in srgb,var(--dice-accent,#ffe08a) 23%,#202737),rgba(17,21,30,.96)); color:var(--dice-accent,#ffe08a); cursor:pointer; font:700 12px system-ui,sans-serif; box-shadow:0 4px 12px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.1); }
.dice-result-confirm:hover { filter:brightness(1.14); }
.dice-result-confirm:focus-visible { box-shadow:0 0 0 2px color-mix(in srgb,var(--dice-accent,#ffe08a) 35%,transparent),0 4px 12px rgba(0,0,0,.28); }
.dice-result-confirm:disabled { opacity:.56; cursor:default; filter:none; }
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
  const DICE_SIZE_MULTIPLIER = 1.30;
  const D20_RESULT_TILT_DEGREES = 16;
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
  function quaternionAngleDegrees(a, b) {
    const cosine = Math.min(1, Math.abs(a.dot(b)));
    return 2 * Math.acos(cosine) * 180 / Math.PI;
  }

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

  // 标准十面骰使用五方偏方面体，而不是五角双锥。这里用上下交错的十点腰环
  // 与两个极点构成十个风筝面，整体再归一化到单位外接球。
  function pentagonalTrapezohedron() {
    const ring = [];
    const ringRadius = 1;
    const poleHeight = 1.15;
    const cosStep = Math.cos(Math.PI / 5);
    const ringHeight = poleHeight * (1 - cosStep) / (1 + cosStep);
    for (let i = 0; i < 10; i++) {
      const angle = Math.PI / 2 + i * Math.PI / 5;
      ring.push([
        Math.cos(angle) * ringRadius,
        i % 2 === 0 ? -ringHeight : ringHeight,
        Math.sin(angle) * ringRadius,
      ]);
    }
    const verts = [[0, poleHeight, 0], [0, -poleHeight, 0]].concat(ring);
    const faces = [];
    for (let i = 0; i < 10; i++) {
      const prev = 2 + ((i + 9) % 10);
      const current = 2 + i;
      const next = 2 + ((i + 1) % 10);
      if (i % 2 === 0) faces.push([0, prev, current, next]);
      else faces.push([1, next, current, prev]);
    }
    const maxRadius = Math.max.apply(null, verts.map((v) => Math.hypot(v[0], v[1], v[2])));
    return { verts: verts.map((v) => scale(v, 1 / maxRadius)), faces };
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

  function ensureOutwardFace(verts, face) {
    const ordered = face.slice();
    if (ordered.length < 3) return ordered;
    const a = verts[ordered[0]], b = verts[ordered[1]], c = verts[ordered[2]];
    const normal = cross(sub(b, a), sub(c, a));
    if (dot(normal, centroid(verts, ordered)) >= 0) return ordered;
    // 保留 face[0] 作为字面上沿锚点，只反转其余顶点来修正手性。
    // 这样最终数字朝向不变，同时 UV 不会跟着朝内面左右镜像。
    return [ordered[0]].concat(ordered.slice(1).reverse());
  }

  function withMeta(poly) {
    poly.faces = poly.faces.map((face) => ensureOutwardFace(poly.verts, face));
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
    d10: withMeta(pentagonalTrapezohedron()),
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
        // Canvas 的 Y 轴向下；所有面已在 withMeta 中规范为外向绕序，
        // 因此这里统一使用逆向 UV 绕序，避免字面左右镜像。
        const a = -(i / n) * Math.PI * 2 - Math.PI / 2;
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
    // 与普通多面体使用同一外向绕序，避免 D4 角标左右镜像。
    const triUv = [[0.12, 0.12], [0.5, 0.92], [0.88, 0.12]];
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

  function drawMarkedNum(g, num, x, y, size, highlight, skin) {
    const text = String(num);
    drawNum(g, text, x, y, size, highlight, skin);
    if (text === '6' || text === '9' || text === '60' || text === '90') {
      const numberColors = highlight ? skin.numberHighlight : skin.number;
      const width = Math.min(size * 1.05, Math.max(size * .58, g.measureText(text).width * .86));
      g.fillStyle = numberColors[1];
      g.fillRect(x - width / 2, y + size * .53, width, Math.max(3, size * .055));
    }
  }

  function faceTexture(isResult, n, label, skin, dieKind) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    faceBase(g, isResult, skin);
    strokeFaceOutline(g, n || 4, isResult, skin);
    const text = String(label == null ? '' : label);
    const digits = Math.max(1, text.length);
    const polygonScale = n <= 3 ? .78 : n === 4 ? 1 : .9;
    let size = Math.round((isResult ? 100 : 84) * polygonScale * Math.min(1, 1.6 / Math.sqrt(digits)));
    g.font = FANCY_FONT.replace('${size}', size);
    const maxTextWidth = n <= 3 ? 112 : n === 4 ? 166 : 148;
    const measuredWidth = g.measureText(text).width || 1;
    if (measuredWidth > maxTextWidth) size = Math.max(30, Math.floor(size * maxTextWidth / measuredWidth));
    // d20 的三角面在透视下视觉中心略低于纹理中心，单独下移一点避免数字显得偏上。
    const numberY = dieKind === 'd20' ? 138 : 132;
    drawMarkedNum(g, text, 128, numberY, size, isResult, skin);
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

  // D4 的每一面同时包含三个顶点读数。数字直接画进面纹理，跟随骰面旋转，
  // 不再使用始终朝向镜头的 Sprite，避免数字脱离骰体悬浮。
  function d4BodyTexture(face, tipIdx, skin) {
    skin = skin || resolveDiceSkin(activeSkinKey);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const highlight = face.indexOf(tipIdx) >= 0;
    faceBase(g, highlight, skin);
    const triUv = [[0.12, 0.12], [0.5, 0.92], [0.88, 0.12]];
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
    face.forEach((vertexIndex, index) => {
      const corner = triUv[index];
      const x = (corner[0] * .48 + .5 * .52) * 256;
      const y = (corner[1] * .48 + .5 * .52) * 256;
      const highlight = vertexIndex === tipIdx;
      drawMarkedNum(g, String(vertexIndex + 1), x, y, highlight ? 42 : 34, highlight, skin);
    });
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

  let rafId = null;
  let cleanupTimer = null;
  let resultCountdownTimer = null;
  let rootEl = null;
  let renderer = null;
  let disposeQueue = [];
  const MAX_QUEUED_ROLLS = 8;
  const MAX_ANIMATED_DICE = 20;
  const RESULT_HOLD_MS = 3000;
  const rollQueue = [];
  let animationActive = false;
  let animationPhase = 'idle';
  let rollSequence = 0;
  let droppedQueuedRolls = 0;
  let interruptedRolls = 0;

  function cleanup() {
    if (rafId) cancelAnimationFrame(rafId);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (resultCountdownTimer) clearInterval(resultCountdownTimer);
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
    rafId = null; cleanupTimer = null; resultCountdownTimer = null; rootEl = null;
  }

  function updateQueueDiagnostics() {
    if (rootEl) {
      rootEl.dataset.queueLength = String(rollQueue.length);
      rootEl.dataset.animationPhase = animationPhase;
    }
    window.__DICE_QUEUE__ = {
      active: animationActive,
      phase: animationPhase,
      pending: rollQueue.length,
      dropped: droppedQueuedRolls,
      interrupted: interruptedRolls,
    };
  }

  function publishDiceCompletion(diagnostic) {
    window.__DICE_LAST__ = diagnostic;
    if (!Array.isArray(window.__DICE_HISTORY__)) window.__DICE_HISTORY__ = [];
    window.__DICE_HISTORY__.push(diagnostic);
    if (window.__DICE_HISTORY__.length > 20) window.__DICE_HISTORY__.splice(0, window.__DICE_HISTORY__.length - 20);
    try { window.dispatchEvent(new CustomEvent('sundoll-dice-complete', { detail: diagnostic })); } catch (e) { /* 忽略 */ }
  }

  function startNextQueuedRoll() {
    cleanup();
    const next = rollQueue.shift();
    if (!next) {
      animationActive = false;
      animationPhase = 'idle';
      updateQueueDiagnostics();
      return;
    }
    animationActive = true;
    animationPhase = 'rolling';
    updateQueueDiagnostics();
    runDieAnimation(next.sides, next.label, next.total, next.opts, next.rollId);
  }

  function scheduleAdvance(delay) {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(startNextQueuedRoll, Math.max(120, delay));
    updateQueueDiagnostics();
  }

  function buildResultCard(resultEl, text, detailText) {
    resultEl.replaceChildren();
    const title = document.createElement('div');
    title.className = 'dice-result-title';
    title.textContent = text;
    resultEl.appendChild(title);
    if (detailText) {
      const detail = document.createElement('small');
      detail.textContent = detailText;
      resultEl.appendChild(detail);
    }
    const actions = document.createElement('div');
    actions.className = 'dice-result-actions';
    const countdown = document.createElement('span');
    countdown.className = 'dice-result-countdown';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'dice-result-confirm';
    confirm.textContent = '确定';
    actions.append(countdown, confirm);
    resultEl.appendChild(actions);
    return { countdown, confirm };
  }

  function armResultDismiss(root, resultEl, controls) {
    const deadline = performance.now() + RESULT_HOLD_MS;
    let finished = false;
    const updateCountdown = () => {
      const remaining = Math.max(0, deadline - performance.now());
      controls.countdown.textContent = remaining > 0 ? `${Math.ceil(remaining / 1000)} 秒后结束` : '正在结束';
    };
    const finish = (reason) => {
      if (finished || rootEl !== root || animationPhase !== 'result') return;
      finished = true;
      root.dataset.dismissedBy = reason;
      controls.confirm.disabled = true;
      controls.countdown.textContent = reason === 'manual' ? '已确认' : '正在结束';
      if (resultCountdownTimer) clearInterval(resultCountdownTimer);
      resultCountdownTimer = null;
      animationPhase = 'closing';
      resultEl.classList.remove('show');
      updateQueueDiagnostics();
      scheduleAdvance(140);
    };
    controls.confirm.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish('manual');
    });
    root.dataset.resultHoldMs = String(RESULT_HOLD_MS);
    updateCountdown();
    resultCountdownTimer = setInterval(updateCountdown, 100);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => finish('auto'), RESULT_HOLD_MS);
  }

  function enqueueDieAnimation(sides, label, total, opts) {
    const request = { sides, label, total, opts: opts || {}, rollId: ++rollSequence };
    if (request.opts.interrupt === true && animationActive) {
      interruptedRolls++;
      rollQueue.splice(0, rollQueue.length);
      cleanup();
      animationActive = false;
      animationPhase = 'idle';
    }
    if (animationActive) {
      if (rollQueue.length >= MAX_QUEUED_ROLLS) {
        rollQueue.shift();
        droppedQueuedRolls++;
      }
      rollQueue.push(request);
      // 每次结果都完整保留三秒；玩家也可以用“确定”立即衔接下一次投掷。
      updateQueueDiagnostics();
      return request.rollId;
    }
    animationActive = true;
    animationPhase = 'rolling';
    updateQueueDiagnostics();
    runDieAnimation(request.sides, request.label, request.total, request.opts, request.rollId);
    return request.rollId;
  }

  function applySkinTheme(root, skin) {
    root.dataset.diceSkin = skin.key;
    root.style.setProperty('--dice-accent', skin.accent);
    root.style.setProperty('--dice-accent-soft', skin.accentSoft);
  }

  function showFallback(total, label, opts, rollId) {
    cleanup();
    opts = opts || {};
    const skin = resolveDiceSkin(opts.skin);
    const board = document.getElementById('board');
    const rect = board ? board.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const root = document.createElement('div');
    root.className = 'dice-fx-root';
    root.style.cssText = `left:${Math.max(0,rect.left)}px;top:${Math.max(0,rect.top)}px;width:${Math.max(220,rect.width)}px;height:${Math.max(180,rect.height)}px;`;
    root.dataset.rollVisibility = opts.visibility === 'private' ? 'private' : 'public';
    applySkinTheme(root, skin);
    const totalEl = document.createElement('div');
    totalEl.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:italic 800 96px Didot,Georgia,serif;color:${skin.accent};text-shadow:0 4px 14px rgba(0,0,0,.8);`;
    totalEl.textContent = total;
    const resultEl = document.createElement('div');
    resultEl.className = 'dice-result-card show';
    const controls = buildResultCard(resultEl, `${label || '掷骰'} → ${total}`, '');
    root.append(totalEl, resultEl);
    document.body.appendChild(root);
    rootEl = root;
    if (opts.critical === 'success') showCrit(root, 'success', '大成功！');
    else if (opts.critical === 'fail') showCrit(root, 'fail', '大失败！');
    animationPhase = 'result';
    const diagnostic = {
      rollId,
      frontLabels: [total],
      topLabels: [String(total)],
      topScores: [1],
      faceLockPassed: true,
      total,
      natural: opts.natural ?? null,
      crit: opts.critical || null,
      fallback: true,
      skin: skin.key,
      queueRemaining: rollQueue.length,
      droppedQueuedRolls,
      interruptedRolls,
    };
    updateQueueDiagnostics();
    publishDiceCompletion(diagnostic);
    armResultDismiss(root, resultEl, controls);
  }

  function showCrit(root, type, text) {
    const el = document.createElement('div');
    el.className = 'dice-crit ' + type;
    el.innerHTML = `<span class="crit-icon">${type === 'success' ? '⚡' : '💥'}</span><span class="crit-text">${text}</span>`;
    root.appendChild(el);
  }

  function adaptiveColumns(N) {
    if (N <= 1) return 1;
    if (N <= 4) return 2;
    if (N <= 7) return 3;
    if (N <= 12) return 4;
    return 5;
  }

  function adaptiveScaleFactor(N) {
    // 数量每翻倍，单颗骰子平滑缩小；20 颗仍保留足够大的可读面。
    return Math.max(.46, .98 - .13 * Math.log2(Math.max(1, N)));
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
    const columns = adaptiveColumns(N);
    const rows = Math.ceil(N / columns);
    const row = Math.floor(i / columns);
    const rowStart = row * columns;
    const rowCount = Math.min(columns, N - rowStart);
    const column = i - rowStart;
    const stagger = rowCount === columns && row % 2 ? .12 : 0;
    return [(column - (rowCount - 1) / 2) * 1.52 + stagger, (row - (rows - 1) / 2) * 1.46];
  }

  function runDieAnimation(sides, label, total, opts, rollId) {
    opts = opts || {};
    if (!window.THREE) { showFallback(total, label, opts, rollId); return; }
    sides = Math.round(clampNumber(sides || 20, 2, 1000));
    const skin = resolveDiceSkin(opts.skin);
    const key = dieKey(sides);
    const poly = POLY[key] || POLY.d20;
    const isD4 = key === 'd4';
    const rawDice = Array.isArray(opts.dice) && opts.dice.length
      ? opts.dice.map((v) => Math.min(sides, Math.max(1, Math.round(v) || 1)))
      : [Math.min(sides, Math.max(1, Math.round(total) || 1))];
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
    const requestedDisplayCount = display.length;
    const N = Math.min(MAX_ANIMATED_DICE, requestedDisplayCount);
    const omittedDisplayCount = Math.max(0, requestedDisplayCount - N);
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
    root.dataset.rollVisibility = opts.visibility === 'private' ? 'private' : 'public';
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
    updateQueueDiagnostics();

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      cleanup();showFallback(total, label, opts, rollId);return;
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
    const screenScale = Math.max(.72, Math.min(1.12, Math.min(canvasW, canvasH) / 580));
    const countScale = adaptiveScaleFactor(N);
    const perScale = countScale * screenScale * DICE_SIZE_MULTIPLIER;
    const worldUp = new THREE.Vector3(0, 1, 0);
    // D20 若完全平放，结果三角面会落在画面的骰顶。轻微朝镜头倾斜后，
    // 结果仍是最高面，但数字会处在更接近骰体视觉中心的位置。
    const d20ResultTilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      D20_RESULT_TILT_DEGREES * Math.PI / 180
    );
    const supportVertex = new THREE.Vector3();
    function supportHeight(quaternion, scaleValue) {
      let minimumY = Infinity;
      poly.verts.forEach((vertex) => {
        supportVertex.set(vertex[0], vertex[1], vertex[2]).applyQuaternion(quaternion);
        if (supportVertex.y < minimumY) minimumY = supportVertex.y;
      });
      return Math.max(.02, -minimumY * scaleValue);
    }
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
    function finishBodyMaterial(material, dimmed) {
      if (dimmed) {
        material.transparent = true;
        material.opacity = .38;
        material.depthWrite = false;
        material.metalness = .28;
      }
      disposeQueue.push(material);
      return material;
    }
    function bodyMaterial(faceLength, faceLabel, highlighted, dimmed) {
      const cacheKey = `${skin.key}|regular|${faceLength}|${faceLabel}|${highlighted ? 1 : 0}|${dimmed ? 1 : 0}`;
      if (bodyMaterialCache.has(cacheKey)) return bodyMaterialCache.get(cacheKey);
      const material = finishBodyMaterial(faceTexture(highlighted, faceLength, faceLabel, skin, key), dimmed);
      bodyMaterialCache.set(cacheKey, material);
      return material;
    }
    function d4Material(face, tipIndex, dimmed) {
      const cacheKey = `${skin.key}|d4|${face.join('.')}|${tipIndex}|${dimmed ? 1 : 0}`;
      if (bodyMaterialCache.has(cacheKey)) return bodyMaterialCache.get(cacheKey);
      const material = finishBodyMaterial(d4BodyTexture(face, tipIndex, skin), dimmed);
      bodyMaterialCache.set(cacheKey, material);
      return material;
    }
    // 一次投掷只选一个入场方向；多颗骰子在同一侧排成错位队列，避免出生时挤在一起。
    const sharedThrowEdge = Math.floor(Math.random() * 4);
    const throwEdgeName = ['left', 'right', 'far', 'near'][sharedThrowEdge];
    root.dataset.throwEdge = throwEdgeName;
    const spawnColumns = adaptiveColumns(N);
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
      const discarded = !!mode && !selected;
      // 每颗骰子每个面的文字：普通骰 1..N；d100 十位骰 00/10/…90、个位骰 0-9
      const faceTexts = sides === 100
        ? (i % 2 === 0
          ? poly.labels.map((lab, fi) => String((fi) * 10).padStart(2, '0'))
          : poly.labels.map((lab, fi) => String(fi)))
        : poly.labels.map((lab) => String(lab));
      // d21-d1000 等自定义骰以现有多面体代为表现，但朝上的面必须写真实结果，
      // 不能把 27 错画成 7。
      if (sides !== 100 && faceTexts[res - 1] !== String(d.text)) faceTexts[res - 1] = String(d.text);
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
      const mats = isD4
        ? poly.faces.map((face) => d4Material(face, res - 1, false))
        : poly.faces.map((face, faceIndex) => bodyMaterial(face.length, faceTexts[faceIndex], faceIndex === res - 1, false));
      const mesh = new THREE.Mesh(geo, mats);
      const finalPos = layout[i];
      const startPos = sharedEdgeStart(i);
      mesh.scale.setScalar(perScale);
      mesh.quaternion.setFromEuler(new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2));
      const initialFloorY = supportHeight(mesh.quaternion, perScale);
      mesh.position.set(startPos[0], initialFloorY + 1.62 + startPos[2] * .1 + Math.random() * .2, startPos[1]);
      scene.add(mesh);
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
      let finalYaw = Math.random() * Math.PI * 2;
      if (!isD4) {
        // 让结果面的数字大致朝向屏幕上方，同时保留少量自然偏转。
        const resultFace = poly.faces[res - 1];
        const faceCenter = centroid(poly.verts, resultFace);
        const firstVertex = poly.verts[resultFace[0]];
        const labelUp = new THREE.Vector3(
          firstVertex[0] - faceCenter[0],
          firstVertex[1] - faceCenter[1],
          firstVertex[2] - faceCenter[2]
        ).normalize().applyQuaternion(qAlign);
        labelUp.y = 0;
        if (labelUp.lengthSq() > .0001) {
          labelUp.normalize();
          // 纹理保持 flipY=false，face[0] 对应字面的上沿；摄像机位于桌面近侧，
          // 因而把该方向对齐到远离镜头的一侧，顶面数字会正向面向玩家。
          const screenUpOnTable = new THREE.Vector3(0, 0, -1);
          finalYaw = Math.atan2(
            labelUp.z * screenUpOnTable.x - labelUp.x * screenUpOnTable.z,
            labelUp.x * screenUpOnTable.x + labelUp.z * screenUpOnTable.z
          ) + (Math.random() * 2 - 1) * .14;
        }
      }
      const qYaw = new THREE.Quaternion().setFromAxisAngle(worldUp, finalYaw);
      const qFinal = qYaw.multiply(qAlign).normalize();
      if (key === 'd20') qFinal.premultiply(d20ResultTilt).normalize();
      const travelSeconds = 1.55 + Math.random() * .18;
      const velocity = new THREE.Vector3((finalPos[0] - startPos[0]) / travelSeconds, 5.4 + Math.random() * 2.1, (finalPos[1] - startPos[1]) / travelSeconds);
      // 只在入场边缘的平行方向加入散射，避免某颗骰子突然逆着整组飞行。
      if (sharedThrowEdge <= 1) velocity.z += (Math.random() * 2 - 1) * 1.0;
      else velocity.x += (Math.random() * 2 - 1) * 1.2;
      const angularVelocity = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(10 + Math.random() * 8);
      // 滚动与落稳阶段所有骰子保持同样大小；只有结果完全稳定后才突出取用骰。
      const finalScale = perScale;
      const resultScale = perScale * (mode ? (selected ? 1.18 : .76) : 1);
      const finalSupportY = supportHeight(qFinal, finalScale);
      return {
        mesh,
        shadowBlob,
        selectionRing,
        res,
        text: d.text,
        faceTexts,
        labelTextures: mats.length,
        opacity: 1,
        selected,
        discarded,
        finalScale,
        resultScale,
        focusMaterials: [],
        focusShadowMaterial: null,
        plannedPosition: new THREE.Vector3(finalPos[0], finalSupportY, finalPos[1]),
        finalPosition: new THREE.Vector3(finalPos[0], finalSupportY, finalPos[1]),
        startPosition: mesh.position.clone(),
        velocity,
        angularVelocity,
        qFinal,
        settlePosition: null,
        settleQuaternion: null,
        settleScale: perScale,
        settleClearance: 0,
        guideStartAngularDistance: null,
        settleAngularDistance: null,
        maxLateFrameAngularStep: 0,
        maxSettleFrameAngularStep: 0,
        previousFrameQuaternion: mesh.quaternion.clone(),
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
    let finalMinDistance = minimumPlanarDistance(layout);
    let settleTargetsPrepared = false;
    function prepareSettleTargets() {
      if (settleTargetsPrepared) return;
      settleTargetsPrepared = true;
      const targets = diceData.map((d) => ({
        x: clampNumber(d.mesh.position.x, -xBound, xBound),
        z: clampNumber(d.mesh.position.z, -zBound, zBound),
      }));
      // 骰子落下时可能仍有高低差；把它们投影到桌面后做有限轮次的最近距离分离，
      // 只修正相互穿插，不再把整组强行搬回预制阵列。
      for (let pass = 0; pass < 14; pass++) {
        for (let i = 0; i < targets.length; i++) {
          for (let j = i + 1; j < targets.length; j++) {
            const a = targets[i], b = targets[j];
            let dx = b.x - a.x, dz = b.z - a.z;
            let distance = Math.hypot(dx, dz);
            const desiredDistance = (diceData[i].finalScale + diceData[j].finalScale) * 1.01;
            if (distance >= desiredDistance) continue;
            if (distance < .0001) {
              const angle = ((i + 1) * 2.399 + (j + 1) * .73) % (Math.PI * 2);
              dx = Math.cos(angle);dz = Math.sin(angle);distance = 1;
            }
            const nx = dx / distance, nz = dz / distance;
            const correction = (desiredDistance - distance) * .505 + .001;
            a.x = clampNumber(a.x - nx * correction, -xBound, xBound);
            a.z = clampNumber(a.z - nz * correction, -zBound, zBound);
            b.x = clampNumber(b.x + nx * correction, -xBound, xBound);
            b.z = clampNumber(b.z + nz * correction, -zBound, zBound);
          }
        }
      }
      diceData.forEach((d, index) => {
        d.finalPosition.set(targets[index].x, supportHeight(d.qFinal, d.finalScale), targets[index].z);
        if (d.selectionRing) {
          d.selectionRing.position.x = targets[index].x;
          d.selectionRing.position.z = targets[index].z;
        }
      });
      finalMinDistance = minimumPlanarDistance(targets);
    }
    root.dataset.diceScale = perScale.toFixed(3);
    root.dataset.countScale = countScale.toFixed(3);
    root.dataset.displayCount = String(N);
    root.dataset.maxAnimatedDice = String(MAX_ANIMATED_DICE);
    root.dataset.layoutGrid = `${adaptiveColumns(N)}x${Math.ceil(N / adaptiveColumns(N))}`;
    root.dataset.spawnGrid = `${spawnColumns}x${spawnRows}`;
    root.dataset.collisionDistance = collisionDiameter.toFixed(3);
    root.dataset.startMinDistance = startMinDistance == null ? '' : startMinDistance.toFixed(3);
    root.dataset.finalMinDistance = finalMinDistance == null ? '' : finalMinDistance.toFixed(3);
    function resolveDiceCollisions() {
      // 最大只显示 20 颗；两轮 O(N²) 分离足以防穿模，成本远低于完整刚体引擎。
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < diceData.length; i++) {
          const a = diceData[i];
          for (let j = i + 1; j < diceData.length; j++) {
            const b = diceData[j];
            let dx = b.mesh.position.x - a.mesh.position.x;
            let dz = b.mesh.position.z - a.mesh.position.z;
            let distance = Math.hypot(dx, dz);
            const verticalGap = Math.abs(b.mesh.position.y - a.mesh.position.y);
            const planarCollisionDistance = Math.sqrt(Math.max(0, collisionDiameter * collisionDiameter - verticalGap * verticalGap));
            if (planarCollisionDistance <= 0 || distance >= planarCollisionDistance) continue;
            if (distance < .0001) {
              const angle = ((i + 1) * 2.399 + (j + 1) * .73) % (Math.PI * 2);
              dx = Math.cos(angle);dz = Math.sin(angle);distance = 1;
            }
            const nx = dx / distance;
            const nz = dz / distance;
            const correction = (planarCollisionDistance - distance) * .52 + .001;
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
    const discardedTint = new THREE.Color(0x747b88);
    let resultFocusPrepared = false;
    function prepareResultFocus() {
      if (!mode || resultFocusPrepared) return;
      resultFocusPrepared = true;
      root.dataset.resultFocus = 'active';
      root.dataset.focusStartedAfterSettle = 'true';
      root.dataset.preFocusScales = diceData.map((d) => d.mesh.scale.x.toFixed(3)).join(',');
      root.dataset.preFocusOpacities = diceData.map((d) => {
        const materials = Array.isArray(d.mesh.material) ? d.mesh.material : [d.mesh.material];
        return materials.length ? Number(materials[0].opacity).toFixed(2) : '1.00';
      }).join(',');
      diceData.forEach((d) => {
        if (!d.discarded) {
          d.mesh.renderOrder = 2;
          return;
        }
        const sourceMaterials = Array.isArray(d.mesh.material) ? d.mesh.material : [d.mesh.material];
        const clonedMaterials = sourceMaterials.map((source) => {
          const material = source.clone();
          material.transparent = true;
          material.depthWrite = false;
          material.opacity = 1;
          material.needsUpdate = true;
          // Material.dispose 不会释放共享贴图；这里只释放克隆材质，原贴图仍由缓存材质统一回收。
          disposeQueue.push({ dispose: () => material.dispose() });
          return material;
        });
        d.mesh.material = Array.isArray(d.mesh.material) ? clonedMaterials : clonedMaterials[0];
        d.focusMaterials = clonedMaterials.map((material) => ({
          material,
          color: material.color ? material.color.clone() : null,
          roughness: Number.isFinite(material.roughness) ? material.roughness : null,
          metalness: Number.isFinite(material.metalness) ? material.metalness : null,
          clearcoat: Number.isFinite(material.clearcoat) ? material.clearcoat : null,
        }));
        const shadowMaterial = d.shadowBlob.material.clone();
        d.shadowBlob.material = shadowMaterial;
        d.focusShadowMaterial = shadowMaterial;
        disposeQueue.push({ dispose: () => shadowMaterial.dispose() });
      });
    }

    function applyResultFocus(d, progress) {
      const eased = easeInOut(progress);
      const scale = d.finalScale + (d.resultScale - d.finalScale) * eased;
      d.mesh.scale.setScalar(scale);
      d.mesh.position.y = supportHeight(d.mesh.quaternion, scale);
      if (d.selectionRing) {
        d.selectionRing.material.opacity = .78 * eased;
        d.selectionRing.scale.setScalar(scale * 1.1);
      }
      if (!d.discarded) return;
      d.opacity = 1 - .72 * eased;
      d.focusMaterials.forEach((state) => {
        state.material.opacity = d.opacity;
        if (state.color) state.material.color.lerpColors(state.color, discardedTint, .38 * eased);
        if (state.roughness != null) state.material.roughness = state.roughness + (.92 - state.roughness) * eased;
        if (state.metalness != null) state.material.metalness = state.metalness * (1 - .82 * eased);
        if (state.clearcoat != null) state.material.clearcoat = state.clearcoat * (1 - .86 * eased);
      });
      if (d.focusShadowMaterial) d.focusShadowMaterial.opacity = .42 - .31 * eased;
    }

    const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const physicsDuration = reducedMotion ? 120 : 1820;
    const settleDuration = reducedMotion ? 260 : 520;
    const focusDuration = mode ? (reducedMotion ? 120 : 420) : 0;
    const settleEnd = physicsDuration + settleDuration;
    const animationDuration = settleEnd + focusDuration;
    root.dataset.resultFocus = mode ? 'pending' : 'none';
    root.dataset.focusDuration = String(focusDuration);
    // 结果面不应在物理阶段结束后才突然校正。滚动到中段便开始极弱引导，
    // 随减速逐渐增强；进入 settle 时只允许留下肉眼不可见的角度残差。
    const orientationGuideStart = reducedMotion ? 0 : 620;
    const orientationLockStart = reducedMotion ? 0 : physicsDuration - 500;
    const t0 = performance.now();
    let lastFrame = t0;
    let physicsSteps = 0;
    const spinAxis = new THREE.Vector3();
    const spinDelta = new THREE.Quaternion();

    function frame(now) {
      const elapsed = now - t0;
      const inPhysics = elapsed < physicsDuration;
      const inSettle = !inPhysics && elapsed < settleEnd;
      const inResultFocus = !!mode && elapsed >= settleEnd;
      const dt = Math.min(.034, Math.max(.001, (now - lastFrame) / 1000));
      lastFrame = now;
      const nextPhase = inPhysics ? 'rolling' : inSettle ? 'settling' : inResultFocus ? 'focus' : 'settling';
      if (animationPhase !== nextPhase) {
        animationPhase = nextPhase;
        updateQueueDiagnostics();
      }
      if (!inPhysics) prepareSettleTargets();
      if (inResultFocus) prepareResultFocus();
      diceData.forEach((d) => {
        if (inPhysics) {
          d.velocity.y -= 14.2 * dt;
          d.mesh.position.addScaledVector(d.velocity, dt);
          const horizontalDrag = Math.exp(-.48 * dt);
          d.velocity.x *= horizontalDrag;d.velocity.z *= horizontalDrag;
          const spinSpeed = d.angularVelocity.length();
          if (spinSpeed > .001) {
            spinAxis.copy(d.angularVelocity).normalize();
            spinDelta.setFromAxisAngle(spinAxis, spinSpeed * dt);
            d.mesh.quaternion.premultiply(spinDelta).normalize();
          }
          if (d.mesh.position.x < -xBound || d.mesh.position.x > xBound) {
            d.mesh.position.x = clampNumber(d.mesh.position.x, -xBound, xBound);d.velocity.x *= -.68;d.angularVelocity.z += d.velocity.x * .45;
          }
          if (d.mesh.position.z < -zBound || d.mesh.position.z > zBound) {
            d.mesh.position.z = clampNumber(d.mesh.position.z, -zBound, zBound);d.velocity.z *= -.68;d.angularVelocity.x -= d.velocity.z * .45;
          }
          const orientationGuideT = clampNumber(
            (elapsed - orientationGuideStart) / Math.max(1, physicsDuration - orientationGuideStart),
            0,
            1
          );
          const orientationLockT = clampNumber(
            (elapsed - orientationLockStart) / Math.max(1, physicsDuration - orientationLockStart),
            0,
            1
          );
          if (orientationGuideT > 0) {
            if (d.guideStartAngularDistance == null) {
              d.guideStartAngularDistance = quaternionAngleDegrees(d.mesh.quaternion, d.qFinal);
            }
            // 先逐步卸掉随机自转，再用连续的球面插值把真实结果“滚”到上方。
            // 指数形式不依赖帧率；前段影响很轻，后段足够强以消除 settle 翻面。
            const angularDampingStrength = reducedMotion
              ? 48
              : 0.8 + 12 * orientationGuideT * orientationGuideT + 8 * orientationLockT * orientationLockT;
            const angularDamping = Math.exp(-angularDampingStrength * dt);
            d.angularVelocity.multiplyScalar(angularDamping);
            // lockT 使用三次曲线从 0 起步，起点的速度与加速度都不会突变；
            // 它只在末 0.5 秒消除多骰碰撞造成的最后几度误差。
            const orientationStrength = reducedMotion
              ? 64
              : 0.65 + 16 * Math.pow(orientationGuideT, 3) + 28 * Math.pow(orientationLockT, 3);
            const orientationBlend = 1 - Math.exp(-orientationStrength * dt);
            d.mesh.quaternion.slerp(d.qFinal, orientationBlend).normalize();
          }
          // 姿态引导会改变多面体的接触高度，所以必须在引导后重新计算桌面支撑面。
          const floorY = supportHeight(d.mesh.quaternion, d.mesh.scale.x);
          if (d.mesh.position.y <= floorY) {
            d.mesh.position.y = floorY;
            if (d.velocity.y < -.35) {d.velocity.y = -d.velocity.y * (.42 + Math.random() * .12);d.bounces++;}
            else d.velocity.y = 0;
            const floorGrip = Math.exp(-2.0 * dt);d.velocity.x *= floorGrip;d.velocity.z *= floorGrip;d.angularVelocity.multiplyScalar(Math.exp(-1.4 * dt));
          }
          // 后半段用柔和的到达速度引导骰子靠近各自落点，避免物理阶段结束后
          // 在半秒内横跨大半张桌面“滑”到预设位置。
          const guideT = clampNumber((elapsed - 480) / Math.max(1, physicsDuration - 480), 0, 1);
          if (guideT > 0) {
            const remainingSeconds = Math.max(.2, (physicsDuration - elapsed) / 1000);
            const desiredX = clampNumber((d.finalPosition.x - d.mesh.position.x) / remainingSeconds, -9, 9);
            const desiredZ = clampNumber((d.finalPosition.z - d.mesh.position.z) / remainingSeconds, -9, 9);
            const velocityBlend = 1 - Math.exp(-(0.9 + 8.5 * guideT * guideT) * dt);
            d.velocity.x += (desiredX - d.velocity.x) * velocityBlend;
            d.velocity.z += (desiredZ - d.velocity.z) * velocityBlend;
          }
        } else {
          if (!d.settlePosition) {
            d.settlePosition = d.mesh.position.clone();
            d.settleQuaternion = d.mesh.quaternion.clone();
            d.settleScale = d.mesh.scale.x;
            d.settleClearance = Math.max(0, d.settlePosition.y - supportHeight(d.settleQuaternion, d.settleScale));
            d.settleAngularDistance = quaternionAngleDegrees(d.settleQuaternion, d.qFinal);
          }
          const settleT = clampNumber((elapsed - physicsDuration) / settleDuration, 0, 1);
          const eased = easeInOut(settleT);
          d.mesh.position.lerpVectors(d.settlePosition, d.finalPosition, eased);
          d.mesh.quaternion.slerpQuaternions(d.settleQuaternion, d.qFinal, eased);
          d.mesh.scale.setScalar(d.settleScale + (d.finalScale - d.settleScale) * easeOut(settleT));
          const currentSupportY = supportHeight(d.mesh.quaternion, d.mesh.scale.x);
          d.mesh.position.y = currentSupportY
            + d.settleClearance * (1 - eased)
            + Math.sin(settleT * Math.PI) * .18 * (1 - settleT);
          if (inResultFocus) {
            const focusT = clampNumber((elapsed - settleEnd) / Math.max(1, focusDuration), 0, 1);
            applyResultFocus(d, focusT);
          }
        }
        const frameAngularStep = quaternionAngleDegrees(d.previousFrameQuaternion, d.mesh.quaternion);
        if (elapsed >= physicsDuration - 420) {
          d.maxLateFrameAngularStep = Math.max(d.maxLateFrameAngularStep, frameAngularStep);
        }
        if (!inPhysics && elapsed <= settleEnd) {
          d.maxSettleFrameAngularStep = Math.max(d.maxSettleFrameAngularStep, frameAngularStep);
        }
        d.previousFrameQuaternion.copy(d.mesh.quaternion);
      });
      if (inPhysics) resolveDiceCollisions();
      diceData.forEach((d) => {
        d.shadowBlob.position.x = d.mesh.position.x;d.shadowBlob.position.z = d.mesh.position.z;
        const floorY = supportHeight(d.mesh.quaternion, d.mesh.scale.x);
        const height = Math.max(0, d.mesh.position.y - floorY), shadowS = Math.max(.5, 1 - height * .18) * d.mesh.scale.x;
        d.shadowBlob.scale.setScalar(shadowS);
      });
      if (inPhysics) physicsSteps++;
      renderer.render(scene, camera);
      if (elapsed < animationDuration) {
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
        root.dataset.continuousSettlePassed = String(diceData.every((d) =>
          (d.settleAngularDistance || 0) <= 1.5 && d.maxSettleFrameAngularStep <= .35
        ));
        root.dataset.resultFocus = mode ? 'complete' : 'none';
        root.dataset.resultScales = diceData.map((d) => d.mesh.scale.x.toFixed(3)).join(',');
        root.dataset.resultOpacities = diceData.map((d) => d.opacity.toFixed(2)).join(',');
        root.dataset.finalMinDistance = finalMinDistance == null ? '' : finalMinDistance.toFixed(3);
        const diagnostic = {
          rollId,
          frontLabels: diceData.map((d) => d.res),
          labels: diceData.map((d) => d.text),
          topLabels: topObservations.map((item) => item.label),
          topScores: topObservations.map((item) => Math.round(item.score * 10000) / 10000),
          faceLockPassed: topObservations.every((item, index) => item.label === String(diceData[index].text)),
          faceTexts: diceData[0] ? diceData[0].faceTexts : [],
          opacities: diceData.map((d) => d.opacity),
          diceScale: perScale,
          countScale,
          resultScales: diceData.map((d) => Math.round(d.mesh.scale.x * 1000) / 1000),
          preFocusOpacities: diceData.map(() => 1),
          focusApplied: !!mode && resultFocusPrepared,
          focusStartedAfterSettle: !!mode && resultFocusPrepared,
          focusDuration,
          resultHoldMs: RESULT_HOLD_MS,
          maxAnimatedDice: MAX_ANIMATED_DICE,
          labelMode: 'face-texture',
          labelTextures: diceData.reduce((sum, d) => sum + d.labelTextures, 0),
          groundClearances: diceData.map((d) => Math.round((d.mesh.position.y - supportHeight(d.mesh.quaternion, d.mesh.scale.x)) * 10000) / 10000),
          canvasSize: [canvasW, canvasH],
          layout: diceData.map((d) => [Math.round(d.finalPosition.x * 100) / 100, Math.round(d.finalPosition.z * 100) / 100]),
          plannedLayout: layout.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
          total,
          pick,
          N,
          requestedDisplayCount,
          omittedDisplayCount,
          natural,
          crit: critical,
          physics: true,
          physicsSteps,
          duration: animationDuration,
          throwEdge: throwEdgeName,
          skin: skin.key,
          sizeMultiplier: DICE_SIZE_MULTIPLIER,
          d20ResultTiltDegrees: key === 'd20' ? D20_RESULT_TILT_DEGREES : 0,
          layoutGrid: [adaptiveColumns(N), Math.ceil(N / adaptiveColumns(N))],
          spawnGrid: [spawnColumns, spawnRows],
          collisionDistance: Math.round(collisionDiameter * 100) / 100,
          collisionCount: diceCollisionCount,
          bounces: diceData.map((d) => d.bounces),
          settleTravelDistances: diceData.map((d) => {
            if (!d.settlePosition) return 0;
            return Math.round(Math.hypot(
              d.settlePosition.x - d.finalPosition.x,
              d.settlePosition.z - d.finalPosition.z
            ) * 100) / 100;
          }),
          guideStartAngularDistances: diceData.map((d) => Math.round((d.guideStartAngularDistance || 0) * 100) / 100),
          settleAngularDistances: diceData.map((d) => Math.round((d.settleAngularDistance || 0) * 100) / 100),
          maxLateFrameAngularSteps: diceData.map((d) => Math.round(d.maxLateFrameAngularStep * 100) / 100),
          maxSettleFrameAngularSteps: diceData.map((d) => Math.round(d.maxSettleFrameAngularStep * 100) / 100),
          continuousSettlePassed: diceData.every((d) =>
            (d.settleAngularDistance || 0) <= 1.5 && d.maxSettleFrameAngularStep <= .35
          ),
          startMinDistance: startMinDistance == null ? null : Math.round(startMinDistance * 100) / 100,
          finalMinDistance: finalMinDistance == null ? null : Math.round(finalMinDistance * 100) / 100,
          startPositions: diceData.map((d) => d.startPosition.toArray().map((v) => Math.round(v * 100) / 100)),
          endPositions: diceData.map((d) => d.finalPosition.toArray().map((v) => Math.round(v * 100) / 100)),
          chosenIndex: pick,
          queueRemaining: rollQueue.length,
          droppedQueuedRolls,
          interruptedRolls,
        };
        if (isD4) {
          const r0 = diceData[0].res;
          const v = new THREE.Vector3(poly.verts[r0 - 1][0], poly.verts[r0 - 1][1], poly.verts[r0 - 1][2]).normalize();
          diagnostic.apexUpScore = v.applyQuaternion(diceData[0].qFinal).y;
        }
        if (isD4) {
          diagnostic.d4Corners = POLY.d4.faces.map((f) => f.map((vi) => vi + 1));
          diagnostic.d4Faces = POLY.d4.faces.map((f) => f.slice());
        }
        let text = `${label || '掷骰'} → ${total}`;
        if (sides === 100) text += `（${diceData.map((d) => d.text).join(' + ')}）`;
        else if (mode !== 0) text += `（取 ${rawDice[pick]}）`;
        else if (N > 1) text += `（${diceData.map((d) => d.text).join(' + ')}）`;
        if (omittedDisplayCount > 0) {
          text += sides === 100
            ? ` · 动画显示前 ${Math.floor(N / 2)} 组，共 ${rawDice.length} 组`
            : ` · 动画显示前 ${N} 颗，共 ${rawDice.length} 颗`;
        }
        if (critical === 'success') {
          showCrit(root, 'success', '大成功！');
          text = '⚡ 大成功！' + text;
        } else if (critical === 'fail') {
          showCrit(root, 'fail', '大失败！');
          text = '💥 大失败！' + text;
        }
        const detailText = mode !== 0 && rawDice.length >= 2
          ? `${mode === 1 ? '优势' : '劣势'}：取 ${rawDice[pick]} · 舍 ${rawDice[pick === 0 ? 1 : 0]}`
          : '';
        const controls = buildResultCard(resultDiv, text, detailText);
        resultDiv.classList.add('show');
        animationPhase = 'result';
        updateQueueDiagnostics();
        publishDiceCompletion(diagnostic);
        armResultDismiss(root, resultDiv, controls);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  window.playDieAnimation = enqueueDieAnimation;
  window.SundollDiceSkins = Object.freeze({
    skins: DICE_SKINS,
    list: () => Object.values(DICE_SKINS).map((skin) => ({ key: skin.key, label: skin.label, swatch: skin.swatch, accent: skin.accent })),
    get: () => activeSkinKey,
    set: (key) => setDiceSkin(key, true),
  });
  window.__DICE_POLY__ = POLY;
  window.__DICE_LAST__ = null;
  window.__DICE_HISTORY__ = [];
  updateQueueDiagnostics();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installDiceSkinPickers, { once: true });
  else installDiceSkinPickers();
})();
