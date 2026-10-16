import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCircle2,FileText,GitBranch,RefreshCw} from 'lucide-react';
import './workmap.css';

const filters={all:'全部工作',actionable:'可继续处理',blocked:'等待与阻塞',check:'关联或依据待核对',completed:'有效完成',cancelled:'已取消'};
const kinds={analysis:'分析',draft:'文稿',external:'外部动作'};
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'未设置';
function References({title,items,open,disabled}) {
  const [count,setCount]=useState(10);
  if(!items.length)return null;
  return <details className="workmap-references"><summary>{title} · {items.length}</summary><ul>{items.slice(0,count).map((item,index)=><li key={`${item.id}:${index}`}><button className="text-button" disabled={disabled||!item.available} onClick={()=>open(item)}><FileText size={13}/>{item.title}{item.available&&<ArrowUpRight size={13}/>}</button>{item.current===false&&<small>材料已更新、撤回或关联待核对</small>}{!item.available&&<small>请进入原事项核对关联</small>}</li>)}</ul>{count<items.length&&<button className="text-button" disabled={disabled} onClick={()=>setCount(n=>n+10)}>再显示 {Math.min(10,items.length-count)} 条 · 还剩 {items.length-count} 条</button>}</details>;
}
export default function WorkMapPage({data,act,openTask,openJob,openProject,openResult}) {
  const [projectId,setProjectId]=useState(''),[jobId,setJobId]=useState(''),[state,setState]=useState('all'),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0),[result,setResult]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const sequence=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const token=++sequence.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('workmapSnapshot',{projectId,jobId,state,page,pageSize:20})).then(value=>{if(sequence.current===token)setResult(value);}).catch(e=>{if(sequence.current===token)setError(e.message);}).finally(()=>{if(sequence.current===token)setLoading(false);});
    return()=>{sequence.current++;};
  },[projectId,jobId,state,page,refresh,data.events?.[0]?.id,!!data.operation]);
  function scope(value){setProjectId(value);setJobId('');setPage(1);setResult(null);}
  const blocked=loading||!!error,items=result?.items||[];
  function open(item){if(item.taskId)openTask?.(item.taskId);else if(item.jobId)openJob?.(item.jobId);}
  return <div className="workmap-page">
    <section className="workmap-intro"><div><GitBranch size={25}/><h2>看清目标如何一步步推进</h2></div><p>把目标、前置事项、当前步骤、材料和产出放在同一张工作地图。先看为什么停住，再进入原记录处理。</p><small>只汇总本机记录 · 模型调用 0 次 · 网络请求 0 次</small></section>
    <div className="workmap-toolbar"><label>所属项目<select aria-label="工作地图所属项目" value={projectId} onChange={e=>scope(e.target.value)}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{(data.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>所属委托<select aria-label="工作地图所属委托" value={jobId} onChange={e=>{setJobId(e.target.value);setPage(1);}}><option value="">全部委托与事项</option>{(result?.jobs||(data.delegations||[]).filter(job=>!projectId||(projectId==='@independent'?!job.projectId:job.projectId===projectId))).map(job=><option key={job.id} value={job.id}>{job.title}</option>)}</select></label><button className="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/>刷新工作地图</button></div>
    <div className="workmap-filters" aria-label="工作地图状态">{Object.entries(filters).map(([key,label])=><button key={key} className={state===key?'active':''} aria-pressed={state===key} onClick={()=>{setState(key);setPage(1);}}>{label}<span>{result?.counts?.[key]||0}</span></button>)}</div>
    {error&&<p className="form-error" role="alert">{error} <button className="text-button" onClick={()=>{setJobId('');setRefresh(value=>value+1);}}>重新读取</button></p>}
    {!error&&result?.automatic&&!result.automatic.automaticAllowed&&<p className="workmap-gate">{result.automatic.message}{result.automatic.nextAllowedAt&&` · 最早恢复 ${when(result.automatic.nextAllowedAt)}`}</p>}
    {!error&&result?.next&&<section className="workmap-next" aria-label="工作地图建议下一步"><div><small>当前项目与委托范围内，建议先查看</small><h3>{result.next.title}</h3><p>{result.next.reason}</p></div><button className="button primary small" disabled={blocked} onClick={()=>open(result.next)}>进入原记录<ArrowUpRight size={14}/></button></section>}
    <section className="workmap-items" aria-label="工作地图事项列表" aria-busy={loading}><header><strong>{loading?'正在整理本地工作地图…':`${result?.total||0} 项${filters[state]}`}</strong><small>第 1 层没有前置事项；后续层依赖前面的工作。</small></header>
      {!error&&items.map(item=><article className={`workmap-card ${item.state}`} key={item.id}>
        <div className="workmap-card-heading"><span>{item.type==='job'?'待拆解委托':item.layer===null?'依赖链待核对':`第 ${item.layer+1} 层`}</span><span className="workmap-state">{item.stateLabel}</span><span>{item.statusLabel}</span>{item.priority==='high'&&<span>优先处理</span>}</div>
        <button className="workmap-title" disabled={blocked} onClick={()=>open(item)}>{item.title}<ArrowUpRight size={16}/></button>
        <div className="workmap-scope">{item.projectId?<button className="text-button" disabled={blocked} onClick={()=>openProject?.(item.projectId)}>{item.projectName}</button>:<span>{item.projectName}</span>}{item.jobId&&item.type==='task'&&<button className="text-button" disabled={blocked} onClick={()=>openJob?.(item.jobId)}>{item.jobTitle||'打开所属委托'}<ArrowUpRight size={12}/></button>}</div>
        {item.goal&&<details className="workmap-goal"><summary>{item.type==='job'||item.jobId?'委托目标':'完成标准'}</summary><p>{item.goal}</p></details>}
        <div className="workmap-current"><strong>当前步骤</strong><p>{item.currentStep}</p>{item.dueAt&&<small>事项截止：{when(item.dueAt)}</small>}{item.scheduledAt&&!['completed','cancelled'].includes(item.state)&&<small>委托计划检查 / 推进：{when(item.scheduledAt)}</small>}</div>
        <section className="workmap-dependencies" aria-label={`前置事项：${item.title}`}><header><strong>前置事项</strong><span className={item.dependencyReady?'ready':'waiting'}>{item.dependencyReady?'依赖已就绪':'依赖尚未就绪'}</span></header>{!item.dependencies.length?<p>没有前置事项。是否继续还需结合下方执行条件。</p>:<ol>{item.dependencies.map((dependency,index)=><li key={`${dependency.id}:${index}`}><button className="text-button" disabled={blocked||!dependency.available} onClick={()=>openTask?.(dependency.id)}>{dependency.valid&&<CheckCircle2 size={14}/>}<span>{dependency.title}</span>{dependency.available&&<ArrowUpRight size={13}/>}</button><small>{dependency.detail}</small></li>)}</ol>}</section>
        {(item.issues.length>0||item.gates.length>0)&&<section className="workmap-reasons" aria-label={`推进条件：${item.title}`}><h4>{item.issues.length?'需要核对':'当前执行条件'}</h4><ul>{[...item.issues,...item.gates].map((reason,index)=><li key={`${reason.code}:${index}`}>{reason.message}</li>)}</ul></section>}
        {item.state==='actionable'&&<p className="workmap-ready">当前记录没有已知阻塞。实际执行时会重新检查权限与额度，并按委托或独立事项的计划推进。</p>}
        {item.steps.length>0&&<details className="workmap-steps"><summary>执行步骤 · {item.steps.filter(step=>step.done).length} / {item.steps.length} 已完成</summary><ol>{item.steps.map((step,index)=><li key={`${step.id}:${index}`}><span>{step.done?'已完成':'未完成'} · {kinds[step.kind]||'类型待核对'}</span><p>{step.title}</p></li>)}</ol></details>}
        <div className="workmap-evidence"><References title="当前材料依据" items={item.sources} open={record=>openResult?.(record)} disabled={blocked}/><References title="当前步骤产出" items={item.artifacts} open={record=>openResult?.(record)} disabled={blocked}/></div>
      </article>)}
      {!loading&&!error&&!items.length&&<div className="workmap-empty"><GitBranch size={28}/><h3>当前筛选没有工作</h3><p>切换项目或状态，或者先在 Agent 委托中添加目标。</p></div>}
    </section>
    {result?.pageCount>1&&!error&&<nav className="workmap-pagination" aria-label="工作地图分页"><button className="button small" disabled={blocked||result.page<=1} onClick={()=>setPage(result.page-1)}>上一页</button><span>第 {result.page} / {result.pageCount} 页 · {result.from}–{result.to} 项</span><button className="button small" disabled={blocked||result.page>=result.pageCount} onClick={()=>setPage(result.page+1)}>下一页</button></nav>}
    <section className="workmap-help"><h3>如何阅读工作地图</h3><ul>{(result?.notices||[]).map(note=><li key={note}>{note}</li>)}<li>暂停、额度、待决定和动作确认会单独显示。查看地图和打开记录不会恢复工作、批准动作或修改任务。</li><li>状态筛选只影响下方列表，建议下一步仍查看当前项目与委托的全部工作。</li><li>材料与产出只显示当前步骤引用的记录；历史版本可进入原事项或全局检索查看。</li></ul></section>
  </div>;
}
