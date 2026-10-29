'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=require('../foundation-diagnostic-runner/identity.cjs'),marker=require('../foundation-marker-runner/identity.cjs'),{root,sha,read,write}=base,{pack}=marker;
function prerequisite(plan){
 const g=plan.gatePrerequisite;assert.equal(g.required,true);assert.equal(g.executions,0);
 for(const [p,h]of [[g.evidencePath,g.evidenceSha256],[g.reviewPath,g.reviewSha256]])assert.equal(sha(fs.readFileSync(path.join(root,p))),h,'Gate evidence changed');
 const evidence=read(path.join(root,g.evidencePath)),review=read(path.join(root,g.reviewPath));
 assert.equal(evidence.runId,g.runId);assert.equal(review.runId,g.runId);assert.equal(evidence.runnerIdentity,g.runnerIdentity);assert.equal(review.runnerIdentity,g.runnerIdentity);assert.equal(evidence.result.protocolGatePassed,true);assert.equal(review.protocolGatePassed,true);assert.equal(review.approvedForUpload,true);assert.deepEqual(review.remainingFindings,[]);assert.equal(evidence.cost.authoritativeUsageComplete,true);assert.equal(evidence.result.unknownUsage,0);assert.equal(evidence.result.pendingUsage,0);
 assert.equal(g.runnerIdentity,read(path.join(root,'evaluations/foundation-diagnostic-runner/runner-seal.json')).identity);
 const local={};for(const f of g.localEvidence){assert.equal(sha(fs.readFileSync(path.resolve(root,f.path))),f.sha256,'Private gate evidence changed');local[f.kind]=read(path.resolve(root,f.path));}
 assert.equal(local.summary.passed,true);assert.equal(local.summary.asarSha256,plan.asarSha256);assert.equal(local.summary.runnerIdentity,g.runnerIdentity);assert.equal(local.summary.sampleSealIdentity,evidence.sampleSealIdentity);assert.equal(local.summary.ledger.totals.unknownUsage,0);assert.equal(local.decision.approved,true);assert.equal(local.decision.identity,evidence.contentReview.checkpointIdentity);assert.equal(local.authorization.runId,g.runId);assert.equal(local.authorization.realCliSha256,g.realCliSha256);
 assert.equal(local.state.modelCalls.length,evidence.result.realModelDispatches);for(const c of local.state.modelCalls){assert.equal(c.providerType,'codex');assert.equal(c.model,plan.model.id);assert.equal(c.reasoning,plan.model.reasoning);}
 return {runId:g.runId,evidenceSha256:g.evidenceSha256,reviewSha256:g.reviewSha256};
}
function frozen(executable,{complete=false}={}){
 const old=base.frozen(executable,{complete}),plan=read(path.join(__dirname,'plan.json')),suite=read(path.join(pack,'stimuli.json'));
 assert.equal(plan.liveAuthorized,false);assert.equal(plan.asarSha256,old.plan.asarSha256);assert.deepEqual(plan.model,old.plan.model);assert.deepEqual(plan.settings,old.plan.settings);assert.deepEqual(plan.order,suite.cases.map(c=>c.id));assert.equal(plan.order.length,6);assert.ok(!plan.order.includes(plan.protocolGate.id));assert.equal(plan.budget.protocolAttempts,0);assert.equal(plan.budget.protocolTokenStopThreshold,0);assert.equal(plan.budget.applicationAttempts,plan.budget.businessAttempts);assert.equal(plan.budget.reportedTokenStopThreshold,plan.budget.businessTokenStopThreshold);
 return {...old,plan,gateProof:prerequisite(plan)};
}
function runnerSeal(){
 const old=base.runnerSeal(),deps=[...old.dependencies];
 for(const name of fs.readdirSync(path.join(root,'evaluations/foundation-diagnostic-runner'))){const p='evaluations/foundation-diagnostic-runner/'+name;if(fs.statSync(path.join(root,p)).isFile())deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});}
 const g=read(path.join(__dirname,'plan.json')).gatePrerequisite;for(const p of [g.evidencePath,g.reviewPath,...g.localEvidence.map(f=>f.path)])deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 const dependencies=[...new Map(deps.map(d=>[d.path,d])).values()].sort((a,b)=>a.path.localeCompare(b.path));
 const files=fs.readdirSync(__dirname).filter(f=>/\.(cjs|md|json)$/.test(f)&&!['runner-seal.json','runner-review.json'].includes(f)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));const contents={files,dependencies,host:old.host};return {schema:1,sampleSealIdentity:old.sampleSealIdentity,...contents,identity:sha(JSON.stringify(contents)),liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(manifest){assert.deepEqual(manifest,runnerSeal(),'Business runner identity changed');return manifest.identity;}
function seal(){assert.ok(!fs.existsSync(path.join(__dirname,'runner-review.json')),'Reviewed runner cannot be resealed');const value=runnerSeal();fs.writeFileSync(path.join(__dirname,'runner-seal.json'),JSON.stringify(value,null,2)+'\n');return {runnerIdentity:value.identity,sampleSealIdentity:value.sampleSealIdentity};}
module.exports={root,pack,sha,read,write,frozen,runnerSeal,verifyRunner,seal,prerequisite};if(require.main===module)console.log(JSON.stringify(seal()));
