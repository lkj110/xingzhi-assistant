'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const grounding=require('../desktop/grounding.cjs');
const {hash}=require('../desktop/evidence-basis.cjs');
const inputText='会议确认：产品定于周五发布，仅限内测用户。';
const draftText='产品定于周五发布，仅限内测用户。';

function workspace(t,chat){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-grounding-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const a=new Assistant({dir,chat});a.data.settings.evidenceGrounding=true;return a;
}
function setup(t,{content=draftText,source=inputText,description='根据会议记录撰写发布摘要。',criteria='说明发布日期和适用用户。',artifact=true,chat}={}){
 const a=workspace(t,chat);a.addSources([{title:'发布会议',content:source}]);const s=a.data.sources[0];
 const task=a.createTask({title:'发布摘要',description,criteria,sourceIds:[s.id],generationMode:'single',steps:[{title:'撰写摘要',kind:'draft'}]});
 let draft;
 if(artifact){
  const step=task.steps[0];draft={id:'grounding-draft',taskId:task.id,stepId:step.id,title:'发布摘要',content,createdAt:new Date().toISOString()};
  a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});step.done=true;step.artifactId=draft.id;
  require('../desktop/deliverables.cjs').record(a,task,step,draft,{});
 }
 a.save();return {a,task,source:s,draft};
}
function rawReport(a,task,{claimText=draftText,kind='fact',sourceId,quote=inputText,claim=true,status='satisfied',deferredStepId}={}){
 const snapshot=grounding.snapshot(a,task),artifact=snapshot.artifacts[0];sourceId??=snapshot.sources[0]?.id;
 return {passed:true,summary:'完成标准已逐项核对',gaps:[],groundingReview:{
  scannedArtifactIds:snapshot.artifacts.map(r=>r.id),requirements:snapshot.requirements.map(r=>({id:r.id,status,claimIds:claim?['c1']:[],reason:'按要求核对当前正文和会议原文',...(deferredStepId?{deferredStepId}:{})})),
  claims:claim?[{id:'c1',artifactId:artifact?.id,text:claimText,kind,supported:true,reason:'原文明确说明日期和适用范围',citations:['fact','inference'].includes(kind)?[{sourceId,quote}]:[]}]:[],unsupportedClaims:[],conflicts:[]}};
}
const seenFor=({a,task,draft,source})=>{
 const seen=new Set(),version=grounding.snapshot(a,task).sources.find(r=>r.id===source?.id)?.version;
 grounding.observe(seen,{artifacts:draft?[draft]:[],contextReads:source?[{result:{ok:true,sourceId:source.id,version,content:source.content}}]:[]});
 return seen;
};
const finish=(f,response=rawReport(f.a,f.task),options={})=>grounding.finish(f.a,f.task,response,{seen:seenFor(f),...options});
function publicationFixture(t,options={}){
 const f=setup(t,options),{a,task,source}=f,output=fs.realpathSync(a.dir);
 const job={id:'grounding-publish-job',projectId:null,title:'发布摘要',goal:'按已核验正文交付',status:'ready',taskIds:[task.id],sourceIds:[source.id],
  feedback:[],followups:[],history:[],watchers:[{tool:'github_read',args:{number:7},taskIds:[task.id],sourceId:source.id}],
  outputFolder:output,fileMode:'auto',githubRepo:'example/grounding-fixture',githubMode:'auto',githubCommentMode:'auto',localTools:{mailMode:'ask'}};
 task.agentJobId=job.id;task.githubIssue={number:7};a.data.delegations.push(job);
 // Only permission/plan admission is mocked. The actual write preparation,
 // journal, current draft selection, grounding and payload checks execute.
 a.contextAccessCheck=()=>({allowed:true,decision:'allow',revision:1});
 t.mock.method(require('../desktop/protocol-access.cjs'),'assertTool',()=>{});
 t.mock.method(require('../desktop/agent-plan.cjs'),'assertReady',()=>{});
 t.mock.method(require('../desktop/execution-gate.cjs'),'assert',()=>{});
 const calls={github:0,mail:0};
 t.mock.method(require('../desktop/agent-tools.cjs'),'github',async()=>{calls.github++;throw Error('Unexpected network transport');});
 t.mock.method(require('../desktop/local-external.cjs'),'submit',async()=>{calls.mail++;throw Error('Unexpected external mail transport');});
 a.data.connectors.push({id:'grounding-mail',provider:'outlook',name:'模拟邮箱',projectId:null,enabled:true,allowSend:true,sealedToken:'unused-fixture-token'});
 return {...f,job,calls};
}
function markContentChecked(f){
 const result=finish(f);assert.equal(result.passed,true,result.gaps.join('\n'));f.task.grounding=result.grounding;
 f.task.contentVerification={passed:true,summary:'已独立核对正文',gaps:[],basis:require('../desktop/execution-control.cjs').contentBasis(f.a,f.job,f.task)};
 return result;
}

test('checklist uses stable requirement identities and avoids duplicating equal requirements',t=>{
 const f=setup(t,{description:'相同要求',criteria:'相同要求\n另一要求'});
 const before=grounding.requirements(f.a,f.task);assert.equal(before.length,2);assert.equal(new Set(before.map(r=>r.id)).size,2);
 f.task.status='running';assert.deepEqual(grounding.requirements(f.a,f.task),before);
 const input=grounding.context(f.a,f.task,{currentStep:{id:f.task.steps[0].id}},'execute');
 assert.equal(input.groundingChecklist.requirements.length,2);assert.equal(input.groundingReviewRequest,undefined);
 assert.equal(JSON.stringify(input).includes(inputText),false,'planning checklist does not repeat whole source bodies');
});

test('valid independent review binds conclusions to exact current source version and position',t=>{
 const f=setup(t),result=finish(f);assert.equal(result.passed,true);assert.equal(result.grounding.passed,true);
 assert.equal(result.groundingReview,undefined,'raw model report is not persisted twice');
 const citation=result.grounding.claims[0].citations[0];assert.equal(citation.start,0);assert.equal(citation.end,inputText.length);assert.equal(citation.quote,inputText);
 assert.equal(citation.version,grounding.snapshot(f.a,f.task).sources[0].version);
 assert.equal(result.grounding.reportHash,hash({...result.grounding,reportHash:undefined}));
});

test('missing model report fails closed while preserving generated business draft',t=>{
 const f=setup(t),before=f.draft.content,result=finish(f,{passed:true,summary:'已完成',gaps:[]});
 assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/清单/);assert.equal(f.draft.content,before);
 assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});
});

test('nonexistent, foreign, and self-authored artifact citations cannot supply factual evidence',t=>{
 const f=setup(t);f.a.addSources([{title:'未分配的另一事项材料',content:'另一事项的私有记录：'+inputText}]);
 const foreign=f.a.data.sources.find(s=>s.id!==f.source.id);
 for(const sourceId of ['missing',foreign.id,f.draft.id]){
  const result=finish(f,rawReport(f.a,f.task,{sourceId}));assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/授权输入|有效原文/);
 }
});

test('altered quote or current conclusion not present in draft is rejected',t=>{
 const f=setup(t);for(const options of [{quote:'会议确认：产品定于周六发布。'},{claimText:'产品已经正式发布。'}]){
  const result=finish(f,rawReport(f.a,f.task,options));assert.equal(result.passed,false);
 }
});

test('source on disk but never supplied to this checker cannot support a conclusion',t=>{
 const f=setup(t),result=finish(f,undefined,{seen:new Set([f.draft.content])});
 assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/尚未提供/);
});

test('checker must see full current draft even when claimed scan list says complete',t=>{
 const f=setup(t,{content:draftText+'另有尚未核实的销量数据。'});
 const result=finish(f,rawReport(f.a,f.task),{seen:new Set([draftText,inputText])});assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/完整阅读/);
 const fragments=new Set([f.draft.content.slice(0,8),f.draft.content.slice(8)]);assert.equal(grounding.covered(f.draft.content,fragments),true);
 assert.equal(grounding.covered(f.draft.content,new Set([f.draft.content.slice(0,8),f.draft.content.slice(9)])),false);
});

test('duplicate quote needs exact source position to avoid quoting a different occurrence',t=>{
 const f=setup(t,{source:inputText+'\n另一次会议：'+inputText});
 const response=rawReport(f.a,f.task);assert.equal(finish(f,response).passed,false);
 response.groundingReview.claims[0].citations[0].start=0;assert.equal(finish(f,response).passed,true);
});

test('clearly labelled unknown and proposal may have no external factual citations',t=>{
 for(const [kind,content] of [['unknown','实际发布日期尚未确认。'],['proposal','建议先向内测用户发布。']]){
  const f=setup(t,{content});assert.equal(finish(f,rawReport(f.a,f.task,{kind,claimText:content})).passed,true);
 }
 const f=setup(t,{content:'产品定于周五发布。'});assert.equal(finish(f,rawReport(f.a,f.task,{kind:'unknown',claimText:f.draft.content})).passed,false,'unlabelled fact cannot be relabelled as unknown');
});

for(const content of ['无法确定','无法确认','未知']){
 test('explicit unknown wording is accepted: '+content,t=>{
  const f=setup(t,{content,source:'资料仅记载处理量增加40%，未提供绝对处理量。',description:'根据资料回答当前绝对处理量。',criteria:'资料不足时允许如实说明未知。'});
  const result=finish(f,rawReport(f.a,f.task,{kind:'unknown',claimText:content}));
  assert.equal(result.passed,true,content+': '+result.gaps.join('\n'));
 });
}

test('unknown wording acceptance preserves unlabelled-assertion and factual-evidence guards',t=>{
 const f=setup(t,{content:'产品定于周五发布。'});
 assert.equal(finish(f,rawReport(f.a,f.task,{kind:'unknown',claimText:f.draft.content})).passed,false,'an unlabelled assertion is not an explicit unknown');
 const fact=rawReport(f.a,f.task,{kind:'fact',claimText:f.draft.content});fact.groundingReview.claims[0].citations=[];
 assert.equal(finish(f,fact).passed,false,'facts still require valid original citations');
});

test('inference needs explicit wording and original premise evidence',t=>{
 const f=setup(t,{content:'根据内测范围，预计首批用户较少。'});
 const result=finish(f,rawReport(f.a,f.task,{kind:'inference',claimText:f.draft.content}));assert.equal(result.passed,true);
 const raw=rawReport(f.a,f.task,{kind:'inference',claimText:f.draft.content});raw.groundingReview.claims[0].citations=[];assert.equal(finish(f,raw).passed,false);
});

test('format-only or creative task can pass without manufacturing factual citations',t=>{
 const f=setup(t,{content:'你好，春天！',description:'写一句问候语。',criteria:'只输出一句话。'}),raw=rawReport(f.a,f.task,{claim:false});
 assert.equal(finish(f,raw).passed,true);
 raw.groundingReview.unsupportedClaims=['发现一个没有依据的事实'];assert.equal(finish(f,raw).passed,false);
});

test('all requirements must be checked once and references must resolve to actual claims',t=>{
 const f=setup(t);
 for(const mutate of [r=>r.requirements.pop(),r=>r.requirements.push({...r.requirements[0]}),r=>r.requirements[0].claimIds=['absent'],r=>r.requirements[0].status='gap',r=>r.claims[0].supported=false,r=>r.conflicts.push('原文存在不同日期')]){
  const raw=rawReport(f.a,f.task);mutate(raw.groundingReview);assert.equal(finish(f,raw).passed,false);
 }
});

test('cached review survives restart and invalidates on requirements, source or draft change',t=>{
 const f=setup(t);f.task.grounding=finish(f).grounding;
 f.task.verification={passed:true,summary:'已独立检查',gaps:[],basis:require('../desktop/acceptance.cjs').basis(f.a,f.task)};f.a.save();
 assert.doesNotThrow(()=>grounding.assertDelivery(f.a,f.task));
 const restored=new Assistant({dir:f.a.dir}),task=restored.task(f.task.id);assert.ok(grounding.reusable(restored,task));
 const original={criteria:task.criteria,content:restored.data.sources[0].content,draft:restored.data.artifacts[0].content};
 task.criteria+='新增要求';assert.equal(grounding.reusable(restored,task),null);task.criteria=original.criteria;
 restored.data.sources[0].content+='来源发生变化';assert.equal(grounding.reusable(restored,task),null);restored.data.sources[0].content=original.content;
 restored.data.artifacts[0].content+='文稿发生变化';assert.equal(grounding.reusable(restored,task),null);restored.data.artifacts[0].content=original.draft;
 assert.ok(grounding.reusable(restored,task));task.grounding.claims[0].reason='篡改记录';assert.equal(grounding.reusable(restored,task),null);
});

test('permission withdrawal and source replacement prevent cache reuse and delivery',t=>{
 const f=setup(t);f.task.grounding=finish(f).grounding;
 f.source.deleted=true;assert.equal(grounding.reusable(f.a,f.task),null);assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});
 f.source.deleted=false;
 f.a.addSources([{title:'新版会议',content:'会议确认改到周六发布。'}]);const replacement=f.a.data.sources.find(s=>s.id!==f.source.id);replacement.previousSourceId=f.source.id;
 f.task.sourceIds.push(replacement.id);assert.equal(grounding.reusable(f.a,f.task),null);
});

test('only content phase can defer a real unfinished external step; result phase rechecks it',t=>{
 const f=setup(t);const external={id:'deliver-step',title:'发送最终文稿',kind:'external',done:false};f.task.steps.push(external);
 const raw=rawReport(f.a,f.task,{status:'deferred',deferredStepId:external.id});
 const content=finish(f,raw,{phase:'content'});assert.equal(content.passed,true);
 f.task.grounding=content.grounding;
 assert.equal(grounding.context(f.a,f.task,{verificationPhase:'result'},'verify').groundingReviewRequest.reused,false);
 assert.equal(finish(f,{passed:true,summary:'已发送',gaps:[]},{phase:'result'}).passed,false);
 delete f.task.grounding;raw.groundingReview.requirements[0].deferredStepId='not-a-real-step';assert.equal(finish(f,raw,{phase:'content'}).passed,false);
});

test('successful cache reuse sends compact counts without repeating quotes or old reasoning',t=>{
 const f=setup(t);const full=grounding.context(f.a,f.task,{},'verify');f.task.grounding=finish(f).grounding;
 const cached=grounding.context(f.a,f.task,{},'verify');assert.equal(cached.groundingReviewRequest.reused,true);
 assert.equal(JSON.stringify(cached).includes(inputText),false);assert.ok(JSON.stringify(cached).length<JSON.stringify(full).length);
 const reused=finish(f,{passed:true,summary:'本次交付回执已确认',gaps:[]},{seen:new Set()});assert.equal(reused.passed,true);assert.equal(reused.grounding.reused,true);
});

test('disabled strict mode preserves existing workflow response and does not create a cache',t=>{
 const f=setup(t);f.a.data.settings.evidenceGrounding=false;const response={passed:true,summary:'旧检查',gaps:[]};
 assert.equal(grounding.finish(f.a,f.task,response),response);assert.equal(grounding.context(f.a,f.task,response,'verify'),response);assert.doesNotThrow(()=>grounding.assertDelivery(f.a,f.task));
});

test('enabling strict review requeues only unaccepted review tasks without changing drafts, steps or calling a model',async t=>{
 let calls=0;const f=setup(t,{chat:async()=>{calls++;throw Error('Enabling a policy must not call a model');}});
 f.a.data.settings.evidenceGrounding=false;f.task.status='review';
 f.task.verification={passed:true,summary:'旧版检查通过',gaps:[]};f.task.contentVerification={passed:true,summary:'旧版正文检查通过',gaps:[]};
 const completed=f.a.createTask({title:'已验收的历史事项',description:'保持历史验收',criteria:'已有用户确认',steps:[{title:'已完成步骤',kind:'draft'}]});
 completed.status='completed';completed.acceptedAt='2026-10-22T02:00:00.000Z';completed.acceptedBy='user';completed.steps[0].done=true;
 const before={content:f.draft.content,steps:structuredClone(f.task.steps),completed:structuredClone(completed)};f.a.save();
 await f.a.dispatch('settings',{evidenceGrounding:true});
 assert.equal(f.task.status,'todo');assert.equal(f.task.contentVerification,undefined);assert.equal(f.draft.content,before.content);assert.deepEqual(f.task.steps,before.steps);
 assert.equal(completed.status,'completed');assert.equal(completed.acceptedAt,before.completed.acceptedAt);assert.equal(completed.acceptedBy,'user');assert.deepEqual(completed.steps,before.completed.steps);
 assert.equal(calls,0);assert.ok(f.a.data.events.some(e=>e.title==='等待独立证据核验'));
 const restored=new Assistant({dir:f.a.dir});assert.equal(restored.data.settings.evidenceGrounding,true);assert.equal(restored.task(f.task.id).status,'todo');assert.equal(restored.task(completed.id).status,'completed');
});

test('overlong requirement inventories are rejected before generation without truncating or changing the saved draft',t=>{
 const f=setup(t),original=f.draft.content;
 f.task.criteria=Array.from({length:81},(_,i)=>'独立要求 '+i).join('\n');
 assert.throws(()=>grounding.context(f.a,f.task,{},'execute'),{code:'GROUNDING_REQUIREMENTS_TOO_LARGE',automaticRetry:false});
 assert.ok(grounding.requirements(f.a,f.task).length>80,'requirements remain complete rather than being silently sliced');
 f.task.criteria='只需要一个正常要求';f.task.notes=Array.from({length:14},(_,i)=>({kind:'feedback',text:'第 '+i+' 条完整补充要求：'+'长'.repeat(1800)}));
 assert.ok(grounding.requirements(f.a,f.task).length<80);assert.ok(JSON.stringify(grounding.requirements(f.a,f.task)).length>24000);
 assert.throws(()=>grounding.context(f.a,f.task,{},'verify'),{code:'GROUNDING_REQUIREMENTS_TOO_LARGE',automaticRetry:false});
 assert.equal(f.draft.content,original);assert.equal(f.task.notes.length,14);
});

test('identical text in generated draft cannot masquerade as an observed original source',t=>{
 const f=setup(t,{content:inputText}),seen=new Set();grounding.observe(seen,{artifacts:[f.draft]});
 const result=finish(f,rawReport(f.a,f.task,{claimText:inputText}),{seen});assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/尚未提供/);
});

test('observed quote from a different source version is not accepted as current evidence',t=>{
 const f=setup(t),seen=new Set();grounding.observe(seen,{artifacts:[f.draft],contextReads:[{result:{ok:true,sourceId:f.source.id,version:'obsolete-version',content:inputText}}]});
 assert.equal(finish(f,undefined,{seen}).passed,false);
});

test('model-produced requirement or description cannot be used as an original factual source',t=>{
 const f=setup(t,{description:inputText});
 const raw=rawReport(f.a,f.task,{sourceId:'user:description'}),seen=seenFor(f);seen.add(inputText);
 assert.equal(finish(f,raw,{seen}).passed,false);
 raw.groundingReview.claims[0].citations[0].sourceId=grounding.requirements(f.a,f.task)[0].id;
 assert.equal(finish(f,raw,{seen}).passed,false);
});

test('only a captured user edit may supply user-stated facts and it invalidates after an untrusted rewrite',async t=>{
 const f=setup(t,{description:inputText});await f.a.dispatch('updateTask',{id:f.task.id,description:inputText});
 const s=grounding.snapshot(f.a,f.task),seen=seenFor(f);grounding.observe(seen,grounding.context(f.a,f.task,{},'verify'));
 assert.equal(s.userInputs.some(r=>r.id==='user:description'),true);
 const raw=rawReport(f.a,f.task,{sourceId:'user:description'});assert.equal(finish(f,raw,{seen}).passed,true);
 f.task.description='未经用户确认的模型改写';assert.equal(finish(f,raw,{seen}).passed,false);
});

test('positive quote checks cannot authorize delivery after the independent overall verdict fails',t=>{
 const f=setup(t),raw=rawReport(f.a,f.task);raw.passed=false;raw.gaps=['未满足格式要求'];
 const result=finish(f,raw);assert.equal(result.grounding.passed,false);f.task.grounding=result.grounding;
 f.task.verification={passed:false,summary:'格式不符',gaps:raw.gaps,basis:require('../desktop/acceptance.cjs').basis(f.a,f.task)};
 assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});
});

test('delivery payload must be byte-identical to an independently checked current artifact',t=>{
 const f=setup(t);f.task.grounding=finish(f).grounding;f.task.verification={passed:true,summary:'已核验',gaps:[],basis:require('../desktop/acceptance.cjs').basis(f.a,f.task)};
 assert.doesNotThrow(()=>grounding.assertPayload(f.a,f.task,draftText,f.draft.id));
 assert.throws(()=>grounding.assertPayload(f.a,f.task,draftText+'未经核验的新结论',f.draft.id),{code:'GROUNDING_REQUIRED'});
});

test('source observation binds a repeated quote to the actual character range, not any equal occurrence',t=>{
 const repeated='周五发布，仅限内测用户。',body='第一次会议：'+repeated+'\n第二次会议：'+repeated;
 const f=setup(t,{source:body,content:repeated}),version=grounding.snapshot(f.a,f.task).sources[0].version;
 const first=body.indexOf(repeated),second=body.indexOf(repeated,first+1),seen=new Set();
 grounding.observe(seen,{artifacts:[f.draft],contextReads:[{result:{ok:true,sourceId:f.source.id,version,segments:[{text:repeated,sourceStart:first}]}}]});
 const raw=rawReport(f.a,f.task,{claimText:repeated,quote:repeated});raw.groundingReview.claims[0].citations[0].start=second;
 assert.equal(finish(f,raw,{seen}).passed,false,'seeing the first occurrence cannot prove the second one was read');
 raw.groundingReview.claims[0].citations[0].start=first;assert.equal(finish(f,raw,{seen}).passed,true);
});

test('original citation spanning paginated reads is accepted only when actual ranges cover all its characters',t=>{
 const f=setup(t),version=grounding.snapshot(f.a,f.task).sources[0].version,split=9,seen=new Set();
 const read=(start,content)=>({result:{ok:true,sourceId:f.source.id,version,content,start,canonical:{origin:0}}});
 grounding.observe(seen,{artifacts:[f.draft],contextReads:[read(0,inputText.slice(0,split))]});
 assert.equal(finish(f,undefined,{seen}).passed,false);
 grounding.observe(seen,{contextReads:[read(split,inputText.slice(split))]});assert.equal(finish(f,undefined,{seen}).passed,true);
 const withGap=new Set();grounding.observe(withGap,{artifacts:[f.draft],contextReads:[read(0,inputText.slice(0,split)),read(split+1,inputText.slice(split+1))]});
 assert.equal(finish(f,undefined,{seen:withGap}).passed,false,'a one-character unread gap cannot be silently filled');
});

test('real GitHub comment preparation blocks missing review and different unreviewed comment body',async t=>{
 const f=publicationFixture(t),writes=require('../desktop/agent-writes.cjs'),args={taskId:f.task.id,number:7,body:draftText};
 await assert.rejects(writes.prepare(f.a,f.job,'github_comment',args),{code:'GROUNDING_REQUIRED'});
 markContentChecked(f);
 await assert.rejects(writes.prepare(f.a,f.job,'github_comment',{...args,body:'改为所有用户正式发布。'}),{code:'GROUNDING_REQUIRED'});
 const record=await writes.prepare(f.a,f.job,'github_comment',args);assert.equal(record.status,'pending');assert.equal(record.content,draftText);
 assert.equal(f.calls.github,0);assert.equal(f.calls.mail,0);
});

test('real GitHub comment execution rechecks review and stops a tampered pending payload before transport',async t=>{
 const f=publicationFixture(t),writes=require('../desktop/agent-writes.cjs');markContentChecked(f);
 const record=await writes.prepare(f.a,f.job,'github_comment',{taskId:f.task.id,number:7,body:draftText});
 const saved=f.task.grounding;delete f.task.grounding;
 await assert.rejects(writes.execute(f.a,f.job,record),{code:'GROUNDING_REQUIRED'});
 f.task.grounding=saved;record.content='未经核验的外发正文';
 await assert.rejects(writes.execute(f.a,f.job,record),{code:'GROUNDING_REQUIRED'});
 assert.equal(record.status,'pending');assert.equal(f.calls.github,0);
});

test('old pending comment cannot publish its older body even after the new current draft passes verification',async t=>{
 const f=publicationFixture(t),writes=require('../desktop/agent-writes.cjs');markContentChecked(f);
 const record=await writes.prepare(f.a,f.job,'github_comment',{taskId:f.task.id,number:7,body:draftText});
 f.draft.content+='\n建议分批发布。';delete f.task.grounding;markContentChecked(f);
 assert.equal(record.version,writes.version(f.task),'the payload guard must protect a change not detected by task-only action version');
 await assert.rejects(writes.execute(f.a,f.job,record),{code:'GROUNDING_REQUIRED'});assert.equal(f.calls.github,0);
});

test('real Outlook preparation rejects unreviewed mail bodies and mail without a current artifact',async t=>{
 const f=publicationFixture(t),local=require('../desktop/agent-local.cjs');f.task.steps.push({id:'mail-step',title:'发送核验正文',kind:'external',tool:'send_mail',done:false});
 const args={taskId:f.task.id,connectorId:'grounding-mail',to:'fixture@example.com',subject:'核验正文',body:draftText};
 await assert.rejects(local.prepare(f.a,f.job,'send_mail',args),{code:'GROUNDING_REQUIRED'});
 markContentChecked(f);await assert.rejects(local.prepare(f.a,f.job,'send_mail',{...args,body:'任意未核验内容'}),{code:'GROUNDING_REQUIRED'});
 const record=await local.prepare(f.a,f.job,'send_mail',args);assert.equal(record.status,'pending');
 f.a.data.artifacts=[];f.task.steps[0].done=false;f.task.primaryArtifactId=null;
 await assert.rejects(local.prepare(f.a,f.job,'send_mail',args),{code:'GROUNDING_REQUIRED'});assert.equal(f.calls.mail,0);
});

test('real Outlook execution rejects changed reviewed body before external submit',async t=>{
 const f=publicationFixture(t),local=require('../desktop/agent-local.cjs');f.task.steps.push({id:'mail-step',title:'发送核验正文',kind:'external',tool:'send_mail',done:false});markContentChecked(f);
 const record=await local.prepare(f.a,f.job,'send_mail',{taskId:f.task.id,connectorId:'grounding-mail',to:'fixture@example.com',subject:'核验正文',body:draftText});
 record.approvedAt=new Date().toISOString();record.args.body='未通过独立核验的新正文';record.content=JSON.stringify(record.args,null,2);
 await assert.rejects(local.execute(f.a,f.job,record),{code:'GROUNDING_REQUIRED'});assert.equal(f.calls.mail,0);assert.equal(record.status,'pending');
});

test('integration: one generation plus existing verifier read loop grounds, saves and accepts after restart',async t=>{
 const calls=[];let f,reads=0;
 f=setup(t,{artifact:false,chat:async(_provider,_key,messages)=>{
  const c=JSON.parse(messages[1].content);calls.push({system:messages[0].content,payload:c});
  if(!c.groundingReviewRequest)return {kind:'artifact',title:'发布摘要',content:draftText,summary:'已生成摘要'};
  if(!reads++)return {kind:'read_context',requests:[{tool:'read_source',sourceId:f.source.id}]};
  return rawReport(f.a,f.task);
 }});
 await f.a.dispatch('saveProvider',{name:'本地协议测试模型',model:'mock',baseUrl:'http://127.0.0.1:1/v1',inputPrice:0,outputPrice:0,key:'mock-test-key'});
 await f.a.dispatch('advance',{id:f.task.id});await f.a.runPromise;
 assert.equal(f.task.status,'review',f.task.lastError);assert.equal(f.task.grounding.passed,true);assert.equal(calls.length,3,'strict review reuses existing verifier instead of a fourth model call');
 assert.ok(calls[0].payload.groundingChecklist);assert.ok(calls[1].system.includes('groundingReview'));
 assert.equal(calls[1].payload.groundingReviewRequest.reused,false);assert.equal(f.a.data.artifacts.length,1);
 const restored=new Assistant({dir:f.a.dir});await restored.dispatch('taskAction',{id:f.task.id,command:'accept'});assert.equal(restored.task(f.task.id).status,'completed');
});

test('integration: ungrounded positive model verdict keeps the real draft blocked and cannot be accepted',async t=>{
 const f=setup(t,{artifact:false,chat:async(_p,_k,m)=>JSON.parse(m[1].content).groundingReviewRequest?{passed:true,summary:'全部满足',gaps:[]}:{kind:'artifact',title:'发布摘要',content:draftText}});
 await f.a.dispatch('saveProvider',{name:'本地协议测试模型',model:'mock',baseUrl:'http://127.0.0.1:1/v1',inputPrice:0,outputPrice:0,key:'mock-test-key'});
 await f.a.dispatch('advance',{id:f.task.id});await f.a.runPromise;
 assert.equal(f.task.status,'blocked');assert.equal(f.a.data.artifacts.length,1);assert.equal(f.task.grounding.passed,false);
 await assert.rejects(f.a.dispatch('taskAction',{id:f.task.id,command:'accept'}),/检查|核验|验收/);
});
