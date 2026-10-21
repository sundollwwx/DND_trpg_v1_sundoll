/* World controls reuse the campaign encounter clock and persistence. */
(() => {
  'use strict';
  const trigger=document.getElementById('btn-world-open'),dialog=document.getElementById('world-dialog');
  if (!trigger || !dialog) return;
  trigger.onclick=()=>{renderEncounter();if(!dialog.open)dialog.showModal();dialog.querySelector('.world-dialog-body').scrollTop=0;};
  document.getElementById('btn-world-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{window.SundollWorldUI.editingDate=false;window.SundollWorldUI.editingWeather=false;window.SundollWorldUI.editingLocation=false;dateStatus.textContent='';weatherStatus.textContent='';trigger.focus();});
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  const auto=document.getElementById('btn-weather-auto'),rate=document.getElementById('time-rate');
  auto.onclick=()=>{if(!CLIMATE_AVAILABLE)return;const e=encounterState();e.weather.auto=e.weather.auto===false;e.weather.generatedHour=weatherHourIndex(worldTimeNow(e));setEncounterEvent(e,e.weather.auto?'已开启每小时天气变化':'天气与风力已固定，温度仍随昼夜变化');renderEncounter();scheduleAutosave();};
  rate.onchange=()=>{const e=encounterState(),running=Boolean(e.worldTime.runningSince);materializeWorldTime(e);e.worldTime.rate=Number(rate.value);if(running&&e.playMode!=='turn')e.worldTime.runningSince=Date.now();setEncounterEvent(e,'实时流速已调整');renderEncounter();scheduleAutosave();};
  const notes=document.getElementById('weather-model-notes');
  const config=window.SundollClimateConfig;
  for(const rule of config?.rulesNotes||[]){const p=el('p');p.append(el('strong',rule.title+'：'),document.createTextNode(rule.detail));notes.append(p);}
  for(const item of config?.sources||[]){const p=el('p'),source=el('a',item.title);source.href=item.url;source.target='_blank';source.rel='noopener noreferrer';p.append(source);notes.append(p);}
  const locationSelect=document.getElementById('world-location'),climateSelect=document.getElementById('weather-climate'),arriveButton=document.getElementById('btn-world-arrive');
  const locationStatus=document.getElementById('world-location-status'),conditionSelect=document.getElementById('weather-condition');
  const linkRule=(sourceId)=>{
    const item=config?.sources?.find(source=>source.id===sourceId);
    if(!item)return null;
    const a=el('a','规则');a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';a.setAttribute('aria-label',item.title);return a;
  };
  if(CLIMATE_AVAILABLE){
    conditionSelect.replaceChildren();
    for(const [key,condition]of Object.entries(WEATHER_META)){
      const option=el('option',condition.label);option.value=key;option.disabled=condition.legacyOnly===true;conditionSelect.append(option);
    }
    climateSelect.replaceChildren();
    for(const [key,climate]of Object.entries(CLIMATE_META)){const option=el('option',climate.label);option.value=key;climateSelect.append(option);}
  }
  locationSelect.onchange=()=>{
    const location=mapLocationById(locationSelect.value);
    climateSelect.value=location?.climateKey||location?.weather?.climate||(!location?state.worldWeatherDefault?.climate:null)||encounterState().weather.climate;
    SundollWorldUI.editingLocation=true;locationStatus.textContent='所在地尚未确认；当地气候会随地点保存。';
  };
  climateSelect.onchange=()=>{SundollWorldUI.editingLocation=true;locationStatus.textContent='当地气候尚未确认。';};
  arriveButton.onclick=()=>{
    const e=encounterState();
    if(!arriveAtWorldLocation(locationSelect.value,climateSelect.value,e))return;
    const location=mapLocationById(state.worldWeatherLocationId);
    setEncounterEvent(e,'队伍抵达：'+(location?.name||'未指定地点')+' · '+CLIMATE_META[e.weather.climate].label);
    SundollWorldUI.editingLocation=false;SundollWorldUI.clearEdit('weather');
    renderEncounter();scheduleAutosave();
  };
  let previous='';
  let locationOptionsKey='';
  window.SundollWorldUI={editingDate:false,editingWeather:false,editingLocation:false,clearEdit(group){
    if(group==='date'){this.editingDate=false;dateStatus.textContent='';}
    if(group==='weather'){this.editingWeather=false;weatherStatus.textContent='';}
  },render(e,world,weather){
    const available=weather.available!==false,enabled=available&&e.weather.auto!==false;
    locationSelect.disabled=climateSelect.disabled=arriveButton.disabled=!available;
    const locations=state.mapLocations||[],location=mapLocationById(state.worldWeatherLocationId);
    const locationKey=JSON.stringify([(state.mapChapters||[]).map(item=>[item.id,item.name]),locations.map(item=>[item.id,item.chapterId,item.name])]);
    if(locationKey!==locationOptionsKey){
      const chosen=this.editingLocation?locationSelect.value:state.worldWeatherLocationId||'';
      locationSelect.replaceChildren();const empty=el('option','未指定地点');empty.value='';locationSelect.append(empty);
      for(const item of locations){
        const chapter=(state.mapChapters||[]).find(chapter=>chapter.id===item.chapterId);
        const option=el('option',(chapter?.name?chapter.name+' · ':'')+item.name);option.value=item.id;locationSelect.append(option);
      }
      locationSelect.value=locations.some(item=>item.id===chosen)?chosen:'';locationOptionsKey=locationKey;
    }
    if(!this.editingLocation){
      locationSelect.value=state.worldWeatherLocationId||'';climateSelect.value=e.weather.climate;
      locationStatus.textContent='确认后使用当地气候；预览或展示地图不会改变所在地。';
    }
    document.getElementById('world-location-current').textContent='队伍所在地：'+(location?.name||'未指定')+(available?' · '+CLIMATE_META[weather.climate].label:'');
    auto.disabled=!available;
    auto.textContent=!available?'自动变化 · 已暂停':enabled?'自动变化 · 开启':'自动变化 · 已固定';auto.setAttribute('aria-pressed',String(enabled));
    document.getElementById('weather-next-step').textContent=!available?weather.detail:enabled?'下次推演 '+String((world.hour+1)%24).padStart(2,'0')+':00':'天气与风力保持 · 温度仍随昼夜变化';
    if(document.activeElement!==rate){
      const value=String(e.worldTime.rate);
      let custom=rate.querySelector('[data-custom-rate]');
      if(![...rate.options].some(option=>option.value===value)){
        if(!custom){custom=el('option');custom.dataset.customRate='true';rate.append(custom);}
        custom.value=value;custom.textContent='1 秒 = 游戏 '+value+' 秒';
      }
      rate.value=value;
    }
    const effects=weatherEnvironmentEffects(e.weather,world),key=JSON.stringify([available,effects]);
    if(key!==previous){
      previous=key;const summary=document.getElementById('weather-risk-summary');summary.replaceChildren();
      if(!available)summary.append(el('p','天气资料不可用，暂停环境提示；仍按现场情况判断。'));
      for(const effect of effects){
        const p=el('p');p.append(el('strong',effect.title+'：'),document.createTextNode(effect.detail));
        const source=linkRule(effect.sourceId);if(source)p.append(document.createTextNode(' '),source);
        if(effect.when){const when=el('small',effect.when);when.className='world-rule-condition';p.append(when);}
        summary.append(p);
      }
    }
  }};
  const dateStatus=el('p'),weatherStatus=el('p');dateStatus.className=weatherStatus.className='world-edit-status';
  document.querySelector('.world-dialog .world-date-inputs').after(dateStatus);document.querySelector('.world-dialog .weather-controls').after(weatherStatus);
  for(const type of ['input','change'])dialog.addEventListener(type,event=>{
    if(event.target.closest('.world-date-inputs')){SundollWorldUI.editingDate=true;dateStatus.textContent='日期尚未应用';}
    if(event.target.closest('.weather-controls')){SundollWorldUI.editingWeather=true;weatherStatus.textContent='天气尚未应用';}
  });
  const restNote=el('p','休息按钮推进时段；是否满足休息与恢复条件由主持人确认。');restNote.className='world-rest-note';document.querySelector('.world-dialog .world-time-actions').after(restNote);
  renderEncounter();
})();
