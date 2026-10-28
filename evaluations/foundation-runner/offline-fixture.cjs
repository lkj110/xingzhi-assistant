'use strict';
// Loaded exclusively by --offline. Synthetic answers exercise plumbing, not model quality.
const path=require('node:path'),assert=require('node:assert/strict'),{pack:defaultPack,read}=require('./common.cjs');
function createFixture({pack=defaultPack,plan}={}){
 const gold=read(path.join(pack,'gold.json')),seen=new Set();
 return async({context,role,payload})=>{
  const g=gold.cases.find(g=>g.id===context.id),gateId=plan?.protocolGate.id||'G00-ronglan';
  const draft=context.id===gateId?(gold.protocolGate?.referenceDraft||'容澜登记袋号K-314，共7袋，仅供档案组复核，尚未向外移交。'):context.revised?g.referenceDraft:(g.initialReferenceDraft||g.referenceDraft);
  if(role==='execute')return payload.revision?{kind:'patch',edits:[{before:payload.revision.originalContent,after:draft}],summary:'OFFLINE SYNTHETIC'}:{kind:'artifact',title:context.title,content:draft,summary:'OFFLINE SYNTHETIC'};
  const ids=payload.groundingReviewRequest.artifactIds,key=JSON.stringify(ids);
  if(!seen.has(key)){seen.add(key);return {kind:'read_context',requests:context.sources.map(s=>({tool:'read_source',sourceId:s.id}))};}
  const negative=context.lane==='fixed_invalid',text=negative?context.candidate:draft;
  const citations=context.sources.map((s,i)=>({id:'e'+i,sourceId:s.id,quote:s.content,start:0})),citationIds=citations.map(c=>c.id);
  const claims=[{id:'c1',artifactId:ids[0],text,kind:'fact',supported:!negative,citationIds}];
  const requirements=payload.groundingChecklist.requirements.map(r=>({id:r.id,status:negative?'gap':'satisfied',claimIds:['c1'],...(negative?{reason:'OFFLINE SYNTHETIC: 原文明确否定候选结论'}:{})}));
  const groundingReview={format:'compact-v3',scannedArtifactIds:ids,citations,requirements,claims,unsupportedClaims:negative?[text]:[],conflicts:[]};
  const unknownText=g?.unknownText||(context.id==='F02-chengdao-disagreement'?'目前不能确定唯一封箱数':null);
  if(unknownText){
   assert.ok(draft.includes(unknownText));
   claims.push({id:'u1',artifactId:ids[0],text:unknownText,kind:'unknown',supported:true,citationIds});
   for(const requirement of requirements)requirement.claimIds.push('u1');
   groundingReview.sourceConflicts=[{claimIds:['u1'],requirementIds:requirements.map(r=>r.id),citationIds,disposition:'disclosed_unknown',reason:'OFFLINE SYNTHETIC: 同级冲突已明确披露，未选边'}];
  }
  // Explicit fixture-only proposal claims exercise the notification tone rule;
  // do not make every notice a fact to hide that rule from the package rehearsal.
  for(const [index,claim]of ((context.revised?g?.notificationClaims:g?.initialNotificationClaims||g?.notificationClaims)||[]).entries()){
   assert.equal(claim.kind,'proposal');assert.ok(draft.includes(claim.text));const id='n'+index;
   claims.push({id,artifactId:ids[0],text:claim.text,kind:'proposal',supported:true,citationIds});
   for(const requirement of requirements)requirement.claimIds.push(id);
  }
  return {passed:!negative,summary:'OFFLINE SYNTHETIC',gaps:negative?['原文明确否定候选结论']:[],groundingReview};
 };
}
module.exports={createFixture};
