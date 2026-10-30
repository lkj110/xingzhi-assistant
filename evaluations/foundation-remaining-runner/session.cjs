'use strict';
// One consumed approval, two one-shot stages. A started stage is never resumed
// or retried; crashes, missing evidence and expired windows close the whole run.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const id=require('./identity.cjs'),{planHash}=require('../foundation-business-runner/ledger.cjs');
const {ledgerStopError}=require('../foundation-runner/failure-cause.cjs');
const capabilities=new WeakSet(),ORDER=['gate','business'];
const phaseGrant=(authorization,stagePlan,authorizationSha256)=>({...authorization,planSha256:planHash(stagePlan),applicationAttempts:stagePlan.budget.applicationAttempts,reportedTokenStopThreshold:stagePlan.budget.reportedTokenStopThreshold,maximumModelDispatches:stagePlan.budget.maximumModelDispatches,derivedFromAuthorizationSha256:authorizationSha256});
const ledgerHashes=output=>Object.fromEntries(['gate','business'].map(phase=>[phase,path.join(output,phase,'ledger/ledger.json')]).filter(([,file])=>fs.existsSync(file)).map(([phase,file])=>[phase,id.sha(fs.readFileSync(file))]));
function persist(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function fail(output,error){const file=path.join(output,'stopped.json');if(!fs.existsSync(file))persist(file,{at:new Date().toISOString(),error:error.code||error.message,...(error.stopCause?{cause:error.stopCause}:{})});}
function aggregate(output,plan,{active}={}){
 const run=id.read(path.join(output,'run.json'));
 let attempts=0,dispatches=0,tokens=0,reserved=0;
 for(const phase of ['gate','business']){
  const file=path.join(output,phase,'ledger/ledger.json');if(!fs.existsSync(file)){assert.ok(phase===active||!fs.existsSync(path.join(output,phase+'.completed.json')),'Missing prior ledger');continue;}
  const raw=id.read(file),{checksum,...state}=raw;assert.equal(checksum,planHash(state),'Ledger checksum changed');assert.equal(state.identity.planSha256,planHash(plan[phase]));
  assert.equal(state.identity.mode,run.mode);assert.equal(state.identity.sealIdentity,id.SAMPLE);assert.equal(state.identity.authorizationSha256,run.phaseAuthorizationHashes?.[phase]);
  if(state.stop!==null)throw ledgerStopError(state.stop,phase);assert.deepEqual(state.caseStops,{});
  for(const r of state.attempts){assert.ok((phase==='gate'?[plan.gate.protocolGate.id]:plan.business.order).includes(r.caseId));attempts++;if(r.transportPermitted)dispatches++;if(r.usage){const value={...r.usage};if(value.cachedInputTokens===null)delete value.cachedInputTokens;const usage=require('../foundation-business-runner/ledger.cjs').normalizeUsage(value);tokens+=usage.totalTokens;}else if(r.transportPermitted){assert.equal(phase,active);assert.equal(r.status,'pending','Unknown usage');assert.ok(Number.isSafeInteger(r.reservedTokens)&&r.reservedTokens>=0);reserved+=r.reservedTokens;}}
  attempts+=(state.rejectedAfterStop||[]).length;assert.equal((state.rejectedAfterStop||[]).length,0,'Unexpected attempt');
 }
 assert.ok(attempts<=plan.total.applicationAttempts&&dispatches<=plan.total.maximumModelDispatches,'Combined attempt limit');
 assert.ok(tokens+reserved<=plan.total.reportedTokenStopThreshold,'Combined token threshold');
 return {applicationAttempts:attempts,maximumAdmittedDispatches:dispatches,knownTokens:tokens,pendingReservation:reserved};
}
function assertSession(session,phase){assert.ok(capabilities.has(session),'Use the sealed staged entry point');assert.equal(session.phase,phase);session.guard();}
function validateCompleted(output,phase,run,proof){
 const started=id.read(path.join(output,phase+'.started.json')),request=id.read(path.join(output,phase,'phase-review-request.json')),{identity,...body}=request;
 assert.equal(identity,id.sha(JSON.stringify(body)),'Prior review request identity changed');
 for(const v of [started,request,proof]){assert.equal(v.phase,phase);assert.equal(v.runId,run.runId);assert.equal(v.mode,run.mode);assert.equal(v.runnerIdentity,run.runnerIdentity);assert.equal(v.startedAt,started.startedAt);assert.equal(v.deadline,started.deadline);}
 assert.equal(started.deadline-started.startedAt,45*60000);assert.ok(proof.finishedAt>=started.startedAt&&proof.finishedAt<started.deadline);
 assert.equal(request.asarSha256,run.asarSha256);assert.equal(request.summarySha256,proof.summarySha256);assert.deepEqual(request.ledgerHashes,proof.ledgerHashes);assert.deepEqual(request.totals,proof.totals);
 if(run.mode==='live'){const decision=id.read(path.join(output,phase,'phase-review.json'));assert.equal(decision.approved,true);assert.equal(decision.reviewer,'independent-subagent');assert.equal(decision.runId,run.runId);assert.equal(decision.identity,identity);}
}
function begin({phase,output,executable,mode,authorizationPath,readyReference,now=Date.now}){
 assert.ok(ORDER.includes(phase));assert.ok(['offline','live'].includes(mode));assert.ok(typeof readyReference==='string'&&readyReference.trim(),'Explicit stage readiness reference required');
 if(mode==='live')assert.equal(now,Date.now,'Live clock injection forbidden');
 const identity=id.frozen(executable,{complete:true}),plan=identity.plan,seal=id.read(path.join(__dirname,'runner-seal.json'));id.verifyRunner(seal);
 let authorization,authorizationSha256;
 if(mode==='live'){
  const review=id.read(path.join(__dirname,'runner-review.json'));assert.equal(review.approvedForLiveReadiness,true);assert.equal(review.runnerIdentity,seal.identity);assert.equal(review.asarSha256,plan.asarSha256);assert.equal(review.realModelCalls,0);
  assert.ok(path.isAbsolute(authorizationPath));authorization=id.read(authorizationPath);id.validateAuthorization(authorization,plan,seal.identity);authorizationSha256=id.sha(fs.readFileSync(authorizationPath));
 }else assert.equal(authorizationPath,undefined);
 const allowed=path.resolve(id.root,'../foundation-remaining-runs-20261030');
 if(phase==='gate'){
  output=require('../foundation-marker-runner/output.cjs').validateOutput(output,allowed);
  if(mode==='live')require('../foundation-runner/authorization.cjs').claimAuthorization({authorizationPath,authorization,output,runnerIdentity:seal.identity,sealIdentity:id.SAMPLE});
  fs.mkdirSync(output,{recursive:true});persist(path.join(output,'run.json'),{schema:1,mode,runId:authorization?.runId||path.basename(output),output,runnerIdentity:seal.identity,asarSha256:plan.asarSha256,planSha256:planHash(plan),authorizationSha256:authorizationSha256||null,phaseAuthorizationHashes:authorization?Object.fromEntries(['gate','business'].map(p=>[p,planHash(phaseGrant(authorization,plan[p],authorizationSha256))])):{}});
 }else{assert.ok(path.isAbsolute(output));output=fs.realpathSync(output);}
 const run=id.read(path.join(output,'run.json'));
 try{
  assert.equal(run.mode,mode);assert.equal(run.output,output);assert.equal(run.runnerIdentity,seal.identity);assert.equal(run.asarSha256,plan.asarSha256);assert.equal(run.planSha256,planHash(plan));assert.equal(run.authorizationSha256,authorizationSha256||null);
  assert.deepEqual(run.phaseAuthorizationHashes,authorization?Object.fromEntries(['gate','business'].map(p=>[p,planHash(phaseGrant(authorization,plan[p],authorizationSha256))])):{});
  if(mode==='live'){const consumed=id.read(fs.realpathSync(authorizationPath)+'.consumed.json');assert.equal(consumed.runId,run.runId);assert.equal(consumed.outputDirectory,output);assert.equal(consumed.authorizationSha256,authorizationSha256);assert.equal(consumed.runnerIdentity,seal.identity);}
  assert.ok(!fs.existsSync(path.join(output,'STOP'))&&!fs.existsSync(path.join(output,'stopped.json')),'Run is closed');
  const prerequisites={f04:id.verifyPrerequisite(plan)};for(const prior of ORDER.slice(0,ORDER.indexOf(phase))){
   const proof=id.read(path.join(output,prior+'.completed.json')),summaryFile=path.join(output,prior,'summary.json');
   validateCompleted(output,prior,run,proof);
   assert.equal(proof.phase,prior);assert.equal(proof.mode,mode);assert.equal(proof.runnerIdentity,seal.identity);assert.equal(proof.runId,run.runId);assert.ok(proof.finishedAt<=proof.deadline);assert.equal(proof.summarySha256,id.sha(fs.readFileSync(summaryFile)));assert.equal(id.read(summaryFile).passed,true);
   for(const[p,h]of Object.entries(proof.ledgerHashes))assert.equal(ledgerHashes(output)[p],h,'Reviewed ledger changed');
   if(mode==='live'){assert.equal(proof.reviewSha256,id.sha(fs.readFileSync(path.join(output,prior,'phase-review.json'))));assert.equal(proof.actualIndependentReview,true);}
   prerequisites[prior]=Object.freeze({phase:prior,runId:run.runId,mode,completedSha256:id.sha(fs.readFileSync(path.join(output,prior+'.completed.json'))),summarySha256:proof.summarySha256,reviewSha256:proof.reviewSha256,requestSha256:id.sha(fs.readFileSync(path.join(output,prior,'phase-review-request.json'))),ledgerHashes:proof.ledgerHashes});
  }
  assert.ok(!fs.existsSync(path.join(output,phase+'.started.json')),'Stage already started; no replay or deadline reset');
  const startedAt=now(),deadline=startedAt+45*60000,phaseOutput=path.join(output,phase);assert.ok(!fs.existsSync(phaseOutput));
  persist(path.join(output,phase+'.started.json'),{phase,runId:run.runId,mode,startedAt,deadline,readyReference,runnerIdentity:seal.identity});
  const phasePlan=plan[phase],runSha256=id.sha(fs.readFileSync(path.join(output,'run.json')));let lastTime=startedAt;
  const session={phase,output,phaseOutput,mode,plan,stagePlan:phasePlan,seal,identity,runId:run.runId,startedAt,deadline,prerequisites:Object.freeze(prerequisites),
   authorization:authorization&&phasePlan?phaseGrant(authorization,phasePlan,authorizationSha256):undefined,
   guard(){try{assert.equal(id.sha(fs.readFileSync(path.join(output,'run.json'))),runSha256,'Run identity changed');
    for(const prior of ORDER.slice(0,ORDER.indexOf(phase))){const p=prerequisites[prior];for(const[file,expected]of [[prior+'.completed.json',p.completedSha256],[prior+'/summary.json',p.summarySha256],[prior+'/phase-review-request.json',p.requestSha256],...(mode==='live'?[[prior+'/phase-review.json',p.reviewSha256]]:[])])assert.equal(id.sha(fs.readFileSync(path.join(output,file))),expected,'Prior evidence changed during stage');for(const[name,h]of Object.entries(p.ledgerHashes))assert.equal(ledgerHashes(output)[name],h,'Reviewed ledger changed during stage');}
    // Validate persisted identity/ledger first. An existing terminal failure
    // remains the cause even if a later deadline or STOP is also observed.
    aggregate(output,plan,{active:phase});const t=now();assert.ok(t>=lastTime,'Clock moved backwards');lastTime=t;assert.ok(t<deadline,'Fixed phase window expired');assert.ok(!fs.existsSync(path.join(output,'STOP'))&&!fs.existsSync(path.join(phaseOutput,'STOP'))&&!fs.existsSync(path.join(output,'stopped.json')),'Run stopped');}catch(e){fail(output,e);throw e;}},
   fail(error){fail(output,error);},
   async finish(summary){
    id.verifyRunner(seal);id.frozen(executable,{complete:true});
    this.guard();assert.equal(summary.passed,true);assert.equal(summary.mode,mode);const summaryFile=path.join(phaseOutput,'summary.json');assert.deepEqual(id.read(summaryFile),JSON.parse(JSON.stringify(summary)));
    const totals=aggregate(output,plan);assert.equal(totals.pendingReservation,0);
    const request={schema:1,phase,mode,runId:run.runId,runnerIdentity:seal.identity,asarSha256:plan.asarSha256,summarySha256:id.sha(fs.readFileSync(summaryFile)),ledgerHashes:ledgerHashes(output),startedAt,deadline,totals};
    const requestIdentity=id.sha(JSON.stringify(request)),decisionPath=path.join(phaseOutput,'phase-review.json');persist(path.join(phaseOutput,'phase-review-request.json'),{...request,identity:requestIdentity});
    if(mode==='live'){
     console.log(JSON.stringify({event:'phase-independent-review-needed',phase,request:path.join(phaseOutput,'phase-review-request.json'),decision:decisionPath}));
     while(!fs.existsSync(decisionPath)){this.guard();await new Promise(r=>setTimeout(r,200));}
     const decision=id.read(decisionPath);assert.equal(decision.approved,true);assert.equal(decision.reviewer,'independent-subagent');assert.equal(decision.identity,requestIdentity);assert.equal(decision.runId,run.runId);
    }
    this.guard();assert.equal(id.sha(fs.readFileSync(summaryFile)),request.summarySha256);assert.deepEqual(ledgerHashes(output),request.ledgerHashes);persist(path.join(output,phase+'.completed.json'),{phase,mode,runId:run.runId,runnerIdentity:seal.identity,startedAt,deadline,finishedAt:now(),summarySha256:request.summarySha256,ledgerHashes:request.ledgerHashes,totals,actualIndependentReview:mode==='live',reviewSha256:mode==='live'?id.sha(fs.readFileSync(decisionPath)):null});
   }
  };capabilities.add(session);session.guard();return Object.freeze(session);
 }catch(e){fail(output,e);throw e;}
}
module.exports={begin,assertSession,aggregate,persist,fail,validateCompleted};
