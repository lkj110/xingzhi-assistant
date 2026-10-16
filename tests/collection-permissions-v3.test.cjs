'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
const policy=require('../desktop/access-policy-store.cjs');
const collection=require('../desktop/collection-permissions.cjs');
const observations=require('../desktop/source-observations.cjs');
const recovery=require('../desktop/recovery.cjs');
const trusted={trusted:true,actor:'user_command',command:'test_explicit_revoke'};

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collection-policy-v3-'));
  let external=0;
  const forbidden=async()=>{external++;throw Error('External/model calls forbidden');};
  const options={dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden};
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});assert.equal(external,0);});
  const a=new Assistant(options);
  await a.dispatch('projectSave',{name:'Local collection fixture'});
  const projectId=a.data.projects[0].id;
  async function add(){
    await a.dispatch('feedConnectionSave',{name:'Explicit collection',url:'https://example.invalid/feed.xml',projectId,enabled:false,intervalMinutes:30});
    return a.data.feedConnections[0];
  }
  function raw(id='untrusted'){
    const c={id,name:id,url:'https://example.invalid/'+id+'.xml',projectId,enabled:false,intervalMinutes:30};
    a.data.feedConnections.push(c);return c;
  }
  return {a,add,raw,restart:()=>new Assistant(options)};
}
function request(c,operation='local_retention'){return {...collection.spec('feed',c),operation};}
function snapshot(id,scope={}){return {principalScope:policy.LOCAL,resourceScope:{kind:'snapshot',key:'source:'+id,...scope},operations:['local_retention','local_read']};}
function checked(a,c,id='new-source',content='Exact synthetic bytes'){
  const source={id,title:id,content,projectId:c.projectId,resourceKey:'feed:'+c.url+':entry',url:'https://example.invalid/entry'};
  const check=observations.observe(a,source,{channel:'feed',trustedInput:true,scope:{projectId:c.projectId}});
  assert.equal(check.allowInput,true);
  return {source,check};
}
function ingest(a,c,id,content,token){
  const {source,check}=checked(a,c,id,content);
  return collection.attach(a,'feed',c,source,check,token);
}
function assertDenied(a,id){
  for(const operation of ['local_retention','local_read'])assert.equal(policy.check(a,{...snapshot(id),operation}).allowed,false);
  const source=a.publicState().sources.find(s=>s.id===id);
  if(source){assert.equal(source.content,'');assert.deepEqual(source.segments,[]);}
}

test('explicit collector retains exact new versions across restart, without granting arbitrary snapshots',async t=>{
  const {a,add,restart}=await fixture(t),c=await add();
  const first=ingest(a,c,'first','First exact bytes');
  const second=ingest(a,c,'second','Second exact bytes');
  assert.notEqual(first.id,second.id);
  const sequence=policy.inventory(a).sequence;
  assert.equal(ingest(a,c,'second','Second exact bytes').id,second.id);
  assert.equal(policy.inventory(a).sequence,sequence);
  assertDenied(a,'never-created');a.save();
  const reopened=restart();
  for(const row of [first,second])assert.equal(reopened.publicState().sources.find(s=>s.id===row.id).content,row.content);
});

test('revoked collector refuses new retention even when response began before revocation',async t=>{
  const {a,add}=await fixture(t),c=await add(),token=collection.begin(a,'feed',c);
  policy.revoke(a,collection.spec('feed',c),trusted);
  const sequence=policy.inventory(a).sequence,row=ingest(a,c,'late','Late bytes',token);
  assert.equal(policy.check(a,request(c)).decision,'revoked');
  assert.equal(row.accessPolicyQuarantined,true);assertDenied(a,row.id);
  assert.equal(policy.inventory(a).sequence,sequence);
});

test('raw collector configuration and ordinary save/restart cannot create a retention grant',async t=>{
  const {a,raw,restart}=await fixture(t),c=raw();a.save();
  const reopened=restart(),current=reopened.data.feedConnections.find(r=>r.id===c.id);
  assert.equal(policy.check(reopened,request(current)).decision,'unknown');
  const sequence=policy.inventory(reopened).sequence,row=ingest(reopened,current,'unknown');
  assertDenied(reopened,row.id);assert.equal(policy.inventory(reopened).sequence,sequence);
});

for(const damage of ['missing','corrupt'])test(`${damage} completed policy store cannot mint retention from current collector fields`,async t=>{
  const {a,add,restart}=await fixture(t),c=await add();a.save();
  const file=policy.locations(a).store;
  if(damage==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,'damaged policy');
  const reopened=restart(),current=reopened.data.feedConnections.find(r=>r.id===c.id);
  assert.equal(policy.check(reopened,request(current)).decision,'unknown');
  const row=ingest(reopened,current,'unknown-'+damage);assertDenied(reopened,row.id);
  if(damage==='missing')assert.equal(fs.existsSync(file),false);else assert.equal(fs.readFileSync(file,'utf8'),'damaged policy');
});

test('specific snapshot revocation wins over an authorized collector and cannot be reattached',async t=>{
  const {a,add}=await fixture(t),c=await add(),row=ingest(a,c,'withdrawn');
  const input=checked(a,c,row.id,row.content);
  policy.revoke(a,snapshot(row.id),trusted);assertDenied(a,row.id);
  a.data.sources=a.data.sources.filter(s=>s.id!==row.id);
  const sequence=policy.inventory(a).sequence;
  assert.throws(()=>collection.attach(a,'feed',c,input.source,input.check),/撤回/);
  assert.equal(a.data.sources.some(s=>s.id===row.id),false);
  assert.equal(policy.check(a,request(c)).allowed,true);
  assert.equal(policy.inventory(a).sequence,sequence);
});

test('restoring an older authorized backup cannot reverse collector or snapshot revocation',async t=>{
  const {a,add}=await fixture(t),c=await add(),row=ingest(a,c,'backed-up');a.save();
  const backup=recovery.create(a,'before-revoke');
  policy.revoke(a,collection.spec('feed',c),trusted);policy.revoke(a,snapshot(row.id),trusted);a.save();
  const sequence=policy.inventory(a).sequence;
  await a.dispatch('backupRestore',{id:backup});
  assert.equal(policy.check(a,request(c)).decision,'revoked');assertDenied(a,row.id);
  const current=a.data.feedConnections.find(r=>r.id===c.id);
  const later=ingest(a,current,'after-restore','Fresh bytes after old backup');assertDenied(a,later.id);
  assert.equal(policy.inventory(a).sequence,sequence);
});

test('automatic old-backup recovery with a missing policy store never imports collection authorization',async t=>{
  const {a,add,restart}=await fixture(t),c=await add(),row=ingest(a,c,'old-source');a.save();
  recovery.create(a,'authorized-old-backup');
  fs.unlinkSync(policy.locations(a).store);fs.writeFileSync(a.file,'damaged workspace');
  const reopened=restart();assert.equal(reopened.recoveryFromBackup,true);
  assert.equal(policy.check(reopened,request(c)).decision,'unknown');assertDenied(reopened,row.id);
  assert.equal(fs.existsSync(policy.locations(reopened).store),false);
});

test('collection permission cannot retain another project or authorize another collector',async t=>{
  const {a,add,raw}=await fixture(t),c=await add(),other=raw('other-collector');
  const input=checked(a,c,'wrong-project');input.source.projectId='foreign-project';
  const sequence=policy.inventory(a).sequence;
  assert.throws(()=>collection.attach(a,'feed',c,input.source,input.check),/项目/);
  assert.equal(a.data.sources.some(s=>s.id==='wrong-project'),false);
  assert.equal(policy.check(a,request(other)).allowed,false);
  assertDenied(a,ingest(a,other,'other-source').id);
  assert.equal(policy.inventory(a).sequence,sequence);
});

test('standalone snapshot retention does not grant any job or task scope',async t=>{
  const {a,add}=await fixture(t),c=await add(),row=ingest(a,c,'standalone');
  assert.equal(a.contextAccessCheck({objectType:'source',objectId:row.id}).allowed,true);
  for(const scope of [{jobId:'foreign-job'},{taskId:'foreign-task'},{jobId:'foreign-job',taskId:'foreign-task'}]){
    assert.equal(a.contextAccessCheck({objectType:'source',objectId:row.id,...scope}).allowed,false);
    for(const operation of ['local_retention','local_read'])assert.equal(policy.check(a,{...snapshot(row.id,scope),operation}).allowed,false);
  }
});

test('a collector response cannot use a changed project scope after explicit reconfiguration',async t=>{
  const {a,add}=await fixture(t),c=await add(),token=collection.begin(a,'feed',c),before=structuredClone(c);
  const input=checked(a,c,'old-scope');
  c.projectId='new-project';collection.configure(a,'feed',c,{before,trusted:true,command:'test_explicit_reconfigure'});
  const sequence=policy.inventory(a).sequence;
  assert.throws(()=>collection.attach(a,'feed',c,input.source,input.check,token),/范围已变化/);
  assert.equal(a.data.sources.some(s=>s.id==='old-scope'),false);
  assert.equal(policy.check(a,request(before)).allowed,false);assert.equal(policy.check(a,request(c)).allowed,true);
  assert.equal(policy.inventory(a).sequence,sequence);
});

test('createTask grants its own scope without reauthorizing revoked or unknown collectors',async t=>{
  const {a,add,raw}=await fixture(t),revoked=await add(),unknown=raw();
  policy.revoke(a,collection.spec('feed',revoked),trusted);
  const before=[revoked,unknown].map(c=>policy.check(a,request(c)));
  const task=a.createTask({title:'Unrelated explicit manual task'});a.save();
  assert.equal(policy.check(a,{principalScope:policy.LOCAL,resourceScope:{kind:'model',key:'app',taskId:task.id},operation:'model_request'}).allowed,true);
  for(const [i,c]of [revoked,unknown].entries()){
    const after=policy.check(a,request(c));assert.equal(after.allowed,false);
    assert.equal(after.decision,before[i].decision);assert.equal(after.grantRevision,before[i].grantRevision);
    assertDenied(a,ingest(a,c,'after-task-'+c.id).id);
  }
});
