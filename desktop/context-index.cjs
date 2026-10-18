// Scope and policy filtering happen in task-context before this directory is built.
const keys=['id','ref','version','type','title','purpose','state','ambiguous','taskId','characters','readTool','readView','stepId'];
const pick=(row,names)=>Object.fromEntries(names.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
function catalog(rows){
 const seen=new Set();return (rows||[]).filter(row=>{
  const key=JSON.stringify([row.ref||row.id,row.purpose,row.state]);if(seen.has(key))return false;seen.add(key);return true;
 }).map(row=>({...pick(row,keys),...(row.sections?{sectionCount:row.sections.length}:{})}));
}
function page(snapshot,args={}){
 const allowed=['tool','start','limit','query','history','type','taskId','ref','note'];
 if(Object.keys(args).some(k=>!allowed.includes(k))||args.start!==undefined&&(!Number.isSafeInteger(args.start)||args.start<0)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>40)||args.history!==undefined&&typeof args.history!=='boolean'||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>300)||args.type!==undefined&&!['source','artifact'].includes(args.type)||['taskId','ref'].some(k=>args[k]!==undefined&&typeof args[k]!=='string'))throw require('./model-errors.cjs').contextError('CONTEXT_INVALID_REQUEST',{message:'目录参数无效；start 为非负整数，limit 为 1–40，query 为最多 300 字符，history 为布尔值。'});
 const current=snapshot.readableCatalog||[],history=snapshot.historyCatalog||[],seen=new Set(),query=(args.query||'').toLowerCase();
 const rows=[...(args.history===true?[]:current),...(args.history===false?[]:history)].filter(row=>{
  const key=JSON.stringify([row.ref||row.id,row.purpose,row.state]);if(seen.has(key))return false;seen.add(key);
  return (!args.type||row.type===args.type)&&(!args.taskId||row.taskId===args.taskId)&&(!args.ref||row.ref===args.ref)&&(!query||[row.id,row.ref,row.title,...(row.sections||[]).map(s=>s.title)].join('\n').toLowerCase().includes(query));
 });
 const start=args.start??0,limit=args.limit??40;
 return {ok:true,directory:true,total:rows.length,start,next:start+limit<rows.length?start+limit:null,contextRevision:snapshot.contextRevision,sources:catalog(rows.slice(start,start+limit)),...(args.ref?{sections:rows.find(r=>r.ref===args.ref)?.sections||[]}:{}),note:'仅索引。需要章节目录可用 ref 查询本工具；读取历史正文须 history:true。'};
}
module.exports={catalog,page,pick};
