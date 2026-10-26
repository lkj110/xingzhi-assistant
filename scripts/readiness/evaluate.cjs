'use strict';
// Shared case driver for both frozen implementations. Transport, authorization,
// immutable case seals and the append-only call ledger are injected by the run.
// This module neither reads gold labels nor opens a model connection.
const path=require('node:path'),{createHash}=require('node:crypto'),lifecycle=require('./lifecycle.cjs');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function snapshot(a,task,root,phase,records,{fixed=false}={}){
 const job=a.data.delegations.find(j=>j.id===task.agentJobId),artifact=require(path.join(root,'desktop/deliverables.cjs')).primary(a,task),calls=records.filter(r=>r.phase===phase);
 const checks=calls.filter(r=>r.role==='verify'&&r.stage!=='goal_verify'&&r.status==='completed'),goals=calls.filter(r=>r.stage==='goal_verify'&&r.status==='completed');
 const verification=structuredClone(task.verification||null),grounding=structuredClone(task.grounding||null),completionCheck=structuredClone(job?.completionCheck||null);
 const acceptance=require(path.join(root,'desktop/acceptance.cjs'));
 const groundingAPI=require(path.join(root,'desktop/grounding.cjs')),evidence=require(path.join(root,'desktop/evidence-basis.cjs'));
 let currentTaskCheck=false;
 try{currentTaskCheck=acceptance.currentBasis(a,task)&&grounding?.version===groundingAPI.VERSION&&grounding.basis===groundingAPI.snapshot(a,task).basis&&grounding.reportHash===evidence.hash({...grounding,reportHash:undefined});}catch{}
 const completeCheck=checks.length>0&&typeof verification?.passed==='boolean'&&typeof grounding?.passed==='boolean'&&currentTaskCheck;
 const goalComplete=goals.length>0&&typeof completionCheck?.passed==='boolean'&&completionCheck.basis===acceptance.completionBasis(a,job);
 const goalPassed=!!job&&acceptance.currentCompletionCheck(a,job);
 const taskPassed=completeCheck&&verification.passed===true&&grounding.passed===true&&task.status==='review';
 const usageKnown=calls.every(r=>['completed','failed'].includes(r.status)&&['inputTokens','outputTokens'].every(k=>Number.isSafeInteger(r.usage?.[k])&&r.usage[k]>=0));
 const technicalError=!usageKnown?'EVAL_USAGE_UNKNOWN':!completeCheck?'EVAL_TASK_CHECK_INCOMPLETE':!fixed&&taskPassed&&!goalComplete?'EVAL_GOAL_CHECK_INCOMPLETE':null;
 return {phase,taskStatus:task.status,candidateTitle:artifact?.title||null,candidate:artifact?.content||null,candidateHash:hash({title:artifact?.title||null,content:artifact?.content||null}),verification,grounding,completionCheck,completeCheck,taskPassed,goalComplete,goalPassed,technicalError,usageKnown,attemptFailures:calls.filter(r=>r.status==='failed').map(r=>({id:r.id??r.index,code:r.code||null})),delivered:taskPassed&&(fixed||goalPassed),taskCheckCallIds:checks.map(r=>r.id??r.index),goalCheckCallIds:goals.map(r=>r.id??r.index),toolEvidence:structuredClone(task.toolEvidence||[]),toolExecutions:structuredClone(task.toolExecutions||[]),callCount:calls.length};
}
async function run({a,task,root,lane,revision,records,setPhase=()=>{}}){
 if(!['fixed','e2e','revision'].includes(lane))throw Error('Invalid readiness lane');
 const phases=[],transitions=[],recordStart=records.length;let phase='initial',exception=null;setPhase(phase);
 const capture=(name,handoff)=>{phases.push({...snapshot(a,task,root,name,records.slice(recordStart),{fixed:lane==='fixed'}),handoff});};
 const transition=name=>{transitions.push({name,at:new Date().toISOString(),status:task.status,artifactHash:hash(require(path.join(root,'desktop/deliverables.cjs')).primary(a,task)),verificationHash:hash(task.verification||null),groundingHash:hash(task.grounding||null)});if(name==='acceptedInitial'){phase='revision';setPhase(phase);}};
 try{
  if(lane==='revision')await lifecycle.revise(a,task,root,revision,{onPhase:capture,onTransition:transition});
  else {const result=await lifecycle.advance(a,task,root,{fixed:lane==='fixed'});capture(phase,result);if(lane==='e2e'){await lifecycle.accept(a,task,root);transition('acceptedFinal');}}
 }catch(error){exception={code:error.code||'EVAL_RUNNER_ERROR',message:error.message};}
 // Interrupted/limited phases are retained even when advance itself throws.
 if(!phases.some(p=>p.phase===phase))capture(phase,null);
 const rejected=['EVAL_NOT_ACCEPTABLE','EVAL_INITIAL_NOT_ACCEPTABLE','EVAL_REVISION_NOT_ACCEPTABLE'].includes(exception?.code);
 const technicalError=phases.find(p=>p.technicalError)?.technicalError||(exception&&!rejected?exception.code:null);
 return {lane,phases,transitions,exception,technicalError,procedureComplete:!exception&&!technicalError&&(lane==='fixed'?phases[0].completeCheck:task.status==='completed'),delivered:!exception&&!technicalError&&!!phases.at(-1)?.delivered};
}
module.exports={run,snapshot};
