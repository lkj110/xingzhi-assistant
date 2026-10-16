import {workBusy} from './execution-state';
import React,{useState,useEffect} from 'react';
import {Check,Pause,ArrowUpRight,MessageSquare,ShieldCheck} from 'lucide-react';
import './decisions.css';
import QuestionAnswer from './QuestionAnswer';
import {SpendControls} from './SpendControls';
import {ResultFiles} from './ResultsPage';
import { actionTarget } from './write-target';
const labels={deadline:'截止风险',deadline_time:'截止时间待确认',source_classification:'来源用途待核对',permission:'需要授权',task_question:'需要补充',task:'事项待处理',question:'需要补充',timeout:'等待超时',approval:'待确认动作',uncertain:'结果待核对',needs_input:'需要补充',blocked:'执行异常',limited:'推进费用确认',review:'待验收'};
const when=t=>t?new Date(t).toLocaleString('zh-CN'):'未设置';
const localDate=t=>new Date(new Date(t).getTime()-new Date(t).getTimezoneOffset()*60000).toISOString().slice(0,16);
export default function DecisionsPage({data,act,perform,openJob,openTask,openResult,openReview,openRevision,filter='all', setFilter}){
  const [query,setQuery]=useState('');
  useEffect(()=>setQuery(''),[filter]);
  const cards=data.decisionCards||[],shown=cards.filter(d=>(filter==='all'||(filter.startsWith('group:')?d.category===filter.slice(6):d.kind===filter))&&`${d.question} ${d.jobTitle}`.includes(query));
  return <div className="decisions-page"><section className="decision-overview"><div><ShieldCheck size={23}/><h2>{cards.length?`${cards.length} 个节点需要你判断`:'目前没有待处理的决定'}</h2></div><p>查看依据和影响事项，处理后由助手继续。暂停中的委托会保留你的回答。</p></section>
    <div className="decision-toolbar"><input aria-label="搜索决定" placeholder="搜索问题或委托" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="筛选决定" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部决定</option><option value="group:progress">推进待介入</option><option value="group:review">待验收（全部事项）</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
    <div className="decision-grid">{shown.map(d=><Decision key={['question','task_question','needs_input','blocked','permission','timeout','source_classification'].includes(d.kind)?d.id:`${d.id}:${d.revision||d.action?.version||''}`} d={d} data={data} act={act} perform={perform} openJob={openJob} openTask={openTask} openResult={openResult} openReview={openReview} openRevision={openRevision}/>)}{!shown.length&&<p className="muted">当前筛选下没有待处理事项。</p>}</div>
    <section className="settings-card decision-history"><h2>已处理的决定</h2>{data.decisions.filter(d=>d.status!=='open').slice(0,20).map(d=><details key={d.id}><summary>{d.question} · {when(d.answeredAt)}</summary>{d.selectedOption&&<small>所选方案：{d.selectedOption.label}</small>}<p>{d.answer}</p><small>影响 {d.taskIds.length} 个事项 · {d.status==='resolved'?'依据新证据解决':'用户决定'}</small></details>)}</section>
  </div>;
}
function Decision({d,data,act,perform,openJob,openTask,openResult,openReview,openRevision}){
  const [answer,setAnswer]=useState(''),[content,setContent]=useState(d.action?.content||''),[messageId,setMessageId]=useState(d.action?.messageId||''),[error,setError]=useState(''),[working,setWorking]=useState(false),[source,setSource]=useState(null);
  const [deadline,setDeadline]=useState(localDate(Date.now()+86400000)),[draftRevision,setDraftRevision]=useState(d.revision);
  const busy=workBusy(data,{jobId:d.jobId,taskId:d.taskIds?.[0]})||working,r=d.action,j=data.delegations.find(j=>j.id===d.jobId),stale=['question','task_question','needs_input','blocked','permission','timeout','source_classification'].includes(d.kind)&&d.revision!==draftRevision;
  const formatFailure=d.kind==='blocked'&&(j?.lastErrorAutomaticRetry===true||!j?.lastErrorCode&&['MODEL_INVALID_RESPONSE','MODEL_CLI','MODEL_NETWORK','MODEL_TIMEOUT'].includes(data.modelCalls?.find(c=>c.jobId===d.jobId)?.errorCode));
  const reviewGroups=(data.resultOverview?.groups||[]).filter(g=>(d.kind==='review'&&g.jobId===d.jobId||d.kind==='task'&&g.taskId===d.taskId)&&data.tasks.some(t=>t.id===g.taskId&&t.status==='review'));
  const latestSources=stale?data.sources.filter(s=>j?.sourceIds.includes(s.id)&&!s.deleted&&!s.projectExcluded&&!data.sources.some(n=>j.sourceIds.includes(n.id)&&n.previousSourceId===s.id)).slice(0,8):[];
  async function run(action,input){setWorking(true);setError('');try{const next=await act(action,input);if(d.kind==='permission'){const current=next?.decisionCards?.find(c=>c.id===d.id);if(current)setDraftRevision(current.revision);}}catch(e){setError(e.message);}finally{setWorking(false);}}
  return <article className="decision-card"><header><span className={`decision-kind ${d.kind}`}>{labels[d.kind]}</span><span>{d.jobId||d.taskId?<button className="text-button" onClick={()=>d.taskId?openTask(d.taskId):openJob(d.jobId)}>{d.jobTitle}<ArrowUpRight size={13}/></button>:d.jobTitle}</span></header><h3>{reviewGroups.length?`请确认 ${reviewGroups.length} 项当前成果是否符合要求`:d.kind==='permission'?'你希望如何补齐访问权限或所需材料？':formatFailure?'模型调用未完成，可从已保存的进度继续':d.question}</h3>{reviewGroups.map(g=><section className="decision-result-summary" key={g.id}><div className="result-next"><strong>{g.title} · {g.statusLabel}</strong><p>{g.detail}</p></div><ResultFiles group={g} compact openResult={openResult}/><div className="decision-buttons"><button className="button primary" onClick={()=>openReview(g.taskId)}>查看验收要点</button><button className="button" onClick={()=>openRevision(g.taskId)}>提出修改意见</button></div></section>)}{d.paused&&<p className="decision-note">委托已暂停，处理后仍保持暂停。</p>}{d.newInformation&&<p className="decision-note">提问后收到新材料，请结合最新来源判断。</p>}{stale&&<section className="decision-note" aria-label="决定依据已更新"><p>问题或关联材料已更新，未提交的草稿已保留。核对当前内容后再提交。</p>{latestSources.length>0&&<details><summary>查看当前材料</summary>{latestSources.map(s=><button key={s.id} className="text-button" onClick={async()=>{try{setSource(await act('readSource',{id:s.id}));}catch{}}}>{s.title} · 第 {s.version||1} 版</button>)}</details>}<button type="button" className="button" disabled={busy} onClick={()=>{setDraftRevision(d.revision);setError('');}}>已核对最新依据，保留草稿</button></section>}
    {d.suggestion&&!['question','task_question','needs_input','blocked','permission'].includes(d.kind)&&<div className="decision-suggestion"><strong>助手建议</strong><p>{d.suggestion}</p>{d.kind==='question'&&<button className="text-button" onClick={()=>setAnswer(d.suggestion)}>采用建议填写</button>}</div>}
    {!!d.tasks?.length&&<div className="decision-related"><small>这次回答将用于</small>{d.tasks.map(t=><button key={t.id} className="text-button" onClick={()=>openTask(t.id)}>{t.title}</button>)}</div>}
    {!!d.sources?.length&&<details><summary>查看 {d.sources.length} 份依据</summary>{d.sources.map(s=><button className="text-button" key={s.id} onClick={async()=>{try{setSource(await act('readSource',{id:s.id}));}catch{}}}>{s.title}</button>)}</details>}{source&&<pre>{source.segments.map(s=>s.text).join('\n\n')}</pre>}
    {formatFailure&&<section><p>{d.context}</p><p>已有步骤和产出已保留。点击继续推进将重试未完成的工作，费用仍计入原事项；登录、配置或服务异常持续存在时，可在模型与设置中检查对应模型。</p><button className="button primary" disabled={busy||stale} onClick={()=>run('agentRun',{id:d.jobId})}>继续推进</button></section>}
    {!formatFailure&&['question','task_question','needs_input','blocked'].includes(d.kind)&&<QuestionAnswer question={d.question} context={d.context} options={d.options} busy={busy} stale={stale} submitLabel={d.paused?'保存决定':'保存决定并继续'} onSubmit={value=>run(d.kind==='task_question'?'decisionTaskAnswer':['needs_input','blocked'].includes(d.kind)?'decisionJobAnswer':'decisionAnswer',{id:d.id,revision:draftRevision,...value})}/>}
    {d.kind==='source_classification'&&<section aria-label="来源用途"><p>{d.context}</p><p className="decision-target">来源：{d.resourceKey}</p><p className="muted">作为新材料将按你的选择用于工作；仅观察和忽略不会重新开启已完成的事项。原有外部动作的待核对记录会继续保留。</p><div className="decision-buttons">{[['input','作为新材料'],['observation','仅保留观察'],['ignore','忽略这次观察']].map(([purpose,label])=><button key={purpose} className="button" disabled={busy||stale} onClick={()=>run('decisionSourceClassify',{id:d.id,revision:draftRevision,purpose})}>{label}</button>)}</div></section>}
    {d.kind==='deadline_time'&&<DeadlineActions key={d.taskId} taskId={d.taskId} data={data} busy={busy} run={run} openTask={openTask} dateOnly/>}
    {(d.deadlineRisks||[]).map(risk=><DeadlineActions key={risk.taskId} taskId={risk.taskId} risk={risk} data={data} busy={busy} run={run} openTask={openTask}/>)}
    {d.kind==='permission'&&<AccessRequest d={d} data={data} busy={busy} stale={stale} revision={draftRevision} run={run} openJob={openJob}/>}
    {d.kind==='timeout'&&<div className="form-stack"><label>新的等待期限<input type="datetime-local" aria-label="延长等待至" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label><button className="button" disabled={busy||stale||!deadline} onClick={()=>run('decisionTimeout',{id:d.id,revision:draftRevision,choice:'extend',deadlineAt:new Date(deadline).toISOString()})}>延长等待</button><label>调整计划说明<textarea aria-label="超时调整说明" rows={2} value={answer} onChange={e=>setAnswer(e.target.value)} placeholder="例如：先交付已确认部分，把未确认部分列为待补充"/></label><button className="button" disabled={busy||stale||!answer.trim()} onClick={()=>run('decisionTimeout',{id:d.id,revision:draftRevision,choice:'replan',note:answer})}>调整计划并继续</button></div>}
    {d.kind==='approval'&&<><p className="decision-target">目标：{data.connectors.find(c=>c.id===r.connectorId)?.name||actionTarget(r)}{r.tool==='lark_create'?' · 将导入下方已保存文稿；创建链接返回后核对正文，不更改分享权限':''}{r.tool==='request_confirmation'?' · 以当前飞书用户身份发送':''}</p>{r.tool==='lark_create'&&<small>创建账号：{r.larkUserName||r.larkOpenId}</small>}{r.tool==='write_file'&&r.latestName&&<small>同时保留历史版本：{r.target}</small>}{r.tool==='request_confirmation'&&<small>会话 ID：{r.target}</small>}{j?.lastError&&<p className="form-error">{j.lastError}</p>}{r.tool==='request_confirmation'?<><label>待发送正文<textarea aria-label="待发送正文" rows={4} maxLength={2000} value={content} onChange={e=>setContent(e.target.value)}/></label><button className="button" disabled={busy||content===r.content||!content.trim()} onClick={()=>run('communicationEdit',{actionId:r.id,version:r.version,content})}>保存消息修改</button><small>等待回复人：{r.respondentId} · 预期：{r.expected}</small></>:<pre>{r.content}</pre>}{r.baseline&&<details><summary>更新前的内容</summary><pre>{JSON.stringify(r.baseline,null,2)}</pre></details>}<div className="decision-buttons"><button className="button" disabled={busy||d.paused} onClick={()=>run('agentReject',{id:d.jobId,actionId:r.id})}>拒绝此动作</button><button className="button primary" disabled={busy||d.paused||(r.tool==='request_confirmation'&&content!==r.content)} onClick={()=>run('agentApprove',{id:d.jobId,actionId:r.id,version:r.version})}>{r.tool==='request_confirmation'?'批准此消息并继续':'批准此动作并继续'}</button></div></>}
    {d.kind==='uncertain'&&(d.orphan?<OrphanAction d={d} busy={busy} run={run}/>:<><p>目标：{actionTarget(r)}</p>{r.tool==='write_file'&&r.latestName&&<small>同时保留历史版本：{r.target}</small>}<pre>{r.content}</pre><p>{r.error||'上次执行中断，请先核对外部记录。'}</p>{r.tool==='lark_create'&&r.result?.url&&<><button className="button" disabled={busy} onClick={()=>run('agentOpenResult',{actionId:r.id})}>打开已创建的飞书文档</button><button className="button" disabled={busy||d.paused} onClick={()=>run('agentRun',{id:d.jobId})}>核对原文档并继续</button></>}{r.tool==='request_confirmation'&&<><label>已发送消息 ID<input aria-label="已发送消息 ID" placeholder="om_…" value={messageId} onChange={e=>setMessageId(e.target.value)}/></label><button className="button" disabled={busy||!messageId} onClick={()=>run('communicationCheck',{actionId:r.id,messageId})}>只读核对消息回执</button></>}<button className="button" disabled={busy} onClick={()=>{if(window.confirm('请先核对外部系统。确定此动作没有生效，允许重新准备？'))run('agentResolve',{id:d.jobId,actionId:r.id,confirmedNotApplied:true});}}>已核对未生效，允许重新准备</button></>)}
    {d.kind==='task'&&!reviewGroups.length&&<button className="button" onClick={()=>openTask(d.taskId)}>查看事项与处理结果</button>}
    {d.kind==='review'&&!reviewGroups.length&&j?.taskIds.map(id=>{const t=data.tasks.find(t=>t.id===id);return t?.status==='review'&&<button className="button" key={id} onClick={()=>openTask(id)}>查看并验收 · {t.title}</button>;})}
    {d.kind==='limited'&&<SpendControls data={data} scopeKey={'job:'+d.jobId} act={act}/>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!d.paused&&d.jobId&&<footer><button className="text-button" disabled={busy} onClick={()=>perform('agentPause',{id:d.jobId})}><Pause size={13}/>暂停此委托</button></footer>}
  </article>;
}
function OrphanAction({d,busy,run}){
  const [evidence,setEvidence]=useState(''),r=d.action,input={id:d.id,revision:d.revision};
  return <section className="form-stack" aria-label="历史动作核对">
    <p>关联工作已结束或不可用。这里仅保存原动作的核对结果，不创建工作或重新发送。</p>
    <p className="decision-target">原始目标：<code>{r.target}</code></p>
    <small>原动作：{r.id} · {r.tool}<br/>原委托：{d.originalJobId||'未记录'} · 原事项：{d.originalTaskId||'未记录'}</small>
    {r.latestName&&<p>原最新版本文件名：<code>{r.latestName}</code></p>}
    {(r.larkOpenId||r.principalScope)&&<pre>原账号：{r.larkOpenId||JSON.stringify(r.principalScope)}</pre>}
    <details><summary>查看原动作正文和回执</summary><pre>{r.content||'原正文不可用'}</pre><pre>{JSON.stringify({baseline:r.baseline,result:r.result,messageId:r.messageId,receiptMessageId:r.receiptMessageId,number:r.number},null,2)}</pre></details>
    <p>{r.error||'执行结果尚不确定，请核对原目标和回执。'}</p>
    {r.tool==='write_file'&&<button className="button" disabled={busy} onClick={()=>run('decisionActionReconcile',input)}>只读核对原文件</button>}
    <label>人工核对依据<textarea aria-label="历史动作核对依据" rows={3} maxLength={3000} value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="填写你在原目标核实的结果、记录编号或回执链接"/></label>
    <div className="decision-buttons"><button className="button" disabled={busy||!evidence.trim()} onClick={()=>{if(window.confirm(`确认已在原目标核实此动作生效？\n${r.target}\n本次只保存人工核对记录。`))run('decisionActionReconcile',{...input,confirmedApplied:true,evidence:evidence.trim()});}}>记录已生效的人工核对结果</button>
      <button className="button" disabled={busy} onClick={()=>{if(window.confirm(`确认原动作未生效？\n${r.target}\n仅关闭这条待核对记录，不重新发送。`))run('decisionActionResolve',{...input,confirmedNotApplied:true});}}>确认未生效并关闭记录</button></div>
  </section>;
}
function DeadlineActions({taskId,risk,data,busy,run,openTask,dateOnly=false}){
  const task=data.tasks.find(t=>t.id===taskId),policy=task?.deadlinePolicy||{};
  const [dueAt,setDueAt]=useState(policy.dueAt||task?.dueAt||''),[note,setNote]=useState('');
  const input={id:`deadline:${taskId}`,revision:risk?.eventId};
  const setTime=patch=>run('updateTask',{id:taskId,deadlinePolicy:patch,expectedDeadlineRevision:policy.deadlineRevision});
  if(!task)return null;
  return <section className="form-stack" aria-label="截止安排">
    <p>{dateOnly?`${policy.localDate} · ${policy.timeZone}，具体时间待确认`:risk?.acknowledged?'已知晓本阶段截止风险':`截止时间：${when(risk?.deadlineAt)}`}</p>
    <label>具体截止时间（含时区）<input aria-label="具体截止时间（含时区）" value={dueAt} onChange={e=>setDueAt(e.target.value)} placeholder="2026-10-20T18:00:00+08:00"/></label>
    <div className="decision-buttons"><button className="button" disabled={busy||!dueAt.trim()} onClick={()=>setTime({dueAt:dueAt.trim()})}>保存截止时间</button>{dateOnly&&<button className="button" disabled={busy} onClick={()=>setTime({keepDateOnly:true})}>保留仅日期</button>}<button className="text-button" onClick={()=>openTask(taskId)}>查看事项与范围</button></div>
    {risk&&<><div className="decision-buttons"><button className="button" disabled={busy} onClick={()=>run('attentionRead',input)}>标记已读</button><button className="button" disabled={busy||risk.acknowledged} onClick={()=>run('attentionAcknowledgeDeadline',{...input,riskKey:risk.riskKey})}>已知晓本阶段风险</button>{[[30,'30 分钟后提醒'],[120,'2 小时后提醒'],[1440,'24 小时后提醒']].map(([minutes,label])=><button key={minutes} className="button" disabled={busy} onClick={()=>run('attentionSnooze',{...input,minutes})}>{label}</button>)}</div>
      {risk.stage==='overdue'&&<><label>接下来如何安排<textarea aria-label="截止后安排" rows={2} value={note} onChange={e=>setNote(e.target.value)} placeholder="填写希望调整的范围或下一步"/></label><div className="decision-buttons"><button className="button" disabled={busy||!note.trim()} onClick={()=>run('taskAction',{id:taskId,command:'feedback',note:note.trim()})}>保存安排</button><button className="button" disabled={busy||task.status==='paused'} onClick={()=>run('taskAction',{id:taskId,command:'feedback',note:`截止后确认继续按当前范围推进：${task.criteria}`})}>确认当前范围并继续</button><button className="button" disabled={busy||task.status==='paused'} onClick={()=>run('taskAction',{id:taskId,command:'pause'})}>暂停此事项</button></div></>}
    </>}
  </section>;
}
function AccessRequest({d,data,busy,stale,revision,run,openJob}){
  const [createMode,setCreateMode]=useState(d.access?.createMode||'auto');
  const access=d.access||{},session=data.accessSessions?.find(s=>s.id===d.id),create=access.kind==='lark_create',lark=access.kind==='lark_document'||create,input={id:d.id,revision,...(create?{createMode}:{})};
  const choices=[
    {id:'authorize',label:create?'连接飞书以创建文档':lark?'连接飞书并读取':'补齐访问权限',recommended:true,description:create?'校验文档创建与读写权限，并按下方选择的创建方式推进。':lark?'按原要求读取这份文档；完成飞书授权后验证原文，再继续事项。':'按原计划获取所需权限，检查成功后继续；无法自行开通的权限需向管理员申请。'},
    {id:'provide_text',label:'我提供所需材料',description:'直接粘贴正文或已确认的信息，助手据此继续；不会因此获得外部访问权限。',requiresText:true},
    {id:'defer',label:'稍后处理',description:'保留事项和进度，继续等待；不反复调用模型尝试获取权限。'}
  ];
  async function choose(value){
    if(value.optionId==='defer')return run('accessCancel',{...input,note:value.answer});
    if(value.optionId==='authorize')return run(lark?session?'accessRetry':['login','scope'].includes(access.stage)?'accessStart':'accessRetry':'accessRetry',{...input,note:value.answer});
    return run('accessAlternative',{...input,mode:value.optionId,answer:value.answer});
  }
  return <section className="access-request"><p><strong>访问范围</strong>：{create?(access.target==='my_library'?'本人飞书云文档':`飞书文件夹 ${access.target?.replace(/^folder:/,'')}`):access.target}</p>{create&&<p className="muted">以你的飞书用户身份创建文档。默认保存在本人云文档；授权范围仅限此处关联事项和保存位置，可选择自动创建或逐次确认。</p>}{create&&<label>创建方式<select aria-label="授权后的飞书创建方式" value={createMode} disabled={busy||stale} onChange={e=>setCreateMode(e.target.value)}><option value="auto">按本次事项目标自动创建（推荐）</option><option value="ask">每次创建前确认具体文稿</option></select></label>}{lark&&!create&&<p className="muted">以你的飞书身份，只为此委托读取这份文档。飞书授权页授予应用的只读权限受账号可访问范围限制；正文将用于此事项的模型处理。不会授予文档写入权限。</p>}{lark&&<details><summary>查看申请的接口权限</summary><code>{create?'docx:document:create · docx:document:write_only · ':''}docx:document:readonly{access.target?.includes('/wiki/')?' · wiki:node:read':''}</code></details>}{access.message&&<p role="status" className="decision-note">{access.message}</p>}
    {session&&<p>授权链接有效至 {when(session.expiresAt)}。完成网页授权后会自动校验所需权限；等待期间不调用模型。</p>}
    {access.reason&&<p><strong>需要这项访问的原因</strong>：{access.reason}</p>}
    {!lark&&access.kind!=='web'&&<p className="decision-note">此工具没有接入可由 App 发起的授权页，因此这里没有授权链接。请先查看委托中使用的连接或仓库能力，在对应工具完成登录或由资源管理员开通权限；如果缺少读取工具，需要先接入能力。点击重新检查只会重试原工具，读取成功后才确认可用。</p>}
    <div className="decision-buttons">
      {lark&&session&&<button className="button primary" disabled={busy||stale} onClick={()=>run('accessOpenLink',{id:d.id})}>打开飞书授权页</button>}
      {lark&&!create&&<button className="button" disabled={busy||stale} onClick={()=>run('accessOpenLink',{id:d.id,kind:'document'})}>打开原文申请访问</button>}
      {lark&&!session&&<button className="button" disabled={busy||stale} onClick={()=>run('accessStart',input)}>{access.approvedAt?'重新获取飞书授权链接':'获取飞书授权链接'}</button>}
      {!lark&&<button className="button" onClick={()=>openJob(d.jobId)}>查看委托授权设置</button>}
    </div>
    <QuestionAnswer question={d.question} options={choices} context="优先补齐权限；也可以提供材料或调整方案。授权由你在对应平台确认。" busy={busy} stale={stale} onSubmit={choose} labelForOption={id=>id==='authorize'?lark?session?'已授权，检查并继续':['login','scope'].includes(access.stage)?'连接飞书并授权':access.approvedAt?'重新检查并继续':create?'连接并检查创建权限':'允许读取并检查':access.kind==='web'?'允许公开网页读取并继续':'已处理权限，重新检查':id==='defer'?'保存并等待':d.paused?'保存补充':'保存补充并继续'}/>
    <small>恢复会沿用原事项的进度与累计预算。{d.paused?'此委托已暂停，授权后仍保持暂停。':'其他待处理决定解决后才会继续推进。'}</small></section>;
}
export function SendPolicy({connection:c,data,act}){
  const [form,setForm]=useState({mode:'off',intervalMinutes:1440,maxSends:3,template:'',expiresAt:new Date(Date.now()+7*86400000).toISOString(),...c.sendPolicy});
  const [error,setError]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(false);
  const sent=data.agentActions.filter(r=>r.tool==='request_confirmation'&&r.projectId===c.projectId&&r.target===c.target&&['done','running','uncertain'].includes(r.status)).length;
  return <details className="send-policy"><summary><MessageSquare size={14}/>确认与催办授权 · {{off:'已关闭',ask:'逐次确认',auto:'固定文案自动发送'}[c.sendPolicy?.mode||'off']}</summary><p>以当前登录的飞书用户身份发送到此会话。自动模式仅发送你保存的固定文案；Agent 拟定的其他内容进入待我决策。</p><form className="form-stack" onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');setSaved(false);try{await act('communicationPolicy',{...form,connectorId:c.id});setSaved(true);}catch(e){setError(e.message);}finally{setSaving(false);}}}>
    <label>会话发送方式<select aria-label={`发送方式 ${c.name}`} value={form.mode} onChange={e=>setForm({...form,mode:e.target.value})}><option value="off">不允许发送</option><option value="ask">逐次预览并确认</option><option value="auto">允许固定文案自动发送</option></select></label>
    {form.mode!=='off'&&<><label>授权到期<input type="datetime-local" required aria-label={`授权到期 ${c.name}`} value={form.expiresAt?localDate(form.expiresAt):''} onChange={e=>setForm({...form,expiresAt:e.target.value?new Date(e.target.value).toISOString():''})}/></label><div className="form-row"><label>最小发送间隔<select aria-label={`发送间隔 ${c.name}`} value={form.intervalMinutes} onChange={e=>setForm({...form,intervalMinutes:Number(e.target.value)})}><option value="60">1 小时</option><option value="1440">24 小时</option><option value="4320">3 天</option></select></label><label>此项目会话累计上限<input aria-label={`发送上限 ${c.name}`} type="number" min="1" max="10" required value={form.maxSends} onChange={e=>setForm({...form,maxSends:Number(e.target.value)})}/></label></div>{form.mode==='auto'&&<label>允许自动发送的固定文案<textarea aria-label={`自动发送文案 ${c.name}`} required rows={4} maxLength={2000} value={form.template} onChange={e=>setForm({...form,template:e.target.value})} placeholder="例如：请确认本次发布的最终日期，谢谢。"/></label>}</>}
    <small>已发送或待核对 {sent} 次。修改授权不清零累计次数。发送权限与读取同步分别设置。</small><button className="button" disabled={saving||!!data.operation}>{form.mode==='off'?'关闭发送权限':'保存发送授权'}</button>{saved&&<p role="status">发送授权已保存</p>}{error&&<p className="form-error" role="alert">{error}</p>}
  </form></details>;
}
