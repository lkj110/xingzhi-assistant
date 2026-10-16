const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),revision=require('../desktop/revision-protocol.cjs');
async function setup(t,{external=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-scoped-repair-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir});
 await a.dispatch('saveProvider',{name:'test',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:0,outputPrice:0});
 const j=agent.buildJob(a,{goal:'交接应精简，正文交付飞书，内部核验不作为正文',autoAccept:false,maxActions:1});a.data.delegations.push(j);
 const {taskId}=await agent.act(a,j,'plan_task',{key:'handoff',title:'交接',criteria:'保留事实和权限边界',steps:[{key:'audit',title:'独立核验说明',kind:'analysis'},{key:'body',title:'交接正文',kind:'draft'},...(external?[{key:'publish',title:'飞书',kind:'external',tool:'lark_update'}]:[]),{key:'report',title:'补查报告',kind:'analysis'}]});
 const task=a.task(taskId);task.generationMode='single';
 for(const [i,s] of task.steps.entries()){s.done=true;if(s.kind==='external'){s.evidence='action-publication';continue;}s.artifactId='artifact-'+i;a.data.artifacts.push({id:s.artifactId,taskId,stepId:s.id,title:s.title,content:'保留事实。'+s.title,createdAt:'2026-01-01T00:00:00Z'});require('../desktop/protocol-access.cjs').retain(a,'artifact',a.data.artifacts.at(-1),{task});require('../desktop/step-evidence.cjs').record(a,task,s);}
 if(external)a.data.agentActions.push({id:'action-publication',jobId:j.id,taskId,artifactId:task.steps[1].artifactId,tool:'lark_update',status:'done',result:{url:'https://example.invalid/doc',revision:26,verified:true,contentVerified:false}});
 return {a,j,task};
}
test('supporting revision changes only its artifact; draft, publication and other report survive restart',async t=>{
 const {a,j,task}=await setup(t),before=structuredClone(task.steps),receipts=structuredClone(a.data.agentActions);
 const result=await agent.act(a,j,'revise_task',{taskId:task.id,artifactId:before[0].artifactId,note:'说明按 revision 26 核对，不要自称已核实全文'});
 assert.deepEqual(result.affectedStepIds,[before[0].id]);assert.deepEqual(task.steps.slice(1),before.slice(1));assert.deepEqual(a.data.agentActions,receipts);
 assert.equal(task.notes.at(-1).targetArtifactId,before[0].artifactId);assert.equal(revision.source(a,task,task.steps[1]),null);
 a.save();const b=new Assistant({dir:a.dir}),restored=b.task(task.id);assert.equal(revision.source(b,restored,restored.steps[0]).artifact.id,before[0].artifactId);assert.deepEqual(restored.steps.slice(1),before.slice(1));
});
test('main revision invalidates its bound delivery but retains independent reports',async t=>{
 const {a,j,task}=await setup(t),before=structuredClone(task.steps);
 await agent.act(a,j,'revise_task',{taskId:task.id,artifactId:before[1].artifactId,note:'精简正文'});
 assert.deepEqual(task.steps.map(s=>s.done),[true,false,false,true]);assert.deepEqual(task.steps[3],before[3]);assert.equal(revision.source(a,task,task.steps[1]).artifact.id,before[1].artifactId);
});
test('gap target routes a supporting artifact and never falls back to main for ambiguous multi-artifact gaps',async t=>{
 const {a,j,task}=await setup(t);task.contentVerification={passed:false,gaps:['辅助说明未核对'],gapDetails:[{text:'辅助说明未核对',artifactId:task.steps[0].artifactId,stepId:task.steps[0].id}]};
 assert.equal(revision.target(a,task,task.contentVerification).id,task.steps[0].artifactId);
 const before=structuredClone(task.steps);task.contentVerification.gapDetails=[];
 await assert.rejects(agent.act(a,j,'revise_task',{taskId:task.id,note:'修正检查'}),e=>e.code==='REVISION_TARGET_REQUIRED');assert.deepEqual(task.steps,before);
 task.contentVerification.gapDetails=[{artifactId:before[0].artifactId}];
 await agent.act(a,j,'revise_task',{taskId:task.id,note:'修正检查'});assert.equal(task.steps[0].done,false);assert.deepEqual(task.steps.slice(1),before.slice(1));
});
test('fixed snapshots distinguish version changes, ignore cosmetic status and cannot be mutated by later receipts',async t=>{
 const {a,j,task}=await setup(t),snap=revision.snapshot(a,task),saved=JSON.stringify(snap);
 task.status='running';task.steps[0].title='新标题';assert.equal(revision.snapshot(a,task).id,snap.id);
 a.data.agentActions[0].result.revision=27;assert.notEqual(revision.snapshot(a,task).id,snap.id);assert.equal(JSON.stringify(snap),saved);
});
test('legacy explicit repair binds only the saved target and is consumed by its replacement',async t=>{
 const {a,j,task}=await setup(t),artifactId=task.steps[0].artifactId,note={kind:'revise',at:'2026-02-01T00:00:00Z',text:'修正辅助说明'};
 task.notes.push(note);a.data.agentRuns.push({jobId:j.id,steps:[{tool:'revise_task',args:{taskId:task.id,artifactId,note:note.text}}]});task.steps.forEach(s=>{s.done=false;delete s.artifactId;});
 assert.equal(revision.source(a,task,task.steps[0]).artifact.id,artifactId);assert.equal(revision.source(a,task,task.steps[1]),null);
 a.data.artifacts.push({id:'replacement',taskId:task.id,stepId:task.steps[0].id,content:'修正',createdAt:'2026-02-01T00:00:01Z'});assert.equal(revision.source(a,task,task.steps[0]),null);
});
test('repair completes supporting report and rechecks retained main without regenerating or publishing it',async t=>{
 const {a,j,task}=await setup(t,{external:false}),before=structuredClone(task.steps),originals=a.data.artifacts.length;let work=0,checks=0;
 await agent.act(a,j,'revise_task',{taskId:task.id,artifactId:before[0].artifactId,note:'只修核验说明'});
 a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:10,outputTokens:5});const c=JSON.parse(m[1].content);if(o.stage==='task_work'){work++;assert.equal(c.revision.artifactId,before[0].artifactId);assert.ok(c.workSnapshot.id);return {kind:'patch',edits:[{before:'保留事实。',after:'事实边界保留。'}]};}checks++;assert.ok(c.verificationSnapshot.id);return {passed:true,summary:'修订说明与保留正文一致',gaps:[]};};
 await agent.act(a,j,'advance_task',{taskId:task.id});assert.equal(task.status,'review');assert.equal(work,1);assert.equal(checks,1);assert.equal(a.data.artifacts.length,originals+1);assert.equal(task.steps[1].artifactId,before[1].artifactId);assert.equal(task.steps[2].artifactId,before[2].artifactId);assert.ok(task.verification.snapshot.id);
});
test('unknown foreign target cannot alter this task, and uncertain writes prevent revision',async t=>{
 const {a,j,task}=await setup(t),before=structuredClone(task.steps);
 await assert.rejects(agent.act(a,j,'revise_task',{taskId:task.id,artifactId:'foreign',note:'修订'}));assert.deepEqual(task.steps,before);
 a.data.agentActions[0].status='uncertain';await assert.rejects(agent.act(a,j,'revise_task',{taskId:task.id,artifactId:before[0].artifactId,note:'修订'}),/核对/);assert.deepEqual(task.steps,before);
});
test('stale supporting gap cannot retarget a replacement or the only remaining main draft',async t=>{
 const {a,task}=await setup(t),old=task.steps[0].artifactId;
 const check={gaps:['修正辅助说明'],gapDetails:[{artifactId:old,stepId:task.steps[0].id}],snapshot:revision.snapshot(a,task)};
 task.steps[0].done=false;delete task.steps[0].artifactId;assert.equal(revision.target(a,task,check),null);
 delete check.snapshot;assert.equal(revision.target(a,task,check),null);
 check.gapDetails=[{sourceIds:[old]}];task.steps[3].done=false;assert.equal(revision.target(a,task,check),null);
});
test('delivery context never promotes a historical readback after same-ID body replacement',async t=>{
 const {a,task}=await setup(t),record=a.data.agentActions[0],artifact=a.data.artifacts.find(r=>r.id===record.artifactId);
 record.content=artifact.content;record.result.sourceId='readback';a.data.sources.push({id:'readback',title:'旧回读',content:'旧正文'});
 const protocol={readableCatalog:[],historyCatalog:[{id:'readback',state:'historical',version:'old-version',delivery:{artifactId:artifact.id,savedArtifactMatchesSubmission:false}}]};
 artifact.content='替换正文';const c=revision.deliveryContext(a,task,record,protocol);assert.equal(c.current,false);assert.equal(c.readback.current,false);assert.equal(c.readback.state,'historical');assert.equal(c.readback.version,'old-version');
});
