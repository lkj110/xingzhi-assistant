'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),g=require('../desktop/grounding.cjs'),p=require('../desktop/task-context.cjs'),fin=require('../desktop/check-finalization.cjs');
const input=require('../desktop/model-input.cjs'),fields=require('../desktop/citation-fields.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xingzhi-citation-fields-'));
 const a=new Assistant({dir,chat:async()=>{throw Error('Offline only');}});
 t.after(()=>{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 a.data.settings.evidenceGrounding=true;a.addSources([{title:'泊棠PT-R08声景复听安排',content:'本轮复听对象为PT-R08三个声景采样段，复听和拼接均未开始。'}]);
 const source=a.data.sources[0],task=a.createTask({title:'PT-R08复听通知',description:'根据资料形成通知，保留条件。',sourceIds:[source.id],steps:[{title:'形成通知',kind:'draft'}]});
 const step=task.steps[0],draft={id:'draft',taskId:task.id,stepId:step.id,title:task.title,content:source.content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});Object.assign(step,{done:true,artifactId:draft.id});require('../desktop/deliverables.cjs').record(a,task,step,draft,{});a.save();
 const f={a,task,source,draft};return f;
}
function report(f){return {passed:true,summary:'Offline fixture semantic verdict',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[f.draft.id],citations:[{id:'b',sourceId:f.source.id,quote:f.source.content},{id:'t',sourceId:f.source.id,field:'title',quote:f.source.title}],requirements:g.snapshot(f.a,f.task).requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['c']})),claims:[{id:'c',artifactId:f.draft.id,text:f.draft.content,kind:'fact',supported:true,citationIds:['b','t']}],unsupportedClaims:[],conflicts:[]}};}
function observed(f,{title=true,version,sourceId,titleText}={}){
 const s=g.snapshot(f.a,f.task),row=s.sources.find(r=>r.id===f.source.id),seen=new Set();
 g.observe(seen,input.prepare({artifacts:[f.draft],sourceCatalog:title?[{...row,id:sourceId||row.id,version:version||row.version,title:titleText??row.title}]:[],contextReads:[{result:{sourceId:f.source.id,version:row.version,content:f.source.content}}]},{stage:'task_verify'}));return seen;
}
const finish=(f,r=report(f),seen=observed(f))=>g.finish(f.a,f.task,r,{seen});
function identity(f){return p.withContext(f.a,p.taskScope(f.task),op=>fin.identity(f.a,f.task,{artifacts:[f.draft]},op.context(),'result'));}

test('explicit complete title plus body binds distinct fields and keeps original body offsets',t=>{
 const f=fixture(t),r=finish(f);assert.equal(r.passed,true,r.summary);const [b,q]=r.grounding.claims[0].citations;
 assert.equal(b.field,undefined);assert.equal(b.quote,f.source.content);assert.equal(q.field,'title');assert.equal(q.start,0);assert.equal(q.end,f.source.title.length);assert.ok(q.fieldHash);assert.equal(q.version,b.version);
});
test('legacy body citations remain valid and a title without field is never inferred or dropped',t=>{
 const f=fixture(t),r=report(f);delete r.groundingReview.citations[1].field;assert.equal(finish(f,r).passed,false);
 r.groundingReview.citations.pop();r.groundingReview.claims[0].citationIds=['b'];assert.equal(finish(f,r).passed,true);
 r.groundingReview.citations[0].field='content';assert.equal(finish(f,r).passed,true);
});
for(const field of [null,'','TITLE','metadata',{},0])test('reject unknown citation field '+JSON.stringify(field),t=>{const f=fixture(t),r=report(f);r.groundingReview.citations[1].field=field;assert.equal(finish(f,r).passed,false);});
for(const [name,change]of Object.entries({substring:q=>q.quote=q.quote.slice(1),forged:q=>q.quote+='已批准',offset:q=>q.start=1,nullOffset:q=>q.start=null,version:q=>q.version='obsolete',source:q=>q.sourceId='other',user:q=>q.sourceId='user:description'}))test('reject invalid title '+name,t=>{const f=fixture(t),r=report(f);change(r.groundingReview.citations[1]);assert.equal(finish(f,r).passed,false);});
for(const options of [{title:false},{version:'obsolete'},{sourceId:'other'},{titleText:'截断标题'}])test('title must be actually sent for exact current source and version '+JSON.stringify(options),t=>{const f=fixture(t);assert.equal(finish(f,report(f),observed(f,options)).passed,false);});
test('title in arbitrary prose and unshown catalog rows is not a title-field observation',t=>{
 const f=fixture(t),seen=observed(f,{title:false});g.observe(seen,{note:f.source.title});assert.equal(finish(f,report(f),seen).passed,false);
 const row=g.snapshot(f.a,f.task).sources[0],catalog=Array.from({length:24},(_,i)=>({...row,id:'other-'+i,ref:'s'+i})).concat({...row,ref:'s24'}),wire=input.prepare({readableCatalog:catalog},{stage:'task_verify'});
 assert.equal(wire.sourceCatalog.length,24);g.observe(seen,wire);assert.equal(finish(f,report(f),seen).passed,false);
});
test('actual paged directory and actual read results can supply title without duplicating it',t=>{
 const f=fixture(t),row=g.snapshot(f.a,f.task).sources[0];
 for(const result of [{directory:true,sources:[row]},{sourceId:row.id,version:row.version,title:row.title,content:f.source.content}]){const seen=observed(f,{title:false});g.observe(seen,{contextReads:[{result}]});assert.equal(finish(f,report(f),seen).passed,true);}
});
for(const kind of ['fact','inference','proposal','unknown'])test('title alone cannot support '+kind+' or expression confirmation',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.claims[0].kind=kind;r.groundingReview.claims[0].citationIds=['t'];const result=finish(f,r);assert.equal(result.passed,false);assert.equal(result.grounding.reviewDisposition,undefined);
});
test('valid title cannot override independent semantic rejection, unsupported business claims or conflict',t=>{
 const f=fixture(t);for(const mutate of [r=>r.passed=false,r=>r.gaps=['正文不支持已批准'],r=>r.groundingReview.claims[0].supported=false,r=>r.groundingReview.conflicts=['正文明确尚未批准'],r=>r.groundingReview.unsupportedClaims=['缺少执行事实']]){const r=report(f);mutate(r);assert.equal(finish(f,r).passed,false);}
});
test('a title cannot supply the second side of a disclosed source conflict',t=>{
 const f=fixture(t);f.draft.content='无法确定';const r=report(f),c=r.groundingReview.claims[0];c.kind='unknown';r.groundingReview.sourceConflicts=[{disposition:'disclosed_unknown',claimIds:['c'],requirementIds:r.groundingReview.requirements.map(q=>q.id),citationIds:['b','t'],reason:'允许未知但这里只提供一段正文'}];assert.equal(finish(f,r).passed,false);
});
for(const change of [s=>s.title+=' ',s=>s.title='é',s=>s.title='e\u0301'])test('exact title change invalidates passed report, cache and delivery '+String(change),t=>{
 const f=fixture(t),before=g.snapshot(f.a,f.task),r=finish(f);f.task.grounding=r.grounding;f.task.verification={passed:true,summary:'fixture',gaps:[],basis:require('../desktop/acceptance.cjs').basis(f.a,f.task),at:new Date().toISOString()};assert.ok(g.reusable(f.a,f.task));
 change(f.source);assert.equal(g.snapshot(f.a,f.task).sources[0].version,before.sources[0].version);assert.notEqual(g.snapshot(f.a,f.task).basis,before.basis);assert.equal(g.reusable(f.a,f.task),null);assert.throws(()=>g.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});assert.equal(require('../desktop/verification-cache.cjs').prepare(f.a,f.task,{artifacts:[f.draft]}).mode,'full');
});
test('bounded identity binds raw titles, rejects replay after restart and A to B to A',t=>{
 const f=fixture(t),oldTitle=f.source.title,first=identity(f);fin.reserve(f.task,first);assert.equal(fin.state(f.task,identity(f)).available,false);
 f.source.title+=' ';const next=identity(f);assert.notEqual(first.semanticCheckId,next.semanticCheckId);assert.equal(first.compatibilityKey,next.compatibilityKey);assert.equal(fin.state(f.task,next).available,true);fin.reserve(f.task,next);f.a.save();
 const restored=new Assistant({dir:f.a.dir,chat:async()=>{throw Error('Offline only');}}),rf={a:restored,task:restored.task(f.task.id),draft:restored.data.artifacts.find(r=>r.id===f.draft.id)};assert.equal(fin.state(rf.task,identity(rf)).available,false);
 f.source.title=oldTitle;assert.equal(fin.state(f.task,identity(f)).available,false);
});
test('protocol upgrade never reopens a legacy consumed identity with unknown title basis',t=>{
 const f=fixture(t);f.a.data.settings.evidenceGrounding=false;const old=identity(f);fin.reserve(f.task,old);f.a.data.settings.evidenceGrounding=true;
 assert.equal(fin.state(f.task,identity(f)).available,false);f.source.title+=' ';assert.equal(fin.state(f.task,identity(f)).available,false,'Old title was not bound, so no proof of a different consumed check');
});
test('strict mode toggle never grants another bounded call, including after restart',t=>{
 const f=fixture(t);fin.reserve(f.task,identity(f));f.a.data.settings.evidenceGrounding=false;assert.equal(fin.state(f.task,identity(f)).available,false);f.a.save();
 const restored=new Assistant({dir:f.a.dir,chat:async()=>{throw Error('Offline only');}}),rf={a:restored,task:restored.task(f.task.id),draft:restored.data.artifacts.find(r=>r.id===f.draft.id)};
 assert.equal(fin.state(rf.task,identity(rf)).available,false);restored.data.settings.evidenceGrounding=true;assert.equal(fin.state(rf.task,identity(rf)).available,false);
 rf.draft.content+='新稿';assert.equal(fin.state(rf.task,identity(rf)).available,true);
});
test('title hash preserves whitespace and Unicode composition',()=>{const row={id:'s',version:'v',type:'source',purpose:'input',title:'é'};assert.notEqual(fields.titleBasis([row]),fields.titleBasis([{...row,title:'e\u0301'}]));assert.notEqual(fields.titleBasis([row]),fields.titleBasis([{...row,title:'é '}]))});

test('title changed during a verifier response is rejected before persisting a conclusion',async t=>{
 const f=fixture(t),before=g.snapshot(f.a,f.task).sources[0].version;let calls=0;f.a.call=async()=>{calls++;f.source.title+=' changed';return report(f);};
 await assert.rejects(require('../desktop/generation-context.cjs').call(f.a,f.task,'',f.a.context(f.task,{verification:true}),'verify'),{code:'CONTEXT_VERSION_CHANGED'});assert.equal(calls,1);assert.equal(g.snapshot(f.a,f.task).sources[0].version,before);assert.equal(f.task.grounding,undefined);
});
