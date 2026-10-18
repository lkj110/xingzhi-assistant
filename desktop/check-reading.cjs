'use strict';
const {hash}=require('./evidence-basis.cjs');
const LIMIT=4096,MAX_CHECKS=128;
const merge=ranges=>{
 const out=[];
 for(const [start,end] of ranges.filter(([s,e])=>Number.isSafeInteger(s)&&Number.isSafeInteger(e)&&s>=0&&e>s).sort((a,b)=>a[0]-b[0])){
  const last=out.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else out.push([start,end]);
 }
 return out;
};
function subtract(ranges,covered){
 const out=[];
 for(const [start,end] of merge(ranges)){
  let cursor=start;
  for(const [s,e] of merge(covered)){if(e<=cursor)continue;if(s>=end)break;if(s>cursor)out.push([cursor,Math.min(s,end)]);cursor=Math.max(cursor,e);}
  if(cursor<end)out.push([cursor,end]);
 }
 return out;
}
const size=ranges=>ranges.reduce((n,[s,e])=>n+e-s,0);
// Resolve content references only against the exact projected model input.
function text(object,key,root){
 if(typeof object?.[key]==='string')return object[key];
 const ref=object?.[key+'Ref'];if(!ref)return '';
 const body=String(ref.path||'').replace(/\[(\d+)\]/g,'.$1').split('.').reduce((v,k)=>v?.[k],root);
 return typeof body==='string'&&Number.isSafeInteger(ref.start)&&Number.isSafeInteger(ref.end)&&ref.start>=0&&ref.end>=ref.start&&ref.end<=body.length?body.slice(ref.start,ref.end):'';
}
function coverage(result,root=result){
 const c=result?.canonical;if(c?.schema!==1||!c.resource||!c.version)return null;
 const ranges=[];
 if(Number.isSafeInteger(c.origin)){
  const body=text(result,'content',root),start=c.origin+(result.start??0);
  if(body.trim())ranges.push([start,start+body.length]);
 }
 for(const segment of result.segments||[]){
  const body=text(segment,'text',root);
  if(Number.isSafeInteger(segment.sourceStart)&&body.trim())ranges.push([segment.sourceStart,segment.sourceStart+body.length]);
 }
 return {key:hash([c.resource,c.version]),resource:c.resource,version:c.version,ranges:merge(ranges)};
}
function visible(context){
 const map={};
 for(const r of [...(context.contextReads||[]).map(r=>r.result),...(context.generationEvidence||[]),...(context.requestedSections||[]),...(context.retrievedEvidence||[])]){
  const c=coverage(r,context);if(c)map[c.key]=merge([...(map[c.key]||[]),...c.ranges]);
 }
 return map;
}
function useful(result,ranges){
 const spans=[];
 if(Number.isSafeInteger(result.canonical?.origin)&&typeof result.content==='string')spans.push([result.canonical.origin+(result.start??0),result.content]);
 for(const s of result.segments||[])if(Number.isSafeInteger(s.sourceStart)&&typeof s.text==='string')spans.push([s.sourceStart,s.text]);
 return ranges.filter(([start,end])=>spans.some(([origin,body])=>end>origin&&start<origin+body.length&&body.slice(Math.max(0,start-origin),Math.min(body.length,end-origin)).trim()));
}
function visibleDraft(context,result){
 if(!result.artifactId||typeof result.content!=='string')return [];
 const start=(result.canonical?.origin??0)+(result.start??0),end=start+result.content.length,ranges=[];
 const candidates=[...(context.artifacts||[]).filter(r=>r.id===result.artifactId).map(r=>text(r,'content',context)),
  context.workingDraft?.id===result.artifactId?text(context.workingDraft,'content',context):'',context.revision?.artifactId===result.artifactId?text(context.revision,'originalContent',context):''];
 for(const body of candidates){const last=Math.min(end,body.length);if(last>start&&body.slice(start,last)===result.content.slice(0,last-start))ranges.push([start,last]);}
 return ranges;
}
function add(bucket,name,c,ranges){
 if(bucket.saturated)return false;
 const next=merge([...(bucket[name][c.key]||[]),...ranges]);
 const count=Object.values(bucket.seenCoverage).reduce((n,r)=>n+r.length,0)+Object.values(bucket.restoredCoverage).reduce((n,r)=>n+r.length,0);
 if(count+next.length-(bucket[name][c.key]?.length||0)>LIMIT){bucket.saturated=true;return false;}
 bucket[name][c.key]=next;return true;
}
function record(state,rows,visibleContext,{semanticCheckId,historyRows=[]}={}){
 if(!semanticCheckId)throw new TypeError('A semantic check identity is required');
 state.ineffective ||= 0;state.checks ||= {};
 let bucket=state.checks[semanticCheckId];
 if(!bucket){
  bucket={seenCoverage:{},restoredCoverage:{},navigationUsed:false,batches:0};
  if(Object.keys(state.checks).length>=MAX_CHECKS)bucket.saturated=true;
  else state.checks[semanticCheckId]=bucket;
  // Current resolver proofs retain the first restoration across generation and
  // check phases. Backfilled legacy coordinates cannot prove an unused recovery.
  for(const row of historyRows){const c=coverage(row.result);if(c){add(bucket,'seenCoverage',c,c.ranges);if(!row.restorationEligible)add(bucket,'restoredCoverage',c,c.ranges);}}
  if(Object.keys(state.coverage||{}).length||Object.keys(state.contentCoverage||{}).length||state.batches)bucket.navigationUsed=true;
 }
 const supplied=visible(visibleContext),summaries=[];
 for(const [key,ranges] of Object.entries(supplied))add(bucket,'seenCoverage',{key},ranges);
 let fresh=0,restored=0,duplicate=0,empty=0,failed=0,directory=0,unmapped=0,freshChars=0,restoredChars=0;
 const pureDirectory=rows.length>0&&rows.every(row=>row.result?.ok===true&&row.result.directoryOnly);
 const navigation=pureDirectory&&!bucket.navigationUsed&&!bucket.saturated;
 if(navigation)bucket.navigationUsed=true;
 for(const row of rows){
  const r=row?.result;
  if(r?.ok!==true){failed++;continue;}
  if(r.directoryOnly){if(navigation)directory++;else duplicate++;continue;}
  const hasBody=!!text(r,'content',r).trim()||(r.segments||[]).some(s=>typeof s.text==='string'&&s.text.trim());
  if(!hasBody){empty++;continue;}
  const c=coverage(r);
  if(!c?.ranges.length){unmapped++;continue;}
  supplied[c.key]=merge([...(supplied[c.key]||[]),...visibleDraft(visibleContext,r)]);
  add(bucket,'seenCoverage',c,supplied[c.key]);
  const seen=bucket.seenCoverage[c.key]||[],unseen=subtract(c.ranges,seen),novel=useful(r,unseen);
  const old=subtract(c.ranges,unseen),recoverable=useful(r,subtract(subtract(old,supplied[c.key]||[]),bucket.restoredCoverage[c.key]||[]));
  // Save both unions before awarding anything. Capacity exhaustion is sticky.
  const accepted=add(bucket,'seenCoverage',c,c.ranges)&&add(bucket,'restoredCoverage',c,recoverable);
  // Siblings in this batch cannot claim a restoration of each other's fresh body.
  supplied[c.key]=merge([...(supplied[c.key]||[]),...c.ranges]);
  if(accepted&&novel.length){fresh++;freshChars+=size(novel);}
  if(accepted&&recoverable.length){restored++;restoredChars+=size(recoverable);}
  if(!accepted||!novel.length&&!recoverable.length)duplicate++;
  if(summaries.length<16)summaries.push({resource:c.resource,version:c.version,coverageHash:hash(c.ranges),ranges:c.ranges.length,freshCharacters:accepted?size(novel):0,restoredCharacters:accepted?size(recoverable):0});
 }
 const ineffective=duplicate+empty+failed+unmapped+(rows.length?0:1);
 state.ineffective+=ineffective;state.batches=(state.batches||0)+1;state.updatedAt=new Date().toISOString();bucket.batches++;
 const exhausted=state.ineffective>=3&&fresh+restored===0&&!navigation;
 const outcome={fresh,restored,duplicate,empty,failed,directory,unmapped,freshChars,restoredChars,ineffective:state.ineffective,exhausted,checkpoint:null,saturated:!!bucket.saturated};
 bucket.lastBatch={...outcome,summaries};
 return outcome;
}
module.exports={record,coverage,visible,merge,subtract,LIMIT,MAX_CHECKS};
