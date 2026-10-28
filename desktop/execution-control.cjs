const evidence=require('./evidence-basis.cjs');
const ledger=require('./operation-ledger.cjs');
const obligations=require('./work-obligations.cjs');
const now=()=>new Date().toISOString();
function tasks(a,job){return (job.taskIds||[]).map(id=>(a.data.tasks||[]).find(t=>t.id===id)).filter(t=>t&&!t.deletedAt&&!t.agentCancelled);}
function stage(a,task){return require('./execution-facts.cjs').taskPhase(task);}
function runnableActions(a,job){return require('./work-state.cjs').runnableActions(a,job);}
// Stage selection is read only. Mutation is confined to claim/prepare below.
function peek(a,job,{taskId,automatic=a.automaticExecution!==false}={}) {
 const facts=require('./execution-facts.cjs'),allowed=facts.candidateActions(a,job,{automatic}),ids=new Set(allowed.map(r=>r.taskId));
 const forced=job.executionState?.forcedNext;
 if(forced&&(!taskId||!forced.args?.taskId||forced.args.taskId===taskId)&&(!forced.args?.taskId?!facts.blockingReasons(a,job).length:ids.has(forced.args.taskId))){
  const t=tasks(a,job).find(t=>t.id===forced.args?.taskId);
  if(!t||!require('./recovery-diagnostics.cjs').planning(a,job,t))return {...structuredClone(forced),controlled:true,forced:true};
 }
 for(const task of tasks(a,job).filter(t=>!taskId||t.id===taskId)) {
  if(task.status==='review'&&!task.acceptedAt&&task.verification?.basis&&task.verification.basis!==require('./acceptance.cjs').basis(a,task))return {command:'review_reopen',taskId:task.id,proof:{basis:task.verification.basis,currentBasis:require('./acceptance.cjs').basis(a,task)}};
  if(!ids.has(task.id))continue;
  if(!automatic&&facts.blockingReasons(a,job,task).some(r=>r.code==='decision')&&!facts.dispatchBlockers(a,job,task,{automatic}).some(r=>r.code==='decision'))return {tool:'planner',args:{taskId:task.id},reason:'手动继续先核对已有问题与当前步骤'};
  if(require('./recovery-diagnostics.cjs').planning(a,job,task)||task.needsReplan)return {tool:'planner',args:{taskId:task.id},reason:'根据当前事项的具体缺口协调计划'};
  if(facts.retryTask(a,job,task)&&task.steps.find(s=>!s.done)?.kind!=='external')return {tool:'advance_task',args:{taskId:task.id},autoRecovery:true,reason:'从已保存的模型调用断点恢复',controlled:true};
  const phase=stage(a,task),primary=require('./deliverables.cjs').primary(a,task);
  if(['work','repair'].includes(phase))return {tool:'planner',args:{taskId:task.id},reason:'选择当前文本步骤所需的动作与参数'};
  if(phase==='verify')return {tool:'advance_task',args:{taskId:task.id},reason:'直接完成当前版本的步骤或结果检查',controlled:true};
  if(phase==='deliver'&&primary){
   if(task.contentVerification?.basis!==contentBasis(a,job,task)||require('./grounding.cjs').enabled(a)&&!require('./grounding.cjs').reusable(a,task)&&task.contentVerification?.passed!==false)return {tool:'verify_content',args:{taskId:task.id},reason:'交付前核对当前主稿',controlled:true};
   if(task.contentVerification.passed===false){const target=require('./revision-protocol.cjs').target(a,task,task.contentVerification);if(target&&!job.executionState?.recoveries?.['content:'+task.contentVerification.basis])return {tool:'revise_task',args:{taskId:task.id,artifactId:target.id,note:'按当前内容检查缺口修订，保持用户范围：\n'+task.contentVerification.gaps.join('\n')},recoveryBasis:task.contentVerification.basis,controlled:true};return {tool:'planner',args:{taskId:task.id},reason:'核对当前明确内容缺口'};}
   return {tool:'planner',args:{taskId:task.id},reason:'为当前已核验交付补齐工具参数，沿用原目标'};
  }
  return {tool:'planner',args:{taskId:task.id},reason:'协调当前事项可执行步骤'};
 }
 return null;
}
function claim(a,job,choice) {
 if(!choice||choice.command)return null;
 if(choice.forced||choice.recoveryBasis||choice.autoRecovery)require('./state-transitions.cjs').commit(a,()=>{
  if(choice.autoRecovery&&job.autoRecovery)job.autoRecovery.status='recovering';
  if(choice.forced)delete job.executionState.forcedNext;
  if(choice.recoveryBasis)ledger.state(job).recoveries['content:'+choice.recoveryBasis]={at:now()};
 });
 return choice.tool==='planner'?null:{...choice,controlled:true};
}
function next(a,job,options={}) {
 const p=require('./execution-policy.cjs'),decision=p.prepare(a,job,options);
 // Compatibility stage API: watcher admission belongs to run/checkSources.
 if(!decision.eligible||decision.mode==='watch')return null;
 if(decision.action?.tool==='planner'){const task=tasks(a,job).find(t=>t.id===decision.taskIds[0]);if(task&&!task.needsReplan&&!require('./recovery-diagnostics.cjs').planning(a,job,task)&&stage(a,task)==='work')return {tool:'advance_task',args:{taskId:task.id},controlled:true};}
 return p.claim(a,job,options);
}
function contentBasis(a,job,task){return evidence.hash({intent:evidence.intent(job,task),criteria:task.criteria,sources:evidence.taskSources(a,task),...(task.primaryArtifactId?{primaryArtifactId:task.primaryArtifactId}:{}),artifacts:require('./deliverables.cjs').current(a,task).map(r=>({stepId:r.stepId,hash:evidence.hash(r.content)}))});}
function contentRequest(a,job,task,{prefetch=false}={}){
 // Claim selection happens inside generation.call. Defer eager numbered-section
 // reads until that selection proves this is an ordinary, rather than forced, check.
 return {context:{...a.context(task,{verification:true,prefetch}),requirements:obligations.requirements(a,job),verificationSnapshot:require('./revision-protocol.cjs').snapshot(a,task),verificationPhase:'content',businessObligations:require('./relation-obligations.cjs').context(a,job,task),pendingDelivery:task.steps.filter(s=>s.kind==='external'&&!s.done).map(s=>s.title)},system:require('./relation-obligations.cjs').instruction+'\n'+require('./revision-protocol.cjs').verificationInstruction+'独立检查当前文稿内容是否满足已确认的用户范围。返回 {"passed":true或false,"summary":"结论","gaps":["具体未满足要求"],"gapDetails":[{"requirementId":"对应要求 ID","text":"与 gaps 一致","sourceIds":["实际使用的来源 ID"]}]}。只能依据给定 requirements 指出缺口，不添加用户没有要求的范围。当前只做内容检查：pendingDelivery 是随后由 App 执行的交付，不因尚未写入、创建或回读而判内容失败。缺失事实如已按用户决定保留边界，核对说明即可。需要原文时使用 read_context。'};
}
async function verifyContent(a,job,task){
 require('./marker-confirmation.cjs').assertRunnable(a,task);
 require('./agent-plan.cjs').assertReady(a,task);
 const consumption=require('./evidence-consumption.cjs');
 if(consumption.draftOnly(a,task)&&(!consumption.coverage(a,job,task)||consumption.view(a,job,task)?.remaining>0))throw Object.assign(Error('当前主稿已纳入部分证据，全部类型的覆盖或事实纳入尚未完成；请继续补证并纳入新增事实，不重复生成旧内容或发起最终内容检查'),{code:'EVIDENCE_REQUIRED',taskId:task.id,businessObligations:require('./relation-obligations.cjs').context(a,job,task)});
 const before=contentBasis(a,job,task),prior=a.activeSpendTask;a.activeSpendTask=task;
 try{
  const {context,system}=contentRequest(a,job,task);
  let result=await require('./generation-context.cjs').call(a,task,system,context,'verify');
  if(typeof result.passed!=='boolean'||!result.summary?.trim()||!Array.isArray(result.gaps)||result.gaps.some(g=>typeof g!=='string')||result.passed&&result.gaps.some(g=>g.trim()))throw require('./model-errors.cjs').modelError('MODEL_INVALID_RESPONSE','内容检查结果无效，将保留文稿后恢复检查',true);
  if(contentBasis(a,job,task)!==before)throw Object.assign(Error('内容检查期间依据变化，需要重新核对'),{code:'PLAN_RECONCILE_REQUIRED',taskId:task.id});
  const coverage=require('./relation-obligations.cjs').validateCoverage(a,job,task,result,before);result=coverage.result;
  require('./state-transitions.cjs').commit(a,()=>{
   if(contentBasis(a,job,task)!==before)throw Object.assign(Error('提交内容检查前依据变化，需要重新核对'),{code:'PLAN_RECONCILE_REQUIRED',taskId:task.id});
   if(consumption.draftOnly(a,task)&&(!consumption.coverage(a,job,task)||consumption.view(a,job,task)?.remaining>0))throw Object.assign(Error('检查期间证据覆盖或事实纳入已变化，增量草稿保持待补证'),{code:'EVIDENCE_REQUIRED',taskId:task.id});
   if(result.grounding)task.grounding=result.grounding;
   task.contentVerification={...result,basis:before,snapshot:context.verificationSnapshot,at:now()};
   require('./marker-confirmation.cjs').route(a,task,result);
   require('./continuation-control.cjs').noteCheck(a,job,task,task.contentVerification,{phase:'content'});require('./relation-obligations.cjs').record(job,coverage.receipts);
   if(result.passed&&consumption.draftOnly(a,task)){
    const artifact=require('./deliverables.cjs').primary(a,task);artifact.draftOnly=false;
    for(const receipt of task.evidenceConsumption?.receipts||[])if(receipt.artifactId===artifact.id&&receipt.artifactHash===evidence.hash(artifact.content))Object.assign(receipt,{verified:true,verifiedAt:task.contentVerification.at,checkBasis:before});
   }
  });return {taskId:task.id,verification:structuredClone(task.contentVerification)};
 }finally{a.activeSpendTask=prior;}
}
function escape(a,job,error){
 if(error.code==='UNRESOLVED_GAPS')return false;
 const s=ledger.state(job),basis=require('./efficiency.cjs').progress(a,job);
 if(s.recoveries[basis])return false;
 const active=tasks(a,job).filter(t=>!['paused','waiting','review','completed'].includes(t.status)&&!t.needsReplan&&!require('./agent-plan.cjs').dependencyIssues(a,t).length);
 const candidate=active.find(t=>stage(a,t)==='verify'||stage(a,t)==='work');
 const boundary=obligations.frontier(a,job).find(r=>r.status==='unexpanded'&&r.scopeProven===true);
 if(!candidate&&!boundary){
  const retry=Object.values(s.operations).map(o=>ledger.eligibility(job,o)).filter(d=>d.action==='wait_until').sort((x,y)=>x.retryAt.localeCompare(y.retryAt))[0];
  if(retry&&job.progressGuard?.tool==='platform_query'){job.status='retry';job.nextRunAt=retry.retryAt;job.retryCheck=false;job.summary='平台请求暂时失败，退避结束后自动继续；已有证据和费用累计保留';s.recovery={code:'PLATFORM_RETRY',message:job.summary,nextRetryAt:retry.retryAt};return true;}
  return false;
 }

 const response=candidate?{tool:'advance_task',args:{taskId:candidate.id},reason:'App 已识别重复读取或重规划，转入当前未完成的生成或检查步骤'}:{tool:'platform_query',args:{queries:[boundary.query]},reason:'App 从未展开的边界继续取证，跳过重复查询'};
 s.recoveries[basis]={at:now(),reason:error.message,next:structuredClone(response)};s.forcedNext=response;
 job.status='ready';job.nextRunAt=now();job.retryCheck=false;job.summary=response.reason;
 return true;
}
function context(a,job){
 const s=ledger.state(job),frontier=obligations.frontier(a,job);
 return {version:2,...obligations.context(a,job),businessObligations:tasks(a,job).flatMap(t=>require('./relation-obligations.cjs').context(a,job,t)),phases:tasks(a,job).map(t=>({taskId:t.id,stage:stage(a,t),nextStep:t.steps.find(s=>!s?.done)?.key||null})),recovery:s.recovery||null,
  queryOperations:ledger.snapshot(job),frontier:frontier.slice(0,1000),frontierTotal:frontier.length,
  instruction:'按照当前阶段完成未满足要求。相同查询会复用证据，不能通过改名或重置步骤制造进展。所有步骤完成后由 App 自动检查；纯授权事件不会重做稿件。已满足的缺口不再进入修订。'};
}
function error(error,taskId){
 if(error.code)return error;
 if(/尚未全部通过结果检查/.test(error.message))return Object.assign(error,{code:'VERIFICATION_REQUIRED',taskId});
 return error;
}
function recover(a,job,step,err){
 error(err,step.args?.taskId);
 if(!['PLAN_RECONCILE_REQUIRED','PLAN_ALREADY_RECONCILED','VERIFICATION_REQUIRED','CONTENT_REPAIR_REQUIRED','REVISION_TARGET_REQUIRED','EVIDENCE_REQUIRED','EXTERNAL_TOOL_REQUIRED'].includes(err.code))return false;
 if(step.tool==='complete'&&err.code==='VERIFICATION_REQUIRED')ledger.state(job).completionRequested={workRevision:job.workRevision??1,tasks:evidence.hash(tasks(a,job).map(t=>[t.id,t.workRevision??1]).sort())};
 ledger.state(job).recovery={code:err.code,taskId:err.taskId||step.args?.taskId,message:err.message,at:now(),allowedTools:err.code==='PLAN_ALREADY_RECONCILED'?['advance_task']:err.code==='EXTERNAL_TOOL_REQUIRED'?[a.task(err.taskId||step.args.taskId).steps.find(s=>!s.done)?.tool].filter(Boolean):['PLAN_RECONCILE_REQUIRED','EVIDENCE_REQUIRED'].includes(err.code)?['plan_task','platform_query','capability_call','read_source','search_source','read_output_state']:['CONTENT_REPAIR_REQUIRED','REVISION_TARGET_REQUIRED','EVIDENCE_REQUIRED','EXTERNAL_TOOL_REQUIRED'].includes(err.code)?['revise_task']:err.code==='EXTERNAL_TOOL_REQUIRED'?[a.task(err.taskId).steps.find(s=>!s.done)?.tool].filter(Boolean):['advance_task']};
 return true;
}
function after(a,job,step){
 const s=ledger.state(job);
 s.lastAction={at:step.at,tool:step.tool,error:step.error||null};
 if(step.tool==='plan_task'&&!step.error)s.recovery=null;
 if(step.tool==='complete'){
  if(!step.error)delete s.completionRequested;
  if(step.result?.complete===false)s.goalFailure={basis:evidence.hash(tasks(a,job).map(t=>require('./acceptance.cjs').basis(a,t))),gaps:step.result.gaps};
  else if(step.result?.completed||step.result?.awaitingReview||step.result?.serving)delete s.goalFailure;
 }else if(s.goalFailure&&s.goalFailure.basis!==evidence.hash(tasks(a,job).map(t=>require('./acceptance.cjs').basis(a,t))))delete s.goalFailure;
 step.afterBasis=require('./efficiency.cjs').progress(a,job);step.phases=tasks(a,job).map(t=>({taskId:t.id,stage:stage(a,t)}));
 ledger.event(job,{tool:step.tool,errorCode:step.errorCode||null,taskId:step.args?.taskId||null,result:step.error?'failed':'returned',beforeBasis:step.beforeBasis,afterBasis:step.afterBasis,phases:step.phases});
}
function initialize(a){
 require('./evidence-store.cjs').migrate(a);
 for(const job of a.data.delegations){
  ledger.state(job);obligations.requirements(a,job);job.executionState.version=2;
  for(const r of Object.values(job.executionState.operations))if(r.status==='running'){r.status='interrupted';r.interruptedAt=now();}
  delete job.executionState.principalCheckedAt;
  if(!job.executionState.migrated){
   for(const [key,check] of Object.entries(job.repairProgress||{}))if(check.gaps?.length&&!job.executionState.gaps.some(g=>g.requirementId===key))obligations.record(a,job,key,{passed:false,gaps:check.gaps.map(g=>g.text)});
   const sources=a.data.sources.filter(s=>job.sourceIds.includes(s.id)&&s.platformSnapshot&&!s.deleted&&!s.projectExcluded);
   const oldIds=new Set(sources.map(s=>s.previousSourceId).filter(Boolean));
   for(const source of sources.filter(s=>!oldIds.has(s.id)))try{const snap=JSON.parse(source.content);if(snap.operation==='identity'&&!job.platformPrincipal)job.platformPrincipal=snap.data.username||null;}catch{}
   for(const source of sources.filter(s=>!oldIds.has(s.id)))try{
    const snap=JSON.parse(source.content),key=ledger.key(job,snap.query),existing=job.executionState.operations[key];
    // Bootstrap only absent/older migrated receipts. A real App dispatch is
    // authoritative even when an older snapshot occurs later in source order.
    if(existing&&(!existing.migrated||Date.parse(existing.completedAt)>=Date.parse(source.lastCheckedAt||snap.queriedAt)))continue;
    job.executionState.operations[key]={id:require('node:crypto').randomUUID(),key,query:snap.query,epoch:ledger.epoch(job),principal:job.platformPrincipal||null,status:'done',sourceId:source.id,completedAt:source.lastCheckedAt||snap.queriedAt,attempt:1,migrated:true};
   }catch{}
   for(const run of [...a.data.agentRuns].reverse().filter(r=>r.jobId===job.id))for(const step of run.steps||[])if(step.tool==='platform_query')for(const row of step.result?.results||[]){
    if(!row.error||!row.query)continue;
    try{const key=ledger.key(job,row.query),old=job.executionState.operations[key],at=step.at||run.finishedAt||run.startedAt;
     if(old&&(!old.migrated||Date.parse(old.completedAt)>=Date.parse(at)))continue;
     const errorCode=ledger.classify(Error(row.error));
     job.executionState.operations[key]={key,query:row.query,epoch:ledger.epoch(job),principal:job.platformPrincipal||null,status:'failed',error:row.error,errorCode,completedAt:at,attempt:1,migrated:true,...(errorCode==='TRANSIENT'?{retryAt:at}:{})};
    }catch{}
   }
   job.executionState.migrated=now();
  }
 }
 require('./evidence-store.cjs').reconcile(a);
 // Rebase only a legacy check whose exact old validity can still be proved.
 for(const task of a.data.tasks){
  const check=task.verification;if(!check?.basis||check.basisVersion===2)continue;
  if(check.basis===require('./acceptance.cjs').basis(a,task,{legacy:true})){check.basis=require('./acceptance.cjs').basis(a,task);check.basisVersion=2;}
 }
}
function requestHelp(a,job,error){
 const gaps=ledger.state(job).gaps.filter(g=>g.status==='open');
 const result=require('./decisions.cjs').ask(a,job,{key:'progress:'+evidence.hash([job.executionContract?.revision||job.goal,gaps.map(g=>g.id),error.signature||error.message]),question:'当前证据下无法继续取得进展，你希望怎样处理？',context:error.message,taskIds:tasks(a,job).filter(t=>!['review','completed'].includes(t.status)).map(t=>t.id),options:[
  {label:'补充资料或授权',description:'补齐缺失依据后沿用已有成果继续。',answer:'我将补充缺失资料或授权',recommended:true},
  {label:'保留缺口交付',description:'明确标注当前无法核实的部分，完成可访问范围。',answer:'保留已知缺口并完成可访问部分'},
  {label:'调整范围',description:'补充需要优先完成的部分。',answer:'调整执行范围',requiresText:true}
 ]});
 const decision=a.data.decisions.find(d=>d.id===result.decisionId);if(decision)decision.executionGapIds=gaps.map(g=>g.id);return result;
}
function answer(a,job,decision){
 if(decision.answer!=='保留已知缺口并完成可访问部分'||!decision.executionGapIds)return;
 for(const gap of ledger.state(job).gaps)if(decision.executionGapIds.includes(gap.id))Object.assign(gap,{status:'accepted_gap',acceptedAt:decision.answeredAt,acceptedBy:'user',decisionId:decision.id,acceptedRequirementText:obligations.requirements(a,job).find(r=>r.id===gap.requirementId)?.text});
}
function view(a,job){const s=job.executionState||{},operations=Object.values(s.operations||{}),waiting=operations.map(o=>({...ledger.eligibility(job,o),tool:o.query?.op})).filter(d=>d.action==='wait_until').sort((a,b)=>a.retryAt.localeCompare(b.retryAt));return {waiting:waiting[0]||null,unchangedReads:s.reusedReads||0,phases:tasks(a,job).map(t=>({taskId:t.id,title:t.title,stage:stage(a,t)})),evidenceConsumption:tasks(a,job).map(t=>{const progress=require('./evidence-consumption.cjs').view(a,job,t);return progress?{taskId:t.id,title:t.title,...progress}:null;}).filter(Boolean),lastProgress:s.lastProgress||null,lastAction:s.lastAction||null,next:s.forcedNext?.reason||null,recovery:s.recovery||null,openGaps:(s.gaps||[]).filter(g=>g.status==='open').length,closedGaps:(s.gaps||[]).filter(g=>g.status==='satisfied').length,reusedQueries:s.reusedQueries||0};}
module.exports={runnableActions,peek,claim,next,stage,context,error,recover,after,initialize,view,escape,verifyContent,contentRequest,contentBasis,requestHelp,answer};
