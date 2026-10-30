'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const id=require('../evaluations/foundation-minimal-runner/identity.cjs'),session=require('../evaluations/foundation-minimal-runner/session.cjs'),native=require('../evaluations/foundation-minimal-runner/native-receipts.cjs');
const {Ledger,planHash}=require('../evaluations/foundation-business-runner/ledger.cjs');
const plan=id.read(path.join(id.root,'evaluations/foundation-minimal-runner/plan.json'));
function fixture(t){
 const base=path.resolve(id.root,'../foundation-minimal-runs-20261030'),output=path.join(base,'unit-'+crypto.randomUUID());let clock=100000;
 // Unit-only package verification substitute. No executable or model is started.
 t.mock.method(id,'frozen',()=>({plan:structuredClone(plan)}));t.mock.method(id,'verifyRunner',()=>{});
 t.after(()=>{if(fs.existsSync(output)){const real=fs.realpathSync(output),relative=path.relative(fs.realpathSync(base),real);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(real,{recursive:true,force:true});}});
 const begin=phase=>session.begin({phase,output,executable:'unit-no-executable',mode:'offline',readyReference:'UNIT-SYNTHETIC-NOT-USER-APPROVAL',now:()=>clock});
 return {output,begin,clock:value=>clock=value};
}
async function complete(s){fs.mkdirSync(s.phaseOutput);if(s.phase!=='f04')new Ledger({dir:path.join(s.phaseOutput,'ledger'),plan:plan[s.phase],mode:'offline',sealIdentity:id.SAMPLE,conservativeAttemptSlot:true});const summary={passed:true,mode:'offline'};id.write(path.join(s.phaseOutput,'summary.json'),summary);await s.finish(summary);}
function makeLedger(f,phase='gate'){
 const dir=path.join(f.output,phase,'ledger'),ledger=new Ledger({dir,plan:plan[phase],mode:'offline',sealIdentity:id.SAMPLE,conservativeAttemptSlot:true});
 const meta={caseId:phase==='gate'?plan.gate.protocolGate.id:plan.business.order[0],role:'verify',stage:'unit',serializedInputBytes:100,schemaBytes:10,visibleBytes:50};return {ledger,meta,file:path.join(dir,'ledger.json')};
}
function alter(file,fn){const raw=id.read(file);delete raw.checksum;fn(raw);fs.writeFileSync(file,JSON.stringify({...raw,checksum:planHash(raw)}));}
test('fixed plan rejects expanded stage, case and aggregate budgets',()=>{
 id.validatePlan(plan);
 for(const mutate of [p=>p.order.reverse(),p=>p.total.applicationAttempts++,p=>p.total.maximumModelDispatches++,p=>p.total.reportedTokenStopThreshold++,p=>p.business.order.unshift('F04-cenwan-direction'),p=>p.business.caseLimits[0].attempts++,p=>p.gate.budget.dispatchWindowMinutes++,p=>p.f04.modelCalls++]){const copy=structuredClone(plan);mutate(copy);assert.throws(()=>id.validatePlan(copy));}
});
test('old or incomplete user authorizations cannot admit the new suite',()=>{
 const a={schema:1,grantedBy:'user',reference:'UNIT-ONLY',runnerIdentity:'a'.repeat(64),sealIdentity:id.SAMPLE,planSha256:planHash(plan),asarSha256:plan.asarSha256,...plan.total,nonHardCapAccepted:true,humanParticipationConfirmed:true,phaseWindowsMinutes:{f04:45,gate:45,business:45},realCliSha256:plan.cli.sha256};
 id.validateAuthorization(a,plan,a.runnerIdentity);
 for(const mutate of [v=>v.runnerIdentity='b'.repeat(64),v=>v.asarSha256='b'.repeat(64),v=>v.applicationAttempts=40,v=>v.planSha256='b'.repeat(64),v=>v.nonHardCapAccepted=false,v=>v.humanParticipationConfirmed=false,v=>v.phaseWindowsMinutes.business=90,v=>v.realCliSha256='b'.repeat(64),v=>v.reference='']){const copy=structuredClone(a);mutate(copy);assert.throws(()=>id.validateAuthorization(copy,plan,a.runnerIdentity));}
});
test('live clock injection is refused before package, authorization or transport access',()=>{assert.throws(()=>session.begin({phase:'f04',mode:'live',readyReference:'unit',now:()=>0}),/Live clock injection/);});
test('direct engine calls and mixed-mode sessions are refused',async()=>{
 for(const phase of ['f04','gate','business'])await assert.rejects(require('../evaluations/foundation-minimal-runner/'+phase+'-engine.cjs').run({mode:'offline'}));
 await assert.rejects(require('../evaluations/foundation-minimal-runner/gate-engine.cjs').run({mode:'live',session:{mode:'offline'}}));
});
test('stages advance in order with one persisted window each',async t=>{
 const f=fixture(t),first=f.begin('f04');await complete(first);f.clock(101000);const gate=f.begin('gate');assert.equal(gate.startedAt,101000);await complete(gate);f.clock(102000);const business=f.begin('business');assert.equal(business.deadline,102000+45*60000);assert.equal(session.aggregate(f.output,plan).knownTokens,0);
});
test('skipping an unfinished stage permanently stops the run',t=>{const f=fixture(t);f.begin('f04');assert.throws(()=>f.begin('gate'));assert.ok(fs.existsSync(path.join(f.output,'stopped.json')));});
test('stage reentry cannot create a new deadline',async t=>{const f=fixture(t);await complete(f.begin('f04'));const first=f.begin('gate'),bytes=fs.readFileSync(path.join(f.output,'gate.started.json'));assert.throws(()=>f.begin('gate'));assert.deepEqual(fs.readFileSync(path.join(f.output,'gate.started.json')),bytes);assert.throws(()=>first.guard());});
test('expiry includes waits and permanently stops following stages',t=>{const f=fixture(t),s=f.begin('f04');f.clock(s.deadline);assert.throws(()=>s.guard(),/window expired/);f.clock(s.startedAt);assert.throws(()=>s.guard());assert.throws(()=>f.begin('gate'));});
test('clock reversal cannot extend a phase',t=>{const f=fixture(t),s=f.begin('f04');f.clock(s.startedAt-1);assert.throws(()=>s.guard(),/Clock moved backwards/);});
test('STOP file closes the run before a further stage',t=>{const f=fixture(t),s=f.begin('f04');fs.writeFileSync(path.join(f.output,'STOP'),'');assert.throws(()=>s.guard());assert.throws(()=>f.begin('gate'));});
test('completed summary edits prevent the next stage',async t=>{const f=fixture(t);await complete(f.begin('f04'));fs.appendFileSync(path.join(f.output,'f04/summary.json'),' ');assert.throws(()=>f.begin('gate'));});
for(const [name,mutate]of [['mode',s=>s.identity.mode='live'],['sample',s=>s.identity.sealIdentity='b'.repeat(64)],['authorization',s=>s.identity.authorizationSha256='b'.repeat(64)],['foreign-case',s=>s.attempts[0].caseId='F03-botang-notice'],['unknown-usage',s=>{s.attempts[0].usage=null;s.attempts[0].status='usage-unknown';}],['conflicting-usage',s=>s.attempts[0].usage.totalTokens++],['combined-cap',s=>s.attempts=Array.from({length:26},()=>s.attempts[0])]])test(`ledger substitution rejected: ${name}`,t=>{
 const f=fixture(t);f.begin('f04');const {ledger,meta,file}=makeLedger(f),row=ledger.admit(meta);ledger.settle(row.id,{inputTokens:100,outputTokens:20});alter(file,mutate);assert.throws(()=>session.aggregate(f.output,plan,{active:'gate'}));
});
test('pending reservations cannot become completed phase evidence',t=>{const f=fixture(t);f.begin('f04');const {ledger,meta}=makeLedger(f);ledger.admit(meta);assert.ok(session.aggregate(f.output,plan,{active:'gate'}).pendingReservation>0);assert.throws(()=>session.aggregate(f.output,plan));});
test('changed reviewed ledger prevents a later stage even with a recomputed checksum',async t=>{
 const f=fixture(t);await complete(f.begin('f04'));const gate=f.begin('gate'),{ledger,meta,file}=makeLedger(f),row=ledger.admit(meta);ledger.settle(row.id,{inputTokens:100,outputTokens:20});id.write(path.join(gate.phaseOutput,'summary.json'),{passed:true,mode:'offline'});await gate.finish({passed:true,mode:'offline'});alter(file,s=>{s.attempts[0].usage.inputTokens++;s.attempts[0].usage.totalTokens++;});assert.throws(()=>f.begin('business'),/Reviewed ledger changed/);
});
async function nativeFixture(t,{phase='f04',handler=async()=>({data:{tasks:[]}})}={}){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'minimal-native-unit-')),file=path.join(dir,'receipts.jsonl'),handlers=new Map([['assistant:call',handler]]);
 t.after(()=>{delete globalThis.__minimalReceiptConfig;assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
 const electron={ipcMain:{_invokeHandlers:handlers,removeHandler:k=>handlers.delete(k),handle:(k,fn)=>handlers.set(k,fn)},app:{getPath:()=>dir,getAppPath:()=>path.join(dir,'app.asar')},BrowserWindow:{getAllWindows:()=>[]}};
 await native.install({evaluate:(fn,args)=>fn(electron,args)},{file,output:dir,deadline:Date.now()+60000,phase,taskId:'target',runId:'unit',mode:'offline'});
 return {file,dir,invoke:(action,input)=>handlers.get('assistant:call')({sender:{id:1,getURL:()=> 'file:///unit'}},action,input)};
}
test('native handler exception retains received and failure receipts',async t=>{
 const f=await nativeFixture(t,{handler:async()=>{throw Error('UNIT_HANDLER_FAILURE');}});await assert.rejects(f.invoke('uiCommand',{action:'taskAction',input:{id:'target',command:'accept'}}),/UNIT_HANDLER_FAILURE/);const rows=native.records(f.file);assert.deepEqual(rows.map(r=>r.kind),['received','native-exception']);assert.equal(rows[0].invocationId,rows[1].invocationId);assert.ok(fs.existsSync(path.join(f.dir,'stopped.json')));
});
for(const [name,action,input]of [['raw-accept','taskAction',{id:'target',command:'accept'}],['wrong-task','uiCommand',{action:'taskAction',input:{id:'other',command:'accept'}}],['model-advance','advance',{id:'target'}],['marker-recheck','uiCommand',{action:'recheckGroundingMarkers',input:{id:'target'}}]])test(`F04 native boundary rejects ${name} before original handler`,async t=>{
 let calls=0;const f=await nativeFixture(t,{handler:async()=>{calls++;return {data:{}};}}),r=await f.invoke(action,input);assert.equal(r.code,'NATIVE_COMMAND_REFUSED');assert.equal(calls,0);assert.equal(native.records(f.file)[0].kind,'denied');
});
test('business permits its scheduled raw revise and UI marker commands only for the active task',async t=>{
 let calls=0;const f=await nativeFixture(t,{phase:'business',handler:async()=>{calls++;return {data:{tasks:[]}};}});
 await f.invoke('taskAction',{id:'target',command:'revise'});await f.invoke('uiCommand',{action:'confirmGroundingMarkers',input:{id:'target'}});await f.invoke('uiCommand',{action:'recheckGroundingMarkers',input:{id:'target'}});assert.equal(calls,3);await f.invoke('taskAction',{id:'other',command:'revise'});assert.equal(calls,3);
});
for(const reason of ['deadline','STOP'])test(`async admission ${reason} stops before transport`,async()=>{
 let stopped=false,transport=0;const guard=()=>{if(stopped)throw Error(reason);};
 await assert.rejects((async()=>{await require('../evaluations/foundation-minimal-runner/admission.cjs').admit({session:{guard},identityGuard:()=>{},phases:{admit:async()=>{await Promise.resolve();stopped=true;}},call:{},context:{}});transport++;})(),new RegExp(reason));assert.equal(transport,0);
});
test('binding-read or identity drift after admission still stops before transport',async()=>{
 for(const point of ['binding','identity']){let stopped=false,transport=0;const guard=()=>{if(stopped)throw Error('late-stop');};await assert.rejects((async()=>{await require('../evaluations/foundation-minimal-runner/admission.cjs').admit({session:{guard},identityGuard:()=>{if(point==='identity')stopped=true;},phases:{admit:async()=>{}},afterAdmission:async()=>{if(point==='binding'){await Promise.resolve();stopped=true;}}});transport++;})(),/late-stop/);assert.equal(transport,0);}
});
test('subset reporting changes only the declared population and preserves unestimable rates',()=>{
 const scoped=require('../evaluations/foundation-minimal-runner/report.cjs').scoped;
 const source={attemptedFixedInvalidCases:0,attemptedGeneratedCases:2,plannedGeneratedCases:4,plannedFixedInvalidCases:2,quality:{completionPlanned:{numerator:2,denominator:4,rate:0.5},fixedInvalidRelease:{numerator:0,denominator:0,rate:null},invalidGeneratedDraftRelease:{numerator:0,denominator:0,rate:null},qualifiedDraftHardFalseBlock:{numerator:1,denominator:3,rate:1/3}},branchCoverage:{sixCaseWorkflowCompleted:false}};
 const summary={passed:true,results:plan.business.order.map(caseId=>({caseId,lane:'generated'}))},result=scoped(structuredClone(source),summary);
 assert.deepEqual(result.quality.completionPlanned,{numerator:2,denominator:2,rate:1});assert.equal(result.plannedFixedInvalidCases,0);assert.equal(result.branchCoverage.sixCaseWorkflowCompleted,undefined);
 for(const key of ['fixedInvalidRelease','invalidGeneratedDraftRelease','qualifiedDraftHardFalseBlock'])assert.deepEqual(result.quality[key],source.quality[key]);
 assert.throws(()=>scoped(structuredClone(source),{results:[{caseId:'F04-cenwan-direction',lane:'generated'}]}));
});
test('subset offline reporting never fabricates semantic quality',()=>{const s=require('../evaluations/foundation-minimal-runner/report.cjs').scoped({attemptedFixedInvalidCases:0,attemptedGeneratedCases:0,quality:null,qualityStatus:'N/A-synthetic'},{passed:false,results:[]});assert.equal(s.quality,null);assert.equal(s.unattemptedGeneratedCases,2);});
