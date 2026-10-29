'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {report}=require('./report.cjs');
function fixture(mode){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marker-report-')),write=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
 const draft={id:'a',title:'T',content:'Historical fact'},task={id:'t',primaryArtifactId:'a',status:'waiting',grounding:{passed:false,reviewDisposition:'marker_confirmation'}},finalTask={...task,status:'completed',grounding:{passed:true}};
 write('F03.json',{caseId:'F03',taskId:'t',lane:'generated',technicalPassed:true,actualHumanAcceptance:mode==='live',final:{tasks:[finalTask],artifacts:[draft]}});
 write('F03-initial-draft.json',{task,draft});
 write('summary.json',{mode,sealIdentity:'a',runnerIdentity:'b',asarSha256:'c',results:[{caseId:'F03'}],actualHumanAcceptances:mode==='live'?1:0,markerBranch:mode==='live'?'observed-human-closed-loop':'synthetic-only',ledger:{attempts:[],totals:{totalTokens:200,knownTokenSubtotal:200,unknownUsage:0,applicationEntryAttempts:0}}});return dir;
}
test('offline reports never infer model quality from technical success',()=>{const r=report(fixture('offline'));assert.equal(r.quality,null);assert.equal(r.qualityStatus,'N/A-synthetic');assert.equal(r.actualHumanAcceptances,0);});
test('human handoff and actual completion keep distinct denominators and unknown stays N/A',()=>{
 const dir=fixture('live'),template=report(dir).adjudicationTemplate;
 template.judgments[0]={...template.judgments[0],qualified:true,hallucination:false,reason:'Original source and all requirements checked'};
 const r=report(dir,template);assert.deepEqual(r.quality.completionPlanned,{numerator:1,denominator:4,rate:0.25});assert.equal(r.quality.qualifiedDraftHumanHandoff.rate,1);assert.equal(r.quality.qualifiedDraftHardFalseBlock.rate,0);assert.equal(r.quality.fixedInvalidRelease.rate,null);assert.equal(r.quality.costPerQualifiedHumanAcceptedTask,200);
 template.judgments[0]={...template.judgments[0],qualified:null,hallucination:null,reason:'Evidence insufficient to adjudicate'};
 const u=report(dir,template);assert.equal(u.quality.initialDraftHallucination.rate,null);assert.equal(u.quality.uncertainDrafts.length,1);
});
test('late requests reconcile with stage attempts and completed invalid draft is always a release',()=>{
 const dir=fixture('live'),summary=JSON.parse(fs.readFileSync(path.join(dir,'summary.json'),'utf8'));
 summary.ledger.rejectedAfterStop=[{id:'late',caseId:'F03',transportPermitted:false,usage:{inputTokens:0,outputTokens:0,totalTokens:0}}];summary.ledger.totals.applicationEntryAttempts=1;
 summary.results.push({caseId:'F01'});fs.mkdirSync(path.join(dir,'calls'));fs.writeFileSync(path.join(dir,'calls','late-terminal.json'),JSON.stringify({attemptId:'late',evaluationPhase:'initial'}));
 fs.writeFileSync(path.join(dir,'F01.json'),JSON.stringify({caseId:'F01',taskId:'bad',lane:'fixed_invalid',technicalPassed:false,final:{tasks:[{id:'bad',status:'completed'}]}}));fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary));
 const a=report(dir).adjudicationTemplate;a.judgments[0]={...a.judgments[0],qualified:true,hallucination:false,reason:'checked'};const r=report(dir,a);assert.equal(r.cost.stages['F03/initial'].attempts,1);assert.equal(r.quality.fixedInvalidRelease.numerator,1);assert.equal(r.quality.fixedInvalidRelease.denominator,1);
});
