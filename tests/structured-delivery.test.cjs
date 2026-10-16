const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),agent=require('../desktop/agent.cjs'),writes=require('../desktop/agent-writes.cjs'),formats=require('../desktop/delivery-format.cjs');
async function setup(t,content='{"project":"青禾","budget":4800}') {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-structured-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const a=new Assistant({dir,chat:async()=>{throw new Error('文件动作不应调用模型');}});
  await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  const output=path.join(dir,'output');fs.mkdirSync(output);a.data.agentSettings.outputFolder=output;
  const j=agent.buildJob(a,{goal:'交付结构化文件',useOutputFolder:true,fileMode:'auto'});a.data.delegations.push(j);
  const {taskId}=await agent.act(a,j,'plan_task',{key:'file',title:'清单',criteria:'交付实际文件',steps:[{key:'draft',kind:'draft',title:'生成文稿'},{key:'save',kind:'external',tool:'write_file',title:'交付'}]});
  const task=a.task(taskId);task.steps[0].done=true;task.steps[0].artifactId='first-artifact';a.data.artifacts.push({id:'first-artifact',taskId,content});a.save();
  const prepare=args=>writes.prepare(a,j,'write_file',{taskId,...args});
  const revise=next=>{const id=`artifact-${a.data.artifacts.length+1}`;task.steps[0].artifactId=id;task.steps[1].done=false;a.data.artifacts.push({id,taskId,content:next});};
  return {a,j,task,output,prepare,revise};
}
test('JSON and TXT deliver exact current content, format metadata, history and verified evidence',async t=>{
  const {a,j,task,output,prepare}=await setup(t);const json=await prepare({filename:'青禾.json'});assert.equal(json.fileFormat,'json');
  const r=await writes.execute(a,j,json);assert.equal(r.format,'json');assert.equal(path.extname(r.path),'.json');assert.deepEqual(JSON.parse(fs.readFileSync(r.latestPath,'utf8')),{project:'青禾',budget:4800});assert.equal(task.steps[1].done,true);await writes.verifyDelivery(a,j,task);
  const same=await prepare({filename:'青禾.json',format:'json'});assert.equal(same.id,json.id);
  const txt=await prepare({filename:'青禾.txt'});assert.notEqual(txt.id,json.id);await writes.execute(a,j,txt);assert.equal(fs.readFileSync(path.join(output,'青禾.txt'),'utf8'),json.content);
});
test('Omitted names inherit JSON through restart and a changed format selects a fresh default target',async t=>{
  const {a,j,task,prepare,revise}=await setup(t);const r=await prepare({filename:'results.json'});await writes.execute(a,j,r);revise('{"version":2}');a.save();
  const b=new Assistant({dir:a.dir}),job=b.data.delegations[0];job.status='ready';const next=await writes.prepare(b,job,'write_file',{taskId:task.id});assert.equal(next.latestName,'results.json');assert.equal(next.fileFormat,'json');await writes.execute(b,job,next);
  const txt=await writes.prepare(b,job,'write_file',{taskId:task.id,format:'txt'});assert.equal(txt.latestName,`行知-${task.id.slice(0,8)}-最新.txt`);assert.notEqual(txt.key,next.key);
});
test('Default Markdown remains compatible and format mismatch or unsupported formats prepare nothing',async t=>{
  const {a,output,prepare}=await setup(t);const md=await prepare();assert.equal(md.fileFormat,'md');assert.ok(md.target.endsWith('.md'));a.data.agentActions=[];
  for(const args of [{filename:'data.json',format:'csv'},{format:'JSON'},{format:null},{format:12},{filename:'data.xlsx'},{filename:'data.json/evil'},{filename:'NUL.csv'},{filename:'../data.csv'}])await assert.rejects(prepare(args));
  assert.deepEqual(a.data.agentActions,[]);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Invalid JSON is rejected without stripping fences or writing any bytes',async t=>{
  const {a,output,prepare}=await setup(t);for(const content of ['```json\n{"x":1}\n```','{"x":1,}','说明 {"x":1}','{"x":undefined}','{"x":NaN}']) {a.data.artifacts[0].content=content;await assert.rejects(prepare({format:'json'}),/JSON/);}
  assert.deepEqual(a.data.agentActions,[]);assert.deepEqual(fs.readdirSync(output),[]);
});
test('CSV preserves quotes, multiline fields, commas, normal signed numbers and exact bytes',async t=>{
  const content='项目,备注,金额\r\n青禾,"引用 ""原话""，含逗号,和\r\n换行",-12.50\r\n白鹭,调整,+1e3\r\n';
  assert.deepEqual(formats.validate(content,'csv'),{format:'csv',rows:3,columns:3});const {a,j,task,prepare}=await setup(t,content);const r=await prepare({filename:'records.CSV'});await writes.execute(a,j,r);assert.equal(fs.readFileSync(r.result.latestPath,'utf8'),content);await writes.verifyDelivery(a,j,task);
});
test('CSV malformed quotes, uneven rows and executable formulas fail before actions are persisted',async t=>{
  const {a,output,prepare}=await setup(t);
  for(const content of ['a,b\n1','a,b\n"abc,1','a,b\nabc"def,1','a,b\n"abc" x,1','a,b\n1,2,3','a,b\n=1+1,2','a,b\n"\t=SUM(1)",2','a,b\n@SUM(1),2','a,b\n-1+2,2','a,b\n+cmd,2','a,b\n1,\u0000','a,b\r1,2']){a.data.artifacts[0].content=content;await assert.rejects(prepare({format:'csv'}),/CSV/);}
  assert.deepEqual(a.data.agentActions,[]);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Format changes do not inherit approval even for the same artifact',async t=>{
  const {a,j,task,output}=await setup(t);const before=structuredClone(j);j.fileMode='ask';require('../desktop/access-policy-store.cjs').syncTrustedJob(a,j,{before,trusted:true,actor:'user_command',command:'test change file policy'});await agent.act(a,j,'write_file',{taskId:task.id,format:'json'});const first=a.data.agentActions[0];await a.dispatch('agentApprove',{id:j.id,actionId:first.id,version:first.version});
  await agent.act(a,j,'write_file',{taskId:task.id,format:'txt'});const second=a.data.agentActions.at(-1);assert.notEqual(second.id,first.id);assert.equal(second.approvedAt,undefined);await assert.rejects(writes.execute(a,j,second),/确认/);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Prepared content mutation, current artifact replacement and revoked scope prevent execution',async t=>{
  const {a,j,output,prepare,revise}=await setup(t);const r=await prepare({format:'json'});r.content='{"different":true}';await assert.rejects(writes.execute(a,j,r),/不一致/);r.content=a.data.artifacts[0].content;revise('{"version":2}');await assert.rejects(writes.execute(a,j,r),/不一致/);assert.deepEqual(fs.readdirSync(output),[]);
  const fresh=await prepare({format:'json'});j.fileMode='off';await assert.rejects(writes.execute(a,j,fresh),/未允许/);assert.deepEqual(fs.readdirSync(output),[]);
});
test('Edited or missing structured files fail current verification and uncertain retries stay read-only',async t=>{
  const {a,j,task,prepare}=await setup(t);const r=await prepare({filename:'result.json'});await writes.execute(a,j,r);fs.writeFileSync(r.result.latestPath,'{"human":true}');await assert.rejects(writes.verifyDelivery(a,j,task),/修改/);
  r.status='uncertain';await assert.rejects(writes.execute(a,j,r),e=>e.requiresInput===true);assert.equal(fs.readFileSync(r.result.latestPath,'utf8'),'{"human":true}');
  fs.unlinkSync(r.result.latestPath);await assert.rejects(writes.execute(a,j,r),e=>e.requiresInput===true);assert.equal(fs.existsSync(r.result.latestPath),false);
});
test('Historical uncertain structured writes can reconcile without marking a newer draft delivered',async t=>{
  const {a,j,task,prepare,revise}=await setup(t);const r=await prepare({format:'json'});await writes.execute(a,j,r);revise('{"version":2}');r.status='uncertain';await writes.execute(a,j,r);assert.equal(r.status,'done');assert.equal(task.steps[1].done,false);await assert.rejects(writes.verifyDelivery(a,j,task),/尚未保存/);
});
test('Structured output preserves user files and latest edits across versions',async t=>{
  const {a,j,output,prepare,revise}=await setup(t);fs.writeFileSync(path.join(output,'mine.json'),'{}');await assert.rejects(prepare({filename:'mine.json'}),e=>e.conflict);const r=await prepare({filename:'result.json'});await writes.execute(a,j,r);fs.writeFileSync(r.result.latestPath,'{"human":true}');revise('{"version":2}');await assert.rejects(writes.execute(a,j,await prepare()),e=>e.conflict);assert.equal(fs.readFileSync(r.result.latestPath,'utf8'),'{"human":true}');
});
test('Structured filename reservations protect other tasks and authorization changes prevent writes',async t=>{
  const {a,j,task,output,prepare}=await setup(t);const r=await prepare({filename:'Records.json'});const {taskId}=await agent.act(a,j,'plan_task',{key:'other',title:'other',criteria:'save',steps:[{key:'draft',kind:'draft',title:'draft'}]});const other=a.task(taskId);other.steps[0].done=true;other.steps[0].artifactId='other-json';a.data.artifacts.push({id:'other-json',taskId,content:'{}'});
  await assert.rejects(writes.prepare(a,j,'write_file',{taskId,filename:'records.JSON'}),e=>e.conflict);const changed=path.join(a.dir,'changed');fs.mkdirSync(changed);j.outputFolder=changed;await assert.rejects(writes.execute(a,j,r),/授权范围/);assert.deepEqual(fs.readdirSync(output),[]);assert.deepEqual(fs.readdirSync(changed),[]);
});
test('A rejected JSON draft is returned to the planner and corrected before any file is written',async t=>{
  const {a,j,task,output}=await setup(t,'```json\n{"budget":4800}\n```');j.maxActions=8;let index=0,sawError=false;
  a.chat=async(_p,_k,m)=>{
    const context=JSON.parse(m[1].content);
    if(m[0].content.includes('动作格式')){
      const commands=[['write_file',{taskId:task.id,filename:'qinghe.json'}],['revise_task',{taskId:task.id,note:'输出合法JSON正文，去掉围栏'}],['advance_task',{taskId:task.id}],['write_file',{taskId:task.id,filename:'qinghe.json'}],['advance_task',{taskId:task.id}],['complete',{summary:'JSON已验收'}]];
      if(index===1){assert.deepEqual(fs.readdirSync(output),[]);assert.equal(a.data.agentActions.length,0);assert.ok(context.recentActions.some(r=>r.error?.includes('JSON')));sawError=true;}
      const next=commands[index++];if(!next)throw new Error('意外的额外规划');return {tool:next[0],args:next[1],reason:'测试格式修复'};
    }
    if(m[0].content.includes('推进给定事项'))return {kind:'artifact',title:'修订JSON',content:'{"budget":4800}'};
    return {passed:true,summary:'符合要求',gaps:[]};
  };
  await a.dispatch('agentRun',{id:j.id});await a.runPromise;assert.equal(sawError,true);assert.equal(j.status,'completed',j.lastError);assert.equal(a.data.agentActions.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'qinghe.json'),'utf8')),{budget:4800});
});
