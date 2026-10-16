'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const context=require('../desktop/task-context.cjs');
const links=require('../desktop/evidence-links.cjs');
const policy=require('../desktop/access-policy-store.cjs');
const protocol=require('../desktop/protocol-access.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const trusted={trusted:true,actor:'user_command',command:'synthetic_readback_test'};
const operations=['local_retention','local_read'];

// No Assistant, real workspace, model, connector, UI, or remote operation.
// Initialize the local policy BEFORE delivery: new readbacks inherit the existing
// collection permission and have no per-source grant, as in the SG failure.
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-readback-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const task={id:'task',agentJobId:'job',projectId:null,status:'todo',workRevision:2,sourceIds:[],steps:[{id:'main',artifactId:'current-draft',done:true}],criteria:'核验已交付历史版本'};
 const job={id:'job',projectId:null,status:'ready',sourceIds:[],taskIds:[task.id],goal:'核验交付'};
 const counters={model:0,network:0,save:0};
 const forbidden=kind=>()=>{counters[kind]++;throw Error('Forbidden '+kind);};
 const a={dir,file:path.join(dir,'workspace.json'),data:{version:1,settings:{},projects:[],tasks:[task],delegations:[job],sources:[],artifacts:[],agentActions:[]},call:forbidden('model'),connectorRequest:forbidden('network'),agentRequest:forbidden('network'),save:forbidden('save')};
 fs.writeFileSync(a.file,JSON.stringify(a.data));
 assert.equal(policy.initialize(a).status,'complete');protocol.initialize(a);
 const source={id:'readback',agentJobId:job.id,projectId:null,identity:'lark-delivery:action',purpose:'delivery_readback',deliveryActionId:'action',title:'历史回读',content:'# 历史交付\n\n'+Array.from({length:78},(_,i)=>'历史证据段落 '+i+' 内容仅属于旧稿。').join('\n\n'),principalScope:'original-account',resourceKey:'https://example.invalid/docx/original',remoteRevision:26};
 const artifact={id:'old-draft',taskId:task.id,stepId:'main',content:'原提交稿；与远端回读可有格式差异'};
 const current={id:'current-draft',taskId:task.id,stepId:'main',content:'新主稿，尚未交付'};
 const record={id:'action',jobId:job.id,taskId:task.id,artifactId:artifact.id,tool:'lark_update',status:'done',effectStatus:'applied',presentationStatus:'current',larkOpenId:source.principalScope,content:artifact.content,result:{sourceId:source.id,url:source.resourceKey,revision:26,verified:true}};
 a.data.sources.push(source);job.sourceIds.push(source.id);a.data.artifacts.push(artifact,current);a.data.agentActions.push(record);
 const binding=links.bindDelivery(a,record,source),scope=context.taskScope(task);
 const request={tool:'read_source',sourceId:source.id,history:true,limit:10};
 t.after(()=>assert.deepEqual(counters,{model:0,network:0,save:0}));
 return {a,task,job,source,artifact,current,record,binding,scope,request,counters};
}
const read=f=>context.resolveRead(f.a,f.scope,f.request);
function snapshotSpec(f,scope={jobId:f.job.id,taskId:f.task.id}){
 return {principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+f.source.id,...scope},operations};
}
function collectionSpec(f,scope={jobId:f.job.id,taskId:f.task.id}){
 return {principalScope:policy.LOCAL,resourceScope:{kind:'snapshot_collection',key:'app',...scope},operations};
}
const savedFiles=a=>Object.fromEntries([a.file,policy.locations(a).store,policy.locations(a).migration,policy.locations(a).original].map(file=>[file,fs.readFileSync(file,'utf8')]));
function denied(f,options){
 const before=JSON.stringify(f.a.data),result=context.resolveRead(f.a,f.scope,f.request,undefined,options);
 assert.equal(result.code,'CONTEXT_SCOPE_DENIED');
 assert.doesNotMatch(JSON.stringify(result),/历史证据段落|历史回读|original-account/);
 assert.equal(JSON.stringify(f.a.data),before,'a rejected read must not repair or reauthorize');
 return result;
}

test('SG-shaped historical readback inherits only existing same-task local permission, without mutation',t=>{
 const f=fixture(t),{a,source,task,job,binding}=f,before=JSON.stringify(a.data),files=savedFiles(a);
 const raw=a.contextAccessCheck({objectType:'source',objectId:source.id,jobId:job.id,taskId:task.id});
 assert.equal(raw.decision,'unknown');assert.equal(raw.policyId,null);assert.equal(raw.grantRevision,0);
 assert.equal(policy.check(a,{...collectionSpec(f),operation:'local_read'}).allowed,true);
 const snapshot=context.buildContext(a,f.scope,'verify'),row=snapshot.historyCatalog.find(r=>r.id===source.id);
 assert.ok(row);assert.equal(row.revisionId,'26');assert.equal(row.delivery.actionId,f.record.id);assert.equal(row.delivery.artifactId,f.artifact.id);
 assert.equal(row.delivery.savedArtifactMatchesSubmission,true);assert.equal(snapshot.currentArtifact[0].id,f.current.id);
 assert.equal(snapshot.readableCatalog.some(r=>r.id===source.id),false);
 assert.equal(context.resolveRead(a,f.scope,{...f.request,history:false}).code,'CONTEXT_VERSION_CHANGED');
 const result=context.resolveRead(a,f.scope,{tool:'read_source',ref:row.ref,version:row.version,history:true,limit:10},snapshot.contextRevision);
 assert.equal(result.ok,true);assert.equal(result.state,'historical');assert.equal(result.purpose,'delivery_readback');
 assert.equal(result.delivery.revisionId,'26');assert.equal(result.coverage.complete,false);assert.equal(result.next,10);
 assert.match(JSON.stringify(result.segments),/历史证据段落/);
 assert.equal(binding.state,'historical');assert.deepEqual(task.sourceIds,[]);
 assert.equal(JSON.stringify(a.data),before);assert.deepEqual(savedFiles(a),files);
 assert.equal(fs.existsSync(path.join(a.dir,'action-facts.json')),false);
 assert.equal(fs.existsSync(path.join(a.dir,'work-journal.json')),false);
});

test('reading all 79 synthetic segments is local, version-pinned and does not become current evidence',t=>{
 const f=fixture(t),before=context.buildContext(f.a,f.scope,'verify');
 const batch=context.readContextBatch(f.a,f.scope,[f.request]);
 assert.equal(batch.complete,true);assert.equal(batch.rows[0].result.segments.length,79);assert.equal(batch.rows[0].result.coverage.complete,true);
 assert.ok(batch.pageRows.length>1);assert.equal(new Set(batch.pageRows.map(r=>r.result.version)).size,1);
 assert.ok(batch.pageRows.every(r=>r.result.state==='historical'&&r.result.delivery.artifactId===f.artifact.id));
 const after=context.buildContext(f.a,f.scope,'verify');
 assert.equal(after.inputBasis,before.inputBasis);assert.equal(after.deliveryBasis,before.deliveryBasis);assert.equal(after.guard,before.guard);
 assert.equal(context.assertCurrent(f.a,f.scope,before).contextRevision,after.contextRevision);
 const without=structuredClone(f.a.data);without.tasks[0].contextBindings=[];
 const empty=context.buildContext({...f.a,data:without},f.scope,'verify');
 assert.equal(after.inputBasis,empty.inputBasis);assert.equal(after.deliveryBasis,empty.deliveryBasis);
});

test('stale active projection is classified historical without rewriting bindings or the receipt',t=>{
 const f=fixture(t);f.binding.state='active';const before=JSON.stringify(f.a.data);
 const result=read(f);assert.equal(result.ok,true);assert.equal(result.state,'historical');
 assert.equal(f.binding.state,'active');assert.equal(f.record.presentationStatus,'current');assert.equal(JSON.stringify(f.a.data),before);
 assert.equal(context.resolveRead(f.a,f.scope,{...f.request,history:false}).code,'CONTEXT_VERSION_CHANGED');
});

test('saved artifact divergence is reported, never asserted to match the delivered draft',t=>{
 const f=fixture(t),old=read(f);f.artifact.content='旧 artifact ID 下被覆盖的正文';
 const next=read(f);assert.equal(next.ok,true);assert.equal(next.state,'historical');
 assert.equal(next.delivery.savedArtifactMatchesSubmission,false);assert.equal(next.delivery.submittedContentHash,hash(f.record.content));
 assert.equal(context.resolveRead(f.a,f.scope,{...f.request,version:old.version}).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.validRead(f.a,f.scope,{request:f.request,result:old}),false);
 assert.notEqual(next.delivery.artifactId,f.current.id);
});

for(const [label,change] of [
 ['missing receipt',f=>f.a.data.agentActions=[]],
 ['duplicate receipt',f=>f.a.data.agentActions.push(structuredClone(f.record))],
 ['ambiguous receipt source',f=>f.a.data.agentActions.push({...structuredClone(f.record),id:'another-action'})],
 ['wrong receipt task',f=>f.record.taskId='sibling'],
 ['wrong receipt job',f=>f.record.jobId='other-job'],
 ['unverified receipt',f=>f.record.result.verified=false],
 ['uncertain receipt',f=>f.record.status='uncertain'],
 ['unapplied receipt',f=>f.record.effectStatus='not_applied'],
 ['conflicting receipt',f=>f.record.deliveryConflict={reason:'changed remotely'}],
 ['wrong receipt source',f=>f.record.result.sourceId='another-source'],
 ['missing receipt revision',f=>delete f.record.result.revision],
 ['wrong receipt revision',f=>f.record.result.revision=27],
 ['wrong receipt target',f=>f.record.result.url='https://example.invalid/other'],
 ['wrong receipt account',f=>f.record.larkOpenId='another-account'],
 ['conflicting result account',f=>f.record.result.principalScope='another-account'],
 ['wrong receipt tool',f=>f.record.tool='write_file'],
 ['wrong source account',f=>f.source.principalScope='another-account'],
 ['wrong binding account',f=>f.binding.principalScope='another-account'],
 ['wrong tenant',f=>f.record.tenantId='another-tenant'],
 ['wrong identity',f=>f.source.identity='lark-delivery:another-action'],
 ['wrong source action',f=>f.source.deliveryActionId='another-action'],
 ['wrong binding action',f=>f.binding.provenance.actionId='another-action'],
 ['wrong binding artifact',f=>f.binding.artifactId=f.current.id],
 ['wrong binding target',f=>f.binding.target='https://example.invalid/other'],
 ['wrong binding revision',f=>f.binding.revisionId='27'],
 ['wrong binding resource',f=>f.binding.resourceKey='other'],
 ['wrong binding provenance',f=>f.binding.provenance.kind='model_text'],
 ['body changed after binding',f=>f.source.content+='\nUntrusted replacement'],
 ['missing body digest',f=>delete f.binding.contentHash],
 ['source removed from job',f=>f.job.sourceIds=[]],
 ['source belongs to sibling',f=>f.source.taskId='sibling'],
 ['source belongs to other job',f=>f.source.agentJobId='other-job'],
 ['contradictory source jobs',f=>f.source.jobId='other-job'],
 ['source belongs to other project',f=>f.source.projectId='other-project'],
 ['task belongs to other job',f=>f.task.agentJobId='other-job'],
 ['task removed from job',f=>f.job.taskIds=[]],
 ['artifact belongs to other task',f=>f.artifact.taskId='sibling'],
 ['artifact belongs to other project',f=>f.artifact.projectId='other-project'],
 ['artifact deleted',f=>f.artifact.deletedAt='deleted'],
 ['task deleted',f=>f.task.deletedAt='deleted'],
 ['task cancelled',f=>f.task.agentCancelled=true],
 ['job deleted',f=>f.job.deletedAt='deleted'],
 ['job cancelled',f=>f.job.status='cancelled'],
 ['task archived',f=>f.task.archivedAt='archived'],
 ['job archived',f=>f.job.status='archived'],
 ['binding withdrawn',f=>f.binding.state='withdrawn'],
 ['binding ID withdrawn',f=>f.task.withdrawnBindingIds=[f.binding.bindingId]],
 ['purpose withdrawn',f=>f.task.contextWithdrawals=[{key:hash({sourceId:f.source.id,purpose:'delivery_readback'})}]],
 ['source deleted',f=>f.source.deleted=true],
 ['source withdrawn',f=>f.source.withdrawn=true],
 ['source state withdrawn',f=>f.source.state='withdrawn'],
 ['source retention deleted',f=>f.source.retention='deleted'],
 ['source excluded',f=>f.source.projectExcluded=true],
 ['source body deleted',f=>f.source.contentDeleted=true],
 ['source deletion tombstone',f=>f.a.data.sourceDeletions=[{sourceId:f.source.id}]],
 ['project archived through job',f=>f.a.data.projects.push({id:'archived',jobId:f.job.id,archivedAt:'archived'})],
 ['project archived through rule',f=>{f.job.ruleId='rule';f.a.data.workRules=[{id:'rule',config:{projectId:'archived'}}];f.a.data.projects.push({id:'archived',archivedAt:'archived'});}],
 ])test('historical proof rejects '+label+' even with an explicit local snapshot grant',t=>{
 const f=fixture(t);policy.grant(f.a,snapshotSpec(f),trusted);change(f);denied(f);
});

test('same-job sibling, cross-job, and unscoped requests cannot borrow the original task proof',t=>{
 const f=fixture(t),sibling={id:'sibling',agentJobId:f.job.id,sourceIds:[],steps:[]};
 f.a.data.tasks.push(sibling);f.job.taskIds.push(sibling.id);
 denied({...f,scope:context.taskScope(sibling)});
 sibling.contextBindings=[{...structuredClone(f.binding),taskId:sibling.id}];
 denied({...f,scope:context.taskScope(sibling)});
 const foreign={id:'foreign-job',taskIds:[],sourceIds:[f.source.id]};f.a.data.delegations.push(foreign);
 denied({...f,scope:{kind:'job',jobId:foreign.id}});
 const result=context.resolveRead(f.a,f.scope,{...f.request,taskId:sibling.id});assert.equal(result.code,'CONTEXT_INVALID_REQUEST');
 assert.equal(read(f).ok,true);
});

for(const operation of operations)for(const scope of ['task','job','unscoped'])test(operation+' snapshot revocation at '+scope+' scope defeats collection fallback',t=>{
 const f=fixture(t),resourceScope=scope==='task'?{jobId:f.job.id,taskId:f.task.id}:scope==='job'?{jobId:f.job.id}:{};
 assert.equal(read(f).ok,true);policy.revoke(f.a,{...snapshotSpec(f,resourceScope),operations:[operation]},trusted);denied(f);
});
for(const operation of operations)for(const scope of ['task','job'])test(operation+' collection revocation at '+scope+' scope remains denied',t=>{
 const f=fixture(t),resourceScope={jobId:f.job.id,...(scope==='task'?{taskId:f.task.id}:{})};
 policy.revoke(f.a,{...collectionSpec(f,resourceScope),operations:[operation]},trusted);denied(f);
});
for(const failure of ['missing','corrupt','migration missing'])test('policy store '+failure+' cannot be recovered from the readback receipt',t=>{
 const f=fixture(t);assert.equal(read(f).ok,true);
 if(failure==='missing')fs.unlinkSync(policy.locations(f.a).store);
 else if(failure==='corrupt')fs.writeFileSync(policy.locations(f.a).store,'{}');
 else fs.unlinkSync(policy.locations(f.a).migration);
 denied(f);
});

test('unknown/denied caller policy and asynchronous callbacks cannot be bypassed',t=>{
 const f=fixture(t);
 for(const result of [{decision:'deny'},{decision:'unknown'},{decision:'unknown',code:'ACCESS_POLICY_UNKNOWN',policyId:null,grantRevision:0},Promise.resolve({decision:'allow'})])denied(f,{checkAccess:()=>result});
 f.a.contextAccessCheck=()=>({decision:'deny'});denied(f);
});

test('missing historical binding is not recreated from mere job membership or body IDs',t=>{
 const f=fixture(t);f.task.contextBindings=[];
 denied(f);assert.deepEqual(f.task.contextBindings,[]);
});

test('job reads still enforce originating task revocation; completed history remains historical',t=>{
 const f=fixture(t);f.task.status='completed';f.job.status='completed';
 const jobScope={kind:'job',jobId:f.job.id};
 assert.equal(context.resolveRead(f.a,jobScope,f.request).state,'historical');
 policy.revoke(f.a,{...collectionSpec(f),operations:['local_read']},trusted);
 denied({...f,scope:jobScope});
});

test('revocation and withdrawal between page checks invalidate cached reads',t=>{
 const f=fixture(t),old=read(f);assert.equal(old.ok,true);
 const batch=context.readContextBatch(f.a,f.scope,[f.request],{onRead(){policy.revoke(f.a,{...snapshotSpec(f),operations:['local_read']},trusted);}});
 assert.equal(batch.complete,false);assert.equal(batch.rows[0].result.ok,false);
 assert.equal(context.validRead(f.a,f.scope,{request:f.request,result:old}),false);
});

test('withdrawal during final access callback cannot leak historical content',t=>{
 const f=fixture(t),check=f.a.contextAccessCheck;let reads=0;
 f.a.contextAccessCheck=input=>{const result=check(input);if(input.objectId===f.source.id&&++reads===2)f.task.withdrawnBindingIds=[f.binding.bindingId];return result;};
 const result=read(f);assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/历史证据段落/);
});

test('ambiguous delivery ancestry cannot turn an invalid active proof into readable history',t=>{
 const f=fixture(t);f.task.steps[0].artifactId=f.artifact.id;f.binding.state='active';
 // A split ancestry can classify a leaf as history after the initial policy read.
 const parent={id:'parent',agentJobId:f.job.id,content:'parent',principalScope:f.source.principalScope};
 const sibling={id:'branch',agentJobId:f.job.id,content:'branch',principalScope:f.source.principalScope,previousSourceId:parent.id};
 f.a.data.sources.push(parent,sibling);f.job.sourceIds.push(parent.id,sibling.id);f.source.previousSourceId=parent.id;
 assert.equal(read(f).state,'historical');assert.equal(read(f).delivery.artifactId,f.artifact.id);
 f.source.content+='\nChanged without a matching receipt';denied(f);
});

test('policy change invalidates a previously pinned historical catalog',t=>{
 const f=fixture(t),before=context.buildContext(f.a,f.scope,'verify'),old=read(f);
 policy.grant(f.a,collectionSpec(f),trusted);
 assert.equal(read(f).ok,true);assert.notEqual(read(f).policyRevision,old.policyRevision);
 assert.equal(context.resolveRead(f.a,f.scope,f.request,before.contextRevision).code,'CONTEXT_VERSION_CHANGED');
 assert.equal(context.validRead(f.a,f.scope,{request:f.request,result:old}),false);
});
