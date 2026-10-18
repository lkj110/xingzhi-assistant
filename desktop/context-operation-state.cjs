// Operation-local consistency fence. No state, permissions or bodies survive an
// operation. Keep the fields consumed by task-context/evidence-links here; omit
// audit histories and saved read bodies, which can dwarf the actual catalog.
const pick=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row[key]]));
const taskKeys='id agentJobId projectId deletedAt agentCancelled archivedAt status sourceIds supersededSourceIds contextBindings contextWithdrawals withdrawnBindingIds steps workRevision requirementRevision criteria objective notes userRequirement'.split(' ');
const jobKeys='id projectId ruleId taskIds sourceIds deletedAt archivedAt status workRevision requirementRevision executionContract goal userDirectives feedback'.split(' ');
const objectKeys='id taskId jobId agentJobId projectId title stepId content segments coverage resourceKey identity url remoteId revisionId remoteRevision version principalScope platformPrincipal larkOpenId previousSourceId copiedFrom purpose deliveryActionId deleted deletedAt withdrawn withdrawnAt projectExcluded contentDeleted state retention fullContentHash platformSnapshot platformArchive'.split(' ');
const actionKeys='id taskId jobId artifactId status effectStatus presentationStatus workRevision content principalScope larkOpenId tenantId resourceKey target deliveryConflict tool'.split(' ');
function state(a){
 const d=a.data;
 return {
  tasks:(d.tasks||[]).map(r=>pick(r,taskKeys)),delegations:(d.delegations||[]).map(r=>pick(r,jobKeys)),
  sources:(d.sources||[]).map(r=>pick(r,objectKeys)),artifacts:(d.artifacts||[]).map(r=>pick(r,objectKeys)),
  agentActions:(d.agentActions||[]).map(r=>({...pick(r,actionKeys),result:r.result&&pick(r.result,['sourceId','verified','revision','url','resourceKey','principalScope'])})),
  projects:(d.projects||[]).map(r=>pick(r,['id','jobId','archivedAt'])),
  workRules:(d.workRules||[]).map(r=>({id:r.id,projectId:r.config?.projectId})),sourceDeletions:d.sourceDeletions||[]
 };
}
function freeze(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value;
}
module.exports={state,freeze};
