const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Assistant} = require('../desktop/core.cjs');
const playbooks = require('../desktop/playbooks.cjs');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-playbook-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  let calls = 0;
  const a = new Assistant({dir,chat:async () => {calls++;throw new Error('方案操作不应调用模型');},agentRequest:async () => {throw new Error('方案操作不应访问网络');}});
  playbooks.initialize(a);
  return {a,dir,calls:() => calls};
}
const spec = {title:'发布方案',description:'每轮复用',goalTemplate:'研究 {{主题}}',taskRequirements:'完成标准：{{要求}}',maxCalls:25,maxActions:4,intervalMinutes:15,autoAccept:false};
const run = (a,action,input) => playbooks.dispatch(a,action,input);
async function create(a,input={}) {await run(a,'playbookSave',{...spec,...input});return a.data.playbooks[0];}

test('Playbooks initialize four real recipes exactly once and survive workspace reload', async t => {
  const {a,dir} = setup(t);assert.equal(a.data.playbooks.length,4);
  playbooks.initialize(a);assert.equal(a.data.playbooks.length,4);
  assert.equal(new Set(a.data.playbooks.map(p => p.id)).size,4);
  for (const p of a.data.playbooks) {assert.equal(p.builtin,true);assert.ok(p.taskRequirements.length>40);assert.deepEqual(playbooks.variables(`${p.goalTemplate}\n${p.taskRequirements}`),['主题','要求']);}
  const custom = await create(a);const restored = new Assistant({dir});playbooks.initialize(restored);
  assert.equal(restored.data.playbooks.length,5);assert.equal(restored.data.playbooks.find(p => p.id === custom.id).revision,1);
});

test('Saving and preparing a recipe never starts a job, calls a model, or copies permissions', async t => {
  const {a,calls} = setup(t);
  const p = await create(a,{folderIds:['private'],outputFolder:'/private',githubRepo:'owner/private',githubToken:'DO_NOT_COPY',sourceIds:['secret-source'],sendPolicy:{mode:'auto'},allowWeb:true,projectId:'private',fileMode:'auto'});
  assert.deepEqual(Object.keys(p).sort(),['title','description','goalTemplate','taskRequirements','maxActions','intervalMinutes','autoAccept','id','builtin','revision','archived','createdAt','updatedAt'].sort());
  const before = JSON.stringify(a.data),draft = await run(a,'playbookPrepare',{id:p.id,revision:p.revision,values:{主题:'发布排期',要求:'列出风险与证据'}});
  assert.deepEqual(Object.keys(draft).sort(),['goal','maxActions','intervalMinutes','autoAccept','templateId','templateRevision'].sort());
  assert.match(draft.goal,/发布排期/);assert.match(draft.goal,/列出风险与证据/);assert.equal(draft.autoAccept,false);
  assert.equal(JSON.stringify(a.data),before);assert.equal(a.data.delegations.length,0);assert.equal(calls(),0);
  assert.equal(JSON.stringify(draft).includes('DO_NOT_COPY'),false);
});

test('Template substitution requires every named value and does not reinterpret replacement text', async t => {
  const {a} = setup(t),p = await create(a);
  const args = {id:p.id,revision:p.revision};
  await assert.rejects(run(a,'playbookPrepare',{...args,values:{主题:'调研'}}),/填写要求/);
  await assert.rejects(run(a,'playbookPrepare',{...args,values:{主题:' ',要求:'完整'}}),/填写主题/);
  await assert.rejects(run(a,'playbookPrepare',{...args,values:['bad']}),/变量须为对象/);
  await assert.rejects(run(a,'playbookPrepare',{...args,values:{主题:'x'.repeat(3001),要求:'完整'}}),/3000/);
  const result = await run(a,'playbookPrepare',{...args,values:{主题:'字面量 {{要求}}',要求:'$& 和 $1'}});
  assert.match(result.goal,/字面量 \{\{要求\}\}/);assert.match(result.goal,/\$& 和 \$1/);
});

test('Unknown or malformed placeholders and oversized rendered goals fail before saving or execution', async t => {
  const {a} = setup(t),before = a.data.playbooks.length;
  for (const goalTemplate of ['写 {{日期}}','写 {{ 主题 }}','写 {{主题','写 主题}}','写 {{{主题}}}']) await assert.rejects(create(a,{goalTemplate}),/变量只支持/);
  assert.equal(a.data.playbooks.length,before);
  const p = await create(a,{goalTemplate:'{{主题}} '.repeat(4),taskRequirements:''});
  await assert.rejects(run(a,'playbookPrepare',{id:p.id,revision:p.revision,values:{主题:'a'.repeat(3000)}}),/10000/);
});

test('A fixed recipe can prepare without variables and validates execution settings strictly', async t => {
  const {a} = setup(t);
  for (const invalid of [{maxActions:1.5},{intervalMinutes:0},{autoAccept:'true'}]) await assert.rejects(create(a,invalid),/上限|间隔|布尔值/);
  const p = await create(a,{goalTemplate:'固定复盘',taskRequirements:''});
  const draft = await run(a,'playbookPrepare',{id:p.id,revision:p.revision});assert.equal(draft.goal,'固定复盘');
});

test('Editing requires a current revision, increments it, and stale cards cannot prepare or overwrite', async t => {
  const {a} = setup(t),p = await create(a),id = p.id;
  await run(a,'playbookSave',{...spec,id,revision:1,title:'新版'});assert.equal(p.revision,2);
  for (const action of ['playbookSave','playbookPrepare','playbookCopy','playbookArchive']) await assert.rejects(run(a,action,{...spec,id,revision:1,archived:true}),/已更新/);
  assert.equal(p.title,'新版');assert.equal(p.revision,2);
  await assert.rejects(run(a,'playbookPrepare',{id:'removed',revision:1}),/不存在/);
});

test('Builtins are read-only, copies are independent, and archived user recipes can be restored', async t => {
  const {a} = setup(t),p = a.data.playbooks[0];
  await assert.rejects(run(a,'playbookSave',{...p,title:'改写内置'}),/先复制/);
  await assert.rejects(run(a,'playbookArchive',{id:p.id,revision:p.revision,archived:true}),/不能归档/);
  await run(a,'playbookCopy',{id:p.id,revision:p.revision});const copy = a.data.playbooks[0];
  assert.notEqual(copy.id,p.id);assert.equal(copy.builtin,false);assert.equal(copy.goalTemplate,p.goalTemplate);
  await run(a,'playbookArchive',{id:copy.id,revision:1,archived:true});assert.equal(copy.revision,2);
  await assert.rejects(run(a,'playbookPrepare',{id:copy.id,revision:2,values:{主题:'项目',要求:'报告'}}),/已归档/);
  await assert.rejects(run(a,'playbookSave',{...copy,title:'归档期间修改'}),/已归档/);
  await run(a,'playbookArchive',{id:copy.id,revision:2,archived:false});assert.equal(copy.revision,3);
  const draft = await run(a,'playbookPrepare',{id:copy.id,revision:3,values:{主题:'项目',要求:'报告'}});assert.match(draft.goal,/项目/);
  assert.equal(p.revision,1);assert.equal(p.archived,false);
});

test('Extracting an existing delegation preserves only goals, active task criteria and bounded execution parameters', async t => {
  const {a,calls} = setup(t);
  a.data.tasks.push({id:'t1',title:'撰写方案',criteria:'列出替代路径',sourceIds:['private-source'],steps:[{title:'Send secret',tool:'request_confirmation'}]}, {id:'t2',title:'取消事项',criteria:'不应提取',agentCancelled:true});
  a.data.delegations.push({id:'j1',title:'发布',goal:'整理发布计划',taskIds:['t1','t2'],maxCalls:60,maxActions:6,intervalMinutes:60,autoAccept:false,folderIds:['private'],outputFolder:'/private',githubRepo:'owner/private',fileMode:'auto',sourceIds:['private-source'],feedback:[{text:'私有材料'}],sendPolicy:{mode:'auto'},githubToken:'PRIVATE_TOKEN'});
  const before = JSON.stringify(a.data),draft = await run(a,'playbookFromJob',{jobId:'j1'});
  assert.equal(draft.goalTemplate,'整理发布计划');assert.match(draft.taskRequirements,/列出替代路径/);
  assert.doesNotMatch(JSON.stringify(draft),/private|PRIVATE_TOKEN|Send secret|不应提取|私有材料/);
  assert.equal(draft.autoAccept,false);assert.equal(draft.maxCalls,undefined);assert.equal(JSON.stringify(a.data),before);assert.equal(calls(),0);
  await run(a,'playbookSave',draft);assert.equal(a.data.playbooks[0].title,'发布方案');
});

test('Unknown delegation, oversized extraction, and invalid operation inputs fail without writes', async t => {
  const {a} = setup(t),before = a.data.playbooks.length;
  await assert.rejects(run(a,'playbookFromJob',{jobId:'missing'}),/不存在/);
  a.data.delegations.push({id:'large',goal:'x'.repeat(7001),taskIds:[]});
  await assert.rejects(run(a,'playbookFromJob',{jobId:'large'}),/较长/);
  await assert.rejects(run(a,'playbookSave',null),/须为对象/);
  await assert.rejects(run(a,'playbookUnknown',{}),/未知/);
  assert.equal(a.data.playbooks.length,before);
});

test('Recipe operations respect the running operation lock', async t => {
  const {a} = setup(t);a.operation = {label:'正在推进'};
  await assert.rejects(run(a,'playbookSave',spec),/正在处理/);
  await assert.rejects(run(a,'playbookPrepare',{id:a.data.playbooks[0].id,revision:1,values:{主题:'项目',要求:'报告'}}),/正在处理/);
  assert.equal(a.data.playbooks.length,4);
});

test('Submission validates recipe provenance again while allowing the user to edit a prepared goal', async t => {
  const {a} = setup(t),p = await create(a);
  const input = {templateId:p.id,templateRevision:1,goal:'用户补充后的目标',folderIds:['selected-now']};
  assert.deepEqual(playbooks.validateDraft(a,input),{id:p.id,revision:1,title:p.title});
  assert.equal(playbooks.validateDraft(a,{goal:'独立目标'}),null);
  await run(a,'playbookSave',{...p,title:'已更新'});
  assert.throws(() => playbooks.validateDraft(a,input),/已更新/);
  await run(a,'playbookArchive',{id:p.id,revision:2,archived:true});
  assert.throws(() => playbooks.validateDraft(a,{...input,templateRevision:3}),/已归档/);
  assert.throws(() => playbooks.validateDraft(a,{templateId:'deleted',templateRevision:1}),/不存在/);
});

test('Extracting a delegation with extended runtime budget does not copy obsolete call limits', async t => {
  const {a} = setup(t);a.data.delegations.push({id:'extended',goal:'复盘',taskIds:[],maxCalls:1000});
  const draft = await run(a,'playbookFromJob',{jobId:'extended'});assert.equal(draft.maxCalls,undefined);
  await run(a,'playbookSave',draft);assert.equal(a.data.playbooks[0].maxCalls,undefined);
});
