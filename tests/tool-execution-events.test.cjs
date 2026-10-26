'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tool=require('../desktop/tool-evidence.cjs'),events=require('../desktop/tool-execution-events.cjs'),ground=require('../desktop/grounding.cjs'),{Assistant}=require('../desktop/core.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-events-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;a.addSources([{title:'秤量',content:'2 3'}]);const source=a.data.sources[0],task=a.createTask({title:'合计',criteria:'求和 kg',sourceIds:[source.id],steps:[{title:'计算',kind:'draft'}]}),request={tool:'compute_evidence',operation:'sum',inputs:[{sourceId:source.id,start:0,end:1,unit:'kg'},{sourceId:source.id,start:2,end:3,unit:'kg'}],args:{unit:'kg'}};return {a,task,source,request,run:()=>tool.execute(a,task,request)};}
test('identical explicit requests retain one result and distinct events; validation creates none',t=>{
 const f=setup(t),first=f.run(),basis=ground.snapshot(f.a,f.task).basis;
 for(let i=0;i<3;i++){assert.ok(tool.valid(f.a,f.task,first));tool.current(f.a,f.task);tool.project(first,f.task);ground.snapshot(f.a,f.task);}
 assert.equal(f.task.toolExecutions.length,1);assert.equal(ground.snapshot(f.a,f.task).basis,basis);
 const second=f.run();assert.equal(second.id,first.id);assert.equal(second.observedAt,first.observedAt);assert.equal(f.task.toolEvidence.length,1);assert.equal(f.task.toolExecutions.length,2);assert.notEqual(f.task.toolExecutions[0].id,f.task.toolExecutions[1].id);assert.equal(f.task.toolExecutions[1].kind,'recomputed');assert.notEqual(ground.snapshot(f.a,f.task).basis,basis);
 assert.equal(tool.project(first,f.task).progressKey,tool.project(second,f.task).progressKey);f.a.save();const reopened=new Assistant({dir:f.a.dir});assert.deepEqual(reopened.task(f.task.id).toolExecutions,f.task.toolExecutions);
});
test('same-batch results preserve the event count at each observation without fabricating progress',async t=>{
 const f=setup(t),batch=await tool.readRequests(f.a,f.task,[f.request,f.request],()=>{throw Error('unexpected fallback');});assert.deepEqual(batch.toolEvidence.map(r=>r.executions.retainedCount),[1,2]);assert.equal(batch.toolEvidence[0].id,batch.toolEvidence[1].id);
 const state={};assert.equal(tool.progress(state,batch.toolEvidence[0],{toolEvidence:batch.toolEvidence}),'fresh');assert.equal(tool.progress(state,batch.toolEvidence[1],{toolEvidence:batch.toolEvidence}),'duplicate');
 const facts=require('../desktop/tool-registry.cjs').facts;assert.deepEqual(facts('compute_evidence',batch.rows[0].result),facts('compute_evidence',batch.rows[1].result));
});
test('failed calls, source mutation and revoked access never retain a successful old observation',t=>{
 const f=setup(t),r=f.run();assert.throws(()=>tool.execute(f.a,f.task,{...f.request,operation:'run_code'}));assert.equal(f.task.toolExecutions.length,1);
 f.source.content='4 3';assert.equal(tool.valid(f.a,f.task,r),false);const next=f.run();assert.equal(next.output.value,'7');assert.notEqual(next.id,r.id);assert.equal(events.rows(f.task,next).length,1);
 f.a.contextAccessCheck=()=>({allowed:false,decision:'deny',revision:2});assert.throws(f.run);assert.equal(f.task.toolExecutions.length,2);assert.equal(tool.current(f.a,f.task).length,0);
});
test('event ledger and projection are bounded and reject duplicates, alterations and foreign ownership',t=>{
 const f=setup(t);let r;for(let i=0;i<135;i++)r=f.run();assert.equal(f.task.toolExecutions.length,128);assert.equal(events.project(f.task,r).events.length,4);assert.equal(events.project(f.task,r).retainedCount,128);assert.equal(events.project(f.task,r).omitted,124);
 const e=f.task.toolExecutions[0];f.task.toolExecutions=[e,{...e}];assert.equal(events.rows(f.task,r).length,0);f.task.toolExecutions=[{...e,kind:'computed'}];assert.equal(events.rows(f.task,r).length,0);f.task.toolExecutions=[e];assert.equal(events.rows({...f.task,id:'foreign'},r).length,0);
});
test('explicit execution claims require the exact current execution text actually shown to verification',t=>{
 const f=setup(t),r=f.run();f.run();const projection=tool.project(r,f.task),step=f.task.steps[0],draft={id:'draft',taskId:f.task.id,stepId:step.id,title:'记录',content:'完成两次显式求值。'};
 f.a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(f.a,'artifact',draft,{task:f.task});step.done=true;step.artifactId=draft.id;require('../desktop/deliverables.cjs').record(f.a,f.task,step,draft,{});
 const report={passed:true,summary:'核对',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],requirements:ground.requirements(f.a,f.task).map(q=>({id:q.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:draft.id,text:draft.content,kind:'fact',supported:true,citationIds:['e']}],citations:[{id:'e',sourceId:r.id,quote:projection.resultText.split('\n')[1]}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}};
 const seen=new Set();ground.observe(seen,{artifacts:[draft],toolEvidence:[tool.project(r)]});assert.equal(ground.finish(f.a,f.task,report,{seen}).passed,false);
 ground.observe(seen,{toolEvidence:[projection]});assert.equal(ground.finish(f.a,f.task,report,{seen}).passed,true);
 f.run();assert.equal(ground.finish(f.a,f.task,report,{seen}).passed,false,'another explicit invocation changes the citable event basis');
});
