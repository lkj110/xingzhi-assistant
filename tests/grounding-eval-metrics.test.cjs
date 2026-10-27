'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {grade,summarize,usageSummary}=require('../scripts/grounding-eval-metrics.cjs');
const spec={answerable:true,expected:{answers:['周五'],certainty:'confirmed'}};
const answer=(value='周五',certainty='confirmed',basis='来自合成会议记录')=>JSON.stringify({answer:value,certainty,basis});
const row=(extra={})=>({caseId:'one',arm:'baseline',spec,grade:grade(spec,answer()),delivered:true,usage:{inputTokens:100,outputTokens:20,cachedInputTokens:40},calls:2,durationMs:10,...extra});

test('exact answer and certainty pass, without fuzzy numeric or unit equivalence',()=>{
 assert.equal(grade(spec,answer()).correct,true);
 assert.equal(grade(spec,answer('周五或周六')).hallucination,true);
 const numeric={expected:{answers:['100万元'],certainty:'confirmed'}};
 assert.equal(grade(numeric,answer('100元')).hallucination,true);
});
test('gold answers normalize Unicode NFC and surrounding whitespace only',()=>{
 const s={expected:{answers:['café'],certainty:'confirmed'}};
 assert.equal(grade(s,answer(' cafe\u0301 ')).correct,true);
 assert.equal(grade(s,answer('CAFÉ')).correct,false);
});
test('markdown fences and non-JSON artifacts are ungradeable',()=>{
 for(const value of ['```json\n'+answer()+'\n```','周五','',null,'[]'])assert.equal(grade(spec,value).parseable,false);
});
test('schema must contain only string answer certainty and basis with a valid certainty',()=>{
 for(const value of [{answer:'周五',certainty:'confirmed'}, {answer:5,certainty:'confirmed',basis:''},{answer:'周五',certainty:'certain',basis:''},{answer:'周五',certainty:'confirmed',basis:'',extra:true}])assert.equal(grade(spec,JSON.stringify(value)).parseable,false);
});
test('valid unknown answer is safe abstention and remains a correct task candidate',()=>{
 const s={answerable:false,expected:{answers:['无法确认'],certainty:'unknown'}};
 const g=grade(s,answer('无法确认','unknown'));
 assert.equal(g.correct,true);assert.equal(g.abstained,true);assert.equal(g.hallucination,false);
 assert.equal(grade(s,answer('周五','confirmed')).hallucination,true);
});
test('confirmed when evidence supports only inference is an unsupported assertion',()=>{
 const s={expected:{answers:['可能周五'],certainty:'inference'}};
 assert.equal(grade(s,answer('可能周五','confirmed')).hallucination,true);
 assert.equal(grade(s,answer('可能周五','inference')).correct,true);
 assert.equal(grade(s,answer('可能周六','inference')).hallucination,true);
});
test('extra caution can fail task correctness without being a factual hallucination',()=>{
 const g=grade(spec,answer('周五','unknown'));assert.equal(g.correct,false);assert.equal(g.hallucination,false);assert.equal(g.abstained,true);
});
test('proposal task failures do not count as factual hallucinations',()=>{
 const s={answerable:true,expected:{answers:['建议小范围试用'],certainty:'proposal'}};
 assert.equal(grade(s,answer('建议小范围试用','proposal')).correct,true);
 const g=grade(s,answer('开展全面投放','confirmed'));assert.equal(g.correct,false);assert.equal(g.hallucination,false);
});
test('invalid gold specifications fail loudly',()=>{
 assert.throws(()=>grade({expected:{answers:[],certainty:'confirmed'}},answer()),TypeError);
});
test('final hallucination excludes blocked candidates and uses explicit denominators',()=>{
 const bad=grade(spec,answer('周六'));
 const s=summarize([row({grade:bad,delivered:false}),row({caseId:'two',grade:bad,delivered:true}),row({caseId:'three'})]).byArm.baseline;
 assert.deepEqual(s.finalUnsupportedPerAll,{numerator:1,denominator:3,rate:1/3});
 assert.equal(s.finalUnsupportedPerDelivered.denominator,2);assert.equal(s.finalUnsupportedPerDelivered.rate,0.5);
 assert.equal(s.candidateUnsupportedPerAll.numerator,2);assert.equal(s.taskSuccess.numerator,1);
});
test('misblocking excludes technical failures and separately reports broad non-delivery',()=>{
 const s=summarize([row({delivered:false}),row({caseId:'two',delivered:false,technicalError:'timeout'}),row({caseId:'three',delivered:false,grade:grade(spec,answer('周六'))})]).byArm.baseline;
 assert.equal(s.falseBlockCorrectCandidateOnly.numerator,1);assert.equal(s.falseBlockCorrectCandidateOnly.denominator,1);
 assert.equal(s.falseBlockCorrectCandidateRaw.numerator,2);assert.equal(s.falseBlockCorrectCandidateRaw.denominator,2);
 assert.equal(s.correctCandidateTechnicalNonDelivery,1);assert.equal(s.allAnswerableNotDelivered.numerator,3);assert.equal(s.allAnswerableNotDelivered.isFalseBlockRate,false);
});
test('zero denominators are null and ungradeable delivery is explicitly visible',()=>{
 const empty=summarize([]).byArm.baseline;assert.equal(empty.taskSuccess.rate,null);assert.equal(empty.falseBlockCorrectCandidateOnly.rate,null);
 const s=summarize([row({grade:grade(spec,'broken')})]).byArm.baseline;
 assert.equal(s.ungradeableCandidates,1);assert.equal(s.finalUnsupportedPerDelivered.ungradeableDelivered,1);assert.equal(s.finalUnsupportedPerDelivered.lowerBoundWhenUngraded,true);
});
test('cached tokens are already included in input and are never double counted',()=>{
 const u=usageSummary([row(),row()]);assert.equal(u.inputTokens,200);assert.equal(u.cachedInputTokens,80);assert.equal(u.totalTokens,240);assert.equal(u.uncachedInputTokens,120);
});
test('missing usage remains unknown with known subtotals, not zero',()=>{
 const u=usageSummary([row(),row({usage:{inputTokens:50,outputTokens:10}})]);
 assert.equal(u.cachedInputTokens,null);assert.equal(u.uncachedInputTokens,null);assert.equal(u.inputTokens,150);assert.equal(u.totalTokens,180);assert.equal(u.knownTotals.cachedInputTokens,40);assert.equal(u.missingRows.cachedInputTokens,1);
 const unknown=usageSummary([row({usage:{}})]);assert.equal(unknown.totalTokens,null);assert.equal(unknown.knownTotals.totalTokens,0);assert.equal(unknown.missingRows.totalTokens,1);
});
test('inconsistent provider cache count is surfaced and uncached remains nonnegative',()=>{
 const u=usageSummary([row({usage:{inputTokens:10,outputTokens:1,cachedInputTokens:20}})]);assert.equal(u.inconsistentRows,1);assert.equal(u.uncachedInputTokens,0);assert.equal(u.totalTokens,11);
});
test('paired success differences require exactly one row in each arm',()=>{
 const report=summarize([row({delivered:false}),row({arm:'strict'}),row({caseId:'unpaired'}),row({caseId:'repeated'}),row({caseId:'repeated'})]);
 assert.equal(report.paired.pairs,1);assert.equal(report.paired.strictOnlySucceeded,1);assert.deepEqual(report.paired.unpairedOrRepeatedCaseIds,['unpaired','repeated']);
});
test('safe abstention reports candidate and delivered views separately',()=>{
 const s={answerable:false,expected:{answers:['未知'],certainty:'unknown'}},g=grade(s,answer('未知','unknown'));
 const result=summarize([row({spec:s,grade:g,delivered:false})]).byArm.baseline;
 assert.equal(result.safeAbstention.rate,1);assert.equal(result.safeAbstentionDelivered.rate,0);assert.equal(result.falseBlockCorrectCandidateOnly.denominator,0);
});
test('missing call and duration metadata cannot become an asserted total',()=>{
 const result=summarize([row({calls:undefined,durationMs:undefined}),row({caseId:'two'})]).byArm.baseline;
 assert.equal(result.calls.total,null);assert.equal(result.calls.knownTotal,2);assert.equal(result.durationMs.total,null);assert.equal(result.durationMs.knownTotal,10);
});
test('unknown arm names are rejected rather than dropped from reports',()=>{
 assert.throws(()=>summarize([row({arm:'control'})]),TypeError);
});
