'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const lifecycle=require('../scripts/readiness/lifecycle.cjs');
const roots={candidate:path.resolve(__dirname,'..'),...(process.env.XINGZHI_READINESS_BASELINE?{baseline:path.resolve(process.env.XINGZHI_READINESS_BASELINE)}:{})};
for(const [arm,root] of Object.entries(roots))test(arm+': task and whole-job checks bracket real accept/reopen/revise/accept',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'readiness-lifecycle-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5}));
 let task,phase='initial',workers=0,taskChecks=0,goalChecks=0;const calls=[];
 const a=new (require(path.join(root,'desktop/core.cjs')).Assistant)({dir,chat:async(p,k,m,o)=>{
  calls.push({phase,role:o.role});o.onUsage?.({inputTokens:10,outputTokens:5});
  assert.ok(!m[0].content.includes('动作格式'),'complete must use the production automatic completion candidate');
  if(o.stage==='goal_verify'){goalChecks++;return {passed:true,summary:'离线整体核验',gaps:[]};}
  if(o.role==='verify'){taskChecks++;return {passed:true,summary:'离线当前稿核验',gaps:[]};}
  workers++;return phase==='initial'?{kind:'artifact',title:'S1 说明',content:'S1 已知事实。'}:{kind:'patch',title:'S2 说明',edits:[{before:'S1 已知事实。',after:'S2 已知事实。'}],summary:'更新当前版本'};
 }});
 a.data.settings.evidenceGrounding=false;a.data.settings.automatic=false;a.data.settings.autoComplete=false;
 await a.dispatch('saveProvider',{name:'offline',model:'mock',baseUrl:'http://127.0.0.1:1',key:'offline',inputPrice:0,outputPrice:0});
 const agent=require(path.join(root,'desktop/agent.cjs')),job=agent.buildJob(a,{goal:'比较 S1 与 S2',autoAccept:false,allowWeb:false,maxActions:12});a.data.delegations.push(job);
 task=a.createTask({title:'S1 说明',description:'说明 S1',criteria:'交付当前版本说明',generationMode:'single',steps:[{title:'说明',kind:'draft'}]});task.agentJobId=job.id;task.agentKey='one';job.taskIds=[task.id];
 const states=[];await lifecycle.revise(a,task,root,{description:'改为说明 S2',note:'将 S1 改为 S2，同时更新交付标题'}, {onPhase:(name,result)=>{states.push({name,result,basis:job.completionCheck?.basis});if(name==='initial')phase='revision';}});
 assert.equal(task.status,'completed');assert.equal(job.status,'completed');assert.equal(workers,2);assert.equal(taskChecks,2);assert.equal(goalChecks,2);assert.equal(calls.length,6);
 assert.notEqual(states[0].basis,states[1].basis);assert.ok(states.every(s=>s.result.completionChecked));
 const artifact=require(path.join(root,'desktop/deliverables.cjs')).primary(a,task);assert.equal(artifact.title,arm==='baseline'?'S1 说明':'S2 说明');assert.equal(artifact.content,'S2 已知事实。');
 const reopened=new (require(path.join(root,'desktop/core.cjs')).Assistant)({dir});assert.equal(reopened.task(task.id).status,'completed');
});
