const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const create=require(path.join(require('./project_paths.cjs').APP_ROOT,'主控台/player/music.js'));
function fixture(relay){
 const nodes=new Map(),audios=[],peers=[];let now=0,token='token';
 const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'70',addEventListener(n,f){this[n]=f;}});return nodes.get(id);};
 class Audio{constructor(){audios.push(this);this.src='';this.currentTime=0;this.duration=100;this.readyState=1;this.paused=true;this.events={};}addEventListener(n,f){this.events[n]=f;}getAttribute(){return this.src;}removeAttribute(){this.src='';}load(){}pause(){this.paused=true;}async play(){this.plays=(this.plays||0)+1;this.paused=false;if(this.fail){this.paused=true;throw this.fail;}}}
 class Peer{constructor(configuration){this.configuration=configuration;peers.push(this);}close(){this.closed=true;}async setRemoteDescription(d){this.remoteDescription=d;}async createAnswer(){return{type:'answer',sdp:'answer'};}async setLocalDescription(d){this.localDescription=d;}async addIceCandidate(){}}
 const api=create({$,session:()=>token,playerId:()=> 'p',serverNow:()=>now,env:{SundollPlayerRelay:relay?{create:()=>relay}:undefined,Audio,RTCPeerConnection:Peer,localStorage:{getItem:()=>null,setItem(){}},fetch:async()=>({ok:true,json:async()=>({ok:true})})}});
 return{api,$,audios,peers,time:t=>now=t,logout:()=>token=''};
}
test('looped songs align by modulo duration and duplicate snapshots do not restart playback',async()=>{const f=fixture();f.time(251000);const cmd={action:'play',mode:'library',url:'/a',time:0,loop:true,issuedAt:1000};await f.api.apply(cmd);assert.equal(f.audios[0].currentTime,50);await f.api.apply(cmd);assert.equal(f.audios[0].plays,1);});
test('late state snapshots cannot override a newer pause command',async()=>{const f=fixture();await f.api.apply({action:'pause',url:'/a',issuedAt:20});await f.api.apply({action:'play',url:'/a',issuedAt:10});assert.equal(f.audios[0].paused,true);});
test('metadata from an older song cannot restore its old seek position',async()=>{const f=fixture();f.audios[0].readyState=0;await f.api.apply({action:'play',url:'/a',time:75,issuedAt:1});const old=f.audios[0].onloadedmetadata;await f.api.apply({action:'play',url:'/b',time:5,issuedAt:2});f.audios[0].readyState=1;old();assert.equal(f.audios[0].currentTime,5);});
test('live track arriving before its play command starts when the command arrives',async()=>{const f=fixture();await f.api.signal({target:'p',signal:{type:'offer',sdp:'sdp'}});f.peers[0].ontrack({streams:[{}]});assert.equal(f.audios[1].plays,undefined);await f.api.apply({action:'play',mode:'live',issuedAt:1});assert.equal(f.audios[1].paused,false);await f.api.apply({action:'pause',mode:'live',issuedAt:2});assert.equal(f.audios[1].paused,true);});
test('switching back to files stops live audio and releases its peer',async()=>{const f=fixture();await f.api.signal({target:'p',signal:{type:'offer',sdp:'sdp'}});f.peers[0].ontrack({streams:[{}]});await f.api.apply({action:'play',mode:'live',issuedAt:1});await f.api.apply({action:'play',url:'/a',issuedAt:2});assert.equal(f.audios[1].paused,true);assert.equal(f.audios[1].srcObject,null);assert.equal(f.peers[0].closed,true);});
test('autoplay blocked state survives duplicate snapshots until user enables audio',async()=>{const f=fixture(),a=f.audios[0];a.fail=Object.assign(new Error('blocked'),{name:'NotAllowedError'});const c={action:'play',url:'/a',issuedAt:1};await f.api.apply(c);await f.api.apply(c);assert.match(f.$('#player-audio-status').textContent,/启用声音/);assert.equal(f.$('#player-audio-enable').hidden,false);a.fail=null;f.$('#player-audio-enable').click();await new Promise(r=>setImmediate(r));assert.equal(f.$('#player-audio-enable').hidden,true);});
test('reset stops both sources and accepts a fresh room timeline',async()=>{const f=fixture();await f.api.apply({action:'play',url:'/old',issuedAt:100});f.api.reset();assert.equal(f.audios[0].src,'');await f.api.apply({action:'play',url:'/new',issuedAt:1});assert.equal(f.audios[0].src,'/new');});

test('relay commands use room audio, pause releases buffers, and WebRTC offers cannot replace it',async()=>{
 const media={},starts=[],stops=[];const relay={start:url=>{starts.push(url);return media;},resume(){},stop(){stops.push(true);},blocked:()=>false,error:()=>''};
 const f=fixture(relay),url='/api/music-live?id=test';await f.api.apply({action:'play',mode:'live',url,issuedAt:1});
 assert.equal(f.audios[1].srcObject,media);await f.api.signal({target:'p',signal:{type:'offer',sdp:'sdp'}});assert.equal(f.peers.length,0);
 await f.api.apply({action:'pause',mode:'live',url,issuedAt:2});assert.equal(f.audios[1].srcObject,null);assert.equal(stops.length,1);
 await f.api.apply({action:'play',mode:'live',url,issuedAt:3});assert.equal(starts.length,2);assert.equal(f.audios[1].paused,false);
 f.api.reset();assert.equal(f.audios[1].srcObject,null);
});


