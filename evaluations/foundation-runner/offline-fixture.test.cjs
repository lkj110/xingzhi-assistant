'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFixture}=require('./offline-fixture.cjs');
test('legacy revision fixture without notification metadata remains valid',async()=>{
 const fixture=createFixture(),context={id:'F03-wenshan-revision',revised:true,title:'synthetic',sources:[{id:'s',content:'synthetic'}]},payload={groundingReviewRequest:{artifactIds:['a']},groundingChecklist:{requirements:[{id:'r'}]}};
 assert.equal((await fixture({context,role:'verify',payload})).kind,'read_context');
 const result=await fixture({context,role:'verify',payload});assert.equal(result.passed,true);assert.equal(result.groundingReview.claims.length,1);
});
test('selected offline pack supplies its own gate, notice proposals, revision and unknown disclosure',async t=>{
 const temp=fs.realpathSync(os.tmpdir()),pack=fs.mkdtempSync(path.join(temp,'foundation-offline-gold-'));
 t.after(()=>{assert.ok(path.resolve(pack).startsWith(temp+path.sep));fs.rmSync(pack,{recursive:true,force:true});});
 fs.writeFileSync(path.join(pack,'gold.json'),JSON.stringify({protocolGate:{id:'G00-new',referenceDraft:'新门检原文'},cases:[{id:'N03-new',initialReferenceDraft:'请按预约时间入场。',referenceDraft:'请已登记访客按预约时间入场。',initialNotificationClaims:[{text:'请按预约时间入场。',kind:'proposal'}],notificationClaims:[{text:'请已登记访客按预约时间入场。',kind:'proposal'}]},{id:'N02-new',referenceDraft:'目前不能确定维修时长。',unknownText:'目前不能确定维修时长'}]}));
 const fixture=createFixture({pack,plan:{protocolGate:{id:'G00-new'}}});
 assert.equal((await fixture({context:{id:'G00-new',title:'gate'},role:'execute',payload:{}})).content,'新门检原文');
 for(const revised of [false,true]){
  const context={id:'N03-new',title:'notice',revised,sources:[{id:'s',content:'原文'}]},payload={groundingReviewRequest:{artifactIds:[revised?'b':'a']},groundingChecklist:{requirements:[{id:'r'}]}};
  assert.equal((await fixture({context,role:'verify',payload})).kind,'read_context');const result=await fixture({context,role:'verify',payload});
  assert.equal(result.groundingReview.claims[1].kind,'proposal');assert.equal(result.groundingReview.claims[1].text,revised?'请已登记访客按预约时间入场。':'请按预约时间入场。');assert.ok(result.groundingReview.requirements[0].claimIds.includes('n0'));
 }
 const context={id:'N02-new',title:'conflict',sources:[{id:'s',content:'记录甲'},{id:'t',content:'记录乙'}]},payload={groundingReviewRequest:{artifactIds:['c']},groundingChecklist:{requirements:[{id:'r'}]}};
 await fixture({context,role:'verify',payload});const result=await fixture({context,role:'verify',payload});assert.equal(result.groundingReview.claims[1].text,'目前不能确定维修时长');assert.equal(result.groundingReview.sourceConflicts[0].disposition,'disclosed_unknown');
});
