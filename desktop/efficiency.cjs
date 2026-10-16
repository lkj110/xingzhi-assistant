const crypto=require('node:crypto');
const spend=require('./spend.cjs');
const {normalizeModelError,safeErrorCode,persistenceError}=require('./model-errors.cjs');
const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>object[k]!==undefined).map(k=>[k,object[k]]));
function summary(text,limit){if(typeof text!=='string')return text;return text.length<=limit?text:text.slice(0,Math.floor(limit*.65))+'\n[摘要已截断，请按需读取全文]\n'+text.slice(-Math.floor(limit*.35));}
function compact(value){
  const result = {...value,
    memory:{goal:value.goal,knownSources:value.sources.filter(s=>s.current).map(s=>({id:s.id,title:s.title,version:s.version})),openQuestions:value.followups.filter(f=>f.status==='waiting'),nextSteps:value.tasks.filter(t=>!t.agentCancelled).map(t=>({taskId:t.id,title:t.title,needsReplan:t.needsReplan,next:t.status==='completed'?(t.acceptedBy==='user'?'用户已验收完成':'已完成'):t.steps.find(s=>!s.done)||'等待验收',waitingOn:t.waitingOn})),note:'这是根据已保存状态生成的项目摘要；正文、冲突与依据请按来源 ID 检索。'},
    tasks:value.tasks.map(t=>({...pick(t,['id','title','description','criteria','priority','status','steps','dependsOn','sourceIds','supersededSourceIds','needsReplan','agentCancelled','planVersion','agentKey','githubIssue','waitingOn','nextCheckAt','verification','contentVerification','evidenceRequest','primaryArtifactId','lastError','acceptedAt','acceptedBy']),notes:t.notes.slice(-3),artifactHistory:t.artifactHistory,artifacts:t.artifacts.map(r=>({id:r.id,title:r.title,stepId:r.stepId,role:r.role,current:r.current,preview:summary(r.content,1200),characters:r.characters||r.content.length,readTool:'read_artifact'}))})),
    sources:value.sources.map(s=>({...s,content:summary(s.content,s.current?1500:350),truncated:s.truncated||s.content.length>(s.current?1500:350)})),
    recentActions:value.recentActions.slice(-5).map((r,i,rows)=>({...pick(r,['tool','at','error','trigger']),result:i===rows.length-1?r.result:{summary:summary(JSON.stringify(r.result||{}),700)}})),
    completedWrites:value.completedWrites.map(r=>({...r,result:pick(r.result||{},['path','latestPath','url','number','sha256','contentHash','verified','reused'])}))};
  return JSON.stringify(result).length < JSON.stringify(value).length ? result : value;
}
async function call(a,provider,key,messages,options,invoke){
  const start=Date.now(),job=a.activeAgentJob,run=a.activeAgentRun,taskRun=a.activeSpendRun,price=options.spendTicket?.pricing||spend.pricing(provider);
  const row={id:crypto.randomUUID(),at:new Date().toISOString(),jobId:job?.id||null,taskId:a.activeSpendTask?.id||null,runId:run?.id||taskRun?.id||null,spendScope:options.spendTicket?.scopeKey||null,pricing:price,role:options.role||'execute',stage:options.stage||'work',providerId:provider.id||null,requestId:options.requestId||null,attempt:options.attempt||1,fallbackFrom:options.fallbackFrom||null,model:provider.model,reasoning:provider.reasoning||null,inputChars:messages.reduce((n,m)=>n+String(m.content||'').length,0),status:'running'};
  a.data.modelCalls ||= [];a.data.modelCalls.unshift(row);a.data.modelCalls=a.data.modelCalls.slice(0,1000);
  row.taskRunId=taskRun?.id||null;row.providerName=provider.name||null;row.providerType=provider.type||null;
  if(options.routing)row.routing=pick(options.routing,['mode','tier','reason','primaryId']);
  const syncModels=require('./run-models.cjs').start(row,[run,taskRun]);
  let usage;
  try{try{a.save();}catch{throw persistenceError();}const result=await invoke(provider,key,messages,{...options,onProgress:value=>{row.lastActivityAt=value.lastActivityAt;options.onProgress?.(value);},onUsage:value=>{usage=spend.usage(value);options.onUsage?.(value);}});row.status='done';return result;}
  catch(error){const normalized=error.localPersistence?error:normalizeModelError(error);row.status=options.signal?.aborted||normalized.code==='MODEL_CANCELLED'?'stopped':'error';row.errorCode=safeErrorCode(normalized);row.errorMessage=normalized.message;row.diagnostic=require('./model-errors.cjs').diagnostic(normalized);normalized.recoveryContext={stage:row.stage,taskId:row.taskId,model:row.model,requestId:row.requestId};if(['idle','total'].includes(normalized.timeoutKind))row.timeoutKind=normalized.timeoutKind;throw normalized;}
  finally{
    row.durationMs=Date.now()-start;
    if(usage)Object.assign(row,usage);
    row.estimatedUSD=spend.cost(usage,price);row.usageReported=!!usage;
    row.reservedUSD=!usage?options.spendTicket?.reservedUSD||0:0;
    syncModels();
    if(job)spend.addUsage(job.usage ||= spend.emptyUsage(),usage,row.estimatedUSD);
    if(run)spend.addUsage(run.usage ||= spend.emptyUsage(),usage,row.estimatedUSD);
    if(taskRun)spend.addUsage(taskRun.usage ||= spend.emptyUsage(),usage,row.estimatedUSD);
    spend.settle(a,options.spendTicket,usage,row.estimatedUSD);
    try{a.save();}catch{throw persistenceError();}
  }
}
function action(a,job,step){
  require('./work-efficiency.cjs').assertAllowed(a,job);
  const signature=crypto.createHash('sha256').update(JSON.stringify({tool:step.tool,args:step.args})).digest('hex');
  const duplicate=job.lastActionSignature===signature;
  if(duplicate)job.repeatedActions=(job.repeatedActions||0)+1;
  job.lastActionSignature=signature;step.repeated=duplicate;
}
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
// Compare saved work, not request timings, history entries, usage or rewritten explanations.
function progress(a,job){
  const basis=require('./evidence-basis.cjs'),unique=rows=>[...new Map(rows.map(r=>[basis.hash(r),r])).values()].sort((x,y)=>basis.hash(x).localeCompare(basis.hash(y)));
  return digest({
    goal:job.goal,executionContract:job.executionContract,feedback:basis.feedback(job.feedback).map(f=>f.text),
    sources:unique(job.sourceIds.map(id=>{const s=a.data.sources.find(s=>s.id===id);return s?basis.version(s,null,job):{id,missing:true};})),
    tasks:job.taskIds.map(id=>{const t=a.task(id);return {id:t.id,cancelled:!!t.agentCancelled,verified:t.verification?.passed===true,waitingOn:t.waitingOn||''};}),
    artifacts:unique(job.taskIds.flatMap(id=>require('./deliverables.cjs').current(a,a.task(id))).map(r=>({taskId:r.taskId,content:digest(r.content)}))),
    followups:job.followups.map(f=>pick(f,['key','taskId','expected','watchKeys','respondentId','status','sourceId','evidence'])),
    decisions:a.data.decisions.filter(d=>d.jobId===job.id).map(d=>pick(d,['id','status','question','answer','sourceIds'])),
    writes:unique(a.data.agentActions.filter(r=>r.jobId===job.id&&r.status==='done').map(r=>({tool:r.tool,taskId:r.taskId,target:r.target,content:digest(r.content||''),result:r.result}))),
  });
}
function resetProgress(job){delete job.progressGuard;delete job.lastActionSignature;/* Persistent operation/gap/work-efficiency evidence survives resume. */}
function checkProgress(a,job,step,before){
  // Persist diagnostics even when the efficiency guard yields this attempt.
  const repairError=require('./repair-progress.cjs').check(a,job,step,{deferThrow:true});
  const work=require('./work-efficiency.cjs').observe(a,job,step);
  step.workEfficiency=work;
  if(!work.allowed)return work; // Yield to automatic strategy recovery, without a fee/decision dialog.
  if(repairError)throw repairError;
  const ledger=require('./operation-ledger.cjs'),evidence=require('./evidence-basis.cjs'),state=ledger.state(job),after=progress(a,job);
  state.progressBasis=after;state.stalls ||= {};state.stallBases ||= {};
  const args=step.tool==='capability_call'?require('./capabilities.cjs').normalizeArguments(a,step.args):step.args;
  const normalized=ledger.normalize(step.tool,args),task=args?.taskId&&a.data.tasks.find(t=>t.id===args.taskId);
  const read=state.reads[require('./tool-registry.cjs').request(job,step.tool,args,a)];
  const items=step.tool==='platform_query'?normalized.queries.map(query=>{
    const result=step.result?.results?.find(r=>JSON.stringify(require('./data-platform.cjs').command(r.query))===JSON.stringify(query));
    const source=a.data.sources.find(s=>s.id===result?.sourceId);
    return {signature:digest({tool:step.tool,query}),fact:source?evidence.version(source,null,job):result?.errorCode||result?.error,changed:!!source&&!result.reused&&!result.unchanged};
  }):[{signature:digest(canonical(normalized)),fact:read?.fingerprint,changed:after!==before}];
  let count=0,signature=items[0]?.signature,changed=false;
  for(const item of items){
    const relevantBasis=evidence.hash({intent:evidence.intent(job,task||null),read:item.fact,task:task?evidence.taskSources(a,task):null});
    const previousBasis=state.stallBases[item.signature];
    if(previousBasis&&previousBasis!==relevantBasis)delete state.stalls[item.signature];
    state.stallBases[item.signature]=relevantBasis;
    if(item.changed&&(step.tool!=='platform_query'||previousBasis!==relevantBasis)){delete state.stalls[item.signature];changed=true;}
    else state.stalls[item.signature]=(state.stalls[item.signature]||0)+1;
    if(state.stalls[item.signature]>count){count=state.stalls[item.signature];signature=item.signature;}
  }
  if(changed){delete job.progressGuard;state.lastProgress={at:new Date().toISOString(),tool:step.tool,taskId:args?.taskId||null,summary:({platform_query:'取得新的平台证据',advance_task:'文稿或结果检查取得进展',write_file:'文件交付已确认',lark_create:'飞书文档已创建',lark_update:'飞书文档已更新'})[step.tool]||'已保存新的证据或执行结果'};}
  else job.progressGuard={signature,state:after,tool:step.tool,count};
  if(count<3)return;
  job.progressGuard={signature,state:after,tool:step.tool,count,stoppedAt:new Date().toISOString()};
  throw Object.assign(new Error(`动作 ${step.tool} 已累计 3 次没有带来新的相关证据或成果（连续 3 次或交替重复均计入），将核对当前阶段并恢复；已有产出保留。`),{noProgress:true,code:'NO_NEW_EVIDENCE',signature});
}

module.exports={compact,call,action,progress,checkProgress,resetProgress};
