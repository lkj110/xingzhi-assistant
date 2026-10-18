'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const harness=require('./system-package-worker.cjs');
function summarize(reports){
 assert.deepEqual(reports.map(r=>r.scenario),harness.SCENARIOS,'all nine existing and three recovery package scenarios must pass');
 const sourceDigest=reports[0]?.result.source?.digest,packageDigest=reports[0]?.result.package?.digest;
 assert.match(sourceDigest||'',/^[a-f0-9]{64}$/);assert.match(packageDigest||'',/^[a-f0-9]{64}$/);
 for(const {scenario,file,result}of reports){
  assert.equal(path.basename(file),'package-worker-'+scenario+'.json');
  assert.equal(result.scenario,scenario);assert.equal(result.status,'passed',result.error||result.identityError);assert.equal(result.passed,true);
  assert.equal(result.layer,'controlled');assert.equal(result.productionDelivery,'not_verified');assert.equal(result.userAccepted,false);
  assert.equal(result.source.digest,sourceDigest,'matrix mixed different source identities');assert.equal(result.afterSourceDigest,sourceDigest);
  assert.equal(result.package.digest,packageDigest,'matrix mixed different package identities');assert.equal(result.afterPackageDigest,packageDigest);
  for(const key of ['realBusinessCalls','realNetworkCalls','realModelCalls'])assert.equal(result[key],0);
  assert.deepEqual(result.blockedExternalAttempts,[]);
 }
 return {schema:harness.VERSION,status:'passed',passed:true,layer:'controlled',productionDelivery:'not_verified',sourceDigest,packageDigest,
  scenarioNames:[...harness.SCENARIOS],
  scenarios:reports.map(({scenario,file,result})=>({id:scenario,status:result.status,report:file})),
  reports:reports.map(({scenario,file})=>({scenario,file}))};
}
async function runMatrix(app,output){
 assert.ok(path.isAbsolute(app)&&path.isAbsolute(output));
 const matrixFile=path.join(output,'package-worker-matrix.json');assert.ok(!fs.existsSync(matrixFile),'matrix evidence already exists');
 const reports=[];
 for(const scenario of harness.SCENARIOS){
  const file=path.join(output,'package-worker-'+scenario+'.json'),result=await harness.run({app,output:file,scenario});
  assert.equal(result.status,'passed',result.error||result.identityError);reports.push({scenario,file,result});
 }
 const summary=summarize(reports);fs.writeFileSync(matrixFile,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});return summary;
}
module.exports={summarize,runMatrix};
if(require.main===module)runMatrix(...process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1;});
