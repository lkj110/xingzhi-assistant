'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const grounding=require('../desktop/grounding.cjs'),generation=require('../desktop/generation-context.cjs'),input=require('../desktop/model-input.cjs');
const sourceText='运维记录：灰度窗口是周四上午，范围仅为东区试用账号。';
const draftText='灰度窗口是周四上午，范围仅为东区试用账号。';
function fixture(t,{artifact=true,source=sourceText,content=draftText,enabled=true,chat}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-input-compaction-'));
 t.after(()=>{
  const resolved=path.resolve(dir),parent=path.resolve(os.tmpdir())+path.sep;
  assert.ok(resolved.startsWith(parent));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 });
 const a=new Assistant({dir,chat});a.data.settings.evidenceGrounding=enabled;
 a.addSources([{title:'原始运维记录',content:source}]);const s=a.data.sources[0];
 const task=a.createTask({title:'灰度说明',description:'依据原文写一段灰度说明。',criteria:'必须保留时间和账号适用范围。',sourceIds:[s.id],generationMode:'single',steps:[{title:'灰度说明',kind:'draft'}]});
 let draft;if(artifact){const step=task.steps[0];draft={id:'input-compaction-current',taskId:task.id,stepId:step.id,title:'灰度说明',content};a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});step.done=true;step.artifactId=draft.id;require('../desktop/deliverables.cjs').record(a,task,step,draft,{});}
 a.save();return {a,task,source:s,draft};
}
const transport=(f,reads)=>input.prepare({...grounding.context(f.a,f.task,{},'verify'),artifacts:[f.draft],contextReads:reads},{stage:'task_verify'});
function response(f,{quote=sourceText,text=draftText,sourceId=f.source.id,start=0}={}){
 const s=grounding.snapshot(f.a,f.task),artifact=s.artifacts[0];
 return {passed:true,summary:'已依据原文独立核对时间及范围。',gaps:[],groundingReview:{consistencyIssues:[],format:'compact-v5',scannedArtifactIds:[artifact.id],citations:[{id:'e1',sourceId,quote,start}],requirements:s.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c1']})),claims:[{id:'c1',artifactId:artifact.id,text,kind:'fact',supported:true,citationIds:['e1']}],unsupportedClaims:[],conflicts:[]}};
}
const read=(id,version,content,start=0)=>({request:{tool:'read_segment',sourceId:id,index:0,start,version},result:{ok:true,sourceId:id,version,content,start,canonical:{origin:0},complete:false,next:start+content.length,coverage:{complete:false,providedComplete:false,reachesEnd:false}}});
const finish=(f,result,wire)=>{const seen=new Set();grounding.observe(seen,wire);return grounding.finish(f.a,f.task,result,{seen});};
async function provider(f){await f.a.dispatch('saveProvider',{name:'输入协议回归模型',baseUrl:'http://127.0.0.1:1/v1',model:'mock',inputPrice:0,outputPrice:0,key:'mock-only-no-external-request'});}

test('compact verifier navigation preserves executable read interfaces and cannot change execute prompts',()=>{
 const task={agentJobId:'job'},system='用户限定的检查范围。';
 const legacy=generation.systemPrompt(task,system,'verify'),compact=generation.systemPrompt(task,system,'verify',{compactVerification:true});
 assert.ok(compact.length<legacy.length,'the verifier uses a shorter navigation contract');
 assert.ok(compact.startsWith(system));
 for(const tool of ['read_context','read_source','search_source','read_section','read_artifact','read_segment','list_sources'])assert.ok(compact.includes(tool),tool);
 for(const field of ['sourceId','artifactId','index','start','next','history','contentRef','textRef','retryCondition'])assert.ok(compact.includes(field),field);
 assert.equal(generation.systemPrompt(task,system,'verify',{compactVerification:false}),legacy);
 assert.equal(generation.systemPrompt(task,system,'execute',{compactVerification:true}),generation.systemPrompt(task,system,'execute'));
});

test('real advance keeps requirements, user facts, current draft and source identities through compact verification',async t=>{
 const calls=[];let f,readCalls=0;
 f=fixture(t,{artifact:false,chat:async(_provider,_key,messages)=>{
  const payload=JSON.parse(messages[1].content);calls.push({system:messages[0].content,payload});
  if(!payload.groundingReviewRequest)return {kind:'artifact',title:'灰度说明',content:draftText};
  if(!readCalls++)return {kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};
  return response(f);
 }});
 await f.a.dispatch('updateTask',{id:f.task.id,description:f.task.description});
 const requirements=grounding.requirements(f.a,f.task),userInputs=grounding.snapshot(f.a,f.task).userInputs;
 await provider(f);await f.a.advance(f.task.id);
 assert.equal(f.task.status,'review',f.task.lastError);assert.equal(calls.length,3,'one generation plus the existing verifier read loop');
 const work=calls[0],checks=calls.slice(1);
 assert.equal(work.payload.groundingReviewRequest,undefined);assert.ok(work.system.includes(grounding.instruction.trim()));
 for(const check of checks){
  assert.deepEqual(check.payload.groundingChecklist.requirements,requirements);
  assert.deepEqual(check.payload.groundingReviewRequest.userInputs,userInputs);
  assert.equal(check.payload.groundingReviewRequest.taskTitle,f.task.title);
  const materialized=input.materialize(check.payload),artifact=materialized.artifacts.find(r=>r.id===f.task.primaryArtifactId);
  assert.equal(artifact.content,draftText);assert.equal(artifact.title,'灰度说明');
  assert.ok(check.payload.sourceCatalog.some(s=>s.id===f.source.id));
 }
 assert.equal(f.task.grounding.claims[0].citations[0].version,grounding.snapshot(f.a,f.task).sources[0].version);
 assert.equal(f.task.grounding.claims[0].citations[0].quote,sourceText);
});

test('strict-off verification retains its original navigation without grounding fields or report requirements',async t=>{
 const f=fixture(t,{enabled:false}),captured=[];
 f.a.call=async(role,system,payload)=>{captured.push({role,system,payload});return {passed:true,summary:'按原检查协议通过。',gaps:[]};};
 const baseSystem='独立检查当前稿件。';
 const result=await generation.call(f.a,f.task,baseSystem,f.a.context(f.task,{verification:true}),'verify');
 assert.equal(result.passed,true);assert.equal(captured.length,1);
 assert.equal(captured[0].system,generation.systemPrompt(f.task,baseSystem,'verify'));
 assert.equal(captured[0].payload.groundingChecklist,undefined);assert.equal(captured[0].payload.groundingReviewRequest,undefined);assert.equal(result.grounding,undefined);
});

test('verification input protocol changes invalidate exact reuse while identical protocol still reuses without calls',async t=>{
 let f,calls=0,requested=false;
 f=fixture(t,{chat:async()=>{calls++;if(!requested){requested=true;return {kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};}return response(f);}});await provider(f);
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review',f.task.lastError);
 // The first independent audit cannot seed exact reuse until grounding itself
 // exists. A second ordinary check may seed it against that validated audit.
 f.task.status='todo';await f.a.advance(f.task.id);assert.equal(f.task.status,'review',f.task.lastError);assert.ok(f.task.verificationCheckpoint.exact);
 const firstCalls=calls,key=f.task.verificationCheckpoint.exact.verifierKey;
 f.task.status='todo';await f.a.advance(f.task.id);assert.equal(calls,firstCalls);assert.equal(f.task.verification.mode,'exact');
 const original=grounding.INPUT_PROTOCOL;t.after(()=>{grounding.INPUT_PROTOCOL=original;});
 assert.equal(typeof original,'string');grounding.INPUT_PROTOCOL=original+'-regression-policy-change';
 f.task.status='todo';await f.a.advance(f.task.id);
 assert.equal(f.task.status,'review',f.task.lastError);assert.equal(calls,firstCalls+1,'a changed verifier input policy must not consume an older exact result');
 assert.notEqual(f.task.verificationCheckpoint.exact.verifierKey,key);
});

test('strict-off exact cache key does not depend on the optional grounding input protocol',async t=>{
 let calls=0;const f=fixture(t,{enabled:false,chat:async()=>{calls++;return {passed:true,summary:'原检查通过。',gaps:[]};}});await provider(f);
 await f.a.advance(f.task.id);assert.equal(f.task.status,'review',f.task.lastError);const firstCalls=calls,key=f.task.verificationCheckpoint.exact.verifierKey;
 const original=grounding.INPUT_PROTOCOL;t.after(()=>{grounding.INPUT_PROTOCOL=original;});grounding.INPUT_PROTOCOL=original+'-disabled-regression';
 f.task.status='todo';await f.a.advance(f.task.id);
 assert.equal(calls,firstCalls);assert.equal(f.task.verification.mode,'exact');assert.equal(f.task.verificationCheckpoint.exact.verifierKey,key);
});

test('projected references cannot transfer observed text to another source or source version',t=>{
 const f=fixture(t),version=grounding.snapshot(f.a,f.task).sources[0].version;
 const valid=transport(f,[read(f.source.id,version,sourceText)]);
 assert.equal(finish(f,response(f),valid).passed,true);
 for(const [id,v] of [[f.source.id,'old-version'],['other-source',version]]){
  const wire=transport(f,[read(id,v,sourceText)]),materialized=input.materialize(wire);
  assert.equal(materialized.contextReads[0].result.sourceId,id);assert.equal(materialized.contextReads[0].result.version,v);
  assert.equal(finish(f,response(f),wire).passed,false,'identical body bytes do not confer original source identity or freshness');
 }
});

test('a compact model input keeps exact source position when equal excerpts occur twice',t=>{
 const quote='仅东区试用账号。',body='旧议程：'+quote+'\n新议程：'+quote;
 const f=fixture(t,{source:body,content:quote}),version=grounding.snapshot(f.a,f.task).sources[0].version,first=body.indexOf(quote),second=body.indexOf(quote,first+1);
 const row=read(f.source.id,version,quote);row.result.canonical.origin=first;
 const wire=transport(f,[row]),materialized=input.materialize(wire);
 assert.equal(materialized.contextReads[0].result.canonical.origin,first);assert.equal(materialized.contextReads[0].result.content,quote);
 assert.equal(finish(f,response(f,{quote,text:quote,start:first}),wire).passed,true);
 assert.equal(finish(f,response(f,{quote,text:quote,start:second}),wire).passed,false,'the unobserved occurrence must remain unobserved');
});

test('compact verification input preserves partial-read gaps and resume metadata rather than granting full coverage',t=>{
 const f=fixture(t),version=grounding.snapshot(f.a,f.task).sources[0].version,split=12;
 const first=read(f.source.id,version,sourceText.slice(0,split)),last=read(f.source.id,version,sourceText.slice(split),split);
 const partial=transport(f,[first]),materialized=input.materialize(partial),result=materialized.contextReads[0].result;
 assert.equal(result.complete,false);assert.equal(result.coverage.providedComplete,false);assert.equal(result.next,split);
 assert.equal(finish(f,response(f),partial).passed,false);
 assert.equal(finish(f,response(f),transport(f,[first,last])).passed,true);
 assert.equal(finish(f,response(f),transport(f,[first,read(f.source.id,version,sourceText.slice(split+1),split+1)])).passed,false,'one unread character still prevents a full original quote');
});

test('observing text in a compact input does not authorize a source withdrawn from current scope',t=>{
 const f=fixture(t),version=grounding.snapshot(f.a,f.task).sources[0].version,wire=transport(f,[read(f.source.id,version,sourceText)]),raw=response(f);
 assert.equal(finish(f,raw,wire).passed,true);
 require('../desktop/evidence-links.cjs').withdrawSources(f.a,f.task,[f.source.id],{reason:'用户移除本事项授权资料'});
 assert.equal(finish(f,raw,wire).passed,false);
});

test('runtime reports input policy identity without persisting diagnostic metadata into task facts',t=>{
 const f=fixture(t),before=JSON.stringify(f.a.data),status=grounding.status(f.a);
 assert.equal(status.inputProtocol,grounding.INPUT_PROTOCOL);assert.ok(status.inputProtocol);
 assert.equal(status.version,12);assert.equal(status.format,'compact-v5');assert.equal(status.inputProtocol,'verify-input-v12');assert.equal(JSON.stringify(f.a.data),before);
});
