'use strict';
// Offline audit of explicit human/agent-authored coverage. Exact spans are not
// semantic proof: a separate review bound to this complete input is mandatory.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const key=(caseId,stage)=>caseId+'::'+stage;
const nonempty=value=>typeof value==='string'&&value.trim().length>0;

function load(directory=path.resolve(__dirname,'../foundation-requirements-regression-20261028')){
 const metadata=read(path.join(directory,'metadata.json'));
 assert.equal(metadata.schema,1);assert.equal(metadata.offlineOnly,true);
 assert.equal(metadata.sourcePack,path.basename(metadata.sourcePack));assert.match(metadata.sourcePack,/^foundation-[a-z0-9-]+$/);
 const source=path.join(path.dirname(directory),metadata.sourcePack),seal=read(path.join(source,'seal.json'));
 assert.equal(seal.identity,metadata.sourceSealIdentity);assert.equal(sha(JSON.stringify(seal.files)),seal.identity);
 for(const f of seal.files){assert.ok(!path.isAbsolute(f.path)&&!f.path.split(/[\\/]/).includes('..'));assert.equal(sha(fs.readFileSync(path.join(source,f.path))),f.sha256,f.path);}
 const gate=read(path.join(source,'gate.json')),suite=read(path.join(source,'stimuli.json')),gold=read(path.join(source,'gold.json'));
 // This sealed input projector performs no model calls. Its historical prefix
 // is part of the actual task input, not an extra reference-only obligation.
 const {project}=require(path.join(source,'inputs.cjs'));
 const inputs=[gate,...suite.cases].map(spec=>{
  const description=project(spec).description;assert.ok(description.endsWith(spec.description));
  return {id:spec.id,lane:spec===gate?'gate':spec.lane,sources:spec.sources,fields:{title:spec.title,description:spec.description,criteria:spec.criteria,
   'projection.descriptionPrefix':description.slice(0,-spec.description.length).trimEnd(),workflow:JSON.stringify(spec.workflow||spec.passRequires||[]),
   ...(spec.revision?{'revision.note':spec.revision.note,'revision.additionalCriteria':spec.revision.additionalCriteria}:{})}};
 });
 const references=[];
 for(const spec of [gate,...suite.cases]){
  const g=spec===gate?gold.protocolGate:gold.cases.find(c=>c.id===spec.id);assert.ok(g);
  const variants=spec===gate?[['gate',g.referenceDraft]]:spec.lane==='fixed_invalid'?[['fixed',spec.candidate]]:spec.lane==='generated_revision'?[['initial',g.initialReferenceDraft],['final',g.referenceDraft]]:[['final',g.referenceDraft]];
  for(const [stage,content]of variants){assert.ok(nonempty(content));references.push({caseId:spec.id,stage,negative:stage==='fixed',title:stage==='fixed'||!content.includes('\n')?spec.title:content.split(/\r?\n/)[0],content});}
 }
 const overrides=read(path.join(directory,'references.json'));assert.equal(overrides.schema,1);const changed=new Set();
 for(const item of overrides.overrides){const id=key(item.caseId,item.stage);assert.ok(!changed.has(id),'Duplicate reference override');changed.add(id);const r=references.find(r=>key(r.caseId,r.stage)===id);assert.ok(r&&!r.negative,'Cannot replace a fixed invalid draft');assert.equal(sha(r.content),item.originalSha256,'Original reference drift');assert.ok(nonempty(item.content)&&nonempty(item.reason));r.content=item.content;r.title=item.content.includes('\n')?item.content.split(/\r?\n/)[0]:r.title;}
 return {metadata,inputs,references,requirements:read(path.join(directory,'requirements.json')),coverage:read(path.join(directory,'coverage.json'))};
}

function validate(data){
 const {metadata,inputs,references,requirements,coverage}=data;
 assert.equal(requirements.schema,1);assert.equal(coverage.schema,1);
 assert.equal(new Set(inputs.map(i=>i.id)).size,inputs.length);
 assert.deepEqual(requirements.cases.map(c=>c.id).sort(),inputs.map(i=>i.id).sort(),'Missing or duplicate input case');
 const referenceMap=new Map(references.map(r=>[key(r.caseId,r.stage),r]));assert.equal(referenceMap.size,references.length);
 const expected=new Map();let obligations=0,allowances=0,processOnly=0;
 function inputAnchor(input,anchor){assert.ok(nonempty(anchor.field)&&nonempty(anchor.quote));assert.ok(typeof input.fields[anchor.field]==='string'&&input.fields[anchor.field].includes(anchor.quote),'Requirement is not bound to original input: '+anchor.field);}
 for(const c of requirements.cases){
  const input=inputs.find(i=>i.id===c.id);assert.ok(c.requirements.length>0);const ids=new Set();
  for(const r of c.requirements){
   assert.ok(nonempty(r.id)&&!ids.has(r.id)&&nonempty(r.meaning));ids.add(r.id);obligations++;
   assert.ok(['content','restriction','format','process'].includes(r.kind));inputAnchor(input,r);
   assert.notEqual(r.field,'revision.additionalCriteria','Scoring metadata cannot create an obligation');
   for(const a of r.references||[])inputAnchor(input,a);
   for(const a of r.sourceSupport||[]){const source=input.sources.find(s=>s.key===a.key);assert.ok(source&&source.content.includes(a.quote),'Source disambiguation anchor mismatch');}
   assert.ok(Array.isArray(r.stages)&&r.stages.length>0&&new Set(r.stages).size===r.stages.length);
   if(r.field==='revision.note')assert.deepEqual(r.stages,['final'],'Revision requirement cannot apply retrospectively');
   if(r.field==='workflow')assert.equal(r.kind,'process');
   for(const stage of r.stages){assert.ok(referenceMap.has(key(c.id,stage)),'Invalid requirement stage');expected.set(key(c.id,stage)+'::'+r.id,{caseId:c.id,stage,requirement:r});}
  }
  for(const a of c.allowances||[]){allowances++;inputAnchor(input,a);for(const x of a.references||[])inputAnchor(input,x);}
 }
 const seen=new Set();
 for(const b of coverage.bindings){
  const id=key(b.caseId,b.stage)+'::'+b.requirementId,entry=expected.get(id);assert.ok(entry&&!seen.has(id),'Unexpected or duplicate coverage binding: '+id);seen.add(id);
  const reference=referenceMap.get(key(b.caseId,b.stage)),r=entry.requirement;
  assert.ok(nonempty(b.reason));assert.ok(Array.isArray(b.spans));
  if(r.kind==='process'||r.processOnly===true){assert.equal(b.disposition,'process_only','Process must remain untested by prose');assert.equal(b.spans.length,0);processOnly++;}
  else {assert.ok(['covered','expected_violation'].includes(b.disposition),'Unresolved textual coverage');assert.ok(b.spans.length>0,'A textual judgment needs explicit inspected spans');if(b.disposition==='expected_violation')assert.equal(reference.negative,true,'Generated reference must satisfy its requirements');}
  for(const s of b.spans){assert.ok(['title','content'].includes(s.part));const text=reference[s.part];assert.ok(Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.start>=0&&s.end>s.start&&s.end<=text.length);assert.ok(nonempty(s.quote));assert.equal(text.slice(s.start,s.end),s.quote,'Reference span mismatch');}
 }
 assert.equal(seen.size,expected.size,'Missing requirement/stage coverage');
 for(const r of references)if(r.negative)assert.ok(coverage.bindings.some(b=>b.caseId===r.caseId&&b.stage===r.stage&&b.disposition==='expected_violation'),'Fixed invalid draft cannot be declared qualified');
 const identity=sha({metadata,inputs,references,requirements,coverage});
 return {schema:1,identity,structuralPassed:true,semanticProof:false,requirements:obligations,allowances,bindings:seen.size,processOnly,references:references.map(r=>({caseId:r.caseId,stage:r.stage,negative:r.negative,referenceSha256:sha({title:r.title,content:r.content})}))};
}

function checkReview(validation,review){
 assert.equal(review.schema,1);assert.equal(review.reviewer,'independent-subagent');assert.equal(review.identity,validation.identity,'Stale semantic review');
 assert.equal(review.approved,true,'Semantic review did not approve');assert.equal(review.coverageComplete,true);assert.equal(review.inputRequirementsComplete,true);
 assert.deepEqual(review.references.map(r=>key(r.caseId,r.stage)).sort(),validation.references.map(r=>key(r.caseId,r.stage)).sort(),'Each whole reference requires an independent judgment');
 for(const r of validation.references){const judgment=review.references.find(x=>x.caseId===r.caseId&&x.stage===r.stage);assert.equal(judgment.referenceSha256,r.referenceSha256);assert.equal(judgment.qualified,!r.negative);assert.ok(nonempty(judgment.reason));}
 return {semanticReviewPassed:true,generatedReferencesQualified:true,fixedInvalidReferencesPreserved:true,readyForLocalReplay:true,readyForLive:false};
}
module.exports={load,validate,checkReview,sha};
if(require.main===module){
 const dir=path.resolve(__dirname,'../foundation-requirements-regression-20261028'),result=validate(load(dir)),reviewPath=path.join(dir,'coverage-review.json');
 const reviewed=fs.existsSync(reviewPath)?checkReview(result,read(reviewPath)):{semanticReviewPassed:false,readyForLocalReplay:false,readyForLive:false};
 console.log(JSON.stringify({...result,...reviewed,modelCalls:0},null,2));
}
