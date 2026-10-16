const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs'),errors=require('../desktop/model-errors.cjs'),stewardship=require('../desktop/stewardship.cjs');
async function setup(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-resilience-integration-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const requests=[];
 const a=new Assistant({dir,chat:async(p,k,m,o)=>{requests.push({id:p.id,role:o.role,messages:JSON.stringify(m)});if(p.model==='primary')throw errors.httpError(503);o.onUsage?.({inputTokens:10,outputTokens:5});return o.role==='verify'?{passed:true,summary:'采用正确材料完成',gaps:[]}:{kind:'artifact',title:'交付',content:'预算 7200 元',summary:'已生成'};}});
 await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'主模型',model:'primary',baseUrl:'https://example.invalid/v1'});const primary=a.data.providers[0];await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'备用模型',model:'backup',baseUrl:'https://backup.invalid/v1'});const backup=a.data.providers.find(p=>p.model==='backup');
 const configure=async(enabled=true)=>{const snapshot=await a.dispatch('modelFallbackSnapshot');return a.dispatch('modelFallbackSave',{revision:snapshot.revision,roles:Object.fromEntries(['organize','execute','verify'].map(role=>[role,{enabled,providerId:backup.id}]))});};await configure();return{a,primary,backup,configure,requests};}
test('a real task uses independent execute and verify fallbacks, preserves one artifact, and accepts normally',async t=>{
 const {a,requests,primary,backup}=await setup(t);const task=a.createTask({title:'成果',criteria:'预算为7200',steps:[{title:'写报告',kind:'draft'}]});
 await a.dispatch('advance',{id:task.id});await a.runPromise;assert.equal(task.status,'review');assert.equal(a.data.artifacts.length,1);assert.equal(a.data.artifacts[0].content,'预算 7200 元');assert.equal(requests.length,4);assert.equal(stewardship.status(a).used,4);
 assert.deepEqual(requests.map(r=>r.id),[primary.id,backup.id,primary.id,backup.id]);assert.equal(requests[0].messages,requests[1].messages);assert.equal(requests[2].messages,requests[3].messages);
 assert.equal(a.data.modelCalls.filter(r=>r.attempt===2).length,2);assert.equal(new Set(a.data.modelCalls.map(r=>r.requestId)).size,2);
 await a.dispatch('taskAction',{id:task.id,command:'accept'});assert.equal(task.status,'completed');assert.equal(requests.length,4);assert.equal(a.data.artifacts.length,1);
});
test('restoring an old enabled policy retains the current opt-out and does not trigger a backup call',async t=>{
 const {a,configure,primary,backup,requests}=await setup(t);const id=(await a.dispatch('backupCreate'))[0].id;await configure(false);await a.dispatch('backupRestore',{id});
 const policy=await a.dispatch('modelFallbackSnapshot');for(const role of Object.values(policy.roles)){assert.equal(role.enabled,false);assert.equal(role.providerId,backup.id);}
 await assert.rejects(a.callModel(primary,'',[{role:'user',content:'资料'}],{role:'execute',stage:'task_work'}),e=>e.httpStatus===503);assert.equal(requests.length,1);
});
test('restoring a backup after removing the selected backup cannot resurrect its configuration',async t=>{
 const {a,primary,backup}=await setup(t);const id=(await a.dispatch('backupCreate'))[0].id;await a.dispatch('deleteProvider',{id:backup.id});await a.dispatch('backupRestore',{id});
 assert.equal(a.data.providers.length,1);assert.equal(a.data.providers[0].id,primary.id);for(const row of Object.values((await a.dispatch('modelFallbackSnapshot')).roles)){assert.equal(row.enabled,false);assert.equal(row.providerId,'');}
});
test('damaged workspace recovery disables backup routing from its automatic backup',async t=>{
 const {a}=await setup(t);await a.dispatch('backupCreate');fs.writeFileSync(a.file,'broken workspace');const restored=new Assistant({dir:a.dir,chat:async()=>{throw new Error('must not run');}});
 assert.ok(restored.data.runtime.recoveryNotice);for(const row of Object.values((await restored.dispatch('modelFallbackSnapshot')).roles))assert.equal(row.enabled,false);
});
test('retired count cap allows verification fallback while retaining exactly one artifact',async t=>{
 const {a,requests}=await setup(t);await a.dispatch('stewardshipSettings',{dailyCallLimit:3});const task=a.createTask({title:'预算受限成果',steps:[{title:'起草',kind:'draft'}]});
 await a.dispatch('advance',{id:task.id});await a.runPromise;assert.equal(requests.length,4);assert.equal(a.data.artifacts.length,1);assert.equal(task.steps[0].done,true);assert.equal(task.status,'review');assert.equal(task.stewardshipDeferredUntil,undefined);assert.equal(a.data.modelCalls.length,4);assert.equal(stewardship.status(a).used,4);
});
