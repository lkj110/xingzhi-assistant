'use strict';
function coverage(summary){
 const checks=summary.checks||[],markers=checks.filter(c=>c.kind==='marker-handoff-closed'),revision=markers.find(c=>c.caseId==='F05-jianping-revision'&&c.stage==='revision'),restarts=checks.filter(c=>c.kind==='restart-preserved'&&c.caseId==='F06-yunshu-restart');
 const value={synthetic:summary.mode==='offline',sixCaseWorkflowCompleted:summary.passed===true&&summary.results.length===6,f05RevisionNewBasis:checks.some(c=>c.kind==='revision-new-basis'&&c.caseId==='F05-jianping-revision'),markerHandoffs:markers.map(c=>({caseId:c.caseId,stage:c.stage,actualHuman:c.actualHuman,explicitRecheckDispatched:c.afterAttempts>c.beforeAttempts,...c.handoffProof})),f05RevisionHumanConfirmationAndRecheck:!!revision&&revision.actualHuman===true&&revision.afterAttempts>revision.beforeAttempts,f05RevisionAuthorizationObserved:!!revision?.handoffProof?.authorizationId,f05RevisionOldBoundedRecordsPreserved:revision?.handoffProof?.oldRecordsPreserved===true,f05RevisionSameBasisBoundedCollisionObserved:revision?.handoffProof?.priorBoundedSameBasisObserved===true,f06RestartBeforeAdvance:restarts.some(c=>c.stage==='before-advance'),f06RestartAtReview:restarts.some(c=>c.stage==='at-review')};
 value.targetBranchStatus=value.synthetic?'synthetic-only':value.f05RevisionHumanConfirmationAndRecheck&&value.f05RevisionAuthorizationObserved&&value.f05RevisionOldBoundedRecordsPreserved?'observed':'not-covered';
 value.exactHistoricalCollisionLiveCovered=!value.synthetic&&value.targetBranchStatus==='observed'&&value.f05RevisionSameBasisBoundedCollisionObserved;
 return value;
}
module.exports={coverage};
