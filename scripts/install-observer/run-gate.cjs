'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {parse,envelope,analyze,SUBSCRIPTIONS}=require('./analyze.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const need=(v,c)=>{if(!v)throw Error(c);};
function prefix(rows,session,now=Date.now()){
 need(rows.length&&rows[0].kind==='begin','NO_BEGIN');
 const allowed=new Set(['begin','subscribed','ready','heartbeat','start','stop']);
 let previous=-1;const subscribed=new Set();
 for(const [i,row] of rows.entries()){
  need(row.session===session&&row.seq===i+1,'LOG_IDENTITY_OR_SEQUENCE');
  need(row.kind!=='fault'&&row.kind!=='closed'&&row.kind!=='closing'&&row.kind!=='subscriptionStopped'&&row.kind!=='cancelTest','OBSERVER_NOT_HEALTHY');
  need(row.kind!=='begin'||i===0,'DUPLICATE_BEGIN');
  need(allowed.has(row.kind),'UNKNOWN_EVENT');
  need(Number.isSafeInteger(row.monoMs)&&row.monoMs>=previous,'MONOTONIC_CLOCK');previous=row.monoMs;
  if(row.kind==='subscribed'){need(SUBSCRIPTIONS.includes(row.subscription)&&!subscribed.has(row.subscription),'SUBSCRIPTION_IDENTITY');subscribed.add(row.subscription);}
 }
 const ready=rows.filter(e=>e.kind==='ready'),beats=rows.filter(e=>e.kind==='heartbeat');
 need(ready.length===1&&subscribed.size===4&&rows.filter(e=>e.kind==='subscribed').every(e=>e.seq<ready[0].seq)&&JSON.stringify(ready[0].subscriptions)===JSON.stringify(SUBSCRIPTIONS),'NOT_READY');
 const health=[ready[0],...beats];need(health.every((e,i)=>i===0||e.seq>health[i-1].seq&&e.monoMs-health[i-1].monoMs<=3500),'HEARTBEAT_GAP');
 const last=beats.at(-1);need(last?.healthy===true&&Number.isFinite(Date.parse(last.at))&&now-Date.parse(last.at)<2500&&now-Date.parse(last.at)>=-1000,'HEARTBEAT_NOT_FRESH');
 return true;
}
function plain(dir){for(let p=path.resolve(dir);;p=path.dirname(p)){need(!fs.lstatSync(p).isSymbolicLink(),'REPARSE_PATH');if(path.dirname(p)===p)break;}}
function log(dir){
 const file=path.join(dir,'events.jsonl');if(!fs.existsSync(file))return [];
 need(!fs.lstatSync(file).isSymbolicLink(),'REPARSE_LOG');need(fs.statSync(file).size<=16*1024*1024,'LOG_TOO_LARGE');
 const raw=fs.readFileSync(file,'utf8'),end=raw.lastIndexOf('\n');return end<0?[]:parse(raw.slice(0,end+1));
}
async function waitFor(read,ms){const start=Date.now();while(Date.now()-start<ms){const value=read();if(value)return value;await sleep(100);}throw Error('GATE_TIMEOUT');}
async function run(dir,seal){
 plain(dir);need(/^[a-f0-9]{64}$/.test(seal),'INVALID_MANIFEST_SEAL');
 const manifestPath=path.join(dir,'session.json');need(!fs.lstatSync(manifestPath).isSymbolicLink(),'REPARSE_MANIFEST');
 const bytes=fs.readFileSync(manifestPath);need(hash(bytes)===seal,'MANIFEST_CHANGED');const m=JSON.parse(bytes);
 need(/^[a-f0-9]{32}$/.test(m.session)&&['cancel','positive'].includes(m.mode),'INVALID_SESSION');
 need(!fs.existsSync(path.join(dir,'control.json'))&&!fs.existsSync(path.join(dir,'gate-result.json')),'SESSION_ALREADY_CONTROLLED');
 const output=(name,obj)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(obj,null,2)+'\n',{flag:'wx'});
 const control=action=>{output('control.pending',{session:m.session,action});fs.renameSync(path.join(dir,'control.pending'),path.join(dir,'control.json'));};
 let commandWritten=false,fixtureExit=null;
 try {
  await waitFor(()=>{const rows=log(dir);if(rows.some(e=>e.kind==='fault'))throw Error('OBSERVER_REGISTRATION_FAILED');if(!rows.some(e=>e.kind==='ready')||!rows.some(e=>e.kind==='heartbeat'))return false;prefix(rows,m.session);return true;},20000);
  if(m.mode==='cancel'){control('cancel');commandWritten=true;}
  else {
   const exe=path.resolve(m.fixturePath);plain(path.dirname(exe));need(path.basename(exe)==='ProcessFixture.exe'&&!fs.lstatSync(exe).isSymbolicLink(),'FIXTURE_PATH');
   need(hash(fs.readFileSync(exe))===m.fixtureSha256,'FIXTURE_CHANGED');
   // Child itself refuses elevation before opening files or spawning workers.
   const child=spawn(exe,['controller',dir,m.session],{windowsHide:true,stdio:['ignore','ignore','pipe']});
   let errorText='',done=false,spawnError=null;
   child.stderr.on('data',chunk=>{if(errorText.length<4000)errorText+=chunk.toString();});
   child.on('error',error=>{spawnError=error;done=true;});
   child.on('exit',(code,signal)=>{fixtureExit={pid:child.pid,exitCode:code,signal,error:errorText};done=true;});
   await waitFor(()=>{prefix(log(dir),m.session);if(spawnError)throw spawnError;return done;},45000);
   need(fixtureExit.exitCode===0&&!fixtureExit.signal,'FIXTURE_EXIT');
   const fixture=JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'),'utf8'));
   need(fixture.controllerPid===child.pid&&fixture.session===m.session,'FIXTURE_CONTROLLER_IDENTITY');
   await waitFor(()=>{
    const rows=log(dir);prefix(rows,m.session);
    return fixture.processes.every(p=>rows.some(e=>e.kind==='start'&&e.pid===p.pid&&e.ppid===p.ppid)&&rows.some(e=>e.kind==='stop'&&e.pid===p.pid&&e.ppid===p.ppid));
   },8000);
   // Continue the live health checks while queued WMI callbacks drain.
   for(let n=0;n<20;n++){await sleep(100);prefix(log(dir),m.session);}
   control('stop');commandWritten=true;
  }
  await waitFor(()=>log(dir).some(e=>e.kind==='closed'),8000);
  const events=parse(fs.readFileSync(path.join(dir,'events.jsonl'),'utf8'));
  const result=m.mode==='cancel'?envelope(events,m.session,{cancel:true}):analyze(events,JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'),'utf8')),m.session);
  const report={session:m.session,mode:m.mode,at:new Date().toISOString(),result,fixtureExit,
   observerExitCodeVerified:false,provisionalUntilObserverExitAndIndependentReview:true,installationMayProceed:false,
   eventsSha256:hash(fs.readFileSync(path.join(dir,'events.jsonl'))),modelCalls:0,officialCliInvocations:0};
  output('gate-result.json',report);return report;
 }catch(error){
  if(!commandWritten&&!fs.existsSync(path.join(dir,'control.json'))){try{control('stop');}catch{}}
  output('gate-failure.json',{session:m.session,error:error.message,at:new Date().toISOString(),fixtureExit,installationMayProceed:false});throw error;
 }
}
module.exports={prefix,run};
if(require.main===module)run(path.resolve(process.argv[2]||''),process.argv[3]).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
