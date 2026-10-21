const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),root=require('./project_paths.cjs').APP_ROOT;
const create=require(path.join(root,'主控台/host/live-audio.js'));
function stream(audio=true){const tracks=[...(audio?[{kind:'audio',enabled:true,stop(){this.stopped=true;}}]:[]),{kind:'video',stop(){this.stopped=true;}}];return{getTracks:()=>tracks,getAudioTracks:()=>tracks.filter(t=>t.kind==='audio')};}
function fixture(relay){
 let online=true,resolveCapture,signalHook;const peers=[],signals=[],commands=[],constraints=[];
 class Peer{constructor(configuration){this.configuration=configuration;this.connectionState='new';this.tracks=[];peers.push(this);}addTrack(t){this.tracks.push(t);}async createOffer(){return {type:'offer',sdp:'offer'};}async setLocalDescription(d){this.localDescription=d;}async setRemoteDescription(d){this.remoteDescription=d;}async addIceCandidate(){}close(){this.closed=true;}}
 const media={getDisplayMedia:c=>{constraints.push(c);return new Promise(r=>resolveCapture=r);},getUserMedia:c=>{constraints.push(c);return new Promise(r=>resolveCapture=r);},enumerateDevices:async()=>[]};
 const live=create({relay,env:{navigator:{mediaDevices:media},RTCPeerConnection:Peer},online:()=>online,players:()=>[{playerId:'p',online:true}],signal:async(id,s)=>{signals.push(s);if(signalHook)return signalHook(s);return{ok:true};},started:()=>commands.push('play'),stopped:b=>commands.push(b?'stop':'silent-stop'),command:a=>commands.push(a)});
 return {live,peers,signals,commands,constraints,media,setSignal:fn=>signalHook=fn,resolve:s=>resolveCapture(s),offline:()=>online=false};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('only audio is sent to peers and stopping releases every capture track',async()=>{
 const f=fixture(),s=stream(),pending=f.live.start('tab');f.resolve(s);await pending;await tick();assert.equal(f.peers[0].tracks.length,1);assert.equal(f.peers[0].tracks[0].kind,'audio');f.live.stop();assert.ok(s.getTracks().every(t=>t.stopped));assert.equal(f.peers[0].closed,true);assert.deepEqual(f.commands,['play','stop']);
});
test('cancelled picker cannot start a late stream',async()=>{const f=fixture(),s=stream(),p=f.live.start('tab');f.live.stop();f.resolve(s);await p;assert.equal(f.live.status().active,false);assert.ok(s.getTracks().every(t=>t.stopped));assert.equal(f.commands.length,0);});
test('double start opens one picker and disconnect during picker releases its result',async()=>{const f=fixture(),s=stream(),p=f.live.start('tab');await f.live.start('tab');assert.equal(f.constraints.length,1);f.offline();f.resolve(s);await p;assert.ok(s.getTracks().every(t=>t.stopped));assert.equal(f.live.status().active,false);});
test('capture without audio fails without interrupting the file player',async()=>{const f=fixture(),s=stream(false),p=f.live.start('system');f.resolve(s);await assert.rejects(p,/没有取得声音/);assert.deepEqual(f.commands,[]);assert.ok(s.getTracks()[0].stopped);});
test('device broadcast requires explicit choice and disables speech processing',async()=>{const f=fixture();await assert.rejects(f.live.start('device'),/选择/);assert.equal(f.constraints.length,0);const p=f.live.start('device','blackhole','BlackHole 2ch');f.resolve(stream());await p;assert.deepEqual(f.constraints[0].audio.deviceId,{exact:'blackhole'});assert.equal(f.constraints[0].audio.echoCancellation,false);assert.match(f.live.status().label,/BlackHole/);});
test('live pause silences outgoing audio and resume re-enables it',async()=>{const f=fixture(),s=stream(),p=f.live.start('device','test');f.resolve(s);await p;f.live.togglePause();assert.equal(s.getAudioTracks()[0].enabled,false);f.live.togglePause();assert.equal(s.getAudioTracks()[0].enabled,true);assert.deepEqual(f.commands,['play','pause','play']);});
test('source ending cleans peers and sends a stop; late old callbacks cannot stop a new source',async()=>{const f=fixture(),a=stream(),p=f.live.start('tab');f.resolve(a);await p;const ended=a.getTracks()[0].onended;ended();const b=stream(),q=f.live.start('tab');f.resolve(b);await q;ended();assert.equal(f.live.status().active,true);assert.equal(b.getTracks()[0].stopped,undefined);});
test('reconnect replaces peers without recapturing audio',async()=>{const f=fixture(),s=stream(),p=f.live.start('tab');f.resolve(s);await p;await tick();const old=f.peers[0];f.live.sync(undefined,true);await tick();assert.equal(old.closed,true);assert.equal(f.peers.length,2);assert.equal(f.constraints.length,1);assert.equal(s.getTracks()[0].stopped,undefined);});
test('a late failed offer cannot close a newer connection for the same player',async()=>{
 const f=fixture();let finish;
 f.setSignal(s=>s.type==='offer'?new Promise(resolve=>{finish=resolve;}):{ok:true});
 const p=f.live.start('tab');f.resolve(stream());await p;await tick();
 f.setSignal(()=>({ok:true}));await f.live.signal({target:'host',senderPlayerId:'p',signal:{type:'ready'}});
 finish({ok:false});await tick();assert.equal(f.peers.length,2);assert.equal(f.peers[1].closed,undefined);
});

test('room relay sends no WebRTC offers and publishes a same-origin audio URL',async()=>{
 let stopped=0;const relay={prepare:async()=>{},start:async()=>'/api/music-live?id=test',url:()=>'/api/music-live?id=test',stop(){stopped++;}};
 const f=fixture(relay),pending=f.live.start('tab');f.resolve(stream());await pending;
 assert.equal(f.live.status().transport,'https');assert.equal(f.live.status().url,'/api/music-live?id=test');
 assert.equal(f.peers.length,0);f.live.sync(undefined,true);await f.live.signal({target:'host',senderPlayerId:'p',signal:{type:'ready'}});assert.equal(f.peers.length,0);
 f.live.stop();assert.equal(stopped,1);
});
test('cancel while relay is preparing never starts a late upload or replaces playback',async()=>{
 let prepareDone,started=0;const relay={prepare:()=>new Promise(r=>prepareDone=r),start:async()=>{started++;},url:()=>'',stop(){}};
 const f=fixture(relay),s=stream(),pending=f.live.start('tab');f.resolve(s);await tick();f.live.cancelPending();prepareDone();await pending;
 assert.equal(started,0);assert.deepEqual(f.commands,[]);assert.ok(s.getTracks().every(t=>t.stopped));
});


test('public live audio retains its existing external traversal servers',async()=>{
 const f=fixture(),pending=f.live.start('tab');f.resolve(stream());await pending;await tick();
 assert.equal(f.peers[0].configuration.iceServers.length,1);assert.equal(f.peers[0].configuration.iceServers[0].urls.length,2);f.live.stop();
});
