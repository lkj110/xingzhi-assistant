const {test}=require('node:test');
const assert=require('node:assert/strict');
const links=require('../desktop/evidence-links.cjs');
const context=require('../desktop/task-context.cjs');
const generation=require('../desktop/generation-context.cjs');
const recovery=require('../desktop/auto-recovery.cjs');
const errors=require('../desktop/model-errors.cjs');
const compact=require('../desktop/context-evidence.cjs').compact;

function fixture(){
 const task={id:'task',agentJobId:'job',projectId:null,title:'事项',criteria:'核实事实',sourceIds:['input'],supersededSourceIds:[],steps:[{id:'step',kind:'draft',done:true,artifactId:'draft'}],notes:[],status:'todo',workRevision:1};
 const other={...structuredClone(task),id:'other-task',agentJobId:'other-job',sourceIds:['secret'],steps:[]};
 const job={id:'job',projectId:null,sourceIds:['input','readback'],taskIds:['task'],goal:'核实事实',status:'running',history:[],feedback:[],followups:[]};
 const otherJob={...structuredClone(job),id:'other-job',sourceIds:['secret'],taskIds:['other-task']};
 const source={id:'readback',projectId:null,title:'回读',content:'# 已交付\n交付事实',deliveryActionId:'action',purpose:'delivery_readback',principalScope:'account',resourceKey:'https://document.invalid/1',remoteId:'https://document.invalid/1',remoteRevision:23};
 const record={id:'action',jobId:'job',taskId:'task',artifactId:'draft',status:'done',effectStatus:'applied',larkOpenId:'account',target:'https://document.invalid/1',result:{sourceId:'readback',verified:true,url:'https://document.invalid/1',revision:23}};
 const a={data:{tasks:[task,other],delegations:[job,otherJob],sources:[{id:'input',projectId:null,title:'输入',content:'# 第一节\n事实42\n\n第二段'},source,{id:'secret',title:'secret-title',projectId:null,content:'PRIVATE_OTHER_JOB'}],artifacts:[{id:'draft',taskId:'task',stepId:'step',title:'稿件',content:'完整稿件'}],agentActions:[record],modelCalls:[]},saveCount:0,save(){this.saveCount++;},event(){},requeue(){throw Error('迁移不能重排队');}};
 return {a,task,job,source,record,scope:context.taskScope(task)};
}
const request=sourceId=>({tool:'read_source',sourceId});

test('delivery bindings are idempotent, independent from input basis and compatibility IDs',()=>{
 const {a,task,source,record,scope}=fixture(),before=context.buildContext(a,scope);
 const first=links.bindDelivery(a,record,source),again=links.bindDelivery(a,record,source);
 assert.equal(first.bindingId,again.bindingId);assert.equal(again.bindingRevision,1);
 assert.deepEqual(task.sourceIds,['input']);assert.equal(task.contextBindings.filter(b=>b.purpose==='delivery_readback').length,1);
 const after=context.buildContext(a,scope);assert.equal(after.inputBasis,before.inputBasis);assert.notEqual(after.contextRevision,before.contextRevision);assert.notEqual(after.deliveryBasis,before.deliveryBasis);
 assert.equal(context.resolveRead(a,scope,request('readback')).purpose,'delivery_readback');
 source.content+='\n远端变化';assert.equal(context.buildContext(a,scope).inputBasis,after.inputBasis);assert.notEqual(context.buildContext(a,scope).deliveryBasis,after.deliveryBasis);
});
test('same-project and null-project membership never authorize another job or sibling task',()=>{
 const {a,task,job,scope}=fixture();
 for(const id of ['secret','absent']){const r=context.resolveRead(a,scope,request(id));assert.equal(r.code,'CONTEXT_SCOPE_DENIED');assert.doesNotMatch(JSON.stringify(r),/PRIVATE_OTHER_JOB|secret-title/);}
 job.sourceIds.push('unassigned');a.data.sources.push({id:'unassigned',projectId:null,title:'未分配',content:'仅规划可读'});
 assert.equal(context.resolveRead(a,scope,request('unassigned')).code,'CONTEXT_SCOPE_DENIED');
 assert.equal(context.resolveRead(a,{kind:'job',jobId:job.id},request('unassigned')).ok,true);
 assert.equal(context.resolveRead(a,{kind:'task',taskId:task.id,jobId:'other-job'},request('input')).code,'CONTEXT_SCOPE_DENIED');
 assert.equal(context.resolveRead(a,scope,{...request('input'),scope:{kind:'job',jobId:'other-job'}}).code,'CONTEXT_INVALID_REQUEST');
 const foreign=a.data.sources.find(s=>s.id==='secret');foreign.agentJobId='other-job';job.sourceIds.push('secret');task.sourceIds.push('secret');
 assert.equal(context.resolveRead(a,scope,request('secret')).code,'CONTEXT_SCOPE_DENIED');assert.equal(context.resolveRead(a,{kind:'job',jobId:job.id},request('secret')).code,'CONTEXT_SCOPE_DENIED');
});
test('unknown tools and invalid pagination are rejected before object lookup',()=>{
 const trap={get data(){throw Error('object lookup must not happen');}};
 for(const r of [{tool:'shell',sourceId:'secret'},{...request('secret'),start:-1},{...request('secret'),limit:11},{...request('secret'),query:'ignored parameter'},{tool:'search_source',sourceId:'secret',query:''}])assert.equal(context.resolveRead(trap,{kind:'job',jobId:'x'},r).code,'CONTEXT_INVALID_REQUEST');
});
test('three successful reads survive one invalid section and expose independent statuses',()=>{
 const {a,scope}=fixture();
 const result=context.readBatch(a,scope,[request('input'),{tool:'read_section',sourceId:'input',title:'第一节'},{tool:'read_artifact',artifactId:'draft'},{tool:'read_section',sourceId:'input',title:'不存在'}]);
 assert.deepEqual(result.map(r=>r.result.ok),[true,true,true,false]);assert.equal(result[3].result.code,'CONTEXT_INVALID_REQUEST');assert.match(result[1].result.content,/事实42/);
});
test('catalog handles, explicit historical source reads, and stale revisions use the same resolver',()=>{
 const {a,task,job,scope}=fixture();const before=context.buildContext(a,scope),ref=before.readableCatalog.find(r=>r.id==='input').ref;
 assert.equal(context.resolveRead(a,scope,{tool:'read_source',ref},before.contextRevision).ok,true);
 a.data.sources.push({id:'input-v2',projectId:null,title:'新版',content:'新事实',previousSourceId:'input'});job.sourceIds.push('input-v2');task.sourceIds.push('input-v2');task.supersededSourceIds=['input'];
 assert.equal(context.resolveRead(a,scope,{tool:'read_source',ref}).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.resolveRead(a,scope,request('input')).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.resolveRead(a,scope,{...request('input'),history:true}).ok,true);
 assert.equal(context.resolveRead(a,scope,request('input-v2'),before.contextRevision).code,'CONTEXT_VERSION_CHANGED');
});
test('forked versions and version cycles cannot masquerade as a current input',()=>{
 const {a,task,job,scope}=fixture();
 for(const id of ['branch-a','branch-b']){a.data.sources.push({id,projectId:null,title:id,content:id,previousSourceId:'input'});job.sourceIds.push(id);task.sourceIds.push(id);}
 assert.equal(context.resolveRead(a,scope,request('branch-a')).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.resolveRead(a,scope,{...request('branch-a'),history:true}).ok,true);
 assert.equal(context.buildContext(a,scope).readableCatalog.some(r=>r.purpose==='input'),false);
 a.data.sources[0].previousSourceId='branch-a';assert.equal(context.resolveRead(a,scope,request('branch-a')).code,'CONTEXT_VERSION_CHANGED');
});
test('artifact pagination preserves saved historical drafts and ownership',()=>{
 const {a,scope}=fixture();a.data.artifacts.push({id:'old',taskId:'task',title:'旧稿',content:'a'.repeat(25000)},{id:'foreign',taskId:'other-task',title:'foreign',content:'SECRET'});
 const first=context.resolveRead(a,scope,{tool:'read_artifact',artifactId:'old'});assert.equal(first.next,24000);assert.equal(first.state,'historical');
 assert.equal(context.resolveRead(a,scope,{tool:'read_artifact',artifactId:'old',start:first.next}).content.length,1000);
 assert.equal(context.resolveRead(a,scope,{tool:'read_artifact',artifactId:'foreign'}).code,'CONTEXT_SCOPE_DENIED');
});
test('policy callback receives precise local retention scope and unknown fails closed',()=>{
 const {a,scope}=fixture();let seen;
 const options={requireAccessPolicy:true,checkAccess:input=>{seen=input;return {decision:'unknown',revision:4};}};
 assert.equal(context.resolveRead(a,scope,request('input'),undefined,options).code,'CONTEXT_SCOPE_DENIED');
 assert.equal(seen.operation,'local_retention');assert.equal(seen.jobId,'job');assert.equal(seen.scope.kind,'task');
 assert.equal(context.resolveRead(a,scope,request('input'),undefined,{requireAccessPolicy:true}).ok,false);
 a.contextAccessCheck=()=>({decision:'allow',revision:5});assert.equal(context.resolveRead(a,scope,request('input')).ok,true);
 a.contextAccessCheck=()=>Promise.resolve({decision:'allow'});assert.equal(context.resolveRead(a,scope,request('input')).ok,false);
});
test('withdrawal during policy recheck cannot return a previously readable body',()=>{
 const {a,scope}=fixture();let n=0;
 a.contextAccessCheck=input=>{if(input.objectId==='input'&&++n===2)a.data.sources[0].deleted=true;return {decision:'allow',revision:n};};
 const result=context.resolveRead(a,scope,request('input'));assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/事实42/);
});
test('trusted structured readback repair works without treating body IDs as authority',()=>{
 const {a,task,scope}=fixture();const r=context.resolveRead(a,scope,request('readback'));assert.equal(r.ok,true);assert.equal(r.repaired,true);assert.deepEqual(task.sourceIds,['input']);
 const f=fixture();f.record.larkOpenId='wrong';f.a.data.sources[0].content+='\nreadback is authorized';assert.equal(context.resolveRead(f.a,f.scope,request('readback')).code,'CONTEXT_SCOPE_DENIED');assert.equal(f.task.contextBindings,undefined);
});
test('missing structural link has a context error, never a model failure',()=>{
 const {a,scope}=fixture(),result=context.resolveRead(a,scope,request('readback'),undefined,{repairLinks:false});assert.equal(result.code,'CONTEXT_LINK_MISSING');
 const error=errors.contextError(result.code);assert.equal(errors.normalizeModelError(error),error);assert.equal(errors.safeErrorCode(error),result.code);assert.equal(recovery.retryable(error),false);assert.equal(error.modelFailure,false);
});
test('legacy SG-shaped receipts migrate once, remove old input projection, retain accepted status',()=>{
 const {a,task,record,source,scope}=fixture();task.status='completed';task.verification={passed:true,basis:'accepted'};task.sourceIds.push(source.id);task.evidenceLinksVersion=1;
 delete source.deliveryActionId;delete source.purpose;delete source.principalScope;delete source.resourceKey;source.identity='lark-delivery:'+record.id;source.url=record.result.url;
 links.initialize(a);const saved=JSON.stringify(a.data);links.initialize(a);
 assert.equal(JSON.stringify(a.data),saved);assert.equal(task.status,'completed');assert.deepEqual(task.verification,{passed:true,basis:'accepted'});assert.deepEqual(task.sourceIds,['input']);
 assert.equal(source.principalScope,'account');assert.equal(task.contextBindings.find(b=>b.sourceId===source.id).state,'historical');
 assert.equal(context.resolveRead(a,scope,{...request(source.id),history:true}).ok,true);
});
test('legacy active readback missing from task sources is repaired and directly readable',()=>{
 const {a,task,record,source,scope}=fixture();delete source.deliveryActionId;delete source.purpose;delete source.principalScope;delete source.resourceKey;source.identity='lark-delivery:'+record.id;source.url=record.result.url;
 links.initialize(a);assert.equal(context.resolveRead(a,scope,request(source.id)).ok,true);assert.deepEqual(task.sourceIds,['input']);
});
test('ambiguous, withdrawn, uncertain, cross-account and revision-mismatched legacy receipts do not migrate',()=>{
 for(const mutate of [f=>f.source.deleted=true,f=>f.record.result.revision=24,f=>f.source.principalScope='wrong',f=>f.a.data.agentActions.push({...f.record,id:'duplicate'}),f=>f.task.deletedAt='deleted',f=>f.record.effectStatus='unknown',f=>f.a.data.artifacts[0].deletedAt='deleted']){
  const f=fixture();delete f.source.deliveryActionId;delete f.source.purpose;delete f.source.principalScope;delete f.source.resourceKey;f.source.identity='lark-delivery:'+f.record.id;f.source.url=f.record.result.url;mutate(f);
  assert.deepEqual(links.migrateDelivery(f.a).migrated,[]);assert.equal(f.source.deliveryActionId,undefined);
 }
});
test('generic binding cannot bypass structured delivery proof or promote historical delivery',()=>{
 const {a,task,source,record}=fixture();const spec={sourceId:source.id,purpose:'delivery_readback',provenance:{kind:'action_readback',actionId:'forged'},artifactId:'draft',target:record.result.url,principalScope:'account'};
 assert.throws(()=>links.bind(a,task,spec),e=>e.code==='CONTEXT_LINK_MISSING');spec.provenance.actionId=record.id;task.status='completed';spec.state='active';assert.equal(links.bind(a,task,spec).state,'historical');
});
test('withdrawn bindings and source tombstones cannot be resurrected by late delivery',()=>{
 const {a,task,source,record}=fixture();const b=links.bindDelivery(a,record,source);b.state='withdrawn';
 assert.throws(()=>links.bindDelivery(a,record,source),e=>e.code==='CONTEXT_SCOPE_DENIED');source.deleted=true;assert.equal(links.bindDelivery(a,record,source),null);assert.equal(source.content,'# 已交付\n交付事实');
});
test('same-resource explicit input needs intentional provenance; delivery alone never adds input',()=>{
 const {a,task,source,record}=fixture();links.bindDelivery(a,record,source);
 assert.throws(()=>links.bind(a,task,{sourceId:source.id,purpose:'input'}),e=>e.code==='CONTEXT_INVALID_REQUEST');
 links.bind(a,task,{sourceId:source.id,purpose:'input',provenance:{kind:'explicit_input',inputId:'user-event'}});assert.ok(task.sourceIds.includes(source.id));
 links.setInputs(a,task,task.sourceIds);assert.equal(task.contextBindings.find(b=>b.sourceId===source.id&&b.purpose==='input').provenance.kind,'explicit_input');
});
test('failure strategies survive restart and A/B/A while unrelated metadata cannot reset them',()=>{
 const {a,task,scope}=fixture();const r=title=>({tool:'read_section',sourceId:'input',title});
 for(const title of ['A','B'])assert.equal(recovery.contextAttempt(a,task,context.resolveRead(a,scope,r(title)),r(title)).allowed,true);
 const restored={...a,data:structuredClone(a.data)},t=restored.data.tasks[0];t.updatedAt='changed';restored.data.sources[0].lastCheckedAt='new time';
 assert.equal(recovery.contextAttempt(restored,t,context.resolveRead(restored,scope,r('A')),r('A')).allowed,false);
 restored.data.sources[0].content+='\nchanged evidence';assert.equal(recovery.contextAttempt(restored,t,context.resolveRead(restored,scope,r('A')),r('A')).allowed,true);
 assert.doesNotMatch(JSON.stringify(t.contextDiagnostics),/事实42|changed evidence/);
});
test('planner correction attempts use job scope before any task exists',()=>{
 const {a,job}=fixture();a.data.tasks=[];job.taskIds=[];const scope={kind:'job',jobId:job.id},r={tool:'read_section',sourceId:'input',title:'wrong'},failure=context.resolveRead(a,scope,r);
 assert.equal(recovery.contextAttempt(a,scope,failure,r,{stage:'planner'}).allowed,true);
 const restarted={...a,data:structuredClone(a.data)};assert.equal(recovery.contextAttempt(restarted,scope,failure,r,{stage:'planner'}).allowed,false);
 assert.equal(job.contextDiagnostics[0].taskId,null);assert.equal(job.contextDiagnostics[0].jobId,job.id);
});
test('generation preserves successful siblings, sends typed correction, and only rereads failed request',async()=>{
 const {a,task}=fixture();let calls=0;
 a.call=async(role,p,c)=>{
  if(++calls===1)return {kind:'read_context',requests:[request('input'),{tool:'read_artifact',artifactId:'draft'},request('readback'),{tool:'read_section',sourceId:'input',title:'wrong'}]};
  assert.ok(a.saveCount>=1);assert.equal(task.generationReads.length,3);assert.ok(task.generationReads.every(r=>r.result.ok&&r.result.complete));
  assert.deepEqual(c.contextReads.map(r=>r.result.ok),[true,true,true,false]);assert.equal(c.contextReads[3].result.code,'CONTEXT_INVALID_REQUEST');return {kind:'artifact',content:'事实42'};
 };
 const result=await generation.call(a,task,'',{});assert.equal(result.kind,'artifact');assert.equal(task.generationReads.length,3);assert.equal(task.contextDiagnostics.length,1);assert.equal(calls,2);assert.equal(a.saveCount,2);
});
test('repeated internal errors retain successes and never request replacement user materials',async()=>{
 const {a,task}=fixture();a.call=async()=>({kind:'read_context',requests:[request('input'),{tool:'read_section',sourceId:'input',title:'wrong'}]});
 await assert.rejects(generation.call(a,task,'',{}),e=>e.code==='CONTEXT_INVALID_REQUEST'&&e.noProgress&&!e.modelFailure);assert.equal(task.generationReads.length,2);
 const restarted={...a,data:structuredClone(a.data)};let calls=0;restarted.call=async()=>{calls++;return {kind:'read_context',requests:[{tool:'read_section',sourceId:'input',title:'wrong'}]};};
 await assert.rejects(generation.call(restarted,restarted.data.tasks[0],'',{}),e=>e.noProgress);assert.equal(calls,1);
});
test('failed local persistence stops correction before the next paid request with a storage error',async()=>{
 const {a,task}=fixture();let calls=0;a.call=async()=>{calls++;return {kind:'read_context',requests:[request('input')]};};a.save=()=>{throw Error('disk unavailable');};
 await assert.rejects(generation.call(a,task,'',{}),e=>e.code==='STORAGE_FAILURE'&&!e.modelFailure&&errors.normalizeModelError(e)===e);assert.equal(calls,1);
});
test('generation automatically completes eighteen segments without paid per-page calls',async()=>{
 const {a,task}=fixture();a.data.sources[0].content=Array.from({length:18},(_,i)=>'段落'+i).join('\n\n');let n=0;
 a.call=async(_role,_prompt,c)=>{
  if(++n===1)return {kind:'read_context',requests:[{...request('input'),limit:1}]};
  assert.equal(c.contextReads[0].result.complete,true);assert.equal(c.contextReads[0].result.next,null);assert.equal(c.contextReads[0].result.segments.length,18);assert.equal(task.generationReads.length,18);
  assert.ok(task.generationReads.every(row=>context.validRead(a,context.taskScope(task),row)));return {kind:'artifact',content:'done'};
 };
 assert.equal((await generation.call(a,task,'',{})).content,'done');assert.equal(n,2);
});
test('late model returns cannot become current after evidence, requirements or lifecycle changes',async()=>{
 for(const change of [f=>f.a.data.sources[0].content='new',f=>f.task.criteria='new requirement',f=>f.task.deletedAt='deleted',f=>f.task.status='completed',f=>f.task.workRevision++]){
  const f=fixture();f.a.call=async()=>{change(f);return {kind:'artifact',content:'stale'};};
  await assert.rejects(generation.call(f.a,f.task,'',{}),e=>['CONTEXT_VERSION_CHANGED','CONTEXT_SCOPE_DENIED'].includes(e.code));assert.equal(f.a.data.artifacts.length,1);
 }
});
test('late verification rejects changed delivery, unrelated readback additions do not invalidate writer input',async()=>{
 const f=fixture();links.bindDelivery(f.a,f.record,f.source);f.a.call=async()=>{f.source.content+='changed';return {passed:true};};await assert.rejects(generation.call(f.a,f.task,'',{},'verify'),e=>e.code==='CONTEXT_VERSION_CHANGED');
 const g=fixture();g.a.call=async()=>{links.bindDelivery(g.a,g.record,g.source);return {kind:'artifact',content:'input unchanged'};};assert.equal((await generation.call(g.a,g.task,'',{})).content,'input unchanged');
});
test('read receipts become stale after policy changes even with unchanged body',()=>{
 const {a,scope}=fixture();let revision=1;a.contextAccessCheck=()=>({decision:'allow',revision});const row={request:request('input'),result:context.resolveRead(a,scope,request('input'))};
 assert.equal(context.validRead(a,scope,row),true);revision=2;assert.equal(context.validRead(a,scope,row),false);
});
test('compact context retains complete purpose/version directories without injecting delivery into input',()=>{
 const {a,task,source,record,scope}=fixture();links.bindDelivery(a,record,source);const snapshot=context.buildContext(a,scope);
 const value=compact({sources:[{id:'input',content:'x'.repeat(50000)},{id:'readback',content:'delivery'}]},snapshot);
 assert.deepEqual(value.sources.map(s=>s.id),['input']);assert.equal(value.evidenceDirectory.ref,'sourceCatalog');assert.equal(value.sourceCatalog.find(s=>s.id==='readback').purpose,'delivery_readback');assert.equal(value.contextRevision,snapshot.contextRevision);
});
test('ten legacy SG-shaped readbacks migrate from action ownership, latest revision remains readable',()=>{
 const {a,task,job,scope}=fixture();a.data.sources=a.data.sources.filter(s=>s.id!=='readback');a.data.agentActions=[];job.sourceIds=['input'];task.steps[0].artifactId='draft-9';
 for(let i=0;i<10;i++){
  const id='readback-'+i,actionId='action-'+i,artifactId='draft-'+i,url='https://document.invalid/sg';
  a.data.sources.push({id,projectId:null,identity:'lark-delivery:'+actionId,url,remoteId:url,remoteRevision:14+i,title:'回读 '+i,content:'正文 '+i});job.sourceIds.push(id);
  a.data.artifacts.push({id:artifactId,taskId:task.id,stepId:'step',content:'稿件 '+i});a.data.agentActions.push({id:actionId,jobId:job.id,taskId:task.id,artifactId,status:'done',larkOpenId:'account',result:{verified:true,url,revision:14+i,sourceId:id}});
 }
 task.sourceIds.push('readback-0');links.initialize(a);
 assert.equal(task.contextBindings.filter(b=>b.purpose==='delivery_readback').length,10);assert.deepEqual(task.sourceIds,['input']);
 const current=context.resolveRead(a,scope,request('readback-9'));assert.equal(current.ok,true);assert.equal(current.state,'active');assert.equal(current.segments[0].text,'正文 9');
 assert.equal(context.resolveRead(a,scope,request('readback-0')).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.resolveRead(a,scope,{...request('readback-0'),history:true}).ok,true);
});
test('job verifier snapshot rejects changed task set; unrelated task edits preserve task writer snapshot',()=>{
 const {a,task,job,scope}=fixture();const taskSnapshot=context.buildContext(a,scope),jobScope={kind:'job',jobId:job.id},jobSnapshot=context.buildContext(a,jobScope,'verify');
 const sibling={...structuredClone(task),id:'sibling',sourceIds:[],steps:[]};a.data.tasks.push(sibling);job.taskIds.push(sibling.id);
 assert.doesNotThrow(()=>context.assertCurrent(a,scope,taskSnapshot));assert.throws(()=>context.assertCurrent(a,jobScope,jobSnapshot),e=>e.code==='CONTEXT_VERSION_CHANGED');
});
test('successful reading loops survive restart and ignore equivalent default arguments',async()=>{
 const {a,task}=fixture();let n=0;a.call=async()=>++n<=2?{kind:'read_context',requests:[request('input')]}:{kind:'artifact',content:'saved'};
 await generation.call(a,task,'',{});const restarted={...a,data:structuredClone(a.data)};
 restarted.call=async()=>({kind:'read_context',requests:[{...request('input'),start:0,limit:6,history:false}]});
 await assert.rejects(generation.call(restarted,restarted.data.tasks[0],'',{}),e=>e.noProgress);
});
test('no-match search and last page do not claim complete source coverage',()=>{
 const {a,scope}=fixture();assert.equal(context.resolveRead(a,scope,{tool:'search_source',sourceId:'input',query:'not-found'}).coverage.complete,false);
 assert.equal(context.resolveRead(a,scope,{...request('input'),start:1,limit:1}).coverage.complete,false);
});

const planner=require('../desktop/agent.cjs').model;
function plannerFixture(){const f=fixture();f.a.available=()=>({id:'mock-provider'});return f;}
test('planner persists partial batches and corrections before another ordinary model request',async()=>{
 const {a,job,task}=plannerFixture();let calls=0;
 a.callModel=async(provider,key,messages,options)=>{
  assert.equal(provider.id,'mock-provider');assert.equal(options.stage,'planner');
  const c=JSON.parse(messages[1].content);
  if(++calls===1)return {kind:'read_context',requests:[request('input'),{tool:'read_artifact',artifactId:'draft'},{tool:'read_section',sourceId:'input',title:'第一节'},{tool:'read_section',sourceId:'input',title:'wrong'}]};
  assert.equal(a.saveCount,1);assert.equal(job.contextReads.length,3);assert.equal(job.contextDiagnostics.length,1);
  assert.deepEqual(c.contextReads.map(row=>row.result.ok),[true,true,true,false]);assert.equal(c.contextReads[3].result.recovery,'correct_request');
  // Usage, diagnostics and checkpoints are bookkeeping, never a new work basis.
  job.callsUsed=10;job.history.push({at:'later',tool:'read_context'});job.executionState.events.push({type:'observed'});
  task.updatedAt='later';task.steps[0].checkpoint={status:'saved'};a.data.sources[0].lastCheckedAt='later';
  return {tool:'plan_task',args:{}};
 };
 assert.equal((await planner(a,job,'fixture',{})).tool,'plan_task');assert.equal(calls,2);
 assert.equal(job.contextDiagnostics[0].stage,'planner');assert.equal(job.contextDiagnostics[0].taskId,null);
});
test('planner correction ledger stops A/B/A across restart, without losing successful siblings',async()=>{
 const {a,job}=plannerFixture();let n=0;
 a.callModel=async()=>++n<3?{kind:'read_context',requests:[request('input'),{tool:'read_section',sourceId:'input',title:n===1?'A':'B'}]}:{tool:'plan_task'};
 await planner(a,job,'fixture',{});assert.equal(job.contextReads.length,2);assert.equal(job.contextDiagnostics.length,2);
 const restarted={...a,data:structuredClone(a.data)};let calls=0;
 restarted.callModel=async()=>{calls++;return {kind:'read_context',requests:[{tool:'read_section',sourceId:'input',title:'A'}]};};
 await assert.rejects(planner(restarted,restarted.data.delegations[0],'fixture',{}),e=>e.noProgress&&e.code==='CONTEXT_INVALID_REQUEST'&&!e.modelFailure);
 assert.equal(calls,1);assert.equal(restarted.data.delegations[0].contextReads.length,2);
 assert.doesNotMatch(JSON.stringify(restarted.data.delegations[0].contextDiagnostics),/事实42|完整稿件/);
});
test('planner successful-read limits survive restart and equivalent ID/ref aliases',async()=>{
 const {a,job}=plannerFixture();let calls=0;
 a.callModel=async()=>++calls<=2?{kind:'read_context',requests:[request('input')]}:{tool:'plan_task'};
 await planner(a,job,'fixture',{});
 const restarted={...a,data:structuredClone(a.data)},catalog=context.buildContext(restarted,{kind:'job',jobId:job.id}),ref=catalog.readableCatalog.find(s=>s.id==='input').ref;
 restarted.callModel=async()=>({kind:'read_context',requests:[{tool:'read_source',ref,start:0,limit:6,history:false}]});
 await assert.rejects(planner(restarted,restarted.data.delegations[0],'fixture',{}),e=>e.noProgress&&e.code==='CONTEXT_INVALID_REQUEST');
});
test('planner persistence failure stops before the next model call with a typed storage failure',async()=>{
 const {a,job}=plannerFixture();let calls=0;
 a.callModel=async()=>{calls++;return {kind:'read_context',requests:[request('input'),{tool:'read_section',sourceId:'input',title:'wrong'}]};};
 a.save=()=>{throw Error('disk failure');};
 await assert.rejects(planner(a,job,'fixture',{}),e=>e.code==='STORAGE_FAILURE'&&!e.modelFailure);assert.equal(calls,1);
});
test('planner snapshots reject changed facts, requirements, ownership, lifecycle and policy',async()=>{
 for(const change of [f=>f.a.data.sources[0].content+='new',f=>f.task.criteria='new criteria',f=>f.job.goal='new goal',f=>f.job.workRevision=2,f=>f.task.status='completed',f=>f.task.agentJobId='other-job',f=>f.a.contextAccessCheck=()=>({decision:'allow',revision:2})]){
  const f=plannerFixture();f.a.contextAccessCheck=()=>({decision:'allow',revision:1});
  f.a.callModel=async()=>{change(f);return {tool:'complete'};};
  await assert.rejects(planner(f.a,f.job,'fixture',{}),e=>e.code==='CONTEXT_VERSION_CHANGED'||e.code==='CONTEXT_SCOPE_DENIED');
 }
});
test('planner guards already-read historical drafts across a model call and a restart',async()=>{
 for(const restart of [false,true]){
  const {a,job}=plannerFixture(),draft={id:'old',taskId:'task',content:'old draft'};a.data.artifacts.push(draft);let calls=0;
  a.callModel=async()=>{if(++calls===1)return {kind:'read_context',requests:[{tool:'read_artifact',artifactId:'old'}]};if(!restart)draft.content='changed';return {tool:'complete'};};
  if(!restart)await assert.rejects(planner(a,job,'fixture',{}),e=>e.code==='CONTEXT_VERSION_CHANGED');
  else {
   await planner(a,job,'fixture',{});const resumed={...a,data:structuredClone(a.data)};
   resumed.callModel=async()=>{resumed.data.artifacts.find(r=>r.id==='old').content='changed';return {tool:'complete'};};
   await assert.rejects(planner(resumed,resumed.data.delegations[0],'fixture',{}),e=>e.code==='CONTEXT_VERSION_CHANGED');
  }
 }
});
test('planner drains more than fifteen saved pages without a paid call per page',async()=>{
 const {a,job}=plannerFixture();a.data.sources[0].content=Array.from({length:18},(_,i)=>'段落'+i).join('\n\n');let calls=0;
 a.callModel=async(_p,_k,messages)=>{
  if(++calls===1)return {kind:'read_context',requests:[{...request('input'),start:0,limit:1}]};
  const read=JSON.parse(messages[1].content).contextReads.find(r=>r.result.sourceId==='input').result;
  assert.equal(read.next,null);assert.equal(read.segments.length,18);return {tool:'plan_task'};
 };
 assert.equal((await planner(a,job,'fixture',{})).tool,'plan_task');assert.equal(calls,2);assert.equal(a.saveCount,1);assert.equal(job.contextReads.length,18);
});
test('generation pins an initial historical revision and saved historical receipts',async()=>{
 for(const mode of ['revision','workingDraft','receipt']){
  const {a,task,scope}=fixture(),old={id:'old',taskId:'task',stepId:'step',content:'original draft'};a.data.artifacts.push(old);let initial={};
  if(mode==='revision')initial={revision:{artifactId:old.id,originalContent:old.content}};
  if(mode==='workingDraft')initial={workingDraft:{id:old.id,content:old.content}};
  if(mode==='receipt'){const r={tool:'read_artifact',artifactId:old.id};task.generationReads=[{request:r,result:context.resolveRead(a,scope,r)}];}
  a.call=async()=>{old.content='changed';return {kind:'artifact',content:'late edit'};};
  await assert.rejects(generation.call(a,task,'fixture',initial),e=>e.code==='CONTEXT_VERSION_CHANGED');
 }
});
test('deleted historical associations survive replan without authorizing tombstone bodies',()=>{
 const {a,task,job,scope}=fixture();a.data.sources[0].deleted=true;
 a.data.sources.push({id:'restored',projectId:null,previousSourceId:'input',content:'restored body'});job.sourceIds.push('restored');
 links.setInputs(a,task,['input','restored'],['input']);const saved=JSON.stringify(task.contextBindings);
 links.setInputs(a,task,['input','restored'],['input']);assert.equal(JSON.stringify(task.contextBindings),saved);
 assert.deepEqual(task.supersededSourceIds,['input']);assert.equal(context.resolveRead(a,scope,{...request('input'),history:true}).code,'CONTEXT_SCOPE_DENIED');
 assert.equal(context.resolveRead(a,scope,request('restored')).ok,true);
});
test('job readback repair uses unique task action proof and never revives another scope',()=>{
 const {a,job,task,source}=fixture(),scope={kind:'job',jobId:job.id};source.taskId=task.id;
 assert.equal(context.resolveRead(a,scope,request(source.id),undefined,{repairLinks:false}).code,'CONTEXT_LINK_MISSING');
 const read=context.resolveRead(a,scope,request(source.id));assert.equal(read.ok,true);assert.equal(read.repaired,true);assert.equal(read.purpose,'delivery_readback');assert.deepEqual(task.sourceIds,['input']);
 for(const change of [f=>f.source.taskId='other-task',f=>f.task.projectId='elsewhere',f=>f.task.deletedAt='deleted',f=>f.job.sourceIds=['input'],f=>f.a.data.agentActions.push({...f.record})]){
  const f=fixture();change(f);const result=context.resolveRead(f.a,{kind:'job',jobId:f.job.id},request(f.source.id));assert.equal(result.ok,false);assert.equal(f.task.contextBindings,undefined);
 }
});
test('legacy migration skips mismatched task/project ownership without partial enrichment',()=>{
 for(const change of [f=>f.source.taskId='other-task',f=>f.task.projectId='elsewhere']){
  const f=fixture();delete f.source.deliveryActionId;delete f.source.purpose;delete f.source.principalScope;delete f.source.resourceKey;f.source.identity='lark-delivery:'+f.record.id;f.source.url=f.record.result.url;change(f);
  const before=structuredClone(f.source);assert.doesNotThrow(()=>links.initialize(f.a));assert.deepEqual(f.source,before);assert.equal(f.task.contextBindings.some(b=>b.purpose==='delivery_readback'),false);
 }
});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const journal=require('../desktop/work-journal.cjs'),plans=require('../desktop/agent-plan.cjs');
function durableFixture(t){
 const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-withdrawal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 Object.assign(f.a,{dir,file:path.join(dir,'workspace.json'),task(id){return this.data.tasks.find(t=>t.id===id);},requeue(task){task.status='todo';task.verification=null;},save(){journal.beforeSave(this);fs.writeFileSync(this.file,JSON.stringify(this.data));}});
 f.a.data.runtime={};Object.assign(f.task,{agentKey:'plan',description:'原计划',dependsOn:[],planVersion:1,evidenceLinksVersion:3});Object.assign(f.task.steps[0],{key:'draft',title:'主稿'});
 f.args={key:'plan',title:f.task.title,criteria:f.task.criteria,sourceIds:[],removeSourceIds:['input'],reason:'明确撤回本事项输入',steps:[{key:'draft',title:'主稿',kind:'draft'}]};f.a.save();return f;
}
test('explicit plan removal journals a causal withdrawal only after complete validation',t=>{
 const {a,task,job,args,scope}=durableFixture(t),before=JSON.stringify(a.data);
 for(const bad of [{...args,reason:''},{...args,resetSteps:['unknown']},{...args,steps:[{key:'draft',title:'主稿',kind:'unknown'}]}])assert.throws(()=>plans.planTask(a,job,bad));
 assert.equal(JSON.stringify(a.data),before);assert.equal(journal.read(a).events.length,0);
 plans.planTask(a,job,args);const events=journal.read(a).events;
 assert.equal(events.filter(e=>e.type==='binding_withdrawn').length,1);assert.equal(events.at(-1).type,'context_bindings_withdrawn');assert.equal(new Set(events.map(e=>e.commitId)).size,1);assert.equal(events[0].actor,'agent');
 assert.deepEqual(task.sourceIds,[]);assert.equal(task.planHistory.at(-1).sourceIds[0],'input');assert.equal(context.resolveRead(a,scope,request('input')).code,'CONTEXT_SCOPE_DENIED');
 assert.doesNotMatch(JSON.stringify(events),/事实42|完整稿件/);
});
test('withdrawal replay defeats typed and legacy backups even when binding revision identity differs',t=>{
 for(const legacy of [false,true]){
  const {a,task,job,args,scope}=durableFixture(t);if(!legacy)links.initialize(a);
  const backup=structuredClone(a.data);a.data.sources[0].content='new revision';task.contextBindings=[];links.setInputs(a,task,['input']);
  plans.planTask(a,job,args);a.data=backup;journal.replay(a,{force:true});const restored=a.data.tasks[0];
  // An old importer may still write compatibility IDs after replay. That cannot override the tombstone.
  restored.sourceIds=['input'];links.initialize(a);assert.deepEqual(restored.sourceIds,[]);
  assert.equal(context.resolveRead(a,scope,request('input')).code,'CONTEXT_SCOPE_DENIED');
  assert.throws(()=>links.setInputs(a,restored,['input']),e=>e.code==='CONTEXT_SCOPE_DENIED');
  assert.equal(a.data.sources[0].content,backup.sources[0].content);
  const count=journal.read(a).events.length;links.initialize(a);assert.equal(journal.read(a).events.length,count);
 }
});
test('withdrawal journal failure precedes plan mutation; committed save failure replays without resurrection',t=>{
 const bad=durableFixture(t),before=JSON.stringify(bad.a.data);bad.a.workJournalFile=path.join(bad.a.dir,'missing','log.json');
 assert.throws(()=>plans.planTask(bad.a,bad.job,bad.args));assert.equal(JSON.stringify(bad.a.data),before);
 const {a,task,job,args,scope}=durableFixture(t),backup=structuredClone(a.data),save=a.save;
 a.save=()=>{throw Error('workspace save failed');};
 assert.throws(()=>plans.planTask(a,job,args),e=>e.committed&&e.projectionPending);assert.ok(task.projectionPending);assert.equal(journal.read(a).events.length,2);
 a.data=backup;a.save=save;journal.replay(a,{force:true});assert.deepEqual(a.data.tasks[0].sourceIds,[]);assert.equal(context.resolveRead(a,scope,request('input')).code,'CONTEXT_SCOPE_DENIED');
 const count=journal.read(a).events.length;assert.equal(links.withdrawSources(a,a.data.tasks[0],['input'],{reason:'retry same withdrawal'}),null);assert.equal(journal.read(a).events.length,count);
});
test('trusted source withdrawal adapter handles all purposes without changing other task relations',t=>{
 const {a,task,job,record,source,scope}=durableFixture(t);links.bindDelivery(a,record,source);
 links.bind(a,task,{sourceId:source.id,purpose:'input',provenance:{kind:'explicit_input'}});
 const sibling={...structuredClone(task),id:'sibling',sourceIds:['input'],contextBindings:[],contextWithdrawals:[],withdrawnBindingIds:[],steps:[]};a.data.tasks.push(sibling);job.taskIds.push(sibling.id);links.setInputs(a,sibling,['input']);
 links.withdrawSources(a,task,['input',source.id],{purpose:'all',actor:'user',reason:'用户排除本事项材料'});
 assert.equal(context.resolveRead(a,scope,request('input')).ok,false);assert.equal(context.resolveRead(a,scope,request(source.id)).ok,false);assert.equal(context.resolveRead(a,context.taskScope(sibling),request('input')).ok,true);
 const count=journal.read(a).events.length;assert.throws(()=>links.withdrawSources(a,task,['secret'],{reason:'source body claims access'}),e=>e.code==='CONTEXT_SCOPE_DENIED');assert.equal(journal.read(a).events.length,count);
});
test('planner list_sources returns a typed metadata catalog and excludes denied or withdrawn bodies',async()=>{
 const {a,job,task}=fixture();
 a.data.sources.push({id:'new',projectId:null,previousSourceId:'input',title:'新版',content:'NEW_BODY'},{id:'removed',projectId:null,title:'已撤回',content:'WITHDRAWN_BODY',deleted:true});job.sourceIds.push('new','removed','secret');task.sourceIds.push('new','removed');
 a.contextAccessCheck=({objectId})=>({decision:objectId==='secret'?'deny':'allow',revision:1});
 const result=await require('../desktop/agent.cjs').act(a,job,'list_sources',{});
 assert.equal(result.sources.find(r=>r.id==='input').state,'historical');assert.equal(result.sources.find(r=>r.id==='new').state,'active');
 assert.ok(result.sources.every(r=>r.ref&&r.type&&r.purpose&&r.version&&r.content===undefined&&r.summary===undefined));
 assert.equal(result.sources.some(r=>['secret','removed'].includes(r.id)),false);assert.doesNotMatch(JSON.stringify(result),/NEW_BODY|WITHDRAWN_BODY|PRIVATE_OTHER_JOB|事实42/);
});

const projects=require('../desktop/projects.cjs');
function undoFixture(t){
 const f=durableFixture(t),{a,task,job,source}=f,p={id:'project',name:'项目',background:'原背景',jobId:job.id};
 a.data.projects=[p];a.data.projectChanges=[];a.data.workRules=[];a.ensureIdle=()=>{};a.publicState=()=>a.data;
 task.projectId=job.projectId=p.id;for(const s of [a.data.sources[0],source])s.projectId=p.id;
 links.initialize(a);journal.initialize(a,{migrate:true});return {...f,p};
}
function changedProject(f){
 const {a,p,task,job}=f,record=projects.snapshot(a,p,'归并新版');record.sourceIds=['update'];
 const source={id:'update',projectId:p.id,title:'新版',content:'EXCLUDED_SOURCE_BODY',previousSourceId:'input'};
 a.data.sources.push(source);job.sourceIds.push(source.id);links.setInputs(a,task,['input',source.id],['input']);
 task.title='归并后的计划';p.background='新背景';return record;
}
test('project undo replays withdrawals and plan without rewinding lifecycle or erasing later user instructions',async t=>{
 const f=undoFixture(t),{a,p,job,task,scope}=f;
 journal.commit(a,[{entityKind:'task',entityId:task.id,type:'accepted',actor:'user',payload:{acceptanceRevision:'accepted'}},{entityKind:'job',entityId:job.id,type:'completed',actor:'user',payload:{}}]);
 const record=changedProject(f);record.note='应撤销的项目补充';journal.recordJobFeedback(a,{id:job.id,requirementRevision:'project-note',note:record.note});
 journal.recordUserEdit(a,{id:task.id,requirementRevision:'later',changes:{criteria:'后续用户标准'},note:'保留后续指令'});
 const backup=structuredClone(a.data),beforeSequence=task.workEvent.sequence,revision=task.workRevision;job.callsUsed=8;
 await projects.dispatch(a,'projectUndo',{id:p.id,changeId:record.id});
 assert.equal(task.workRevision,revision);assert.ok(task.workEvent.sequence>beforeSequence);assert.equal(task.acceptanceHistory.length,1);assert.equal(task.criteria,'后续用户标准');assert.equal(task.title,'事项');assert.deepEqual(task.sourceIds,['input']);assert.equal(job.callsUsed,8);
 assert.equal(task.notes.some(n=>n.text===record.note),false);assert.ok(task.notes.some(n=>n.text==='保留后续指令'));assert.equal(job.userDirectives.some(n=>n.text===record.note),false);
 assert.ok(task.withdrawnRequirementIds.includes('project-note'));assert.ok(task.contextWithdrawals.some(w=>w.sourceId==='update'));
 const events=journal.read(a).events,undoEvents=events.filter(e=>e.commitId===events.at(-1).commitId);
 assert.doesNotMatch(JSON.stringify(undoEvents),/EXCLUDED_SOURCE_BODY|完整稿件|PRIVATE_OTHER_JOB|acceptanceHistory|workEvent|snapshot/);
 journal.recordUserEdit(a,{id:task.id,requirementRevision:'after-undo',note:'撤销之后的新指令'});
 // Restore a pre-undo legacy mirror; its binding identity and cursor cannot win.
 a.data=backup;delete a.data.tasks[0].contextBindings;journal.replay(a,{force:true});links.initialize(a);
 const restored=a.task(task.id),restoredJob=a.data.delegations.find(j=>j.id===job.id);
 assert.equal(restored.workRevision,revision);assert.equal(restored.criteria,'后续用户标准');assert.equal(restored.requirementRevision,'after-undo');assert.deepEqual(restored.sourceIds,['input']);assert.equal(restoredJob.status,'paused');assert.equal(a.data.projects[0].background,'原背景');
 assert.ok(restored.notes.some(n=>n.text==='保留后续指令'));assert.ok(restored.notes.some(n=>n.text==='撤销之后的新指令'));assert.equal(restored.notes.some(n=>n.text===record.note),false);
 assert.equal(context.resolveRead(a,scope,request('update')).ok,false);assert.equal(context.resolveRead(a,{kind:'job',jobId:job.id},request('update')).ok,false);assert.equal(a.data.sources.find(s=>s.id==='update').projectExcluded,true);
 const count=journal.read(a).events.length;journal.replay(a,{force:true});assert.equal(journal.read(a).events.length,count);assert.equal(restoredJob.history.filter(h=>h.tool==='project_undo').length,1);
});
test('project undo has no precommit mutations and recovers a committed save failure without its old full snapshot',async t=>{
 const f=undoFixture(t),{a,p,task,job}=f,record=changedProject(f),backup=structuredClone(a.data),save=a.save;
 a.workJournalFile=path.join(a.dir,'missing','journal.json');const before=JSON.stringify(a.data);
 await assert.rejects(projects.dispatch(a,'projectUndo',{id:p.id,changeId:record.id}));assert.equal(JSON.stringify(a.data),before);delete a.workJournalFile;
 a.save=()=>{throw Error('workspace unavailable');};await assert.rejects(projects.dispatch(a,'projectUndo',{id:p.id,changeId:record.id}),e=>e.committed&&e.projectionPending);
 a.data=backup;a.data.projectChanges=[];a.save=save;journal.replay(a,{force:true});
 assert.deepEqual(a.task(task.id).sourceIds,['input']);assert.equal(a.data.delegations.find(j=>j.id===job.id).status,'paused');assert.equal(a.data.projectChanges[0].status,'undone');assert.equal(a.data.projectChanges[0].snapshot,undefined);assert.ok(a.task(task.id).contextWithdrawals.some(w=>w.sourceId==='update'));
});
test('source deletion withdraws typed delivery binding and backup restore cannot expose body or revive association',async t=>{
 const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),backups=require('../desktop/recovery.cjs'),policy=require('../desktop/access-policy-store.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-delete-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:async()=>{throw Error('model forbidden');},agentRequest:async()=>{throw Error('network forbidden');}});
 await a.dispatch('saveProvider',{name:'fixture',baseUrl:'https://fixture.invalid',model:'fixture',inputPrice:0,outputPrice:0});
 const job=agent.buildJob(a,{goal:'核对交付',allowWeb:false,fileMode:'off'});a.data.delegations.push(job);
 const task=a.createTask({title:'核对交付',criteria:'完整',steps:[{title:'主稿',kind:'draft'}]});task.agentJobId=job.id;job.taskIds.push(task.id);
 const f=fixture(),source={...f.source},record={...f.record,jobId:job.id,taskId:task.id},artifact={...f.a.data.artifacts[0],taskId:task.id,stepId:task.steps[0].id};
 a.data.sources.push(source);job.sourceIds.push(source.id);a.data.artifacts.push(artifact);task.steps[0].artifactId=artifact.id;task.steps[0].done=true;a.data.agentActions.push(record);
 policy.grant(a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id,jobId:job.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command',command:'test_import'});
 links.bindDelivery(a,record,source);a.save();const backup=backups.create(a,'before-source-deletion');
 assert.equal(context.resolveRead(a,context.taskScope(task),request(source.id)).ok,true);
 await a.dispatch('deleteSource',{id:source.id});assert.equal(a.data.sources.some(s=>s.id===source.id),false);assert.ok(task.contextWithdrawals.some(w=>w.sourceId===source.id&&w.purpose==='delivery_readback'));assert.deepEqual(task.sourceIds,[]);
 backups.restore(a,backup);const restored=a.task(task.id),restoredSource=a.data.sources.find(s=>s.id===source.id);
 assert.ok(restored.contextWithdrawals.some(w=>w.sourceId===source.id));assert.equal(context.resolveRead(a,context.taskScope(restored),request(source.id)).ok,false);
 assert.equal(restoredSource,undefined);assert.doesNotMatch(JSON.stringify(a.publicState()),/交付事实/);assert.doesNotMatch(JSON.stringify(a.context(restored)),/交付事实/);assert.equal(links.bindDelivery(a,record,source),null);
 const reopened=new Assistant({dir,chat:a.chat,agentRequest:a.agentRequest});assert.equal(context.resolveRead(reopened,context.taskScope(reopened.task(task.id)),request(source.id)).ok,false);assert.ok(reopened.task(task.id).contextWithdrawals.some(w=>w.sourceId===source.id));
});
test('source deletion still refuses active typed input even if compatibility sourceIds are missing',async t=>{
 const {Assistant}=require('../desktop/core.cjs'),f=undoFixture(t),{a,task}=f;
 task.sourceIds=[];const before=JSON.stringify(a.data);a.publicState=()=>a.data;
 await assert.rejects(Assistant.prototype.dispatch.call(a,'deleteSource',{id:'input'}),/引用|追溯/);assert.equal(JSON.stringify(a.data),before);
});
