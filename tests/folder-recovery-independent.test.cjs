const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),folders=require('../desktop/folders.cjs'),projects=require('../desktop/projects.cjs'),recovery=require('../desktop/recovery.cjs');
async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-folder-independent-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const input=path.join(dir,'input');fs.mkdirSync(input);
  const a=new Assistant({dir:path.join(dir,'workspace'),chat:async()=>{throw new Error('不应调用模型');}});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid'});await a.dispatch('projectSave',{name:'目录项目'});const p=a.data.projects[0];
  a.data.folders.push({id:'folder',name:'目录',path:input,projectId:p.id,enabled:true});const j=agent.buildJob(a,{projectId:p.id,goal:'维护当前目录资料',allowWeb:false,fileMode:'off'});a.data.delegations.push(j);p.jobId=j.id;j.status='paused';
  const write=content=>fs.writeFileSync(path.join(input,'requirements.md'),content),sync=()=>folders.syncAllFolders(a);return{a,p,j,input,write,sync};
}
test('Restoring an older backup and rescanning an unchanged folder reattaches the actual current version',async t=>{
  const {a,p,j,write,sync}=await setup(t);write('第一版预算4800');await sync();const old=a.data.sources[0],backup=recovery.create(a);write('第二版预算5200');await sync();const current=a.data.sources[0];assert.ok(j.sourceIds.includes(current.id));
  await a.dispatch('backupRestore',{id:backup});const restored=a.data.delegations.find(v=>v.id===j.id);assert.equal(restored.status,'paused');assert.ok(a.data.sources.some(s=>s.id===current.id));await sync();
  assert.ok(restored.sourceIds.includes(current.id),'无变化同步仍需将保留的新版本关联回恢复后的委托');assert.equal(restored.status,'paused');const context=agent.context(a,restored);assert.equal(context.sources.some(s=>s.id===old.id),false);assert.ok(context.historyCatalog.some(s=>s.id===old.id));assert.equal(context.sources.find(s=>s.id===current.id)?.current,true);assert.equal(a.data.sources.length,2);
});
test('Restored directory deletion remains unavailable after a no-change rescan',async t=>{
  const {a,j,input,write,sync}=await setup(t);write('历史确认已交付');await sync();const old=a.data.sources[0],backup=recovery.create(a);fs.unlinkSync(path.join(input,'requirements.md'));await sync();const deleted=a.data.sources[0];assert.equal(deleted.deleted,true);
  await a.dispatch('backupRestore',{id:backup});await sync();const restored=a.data.delegations.find(v=>v.id===j.id);assert.ok(restored.sourceIds.includes(deleted.id));const context=agent.context(a,restored);assert.equal(context.sources.some(s=>s.id===old.id),false);assert.ok(context.historyCatalog.some(s=>s.id===old.id));assert.equal(context.sources.some(s=>s.id===deleted.id),false);assert.equal(a.data.sources.length,2);
});
test('Directory reattachment after restore waits for uncertain external evidence without changing source IDs',async t=>{
  const {a,j,write,sync}=await setup(t);write('旧内容');await sync();const backup=recovery.create(a);write('新内容');await sync();const current=a.data.sources[0];a.data.agentActions.push({id:'unknown-write',jobId:j.id,status:'uncertain',tool:'write_file'});a.save();await a.dispatch('backupRestore',{id:backup});
  const restored=a.data.delegations.find(v=>v.id===j.id),before=[...restored.sourceIds];await sync();assert.deepEqual(restored.sourceIds,before);assert.equal(restored.pendingActionId,'unknown-write');assert.equal(a.data.agentActions.find(r=>r.id==='unknown-write').status,'uncertain');
  a.data.agentActions.find(r=>r.id==='unknown-write').status='done';restored.pendingActionId=null;await sync();assert.ok(restored.sourceIds.includes(current.id));assert.equal(restored.status,'paused');
});
test('A revoked folder grant is retained across restore and no scan reauthorizes it',async t=>{
  const {a,write,sync}=await setup(t);write('保留历史');await sync();const backup=recovery.create(a);await a.dispatch('folderRemove',{id:'folder'});await a.dispatch('backupRestore',{id:backup});assert.equal(a.data.folders.length,0);await sync();assert.equal(a.data.folders.length,0);assert.equal(a.data.sources.length,1);
});
test('Copying a folder source to another project cannot hide deletion in the original project',async t=>{
  const {a,p,input,write,sync}=await setup(t);write('项目原始材料');await sync();const original=a.data.sources[0];await a.dispatch('projectSave',{name:'另一个项目'});const other=a.data.projects[0];await a.dispatch('projectAttach',{id:other.id,sourceIds:[original.id]});const copy=a.data.sources.find(s=>s.copiedFrom===original.id);assert.ok(copy);
  fs.unlinkSync(path.join(input,'requirements.md'));await sync();const tombstone=a.data.sources.find(s=>s.projectId===p.id&&s.deleted);assert.ok(tombstone,'另一个项目的来源副本不能成为此目录的当前版本');assert.equal(tombstone.previousSourceId,original.id);assert.equal(copy.deleted,undefined);assert.equal(copy.projectId,other.id);
});
