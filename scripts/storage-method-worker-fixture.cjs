'use strict';
// Synthetic legacy import + transport substitutes. After seed(), all business
// mutations use normal Worker RPC/production controllers. Never queries SG.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const agent=require('../desktop/agent.cjs'),continuation=require('../desktop/continuation-control.cjs');
const relations=require('../desktop/relation-obligations.cjs'),ledger=require('../desktop/operation-ledger.cjs');
const access=require('../desktop/access.cjs'),policy=require('../desktop/access-policy-store.cjs');
const outputs=require('../desktop/deliverables.cjs'),control=require('../desktop/execution-control.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const platform=require('../desktop/data-platform.cjs'),storage=require('../desktop/platform-result.cjs');
const spend=require('../desktop/spend.cjs');
const QUERY={op:'table_lineage',database:'db',table:'leaf'};
const LEGACY_ERROR='结果超过材料上限，请减小查询深度或分页读取';
const url='https://storage-fixture.feishu.cn/docx/StorageRecoveryFixture123';
const oldBody='# 物理血缘核对\n\n## 已核实\n入口123产出db.out；db.out上游是db.leaf。\n\n## 待核实\n缺少db.leaf自身中心，不能断言闭合。\n\n## 交付\n继续更新同一飞书文档。';
const fact='STORAGE_CENTER_VERIFIED：db.leaf自身中心上下游均为空，入口123的这条物理血缘已闭合。';
const revisedBody=oldBody.replace('缺少db.leaf自身中心，不能断言闭合。',fact);
const denied=()=>{throw Error('Real transport forbidden in storage Worker fixture');};
const clone=v=>structuredClone(v),json=v=>JSON.parse(JSON.stringify(v));
const node=(name,extra={})=>({guid:name,typeName:'HiveTable',attributes:{name,parentName:'db',qualifiedName:'HiveTable:///db/'+name+'@6',cid:6,inputToProcesses:[],outputFromProcesses:[],...extra}});
function coral(table,input=[]){return {baseEntityGuid:table,inputEntityCount:input.length,inputEntityDepth:1,inputEntityGuids:input.length?[input]:[],outputEntityCount:0,outputEntityDepth:1,outputEntityGuids:[],guidEntityMap:{...Object.fromEntries(input.map(n=>[n,node(n)])),[table]:node(table,{outputFromProcesses:input.length?[{guid:'process-123',typeName:'DoradoTask',attributes:{id:123,qualifiedName:'DoradoTask:///123@6',inputs:[],outputs:[],errorMessage:null}}]:[]})}};}
function largeData(){const data=coral('leaf');data.guidEntityMap.leaf.attributes.sql='SELECT synthetic_archive_only;\n'.repeat(Math.ceil(require('../desktop/documents.cjs').maxChars/25));return data;}
const key=n=>hash({obligationId:n.obligationId,rootIds:[...n.rootIds].sort(),direction:n.direction||null,query:require('../desktop/platform-boundaries.cjs').canonicalQuery(n.query)});
function current(f){const c=f.job.executionState.continuation;return c.episodes[c.activeBasis];}
function state(f){const {a,job,task}=f;return json({view:continuation.peek(a,job,task),jobId:job.id,taskId:task.id,jobStatus:job.status,taskStatus:task.status,primary:task.primaryArtifactId,paused:a.data.stewardship.paused,continuation:job.executionState.continuation,methodAttempts:job.executionState.evidenceMethodAttempts||{},request:task.evidenceRequest,resolution:task.lastEvidenceResolution,operations:job.executionState.operations,history:job.executionState.history,taskSources:task.sourceIds,ledger:a.spendLedger.scopes['job:'+job.id],policies:JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8')),failedRun:a.data.agentRuns.find(r=>r.id===f.baseline.run.id),contentVerification:task.contentVerification,checks:f.audit.checks});}
async function seed(a){
 await a.dispatch('saveProvider',{name:'storage synthetic transport',model:'storage-fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:2,cachedInputPrice:1});
 const job=agent.buildJob(a,{goal:'入口 IDs: 123\n\n范围：\n核对物理表血缘，修订现有主稿并更新原飞书文档，回读后等待用户验收。',dataPlatform:'sg-readonly',allowWeb:false,fileMode:'off',autoAccept:false,maxActions:20});a.data.delegations.push(job);
 const initial=agent.source(a,job,'storage-initial','原始要求','入口123，核对物理表血缘并保留原目标。');
 const plan={key:'storage-handover',title:'物理血缘核对',criteria:'逐项核对入口123的物理表血缘，修订原主稿、更新同一飞书并回读，等待用户验收。',sourceIds:[initial.id],steps:[{key:'draft',title:'修订原主稿',kind:'draft'},{key:'publish',title:'更新原飞书',kind:'external',tool:'lark_create'}]};
 const {taskId}=await agent.act(a,job,'plan_task',plan),task=a.task(taskId);
 const old={id:'storage-original-primary',taskId,stepId:task.steps[0].id,title:task.title,content:oldBody,createdAt:new Date().toISOString()};a.data.artifacts.push(old);Object.assign(task.steps[0],{done:true,artifactId:old.id});
 require('../desktop/protocol-access.cjs').retain(a,'artifact',old,{task,job});a.save();
 const request=access.request(a,job,{kind:'lark_create',target:'my_library',reason:'synthetic historical original document'}),d=a.data.decisions.find(d=>d.id===request.decisionId);
 await a.dispatch('accessRetry',{id:d.id,revision:require('../desktop/decisions.cjs').revision(a.data,d)});await a.runPromise;
 await a.dispatch('agentLarkCreatePolicy',{id:job.id,taskId,mode:'auto',allowUpdate:true,target:job.larkCreateGrant.target,openId:job.larkCreateGrant.openId});
 const receipt=await agent.act(a,job,'lark_create',{taskId});assert.equal(receipt.url,url);assert.equal(receipt.verified,true);
 await agent.act(a,job,'plan_task',{...plan,primaryArtifactId:old.id,steps:[plan.steps[0],{...plan.steps[1],tool:'lark_update'}],resetSteps:['publish'],reason:'历史文档沿同目标接续'});task.generationMode='single';
 // This goes through the real identity bootstrap and policy store; no ACL mock.
 job.executionState={version:2,permissionRevision:0,operations:{},requirements:[],gaps:[],reads:{},recoveries:{},events:[],...job.executionState};
 await ledger.prepareBatch(a,job);
 const source=(operation,data,query)=>agent.source(a,job,'storage-seed-'+operation,operation,JSON.stringify({operation,region:'sg',query,data}),{platformSnapshot:true,platformPrincipal:job.platformPrincipal});
 const mapping=source('outputs',{taskId:123,outputs:[{type:'partition',databaseName:'db',tableName:'out',storageRegion:'sg'}]},{op:'outputs',taskId:123});
 const root=source('table_lineage',coral('out',['leaf']),{op:'table_lineage',database:'db',table:'out'});
 require('../desktop/evidence-links.cjs').setInputs(a,task,[...task.sourceIds,mapping.id,root.id]);
 control.initialize(a);
 const needs=relations.evidenceNeeds(a,job,task);assert.equal(needs.length,1);assert.deepEqual(needs[0].query,QUERY);const need=needs[0];
 const intentBasis=hash({contract:job.executionContract?.text||job.goal,requirements:task.userRequirement?Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])):null});
 const basis=continuation.basis(a,job,task),at=n=>new Date(Date.now()-120000+n*1000).toISOString();
 const attempt={query:clone(QUERY),obligationId:need.obligationId,rootIds:need.rootIds,status:'failed',at:at(2),finishedAt:at(5),errorCode:'EVIDENCE_RESULT_UNAVAILABLE',error:LEGACY_ERROR};
 const episode={taskId,basis,intentBasis,fromValidationGrantId:'synthetic-prior-validation',cycles:3,hops:2,executions:6,blocked:true,reason:'原三次修订额度耗尽',factKeys:[...new Set(relations.recoveryFacts(a,job,task).map(hash))].sort(),evidenceAcquisition:{version:1,requestBasis:'synthetic-legacy-request',attempts:{[key(need)]:attempt}}};
 job.executionState.continuation={version:1,activeTaskId:taskId,activeBasis:basis,episodes:{[basis]:episode}};
 const check=policy.checkTool(a,job,'platform_query',{queries:[QUERY]});assert.equal(check.allowed,true);
 const operation={id:'synthetic-legacy-interrupted-operation',key:ledger.key(job,QUERY),query:clone(QUERY),actualQuery:clone(QUERY),requestedQuery:clone(QUERY),epoch:ledger.epoch(job),permissionRevision:job.executionState.permissionRevision||0,scope:job.dataPlatform,projectId:job.projectId||null,workRevision:job.workRevision??1,principal:clone(job.platformPrincipal),policy:hash({policyId:check.policyId,grantRevision:check.grantRevision}),status:'interrupted',attempt:1,startedAt:at(3)};
 job.executionState.operations[operation.key]=operation;
 const run={id:'synthetic-legacy-size-failure',jobId:job.id,status:'done',startedAt:at(0),finishedAt:at(6),modelCalls:0,modelCallsDetail:[],steps:[{tool:'platform_query',args:{taskId,queries:[clone(QUERY)]},at:at(1),continuation:{handled:true,tracked:true,kind:'evidence',basis},evidenceAcquisition:{taskId,episodeBasis:basis,requestBasis:episode.evidenceAcquisition.requestBasis,targets:[clone(need)]},result:{results:[{query:clone(QUERY),error:LEGACY_ERROR}]}}]};a.data.agentRuns.unshift(run);
 task.contentVerification={passed:false,basis:control.contentBasis(a,job,task),summary:'缺少db.leaf自身中心',gaps:['缺少db.leaf自身中心'],gapDetails:[{kind:'evidence',requirementId:need.obligationId,relationKind:'physical_lineage',rootIds:need.rootIds,artifactId:old.id,stepId:task.steps[0].id,text:'缺少db.leaf自身中心'}]};
 job.status='blocked';job.nextRunAt=null;job.lastError=episode.reason;
 // Reproduce the production cross-condition: after a method claim disappears
 // from candidates, the old efficiency guard would reject the same dispatch.
 job.executionState.workEfficiency={version:2,progressVersion:1,intent:require('../desktop/work-efficiency.cjs').intent(a,job),seen:[],attempts:18,phase:'awaiting_change',tried:{},history:[],lastFailure:{code:'CONTINUATION_EXHAUSTED',message:episode.reason,taskId,scope:'task'}};
 a.activeAgentJob=job;const budget=spend.scope(a);budget.limitUSD=200;const billed=spend.reserve(a,a.data.providers[0],[],{}),usage=spend.usage({inputTokens:1000000,outputTokens:0});spend.settle(a,billed,usage,spend.cost(usage,billed.pricing));const unknown=spend.reserve(a,a.data.providers[0],[],{});spend.settle(a,unknown,null,null);a.activeAgentJob=null;
 a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.save();
 return {a,job,task,old,baseline:{run:clone(run),episode:clone(episode),operation:clone(operation),attempt:clone(attempt),need:clone(need),ledger:clone(budget),receipt:clone(a.data.agentActions.find(r=>r.tool==='lark_create')),policies:JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8'))}};
}
function assertHistory(f){
 const {a,job,task,baseline:b}=f,old=job.executionState.continuation.episodes[b.episode.basis];
 assert.equal(old.cycles,3);assert.equal(old.fromValidationGrantId,b.episode.fromValidationGrantId);assert.equal(old.blocked,true);
 assert.deepEqual(a.data.agentRuns.find(r=>r.id===b.run.id),b.run,'immutable original raw run/result');
 assert.equal(a.data.artifacts.find(r=>r.id===f.old.id).content,oldBody);
 assert.equal(job.autoAccept,false);assert.equal(task.acceptedAt??null,null);assert.equal(job.completedAt??null,null);
 const budget=a.spendLedger.scopes['job:'+job.id];assert.equal(budget.limitUSD,200);assert.ok(budget.spentUSD>=b.ledger.spentUSD);assert.ok(Math.abs(budget.heldUSD-Object.values(budget.pending).reduce((sum,p)=>sum+p.reservedUSD,0)-b.ledger.heldUSD)<1e-9);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8')),b.policies,'normal ACLs must survive');
 assert.deepEqual(a.data.agentActions.find(r=>r.id===b.receipt.id).result,b.receipt.result);
}
function assertAcquired(f){
 const {a,job,task,audit,baseline:b}=f;assertHistory(f);assert.deepEqual(audit.violations,[]);
 assert.equal(audit.platformCalls.length,1);assert.equal(audit.events.filter(e=>e.kind==='claim_before_network').length,1);
 const claims=Object.values(job.executionState.evidenceMethodAttempts||{});assert.equal(claims.length,1);assert.equal(claims[0].method,'coral-structural-v1');assert.equal(claims[0].status,'done');assert.deepEqual(claims[0].proof.previousAttempt,b.attempt);
 const retained=Object.values(job.executionState.continuation.episodes[b.episode.basis].evidenceAcquisition.attempts).find(r=>r.methodClaimKey===claims[0].key);assert.deepEqual(retained.previousAttempt,b.attempt);
 const source=a.data.sources.find(s=>s.id===task.lastEvidenceResolution?.sourceIds?.[0])||a.data.sources.find(s=>s.platformArchive);
 assert.ok(source&&task.sourceIds.includes(source.id)&&job.sourceIds.includes(source.id),'actual result atomically bound to original task');
 const snapshot=JSON.parse(source.content),manifest=snapshot.platformResult;assert.deepEqual(snapshot.query,QUERY);assert.equal(manifest.version,2);assert.equal(manifest.format,'platform-chunks-v2');assert.equal(manifest.codec,'gzip-base64-chunks');assert.equal(manifest.dataView,'manifest_only');assert.equal(snapshot.platformArchive,undefined);
 assert.ok(Array.isArray(source.platformArchive?.chunks));assert.equal(source.platformArchive.chunks.length,manifest.chunkCount);assert.equal(source.platformArchive.manifestHash,hash(manifest));assert.equal(source.platformArchive.body,undefined);
 assert.ok(source.content.length<require('../desktop/documents.cjs').maxChars);
 assert.equal(snapshot.data.guidEntityMap,undefined,'manifest directory cannot stand in for a complete graph');assert.equal(snapshot.data.incomplete,true);
 for(const chunk of source.platformArchive.chunks)assert.ok(!source.content.includes(chunk.body),'archive encoding stays out of public content');
 assert.deepEqual(storage.restore(snapshot,source),largeData(),'same-source v2 archive restores all SQL and structure');
 assert.ok(snapshot.platformResult.rawBytes>require('../desktop/documents.cjs').maxChars);
 assert.equal(relations.physicalContext(a,job,task).closureProven,true);
 assert.ok(require('../desktop/protocol-access.cjs').allowedObject(a,'source',source,job,task));
 assert.ok(task.lastEvidenceResolution?.recoveryProof,'real source association proof');
 assert.notEqual(current(f).basis,b.episode.basis,'new related fact must create ordinary continuation basis');
 assert.equal(current(f).fromValidationGrantId,b.episode.fromValidationGrantId);
 assert.ok(current(f).factKeys.some(k=>!b.episode.factKeys.includes(k)),'new semantic fact, not just a new source id');
 const steps=a.data.agentRuns.filter(r=>r.id!==b.run.id).flatMap(r=>r.steps||[]);
 assert.equal(steps.filter(s=>s.tool==='platform_query').length,1);assert.equal(steps.find(s=>s.tool==='platform_query').continuation.kind,'evidence');
 assert.ok(steps.some(s=>s.tool==='plan_task'&&s.args.evidenceResolution&&!s.error));
 assert.deepEqual(job.executionState.history.find(o=>o.id===b.operation.id),b.operation);
 return source;
}
function assertCheckpoint(f){assertAcquired(f);assert.equal(f.a.data.stewardship.paused,true);assert.equal(f.audit.connectorCalls.filter(c=>c.args[1]==='+update').length,0);assert.equal(f.audit.events.filter(e=>e.kind==='revision_generated').length,1);assert.equal(current(f).pendingCheck.status,'interrupted');return {claimCount:1,platformCalls:1,oldCycles:3};}
function assertComplete(f){
 assertAcquired(f);const {a,job,task,audit}=f;assert.equal(job.status,'review');assert.equal(task.status,'review');assert.equal(outputs.primary(a,task).content,revisedBody);assert.equal(task.contentVerification.passed,true);assert.equal(task.contentVerification.basis,control.contentBasis(a,job,task));assert.equal(task.verification.passed,true);
 const updates=a.data.agentActions.filter(r=>r.tool==='lark_update');assert.equal(updates.length,1);assert.equal(updates[0].status,'done');assert.equal(updates[0].result.url,url);assert.equal(updates[0].artifactId,task.primaryArtifactId);assert.equal(a.data.sources.find(s=>s.id===updates[0].result.sourceId).content,revisedBody);
 assert.equal(audit.connectorCalls.filter(c=>c.args[1]==='+update').length,1);assert.equal(audit.events.filter(e=>e.kind==='revision_generated').length,1);
 assert.deepEqual(audit.checks.map(c=>[c.kind,c.passed]),[['content',true],['result',true],['goal',true]]);
 assert.equal(audit.events.filter(e=>e.kind==='acquired_body_consumed').length,1);
 assert.ok(audit.events.findIndex(e=>e.kind==='associated_fresh_fact')<audit.events.findIndex(e=>e.kind==='acquired_body_consumed'));
 assert.ok(audit.events.findIndex(e=>e.kind==='acquired_body_consumed')<audit.events.findIndex(e=>e.kind==='revision_generated'));
 assert.deepEqual(a.spendLedger.scopes['job:'+job.id].pending,{});
 const source=assertAcquired(f),manifest=JSON.parse(source.content).platformResult;
 return {status:job.status,workerThreadId:audit.workerThreadId,platformCalls:1,methodClaims:1,oldCycles:3,updates:1,compressedArchive:true,userAccepted:false,sourceId:source.id,archive:{format:manifest.format,rawBytes:manifest.rawBytes,rawSha256:manifest.rawSha256,compressedBytes:manifest.compressedBytes,compressedSha256:manifest.compressedSha256,chunkCount:manifest.chunkCount,envelopeHash:manifest.envelopeHash,bindingHash:manifest.bindingHash,limitChars:require('../desktop/documents.cjs').maxChars}};
}
function assertBlocked(f){assertAcquired(f);const {job,task,audit}=f;assert.equal(job.status,'blocked');assert.equal(current(f).blocked,true);assert.equal(current(f).cycles,3);assert.ok(task.contentVerification,JSON.stringify({episode:current(f),checks:audit.checks,events:audit.events,run:f.a.data.agentRuns[0]}));assert.equal(task.contentVerification.passed,false);assert.notEqual(task.status,'review');assert.equal(audit.connectorCalls.filter(c=>c.args[1]==='+update').length,0);assert.equal(audit.checks.filter(c=>c.kind==='content'&&!c.passed).length,3);assert.equal(audit.checks.some(c=>c.passed),false);assert.equal(new Set(audit.checks.map(c=>c.artifactId)).size,3,'each failed check must inspect a changed primary revision');assert.equal(audit.events.filter(e=>e.kind==='revision_generated').length,3);return {status:'blocked',oldCycles:3,newCycles:3,updates:0,methodClaims:1};}
function inputText(input,value=input){const at=p=>p.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],input);const out=[];const walk=x=>{if(!x||typeof x!=='object')return;for(const [k,v] of Object.entries(x)){if(typeof v==='string')out.push(v);else if(v&&typeof v==='object'){if(k.endsWith('Ref')&&v.path){const text=at(v.path);assert.equal(typeof text,'string');out.push(text.slice(v.start,v.end));}else walk(v);}}};walk(value);return out.join('\n');}
async function setup({Assistant=require('../desktop/core.cjs').Assistant,options={},scenario='storage_method_recovery',reportFile,restoreAudit=false}={}){
 const restored=restoreAudit?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
 const audit=restored||{layer:'controlled',productionDelivery:'not_verified',scenario,events:[],violations:[],modelInputs:[],platformCalls:[],connectorCalls:[],checks:[]};audit.workerThreadId=require('node:worker_threads').threadId;
 const remote=restored?.remote||{body:oldBody,revision:1};let f,seeding=!restored;
 const saveAudit=()=>{if(reportFile)fs.writeFileSync(reportFile,JSON.stringify({...audit,remote,baseline:f?.baseline,ids:f?{jobId:f.job.id,taskId:f.task.id,oldId:f.old.id}:null},null,2));};
 const event=(kind,detail={})=>{audit.events.push({kind,...detail});saveAudit();};
 const checked=fn=>async(...args)=>{try{return await fn(...args);}catch(e){audit.violations.push(e.stack||e.message);saveAudit();throw e;}};
 const connectorRequest=checked(async(args,opts={})=>{
  audit.connectorCalls.push({args,input:opts.input,baseline:seeding});saveAudit();
  if(args[1]==='status')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_storage_fixture',userName:'测试人',scope:access.scopes('my_library').join(' ')}}};
  if(args[1]==='+create'){assert.ok(seeding);assert.equal(opts.input,oldBody);return {ok:true,data:{document:{document_id:'StorageRecoveryFixture123',url}}};}
  assert.ok(args.includes(url)||args.includes('StorageRecoveryFixture123'));
  if(args[1]==='+fetch'){event('lark_readback',{revision:remote.revision,baseline:seeding});return {ok:true,data:{document:{content:remote.body,revision_id:remote.revision}}};}
  if(args[1]==='+update'){assert.equal(seeding,false);assertAcquired(f);assert.equal(f.task.contentVerification.passed,true);assert.equal(f.task.contentVerification.basis,control.contentBasis(f.a,f.job,f.task));assert.equal(opts.input,revisedBody);assert.equal(audit.connectorCalls.filter(c=>c.args[1]==='+update').length,1);remote.body=opts.input;remote.revision=2;event('lark_update');return {ok:true,data:{result:'success',document:{document_id:'StorageRecoveryFixture123',revision_id:2}}};}
  throw Error('Unexpected connector command '+JSON.stringify(args));
 });
 const a=new Assistant({...options,chat:denied,agentRequest:denied,connectorRequest,platformRequest:denied,officeRequest:denied,webRequest:denied,feedRequest:denied});
 // Unlike the generic helper, even identity requests observe the durable claim
 // during recovery. The bootstrap identity is the only pre-seed exception.
 a.platformRequest=checked(async args=>{
  if(!seeding){
   const disk=JSON.parse(fs.readFileSync(a.file,'utf8')),job=disk.delegations.find(j=>j.id===f.job.id),claims=Object.values(job.executionState.evidenceMethodAttempts||{});
   assert.equal(claims.length,1,'persist method claim BEFORE every network request, including identity');assert.equal(claims[0].status,'started');assert.equal(claims[0].method,'coral-structural-v1');const ownedRun=disk.agentRuns.find(r=>r.id===claims[0].dispatch?.runId),ownedStep=ownedRun?.steps.find(s=>s.id===claims[0].dispatch.stepId);assert.ok(ownedStep&&ownedStep.dispatch.id===claims[0].dispatch.id,'claim and original step atomically durable');assert.equal(ownedStep.dispatch.phase,'dispatch_started');assert.deepEqual(claims[0].proof.previousAttempt,f.baseline.attempt);assert.ok(disk.tasks.find(t=>t.id===f.task.id).evidenceRequest);
  }
  if(JSON.stringify(args)===JSON.stringify(platform.command({op:'identity'})))return {username:'storage-fixture'};
  assert.equal(seeding,false);assert.deepEqual(args,platform.command(QUERY));assert.equal(audit.platformCalls.length,0,'method may dispatch at most once across cold Workers');assert.equal(audit.modelInputs.length,0,'deterministic acquisition must precede model planning/revision');
  assert.equal(f.job.executionState.continuation.episodes[f.baseline.episode.basis].cycles,3);
  audit.platformCalls.push(clone(QUERY));event('claim_before_network');const data=largeData();assert.ok(JSON.stringify(data).length>require('../desktop/documents.cjs').maxChars);return data;
 });
 if(restored){f={a,job:a.data.delegations.find(j=>j.id===restored.ids.jobId),task:a.task(restored.ids.taskId),old:a.data.artifacts.find(r=>r.id===restored.ids.oldId),baseline:restored.baseline};assert.ok(f.job&&f.task&&f.old);}else f=await seed(a);
 Object.assign(f,{audit,remote,saveAudit});seeding=false;event(restored?'cold_worker_loaded':'baseline_ready');
 a.chat=checked(async(_provider,_key,messages,opts)=>{
  const system=messages[0].content,input=JSON.parse(messages[1].content),primary=outputs.primary(a,f.task);opts.onUsage?.({inputTokens:100,outputTokens:30});audit.modelInputs.push({role:opts.role,stage:opts.stage,context:input});saveAudit();
  assertAcquired(f);
  if(system.includes('动作格式')){
   assert.equal(scenario,'storage_method_recovery_false');assert.ok(audit.checks.some(c=>c.passed===false),'planner may only follow actual failed revised checks');
   event('failed_check_revision_requested',{artifactId:primary.id});
   return {tool:'revise_task',args:{taskId:f.task.id,artifactId:primary.id,note:'针对仍未通过的正文检查局部修订，保留真实来源和原目标'}};
  }
  const text=inputText(input);
  if(opts.role==='verify'){
   const kind=system.includes('整体委托')?'goal':input.verificationPhase==='content'?'content':'result';
   if(kind==='content'&&!audit.pauseInjected){audit.pauseInjected=true;await a.dispatch('stewardshipPause',{});event('pause_during_check');return {kind:'read_context',requests:[{tool:'read_source',sourceId:assertAcquired(f).id}]};}
   assert.ok(text.includes('STORAGE_CENTER_VERIFIED'),'verifier must receive revised current body');
   const passed=scenario!=='storage_method_recovery_false';audit.checks.push({kind,passed,artifactId:primary.id});event('check_returned',{phase:kind,passed});
   if(!passed)return {passed:false,summary:'正文仍有未满足的准确说明',gaps:['正文仍有未满足的准确说明'],gapDetails:[{kind:'text',requirementId:'task:'+f.task.id,artifactId:primary.id,stepId:f.task.steps[0].id,text:'正文仍有未满足的准确说明'}]};
   if(kind==='result')assert.ok(inputText(input,input.deliveryEvidence).includes(revisedBody),'result verifier must consume actual same-target readback');
   if(kind!=='content'){assert.equal(remote.body,revisedBody);assert.ok(a.data.agentActions.some(r=>r.tool==='lark_update'&&r.status==='done'));}
   return {passed:true,summary:'实际中心和原目标回读均已核对',gaps:[],relationCoverage:relations.required(a,f.job,f.task).map(o=>({obligationId:o.id,status:'analyzed',coverage:'complete',rootIds:o.rootIds,sourceIds:f.task.sourceIds,summary:'入口123产出db.out，上游db.leaf已取得自身中心；各自中心上下游结构已逐项核对'}))};
  }
  const revisions=audit.events.filter(e=>e.kind==='revision_generated').length;
  if(!revisions){assert.equal(primary.id,f.old.id);assert.ok(text.includes(oldBody),'original primary must be supplied for local revision');assert.equal(f.task.steps[0].targetArtifactId,f.old.id);if(!audit.events.some(e=>e.kind==='associated_fresh_fact'))event('associated_fresh_fact',{sourceId:assertAcquired(f).id,basis:current(f).basis});
   const source=assertAcquired(f),reads=(input.contextReads||[]).filter(r=>r.request?.sourceId===source.id);
   if(!reads.length)return {kind:'read_context',requests:[{tool:'search_source',sourceId:source.id,query:'baseEntityGuid',limit:1},{tool:'search_source',sourceId:source.id,query:'inputEntityCount outputEntityCount',limit:2}]};
   for(const read of reads)assert.equal(read.result?.ok,true);const body=inputText(input,reads.map(r=>r.result));
   assert.ok(/"baseEntityGuid"\s*:\s*"leaf"/.test(body),'read must identify actual leaf center');
   assert.ok(/"inputEntityCount"\s*:\s*0/.test(body),'bounded source search must consume actual input count');
   assert.ok(/"outputEntityCount"\s*:\s*0/.test(body),'bounded source search must consume actual output count');
   event('acquired_body_consumed',{sourceId:source.id});
  }
  assert.match(system,/kind.*patch/);event('revision_generated',{originalArtifactId:primary.id});
  return {kind:'patch',edits:[revisions?{before:fact+(revisions>1?'\n补充核对1。':''),after:fact+'\n补充核对'+revisions+'。'}:{before:'缺少db.leaf自身中心，不能断言闭合。',after:fact}],summary:'依据原缺口真实新中心局部修订当前原稿',...(input.evidenceConsumption?{evidenceIntegration:input.evidenceConsumption.targetFacts.map(({factKey,obligationId})=>({factKey,obligationId,sectionId:input.revision.sections.find(section=>section.title==='待核实').id,quote:fact}))}:{})};
 });
 saveAudit();return f;
}
module.exports={setup,state,assertCheckpoint,assertComplete,assertBlocked,assertHistory,largeData,coral,url,oldBody,revisedBody};
