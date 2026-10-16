import React, {useEffect, useState} from 'react';
import {Trash2, RotateCcw, Search} from 'lucide-react';
import './task-trash.css';

export function TaskDeleteDialog({task, data, act, Modal, onClose, onDeleted}) {
  const [preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;act('taskTrashPreview',{id:task.id}).then(value=>{if(active)setPreview(value);}).catch(e=>{if(active)setError(e.message);});return ()=>{active=false;};},[task.id,JSON.stringify(data.operations)]);
  async function remove(){setBusy(true);setError('');try{await act('taskTrashDelete',{id:task.id,revision:preview.revision},'事项已移入「已删除」');onDeleted();}catch(e){setError(e.message);setPreview(null);try{setPreview(await act('taskTrashPreview',{id:task.id}));}catch{}}finally{setBusy(false);}}
  return <Modal title="删除事项" subtitle="可以在工作台的「已删除」中恢复。" onClose={()=>{if(!busy)onClose();}}>
    <div className="modal-body form-stack"><h3>{task.title}</h3><p>删除后停止此事项的推进和提醒。已有材料、文档、执行记录和费用保留。</p>
      {!preview&&!error&&<p>正在检查关联工作…</p>}
      {preview?.jobs.length>0&&<div className="criteria-box"><div><strong>同时暂停关联 Agent 委托</strong><p>{preview.jobs.map(j=>j.title).join('、')}</p><p>此委托的其他事项也暂缓推进，核对剩余范围后可手动恢复委托。</p></div></div>}
      {preview?.dependents.length>0&&<p>以下事项依赖它，需要重新核对计划：{preview.dependents.map(t=>t.title).join('、')}。</p>}
      {preview?.pendingActions>0&&<p>{preview.pendingActions} 条尚未执行的动作确认将失效。</p>}
      {preview?.captures>0&&<p>{preview.captures} 条待处理的补充材料将暂停，已保存内容保留。</p>}
      {preview?.unresolved&&<p className="form-error">有外部动作仍在执行或结果未知。请先核对执行结果，再删除。</p>}
      {preview?.reason&&<p className="form-error">{preview.reason}</p>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div><div className="modal-footer"><button className="button" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy||!preview||!preview.allowed} onClick={remove}><Trash2 size={16}/>{busy?'正在删除…':'确认删除'}</button></div>
  </Modal>;
}

export default function TaskTrash({data, act, openTask, openResults}) {
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(null),[error,setError]=useState('');
  const tasks=(data.deletedTasks||[]).filter(t=>t.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function restore(task){setBusy(task.id);setError('');try{await act('taskTrashRestore',{id:task.id,revision:task.revision},'事项已恢复，保持暂停；核对后再继续');openTask(task.id);}catch(e){setError(e.message);}finally{setBusy(null);}}
  return <section className="task-trash" aria-label="已删除事项">
    <p className="help-text">恢复后，事项和关联 Agent 委托保持暂停。历史成果与费用仍然保留，确认后再继续推进。</p>
    <label className="search-field"><Search size={16}/><input aria-label="搜索已删除事项" placeholder="搜索已删除事项" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!tasks.length&&<div className="agent-empty"><Trash2 size={28}/><h3>{query?'没有匹配的已删除事项':'暂无已删除事项'}</h3><p>在事项详情中点击「删除事项」，即可移入这里。</p></div>}
    {tasks.map(task=><article className="trash-row" key={task.id}><div><h3>{task.title}</h3><p>{new Date(task.deletedAt).toLocaleString('zh-CN')} 删除 · {task.agentJobId?'Agent 事项':'独立事项'}{task.artifactCount>0?` · 保留 ${task.artifactCount} 份成果`:''}</p></div><div className="trash-actions">{task.artifactCount>0&&<button className="text-button" onClick={openResults}>查看历史成果</button>}<button className="button" disabled={!!busy||!task.allowed} title={task.reason||undefined} onClick={()=>restore(task)}><RotateCcw size={15}/>{busy===task.id?'正在恢复…':'恢复事项'}</button></div></article>)}
  </section>;
}
