const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const platform=require('../desktop/data-platform.cjs');
const agent=require('../desktop/agent.cjs');
const {Assistant}=require('../desktop/core.cjs');

test('Platform access is explicit, SG-only and cannot dispatch arbitrary commands',async()=>{
  let calls=0;const request=async()=>{calls++;return {};};
  await assert.rejects(platform.query({}, {op:'task',taskId:1},{request}),/未授权/);
  for(const q of [{op:'exec',sql:'select 1'},{op:'task',taskId:'1; whoami'},{op:'my_tasks',projectId:'--help'},{op:'table',database:'db',table:'../auth.json'},{op:'upstream',taskId:1,depth:11},{op:'projects',page:0}])assert.throws(()=>platform.command(q));
  const args=platform.command({op:'my_tasks',projectId:21,page:2,pageSize:100,owner:'someone',region:'cn',command:'delete'});
  assert.ok(args.includes('--only-self'));assert.equal(args[args.indexOf('--region')+1],'sg');assert.ok(!args.includes('someone'));assert.equal(calls,0);
  assert.ok(platform.command({op:'downstream',taskId:1}).includes('--no-cross-region'));
});
test('Platform errors and diagnostic events never become empty success',()=>{
  assert.deepEqual(platform.parse('{"event":"login"}\n{"status":"success","data":{"total":0}}\n'),{total:0});
  for(const raw of ['bad','{"status":"error","data":[]}','{"data":[]}'])assert.throws(()=>platform.parse(raw));
});
test('Dorado task-not-found business errors retain their meaning without exposing diagnostics',()=>{
  for(const code of [1004,'1004',404])assert.throws(()=>platform.parse(JSON.stringify({status:'error',error:{code,message:'Dorado API error: 任务不存在:700001205 Bearer PRIVATE_TOKEN'}})),e=>e.code==='NOT_FOUND'&&/资源不存在/.test(e.message)&&!/PRIVATE_TOKEN|700001205/.test(e.message)&&e.providerCode===Number(code));
  assert.throws(()=>platform.parse(JSON.stringify({status:'error',error:{code:1004,message:'未知业务错误'}})),e=>e.code==='INVALID_PLATFORM_RESPONSE');
  assert.throws(()=>platform.parse(JSON.stringify({status:'error',error:{code:1004,message:'任务不存在:7 permission denied'}})),e=>e.code==='AUTH_REQUIRED');
});
test('CLI status_code is classified even when its error code is a symbolic string',()=>{
  // Synthetic envelopes follow bytedcli toErrorPayload's documented-in-source
  // shape; these are not captured responses from the eight SG Coral failures.
  for(const [status,expected] of [[400,'INVALID_ARGUMENT'],[401,'AUTH_REQUIRED'],[403,'AUTH_REQUIRED'],[404,'NOT_FOUND'],[429,'TRANSIENT'],[500,'TRANSIENT'],[503,'TRANSIENT']]){
    for(const status_code of [status,String(status)]){
      const raw=JSON.stringify({status:'error',data:null,error:{code:'HTTP_ERROR',status_code,message:'PRIVATE_DIAGNOSTIC Bearer PRIVATE_TOKEN',details:{cookie:'PRIVATE_COOKIE'},retry_after:2}});
      assert.throws(()=>platform.parse(raw),e=>e.code===expected&&e.providerCode===status&&e.retryAfterMs===2000&&!/PRIVATE/.test(JSON.stringify({message:e.message,...e})));
    }
  }
  assert.throws(()=>platform.parse(JSON.stringify({status:'error',error:{code:'CORAL_AUTH_ERROR',status_code:403,message:'Coral API authentication failed.'}})),e=>e.code==='AUTH_REQUIRED'&&e.providerCode===403);
  // A symbolic Coral business error alone does not prove a missing table,
  // permission denial, or transport failure; do not infer from nested codes.
  for(const error of [{code:'CORAL_API_ERROR',details:{code:34013},message:'Coral API error: unknown error'},{code:'CORAL_ENTITY_GUID_MISSING',message:'Coral table lineage requires a table guid for fixture_db.fixture_table.'}]){
    assert.throws(()=>platform.parse(JSON.stringify({status:'error',error})),e=>e.code==='INVALID_PLATFORM_RESPONSE'&&e.providerCode===undefined);
  }
});
test('Identity and embedded credentials are narrowed before storage or model input',async()=>{
  const result=await platform.query({dataPlatform:'sg-readonly'},{op:'identity'},{request:async()=>({username:'me',name:'Name',email:'not needed',accessToken:'secret'})});
  assert.deepEqual(result.data,{username:'me',name:'Name'});
  assert.deepEqual(platform.redact({nested:{secret:'secret',name:'safe'},cookie:'secret',sql:'SELECT 1'}),{nested:{name:'safe'},sql:'SELECT 1'});
});
test('Upstream queries resolve and pass the real project ID before requesting lineage',async()=>{
  const calls=[];const request=async args=>{calls.push(args);return args.includes('get')?{projectId:42}:{nodes:[]};};
  const result=await platform.query({dataPlatform:'sg-readonly'},{op:'upstream',taskId:1},{request});
  assert.equal(calls.length,2);assert.deepEqual(calls[1].slice(-2),['--project-id','42']);assert.equal(result.query.projectId,'42');
  calls.length=0;await platform.query({dataPlatform:'sg-readonly'},{op:'upstream',taskId:1,projectId:42},{request});assert.equal(calls.length,1);
  await assert.rejects(platform.query({dataPlatform:'sg-readonly'},{op:'upstream',taskId:1},{request:async()=>({})}),/项目 ID/);
});
test('Structured index pages through middle graph nodes and keeps platform pagination boundaries',()=>{
  const snapshot={operation:'downstream',query:{depth:1},data:{nodes:Array.from({length:55},(_,i)=>({id:i+1,owner:'me',projectId:42,parentRelation:[1],detail:'large config'})),depth:1}};
  const first=platform.index(snapshot),last=platform.index(snapshot,{start:50,limit:5});assert.equal(first.next,50);assert.equal(first.rows.length,50);assert.equal(last.rows[0].id,51);assert.equal(last.next,null);assert.equal(last.rows[0].detail,undefined);assert.deepEqual(last.rows[0].parentRelation,[1]);assert.equal(last.depth,1);
  const tasks=platform.index({data:{tasks:[{id:9}],total:90,page:2,page_size:10}});assert.equal(tasks.platformTotal,90);assert.equal(tasks.pageSize,10);assert.equal(tasks.rowsInSnapshot,1);
});
async function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-platform-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>({tool:'ask',args:{question:'test pause'},reason:'fixture'})});
  require('./helpers/platform-fixture.cjs').install(a);
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.com/v1',model:'fixture'});return a;
}
test('Repeated platform evidence preserves completed work while real data changes invalidate once',async t=>{
 const a=await setup(t),job=agent.buildJob(a,{goal:'chain',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 let data={id:2,owner:'me',updatedAt:'2026-01-01',nodes:[1,3]};a.platformRequest=async()=>structuredClone(data);
 const query=()=>agent.act(a,job,'platform_query',{queries:[{op:'task',taskId:2}]});
 const first=(await query()).results[0],task=a.createTask({title:'handover',criteria:'checked',sourceIds:[first.sourceId]});job.taskIds.push(task.id);
 task.status='review';task.verification={passed:true};task.steps[0].done=true;
 const original=a.data.sources[0].content;
 await new Promise(r=>setTimeout(r,5));const again=(await query()).results[0];
 assert.equal(again.unchanged,true);assert.equal(again.sourceId,first.sourceId);assert.equal(a.data.sources.length,1);assert.equal(task.needsReplan,undefined);assert.equal(task.status,'review');assert.equal(task.steps[0].done,true);assert.equal(task.verification.passed,true);assert.equal(a.data.sources[0].content,original);
 assert.equal(agent.context(a,job).platformInventory.queries[0].at,again.checkedAt);
 for(const op of Object.values(job.executionState.operations))op.completedAt='2020-01-01T00:00:00Z';
 data.owner='other';const changed=(await query()).results[0];assert.equal(changed.unchanged,false);assert.notEqual(changed.sourceId,first.sourceId);assert.match(task.needsReplan,/内容已变化/);assert.equal(task.verification,null);assert.ok(task.sourceIds.includes(changed.sourceId));
 // Simulate the application accepting the updated plan, then querying it again.
 task.needsReplan=null;task.status='review';task.verification={passed:true};
 const repeated=(await query()).results[0];assert.equal(repeated.sourceId,changed.sourceId);assert.equal(repeated.unchanged,true);assert.equal(task.needsReplan,null);assert.equal(task.verification.passed,true);assert.equal(a.data.sources.length,2);
 const restored=new Assistant({dir:a.dir});assert.equal(restored.data.sources[0].lastCheckedAt,repeated.checkedAt);
 // A failed intermediate query is superseded by a subsequent successful check,
 // even when the business data is unchanged and the original snapshot is old.
 a.data.agentRuns.push({jobId:job.id,steps:[{tool:'platform_query',at:new Date().toISOString(),result:{results:[{query:{op:'task',taskId:2},error:'temporary failure'}]}}]});
 for(const op of Object.values(job.executionState.operations))op.completedAt='2020-01-01T00:00:00Z';
 await new Promise(r=>setTimeout(r,5));await query();assert.equal(agent.context(a,job).platformInventory.failures.length,0);
});
test('Platform comparison ignores only observation time and equivalent command parameters',()=>{
 const value={operation:'task',region:'sg',scope:'authorized',query:{op:'task',taskId:2},queriedAt:'old',data:{owner:'me',updatedAt:'business-time',nodes:[1,3]}};
 assert.ok(platform.sameEvidence(JSON.stringify(value),{...value,queriedAt:'new',query:{op:'task',taskId:'2'},data:{nodes:[1,3],updatedAt:'business-time',owner:'me'}}));
 for(const changed of [{...value,data:{...value.data,updatedAt:'changed'}},{...value,data:{...value.data,nodes:[3,1]}},{...value,scope:'other'},{...value,region:'other'},{...value,query:{op:'task',taskId:3}}])assert.equal(platform.sameEvidence(JSON.stringify(value),changed),false);
 assert.equal(platform.sameEvidence('broken',value),false);
});
test('Batch snapshots persist successful pages, retain failure and do not consume watcher slots',async t=>{
  const a=await setup(t),job=agent.buildJob(a,{goal:'test',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
  let calls=0;a.platformRequest=async()=>{if(++calls===2)throw new Error('fixture unavailable');return {tasks:[{id:1}],total:201,page:1};};
  const result=await agent.act(a,job,'platform_query',{queries:[{op:'my_tasks',projectId:1,page:1},{op:'my_tasks',projectId:1,page:2}]});
  assert.equal(result.results.length,2);assert.equal(job.sourceIds.length,1);assert.equal(job.watchers.length,0);assert.match(result.results[1].error,/unavailable/);
  assert.ok(a.data.sources[0].content.includes('201'));assert.equal(agent.context(a,job).sources[0].current,true);
  const restored=new Assistant({dir:a.dir});assert.equal(restored.data.sources.length,1);assert.equal(restored.data.delegations[0].dataPlatform,'sg-readonly');
  const sourceId=result.results[0].sourceId;
  assert.equal((await agent.act(a,job,'read_source',{sourceId})).sourceId,sourceId);
  a.controller=new AbortController();a.controller.abort();await assert.rejects(agent.act(a,job,'platform_query',{queries:[{op:'projects'}]}));assert.equal(calls,2);
});
test('Adopting a task preserves identity and old deliverables but requires a fresh Agent plan',async t=>{
  const a=await setup(t),task=a.createTask({title:'旧事项',description:'old',criteria:'old'});task.status='review';task.steps[0].done=true;task.steps[0].artifactId='old';
  a.data.artifacts.push({id:'old',taskId:task.id,content:'old document'});const oldSteps=structuredClone(task.steps);
  await a.dispatch('agentAdoptTask',{taskId:task.id,taskUpdatedAt:task.updatedAt,goal:'重新查询完整链路，整理交接',dataPlatform:'sg-readonly',autoAccept:false});await a.runPromise;
  assert.equal(a.data.tasks.length,1);assert.equal(a.data.delegations.length,1);assert.equal(a.data.artifacts[0].content,'old document');
  assert.equal(task.agentJobId,a.data.delegations[0].id);assert.deepEqual(task.planHistory[0].steps,oldSteps);assert.ok(task.needsReplan);assert.equal(task.steps[0].done,false);
  await assert.rejects(agent.act(a,a.data.delegations[0],'advance_task',{taskId:task.id}),/plan_task/);
  await assert.rejects(a.dispatch('agentAdoptTask',{taskId:task.id,taskUpdatedAt:task.updatedAt,goal:'repeat'}),/已有/);assert.equal(a.data.delegations.length,1);
});
test('Adoption validates stale state, paused tasks and write uncertainty before any mutation',async t=>{
  const a=await setup(t),task=a.createTask({title:'task',criteria:'criteria'});
  await assert.rejects(a.dispatch('agentAdoptTask',{taskId:task.id,taskUpdatedAt:'old',goal:'new'}),/已更新/);
  task.status='paused';await assert.rejects(a.dispatch('agentAdoptTask',{taskId:task.id,taskUpdatedAt:task.updatedAt,goal:'new'}),/恢复/);
  task.status='todo';a.data.agentActions.push({taskId:task.id,status:'uncertain'});await assert.rejects(a.dispatch('agentAdoptTask',{taskId:task.id,taskUpdatedAt:task.updatedAt,goal:'new'}),/外部动作/);
  assert.equal(a.data.delegations.length,0);assert.equal(task.agentJobId,undefined);
});

test('Persistent platform inventory retains early lineage after forty later sources and scopes access',async t=>{
  const a=await setup(t),job=agent.buildJob(a,{goal:'chain',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
  a.platformRequest=async args=>args.includes('upstream')?{depth:1,nodes:[{id:2,owner:'me',parentRelation:[{id:1}]}]}:{sql:'SELECT 1'};
  const first=await agent.act(a,job,'platform_query',{queries:[{op:'upstream',taskId:2,projectId:1}]});
  for(let i=3;i<45;i++)await agent.act(a,job,'platform_query',{queries:[{op:'code',taskId:i}]});
  const foreign={...a.data.sources[0],id:'foreign',content:JSON.stringify({operation:'task',data:{id:999,owner:'not-me'}})};a.data.sources.push(foreign);
  job.history=[];const ctx=agent.context(a,job);assert.equal(ctx.sources.some(s=>s.id===first.results[0].sourceId),false);
  assert.equal(ctx.platformInventory.nodes[0].id,'2');assert.deepEqual(ctx.platformInventory.nodes[0].parents,['1']);assert.equal(ctx.platformInventory.nodes.some(n=>n.id==='999'),false);
  const page=await agent.act(a,job,'platform_inventory',{queryStart:40,limit:5});assert.equal(page.queries.length,3);assert.equal(page.nextQueries,null);
});
test('Inventory excludes revoked and superseded evidence, preserves conflicting relations with provenance and pages nodes',()=>{
  const source=(id,data,extra={})=>({id,platformSnapshot:true,content:JSON.stringify({operation:'upstream',query:{taskId:2,depth:1},data}),...extra});
  const result=platform.inventory([source('old',{nodes:[{id:2,owner:'old',parentRelation:[{id:99}]}]}),source('new',{nodes:[{id:2,owner:'new',parentRelation:[{id:1}]},{id:1}]},{previousSourceId:'old'}),source('gone',{nodes:[{id:3}]},{deleted:true}),source('excluded',{nodes:[{id:4}]},{projectExcluded:true})],{limit:1});
  assert.equal(result.totalNodes,2);assert.equal(result.nodes[0].owner,'new');assert.deepEqual(result.nodes[0].parents,['1']);assert.deepEqual(result.nodes[0].sourceIds,['new']);assert.equal(result.next,1);assert.equal(result.totalQueries,1);
});
test('Known platform permission failures preserve a safe actionable reason',()=>{
  assert.throws(()=>platform.parse(JSON.stringify({status:'error',error:{message:'当前用户没有[PRIVATE_PROJECT]项目访问权限 TOKEN_PRIVATE',code:8000}})),e=>/读取权限/.test(e.message)&&!e.message.includes('PRIVATE'));
});

test('Permission gaps persist outside recent history and clear after a later successful snapshot',async t=>{
 const a=await setup(t),job=agent.buildJob(a,{goal:'chain',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 a.data.agentRuns.push({jobId:job.id,steps:[{tool:'platform_query',at:'2026-01-01T00:00:00Z',result:{results:[{query:{op:'upstream',taskId:2},error:'读取权限不足'}]}}]});job.history=[];require('../desktop/execution-control.cjs').initialize(a);
 assert.equal(agent.context(a,job).platformInventory.failures.length,1);a.save();const restored=new Assistant({dir:a.dir});assert.equal(agent.context(restored,restored.data.delegations[0]).platformInventory.failures.length,1);
 a.platformRequest=async()=>({nodes:[]});await agent.act(a,job,'platform_query',{queries:[{op:'upstream',taskId:'2',projectId:'7'}]});
 assert.equal(agent.context(a,job).platformInventory.failures.length,0);
 a.data.agentRuns.unshift({jobId:'foreign',steps:[{tool:'platform_query',result:{results:[{query:{op:'task',taskId:99},error:'foreign'}]}}]});assert.equal(agent.context(a,job).platformInventory.failures.length,0);
});

test('Planner retains tail-page source IDs after action history compaction',async t=>{
 const a=await setup(t),job=agent.buildJob(a,{goal:'large chain',dataPlatform:'sg-readonly'});a.data.delegations.push(job);
 for(let i=1;i<=126;i++){const source={id:`source-${i}`,title:`task ${i}`,platformSnapshot:true,content:JSON.stringify({operation:'task',query:{op:'task',taskId:i},data:{id:i,owner:'me',parentRelation:i>1?[i-1]:[]}})};a.data.sources.push(source);job.sourceIds.push(source.id);}
 job.history=[];const inv=agent.context(a,job).platformInventory;
 assert.equal(inv.nodes.length,126);assert.equal(inv.queries.length,126);assert.equal(inv.next,null);assert.equal(inv.nextQueries,null);assert.equal(inv.queries.at(-1).sourceId,'source-126');
 const paged=await agent.act(a,job,'platform_inventory',{start:100,queryStart:100,limit:30});assert.equal(paged.nodes.length,26);
});
test('Writing and verification receive all graph edges without repeated bulky node configuration',async t=>{
 const a=await setup(t),task=a.createTask({title:'graph',criteria:'complete'});
 const nodes=Array.from({length:60},(_,i)=>({id:i+1,owner:'me',projectId:7,parentRelation:[i],frequency:'daily',config:'x'.repeat(3000)}));
 const source={id:'graph-source',title:'graph',platformSnapshot:true,content:JSON.stringify({operation:'upstream',query:{op:'upstream',taskId:60,depth:1},queriedAt:'2026-01-01T00:00:00Z',data:{nodes,depth:1}})};
 a.data.sources.push(source);task.sourceIds=[source.id];
 for(const verification of [false,true]){const evidence=a.context(task,{verification}).sources[0];const graph=JSON.parse(evidence.content);assert.equal(graph.rows.length,60);assert.deepEqual(graph.rows.at(-1).parentRelation,[59]);assert.equal(graph.rows.at(-1).frequency,'daily');assert.equal(graph.rows[0].config,undefined);assert.equal(graph.depth,1);assert.equal(evidence.structuralProjection,true);}
 assert.equal(JSON.parse(source.content).data.nodes[0].config.length,3000);
 source.deleted=true;assert.equal(a.context(task).sources.length,0);
 const denied=require('../desktop/task-context.cjs').resolveRead(a,{kind:'task',taskId:task.id},{tool:'read_source',sourceId:source.id});assert.equal(denied.ok,false);assert.equal(denied.content,undefined);
});
test('Coral graph projection retains every entity, direction, producer and consumer without bulky attributes',()=>{
 const entities=Object.fromEntries(Array.from({length:55},(_,i)=>[`g${i}`,{guid:`g${i}`,typeName:i===54?'DummyTable':'HiveTable',attributes:{name:`table${i}`,qualifiedName:`table${i}@6`,userNames:['me'],noise:'x'.repeat(2000),inputToProcesses:[{guid:`p${i}`,typeName:'DoradoTask',attributes:{id:i+1,userNames:['me'],outputs:[{guid:'out'}]}}],outputFromProcesses:[]}}]));
 const snapshot={operation:'table_lineage',query:{op:'table_lineage',database:'db',table:'tbl'},data:{baseEntityGuid:'base',inputEntityCount:55,inputEntityDepth:1,outputEntityCount:0,outputEntityDepth:1,inputEntityGuids:[Object.keys(entities)],outputEntityGuids:[],guidEntityMap:entities}};
 const first=platform.index(snapshot),last=platform.index(snapshot,{start:50,limit:5});assert.equal(first.next,50);assert.equal(last.rows.at(-1).typeName,'DummyTable');assert.equal(last.rows.at(-1).attributes.inputToProcesses[0].attributes.id,55);assert.deepEqual(first.inputEntityGuids,snapshot.data.inputEntityGuids);assert.equal(first.rows[0].attributes.noise,undefined);
 const summary=platform.evidenceSummary({id:'s',title:'coral',platformSnapshot:true,content:JSON.stringify(snapshot)});const compact=JSON.parse(summary.content);assert.equal(compact.rows.length,55);assert.equal(compact.baseEntityGuid,'base');assert.equal(compact.inputEntityDepth,1);assert.equal(compact.next,null);assert.deepEqual(compact.rows[54].attributes.inputToProcesses[0].attributes.outputs,[{guid:'out'}]);
});
test('Table producer mappings support array responses and retain actual access fields',()=>{
 const value=platform.index({operation:'table_tasks',data:[{taskId:7,taskName:'producer',taskOwner:'me',taskCid:6,canAccess:false,accessDeniedMsg:'permission',query:'large sql'}]});
 assert.equal(value.rows.length,1);assert.equal(value.rows[0].taskId,7);assert.equal(value.rows[0].canAccess,false);assert.equal(value.rows[0].taskCid,6);assert.equal(value.rows[0].query,undefined);
});
