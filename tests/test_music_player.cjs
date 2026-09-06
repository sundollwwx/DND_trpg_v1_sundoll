// Run with node --test tests/test_music_player.cjs. Uses the actual music code, no live saves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, '主控台/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, '主控台/主控台.html'), 'utf8');
const music = source.slice(source.indexOf('let bgmList = [];'), source.indexOf('/* ==================== 简易联机'));
function fixture() {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.value = ''; this.children = []; this.dataset = {}; this.listeners = {}; this.attrs = {}; this.classList = { toggle() {} }; }
    addEventListener(name, cb) { (this.listeners[name] ||= []).push(cb); }
    fire(name) { for (const fn of this.listeners[name] || []) fn({ target: this }); }
    append(...items) { this.children.push(...items); if (this.tag === 'select' && !this.value) this.value = items[0]?.value || ''; }
    replaceChildren() { this.children = []; if (this.tag === 'select') this.value = ''; }
    setAttribute(name, value) { this.attrs[name] = value; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements.set('#' + match[2], new Element(match[1]));
  const $ = selector => { assert.ok(elements.has(selector), 'Existing DOM element: ' + selector); return elements.get(selector); };
  $('#bgm-scope').value = 'all'; $('#bgm-volume').value = '70';
  const audios = [], playHooks = [], actions = [], storage = new Map();
  class Audio {
    constructor(src = '') { this.src = src; this.currentTime = 0; this.volume = 1; this.duration = 180; this.paused = true; this.listeners = {}; audios.push(this); }
    addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
    play() { this.paused = false; return playHooks.length ? playHooks.shift()(this) : Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { if (!this.src) this.currentTime = 0; }
    end() { this.paused = true; for (const cb of this.listeners.ended || []) cb(); }
  }
  const ctx = vm.createContext({ $, Audio, URL, URLSearchParams, Promise, Map, Set, Number,
    state: {campaignId:'a',campaignName:'A'}, streamOn:false, streamPlayers:[],
    localStorage:{getItem:k=>storage.get(k) ?? null,setItem:(k,v)=>storage.set(k,v)},
    document:{createElement:tag=>new Element(tag),querySelectorAll:selector=>selector === '#bgm-list .bgm-item' ? $('#bgm-list').children.filter(x=>x.tag==='button') : []},
    serverApiBase:()=>'', toast(){},
    sendHostAction:async payload=>{actions.push(payload);return {ok:true,data:{ok:true}};},
    fetch:async()=>({ok:true,json:async()=>({ok:true,tracks:[]})}),
  });
  vm.runInContext(music,ctx);
  const run = code => vm.runInContext(code,ctx);
  run(`bgmList = [
    {id:'town-a',name:'酒馆 A',url:'/town-a.mp3',serverUrl:'/town-a.mp3',source:'library',scope:'general',collection:'通用',category:'通用 / 城镇'},
    {id:'boss',name:'首领',url:'/boss.mp3',serverUrl:'/boss.mp3',source:'library',scope:'general',collection:'通用',category:'通用 / Boss'},
    {id:'town-b',name:'酒馆 B',url:'/town-b.mp3',serverUrl:'/town-b.mp3',source:'library',scope:'campaign',collection:'当前战役',category:'城镇'}
  ]; renderBgmList();`);
  return {ctx,run,$,audios,playHooks,actions};
}
const flush = async f => { await new Promise(resolve=>setImmediate(resolve)); await f.run('bgmSendChain'); };

test('refresh and selecting a replacement recording plays and broadcasts its versioned URL', async () => {
  const f=fixture();
  await f.run('playBgm(1)');
  f.ctx.fetch=async()=>({ok:true,json:async()=>({ok:true,tracks:[{id:'boss',title:'新版决战',url:'/api/music-stream/boss?v=2',category:'通用 / 首领'}]})});
  await f.run('loadProjectMusicLibrary()');
  f.run('streamOn=true');
  await f.run("playBgm(bgmList.findIndex(x=>x.id==='boss'))");
  await flush(f);
  assert.equal(f.run('bgmAudio.src'),'/api/music-stream/boss?v=2');
  assert.equal(f.actions.at(-1).url,'/api/music-stream/boss?v=2');
});

test('scene classification follows folders and aliases, independently of map selection', () => {
  const f=fixture();
  assert.equal(f.run("bgmScene({source:'library',category:'通用 / 城镇 / 夜晚'})"),'城镇');
  assert.equal(f.run("bgmScene({source:'library',category:'环境'})"),'探索');
  assert.equal(f.run("bgmScene(bgmList[1])"),'首领');
  assert.equal(f.run("bgmScene({source:'library',category:'通用'})"),'未分类');
  f.$('#bgm-scene').value='城镇';
  assert.equal(f.run('visibleBgmTracks().length'),2);
  f.run("state.activeMapId = 'entirely-different-map'");
  assert.equal(f.run('visibleBgmTracks().length'),2);
});

test('selection, preview and closing the dialog never change the room track or broadcast', async () => {
  const f=fixture();f.run('streamOn=true');await f.run('playBgm(0)');await flush(f);
  const sent=f.actions.length;
  f.run("bgmAudio.currentTime=42; bgmSelectedKey='boss'; openBgmPlayer()");
  await f.run('previewSelectedBgm()');
  assert.equal(f.run('bgmIndex'),0);
  assert.equal(f.run('bgmAudio.currentTime'),42);
  assert.equal(f.run('bgmAudio.paused'),false);
  assert.equal(f.run('bgmAudio.muted'),true);
  assert.equal(f.actions.length,sent);
  f.run('closeBgmPlayer()');
  assert.equal(f.run('bgmPreviewAudio.paused'),true);
  assert.equal(f.run('bgmAudio.muted'),false);
  assert.equal(f.run('bgmAudio.paused'),false);
  assert.equal(f.actions.length,sent);
});

test('next track stays in the playing scene even after search/filter changes', async () => {
  const f=fixture();await f.run('playBgm(0)');
  f.$('#bgm-scene').value='首领';f.run('renderBgmList(); nextBgm()');await flush(f);
  assert.equal(f.run('bgmList[bgmIndex].id'),'town-b');
  f.run('nextBgm()');await flush(f);
  assert.equal(f.run('bgmList[bgmIndex].id'),'town-a');
});

test('pause keeps time, stop resets it, and one-shot ending does not pick another scene', async () => {
  const f=fixture();await f.run('playBgm(0)');
  f.run('bgmAudio.currentTime=48');await f.run('toggleBgm()');
  assert.equal(f.run('bgmAudio.currentTime'),48);assert.equal(f.run('bgmAudio.paused'),true);
  await f.run('toggleBgm()');assert.equal(f.run('bgmAudio.paused'),false);
  f.run("bgmMode='once';bgmAudio.end()");
  assert.equal(f.run('bgmAudio.currentTime'),0);assert.equal(f.run('bgmPlaying'),false);
  assert.equal(f.run('bgmList[bgmIndex].id'),'town-a');
});

test('stopping or a newer selection cancels stale asynchronous playback', async () => {
  const f=fixture();let finish;
  f.playHooks.push(()=>new Promise(resolve=>{finish=resolve;}));
  const old=f.run('playBgm(0)');
  await f.run('playBgm(1)');finish();await old;
  assert.equal(f.run('bgmList[bgmIndex].id'),'boss');
  f.playHooks.push(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.run('playBgm(2)');f.run('stopBgmAudio()');finish();await pending;
  assert.equal(f.run('bgmPlaying'),false);assert.equal(f.run('bgmAudio.src'),'');
});

test('switching immediately updates the main and sidebar titles while the new audio loads', async () => {
  const f=fixture();await f.run('playBgm(0)');
  let finish;f.playHooks.push(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.run('playBgm(1)');
  assert.equal(f.$('#bgm-now-title').textContent,'首领');
  assert.equal(f.$('#bgm-mini-title').textContent,'首领');
  assert.match(f.$('#bgm-status').textContent,/正在切换/);
  assert.equal(f.run("bgmList[bgmIndex].id"),'town-a');
  finish();await pending;
  assert.equal(f.$('#bgm-now-title').textContent,'首领');
  assert.match(f.$('#bgm-status').textContent,/播放中/);
  assert.equal(f.run("bgmList[bgmIndex].id"),'boss');
});

test('clicking another row while audio exists switches it and synchronizes both titles', async () => {
  const f=fixture();await f.run('playBgm(0)');
  f.$('#bgm-list').children[1].fire('click');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.run("bgmList[bgmIndex].id"),'boss');
  assert.equal(f.run('bgmSelectedKey'),'boss');
  assert.equal(f.$('#bgm-now-title').textContent,'首领');
  assert.equal(f.$('#bgm-mini-title').textContent,'首领');
});

test('clicking a row while stopped only selects it so local preview remains available', () => {
  const f=fixture();f.$('#bgm-list').children[1].fire('click');
  assert.equal(f.run('bgmIndex'),-1);
  assert.equal(f.run('bgmSelectedKey'),'boss');
  assert.equal(f.$('#bgm-selected-title').textContent,'首领');
  assert.equal(f.$('#bgm-now-title').textContent,'尚未播放');
});

test('a failed switch restores the previous title after showing the target title', async () => {
  const f=fixture();await f.run('playBgm(0)');
  let fail;f.playHooks.push(()=>new Promise((resolve,reject)=>{fail=reject;}));
  const pending=f.run('playBgm(1)');
  assert.equal(f.$('#bgm-now-title').textContent,'首领');
  fail(new Error('cannot load'));await pending;
  assert.equal(f.$('#bgm-now-title').textContent,'酒馆 A');
  assert.match(f.$('#bgm-status').textContent,/播放失败/);
});

test('a failed replacement keeps the currently playing audio', async () => {
  const f=fixture();await f.run('playBgm(0)');
  f.playHooks.push(()=>Promise.reject(new Error('bad audio')));
  await f.run('playBgm(1)');
  assert.equal(f.run('bgmList[bgmIndex].id'),'town-a');
  assert.equal(f.run('bgmAudio.paused'),false);
  assert.match(f.$('#bgm-status').textContent,/播放失败/);
});

test('removing the playing file during refresh stops it and sends a stop without uploading', async () => {
  const f=fixture();f.run('streamOn=true');await f.run('playBgm(0)');await flush(f);
  await f.run('loadProjectMusicLibrary({silent:true})');await flush(f);
  assert.equal(f.run('bgmIndex'),-1);assert.equal(f.run('bgmAudio.src'),'');
  assert.equal(f.actions.at(-1).action,'stop');
});

test('late library responses cannot overwrite the latest campaign catalog', async () => {
  const f=fixture();let first;
  f.ctx.fetch=()=>new Promise(resolve=>{first=resolve;});
  const pending=f.run('loadProjectMusicLibrary({silent:true})');
  f.run("state.campaignId='b'");
  f.ctx.fetch=async()=>({ok:true,json:async()=>({ok:true,tracks:[{id:'b-track',title:'B music',url:'/b.mp3'}]})});
  await f.run('loadProjectMusicLibrary({silent:true})');
  first({ok:true,json:async()=>({ok:true,tracks:[{id:'a-track',title:'A music'}]})});await pending;
  assert.equal(f.run('bgmList[0].id'),'b-track');
});

test('a stopped room cannot be restarted by a late temporary-file upload', async () => {
  const f=fixture();let finish;
  f.run("streamOn=true; bgmList[0].serverUrl=''; bgmList[0].source='temporary'");
  f.ctx.file={arrayBuffer:()=>new Promise(resolve=>{finish=resolve;})};f.run('bgmList[0].file=file');
  f.ctx.fetch=async()=>({ok:true,json:async()=>({ok:true,url:'/uploaded.mp3'})});
  await f.run('playBgm(0)');f.run('stopBgmAudio()');await flush(f);
  finish(new ArrayBuffer(0));await flush(f);
  assert.equal(f.actions.length,1);assert.equal(f.actions[0].action,'stop');
});

test('volume starts at the displayed 70 percent and remains a local preference', async () => {
  const f=fixture();assert.equal(f.run('bgmAudio.volume'),0.7);
  f.run('streamOn=true');await f.run('playBgm(0)');await flush(f);
  const count=f.actions.length;
  f.$('#bgm-volume').value='23';f.$('#bgm-volume').fire('input');
  assert.equal(f.run('bgmAudio.volume'),0.23);assert.equal(f.run('bgmPreviewAudio.volume'),0.23);
  assert.equal(f.actions.length,count);assert.equal(f.actions[0].volume,undefined);
});
