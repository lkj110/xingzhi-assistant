'use strict';
// Read-only replay of a sealed failed response. The derived response is an
// explicitly synthetic protocol example, not a new model result or acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function replay({run,output}){
 assert.ok(path.isAbsolute(run)&&path.isAbsolute(output));assert.ok(!fs.existsSync(output));
 const id='91afdab6-c562-4e14-9cea-2b545b43ea9e',files=['F03-botang-notice.json','calls/'+id+'-request.json','calls/'+id+'-terminal.json'];
 const frozen=files.map(p=>({path:p,bytes:fs.readFileSync(path.join(run,p))})),[record,request,terminal]=frozen.map(f=>JSON.parse(f.bytes));
 assert.equal(record.caseId,'F03-botang-notice');assert.equal(record.technicalPassed,false);assert.equal(terminal.attemptId,id);
 const raw=JSON.parse(JSON.parse(terminal.rawOutput).response_json),derived=structuredClone(raw),e3=derived.groundingReview.citations.find(q=>q.id==='e3');assert.equal(e3.quote,'泊棠PT-R08声景复听安排');assert.equal(e3.field,undefined);e3.field='title';
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'citation-sealed-replay-'));
 const {Assistant}=require('../desktop/core.cjs'),g=require('../desktop/grounding.cjs');let calls=0;
 const a=new Assistant({dir,chat:async()=>{calls++;throw Error('Offline replay forbids transport');}});
 try{
  a.data=structuredClone(record.final);const task=a.task(record.taskId);assert.equal(task.grounding.passed,false);
  // Exported workspace data intentionally omits the separate permission store.
  // Reconstruct only this fixture's local read grants in the disposable profile.
  const access=require('../desktop/protocol-access.cjs');
  const policy=require('../desktop/access-policy-store.cjs');
  policy.grant(a,{principalScope:policy.LOCAL,resourceScope:{kind:'execution',key:'app',taskId:task.id},operations:['read_source']},{trusted:true,actor:'user_command',command:'offline_fixture'});
  for(const source of a.data.sources.filter(s=>task.sourceIds.includes(s.id)))access.retain(a,'source',source,{task});
  for(const artifact of a.data.artifacts.filter(r=>r.taskId===task.id))access.retain(a,'artifact',artifact,{task});
  const seen=new Set();for(const message of request.messages.filter(m=>m.role==='user'))g.observe(seen,JSON.parse(message.content));
  const before=sha(JSON.stringify(a.data)),original=g.finish(a,task,raw,{seen}),adapted=g.finish(a,task,derived,{seen});
  assert.equal(original.passed,false);assert.ok(original.gaps.includes('引用与原文不匹配：e3'),JSON.stringify(original.gaps));assert.equal(adapted.passed,true,adapted.summary);assert.equal(sha(JSON.stringify(a.data)),before);
  for(const f of frozen)assert.equal(sha(fs.readFileSync(path.join(run,f.path))),sha(f.bytes));assert.equal(calls,0);
  const result={schema:1,kind:'offline-sealed-citation-replay',createdAt:new Date().toISOString(),sourceRun:'c16483ef-c4ab-4fff-97d5-6335ade71431',sourceCall:id,sourceFiles:frozen.map(f=>({path:f.path,sha256:sha(f.bytes)})),localReadGrants:'reconstructed in disposable fixture; not original authorization evidence',originalBlocked:true,originalIssues:original.gaps,derivedPassed:true,derivedModification:{citationId:'e3',addedField:{field:'title'}},derivedResponseSha256:sha(JSON.stringify(derived)),semanticVerdictUnchanged:true,draftAndSourcesUnchanged:true,rawEvidenceUnchanged:true,realModelCalls:0,realAcceptancePassed:false};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
 }finally{require('../desktop/access.cjs').cancel(a);require('../desktop/deadline-scheduler.cjs').dispose(a);assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}
module.exports={replay};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{run:{type:'string'},output:{type:'string'}}});console.log(JSON.stringify(replay(values)));}
