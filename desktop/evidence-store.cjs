// Shared resource/version relationships. Never merge across projects or copied scopes.
const basis=require('./evidence-basis.cjs');
function sameScope(a,b){return !!a&&!!b&&(a.projectId||null)===(b.projectId||null)&&!a.copiedFrom&&!b.copiedFrom;}
function ancestors(data,source){
 const ids=[],seen=new Set([source.id]);let id=source.previousSourceId;
 while(id&&!seen.has(id)){seen.add(id);const previous=data.sources.find(s=>s.id===id);if(!sameScope(source,previous))break;if((source.resourceKey||source.identity)&&(previous.resourceKey||previous.identity)&&basis.sourceKey(source)!==basis.sourceKey(previous))break;ids.push(id);id=previous.previousSourceId;}
 return ids;
}
function current(data,source){
 return require('./projection-cache.cjs').memo(current,[data,source],()=>currentSource(data,source));
}
function currentSource(data,source){
 const descendants=data.sources.filter(s=>sameScope(s,source)&&!s.projectExcluded&&ancestors(data,s).includes(source.id));
 const heads=descendants.filter(s=>!descendants.some(n=>n.previousSourceId===s.id));
 return heads.length===1?heads[0]:heads.length?null:source;
}
function capabilityKey(job,args){return 'capability-resource:'+basis.hash({projectId:job.projectId||null,jobId:job.id,capabilityId:args.capabilityId,tool:args.tool,input:args.input||{}});}
function observe(source,record){
 source.lastCheckedAt=new Date().toISOString();source.lastObservationId=record.recordId;
 source.capabilityVersion=record.usedVersion;
}
function migrate(a){
 // Old exact parameters are recovered only from a retained run; otherwise keep the source separate.
 for(const run of [...(a.data.agentRuns||[])].reverse())for(const step of run.steps||[]){
  if(step.tool!=='capability_call'||!step.result?.sourceId||!step.args?.capabilityId)continue;
  const job=a.data.delegations.find(j=>j.id===run.jobId),s=a.data.sources.find(s=>s.id===step.result.sourceId);
  if(!job||!s||s.capabilityId!==step.args.capabilityId)continue;
  s.resourceKey=capabilityKey(job,require('./capabilities.cjs').normalizeArguments(a,step.args));
 }
}
function reconcile(a){
 for(const source of a.data.sources||[])if(source.deleted||source.projectExcluded)require('./source-observations.cjs').close(a,{sourceId:source.id},source.deleted?'来源已删除':'来源已撤回');
 for(const job of a.data.delegations||[])for(const f of job.followups||[]){
  if(f.status!=='resolved'||!f.sourceId)continue;
  const source=a.data.sources.find(s=>s.id===f.sourceId),latest=source&&current(a.data,source);
  if(!source||!latest)require('./agent-followup.cjs').invalidateEvidence(a,job,{id:f.sourceId,projectId:job.projectId,deleted:true});
  else if(latest.id!==source.id||latest.deleted||latest.projectExcluded)require('./agent-followup.cjs').invalidateEvidence(a,job,latest);
 }
}
function changed(a,job,source){
 if(!require('./source-observations.cjs').allows(a,source,{channel:'evidence_changed',scope:{projectId:job.projectId||null,jobId:job.id}}))return;
 const replaced=ancestors(a.data,source);if(!replaced.length)return;
 require('./agent-followup.cjs').invalidateEvidence(a,job,source);
 for(const id of job.taskIds||[]){const task=a.task(id);if(task.deletedAt||task.sourceIds.includes(source.id))continue;
  const old=task.sourceIds.filter(id=>replaced.includes(id));if(!old.length)continue;
  const affected=old.some(id=>basis.relevantChange(a.data.sources.find(s=>s.id===id),source,task,job));
  task.sourceIds=[...new Set([...task.sourceIds,source.id])];task.supersededSourceIds=[...new Set([...(task.supersededSourceIds||[]),...old])];
  if(affected){task.needsReplan='引用材料内容已变化，请核对相关计划与产出';a.requeue(task);require('./agent-plan.cjs').invalidateDependents(a,task);}
 }
}
module.exports={changed,sameScope,ancestors,current,capabilityKey,observe,migrate,reconcile};
