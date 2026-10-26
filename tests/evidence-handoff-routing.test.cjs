'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),tool=require('../desktop/tool-evidence.cjs'),request=require('../desktop/evidence-request.cjs');
const root=path.resolve(__dirname,'..'),fixtures=require('../scripts/readiness/fixtures.cjs');
async function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'evidence-handoff-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',{name:'offline',model:'offline',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 a.addSources([{title:'已知记录',content:'2 kg 与 3 kg。'}]);
 const task=a.createTask({title:'只读核对',description:'读取旧文件和新检查记录，不创建新文件。',criteria:'按真实观察形成说明',sourceIds:[a.data.sources[0].id],generationMode:'single',steps:[{title:'说明',kind:'draft'}]});
 const ids=await fixtures.install(a,task,{fixture:{existingAction:{fileName:'existing.txt',title:'历史记录',content:'旧稿，仅供比较。'},inputFiles:[{fileName:'inspection.txt',content:'现场记录：未寄送。'}]}},root);
 const job=a.data.delegations[0],action=a.data.agentActions.find(r=>r.id===ids.__EXISTING_ACTION_ID__);
 const need=()=>{task.evidenceRequest=request.normalize(a,task,{kind:'needs_evidence',summary:'核对原文件和现场记录',gaps:['尚无本次观察']},require('../desktop/grounding.cjs').snapshot(a,task).basis);a.save();return task.evidenceRequest;};
 return {a,task,job,action,need,read:()=>agent.act(a,job,'read_local_result',{taskId:task.id,actionId:action.id}),file:()=>agent.act(a,job,'read_file',{folderId:'evaluation-input',name:'inspection.txt'})};
}
test('historical file routes through read-only scope without a new delivery obligation',async t=>{
 const f=await setup(t),before=fs.statSync(f.action.target).mtimeMs,r=await f.read();
 assert.equal(f.job.fileMode,'off');assert.equal(f.task.steps.length,1);assert.ok(!require('../desktop/deliverables.cjs').current(f.a,f.task).length);
 assert.equal(r.computedEvidence.output.status,'readback_verified');assert.equal(r.computedEvidence.output.deliveryCurrent,false);assert.match(r.computedEvidence.output.note,/不证明当前主稿已交付/);
 assert.equal(fs.statSync(f.action.target).mtimeMs,before);assert.equal(f.a.data.agentActions.length,1);
 await assert.rejects(agent.act(f.a,f.job,'read_local_result',{taskId:f.task.id,actionId:f.action.id,filename:'exist.txt'}),/文件/);
 await assert.rejects(agent.act(f.a,f.job,'read_local_result',{taskId:f.task.id,actionId:f.action.id,start:1}),/完整比较/);
 assert.throws(()=>require('../desktop/agent-writes.cjs').readRecordedFile(f.a,f.job,f.task,f.action),/授权/);
 f.job.folderIds=[];await assert.rejects(f.read(),/授权/);
});
test('repeated file reads return a reference while changed content is supplied again',async t=>{
 const f=await setup(t);f.need();const first=await f.file(),second=await f.file();
 assert.match(first.content,/未寄送/);assert.equal(second.sourceId,first.sourceId);assert.equal(second.reused,true);assert.equal(second.content,undefined);assert.equal(second.nextActions[0].args.basis,f.task.evidenceRequest.basis);
 fs.writeFileSync(path.join(f.a.dir,'inspection.txt'),'现场记录：封存完成，尚未寄送。');const third=await f.file();assert.notEqual(third.sourceId,first.sourceId);assert.match(third.content,/封存完成/);assert.equal(third.reused,undefined);
 f.job.folderIds=[];await assert.rejects(f.file());
});
test('new sources and explicit tool observations resume the same task durably; stale proofs do not',async t=>{
 const f=await setup(t),old=await f.read();f.need();
 const args={taskId:f.task.id,basis:f.task.evidenceRequest.basis,toolEvidenceIds:[old.computedEvidence.id],reason:'核对真实文件'};
 const before=JSON.stringify(f.task);await assert.rejects(agent.act(f.a,f.job,'resume_evidence',args),/本轮/);assert.equal(JSON.stringify(f.task),before);
 const observed=await f.read(),source=await f.file();assert.equal(observed.computedEvidence.id,old.computedEvidence.id);
 await assert.rejects(agent.act(f.a,f.job,'resume_evidence',{...args,basis:'outdated'}),/basis/);
 await agent.act(f.a,f.job,'resume_evidence',{...args,sourceIds:[source.sourceId]});
 assert.equal(f.task.evidenceRequest,undefined);assert.equal(f.task.steps.length,1);assert.equal(f.task.steps[0].done,false);assert.equal(f.task.lastEvidenceResolution.toolProofs.length,1);assert.ok(f.task.sourceIds.includes(source.sourceId));
 const reopened=new Assistant({dir:f.a.dir}),saved=reopened.task(f.task.id);assert.equal(saved.evidenceRequest,undefined);assert.deepEqual(saved.lastEvidenceResolution,f.task.lastEvidenceResolution);assert.equal(saved.toolExecutions.length,2);
});
test('paused tasks, withdrawn artifacts and cross-task actions cannot create observations or resume',async t=>{
 const f=await setup(t);f.need();f.task.status='paused';await assert.rejects(f.read(),/暂停/);await assert.rejects(agent.act(f.a,f.job,'resume_evidence',{taskId:f.task.id,basis:f.task.evidenceRequest.basis,reason:'恢复'}),/暂停/);assert.equal(f.task.toolExecutions,undefined);
 f.task.status='todo';f.a.data.artifacts[0].deleted=true;await assert.rejects(f.read(),/可读/);f.a.data.artifacts[0].deleted=false;
 f.action.taskId='other';await assert.rejects(f.read(),/不属于/);assert.equal(f.task.toolExecutions,undefined);
});

test('historical observations reject withdrawn and conflicting canonical ownership before reading files',async t=>{
 const f=await setup(t),artifact=f.a.data.artifacts.find(r=>r.id===f.action.artifactId);
 for(const metadata of [{withdrawn:true},{state:'withdrawn'},{projectId:'another-project'},{jobId:'another-job'},{agentJobId:'another-job'}]){
  Object.assign(artifact,metadata);
  await assert.rejects(f.read(),/可读/);
  for(const key of Object.keys(metadata))delete artifact[key];
  assert.equal(f.task.toolExecutions,undefined);
 }
 f.a.data.tasks.push({...f.task});await assert.rejects(f.read(),/可读/);f.a.data.tasks.pop();
 assert.equal((await f.read()).computedEvidence.output.status,'readback_verified');
});

test('resume replays a committed response once across restart and cannot consume a later request',async t=>{
 const f=await setup(t);f.need();const observed=await f.read(),source=await f.file();
 const args={taskId:f.task.id,basis:f.task.evidenceRequest.basis,sourceIds:[source.sourceId],toolEvidenceIds:[observed.computedEvidence.id],reason:'绑定本轮材料'};
 const first=await agent.act(f.a,f.job,'resume_evidence',args),before=JSON.stringify(f.task);
 assert.deepEqual(await agent.act(f.a,f.job,'resume_evidence',args),first);assert.equal(JSON.stringify(f.task),before);
 const a=new Assistant({dir:f.a.dir}),job=a.data.delegations.find(j=>j.id===f.job.id),task=a.task(f.task.id),version=task.planVersion;
 assert.deepEqual(await agent.act(a,job,'resume_evidence',args),first);assert.equal(task.planVersion,version);
 assert.equal(require('../desktop/work-journal.cjs').read(a).events.filter(e=>e.type==='evidence_plan_committed').length,1);
 await assert.rejects(agent.act(a,job,'resume_evidence',{...args,reason:'different command'}),/当前补证/);
 task.evidenceRequest=request.normalize(a,task,{kind:'needs_evidence',summary:'新缺口',gaps:['再次实际观察']},args.basis);
 const current=JSON.stringify(task);await assert.rejects(agent.act(a,job,'resume_evidence',args),/本轮/);assert.equal(JSON.stringify(task),current);
 await agent.act(a,job,'read_local_result',{taskId:task.id,actionId:f.action.id});
 const next=await agent.act(a,job,'resume_evidence',args);assert.notEqual(next.commitId,first.commitId);assert.equal(task.evidenceRequest,undefined);
});

test('a persisted legacy request gets a stable replay identity without manufacturing a replacement request',async t=>{
 const f=await setup(t);f.need();delete f.task.evidenceRequest.id;const legacy=structuredClone(f.task.evidenceRequest);
 const source=await f.file(),args={taskId:f.task.id,basis:legacy.basis,sourceIds:[source.sourceId],reason:'绑定新材料'};
 const original=await agent.act(f.a,f.job,'resume_evidence',args);assert.equal(f.task.lastEvidenceResolution.requestId,request.identity(legacy));
 assert.deepEqual(await agent.act(f.a,f.job,'resume_evidence',args),original);assert.equal(f.task.evidenceRequest,undefined);
});
test('actual planner handoff reads, resumes, regenerates and checks task plus whole job',async t=>{
 const f=await setup(t);let workers=0,planner=0,checks=0,goals=0;
 // Model transport is mocked; every transition, tool and acceptance gate is real.
 // Strict grounding remains enabled throughout the real routing path.
 f.a.chat=async(p,k,m,o)=>{
  o.onUsage?.({inputTokens:10,outputTokens:5});
  if(o.stage==='goal_verify'){goals++;return {passed:true,summary:'实际观察已完成',gaps:[]};}
  if(o.role==='verify'){
   checks++;const ground=require('../desktop/grounding.cjs'),draft=require('../desktop/deliverables.cjs').primary(f.a,f.task),source=f.a.data.sources.find(r=>r.content==='现场记录：未寄送。'),receipt=tool.current(f.a,f.task)[0];
   return {passed:true,summary:'说明符合观察',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],requirements:ground.requirements(f.a,f.task).map(r=>({id:r.id,status:'satisfied',claimIds:['c1','c2']})),claims:[{id:'c1',artifactId:draft.id,text:'历史文件与记录一致。',kind:'fact',supported:true,citationIds:['e1']},{id:'c2',artifactId:draft.id,text:'现场记录：未寄送。',kind:'fact',supported:true,citationIds:['e2']}],citations:[{id:'e1',sourceId:receipt.id,quote:receipt.resultText},{id:'e2',sourceId:source.id,quote:source.content}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
  }
  if(m[0].content.includes('动作格式')){
   planner++;if(planner===1)return {tool:'read_local_result',args:{taskId:f.task.id,actionId:f.action.id}};
   if(planner===2)return {tool:'read_file',args:{folderId:'evaluation-input',name:'inspection.txt'}};
   if(planner===3)return {tool:'resume_evidence',args:{taskId:f.task.id,basis:f.task.evidenceRequest.basis,sourceIds:[f.job.sourceIds.at(-1)],toolEvidenceIds:[f.task.toolEvidence.at(-1).id],reason:'将本轮观察交回核对'}};
   if(planner===4)return {tool:'advance_task',args:{taskId:f.task.id}};
   throw Error('Unexpected extra planner call '+planner);
  }
  workers++;if(workers===1)return {kind:'needs_evidence',summary:'须核对旧稿和新检查记录',gaps:['缺本次回读和检查记录']};
  assert.match(JSON.stringify(m),/现场记录：未寄送/);assert.match(JSON.stringify(m),/readback_verified/);
  return {kind:'artifact',title:'只读核对',content:'历史文件与记录一致。现场记录：未寄送。'};
 };
 const result=await require('../scripts/readiness/lifecycle.cjs').advance(f.a,f.task,root);
 assert.ok(result.completionChecked,JSON.stringify({result,error:f.task.lastError,runs:f.a.data.agentRuns.map(r=>({steps:r.steps.map(s=>({tool:s.tool,error:s.error,result:s.tool==='advance_task'?s.result:undefined})),error:r.error})),verification:f.task.verification}));assert.equal(f.task.evidenceRequest,undefined);assert.equal(workers,2);assert.equal(planner,4);assert.equal(checks,1);assert.equal(goals,1);
 await f.a.dispatch('taskAction',{id:f.task.id,command:'accept'});assert.equal(f.task.status,'completed');assert.equal(f.job.status,'completed');assert.equal(f.a.data.agentActions.length,1);
});
