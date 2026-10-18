'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// This suite cannot reach a real CLI, network, model or production workspace.
const forbidden=()=>{throw Error('root-platform-recovery: real I/O forbidden');};
require('node:child_process').spawn=forbidden;
require('node:net').Socket.prototype.connect=forbidden;
global.fetch=forbidden;
const platform=require('../desktop/data-platform.cjs'),ledger=require('../desktop/operation-ledger.cjs');
const boundaries=require('../desktop/platform-boundaries.cjs'),frontier=require('../desktop/lineage-frontier.cjs');
const policy=require('../desktop/access-policy-store.cjs');
const auth={trusted:true,actor:'user_command',command:'root_platform_fixture'};
const q={op:'downstream',taskId:710000038,projectId:710000013,depth:10};
function job(){return {id:'root-platform-job',status:'ready',dataPlatform:'sg-readonly',platformPrincipal:'alice',workRevision:1,sourceIds:[],taskIds:[],feedback:[],executionContract:{revision:'original-contract',updatedAt:'2032-01-20T00:00:00Z',text:'入口任务 IDs: 1'},executionState:{version:2,permissionRevision:0,operations:{},requirements:[],gaps:[],reads:{},events:[]}};}
function failure(j,query,n=0,patch={}){
 const op={id:'actual-failure-'+n,key:ledger.key(j,query),query:structuredClone(query),principal:j.platformPrincipal,scope:j.dataPlatform,permissionRevision:0,status:'failed',errorCode:'AUTH_REQUIRED',error:'permission failure',startedAt:'2032-01-19T19:34:00Z',completedAt:'2032-01-19T19:35:01Z',...patch};j.executionState.operations[op.key]=op;return op;
}
function source(j,query,data,id='snapshot-1'){
 j.sourceIds.push(id);return {id,platformSnapshot:true,platformPrincipal:'alice',content:JSON.stringify({operation:query.op,query,region:'sg',data}),lastCheckedAt:'2032-01-19T19:30:00Z'};
}
function accept(j,query,coverage='direction'){
 j.executionContract.acceptedBoundaries=[...(j.executionContract.acceptedBoundaries||[]),{query:structuredClone(query),coverage}];
}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-platform-B-isolated-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const j=job(),a={dir,file:path.join(dir,'workspace.json'),data:{version:1,settings:{automatic:false},delegations:[j],tasks:[],sources:[],artifacts:[],projects:[],providers:[],folders:[],capabilities:[],agentActions:[],events:[],runtime:{}}};
 const f={a,job:j,calls:[],identityCalls:0,response:()=>{throw Object.assign(Error('PRIVATE_TOKEN not to persist'),{code:'AUTH_REQUIRED'});}};
 function install(a){
  a.save=()=>fs.writeFileSync(a.file,JSON.stringify(a.data));a.task=id=>a.data.tasks.find(t=>t.id===id);
  a.platformRequest=async args=>{if(args.includes('userinfo')){f.identityCalls++;return {username:'alice'};}f.calls.push(args);return f.response(args);};
 }
 install(a);a.save();policy.initialize(a);
 f.restart=()=>{f.a.save();f.a={dir,file:a.file,data:JSON.parse(fs.readFileSync(a.file,'utf8'))};install(f.a);policy.initialize(f.a);f.job=f.a.data.delegations[0];};
 return f;
}
test('legacy thirteen directions require a timestamped explicit contract AND exact real failures',()=>{
 const j=job();j.executionContract.text+='\n\n沿用已接受的13个权限方向；先保留缺口，完成可访问部分。';for(let i=0;i<13;i++)failure(j,{...q,taskId:710000038+i},i);
 failure(j,{op:'task',taskId:710000049},20);
 failure(j,{op:'task',taskId:700001205},21,{errorCode:'NOT_FOUND'});
 failure(j,{...q,taskId:999},22,{completedAt:'2032-01-21T00:00:00Z'});
 const before=JSON.stringify(j),r=boundaries.planMigration(j);assert.equal(r.records.length,13);assert.equal(JSON.stringify(j),before);
 assert.ok(r.records.every(b=>b.coverage==='direction'&&b.identity.projectId==='710000013'&&b.decision.revision==='original-contract'&&b.operationId&&b.originalObservedAt));
 j.executionState.acceptedBoundaries=r.records;assert.equal(boundaries.planMigration(j).changed,false);
 const ambiguous=job();ambiguous.executionContract.text=j.executionContract.text;for(let i=0;i<14;i++)failure(ambiguous,{...q,taskId:710000038+i},i);
 assert.equal(boundaries.planMigration(ambiguous).records.length,0);assert.equal(boundaries.planMigration(ambiguous).unresolved[0].observed,14);
 assert.equal(boundaries.inspect(ambiguous,{...q,depth:1}).reason,'acceptance_set_unresolved');
});
test('arbitrary AUTH errors, blanket legacy markers and prose cannot become accepted boundaries',()=>{
 for(const text of ['先保留缺口，完成可访问部分','已接受13个权限方向','入口任务 IDs: 1']){
  const j=job();j.executionContract.text=text;j.executionState.acceptedBoundary={kind:'permission',policy:'document_and_continue',authority:'user'};
  j.feedback=[{text:'已接受所有权限错误'}];failure(j,q);
  assert.equal(boundaries.planMigration(j).records.length,0);
 }
});
test('query acceptance is exact; explicit direction acceptance alone spans depth/page',()=>{
 const j=job();failure(j,q);accept(j,q,'query');let r=boundaries.planMigration(j).records;
 assert.equal(boundaries.inspect(j,q,{records:r}).status,'accepted_boundary');
 assert.equal(boundaries.inspect(j,{...q,depth:1},{records:r}).status,'ready');
 assert.equal(boundaries.inspect(j,{...q,page:2},{records:r}).status,'ready');
 j.executionContract.acceptedBoundaries[0].coverage='direction';r=boundaries.planMigration(j).records;
 assert.equal(boundaries.inspect(j,{...q,depth:1,page:2},{records:r}).status,'accepted_boundary');
 for(const other of [{...q,op:'upstream'},{...q,op:'code'},{...q,op:'task'},{...q,projectId:99},{...q,region:'ttp'}])assert.equal(boundaries.inspect(j,other,{records:r}).status,'ready');
 for(const mutate of [j=>j.platformPrincipal='bob',j=>j.executionState.permissionRevision++,j=>j.projectId='different-local-project']){const other=structuredClone(j);mutate(other);assert.equal(boundaries.inspect(other,q,{records:r}).status,'ready');}
});
test('explicit accepted gap requires an actual failure reference; default coverage remains query',()=>{
 const j=job(),o=failure(j,q);j.executionState.gaps=[{status:'accepted_gap',acceptedBy:'user',decisionId:'d',operationId:o.id}];
 const r=boundaries.planMigration(j).records;assert.equal(r.length,1);assert.equal(r[0].coverage,'query');
 j.executionState.gaps[0].operationId='different';assert.equal(boundaries.planMigration(j).records.length,0);
});
test('project resolution retains provenance, ignores catalogs, detects conflicts and does not copy root project to children',()=>{
 const j=job(),s=source(j,q,{nodes:[{id:q.taskId,projectId:q.projectId},{id:7,parentRelation:[{id:q.taskId}]}]});
 const r=boundaries.resolveQuery(j,{op:'downstream',taskId:q.taskId},{sources:[s]});assert.equal(r.query.projectId,'710000013');assert.equal(r.proof[0].sourceId,s.id);
 assert.equal(boundaries.resolveQuery(j,{op:'downstream',taskId:7},{sources:[s]}).status,'scope_unresolved');
 const s2=source(j,{op:'task',taskId:q.taskId},{id:q.taskId,projectId:710000014},'other');
 assert.equal(boundaries.resolveQuery(j,{op:'downstream',taskId:q.taskId},{sources:[s,s2]}).reason,'ambiguous_project');
 s2.deleted=true;assert.equal(boundaries.resolveQuery(j,{op:'downstream',taskId:q.taskId},{sources:[s,s2]}).status,'resolved');
});
test('frontier helper preserves same-direction roots and project proofs; accepted candidates cannot dispatch',()=>{
 const j=job(),s=source(j,{op:'downstream',taskId:1,projectId:7},{nodes:[{id:1,projectId:7},{id:2,projectId:8,parentRelation:[{id:1}]},{id:3,projectId:9,parentRelation:[{id:2}]},{id:90,projectId:90,parentRelation:[]}]});
 const upstream=source(j,{op:'upstream',taskId:2,projectId:8},{nodes:[{id:2,projectId:8,parentRelation:[{id:91}]},{id:91,projectId:91}]},'side-input');
 const queries=[{sourceId:s.id},{sourceId:upstream.id}],scope={rootIds:['1'],region:'sg',revision:'scope'};
 const rows=frontier.build([s,upstream],scope,queries);
 assert.ok(rows.some(r=>r.nodeId==='3'&&r.projectId==='9'));assert.ok(!rows.some(r=>['90','91'].includes(r.nodeId)));
 const denied={op:'downstream',taskId:2,projectId:8,depth:10};failure(j,denied);accept(j,denied);
 const before=JSON.stringify(j),projected=frontier.project(j,rows,{sources:[s,upstream]});
 assert.equal(projected.find(r=>r.nodeId==='2').status,'accepted_boundary');assert.equal(JSON.stringify(j),before);
 assert.ok(!frontier.candidates(j,rows,{sources:[s,upstream]}).some(r=>r.nodeId==='2'));
 assert.equal(frontier.candidates(j,rows,{sources:[s,upstream]}).find(r=>r.nodeId==='3').query.projectId,'9');
});
test('contradictory node projects do not authorize traversal through that node',()=>{
 const j=job(),s=source(j,{op:'downstream',taskId:1,projectId:7},{nodes:[{id:1,projectId:7},{id:2,projectId:8,parentRelation:[{id:1}]},{id:3,projectId:9,parentRelation:[{id:2}]}]});
 const other=source(j,{op:'task',taskId:2},{id:2,projectId:10},'conflict');
 const rows=frontier.build([s,other],{rootIds:['1'],region:'sg',revision:'r'},[{sourceId:s.id},{sourceId:other.id}]);
 assert.ok(!rows.some(r=>r.nodeId==='3'));assert.equal(rows.find(r=>r.nodeId==='2').scopeProven,false);
});
test('accepted direction dispatch resolves omitted projects, preserves original receipt and survives restart',async t=>{
 const f=fixture(t),o=failure(f.job,q);accept(f.job,q);await ledger.prepareBatch(f.a,f.job);f.restart();
 for(const request of [{...q,depth:1},{op:'downstream',taskId:String(q.taskId),depth:2}]){
  const r=await ledger.fetch(f.a,f.job,request);assert.equal(r.status,'accepted_boundary');assert.equal(r.reused,true);assert.equal(r.operationId,o.id);assert.deepEqual(r.originalQuery,q);assert.equal(r.originalObservedAt,o.completedAt);assert.equal(r.resolvedQuery.projectId==q.projectId,true);assert.deepEqual(r.requestedQuery,request);
 }
 assert.equal(f.calls.length,0);
});
test('accepted direction cannot bypass pause/revocation and grant replacement invalidates it',async t=>{
 const f=fixture(t);failure(f.job,q);accept(f.job,q);await ledger.prepareBatch(f.a,f.job);
 f.job.status='paused';await assert.rejects(ledger.fetch(f.a,f.job,q),e=>e.code==='EXECUTION_GATE_CLOSED');f.job.status='ready';
 const grant={principalScope:{kind:'account',provider:'platform',subject:'alice'},resourceScope:{kind:'platform',key:'sg-readonly',jobId:f.job.id},operations:['platform_query']};
 policy.revoke(f.a,grant,auth);await assert.rejects(ledger.fetch(f.a,f.job,q));assert.equal(f.calls.length,0);
 policy.grant(f.a,grant,auth);const r=await ledger.fetch(f.a,f.job,q);assert.equal(r.reused,false);assert.equal(f.calls.length,1);
 const exact=await ledger.fetch(f.a,f.job,q);assert.equal(exact.reused,true);assert.notEqual(exact.status,'accepted_boundary');
 const otherDepth=await ledger.fetch(f.a,f.job,{...q,depth:1});assert.equal(otherDepth.reused,false);assert.notEqual(otherDepth.status,'accepted_boundary');assert.equal(f.calls.length,2);
});
test('ambiguous omitted project yields scope_unresolved with zero metadata requests even for explicit retry',async t=>{
 const f=fixture(t);failure(f.job,q);failure(f.job,{...q,projectId:710000014},1);
 for(const retry of [false,true]){const r=await ledger.fetch(f.a,f.job,{op:'downstream',taskId:q.taskId,depth:1},{retry});assert.equal(r.errorCode,'SCOPE_UNRESOLVED');assert.equal(r.receipt.dispatched,false);}
 assert.equal(f.calls.length,0);
});
test('AUTH failure cache matches exact depth/page/project, independent of acceptance',async t=>{
 const f=fixture(t),first=await ledger.fetch(f.a,f.job,q);assert.equal(first.errorCode,'AUTH_REQUIRED');
 const reused=await ledger.fetch(f.a,f.job,{...q,taskId:String(q.taskId)});assert.equal(reused.reused,true);assert.equal(reused.operationId,first.operation.id);assert.deepEqual(reused.cachedQuery,q);
 assert.equal((await ledger.fetch(f.a,f.job,{...q,depth:1})).reused,false);
 assert.equal((await ledger.fetch(f.a,f.job,{...q,page:2})).reused,false);
 assert.equal((await ledger.fetch(f.a,f.job,{...q,projectId:42})).reused,false);
 assert.equal(f.calls.length,4);
});
test('710000049 task denial and another project/depth downstream success stay separate',async t=>{
 const f=fixture(t),detail={op:'task',taskId:710000049},denial=await ledger.fetch(f.a,f.job,detail);
 const old=await ledger.fetch(f.a,f.job,{op:'downstream',taskId:710000049,projectId:710000014,depth:10});
 f.response=()=>({nodes:[]});const result=await ledger.fetch(f.a,f.job,{op:'downstream',taskId:710000049,projectId:710000011,depth:10});
 const saved=require('../desktop/state-transitions.cjs').commit(f.a,()=>{
  const stored=platform.splitPlatformSnapshot(result.snapshot),s=require('../desktop/agent.cjs').source(f.a,f.job,'controlled-other-project','Controlled other-project result',JSON.stringify(stored.snapshot),{platformSnapshot:true,platformPrincipal:f.job.platformPrincipal,...stored.sourceMeta});
  ledger.finish(f.a,f.job,result.operation,s.id);return s;
 });
 assert.equal(require('../desktop/protocol-access.cjs').allowedObject(f.a,'source',saved,f.job),true);
 assert.equal(JSON.parse(fs.readFileSync(f.a.file)).sources.find(s=>s.id===saved.id).content,saved.content);
 assert.equal(denial.operation.status,'failed');assert.equal(old.operation.status,'failed');assert.equal(result.operation.status,'done');
 assert.equal((await ledger.fetch(f.a,f.job,detail)).reused,true);
});
test('resolved child query survives a real failure and cache/receipt retain original request',async t=>{
 const f=fixture(t);f.response=args=>{if(args.includes('get'))return {projectId:7};throw Object.assign(Error('denied'),{code:'AUTH_REQUIRED'});};
 const request={op:'upstream',taskId:42,depth:10},first=await ledger.fetch(f.a,f.job,request);
 assert.equal(first.receipt.actualQuery.projectId,'7');assert.deepEqual(first.requestedQuery,request);assert.equal(first.operation.actualQuery.projectId,'7');
 const second=await ledger.fetch(f.a,f.job,{...request,projectId:7});assert.equal(second.reused,true);assert.equal(second.operationId,first.operationId);assert.equal(f.calls.length,2);
});
test('explicit CH/Aeolus/unknown return typed limitations without a Hive request',async t=>{
 const f=fixture(t);f.response=()=>({name:'table'});
 for(const type of [null,'ClickhouseTable','ch','AeolusDataset','UnknownTable']){
  const r=await ledger.fetch(f.a,f.job,{op:'table_lineage',database:'fixture_db',table:'fixture_table',entityType:type});
  assert.equal(r.errorCode,'UNSUPPORTED_ENTITY');assert.equal(r.receipt.dispatched,false);assert.equal(r.receipt.limitation.executable,false);assert.equal(ledger.eligibility(f.job,r.operation).action,'diagnose');
 }
 assert.equal(f.calls.length,0);
 const hive=await ledger.fetch(f.a,f.job,{op:'table',database:'fixture_db',table:'fixture_table',entityType:'HiveTable'});assert.ok(hive.snapshot);assert.equal(f.calls.length,1);
 assert.throws(()=>platform.command({op:'table_lineage',database:'d',table:'t',entityType:'HiveTable',direction:'OUTPUT'}),e=>e.code==='UNSUPPORTED_CAPABILITY');
 assert.throws(()=>platform.command({...q,region:'ttp'}),e=>e.code==='UNSUPPORTED_CAPABILITY');
});
test('legacy omitted Hive type keeps its command, durable normalization and successful cache across restart',async t=>{
 const f=fixture(t),oldQuery={op:'table_lineage',database:'fixture_db',table:'fixture_table'},modern={...oldQuery,entityType:'HiveTable'};
 f.response=()=>({guidEntityMap:{}});const first=await ledger.fetch(f.a,f.job,oldQuery);
 const saved=source(f.job,oldQuery,first.snapshot.data,'legacy-hive');f.a.data.sources.push(saved);ledger.finish(f.a,f.job,first.operation,saved.id);
 const hash=loadHash(),oldKey=hash({jobId:f.job.id,projectId:null,scope:f.job.dataPlatform,principal:f.job.platformPrincipal,request:platform.command(oldQuery)});
 delete f.job.executionState.operations[first.operation.key];first.operation.key=oldKey;f.job.executionState.operations[oldKey]=first.operation;
 f.restart();const cached=await ledger.fetch(f.a,f.job,modern);assert.equal(cached.reused,true);assert.equal(cached.operationId??cached.operation.id,first.operation.id);assert.equal(f.calls.length,1);
 assert.deepEqual(platform.command(oldQuery),platform.command(modern));assert.deepEqual(ledger.normalize('platform_query',{queries:[oldQuery]}),{tool:'platform_query',queries:[platform.command(oldQuery)]});assert.deepEqual(ledger.normalize('platform_query',{queries:[oldQuery]}),ledger.normalize('platform_query',{queries:[modern]}));
 assert.equal(platform.sameEvidence(JSON.stringify(first.snapshot),{...first.snapshot,query:modern}),true);
});
function loadHash(){return require('../desktop/evidence-basis.cjs').hash;}
test('legacy Hive failure cache is reused by an explicit Hive request, but never by CH',async t=>{
 const f=fixture(t),oldQuery={op:'table_tasks',database:'fixture_db',table:'fixture_table'},old=await ledger.fetch(f.a,f.job,oldQuery);
 const oldKey=loadHash()({jobId:f.job.id,projectId:null,scope:f.job.dataPlatform,principal:f.job.platformPrincipal,request:platform.command(oldQuery)});
 delete f.job.executionState.operations[old.operation.key];old.operation.key=oldKey;f.job.executionState.operations[oldKey]=old.operation;f.restart();
 assert.equal((await ledger.fetch(f.a,f.job,{...oldQuery,entityType:'HiveTable'})).reused,true);
 const ch=await ledger.fetch(f.a,f.job,{...oldQuery,entityType:'ClickhouseTable'});assert.equal(ch.errorCode,'UNSUPPORTED_ENTITY');assert.equal(ch.receipt.dispatched,false);assert.equal(f.calls.length,1);
});
test('unknown symbolic failures preserve safe diagnostics and never become automatic transient retries',async t=>{
 const f=fixture(t);f.response=()=>{try{platform.parse(JSON.stringify({status:'error',error:{code:'CORAL_ENTITY_GUID_MISSING',message:'PRIVATE_TOKEN https://login.invalid/?token=PRIVATE_COOKIE',details:{code:34013,token:'PRIVATE_TOKEN',message:'PRIVATE_MESSAGE'}}}));}catch(e){e.exitCode=17;throw e;}};
 const first=await ledger.fetch(f.a,f.job,q);assert.equal(first.errorCode,'INVALID_PLATFORM_RESPONSE');assert.equal(first.receipt.diagnostics.symbolicCode,'CORAL_ENTITY_GUID_MISSING');assert.equal(first.receipt.diagnostics.exitCode,17);assert.equal(first.receipt.diagnostics.details.code,34013);assert.equal(first.operation.retryAt,undefined);
 first.operation.completedAt='2000-01-01T00:00:00Z';f.job.feedback.push({text:'new business feedback'});f.job.workRevision++;
 assert.equal(ledger.eligibility(f.job,first.operation,Date.now()+1e10).action,'diagnose');
 assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);f.restart();assert.equal((await ledger.fetch(f.a,f.job,q)).reused,true);assert.equal(f.calls.length,1);
 assert.doesNotMatch(fs.readFileSync(f.a.file,'utf8'),/PRIVATE_|login\.invalid/);
 assert.equal((await ledger.fetch(f.a,f.job,q,{retry:true})).reused,false);assert.equal(f.calls.length,2);
});
test('stderr extraction discards all free text and credentials while retaining typed codes',()=>{
 const d=platform.stderrDiagnostics('Bearer PRIVATE_TOKEN\n'+JSON.stringify({status:'error',error:{code:'CORAL_API_ERROR',status_code:503,message:'PRIVATE_MESSAGE',details:{code:34013,cookie:'PRIVATE_COOKIE'}}}));
 assert.equal(d.symbolicCode,'CORAL_API_ERROR');assert.equal(d.httpStatus,503);assert.equal(d.details.code,34013);assert.doesNotMatch(JSON.stringify(d),/PRIVATE|Bearer|message|cookie/);
 assert.deepEqual(platform.stderrDiagnostics('timeout PRIVATE_TOKEN'),{});
});
test('only evidenced transient errors get automatic retry; prose unavailable stays unknown',async t=>{
 const f=fixture(t);assert.equal(ledger.classify(Error('unknown unavailable timeout')),'INVALID_PLATFORM_RESPONSE');
 f.response=()=>{throw Object.assign(Error('PRIVATE_TOKEN'),{code:'ETIMEDOUT'});};const r=await ledger.fetch(f.a,f.job,q);
 assert.equal(r.errorCode,'TRANSIENT');assert.ok(r.operation.retryAt);assert.equal(ledger.eligibility(f.job,r.operation).action,'wait_until');
 r.operation.retryAt='2000-01-01T00:00:00Z';assert.equal((await ledger.fetch(f.a,f.job,q)).reused,false);
});
test('extra credential fields and untrusted diagnostic properties cannot enter a receipt',async t=>{
 const f=fixture(t);f.response=()=>{throw Object.assign(Error('Bearer PRIVATE_MESSAGE'),{code:'CORAL_API_ERROR',classificationBasis:'PRIVATE_BASIS',limitation:{token:'PRIVATE_LIMIT'},stderr:'PRIVATE_STDERR'});};
 const request={...q,token:'PRIVATE_QUERY',authorization:'PRIVATE_AUTH'},r=await ledger.fetch(f.a,f.job,request);
 assert.deepEqual(r.requestedQuery,q);assert.equal(r.receipt.classificationBasis,'unknown_response');assert.equal(r.receipt.limitation,undefined);
 assert.doesNotMatch(fs.readFileSync(f.a.file,'utf8'),/PRIVATE_/);
});

const synthetic=require('./helpers/platform-boundary-synthetic.cjs');
function syntheticMetadataFixture(){
 const value=job();value.executionContract=structuredClone(synthetic.contract);
 for(const [op,taskId,projectId,depth,completedAt,operationId]of synthetic.metadata())failure(value,{op,taskId,projectId,depth},operationId,{id:operationId,completedAt});
 return value;
}
test('synthetic SG contract without literal thirteen exposes 24 distinct pre-contract directions, never silently accepts all',()=>{
 const j=syntheticMetadataFixture(),before=JSON.stringify(j),result=boundaries.planMigration(j);
 assert.equal(Object.values(j.executionState.operations).length,59);assert.equal(result.records.length,0);assert.equal(result.unresolved[0].observed,24);assert.equal(JSON.stringify(j),before);
 for(const taskId of [710000038,710000039,710000042])assert.equal(boundaries.inspect(j,{op:'downstream',taskId,depth:1}).reason,'acceptance_set_unresolved');
 const postContract={op:'upstream',taskId:'710000045',projectId:9};assert.notEqual(boundaries.inspect(j,postContract).status,'accepted_boundary');
});
test('the explicit discovered-permissions contract needs no literal count when its frozen set is unambiguous',()=>{
 const j=job();j.executionContract.text=syntheticMetadataFixture().executionContract.text;
 for(let i=0;i<13;i++)failure(j,{...q,taskId:100+i},i);
 const r=boundaries.planMigration(j);assert.equal(r.records.length,13);j.executionState.acceptedBoundaries=r.records;
 failure(j,{...q,taskId:999},99,{completedAt:'2032-01-22T00:00:00Z'});
 assert.equal(boundaries.planMigration(j).changed,false);assert.notEqual(boundaries.inspect(j,{...q,taskId:999}).status,'accepted_boundary');
});
test('current same-direction path proof filters unrelated historical refusals before freezing acceptance',()=>{
 const j=job();j.executionContract.text=syntheticMetadataFixture().executionContract.text;
 const root=700000101,rows=[{id:root,projectId:7}];
 for(let i=0;i<13;i++){failure(j,{...q,taskId:100+i},i);rows.push({id:100+i,projectId:q.projectId,parentRelation:[{id:root}]});}
 failure(j,{...q,taskId:999},99);failure(j,{...q,taskId:100,op:'upstream'},100);
 const s=source(j,{op:'downstream',taskId:root,projectId:7},{nodes:rows});
 const r=boundaries.planMigration(j,{sources:[s]});assert.equal(r.records.length,13);assert.ok(r.records.every(b=>b.scopeProof?.sourceIds.includes(s.id)));assert.ok(r.records.every(b=>b.query.op==='downstream'&&b.query.taskId!==999));
 const replacement=source(j,{op:'downstream',taskId:root,projectId:7},{nodes:[rows[0]]},'replacement');replacement.previousSourceId=s.id;
 assert.equal(boundaries.planMigration(j,{sources:[s,replacement]}).records.length,0,'superseded path evidence cannot authorize migration');
});

function syntheticAcceptedFixture(){
 const value=syntheticMetadataFixture(),{roots,projects}=synthetic.config;value.userDirectives=structuredClone(synthetic.directives);
 return {job:value,sources:[source(value,{op:'downstream',taskId:roots[2],projectId:projects[3],depth:10},structuredClone(synthetic.downstream),'synthetic-downstream'),source(value,{op:'upstream',taskId:roots[2],projectId:projects[3],depth:10},structuredClone(synthetic.upstream),'synthetic-upstream')]};
}
test('synthetic SG acceptance provenance freezes exactly thirteen; the four later persisted denials retain their original proof',()=>{
 const {job:j,sources}=syntheticAcceptedFixture(),before=JSON.stringify({j,sources}),migration=boundaries.planMigration(j,{sources});
 assert.equal(migration.records.length,13);assert.deepEqual(migration.unresolved,[]);assert.equal(JSON.stringify({j,sources}),before);
 assert.deepEqual(migration.records.map(b=>b.query.op+':'+b.query.taskId).sort(),[
  ...[710000048,700001201,710000034,710000035,710000041,710000036,710000037,710000038,710000039,710000042,710000043].map(id=>'downstream:'+id),
  'upstream:700001203','upstream:700001204'].sort());
 assert.equal(migration.records.filter(b=>b.historicalDenial?.directiveId===j.userDirectives[0].id).length,4);
 assert.ok(migration.records.every(b=>b.decision.decisionId===j.userDirectives[1].id&&b.decision.setConfirmedAt==='2032-01-10T12:00:00Z'&&b.scopeProof.path.length>=2));
 assert.equal(boundaries.inspect(j,{op:'downstream',taskId:710000040,projectId:710000013,depth:1},{sources}).status,'ready');
 const noDecision=structuredClone(j);noDecision.userDirectives=[];
 assert.equal(boundaries.planMigration(noDecision,{sources}).unresolved[0].observed,14,'path and latest contract alone cannot select thirteen');
 const missingFailure=structuredClone(j);for(const [k,o] of Object.entries(missingFailure.executionState.operations))if(o.query.taskId==='710000038')delete missingFailure.executionState.operations[k];
 assert.equal(boundaries.planMigration(missingFailure,{sources}).records.length,0,'a directive never manufactures a real failure');
 j.executionState.acceptedBoundaries=migration.records;
 failure(j,{op:'downstream',taskId:710000040,projectId:710000013,depth:1},'later',{completedAt:'2032-01-21T12:00:00Z'});
 assert.equal(boundaries.planMigration(j,{sources}).changed,false);
 assert.equal(boundaries.inspect(j,{op:'downstream',taskId:710000040,projectId:710000013},{sources}).status,'ready');
});
test('SG historical corroboration cannot switch project/direction, trust source prose, or expand with later confirmation',()=>{
 for(const change of [
  j=>j.userDirectives[0].text=j.userDirectives[0].text.replace('710000013','710000019'),
  j=>j.userDirectives[0].text=j.userDirectives[0].text.replace('下游查询','上游查询'),
  j=>j.userDirectives[0].origin='model',
  j=>j.userDirectives[0].at='2032-01-20T00:00:00Z'
 ]){const {job:j,sources}=syntheticAcceptedFixture();change(j);assert.equal(boundaries.planMigration(j,{sources}).records.length,0);}
 const {job:j,sources}=syntheticAcceptedFixture();j.userDirectives.push({...j.userDirectives[1],id:'later-reaffirmation',at:'2032-01-20T18:00:00Z'});
 assert.equal(boundaries.planMigration(j,{sources}).records.length,13);
});
test('SG thirteen direction candidates and dispatch agree without data requests across depth or omitted project',async t=>{
 const f=fixture(t),sg=syntheticAcceptedFixture();f.job=sg.job;f.a.data.delegations=[f.job];f.a.data.sources=sg.sources;
 const options=ledger.boundaryOptions(f.a,f.job),scope=require('../desktop/lineage-scope.cjs').resolve(f.job);
 const rows=frontier.project(f.job,frontier.build(sg.sources,scope,sg.sources.map(s=>({sourceId:s.id}))),options);
 assert.equal(rows.filter(r=>r.status==='accepted_boundary').length,13);
 assert.ok(frontier.candidates(f.job,rows,options).every(r=>!options.records.some(b=>b.query.op===r.direction&&String(b.query.taskId)===r.nodeId)));
 const batch=await ledger.prepareBatch(f.a,f.job);
 for(const b of options.records)for(const depth of [1,10]){
  const requested={op:b.query.op,taskId:b.query.taskId,depth},r=await ledger.fetch(f.a,f.job,requested,{batch});
  assert.equal(r.status,'accepted_boundary');assert.equal(r.operationId,b.operationId);assert.deepEqual(r.requestedQuery,requested);assert.deepEqual(r.cachedQuery,b.query);assert.equal(r.originalObservedAt,b.originalObservedAt);
 }
 assert.equal(f.calls.length,0);assert.equal(f.identityCalls,1);
});
