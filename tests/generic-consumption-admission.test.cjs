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
for(const status of ['failed','unknown'])for(const entry of ['policy','agent','core','model'])test(`C1/C2 ${status} cannot bypass through ${entry}`,async t=>{
 const f=setup(t);begin(f);requestRun(f,'original-generation-run');
 if(status==='unknown')consume.beforeModel(f.a,{requestId:'original-unknown',attempt:1,spendTicket:{id:'existing-ticket'},role:'execute'});
 consume.failed(f.a,f.task,{code:status==='unknown'?'MODEL_TIMEOUT':'EVIDENCE_NOT_INTEGRATED'});f.a.save();requestRun(f,'new-run');
 const before=stable(f);let calls=0;f.a.chat=async()=>{calls++;throw Error('forbidden repeat')};
 const code=status==='unknown'?'EVIDENCE_GENERATION_UNRESOLVED':'EVIDENCE_CONSUMPTION_FAILED';
 if(entry==='policy'){const p=policy.inspect(f.a,f.job,{currentExecutionId:f.a.activeAgentRun.id});assert.equal(p.eligible,false,JSON.stringify(p));assert.equal(p.reasonCode,code);}
 if(entry==='agent')await assert.rejects(agent.act(f.a,f.job,'advance_task',{taskId:f.task.id}),{code});
 if(entry==='core')await assert.rejects(f.a.advance(f.task.id),{code});
 if(entry==='model')await assert.rejects(f.a.call('execute','test',{test:true}),{code});
 assert.equal(calls,0);assert.equal(stable(f),before,'no new artifact, request or budget reservation');
});
function extraInputs(f){
 const source=f.source('task',{taskId:123,title:'辅助说明'},{taskId:123});
 const analysis={id:'prior-analysis',taskId:f.task.id,stepId:'prior-analysis-step',title:'核对记录',content:'已检查实际输入',createdAt:new Date().toISOString()};
 f.a.data.artifacts.push(analysis);require('../desktop/protocol-access.cjs').retain(f.a,'artifact',analysis,{task:f.task});
 f.task.steps.unshift({id:analysis.stepId,key:'analysis',title:analysis.title,kind:'analysis',done:true,artifactId:analysis.id,evidence:'observed'});
 return {source,analysis};
}
function changePermission(f,tool,args,operation='local_read'){
 const store=require('../desktop/access-policy-store.cjs'),request=store.requestsForTool(f.a,f.job,tool,args,{taskId:f.task.id}).find(r=>r.operation===operation);
 store.revoke(f.a,{principalScope:request.principalScope,resourceScope:request.resourceScope,operations:[request.operation]},{trusted:true,actor:'user_command',command:'revoke'});
}
for(const cold of [false,true])for(const change of ['auxiliary','analysis','model-grant','source-grant','primary-grant','related-regrant'])test(`C3/C5 retained ${cold?'cold':'warm'} rejects ${change}`,async t=>{
 const f=setup(t),extra=extraInputs(f);begin(f);const step=f.task.steps.find(s=>s.id===f.artifact.stepId);consume.retain(f.a,f.job,f.task,step,validResult(f));
 const candidate=structuredClone(consume.active(f.task).candidate),original=consume.active(f.task).originalInputBasis.hash;
 if(change==='auxiliary')extra.source.content+='\n输入修正';
 if(change==='analysis')extra.analysis.content+='\n分析结论修正';
 if(change==='model-grant')changePermission(f,'model_request',{},'model_request');
 if(change==='source-grant')changePermission(f,'read_source',{sourceId:extra.source.id});
 if(change==='primary-grant')changePermission(f,'read_artifact',{artifactId:f.artifact.id});
 if(change==='related-regrant'){const store=require('../desktop/access-policy-store.cjs'),r=store.requestsForTool(f.a,f.job,'read_artifact',{artifactId:f.artifact.id},{taskId:f.task.id})[0];store.grant(f.a,{principalScope:r.principalScope,resourceScope:r.resourceScope,operations:[r.operation]},{trusted:true,actor:'user_command',command:'refresh'});}
 f.a.save();let a=f.a,task=f.task,job=f.job;
 if(cold){a=new (require('../desktop/core.cjs').Assistant)({dir:f.dir,chat:()=>assert.fail('no model'),connectorRequest:()=>assert.fail('no connector')});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));task=a.task(task.id);job=a.data.delegations.find(j=>j.id===job.id);}
 await assert.rejects(a.advance(task.id),{code:'EVIDENCE_CONSUMPTION_STALE'});
 assert.equal(task.primaryArtifactId,f.artifact.id);assert.equal(task.evidenceConsumption.receipts.length,0);assert.deepEqual(consume.active(task).candidate,candidate);assert.equal(consume.active(task).originalInputBasis.hash,original);assert.equal((a.data.modelCalls||[]).length,0);
});
for(const status of ['pending','claimed','interrupted','unknown'])test('C4 stale '+status+' check blocks before consumption attempt or model',async t=>{
 const f=setup(t),e=cc.episode(f.a,f.job,f.task);e.pendingCheck={status,taskId:f.task.id,ownerEpisodeId:'old-episode',inputBasis:'old-input',checkBasis:'old-basis',claimId:status==='pending'?null:'original-check',claimedByRunId:status==='pending'?null:'old-run'};
 const before=structuredClone(e.pendingCheck);let calls=0;f.a.chat=async()=>{calls++;throw Error('forbidden')};
 assert.equal(consume.inspect(f.a,f.job,f.task).reason,'CHECK_REQUEST_UNRESOLVED');assert.equal(policy.prepare(f.a,f.job).eligible,false);assert.equal(f.task.evidenceConsumption,undefined);
 await assert.rejects(agent.act(f.a,f.job,'advance_task',{taskId:f.task.id}),{code:'CHECK_REQUEST_UNRESOLVED'});assert.equal(calls,0);assert.deepEqual(e.pendingCheck,before);
});
for(const status of ['prepared','result_retained'])test('C5 unrelated ACL does not invalidate '+status,async t=>{
 const f=setup(t);if(status==='prepared')prepare(f);else{begin(f);consume.retain(f.a,f.job,f.task,f.task.steps[0],validResult(f));}
 const store=require('../desktop/access-policy-store.cjs'),spec={principalScope:store.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:unrelated',jobId:'unrelated-job',taskId:'unrelated-task'},operations:['local_read']};
 store.grant(f.a,spec,{trusted:true,actor:'user_command',command:'unrelated'});store.revoke(f.a,spec,{trusted:true,actor:'user_command',command:'unrelated'});
 assert.equal(consume.current(f.a,f.job,f.task,consume.active(f.task)),true);consume.assertAdvance(f.a,f.job,f.task);
 if(status==='result_retained'){const original=structuredClone(consume.active(f.task).originalGenerationSnapshot),input=consume.active(f.task).originalInputBasis.hash;await f.a.advance(f.task.id);const artifact=require('../desktop/deliverables.cjs').primary(f.a,f.task);assert.deepEqual(artifact.generationSnapshot,original);assert.equal(f.task.evidenceConsumption.receipts[0].originalInputHash,input);assert.equal((f.a.data.modelCalls||[]).length,0);}
});
test('C2 genuine unreported model failure retains original ticket across cold direct continuation',async t=>{
 const f=setup(t);prepare(f);requestRun(f);f.a.data.agentRuns.unshift(f.a.activeAgentRun);let calls=0;
 f.a.chat=async()=>{calls++;throw Object.assign(Error('controlled timeout'),{code:'MODEL_TIMEOUT'})};
 await f.a.advance(f.task.id).catch(()=>{});assert.equal(calls,1);const p=consume.active(f.task);assert.equal(p.status,'unknown');assert.equal(p.requests.length,1);assert.ok(p.requests[0].requestId);assert.ok(p.requests[0].spendTicketId);assert.equal(p.requests[0].usageReported,false);
 f.a.save();const original=structuredClone(p),ledger=structuredClone(f.a.spendLedger);
 const a=new (require('../desktop/core.cjs').Assistant)({dir:f.dir,chat:()=>assert.fail('must not redispatch')});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));const task=a.task(f.task.id);
 await assert.rejects(a.advance(task.id),{code:'EVIDENCE_GENERATION_UNRESOLVED'});assert.deepEqual(consume.active(task),original);assert.deepEqual(a.spendLedger,ledger);
});
for(const field of ['originalInputBasis','originalGenerationSnapshot'])test('retained draft with missing '+field+' has no resumable proof',async t=>{
 const f=setup(t);begin(f);consume.retain(f.a,f.job,f.task,f.task.steps[0],validResult(f));delete consume.active(f.task)[field];f.a.save();
 await assert.rejects(f.a.advance(f.task.id),{code:'EVIDENCE_CONSUMPTION_STALE'});assert.equal(f.task.evidenceConsumption.receipts.length,0);assert.equal(f.task.primaryArtifactId,f.artifact.id);
});
test('C1 failed draft hands off to a different executable typed gap without replenishing its generation',t=>{
 const f=setup(t,{roots:['123','456'],kinds:'SQL读写和物理表血缘'});begin(f);consume.failed(f.a,f.task,{code:'EVIDENCE_NOT_INTEGRATED'});const attempt=structuredClone(consume.active(f.task));
 const e=cc.episode(f.a,f.job,f.task);assert.equal(require('../desktop/evidence-recovery.cjs').hasWork(f.a,f.job,f.task,e),true);
 const p=cc.peek(f.a,f.job,f.task);assert.equal(p.route,'evidence');assert.equal(p.action.tool,'platform_query');assert.deepEqual(consume.active(f.task),attempt);assert.equal((f.a.data.modelCalls||[]).length,0);
 assert.throws(()=>consume.assertAdvance(f.a,f.job,f.task),{code:'EVIDENCE_CONSUMPTION_FAILED'});
});
test('C5 denied original draft cannot queue or repeatedly prepare consumption',t=>{
 const f=setup(t);changePermission(f,'read_artifact',{artifactId:f.artifact.id});f.a.save();const before=JSON.stringify(f.task.steps),journal=JSON.stringify(require('../desktop/work-journal.cjs').read(f.a));
 for(let i=0;i<2;i++){assert.equal(consume.inspect(f.a,f.job,f.task).reason,'CONTEXT_SCOPE_DENIED');assert.equal(policy.prepare(f.a,f.job).eligible,false);}
 assert.equal(f.task.evidenceConsumption,undefined);assert.equal(JSON.stringify(f.task.steps),before);assert.equal(JSON.stringify(require('../desktop/work-journal.cjs').read(f.a)),journal);
});
