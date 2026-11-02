'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const id=require('../evaluations/foundation-remaining-runner/identity.cjs'),{run}=require('../evaluations/foundation-remaining-runner/run.cjs');
async function rehearse({executable,output}){
 const plan=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json'));id.validatePlan(plan);
 output=require('../evaluations/foundation-marker-runner/output.cjs').validateOutput(output,path.resolve(id.root,plan.outputParent));fs.mkdirSync(output,{recursive:true});
 const seal=id.read(path.join(id.root,'evaluations/foundation-remaining-runner/runner-seal.json'));id.verifyRunner(seal);const results=[];
 const probes=[{id:'normal',phases:['gate','business'],fault:'capture-lifecycle'},
  {id:'gate-malformed',phases:['gate'],fault:'malformed-inner',negative:true},
  {id:'business-unknown-usage',phases:['gate','business'],fault:'unknown-usage',negative:true},
  {id:'capture-submit',phases:['gate'],fault:'capture-submit',negative:true},
  {id:'wrong-window',phases:['gate'],fault:'wrong-window',negative:true},
  {id:'phase-stop',phases:['gate'],fault:'phase-stop',negative:true},
  {id:'gate-routing-timeout',phases:['gate'],fault:'routing-timeout',negative:true},
  {id:'business-routing-timeout',phases:['gate','business'],fault:'routing-timeout',negative:true},
  {id:'business-body-three-paragraphs',phases:['gate','business'],fault:'body-three-paragraphs',negative:true},
  {id:'business-title-real-patch',phases:['gate','business'],fault:'title-real-patch',negative:true},
  {id:'business-title-corrected-patch',phases:['gate','business'],fault:'title-corrected-patch'}];
 // Run the two new replay paths first so their assertions fail early. All eleven probes remain mandatory.
 probes.sort((a,b)=>Number(!a.id.startsWith('business-title-'))-Number(!b.id.startsWith('business-title-')));
 for(const probe of probes){
  const target=path.join(output,probe.id);let error;
  for(const [i,stage]of probe.phases.entries())try{await run({stage,executable,output:target,mode:'offline',readyReference:'OFFLINE-SYNTHETIC-NOT-USER-APPROVAL',fault:probe.id==='normal'||i===probe.phases.length-1?probe.fault:undefined});}catch(e){error=e;break;}
  assert.equal(!!error,!!probe.negative,probe.id+': '+error?.stack);assert.ok(!fs.existsSync(path.join(target,'f04.started.json'))&&!fs.existsSync(path.join(target,'f04')),'F04 must not run');
  const last=probe.phases.at(-1),summary=id.read(path.join(target,last,'summary.json'));assert.equal(summary.mode,'offline');assert.equal(summary.passed,!probe.negative);assert.equal(summary.liveModelCalls||summary.realCliExecutions||0,0);assert.equal(summary.actualHumanAcceptances,0);
  if(probe.negative){
   assert.ok(fs.existsSync(path.join(target,'stopped.json')));assert.ok(!fs.existsSync(path.join(target,last+'.completed.json')));
   if(last==='gate')assert.ok(!fs.existsSync(path.join(target,'business.started.json')));
   if(probe.fault==='malformed-inner'){assert.equal(summary.ledger.totals.admitted,1);assert.equal(summary.ledger.totals.unknownUsage,0);}
   if(probe.fault==='unknown-usage'){assert.ok(summary.ledger.totals.unknownUsage>0);assert.equal(summary.ledger.totals.totalTokens,null);assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));}
   if(probe.fault==='routing-timeout'){
    assert.equal(error.code,'CLI_ROUTING_TIMEOUT');const stopped=id.read(path.join(target,'stopped.json'));assert.equal(stopped.error,'CLI_ROUTING_TIMEOUT');assert.equal(stopped.cause.code,'CLI_ROUTING_TIMEOUT');
    assert.equal(summary.ledger.stop.reason,'CLI_ROUTING_TIMEOUT');assert.equal(summary.ledger.totals.admitted,1);assert.equal(summary.ledger.totals.applicationEntryAttempts,1);assert.equal(summary.ledger.totals.unknownUsage,1);assert.equal(summary.ledger.totals.totalTokens,null);assert.equal(summary.ledger.totals.pendingUsage,0);assert.equal(summary.ledger.totals.unexpectedAttempts,0);
    const terminals=fs.readdirSync(path.join(target,last,'calls')).filter(n=>n.endsWith('-terminal.json'));assert.equal(terminals.length,1);const terminal=id.read(path.join(target,last,'calls',terminals[0]));assert.equal(terminal.error,'CLI_ROUTING_TIMEOUT');assert.equal(terminal.rawOutput,null);assert.equal(terminal.processTreeConfirmed,true);assert.equal(terminal.diagnostics.events[0].rawEventSha256,'32345e942660070888e7e55e44337de7621a23fab06c7643c8f484c380a8ad25');
    if(last==='business'){assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.equal(summary.results[0].errorCode,'CLI_ROUTING_TIMEOUT');assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));}
   }
   if(probe.fault==='body-three-paragraphs'){
    assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));assert.equal(summary.simulatedAcceptances,0);assert.equal(summary.ledger.totals.unknownUsage,0);
    const revision=id.read(path.join(target,'business/F05-jianping-revision-revision-draft.json')),check=revision.task.verification.bodyStructure;assert.equal(check.expected,2);if(check.kind==='paragraph-count')assert.equal(check.actual,3);else{assert.equal(check.reason,'duplicate-leading-title');assert.equal(check.actual,null);}assert.equal(check.passed,false);assert.equal(revision.task.verification.passed,false);assert.equal(revision.task.status,'blocked');
   }
   if(['capture-submit','wrong-window','phase-stop'].includes(probe.fault)){assert.equal(summary.ledger.totals.admitted,0);assert.equal(summary.ledger.totals.totalTokens,0);const rows=require('../evaluations/foundation-remaining-runner/native.cjs').records(path.join(target,last,'native-commands.jsonl'));assert.ok(rows.some(r=>r.kind==='denied'&&r.boundary==='before-original-handler'));}
  }else{
   assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision','F06-yunshu-restart']);assert.equal(summary.gateExecutions,0);assert.equal(summary.simulatedAcceptances,2);
   for(const kind of ['revision-new-basis','restart-preserved','accepted-cold-restart-preserved','final-human-acceptance',...(probe.id==='normal'?['marker-handoff-closed','capture-button-escape-reopen-recreate']:[])])assert.ok(summary.checks.some(c=>c.kind===kind),kind);
   assert.ok(summary.gatePrerequisite?.summarySha256);const gate=id.read(path.join(target,'gate/summary.json'));assert.equal(gate.f04Prerequisite.runId,'3416bcda-77e0-4866-b0a6-2bb7eabec4f0');assert.equal(gate.f04Prerequisite.rerun,false);
   const report=require('../evaluations/foundation-remaining-runner/report.cjs').report(target);assert.equal(report.business.plannedGeneratedCases,2);assert.equal(report.business.plannedFixedInvalidCases,0);assert.equal(report.business.quality,null);assert.equal(report.cost.synthetic,true);id.write(path.join(target,'scoped-report.json'),report);
  }
  if(['title-real-patch','title-corrected-patch'].includes(probe.fault)){
   const f=require('../evaluations/foundation-remaining-runner/title-replay.cjs').historical,initial=id.read(path.join(target,'business/F05-jianping-revision-initial-draft.json')),revision=id.read(path.join(target,'business/F05-jianping-revision-revision-draft.json')),check=revision.task.verification.bodyStructure;
   assert.deepEqual({title:initial.draft.title,content:initial.draft.content},{title:f.initialDraft.title,content:f.initialDraft.content});assert.equal(initial.task.verification.passed,true);assert.equal(initial.task.verification.bodyStructure,undefined);
   const corrected=probe.fault==='title-corrected-patch',heading='# '+f.initialDraft.title+'\n\n';assert.equal(revision.draft.title,f.invalidRevision.title);assert.equal(revision.draft.content,corrected?f.invalidRevision.content.slice(heading.length):f.invalidRevision.content);assert.equal(check.preStructurePassed,true);assert.equal(revision.task.grounding.passed,true);
   const terminals=fs.readdirSync(path.join(target,'business/calls')).filter(p=>p.endsWith('-terminal.json')).map(p=>id.read(path.join(target,'business/calls',p))),patches=terminals.filter(t=>t.caseId==='F05-jianping-revision'&&t.evaluationPhase==='revision'&&t.role==='execute').map(t=>JSON.parse(JSON.parse(t.rawOutput).response_json)).filter(r=>r.kind==='patch');assert.equal(patches.length,1);
   const expected=structuredClone(f.patch);if(corrected)expected.edits.push({before:heading,after:''});assert.deepEqual(patches[0],expected);
   if(corrected){assert.equal(check.passed,true);assert.equal(check.actual,2);assert.equal(summary.simulatedAcceptances,2);}else{
    assert.equal(check.reason,'duplicate-leading-title');assert.equal(check.actual,null);assert.equal(check.passed,false);assert.equal(revision.task.status,'blocked');assert.equal(summary.simulatedAcceptances,0);assert.equal(summary.ledger.totals.unknownUsage,0);assert.deepEqual(summary.results.map(r=>r.caseId),['F05-jianping-revision']);assert.ok(!fs.existsSync(path.join(target,'business/F06-yunshu-restart.json')));assert.ok(summary.checks.some(c=>c.kind==='blocked-title-restart-excluded-from-acceptance'));
   }
  }
  const files=['run.json',...probe.phases.flatMap(p=>[p+'.started.json',p+'.completed.json',p+'/summary.json',p+'/native-commands.jsonl',p+'/phase-review-request.json',p+'/ledger/ledger.json']),...(probe.negative?['stopped.json']:['scoped-report.json'])].filter(p=>fs.existsSync(path.join(target,p))).map(p=>({path:probe.id+'/'+p,sha256:id.sha(fs.readFileSync(path.join(target,p)))}));
  results.push({id:probe.id,passed:true,expectedFailure:!!probe.negative,error:error?.message||null,realModelCalls:0,files});console.log(JSON.stringify({probe:probe.id,passed:true,expectedFailure:!!probe.negative}));
 }
 id.verifyRunner(seal);const value={schema:1,kind:'offline-packaged-remaining-workflows-rehearsal',createdAt:new Date().toISOString(),runnerIdentity:seal.identity,asarSha256:id.read(path.join(id.root,'evaluations/foundation-remaining-runner/plan.json')).asarSha256,passed:true,results,realModelCalls:0,officialCliInvocations:0,actualHumanAcceptances:0,f04Executions:0,installed:false,syntheticFixtureOnly:true};id.write(path.join(output,'rehearsal.json'),value);return value;
}
module.exports={rehearse};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});rehearse(values).then(r=>console.log(JSON.stringify({passed:r.passed,probes:r.results.length,realModelCalls:0,f04Executions:0}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
