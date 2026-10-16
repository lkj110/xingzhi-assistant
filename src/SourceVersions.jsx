import {LazyDetails} from './RenderBounds';
import {metadataVersion} from './render-bounds.mjs';
import React,{useEffect,useState} from 'react';
import {ArrowRight,ArrowUpRight,RefreshCw,History} from 'lucide-react';
import './source-versions.css';
const stateName={todo:'待推进',running:'正在推进',waiting:'等待反馈',review:'待验收',blocked:'需关注',paused:'已暂停',completed:'已完成'};
const versionName=row=>row.version?`第 ${row.version} 版`:'未编号版本';
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'保存时间未知';
function flags(row){return [row.current?'当前':row.relation==='historical'?'历史':row.latest?'最新记录':'先后待核对',row.withdrawn?'已撤回':null,row.deleted?'已删除':null].filter(Boolean).join(' · ');}
function Pager({label,value,onChange}){if(!value||value.pageCount<=1)return null;return <div className="versions-pager" aria-label={label}><button className="button small" disabled={value.page<=1} onClick={()=>onChange(value.page-1)}>上一页</button><span>第 {value.page} / {value.pageCount} 页</span><button className="button small" disabled={value.page>=value.pageCount} onClick={()=>onChange(value.page+1)}>下一页</button></div>;}
export default function SourceVersions({data,sourceId,act,openTask}){
 const [selectedId,setSelectedId]=useState(sourceId),[compareId,setCompareId]=useState(null),[report,setReport]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0),[pages,setPages]=useState({historyPage:1,diffPage:1,taskPage:1,leftPage:1,rightPage:1});
 const version=metadataVersion(data);
 useEffect(()=>{setReport(null);setError('');setSelectedId(sourceId);setCompareId(null);setPages({historyPage:1,diffPage:1,taskPage:1,leftPage:1,rightPage:1});},[sourceId]);
 useEffect(()=>{let active=true;setError('');setLoading(true);act('sourceVersionsSnapshot',{id:sourceId,selectedId,...(compareId?{compareId}:{}),...pages}).then(result=>{if(!active)return;setLoading(false);setReport(result);if(!compareId)setCompareId(result.compareId);}).catch(e=>{if(active){setLoading(false);setError(e.message);setReport(null);}});return()=>{active=false;};},[sourceId,selectedId,compareId,version,pages,refresh]);
 function change(side,id){if(side==='left')setCompareId(id);else setSelectedId(id);setPages(value=>({...value,diffPage:1,taskPage:1,leftPage:1,rightPage:1}));}
 function paginate(key,page){setPages(value=>({...value,[key]:page}));}
 const options=report?[...new Map([...report.history.items,report.left,report.right].map(row=>[row.id,row])).values()]:[];
 return <section className="source-versions" aria-label="材料版本与影响"><header><div><h3><History size={18}/>版本与事项引用</h3><p>比较本机保存的原文，查看哪些事项明确引用所选版本。</p></div><button className="button small" aria-label="刷新材料版本" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={14}/>刷新</button></header>
  {error&&<p className="form-error" role="alert">{error}</p>}{!report&&!error&&<p className="muted">正在读取版本记录…</p>}
  {report&&<>
   {loading&&<p className="help-text" role="status">正在读取更新，下面仍是上次对比。</p>}
   {report.issues.map(issue=><p className="versions-warning" key={issue.code}>{issue.message}</p>)}
   {!report.chainValid&&<p className="help-text">以下按保存时间列出可确认的同来源记录；不将列表顺序当作版本先后。</p>}
   {report.newerAvailable&&<div className="versions-new"><span>已有更新版本。当前保留你选择的比较内容。</span><button className="button small" onClick={()=>{setSelectedId(report.latestId);setCompareId(report.latestPreviousId);setPages({historyPage:1,diffPage:1,taskPage:1,leftPage:1,rightPage:1});}}>对比最新两版</button></div>}
   <div className="versions-select"><label>基准版本<select aria-label="材料对比基准版本" value={report.compareId} onChange={event=>change('left',event.target.value)}>{options.map(row=><option value={row.id} key={row.id}>{versionName(row)} · {flags(row)} · {when(row.createdAt)}</option>)}</select></label><ArrowRight size={18}/><label>目标版本<select aria-label="材料对比目标版本" value={report.selectedId} onChange={event=>change('right',event.target.value)}>{options.map(row=><option value={row.id} key={row.id}>{versionName(row)} · {flags(row)} · {when(row.createdAt)}</option>)}</select></label></div>
   {report.direction==='backward'&&<p className="help-text">基准版本实际较新，以下按你选择的基准 → 目标方向展示。</p>}
   <LazyDetails className="versions-history" summary={<> 同来源版本记录（{report.history.total}）</>}>{()=><>{report.history.items.map(row=><div className="versions-history-row" key={row.id}><div><strong>{versionName(row)} · {flags(row)}</strong><small>{when(row.createdAt)} · {row.chars===null?'正文缺失':`${row.chars.toLocaleString()} 字符`}</small></div><div><button className="text-button" onClick={()=>change('left',row.id)}>设为基准</button><button className="text-button" onClick={()=>change('right',row.id)}>设为目标</button></div></div>)}<Pager label="材料版本历史分页" value={report.history} onChange={page=>paginate('historyPage',page)}/></>}</LazyDetails>
   <section className="versions-diff" aria-label="材料正文差异"><h4>正文差异</h4>
    {report.diff.identical===true&&<p className="versions-identical">两版正文完全相同（包括空白与换行）。</p>}
    {report.diff.counts&&<div className="versions-counts"><span className="add">新增 {report.diff.counts.added} 行</span><span className="remove">删除 {report.diff.counts.removed} 行</span><span>未变 {report.diff.counts.unchanged} 行</span></div>}
    {report.diff.mode==='diff'&&<><p className="help-text">逐行保留空格与换行类型；LF / CRLF / CR 表示换行，无换行表示最后一行未以换行结尾。</p><div className="versions-diff-table">{report.diff.items.map((row,index)=><div className={`versions-diff-row ${row.kind}`} key={`${report.diff.page}-${index}`}><span className="versions-line-numbers" aria-label={`原行 ${row.oldLine??'无'} 新行 ${row.newLine??'无'}`}>{row.oldLine??'·'}<br/>{row.newLine??'·'}</span><span className="versions-marker" aria-label={row.kind==='added'?'新增行':row.kind==='removed'?'删除行':'未变行'}>{row.kind==='added'?'+':row.kind==='removed'?'−':' '}</span><pre>{row.text===''?<span className="versions-empty">（空行）</span>:row.text}</pre><small>{row.ending==='none'?'无换行':row.ending}</small></div>)}</div>{!report.diff.items.length&&<p className="muted">两版都是空正文。</p>}<Pager label="材料差异分页" value={report.diff} onChange={page=>paginate('diffPage',page)}/></>}
    {report.diff.mode==='unavailable'&&<p className="versions-warning">{report.diff.reason}</p>}
    {report.diff.mode==='preview'&&<><p className="versions-warning">{report.diff.reason}可逐页查看，或通过材料详情的“下载第 N 版原文”按钮保存当前打开材料的完整文本。</p><div className="versions-previews">{[['left','基准原文','leftPage'],['right','目标原文','rightPage']].map(([side,label,key])=><section key={side} aria-label={label}><h5>{label}</h5><small>字符 {report.diff[side].start}–{report.diff[side].end} / {report.diff[side].totalChars}（按 UTF-16 单元计数）{report.diff[side].boundaryOverlap?' · 表情边界重叠展示':''}</small><pre>{report.diff[side].text||'（空正文）'}</pre><Pager label={`${label}分页`} value={report.diff[side]} onChange={page=>paginate(key,page)}/></section>)}</div></>}
   </section>
   <section className="versions-tasks" aria-label="引用所选版本的事项"><h4>引用所选版本的事项（{report.affectedTasks.total}）</h4><p className="help-text">{report.affectedTasks.notice}</p>{report.affectedTasks.items.map(task=><button className="versions-task" key={task.id} onClick={()=>openTask(task.id)}><div><strong>{task.title}</strong><small>{task.cancelled?'已取消':stateName[task.status]||'状态待核对'} · {task.references.map(ref=>`${ref.sides.map(side=>side==='left'?'基准版':'目标版').join('/')}：${ref.active?'当前引用':'历史引用，已被替换'}`).join('；')}</small>{task.needsReplan&&<small>待重新核对：{task.needsReplan}</small>}</div><ArrowUpRight size={14}/></button>)}{!report.affectedTasks.total&&<p className="muted">暂无事项明确引用所选两版材料。</p>}<Pager label="材料引用事项分页" value={report.affectedTasks} onChange={page=>paginate('taskPage',page)}/></section>
  </>}
 </section>;
}
