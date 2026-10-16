// Diagnose/migrate a private disposable copy. Never open the live data with Assistant.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs');
const original=path.join(os.homedir(),'Library/Application Support/行知助手/workspace');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-v3-live-copy-'));fs.chmodSync(dir,0o700);
const reportPath=process.argv[2]||path.join(__dirname,'../artifacts/protocol-v3-live-copy.json');
let calls=0;
try{
 for(const name of ['workspace.json','spend-ledger.json','stewardship-ledger.json','action-ledger.json','work-journal.json','access-policy.json','authorization-migration.json','action-facts.json','action-facts.initialized','source-observations.json','source-deletions.json'])if(fs.existsSync(path.join(original,name)))fs.copyFileSync(path.join(original,name),path.join(dir,name));
 for(const name of ['protocol-migrations','effect-content','observation-content'])if(fs.existsSync(path.join(original,name)))fs.cpSync(path.join(original,name),path.join(dir,name),{recursive:true});
 const before=JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'),'utf8'));
 const rejected=async()=>{calls++;throw Error('No network/model permitted in migration verification');};
 const a=new Assistant({dir,chat:rejected,connectorRequest:rejected,agentRequest:rejected,vault:{seal(){throw Error('No secrets');},open(){throw Error('No secrets');}}});
 const j=a.data.delegations.find(j=>j.id==='e6ce9157-c783-4b62-9aa4-515e5194daef'),task=a.task(j.taskIds[0]);
 const reads=a.data.agentActions.filter(r=>r.jobId===j.id&&r.result?.sourceId&&r.status==='done').map(r=>({actionId:r.id,sourceId:r.result.sourceId,result:require('../desktop/task-context.cjs').resolveRead(a,{kind:'task',jobId:j.id,taskId:task.id},{tool:'read_source',sourceId:r.result.sourceId,history:true})}));
 const originalJob=before.delegations.find(x=>x.id===j.id);for(const key of ['dataPlatform','outputFolder','githubRepo','fileMode'])assert.equal(j[key],originalJob[key],key+' authority must be preserved');assert.equal(j.larkCreateGrant?.target,originalJob.larkCreateGrant?.target);assert.equal(j.larkCreateGrant?.openId,originalJob.larkCreateGrant?.openId);
 const completed=before.delegations.filter(j=>j.status==='completed').map(old=>({id:old.id,status:a.data.delegations.find(j=>j.id===old.id)?.status}));
 assert.ok(completed.every(j=>j.status==='completed'));assert.equal(calls,0);
 assert.ok(reads.length&&reads.every(r=>r.result.ok),'Previously saved readbacks must be readable');
 const ledgerBefore=JSON.parse(fs.readFileSync(path.join(original,'spend-ledger.json'),'utf8'));
 const ledgerAfter=JSON.parse(fs.readFileSync(path.join(dir,'spend-ledger.json'),'utf8'));
 assert.deepEqual(ledgerAfter,ledgerBefore,'Migration cannot reset or alter the independent spend ledger');
 a.save();const b=new Assistant({dir,chat:rejected,connectorRequest:rejected,agentRequest:rejected});
 assert.equal(b.data.delegations.find(x=>x.id===j.id).status,j.status);assert.equal(calls,0);
 const viewStarted=performance.now(),publicState=a.publicState(),publicStateMs=Math.round(performance.now()-viewStarted);
 assert.equal(publicState.delegations.find(x=>x.id===j.id).id,j.id);
 const snapshot=require('../desktop/task-context.cjs').buildContext(a,{kind:'job',jobId:j.id},'execute');
 const context={...require('../desktop/agent.cjs').context(a,j),...snapshot,sourceCatalog:snapshot.readableCatalog,contextReads:(j.contextReads||[]).slice(-12)};
 const modelContextChars={before:JSON.stringify(context).length,after:JSON.stringify(require('../desktop/model-context.cjs').project(context)).length};
 assert.ok(modelContextChars.after<require('../desktop/subscription.cjs').maxInputChars-65536,'Planner context must leave room for the CLI envelope and system instructions');
 const report={at:new Date().toISOString(),publicStateMs,modelContextChars,schema:a.data.runtime.executionSchema,networkAndModelCalls:calls,readbackChecks:reads.map(r=>({actionId:r.actionId,sourceId:r.sourceId,ok:r.result.ok,purpose:r.result.purpose,state:r.result.state})),completedDelegations:completed,spendLedgerUnchanged:true,restartPreservesState:true,policyInventory:require('../desktop/access-policy-store.cjs').inventory(a)};
 // Permission inventory contains only identities, no tokens or material bodies.
 fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({...report,policyInventory:undefined,reportPath},null,2));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
