'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const policies=require('../desktop/access-policy-store.cjs');
const body='用户确认：复听安排在周五，仅用于内部校对。';
const quotation=task=>task.grounding.claims[0].citations[0];
const intact=report=>report.reportHash===hash({...report,reportHash:undefined});
async function fixture(t,field='description'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-user-citations-'));
 const a=new Assistant({dir,chat:()=>{throw Error('offline: model forbidden');}});
 t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);a.streamController?.dispose();const resolved=fs.realpathSync(dir),temp=fs.realpathSync(os.tmpdir());assert.ok(resolved.startsWith(temp+path.sep));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 a.data.settings.evidenceGrounding=true;
 const task=a.createTask({title:'复听通知',description:'据用户信息形成通知',criteria:'准确说明安排和范围',generationMode:'single',steps:[{title:'拟稿',kind:'draft'}]});
 await a.dispatch('uiCommand',{action:'updateTask',input:{id:task.id,[field]:body}});
 const artifact={id:'offline-user-draft',taskId:task.id,stepId:task.steps[0].id,title:'复听通知',content:body,createdAt:new Date().toISOString()};
 a.data.artifacts.push(artifact);require('../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});
 task.steps[0].done=true;task.steps[0].artifactId=artifact.id;require('../desktop/deliverables.cjs').record(a,task,task.steps[0],artifact,{});
 const snapshot=grounding.snapshot(a,task),seen=new Set();
 grounding.observe(seen,{artifacts:[artifact],...grounding.context(a,task,{},'verify')});
 const response={passed:true,summary:'用户陈述与正文逐项一致',gaps:[],groundingReview:{
  scannedArtifactIds:[artifact.id],requirements:snapshot.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c1'],reason:'用户信息明确安排和范围'})),
  claims:[{id:'c1',artifactId:artifact.id,text:body,kind:'fact',supported:true,reason:'仅证明用户的陈述',citations:[{sourceId:'user:'+field,quote:body}]}],unsupportedClaims:[],conflicts:[]}};
 const result=grounding.finish(a,task,response,{seen});assert.equal(result.passed,true,JSON.stringify(result.gaps));task.grounding=result.grounding;a.save();
 return {a,task,artifact,dir};
}
for(const field of ['description','objective'])test(`captured ${field} citations survive full, UI and export projections without changing the report`,async t=>{
 const {a,task}=await fixture(t,field),raw=structuredClone(task.grounding),stored=JSON.stringify(a.data);
 const projections=[a.publicState({full:true}),a.publicState({summary:true}),(await a.dispatch('stateView')).state,await a.dispatch('export'),await a.dispatch('uiCommand',{action:'export'})];
 for(const state of projections){const report=state.tasks.find(r=>r.id===task.id).grounding;assert.deepEqual(report,raw);assert.ok(intact(report));}
 assert.equal(JSON.stringify(a.data),stored);assert.ok(grounding.reusable(a,task));
});

const damaged={
 'uncaptured user input':f=>{f.task.groundingUserInputs=[];},
 'model-origin input':f=>{f.task.groundingUserInputs[0].origin='model';},
 'unsupported field':f=>{f.task.criteria=body;f.task.groundingUserInputs=[{field:'criteria',text:body,origin:'user'}];quotation(f.task).sourceId='user:criteria';},
 'changed current input':f=>{f.task.description+='已变更';},
 'foreign user namespace':f=>{quotation(f.task).sourceId='user:other-task';},
 'stale version':f=>{quotation(f.task).version=hash('older input');},
 'wrong start':f=>{quotation(f.task).start=1;},
 'wrong end':f=>{quotation(f.task).end--;},
 'changed quote':f=>{quotation(f.task).quote+='伪造';},
 'title field is not user evidence':f=>{quotation(f.task).field='title';},
 'foreign artifact owner':f=>{f.artifact.taskId='another-task';},
 'missing artifact':f=>{f.a.data.artifacts=[];},
 'cancelled task':f=>{f.task.agentCancelled=true;},
 'same source ID is a real denied source':f=>{f.a.data.sources.push({id:'user:description',title:'conflicting real source',content:body});}
};
for(const [name,damage] of Object.entries(damaged))test(`user citation isolation: ${name}`,async t=>{
 const f=await fixture(t);damage(f);const before=JSON.stringify(f.a.data),oldHash=f.task.grounding.reportHash;
 const projected=(await f.a.dispatch('export')).tasks.find(r=>r.id===f.task.id);
 assert.equal(quotation(projected).quote,'');assert.equal(projected.grounding.reportHash,oldHash);assert.equal(JSON.stringify(f.a.data),before);
});

test('a valid user citation cannot expose unrelated caches, forged projections or blocked ancestors',async t=>{
 const {a,task}=await fixture(t),copy=structuredClone(quotation(task));
 a.data.agentActions.push({id:'untrusted-cache',status:'done',result:{...copy}});
 const state=a.publicState({full:true});assert.equal(quotation(state.tasks[0]).quote,body);assert.equal(state.agentActions[0].result.quote,'');
 const publicContext=require('../desktop/public-context.cjs');
 assert.equal(publicContext.sanitize(a,null),null);
 const partial={grounding:structuredClone(task.grounding)};publicContext.sanitize(a,partial);assert.equal(quotation(partial).quote,'');
 const changed={tasks:[structuredClone(task)]};changed.tasks[0].grounding.claims[0].text='forged report';publicContext.sanitize(a,changed);assert.equal(quotation(changed.tasks[0]).quote,'');
 const blocked={tasks:[structuredClone(task)]};blocked.tasks[0].sourceId='missing-parent';publicContext.sanitize(a,blocked);assert.equal(quotation(blocked.tasks[0]).quote,'');
});

for(const damage of ['revoked','unknown'])test(`artifact ${damage} permission still redacts user citations`,async t=>{
 const {a,task,artifact}=await fixture(t);
 if(damage==='revoked')policies.revoke(a,{principalScope:policies.LOCAL,resourceScope:{kind:'snapshot',key:'artifact:'+artifact.id},operations:['local_retention','local_read']},{trusted:true,actor:'user_command',command:'test'});
 else fs.unlinkSync(policies.locations(a).store);
 const state=await a.dispatch('export');assert.equal(quotation(state.tasks.find(r=>r.id===task.id)).quote,'');assert.equal(state.artifacts[0].content,'');
});

test('projection never repairs an invalid report hash or authorizes delivery',async t=>{
 const {a,task}=await fixture(t);task.grounding.reportHash='tampered';
 const state=await a.dispatch('export'),report=state.tasks[0].grounding;
 assert.equal(quotation(state.tasks[0]).quote,body);assert.equal(report.reportHash,'tampered');assert.equal(intact(report),false);
 assert.equal(grounding.reusable(a,task),null);assert.throws(()=>grounding.assertDelivery(a,task),{code:'GROUNDING_REQUIRED'});
});
