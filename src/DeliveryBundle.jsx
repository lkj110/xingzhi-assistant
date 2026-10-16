import {LazyDetails,PagedList} from './RenderBounds';
import {metadataVersion} from './render-bounds.mjs';
import React,{useEffect,useState} from 'react';
import {Archive,Download,RefreshCw,ArrowUpRight} from 'lucide-react';
import {download} from './api';
import './delivery-bundle.css';
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024*1024 ? `${(bytes/1024).toFixed(1)} KiB` : `${(bytes/1024/1024).toFixed(1)} MiB`;
export default function DeliveryBundle({data,project,act,openTask}) {
  const [report,setReport]=useState(null),[includeDrafts,setIncludeDrafts]=useState(false),[includeSources,setIncludeSources]=useState(false),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const version=metadataVersion(data,{projectId:project.id});
  useEffect(()=>{let active=true;setReport(null);setError('');act('deliveryBundleSnapshot',{projectId:project.id,includeDrafts,includeSources}).then(value=>{if(active)setReport(value);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[project.id,version,includeDrafts,includeSources,refresh]);
  useEffect(()=>{setIncludeDrafts(false);setIncludeSources(false);},[project.id]);
  async function exportBundle(){
    if(!report)return;
    setBusy(true);setError('');
    try{
      const result=await act('deliveryBundleExport',{projectId:project.id,includeDrafts,includeSources,revision:report.revision});
      const binary=atob(result.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      download(result.filename,bytes,result.mimeType);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const label=item=>item.status==='accepted'?(item.acceptanceMode==='user'?'有效 · 人工验收':'有效 · 自动验收'):item.status==='draft'?'未验收草稿':'暂不能导出';
  return <section className="delivery-bundle" aria-label="项目成果交付包"><header><div><h3><Archive size={18}/>项目成果交付包</h3><p>把当前成果、验收状态和文件清单整理为 ZIP。</p></div><button className="button small" aria-label="刷新项目交付包" disabled={busy} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={14}/>刷新</button></header>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="delivery-options"><label className="check-label"><input type="checkbox" aria-label="交付包包含未验收草稿" disabled={busy} checked={includeDrafts} onChange={event=>setIncludeDrafts(event.target.checked)}/>包含未验收草稿</label><label className="check-label"><input type="checkbox" aria-label="交付包附当前材料正文" disabled={busy} checked={includeSources} onChange={event=>setIncludeSources(event.target.checked)}/>附当前材料正文</label></div>
    {!report&&!error&&<p className="muted">正在核对当前成果…</p>}
    {report&&<><div className="delivery-counts"><span>有效验收 <strong>{report.counts.accepted}</strong></span><span>未验收草稿 <strong>{report.counts.drafts}</strong></span><span>不可导出 <strong>{report.counts.blocked}</strong></span></div>
      <LazyDetails className="delivery-files" summary={<> 查看成果清单（{report.items.length}）</>}>{()=><><PagedList items={report.items} label="成果清单分页">{item=><button className="delivery-file" key={item.id} onClick={()=>openTask(item.taskId)}><div><strong>{item.title}</strong><small>{label(item)} · {item.format.toUpperCase()} · {size(item.bytes)}{item.selected?' · 已选入包':''}</small>{item.reasons.length>0&&<small>{item.reasons.slice(0,3).join('；')}</small>}</div><ArrowUpRight size={14}/></button>}</PagedList>{!report.items.length&&<p className="muted">尚无当前步骤产出。</p>}</>}</LazyDetails>
      {includeSources&&<LazyDetails className="delivery-files" summary={<> 当前材料正文（{report.sources.length}）</>}>{()=><><PagedList items={report.sources} label="交付材料分页">{source=><div className="delivery-file" key={source.id}><div><strong>{source.title}</strong><small>第 {source.version} 版 · {size(source.bytes)}{source.problem?` · ${source.problem}`:' · 已选入包'}</small></div></div>}</PagedList></>}</LazyDetails>}
      {report.counts.excluded>0&&<p className="help-text">已排除 {report.counts.excluded} 条取消或关联异常的记录。</p>}
      {report.blockers.map((reason,index)=><p className="delivery-notice" key={index}>{reason}</p>)}
      <div className="delivery-export"><small>{report.counts.selected} 份正文 · {size(report.counts.bytes)}{report.archived?' · 已归档项目':''}</small><button className="button" disabled={busy||!report.canExport} onClick={exportBundle}><Download size={15}/>{busy?'正在生成交付包…':'下载成果 ZIP'}</button></div>
    </>}
    <p className="help-text">默认仅包含当前有效验收成果，草稿单独放入 drafts 目录。ZIP 正文保留原文，清单省略内部路径和授权信息。导出前确认正文可分享。</p><p className="help-text">文件来自本机已保存的正文，下载不会重新核对外部文件或平台。最多 200 份正文、合计 8 MiB。</p>
  </section>;
}
