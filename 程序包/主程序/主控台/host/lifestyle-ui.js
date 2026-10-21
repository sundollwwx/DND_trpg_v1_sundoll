/* Host reference and quote surfaces; no wallet, HP, or inventory mutation. */
(() => {
  'use strict';
  const trigger = document.getElementById('btn-lifestyle-open');
  if (!trigger) return;
  const el = (tag, text, cls) => {const n=document.createElement(tag);if(text !== undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const dialog = el('dialog',undefined,'daily-life-dialog lifestyle-dialog'); dialog.id='lifestyle-dialog';dialog.setAttribute('aria-labelledby','lifestyle-title');
  const header=el('header',undefined,'fishing-header'),title=el('h2','食宿生活');title.id='lifestyle-title';
  const close=el('button','关闭 ×');close.type='button';close.setAttribute('aria-label','关闭食宿生活');close.onclick=()=>dialog.close();header.append(title,close);
  const tabs=el('div',undefined,'lifestyle-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','食宿生活分类');
  const status=el('p','','fishing-status');status.setAttribute('role','status');
  const content=el('div',undefined,'lifestyle-body');
  dialog.append(header,tabs,status,content);document.body.append(dialog);
  let data,flavor,loading=false,section='expenses';const panels=new Map(),buttons=new Map();
  function card(title,text){const n=el('section',undefined,'lifestyle-card');n.append(el('h3',title));if(text)n.append(el('p',text));return n;}
  function paragraph(parent,text){parent.append(el('p',text));}
  function list(parent,values){const ul=el('ul');values.forEach(v=>ul.append(el('li',v)));parent.append(ul);}
  function field(parent,label,id,tag='select'){const l=el('label',label),input=el(tag);input.id=id;l.htmlFor=id;l.append(input);parent.append(l);return input;}
  function options(select,values){select.replaceChildren(...values.map(([value,text])=>{const o=el('option',text);o.value=value;return o;}));}
  function table(parent,heads,rows){const wrap=el('div',undefined,'lifestyle-table-wrap'),t=el('table',undefined,'lifestyle-table'),h=el('thead'),r=el('tr');heads.forEach(text=>{const th=el('th',text);th.scope='col';r.append(th);});h.append(r);const b=el('tbody');rows.forEach(row=>{const tr=el('tr');row.forEach(text=>tr.append(el('td',String(text))));b.append(tr);});t.append(h,b);wrap.append(t);parent.append(wrap);}
  function details(parent,title){const d=el('details',undefined,'lifestyle-details');d.append(el('summary',title));parent.append(d);return d;}
  const money=cp=>SundollLifestyle.money(cp);
  function buildExpenses(panel){
    const intro=card('先约好怎样算账','长住选择生活费；短暂停留可以逐项点餐、订房。生活费已经包含基础食宿，下面两种方式只选一种。');panel.append(intro);
    const form=el('div',undefined,'lifestyle-fields'),mode=field(form,'计价方式','life-mode');
    options(mode,[['lifestyle','生活费 · 已含基础食宿'],['itemized','逐项食宿 · 每餐／每夜']]);
    const tier=field(form,'生活水准','life-tier');options(tier,data.expenses.lifestyles.map(t=>[t.id,t.name+' · '+money(t.dailyCp)+'/人/日'+(t.id==='aristocratic'?'起':'')]));tier.value='modest';
    const people=field(form,'人数','life-people','input'),days=field(form,'天数','life-days','input');
    for(const [input,max,value] of [[people,100,4],[days,365,1]]){input.type='number';input.min=1;input.max=max;input.step=1;input.value=value;}
    const mealTier=field(form,'每餐档位','life-meal-tier'),roomTier=field(form,'每夜档位','life-room-tier');
    const tierName=id=>data.expenses.lifestyles.find(t=>t.id===id).name;
    options(mealTier,data.expenses.meals.map(t=>[t.tier,tierName(t.tier)+' · '+money(t.perMealCp)]));mealTier.value='modest';
    options(roomTier,data.expenses.lodging.map(t=>[t.tier,tierName(t.tier)+' · '+money(t.perNightCp)]));roomTier.value='modest';
    const meals=field(form,'每日餐数','life-meals','input'),nights=field(form,'住宿晚数','life-nights','input');
    for(const [input,max,value] of [[meals,6,3],[nights,365,1]]){input.type='number';input.min=0;input.max=max;input.step=1;input.value=value;}
    const result=card('费用参考');result.id='life-quote';result.setAttribute('aria-live','polite');
    const room=card('这笔钱买到什么');
    function update(){
      const packed=mode.value==='lifestyle';tier.parentElement.hidden=!packed;[mealTier,roomTier,meals,nights].forEach(x=>x.parentElement.hidden=packed);
      result.replaceChildren(el('h3','费用参考'));
      try{const q=SundollLifestyle.quote(data,{mode:mode.value,tier:tier.value,people:people.value,days:days.value,mealTier:mealTier.value,roomTier:roomTier.value,mealsPerDay:meals.value,nights:nights.value});
        result.append(el('strong',(q.minimum?'至少 ':'')+money(q.totalCp),'lifestyle-total'));list(result,q.lines.map(l=>l.label+'：'+money(l.cp)));paragraph(result,q.note);paragraph(result,'这是报价参考。确认消费后，主持人再使用现有钱包操作记账。');
      }catch(error){paragraph(result,error.message);}
      const id=packed?tier.value:roomTier.value;room.replaceChildren(el('h3','这笔钱买到什么'),el('p',data.lodgingFlavor[id]||'赤贫没有保证供应；先明确今日能获得哪些食物和住所。'),el('p','住宿样式是场景示例。房价不改变长休恢复量，也不保证不会受到打扰。'));
    }
    form.addEventListener('input',update);form.addEventListener('change',update);panel.append(form,result,room);update();
    const prices=details(panel,'查看官方食宿档位');table(prices,['水准','生活／日','餐食／餐','住宿／夜'],data.expenses.lifestyles.map(t=>[t.name,money(t.dailyCp)+(t.id==='aristocratic'?'起':''),data.expenses.meals.find(x=>x.tier===t.id)?money(data.expenses.meals.find(x=>x.tier===t.id).perMealCp):'不保证',data.expenses.lodging.find(x=>x.tier===t.id)?money(data.expenses.lodging.find(x=>x.tier===t.id).perNightCp):'不保证']));
    const day=details(panel,'主持一段有意思的停留');data.flow.forEach(s=>day.append(card(s.title,s.text)));
  }
  function buildRest(panel){
    const r=data.rest,short=card('短休 · 至少 1 小时');list(short,[r.short.allowed,r.short.benefits,'开始时至少 1 HP。','中断：'+r.short.interruptions.join('、')+'。'+r.short.interruptedOutcome]);panel.append(short);
    const long=card('长休 · 至少 8 小时');list(long,['通常睡眠至少 6 小时，轻活动最多 2 小时；开始时至少 1 HP。','上次长休结束至少 16 小时后，才能开始下一次。',...r.long.benefits,r.long.interruptedOutcome]);paragraph(long,'中断条件：'+r.long.interruptions.join('、')+'。');paragraph(long,r.long.exceptions);panel.append(long);
    panel.append(card('时间按钮如何使用','时间与天气中的短休／长休按钮推进世界时间并播放休息场景。先由主持人判断是否满足规则条件，再处理角色恢复；时间推进本身不证明完成了有效休息。'));
    const needs=details(panel,'每日食物、饮水与力竭');table(needs,['体型','食物／日','饮水／日'],[['微型','tiny'],['小型','small'],['中型','medium'],['大型','large'],['巨型','huge'],['超巨型','gargantuan']].map(([name,key])=>[name,data.dailyNeeds.food.lbPerDay[key]+' 磅',data.dailyNeeds.water.gallonsPerDay[key]+' 加仑']));
    list(needs,[data.dailyNeeds.food.partial,data.dailyNeeds.food.none,data.dailyNeeds.food.removal,data.dailyNeeds.water.penalty,data.dailyNeeds.water.removal,'2024 力竭：每级 d20 检定总值 −2、速度 −5 尺；6 级死亡。有效长休通常减 1 级，食水限制仍适用。',data.dailyNeeds.species]);
    const forage=details(panel,'觅食、钓鱼与野营');paragraph(forage,data.foraging.check+'；自然骰面 1/20 不自动决定成败。');table(forage,['环境','觅食 DC'],[['海岸','coastal'],['森林','forest'],['沼泽','swamp'],['草原','grassland'],['丘陵','hill'],['水上','waterborne'],['极地','arctic'],['荒漠','desert'],['山地','mountain'],['幽暗地域','underdark'],['城市','urban']].map(([name,key])=>[name,data.foraging.officialTerrainDc[key]]));paragraph(forage,data.foraging.yieldBoundary);paragraph(forage,data.foraging.fishingBoundary);
    const social=details(panel,'交谈、喝酒与普通服务');list(social,[data.social.workflow,data.social.hesitantDc,data.social.skills,data.social.retry,'喝酒没有本包另设的自动醉酒、奖励或属性修正；想让人帮忙，先说明具体请求。']);table(social,['服务','官方参考'],data.hirelings.services.map(s=>[s.name,s.minimumDailyCp!==undefined?'至少 '+money(s.minimumDailyCp)+'／日':s.cpPerMile!==undefined?money(s.cpPerMile)+'／英里':money(s.dailyCp)+'／日']));paragraph(social,data.hirelings.boundary);
  }
  function buildFlavor(panel){
    panel.append(card('地方风味','以下是可替换的原创场景素材。菜系由地区、季节和个人习惯塑造，不把某种族固定成同一种饮食。'));
    const filters=el('div',undefined,'lifestyle-fields'),venue=field(filters,'停留地点','life-venue');options(venue,flavor.venues.map(v=>[v.id,v.title]));const place=card('');
    function renderPlace(){const v=flavor.venues.find(v=>v.id===venue.value);place.replaceChildren(el('h3',v.title),el('p',v.summary));table(place,['细节','怎么呈现'],[['饭食',v.food],['住宿',v.lodging],['店规',v.custom],['人们',v.people],['一个话头',v.hook]]);}
    venue.onchange=renderPlace;panel.append(filters,place);renderPlace();
    const event=card('抽一个日常细节'),fields=el('div',undefined,'lifestyle-fields'),kind=field(fields,'细节类型','life-event-table'),roll=field(fields,'d20 结果','life-event-roll');options(kind,flavor.tables.map(t=>[t.id,t.title]));options(roll,Array.from({length:20},(_,i)=>[String(i+1),String(i+1)]));
    const draw=el('button','掷 d20 · 抽细节');draw.type='button';draw.id='life-event-draw';fields.append(draw);const line=el('div');
    function renderEvent(){const t=flavor.tables.find(t=>t.id===kind.value),row=t.rows.find(r=>r.roll===Number(roll.value));line.replaceChildren(el('h4',row.title),el('p',row.text));}
    draw.onclick=()=>{const limit=4294967280,bits=new Uint32Array(1);do{crypto.getRandomValues(bits);}while(bits[0]>=limit);roll.value=String(bits[0]%20+1);renderEvent();};kind.onchange=renderEvent;roll.onchange=renderEvent;event.append(fields,line,el('p','这是叙事随机表；1 和 20 不会自动触发属性检定奖惩。'));panel.append(event);renderEvent();
    const cultures=details(panel,'不同社区的桌边习惯');for(const culture of flavor.cultures){const c=card(culture.title);list(c,culture.traditions);paragraph(c,culture.adaptation);cultures.append(c);}
  }
  function buildSources(panel){
    panel.append(card(data.edition.name,data.edition.language));
    const checks=card('什么时候才掷骰');list(checks,[data.checks.when,data.checks.formula,data.checks.naturalOneTwenty,data.checks.d20Tables]);panel.append(checks);
    const boundary=card('规则与创作的边界');list(boundary,data.creativeBoundary);paragraph(boundary,'原有 24 张钓鱼表作为可选自定义扩展保留。它们的战斗、奖励与岩浆条件不属于官方日常规则，本次没有新增装备或魔法物品。');paragraph(boundary,data.weather.climateModelBoundary);panel.append(boundary);
    const source=card('核验来源');for(const s of data.sources){const p=el('p'),a=el('a',s.title);a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';p.append(a);source.append(p);}paragraph(source,'食宿 SRD 第 101–102 页；休息与生存第 181、185、187 页；觅食地形第 192 页；环境第 195 页。');panel.append(source);
  }
  function showSection(id){section=id;for(const [key,panel] of panels){panel.hidden=key!==id;const button=buttons.get(key);button.setAttribute('aria-selected',String(key===id));button.tabIndex=key===id?0:-1;button.classList.toggle('active',key===id);}content.scrollTop=0;}
  function build(){tabs.replaceChildren();content.replaceChildren();panels.clear();buttons.clear();for(const [id,label,buildPanel] of [['expenses','食宿',buildExpenses],['rest','休整',buildRest],['flavor','地方风味',buildFlavor],['sources','规则来源',buildSources]]){const button=el('button',label);button.type='button';button.id='life-tab-'+id;button.setAttribute('role','tab');button.setAttribute('aria-controls','life-panel-'+id);button.onclick=()=>showSection(id);const panel=el('section');panel.id='life-panel-'+id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);buildPanel(panel);panels.set(id,panel);buttons.set(id,button);tabs.append(button);content.append(panel);}tabs.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const ids=[...buttons.keys()],i=ids.indexOf(section);const next=e.key==='Home'?0:e.key==='End'?ids.length-1:(i+(e.key==='ArrowRight'?1:-1)+ids.length)%ids.length;showSection(ids[next]);buttons.get(ids[next]).focus();};showSection(section);}
  async function load(){if(data){showSection(section);return;}if(loading)return;loading=true;status.hidden=false;status.textContent='正在读取通用生活资料…';try{const responses=await Promise.all(['lifestyle','flavor'].map(k=>fetch('/api/daily-life/'+k,{credentials:'same-origin',cache:'no-store'})));if(responses.some(r=>!r.ok))throw Error();const values=await Promise.all(responses.map(r=>r.json()));if(!values[0].expenses?.lifestyles||!values[1].venues?.length||!values[1].tables?.length)throw Error();[data,flavor]=values;build();status.hidden=true;}catch(error){data=null;flavor=null;status.textContent='资料暂时无法读取，请关闭后重试。';}finally{loading=false;}}
  trigger.onclick=()=>{if(!dialog.open)dialog.showModal();void load();};dialog.addEventListener('close',()=>trigger.focus());
})();
