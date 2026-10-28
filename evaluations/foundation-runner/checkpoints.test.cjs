'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createCheckpoint}=require('./checkpoints.cjs');
const seal='a'.repeat(64),hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup(t,overrides={}){
 const tmp=fs.realpathSync(os.tmpdir()),directory=fs.realpathSync(fs.mkdtempSync(path.join(tmp,'foundation-checkpoint-')));
 t.after(()=>{assert.ok(directory.startsWith(tmp+path.sep)&&path.basename(directory).startsWith('foundation-checkpoint-'));fs.rmSync(directory,{recursive:true,force:true});});
 const input={title:'合成通知',description:'按原文写通知',criteria:'保留日期和限定条件',sources:[{title:'合成记录',content:'2025年7月2日，只接待已登记人员。'}]};
 const draft={title:'已登记人员通知',content:'请已登记人员于2025年7月2日到场。'};
 const args={directory,caseId:'G00-synthetic',stage:'protocol',input,draft,sealIdentity:seal,...overrides};
 const checkpoint=createCheckpoint(args),request=JSON.parse(fs.readFileSync(checkpoint.requestPath,'utf8'));
 const decision=(extra={})=>({schema:1,caseId:args.caseId,stage:args.stage,identity:checkpoint.identity,sealIdentity:seal,reviewer:'independent-subagent',approved:true,verdict:'逐项阅读资料及当前稿，全部符合。',...extra});
 const publish=value=>{const file=checkpoint.decisionPath+'.next';fs.writeFileSync(file,JSON.stringify(value));fs.renameSync(file,checkpoint.decisionPath);};
 return {checkpoint,request,args,decision,publish};
}
test('explicit independent approval bound to this draft is returned without modifying product or input',async t=>{
 const f=setup(t,{now:()=>1000});f.publish(f.decision());const before=fs.readFileSync(f.checkpoint.requestPath,'utf8');
 assert.deepEqual(await f.checkpoint.wait({deadline:2000}),f.decision());assert.equal(fs.readFileSync(f.checkpoint.requestPath,'utf8'),before);assert.equal(fs.readdirSync(path.dirname(f.checkpoint.requestPath)).sort().join(','),'decision.json,request.json');
});
test('explicit rejection cannot be treated as permission to continue',async t=>{
 const f=setup(t,{now:()=>1000});f.publish(f.decision({approved:false,verdict:'当前稿扩大了适用对象。'}));
 await assert.rejects(f.checkpoint.wait({deadline:2000}),e=>e.code==='CHECKPOINT_REJECTED'&&e.verdict==='当前稿扩大了适用对象。');
});
test('wrong draft hash, suite, case, stage or reviewer is rejected immediately',async t=>{
 for(const [key,value] of [['identity','b'.repeat(64)],['sealIdentity','b'.repeat(64)],['caseId','F03-other'],['stage','final'],['reviewer','runner-self']])await t.test(key,async t=>{
  const f=setup(t,{now:()=>1000});f.publish(f.decision({[key]:value}));await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_IDENTITY'});
 });
});
test('missing or incomplete decisions expire at the original absolute deadline',async t=>{
 for(const partial of [undefined,'{"approved":true,'])await t.test(partial?'partial':'missing',async t=>{
  let clock=1000,waited=0;const f=setup(t,{now:()=>clock,delay:async ms=>{clock+=ms;waited++;}});
  if(partial)fs.writeFileSync(f.checkpoint.decisionPath,partial);
  await assert.rejects(f.checkpoint.wait({deadline:1250}),{code:'CHECKPOINT_EXPIRED'});assert.equal(clock,1250);assert.equal(waited,3);
 });
});
test('partial JSON is not an approval; a later complete atomic replacement can approve',async t=>{
 let clock=1000,polls=0,f;f=setup(t,{now:()=>clock,delay:async ms=>{clock+=ms;polls++;f.publish(f.decision());}});
 fs.writeFileSync(f.checkpoint.decisionPath,'{"schema":1,"approved":true');
 assert.equal((await f.checkpoint.wait({deadline:2000})).approved,true);assert.equal(polls,1);
});
test('pre-cancelled and during-wait cancellation never pass an existing or later approval',async t=>{
 const pre=new AbortController(),first=setup(t,{now:()=>1000});first.publish(first.decision());pre.abort();await assert.rejects(first.checkpoint.wait({signal:pre.signal,deadline:2000}),{code:'CHECKPOINT_CANCELLED'});
 const controller=new AbortController();let clock=1000,second;second=setup(t,{now:()=>clock,delay:async ms=>{clock+=ms;second.publish(second.decision());controller.abort();}});
 await assert.rejects(second.checkpoint.wait({signal:controller.signal,deadline:2000}),{code:'CHECKPOINT_CANCELLED'});
});
test('approval arriving at or after the deadline is expired and cannot reset the window',async t=>{
 let clock=2000;const f=setup(t,{now:()=>clock});f.publish(f.decision());await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_EXPIRED'});
 clock=2100;await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_EXPIRED'});
});
test('decision requires a boolean verdict and a nonempty explanation',async t=>{
 for(const delta of [{approved:'true'},{approved:null},{verdict:''},{verdict:'   '},{verdict:[]}, {approved:undefined}])await t.test(JSON.stringify(delta),async t=>{
  const f=setup(t,{now:()=>1000});f.publish(f.decision(delta));await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_DECISION'});
 });
});
test('review request projects only evidence and current draft, without system verdicts or gold',t=>{
 const forbidden='SECRET_SYSTEM_VERDICT';const input={title:'标题',description:'任务',criteria:'原文要求',status:forbidden,passed:forbidden,gold:forbidden,expected:forbidden,workflow:forbidden,sources:[{title:'原文',content:'证据正文',status:forbidden,internalExpected:forbidden}]};
 const draft={title:'当前稿标题',content:'当前稿正文',task:{status:forbidden},passed:forbidden,grounding:forbidden};
 const f=setup(t,{input,draft}),raw=fs.readFileSync(f.checkpoint.requestPath,'utf8');assert.ok(!raw.includes(forbidden));
 assert.deepEqual(Object.keys(f.request.input).sort(),['criteria','description','sources','title']);assert.deepEqual(Object.keys(f.request.draft).sort(),['content','title']);assert.deepEqual(Object.keys(f.request.input.sources[0]).sort(),['content','title']);
 assert.equal(f.request.contentSha256,hash({input:f.request.input,draft:f.request.draft}));const {identity,...bound}=f.request;assert.equal(identity,hash(bound));assert.ok(!fs.existsSync(f.checkpoint.decisionPath),'No synthetic approval may be fabricated');
});
test('duplicate checkpoints cannot replace a review and new runs cannot replay old approval',async t=>{
 const first=setup(t,{now:()=>1000});assert.throws(()=>createCheckpoint(first.args),{code:'CHECKPOINT_EXISTS'});
 const second=setup(t,{now:()=>1000});assert.notEqual(first.checkpoint.identity,second.checkpoint.identity);second.publish(first.decision());await assert.rejects(second.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_IDENTITY'});
});
test('clock rollback cannot extend the time allowed for a decision',async t=>{
 let clock=1000;const f=setup(t,{now:()=>clock,delay:async()=>{clock=999;}});await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_CLOCK'});
});
test('the review request is immutable and the absolute deadline cannot be extended by retrying wait',async t=>{
 const f=setup(t,{now:()=>1000});f.publish(f.decision());fs.appendFileSync(f.checkpoint.requestPath,' ');await assert.rejects(f.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_REQUEST_CHANGED'});
 const expired=setup(t,{now:()=>2000});await assert.rejects(expired.checkpoint.wait({deadline:2000}),{code:'CHECKPOINT_EXPIRED'});await assert.rejects(expired.checkpoint.wait({deadline:3000}),{code:'CHECKPOINT_DEADLINE_CHANGED'});
});
