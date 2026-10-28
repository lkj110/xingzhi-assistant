'use strict';
// Evaluation transport boundary only. These are the existing application's
// response types, not a new model schema or a second semantic verifier.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
function evidenceProtocol(review){
 const check=(valid,field)=>{if(!valid)throw Object.assign(Error('Invalid evidence response field: groundingReview'+field),{code:'RUNNER_EVIDENCE_FORMAT',field:'groundingReview'+field});};
 const strings=(value,field,ids=false)=>check(Array.isArray(value)&&value.every(ids?text:v=>typeof v==='string'),field);
 const boundedIds=(value,field,min,max)=>{strings(value,field,true);check(value.length>=min&&value.length<=max&&new Set(value).size===value.length,field);};
 const uniqueRows=(value,field,max)=>{check(value.length<=max,field);check(new Set(value.map(r=>r?.id)).size===value.length,field+'.id');};
 const optionalText=(row,key,field)=>{if(row[key]!==undefined)check(typeof row[key]==='string',field+'.'+key);};
 const citation=(row,field,shared)=>{
  check(object(row),field);if(shared)check(text(row.id),field+'.id');
  check(text(row.sourceId),field+'.sourceId');check(typeof row.quote==='string'&&row.quote.length<=1200,field+'.quote');
  if(row.start!==undefined)check(Number.isSafeInteger(row.start)&&row.start>=0,field+'.start');
 };
 check(object(review),'');const compact=review.format==='compact-v3';
 check(review.format===undefined||compact,'.format');
 strings(review.scannedArtifactIds,'.scannedArtifactIds',true);
 strings(review.unsupportedClaims,'.unsupportedClaims');strings(review.conflicts,'.conflicts');
 check(Array.isArray(review.requirements),'.requirements');check(Array.isArray(review.claims),'.claims');
 uniqueRows(review.requirements,'.requirements',80);uniqueRows(review.claims,'.claims',160);
 if(compact){check(Array.isArray(review.citations),'.citations');uniqueRows(review.citations,'.citations',1280);review.citations.forEach((c,i)=>citation(c,'.citations['+i+']',true));}
 else check(review.citations===undefined,'.citations');
 review.requirements.forEach((r,i)=>{
  const field='.requirements['+i+']';check(object(r),field);check(text(r.id),field+'.id');
  check(['satisfied','gap','deferred'].includes(r.status),field+'.status');strings(r.claimIds,field+'.claimIds',true);
  optionalText(r,'reason',field);optionalText(r,'deferredStepId',field);
 });
 review.claims.forEach((c,i)=>{
  const field='.claims['+i+']';check(object(c),field);check(text(c.id),field+'.id');check(text(c.artifactId),field+'.artifactId');
  check(typeof c.text==='string'&&c.text.length<=3000,field+'.text');check(['fact','inference','unknown','proposal'].includes(c.kind),field+'.kind');
  check(typeof c.supported==='boolean',field+'.supported');optionalText(c,'reason',field);
  if(compact){check(c.citations===undefined,field+'.citations');boundedIds(c.citationIds,field+'.citationIds',0,8);}
  else {check(c.citationIds===undefined,field+'.citationIds');check(Array.isArray(c.citations)&&c.citations.length<=8,field+'.citations');c.citations.forEach((q,j)=>citation(q,field+'.citations['+j+']',false));}
 });
 if(review.sourceConflicts!==undefined){
  check(Array.isArray(review.sourceConflicts)&&review.sourceConflicts.length<=80,'.sourceConflicts');
  review.sourceConflicts.forEach((c,i)=>{
   const field='.sourceConflicts['+i+']';check(compact&&object(c),field);check(c.disposition==='disclosed_unknown',field+'.disposition');
   for(const [key,max] of [['claimIds',16],['requirementIds',80],['citationIds',128]])boundedIds(c[key],field+'.'+key,1,max);
   check(typeof c.reason==='string',field+'.reason');
  });
 }
 return review;
}
module.exports={evidenceProtocol};
