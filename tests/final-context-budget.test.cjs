const {test}=require('node:test'),assert=require('node:assert/strict');
const input=require('../desktop/model-input.cjs'),protocol=require('../desktop/task-context.cjs');
const {fixture}=require('./root-relation-fixture.cjs');
const catalog=()=>({readableCatalog:[],historyCatalog:[]});
test('whole serialized input is bounded including escaped metadata and old delivery bodies',()=>{
 const body='"\\\n'.repeat(9000),context={...catalog(),task:{id:'t',criteria:'保留用户的完整要求'},artifacts:[{id:'current',content:'当前主稿'}],
  deliveryEvidence:Array.from({length:30},(_,i)=>({tool:'lark_update',artifactId:'old'+i,current:false,result:{sourceId:'s'+i,content:body,url:'https://example.test/'+i},readback:{id:'s'+i,content:body,state:'historical'}})),
  businessObligations:[{id:'ob',taskId:'t',required:true,kind:'physical_lineage',rootIds:['123'],physicalCoverage:{satisfied:false,closureProven:false,frontier:Array.from({length:2000},()=>({reason:body.slice(0,1000)})),proofSourceIds:['s']}}]};
 const p=input.prepare(context,{stage:'task_verify'});
 assert.ok(input.encodedSize(p)<=480000);assert.equal(p.task.criteria,context.task.criteria);assert.equal(p.artifacts[0].content,'当前主稿');
 assert.equal(p.businessObligations[0].physicalCoverage.closureProven,false);assert.equal(p.businessObligations[0].physicalCoverage.frontierCount,2000);
 assert.equal(p.deliveryEvidence[0].readback.resumeRequest.history,true);assert.equal(p.deliveryEvidence[0].readback.content,undefined);
 assert.equal(context.deliveryEvidence[0].readback.content,body);
});
test('fresh reads remain visible while old durable reads do not exhaust the request',()=>{
 const rows=Array.from({length:300},(_,i)=>({sourceId:'s'+i,ref:'s'+i,version:'v',start:0,ok:true,content:('evidence '+i+' ').repeat(5000)}));
 const c={...catalog(),generationEvidence:rows,contextReads:[{request:{tool:'read_source',sourceId:'latest'},result:{ok:true,sourceId:'latest',start:0,content:'FRESH READ',complete:true}}],artifacts:[{id:'draft',content:'CURRENT DRAFT'}]};
 const p=input.prepare(c,{stage:'task_verify'});assert.ok(input.encodedSize(p)<=480000);assert.ok(require('../desktop/context-evidence.cjs').suppliedBodies(p).some(s=>s.includes('FRESH READ')));assert.equal(p.artifacts[0].content,'CURRENT DRAFT');
});
test('oversized draft gets a readable reference; no dangling dedup references survive navigation',()=>{
 const body='"\\'.repeat(250000),c={...catalog(),artifacts:[{id:'draft',content:body}],generationEvidence:[{sourceId:'s',contentRef:{path:'artifacts[0].content',start:0,end:body.length},ok:true,start:0}]};
 const p=input.prepare(c);assert.ok(input.encodedSize(p)<=480000);assert.equal(p.artifacts[0].resumeRequest.artifactId,'draft');assert.equal(p.artifacts[0].truncated,true);
 const walk=x=>{if(!x||typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(k.endsWith('Ref')&&v?.path){const target=v.path.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((n,k)=>n?.[k],p);assert.equal(typeof target,'string');assert.ok(v.end<=target.length);}else walk(v);}};walk(p);
});
test('immutable requirements are never silently shortened to satisfy budget',()=>{
 const criteria='USER REQUIREMENT '.repeat(80000);assert.throws(()=>input.prepare({...catalog(),task:{criteria}}),e=>e.contextFailure&&e.diagnostic?.kind==='input_budget_exceeded');
});
test('coverage detail paging is scope pinned, version checked and has honest progress',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),scope=protocol.taskScope(v.task),o=require('../desktop/relation-obligations.cjs').required(v.a,v.job,v.task)[0];
 const request={tool:'read_obligations',taskId:v.task.id,obligationId:o.id,section:'frontier',start:0,limit:1};
 const result=protocol.readContextBatch(v.a,scope,[request]).rows[0].result;assert.equal(result.ok,true);assert.ok(result.items.length);assert.ok(result.next!==null);assert.equal(result.complete,false);
 const state={};assert.equal(protocol.recordReadResults(state,[{request,result}],{}).directory,1);
 assert.equal(protocol.recordReadResults(state,[{request,result}],{contextReads:[{request,result}]}).duplicate,1);
 assert.equal(protocol.recordReadResults(state,[{request,result}],{}).restored,1);
 for(const delta of [{taskId:'other'},{contextRevision:'stale'},{section:'secret'},{jobId:v.job.id}])assert.equal(protocol.readContextBatch(v.a,scope,[{...request,...delta}]).rows[0].result.ok,false);
});
test('task-scoped coverage never exposes another task in the same job',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),other=v.a.createTask({title:'other',description:'x',criteria:'x'});other.agentJobId=v.job.id;v.job.taskIds.push(other.id);
 const result=protocol.readContextBatch(v.a,protocol.taskScope(v.task),[{tool:'read_obligations',taskId:other.id,section:'obligations'}]).rows[0].result;assert.equal(result.code,'CONTEXT_SCOPE_DENIED');
});
test('real subscription envelope includes profile and fails before charges or transport',async t=>{
 const v=fixture(t),provider=v.a.data.providers[0];provider.type='codex';provider.model='fixture';v.a.data.settings.profile='"\\'.repeat(600000);
 const calls=JSON.stringify(v.a.data.modelCalls),used=v.job.callsUsed;let transport=0;v.a.chat=()=>{transport++;throw Error('must not dispatch');};
 await assert.rejects(v.a.call('verify','检查当前文稿',{task:{criteria:'保持完整'}}),e=>e.diagnostic?.kind==='input_too_large');
 assert.equal(transport,0);assert.equal(JSON.stringify(v.a.data.modelCalls),calls);assert.equal(v.job.callsUsed,used);
});
test('coverage pagination rejects changed acceptance/failure projection even with unchanged source catalog',t=>{
 const v=fixture(t,{kinds:'物理表血缘'}),scope=protocol.taskScope(v.task),o=require('../desktop/relation-obligations.cjs').required(v.a,v.job,v.task)[0];
 const request={tool:'read_obligations',taskId:v.task.id,obligationId:o.id,section:'frontier',start:0,limit:1};
 const r=protocol.readContextBatch(v.a,scope,[request]).rows[0].result;
 v.job.executionState.gaps=[{obligationId:o.id,taskId:v.task.id,status:'accepted_gap',acceptedBy:'user',decisionId:'changed'}];
 const next=protocol.readContextBatch(v.a,scope,[r.resumeRequest]).rows[0].result;assert.equal(next.code,'CONTEXT_VERSION_CHANGED');
 assert.throws(()=>require('../desktop/relation-context-page.cjs').assertCurrent(v.a,scope,[{request,result:r}]),e=>e.code==='CONTEXT_VERSION_CHANGED');
});
