const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,deny}=require('./root-relation-fixture.cjs');
const r=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs');
function graph(f,nodes=[888,999],root=123){return f.source('downstream',{taskId:root,nodes:nodes.map(id=>({id,projectId:7,parentRelation:[{id:root}]}))},{taskId:root,depth:1});}
function sql(f,id=123,extra={}){return f.source('code',{taskId:id,sql:'SELECT value FROM table_'+id,...extra},{taskId:id,...(id===123?{}:{projectId:7})});}
function output(f,id=123){return f.source('outputs',{taskId:id,outputs:[{database:'db',table:'out_'+id}]},{taskId:id});}
function check(f,ids){return r.validateCoverage(f.a,f.job,f.task,{passed:true,summary:'全部逐项核对',gaps:[],relationCoverage:r.required(f.a,f.job,f.task).map(o=>({obligationId:o.id,status:'analyzed',coverage:'complete',rootIds:o.rootIds,sourceIds:ids,summary:'已逐项核对对应事实及边界'}))},'check-'+ids.join('-'));}
test('CR-P1-1: one child cannot close root and sibling SQL/output requirements',t=>{
 const f=fixture(t,{kinds:'SQL读写、产出配置；逐个核对入口123和下游任务888、999'}),g=graph(f),s=sql(f,999),o=output(f,999);
 const result=check(f,[g.id,s.id,o.id]);assert.equal(result.result.passed,false);assert.equal(result.receipts.length,0);
 for(const demand of r.required(f.a,f.job,f.task))assert.deepEqual(demand.entities.map(e=>e.nodeId).sort(),['123','888','999']);
 const all=[g,s,o,sql(f),output(f),sql(f,888),output(f,888)];const good=check(f,all.map(s=>s.id));assert.equal(good.result.passed,true);
 assert.equal(good.receipts.length,2);assert.ok(good.receipts.every(r=>r.entityCoverage.length===3));
});
test('omitting any root/peer fact rejects coverage, even when the full scope graph is not cited',t=>{
 const f=fixture(t),g=graph(f),sources=[sql(f),sql(f,888),sql(f,999)];
 for(const omitted of sources)assert.equal(check(f,[g.id,...sources.filter(s=>s!==omitted).map(s=>s.id)]).result.passed,false);
 assert.equal(check(f,sources.map(s=>s.id)).result.passed,false);
});
test('same-direction scope excludes a sibling reached only by reversing at the downstream node',t=>{
 const f=fixture(t),g=f.source('downstream',{taskId:123,nodes:[{id:888,projectId:7,parentRelation:[{id:123},{id:777}]}]},{taskId:123});
 const entities=r.required(f.a,f.job,f.task)[0].entities;assert.deepEqual(entities.map(e=>e.nodeId).sort(),['123','888']);
 assert.equal(check(f,[g.id,sql(f).id,sql(f,888).id]).result.passed,true);
});
test('unrelated inventory and a cross-region task do not enlarge the SG entity set',t=>{
 const f=fixture(t);f.source('downstream',{taskId:123,nodes:[{id:999,region:'us',parentRelation:[{id:123}]}]},{taskId:123});
 f.source('downstream',{taskId:555,nodes:[{id:666,parentRelation:[{id:555}]}]},{taskId:555});
 sql(f,777);assert.deepEqual(r.required(f.a,f.job,f.task)[0].entities.map(e=>e.nodeId),['123']);
});
test('project conflict is an unresolved required node, never silently omitted',t=>{
 const f=fixture(t),g=graph(f,[888]);f.source('task',{id:888,projectId:8},{taskId:888,projectId:8});
 const o=r.required(f.a,f.job,f.task)[0];assert.ok(o.entities.some(e=>e.nodeId==='888'&&!e.scopeProven));
 assert.equal(check(f,[g.id,sql(f).id,sql(f,888).id]).result.passed,false);
});
test('a new lawful in-scope entity invalidates an old analyzed receipt',t=>{
 const f=fixture(t),s=sql(f);r.record(f.job,check(f,[s.id]).receipts);assert.equal(r.context(f.a,f.job,f.task)[0].status,'analyzed');
 graph(f,[888]);assert.notEqual(r.context(f.a,f.job,f.task)[0].status,'analyzed');assert.deepEqual(r.recoveryFacts(f.a,f.job,f.task),[]);
});
test('withdrawn path proof cannot delete previously confirmed entity obligations',t=>{
 const f=fixture(t),g=graph(f,[888]),a=sql(f),b=sql(f,888);r.record(f.job,check(f,[g.id,a.id,b.id]).receipts);
 links.withdrawSources(f.a,f.task,[g.id],{reason:'撤回路径'});
 const o=r.required(f.a,f.job,f.task)[0];assert.ok(o.entities.some(e=>e.nodeId==='888'&&!e.scopeProven));assert.equal(check(f,[a.id]).result.passed,false);
});
test('exact accepted SQL boundary covers only its own entity and operation',t=>{
 const f=fixture(t,{kinds:'SQL读写、产出配置'}),g=graph(f,[888]),root=sql(f),out=output(f),query={op:'code',taskId:888,projectId:7};
 f.job.executionState.operations.denied={id:'denied',key:'denied',query,principal:f.job.platformPrincipal||null,permissionRevision:0,scope:f.job.dataPlatform,status:'failed',errorCode:'AUTH_REQUIRED',completedAt:'2026-01-01T00:00:00Z',acceptedBoundary:{authority:'user',policy:'document_and_continue',decisionId:'accepted',coverage:'query'}};
 const checked=check(f,[g.id,root.id,out.id]);assert.equal(checked.result.passed,false);assert.deepEqual(checked.receipts.map(r=>r.kind),['sql_read_write']);
 assert.equal(checked.receipts[0].entityCoverage.find(e=>e.nodeId==='888').status,'accepted_boundary');
 f.job.executionState.operations.denied.query.taskId=999;assert.equal(check(f,[g.id,root.id,out.id]).receipts.length,0);
});
test('CR-P1-2: explicit equivalent wording and typed gaps create stable types, not an empty pass',t=>{
 const f=fixture(t,{kinds:'SQL 的读表与写表、任务配置产出、物理表生产/消费关系及最终数据集映射'});
 assert.equal(r.required(f.a,f.job,f.task).length,4);const v=r.validateCoverage(f.a,f.job,f.task,{passed:true,summary:'笼统通过',gaps:[]},'check');
 assert.equal(v.result.passed,false);assert.equal(v.receipts.length,0);
 r.record(f.job,v.receipts);assert.equal(f.job.executionState.relations.requirements.length,4);
});
test('new explicit typed check gap is confirmed and persisted even without a successful receipt',t=>{
 const f=fixture(t,{kinds:'按已确定的要求逐项核对'}),g={text:'入口123原指定关系缺少事实',relationKind:'sql_read_write',rootIds:['123'],requirementId:'task:'+f.task.id};
 assert.equal(r.required(f.a,f.job,f.task).length,0);
 const v=r.validateCoverage(f.a,f.job,f.task,{passed:false,summary:'缺事实',gaps:[g.text],gapDetails:[g]},'typed-check');r.record(f.job,v.receipts);
 assert.deepEqual(r.required(f.a,f.job,f.task).map(o=>o.kind),['sql_read_write']);
 f.a.save();const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const j=a.data.delegations.find(j=>j.id===f.job.id),task=a.task(f.task.id);assert.equal(r.required(a,j,task)[0].kind,'sql_read_write');
 assert.equal(r.validateCoverage(a,j,task,{passed:true,summary:'遗漏旧缺口',gaps:[]},'next').result.passed,false);
});
test('foreign typed gap, ordinary feedback and arbitrary source prose never create requirements',t=>{
 const f=fixture(t,{kinds:'只按已确定要求核对'});f.job.feedback=[{text:'SQL读写、物理表血缘'}];f.source('code',{taskId:999,sql:'SQL读写'} ,{taskId:999});
 const g={text:'新增外部任务SQL',relationKind:'sql_read_write',rootIds:['999'],requirementId:'task:'+f.task.id};
 const v=r.validateCoverage(f.a,f.job,f.task,{passed:false,summary:'其他范围',gaps:[g.text],gapDetails:[g]},'other');r.record(f.job,v.receipts);assert.equal(r.required(f.a,f.job,f.task).length,0);
});
test('identity survives rephrasing, while a changed opaque contract requires reconfirmation',t=>{
 const f=fixture(t),s=sql(f);r.record(f.job,check(f,[s.id]).receipts);const before=r.required(f.a,f.job,f.task)[0];
 f.job.executionContract={revision:'reworded',text:'入口 IDs: 123\n\n范围：\n逐项确认SQL的读表与写表'};
 let now=r.required(f.a,f.job,f.task)[0];assert.equal(now.id,before.id);assert.equal(now.confirmationState,'confirmed');assert.notEqual(now.contractBasis,before.contractBasis);
 f.job.executionContract={revision:'changed',text:'入口 IDs: 123\n\n范围：\n沿已确认要求继续'};
 now=r.required(f.a,f.job,f.task)[0];assert.equal(now.id,before.id);assert.equal(now.confirmationState,'requires_confirmation');assert.equal(check(f,[s.id]).result.passed,false);
});
test('trusted structured contract confirms a type independent of words and explicitly withdraws it',t=>{
 const f=fixture(t,{kinds:'核对约定项'});f.job.executionContract={revision:'typed',text:f.job.goal,relationRequirements:['sql_read_write']};
 const s=sql(f);r.record(f.job,check(f,[s.id]).receipts);assert.equal(r.context(f.a,f.job,f.task)[0].status,'analyzed');
 f.job.executionContract={...f.job.executionContract,revision:'withdrawn',relationRequirements:[]};const v=check(f,[]);r.record(f.job,v.receipts);assert.deepEqual(r.required(f.a,f.job,f.task),[]);
});
test('read projections stay pure; stale confirmation cannot commit across contract change',t=>{
 const f=fixture(t),before=JSON.stringify(f.a.data);r.required(f.a,f.job,f.task);r.context(f.a,f.job,f.task);assert.equal(JSON.stringify(f.a.data),before);
 const v=check(f,[]);assert.equal(JSON.stringify(f.a.data),before);
 f.job.executionContract={revision:'changed',text:f.job.goal};assert.throws(()=>r.record(f.job,v.receipts),e=>e.code==='PLAN_RECONCILE_REQUIRED');
});
test('real verifyContent transaction persists typed confirmation on a failed check and retains it on restart',async t=>{
 const f=fixture(t,{kinds:'SQL 的读表与写表'});f.a.chat=async(_p,_k,_m,o)=>{o.onUsage?.({inputTokens:10,outputTokens:5});return {passed:false,summary:'缺少当前证据',gaps:['入口123SQL仍需核对']};};
 const v=await require('../desktop/execution-control.cjs').verifyContent(f.a,f.job,f.task);assert.equal(v.verification.passed,false);
 assert.equal(f.job.executionState.relations.requirements[0].kind,'sql_read_write');
 const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 assert.equal(a.data.delegations.find(j=>j.id===f.job.id).executionState.relations.requirements[0].kind,'sql_read_write');
});
test('final mapping targets a proven consumer, not every intermediate ETL task',t=>{
 const f=fixture(t,{kinds:'最终数据集映射'}),g=graph(f),consumer=f.source('task',{id:999,type:'Hive2CH',projectId:7},{taskId:999,projectId:7});
 const demand=r.required(f.a,f.job,f.task)[0];assert.deepEqual(demand.entities.map(e=>e.nodeId),['999']);
 assert.equal(check(f,[g.id,consumer.id]).result.passed,false);
 const mapped=f.source('dataset_mapping',{taskId:999,mappings:[{datasetId:'ds1'}]},{taskId:999,projectId:7});
 assert.equal(check(f,[g.id,consumer.id,mapped.id]).result.passed,true);
 // A second proven consumer cannot be covered by the first consumer's mapping.
 f.source('task',{id:888,type:'Hive2CH',projectId:7},{taskId:888,projectId:7});assert.equal(check(f,[g.id,consumer.id,mapped.id]).result.passed,false);
});
test('terminal scheduling nodes alone never establish final mapping targets',t=>{
 const f=fixture(t,{kinds:'Aeolus映射'}),g=graph(f);sql(f);sql(f,888);sql(f,999);
 const o=r.required(f.a,f.job,f.task)[0];assert.deepEqual(o.entities,[]);assert.deepEqual(o.unresolvedRootIds,['123']);assert.equal(check(f,[g.id]).result.passed,false);
});
test('explicit final mapping target is pinned to the existing path; a foreign target stays unresolved',t=>{
 const f=fixture(t,{kinds:'最终数据集映射'}),g=graph(f);
 f.job.executionContract={text:f.job.goal,revision:'typed',relationRequirements:[{kind:'dataset_mapping',taskIds:['888']}]};
 assert.deepEqual(r.required(f.a,f.job,f.task)[0].entities.map(e=>e.nodeId),['888']);
 const mapped=f.source('dataset_mapping',{taskId:888,mappings:[]},{taskId:888,projectId:7});assert.equal(check(f,[g.id,mapped.id]).result.passed,true);
 f.job.executionContract.relationRequirements[0].taskIds.push('777');assert.equal(check(f,[g.id,mapped.id]).result.passed,false);
 assert.deepEqual(r.required(f.a,f.job,f.task)[0].unprovenTargetTaskIds,['777']);
});
test('persisted typed gap must be reconfirmed after basis change, never by a derived missing-coverage gap',t=>{
 const f=fixture(t,{kinds:'按约定核对'}),gap={text:'入口原SQL类型缺事实',relationKind:'sql_read_write',rootIds:['123']};
 let checked=r.validateCoverage(f.a,f.job,f.task,{passed:false,summary:'缺事实',gaps:[gap.text],gapDetails:[gap]},'old');f.task.contentVerification=checked.result;r.record(f.job,checked.receipts);
 f.job.executionContract={text:f.job.goal,revision:'new-contract'};
 assert.equal(r.required(f.a,f.job,f.task)[0].confirmationState,'requires_confirmation');
 checked=check(f,[]);f.task.contentVerification=checked.result;r.record(f.job,checked.receipts);
 assert.equal(r.required(f.a,f.job,f.task)[0].confirmationState,'requires_confirmation');
 checked=r.validateCoverage(f.a,f.job,f.task,{passed:false,summary:'按原要求确认',gaps:[gap.text],gapDetails:[gap]},'fresh');r.record(f.job,checked.receipts);
 assert.equal(r.required(f.a,f.job,f.task)[0].confirmationState,'confirmed');
});
test('unresolved root scope and malformed typed contract cannot pass via an empty set',t=>{
 const f=fixture(t);f.job.executionContract={text:'继续SQL读写，入口范围另行确认',revision:'unresolved'};
 assert.equal(r.required(f.a,f.job,f.task)[0].confirmationState,'scope_unresolved');assert.equal(check(f,[]).result.passed,false);
 f.job.executionContract={text:'入口 IDs: 123\n\n范围：\n待确认',relationRequirements:['not_a_relation_type']};assert.equal(check(f,[]).result.passed,false);
});
test('legacy accepted binding changes context version but cannot exempt uncovered entities or other types',t=>{
 const f=fixture(t,{kinds:'SQL读写、产出配置'}),o=r.required(f.a,f.job,f.task)[0],before=JSON.stringify(r.context(f.a,f.job,f.task));
 f.job.executionState.gaps.push({obligationId:o.legacyIds[0],status:'accepted_gap',acceptedBy:'user',decisionId:'legacy-boundary'});
 const context=r.context(f.a,f.job,f.task);assert.notEqual(JSON.stringify(context),before);assert.equal(context[0].boundaryDecisions[0].obligationId,o.legacyIds[0]);assert.equal(context[0].boundaryDecisions[0].status,'requires_entity_confirmation');
 assert.equal(check(f,[]).result.passed,false);assert.deepEqual(context[1].boundaryDecisions,[]);
});
test('exact entity acceptance expires on new entities or changed basis',t=>{
 const f=fixture(t),o=r.required(f.a,f.job,f.task)[0];f.job.executionState.gaps.push({obligationId:o.id,status:'accepted_gap',acceptedBy:'user',decisionId:'exact',contractBasis:o.contractBasis,entityIds:o.entities.map(e=>e.id)});
 assert.equal(check(f,[]).result.passed,true);graph(f,[888]);assert.equal(check(f,[]).result.passed,false);
 f.job.executionContract={text:f.job.goal,revision:'new'};assert.notEqual(r.context(f.a,f.job,f.task)[0].status,'accepted_boundary');
});
test('physical legacy boundary keeps its original scope revision while its typed identity stays stable',t=>{
 const f=fixture(t,{kinds:'物理表血缘'}),o=r.required(f.a,f.job,f.task)[0];f.job.executionState.gaps.push({obligationId:o.id,status:'accepted_gap',acceptedBy:'user',decisionId:'physical-existing'});
 assert.equal(r.context(f.a,f.job,f.task)[0].status,'accepted_boundary');f.job.executionContract={text:f.job.goal,revision:'changed'};
 const next=r.required(f.a,f.job,f.task)[0];assert.equal(next.typeId,o.typeId);assert.notEqual(next.id,o.id);assert.notEqual(r.context(f.a,f.job,f.task)[0].status,'accepted_boundary');
});
test('explicit synchronize hook persists initial types before any check and is idempotent',t=>{
 const f=fixture(t),requirements=require('../desktop/relation-requirements.cjs');assert.equal(requirements.synchronize(f.a),true);const snapshot=JSON.stringify(f.a.data);assert.equal(requirements.synchronize(f.a),false);assert.equal(JSON.stringify(f.a.data),snapshot);
 f.job.executionContract={text:'入口 IDs: 123\n\n范围：\n沿已约定类型继续',revision:'opaque'};requirements.synchronize(f.a);
 assert.equal(r.required(f.a,f.job,f.task)[0].confirmationState,'requires_confirmation');f.a.save();
 const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const job=a.data.delegations.find(j=>j.id===f.job.id);assert.equal(job.executionState.relations.requirements[0].confirmationState,'requires_confirmation');
});
test('synchronize skips unchanged graphs and invalidates its cache after atomic rollback',t=>{
 const f=fixture(t),requirements=require('../desktop/relation-requirements.cjs'),original=r.required;let projections=0;
 t.mock.method(r,'required',(...args)=>{projections++;return original(...args);});
 requirements.synchronize(f.a);assert.equal(projections,1);requirements.synchronize(f.a);assert.equal(projections,1);
 f.task.updatedAt='only-observation';f.job.summary='saving model progress';requirements.synchronize(f.a);assert.equal(projections,1);
 const undo=require('../desktop/state-transitions.cjs').snapshot(f.a.data),old=structuredClone(f.job.executionState.relations.requirements);
 f.job.executionContract={text:f.job.goal,revision:'would-be-new'};requirements.synchronize(f.a);assert.equal(projections,2);
 undo();assert.deepEqual(f.job.executionState.relations.requirements,old);requirements.synchronize(f.a);assert.equal(projections,3);
 // Rolling back only the requirement projection must also invalidate the key.
 f.job.executionState.relations.requirements=[];requirements.synchronize(f.a);assert.equal(projections,4);assert.equal(f.job.executionState.relations.requirements.length,1);
});
test('save integration preserves initial requirements across a text change before the first check',t=>{
 const f=fixture(t);f.a.save();assert.equal(f.job.executionState.relations?.requirements?.[0]?.kind,'sql_read_write','core.save must call relation-requirements.synchronize after execution-contract.initialize');
 f.job.executionContract={text:'入口 IDs: 123\n\n范围：\n沿已约定项继续',revision:'before-first-check'};f.a.save();
 const o=r.required(f.a,f.job,f.task)[0];assert.equal(o.kind,'sql_read_write');assert.equal(o.confirmationState,'requires_confirmation');assert.equal(check(f,[]).result.passed,false);
 const {Assistant}=require('../desktop/core.cjs'),a=new Assistant({dir:f.dir,chat:deny,connectorRequest:deny,webRequest:deny,platformRequest:deny});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(a));
 const job=a.data.delegations.find(j=>j.id===f.job.id);assert.equal(job.executionState.relations.requirements[0].confirmationState,'requires_confirmation');
});
