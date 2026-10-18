const {test}=require('node:test');
const assert=require('node:assert/strict');
const {overview}=require('../desktop/results.cjs');
const acceptance=require('../desktop/acceptance.cjs');
function setup(){return {data:{tasks:[],artifacts:[],delegations:[],sources:[],projects:[],agentActions:[],decisions:[]}};}
function ready(a,id='one'){
  const task={id,title:'交接事项 '+id,status:'review',steps:[{id:id+'-step',kind:'draft',done:true,artifactId:id+'-current'}],sourceIds:[],notes:[],criteria:'包含范围和出口',verification:{passed:true,summary:'可访问范围已核对，权限缺口保留，实际运行未验证。',gaps:[]}};
  a.data.tasks.push(task);a.data.artifacts.push({id:id+'-current',taskId:id,stepId:id+'-step',title:'完整修订版',content:'## 当前交接\n当前正文',createdAt:'2026-10-12T10:29:00Z'});return task;
}
test('One current document and six historical versions remain unambiguous, even with identical titles',()=>{
  const a=setup(),task=ready(a);for(let i=0;i<6;i++)a.data.artifacts.push({id:'old-'+i,taskId:task.id,stepId:task.steps[0].id,title:'完整修订版',content:'旧正文',createdAt:'2026-10-13T00:00:00Z'});
  task.verification.basis=acceptance.basis(a,task);
  const before=JSON.stringify(a.data),view=overview(a),g=view.groups[0];assert.equal(g.primaryId,'one-current');assert.equal(g.ready,true);assert.equal(g.current.length,1);assert.equal(g.history.length,6);assert.equal(view.counts.current,1);assert.equal(view.counts.history,6);assert.equal(g.verification.summary,task.verification.summary);assert.equal(JSON.stringify(a.data),before);assert.equal(view.modelCalls,0);assert.equal(view.networkRequests,0);
});
test('Revisions never promote the newest unreferenced draft or a failed step as the current result',()=>{
  const a=setup(),task=ready(a);task.steps[0].done=false;task.status='running';const g=overview(a).groups[0];assert.equal(g.primaryId,null);assert.equal(g.current.length,0);assert.equal(g.history.length,1);assert.equal(g.status,'running');assert.equal(g.ready,false);
});
test('Replan and cancellation keep previous documents in history',()=>{
  for(const change of [t=>t.needsReplan='来源更新',t=>t.agentCancelled=true]){const a=setup(),task=ready(a);change(task);const g=overview(a).groups[0];assert.equal(g.current.length,0);assert.equal(g.ready,false);assert.equal(g.history.length,1);}
});
test('Multiple current deliverables remain visible and prefer a verified current delivery',()=>{
  const a=setup(),task=ready(a);task.steps.push({id:'appendix',kind:'analysis',done:true,artifactId:'appendix'});a.data.artifacts.push({id:'appendix',stepId:'appendix',taskId:task.id,title:'附录',content:'附录'});a.data.agentActions.push({id:'write',taskId:task.id,tool:'write_file',status:'done',artifactId:'one-current',result:{verified:true,latestPath:'/delivery/current.md'}});
  const g=overview(a).groups[0];assert.equal(g.current.length,2);assert.equal(g.primaryId,'one-current');assert.equal(g.deliveries.length,1);assert.equal(g.history.length,0);
});
test('A historical delivery or a foreign job receipt cannot become the recommended file',()=>{
  const a=setup(),task=ready(a);task.agentJobId='job';a.data.delegations.push({id:'job',taskIds:[task.id],sourceIds:[],followups:[]});a.data.artifacts.push({id:'old',taskId:task.id,content:'old'});a.data.agentActions.push({id:'old-write',taskId:task.id,jobId:'job',tool:'write_file',status:'done',artifactId:'old',result:{verified:true,latestPath:'/newer-file'}},{id:'foreign',taskId:task.id,jobId:'other',tool:'write_file',status:'done',artifactId:'one-current',result:{verified:true}});
  const g=overview(a).groups[0];assert.equal(g.primaryId,'one-current');assert.equal(g.deliveries.length,0);
});
test('Missing, foreign, empty and mismatched artifacts never receive a current label',()=>{
  for(const change of [(a,t)=>t.steps[0].artifactId='missing',(a,t)=>a.data.artifacts[0].taskId='other',(a,t)=>a.data.artifacts[0].stepId='other',(a,t)=>a.data.artifacts[0].content=' ']){const a=setup(),t=ready(a);change(a,t);const v=overview(a);assert.equal(v.counts.current,0);assert.ok(!v.groups[0]?.ready);}
});
test('Stale verification removes the ready claim without hiding the current document',()=>{
  const a=setup(),task=ready(a);task.verification.basis=acceptance.basis(a,task);a.data.artifacts[0].content+=' later edit';const g=overview(a).groups[0];assert.equal(g.current.length,1);assert.equal(g.ready,false);assert.equal(g.status,'needs_work');assert.ok(g.reasons.some(r=>r.code==='changed'));
});
test('Failed checks and missing steps cannot imply that user acceptance is available',()=>{
  const a=setup(),task=ready(a);task.verification.passed=false;const g=overview(a).groups[0];assert.equal(g.ready,false);assert.match(g.detail,/检查/);
});
test('Completed results distinguish human and automatic acceptance and archived work cannot be accepted',()=>{
  const a=setup(),task=ready(a);task.status='completed';assert.equal(overview(a).groups[0].statusLabel,'已自动验收');task.acceptedBy='user';assert.equal(overview(a).groups[0].statusLabel,'已由你验收');task.status='review';task.projectId='p';a.data.projects.push({id:'p',name:'归档项目',archivedAt:'2026-10-12'});const g=overview(a).groups[0];assert.equal(g.ready,false);assert.equal(g.status,'archived');
});
test('Orphaned artifacts stay available as unlinked history without being promoted',()=>{
  const a=setup();a.data.artifacts.push({id:'orphan',taskId:'missing',title:'孤立文稿',content:'旧内容'});const v=overview(a);assert.equal(v.groups.length,0);assert.equal(v.unlinked.length,1);assert.equal(v.counts.current,0);assert.equal(v.counts.history,1);
});
test('Duplicate references deduplicate and grouping keeps independent tasks and projects separate',()=>{
  const a=setup(),one=ready(a),two=ready(a,'two');one.steps.push({...one.steps[0]});two.projectId='p';a.data.projects.push({id:'p',name:'P'});const v=overview(a);assert.equal(v.counts.current,2);assert.equal(v.groups.find(g=>g.id==='one').projectId,null);assert.equal(v.groups.find(g=>g.id==='two').projectName,'P');assert.equal(v.groups.find(g=>g.id==='one').current.length,1);
});

test('Read-only presentation checks revalidate without hashing unrelated workspace history',()=>{
  const a={data:{tasks:[],artifacts:[],sources:[]}};
  const t={id:'cache-task',status:'review',steps:[]};a.data.tasks.push(t);
  let calls=0;const original=acceptance.reasons;
  acceptance.reasons=(...args)=>{calls++;return original(...args);};
  try {
    const first=acceptance.presentationChecks(a)(t);first.length=0;
    assert.ok(acceptance.presentationChecks(a)(t).length>0,'callers cannot mutate later verdicts');
    assert.equal(calls,2);
    t.verification={passed:true,summary:'New verification',gaps:[]};
    acceptance.presentationChecks(a)(t);assert.equal(calls,3);
    acceptance.presentationChecks(a)(t,true);assert.equal(calls,4,'completion and review checks are distinct');
  } finally {acceptance.reasons=original;}
});
