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
return Object.freeze({sameTurnPoint,normalizeTurnPathSegmentEnds,turnPathEdgeKey,turnPathEdgeCounts,normalizeSpellRange,measureGridFeet,snapMeasurePoint});
});
