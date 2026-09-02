/*
 * 桑哆尔地图共享材质渲染器
 * AI 纹理只作为静态美术资源；格子结构、变体选择与边缘仍由 Canvas 决定。
 */
(function initSundollTileRenderer(global) {
  'use strict';

  const scriptUrl = document.currentScript && document.currentScript.src;
  const assetUrl = (file) => new URL(`材质/${file}`, scriptUrl || window.location.href).href;
  const MATERIALS = {
    floor: {
      variants: [
        { file: 'stone-floor.png', label: '石板·样式 I' },
        { file: 'stone-floor-v2.png', label: '石板·样式 II' },
      ],
      fallback: '#8f8574', crop: .34, overlay: 'rgba(22,27,33,.08)',
    },
    wood: {
      variants: [
        { file: 'wood-floor.png', label: '木地板·样式 I' },
        { file: 'wood-floor-v2.png', label: '木地板·样式 II' },
      ],
      fallback: '#a97c50', crop: .34, overlay: 'rgba(46,26,10,.06)',
    },
    grass: {
      variants: [
        { file: 'grass.png', label: '草地·样式 I' },
        { file: 'grass-v2.png', label: '草地·样式 II' },
      ],
      fallback: '#7da05c', crop: .34, overlay: 'rgba(20,45,18,.06)',
    },
    road: {
      variants: [
        { file: 'dirt-road.png', label: '土路·样式 I' },
        { file: 'dirt-road-v2.png', label: '土路·样式 II' },
      ],
      fallback: '#a8754d', crop: .34, overlay: 'rgba(48,28,12,.04)',
    },
    water: {
      variants: [
        { file: 'water.png', label: '水面·样式 I' },
        { file: 'water-v2.png', label: '水面·样式 II' },
      ],
      fallback: '#4f8fc2', crop: .34, overlay: 'rgba(7,32,53,.10)',
    },
    wall: {
      variants: [
        { file: 'stone-wall.png', label: '石墙·样式 I' },
        { file: 'stone-wall-v2.png', label: '石墙·样式 II' },
      ],
      fallback: '#5c6068', crop: .34, overlay: 'rgba(8,12,15,.16)', wall: true,
    },
  };
  const images = new Map();
  const readyListeners = new Set();

  function stableNumber(x, y, salt) {
    let h = (Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263) + Math.imul(salt + 1, 1274126177)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  function notifyReady() {
    readyListeners.forEach((listener) => listener());
  }

  function variantIndex(material, requestedVariant) {
    const index = Number.parseInt(requestedVariant, 10);
    if (Number.isInteger(index) && index >= 0 && index < material.variants.length) return index;
    // 旧地图没有记录变体编号：统一回退到样式 I，而不是再次随机选择。
    return 0;
  }

  function imageFor(id, x, y, requestedVariant) {
    const material = MATERIALS[id];
    if (!material) return null;
    const file = material.variants[variantIndex(material, requestedVariant)].file;
    if (!images.has(file)) {
      const image = new Image();
      image.decoding = 'async';
      image.onload = notifyReady;
      image.onerror = notifyReady;
      image.src = assetUrl(file);
      images.set(file, image);
    }
    return images.get(file);
  }

  function drawTextureCrop(g, image, px, py, size, x, y, crop) {
    const sourceSize = Math.max(1, Math.floor(image.naturalWidth * crop));
    const maxX = Math.max(1, image.naturalWidth - sourceSize);
    const maxY = Math.max(1, image.naturalHeight - sourceSize);
    const seed = stableNumber(x, y, 41);
    const sourceX = (x * sourceSize + (seed % Math.max(1, Math.floor(sourceSize / 3)))) % maxX;
    const sourceY = (y * sourceSize + (Math.floor(seed / 11) % Math.max(1, Math.floor(sourceSize / 3)))) % maxY;
    g.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, px, py, size, size);
  }

  function drawWallEdges(g, px, py, size, neighbors) {
    const edge = Math.max(1, size * .075);
    const connected = (direction) => Boolean(neighbors && (neighbors[direction] === true || neighbors[direction] === 'wall'));
    g.save();
    g.lineCap = 'square';
    g.lineWidth = edge;
    g.strokeStyle = 'rgba(0,0,0,.5)';
    if (!connected('north')) { g.beginPath(); g.moveTo(px, py); g.lineTo(px + size, py); g.stroke(); }
    if (!connected('west')) { g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + size); g.stroke(); }
    g.strokeStyle = 'rgba(0,0,0,.3)';
    if (!connected('south')) { g.beginPath(); g.moveTo(px, py + size); g.lineTo(px + size, py + size); g.stroke(); }
    if (!connected('east')) { g.beginPath(); g.moveTo(px + size, py); g.lineTo(px + size, py + size); g.stroke(); }
    g.restore();
  }

  function drawWaterEdges(g, px, py, size, neighbors) {
    const shore = Math.max(1, size * .065);
    const isWater = (direction) => neighbors && (neighbors[direction] === 'water' || neighbors[direction] === 'bridge');
    g.save();
    g.lineCap = 'round';
    g.lineWidth = shore;
    g.strokeStyle = 'rgba(218, 244, 255, .48)';
    if (!isWater('north')) { g.beginPath(); g.moveTo(px + size * .12, py + shore); g.lineTo(px + size * .88, py + shore); g.stroke(); }
    if (!isWater('south')) { g.beginPath(); g.moveTo(px + size * .12, py + size - shore); g.lineTo(px + size * .88, py + size - shore); g.stroke(); }
    if (!isWater('west')) { g.beginPath(); g.moveTo(px + shore, py + size * .12); g.lineTo(px + shore, py + size * .88); g.stroke(); }
    if (!isWater('east')) { g.beginPath(); g.moveTo(px + size - shore, py + size * .12); g.lineTo(px + size - shore, py + size * .88); g.stroke(); }
    g.restore();
  }

  function drawRoadEdges(g, px, py, size, neighbors) {
    if (!neighbors) return;
    const grass = (direction) => neighbors[direction] === 'grass';
    const edge = Math.max(1, size * .045);
    g.save();
    g.lineWidth = edge;
    g.strokeStyle = 'rgba(55, 82, 36, .32)';
    if (grass('north')) { g.beginPath(); g.moveTo(px, py + edge); g.lineTo(px + size, py + edge); g.stroke(); }
    if (grass('south')) { g.beginPath(); g.moveTo(px, py + size - edge); g.lineTo(px + size, py + size - edge); g.stroke(); }
    if (grass('west')) { g.beginPath(); g.moveTo(px + edge, py); g.lineTo(px + edge, py + size); g.stroke(); }
    if (grass('east')) { g.beginPath(); g.moveTo(px + size - edge, py); g.lineTo(px + size - edge, py + size); g.stroke(); }
    g.restore();
  }

  function drawMaterial(g, px, py, size, id, options = {}) {
    const material = MATERIALS[id];
    if (!material) return false;
    const x = Number.isFinite(options.x) ? options.x : Math.round(px / size);
    const y = Number.isFinite(options.y) ? options.y : Math.round(py / size);
    const image = imageFor(id, x, y, options.variant);
    g.fillStyle = material.fallback;
    g.fillRect(px, py, size, size);
    if (image && image.complete && image.naturalWidth) {
      drawTextureCrop(g, image, px, py, size, x, y, material.crop);
      if (material.overlay) {
        g.fillStyle = material.overlay;
        g.fillRect(px, py, size, size);
      }
    }
    if (material.wall) drawWallEdges(g, px, py, size, options.neighbors);
    if (id === 'water') drawWaterEdges(g, px, py, size, options.neighbors);
    if (id === 'road') drawRoadEdges(g, px, py, size, options.neighbors);
    return true;
  }

  global.SundollTileRenderer = {
    drawMaterial,
    isAiMaterial: (id) => Boolean(MATERIALS[id]),
    getVariants(id) {
      const material = MATERIALS[id];
      return material
        ? material.variants.map((variant, index) => ({ index, label: variant.label, file: variant.file }))
        : [];
    },
    onReady(listener) {
      if (typeof listener === 'function') readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    materials: Object.freeze(Object.keys(MATERIALS)),
  };
})(window);
