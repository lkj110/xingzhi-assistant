const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const capture=require('../desktop/capture.cjs');
async function setup(t,chat) {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-queue-independent-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:chat||(async()=>({tasks:[]}))});return {a,dir};
}
const text=(title='交叉审材料',content='需要处理的新要求')=>({textItems:[{title,content}]});
const payloadDir=a=>path.join(a.dir,'capture-payloads');
const busy=a=>{a.operation={label:'已有操作'};a.controller=new AbortController();};
async function drain(a){a.operation=null;a.controller=null;assert.equal(capture.tick(a),true);await a.runPromise;}

test('Independent review: restoring a pre-organization backup retains new evidence on an existing task',async t=>{
  let taskId;const {a}=await setup(t,async(p,k,m)=>{const input=JSON.parse(m[1].content);return {tasks:[{existingTaskId:taskId,title:'已有独立事项',sourceIds:input.sources.map(s=>s.id),description:'加入新的日期要求'}]};});
  const original=a.createTask({title:'已有独立事项',criteria:'按资料完成'});taskId=original.id;original.status='review';original.verification={passed:true};original.steps=[{id:'old-step',title:'写作',kind:'draft',done:true,artifactId:'old-artifact'}];a.data.artifacts.push({id:'old-artifact',taskId,content:'旧产出'});a.save();
  await a.dispatch('captureEnqueue',{...text(),organize:true});await a.runPromise;assert.equal(a.data.captureQueue[0].status,'failed');const backup=(await a.dispatch('backupCreate')).find(b=>b.reason==='manual').id;
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('captureRetry',{id:a.data.captureQueue[0].id});await a.runPromise;const sourceId=a.data.captureQueue[0].sourceIds[0];assert.ok(a.data.tasks.find(t=>t.id===taskId).sourceIds.includes(sourceId));
  await a.dispatch('backupRestore',{id:backup});const restored=a.data.tasks.find(t=>t.id===taskId);
  assert.ok(restored.sourceIds.includes(sourceId),'newly captured context must remain attached after an older plan is restored');assert.equal(a.data.captureQueue[0].status,'completed');assert.equal(a.data.sources.find(s=>s.id===sourceId).state,'processed');assert.equal(restored.status,'blocked');assert.notEqual(restored.verification?.passed,true);assert.ok(restored.needsReplan);assert.equal(restored.steps[0].done,false);assert.ok(a.data.artifacts.some(r=>r.id==='old-artifact'));
});
test('Independent review: failed payload write leaves no private orphan or durable queue receipt',async t=>{
  const {a}=await setup(t);busy(a);const write=fs.writeFileSync;let injected=false;
  fs.writeFileSync=function(file,body,...args){if(typeof file==='number'&&typeof body==='string'&&body.includes('"textItems"')&&!injected){injected=true;write.call(fs,file,body.slice(0,15),...args);throw new Error('fixture ENOSPC');}return write.call(fs,file,body,...args);};
  try {await assert.rejects(a.dispatch('captureEnqueue',text()),/ENOSPC/);}finally{fs.writeFileSync=write;}
  assert.equal(injected,true);assert.equal(a.data.captureQueue.length,0);assert.deepEqual(fs.readdirSync(payloadDir(a)),[]);assert.equal(JSON.parse(fs.readFileSync(a.file)).captureQueue.length,0);
});
test('Independent review: failed payload fsync leaves no private orphan',async t=>{
  const {a}=await setup(t);busy(a);const sync=fs.fsyncSync;let injected=false;
  fs.fsyncSync=function(fd){if(!injected){injected=true;throw new Error('fixture sync failure');}return sync.call(fs,fd);};
  try {await assert.rejects(a.dispatch('captureEnqueue',text()),/sync failure/);}finally{fs.fsyncSync=sync;}
  assert.equal(a.data.captureQueue.length,0);assert.deepEqual(fs.readdirSync(payloadDir(a)),[]);
});
test('Independent review: a corrupt first payload does not prevent later valid queue work',async t=>{
  const {a}=await setup(t);busy(a);await a.dispatch('captureEnqueue',text('坏材料','第一份'));await a.dispatch('captureEnqueue',text('好材料','第二份'));const first=a.data.captureQueue[0],second=a.data.captureQueue[1];fs.writeFileSync(path.join(payloadDir(a),first.id+'.json'),'{}');
  await drain(a);assert.equal(first.status,'failed');assert.equal(second.status,'queued');assert.equal(a.data.sources.length,0);await drain(a);assert.equal(second.status,'completed');assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].title,'好材料');
});
test('Independent review: cancellation while parsing leaves no half-imported mixed batch',async t=>{
  const {a}=await setup(t);const documents=require('../desktop/documents.cjs'),parse=documents.parse;let entered,release;const started=new Promise(r=>entered=r);documents.parse=async(name,buffer,signal)=>{entered();await new Promise(r=>release=r);signal.throwIfAborted();return {title:name,content:buffer.toString(),segments:[{text:buffer.toString()}]};};
  try {await a.dispatch('captureEnqueue',{items:[{title:'queued.txt',base64:Buffer.from('原始正文').toString('base64')}],...text()});await started;const row=a.data.captureQueue[0];await a.dispatch('captureCancel',{id:row.id});release();await a.runPromise;assert.equal(row.status,'cancelled');assert.equal(a.data.sources.length,0);assert.equal(row.importedAt,undefined);assert.deepEqual(fs.readdirSync(payloadDir(a)),[]);}finally{documents.parse=parse;}
});
test('Independent review: post-import retries do not depend on or reread a removed payload',async t=>{
  const {a}=await setup(t);await a.dispatch('captureEnqueue',{...text(),organize:true});await a.runPromise;const row=a.data.captureQueue[0],sourceId=row.sourceIds[0];assert.equal(row.status,'failed');assert.ok(row.importedAt);assert.deepEqual(fs.readdirSync(payloadDir(a)),[]);
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});fs.writeFileSync(path.join(payloadDir(a),row.id+'.json'),'MALICIOUS_REPLACEMENT');await a.dispatch('captureRetry',{id:row.id});await a.runPromise;assert.equal(row.status,'completed');assert.deepEqual(row.sourceIds,[sourceId]);assert.equal(a.data.sources.length,1);assert.ok(!JSON.stringify(a.data.sources).includes('MALICIOUS'));assert.deepEqual(fs.readdirSync(payloadDir(a)),[]);
});
test('Independent review: queue receipt restart does not reinstate a cancelled project import',async t=>{
  const {a,dir}=await setup(t);await a.dispatch('projectSave',{name:'临时项目'});const projectId=a.data.projects[0].id;busy(a);await a.dispatch('captureEnqueue',{...text(),projectId});const row=a.data.captureQueue[0];await a.dispatch('captureCancel',{id:row.id});const b=new Assistant({dir});assert.equal(b.data.captureQueue[0].status,'cancelled');assert.equal(capture.tick(b),false);assert.equal(b.data.sources.length,0);
});
test('Independent review: project imports never grant or resume a paused project job',async t=>{
  const {a}=await setup(t);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});await a.dispatch('projectSave',{name:'暂停项目'});const p=a.data.projects[0],job=require('../desktop/agent.cjs').buildJob(a,{projectId:p.id,goal:'推进项目'});job.status='paused';job.fileMode='off';job.githubMode='off';a.data.delegations.push(job);p.jobId=job.id;
  await a.dispatch('captureEnqueue',{...text(),projectId:p.id,organize:true});await a.runPromise;assert.equal(a.data.captureQueue[0].status,'completed');assert.equal(job.status,'paused');assert.equal(job.fileMode,'off');assert.equal(job.githubMode,'off');assert.equal(a.data.modelCalls?.length||0,0);assert.ok(job.sourceIds.includes(a.data.sources[0].id));
});
