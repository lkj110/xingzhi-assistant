'use strict';
// The already-exposed gate is a protocol regression, not a fresh quality sample.
const assert=require('node:assert/strict');
function createFixture({pack,plan,fault}){
 const original=require('../foundation-runner/offline-fixture.cjs').createFixture({pack,plan});let generationReads=0,verificationReads=0;
 return async call=>{
  assert.equal(call.context.id,plan.protocolGate.id);
  if(call.role==='execute'&&generationReads++===0)return {kind:'read_context',requests:[{tool:'read_source',sourceId:call.context.sources[0].id,start:0}]};
  if(call.role==='verify'&&fault==='fifth-request'&&++verificationReads===2)return {kind:'read_context',requests:[{tool:'read_source',sourceId:call.context.sources[0].id,start:0}]};
  return original(call);
 };
}
module.exports={createFixture};
