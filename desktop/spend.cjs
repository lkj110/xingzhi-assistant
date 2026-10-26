// Per-work USD-equivalent accounting. This ledger is independent of rotating backups.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {outputBudget}=require('./model-protocols.cjs');
const now=()=>new Date().toISOString(),uid=()=>crypto.randomUUID();
const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const rates={
  'gpt-6.1-sol':[2,.1,10,true], 'gpt-6-luna':[.1,.01,.5,true],
  'gpt-6-astra':[10,1,50,true], 'gpt-5.6-sol':[4,.4,20,true],
  'gpt-5.3-codex':[1.75,.175,14,false]
};
const source='https://developers.openai.com/api/docs/pricing';
function pricing(p){
  if(valid(p.inputPrice)&&valid(p.outputPrice))return {input:p.inputPrice,cached:valid(p.cachedInputPrice)?p.cachedInputPrice:p.inputPrice,output:p.outputPrice,longContext:p.longContextPricing===true,source:'用户配置',asOf:null};
  if(p.type==='ollama')return {input:0,cached:0,output:0,longContext:false,source:'本地 Ollama，不计电费和设备成本'};
  // Third-party services may charge different prices for the same model name.
  let official=p.type==='codex';try{official ||= new URL(p.baseUrl).hostname==='api.openai.com';}catch{}
  const r=official&&rates[p.model];
  return r?{input:r[0],cached:r[1],output:r[2],longContext:r[3],source,asOf:'2026-10-12'}:null;
}
function usage(value){
  if(!value||!valid(value.inputTokens)||!valid(value.outputTokens))return null;
  const cached=value.cachedInputTokens??0,write=value.cacheWriteTokens??0,hour=value.cacheWrite1hTokens??0;
  if(!valid(cached)||!valid(write)||!valid(hour)||hour>write||cached+write>value.inputTokens)return null;
  return {inputTokens:value.inputTokens,outputTokens:value.outputTokens,cachedInputTokens:cached,cacheWriteTokens:write,...(hour?{cacheWrite1hTokens:hour}:{}),totalTokens:value.inputTokens+value.outputTokens};
}
function cost(u,p){
  if(!u||!p)return null;
  const long=p.longContext&&u.inputTokens>272000,im=long?2:1,om=long?1.5:1;
  const hour=u.cacheWrite1hTokens||0;
  return ((u.inputTokens-u.cachedInputTokens-u.cacheWriteTokens)*p.input*im+u.cachedInputTokens*p.cached*im+((u.cacheWriteTokens-hour)*1.25+hour*2)*p.input*im+u.outputTokens*p.output*om)/1e6;
}
function emptyUsage(){return {inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,totalTokens:0,reportedCalls:0,unknownCalls:0,estimatedUSD:0,unpricedCalls:0};}
function addUsage(target,u,usd){
  for(const [k,v] of Object.entries(emptyUsage()))target[k]??=v;
  if(u){for(const k of ['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','totalTokens'])target[k]+=u[k];target.reportedCalls++;if(usd===null)target.unpricedCalls++;else target.estimatedUSD+=usd;}
  else target.unknownCalls++;
}
function failure(message,kind='budget'){return Object.assign(new Error(message),{spendLimit:true,spendKind:kind,automaticRetry:false});}
const file=a=>path.join(a.dir,'spend-ledger.json');
function persist(a){
  if(a.spendError)throw failure(a.spendError,'storage');
  try{
    const fd=fs.openSync(file(a)+'.tmp','w',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(a.spendLedger));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(file(a)+'.tmp',file(a));a.data.spendMeter=structuredClone(a.spendLedger);
  }catch{a.spendError='费用账本无法保存，已停止模型请求。请检查本地存储。';throw failure(a.spendError,'storage');}
}
function newScope(key,label){return {id:uid(),key,label,revision:uid(),createdAt:now(),limitUSD:100,spentUSD:0,heldUSD:0,usage:emptyUsage(),unknownAcknowledged:0,unreservedCalls:0,approvals:[],pending:{}};}
function initialize(a){
  try{
    if(fs.existsSync(file(a))){
      const st=fs.lstatSync(file(a));if(!st.isFile()||st.isSymbolicLink()||st.size>50e6)throw Error();
      const ledger=JSON.parse(fs.readFileSync(file(a),'utf8'));
      if(ledger.format!==1||!ledger.scopes||Array.isArray(ledger.scopes))throw Error();
      for(const [key,s] of Object.entries(ledger.scopes)){
        if(s.key!==key||!s.id||!s.revision||![s.limitUSD,s.spentUSD,s.heldUSD,s.unknownAcknowledged].every(valid)||s.limitUSD<100||!s.usage||!Object.keys(emptyUsage()).every(k=>valid(s.usage[k]))||!s.pending||!Array.isArray(s.approvals))throw Error();
        if(s.unreservedCalls===undefined)s.unreservedCalls=s.legacy?Math.max(0,s.usage.unknownCalls+s.usage.unpricedCalls-s.unknownAcknowledged):0;
        if(!valid(s.unreservedCalls)||!Number.isInteger(s.unreservedCalls))throw Error();
        for(const p of Object.values(s.pending)){if(!valid(p.reservedUSD))throw Error();s.usage.unknownCalls++;}
        // Reservations survive crashes and stay charged against the same budget.
        if(Object.keys(s.pending).length){s.pending={};s.revision=uid();}
      }
      a.spendLedger=ledger;
    }else{
      if(a.data.spendMeter)throw Error(); // A missing established ledger must not grant fresh credit.
      a.spendLedger={format:1,createdAt:now(),scopes:{}};
      for(const job of a.data.delegations||[]){
        const rows=(a.data.modelCalls||[]).filter(r=>r.jobId===job.id);if(!rows.length&&!job.callsUsed)continue;
        const s=newScope('job:'+job.id,job.title);s.legacy=true;
        for(const row of rows){
          const p=a.data.providers.find(p=>p.id===row.providerId),price=p?.model===row.model?pricing(p):null,u=usage(row),usd=cost(u,price);
          addUsage(s.usage,u,usd);if(usd!==null)s.spentUSD+=usd;
        }
        const missing=Math.max(0,(job.callsUsed||0)-rows.length);s.usage.unknownCalls+=missing;s.unreservedCalls=s.usage.unknownCalls+s.usage.unpricedCalls;
        a.spendLedger.scopes[s.key]=s;
      }
    }
    for(const s of Object.values(a.spendLedger.scopes)){
      if(unsettled(s))s.blocked={kind:'unknown',message:'历史调用缺少用量和费用预留，无法核算剩余额度，请核对历史消耗。',at:now()};
      else if(s.blocked?.kind==='unknown'){
        delete s.blocked;s.revision=uid();
        const j=a.data.delegations?.find(j=>'job:'+j.id===s.key);
        if(j?.status==='limited'&&j.limitReason==='spend'&&s.spentUSD+s.heldUSD<s.limitUSD){
          const pending=a.data.agentActions?.some(r=>r.jobId===j.id&&['pending','uncertain','running'].includes(r.status));
          j.status=pending?'approval':a.data.decisions?.some(d=>d.jobId===j.id&&d.status==='open')?'needs_input':'ready';
          j.nextRunAt=j.status==='ready'?now():null;j.lastError='';j.summary='未知用量已保留费用预留，在原累计额度内继续';delete j.limitReason;
        }
      }
    }
    persist(a);
  }catch{a.spendError='费用账本无法读取或保存，已停止模型请求。请保留账本并检查本地存储。';a.spendLedger||={format:1,scopes:{}};}
}
function scope(a,{evaluation=false}={}){
  const job=a.activeAgentJob,task=a.activeSpendTask;
  if(!job&&!task&&!evaluation)return null;
  const key=job?'job:'+job.id:task?'task:'+task.id:'evaluation';
  return a.spendLedger.scopes[key] ||= newScope(key,job?.title||task?.title||'真实模型验收');
}
function unsettled(s){return s.unreservedCalls??Math.max(0,s.usage.unknownCalls+s.usage.unpricedCalls-s.unknownAcknowledged);}
function reserve(a,p,messages,options={}){
  if(a.spendError)throw failure(a.spendError,'storage');
  const output=outputBudget(p);
  const s=scope(a,options);if(!s)return null;
  const price=pricing(p);
  const block=(kind,message)=>{s.blocked={kind,message,at:now()};s.revision=uid();persist(a);throw failure(message,kind);};
  if(!price)block('pricing',`模型 ${p.model} 尚未配置单价，请到模型设置填写输入、缓存输入和输出单价后继续。`);
  if(unsettled(s))block('unknown',`有 ${unsettled(s)} 次历史调用缺少用量或单价，且没有费用预留，请核对历史消耗后继续。`);
  // Conservative admission estimate, not a provider-side billing guarantee. Codex may internally compact.
  const inputTokens=Buffer.byteLength(JSON.stringify(messages),'utf8')+8192+(options.extraInputBytes||0);
  const reserveUSD=cost({inputTokens,outputTokens:output.outputTokens,cachedInputTokens:0,cacheWriteTokens:0},{...price,input:Math.max(price.input*1.25,price.cached)});
  if(s.spentUSD+s.heldUSD>=s.limitUSD||s.spentUSD+s.heldUSD+reserveUSD>s.limitUSD)block('budget',`本次推进已计入 $${(s.spentUSD+s.heldUSD).toFixed(4)}，上限 $${s.limitUSD.toFixed(2)}；下一次请求预计预留 $${reserveUSD.toFixed(4)}，需要人工追加额度。`);
  const outputMeta={outputTokens:output.outputTokens,outputLimitMode:output.mode};
  const id=uid();s.pending[id]={reservedUSD:reserveUSD,at:now(),...outputMeta};s.heldUSD+=reserveUSD;s.revision=uid();delete s.blocked;persist(a);
  return {scopeKey:s.key,id,reservedUSD:reserveUSD,pricing:price,...outputMeta};
}
function cancel(a,ticket){const s=a.spendLedger.scopes[ticket.scopeKey];if(s?.pending[ticket.id]){delete s.pending[ticket.id];s.heldUSD=Math.max(0,s.heldUSD-ticket.reservedUSD);s.revision=uid();persist(a);}}
function settle(a,ticket,u,usd){
  if(!ticket)return;
  const s=a.spendLedger.scopes[ticket.scopeKey];if(!s?.pending[ticket.id])throw failure('费用预留记录缺失，已停止后续请求。','storage');
  delete s.pending[ticket.id];addUsage(s.usage,u,usd);
  if(u&&usd!==null){s.heldUSD=Math.max(0,s.heldUSD-ticket.reservedUSD);s.spentUSD+=usd;}
  else if(ticket.reservedUSD===0){s.unknownAcknowledged++;} // Explicitly zero-priced local/mock computation.
  s.revision=uid();s.updatedAt=now();
  if(unsettled(s))s.blocked={kind:'unknown',message:'历史调用没有完整用量或费用预留，请核对历史消耗。',at:now()};
  else if(s.spentUSD+s.heldUSD>=s.limitUSD)s.blocked={kind:'budget',message:'本次推进已达到费用上限，需要人工追加额度后继续。',at:now()};
  persist(a);
}
function check(a,options={}){
  if(a.spendError)throw failure(a.spendError,'storage');
  const s=scope(a,options);if(!s)return;
  const kind=unsettled(s)?'unknown':s.spentUSD+s.heldUSD>=s.limitUSD?'budget':null;
  if(kind){const message=kind==='unknown'?'历史调用缺少完整用量和费用预留，无法核算剩余额度，请核对历史消耗。':'本次推进已达到费用上限，需要人工追加额度后继续。';s.blocked={kind,message,at:now()};s.revision=uid();persist(a);throw failure(message,kind);}
}
function summaries(a){return {error:a.spendError||null,scopes:Object.values(a.spendLedger.scopes).map(s=>({...s,pending:undefined,remainingUSD:Math.max(0,s.limitUSD-s.spentUSD-s.heldUSD),unsettledCalls:unsettled(s)}))};}
function approve(a,input){
  const targetScope=Object.values(a.spendLedger.scopes).find(s=>s.id===input.id);
  a.ensureIdle(targetScope?.key.startsWith('job:')?{jobId:targetScope.key.slice(4)}:targetScope?.key.startsWith('task:')?{taskId:targetScope.key.slice(5)}:undefined);if(a.spendError)throw failure(a.spendError,'storage');
  const s=Object.values(a.spendLedger.scopes).find(s=>s.id===input.id);
  if(!s||input.revision!==s.revision)throw Error('费用记录已变化，请刷新后重新确认');
  const additional=input.additionalUSD;
  if(input.confirmed!==true||![0,100].includes(additional))throw Error('需要人工明确确认追加 100 美元等值额度');
  if(additional===0&&(!unsettled(s)||s.spentUSD+s.heldUSD>=s.limitUSD))throw Error('只有仍有剩余额度的未知用量可以在原上限内确认');
  if(unsettled(s)&&input.acknowledgeUnknown!==true)throw Error('请先确认已知悉未返回用量，实际消耗可能高于已报告值');
  if(s.blocked?.kind==='pricing')throw Error('请先配置模型单价，普通追加额度不能绕过计价');
  s.unreservedCalls=0;s.limitUSD+=additional;s.unknownAcknowledged=s.usage.unknownCalls+s.usage.unpricedCalls;
  s.approvals.push({id:uid(),at:now(),additionalUSD:additional,approvedBy:'user',knownUSD:s.spentUSD,heldUSD:s.heldUSD,unknownCalls:s.unknownAcknowledged});
  s.revision=uid();delete s.blocked;persist(a);
  const job=a.data.delegations.find(j=>'job:'+j.id===s.key);
  if(job?.limitReason==='spend'){delete job.limitReason;job.lastError='';job.summary=additional?'费用额度已人工追加，可继续推进':'未知用量已人工确认，将在原额度内继续';if(job.status!=='paused'){job.status='ready';job.nextRunAt=now();}}
  a.event(additional?'人工追加推进额度':'人工核对未知消耗',`${s.label}：追加 $${additional}，累计上限 $${s.limitUSD}`);a.save();return a.publicState();
}
function blockJob(a,job,error){if(!job||!error.spendLimit)return;job.status='limited';job.limitReason='spend';job.nextRunAt=null;job.lastError=error.message;job.summary=error.message;}
module.exports={initialize,pricing,usage,cost,emptyUsage,addUsage,scope,check,reserve,cancel,settle,summaries,approve,blockJob,persist,unsettled};
