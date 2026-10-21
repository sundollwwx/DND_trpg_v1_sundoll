/* Pure quote helper. Rates are supplied by the general package, in copper. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SundollLifestyle = factory();
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  function whole(value, min, max) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('请填写范围内的整数');
    return n;
  }
  function money(cp) {
    if (!Number.isSafeInteger(cp) || cp < 0) throw Error('金额无效');
    if (!cp) return '0 铜币';
    return [[100,'金币'],[10,'银币'],[1,'铜币']].flatMap(([unit,label]) => {
      const count = Math.floor(cp / unit); cp %= unit;
      return count ? [count + ' ' + label] : [];
    }).join(' ');
  }
  function quote(data, options) {
    const expenses = data.expenses;
    const people = whole(options.people, 1, 100);
    const days = whole(options.days, 1, 365);
    if (options.mode === 'lifestyle') {
      const tier = expenses.lifestyles.find(t => t.id === options.tier);
      if (!tier) throw Error('生活档位无效');
      const totalCp = people * days * tier.dailyCp;
      return {totalCp, minimum:tier.id === 'aristocratic', lines:[{label:tier.name+'生活费（含基础食宿）', cp:totalCp}], note:tier.id === 'wretched' ? '赤贫的 0 金币不保证有食物、饮水或住所。' : '已包含基础食宿；不要再重复收同档餐费与房费。'};
    }
    if (options.mode !== 'itemized') throw Error('计价方式无效');
    const meal = expenses.meals.find(t => t.tier === options.mealTier);
    const room = expenses.lodging.find(t => t.tier === options.roomTier);
    if (!meal || !room) throw Error('食宿档位无效');
    const meals = whole(options.mealsPerDay, 0, 6), nights = whole(options.nights, 0, 365);
    const lines = [{label:'餐食 · '+(people*days*meals)+' 人餐',cp:people*days*meals*meal.perMealCp}, {label:'住宿 · '+(people*nights)+' 人夜',cp:people*nights*room.perNightCp}];
    return {totalCp:lines.reduce((sum,l)=>sum+l.cp,0), minimum:false, lines, note:'只计所选食宿；额外酒水另点。这不是完整生活开销，餐数也不等于营养判定。'};
  }
  return {money,quote};
});
