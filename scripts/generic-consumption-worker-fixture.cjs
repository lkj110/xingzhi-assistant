'use strict';
// Controlled future transitions; not a production SG or platform result.
// Only seed() supplies an old state. Afterwards App controllers own all changes.
const assert=require('node:assert/strict'),fs=require('node:fs');
const agent=require('../desktop/agent.cjs'),access=require('../desktop/access.cjs'),relations=require('../desktop/relation-obligations.cjs'),outputs=require('../desktop/deliverables.cjs'),continuation=require('../desktop/continuation-control.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const url='https://generic-fixture.feishu.cn/docx/GenericConsumptionFixture123';
const oldBody='# 交接\n\n## 已有事实\n入口123输出db.out。\n\n## 血缘核对\n待补齐各中心，保留尚未核实的边界。\n\n## 交付\n更新同一飞书文档。';
const coral=require('../tests/root-relation-physical-fixture.cjs');
const deny=()=>{throw Error('Controlled fixture forbids actual transports');};
const recoveryScenarios=['preflight_recovery','v2_recovery','local_recovery'];
function platformData(table,scenario){const data=coral.data(table,table==='leaf'?['tail']:[]);if(table==='leaf'&&['v2_recovery','local_recovery'].includes(scenario))data.guidEntityMap.leaf.attributes.controlledMetadata='controlled retained metadata '.repeat(28000);return data;}
const rows=v=>Array.isArray(v)?v:[];
function transportCounts(f){return {identity:f.audit.identity||0,platform:f.audit.queries.length,methodClaims:Object.keys(f.job.executionState.evidenceMethodAttempts||{}).length,models:f.job.callsUsed};}
async function seedRecovery(f,scenario){
 const {a,job,task,audit}=f,episode=job.executionState.continuation.episodes[f.originalBasis];
 const recovery=require('../desktop/evidence-recovery.cjs'),method=require('../desktop/evidence-storage-method.cjs'),ledger=require('../desktop/operation-ledger.cjs'),legacy=require('../desktop/evidence-legacy-preflight.cjs');
 const need=recovery.needs(a,job,task).find(n=>n.query?.table==='leaf');assert.ok(need,'controlled leaf must be an actual typed gap');
 const query=structuredClone(need.query),initial={kind:scenario,query,need:structuredClone(need)};audit.recovery=initial;
 if(scenario==='local_recovery'){
  // Generate an actual retained receipt through normal scheduling, then fail
  // the real source+operation save. No handcrafted request/response identity.
  const save=a.save.bind(a),max=job.maxActions;let failed=false;job.maxActions=1;
  a.save=()=>{const op=Object.values(job.executionState.operations).find(o=>o.query?.table==='leaf');if(!failed&&op?.status==='done'&&a.data.sources.some(s=>s.id===op.sourceId)){failed=true;throw Object.assign(Error('controlled source commit ENOSPC'),{code:'ENOSPC'});}return save();};
  try{await agent.run(a,job.id);}finally{a.save=save;job.maxActions=max;}
  assert.equal(failed,true,'must reach actual source save failure');
  const op=Object.values(job.executionState.operations).find(o=>o.query?.table==='leaf');assert.equal(op.errorCode,'LOCAL_RESULT_STORAGE');assert.equal(op.responses.length,1);assert.ok(op.requests[0].requestId);
  assert.ok(!a.data.sources.some(s=>s.id===op.sourceId));assert.equal(audit.patches.length,0);assert.equal(audit.writes,0);
  Object.assign(initial,{operationId:op.id,attemptId:op.attemptId,logicalKey:op.logicalKey,requests:structuredClone(op.requests),responseHash:op.responses[0].dataHash,operationHash:hash(op),failureCode:op.errorCode,runId:op.requests[0].runId});
  f.originalCycles=job.executionState.continuation.episodes[f.originalBasis].cycles;
 }else{
  // Explicitly controlled historical adapters; never alter a real SG row to
  // manufacture the scope/dispatch proof absent from production history.
  const at=n=>new Date(Date.UTC(2026,9,17,0,0,n)).toISOString(),check=require('../desktop/access-policy-store.cjs').checkTool(a,job,'platform_query',{queries:[query]});
  const error=scenario==='preflight_recovery'?'controlled historical identity timeout':'controlled historical local size failure',code=scenario==='preflight_recovery'?'TRANSIENT':'INVALID_PLATFORM_RESPONSE';
  const attempt={query:structuredClone(query),rootIds:need.rootIds,obligationId:need.obligationId,status:'failed',at:at(3),finishedAt:at(6),errorCode:code,error};
  episode.evidenceAcquisition={requestBasis:'controlled-old-request',attempts:{[method.attemptKey(need)]:attempt}};
  const step={id:'controlled-old-step',tool:'platform_query',args:{taskId:task.id,queries:[query]},at:at(1),error,errorCode:code,evidenceAcquisition:{taskId:task.id,episodeBasis:episode.basis,requestBasis:'controlled-old-request',targets:[structuredClone(need)]}};
  const run={id:'controlled-old-run',jobId:job.id,status:'paused',error,startedAt:at(0),finishedAt:at(7),modelCalls:0,modelCallsDetail:[],steps:[step]};
  step.dispatch={id:step.id,stepId:step.id,jobId:job.id,taskId:task.id,runId:run.id,tool:step.tool,argsHash:hash(step.args),phase:'dispatch_started',preparedAt:at(2),scopeHash:hash(legacy.scope(job,task)),policyHash:hash({policyId:check.policyId,grantRevision:check.grantRevision}),requests:[{query:{op:'identity'},at:at(4),phase:'dispatch_started'}]};
  if(scenario==='preflight_recovery')step.dispatch.failure={dispatchId:step.id,stepId:step.id,runId:run.id,phase:'dispatch_started',code,message:error,at:at(5)};
  else{
   const data=platformData('leaf',scenario),raw=JSON.stringify(data),diagnostics={stage:'storage',reason:'structural_limit',rawBytes:Buffer.byteLength(raw),rawSha256:require('node:crypto').createHash('sha256').update(raw).digest('hex'),limitChars:500000};
   const op={id:'controlled-original-operation',key:ledger.key(job,query),query:structuredClone(query),requestedQuery:structuredClone(query),actualQuery:structuredClone(query),scope:job.dataPlatform,projectId:job.projectId||null,principal:job.platformPrincipal,permissionRevision:job.executionState.permissionRevision||0,workRevision:job.workRevision||1,policy:step.dispatch.policyHash,epoch:ledger.epoch(job),status:'failed',attempt:1,errorCode:code,error,startedAt:at(3),completedAt:at(5)};
   op.receipt={version:1,operationId:op.id,requestedQuery:query,originalQuery:query,actualQuery:query,classification:code,diagnostics,dispatched:true,observedAt:op.completedAt};
   job.executionState.operations[op.key]=op;step.dispatch.requests.push({query:structuredClone(query),at:at(4)});step.result={results:[{query,operationId:op.id,error,errorCode:code,receipt:structuredClone(op.receipt)}]};
   Object.assign(initial,{operationId:op.id,operationHash:hash(op),familyKey:require('../desktop/evidence-storage-family.cjs').familyKey(job,op)});
  }
  a.data.agentRuns.push(run);Object.assign(initial,{runId:run.id,runHash:hash(run),attemptHash:hash(attempt)});a.save();
  if(scenario==='preflight_recovery'){initial.proof=legacy.buildProof(a,job,task,{runId:run.id,stepId:step.id,query});assert.equal(initial.proof.eligible,true,initial.proof.reason);}
  else {initial.proof=method.eligibility(a,job,task,episode,need);assert.equal(initial.proof.eligible,true,initial.proof.reason);assert.equal(initial.proof.method,'platform-chunks-v2');}
 }
 initial.counts=transportCounts(f);initial.ledger=structuredClone(a.spendLedger.scopes['job:'+job.id]);
 a.save();f.saveAudit();
}
function recoveryView(f){
 const {a,job,task,audit}=f,initial=audit.recovery;if(!initial)return null;
 const ops=Object.values(job.executionState.operations||{}),history=job.executionState.history||[],source=op=>a.data.sources.find(s=>s.id===op?.sourceId);
 const original=[...ops,...history].find(o=>o.id===initial.operationId),current=ops.find(o=>o.status!=='superseded'&&o.query?.table==='leaf');
 const claims=Object.values(job.executionState.evidenceMethodAttempts||{}),events=require('../desktop/work-journal.cjs').read(a).events;
 const attempts=Object.values(job.executionState.continuation.episodes).flatMap(e=>[...Object.values(e.evidenceAcquisition?.attempts||{}),...rows(e.evidenceAcquisition?.attemptHistory)]);
 const s=source(current),check=s&&require('../desktop/access-policy-store.cjs').check(a,{principalScope:require('../desktop/access-policy-store.cjs').LOCAL,resourceScope:{kind:'snapshot',key:'source:'+s.id,jobId:job.id},operation:'local_read'});
 return {initial,counts:transportCounts(f),oldRunHash:hash(a.data.agentRuns.find(r=>r.id===initial.runId)),oldAttemptPreserved:initial.attemptHash?attempts.some(v=>hash(v)===initial.attemptHash):null,
  originalOperationHash:original?hash(original):null,corrections:events.filter(e=>e.type==='evidence_preflight_reclassified_v1').map(e=>({eventId:e.eventId,payload:e.payload})),
  associations:events.filter(e=>e.type==='evidence_plan_committed'&&e.entityId===task.id).map(e=>({eventId:e.eventId,proof:e.payload?.task?.set?.lastEvidenceResolution?.recoveryProof})),
  claims:claims.map(c=>({key:c.key,method:c.method,familyKey:c.familyKey,originOperationId:c.originOperationId,operationId:c.operationId,sourceId:c.sourceId,status:c.status})),
  operation:current&&{id:current.id,status:current.status,attemptId:current.attemptId,logicalKey:current.logicalKey,sourceId:current.sourceId,requests:current.requests,responseProof:current.responseProof,originOperationId:current.originOperationId,familyKey:current.familyKey,methodClaimId:current.methodClaimId,localRecovery:current.localRecovery},
  source:s&&{id:s.id,associated:task.sourceIds.includes(s.id),readAllowed:check.allowed,format:JSON.parse(s.content).platformResult?.format,restoredHash:hash(require('../desktop/platform-result.cjs').fullSnapshot(s).data)},
  steps:a.data.agentRuns.filter(r=>r.id!==initial.runId).flatMap(r=>r.steps.map(s=>({runId:r.id,id:s.id,tool:s.tool,args:s.args,result:s.result,errorCode:s.errorCode,dispatch:s.dispatch}))),
  localCompletion:audit.localCompletion||null};
}
async function seed(a){
 await a.dispatch('saveProvider',{name:'controlled fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:2});
 const job=agent.buildJob(a,{goal:'入口 IDs: 123\n\n范围：\n核对物理表血缘；更新原飞书，等待用户验收。',dataPlatform:'sg-readonly',autoAccept:false,maxActions:3});a.data.delegations.push(job);
 const plan={key:'handover',title:'入口123交接',criteria:'全部可访问物理表血缘；修订原稿更新同一飞书并回读。',steps:[{key:'draft',kind:'draft',title:'原主稿'},{key:'publish',kind:'external',tool:'lark_create',title:'飞书交付'}]};
 const {taskId}=await agent.act(a,job,'plan_task',plan),task=a.task(taskId),old={id:'generic-original',taskId,stepId:task.steps[0].id,title:task.title,content:oldBody,createdAt:new Date().toISOString()};
 a.data.artifacts.push(old);Object.assign(task.steps[0],{done:true,artifactId:old.id});require('../desktop/protocol-access.cjs').retain(a,'artifact',old,{task,job});a.save();
 const req=access.request(a,job,{kind:'lark_create',target:'my_library',reason:'controlled prior document'}),d=a.data.decisions.find(d=>d.id===req.decisionId);
 await a.dispatch('accessRetry',{id:d.id,revision:require('../desktop/decisions.cjs').revision(a.data,d)});await a.runPromise;
 await a.dispatch('agentLarkCreatePolicy',{id:job.id,taskId,mode:'auto',allowUpdate:true,target:job.larkCreateGrant.target,openId:job.larkCreateGrant.openId});await agent.act(a,job,'lark_create',{taskId});
 await agent.act(a,job,'plan_task',{...plan,primaryArtifactId:old.id,steps:[plan.steps[0],{...plan.steps[1],tool:'lark_update'}],resetSteps:['publish'],reason:'历史同目标交付接续'});
 job.executionState={version:2,permissionRevision:0,operations:{},requirements:[],gaps:[],reads:{},recoveries:{},events:[],...job.executionState};
 await require('../desktop/operation-ledger.cjs').prepareBatch(a,job);
 const sources=[['outputs',{taskId:123,outputs:[{databaseName:'db',tableName:'out',storageRegion:'sg'}]},{op:'outputs',taskId:123}],['table_lineage',coral.data('out',['leaf']),{op:'table_lineage',database:'db',table:'out'}]].map(([operation,data,query])=>agent.source(a,job,'controlled-'+operation,operation,JSON.stringify({operation,query,region:'sg',data}),{platformSnapshot:true,platformPrincipal:job.platformPrincipal}));
 require('../desktop/evidence-links.cjs').setInputs(a,task,sources.map(s=>s.id));task.generationMode='single';
 continuation.redirect(a,job,{args:{taskId}},{code:'PLAN_ALREADY_RECONCILED',message:'controlled historical failure',taskId});
 const e=continuation.episode(a,job,task);e.fromValidationGrantId='controlled-old-handoff';e.cycles=1;e.hops=1;
 job.status='ready';job.nextRunAt=null;a.activeAgentJob=job;const budget=require('../desktop/spend.cjs').scope(a);budget.limitUSD=200;budget.spentUSD=17;require('../desktop/spend.cjs').persist(a);a.activeAgentJob=null;a.save();
 return {job,task,old,originalCycles:e.cycles,originalBasis:e.basis};
}
async function setup({Assistant=require('../desktop/core.cjs').Assistant,options={},reportFile,restoreAudit=false,scenario='success'}={}){
 const restored=restoreAudit&&fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile)):null;
 const audit=restored?.audit||{layer:'controlled future, NOT production',queries:[],patches:[],checks:[],writes:0,creates:0,readbacks:0,identity:0,violations:[]};
 const remote=restored?.remote||{content:oldBody,revision:1};let f,seeding=!restored;
 const saveAudit=()=>fs.writeFileSync(reportFile,JSON.stringify({audit,remote,ids:f&&{jobId:f.job.id,taskId:f.task.id,oldId:f.old.id},originalCycles:f?.originalCycles,originalBasis:f?.originalBasis},null,2));
 const checked=async fn=>{try{return await fn();}catch(e){if(!e.fixtureExpected)audit.violations.push(e.message);saveAudit();throw e;}};
 const a=new Assistant({...options,chat:deny,webRequest:deny,connectorRequest:(args,opts={})=>checked(async()=>{
  if(args[1]==='status')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'fixture-user',scope:access.scopes('my_library').join(' ')}}};
  if(args[1]==='+create'){assert.equal(seeding,true);audit.creates++;return {ok:true,data:{document:{document_id:'GenericConsumptionFixture123',url}}};}
  if(args[1]==='+fetch'){assert.ok(args.includes(url)||args.includes('GenericConsumptionFixture123'));audit.readbacks++;return {ok:true,data:{document:{content:remote.content,revision_id:remote.revision}}};}
  if(args[1]==='+update'){
   assert.equal(seeding,false);assert.equal(audit.patches.length,2,'both acquisition batches incorporated before delivery');assert.equal(relations.coverageReady(a,f.job,f.task),true);assert.equal(f.task.contentVerification?.passed,true);assert.equal(outputs.primary(a,f.task).draftOnly,false);
   assert.ok(args.includes(url)||args.includes('GenericConsumptionFixture123'),'update must address the same original document');
   assert.ok(opts.input.includes('leaf→tail')&&opts.input.includes('tail→无上游'));assert.equal(audit.writes++,0,'same target updated only once');
   remote.content=scenario==='mismatch'?'external body mismatch':opts.input;remote.revision++;
   if(scenario==='uncertain')throw Object.assign(Error('controlled response lost after apply'),{fixtureExpected:true});return {ok:true,data:{result:'success',document:{document_id:'GenericConsumptionFixture123',revision_id:remote.revision}}};
  }
  throw Error('unexpected connector request '+args[1]);
 })});
 require('../tests/helpers/platform-fixture.cjs').install(a,{username:'controlled-generic'});
 a.platformRequest=async args=>checked(async()=>{const table=args[args.indexOf('--table-name')+1];assert.ok(['leaf','tail'].includes(table));assert.ok(!audit.queries.includes(table),'must not repeat a saved query');audit.queries.push(table);saveAudit();return platformData(table,scenario);});
 const platformRequest=a.platformRequest,identity=JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}));
 Object.defineProperty(a,'platformRequest',{configurable:true,value:async(...args)=>{if(JSON.stringify(args[0])===identity){audit.identity++;saveAudit();}return platformRequest(...args);}});
 if(restored)f={a,job:a.data.delegations.find(j=>j.id===restored.ids.jobId),task:a.task(restored.ids.taskId),old:a.data.artifacts.find(r=>r.id===restored.ids.oldId),originalCycles:restored.originalCycles,originalBasis:restored.originalBasis};else f={a,...await seed(a)};
 seeding=false;Object.assign(f,{audit,remote,saveAudit});
 if(recoveryScenarios.includes(scenario)&&!restored)await seedRecovery(f,scenario);
 if(scenario==='local_recovery'){
  const save=a.save.bind(a);a.save=()=>{const result=save(),op=Object.values(f.job.executionState.operations).find(o=>o.id===audit.recovery.operationId);
   if(!audit.localCompletion&&op?.localRecovery&&op.status==='done'){audit.localCompletion={counts:transportCounts(f),operationId:op.id,attemptId:op.attemptId,logicalKey:op.logicalKey,sourceId:op.sourceId,responseHash:op.responseProof?.dataHash};saveAudit();}return result;};
 }
 a.chat=async(_p,_k,m,o)=>checked(async()=>{
  o.onUsage?.({inputTokens:15,outputTokens:10});const input=JSON.parse(m[1].content),current=outputs.primary(a,f.task);
  if(m[0].content.includes('动作格式')&&scenario==='mismatch')return {tool:'complete',args:{}};
  if(o.role==='verify'){
   assert.equal(relations.coverageReady(a,f.job,f.task),true,'partial evidence must not start final check');assert.ok(current.content.includes('leaf→tail')&&current.content.includes('tail→无上游'));
   const phase=m[0].content.includes('整体委托')?'goal':input.verificationPhase==='content'?'content':'result';audit.checks.push(phase);saveAudit();
   if(phase!=='content'&&scenario==='mismatch')return {passed:false,summary:'实际飞书回读正文与当前主稿不一致',gaps:['远端正文不一致，当前主稿无需重写，须核对原交付'],gapDetails:[{requirementId:'task:'+f.task.id,kind:'delivery',text:'远端正文不一致，当前主稿无需重写，须核对原交付',artifactId:current.id,stepId:f.task.steps[1].id}]};
   if(phase!=='content')assert.equal(remote.content,current.content);
   return {passed:true,summary:'逐中心核对且同一交付已回读',gaps:[],relationCoverage:relations.required(a,f.job,f.task).map(ob=>({obligationId:ob.id,status:'analyzed',coverage:'complete',rootIds:ob.rootIds,sourceIds:f.task.sourceIds,summary:'out→leaf→tail；逐中心完整，tail无上游，各中心输出已核对'}))};
  }
  assert.ok(input.evidenceConsumption,'generation must be original-draft evidence consumption, not a planner loop');
  const p=f.task.evidenceConsumption.attempts[f.task.evidenceConsumption.activeAttemptId],marker=audit.queries.includes('tail')?'tail→无上游，最终中心已核对。':'leaf→tail，尚缺 tail 自身中心。',section=require('../desktop/evidence-consumption.cjs').sections(current.content).find(s=>s.title==='血缘核对');
  audit.patches.push({attemptId:p.attemptId,primary:current.id,marker,facts:p.targetFacts.map(v=>v.factKey)});saveAudit();
  return {kind:'patch',edits:[{before:current.content.slice(section.start,section.end),after:current.content.slice(section.start,section.end)+'\n'+marker+'\n'}],summary:'纳入本批真实中心',evidenceIntegration:p.targetFacts.map(v=>({factKey:v.factKey,obligationId:v.obligationId,sectionId:section.id,quote:marker}))};
 });
 const dispatch=a.dispatch.bind(a);a.dispatch=async(action,input)=>{
  if(action==='controlledRun'){await agent.run(a,f.job.id);saveAudit();return observe(f);}
  if(action==='controlledObserve')return observe(f);
  return dispatch(action,input);
 };
 saveAudit();return f;
}
function observe(f){const {a,job,task,audit}=f;return {jobStatus:job.status,taskStatus:task.status,error:job.lastError,summary:job.summary,primary:outputs.primary(a,task),audit,consumption:task.evidenceConsumption,contentCheck:task.contentVerification,resultCheck:task.verification,oldCycles:job.executionState.continuation.episodes[f.originalBasis]?.cycles,originalCycles:f.originalCycles,budget:a.spendLedger.scopes['job:'+job.id],runs:a.data.agentRuns.map(r=>({status:r.status,steps:r.steps.map(s=>({tool:s.tool,error:s.error,errorCode:s.errorCode}))})),deliveries:a.data.agentActions.filter(r=>r.tool==='lark_update').map(r=>({id:r.id,status:r.status,result:r.result})),recovery:recoveryView(f),accepted:!!task.acceptedAt,threadId:require('node:worker_threads').threadId};}
module.exports={setup,observe,url,recoveryScenarios};
