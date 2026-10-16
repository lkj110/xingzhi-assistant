const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),stewardship=require('../desktop/stewardship.cjs'),agent=require('../desktop/agent.cjs');
async function setup(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-rhythm-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;const a=new Assistant({dir,chat:async()=>{calls++;return {ok:true};}});await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'隔离测试模型',model:'fixture',baseUrl:'https://example.invalid/v1'});return {a,dir,calls:()=>calls};}
async function timed(a){const until=new Date(Date.now()+120000).toISOString();await a.dispatch('stewardshipPause',{until,revision:stewardship.status(a).revision});return until;}
test('timed global resume drains a saved collection but preserves separately paused work and rules',async t=>{
 const {a,calls}=await setup(t),task=a.createTask({title:'手动暂停事项'});task.status='paused';const job=agent.buildJob(a,{goal:'手动暂停委托'});job.status='paused';a.data.delegations.push(job);await a.dispatch('ruleSave',{name:'保留手动暂停',goal:'等待用户继续',trigger:'daily',time:'09:00',enabled:false,allowWeb:false,folderIds:[]});
 const until=await timed(a);await a.dispatch('captureEnqueue',{textItems:[{title:'暂停时的新资料',content:'到期后接收这份材料。'}],organize:false});a.tick();assert.equal(a.data.sources.length,0);assert.equal(a.data.captureQueue[0].status,'queued');
 assert.equal(stewardship.reconcile(a,Date.parse(until)+1),true);a.save();a.tick();await a.runPromise;
 assert.equal(a.data.captureQueue[0].status,'completed');assert.equal(a.data.sources.length,1);assert.equal(task.status,'paused');assert.equal(job.status,'paused');assert.equal(a.data.workRules[0].status,'paused');assert.equal(calls(),0);assert.equal(stewardship.status(a).pauseUntil,null);
});
test('offdays are explained consistently in health and workmap and leave the durable queue untouched',async t=>{
 const {a,calls}=await setup(t);const today=stewardship.local(Date.now(),a.data.stewardship.timeZone).weekday;await a.dispatch('stewardshipSettings',{weekdays:[(today+1)%7]});
 const task=a.createTask({title:'等待工作日'});await a.dispatch('captureEnqueue',{textItems:[{title:'稍后整理',content:'已保存待工作日处理'}],organize:false});a.tick();assert.equal(a.operation,null);assert.equal(a.data.captureQueue[0].status,'queued');assert.equal(a.data.sources.length,0);assert.equal(calls(),0);
 const health=await a.dispatch('healthSnapshot');assert.ok(health.findings.some(r=>r.code==='global_offday'));
 const map=await a.dispatch('workmapSnapshot');assert.ok(JSON.stringify(map).includes('offday'));assert.ok(map.items.some(r=>r.taskId===task.id));
 const b=new Assistant({dir:a.dir,chat:a.chat});b.tick();assert.equal(b.data.captureQueue[0].status,'queued');assert.equal(stewardship.status(b).reason,'offday');
});
test('restoring a backup cancels a later timed resume even after reopening the workspace',async t=>{
 const {a}=await setup(t);const id=(await a.dispatch('backupCreate'))[0].id,until=await timed(a);await a.dispatch('backupRestore',{id});
 assert.equal(stewardship.status(a).pauseUntil,null);assert.equal(stewardship.status(a).reason,'paused');stewardship.reconcile(a,Date.parse(until)+60000);assert.equal(stewardship.status(a).reason,'paused');
 const b=new Assistant({dir:a.dir,chat:a.chat});stewardship.reconcile(b,Date.parse(until)+60000);assert.equal(stewardship.status(b).pauseUntil,null);assert.equal(stewardship.status(b).reason,'paused');
});
test('damaged workspace recovery cannot recover an old automatic resume permission from the ledger or backup',async t=>{
 const {a}=await setup(t),until=await timed(a);await a.dispatch('backupCreate');fs.writeFileSync(a.file,'damaged');const b=new Assistant({dir:a.dir,chat:a.chat});assert.ok(b.data.runtime.recoveryNotice);stewardship.reconcile(b,Date.parse(until)+60000);assert.equal(stewardship.status(b).reason,'paused');assert.equal(stewardship.status(b).pauseUntil,null);
});
test('global stop cancels the resume deadline durably while keeping collected work for review',async t=>{
 const {a,calls}=await setup(t),until=await timed(a);await a.dispatch('captureEnqueue',{textItems:[{title:'停止前材料',content:'不能被旧定时授权重新推进'}],organize:false});await a.dispatch('stop');assert.equal(a.data.captureQueue[0].status,'failed');assert.equal(stewardship.status(a).pauseUntil,null);
 const b=new Assistant({dir:a.dir,chat:a.chat});stewardship.reconcile(b,Date.parse(until)+60000);b.tick();assert.equal(stewardship.status(b).reason,'paused');assert.equal(b.data.captureQueue[0].status,'failed');assert.equal(b.data.sources.length,0);assert.equal(calls(),0);
});
test('a failed queue-start save leaves a retryable queued receipt and delivers the original payload once',async t=>{
 const {a}=await setup(t);a.operation={label:'已有工作'};await a.dispatch('captureEnqueue',{textItems:[{title:'启动保存失败',content:'原始内容应保留且只导入一次'}],organize:false});const row=a.data.captureQueue[0],prior=structuredClone(row),save=a.save.bind(a);a.operation=null;
 try{a.save=()=>{throw Error('controlled start write failure');};assert.throws(()=>require('../desktop/capture.cjs').tick(a),/controlled start write failure/);assert.deepEqual(row,prior);assert.equal(a.operation,null);assert.equal(a.data.sources.length,0);}finally{a.save=save;}
 assert.equal(require('../desktop/capture.cjs').tick(a),true);await a.runPromise;assert.equal(row.status,'completed');assert.equal(a.data.captureQueue.length,1);assert.equal(a.data.sources.length,1);assert.equal(a.data.sources[0].content,'原始内容应保留且只导入一次');
});
