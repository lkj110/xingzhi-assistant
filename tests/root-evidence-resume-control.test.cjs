const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./root-relation-fixture.cjs'),control=require('../desktop/continuation-control.cjs'),relations=require('../desktop/relation-obligations.cjs');
function exhausted(f){
 require('../desktop/work-efficiency.cjs').before(f.a,f.job);
 for(let i=0;i<=control.MAX_HOPS;i++){
  const step={tool:'plan_task',args:{existingTaskId:f.task.id},errorCode:'PLAN_ALREADY_RECONCILED'};
  assert.equal(control.redirect(f.a,f.job,step,Object.assign(Error('同依据计划已协调'),{code:step.errorCode,taskId:f.task.id})),true);
 }
 assert.equal(control.ready(f.a,f.job),false);return f.job.executionState.continuation.activeBasis;
}
test('parent refresh consumes one committed related fact basis and preserves the exhausted episode',t=>{
 const f=fixture(t),oldKey=exhausted(f),old=structuredClone(f.job.executionState.continuation.episodes[oldKey]);
 f.need();const s=f.source('code',undefined,undefined,{},false);f.resolve([s.id]);
 assert.equal(control.refresh(f.a,f.job),true);assert.equal(control.ready(f.a,f.job),true);assert.equal(f.job.status,'ready');assert.equal(f.job.executionState.workEfficiency.phase,'working');
 assert.deepEqual(f.job.executionState.continuation.episodes[oldKey],old);assert.notEqual(f.job.executionState.continuation.activeBasis,oldKey);assert.equal(control.refresh(f.a,f.job),false);
 assert.notEqual(relations.context(f.a,f.job,f.task)[0].status,'analyzed');
 const current=f.job.executionState.continuation.episodes[f.job.executionState.continuation.activeBasis];
 for(let n=0;n<3;n++){control.started(f.a,f.job,{tool:'advance_task',args:{taskId:f.task.id}});control.settled(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id},result:{verification:{passed:false,basis:'failed-check-'+n,gaps:['SQL读写仍未核对']}}});assert.equal(current.cycles,n+1);}
 assert.equal(control.ready(f.a,f.job),false);f.need();const clone=f.source();f.resolve([clone.id]);assert.equal(control.refresh(f.a,f.job),false);assert.equal(current.cycles,3);
});
test('parent refresh never admits calendar evidence to an exhausted SQL gap',t=>{
 const f=fixture(t),key=exhausted(f);f.need();const s=f.source('calendar',{date:'2026-10-17'});f.resolve([s.id]);
 assert.equal(control.refresh(f.a,f.job),false);assert.equal(f.job.executionState.continuation.activeBasis,key);assert.equal(control.ready(f.a,f.job),false);
});
test('permission observation counters never replenish a blocked fact basis',t=>{
 for(const path of ['resolution','receipt']){
  const f=fixture(t);if(path==='resolution')f.need();const s=f.source();
  if(path==='resolution')f.resolve([s.id]);else relations.record(f.job,f.check([s.id]).receipts);
  const facts=relations.recoveryFacts(f.a,f.job,f.task),key=exhausted(f),before=structuredClone(f.job.executionState.continuation.episodes[key]);
  f.job.executionState.permissionRevision++;
  assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),facts);assert.equal(control.basis(f.a,f.job,f.task),key);
  assert.equal(control.refresh(f.a,f.job),false);assert.equal(control.ready(f.a,f.job),false);
  assert.deepEqual(f.job.executionState.continuation.episodes[key],before);
 }
});
test('related facts do not override parent pause or an already blocked target basis',t=>{
 const f=fixture(t),oldKey=exhausted(f);f.need();const s=f.source();f.resolve([s.id]);
 f.job.executionPaused=true;assert.equal(control.refresh(f.a,f.job),false);assert.equal(f.job.executionState.continuation.activeBasis,oldKey);
 f.job.executionPaused=false;const key=control.basis(f.a,f.job,f.task),state=f.job.executionState.continuation;
 state.episodes[key]={...structuredClone(state.episodes[oldKey]),basis:key,blocked:true,cycles:3,reason:'该事实依据已耗尽'};
 assert.equal(control.refresh(f.a,f.job),true);assert.equal(control.ready(f.a,f.job),false);assert.equal(state.episodes[key].cycles,3);
});

for(const path of ['resolution','receipt'])test('IR4 '+path+' cannot replenish A → B → A+B across restart, but genuinely new C can',t=>{
 const {Assistant}=require('../desktop/core.cjs'),{deny}=require('./root-relation-fixture.cjs');
 const agent=require('../desktop/agent.cjs'),plans=require('../desktop/agent-plan.cjs'),requests=require('../desktop/evidence-request.cjs');
 const links=require('../desktop/evidence-links.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
 let f=fixture(t),sequence=0;
 const state=()=>f.job.executionState.continuation;
 const facts=()=>relations.recoveryFacts(f.a,f.job,f.task).map(hash).sort();
 function source(value,op='code'){
  return agent.source(f.a,f.job,'IR4-combination-'+(++sequence),op,JSON.stringify({operation:op,region:'sg',query:{op,taskId:123},data:{taskId:123,[op==='sql'?'code':'sql']:'SELECT '+value+' FROM orders'}}),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal||null});
 }
 function admit(ids,removeSourceIds=[]){
  if(path==='resolution'){
   f.task.evidenceRequest=requests.normalize(f.a,f.task,{kind:'needs_evidence',summary:'原SQL缺口需要补证',gaps:['入口123 SQL缺失'],requirements:[]},'request-'+(++sequence));
   plans.planTask(f.a,f.job,{key:'report',title:f.task.title,criteria:f.task.criteria,sourceIds:ids,removeSourceIds,reason:'补齐原SQL缺口并替换旧诊断来源',evidenceResolution:{basis:f.task.evidenceRequest.basis,sourceIds:ids,reason:'处理原SQL缺口'}});
   assert.ok(f.task.lastEvidenceResolution.recoveryProof);
  }else{
   links.setInputs(f.a,f.task,[...new Set([...f.task.sourceIds,...ids])]);
   const o=relations.required(f.a,f.job,f.task).find(o=>o.kind==='sql_read_write');
   const checked=relations.validateCoverage(f.a,f.job,f.task,{passed:true,summary:'对应SQL已核对',gaps:[],relationCoverage:[{obligationId:o.id,status:'analyzed',coverage:'complete',rootIds:o.rootIds,sourceIds:ids,summary:'核对当前入口SQL'}]},'check-'+(++sequence));
   assert.equal(checked.result.passed,true);relations.record(f.job,checked.receipts);
  }
 }
 function exhaustCycles(label){
  for(let i=0;i<3;i++){
   control.started(f.a,f.job,{tool:'advance_task',args:{taskId:f.task.id}});
   control.settled(f.a,f.job,{tool:'verify_content',args:{taskId:f.task.id},result:{verification:{passed:false,basis:label+'-'+i,gaps:['SQL读写仍未核对']}}});
  }
  assert.equal(state().episodes[state().activeBasis].cycles,3);assert.equal(control.ready(f.a,f.job),false);
 }
 function restart(){
  f.a.save();require('../desktop/deadline-scheduler.cjs').dispose(f.a);
  const a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});
  t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
  f={a,job:a.data.delegations.find(j=>j.id===f.job.id),task:a.task(f.task.id),dir:f.dir};
 }
 const A=source('A');admit([A.id]);require('../desktop/work-efficiency.cjs').before(f.a,f.job);
 assert.equal(control.redirect(f.a,f.job,{tool:'plan_task',args:{existingTaskId:f.task.id}},Object.assign(Error('同依据计划已协调'),{code:'PLAN_ALREADY_RECONCILED',taskId:f.task.id})),true);
 exhaustCycles('A');const aKey=state().activeBasis,aFacts=facts();assert.equal(aFacts.length,1);
 const B=source('B');admit([B.id],[A.id]);assert.equal(control.refresh(f.a,f.job),true);
 exhaustCycles('B');const bKey=state().activeBasis,bFacts=facts();assert.equal(bFacts.length,1);assert.notDeepEqual(bFacts,aFacts);
 const consumed=[...new Set([...aFacts,...bFacts])].sort(),before=structuredClone(state());
 // A new source ID/operation wrapper may prove the current request, but the
 // same semantic A already funded an exhausted episode of this obligation.
 const restoredA=path==='resolution'?source('A','sql'):A;
 admit([B.id,restoredA.id]);assert.deepEqual(facts(),consumed);
 const combination=control.basis(f.a,f.job,f.task);assert.notEqual(combination,aKey);assert.notEqual(combination,bKey);
 assert.equal(control.refresh(f.a,f.job),false);assert.deepEqual(state(),before);
 restart();assert.deepEqual(facts(),consumed);assert.equal(control.refresh(f.a,f.job),false);
 assert.deepEqual(state(),before);assert.equal(f.job.status,'blocked');assert.equal(f.job.nextRunAt,null);assert.equal(control.ready(f.a,f.job),false);
 const C=source('C');admit([B.id,restoredA.id,C.id]);assert.equal(facts().filter(k=>!consumed.includes(k)).length,1);
 assert.equal(control.refresh(f.a,f.job),true);const cKey=state().activeBasis;
 assert.notEqual(cKey,bKey);assert.notEqual(cKey,combination);assert.equal(Object.keys(state().episodes).length,3);
 assert.equal(state().episodes[cKey].cycles,0);assert.equal(state().episodes[cKey].hops,0);
 assert.deepEqual(state().episodes[aKey],before.episodes[aKey]);assert.deepEqual(state().episodes[bKey],before.episodes[bKey]);
 assert.equal(f.job.status,'ready');assert.equal(f.job.executionState.workEfficiency.phase,'working');assert.equal(control.ready(f.a,f.job),true);
 assert.equal(control.refresh(f.a,f.job),false);exhaustCycles('C');const afterC=structuredClone(state());
 restart();assert.equal(control.refresh(f.a,f.job),false);assert.deepEqual(state(),afterC);assert.equal(control.ready(f.a,f.job),false);
});
