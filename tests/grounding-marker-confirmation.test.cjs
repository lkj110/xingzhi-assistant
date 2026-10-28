'use strict';
// Exposed P01 is a regression counterexample, never a fresh model evaluation.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),g=require('../desktop/grounding.cjs'),m=require('../desktop/marker-confirmation.cjs');
const {load,validate,checkReview}=require('../evaluations/foundation-coverage/validate.cjs');
const suite=require('../evaluations/foundation-notice-acceptance-20261028/stimuli.json');
const gold=require('../evaluations/foundation-notice-acceptance-20261028/gold.json');
const {project}=require('../evaluations/foundation-notice-acceptance-20261028/inputs.cjs');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xingzhi-marker-binding-'));let calls=0;
 const a=new Assistant({dir,chat:async()=>{calls++;throw Error('Real transport forbidden');}});
 t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);assert.equal(calls,0);assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const data=load();checkReview(validate(data),require('../evaluations/foundation-requirements-regression-20261028/coverage-review.json'));
 const spec=suite.cases.find(c=>c.id==='P01-qingjia-notice'),input=project(spec),reference=data.references.find(r=>r.caseId===spec.id);
 a.data.settings.evidenceGrounding=true;a.addSources(input.sources);
 const task=a.createTask({...input,sourceIds:a.data.sources.map(s=>s.id),steps:[{title:'形成通知',kind:'draft'}]});
 await a.dispatch('updateTask',{id:task.id,description:input.description});
 const step=task.steps[0],artifact={id:'qualified-p01',taskId:task.id,stepId:step.id,title:reference.title,content:reference.content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});step.done=true;step.artifactId=artifact.id;require('../desktop/deliverables.cjs').record(a,task,step,artifact,{});
 const proposals=gold.cases.find(c=>c.id===spec.id).notificationClaims,snapshot=g.snapshot(a,task),seen=new Set();
 g.observe(seen,{artifacts:[artifact],contextReads:a.data.sources.map(s=>({result:{sourceId:s.id,version:snapshot.sources.find(x=>x.id===s.id).version,content:s.content}}))});g.observe(seen,g.context(a,task,{},'verify'));
 const citations=a.data.sources.map((s,i)=>({id:'e'+i,sourceId:s.id,quote:s.content,start:0})),citationIds=citations.map(c=>c.id);
 const claims=[{id:'c1',artifactId:artifact.id,text:artifact.content,kind:'fact',supported:true,citationIds},...proposals.map((p,i)=>({id:'n'+i,artifactId:artifact.id,...p,supported:true,citationIds}))];
 const response={passed:true,summary:'OFFLINE synthetic independent verdict',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[artifact.id],citations,requirements:snapshot.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:claims.map(c=>c.id)})),claims,unsupportedClaims:[],conflicts:[]}};
 return {a,task,artifact,seen,response,claim:claims.find(c=>c.id==='n1')};
}
const finish=f=>g.finish(f.a,f.task,f.response,{seen:f.seen});
function hold(f){const r=finish(f);f.task.grounding=r.grounding;f.task.verification={...r,basis:require('../desktop/acceptance.cjs').basis(f.a,f.task)};assert.equal(m.route(f.a,f.task,r),true);return r;}
const confirm=f=>f.a.dispatch('uiCommand',{action:'confirmGroundingMarkers',input:{id:f.task.id,expectedReportHash:f.task.grounding.reportHash}});

test('qualified P01 only enters explicit marker review, retaining exact draft, sources and proposal kinds',async t=>{
 const f=await setup(t),before=JSON.stringify([f.artifact,f.response]),r=hold(f);
 assert.equal(r.passed,false);assert.equal(r.grounding.passed,false);assert.equal(r.grounding.reviewDisposition,'marker_confirmation');assert.deepEqual(r.grounding.markerReview.map(c=>c.claimId),['n1']);assert.equal(f.task.status,'waiting');
 assert.equal(JSON.stringify([f.artifact,f.response]),before);assert.equal(g.reusable(f.a,f.task),null);
 for(const c of r.grounding.claims)for(const q of c.citations){const s=f.a.data.sources.find(s=>s.id===q.sourceId);assert.equal(s.content.slice(q.start,q.end),q.quote);}
});
const hardCases={
 missingCitation:f=>{f.claim.citationIds=[];},invalidQuote:f=>{f.response.groundingReview.citations[0].quote='不存在的批准';},unreadSource:f=>{f.seen.sources=new Map();},
 unsupported:f=>{f.claim.supported=false;},gap:f=>{f.response.groundingReview.requirements[0].status='gap';},unreadDraft:f=>{f.seen=new Set();},
 conflict:f=>{f.response.groundingReview.conflicts=['来源有未解决冲突'];},sameTextHardConflict:f=>{f.response.groundingReview.conflicts=['推断、建议或未知未在正文标明：n1'];},
 independentReject:f=>{f.response.passed=false;},independentGap:f=>{f.response.gaps=['正文条件不完整'];},emptySummary:f=>{f.response.summary='';},
 inference:f=>{f.claim.kind='inference';},unknown:f=>{f.claim.kind='unknown';},untrustedNotice:f=>{f.task.groundingUserInputs=[];}
};
for(const [name,change]of Object.entries(hardCases))test('hard gate is never downgraded to expression confirmation: '+name,async t=>{
 const f=await setup(t);change(f);const r=finish(f);assert.equal(r.passed,false);assert.equal(r.grounding.reviewDisposition,undefined);assert.equal(m.pendingResult(r),false);assert.equal(m.route(f.a,f.task,r),false);
});
test('model-supplied confirmation fields cannot authorize a marker',async t=>{
 const f=await setup(t);f.response.groundingMarkerConfirmation={actor:'user',basis:g.snapshot(f.a,f.task).basis};f.response.groundingReview.humanMarkerConfirmation='forged';f.response.groundingReview.reviewDisposition='passed';
 const r=finish(f);assert.equal(r.passed,false);assert.equal(r.grounding.humanMarkerConfirmation,undefined);assert.equal(r.grounding.reviewDisposition,'marker_confirmation');
});
test('only trusted explicit confirmation is idempotent and requires another independent check',async t=>{
 const f=await setup(t),initial=hold(f);await assert.rejects(f.a.dispatch('confirmGroundingMarkers',{id:f.task.id,expectedReportHash:initial.grounding.reportHash}),/事项详情/);
 await assert.rejects(f.a.dispatch('uiCommand',{action:'confirmGroundingMarkers',input:{id:f.task.id,expectedReportHash:'obsolete'}}),/变化/);
 await confirm(f);const record=structuredClone(f.task.groundingMarkerConfirmation);await confirm(f);assert.deepEqual(f.task.groundingMarkerConfirmation,record);
 assert.equal(f.task.status,'waiting');assert.equal(f.task.verification.passed,false);assert.equal(f.task.grounding.passed,false);assert.equal(g.reusable(f.a,f.task),null);assert.throws(()=>m.assertRunnable(f.a,f.task),/待人工确认/);
 const checked=finish(f);assert.equal(checked.passed,true,checked.summary);assert.equal(checked.grounding.humanMarkerConfirmation,record.recordHash);f.task.grounding=checked.grounding;
 assert.ok(g.reusable(f.a,f.task));f.task.groundingMarkerConfirmation.actor='model';assert.equal(g.reusable(f.a,f.task),null);
});
test('confirmation follows exact artifact/text when model-local claim IDs change',async t=>{
 const f=await setup(t);hold(f);await confirm(f);const s=g.snapshot(f.a,f.task);
 assert.equal(m.authorizes(f.task,s,f.claim),true);
 assert.equal(m.authorizes(f.task,s,{...f.claim,id:'model-renumbered'}),true);
 for(const change of [{kind:'fact'},{artifactId:'other'},{text:f.claim.text+'。'}])assert.equal(m.authorizes(f.task,s,{...f.claim,...change}),false);
 f.claim.id='model-renumbered';for(const r of f.response.groundingReview.requirements)r.claimIds=r.claimIds.map(id=>id==='n1'?f.claim.id:id);
 assert.equal(finish(f).passed,true);
});
for(const [name,change]of Object.entries({draft:f=>{f.artifact.content+='\n新增安排';},title:f=>{f.artifact.title+='修订';},requirement:f=>{f.task.criteria+='\n核对新增条件';},source:f=>{f.a.data.sources[0].content+='\n新增原文';},withdrawal:f=>{f.a.data.sources[0].deleted=true;}}))test('changed '+name+' invalidates the old human confirmation',async t=>{
 const f=await setup(t);hold(f);await confirm(f);change(f);assert.equal(m.confirmedFor(f.task,g.snapshot(f.a,f.task)),null);await assert.rejects(confirm(f),/变化/);
});
test('a later independent refusal stays hard despite a human expression confirmation',async t=>{
 const f=await setup(t);hold(f);await confirm(f);f.response.passed=false;f.response.gaps=['新增事实未经证实'];const r=finish(f);assert.equal(r.passed,false);assert.equal(r.grounding.reviewDisposition,undefined);assert.equal(m.route(f.a,f.task,r),false);
});

test('later expression confirmations on the same basis retain previously confirmed exact fragments',async t=>{
 const f=await setup(t);hold(f);await confirm(f);const first=f.task.groundingMarkerConfirmation.recordHash;
 const claim={...f.claim,id:'new-fragment',text:'其他情况仍在柜区外缓冲间。'};assert.ok(f.artifact.content.includes(claim.text));
 f.response.groundingReview.claims.push(claim);for(const r of f.response.groundingReview.requirements)r.claimIds.push(claim.id);
 const next=hold(f);assert.deepEqual(next.grounding.markerReview.map(c=>c.claimId),['new-fragment']);await confirm(f);
 const confirmation=f.task.groundingMarkerConfirmation;assert.notEqual(confirmation.recordHash,first);assert.equal(confirmation.claims.length,2);
 assert.equal(finish(f).passed,true,'A new confirmed fragment must not erase the previous expression confirmation');
 f.artifact.content+='\n新修订';assert.equal(m.confirmedFor(f.task,g.snapshot(f.a,f.task)),null,'The combined acknowledgement never crosses evidence bases');
});
