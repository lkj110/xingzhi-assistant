'use strict';
// Isolated real Assistant/Worker fixture. Only transports and the process clock
// are controlled. No policy, continuation, dispatch or journal mocks.
const fs=require('node:fs'),assert=require('node:assert/strict');
const RealDate=Date;
const scenarios=['permanent','unknown','transient','local_recovery'];
function isolate(attempts){
 const deny=name=>()=>{attempts.push(name);throw Error('REAL_TRANSPORT_FORBIDDEN: '+name);};
 global.fetch=deny('fetch');require('node:net').Socket.prototype.connect=deny('net');
 for(const type of ['node:http','node:https'])for(const name of ['request','get'])require(type)[name]=deny(type+'.'+name);
 require('node:tls').connect=deny('tls');require('node:dgram').createSocket=deny('dgram');
 for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[name]=deny('child_process.'+name);
}
async function setup({Assistant,options={},reportFile,scenario='permanent',restoreAudit=false}={}){
 assert.ok(scenarios.includes(scenario));assert.ok(reportFile);
 const old=restoreAudit&&fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile)):null;
 const audit=old?.audit||{identity:0,business:0,models:0,forbidden:[],offset:0};
 isolate(audit.forbidden);global.Date=RealDate;
 const base=await require('./generic-consumption-worker-fixture.cjs').setup({Assistant,options,reportFile:reportFile+'.base.json',restoreAudit,scenario:scenario==='local_recovery'?scenario:'success'});
 const {a,job,task}=base,identity=require('../desktop/evidence-identity-preflight.cjs');
 let clock=old?.clock||RealDate.now();
 global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
 const saveAudit=()=>{base.saveAudit();fs.writeFileSync(reportFile,JSON.stringify({schema:'identity-scheduling-fixture/1',scenario,audit,clock},null,2)+'\n');};
 const idCommand=JSON.stringify(require('../desktop/data-platform.cjs').command({op:'identity'}));
 Object.defineProperty(a,'platformRequest',{configurable:true,value:async args=>{
  if(JSON.stringify(args)!==idCommand){audit.business++;saveAudit();throw Error('UNEXPECTED_BUSINESS_REQUEST');}
  audit.identity++;saveAudit();throw Object.assign(Error('controlled identity failure'),{code:scenario==='transient'?'TRANSIENT':'REPLAY_FORBIDDEN_NETWORKATTEMPTS'});
 }});
 const controlledLocalModel=a.chat;
 a.chat=async()=>{audit.models++;saveAudit();throw Error('UNEXPECTED_MODEL_REQUEST');};
 if(!old){
  job.maxActions=scenario==='local_recovery'?2:6;a.data.settings.automatic=true;
  if(scenario==='unknown'||scenario==='local_recovery'){
   // Explicit historical adapter: commit a real request boundary, deliberately
   // leave it unresolved, never invoke its transport or finish it.
   const row=identity.begin(a,job);identity.dispatched(a,row);
  }
  a.save();saveAudit();
 }
 function observe(){
  const p=require('../desktop/execution-policy.cjs').inspect(a,job,{mode:'automatic'}),v=identity.inspect(a,job),c=job.executionState.continuation;
  const runs=a.data.agentRuns.filter(r=>r.jobId===job.id),steps=runs.flatMap(r=>r.steps||[]);
  const histories=Object.values(job.executionState.identityPreflights||{}).flat();
  return {schema:'identity-scheduling-observation/1',scenario,threadId:require('node:worker_threads').threadId,clock,audit:structuredClone(audit),jobId:job.id,taskId:task.id,jobStatus:job.status,nextRunAt:job.nextRunAt,summary:job.summary,
   policy:{phase:p.phase,eligible:p.eligible,reasonCode:p.reasonCode,reason:p.reason,resumeAt:p.resumeAt,action:p.action,choices:p.choices.map(c=>({taskId:c.taskId,eligible:c.eligible,phase:c.phase,reasonCode:c.reasonCode,tool:c.action?.tool}))},
   identityDecision:v.decision,identityKey:v.key,identityRecords:structuredClone(histories),runCount:runs.length,stepCount:steps.length,attemptCount:require('../desktop/evidence-item-lifecycle.cjs').allAttempts(job).length,attempts:structuredClone(require('../desktop/evidence-item-lifecycle.cjs').allAttempts(job)),
   runs:runs.map(r=>({id:r.id,status:r.status,steps:r.steps.map(s=>({id:s.id,args:structuredClone(s.args),evidenceAcquisition:structuredClone(s.evidenceAcquisition),tool:s.tool,errorCode:s.errorCode,requests:s.dispatch?.requests,identityPreflight:s.identityPreflight}))})),
   budget:structuredClone(a.spendLedger.scopes['job:'+job.id]),episode:{basis:base.originalBasis,cycles:c.episodes[base.originalBasis]?.cycles,hops:c.episodes[base.originalBasis]?.hops,suspendedBy:c.episodes[base.originalBasis]?.suspendedBy||null},
   recovery:require('./generic-consumption-worker-fixture.cjs').observe(base).recovery,executions:a.executions.size};
 }
 const dispatch=a.dispatch.bind(a);
 a.dispatch=async(command,input={})=>{
  if(command==='controlledIdentityObserve')return observe();
  if(command==='controlledIdentityTick'){
   assert.ok(Number.isFinite(input.advanceMs||0)&&Math.abs(input.advanceMs||0)<=86400000);clock+=input.advanceMs||0;a.tick();await a.runPromise;saveAudit();return observe();
  }
  if(command==='controlledIdentityRun'){await dispatch('agentRun',{id:job.id});await a.runPromise;saveAudit();return observe();}
  return dispatch(command,input);
 };
 return {a,job,task,observe,saveAudit,controlledLocalModel,dispose:()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);global.Date=RealDate;}};
}
module.exports={setup,scenarios};
