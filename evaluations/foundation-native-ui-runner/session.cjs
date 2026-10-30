'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),id=require('./identity.cjs');
const sessions=new WeakSet();
function persist(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function fail(output,error){if(!fs.existsSync(path.join(output,'stopped.json')))persist(path.join(output,'stopped.json'),{error:error.code||error.message,at:new Date().toISOString()});}
function begin({executable,output,mode,authorizationPath,readyReference,now=Date.now}){
 assert.ok(['offline','live'].includes(mode));assert.ok(typeof readyReference==='string'&&readyReference.trim());if(mode==='live')assert.equal(now,Date.now);
 const identity=id.frozen(executable,{complete:true}),plan=identity.plan,seal=id.read(path.join(__dirname,'runner-seal.json'));id.verifyRunner(seal);
 output=require('../foundation-marker-runner/output.cjs').validateOutput(output,path.resolve(id.root,'../foundation-native-ui-runs-20261030'));
 let authorization,authorizationSha256;
 if(mode==='live'){
  const review=id.read(path.join(__dirname,'runner-review.json'));assert.equal(review.approvedForLiveReadiness,true);assert.equal(review.runnerIdentity,seal.identity);assert.equal(review.asarSha256,plan.asarSha256);assert.equal(review.realModelCalls,0);
  assert.ok(path.isAbsolute(authorizationPath));authorization=id.read(authorizationPath);id.validateAuthorization(authorization,plan,seal.identity);authorizationSha256=id.sha(fs.readFileSync(authorizationPath));
  require('../foundation-runner/authorization.cjs').claimAuthorization({authorizationPath,authorization,output,runnerIdentity:seal.identity,sealIdentity:id.SAMPLE});
 }else assert.equal(authorizationPath,undefined);
 fs.mkdirSync(output,{recursive:true});const startedAt=now(),deadline=startedAt+plan.budget.windowMinutes*60000,runId=authorization?.runId||path.basename(output),phaseOutput=path.join(output,'f04');let last=startedAt;
 persist(path.join(output,'run.json'),{schema:1,runId,mode,scope:plan.scope,runnerIdentity:seal.identity,asarSha256:plan.asarSha256,authorizationSha256:authorizationSha256||null});
 persist(path.join(output,'f04.started.json'),{runId,mode,startedAt,deadline,readyReference,runnerIdentity:seal.identity});
 const s={phase:'f04',mode,output,phaseOutput,identity,plan,seal,runId,startedAt,deadline,
  guard(){try{const t=now();assert.ok(t>=last,'Clock moved backwards');last=t;assert.ok(t<deadline,'Fixed phase window expired');assert.ok(!['STOP','stopped.json','f04/STOP'].some(p=>fs.existsSync(path.join(output,p))),'Run stopped');}catch(e){fail(output,e);throw e;}},
  fail(e){fail(output,e);},
  async finish(summary){
   this.guard();id.verifyRunner(seal);id.frozen(executable,{complete:true});assert.equal(summary.passed,true);assert.equal(summary.mode,mode);assert.equal(summary.realModelCalls,0);assert.equal(summary.modelCallsAdded,0);assert.equal(summary.transportAttempts.length,0);assert.equal(summary.actualHumanAcceptance,mode==='live');
   const file=path.join(phaseOutput,'summary.json');assert.deepEqual(id.read(file),JSON.parse(JSON.stringify(summary)));
   const request={schema:1,runId,mode,runnerIdentity:seal.identity,asarSha256:plan.asarSha256,summarySha256:id.sha(fs.readFileSync(file)),startedAt,deadline};request.identity=id.sha(JSON.stringify(request));persist(path.join(phaseOutput,'phase-review-request.json'),request);
   if(mode==='live'){
    const decision=path.join(phaseOutput,'phase-review.json');console.log(JSON.stringify({event:'independent-review-needed',request:path.join(phaseOutput,'phase-review-request.json'),decision}));
    while(!fs.existsSync(decision)){this.guard();await new Promise(r=>setTimeout(r,200));}
    const d=id.read(decision);assert.equal(d.approved,true);assert.equal(d.identity,request.identity);assert.equal(d.runId,runId);assert.equal(d.reviewer,'independent-subagent');
   }
   this.guard();assert.equal(id.sha(fs.readFileSync(file)),request.summarySha256);persist(path.join(output,'f04.completed.json'),{...request,finishedAt:now(),actualIndependentReview:mode==='live',reviewSha256:mode==='live'?id.sha(fs.readFileSync(path.join(phaseOutput,'phase-review.json'))):null});
  }
 };sessions.add(s);s.guard();return Object.freeze(s);
}
function assertSession(s,phase){assert.ok(sessions.has(s),'Use the one-shot F04 entry point');assert.equal(phase,'f04');assert.equal(s.phase,phase);s.guard();}
module.exports={begin,assertSession,persist,fail};
