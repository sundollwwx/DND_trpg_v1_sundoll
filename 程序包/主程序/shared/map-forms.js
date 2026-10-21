/* Map forms contain background images only. Scene state belongs to the map. */
(function(root) {
  'use strict';
  function list(map) {
    const seen = new Set();
    return (Array.isArray(map.mapForms) ? map.mapForms : []).filter(f => {
      if (!f || typeof f.id !== 'string' || seen.has(f.id) || typeof f.mapData !== 'string' || !f.mapData) return false;
      seen.add(f.id); return true;
    }).map(f => ({id:f.id, name:String(f.name || '未命名形态'), mapData:f.mapData}));
  }
  function fields(map) {
    const forms = list(map);
    if (!forms.length) return {};
    const current = forms.find(f => f.id === map.activeMapFormId) || forms.find(f => f.mapData === map.mapData) || forms[0];
    return {mapForms:forms, activeMapFormId:current.id, mapData:current.mapData};
  }
  function ensure(map) {
    const data = fields(map);
    if (data.mapForms) Object.assign(map,data);
    else {
      if (!map.mapData || map.cells) throw new Error('仅图片地图支持形态；请先载入地图图片');
      map.mapForms=[{id:'original',name:'原始形态',mapData:map.mapData}];
      map.activeMapFormId='original';
    }
    return map.mapForms;
  }
  function add(map, form, width, height) {
    if (Number(width)!==Number(map.mapW) || Number(height)!==Number(map.mapH)) throw new Error(`形态图片必须与地图尺寸一致：${map.mapW} × ${map.mapH}`);
    if (!form || !form.id || !form.mapData) throw new Error('形态图片无效');
    if (list(map).some(f=>f.id===form.id)) throw new Error('形态编号重复');
    ensure(map).push({id:form.id,name:String(form.name||'新形态'),mapData:form.mapData});
  }
  function apply(map,id) {
    const form=list(map).find(f=>f.id===id);
    if(!form) throw new Error('形态不存在，请重新打开地图册');
    // Intentionally change only the background, keeping every live scene field intact.
    map.activeMapFormId=form.id; map.mapData=form.mapData;
    return form;
  }
  const api={list,fields,ensure,add,apply};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SundollMapForms=api;
})(typeof window!=='undefined'?window:this);
