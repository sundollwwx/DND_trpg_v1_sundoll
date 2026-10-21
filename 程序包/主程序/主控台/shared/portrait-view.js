(function(root) {
  'use strict';
  const DEFAULT = Object.freeze({scale:1,offsetX:0,offsetY:0});
  const images = new Map(), bindings = new WeakMap();
  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const keys=['scale','offsetX','offsetY'];
    if (keys.some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k]))) return undefined;
    return {scale:clamp(value.scale,.5,3),offsetX:clamp(value.offsetX,-1,1),offsetY:clamp(value.offsetY,-1,1)};
  }
  function sameView(first,second) {
    const a=normalize(first),b=normalize(second);
    if(!a||!b)return !a&&!b;
    return a.scale===b.scale&&a.offsetX===b.offsetX&&a.offsetY===b.offsetY;
  }
  function geometry(width,height,imageWidth,imageHeight,view) {
    const v=normalize(view)||DEFAULT;
    const factor=Math.max(width/imageWidth,height/imageHeight)*v.scale;
    const w=imageWidth*factor,h=imageHeight*factor;
    return {width:w,height:h,left:(width-w)/2+v.offsetX*width,top:(height-h)/2+v.offsetY*height};
  }
  function imageFor(src) {
    if (!images.has(src)) {
      if(images.size>=32)images.delete(images.keys().next().value);
      images.set(src,new Promise((resolve,reject)=>{
      const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>{images.delete(src);reject(new Error('无法读取立绘图片'));};image.src=src;
      }));
    }
    return images.get(src);
  }
  function backgroundUrl(el,source) {
    if (el.tagName==='IMG') return el.currentSrc||el.src;
    const match=String(el.style.backgroundImage||'').match(/^url\(["']?(.*?)["']?\)$/);
    return match?.[1]||source?.iconImg||source?.iconImgHd||source?.iconImgPath||'';
  }
  function dimension(el,key) {
    if(!el)return 0;
    const client=el[key==='width'?'clientWidth':'clientHeight'];
    if(client>0)return client;
    const pixels=value=>typeof value==='string'&&/^\d+(?:\.\d+)?px$/.test(value)?parseFloat(value):0;
    return pixels(el.style?.[key])||pixels(root.getComputedStyle?.(el)?.[key]);
  }
  function render(el,binding,image) {
    if (bindings.get(el)!==binding) return;
    const {source,legacyScale}=binding;
    const view=normalize(source?.portraitView)||{...DEFAULT,scale:legacyScale||1};
    if (el.tagName==='IMG') {
      const frame=el.parentElement;
      if(frame){frame.style.overflow='hidden';frame.style.position='relative';}
      const fw=dimension(frame,'width')||100,fh=dimension(frame,'height')||fw;
      const g=geometry(fw,fh,image?.naturalWidth||1,image?.naturalHeight||1,view);
      Object.assign(el.style,{position:'absolute',maxWidth:'none',maxHeight:'none',width:g.width+'px',height:g.height+'px',left:g.left+'px',top:g.top+'px',objectFit:'fill',transform:'none'});
    } else {
      const width=dimension(el,'width')||100,height=dimension(el,'height')||width;
      const rect=geometry(width,height,image?.naturalWidth||1,image?.naturalHeight||1,view);
      el.style.backgroundSize=rect.width+'px '+rect.height+'px';
      el.style.backgroundPosition=rect.left+'px '+rect.top+'px';
      el.style.backgroundRepeat='no-repeat';
      el.style.backgroundColor='#D9B574';
    }
  }
  function apply(el,source={},options={}) {
    if (!el) return;
    const binding={source:{portraitView:normalize(source.portraitView)},legacyScale:options.legacyScale||1};
    bindings.set(el,binding);render(el,binding);
    const src=backgroundUrl(el,source);
    if(src)imageFor(src).then(image=>{binding.image=image;render(el,binding,image);}).catch(()=>{});
  }
  async function prepareFile(file) {
    if(!file||!file.type.startsWith('image/'))throw new Error('请选择图片文件');
    if(file.size>16*1024*1024)throw new Error('立绘不能超过 16 MB');
    const src=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法读取图片文件'));r.readAsDataURL(file);});
    return {src,image:await imageFor(src)};
  }
  async function edit(options) {
    const {src,title='调整立绘显示范围'}=options;
    await imageFor(src);
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='pv-dialog';
      const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
      const heading=make('h3','',title),copy=make('p','pv-copy','拖动图片调整位置，缩放决定棋子中显示的范围。原图完整保留。');
      const frame=make('div','pv-frame'),preview=make('div','pv-preview');preview.style.backgroundImage='url("'+src+'")';frame.append(preview);
      const mask=make('div','pv-mask');frame.append(mask);frame.setAttribute('aria-label','圆形棋子显示预览');
      const sample=make('img','pv-original');sample.src=src;sample.alt='完整原图';
      const wrap=make('div','pv-previews');wrap.append(frame,sample);
      let view=normalize(options.view)||{...DEFAULT,scale:clamp(options.legacyScale||1,.5,3)};
      const sliders=make('div','pv-sliders'),inputs={};
      const refresh=()=>{
        apply(preview,{portraitView:view});
        for(const [key,input] of Object.entries(inputs)){input.value=view[key];input.nextElementSibling.textContent=key==='scale'?Math.round(view[key]*100)+'%':Math.round(view[key]*100)+'%';}
      };
      for(const [key,label,min,max,step] of [['scale','缩放',.5,3,.01],['offsetX','左右位置',-1,1,.005],['offsetY','上下位置',-1,1,.005]]){
        const row=make('label','pv-control',label),input=make('input'),output=make('output');input.type='range';input.min=min;input.max=max;input.step=step;input.setAttribute('aria-label',label);inputs[key]=input;input.oninput=()=>{view={...view,[key]:Number(input.value)};refresh();};row.append(input,output);sliders.append(row);
      }
      let drag;
      frame.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,view:{...view}};frame.setPointerCapture(e.pointerId);};
      frame.onpointermove=e=>{if(!drag)return;view={...view,offsetX:clamp(drag.view.offsetX+(e.clientX-drag.x)/frame.clientWidth,-1,1),offsetY:clamp(drag.view.offsetY+(e.clientY-drag.y)/frame.clientHeight,-1,1)};refresh();};
      frame.onpointerup=frame.onpointercancel=()=>{drag=null;};
      const actions=make('div','pv-actions');
      const button=(label,fn)=>{const b=make('button','',label);b.type='button';b.onclick=fn;return b;};
      let finished=false;
      const finish=result=>{if(finished)return;finished=true;dialog.close();dialog.remove();resolve(result);};
      actions.append(button('重置',()=>{view={...DEFAULT};refresh();}),button('取消',()=>finish(null)),button('使用这个范围',()=>finish({...view})));
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
      dialog.append(heading,copy,wrap,sliders,actions);document.body.append(dialog);dialog.showModal();refresh();
    });
  }
  root.SundollPortraitView={normalize,sameView,geometry,apply,edit,prepareFile,defaultView:()=>({...DEFAULT})};
})(typeof window==='object'?window:globalThis);
