import React from 'react';
const statuses={todo:'待推进',running:'进行中',waiting:'跟进中',blocked:'需补充',review:'待验收',paused:'已暂停'};
export default function CaptureDestination({mode,onMode,taskId,onTask,tasks=[],suggestion,loading,error,disabled=false}){
 return <section className="capture-destination" aria-label="新建或补充事项"><div className="capture-destination-tabs" role="group" aria-label="信息用途">{[['auto','智能推荐'],['new','新建事项'],['task','补充已有事项']].map(([value,label])=><button type="button" disabled={disabled} key={value} className={mode===value?'active':''} aria-pressed={mode===value} onClick={()=>onMode(value)}>{label}</button>)}</div>
 {mode==='task'&&<label>补充到哪个事项<select disabled={disabled} aria-label="补充目标事项" value={taskId} onChange={e=>onTask(e.target.value)}><option value="">请选择推进中的事项</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title} · {statuses[t.status]||t.status}{t.projectName?` · ${t.projectName}`:''}</option>)}</select></label>}
 {loading&&<p role="status">正在本机识别内容并查找相关事项…</p>}{error&&<p role="status">{error}。可手动选择新建或补充。</p>}
 {suggestion&&<div className="capture-recommendation"><strong>{suggestion.reason}</strong>{suggestion.candidates.map(c=><button type="button" disabled={disabled} key={c.taskId} className={taskId===c.taskId?'selected':''} onClick={()=>{onMode('task');onTask(c.taskId);}}><span>{suggestion.taskId===c.taskId?'推荐补充 · ':''}{c.title}</span><small>{c.reasons.join('；')}</small></button>)}{mode==='auto'&&suggestion.recommendation==='task'&&<p>将补充到「{tasks.find(t=>t.id===suggestion.taskId)?.title}」。点击下方「补充并继续」确认。</p>}{mode==='auto'&&suggestion.recommendation==='choose'&&<p>请点选一个事项，或选择「新建事项」。</p>}<small>本机匹配来源、任务编号和关键词，不调用模型；不会自动合并材料。</small></div>}
 </section>;
}
