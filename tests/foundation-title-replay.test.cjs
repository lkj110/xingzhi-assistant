'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const replay=require('../evaluations/foundation-remaining-runner/title-replay.cjs'),f=replay.historical;
function call(role,revised=false){const verifier=revised?f.revisionVerifier:f.initialVerifier;return {role,context:{id:'F05-jianping-revision',revised,sources:f.input.sources.map((s,i)=>({...s,id:'new-source-'+i}))},payload:{revision:{originalContent:f.initialDraft.content,note:f.revisionNote},groundingReviewRequest:{artifactIds:['new-artifact']},groundingChecklist:{requirements:verifier.groundingReview.requirements.map(r=>({id:r.id}))}}};}
test('historical initial draft and patch are exact; corrected counterexample is separately labeled',()=>{
 const before=JSON.stringify(f),initial=replay.response(call('execute'));assert.deepEqual(initial,{kind:'artifact',title:f.initialDraft.title,content:f.initialDraft.content,summary:'OFFLINE HISTORICAL DRAFT REPLAY'});
 const patch=replay.response(call('execute',true));assert.deepEqual(patch,f.patch);assert.equal(initial.content.replace(patch.edits[0].before,patch.edits[0].after),f.invalidRevision.content);
 const corrected=replay.response(call('execute',true),{corrected:true});assert.equal(corrected.edits.length,patch.edits.length+1);assert.deepEqual(corrected.edits.slice(0,-1),patch.edits);assert.deepEqual(corrected.edits.at(-1),{before:'# '+f.initialDraft.title+'\n\n',after:''});assert.equal(JSON.stringify(f),before);
});
for(const revised of [false,true])test('verifier replay changes only runtime resource identifiers: '+revised,()=>{
 const c=call('verify',revised),stage=revised?'revision':'initial',result=replay.response(c),original=revised?f.revisionVerifier:f.initialVerifier;
 const reverse=new Map([['new-artifact',f.originalArtifactIds[stage]],...c.context.sources.map(s=>[s.id,Object.entries(f.originalSourceIds).find(([,title])=>title===s.title)[0]])]);
 const walk=v=>Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])):reverse.get(v)||v;
 assert.deepEqual(walk(result),original);
});
for(const kind of ['case','source','extra-source','original','note','requirements','artifact-count'])test('replay refuses mismatched input: '+kind,()=>{
 const c=call(kind==='requirements'||kind==='artifact-count'?'verify':'execute',true);
 if(kind==='case')c.context.id='F06-yunshu-restart';if(kind==='source')c.context.sources[0].content+=' changed';if(kind==='extra-source')c.context.sources.push({...c.context.sources[0],id:'extra'});if(kind==='original')c.payload.revision.originalContent+=' changed';if(kind==='note')c.payload.revision.note+=' changed';if(kind==='requirements')c.payload.groundingChecklist.requirements.pop();if(kind==='artifact-count')c.payload.groundingReviewRequest.artifactIds.push('other');assert.throws(()=>replay.response(c));
});

const restartFixture=require('./fixtures/foundation-title-restart-projection-20261102.json');
function restartCase(){const r=structuredClone(restartFixture);return {...r,options:{mode:'offline',stage:r.stage,startedAt:r.startedAt,finishedAt:r.finishedAt}};}
test('blocked-title restart permits only the observed exact legacy initialization and keeps its actual stage',()=>{
 const r=restartCase(),proof=replay.blockedRestartPreserved(r.before,r.after,r.options);assert.equal(proof.preserved,true);assert.equal(proof.legacyBindingInitialization,true);assert.equal(proof.actualStage,'blocked-title-replay');
 const repeated=replay.blockedRestartPreserved(r.after,structuredClone(r.after),r.options);assert.equal(repeated.legacyBindingInitialization,false);
});
for(const mutation of ['live','stage','status','verification','grounding','reason','accepted','draft','source','existing-binding','withdrawal','deleted-source','extra-binding','wrong-hash','early-time','late-time','extra-task-field'])test('blocked restart rejects '+mutation,()=>{
 const r=restartCase();
 if(mutation==='live')r.options.mode='live';if(mutation==='stage')r.options.stage='at-review';if(mutation==='status')r.after.task.status='review';if(mutation==='verification')r.after.task.verification.passed=true;if(mutation==='grounding')r.after.task.grounding.passed=false;if(mutation==='reason')r.after.task.verification.bodyStructure.reason='paragraph-count';if(mutation==='accepted')r.after.task.acceptedAt='2026-11-02T00:00:00Z';
 if(mutation==='draft')r.after.draft.content+='changed';if(mutation==='source')r.after.sources[0].content+='changed';if(mutation==='existing-binding'){r.before=structuredClone(r.after);r.after.task.contextBindings[0].principalScope='changed';}if(mutation==='withdrawal')r.before.task.contextWithdrawals=[{sourceId:r.before.sources[0].id}];if(mutation==='deleted-source'){r.before.sources[0].deleted=true;r.after.sources[0].deleted=true;}if(mutation==='extra-binding')r.after.task.contextBindings.push(r.after.task.contextBindings[0]);if(mutation==='wrong-hash')r.after.task.contextBindings[0].contentHash='wrong';if(mutation==='early-time')r.after.task.contextBindings[0].createdAt=new Date(r.options.startedAt-1).toISOString();if(mutation==='late-time')r.after.task.contextBindings[0].createdAt=new Date(r.options.finishedAt+1).toISOString();if(mutation==='extra-task-field')r.after.task.unexpected=true;
 assert.throws(()=>replay.blockedRestartPreserved(r.before,r.after,r.options));
});
