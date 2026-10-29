'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{prerequisite}=require('./identity.cjs'),base=require('./plan.json');
test('passed gate binds original evidence, candidate, model and CLI rather than a passed flag alone',()=>{
 assert.equal(prerequisite(base).runId,base.gatePrerequisite.runId);
 for(const mutate of [p=>p.gatePrerequisite.evidenceSha256='0'.repeat(64),p=>p.gatePrerequisite.localEvidence[0].sha256='0'.repeat(64),p=>p.asarSha256='0'.repeat(64),p=>p.model.id='foreign',p=>p.gatePrerequisite.realCliSha256='0'.repeat(64)]){const p=structuredClone(base);mutate(p);assert.throws(()=>prerequisite(p));}
});
