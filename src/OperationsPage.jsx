import React,{useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CalendarDays,Check,Clock3,Download,RefreshCw} from 'lucide-react';
import {download} from './api';
import './operations.css';

const buckets={all:'全部安排',overdue:'已逾期',today:'今日剩余',upcoming:'未来 7 天',undated:'未设日期',later:'更晚'};
const priorities={high:'优先处理',normal:'普通',low:'不着急'};
function when(value,timeZone){return value?new Intl.DateTimeFormat('zh-CN',{timeZone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'未设置';}

export default function OperationsPage({data,act,openTask,openJob,openDecisions,openProject}){
  const [projectId,setProjectId]=useState(''),[bucket,setBucket]=useState('all'),[offset,setOffset]=useState(0),[result,setResult]=useState(null),[selected,setSelected]=useState({});
  const [priority,setPriority]=useState(''),[dateMode,setDateMode]=useState('keep'),[deadline,setDeadline]=useState(''),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[refresh,setRefresh]=useState(0);
  const [calendarRange,setCalendarRange]=useState('30d'),[includeOverdue,setIncludeOverdue]=useState(true),[reminder,setReminder]=useState('15'),[exporting,setExporting]=useState(false),[calendarMessage,setCalendarMessage]=useState(''),[calendarError,setCalendarError]=useState('');
  const generation=useRef(0),actRef=useRef(act);actRef.current=act;
  useEffect(()=>{const timer=setInterval(()=>setRefresh(n=>n+1),30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const id=++generation.current;setLoading(true);setError('');
    Promise.resolve().then(()=>actRef.current('operationsAgenda',{projectId,bucket,offset,limit:50})).then(r=>{if(generation.current===id)setResult(r);}).catch(e=>{if(generation.current===id)setError(e.message);}).finally(()=>{if(generation.current===id)setLoading(false);});
    return()=>{generation.current++;};
  },[projectId,bucket,offset,refresh,data.events[0]?.id,!!data.operation]);
  const selection=Object.values(selected),rows=result?.rows || [],timeZone=result?.timeZone || data.stewardship?.timeZone || 'UTC';
  const stale=selection.some(item=>!rows.some(r=>r.taskId===item.id&&r.kind==='task'&&r.revision===item.revision&&r.canSchedule));
  const blocked=loading||saving||!!error||!!data.operation;
  function filter(setter,value){setter(value);setOffset(0);setSelected({});setMessage('');setCalendarMessage('');setCalendarError('');}
  function clear(){setSelected({});setMessage('');}
  function toggle(row,checked){setSelected(value=>{const next={...value};if(checked)next[row.taskId]={id:row.taskId,revision:row.revision};else delete next[row.taskId];return next;});setMessage('');}
  async function submit(e){
    e.preventDefault();setSaving(true);setError('');setMessage('');
    const changes={};if(priority)changes.priority=priority;if(dateMode==='clear')changes.dueAt=null;if(dateMode==='set')changes.dueLocal=deadline;
    try{await act('operationsSchedule',{projectId,items:selection,changes});setMessage(`已更新 ${selection.length} 个事项的安排。`);setSelected({});setPriority('');setDateMode('keep');setDeadline('');setRefresh(n=>n+1);}
    catch(e){setError(e.message);}finally{setSaving(false);}
  }
  async function exportCalendar(){
    setExporting(true);setCalendarError('');setCalendarMessage('');
    try{
      const report=await actRef.current('calendarExport',{projectId,range:calendarRange,includeOverdue,reminderMinutes:reminder==='none'?null:Number(reminder)});
      if(!report.eventCount){setCalendarMessage('当前项目和时间范围内没有可导出的截止或跟进安排。');return;}
      download(report.filename,report.content,report.mime);
      setCalendarMessage(`已生成 ${report.eventCount} 条日历事件 · ${report.scopeLabel}。可将下载的 .ics 文件导入日历。`);
    }catch(e){setCalendarError(e.message);}finally{setExporting(false);}
  }
  return <div className="operations-page">
    <section className="operations-intro"><div><CalendarDays size={24}/><h2>把今天需要关注的工作放在一起</h2></div><p>根据截止时间与优先级给出建议处理次序。Agent 沿用各自计划执行；检查时间表示再次查看信息的时间。</p><small>{result?.today} · {timeZone} · 汇总本机记录，不调用模型</small></section>
    <div className="operations-toolbar"><label>所属项目<select aria-label="安排所属项目" value={projectId} disabled={exporting||saving} onChange={e=>filter(setProjectId,e.target.value)}><option value="">全部项目与独立工作</option><option value="@independent">仅独立工作</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="button" disabled={saving} onClick={()=>{clear();setRefresh(n=>n+1);}}><RefreshCw size={15}/>刷新安排</button></div>
    <section className="operations-calendar" aria-label="导出日历安排"><header><CalendarDays size={18}/><h3>在日历中查看截止与跟进</h3></header><div className="operations-calendar-controls"><label>导出时间<select aria-label="日历导出时间范围" value={calendarRange} disabled={exporting} onChange={e=>{setCalendarRange(e.target.value);setCalendarMessage('');}}><option value="7d">从现在起未来 7 天</option><option value="30d">从现在起未来 30 天</option><option value="90d">从现在起未来 90 天</option></select></label><label>日历提醒<select aria-label="日历提醒时间" value={reminder} disabled={exporting} onChange={e=>{setReminder(e.target.value);setCalendarMessage('');}}><option value="none">不设置提醒</option><option value="0">到点提醒</option><option value="15">提前 15 分钟</option><option value="60">提前 1 小时</option></select></label><label className="operations-calendar-check"><input type="checkbox" checked={includeOverdue} disabled={exporting} onChange={e=>{setIncludeOverdue(e.target.checked);setCalendarMessage('');}}/>包含过去 30 天逾期安排</label><button className="button" disabled={exporting||loading||saving||!!error} onClick={exportCalendar}><Download size={15}/>{exporting?'正在生成日历…':'导出日历 .ics'}</button></div><p>使用上方所属项目范围，包含全部页的截止与跟进，不受下方时间标签或所选事项限制。未设日期、已结束和已取消工作不导出，暂停工作保留日期。</p><p>这是一次导出快照，没有双向同步；后续变更需重新导入，已导入的旧事件需在日历中自行移除。日历按自身时区显示并负责提醒，已过提醒时间的事件不加提醒。</p>{calendarError&&<p className="form-error" role="alert">{calendarError}</p>}{calendarMessage&&<p className="operations-success" role="status">{calendarMessage}</p>}</section>
    <div className="operations-tabs" aria-label="安排时间范围">{Object.entries(buckets).map(([key,label])=><button key={key} className={bucket===key?'active':''} aria-pressed={bucket===key} onClick={()=>filter(setBucket,key)}>{label}<span>{key==='all'?Object.values(result?.counts || {}).reduce((n,v)=>n+v,0):result?.counts[key] || 0}</span></button>)}</div>
    {result?.automatic&&!result.automatic.automaticAllowed&&<p className="operations-gate"><Clock3 size={16}/>{result.automatic.message}{result.automatic.nextAllowedAt?` · 最早恢复 ${when(result.automatic.nextAllowedAt,timeZone)}`:''}</p>}
    <section className="operations-schedule" aria-label="批量安排事项"><header><h3>批量安排</h3><span>已选 {selection.length} 个事项</span><button className="text-button" disabled={!selection.length||saving} onClick={clear}>清空选择</button></header><p>统一设置优先级或截止时间，保存后各事项沿用原有推进、暂停和验收状态。跟进期限请在委托中处理。</p>
      <form onSubmit={submit}><label>优先级<select aria-label="批量优先级" value={priority} onChange={e=>setPriority(e.target.value)} disabled={saving}><option value="">保留原优先级</option>{Object.entries(priorities).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>截止时间<select aria-label="批量截止时间方式" value={dateMode} onChange={e=>setDateMode(e.target.value)} disabled={saving}><option value="keep">保留原时间</option><option value="set">设置统一时间</option><option value="clear">清空截止时间</option></select></label>{dateMode==='set'&&<label>新截止时间 · {timeZone}<input type="datetime-local" aria-label="批量新截止时间" required value={deadline} onChange={e=>setDeadline(e.target.value)} disabled={saving}/></label>}<button className="button primary" disabled={blocked||stale||!selection.length||!priority&&dateMode==='keep'||dateMode==='set'&&!deadline}><Check size={15}/>{saving?'正在保存…':'保存所选安排'}</button></form>
      {stale&&<p className="form-error" role="alert">所选事项已变化，请刷新安排后重新选择。本次不会自动覆盖新进展。</p>}{message&&<p className="operations-success" role="status">{message}</p>}
    </section>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="operations-results" aria-busy={loading}><header><strong>{loading?'正在汇总安排…':`${result?.total || 0} 条安排`}</strong><small>已完成和已取消事项不在本页显示</small></header>
      {rows.map(row=><article className={`operations-row ${row.bucket}`} key={row.id}>
        <div className="operations-row-top">{row.kind==='task'?<input type="checkbox" aria-label={`选择安排：${row.title}`} checked={!!selected[row.taskId]} disabled={blocked||!row.canSchedule} onChange={e=>toggle(row,e.target.checked)}/>:<Clock3 size={17}/>}<span className="operations-kind">{row.kind==='task'?'事项':'跟进'}</span><span>{row.statusLabel}</span>{row.priority==='high'&&<span className="operations-priority">优先处理</span>}<span className="operations-bucket">{buckets[row.bucket]}</span></div>
        <button className="operations-title" disabled={loading||!!error} onClick={()=>row.taskId?openTask(row.taskId):openJob(row.jobId)}>{row.title}<ArrowUpRight size={15}/></button>
        <div className="operations-times"><strong>{row.dateKind}：{when(row.at,timeZone)}</strong>{row.nextCheckAt&&row.dateKind!=='再次检查'&&<span>再次检查：{when(row.nextCheckAt,timeZone)}</span>}{row.scheduledAt&&<span>委托计划检查 / 推进：{when(row.scheduledAt,timeZone)}</span>}</div>
        <ul className="operations-reasons">{row.reasons.map((reason,index)=><li key={`${reason.code}:${index}`}>{reason.label}</li>)}</ul>
        <footer>{row.projectId?<button className="text-button" disabled={loading||!!error} onClick={()=>openProject(row.projectId)}>{row.projectName}</button>:<span>独立工作</span>}{row.jobId&&<button className="text-button" disabled={loading||!!error} onClick={()=>openJob(row.jobId)}>打开委托</button>}{row.reasons.some(r=>['decision','approval','uncertain'].includes(r.code))&&<button className="text-button" disabled={loading||!!error} onClick={openDecisions}>查看待我决策</button>}</footer>
      </article>)}
      {!loading&&!error&&!rows.length&&<div className="agent-empty"><CalendarDays size={30}/><h3>当前范围没有待处理安排</h3><p>调整时间或项目筛选，或在工作看板中添加事项。</p></div>}
    </div>
    {(result?.total>50||offset>0)&&<div className="operations-pagination"><button className="button" disabled={blocked||offset===0} onClick={()=>{setOffset(Math.max(0,offset-50));clear();}}>上一页</button><span>{result?.total?`${offset+1}–${Math.min(offset+50,result.total)} / ${result.total}`:'无结果'}</span><button className="button" disabled={blocked||!result?.more} onClick={()=>{setOffset(offset+50);clear();}}>下一页</button></div>}
  </div>;
}
