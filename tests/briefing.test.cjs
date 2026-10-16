const {test}=require('node:test');
const assert=require('node:assert/strict');
const {snapshot,exportReport,dispatch}=require('../desktop/briefing.cjs');
const NOW=Date.now(),date=hours=>new Date(NOW+hours*3600000).toISOString();
function fixture() {
  return {chat(){throw Error('must not call model');},save(){throw Error('must not save');},data:{
    projects:[{id:'p',name:'青禾项目'},{id:'q',name:'另一个项目'}],
    delegations:[{id:'j',projectId:'p',title:'青禾交付',status:'watching',followups:[],updatedAt:date(-1)}],
    sources:[{id:'s',projectId:'p',title:'青禾材料',content:'SOURCE_BODY_PRIVATE',createdAt:date(-2),version:1}],
    tasks:[{id:'t',projectId:'p',agentJobId:'j',title:'青禾交付事项',status:'completed',sourceIds:['s'],completedAt:date(-1),createdAt:date(-10),updatedAt:date(-1),verification:{passed:true,gaps:[]},steps:[{kind:'draft',done:true,artifactId:'v'},{kind:'external',tool:'write_file',done:true,artifactId:'v',evidence:'{"actionId":"a"}'}]}],
    artifacts:[{id:'v',taskId:'t',title:'青禾文稿',content:'ARTIFACT_BODY_PRIVATE',createdAt:date(-1.5)}],
    agentActions:[{id:'a',jobId:'j',projectId:'p',taskId:'t',artifactId:'v',tool:'write_file',title:'PRIVATE_ACTION_TITLE',status:'done',finishedAt:date(-1.4),result:{verified:true,path:'/Users/private/out/report.md',content:'EXTERNAL_BODY_PRIVATE'}}],
    decisions:[],providers:[{apiKey:'VERY_SECRET_KEY'}],agentSettings:{githubToken:'VERY_SECRET_TOKEN'},folders:[]
  }};
}
function deepFreeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;}

test('Briefing counts actual verified receipts separately from completed tasks without mutation or calls',()=>{
  const a=fixture(),before=JSON.stringify(a.data);deepFreeze(a.data);
  const r=snapshot(a,{projectId:'p',range:'7d'});
  assert.equal(r.counts.deliveries,1);assert.equal(r.counts.completions,1);assert.equal(r.completionCounts.checked,1);assert.equal(r.counts.drafts,0);assert.equal(r.counts.materials,1);
  assert.equal(r.sections.deliveries.items[0].verified,true);assert.equal(r.sections.deliveries.items[0].current,true);assert.equal(r.modelCalls,0);assert.equal(r.networkRequests,0);assert.equal(JSON.stringify(a.data),before);
  for(const text of ['SOURCE_BODY_PRIVATE','ARTIFACT_BODY_PRIVATE','EXTERNAL_BODY_PRIVATE','PRIVATE_ACTION_TITLE','/Users/private','VERY_SECRET'])assert.ok(!JSON.stringify(r).includes(text));
});
test('Range boundaries are inclusive and future events do not count',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.sources=[];
  for(const [id,hours] of [['exact-start',-24],['before',-24.0001],['end',0],['future',0.0001],['week',-72],['month',-400]])a.data.sources.push({id,projectId:'p',title:id,createdAt:date(hours)});
  assert.deepEqual(snapshot(a,{range:'24h'}).sections.materials.items.map(s=>s.title),['end','exact-start']);
  assert.equal(snapshot(a,{range:'7d'}).counts.materials,4);assert.equal(snapshot(a,{range:'30d'}).counts.materials,5);
});
test('Global, project and independent scopes attribute inherited jobs and standalone work correctly',()=>{
  const a=fixture();delete a.data.tasks[0].projectId;
  a.data.tasks.push({id:'ind',title:'独立事项',status:'waiting',nextCheckAt:date(2),dueAt:date(4)});
  a.data.sources.push({id:'ind-source',title:'独立材料',createdAt:date(-1)});
  a.data.delegations.push({id:'ind-job',title:'独立委托',status:'needs_input',followups:[]});
  const r=snapshot(a,{projectId:'@independent'});assert.equal(r.counts.completions,0);assert.equal(r.counts.materials,1);assert.equal(r.counts.followups,1);assert.equal(r.counts.decisions,1);assert.equal(r.counts.deadlines,1);
  assert.ok(!JSON.stringify(r).includes('青禾'));assert.equal(snapshot(a,{projectId:'p'}).counts.completions,1);assert.equal(snapshot(a).counts.materials,2);
});
test('Unknown project inputs and malformed range/pagination never widen the requested scope',()=>{
  const a=fixture();for(const input of [null,[],{projectId:null},{projectId:false},{projectId:0},{projectId:{}},{projectId:'missing'},{range:''},{range:'__proto__'},{range:7},{pageSize:0},{pageSize:'20'},{pageSize:101},{pages:[]},{pages:{materials:0}},{pages:{materials:1.5}},{pages:{secrets:1}}])assert.throws(()=>snapshot(a,input));
  assert.throws(()=>exportReport(a,{format:'html'}));assert.throws(()=>dispatch(a,'anything'));
});
test('Conflicting task/job scopes and forged receipt references do not cross project boundaries',()=>{
  const a=fixture();a.data.delegations.push({id:'qj',projectId:'q',title:'FOREIGN',followups:[]});
  a.data.tasks.push({id:'foreign-task',projectId:'q',agentJobId:'j',title:'FOREIGN',status:'completed',completedAt:date(-1)});
  a.data.agentActions.push({...a.data.agentActions[0],id:'foreign-action',jobId:'qj',title:'FOREIGN'});
  a.data.decisions.push({id:'foreign-decision',jobId:'qj',projectId:'p',status:'open',question:'FOREIGN'});
  a.data.delegations[0].followups.push({key:'bad',taskId:'foreign-task',status:'waiting',expected:'FOREIGN',deadlineAt:date(1)});
  const r=snapshot(a,{projectId:'p'});assert.equal(r.counts.deliveries,1);assert.equal(r.counts.completions,1);assert.equal(r.counts.decisions,0);assert.equal(r.counts.followups,0);assert.ok(!JSON.stringify(r).includes('FOREIGN'));assert.equal(r.notices.length,0);
  assert.match(snapshot(a).notices.join(' '),/归属/);
});
test('Historical verified receipts remain delivery events even when task is reopened',()=>{
  const a=fixture();Object.assign(a.data.tasks[0],{status:'todo',needsReplan:'new source',steps:[]});
  const r=snapshot(a);assert.equal(r.counts.deliveries,1);assert.equal(r.sections.deliveries.items[0].current,false);assert.match(r.sections.deliveries.items[0].detail,/历史动作/);assert.equal(r.counts.completions,0);assert.equal(r.counts.drafts,1);assert.equal(r.sections.drafts.items[0].kind,'historical');
});
test('Unverified, running and uncertain writes never masquerade as verified external deliveries',()=>{
  for(const patch of [{status:'pending'},{status:'running'},{status:'uncertain'},{result:{verified:false}},{result:{verified:'true'}}]){
    const a=fixture();Object.assign(a.data.agentActions[0],patch);const r=snapshot(a);assert.equal(r.counts.deliveries,0);assert.equal(r.completionCounts.checked,0);assert.equal(r.completionCounts.unverified,1);
  }
});
test('Completion classifications distinguish manual evidence from connector receipts and unsupported marks',()=>{
  const a=fixture();a.data.agentActions=[];a.data.tasks[0].steps=[{kind:'external',tool:'manual',done:true,evidence:'用户说明人工执行完成'}];
  let r=snapshot(a);assert.equal(r.completionCounts.manualEvidence,1);assert.equal(r.counts.deliveries,0);assert.match(r.sections.completions.items[0].detail,/人工提供/);
  a.data.tasks[0].steps[0].evidence='';r=snapshot(a);assert.equal(r.completionCounts.unverified,1);assert.equal(r.completionCounts.manualEvidence,0);
  a.data.tasks[0].steps=[];assert.equal(snapshot(a).completionCounts.unverified,1);
});
test('Source replacements, withdrawal, cancelled tasks and contradictory checks never appear as accepted',()=>{
  for(const mutate of [a=>{a.data.tasks[0].verification.gaps=['missing'];},a=>{a.data.tasks[0].verification.passed=false;},a=>{a.data.sources[0].deleted=true;},a=>{a.data.sources[0].projectExcluded=true;},a=>{a.data.artifacts=[];},a=>{a.data.tasks[0].steps[0].done=false;},a=>{a.data.sources.push({...a.data.sources[0],id:'new',previousSourceId:'s',version:2});}]){
    const a=fixture();mutate(a);assert.equal(snapshot(a).completionCounts.checked,0);
  }
  const a=fixture();a.data.tasks[0].agentCancelled=true;assert.equal(snapshot(a).counts.completions,0);assert.equal(snapshot(a).counts.deliveries,1);
});
test('Current replacement source works when an old source is explicitly superseded',()=>{
  const a=fixture();a.data.sources.push({...a.data.sources[0],id:'new',previousSourceId:'s',version:2});Object.assign(a.data.tasks[0],{sourceIds:['s','new'],supersededSourceIds:['s']});
  const r=snapshot(a);assert.equal(r.completionCounts.checked,1);assert.equal(r.counts.materials,2);assert.equal(r.sections.materials.items.filter(s=>s.kind==='version').length,1);assert.ok(r.sections.materials.items.some(s=>s.detail.includes('已有更新版本')));
});
test('Current decisions and followups are not hidden by a short historical range and omit question bodies',()=>{
  const a=fixture();a.data.decisions.push({id:'d',jobId:'j',projectId:'p',status:'open',createdAt:date(-1000),question:'PRIVATE_QUESTION_BODY',suggestion:'PRIVATE_SUGGESTION'});
  a.data.delegations[0].status='paused';a.data.delegations[0].followups=[{key:'f',taskId:'t',status:'waiting',createdAt:date(-1000),expected:'PRIVATE_EXPECTED_BODY',deadlineAt:date(-2),checkAt:date(1)}];
  const r=snapshot(a,{range:'24h'});assert.equal(r.counts.decisions,1);assert.equal(r.counts.followups,1);assert.equal(r.counts.deadlines,1);assert.equal(r.sections.followups.items[0].paused,true);assert.equal(r.sections.followups.items[0].overdue,true);assert.ok(!JSON.stringify(r).includes('PRIVATE_'));assert.equal(r.sections.decisions.period,'current');
});
test('Waiting independent work and future/overdue deadlines are ordered from earliest',()=>{
  const a=fixture();a.data.tasks.push({id:'future',title:'later',status:'paused',dueAt:date(50)},{id:'overdue',title:'earlier',status:'waiting',dueAt:date(-3),nextCheckAt:date(1)});
  const r=snapshot(a,{projectId:'@independent'});assert.deepEqual(r.sections.deadlines.items.map(t=>t.title),['earlier','later']);assert.equal(r.counts.followups,1);assert.match(r.sections.deadlines.items[1].detail,/暂停/);
});
test('Pagination totals match every detail and exports include all pages without routes',()=>{
  const a=fixture();a.data.sources=[];for(let i=0;i<47;i++)a.data.sources.push({id:`s-${String(i).padStart(3,'0')}`,projectId:'p',title:`材料${i}`,createdAt:date(-i/100)});
  const first=snapshot(a,{pageSize:20}),middle=snapshot(a,{pageSize:20,pages:{materials:2}}),last=snapshot(a,{pageSize:20,pages:{materials:99}});
  assert.equal(first.counts.materials,47);assert.equal(first.sections.materials.total,47);assert.equal(first.sections.materials.items.length,20);assert.equal(middle.sections.materials.from,21);assert.equal(last.sections.materials.page,3);assert.equal(last.sections.materials.items.length,7);assert.equal(last.sections.materials.to,47);
  const all=[...first.sections.materials.items,...middle.sections.materials.items,...last.sections.materials.items];assert.equal(new Set(all.map(s=>s.id)).size,47);
  const json=JSON.parse(exportReport(a,{format:'json',pageSize:1,pages:{materials:4}}).content);assert.equal(json.sections.materials.items.length,47);assert.equal(json.counts.materials,47);assert.equal(json.sections.materials.items[0].route,undefined);assert.equal(json.projectId,undefined);
  const markdown=exportReport(a,{format:'md'});assert.match(markdown.content,/收集与材料变化：47 条/);assert.match(markdown.content,/材料46/);
});
test('Missing event dates are disclosed and never inferred from newer edit timestamps',()=>{
  const a=fixture();delete a.data.tasks[0].completedAt;delete a.data.agentActions[0].finishedAt;a.data.sources[0].createdAt='invalid';
  const r=snapshot(a);assert.equal(r.counts.completions,0);assert.equal(r.counts.deliveries,0);assert.equal(r.counts.materials,0);assert.match(r.notices.join(' '),/3 条/);
});
test('Default preview and both exports redact configured credentials, paths and URL tokens from titles',()=>{
  const a=fixture();a.data.projects[0].name='青禾 VERY_SECRET_TOKEN';a.data.tasks[0].title='VERY_SECRET_KEY https://host.example/private?token=URL_TOKEN';a.data.sources[0].title='位置 /Users/private/My Folder/file.md';a.data.artifacts[0].title='密码 password=RAW_PASSWORD';a.data.tasks[0].status='review';
  for(const result of [snapshot(a),exportReport(a,{format:'json'}),exportReport(a,{format:'md'})])for(const secret of ['VERY_SECRET','URL_TOKEN','/Users/private','My Folder','RAW_PASSWORD','SOURCE_BODY_PRIVATE','ARTIFACT_BODY_PRIVATE','EXTERNAL_BODY_PRIVATE'])assert.ok(!JSON.stringify(result).includes(secret),secret);
});
test('Sparse malformed legacy records do not crash or get widened into independent scope',()=>{
  const a={data:{projects:[],delegations:[null,{id:'missing',projectId:'gone'},{id:'numeric',projectId:0}],tasks:[null,{id:'t',agentJobId:'gone'},{id:'bad',projectId:0}],sources:[null,{id:'s',projectId:0}],artifacts:[null],agentActions:[null],decisions:[null]}};
  const r=snapshot(a,{projectId:'@independent'});assert.equal(Object.values(r.counts).reduce((n,v)=>n+v,0),0);assert.doesNotThrow(()=>exportReport(a,{format:'md'}));
});
test('Public dispatch returns deterministic local snapshots and rejects unsupported export formats',()=>{
  const a=fixture();assert.equal(dispatch(a,'briefingSnapshot').counts.deliveries,1);assert.equal(dispatch(a,'briefingExport',{format:'json'}).mime,'application/json');assert.equal(dispatch(a,'briefingExport',{format:'md'}).mime,'text/markdown');assert.throws(()=>dispatch(a,'briefingExport',{format:'txt'}));
});
