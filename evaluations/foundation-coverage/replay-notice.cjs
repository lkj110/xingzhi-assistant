'use strict';
// One fixed, local-only counterexample. It cannot invoke a provider, alter the
// frozen product, replace proposals or turn this exposed sample into a live eval.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {load,validate,checkReview,sha}=require('./validate.cjs');
const root=path.resolve(__dirname,'../..'),work=path.dirname(root),pack=path.join(root,'evaluations/foundation-requirements-regression-20261028');
const output=path.join(work,'foundation-coverage-20261028/source-replay.json');
const expectedGrounding='687bf5f3078a86cd360cc0c6971f4e9edc9f672236910f623b7744f87b799310';
async function replay(){
 assert.ok(!fs.existsSync(output),'This bounded replay has already produced a result');
 const data=load(),validation=validate(data),review=JSON.parse(fs.readFileSync(path.join(pack,'coverage-review.json'),'utf8'));
 checkReview(validation,review);
 const implementation=fs.readFileSync(path.join(root,'desktop/grounding.cjs'));assert.equal(sha(implementation),expectedGrounding);
 const candidateAsar=path.join(work,'foundation-candidate-bundle-notice-20261028/resources/app.asar');
 assert.equal(sha(fs.readFileSync(candidateAsar)),'56916f8062b2384df6de2fbb3a8d976b9ae8bf6c7e4ff0c29f8d841ed0c5b1af');
 assert.equal(sha(require('@electron/asar').extractFile(candidateAsar,'desktop/grounding.cjs')),expectedGrounding);
 const sourcePack=path.join(root,'evaluations',data.metadata.sourcePack),suite=JSON.parse(fs.readFileSync(path.join(sourcePack,'stimuli.json'),'utf8')),gold=JSON.parse(fs.readFileSync(path.join(sourcePack,'gold.json'),'utf8'));
 const id='P01-qingjia-notice',spec=suite.cases.find(c=>c.id===id),g=gold.cases.find(c=>c.id===id),reference=data.references.find(r=>r.caseId===id&&r.stage==='final');
 const {project}=require(path.join(sourcePack,'inputs.cjs')),input=project(spec);
 const {Assistant}=require('../../desktop/core.cjs'),grounding=require('../../desktop/grounding.cjs');
 const temp=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(temp,'xingzhi-coverage-replay-'));let calls=0,a;
 try{
  a=new Assistant({dir:directory,chat:async()=>{calls++;throw Error('No model calls allowed in coverage replay');}});
  a.data.settings.automatic=false;a.data.settings.evidenceGrounding=true;a.addSources(input.sources);
  const sources=a.data.sources.slice(),task=a.createTask({...input,sourceIds:sources.map(s=>s.id),generationMode:'single',steps:[{title:'形成文稿',kind:'draft'}]});
  await a.dispatch('updateTask',{id:task.id,description:input.description});
  const step=task.steps[0],artifact={id:'qualified-notice-reference',taskId:task.id,stepId:step.id,title:reference.title,content:reference.content,createdAt:new Date().toISOString()};
  a.data.artifacts.push(artifact);require('../../desktop/protocol-access.cjs').retain(a,'artifact',artifact,{task});step.done=true;step.artifactId=artifact.id;require('../../desktop/deliverables.cjs').record(a,task,step,artifact,{});a.save();
  const snapshot=grounding.snapshot(a,task),seen=new Set();
  grounding.observe(seen,{artifacts:[artifact],contextReads:sources.map(s=>({result:{sourceId:s.id,version:snapshot.sources.find(x=>x.id===s.id).version,content:s.content}}))});
  grounding.observe(seen,grounding.context(a,task,{},'verify'));
  const citations=sources.map((s,i)=>({id:'e'+i,sourceId:s.id,quote:s.content,start:0})),citationIds=citations.map(c=>c.id);
  // Preserve the original fixture's whole-draft claim and BOTH proposal spans.
  // The corrected whole draft now has its own separate independent quality review.
  const claims=[{id:'c1',artifactId:artifact.id,text:artifact.content,kind:'fact',supported:true,citationIds},...g.notificationClaims.map((c,i)=>({id:'n'+i,artifactId:artifact.id,text:c.text,kind:c.kind,supported:true,citationIds}))];
  const response={passed:true,summary:'OFFLINE SYNTHETIC: independently qualified corrected reference',gaps:[],groundingReview:{format:'compact-v3',scannedArtifactIds:[artifact.id],citations,requirements:snapshot.requirements.map(r=>({id:r.id,status:'satisfied',claimIds:claims.map(c=>c.id)})),claims,unsupportedClaims:[],conflicts:[]}};
  const before=sha({title:artifact.title,content:artifact.content}),result=grounding.finish(a,task,response,{seen});
  assert.equal(calls,0);assert.equal(sha({title:artifact.title,content:artifact.content}),before);
  assert.deepEqual(claims.slice(1).map(c=>({text:c.text,kind:c.kind})),g.notificationClaims);
  const record={schema:1,at:new Date().toISOString(),scope:'one-source-only-local-marker-replay',caseId:id,validationIdentity:validation.identity,independentReferenceQualified:true,reviewSha256:sha(fs.readFileSync(path.join(pack,'coverage-review.json'))),referenceSha256:before,implementationSha256:expectedGrounding,candidateModuleMatchesSource:true,sourceInputUnchanged:true,proposalTextAndKindsUnchanged:true,artifactUnchangedByVerifier:true,realModelCalls:calls,actualPackageLifecycleRun:false,passed:result.passed,issues:result.grounding?.issues||[],artifact:{title:artifact.title,content:artifact.content},response,result};
  fs.writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,passed:record.passed,issues:record.issues,independentReferenceQualified:true,realModelCalls:calls}));return record;
 }finally{
  if(a){require('../../desktop/access.cjs').cancel(a);require('../../desktop/deadline-scheduler.cjs').dispose(a);}
  assert.equal(calls,0);const resolved=fs.realpathSync(directory);assert.ok(path.relative(temp,resolved)&&!path.relative(temp,resolved).startsWith('..')&&!path.isAbsolute(path.relative(temp,resolved)));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 }
}
module.exports={replay};
if(require.main===module)replay().catch(e=>{console.error(e.stack);process.exitCode=1;});
