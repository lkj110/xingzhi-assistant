'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const grounding=require('../desktop/grounding.cjs');
const fixtures=require('./fixtures/foundation-notification-replies.json').fixtures;

async function setup(t,fixture=fixtures[0]){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-notification-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const a=new Assistant({dir,chat:async()=>{throw Error('Offline regression must never call a model');}});
 a.data.settings.evidenceGrounding=true;a.addSources(fixture.input.sources);
 const source=a.data.sources[0],task=a.createTask({...fixture.input,sourceIds:[source.id],generationMode:'single',steps:[{title:'起草通知',kind:'draft'}]});
 // The trusted UI command captures the request. createTask itself can also be
 // called by planning code, so mere presence in task.description is not enough.
 await a.dispatch('updateTask',{id:task.id,description:fixture.input.description});
 const step=task.steps[0],draft={id:'notification-draft',taskId:task.id,stepId:step.id,...fixture.draft,createdAt:new Date().toISOString()};
 a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});
 step.done=true;step.artifactId=draft.id;require('../desktop/deliverables.cjs').record(a,task,step,draft,{});a.save();
 const response=structuredClone(fixture.response),g=response.groundingReview;
 // Only runtime UUIDs are rebound. Preserve all original claims, requirements,
 // verdicts, quoted text and any extra response fields from the complete reply.
 g.scannedArtifactIds=g.scannedArtifactIds.map(()=>draft.id);
 for(const c of g.claims)c.artifactId=draft.id;
 for(const c of g.citations)c.sourceId=source.id;
 const snapshot=grounding.snapshot(a,task),seen=new Set();
 assert.deepEqual(g.requirements.map(r=>r.id),snapshot.requirements.map(r=>r.id),'sealed requirement identities remain unchanged');
 grounding.observe(seen,{artifacts:[draft],contextReads:[{result:{sourceId:source.id,version:snapshot.sources[0].version,content:source.content}}]});
 grounding.observe(seen,grounding.context(a,task,{},'verify'));
 return {a,task,draft,source,response,seen,claim:g.claims.find(c=>c.id==='c2')};
}
const finish=f=>grounding.finish(f.a,f.task,f.response,{seen:f.seen});
function rewriteClaim(f,text){f.draft.content=f.draft.content.replace(f.claim.text,text);f.claim.text=text;f.seen.add(f.draft.content);}

for(const fixture of fixtures)test('complete real verifier reply accepts evidenced notification tone: '+fixture.caseId,async t=>{
 const f=await setup(t,fixture),before=f.draft.content,result=finish(f);
 assert.equal(result.passed,true,result.gaps.join('\n'));
 assert.equal(result.grounding.claims.length,fixture.response.groundingReview.claims.length);
 assert.equal(f.draft.content,before,'verification never edits the business text');
 const claim=result.grounding.claims.find(c=>c.id==='c2');
 assert.equal(claim.kind,'proposal');assert.ok(claim.citations.length);
 for(const citation of claim.citations){assert.equal(citation.sourceId,f.source.id);assert.equal(f.source.content.slice(citation.start,citation.end),citation.quote);assert.ok(citation.version);}
});

test('notification exception requires a captured current user request, not a generated description or title',async t=>{
 const f=await setup(t);f.task.groundingUserInputs=[];
 assert.equal(finish(f).passed,false);
 f.task.groundingUserInputs=[{field:'description',text:f.task.description,origin:'model'}];
 assert.equal(finish(f).passed,false);
 f.task.groundingUserInputs=[{field:'description',text:f.task.description+'曾由用户确认',origin:'user'}];
 assert.equal(finish(f).passed,false,'stale user input does not authorize a model rewrite');
});

test('notification request must be linked to this proposal by a satisfied requirement',async t=>{
 const f=await setup(t);
 for(const r of f.response.groundingReview.requirements){r.claimIds=r.claimIds.filter(id=>id!==f.claim.id);if(!r.claimIds.length)r.reason='该项不关联通知祈使句';}
 const result=finish(f);assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/未在正文标明/);
});

for(const kind of ['unknown','inference'])test('please does not label '+kind,async t=>{
 const f=await setup(t);f.claim.kind=kind;
 assert.equal(finish(f).passed,false);
});

test('notification tone still requires independent support and overall approval',async t=>{
 const f=await setup(t);f.claim.supported=false;f.claim.reason='收件范围不受当前要求和原文支持';
 assert.equal(finish(f).passed,false);
 f.claim.supported=true;f.response.passed=false;f.response.gaps=['通知扩大了用户授权范围'];
 assert.equal(finish(f).passed,false);
});

test('unsupported approval directive cannot gain authorization merely by beginning with please',async t=>{
 const f=await setup(t);rewriteClaim(f,'请批准本场面向所有公众开放。');
 f.claim.supported=false;f.claim.reason='当前来源仅允许已预约校内团体，没有批准公众开放';
 f.response.groundingReview.unsupportedClaims=['c2'];
 f.response.groundingReview.conflicts=['该指令与当前来源适用范围冲突'];
 const result=finish(f);assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/未获支持|冲突/);
});

for(const text of ['请团体联络员通知参加人员，活动已批准向公众开放。','请团体联络员通知参加人员。活动已批准向公众开放。','请团体联络员通知参加人员：活动已批准向公众开放。','请团体联络员通知参加人员；活动已批准向公众开放。'])test('a leading imperative cannot hide an appended declarative clause: '+text,async t=>{
 const f=await setup(t);rewriteClaim(f,text);
 // Deliberately keep the model's true verdict: local tone recognition must not
 // exempt this mixed assertion solely because its first character is 请.
 const result=finish(f);assert.equal(result.passed,false);assert.match(result.gaps.join('\n'),/未在正文标明/);
});

test('plain assertion cannot become a notification just by assigning proposal kind',async t=>{
 const f=await setup(t);rewriteClaim(f,'活动已批准向公众开放。');assert.equal(finish(f).passed,false);
});

test('notification tone cannot bypass missing, altered, unread or stale citation evidence',async t=>{
 const f=await setup(t),g=f.response.groundingReview,original=structuredClone(g.citations),ids=[...f.claim.citationIds],seen=f.seen;
 f.claim.citationIds=[];assert.equal(finish(f).passed,false);f.claim.citationIds=ids;
 g.citations[0].quote='从未存在的批准记录';assert.equal(finish(f).passed,false);g.citations=structuredClone(original);
 f.seen=new Set([f.draft.content]);assert.equal(finish(f).passed,false);
 grounding.observe(f.seen,{contextReads:[{result:{sourceId:f.source.id,version:'obsolete',content:f.source.content}}]});assert.equal(finish(f).passed,false);
 f.seen=seen;assert.equal(finish(f).passed,true);
});

test('notification evidence cannot cite an unrelated or self-authored resource',async t=>{
 const f=await setup(t),citation=f.response.groundingReview.citations[0],original=citation.sourceId;
 f.a.addSources([{title:'未分配的无关来源',content:'无关事项的独立记录：'+f.source.content}]);
 for(const id of ['missing',f.draft.id,f.a.data.sources.find(s=>s.id!==original).id]){citation.sourceId=id;assert.equal(finish(f).passed,false);}
});

test('notification tone does not clear unsupported claims, unresolved conflicts or requirement gaps',async t=>{
 const f=await setup(t),g=f.response.groundingReview;
 g.unsupportedClaims=['通知中的日期不受资料支持'];assert.equal(finish(f).passed,false);g.unsupportedClaims=[];
 g.conflicts=['同级资料对活动时段仍有未解决冲突'];assert.equal(finish(f).passed,false);g.conflicts=[];
 g.requirements[1].status='gap';g.requirements[1].reason='当前稿件扩大了适用范围';assert.equal(finish(f).passed,false);
});

test('verification prompt keeps notification factual operands and authorization within semantic review',()=>{
 assert.match(grounding.reviewInstruction,/通知中的“请…”/);
 assert.match(grounding.reviewInstruction,/conflicts为字符串数组/);
 assert.match(grounding.reviewInstruction,/核对对象、动作、时间和条件/);
 assert.match(grounding.reviewInstruction,/不据此放行新增安排或已完成\/已批准断言/);
});
