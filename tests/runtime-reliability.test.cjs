// Regression scenarios promoted from the v0.35.0 independent audit. All I/O is isolated.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),load=name=>require(path.join(root,'desktop',name+'.cjs'));
const {Assistant}=load('core'),agent=load('agent'),efficiency=load('efficiency'),control=load('execution-control'),obligations=load('work-obligations'),ledger=load('operation-ledger'),platform=load('data-platform'),spend=load('spend'),json=load('model-json'),execution=load('execution'),routing=load('model-routing');
async function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-runtime-audit-')));
 const a=new Assistant({dir,chat:async()=>{throw Error('Unexpected model call');},connectorRequest:async()=>{throw Error('Unexpected connector call');}});
 require('./helpers/platform-fixture.cjs').install(a);
 t.after(async()=>{a.stop();await a.runPromise;fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{name:'audit',model:'audit',baseUrl:'https://audit.invalid',inputPrice:1,outputPrice:1});
 const j=agent.buildJob(a,{goal:'核对所有上下游并交付完整报告',dataPlatform:'sg-readonly',maxActions:12});a.data.delegations.push(j);
 const args={key:'report',title:'报告',criteria:'必须包含上下游关系',steps:[{key:'draft',title:'整理正文',kind:'draft'}]};
 const {taskId}=await agent.act(a,j,'plan_task',args),task=a.task(taskId);return {a,j,task,args,dir};
}
async function guarded(f,tool,args){const before=efficiency.progress(f.a,f.j),step={tool,args};step.result=await agent.act(f.a,f.j,tool,args);control.after(f.a,f.j,step);efficiency.checkProgress(f.a,f.j,step,before);return step.result;}
async function mount(f){const repo=path.join(f.dir,'repo');fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,'AGENTS.md'),'# Capability\nRead this repository guidance.\n');const p=await f.a.dispatch('capabilityInspect',{kind:'repository',path:repo});await f.a.dispatch('capabilitySave',{token:p.token,allowedTools:p.tools.map(t=>t.name),trusted:true});const c=f.a.data.capabilities[0];await f.a.dispatch('capabilityGrant',{jobId:f.j.id,capabilityIds:[c.id]});return {c,repo};}
test('AUDIT-01 unchanged capability reads must not count as new evidence indefinitely',async t=>{
 const f=await fixture(t),{c}=await mount(f),rows=[];let stopped;
 for(let i=0;i<8;i++)try{const before=efficiency.progress(f.a,f.j),r=await guarded(f,'capability_call',{capabilityId:c.id,tool:'read_document',input:{path:'AGENTS.md'}});rows.push({sourceId:r.sourceId,recordId:r.recordId,resultHash:load('evidence-basis').hash(r.result),version:r.usedVersion.contentRevision,changed:before!==efficiency.progress(f.a,f.j),stallCount:f.j.progressGuard?.count||0});}catch(e){stopped=e.code;break;}
 assert.equal(stopped,'NO_NEW_EVIDENCE','identical capability reads never tripped the progress guard');
 assert.equal(new Set(rows.map(r=>r.sourceId)).size,1);assert.equal(rows[0].changed,true);assert.ok(rows.slice(1).every(r=>r.changed===false));
});
test('AUDIT-02 fresh repository changes remain readable with the existing capability grant',async t=>{
 const f=await fixture(t),{c,repo}=await mount(f),args={capabilityId:c.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const before=await agent.act(f.a,f.j,'capability_call',args);fs.appendFileSync(path.join(repo,'AGENTS.md'),'NEW FACT\n');const after=await agent.act(f.a,f.j,'capability_call',args);
 assert.notEqual(before.usedVersion.contentRevision,after.usedVersion.contentRevision);assert.match(after.result.content,/NEW FACT/);
});
test('AUDIT-03 user-edited task criteria must update authoritative requirements',async t=>{
 const f=await fixture(t),before=structuredClone(obligations.requirements(f.a,f.j).find(r=>r.taskId===f.task.id));
 await f.a.dispatch('updateTask',{id:f.task.id,criteria:'必须包含全部上下游关系，以及每个最终输出的负责人和交接联系人'});
 const after=obligations.requirements(f.a,f.j).find(r=>r.taskId===f.task.id);assert.equal(after.text,f.task.criteria);assert.notEqual(after.revision,before.revision);
});
test('AUDIT-04 transient CLI error must expire within the same authorization and scope',async t=>{
 const f=await fixture(t);let calls=0;f.a.platformRequest=async()=>{calls++;if(calls===1)return platform.parse(JSON.stringify({status:'error',error:{code:429,message:'Too Many Requests'}}));return {owner:'alice'};};
 const args={queries:[{op:'task',taskId:42}]};const first=(await agent.act(f.a,f.j,'platform_query',args)).results[0];
 for(const op of Object.values(ledger.state(f.j).operations)){op.completedAt='2020-01-01';op.retryAt='2020-01-01';}
 const second=(await agent.act(f.a,f.j,'platform_query',args)).results[0];
 assert.equal(first.errorCode,'TRANSIENT');assert.ok(second.sourceId,'even after waiting/backoff, the transient error stayed cached without a retry');assert.equal(calls,2);
});
test('AUDIT-05 accepted permission frontier must reopen after permission revision',async t=>{
 const f=await fixture(t);f.j.executionContract={revision:'scope1',text:'入口任务 IDs: 1\n完整上下游；先保留缺口，完成可访问部分'};
 agent.source(f.a,f.j,'graph','lineage',JSON.stringify({operation:'downstream',query:{op:'downstream',taskId:1,depth:1},data:{nodes:[{id:1,parentRelation:[]},{id:2,parentRelation:[{id:1}]}]}}),{platformSnapshot:true});
 const q={op:'downstream',taskId:2};ledger.state(f.j).operations[ledger.key(f.j,q)]={query:q,epoch:ledger.epoch(f.j),status:'failed',errorCode:'AUTH_REQUIRED',error:'无访问权限'};
 assert.equal(obligations.frontier(f.a,f.j).find(r=>r.nodeId==='2').status,'accepted_boundary');ledger.state(f.j).permissionRevision++;
 const row=obligations.frontier(f.a,f.j).find(r=>r.nodeId==='2');control.escape(f.a,f.j,Object.assign(Error('没有新证据'),{code:'NO_NEW_EVIDENCE'}));const escapeTool=ledger.state(f.j).forcedNext?.tool;
 f.a.platformRequest=async()=>({nodes:[{id:2}]});const directRetry=(await agent.act(f.a,f.j,'platform_query',{queries:[q]})).results[0];assert.equal(row.status,'unexpanded');assert.equal(escapeTool,'platform_query');assert.ok(directRetry.sourceId);
});
test('AUDIT-06 alternating known platform reads still halt across saved restart',async t=>{
 const f=await fixture(t);f.a.platformRequest=async args=>({taskName:args.join(' ')});const q1={op:'task',taskId:1},q2={op:'task',taskId:2};await guarded(f,'platform_query',{queries:[q1,q2]});await guarded(f,'platform_query',{queries:[q1]});await guarded(f,'platform_query',{queries:[q2,q1]});f.a.save();
 const restored=new Assistant({dir:f.dir,platformRequest:f.a.platformRequest});restored.platformRequest=f.a.platformRequest;
 // Unknown-account caches are intentionally run-local, so exercise the durable read guard.
 const state=restored.data.delegations[0],source=state.sourceIds[0],ff={...f,a:restored,j:state};
 await guarded(ff,'read_source',{sourceId:source});await guarded(ff,'read_source',{sourceId:source});await assert.rejects(guarded(ff,'read_source',{sourceId:source}),e=>e.noProgress);
});
test('AUDIT-07 transient timeout does retry when the stored delay expires',async t=>{
 const f=await fixture(t);let n=0;f.a.platformRequest=async()=>{if(++n===1)throw Error('network timeout');return {owner:'alice'};};const args={queries:[{op:'task',taskId:4}]};
 const one=(await agent.act(f.a,f.j,'platform_query',args)).results[0];assert.equal(one.errorCode,'TRANSIENT');await agent.act(f.a,f.j,'platform_query',args);assert.equal(n,1);
 Object.values(ledger.state(f.j).operations)[0].retryAt='2020-01-01';assert.ok((await agent.act(f.a,f.j,'platform_query',args)).results[0].sourceId);assert.equal(n,2);
});
test('AUDIT-08 malformed JSON repair uses one original spend scope with unknown usage reserved',async t=>{
 const f=await fixture(t);f.a.activeAgentJob=f.j;let calls=0;f.a.chat=async(p,k,m,o)=>{if(++calls===1)return json.parse('{');o.onUsage({inputTokens:91,outputTokens:11,cachedInputTokens:10});return {ok:true};};
 const result=await f.a.callModel(f.a.data.providers[0],'',[{role:'user',content:'audit'}],{role:'execute',stage:'task_work'});assert.equal(result.ok,true);assert.equal(calls,2);assert.equal(Object.keys(f.a.spendLedger.scopes).length,1);const s=f.a.spendLedger.scopes['job:'+f.j.id];assert.equal(s.limitUSD,100);assert.ok(s.heldUSD>0);assert.equal(s.usage.unknownCalls,1);assert.equal(s.usage.reportedCalls,1);assert.equal(spend.unsettled(s),0);f.a.activeAgentJob=null;
});
test('AUDIT-09 sufficient consumed spend prevents a new model request across restart',async t=>{
 const f=await fixture(t);f.a.activeAgentJob=f.j;spend.scope(f.a).spentUSD=100;spend.persist(f.a);f.a.activeAgentJob=null;f.a.save();let calls=0;const restored=new Assistant({dir:f.dir,chat:async()=>{calls++;return {ok:true};}});restored.activeAgentJob=restored.data.delegations[0];
 await assert.rejects(restored.callModel(restored.data.providers[0],'',[{role:'user',content:'audit'}],{role:'execute'}),e=>e.spendLimit);assert.equal(calls,0);
});
test('AUDIT-10 cancelling one parallel execution leaves the other token scope intact',async t=>{
 const f=await fixture(t),j2=agent.buildJob(f.a,{goal:'第二项',maxActions:1});f.a.data.delegations.push(j2);const gates=[];
 f.a.chat=async(p,k,m,o)=>new Promise((resolve,reject)=>{const row={o,resolve:()=>{o.onUsage({inputTokens:123,outputTokens:17});resolve({tool:'ask',args:{question:'选择补充方案'}});}};gates.push(row);o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true});});
 execution.launch(f.a,{jobId:f.j.id},'first',view=>agent.run(view,f.j.id));execution.launch(f.a,{jobId:j2.id},'second',view=>agent.run(view,j2.id));for(let i=0;i<100&&gates.length<2;i++)await new Promise(r=>setTimeout(r,5));assert.equal(gates.length,2);
 execution.abortJob(f.a,f.j.id);assert.equal(gates[1].o.signal.aborted,false);gates[1].resolve();await f.a.runPromise;
 assert.equal(f.j.status,'paused');assert.equal(j2.status,'needs_input');assert.equal(f.a.spendLedger.scopes['job:'+j2.id].usage.inputTokens,123);assert.equal(f.a.spendLedger.scopes['job:'+j2.id].heldUSD,0);assert.ok(f.a.spendLedger.scopes['job:'+f.j.id].heldUSD>0);
});
test('AUDIT-11 planner and editorial requests remain economy while lineage verification is analysis',()=>{
 const payload={goal:'分析全部上下游血缘',currentStep:{title:'压缩正文',kind:'draft'}};
 assert.equal(routing.classify(payload,'execute','planner').tier,'economy');assert.equal(routing.classify(payload,'execute','task_work').tier,'economy');assert.equal(routing.classify(payload,'verify','task_verify').tier,'analysis');
});
test('AUDIT-12 exact unchanged draft rereads are bounded even when interleaved with other reads',async t=>{
 const f=await fixture(t),s=agent.source(f.a,f.j,'text','材料','静态正文');f.task.sourceIds.push(s.id);const artifact={id:'audit-artifact',taskId:f.task.id,stepId:f.task.steps[0].id,title:'稿件',content:'静态稿件'};f.a.data.artifacts.push(artifact);
 for(let i=0;i<2;i++){await guarded(f,'read_source',{sourceId:s.id});await guarded(f,'read_artifact',{artifactId:artifact.id});}await assert.rejects(guarded(f,'read_artifact',{artifactId:artifact.id}),e=>e.noProgress);
});
test('AUDIT-13 reordering identical gap evidence must not reset failed-repair counts',async t=>{
 const f=await fixture(t),repair=load('repair-progress'),s1=agent.source(f.a,f.j,'a','A','同一组已知事实 A'),s2=agent.source(f.a,f.j,'b','B','同一组已知事实 B');f.task.sourceIds.push(s1.id,s2.id);let failure;const counts=[];
 for(let i=0;i<8;i++){const ids=i%2?[s1.id,s2.id]:[s2.id,s1.id],text='仍缺少最终输出消费者的联系信息';try{repair.check(f.a,f.j,{tool:'advance_task',args:{taskId:f.task.id},result:{verification:{passed:false,gaps:[text],gapDetails:[{requirementId:'task:'+f.task.id,text,sourceIds:ids}]}}});counts.push(ledger.state(f.j).gaps[0].count);}catch(e){failure=e.code;break;}}assert.equal(failure,'UNRESOLVED_GAPS');
 assert.deepEqual(counts,[1,2,3]);
});

function readyArtifact(f){const step=f.task.steps[0],r={id:'current-artifact',taskId:f.task.id,stepId:step.id,title:'报告',content:'已核对的业务正文',createdAt:new Date().toISOString()};f.a.data.artifacts.push(r);Object.assign(step,{done:true,artifactId:r.id});f.task.status='todo';return r;}
test('User requirements survive model plan rewording and remain in generation and verification context',async t=>{
 const f=await fixture(t),criteria='必须核对全部上下游，并列出每个最终输出负责人';
 await f.a.dispatch('updateTask',{id:f.task.id,criteria,description:'仅 SG 范围',objective:'准备完整交接'});
 const revision=f.task.userRequirement.revision;
 await agent.act(f.a,f.j,'plan_task',{...f.args,criteria:'仅梳理入口任务即可',description:'任意区域',objective:'只写摘要',reason:'模型重新描述计划'});
 assert.equal(obligations.requirements(f.a,f.j).find(r=>r.taskId===f.task.id).text,criteria);
 for(const verification of [false,true]){const ctx=f.a.context(f.task,{verification});assert.equal(ctx.task.criteria,criteria);assert.equal(ctx.task.description,'仅 SG 范围');assert.equal(ctx.task.objective,'准备完整交接');}
 assert.equal(f.task.userRequirement.revision,revision);
});
test('Priority changes leave user scope revision and accepted gaps intact',async t=>{
 const f=await fixture(t);await f.a.dispatch('updateTask',{id:f.task.id,criteria:'允许保留无法访问的节点并说明原因'});
 const requirement=obligations.requirements(f.a,f.j).find(r=>r.taskId===f.task.id),revision=requirement.revision;
 const [gap]=obligations.record(f.a,f.j,requirement.id,{passed:false,gaps:['节点没有访问权限']});
 control.answer(f.a,f.j,{answer:'保留已知缺口并完成可访问部分',executionGapIds:[gap.id],answeredAt:new Date().toISOString(),id:'decision'});
 await f.a.dispatch('updateTask',{id:f.task.id,priority:'high'});
 assert.equal(obligations.requirements(f.a,f.j).find(r=>r.taskId===f.task.id).revision,revision);assert.equal(gap.status,'accepted_gap');
 await f.a.dispatch('updateTask',{id:f.task.id,criteria:'本次要求补齐所有节点，没有权限必须先解决'});
 obligations.requirements(f.a,f.j);assert.equal(gap.status,'superseded');
});
test('A late task verification cannot certify evidence that changed during its request',async t=>{
 const f=await fixture(t),s=agent.source(f.a,f.j,'facts','资料','原始事实');f.task.sourceIds.push(s.id);const draft=readyArtifact(f);let calls=0;
 f.a.call=async()=>{calls++;s.content='后来修正的事实';return {passed:true,summary:'旧输入通过',gaps:[]};};
 // advance records non-model protocol errors on the task; it must never accept the late check.
 await f.a.advance(f.task.id);assert.equal(calls,1);assert.equal(f.task.status,'blocked');assert.match(f.task.lastError,/变化|重新|旧|stale/i);assert.notEqual(f.task.verification?.passed,true);assert.equal(f.a.data.artifacts.find(r=>r.id===draft.id).content,'已核对的业务正文');
 const restored=new Assistant({dir:f.dir}),task=restored.task(f.task.id);assert.equal(task.status,'blocked');assert.notEqual(task.verification?.passed,true);
});
test('A late goal verification cannot complete changed task output',async t=>{
 const f=await fixture(t),r=readyArtifact(f);f.task.status='review';f.task.verification={passed:true,summary:'通过',gaps:[],basis:load('acceptance').basis(f.a,f.task)};
 f.a.callModel=async()=>{r.content='检查进行期间更正的正文';return {passed:true,summary:'整体通过',gaps:[]};};
 await assert.rejects(agent.act(f.a,f.j,'complete',{}),/变化|重新|旧|stale/i);assert.notEqual(f.j.status,'completed');assert.notEqual(f.j.status,'review');
});
test('A late content check rejects a requirement edit and retains the existing draft',async t=>{
 const f=await fixture(t),r=readyArtifact(f);f.a.call=async()=>{load('requirements').edit(f.task,{criteria:'新完成标准'});f.task.criteria='新完成标准';return {passed:true,summary:'旧输入通过',gaps:[]};};
 await assert.rejects(control.verifyContent(f.a,f.j,f.task),/变化|重新|旧|stale/i);assert.equal(f.task.contentVerification,undefined);assert.equal(f.a.data.artifacts[0],r);assert.equal(r.content,'已核对的业务正文');
});
test('A delayed platform result after permission changes is historical and cannot create current evidence',async t=>{
 const f=await fixture(t);f.a.platformRequest=async()=>{ledger.state(f.j).permissionRevision++;return {owner:'alice'};};
 const r=await agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:17}]});assert.ok(r.results[0].error);assert.equal(r.results[0].sourceId,undefined);assert.equal(f.j.sourceIds.length,0);assert.equal(Object.values(ledger.state(f.j).operations)[0].status,'superseded');
});
test('Changed capability evidence invalidates an already checked task without deleting the saved draft',async t=>{
 const f=await fixture(t),{c,repo}=await mount(f),args={capabilityId:c.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const first=await agent.act(f.a,f.j,'capability_call',args);f.task.sourceIds.push(first.sourceId);const draft=readyArtifact(f);f.task.status='review';f.task.verification={passed:true,summary:'通过',gaps:[],basis:load('acceptance').basis(f.a,f.task)};
 fs.appendFileSync(path.join(repo,'AGENTS.md'),'修正了重要依据\n');const next=await agent.act(f.a,f.j,'capability_call',args);
 assert.notEqual(next.sourceId,first.sourceId);assert.ok(f.task.sourceIds.includes(next.sourceId));assert.ok(f.task.supersededSourceIds.includes(first.sourceId));assert.ok(f.task.needsReplan);assert.notEqual(f.task.verification?.passed,true);assert.ok(f.a.data.artifacts.includes(draft));
});
test('Migrated capability calls reuse known exact parameters without merging unrelated historical sources',async t=>{
 const f=await fixture(t),{c}=await mount(f),args={capabilityId:c.id,tool:'read_document',input:{path:'AGENTS.md'}};
 const first=await agent.act(f.a,f.j,'capability_call',args),s=f.a.data.sources.find(s=>s.id===first.sourceId);delete s.resourceKey;s.identity='capability:'+first.recordId;
 const unrelated=agent.source(f.a,f.j,'capability:untraceable','历史','不能确认调用参数',{capabilityId:c.id});
 f.a.data.agentRuns.unshift({id:'historical-run',jobId:f.j.id,steps:[{tool:'capability_call',args,result:first}]});f.a.save();
 const restored=new Assistant({dir:f.dir}),j=restored.data.delegations.find(j=>j.id===f.j.id);const next=await agent.act(restored,j,'capability_call',args);
 assert.equal(next.sourceId,first.sourceId);assert.equal(restored.data.sources.find(x=>x.id===unrelated.id).resourceKey,undefined);assert.equal(j.sourceIds.length,2);
});
test('Reopening preserves unknown reservations and marks interrupted operations retryable',async t=>{
 const f=await fixture(t),q={op:'task',taskId:99};f.a.activeAgentJob=f.j;const ticket=spend.reserve(f.a,f.a.data.providers[0],[{role:'user',content:'pending'}]);f.a.activeAgentJob=null;
 ledger.state(f.j).operations[ledger.key(f.j,q)]={query:q,epoch:ledger.epoch(f.j),status:'running',startedAt:new Date().toISOString()};f.j.executionState.migrated='legacy';f.a.save();
 const restored=new Assistant({dir:f.dir}),j=restored.data.delegations[0],s=restored.spendLedger.scopes['job:'+j.id],op=Object.values(j.executionState.operations)[0];
 assert.equal(op.status,'interrupted');assert.equal(ledger.eligibility(j,op).action,'execute');assert.equal(s.heldUSD,ticket.reservedUSD);assert.equal(s.limitUSD,100);assert.equal(s.usage.unknownCalls,1);assert.equal(Object.keys(s.pending).length,0);
});
test('Legacy unclassified failures expire after restart instead of becoming permanent restrictions',async t=>{
 const f=await fixture(t),q={op:'task',taskId:101};f.a.platformFixture.identity={username:'alice'};await ledger.prepareBatch(f.a,f.j);ledger.state(f.j).operations[ledger.key(f.j,q)]={query:q,epoch:ledger.epoch(f.j),principal:'alice',status:'failed',errorCode:'INVALID_PLATFORM_RESPONSE',error:'旧协议错误',completedAt:'2020-01-01'};f.j.executionState.migrated='legacy';f.a.save();
 const restored=new Assistant({dir:f.dir}),j=restored.data.delegations[0];let requests=0;restored.platformRequest=async args=>{if(args.includes('userinfo'))return {username:'alice'};requests++;return {owner:'alice'};};
 const r=await agent.act(restored,j,'platform_query',{queries:[q]});assert.ok(r.results[0].sourceId);assert.equal(requests,1);
});
test('Restoring an old backup retains the latest explicit user requirements and original spend',async t=>{
 const f=await fixture(t),recovery=load('recovery'),backup=recovery.create(f.a);
 await f.a.dispatch('updateTask',{id:f.task.id,criteria:'新标准：必须核对所有最终输出',objective:'按最新范围交接'});const revision=f.task.userRequirement.revision;
 f.a.activeAgentJob=f.j;spend.scope(f.a).spentUSD=45;spend.persist(f.a);f.a.activeAgentJob=null;f.a.save();
 await f.a.dispatch('backupRestore',{id:backup});const task=f.a.task(f.task.id),j=f.a.data.delegations.find(j=>j.id===f.j.id);
 assert.equal(task.userRequirement.revision,revision);assert.equal(task.criteria,'新标准：必须核对所有最终输出');assert.equal(obligations.requirements(f.a,j).find(r=>r.taskId===task.id).text,task.criteria);assert.equal(f.a.spendLedger.scopes['job:'+j.id].spentUSD,45);assert.equal(j.status,'paused');
});
test('Restoring old resolved followups reopens when a later descendant replaced their evidence',async t=>{
 const f=await fixture(t),s1=agent.source(f.a,f.j,'confirmation','确认','同意方案');f.j.followups.push({key:'confirm',expected:'同意方案',status:'resolved',sourceId:s1.id,evidence:'同意方案',resolvedAt:new Date().toISOString()});
 const backup=load('recovery').create(f.a);agent.source(f.a,f.j,'confirmation','确认','撤回同意');const latest=agent.source(f.a,f.j,'confirmation','确认','重新讨论方案');f.a.save();
 await f.a.dispatch('backupRestore',{id:backup});const j=f.a.data.delegations.find(j=>j.id===f.j.id),followup=j.followups[0];assert.equal(followup.status,'waiting');assert.equal(followup.sourceId,undefined);assert.equal(followup.previousResolutions[0].sourceId,s1.id);assert.ok(f.a.data.sources.some(s=>s.id===latest.id));
});
test('Semantically identical capability source aliases cannot reset a gap counter',async t=>{
 const f=await fixture(t),s=agent.source(f.a,f.j,'stable','证据','相同正文',{resourceKey:'same-resource'}),copy={...s,id:'legacy-alias',identity:'legacy-call',lastCheckedAt:'different'};f.a.data.sources.push(copy);f.j.sourceIds.push(copy.id);f.task.sourceIds.push(s.id,copy.id);
 const key='task:'+f.task.id,text='仍缺少最终消费者';for(const ids of [[s.id],[copy.id,copy.id],[copy.id,s.id]])obligations.record(f.a,f.j,key,{passed:false,gaps:[text],gapDetails:[{requirementId:key,text,sourceIds:ids}]});assert.equal(ledger.state(f.j).gaps[0].count,3);
});
test('Late confirmation validation cannot resolve a wait using a replaced reply',async t=>{
 const f=await fixture(t),followup=load('agent-followup'),url='https://fixture.invalid/status';
 const read=content=>agent.watch(f.a,f.j,'read_url',{url},{url,title:'审核结果',content});
 const first=read('等待审核');followup.wait(f.a,f.j,{key:'approval',reason:'等待批准',expected:'明确批准方案',sourceIds:[first.sourceId]});const approved=read('已明确批准方案');
 f.a.callModel=async()=>{read('撤回此前批准，需要重新审核');return {satisfied:true,quote:'已明确批准方案',reason:'旧材料显示批准'};};
 await assert.rejects(followup.resolve(f.a,f.j,{key:'approval',sourceId:approved.sourceId,evidence:'明确批准'}),/变化|重新|旧|stale/i);assert.equal(f.j.followups[0].status,'waiting');assert.equal(f.j.followups[0].claim,undefined);
});
test('An unverified-account failure cannot block the frontier after the current account is established',async t=>{
 const f=await fixture(t),q={op:'downstream',taskId:2,depth:1};
 agent.source(f.a,f.j,'graph','lineage',JSON.stringify({operation:'downstream',query:{op:'downstream',taskId:1,depth:1},data:{nodes:[{id:1},{id:2}]}}),{platformSnapshot:true});
 ledger.state(f.j).operations[ledger.key(f.j,q)]={query:q,epoch:ledger.epoch(f.j),principal:null,status:'failed',errorCode:'AUTH_REQUIRED',error:'原未知账号没有权限'};
 f.a.platformFixture.identity={username:'newly-verified-user'};await ledger.prepareBatch(f.a,f.j);assert.equal(ledger.lookup(f.a,f.j,q),null);assert.equal(obligations.frontier(f.a,f.j).find(r=>r.nodeId==='2').status,'unexpanded');
});
test('Typed platform failures keep retry-after timing and do not expose diagnostic credentials',async t=>{
 const f=await fixture(t);f.a.platformRequest=async()=>platform.parse(JSON.stringify({status:'error',error:{code:503,message:'Bearer PRIVATE_TOKEN',retry_after:120}}));const started=Date.now();
 const r=(await agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:7}]})).results[0],op=Object.values(ledger.state(f.j).operations)[0];
 assert.equal(r.errorCode,'TRANSIENT');assert.ok(Date.parse(op.retryAt)>=started+120000);assert.doesNotMatch(JSON.stringify(op),/PRIVATE_TOKEN/);assert.equal(ledger.eligibility(f.j,op,Date.parse(op.retryAt)-1).action,'wait_until');assert.equal(ledger.eligibility(f.j,op,Date.parse(op.retryAt)).action,'execute');
});
test('Missing platform resources request input repair instead of retrying the identical query forever',async t=>{
 const f=await fixture(t);let calls=0;f.a.platformRequest=async()=>{calls++;return platform.parse(JSON.stringify({status:'error',error:{code:1004,message:'Dorado API error: 任务不存在:7'}}));};
 const args={queries:[{op:'task',taskId:7}]},first=(await agent.act(f.a,f.j,'platform_query',args)).results[0];
 const op=Object.values(ledger.state(f.j).operations)[0];assert.equal(first.errorCode,'NOT_FOUND');assert.equal(op.providerCode,1004);assert.equal(op.retryAt,undefined);
 op.completedAt='2000-01-01T00:00:00.000Z';assert.equal(ledger.eligibility(f.j,op).action,'repair_input');
 const second=(await agent.act(f.a,f.j,'platform_query',args)).results[0];assert.equal(second.reused,true);assert.equal(second.errorCode,'NOT_FOUND');assert.equal(calls,1);assert.equal(f.a.data.decisions.length,0);
 await agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:8}]});assert.equal(calls,2,'a corrected resource identifier must remain queryable');
});
test('A genuinely changed related source permits repair without unrelated source resets',async t=>{
 const f=await fixture(t),s=agent.source(f.a,f.j,'facts','依据','尚未给出负责人'),key='task:'+f.task.id,text='缺少最终输出负责人';f.task.sourceIds.push(s.id);
 const check=()=>obligations.record(f.a,f.j,key,{passed:false,gaps:[text],gapDetails:[{requirementId:key,text,sourceIds:[s.id]}]})[0];assert.equal(check().count,1);assert.equal(check().count,2);
 agent.source(f.a,f.j,'unrelated','无关','改变了无关背景');assert.equal(check().count,3);s.content='新增最终输出负责人信息';assert.equal(check().count,1);
});
test('Ignored repository-tool parameters and equivalent defaults cannot create fresh evidence identities',async t=>{
 const f=await fixture(t),{c}=await mount(f),results=[];let stopped;
 for(let i=0;i<8;i++)try{results.push(await guarded(f,'capability_call',{capabilityId:c.id,tool:'read_document',input:{path:'AGENTS.md',...(i?{start:0,note:'planner explanation '+i}:{})}}));}catch(e){stopped=e.code;break;}
 assert.equal(new Set(results.map(r=>r.sourceId)).size,1);assert.equal(stopped,'NO_NEW_EVIDENCE');
});
test('Refreshing lineage statistics alone cannot renew material progress in a lineage-only task',async t=>{
 const f=await fixture(t);let requests=0,stop;
 f.a.platformRequest=async()=>({guidEntityMap:{table:{guid:'table',typeName:'hive_table',attributes:{name:'out',owner:'alice',tableSize:++requests}}}});
 for(let n=0;n<8;n++){
  for(const op of Object.values(ledger.state(f.j).operations))op.completedAt='2020-01-01';
  try{await guarded(f,'platform_query',{queries:[{op:'table_lineage',database:'db',table:'out'}]});}catch(e){stop=e;break;}
 }
 assert.equal(stop?.code,'NO_NEW_EVIDENCE');
});
test('A requested table-size change remains new evidence for a size-analysis task',async t=>{
 const f=await fixture(t);f.j.goal='核对表血缘和表大小变化';let requests=0;
 f.a.platformRequest=async()=>({guidEntityMap:{table:{guid:'table',typeName:'hive_table',attributes:{name:'out',owner:'alice',tableSize:++requests}}}});
 for(let n=0;n<4;n++){
  for(const op of Object.values(ledger.state(f.j).operations))op.completedAt='2020-01-01';
  const before=efficiency.progress(f.a,f.j);await guarded(f,'platform_query',{queries:[{op:'table_lineage',database:'db',table:'out'}]});assert.notEqual(efficiency.progress(f.a,f.j),before);
 }
 assert.equal(requests,4);assert.equal(f.j.progressGuard,undefined);
});
