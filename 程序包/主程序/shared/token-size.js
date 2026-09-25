/* Physical footprint and creature rank are distinct: small and medium share one cell. */
globalThis.SundollSize = (() => {
  const categories = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];
  const labels = ['微型', '小型', '中型', '大型', '超大型', '巨大型'];
  const footprints = [.5, 1, 1, 2, 3, 4];
  function category(token = {}) {
    if (categories.includes(token.sizeCategory)) return token.sizeCategory;
    return ({'.5':'tiny','0.5':'tiny','2':'large','3':'huge','4':'gargantuan'})[token.size] || 'medium';
  }
  const rank = token => categories.indexOf(category(token));
  const footprint = token => footprints[rank(token)];
  const normalize = token => ({sizeCategory: category(token), size: footprint(token)});
  const canRide = (rider, mount) => !!rider && !!mount && rider !== mount && rank(mount) > rank(rider);
  function snap(value, grid, size, offset = 0) {
    const step = size === .5 ? grid / 2 : grid;
    const phase = size === .5 ? grid / 4 : (size % 2 ? grid / 2 : 0);
    return offset + phase + Math.round((value - offset - phase) / step) * step;
  }
  function anchor(token, map) {
    const seen = new Set();
    while (token?.mountId && !seen.has(token.id)) {
      seen.add(token.id);
      const mount = (map?.tokens || []).find(t => t.id === token.mountId);
      if (!canRide(token, mount)) break;
      token = mount;
    }
    return token;
  }
  function point(map, token, x, y, snapped = true) {
    const grid = Number(map.gridSize) || 50, size = footprint(token);
    function axis(value, extent, offset) {
      const margin = Math.min(size * grid / 2, extent / 2);
      if (!snapped) return Math.max(margin, Math.min(extent - margin, value));
      const step = size === .5 ? grid / 2 : grid;
      const phase = offset + (size === .5 ? grid / 4 : size % 2 ? grid / 2 : 0);
      const low = phase + Math.ceil((margin - phase) / step) * step;
      const high = phase + Math.floor((extent - margin - phase) / step) * step;
      return low > high ? extent / 2 : Math.max(low, Math.min(high, snap(value, grid, size, offset)));
    }
    return {x: axis(x, map.mapW, Number(map.gridOffsetX)||0), y: axis(y, map.mapH, Number(map.gridOffsetY)||0)};
  }
  function riders(token, map) {
    return (map?.tokens || []).filter(t => t !== token && anchor(t, map)?.id === token.id);
  }
  function repair(map) {
    for (const token of map?.tokens || []) {
      Object.assign(token, normalize(token));
      if (token.mountId && !canRide(token, map.tokens.find(t => t.id === token.mountId))) token.mountId = null;
    }
    for (const token of map?.tokens || []) {
      const root = anchor(token, map);
      if (root !== token) { token.x = root.x; token.y = root.y; }
    }
  }
  return {categories, labels, footprints, category, rank, footprint, normalize, canRide, snap, point, anchor, riders, repair};
})();
