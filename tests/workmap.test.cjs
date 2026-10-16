const {test}=require('node:test');
const assert=require('node:assert/strict');
const {snapshot,dispatch}=require('../desktop/workmap.cjs');
const acceptance=require('../desktop/acceptance.cjs');
const plan=require('../desktop/agent-plan.cjs');
const writes=require('../desktop/agent-writes.cjs');
function fixture(){
  return {save(){throw Error('read only');},chat(){throw Error('no model');},agentRequest(){throw Error('no network');},data:{projects:[{id:'p',name:'青禾项目'},{id:'q',name:'其他项目'}],delegations:[{id:'j',projectId:'p',title:'青禾发布',goal:'完成青禾说明文稿和交付',status:'ready',taskIds:['first','next'],sourceIds:['s'],maxCalls:20,callsUsed:0,followups:[],fileMode:'auto',outputFolder:'/not-accessed'}],tasks:[{id:'first',projectId:'p',agentJobId:'j',title:'整理事实',criteria:'说明预算',status:'completed',dependsOn:[],sourceIds:['s'],verification:{passed:true,summary:'预算已核对',gaps:[]},steps:[{id:'step-first',title:'整理事实依据',kind:'draft',done:true,artifactId:'artifact'}]},{id:'next',projectId:'p',agentJobId:'j',title:'生成最终说明',criteria:'说明预算和安排',status:'todo',dependsOn:['first'],sourceIds:['s'],steps:[{id:'step-next',title:'生成说明文稿',kind:'draft',done:false}]}],sources:[{id:'s',projectId:'p',title:'预算事实',content:'PRIVATE_SOURCE_BODY'}],artifacts:[{id:'artifact',taskId:'first',stepId:'step-first',title:'事实文稿',content:'PRIVATE_ARTIFACT_BODY'}],agentActions:[],decisions:[],connectors:[],workRules:[],providers:[{id:'provider',apiKey:'PRIVATE_TOKEN'}],settings:{automatic:true,roles:{organize:'provider',execute:'provider',verify:'provider'}},agentSettings:{},events:[]}};
}
const item=(a,id='next',input={})=>snapshot(a,input).items.find(row=>row.taskId===id);
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}

test('Work map shows goal, current step, valid dependency layers and current evidence without mutation or calls',()=>{
  const a=fixture(),before=JSON.stringify(a.data);freeze(a.data);const result=snapshot(a),first=item(a,'first'),next=item(a);
  assert.equal(result.modelCalls,0);assert.equal(result.networkRequests,0);assert.equal(first.state,'completed');assert.equal(first.layer,0);assert.equal(next.layer,1);assert.equal(next.dependencyReady,true);assert.equal(next.state,'actionable');assert.equal(next.currentStep,'生成说明文稿');assert.equal(next.goal,'完成青禾说明文稿和交付');assert.equal(next.sources[0].type,'source');assert.equal(first.artifacts[0].type,'artifact');assert.equal(result.next.taskId,'next');assert.equal(JSON.stringify(a.data),before);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});
test('Scope filters inherit project from delegation and retain genuine independent work',()=>{
  const a=fixture();delete a.data.tasks[0].projectId;a.data.tasks.push({id:'i',title:'独立工作',status:'todo',steps:[{title:'草稿',kind:'draft',done:false}]});a.data.delegations.push({id:'empty',projectId:'q',title:'另一个委托',status:'ready',taskIds:[],sourceIds:[]});
  assert.equal(snapshot(a,{projectId:'p'}).total,2);assert.equal(snapshot(a,{projectId:'@independent'}).total,1);assert.equal(snapshot(a,{projectId:'q'}).items[0].type,'job');assert.equal(snapshot(a,{jobId:'j'}).total,2);assert.throws(()=>snapshot(a,{projectId:'p',jobId:'empty'}));
});
test('Malformed scope, filters and pagination cannot silently widen a query',()=>{
  const a=fixture();for(const input of [null,[],{projectId:null},{projectId:0},{projectId:'missing'},{jobId:null},{jobId:'missing'},{state:'__proto__'},{state:['all']},{state:null},{page:0},{page:1.5},{pageSize:101},{pageSize:0},{pageSize:'20'}])assert.throws(()=>snapshot(a,input),JSON.stringify(input));assert.throws(()=>dispatch(a,'workmapMutate'));assert.equal(dispatch(a,'workmapSnapshot').total,2);
});
test('A task can have ready dependencies while pauses, global gates and quota still block its execution',()=>{
  const a=fixture();a.data.delegations[0].status='paused';a.data.delegations[0].callsUsed=20;a.suspended=true;
  const row=item(a);assert.equal(row.dependencyReady,true);assert.equal(row.state,'blocked');for(const code of ['job_paused','suspended'])assert.ok(row.gates.some(gate=>gate.code===code));assert.equal(row.validCompletion,false);assert.equal(item(a,'first').state,'completed');
});
test('Incomplete, cancelled, replanned or unverified prerequisites block dependent work',()=>{
  for(const mutate of [task=>task.status='review',task=>task.agentCancelled=true,task=>task.needsReplan='changed',task=>task.verification.passed=false,task=>task.verification.gaps=['未完成'],task=>task.steps[0].done=false]){
    const a=fixture();mutate(a.data.tasks[0]);const row=item(a);assert.equal(row.dependencyReady,false);assert.equal(row.state,'blocked');assert.equal(row.dependencies[0].valid,false);assert.ok(plan.dependencyIssues(a,a.data.tasks[1]).length);
  }
});
test('Changes after verification invalidate completion and dependencies consistently with agent readiness',()=>{
  for(const mutate of [a=>a.data.artifacts[0].content+='changed',a=>a.data.sources[0].content+='changed',a=>a.data.tasks[0].criteria+='changed',a=>a.data.delegations[0].goal+='changed']){
    const a=fixture();a.data.tasks[0].verification.basis=acceptance.basis(a,a.data.tasks[0]);assert.equal(item(a).dependencyReady,true);assert.equal(plan.dependencyIssues(a,a.data.tasks[1]).length,0);mutate(a);assert.equal(item(a).dependencyReady,false);assert.equal(item(a,'first').state,'check');assert.ok(item(a,'first').issues.some(reason=>reason.code==='changed'));assert.ok(plan.dependencyIssues(a,a.data.tasks[1]).length);
  }
});
test('Missing or withdrawn evidence cannot count as valid completed prerequisites',()=>{
  for(const mutate of [a=>a.data.artifacts=[],a=>a.data.sources=[],a=>a.data.sources[0].projectExcluded=true,a=>a.data.sources[0].deleted=true,a=>a.data.sources.push({id:'s2',projectId:'p',previousSourceId:'s',title:'新版',content:'新版'})]){
    const a=fixture();mutate(a);assert.equal(item(a).dependencyReady,false);assert.equal(item(a,'first').state,'check');assert.ok(plan.dependencyIssues(a,a.data.tasks[1]).length);
  }
});
test('Cross-project and cross-delegation links are errors and never reveal foreign record titles',()=>{
  const a=fixture();a.data.delegations.push({id:'foreign-job',projectId:'q',title:'FOREIGN_JOB',goal:'FOREIGN_GOAL',taskIds:['foreign'],sourceIds:['foreign-source'],status:'ready'});a.data.tasks.push({id:'foreign',agentJobId:'foreign-job',projectId:'q',title:'FOREIGN_TASK',status:'completed'});a.data.sources.push({id:'foreign-source',projectId:'q',title:'FOREIGN_SOURCE'});a.data.artifacts.push({id:'foreign-artifact',taskId:'foreign',title:'FOREIGN_ARTIFACT'});Object.assign(a.data.tasks[1],{dependsOn:['foreign'],sourceIds:['foreign-source'],steps:[{kind:'draft',done:true,artifactId:'foreign-artifact'}]});
  const r=snapshot(a,{projectId:'p'}),next=r.items.find(row=>row.taskId==='next');assert.equal(next.state,'check');assert.equal(next.dependencies[0].available,false);assert.equal(next.sources[0].available,false);assert.equal(next.artifacts[0].available,false);assert.ok(!JSON.stringify(r).includes('FOREIGN_'));
  a.data.delegations[1].projectId='p';a.data.tasks[2].projectId='p';assert.equal(item(a).dependencies[0].available,false);
});
test('Missing jobs, missing dependencies, malformed dependency lists and duplicate IDs are flagged',()=>{
  for(const mutate of [a=>a.data.tasks[1].agentJobId='gone',a=>a.data.tasks[1].dependsOn=['gone'],a=>a.data.tasks[1].dependsOn=['first','first'],a=>a.data.tasks[1].dependsOn='first',a=>a.data.tasks.push({...a.data.tasks[0]})]){
    const a=fixture();mutate(a);const row=item(a);assert.equal(row.state,'check');assert.equal(row.dependencyReady,false);
  }
});
test('Cycles and their descendants are blocked without recursive traversal',()=>{
  const a=fixture();a.data.tasks[0].dependsOn=['next'];a.data.tasks.push({id:'tail',agentJobId:'j',projectId:'p',title:'依赖循环的后续事项',status:'todo',dependsOn:['next'],steps:[{kind:'draft',done:false}]});a.data.delegations[0].taskIds.push('tail');
  const r=snapshot(a);assert.equal(r.counts.check,3);for(const row of r.items){assert.equal(row.layer,null);assert.equal(row.dependencyReady,false);assert.ok(row.issues.some(reason=>reason.code==='dependency_cycle'));}
});
test('Long dependency chains paginate completely and remain iterative',()=>{
  const a=fixture();a.data.delegations=[];a.data.tasks=[];a.data.sources=[];a.data.artifacts=[];
  for(let i=0;i<600;i++)a.data.tasks.push({id:`t${String(i).padStart(3,'0')}`,title:`步骤${i}`,status:'completed',dependsOn:i?[`t${String(i-1).padStart(3,'0')}`]:[],verification:{passed:true,summary:'人工证据已核对',gaps:[]},steps:[{kind:'external',tool:'manual',done:true,evidence:'用户确认实际完成'}]});
  const first=snapshot(a,{pageSize:100}),last=snapshot(a,{pageSize:100,page:999});assert.equal(first.counts.completed,600);assert.equal(last.page,6);assert.equal(last.items.length,100);assert.equal(last.items.at(-1).layer,599);assert.equal(first.items[0].validCompletion,true);assert.equal(last.to,600);
});
test('Current decisions, unsettled writes and model configuration are explicit separate gates',()=>{
  const a=fixture();a.data.decisions.push({jobId:'j',status:'open'});a.data.agentActions.push({jobId:'j',status:'uncertain'});a.data.providers=[];const row=item(a);assert.equal(row.dependencyReady,false);for(const code of ['decision','uncertain','model'])assert.ok(row.gates.some(gate=>gate.code===code));
});
test('External-step permissions, destinations and manual steps never imply automatic execution',()=>{
  const a=fixture();a.data.tasks[1].steps=[{kind:'external',tool:'write_file',done:false}];a.data.delegations[0].fileMode='off';delete a.data.delegations[0].outputFolder;
  let row=item(a);assert.equal(row.dependencyReady,true);assert.equal(row.state,'blocked');assert.ok(row.gates.some(gate=>gate.code==='permission'));assert.ok(row.gates.some(gate=>gate.code==='destination'));
  a.data.tasks[1].steps[0].tool='manual';assert.ok(item(a).gates.some(gate=>gate.code==='manual_step'));
  a.data.tasks[1].steps[0].tool='github_update';a.data.delegations[0].githubUpdateMode='auto';assert.ok(item(a).gates.some(gate=>gate.code==='credential'));
});
test('Approved pending writes do not ask for the same approval again; changed versions still require review',()=>{
  const a=fixture(),task=a.data.tasks[1],job=a.data.delegations[0];task.steps=[{kind:'external',tool:'write_file',done:false}];job.fileMode='ask';job.pendingActionId='write';const action={id:'write',jobId:'j',taskId:'next',tool:'write_file',status:'pending',version:writes.version(task)};a.data.agentActions.push(action);
  assert.ok(item(a).gates.some(gate=>gate.code==='approval'));assert.ok(item(a).gates.some(gate=>gate.code==='permission_ask'));
  action.approvedAt=new Date().toISOString();assert.ok(!item(a).gates.some(gate=>['approval','permission_ask'].includes(gate.code)));assert.equal(item(a).state,'actionable');task.title+='changed';assert.ok(item(a).gates.some(gate=>gate.code==='permission_ask'));
});
test('Approval for a different task or tool cannot satisfy the current ask policy',()=>{
  const a=fixture(),task=a.data.tasks[1],job=a.data.delegations[0];task.steps=[{kind:'external',tool:'write_file',done:false}];job.fileMode='ask';a.data.agentActions.push({id:'write',jobId:'j',taskId:'next',tool:'github_create',status:'pending',version:writes.version(task),approvedAt:new Date().toISOString()});assert.ok(item(a).gates.some(gate=>gate.code==='permission_ask'));
});
test('Future schedule, paused rules, independent automation and active operations appear without changing work',()=>{
  const a=fixture();a.data.delegations[0].nextRunAt=new Date(Date.now()+3600000).toISOString();a.data.delegations[0].ruleId='rule';a.operation={label:'busy'};for(const code of ['scheduled','rule_paused','busy'])assert.ok(item(a).gates.some(gate=>gate.code===code));
  a.data.tasks.push({id:'independent',title:'人工启用',status:'todo',steps:[{kind:'draft',done:false}]});a.data.settings.automatic=false;assert.ok(item(a,'independent').gates.some(gate=>gate.code==='manual'));
});
test('Empty delegations remain visible, and completed jobs without tasks are explicitly unverified',()=>{
  const a=fixture();a.data.delegations.push({id:'empty',title:'收集需求',goal:'从目标开始',status:'ready',taskIds:[],sourceIds:[]});assert.equal(snapshot(a,{jobId:'empty'}).items[0].state,'actionable');a.data.delegations[1].status='completed';const result=snapshot(a,{jobId:'empty'});assert.equal(result.items[0].state,'check');assert.match(result.items[0].issues[0].message,/没有关联事项/);
});
test('Cancelled work and completed work remain visible under dedicated filters',()=>{
  const a=fixture();a.data.tasks[1].agentCancelled=true;assert.equal(snapshot(a,{state:'cancelled'}).items[0].taskId,'next');assert.equal(snapshot(a,{state:'completed'}).items[0].taskId,'first');assert.equal(snapshot(a).next,null);
});
test('Scoped malformed legacy records neither crash nor leak into independent work',()=>{
  const a=fixture();a.data.tasks.push(null,{id:'bad-number',projectId:0,status:'todo'},{id:'bad-job',agentJobId:0,status:'todo'},{id:'missing-job',agentJobId:'gone',status:'todo'});a.data.delegations.push(null);a.data.sources.push(null);a.data.artifacts.push(null);a.data.agentActions.push(null);a.data.decisions.push(null);assert.doesNotThrow(()=>snapshot(a));assert.equal(snapshot(a,{projectId:'@independent'}).total,0);
});
test('Source labels do not treat another project version pointer as replacement',()=>{
  const a=fixture();a.data.sources.push({id:'foreign-new',projectId:'q',previousSourceId:'s',title:'FOREIGN_REPLACEMENT'});assert.equal(item(a).sources[0].current,true);assert.ok(!JSON.stringify(snapshot(a,{projectId:'p'})).includes('FOREIGN_REPLACEMENT'));
});
test('Malformed and empty current steps cannot be advertised as actionable',()=>{
  for(const steps of [[],[null],[{kind:'draft',done:'false'}],[{kind:'unrecognized',done:false}]]){
    const a=fixture();a.data.tasks[1].steps=steps;assert.equal(item(a).state,'blocked');assert.ok(item(a).gates.some(gate=>gate.code==='step'));
  }
});
