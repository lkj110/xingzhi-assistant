'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {analyze,applyAudit,wilson95,pairedResources,summarizeLane}=require('../scripts/grounding-eval-analysis.cjs');
const candidate=JSON.stringify({answer:'a',certainty:'confirmed',basis:'source says a'});
const grade={parseable:true,correct:true,hallucination:false,abstained:false,answer:'a',certainty:'confirmed',reason:'Matches'};
function row(extra={}){return {caseId:'e2e:a',lane:'e2e',arm:'baseline',spec:{answerable:true,expected:{answers:['a'],certainty:'confirmed'}},candidate,grade:{...grade},delivered:true,technicalError:null,usage:{inputTokens:100,outputTokens:20,cachedInputTokens:40},calls:1,durationMs:1000,...extra};}
const report=rows=>({schema:1,identity:'test',rows,status:'complete'});
function override(original,extra={}){return {caseId:original.caseId,arm:original.arm,candidateHash:crypto.createHash('sha256').update(original.candidate||'').digest('hex'),originalGrade:{...original.grade},grade:{...original.grade},review:{basisStatus:'supported',basisHallucination:false},...extra};}
const audit=overrides=>({schema:1,reportIdentity:'test',overrides});

test('zero events retain a nonzero upper bound and no denominator stays null',()=>{
 const one=wilson95(0,16);assert.equal(one.lower,0);assert.ok(one.upper>0.19&&one.upper<0.2);
 assert.deepEqual(wilson95(0,0),{lower:null,upper:null,confidence:0.95,method:'Wilson score'});
 assert.throws(()=>wilson95(2,1));
});
test('paired token accounting includes cache once and compares strict against baseline',()=>{
 const resources=pairedResources([row(),row({arm:'strict',usage:{inputTokens:150,outputTokens:30,cachedInputTokens:50},calls:2,durationMs:3000})]);
 assert.equal(resources.fields.totalTokens.baselineTotal,120);assert.equal(resources.fields.totalTokens.strictTotal,180);
 assert.equal(resources.fields.totalTokens.totalRelativeChangePercent,50);assert.equal(resources.fields.uncachedInputTokens.baselineTotal,60);
 assert.equal(resources.fields.uncachedInputTokens.strictTotal,100);assert.equal(resources.fields.durationMs.medianAbsoluteDelta,2000);
});
test('median pair percentage differs from percentage of aggregate totals',()=>{
 const resources=pairedResources([row({usage:{inputTokens:1}}),row({arm:'strict',usage:{inputTokens:3}}),row({caseId:'b',usage:{inputTokens:100}}),row({caseId:'b',arm:'strict',usage:{inputTokens:110}})]);
 assert.equal(resources.fields.inputTokens.medianRelativeChangePercent,105);
 assert.ok(Math.abs(resources.fields.inputTokens.totalRelativeChangePercent-12/101*100)<1e-10);
});
test('zero baseline pair percentages are null while absolute differences remain',()=>{
 const field=pairedResources([row({calls:0}),row({arm:'strict',calls:1})]).fields.calls;
 assert.equal(field.totalRelativeChangePercent,null);assert.equal(field.medianRelativeChangePercent,null);assert.equal(field.absoluteDelta,1);assert.equal(field.zeroBaselinePairs,1);
});
test('missing and fractional token usage never silently becomes zero',()=>{
 const resources=pairedResources([row(),row({arm:'strict',usage:{inputTokens:null,outputTokens:1.5,cachedInputTokens:0}})]);
 assert.equal(resources.fields.inputTokens.baselineTotal,null);assert.equal(resources.fields.inputTokens.missingPairs,1);
 assert.equal(resources.fields.outputTokens.eligiblePairs,0);assert.equal(resources.fields.cachedInputTokens.strictTotal,0);
});
test('repeated or incomplete pair IDs are excluded and reported',()=>{
 const resources=pairedResources([row(),row(),row({arm:'strict'}),row({caseId:'only'})]);
 assert.equal(resources.pairs,0);assert.deepEqual(resources.unpairedOrRepeatedCaseIds,['e2e:a','only']);
});
test('audit preserves raw grades and source report while counting reviews separately',()=>{
 const original=row({grade:{...grade,correct:false,hallucination:true}}),source=report([original]);
 const reviewed=audit([override(original,{grade:{...original.grade,correct:true,hallucination:false,reason:'Equivalent'}})]);
 const snapshot=JSON.stringify(source),result=analyze(source,reviewed);
 assert.equal(JSON.stringify(source),snapshot);assert.equal(result.rows[0].rawGrade.correct,false);assert.equal(result.rows[0].effectiveGrade.correct,true);
 assert.equal(result.audit.reviewedRows,1);assert.equal(result.audit.changedRows,1);
 assert.equal(result.raw.e2e.byArm.baseline.candidateCorrect.rate,0);assert.equal(result.audited.e2e.byArm.baseline.candidateCorrect.rate,1);
});
test('unchanged review counts as reviewed and not changed',()=>{
 const original=row(),result=analyze(report([original]),audit([override(original)]));
 assert.equal(result.audit.reviewedRows,1);assert.equal(result.audit.changedRows,0);
});
test('review reason annotations do not count as semantic scoring changes',()=>{
 const original=row(),result=analyze(report([original]),audit([override(original,{grade:{...grade,reason:'Source-grounded review reason'}})]));
 assert.equal(result.audit.reviewedRows,1);assert.equal(result.audit.changedRows,0);assert.equal(result.audit.reasonAnnotations,1);
});
test('audit rejects mismatched identity, candidate hash, original grade and duplicate overrides',()=>{
 const original=row(),source=report([original]),reviewed=override(original);
 assert.throws(()=>applyAudit(source,{...audit([reviewed]),reportIdentity:'wrong'}),/identity/);
 assert.throws(()=>applyAudit(source,audit([{...reviewed,candidateHash:'wrong'}])),/candidate/);
 assert.throws(()=>applyAudit(source,audit([{...reviewed,originalGrade:{}}])),/original grade/);
 assert.throws(()=>applyAudit(source,audit([reviewed,reviewed])),/duplicate/);
});
test('audit cannot alter JSON parseability and preserves technical error correction history',()=>{
 const original=row({technicalError:'Recovered failure'}),source=report([original]);
 assert.throws(()=>applyAudit(source,audit([override(original,{grade:{...grade,parseable:false}})])),/parseability/);
 const result=analyze(source,audit([override(original,{technicalError:null})]));
 assert.equal(result.rows[0].rawTechnicalError,'Recovered failure');assert.equal(result.rows[0].effectiveTechnicalError,null);assert.equal(result.audit.technicalCorrections,1);
});
test('honest unknown and creative proposal are included in all-correct false-block denominator',()=>{
 const unknown=row({spec:{answerable:false,expected:{certainty:'unknown'}},grade:{...grade,abstained:true,certainty:'unknown'},delivered:false});
 const proposal=row({caseId:'p',spec:{answerable:false,expected:{certainty:'proposal'}},grade:{...grade,certainty:'proposal'},delivered:false});
 const arm=summarizeLane([unknown,proposal]).byArm.baseline;
 assert.equal(arm.falseBlockCorrectCandidateOnly.denominator,0);assert.equal(arm.allCorrectCandidateFalseBlock.denominator,2);
 assert.equal(arm.allCorrectCandidateFalseBlock.numerator,2);assert.equal(arm.correctUnknownNotDelivered.numerator,1);assert.equal(arm.correctProposalNotDelivered.numerator,1);
});
test('technical failure is excluded from false-block denominators',()=>{
 const arm=summarizeLane([row({delivered:false,technicalError:'network'})]).byArm.baseline;
 assert.equal(arm.allCorrectCandidateFalseBlock.denominator,0);assert.equal(arm.falseBlockCorrectCandidateRaw.numerator,1);
});
test('fully supported false-block includes unknown but excludes insufficient basis',()=>{
 const unknown=row({spec:{answerable:false,expected:{certainty:'unknown'}},delivered:false,auditReview:{basisStatus:'supported'}});
 const generic=row({caseId:'generic',delivered:false,auditReview:{basisStatus:'insufficient'}});
 const arm=summarizeLane([unknown,generic],{audited:true}).byArm.baseline;
 assert.equal(arm.allCorrectCandidateFalseBlock.denominator,2);assert.equal(arm.fullySupportedCandidateFalseBlock.denominator,1);assert.equal(arm.fullySupportedCandidateFalseBlock.numerator,1);
});
test('incorrect fixed input repaired into a correct output is not unsupported acceptance',()=>{
 const repaired=row({lane:'fixed',goldCandidateCorrect:false}),wrong=row({lane:'fixed',caseId:'bad',goldCandidateCorrect:false,grade:{...grade,correct:false,hallucination:true}});
 const fixed=summarizeLane([repaired,wrong]).byArm.baseline.fixedInput;
 assert.equal(fixed.incorrectInputDeliveredFinalCorrect.numerator,1);assert.equal(fixed.incorrectInputUnsupportedFinalDelivered.numerator,1);assert.equal(fixed.incorrectInputUnsupportedFinalDelivered.denominator,2);
});
test('analysis separates lanes and labels unknown delivery safety as a lower bound',()=>{
 const result=analyze(report([row(),row({caseId:'fixed:a',lane:'fixed',grade:{...grade,parseable:false},delivered:true})]));
 assert.equal(result.raw.e2e.byArm.baseline.attempts,1);assert.equal(result.raw.fixed.byArm.baseline.attempts,1);
 assert.equal(result.raw.fixed.byArm.baseline.finalUnsupportedPerDelivered.lowerBoundWhenUngraded,true);assert.equal(result.audited,null);
 const rate=result.raw.e2e.byArm.baseline.finalUnsupportedPerAll;assert.equal(rate.numerator,0);assert.ok(rate.zeroEventOneSidedUpper95>0);
});
test('resource cost per correct delivery includes resources spent on false blocks',()=>{
 const arm=summarizeLane([row(),row({caseId:'blocked',delivered:false})]).byArm.baseline;
 assert.equal(arm.totalTokensPerCorrectDelivered,240);assert.equal(arm.totalTokensPerAttempt,120);
 assert.equal(arm.uncachedInputTokensPerCorrectDelivered,120);assert.equal(arm.callsPerCorrectDelivered,2);assert.equal(arm.callsPerAttempt,1);
});
test('resource efficiency is null for zero success or missing usage and uses each scoring view',()=>{
 const blocked=summarizeLane([row({delivered:false})]).byArm.baseline;
 assert.equal(blocked.totalTokensPerCorrectDelivered,null);assert.equal(blocked.totalTokensPerAttempt,120);assert.equal(blocked.callsPerCorrectDelivered,null);
 const missing=summarizeLane([row({usage:{inputTokens:null,outputTokens:20,cachedInputTokens:null}})]).byArm.baseline;
 assert.equal(missing.totalTokensPerCorrectDelivered,null);assert.equal(missing.uncachedInputTokensPerCorrectDelivered,null);assert.equal(missing.outputTokensPerCorrectDelivered,20);
 const original=row({grade:{...grade,correct:false,hallucination:true}});
 const result=analyze(report([original]),audit([override(original,{grade:{...original.grade,correct:true,hallucination:false}})]));
 assert.equal(result.raw.e2e.byArm.baseline.totalTokensPerCorrectDelivered,null);assert.equal(result.audited.e2e.byArm.baseline.totalTokensPerCorrectDelivered,120);
});
