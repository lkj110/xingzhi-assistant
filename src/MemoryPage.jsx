import React,{useRef,useState} from 'react';
import {BookOpen,Check,Edit3,Pause,Play,Trash2} from 'lucide-react';
import './memory.css';

const kinds={preference:'工作偏好',fact:'确认事实',term:'项目术语'};
const empty=()=>({kind:'preference',title:'',content:'',projectId:null,sourceId:null,enabled:true,expiresAt:null});
const localDate=value=>value&&Number.isFinite(Date.parse(value))?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'长期有效';

export default function MemoryPage({data,act,openSource}){
  const [form,setForm]=useState(empty),[scope,setScope]=useState('all'),[query,setQuery]=useState(''),[decisionId,setDecisionId]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false),[preview,setPreview]=useState(null);
  const editor=useRef(null),memories=data.memories||[],projects=data.projects||[],busy=working||!!data.operation;
  const shown=memories.filter(m=>(scope==='all'||(scope==='global'?!m.projectId:m.projectId===scope))&&`${m.title} ${m.content}`.toLowerCase().includes(query.toLowerCase()));
  const usage=(data.memoryUsage||[]).find(u=>(u.projectId||null)===(scope==='all'||scope==='global'?null:scope));
  const sources=(data.sources||[]).filter(s=>(s.projectId||null)===(form.projectId||null));
  const answered=(data.decisions||[]).filter(d=>d.kind==='question'&&d.status==='answered');
  async function run(action,input,success){
    setError('');setNotice('');setWorking(true);
    try{const result=await act(action,input);if(success)setNotice(success);return result;}
    catch(e){setError(e.message);return null;}
    finally{setWorking(false);}
  }
  function edit(memory){setForm({...memory});setError('');setNotice('');editor.current?.scrollIntoView({block:'start',behavior:'smooth'});}
  async function viewSource(id){
    if(openSource){openSource(id);return;}
    const result=await run('readSource',{id});if(result)setPreview(result);
  }
  return <div className="memory-page">
    <section className="memory-intro"><div><BookOpen size={23}/><h2>把反复说明的事情记下来</h2></div><p>由你确认保存的偏好、事实和术语，会用于后续规划、执行与验收。项目记忆只用于对应项目；来源更新或条目过期后会停止使用。</p><small>最多保存 100 条，每条内容 2000 字符。记忆不改变任何工具或发送授权。</small></section>
    <div className="memory-layout">
      <section className="settings-card memory-editor" ref={editor}>
        <header><h2>{form.id?'编辑工作记忆':'新增工作记忆'}</h2>{form.id&&<button type="button" className="text-button" onClick={()=>edit(empty())}>取消编辑</button>}</header>
        <form onSubmit={async e=>{e.preventDefault();const result=await run('memorySave',form,'记忆已保存，相关未完成委托会重新核对计划。');if(result)setForm(empty());}}>
          <div className="memory-form-row"><label>类型<select aria-label="记忆类型" value={form.kind} onChange={e=>setForm({...form,kind:e.target.value})}>{Object.entries(kinds).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label>作用范围<select aria-label="记忆作用范围" value={form.projectId||''} onChange={e=>setForm({...form,projectId:e.target.value||null,sourceId:null})}><option value="">所有工作</option>{projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label></div>
          <label>标题<input required maxLength={120} aria-label="记忆标题" placeholder="例如：交付文档的写作偏好" value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
          <label>确认的内容<textarea required rows={5} maxLength={2000} aria-label="记忆内容" placeholder="写清楚适用条件和具体要求。例如：项目周报先列风险与待决策项，再写已完成进展。" value={form.content} onChange={e=>setForm({...form,content:e.target.value})}/><small>{form.content.length} / 2000 字符</small></label>
          <label>引用来源（可选）<select aria-label="记忆引用来源" value={form.sourceId||''} onChange={e=>setForm({...form,sourceId:e.target.value||null})}><option value="">用户直接确认，无材料引用</option>{form.sourceId&&!sources.some(s=>s.id===form.sourceId)&&<option value={form.sourceId}>原来源已不可用，请重新选择</option>}{sources.map(s=><option key={s.id} value={s.id}>{s.title} · v{s.version||1}{s.deleted?' · 已撤回':s.projectExcluded?' · 已撤销':''}</option>)}</select><small>来源有新版本时，先检查最新内容，再选择新来源并保存。</small></label>
          <label>到期时间（可选）<input type="datetime-local" aria-label="记忆到期时间" value={localDate(form.expiresAt)} onChange={e=>setForm({...form,expiresAt:e.target.value?new Date(e.target.value).toISOString():null})}/></label>
          <label className="memory-checkbox"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>保存后启用</label>
          <button className="button primary" disabled={busy}><Check size={14}/>确认并保存记忆</button>
        </form>
        {answered.length>0&&<details className="memory-from-decision"><summary>从已回答的问题整理</summary><p>选取一次决定形成草稿，核对作用范围和内容后，再点击上方保存。</p><select aria-label="选择已回答的决定" value={decisionId} onChange={e=>setDecisionId(e.target.value)}><option value="">选择问题</option>{answered.map(d=><option key={d.id} value={d.id}>{d.question}</option>)}</select><button type="button" className="button" disabled={busy||!decisionId} onClick={async()=>{const result=await run('memoryDraftDecision',{id:decisionId});if(result){setForm(result.draft);setNotice(result.warning||'草稿已填写，核对后点击「确认并保存记忆」。');}}}>填写为草稿</button></details>}
        {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="memory-notice" role="status">{notice}</p>}
      </section>
      <section className="memory-list">
        <div className="memory-toolbar"><input aria-label="搜索工作记忆" placeholder="搜索偏好、事实或术语" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="筛选记忆范围" value={scope} onChange={e=>setScope(e.target.value)}><option value="all">全部记忆</option><option value="global">所有工作通用</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="memory-count"><span>已保存 {memories.length} / 100 条 · 当前显示 {shown.length} 条</span><small>{scope==='all'||scope==='global'?'通用上下文':projects.find(p=>p.id===scope)?.name}采用 {usage?.included||0} 条{scope!=='all'&&scope!=='global'?'（含通用记忆）':''}</small></div>
        {usage?.warning&&<p className="memory-warning" role="status">{usage.warning}</p>}
        {!shown.length&&<div className="memory-empty"><BookOpen size={28}/><h3>{memories.length?'没有匹配的记忆':'从一条经常说明的偏好开始'}</h3><p>例如：回复使用中文；每次调研都附原始来源；项目中的特定术语定义。</p></div>}
        {shown.map(m=><article className={`memory-item${m.effective?'':' memory-inactive'}`} key={m.id}><header><span className="memory-kind">{kinds[m.kind]||'待核对记忆'}</span><span className="memory-status">{m.reason||'待检查'}</span></header><h3>{m.title}</h3><p className="memory-content">{m.content}</p><div className="memory-meta"><span>{m.projectId?projects.find(p=>p.id===m.projectId)?.name||'项目已不存在':'所有工作'}</span><span>v{m.version} · {m.expiresAt?`到期 ${when(m.expiresAt)}`:'长期有效'}</span></div>{m.sourceId&&<button className="text-button memory-source" onClick={()=>viewSource(m.sourceId)}>来源：{m.sourceTitle||'已删除的来源'}</button>}<footer><button className="button small" disabled={busy} onClick={()=>edit(m)}><Edit3 size={13}/>编辑</button><button className="button small" disabled={busy} onClick={()=>run('memoryToggle',{id:m.id,version:m.version,enabled:!m.enabled},m.enabled?'记忆已停用。':'记忆已启用。')}>{m.enabled?<Pause size={13}/>:<Play size={13}/>} {m.enabled?'停用':'启用'}</button><button className="icon-button" aria-label={`删除记忆 ${m.title}`} disabled={busy} onClick={()=>{if(window.confirm(`删除「${m.title}」？后续工作将不再使用这条记忆。`))run('memoryDelete',{id:m.id,version:m.version},'记忆已删除。');}}><Trash2 size={14}/></button></footer></article>)}
        {preview&&<section className="settings-card memory-preview"><header><h3>{preview.title}</h3><button className="text-button" onClick={()=>setPreview(null)}>收起来源</button></header><pre>{(preview.segments||[]).map(s=>s.text).join('\n\n')||preview.content}</pre></section>}
      </section>
    </div>
  </div>;
}
