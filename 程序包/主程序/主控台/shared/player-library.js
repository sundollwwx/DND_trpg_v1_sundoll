/* Shared player profile and personal collection UI. Only the server writes player files. */
window.PlayerLibrary = (() => {
  let config = {}, dialog, content, status, selected = '', current, grantRequest, loadSerial = 0;
  let headingTitle, headingCopy, headingBack, libraryReturn=null;
  const drafts = new Map();
  const saving = new Set();
  const searches = new Map();
  let collectionFilter = 'all';
  const roleLabels = {main:'主角色',character:'其他角色',companion:'伙伴'};
  let returnToMap = true, focusedPiece = '', requestedEditor = '', page = 'profile';
  const actionsInFlight = new Set();
  async function runPieceAction(key, action) {
    if (actionsInFlight.has(key) || saving.has(key)) return;
    actionsInFlight.add(key);
    try { await action(); } finally { actionsInFlight.delete(key); }
  }
  const draftKey = (pid, oid) => `${pid}:${oid}`;
  function portraitFormIndex(piece, variants) {
    const identity = source => {
      const field = ['iconImgPath', 'iconImgId', 'iconImgHd', 'iconImg'].find(key => source?.[key]);
      return field ? field + ':' + source[field] : '';
    };
    const image = identity(piece);
    if (!image) return -1;
    const matches = form => identity(form) === image
      && SundollPortraitView.sameView(form?.portraitView, piece.portraitView);
    const hinted = Number.isInteger(piece.portraitVariant) ? piece.portraitVariant : -1;
    return hinted >= 0 && hinted < variants.length && matches(variants[hinted])
      ? hinted : variants.findIndex(matches);
  }
  const el = (tag, text, className = '') => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function button(text, callback, className = '', enabled = () => true, feedback = null) {
    const control = el('button', text, className);
    control.type = 'button';
    control.onclick = async () => {
      if (control.disabled || !enabled()) return;
      control.disabled = true;
      const originalText = control.textContent;
      control.textContent = '处理中…';
      if (feedback) feedback.textContent = '';
      try { await callback(); }
      catch (error) { status.textContent = error.message; if (feedback) feedback.textContent = error.message; }
      finally { control.textContent = originalText; control.disabled = !enabled(); }
    };
    return control;
  }
  async function api(data) {
    if (location.protocol === 'file:') throw new Error('请从 http://localhost:8090 打开页面后使用玩家档案');
    const response = await fetch('/api/player-profiles', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...(config.host ? {'X-Sundoll-Local-Save': '1'} : {})},
      body: JSON.stringify({...data, ...(!config.host ? {sessionToken: config.session?.()} : {})}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const message = result.error || '服务暂时不可用，请保留草稿后重试';
      const error = new Error(message);
      error.status = response.status;
      if (!config.host && data.op === 'get' && [401,403].includes(response.status) && content) {
        const panel = el('section', undefined, 'pl-panel');
        const emailAccount = config.emailAccount?.() || !!window.SundollRoom;
        panel.append(el('h3', '登录后使用个人收藏'), el('p', emailAccount ? '返回我的战役，使用邮箱账号重新进入此战役空间。已有角色与背包仍属于你的账号。' : '在玩家首页输入你的玩家名字，或创建一个尚未使用的新名字。', 'pl-panel-copy'));
        if (config.signIn) panel.append(button(emailAccount ? '返回我的战役' : '使用名字登录', () => { dialog.close(); config.signIn(); }, 'pl-primary'));
        content.replaceChildren(panel);
      }
      throw error;
    }
    return result;
  }
  function ensure() {
    if (dialog) return;
    const style = el('style');
    style.textContent = `
      /* The character name, map action and editing tools have separate visual levels. */
      .player-library-dialog{position:fixed;inset:0;width:min(960px,95vw);max-height:90dvh;margin:auto;box-sizing:border-box;border:1px solid var(--sw-character-line,#4f6256);border-radius:14px;background:var(--sw-character,#1d2b26);color:var(--sw-ink,#f0ebe1);padding:0;overflow:hidden;box-shadow:0 26px 100px #0009;font:14px/1.55 system-ui,sans-serif}
      .player-library-dialog[open]{display:flex;flex-direction:column}.player-library-dialog::backdrop{background:#080e11b8;backdrop-filter:blur(3px)}
      .player-library-dialog *{box-sizing:border-box}.player-library-dialog [hidden]{display:none!important}
      .player-library-dialog :is(button,input,select,textarea){max-width:100%;min-width:0;border:1px solid var(--sw-edge,#c1c6bd29);border-radius:7px;background:#17231f;color:inherit;font:inherit;font-size:13px}
      .player-library-dialog :is(input,select){min-height:var(--ui-control,34px);padding:6px 10px}.player-library-dialog select{width:100%;color-scheme:dark}.player-library-dialog textarea{width:100%;min-height:88px;padding:10px;resize:vertical;line-height:1.65}
      .player-library-dialog button{min-height:var(--ui-control,34px);padding:6px 12px;line-height:1.45;cursor:pointer;transition:background .15s,border-color .15s}
      .player-library-dialog button:hover:not(:disabled){background:var(--sw-character-raised,#2a3831);border-color:var(--sw-character-line,#4f6256)}
      .player-library-dialog button:disabled{cursor:default;opacity:.48}.player-library-dialog :is(button,summary,input,select,textarea):focus-visible{outline:2px solid #d6bc88;outline-offset:3px}
      .player-library-dialog .pl-primary{min-height:var(--ui-control-primary,38px);background:#d6bc88;border-color:#d6bc88;color:#262218;font-weight:600}.player-library-dialog .pl-primary:hover:not(:disabled){background:#e3cda5;border-color:#e3cda5}
      .player-library-dialog .pl-danger{color:#dba69c;border-color:#b7796b55;background:transparent}.player-library-dialog .pl-muted{color:var(--sw-muted,#b0bbb7)}
      .player-library-dialog>header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;background:var(--sw-character-raised,#2a3831);border-bottom:1px solid var(--sw-edge,#c1c6bd29);flex-shrink:0}
      .player-library-dialog>header>div:first-child{min-width:0}.player-library-dialog>header h2{margin:0;font:400 23px/1.35 'Songti SC',STSong,Georgia,serif;letter-spacing:.04em;color:#f2e6cc}
      .player-library-dialog .pl-eyebrow{display:block;color:#b9b396;font-size:10px;letter-spacing:.16em;margin-bottom:5px}.player-library-dialog .pl-header-copy{margin:5px 0 0;color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-header-copy:empty{display:none}
      .player-library-dialog .pl-header-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0}.player-library-dialog .pl-header-actions button{background:transparent;font-size:12px}
      .player-library-dialog .pl-status{min-height:0;margin:0;padding:10px 22px;border-top:1px solid var(--sw-edge,#c1c6bd29);color:#d1be95;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;flex-shrink:0}.player-library-dialog .pl-status:empty{display:none}
      .player-library-dialog .pl-content{padding:20px 22px 24px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;min-height:0;flex:1}
      .player-library-dialog .pl-panel{padding:18px;border:1px solid var(--sw-edge,#c1c6bd29);border-radius:10px;background:var(--sw-character-raised,#2a3831);margin-bottom:18px}
      .player-library-dialog .pl-panel :is(h3,h4){margin:0}.player-library-dialog .pl-panel h3{font-size:17px;font-weight:600}.player-library-dialog .pl-panel-copy{margin:6px 0 0;color:var(--sw-muted,#b0bbb7);font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
      .player-library-dialog .pl-picker-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin-top:14px}.player-library-dialog .pl-picker-block{display:grid;gap:7px}.player-library-dialog .pl-picker-block label{color:var(--sw-muted,#b0bbb7);font-size:12px}
      .player-library-dialog .pl-create-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.player-library-dialog .pl-search{width:100%}
      .player-library-dialog :is(.pl-profile-head,.pl-library-head,.pl-piece-top){display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
      .player-library-dialog .pl-profile-identity{display:flex;align-items:center;gap:12px;min-width:0}.player-library-dialog .pl-avatar{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;border-radius:10px;background:#d3b37d14;border:1px solid #d3b37d44;color:#e3cda5;font-size:20px}
      .player-library-dialog .pl-profile-name{font-size:21px;line-height:1.35;color:#eee4cf;overflow-wrap:anywhere}.player-library-dialog .pl-badge{display:inline-block;max-width:100%;padding:3px 7px;border:1px solid var(--sw-edge,#c1c6bd29);border-radius:5px;background:#111b1733;color:#b8c4b8;font-size:11px;line-height:1.4;overflow-wrap:anywhere}
      .player-library-dialog :is(.pl-profile-tools,.pl-editor){margin-top:16px;padding-top:12px;border-top:1px solid var(--sw-edge,#c1c6bd29)}
      .player-library-dialog summary{cursor:pointer;color:#c6cebf;min-height:var(--ui-control-sm,32px);padding:5px 0;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
      .player-library-dialog :is(.pl-profile-actions,.pl-piece-actions,.pl-editor-actions,.pl-credential-actions){display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px}
      .player-library-dialog .pl-library-head{margin:0 0 14px;flex-wrap:wrap;gap:8px}.player-library-dialog .pl-library-head h3{margin:0;color:#e7dac0;font-size:17px;font-weight:600}.player-library-dialog .pl-library-head .pl-search-row{width:340px;max-width:100%;flex:1 1 240px}.player-library-dialog .pl-library-count{margin:0;color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-library-count:empty{display:none}.player-library-dialog .pl-library-head .pl-library-count{margin-left:auto}
      .player-library-dialog .pl-search-row{display:flex;gap:8px;min-width:0}.player-library-dialog .pl-search-row .pl-search{min-width:0;flex:1}.player-library-dialog .pl-search-row>button{flex-shrink:0;font-size:12px}
      .player-library-dialog .pl-map-tools{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 0;margin-bottom:4px;border-top:1px solid var(--sw-edge,#c1c6bd29);color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-map-tools strong{color:#d4d6c8;font-weight:500;overflow-wrap:anywhere}.player-library-dialog .pl-map-tools label{display:flex;align-items:center;gap:7px}.player-library-dialog input[type=checkbox]{accent-color:#d6bc88;width:16px;height:16px;min-height:0;padding:0;flex-shrink:0}
      .player-library-dialog .pl-category-tabs{gap:4px;margin:0 0 16px;padding-bottom:10px;border-bottom:1px solid var(--sw-edge,#c1c6bd29)}.player-library-dialog .pl-category-tabs>button{min-height:var(--ui-control-sm,32px);padding:5px 12px;background:transparent;border-color:transparent;color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-category-tabs>button[aria-pressed=true]{background:#d6bc8814;border-color:#d6bc8838;color:#e3cda5}
      .player-library-dialog .pl-piece-card{display:grid;grid-template-columns:88px minmax(0,1fr);gap:18px;padding:18px;margin-top:12px;border:1px solid var(--sw-edge,#c1c6bd29);border-radius:10px;background:#24332c66;align-items:start}
      .player-library-dialog .pl-portrait{display:grid;place-items:center;width:88px;height:108px;border-radius:9px;background:#13211c;border:1px solid var(--sw-edge,#c1c6bd29);overflow:hidden;color:#77877b;font-size:30px}.player-library-dialog .pl-portrait img{width:100%;height:100%;object-fit:contain}.player-library-dialog .pl-piece-main{min-width:0}
      .player-library-dialog .pl-piece-top h4{margin:0;color:#f0ebe1;font-size:18px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}.player-library-dialog .pl-piece-main>.pl-piece-top{margin-bottom:8px}.player-library-dialog .pl-piece-meta{margin:7px 0;color:var(--sw-muted,#b0bbb7);font-size:12px}
      .player-library-dialog .pl-piece-actions{margin:12px 0}.player-library-dialog .pl-piece-actions>button{font-size:12px}.player-library-dialog .pl-piece-actions>.pl-editor{flex-basis:100%;margin-top:4px}.player-library-dialog .pl-role-tools{padding-top:10px;border-top:1px solid var(--sw-edge,#c1c6bd29);gap:6px}.player-library-dialog .pl-role-tools>button{min-height:var(--ui-control-sm,32px);padding:5px 9px;color:var(--sw-muted,#b0bbb7);background:transparent}
      .player-library-dialog .pl-form-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px;margin:10px 0}.player-library-dialog .pl-form-list button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px;font-size:12px}.player-library-dialog .pl-form-list img{width:100%;height:100%;object-fit:contain}
      .player-library-dialog .pl-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:12px;margin-top:12px}.player-library-dialog .pl-editor label{display:grid;gap:6px;min-width:0;color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-editor .pl-wide{grid-column:1/-1}.player-library-dialog .pl-file-hint{min-height:18px;color:#d1be95;overflow-wrap:anywhere}.player-library-dialog .pl-piece-main>.pl-editor>.pl-badge{margin-top:10px}
      .player-library-dialog .pl-card-feedback{margin:8px 0;color:#d1be95;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.player-library-dialog .pl-card-feedback:empty{display:none}.player-library-dialog .pl-conflict{padding:10px;border:1px solid #b58c5c55;border-radius:8px;background:#8b5e2820;color:#eed1a7;font-size:12px}
      .player-library-dialog .pl-empty{min-height:180px;display:grid;place-items:center;text-align:center;padding:24px;color:var(--sw-muted,#b0bbb7);font-size:13px}.player-library-dialog .pl-credential{width:100%;min-height:100px;word-break:break-all}.player-library-dialog .pl-code-field{display:grid;gap:8px;margin:18px 0 10px;max-width:480px;color:var(--sw-muted,#b0bbb7);font-size:12px}.player-library-dialog .pl-code-field input{font:16px/1.5 ui-monospace,monospace;letter-spacing:.04em}
      .player-library-dialog .pl-player-picker{background:transparent;border:0;border-bottom:1px solid var(--sw-edge,#c1c6bd29);padding:0 0 14px;margin-bottom:18px}.player-library-dialog .pl-picker-heading{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px}.player-library-dialog .pl-picker-heading h3{font-size:15px;color:#d8c9aa}.player-library-dialog .pl-picker-heading .pl-header-actions{margin-left:auto}
      .player-library-dialog .pl-player-rail{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;scrollbar-color:#596450 transparent;padding:3px 2px 8px}.player-library-dialog .pl-player-preview{flex:0 0 132px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px;padding:10px 12px;scroll-snap-align:center;background:#17231f;border-color:var(--sw-edge,#c1c6bd29);border-radius:8px}.player-library-dialog .pl-player-preview[aria-pressed=true]{border-color:#d6bc8866;background:#d6bc8810;box-shadow:inset 0 -2px #d6bc88}.player-library-dialog .pl-player-preview strong{max-width:100%;overflow-wrap:anywhere;color:#eee3cc;font-size:13px;font-weight:600}.player-library-dialog .pl-preview-caption{font-size:11px;color:var(--sw-muted,#b0bbb7)}.player-library-dialog .pl-preview-avatar{display:grid;place-items:center;width:44px;height:44px;border-radius:10px;background:#d3b37d14;border:1px solid #d3b37d44;color:#e3cda5;font-size:22px}
      .player-library-dialog .pl-transfer-row{display:flex;gap:8px;flex-basis:100%;min-width:0}.player-library-dialog .pl-transfer-row select{flex:1;min-width:0;width:auto}
      @media(max-width:680px){.player-library-dialog{width:97vw;max-height:95dvh;border-radius:12px}.player-library-dialog>header{padding:15px;flex-wrap:wrap;gap:10px}.player-library-dialog>header h2{font-size:21px}.player-library-dialog .pl-content{padding:14px}.player-library-dialog .pl-panel{padding:14px}.player-library-dialog .pl-profile-head{flex-wrap:wrap}.player-library-dialog .pl-editor-grid{grid-template-columns:1fr}.player-library-dialog .pl-piece-card{grid-template-columns:64px minmax(0,1fr);gap:12px;padding:12px}.player-library-dialog .pl-portrait{width:64px;height:80px}.player-library-dialog .pl-piece-top{align-items:flex-start}.player-library-dialog .pl-piece-top h4{font-size:17px}.player-library-dialog .pl-piece-main>.pl-editor{margin-left:-76px}.player-library-dialog .pl-create-row{grid-template-columns:1fr}.player-library-dialog .pl-library-head .pl-search-row{flex-basis:100%}.player-library-dialog .pl-status{padding:10px 14px}.player-library-dialog .pl-transfer-row{flex-wrap:wrap}.player-library-dialog .pl-transfer-row select{flex-basis:100%}}
      @media(max-width:680px),(pointer:coarse){.player-library-dialog button,.player-library-dialog .pl-piece-actions>button,.player-library-dialog .pl-category-tabs>button,.player-library-dialog .pl-role-tools>button,.player-library-dialog .pl-primary,.player-library-dialog summary{min-height:var(--ui-control-touch,44px)}.player-library-dialog :is(input,select){min-height:var(--ui-control-touch,44px)}.player-library-dialog :is(input,select,textarea){font-size:16px}.player-library-dialog input[type=checkbox]{min-height:0}.player-library-dialog summary{padding:11px 0}}
      @media(prefers-reduced-motion:reduce){.player-library-dialog button{transition:none}}
    `;
    document.head.append(style);
    dialog = el('dialog');
    dialog.className = 'player-library-dialog';
    const header = el('header');
    const heading=el('div');
    const title=el('h2', config.host ? '参团角色' : '我的角色');title.id='player-library-title';
    heading.append(el('span', 'ADVENTURER ARCHIVES', 'pl-eyebrow'),title,
      el('p',config.host?'每位冒险者的身份、收藏与随身物品。':'收藏你的角色，继续下一段冒险。','pl-header-copy'));
    headingTitle=title;headingCopy=heading.children[2];
    const headerActions=el('div',undefined,'pl-header-actions');
    headingBack=button('← 返回角色列表',async()=>{
      if(saving.size||actionsInFlight.size){status.textContent='正在处理收藏，请稍后返回';return;}
      if(libraryReturn){dialog.close();await libraryReturn();return;}
      page='profile';await load();
    });headingBack.hidden=true;
    headerActions.append(headingBack,button('关闭',()=>dialog.close()));
    header.append(heading,headerActions);
    dialog.setAttribute('aria-labelledby','player-library-title');
    status = el('p', '', 'pl-status');
    status.setAttribute('role', 'status');
    content = el('div', undefined, 'pl-content');
    dialog.append(header, content, status);
    document.body.append(dialog);
    dialog.addEventListener('close', () => { ++loadSerial; });
    window.addEventListener('beforeunload', event => {
      if (drafts.size) { event.preventDefault(); event.returnValue = ''; }
    });
  }

  function roomCharacterPicker(players) {
    const panel=el('section',undefined,'pl-panel pl-player-picker');
    const rows=players.flatMap(player=>(player.characters||[]).map(character=>({...character,playerId:player.playerId,owner:player.accountId?player.name:'待认领'})));
    const top=el('div',undefined,'pl-picker-heading');top.append(el('h3','选择角色'),el('span',`${rows.length} 个角色与伙伴`,'pl-library-count'));
    const rail=el('div',undefined,'pl-player-rail');rail.setAttribute('role','group');rail.setAttribute('aria-label','选择角色');
    for(const row of rows){
      const card=el('button',undefined,'pl-player-preview');card.type='button';card.setAttribute('aria-label',`查看角色 ${row.name}`);card.setAttribute('aria-pressed',String(row.characterId===focusedPiece));
      card.append(el('strong',row.name),el('span',row.owner,'pl-preview-caption'));
      card.onclick=async()=>{if(saving.size||actionsInFlight.size)return;selected=row.playerId;focusedPiece=row.characterId;collectionFilter='all';page='library';try{await load();}catch(error){status.textContent=error.message;}};
      rail.append(card);
    }
    panel.append(top,rail);return panel;
  }
  function hostPicker(players, targetPlayer) {
    const panel=el('section',undefined,'pl-panel pl-player-picker');
    const top=el('div',undefined,'pl-picker-heading');
    top.append(el('h3','选择玩家'),el('span',`${players.length} 位玩家`,'pl-library-count'));
    const rail=el('div',undefined,'pl-player-rail');
    rail.setAttribute('role','group');rail.setAttribute('aria-label','选择玩家档案');
    const controls=el('div',undefined,'pl-header-actions');
    for(const [label,direction] of [['←',-1],['→',1]]){
      const arrow=el('button',label);arrow.type='button';arrow.setAttribute('aria-label',direction<0?'向左浏览玩家':'向右浏览玩家');
      arrow.onclick=()=>rail.scrollBy({left:direction*rail.clientWidth*.8,behavior:'smooth'});
      controls.append(arrow);
    }
    controls.hidden=players.length<3;top.append(controls);panel.append(top,rail);
    players.forEach(player=>{
      const card=el('button',undefined,'pl-player-preview');card.type='button';
      card.setAttribute('aria-label',`查看 ${player.name} 的档案`);
      card.setAttribute('aria-pressed',String(player.playerId===targetPlayer));
      const avatar=el('span',Array.from(player.name||'冒')[0],'pl-preview-avatar');avatar.setAttribute('aria-hidden','true');
      card.append(avatar,el('strong',player.name),el('span',player.playerId===targetPlayer?'当前玩家':'查看角色','pl-preview-caption'));
      card.onclick=async()=>{
        if(selected===player.playerId)return;
        if(saving.size||actionsInFlight.size){status.textContent='正在保存收藏，请稍后切换档案';return;}
        selected=player.playerId;page='profile';
        try{await load();}catch(error){status.textContent=error.message;}
      };
      rail.append(card);
    });
    if(!players.length)rail.append(el('span','暂无玩家','pl-muted'));
    return panel;
  }
  function profilePanel(result, players = []) {
    const panel = el('section', undefined, 'pl-panel pl-profile-panel');
    const head = el('div', undefined, 'pl-profile-head');
    const identity=el('div',undefined,'pl-profile-identity');
    const avatar=el('span',Array.from(result.profile.name||'冒')[0],'pl-avatar');avatar.setAttribute('aria-hidden','true');
    identity.append(avatar,el('strong', result.profile.name, 'pl-profile-name'));
    head.append(identity, el('span', result.profile.accountId ? '已绑定账号' : config.host ? '主控管理视图' : '当前登录玩家', 'pl-badge'));
    panel.append(head, el('p', config.host ? '管理角色与持久伙伴，将已有角色带入当前地图。' : '这里是你的角色名册。将棋子带入地图开始行动；角色与持久伙伴可以随你进入不同战役。', 'pl-panel-copy'));
    const quick=el('div',undefined,'pl-profile-actions');
    if (config.host) quick.append(button('角色名册', async () => { page = 'library'; await load(); }, 'pl-primary'));
    if (config.host && config.backpack) quick.append(button('🎒 查看背包 / 发放物品', () => { dialog.close(); config.backpack(result.profile); }));
    if (config.host) panel.append(quick);
    if (config.host && !result.profile.accountId && !result.profile.characterMode) {
      const tools = el('details', undefined, 'pl-profile-tools');
      tools.append(el('summary', '更多操作'));
      const actions = el('div', undefined, 'pl-profile-actions');
      const remove = button('删除玩家档案', async () => {
        const player = players.find(item => item.playerId === result.profile.playerId);
        if (!confirm(`删除「${player?.name || result.profile.name}」的玩家档案和个人小棋子库？该玩家会被下线，当前登录失效。已有地图棋子保留，档案会移入主控电脑的“已删除”备份。`)) return;
        await api({op: 'delete', playerId: result.profile.playerId});
        for (const key of drafts.keys()) if (key.startsWith(`${result.profile.playerId}:`)) drafts.delete(key);
        selected = '';
        await load();
        status.textContent = '玩家档案已删除，当前登录已失效；已保留删除备份';
      }, 'pl-danger');
      actions.append(remove);
      tools.append(actions);
      panel.append(tools);
    }
    return panel;
  }
  function pieceCard(piece, result) {
    const key = draftKey(result.profile.playerId, piece.ownedPieceId);
    const draft = drafts.get(key);
    const baseRevision = draft?.baseRevision ?? piece.revision;
    const card = el('article', undefined, 'pl-piece-card');
    const portrait = el('div', piece.icon || '♟', 'pl-portrait');
    if (piece.iconImgPath) {
      portrait.textContent = '';
      const imageNode = el('img');
      imageNode.src = piece.iconImgPath;
      imageNode.alt = piece.name;
      imageNode.onerror = () => { portrait.replaceChildren(el('span', piece.icon || '♟')); };
      portrait.append(imageNode);
      SundollPortraitView.apply(imageNode,piece,{legacyScale:1});
    }
    const main = el('div', undefined, 'pl-piece-main');
    const top = el('div', undefined, 'pl-piece-top');
    const stateBadge = el('span', draft ? '未保存' : '已保存', 'pl-badge');
    top.append(el('h4', piece.name));
    main.append(top);
    const feedback = el('p', '', 'pl-card-feedback');
    feedback.setAttribute('role', 'status');
    const actions = el('div', undefined, 'pl-piece-actions');
    const deployment=result.deployments?.[piece.ownedPieceId];
    if(deployment)main.append(el('span',deployment.status==='placed'?(deployment.mapName?`位于 ${deployment.mapName}`:'已放出'):deployment.status==='conflict'?'身份冲突':'已收起','pl-badge'));
    const placement = config.describePlacement?.(piece) || {};
    if (placement.hint && (placement.blocked || !result.deployments)) main.append(el('p', placement.hint, 'pl-panel-copy'));
    if (config.place) {
      const placeControl=button(placement.label || config.placeLabel || '释放到当前地图', () => runPieceAction(key, async () => {
      if (drafts.has(key)) throw new Error('请先保存或放弃这枚收藏的修改，再操作地图棋子');
      const actionView = loadSerial;
      const destination = config.mapId?.();
      const latestPlacement = config.describePlacement?.(piece);
      if (latestPlacement?.blocked) throw new Error(latestPlacement.hint);
      const fresh = await api({op: 'get', playerId: result.profile.playerId});
      const currentPiece = fresh.library.pieces.find(item => item.ownedPieceId === piece.ownedPieceId);
      if (!currentPiece) throw new Error('这枚收藏已不存在，请刷新小库');
      if (config.mapId && destination !== config.mapId()) throw new Error('地图已切换，请核对目标地图后重试');
      if (drafts.has(key)) throw new Error('资料正在编辑，请先保存或放弃修改');
      if (actionView !== loadSerial || !dialog.open) throw new Error('档案视图已切换，请重新操作');
      await config.place(currentPiece, fresh.profile);
      if (actionView !== loadSerial || !dialog.open) return;
      status.textContent = config.placeStatus || '已放入地图';
      feedback.textContent = '已释放到当前地图';
      if (returnToMap) dialog.close();
      else { actionsInFlight.delete(key); await load(); }
      }), 'pl-primary', () => true, feedback);
      placeControl.disabled=!!placement.blocked;
      actions.append(placeControl);
    }
    if(config.recall && deployment?.status==='placed')actions.append(button('远程收回',()=>runPieceAction(key,async()=>{
      if(drafts.has(key))throw new Error('请先保存或放弃修改');
      await config.recall(piece);actionsInFlight.delete(key);await load();
    }),'',()=>true,feedback));
    if (config.bind) {
      const advanced = el('details', undefined, 'pl-editor');
      advanced.append(el('summary', '关联已有棋子'));
      advanced.append(button('关联地图上选中的旧棋子', () => runPieceAction(key, async () => {
      if (drafts.has(key)) throw new Error('请先保存或放弃这枚收藏的修改，再操作地图棋子');
      const actionView = loadSerial;
      const bindingTarget = config.bindingTarget?.();
      const fresh = await api({op: 'get', playerId: result.profile.playerId});
      const currentPiece = fresh.library.pieces.find(item => item.ownedPieceId === piece.ownedPieceId);
      if (!currentPiece) throw new Error('这枚收藏已不存在，请刷新小库');
      if (actionView !== loadSerial || !dialog.open) throw new Error('档案视图已切换，请重新操作');
      if (drafts.has(key)) throw new Error('资料正在编辑，请先保存或放弃修改');
      if (config.bindingTarget && bindingTarget !== config.bindingTarget()) throw new Error('选中的地图棋子已变化，请核对后重试');
      if (await config.bind(currentPiece, fresh.profile)) {
        if (actionView !== loadSerial || !dialog.open) return;
        status.textContent = feedback.textContent = '已关联，保留旧棋子的本战役状态';
        if (returnToMap) dialog.close();
        else { actionsInFlight.delete(key); await load(); }
      }
    }), '', () => true, feedback));
      actions.append(advanced);
    }
    if (actions.children.length) main.append(actions);
    main.append(feedback);
    const roleTools=el('div',undefined,'pl-piece-actions pl-role-tools');
    roleTools.append(el('span',roleLabels[piece.collectionRole]||'角色','pl-badge'));
    for(const [role,label] of Object.entries(roleLabels)){if(role===piece.collectionRole)continue;roleTools.append(button('设为'+label,async()=>{if(drafts.has(key))throw new Error('请先保存或放弃资料修改');await api({op:'edit',playerId:result.profile.playerId,ownedPieceId:piece.ownedPieceId,revision:result.library.revision,pieceRevision:piece.revision,patch:{collectionRole:role}});await load();}));}
    main.append(roleTools);

    const formPanel = el('details', undefined, 'pl-editor');
    const variants = piece.portraitVariants || [];
    const currentForm = portraitFormIndex(piece, variants);
    formPanel.append(el('summary', `形态管理 · ${variants.length} 个形态`));
    const formList = el('div', undefined, 'pl-form-list');
    variants.forEach((variant, index) => {
      const item = button((index === currentForm ? '默认 · ' : '') + variant.name, async () => {
        if (drafts.has(key)) throw new Error('请先保存或放弃资料草稿');
        await api({op:'edit', playerId:result.profile.playerId, ownedPieceId:piece.ownedPieceId,
          revision:result.library.revision, pieceRevision:piece.revision, patch:{portraitVariant:index}});
        await load();
        status.textContent = '默认形态已保存，已有地图棋子的状态保持不变';
      }, '', () => !saving.has(key) && !actionsInFlight.has(key), feedback);
      if (variant.iconImgPath) {
        const preview = el('img'); preview.src = variant.iconImgPath; preview.alt = ''; preview.loading = 'lazy';
        const thumb=el('span');thumb.style.cssText='display:block;position:relative;flex:0 0 40px;width:40px;height:40px;border-radius:50%;overflow:hidden';thumb.append(preview);item.append(thumb);
        SundollPortraitView.apply(preview,variant,{legacyScale:1});
      }
      formList.append(item);
      if (variant.iconImgPath) formList.append(button('调整「'+variant.name+'」显示范围', async () => {
        if (drafts.has(key)) throw new Error('请先保存或放弃资料草稿');
        const view=await SundollPortraitView.edit({src:variant.iconImgPath,view:variant.portraitView,legacyScale:1.163,title:'调整「'+variant.name+'」显示范围'});
        if(!view)return;
        const forms=(piece.portraitVariants||[]).map((v,i)=>i===index?{...v,portraitView:view}:{...v});
        const patch={portraitVariants:forms};
        if(currentForm===index)patch.portraitView=view;
        await api({op:'edit',playerId:result.profile.playerId,ownedPieceId:piece.ownedPieceId,revision:result.library.revision,pieceRevision:piece.revision,patch});
        await load(); status.textContent='形态显示范围已保存';
      },'',()=>!saving.has(key)&&!actionsInFlight.has(key),feedback));
    });
    if (!variants.length) formList.append(el('p', '暂无形态', 'pl-panel-copy'));
    formPanel.append(formList);
    if (config.host && !piece.characterId) formPanel.append(button('从来源棋子补齐形态', async () => {
      if (drafts.has(key)) throw new Error('请先保存或放弃资料草稿');
      await api({op:'syncForms',playerId:result.profile.playerId,ownedPieceId:piece.ownedPieceId});
      await load(); status.textContent = '来源形态已补齐；重新带入地图即可补充地图形态，血量与状态保持不变';
    }, '', () => !saving.has(key) && !actionsInFlight.has(key), feedback));
    main.append(formPanel);

    const editor = el('details', undefined, 'pl-editor');
    const editorSummary = el('summary', draft ? '编辑收藏资料 · 有未保存修改' : '编辑收藏资料');
    editor.append(editorSummary, stateBadge);
    editor.open = !!draft || piece.ownedPieceId === requestedEditor;
    const editorGrid = el('div', undefined, 'pl-editor-grid');
    const name = el('input');
    name.value = draft?.name ?? piece.name;
    name.maxLength = 60;
    const nameLabel = el('label', '收藏名称');
    nameLabel.append(name);
    const statInputs = {};
    if (config.host) {
      for (const [field, title, min, max] of [['hpMax','生命上限',1,99999],['ac','护甲等级 AC',0,99],['level','等级',1,99]]) {
        const input = el('input');
        input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1';
        input.value = String(draft?.stats?.[field] ?? piece[field] ?? (field === 'ac' ? 10 : 1));
        const label = el('label', title); label.append(input); editorGrid.append(label);
        statInputs[field] = input;
        input.oninput = () => capture();
      }
      const select = el('select');
      SundollSize.categories.forEach((category, index) => {
        const option = el('option', `${SundollSize.labels[index]} · ${SundollSize.footprints[index]}×${SundollSize.footprints[index]}`);
        option.value = category; select.append(option);
      });
      select.value = draft?.stats?.sizeCategory ?? SundollSize.category(piece);
      select.onchange = () => capture();
      statInputs.sizeCategory = select;
      const label = el('label', '体型'); label.append(select); editorGrid.append(label);
    }
    const note = el('textarea');
    note.value = draft?.publicNote ?? (piece.publicNote || '');
    note.maxLength = 240;
    const noteLabel = el('label', '玩家可见的公开资料', 'pl-wide');
    noteLabel.append(note);
    const image = el('input');
    image.type = 'file';
    image.accept = 'image/png,image/jpeg,image/webp,image/gif';
    const imageLabel = el('label', '更换收藏立绘');
    imageLabel.append(image);
    const fileHint = el('small', draft?.file ? `已保留待上传图片：${draft.file.name}` : 'PNG、JPEG、WebP 或 GIF，最大 16 MB', 'pl-file-hint');
    imageLabel.append(fileHint);
    function capture(acceptedUpload) {
      const pending=drafts.get(key);
      const next = {name: name.value, publicNote: note.value, file: acceptedUpload ? acceptedUpload.file : pending?.file || null, portraitView: acceptedUpload ? acceptedUpload.portraitView : pending?.portraitView, baseRevision};
      next.stats = Object.fromEntries(Object.entries(statInputs).map(([field, input]) => [field, input.value]));
      const statsChanged = Object.entries(next.stats).some(([field, value]) => String(field === 'sizeCategory' ? SundollSize.category(piece) : piece[field] ?? (field === 'ac' ? 10 : 1)) !== value);
      if (!saving.has(key) && !statsChanged && !next.file && next.name === piece.name && next.publicNote === (piece.publicNote || '')) drafts.delete(key);
      else drafts.set(key, next);
      editorSummary.textContent = drafts.has(key) ? '编辑收藏资料 · 有未保存修改' : '编辑收藏资料';
      stateBadge.textContent = saving.has(key) ? '保存中' : drafts.has(key) ? '未保存' : '已保存';
      cancelPortrait.hidden = !drafts.get(key)?.file;
      discard.hidden = !drafts.has(key);
      cancelPortrait.disabled = !drafts.get(key)?.file || saving.has(key);
      discard.disabled = saving.has(key) || !drafts.has(key);
      fileHint.textContent = next.file ? `待上传：${next.file.name}` : 'PNG、JPEG、WebP 或 GIF，最大 16 MB';
    }
    name.oninput = note.oninput = () => capture();
    image.onchange = async () => {
      const file = image.files[0];
      if (file && (file.size > 16 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
        image.value = '';
        feedback.textContent = '请选择不超过 16 MB 的 PNG、JPEG、WebP 或 GIF 图片；原有草稿已保留。';
        return;
      }
      if (!file) return;
      try {
        const {src}=await SundollPortraitView.prepareFile(file);
        const view=await SundollPortraitView.edit({src});
        if(!view){image.value='';return;}
        if(image.files[0]!==file)return;
        capture({file,portraitView:view});
        feedback.textContent='图片和显示范围已准备好，点击保存收藏资料生效';
      } catch(error) { image.value='';feedback.textContent=error.message; }
    };
    const cancelPortrait = button('取消更换立绘', () => {
      image.value = '';
      const pending = drafts.get(key);
      if (pending) { pending.file = null; delete pending.portraitView; }
      capture();
      feedback.textContent = '已取消更换立绘，文字修改仍保留';
    }, '', () => !!drafts.get(key)?.file && !saving.has(key));
    cancelPortrait.hidden = !draft?.file;
    cancelPortrait.disabled = !draft?.file || saving.has(key);
    imageLabel.append(cancelPortrait);

    editorGrid.append(nameLabel, imageLabel, noteLabel);
    editor.append(editorGrid);
    if (draft && draft.baseRevision !== piece.revision) {
      editor.open = true;
      editor.append(el('p', `这枚棋子已在另一处更新。最新名称：${piece.name}；最新公开资料：${piece.publicNote || '（空）'}。你的草稿仍保留。`, 'pl-conflict'));
    }
    const editorActions = el('div', undefined, 'pl-editor-actions');
    if (draft && draft.baseRevision !== piece.revision) editorActions.append(button('基于最新版本继续编辑', async () => {
      if (!confirm('已查看最新资料，继续保留自己的草稿？再次保存会提交当前草稿。')) return;
      const latestDraft = drafts.get(key);
      if (latestDraft) latestDraft.baseRevision = piece.revision;
      await load();
    }));
    const discard = button('放弃未保存修改', async () => {
      if (!confirm('放弃这枚棋子尚未保存的编辑？')) return;
      drafts.delete(key);
      name.value = piece.name; note.value = piece.publicNote || ''; image.value = '';
      for (const [field, input] of Object.entries(statInputs)) input.value = field === 'sizeCategory' ? SundollSize.category(piece) : piece[field] ?? (field === 'ac' ? 10 : 1);
      editorSummary.textContent = '编辑收藏资料';
      stateBadge.textContent = '已保存';
      cancelPortrait.hidden = true; discard.hidden = true;
      cancelPortrait.disabled = true;
      feedback.textContent = '已放弃未保存修改';
      fileHint.textContent = 'PNG、JPEG、WebP 或 GIF，最大 16 MB';
      if (draft && draft.baseRevision !== piece.revision) await load();
    }, '', () => drafts.has(key) && !saving.has(key));
    discard.hidden = !draft;
    discard.disabled = !draft || saving.has(key);
    editorActions.append(discard);
    editorActions.append(button('保存收藏资料', async () => {
      if (saving.has(key) || actionsInFlight.has(key)) return;
      capture();
      const submittedDraft = drafts.get(key);
      if (!submittedDraft) { status.textContent = '没有需要保存的修改'; return; }
      if (!submittedDraft.name.trim()) throw new Error('请填写收藏名称');
      for (const input of Object.values(statInputs)) {
        if (input === statInputs.sizeCategory) continue;
        if (!input.value.trim() || !input.checkValidity()) throw new Error('请填写范围内的整数属性');
      }
      saving.add(key);
      stateBadge.textContent = '保存中';
      cancelPortrait.disabled = true;
      feedback.textContent = '正在保存；你可以继续输入，后续修改会保留为草稿';
      discard.disabled = true;
      const viewSerial = loadSerial;
      try {
      const patch = {name: name.value, publicNote: note.value};
      for (const [field, value] of Object.entries(submittedDraft.stats || {})) {
        if (field === 'sizeCategory') {
          if (value !== SundollSize.category(piece)) Object.assign(patch, SundollSize.normalize({sizeCategory: value}));
          continue;
        }
        if (Number(value) !== piece[field]) patch[field] = Number(value);
      }
      const file = submittedDraft?.file;
      if (file) {
        patch.portraitView = submittedDraft.portraitView || SundollPortraitView.defaultView();
        if (file.size > 16 * 1024 * 1024) throw new Error('立绘不能超过 16 MB');
        patch.iconImg = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
      const saved = await api({op: 'edit', playerId: result.profile.playerId, ownedPieceId: piece.ownedPieceId, revision: result.library.revision, pieceRevision: baseRevision, patch});
      config.onPieceEdited?.(result.profile.playerId, piece.ownedPieceId, patch);
      if (drafts.get(key) === submittedDraft) drafts.delete(key);
      else if (drafts.has(key)) {
        const pending = drafts.get(key);
        pending.baseRevision = saved.library.pieces.find(item => item.ownedPieceId === piece.ownedPieceId).revision;
        if (pending.file === submittedDraft.file) pending.file = null;
      }
      saving.delete(key);
      if (viewSerial === loadSerial) {
        await load();
        status.textContent = '收藏资料已保存；其他棋子的未保存草稿仍保留';
      }
      } catch (error) {
        if (viewSerial === loadSerial && error.status === 409) {
          saving.delete(key);
          await load();
          status.textContent = '资料已在另一处更新。草稿已保留，请在卡片中核对最新资料后继续。';
          return;
        }
        throw error;
      } finally {
        saving.delete(key);
        stateBadge.textContent = drafts.has(key) ? '未保存' : '已保存';
        cancelPortrait.disabled = !drafts.get(key)?.file;
        discard.disabled = !drafts.has(key);
      }
    }, 'pl-primary', () => true, feedback));
    editor.append(editorActions);
    main.append(editor);
    card.append(portrait, main);
    return card;
  }
  async function load() {
    if (saving.size || actionsInFlight.size) { status.textContent = '正在处理收藏，请完成后再刷新或切换档案'; return; }
    const serial = ++loadSerial;
    headingTitle.textContent=config.host?'参团角色':'我的角色';
    headingCopy.textContent='';headingBack.hidden=true;
    let targetPlayer = selected;
    status.textContent = '正在读取角色…';
    const nextContent = el('div');
    let players = [];
    if (config.host) {
      ({players} = await api({op: 'list'}));
      if (serial !== loadSerial) return;
      if (targetPlayer && !players.some(player => player.playerId === targetPlayer)) { selected = ''; targetPlayer = ''; }
      if (window.SundollRoom && players.length) {
        const owner=players.find(p=>(p.characters||[]).some(c=>c.characterId===focusedPiece)) || players.find(p=>p.playerId===targetPlayer) || players[0];
        targetPlayer=selected=owner.playerId;
        if(!(owner.characters||[]).some(c=>c.characterId===focusedPiece)) focusedPiece=owner.characters?.[0]?.characterId || '';
        page='library';
      }
      if (window.SundollRoom) nextContent.append(roomCharacterPicker(players));
      else if (page === 'profile' || !targetPlayer) nextContent.append(hostPicker(players, targetPlayer));
      if (!targetPlayer) {
        nextContent.append(el('div', '选择成员查看角色', 'pl-empty'));
        content.replaceChildren(nextContent);
        status.textContent = players.length ? `共有 ${players.length} 位参团成员` : '还没有参团角色';
        return;
      }
    }
    const result = await api({op: 'get', ...(config.host ? {playerId: targetPlayer} : {})});
    if (serial !== loadSerial) return;
    current = result;
    if (config.host && window.SundollRoom && focusedPiece) result.library.pieces=result.library.pieces.filter(piece=>piece.ownedPieceId===focusedPiece);
    if (config.host && page === 'profile') nextContent.append(profilePanel(result, players));
    if (config.host && page === 'profile') {
      content.replaceChildren(nextContent);
      status.textContent = '';
      content.querySelector?.('.pl-player-preview[aria-pressed="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
      return;
    }
    headingTitle.textContent=window.SundollRoom?(config.host?'参团角色':'我的角色'):`${result.profile.name}的角色与伙伴`;
    headingBack.hidden=(!!window.SundollRoom || !config.host)&&!libraryReturn;
    headingBack.textContent=libraryReturn?'← 返回背包':'← 返回角色列表';
    const libraryHead=el('div',undefined,'pl-library-head');
    const count=el('span',`${result.library.pieces.length} 枚棋子`,'pl-library-count');
    nextContent.append(libraryHead);
    if (config.place && result.library.pieces.length) {
      const mapTools = el('div', undefined, 'pl-map-tools');
      const destination = config.mapName?.();
      mapTools.append(el('strong', destination ? `当前地图：${destination}` : '尚未选择可用地图'));
      const preference = el('label');
      const check = el('input'); check.type = 'checkbox'; check.checked = returnToMap;
      check.onchange = () => { returnToMap = check.checked; };
      preference.append(check, el('span', '操作成功后返回地图'));
      mapTools.append(preference);
      nextContent.append(mapTools);
    }
    const list = el('div');
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索棋子…';
    search.setAttribute('aria-label', '搜索个人收藏');
    search.className = 'pl-search';
    search.value = focusedPiece ? '' : searches.get(result.profile.playerId) || '';
    const searchRow = el('div', undefined, 'pl-search-row');
    const searchCount = el('p', '', 'pl-library-count');
    searchCount.setAttribute('role', 'status');
    const clearSearch = button('清空搜索', () => { search.value = ''; search.oninput(); });
    searchRow.append(search, clearSearch);
    search.disabled=!result.library.pieces.length;
    if(config.host&&window.SundollRoom) {searchRow.hidden=true;collectionFilter='all';}
    libraryHead.append(searchRow,button('刷新',load),count);
    const rank={main:0,character:1,companion:2};
    const roleTabs=el('nav',undefined,'pl-piece-actions pl-category-tabs');roleTabs.setAttribute('aria-label','棋子分类');
    for(const [role,label] of Object.entries({all:'全部',...roleLabels})){const tab=button(label,()=>{collectionFilter=role;for(const control of roleTabs.children)control.setAttribute('aria-pressed',String(control.dataset.role===role));search.oninput();});tab.dataset.role=role;tab.setAttribute('aria-pressed',String(role===collectionFilter));roleTabs.append(tab);}nextContent.append(roleTabs);
    if(config.host&&window.SundollRoom) roleTabs.hidden=true;
    const orderedPieces = [...result.library.pieces].sort((a,b) => Number(b.ownedPieceId===focusedPiece)-Number(a.ownedPieceId===focusedPiece)||(rank[a.collectionRole]??1)-(rank[b.collectionRole]??1));
    const cards = orderedPieces.map(piece => ({piece, card: pieceCard(piece, result)}));
    const empty = el('div', '没有匹配的收藏', 'pl-empty'); empty.hidden = true;
    search.oninput = () => {
      clearSearch.hidden = !search.value;
      searches.set(result.profile.playerId, search.value);
      const query = search.value.trim().toLocaleLowerCase(); let count = 0;
      cards.forEach(({piece, card}) => {
        const pending = drafts.get(draftKey(result.profile.playerId, piece.ownedPieceId));
        card.hidden = (collectionFilter!=='all'&&piece.collectionRole!==collectionFilter)||![piece.name, piece.publicNote, pending?.name, pending?.publicNote].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
        if (!card.hidden) count++;
      });
      empty.hidden = count > 0;
      searchCount.textContent = query ? `找到 ${count} / ${cards.length} 枚收藏` : '';
    };
    search.oninput();
    if (cards.length) { nextContent.append(searchCount); cards.forEach(({card}) => list.append(card)); list.append(empty); }
    else list.append(el('div', '暂无棋子', 'pl-empty'));
    nextContent.append(list);
    content.replaceChildren(nextContent);
    if(!(config.host&&window.SundollRoom)) focusedPiece = '';
    status.textContent = '';
  }
  async function open(options = {}) {
    collectionFilter='all';libraryReturn=typeof options.onBack==='function'?options.onBack:null;
    focusedPiece = options.ownedPieceId || '';
    requestedEditor = options.edit === false ? '' : focusedPiece;
    if (options.playerId) selected = options.playerId;
    page = focusedPiece || options.page === 'library' ? 'library' : 'profile';
    if (focusedPiece && current) searches.delete(current.profile.playerId);
    ensure();
    if (!dialog.open) dialog.showModal();
    try { await load(); }
    catch (error) { status.textContent = error.message; }
  }
  async function grant(preset) {
    const serial = ++loadSerial;
    ensure();
    if (!dialog.open) dialog.showModal();
    content.replaceChildren();
    status.textContent = '正在读取角色…';
    try {
      const {players} = await api({op: 'list'});
      if (serial !== loadSerial) return;
      if (!players.length) { await load(); return; }
      const panel = el('section', undefined, 'pl-panel');
      panel.append(el('h3', `发放「${preset.name}」`), el('p', '发放后会成为玩家的独立收藏；之后修改大棋子库不会覆盖它。', 'pl-panel-copy'));
      const select = el('select');
      select.setAttribute('aria-label', '发给哪位玩家');
      players.forEach(player => select.append(new Option(player.name, player.playerId)));
      const request = {
        preset: JSON.parse(JSON.stringify(preset)),
        grantId: Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, '0')).join(''),
      };
      grantRequest = request;
      panel.append(select, button('确认发放', async () => {
        if (grantRequest !== request || serial !== loadSerial || !dialog.open) return;
        select.disabled = true;
        request.playerId ||= select.value;
        await api({op: 'grant', ...request});
        if (grantRequest !== request || serial !== loadSerial || !dialog.open) return;
        selected = request.playerId;
        grantRequest = null;
        await load();
        status.textContent = '发放成功，独立收藏及立绘已保存到玩家小库';
      }, 'pl-primary'), button('返回玩家档案', load));
      content.append(panel);
      status.textContent = '请选择接收玩家';
    } catch (error) { status.textContent = error.message; }
  }
  return {
    configure(options) { config = options; },
    open,
    grant,
    api,
    async saveForms(token) {
      if (!token?.ownedPieceId || !token.ownerPlayerId) throw new Error('请先将棋子绑定到玩家收藏');
      const fresh = await api({op:'get',playerId:token.ownerPlayerId});
      const piece = fresh.library.pieces.find(p => p.ownedPieceId === token.ownedPieceId);
      if (!piece) throw new Error('对应收藏不存在');
      const variants = token.portraitVariants || [];
      const selectedForm = portraitFormIndex(token, variants);
      const patch = {portraitVariants:variants};
      if (config.host) patch.initiativePortrait = token.initiativePortrait || null;
      if (selectedForm >= 0) patch.portraitVariant = selectedForm;
      return api({op:'edit',playerId:token.ownerPlayerId,ownedPieceId:token.ownedPieceId,
        revision:fresh.library.revision,pieceRevision:piece.revision,patch});
    },
    buttonFor(preset) {
      const control = el('button', '发给玩家');
      control.type = 'button';
      control.className = 'small';
      control.onclick = () => grant(preset);
      return control;
    },
  };
})();
