'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const probe=require('./helpers/recovery-performance-contract.cjs');

test('G10 thresholds are strict and missing/over-limit measurements never pass',()=>{
  const row=(cold,warm,unchanged=true)=>({coldPublic:{wallMs:cold},rpc:{warmStateView:{wallMs:warm}},warmUnchanged:unchanged});
  assert.ok(probe.performanceGates([row(1999.9,99.9)]).every(g=>g.passed));
  assert.ok(probe.performanceGates([row(2000,100)]).every(g=>!g.passed));
  assert.ok(probe.performanceGates([{}]).every(g=>!g.passed));
  assert.equal(probe.performanceGates([row(1,1,false)])[1].passed,false);
  assert.equal(probe.performanceGates([row(NaN,Infinity)])[0].passed,false);
  assert.deepEqual(probe.LIMITS,{coldPublicMs:2000,unchangedStateViewMs:100});
});
test('G10 rejects incomplete CLI, arbitrary thresholds and invalid repetitions',async()=>{
  assert.throws(()=>probe.parseArgs(['--output']),{code:'MISSING_ARGUMENT'});
  assert.throws(()=>probe.parseArgs(['--cold-public-ms','3000']),{code:'UNKNOWN_ARGUMENT'});
  assert.throws(()=>probe.parseArgs(['--output','a','--output','b']),{code:'DUPLICATE_ARGUMENT'});
  assert.throws(()=>probe.validateOptions({repetitions:0}),{code:'INVALID_OPTIONS'});
  assert.deepEqual(probe.parseArgs(['--repetitions','3','--timeout-ms','45000']),{repetitions:3,timeoutMs:45000});
});
test('G10 guard stops real network/model/process/outside writes before effects and restores globals',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'g10-guard-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const fetchBefore=globalThis.fetch,audit=probe.zero(),guard=probe.installIsolation(root,audit);
  try{
    assert.throws(()=>fetch('https://invalid.example'),/FORBIDDEN/);
    assert.throws(()=>require('node:http').get('http://invalid.example'),/FORBIDDEN/);
    assert.throws(()=>require('node:http2').connect('https://invalid.example'),/FORBIDDEN/);
    assert.throws(()=>require('node:dns').lookup('invalid.example',()=>{}),/FORBIDDEN/);
    assert.throws(()=>new (require('node:dns').Resolver)().resolve4('invalid.example',()=>{}),/FORBIDDEN/);
    assert.throws(()=>require('node:child_process').spawnSync(process.execPath,['--version']),/FORBIDDEN/);
    assert.throws(()=>new (require('node:child_process').ChildProcess)().spawn({file:process.execPath,args:['--version']}),/FORBIDDEN/);
    assert.throws(()=>new (require('node:worker_threads').Worker)('',{eval:true}),/FORBIDDEN/);
    assert.throws(()=>guard.denyModel(),/FORBIDDEN/);
    assert.throws(()=>guard.denyBusiness(),/FORBIDDEN/);
    assert.throws(()=>fs.writeFileSync(path.join(root,'..','g10-outside'),'no'),/OUTSIDE_COPY/);
    assert.throws(()=>fs.promises.writeFile(path.join(root,'async'),'no'),/FORBIDDEN/);
    assert.throws(()=>fs.readFileSync('/Users/fixture/Library/Application Support/fixture/workspace.json'),/LIVEREAD/);
    fs.writeFileSync(path.join(root,'allowed'),'yes');
  }finally{guard.restore();}
  assert.equal(globalThis.fetch,fetchBefore);
  assert.deepEqual(audit,{networkAttempts:5,modelAttempts:1,subprocessAttempts:3,outsideWriteAttempts:2,businessAttempts:1,nativeAttempts:0,liveReadAttempts:1});
  assert.equal(fs.readFileSync(path.join(root,'allowed'),'utf8'),'yes');
});
test('G10 financial oracle detects unknown-cost erasure, held-credit reset and extra calls',()=>{
  const data={modelCalls:[{id:'unknown',status:'stopped'}],agentRuns:[],agentActions:[],delegations:[{id:'j',callsUsed:14}]};
  const ledger={scopes:{j:{key:'j',spentUSD:170,heldUSD:3,usage:{unknownCalls:14},unknownAcknowledged:11,limitUSD:200,pending:{},approvals:[]}}};
  const baseline=probe.preservation(data,ledger);
  for(const change of [l=>l.scopes.j.heldUSD=0,l=>l.scopes.j.usage.unknownCalls=0,l=>l.scopes.j.unknownAcknowledged=14]){
    const copy=structuredClone(ledger);change(copy);assert.notEqual(probe.preservation(data,copy).spend,baseline.spend);
  }
  const changed=structuredClone(data);changed.modelCalls[0].inputTokens=0;changed.modelCalls[0].outputTokens=0;
  assert.notDeepEqual(probe.preservation(changed,ledger).unknownUsage,baseline.unknownUsage);
  changed.modelCalls.push({id:'new'});assert.notEqual(probe.preservation(changed,ledger).modelCalls,baseline.modelCalls);
  const running={...data,agentRuns:[{id:'old',status:'running',steps:[{tool:'read_source',result:{sourceId:'s'}}]}]};
  const recovered=structuredClone(running);Object.assign(recovered.agentRuns[0],{status:'interrupted',finishedAt:'2026-10-18',modelCalls:0});
  assert.equal(probe.preservation(running,ledger,['old']).runs,probe.preservation(recovered,ledger,['old']).runs);
  assert.notEqual(probe.preservation(running,ledger).runs,probe.preservation(recovered,ledger).runs);
  recovered.agentRuns[0].steps.push({tool:'platform_query'});
  assert.notEqual(probe.preservation(running,ledger,['old']).runs,probe.preservation(recovered,ledger,['old']).runs);
});
test('synthetic capture rejects corruption, inconsistent metadata and symlinks without private history',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-capture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const snapshot=path.join(root,'snapshot');fs.mkdirSync(snapshot);
 const contents={'workspace.json':'{"tasks":[]}','spend-ledger.json':'{"scopes":{}}','notes.txt':'synthetic'};
 const manifest=Object.fromEntries(Object.entries(contents).map(([name,body])=>[name,require('node:crypto').createHash('sha256').update(body).digest('hex')]));
 for(const [name,body]of Object.entries(contents))fs.writeFileSync(path.join(snapshot,name),body);
 const capture=path.join(root,'capture.json'),record={consistent:true,files:3,differences:[],manifest};
 fs.writeFileSync(capture,JSON.stringify(record));const expected={files:3,workspaceHash:manifest['workspace.json']};
 assert.equal(probe.verifySyntheticSnapshot(snapshot,capture,expected).files.length,3);
 assert.throws(()=>probe.verifySyntheticSnapshot(snapshot,capture),{code:'SYNTHETIC_CAPTURE_IDENTITY_REQUIRED'});
 fs.writeFileSync(path.join(snapshot,'notes.txt'),'corrupt');assert.throws(()=>probe.verifySyntheticSnapshot(snapshot,capture,expected),{code:'CAPTURE_HASH_MISMATCH'});
 fs.writeFileSync(capture,JSON.stringify({...record,consistent:false}));assert.throws(()=>probe.verifySyntheticSnapshot(snapshot,capture,expected),{code:'INVALID_CAPTURE_RECORD'});
 fs.writeFileSync(capture,JSON.stringify(record));{if(!require('./helpers/symlink.cjs').link(t,path.join(snapshot,'workspace.json'),path.join(snapshot,'unexpected-link')))return;}assert.throws(()=>probe.verifySyntheticSnapshot(snapshot,capture,expected),{code:'SNAPSHOT_NONREGULAR_ENTRY'});
});
