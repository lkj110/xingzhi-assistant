'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Assistant}=require('../desktop/core.cjs'),grounding=require('../desktop/grounding.cjs'),generation=require('../desktop/generation-context.cjs'),modelInput=require('../desktop/model-input.cjs');
const sourceText='仓库记录：蓝箱存放12件，绿箱存放18件。两箱分别登记，不合并统计。',draftText='蓝箱存放12件，按蓝箱单独登记的数量报告。';
async function fixture(t,{first,second,content=draftText,hook,sourceContent=sourceText}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-classification-'));t.after(()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const calls=[];let a,task,source,draft;
 const response=(kind='inference')=>({passed:true,summary:'独立核对当前要求、正文及来源。',gaps:[],groundingReview:{format:'compact-v5',scannedArtifactIds:[draft.id],citations:[{id:'e1',sourceId:source.id,quote:sourceContent}],requirements:grounding.requirements(a,task).map(r=>({id:r.id,status:'satisfied',claimIds:['c1']})),claims:[{id:'c1',artifactId:draft.id,text:content,kind,supported:true,citationIds:['e1']}],unsupportedClaims:[],conflicts:[],consistencyIssues:[]}});
 a=new Assistant({dir,chat:async(_p,_k,messages,options)=>{
  const payload=modelInput.materialize(JSON.parse(messages[1].content));calls.push({payload,system:messages[0].content,options});
  if(calls.length===1)return {kind:'read_context',requests:[{tool:'read_source',sourceId:source.id}]};
  const result=response(payload.groundingClassificationReview?'fact':'inference');
  hook?.({a,task,source,draft,calls,payload});
  return (payload.groundingClassificationReview?second:first)?.(result,{a,task,source,draft,calls,payload})||result;
 }});
 a.data.settings.evidenceGrounding=true;a.addSources([{title:'分箱登记',content:sourceContent}]);source=a.data.sources[0];
 task=a.createTask({title:'箱内件数查询',description:'根据原文报告蓝箱登记件数。',criteria:'数量和箱名准确，保留来源与范围。',sourceIds:[source.id],generationMode:'single',steps:[{title:'查询结果',kind:'draft'}]});
 draft={id:'classification-draft',taskId:task.id,stepId:task.steps[0].id,title:'蓝箱登记',content};a.data.artifacts.push(draft);require('../desktop/protocol-access.cjs').retain(a,'artifact',draft,{task});task.steps[0].done=true;task.steps[0].artifactId=draft.id;require('../desktop/deliverables.cjs').record(a,task,task.steps[0],draft,{});
 await a.dispatch('saveProvider',{name:'offline',baseUrl:'http://127.0.0.1:1/v1',model:'mock',key:'offline-only',inputPrice:0,outputPrice:0});a.save();
 return {a,task,source,draft,calls,dir,response,run:()=>generation.call(a,task,'独立核验当前稿件。',a.context(task,{verification:true}),'verify')};
}
test('one independent classification correction preserves complete target and source',async t=>{
 const f=await fixture(t);const result=await f.run();assert.equal(result.passed,true,result.summary);assert.equal(f.calls.length,3);
 const retry=f.calls[2].payload;assert.equal(retry.groundingClassificationReview.claims[0].text,draftText);assert.ok(f.calls[2].system.includes('不预设应该通过'));assert.ok(JSON.stringify(retry).includes(sourceText));
 assert.ok(f.calls.every(c=>c.options.responseContract===require('../desktop/verification-output.cjs').ID),'read loop and bounded classification carry the explicit strict contract');
 const record=Object.values(f.task.contextFinalizations)[0];assert.equal(record.reason,'grounding_classification');assert.equal(record.initialGrounding.passed,false);assert.equal(record.status,'returned');assert.ok(record.transport.requestId);
 await assert.rejects(f.run(),/有界结论/);assert.equal(f.calls.length,3);
 const restarted=new Assistant({dir:f.dir,chat:async()=>{throw Error('Unexpected transport after restart');}}),task=restarted.data.tasks.find(x=>x.id===f.task.id);
 await assert.rejects(generation.call(restarted,task,'独立核验。',restarted.context(task,{verification:true}),'verify'),/有界结论/);
});

test('direct entailment with all premises needs no literal inference marker or extra call',async t=>{
 const sourceContent='同一值守员必须在甲室09:00至09:30全程在场，并在乙室09:10至09:40全程在场。两室独立且不能同时覆盖。',content='上述时间要求存在重叠，同一值守员无法同时满足两室全程在场要求。';
 const f=await fixture(t,{sourceContent,content,first:r=>{r.groundingReview.claims[0].kind='fact';return r;}}),result=await f.run();
 assert.equal(result.passed,true,result.summary);assert.equal(f.calls.length,2);assert.equal(result.grounding.claims[0].citations[0].quote,sourceContent);
 assert.ok(f.calls[1].system.includes(require('../desktop/claim-semantics.cjs').instruction));
 f.task.grounding=result.grounding;assert.equal((await f.run()).passed,true);assert.equal(f.calls.at(-1).options.responseContract,undefined,'cached protocol stays legacy');
});
test('same-paragraph premise and applicable limit can bind inference without keyword matching',async t=>{
 const content='在两库库存记录均完整的条件下，现有数据支持蓝箱需要更少货位；尚无现场堆放尺寸，不能确定实际货位数。';
 const f=await fixture(t,{content,first:r=>{const c=r.groundingReview.claims[0];c.field='content';c.text='现有数据支持蓝箱需要更少货位';c.qualification={field:'content',quote:content};return r;}}),result=await f.run();
 assert.equal(result.passed,true,result.summary);assert.equal(f.calls.length,2);assert.equal(result.grounding.claims[0].qualification.quote,content);
});
test('model refusal over marker, hidden assumption or execution claim cannot be locally converted into pass',async t=>{
 for(const reason of ['已读前提支持结论，但没有额外写推断二字','两室是否由同一人负责未说明','排期不证明已经通知观众']){
  const f=await fixture(t,{first:r=>{r.passed=false;r.gaps=[reason];r.groundingReview.claims[0].supported=false;r.groundingReview.claims[0].reason=reason;return r;}}),result=await f.run();
  assert.equal(result.passed,false);assert.equal(f.calls.length,2);assert.ok(result.gaps.includes(reason));assert.equal(Object.keys(f.task.contextFinalizations||{}).length,0);
 }
});
test('nonstrict verification does not opt into compact report transport',async t=>{
 const f=await fixture(t);f.a.data.settings.evidenceGrounding=false;await f.run();assert.ok(f.calls.every(c=>c.options.responseContract===undefined));
});
test('genuine unmarked inference remains blocked after sole recheck',async t=>{
 const f=await fixture(t,{content:'蓝箱数量较少，因此运输过程更安全。',second:r=>{r.groundingReview.claims[0].kind='inference';return r;}});const result=await f.run();assert.equal(result.passed,false);assert.equal(f.calls.length,3);assert.ok(result.grounding.issues.some(x=>x.includes('未在正文标明')));
});
for(const mode of ['delete','shorten','artifact','read','retryFull'])test('recheck cannot evade target through '+mode,async t=>{
 const f=await fixture(t,{second:r=>{if(mode==='delete')r.groundingReview.claims=[];if(mode==='shorten')r.groundingReview.claims[0].text='蓝箱存放12件';if(mode==='artifact')r.groundingReview.claims[0].artifactId='foreign';if(mode==='read')return {kind:'read_context',requests:[]};if(mode==='retryFull')r.retryFull=true;return r;}});
 const result=await f.run();assert.equal(result.passed,false);assert.notEqual(result.retryFull,true);assert.equal(f.calls.length,3);assert.ok(result.gaps.some(x=>x.includes('分类复核未保留')));
});
for(const mode of ['quote','unsupported-spoof','conflict','overall-fail'])test('other defects cannot trigger classification retry: '+mode,async t=>{
 const f=await fixture(t,{first:r=>{if(mode==='quote')r.groundingReview.citations[0].quote='不存在的原文';if(mode==='unsupported-spoof')r.groundingReview.unsupportedClaims=['推断、建议或未知未在正文标明：c1'];if(mode==='conflict')r.groundingReview.conflicts=['范围矛盾'];if(['unknown','proposal'].includes(mode))r.groundingReview.claims[0].kind=mode;if(mode==='overall-fail')r.passed=false;return r;}});
 const result=await f.run();assert.equal(result.passed,false);assert.equal(f.calls.length,2);assert.equal(Object.keys(f.task.contextFinalizations||{}).length,0);
});
for(const kind of ['unknown','proposal'])test(kind+' scope can be bound by the sole full verifier recheck',async t=>{
 const content=kind==='unknown'?'答案：不能选定唯一周期\n确定性：unknown\n依据：资料没有唯一周期。':'答案：先开展桌面演练\n确定性：proposal\n依据：仅为未来方案。',target=content.split('\n')[0];
 const patch=(r,bound)=>{const c=r.groundingReview.claims[0];c.kind=kind;c.text=target;c.field='content';c.start=0;c.citationIds=[];if(bound)c.qualification={field:'content',quote:content};return r;};
 const f=await fixture(t,{content,first:r=>patch(r,false),second:r=>patch(r,true)}),result=await f.run();
 assert.equal(result.passed,true,result.summary);assert.equal(f.calls.length,3);assert.equal(result.grounding.claims[0].kind,kind);assert.equal(Object.values(f.task.contextFinalizations).length,1);
 await assert.rejects(f.run(),/有界结论/);assert.equal(f.calls.length,3);
});
for(const kind of ['unknown','proposal'])test(kind+' mixed factual defect cannot spend the scope repair allowance',async t=>{
 const f=await fixture(t,{first:r=>{r.groundingReview.claims[0].kind=kind;r.groundingReview.unsupportedClaims=['仍有未经支持的肯定断言'];return r;}});
 assert.equal((await f.run()).passed,false);assert.equal(f.calls.length,2);assert.equal(Object.keys(f.task.contextFinalizations||{}).length,0);
});
test('JSON repairable failure in recheck gets no automatic third verifier transport',async t=>{
 const f=await fixture(t,{second:()=>{throw Object.assign(Error('malformed output'),{code:'MODEL_INVALID_RESPONSE',modelFailure:true,jsonRepairable:true,automaticRetry:true,responseText:'{'});}});
 await assert.rejects(f.run(),/malformed output/);assert.equal(f.calls.length,3);assert.equal(Object.values(f.task.contextFinalizations)[0].status,'failed');await assert.rejects(f.run(),/有界结论/);assert.equal(f.calls.length,3);
});
for(const when of ['before-recheck','during-recheck'])test('changed source cannot authorize recheck result: '+when,async t=>{
 const f=await fixture(t,{hook:({source,payload})=>{if((when==='during-recheck')===!!payload.groundingClassificationReview)source.content='已修改为另一份记录。';}});
 await assert.rejects(f.run());assert.equal(f.calls.length,when==='before-recheck'?2:3);
});
test('pause before recheck prevents extra transport',async t=>{
 const f=await fixture(t,{hook:({a})=>{a.suspended=true;}});await assert.rejects(f.run());assert.equal(f.calls.length,2);
});
for(const when of ['before-recheck','during-recheck'])test('revoked source prevents recheck result: '+when,async t=>{
 const f=await fixture(t,{hook:({a,task,source,payload})=>{if((when==='during-recheck')===!!payload.groundingClassificationReview){const p=require('../desktop/access-policy-store.cjs');p.revoke(a,{principalScope:p.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+source.id,taskId:task.id},operations:['local_read','local_retention']},{trusted:true,actor:'user_command'});}}});
 await assert.rejects(f.run());assert.equal(f.calls.length,when==='before-recheck'?2:3);
});
test('fresh check cannot borrow visibility from evidence omitted in its actual input',async t=>{
 const budget=require('../desktop/input-budget.cjs'),original=budget.prepare;
 t.mock.method(budget,'prepare',(...args)=>{const prepared=original(...args);for(const row of prepared.payloads)if(row.value.groundingClassificationReview){for(const key of ['contextReads','generationEvidence','requestedSections','retrievedEvidence','sources'])row.value[key]=[];prepared.messages[row.index].content=JSON.stringify(row.value);}return prepared;});
 const f=await fixture(t);const result=await f.run();assert.equal(result.passed,false);assert.equal(f.calls.length,3);assert.ok(result.grounding.issues.some(s=>s.includes('尚未提供')));
});
test('explicit root review arrays may supply missing nested fields without another call',async t=>{
 const f=await fixture(t,{first:r=>{r.groundingReview.claims[0].kind='fact';for(const key of ['unsupportedClaims','conflicts','consistencyIssues']){r[key]=r.groundingReview[key];delete r.groundingReview[key];}return r;}});
 const result=await f.run();assert.equal(result.passed,true,result.summary);assert.equal(f.calls.length,2);
});
for(const mode of ['missing','invalid-root','nonempty-root','root-nested-disagree','same-location-values'])test('review field envelope validation: '+mode,async t=>{
 const f=await fixture(t,{first:r=>{r.groundingReview.claims[0].kind='fact';if(mode==='missing')delete r.groundingReview.unsupportedClaims;if(mode==='invalid-root'){delete r.groundingReview.unsupportedClaims;r.unsupportedClaims='not an array';}if(mode==='nonempty-root'){delete r.groundingReview.unsupportedClaims;r.unsupportedClaims=['缺少可靠依据'];}if(mode==='root-nested-disagree')r.unsupportedClaims=['不能被嵌套空数组覆盖'];if(mode==='same-location-values')r.unsupportedClaims=[];return r;}});
 const result=await f.run();assert.equal(result.passed,mode==='same-location-values');assert.equal(f.calls.length,2);
});
for(const mode of ['root-nested-disagree','nonempty-root','new-nested-defect'])test('cached pass cannot suppress explicit new review data: '+mode,async t=>{
 const f=await fixture(t),passed=await f.run();assert.equal(passed.passed,true);f.task.grounding=passed.grounding;
 const seen=new Set();grounding.observe(seen,f.calls.at(-1).payload);
 const confirmation=grounding.finish(f.a,f.task,{passed:true,summary:'其余标准通过',gaps:[]},{seen});assert.equal(confirmation.passed,true);assert.equal(confirmation.grounding.reused,true);
 const response=f.response('fact');if(mode==='new-nested-defect')response.groundingReview.unsupportedClaims=['当前数量未获原文支持'];else response.unsupportedClaims=['当前数量未获原文支持'];if(mode==='nonempty-root')delete response.groundingReview.unsupportedClaims;
 const result=grounding.finish(f.a,f.task,response,{seen});assert.equal(result.passed,false);assert.equal(result.grounding.reused,false);assert.ok(result.grounding.issues.length);
});
