import React,{useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,FolderInput,Pause,Play,Plus,RefreshCw,Trash2} from 'lucide-react';
import './intake-routing.css';

const blank=projectId=>({name:'',projectId,field:'all',match:'any',keywordsText:'',enabled:false});
const labels={title:'标题或文件名',content:'正文',all:'标题和正文'};
const when=value=>value?new Date(value).toLocaleString('zh-CN'):'—';
export default function IntakeRouting({data,act,onNavigate,openSource}){
  const [form,setForm]=useState(()=>blank(data.projects.find(p=>!p.archivedAt)?.id||'')),[sample,setSample]=useState({title:'',content:''}),[preview,setPreview]=useState(null),[result,setResult]=useState(null),[error,setError]=useState(''),[working,setWorking]=useState(false),[refresh,setRefresh]=useState(0),[choices,setChoices]=useState({}),[request,setRequest]=useState(null);
  const actRef=useRef(act),sequence=useRef(0),previewSequence=useRef(0),formRef=useRef(null),requestRef=useRef(null),submitting=useRef(false);actRef.current=act;
  useEffect(()=>{const id=++sequence.current;Promise.resolve().then(()=>actRef.current('intakeRoutingSnapshot')).then(value=>{if(sequence.current===id)setResult(value);}).catch(e=>{if(sequence.current===id)setError(e.message);});return()=>{sequence.current++;};},[refresh,data.events?.[0]?.id,!!data.operation]);
  const busy=working||!!data.operation;
  const ruleInput=()=>{const {keywordsText,...rest}=form;return {...rest,keywords:keywordsText.split('\n').map(value=>value.trim()).filter(Boolean)};};
  function invalidatePreview(){previewSequence.current++;setPreview(null);}
  function change(patch){setForm(value=>({...value,...patch}));invalidatePreview();}
  async function run(action,input,success){setWorking(true);setError('');try{const value=await actRef.current(action,input,success);setRefresh(v=>v+1);return value;}catch(e){setError(e.message);return null;}finally{setWorking(false);}}
  function remember(value){requestRef.current=value;setRequest(value);}
  function newDraft(){remember(null);setForm(blank(form.projectId));invalidatePreview();setError('');}
  async function save(event){
    event.preventDefault();if(submitting.current)return;submitting.current=true;setWorking(true);setError('');
    let envelope=requestRef.current;
    const retrying=!!envelope;
    try{
      if(!envelope){
        const input=ruleInput();
        if(input.id)envelope=input;
        else{const current=await actRef.current('intakeRoutingSnapshot');envelope={...input,requestId:crypto.randomUUID(),expectedRevision:current.stateRevision};}
        remember(envelope);
      }
      await actRef.current('intakeRoutingSave',envelope,'自动归类规则已保存');
      newDraft();setRefresh(v=>v+1);
    }catch(e){
      // A failed retry says nothing about whether the earlier attempt committed.
      if(!envelope||e.committed===false&&!retrying){remember(null);setError(e.message);}
      else{
        let found;
        try{
          const current=await actRef.current('intakeRoutingSnapshot');setResult(current);
          found=current.rules.find(r=>envelope.id?r.id===envelope.id:r.creationRequestId===envelope.requestId);
        }catch{}
        // Creation identity proves that request, but an edit's ID only proves
        // an older row exists. Unknown edits keep their draft and revision.
        const confirmed=found&&(!envelope.id||e.committed===true);
        if(confirmed){remember(null);setForm({...found,keywordsText:found.keywords.join('\n')});invalidatePreview();}
        setError(confirmed?`已保存，请核对当前规则。${e.message}`:e.committed===true?`已保存，暂未完成结果核对；请先核对保存结果。${e.message}`:retrying&&e.committed===false?`本次重试未提交，原请求结果仍待核对；已保留原草稿，请核对当前记录。${e.message}`:`保存结果尚未确认，已保留原草稿，请先核对当前记录。${e.message}`);
      }
    }finally{submitting.current=false;setWorking(false);}
  }
  async function check(){const id=++previewSequence.current;setWorking(true);setError('');setPreview(null);try{const value=await actRef.current('intakeRoutingPreview',{rule:ruleInput(),sample});if(previewSequence.current===id)setPreview(value);}catch(e){if(previewSequence.current===id)setError(e.message);}finally{setWorking(false);}}
  function edit(rule){remember(null);setForm({...rule,keywordsText:rule.keywords.join('\n')});invalidatePreview();setError('');formRef.current?.scrollIntoView({block:'start'});}
  const pending=result?.pending||[],rules=result?.rules||[];
  return <div className="routing-page">
    <section className="routing-intro"><div><FolderInput size={25}/><h2>材料自动找到所属项目</h2></div><p>设置一次关键词规则，后续手动输入、粘贴和导入的材料即可归入项目，由原 Agent 沿用已有事项继续处理。</p><div className="routing-facts"><span>{rules.filter(r=>r.enabled&&r.available).length} 条生效规则</span><span>{pending.length} 份待确认归属</span><span>归类与预览不调用模型</span></div></section>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <div className="routing-columns"><section className="settings-card routing-editor" ref={formRef}><header><div><h2>{form.id?'编辑归类规则':'添加归类规则'}</h2><p>按原文关键词匹配，忽略英文大小写和全角半角差异。</p></div></header>
      {!data.projects.length?<p>先在「项目」建立项目，再设置自动归类。{onNavigate&&<button className="button" onClick={()=>onNavigate({page:'projects'})}>前往项目</button>}</p>:<form onSubmit={save}>
        <fieldset disabled={busy||!!request} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <label>规则名称<input required maxLength={100} aria-label="归类规则名称" value={form.name} onChange={e=>change({name:e.target.value})} placeholder="例如：青禾会议材料"/></label>
        <label>归入项目<select required aria-label="归类目标项目" value={form.projectId} onChange={e=>change({projectId:e.target.value})}><option value="">选择项目</option>{data.projects.map(p=><option key={p.id} value={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select></label>
        <div className="routing-pair"><label>查找范围<select aria-label="归类匹配范围" value={form.field} onChange={e=>change({field:e.target.value})}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>匹配方式<select aria-label="归类匹配方式" value={form.match} onChange={e=>change({match:e.target.value})}><option value="any">任一关键词命中</option><option value="all">全部关键词命中</option></select></label></div>
        <label>关键词，每行一个<textarea required rows={3} maxLength={1000} aria-label="归类关键词" value={form.keywordsText} onChange={e=>change({keywordsText:e.target.value})} placeholder={'青禾\nQinghe'}/><small>最多 12 个，每个最多 80 字符。符号按字面匹配。</small></label>
        <label className="routing-check"><input type="checkbox" checked={form.enabled} onChange={e=>change({enabled:e.target.checked})}/>保存后启用自动归类</label>
        </fieldset>
        <div className="routing-buttons"><button className="button primary" disabled={busy}><Plus size={15}/>{request?'核对保存结果':form.id?'保存归类规则':'添加归类规则'}</button>{request&&<button type="button" className="button" disabled={working} onClick={()=>{if(window.confirm('旧请求可能已保存。放弃此草稿并开始另一条规则？'))newDraft();}}>放弃此草稿并新建</button>}{form.id&&<button type="button" className="button" disabled={working} onClick={newDraft}>取消编辑</button>}</div>
        <details className="routing-preview"><summary>用一份材料预览匹配结果</summary><p>预览会将当前表单视为启用，并与其他生效规则一起检查，不保存材料或改变归属。</p><label>预览标题<input maxLength={300} aria-label="归类预览标题" value={sample.title} onChange={e=>{setSample({...sample,title:e.target.value});invalidatePreview();}}/></label><label>预览正文<textarea rows={3} maxLength={500000} aria-label="归类预览正文" value={sample.content} onChange={e=>{setSample({...sample,content:e.target.value});invalidatePreview();}}/></label><button type="button" className="button" disabled={working} onClick={check}>预览自动归类</button>{preview&&<div className={`routing-preview-result ${preview.status}`} aria-live="polite"><strong>{preview.status==='routed'?`将归入「${data.projects.find(p=>p.id===preview.projectId)?.name||'项目'}」`:preview.status==='conflict'?'匹配到不同项目，将等待确认':'没有命中，将保存为独立材料'}</strong>{preview.matchedRules.map(rule=><p key={rule.id}>{rule.name} → {rule.projectName} · 命中：{rule.keywords.join('、')}</p>)}</div>}</details>
      </form>}
    </section>
    <section className="settings-card routing-rules"><header><div><h2>已保存的规则</h2><p>多条规则指向同一个项目时可直接归类。</p></div><button className="icon-button" aria-label="刷新归类记录" disabled={working} onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={17}/></button></header>
      {!rules.length&&<p className="muted">还没有规则。建议使用项目名、专有名词或固定文件名前缀。</p>}
      {rules.map(rule=><article className="routing-rule" key={rule.id}><div><h3>{rule.name}</h3><span className={rule.enabled&&rule.available?'routing-enabled':'routing-paused'}>{rule.enabled&&rule.available?'已启用':'已暂停'}</span></div><p>{labels[rule.field]} · {rule.match==='all'?'全部':'任一'}命中 <ArrowRight size={13}/> {rule.projectName}</p><div className="routing-keywords">{rule.keywords.map(keyword=><code key={keyword}>{keyword}</code>)}</div>{rule.disabledReason&&<p className="form-error">{rule.disabledReason}</p>}<div className="routing-buttons"><button className="button small" disabled={busy} onClick={()=>edit(rule)}>编辑归类规则</button><button className="button small" disabled={busy||(!rule.available&&!rule.enabled)} onClick={()=>run('intakeRoutingToggle',{id:rule.id,revision:rule.revision,enabled:!rule.enabled},rule.enabled?'归类规则已暂停':'归类规则已启用')}>{rule.enabled?<Pause size={13}/>:<Play size={13}/>} {rule.enabled?'暂停规则':'启用规则'}</button><button className="icon-button" aria-label={`移除归类规则 ${rule.name}`} disabled={busy} onClick={()=>{if(window.confirm(`移除「${rule.name}」归类规则？已归类材料保持原归属。`))run('intakeRoutingDelete',{id:rule.id,revision:rule.revision},'归类规则已移除');}}><Trash2 size={15}/></button></div></article>)}
    </section></div>
    <section className="settings-card routing-pending"><header><div><h2>待确认归属 <span>{pending.length}</span></h2><p>命中多个项目的材料先保留在此，确认后再整理或归并。</p></div></header>
      {!pending.length&&<p className="muted">当前没有归类冲突。</p>}
      {pending.map(source=><article className="routing-conflict" key={source.id}><div className="routing-conflict-title"><h3>{source.title}</h3>{openSource&&<button className="button small" onClick={()=>openSource(source.id)}>查看材料</button>}</div><p>{source.routing.matchedRules.map(rule=>`${rule.name} → ${rule.projectName}（${rule.keywords.join('、')}）`).join('；')}</p>{source.canResolve?<div className="routing-buttons"><select aria-label={`材料 ${source.title} 的归属项目`} value={choices[source.id]||''} onChange={e=>setChoices({...choices,[source.id]:e.target.value})}><option value="">选择归属项目</option>{data.projects.map(p=><option value={p.id} key={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select><button className="button primary small" disabled={busy||!choices[source.id]} onClick={()=>run('intakeRoutingResolve',{id:source.id,revision:source.revision,choice:'project',projectId:choices[source.id]},'材料已归入项目')}><Check size={14}/>确认归入项目</button><button className="button small" disabled={busy} onClick={()=>run('intakeRoutingResolve',{id:source.id,revision:source.revision,choice:'independent'},'材料已保留为独立材料')}>保持独立材料</button></div>:<p className="form-error">材料已有处理记录，请从原事项核对归属。</p>}</article>)}
    </section>
    {(result?.recent||[]).length>0&&<section className="settings-card routing-history"><h2>最近归类记录</h2>{result.recent.map(source=><article key={source.id}><div><strong>{source.title}</strong><span>{source.projectName}</span></div><p>{source.status==='routed'?'规则自动归类':source.status==='assigned'?'已确认项目归属':'已确认保持独立'} · {when(source.at)}</p><small>{source.matchedRules.map(rule=>`${rule.name}：${rule.keywords.join('、')}`).join('；')}</small></article>)}</section>}
    <section className="routing-help"><h3>生效范围</h3><ul><li>仅处理后续手动输入、粘贴和文件导入中未指定项目的材料。手动选择的项目、资料目录和信息连接沿用原归属。</li><li>收集队列使用实际导入时的生效规则。修改规则不会搬动已经保存的材料。</li><li>归类只改变资料归属。项目沿用原有 Agent 权限；暂停的项目保持暂停，没有委托的项目先保存资料。</li><li>恢复备份保留当前归类规则，并暂停自动归类。需要时可逐条重新启用。</li></ul></section>
  </div>;
}
