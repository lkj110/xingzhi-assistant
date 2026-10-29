'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{createFixture}=require('./fixture.cjs'),plan=require('./plan.json');
test('generation, initial verification and human recheck each exercise a batch source read',async()=>{
 const f=createFixture({pack:path.resolve('evaluations/foundation-marker-acceptance-20261029'),plan}),context={id:plan.caseLimits[2].id,title:'Fixture',evaluationPhase:'initial',sources:[{id:'s1',content:'First'},{id:'s2',content:'Second'}]},payload={groundingReviewRequest:{artifactIds:['a']},groundingChecklist:{requirements:[{id:'r'}]}};
 const first=await f({context,role:'execute',payload});assert.equal(first.kind,'read_context');assert.equal(first.requests.length,2);assert.equal((await f({context,role:'execute',payload})).kind,'artifact');
 assert.equal((await f({context,role:'verify',payload})).kind,'read_context');assert.equal((await f({context,role:'verify',payload})).passed,true);context.evaluationPhase='initial-human-recheck';assert.equal((await f({context,role:'verify',payload})).kind,'read_context');assert.equal((await f({context,role:'verify',payload})).passed,true);
});
test('revision uses fully visible original evidence and does not force duplicate reading',async()=>{
 const f=createFixture({pack:path.resolve('evaluations/foundation-marker-acceptance-20261029'),plan}),context={id:plan.caseLimits[4].id,title:'Fixture',revised:true,evaluationPhase:'revision',sources:[{id:'s1',content:'Original'}]},payload={revision:{originalContent:'Old draft'},generationEvidence:[{sourceId:'s1',ok:true,complete:true,more:false,segments:[{text:'Original',truncated:false}]}]};
 assert.equal((await f({context,role:'execute',payload})).kind,'patch');
 const g=createFixture({pack:path.resolve('evaluations/foundation-marker-acceptance-20261029'),plan});payload.generationEvidence[0].complete=false;assert.equal((await g({context,role:'execute',payload})).kind,'read_context');
});
