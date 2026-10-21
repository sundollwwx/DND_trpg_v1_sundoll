/* Durable uncertain requests. Never replay automatically or persist login tokens. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SundollPendingRequests=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const PREFIX='sundoll-pending-request-v1:',MAX_LENGTH=24*1024*1024;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function stable(value){
    if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function fail(message){return Object.assign(new Error(message),{pendingVerification:true});}
  function create({channel,context,env=globalThis}){
    if(!['backpack','map-items'].includes(channel)||typeof context!=='function')throw fail('待核对操作配置无效');
    let frozenBase=null;
    async function json(url){
      const controller=new env.AbortController();let timer;
      const expired=new Promise((_,reject)=>{timer=env.setTimeout(()=>{reject(fail('待核对操作的身份校验超时；操作未发送'));controller.abort();},8000);});
      try{return await Promise.race([(async()=>{
        const response=await env.fetch(url,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        const data=await response.json();
        if(!response.ok)throw fail(data.error||'无法核对当前工作区或身份；操作未发送');
        return data;
      })(),expired]);}finally{env.clearTimeout(timer);}
    }
    async function identify(){
      const before=clone(context()),room=env.SundollRoom||env.window?.SundollRoom;
      const [info,epoch]=await Promise.all([json('/api/info'),json('/api/workspace-epoch')]);
      if(typeof info.projectId!=='string'||!info.projectId||typeof epoch.epoch!=='string')throw fail('工作区身份无法确认；操作未发送');
      let account='';
      if(room||info.authentication?.method==='email_password'){
        const session=await json('/api/account/session');account=session.account?.accountId;
        if(typeof account!=='string'||!account||(room&&account!==room.accountId))throw fail('账号已变化，请重新进入战役；原待核对操作保留');
      }
      let actor,playerId='';
      if(before.host){
        const local=/^(localhost|127\.[\d.]+|\[?::1\]?)$/.test(env.location?.hostname||'');
        if(room||!local){const dm=await json('/api/dm/session');if(dm.authenticated!==true)throw fail('主持人身份未确认；操作未发送');}
        actor=account||'shared-dm';
      }else{
        if(typeof before.sessionToken!=='string'||!before.sessionToken)throw fail('请先登录玩家身份');
        const session=await json('/api/session?token='+encodeURIComponent(before.sessionToken));
        playerId=session.session?.playerId;
        if(typeof playerId!=='string'||!playerId||session.session?.persistent!==true||(before.playerId&&before.playerId!==playerId))throw fail('玩家身份已变化，请重新打开；原待核对操作保留');
        actor=playerId;
      }
      if(stable(before)!==stable(context()))throw fail('当前身份或地图已变化，操作未发送');
      const base={origin:env.location?.origin||'',workspace:room?'room:'+room.id:info.projectId,epoch:epoch.epoch,
                  room:room?.id||'local',account,role:before.host?'host':'player'};
      if(!base.origin||base.origin==='null')throw fail('请通过当前工作区网页操作，无法安全保存待核对请求');
      if(frozenBase&&stable(base)!==stable(frozenBase))throw fail('工作区或账号已变化，请刷新页面；原待核对操作保留');
      frozenBase=base;
      const target=channel==='backpack'?(before.host?before.playerId:playerId):[before.campaignId||'',before.mapId||''];
      if(!target||(channel==='map-items'&&(!target[0]||!target[1])))throw fail('请选择背包或地图后再操作');
      const scope={...base,channel,actor,target};
      return {scope,prefix:PREFIX+stable(scope)+':',sessionToken:before.host?'':before.sessionToken};
    }
    function storage(){try{const s=env.localStorage;if(!s)throw Error();return s;}catch{throw fail('浏览器存储不可用，无法保留待核对请求；本次操作未发送');}}
    function parse(text,scope){
      let entry;try{entry=JSON.parse(text);}catch{throw fail('待核对记录损坏，请保留页面并联系主持人核对；新操作未发送');}
      if(entry?.version!==1||stable(entry.scope)!==stable(scope))throw fail('待核对记录身份不一致；操作未发送');
      if(entry.resolved)return null;
      const c=entry.command;
      if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.requestId!=='string'||! /^[A-Za-z0-9_-]{16,96}$/.test(c.requestId)||!c.op||c.op==='get'||Object.hasOwn(c,'sessionToken'))throw fail('待核对记录无效；操作未发送');
      if((channel==='backpack'&&c.playerId!==scope.target)||(channel==='map-items'&&(c.campaignId!==scope.target[0]||c.mapId!==scope.target[1])))throw fail('待核对请求的目标身份不一致；操作未发送');
      return entry;
    }
    function entries(identity){
      const s=storage(),found=[];
      try{
        // Room-context adds its own account prefix to getItem/setItem. Enumerated
        // keys remain raw, so recover the logical suffix, then use scoped getItem.
        for(let i=0;i<s.length;i++){
          const raw=s.key(i);if(typeof raw!=='string')continue;
          const start=raw.indexOf(identity.prefix);if(start<0)continue;
          const logical=raw.slice(start),rid=logical.slice(identity.prefix.length);
          if(!/^[A-Za-z0-9_-]{16,96}$/.test(rid))continue;
          const text=s.getItem(logical);if(text===null)continue;
          const entry=parse(text,identity.scope);if(entry){if(entry.command.requestId!==rid)throw fail('待核对记录编号不一致');found.push({entry,key:logical});}
        }
      }catch(error){if(error.pendingVerification)throw error;throw fail('浏览器待核对存储不可读；新操作未发送');}
      return found.sort((a,b)=>a.entry.createdAt-b.entry.createdAt||a.key.localeCompare(b.key));
    }
    function result(item,identity){
      const command=clone(item.entry.command);if(identity.sessionToken)command.sessionToken=identity.sessionToken;
      return {command,ticket:{key:item.key,scope:identity.scope,requestId:command.requestId,signature:stable(item.entry.command)}};
    }
    async function load(){const identity=await identify(),found=entries(identity);return found.length?{...result(found[0],identity),count:found.length}:null;}
    async function prepare(command){
      const identity=await identify(),clean=clone(command);delete clean.sessionToken;
      if(typeof clean.requestId!=='string'||! /^[A-Za-z0-9_-]{16,96}$/.test(clean.requestId)||!clean.op||clean.op==='get')throw fail('待核对请求编号无效；操作未发送');
      const found=entries(identity);if(found.length)throw fail('还有操作结果待核对，请先点击核对原操作；新操作未发送');
      const entry={version:1,scope:identity.scope,createdAt:Date.now(),command:clean},key=identity.prefix+clean.requestId,text=JSON.stringify(entry);
      parse(text,identity.scope);
      if(text.length>MAX_LENGTH)throw fail('操作内容过大，浏览器无法持久保留；本次操作未发送');
      try{const s=storage();s.setItem(key,text);if(s.getItem(key)!==text)throw Error();}
      catch(error){throw fail('浏览器无法持久保留待核对请求（可能空间不足）；本次操作未发送，请先恢复可用存储');}
      return result({entry,key},identity);
    }
    async function authorize(ticket){
      const identity=await identify();
      if(stable(identity.scope)!==stable(ticket.scope))throw fail('账号、玩家或地图已变化；原操作保留，未发送重试');
      const raw=storage().getItem(ticket.key);
      if(raw===null)throw fail('本地待核对记录已不存在，请刷新并核对最新状态；原操作未重试');
      const entry=parse(raw,identity.scope);
      if(!entry||entry.command.requestId!==ticket.requestId||stable(entry.command)!==ticket.signature)throw fail('待核对操作已变化或已确认，请读取最新状态；未重试');
      return result({entry,key:ticket.key},identity).command;
    }
    function complete(ticket){
      const s=storage(),raw=s.getItem(ticket.key);if(raw===null)return;
      const entry=parse(raw,ticket.scope);if(!entry)return;
      if(entry.command.requestId!==ticket.requestId||stable(entry.command)!==ticket.signature)throw fail('结果已确认，但待核对记录已变化；其他记录未删除');
      try{
        s.removeItem(ticket.key);if(s.getItem(ticket.key)===null)return;
        throw Error();
      }catch{
        // A resolved tombstone is small and prevents replay even if deletion is
        // blocked. If storage is entirely unavailable, never claim it was cleared.
        try{const text=JSON.stringify({version:1,scope:ticket.scope,resolved:ticket.requestId});s.setItem(ticket.key,text);if(s.getItem(ticket.key)!==text)throw Error();}
        catch{throw fail('结果已确认，但浏览器待核对记录未能清理；请保留页面，重新打开后需再次核对，系统不会自动执行');}
      }
    }
    return Object.freeze({load,prepare,authorize,complete});
  }
  return Object.freeze({create});
});
