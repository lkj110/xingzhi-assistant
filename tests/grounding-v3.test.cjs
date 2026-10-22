'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const grounding=require('../desktop/grounding.cjs');
const quoteA='同级记录甲：明天使用橙色通道。两份记录同级、同时间，彼此没有版本替代关系。';
const quoteB='同级记录乙：明天使用紫色通道。两份记录同级、同时间，尚无冲突协调结果。';
const basis='同级原文分别指定橙色和紫色通道，尚无协调结果，现有资料不能确定唯一通道。';

function fixture(t,{singleSource=false,content=JSON.stringify({answer:'无法确定',certainty:'unknown',basis}),description='根据原始记录判断明天应采用哪个通道；无法确定时允许如实未知。',criteria='依据不足时如实说明未知，简述实际依据与分歧。'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-grounding-v3-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const a=new Assistant({dir});a.data.settings.evidenceGrounding=true;
 a.addSources(singleSource?[{title:'同级记录汇编',content:quoteA+'\n'+quoteB}]:[{title:'同级记录甲',content:quoteA},{title:'同级记录乙',content:quoteB}]);
 const sources=singleSource?[a.data.sources[0]]:[a.data.sources.find(s=>s.content===quoteA),a.data.sources.find(s=>s.content===quoteB)];
 const task=a.createTask({title:'当前通道结论',description,criteria,sourceIds:sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成结论',kind:'draft'}]});
 const step=task.steps[0],draft={id:'v3-current-draft',taskId:task.id,stepId:step.id,title:'当前通道结论',content,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});step.done=true;step.artifactId=draft.id;
 require('../desktop/deliverables.cjs').record(a,task,step,draft,{});a.save();
 return {a,task,draft,sources};
}
function report(f){
 const s=grounding.snapshot(f.a,f.task),last=f.sources[f.sources.length-1];
 return {passed:true,summary:'逐项核对后，稿件按要求保留未知并披露来源分歧。',gaps:[],groundingReview:{consistencyIssues:[],
  format:'compact-v4',scannedArtifactIds:[f.draft.id],
  citations:[{id:'e1',sourceId:f.sources[0].id,quote:quoteA,start:0},{id:'e2',sourceId:last.id,quote:quoteB,start:last.content.indexOf(quoteB)}],
  requirements:s.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:['u1','f1']})),
  claims:[{id:'u1',artifactId:f.draft.id,text:'无法确定',kind:'unknown',supported:true,citationIds:['e1','e2']},
   {id:'f1',artifactId:f.draft.id,text:basis,kind:'fact',supported:true,citationIds:['e1','e2']}],
  unsupportedClaims:[],conflicts:[],sourceConflicts:[{claimIds:['u1'],requirementIds:s.requirements.map(r=>r.id),citationIds:['e1','e2'],disposition:'disclosed_unknown',reason:'当前要求允许证据不足时未知，正文明确无法确定并说明同级分歧，未无依据选边。'}]
 }};
}
function observed(f,{omit=[],versions={}}={}){
 const s=grounding.snapshot(f.a,f.task),seen=new Set();
 grounding.observe(seen,{artifacts:[f.draft],contextReads:s.sources.filter(source=>!omit.includes(source.id)).map(source=>({result:{sourceId:source.id,version:versions[source.id]||source.version,content:f.sources.find(v=>v.id===source.id).content}}))});
 return seen;
}
const finish=(f,r=report(f),seen=observed(f))=>grounding.finish(f.a,f.task,r,{seen});

test('compact review accepts disclosed source conflict and expands shared evidence for persisted UI and delivery',t=>{
 const f=fixture(t),r=finish(f);assert.equal(r.passed,true,r.gaps.join('\n'));
 assert.equal(r.groundingReview,undefined);
 assert.equal(r.grounding.claims.length,2);
 const first=r.grounding.claims[0].citations;
 assert.deepEqual(first.map(c=>c.quote),[quoteA,quoteB]);
 assert.deepEqual(r.grounding.claims[1].citations,first,'shared transport refs expand to the same evidence records for the existing UI');
 for(const c of first){assert.ok(c.title);assert.ok(c.version);assert.equal(c.start,0);assert.equal(c.end,c.quote.length);}
 assert.ok(r.grounding.requirements.every(item=>item.reason&&item.status==='satisfied'));
 assert.ok(r.grounding.claims.every(item=>item.reason));
 f.task.grounding=r.grounding;f.task.verification={passed:true,summary:'通过',gaps:[],basis:require('../desktop/acceptance.cjs').basis(f.a,f.task),at:new Date().toISOString()};f.a.save();
 const restored=new Assistant({dir:f.a.dir}),task=restored.task(f.task.id);
 assert.ok(grounding.reusable(restored,task));assert.doesNotThrow(()=>grounding.assertDelivery(restored,task));
 assert.deepEqual(task.grounding.claims[0].citations,first);
});

test('two conflicting excerpts from one original document can support an explicit unknown',t=>{
 const f=fixture(t,{singleSource:true}),r=finish(f);assert.equal(r.passed,true,r.gaps.join('\n'));
 assert.equal(r.grounding.claims[0].citations[1].start,quoteA.length+1);
});

test('legacy conflicts remain delivery blockers even when a valid informational source conflict exists',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.conflicts=['稿件仍遗漏一项必须交付的确定结论'];
 assert.equal(finish(f,r).passed,false);
});

test('source conflict cannot turn an unsupported fact choosing one side into a permitted unknown',t=>{
 const f=fixture(t,{content:'橙色通道'}),r=report(f);r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:'橙色通道',kind:'fact',supported:true,citationIds:['e1','e2']}];
 assert.equal(finish(f,r).passed,false);
});

test('unlabelled assertion cannot bypass the conflict guard by changing only its claimed kind to unknown',t=>{
 const f=fixture(t,{content:'橙色通道'}),r=report(f);r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:'橙色通道',kind:'unknown',supported:true,citationIds:['e1','e2']}];
 assert.equal(finish(f,r).passed,false);
});

for(const content of ['建议使用橙色通道','可能使用橙色通道'])test('source conflict requires explicit unknown rather than a mislabelled suggestion or inference: '+content,t=>{
 const f=fixture(t,{content}),r=report(f);r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:content,kind:'unknown',supported:true,citationIds:['e1','e2']}];
 for(const requirement of r.groundingReview.requirements)requirement.claimIds=['u1'];
 assert.equal(finish(f,r).passed,false,'suggestion/inference markers alone do not disclose inability to determine the answer');
});

for(const content of ['无法判断','不能确定','无法得知','未能确认']){
 test('ordinary explicit unknown wording is accepted: '+content,t=>{
  const f=fixture(t,{content}),r=report(f);r.groundingReview.sourceConflicts=[];
  r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:content,kind:'unknown',supported:true,citationIds:['e1','e2']}];
  for(const requirement of r.groundingReview.requirements)requirement.claimIds=['u1'];
  const result=finish(f,r);assert.equal(result.passed,true,result.gaps.join('\n'));
 });
 test('source conflict accepts explicit unknown wording: '+content,t=>{
  const f=fixture(t,{content}),r=report(f);r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:content,kind:'unknown',supported:true,citationIds:['e1','e2']}];
  for(const requirement of r.groundingReview.requirements)requirement.claimIds=['u1'];
  const result=finish(f,r);assert.equal(result.passed,true,result.gaps.join('\n'));
 });
}

for(const content of ['未','本周未使用橙色通道。'])test('plain negative wording does not become an unknown marker: '+content,t=>{
 const f=fixture(t,{content}),r=report(f);r.groundingReview.claims=[{id:'u1',artifactId:f.draft.id,text:content,kind:'unknown',supported:true,citationIds:['e1','e2']}];
 for(const requirement of r.groundingReview.requirements)requirement.claimIds=['u1'];
 assert.equal(finish(f,r).passed,false);
 r.groundingReview.sourceConflicts=[];assert.equal(finish(f,r).passed,false);
});

test('conflict with unresolved disposition cannot be classified as disclosed unknown',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.sourceConflicts[0].disposition='unresolved';assert.equal(finish(f,r).passed,false);
});

test('a requirement demanding a determined answer still blocks a correct-but-insufficient unknown',t=>{
 const f=fixture(t,{criteria:'必须给出唯一确定通道，无法确定不满足当前交付要求。'}),r=report(f);
 const requirement=r.groundingReview.requirements.find(v=>grounding.requirements(f.a,f.task).find(q=>q.id===v.id)?.kind==='criteria');
 requirement.status='gap';requirement.reason='要求必须确定，当前同级分歧尚未协调，未知不能满足此项。';
 assert.equal(finish(f,r).passed,false);
});

test('source-conflict disclosure cannot override an independent failed overall verdict',t=>{
 const f=fixture(t),r=report(f);r.passed=false;r.gaps=['用户要求先收到协调结果，当前交付未满足。'];
 assert.equal(finish(f,r).passed,false);
});

test('informational conflict must name a real current unknown claim and a linked current requirement',t=>{
 const f=fixture(t);
 for(const mutate of [r=>r.claimIds=['missing'],r=>r.requirementIds=['missing'],r=>r.requirementIds=[],r=>r.claimIds=[]]){
  const r=report(f);mutate(r.groundingReview.sourceConflicts[0]);assert.equal(finish(f,r).passed,false);
 }
 const r=report(f);for(const requirement of r.groundingReview.requirements)requirement.claimIds=['f1'];assert.equal(finish(f,r).passed,false);
});

function titleAndAnswerReport(f){
 f.task.title='未知：同级通道记录分歧未协调';
 const r=report(f),g=r.groundingReview;assert.equal(g.requirements.length,3);
 g.claims.push({id:'uTitle',artifactId:f.draft.id,text:f.task.title,kind:'unknown',supported:true,citationIds:['e1','e2']});
 g.requirements[0].claimIds=['uTitle'];g.requirements[1].claimIds=['u1'];g.requirements[2].claimIds=['u1','f1'];
 g.sourceConflicts[0].claimIds=['u1','uTitle'];g.sourceConflicts[0].requirementIds=g.requirements.slice(1).map(v=>v.id);
 return r;
}

test('source-conflict permission requirements may differ from a separately covered unknown delivery title',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f);
 const result=finish(f,r);assert.equal(result.passed,true,result.gaps.join('\n'));
});

test('a separately verified supplemental unknown title need not be reverse-linked to a requirement',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f);
 r.groundingReview.requirements[0].claimIds=['f1'];
 const result=finish(f,r);assert.equal(result.passed,true,result.gaps.join('\n'));
});

test('supplemental unknown title still must be exact current title or artifact text',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f);
 r.groundingReview.requirements[0].claimIds=['f1'];r.groundingReview.claims.find(c=>c.id==='uTitle').text='无法确定：未在当前标题或正文出现的补充结论';
 assert.equal(finish(f,r).passed,false);
});

test('supplemental unknown title still needs both source-conflict excerpts',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f);
 r.groundingReview.requirements[0].claimIds=['f1'];r.groundingReview.claims.find(c=>c.id==='uTitle').citationIds=['e1'];
 assert.equal(finish(f,r).passed,false);
});

test('supplemental title cannot cite an invalid shared excerpt while core unknown evidence remains valid',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f);
 r.groundingReview.requirements[0].claimIds=['f1'];
 r.groundingReview.citations.push({id:'e3',sourceId:f.sources[0].id,quote:'这不是给定原文中的片段。',start:0});
 r.groundingReview.claims.find(c=>c.id==='uTitle').citationIds.push('e3');
 assert.equal(finish(f,r).passed,false);
});

test('supplemental title cannot use an unread original excerpt even when both core conflict excerpts were read',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),extra='附加原文：未知结论仍待协调确认。';
 f.sources[0].content+='\n'+extra;
 const r=titleAndAnswerReport(f),s=grounding.snapshot(f.a,f.task),seen=new Set();r.groundingReview.requirements[0].claimIds=['f1'];
 r.groundingReview.citations.push({id:'e3',sourceId:f.sources[0].id,quote:extra,start:quoteA.length+1});
 r.groundingReview.claims.find(c=>c.id==='uTitle').citationIds.push('e3');
 grounding.observe(seen,{artifacts:[f.draft],contextReads:f.sources.map((source,index)=>({result:{sourceId:source.id,version:s.sources.find(v=>v.id===source.id).version,content:index===0?quoteA:quoteB,start:0}}))});
 assert.equal(finish(f,r,seen).passed,false);
});

test('source-conflict permission set must link at least one of its actual unknown conclusions',t=>{
 const f=fixture(t,{description:'判断明天应使用哪个通道。\n同级记录冲突时允许如实未知。'}),r=titleAndAnswerReport(f),g=r.groundingReview;
 g.requirements[1].claimIds=['f1'];g.sourceConflicts[0].requirementIds=[g.requirements[1].id];
 assert.equal(finish(f,r).passed,false,'a requirement covering only factual basis cannot grant unknown-conflict permission');
});

test('source conflict needs both distinct original excerpts bound to its unknown claim',t=>{
 const f=fixture(t);
 for(const refs of [['e1'],['e1','e1']]){const r=report(f);r.groundingReview.sourceConflicts[0].citationIds=refs;assert.equal(finish(f,r).passed,false);}
 const r=report(f);r.groundingReview.claims[0].citationIds=['e1'];assert.equal(finish(f,r).passed,false);
 const repeated=report(f);repeated.groundingReview.citations[1]={...repeated.groundingReview.citations[0],id:'e2'};assert.equal(finish(f,repeated).passed,false,'two IDs do not turn one excerpt into conflicting evidence');
});

test('source-conflict classification requires a concrete explanation even when success reasons are omitted',t=>{
 const f=fixture(t),r=report(f);delete r.groundingReview.sourceConflicts[0].reason;assert.equal(finish(f,r).passed,false);
});

test('duplicate shared citation ids are rejected instead of shadowing one original with another',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.citations[1].id='e1';assert.equal(finish(f,r).passed,false);
});

test('missing shared citation reference cannot silently disappear from a factual claim',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.claims[1].citationIds.push('missing');assert.equal(finish(f,r).passed,false);
});

test('inline and shared citation forms cannot be mixed to hide contradictory or unvalidated evidence',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.claims[1].citations=[{sourceId:f.sources[0].id,quote:quoteA}];
 assert.equal(finish(f,r).passed,false);
});

test('shared citation still checks exact original character range',t=>{
 const f=fixture(t),r=report(f);r.groundingReview.citations[0].start=1;assert.equal(finish(f,r).passed,false);
});

test('shared citation still requires the named original to be actually supplied to this checker',t=>{
 const f=fixture(t),seen=observed(f,{omit:[f.sources[0].id]});assert.equal(finish(f,report(f),seen).passed,false);
});

test('an observed previous source version cannot validate current shared citations',t=>{
 const f=fixture(t),seen=observed(f,{versions:{[f.sources[0].id]:'previous-version'}});assert.equal(finish(f,report(f),seen).passed,false);
});

test('equal text in another source does not count as reading the referenced original',t=>{
 const f=fixture(t);f.sources[1].content=quoteA;
 const s=grounding.snapshot(f.a,f.task),seen=new Set();
 grounding.observe(seen,{artifacts:[f.draft],contextReads:[{result:{sourceId:f.sources[1].id,version:s.sources.find(v=>v.id===f.sources[1].id).version,content:quoteA}}]});
 const r=report(f);r.groundingReview.citations=[{id:'e1',sourceId:f.sources[0].id,quote:quoteA,start:0}];r.groundingReview.sourceConflicts=[];
 for(const claim of r.groundingReview.claims)claim.citationIds=['e1'];
 assert.equal(finish(f,r,seen).passed,false);
});

test('current permission revocation invalidates compact reports and cached delivery authority',t=>{
 const f=fixture(t),r=finish(f);assert.equal(r.passed,true,r.gaps.join('\n'));f.task.grounding=r.grounding;
 const seen=observed(f),check=f.a.contextAccessCheck;f.a.contextAccessCheck=args=>args.objectType==='source'&&args.objectId===f.sources[0].id?{allowed:false,decision:'deny',revision:2}:check(args);
 assert.equal(grounding.reusable(f.a,f.task),null);assert.equal(finish(f,report(f),seen).passed,false);
 assert.throws(()=>grounding.assertDelivery(f.a,f.task),{code:'GROUNDING_REQUIRED'});
});

test('omitting success reasons does not allow missing requirements or unsupported claims',t=>{
 const f=fixture(t);
 const missing=report(f);missing.groundingReview.requirements.pop();assert.equal(finish(f,missing).passed,false);
 const unsupported=report(f);unsupported.groundingReview.claims[0].supported=false;unsupported.groundingReview.claims[0].reason='没有充分依据，当前结论未能成立。';assert.equal(finish(f,unsupported).passed,false);
 const gap=report(f);gap.groundingReview.requirements[0].status='gap';assert.equal(finish(f,gap).passed,false);
});

test('format-only requirement without claims still needs a specific reason in compact review',t=>{
 const f=fixture(t,{content:'你好。',description:'写一句简短中文问候。',criteria:'正文仅输出一句问候，不包含事实断言。'}),r=report(f);r.groundingReview.claims=[];r.groundingReview.sourceConflicts=[];r.groundingReview.citations=[];
 for(const requirement of r.groundingReview.requirements)requirement.claimIds=[];
 assert.equal(finish(f,r).passed,false);
 for(const requirement of r.groundingReview.requirements)requirement.reason='正文只包含一句中文问候，没有需绑定原文的关键事实。';
 assert.equal(finish(f,r).passed,true);
});

test('compact optimizations require an explicit supported format version',t=>{
 const f=fixture(t);
 for(const value of [undefined,'compact-v99']){const r=report(f);r.groundingReview.format=value;assert.equal(finish(f,r).passed,false);}
});

test('legacy inline review continues to require explicit success reasons',t=>{
 const f=fixture(t),r=report(f),g=r.groundingReview;
 for(const claim of g.claims){claim.citations=claim.citationIds.map(id=>{const {id:ignored,...citation}=g.citations.find(c=>c.id===id);return citation;});delete claim.citationIds;}
 delete g.format;delete g.citations;delete g.sourceConflicts;
 assert.equal(finish(f,r).passed,false,'unversioned reports cannot inherit relaxed compact reason rules');
 for(const claim of g.claims)claim.reason='同级原文直接支持该事实或明确未知。';
 for(const requirement of g.requirements)requirement.reason='正文满足当前要求，必要分歧已如实披露。';
 const result=finish(f,r);assert.equal(result.passed,true,result.gaps.join('\n'));
});

test('compact deferred requirement needs a concrete reason even during a valid content check',t=>{
 const f=fixture(t);f.task.steps.push({id:'v3-pending-external',title:'后续交付',kind:'external',done:false});
 const r=report(f);r.groundingReview.sourceConflicts=[];
 Object.assign(r.groundingReview.requirements[0],{status:'deferred',deferredStepId:'v3-pending-external'});
 const run=()=>grounding.finish(f.a,f.task,r,{seen:observed(f),phase:'content'});
 assert.equal(run().passed,false);
 r.groundingReview.requirements[0].reason='这项只涉及后续外部交付步骤，当前内容检查先核对已保存正文。';
 const result=run();assert.equal(result.passed,true,result.gaps.join('\n'));
});

test('runtime grounding status is read-only and identifies the loaded implementation independently of enablement',t=>{
 const f=fixture(t),before=JSON.stringify(f.a.data),status=grounding.status(f.a);
 assert.equal(status.enabled,true);assert.equal(status.version,grounding.VERSION);assert.equal(status.format,'compact-v4');
 assert.match(status.implementationHash,/^[a-f0-9]{64}$/);
 assert.equal(status.implementationHash,require('node:crypto').createHash('sha256').update(fs.readFileSync(require.resolve('../desktop/grounding.cjs'))).digest('hex'));
 assert.ok(status.features.includes('disclosed-source-conflicts'));assert.ok(status.features.includes('shared-citations'));
 assert.equal(JSON.stringify(f.a.data),before,'status cannot modify workspace state');
 status.features.push('caller-mutation');f.a.data.settings.evidenceGrounding=false;
 const disabled=grounding.status(f.a);assert.equal(disabled.enabled,false);assert.equal(disabled.implementationHash,status.implementationHash);
 assert.equal(disabled.features.includes('caller-mutation'),false);
});
