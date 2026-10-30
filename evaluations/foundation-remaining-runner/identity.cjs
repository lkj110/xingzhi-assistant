'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const prior=require('../foundation-native-ui-runner/identity.cjs'),{root,read,write,sha,SAMPLE}=prior;
const {planHash}=require('../foundation-business-runner/ledger.cjs');
const prerequisite={runId:'3416bcda-77e0-4866-b0a6-2bb7eabec4f0',report:'docs/evidence/foundation-native-ui-f04-result-20261030.json',reportSha256:'d1440e32e79a60c854627603e1f995428e10ff575bb12a6f20e8d4751cc26985',review:'docs/evidence/foundation-native-ui-f04-result-review-20261030.json',reviewSha256:'fa0e0ed0f8bb263a2119c8b1f1c53d9df56d4d503aae6b6b7cf59947563f9891'};
function validatePlan(plan){
 const old=read(path.join(root,'evaluations/foundation-minimal-runner/plan.json'));
 assert.equal(plan.scope,'G01-F05-F06-only');assert.equal(plan.liveAuthorized,false);assert.equal(plan.candidateInstalled,false);assert.equal(plan.f04,undefined);
 assert.equal(plan.outputParent,'../foundation-transport-retest-runs-20261030');
 assert.deepEqual(plan.order,['gate','business']);assert.deepEqual(plan.f04Prerequisite,prerequisite);
 for(const key of ['gate','business','settings','total','cli','asarSha256','sourceSampleIdentity'])assert.deepEqual(plan[key],old[key],key+' changed');
}
function checkPrerequisite(report,review,completed,decision,summary){
 assert.equal(report.passed,true);assert.equal(review.F04LocalWorkflowPassed,true);assert.equal(review.resultRecordApproved,true);assert.equal(report.scope,'F04-native-ui-only');
 for(const v of [report,review,completed,decision])assert.equal(v.runId,prerequisite.runId);
 assert.equal(report.asarSha256,completed.asarSha256);assert.equal(report.asarSha256,review.asarSha256);assert.equal(report.sampleIdentity,SAMPLE);
 assert.equal(completed.mode,'live');assert.equal(completed.actualIndependentReview,true);assert.ok(completed.finishedAt<completed.deadline);assert.equal(completed.deadline-completed.startedAt,45*60000);
 assert.equal(decision.approved,true);assert.equal(decision.reviewer,'independent-subagent');assert.equal(decision.identity,completed.identity);
 assert.equal(summary.passed,true);assert.equal(summary.actualHumanAcceptance,true);assert.equal(summary.realModelCalls,0);assert.equal(summary.modelCallsAdded,0);assert.deepEqual(summary.transportAttempts,[]);
 assert.equal(summary.asarSha256,report.asarSha256);assert.equal(summary.runnerIdentity,report.runnerIdentity);assert.equal(completed.runnerIdentity,report.runnerIdentity);
}
function verifyPrerequisite(plan){
 assert.deepEqual(plan.f04Prerequisite,prerequisite);const p=prerequisite;
 for(const [file,hash]of [[p.report,p.reportSha256],[p.review,p.reviewSha256]])assert.equal(sha(fs.readFileSync(path.join(root,file))),hash,'F04 public proof changed');
 const report=read(path.join(root,p.report)),review=read(path.join(root,p.review)),run=path.resolve(root,report.evidence.privateRunDirectory),audit=path.resolve(root,report.evidence.privateAuditDirectory);
 for(const f of report.evidence.files){const isAudit=f.path.startsWith('independent-audit/'),file=path.resolve(isAudit?audit:run,isAudit?f.path.slice('independent-audit/'.length):f.path);assert.ok(file.startsWith((isAudit?audit:run)+path.sep));assert.equal(sha(fs.readFileSync(file)),f.sha256,'F04 raw proof changed: '+f.path);}
 assert.ok(!fs.existsSync(path.join(run,'stopped.json'))&&!fs.existsSync(path.join(run,'STOP'))&&!fs.existsSync(path.join(run,'f04/STOP')));
 const completed=read(path.join(run,'f04.completed.json')),decision=read(path.join(run,'f04/phase-review.json')),summary=read(path.join(run,'f04/summary.json'));
 checkPrerequisite(report,review,completed,decision,summary);assert.equal(completed.summarySha256,sha(fs.readFileSync(path.join(run,'f04/summary.json'))));assert.equal(completed.reviewSha256,sha(fs.readFileSync(path.join(run,'f04/phase-review.json'))));
 const value={runId:p.runId,asarSha256:report.asarSha256,sampleIdentity:SAMPLE,completedSha256:sha(fs.readFileSync(path.join(run,'f04.completed.json'))),reportSha256:p.reportSha256,reviewSha256:p.reviewSha256,rerun:false};return {...value,identity:sha(JSON.stringify(value))};
}
function frozen(executable,options={}){const inherited=prior.frozen(executable,options),plan=read(path.join(__dirname,'plan.json'));validatePlan(plan);const proof=verifyPrerequisite(plan);assert.equal(plan.asarSha256,inherited.plan.asarSha256);assert.equal(proof.asarSha256,plan.asarSha256);return {...inherited,plan:options.phase?plan[options.phase]:plan,f04Prerequisite:proof};}
function validateAuthorization(a,plan,identity){
 assert.equal(a?.schema,1);assert.equal(a.grantedBy,'user');assert.ok(typeof a.reference==='string'&&a.reference.trim());assert.equal(a.scope,plan.scope);assert.equal(a.runnerIdentity,identity);assert.equal(a.sealIdentity,SAMPLE);assert.equal(a.asarSha256,plan.asarSha256);assert.equal(a.planSha256,planHash(plan));
 assert.equal(a.f04PrerequisiteIdentity,verifyPrerequisite(plan).identity);for(const[k,v]of Object.entries(plan.total))assert.equal(a[k],v);
 assert.equal(a.nonHardCapAccepted,true);assert.equal(a.humanParticipationConfirmed,true);assert.deepEqual(a.phaseWindowsMinutes,{gate:45,business:45});assert.equal(a.realCliSha256,plan.cli.sha256);
}
function runnerSeal(){
 const inherited=prior.runnerSeal(),deps=[...inherited.dependencies,...inherited.files.map(f=>({...f,path:'evaluations/foundation-native-ui-runner/'+f.path}))];
 for(const p of [prerequisite.report,prerequisite.review,'evaluations/foundation-native-ui-runner/runner-seal.json','evaluations/foundation-native-ui-runner/runner-review.json','scripts/rehearse-remaining-runner.cjs','tests/foundation-remaining-runner.test.cjs','tests/foundation-transport-cause.test.cjs','tests/foundation-transport-retest-preparation.test.cjs','tests/fixtures/foundation-cli-routing-timeout-20261030.json','tests/fixtures/foundation-remaining-prior-seal-20261030.json'])deps.push({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))});
 const files=fs.readdirSync(__dirname).filter(p=>/\.(cjs|json)$/.test(p)&&!['runner-seal.json','runner-review.json'].includes(p)).sort().map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(__dirname,p)))}));
 const value={files,dependencies:[...new Map(deps.map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path)),host:inherited.host};return {schema:1,...value,identity:sha(JSON.stringify(value)),scope:'G01-F05-F06-only',liveAuthorized:false,realModelCalls:0};
}
function verifyRunner(seal){assert.deepEqual(seal,runnerSeal(),'Remaining runner/dependency drift');return seal.identity;}
module.exports={root,pack:require('../foundation-minimal-runner/identity.cjs').pack,read,write,sha,SAMPLE,validatePlan,checkPrerequisite,verifyPrerequisite,frozen,validateAuthorization,runnerSeal,verifyRunner};
