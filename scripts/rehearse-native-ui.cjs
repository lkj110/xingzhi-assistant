'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),id=require('../evaluations/foundation-native-ui-runner/identity.cjs');
async function rehearse({executable,output}){
 output=require('../evaluations/foundation-marker-runner/output.cjs').validateOutput(output,path.resolve(id.root,'../foundation-native-ui-runs-20261030'));fs.mkdirSync(output,{recursive:true});
 const seal=id.read(path.join(id.root,'evaluations/foundation-native-ui-runner/runner-seal.json'));id.verifyRunner(seal);const probes=[];
 for(const fault of [null,'capture-submit','wrong-window','invalid-input','expired-accept','stop-accept','phase-stop-accept','unknown-command','cli-attempt','wrong-task']){
  const name=fault||'normal',target=path.join(output,name);let error;
  try{await require('../evaluations/foundation-native-ui-runner/run.cjs').run({executable,output:target,mode:'offline',readyReference:'OFFLINE-SYNTHETIC',fault});}catch(e){error=e;}
  assert.equal(!!error,!!fault,name+': '+error?.stack);const summary=id.read(path.join(target,'f04/summary.json'));
  assert.equal(summary.passed,!fault);assert.equal(summary.modelCallsAdded,0);assert.equal(summary.realModelCalls,0);assert.equal(summary.actualHumanAcceptance,false);
  const rows=require('../evaluations/foundation-native-ui-runner/native.cjs').records(path.join(target,'f04/native-commands.jsonl'));
  if(fault){assert.ok(fs.existsSync(path.join(target,'stopped.json')));assert.ok(!fs.existsSync(path.join(target,'f04.completed.json')));assert.equal(summary.receipt,null);assert.ok(!rows.some(r=>r.kind==='native-command'&&r.kindOfCall==='accept'));if(fault!=='cli-attempt')assert.ok(rows.some(r=>r.kind==='denied'&&r.senderId&&r.windowRole&&r.boundary==='before-original-handler'));assert.ok(!JSON.stringify(rows).includes('PRIVATE_SENTINEL'));}
  else{assert.ok(fs.existsSync(path.join(target,'f04.completed.json')));for(const kind of ['main-window-task-ready','actual-dynamic-capture-mount-poll-occupancy','capture-button-escape-reopen-recreate','cold-restart-ui-and-receipt-preserved'])assert.ok(summary.checks.some(c=>c.kind===kind),kind);assert.equal(summary.receipt.nativeReceipt.windowRole,'main');}
  probes.push({id:name,passed:true,expectedFailure:!!fault,error:error?.message||null,files:['stopped.json','f04.completed.json','f04/summary.json','f04/native-commands.jsonl'].filter(p=>fs.existsSync(path.join(target,p))).map(p=>({path:name+'/'+p,sha256:id.sha(fs.readFileSync(path.join(target,p)))}))});console.log(JSON.stringify({probe:name,passed:true}));
 }
 id.verifyRunner(seal);const value={schema:1,runnerIdentity:seal.identity,asarSha256:id.read(path.join(id.root,'evaluations/foundation-native-ui-runner/plan.json')).asarSha256,mode:'offline',passed:true,probes,realModelCalls:0,officialCliInvocations:0,actualHumanAcceptances:0,installed:false};id.write(path.join(output,'rehearsal.json'),value);return value;
}
module.exports={rehearse};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'}}});rehearse(values).then(r=>console.log(JSON.stringify({passed:r.passed,probes:r.probes.length}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
