'use strict';
const assert=require('node:assert/strict');
async function run(options){
 assert.ok(!options.fault||options.mode==='offline');assert.equal(options.realCli,undefined);
 const session=require('./session.cjs').begin(options);
 try{const result=await require('./engine.cjs').run({...options,output:session.phaseOutput,session});await session.finish(result);return result;}catch(e){session.fail(e);throw e;}
}
module.exports={run};
if(require.main===module){const {values:v}=require('node:util').parseArgs({options:{executable:{type:'string'},output:{type:'string'},offline:{type:'boolean'},live:{type:'boolean'},authorization:{type:'string'},'ready-reference':{type:'string'},fault:{type:'string'}}});assert.notEqual(!!v.offline,!!v.live);run({executable:v.executable,output:v.output,mode:v.live?'live':'offline',authorizationPath:v.authorization,readyReference:v['ready-reference'],fault:v.fault}).then(r=>console.log(JSON.stringify({passed:r.passed,mode:r.mode,realModelCalls:r.realModelCalls}))).catch(e=>{console.error(e.stack);process.exitCode=1;});}
