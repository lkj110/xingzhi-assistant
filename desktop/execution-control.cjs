const evidence=require('./evidence-basis.cjs');
const ledger=require('./operation-ledger.cjs');
const obligations=require('./work-obligations.cjs');
const now=()=>new Date().toISOString();
function tasks(a,job){return (job.taskIds||[]).map(id=>(a.data.tasks||[]).find(t=>t.id===id)).filter(t=>t&&!t.deletedAt&&!t.agentCancelled);}
function stage(a,task){return require('./work-state.cjs').taskPhase(task);}
function runnableActions(a,job){return require('./work-state.cjs').runnableActions(a,job);}
function next(a,job){
 const acceptance=require('./acceptance.cjs'),state=require('./work-state.cjs');
 if(job.status==='completed'||job.deletedAt)return null;
 if(tasks(a,job).length&&tasks(a,job).every(t=>t.status==='completed'))acceptance.reconcileJobCompletion(a,job);
 if(!state.gate(a,job).automaticAllowed)return null;
 const needsPlanning=new Set(tasks(a,job).filter(t=>require('./recovery-diagnostics.cjs').planning(a,job,t)).map(t=>t.id));
 const allowed=new Set(runnableActions(a,job).filter(r=>!needsPlanning.has(r.taskId)).map(r=>r.taskId));
 const forced=ledger.state(job).forcedNext;
 if(forced&&forced.args?.taskId&&allowed.has(forced.args.taskId)){delete job.executionState.forcedNext;return {...forced,controlled:true};}
 if(forced&&!forced.args?.taskId&&!state.blockingReasons(a,job).length&&!needsPlanning.size){delete job.executionState.forcedNext;return {...forced,controlled:true};}
 if(forced?.args?.taskId&&needsPlanning.has(forced.args.taskId))delete job.executionState.forcedNext;
 for(const task of tasks(a,job))if(task.status==='review'&&!task.acceptedAt&&task.verification?.basis&&task.verification.basis!==require('./acceptance.cjs').basis(a,task)){
  task.status='todo';task.verification=null;a.event('已安排重新检查','已保存稿件保留，核对当前有效依据。',task.id);a.save();
 }
 const all=tasks(a,job),active=all.filter(t=>allowed.has(t.id)),ready=active.find(t=>stage(a,t)==='verify'&&!require('./agent-plan.cjs').dependencyIssues(a,t).length);
 if(ready)return {tool:'advance_task',args:{taskId:ready.id},reason:'App 已确认所有步骤完成，直接执行当前版本的结果检查',controlled:true};
 const deliver=active.find(t=>stage(a,t)==='deliver'&&!require('./agent-plan.cjs').dependencyIssues(a,t).length&&require('./deliverables.cjs').primary(a,t));
 if(deliver&&deliver.contentVerification?.basis!==contentBasis(a,job,deliver))return {tool:'verify_content',args:{taskId:deliver.id},reason:'App 在交付前检查当前稿件；核验不会执行外部写入',controlled:true};
 if(deliver?.contentVerification?.passed===false){
  const key=deliver.contentVerification.basis;
  const repairTarget=require('./revision-protocol.cjs').target(a,deliver,deliver.contentVerification);
  if(repairTarget&&!ledger.state(job).recoveries['content:'+key]){
   ledger.state(job).recoveries['content:'+key]={at:now()};
   return {tool:'revise_task',args:{taskId:deliver.id,artifactId:repairTarget.id,note:'按当前内容检查缺口修订，保持用户范围：\n'+deliver.contentVerification.gaps.join('\n')},reason:'App 将内容缺口交给修订步骤，完成后再交付',controlled:true};
  }
 }
 const candidate=acceptance.completionCandidate(a,job),requested=ledger.state(job).completionRequested;
 const retryCompletion=requested?.workRevision===(job.workRevision??1)&&requested.tasks===evidence.hash(tasks(a,job).map(t=>[t.id,t.workRevision??1]).sort());
 // Continuous work lets the planner establish its next wait or explicitly
 // finish this batch. Legacy accepted work still needs its bounded final check.
 if((acceptance.mode(job)!=='continuous'||job.status==='finalizing'||retryCompletion)&&candidate.ready&&!candidate.checked&&!(job.completionOperation?.basis===candidate.basis&&job.completionOperation.status==='running')&&!ledger.state(job).goalFailure)return {tool:'complete',args:{},completionBasis:candidate.basis,reason:'App 已确认本次成果检查通过，核对整体交付并开放最终验收',controlled:true};
 if(state.blockingReasons(a,job).length&&active.length)return {tool:'advance_task',args:{taskId:active[0].id},reason:'当前事项可独立推进，其他事项的等待保持可见',controlled:true};
 return null;
}
function contentBasis(a,job,task){return evidence.hash({intent:evidence.intent(job,task),criteria:task.criteria,sources:evidence.taskSources(a,task),...(task.primaryArtifactId?{primaryArtifactId:task.primaryArtifactId}:{}),artifacts:require('./deliverables.cjs').current(a,task).map(r=>({stepId:r.stepId,hash:evidence.hash(r.content)}))});}
async function verifyContent(a,job,task){
 require('./agent-plan.cjs').assertReady(a,task);
 const before=contentBasis(a,job,task),prior=a.activeSpendTask;a.activeSpendTask=task;
 try{
  const context={...a.context(task,{verification:true}),requirements:obligations.requirements(a,job),verificationSnapshot:require('./revision-protocol.cjs').snapshot(a,task),verificationPhase:'content',pendingDelivery:task.steps.filter(s=>s.kind==='external'&&!s.done).map(s=>s.title)};
  const result=await require('./generation-context.cjs').call(a,task,''+require('./revision-protocol.cjs').verificationInstruction+'独立检查当前文稿内容是否满足已确认的用户范围。返回 {"passed":true或false,"summary":"结论","gaps":["具体未满足要求"],"gapDetails":[{"requirementId":"对应要求 ID","text":"与 gaps 一致","sourceIds":["实际使用的来源 ID"]}]}。只能依据给定 requirements 指出缺口，不添加用户没有要求的范围。当前只做内容检查：pendingDelivery 是随后由 App 执行的交付，不因尚未写入、创建或回读而判内容失败。缺失事实如已按用户决定保留边界，核对说明即可。需要原文时使用 read_context。',context,'verify');
  if(typeof result.passed!=='boolean'||!result.summary?.trim()||!Array.isArray(result.gaps)||result.gaps.some(g=>typeof g!=='string')||result.passed&&result.gaps.some(g=>g.trim()))throw require('./model-errors.cjs').modelError('MODEL_INVALID_RESPONSE','内容检查结果无效，将保留文稿后恢复检查',true);
  if(contentBasis(a,job,task)!==before)throw Object.assign(Error('内容检查期间依据变化，需要重新核对'),{code:'PLAN_RECONCILE_REQUIRED',taskId:task.id});
  task.contentVerification={...result,basis:before,snapshot:context.verificationSnapshot,at:now()};a.save();return {taskId:task.id,verification:structuredClone(task.contentVerification)};
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

 const response=boundary?{tool:'platform_query',args:{queries:[boundary.query]},reason:'App 从未展开的边界继续取证，跳过重复查询'}:{tool:'advance_task',args:{taskId:candidate.id},reason:'App 已识别重复读取或重规划，转入当前未完成的生成或检查步骤'};
 s.recoveries[basis]={at:now(),reason:error.message,next:structuredClone(response)};s.forcedNext=response;
 job.status='ready';job.nextRunAt=now();job.retryCheck=false;job.summary=response.reason;
 return true;
}
function context(a,job){
 const s=ledger.state(job),frontier=obligations.frontier(a,job);
 return {version:2,...obligations.context(a,job),phases:tasks(a,job).map(t=>({taskId:t.id,stage:stage(a,t),nextStep:t.steps.find(s=>!s?.done)?.key||null})),recovery:s.recovery||null,
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
 ledger.state(job).recovery={code:err.code,taskId:err.taskId||step.args?.taskId,message:err.message,at:now(),allowedTools:['PLAN_RECONCILE_REQUIRED','PLAN_ALREADY_RECONCILED','EVIDENCE_REQUIRED'].includes(err.code)?['plan_task','platform_query','capability_call','read_source','search_source','read_output_state']:['CONTENT_REPAIR_REQUIRED','REVISION_TARGET_REQUIRED','EVIDENCE_REQUIRED','EXTERNAL_TOOL_REQUIRED'].includes(err.code)?['revise_task']:err.code==='EXTERNAL_TOOL_REQUIRED'?[a.task(err.taskId).steps.find(s=>!s.done)?.tool].filter(Boolean):['advance_task']};
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
   for(const source of sources.filter(s=>!oldIds.has(s.id)))try{const snap=JSON.parse(source.content);if(snap.operation==='identity')job.platformPrincipal=snap.data.username||null;}catch{}
   for(const source of sources.filter(s=>!oldIds.has(s.id)))try{
    const snap=JSON.parse(source.content),key=ledger.key(job,snap.query);
    job.executionState.operations[key]={id:require('node:crypto').randomUUID(),key,query:snap.query,epoch:ledger.epoch(job),principal:job.platformPrincipal||null,status:'done',sourceId:source.id,completedAt:source.lastCheckedAt||snap.queriedAt,attempt:1,migrated:true};
   }catch{}
   for(const run of [...a.data.agentRuns].reverse().filter(r=>r.jobId===job.id))for(const step of run.steps||[])if(step.tool==='platform_query')for(const row of step.result?.results||[]){
    if(!row.error||!row.query)continue;
    try{const key=ledger.key(job,row.query),old=job.executionState.operations[key],at=step.at||run.finishedAt||run.startedAt;
     if(old&&Date.parse(old.completedAt)>=Date.parse(at))continue;
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
function view(a,job){const s=job.executionState||{},operations=Object.values(s.operations||{}),waiting=operations.map(o=>({...ledger.eligibility(job,o),tool:o.query?.op})).filter(d=>d.action==='wait_until').sort((a,b)=>a.retryAt.localeCompare(b.retryAt));return {waiting:waiting[0]||null,unchangedReads:s.reusedReads||0,phases:tasks(a,job).map(t=>({taskId:t.id,title:t.title,stage:stage(a,t)})),lastProgress:s.lastProgress||null,lastAction:s.lastAction||null,next:s.forcedNext?.reason||null,recovery:s.recovery||null,openGaps:(s.gaps||[]).filter(g=>g.status==='open').length,closedGaps:(s.gaps||[]).filter(g=>g.status==='satisfied').length,reusedQueries:s.reusedQueries||0};}
module.exports={runnableActions,next,stage,context,error,recover,after,initialize,view,escape,verifyContent,contentBasis,requestHelp,answer};
