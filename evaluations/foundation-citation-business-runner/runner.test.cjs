'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const identity=require('./identity.cjs'),handoff=require('./handoff-proof.cjs'),{coverage}=require('./coverage.cjs'),{conditions}=require('./budget.cjs'),{hash}=require('../../desktop/evidence-basis.cjs'),{taskOutcome,outcome,metrics,report,titleStage}=require('./report.cjs');
const plan=identity.read(path.join(__dirname,'plan.json')),clone=v=>JSON.parse(JSON.stringify(v));
const terminal=(passed=false)=>({rawOutput:JSON.stringify({response_json:JSON.stringify({passed,groundingReview:{}})})});
function checked(passed,disposition){const r={passed,basis:'basis',phase:'verify',reviewDisposition:disposition};r.reportHash=hash({...r,reportHash:undefined});return {id:'t',grounding:r,verification:{passed}};}
test('only the closed new-candidate G01 proof qualifies; budgets and sample status are pinned',()=>{
 identity.validatePlan(plan);assert.equal(identity.prerequisite(plan).authorizationReusable,false);
 for(const change of [p=>p.asarSha256='old',p=>p.gatePrerequisite.runId='old',p=>p.gatePrerequisite.authorizationReusable=true,p=>p.gatePrerequisite.evidenceSha256='changed']){const p=clone(plan);change(p);assert.throws(()=>identity.prerequisite(p));}
 for(const change of [p=>p.budget.reportedTokenStopThreshold--,p=>p.budget.maximumModelDispatches++,p=>p.budget.protocolAttempts=1,p=>p.caseLimits[4].attempts++,p=>p.humanParticipationRequired=false,p=>p.freshBlindEvaluation=true,p=>p.settings.retries=1]){const p=clone(plan);change(p);assert.throws(()=>identity.validatePlan(p));}
});
test('new approval must explicitly bind business runner, plan, budget and human participation',()=>{
 const a={schema:1,grantedBy:'user',reference:'unit test only; never written',runnerIdentity:'unit-only',sealIdentity:'68785ade24b83dccffc00949dab70309a472c158d5be21358a95d399e415f8e5',planSha256:require('../foundation-business-runner/ledger.cjs').planHash(plan),applicationAttempts:40,maximumModelDispatches:34,reportedTokenStopThreshold:1000000,dispatchWindowMinutes:45,nonHardCapAccepted:true,humanParticipationConfirmed:true,realCliSha256:plan.gatePrerequisite.realCliSha256};
 identity.validateAuthorization(a,plan,'unit-only');
 for(const key of ['runnerIdentity','sealIdentity','planSha256','maximumModelDispatches','humanParticipationConfirmed','nonHardCapAccepted','realCliSha256']){const changed={...a,[key]:null};assert.throws(()=>identity.validateAuthorization(changed,plan,'unit-only'));}
 assert.throws(()=>identity.validateAuthorization(identity.read(path.resolve(identity.root,plan.gatePrerequisite.localEvidence.find(f=>f.kind==='authorization').path)),plan,'unit-only'));
});
test('live entry without new authorization stops before any subprocess or output creation',async()=>{
 const output=path.resolve(identity.root,'../foundation-marker-runs-20261029/never-created-business-unit-'+process.pid);
 await assert.rejects(require('./run.cjs').run({mode:'live',executable:'missing',output}),/New explicit user approval required/);assert.equal(fs.existsSync(output),false);
});
function handoffState(bounded=true){
 const original=checked(false,'marker_confirmation');original.contextFinalizations={old:{basis:{taskId:'t',phase:'verify',content:'same'},status:'finished'}};original.markerRechecks={historical:{id:'historical',status:'finished'}};
 const prior=handoff.before(original),task=clone(original),c={actor:'user',basis:original.grounding.basis,reportHash:original.grounding.reportHash};c.recordHash=hash(c);task.groundingMarkerConfirmation=c;task.grounding={...checked(true).grounding,humanMarkerConfirmation:c.recordHash};task.verification.passed=true;
 const binding={taskId:'t',phase:'verify',basis:c.basis,reportHash:c.reportHash,confirmationHash:c.recordHash},id=hash(binding);task.markerRechecks[id]={...binding,id,status:'finished'};
 if(bounded)task.contextFinalizations.new={basis:{taskId:'t',phase:'verify',content:'same',markerRecheck:id},status:'finished'};
 return {prior,task,id};
}
test('handoff proof preserves old records and proves exactly one new bound authorization',()=>{
 const {prior,task,id}=handoffState(),proof=handoff.after(prior,task);assert.equal(proof.authorizationId,id);assert.equal(proof.newAuthorizationCount,1);assert.equal(proof.priorBoundedSameBasisObserved,true);
 const direct=handoffState(false);assert.equal(handoff.after(direct.prior,direct.task).boundedFinalizationObserved,false);
 for(const change of [t=>t.groundingMarkerConfirmation.recordHash='forged',t=>t.markerRechecks.historical.status='started',t=>t.markerRechecks.extra={},t=>t.contextFinalizations.old.status='mutated',t=>t.contextFinalizations.new.basis.markerRecheck='old',t=>delete t.markerRechecks[id]]){const t=clone(task);change(t);assert.throws(()=>handoff.after(prior,t));}
});
test('six-case success and historical-collision coverage are different claims',()=>{
 const s={mode:'live',passed:true,results:Array(6).fill({}),checks:[]};assert.equal(coverage(s).sixCaseWorkflowCompleted,true);assert.equal(coverage(s).targetBranchStatus,'not-covered');
 const marker={kind:'marker-handoff-closed',caseId:'F05-jianping-revision',stage:'revision',actualHuman:true,beforeAttempts:10,afterAttempts:12,handoffProof:{authorizationId:'a',oldRecordsPreserved:true,priorBoundedSameBasisObserved:false}};s.checks.push(marker);assert.equal(coverage(s).targetBranchStatus,'observed');assert.equal(coverage(s).exactHistoricalCollisionLiveCovered,false);
 marker.handoffProof.priorBoundedSameBasisObserved=true;assert.equal(coverage(s).exactHistoricalCollisionLiveCovered,true);s.mode='offline';assert.equal(coverage(s).targetBranchStatus,'synthetic-only');assert.equal(coverage(s).exactHistoricalCollisionLiveCovered,false);
 s.checks.push({kind:'restart-preserved',caseId:'F06-yunshu-restart',stage:'before-advance'});assert.equal(coverage(s).f06RestartAtReview,false);
});
test('terminal recheck rejection counts; transport/format/waiting/mismatched content do not',()=>{
 const draft={draft:{content:'same'},contentBinding:'b'},snapshot={...draft,task:checked(false)};
 assert.equal(outcome(draft,snapshot,terminal()),'hard-rejected');assert.equal(outcome(draft,{...snapshot,contentBinding:'stale'},terminal()),'technical-or-missing');
 for(const row of [undefined,{error:'UNKNOWN_USAGE'}, {rawOutput:'invalid'}, {rawOutput:JSON.stringify({response_json:'{}'})}])assert.equal(taskOutcome(checked(false),row),'technical-or-missing');
 assert.equal(taskOutcome(checked(false,'marker_confirmation'),terminal()),'human-pending');assert.equal(taskOutcome(checked(true),terminal(true)),'passed');
 const forged=checked(false);forged.grounding.passed=true;assert.equal(taskOutcome(forged,terminal()),'technical-or-missing');
});
test('quality denominators separate technical failure, pending human, negatives and released hallucinations',()=>{
 const rows=[{caseId:'a',stage:'initial',qualified:true,hallucination:false,outcome:'hard-rejected'}, {caseId:'b',stage:'initial',qualified:true,hallucination:false,outcome:'human-pending'}, {caseId:'c',stage:'initial',qualified:false,hallucination:true,outcome:'technical-or-missing'}, {caseId:'d',stage:'revision',qualified:false,hallucination:true,outcome:'passed',finalSameDraft:true}];
 const m=metrics(rows,[{outcome:'hard-rejected'},{outcome:'technical-or-missing'}],[{lane:'generated',technicalPassed:false}]);
 assert.deepEqual(m.qualifiedDraftHardFalseBlock,{numerator:1,denominator:1,rate:1});assert.equal(m.initialDraftHallucination.denominator,3);assert.equal(m.releasedDraftHallucination.rate,1);assert.equal(m.invalidGeneratedDraftRelease.denominator,1);assert.equal(m.fixedInvalidCorrectlyBlocked.denominator,1);assert.equal(m.unscorableFixedInvalid,1);assert.equal(m.completionPlanned.numerator,0);assert.equal(metrics([],[],[]).initialDraftHallucination.rate,null);
});
test('report reads latest post-confirmation verdict and retains initial revision stage separately',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'business-stage-report-')),write=(p,v)=>fs.writeFileSync(path.join(dir,p),JSON.stringify(v));fs.mkdirSync(path.join(dir,'calls'));
 const task={...checked(false),status:'blocked',primaryArtifactId:'a'},draft={id:'a',title:'Draft',content:'initial'},revised={...draft,content:'revised'},snap={task,draft,contentBinding:'b'};
 write('F05-test-initial-draft.json',{...snap,task:checked(false,'marker_confirmation')});write('F05-test-initial-outcome.json',snap);
 write('F05-test-revision-draft.json',{...snap,draft:revised,contentBinding:'c'});write('F05-test-revision-outcome.json',{...snap,draft:revised,contentBinding:'c',task:{...checked(true),status:'review'}});
 write('F05-test.json',{caseId:'F05-test',lane:'generated_revision',taskId:'t',technicalPassed:false,actualHumanAcceptance:false,final:{tasks:[{...checked(true),status:'review',primaryArtifactId:'a'}],artifacts:[revised]}});
 const phases=['initial','initial-human-recheck','revision'];phases.forEach((phase,i)=>write(`calls/c${i}-terminal.json`,{...terminal(i===2),attemptId:'c'+i,caseId:'F05-test',role:'verify',evaluationPhase:phase}));
 write('summary.json',{mode:'live',passed:false,checks:[],sealIdentity:'s',runnerIdentity:'r',asarSha256:'a',results:[{caseId:'F05-test'}],ledger:{attempts:phases.map((_,i)=>({id:'c'+i,caseId:'F05-test'})),totals:{totalTokens:30,knownTokenSubtotal:30,unknownUsage:0,applicationEntryAttempts:3}}});
 const template=report(dir).adjudicationTemplate,graded={...template,judgments:template.judgments.map(j=>({...j,qualified:true,hallucination:false,reason:'Independent fixture judgment'}))},r=report(dir,graded);
 assert.equal(r.quality.qualifiedDraftHardFalseBlock.numerator,1);assert.equal(r.quality.qualifiedDraftHardFalseBlock.denominator,2);assert.equal(r.quality.initialDraftHallucination.denominator,1);assert.equal(r.quality.finalDraftHallucination.denominator,1);assert.equal(r.quality.completionPlanned.numerator,0);assert.equal(r.outcomes[0].outcome,'hard-rejected');
 write('calls/c1-terminal.json',{caseId:'F05-test',role:'verify',evaluationPhase:'initial-human-recheck',error:'UNKNOWN_USAGE'});assert.equal(report(dir,graded).quality.qualifiedDraftHardFalseBlock.denominator,1);
});
test('budget conditional arithmetic extends allowed dispatch slots without calling a model',()=>{
 const result=conditions([{caseId:'x',transportPermitted:true,serializedInputBytes:100,schemaBytes:10,reservedTokens:500},{caseId:'x',transportPermitted:true,serializedInputBytes:200,schemaBytes:10,reservedTokens:600}],[{id:'x',attempts:4,tokenStopThreshold:4000}])[0];
 assert.equal(result.observedConditionalPeak,1724);assert.equal(result.extendedConditionalPeak,2948);assert.equal(result.maxDispatches,3);assert.equal(result.conditionalMargin,1052);assert.equal(result.notATokenForecast,true);
});
test('first restart accepts only exact legacy binding initialization and preserves all other values',()=>{
 const {preserved}=require('./restart-proof.cjs'),s={id:'s',title:'Source',content:'original'},before={task:{id:'t',sourceIds:['s'],status:'todo'},sources:[s]},after=clone(before),at=new Date().toISOString(),epoch=Date.parse(at),contentHash=hash(s.content),revisionId=contentHash;
 Object.assign(after.task,{evidenceLinksVersion:3,supersededSourceIds:[],contextBindings:[{bindingId:'binding:'+hash({taskId:'t',sourceId:'s',purpose:'input',actionId:null,revisionId}),taskId:'t',sourceId:'s',resourceKey:'s',revisionId,purpose:'input',state:'active',provenance:{kind:'legacy_input'},principalScope:null,contentHash,createdAt:at,bindingRevision:1}]});
 const window={stage:'before-advance',startedAt:epoch-100,finishedAt:epoch+100};assert.equal(preserved(before,after,window).legacyBindingInitialization,true);
 for(const change of [v=>v.sources[0].content='different',v=>v.task.status='review',v=>v.task.grounding={passed:true},v=>v.task.extra=true,v=>v.task.contextBindings[0].contentHash='stale',v=>v.task.contextBindings[0].sourceId='other',v=>v.task.contextBindings[0].createdAt='1900-01-01',v=>v.task.contextBindings[0].state='withdrawn',v=>v.task.supersededSourceIds=['s']]){const changed=clone(after);change(changed);assert.throws(()=>preserved(before,changed,window));}
 assert.throws(()=>preserved(before,after,{...window,stage:'at-review'}));
});
test('later restart preserves all existing evidence, authorization and verification records exactly',()=>{
 const {preserved}=require('./restart-proof.cjs'),before={task:{id:'t',contextBindings:[{id:'binding',createdAt:'old'}],evidenceLinksVersion:3,supersededSourceIds:[],grounding:{passed:true},markerRechecks:{old:{status:'finished'}}},sources:[],draft:{content:'final'}};
 assert.equal(preserved(before,clone(before),{stage:'at-review'}).legacyBindingInitialization,false);
 for(const change of [v=>v.task.contextBindings[0].createdAt='new',v=>v.task.markerRechecks.old.status='started',v=>v.task.grounding.passed=false,v=>v.draft.content='changed']){const after=clone(before);change(after);assert.throws(()=>preserved(before,after,{stage:'at-review'}));}
});

test('business execution is byte-equivalent to the reviewed offline executor after its offline-only entry guard',()=>{
 const old=fs.readFileSync(path.join(identity.root,'evaluations/foundation-citation-offline-runner/run.cjs'),'utf8').split(/\r?\n/),line=" assert.equal(mode,'offline','This isolated regression runner cannot dispatch real models');assert.equal(authorization,undefined);assert.equal(authorizationPath,undefined);assert.equal(realCli,undefined);";
 assert.equal(old.filter(s=>s===line).length,1);assert.equal(old.filter(s=>s!==line).join('\n'),fs.readFileSync(path.join(__dirname,'run.cjs'),'utf8').split(/\r?\n/).join('\n'));
 for(const name of ['handoff-proof','restart-proof','budget'])assert.equal(require('./'+name+'.cjs'),require('../foundation-citation-offline-runner/'+name+'.cjs'));
 for(const name of ['metrics','taskOutcome','outcome'])assert.equal(require('./report.cjs')[name],require('../foundation-citation-offline-runner/report.cjs')[name]);
});

test('same candidate is required and the real G01 evidence stays closed without another gate execution',()=>{
 const candidate=path.resolve(identity.root,'../foundation-candidate-bundle-citation-20261029/XingzhiAssistant.exe'),value=identity.frozen(candidate);
 assert.equal(value.plan.asarSha256,plan.asarSha256);assert.equal(value.gateProof.executions,0);assert.equal(value.gateProof.authorizationReusable,false);
 assert.throws(()=>identity.frozen(path.resolve(identity.root,'../foundation-candidate-bundle-recheck-20261029/XingzhiAssistant.exe')));
 for(const key of ['summary','state','decision','authorization','consumption','closure']){const changed=clone(plan);changed.gatePrerequisite.localEvidence.find(f=>f.kind===key).sha256='0'.repeat(64);assert.throws(()=>identity.prerequisite(changed));}
});

test('six case slots cap actual model dispatches at 34, and G01 has no quota',()=>{
 const {Ledger}=require('../foundation-business-runner/ledger.cjs'),base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'citation-business-ledger-'));
 try{
  let dispatches=0;const meta={role:'verify',stage:'task_verify',serializedInputBytes:1,schemaBytes:1,visibleBytes:1};
  for(const c of plan.caseLimits){const ledger=new Ledger({dir:path.join(dir,c.id),plan,mode:'offline',sealIdentity:'a'.repeat(64),conservativeAttemptSlot:true});for(let i=0;i<c.attempts-1;i++){const row=ledger.admit({...meta,caseId:c.id});ledger.settle(row.id,{inputTokens:1,outputTokens:1});dispatches++;}assert.throws(()=>ledger.admit({...meta,caseId:c.id}),{code:'LEDGER_CASE_BUDGET'});assert.equal(ledger.snapshot().totals.applicationEntryAttempts,c.attempts);}
  assert.equal(dispatches,34);const ledger=new Ledger({dir:path.join(dir,'gate'),plan,mode:'offline',sealIdentity:'a'.repeat(64),conservativeAttemptSlot:true});assert.throws(()=>ledger.admit({...meta,caseId:plan.protocolGate.id}));assert.equal(ledger.snapshot().totals.admitted,0);
 }finally{assert.equal(path.dirname(fs.realpathSync(dir)),base);fs.rmSync(dir,{recursive:true,force:true});}
});

function titleFixture(){
 const quote={field:'title',sourceId:'s',title:'资料标题',quote:'资料标题',fieldHash:hash('资料标题'),version:'v'},g={passed:true,claims:[{artifactId:'a',text:'稿件结论',citations:[quote]}]};g.reportHash=hash(g);
 const draft={draft:{id:'a',title:'稿件',content:'稿件结论'},contentBinding:'b'},checked={...clone(draft),task:{grounding:g,verification:{passed:true}}};
 const value={passed:true,groundingReview:{format:'compact-v3',citations:[{id:'e',sourceId:'s',field:'title',quote:'资料标题'}],claims:[{artifactId:'a',text:'稿件结论',citationIds:['e']}]}};
 const row={role:'verify',transportDispatched:true,synthetic:false,rawOutput:JSON.stringify({response_json:JSON.stringify(value)})};return {draft,checked,value,row};
}
const encode=(row,v)=>({...row,rawOutput:JSON.stringify({response_json:JSON.stringify(v)})});
test('only successful final raw title citation exactly bound to the saved claim counts as live title coverage',()=>{
 const f=titleFixture(),stage=titleStage(f.draft,f.checked,[f.row]);assert.deepEqual(stage,{modelTitleCitationEmitted:true,titleBindingValidated:true,liveTitleBindingValidated:true});
 const s={mode:'live',passed:true,results:[{caseId:'F03-botang-notice',technicalPassed:true}],checks:[]};assert.equal(coverage(s,[{caseId:'F03-botang-notice',...stage}]).citationFields.F03LiveTitleCitationCovered,true);
 const synthetic=titleStage(f.draft,f.checked,[{...f.row,transportDispatched:false,synthetic:true}]);assert.equal(synthetic.titleBindingValidated,true);assert.equal(synthetic.liveTitleBindingValidated,false);assert.equal(coverage(s,[{caseId:'F03-botang-notice',...synthetic}]).citationFields.status,'not-covered');
 s.mode='offline';assert.equal(coverage(s,[{caseId:'F03-botang-notice',...stage}]).citationFields.status,'synthetic-only');
});
test('body-only business success remains success without pretending title coverage',()=>{
 const f=titleFixture();delete f.value.groundingReview.citations[0].field;const stage=titleStage(f.draft,f.checked,[encode(f.row,f.value)]);assert.equal(stage.modelTitleCitationEmitted,false);assert.equal(stage.titleBindingValidated,false);
 const s={mode:'live',passed:true,results:[{caseId:'F03-botang-notice',technicalPassed:true},...Array(5).fill({technicalPassed:true})],checks:[]},r=coverage(s,[{caseId:'F03-botang-notice',...stage}]);assert.equal(r.sixCaseWorkflowCompleted,true);assert.equal(r.citationFields.F03WorkflowCompleted,true);assert.equal(r.citationFields.status,'not-covered');
});
test('early title emission cannot count after a later technical failure, rejection or body-only conclusion',()=>{
 const f=titleFixture(),body=clone(f.value);delete body.groundingReview.citations[0].field;
 for(const last of [{...f.row,error:'UNKNOWN_USAGE'},encode(f.row,{...f.value,passed:false}),encode(f.row,body),{...f.row,rawOutput:'invalid'}]){const r=titleStage(f.draft,f.checked,[f.row,last]);assert.equal(r.modelTitleCitationEmitted,true);assert.equal(r.titleBindingValidated,false);}
});
test('source, quote, claim, raw reference and exact draft binding mismatches never count title coverage',()=>{
 for(const mutate of [f=>f.value.groundingReview.citations[0].sourceId='other',f=>f.value.groundingReview.citations[0].quote='other',f=>f.value.groundingReview.citations[0].version='other',f=>f.value.groundingReview.claims[0].citationIds=[],f=>f.value.groundingReview.claims[0].text='other',f=>f.checked.contentBinding='other',f=>f.checked.draft.content='changed',f=>f.checked.task.grounding.reportHash='forged',f=>f.checked.task.verification.passed=false]){const f=titleFixture();mutate(f);assert.equal(titleStage(f.draft,f.checked,[encode(f.row,f.value)]).titleBindingValidated,false);}
});

test('raw title offsets must be absent or zero and cache reuse is never current verification coverage',()=>{
 for(const start of [1,-1,'0',null]){const f=titleFixture();f.value.groundingReview.citations[0].start=start;assert.equal(titleStage(f.draft,f.checked,[encode(f.row,f.value)]).titleBindingValidated,false);}
 const f=titleFixture();f.value.groundingReview.citations[0].start=0;assert.equal(titleStage(f.draft,f.checked,[encode(f.row,f.value)]).titleBindingValidated,true);
 f.checked.task.grounding.reused=true;f.checked.task.grounding.reportHash=hash({...f.checked.task.grounding,reportHash:undefined});assert.deepEqual(titleStage(f.draft,f.checked,[encode(f.row,f.value)]),{modelTitleCitationEmitted:true,titleBindingValidated:false,liveTitleBindingValidated:false});
});

test('malformed claim rows cannot crash or establish title coverage',()=>{
 for(const claim of [null,0,{}, {text:42}, {text:['text']}]){const f=titleFixture();f.value.groundingReview.claims=[claim];assert.equal(titleStage(f.draft,f.checked,[encode(f.row,f.value)]).titleBindingValidated,false);}
});
