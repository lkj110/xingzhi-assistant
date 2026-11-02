'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {analyze,envelope,parse,SUBSCRIPTIONS}=require('../scripts/install-observer/analyze.cjs');
const {prefix}=require('../scripts/install-observer/run-gate.cjs');
const base=134381170000000000n,ft=ms=>(base+BigInt(ms)*10000n).toString(),session='1'.repeat(32);
function sample(){
 const rows=[['root1',10,99,1000,4000],['child',11,10,2000,8000],['grandchild',12,11,5000,7000],['root2',13,99,4500,9000],...Array.from({length:6},(_,i)=>['leaf'+i,20+i,13,5500+i*50,5520+i*50])];
 const fixture={session,expected:10,complete:true,administrative:false,controllerPid:99,processes:rows.map(([name,pid,ppid,a,b])=>({name,pid,ppid,startTime:ft(a),exitTime:ft(b),exitCode:0}))};
 let events=[{kind:'begin'},...SUBSCRIPTIONS.map(subscription=>({kind:'subscribed',subscription})),{kind:'ready',subscriptions:SUBSCRIPTIONS},
  ...rows.flatMap(([name,pid,ppid,a,b])=>[{kind:'start',pid,ppid,name:'ProcessFixture.exe',sessionId:1,eventTime:ft(a)},{kind:'stop',pid,ppid,name:'ProcessFixture.exe',sessionId:1,eventTime:ft(b),exitCode:0}]),
  {kind:'heartbeat',healthy:true},{kind:'closing',reason:'stop'},...SUBSCRIPTIONS.map(subscription=>({kind:'subscriptionStopped',subscription,expected:true,status:'OperationCanceled'})),{kind:'closed',reason:'stop',healthy:true}];
 events=events.map((e,i)=>({...e,session,seq:i+1,monoMs:i*100,fileTime:ft(e.kind==='begin'?0:e.kind==='ready'?500:i<6?100:10000+i)}));
 return {events,fixture};
}
function run(s){return analyze(s.events,s.fixture,session);}
test('two roots, six short leaves and grandchild after root exit are matched',()=>{
 const s=sample(),before=JSON.stringify(s);assert.equal(run(s).matchedEvents,20);assert.equal(run(s).installationMayProceed,false);assert.equal(JSON.stringify(s),before);
});
test('event delivery order can differ from FILETIME order',()=>{
 const s=sample(),a=s.events[6],b=s.events[7];s.events[6]={...b,seq:a.seq,monoMs:a.monoMs};s.events[7]={...a,seq:b.seq,monoMs:b.monoMs};assert.equal(run(s).passed,true);
});
test('unrelated later PID reuse does not acquire the earlier tree',()=>{
 const s=sample(),at=s.events.findIndex(e=>e.kind==='closing');
 s.events.splice(at,0,{kind:'start',pid:10,ppid:500,name:'Other.exe',sessionId:1,eventTime:ft(20000),fileTime:ft(20000),session});
 s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));assert.equal(run(s).passed,true);
});
for(const [name,change] of [
 ['missing start',s=>{s.events.splice(6,1);s.events=s.events.map((e,i)=>({...e,seq:i+1}));}],
 ['missing stop',s=>{s.events.splice(7,1);s.events=s.events.map((e,i)=>({...e,seq:i+1}));}],
 ['sequence gap',s=>s.events[7].seq++],
 ['duplicate sequence',s=>s.events[7].seq--],
 ['unknown event',s=>s.events[7].kind='mystery'],
 ['silent observer',s=>{for(const e of s.events.slice(7))e.monoMs+=4000;}],
 ['bad subscription stop',s=>s.events.find(e=>e.kind==='subscriptionStopped').expected=false],
 ['no final receipt',s=>s.events.pop()],
 ['unknown worker exit',s=>s.fixture.processes[0].exitCode=null],
 ['elevated fixture',s=>s.fixture.administrative=true],
 ['start time rounded to Number',s=>s.events[6].eventTime=Number(s.events[6].eventTime)],
 ['parent exit not demonstrated',s=>s.fixture.processes[0].exitTime=ft(6000)],
 ['wrong parent',s=>s.fixture.processes[1].ppid=500],
 ['PID reused with ambiguous event',s=>{const copy={...s.events[6]};s.events.splice(7,0,copy);s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}],
 ['unexpected descendant',s=>{s.events.splice(7,0,{...s.events[6],pid:999,ppid:10,eventTime:ft(2500)});s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}],
 ['WMI loss',s=>{s.events.splice(7,0,{...s.events[6],kind:'fault',reason:'WMI_EVENT_LOSS'});s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}]
 ,['only stop of extra descendant survives',s=>{s.events.splice(7,0,{...s.events[7],pid:999,ppid:10,eventTime:ft(2500)});s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}]
 ,['child starts after parent exit',s=>{s.fixture.processes[1].startTime=ft(4500);s.events.find(e=>e.kind==='start'&&e.pid===11).eventTime=ft(4500);}]
 ,['no heartbeat',s=>{s.events=s.events.filter(e=>e.kind!=='heartbeat').map((e,i)=>({...e,seq:i+1}));}]
 ,['second begin',s=>{s.events.splice(7,0,{...s.events[6],kind:'begin'});s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}]
 ,['event after closed',s=>s.events.push({...s.events.at(-1),kind:'heartbeat',seq:s.events.length+1,monoMs:s.events.at(-1).monoMs+1})]
 ,['slow leaf is not short-lived validation',s=>{s.fixture.processes[4].exitTime=ft(6800);s.events.find(e=>e.kind==='stop'&&e.pid===20).eventTime=ft(6800);}]
 ,['orphan descendant stop long after parent exit',s=>{s.events.splice(7,0,{...s.events[7],pid:999,ppid:10,eventTime:ft(8500)});s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}]
 ,['old start received before ready',s=>{const old=s.events.splice(6,1)[0];s.events.splice(5,0,old);s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));}]
])test('fails closed: '+name,()=>{const s=sample();change(s);assert.throws(()=>run(s));});
test('truncated JSONL cannot be accepted',()=>assert.throws(()=>parse('{"seq":1}'),/TRUNCATED/));
test('cancellation needs the actual unexpected Stopped callback',()=>{
 const s=sample();s.events=s.events.filter(e=>!(e.kind==='subscriptionStopped'&&e.subscription==='Win32_ProcessStartTrace'));
 const index=s.events.findIndex(e=>e.kind==='closing');s.events.splice(index,0,
  {...s.events[index],kind:'cancelTest'},
  {...s.events[index],kind:'subscriptionStopped',subscription:'Win32_ProcessStartTrace',expected:false,status:'OperationCanceled'},
  {...s.events[index],kind:'fault',reason:'SUBSCRIPTION_STOPPED'},
  {...s.events[index],kind:'fault',reason:'UNCLEAN_END',detail:'cancel-test'});
 for(const e of s.events)if(['closing','closed'].includes(e.kind))e.reason='cancel-test';
 s.events=s.events.map((e,i)=>({...e,seq:i+1,monoMs:i*100}));s.events.at(-1).healthy=false;
 assert.equal(envelope(s.events,session,{cancel:true}).cancellationDetected,true);
 assert.throws(()=>run(s));
 const partial=s.events.filter(e=>!(e.kind==='subscriptionStopped'&&e.expected===true)).map((e,i)=>({...e,seq:i+1}));
 assert.throws(()=>envelope(partial,session,{cancel:true}),/CANCEL_CLEANUP_INCOMPLETE/);
 const lost=structuredClone(s.events);lost.find(e=>e.kind==='fault'&&e.reason==='UNCLEAN_END').reason='WMI_EVENT_LOSS';
 assert.throws(()=>envelope(lost,session,{cancel:true}),/CANCEL_UNEXPECTED_FAULT/);
 s.events=s.events.filter(e=>!(e.kind==='subscriptionStopped'&&e.expected===false)).map((e,i)=>({...e,seq:i+1}));
 assert.throws(()=>envelope(s.events,session,{cancel:true}),/CANCEL_NOT_DETECTED/);
});
test('live controller requires a complete registration and fresh heartbeat before spawning',()=>{
 const rows=sample().events.filter(e=>e.seq<28).map(e=>({...e,at:'2026-11-02T10:00:00Z'}));
 assert.equal(prefix(rows,session,Date.parse('2026-11-02T10:00:01Z')),true);
 assert.throws(()=>prefix(rows,session,Date.parse('2026-11-02T10:00:04Z')),/HEARTBEAT_NOT_FRESH/);
 for(const kind of ['subscribed','heartbeat'])assert.throws(()=>prefix(rows.filter(e=>e.kind!==kind).map((e,i)=>({...e,seq:i+1})),session,Date.parse('2026-11-02T10:00:01Z')));
 const unknown=structuredClone(rows);unknown[6].kind='unknown';assert.throws(()=>prefix(unknown,session),/UNKNOWN_EVENT/);
 const restarted=structuredClone(rows);restarted[6].kind='begin';assert.throws(()=>prefix(restarted,session),/DUPLICATE_BEGIN/);
});
