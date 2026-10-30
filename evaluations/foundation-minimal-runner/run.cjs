'use strict';
const assert=require('node:assert/strict'),{begin}=require('./session.cjs');
async function run(options){
 const {stage:phase,executable,output,mode,authorizationPath,realCli,readyReference,fault}=options;
 assert.ok(['f04','gate','business'].includes(phase));assert.ok(!fault||mode==='offline');if(mode==='offline')assert.equal(realCli,undefined);
 const session=begin({phase,executable,output,mode,authorizationPath,readyReference});
 try{
  const engine=require('./'+(phase==='business'?'business':phase)+'-engine.cjs');
  const summary=await engine.run({executable,output:session.phaseOutput,mode,realCli:phase==='f04'?undefined:realCli,fault,session});await session.finish(summary);
  console.log(JSON.stringify({phase,passed:true,output:session.output,actualHuman:mode==='live',next:phase==='f04'?'gate':phase==='gate'?'business':null}));return summary;
 }catch(e){session.fail(e);throw e;}
}
module.exports={run};
if(require.main===module){const {values}=require('node:util').parseArgs({options:{stage:{type:'string'},executable:{type:'string'},output:{type:'string'},offline:{type:'boolean'},live:{type:'boolean'},authorization:{type:'string'},'real-cli':{type:'string'},'ready-reference':{type:'string'},fault:{type:'string'}}});assert.notEqual(!!values.offline,!!values.live);run({stage:values.stage,executable:values.executable,output:values.output,mode:values.live?'live':'offline',authorizationPath:values.authorization,realCli:values['real-cli'],readyReference:values['ready-reference'],fault:values.fault}).catch(e=>{console.error(e.stack);process.exitCode=1;});}
