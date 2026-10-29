'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{report}=require('./report.cjs'),{capture}=require('./failed-draft.cjs');
test('interrupted produced drafts remain in hallucination judgments but not semantic false-block denominators',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'business-report-')),write=(p,v)=>fs.writeFileSync(path.join(dir,p),JSON.stringify(v));
 const final={tasks:[{id:'t',status:'blocked',primaryArtifactId:'a',grounding:{passed:false}}],artifacts:[{id:'a',title:'Draft',content:'Produced claim'}]};capture({directory:dir,caseId:'F03-test',stage:'initial',input:{},data:final,taskId:'t',error:Error('unknown usage')});
 write('F03-test.json',{caseId:'F03-test',lane:'generated',taskId:'t',technicalPassed:false,actualHumanAcceptance:false,final});write('F01-test.json',{caseId:'F01-test',lane:'fixed_invalid',taskId:'t',technicalPassed:false,final});
 write('summary.json',{mode:'live',sealIdentity:'s',runnerIdentity:'r',asarSha256:'a',actualHumanAcceptances:0,results:[{caseId:'F03-test'},{caseId:'F01-test'}],ledger:{attempts:[],totals:{totalTokens:null,knownTokenSubtotal:10,unknownUsage:1,applicationEntryAttempts:1}}});
 const template=report(dir).adjudicationTemplate;assert.equal(template.judgments.length,1);
 const grade=(qualified,hallucination)=>({...template,judgments:template.judgments.map(j=>({...j,qualified,hallucination,reason:'Independent content review'}))});
 const good=report(dir,grade(true,false)).quality;assert.equal(good.qualifiedDraftHardFalseBlock.denominator,0);assert.equal(good.fixedInvalidRelease.denominator,0);assert.equal(good.unscorableFixedInvalid,1);assert.equal(good.technicallyInterruptedDrafts.length,1);
 const bad=report(dir,grade(false,true)).quality;assert.equal(bad.initialDraftHallucination.numerator,1);assert.equal(bad.initialDraftHallucination.denominator,1);assert.equal(bad.invalidGeneratedDraftRelease.denominator,0);
 // A semantic false release remains countable even if the expected-block assertion failed.
 final.tasks[0].grounding.passed=true;final.tasks[0].status='review';write('F01-test.json',{caseId:'F01-test',lane:'fixed_invalid',taskId:'t',technicalPassed:false,final});fs.mkdirSync(path.join(dir,'calls'));write('calls/verdict-terminal.json',{caseId:'F01-test',role:'verify',rawOutput:JSON.stringify({response_json:JSON.stringify({passed:true,groundingReview:{}})})});const released=report(dir,grade(false,true)).quality;assert.equal(released.fixedInvalidRelease.numerator,1);assert.equal(released.fixedInvalidRelease.denominator,1);
});
