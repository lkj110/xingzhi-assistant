'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Ledger,planHash,normalizeUsage}=require('./ledger.cjs');
const original=require('../foundation-acceptance-20261028/plan.json'),seal=require('../foundation-acceptance-20261028/seal.json').identity;
const copy=value=>JSON.parse(JSON.stringify(value));
function fixture(t,patch={}){const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'foundation-ledger-test-'));t.after(()=>{assert.ok(fs.realpathSync(dir).startsWith(base+path.sep)&&path.basename(dir).startsWith('foundation-ledger-test-'));fs.rmSync(dir,{recursive:true,force:true});});const plan=copy(original),args={dir,plan,mode:'offline',sealIdentity:seal,...patch};return {dir,plan,args,ledger:new Ledger(args)};}
const request=(caseId='F01-lanqiao-tour',extra={})=>({caseId,role:'verify',stage:'review',serializedInputBytes:10000,schemaBytes:100,visibleBytes:10000,...extra});
const usage={inputTokens:1000,outputTokens:200,cachedInputTokens:300};
test('persisted reservation precedes transport; settlement and restart preserve known usage',t=>{
 const {ledger,args,dir}=fixture(t),attempt=ledger.admit(request());let transportCalls=0;
 const persisted=JSON.parse(fs.readFileSync(path.join(dir,'ledger.json'),'utf8'));assert.equal(persisted.attempts[0].id,attempt.id);assert.equal(persisted.attempts[0].status,'pending');assert.equal(attempt.reservedTokens,46964);transportCalls++;
 ledger.settle(attempt.id,usage);ledger.settle(attempt.id,usage);assert.equal(transportCalls,1);assert.equal(ledger.snapshot().totals.totalTokens,1200);assert.equal(ledger.snapshot().totals.attempts,1);
 const restarted=new Ledger(args);assert.equal(restarted.snapshot().totals.totalTokens,1200);assert.equal(restarted.snapshot().totals.unknownUsage,0);assert.equal(restarted.snapshot().synthetic,true);assert.equal(restarted.snapshot().stop,null);
});
test('case admission refusal is counted and prevents transport while another case may continue',t=>{
 const {ledger}=fixture(t);let calls=0;const run=req=>{const a=ledger.admit(req);calls++;return a;};
 assert.throws(()=>run(request('F05-tangyu-missing-approval',{serializedInputBytes:50000})),e=>e.code==='LEDGER_CASE_BUDGET'&&e.scope==='case');assert.equal(calls,0);assert.equal(ledger.snapshot().totals.attempts,1);assert.equal(ledger.snapshot().stop,null);assert.equal(ledger.snapshot().cases['F05-tangyu-missing-approval'].admitted,0);
 const a=run(request());ledger.settle(a.id,usage);assert.equal(calls,1);assert.throws(()=>run(request('F05-tangyu-missing-approval')),e=>e.code==='LEDGER_CASE_STOPPED');assert.equal(calls,1);
});
test('protocol stage budget refuses before transport and globally stops business cases',t=>{
 const {ledger}=fixture(t);assert.throws(()=>ledger.admit(request('G00-ronglan',{serializedInputBytes:80000})),e=>e.code==='LEDGER_STAGE_BUDGET'&&e.scope==='global');assert.equal(ledger.snapshot().totals.attempts,1);assert.equal(ledger.snapshot().totals.admitted,0);assert.throws(()=>ledger.admit(request()),{code:'LEDGER_STOPPED'});
});
test('unknown, contradictory, unsafe and impossible cached usage cannot become zero',async t=>{
 for(const value of [undefined,{}, {inputTokens:100}, {inputTokens:100,outputTokens:-1},{inputTokens:100,outputTokens:1.5},{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:2},{inputTokens:100,input_tokens:101,outputTokens:20},{inputTokens:100,outputTokens:20,total_tokens:119},{inputTokens:100,outputTokens:20,cachedInputTokens:101}])await t.test(JSON.stringify(value)||'missing',t=>{
  const {ledger}=fixture(t),a=ledger.admit(request());assert.throws(()=>ledger.settle(a.id,value),{code:'LEDGER_USAGE'});assert.equal(ledger.snapshot().totals.unknownUsage,1);assert.equal(ledger.snapshot().attempts[0].usage,null);assert.throws(()=>ledger.admit(request()),{code:'LEDGER_STOPPED'});
 });
});
test('absent cache remains unknown but input plus output is authoritative; later conflict stops',t=>{
 const {ledger}=fixture(t),a=ledger.admit(request());ledger.settle(a.id,{input_tokens:100,output_tokens:10});assert.equal(ledger.snapshot().attempts[0].usage.cachedInputTokens,null);assert.equal(ledger.snapshot().totals.totalTokens,110);assert.equal(ledger.snapshot().totals.unknownUsage,0);
 assert.throws(()=>ledger.settle(a.id,{inputTokens:100,outputTokens:11}),{code:'LEDGER_USAGE_CONFLICT'});assert.equal(ledger.snapshot().totals.totalTokens,110);assert.equal(ledger.snapshot().stop.code,'LEDGER_USAGE_CONFLICT');
});
test('reported overage retains actual usage and halts rather than clipping it to reservation',t=>{
 const {ledger}=fixture(t),a=ledger.admit(request());assert.throws(()=>ledger.settle(a.id,{inputTokens:a.reservedTokens,outputTokens:1}),{code:'LEDGER_OVERAGE'});assert.equal(ledger.snapshot().totals.totalTokens,a.reservedTokens+1);assert.equal(ledger.snapshot().totals.unknownUsage,0);
});
test('an unsettled restart is permanently closed and cannot replay or retroactively claim zero usage',t=>{
 const {ledger,args}=fixture(t),a=ledger.admit(request()),restarted=new Ledger(args);assert.equal(restarted.snapshot().stop.code,'LEDGER_INTERRUPTED');assert.equal(restarted.snapshot().totals.unknownUsage,1);assert.throws(()=>restarted.admit(request()),{code:'LEDGER_STOPPED'});assert.throws(()=>restarted.settle(a.id,usage),{code:'LEDGER_SETTLEMENT'});assert.equal(restarted.snapshot().totals.totalTokens,null);assert.equal(restarted.snapshot().totals.knownTokenSubtotal,0);assert.equal(restarted.snapshot().totals.unknownUsage,1);assert.throws(()=>ledger.settle(a.id,usage),{code:'LEDGER_STALE'});
});
test('atomic write failure prevents transport and poisons the current ledger',t=>{
 const {ledger,dir}=fixture(t);let calls=0;fs.mkdirSync(path.join(dir,'ledger.json.blocker'));
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===path.join(dir,'ledger.json'))throw Object.assign(Error('injected disk failure'),{code:'EIO'});return rename(from,to);};
 try{assert.throws(()=>{ledger.admit(request());calls++;},{code:'LEDGER_PERSIST'});}finally{fs.renameSync=rename;}
 assert.equal(calls,0);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ledger.json'),'utf8')).attempts.length,0);assert.throws(()=>ledger.admit(request()),{code:'LEDGER_POISONED'});assert.equal(ledger.snapshot().poisoned,true);
});
test('plan, mode, seal and disk integrity cannot silently reset an existing ledger',t=>{
 const {args,dir}=fixture(t),changed=copy(args.plan);changed.budget.reservationOutputAllowance++;
 assert.throws(()=>new Ledger({...args,plan:changed}),{code:'LEDGER_IDENTITY'});assert.throws(()=>new Ledger({...args,sealIdentity:'a'.repeat(64)}),{code:'LEDGER_IDENTITY'});
 const auth={schema:1,grantedBy:'user',reference:'synthetic test approval only',sealIdentity:seal,planSha256:planHash(args.plan),applicationAttempts:36,reportedTokenStopThreshold:700000,nonHardCapAccepted:true};assert.throws(()=>new Ledger({...args,mode:'live',authorization:auth}),{code:'LEDGER_IDENTITY'});
 const file=path.join(dir,'ledger.json'),disk=JSON.parse(fs.readFileSync(file,'utf8'));disk.revision++;fs.writeFileSync(file,JSON.stringify(disk));assert.throws(()=>new Ledger(args),{code:'LEDGER_CORRUPT'});
});
test('live mode cannot be enabled without exact external approval including non-hard-cap acknowledgement',t=>{
 const {args}=fixture(t);for(const authorization of [undefined,{}, {grantedBy:'user'}, {schema:1,grantedBy:'user',reference:'approval',sealIdentity:seal,planSha256:planHash(args.plan),applicationAttempts:36,reportedTokenStopThreshold:700000,nonHardCapAccepted:false}])assert.throws(()=>new Ledger({...args,mode:'live',authorization}),{code:'LEDGER_UNAUTHORIZED'});
});
test('45 minute window and backwards time stop dispatch, while a settled failure retains usage',t=>{
 let now=100000;const {ledger}=fixture(t,{now:()=>now}),a=ledger.admit(request());ledger.settle(a.id,usage);now+=45*60000;assert.throws(()=>ledger.admit(request()),{code:'LEDGER_WINDOW'});assert.equal(ledger.snapshot().totals.attempts,2);assert.equal(ledger.snapshot().totals.admitted,1);
 const other=fixture(t,{now:()=>now}).ledger,b=other.admit(request());other.settle(b.id,usage);now--;assert.throws(()=>other.admit(request()),{code:'LEDGER_CLOCK'});
 const third=fixture(t).ledger,c=third.admit(request());third.settle(c.id,usage);third.fail(c.id,'protocol_or_schema_rejection');assert.equal(third.snapshot().totals.totalTokens,1200);assert.equal(third.snapshot().stop.reason,'protocol_or_schema_rejection');
});
test('overlapping attempts and duplicate instance writes cannot dispatch concurrently',t=>{
 const {ledger,args}=fixture(t),stale=new Ledger(args),a=ledger.admit(request());assert.throws(()=>stale.admit(request('F02-chengdao-disagreement')),{code:'LEDGER_STALE'});assert.throws(()=>ledger.admit(request('F02-chengdao-disagreement')),{code:'LEDGER_CONCURRENT'});ledger.settle(a.id,usage);assert.equal(ledger.snapshot().totals.admitted,1);assert.equal(ledger.snapshot().totals.attempts,2);assert.equal(ledger.snapshot().stop.code,'LEDGER_CONCURRENT');
});
test('known zero usage remains valid and input/output aliases must agree',()=>{assert.deepEqual(normalizeUsage({inputTokens:0,input_tokens:0,outputTokens:0,cachedInputTokens:0}),{inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0});});
test('conservative mode reserves the last case attempt for a recorded local refusal',t=>{
 const {ledger}=fixture(t,{conservativeAttemptSlot:true});for(let i=0;i<5;i++){const a=ledger.admit(request());ledger.settle(a.id,{inputTokens:0,outputTokens:0});}
 assert.throws(()=>ledger.admit(request()),{code:'LEDGER_CASE_BUDGET',scope:'case'});assert.equal(ledger.snapshot().cases['F01-lanqiao-tour'].attempts,6);assert.equal(ledger.snapshot().cases['F01-lanqiao-tour'].admitted,5);assert.equal(ledger.snapshot().stop,null);
 assert.throws(()=>ledger.admit(request()),e=>e.code==='LEDGER_CASE_STOPPED'&&e.unexpectedAttempt===true);assert.equal(ledger.snapshot().totals.attempts,6);assert.equal(ledger.snapshot().totals.unexpectedAttempts,1);assert.equal(ledger.snapshot().totals.applicationEntryAttempts,7);assert.equal(ledger.snapshot().stop.code,'LEDGER_UNEXPECTED_ATTEMPT');
});
test('conservative protocol stage last slot rejects globally and never forwards call four',t=>{
 const {ledger}=fixture(t,{conservativeAttemptSlot:true});for(let i=0;i<3;i++){const a=ledger.admit(request('G00-ronglan'));ledger.settle(a.id,{inputTokens:0,outputTokens:0});}
 assert.throws(()=>ledger.admit(request('G00-ronglan')),{code:'LEDGER_STAGE_BUDGET',scope:'global'});assert.equal(ledger.snapshot().lanes.protocol.attempts,4);assert.equal(ledger.snapshot().lanes.protocol.admitted,3);assert.equal(ledger.snapshot().stop.code,'LEDGER_STAGE_BUDGET');
});
test('global token admission, oversized visible input and exclusive lock all prevent transport',t=>{
 const first=fixture(t).ledger;assert.throws(()=>first.admit(request('F01-lanqiao-tour',{serializedInputBytes:700000})),{code:'LEDGER_GLOBAL_BUDGET'});assert.equal(first.snapshot().totals.admitted,0);
 const second=fixture(t).ledger;assert.throws(()=>second.admit(request('F01-lanqiao-tour',{visibleBytes:70001})),{code:'LEDGER_REQUEST_SIZE'});assert.equal(second.snapshot().totals.admitted,0);
 const {ledger,dir}=fixture(t);fs.writeFileSync(path.join(dir,'ledger.lock'),'test concurrent owner');assert.throws(()=>ledger.admit(request()),{code:'LEDGER_LOCKED'});assert.equal(ledger.snapshot().totals.attempts,0);
});
test('caller mutation cannot change approved budget, and conservative policy cannot change on resume',t=>{
 const {ledger,args,plan}=fixture(t,{conservativeAttemptSlot:true});plan.budget.reportedTokenStopThreshold=900000;assert.equal(ledger.plan.budget.reportedTokenStopThreshold,700000);assert.throws(()=>{ledger.plan.budget.reportedTokenStopThreshold=900000;},TypeError);assert.throws(()=>new Ledger({...args,plan:copy(original),conservativeAttemptSlot:false}),{code:'LEDGER_IDENTITY'});
});
test('pre-admission protocol rejection is durable and closing preserves the original stop cause',t=>{
 const {ledger,args}=fixture(t);ledger.localReject({caseId:'G00-ronglan',role:'verify',stage:'task_verify'},'CLI_PROTOCOL_CHANGED');ledger.stop('cleanup');const after=new Ledger(args).snapshot();assert.equal(after.totals.attempts,1);assert.equal(after.totals.admitted,0);assert.equal(after.totals.totalTokens,0);assert.equal(after.stop.reason,'CLI_PROTOCOL_CHANGED');
 const other=fixture(t).ledger,a=other.admit(request());assert.throws(()=>other.settle(a.id,{}),{code:'LEDGER_USAGE'});other.fail(a.id,'cleanup transport failure');assert.equal(other.snapshot().stop.code,'LEDGER_USAGE');assert.equal(other.snapshot().totals.totalTokens,null);
});
