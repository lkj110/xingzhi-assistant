import React, {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Archive, BookOpen, Copy, Pencil, Plus, RotateCcw, Search, X} from 'lucide-react';
import './playbooks.css';

const empty = {title:'', description:'', goalTemplate:'', taskRequirements:'',  maxActions:6, intervalMinutes:30, autoAccept:true};
const variableNames = value => [...new Set([...value.matchAll(/\{\{(主题|要求)\}\}/g)].map(m => m[1]))];

function Dialog({title, close, children}) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input,textarea,button')?.focus();
    const key = event => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab') return;
      const nodes = [...ref.current.querySelectorAll('button,input,textarea,select')].filter(node => !node.disabled);
      if (event.shiftKey && document.activeElement === nodes[0]) {event.preventDefault();nodes.at(-1)?.focus();}
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {event.preventDefault();nodes[0]?.focus();}
    };
    document.addEventListener('keydown', key);
    return () => {document.removeEventListener('keydown', key);previous?.focus();};
  }, []);
  return <div className="modal-backdrop"><section className="modal wide playbook-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭工作方案" onClick={close}><X size={19}/></button></header>{children}</section></div>;
}

export default function PlaybooksPage({data,act,perform,startJob,startRule,openJob}) {
  const [search,setSearch] = useState(''), [filter,setFilter] = useState('active'), [editing,setEditing] = useState(null), [using,setUsing] = useState(null);
  const [jobId,setJobId] = useState(''), [working,setWorking] = useState(false);
  const busy = working || !!data.operation;
  const rows = (data.playbooks || []).filter(p => (filter === 'all' || (filter === 'archived' ? p.archived : !p.archived)) && `${p.title} ${p.description} ${p.goalTemplate}`.toLowerCase().includes(search.toLowerCase()));
  async function action(name,input) {
    setWorking(true);
    try {return await act(name,input);} catch {return null;} finally {setWorking(false);}
  }
  async function extract() {
    const draft = await action('playbookFromJob',{jobId});
    if (draft) setEditing(draft);
  }
  return <div className="playbooks-page">
    <section className="agent-intro"><div><BookOpen size={28}/><div><h2>把有效的做法保存下来</h2><p>复用目标、处理方法和验收要求，替换主题后交给助手推进。</p></div></div><button className="button primary" disabled={busy} onClick={() => setEditing({...empty})}><Plus size={16}/>新建工作方案</button></section>
    <section className="playbook-extract"><div><h3>从已有委托提炼</h3><p>提取目标和事项完成标准，修改后保存为下一次工作的方案。</p></div><div><select aria-label="提炼方案的委托" value={jobId} onChange={e => setJobId(e.target.value)}><option value="">选择已有委托</option>{data.delegations.map(j => <option value={j.id} key={j.id}>{j.title}</option>)}</select><button className="button" disabled={busy || !jobId} onClick={extract}>提炼为方案</button>{jobId && <button className="text-button" onClick={() => openJob(jobId)}>查看委托<ArrowUpRight size={13}/></button>}</div></section>
    <div className="playbook-toolbar"><label className="search-field"><Search size={16}/><input aria-label="搜索工作方案" placeholder="搜索名称、目标或方法" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="工作方案筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">可用方案</option><option value="archived">已归档</option><option value="all">全部方案</option></select></div>
    <div className="playbook-grid">{rows.map(p => <article className="playbook-card" key={p.id} aria-label={`工作方案 ${p.title}`}><header><span className="playbook-kind">{p.builtin ? '内置方案' : p.archived ? '已归档' : '我的方案'}</span><small>第 {p.revision} 版</small></header><h3>{p.title}</h3><p>{p.description || p.goalTemplate}</p><details><summary>查看处理方法</summary><pre>{p.goalTemplate}{p.taskRequirements ? `\n\n${p.taskRequirements}` : ''}</pre></details><div className="playbook-parameters"><span>每次推进默认 $100 等值上限</span><span>每批 {p.maxActions} 个动作</span><span>每 {p.intervalMinutes} 分钟跟进</span></div><footer>{!p.builtin && !p.archived && <button className="button" disabled={busy} aria-label={`编辑方案 ${p.title}`} onClick={() => setEditing({...p})}><Pencil size={14}/>编辑</button>}<button className="button" disabled={busy} aria-label={`复制方案 ${p.title}`} onClick={() => action('playbookCopy',{id:p.id,revision:p.revision})}><Copy size={14}/>复制</button>{!p.builtin && <button className="icon-button" disabled={busy} aria-label={`${p.archived ? '恢复' : '归档'}方案 ${p.title}`} onClick={() => action('playbookArchive',{id:p.id,revision:p.revision,archived:!p.archived})}>{p.archived ? <RotateCcw size={16}/> : <Archive size={16}/>}</button>}{!p.archived && <button className="button primary" disabled={busy} aria-label={`使用方案 ${p.title}`} onClick={() => setUsing({...p})}>使用方案<ArrowUpRight size={14}/></button>}</footer></article>)}</div>
    {!rows.length && <div className="agent-empty"><BookOpen size={32}/><h3>暂无匹配的工作方案</h3><p>调整筛选条件，或从一次有效的委托开始保存做法。</p></div>}
    <p className="help-text playbook-note">方案可用于一次委托，也可按时间或资料变化自动运行。每次使用都选择资料范围和交付位置。</p>
    {editing && <Editor value={editing} act={act} close={() => setEditing(null)}/>}
    {using && <UsePlaybook value={using} act={act} startJob={draft => {setUsing(null);startJob(draft);}} startRule={draft => {setUsing(null);startRule(draft);}} close={() => setUsing(null)}/>}
  </div>;
}

function Editor({value,act,close}) {
  const [form,setForm] = useState({...empty,...value}), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const set = (key,value) => setForm(f => ({...f,[key]:value}));
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');
    try {await act('playbookSave',form,'工作方案已保存');close();} catch (e) {setError(e.message);} finally {setBusy(false);}
  }
  return <Dialog title={form.id ? '编辑工作方案' : '新建工作方案'} close={close}><form onSubmit={save}><div className="modal-body form-stack"><label>方案名称<input autoFocus required aria-label="方案名称" maxLength={100} value={form.title} onChange={e => set('title',e.target.value)}/></label><label>简短说明<input aria-label="方案说明" maxLength={500} value={form.description} onChange={e => set('description',e.target.value)}/></label><label>目标模板<textarea required aria-label="方案目标模板" rows={4} maxLength={7000} value={form.goalTemplate} onChange={e => set('goalTemplate',e.target.value)} placeholder="例如：结合授权资料，调研 {{主题}} 并给出建议。"/></label><label>处理方法与验收要求<textarea aria-label="方案处理方法" rows={5} maxLength={2000} value={form.taskRequirements} onChange={e => set('taskRequirements',e.target.value)} placeholder="例如：{{要求}}；区分事实与推断，列出来源，检查实际交付。"/></label><p className="help-text">支持 {'{{主题}}'} 和 {'{{要求}}'}。使用时会逐项填写并预览最终目标；也可保存没有变量的固定方案。</p><div className="form-row"><label>每批动作数<input required aria-label="方案动作上限" type="number" min={1} max={12} value={form.maxActions} onChange={e => set('maxActions',Number(e.target.value))}/></label><label>跟进间隔（分钟）<input required aria-label="方案跟进间隔" type="number" min={5} max={1440} value={form.intervalMinutes} onChange={e => set('intervalMinutes',Number(e.target.value))}/></label></div><label className="check-label"><input type="checkbox" checked={form.autoAccept} onChange={e => set('autoAccept',e.target.checked)}/>检查通过后自动验收事项</label><p className="help-text">保存后可反复使用。资料目录、项目、仓库与发送授权在每次委托时选择。</p>{error && <p role="alert" className="form-error">{error}</p>}</div><footer className="modal-footer"><button className="button primary" disabled={busy}>保存工作方案</button></footer></form></Dialog>;
}

function UsePlaybook({value,act,startJob,startRule,close}) {
  const names = variableNames(`${value.goalTemplate}\n${value.taskRequirements}`);
  const [values,setValues] = useState({}), [preview,setPreview] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function prepare(event) {
    event.preventDefault();setBusy(true);setError('');
    try {setPreview(await act('playbookPrepare',{id:value.id,revision:value.revision,values}));} catch (e) {setPreview(null);setError(e.message);} finally {setBusy(false);}
  }
  return <Dialog title={`使用方案：${value.title}`} close={close}><form onSubmit={prepare}><div className="modal-body form-stack">{names.map(name => <label key={name}>{name}<textarea disabled={busy} required rows={name === '主题' ? 2 : 3} maxLength={3000} aria-label={`方案变量${name}`} value={values[name] || ''} onChange={e => {setValues(v => ({...v,[name]:e.target.value}));setPreview(null);}} placeholder={name === '主题' ? '这次要推进的主题或目标' : '产出格式、时间范围、限制；没有可填写“按方案默认要求”'}/></label>)}{!names.length && <p>这是固定目标方案，预览后即可选择本次资料范围。</p>}<button type="submit" className="button" disabled={busy}>预览本次目标</button>{preview && <section className="playbook-preview" aria-label="工作方案预览"><h3>本次委托目标</h3><pre>{preview.goal}</pre><p>默认 $100 等值费用上限 · 每批 {preview.maxActions} 个动作 · 每 {preview.intervalMinutes} 分钟跟进</p></section>}<p className="help-text">预览与保存方案不调用模型。下一步选择资料范围、交付位置，以及是否自动重复运行。</p>{error && <p role="alert" className="form-error">{error}</p>}</div><footer className="modal-footer"><button type="button" className="button" disabled={!preview || busy} onClick={() => startRule({...preview,templateTitle:value.title,name:`${value.title}自动运行`.slice(0,100)})}>设置自动运行</button><button type="button" className="button primary" disabled={!preview || busy} onClick={() => startJob(preview)}>选择资料并委托<ArrowUpRight size={14}/></button></footer></form></Dialog>;
}
