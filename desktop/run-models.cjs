// Keep the models actually invoked with the run, independently of recent-call retention.
const fields=['id','at','taskId','runId','spendScope','spendTicketId','providerId','providerName','providerType','model','reasoning','role','stage','status','requestId','attempt','fallbackFrom','errorCode','errorMessage','diagnostic','producerSchema','inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','cacheWrite1hTokens','totalTokens','usageReported','estimatedUSD','routing','pricing'];
const snapshot=row=>Object.fromEntries(fields.filter(k=>row[k]!==undefined).map(k=>[k,structuredClone(row[k])]));
function initialize(a){
  const calls=a.data.modelCalls||[],agentRuns=a.data.agentRuns||[];
  const byId=new Map(calls.map(c=>[c.id,c]));
  const taskRuns=(a.data.tasks||[]).flatMap(t=>(t.progressRuns||[]).map(run=>({run,taskId:t.id})));
  const within=(call,run)=>Number.isFinite(Date.parse(run.startedAt))&&Number.isFinite(Date.parse(run.finishedAt))&&Date.parse(call.at)>=Date.parse(run.startedAt)&&Date.parse(call.at)<=Date.parse(run.finishedAt);
  for(const run of agentRuns){
    if(Array.isArray(run.modelCallsDetail))continue;
    run.modelCallsDetail=calls.filter(c=>c.runId===run.id||(!c.runId&&c.jobId===run.jobId&&within(c,run)&&agentRuns.filter(r=>r.jobId===c.jobId&&within(c,r)).length===1)).reverse().map(snapshot);
    run.modelUsageSource='legacy';
  }
  for(const {run,taskId} of taskRuns){
    if(Array.isArray(run.modelCallsDetail))continue;
    run.modelCallsDetail=calls.filter(c=>c.taskRunId===run.id||c.runId===run.id||(!c.taskRunId&&c.taskId===taskId&&within(c,run)&&taskRuns.filter(r=>r.taskId===taskId&&within(c,r.run)).length===1)).reverse().map(snapshot);
    run.modelUsageSource='legacy';
  }
  for(const run of [...agentRuns,...taskRuns.map(r=>r.run)])for(const call of run.modelCallsDetail){
    // Restore only metadata from the exact historical call; never reroute or
    // reprice a past request using today's configuration.
    const original=call.id&&byId.get(call.id);
    if(original)for(const key of ['routing','pricing','cacheWriteTokens','cacheWrite1hTokens'])if(call[key]===undefined&&original[key]!==undefined)call[key]=structuredClone(original[key]);
    if(call.status==='running')call.status='interrupted';
  }
  for(const {run} of taskRuns)if(!run.finishedAt){run.finishedAt=new Date().toISOString();run.status='interrupted';}
}
function start(row,runs){
  const entries=[...new Set(runs.filter(Boolean))].map(run=>{const entry=snapshot(row);(run.modelCallsDetail||=[]).push(entry);return entry;});
  return ()=>entries.forEach(entry=>Object.assign(entry,snapshot(row)));
}
module.exports={initialize,start};
