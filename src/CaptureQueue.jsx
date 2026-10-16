import React,{useState} from 'react';
import {Inbox,RefreshCw,X,FileText,FolderOpen,Clock3,CheckCircle2,AlertCircle} from 'lucide-react';
import './capture-queue.css';
const names={queued:'等待处理',processing:'处理中',completed:'已完成',failed:'需要处理',cancelled:'已取消'};
const time=value=>value?new Date(value).toLocaleString('zh-CN'):'—';
export default function CaptureQueue({data,act,openSource,openProject,openRouting,openJob}){
  const [filter,setFilter]=useState('active'),[error,setError]=useState(''),[pending,setPending]=useState('');
  const rows=data.captureQueue||[],active=rows.filter(row=>['queued','processing','failed'].includes(row.status));
  const selected=rows.filter(row=>filter==='all'||(filter==='active'?['queued','processing','failed'].includes(row.status):row.status===filter)).slice().reverse();
  const [limit,setLimit]=useState(30);
  async function run(action,row,extra={}){setError('');setPending(row.id);try{await act(action,{id:row.id,...extra});}catch(e){setError(e.message);}finally{setPending('');}}
  return <section className="capture-queue-page">
    <header className="capture-queue-intro"><div><Inbox size={23}/><h2>材料先收下，空闲后依次处理</h2></div><p>助手正在工作时也能提交文字和文件。每批保留收集回执；整理中断后只重试剩余材料，已创建的事项继续保留。</p><small>当前有 {active.length} 批待处理。队列遵守托管暂停、工作星期、运行时段和调用额度；App 退出后，下次启动仍可继续。自动重试默认关闭，可按每批材料开启。</small></header>
    <nav className="capture-queue-filters" aria-label="收集状态筛选">{[['active','待处理'],['all','全部记录'],['completed','已完成'],['cancelled','已取消']].map(([key,label])=><button key={key} className={`button ${key===filter?'active':''}`} onClick={()=>{setFilter(key);setLimit(30);}}>{label}<span>{key==='active'?active.length:key==='all'?rows.length:rows.filter(row=>row.status===key).length}</span></button>)}</nav>
    {data.stewardshipStatus?.automaticAllowed===false&&<p className="capture-queue-notice">{data.stewardshipStatus.message}。等待中的收集会继续保留。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="capture-queue-list">{selected.slice(0,limit).map(row=><article key={row.id} className={`capture-receipt ${row.status}`} aria-label={`收集记录：${row.itemTitles?.[0]||'材料'}`}>
      <header><span className="capture-state">{row.status==='completed'?<CheckCircle2 size={16}/>:row.status==='failed'?<AlertCircle size={16}/>:<Clock3 size={16}/>} {row.status==='failed'&&row.autoRetry?.enabled&&row.autoRetry?.nextRetryAt?'等待自动重试':names[row.status]||row.status}</span><time>{time(row.createdAt)}</time></header>
      <h3>{row.itemTitles?.[0]||'材料收集'}{row.itemTitles?.length>1&&<small>等 {row.itemTitles.length} 份材料</small>}</h3>
      {row.itemTitles?.length>1&&<p className="capture-titles">{row.itemTitles.join('、')}</p>}
      <p>{row.fileCount||0} 份文件 · {row.textCount||0} 段文字 · {row.advancement?'记录并推进':row.organize?(row.projectId?'归入项目后继续推进':'按归类结果推进或整理'):'只保存材料'} · 尝试 {row.attempts||0} 次</p>
      <div className="capture-project">{row.projectId&&data.projects.some(p=>p.id===row.projectId)?<button className="text-button" onClick={()=>openProject?.(row.projectId)}><FolderOpen size={14}/>{data.projects.find(p=>p.id===row.projectId).name}</button>:<span>{row.projectId?`${row.projectName||'原项目'}（项目已移除）`:'按导入时的归类规则处理'}</span>}</div>
      {row.importedAt&&<p className="capture-progress">已保存 {row.sourceIds?.length||0} 份新材料{!row.sourceIds?.length?'，重复内容已跳过':''}{row.organize&&!row.projectId?` · 已整理 ${row.sourceIds?.filter(id=>row.organizedSourceIds?.includes(id)||data.sources.find(s=>s.id===id)?.state==='processed').length||0} 份`:''}</p>}
      {!!row.sourceIds?.some(id=>data.sources.find(s=>s.id===id)?.routing?.status==='conflict')&&<p className="capture-queue-notice">材料已保存，归属冲突的内容尚未整理。<button className="text-button" onClick={openRouting}>处理材料归类</button></p>}
      {row.organize&&<div className="capture-retry-policy" aria-label="本批自动重试">{['queued','processing','failed'].includes(row.status)&&<label><input type="checkbox" aria-label="临时服务故障自动重试" checked={!!row.autoRetry?.enabled} disabled={pending===row.id||(!row.autoRetry?.enabled&&(row.autoRetry?.used||0)>=3)||!!row.cancelRequestedAt} onChange={e=>run('captureRetryPolicy',row,{enabled:e.target.checked,revision:row.autoRetry?.revision})}/>临时服务故障自动重试</label>}<p>本批自动重试已用 {row.autoRetry?.used||0}/3 次；间隔 1、5、15 分钟。每次模型尝试均计入额度。</p>{row.autoRetry?.enabled&&row.autoRetry?.nextRetryAt&&<p className="capture-retry-time">下次最早重试：{time(row.autoRetry.nextRetryAt)}。需同时满足全局托管与项目运行条件。</p>}{row.status==='failed'&&(row.autoRetry?.used||0)>=3&&<p className="capture-queue-notice">本批自动次数已用完，请检查后手动重试。</p>}{row.status==='failed'&&!row.autoRetry?.retryable&&<p className="capture-queue-notice">此次故障需要手动处理，不会自动重试。</p>}</div>}
      {row.target?.kind==='task'&&<p>补充事项：{data.tasks.find(t=>t.id===row.target.taskId)?.title||row.target.taskId}</p>}{row.provenance&&<p>来源：{[row.provenance.appName,row.provenance.windowTitle,row.provenance.note].filter(Boolean).join(' · ')||({selection:'选中文字',screenshot:'截图',manual:'手动输入',file:'文件导入'})[row.provenance.kind]} · {time(row.provenance.capturedAt||row.createdAt)}</p>}{row.advancement&&<p>{row.target?.kind==='task'?'Agent 核对新增材料，更新受影响的计划与成果，继续原事项。':row.advancement.infer?'Agent 自动提炼标题、背景、目标和执行步骤。':<>工作目标：{row.advancement.goal}<br/>预期结果：{row.advancement.criteria}</>}</p>}{row.advanceMessage&&<p className="capture-queue-notice">{row.advanceMessage}</p>}{row.jobId&&<button className="button small" onClick={()=>openJob?.(row.jobId)}>查看 Agent 推进</button>}{row.lastError&&<p className={row.status==='failed'?'form-error':'capture-queue-notice'}>{row.lastError}</p>}
      {!!row.sourceIds?.length&&<div className="capture-sources">{row.sourceIds.map(id=>{const source=data.sources.find(s=>s.id===id);return source&&<button key={id} className="text-button" onClick={()=>openSource?.(id)}><FileText size={13}/>{source.title}</button>;})}</div>}
      {['queued','processing','failed'].includes(row.status)&&<footer>{row.status==='failed'&&<button className="button small" disabled={pending===row.id} onClick={()=>run('captureRetry',row)}><RefreshCw size={14}/>重试剩余步骤</button>}<button className="button small" disabled={pending===row.id||!!row.cancelRequestedAt} onClick={()=>run('captureCancel',row)}><X size={14}/>{row.cancelRequestedAt?'正在取消…':'取消后续处理'}</button><small>已保存的材料和事项保留。</small></footer>}
    </article>)}</div>
    {!selected.length&&<div className="capture-queue-empty"><Inbox size={32}/><h3>{filter==='active'?'没有等待处理的收集':'暂无收集记录'}</h3><p>点击顶部“快速收集”。助手忙碌时，提交的材料会自动加入这里。</p></div>}
    {selected.length>limit&&<button className="button" onClick={()=>setLimit(n=>n+30)}>查看更多记录（剩余 {selected.length-limit} 批）</button>}
    <p className="help-text">仅明确的网络、超时或临时服务错误可自动重试。取消、服务拦截、额度不足、配置错误、坏文件与保存失败需人工处理。手动重试和开关都不重置本批 3 次自动额度；停止全部工作、归档和恢复备份会关闭自动重试。已整理的材料不重复整理。</p>
    <p className="help-text">单份文件不超过 10 MB，每批最多 10 份、合计 25 MB；未导入的暂存材料最多 50 批或 100 MB。暂存内容仅保存在本机，普通导出包含回执。</p>
  </section>;
}
