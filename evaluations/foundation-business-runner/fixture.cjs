'use strict';
// Read missing sources once per phase. A revision with complete carried evidence
// writes its patch directly; it must not force a duplicate/no-progress read.
const assert=require('node:assert/strict');
function visible(source,payload){return (payload.generationEvidence||[]).some(e=>e.sourceId===source.id&&e.ok===true&&e.complete===true&&e.more===false&&e.segments?.every(s=>!s.truncated)&&e.segments.map(s=>s.text).join('\n')===source.content);}
function createFixture({pack,plan,fault}){
 const seenGeneration=new Set(),phases=new Map(),verificationCount=new Map();
 return async call=>{
  const {context,role}=call;assert.ok(plan.caseLimits.some(c=>c.id===context.id));
  const key=JSON.stringify([context.id,context.evaluationPhase,!!context.revised]);
  if(role==='execute'&&!seenGeneration.has(key)){seenGeneration.add(key);const missing=context.sources.filter(s=>!visible(s,call.payload));if(missing.length)return {kind:'read_context',requests:missing.map(s=>({tool:'read_source',sourceId:s.id,start:0}))};}
  if(role==='verify'){const n=(verificationCount.get(key)||0)+1;verificationCount.set(key,n);if(fault==='case-extra-request'&&context.id===plan.caseLimits[0].id&&n===2)return {kind:'read_context',requests:context.sources.map(s=>({tool:'read_source',sourceId:s.id,start:0}))};}
  if(!phases.has(key))phases.set(key,require('../foundation-runner/offline-fixture.cjs').createFixture({pack,plan}));return phases.get(key)(call);
 };
}
module.exports={createFixture};
