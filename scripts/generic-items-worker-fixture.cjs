'use strict';
// Explicit controlled transport failures in the formal Worker. No production data.
const fs=require('node:fs'),{threadId}=require('node:worker_threads');
const agent=require('../desktop/agent.cjs'),ledger=require('../desktop/operation-ledger.cjs'),items=require('../desktop/evidence-item-lifecycle.cjs'),dispatch=require('../desktop/dispatch-lifecycle.cjs'),recovery=require('../desktop/evidence-recovery.cjs');
const policies=require('../desktop/access-policy-store.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
async function setup({Assistant,options,reportFile,scenario}){
 const deny=()=>{throw Error('Actual transport forbidden')},a=new Assistant({...options,chat:deny,connectorRequest:deny,webRequest:deny});a.tick=async()=>{};
 let record=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile)):null;
 if(!record){
  await a.dispatch('saveProvider',{name:'controlled fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:1,outputPrice:2});
  const job=agent.buildJob(a,{goal:'受控四项查询',dataPlatform:'sg-readonly'});a.data.delegations.push(job);job.platformPrincipal='controlled-user';ledger.state(job);
  policies.grant(a,{principalScope:{kind:'account',provider:'platform',subject:job.platformPrincipal},resourceScope:{kind:'platform',key:job.dataPlatform,jobId:job.id},operations:['platform_query']},{trusted:true,actor:'user_command',command:'controlled'});
  const task=a.createTask({title:'受控部分批次',criteria:'保留每项真实身份',steps:[{kind:'draft',title:'原稿'}]});Object.assign(task,{agentJobId:job.id,agentKey:'controlled',planVersion:1,workRevision:1});job.taskIds=[task.id];job.workRevision=1;
  const queries=Array.from({length:4},(_,i)=>({op:'code',taskId:String(123+i)})),episode={basis:'controlled-item-episode',taskId:task.id,intentBasis:require('../desktop/continuation-control.cjs').intentBasis(job,task),evidenceAcquisition:{requestBasis:'controlled-item-request',attempts:{}}};
  job.executionState.continuation={episodes:{[episode.basis]:episode},activeBasis:episode.basis};task.evidenceRequest={kind:'needs_evidence',basis:'controlled-item-request'};
  const run={id:'controlled-item-run',jobId:job.id,status:'running',startedAt:new Date().toISOString(),steps:[]},step={tool:'platform_query',args:{taskId:task.id,queries},at:new Date().toISOString()};a.data.agentRuns.push(run);a.activeAgentRun=run;
  dispatch.prepare(a,job,run,step,()=>{step.evidenceAcquisition={taskId:task.id,episodeBasis:episode.basis,requestBasis:task.evidenceRequest.basis,targets:queries.map(query=>({query,direction:null,obligationId:'controlled-item-obligation',rootIds:['123']}))};for(const n of step.evidenceAcquisition.targets){const attempt={...structuredClone(n),at:step.at};episode.evidenceAcquisition.attempts[require('../desktop/evidence-storage-method.cjs').attemptKey(n)]=attempt;items.claimInCommit(job,task,attempt,step);}});
  a.activeAgentJob=job;const spend=require('../desktop/spend.cjs'),budget=spend.scope(a);budget.limitUSD=200;budget.spentUSD=17;budget.heldUSD=3;budget.usage.unknownCalls=1;spend.persist(a);a.activeAgentJob=null;
  a.activeAgentRun=null;record={jobId:job.id,taskId:task.id,runId:run.id,episodeId:episode.basis,audit:{identity:0,business:[],models:0}};fs.writeFileSync(reportFile,JSON.stringify(record));
 }
 const job=a.data.delegations.find(j=>j.id===record.jobId),task=a.task(record.taskId),run=a.data.agentRuns.find(r=>r.id===record.runId),episode=job.executionState.continuation.episodes[record.episodeId],step=run.steps[0],attempts=()=>Object.values(episode.evidenceAcquisition.attempts);
 const saveAudit=()=>fs.writeFileSync(reportFile,JSON.stringify(record));
 a.platformRequest=async args=>{
  if(JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}))){record.audit.identity++;saveAudit();if(scenario==='identity')throw Object.assign(Error('controlled preflight timeout'),{code:'TRANSIENT'});return {username:'controlled-user'};}
  const id=step.args.queries.find(q=>JSON.stringify(args)===JSON.stringify(require('../desktop/data-platform.cjs').command(q)))?.taskId;if(!id)throw Error('Unexpected controlled query');record.audit.business.push(id);saveAudit();
  if(id==='125')throw Object.assign(Error('controlled transport interruption'),{code:'ABORTED',dispatchFailure:true});
  return {taskId:Number(id),sql:'SELECT confirmed_value FROM controlled_input'};
 };
 const observe=()=>({threadId,audit:record.audit,attempts:structuredClone(attempts()),phases:attempts().map(v=>items.inspect(a,job,v).phase),candidates:step.args.queries.map(q=>items.candidate(a,job,task,q).action),operations:Object.values(job.executionState.operations).map(o=>({id:o.id,status:o.status,sourceId:o.sourceId,requests:o.requests})),sources:job.sourceIds.slice(),pendingSourceIds:episode.evidenceAcquisition.pendingPlan?.sourceIds||[],ledger:hash(a.spendLedger),history:hash(job.executionState.history||[]),preflights:Object.values(job.executionState.identityPreflights||{}).flat()});
 const ordinary=a.dispatch.bind(a);a.dispatch=async(action,input)=>{
  if(action==='controlledItemObserve')return observe();
  if(action==='controlledItemRun'){
   a.activeAgentJob=job;a.activeAgentRun=run;run.status='running';delete run.finishedAt;let code=null;
   try{await agent.act(a,job,'platform_query',step.args);}catch(e){code=e.code;step.error=e.message;step.errorCode=e.code;run.status='interrupted';run.finishedAt=new Date().toISOString();}
   recovery.settled(a,job,task,episode,step);a.save();a.activeAgentJob=null;a.activeAgentRun=null;return {...observe(),code};
  }
  if(action==='controlledItemRetryUnknown'){
   const before=observe();let code=null;try{await ledger.fetch(a,job,step.args.queries[2],{batch:await ledger.prepareBatch(a,job),retry:true});}catch(e){code=e.code;}return {before,after:observe(),code};
  }
  if(action==='controlledItemRetryIdentity'){let code=null;try{await ledger.prepareBatch(a,job);}catch(e){code=e.code;}return {...observe(),code};}
  return ordinary(action,input);
 };
 return a;
}
module.exports={setup};
