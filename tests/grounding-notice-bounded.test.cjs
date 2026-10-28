'use strict';
// These exposed cases are regression inputs, not fresh model-evaluation samples.
// The synthetic checker verdict isolates the local marker/evidence contract; it
// neither calls a model nor independently proves full semantic coverage.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs');
const suite=require('../evaluations/foundation-candidate-20261028/stimuli.json');
const gold=require('../evaluations/foundation-candidate-20261028/gold.json');
const {project}=require('../evaluations/foundation-candidate-20261028/inputs.cjs');

async function fixture(t,id,{revised=false}={}){
 const spec=suite.cases.find(c=>c.id===id),g=gold.cases.find(c=>c.id===id),input=project(spec);
 const tmp=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(tmp,'xingzhi-notice-bounded-'));let modelCalls=0;
 const a=new Assistant({dir,chat:async()=>{modelCalls++;throw Error('Offline local-marker regression forbids model calls');}});
 t.after(()=>{assert.equal(modelCalls,0);require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);assert.ok(path.resolve(dir).startsWith(tmp+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 a.data.settings.evidenceGrounding=true;a.addSources(input.sources);
 const source=a.data.sources[0],task=a.createTask({...input,sourceIds:[source.id],generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
 await a.dispatch('updateTask',{id:task.id,description:input.description});
 if(revised)task.notes.push({kind:'revise',text:spec.revision.note});
 const content=revised?g.referenceDraft:g.initialReferenceDraft||g.referenceDraft;
 const claimText=(revised?g.notificationClaims:g.initialNotificationClaims||g.notificationClaims)[0].text;
 const step=task.steps[0],draft={id:'bounded-notice-draft',taskId:task.id,stepId:step.id,title:content.split('\n')[0],content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});step.done=true;step.artifactId=draft.id;require('../desktop/deliverables.cjs').record(a,task,step,draft,{});a.save();
 const f={a,task,draft,source,spec,g,claimText};f.seen=observe(f);f.response=report(f);return f;
}
function observe(f){
 const snapshot=grounding.snapshot(f.a,f.task),seen=new Set();
 grounding.observe(seen,{artifacts:[f.draft],contextReads:[{result:{sourceId:f.source.id,version:snapshot.sources[0].version,content:f.source.content}}]});
 grounding.observe(seen,grounding.context(f.a,f.task,{},'verify'));return seen;
}
function report(f){return {passed:true,summary:'OFFLINE: existing independent checker supports the bound notice',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[f.draft.id],citations:[{id:'e1',sourceId:f.source.id,quote:f.source.content,start:0}],requirements:grounding.snapshot(f.a,f.task).requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['p1']})),claims:[{id:'p1',artifactId:f.draft.id,text:f.claimText,kind:'proposal',supported:true,citationIds:['e1']}],unsupportedClaims:[],conflicts:[]}};}
const finish=f=>grounding.finish(f.a,f.task,f.response,{seen:f.seen});

for(const [id,revised]of [['N01-yunhe-notice',false],['N03-lansui-revision',false],['N03-lansui-revision',true]])test('exposed notice accepts existing supported proposal with exact evidence: '+id+(revised?' revised':''),async t=>{
 const f=await fixture(t,id,{revised}),before=f.draft.content,result=finish(f);
 assert.equal(result.passed,true,result.gaps.join('\n'));assert.equal(f.draft.content,before);assert.equal(f.draft.title,before.split('\n')[0]);
 const claim=result.grounding.claims[0];assert.equal(claim.kind,'proposal');assert.equal(claim.text,f.claimText);assert.equal(claim.citations.length,1);
 const q=claim.citations[0];assert.equal(q.sourceId,f.source.id);assert.equal(f.source.content.slice(q.start,q.end),q.quote);assert.equal(q.version,grounding.snapshot(f.a,f.task).sources[0].version);
 if(id==='N01-yunhe-notice'){assert.match(f.task.description,/整理成/);assert.match(f.claimText,/，/);assert.match(f.draft.title,/短信确认/);}
 if(revised){assert.ok(result.grounding.requirements.some(r=>r.text===f.spec.revision.note));assert.equal(f.draft.content.split('\n').filter(line=>/^- /.test(line)).length,3);}
});

test('normal English comma preserves the same evidenced notice arrangements',async t=>{
 const f=await fixture(t,'N01-yunhe-notice'),original=f.claimText,variant=original.replace('，',',');assert.notEqual(variant,original);
 f.draft.content=f.draft.content.replace(original,variant);f.claimText=variant;f.response.groundingReview.claims[0].text=variant;f.seen=observe(f);
 const result=finish(f);assert.equal(result.passed,true,result.gaps.join('\n'));assert.equal(result.grounding.claims[0].text,variant);
 assert.equal(result.grounding.claims[0].citations[0].quote,f.source.content,'Original source punctuation and exact quote are unchanged');
});

test('updated requirements and draft do not reuse the initial notice grounding',async t=>{
 const f=await fixture(t,'N03-lansui-revision'),initial=finish(f);assert.equal(initial.passed,true);f.task.grounding=initial.grounding;
 f.task.notes.push({kind:'revise',text:f.spec.revision.note});f.draft.content=f.g.referenceDraft;f.draft.title=f.g.referenceDraft.split('\n')[0];f.claimText=f.g.notificationClaims[0].text;
 assert.equal(grounding.reusable(f.a,f.task),null);f.seen=observe(f);f.response=report(f);
 const final=finish(f);assert.equal(final.passed,true,final.gaps.join('\n'));assert.notEqual(final.grounding.basis,initial.grounding.basis);assert.equal(final.grounding.reused,false);
 assert.ok(final.grounding.requirements.some(r=>r.text===f.spec.revision.note));assert.equal(final.grounding.claims[0].text,f.claimText);
});

test('notice still needs a trusted current captured user request',async t=>{
 const f=await fixture(t,'N01-yunhe-notice');f.task.groundingUserInputs=[];assert.equal(finish(f).passed,false);
 f.task.groundingUserInputs=[{field:'description',origin:'model',text:f.task.description}];assert.equal(finish(f).passed,false);
 f.task.groundingUserInputs=[{field:'description',origin:'user',text:f.task.description+'旧版本'}];assert.equal(finish(f).passed,false);
});

test('a notice title alone cannot supply the missing notice context in the captured request',async t=>{
 const f=await fixture(t,'N01-yunhe-notice');
 await f.a.dispatch('updateTask',{id:f.task.id,description:'根据资料整理一份安排摘要。'});
 f.seen=observe(f);f.response=report(f);
 assert.ok(f.draft.title.includes('通知'));
 const result=finish(f);assert.equal(result.passed,false);
 assert.deepEqual(result.grounding.issues,['推断、建议或未知未在正文标明：p1']);
});

test('notice proposal still must link to the satisfied user requirement',async t=>{
 const f=await fixture(t,'N01-yunhe-notice');for(const r of f.response.groundingReview.requirements){r.claimIds=[];r.reason='离线测试：未关联此通知结论';}
 assert.equal(finish(f).passed,false);
});

for(const kind of ['unknown','inference'])test('a request tone does not waive '+kind+' markers',async t=>{
 const f=await fixture(t,'N03-lansui-revision');f.response.groundingReview.claims[0].kind=kind;assert.equal(finish(f).passed,false);
});

test('missing, unread, changed and stale evidence still blocks the notice',async t=>{
 const f=await fixture(t,'N01-yunhe-notice'),g=f.response.groundingReview,originalSeen=f.seen;
 g.claims[0].citationIds=[];assert.equal(finish(f).passed,false);g.claims[0].citationIds=['e1'];
 const original=g.citations[0].quote;g.citations[0].quote='不存在的批准原句';assert.equal(finish(f).passed,false);g.citations[0].quote=original;
 f.seen=new Set([f.draft.content]);assert.equal(finish(f).passed,false);
 grounding.observe(f.seen,{contextReads:[{result:{sourceId:f.source.id,version:'obsolete',content:f.source.content}}]});assert.equal(finish(f).passed,false);
 f.seen=originalSeen;assert.equal(finish(f).passed,true);
});

test('independent refusal, unresolved conflict and unmet requirement remain blocking',async t=>{
 const f=await fixture(t,'N01-yunhe-notice'),g=f.response.groundingReview;
 g.claims[0].supported=false;g.claims[0].reason='当前来源不支持';assert.equal(finish(f).passed,false);g.claims[0].supported=true;
 f.response.passed=false;f.response.gaps=['未通过独立核验'];assert.equal(finish(f).passed,false);f.response.passed=true;f.response.gaps=[];
 g.unsupportedClaims=['p1'];assert.equal(finish(f).passed,false);g.unsupportedClaims=[];
 g.conflicts=['当前安排与有效原文冲突'];assert.equal(finish(f).passed,false);g.conflicts=[];
 g.requirements[0].status='gap';g.requirements[0].reason='用户要求未满足';assert.equal(finish(f).passed,false);
});

for(const wrong of ['请收到短信的志愿者参加，活动已批准向全部公众开放。','请各组确认48块展板已经交回。'])test('existing independent negative verdict still blocks unsupported approval/completion: '+wrong,async t=>{
 const f=await fixture(t,'N03-lansui-revision'),g=f.response.groundingReview;
 f.draft.content=f.draft.content.replace(f.claimText,wrong);g.claims[0].text=wrong;g.claims[0].supported=false;g.claims[0].reason='原文没有批准公众开放，也没有完成交回记录';g.unsupportedClaims=['p1'];g.conflicts=['该断言与待执行安排相冲突'];
 f.seen=observe(f);const result=finish(f);assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/关键结论未获支持|待执行安排相冲突/);
});
