'use strict';
// Offline only: local Node fixtures and loopback HTTP. Never invoke a model CLI.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {classifyFailureEvent,ledgerStopError}=require('../evaluations/foundation-runner/failure-cause.cjs');
const transport=require('../evaluations/foundation-diagnostic-runner/transport.cjs'),originalTransport=transport.runTransport;
const fixture=require('./fixtures/foundation-cli-routing-timeout-20261030.json'),routing=JSON.parse(fixture.eventLine);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const emit=v=>'process.stdout.write('+JSON.stringify(JSON.stringify(v)+'\n')+');';
const emitBatch=values=>'process.stdout.write('+JSON.stringify(values.map(v=>JSON.stringify(v)+'\n').join(''))+');';
const usage={input_tokens:100,output_tokens:20};
const run=(body,extra={})=>originalTransport({bin:process.execPath,args:['-e',body],input:'offline synthetic fixture',cwd:os.tmpdir(),timeoutMs:10000,idleTimeoutMs:3000,...extra});
function directory(t,prefix='foundation-cause-'){
 const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,prefix));
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(dir)),base);assert.ok(path.basename(dir).startsWith(prefix));fs.rmSync(dir,{recursive:true,force:true});});return dir;
}
test('saved routing event is exactly bound to the historical raw event, not edited to pass',()=>{
 assert.equal(Buffer.byteLength(fixture.eventLine),88);assert.equal(sha(fixture.eventLine),fixture.provenance.rawEventSha256);
 assert.equal(fixture.provenance.rawEventSha256,'32345e942660070888e7e55e44337de7621a23fab06c7643c8f484c380a8ad25');
 assert.equal(fixture.provenance.terminalSha256,'eaf761331fa34f1f87eae33c8f26f4aa340a6d874a0f61c2fcb2807330377aeb');
 assert.equal(fixture.historicalRecordedCode,'CLI_PROTOCOL_REJECTION');assert.equal(fixture.authoritativeUsagePresent,false);
});
test('routing, explicit connection and schema diagnostics are distinguished; unknown errors still fail',()=>{
 assert.equal(classifyFailureEvent(routing).code,'CLI_ROUTING_TIMEOUT');
 assert.equal(classifyFailureEvent({type:'turn.failed',error:{message:routing.message}}).code,'CLI_ROUTING_TIMEOUT');
 assert.equal(classifyFailureEvent({type:'error',code:'ECONNRESET'}).code,'CLI_CONNECTION_ERROR');
 assert.equal(classifyFailureEvent({type:'turn.failed',error:{code:'invalid_json_schema',message:routing.message}}).code,'CLI_SCHEMA_REJECTED');
 assert.equal(classifyFailureEvent({type:'error',message:'Quoted: '+routing.message}).code,'CLI_ERROR_EVENT');
 assert.equal(classifyFailureEvent({type:'error',message:routing.message+' authorization=Bearer SENTINEL'}).code,'CLI_ERROR_EVENT');
 assert.equal(classifyFailureEvent({type:'turn.failed',error:'unknown'}).code,'CLI_TURN_FAILED');
 assert.equal(classifyFailureEvent({type:'turn.completed',message:routing.message}),null);
 assert.equal(classifyFailureEvent({type:'item.completed',item:{text:routing.message}}),null);
});
test('saved event crosses the actual local supervisor and diagnostic collector with unknown usage',async()=>{
 const frames=[];await assert.rejects(run(emit(routing)+'setInterval(()=>{},1000);',{onFrame:f=>frames.push(f)}),e=>{
  assert.equal(e.code,'CLI_ROUTING_TIMEOUT');assert.equal(e.usageUnknown,true);assert.equal(e.usage,undefined);assert.deepEqual(e.rawUsageEvents,[]);assert.equal(e.processTreeConfirmed,true);
  assert.equal(e.diagnostics.events[0].rawEventSha256,fixture.provenance.rawEventSha256);assert.equal(e.diagnostics.events[0].details.message,routing.message);assert.equal(e.diagnostics.terminal.failureCode,e.code);return true;
 });assert.equal(frames.filter(f=>f.channel==='stdout').map(f=>f.data).join(''),fixture.eventLine+'\n');
});
test('first event remains the cause and later valid usage is retained without turning failure into success',async()=>{
 await assert.rejects(run(emitBatch([routing,{type:'error',message:'later unknown'},{type:'turn.completed',usage}])+'setInterval(()=>{},1000);'),e=>{
  assert.equal(e.code,'CLI_ROUTING_TIMEOUT');assert.equal(e.usageUnknown,false);assert.equal(e.usage.totalTokens,120);assert.equal(e.diagnostics.events.length,2);return true;
 });
});
test('authoritative usage before an error stays known; conflicting usage never becomes a zero',async()=>{
 for(const conflict of [false,true])await assert.rejects(run(emitBatch([{type:'turn.completed',usage},routing,...(conflict?[{type:'turn.completed',usage:{input_tokens:101,output_tokens:20}}]:[])])+'setInterval(()=>{},1000);'),e=>{
  assert.equal(e.code,'CLI_ROUTING_TIMEOUT');assert.equal(e.usageUnknown,conflict);assert.equal(e.usage?.totalTokens,conflict?undefined:120);assert.equal(e.rawUsageEvents.length,conflict?2:1);return true;
 });
});
for(const [name,body,code]of [
 ['connection',emit({type:'error',code:'ETIMEDOUT'}),'CLI_CONNECTION_ERROR'],
 ['schema',emit({type:'turn.failed',error:{code:'invalid_json_schema'}}),'CLI_SCHEMA_REJECTED'],
 ['unknown error',emit({type:'error',message:'not classified'}),'CLI_ERROR_EVENT'],
 ['failed turn',emit({type:'turn.failed',error:{message:'not classified'}}),'CLI_TURN_FAILED'],
 ['malformed JSON',"process.stdout.write('invalid-json\\n');",'CLI_PROTOCOL_JSON'],
 ['missing event type',emit({message:'invalid event'}),'CLI_PROTOCOL_EVENT'],
])test(name+' stops the actual local process with no invented usage',async()=>{
 await assert.rejects(run(body+'setInterval(()=>{},1000);'),e=>e.code===code&&e.usageUnknown===true&&e.usage===undefined&&e.processTreeConfirmed===true);
});
test('new classification and ledger cause never copy credentials or request text',async()=>{
 const secret='SYNTHETIC_NEW_CAUSE_SECRET',message='Upstream error; authorization=Bearer '+secret;
 await assert.rejects(run(emit({type:'error',message})+'setInterval(()=>{},1000);'),e=>{assert.equal(e.code,'CLI_ERROR_EVENT');assert.ok(!JSON.stringify(e).includes(secret));assert.ok(!e.message.includes(secret));return true;});
 const e=ledgerStopError({code:'LEDGER_FAILURE',reason:message},'business');assert.equal(e.code,'RUNNER_LEDGER_STOPPED');assert.equal(e.stopCause.reasonSha256,sha(message));assert.ok(!JSON.stringify(e).includes(secret));assert.equal(e.cause.code,'LEDGER_FAILURE');
});
test('local transport -> actual broker -> ledger -> session keeps first cause and refuses redispatch',async t=>{
 const directoryRoot=directory(t),modelCwd=directory(t,'xingzhi-model-');
 const plan=require('../evaluations/foundation-remaining-runner/plan.json'),protocol=require('../desktop/subscription-protocol.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs');
 const businessOutput=path.join(directoryRoot,'business'),context={id:plan.business.order[0],evaluationPhase:'initial',taskId:'offline-task',title:'offline task',description:'offline',criteria:'offline',sources:[]};
 let dispatched=0; t.mock.method(transport,'runTransport',options=>{assert.equal(options.bin,process.execPath);dispatched++;return originalTransport({...options,args:['-e',emit(routing)+'setInterval(()=>{},1000);']});});
 const brokerFile=require.resolve('../evaluations/foundation-business-runner/broker.cjs');delete require.cache[brokerFile];t.after(()=>delete require.cache[brokerFile]);
 const broker=await require(brokerFile).createBroker({directory:businessOutput,plan:plan.business,mode:'offline',sealIdentity:plan.sourceSampleIdentity,identityGuard:()=>{},admission:async()=>{},responseObserved:()=>{assert.fail('No output may be accepted');},fixture:async()=>({kind:'artifact',title:'unused fixture',content:'unused fixture'})});
 t.after(()=>broker.close());broker.setContext(context);
 fs.writeFileSync(path.join(directoryRoot,'run.json'),JSON.stringify({mode:'offline',phaseAuthorizationHashes:{}}));
 const schemaFile=path.join(modelCwd,'schema.json'),outputFile=path.join(modelCwd,'response.json');
 fs.writeFileSync(schemaFile,JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false}));
 const args=['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',plan.business.model.id,...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(plan.business.model.reasoning)}`,'--output-schema',schemaFile,'--output-last-message',outputFile,'-'];
 const input=protocol.serialize([{role:'system',content:'offline only'},{role:'user',content:JSON.stringify({task:{id:context.taskId,title:context.title,description:context.description,criteria:context.criteria,sourceIds:[]},sources:[]})}]);
 const post=async()=>{const r=await fetch(broker.bridgeConfig.url,{method:'POST',headers:{'X-Runner-Nonce':broker.bridgeConfig.nonce},body:JSON.stringify({args,input,cwd:modelCwd})});return (await r.text()).trim().split('\n').map(JSON.parse);};
 assert.equal((await post()).at(-1).code,78);assert.equal(dispatched,1);assert.equal(broker.stopped,true);
 const state=broker.ledger.snapshot();assert.equal(state.stop.reason,'CLI_ROUTING_TIMEOUT');assert.equal(state.totals.totalTokens,null);assert.equal(state.totals.unknownUsage,1);
 const terminal=JSON.parse(fs.readFileSync(path.join(businessOutput,'calls',broker.rows[0].attemptId+'-terminal.json')));assert.equal(terminal.error,'CLI_ROUTING_TIMEOUT');assert.equal(terminal.rawOutput,null);assert.equal(terminal.diagnostics.events[0].rawEventSha256,fixture.provenance.rawEventSha256);
 let primary;try{session.aggregate(directoryRoot,plan,{active:'business'});}catch(e){primary=e;session.fail(directoryRoot,e);}
 assert.equal(primary.code,'CLI_ROUTING_TIMEOUT');assert.equal(primary.cause.code,'LEDGER_FAILURE');const first=fs.readFileSync(path.join(directoryRoot,'stopped.json'));
 const stopped=JSON.parse(first);assert.equal(stopped.error,'CLI_ROUTING_TIMEOUT');assert.deepEqual(stopped.cause,{phase:'business',code:'CLI_ROUTING_TIMEOUT',ledgerCode:'LEDGER_FAILURE',reasonSha256:sha('CLI_ROUTING_TIMEOUT')});
 broker.cancel('LATE_CANCEL');session.fail(directoryRoot,Object.assign(Error('later guard'),{code:'ERR_ASSERTION'}));assert.deepEqual(fs.readFileSync(path.join(directoryRoot,'stopped.json')),first);
 assert.equal((await post()).at(-1).code,78);assert.equal(dispatched,1);assert.equal(broker.ledger.snapshot().stop.reason,'CLI_ROUTING_TIMEOUT');assert.equal(broker.ledger.snapshot().totals.unknownUsage,1);assert.equal(broker.ledger.snapshot().totals.totalTokens,null);assert.equal(broker.ledger.snapshot().rejectedAfterStop.length,1);
});
for(const known of [false,true])test('actual session guard records the original stop and keeps '+(known?'known':'unknown')+' usage',t=>{
 const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs'),{Ledger}=require('../evaluations/foundation-business-runner/ledger.cjs');
 const plan=require('../evaluations/foundation-remaining-runner/plan.json'),base=path.resolve(id.root,'../foundation-remaining-runs-20261030'),output=path.join(base,'unit-cause-'+crypto.randomUUID());
 t.mock.method(id,'frozen',()=>({plan:structuredClone(plan)}));t.mock.method(id,'verifyRunner',()=>{});
 t.after(()=>{if(fs.existsSync(output)){assert.equal(path.dirname(fs.realpathSync(output)),fs.realpathSync(base));fs.rmSync(output,{recursive:true,force:true});}});
 const s=session.begin({phase:'gate',mode:'offline',output,executable:'unused',readyReference:'UNIT-NO-USER-AUTHORIZATION'});
 const ledger=new Ledger({dir:path.join(s.phaseOutput,'ledger'),plan:plan.gate,mode:'offline',sealIdentity:id.SAMPLE,conservativeAttemptSlot:true});
 const row=ledger.admit({caseId:plan.gate.protocolGate.id,role:'execute',stage:'unit',serializedInputBytes:100,schemaBytes:10,visibleBytes:50});
 if(known)ledger.settle(row.id,{inputTokens:100,outputTokens:20});ledger.fail(row.id,'CLI_ROUTING_TIMEOUT');
 assert.throws(()=>s.guard(),e=>e.code==='CLI_ROUTING_TIMEOUT'&&e.cause.code==='LEDGER_FAILURE');
 const first=fs.readFileSync(path.join(output,'stopped.json'));assert.equal(JSON.parse(first).cause.code,'CLI_ROUTING_TIMEOUT');
 ledger.stop('LATE_CANCEL');assert.throws(()=>s.guard());assert.deepEqual(fs.readFileSync(path.join(output,'stopped.json')),first);
 assert.equal(ledger.snapshot().totals.totalTokens,known?120:null);assert.equal(ledger.snapshot().totals.unknownUsage,known?0:1);
});
for(const [terminal,later,expected]of [[true,'deadline','CLI_ROUTING_TIMEOUT'],[true,'STOP','CLI_ROUTING_TIMEOUT'],[true,'clock','CLI_ROUTING_TIMEOUT'],[false,'deadline','ERR_ASSERTION'],[false,'deadline-during-validation','ERR_ASSERTION'],[true,'identity','ERR_ASSERTION'],[true,'checksum','ERR_ASSERTION']])test(`first failure precedence: terminal=${terminal}, later=${later}`,t=>{
 const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs'),{Ledger}=require('../evaluations/foundation-business-runner/ledger.cjs');
 const plan=require('../evaluations/foundation-remaining-runner/plan.json'),base=path.resolve(id.root,'../foundation-remaining-runs-20261030'),output=path.join(base,'unit-cause-'+crypto.randomUUID());let clock=Date.now();
 t.mock.method(id,'frozen',()=>({plan:structuredClone(plan)}));t.mock.method(id,'verifyRunner',()=>{});
 t.after(()=>{if(fs.existsSync(output)){assert.equal(path.dirname(fs.realpathSync(output)),fs.realpathSync(base));fs.rmSync(output,{recursive:true,force:true});}});
 const s=session.begin({phase:'gate',mode:'offline',output,executable:'unused',readyReference:'UNIT-NO-USER-AUTHORIZATION',now:()=>clock});
 const ledger=new Ledger({dir:path.join(s.phaseOutput,'ledger'),plan:plan.gate,mode:'offline',sealIdentity:id.SAMPLE,conservativeAttemptSlot:true});
 const row=ledger.admit({caseId:plan.gate.protocolGate.id,role:'execute',stage:'unit',serializedInputBytes:100,schemaBytes:10,visibleBytes:50});if(terminal)ledger.fail(row.id,'CLI_ROUTING_TIMEOUT');
 if(later==='deadline')clock=s.deadline;
 if(later==='deadline-during-validation'){const original=id.sha;t.mock.method(id,'sha',value=>{clock=s.deadline;return original(value);});}
 if(later==='clock')clock=s.startedAt-1;
 if(later==='STOP')fs.writeFileSync(path.join(output,'STOP'),'');
 if(later==='identity')fs.appendFileSync(path.join(output,'run.json'),' ');
 if(later==='checksum'){const file=path.join(s.phaseOutput,'ledger/ledger.json'),raw=JSON.parse(fs.readFileSync(file));raw.stop.reason='FORGED_REASON';fs.writeFileSync(file,JSON.stringify(raw));}
 let problem;try{s.guard();}catch(e){problem=e;}
 assert.equal(problem?.code,expected);assert.equal(JSON.parse(fs.readFileSync(path.join(output,'stopped.json'))).error,expected);
 if(!terminal)assert.match(problem.message,/Fixed phase window expired/);
 if(later==='identity')assert.match(problem.message,/Run identity changed/);
 if(later==='checksum')assert.match(problem.message,/Ledger checksum changed/);
});
test('modified checkout rejects the old live seal before any authorization is consumed or CLI is spawned',t=>{
 const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs'),cp=require('node:child_process');
 const dir=directory(t),auth=path.join(dir,'authorization.json');fs.writeFileSync(auth,'{}');
 // Avoid reading the large candidate archive in this unit test. Seal validation
 // is the real implementation and must reject the actual changed source tree.
 t.mock.method(id,'frozen',()=>({plan:require('../evaluations/foundation-remaining-runner/plan.json')}));
 for(const method of ['spawn','spawnSync','execFileSync'])t.mock.method(cp,method,()=>assert.fail('No process allowed at the sealed entry'));
 assert.throws(()=>session.begin({phase:'gate',mode:'live',readyReference:'OFFLINE UNIT ONLY',authorizationPath:auth,output:path.join(dir,'unused'),executable:'unused'}),/runner\/dependency drift/i);
 assert.equal(fs.existsSync(auth+'.consumed.json'),false);assert.equal(fs.existsSync(path.join(dir,'unused')),false);assert.equal(fs.readFileSync(auth,'utf8'),'{}');
});
