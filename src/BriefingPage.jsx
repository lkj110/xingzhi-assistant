import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,BookOpenCheck,ChevronLeft,ChevronRight,Download,RefreshCw} from 'lucide-react';
import {download} from './api';
import './briefing.css';
import BriefingSchedule from './BriefingSchedule';

const when=value=>value?new Date(value).toLocaleString('zh-CN'):'未记录';
const rangeLabels={'24h':'最近 24 小时','7d':'最近 7 天','30d':'最近 30 天'};
export default function BriefingPage({data,act,openTask,openJob,openProject}) {
  const [projectId,setProjectId]=useState(''),[range,setRange]=useState('7d'),[pages,setPages]=useState({}),[result,setResult]=useState(null),[loading,setLoading]=useState(true),[exporting,setExporting]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const sequence=useRef(0),actRef=useRef(act);actRef.current=act;
  // Event and state stamps avoid reloading every time the parent polls state.
  const version=JSON.stringify([data.events?.[0]?.id,(data.projects||[]).map(p=>[p.id,p.name]),(data.tasks||[]).map(t=>[t.id,t.status,t.updatedAt,t.completedAt,t.dueAt]),(data.delegations||[]).map(j=>[j.id,j.status,j.updatedAt]),(data.sources||[]).map(s=>[s.id,s.deleted,s.projectExcluded]),(data.agentActions||[]).map(r=>[r.id,r.status,r.finishedAt]),(data.decisions||[]).map(d=>[d.id,d.status])]);
  useEffect(()=>{const timer=setInterval(()=>setRefresh(value=>value+1),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const id=++sequence.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('briefingSnapshot',{projectId,range,pages})).then(value=>{if(sequence.current===id)setResult(value);}).catch(e=>{if(sequence.current===id){setResult(null);setError(e.message);}}).finally(()=>{if(sequence.current===id)setLoading(false);});
    return()=>{sequence.current++;};
  },[projectId,range,pages,refresh,version]);
  async function exportSummary(format) {
    setExporting(true);setError('');
    try {const report=await actRef.current('briefingExport',{projectId,range,format});download(report.filename,report.content,report.mime);}
    catch(e){setError(e.message);}finally{setExporting(false);}
  }
  function open(row,key) {
    const route=row.route||{};
    if(route.jobId&&(key==='followups'||key==='decisions'&&row.kind!=='review'))openJob(route.jobId);
    else if(route.taskId)openTask(route.taskId);
    else if(route.jobId)openJob(route.jobId);
    else if(route.projectId)openProject(route.projectId);
  }
  const blocked=loading||exporting;
  return <div className="briefing-page">
    <section className="briefing-intro"><div><BookOpenCheck size={25}/><h2>回顾进展，安排下一步</h2></div><p>把各项目的实际交付、完成记录和材料变化汇总到一起，再查看当前等待你处理的事情。</p><small>本地只读汇总 · 本次模型调用 0 次 · 本次网络请求 0 次</small></section>
    <BriefingSchedule data={data} act={act}/>
    <div className="briefing-toolbar"><div className="briefing-selects"><label>所属项目<select aria-label="简报所属项目" value={projectId} disabled={exporting} onChange={e=>{setProjectId(e.target.value);setPages({});}}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{(data.projects||[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>回顾时间<select aria-label="简报回顾时间" value={range} disabled={exporting} onChange={e=>{setRange(e.target.value);setPages({});}}>{Object.entries(rangeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div><div className="briefing-actions"><button className="button" disabled={blocked} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/>刷新简报</button><button className="button" disabled={blocked||!result} onClick={()=>exportSummary('md')}><Download size={15}/>导出简报 Markdown</button><button className="button" disabled={blocked||!result} onClick={()=>exportSummary('json')}>导出简报 JSON</button></div></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div aria-busy={loading} aria-label="工作简报结果">
      {loading?<p className="briefing-loading" role="status">正在汇总本地记录…</p>:result&&<>
        <div className="briefing-counts">{Object.entries(result.sections).map(([key,section])=><a href={`#briefing-${key}`} key={key}><span>{section.label}</span><strong>{section.total}</strong><small>{section.period==='current'?'当前状态':rangeLabels[range]}</small></a>)}</div>
        <p className="briefing-dates">{result.scopeLabel} · {when(result.from)} — {when(result.to)}<br/>完成记录：检查通过 {result.completionCounts.checked} 项，含人工执行证据 {result.completionCounts.manualEvidence} 项，证据待核对 {result.completionCounts.unverified} 项。</p>
        {result.notices.length>0&&<div className="briefing-notices">{result.notices.map(note=><p key={note}>{note}</p>)}</div>}
        <div className="briefing-sections">{Object.entries(result.sections).map(([key,section])=><section key={key} className="briefing-section" id={`briefing-${key}`} aria-label={section.label}><header><div><h3>{section.label}<span>{section.total} 条</span></h3><p>{section.period==='current'?'当前状态，不受回顾时间限制':rangeLabels[range]+'内的保留记录'}</p></div></header>
          {section.items.length?section.items.map(row=><article key={row.id} className={`briefing-row ${row.overdue?'overdue':''}`}><div className="briefing-row-main"><div className="briefing-row-heading"><h4>{row.title}</h4><span className={`briefing-tag ${row.kind==='unverified'?'attention':''}`}>{row.label}</span></div><small>{row.project} · {when(row.at)}{row.version?` · 第 ${row.version} 版`:''}</small><p>{row.detail}</p>{(row.deadlineAt||row.checkAt)&&<p className="briefing-followup-time">{row.deadlineAt&&<>期限：{when(row.deadlineAt)}　</>}{row.checkAt&&<>计划检查：{when(row.checkAt)}{row.paused?'（已暂停）':''}</>}</p>}</div>{(row.route?.taskId||row.route?.jobId||row.route?.projectId)&&<button className="button small" onClick={()=>open(row,key)}>查看工作<ArrowUpRight size={14}/></button>}</article>):<div className="briefing-empty">{section.period==='current'?'当前没有匹配记录。':'所选期间内没有保留的匹配记录。'}</div>}
          {section.total>0&&<footer className="briefing-pagination"><small>显示 {section.from}–{section.to} 条，共 {section.total} 条</small>{section.pageCount>1&&<div><button className="button small" aria-label={`${section.label}上一页`} disabled={section.page<=1} onClick={()=>setPages(value=>({...value,[key]:section.page-1}))}><ChevronLeft size={14}/></button><span>{section.page} / {section.pageCount}</span><button className="button small" aria-label={`${section.label}下一页`} disabled={section.page>=section.pageCount} onClick={()=>setPages(value=>({...value,[key]:section.page+1}))}><ChevronRight size={14}/></button></div>}</footer>}
        </section>)}</div>
        <section className="briefing-limitations"><h3>简报范围</h3><ul>{result.limitations.map(note=><li key={note}>{note}</li>)}</ul><p>导出会重新读取当前记录，包含筛选范围的全部页；默认不附正文。</p></section>
      </>}
    </div>
  </div>;
}
