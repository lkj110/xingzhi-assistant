'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../desktop/core.cjs'),routing=require('../desktop/intake-routing.cjs');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b3-feedback-')),deny=async()=>{throw Error('No external calls');};const a=new Assistant({dir,chat:deny,agentRequest:deny,connectorRequest:deny,officeRequest:deny,webRequest:deny,feedRequest:deny});t.after(()=>{require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});return a;}
async function input(a){if(!a.data.projects.length)await a.dispatch('projectSave',{name:'test'});return {name:'same name',projectId:a.data.projects[0].id,field:'all',match:'any',keywords:['match'],enabled:true,requestId:crypto.randomUUID(),expectedRevision:(await a.dispatch('intakeRoutingSnapshot')).stateRevision};}
function fault(a,after=false){const key=after?'readFileSync':'renameSync',original=fs[key];let fired=false;fs[key]=function(file,...args){if(!fired&&(after?file===path.join(a.dir,'action-ledger.json'):args[0]===a.file)){fired=true;throw Object.assign(Error('B3 disk fault'),{code:after?'EIO':'ENOSPC'});}return original.call(this,file,...args);};return ()=>{fs[key]=original;assert.ok(fired);};}
for(const command of ['create','edit','toggle','delete'])test('routing '+command+' failed save cannot affect later routing or save',async t=>{
 const a=setup(t);let data=await input(a);if(command!=='create'){await a.dispatch('intakeRoutingSave',data);data=a.data.intakeRoutingRules[0];}
 const args=command==='create'?['intakeRoutingSave',data]:command==='edit'?['intakeRoutingSave',{...data,keywords:['other']}]:command==='toggle'?['intakeRoutingToggle',{id:data.id,revision:data.revision,enabled:false}]:['intakeRoutingDelete',{id:data.id,revision:data.revision}];
 const before=structuredClone(a.data),restore=fault(a);try{await assert.rejects(a.dispatch('uiCommand',{action:args[0],input:args[1]}),e=>e.code==='ENOSPC'&&e.committed===false);}finally{restore();}
 assert.deepEqual(a.data,before);assert.equal(routing.route(a,{title:'match',content:'text'}).projectId,command==='create'?undefined:data.projectId);
 await a.dispatch('settings',{profile:'unrelated'});assert.deepEqual(JSON.parse(fs.readFileSync(a.file)).intakeRoutingRules,before.intakeRoutingRules);
});
test('real API retains committed/code; repeated creation reuses identity across cold restart',async t=>{
 const a=setup(t),old=global.window;t.after(()=>{global.window=old;});
 global.window={assistant:{call:async(action,input)=>{try{return {data:await a.dispatch(action,input)};}catch(e){return {error:e.message,code:e.code,...(typeof e.committed==='boolean'?{committed:e.committed}:{})};}}}};
 const api=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(__dirname,'../src/api.js'),'utf8')).toString('base64'));
 const envelope=await input(a),restore=fault(a,true);try{await assert.rejects(api.call('intakeRoutingSave',envelope),e=>e.code==='EIO'&&e.committed===true);}finally{restore();}
 const revision=a.data.runtime.revision,count=a.data.events.length;const again=await api.call('intakeRoutingSave',envelope);assert.equal(again.reused,true);assert.equal(a.data.intakeRoutingRules.length,1);assert.equal(a.data.events.length,count);assert.equal(a.data.runtime.revision,revision);
 const cold=new Assistant({dir:a.dir});t.after(()=>require('../desktop/deadline-scheduler.cjs').dispose(cold));assert.equal((await cold.dispatch('intakeRoutingSave',envelope)).reused,true);assert.equal(cold.data.intakeRoutingRules.length,1);
});
test('identity binds intent; replay cannot overwrite edited rule or resurrect deleted rule',async t=>{
 const a=setup(t),envelope=await input(a);await Promise.all([a.dispatch('intakeRoutingSave',envelope),a.dispatch('intakeRoutingSave',envelope)]);assert.equal(a.data.intakeRoutingRules.length,1);
 await assert.rejects(a.dispatch('intakeRoutingSave',{...envelope,name:'different'}),e=>e.code==='INTAKE_REQUEST_CONFLICT');
 const row=a.data.intakeRoutingRules[0];await a.dispatch('intakeRoutingSave',{...row,name:'later edit'});await a.dispatch('intakeRoutingSave',envelope);assert.equal(row.name,'later edit');
 await a.dispatch('intakeRoutingDelete',{id:row.id,revision:row.revision});await assert.rejects(a.dispatch('intakeRoutingSave',envelope),e=>e.code==='STATE_STALE');assert.equal(a.data.intakeRoutingRules.length,0);
 await a.dispatch('intakeRoutingSave',await input(a));await a.dispatch('intakeRoutingSave',await input(a));assert.equal(a.data.intakeRoutingRules.length,2,'intentional same-name creations remain legal');
});
test('missing protocol fields and stale creation revision reject with no mutation',async t=>{
 const a=setup(t),good=await input(a),before=structuredClone(a.data);
 for(const patch of [{requestId:undefined},{expectedRevision:undefined},{requestId:'bad'},{expectedRevision:good.expectedRevision-1}]){
  await assert.rejects(a.dispatch('intakeRoutingSave',{...good,...patch}),e=>e.committed===false&&e.code===(patch.expectedRevision===good.expectedRevision-1?'STATE_STALE':'INTAKE_REQUEST_INVALID'));assert.deepEqual(a.data,before);
 }
 const row={id:'legacy',revision:'legacy-rev',name:'legacy',projectId:good.projectId,field:'all',match:'any',keywords:['old'],enabled:false};a.data.intakeRoutingRules.push(row);a.save();await a.dispatch('intakeRoutingSave',{...row,name:'legacy edited'});assert.equal(row.name,'legacy edited');
});
test('browser HTTP transport retains error code and known commitment',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b3-http-'));const {server,assistant:a,origin}=await require('../desktop/server.cjs').startServer({dir,port:0,chat:async()=>{throw Error('no models');}});
 t.after(async()=>{await new Promise(r=>server.close(r));require('../desktop/deadline-scheduler.cjs').dispose(a);fs.rmSync(dir,{recursive:true,force:true});});
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],token=(await session.json()).token;
 const restore=fault(a);let result;try{result=await fetch(origin+'/api/call',{method:'POST',headers:{Cookie:cookie,'X-Assistant-Token':token},body:JSON.stringify({action:'uiCommand',input:{action:'settings',input:{profile:'failed'}}})});}finally{restore();}
 const body=await result.json();assert.equal(body.code,'ENOSPC');assert.equal(body.committed,false);
});
