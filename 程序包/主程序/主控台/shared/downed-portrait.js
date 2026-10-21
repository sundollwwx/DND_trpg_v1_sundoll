(function (root) {
  'use strict';

  const fields = ['iconImgPath', 'iconImg', 'iconImgHd', 'iconImgId'];
  const memoryHashes = new Map();
  function identity(source) {
    if (!source) return '';
    if (source.iconImgPath) return 'iconImgPath:' + String(source.iconImgPath).replace(/\\/g, '/');
    for (const field of fields.slice(1)) if (source[field]) return field + ':' + String(source[field]);
    return '';
  }
  function samePortrait(first,second) {
    const image=identity(first);
    return !!image&&image===identity(second)
      && root.SundollPortraitView.sameView(first?.portraitView,second?.portraitView);
  }
  function beforeImage(source) {
    if(!source)return '';
    if(source.iconImgPath)return identity(source);
    if(source.iconImgId)return 'iconImgId:'+String(source.iconImgId);
    for(const field of ['iconImg','iconImgHd']) {
      if(!source[field])continue;
      const value=String(source[field]);let digest=memoryHashes.get(value);
      // This compact fingerprint is only for restoring a form, never authorization.
      if(!digest) {
        let hash=14695981039346656037n;
        for(let i=0;i<value.length;i++) {
          const code=value.charCodeAt(i);
          hash=BigInt.asUintN(64,(hash^BigInt(code&255))*1099511628211n);
          hash=BigInt.asUintN(64,(hash^BigInt(code>>>8))*1099511628211n);
        }
        digest=hash.toString(16).padStart(16,'0');
        if(memoryHashes.size>=8)memoryHashes.delete(memoryHashes.keys().next().value);
        memoryHashes.set(value,digest);
      }
      return field+':fnv64:'+digest;
    }
    return '';
  }
  function beforeIdentity(source) {
    const image=beforeImage(source),portraitView=root.SundollPortraitView.normalize(source?.portraitView);
    return portraitView?JSON.stringify({image,portraitView}):image;
  }
  function matchesBefore(source,previous) {
    if(!previous)return false;
    if(typeof previous==='string'&&previous.startsWith('{')) {
      try {
        const saved=JSON.parse(previous);
        return (beforeImage(source)===saved.image||identity(source)===saved.image)
          && root.SundollPortraitView.sameView(source?.portraitView,saved.portraitView);
      } catch (_) { return false; }
    }
    return beforeImage(source)===previous||identity(source)===previous;
  }
  function sync(token) {
    if (!token || !(token.ownedPieceId || token.type === 'pc')) return false;
    const forms = Array.isArray(token.portraitVariants) ? token.portraitVariants : [];
    const down = forms.findIndex(form => String(form?.name || '').trim().startsWith('倒地'));
    if (down < 0) return false;
    const current = identity(token);
    if (!identity(forms[down])) return false;
    const hinted=Number.isInteger(token.portraitVariant)?token.portraitVariant:-1;
    const atDown=hinted>=0&&hinted<forms.length&&samePortrait(token,forms[hinted])
      ?hinted===down:samePortrait(token,forms[down]);
    let target = -1;
    if (Number(token.hp) <= 0) {
      if (atDown) return false;
      if (current) token.portraitBeforeDowned = beforeIdentity(token);
      target = down;
    } else if (atDown) {
      target = forms.findIndex((form, index) => index !== down && matchesBefore(form,token.portraitBeforeDowned));
      if (target < 0) target = forms.findIndex((form, index) => index !== down && identity(form));
      if (target < 0) return false;
      delete token.portraitBeforeDowned;
    } else {
      if (token.portraitBeforeDowned) delete token.portraitBeforeDowned;
      return false;
    }
    for (const field of fields) token[field] = forms[target][field] || null;
    const portraitView = root.SundollPortraitView?.normalize(forms[target].portraitView);
    if (portraitView) token.portraitView = portraitView;
    else delete token.portraitView;
    token.portraitVariant = target;
    return true;
  }
  root.SundollDownedPortrait = { sync, identity, memoryIdentity:beforeImage };
})(typeof window === 'object' ? window : globalThis);
