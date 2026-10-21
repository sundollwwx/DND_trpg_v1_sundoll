/* Supply real persistence with simulated authentication to existing UI fixtures. */
const {create}=require('../../程序包/主程序/主控台/shared/pending-requests.js');
class MemoryStorage{
 constructor(){this.data=new Map();}get length(){return this.data.size;}
 key(i){return [...this.data.keys()][i]??null;}getItem(k){return this.data.get(k)??null;}
 setItem(k,v){this.data.set(k,String(v));}removeItem(k){this.data.delete(k);}
}
function installPendingFixture(context,options={}){
 const storage=options.storage||new MemoryStorage(),state=options.state||{projectId:'fixture-project',epoch:'fixture-epoch',accountId:'',playerId:''};
 const root=context.window;
 root.SundollPendingRequests={create(settings){return create({...settings,env:{
  localStorage:storage,location:{origin:'http://127.0.0.1:9999',hostname:'127.0.0.1'},AbortController,setTimeout,clearTimeout,
  get SundollRoom(){return state.roomId?{id:state.roomId,accountId:state.accountId}:undefined;},
  async fetch(url){let data;
   if(url==='/api/info')data={projectId:state.projectId,authentication:{method:state.accountId?'email_password':'name'}};
   else if(url==='/api/workspace-epoch')data={epoch:state.epoch};
   else if(url==='/api/account/session')data={account:{accountId:state.accountId}};
   else if(url==='/api/dm/session')data={authenticated:true};
   else if(url.startsWith('/api/session?')){
    const token=new URL(url,'http://127.0.0.1').searchParams.get('token'),at=settings.context();
    // Legacy fixtures model every replacement token as a different viewer.
    const id=state.playerId||(at.playerId?(token==='session-2'?'p2':at.playerId):'fixture-player-'+token);
    data={session:{playerId:id,persistent:true}};
   }else throw Error('unexpected identity URL');
   return {ok:true,status:200,json:async()=>data};
  }
 }});}};
 return {storage,state};
}
module.exports={installPendingFixture,MemoryStorage};
