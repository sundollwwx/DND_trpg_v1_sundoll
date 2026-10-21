/* Shared pure game rules. Browser and Node use this same implementation. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SundollRules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
  const SPELL_RANGE_STEP_FEET=5, SPELL_RANGE_MIN_FEET=5, SPELL_RANGE_MAX_FEET=180;
function sameTurnPoint(a, b) {
  return Math.abs(Number(a?.x) - Number(b?.x)) < 0.01 && Math.abs(Number(a?.y) - Number(b?.y)) < 0.01;
}

function normalizeTurnPathSegmentEnds(rawEnds, pointCount) {
  const lastPointIndex = Math.max(0, Math.trunc(Number(pointCount) || 0) - 1);
  if (lastPointIndex < 1) return [];
  const ends = [];
  (Array.isArray(rawEnds) ? rawEnds : []).forEach((raw) => {
    const end = Math.trunc(Number(raw));
    if (Number.isInteger(end) && end >= 1 && end <= lastPointIndex && end > (ends[ends.length - 1] || 0)) ends.push(end);
  });
  // 旧客户端只有 points：把现有路径视为一次已经松开鼠标的移动。
  if (!ends.length || ends[ends.length - 1] !== lastPointIndex) ends.push(lastPointIndex);
  return ends;
}

function turnPathEdgeKey(a, b) {
  const pointKey = (point) => `${Math.round(Number(point.x) * 10) / 10},${Math.round(Number(point.y) * 10) / 10}`;
  const left = pointKey(a);
  const right = pointKey(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function turnPathEdgeCounts(...paths) {
  const counts = new Map();
  paths.forEach((points) => {
    if (!Array.isArray(points)) return;
    for (let index = 1; index < points.length; index++) {
      if (sameTurnPoint(points[index - 1], points[index])) continue;
      const key = turnPathEdgeKey(points[index - 1], points[index]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  return counts;
}

function normalizeSpellRange(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const shape = source.shape === 'radius' || source.shape === 'cone' ? source.shape : 'off';
  const rawFeet = Number(source.feet);
  const feet = clamp(
    Math.round((Number.isFinite(rawFeet) ? rawFeet : 30) / SPELL_RANGE_STEP_FEET) * SPELL_RANGE_STEP_FEET,
    SPELL_RANGE_MIN_FEET,
    SPELL_RANGE_MAX_FEET,
  );
  const rawDirection = Number(source.direction);
  const direction = Number.isFinite(rawDirection)
    ? ((Math.round(rawDirection / 5) * 5) % 360 + 360) % 360
    : 0;
  return { shape, feet, direction };
}

function normalizeInitiativePortrait(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = { iconImgPath: null, iconImg: null, iconImgHd: null, iconImgId: null };
  const imageSource = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const source = value.trim().replace(/\\/g, '/');
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(source)) {
      return source.length <= Math.ceil(16 * 1024 * 1024 * 4 / 3) + 64 ? source : null;
    }
    if (/[\x00-\x1f]/.test(source) || source.length > 2048) return null;
    if (/^https?:\/\//i.test(source)) {
      try {
        const url = new URL(source);
        return url.username || url.password ? null : source;
      } catch (_) { return null; }
    }
    if (/^\/api\/(?:module-assets|assets|player-art)\/[a-f0-9]{64}(?:\?[^#]*)?$/.test(source)) return source;
    const relative = source.replace(/^(?:\.\.\/)?\/?(?:asset|assets)\/棋子库\//, '').replace(/^棋子库\//, '');
    let decoded;
    try { decoded = decodeURIComponent(relative).replace(/\\/g, '/'); } catch (_) { return null; }
    if (decoded.startsWith('/') || decoded.split('/').some((part) => part === '..') || /[\x00-\x1f:]/.test(decoded)) return null;
    return /^(?:立绘|显示缓存)\/.+\.(?:png|jpe?g|webp|gif)$/i.test(decoded) ? relative : null;
  };
  for (const key of ['iconImgPath', 'iconImg', 'iconImgHd']) result[key] = imageSource(raw[key]);
  if (typeof raw.iconImgId === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(raw.iconImgId)) result.iconImgId = raw.iconImgId;
  if (!Object.values(result).some(Boolean)) return null;
  if (result.iconImgPath) result.iconImg = result.iconImgHd = result.iconImgId = null;
  return result;
}

function initiativeSwapAllowed(encounter) {
  return encounter?.allowInitiativeSwap !== false;
}

function normalizeInitiativeEntryOrders(raw) {
  const entries = Array.isArray(raw) ? raw : [];
  const orders = entries.map((entry) => {
    const value = entry?.order;
    return (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value))
      ? Number(value) : null;
  });
  const valid = orders.every((order) => order !== null);
  const repair = !valid || new Set(orders).size !== orders.length;
  return entries.map((entry, index) => ({ ...entry, order: repair ? index : orders[index] }));
}

function snapMeasurePoint(p,map,zoom=1) {
  if(!map||!p)return p;
  const grid=Number(map.gridSize)||50,scale=Math.max(.2,Number(zoom)||1);
  const ox=Number(map.gridOffsetX)||0,oy=Number(map.gridOffsetY)||0;
  const intersections={x:Math.round((p.x-ox)/grid)*grid+ox,y:Math.round((p.y-oy)/grid)*grid+oy};
  const centers={x:Math.round((p.x-ox)/grid-.5)*grid+grid/2+ox,y:Math.round((p.y-oy)/grid-.5)*grid+grid/2+oy};
  const snapped=Math.hypot(p.x-intersections.x,p.y-intersections.y)<=Math.hypot(p.x-centers.x,p.y-centers.y)?intersections:centers;
  return Math.hypot(p.x-snapped.x,p.y-snapped.y)<=Math.min(grid*.35,14/scale)?snapped:p;
}
function measureGridFeet(from,to,gridSize) {
    const grid=Number(gridSize)>0?Number(gridSize):50;
    const dx=Math.abs(Number(to.x)-Number(from.x))/grid,dy=Math.abs(Number(to.y)-Number(from.y))/grid;
    if(!Number.isFinite(dx)||!Number.isFinite(dy))return 0;
    const diagonal=Math.min(dx,dy),straight=Math.max(dx,dy)-diagonal;
    // 两次斜行合计三格；不足整格时按当前这一格的费用比例计算。
    const pairs=Math.floor(diagonal/2),remainder=diagonal-pairs*2;
    return (straight+pairs*3+Math.min(remainder,1)+Math.max(0,remainder-1)*2)*5;
  }
function normalizeMapCover(raw){const cells={};if(raw&&typeof raw.cells==='object'&&raw.cells)for(const [key,value] of Object.entries(raw.cells).slice(0,100000))if(/^-?\d{1,6},-?\d{1,6}$/.test(key)&&value===true)cells[key]=true;return {all:raw?.all===true,cells};}
function mapCoverCell(map,x,y){const g=Math.max(1,Number(map.gridSize)||50);return [Math.floor((x-(Number(map.gridOffsetX)||0))/g),Math.floor((y-(Number(map.gridOffsetY)||0))/g)];}
function mapPointCovered(map,x,y){const c=map?.gridCover;if(!c)return false;const key=mapCoverCell(map,x,y).join(',');return !!c.all!==!!c.cells?.[key];}
function mapCoverBrushCells(map,col,row,size=1,shape='square'){
 const n=[1,3,5,9].includes(Number(size))?Number(size):1,r=Math.floor(n/2),g=Math.max(1,Number(map.gridSize)||50),ox=Number(map.gridOffsetX)||0,oy=Number(map.gridOffsetY)||0,keys=[];
 for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){
  if(shape==='circle'&&dx*dx+dy*dy>(n/2)**2)continue;
  const x=col+dx,y=row+dy;if(x*g+ox>=map.mapW||y*g+oy>=map.mapH||(x+1)*g+ox<=0||(y+1)*g+oy<=0)continue;keys.push(x+','+y);
 }return keys;
}
function mapCoverSignature(map){if(!map)return '';const c=map.gridCover;return JSON.stringify([Number(map.mapW)||1400,Number(map.mapH)||900,Math.max(1,Number(map.gridSize)||50),Number(map.gridOffsetX)||0,Number(map.gridOffsetY)||0,!!c?.all,Object.keys(c?.cells||{}).sort()]);}
function mapCoverPath(map){if(!map)return '';const c=map.gridCover;if(!c)return '';const w=Number(map.mapW)||1400,h=Number(map.mapH)||900,g=Math.max(1,Number(map.gridSize)||50),ox=Number(map.gridOffsetX)||0,oy=Number(map.gridOffsetY)||0;const rect=(x,y,r,b)=>r>x&&b>y?`M${x} ${y}H${r}V${b}H${x}Z`:'';let d=c.all?rect(0,0,w,h):'';for(const key of Object.keys(c.cells||{})){const [col,row]=key.split(',').map(Number),x=col*g+ox,y=row*g+oy;d+=rect(Math.max(0,x),Math.max(0,y),Math.min(w,x+g),Math.min(h,y+g));}return d;}

return Object.freeze({initiativeSwapAllowed,normalizeInitiativeEntryOrders,normalizeInitiativePortrait,normalizeMapCover,mapCoverBrushCells,mapCoverCell,mapPointCovered,mapCoverSignature,mapCoverPath,sameTurnPoint,normalizeTurnPathSegmentEnds,turnPathEdgeKey,turnPathEdgeCounts,normalizeSpellRange,measureGridFeet,snapMeasurePoint});
});
