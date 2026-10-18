'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs');
const cc=require('../desktop/continuation-control.cjs'),consume=require('../desktop/evidence-consumption.cjs');
const policy=require('../desktop/execution-policy.cjs'),agent=require('../desktop/agent.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
function setup(t,options){
 const f=fixture(t,options),{a,job,task}=f;job.platformPrincipal='fixture-user';require('../desktop/access-policy-store.cjs').grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixture'});
 const artifact={id:'original-primary',taskId:task.id,stepId:task.steps[0].id,title:'交接',content:'# 交接\n\n## 输入与输出\n已有事实。\n\n## 排障\n原有排障。',createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});task.primaryArtifactId=artifact.id;task.steps[0].artifactId=artifact.id;task.generationMode='single';
 assert.equal(cc.redirect(a,job,{args:{taskId:task.id}}, {code:'PLAN_ALREADY_RECONCILED',message:'同一计划已协调',taskId:task.id}),true);
 f.need();const s=f.source('code',{taskId:123,sql:'INSERT INTO report SELECT x FROM orders'},{taskId:123},{},false);f.resolve([s.id]);
 cc.refresh(a,job);job.nextRunAt=null;a.save();return {...f,artifact};
}
function prepare(f){let p=policy.prepare(f.a,f.job);assert.equal(p.eligible,true,JSON.stringify(p));assert.equal(p.action.tool,'advance_task');assert.ok(f.task.evidenceConsumption,JSON.stringify(p));return p;}
function validResult(f){const p=f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId],fact=p.targetFacts[0],section=require('../desktop/generation-context.cjs').sections(f.artifact).find(s=>s.title==='输入与输出');return {kind:'artifact',title:f.artifact.title,content:f.artifact.content.replace('已有事实。','已有事实。新增证据：report 表读取 orders 的 x 字段。'),evidenceIntegration:[{factKey:fact.factKey,obligationId:fact.obligationId,sectionId:section.id,quote:'新增证据：report 表读取 orders 的 x 字段。'}]};}
function begin(f){prepare(f);f.a.activeAgentRun={id:'original-generation-run'};f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;return consume.begin(f.a,f.job,f.task,consume.selectedStep(f.a,f.job,f.task));}
function requestRun(f,id='run'){f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;f.a.activeAgentRun={id,jobId:f.job.id,startedAt:new Date().toISOString(),status:'running',modelCalls:0,modelCallsDetail:[],steps:[]};}
function stable(f){return JSON.stringify({artifacts:f.a.data.artifacts,attempts:f.task.evidenceConsumption,ledger:f.a.spendLedger,calls:f.a.data.modelCalls});}

function idle(f){const r=f.a.activeAgentRun;if(r){r.status='done';r.finishedAt=new Date().toISOString();}f.a.activeAgentRun=null;f.a.activeAgentJob=null;f.a.activeSpendTask=null;}
function patch(f,second=false){const p=consume.active(f.task),fact=p.targetFacts[0],artifact=require('../desktop/deliverables.cjs').primary(f.a,f.task),section=require('../desktop/generation-context.cjs').sections(artifact).find(s=>s.title==='输入与输出'),quote=second?'新证据B：report 当前从 products 读取 z 字段。':'新增证据：report 表从 orders 读取 x 字段。';return {kind:'patch',edits:[{before:'已有事实。',after:'已有事实。'+quote}],summary:'controlled fact incorporation',evidenceIntegration:[{factKey:fact.factKey,obligationId:fact.obligationId,sectionId:section.id,quote}]};}
async function first(t){const f=setup(t,{roots:['123','456'],kinds:'SQL读写和物理表血缘'});prepare(f);Object.assign(f.a.data.providers.find(p=>p.id===f.a.data.settings.roles.execute),{inputPrice:2,cachedInputPrice:0.1,outputPrice:10});requestRun(f,'original-A');f.a.data.agentRuns.unshift(f.a.activeAgentRun);f.calls=0;f.a.chat=async()=>{f.calls++;return patch(f);};await f.a.advance(f.task.id);const p=consume.active(f.task);assert.equal(p.status,'committed');assert.equal(p.requests[0].usageReported,false);assert.ok(p.completionProof);idle(f);return f;}
function addB(f){f.need();const b=f.source('code',{taskId:123,sql:'INSERT INTO report SELECT z FROM products'},{taskId:123},{},false);f.resolve([...f.task.sourceIds,b.id]);cc.refresh(f.a,f.job);f.job.nextRunAt=null;f.a.save();assert.equal(consume.pendingBarrier(f.job,f.task),undefined);}
function cold(t,f){const a=new (require('../desktop/core.cjs').Assistant)({dir:f.dir,chat:()=>assert.fail('unexpected call')});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));return {...f,a,task:a.task(f.task.id),job:a.data.delegations.find(j=>j.id===f.job.id)};}
for(const restart of [false,true])test(`C6 known response without usage admits B under original reservation ${restart?'cold':'warm'}`,async t=>{
 let f=await first(t);const original=structuredClone(consume.active(f.task)),scopeKey='job:'+f.job.id,s=f.a.spendLedger.scopes[scopeKey],held=s.heldUSD;assert.ok(held>0);assert.equal(s.limitUSD,100);assert.equal(s.approvals.length,0);addB(f);if(restart)f=cold(t,f);
 prepare(f);assert.notEqual(consume.active(f.task).attemptId,original.attemptId);requestRun(f,'next-B');f.a.data.agentRuns.unshift(f.a.activeAgentRun);let calls=0;f.a.chat=async(_p,_k,_m,o)=>{calls++;o.onUsage?.({inputTokens:10,outputTokens:5});return patch(f,true);};await f.a.advance(f.task.id);
 assert.equal(calls,1);assert.equal(f.task.evidenceConsumption.receipts.length,2);assert.deepEqual(f.task.evidenceConsumption.attempts[original.attemptId],original);assert.ok(f.a.spendLedger.scopes[scopeKey].heldUSD>=held-1e-9);assert.equal(f.a.spendLedger.scopes[scopeKey].limitUSD,100);assert.equal(f.a.spendLedger.scopes[scopeKey].approvals.length,0);
});
for(const change of ['possible_dispatch','unknown','missing-proof','wrong-call','wrong-receipt','duplicate-receipt','altered-artifact','second-unknown'])test('C6 metering reservation cannot settle '+change,async t=>{
 let f=await first(t);const p=consume.active(f.task);
 if(change==='possible_dispatch'||change==='unknown')p.requests[0].status=change;
 if(change==='missing-proof')delete p.completionProof;
 if(change==='wrong-call')p.requests[0].callId='other-call';
 if(change==='wrong-receipt')p.receipt.integration=[];
 if(change==='duplicate-receipt')f.task.evidenceConsumption.receipts.push(structuredClone(p.receipt));
 if(change==='altered-artifact')f.a.data.artifacts.find(a=>a.id===p.receipt.artifactId).content+='\nchanged';
 if(change==='second-unknown')p.requests.push({...p.requests[0],requestId:'other-request',status:'unknown'});
 addB(f);f=cold(t,f);const before=stable(f);let calls=0;f.a.chat=async()=>{calls++;assert.fail('must stay blocked')};
 assert.equal(consume.inspect(f.a,f.job,f.task).reason,'EVIDENCE_GENERATION_UNRESOLVED');assert.equal(policy.prepare(f.a,f.job).eligible,false);await assert.rejects(f.a.advance(f.task.id),{code:'EVIDENCE_GENERATION_UNRESOLVED'});assert.equal(calls,0);assert.equal(stable(f),before);
});
test('C6 B admission retains original budget limit and cannot dispatch when next reservation exceeds it',async t=>{
 const f=await first(t),s=f.a.spendLedger.scopes['job:'+f.job.id],original=structuredClone(consume.active(f.task));s.limitUSD=s.spentUSD+s.heldUSD+0.01;const limit=s.limitUSD,held=s.heldUSD;require('../desktop/spend.cjs').persist(f.a);addB(f);prepare(f);requestRun(f,'budget-B');let calls=0;f.a.chat=async()=>{calls++;assert.fail('budget must stop actual call')};await f.a.advance(f.task.id).catch(e=>assert.equal(e.spendLimit,true));assert.equal(calls,0);assert.equal(s.limitUSD,limit);assert.equal(s.heldUSD,held);assert.equal(s.approvals.length,0);assert.equal(s.blocked.kind,'budget');assert.deepEqual(f.task.evidenceConsumption.attempts[original.attemptId],original);
});

test('C6 ordinary manual advance records its real progress-run identity and completes consumption',async t=>{
 const f=setup(t);prepare(f);assert.equal(f.a.activeAgentRun,undefined);let calls=0;f.a.chat=async()=>{calls++;return patch(f);};await f.a.advance(f.task.id);assert.equal(calls,1);const p=consume.active(f.task);assert.equal(p.status,'committed');assert.ok(p.runId);assert.equal(p.runId,f.task.progressRuns[0].id);assert.equal(p.requests[0].runId,p.runId);assert.equal(p.completionProof.request.runId,p.runId);assert.equal(f.a.data.modelCalls[0].runId,p.runId);
});

test('C6 later verification metadata on the receipt cannot erase cold successful response identity',async t=>{
 let f=await first(t);f.a.save();f=cold(t,f);const original=structuredClone(consume.active(f.task));Object.assign(f.task.evidenceConsumption.receipts[0],{verified:true,verifiedAt:new Date().toISOString(),checkBasis:'later-independent-check'});f.a.save();f=cold(t,f);assert.notDeepEqual(f.task.evidenceConsumption.receipts[0],consume.active(f.task).receipt);addB(f);prepare(f);assert.deepEqual(f.task.evidenceConsumption.attempts[original.attemptId],original);
});
