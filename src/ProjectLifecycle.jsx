import React,{useEffect,useState} from 'react';
import {Archive,RotateCcw,RefreshCw,ChevronDown,ChevronUp} from 'lucide-react';
import './project-lifecycle.css';
export default function ProjectLifecycle({data,project,act}){
  const [expanded,setExpanded]=useState(!!project.archivedAt),[preview,setPreview]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const archived=!!project.archivedAt,busy=!!data.operation||loading;
  async function refresh(){setLoading(true);setError('');try{setPreview(await act('projectLifecyclePreview',{id:project.id}));}catch(e){setError(e.message);}finally{setLoading(false);}}
  useEffect(()=>{setPreview(null);setError('');setExpanded(!!project.archivedAt);},[project.id,project.archivedAt]);
  useEffect(()=>{if(expanded&&!preview&&!loading&&!error)refresh();},[expanded,preview,loading,error]);
  async function submit(){setLoading(true);setError('');try{await act(archived?'projectLifecycleReopen':'projectLifecycleArchive',{id:project.id,revision:preview.revision},archived?'项目已重新打开，各入口保持暂停':'项目已归档，历史记录保留');setPreview(null);}catch(e){setError(e.message);}finally{setLoading(false);}}
  return <section className={`project-lifecycle ${archived?'is-archived':''}`} aria-label="项目归档">
    <header><div><h3><Archive size={17}/>{archived?'项目已归档':'项目收尾与归档'}</h3><p>{archived?'可查看材料、事项和历史产出。重新打开后，按需恢复委托与采集入口。':'结束这一阶段时，统一暂停项目的采集、推进和自动发送，并保留历史。'}</p></div><button className="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起':'查看归档影响'}{expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</button></header>
    {expanded&&<div className="project-lifecycle-body">{preview&&<>
      {archived?<p>归档时间：{new Date(preview.archivedAt).toLocaleString('zh-CN')}</p>:<><div className="project-lifecycle-groups">{preview.groups.filter(g=>g.count).map(g=><div key={g.key}><strong>{g.label} <span>{g.count}</span></strong><p>{g.items.slice(0,6).map(row=>row.name).join('、')}{g.count>6?`，另 ${g.count-6} 项`:''}</p></div>)}{!preview.groups.some(g=>g.count)&&<p>当前没有需要暂停的自动工作。</p>}</div><p className="help-text">归档后自动写入改为逐项确认，飞书发送授权关闭。重新打开项目也不会自动恢复这些授权。</p></>}
      <p className="project-lifecycle-preserved">保留 {preview.preserved.tasks} 个事项、{preview.preserved.sources} 份材料、{preview.preserved.artifacts} 份产出和 {preview.preserved.receipts} 条执行记录。</p>
      {preview.unresolved.length>0&&<div className="project-lifecycle-unresolved" role="status"><strong>{preview.unresolved.length} 条外部执行结果尚未确认</strong><p>这些记录继续保留原状态。重新打开项目后先核对，系统不会把归档视为执行成功。</p><ul>{preview.unresolved.slice(0,6).map(r=><li key={r.id}>{r.title} · {r.tool}</li>)}</ul></div>}
    </>}{error&&<p className="form-error" role="alert">{error}</p>}<div className="project-lifecycle-actions"><button className="button" disabled={busy} onClick={refresh}><RefreshCw size={15}/>刷新影响</button><button className="button" disabled={busy||!preview} onClick={submit}>{archived?<RotateCcw size={15}/>:<Archive size={15}/>} {archived?'重新打开项目':'归档并暂停以上工作'}</button></div>{loading&&<p className="help-text">正在核对项目状态…</p>}</div>}
  </section>;
}
