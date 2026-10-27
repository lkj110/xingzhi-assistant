'use strict';
// Product lifecycle only: no gold, synthetic completion check or forced status.
const path=require('node:path');
const fail=code=>Object.assign(Error(code),{code,automaticRetry:false});
async function advance(a,task,root,{fixed=false}={}){
 await a.dispatch('advance',{id:task.id});await a.runPromise;
 const job=a.data.delegations.find(j=>j.id===task.agentJobId),triggered=!!task.evidenceRequest;
 const acceptance=require(path.join(root,'desktop/acceptance.cjs'));
 if(!fixed&&job&&(triggered||acceptance.completionCandidate(a,job).ready&&!acceptance.currentCompletionCheck(a,job)))await require(path.join(root,'desktop/agent.cjs')).run(a,job.id);
 return {triggered,resolved:!task.evidenceRequest,jobStatus:job?.status,jobError:job?.lastError||null,completionChecked:!!job&&acceptance.currentCompletionCheck(a,job)};
}
async function accept(a,task,root){
 const job=a.data.delegations.find(j=>j.id===task.agentJobId);
 if(!job||!require(path.join(root,'desktop/acceptance.cjs')).currentCompletionCheck(a,job)||task.status!=='review')throw fail('EVAL_NOT_ACCEPTABLE');
 await a.dispatch('taskAction',{id:task.id,command:'accept'});
 if(task.status!=='completed')throw fail('EVAL_ACCEPT_FAILED');
}
async function revise(a,task,root,revision,{onPhase=()=>{},onTransition=()=>{}}={}){
 const initial=await advance(a,task,root);await onPhase('initial',initial);
 const job=a.data.delegations.find(j=>j.id===task.agentJobId);
 if(!job||!initial.completionChecked||task.status!=='review')throw fail('EVAL_INITIAL_NOT_ACCEPTABLE');
 await accept(a,task,root);await onTransition('acceptedInitial');
 await a.dispatch('updateTask',{id:task.id,description:revision.description,criteria:revision.criteria||task.criteria});
 if(task.status==='completed')throw fail('EVAL_REOPEN_FAILED');
 await onTransition('reopened');
 await a.dispatch('taskAction',{id:task.id,command:'revise',note:revision.note});
 await onTransition('revisionRequested');
 const changed=await advance(a,task,root);await onPhase('revision',changed);
 if(!changed.completionChecked||task.status!=='review')throw fail('EVAL_REVISION_NOT_ACCEPTABLE');
 await accept(a,task,root);await onTransition('acceptedRevision');
 return {initial,revision:changed};
}
module.exports={advance,accept,revise};
