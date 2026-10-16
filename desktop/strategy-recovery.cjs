// Deterministic recovery chooses executable alternatives. It never grants access,
// resets spend, accepts a gap, or retries an uncertain external side effect.
const work=require('./work-efficiency.cjs');
const evidence=require('./evidence-basis.cjs');
const control=require('./execution-control.cjs');
const ledger=require('./operation-ledger.cjs');
const diagnostics=require('./recovery-diagnostics.cjs');
// A changing query ID is not a new recovery method. Bound exploration under
// the same task input basis so a large catalog cannot starve verification,
// delivery, or the planner that must reconcile newly acquired evidence.
const MAX_BOUNDARY_ATTEMPTS=3;
const now=()=>new Date().toISOString();
const tasks=(a,j)=>a.data.tasks.filter(t=>j.taskIds.includes(t.id)&&t.agentJobId===j.id&&!t.deletedAt&&!t.agentCancelled);
function inputBasis(a,job){
 const snap=work.snapshot(a,job);
 return evidence.hash({intent:snap.intent,inputs:snap.facts.filter(f=>f.startsWith('evidence:')),diagnostics:tasks(a,job).map(t=>({taskId:t.id,...diagnostics.basis(a,job,t)})),
  scopes:tasks(a,job).map(t=>({taskId:t.id,policies:require('./task-context.cjs').buildContext(a,require('./task-context.cjs').taskScope(t)).readableCatalog.filter(r=>r.purpose==='input').map(r=>[r.resourceKey,r.policyRevision]).sort()}))});
}
function actionKey(a,action){
 let args=action.args||{};
 if(action.tool==='capability_call')args=require('./capabilities.cjs').normalizeArguments(a,args);
 const normalized=ledger.normalize(action.tool,args);
 // Rephrasing repair instructions is not an alternative execution path.
 if(['revise_task','plan_task'].includes(action.tool))return evidence.hash({tool:action.tool,taskId:args.taskId||args.existingTaskId||args.key});
 return evidence.hash(normalized);
}
function gaps(task){return [...new Set([...(task.contentVerification?.passed===false?task.contentVerification.gaps||[]:[]),...(task.verification?.passed===false?task.verification.gaps||[]:[]),...(task.autoRepair?.check?.gaps||[])])].slice(0,20);}
function candidates(a,job){
 const permitted=new Set(require('./work-state.cjs').runnableActions(a,job).map(r=>r.taskId));
 const active=tasks(a,job).filter(t=>permitted.has(t.id)),result=[];
 const add=(id,title,instruction,queue)=>result.push({id,title,instruction,queue});
 const diagnose=active.filter(t=>t.needsReplan||diagnostics.planning(a,job,t));
 if(diagnose.length)return diagnose.map(t=>({id:'diagnose:'+t.id,title:'按检查缺口补证并协调主稿',instruction:'needsReplan 非空时先依据最新用户补充或决定修正计划，不先查询旧边界。处理当前 contentVerification 和 evidenceRequest 的具体缺口。缺新事实时使用已授权工具；稿件绑定错误时用 plan_task 明确 primaryArtifactId 与步骤 outputRole/targetArtifactId。辅助检查报告不能替代业务主稿。查询结果关联到事项后再推进；不要复述旧计划、重写缺证清单或查询已接受的权限边界。',queue:[],planning:true}));
 for(const task of active){
  if(task.needsReplan)continue;
  const phase=control.stage(a,task),step=task.steps.find(s=>!s.done),artifact=require('./deliverables.cjs').primary(a,task),missing=gaps(task);
  const advance={tool:'advance_task',args:{taskId:task.id},reason:'自动纠偏：使用已保存原文与当前步骤直接生成或检查，不重复扫描目录'};
  const invalidRevision=job.executionState?.workEfficiency?.lastFailure?.code==='MODEL_INVALID_RESPONSE'&&step&&a.data.artifacts.some(r=>r.taskId===task.id&&r.stepId===step.id&&r.content?.trim());
  if(!invalidRevision&&['work','verify','repair'].includes(phase))add('cached:'+task.id,'复用材料直接完成当前步骤','所需已读正文保存在 generationEvidence/contextReads。先使用现有证据完成当前步骤；确实缺少内容才读取尚未提供的范围。不要重复请求已完整提供的正文。',[advance]);
  if(step&&['analysis','draft'].includes(step.kind)&&a.data.artifacts.some(r=>r.taskId===task.id&&r.stepId===step.id&&r.content?.trim()))add('full_rewrite:'+task.id,'改用完整稿修订','片段修改或重复生成未成功，改为在已保存原稿上一次生成完整修订稿，再按原标准检查。',[{...advance,reason:'自动纠偏：改用完整稿修订，跳过反复失败的精确片段匹配'}]);
  const repairTarget=require('./revision-protocol.cjs').target(a,task,task.contentVerification?.passed===false?task.contentVerification:task.verification||task.autoRepair?.check);
  if(missing.length&&repairTarget){
   const note='自动纠偏：逐项把检查缺口映射到原文，实质修改对应段落并保留其他事实。不能降低完成标准、扩大权限或把未知写成已核实。\n'+missing.join('\n');
   add('repair:'+task.id,'针对检查缺口修改原稿',note,[{tool:'revise_task',args:{taskId:task.id,artifactId:repairTarget.id,note},reason:'自动纠偏：改为逐项修复具体缺口，不再检查相同旧稿'}]);
  }
  if(phase==='deliver'&&artifact){
   if(task.contentVerification?.basis!==control.contentBasis(a,job,task))add('check:'+task.id,'先核对现有稿件','只核对当前稿件与用户标准；外部交付由后续工具执行。',[{tool:'verify_content',args:{taskId:task.id},reason:'自动纠偏：停止读取状态，核对现有稿件'}]);
   else if(task.contentVerification.passed&&['write_file','lark_create','lark_update','github_create'].includes(step.tool))add('deliver:'+task.id+':'+step.tool,'完成当前已核验交付','沿用当前文稿、原目标和已有授权，执行当前外部步骤。',[{tool:step.tool,args:{taskId:task.id},reason:'自动纠偏：稿件内容已通过检查，执行尚未完成的交付'}]);
  }
 }
 // Complete/check the current step before generic exploration. Content and
 // external-action gates above still apply; this order does not permit an
 // unverified draft to be delivered.
 if(job.dataPlatform==='sg-readonly')for(const b of require('./work-obligations.cjs').frontier(a,job).filter(b=>b.status==='unexpanded'&&b.scopeProven===true).slice(0,10)){
  add('boundary:'+evidence.hash(b.query),'改查尚未展开的证据边界','只查询当前未满足要求的边界，沿用已有查询；失败和权限缺口不得冒充查完。',[{tool:'platform_query',args:{queries:[b.query]},reason:'自动纠偏：改查尚未展开的边界，跳过重复目录读取'}]);
 }
 return result;
}
function publish(job,state,message){
 ledger.state(job).recovery={code:'AUTOMATIC_STRATEGY_REPAIR',message,at:now(),strategy:state.active?.title||null};
 job.summary=message;job.lastError='';delete job.lastErrorCode;delete job.lastErrorAutomaticRetry;
}
function schedule(a,job,error){
 if(a.controller?.signal.aborted||!require('./work-state.cjs').gate(a,job).automaticAllowed)return false;
 if(require('./projects.cjs').relatedActions(a,job).some(r=>['running','uncertain','pending'].includes(r.status)))return false;
 const task=tasks(a,job).find(t=>t.id===error.recoveryContext?.taskId);
 if(error.code==='MODEL_INVALID_RESPONSE'&&task?.status==='blocked'&&task.lastError===error.message)task.status='todo';
 work.request(a,job,error);delete ledger.state(job).forcedNext;
 if(error.code==='MODEL_INVALID_RESPONSE'&&error.recoveryContext?.stage==='task_work'&&task&&a.data.artifacts.some(r=>r.taskId===task.id&&r.content?.trim())){
  const s=job.executionState.workEfficiency;
  s.tried[inputBasis(a,job)+':cached:'+task.id]={at:now(),title:'原片段修订路径',outcome:'excluded',reason:'同一输入的原生成路径已连续返回无效结构'};
 }
 job.status='ready';job.nextRunAt=now();job.retryCheck=false;job.failures=0;
 publish(job,job.executionState.workEfficiency,'正在自动纠偏：诊断重复原因，切换执行方式后继续推进');
 a.event('已转入自动纠偏',error.message,null);return true;
}
function invalidOutput(a,job,error){
 if(error?.modelFailure!==true||error.code!=='MODEL_INVALID_RESPONSE'||error.automaticRetry!==true)return false;
 // A failed alternative is consumed, including malformed planner responses that
 // have no task context. Replaying it would renew the same paid recovery route.
 if(job.executionState?.workEfficiency?.phase==='recovering'&&job.executionState.workEfficiency.active)return schedule(a,job,error);
 const task=tasks(a,job).find(t=>t.id===error.recoveryContext?.taskId),stage=error.recoveryContext?.stage;
 if(!task||!['task_work','task_verify'].includes(stage))return false;
 const key=evidence.hash({task:task.id,stage,basis:require('./acceptance.cjs').basis(a,task)}),records=ledger.state(job).invalidOutputs ||= {};
 records[key]={count:(records[key]?.count||0)+1,at:now(),taskId:task.id,stage};
 if(records[key].count<2)return false;
 return schedule(a,job,error);
}
function begin(a,job){
 const {state}=work.sync(a,job);
 if(state.phase!=='recovery_pending')return true;
 if(!require('./work-state.cjs').gate(a,job).automaticAllowed)return false;
 if(require('./projects.cjs').relatedActions(a,job).some(r=>['running','uncertain','pending'].includes(r.status)))return false;
 const allowed=require('./work-state.cjs').runnableActions(a,job);
 if(!allowed.length&&require('./work-state.cjs').blockingReasons(a,job).length){job.status=require('./work-state.cjs').blockingReasons(a,job).some(r=>r.needsHuman)?'needs_input':'watching';return false;}
 const basis=inputBasis(a,job),key=id=>basis+':'+id;
 const boundaryAttempts=Object.keys(state.tried).filter(k=>k.startsWith(key('boundary:'))).length;
 let strategy=candidates(a,job).find(c=>!state.tried[key(c.id)]&&(!c.id.startsWith('boundary:')||boundaryAttempts<MAX_BOUNDARY_ATTEMPTS));
 if(!strategy&&!state.tried[key('replan')])strategy={id:'replan',title:'重新诊断并选择其他工具',instruction:'此前方法没有进展。根据当前未满足要求、工具回执和已尝试策略，选择一条不同的可执行动作；不要重复已失败的工具请求，不要要求用户只确认继续。若边界查询已有新来源但尚未关联到事项，先核对其与用户范围的关系，再一次性纳入对应事项并继续当前步骤；不把来源数量增长当作业务缺口关闭，不继续机械遍历历史目录。可以调整内部步骤，但保留用户目标、完成标准、已接受边界、权限和预算。只有无法通过授权工具取得的具体信息、权限或人工动作才 ask/request_access。',queue:[],planning:true};
 if(!strategy){
  const attempted=[...new Set(state.history.map(h=>h.title))];
  state.phase='awaiting_change';state.waitBasis=basis;state.blocker={code:'NO_EXECUTABLE_ALTERNATIVE',attempted,lastFailure:state.lastFailure,at:now()};
  job.status='blocked';job.nextRunAt=null;job.retryCheck=false;
  publish(job,state,'自动纠偏未找到可执行的新路径：已尝试'+attempted.join('、')+'。最后原因：'+(state.lastFailure?.message||'未取得新的有效结果')+'。相关材料、权限或执行条件变化后自动重新评估。');
  a.event('自动纠偏需要新的执行条件',job.summary,null,'warning');return false;
 }
 state.tried[key(strategy.id)]={at:now(),title:strategy.title};
 state.active={...strategy,basis,startedAt:now(),reads:0};state.phase='recovering';
 publish(job,state,'正在自动纠偏：'+strategy.title);a.event('已切换推进策略',strategy.title,null);return true;
}
function next(a,job){
 const state=job.executionState?.workEfficiency;
 if(state?.phase!=='recovering'||!state.active)return null;
 const response=state.active.queue.shift();
 if(response?.tool==='advance_task'){
  const task=tasks(a,job).find(t=>t.id===response.args.taskId),step=task?.steps.find(s=>!s.done);
  if(!task||task.needsReplan||task.evidenceRequest||step?.kind==='external'){
   state.active.queue=[];state.active.planning=true;return null;
  }
 }
 if(response)return {...response,controlled:true,strategyRecovery:true};
 return null;
}
function planning(job){return job.executionState?.workEfficiency?.phase==='recovering'&&job.executionState.workEfficiency.active?.planning===true;}
function acceptPlan(a,job,response){
 if(!planning(job))return;
 const state=job.executionState.workEfficiency,key=actionKey(a,response),past=state.history.filter(h=>h.basis===state.active.basis).flatMap(h=>h.actionKeys||[]);
 if(past.includes(key)||['read_output_state','platform_inventory','read_work_state'].includes(response.tool))throw Object.assign(Error('纠偏规划仍选择已失败的路径或重复状态读取，需要改换执行方式'),{noProgress:true,code:'RECOVERY_ROUTE_REPEATED'});
 // Follow-ups are selected only after the action commits, never on intent.
}
function settled(a,job,step,{planInputInvalid=false}={}){
 const state=job.executionState?.workEfficiency,active=state?.phase==='recovering'&&state.active;
 if(!active)return;
 if(step.error){
  active.queue=[];
  // An uncommitted malformed plan is not an exhausted business strategy.
  // Allow at most two corrections in this recovery attempt, never queue work
  // on failure and never extend this allowance for access/side-effect errors.
  const correctable=step.tool==='plan_task'&&planInputInvalid&&step.errorCode==='PLAN_INPUT_INVALID';
  active.planning=correctable&&(active.inputCorrections||0)<2;
  if(active.planning){
   active.inputCorrections=(active.inputCorrections||0)+1;
   active.instruction='上次 plan_task 在提交前因参数无效被拒，尚未修改计划。请只修正工具指出的字段后重提，不能改权限或降低验收标准；不要重复查询或直接 advance_task。\n'+step.error;
  }
  return;
 }
 if(['revise_task','plan_task'].includes(step.tool)){
  const taskId=step.result?.taskId||step.args.taskId||step.args.existingTaskId,task=tasks(a,job).find(t=>t.id===taskId);
  active.queue=[];
  if(task&&!task.needsReplan&&!task.evidenceRequest&&!diagnostics.planning(a,job,task)){
   const next=task.steps.find(s=>!s.done);
   if(!next||['analysis','draft'].includes(next.kind))active.queue.push({tool:'advance_task',args:{taskId},reason:'自动纠偏：已提交计划，完成当前文本或检查步骤'});
  }
  active.planning=!active.queue.length;
 }else if(step.result?.evidenceRequest){active.queue=[];active.planning=true;}
}
function started(a,job,step){const s=job.executionState?.workEfficiency;if(s?.active){s.active.actionKeys ||= [];s.active.actionKeys.push(actionKey(a,step));s.active.executedActions=[...(s.active.executedActions||[]),{tool:step.tool,args:structuredClone(step.args)}].slice(-6);s.active.inFlight={tool:step.tool,taskId:step.args?.taskId||null,at:now()};step.strategyRecovery={id:s.active.id,title:s.active.title};}}
function plannerStarted(a,job){if(planning(job)){job.executionState.workEfficiency.active.inFlight={tool:'planner',at:now()};a.save();}}
function ready(a,job){
 const state=job.executionState?.workEfficiency;
 if(state?.phase!=='awaiting_change')return true;
 const newlySaved=tasks(a,job).some(t=>t.steps.some(step=>{
  if(!step.done)return false;
  const artifact=a.data.artifacts.find(r=>r.id===step.artifactId&&r.taskId===t.id&&!r.stale);
  const saved=artifact&&(artifact.origin==='user_import'||step.outputHash===evidence.hash(artifact.content)&&step.inputBasis?.hash===require('./step-evidence.cjs').snapshot(a,t,step).hash);
  return saved&&!state.seen.includes('artifact:'+evidence.hash(artifact.content));
 }));
 if(newlySaved){const result=work.sync(a,job);if(result.changed){job.status='ready';job.nextRunAt=now();return true;}}
 if(state.waitBasis===inputBasis(a,job))return false;
 work.request(a,job,{message:'相关证据或执行条件已变化，自动重新评估可用路径'});
 job.status='ready';job.nextRunAt=now();return true;
}
module.exports={begin,next,planning,acceptPlan,settled,started,plannerStarted,schedule,invalidOutput,ready,inputBasis,candidates};
