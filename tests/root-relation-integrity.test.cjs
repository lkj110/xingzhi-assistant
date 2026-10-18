const {test}=require('node:test'),assert=require('node:assert/strict');
const coral=require('./root-relation-physical-fixture.cjs');
const {fixture}=require('./root-relation-fixture.cjs'),relations=require('../desktop/relation-obligations.cjs'),links=require('../desktop/evidence-links.cjs'),policy=require('../desktop/access-policy-store.cjs');
test('IR3 wrong root cannot be laundered by model rootIds or generic passed',t=>{
 const f=fixture(t),s=f.source('code',{taskId:999,sql:'SELECT x FROM other'},{taskId:999});
 const result=f.check([s.id]);assert.equal(result.result.passed,false);assert.equal(result.receipts.length,0);
});
for(const flag of [{coverage:'partial'},{truncated:true}])test('IR3 source limitation '+JSON.stringify(flag)+' overrides model complete',t=>{
 const f=fixture(t),s=f.source('code',undefined,undefined,flag);assert.equal(f.check([s.id]).result.passed,false);
});
for(const data of [{taskId:123,sql:'SELECT 1',hasMore:true},{taskId:123,sql:'SELECT 1',nextPage:2},{taskId:123,sql:'SELECT 1',total:20,rows:[1]}])test('IR3 incomplete page cannot close coverage '+JSON.stringify(data),t=>{
 const f=fixture(t),s=f.source('code',data);assert.equal(f.check([s.id]).result.passed,false);
});
test('another complete source can cover the root while the limited source remains disclosed',t=>{
 const f=fixture(t),partial=f.source('code',undefined,undefined,{truncated:true}),full=f.source();
 const r=f.check([partial.id,full.id]);assert.equal(r.result.passed,true);assert.deepEqual(r.receipts[0].limitedSourceIds,[partial.id]);
});
test('every root requires actual evidence and connected auxiliary evidence needs an explicit path',t=>{
 const f=fixture(t,{roots:['123','456']}),s=f.source('code',{taskId:999,sql:'SELECT 1'},{taskId:999,projectId:7});
 const first=f.source('downstream',{taskId:123,nodes:[{id:999,projectId:7,parentRelation:[{id:123}]}]},{taskId:123,depth:1});
 assert.equal(f.check([s.id,first.id]).result.passed,false);
 const second=f.source('downstream',{taskId:456,nodes:[{id:999,projectId:7,parentRelation:[{id:456}]}]},{taskId:456,depth:1});
 // A path proves membership, not either root's SQL. The former true assertion
 // let one shared descendant stand in for two missing root facts (CR-P1-1).
 assert.equal(f.check([s.id,first.id,second.id]).result.passed,false);
 const root1=f.source('code',{taskId:123,sql:'SELECT root1 FROM a'},{taskId:123}),root2=f.source('code',{taskId:456,sql:'SELECT root2 FROM b'},{taskId:456});
 assert.equal(f.check([s.id,first.id,second.id,root1.id,root2.id]).result.passed,true);
});
test('wrong direction, contradictory envelope, cross region and ambiguous project do not prove mapping',t=>{
 for(const variant of ['direction','envelope','region','project']){
  const f=fixture(t),sql=f.source('code',{taskId:999,sql:'SELECT 1'},{taskId:999,projectId:7});
  const graph=f.source('downstream',{taskId:variant==='envelope'?8:123,nodes:[{id:999,projectId:variant==='project'?8:7,...(variant==='region'?{region:'us',crossRegion:true}:{}),parentRelation:[{id:variant==='direction'?55:123}]}]},{taskId:123});
  assert.equal(f.check([sql.id,graph.id]).result.passed,false,variant);
 }
});
test('task detail proves SQL or outputs only when the corresponding content exists',t=>{
 const f=fixture(t,{kinds:'SQL读写、产出配置'}),detail=f.source('task',{id:123,name:'metadata only'});
 assert.equal(f.check([detail.id]).receipts.length,0);assert.equal(f.check([detail.id],{kind:'configured_outputs'}).receipts.length,0);
 const sql=f.source('task',{id:123,sql:'SELECT 1'}),out=f.source('task',{id:123,outputs:[{database:'db',table:'out'}]});
 assert.equal(f.check([sql.id]).receipts.length,1);assert.equal(f.check([sql.id],{kind:'configured_outputs'}).receipts.length,0);
 assert.equal(f.check([out.id],{kind:'configured_outputs'}).receipts.length,1);assert.equal(f.check([out.id]).receipts.length,0);
});
test('table lineage requires actual table type and a current task output mapping',t=>{
 const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out',entityType:'HiveTable'};
 const physical=f.source('table_lineage',coral.data(),q);
 assert.equal(f.check([physical.id],{kind:'physical_lineage'}).result.passed,false);
 const mapping=f.source('outputs',{taskId:123,outputs:[q]});
 assert.equal(f.check([physical.id,mapping.id],{kind:'physical_lineage'}).result.passed,true);
 const limited=f.source('table_lineage',{edges:[],inputEntityDepth:2},q);
 assert.equal(f.check([limited.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
});
test('invented complete flags never substitute for actual centered closure',t=>{
 for(const proof of [{},{complete:true},{pagination:{complete:true,noMore:true}},{complete:true,noMore:true},{complete:true,hasMore:false},{closure:{input:{complete:true,noMore:true},output:{complete:true,noMore:true}}},{closure:{input:{complete:true,noMore:true}}}]){
  const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out',entityType:'HiveTable'};
  const mapping=f.source('outputs',{taskId:123,outputs:[q]}),s=f.source('table_lineage',{edges:[],inputEntityDepth:2,outputEntityDepth:2,...proof},q);
  assert.equal(f.check([s.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
 }
});
test('hard truncation, pagination and missing Coral entities override platform closure',t=>{
 for(const delta of [{truncated:true},{hasMore:true},{pagination:{hasMore:true}},{closure:{input:{complete:false}}},{inputEntityCount:2},{inputEntityGuids:[['missing']]}]){
  const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out'};
  const mapping=f.source('outputs',{taskId:123,outputs:[q]}),s=f.source('table_lineage',{complete:true,noMore:true,inputEntityDepth:1,outputEntityDepth:1,inputEntityCount:0,outputEntityCount:0,inputEntityGuids:[],outputEntityGuids:[],guidEntityMap:{base:{typeName:'HiveTable',attributes:{name:'out',parentName:'db'}}},baseEntityGuid:'base',...delta},q);
  assert.equal(f.check([s.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
 }
});
test('Dorado task configuration uses typed nested SQL and explicit targets; metadata and shell code do not',t=>{
 const f=fixture(t,{kinds:'SQL读写、产出配置'});
 const task=f.source('task',{id:123,type:'hsql',conf:{configuration:{operator:{type:'operator',parameter:{engineType:'spark',code:'SELECT a FROM orders',targets:[{type:'partition',databaseName:'db',tableName:'out',storageRegion:'sg',partitions:[{key:'day',value:'${date}'}]}]}}}}});
 assert.equal(f.check([task.id]).receipts.length,1);assert.equal(f.check([task.id],{kind:'configured_outputs'}).receipts.length,1);
 const shell=f.source('task',{id:123,type:'shell',conf:{configuration:{operator:{type:'operator',parameter:{code:'echo success',targets:null}}}}});
 assert.equal(f.check([shell.id]).receipts.length,0);assert.equal(f.check([shell.id],{kind:'configured_outputs'}).receipts.length,0);
});
test('production-shaped Dorado outputs map Coral tables; depth counts alone remain incomplete',t=>{
 const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out'};
 const mapping=f.source('outputs',{taskId:123,outputs:[{type:'partition',storageRegion:'sg',databaseName:'db',tableName:'out',path:null,partitions:[{key:'day',value:'${date}'}]}]});
 const tasks=f.source('table_tasks',[{taskId:123,taskName:'producer',taskType:'hsql',taskTypeCode:1,taskOwner:'fixture',description:'fixture',query:'SELECT a FROM orders',projectId:7,canAccess:true,accessDeniedMsg:null,taskCid:1}],q);
 assert.equal(f.check([tasks.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
 const graph=coral.data('out',['input']);
 // An explicit original gap can acquire this real finite-depth content without
 // turning it into a complete relationship receipt.
 const o=relations.required(f.a,f.job,f.task)[0];f.need({requirements:[o.id],gaps:['入口123物理表血缘缺失']});
 const lineage=f.source('table_lineage',graph,q);assert.equal(f.check([lineage.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
 f.resolve([lineage.id,mapping.id]);assert.equal(relations.recoveryFacts(f.a,f.job,f.task).length,2);
});
test('Dorado output store, region and Coral database identity cannot be silently changed',t=>{
 for(const variant of ['store','region','database']){
  const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out'};
  const mapping=f.source('outputs',{taskId:123,outputs:[{type:variant==='store'?'ClickhouseTable':'partition',storageRegion:variant==='region'?'us':'sg',databaseName:'db',tableName:'out'}]});
  const graph=f.source('table_lineage',{baseEntityGuid:'base',guidEntityMap:{base:{typeName:'HiveTable',attributes:{name:'out',parentName:variant==='database'?'other':'db'}}}},q);
  assert.equal(f.check([graph.id,mapping.id],{kind:'physical_lineage'}).result.passed,false);
 }
});
test('current receipt loses authority after withdrawal, version change, revocation or missing mapping',t=>{
 for(const change of ['withdraw','version','revoke','mapping']){
  const f=fixture(t),sql=f.source('code',{taskId:999,sql:'SELECT 1'},{taskId:999}),map=f.source('downstream',{taskId:123,nodes:[{id:999,parentRelation:[123]}]});
  // The positive premise needs the root's own fact as well as the descendant.
  const root=f.source('code',{taskId:123,sql:'SELECT root_value FROM root_table'},{taskId:123});
  relations.record(f.job,f.check([sql.id,map.id,root.id]).receipts);assert.equal(relations.context(f.a,f.job,f.task)[0].status,'analyzed');
  if(change==='withdraw')links.withdrawSources(f.a,f.task,[sql.id],{reason:'撤回'});
  if(change==='version')sql.content+=' ';
  if(change==='mapping')f.task.sourceIds=f.task.sourceIds.filter(id=>id!==map.id);
  if(change==='revoke')policy.revoke(f.a,{principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+sql.id,jobId:f.job.id,taskId:f.task.id},operations:['local_read']},{trusted:true,actor:'user_command',command:'fixture'});
  assert.notEqual(relations.context(f.a,f.job,f.task)[0].status,'analyzed',change);assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),[]);
 }
});
function acceptedFailure(f,{op='code',taskId=123,projectId=7,errorCode='AUTH_REQUIRED'}={}){
 const query={op,taskId,projectId},operation={id:'failure-'+taskId,key:'failure-'+taskId,query,principal:f.job.platformPrincipal||null,permissionRevision:0,scope:f.job.dataPlatform,status:'failed',errorCode,completedAt:'2026-01-01T00:00:00Z',acceptedBoundary:{authority:'user',policy:'document_and_continue',decisionId:'accepted-'+taskId,coverage:'query'}};
 f.job.executionState.operations[operation.key]=operation;return operation;
}
test('exact authorized inaccessible root boundary can coexist with accessible complete evidence',t=>{
 const f=fixture(t,{roots:['123','456']}),s=f.source('code',{taskId:456,sql:'SELECT 1'},{taskId:456});acceptedFailure(f);
 const r=f.check([s.id]);assert.equal(r.result.passed,true);assert.equal(r.receipts[0].boundaries[0].rootId,'123');
 relations.record(f.job,r.receipts);assert.equal(relations.context(f.a,f.job,f.task)[0].status,'analyzed');
 f.job.executionState.permissionRevision++;assert.equal(relations.context(f.a,f.job,f.task)[0].status,'acquired');
});
test('other-root, other-type, unsupported or unaccepted failures do not grant a boundary',t=>{
 for(const variant of [{taskId:999},{op:'downstream'},{errorCode:'UNSUPPORTED_CAPABILITY'},{unaccepted:true}]){
  const f=fixture(t),op=acceptedFailure(f,variant);if(variant.unaccepted)delete op.acceptedBoundary;
  assert.equal(f.check([]).result.passed,false);
 }
});
test('context and semantic recovery inspections do not change workspace, journal or fees',t=>{
 const f=fixture(t),s=f.source();relations.record(f.job,f.check([s.id]).receipts);
 const before=JSON.stringify(f.a.data),fees=JSON.stringify(f.a.spendLedger);
 for(let i=0;i<3;i++){relations.context(f.a,f.job,f.task);relations.recoveryFacts(f.a,f.job,f.task);}
 assert.equal(JSON.stringify(f.a.data),before);assert.equal(JSON.stringify(f.a.spendLedger),fees);
});

test('table taskId cannot replace mapping; wrong physical type and base entity are rejected',t=>{
 const f=fixture(t,{kinds:'物理表血缘'}),q={database:'db',table:'out',entityType:'HiveTable'},out=f.source('outputs',{taskId:123,outputs:[q]});
 for(const [query,data] of [[{...q,taskId:123},{edges:[]}],[{...q,entityType:'ClickhouseTable'},{edges:[]}],[q,{baseEntityGuid:'x',guidEntityMap:{x:{typeName:'DummyTable',attributes:{name:'out'}}}}],[q,{baseEntityGuid:'x',guidEntityMap:{x:{typeName:'HiveTable',attributes:{name:'other'}}}}]]){
  const s=f.source('table_lineage',data,query);
  assert.equal(f.check([s.id],{kind:'physical_lineage'}).result.passed,false);
  if(!query.taskId)assert.equal(f.check([s.id,out.id],{kind:'physical_lineage'}).result.passed,false);
 }
});
test('an accepted different-region denial is not a boundary for the SG root',t=>{
 const f=fixture(t),op=acceptedFailure(f);op.query.region='us';assert.equal(f.check([]).result.passed,false);
});
test('all exact accepted boundaries remain boundaries, not acquired relation facts',t=>{
 const f=fixture(t);acceptedFailure(f);const result=f.check([]);assert.equal(result.result.passed,true);assert.equal(result.receipts[0].status,'accepted_boundary');
 relations.record(f.job,result.receipts);assert.equal(relations.context(f.a,f.job,f.task)[0].status,'accepted_boundary');assert.deepEqual(relations.recoveryFacts(f.a,f.job,f.task),[]);
});
test('capability mapping requires its actual successful authorized content receipt',t=>{
 const f=fixture(t,{kinds:'Aeolus映射'}),raw={operation:'dataset_mapping',query:{op:'dataset_mapping',taskId:123},data:{taskId:123,mappings:[{datasetId:'d1',table:'db.output'}]}};
 const s=f.source(raw.operation,raw.data,{taskId:123},{platformSnapshot:false,capabilityId:'mapping',lastObservationId:'run'});
 assert.equal(f.check([s.id],{kind:'dataset_mapping'}).result.passed,false);
 f.a.data.capabilities.push({id:'mapping',enabled:true,revision:1,allowedTools:['read_mapping']});f.job.capabilityGrants=[{id:'mapping',revision:1}];
 f.a.data.capabilityRuns.push({id:'run',jobId:f.job.id,capabilityId:'mapping',tool:'read_mapping',status:'done',resultHash:require('../desktop/evidence-basis.cjs').hash(JSON.parse(s.content))});
 const result=f.check([s.id],{kind:'dataset_mapping'});assert.equal(result.result.passed,true);
 relations.record(f.job,result.receipts);f.job.capabilityGrants=[];assert.notEqual(relations.context(f.a,f.job,f.task)[0].status,'analyzed');
});


test('mapping cannot traverse an intermediate node with conflicting current project evidence',t=>{
 const f=fixture(t),sql=f.source('code',{taskId:888,sql:'SELECT 1'},{taskId:888});
 const graph=f.source('downstream',{taskId:123,nodes:[{id:999,projectId:7,parentRelation:[123]},{id:888,parentRelation:[999]}]});
 const conflict=f.source('task',{id:999,projectId:8},{taskId:999});
 assert.equal(f.check([sql.id,graph.id,conflict.id]).result.passed,false);
});
