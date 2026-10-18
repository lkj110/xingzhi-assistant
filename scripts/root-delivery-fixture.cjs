'use strict';
// Transport-only fixture shared by the in-process integration test and the real
// desktop Worker. Only seedBaseline writes historical state; after it returns,
// every plan, read, revision, check, write and acceptance state belongs to App.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const agent=require('../desktop/agent.cjs');
const access=require('../desktop/access.cjs');
const decisions=require('../desktop/decisions.cjs');
const outputs=require('../desktop/deliverables.cjs');
const control=require('../desktop/execution-control.cjs');
const spend=require('../desktop/spend.cjs');
const hash=require('../desktop/evidence-basis.cjs').hash;
const pending=require('../desktop/pending-check.cjs');
const url='https://root-fixture.feishu.cn/docx/RootDeliveryFixture123';
const oldBody='# 交接说明\n\n## 已有事实\n\n负责人：测试人；周五发布。\n\n## 证据核对\n\n尚未核对19项来源。\n\n## 交付目标\n\n继续更新同一文档。';
const facts=Array.from({length:19},(_,i)=>({id:700001+i,marker:`ROOT_FACT_${String(i+1).padStart(2,'0')}_VERIFIED`,value:`第${i+1}项实际负责人为负责人${i+1}`}));
const revisedBody=oldBody.replace('尚未核对19项来源。',facts.map(f=>`${f.marker}：${f.value}。`).join('\n\n'));
const batches=[facts.slice(0,4),facts.slice(4,7),facts.slice(7,10),facts.slice(10,13),facts.slice(13,16),facts.slice(16,19)];
const denied=async()=>{throw Error('External network/model forbidden in root delivery fixture');};

// Independent consumer of the serialized model input, not App's dedup helper.
function atPath(input,p){return p.replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],input);}
function body(input,row,key='content'){
  if(typeof row?.[key]==='string')return row[key];
  const ref=row?.[key+'Ref'];if(!ref)return '';
  const text=atPath(input,ref.path);
  assert.equal(typeof text,'string',`dangling ${key}Ref: ${ref.path}`);
  assert.ok(Number.isInteger(ref.start)&&Number.isInteger(ref.end)&&ref.start>=0&&ref.end>=ref.start&&ref.end<=text.length,'invalid body reference range');
  return text.slice(ref.start,ref.end);
}
function assertReferences(input){
  const visit=value=>{if(!value||typeof value!=='object')return;for(const key of ['content','text','originalContent'])if(value[key+'Ref'])body(input,value,key);for(const v of Object.values(value))if(v&&typeof v==='object')visit(v);};
  visit(input);
}
function readText(input,row){return [body(input,row),...(Array.isArray(row?.segments)?row.segments:[]).map(s=>body(input,s,'text'))].filter(Boolean).join('\n');}
function suppliedDraft(input,id){
  const r=input.revision;if(r?.artifactId===id)return body(input,r,'originalContent');
  if(input.workingDraft?.id===id)return body(input,input.workingDraft);
  for(const item of input.artifacts||[])if(item.id===id)return body(input,item);
  for(const row of input.contextReads||[])if(row.result?.artifactId===id)return readText(input,row.result);
  return '';
}
function compactFailure(f){
  const check=v=>v&&({passed:v.passed,summary:v.summary,basis:v.basis,gaps:v.gaps});
  return JSON.stringify({status:f.job.status,error:f.job.lastError,summary:f.job.summary,violations:f.audit.violations,events:f.audit.events.map(({sourceIds,...event})=>({...event,...(sourceIds?{sources:sourceIds.length}:{})})),steps:f.a.data.agentRuns.flatMap(r=>r.steps||[]).map(s=>({tool:s.tool,error:s.error,errorCode:s.errorCode,result:s.result?.status,verification:s.result?.verification?.passed})),task:{status:f.task.status,contentVerification:check(f.task.contentVerification),verification:check(f.task.verification),steps:f.task.steps.map(s=>({key:s.key,done:s.done,artifactId:s.artifactId,targetArtifactId:s.targetArtifactId}))}},null,2);
}

async function seedBaseline(a){
  await a.dispatch('saveProvider',{name:'root transport fixture',model:'root-fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:2,cachedInputPrice:1});
  const job=agent.buildJob(a,{goal:'核对指定19项来源中的实际负责人，修订现有交接主稿并更新原飞书文档，回读后等待用户验收。',dataPlatform:'sg-readonly',allowWeb:false,fileMode:'off',autoAccept:false,maxActions:12});
  a.data.delegations.push(job);
  const initial=agent.source(a,job,'root-original','原始事实','负责人：测试人；周五发布。');
  const unrelated=agent.source(a,job,'root-unrelated','另一事项的资料','UNRELATED_MUST_NOT_BE_BOUND');
  const plan={key:'handover',title:'交接说明',criteria:'核对指定19项来源中的实际负责人，修订原主稿，更新同一飞书并回读，等待用户验收。',sourceIds:[initial.id],steps:[{key:'draft',title:'修订主稿',kind:'draft'},{key:'publish',title:'更新原飞书',kind:'external',tool:'lark_create'}]};
  const {taskId}=await agent.act(a,job,'plan_task',plan),task=a.task(taskId);
  // Historical draft is the sole done/artifact seed, as in lark-publish.test.cjs.
  const old={id:'root-old-main',taskId,stepId:task.steps[0].id,title:task.title,content:oldBody,createdAt:new Date().toISOString()};
  a.data.artifacts.push(old);Object.assign(task.steps[0],{done:true,artifactId:old.id});
  require('../desktop/protocol-access.cjs').retain(a,'artifact',old,{task,job});a.save();
  const request=access.request(a,job,{kind:'lark_create',target:'my_library',reason:'fixture historical document authorization'});
  const decision=a.data.decisions.find(d=>d.id===request.decisionId);
  await a.dispatch('accessRetry',{id:decision.id,revision:decisions.revision(a.data,decision)});await a.runPromise;
  await a.dispatch('agentLarkCreatePolicy',{id:job.id,taskId,mode:'auto',allowUpdate:true,target:job.larkCreateGrant.target,openId:job.larkCreateGrant.openId});
  const receipt=await agent.act(a,job,'lark_create',{taskId});
  assert.equal(receipt.url,url);assert.equal(receipt.verified,true);
  await agent.act(a,job,'plan_task',{...plan,primaryArtifactId:old.id,steps:[plan.steps[0],{...plan.steps[1],tool:'lark_update'}],resetSteps:['publish'],reason:'在已存在的同一飞书上核对并修订旧稿'});
  task.generationMode='single';
  // Synthetic prior billed usage + an unknown reservation; neither may reset.
  a.activeAgentJob=job;const ledger=spend.scope(a);ledger.limitUSD=200;
  const historical=spend.reserve(a,a.data.providers[0],[],{}),usage=spend.usage({inputTokens:1000000,outputTokens:0});
  spend.settle(a,historical,usage,spend.cost(usage,historical.pricing));
  const unknown=spend.reserve(a,a.data.providers[0],[],{});spend.settle(a,unknown,null,null);
  a.activeAgentJob=null;
  a.data.runtime.onboarding={seenAt:new Date().toISOString(),version:2};a.save();
  return {a,job,task,old,initial,unrelated,baseline:{ledger:structuredClone(ledger),receipt:structuredClone(a.data.agentActions.find(r=>r.tool==='lark_create')),sourceCount:a.data.sources.length}};
}

// Synthetic historical import only. This deliberately represents the old SG
// failure shape, not a new failure emitted by the repaired production code.
// Negative variants are also seeded here, never injected into live controllers.
async function seedContextRepair(f,variant){
  const {a,job,task,old}=f,work=require('../desktop/work-efficiency.cjs');
  const historicalBase=Date.now()-120000,at=n=>new Date(historicalBase+n*1000).toISOString();
  work.before(a,job);
  Object.assign(job.executionState.workEfficiency,{attempts:18,phase:'recovery_pending',lastFailure:{code:'NO_NEW_EVIDENCE',message:'historical diagnostic'},tried:{historical:{at:at(0)}},history:[]});
  const basis=require('../desktop/continuation-control.cjs').basis(a,job,task);
  const e={taskId:task.id,basis,intentBasis:hash({contract:job.executionContract?.text||job.goal,requirements:task.userRequirement?Object.fromEntries(['description','objective','criteria'].map(k=>[k,task.userRequirement[k]])):null}),cycles:1,hops:2,executions:4,revisionPending:true};
  job.executionState.continuation={version:1,activeTaskId:task.id,activeBasis:basis,episodes:{[basis]:e}};
  const generation={id:'synthetic-generation',jobId:job.id,status:'done',startedAt:at(0),finishedAt:at(3),modelCalls:0,modelCallsDetail:[],steps:[{tool:'advance_task',args:{taskId:task.id},at:at(1),continuation:{tracked:true,handled:true,basis}}]};
  a.data.agentRuns.unshift(generation);a.activeAgentRun=generation;a.activeAgentJob=job;
  old.createdAt=at(2);old.generationSnapshot=require('../desktop/revision-protocol.cjs').snapshot(a,task);
  require('../desktop/deliverables.cjs').record(a,task,task.steps[0],old);
  require('../desktop/step-evidence.cjs').record(a,task,task.steps[0]);
  pending.recordGenerated(a,job,task,task.steps[0],old);
  const p=e.pendingCheck,run={id:'synthetic-context-failure',jobId:job.id,status:'needs_input',startedAt:at(4),finishedAt:at(30),modelCalls:20,steps:[],modelCallsDetail:[]};
  Object.assign(p,{status:'claimed',claimId:hash({generationAttemptId:p.generationAttemptId,phase:'content'}),claimedByRunId:run.id,claimedAt:at(5),interruption:{code:'EXECUTION_GATE_CLOSED',at:at(-30),requestProof:[{id:'older-paused-request',status:'done'}]}});
  const d={id:'synthetic-false-permission',jobId:job.id,taskIds:[task.id],sourceIds:[],status:'open',kind:'permission',key:'access:external:verify_content',question:'需要授权：检查外部访问权限',createdAt:at(29),access:{kind:'external',target:'verify_content',stage:'requested'}};
  run.steps=[{tool:'verify_content',args:{taskId:task.id},at:at(5),errorCode:'CONTEXT_INVALID_REQUEST',error:'内部请求纠正耗尽，需修正参数、关联或权限',continuation:{tracked:true,handled:true,basis},result:{needsAuthorization:true,kind:'external',target:'verify_content',decisionId:d.id}}];
  for(let i=0;i<20;i++)run.modelCallsDetail.push({id:'synthetic-known-'+i,runId:run.id,taskId:task.id,at:at(6+i),status:'done',requestId:'synthetic-request-'+i,usageReported:true,stage:'task_verify',role:'verify',spendScope:'job:'+job.id,inputTokens:50000,outputTokens:0,estimatedUSD:0.05,providerId:a.data.providers[0].id,model:'root-fixture'});
  if(variant==='unknown')run.modelCallsDetail[19].usageReported=false;
  if(variant==='unknown_before_check')Object.assign(run.modelCallsDetail[0],{at:at(4.5),usageReported:false});
  (a.data.modelCalls ||= []).push(...structuredClone(run.modelCallsDetail));a.data.agentRuns.unshift(run);a.data.decisions.push(d);
  if(variant==='usage_conflict')a.data.modelCalls.find(c=>c.id===run.modelCallsDetail[0].id).estimatedUSD=0.06;
  job.status='needs_input';job.lastError='';job.summary=d.question;task.contentVerification=null;
  const row=require('../desktop/generation-context.cjs').read(a,task,{tool:'read_source',sourceId:f.initial.id});
  task.generationReads=[{request:{tool:'read_source',sourceId:f.initial.id},result:row}];
  const identity=require('../desktop/generation-context.cjs').finalizationState(a,task,{phase:'content'});
  if(variant==='consumed')task.contextFinalizations={[identity.legacyKey]:{status:'started',checkPhase:'content',semanticCheckId:identity.semanticCheckId,legacyKey:identity.legacyKey,startedAt:at(28)}};
  if(variant==='later_owner')Object.assign(job.executionState.continuation,{activeTaskId:'synthetic-later-owner',activeBasis:'synthetic-later-basis'});
  if(variant==='paused')await a.dispatch('stewardshipPause',{});
  a.activeAgentRun=null;a.activeAgentJob=null;
  f.baseline.contextRepair={variant:variant||'positive',run:structuredClone(run),decision:structuredClone(d),episode:structuredClone(e),continuation:structuredClone(job.executionState.continuation),efficiency:structuredClone(job.executionState.workEfficiency),reads:structuredClone(job.executionState.reads),generationReads:structuredClone(task.generationReads),finalization:identity,policies:structuredClone(JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8'))),goal:job.goal,contract:structuredClone(job.executionContract),contextFinalizations:structuredClone(task.contextFinalizations)};
  a.save();
}

function contextRepairState(f){
  const {a,job,task}=f,b=f.baseline.contextRepair;
  return JSON.parse(JSON.stringify({view:pending.view(a,job),jobId:job.id,taskId:task.id,jobStatus:job.status,lastError:job.lastError,taskStatus:task.status,paused:a.data.stewardship.paused,primary:task.primaryArtifactId,continuation:job.executionState.continuation,efficiency:job.executionState.workEfficiency,reads:job.executionState.reads,generationReads:task.generationReads,contextFinalizations:task.contextFinalizations,ledger:a.spendLedger.scopes['job:'+job.id],policies:JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8')),goal:job.goal,contract:job.executionContract,decision:a.data.decisions.find(d=>d.id===b.decision.id),failedRun:a.data.agentRuns.find(r=>r.id===b.run.id),modelCalls:a.data.modelCalls,artifacts:a.data.artifacts}));
}

function assertContextRepairRestored(before,after){
  // The workspace save revision advances on close/start. The candidate proof,
  // all work revisions and every historical/business fact must stay identical.
  const stable=x=>{const c=structuredClone(x);if(c.view)delete c.view.expectedRevision;return c;};
  if(before.view){assert.ok(after.view);assert.ok(after.view.expectedRevision>=before.view.expectedRevision);}
  assert.deepEqual(stable(after),stable(before));
}

function assertContextRepairFirst(f,system,input){
  const {a,job,task,old,audit}=f,b=f.baseline.contextRepair,e=job.executionState.continuation.episodes[b.episode.basis],p=e.pendingCheck;
  assert.equal(audit.modelInputs.length,1,'the first resumed call must be the bounded original content check');
  assert.match(system,/本轮改为形成检查结论/);assert.equal(input.verificationPhase,'content');assert.equal(suppliedDraft(input,old.id),oldBody);
  // Engine runtime.launch runs through an execution-scoped Assistant. Observe
  // its durable run by the claimed identity, not root-instance transient fields.
  const run=a.data.agentRuns.find(r=>r.id===p.claimedByRunId);assert.ok(run);assert.notEqual(run.id,b.run.id);
  assert.equal(run.steps.length,1);assert.equal(run.steps[0].tool,'verify_content');
  for(const key of ['claimId','generationAttemptId','artifactId','artifactHash','checkBasis','inputBasis','ownerEpisodeId'])assert.equal(p[key],b.episode.pendingCheck[key],key);
  assert.deepEqual(p.interruption,b.episode.pendingCheck.interruption);
  assert.equal(p.claimHistory.at(-1).runId,b.run.id);assert.equal(p.claimedByRunId,run.id);
  assert.equal(e.checkRepairs[p.generationAttemptId].status,'claimed');
  const proof=e.checkRepairs[p.generationAttemptId].proof.requestProof;
  assert.deepEqual(proof.map(r=>r.id),b.run.modelCallsDetail.map(r=>r.id),'whole failure run must be proven');assert.ok(proof.every(r=>typeof r.usageHash==='string'&&r.usageHash.length===64));
  const d=a.data.decisions.find(d=>d.id===b.decision.id);assert.equal(d.status,'superseded');assert.equal(d.answer,undefined);
  const finalized=Object.values(task.contextFinalizations||{}).filter(r=>r.semanticCheckId===b.finalization.semanticCheckId);
  assert.equal(finalized.length,1);assert.equal(finalized[0].status,'started','must reserve durably before transport');
  const persisted=JSON.parse(fs.readFileSync(a.file,'utf8')).tasks.find(t=>t.id===task.id);
  assert.equal(Object.values(persisted.contextFinalizations).find(r=>r.semanticCheckId===b.finalization.semanticCheckId)?.status,'started','reservation must be on disk before transport');
  assert.equal(audit.platformCalls.length,0);assert.equal(audit.readBatches.length,0);
  assert.equal(audit.connectorCalls.filter(c=>!c.baseline).length,0);
  for(const key of ['cycles','hops','executions'])assert.ok(e[key]>=b.episode[key],key+' reset');
  assert.equal(job.executionState.workEfficiency.attempts,b.efficiency.attempts);
  assert.deepEqual(job.executionState.workEfficiency.tried,b.efficiency.tried);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.dir,'access-policy.json'),'utf8')),b.policies);assert.equal(job.goal,b.goal);
}

async function setup({Assistant=require('../desktop/core.cjs').Assistant,options={},scenario='success',repairVariant,reportFile,restoreAudit=false}={}){
  const restored=restoreAudit?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
  const audit={layer:'controlled',productionDelivery:'not_verified',scenario,events:[],violations:[],modelInputs:[],readBatches:[],verificationReads:[],checks:[],platformCalls:[],connectorCalls:[],workerThreadId:require('node:worker_threads').threadId};
  if(restored)Object.assign(audit,restored,{workerThreadId:require('node:worker_threads').threadId});
  const remote=restored?structuredClone(restored.remote):{body:oldBody,revision:1};let f,seeding=!restored,pendingBatch=restored?.transportState?.pendingBatch||null,readIndex=restored?.transportState?.readIndex||0,generated=restored?.transportState?.generated||false;
  const readOrder=scenario==='read_reorder'?[...batches].reverse().map(batch=>[...batch].reverse()):batches;
  const saveAudit=()=>{if(reportFile)fs.writeFileSync(reportFile,JSON.stringify({...audit,remote,transportState:{pendingBatch,readIndex,generated},baseline:f?.baseline,ids:f?{jobId:f.job.id,taskId:f.task.id,oldId:f.old.id,unrelatedId:f.unrelated.id}:null},null,2));};
  const event=(kind,detail={})=>{audit.events.push({kind,...detail});saveAudit();};
  const checked=async(fn)=>{try{return await fn();}catch(e){if(!e.expectedFixtureFailure)audit.violations.push(e.message);saveAudit();throw e;}};
  const connectorRequest=async(args,opts={})=>checked(async()=>{
    audit.connectorCalls.push({args,input:opts.input,baseline:seeding});saveAudit();
    if(args[1]==='status')return {verified:true,identities:{user:{available:true,status:'ready',verified:true,openId:'ou_root_fixture',userName:'测试人',scope:access.scopes('my_library').join(' ')}}};
    if(args[1]==='+create'){
      assert.equal(seeding,true,'recovery must never create a second document');assert.equal(opts.input,oldBody);
      event('baseline_create');return {ok:true,data:{document:{document_id:'RootDeliveryFixture123',url}}};
    }
    if(args[1]==='+fetch'){
      assert.ok(args.includes(url)||args.includes('RootDeliveryFixture123'),'fetch must use the original target');
      event('lark_readback',{revision:remote.revision,baseline:seeding});
      return {ok:true,data:{document:{content:remote.body,revision_id:remote.revision}}};
    }
    if(args[1]==='+update'){
      assert.equal(seeding,false);assert.equal(opts.input,revisedBody,'only the complete revised primary may be sent');
      assert.ok(args.includes(url)||args.includes('RootDeliveryFixture123'),'update must use the original target');
      assert.equal(f.task.contentVerification?.passed,true,'unverified publication');
      assert.equal(f.task.contentVerification.basis,control.contentBasis(f.a,f.job,f.task),'stale verification at transport dispatch');
      assert.equal(audit.readBatches.length,6);assert.equal(generated,true);
      assert.equal(audit.connectorCalls.filter(c=>c.args[1]==='+update').length,1,'duplicate external write');
      remote.body=scenario==='readback_mismatch'?'REMOTE_PARTIAL_BODY':opts.input;remote.revision=2;event('lark_update',{artifactId:outputs.primary(f.a,f.task).id,basis:f.task.contentVerification.basis});
      if(scenario==='uncertain')throw Object.assign(Error('fixture transport lost response after applying update'),{expectedFixtureFailure:true});
      return {ok:true,data:{result:'success',document:{document_id:'RootDeliveryFixture123',revision_id:2}}};
    }
    throw Error('Unexpected Lark transport: '+JSON.stringify(args));
  });
  let a=new Assistant({...options,chat:denied,agentRequest:denied,connectorRequest,officeRequest:denied,webRequest:denied,feedRequest:denied});
  require('../tests/helpers/platform-fixture.cjs').install(a,{username:'root-fixture'});
  a.platformRequest=async args=>checked(async()=>{
    assert.ok(!seeding);const fact=facts.find(x=>JSON.stringify(require('../desktop/data-platform.cjs').command({op:'task',taskId:x.id}))===JSON.stringify(args));
    assert.ok(fact,'unexpected or unrelated platform query: '+JSON.stringify(args));
    assert.ok(!audit.platformCalls.includes(fact.id),'duplicate platform query');
    audit.platformCalls.push(fact.id);event('platform_fact',{id:fact.id});
    // Padding makes markers absent from short catalog summaries, forcing reads.
    return {taskId:fact.id,description:'fixture context padding '.repeat(85),owner:fact.value,fact:fact.marker};
  });
  if(restored){const ids=restored.ids;f={a,job:a.data.delegations.find(j=>j.id===ids.jobId),task:a.task(ids.taskId),old:a.data.artifacts.find(r=>r.id===ids.oldId),unrelated:{id:ids.unrelatedId},baseline:restored.baseline};f.initial=a.data.sources.find(s=>f.task.sourceIds.includes(s.id)&&!s.platformSnapshot);assert.ok(f.job&&f.task&&f.old&&f.initial,'cold fixture must load the same persisted workspace');}
  else {f=await seedBaseline(a);if(scenario==='context_authorization_repair')await seedContextRepair(f,repairVariant);}
  Object.assign(f,{audit,remote,saveAudit});seeding=false;event(restored?'cold_worker_loaded':'baseline_ready');
  a.chat=async(_provider,_key,messages,opts)=>checked(async()=>{
    const system=messages[0].content,input=JSON.parse(messages[1].content);
    if(scenario==='input_upgrade'&&generated&&opts.role==='verify'&&input.verificationPhase==='content'&&!audit.upgradeFailure){
      audit.upgradeFailure=true;event('legacy_input_failure');
      opts.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});
      throw Object.assign(require('../desktop/model-errors.cjs').modelError('MODEL_CONFIG','本轮输入超过订阅 CLI 的 1048576 字符上限，请分批读取材料后继续；已有进度已保留。',false),{expectedFixtureFailure:true,diagnostic:{source:'codex_cli',kind:'input_too_large',maxChars:1048576,actualChars:1095208}});
    }
    opts.onUsage?.({inputTokens:100,outputTokens:30});
    assertReferences(input);audit.modelInputs.push({role:opts.role,stage:opts.stage,context:input});saveAudit();
    const task=f.task,job=f.job,primary=outputs.primary(a,task);
    if(scenario==='context_authorization_repair'&&audit.modelInputs.length===1){assertContextRepairFirst(f,system,input);event('context_repair_first_bounded',{artifactId:primary.id,semanticCheckId:f.baseline.contextRepair.finalization.semanticCheckId});}
    if(system.includes('动作格式')){
      assert.ok(audit.checks.some(c=>!c.passed),'independent failed content check must precede acquisition');
      const acquired=a.data.sources.filter(s=>s.platformSnapshot&&job.sourceIds.includes(s.id));
      if(acquired.length<19){
        const ids=new Set(acquired.map(s=>JSON.parse(s.content).query?.taskId).map(Number));
        // Transport audit identifies completed queries; storage count is checked independently.
        const pending=facts.filter(x=>!audit.platformCalls.includes(x.id)).slice(0,10);
        assert.ok(pending.length,`platform results were not stored: ${acquired.length}, query ids ${[...ids]}`);
        return {tool:'platform_query',args:{queries:pending.map(x=>({op:'task',taskId:x.id}))}};
      }
      const missing=acquired.filter(s=>!task.sourceIds.includes(s.id));
      if(missing.length){
        assert.equal(acquired.length,19);assert.equal(primary.id,f.old.id);assert.equal(task.steps[0].done,true);
        for(const source of acquired)assert.ok(input.sources?.some(s=>s.id===source.id)||input.sourceCatalog?.some(s=>s.id===source.id),'planner cannot associate a source absent from its actual input');
        event('associate_requested',{sourceIds:acquired.map(s=>s.id)});
        return {tool:'plan_task',args:{key:task.agentKey,existingTaskId:task.id,title:task.title,criteria:task.criteria,sourceIds:[f.initial.id,...acquired.map(s=>s.id)],reason:'仅关联本缺口19项真实查询结果并重开受影响正文和交付',...(task.evidenceRequest?{evidenceResolution:{basis:task.evidenceRequest.basis,sourceIds:acquired.map(s=>s.id),reason:'已取得本缺口事实'}}:{})}};
      }
      if(!task.steps[0].done)return {tool:'advance_task',args:{taskId:task.id}};
      if(!task.contentVerification||task.contentVerification.basis!==control.contentBasis(a,job,task))return {tool:'verify_content',args:{taskId:task.id}};
      assert.equal(task.contentVerification.passed,true,'failed current content check must not be published');
      if(!task.steps[1].done)return {tool:'lark_update',args:{taskId:task.id}};
      return {tool:'complete',args:{}};
    }
    if(opts.role==='verify'){
      const goal=system.includes('整体委托'),kind=goal?'goal':input.verificationPhase==='content'?'content':'result';
      const draft=suppliedDraft(input,primary.id)||(goal?JSON.stringify(input.tasks?.flatMap(t=>t.artifacts||[])):''),missing=facts.filter(x=>!draft.includes(x.marker)||!draft.includes(x.value));
      if(missing.length){
        assert.equal(primary.id,f.old.id,'checker did not receive revised current primary');
        const gap='当前主稿缺少指定19项实际负责人的事实依据';audit.checks.push({kind,passed:false,artifactId:primary.id});event('check_missing');
        return {passed:false,summary:gap,gaps:[gap],gapDetails:[{requirementId:'task:'+task.id,kind:'evidence',text:gap,artifactId:primary.id,stepId:task.steps[0].id,sourceIds:[f.initial.id]}]};
      }
      assert.equal(generated,true);assert.equal(audit.readBatches.length,6);
      if(scenario==='pause_during_check'&&kind==='content'&&!audit.pauseInjected){
        audit.pauseInjected=true;
        const state=f.job.executionState.workEfficiency;
        // Preserve an exhausted legacy diagnostic underneath the active episode,
        // reproducing the SG composition rather than resetting its counters.
        Object.assign(state,{attempts:18,phase:'recovery_pending',lastFailure:{code:'NO_NEW_EVIDENCE',message:'legacy no progress'}});
        audit.legacyCounters={attempts:state.attempts,cycles:f.job.executionState.continuation?.episodes?.[f.job.executionState.continuation.activeBasis]?.cycles||0};
        await a.dispatch('stewardshipPause',{});event('pause_during_check');
        return {kind:'read_context',requests:[{tool:'read_source',sourceId:input.sourceCatalog.find(s=>s.title===`SG · task · ${facts[0].id}`).id}]};
      }

      if(scenario==='pause_during_result'&&kind==='result'&&!audit.resultPauseInjected){audit.resultPauseInjected=true;await a.dispatch('stewardshipPause',{});event('pause_during_result');return {kind:'read_context',requests:[{tool:'read_source',sourceId:input.sourceCatalog.find(s=>s.title===`SG · task · ${facts[0].id}`).id}]};}

      // The independent verifier must see the source facts too. App may compact
      // stored generation evidence to metadata; a prior writer's reads do not
      // grant the verifier knowledge of omitted bodies. Re-read those windows.
      const evidenceRows=[...(input.sources||[]),...(input.generationEvidence||[]),...(input.requestedSections||[]),...(input.contextReads||[]).map(r=>r.result)];
      const evidenceText=evidenceRows.map(row=>readText(input,row)).join('\n');
      const unread=facts.filter(x=>!evidenceText.includes(x.marker)||!evidenceText.includes(x.value));
      if(unread.length){
        const requests=unread.slice(0,4).map(x=>{
          const source=input.sourceCatalog?.find(s=>s.title===`SG · task · ${x.id}`);
          assert.ok(source,'verifier must have a real readable source handle');
          return {tool:'read_source',sourceId:source.id};
        });
        audit.verificationReads.push({kind,sourceIds:requests.map(r=>r.sourceId)});saveAudit();
        return {kind:'read_context',requests};
      }
      if(scenario==='input_upgrade'&&['content','result'].includes(kind)&&!audit.finalChecksReturned?.[kind]){
        audit.finalChecksReturned ||= {};audit.repeatedVerification ||= {};
        if(system.includes('本轮改为形成检查结论')){audit.finalChecksReturned[kind]=true;event('bounded_check_conclusion',{phase:kind});}
        else {audit.repeatedVerification[kind]=(audit.repeatedVerification[kind]||0)+1;assert.ok(audit.repeatedVerification[kind]<=4,'duplicate verifier must switch methods');return {kind:'read_context',requests:[{tool:'read_source',sourceId:input.sourceCatalog.find(s=>s.title===`SG · task · ${facts[0].id}`).id}]};}
      }
      if(kind!=='content'){
        if(scenario==='readback_mismatch'){
          assert.ok(input.deliveryEvidence?.some(r=>r.tool==='lark_update'&&readText(input,r.readback)==='REMOTE_PARTIAL_BODY'),'checker must see the actual mismatch');
          audit.checks.push({kind,passed:false,artifactId:primary.id});event('readback_mismatch_detected');
          return {passed:false,summary:'原飞书回读与已通过的主稿不一致，需要核对原外部动作',gaps:['远端只含片段；当前主稿完整，不能重复发布'],gapDetails:[{requirementId:'task:'+task.id,kind:'delivery',text:'远端只含片段；当前主稿完整，不能重复发布',artifactId:primary.id,stepId:task.steps[1].id}]};
        }
        assert.equal(remote.body,revisedBody);assert.ok(a.data.agentActions.some(r=>r.tool==='lark_update'&&r.status==='done'&&r.result?.url===url));
        if(kind==='result')assert.ok(input.deliveryEvidence?.some(r=>r.tool==='lark_update'&&readText(input,r.readback)===revisedBody),'result check must consume actual readback body');
      }
      audit.checks.push({kind,passed:true,artifactId:primary.id});event('check_passed',{phase:kind,artifactId:primary.id});
      return {passed:true,summary:'独立核对19项真实事实及当前阶段所需回执均一致',gaps:[]};
    }
    assert.equal(task.steps[0].done,false,'text step not reopened by plan_task');
    assert.equal(task.steps[1].done,false,'delivery successor not reopened');
    assert.equal(task.contentVerification,null,'old failed check must be invalidated atomically');
    assert.equal(primary.id,f.old.id,'must revise original primary');
    assert.equal(task.steps[0].targetArtifactId,f.old.id,'reopened draft must keep explicit revision target');
    assert.equal(task.sourceIds.filter(id=>a.data.sources.find(s=>s.id===id)?.platformSnapshot).length,19);
    assert.ok(!task.sourceIds.includes(f.unrelated.id));
    assert.equal(suppliedDraft(input,f.old.id),oldBody,'generation must receive original draft');
    if(pendingBatch){
      for(const item of pendingBatch){
        const row=input.contextReads?.findLast(r=>r.request?.sourceId===item.sourceId);
        assert.equal(row?.result?.ok,true,`read ${item.marker} missing from next model input`);
        assert.ok(readText(input,row.result).includes(item.marker),`read ${item.marker} body omitted from next model input`);
      }
      audit.readBatches.push(pendingBatch);event('read_batch_consumed',{batch:audit.readBatches.length,sourceIds:pendingBatch.map(x=>x.sourceId)});pendingBatch=null;
    }
    if(readIndex<readOrder.length){
      pendingBatch=readOrder[readIndex++].map(fact=>{
        const source=a.data.sources.find(s=>s.platformSnapshot&&s.content.includes(fact.marker));
        assert.ok(input.sourceCatalog?.some(s=>s.id===source.id||s.sourceId===source.id),'read source must be visible in model directory');
        return {sourceId:source.id,marker:fact.marker};
      });
      if(scenario==='read_mixed'&&audit.readBatches.length)pendingBatch.push(audit.readBatches[0][0]);
      saveAudit();return {kind:'read_context',requests:pendingBatch.map(({sourceId})=>({tool:'read_source',sourceId}))};
    }
    assert.equal(audit.readBatches.length,6,'sixth batch must be consumed before generation');
    assert.equal(generated,false,'only one revision expected');generated=true;event('revision_generated');
    assert.match(system,/kind.*patch/,'fixture must follow the actual revision response contract');
    return {kind:'patch',edits:[{before:'尚未核对19项来源。',after:facts.map(x=>`${x.marker}：${x.value}。`).join('\n\n')}],summary:'保留原稿结构并补齐19项已读事实'};
  });
  f.reopen=()=>{
    a.save();dispose(a);
    const previous=a,ids={job:f.job.id,task:f.task.id};
    a=new Assistant({...options,chat:previous.chat,agentRequest:previous.agentRequest,connectorRequest,officeRequest:denied,webRequest:denied,feedRequest:denied});
    a.platformRequest=previous.platformRequest;
    f.a=a;f.job=a.data.delegations.find(j=>j.id===ids.job);f.task=a.task(ids.task);
    event('cold_workspace_loaded');return f;
  };
  saveAudit();return f;
}

function assertComplete(f){
  const {a,job,task,audit}=f,diagnostic=compactFailure(f);
  assert.deepEqual(audit.violations,[],diagnostic);assert.equal(job.status,'review',diagnostic);assert.equal(task.status,'review',diagnostic);
  assert.equal(job.autoAccept,false);assert.equal(task.acceptedAt??null,null);assert.equal(job.completedAt??null,null);
  assert.deepEqual(audit.platformCalls,facts.map(f=>f.id));assert.equal(audit.readBatches.length,6);assert.equal(new Set(audit.readBatches.flat().map(r=>r.sourceId)).size,19);
  const primary=outputs.primary(a,task);assert.notEqual(primary.id,f.old.id);assert.equal(primary.content,revisedBody);assert.equal(a.data.artifacts.find(r=>r.id===f.old.id).content,oldBody);
  assert.equal(task.contentVerification.passed,true);assert.equal(task.contentVerification.basis,control.contentBasis(a,job,task));assert.equal(task.verification.passed,true);
  const update=a.data.agentActions.filter(r=>r.tool==='lark_update');assert.equal(update.length,1);assert.equal(update[0].status,'done');assert.equal(update[0].result.url,url);assert.equal(update[0].artifactId,primary.id);
  assert.equal(a.data.sources.find(s=>s.id===update[0].result.sourceId).content,revisedBody);assert.deepEqual(a.data.agentActions.find(r=>r.id===f.baseline.receipt.id).result,f.baseline.receipt.result);
  assert.ok(!task.sourceIds.includes(f.unrelated.id));assert.equal(a.data.decisions.filter(d=>d.status==='open').length,0);
  const ledger=a.spendLedger.scopes['job:'+job.id];assert.equal(ledger.limitUSD,200);assert.ok(ledger.spentUSD>f.baseline.ledger.spentUSD);assert.ok(Math.abs(ledger.heldUSD-f.baseline.ledger.heldUSD)<1e-9);assert.deepEqual(ledger.pending,{});
  const kinds=audit.events.map(e=>e.kind),idx=k=>kinds.indexOf(k);
  assert.ok(idx('check_missing')<idx('platform_fact'));assert.ok(idx('associate_requested')<idx('read_batch_consumed'));assert.ok(idx('revision_generated')<idx('lark_update'));
  assert.deepEqual(audit.checks.map(c=>[c.kind,c.passed]),[['content',false],['content',true],['result',true],['goal',true]]);
  if(audit.scenario==='input_upgrade'){assert.deepEqual(audit.finalChecksReturned,{content:true,result:true});assert.equal(audit.events.filter(e=>e.kind==='bounded_check_conclusion').length,2);assert.equal(Object.values(task.contextFinalizations).filter(a=>a.status==='returned').length,2);}
  if(audit.scenario==='context_authorization_repair'){
    const b=f.baseline.contextRepair,e=job.executionState.continuation.episodes[b.episode.basis];
    assert.equal(audit.events.filter(e=>e.kind==='context_repair_first_bounded').length,1);
    assert.ok(idx('cold_worker_loaded')>=0||idx('cold_workspace_loaded')>=0,'upgrade must cold load before repair');
    assert.equal(Object.keys(e.checkRepairs).length,1);
    const receipts=[e.pendingCheck,...(e.checkReceipts||[])],receipt=receipts.find(p=>p.generationAttemptId===b.episode.pendingCheck.generationAttemptId);
    assert.ok(receipt);assert.equal(receipt.claimId,b.episode.pendingCheck.claimId);assert.equal(receipt.status,'settled');assert.deepEqual(receipt.interruption,b.episode.pendingCheck.interruption);
    const conclusions=Object.values(task.contextFinalizations).filter(r=>r.semanticCheckId===b.finalization.semanticCheckId);assert.equal(conclusions.length,1);assert.equal(conclusions[0].status,'returned');
    assert.deepEqual(a.data.agentRuns.find(r=>r.id===b.run.id),b.run,'historical run is immutable');
  }
  return {status:job.status,platformSources:19,consumedReadBatches:6,verificationReadBatches:audit.verificationReads.length,updates:1,creates:audit.connectorCalls.filter(c=>c.args[1]==='+create').length,workerThreadId:audit.workerThreadId,spentUSD:ledger.spentUSD,heldUSD:ledger.heldUSD};
}
function dispose(a){access.cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);}
module.exports={setup,assertComplete,compactFailure,dispose,url,oldBody,revisedBody,facts,assertReferences,contextRepairState,assertContextRepairRestored};
