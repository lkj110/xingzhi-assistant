const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Assistant}=require('../desktop/core.cjs'),m=require('../desktop/briefing-schedule.cjs');
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'briefing-schedule-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=new Assistant({dir:path.join(dir,'workspace'),chat:async()=>{throw new Error('No model calls expected');}});const output=path.join(dir,'output');fs.mkdirSync(output);m.setFolder(a,output);return {a,dir,output};}
const config=(a,patch={})=>({...m.snapshot(a),...patch});
test('Daily and weekly scheduling respects explicit timezone',()=>{
 const s={time:'18:00',timeZone:'Asia/Shanghai',cadence:'daily',weekday:1};
 assert.equal(m.nextRun(s,Date.parse('2026-10-03T09:59:40Z')),'2026-10-03T10:00:00.000Z');
 assert.equal(m.nextRun(s,Date.parse('2026-10-03T10:00:00Z')),'2026-10-04T10:00:00.000Z');
 assert.equal(m.nextRun({...s,cadence:'weekly'},Date.parse('2026-10-03T10:00:00Z')),'2026-10-05T10:00:00.000Z');
});
test('DST skips missing times and does not repeat a local day in the repeated hour',()=>{
 const s={time:'02:30',timeZone:'America/New_York',cadence:'daily',weekday:1};
 assert.equal(m.nextRun(s,Date.parse('2026-03-08T05:00:00Z')),'2026-03-09T06:30:00.000Z');
 assert.equal(m.nextRun({...s,time:'01:30'},Date.parse('2026-11-01T05:35:00Z')),'2026-11-02T06:30:00.000Z');
});
test('Manual reports write actual immutable files, verify hashes, and omit material bodies',async t=>{
 const {a,output}=fixture(t);await a.dispatch('import',{items:[{title:'汇总材料',content:'SECRET_SOURCE_BODY'}]});
 let result=await a.dispatch('briefingScheduleRun',{revision:a.data.briefingSchedule.revision});
 assert.equal(result.runs[0].status,'done');const file=m.resultPath(a,result.runs[0].id);assert.ok(file.startsWith(output));assert.match(fs.readFileSync(file,'utf8'),/汇总材料/);assert.ok(!fs.readFileSync(file,'utf8').includes('SECRET_SOURCE_BODY'));assert.equal(result.runs[0].content,undefined);
 result=await a.dispatch('briefingScheduleRun',{revision:result.revision});assert.equal(fs.readdirSync(output).length,2);assert.equal(new Set(result.runs.map(r=>r.filename)).size,2);assert.equal((a.data.modelCalls||[]).length,0);
 fs.appendFileSync(file,'user edit');assert.throws(()=>m.resultPath(a,result.runs[1].id),/修改/);
});
test('Export respects selected scope and JSON format',async t=>{
 const {a}=fixture(t);await a.dispatch('projectSave',{name:'单个项目'});const p=a.data.projects[0];await a.dispatch('import',{items:[{title:'项目材料',content:'one',projectId:p.id},{title:'独立材料',content:'two'}]});
 await a.dispatch('briefingScheduleSave',config(a,{projectId:p.id,format:'json'}));const r=m.run(a).runs[0],body=JSON.parse(fs.readFileSync(m.resultPath(a,r.id),'utf8'));assert.equal(body.counts.materials,1);assert.ok(!JSON.stringify(body).includes('独立材料'));
});
test('No ungranted path or stale config may start a plan',async t=>{
 const {a,dir}=fixture(t),revision=a.data.briefingSchedule.revision;
 await assert.rejects(a.dispatch('briefingScheduleSave',config(a,{enabled:true,time:'25:10'})),/参数/);
 await assert.rejects(a.dispatch('briefingScheduleSave',config(a,{timeZone:'Invalid/Zone'})),/时区/);
 await assert.rejects(a.dispatch('briefingScheduleSave',config(a,{projectId:null})),/项目/);
 await a.dispatch('briefingScheduleSave',config(a,{folder:dir,enabled:true}));assert.notEqual(a.data.briefingSchedule.folder,dir);
 await assert.rejects(a.dispatch('briefingScheduleRun',{revision}),/变化/);
 assert.equal(a.data.briefingSchedule.enabled,true);
});
test('Global pause, automatic window and busy operation prevent scheduled save',t=>{
 const {a,output}=fixture(t);m.save(a,config(a,{enabled:true}));a.data.briefingSchedule.nextRunAt=new Date(Date.now()-86400000).toISOString();
 a.data.stewardship.paused=true;assert.equal(m.tick(a),false);a.data.stewardship.paused=false;a.suspended=true;assert.equal(m.tick(a),false);a.suspended=false;a.operation={};assert.equal(m.tick(a),false);a.operation=null;assert.equal(fs.readdirSync(output).length,0);
 a.stop();assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(a.data.briefingSchedule.nextRunAt,null);
});
test('Missed scheduled periods coalesce to one fresh report with future next run',async t=>{
 const {a,output}=fixture(t);m.save(a,config(a,{enabled:true}));a.data.briefingSchedule.nextRunAt=new Date(Date.now()-7*86400000).toISOString();assert.equal(m.tick(a),true);await a.runPromise;assert.equal(fs.readdirSync(output).length,1);assert.ok(Date.parse(a.data.briefingSchedule.nextRunAt)>Date.now());assert.equal(m.tick(a),false);
});
test('A replaced directory stops automatic retries without writing elsewhere',async t=>{
 const {a,output}=fixture(t);m.save(a,config(a,{enabled:true}));fs.renameSync(output,output+'-old');fs.mkdirSync(output);a.data.briefingSchedule.nextRunAt=new Date(Date.now()-1000).toISOString();assert.equal(m.tick(a),true);await a.runPromise;assert.equal(a.data.briefingSchedule.enabled,false);assert.ok(a.data.briefingSchedule.error);assert.equal(fs.readdirSync(output).length,0);assert.equal(m.tick(a),false);
});
test('Failed writes retain exact planned content and retry the same path without duplication',t=>{
 const {a,output}=fixture(t),open=fs.openSync;let fail=true;
 fs.openSync=(file,...args)=>{if(String(file).startsWith(output+path.sep)&&args[0]==='wx'&&fail){fail=false;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return open(file,...args);};
 try{m.run(a);}finally{fs.openSync=open;}
 const r=a.data.briefingSchedule.runs[0];assert.equal(r.status,'failed');assert.equal(a.publicState().briefingSchedule.runs[0].content,undefined);const body=r.content;
 fs.writeFileSync(path.join(output,r.filename),body);m.run(a,{retryId:r.id});assert.equal(r.status,'done');assert.equal(fs.readdirSync(output).length,1);assert.equal(fs.readFileSync(path.join(output,r.filename),'utf8'),body);
});
test('Crash after the external file is written retries by readback after restart',t=>{
 const {a,output}=fixture(t),save=a.save.bind(a);let count=0;
 a.save=()=>{if(++count===2)throw new Error('commit interrupted');return save();};
 assert.throws(()=>m.run(a),/commit interrupted/);assert.equal(fs.readdirSync(output).length,1);
 const reopened=new Assistant({dir:a.dir});const r=reopened.data.briefingSchedule.runs[0];assert.equal(r.status,'interrupted');assert.equal(reopened.data.briefingSchedule.enabled,false);m.run(reopened,{retryId:r.id});assert.equal(r.status,'done');assert.equal(fs.readdirSync(output).length,1);
});
test('Conflicting existing files and symlinks remain untouched; discard allows a new report',async t=>{
 const {a,output,dir}=fixture(t),open=fs.openSync;let once=true;
 fs.openSync=(file,...args)=>{if(String(file).startsWith(output+path.sep)&&args[0]==='wx'&&once){once=false;fs.writeFileSync(file,'manual content');}return open(file,...args);};try{m.run(a);}finally{fs.openSync=open;}
 const r=a.data.briefingSchedule.runs[0];assert.equal(r.status,'failed');assert.equal(fs.readFileSync(path.join(output,r.filename),'utf8'),'manual content');assert.throws(()=>m.run(a),/核对/);
 const target=path.join(dir,'secret');fs.writeFileSync(target,'untouched');fs.unlinkSync(path.join(output,r.filename));fs.symlinkSync(target,path.join(output,r.filename));m.run(a,{retryId:r.id});assert.equal(r.status,'failed');assert.equal(fs.readFileSync(target,'utf8'),'untouched');
 await a.dispatch('briefingScheduleDiscard',{revision:a.data.briefingSchedule.revision,id:r.id});assert.equal(r.status,'abandoned');assert.equal(r.content,undefined);m.run(a);assert.equal(fs.readdirSync(output).length,2);
});
test('Restoring old work retains later report receipts and current folder but pauses the plan',async t=>{
 const {a,output}=fixture(t),backup=(await a.dispatch('backupCreate'))[0].id;m.save(a,config(a,{enabled:true}));m.run(a);const id=a.data.briefingSchedule.runs[0].id;
 await a.dispatch('backupRestore',{id:backup});assert.equal(a.data.briefingSchedule.folder,output);assert.equal(a.data.briefingSchedule.runs[0].id,id);assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(fs.readdirSync(output).length,1);
});
test('Reports cannot feed the same collection directory and do not run while busy',async t=>{
 const {a,output}=fixture(t);a.data.folders.push({id:'f',path:output});assert.throws(()=>m.setFolder(a,output),/独立目录/);m.run(a);assert.equal(a.data.briefingSchedule.runs[0].status,'failed');assert.equal(fs.readdirSync(output).length,0);
 a.operation={};await assert.rejects(a.dispatch('briefingScheduleRun',{revision:a.data.briefingSchedule.revision}),/正在处理/);
});
test('Configuration and folder grant failures roll back both state and persisted configuration',t=>{
 const {a,dir}=fixture(t),before=structuredClone(a.data.briefingSchedule),save=a.save.bind(a);let calls=0;
 a.save=()=>{save();if(++calls===1)throw new Error('secondary ledger failed');};
 assert.throws(()=>m.save(a,config(a,{enabled:true,time:'09:12'})),/secondary ledger/);assert.deepEqual(a.data.briefingSchedule,before);assert.deepEqual(JSON.parse(fs.readFileSync(a.file,'utf8')).briefingSchedule,before);
 const another=path.join(dir,'another');fs.mkdirSync(another);a.save=()=>{throw new Error('disk unavailable');};
 assert.throws(()=>m.setFolder(a,another),/disk unavailable/);assert.deepEqual(a.data.briefingSchedule,before);a.save=save;
});
test('Pause and discard persistence failures never lose the prior configuration or retry body',async t=>{
 const {a,output}=fixture(t);m.save(a,config(a,{enabled:true}));const save=a.save.bind(a),before=structuredClone(a.data.briefingSchedule);a.save=()=>{throw new Error('disk unavailable');};
 await assert.rejects(a.dispatch('briefingSchedulePause',{revision:before.revision}),/disk unavailable/);assert.deepEqual(a.data.briefingSchedule,before);a.save=save;
 const open=fs.openSync;fs.openSync=(file,...args)=>{if(String(file).startsWith(output+path.sep)&&args[0]==='wx')throw Object.assign(new Error('full'),{code:'ENOSPC'});return open(file,...args);};try{m.run(a);}finally{fs.openSync=open;}
 const failed=structuredClone(a.data.briefingSchedule),events=structuredClone(a.data.events);a.save=()=>{throw new Error('disk unavailable');};
 await assert.rejects(a.dispatch('briefingScheduleDiscard',{revision:failed.revision,id:failed.runs[0].id}),/disk unavailable/);assert.deepEqual(a.data.briefingSchedule,failed);assert.deepEqual(a.data.events,events);a.save=save;
});
test('Final receipt failure can be retried in the same live process without creating another file',t=>{
 const {a,output}=fixture(t),save=a.save.bind(a);let count=0;a.save=()=>{if(++count===2)throw new Error('receipt failed');return save();};
 assert.throws(()=>m.run(a),/receipt failed/);const r=a.data.briefingSchedule.runs[0];assert.equal(r.status,'interrupted');assert.equal(typeof r.content,'string');assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(a.data.briefingSchedule.nextRunAt,null);assert.ok(!a.data.events.some(e=>e.title==='工作简报已保存'));
 const files=fs.readdirSync(output),body=fs.readFileSync(path.join(output,files[0]),'utf8');a.save=save;m.run(a,{retryId:r.id});assert.equal(r.status,'done');assert.equal(r.content,undefined);assert.deepEqual(fs.readdirSync(output),files);assert.equal(fs.readFileSync(path.join(output,files[0]),'utf8'),body);
});
test('A failed planned-body save writes no destination file and preserves a recoverable attempt',t=>{
 const {a,output}=fixture(t),save=a.save.bind(a);a.save=()=>{throw new Error('workspace full');};assert.throws(()=>m.run(a),/workspace full/);
 const r=a.data.briefingSchedule.runs[0];assert.equal(r.status,'interrupted');assert.equal(typeof r.content,'string');assert.equal(fs.readdirSync(output).length,0);assert.match(a.data.briefingSchedule.error,/尚未写入/);a.save=save;m.run(a,{retryId:r.id});assert.equal(r.status,'done');assert.equal(fs.readdirSync(output).length,1);
});
test('Changing directory authorization prevents retry or opening a receipt from the previous directory',t=>{
 const {a,output,dir}=fixture(t),done=m.run(a).runs[0],next=path.join(dir,'next');fs.mkdirSync(next);m.setFolder(a,next);assert.throws(()=>m.resultPath(a,done.id),/授权已改变/);
 const open=fs.openSync;fs.openSync=(file,...args)=>{if(String(file).startsWith(next+path.sep)&&args[0]==='wx')throw Object.assign(new Error('full'),{code:'ENOSPC'});return open(file,...args);};try{m.run(a);}finally{fs.openSync=open;}
 const failed=a.data.briefingSchedule.runs[0];m.setFolder(a,output);m.run(a,{retryId:failed.id});assert.equal(failed.status,'failed');assert.match(failed.error,/授权已改变/);assert.equal(fs.readdirSync(next).length,0);assert.equal(fs.readdirSync(output).length,1);
});
test('Missing project disables an automatic plan after one attempt without repeated launches',async t=>{
 const {a,output}=fixture(t);await a.dispatch('projectSave',{name:'即将移除'});const p=a.data.projects[0];m.save(a,config(a,{enabled:true,projectId:p.id}));a.data.projects=[];a.data.briefingSchedule.nextRunAt=new Date(Date.now()-1000).toISOString();assert.equal(m.tick(a),true);await a.runPromise;assert.equal(a.data.briefingSchedule.enabled,false);assert.equal(m.tick(a),false);assert.equal(fs.readdirSync(output).length,0);
});
test('Weekly DST gap skips only the missing occurrence and fractional offsets retain wall-clock time',()=>{
 const s={time:'02:30',timeZone:'America/New_York',cadence:'weekly',weekday:0};assert.equal(m.nextRun(s,Date.parse('2026-03-08T05:00:00Z')),'2026-03-15T06:30:00.000Z');
 assert.equal(m.nextRun({...s,cadence:'daily',time:'09:30',timeZone:'Asia/Kathmandu'},Date.parse('2026-10-03T03:44:59Z')),'2026-10-03T03:45:00.000Z');
});
