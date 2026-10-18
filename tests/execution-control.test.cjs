const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),efficiency=require('../desktop/efficiency.cjs'),acceptance=require('../desktop/acceptance.cjs'),cache=require('../desktop/verification-cache.cjs'),repair=require('../desktop/repair-progress.cjs'),access=require('../desktop/access.cjs'),decisions=require('../desktop/decisions.cjs'),control=require('../desktop/execution-control.cjs'),ledger=require('../desktop/operation-ledger.cjs'),obligations=require('../desktop/work-obligations.cjs');
async function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-control-')));
 const a=new Assistant({dir,chat:async()=>{throw Error('Unexpected model call');},connectorRequest:async()=>{throw Error('Unexpected connector call');}});
 require('./helpers/platform-fixture.cjs').install(a);
 t.after(()=>{access.cancel(a);fs.rmSync(dir,{recursive:true,force:true});});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid',inputPrice:0,outputPrice:0});
 const j=agent.buildJob(a,{goal:'核对已有证据并交付文稿',dataPlatform:'sg-readonly',fileMode:'auto',maxActions:12});a.data.delegations.push(j);
 const args={key:'report',title:'报告',criteria:'符合已确认范围',steps:[{key:'draft',title:'整理主稿',kind:'draft'}]};
 const {taskId}=await agent.act(a,j,'plan_task',args),task=a.task(taskId);return {a,j,task,args,dir};
}
function artifact(f){const r={id:'fixture-artifact',taskId:f.task.id,stepId:f.task.steps[0].id,title:'报告',content:'测试正文',createdAt:'2026-01-01T00:00:00Z'};f.a.data.artifacts.push(r);Object.assign(f.task.steps[0],{done:true,artifactId:r.id});return r;}
async function guarded(f,tool,args){const before=efficiency.progress(f.a,f.j),step={tool,args};step.result=await agent.act(f.a,f.j,tool,args);efficiency.checkProgress(f.a,f.j,step,before);return step.result;}
test('R1 alternating identical reads are detected across restart without resetting saved work',async t=>{
 const f=await fixture(t),s=agent.source(f.a,f.j,'fixture','资料','相同正文');f.task.sourceIds.push(s.id);artifact(f);
 for(let i=0;i<2;i++){await guarded(f,'read_source',{sourceId:s.id});await guarded(f,'read_artifact',{artifactId:'fixture-artifact'});}f.a.save();
 const restored=new Assistant({dir:f.dir});await assert.rejects(guarded({...f,a:restored,j:restored.data.delegations[0]},'read_source',{sourceId:s.id}),e=>e.noProgress);
 assert.equal(restored.data.artifacts[0].content,'测试正文');
});
test('R2 reordered query batches reuse individual results and cannot bypass the loop guard',async t=>{
 const f=await fixture(t);let calls=0;f.a.platformRequest=async()=>{calls++;return {owner:'fixture'};};
 const q1={op:'task',taskId:1},q2={op:'task',taskId:2};await guarded(f,'platform_query',{queries:[q1,q2]});assert.equal(calls,2);
 await guarded(f,'platform_query',{queries:[q2,q1]});await guarded(f,'platform_query',{queries:[q1,q2]});
 await assert.rejects(guarded(f,'platform_query',{queries:[q2,q1]}),e=>e.noProgress);assert.equal(calls,2);assert.equal(f.a.data.sources.length,2);
});
test('R3 refresh of identical facts preserves acceptance and chunk verification cache',async t=>{
 const f=await fixture(t);f.a.platformRequest=async()=>({owner:'fixture'});
 const query=()=>agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:1}]});const first=(await query()).results[0];f.task.sourceIds.push(first.sourceId);artifact(f);f.task.status='review';f.task.verification={passed:true,summary:'通过',gaps:[],basis:acceptance.basis(f.a,f.task)};
 const before=cache.basis(f.a,f.task);for(const row of Object.values(ledger.state(f.j).operations))row.completedAt='2020-01-01';
 const next=(await query()).results[0];assert.equal(next.sourceId,first.sourceId);assert.equal(next.reused,false);assert.deepEqual(acceptance.reasons(f.a,f.task),[]);assert.equal(cache.basis(f.a,f.task),before);
});
test('R4 cosmetic titles preserve completed steps and never count as progress',async t=>{
 const f=await fixture(t);artifact(f);const before=efficiency.progress(f.a,f.j);
 for(let i=0;i<12;i++)await agent.act(f.a,f.j,'plan_task',{...f.args,title:'报告 '+i,steps:[{key:'draft',title:'换一个标题 '+i,kind:'draft'}]});
 assert.equal(f.task.steps[0].done,true);assert.equal(f.task.steps[0].artifactId,'fixture-artifact');assert.equal(f.task.planVersion,1);assert.equal(efficiency.progress(f.a,f.j),before);
});
test('R5 actual authorization does not invalidate a prepared plan or current check basis',async t=>{
 const f=await fixture(t);artifact(f);const before=acceptance.basis(f.a,f.task);
 f.a.connectorRequest=async args=>{assert.equal(args[1],'status');return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_fixture',scope:access.scopes('my_library').join(' ')}}};};
 const r=access.request(f.a,f.j,{kind:'lark_create',target:'my_library',reason:'交付文档'}),d=f.a.data.decisions.find(d=>d.id===r.decisionId);
 await f.a.dispatch('accessRetry',{id:d.id,revision:decisions.revision(f.a.data,d),createMode:'auto'});await f.a.runPromise;
 assert.equal(d.status,'resolved');assert.ok(f.j.larkCreateGrant);assert.ok(!f.task.needsReplan);assert.equal(f.task.steps[0].artifactId,'fixture-artifact');assert.equal(acceptance.basis(f.a,f.task),before);
});
test('R6 failed structural preconditions are routed to reconciliation and bounded, not generic timed retry',async t=>{
 const f=await fixture(t);artifact(f);f.task.needsReplan='状态前置条件未满足';const before=structuredClone(f.j);f.j.outputFolder=f.dir;f.j.fileMode='auto';require('../desktop/access-policy-store.cjs').syncTrustedJob(f.a,f.j,{before,trusted:true,actor:'user_command',command:'test-output-folder'});
 f.a.chat=async()=>({tool:'write_file',args:{taskId:f.task.id}});await agent.run(f.a,f.j.id);
 assert.equal(f.j.status,'ready');assert.equal(f.j.executionState.recovery.code,'AUTOMATIC_STRATEGY_REPAIR');assert.equal(f.j.progressGuard.count,3);assert.equal(f.a.data.agentActions.length,0);
 assert.equal(f.a.data.decisions.filter(d=>d.status==='open').length,0);assert.equal(f.a.data.agentRuns[0].steps.filter(r=>r.errorCode==='PLAN_RECONCILE_REQUIRED').length,3);
});
test('R7 unrelated sources and reworded criteria cannot renew an unchanged gap',async t=>{
 const f=await fixture(t),step={tool:'complete',args:{},result:{complete:false,gaps:['仍缺少最终文档的正文回读证据']}};
 for(let i=0;i<3;i++){const s=agent.source(f.a,f.j,'irrelevant:'+i,'无关统计','表大小：'+i);f.task.sourceIds.push(s.id);f.task.criteria='相同标准的重新表述 '+i;repair.check(f.a,f.j,step);}
 assert.throws(()=>repair.check(f.a,f.j,step),e=>e.noProgress);assert.equal(f.j.repairProgress.goal.gaps[0].count,4);
});
test('R8 returned plans and event history are immutable snapshots',async t=>{
 const f=await fixture(t),result=await agent.act(f.a,f.j,'plan_task',f.args);artifact(f);assert.equal(result.steps[0].done,false);assert.notEqual(result.steps,f.task.steps);
 const row={tool:'plan_task',result};ledger.event(f.j,row);row.result.steps[0].title='later';assert.notEqual(f.j.executionState.events[0].result.steps[0].title,'later');
});
test('Delivery follows preflight content check, actual write, result check and final check without planner detours',async t=>{
 const f=await fixture(t),before=structuredClone(f.j);f.j.outputFolder=path.join(f.dir,'output');fs.mkdirSync(f.j.outputFolder);f.j.autoAccept=false;f.j.fileMode='auto';require('../desktop/access-policy-store.cjs').syncTrustedJob(f.a,f.j,{before,trusted:true,actor:'user_command',command:'test-output-folder'});
 await agent.act(f.a,f.j,'plan_task',{...f.args,reason:'增加交付',steps:[...f.args.steps,{key:'save',title:'写文件',kind:'external',tool:'write_file'}]});artifact(f);
 const phases=[];f.a.chat=async(p,k,m,o)=>{o.onUsage({inputTokens:10,outputTokens:10});if(m[0].content.includes('动作格式')){phases.push('write');return {tool:'write_file',args:{taskId:f.task.id}};}phases.push(m[0].content.includes('当前文稿内容')?'content':'verify');return {passed:true,summary:'通过',gaps:[]};};
 await agent.run(f.a,f.j.id);assert.equal(f.j.status,'review');assert.equal(f.task.steps[1].done,true);assert.equal(f.a.data.agentActions.filter(r=>r.status==='done').length,1);assert.deepEqual(phases,['content','write','verify','verify']);assert.ok(f.a.data.agentRuns[0].steps.some(s=>s.tool==='advance_task'));
});
test('A configured output obligation prevents auto-completion of an unexported legacy draft',async t=>{
 const f=await fixture(t);artifact(f);f.j.outputFolder=f.dir;f.task.status='review';f.task.verification={passed:true,summary:'通过',gaps:[],basis:acceptance.basis(f.a,f.task)};
 assert.equal(control.next(f.a,f.j),null);
});
test('Account change invalidates cached queries and preserves principal provenance',async t=>{
 const f=await fixture(t);let who='alice',calls=0;f.a.platformFixture.identity={username:who};
 f.a.platformRequest=async()=>{calls++;return {owner:who};};
 await agent.act(f.a,f.j,'platform_query',{queries:[{op:'identity'},{op:'task',taskId:1}]});assert.equal(calls,1);
 await agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:1}]});assert.equal(calls,1);
 who='bob';f.a.platformFixture.identity={username:who};
 await assert.rejects(agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:1}]}),/账号|身份|授权/);assert.equal(calls,1);assert.equal(f.j.platformPrincipal,'alice');
 const policy=require('../desktop/access-policy-store.cjs');
 policy.grant(f.a,{principalScope:{kind:'account',provider:'platform',subject:'bob'},resourceScope:{kind:'platform',key:'sg-readonly',jobId:f.j.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'fixtureReauthorizeAccount'});
 const result=await agent.act(f.a,f.j,'platform_query',{queries:[{op:'task',taskId:1}]});assert.equal(calls,2);assert.equal(result.results[0].reused,false);assert.equal(f.a.data.sources.find(s=>s.id===result.results[0].sourceId).platformPrincipal,'bob');assert.ok(f.a.data.sources.some(s=>s.platformPrincipal==='alice'));
});
test('Typed failed operations are not retried until their conditions change',async t=>{
 const f=await fixture(t);let calls=0;f.a.platformRequest=async()=>{calls++;throw Error('access denied');};
 const q={queries:[{op:'task',taskId:42}]};await agent.act(f.a,f.j,'platform_query',q);const second=await agent.act(f.a,f.j,'platform_query',q);assert.equal(calls,1);assert.equal(second.results[0].errorCode,'AUTH_REQUIRED');assert.equal(second.results[0].reused,true);
 f.j.executionState.permissionRevision++;await agent.act(f.a,f.j,'platform_query',q);assert.equal(calls,2);
});
test('Only an explicit answer to the scoped recovery decision can accept gaps',async t=>{
 const f=await fixture(t);obligations.record(f.a,f.j,'goal',{passed:false,gaps:['项目无读取权限']});
 const r=control.requestHelp(f.a,f.j,Error('同一缺口没有新证据'));const d=f.a.data.decisions.find(d=>d.id===r.decisionId);
 assert.equal(d.executionGapIds.length,1);d.answer='保留已知缺口并完成可访问部分';d.answeredAt=new Date().toISOString();control.answer(f.a,f.j,d);
 f.j.feedback.push({text:d.answer});const ctx=obligations.context(f.a,f.j);assert.equal(ctx.gaps[0].status,'accepted_gap');
});
test('Read-only UI state does not create new runtime state or mutate the stored workspace',async t=>{
 const f=await fixture(t);delete f.j.executionState;const before=JSON.stringify(f.a.data);f.a.publicState();assert.equal(JSON.stringify(f.a.data),before);
});
test('Legacy valid acceptance is rebased without reviving already invalid checks',async t=>{
 const f=await fixture(t);artifact(f);f.task.status='review';f.task.verification={passed:true,summary:'通过',gaps:[],basis:acceptance.basis(f.a,f.task,{legacy:true})};control.initialize(f.a);assert.equal(f.task.verification.basisVersion,2);assert.deepEqual(acceptance.reasons(f.a,f.task),[]);
 f.task.verification={passed:true,summary:'旧结果',gaps:[],basis:'invalid-old-basis'};control.initialize(f.a);assert.equal(f.task.verification.basis,'invalid-old-basis');assert.ok(acceptance.reasons(f.a,f.task).some(r=>r.code==='changed'));
});
test('Same query split across batches is still detected, while new query facts continue',async t=>{
 const f=await fixture(t);f.a.platformRequest=async args=>({value:args.join(' ')});const q1={op:'task',taskId:1},q2={op:'task',taskId:2};await guarded(f,'platform_query',{queries:[q1,q2]});
 await guarded(f,'platform_query',{queries:[q1]});await guarded(f,'platform_query',{queries:[q2,q1]});await assert.rejects(guarded(f,'platform_query',{queries:[q1]}),e=>e.noProgress);
 await guarded(f,'platform_query',{queries:[{op:'task',taskId:3}]});assert.equal(f.j.progressGuard,undefined);
});
test('Unrelated new sources cannot trigger another recovery of the same unresolved gap',async t=>{
 const f=await fixture(t);artifact(f);const step={tool:'advance_task',args:{taskId:f.task.id},result:{verification:{passed:false,gaps:['缺少消费者映射']}}};
 for(let i=0;i<3;i++)repair.check(f.a,f.j,step);let failure;try{repair.check(f.a,f.j,step);}catch(e){failure=e;}
 agent.source(f.a,f.j,'unrelated','无关数据','新统计');assert.equal(control.escape(f.a,f.j,failure),false);assert.equal(f.j.executionState.forcedNext,undefined);
});
test('Lineage traversal maintains distinct directional frontier, cycles and accepted permission boundaries',async t=>{
 const f=await fixture(t);f.j.executionContract={revision:'scope1',text:'入口 IDs: 1\n\n范围：\n完整上下游；先保留缺口，完成可访问部分'};
 const snapshot=(taskId,nodes)=>({operation:'downstream',query:{op:'downstream',taskId,depth:1},data:{nodes:nodes.map(id=>({id,projectId:42,parentRelation:id===taskId?[]:[{id:taskId}]}))},queriedAt:new Date().toISOString()});
 for(const [id,nodes] of [[1,[1,2,3]],[2,[2,1]]])agent.source(f.a,f.j,'graph:'+id,'图',JSON.stringify(snapshot(id,nodes)),{platformSnapshot:true});
 const q={op:'downstream',taskId:3,projectId:42};
 f.a.platformRequest=async()=>{throw Object.assign(Error('无读取权限'),{code:'AUTH_REQUIRED'});};
 await agent.act(f.a,f.j,'platform_query',{queries:[q]});
 assert.notEqual(obligations.frontier(f.a,f.j).find(r=>r.nodeId==='3').status,'accepted_boundary','generic gap prose does not accept an unlinked denial');
 f.j.executionContract.acceptedBoundaries=[{query:q,coverage:'direction'}];
 const frontier=obligations.frontier(f.a,f.j);assert.equal(frontier.filter(r=>r.status==='queried').length,2);assert.equal(frontier.find(r=>r.nodeId==='3').status,'accepted_boundary');assert.equal(new Set(frontier.map(r=>r.direction+':'+r.nodeId)).size,frontier.length);
});
test('Reading the same worker evidence in reordered batches remains bounded across worker restarts',async t=>{
 const f=await fixture(t);const s=agent.source(f.a,f.j,'text','正文','# A\n第一节\n# B\n第二节');f.task.sourceIds.push(s.id);const generation=require('../desktop/generation-context.cjs');let n=0;
 const queries=[{tool:'read_section',sourceId:s.id,title:'A'},{tool:'read_section',sourceId:s.id,title:'B'}];
 f.a.call=async()=>{n++;return n===1?{kind:'read_context',requests:queries}:{kind:'artifact',content:'待保存草稿'};};
 await generation.call(f.a,f.task,'相同写作步骤',{});n=0;await generation.call(f.a,f.task,'相同写作步骤',{});n=0;
 await assert.rejects(generation.call(f.a,f.task,'相同写作步骤',{}),e=>e.noProgress);assert.equal(n,1);
});
test('First real refresh after migration follows the old source chain and invalidates changed facts',async t=>{
 const f=await fixture(t),platform=require('../desktop/data-platform.cjs'),q={op:'task',taskId:91};
 // Migration may continue a legacy resource chain only with matching account evidence.
 // The synthetic CLI reports this same identity again at the actual refresh boundary.
 const principal=f.a.platformFixture.identity.username;
 agent.source(f.a,f.j,'platform:legacy-identity','旧身份',JSON.stringify({operation:'identity',query:{op:'identity'},data:{username:principal},queriedAt:'2020-01-01'}),{platformSnapshot:true,platformPrincipal:principal});
 const old=agent.source(f.a,f.j,'platform:'+JSON.stringify(platform.command(q)),'旧查询',JSON.stringify({operation:'task',query:q,data:{owner:'old'},queriedAt:'2020-01-01'}),{platformSnapshot:true,platformPrincipal:principal});f.task.sourceIds.push(old.id);artifact(f);f.task.status='review';f.task.verification={passed:true,summary:'旧结果',gaps:[],basis:acceptance.basis(f.a,f.task)};
 control.initialize(f.a);f.a.platformRequest=async()=>({owner:'new'});const r=(await agent.act(f.a,f.j,'platform_query',{queries:[q]})).results[0];assert.notEqual(r.sourceId,old.id);assert.equal(f.a.data.sources.find(s=>s.id===r.sourceId).previousSourceId,old.id);assert.ok(f.task.needsReplan);assert.ok(f.task.sourceIds.includes(r.sourceId));assert.equal(f.task.verification,null);
});
