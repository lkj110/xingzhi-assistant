'use strict';
// Real loopback broker, synthetic fixtures only; no login or model executable.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createBroker}=require('./broker.cjs'),guard=require('./protocol-guard.cjs'),protocol=require('../../desktop/subscription-protocol.cjs');
const {project}=require('../foundation-acceptance-20261028/inputs.cjs'),plan=require('../foundation-acceptance-20261028/plan.json');
async function setup(t,fixture){
 const tmp=fs.realpathSync.native(os.tmpdir()),cwd=fs.mkdtempSync(path.join(tmp,'xingzhi-model-path-broker-')),directory=fs.mkdtempSync(path.join(tmp,'foundation-broker-audit-'));
 const schema=path.join(cwd,'schema.json'),output=path.join(cwd,'response.json');fs.writeFileSync(schema,JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false}));
 const input=project(plan.protocolGate),sources=input.sources.map((s,i)=>({...s,id:'source-'+i})),context={id:plan.protocolGate.id,taskId:'gate-path-test',...input,sources};
 const payload={task:{id:context.taskId,title:input.title,description:input.description,criteria:input.criteria,sourceIds:sources.map(s=>s.id)},sources};
 const body={cwd,args:['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',plan.model.id,...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(plan.model.reasoning)}`,'--output-schema',schema,'--output-last-message',output,'-'],input:protocol.serialize([{role:'system',content:'Synthetic broker path test'},{role:'user',content:JSON.stringify(payload)}])};
 let fixtureCalls=0;const broker=await createBroker({directory,plan,mode:'offline',sealIdentity:'a'.repeat(64),identityGuard:()=>{},fixture:async call=>{fixtureCalls++;return fixture?fixture(call):{kind:'artifact',title:'合成稿',content:'仅用于本地路径回归。'};}});broker.setContext(context);
 t.after(async()=>{await broker.close();for(const target of [cwd,directory]){const resolved=fs.realpathSync.native(target);assert.equal(path.dirname(resolved),tmp);assert.ok(/^(xingzhi-model-path-broker-|foundation-broker-audit-)/.test(path.basename(resolved)));fs.rmSync(resolved,{recursive:true,force:true});}});
 return {body,broker,cwd,schema,output,directory,get fixtureCalls(){return fixtureCalls;},async send(){const response=await fetch(broker.bridgeConfig.url,{method:'POST',headers:{'X-Runner-Nonce':broker.bridgeConfig.nonce},body:JSON.stringify(body)});return (await response.text()).trim().split('\n').map(s=>JSON.parse(s));},terminal(){const files=fs.readdirSync(path.join(directory,'calls')).filter(f=>f.endsWith('-terminal.json'));assert.equal(files.length,1);return JSON.parse(fs.readFileSync(path.join(directory,'calls',files[0])));}};
}
test('successful local request preserves original and canonical path proof',async t=>{
 const f=await setup(t);const frames=await f.send(),terminal=f.terminal();assert.equal(frames.at(-1).code,0);assert.equal(f.fixtureCalls,1);assert.equal(f.broker.stopped,false);
 assert.equal(terminal.transportDispatched,false);assert.equal(terminal.synthetic,true);assert.equal(terminal.pathDiagnostics.cwd.raw,f.cwd);assert.equal(terminal.pathDiagnostics.cwd.canonical,fs.realpathSync.native(f.cwd));assert.equal(typeof terminal.rawOutput,'string');
});
test('escaped output is refused with path-only diagnostics before admission',async t=>{
 const f=await setup(t);f.body.args[f.body.args.indexOf('--output-last-message')+1]=path.join(f.directory,'response.json');const frames=await f.send(),terminal=f.terminal(),totals=f.broker.ledger.snapshot().totals;
 assert.equal(frames.at(-1).code,78);assert.equal(f.fixtureCalls,0);assert.equal(terminal.error,'RUNNER_PATH_OUTSIDE');assert.equal(terminal.failureStage,'invocation');assert.equal(terminal.pathValidationStage,'path-capture');assert.equal(terminal.transportDispatched,false);assert.equal(terminal.rawOutput,null);
 assert.equal(totals.attempts,1);assert.equal(totals.admitted,0);assert.equal(totals.totalTokens,0);assert.ok(terminal.pathDiagnostics.output.raw.endsWith('response.json'));
 const text=JSON.stringify(terminal.pathDiagnostics);assert.ok(!text.includes(f.body.input));assert.ok(!text.includes(f.broker.bridgeConfig.nonce));assert.deepEqual(Object.keys(terminal.pathDiagnostics).sort(),['cwd','output','schema','temporaryRoot']);
});
test('schema replacement after capture is one failed attempt with proven zero usage',async t=>{
 const f=await setup(t),original=guard.request;t.after(()=>{guard.request=original;});guard.request=(...args)=>{const result=original(...args);fs.writeFileSync(f.schema,'{}');return result;};
 const frames=await f.send(),terminal=f.terminal(),ledger=f.broker.ledger.snapshot();assert.equal(frames.at(-1).code,78);assert.equal(f.fixtureCalls,0);assert.equal(terminal.error,'RUNNER_PATH_CHANGED');assert.equal(terminal.failureStage,'path-before-dispatch');assert.equal(terminal.usageSource,'not_dispatched');assert.equal(terminal.rawOutput,null);
 assert.equal(ledger.totals.attempts,1);assert.equal(ledger.totals.totalTokens,0);assert.equal(ledger.totals.unknownUsage,0);assert.equal(ledger.attempts[0].status,'failed-known-usage');
});
test('result-time schema tampering retains synthetic usage but refuses release and raw output',async t=>{
 const f=await setup(t),original=guard.response;t.after(()=>{guard.response=original;});guard.response=(...args)=>{const result=original(...args);fs.writeFileSync(f.schema,'{}');return result;};
 const frames=await f.send(),terminal=f.terminal(),totals=f.broker.ledger.snapshot().totals;assert.equal(frames.at(-1).code,78);assert.equal(f.fixtureCalls,1);assert.equal(terminal.error,'RUNNER_PATH_CHANGED');assert.equal(terminal.failureStage,'terminal-audit');assert.equal(terminal.rawOutput,null);assert.equal(terminal.outputReadError,'RUNNER_PATH_CHANGED');assert.ok(totals.totalTokens>0);assert.equal(totals.unknownUsage,0);
});
