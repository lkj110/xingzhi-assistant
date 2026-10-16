// Independent work shares durable data, never its cancellation or accounting context.
const root=a=>a.executionOwner||a;
const localKeys=new Set(['controller','activeAgentJob','activeAgentRun','activeSpendTask','activeSpendRun','automaticExecution']);
function initialize(a){
  a.executions=new Map();a.writeExecutions=new Map();
  Object.defineProperty(a,'operation',{configurable:true,get(){
    if(this.exclusiveOperation)return this.exclusiveOperation;
    const rows=snapshot(this);if(!rows.length)return null;
    return {...rows[0],parallel:true,count:rows.length,label:rows.length===1?rows[0].label:`${rows.length} 项工作并行推进`};
  },set(value){this.exclusiveOperation=value;}});
  Object.defineProperty(a,'runPromise',{configurable:true,get(){
    const work=[this.exclusivePromise,...[...this.executions.values()].map(r=>r.promise)].filter(Boolean);
    return work.length?Promise.all(work):null;
  },set(value){this.exclusivePromise=value;}});
}
function snapshot(a){return [...(root(a).executions?.values()||[])].map(({key,label,startedAt,jobId,taskId,projectId})=>({key,label,startedAt,jobId,taskId,projectId}));}
function scope(a,{jobId,taskId,projectId}={}){
  const task=taskId&&(a.data.tasks||[]).find(t=>t?.id===taskId);jobId ||= task?.agentJobId;
  const job=jobId&&(a.data.delegations||[]).find(j=>j?.id===jobId);projectId ||= job?.projectId||task?.projectId;
  const key=jobId?`job:${jobId}`:taskId?`task:${taskId}`:null;
  return {key,jobId:jobId||null,taskId:taskId||null,projectId:projectId||null};
}
function conflict(a,input){
  const owner=root(a),s=scope(owner,input);
  if(owner.exclusiveOperation)return owner.exclusiveOperation;
  if(!owner.executions&&owner.operation)return owner.operation;
  return [...(owner.executions?.values()||[])].find(r=>r.key===s.key||s.projectId&&r.projectId===s.projectId);
}
function assertIdle(a,input){
  if(conflict(a,input))throw Error('此事项或所属项目正在推进，请等待本轮结束；其他独立事项可并行执行');
}
function launch(a,input,label,callback){
  const owner=root(a),s=scope(owner,input);if(!s.key)throw Error('并行推进需要明确的事项或委托');
  assertIdle(owner,s);
  const context={automaticExecution:input.automatic===true,controller:new AbortController(),activeAgentJob:null,activeAgentRun:null,activeSpendTask:null,activeSpendRun:null};
  const view=new Proxy(owner,{get(target,key,receiver){if(key==='executionOwner')return owner;if(localKeys.has(key))return context[key];return Reflect.get(target,key,receiver);},set(target,key,value){if(localKeys.has(key)){context[key]=value;return true;}return Reflect.set(target,key,value);}});
  const row={...s,label,startedAt:new Date().toISOString(),context};owner.executions.set(s.key,row);
  row.promise=Promise.resolve().then(()=>{context.controller.signal.throwIfAborted();return callback(view);}).catch(error=>{
    owner.event('本轮处理未完成',error.message,s.taskId,'error');
  }).finally(()=>{if(owner.executions.get(s.key)===row)owner.executions.delete(s.key);owner.save();});
  try{owner.save();}catch(error){context.controller.abort();owner.executions.delete(s.key);throw error;}
  return owner.publicState();
}
function abortJob(a,id){const owner=root(a);owner.executions?.get(`job:${id}`)?.context.controller.abort();if(owner.activeAgentJob?.id===id)owner.controller?.abort();}
function abortAll(a){const owner=root(a);owner.controller?.abort();for(const row of owner.executions?.values()||[])row.context.controller.abort();}
function jobActive(a,id){return root(a).executions?.has(`job:${id}`)||root(a).activeAgentJob?.id===id;}
function maintenanceDue(a){
  const active=id=>require('./project-lifecycle.cjs').isActive(a.data,id),due=time=>time&&Date.parse(time)<=Date.now();
  if((a.data.captureQueue||[]).some(r=>active(r.projectId)&&(r.status==='queued'||r.status==='failed'&&r.autoRetry?.enabled&&r.autoRetry.retryable&&due(r.autoRetry.nextRetryAt))))return true;
  if(['connectors','feedConnections','webConnections'].some(key=>(a.data[key]||[]).some(c=>c.enabled&&active(c.projectId)&&due(c.nextRunAt))))return true;
  if((a.data.workRules||[]).some(r=>r.status==='enabled'&&active(r.config.projectId)&&(!r.nextRunAt||due(r.nextRunAt))))return true;
  const briefing=a.data.briefingSchedule;if(briefing?.enabled&&active(briefing.projectId)&&due(briefing.nextRunAt))return true;
  try{return require('./chat-streams.cjs').pending(a).length>0;}catch{return true;}
}
// Only writes to the same destination wait for one another. Reads and model work continue.
async function withWrite(a,key,callback){
  const owner=root(a);owner.writeExecutions ||= new Map();const previous=owner.writeExecutions.get(key)||Promise.resolve();
  let release;const gate=new Promise(resolve=>{release=resolve;});const tail=previous.catch(()=>{}).then(()=>gate);owner.writeExecutions.set(key,tail);
  try{await previous.catch(()=>{});a.controller?.signal.throwIfAborted();return await callback();}
  finally{release();if(owner.writeExecutions.get(key)===tail)owner.writeExecutions.delete(key);}
}
module.exports={initialize,root,snapshot,scope,conflict,assertIdle,launch,abortJob,abortAll,jobActive,withWrite,maintenanceDue};
