const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),cache=require('../desktop/verification-cache.cjs'),acceptance=require('../desktop/acceptance.cjs');
const access=require('../desktop/protocol-access.cjs'),policies=require('../desktop/access-policy-store.cjs');
const options={allowExact:true,verifierKey:'task-result-prompt-v1'},passed={passed:true,summary:'正文与当前依据一致',gaps:[]};
const prohibited=async()=>{throw Error('Network/model access prohibited');};
function fixture(t,{long=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-exact-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited});
 const task=a.createTask({title:'发布说明',criteria:'包含发布日期',steps:[{title:'正文',kind:'draft'}]});
 const source={id:'source',title:'发布日期',content:'周五发布',projectId:null};a.data.sources.push(source);task.sourceIds=[source.id];access.retain(a,'source',source,{task});
 const artifact={id:'artifact',taskId:task.id,stepId:task.steps[0].id,title:'发布说明',content:long?Array.from({length:7},(_,i)=>`## ${i}\n`+'周五发布。'.repeat(200)).join('\n'):'周五发布。'};
 a.data.artifacts.push(artifact);Object.assign(task.steps[0],{done:true,artifactId:artifact.id});access.retain(a,'artifact',artifact,{task});a.save();
 return {a,task,source,artifact,dir};
}
function prepare(f,opts=options){return cache.prepare(f.a,f.task,f.a.context(f.task,{verification:true}),opts);}
function seed(f){const prepared=prepare(f);assert.ok(prepared.exactBasis);cache.remember(f.a,f.task,passed,prepared);f.task.verification={...passed,basisVersion:2,basis:acceptance.basis(f.a,f.task)};f.task.status='review';assert.ok(f.task.verificationCheckpoint.exact);}
test('same passed short result is reusable with explicit zero-model metrics and no auto-acceptance',t=>{
 const f=fixture(t);seed(f);const p=prepare(f);assert.equal(p.mode,'exact');assert.equal(p.checkedChunks,0);assert.equal(p.reusedChunks,1);assert.deepEqual(p.metrics,{modelCalls:0,avoidedModelCalls:1,reusedResults:1});
 const result=cache.reuse(f.a,f.task,p,options);assert.deepEqual(result,passed);result.summary='caller edit';assert.equal(cache.reuse(f.a,f.task,p,options).summary,passed.summary);
 assert.equal(f.task.status,'review');assert.equal(f.task.acceptedAt,undefined);assert.equal((f.a.data.modelCalls||[]).length,0);assert.equal(prepare(f,{}).mode,'full');assert.equal(cache.reuse(f.a,f.task,p,{}),null);
});
test('passed exact cache survives persisted Assistant restart',t=>{
 const f=fixture(t);seed(f);f.a.save();const a=new Assistant({dir:f.dir,chat:prohibited}),restored={...f,a,task:a.task(f.task.id)};
 const p=prepare(restored);assert.equal(p.mode,'exact');assert.deepEqual(cache.reuse(a,restored.task,p,options),passed);
});
for(const [name,mutate] of [
 ['business criteria',f=>f.task.criteria+='并补充延期负责人'],
 ['business revision note',f=>f.task.notes.push({kind:'revise',text:'新增订单金额要求'})],
 ['artifact bytes',f=>f.artifact.content+='修改'],
 ['source facts',f=>f.source.content+='改期'],
 ['source deletion',f=>f.source.deleted=true],
 ['missing source',f=>f.a.data.sources=[]],
 ['new source revision',f=>f.a.data.sources.push({...f.source,id:'source-2',previousSourceId:f.source.id,content:'周六发布'})],
 ['work revision',f=>f.task.workRevision++],
 ['requirement revision',f=>f.task.requirementRevision='new-requirement'],
 ['acceptance basis version',f=>f.task.verification.basisVersion=1],
 ['invalid passed result',f=>f.task.verification.gaps=['仍有缺口']],
 ['conflicting receipt',f=>f.a.data.agentActions.push({id:'receipt',taskId:f.task.id,status:'done',artifactId:f.artifact.id,content:f.artifact.content,result:{verified:true},deliveryConflict:{message:'remote edit'}})],
 ['uncertain delivery',f=>f.a.data.agentActions.push({id:'receipt',taskId:f.task.id,status:'uncertain'})],
 ['open decision',f=>f.a.data.decisions.push({id:'decision',status:'open',taskIds:[f.task.id]})],
 ['withdrawn binding',f=>f.task.contextWithdrawals=[{key:require('../desktop/evidence-basis.cjs').hash({sourceId:f.source.id,purpose:'input'})}]],
 ['policy denied',f=>f.a.contextAccessCheck=()=>({decision:'deny',revision:'revoked'})],
 ['policy revision changed',f=>{const check=f.a.contextAccessCheck;f.a.contextAccessCheck=input=>({...check(input),revision:'new-policy'});}],
 ['policy store revocation',f=>policies.revoke(f.a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.source.id,taskId:f.task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command',command:'fixtureRevoke'})],
 ['cached result tampering',f=>f.task.verificationCheckpoint.exact.result.summary='tampered'],
])test(`prepared hit is rejected before use after ${name}`,t=>{
 const f=fixture(t);seed(f);const p=prepare(f);assert.equal(p.mode,'exact');mutate(f);assert.equal(cache.reuse(f.a,f.task,p,options),null);assert.notEqual(prepare(f).mode,'exact');
});
test('changed verifier policy never reuses a prior passed result',t=>{
 const f=fixture(t);seed(f);const p=prepare(f);assert.equal(cache.reuse(f.a,f.task,p,{verifierKey:'v2'}),null);assert.notEqual(prepare(f,{...options,verifierKey:'v2'}).mode,'exact');
});
for(const [name,change] of [
 ['denied source',f=>f.a.contextAccessCheck=({objectType})=>({decision:objectType==='source'?'deny':'allow',revision:'revoked'})],
 ['changed policy revision',f=>{const old=f.a.contextAccessCheck;f.a.contextAccessCheck=input=>({...old(input),revision:'changed'});}],
 ['missing policy checkpoint',f=>delete f.task.verificationCheckpoint.policyBasis]
])test(`incremental fallback does not reuse old evidence after ${name}`,t=>{
 const f=fixture(t,{long:true});seed(f);assert.equal(prepare(f,{}).mode,'incremental');change(f);
 const p=prepare(f,{});assert.equal(p.mode,'full');assert.equal(p.reusedChunks,0);assert.equal(p.context.previousCheck,undefined);
});
test('failed/malformed checks and stale asynchronous responses cannot seed exact reuse',t=>{
 const f=fixture(t);let p=prepare(f);cache.remember(f.a,f.task,{passed:true,summary:'contradiction',gaps:['gap']},p);assert.equal(f.task.verificationCheckpoint,undefined);
 p=prepare(f);f.source.content='周六发布';cache.remember(f.a,f.task,passed,p);assert.equal(f.task.verificationCheckpoint,undefined);
 seed(f);cache.remember(f.a,f.task,{passed:false,summary:'failed',gaps:['gap']},prepare(f));assert.equal(f.task.verificationCheckpoint,undefined);
});
test('editorial changes retain incremental neighbours; new business requirements recheck all chunks',t=>{
 const f=fixture(t,{long:true});seed(f);f.artifact.content=f.artifact.content.replace('## 3\n周五发布。','## 3\n计划周五发布。');f.task.notes.push({kind:'revise',text:'润色第三节'});
 const p=prepare(f);assert.equal(p.mode,'incremental');assert.equal(p.checkedChunks,3);assert.equal(p.reusedChunks,4);
 f.task.criteria+='补充负责人的联系信息';assert.equal(prepare(f).mode,'full');
});
test('parent advance integration calls verifier once, reuses on a second pass, and rechecks changed requirements',async t=>{
 const f=fixture(t);f.a.data.settings.autoComplete=false;
 await f.a.dispatch('saveProvider',{name:'fixture',baseUrl:'https://fixture.invalid/v1',model:'fixture',inputPrice:0,outputPrice:0});
 let calls=0;f.a.chat=async(p,k,m,o)=>{calls++;o.onUsage?.({inputTokens:10,outputTokens:10});return structuredClone(passed);};
 await f.a.advance(f.task.id);assert.equal(calls,1);assert.equal(f.task.status,'review');assert.equal(f.task.verification.mode,'full');
 // Simulate the scheduler revisiting the same work, without revising requirements.
 f.task.status='todo';const oldBasis=f.task.verification.basis;
 await f.a.advance(f.task.id);assert.equal(calls,1);assert.equal(f.task.status,'review');assert.equal(f.task.verification.mode,'exact');assert.equal(f.task.verification.avoidedModelCalls,1);assert.equal(f.task.verification.basis,oldBasis);
 assert.equal(f.a.data.modelCalls.length,1);assert.equal(f.task.acceptedAt,undefined);
 f.task.criteria+='并检查发布负责人';f.task.status='todo';await f.a.advance(f.task.id);assert.equal(calls,2);assert.equal(f.task.verification.mode,'full');
});
