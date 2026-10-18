const {contextError}=require('./model-errors.cjs');
function page(a,operation,args){
 const allowed=['tool','taskId','obligationId','section','start','limit','contextRevision','coverageVersion','path'];
 if(Object.keys(args).some(k=>!allowed.includes(k))||args.start!==undefined&&(!Number.isSafeInteger(args.start)||args.start<0)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>16))throw contextError('CONTEXT_INVALID_REQUEST');
 const {owner,context}=operation.snapshot(),job=owner.job;
 if(!job)throw contextError('CONTEXT_SCOPE_DENIED');
 const task=owner.task||a.data.tasks.find(t=>t.id===args.taskId&&t.agentJobId===job.id&&job.taskIds.includes(t.id));
 if(!task||args.taskId&&args.taskId!==task.id||task.deletedAt||task.agentCancelled||(task.projectId||null)!==(job.projectId||null))throw contextError('CONTEXT_SCOPE_DENIED');
 if(args.contextRevision&&args.contextRevision!==context.contextRevision)throw contextError('CONTEXT_VERSION_CHANGED');
 // context() re-resolves all source authorization and versions; this is never an authority token.
 const all=require('./relation-obligations.cjs').context(a,job,task),o=all.find(o=>o.id===args.obligationId),section=args.section||'obligations';
 const coverageVersion=require('./evidence-basis.cjs').hash({contextRevision:context.contextRevision,taskId:task.id,all});
 if(args.coverageVersion&&args.coverageVersion!==coverageVersion)throw contextError('CONTEXT_VERSION_CHANGED');
 if((args.start>0||args.path?.length)&&!args.coverageVersion)throw contextError('CONTEXT_INVALID_REQUEST',{message:'后续页需携带上一页的 coverageVersion'});
 let rows;
 if(section==='obligations')rows=all.map(require('./model-input.cjs').relation);
 else{
  if(!o)throw contextError('CONTEXT_SCOPE_DENIED');
  if(!['frontier','roots','observations','proofSourceIds','receipt'].includes(section))throw contextError('CONTEXT_INVALID_REQUEST');
  rows=section==='receipt'?(o.lastReceipt?.sourceIds||[]):o.physicalCoverage?.[section]||[];
 }
 const path=args.path||[];
 if(!Array.isArray(path)||path.length>16||path.some(k=>typeof k!=='string'&&!Number.isSafeInteger(k)||['__proto__','prototype','constructor'].includes(k)))throw contextError('CONTEXT_INVALID_REQUEST');
 let selected=rows;
 for(const k of path){if(!selected||typeof selected!=='object'||!Object.hasOwn(selected,k))throw contextError('CONTEXT_INVALID_REQUEST');selected=selected[k];}
 const isText=typeof selected==='string',isArray=Array.isArray(selected),keys=!isText&&!isArray&&selected&&typeof selected==='object'?Object.keys(selected):[];
 const start=args.start??0,limit=isText?2048:args.limit??8,total=isText?selected.length:isArray?selected.length:keys.length;
 let end=Math.min(total,start+limit),items=isText?[{text:selected.slice(start,end),start}]:isArray?selected.slice(start,end):keys.slice(start,end).map(key=>({key,value:selected[key]}));
 // A single navigation record may contain a huge root frontier; return the root summary
 // and the flat frontier page entry point instead of duplicating that graph per root.
 if(section==='roots'&&!path.length)items=items.map(r=>({...r,proofSourceIds:undefined,directions:Object.fromEntries(Object.entries(r.directions||{}).map(([k,d])=>[k,{directObserved:d.directObserved,closureProven:d.closureProven,satisfied:d.satisfied,frontierCount:d.frontier?.length||0,details:{tool:'read_obligations',taskId:task.id,obligationId:o.id,section:'frontier',start:0}}]))}));
 items=items.map((value,i)=>JSON.stringify(value).length<=16000?value:{detailOmitted:true,type:typeof value,characters:JSON.stringify(value).length,resumeRequest:{tool:'read_obligations',taskId:task.id,obligationId:o?.id,section,path:[...path,isArray?start+i:keys[start+i]],coverageVersion,start:0,limit:8}});
 while(items.length>1&&JSON.stringify(items).length>24000){items.pop();end--;}
 return {ok:true,directoryOnly:true,taskId:task.id,obligationId:o?.id,section,path,items,total,start,next:end<total?end:null,contextRevision:context.contextRevision,coverageVersion,reachesEnd:end>=total,complete:start===0&&end>=total,note:'仅所请求范围的导航页；页尾不代表关系闭合，不作为新的业务证据。'};
}
function assertCurrent(a,scope,reads){
 if(!reads?.length)return;
 require('./task-context.cjs').withContext(a,scope,operation=>{
  for(const row of reads)page(a,operation,{...row.request,start:0,path:[],coverageVersion:row.result.coverageVersion,contextRevision:row.result.contextRevision,limit:1});
 });
}
module.exports={page,assertCurrent};
