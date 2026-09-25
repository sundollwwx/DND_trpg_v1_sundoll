(function (root) {
  'use strict';

  const fields = ['iconImgPath', 'iconImg', 'iconImgHd', 'iconImgId'];
  function identity(source) {
    if (!source) return '';
    if (source.iconImgPath) return 'iconImgPath:' + String(source.iconImgPath).replace(/\\/g, '/');
    for (const field of fields.slice(1)) if (source[field]) return field + ':' + String(source[field]);
    return '';
  }
  function sync(token) {
    if (!token || !(token.ownedPieceId || token.type === 'pc')) return false;
    const forms = Array.isArray(token.portraitVariants) ? token.portraitVariants : [];
    const down = forms.findIndex(form => String(form?.name || '').trim().startsWith('倒地'));
    if (down < 0) return false;
    const current = identity(token);
    const downId = identity(forms[down]);
    if (!downId) return false;
    let target = -1;
    if (Number(token.hp) <= 0) {
      if (current === downId) return false;
      if (current) token.portraitBeforeDowned = current;
      target = down;
    } else if (current === downId) {
      target = forms.findIndex((form, index) => index !== down && identity(form) === token.portraitBeforeDowned);
      if (target < 0) target = forms.findIndex((form, index) => index !== down && identity(form));
      if (target < 0) return false;
      delete token.portraitBeforeDowned;
    } else {
      if (token.portraitBeforeDowned) delete token.portraitBeforeDowned;
      return false;
    }
    for (const field of fields) token[field] = forms[target][field] || null;
    token.portraitVariant = target;
    return true;
  }
  root.SundollDownedPortrait = { sync, identity };
})(typeof window === 'object' ? window : globalThis);
