const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const access=require('../desktop/protocol-access.cjs');
const policies=require('../desktop/access-policy-store.cjs');

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-editorial-flow-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls=[],prohibited=async()=>{throw Error('External access prohibited');};
 const a=new Assistant({dir,connectorRequest:prohibited,agentRequest:prohibited,webRequest:prohibited,
  chat:async(_provider,_key,messages,options)=>{
   const context=JSON.parse(messages[1].content);
   calls.push({role:options.role,context});
   options.onUsage?.({inputTokens:10,outputTokens:10});
   if(options.role==='execute')return {kind:'patch',edits:[{
    before:'## 3\n周五发布。',after:'## 3\n计划周五发布。'
   }],summary:'仅润色第三节'};
   const readable=context.sources.some(s=>s.id==='source');
   return readable?{passed:true,summary:'各节符合发布日期依据',gaps:[]}:
    {passed:false,summary:'发布日期依据已不可读',gaps:['无法核验发布日期依据']};
  }});
 await a.dispatch('saveProvider',{name:'fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',inputPrice:0,outputPrice:0});
 a.data.settings.autoComplete=false;
 const task=a.createTask({title:'发布报告',criteria:'记录已核实的发布日期',steps:[{title:'正文',kind:'draft'}]});
 const source={id:'source',title:'发布日期',content:'周五发布',projectId:null};
 a.data.sources.push(source);task.sourceIds=[source.id];access.retain(a,'source',source,{task});
 const artifact={id:'original',taskId:task.id,stepId:task.steps[0].id,title:'发布报告',createdAt:'2026-10-12T00:00:00Z',
  content:Array.from({length:7},(_,i)=>`## ${i}\n`+'周五发布。'.repeat(200)).join('\n')};
 a.data.artifacts.push(artifact);Object.assign(task.steps[0],{done:true,artifactId:artifact.id});
 access.retain(a,'artifact',artifact,{task});
 // Seed through the actual verifier integration, not by constructing a checkpoint.
 await a.advance(task.id);
 assert.equal(task.status,'review');assert.equal(task.verification.mode,'full');
 assert.ok(task.verificationCheckpoint.policyBasis);
 return {a,task,source,artifact,calls};
}

for(const revoked of [false,true])test(revoked?
 'editorial taskAction/patch/advance uses full verification after source revocation':
 'editorial taskAction/patch/advance reuses unchanged chunks across new artifact IDs',async t=>{
 const {a,task,source,artifact,calls}=await fixture(t);
 const originalContent=artifact.content;
 await a.dispatch('taskAction',{id:task.id,command:'revise',note:'润色第三节'});
 if(revoked)policies.revoke(a,{
  principalScope:policies.LOCAL,
  resourceScope:{kind:'snapshot',key:'source:'+source.id,taskId:task.id},
  operations:['local_read','local_retention']
 },{trusted:true,actor:'user_command',command:'fixtureRevoke'});
 await a.advance(task.id);
 const revised=a.data.artifacts.find(r=>r.id===task.steps[0].artifactId);
 assert.notEqual(revised.id,artifact.id);
 assert.equal(artifact.content,originalContent);
 assert.equal(revised.content,originalContent.replace('## 3\n周五发布。','## 3\n计划周五发布。'));
 assert.deepEqual(calls.map(c=>c.role),['verify','execute','verify']);
 assert.equal(calls[1].context.revision.artifactId,artifact.id);
 const checked=calls.at(-1).context;
 if(revoked){
  assert.equal(task.verification.mode,'full');assert.equal(task.verification.reusedChunks,0);
  assert.equal(checked.previousCheck,undefined);assert.equal(checked.sources.length,0);
  assert.equal(task.status,'blocked');assert.equal(task.verification.passed,false);
 }else{
  assert.equal(task.verification.mode,'incremental');assert.ok(task.verification.reusedChunks>0);
  assert.equal(task.verification.reusedChunks,4);assert.equal(task.verification.checkedChunks,3);
  assert.equal(checked.previousCheck.requirementsAndSourcesUnchanged,true);
  assert.equal(task.status,'review');assert.equal(task.verification.passed,true);
 }
 assert.equal(task.acceptedAt,undefined);
});
