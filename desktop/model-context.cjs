// The full resolver snapshot stays in memory for validation. Models need one
// compact directory of handles, not duplicate policy/version/section inventories.
const {catalog,pick}=require('./context-index.cjs');
function project(context,options={}){
 if(!context||!Array.isArray(context.readableCatalog))return context;
 const {readableCatalog,sourceCatalog,historyCatalog,currentArtifact,...rest}=context;
 const result={...rest,sourceCatalog:catalog([...readableCatalog,...(sourceCatalog||[]).filter(r=>r.state!=='historical')]),historyCatalog:catalog([...(historyCatalog||[]),...(sourceCatalog||[]).filter(r=>r.state==='historical')]),currentArtifact:catalog(currentArtifact),
  catalogNote:'目录保留全部可读引用；章节、版本校验及权限由 App 管理。需要正文或章节时用 read_context 按 ref/sourceId 读取、检索；历史目录须 history:true。目录是索引，不是新增要求。'};
 if(!options.stage)return result;
 const planner=options.stage==='planner';
 result.catalogIndex={current:{total:result.sourceCatalog.length,shown:Math.min(24,result.sourceCatalog.length),next:result.sourceCatalog.length>24?24:null},historical:{total:result.historyCatalog.length,shown:Math.min(8,result.historyCatalog.length),next:result.historyCatalog.length>8?8:null},tool:'list_sources',request:{tool:'list_sources',query:'标题、ID 或章节关键词',history:false,start:0,limit:24}};
 result.sourceCatalog=result.sourceCatalog.slice(0,24);result.historyCatalog=result.historyCatalog.slice(0,8);
 result.catalogNote='这是部分目录，不代表已读完资料。通过 list_sources 分页或按 query 检索全部当前/历史索引；写作模型把该请求放在 read_context.requests 内。用 ref 查询 list_sources 可取章节标题。read_context 由程序自动拼接后续页，仍有 next 时才需续读。权限和版本在每页重新校验。';
 // Never trim user intent, acceptance criteria, current draft, or requested evidence.
 // Large inventories are navigation data, fetched explicitly through read tools.
 if(result.platformInventory){const p=result.platformInventory;result.platformInventory={...pick(p,['identities','totalNodes','totalQueries','failureCount','failureNote']),nodes:[],queries:[],next:p.totalNodes?0:null,nextQueries:p.totalQueries?0:null,readTool:'platform_inventory',note:'节点和查询明细按需分页读取；已保存证据由 App 复用。'};}
 if(result.executionControl){const c=result.executionControl,frontier=c.frontier||[],pending=frontier.filter(r=>r.status!=='queried');result.executionControl={...pick(c,['version','requirements','acceptedBoundary','gaps','phases','recovery','instruction']),closedGapCount:c.closedGaps?.length||0,frontier:pending.slice(0,16),frontierTotal:c.frontierTotal,frontierStatus:Object.fromEntries([...new Set(frontier.map(r=>r.status))].map(s=>[s,frontier.filter(r=>r.status===s).length])),queryOperationCount:c.queryOperations?.length||0,detailsTool:'read_work_state',detailsSections:['frontier','queryOperations','closedGaps']};}
 if(result.decisions)result.decisions=result.decisions.map(d=>pick(d,['id','kind','question','context','options','decisionType','taskIds','sourceIds','suggestion','status','answer','answeredAt']));
 if(result.memory)result.memory=pick(result.memory,['openQuestions','nextSteps','note']);
 if(result.tasks)result.tasks=result.tasks.map(t=>{
  const {sourceIds,supersededSourceIds,artifactHistory,artifacts,...task}=t;
  return {...task,sourceCount:sourceIds?.length||0,sourceList:{tool:'list_sources',taskId:t.id,history:false},artifactHistoryCount:artifactHistory?.length||0,artifacts:(artifacts||[]).map(r=>planner?{...pick(r,['id','title','stepId','role','current','characters']),readTool:'read_artifact'}:r)};
 });
 if(planner){
  result.sources=catalog((result.sources||[]).map(s=>({...s,type:'source',readTool:'read_source'})));
  if(result.recentActions)result.recentActions=result.recentActions.slice(-3).map((r,i,rows)=>{
   if(i!==rows.length-1)return pick(r,['tool','at','error','trigger']);
   if(r.tool==='read_output_state')return {...pick(r,['tool','at','error','trigger']),result:{note:'最新事项状态已列在 tasks 与 executionControl 中；正文按 artifact 引用读取。'}};
   if(r.tool==='generation_read')return {...pick(r,['tool','at','error','trigger']),result:pick(r.result||{},['ok','sourceId','artifactId','ref','title','section','next','complete','coverage','code'])};
   return r;
  });
 }
 return result;
}
module.exports={project,catalog};
