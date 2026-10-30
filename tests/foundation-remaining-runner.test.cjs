'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),session=require('../evaluations/foundation-remaining-runner/session.cjs'),native=require('../evaluations/foundation-remaining-runner/native.cjs');
const {Ledger,planHash}=require('../evaluations/foundation-business-runner/ledger.cjs');
const plan=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json'));
function fixture(t){
 const base=path.resolve(id.root,'../foundation-remaining-runs-20261030'),output=path.join(base,'unit-'+crypto.randomUUID());let clock=100000;
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
 for(const mutate of [p=>p.order.reverse(),p=>p.total.applicationAttempts++,p=>p.total.maximumModelDispatches++,p=>p.total.reportedTokenStopThreshold++,p=>p.business.order.unshift('F04-cenwan-direction'),p=>p.business.caseLimits[0].attempts++,p=>p.gate.budget.dispatchWindowMinutes++,p=>p.f04={}]){const copy=structuredClone(plan);mutate(copy);assert.throws(()=>id.validatePlan(copy));}
});
test('old or incomplete user authorizations cannot admit the new suite',()=>{
 const a={schema:1,grantedBy:'user',reference:'UNIT-ONLY',scope:plan.scope,f04PrerequisiteIdentity:id.verifyPrerequisite(plan).identity,runnerIdentity:'a'.repeat(64),sealIdentity:id.SAMPLE,planSha256:planHash(plan),asarSha256:plan.asarSha256,...plan.total,nonHardCapAccepted:true,humanParticipationConfirmed:true,phaseWindowsMinutes:{gate:45,business:45},realCliSha256:plan.cli.sha256};
 id.validateAuthorization(a,plan,a.runnerIdentity);
 for(const mutate of [v=>v.runnerIdentity='b'.repeat(64),v=>v.asarSha256='b'.repeat(64),v=>v.applicationAttempts=40,v=>v.planSha256='b'.repeat(64),v=>v.nonHardCapAccepted=false,v=>v.humanParticipationConfirmed=false,v=>v.phaseWindowsMinutes.business=90,v=>v.realCliSha256='b'.repeat(64),v=>v.reference='']){const copy=structuredClone(a);mutate(copy);assert.throws(()=>id.validateAuthorization(copy,plan,a.runnerIdentity));}
});
test('live clock injection is refused before package, authorization or transport access',()=>{assert.throws(()=>session.begin({phase:'gate',mode:'live',readyReference:'unit',now:()=>0}),/Live clock injection/);});
test('direct engine calls and mixed-mode sessions are refused',async()=>{
 for(const phase of ['gate','business'])await assert.rejects(require('../evaluations/foundation-remaining-runner/'+phase+'-engine.cjs').run({mode:'offline'}));
 await assert.rejects(require('../evaluations/foundation-remaining-runner/gate-engine.cjs').run({mode:'live',session:{mode:'offline'}}));
});
test('stages advance in order with one persisted window each',async t=>{
 const f=fixture(t),gate=f.begin('gate');assert.ok(gate.prerequisites.f04.identity);await complete(gate);f.clock(102000);const business=f.begin('business');assert.equal(business.deadline,102000+45*60000);assert.ok(!fs.existsSync(path.join(f.output,'f04.started.json')));assert.equal(session.aggregate(f.output,plan).knownTokens,0);
});
test('skipping an unfinished stage permanently stops the run',t=>{const f=fixture(t);f.begin('gate');assert.throws(()=>f.begin('business'));assert.ok(fs.existsSync(path.join(f.output,'stopped.json')));});
test('stage reentry cannot create a new deadline',async t=>{const f=fixture(t);const first=f.begin('gate'),bytes=fs.readFileSync(path.join(f.output,'gate.started.json'));assert.throws(()=>f.begin('gate'));assert.deepEqual(fs.readFileSync(path.join(f.output,'gate.started.json')),bytes);assert.equal(first.deadline,first.startedAt+2700000);});
test('expiry includes waits and permanently stops following stages',t=>{const f=fixture(t),s=f.begin('gate');f.clock(s.deadline);assert.throws(()=>s.guard(),/window expired/);f.clock(s.startedAt);assert.throws(()=>s.guard());assert.throws(()=>f.begin('business'));});
test('clock reversal cannot extend a phase',t=>{const f=fixture(t),s=f.begin('gate');f.clock(s.startedAt-1);assert.throws(()=>s.guard(),/Clock moved backwards/);});
test('STOP file closes the run before a further stage',t=>{const f=fixture(t),s=f.begin('gate');fs.writeFileSync(path.join(f.output,'STOP'),'');assert.throws(()=>s.guard());assert.throws(()=>f.begin('gate'));});
test('completed summary edits prevent the next stage',async t=>{const f=fixture(t);await complete(f.begin('gate'));fs.appendFileSync(path.join(f.output,'gate/summary.json'),' ');assert.throws(()=>f.begin('business'));});
for(const file of ['gate.started.json','gate.completed.json','gate/phase-review-request.json'])test('prior stage timing and review substitution rejected: '+file,async t=>{
 const f=fixture(t);await complete(f.begin('gate'));const p=path.join(f.output,file),value=id.read(p);value.deadline+=60000;fs.writeFileSync(p,JSON.stringify(value));assert.throws(()=>f.begin('business'));
});
for(const file of ['gate.completed.json','gate/summary.json','gate/phase-review-request.json','gate/ledger/ledger.json','run.json'])test('prior proof changes during business stop the run: '+file,async t=>{
 const f=fixture(t);await complete(f.begin('gate'));const business=f.begin('business');fs.appendFileSync(path.join(f.output,file),' ');assert.throws(()=>business.guard());assert.ok(fs.existsSync(path.join(f.output,'stopped.json')));
});
for(const [name,mutate]of [['mode',s=>s.identity.mode='live'],['sample',s=>s.identity.sealIdentity='b'.repeat(64)],['authorization',s=>s.identity.authorizationSha256='b'.repeat(64)],['foreign-case',s=>s.attempts[0].caseId='F03-botang-notice'],['unknown-usage',s=>{s.attempts[0].usage=null;s.attempts[0].status='usage-unknown';}],['conflicting-usage',s=>s.attempts[0].usage.totalTokens++],['combined-cap',s=>s.attempts=Array.from({length:26},()=>s.attempts[0])]])test(`ledger substitution rejected: ${name}`,t=>{
 const f=fixture(t);f.begin('gate');const {ledger,meta,file}=makeLedger(f),row=ledger.admit(meta);ledger.settle(row.id,{inputTokens:100,outputTokens:20});alter(file,mutate);assert.throws(()=>session.aggregate(f.output,plan,{active:'gate'}));
});
test('pending reservations cannot become completed phase evidence',t=>{const f=fixture(t);f.begin('gate');const {ledger,meta}=makeLedger(f);ledger.admit(meta);assert.ok(session.aggregate(f.output,plan,{active:'gate'}).pendingReservation>0);assert.throws(()=>session.aggregate(f.output,plan));});
test('changed reviewed ledger prevents a later stage even with a recomputed checksum',async t=>{
 const f=fixture(t);const gate=f.begin('gate'),{ledger,meta,file}=makeLedger(f),row=ledger.admit(meta);ledger.settle(row.id,{inputTokens:100,outputTokens:20});id.write(path.join(gate.phaseOutput,'summary.json'),{passed:true,mode:'offline'});await gate.finish({passed:true,mode:'offline'});alter(file,s=>{s.attempts[0].usage.inputTokens++;s.attempts[0].usage.totalTokens++;});assert.throws(()=>f.begin('business'),/Reviewed ledger changed/);
});
for(const reason of ['deadline','STOP'])test(`async admission ${reason} stops before transport`,async()=>{
 let stopped=false,transport=0;const guard=()=>{if(stopped)throw Error(reason);};
 await assert.rejects((async()=>{await require('../evaluations/foundation-remaining-runner/admission.cjs').admit({session:{guard},identityGuard:()=>{},phases:{admit:async()=>{await Promise.resolve();stopped=true;}},call:{},context:{}});transport++;})(),new RegExp(reason));assert.equal(transport,0);
});
test('binding-read or identity drift after admission still stops before transport',async()=>{
 for(const point of ['binding','identity']){let stopped=false,transport=0;const guard=()=>{if(stopped)throw Error('late-stop');};await assert.rejects((async()=>{await require('../evaluations/foundation-remaining-runner/admission.cjs').admit({session:{guard},identityGuard:()=>{if(point==='identity')stopped=true;},phases:{admit:async()=>{}},afterAdmission:async()=>{if(point==='binding'){await Promise.resolve();stopped=true;}}});transport++;})(),/late-stop/);assert.equal(transport,0);}
});
test('subset reporting changes only the declared population and preserves unestimable rates',()=>{
 const scoped=require('../evaluations/foundation-remaining-runner/report.cjs').scoped;
 const source={attemptedFixedInvalidCases:0,attemptedGeneratedCases:2,plannedGeneratedCases:4,plannedFixedInvalidCases:2,quality:{completionPlanned:{numerator:2,denominator:4,rate:0.5},fixedInvalidRelease:{numerator:0,denominator:0,rate:null},invalidGeneratedDraftRelease:{numerator:0,denominator:0,rate:null},qualifiedDraftHardFalseBlock:{numerator:1,denominator:3,rate:1/3}},branchCoverage:{sixCaseWorkflowCompleted:false}};
 const summary={passed:true,results:plan.business.order.map(caseId=>({caseId,lane:'generated'}))},result=scoped(structuredClone(source),summary);
 assert.deepEqual(result.quality.completionPlanned,{numerator:2,denominator:2,rate:1});assert.equal(result.plannedFixedInvalidCases,0);assert.equal(result.branchCoverage.sixCaseWorkflowCompleted,undefined);
 for(const key of ['fixedInvalidRelease','invalidGeneratedDraftRelease','qualifiedDraftHardFalseBlock'])assert.deepEqual(result.quality[key],source.quality[key]);
 assert.throws(()=>scoped(structuredClone(source),{results:[{caseId:'F04-cenwan-direction',lane:'generated'}]}));
});
test('subset offline reporting never fabricates semantic quality',()=>{const s=require('../evaluations/foundation-remaining-runner/report.cjs').scoped({attemptedFixedInvalidCases:0,attemptedGeneratedCases:0,quality:null,qualityStatus:'N/A-synthetic'},{passed:false,results:[]});assert.equal(s.quality,null);assert.equal(s.unattemptedGeneratedCases,2);});

const {EventEmitter}=require('node:events'),{pathToFileURL}=require('node:url'),policy=require('../evaluations/foundation-remaining-runner/policy.cjs'),humanBinding=require('../evaluations/foundation-remaining-runner/human-binding.cjs');
function humanState(kind='confirm'){
 return {tasks:[{id:'target',title:'title',description:'description',criteria:'criteria',sourceIds:['s'],primaryArtifactId:'a',status:kind==='accept'?'review':'waiting',grounding:{reportHash:'report',basis:'basis',passed:kind==='accept',reviewDisposition:'marker_confirmation'},verification:{passed:true},markerReviewHold:{reportHash:'report'}}],sources:[{id:'s',title:'source',content:'original'}],artifacts:[{id:'a',title:'draft',content:'bound draft'}]};
}
async function nativeFixture(t,{kind='confirm',phase='business',handler}={}){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'remaining-native-unit-')),file=path.join(dir,'receipts.jsonl'),captureSession={},mainSession={},map=new Map(),app=new EventEmitter(),state=humanState(kind);
 fs.mkdirSync(path.join(dir,'workspace'));const save=()=>fs.writeFileSync(path.join(dir,'workspace/workspace.json'),JSON.stringify(state));save();
 t.after(()=>{delete globalThis.__remainingReceiptConfig;assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
 let calls=0;const handlers=new Map([['assistant:call',async(event,action,input)=>{calls++;if(handler)return handler(event,action,input);if(input?.action==='confirmGroundingMarkers'){state.tasks[0].groundingMarkerConfirmation={actor:'user',reportHash:'report',basis:'basis',recordHash:'record',confirmedAt:new Date().toISOString()};save();}return {data:{tasks:state.tasks}};}]]);
 app.getPath=()=>dir;app.getAppPath=()=>id.root;
 const make=(n,s)=>{const w=new EventEmitter();Object.assign(w,{id:n,title:'unit',isDestroyed:()=>false,setTitle:v=>w.title=v,getTitle:()=>w.title,hide:()=>{},webContents:{id:n+10,session:s,mainFrame:{url:pathToFileURL(path.join(id.root,'dist/index.html')).href},getURL(){return this.mainFrame.url;},setBackgroundThrottling(){}}});map.set(n,w);return w;};
 const main=make(1,mainSession),electron={app,session:{fromPartition:()=>captureSession},BrowserWindow:{fromId:n=>map.get(n),fromWebContents:c=>[...map.values()].find(w=>w.webContents===c),getAllWindows:()=>[...map.values()]},ipcMain:{_invokeHandlers:handlers,removeHandler:k=>handlers.delete(k),handle:(k,fn)=>handlers.set(k,fn)}},adapter={evaluate:(fn,args)=>fn(electron,args)};
 await native.install(adapter,{mainWindowId:1,file,output:dir,deadline:Date.now()+60000,phase,taskId:'target',runId:'unit',mode:'offline'});
 if(phase==='business')await native.human(adapter,humanBinding.selection(state,'target',kind,{caseId:'F05-jianping-revision',stage:'initial'}));
 const capture=make(2,captureSession);app.emit('browser-window-created',{},capture);
 const invoke=(w,action,input,event={})=>handlers.get('assistant:call')({sender:w.webContents,senderFrame:w.webContents.mainFrame,...event},action,input);
 return {dir,file,main,capture,invoke,make,mainSession,app,adapter,state,save,calls:()=>calls};
}
const markerInput=action=>({action,input:{id:'target',expectedReportHash:'report'}});
test('F04 is bound as read-only proof and cannot be executed',async()=>{
 const proof=id.verifyPrerequisite(plan);assert.equal(proof.rerun,false);assert.equal(proof.runId,plan.f04Prerequisite.runId);
 await assert.rejects(require('../evaluations/foundation-remaining-runner/run.cjs').run({stage:'f04',mode:'offline'}));
 const report=id.read(path.join(id.root,plan.f04Prerequisite.report)),review=id.read(path.join(id.root,plan.f04Prerequisite.review)),out=path.resolve(id.root,report.evidence.privateRunDirectory),done=id.read(path.join(out,'f04.completed.json')),decision=id.read(path.join(out,'f04/phase-review.json')),summary=id.read(path.join(out,'f04/summary.json'));
 id.checkPrerequisite(report,review,done,decision,summary);
 for(const mutate of [v=>v[0].passed=false,v=>v[1].F04LocalWorkflowPassed=false,v=>v[2].finishedAt=v[2].deadline,v=>v[3].runId='other',v=>v[3].identity='other',v=>v[4].modelCallsAdded=1,v=>v[4].actualHumanAcceptance=false]){const values=structuredClone([report,review,done,decision,summary]);mutate(values);assert.throws(()=>id.checkPrerequisite(...values));}
 const bad=structuredClone(plan);bad.f04Prerequisite.reportSha256='0'.repeat(64);assert.throws(()=>id.verifyPrerequisite(bad));
});
test('main human confirmation and recheck are distinct one-use bound operations',async t=>{
 const f=await nativeFixture(t);await f.invoke(f.main,'uiCommand',markerInput('confirmGroundingMarkers'));assert.equal(f.calls(),1);assert.equal(globalThis.__remainingReceiptConfig.human.kind,'recheck');
 await f.invoke(f.main,'uiCommand',markerInput('recheckGroundingMarkers'));assert.equal(f.calls(),2);assert.equal(globalThis.__remainingReceiptConfig.human.kind,'none');
 const refused=await f.invoke(f.main,'uiCommand',markerInput('recheckGroundingMarkers'));assert.equal(refused.code,'NATIVE_COMMAND_REFUSED');assert.equal(f.calls(),2);
});
for(const reason of ['recheck-before-confirm','duplicate-confirm','wrong-task','wrong-report','wrong-window','subframe','stale-draft','stale-source','stale-report','phase-stop','expired','gate'])test('human admission rejects '+reason,async t=>{
 const f=await nativeFixture(t,{phase:reason==='gate'?'gate':'business'});let expectedCalls=0,action=markerInput('confirmGroundingMarkers'),target=f.main,event={};
 if(reason==='recheck-before-confirm')action=markerInput('recheckGroundingMarkers');
 if(reason==='duplicate-confirm'){await f.invoke(f.main,'uiCommand',action);expectedCalls=1;}
 if(reason==='wrong-task')action.input.id='other';if(reason==='wrong-report')action.input.expectedReportHash='old';if(reason==='wrong-window')target=f.capture;if(reason==='subframe')event.senderFrame={url:f.main.webContents.mainFrame.url};
 if(reason==='stale-draft')f.state.artifacts[0].content='changed';if(reason==='stale-source')f.state.sources[0].content='changed';if(reason==='stale-report')f.state.tasks[0].grounding.reportHash='changed';f.save();
 if(reason==='phase-stop'){fs.mkdirSync(path.join(f.dir,'business'));fs.writeFileSync(path.join(f.dir,'business/STOP'),'');}if(reason==='expired')globalThis.__remainingReceiptConfig.deadline=Date.now()-1;
 const r=await f.invoke(target,'uiCommand',action,event);assert.equal(r.code,'NATIVE_COMMAND_REFUSED');assert.equal(f.calls(),expectedCalls);const denied=native.records(f.file).find(r=>r.kind==='denied');assert.equal(denied.boundary,'before-original-handler');assert.ok(denied.senderId&&denied.windowId);
});
test('acceptance is bound to current content and cannot be repeated',async t=>{
 const f=await nativeFixture(t,{kind:'accept'}),input={action:'taskAction',input:{id:'target',command:'accept'}};
 await f.invoke(f.main,'uiCommand',input);assert.equal(f.calls(),1);await f.invoke(f.main,'uiCommand',input);assert.equal(f.calls(),1);assert.equal(native.records(f.file).filter(r=>r.kind==='native-command'&&r.kindOfCall==='accept').length,1);
});
test('executor writes require one exact grant and reject changed input',async t=>{
 const f=await nativeFixture(t,{phase:'gate'}),page={evaluate:(fn,args)=>f.invoke(f.main,args.action,args.input)};
 await native.invoke(f.adapter,page,'advance',{id:'target'});assert.equal(f.calls(),1);assert.equal(globalThis.__remainingReceiptConfig.executorGrant,null);
 await f.invoke(f.main,'advance',{id:'target'});assert.equal(f.calls(),1);
});
test('executor grant is checked again after asynchronous UI delay and STOP',async t=>{
 const f=await nativeFixture(t,{phase:'gate'}),page={evaluate:async(fn,args)=>{await Promise.resolve();fs.writeFileSync(path.join(f.dir,'STOP'),'');return f.invoke(f.main,args.action,args.input);}};
 const r=await native.invoke(f.adapter,page,'advance',{id:'target'});assert.equal(r.code,'NATIVE_COMMAND_REFUSED');assert.equal(f.calls(),0);
});
for(const value of [undefined,{id:'other'},{id:'target',force:true}])test('one-use executor grant rejects substituted input '+JSON.stringify(value),async t=>{
 const f=await nativeFixture(t,{phase:'gate'}),page={evaluate:(fn,args)=>f.invoke(f.main,args.action,value)};const r=await native.invoke(f.adapter,page,'advance',{id:'target'});assert.equal(r.code,'NATIVE_COMMAND_REFUSED');assert.equal(f.calls(),0);
});
test('new main identity rejects old window sender after restart',async t=>{
 const f=await nativeFixture(t,{kind:'accept'}),old=f.make(9,f.mainSession);await f.invoke(old,'uiCommand',{action:'taskAction',input:{id:'target',command:'accept'}});assert.equal(f.calls(),0);assert.equal(native.records(f.file).find(r=>r.kind==='denied').windowRole,'unknown');
});
test('dynamic capture lifecycle preserves original sender and rejects submits',async t=>{
 const f=await nativeFixture(t);for(const [a,v]of [['quickCaptureState',{}],['quickCaptureDraft',{occupied:false}],['quickCaptureHide',{}]])await f.invoke(f.capture,a,v);assert.equal(f.calls(),3);
 await f.invoke(f.capture,'quickCaptureSubmit',{textItems:[{content:'PRIVATE_SENTINEL'}]});assert.equal(f.calls(),3);const rows=native.records(f.file);assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));assert.ok(rows.some(r=>r.kind==='native-command'&&r.windowRole==='capture'&&r.trusted));
});
for(const kind of ['confirm','recheck','accept'])for(const point of ['binding-read','receipt-fsync'])for(const stop of ['STOP','deadline'])test('late native boundary '+[kind,point,stop].join('/'),async t=>{
 const f=await nativeFixture(t,{kind:kind==='accept'?'accept':'confirm'});
 if(kind==='recheck')await f.invoke(f.main,'uiCommand',markerInput('confirmGroundingMarkers'));
 const before=f.calls();let triggered=false;
 const close=()=>{if(triggered)return;triggered=true;if(stop==='STOP')fs.writeFileSync(path.join(f.dir,'STOP'),'unit late stop');else globalThis.__remainingReceiptConfig.deadline=Date.now()-1;};
 if(point==='binding-read'){const original=fs.readFileSync;t.mock.method(fs,'readFileSync',function(file,...args){const bytes=original.call(fs,file,...args);if(typeof file==='string'&&path.resolve(file)===path.join(f.dir,'workspace/workspace.json'))close();return bytes;});}
 else{const original=fs.fsyncSync;t.mock.method(fs,'fsyncSync',function(...args){const result=original.apply(fs,args);close();return result;});}
 const input=kind==='accept'?{action:'taskAction',input:{id:'target',command:'accept'}}:markerInput(kind==='confirm'?'confirmGroundingMarkers':'recheckGroundingMarkers');
 const r=await f.invoke(f.main,'uiCommand',input);assert.equal(triggered,true);assert.equal(r.code,'NATIVE_COMMAND_REFUSED');assert.equal(f.calls(),before);assert.ok(native.records(f.file).some(r=>r.kind==='denied'&&r.reason==='late-closed-window'&&r.boundary==='before-original-handler'));
});
for(const [kind,quit,error,expected]of [['stateView',true,{error:'应用正在退出'},true],['stateView',false,{error:'应用正在退出'},false],['stateView',true,{error:'other'},false],['quickCaptureDraft',true,{error:'应用正在退出'},false]])test('shutdown stays narrow: '+kind+quit+error.error,async t=>{
 const f=await nativeFixture(t,{handler:async()=>error});if(quit)f.app.emit('before-quit',{});await f.invoke(kind==='quickCaptureDraft'?f.capture:f.main,kind,kind==='quickCaptureDraft'?{occupied:false}:{});assert.equal(native.records(f.file).find(r=>r.kind==='native-command').expectedShutdown,expected);assert.equal(fs.existsSync(path.join(f.dir,'stopped.json')),!expected);
});
