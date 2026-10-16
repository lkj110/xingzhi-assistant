const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs'),contracts=require('../desktop/execution-contract.cjs'),guard=require('../desktop/repair-progress.cjs');
async function setup(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-continuity-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir});await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const j=agent.buildJob(a,{goal:'全站扫描旧范围',fileMode:'auto'});a.data.delegations.push(j);j.outputFolder=path.join(dir,'output');fs.mkdirSync(j.outputFolder);require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{trusted:true,actor:'user_command',command:'fixture_output_scope'});
 const args={key:'handover',title:'交接',criteria:'六入口范围',steps:[{key:'draft',kind:'draft',title:'主稿'},{key:'report',kind:'analysis',title:'辅助核对报告'}]};
 const {taskId}=await agent.act(a,j,'plan_task',args),task=a.task(taskId);
 for(const [index,step] of task.steps.entries()){const r={id:(index?'22222222':'11111111')+'-artifact',taskId,stepId:step.id,title:step.title,content:index?'检查报告':'主稿正文'};a.data.artifacts.push(r);step.done=true;step.artifactId=r.id;}
 a.save();return {a,j,task,args,dir};
}
test('Current scope persists through long feedback history, restart and all model contexts; only user dispatch can set it',async t=>{
 const f=await setup(t);f.j.status='paused';await f.a.dispatch('agentContract',{id:f.j.id,text:'仅六入口上下游，保留已接受的权限缺口'});
 const revision=f.j.executionContract.revision;assert.equal(f.j.status,'paused');assert.ok(f.task.needsReplan);
 for(let i=0;i<40;i++){f.j.feedback.push({at:new Date(Date.now()+i+100).toISOString(),text:'后续要求 '+i});f.j.feedback=f.j.feedback.slice(-30);f.a.save();}
 const a=new Assistant({dir:f.dir}),j=a.data.delegations[0];assert.equal(j.userDirectives.length,40);
 for(const c of [agent.context(a,j),agent.context(a,j,{full:true}),a.context(a.task(f.task.id)).delegation]){assert.equal(c.goal,'仅六入口上下游，保留已接受的权限缺口');assert.equal(c.executionContract.revision,revision);assert.equal(c.userDirectives.length,40);assert.doesNotMatch(c.goal,/全站/);}
 await assert.rejects(a.dispatch('agentContract',{id:j.id,text:'错误旧页面',revision:'stale'}),/已变化/);
 await assert.rejects(agent.act(a,j,'agentContract',{text:'模型扩大范围'}),/不可用/);
});
test('Replanning with an empty list preserves evidence; explicit reasoned removal stays available',async t=>{
 const f=await setup(t);const s=agent.source(f.a,f.j,'fixture','事实','内容');f.task.sourceIds=[s.id];
 await agent.act(f.a,f.j,'plan_task',{...f.args,sourceIds:[],reason:'仅调整文案'});assert.deepEqual(f.task.sourceIds,[s.id]);
 await agent.act(f.a,f.j,'plan_task',{...f.args,sourceIds:[],removeSourceIds:[s.id],reason:'用户撤回此事实'});assert.deepEqual(f.task.sourceIds,[]);
});
test('Upgrade restores lost current evidence once, follows versions and respects project and acceptance boundaries',async t=>{
 const f=await setup(t),old=agent.source(f.a,f.j,'fixture','旧事实','旧'),next=agent.source(f.a,f.j,'fixture','新事实','新');
 assert.equal(next.previousSourceId,old.id);f.task.planHistory=[{sourceIds:[old.id]}];delete f.task.evidenceLinksVersion;f.a.save();
 const a=new Assistant({dir:f.dir}),task=a.task(f.task.id);assert.deepEqual(task.sourceIds,[next.id]);assert.ok(task.needsReplan);
 require('../desktop/evidence-links.cjs').setInputs(a,task,[]);a.save();const b=new Assistant({dir:f.dir});assert.deepEqual(b.task(task.id).sourceIds,[]);
});
test('Default export and revision target draft, never a later check report; supporting export requires distinct filename',async t=>{
 const f=await setup(t);const main=await writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,filename:'交接.md'});assert.equal(main.artifactId,'11111111-artifact');await writes.execute(f.a,f.j,main);
 await assert.rejects(writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,artifactId:'22222222-artifact'}),/独立文件名/);
 await assert.rejects(writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,artifactId:'22222222-artifact',filename:'交接.md'}),/不能覆盖/);
 const report=await writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,artifactId:'22222222-artifact',filename:'核对.md'});await writes.execute(f.a,f.j,report);
 assert.equal(fs.readFileSync(main.result.latestPath,'utf8'),'主稿正文');assert.equal(require('../desktop/results.cjs').overview(f.a).groups[0].primaryId,'11111111-artifact');
 await writes.verifyDelivery(f.a,f.j,f.task);
 await agent.act(f.a,f.j,'revise_task',{taskId:f.task.id,note:'精简主稿'});assert.equal(f.task.steps[0].done,false);assert.equal(f.task.steps[1].done,true);assert.equal(f.task.steps[1].artifactId,'22222222-artifact');
});
test('Previously overwritten alias can be restored from saved main draft, while human edits stay protected',async t=>{
 const f=await setup(t),main=await writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,filename:'交接.md'});await writes.execute(f.a,f.j,main);
 const report=await writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,artifactId:'22222222-artifact',filename:'核对.md'});await writes.execute(f.a,f.j,report);
 // Simulate a receipt from the legacy exporter that wrongly used the main alias.
 report.latestName='交接.md';report.result.latestPath=main.result.latestPath;delete report.role;fs.writeFileSync(main.result.latestPath,report.content);
 const restore=await writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,filename:'交接.md'});assert.notEqual(restore.id,main.id);await writes.execute(f.a,f.j,restore);assert.equal(fs.readFileSync(main.result.latestPath,'utf8'),'主稿正文');
 fs.writeFileSync(main.result.latestPath,'人工改稿');await assert.rejects(writes.prepare(f.a,f.j,'write_file',{taskId:f.task.id,filename:'交接.md'}),/人工修改/);
});
test('Repeated semantic failures stop even as artifact IDs change; new evidence and resolved checks reset the defect',async t=>{
 const f=await setup(t);const step={tool:'complete',args:{},result:{complete:false,gaps:['当前主稿缺少飞书正文与链接回读证据']}};
 for(let i=0;i<3;i++){f.a.data.artifacts.push({id:crypto.randomUUID(),taskId:f.task.id,content:'另一份报告'+i});guard.check(f.a,f.j,step);}
 assert.throws(()=>guard.check(f.a,f.j,{...step,result:{complete:false,gaps:['仍缺少当前主稿的飞书正文与链接回读证据']}}),e=>e.noProgress===true);
 const s=agent.source(f.a,f.j,'readback','飞书回读','当前正文');f.task.sourceIds.push(s.id);step.result.gapDetails=[{requirementId:'goal',text:step.result.gaps[0],sourceIds:[s.id]}];guard.check(f.a,f.j,step);assert.equal(f.j.repairProgress.goal.gaps[0].count,1);
 guard.check(f.a,f.j,{...step,result:{awaitingReview:true}});assert.equal(f.j.repairProgress.goal,undefined);
});
test('Evidence migration never rewrites accepted work or tasks with an uncertain external action',async t=>{for(const mode of ['accepted','uncertain','archived']){const f=await setup(t);const s=agent.source(f.a,f.j,'fixture','事实','内容');f.task.planHistory=[{sourceIds:[s.id]}];delete f.task.evidenceLinksVersion;if(mode==='accepted'){f.task.status='completed';f.task.acceptedBy='user';}if(mode==='uncertain')f.a.data.agentActions.push({id:'unknown',jobId:f.j.id,taskId:f.task.id,tool:'lark_create',status:'uncertain'});if(mode==='archived'){f.j.projectId='archived';f.a.data.projects.push({id:'archived',archivedAt:new Date().toISOString()});}f.a.save();const b=new Assistant({dir:f.dir});assert.deepEqual(b.task(f.task.id).sourceIds,[]);}});
test('Explicit supporting revision keeps main draft, and scope changes invalidate a prior check cache',async t=>{const f=await setup(t);await agent.act(f.a,f.j,'revise_task',{taskId:f.task.id,artifactId:'22222222-artifact',note:'修正辅助说明'});assert.equal(f.task.steps[0].done,true);assert.equal(f.task.steps[1].done,false);const before=require('../desktop/verification-cache.cjs').basis(f.a,f.task);await f.a.dispatch('agentContract',{id:f.j.id,text:'以新范围核对'});assert.notEqual(require('../desktop/verification-cache.cjs').basis(f.a,f.task),before);});
