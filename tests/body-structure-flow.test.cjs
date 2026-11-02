'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs'),structure=require('../desktop/body-structure.cjs'),acceptance=require('../desktop/acceptance.cjs');
const {hash}=require('../desktop/evidence-basis.cjs'),cache=require('../desktop/verification-cache.cjs');
const frozen=require('./fixtures/foundation-body-structure-f05-20261102.json');
const livePatch=require('./fixtures/foundation-title-contract-f05-20261102.json');
const actualGenerationCall=require('../desktop/generation-context.cjs').call;
function setup(t,{historical=false,replay=frozen,content='安排。\n\n规则。',strict=false}={}){
 const temp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(temp,'xingzhi-body-structure-')),assistants=[];let external=0;
 const prohibited=async()=>{external++;throw Error('No real model or external transport permitted');};
 const make=()=>{const a=new Assistant({dir,chat:prohibited,connectorRequest:prohibited,webRequest:prohibited,agentRequest:prohibited});assistants.push(a);return a;};
 const a=make();a.data.settings.evidenceGrounding=strict;a.data.settings.automatic=false;a.data.settings.autoExtract=false;a.data.settings.autoComplete=false;
 a.data.providers=[{id:'fixture',type:'openai',name:'Offline fixture',model:'fixture'}];a.data.settings.roles={execute:'fixture',verify:'fixture',organize:'fixture'};
 const input=historical?replay.input:{title:'结构检查',description:'写一份通知。',criteria:'正文恰好两个自然段。',sources:[]};
 if(input.sources.length)a.addSources(input.sources);const task=a.createTask({...input,sourceIds:a.data.sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});grounding.captureUserInput(task,'description',task.description);
 const draft={id:'original',taskId:task.id,stepId:task.steps[0].id,title:historical?replay.initialDraft.title:'通知',content:historical?replay.initialDraft.content:content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});Object.assign(task.steps[0],{done:true,artifactId:draft.id});require('../desktop/deliverables.cjs').record(a,task,task.steps[0],draft,{});a.save();
 t.after(()=>{for(const v of assistants){require('../desktop/access.cjs').cancel(v);require('../desktop/deadline-scheduler.cjs').dispose(v);}assert.equal(external,0);assert.ok(path.resolve(dir).startsWith(temp+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 return {a,task,draft,dir,make};
}
function historicalVerdict(a,task,stage,replay=frozen){
 const s=grounding.snapshot(a,task),current=s.artifacts[0],raw=structuredClone(stage==='initial'?replay.initialVerifier:replay.revisionVerifier),map=new Map([[replay.originalArtifactIds[stage],current.id]]);
 for(const [id,title] of Object.entries(replay.originalSourceIds))map.set(id,a.data.sources.find(r=>r.title===title).id);
 const replace=v=>Array.isArray(v)?v.map(replace):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)])):map.get(v)||v;
 const seen=new Set();grounding.observe(seen,{artifacts:s.artifacts,contextReads:a.data.sources.map(source=>({result:{sourceId:source.id,title:source.title,version:s.sources.find(r=>r.id===source.id).version,content:source.content}}))});grounding.observe(seen,grounding.context(a,task,{},'verify'));
 return grounding.finish(a,task,replace(raw),{seen,phase:'result'});
}
test('sealed F05 initial passes; real revision response is rejected locally and cannot be accepted or delivered',async t=>{
 const f=setup(t,{historical:true,strict:true}),calls=[];
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async(a,task,_system,_payload,role='execute')=>{
  calls.push(role);if(role==='execute')return {kind:'patch',edits:[{before:frozen.initialDraft.content,after:frozen.invalidRevision.content}],summary:'Offline exact replay of invalid F05 revision'};
  const result=historicalVerdict(a,task,calls.length===1?'initial':'revision');assert.equal(result.passed,true,result.gaps.join('\n'));return result;
 });
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review');assert.equal(f.task.verification.bodyStructure,undefined);const oldBasis=f.task.grounding.basis;
 await f.a.dispatch('taskAction',{id:f.task.id,command:'revise',note:frozen.revisionNote});f.task=f.a.task(f.task.id);await f.a.advance(f.task.id);f.task=f.a.task(f.task.id);
 const current=require('../desktop/deliverables.cjs').primary(f.a,f.task);assert.equal(current.content,frozen.invalidRevision.content);assert.equal(f.draft.content,frozen.initialDraft.content);assert.notEqual(f.task.grounding.basis,oldBasis,f.task.lastError+JSON.stringify(calls));
 assert.equal(f.task.status,'blocked');assert.equal(f.task.verification.passed,false);assert.equal(f.task.verification.bodyStructure.actual,3);assert.equal(f.task.verification.bodyStructure.preStructurePassed,true);assert.equal(f.task.verification.bodyStructure.contentHash,hash(current.content));assert.equal(f.task.verificationCheckpoint,undefined);
 assert.equal(f.task.markerReviewHold,undefined);assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'BODY_STRUCTURE_REQUIRED'});assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'user'}));assert.equal(f.task.acceptedAt,undefined);assert.deepEqual(calls,['verify','execute','verify']);
 // A restart reloads the same invalid bytes and still refuses direct acceptance.
 const restarted=f.make(),restored=restarted.task(f.task.id);assert.equal(structure.inspect(restarted,restored).actual,3);assert.ok(acceptance.reasons(restarted,restored).some(r=>r.code==='body_structure'));
});
test('correct body passes, exact cache is safe, changed bytes cannot borrow its result',async t=>{
 const f=setup(t),calls=[];t.mock.method(require('../desktop/generation-context.cjs'),'call',async()=>{calls.push('verify');return {passed:true,summary:'Offline semantic check',gaps:[]};});
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review');assert.equal(f.task.verification.bodyStructure.passed,true);assert.equal(f.task.verification.bodyStructure.actual,2);
 assert.equal(JSON.stringify(f.a.context(f.task,{verification:true})).includes('bodyStructure'),false,'local diagnostic is not repeated in model input');
 f.task.status='todo';await f.a.advance(f.task.id);assert.equal(f.task.verification.mode,'exact');assert.equal(calls.length,1);
 f.draft.content='通知\n\n安排。\n\n规则。';f.task.status='review';assert.ok(acceptance.reasons(f.a,f.task).some(r=>r.code==='body_structure'));
 const p=cache.prepare(f.a,f.task,f.a.context(f.task,{verification:true}),{allowExact:true,verifierKey:'fixture'});assert.notEqual(p.mode,'exact');
 f.task.status='todo';await f.a.advance(f.task.id);assert.equal(f.task.status,'blocked');assert.equal(calls.length,2);assert.equal(f.task.verification.bodyStructure.reason,'duplicate-leading-title');
});
test('a legacy model pass and forged current acceptance basis cannot bypass local acceptance',t=>{
 const f=setup(t,{content:'通知\n\n安排。\n\n规则。'});f.task.status='review';f.task.verification={basisVersion:2,passed:true,summary:'Legacy model accepted three paragraphs',gaps:[],basis:acceptance.basis(f.a,f.task)};
 assert.ok(acceptance.reasons(f.a,f.task).some(r=>r.code==='body_structure'));assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'user'}));assert.equal(f.task.acceptedAt,undefined);
});
test('local failure cannot be routed to expression confirmation even when marker report is valid',async t=>{
 const f=setup(t,{content:'通知\n\n安排。\n\n规则。'}),issue='需确认表达';
 const report={passed:false,reviewDisposition:'marker_confirmation',markerReview:[{issue}],issues:[issue]};report.reportHash=hash(report);
 const result=structure.finish(f.a,f.task,{passed:false,summary:issue,gaps:[issue],grounding:report});assert.equal(require('../desktop/marker-confirmation.cjs').pendingResult(result),false);assert.equal(result.bodyStructure.passed,false);
});
test('generation boundary reminder adds one string only for a supported rule and no extra call',async t=>{
 const f=setup(t),systems=[];f.a.call=async(role,system)=>{assert.equal(role,'execute');systems.push(system);return {kind:'artifact',title:'通知',content:'安排。\n\n规则。',summary:'Offline fixture'};};
 const context=()=>({...f.a.context(f.task),currentStep:{id:f.task.steps[0].id,kind:'draft'}});
 await actualGenerationCall(f.a,f.task,'生成正文',context(),'execute');assert.equal(systems.length,1);assert.equal(systems[0].split(structure.instruction).length,2);
 f.task.criteria='按要求写通知。';await actualGenerationCall(f.a,f.task,'生成正文',context(),'execute');assert.equal(systems.length,2);assert.equal(systems[1].includes(structure.instruction),false);
});

test('real 4291eb15 revision patch preserves its duplicate heading, then is rejected without changing bytes or semantic evidence',async t=>{
 const f=setup(t,{historical:true,replay:livePatch,strict:true}),calls=[];
 const patch=structuredClone(livePatch.patch),initialBytes=livePatch.initialDraft.content;
 assert.equal(patch.edits.length,1);assert.equal(initialBytes.replace(patch.edits[0].before,patch.edits[0].after),livePatch.invalidRevision.content);
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async(a,task,_system,_payload,role='execute')=>{
  calls.push(role);if(role==='execute')return structuredClone(patch);
  const result=historicalVerdict(a,task,calls.length===1?'initial':'revision',livePatch);assert.equal(result.passed,true,result.gaps.join('\n'));return result;
 });
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review');assert.equal(f.task.verification.bodyStructure,undefined);const oldBasis=f.task.grounding.basis;
 await f.a.dispatch('taskAction',{id:f.task.id,command:'revise',note:livePatch.revisionNote});f.task=f.a.task(f.task.id);await f.a.advance(f.task.id);f.task=f.a.task(f.task.id);
 const current=require('../desktop/deliverables.cjs').primary(f.a,f.task),check=f.task.verification.bodyStructure;
 assert.equal(current.content,livePatch.invalidRevision.content);assert.equal(current.title,livePatch.invalidRevision.title);assert.equal(f.draft.content,initialBytes);assert.deepEqual(patch,livePatch.patch);
 assert.notEqual(f.task.grounding.basis,oldBasis);assert.equal(f.task.grounding.passed,true,'evidence report remains independently valid');assert.equal(check.preStructurePassed,true);assert.equal(check.reason,'duplicate-leading-title');assert.equal(check.actual,null);assert.equal(check.titleSyntax,'atx');assert.equal(check.titleHash,hash(current.title));assert.equal(check.contentHash,hash(current.content));
 assert.equal(f.task.status,'blocked');assert.equal(f.task.verification.passed,false);assert.equal(f.task.verificationCheckpoint,undefined);assert.equal(f.task.markerReviewHold,undefined);assert.deepEqual(calls,['verify','execute','verify']);
 assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'BODY_STRUCTURE_REQUIRED'});assert.throws(()=>acceptance.acceptTask(f.a,{id:f.task.id},{actor:'user'}));assert.equal(f.task.acceptedAt,undefined);
 const restarted=f.make(),restored=restarted.task(f.task.id);assert.equal(structure.inspect(restarted,restored).reason,'duplicate-leading-title');assert.equal(require('../desktop/deliverables.cjs').primary(restarted,restored).content,livePatch.invalidRevision.content);
 restored.status='review';restored.verification={passed:true,summary:'Legacy semantic pass',gaps:[],basisVersion:2,basis:acceptance.basis(restarted,restored)};
 assert.ok(acceptance.reasons(restarted,restored).some(r=>r.code==='body_structure'));assert.throws(()=>acceptance.acceptTask(restarted,{id:restored.id},{actor:'user'}));assert.throws(()=>grounding.assertDelivery(restarted,restored),{code:'BODY_STRUCTURE_REQUIRED'});assert.equal(restored.acceptedAt,undefined);
});

test('cached valid body cannot lend its pass to a Markdown duplicate or expression confirmation',async t=>{
 const f=setup(t);let calls=0;t.mock.method(require('../desktop/generation-context.cjs'),'call',async()=>{calls++;return {passed:true,summary:'Offline semantic pass',gaps:[]};});
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review');f.task.status='todo';await f.a.advance(f.task.id);assert.equal(f.task.verification.mode,'exact');assert.equal(calls,1);
 f.draft.content='# 通知\n\n安排。\n\n规则。';assert.ok(acceptance.reasons(f.a,f.task).some(r=>r.code==='body_structure'));
 const report={passed:false,reviewDisposition:'marker_confirmation',markerReview:[{issue:'需确认表达'}],issues:['需确认表达']};report.reportHash=hash(report);
 const rejected=structure.finish(f.a,f.task,{passed:false,summary:'需确认表达',gaps:['需确认表达'],grounding:report});assert.equal(require('../desktop/marker-confirmation.cjs').pendingResult(rejected),false);assert.deepEqual(rejected.grounding,report);
 f.task.status='todo';await f.a.advance(f.task.id);assert.equal(f.task.status,'blocked');assert.equal(f.task.verification.bodyStructure.reason,'duplicate-leading-title');assert.equal(calls,2);
});

test('an explicitly corrected offline patch passes strict evidence checking, acceptance and cold restart',async t=>{
 const f=setup(t,{historical:true,replay:livePatch,strict:true}),calls=[],heading='# '+livePatch.initialDraft.title+'\n\n';
 // This is a labeled positive counterexample, not a modified historical replay
 // or a product-side automatic cleanup. The supplied fixture explicitly edits it.
 const corrected={...structuredClone(livePatch.patch),edits:[...structuredClone(livePatch.patch.edits),{before:heading,after:''}]};
 t.mock.method(require('../desktop/generation-context.cjs'),'call',async(a,task,_system,_payload,role='execute')=>{
  calls.push(role);return role==='execute'?structuredClone(corrected):historicalVerdict(a,task,calls.length===1?'initial':'revision',livePatch);
 });
 await f.a.advance(f.task.id);await f.a.dispatch('taskAction',{id:f.task.id,command:'revise',note:livePatch.revisionNote});f.task=f.a.task(f.task.id);await f.a.advance(f.task.id);f.task=f.a.task(f.task.id);
 const draft=require('../desktop/deliverables.cjs').primary(f.a,f.task);assert.equal(draft.content,livePatch.invalidRevision.content.slice(heading.length));assert.equal(draft.title,livePatch.invalidRevision.title);assert.equal(f.draft.content,livePatch.initialDraft.content);
 assert.equal(f.task.status,'review');assert.equal(f.task.grounding.passed,true);assert.equal(f.task.verification.passed,true);assert.equal(f.task.verification.bodyStructure.kind,'paragraph-count');assert.equal(f.task.verification.bodyStructure.actual,2);assert.deepEqual(acceptance.reasons(f.a,f.task),[]);
 acceptance.acceptTask(f.a,{id:f.task.id},{actor:'user'});assert.equal(f.task.status,'completed');f.a.save();const restarted=f.make(),restored=restarted.task(f.task.id);assert.equal(restored.status,'completed');assert.deepEqual(restored.acceptanceHistory,f.task.acceptanceHistory);assert.equal(structure.inspect(restarted,restored).passed,true);assert.deepEqual(calls,['verify','execute','verify']);
});
