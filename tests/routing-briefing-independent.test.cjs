const {test}=require('node:test');
const assert=require('node:assert/strict');
const {snapshot,exportReport}=require('../desktop/briefing.cjs');
const NOW=Date.parse('2026-10-02T15:59:59.500Z');
const at=ms=>new Date(NOW+ms).toISOString();
function fixture(){return {data:{projects:[{id:'p',name:'项目甲'},{id:'q',name:'项目乙'}],delegations:[{id:'j',projectId:'p',title:'委托甲',followups:[]}],tasks:[{id:'t',projectId:'p',agentJobId:'j',title:'事项甲',status:'completed',sourceIds:['s'],completedAt:at(-1000),verification:{passed:true,gaps:[]},steps:[{kind:'draft',done:true,artifactId:'v'},{kind:'external',tool:'write_file',done:true,artifactId:'v',evidence:'{"actionId":"new"}'}]}],sources:[{id:'s',projectId:'p',title:'材料甲',content:'PRIVATE_BODY',createdAt:at(-2000)}],artifacts:[{id:'v',taskId:'t',title:'文稿甲',content:'PRIVATE_DELIVERY',createdAt:at(-1200)}],agentActions:[{id:'old',jobId:'j',taskId:'t',artifactId:'v',tool:'write_file',status:'done',finishedAt:at(-3000),result:{verified:true}},{id:'new',jobId:'j',taskId:'t',artifactId:'v',tool:'write_file',status:'done',finishedAt:at(-1500),result:{verified:true}}],decisions:[]}};}

test('Independent briefing audit: explicit action receipt takes precedence when an artifact is delivered twice',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture(),r=snapshot(a);
  assert.equal(r.counts.deliveries,2);assert.equal(r.sections.deliveries.items.find(r=>r.id==='action:new').current,true);assert.equal(r.sections.deliveries.items.find(r=>r.id==='action:old').current,false);assert.equal(r.completionCounts.checked,1);
});
test('Independent briefing audit: an explicit missing or failed receipt cannot fall back to an old successful artifact',t=>{
  t.mock.method(Date,'now',()=>NOW);
  for(const mutation of [a=>a.data.agentActions=a.data.agentActions.filter(r=>r.id!=='new'),a=>a.data.agentActions.find(r=>r.id==='new').status='failed']){const a=fixture();mutation(a);const r=snapshot(a);assert.equal(r.completionCounts.checked,0);assert.equal(r.completionCounts.unverified,1);assert.equal(r.sections.deliveries.items.some(r=>r.current),false);}
});
test('Independent briefing audit: malformed historical steps fail closed for completion',t=>{
  t.mock.method(Date,'now',()=>NOW);
  for(const steps of [[{kind:'draft',done:true,artifactId:'v'},null],[{kind:'unknown',done:true,artifactId:'v'}],[{kind:'draft',done:'yes',artifactId:'v'}]]){const a=fixture();a.data.tasks[0].steps=steps;assert.equal(snapshot(a).completionCounts.checked,0);assert.equal(snapshot(a).completionCounts.unverified,1);}
});
test('Independent briefing audit: rolling ranges include exact boundaries across local midnight',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.sources=[-86400001,-86400000,-1,0,1].map((delta,i)=>({id:String(i),projectId:'p',title:String(delta),createdAt:at(delta)}));
  const r=snapshot(a,{projectId:'p',range:'24h',pageSize:1,pages:{materials:2}});assert.equal(r.counts.materials,3);assert.equal(r.sections.materials.items[0].title,'-1');assert.equal(r.sections.materials.pageCount,3);const exported=JSON.parse(exportReport(a,{format:'json',projectId:'p',range:'24h',pageSize:1,pages:{materials:2}}).content);assert.equal(exported.sections.materials.items.length,3);assert.equal(exported.counts.materials,3);assert.equal(exported.projectId,undefined);assert.ok(exported.sections.materials.items.every(r=>!r.route&&!r.id));
});
test('Independent briefing audit: foreign source replacement and approval do not alter a scoped report',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.tasks[0].steps[1].evidence='{"actionId":"old"}';const before=snapshot(a,{projectId:'p'});
  a.data.sources.push({id:'foreign',projectId:'q',previousSourceId:'s',title:'FOREIGN_TITLE',content:'FOREIGN_BODY',createdAt:at(-100)});a.data.delegations.push({id:'foreign-job',projectId:'q',title:'FOREIGN_JOB'});a.data.agentActions.push({id:'forged',jobId:'foreign-job',taskId:'t',tool:'write_file',status:'pending',createdAt:at(-50)});
  const after=snapshot(a,{projectId:'p'});assert.equal(after.completionCounts.checked,before.completionCounts.checked);assert.equal(after.counts.materials,before.counts.materials);assert.equal(after.counts.decisions,0);assert.ok(!JSON.stringify(after).includes('FOREIGN'));
});
test('Independent briefing audit: legacy missing dates stay excluded while current followups remain visible',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.agentActions.forEach(r=>delete r.finishedAt);delete a.data.tasks[0].completedAt;a.data.sources[0].createdAt='invalid';a.data.delegations[0].status='paused';a.data.delegations[0].followups=[{key:'f',status:'waiting',taskId:'t',createdAt:at(-40*86400000),deadlineAt:at(0),checkAt:at(1000)}];const r=snapshot(a,{range:'24h'});
  assert.equal(r.counts.deliveries,0);assert.equal(r.counts.completions,0);assert.equal(r.counts.materials,0);assert.equal(r.counts.followups,1);assert.equal(r.sections.followups.items[0].overdue,true);assert.equal(r.sections.followups.items[0].paused,true);assert.match(r.notices.join(' '),/4 条/);
});
test('Independent briefing audit: read-only exports omit bodies, credentials and local locations',t=>{
  t.mock.method(Date,'now',()=>NOW);const a=fixture();a.data.tasks[0].title='报告 TOKEN_PRIVATE /Users/alice/project/out';a.data.providers=[{sealedKey:{value:'TOKEN_PRIVATE'},baseUrl:'https://private.example/v1'}];a.data.sources[0].title='http://private.example/path?key=PRIVATE_QUERY';a.data.agentSettings={outputFolder:'/srv/private-work'};a.data.artifacts[0].title='历史 /srv/private-work/output.md';a.data.tasks[0].status='review';const before=JSON.stringify(a.data);
  for(const format of ['json','md']){const out=exportReport(a,{format});for(const key of ['PRIVATE_BODY','PRIVATE_DELIVERY','TOKEN_PRIVATE','/Users/alice','PRIVATE_QUERY','/srv/private-work'])assert.ok(!out.content.includes(key),key);}assert.equal(JSON.stringify(a.data),before);
});
