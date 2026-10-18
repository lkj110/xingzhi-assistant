'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Assistant}=require('../desktop/core.cjs');
function setup(t,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b3-commit-'));
 const denied=async()=>{throw Error('B3 forbids external calls');};
 const a=new Assistant({dir,chat:denied,agentRequest:denied,connectorRequest:denied,officeRequest:denied,webRequest:denied,feedRequest:denied,...extra});
 t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});return a;
}
function disk(a){return JSON.parse(fs.readFileSync(a.file,'utf8'));}
function inject(a,stage){
 const key={write:'writeFileSync',fsync:'fsyncSync',rename:'renameSync',after:'readFileSync'}[stage],original=fs[key],open=fs.openSync;let fired=false,workspaceFd;
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===a.file+'.tmp')workspaceFd=fd;return fd;};
 fs[key]=function(file,...args){
  const hit=stage==='rename'?args[0]===a.file:stage==='after'?file===path.join(a.dir,'action-ledger.json'):workspaceFd!==undefined&&file===workspaceFd;
  if(!fired&&hit){fired=true;throw Object.assign(Error('B3 injected '+stage),{code:stage==='after'?'EIO':'ENOSPC'});}
  return original.call(this,file,...args);
 };
 return ()=>{fs[key]=original;fs.openSync=open;assert.equal(fired,true,'must reach intended fault boundary');};
}
for(const stage of ['write','fsync','rename'])test('ordinary resume '+stage+' failure restores RAM references and later saves',async t=>{
 const a=setup(t);await a.dispatch('createTask',{title:'resume',criteria:'fixed'});const task=a.data.tasks[0];await a.dispatch('taskAction',{id:task.id,command:'pause'});
 const before=structuredClone(a.data),events=a.data.events,tasks=a.data.tasks;const restore=inject(a,stage);
 try{await assert.rejects(a.dispatch('uiCommand',{action:'taskAction',input:{id:task.id,command:'resume'}}),e=>e.code==='ENOSPC'&&e.committed===false);}finally{restore();}
 assert.equal(a.data.tasks,tasks);assert.equal(a.data.tasks[0],task);assert.equal(a.data.events,events);assert.deepEqual(a.data,before);assert.equal(disk(a).tasks[0].status,'paused');
 await a.dispatch('settings',{profile:'unrelated'});assert.equal(disk(a).tasks[0].status,'paused');
 const cold=new Assistant({dir:a.dir,chat:async()=>{throw Error('no chat');}});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(cold));assert.equal(cold.data.tasks[0].status,'paused');
 await cold.dispatch('taskAction',{id:task.id,command:'resume'});assert.equal(cold.data.tasks[0].status,'todo');
});
test('afterSave failure retains committed task and code across unrelated save and cold load',async t=>{
 const a=setup(t);await a.dispatch('createTask',{title:'resume'});const task=a.data.tasks[0];await a.dispatch('taskAction',{id:task.id,command:'pause'});const revision=a.data.runtime.revision,restore=inject(a,'after');
 try{await assert.rejects(a.dispatch('taskAction',{id:task.id,command:'resume'}),e=>e.code==='EIO'&&e.committed===true);}finally{restore();}
 assert.equal(task.status,'todo');assert.equal(disk(a).tasks[0].status,'todo');assert.equal(a.data.runtime.revision,revision+1);
 await a.dispatch('settings',{profile:'later'});const cold=new Assistant({dir:a.dir});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(cold));assert.equal(cold.data.tasks[0].status,'todo');
});
module.exports={setup,inject,disk};
for(const action of ['settings','deleteProvider','saveProvider','updateTask','pause','retry'])test('selected ordinary '+action+' restores all RAM on failure',async t=>{
 const a=setup(t);await a.dispatch('saveProvider',{name:'local',model:'fixture',baseUrl:'https://example.invalid'});await a.dispatch('createTask',{title:'task'});
 const task=a.data.tasks[0];if(action==='retry'){task.status='blocked';a.save();}
 const before=structuredClone(a.data),restore=inject(a,'rename');
 const commands={settings:['settings',{profile:'changed'}],deleteProvider:['deleteProvider',{id:a.data.providers[0].id}],saveProvider:['saveProvider',{id:a.data.providers[0].id,name:'changed',model:'fixture',baseUrl:'https://example.invalid'}],updateTask:['updateTask',{id:task.id,priority:'high'}],pause:['taskAction',{id:task.id,command:'pause'}],retry:['taskAction',{id:task.id,command:'retry'}]};
 try{await assert.rejects(a.dispatch(...commands[action]),e=>e.code==='ENOSPC'&&e.committed===false);}finally{restore();}
 assert.deepEqual(a.data,before);assert.equal(a.data.tasks[0],task);await a.dispatch('settings',{profile:'later'});assert.equal(disk(a).tasks[0].status,before.tasks[0].status);
});
for(const change of ['unrelated','edit','delete'])test('provider await never rolls back concurrent '+change+' success',async t=>{
 let release,entered;const reached=new Promise(r=>{entered=r;});
 const a=setup(t,{vault:{open:()=>'',seal:async()=>{entered();await new Promise(r=>{release=r;});return 'fixture-sealed';}}});
 await a.dispatch('saveProvider',{name:'original',model:'fixture',baseUrl:'https://example.invalid'});const id=a.data.providers[0].id;
 const pending=a.dispatch('saveProvider',{id,name:'awaiting',model:'fixture',baseUrl:'https://example.invalid',key:'synthetic-only'});const outcome=pending.then(value=>({value}),error=>({error}));await reached;
 if(change==='unrelated')await a.dispatch('createTask',{title:'concurrent success'});
 if(change==='edit')await a.dispatch('saveProvider',{id,name:'concurrent success',model:'fixture',baseUrl:'https://example.invalid'});
 if(change==='delete')await a.dispatch('deleteProvider',{id});
 const before=structuredClone(a.data),restore=change==='unrelated'?inject(a,'rename'):()=>{};release();const result=await outcome;restore();
 assert.equal(result.error.code,change==='unrelated'?'ENOSPC':'STATE_STALE');assert.deepEqual(a.data,before);assert.deepEqual(disk(a),before);
});
test('post-commit public projection failure is committed, not a rollback',async t=>{
 const a=setup(t),original=a.publicState;a.publicState=()=>{throw Object.assign(Error('projection failed'),{code:'B3_VIEW'});};
 await assert.rejects(a.dispatch('settings',{profile:'saved'}),e=>e.code==='B3_VIEW'&&e.committed===true);a.publicState=original;
 assert.equal(disk(a).settings.profile,'saved');assert.equal(a.data.settings.profile,'saved');
});
test('pending journal is replayed before ordinary rollback; durable acceptance survives',async t=>{
 const a=setup(t);await a.dispatch('createTask',{title:'journal'});const task=a.data.tasks[0],journal=require('../desktop/work-journal.cjs');
 let restore=inject(a,'rename');try{assert.throws(()=>journal.commit(a,[{entityKind:'task',entityId:task.id,type:'manual_completed',actor:'user',workRevision:1,payload:{}}]),e=>e.committed===true);}finally{restore();}
 const log=fs.readFileSync(journal.file(a),'utf8');restore=inject(a,'rename');try{await assert.rejects(a.dispatch('settings',{profile:'not committed'}));}finally{restore();}
 assert.equal(fs.readFileSync(journal.file(a),'utf8'),log);assert.equal(task.status,'completed');
 const cold=new Assistant({dir:a.dir});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(cold));assert.equal(cold.data.tasks[0].status,'completed');
});
