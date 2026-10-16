const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const model=require('../desktop/model-context.cjs'),index=require('../desktop/context-index.cjs'),protocol=require('../desktop/task-context.cjs'),agent=require('../desktop/agent.cjs');
const {Assistant}=require('../desktop/core.cjs');
const rows=Array.from({length:600},(_,i)=>({id:'source-'+i,ref:'s:'+i,type:'source',title:'Reference '+i,taskId:'task',purpose:'input',state:i<400?'active':'historical',version:'v'+i,characters:100000,sections:[{title:'chapter '+i,start:0,characters:100000}],readTool:'read_source'}));
test('planner sends a bounded index and exact requirements; every omitted reference stays discoverable',()=>{
 const input={readableCatalog:rows.slice(0,400),historyCatalog:rows.slice(400),sourceCatalog:rows,guard:'guard',executionContract:{text:'全部要求不得删减'},userDirectives:[{text:'保留明确边界'}],tasks:[{id:'task',criteria:'逐项验收',steps:[{key:'next',title:'生成正文'}],sourceIds:rows.map(r=>r.id),artifactHistory:[]}],sources:rows.map(r=>({...r,content:'UNNECESSARY_BODY'.repeat(1000)})),executionControl:{requirements:[{text:'完整验收要求'}],gaps:[{text:'必须补齐事实'}],queryOperations:rows,frontier:rows.map(r=>({...r,status:'queried'})),frontierTotal:600},decisions:[{question:'范围',answer:'使用六个入口',baselineIds:rows.map(r=>r.id)}]};
 const result=model.project(input,{stage:'planner'});
 assert.deepEqual(result.executionContract,input.executionContract);assert.deepEqual(result.userDirectives,input.userDirectives);assert.equal(result.tasks[0].criteria,'逐项验收');assert.deepEqual(result.executionControl.gaps,input.executionControl.gaps);
 assert.equal(result.sourceCatalog.length,24);assert.equal(result.historyCatalog.length,8);assert.equal(result.catalogIndex.current.next,24);assert.equal(result.decisions[0].baselineIds,undefined);assert.doesNotMatch(JSON.stringify(result),/UNNECESSARY_BODY/);
 const found=[];for(let start=0;start!==null;){const page=index.page(input,{start,limit:40});found.push(...page.sources);start=page.next;}
 assert.deepEqual(found.map(r=>r.ref),rows.map(r=>r.ref));assert.equal(index.page(input,{history:true,query:'chapter 599'}).sources[0].ref,'s:599');assert.equal(index.page(input,{history:false,query:'599'}).sources.length,0);
 assert.equal(index.page(input,{ref:'s:599'}).sections[0].title,'chapter 599');assert.ok(JSON.stringify(result).length<JSON.stringify(input).length*.03);
});
test('worker preserves requested exact bodies and current draft; directory is not the full corpus',()=>{
 const input={readableCatalog:rows.slice(0,400),historyCatalog:rows.slice(400),task:{criteria:'全量条件'},workingDraft:{content:'EXACT_DRAFT'},contextReads:[{result:{content:'EXACT_EVIDENCE'}}],artifacts:[{content:'EXACT_ARTIFACT'}]};
 const result=model.project(input,{stage:'task_verify'});for(const k of ['task','workingDraft','contextReads','artifacts'])assert.deepEqual(result[k],input[k]);assert.equal(result.catalogIndex.historical.total,200);
});
test('catalog rejects scope injection and fingerprints distinguish history and refs',()=>{
 assert.throws(()=>index.page({},{jobId:'foreign'}),e=>e.contextFailure);assert.throws(()=>index.page({},{limit:1000}),e=>e.contextFailure);
 const reg=require('../desktop/tool-registry.cjs');assert.deepEqual(reg.parameters('read_source',{ref:'s:1',history:true,start:6}),{ref:'s:1',start:6,history:true});
});
test('work-state pagination reaches every frontier entry beyond the model projection and filters before slicing',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-frontier-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new Assistant({dir});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});const job=agent.buildJob(a,{goal:'补齐执行边界'});a.data.delegations.push(job);
 t.mock.method(require('../desktop/work-obligations.cjs'),'frontier',()=>Array.from({length:1003},(_,i)=>({nodeId:String(i),status:i<1000?'queried':'unexpanded'})));
 const last=await agent.act(a,job,'read_work_state',{section:'frontier',start:1000});assert.equal(last.total,1003);assert.equal(last.rows.length,3);assert.equal(last.rows[2].nodeId,'1002');assert.equal(last.next,null);
 const filtered=await agent.act(a,job,'read_work_state',{section:'frontier',status:'unexpanded',limit:2});assert.equal(filtered.total,3);assert.equal(filtered.next,2);assert.equal(filtered.rows[0].nodeId,'1000');
});
test('underlying frontier also retains platform queries after the thousandth snapshot',()=>{
 const sources=Array.from({length:1002},(_,i)=>({id:'s'+i,platformSnapshot:true,content:JSON.stringify({operation:'downstream',query:{op:'downstream',taskId:i+1,depth:1},data:{nodes:[{id:i+1,name:'节点'}]}})}));
 const a={data:{sources}},job={id:'job',dataPlatform:'sg-readonly',sourceIds:sources.map(s=>s.id),executionState:{operations:{}}};
 const rows=require('../desktop/work-obligations.cjs').frontier(a,job);assert.equal(rows.length,1002);assert.equal(rows.at(-1).nodeId,'1002');assert.equal(rows.at(-1).sourceId,'s1001');
});
test('planner accepts read_context tool envelope and local paging avoids a paid call per page',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-planner-eff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let count=0,sourceId;
 const a=new Assistant({dir,chat:async(_p,_k,messages)=>{
  const c=JSON.parse(messages[1].content);count++;
  if(count===1)return {tool:'read_context',args:{requests:[{tool:'read_source',sourceId}]}};
  const r=c.contextReads.find(r=>r.result.sourceId===sourceId).result;assert.equal(r.next,null);assert.equal(r.segments.length,70);assert.equal(r.pages,12);
  return {tool:'ask',args:{question:'测试结束的真实选择',options:[{label:'结束',answer:'结束'}]},reason:'fixture'};
 }});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'});
 const s={id:'source',title:'可读材料',content:Array.from({length:70},(_,i)=>'paragraph '+i).join('\n\n'),state:'processed'};sourceId=s.id;a.data.sources.push(s);
 const job=agent.buildJob(a,{goal:'读取材料',maxActions:1});job.sourceIds=[s.id];s.agentJobId=job.id;a.data.delegations.push(job);a.save();
 await a.dispatch('agentRun',{id:job.id});await a.runPromise;
 assert.equal(count,2);assert.ok(job.contextReads.length>=12);assert.notEqual(job.lastErrorCode,'MODEL_INVALID_RESPONSE');assert.equal(job.status,'needs_input');
 assert.ok(job.contextReads.every(r=>protocol.validRead(a,{kind:'job',jobId:job.id},r)));
});
