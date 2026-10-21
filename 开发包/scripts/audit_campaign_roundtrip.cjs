/* Read-only campaign audit: real host normalization and serializer in a VM. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,plain}=require('../tests/campaign_roundtrip_fixture.cjs');
const {PACKAGE_ROOT,CHECKOUT_ROOT}=require('../tests/project_paths.cjs');
const root=path.join(PACKAGE_ROOT,'战役包');
const args=process.argv.slice(2);
const files=args[0]==='--manifest'?JSON.parse(fs.readFileSync(args[1],'utf8')).map(entry=>path.resolve(CHECKOUT_ROOT,entry.path))
  :args.length?args:fs.readdirSync(root).map(name=>path.join(root,name,'当前存档.json')).filter(file=>fs.existsSync(file));
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function identities(state){return{
  campaignId:state.campaignId||null,mapIds:(state.maps||[]).map(m=>m.id),
  tokens:(state.maps||[]).flatMap(map=>(map.tokens||[]).map(t=>({mapId:map.id,id:t.id,ownedPieceId:t.ownedPieceId||null,ownerPlayerId:t.ownerPlayerId||null,presetId:t.presetId||null,sourcePresetId:t.sourcePresetId||null}))),
  formIds:(state.maps||[]).flatMap(m=>(m.mapForms||[]).map(form=>({mapId:m.id,id:form.id}))),
  journalIds:(state.journal?.entries||[]).map(entry=>entry.id),
};}
function changes(a,b,prefix='',out=[]){
  if(JSON.stringify(a)===JSON.stringify(b))return out;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))changes(a[key],b[key],prefix?`${prefix}.${key}`:key,out);
  }else out.push({path:prefix,kind:a===undefined?'added':b===undefined?'removed':'changed',beforeHash:hash(JSON.stringify(a)??'undefined'),afterHash:hash(JSON.stringify(b)??'undefined')});
  return out;
}
const reports=[];
for(const file of files.sort()){
  const raw=fs.readFileSync(file),saved=JSON.parse(raw),input=saved.state||saved,f=fixture();
  const loaded=f.context.applySavedState(input);if(!loaded){reports.push({file,loaded,warnings:f.warnings});continue;}
  const output=plain(f.context.stateStorageSnapshot()),next=fixture(),reopened=next.context.applySavedState(output);
  const tokens=(input.maps||[]).flatMap(m=>m.tokens||[]),after=new Map(output.maps.flatMap(m=>m.tokens.map(t=>[t.id,t]))),resourceChanges=[];
  const allBefore=tokens.concat(input.travelBasketTokens||[],Object.values(input.parkedOwnedPieces||{}));
  const allAfter=new Map([...after,...(output.travelBasketTokens||[]).map(t=>[t.id,t]),...Object.values(output.parkedOwnedPieces||{}).map(t=>[t.id,t])]);
  let privateNotesPreserved=true,privateNotesPublic=false,nonemptyOldNoteCount=0;
  for(const token of allBefore){
    const notes=[token.gmNote,token.legacyGmNote,...(token.legacyGmNoteHistory||[])].filter(note=>typeof note==='string'&&note.trim());
    if(typeof token.gmNote==='string'&&token.gmNote.trim())nonemptyOldNoteCount++;
    const savedToken=allAfter.get(token.id),savedNotes=[savedToken?.legacyGmNote,...(savedToken?.legacyGmNoteHistory||[])];
    if(notes.some(note=>!savedNotes.includes(note)))privateNotesPreserved=false;
    if(savedToken){const publicToken=f.context.publicStreamToken(savedToken);if(publicToken&&['gmNote','legacyGmNote','legacyGmNoteHistory'].some(key=>Object.hasOwn(publicToken,key)))privateNotesPublic=true;}
  }
  for(const token of tokens)for(const field of ['level','characterRevision','hp','hpMax','tempHp','tempHpMax','ac','conditions','spellSlots','resourceSlots']){
    if(Object.hasOwn(token,field)&&JSON.stringify(token[field])!==JSON.stringify(after.get(token.id)?.[field]))resourceChanges.push({tokenId:token.id,field});
  }
  reports.push({file,campaignId:input.campaignId||null,loaded,reopened,mapCount:output.maps.length,tokenCount:tokens.length,
    sourceUnchanged:hash(raw)===hash(fs.readFileSync(file)),identityUnchanged:JSON.stringify(identities(input))===JSON.stringify(identities(output)),
    resourceChanges,privateNotesPreserved,privateNotesPublic,nonemptyOldNoteCount,firstLoadChanges:changes(input,output),secondLoadChanges:reopened?changes(output,plain(next.context.stateStorageSnapshot())):[],warnings:[...f.warnings,...next.warnings]});
}
process.stdout.write(JSON.stringify({readOnly:true,reports},null,2)+'\n');
if(reports.some(r=>!r.loaded||!r.reopened||!r.sourceUnchanged||!r.identityUnchanged||r.resourceChanges.length||!r.privateNotesPreserved||r.privateNotesPublic))process.exitCode=1;
