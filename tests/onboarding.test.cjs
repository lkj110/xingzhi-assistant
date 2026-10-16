const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Assistant} = require('../desktop/core.cjs');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-guide-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return new Assistant({dir, chat: () => { throw Error('Guide must not call models'); }});
}

test('first-use dismissal survives restart without changing work or enabling automation', async t => {
  const a = workspace(t);
  const task = a.createTask({title:'原事项', criteria:'保留原要求', steps:[{title:'整理',kind:'draft'}]});
  a.operation = {label:'原有工作正在运行'};
  const before = JSON.stringify({tasks:a.data.tasks,settings:a.data.settings,modelCalls:a.data.modelCalls});
  assert.equal(a.publicState().runtime.onboarding, undefined);
  const result = await a.dispatch('guideDismiss', {automatic:true});
  assert.ok(result.runtime.onboarding.seenAt);
  assert.equal(JSON.stringify({tasks:a.data.tasks,settings:a.data.settings,modelCalls:a.data.modelCalls}), before);
  assert.equal(a.operation.label, '原有工作正在运行');
  const restored = new Assistant({dir:a.dir});
  assert.deepEqual(restored.publicState().runtime.onboarding,result.runtime.onboarding);
  assert.equal(restored.data.tasks[0].id,task.id);
  assert.equal(restored.data.settings.automatic,false);
});

test('reopening and dismissing the guide is idempotent', async t => {
  const a = workspace(t);
  const first = await a.dispatch('guideDismiss');
  a.save = () => { throw Error('Repeated acknowledgement should not save'); };
  const second = await a.dispatch('guideDismiss');
  assert.deepEqual(second.runtime.onboarding,first.runtime.onboarding);
});

test('failed acknowledgement stays unseen so the user can retry', async t => {
  const a = workspace(t), save = a.save.bind(a);
  a.save = () => {throw Error('disk full');};
  await assert.rejects(a.dispatch('guideDismiss'),/disk full/);
  assert.equal(a.publicState().runtime.onboarding,undefined);
  a.save = save;
  assert.ok((await a.dispatch('guideDismiss')).runtime.onboarding.seenAt);
});

test('offline handbook search finds troubleshooting, Chinese phrases and model names', async () => {
  const {parseGuide,searchGuide,guideRoutes} = await import('../src/help-content.mjs');
  const content = fs.readFileSync(path.join(__dirname,'../docs/USER_GUIDE.md'),'utf8');
  const sections = parseGuide(content);
  assert.equal(new Set(sections.map(s=>s.id)).size,sections.length);
  assert.ok(sections.length >= 20);
  for(const title of Object.keys(guideRoutes)) assert.ok(sections.some(s=>s.title===title),title);
  assert.ok(searchGuide(sections,'用量未知').some(s=>s.title==='超时、失败与用量未知'));
  assert.ok(searchGuide(sections,'dw 静态').some(s=>s.title==='能力中心与 DW 仓库'));
  assert.ok(searchGuide(sections,'OLLAMA').some(s=>s.title==='连接模型与订阅'));
  assert.deepEqual(searchGuide(sections,'不存在的使用说明关键字'),[]);
  assert.equal(searchGuide(sections,'   ').length,sections.length);
  assert.deepEqual(parseGuide('标题\r\n## 第一章\r\n正文'),[{id:'第一章',title:'第一章',body:'正文'}]);
});

test('existing users see the capture permission guide once on upgrade',async t=>{const a=workspace(t);a.data.runtime.onboarding={version:1,seenAt:'2026-01-01'};const first=await a.dispatch('guideDismiss');assert.equal(first.runtime.onboarding.version,2);const at=first.runtime.onboarding.seenAt;a.save=()=>{throw Error('must not repeat');};assert.equal((await a.dispatch('guideDismiss')).runtime.onboarding.seenAt,at);});
