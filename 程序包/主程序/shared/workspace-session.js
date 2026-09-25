/* Freeze the workspace generation for this page; restoration invalidates old tabs. */
(() => {
  const nativeFetch=window.fetch.bind(window);
  let captured=false,generation='',generationJob=null;
  function workspaceGeneration(){
    if(captured)return Promise.resolve(generation);
    if(generationJob)return generationJob;
    const controller=new AbortController(),timeoutError=new Error('工作区校验超时，请检查连接后重试；操作尚未发送');
    let timer;
    const request=(async()=>{
      const response=await nativeFetch('/api/workspace-epoch',{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error('工作区服务暂时不可用');
      const data=await response.json();
      if(typeof data?.epoch!=='string')throw new Error('工作区校验响应无效');
      return data.epoch;
    })();
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(timeoutError);controller.abort();},8000);});
    // Only the winning request may capture an epoch, including the valid empty epoch.
    generationJob=Promise.race([request,deadline]).then(epoch=>{
      generation=epoch;captured=true;return epoch;
    },error=>{throw error===timeoutError?error:new Error('无法校验工作区，请检查服务连接后重试；操作尚未发送',{cause:error});}).finally(()=>{
      clearTimeout(timer);generationJob=null;
    });
    return generationJob;
  }
  workspaceGeneration().catch(()=>{});
  window.fetch=async (input,options={})=>{
    const url=new URL(typeof input==='object' && input && 'url' in input ? input.url : input,location.href);
    const method=String(options.method||(typeof input==='object'&&input.method)||'GET').toUpperCase();
    if(url.origin===location.origin && url.pathname.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(method)){
      const headers=new Headers(options.headers||(typeof input==='object'&&input.headers)||{});
      headers.set('X-Sundoll-Workspace',await workspaceGeneration());
      options={...options,headers};
    }
    return nativeFetch(input,options);
  };
})();
