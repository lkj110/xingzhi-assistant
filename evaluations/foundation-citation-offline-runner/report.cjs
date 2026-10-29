'use strict';
// Terminal check outcomes, including human rechecks, determine hard refusal.
// Technical stops and human waiting never become semantic false-block labels.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {read}=require('./identity.cjs'),{digest,current}=require('../foundation-marker-runner/phases.cjs'),{hash}=require('../../desktop/evidence-basis.cjs');
const {coverage}=require('./coverage.cjs'),{ratio}=require('../foundation-business-runner/report.cjs');
function verdict(row){if(!row||row.error||!row.rawOutput)return false;try{const v=JSON.parse(JSON.parse(row.rawOutput).response_json);return typeof v.passed==='boolean'&&v.groundingReview&&typeof v.groundingReview==='object';}catch{return false;}}
function taskOutcome(task,last){
 if(!verdict(last))return 'technical-or-missing';const r=task?.grounding;
 if(!r||r.reportHash!==hash({...r,reportHash:undefined}))return 'technical-or-missing';
 if(r.reviewDisposition==='marker_confirmation'||task.markerReviewHold)return 'human-pending';
 if(r.passed===true&&task.verification?.passed===true)return 'passed';
 if(r.passed===false&&task.verification?.passed===false)return 'hard-rejected';
 return 'technical-or-missing';
}
function outcome(draft,checked,last){
 if(!checked||!draft.contentBinding||draft.contentBinding!==checked.contentBinding||digest(draft.draft)!==digest(checked.draft))return 'technical-or-missing';
 return taskOutcome(checked.task,last);
}
function metrics(judged,negatives,cases){
 const classified=judged.filter(j=>j.qualified!==null),eligible=classified.filter(j=>['passed','hard-rejected'].includes(j.outcome)),qualified=eligible.filter(j=>j.qualified),bad=eligible.filter(j=>!j.qualified),initial=classified.filter(j=>j.stage==='initial'),final=classified.filter(j=>j.finalSameDraft),eligibleNegatives=negatives.filter(n=>['passed','hard-rejected'].includes(n.outcome));
 const rate=(list,predicate)=>ratio(list.filter(predicate).length,list.length),accepted=final.filter(j=>j.qualified&&j.acceptedByHuman),positiveCases=cases.filter(c=>c.lane!=='fixed_invalid');
 return {completionPlanned:ratio(accepted.length,4),completionAttempted:ratio(accepted.length,positiveCases.length),initialDraftHallucination:rate(initial,j=>j.hallucination),finalDraftHallucination:rate(final,j=>j.hallucination),releasedDraftHallucination:rate(eligible.filter(j=>j.outcome==='passed'),j=>j.hallucination),qualifiedDraftHardFalseBlock:rate(qualified,j=>j.outcome==='hard-rejected'),invalidGeneratedDraftRelease:rate(bad,j=>j.outcome==='passed'),fixedInvalidRelease:rate(eligibleNegatives,n=>n.outcome==='passed'),fixedInvalidCorrectlyBlocked:rate(eligibleNegatives,n=>n.outcome==='hard-rejected'),unscorableFixedInvalid:negatives.length-eligibleNegatives.length,technicalOrMissingDrafts:judged.filter(j=>j.outcome==='technical-or-missing').map(j=>({caseId:j.caseId,stage:j.stage})),humanPendingDrafts:judged.filter(j=>j.outcome==='human-pending').map(j=>({caseId:j.caseId,stage:j.stage})),uncertainDrafts:judged.filter(j=>j.qualified===null).map(j=>({caseId:j.caseId,stage:j.stage,reason:j.reason})),caseInterruptions:cases.filter(c=>!c.technicalPassed).map(c=>({caseId:c.caseId,error:c.error,errorCode:c.errorCode}))};
}
function report(directory,adjudication){
 const result=require('../foundation-business-runner/report.cjs').report(directory),summary=read(path.join(directory,'summary.json'));
 result.branchCoverage=coverage(summary);result.metricsVersion='stage-terminal-outcomes-v1';
 if(summary.mode==='offline'||!adjudication)return result;
 const template=result.adjudicationTemplate;for(const k of ['schema','reviewer','sampleSealIdentity','runnerIdentity','asarSha256'])assert.equal(adjudication[k],template[k]);assert.equal(adjudication.judgments.length,template.judgments.length);
 const cases=summary.results.map(r=>read(path.join(directory,r.caseId+'.json'))),rows=summary.ledger.attempts.map(a=>read(path.join(directory,'calls',a.id+'-terminal.json')));
 const judged=template.judgments.map(expected=>{
  const list=adjudication.judgments.filter(j=>j.caseId===expected.caseId&&j.stage===expected.stage);assert.equal(list.length,1);const j=list[0];assert.equal(j.draftHash,expected.draftHash);assert.ok(typeof j.qualified==='boolean'||j.qualified===null);assert.ok(typeof j.hallucination==='boolean'||j.hallucination===null);assert.equal(j.qualified===null,j.hallucination===null);assert.ok(j.reason&&typeof j.reason==='string');assert.ok(!j.qualified||!j.hallucination);
  const c=cases.find(c=>c.caseId===j.caseId),draft=read(path.join(directory,`${j.caseId}-${j.stage}-draft.json`)),checkedPath=path.join(directory,`${j.caseId}-${j.stage}-outcome.json`),checked=fs.existsSync(checkedPath)?read(checkedPath):null;
  const last=rows.filter(r=>r.caseId===j.caseId&&r.role==='verify'&&[j.stage,j.stage+'-human-recheck'].includes(r.evaluationPhase)).at(-1),final=current(c.final,c.taskId);
  const same=digest(final.draft)===j.draftHash;return {...j,outcome:outcome(draft,checked,last),finalSameDraft:same,acceptedByHuman:same&&c.actualHumanAcceptance===true&&final.task.status==='completed'};
 });
 const negatives=cases.filter(c=>c.lane==='fixed_invalid').map(c=>({caseId:c.caseId,outcome:taskOutcome(c.final.tasks.find(t=>t.id===c.taskId),rows.filter(r=>r.caseId===c.caseId&&r.role==='verify').at(-1))}));
 result.qualityStatus='independently-adjudicated';result.quality=metrics(judged,negatives,cases);result.quality.costPerQualifiedHumanAcceptedTask=result.quality.completionPlanned.numerator&&result.cost.totalTokens!==null?result.cost.totalTokens/result.quality.completionPlanned.numerator:null;result.outcomes=judged.map(({caseId,stage,outcome})=>({caseId,stage,outcome}));return result;
}
module.exports={report,ratio,verdict,taskOutcome,outcome,metrics};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{output:{type:'string'},adjudication:{type:'string'}}});console.log(JSON.stringify(report(values.output,values.adjudication?read(values.adjudication):undefined),null,2));}
