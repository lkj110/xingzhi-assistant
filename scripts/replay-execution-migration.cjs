// Read a workspace into an isolated temporary copy. Never call models or external services.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Assistant}=require('../desktop/core.cjs'),basis=require('../desktop/evidence-basis.cjs');
const input=process.argv[2];if(!input)throw Error('Pass the workspace directory to inspect');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-migration-replay-'));
const projection=a=>({sources:a.data.sources.map(s=>({id:s.id,key:s.resourceKey,hash:s.hash})),tasks:a.data.tasks.map(t=>({id:t.id,requirement:t.userRequirement})),jobs:a.data.delegations.map(j=>({id:j.id,state:j.executionState})),actions:a.data.agentActions,scope:a.spendLedger.scopes});
let calls=0;const forbidden=()=>{calls++;throw Error('Replay cannot access external services');};
try{
 for(const name of ['workspace.json','spend-ledger.json','action-ledger.json']){const file=path.join(input,name);if(fs.existsSync(file))fs.copyFileSync(file,path.join(dir,name));}
 const original=JSON.parse(fs.readFileSync(path.join(dir,'workspace.json'),'utf8'));
 const options={dir,chat:forbidden,agentRequest:forbidden,connectorRequest:forbidden,officeRequest:forbidden,webRequest:forbidden,feedRequest:forbidden};
 const a=new Assistant(options),first=projection(a),b=new Assistant(options);
 assert.deepEqual(projection(b),first,'migration must be idempotent');assert.equal(calls,0);
 assert.deepEqual(a.data.agentActions,original.agentActions,'external receipts retained');
 for(const key of ['sources','tasks','artifacts'])assert.deepEqual(new Set(a.data[key].map(x=>x.id)),new Set(original[key].map(x=>x.id)),key+' IDs retained');
 const report={version:require('../package.json').version,executionSchema:a.data.runtime.executionSchema,at:new Date().toISOString(),sources:a.data.sources.length,tasks:a.data.tasks.length,artifacts:a.data.artifacts.length,jobs:a.data.delegations.length,externalCalls:calls,idempotent:true,receiptsRetained:true,stableCapabilityKeys:a.data.sources.filter(s=>s.resourceKey).length,scopes:Object.values(a.spendLedger.scopes).map(s=>({limitUSD:s.limitUSD,spentUSD:s.spentUSD,reservedUSD:s.reservedUSD})),replayDigest:basis.hash(first)};
 console.log(JSON.stringify(report,null,2));
}finally{fs.rmSync(dir,{recursive:true,force:true});}
