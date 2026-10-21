const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const folders=require('../desktop/folders.cjs');
const agent=require('../desktop/agent.cjs');
const projects=require('../desktop/projects.cjs');
const documents=require('../desktop/documents.cjs');
async function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-folders-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=path.join(root,'input');fs.mkdirSync(input);const a=new Assistant({dir:path.join(root,'workspace'),chat:async()=>{throw new Error('unexpected model call');}});
  a.data.folders.push({id:'folder',name:'资料',path:input});a.save();
  const write=(name,content)=>fs.writeFileSync(path.join(input,name),content);
  const sync=()=>folders.syncAllFolders(a);
  const project=async(name='甲项目')=>{await a.dispatch('projectSave',{name});return a.data.projects[0];};
  const bind=async(projectId,enabled=true)=>folders.dispatch(a,'folderConfigure',{id:'folder',name:'资料',projectId,enabled});
  async function job(p){await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',type:'ollama',baseUrl:'http://127.0.0.1:9',model:'fake'});const j=agent.buildJob(a,{projectId:p.id,goal:'整理项目',allowWeb:false,fileMode:'off',githubMode:'off'});a.data.delegations.unshift(j);p.jobId=j.id;projects.ingest(a,p);return j;}
  return {a,input,write,sync,project,bind,job,folder:a.data.folders[0]};
}

test('Legacy folders remain enabled and repeated text sync preserves one identity',async t=>{
  const {a,write,folder}=await setup(t);write('note.md','第一版');assert.equal(folders.syncFolders(a),1);assert.equal(folders.syncFolders(a),0);assert.equal(folder.enabled,true);assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].folderId,'folder');assert.equal(a.data.sources[0].fileName,'note.md');assert.match(a.data.sources[0].identity,/^folder:/);
});
test('Same-content files and same-content sources in other scopes stay distinct',async t=>{
  const {a,write,sync,project,bind}=await setup(t);const p=await project();await a.dispatch('import',{items:[{title:'手动材料',content:'相同正文',projectId:p.id}]});write('a.md','相同正文');write('b.md','相同正文');await sync();assert.equal(a.data.sources.length,3);await bind(p.id);await sync();assert.equal(a.data.sources.length,5);assert.equal(a.data.sources.filter(s=>s.projectId===p.id).length,3);
});
test('A→B→A creates three versions, not a duplicate of a historical source',async t=>{
  const {a,write,sync}=await setup(t);for(const value of ['甲','乙','甲']){write('brief.md',value);await sync();}const rows=a.data.sources;assert.equal(rows.length,3);assert.equal(rows[0].version,3);assert.equal(rows[0].previousSourceId,rows[1].id);assert.equal(rows[1].previousSourceId,rows[2].id);await sync();assert.equal(a.data.sources.length,3);
});
test('Project binding preserves source isolation and wakes only the existing project job',async t=>{
  const {a,write,sync,project,bind,job}=await setup(t);const p=await project();await bind(p.id);const j=await job(p);j.status='completed';write('brief.md','发布材料');await sync();assert.equal(a.data.delegations.length,1);assert.equal(j.status,'ready');assert.equal(j.sourceIds[0],a.data.sources[0].id);assert.equal(a.data.sources[0].state,'processed');assert.equal(a.data.sources[0].projectId,p.id);
});
test('Rebinding a folder never moves old project evidence',async t=>{
  const {a,write,sync,project,bind}=await setup(t);const p=await project('甲'),q=await project('乙');write('brief.md','材料');await bind(p.id);await sync();const first=a.data.sources[0];await bind(q.id);await sync();assert.equal(a.data.sources.length,2);assert.equal(first.projectId,p.id);assert.equal(a.data.sources[0].projectId,q.id);assert.notEqual(first.identity,a.data.sources[0].identity);await bind(p.id);await sync();assert.equal(a.data.sources.length,2);
});
test('Paused folder skips background scan, explicit sync runs once without enabling it',async t=>{
  const {a,write,sync,bind,folder}=await setup(t);write('brief.md','材料');await bind(null,false);await sync();assert.equal(a.data.sources.length,0);await folders.dispatch(a,'folderSync',{id:'folder'});assert.equal(a.data.sources.length,1);assert.equal(folder.enabled,false);await folders.dispatch(a,'folderToggle',{id:'folder',enabled:true});assert.equal(folder.enabled,true);
});
test('A paused project remains paused on new versions',async t=>{
  const {a,write,sync,project,bind,job}=await setup(t);const p=await project();await bind(p.id);const j=await job(p);j.status='paused';write('brief.md','第一版');await sync();write('brief.md','第二版');await sync();assert.equal(j.status,'paused');assert.equal(a.data.sources.length,2);
});
test('Uncertain external action prevents both import and deletion until reconciled',async t=>{
  const {a,write,sync,project,bind,job,input,folder}=await setup(t);const p=await project();await bind(p.id);const j=await job(p);write('a.md','第一版');await sync();a.data.agentActions.push({id:'uncertain',jobId:j.id,status:'uncertain',tool:'write_file'});fs.unlinkSync(path.join(input,'a.md'));write('b.md','新材料');await sync();assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].deleted,undefined);assert.match(folder.error,/外部动作待核对/);a.data.agentActions=[];await sync();assert.equal(a.data.sources.length,3);assert.equal(a.data.sources.filter(s=>s.deleted).length,1);
});
test('Complete scan creates one deletion tombstone, retains original content, and reappearance creates a new version',async t=>{
  const {a,write,sync,input}=await setup(t);write('a.md','原文');await sync();const original=a.data.sources[0];fs.unlinkSync(path.join(input,'a.md'));await sync();const tombstone=a.data.sources[0];assert.equal(tombstone.deleted,true);assert.equal(tombstone.content,'原文');assert.equal(tombstone.previousSourceId,original.id);assert.equal(original.deleted,undefined);await sync();assert.equal(a.data.sources.length,2);write('a.md','原文');await sync();assert.equal(a.data.sources[0].version,3);assert.equal(a.data.sources[0].deleted,undefined);assert.equal(a.data.sources[0].previousSourceId,tombstone.id);
});
test('A missing directory is an error and never a deletion',async t=>{
  const {a,write,sync,input,folder}=await setup(t);write('a.md','正文');await sync();fs.renameSync(input,input+'-away');await sync();assert.equal(a.data.sources.length,1);assert.equal(folder.health,'error');assert.equal(folder.stats.complete,false);
});
test('Any invalid file suppresses deletion inference but valid files still import',async t=>{
  const {a,write,sync,input,folder}=await setup(t);write('old.md','原文');await sync();fs.unlinkSync(path.join(input,'old.md'));write('bad.pdf','not a pdf');write('good.md','新文');await sync();assert.equal(a.data.sources.length,2);assert.equal(a.data.sources.some(s=>s.deleted),false);assert.match(folder.error,/bad.pdf/);assert.equal(folder.stats.complete,false);
});
test('A single 100-file cap covers mixed document formats, does not delete hidden overflow',async t=>{
  const {a,write,sync,input,folder}=await setup(t);write('z.md','原文');await sync();fs.unlinkSync(path.join(input,'z.md'));for(let i=0;i<101;i++)write(`a${String(i).padStart(3,'0')}.md`,'正文'+i);await sync();assert.equal(folder.stats.checked,100);assert.equal(a.data.sources.length,101);assert.equal(a.data.sources.some(s=>s.deleted),false);assert.match(folder.warnings[0],/101/);
});
test('Symlinks and unsupported files are skipped, symlink substitution is not treated as confirmed deletion',async t=>{
  const {a,write,sync,input}=await setup(t);write('a.md','正文');await sync();fs.unlinkSync(path.join(input,'a.md'));write('secret.env','secret');{if(!require('./helpers/symlink.cjs').link(t,path.join(input,'secret.env'),path.join(input,'a.md')))return;}write('.hidden.txt','hidden');fs.mkdirSync(path.join(input,'nested'));write('safe.txt','公开');await sync();assert.equal(a.data.sources.length,2);assert.equal(a.data.sources.some(s=>s.deleted),false);assert.ok(!a.data.sources.some(s=>s.content.includes('secret')));
});
test('Known generated artifacts and named deliveries are not imported back as source material',async t=>{
  const {a,write,sync,input}=await setup(t);write('行知-1234abcd-最新.md','自动产出');write('交付.md','指定名称产出');write('notes.md','真实材料');a.data.agentActions.push({id:'write',tool:'write_file',status:'done',target:path.join(input,'history.md'),latestName:'交付.md',result:{path:path.join(input,'history.md'),latestPath:path.join(input,'交付.md')}});await sync();assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].title,'notes.md');
});
test('PDF/DOCX content is parsed once, persisted fingerprints avoid repeat parsing after restart',async t=>{
  const {a,input,sync}=await setup(t);for(const name of ['project.pdf','project.docx'])fs.copyFileSync(path.join(__dirname,'fixtures',name),path.join(input,name));await sync();assert.equal(a.data.sources.length,2);assert.ok(a.data.sources.every(s=>s.segments.length));const restarted=new Assistant({dir:a.dir});const original=documents.parse;let calls=0;documents.parse=async()=>{calls++;throw new Error('unchanged docs must not parse');};try{await folders.syncAllFolders(restarted);}finally{documents.parse=original;}assert.equal(calls,0);assert.equal(restarted.data.sources.length,2);assert.equal(restarted.data.folders[0].stats.unchanged,2);
});
test('Interrupted async document parsing imports no partial folder and clears its operation lock',async t=>{
  const {a,write,sync}=await setup(t);write('a.pdf','fixture');let release;const original=documents.parse;documents.parse=()=>new Promise(resolve=>{release=resolve;});try{const pending=sync();assert.ok(a.operation);await assert.rejects(folders.dispatch(a,'folderToggle',{id:'folder',enabled:false}),/正在处理/);a.controller.abort();release({title:'a.pdf',content:'未完整读取',segments:[],format:'pdf'});await assert.rejects(pending);assert.equal(a.data.sources.length,0);assert.equal(a.operation,null);}finally{documents.parse=original;}
});
test('Undo-excluded source stays excluded after file changes until explicitly attached',async t=>{
  const {a,write,sync,project,bind}=await setup(t);const p=await project();await bind(p.id);write('a.md','第一版');await sync();a.data.sources[0].projectExcluded=true;write('a.md','第二版');await sync();assert.equal(a.data.sources.length,1);assert.match(a.data.folders[0].warnings[0],/撤回/);await a.dispatch('projectAttach',{id:p.id,sourceIds:[a.data.sources[0].id]});await sync();assert.equal(a.data.sources.length,2);assert.equal(a.data.sources[0].version,2);
});
test('Updating a source invalidates completed standalone artifacts; paused tasks remain paused',async t=>{
  const {a,write,sync}=await setup(t);write('a.md','第一版');await sync();const id=a.data.sources[0].id;const task=a.createTask({title:'输出',sourceIds:[id],steps:[{title:'写文',kind:'draft'}]}),paused=a.createTask({title:'暂停任务',sourceIds:[id]});task.status='completed';task.verification={passed:true};task.steps[0].done=true;task.steps[0].artifactId='old';paused.status='paused';write('a.md','第二版');await sync();assert.equal(task.status,'blocked');assert.equal(task.verification,null);assert.equal(task.steps[0].done,false);assert.match(task.needsReplan,/更新/);assert.equal(paused.status,'paused');assert.equal(task.sourceIds.length,2);
});
test('Removing a source invalidates standalone tasks and source-backed memory',async t=>{
  const {a,write,sync,input}=await setup(t);write('a.md','确定日期');await sync();const s=a.data.sources[0],task=a.createTask({title:'交付',sourceIds:[s.id]});task.status='completed';task.verification={passed:true};await a.dispatch('memorySave',{title:'日期',content:'确定日期',kind:'fact',sourceId:s.id});fs.unlinkSync(path.join(input,'a.md'));await sync();assert.equal(task.status,'blocked');assert.equal(task.verification,null);assert.match(task.notes.at(-1).text,/移除/);assert.equal(a.publicState().memories[0].effective,false);assert.equal(a.context(task).sources.some(row=>row.content?.includes('确定日期')),false);
});
test('A project update invalidates only tasks referencing changed file and current context recognizes folder source',async t=>{
  const {a,write,sync,project,bind,job}=await setup(t);const p=await project();await bind(p.id);const j=await job(p);write('a.md','预算一');write('b.md','日期一');await sync();const source=name=>a.data.sources.find(s=>s.fileName===name);const ptask=async(name)=>agent.act(a,j,'plan_task',{key:name,title:name,criteria:'按当前资料',sourceIds:[source(name).id],steps:[{key:'draft',title:'成文',kind:'draft'}]});const ta=a.task((await ptask('a.md')).taskId),tb=a.task((await ptask('b.md')).taskId);ta.status=tb.status='completed';ta.verification=tb.verification={passed:true};write('a.md','预算二');await sync();assert.ok(ta.needsReplan);assert.equal(tb.needsReplan,undefined);assert.equal(tb.status,'completed');assert.equal(agent.context(a,j).sources.filter(s=>s.current).length,2);
});
test('Folder removal revokes future reads without deleting imported history; stale settings reject atomically',async t=>{
  const {a,write,sync,folder}=await setup(t);write('a.md','材料');await sync();await assert.rejects(folders.dispatch(a,'folderConfigure',{id:folder.id,projectId:'missing',enabled:true,name:'名称'}),/项目不存在/);assert.equal(folder.name,'资料');await folders.dispatch(a,'folderRemove',{id:folder.id});assert.equal(a.data.folders.length,0);assert.equal(a.data.sources.length,1);await assert.rejects(folders.dispatch(a,'folderSync',{id:folder.id}),/已移除/);
});

test('50 MB limit stops before reading the next file, preserves missing source as unconfirmed',async t=>{
  const {a,write,sync,input,folder}=await setup(t);write('old.md','历史正文');await sync();fs.unlinkSync(path.join(input,'old.md'));
  for(let i=0;i<8;i++){const fd=fs.openSync(path.join(input,`a${i}.txt`),'w');fs.ftruncateSync(fd,10_000_000);fs.closeSync(fd);}
  const original=fs.readFileSync;let bufferReads=0;fs.readFileSync=function(target,...args){if(typeof target==='number')bufferReads++;return original.call(this,target,...args);};
  try{await sync();}finally{fs.readFileSync=original;}
  assert.equal(bufferReads,5);assert.equal(folder.stats.checked,5);assert.equal(folder.stats.complete,false);assert.match(folder.warnings[0],/50 MB/);assert.equal(a.data.sources.length,1);assert.equal(a.data.sources.some(s=>s.deleted),false);
});
test('Equal timestamps preserve exact project version chain including a revert and deletion',async t=>{
  const {a,write,sync,project,bind,job,input}=await setup(t);const p=await project();await bind(p.id);const j=await job(p);
  for(const content of ['甲','乙','甲']){write('a.md',content);await sync();for(const s of a.data.sources)s.createdAt='2026-10-01T00:00:00.000Z';}
  assert.deepEqual(a.data.sources.map(s=>s.version),[3,2,1]);assert.equal(a.data.sources[0].previousSourceId,a.data.sources[1].id);
  fs.unlinkSync(path.join(input,'a.md'));await sync();assert.equal(a.data.sources[0].version,4);assert.equal(a.data.sources[0].previousSourceId,a.data.sources[1].id);assert.equal(j.sourceIds.length,4);
});
test('A restored standalone task catches up across several retained directory versions',async t=>{
  const {a,write,sync}=await setup(t);write('a.md','甲');await sync();const task=a.createTask({title:'文稿',sourceIds:[a.data.sources[0].id]});task.status='completed';task.verification={passed:true};task.steps[0].done=true;a.save();const backup=require('../desktop/recovery.cjs').create(a);
  for(const content of ['乙','丙']){write('a.md',content);await sync();}
  await a.dispatch('backupRestore',{id:backup});assert.equal(a.task(task.id).status,'blocked');await sync();const restored=a.task(task.id);assert.equal(restored.status,'blocked');assert.equal(restored.verification,null);assert.ok(restored.sourceIds.includes(a.data.sources.find(s=>s.content==='丙').id));
});
