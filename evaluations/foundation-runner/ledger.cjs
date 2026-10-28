'use strict';
// Evaluation-only accounting. A successful admit must precede any transport.
// Tokens in an offline ledger are synthetic; they never establish live usage.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const planHash=plan=>hash(plan);
function fault(code,message,scope='global',extra={}){return Object.assign(Error(message),{code,scope,...extra});}
function validatePlan(plan){
 const b=plan?.budget,ids=plan?.caseLimits?.map(c=>c.id);
 if(!b||!plan.protocolGate?.id||!ids?.length||new Set(ids).size!==ids.length||ids.includes(plan.protocolGate.id))throw fault('LEDGER_PLAN','Invalid case inventory');
 for(const key of ['applicationAttempts','reportedTokenStopThreshold','protocolAttempts','protocolTokenStopThreshold','businessAttempts','businessTokenStopThreshold','dispatchWindowMinutes','maxVisibleRequestBytes','reservationOutputAllowance','reservationFramingAllowance'])if(!integer(b[key])||b[key]===0)throw fault('LEDGER_PLAN','Invalid budget '+key);
 for(const c of plan.caseLimits)if(typeof c.id!=='string'||!c.id||!integer(c.attempts)||!c.attempts||!integer(c.tokenStopThreshold)||!c.tokenStopThreshold)throw fault('LEDGER_PLAN','Invalid case budget');
 if(plan.caseLimits.reduce((n,c)=>n+c.attempts,0)!==b.businessAttempts||plan.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0)!==b.businessTokenStopThreshold||b.protocolAttempts+b.businessAttempts!==b.applicationAttempts||b.protocolTokenStopThreshold+b.businessTokenStopThreshold!==b.reportedTokenStopThreshold)throw fault('LEDGER_PLAN','Budget sums disagree');
 if(plan.settings?.concurrency!==1||plan.settings?.retries!==0||plan.settings?.fallback!==false||b.serverEnforcedTokenCap!==false||b.priorBudgetsReusable!==false)throw fault('LEDGER_PLAN','Unsupported execution policy');
}
function normalizeUsage(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw fault('LEDGER_USAGE','Missing authoritative usage');
 const pick=(names,required)=>{
  const found=names.filter(k=>Object.hasOwn(value,k)&&value[k]!==undefined);
  if(!found.length){if(required)throw fault('LEDGER_USAGE','Missing '+names[0]);return null;}
  if(found.some(k=>!integer(value[k]))||found.some(k=>value[k]!==value[found[0]]))throw fault('LEDGER_USAGE','Invalid or conflicting '+names[0]);
  return value[found[0]];
 };
 const inputTokens=pick(['inputTokens','input_tokens','prompt_tokens'],true),outputTokens=pick(['outputTokens','output_tokens','completion_tokens'],true),cachedInputTokens=pick(['cachedInputTokens','cached_input_tokens','cached_tokens'],false);
 if(cachedInputTokens!==null&&cachedInputTokens>inputTokens)throw fault('LEDGER_USAGE','Cached input exceeds input');
 const totalTokens=inputTokens+outputTokens;
 if(!integer(totalTokens))throw fault('LEDGER_USAGE','Usage total overflow');
 const explicitTotal=pick(['totalTokens','total_tokens'],false);
 if(explicitTotal!==null&&explicitTotal!==totalTokens)throw fault('LEDGER_USAGE','Conflicting total usage');
 return {inputTokens,outputTokens,cachedInputTokens,totalTokens};
}
class Ledger{
 constructor({dir,plan,mode,sealIdentity,authorization,conservativeAttemptSlot=false,now=Date.now}){
  validatePlan(plan);
  if(!path.isAbsolute(dir)||!['offline','live'].includes(mode)||!/^[a-f0-9]{64}$/.test(sealIdentity||'')||typeof now!=='function'||typeof conservativeAttemptSlot!=='boolean')throw fault('LEDGER_CONFIG','Invalid ledger configuration');
  this.dir=dir;this.file=path.join(dir,'ledger.json');this.lock=path.join(dir,'ledger.lock');this.plan=freeze(clone(plan));this.now=now;this.poisoned=false;this.identity={planSha256:planHash(plan),sealIdentity,mode,conservativeAttemptSlot};
  if(mode==='live'){
   if(authorization?.schema!==1||authorization.grantedBy!=='user'||typeof authorization.reference!=='string'||!authorization.reference.trim()||authorization.sealIdentity!==sealIdentity||authorization.planSha256!==this.identity.planSha256||authorization.applicationAttempts!==plan.budget.applicationAttempts||authorization.reportedTokenStopThreshold!==plan.budget.reportedTokenStopThreshold||authorization.nonHardCapAccepted!==true)throw fault('LEDGER_UNAUTHORIZED','Explicit matching user authorization is required');
   this.identity.authorizationSha256=hash(authorization);
  }
  freeze(this.identity);
  fs.mkdirSync(dir,{recursive:true});
  this._locked(()=>{
   if(fs.existsSync(this.file)){
    const disk=this._read();
    if(canonical(disk.identity)!==canonical(this.identity))throw fault('LEDGER_IDENTITY','Ledger mode, plan, seal or authorization changed');
    this.state=disk;
    if(disk.attempts.some(a=>a.status==='pending')){const next=clone(disk);next.stop ||= {code:'LEDGER_INTERRUPTED',reason:'Unsettled attempt on restart; usage is unknown'};for(const a of next.attempts)if(a.status==='pending')a.status='interrupted';this._write(next);}
   }else{
    const t=this._time();this.state={schema:1,revision:0,identity:this.identity,synthetic:mode==='offline',createdAt:t,startedAt:null,lastObservedAt:t,attempts:[],rejectedAfterStop:[],stop:null,caseStops:{}};this._write(this.state);
   }
  });
 }
 _time(){const n=this.now();if(!integer(n))throw fault('LEDGER_CLOCK','Invalid clock');return n;}
 _read(){
  let disk;try{disk=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw fault('LEDGER_CORRUPT','Unreadable ledger; refusing dispatch');}
  if(disk?.schema!==1||typeof disk.checksum!=='string')throw fault('LEDGER_CORRUPT','Invalid ledger envelope');
  const {checksum,...state}=disk;
  if(hash(state)!==checksum||!Array.isArray(state.attempts)||!integer(state.revision))throw fault('LEDGER_CORRUPT','Ledger integrity check failed');
  return state;
 }
 _locked(fn){
  let fd;try{fd=fs.openSync(this.lock,'wx',0o600);}catch{throw fault('LEDGER_LOCKED','Ledger is owned by another operation; no dispatch');}
  try{return fn();}finally{fs.closeSync(fd);fs.unlinkSync(this.lock);}
 }
 _write(next){
  next.revision=(this.state?.revision||0)+1;
  const temp=path.join(this.dir,'ledger-write-'+crypto.randomUUID()+'.tmp');let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({...next,checksum:hash(next)},null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,this.file);this.state=next;}
  catch(error){this.poisoned=true;throw fault('LEDGER_PERSIST','Accounting persistence failed; no further transport is permitted','global',{cause:error});}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
 }
 _change(fn){
  if(this.poisoned)throw fault('LEDGER_POISONED','Previous persistence failure; no dispatch');
  return this._locked(()=>{
   const disk=this._read();if(hash(disk)!==hash(this.state))throw fault('LEDGER_STALE','Another process changed the ledger; reopen before continuing');
   const next=clone(this.state),result=fn(next);this._write(next);if(result?.error)throw result.error;return result;
  });
 }
 _totals(state,filter=()=>true){
  const rows=state.attempts.filter(filter),known=rows.filter(r=>r.usage),sum=key=>known.reduce((n,r)=>n+r.usage[key],0);
  const unsettled=rows.filter(r=>r.transportPermitted&&!r.usage),usageComplete=unsettled.length===0;
  const unexpectedAttempts=(state.rejectedAfterStop||[]).filter(filter).length;
  return {attempts:rows.length,unexpectedAttempts,applicationEntryAttempts:rows.length+unexpectedAttempts,admitted:rows.filter(r=>r.transportPermitted).length,inputTokens:usageComplete?sum('inputTokens'):null,outputTokens:usageComplete?sum('outputTokens'):null,totalTokens:usageComplete?sum('totalTokens'):null,knownInputSubtotal:sum('inputTokens'),knownOutputSubtotal:sum('outputTokens'),knownTokenSubtotal:sum('totalTokens'),usageComplete,pendingReservation:rows.filter(r=>r.status==='pending').reduce((n,r)=>n+r.reservedTokens,0),pendingUsage:unsettled.filter(r=>r.status==='pending').length,unknownUsage:unsettled.filter(r=>r.status!=='pending').length};
 }
 admit(meta){
  return this._change(next=>{
   if(next.stop||next.caseStops[meta.caseId]){
    const global=!!next.stop,previous=next.stop||next.caseStops[meta.caseId];
    next.rejectedAfterStop.push({id:crypto.randomUUID(),caseId:meta.caseId,lane:meta.caseId===this.plan.protocolGate.id?'protocol':'business',role:meta.role,stage:meta.stage,at:this._time(),reason:previous.reason||previous.code});
    next.stop ||= {code:'LEDGER_UNEXPECTED_ATTEMPT',reason:'Adapter was called after this case stopped'};
    return {error:fault(global?'LEDGER_STOPPED':'LEDGER_CASE_STOPPED',previous.reason||previous.code,global?'global':'case',{caseId:meta.caseId,unexpectedAttempt:true})};
   }
   const protocol=meta.caseId===this.plan.protocolGate.id,limit=protocol?{attempts:this.plan.budget.protocolAttempts,tokenStopThreshold:this.plan.budget.protocolTokenStopThreshold}:this.plan.caseLimits.find(c=>c.id===meta.caseId);
   const before=this._totals(next),stageTotals=this._totals(next,r=>r.lane===(protocol?'protocol':'business')),caseTotals=this._totals(next,r=>r.caseId===meta.caseId),t=this._time();
   const row={id:crypto.randomUUID(),caseId:meta.caseId,role:meta.role,stage:meta.stage,lane:protocol?'protocol':'business',at:t,status:'rejected',transportPermitted:false,usage:null};
   next.attempts.push(row);next.startedAt??=t;
   const reject=(code,reason,scope='global')=>{row.rejection={code,reason,scope};if(scope==='case')next.caseStops[meta.caseId]={code,reason};else next.stop={code,reason};return {error:fault(code,reason,scope,{attemptId:row.id,caseId:meta.caseId})};};
   if(!limit||!['execute','verify'].includes(meta.role)||typeof meta.stage!=='string'||!meta.stage)return reject('LEDGER_REQUEST','Unknown case, role or stage');
   if(t<next.lastObservedAt)return reject('LEDGER_CLOCK','Clock moved backwards');next.lastObservedAt=t;
   if(t-next.startedAt>=this.plan.budget.dispatchWindowMinutes*60000)return reject('LEDGER_WINDOW','Dispatch window ended');
   if(before.pendingReservation)return reject('LEDGER_CONCURRENT','An attempt is still pending');
   for(const key of ['serializedInputBytes','schemaBytes','visibleBytes'])if(!integer(meta[key]))return reject('LEDGER_REQUEST','Invalid request byte count');
   const reservedTokens=meta.serializedInputBytes+meta.schemaBytes+this.plan.budget.reservationOutputAllowance+this.plan.budget.reservationFramingAllowance;
   if(!integer(reservedTokens))return reject('LEDGER_REQUEST','Reservation overflow');
   Object.assign(row,{serializedInputBytes:meta.serializedInputBytes,schemaBytes:meta.schemaBytes,visibleBytes:meta.visibleBytes,reservedTokens});
   const b=this.plan.budget,stageAttempts=protocol?b.protocolAttempts:b.businessAttempts,stageTokens=protocol?b.protocolTokenStopThreshold:b.businessTokenStopThreshold;
   const attemptsExhausted=(used,max)=>this.identity.conservativeAttemptSlot?used+1>=max:used+1>max;
   if(attemptsExhausted(before.attempts,b.applicationAttempts)||before.knownTokenSubtotal+reservedTokens>b.reportedTokenStopThreshold)return reject('LEDGER_GLOBAL_BUDGET','Global admission budget exhausted');
   if(attemptsExhausted(stageTotals.attempts,stageAttempts)||stageTotals.knownTokenSubtotal+reservedTokens>stageTokens)return reject('LEDGER_STAGE_BUDGET','Stage admission budget exhausted');
   if(attemptsExhausted(caseTotals.attempts,limit.attempts)||caseTotals.knownTokenSubtotal+reservedTokens>limit.tokenStopThreshold)return reject('LEDGER_CASE_BUDGET','Case admission budget exhausted','case');
   if(meta.visibleBytes>b.maxVisibleRequestBytes)return reject('LEDGER_REQUEST_SIZE','Visible request exceeds approved limit');
   row.status='pending';row.transportPermitted=true;return clone(row);
  });
 }
 settle(id,value){
  return this._change(next=>{
   const row=next.attempts.find(a=>a.id===id);
   const stop=(code,reason)=>{next.stop ||= {code,reason};return {error:fault(code,reason,'global',{attemptId:id})};};
   if(!row||!row.transportPermitted)return stop('LEDGER_SETTLEMENT','Unknown or rejected attempt');
   let usage;try{usage=normalizeUsage(value);}catch(error){if(row.status==='pending')row.status='usage-unknown';return stop(error.code,error.message);}
   if(row.usage){if(canonical(row.usage)===canonical(usage))return clone(row);return stop('LEDGER_USAGE_CONFLICT','Conflicting usage for an already settled attempt');}
   if(row.status!=='pending')return stop('LEDGER_SETTLEMENT','Attempt cannot be settled after interruption or failure');
   row.usage=usage;row.status='settled';
   const total=this._totals(next),stage=this._totals(next,a=>a.lane===row.lane),c=this._totals(next,a=>a.caseId===row.caseId),b=this.plan.budget,limit=row.lane==='protocol'?b.protocolTokenStopThreshold:this.plan.caseLimits.find(c=>c.id===row.caseId).tokenStopThreshold;
   if(usage.totalTokens>row.reservedTokens||total.knownTokenSubtotal>b.reportedTokenStopThreshold||stage.knownTokenSubtotal>(row.lane==='protocol'?b.protocolTokenStopThreshold:b.businessTokenStopThreshold)||c.knownTokenSubtotal>limit)return stop('LEDGER_OVERAGE','Reported usage exceeds reservation or approved threshold');
   return clone(row);
  });
 }
 fail(id,reason){
  return this._change(next=>{const row=next.attempts.find(a=>a.id===id);if(!row||!row.transportPermitted){next.stop ||= {code:'LEDGER_SETTLEMENT',reason:'Unknown or rejected attempt'};return {error:fault('LEDGER_SETTLEMENT','Unknown or rejected attempt')};}row.status=row.usage?'failed-known-usage':'failed-unknown-usage';row.failure=String(reason||'transport_failure');next.stop ||= {code:'LEDGER_FAILURE',reason:row.failure};return clone(row);});
 }
 localReject(meta,reason){
  return this._change(next=>{
   const row={id:crypto.randomUUID(),caseId:meta?.caseId||'unattributed',lane:meta?.caseId===this.plan.protocolGate.id?'protocol':'business',role:meta?.role||'unknown',stage:meta?.stage||'unknown',at:this._time(),status:'rejected',transportPermitted:false,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:null,totalTokens:0,source:'not_dispatched'},rejection:{code:'LEDGER_LOCAL_REJECTION',reason:String(reason),scope:'global'}};
   if(next.stop||next.caseStops[row.caseId])next.rejectedAfterStop.push({...row,reason:row.rejection.reason});else{next.attempts.push(row);next.startedAt??=row.at;}
   next.stop ||= {code:'LEDGER_LOCAL_REJECTION',reason:row.rejection.reason};return clone(row);
  });
 }
 stop(reason){return this._change(next=>{next.stop ||= {code:'LEDGER_HALTED',reason:String(reason)};return clone(next.stop);});}
 stopCase(caseId,reason){
  return this._change(next=>{if(!this.plan.caseLimits.some(c=>c.id===caseId))throw fault('LEDGER_REQUEST','Unknown business case');next.caseStops[caseId]={code:'LEDGER_BUSINESS_STOP',reason:String(reason)};return clone(next.caseStops[caseId]);});
 }
 snapshot(){
  const state=clone(this.state),totals=this._totals(state);return {...state,totals,lanes:{protocol:this._totals(state,a=>a.lane==='protocol'),business:this._totals(state,a=>a.lane==='business')},cases:Object.fromEntries([this.plan.protocolGate.id,...this.plan.caseLimits.map(c=>c.id)].map(id=>[id,this._totals(state,a=>a.caseId===id)])),remainingApplicationAttempts:Math.max(0,this.plan.budget.applicationAttempts-totals.attempts),poisoned:this.poisoned};
 }
}
module.exports={Ledger,planHash,normalizeUsage};
