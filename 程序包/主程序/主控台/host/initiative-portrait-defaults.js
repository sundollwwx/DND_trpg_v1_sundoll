/* Approved portrait defaults. A saved assignment or form override always wins. */
window.SundollInitiativePortraitDefaults = (() => {
  let config = {};
  try {
    const node = typeof document === 'object' && document.getElementById('sundoll-initiative-portrait-defaults');
    config = node ? JSON.parse(node.textContent || '{}') : {};
  } catch { /* Optional room defaults may be absent in a clean installation. */ }
  function configured(group, identity) {
    const entries = config && typeof config === 'object' && config[group];
    if (!entries || typeof entries !== 'object' || !Object.prototype.hasOwnProperty.call(entries, identity)) return null;
    const path = entries[identity];
    return typeof path === 'string' && /^\/api\/module-assets\/[a-f0-9]{64}$/.test(path) ? path : null;
  }
  function forToken(token) {
    if (!token || token.initiativePortraitDefaultsApplied === true) return null;
    // An owned role uses its own identity; unrelated library presets cannot lend it art.
    const path = token.ownedPieceId ? configured('owned', token.ownedPieceId) : configured('presets', token.presetId || token.sourcePresetId);
    return path ? { iconImgPath: path } : null;
  }
  function assign(token) {
    if (!token || token.initiativePortraitDefaultsApplied === true) return false;
    const portrait = forToken(token);
    if (!portrait) return false;
    if (!token.initiativePortrait) token.initiativePortrait = portrait;
    token.initiativePortraitDefaultsApplied = true;
    return true;
  }
  return { forToken, assign };
})();
