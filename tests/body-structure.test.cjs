'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const structure=require('../desktop/body-structure.cjs'),{hash}=require('../desktop/evidence-basis.cjs');
const access=require('../desktop/protocol-access.cjs');
function fixture(t,content='安排。\n\n规则。',criteria='正文恰好两个自然段。'){
 t.mock.method(access,'allowedObject',()=>true);
 const task={id:'task',description:'写一份通知。',criteria,steps:[{id:'step',kind:'draft',done:true,artifactId:'current'}],notes:[],primaryArtifactId:'current'};
 const artifact={id:'current',taskId:task.id,stepId:'step',title:'通知标题',content};
 return {a:{data:{artifacts:[artifact],delegations:[]}},task,artifact};
}
for(const [wording,expected] of [['正文恰好两个自然段。',2],['请将正文改为恰好2个自然段，不用项目符号：先安排后规则。',2],['把正文调整为恰好十一个自然段。',11],['正文必须为恰好二十个自然段。',20]])test('explicit complete directive: '+wording,()=>assert.equal(structure.extract(wording)[0]?.count,expected));
for(const wording of [
 '初稿不要求两段正文。','正文不必恰好两个自然段。','不要将正文改为恰好两个自然段。',
 '正文恰好两个自然段，但不必严格满足。','正文恰好两个自然段，或者三段。',
 '```text\n\n正文恰好两个自然段。\n\n```','“\n\n正文恰好两个自然段。\n\n”','示例：\n\n正文恰好两个自然段。',
 '正文恰好两个自然段，不需要遵守这个限制。','正文恰好两个自然段，除非实际内容需要更多段。',
 '例如，正文恰好两个自然段。','示例：\n正文恰好两个自然段。','“正文恰好两个自然段。”',
 '“\n正文恰好两个自然段。\n”','`正文恰好两个自然段`','```\n正文恰好两个自然段。\n```',
 '> 正文恰好两个自然段。','如果需要，正文恰好两个自然段。','此前要求：\n正文恰好两个自然段。',
 '附件正文恰好两个自然段。','正文约两个自然段。','正文最多两个自然段。','正文至少两个自然段。',
 '正文恰好零个自然段。','正文恰好二十一个自然段。','正文恰好2至3个自然段。'
])test('not a supported current exact directive: '+JSON.stringify(wording),()=>assert.deepEqual(structure.extract(wording),[]));
for(const [name,content,actual] of [
 ['normal','安排。\n\n规则。',2],['CRLF','安排。\r\n\r\n规则。',2],['blank whitespace','\n安排。\n \t\n\u3000\n规则。\n',2],['unicode blank whitespace','安排。\n\u00a0\n规则。',2],
 ['soft line wrap','安排\n继续安排。\n\n规则。',2],['repeated title is body','通知标题\n\n安排。\n\n规则。',3],['empty','',0]
])test('body counting preserves bytes: '+name,t=>{const f=fixture(t,content),v=structure.inspect(f.a,f.task);assert.equal(v.status,'checked');assert.equal(v.actual,actual);assert.equal(v.passed,actual===2);assert.equal(v.contentHash,hash(content));assert.equal(f.artifact.content,content);});
for(const content of ['# 标题\n\n安排。\n\n规则。','标题\n===\n\n安排。\n\n规则。','- 安排\n\n- 规则','1. 安排\n\n2. 规则','```\n安排\n\n规则\n```','| 列一 | 列二 |','<p>安排</p><p>规则</p>'])test('unsupported layout never becomes local passed: '+content,t=>{const f=fixture(t,content);assert.equal(structure.inspect(f.a,f.task).status,'unsupported');assert.equal(structure.inspect(f.a,f.task).passed,undefined);});
test('no explicit rule, ambiguous counts, multi-draft and linked tasks retain semantic verification',t=>{
 for(const criteria of ['写清安排。','正文恰好两个自然段。正文恰好三个自然段。']){const f=fixture(t,'标题\n\n安排\n\n规则',criteria),r={passed:true,summary:'model',gaps:[]};assert.equal(structure.finish(f.a,f.task,r),r);}
 const f=fixture(t);f.task.steps.push({id:'other',kind:'draft'});assert.equal(structure.rule(f.a,f.task),null);f.task.steps.pop();f.task.agentJobId='job';assert.equal(structure.rule(f.a,f.task),null);
});
for(const override of ['正文不要求固定段数。','正文不限段数。','正文最多三个自然段。','正文恰好二十一个自然段。','示例：\n\n正文恰好两个自然段。','无任何格式限制。'])test('unsupported related criteria cannot disappear beside a description rule: '+override,t=>{
 const f=fixture(t,'一\n\n二\n\n三',override);f.task.description='正文恰好两个自然段。';const before=structuredClone(f.task);assert.equal(structure.rule(f.a,f.task),null);assert.equal(structure.inspect(f.a,f.task).passed,undefined);assert.deepEqual(f.task,before);
});
function revision(f,text='将正文改为恰好两个自然段。'){
 const original={id:'old',taskId:f.task.id,stepId:'step',title:'通知标题',content:'原稿。'};f.a.data.artifacts.push(original);
 f.task.notes.push({id:'revision',kind:'revise',origin:'user',text,targetArtifactId:original.id,targetStepId:'step',baseHash:hash(original.content),at:'2026-11-02T01:00:00Z'});
 f.artifact.generationSnapshot={artifacts:[{artifactId:original.id,stepId:'step',hash:hash(original.content)}]};return original;
}
test('revision binds original and replacement without applying its count to the old body',t=>{
 const f=fixture(t);revision(f);assert.equal(structure.inspect(f.a,f.task).passed,true);
 f.artifact.generationSnapshot.artifacts[0].hash='wrong';assert.equal(structure.inspect(f.a,f.task).status,'unsupported');
});
test('newest revision does not resurrect old numeric requirements or alter semantic inputs',t=>{
 const f=fixture(t,'三\n\n个\n\n段');revision(f);
 const previous=structuredClone(f.task.notes);revision(f,'只润色文字，不限制正文段数。');
 // Keep a unique original resource for this fixture; the second user note still wins.
 f.a.data.artifacts.pop();const note=f.task.notes.at(-1);note.targetArtifactId='old';
 assert.equal(structure.rule(f.a,f.task),null);assert.deepEqual(f.task.notes[0],previous[0]);assert.equal(f.task.criteria,'正文恰好两个自然段。');
});
test('wrong target, agent note, tampered original, later user edit do not infer a revision rule',t=>{
 for(const mutate of [f=>f.task.notes[0].targetStepId='other',f=>f.task.notes[0].origin='agent',f=>f.a.data.artifacts[1].content='changed',f=>f.task.notes[0].baseHash='wrong']){const f=fixture(t);revision(f);mutate(f);assert.equal(structure.rule(f.a,f.task),null);}
 const f=fixture(t);revision(f);f.task.userRequirement={at:'2026-11-02T02:00:00Z'};f.task.criteria='无段数要求。';assert.equal(structure.rule(f.a,f.task),null);
});
test('current content/title/requirement hashes change the local basis',t=>{
 const f=fixture(t),a=structure.inspect(f.a,f.task);f.artifact.content+='变化';const b=structure.inspect(f.a,f.task);assert.notEqual(a.basis,b.basis);f.task.criteria='正文恰好三个自然段。';const c=structure.inspect(f.a,f.task);assert.notEqual(b.basis,c.basis);f.artifact.title='新标题';assert.notEqual(c.basis,structure.inspect(f.a,f.task).basis);
});
test('model pass cannot overwrite local mismatch; semantic rejection cannot be promoted by local pass',t=>{
 const f=fixture(t,'标题\n\n安排\n\n规则'),raw={passed:true,summary:'正文两段',gaps:[]};const rejected=structure.finish(f.a,f.task,raw);assert.equal(rejected.passed,false);assert.equal(rejected.bodyStructure.preStructurePassed,true);assert.equal(rejected.bodyStructure.preStructureSummary,raw.summary);assert.equal(raw.passed,true);assert.equal(rejected.gaps.length,1);
 f.artifact.content='安排\n\n规则';const failed={passed:false,summary:'缺少证据',gaps:['缺少证据']};assert.equal(structure.finish(f.a,f.task,failed).passed,false);
});
