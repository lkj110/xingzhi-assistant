const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const routing=require('../desktop/intake-routing.cjs');
const agent=require('../desktop/agent.cjs');
const recovery=require('../desktop/recovery.cjs');
async function setup(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-routing-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const calls=[],a=new Assistant({dir,chat:async(p,k,m)=>{calls.push(m);return {tasks:[],summary:'完成整理'};}});
  await a.dispatch('projectSave',{name:'青禾'});const p=a.data.projects[0];await a.dispatch('projectSave',{name:'远山'});const q=a.data.projects[0];
  return {a,p,q,calls,dir};
}
async function rule(a,p,extra={}){await routing.dispatch(a,'intakeRoutingSave',{name:'青禾资料',projectId:p.id,field:'all',match:'any',keywords:['青禾'],enabled:true,...extra});return a.data.intakeRoutingRules.at(-1);}
async function conflict(a,p,q){await rule(a,p);await rule(a,q,{name:'另一项目规则'});a.addSources([{title:'会议材料',content:'青禾发布日期已确定'}]);return a.data.sources[0];}
async function projectJob(a,p){if(!a.data.providers.length)await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});const j=agent.buildJob(a,{goal:'持续整理项目资料',projectId:p.id,fileMode:'off',githubMode:'off'});j.status='paused';a.data.delegations.push(j);p.jobId=j.id;return j;}

test('Routing is opt-in and unmatched sources remain independent without calls',async t=>{
  const {a,p,calls}=await setup(t);const r=await rule(a,p,{enabled:false});a.addSources([{title:'青禾材料',content:'第一条记录'}]);assert.equal(a.data.sources[0].projectId,null);
  await routing.dispatch(a,'intakeRoutingToggle',{id:r.id,revision:r.revision,enabled:true});a.addSources([{title:'其他材料',content:'第二条记录'}]);assert.equal(a.data.sources[0].projectId,null);assert.equal(calls.length,0);
});
test('Literal keywords match Unicode fullwidth and case without regex evaluation',async t=>{
  const {a,p}=await setup(t);await rule(a,p,{keywords:['Qinghe','[x].*'],field:'title'});
  assert.equal(routing.route(a,{title:'ＱＩＮＧＨＥ 发布',content:'a'}).projectId,p.id);
  assert.equal(routing.route(a,{title:'[x].*',content:'b'}).projectId,p.id);
  assert.equal(routing.route(a,{title:'xxx',content:'Qinghe'}).projectId,undefined);
});
test('All keywords may occur across selected title and body, while content-only ignores title',async t=>{
  const {a,p}=await setup(t);const r=await rule(a,p,{keywords:['青禾','发布'],match:'all'});
  assert.equal(routing.route(a,{title:'青禾',content:'发布安排'}).projectId,p.id);assert.equal(routing.route(a,{title:'青禾',content:'无安排'}).projectId,undefined);
  await routing.dispatch(a,'intakeRoutingSave',{...r,field:'content'});assert.equal(routing.route(a,{title:'青禾发布',content:'无安排'}).projectId,undefined);
});
test('Explicit project and dedicated connection scopes cannot be reassigned by a rule',async t=>{
  const {a,p,q}=await setup(t);await rule(a,p);
  assert.equal(routing.route(a,{title:'青禾',content:'c',projectId:q.id}).projectId,q.id);
  for(const key of ['folderId','connectorId','webConnectionId','agentJobId','copiedFrom'])assert.equal(routing.route(a,{title:'青禾',content:'c',[key]:'bound'}).projectId,undefined);
  const item=routing.route(a,{title:'other',content:'c',routing:{status:'routed',projectId:q.id}});assert.equal(item.routing,undefined);
});
test('Multiple rules for one destination route once and preserve matching evidence',async t=>{
  const {a,p}=await setup(t);await rule(a,p);await rule(a,p,{name:'发布关键词',keywords:['发布']});a.addSources([{title:'青禾发布',content:'会议'}]);
  const s=a.data.sources[0];assert.equal(s.projectId,p.id);assert.equal(s.routing.status,'routed');assert.equal(s.routing.matchedRules.length,2);assert.equal(a.data.sources.length,1);assert.deepEqual(s.routing.projectIds,[p.id]);
});
test('Different matching destinations retain an independent conflict and skip extraction',async t=>{
  const {a,p,q,calls}=await setup(t);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});const s=await conflict(a,p,q);
  assert.equal(s.projectId,null);assert.equal(s.routing.status,'conflict');await assert.rejects(a.extract(),/没有待整理/);assert.equal(s.state,'new');assert.equal(calls.length,0);
});
test('Preview considers other enabled rules, excludes original edited version and has no side effects',async t=>{
  const {a,p,q,calls}=await setup(t);const r=await rule(a,p),before=JSON.stringify(a.data);
  const value=await routing.dispatch(a,'intakeRoutingPreview',{rule:{...r,projectId:q.id},sample:{title:'青禾',content:'预览正文'}});
  assert.equal(value.status,'routed');assert.equal(value.projectId,q.id);assert.equal(value.matchedRules.length,1);assert.equal(value.preview,true);assert.equal(JSON.stringify(a.data),before);assert.equal(calls.length,0);
  const conflictPreview=await routing.dispatch(a,'intakeRoutingPreview',{rule:{...r,id:undefined,projectId:q.id},sample:{title:'青禾'}});assert.equal(conflictPreview.status,'conflict');
});
test('Rule validation rejects normalized duplicates, empty/oversized/nonliteral patterns atomically',async t=>{
  const {a,p}=await setup(t);const base={name:'规则',projectId:p.id,field:'all',match:'any',keywords:['青禾']};
  for(const patch of [{keywords:[]},{keywords:['Ａ','a']},{keywords:[' ']},{keywords:['a'.repeat(81)]},{keywords:Array.from({length:13},(_,i)=>String(i))},{keywords:[{}]},{field:'origin'},{match:'regex'},{projectId:'missing'},{enabled:'true'}])await assert.rejects(routing.dispatch(a,'intakeRoutingSave',{...base,...patch}));
  assert.equal(a.data.intakeRoutingRules.length,0);
  for(const sample of [{},{title:'x'.repeat(301)},{content:'x'.repeat(500001)},{title:{}}])await assert.rejects(routing.dispatch(a,'intakeRoutingPreview',{sample}));
});
test('Rule edits, toggles and deletes reject stale revisions, and deletion preserves imported history',async t=>{
  const {a,p}=await setup(t);const r=await rule(a,p),stale=r.revision;a.addSources([{title:'青禾',content:'旧归类内容'}]);const s=a.data.sources[0];
  await routing.dispatch(a,'intakeRoutingToggle',{id:r.id,revision:r.revision,enabled:false});
  for(const action of ['intakeRoutingSave','intakeRoutingToggle','intakeRoutingDelete'])await assert.rejects(routing.dispatch(a,action,{...r,revision:stale,enabled:true}),/已变化/);
  await routing.dispatch(a,'intakeRoutingDelete',{id:r.id,revision:r.revision});assert.equal(a.data.intakeRoutingRules.length,0);assert.equal(s.projectId,p.id);assert.equal(s.routing.matchedRules[0].name,'青禾资料');
});
test('Missing target and malformed persisted rules are paused and still render a bounded snapshot',async t=>{
  const {a,p}=await setup(t);const r=await rule(a,p);a.data.projects=a.data.projects.filter(x=>x.id!==p.id);routing.initialize(a);assert.equal(r.enabled,false);assert.match(r.disabledReason,/不可用/);assert.equal(routing.route(a,{title:'青禾',content:'c'}).projectId,undefined);
  await assert.rejects(routing.dispatch(a,'intakeRoutingToggle',{id:r.id,revision:r.revision,enabled:true}),/项目不存在/);
  r.keywords=null;r.extraSecret='do not expose';routing.initialize(a);const view=routing.snapshot(a).rules[0];assert.deepEqual(view.keywords,[]);assert.ok(!JSON.stringify(view).includes('do not expose'));
});
test('Conflict snapshot omits source body and action data, with independent explicit resolution',async t=>{
  const {a,p,q}=await setup(t);const s=await conflict(a,p,q);s.content+=' 秘密正文';s.privateKey='秘密凭据';let view=routing.snapshot(a);assert.equal(view.pending.length,1);assert.ok(!JSON.stringify(view).includes('秘密'));
  await routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:view.pending[0].revision,choice:'independent'});assert.equal(s.projectId,null);assert.equal(s.routing.status,'kept_independent');assert.equal(s.state,'new');assert.equal(routing.snapshot(a).pending.length,0);
});
test('Resolve attaches to original paused project job without unpausing or duplicating it',async t=>{
  const {a,p,q,calls}=await setup(t);const j=await projectJob(a,p),s=await conflict(a,p,q);const row=routing.snapshot(a).pending[0];
  await routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:row.revision,choice:'project',projectId:p.id});assert.equal(s.projectId,p.id);assert.equal(s.routing.status,'assigned');assert.equal(j.status,'paused');assert.deepEqual(j.sourceIds,[s.id]);assert.equal(s.state,'processed');assert.equal(a.data.delegations.length,1);assert.equal(calls.length,0);
});
test('Resolve rejects stale material, processed sources, changed linkage and missing project without mutations',async t=>{
  const {a,p,q}=await setup(t);const s=await conflict(a,p,q),revision=routing.snapshot(a).pending[0].revision;
  s.updatedAt=new Date().toISOString();await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision,choice:'independent'}),/已变化/);
  const current=routing.snapshot(a).pending[0].revision;await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:current,choice:'project',projectId:'missing'}),/不存在/);assert.equal(s.routing.status,'conflict');
  s.state='processed';await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:current,choice:'independent'}),/状态已变化/);s.state='new';a.createTask({title:'现有事项',sourceIds:[s.id]});assert.equal(routing.snapshot(a).pending[0].canResolve,false);await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:current,choice:'independent'}),/状态已变化/);
});
test('Uncertain external result blocks project resolution and retains the conflict',async t=>{
  const {a,p,q}=await setup(t);const j=await projectJob(a,p),s=await conflict(a,p,q);a.data.agentActions.push({id:'u',jobId:j.id,status:'uncertain'});const before=JSON.stringify(a.data),row=routing.snapshot(a).pending[0];
  await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:row.revision,choice:'project',projectId:p.id}),/待核对/);assert.equal(JSON.stringify(a.data),before);
});
test('Project resolution rolls back the entire material/plan transaction if ingestion fails',async t=>{
  const {a,p,q}=await setup(t);await projectJob(a,p);const s=await conflict(a,p,q),row=routing.snapshot(a).pending[0],before=JSON.stringify(a.data),projects=require('../desktop/projects.cjs'),ingest=projects.ingest;
  projects.ingest=(a,p)=>{a.data.sources[0].state='processed';a.data.delegations[0].sourceIds.push('partial');throw new Error('fixture ingest failed');};
  try{await assert.rejects(routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:row.revision,choice:'project',projectId:p.id}),/fixture/);}finally{projects.ingest=ingest;}
  assert.equal(JSON.stringify(a.data),before);
});
test('A routed quick capture joins project without ordinary extraction, while queued imports use current rules',async t=>{
  const {a,p,q,calls}=await setup(t);await a.dispatch('saveProvider',{inputPrice:0,outputPrice:0,name:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});const j=await projectJob(a,p),r=await rule(a,p);
  await a.dispatch('captureSave',{textItems:[{title:'青禾即时',content:'即时材料'}],organize:true});await a.runPromise;assert.equal(a.data.sources[0].projectId,p.id);assert.equal(j.sourceIds.length,1);assert.equal(calls.length,0);
  a.operation={label:'fixture'};await a.dispatch('captureEnqueue',{textItems:[{title:'青禾排队',content:'排队材料'}],organize:true});a.operation=null;
  await routing.dispatch(a,'intakeRoutingSave',{...r,projectId:q.id});require('../desktop/capture.cjs').tick(a);await a.runPromise;const queued=a.data.sources.find(s=>s.title==='青禾排队');assert.equal(queued.projectId,q.id);assert.equal(a.data.captureQueue[0].status,'completed');assert.equal(calls.length,0);
});
test('Queued conflict completes import while retaining pending classification and makes no organizer calls',async t=>{
  const {a,p,q,calls}=await setup(t);await rule(a,p);await rule(a,q);await a.dispatch('captureEnqueue',{textItems:[{title:'青禾冲突',content:'等待确认归属'}],organize:true});await a.runPromise;
  assert.equal(a.data.captureQueue[0].status,'completed');assert.equal(a.data.sources[0].routing.status,'conflict');assert.equal(a.data.sources[0].state,'new');assert.equal(calls.length,0);
});
test('Restore preserves revoked rules and later routing decisions, reconnecting the original project evidence',async t=>{
  const {a,p,q}=await setup(t);const j=await projectJob(a,p),s=await conflict(a,p,q),id=recovery.create(a);const row=routing.snapshot(a).pending[0];
  await routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:row.revision,choice:'project',projectId:p.id});const removed=a.data.intakeRoutingRules[0];await routing.dispatch(a,'intakeRoutingDelete',{id:removed.id,revision:removed.revision});
  const old=JSON.parse(fs.readFileSync(path.join(a.dir,'backups',id))).data;routing.retain(a.data,old);
  assert.equal(old.intakeRoutingRules.length,1);assert.equal(old.intakeRoutingRules[0].enabled,false);assert.ok(!old.intakeRoutingRules.some(r=>r.id===removed.id));assert.equal(old.sources.find(x=>x.id===s.id).routing.status,'assigned');assert.equal(old.sources.find(x=>x.id===s.id).projectId,p.id);assert.ok(old.delegations.find(x=>x.id===j.id).sourceIds.includes(s.id));
});
test('Initialization after restart retains rules and source routing decisions',async t=>{
  const {a,p,dir}=await setup(t);await rule(a,p);a.addSources([{title:'青禾',content:'重启后保留'}]);const b=new Assistant({dir});assert.equal(b.data.intakeRoutingRules[0].enabled,true);assert.equal(b.data.sources[0].projectId,p.id);assert.equal(b.data.sources[0].routing.status,'routed');
});

test('Retaining a later routing decision does not resurrect material subsequently excluded from its project',async t=>{
  const {a,p,q}=await setup(t);const j=await projectJob(a,p),s=await conflict(a,p,q),before=structuredClone(a.data),row=routing.snapshot(a).pending[0];
  await routing.dispatch(a,'intakeRoutingResolve',{id:s.id,revision:row.revision,choice:'project',projectId:p.id});s.projectExcluded=true;j.sourceIds=[];
  routing.retain(a.data,before);const retained=before.sources.find(r=>r.id===s.id);assert.equal(retained.routing.status,'assigned');assert.equal(retained.projectExcluded,true);assert.ok(!before.delegations.find(r=>r.id===j.id).sourceIds.includes(s.id));
});
