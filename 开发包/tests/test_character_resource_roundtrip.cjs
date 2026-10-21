const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,plain}=require('./campaign_roundtrip_fixture.cjs');
function saved(){return{campaignId:'c1',campaignName:'回归',activeMapId:'m1',presentedMapId:'m1',maps:[{
  id:'m1',name:'地图',mapW:1000,mapH:800,tokens:[{id:'t1',name:'角色',type:'pc',hp:7,hpMax:30,tempHp:2,tempHpMax:4,
    ownedPieceId:'o1',ownerPlayerId:'p1',characterRevision:12,level:6,
    spellSlots:{1:{current:2,max:4}},resourceSlots:[{id:'rage',current:1,max:3}],ac:16,x:100,y:200,conditions:[]}]}]};}
test('real campaign loading preserves character growth, resource slots and revision through serialization',()=>{
  const input=saved(),original=plain(input),f=fixture();assert.equal(f.context.applySavedState(input),true,f.warnings.join('\n'));
  const output=plain(f.context.stateStorageSnapshot()),token=output.maps[0].tokens[0];
  for(const field of ['id','ownedPieceId','ownerPlayerId','characterRevision','level','hp','hpMax','tempHp','tempHpMax','ac','x','y','spellSlots','resourceSlots']){
    assert.deepEqual(token[field],input.maps[0].tokens[0][field],field);
  }
  const reopened=fixture();assert.equal(reopened.context.applySavedState(output),true,reopened.warnings.join('\n'));
  assert.deepEqual(plain(reopened.context.stateStorageSnapshot()).maps[0].tokens[0],token);assert.deepEqual(input,original);
});
test('token normalization retains independent slots and archives old private notes without deleting their text',()=>{
  const f=fixture(),token=saved().maps[0].tokens[0];token.gmNote='旧字段';
  f.context.normalizeSheet(token);assert.equal(token.level,6);assert.equal(token.characterRevision,12);
  assert.deepEqual(plain(token.spellSlots),{1:{current:2,max:4}});assert.deepEqual(plain(token.resourceSlots),[{id:'rage',current:1,max:3}]);
  assert.equal('gmNote'in token,false);
  assert.equal(token.legacyGmNote,'旧字段');
});
test('old GM notes do not overwrite an existing archive and never enter the public token projection',()=>{
  const f=fixture(),input=saved();Object.assign(input.maps[0].tokens[0],{legacyGmNote:'已有归档',gmNote:'旧存档备注',legacyGmNoteHistory:['更早内容']});
  assert.equal(f.context.applySavedState(input),true);const token=plain(f.context.stateStorageSnapshot()).maps[0].tokens[0];
  assert.equal(token.legacyGmNote,'已有归档');assert.deepEqual(token.legacyGmNoteHistory,['更早内容','旧存档备注']);assert.equal('gmNote'in token,false);
  const publicToken=plain(f.context.publicStreamToken(token));
  for(const field of ['gmNote','legacyGmNote','legacyGmNoteHistory'])assert.equal(Object.hasOwn(publicToken,field),false,field);
  const next=fixture();assert.equal(next.context.applySavedState(plain(f.context.stateStorageSnapshot())),true);
  assert.deepEqual(plain(next.context.stateStorageSnapshot()).maps[0].tokens[0].legacyGmNoteHistory,token.legacyGmNoteHistory);
});
test('saving parks and travel tokens archives their old private notes as well',()=>{
  const f=fixture();assert.equal(f.context.applySavedState(saved()),true);
  f.state.parkedOwnedPieces={o2:{id:'parked',ownedPieceId:'o2',gmNote:'离场备注'}};
  f.state.travelBasketTokens=[{id:'travel',gmNote:'旅行备注'}];const output=plain(f.context.stateStorageSnapshot());
  assert.equal(output.parkedOwnedPieces.o2.legacyGmNote,'离场备注');assert.equal('gmNote'in output.parkedOwnedPieces.o2,false);
  assert.equal(output.travelBasketTokens[0].legacyGmNote,'旅行备注');assert.equal('gmNote'in output.travelBasketTokens[0],false);
});
test('invalid saved resource slots fail loading without replacing the current campaign or source',()=>{
  const f=fixture();assert.equal(f.context.applySavedState(saved()),true);const previous=plain(f.state),input=saved();
  input.maps[0].tokens[0].resourceSlots='corrupt';const original=plain(input);
  assert.equal(f.context.applySavedState(input),false);assert.deepEqual(plain(f.state),previous);assert.deepEqual(input,original);
});
test('unknown journal dates stay unknown after normalization and reopening',()=>{
  const f=fixture(),journal={campaignId:'c1',worldSeconds:null,entries:[{id:'j1',title:'旧日志',text:'保留',worldSeconds:42,createdWorldSeconds:null,updatedWorldSeconds:null}]};
  const first=plain(f.context.CampaignJournal.normalize(journal,'c1'));
  assert.equal(first.worldSeconds,null);assert.equal(first.entries[0].createdWorldSeconds,null);assert.equal(first.entries[0].updatedWorldSeconds,null);
  assert.deepEqual(plain(f.context.CampaignJournal.normalize(first,'c1')),first);
  for(const value of [undefined,null,'','  ',false])assert.equal(f.context.CampaignJournal.normalize({worldSeconds:value},'c1').worldSeconds,null);
  assert.equal(f.context.CampaignJournal.normalize({worldSeconds:0},'c1').worldSeconds,0);
});
