const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');
async function setup(t) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-named-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('文件动作不应调用模型');}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  const output=path.join(dir,'output');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
  const j=agent.buildJob(a,{goal:'交付指定文件',useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(j);
  const makeTask=async key=>{const result=await agent.act(a,j,'plan_task',{key,title:key,criteria:'保存文稿',steps:[{key:'draft',kind:'draft',title:'写作'},{key:'save',kind:'external',tool:'write_file',title:'保存'}]});const task=a.task(result.taskId);task.steps[0].done=true;task.steps[0].artifactId='artifact-'+key;a.data.artifacts.push({id:'artifact-'+key,taskId:task.id,title:'测试文稿',content:'青禾报告 4800 元',createdAt:new Date().toISOString()});return task;};
  const task=await makeTask('青禾');a.save();
  return {a,j,task,output,makeTask,prepare:(filename)=>writes.prepare(a,j,'write_file',{taskId:task.id,...(filename===undefined?{}:{filename})})};
}
test('Named Markdown delivery preserves history, records exact filename and reuses duplicate attempts',async t=>{
  const {a,j,task,output,prepare}=await setup(t),r=await prepare('qinghe.md');assert.equal(r.args.filename,'qinghe.md');assert.equal(r.latestName,'qinghe.md');assert.notEqual(path.basename(r.target),'qinghe.md');
  const result=await writes.execute(a,j,r);assert.equal(result.latestPath,path.join(output,'qinghe.md'));assert.equal(fs.readFileSync(result.path,'utf8'),fs.readFileSync(result.latestPath,'utf8'));assert.equal(task.steps[1].done,true);
  const again=await prepare('qinghe.md'),implicit=await prepare();assert.equal(again.id,r.id);assert.equal(implicit.id,r.id);assert.equal(a.data.agentActions.length,1);assert.equal(fs.readdirSync(output).length,2);await writes.verifyDelivery(a,j,task);
});
test('Filename omission after a restart keeps the named destination when publishing a newer artifact',async t=>{
  const {a,j,task,output,prepare}=await setup(t);await writes.execute(a,j,await prepare('青禾报告.md'));
  const b=new Assistant({dir:a.dir}),job=b.data.delegations[0],current=b.task(task.id);job.status='ready';current.steps[1].done=false;current.steps[0].artifactId='revision-2';b.data.artifacts.push({id:'revision-2',taskId:task.id,title:'新版',content:'新版预算 5000 元'});
  const r=await writes.prepare(b,job,'write_file',{taskId:task.id});assert.equal(r.latestName,'青禾报告.md');await writes.execute(b,job,r);assert.equal(fs.readFileSync(path.join(output,'青禾报告.md'),'utf8'),'新版预算 5000 元');assert.equal(fs.readdirSync(output).length,3);
});
test('Unsafe or reserved filenames fail before preparing an action or touching the output directory',async t=>{
  const {a,output,prepare}=await setup(t);
  for(const name of ['../outside.md','/tmp/outside.md','folder/name.md','folder\\name.md','.secret.md','bad\nname.md','bad:name.md','name.pdf',' report.md','report.md ',null,123,'行知-1234abcd-最新.md','中'.repeat(100)+'.md'])await assert.rejects(prepare(name),/文件名/);
  assert.equal(a.data.agentActions.length,0);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Preexisting user files, including identical content, are preserved and never claimed',async t=>{
  const {output,prepare}=await setup(t);fs.writeFileSync(path.join(output,'user.md'),'青禾报告 4800 元');await assert.rejects(prepare('user.md'),e=>e.conflict);assert.deepEqual(fs.readdirSync(output),['user.md']);assert.equal(fs.readFileSync(path.join(output,'user.md'),'utf8'),'青禾报告 4800 元');
});
test('A file created after approval preparation blocks the write without overwriting it',async t=>{
  const {a,j,output,prepare}=await setup(t);j.fileMode='ask';const r=await prepare('later.md');r.approvedAt=new Date().toISOString();require('../desktop/protocol-access.cjs').authorizeAction(a,r,'fixture_explicit_action');fs.writeFileSync(path.join(output,'later.md'),'人工报告');await assert.rejects(writes.execute(a,j,r),e=>e.conflict);assert.equal(fs.readFileSync(path.join(output,'later.md'),'utf8'),'人工报告');assert.deepEqual(fs.readdirSync(output),['later.md']);
});
test('Another task cannot reserve or overwrite an existing named destination',async t=>{
  const {a,j,prepare,makeTask}=await setup(t);await prepare('Shared.md');const second=await makeTask('其他事项');await assert.rejects(writes.prepare(a,j,'write_file',{taskId:second.id,filename:'shared.md'}),e=>e.conflict);assert.equal(a.data.agentActions.length,1);
});
test('Human edits to a named delivery block newer versions and leave the edited file intact',async t=>{
  const {a,j,task,output,prepare}=await setup(t);await writes.execute(a,j,await prepare('report.md'));fs.writeFileSync(path.join(output,'report.md'),'人工补充');task.steps[1].done=false;task.steps[0].artifactId='revision-2';a.data.artifacts.push({id:'revision-2',taskId:task.id,title:'新版',content:'模型新版'});const r=await prepare();await assert.rejects(writes.execute(a,j,r),e=>e.conflict);assert.equal(fs.readFileSync(path.join(output,'report.md'),'utf8'),'人工补充');
});
test('Changed output authorization or plan makes a prepared named write invalid',async t=>{
  const {a,j,task,output,prepare}=await setup(t);const r=await prepare('scope.md');const changed=path.join(a.dir,'changed');fs.mkdirSync(changed);j.outputFolder=changed;await assert.rejects(writes.execute(a,j,r),/授权范围/);assert.deepEqual(fs.readdirSync(output),[]);assert.deepEqual(fs.readdirSync(changed),[]);j.outputFolder=output;task.criteria='改变要求';await assert.rejects(writes.execute(a,j,r),/失效/);
});
test('Symlinks never redirect named writes outside the selected directory',async t=>{
  const {a,j,output,prepare}=await setup(t),outside=path.join(a.dir,'outside.md');fs.writeFileSync(outside,'保留');fs.symlinkSync(outside,path.join(output,'link.md'));await assert.rejects(prepare('link.md'),e=>e.conflict);
  const r=await prepare('after.md');fs.symlinkSync(outside,path.join(output,'after.md'));await assert.rejects(writes.execute(a,j,r),e=>e.conflict);assert.equal(fs.readFileSync(outside,'utf8'),'保留');
});
test('Uncertain named delivery is reconciled read-only and a missing file is never recreated',async t=>{
  const {a,j,task,output,prepare}=await setup(t);const r=await prepare('proof.md');await writes.execute(a,j,r);r.status='uncertain';await writes.execute(a,j,r);assert.equal(r.status,'done');fs.unlinkSync(path.join(output,'proof.md'));r.status='uncertain';await assert.rejects(writes.execute(a,j,r),e=>e.requiresInput);assert.equal(r.status,'uncertain');assert.equal(fs.existsSync(path.join(output,'proof.md')),false);assert.equal(task.steps[1].done,true);
});
