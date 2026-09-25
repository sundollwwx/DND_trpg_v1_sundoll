/* Shared player profile and personal collection UI. Only the server writes player files. */
window.PlayerLibrary = (() => {
  let config = {}, dialog, content, status, selected = '', current, grantRequest, loadSerial = 0;
  let headingTitle, headingCopy, headingBack, libraryReturn=null;
  const drafts = new Map();
  const saving = new Set();
  const searches = new Map();
  let returnToMap = true, focusedPiece = '', page = 'profile';
  const actionsInFlight = new Set();
  async function runPieceAction(key, action) {
    if (actionsInFlight.has(key) || saving.has(key)) return;
    actionsInFlight.add(key);
    try { await action(); } finally { actionsInFlight.delete(key); }
  }
  const draftKey = (pid, oid) => `${pid}:${oid}`;
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
        panel.append(el('h3', '登录后使用个人收藏'), el('p', '在玩家首页输入你的玩家名字，或创建一个尚未使用的新名字。', 'pl-panel-copy'));
        if (config.signIn) panel.append(button('使用名字登录', () => { dialog.close(); config.signIn(); }, 'pl-primary'));
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
      .player-library-dialog{position:fixed;inset:0;width:min(920px,94vw);max-height:88vh;margin:auto;box-sizing:border-box;border:1px solid #665d49;border-radius:18px;background:#171c26;color:#eef1f7;padding:0;overflow:hidden}
      .player-library-dialog[open]{display:flex;flex-direction:column}.player-library-dialog>header,.player-library-dialog>.pl-status{flex-shrink:0}
      .player-library-dialog::backdrop{background:#000b;backdrop-filter:blur(2px)}
      .player-library-dialog *{box-sizing:border-box}.player-library-dialog [hidden]{display:none!important}.player-library-dialog button:focus-visible,.player-library-dialog summary:focus-visible,.player-library-dialog input:focus-visible{outline:2px solid #e8c66f;outline-offset:3px}.player-library-dialog .pl-piece-top h4{margin:0;overflow-wrap:anywhere}.player-library-dialog .pl-panel-copy{overflow-wrap:anywhere;white-space:pre-wrap}
      .player-library-dialog button,.player-library-dialog input,.player-library-dialog select,.player-library-dialog textarea{font:inherit;color:inherit;background:#252c3a;border:1px solid #4d586d;border-radius:8px;padding:9px 11px;max-width:100%}
      .player-library-dialog button{cursor:pointer}.player-library-dialog button:hover{border-color:#d8ad4c}.player-library-dialog button:disabled{cursor:default;opacity:.55}
      .player-library-dialog .pl-primary{background:#d9ad49;border-color:#e8c66f;color:#17130b;font-weight:700}
      .player-library-dialog .pl-danger{color:#ffaaa9;border-color:#79484d}.player-library-dialog .pl-muted{color:#aab2c2}
      .player-library-dialog>header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid #343d4d;background:#171c26}
      .player-library-dialog>header h2{margin:0;color:#e7bd5b;font-size:20px}.player-library-dialog>header button{padding:7px 12px}
      .player-library-dialog .pl-status{min-height:38px;margin:0;padding:10px 22px;background:#202634;color:#e8c675;white-space:pre-wrap}
      .player-library-dialog .pl-content{padding:18px 22px 26px;overflow:auto;min-height:0;flex:1}
      .player-library-dialog .pl-panel{padding:16px;border:1px solid #394356;border-radius:13px;background:#1d2330;margin-bottom:14px}
      .player-library-dialog .pl-panel h3,.player-library-dialog .pl-panel h4{margin:0}.player-library-dialog .pl-panel-copy{margin:6px 0 0;color:#aab2c2;font-size:13px;line-height:1.5}
      .player-library-dialog .pl-picker-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin-top:14px}
      .player-library-dialog .pl-player-picker>summary{cursor:pointer;color:#cbd2df}.player-library-dialog .pl-player-picker[open]>summary{margin-bottom:12px}.player-library-dialog .pl-search{width:100%}.player-library-dialog .pl-picker-block summary{cursor:pointer}.player-library-dialog .pl-picker-block{display:grid;gap:7px}.player-library-dialog .pl-picker-block label{color:#bcc4d3;font-size:12px}.player-library-dialog .pl-create-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}
      .player-library-dialog .pl-profile-head,.player-library-dialog .pl-library-head,.player-library-dialog .pl-piece-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .player-library-dialog .pl-profile-name{font-size:18px;color:#f0c861}.player-library-dialog .pl-badge{padding:4px 8px;border-radius:999px;background:#30384a;color:#b9c2d3;font-size:11px;white-space:nowrap}
      .player-library-dialog .pl-profile-tools{margin-top:12px;border-top:1px solid #343d4d;padding-top:10px}.player-library-dialog .pl-profile-tools summary,.player-library-dialog .pl-editor summary{cursor:pointer;color:#cbd2df}
      .player-library-dialog .pl-profile-actions,.player-library-dialog .pl-piece-actions,.player-library-dialog .pl-editor-actions,.player-library-dialog .pl-credential-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
      .player-library-dialog .pl-library-head{margin:20px 0 10px}.player-library-dialog .pl-library-head h3{margin:0;color:#e7bd5b}.player-library-dialog .pl-library-count{color:#98a3b8;font-size:12px}
      .player-library-dialog .pl-form-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:12px 0}.player-library-dialog .pl-form-list button{display:flex;flex-direction:column;align-items:center;gap:8px}.player-library-dialog .pl-form-list img{width:80px;height:96px;object-fit:contain}.player-library-dialog .pl-map-tools{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 0;color:#bbc5d5;font-size:13px}.player-library-dialog .pl-map-tools strong{overflow-wrap:anywhere}.player-library-dialog .pl-map-tools label{display:flex;align-items:center;gap:7px}.player-library-dialog input[type=checkbox]{accent-color:#d9ad49;width:18px;height:18px}.player-library-dialog .pl-card-feedback{margin:8px 0;color:#e8c675;font-size:13px;white-space:pre-wrap}.player-library-dialog .pl-card-feedback:empty{display:none}.player-library-dialog .pl-search-row{display:flex;gap:8px}.player-library-dialog .pl-search-row .pl-search{min-width:0;flex:1}.player-library-dialog .pl-empty{text-align:center;padding:34px 18px;border:1px dashed #4a5569;border-radius:13px;color:#aab2c2}
      .player-library-dialog .pl-piece-card{display:grid;grid-template-columns:96px minmax(0,1fr);gap:16px;padding:16px;margin-top:10px;border:1px solid #3b4659;border-radius:14px;background:#1c222e}
      .player-library-dialog .pl-portrait{display:grid;place-items:center;width:96px;height:112px;border-radius:11px;background:#121722;border:1px solid #343d4d;overflow:hidden;color:#727d91;font-size:30px}
      .player-library-dialog .pl-portrait img{width:100%;height:100%;object-fit:contain}.player-library-dialog .pl-piece-main{min-width:0}
      .player-library-dialog .pl-piece-top h4{font-size:17px;color:#f0f2f7}.player-library-dialog .pl-piece-meta{margin:7px 0;color:#aab2c2;font-size:12px}
      .player-library-dialog .pl-piece-actions{margin:10px 0}.player-library-dialog .pl-piece-actions>.pl-editor{flex-basis:100%}.player-library-dialog .pl-editor{margin-top:10px;border-top:1px solid #343d4d;padding-top:10px}
      .player-library-dialog .pl-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:12px;margin-top:12px}.player-library-dialog .pl-editor label{display:grid;gap:6px;color:#b8c0cf;font-size:12px}.player-library-dialog .pl-editor .pl-wide{grid-column:1/-1}
      .player-library-dialog textarea{width:100%;min-height:76px;resize:vertical}.player-library-dialog .pl-file-hint{min-height:18px;color:#e8c675}
      .player-library-dialog .pl-conflict{padding:10px;border-radius:8px;background:#3a2c27;color:#ffd3a6;font-size:12px}.player-library-dialog .pl-credential{width:100%;min-height:100px;word-break:break-all}
      .player-library-dialog{border-color:#706248;background:#191e25;box-shadow:0 26px 100px #0009;font:14px/1.55 system-ui,sans-serif}
      .player-library-dialog>header{padding:23px 26px;background:radial-gradient(ellipse at top right,#b68b3530,transparent 68%),#1c222a;border-bottom-color:#bca36a2b}
      .player-library-dialog>header h2{font-size:23px;letter-spacing:1px;color:#f0e3c9}
      .player-library-dialog .pl-eyebrow{display:block;color:#bfa677;font-size:10px;letter-spacing:2.5px;margin-bottom:4px}
      .player-library-dialog .pl-header-copy{margin:5px 0 0;color:#a9b0bc;font-size:12px}
      .player-library-dialog .pl-status{background:#141a21;border-bottom:1px solid #ffffff08;color:#c7b48e;font-size:12px;min-height:0;padding:9px 26px}
      .player-library-dialog .pl-status:empty{display:none}
      .player-library-dialog .pl-content{padding:22px 26px 28px}
      .player-library-dialog .pl-panel{background:#222933;border-color:#ffffff12;padding:20px}
      .player-library-dialog .pl-profile-panel{background:linear-gradient(115deg,#30302c,#222933 65%);border-color:#aa906746}
      .player-library-dialog .pl-profile-identity{display:flex;align-items:center;gap:12px;min-width:0}
      .player-library-dialog .pl-avatar{display:grid;place-items:center;flex-shrink:0;width:44px;height:44px;border-radius:13px;background:#d3b37d1c;border:1px solid #d3b37d55;color:#f1d9ad;font-size:20px;font-weight:650}
      .player-library-dialog .pl-profile-name{color:#f4e7ce;font-size:21px;overflow-wrap:anywhere}
      .player-library-dialog .pl-profile-panel>button{margin-top:16px}
      .player-library-dialog .pl-profile-tools{margin-top:18px;padding-top:14px;border-color:#ffffff10;font-size:12px}
      .player-library-dialog .pl-badge{background:#11182077;border:1px solid #ffffff12;color:#b0b9c5}
      .player-library-dialog .pl-primary{background:#d8b780;border-color:#e4c894;color:#272115}
      .player-library-dialog .pl-primary:hover{background:#e9cc9c}
      .player-library-dialog .pl-library-head{margin-top:26px}.player-library-dialog .pl-library-head h3{color:#e7dac0;font-size:16px}
      .player-library-dialog .pl-piece-card{background:#202731;border-color:#ffffff12;box-shadow:0 4px 16px #0001}
      .player-library-dialog select{width:100%}.player-library-dialog .pl-picker-grid{gap:22px}
      .player-library-dialog .pl-code-field{display:grid;gap:8px;margin:22px 0 10px;max-width:480px;color:#b9c2d0;font-size:12px}
      .player-library-dialog .pl-code-field input{font:17px/1.6 ui-monospace,monospace;padding:12px 14px;letter-spacing:.5px;background:#161c24;border-color:#a88c5a88}
      @media(max-width:680px){.player-library-dialog>header{padding:17px}.player-library-dialog>header h2{font-size:20px}.player-library-dialog .pl-header-copy{max-width:220px}.player-library-dialog .pl-picker-grid,.player-library-dialog .pl-editor-grid{grid-template-columns:1fr}.player-library-dialog .pl-piece-card{grid-template-columns:70px minmax(0,1fr)}.player-library-dialog .pl-portrait{width:70px;height:84px}.player-library-dialog .pl-piece-top{align-items:flex-start}.player-library-dialog .pl-content{padding:14px}.player-library-dialog .pl-create-row{grid-template-columns:1fr}.player-library-dialog .pl-profile-head{flex-wrap:wrap}.player-library-dialog .pl-panel{padding:16px}}

      .player-library-dialog{width:min(1040px,95vw);max-height:90vh;border-color:#796248;border-radius:20px;background:#191e23;color:#eee8dc}
      .player-library-dialog>header{padding:14px 24px 12px;background:radial-gradient(ellipse at top right,#5d473844,transparent 65%);border-color:#bca36a22}
      .player-library-dialog>header h2{font-size:24px;letter-spacing:2px;color:#f2e6cc}
      .player-library-dialog .pl-header-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .player-library-dialog .pl-header-copy:empty,.player-library-dialog .pl-library-count:empty{display:none}
      .player-library-dialog button,.player-library-dialog input,.player-library-dialog select,.player-library-dialog textarea{background:#252c30;border-color:#4f514f;border-radius:9px}
      .player-library-dialog .pl-primary{background:#d6b679;border-color:#e6c88c;color:#231e16}
      .player-library-dialog .pl-content{padding:16px 24px 20px}
      .player-library-dialog .pl-library-head{margin:0 0 14px;display:flex;gap:10px;flex-wrap:wrap}
      .player-library-dialog .pl-library-head .pl-search-row{width:300px;max-width:100%}
      .player-library-dialog .pl-library-head .pl-library-count{margin-left:auto;color:#aaa594}
      .player-library-dialog .pl-map-tools{border-top:1px solid #bca36a18;font-size:12px;color:#aaa594}
      .player-library-dialog .pl-empty{border:0;min-height:225px;display:grid;place-items:center;padding:24px;color:#aaa594}
      .player-library-dialog .pl-piece-card{background:#232a2c;border-color:#a3997433;box-shadow:none;align-items:start}
      .player-library-dialog .pl-piece-main>.pl-piece-top{margin:0 0 9px}
      .player-library-dialog .pl-piece-actions>button{min-height:40px;border-radius:9px;padding:8px 13px}
      .player-library-dialog .pl-card-feedback:empty{display:none}
      .player-library-dialog .pl-piece-main>.pl-editor>.pl-badge{display:inline-block;margin-top:10px}
      .player-library-dialog .pl-status{background:transparent;border-top:1px solid #a3937122;border-bottom:0;padding:10px 24px}
      @media(max-width:650px){.player-library-dialog{width:97vw;max-height:95vh;border-radius:13px}.player-library-dialog>header{padding:15px;flex-wrap:wrap}.player-library-dialog .pl-content{padding:12px}.player-library-dialog .pl-library-head .pl-search-row{flex:1;min-width:140px}}

      .player-library-dialog .pl-player-picker{background:transparent;border:0;padding:0;margin-bottom:20px}
      .player-library-dialog .pl-picker-heading{display:flex;align-items:center;gap:12px;margin-bottom:12px}
      .player-library-dialog .pl-picker-heading h3{font-size:14px;color:#d8c9aa}
      .player-library-dialog .pl-picker-heading .pl-header-actions{margin-left:auto}
      .player-library-dialog .pl-player-rail{display:flex;gap:12px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;scrollbar-color:#8a7452 #1a2024;padding:3px 2px 12px}
      .player-library-dialog .pl-player-preview{flex:0 0 156px;display:flex;flex-direction:column;align-items:center;gap:9px;padding:18px 12px;scroll-snap-align:center;border:1px solid #a3997433;background:linear-gradient(150deg,#2b3336,#202729);border-radius:13px}
      .player-library-dialog .pl-player-preview[aria-pressed=true]{border-color:#d5b46c;background:linear-gradient(150deg,#514631,#292b29);box-shadow:inset 0 0 0 1px #d5b46c55}
      .player-library-dialog .pl-preview-avatar{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;background:#d3b37d18;border:1px solid #d3b37d55;color:#f1d9ad;font-size:26px}
      .player-library-dialog .pl-player-preview strong{max-width:100%;overflow-wrap:anywhere;color:#eee3cc;font-size:15px}
      .player-library-dialog .pl-preview-caption{font-size:11px;color:#aaa594}
      .player-library-dialog .pl-transfer-row{display:flex;gap:8px;flex-basis:100%}.player-library-dialog .pl-transfer-row select{flex:1;min-width:0;width:auto}
    `;
    document.head.append(style);
    dialog = el('dialog');
    dialog.className = 'player-library-dialog';
    const header = el('header');
    const heading=el('div');
    const title=el('h2', config.host ? '玩家档案管理' : '我的冒险档案');title.id='player-library-title';
    heading.append(el('span', 'ADVENTURER ARCHIVES', 'pl-eyebrow'),title,
      el('p',config.host?'每位冒险者的身份、收藏与随身物品。':'收藏你的角色，继续下一段冒险。','pl-header-copy'));
    headingTitle=title;headingCopy=heading.children[2];
    const headerActions=el('div',undefined,'pl-header-actions');
    headingBack=button('← 返回玩家档案',async()=>{
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
      card.append(avatar,el('strong',player.name),el('span',player.playerId===targetPlayer?'当前玩家':'查看档案','pl-preview-caption'));
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
    head.append(identity, el('span', config.host ? '主控管理视图' : '当前登录玩家', 'pl-badge'));
    panel.append(head, el('p', config.host ? '管理角色与持久伙伴，将已有角色带入当前地图。' : '这里是你的角色名册。将棋子带入地图开始行动；角色与持久伙伴可以随你进入不同战役。', 'pl-panel-copy'));
    const quick=el('div',undefined,'pl-profile-actions');
    if (config.host) quick.append(button('角色名册', async () => { page = 'library'; await load(); }, 'pl-primary'));
    if (config.host && config.backpack) quick.append(button('🎒 查看背包 / 发放物品', () => { dialog.close(); config.backpack(result.profile); }, 'pl-primary'));
    if (config.host) {
      const tools = el('details', undefined, 'pl-profile-tools');
      tools.append(el('summary', '更多操作'));
      const actions = el('div', undefined, 'pl-profile-actions');
      panel.append(quick);
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
    if (config.place) actions.append(button(placement.label || config.placeLabel || '释放到当前地图', () => runPieceAction(key, async () => {
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
    }), 'pl-primary', () => true, feedback));
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

    const formPanel = el('details', undefined, 'pl-editor');
    const variants = piece.portraitVariants || [];
    formPanel.append(el('summary', `形态管理 · ${variants.length} 个形态`));
    const formList = el('div', undefined, 'pl-form-list');
    variants.forEach((variant, index) => {
      const item = button((variant.iconImgPath === piece.iconImgPath ? '默认 · ' : '') + variant.name, async () => {
        if (drafts.has(key)) throw new Error('请先保存或放弃资料草稿');
        await api({op:'edit', playerId:result.profile.playerId, ownedPieceId:piece.ownedPieceId,
          revision:result.library.revision, pieceRevision:piece.revision, patch:{portraitVariant:index}});
        await load();
        status.textContent = '默认形态已保存，已有地图棋子的状态保持不变';
      }, '', () => !saving.has(key) && !actionsInFlight.has(key), feedback);
      if (variant.iconImgPath) {
        const preview = el('img'); preview.src = variant.iconImgPath; preview.alt = ''; preview.loading = 'lazy';
        item.append(preview);
      }
      formList.append(item);
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
    editor.open = !!config.host || !!draft || piece.ownedPieceId === focusedPiece;
    const editorGrid = el('div', undefined, 'pl-editor-grid');
    const name = el('input');
    name.value = draft?.name ?? piece.name;
    name.maxLength = 24;
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
    function capture() {
      const next = {name: name.value, publicNote: note.value, file: image.files[0] || drafts.get(key)?.file || null, baseRevision};
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
    name.oninput = note.oninput = capture;
    image.onchange = () => {
      const file = image.files[0];
      if (file && (file.size > 16 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
        image.value = '';
        feedback.textContent = '请选择不超过 16 MB 的 PNG、JPEG、WebP 或 GIF 图片；原有草稿已保留。';
        return;
      }
      feedback.textContent = '';
      capture();
    };
    const cancelPortrait = button('取消更换立绘', () => {
      image.value = '';
      const pending = drafts.get(key);
      if (pending) pending.file = null;
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
    headingTitle.textContent=config.host?'玩家档案管理':'我的角色';
    headingCopy.textContent='';headingBack.hidden=true;
    let targetPlayer = selected;
    status.textContent = '正在读取玩家档案…';
    const nextContent = el('div');
    let players = [];
    if (config.host) {
      ({players} = await api({op: 'list'}));
      if (serial !== loadSerial) return;
      if (targetPlayer && !players.some(player => player.playerId === targetPlayer)) { selected = ''; targetPlayer = ''; }
      if (page === 'profile' || !targetPlayer) nextContent.append(hostPicker(players, targetPlayer));
      if (!targetPlayer) {
        nextContent.append(el('div', '选择玩家查看档案', 'pl-empty'));
        content.replaceChildren(nextContent);
        status.textContent = players.length ? `共有 ${players.length} 个玩家档案` : '还没有玩家档案';
        return;
      }
    }
    const result = await api({op: 'get', ...(config.host ? {playerId: targetPlayer} : {})});
    if (serial !== loadSerial) return;
    current = result;
    if (config.host && page === 'profile') nextContent.append(profilePanel(result, players));
    if (config.host && page === 'profile') {
      content.replaceChildren(nextContent);
      status.textContent = '';
      content.querySelector?.('.pl-player-preview[aria-pressed="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
      return;
    }
    headingTitle.textContent=`${result.profile.name}的角色与伙伴`;
    headingBack.hidden=!config.host&&!libraryReturn;
    headingBack.textContent=libraryReturn?'← 返回背包':'← 返回玩家档案';
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
    libraryHead.append(searchRow,button('刷新',load),count);
    const orderedPieces = [...result.library.pieces].sort((a,b) => Number(b.ownedPieceId === focusedPiece) - Number(a.ownedPieceId === focusedPiece));
    const cards = orderedPieces.map(piece => ({piece, card: pieceCard(piece, result)}));
    const empty = el('div', '没有匹配的收藏', 'pl-empty'); empty.hidden = true;
    search.oninput = () => {
      clearSearch.hidden = !search.value;
      searches.set(result.profile.playerId, search.value);
      const query = search.value.trim().toLocaleLowerCase(); let count = 0;
      cards.forEach(({piece, card}) => {
        const pending = drafts.get(draftKey(result.profile.playerId, piece.ownedPieceId));
        card.hidden = ![piece.name, piece.publicNote, pending?.name, pending?.publicNote].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
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
    focusedPiece = '';
    status.textContent = '';
  }
  async function open(options = {}) {
    libraryReturn=typeof options.onBack==='function'?options.onBack:null;
    focusedPiece = options.ownedPieceId || '';
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
    status.textContent = '正在读取玩家档案…';
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
      const selectedForm = variants.findIndex(v => ['iconImgPath','iconImgId','iconImgHd','iconImg'].some(k => v[k] && v[k] === token[k]));
      const patch = {portraitVariants:variants};
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
