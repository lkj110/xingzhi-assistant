'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,review}=require('./helpers/evidence-workflow.cjs'),ground=require('../desktop/grounding.cjs');
const dimensions=[['金额','境内预算为100元。','境内预算为200元。'],['分母','完成率分母为全部工单。','完成率分母为已开始工单。'],['日期','计划发布日期为2028-05-01。','计划发布日期为2028-05-02。'],['状态','发布尚未执行。','发布已完成且有回读。'],['例外','本规则涉密岗位除外。','本规则夜班岗位除外。']];
for(const [dimension,oldValue,newValue] of dimensions)for(const partial of [false,true])test('D accepted multisection '+dimension+' revision '+(partial?'blocks stale detail':'rechecks every section'),async t=>{
 let task,source,revising=false;
 const body=(summary,detail)=>'# 一、摘要\n摘要：'+summary+'\n\n# 二、明细\n明细：'+detail+'\n\n# 三、独立范围\n境外项目预算为120元，单独核算。\n\n# 四、说明\n本文只记录当前有效方案。';
 const f=await fixture(t,({a,context,role})=>{
  if(role==='execute'){
   if(!revising)return {kind:'artifact',title:'当前方案报告',content:body(oldValue,oldValue)};
   assert.ok(context.revision);return {kind:'patch',title:'当前方案报告',edits:[{before:'摘要：'+oldValue,after:'摘要：'+newValue},...(!partial?[{before:'明细：'+oldValue,after:'明细：'+newValue}]:[])],summary:'同步当前方案'};
  }
  const artifact=context.artifacts.find(r=>r.id===context.task.primaryArtifactId)||context.artifacts[0],lines=artifact.content.split('\n').filter(l=>l&&!l.startsWith('#'));
  const claims=lines.map((text,i)=>({id:'c'+i,artifactId:artifact.id,field:'content',text,kind:'fact',supported:true,citationIds:['e']}));
  const r=review(a,task,context,claims,[{id:'e',sourceId:source.id,quote:source.content}]);
  if(revising&&partial)r.groundingReview.consistencyIssues=[{claimIds:['c0','c1'],anchors:lines.slice(0,2).map(quote=>({artifactId:artifact.id,quote})),reason:'同一对象的摘要已更新，明细仍为旧'+dimension}];
  return r;
 });
 f.a.addSources([{title:'批准记录',content:oldValue+'境外项目预算为120元，单独核算。本文只记录当前有效方案。'}]);source=f.a.data.sources[0];
 task=f.a.createTask({title:'报告事项',description:'根据当前有效记录形成多章节方案。',criteria:'摘要、明细和例外相互一致，独立对象分别核算。',sourceIds:[source.id],generationMode:'single',steps:[{title:'形成报告',kind:'draft'}]});
 await f.a.advance(task.id);assert.equal(task.status,'review',task.lastError);ground.assertDelivery(f.a,task);const initialBasis=task.grounding.basis,oldId=task.primaryArtifactId;
 await f.a.dispatch('taskAction',{id:task.id,command:'accept'});assert.equal(task.status,'completed');
 await f.a.dispatch('updateTask',{id:task.id,description:'根据第二轮当前批准记录更新多章节方案。'});assert.notEqual(task.status,'completed');
 await f.a.dispatch('taskAction',{id:task.id,command:'revise',note:'根据最新批准记录同步摘要和明细，保留境外独立范围。'});source.content=newValue+'境外项目预算为120元，单独核算。本文只记录当前有效方案。';revising=true;
 assert.equal(ground.reusable(f.a,task),null);await f.a.advance(task.id);
 assert.deepEqual(f.calls.map(c=>c.role),['execute','verify','execute','verify']);assert.notEqual(task.primaryArtifactId,oldId);assert.equal(task.verification.mode,'full');assert.equal(task.verification.reusedChunks,0);assert.notEqual(task.grounding.basis,initialBasis);
 const checked=f.calls.at(-1).context.artifacts.find(r=>r.id===task.primaryArtifactId);assert.ok(checked.content.includes('# 四、说明'));assert.ok(checked.content.includes('境外项目预算为120元'));
 if(partial){assert.equal(task.verification.passed,false);assert.equal(task.grounding.consistencyIssues.length,1);assert.throws(()=>ground.assertDelivery(f.a,task),e=>e.code==='GROUNDING_REQUIRED');}
 else {assert.equal(task.status,'review',task.lastError);assert.equal(task.verification.passed,true);ground.assertDelivery(f.a,task);}
});
