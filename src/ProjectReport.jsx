import {LazyDetails,PagedList} from './RenderBounds';
import {metadataVersion} from './render-bounds.mjs';
import React,{useEffect,useState} from 'react';
import {ArrowUpRight,Download,RefreshCw,FileCheck2} from 'lucide-react';
import {desktop,download} from './api';
import './project-report.css';

const when = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未安排';
export default function ProjectReport({data,project,act,openTask,openJob,openSource}) {
  const [report,setReport] = useState(null),[includeBody,setIncludeBody] = useState(false),[error,setError] = useState(''),[refresh,setRefresh] = useState(0),[exporting,setExporting] = useState(false);
  const version=metadataVersion(data,{projectId:project.id});
  useEffect(() => {let active = true;setError('');setReport(null);act('projectReport',{projectId:project.id}).then(value => {if (active) setReport(value);}).catch(e => {if (active) setError(e.message);});return () => {active = false;};},[project.id,version,refresh]);
  useEffect(() => {setIncludeBody(false);},[project.id]);
  async function exportReport() {
    setExporting(true);setError('');
    try {
      const value = await act('projectReport',{projectId:project.id,includeArtifactContent:includeBody});
      const name = project.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,80) || '项目';
      download(`${name}-进展简报-${value.generatedAt.slice(0,10)}.md`,value.markdown,'text/markdown;charset=utf-8');
    } catch(e) {setError(e.message);} finally {setExporting(false);}
  }
  function viewBlocker(b) {if (b.taskId) openTask(b.taskId);else if (b.jobId) openJob(b.jobId);}
  return <section className="project-report" aria-label="项目进展简报"><header><div><h3><FileCheck2 size={18}/>项目进展与交付</h3><p>汇总已保存的进度和依据，不消耗模型调用。</p></div><button className="button small" aria-label="刷新项目简报" onClick={() => setRefresh(v => v+1)}><RefreshCw size={14}/>刷新</button></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!report && !error && <p className="muted">正在整理项目进展…</p>}
    {report && <><div className="project-report-facts"><div><small>已完成且当前检查有效</small><strong>{report.progress.completed} / {report.progress.total}</strong></div><div><small>待判断</small><strong>{report.totals.decisions}</strong></div><div><small>已到期事项 / 跟进</small><strong>{report.progress.overdueTasks} / {report.progress.overdueFollowups}</strong></div><div><small>当前产出 / 已核对交付</small><strong>{report.totals.artifacts} / {report.totals.deliveries}</strong></div></div>
      <p className="help-text">历史已验收：{report.progress.historicalAccepted} 项；当前检查待核对：{report.progress.unverified} 项。含人工执行证据的当前有效检查：{report.progress.manualEvidence} 项；人工确认完成：{report.progress.manualCompleted} 项，均不计入上方检查通过数，也不代表连接器读回核对。</p>
      <p className="project-report-dates">下次自动检查：{when(report.nextCheckAt)}<br/>{report.automatic.message}<br/>最近记录更新：{when(report.lastUpdatedAt)}</p>
      {(report.decisions.length > 0 || report.blockers.length > 0) && <LazyDetails className="project-report-section" defaultOpen summary={<> 需要处理（{report.totals.decisions + report.totals.blockers} 条记录）</>}>{()=><><PagedList items={report.decisions} label="项目决策分页">{d => <button className="project-report-row" key={d.id} onClick={() => openJob(d.jobId)}><div><strong>{d.question}</strong><small>{d.kind}{d.suggestion ? ` · ${d.suggestion}` : ''}</small></div><ArrowUpRight size={14}/></button>}</PagedList><PagedList items={report.blockers} label="项目阻塞记录分页">{b => <button className="project-report-row" key={`${b.kind}:${b.id}`} onClick={() => viewBlocker(b)}><div><strong>{b.title}</strong><small>{b.reason}</small></div><ArrowUpRight size={14}/></button>}</PagedList></>}</LazyDetails>}
      {report.followups.length > 0 && <LazyDetails className="project-report-section" summary={<> 持续跟进（{report.totals.followups}）</>}>{()=><><PagedList items={report.followups} label="持续跟进分页">{f => <button className="project-report-row" key={`${f.jobId}:${f.key}`} onClick={() => openJob(f.jobId)}><div><strong>{f.expected}</strong><small>{f.overdue ? '已超时' : '等待结果'} · 期限 {when(f.deadlineAt)}{f.paused ? ' · 委托已暂停' : ` · 下次检查 ${when(f.checkAt)}`}</small></div><ArrowUpRight size={14}/></button>}</PagedList></>}</LazyDetails>}
      <LazyDetails className="project-report-section" summary={<> 当前产出与交付（{report.totals.artifacts} / {report.totals.deliveries}）</>}>{()=><><PagedList items={report.artifacts} label="项目产出分页">{a => <button className="project-report-row" key={a.id} onClick={() => openTask(a.taskId)}><div><strong>{a.title}</strong><small>{a.completionLabel}{a.historicalAccepted ? ' · 保留历史验收记录' : ''} · {a.characters.toLocaleString()} 字符 · {a.ref}</small></div><ArrowUpRight size={14}/></button>}</PagedList><PagedList items={report.deliveries} label="项目交付分页">{d => <div className="project-report-row" key={d.id}><div><strong>{d.label} · {d.title}</strong><small>{d.filename || d.receiptId || d.artifactRef} · {when(d.at)}</small></div>{desktop && (d.url || d.filename) ? <button className="text-button" onClick={async () => {try {await act('agentOpenResult',{actionId:d.id});} catch(e) {setError(e.message);}}}>{d.filename ? '定位文件' : '查看记录'}<ArrowUpRight size={14}/></button> : d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-button">查看记录<ArrowUpRight size={14}/></a>}</div>}</PagedList>{!report.artifacts.length && !report.deliveries.length && <p className="muted">执行过程中产生的当前文稿和已核对交付会显示在这里。</p>}</>}</LazyDetails>
      <LazyDetails className="project-report-section" summary={<> 当前材料依据（{report.totals.sources}）</>}>{()=><><PagedList items={report.sources} label="项目依据分页">{s => <button className="project-report-row" key={s.id} onClick={() => {const source=data.sources.find(value => value.id === s.id && value.projectId === project.id);if (source) openSource(source);}}><div><strong>{s.title}</strong><small>{s.ref} · 第 {s.version} 版 · {when(s.at)}</small></div><ArrowUpRight size={14}/></button>}</PagedList>{!report.sources.length && <p className="muted">暂无当前项目材料。</p>}</>}</LazyDetails>
      <div className="project-report-export"><label className="check-label"><input type="checkbox" aria-label="附当前产出正文" checked={includeBody} onChange={e => setIncludeBody(e.target.checked)}/>附当前产出正文</label><button className="button" disabled={exporting} onClick={exportReport}><Download size={15}/>{exporting ? '正在生成…' : '下载项目简报'}</button></div>
      <p className="help-text">历史、撤回材料和历史产出不进入简报。已核对交付依据上次执行时的读回记录；下载不会重新访问外部服务。{report.progress.cancelled > 0 && ` 已取消 ${report.progress.cancelled} 项，不计入进度。`}</p>
      {report.truncated && <p className="project-report-notice">部分内容已截断：{report.notices.join('；')}。完整记录请在 App 中查看。</p>}
    </>}
  </section>;
}
