'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPhases,waitForHuman,digest}=require('./phases.cjs');
const context=()=>({id:'F03',taskId:'task'});
test('waiting and completed verification forbid model calls, generation cannot repeat',async()=>{
 const c=context(),p=createPhases({snapshot:async()=>({})});p.open('closed',c);
 await assert.rejects(p.admit({role:'execute'},c),/waiting for a person/);
 p.open('work',c);await p.admit({role:'execute'},c);p.observed({kind:'read_context'},{role:'execute'});await p.admit({role:'execute'},c);
 p.observed({kind:'artifact'},{role:'execute'});await assert.rejects(p.admit({role:'execute'},c),/second generation/);await p.admit({role:'verify'},c);
 p.observed({passed:true},{role:'verify'});await assert.rejects(p.admit({role:'verify'},c),/waiting for a person/);
});
test('recheck requires exact current confirmation and unchanged draft; never generates',async()=>{
 const draft={id:'d',title:'Title',content:'Original'},task={id:'task',primaryArtifactId:'d'},data={tasks:[task],artifacts:[draft]},c=context(),p=createPhases({snapshot:async()=>data});
 p.open('recheck',c,{draftHash:digest(draft),reportHash:'r',basis:'b'});
 await assert.rejects(p.admit({role:'verify'},c),/current user confirmation/);
 task.groundingMarkerConfirmation={actor:'user',reportHash:'r',basis:'b',recordHash:'record',confirmedAt:'date'};await p.admit({role:'verify'},c);
 await assert.rejects(p.admit({role:'execute'},c),/cannot generate/);draft.content='Changed';await assert.rejects(p.admit({role:'verify'},c),/Draft changed/);
});
test('human deadline is checked after slow read and before accepting success',async()=>{
 let clock=0;await assert.rejects(waitForHuman({deadline:5,now:()=>clock,guard:async()=>{},read:async()=>{clock=6;return true;},check:x=>x}),{code:'HUMAN_PENDING'});
});
test('human deadline is checked after slow decision; missing answer stays pending',async()=>{
 let clock=0;await assert.rejects(waitForHuman({deadline:5,now:()=>clock,guard:async()=>{},read:async()=>true,check:()=>{clock=5;return true;}}),{code:'HUMAN_PENDING'});
 clock=0;let reads=0;await assert.rejects(waitForHuman({deadline:5,now:()=>clock,guard:async()=>{},read:async()=>++reads,check:()=>false,pause:async ms=>{clock+=ms;}}),{code:'HUMAN_PENDING'});assert.equal(reads,1);
});
test('stop and clock rollback cannot become human acceptance',async()=>{
 await assert.rejects(waitForHuman({deadline:100,now:()=>0,guard:async()=>{throw Error('STOP');},read:async()=>true,check:x=>x}),/STOP/);
 let clock=2;await assert.rejects(waitForHuman({deadline:100,now:()=>clock,guard:async()=>{},read:async()=>{clock=1;return true;},check:x=>x}),/backwards/);
});
test('offline automation rejects live mode before accessing any page',async()=>{
 await assert.rejects(require('./offline-human.cjs').act(null,'accept','task','live'));
});
test('revision independent checkpoint binds the additional user note',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const directory=fs.mkdtempSync(path.join(os.tmpdir(),'marker-checkpoint-'));
 const c=require('./checkpoints.cjs').createCheckpoint({directory,caseId:'F05',stage:'revision',sealIdentity:'a'.repeat(64),input:{title:'T',description:'D',criteria:'C',sources:[{title:'S',content:'Q'}],revisionNote:'Only add this requirement'},draft:{title:'T',content:'Q'}});
 assert.equal(JSON.parse(fs.readFileSync(c.requestPath,'utf8')).input.revisionNote,'Only add this requirement');
});
