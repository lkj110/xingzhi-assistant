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
test('new typed proof prepares original primary without changing legacy cycles, and cannot replenish with same facts',t=>{
 const f=setup(t),e=cc.episode(f.a,f.job,f.task),before={cycles:e.cycles,hops:e.hops};
 assert.ok(consume.facts(f.a,f.job,f.task).length);prepare(f);
 assert.deepEqual({cycles:e.cycles,hops:e.hops},before);assert.equal(consume.selectedStep(f.a,f.job,f.task).id,f.artifact.stepId);
 assert.equal(Object.keys(f.task.evidenceConsumption.attempts).length,1);prepare(f);assert.equal(Object.keys(f.task.evidenceConsumption.attempts).length,1);
});
test('actual patch retains fact-to-section receipt and same primary lineage atomically',async t=>{
 const f=setup(t);prepare(f);const step=policy.claim(f.a,f.job);let calls=0;
 f.a.chat=async(_p,_k,m,o)=>{calls++;o.onUsage?.({inputTokens:10,outputTokens:5});const p=f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId],fact=p.targetFacts[0];const section=require('../desktop/generation-context.cjs').sections(f.artifact).find(s=>s.title==='输入与输出');return {kind:'patch',edits:[{before:'已有事实。',after:'已有事实。新增证据：report 表从 orders 读取 x 字段。'}],summary:'按真实SQL补齐',evidenceIntegration:[{factKey:fact.factKey,obligationId:fact.obligationId,sectionId:section.id,quote:'新增证据：report 表从 orders 读取 x 字段。'}]};};
 const run={id:'consumption-run',jobId:f.job.id,startedAt:new Date().toISOString(),status:'running',modelCalls:0,modelCallsDetail:[],steps:[]};f.a.data.agentRuns.unshift(run);f.a.activeAgentJob=f.job;f.a.activeAgentRun=run;
 step.at=new Date().toISOString();run.steps.push(step);cc.started(f.a,f.job,step);f.a.save();step.result=await agent.act(f.a,f.job,step.tool,step.args);cc.settled(f.a,f.job,step);
 assert.equal(calls,1,JSON.stringify(step.result));const current=require('../desktop/deliverables.cjs').primary(f.a,f.task);
 assert.notEqual(current.id,f.artifact.id);assert.equal(current.baseArtifactId,f.artifact.id);assert.equal(current.draftOnly,true);assert.equal(current.primaryLineageId,f.artifact.id);
 assert.equal(f.task.evidenceConsumption.receipts.length,1);assert.equal(f.task.evidenceConsumption.receipts[0].artifactHash,hash(current.content));assert.equal(f.task.evidenceConsumption.receipts[0].verified,false);
 assert.equal(consume.inspect(f.a,f.job,f.task),null,'same proof must not produce a second attempt');
});
test('unknown possible model request blocks reissue before a new budget reservation',t=>{
 const f=setup(t);prepare(f);f.a.activeAgentRun={id:'run'};f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;consume.begin(f.a,f.job,f.task,consume.selectedStep(f.a,f.job,f.task));
 consume.beforeModel(f.a,{requestId:'request-1',attempt:1,spendTicket:{id:'ticket'},role:'execute'});
 assert.throws(()=>consume.modelGuard(f.a),{code:'EVIDENCE_GENERATION_UNRESOLVED'});consume.failed(f.a,f.task,{code:'MODEL_TIMEOUT'});
 assert.equal(consume.inspect(f.a,f.job,f.task).reason,'EVIDENCE_GENERATION_UNRESOLVED');assert.equal(f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId].requests.length,1);
});
function validResult(f){const p=f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId],fact=p.targetFacts[0],section=require('../desktop/generation-context.cjs').sections(f.artifact).find(s=>s.title==='输入与输出');return {kind:'artifact',title:f.artifact.title,content:f.artifact.content.replace('已有事实。','已有事实。新增证据：report 表读取 orders 的 x 字段。'),evidenceIntegration:[{factKey:fact.factKey,obligationId:fact.obligationId,sectionId:section.id,quote:'新增证据：report 表读取 orders 的 x 字段。'}]};}
function begin(f){prepare(f);f.a.activeAgentRun={id:'original-generation-run'};f.a.activeAgentJob=f.job;f.a.activeSpendTask=f.task;return consume.begin(f.a,f.job,f.task,consume.selectedStep(f.a,f.job,f.task));}
for(const defect of ['unchanged','wrong-fact','wrong-section','old-quote','absent-quote'])test('consumption refuses '+defect+' without declaring integrated evidence',t=>{
 const f=setup(t);begin(f);const result=validResult(f);
 if(defect==='unchanged')result.content=f.artifact.content;
 if(defect==='wrong-fact')result.evidenceIntegration[0].factKey='unrelated';
 if(defect==='wrong-section')result.evidenceIntegration[0].sectionId='unknown';
 if(defect==='old-quote')result.evidenceIntegration[0].quote='已有事实。';
 if(defect==='absent-quote')result.evidenceIntegration[0].quote='这是模型虚构的不存在位置';
 assert.throws(()=>consume.retain(f.a,f.job,f.task,f.task.steps[0],result),{code:'EVIDENCE_NOT_INTEGRATED'});assert.equal(f.task.evidenceConsumption.receipts.length,0);assert.equal(f.task.primaryArtifactId,f.artifact.id);
});
test('retained response survives cold restart and commits without a second model request',async t=>{
 const f=setup(t);begin(f);const result=validResult(f);consume.retain(f.a,f.job,f.task,f.task.steps[0],result);
 const {Assistant}=require('../desktop/core.cjs');const a=new Assistant({dir:f.dir,chat:()=>assert.fail('retained result must not invoke model'),connectorRequest:()=>assert.fail('connector')});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));const task=a.task(f.task.id),job=a.data.delegations.find(j=>j.id===f.job.id);
 assert.equal(consume.candidate(a,job,task,task.steps[0]).content,result.content);await a.advance(task.id);
 assert.equal(task.evidenceConsumption.receipts.length,1);assert.equal(require('../desktop/deliverables.cjs').primary(a,task).content,result.content);assert.equal((a.data.modelCalls||[]).length,0);
});
for(const change of ['source','primary','intent','permission'])test('late '+change+' change rejects retained draft without replacing original',t=>{
 const f=setup(t);begin(f);consume.retain(f.a,f.job,f.task,f.task.steps[0],validResult(f));
 if(change==='source')f.a.data.sources.find(s=>s.id===f.task.sourceIds[0]).content+='\nchanged';
 if(change==='primary')f.artifact.content+='\n人类修改';
 if(change==='intent')f.job.goal+='\n增加新的要求';
 if(change==='permission')f.job.executionState.permissionRevision=(f.job.executionState.permissionRevision||0)+1;
 assert.throws(()=>consume.candidate(f.a,f.job,f.task,f.task.steps[0]),{code:'EVIDENCE_CONSUMPTION_STALE'});assert.equal(f.task.primaryArtifactId,f.artifact.id);assert.equal(f.task.evidenceConsumption.receipts.length,0);
});
test('fresh B may carry failed A within one bounded revision but A alone grants no second attempt',t=>{
 const f=setup(t,{roots:['123','456']});const first=begin(f),aKeys=first.targetFacts.map(f=>f.factKey);
 consume.failed(f.a,f.task,{code:'EVIDENCE_NOT_INTEGRATED'});assert.equal(consume.inspect(f.a,f.job,f.task).reason,'EVIDENCE_CONSUMPTION_FAILED');
 f.need({gaps:['入口456 SQL缺失']});const s=f.source('code',{taskId:456,sql:'INSERT INTO output_b SELECT b FROM input_b'},{taskId:456},{},false);f.resolve([...f.task.sourceIds,s.id]);cc.refresh(f.a,f.job);
 const second=consume.inspect(f.a,f.job,f.task);assert.equal(second.command,'evidence_consume');
 assert.ok(second.proof.targetFacts.length);assert.ok(second.proof.targetFacts.every(f=>!aKeys.includes(f.factKey)));
 assert.deepEqual(second.proof.additionalFacts.map(f=>f.factKey),aKeys);assert.ok(second.proof.targetFacts.length+second.proof.additionalFacts.length<=consume.LIMIT);
 prepare(f);const p=consume.begin(f.a,f.job,f.task,consume.selectedStep(f.a,f.job,f.task));const result=validResult(f);
 const carried=p.additionalFacts[0];result.evidenceIntegration=[{...result.evidenceIntegration[0],factKey:carried.factKey,obligationId:carried.obligationId}];
 assert.throws(()=>consume.retain(f.a,f.job,f.task,f.task.steps[0],result),{code:'EVIDENCE_NOT_INTEGRATED'},'carrying A cannot hide failure to integrate new B');
 const fresh=p.targetFacts[0];result.evidenceIntegration.push({...result.evidenceIntegration[0],factKey:fresh.factKey,obligationId:fresh.obligationId});
 consume.retain(f.a,f.job,f.task,f.task.steps[0],result);assert.equal(p.candidate.evidenceIntegration.length,2);
});
test('adopting another draft cannot remove the incomplete-evidence publication gate',async t=>{
 const f=setup(t);f.artifact.draftOnly=true;f.task.status='todo';f.task.steps[0].done=false;
 await f.a.dispatch('adoptArtifact',{id:f.task.id,stepId:f.task.steps[0].id,title:'补充稿',content:f.artifact.content+'\n补充文字不能作为证据闭合。'});
 const current=require('../desktop/deliverables.cjs').primary(f.a,f.task);assert.notEqual(current.id,f.artifact.id);assert.equal(current.draftOnly,true);
 assert.throws(()=>consume.assertDelivery(f.a,f.job,f.task),{code:'DRAFT_EVIDENCE_INCOMPLETE'});
 assert.ok(require('../desktop/acceptance.cjs').reasons(f.a,f.task).some(r=>r.code==='draft_evidence'));
});
