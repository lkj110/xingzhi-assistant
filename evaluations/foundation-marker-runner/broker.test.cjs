'use strict';
// Real loopback broker, synthetic fixtures only; no login or model executable.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createBroker}=require('./broker.cjs'),guard=require('../foundation-runner/protocol-guard.cjs'),protocol=require('../../desktop/subscription-protocol.cjs');
const {project}=require('../foundation-acceptance-20261028/inputs.cjs'),plan=require('../foundation-acceptance-20261028/plan.json');
async function setup(t,fixture,options={}){
 const tmp=fs.realpathSync.native(os.tmpdir()),cwd=fs.mkdtempSync(path.join(tmp,'xingzhi-model-path-broker-')),directory=fs.mkdtempSync(path.join(tmp,'foundation-broker-audit-'));
 const schema=path.join(cwd,'schema.json'),output=path.join(cwd,'response.json');fs.writeFileSync(schema,JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false}));
 const input=project(plan.protocolGate),sources=input.sources.map((s,i)=>({...s,id:'source-'+i})),context={id:options.caseId||plan.protocolGate.id,evaluationPhase:'initial-test',taskId:'gate-path-test',...input,sources};
 const payload={task:{id:context.taskId,title:input.title,description:input.description,criteria:input.criteria,sourceIds:sources.map(s=>s.id)},sources};
 const body={cwd,args:['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',plan.model.id,...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(plan.model.reasoning)}`,'--output-schema',schema,'--output-last-message',output,'-'],input:protocol.serialize([{role:'system',content:'Synthetic broker path test'},{role:'user',content:JSON.stringify(payload)}])};
 let fixtureCalls=0;const broker=await createBroker({directory,plan:options.plan||plan,mode:'offline',sealIdentity:'a'.repeat(64),identityGuard:()=>{},admission:options.admission||(()=>{}),responseObserved:()=>{},fault:options.fault,fixture:async call=>{fixtureCalls++;return fixture?fixture(call):{kind:'artifact',title:'合成稿',content:'仅用于本地路径回归。'};}});broker.setContext(context);
 t.after(async()=>{await broker.close();for(const target of [cwd,directory]){const resolved=fs.realpathSync.native(target);assert.equal(path.dirname(resolved),tmp);assert.ok(/^(xingzhi-model-path-broker-|foundation-broker-audit-)/.test(path.basename(resolved)));fs.rmSync(resolved,{recursive:true,force:true});}});
 return {body,broker,cwd,schema,output,directory,get fixtureCalls(){return fixtureCalls;},async send(){const response=await fetch(broker.bridgeConfig.url,{method:'POST',headers:{'X-Runner-Nonce':broker.bridgeConfig.nonce},body:JSON.stringify(body)});return (await response.text()).trim().split('\n').map(s=>JSON.parse(s));},terminal(){const files=fs.readdirSync(path.join(directory,'calls')).filter(f=>f.endsWith('-terminal.json'));assert.equal(files.length,1);return JSON.parse(fs.readFileSync(path.join(directory,'calls',files[0])));}};
}

test('protocol budget refusal stops entire round and counts late requests',async t=>{
 const altered=structuredClone(plan);altered.budget.protocolTokenStopThreshold=1;altered.budget.reportedTokenStopThreshold=1+altered.budget.businessTokenStopThreshold;
 const f=await setup(t,undefined,{plan:altered});await f.send();assert.equal(f.broker.stopped,true);assert.equal(f.fixtureCalls,0);
 const before=f.broker.ledger.snapshot();assert.equal(before.totals.applicationEntryAttempts,1);
 await f.send();const after=f.broker.ledger.snapshot();assert.equal(after.totals.applicationEntryAttempts,2);assert.equal(after.totals.unexpectedAttempts,1);assert.equal(f.fixtureCalls,0);
});
test('human-wait phase refuses dispatch with proven zero remote usage',async t=>{
 const f=await setup(t,undefined,{admission:()=>{throw Error('WAITING_FOR_HUMAN');}});await f.send();assert.equal(f.broker.stopped,true);assert.equal(f.fixtureCalls,0);assert.equal(f.broker.ledger.snapshot().totals.totalTokens,0);
});
test('unknown usage stops once and remains unknown',async t=>{
 const f=await setup(t,undefined,{fault:'unknown-usage'});await f.send();const s=f.broker.ledger.snapshot();assert.equal(f.fixtureCalls,1);assert.equal(f.broker.stopped,true);assert.equal(s.totals.totalTokens,null);assert.equal(s.totals.unknownUsage,1);assert.equal(f.terminal().evaluationPhase,'initial-test');
});
test('new pack gold sentinel is forbidden before forwarding',async t=>{
 const f=await setup(t);f.body.input=f.body.input.replace('Synthetic broker path test','FOUNDATION_MARKER_GOLD_ONLY_TEST');await f.send();assert.equal(f.fixtureCalls,0);assert.equal(f.broker.stopped,true);
});

test('business case budget refusal stops globally before fixture dispatch',async t=>{
 const altered=structuredClone(plan),id=altered.caseLimits[0].id;altered.caseLimits[0].tokenStopThreshold=1;altered.budget.businessTokenStopThreshold=altered.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0);altered.budget.reportedTokenStopThreshold=altered.budget.protocolTokenStopThreshold+altered.budget.businessTokenStopThreshold;
 const f=await setup(t,undefined,{plan:altered,caseId:id});await f.send();const ledger=f.broker.ledger.snapshot();assert.equal(f.broker.stopped,true);assert.equal(f.fixtureCalls,0);assert.equal(ledger.caseStops[id].code,'LEDGER_CASE_BUDGET');assert.equal(f.terminal().evaluationPhase,'initial-test');
});
test('stage attribution survives successful and malformed responses',async t=>{
 const good=await setup(t);await good.send();assert.equal(good.terminal().evaluationPhase,'initial-test');
 const bad=await setup(t,undefined,{fault:'malformed-inner'});await bad.send();assert.equal(bad.terminal().evaluationPhase,'initial-test');assert.ok(bad.broker.ledger.snapshot().totals.totalTokens>0);
});
