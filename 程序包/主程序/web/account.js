(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  window.addEventListener('hashchange', () => {
    if (location.hash && location.hash !== '#account-app') location.reload();
  });
  const fragment = new URLSearchParams(location.hash.slice(1));
  const requestedReturn = new URLSearchParams(location.search).get('return');
  const mainHome = new URL($('account-home').href, location.href);
  const pendingKey = 'sundoll-account-pending';
  function readPending() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) || '{}');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
      if (saved.reset && saved.at < Date.now() - 1800000) saved.reset = '';
      return saved.at > Date.now() - 86400000 ? saved : {code:saved.code};
    } catch { return {}; }
  }
  const pending = readPending();
  // A new main-site sign-in link replaces an abandoned dashboard entry.
  // Invitation intents remain pending until the user explicitly accepts them.
  let dashboardRequested = fragment.has('dashboard') || (requestedReturn === null && pending.dashboard === true);
  let verifyToken = fragment.get('verify') || pending.verify || '';
  let resetToken = fragment.get('reset') || pending.reset || '';
  let invitation = fragment.get('bind') || pending.bind || '';
  let roomInvitation = fragment.get('room') || pending.room || '';
  let joinInvitation = fragment.get('join') || pending.join || '';
  let managementTarget = fragment.get('manage') || pending.manage || '';
  // Room continuation is same-origin and separate from returning to the main site.
  function safeRoomResume(value) {
    if (typeof value !== 'string' || !value || value.length > 512) return '';
    try {
      const target = new URL(value, location.href);
      if (target.origin !== location.origin || target.username || target.password || target.search || target.hash) return '';
      const path = decodeURI(target.pathname);
      return /^\/rooms\/r[0-9a-f]{32}\/(?:主控台\/(?:主控台|玩家)\.html)?$/.test(path) ? path : '';
    } catch { return ''; }
  }
  let resumeTarget = safeRoomResume(fragment.has('continue') ? fragment.get('continue') : requestedReturn === null ? pending.resume : '');
  function safeReturn(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) return '';
    try {
      const target = new URL(value, mainHome);
      if (target.username || target.password) return '';
      const loopback = host => ['localhost','127.0.0.1','[::1]'].includes(host);
      const sameMain = target.protocol === 'https:' && target.origin === mainHome.origin;
      const localPreview = loopback(location.hostname) && target.protocol === 'http:' && loopback(target.hostname);
      return sameMain || localPreview ? target.href : '';
    } catch { return ''; }
  }
  let returnTarget = safeReturn(requestedReturn !== null ? requestedReturn : pending.returnTarget);
  $('account-home').href = returnDestination();
  function restoredChallenge(saved) {
    if (!saved || typeof saved !== 'object' || !['verify','reset'].includes(saved.purpose)
        || typeof saved.token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(saved.token)
        || typeof saved.email !== 'string' || saved.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(saved.email)
        || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now() || saved.expiresAt > Date.now() + 3600000
        || !Number.isFinite(saved.codeExpiresAt) || saved.codeExpiresAt > saved.expiresAt) return null;
    return {token:saved.token,email:saved.email,purpose:saved.purpose,expiresAt:saved.expiresAt,codeExpiresAt:saved.codeExpiresAt};
  }
  let challenge = restoredChallenge(pending.code);
  let resendAt = challenge && Number.isFinite(pending.code.resendAt)
    && pending.code.resendAt >= 0 && pending.code.resendAt <= challenge.expiresAt ? pending.code.resendAt : 0;
  let resendTimer;
  function savePending() {
    // Invitation and challenge links survive a same-tab verification round trip.
    // Only email and verification metadata are retained; never passwords/codes.
    try {
      returnTarget = safeReturn(returnTarget);
      if (verifyToken || resetToken || invitation || roomInvitation || joinInvitation || managementTarget || resumeTarget || dashboardRequested || challenge || returnTarget) {
        sessionStorage.setItem(pendingKey, JSON.stringify({at:pending.at || Date.now(),verify:verifyToken,reset:resetToken,bind:invitation,room:roomInvitation,join:joinInvitation,manage:managementTarget,resume:resumeTarget,dashboard:dashboardRequested,returnTarget,
          ...(challenge ? {code:{...challenge,resendAt}} : {})}));
      } else sessionStorage.removeItem(pendingKey);
    } catch { /* Private browsing may make session storage unavailable. */ }
  }
  if (fragment.has('verify')) { resetToken = ''; pending.at = Date.now(); }
  if (fragment.has('reset')) { verifyToken = ''; pending.at = Date.now(); }
  if (verifyToken || resetToken) { challenge = null; resendAt = 0; }
  if (fragment.has('join')) roomInvitation = '';
  if (fragment.has('room')) joinInvitation = '';
  if (fragment.has('room') || fragment.has('join') || fragment.has('bind') || fragment.has('manage')) resumeTarget = '';
  if (fragment.has('continue')) pending.at = Date.now();
  if (fragment.has('room') || fragment.has('join') || fragment.has('bind') || fragment.has('manage')) pending.at = Date.now();
  if ((fragment.has('room') || fragment.has('join') || fragment.has('bind') || fragment.has('manage') || fragment.has('register')) && !fragment.has('verify') && !fragment.has('reset')) verifyToken = resetToken = '';
  savePending();
  let roomsEnabled = false, selectedRoom = null, playerRoom = null, sharedRoom = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  let mode = verifyToken ? 'verify' : resetToken ? 'reset' : challenge ? challenge.purpose === 'verify' ? 'register-code' : 'forgot-code' : fragment.has('register') ? 'register' : 'login';
  let busy = false, enabled = false, emailReady = false, currentAccountId = '';
  if (challenge) $('account-email').value = challenge.email;
  function returnDestination() {
    return safeReturn(returnTarget) || mainHome.href;
  }
  function setView(view) {
    document.body.dataset.view = view;
    if ($('account-app')) $('account-app').dataset.view = view;
  }
  function clearChallenge() {
    challenge = null; resendAt = 0;
    clearTimeout(resendTimer);
    $('account-code').value = '';
    savePending();
  }
  async function completeAuthentication(account) {
    if (!account || typeof account.accountId !== 'string' || !account.accountId) throw new Error('登录响应不完整，请刷新确认登录状态。');
    currentAccountId = account.accountId;
    publishAccount(account.accountId);
    $('account-password').value = $('account-confirm').value = '';
    clearChallenge();
    status();
    if (dashboardRequested || roomInvitation || joinInvitation || invitation || managementTarget || resumeTarget) await dashboard(account);
    else location.assign(returnDestination());
  }
  function activeAccount() {
    try { return localStorage.getItem('sundoll-active-account'); }
    catch { return undefined; }
  }
  function status(message = '', error = false) {
    $('account-status').textContent = message;
    $('account-status').dataset.error = String(error);
  }
  async function request(action, data, authenticates = false) {
    const startedAccount = activeAccount();
    const privateAction = action === 'session' || action === 'logout' || action === 'rooms' || action.startsWith('room-') || action === 'characters' || action === 'character-create' || action === 'bind' || action === 'create-player' || action === 'player-session';
    const headers = data === undefined ? {} : {'Content-Type':'application/json','X-Sundoll-Account':'1'};
    if (privateAction && currentAccountId) headers['X-Sundoll-Expected-Account'] = currentAccountId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/account/' + action, {
        method: data === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin',
        headers,
        body: data === undefined ? undefined : JSON.stringify(data), signal:controller.signal,
      });
      let result;
      try { result = await response.json(); }
      catch { throw Object.assign(new Error('账号服务返回了无效响应，请检查连接后重试'), {status:response.status}); }
      if ((privateAction || authenticates) && startedAccount !== undefined && activeAccount() !== startedAccount) {
        throw Object.assign(new Error('邮箱账号已在其他页面切换，请刷新后继续。'), {accountChanged:true});
      }
      if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || '操作未完成，请重试'), {status:response.status,errorCode:result.errorCode,retryAfter:result.retryAfter,accountChanged:response.status === 409 && /邮箱账号.*(?:变化|切换|不一致)/.test(result.error || '')});
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(data === undefined ? '连接超时，请检查连接后重试。' : ['register','forgot','resend-code'].includes(action) ? '响应超时，邮件可能已发送。请检查邮箱后再重试。' : '响应超时，操作可能已完成。请刷新查看结果后再决定是否重新提交。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function renderMode(next = mode) {
    mode = next;
    setView('auth');
    $('account-notice').hidden = enabled && emailReady;
    $('account-notice').textContent = !enabled ? '邮箱账号暂未开放，请等待管理员完成配置。' : '邮件服务暂不可用，注册和找回密码暂未开放。已有账号可以登录。';
    const register = mode === 'register', code = mode === 'register-code' || mode === 'forgot-code';
    const confirm = register || mode === 'reset' || mode === 'forgot-code';
    const labels = {login:'登录账号',register:'创建账号',forgot:'找回密码',verify:'验证邮箱',reset:'设置新密码','register-code':'验证邮箱','forgot-code':'重设密码'};
    $('account-title').textContent = labels[mode];
    $('account-submit').textContent = {login:'登录',register:'发送验证码',forgot:'发送验证码',verify:'完成邮箱验证',reset:'更新密码','register-code':'验证并登录','forgot-code':'更新密码'}[mode];
    $('account-intro').textContent = mode === 'verify' ? '输入注册时设置的密码，完成邮箱验证。' : '';
    $('account-intro').hidden = mode !== 'verify';
    $('name-field').hidden = !register;
    $('account-name').required = register;
    $('email-field').hidden = code || mode === 'verify' || mode === 'reset';
    $('account-email').required = !$('email-field').hidden;
    $('password-field').hidden = mode === 'forgot' || mode === 'register-code';
    $('account-password').required = !$('password-field').hidden;
    $('account-password').minLength = confirm ? 2 : 1;
    $('account-password').autocomplete = confirm ? 'new-password' : 'current-password';
    $('password-label').textContent = mode === 'reset' || mode === 'forgot-code' ? '新密码' : mode === 'verify' ? '注册时设置的密码' : '密码';
    $('password-hint').hidden = !confirm;
    $('confirm-field').hidden = !confirm;
    $('account-confirm').required = confirm;
    $('mode-forgot').hidden = mode !== 'login';
    $('mode-login').setAttribute('aria-pressed', String(mode === 'login'));
    $('mode-register').setAttribute('aria-pressed', String(register));
    $('account-submit').disabled = !enabled || busy || ((register || mode === 'forgot') && !emailReady);
    $('code-field').hidden = !code;
    $('account-code').required = code;
    $('code-destination').textContent = challenge ? '验证码已发送至 ' + challenge.email : '';
    updateResend();
    renderInvitation();
  }
  function updateResend() {
    clearTimeout(resendTimer);
    if (challenge && challenge.expiresAt <= Date.now()) {
      const previous = challenge.purpose === 'verify' ? 'register' : 'forgot';
      clearChallenge(); renderMode(previous);
      status('验证操作已过期，请重新发送验证码。', true);
      return;
    }
    const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    $('code-resend').textContent = seconds ? seconds + ' 秒后可重发' : '重新发送';
    $('code-resend').disabled = busy || !emailReady || !challenge || seconds > 0;
    if (challenge) resendTimer = setTimeout(updateResend, seconds > 0
      ? Math.min(1000, resendAt - Date.now()) : challenge.expiresAt - Date.now());
  }
  function receiveChallenge(result, email, purpose) {
    if (typeof result.challenge !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.challenge) || result.purpose !== purpose
        || !Number.isFinite(result.resendAfter) || result.resendAfter < 0 || result.resendAfter > 3600
        || !Number.isFinite(result.expiresIn) || result.expiresIn <= 0 || result.expiresIn > 600) {
      throw new Error('验证码发送响应不完整，请确认连接后重新发送。');
    }
    challenge = {token:result.challenge,email:email.trim(),purpose,expiresAt:Date.now()+3600000,codeExpiresAt:Date.now()+result.expiresIn*1000};
    resendAt = Date.now() + result.resendAfter * 1000;
    savePending();
    $('account-code').value = '';
    renderMode(purpose === 'verify' ? 'register-code' : 'forgot-code');
    status();
  }
  function renderInvitation() {
    const hasInvite = roomsEnabled ? !!(roomInvitation || joinInvitation) : !!invitation;
    $('account-invitation-notice').hidden = !hasInvite || !$('account-dashboard').hidden;
    $('account-invitation-notice').textContent = roomsEnabled ? joinInvitation ? '你收到了一份玩家邀请。登录或注册后可以加入房间。' : '你收到了一份战役邀请。请使用受邀邮箱登录或注册。' : '请使用受邀邮箱登录或注册，连接已有玩家档案。';
  }
  function focusSection(id) {
    const section = $(id);
    section.setAttribute('tabindex', '-1');
    section.focus({preventScroll:true});
    section.scrollIntoView({block:'start', behavior:'instant'});
  }
  function revealPanel(id) {
    if (id !== 'room-management') closeManagement();
    if (id !== 'player-onboarding') closeOnboarding();
    if (id !== 'room-share-panel') closeShare();
    $(id).hidden = false;
    focusSection(id);
  }
  function closePanel(action) { action(); status(); focusSection('room-list'); }
  function closeManagement() {
    selectedRoom = null;
    $('room-management').hidden = true;
    $('room-members').replaceChildren();
    $('invite-email').value = '';
    $('invite-role').value = 'player';
    $('room-invitation').value = '';
    $('room-invitation').hidden = $('invite-help').hidden = true;
    $('bind-member').replaceChildren(newOption('', '请选择成员'));
    $('bind-player').replaceChildren(newOption('', '请选择旧角色'));
    $('room-bind-submit').disabled = true;
    $('room-migration-list').replaceChildren();
  }
  function closeOnboarding() { playerRoom = null; selectionCharacters=[]; $('player-onboarding').hidden = true; }
  function closeShare() { sharedRoom = null; $('room-share-url').value = ''; $('room-share-panel').hidden = true; }
  $('room-share-close').addEventListener('click', () => closePanel(closeShare));
  $('room-share-copy').addEventListener('click', () => run(async () => {
    if (!sharedRoom || !$('room-share-url').value) throw new Error('请先生成玩家邀请');
    try { await navigator.clipboard.writeText($('room-share-url').value); status('邀请链接已复制。'); }
    catch { $('room-share-url').focus(); $('room-share-url').select(); status('请复制已选中的邀请链接。'); }
  }));
  $('room-share-revoke').addEventListener('click', () => run(async () => {
    if (!sharedRoom) throw new Error('请先选择房间');
    await request('room-share-revoke', {roomId:sharedRoom.id});
    closeShare(); status('玩家邀请已停用，旧链接不能再加入。');
  }));
  function publishAccount(accountId) {
    // Other tabs must stop using their previous account's room caches and actions.
    try { localStorage.setItem('sundoll-active-account', accountId || ''); }
    catch { /* Unavailable storage does not block account login. */ }
  }
  function showLogin(publish = true) {
    // Re-authentication continues in the homepage the user was already using.
    if (!$('account-dashboard').hidden) { dashboardRequested = true; savePending(); }
    currentAccountId = '';
    clearChallenge();
    if (publish) publishAccount('');
    closeManagement();
    closeOnboarding();
    closeShare();
    ownedCharacters=[];charactersLoaded=false;roomChoices=[];roomReadState='loading';createAttempt=null;roomCreateAttempt=null;
    $('character-name').value='';
    $('room-name').value='';
    $('room-create-status').hidden=true;
    $('room-list').replaceChildren();
    $('room-status').hidden = true;
    $('account-dashboard').hidden = true;
    $('my-characters').hidden=true;
    $('character-list').replaceChildren();
    $('character-status').hidden=true;
    $('account-auth').hidden = false;
    $('identity-name').textContent = $('identity-email').textContent = '';
    $('account-password').value = $('account-confirm').value = '';
    renderMode('login');
  }
  async function dashboard(account) {
    clearChallenge();
    currentAccountId = account.accountId;
    publishAccount(account.accountId);
    restoreRoomCreateAttempt();
    dashboardRequested = false; savePending();
    // The return is now stored. A refresh must continue this dashboard rather
    // than mistake its original sign-in query for a newly opened main-site link.
    const dashboardURL = new URL(location.href);
    if (dashboardURL.searchParams.has('return')) {
      dashboardURL.searchParams.delete('return');
      history.replaceState(null, '', dashboardURL.pathname + dashboardURL.search + dashboardURL.hash);
    }
    closeManagement();
    $('account-auth').hidden = true;
    $('account-dashboard').hidden = false;
    $('account-notice').hidden = true;
    setView('dashboard');
    $('account-title').textContent = '我的主页';
    $('account-intro').hidden = true;
    $('identity-name').textContent = account.name;
    $('identity-email').textContent = account.email;
    $('profile-ready').hidden = !account.playerId;
    $('profile-missing').hidden = !!account.playerId || !!invitation;
    $('profile-name').value = account.name;
    $('bind-profile').hidden = !invitation || !!account.playerId;
    if (!roomsEnabled && invitation && account.playerId) status('此账号已有玩家档案，不能覆盖绑定。', true);
    $('campaign-rooms').hidden = !roomsEnabled;
    renderInvitation();
    if (roomsEnabled) {
      $('profile-ready').hidden = $('profile-missing').hidden = $('bind-profile').hidden = true;
      renderJoinEntry();
      $('my-characters').hidden=false;
      // A slow or failed room read must not hide the independently stored roles.
      // Settle both before reporting failure so each section retains its retry.
      const reads = await Promise.allSettled([loadRooms(), loadCharacters()]);
      const failures = reads.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw failures.find(error => error.accountChanged || error.status === 401) || failures[0];
      const roomList = reads[0].value;
      await showRequestedManagement(roomList);
      if (resumeTarget && !roomInvitation && !joinInvitation && !invitation) {
        const target = resumeTarget;
        const roomId = target.split('/')[2];
        const room = roomList.find(candidate => candidate.id === roomId);
        if (!room || (target.endsWith('/主控台/主控台.html') && room.role === 'player')) {
          resumeTarget = ''; savePending();
          throw new Error('当前账号没有原房间的进入权限，请从列表选择房间或切换账号。');
        }
        if (target.endsWith('/玩家.html') || (target.endsWith('/') && room.role === 'player')) await preparePlayer(room);
        else location.assign(target);
        resumeTarget = ''; savePending();
      }
    }
    renderInvitation();
  }
  async function loadRooms() {
    const list = $('room-list');
    roomReadState = 'loading';
    list.setAttribute('aria-busy', 'true');
    $('room-status').hidden = false;
    $('room-status').dataset.error = 'false';
    $('room-status').textContent = '正在读取战役空间…';
    try {
      const result = await request('rooms');
      if (!Array.isArray(result.rooms)) throw new Error('房间列表响应不完整，请刷新重试');
      const cards = [];
      for (const room of result.rooms) {
        const card = document.createElement('article'); card.className = 'room-card';
        const title = document.createElement('h3'); title.textContent = room.name;
        const role = document.createElement('p'); role.textContent = {owner:'房主 · DM',dm:'DM',player:'玩家'}[room.role];
        const enter = document.createElement('a'); enter.className = 'primary-link';
        enter.href = '/rooms/' + room.id + '/'; enter.textContent = room.role === 'player' ? '进入玩家端 →' : '进入 DM 端 →';
        if (room.role === 'player') enter.addEventListener('click', event => { event.preventDefault(); run(() => preparePlayer(room)); });
        card.append(title, role, enter);
        if (room.role !== 'player') {
          const options = document.createElement('details'); options.className = 'room-options';
          const summary = document.createElement('summary'); summary.textContent = room.role === 'owner' ? '房间管理' : '更多'; options.append(summary);
          const player = document.createElement('a'); player.href = '/rooms/' + room.id + '/主控台/玩家.html';
          player.textContent = '以玩家身份进入'; player.className = 'text-button'; options.append(player);
          player.addEventListener('click', event => { event.preventDefault(); run(() => preparePlayer(room)); });
          if (room.role === 'owner') {
            const share = document.createElement('button'); share.type = 'button'; share.className = 'text-button'; share.textContent = '分享玩家邀请';
            share.addEventListener('click', () => run(async () => {
              const result = await request('room-share', {roomId:room.id});
              if (typeof result.invitationUrl !== 'string' || !result.invitationUrl) throw new Error('邀请链接响应不完整，请重试。');
              sharedRoom = room;
              $('room-share-title').textContent = room.name + ' · 玩家邀请';
              $('room-share-url').value = result.invitationUrl;
              revealPanel('room-share-panel'); status();
            })); options.append(share);
            const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'text-button'; manage.textContent = '邀请与成员';
            manage.addEventListener('click', () => run(async () => { closeManagement(); selectedRoom = room; await loadMembers(); status(); })); options.append(manage);
          }
          card.append(options);
        }
        cards.push(card);
      }
      list.replaceChildren(...cards);
      $('room-status').hidden = cards.length > 0;
      $('room-status').textContent = '还没有房间。';
      if (selectedRoom && !result.rooms.some(room => room.id === selectedRoom.id && room.role === 'owner')) closeManagement();
      if (playerRoom && !result.rooms.some(room => room.id === playerRoom.id)) closeOnboarding();
      if (sharedRoom && !result.rooms.some(room => room.id === sharedRoom.id && room.role === 'owner')) closeShare();
      roomChoices=result.rooms;
      roomReadState='ready';
      renderCharacters();
      return result.rooms;
    } catch (error) {
      roomReadState='error';
      $('room-status').dataset.error = 'true';
      $('room-status').textContent = '空间列表读取失败，可以点击“刷新列表”重试。';
      renderCharacters();
      throw error;
    } finally { list.setAttribute('aria-busy', 'false'); }
  }
  async function showRequestedManagement(roomList) {
    if (!managementTarget) return;
    const target = managementTarget;
    managementTarget = ''; savePending();
    const room = roomList.find(candidate => candidate.id === target);
    if (!room) throw new Error('该战役空间不存在，或当前账号尚未加入。请切换到有权限的邮箱账号。');
    if (room.role !== 'owner') throw new Error('只有房主可以确认旧角色归属。');
    closeManagement(); selectedRoom = room; await loadMembers();
  }
  $('room-refresh').addEventListener('click', () => run(async () => { await showRequestedManagement(await loadRooms()); status(); }));
  $('room-management-close').addEventListener('click', () => closePanel(closeManagement));
  let ownedCharacters = [], charactersLoaded = false, selectionCharacters = [], roomChoices = [], roomReadState = 'loading', createAttempt = null, roomCreateAttempt = null, playerReturnTarget = 'room-list';
  async function loadCharacters(rooms = roomChoices) {
    roomChoices=rooms;
    $('character-list').setAttribute('aria-busy', 'true');
    $('character-status').hidden=false;
    $('character-status').dataset.error='false';
    $('character-status').textContent='正在读取角色…';
    try {
      const result=await request('characters');
      if (!Array.isArray(result.characters)) throw new Error('角色列表响应不完整，请刷新重试');
      ownedCharacters=result.characters;
      charactersLoaded=true;
      renderCharacters();
      $('character-status').hidden=true;
    } catch (error) {
      $('character-status').dataset.error='true';
      $('character-status').textContent='角色列表读取失败，可以点击“刷新角色”重试。';
      throw error;
    } finally { $('character-list').setAttribute('aria-busy', 'false'); }
  }
  function renderCharacters() {
    if (!charactersLoaded) { $('character-list').replaceChildren(); return; }
    const rooms=roomChoices;
    const previous=new Map();
    for (const card of $('character-list').children) {
      const choice=card.querySelector?.('select');
      if (choice) previous.set(card.dataset.characterId,choice.value);
    }
    const cards=ownedCharacters.map(character=>{
      const card=document.createElement('article');card.className='character-card';card.dataset.characterId=character.characterId;
      const title=document.createElement('h3');title.textContent=character.name;
      const info=document.createElement('p');
      const active=rooms.find(room=>room.id===character.activeRoomId);
      info.textContent='等级 '+character.level+' · '+(active?active.name:character.activeRoomId?'曾参与的房间':'尚未参团');
      const identity=document.createElement('div');identity.className='character-identity';identity.append(title,info);card.append(identity);
      const choices=document.createElement('select');choices.setAttribute('aria-label',character.name+'的参团房间');
      choices.append(...rooms.map(room=>newOption(room.id,room.name)));
      const preferred=previous.get(character.characterId) || character.activeRoomId;
      choices.value=rooms.some(room=>room.id===preferred)?preferred:rooms[0]?.id || '';
      const button=document.createElement('button');button.type='button';button.className=rooms.length?'character-enter':'text-button';
      button.textContent=rooms.length?'使用此角色参团':roomReadState==='ready'?'先加入或创建房间':roomReadState==='loading'?'正在读取房间…':'刷新房间列表';
      button.disabled=!rooms.length && roomReadState==='loading';
      if (character.enabled===false) {button.hidden=true;choices.hidden=true;info.textContent+=' · 已停用';}
      button.addEventListener('click',()=>rooms.length?run(()=>preparePlayer(rooms.find(room=>room.id===choices.value),character.characterId,'character-list')):roomReadState==='error'?run(async()=>{await loadRooms();status();}):focusSection('room-list'));
      const actions=document.createElement('div');actions.className='character-actions';
      if (rooms.length) {
        const field=document.createElement('label');field.className='character-room';
        const caption=document.createElement('span');caption.textContent='参团房间';field.append(caption,choices);
        field.hidden=character.enabled===false;actions.append(field);
      }
      actions.append(button);card.append(actions);
      return card;
    });
    if (!cards.length) {const empty=document.createElement('p');empty.textContent='还没有角色。可以创建新角色，或等待 DM 交还旧角色。';cards.push(empty);}
    $('character-list').replaceChildren(...cards);
  }
  $('character-refresh').addEventListener('click',()=>run(async()=>{await loadCharacters();status();}));
  $('character-create-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const data={name:$('character-name').value.trim(),base:{level:Number($('character-level').value),hpMax:Number($('character-hp').value),ac:Number($('character-ac').value)}};
    const draft=JSON.stringify(data);
    if (!createAttempt || createAttempt.draft!==draft) createAttempt={draft,id:crypto.randomUUID()};
    await request('character-create',{...data,requestId:createAttempt.id});
    createAttempt=null;$('character-name').value='';
    try { await loadCharacters(); }
    catch (error) {
      if (error.status===401 || error.accountChanged) throw error;
      status('角色已创建；列表暂时没能更新，请点击“刷新角色”，无需再次创建。',true);return;
    }
    status('角色已创建，拥有独立背包。');
  });});
  function updateCharacterSelection() {
    const character=selectionCharacters.find(c=>c.characterId===$('player-character').value);
    $('character-switch-label').hidden=!character?.activeRoomId || character.activeRoomId===playerRoom?.id;
    $('character-switch').checked=false;
    $('player-start').hidden=!character;
  }
  $('player-character').addEventListener('change',updateCharacterSelection);
  async function preparePlayer(room, preferredCharacterId, returnTarget='room-list') {
    const result=await request('room-onboarding',{roomId:room.id});
    playerRoom=room;playerReturnTarget=returnTarget;selectionCharacters=(result.characters || []).filter(c=>c.enabled!==false);
    $('player-onboarding-title').textContent=room.name+' · 选择角色';
    $('player-character').replaceChildren(...selectionCharacters.map(c=>newOption(c.characterId,c.name+' · 等级 '+c.level)));
    $('player-character').value=selectionCharacters.some(c=>c.characterId===preferredCharacterId)?preferredCharacterId:selectionCharacters[0]?.characterId || '';
    $('player-character').hidden=!selectionCharacters.length;
    $('player-onboarding-message').textContent=selectionCharacters.length?'角色与背包沿用当前进度。':'先在「我的角色」创建新角色；旧角色由房主确认归属。';
    $('player-wait').hidden=selectionCharacters.length>0;updateCharacterSelection();revealPanel('player-onboarding');status();
  }
  $('player-onboarding-close').addEventListener('click', () => { closeOnboarding();status();focusSection(playerReturnTarget); });
  $('player-recheck').addEventListener('click', () => run(async () => { if (playerRoom) await preparePlayer(playerRoom,$('player-character').value,playerReturnTarget); }));
  $('player-wait').addEventListener('click',()=>status('请房主在「邀请与成员 → 确认旧角色归属」中选择你的邮箱和旧角色。'));
  $('player-start').addEventListener('click',()=>run(async()=>{
    const character=selectionCharacters.find(c=>c.characterId===$('player-character').value);
    if (!playerRoom || !character) throw new Error('请选择参团角色');
    if (character.activeRoomId && character.activeRoomId!==playerRoom.id && !$('character-switch').checked) throw new Error('请先勾选确认切换房间');
    try { await request('room-start-player',{roomId:playerRoom.id,characterId:character.characterId,expectedRoomId:character.activeRoomId}); }
    catch (error) {
      if (error.status===409) { await preparePlayer(playerRoom,character.characterId,playerReturnTarget); }
      throw error;
    }
    location.assign('/rooms/'+playerRoom.id+'/主控台/玩家.html');
  }));
  async function loadMembers() {
    const snapshot = await request('room-onboarding', {roomId:selectedRoom.id});
    if (!snapshot.migration) throw new Error('只有空间创建者可以查看迁移清单和成员');
    const result = {members:snapshot.migration.members}, profiles = {profiles:snapshot.migration.profiles};
    $('room-management-title').textContent = selectedRoom.name + ' · 成员';
    renderMigration(snapshot.migration);
    $('room-members').replaceChildren();
    for (const member of result.members) {
      const line = document.createElement('div'); line.className = 'room-member';
      const label = document.createElement('span'); label.textContent = member.name + ' · ' + member.email + ' · ' + {owner:'创建者',dm:'DM',player:'玩家'}[member.role]; line.append(label);
      if (member.role !== 'owner') {
        for (const [role, text] of [[member.role === 'dm' ? 'player' : 'dm', member.role === 'dm' ? '改为玩家' : '设为 DM'], ['remove','移除']]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = role==='remove'?'text-button danger-button':'text-button'; button.textContent = text;
          button.addEventListener('click', () => run(async () => { await request('room-member',{roomId:selectedRoom.id,accountId:member.accountId,role}); await loadMembers(); status('成员权限已更新。'); })); line.append(button);
        }
      }
      $('room-members').append(line);
    }
    const candidates = (snapshot.migration.characters || []).filter(character=>!character.accountId && character.enabled!==false);
    const members = result.members;
    $('bind-member').replaceChildren(newOption('', '请选择成员'), ...members.map(member => newOption(member.accountId, member.name + ' · ' + member.email)));
    $('bind-player').replaceChildren(newOption('', '请选择旧角色'), ...candidates.map(profile => newOption(profile.characterId, profile.name)));
    $('bind-member').value = $('bind-player').value = '';
    $('room-profiles-status').hidden = candidates.length > 0 && members.length > 0;
    $('room-profiles-status').textContent = !candidates.length ? '当前没有待认领角色。' : '玩家加入房间后，可在这里确认角色归属。';
    $('room-bind-form').hidden = !candidates.length || !members.length;
    updateBindingButton();
    revealPanel('room-management');
  }
  function renderMigration(migration) {
    const characters=migration.characters || [],members=migration.members || [];
    const pending=characters.filter(c=>!c.accountId);
    $('room-migration-summary').textContent='本房间 '+characters.length+' 个角色 · 待认领 '+pending.length+' 个';
    const list=$('room-migration-list');list.replaceChildren();
    for (const character of characters) {
      const line=document.createElement('p'),member=members.find(m=>m.accountId===character.accountId);
      line.textContent=character.name+' · '+(member?member.name:character.accountId?'已归属账号':'等待认领');list.append(line);
    }
    $('room-migration-continue').href='/rooms/'+selectedRoom.id+'/主控台/主控台.html';
  }
  function newOption(value, text) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; return option;
  }
  function updateBindingButton() { $('room-bind-submit').disabled = busy || !selectedRoom || !$('bind-member').value || !$('bind-player').value; }
  $('bind-member').addEventListener('change', updateBindingButton);
  $('bind-player').addEventListener('change', updateBindingButton);
  $('room-bind-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    if (!selectedRoom || !$('bind-member').value || !$('bind-player').value) throw new Error('请先选择成员邮箱和旧角色');
    await request('room-bind-player',{roomId:selectedRoom.id,accountId:$('bind-member').value,characterId:$('bind-player').value});
    await loadMembers(); status('角色已交还本人，背包与成长记录保留。');
  }); });
  function roomCreateKey(accountId) { return 'sundoll-room-create:' + accountId; }
  function roomDraftName() { return $('room-name').value.normalize('NFKC').trim(); }
  function renderRoomCreateAttempt() {
    $('room-create-status').hidden=!roomCreateAttempt || roomCreateAttempt.accountId!==currentAccountId || roomCreateAttempt.name!==roomDraftName();
    $('room-create-status').textContent='上次创建结果待确认，重试会核对同一次操作。';
  }
  function restoreRoomCreateAttempt() {
    roomCreateAttempt=null;
    try {
      const saved=JSON.parse(sessionStorage.getItem(roomCreateKey(currentAccountId)) || 'null');
      if (saved && saved.accountId===currentAccountId && typeof saved.name==='string'
          && saved.name && saved.name===saved.name.normalize('NFKC').trim() && [...saved.name].length<=60
          && typeof saved.requestId==='string' && /^[A-Za-z0-9_-]{16,96}$/.test(saved.requestId)) {
        roomCreateAttempt=saved;
        $('room-name').value=saved.name;
      }
    } catch { /* A blocked session store still permits same-page retries. */ }
    renderRoomCreateAttempt();
  }
  function clearRoomCreateAttempt(attempt) {
    if (roomCreateAttempt?.requestId!==attempt.requestId || roomCreateAttempt.accountId!==attempt.accountId) return;
    try { sessionStorage.removeItem(roomCreateKey(attempt.accountId)); } catch {}
    roomCreateAttempt=null;renderRoomCreateAttempt();
  }
  $('room-name').addEventListener('input', renderRoomCreateAttempt);
  $('room-create-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    const name=roomDraftName();
    if (!roomCreateAttempt || roomCreateAttempt.accountId!==currentAccountId || roomCreateAttempt.name!==name) {
      roomCreateAttempt={accountId:currentAccountId,name,requestId:crypto.randomUUID()};
      try { sessionStorage.setItem(roomCreateKey(currentAccountId),JSON.stringify(roomCreateAttempt)); } catch {}
    }
    const attempt=roomCreateAttempt;
    let result;
    try { result=await request('room-create',{name:attempt.name,requestId:attempt.requestId}); }
    catch (error) {
      if (error.errorCode==='ROOM_CREATE_REQUEST_CONFLICT') clearRoomCreateAttempt(attempt);
      else renderRoomCreateAttempt();
      throw error;
    }
    if (!/^r[0-9a-f]{32}$/.test(result.room?.id || '')) {
      renderRoomCreateAttempt();
      throw new Error('创建响应不完整，操作可能已完成。请用同一名称重试确认。');
    }
    clearRoomCreateAttempt(attempt);$('room-name').value='';
    await refreshRoomsAfterChange('房间已创建。进入 DM 端后可以新建或导入战役。');
  }); });
  $('room-invite-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
    if (!selectedRoom) throw new Error('请先选择要管理的空间');
    const result=await request('room-invite',{roomId:selectedRoom.id,email:$('invite-email').value,role:$('invite-role').value});
    $('room-invitation').hidden=$('invite-help').hidden=false; $('room-invitation').value=result.invitationUrl; status('邀请链接已生成。');
  }); });
  function tokenFromJoinLink(value) {
    try {
      const url = new URL(value);
      const local = ['localhost','127.0.0.1','[::1]'].includes(location.hostname);
      const validProtocol = url.protocol === 'https:' || (local && url.protocol === 'http:');
      const hash = new URLSearchParams(url.hash.slice(1)), token = hash.get('join');
      if (!validProtocol || url.origin !== location.origin || url.username || url.password || url.pathname !== '/account' || url.search || [...hash.keys()].length !== 1 || !token) throw new Error();
      return token;
    } catch { throw new Error('请粘贴此网站的完整玩家邀请链接。'); }
  }
  function renderJoinEntry() {
    const invited = !!(roomInvitation || joinInvitation);
    $('room-join-confirm').hidden = $('accept-room').hidden = !invited;
    $('room-join-form').hidden = invited;
    $('accept-room').textContent = joinInvitation ? '加入邀请中的房间' : '接受战役邀请';
  }
  $('room-invite-change').addEventListener('click', () => {
    if (busy) return;
    roomInvitation = joinInvitation = ''; savePending(); renderJoinEntry(); status();
  });
  async function joinRoom(token) {
    await request('room-join', {token});
    if (joinInvitation === token) { joinInvitation = ''; savePending(); }
    $('room-join-url').value = '';
    renderJoinEntry();
    await refreshRoomsAfterChange('已加入房间，可以从列表进入。');
  }
  async function refreshRoomsAfterChange(message) {
    try { await loadRooms(); }
    catch (error) {
      if (error.status === 401 || error.accountChanged) throw error;
      status(message + ' 列表暂未更新，请点击“刷新列表”，无需再次提交。', true);
      return;
    }
    focusSection('room-list'); status(message);
  }
  $('room-join-form').addEventListener('submit', event => {
    event.preventDefault(); run(() => joinRoom(tokenFromJoinLink($('room-join-url').value.trim())));
  });
  $('accept-room').addEventListener('click', () => run(async () => {
    if (joinInvitation) { await joinRoom(joinInvitation); return; }
    if (!roomInvitation) throw new Error('请先打开朋友的邀请链接');
    await request('room-accept',{token:roomInvitation}); roomInvitation=''; savePending(); renderJoinEntry(); await refreshRoomsAfterChange('已加入房间，可以从列表进入。');
  }));
  async function run(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    $('account-form').setAttribute('aria-busy', 'true');
    status('正在处理…');
    try { await action(); } catch (error) {
      if (challenge && Number.isFinite(error.retryAfter) && error.retryAfter > 0) {
        resendAt = Date.now() + error.retryAfter * 1000; savePending();
      }
      if (error.accountChanged) {
        showLogin(false); status(error.message, true);
      } else if (error.status === 401 && !$('account-dashboard').hidden) {
        showLogin(); status('登录已失效，请重新登录后继续。', true);
      } else {
        if ((error.status === 403 || error.status === 404) && selectedRoom) {
          closeManagement();
          try { await loadRooms(); } catch { /* Keep the original authorization error. */ }
        }
        status(error.message || '连接失败，请稍后重试', true);
      }
    }
    finally {
      busy = false;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
      updateBindingButton();
      $('account-form').setAttribute('aria-busy', 'false');
      if (!$('account-auth').hidden) renderMode();
    }
  }
  function chooseMode(next) { verifyToken = resetToken = ''; clearChallenge(); $('account-password').value = $('account-confirm').value = ''; status(); renderMode(next); }
  $('mode-login').addEventListener('click', () => chooseMode('login'));
  $('mode-register').addEventListener('click', () => chooseMode('register'));
  $('mode-forgot').addEventListener('click', () => chooseMode('forgot'));
  $('code-back').addEventListener('click', () => {
    if (busy || !challenge) return;
    const previous = challenge.purpose === 'verify' ? 'register' : 'forgot';
    clearChallenge();
    status(); renderMode(previous);
  });
  $('code-resend').addEventListener('click', () => {
    if (!challenge || Date.now() < resendAt || !emailReady) return;
    run(async () => {
      const previous = challenge;
      const result = await request('resend-code', {challenge:previous.token});
      receiveChallenge(result, previous.email, previous.purpose);
    });
  });
  $('account-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!enabled) return;
    run(async () => {
      const password = $('account-password').value;
      const passwordLength = [...password].length;
      const codeMode = mode === 'register-code' || mode === 'forgot-code';
      if ((mode === 'register' || mode === 'reset' || mode === 'forgot-code') && password !== $('account-confirm').value) throw new Error('两次输入的密码不一致');
      if ((mode === 'register' || mode === 'reset' || mode === 'forgot-code') && (passwordLength < 2 || passwordLength > 256)) throw new Error('密码需为 2–256 个字符');
      if (codeMode) {
        if (!challenge) throw new Error('请先发送邮箱验证码');
        const code = $('account-code').value.trim();
        if (!/^[0-9]{6}$/.test(code)) throw new Error('请输入六位数字验证码');
        const resetting = mode === 'forgot-code';
        const result = await request(resetting ? 'reset-code' : 'verify-code', {challenge:challenge.token,code,...(resetting ? {password} : {})}, true);
        if (!resetting) await completeAuthentication(result.account);
        else {
          clearChallenge(); publishAccount('');
          $('account-password').value = $('account-confirm').value = $('account-code').value = '';
          renderMode('login'); status(result.message || '密码已更新，请登录。');
        }
        return;
      }
      const payload = mode === 'forgot' ? {email:$('account-email').value} : mode === 'verify' || mode === 'reset' ? {token:mode === 'verify' ? verifyToken : resetToken,password} : {email:$('account-email').value,password};
      if (mode === 'register') payload.name = $('account-name').value;
      if (mode === 'register' || mode === 'forgot') payload.delivery = 'code';
      const result = await request(mode, payload, mode === 'login' || mode === 'reset');
      if (mode === 'register' || mode === 'forgot') {
        receiveChallenge(result, $('account-email').value, mode === 'register' ? 'verify' : 'reset');
        return;
      }
      $('account-password').value = $('account-confirm').value = '';
      if (mode === 'login') await completeAuthentication(result.account);
      else {
        if (mode === 'verify' || mode === 'reset') {
          if (mode === 'reset') publishAccount('');
          verifyToken = resetToken = ''; savePending(); renderMode('login');
        }
        status(result.message || '操作已完成。');
      }
    });
  });
  $('profile-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => { const result = await request('create-player', {name:$('profile-name').value}); await dashboard(result.account); status('玩家档案已建立。'); });
  });
  $('bind-profile').addEventListener('click', () => run(async () => {
    const result = await request('bind', {token:invitation});
    invitation = '';
    savePending();
    await dashboard((await request('session')).account);
    status(result.message);
  }));
  $('account-logout').addEventListener('click', () => run(async () => {
    await request('logout', {});
    showLogin(); status('已退出登录。');
  }));
  window.addEventListener('storage', event => {
    if (event.key === 'sundoll-active-account' && currentAccountId && event.newValue !== currentAccountId) {
      showLogin(false);
      status('邮箱账号已在其他页面切换或退出，请刷新后继续。', true);
    }
  });
  async function start() {
    if (busy) return;
    busy = true;
    setView('loading');
    $('account-app').setAttribute('aria-busy', 'true');
    $('account-auth').hidden = true;
    $('account-retry').hidden = true;
    $('account-title').textContent = '我的冒险';
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    $('account-form').setAttribute('aria-busy', 'true');
    status('正在连接…');
    try {
      const config = await request('config');
      enabled = config.enabled; emailReady = config.emailReady;
      roomsEnabled = config.roomsEnabled === true;
      if (enabled && mode !== 'verify' && mode !== 'reset') {
        try { const session = await request('session'); status(); await dashboard(session.account); }
        catch (error) {
          if (error.status === 401 && !$('account-dashboard').hidden) { showLogin(); status('登录已失效，请重新登录后继续。', true); }
          else if (error.status === 401) { publishAccount(''); $('account-auth').hidden = false; status(); }
          else throw error;
        }
      } else { $('account-auth').hidden = false; status(); }
    } catch (error) {
      if (error.accountChanged) showLogin(false);
      if ($('account-dashboard').hidden && $('account-auth').hidden) {
        $('account-title').textContent = '暂时无法连接';
        $('account-retry').hidden = false;
      }
      status(error.message || '无法连接账号服务，请刷新重试', true);
    }
    finally {
      busy = false;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
      $('account-form').setAttribute('aria-busy', 'false');
      $('account-app').setAttribute('aria-busy', 'false');
      updateBindingButton();
      if (!$('account-auth').hidden) renderMode();
    }
  }
  $('account-retry').addEventListener('click', start);
  start();
})();
