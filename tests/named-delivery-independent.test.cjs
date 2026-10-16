const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs');
async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-independent-name-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('此测试不调用模型');}});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid'});
  const output=path.join(dir,'output');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
  const j=agent.buildJob(a,{goal:'文件交付',useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(j);
  async function makeTask(job,key){const {taskId}=await agent.act(a,job,'plan_task',{key,title:key,criteria:'保存文稿',steps:[{key:'draft',kind:'draft',title:'文稿'}]});const task=a.task(taskId);task.steps[0].done=true;task.steps[0].artifactId=`artifact-${key}`;a.data.artifacts.push({id:task.steps[0].artifactId,taskId,content:'有依据的正文'});return task;}
  const task=await makeTask(j,'a');return {a,j,task,output,makeTask,prepare:name=>writes.prepare(a,j,'write_file',{taskId:task.id,filename:name})};
}
test('Custom filenames reject Windows device names while allowing ordinary related words',async t=>{
  const {prepare,output}=await setup(t);
  for(const name of ['CON.md','nul.md','Aux.md','prn.md','COM1.md','LPT9.md','com².md','lpt³.md','CONIN$.md','conout$.md','clock$.md','con.backup.md','NUL .md'])await assert.rejects(prepare(name),/设备保留名/);
  assert.deepEqual(fs.readdirSync(output),[]);const r=await prepare('console.md');assert.equal(r.latestName,'console.md');
});
test('A second named target does not inherit approval for the first target',async t=>{
  const {a,j,task,output}=await setup(t);const before=structuredClone(j);j.fileMode='ask';require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{before,trusted:true,actor:'user_command',command:'fixtureWritePolicy'});await agent.act(a,j,'write_file',{taskId:task.id,filename:'first.md'});const old=a.data.agentActions[0];
  await a.dispatch('agentApprove',{id:j.id,actionId:old.id,version:old.version});assert.ok(old.approvedAt);
  await agent.act(a,j,'write_file',{taskId:task.id,filename:'second.md'});const next=a.data.agentActions.at(-1);assert.notEqual(next.id,old.id);assert.equal(next.approvedAt,undefined);assert.equal(j.pendingActionId,next.id);
  await assert.rejects(writes.execute(a,j,next),/请先确认/);await assert.rejects(a.dispatch('agentApprove',{id:j.id,actionId:old.id,version:old.version}),/已变化/);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Named file ownership and normalized collisions are enforced across delegations',async t=>{
  const {a,j,task,makeTask,prepare}=await setup(t);await prepare('e\u0301.md');const other=agent.buildJob(a,{goal:'其他委托',useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(other);const own=await makeTask(other,'b');
  await assert.rejects(writes.prepare(a,other,'write_file',{taskId:task.id,filename:'takeover.md'}),/不属于/);
  await assert.rejects(writes.prepare(a,other,'write_file',{taskId:own.id,filename:'é.md'}),error=>error.conflict===true);
  const r=await writes.prepare(a,j,'write_file',{taskId:task.id,filename:'own.md'});j.fileMode='off';await assert.rejects(writes.execute(a,j,r),/未允许/);
});
test('Replacing an authorized directory with a symlink cannot create, reconcile or verify named files outside it',async t=>{
  const {a,j,task,output,prepare}=await setup(t);const r=await prepare('proof.md');await writes.execute(a,j,r);
  const outside=path.join(a.dir,'outside');fs.cpSync(output,outside,{recursive:true});const original=output+'-original';fs.renameSync(output,original);fs.symlinkSync(outside,output);
  await assert.rejects(prepare('other.md'),/符号链接替换/);r.status='uncertain';await assert.rejects(writes.execute(a,j,r),error=>error.requiresInput===true&&/符号链接替换/.test(error.message));assert.equal(r.status,'uncertain');
  // A stale success flag also cannot make goal verification accept files reached through an alias.
  r.status='done';await assert.rejects(writes.verifyDelivery(a,j,task),/符号链接替换/);assert.deepEqual(fs.readdirSync(outside).sort(),fs.readdirSync(original).sort());
});
test('Dangling file and directory symlinks never create files at their targets',async t=>{
  const {a,j,output,prepare}=await setup(t),missing=path.join(a.dir,'missing-target.md');fs.symlinkSync(missing,path.join(output,'dangling.md'));
  const r=await prepare('dangling.md');await assert.rejects(writes.execute(a,j,r));assert.equal(fs.existsSync(missing),false);assert.ok(fs.lstatSync(path.join(output,'dangling.md')).isSymbolicLink());
  fs.renameSync(output,output+'-original');fs.symlinkSync(path.join(a.dir,'absent-directory'),output);r.status='uncertain';await assert.rejects(writes.execute(a,j,r),error=>error.requiresInput===true);assert.equal(r.status,'uncertain');assert.equal(fs.existsSync(path.join(a.dir,'absent-directory')),false);
});
