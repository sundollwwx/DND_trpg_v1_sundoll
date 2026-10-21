/* 玩家可见菜单：仅生活风味，无主持人秘密，无自动扣款或增益。 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.SundollDining = api;
    const button = document.getElementById('btn-player-menu');
    if (button) api.initPlayer(button);
  }
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  // Content belongs to the general module. The engine only manages presentation.
  const menus = [];
  let loading = null, loaded = false, pendingPlayer = null;
  function setMenus(value) {
    const list = Array.isArray(value) ? value : value?.menus;
    if (!Array.isArray(list) || !list.length || !list.every(m => m.id && m.title && Array.isArray(m.sections))) throw Error('菜单资料不完整');
    menus.splice(0, menus.length, ...list); loaded = true;
    return menus;
  }
  async function loadMenus() {
    if (loaded) return menus;
    if (loading) return loading;
    loading = (async () => {
      const response = await fetch('/api/daily-life/menus', {credentials:'same-origin', cache:'no-store'});
      if (!response.ok) throw Error('菜单读取失败');
      return setMenus(await response.json());
    })();
    try {return await loading;} finally {loading = null;}
  }
  const find = id => menus.find(menu => menu.id === id);
  function createHostChannel() {
    let campaign = null, shown = null;
    const snapshot = nextCampaign => {
      if (nextCampaign !== campaign) {campaign = nextCampaign; shown = null;}
      return shown ? {...shown} : null;
    };
    return {
      snapshot,
      show(id, token, nextCampaign) {
        snapshot(nextCampaign);
        if (!find(id) || !nextCampaign || typeof token !== 'string' || !token) throw Error('菜单或战役无效');
        shown = {id, token}; return snapshot(campaign);
      },
      hide(nextCampaign) {snapshot(nextCampaign); shown = null;},
      matches(value) {return JSON.stringify(value || null) === JSON.stringify(shown);}
    };
  }
  function createPlayerChannel() {
    let context = null, ticket = null, current = null;
    return {
      receive(value, nextContext) {
        const reset = context !== nextContext;
        if (reset) {context = nextContext; ticket = null; current = null;}
        if (!value || !find(value.id) || typeof value.token !== 'string' || !value.token || value.token.length > 100) {
          ticket = null; current = null; return {menu:null, open:false};
        }
        const nextTicket = value.id + ':' + value.token;
        const open = ticket !== nextTicket;
        ticket = nextTicket; current = find(value.id);
        return {menu:current, open};
      }
    };
  }
  const node = (tag, text, cls) => {
    const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el;
  };
  let dialog, page, controls, status, picker, share, retract, hostConfig, playerButton;
  let selected = null, playerMenu = null;
  const hostChannel = createHostChannel(), playerChannel = createPlayerChannel();
  function renderMenu(menu) {
    page.replaceChildren(); page.dataset.venue = menu.id;
    const title = node('h2', menu.title); title.id = 'dining-title';
    page.append(node('p', menu.subtitle, 'dining-subtitle'), title, node('p', menu.motto, 'dining-motto'), node('p', menu.intro, 'dining-intro'));
    for (const section of menu.sections) {
      const group = node('section', '', 'dining-section'); group.append(node('h3', section.title));
      for (const item of section.items) {
        const row = node('article', '', 'dining-item'), top = node('div', '', 'dining-item-top');
        top.append(node('h4', item.name), node('span', item.price, 'dining-price'));
        row.append(top, node('span', item.tag, 'dining-tag'), node('p', item.detail)); group.append(row);
      }
      page.append(group);
    }
    page.append(node('p', menu.note, 'dining-note')); page.scrollTop = 0;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = node('dialog', '', 'dining-dialog'); dialog.id = 'dining-dialog'; dialog.setAttribute('aria-label','菜单');dialog.setAttribute('aria-labelledby','dining-title');
    const bar = node('header', '', 'dining-toolbar'); const close = node('button','关闭 ×'); close.type='button'; close.setAttribute('aria-label','关闭菜单');
    close.addEventListener('click',()=>dialog.close()); bar.append(node('span','世界 · 菜单'),close);
    controls=node('div','','dining-controls'); controls.hidden=true;
    status=node('p','','dining-status'); status.setAttribute('role','status'); status.hidden=true;
    page=node('div','','dining-page'); dialog.append(bar,controls,status,page); document.body.append(dialog);
  }
  function setStatus(text) {status.hidden=false;status.textContent=text;}
  function initHost(config) {
    hostConfig=config;ensureDialog();controls.hidden=false;
    const label=node('label','地点'); picker=node('select'); picker.setAttribute('aria-label','菜单地点');
    const prepare = async () => {
      share.disabled = true; setStatus('正在读取菜单…');
      try {
        await loadMenus();
        if (!find(selected)) selected = menus[0].id;
        picker.replaceChildren(...menus.map(menu=>{const option=node('option',menu.title);option.value=menu.id;return option;}));
        picker.value = selected; renderMenu(find(selected)); share.disabled = false; status.hidden = true;
      } catch (error) {setStatus('菜单暂时无法读取，请关闭后重新打开。');}
    };
    label.append(picker); picker.addEventListener('change',()=>{selected=picker.value;renderMenu(find(selected));});
    share=node('button','展示给玩家');share.type='button';
    retract=node('button','收起玩家菜单');retract.type='button';
    share.addEventListener('click',()=>{
      if (!find(selected)) {setStatus('请先等待菜单加载。');return;}
      if (!config.ready()) {setStatus('请先进入战役并开启联机，再展示菜单。');return;}
      hostChannel.show(selected,crypto.randomUUID(),config.campaign());
      setStatus('正在展示给玩家…'); config.push();
    });
    retract.addEventListener('click',()=>{
      if (!config.ready()) {setStatus('请先开启联机，再收起玩家菜单。');return;}
      hostChannel.hide(config.campaign());setStatus('正在收起玩家菜单…');config.push();
    });
    controls.append(label,share,retract);
    config.trigger.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();void prepare();});
    dialog.addEventListener('close',()=>config.trigger.focus());
  }
  function initPlayer(button) {
    playerButton=button;ensureDialog();
    button.disabled=true;
    const preparePlayer = async () => {
      try {await loadMenus(); if(pendingPlayer) receive(pendingPlayer.value,pendingPlayer.context);}
      catch (error) {button.disabled=false;button.textContent='菜单暂时不可用 · 点击重试';}
    };
    button.addEventListener('click',()=>{if(playerMenu){renderMenu(playerMenu);if(!dialog.open)dialog.showModal();}else void preparePlayer();});
    void preparePlayer();
  }
  function receive(value, context) {
    if (!playerButton) return;
    pendingPlayer={value,context};
    if (!loaded) return;
    const received=playerChannel.receive(value,context);playerMenu=received.menu;
    playerButton.disabled=!playerMenu;
    playerButton.textContent=playerMenu?'查看'+playerMenu.title+'菜单':'等待主持人展示菜单';
    if (!playerMenu) {if(dialog.open)dialog.close();return;}
    if (received.open) {renderMenu(playerMenu);if(!dialog.open)dialog.showModal();}
  }
  return {menus,setMenus,loadMenus,find,createHostChannel,createPlayerChannel,initHost,initPlayer,receive,
    snapshot:campaign=>hostChannel.snapshot(campaign),
    acknowledge(value) {if(hostConfig && hostChannel.matches(value))setStatus(value?'已展示给玩家：'+find(value.id).title:'玩家菜单已收起。');},
    syncFailed() {if(hostConfig)setStatus('菜单同步尚未成功，恢复连接后会自动重试。');}
  };
});
