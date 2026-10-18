'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../../desktop/core.cjs'),agent=require('../../desktop/agent.cjs'),pending=require('../../desktop/pending-check.cjs'),cont=require('../../desktop/continuation-control.cjs');
const work=require('../../desktop/work-efficiency.cjs'),hash=require('../../desktop/evidence-basis.cjs').hash;
const deny=()=>{throw Error('No external calls in pending-check tests');};
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'system-pending-'));
 const a=new Assistant({dir,chat:deny,platformRequest:deny,connectorRequest:deny,webRequest:deny});
 t.after(()=>{require('../../desktop/access.cjs').cancel(a);require('../../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 a.data.providers.push({id:'fixture',name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});a.data.settings.roles={organize:'fixture',execute:'fixture',verify:'fixture'};
 a.data.modelCalls ||= [];
 const j=agent.buildJob(a,{goal:'记录已知事实并更新原文档',autoAccept:false});a.data.delegations.push(j);
 const task=a.createTask({title:'报告',criteria:'保留已有事实',steps:[{title:'正文',kind:'draft',outputRole:'primary'},{title:'交付',kind:'external',tool:'lark_update'}]});task.agentJobId=j.id;j.taskIds=[task.id];
 const source=agent.source(a,j,'known','资料','已核实：周五发布');task.sourceIds=[source.id];require('../../desktop/protocol-access.cjs').retain(a,'source',source,{task,job:j});
 work.before(a,j);Object.assign(j.executionState.workEfficiency,{attempts:18,phase:'recovery_pending',lastFailure:{code:'NO_NEW_EVIDENCE',message:'old'},tried:{old:{at:'2026-01-01'}},history:[]});
 const basis=cont.basis(a,j,task),intent=hash({contract:j.goal,requirements:null}),e={taskId:task.id,basis,intentBasis:intent,cycles:1,hops:2,revisionPending:true,executions:4};j.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:basis,episodes:{[basis]:e}};
 const run={id:'run',jobId:j.id,status:'running',startedAt:'2026-01-01T00:00:00.000Z',steps:[{tool:'advance_task',args:{taskId:task.id},at:'2026-01-01T00:00:01.000Z',continuation:{handled:true,tracked:true,kind:'execution',basis}}]};a.data.agentRuns.unshift(run);a.activeAgentRun=run;a.activeAgentJob=j;a.automaticExecution=true;
 const step=task.steps[0],generationSnapshot=require('../../desktop/revision-protocol.cjs').snapshot(a,task),artifact={id:'draft',taskId:task.id,stepId:step.id,title:'正文',content:'已核实：周五发布',createdAt:'2026-01-01T00:00:02.000Z',generationSnapshot};
 a.data.artifacts.push(artifact);require('../../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task,job:j});step.done=true;step.artifactId=artifact.id;require('../../desktop/deliverables.cjs').record(a,task,step,artifact);require('../../desktop/step-evidence.cjs').record(a,task,step);pending.recordGenerated(a,j,task,step,artifact);a.save();
 return {a,j,task,step,artifact,run,e,source,dir};
}
function recordCall(f,{id='call',at='2026-01-01T00:00:04.000Z',status='done'}={}){const c={id,runId:f.run.id,taskId:f.task.id,at,status,requestId:'request-'+id,usageReported:status==='done',inputTokens:100,outputTokens:10,cachedInputTokens:0,cacheWriteTokens:0,totalTokens:110,estimatedUSD:0};f.a.data.modelCalls.push(c);f.run.modelCallsDetail ||= [];f.run.modelCallsDetail.push(structuredClone(c));f.run.modelCalls=f.run.modelCallsDetail.length;return c;}

module.exports={fixture,recordCall};
