'use strict';
// A read-only CLI observation, never a model allowance or a recovery grant.
const {randomUUID}=require('node:crypto');
const {hash}=require('./evidence-basis.cjs');
const journal=require('./work-journal.cjs');
const transitions=require('./state-transitions.cjs');
const subscription=require('./subscription.cjs');
const errors=require('./model-errors.cjs');
const EVENT='subscription_health_pending_v1',TTL_MS=10*60*1000;
const blocked=new WeakSet();
const rows=v=>Array.isArray(v)?v:[];
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v?.[k]??null]));
const ordered=v=>v.sort((a,b)=>hash(a).localeCompare(hash(b)));
const receipt=a=>a.data.runtime?.subscriptionHealth;

function recoveryIntent(a){
 // Derive from immutable failed-request evidence. Preparing a grant changes the
 // attempt's status/runId; neither that nor the grant belongs in this identity.
 return ordered(rows(a.data.tasks).flatMap(t=>Object.entries(t.evidenceConsumption?.attempts||{}).flatMap(([key,p])=>{
   if(!rows(p.requests).some(r=>r.errorCode||r.responseStatus==='error'))return [];
   // claim appends the new request in its atomic commit before checking health.
   // Select the original tuple using the stored proof, then hash the LIVE old
   // request (including missing/duplicate copies), never the proof's copy. The
   // recovery verifier owns admission of additional requests and grant validity.
   const original=p.modelPreflightRecovery?.proof?.originalRequest;
   const bound=original?rows(p.requests).filter(r=>['requestId','attempt','runId','callId','spendTicketId'].every(k=>r[k]===original[k])):rows(p.requests);
   const requests=ordered(bound.map(r=>{
     const calls=rows(a.data.modelCalls).filter(c=>c.id===r.callId||c.requestId===r.requestId&&c.attempt===r.attempt);
     const runs=rows(a.data.agentRuns).filter(run=>run.id===r.runId);
     return {request:pick(r,['requestId','attempt','runId','callId','spendTicketId','producerSchema','at','finishedAt','status','responseStatus','usageReported','errorCode','diagnostic','errorDiagnostic']),
       calls:ordered(calls.map(c=>pick(c,['id','requestId','attempt','runId','taskRunId','taskId','jobId','spendTicketId','spendScope','providerType','providerId','model','reasoning','role','stage','status','errorCode','error','errorMessage','diagnostic','producerSchema','usageReported','inputTokens','outputTokens','cachedInputTokens','at','finishedAt']))),
       runs:ordered(runs.map(run=>({id:run.id,finishedAt:run.finishedAt??null,errorCode:run.errorCode??null,error:run.error??null,
         calls:rows(run.modelCallsDetail).filter(c=>c.id===r.callId),steps:rows(run.steps).filter(s=>s.tool==='advance_task'&&s.args?.taskId===t.id).map(s=>pick(s,['id','tool','args','status','errorCode','error','errorDiagnostic','startedAt','finishedAt']))}))),
       taskRuns:ordered(rows(t.progressRuns).filter(run=>rows(run.modelCallsDetail).some(c=>c.id===r.callId)).map(run=>({id:run.id,finishedAt:run.finishedAt??null,calls:rows(run.modelCallsDetail).filter(c=>c.id===r.callId)})))};
   }));
   return [{taskId:t.id,jobId:t.agentJobId,key,...pick(p,['attemptId','intent','scope','baseArtifactId','baseHash','primaryLineageId','stepId','targetFacts','additionalFacts','originalInputBasis','originalGenerationSnapshot']),requests}];
 })));
}

function identity(a){
 const cli=subscription.identity();
 const providers=ordered(rows(a.data.providers).filter(p=>p.type==='codex').map(p=>pick(p,['id','type','model','reasoning','archivedAt','requestPolicy'])));
 const configuration={cli:cli.configurationHash,providers,roles:pick(a.data.settings?.roles,['organize','execute','verify']),
   routing:pick(a.data.modelRouting,['version','revision','enabled','economyId','analysisId','configuration','needsSave']),
   fallback:{...pick(a.data.modelFallback,['version','revision','configuration']),roles:Object.fromEntries(['organize','execute','verify'].map(role=>[role,pick(a.data.modelFallback?.roles?.[role],['enabled','providerId','needsSave'])]))},
   taskModels:ordered(rows(a.data.tasks).filter(t=>t.evidenceConsumption).map(t=>({id:t.id,modelPreference:t.modelPreference??null})))};
 return {identityPolicyVersion:2,cliHash:cli.cliHash,configurationHash:cli.configurationHash?hash(configuration):null,intentHash:hash(recoveryIntent(a))};
}

function latest(a){return journal.read(a).events.findLast(e=>e.type===EVENT)?.payload?.health||null;}
function same(a,b){return !!a&&!!b&&(a.identityPolicyVersion??1)===(b.identityPolicyVersion??1)&&['cliHash','configurationHash','intentHash'].every(k=>typeof a[k]==='string'&&a[k]===b[k]);}
function set(a,value){a.data.runtime||={};a.data.runtime.subscriptionHealth=structuredClone(value);}
journal.registerProjector(EVENT,(a,_target,event)=>{
 const next=event.payload?.health,current=receipt(a);
 if(!next||next.version!==1||!Number.isSafeInteger(next.sequence)||next.sequence<1||!next.checkId||!['pending','failed'].includes(next.status))return;
 if(!current||next.sequence>current.sequence||next.sequence===current.sequence&&(next.checkId!==current.checkId||next.status==='failed'))set(a,next);
});
function eventFor(target,health){return {type:EVENT,entityKind:target.kind,entityId:target.value.id,actor:'user',workRevision:target.value.workRevision??1,payload:{health}};}
function targetFor(a){
 const task=rows(a.data.tasks).find(t=>Object.keys(t.evidenceConsumption?.attempts||{}).length)||rows(a.data.tasks)[0];
 if(task)return {kind:'task',value:task};
 const job=rows(a.data.delegations)[0];return job?{kind:'job',value:job}:null;
}
function invalidate(a,target,pending){
 if((receipt(a)?.sequence||0)>pending.sequence)return;
 blocked.add(a);
 const failed={...pending,status:'failed',errorCode:'MODEL_STORAGE'};
 set(a,failed);
 // The pending journal already revokes an older success. If a snapshot save
 // threw after rename, this tombstone also revokes that ambiguous completion
 // on cold replay. Never mask the original persistence error.
 try {const head=latest(a);if(head?.checkId===pending.checkId||!head||head.sequence<pending.sequence)journal.commit(a,[eventFor(target,failed)],{save:false});}catch{}
 // If the journal itself could not accept pending, preserve the revocation in
 // the snapshot as well. Either durable store suffices to reject the old check.
 try {a.save();}catch{}
}

async function check(a){
 if(!require('./workspace-view.cjs').trustedCommand(a,'subscriptionStatus'))throw Object.assign(Error('请从模型设置检测订阅状态'),{code:'SUBSCRIPTION_HEALTH_UNTRUSTED'});
 const target=targetFor(a);
 // An empty workspace has no recovery subject or work-journal entity. It may
 // display ordinary subscription status, but cannot mint a recovery receipt.
 if(!target)return {...await subscription.status(),health:null};
 let pending;
 try {
   const previous=latest(a),sequence=Math.max(previous?.sequence||0,receipt(a)?.sequence||0)+1;
   if(!Number.isSafeInteger(sequence))throw Error('invalid health sequence');
   const startedAt=new Date().toISOString();
   pending={version:1,checkId:randomUUID(),sequence,status:'pending',startedAt,...identity(a)};
   // This commit is synchronous and durable before subscription.status awaits.
   journal.commit(a,[eventFor(target,pending)]);
   blocked.delete(a);
 }catch(error){
   if(!pending)pending={...receipt(a),version:1,checkId:randomUUID(),sequence:(receipt(a)?.sequence||0)+1,status:'pending',startedAt:new Date().toISOString()};
   invalidate(a,target,pending);throw errors.persistenceError();
 }
 let result,failure;
 try{result=await subscription.status();}catch(error){failure=errors.normalizeModelError(error);}
 try {
   const head=latest(a);
   if(head?.checkId!==pending.checkId||head.sequence!==pending.sequence||head.status!=='pending'){
     if(failure)throw failure;
     return {...result,health:null};
   }
   const finishedAt=new Date().toISOString(),finished=Date.parse(finishedAt),started=Date.parse(pending.startedAt);
   const healthy=!failure&&result?.installed===true&&result?.loggedIn===true&&same(pending,identity(a))&&finished>=started&&finished-started<TTL_MS;
   const next={...pending,status:healthy?'success':'failed',finishedAt,expiresAt:new Date(started+TTL_MS).toISOString(),installed:result?.installed===true,loggedIn:result?.loggedIn===true,
     ...(!healthy?{errorCode:failure?errors.safeErrorCode(failure):'MODEL_AUTH'}:{})};
   transitions.commit(a,()=>set(a,next));
   if(failure)throw failure;
   return {...result,health:healthy?structuredClone(next):null};
 }catch(error){
   if(error===failure)throw failure;
   invalidate(a,target,pending);throw errors.persistenceError();
 }
}

function valid(a,{after,intent}={}){
 try {
   if(blocked.has(a)||a.readOnlyRecovery||a.data.runtime?.workJournalError||a.data.runtime?.projectionPending||a.data.runtime?.workJournal?.projectionPending)return null;
   const r=receipt(a),head=latest(a),now=Date.now();
   const at=typeof after==='number'?after:typeof after==='string'?Date.parse(after):NaN;
   if(!r||r.version!==1||r.status!=='success'||r.installed!==true||r.loggedIn!==true||head?.status!=='pending'||head.checkId!==r.checkId||head.sequence!==r.sequence||!same(r,head)||!same(r,identity(a)))return null;
   if(intent!==undefined&&intent!==r.intentHash)return null;
   const start=Date.parse(r.startedAt),finish=Date.parse(r.finishedAt),expires=Date.parse(r.expiresAt);
   if(!Number.isFinite(at)||!Number.isFinite(start)||!Number.isFinite(finish)||!Number.isFinite(expires)||start<=at||start>now||finish<start||finish>now||expires!==start+TTL_MS||now>=expires||head.startedAt!==r.startedAt)return null;
   return {...structuredClone(r),valid:true};
 }catch{return null;}
}
// Validate the immutable receipt at the recorded claim time on cold replay.
// Later expiry/checks cannot revoke a model request that was already claimed.
function validAtClaim(a,r,{after,at}={}){
 try{
  const start=Date.parse(r?.startedAt),finish=Date.parse(r?.finishedAt),expires=Date.parse(r?.expiresAt),claimed=Date.parse(at),failed=Date.parse(after);
  if(r?.version!==1||r.status!=='success'||r.installed!==true||r.loggedIn!==true||!Number.isSafeInteger(r.sequence)||r.sequence<1||![start,finish,expires,claimed,failed].every(Number.isFinite)||start<=failed||finish<start||finish>claimed||claimed>=expires||expires!==start+TTL_MS)return false;
  return journal.read(a).events.some(e=>e.type===EVENT&&e.payload?.health?.status==='pending'&&e.payload.health.checkId===r.checkId&&e.payload.health.sequence===r.sequence&&e.payload.health.startedAt===r.startedAt&&same(e.payload.health,r));
 }catch{return false;}
}
module.exports={identity,check,valid,validAtClaim,receipt:a=>receipt(a)?structuredClone(receipt(a)):null,TTL_MS};
