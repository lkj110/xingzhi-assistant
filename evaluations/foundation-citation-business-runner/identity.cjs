'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-citation-gate-runner/identity.cjs'),{root,pack,sha,read,write}=base;
const SAMPLE='68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5';
function prerequisite(plan){
 const g=plan.gatePrerequisite;assert.equal(g.required,true);assert.equal(g.executions,0);assert.equal(g.authorizationReusable,false);
 for(const [p,h]of [[g.evidencePath,g.evidenceSha256],[g.reviewPath,g.reviewSha256]])assert.equal(sha(fs.readFileSync(path.join(root,p))),h,'Gate evidence changed');
 const evidence=read(path.join(root,g.evidencePath)),review=read(path.join(root,g.reviewPath));
 for(const value of [evidence,review]){assert.equal(value.runId,g.runId);assert.equal(value.runnerIdentity,g.runnerIdentity);assert.equal(value.candidateAsarSha256,plan.asarSha256);assert.equal(value.sourceCodeCommit,plan.sourceCodeCommit);}
 assert.equal(evidence.sampleSealIdentity,SAMPLE);assert.equal(evidence.result.protocolGatePassed,true);assert.equal(review.protocolGatePassed,true);assert.equal(review.approvedForResultReport,true);assert.equal(review.roundClosed,true);assert.equal(review.authorizationReusable,false);assert.equal(review.unusedBudgetReusable,false);assert.deepEqual(review.unresolvedFindings,[]);assert.equal(evidence.cost.authoritativeUsageComplete,true);
 assert.equal(review.reviewedFiles.find(f=>f.path===g.evidencePath)?.sha256,g.evidenceSha256);
 assert.equal(g.runnerIdentity,read(path.join(root,'evaluations/foundation-citation-gate-runner/runner-seal.json')).identity);
 const local={};for(const f of g.localEvidence){assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256,'Private gate evidence changed');assert.ok(!local[f.kind]);local[f.kind]=read(path.resolve(root,f.path));}
 assert.deepEqual(Object.keys(local).sort(),['authorization','closure','consumption','decision','state','summary']);
 const s=local.summary,t=local.state.tasks.find(t=>t.id===s.taskId);assert.equal(s.passed,true);assert.equal(s.mode,'live');assert.equal(s.synthetic,false);assert.equal(s.asarSha256,plan.asarSha256);assert.equal(s.runnerIdentity,g.runnerIdentity);assert.equal(s.sampleSealIdentity,SAMPLE);
 for(const key of ['unknownUsage','pendingUsage','unexpectedAttempts'])assert.equal(s.ledger.totals[key],0);assert.equal(s.ledger.totals.usageComplete,true);assert.equal(s.ledger.totals.totalTokens,evidence.cost.totalTokens);assert.equal(s.ledger.totals.totalTokens,review.cost.totalTokens);assert.deepEqual(s.errors,[]);assert.deepEqual(s.appErrors,[]);
 assert.equal(local.decision.approved,true);assert.equal(local.decision.identity,evidence.contentReview.checkpointIdentity);assert.equal(local.decision.reviewer,'independent-subagent');assert.equal(local.decision.sealIdentity,SAMPLE);assert.equal(t.status,'review');assert.equal(t.verification.passed,true);assert.equal(t.grounding.passed,true);assert.equal(t.acceptedAt,undefined);
 const priorPlan=read(path.join(root,'evaluations/foundation-citation-gate-runner/plan.json'));base.validateAuthorization(local.authorization,priorPlan,g.runnerIdentity);assert.equal(local.authorization.runId,g.runId);assert.equal(local.authorization.realCliSha256,g.realCliSha256);assert.equal(local.consumption.runId,g.runId);assert.equal(local.consumption.authorizationSha256,g.localEvidence.find(f=>f.kind==='authorization').sha256);assert.equal(local.consumption.outputDirectory,local.authorization.outputDirectory);
 const closure=local.closure;assert.equal(closure.runId,g.runId);assert.equal(closure.authorizationReusable,false);assert.equal(closure.unusedBudgetReusable,false);assert.equal(closure.protocolGatePassed,true);assert.equal(closure.runProcessExitCode,0);assert.equal(closure.summarySha256,g.localEvidence.find(f=>f.kind==='summary').sha256);assert.equal(closure.originalDeadline,s.ledger.startedAt+45*60000);assert.ok(Date.parse(closure.closedAt)<closure.originalDeadline);
 for(const [kind,key]of [['summary','summarySha256'],['state','stateSha256'],['decision','checkpointDecisionSha256'],['closure','authorizationClosureSha256'],['authorization','authorizationSha256'],['consumption','consumedAuthorizationSha256']])assert.equal(review.evidence[key],g.localEvidence.find(f=>f.kind===kind).sha256);
 assert.equal(local.state.modelCalls.length,evidence.result.realModelDispatches);assert.equal(s.realCliExecutions,evidence.result.realModelDispatches);assert.equal(review.callAudit.modelDispatches,s.realCliExecutions);for(const c of local.state.modelCalls){assert.equal(c.providerType,'codex');assert.equal(c.model,plan.model.id);assert.equal(c.reasoning,plan.model.reasoning);}
 return {runId:g.runId,evidenceSha256:g.evidenceSha256,reviewSha256:g.reviewSha256,executions:0,authorizationReusable:false};
}
function validatePlan(plan){
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.scope,'six-sealed-business-regressions-on-citation-candidate');assert.equal(plan.budget.protocolAttempts,0);assert.equal(plan.budget.protocolTokenStopThreshold,0);
 assert.equal(plan.budget.applicationAttempts,40);assert.equal(plan.budget.businessAttempts,40);assert.equal(plan.budget.maximumModelDispatches,34);assert.equal(plan.budget.reportedTokenStopThreshold,1000000);assert.equal(plan.budget.businessTokenStopThreshold,1000000);assert.equal(plan.budget.dispatchWindowMinutes,45);assert.equal(plan.budget.priorBudgetsReusable,false);assert.equal(plan.budget.serverEnforcedTokenCap,false);
 assert.deepEqual(plan.caseLimits.map(c=>c.attempts),[3,3,7,7,13,7]);assert.deepEqual(plan.caseLimits.map(c=>c.tokenStopThreshold),[80000,80000,170000,170000,330000,170000]);assert.deepEqual(plan.caseLimits.map(c=>c.id),plan.order);
 assert.equal(plan.humanParticipationRequired,true);assert.equal(plan.samplesParticipatedOfflineRegression,true);assert.equal(plan.freshBlindEvaluation,false);assert.equal(plan.targetBranchPolicy.naturalTriggerOnly,true);assert.equal(plan.citationFieldCoverage.naturalTriggerOnly,true);assert.equal(plan.citationFieldCoverage.noForcedCitationOrExtraCalls,true);assert.equal(plan.citationFieldCoverage.separateFromBusinessOutcome,true);
 assert.deepEqual(plan.order,read(path.join(pack,'stimuli.json')).cases.map(c=>c.id));assert.equal(plan.settings.concurrency,1);assert.equal(plan.settings.retries,0);assert.equal(plan.settings.fallback,false);assert.equal(plan.caseFailureEndsRound,true);assert.equal(plan.candidateInstalled,false);
}
function frozen(executable,{complete=false}={}){
 const old=base.frozen(executable,{complete});base.verifyRunner(read(path.join(root,'evaluations/foundation-citation-gate-runner/runner-seal.json')));
 const plan=read(path.join(__dirname,'plan.json'));validatePlan(plan);assert.equal(plan.asarSha256,old.plan.asarSha256);assert.deepEqual(plan.model,old.plan.model);assert.deepEqual(plan.settings,old.plan.settings);
 return {...old,plan,gateProof:prerequisite(plan)};
}
function validateAuthorization(a,plan,runnerIdentity){
 assert.equal(a?.schema,1);assert.equal(a.grantedBy,'user');assert.ok(typeof a.reference==='string'&&a.reference.trim());assert.equal(a.runnerIdentity,runnerIdentity);assert.equal(a.sealIdentity,SAMPLE);assert.equal(a.planSha256,require('../foundation-business-runner/ledger.cjs').planHash(plan));
 assert.equal(a.applicationAttempts,40);assert.equal(a.maximumModelDispatches,34);assert.equal(a.reportedTokenStopThreshold,1000000);assert.equal(a.dispatchWindowMinutes,45);assert.equal(a.nonHardCapAccepted,true);assert.equal(a.humanParticipationConfirmed,true);assert.equal(a.realCliSha256,plan.gatePrerequisite.realCliSha256);
}
function runnerSeal(){
 const inherited=base.runnerSeal(),deps=[...inherited.dependencies];
 for(const dir of ['foundation-citation-gate-runner','foundation-business-runner'])for(const file of fs.readdirSync(path.join(root,'evaluations',dir))){const p='evaluations/'+dir+'/'+file;if(fs.statSync(path.join(root,p)).isFile())deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});}
 const g=read(path.join(__dirname,'plan.json')).gatePrerequisite;for(const p of [g.evidencePath,g.reviewPath,...g.localEvidence.map(f=>f.path)])deps.push({path:p,sha256:sha(fs.readFileSync(path.resolve(root,p)))});
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const dependencies=[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),contents={files,dependencies,host:inherited.host};return {schema:1,sampleSealIdentity:SAMPLE,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(value){assert.deepEqual(value,runnerSeal(),'Business candidate runner or dependency changed');return value.identity;}
function seal(){assert.ok(!fs.existsSync(path.join(__dirname,'runner-seal.json')),'Existing seal is immutable');const value=runnerSeal();write(path.join(__dirname,'runner-seal.json'),value);return {runnerIdentity:value.identity,sampleSealIdentity:SAMPLE};}
module.exports={root,pack,sha,read,write,prerequisite,validatePlan,validateAuthorization,frozen,runnerSeal,verifyRunner,seal};if(require.main===module)console.log(JSON.stringify(seal()));
