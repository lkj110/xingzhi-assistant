'use strict';
// Structural sample preparation only; no Assistant, network, CLI or model calls.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const read=n=>JSON.parse(fs.readFileSync(path.join(__dirname,n),'utf8')),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const plan=read('plan.json'),suite=read('stimuli.json'),gold=read('gold.json'),anchors=read('anchors.json'),{project}=require('./inputs.cjs');
assert.equal(plan.liveAuthorized,false);assert.equal(suite.cases.length,6);assert.equal(gold.cases.length,6);
assert.deepEqual(suite.cases.map(c=>c.id),plan.caseLimits.map(c=>c.id));assert.equal(new Set(suite.cases.map(c=>c.id)).size,6);
assert.deepEqual(plan.order,[plan.protocolGate.id,...suite.cases.map(c=>c.id)]);assert.equal(gold.protocolGate.id,plan.protocolGate.id);
assert.equal(plan.caseLimits.reduce((n,c)=>n+c.attempts,0),32);assert.equal(plan.caseLimits.reduce((n,c)=>n+c.tokenStopThreshold,0),600000);
assert.equal(plan.budget.applicationAttempts,36);assert.equal(plan.budget.reportedTokenStopThreshold,700000);assert.equal(plan.budget.protocolAttempts,4);assert.equal(plan.budget.protocolTokenStopThreshold,100000);assert.equal(plan.budget.serverEnforcedTokenCap,false);
assert.equal(suite.cases.filter(c=>c.lane==='fixed_invalid').length,2);assert.equal(suite.cases.filter(c=>c.lane==='generated_revision').length,1);assert.equal(suite.cases.filter(c=>c.lane==='generated_restart').length,1);
let anchorCount=0;
for(const c of suite.cases){const g=gold.cases.find(x=>x.id===c.id);assert.ok(g);assert.equal(g.expectedTerminal,c.lane==='fixed_invalid'?'blocked':'review');
 const input=project({...c,expected:gold.canary,gold:gold.canary,budget:gold.canary,referenceDraft:gold.canary});assert.deepEqual(Object.keys(input).sort(),(c.lane==='fixed_invalid'?['title','description','criteria','sources','candidate']:['title','description','criteria','sources']).sort());assert.ok(!JSON.stringify(input).includes(gold.canary));assert.deepEqual(input.sources,c.sources.map(s=>({title:s.title,content:s.content})));
 for(const a of g.assertions)for(const e of a.evidence){const s=c.sources.find(s=>s.key===e.sourceKey);assert.ok(s);const matches=anchors.anchors.filter(r=>r.caseId===c.id&&r.assertionId===a.id&&r.sourceKey===e.sourceKey&&r.quote===e.quote);assert.equal(matches.length,1);const r=matches[0];assert.equal(r.sourceSha256,sha(s.content));assert.equal(r.offsetUnit,'UTF-16');assert.equal(s.content.slice(r.start,r.end),e.quote);assert.equal(s.content.indexOf(e.quote),s.content.lastIndexOf(e.quote));anchorCount++;}
 for(const [text,claims]of [[g.initialReferenceDraft||g.referenceDraft,g.initialNotificationClaims||g.notificationClaims||[]],[g.referenceDraft,g.notificationClaims||[]]])for(const claim of claims){assert.equal(claim.kind,'proposal');assert.ok(text.includes(claim.text));}
 if(g.unknownText)assert.ok(g.referenceDraft.includes(g.unknownText));
 if(c.lane==='generated_revision'){assert.equal(g.referenceDraft.split('\n').filter(l=>/^[-*] /.test(l)).length,3);assert.ok(c.revision.note);}
}
assert.equal(anchorCount,anchors.anchors.length);
const shared=path.join(__dirname,'../foundation-acceptance-20261028/inputs.cjs'),sharedSha256=sha(fs.readFileSync(shared));assert.equal(sharedSha256,'eb42b1f19903a96a6376a405a6b79d72a964e2539ea18327b3b1a8a91e535dd6');
const output={schema:1,passed:true,scope:'sample structure, anchors, allowlist and budget arithmetic only; not candidate runtime readiness',businessCases:6,protocolGate:plan.protocolGate.id,anchors:anchorCount,sharedProjectionSha256:sharedSha256,productModificationPerformed:false,liveModelCalls:0,modelAvailabilityProbed:false,liveAuthorized:false};
if(require.main===module){const target=path.join(__dirname,'preflight.json');assert.ok(!fs.existsSync(target),'Preflight already sealed; do not overwrite');fs.writeFileSync(target,JSON.stringify(output,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(output));}
module.exports=output;
