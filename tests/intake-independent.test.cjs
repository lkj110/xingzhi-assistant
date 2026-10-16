const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs'),formats=require('../desktop/delivery-format.cjs');
async function setup(t,chat=async()=>({tasks:[],summary:'done'})){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-intake-independent-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});return a;
}
const capture=(a,input={})=>a.dispatch('captureSave',{organize:true,textItems:[{title:'独立资料',content:'本次独立内容'}],...input});
const generated=(id,title,extra={})=>({title,criteria:'有据可查',sourceIds:[id],steps:[{title:'形成文稿',kind:'draft'}],...extra});
test('Independent capture ignores model-supplied project scope before applying any task',async t=>{
  const a=await setup(t,async(p,k,m)=>{const id=JSON.parse(m[1].content).sources[0].id;return {tasks:[generated(id,'第一项'),generated(id,'第二项',{projectId:'nonexistent'})]};});
  await capture(a);await a.runPromise;assert.equal(a.data.tasks.length,2);assert.ok(a.data.tasks.every(t=>!t.projectId));assert.equal(a.data.sources[0].state,'processed');
});
test('A model cannot attach a newly captured independent task to an existing private project',async t=>{
  const a=await setup(t,async(p,k,m)=>({tasks:[generated(JSON.parse(m[1].content).sources[0].id,'独立事项',{projectId:'private-project'})]}));a.data.projects.push({id:'private-project',name:'别的项目'});
  await capture(a);await a.runPromise;assert.equal(a.data.tasks.length,1);assert.equal(a.data.tasks[0].projectId,null);
});
test('Failure in a later extraction batch preserves earlier completed material and all later sources',async t=>{
  let calls=0;const a=await setup(t,async()=>{if(++calls===2)throw new Error('第二批服务不可用');return {tasks:[],summary:'首批完成'};});
  const files=Array.from({length:10},(_,i)=>({title:`material-${i}.txt`,base64:Buffer.from(`材料 ${i}`).toString('base64')}));
  await capture(a,{items:files});await a.runPromise;assert.equal(a.data.sources.length,11);assert.equal(a.data.sources.filter(s=>s.state==='processed').length,6);assert.equal(a.data.sources.filter(s=>s.state==='new').length,5);assert.equal(a.operation,null);
});
test('Stopping a later capture batch preserves all material and the first batch progress across restart',async t=>{
  let calls=0,entered;const second=new Promise(resolve=>entered=resolve);const a=await setup(t,async(p,k,m,o)=>{if(++calls===1)return {tasks:[],summary:'首批完成'};entered();return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('已停止本轮整理')),{once:true}));});
  const files=Array.from({length:7},(_,i)=>({title:`stop-${i}.txt`,base64:Buffer.from(`取消前材料 ${i}`).toString('base64')}));await capture(a,{items:files});await second;a.stop();await a.runPromise;
  const b=new Assistant({dir:a.dir});assert.equal(b.data.sources.length,8);assert.equal(b.data.sources.filter(s=>s.state==='processed').length,6);assert.equal(b.data.sources.filter(s=>s.state==='new').length,2);assert.equal(b.operation,null);
});
test('Restoring a pre-capture backup keeps material from both successful and failed batches',async t=>{
  let calls=0;const a=await setup(t,async()=>{if(++calls===2)throw new Error('第二批失败');return {tasks:[],summary:'已整理'};});const before=(await a.dispatch('backupCreate'))[0].id;
  const files=Array.from({length:7},(_,i)=>({title:`restore-${i}.txt`,base64:Buffer.from(`还原前材料 ${i}`).toString('base64')}));await capture(a,{items:files});await a.runPromise;const captured=a.data.sources.map(s=>({id:s.id,content:s.content,state:s.state}));
  await a.dispatch('backupRestore',{id:before});for(const saved of captured)assert.deepEqual({id:a.data.sources.find(s=>s.id===saved.id)?.id,content:a.data.sources.find(s=>s.id===saved.id)?.content,state:a.data.sources.find(s=>s.id===saved.id)?.state},saved);assert.equal(a.data.stewardship.paused,true);assert.equal(a.operation,null);
});
test('Undoing project capture retains the new material as excluded history and keeps the job paused',async t=>{
  const a=await setup(t);await a.dispatch('projectSave',{name:'会议项目'});const p=a.data.projects[0],j=agent.buildJob(a,{goal:'跟进会议',projectId:p.id});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;
  await capture(a,{projectId:p.id,textItems:[{title:'会议记录',content:'原计划周一',origin:'手动输入'}]});const first=a.data.sources[0];await capture(a,{projectId:p.id,textItems:[{title:'会议记录',content:'新计划周五',origin:'手动输入'}]});const added=a.data.sources[0],latest=a.data.projectChanges[0];
  await a.dispatch('projectUndo',{id:p.id,changeId:latest.id});assert.equal(a.data.sources.find(s=>s.id===added.id).content,'新计划周五');assert.equal(a.data.sources.find(s=>s.id===added.id).projectExcluded,true);assert.ok(j.sourceIds.includes(first.id));assert.ok(!j.sourceIds.includes(added.id));assert.equal(j.status,'paused');
  const history=await a.dispatch('librarySearch',{query:'新计划周五',projectId:p.id,history:true});assert.ok(history.items.some(s=>s.id===added.id));
});
test('Saving a capture without organizer never requires the role or reprocesses unrelated sources',async t=>{
  const a=await setup(t,async()=>{throw new Error('不应调用');});a.data.settings.roles.organize='';await a.dispatch('import',{items:[{title:'旧材料',content:'保留旧材料'}]});
  await capture(a,{organize:false});assert.equal(a.data.sources.length,2);assert.ok(a.data.sources.every(s=>s.state==='new'));assert.equal(a.data.modelCalls?.length || 0,0);
});
test('Project capture cannot consume a pending write approval and arbitrary mixed file failure stays atomic',async t=>{
  const a=await setup(t),j=agent.buildJob(a,{goal:'维护项目',projectId:'p'});a.data.projects.push({id:'p',name:'项目',jobId:j.id});a.data.delegations.push(j);j.pendingActionId='write';a.data.agentActions.push({id:'write',jobId:j.id,status:'uncertain'});
  await assert.rejects(capture(a,{projectId:'p'}),/外部动作/);assert.equal(a.data.sources.length,0);assert.equal(j.pendingActionId,'write');
  await assert.rejects(capture(a,{items:[{title:'first.txt',base64:Buffer.from('已解析内容').toString('base64')},{title:'broken.pdf',base64:Buffer.from('not pdf').toString('base64')}]}));assert.equal(a.data.sources.length,0);assert.equal(a.operation,null);
});
test('CSV formula detection covers all columns, quoted line breaks, Unicode leading whitespace and separators',()=>{
  for(const content of ['a,b\ntext,"\n=1+1"','a,b\ntext,\uFEFF@SUM(1)','a,b\ntext,\u00a0+CMD(1)','a,b\ntext,"-1+1"','a,b\ntext,"a""b"x'])assert.throws(()=>formats.validate(content,'csv'));
  assert.deepEqual(formats.validate('a,b\n"x,y","one\ntwo"\n"quote ""inside""",-12.50','csv'),{format:'csv',rows:3,columns:2});
});
test('Structured format choice is preserved after approving and reloading before actual execution',async t=>{
  const a=await setup(t),out=path.join(a.dir,'out');fs.mkdirSync(out);a.data.agentSettings.outputFolder=out;const j=agent.buildJob(a,{goal:'交付CSV',useOutputFolder:true,fileMode:'ask'});a.data.delegations.push(j);
  const planned=await agent.act(a,j,'plan_task',{key:'table',title:'表格',criteria:'保存CSV',steps:[{key:'draft',title:'生成CSV',kind:'draft'},{key:'save',title:'保存CSV',kind:'external',tool:'write_file'}]});const t1=a.task(planned.taskId);t1.steps[0].done=true;t1.steps[0].artifactId='csv';a.data.artifacts.push({id:'csv',taskId:t1.id,content:'名称,数量\n材料,2'});
  await agent.act(a,j,'write_file',{taskId:t1.id,filename:'核对清单.csv'});const r=a.data.agentActions[0];await a.dispatch('agentApprove',{id:j.id,actionId:r.id,version:r.version});
  const b=new Assistant({dir:a.dir});const restored=b.data.delegations.find(v=>v.id===j.id),record=b.data.agentActions.find(v=>v.id===r.id);const result=await writes.execute(b,restored,record);assert.equal(result.format,'csv');assert.equal(fs.readFileSync(result.latestPath,'utf8'),'名称,数量\n材料,2');assert.equal(b.data.agentActions.length,1);
});
