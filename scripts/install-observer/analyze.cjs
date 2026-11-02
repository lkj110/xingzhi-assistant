'use strict';
// Pure validation. FILETIME is never rounded through a JavaScript Number.
const SUBSCRIPTIONS=['__EventDroppedEvent','__ConsumerFailureEvent','Win32_ProcessStopTrace','Win32_ProcessStartTrace'];
const KINDS=new Set(['begin','subscribed','ready','heartbeat','start','stop','subscriptionStopped','closing','closed','fault','cancelTest']);
const names=['root1','child','grandchild','root2',...Array.from({length:6},(_,i)=>'leaf'+i)];
const CANCEL_STATUS=new Map([['CallCanceled',-2147217358],['OperationCanceled',262150]]);
const cancellation=e=>CANCEL_STATUS.has(e.status)&&CANCEL_STATUS.get(e.status)===e.statusCode;
const expect=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const time=x=>{expect(typeof x==='string'&&/^\d{17,20}$/.test(x),'INVALID_FILETIME');return BigInt(x);};
function parse(text){expect(text.endsWith('\n'),'TRUNCATED_LOG');return text.trimEnd().split('\n').map(line=>JSON.parse(line));}
function envelope(events,session,{cancel=false}={}){
 expect(Array.isArray(events)&&events.length>2,'EMPTY_LOG');
 let previous=-1,ready=null,closing=null,closedSeen=false;const subscriptions=new Set(),stops=new Set(),faults=[],beats=[];
 for(const [index,e] of events.entries()){
  expect(e.session===session&&e.seq===index+1,'IDENTITY_OR_SEQUENCE');
  expect(KINDS.has(e.kind),'UNKNOWN_EVENT');
  expect(!closedSeen,'EVENT_AFTER_CLOSED');
  if(e.kind==='begin')expect(index===0,'DUPLICATE_BEGIN');
  expect(Number.isSafeInteger(e.monoMs)&&e.monoMs>=previous,'MONOTONIC_CLOCK');
  expect(previous<0||e.monoMs-previous<=3500,'OBSERVER_SILENCE');previous=e.monoMs;time(e.fileTime);
  if(e.kind==='subscribed'){expect(!ready&&!closing&&!subscriptions.has(e.subscription)&&SUBSCRIPTIONS.includes(e.subscription),'SUBSCRIPTION_IDENTITY');subscriptions.add(e.subscription);}
  if(e.kind==='ready'){expect(!ready&&subscriptions.size===4&&JSON.stringify(e.subscriptions)===JSON.stringify(SUBSCRIPTIONS),'NOT_FULLY_READY');ready=e;}
  if(e.kind==='fault')faults.push(e);
  if(e.kind==='heartbeat'){expect(ready&&!closing&&(e.healthy===true||cancel),'UNHEALTHY_HEARTBEAT');beats.push(e);}
  if(e.kind==='closing'){expect(ready&&!closing,'INVALID_CLOSING');closing=e;}
  if(e.kind==='closed'){expect(closing,'CLOSED_BEFORE_CLOSING');closedSeen=true;}
  if(e.kind==='subscriptionStopped'){
   expect(SUBSCRIPTIONS.includes(e.subscription),'UNKNOWN_SUBSCRIPTION_STOP');
   if(!cancel){expect(e.expected===true&&cancellation(e)&&!stops.has(e.subscription),'UNEXPECTED_SUBSCRIPTION_STOP');}
   stops.add(e.subscription);
  }
  if(['start','stop'].includes(e.kind)){
   time(e.eventTime);expect(Number.isSafeInteger(e.pid)&&e.pid>0&&Number.isSafeInteger(e.ppid)&&e.ppid>=0,'INVALID_PID');
   expect(typeof e.name==='string'&&e.name.length>0&&Number.isSafeInteger(e.sessionId),'INVALID_PROCESS');
   if(e.kind==='stop')expect(Number.isInteger(e.exitCode)&&e.exitCode>=0,'INVALID_EXIT_CODE');
  }
 }
 const closed=events.at(-1);
 expect(events[0].kind==='begin'&&ready&&closed.kind==='closed','MISSING_LIFECYCLE');
 expect(beats.length>0,'NO_HEARTBEAT');
 const health=[ready,...beats,closing];
 expect(health.every((e,i)=>i===0||e.monoMs-health[i-1].monoMs<=3500),'HEARTBEAT_GAP');
 if(cancel){
  const requests=events.filter(e=>e.kind==='cancelTest'),ended=events.filter(e=>e.kind==='subscriptionStopped'),unexpected=ended.filter(e=>e.expected===false);
  expect(requests.length===1&&requests[0].seq>ready.seq&&unexpected.length===1&&unexpected[0].subscription==='Win32_ProcessStartTrace'&&unexpected[0].seq>requests[0].seq&&unexpected[0].seq<closing.seq&&faults.filter(e=>e.reason==='SUBSCRIPTION_STOPPED').length===1,'CANCEL_NOT_DETECTED');
  expect(ended.length===4&&stops.size===4&&ended.every(e=>cancellation(e)&&(e.expected===false||e.expected===true&&e.seq>closing.seq)),'CANCEL_CLEANUP_INCOMPLETE');
  expect(faults.every(e=>e.reason==='SUBSCRIPTION_STOPPED'||e.reason==='UNCLEAN_END'&&e.detail==='cancel-test')&&closing.reason==='cancel-test'&&closed.reason==='cancel-test'&&closed.healthy===false,'CANCEL_UNEXPECTED_FAULT');
  return {cancellationDetected:true,passed:false};
 }
 expect(!faults.length&&!events.some(e=>e.kind==='cancelTest'),'OBSERVER_FAULT');
 expect(closed.healthy===true&&closed.reason==='stop'&&stops.size===4,'UNCLEAN_CLOSE');
 expect(closing.reason==='stop','MISSING_CLOSE_REQUEST');
 expect(events.filter(e=>e.kind==='subscriptionStopped').every(e=>e.seq>closing.seq),'EARLY_SUBSCRIPTION_STOP');
 return {ready,closing,closed};
}
function analyze(events,fixture,session){
 const life=envelope(events,session),tolerance=10000000n;
 expect(fixture.session===session&&fixture.complete===true&&fixture.administrative===false,'FIXTURE_NOT_COMPLETE');
 expect(fixture.expected===names.length&&fixture.processes.length===names.length,'FIXTURE_COUNT');
 const rows=fixture.processes,byName=new Map(rows.map(p=>[p.name,p]));
 expect(byName.size===names.length&&names.every(n=>byName.has(n)),'FIXTURE_NAMES');
 const starts=events.filter(e=>e.kind==='start'),stops=events.filter(e=>e.kind==='stop'),matched=new Set();
 for(const p of rows){
  const a=time(p.startTime),b=time(p.exitTime);expect(b>=a&&p.exitCode===0,'FIXTURE_EXIT');
  expect(a>time(life.ready.fileTime)&&b<time(life.closing.fileTime),'OUTSIDE_OBSERVATION');
  const candidates=starts.filter(e=>e.pid===p.pid&&e.ppid===p.ppid&&time(e.eventTime)>=a-tolerance&&time(e.eventTime)<=b);
  const ends=stops.filter(e=>e.pid===p.pid&&e.ppid===p.ppid&&time(e.eventTime)>=a&&time(e.eventTime)<=b+tolerance);
  expect(candidates.length===1&&ends.length===1,'MISSING_OR_AMBIGUOUS_PROCESS');
  const s=candidates[0],end=ends[0];
  expect(!matched.has(s)&&!matched.has(end),'PID_INSTANCE_REUSED');matched.add(s);matched.add(end);
  expect(s.name.toLowerCase()==='processfixture.exe'&&end.name.toLowerCase()===s.name.toLowerCase()&&s.sessionId===end.sessionId&&end.exitCode===0,'PROCESS_IDENTITY');
  expect(time(s.eventTime)>=time(life.ready.fileTime)&&time(s.eventTime)<=time(end.eventTime)&&s.seq>life.ready.seq&&end.seq>life.ready.seq&&s.seq<life.closing.seq&&end.seq<life.closing.seq,'LATE_OR_REVERSED_PROCESS');
  const expectedParent=p.name==='root1'||p.name==='root2'?fixture.controllerPid:p.name==='child'?byName.get('root1').pid:p.name==='grandchild'?byName.get('child').pid:byName.get('root2').pid;
  expect(p.ppid===expectedParent,'WRONG_PARENT');
  const parentName=p.name==='child'?'root1':p.name==='grandchild'?'child':p.name.startsWith('leaf')?'root2':null;
  if(parentName){const parent=byName.get(parentName);expect(a>=time(parent.startTime)&&a<time(parent.exitTime),'PARENT_INSTANCE_NOT_ALIVE');}
 }
 const r1=byName.get('root1'),r2=byName.get('root2'),child=byName.get('child'),grand=byName.get('grandchild');
 expect(time(r1.exitTime)<time(grand.startTime)&&time(child.exitTime)>time(grand.exitTime),'PARENT_EARLY_EXIT_NOT_PROVEN');
 expect(r1.pid!==r2.pid&&time(r1.exitTime)<time(r2.startTime),'TWO_ROOTS_NOT_PROVEN');
 const leafDurationsMs=rows.filter(p=>p.name.startsWith('leaf')).map(p=>Number(time(p.exitTime)-time(p.startTime))/10000);
 expect(leafDurationsMs.length===6&&leafDurationsMs.every(ms=>ms>0&&ms<1000),'LEAF_NOT_SHORT_LIVED');
 // Parent instance is resolved by its OS lifetime, including after the root has
 // exited. Any unexplained direct descendant (or reused PID ambiguity) fails.
 for(const e of starts){
  if(matched.has(e))continue;
  const owners=rows.filter(p=>p.pid===e.ppid&&time(e.eventTime)>=time(p.startTime)-tolerance&&time(e.eventTime)<=time(p.exitTime)+tolerance);
  expect(!owners.length,'UNEXPECTED_DESCENDANT');
 }
 for(const e of stops){
  if(matched.has(e))continue;
  // A child may exit long after its parent. Without its start event, a later
  // reused parent PID cannot establish that this stop belongs to another tree.
  const owners=rows.filter(p=>time(e.eventTime)>=time(p.startTime)-tolerance&&(p.pid===e.ppid||p.pid===e.pid&&time(e.eventTime)<=time(p.exitTime)+tolerance));
  expect(!owners.length,'UNMATCHED_TARGET_STOP');
 }
 return {passed:true,processes:rows.length,matchedEvents:matched.size,twoRoots:true,parentEarlyExit:true,leafDurationsMs,
  scope:'bounded harmless-process observation only',modelRequestObservationPassed:false,installationMayProceed:false};
}
module.exports={parse,envelope,analyze,SUBSCRIPTIONS};
if(require.main===module){
 const fs=require('node:fs'),path=require('node:path'),dir=path.resolve(process.argv[2]||'');
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'session.json'),'utf8'));
 const events=parse(fs.readFileSync(path.join(dir,'events.jsonl'),'utf8'));
 const result=process.argv[3]==='cancel'?envelope(events,manifest.session,{cancel:true}):analyze(events,JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'),'utf8')),manifest.session);
 console.log(JSON.stringify(result,null,2));
}
