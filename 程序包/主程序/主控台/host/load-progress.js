/* Fixed loading stages and timings; never retain campaign data or error messages. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SundollHostLoading = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  const stages = Object.freeze({
    workspace:'连接存档服务', permission:'确认存档权限', catalog:'读取战役目录',
    library:'读取棋子库', recoveryCache:'准备浏览器恢复点', pendingSave:'等待当前保存',
    saveRead:'读取战役存档', parse:'解析存档', recoveryWrite:'保存读取前恢复点',
    normalize:'恢复战役数据', interface:'恢复界面', browserCache:'更新浏览器恢复缓存',
    selection:'记录上次打开', connection:'恢复联机', connectionRead:'检查联机服务',
  });
  const kinds = Object.freeze({home:'存档目录检查',campaign:'战役加载',interface:'界面恢复',connection:'联机检查'});
  const results = Object.freeze({running:'进行中',success:'成功',failure:'失败',partial:'部分步骤需核对',cancelled:'取消',skipped:'未开启'});
  const errors = new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','AbortError','TimeoutError','NetworkError','NotAllowedError','NotFoundError','QuotaExceededError']);
  const errorClass = error => errors.has(error?.name) ? error.name : 'Error';
  const milliseconds = value => Math.max(0, Math.round(Number(value) || 0));
  function create({ now = () => performance.now(), changed = () => {}, yieldTask = () => new Promise(resolve=>setTimeout(resolve,0)) } = {}) {
    let active = null, sequence = 0;
    const history = [], listeners = new Set();
    function snapshot() {
      if (!active) return null;
      const time = now();
      return { kind:active.kind,status:active.status,elapsedMs:milliseconds((active.end ?? time)-active.start),
        stages:active.rows.map(row=>({stage:row.stage,status:row.status,elapsedMs:milliseconds((row.end ?? time)-row.start),...(row.errorClass?{errorClass:row.errorClass}:{})})),
        retryAvailable:!!active.retry && ['failure','partial'].includes(active.status) && !active.retrying,
        retryLabel:active.retryLabel,
      };
    }
    function emit() { const value=snapshot();changed(value);for(const listener of listeners)listener(value,active?.sequence); }
    function begin(kind, { retry = null, retryLabel = '重新读取' } = {}) {
      if (!Object.hasOwn(kinds,kind)) throw new TypeError('Unknown loading kind');
      if (active) {
        if(active.status==='running'){active.status='cancelled';active.end=now();for(const row of active.rows)if(row.status==='running'){row.status='cancelled';row.end=active.end;}}
        history.push(snapshot());if(history.length>3)history.shift();
      }
      const run = {kind,start:now(),end:null,status:'running',rows:[],retry, retryLabel, retrying:false,sequence:++sequence};active=run;emit();
      const current=()=>active===run&&run.status!=='cancelled';
      function rowFor(stage) { if(!Object.hasOwn(stages,stage))throw new TypeError('Unknown loading stage');return run.rows.find(row=>row.stage===stage); }
      function fail(error, options={}) {
        if(!current())return;
        const row=run.rows.findLast(row=>row.status==='running')||run.rows.at(-1);
        if(row&&row.status!=='failure'){row.status='failure';row.end=now();row.errorClass=errorClass(error);}
        run.status='failure';run.end=now();
        if(Object.hasOwn(options,'retry'))run.retry=options.retry;
        if(options.retryLabel)run.retryLabel=options.retryLabel;
        emit();
      }
      return Object.freeze({
        get status(){return run.status;},get current(){return current();},
        async step(stage, work) {
          rowFor(stage);
          if(!current())throw Object.assign(new Error('Loading superseded'),{name:'AbortError'});
          const row={stage,start:now(),end:null,status:'running'};run.rows.push(row);emit();
          try { await yieldTask();if(!current())throw Object.assign(new Error(),{name:'AbortError'});const value=await work();if(current()){row.status='success';row.end=now();emit();}return value; }
          catch(error){if(current()){row.status='failure';row.end=now();row.errorClass=errorClass(error);fail(error);}throw error;}
        },
        skip(stage){const row=rowFor(stage);if(current()){if(row){row.status='skipped';row.end=now();}else run.rows.push({stage,start:now(),end:now(),status:'skipped'});emit();}},
        warn(stage,error){const row=rowFor(stage);if(current()&&row){row.status='failure';row.errorClass=errorClass(error);row.end=now();emit();}},
        finish(){if(!current()||run.status==='cancelled')return;run.status=run.rows.some(row=>row.status==='failure')?'partial':'success';run.end=now();emit();},
        fail,
        resume(){if(current()&&run.status!=='cancelled'){run.status='running';run.end=null;emit();}},
        cancel(){if(!current())return;run.status='cancelled';run.end=now();for(const row of run.rows)if(row.status==='running'){row.status='cancelled';row.end=run.end;}emit();},
        setRetry(retry,retryLabel='重新读取'){if(current()){run.retry=retry;run.retryLabel=retryLabel;emit();}},
      });
    }
    function summaryText() {
      // Rebuild the exported text solely from the fixed schema and labels.
      const samples=[...history,snapshot()].filter(Boolean);
      return samples.map(sample=>`${kinds[sample.kind]} | ${results[sample.status]} | ${sample.elapsedMs} 毫秒\n`+
        sample.stages.map(row=>`${stages[row.stage]} | ${results[row.status]} | ${row.elapsedMs} 毫秒${row.errorClass?' | '+row.errorClass:''}`).join('\n')).join('\n\n');
    }
    return Object.freeze({begin,snapshot,summaryText,subscribe(listener){listeners.add(listener);listener(snapshot(),active?.sequence);return()=>listeners.delete(listener);},
      async retry(){const run=active;if(!run?.retry||run.retrying||!['failure','partial'].includes(run.status))return false;run.retrying=true;emit();try{return await run.retry();}finally{if(active===run){run.retrying=false;emit();}}},
    });
  }
  function mount(controller, env=globalThis) {
    const document=env.document,box=document.getElementById('host-load-progress');if(!box)return;
    const status=document.getElementById('host-load-status'),list=document.getElementById('host-load-stages'),retry=document.getElementById('host-load-retry');
    const copy=document.getElementById('host-load-copy'),close=document.getElementById('host-load-close'),open=document.getElementById('btn-host-load-diagnostics');
    let timer=null,previousSequence=null,dismissTimer=null,keepOpen=false;
    function cancelDismiss(){if(dismissTimer!==null){env.clearTimeout(dismissTimer);dismissTimer=null;}}
    function keepDiagnostics(){keepOpen=true;cancelDismiss();}
    const seconds=ms=>(ms/1000).toFixed(1)+' 秒';
    function render(sample,sequence=previousSequence) {
      if(!sample)return;
      const running=sample.status==='running';
      cancelDismiss();
      if(sequence!==previousSequence){box.hidden=false;keepOpen=false;}previousSequence=sequence;
      const row=sample.stages.findLast(stage=>stage.status==='running')||sample.stages.findLast(stage=>stage.status==='failure')||sample.stages.at(-1);
      const label=row?stages[row.stage]:kinds[sample.kind];
      status.textContent=running?`${label} · 已等待 ${seconds(row?.elapsedMs||0)}`
        :sample.status==='failure'?`${label}${row?.stage==='connection'?'尚未确认':'失败'} · ${seconds(sample.elapsedMs)}`
        :sample.status==='partial'?`已载入，部分步骤需核对 · ${seconds(sample.elapsedMs)}`
        :sample.status==='cancelled'?`读取已取消 · ${seconds(sample.elapsedMs)}`:`${kinds[sample.kind]}已完成 · ${seconds(sample.elapsedMs)}`;
      box.dataset.state=sample.status;box.setAttribute('aria-busy',String(running));
      list.replaceChildren(...sample.stages.map(stage=>{const li=document.createElement('li');li.dataset.state=stage.status;li.textContent=`${stages[stage.stage]} · ${{running:'进行中',success:'成功',failure:'失败',skipped:'未开启',cancelled:'取消'}[stage.status]} · ${seconds(stage.elapsedMs)}${stage.errorClass?' · '+stage.errorClass:''}`;return li;}));
      retry.hidden=!sample.retryAvailable;retry.disabled=!sample.retryAvailable;retry.textContent=sample.retryLabel;
      if(timer!==null){env.clearTimeout(timer);timer=null;}if(running)timer=env.setTimeout(()=>render(controller.snapshot()),1000);
      if(sample.status==='success'&&!keepOpen){dismissTimer=env.setTimeout(()=>{dismissTimer=null;box.hidden=true;},2500);}
    }
    controller.subscribe(render);
    retry.addEventListener('click',()=>controller.retry().catch(()=>{}));
    copy.addEventListener('click',async()=>{const text=controller.summaryText();try{await env.navigator.clipboard.writeText(text);copy.textContent='诊断已复制';}catch(error){const output=document.getElementById('host-load-summary');output.hidden=false;output.value=text;output.focus();output.select();copy.textContent='请选择下方摘要复制';}});
    close.addEventListener('click',()=>{cancelDismiss();box.hidden=true;});
    box.addEventListener('pointerenter',keepDiagnostics);
    box.addEventListener('focusin',keepDiagnostics);
    for(const button of [open,document.getElementById('cover-host-load-diagnostics')])button?.addEventListener('click',()=>{document.getElementById('save-tools-dialog')?.close();keepDiagnostics();box.hidden=false;render(controller.snapshot());});
  }
  return Object.freeze({create,mount,stages,kinds});
});
