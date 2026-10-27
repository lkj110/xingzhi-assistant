import {workBusy} from './execution-state';
import {WorkspaceNavigation,SectionNavigation,sectionForPage} from './WorkspaceNavigation';
import Markdown from './Markdown';
import TaskIntakeDialog from './TaskIntakeDialog';
import TaskTrash, {TaskDeleteDialog} from './TaskTrash';
import HelpPage, {QuickStartDialog} from './HelpPage';
import {SpendControls} from './SpendControls';
import ProviderEditor, {protocolLabel} from './ProviderForm';
import {GenerationControls,RecentModelCalls} from './GenerationControls';
import ScreenshotInput,{ScreenshotPreview,pasteImages,serializeCaptureFiles} from './ScreenshotInput';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen, Check, CheckCheck, ChevronRight, Circle, CircleCheck, Clock3, FileText, FolderOpen, Inbox, LayoutDashboard, List, LoaderCircle, MoreHorizontal, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, Upload, WandSparkles, X, Zap, Bot, PanelLeft, RefreshCw, AlertCircle, Link2, SlidersHorizontal, Pencil, CalendarDays } from 'lucide-react';
import { call, desktop, download } from './api';
import AgentPage from './AgentPage';
import RulesPage from './RulesPage';
import ProjectsPage from './ProjectsPage';
import CapabilitiesPage from './CapabilitiesPage';
import ConnectionsPage from './ConnectionsPage';
import RuntimePage from './RuntimePage';
import DecisionsPage from './DecisionsPage';
import LibraryPage from './LibraryPage';
import ResultsPage,{ResultFiles,DeliveryCard} from './ResultsPage';
import PlaybooksPage from './PlaybooksPage';
import MemoryPage from './MemoryPage';
import GroundingPanel from './GroundingPanel';
import OperationsPage from './OperationsPage';
import CaptureQueue from './CaptureQueue';
import HealthPage from './HealthPage';
import AcceptancePage from './AcceptancePage';
import BriefingPage from './BriefingPage';
import IntakeRouting from './IntakeRouting';
import AttentionPage from './AttentionPage';
import WorkMapPage from './WorkMapPage';
import SourceVersions from './SourceVersions';
import SourceProvenance from './SourceProvenance';
import ModelFallback from './ModelFallback';
import ModelRouting, {TaskModelPreference} from './ModelRouting';
import QuickCaptureWindow, {QuickCaptureSettings} from './QuickCaptureWindow';
import './connected.css';
import {version as appVersion} from '../package.json';
import {createWorkspaceSync} from './workspace-sync.mjs';

const labels = { todo: '待推进', running: '正在推进', waiting: '等待反馈', review: '待验收', completed: '已完成', blocked: '需要关注', paused: '已暂停' };
const kinds = { analysis: '分析整理', draft: '生成文稿', external: '外部执行' };
const roles = { organize: '信息整理', execute: '事项推进', verify: '结果检查' };
const formatDate = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '未设置';
const dateInput = value => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const cx = (...items) => items.filter(Boolean).join(' ');


function Modal({ title, subtitle, children, onClose, wide = false }) {
  const ref = useRef(), closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input, textarea, button, select')?.focus();
    function key(event) {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const nodes = [...ref.current.querySelectorAll('button, input, textarea, select, a[href]')].filter(el => !el.disabled);
        if (!nodes.length) return;
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
      }
    }
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={ref} className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20}/></button></header>{children}</section></div>;
}

function Empty({ icon: Icon = Inbox, title, description, children }) {
  return <div className="empty"><div className="empty-icon"><Icon size={25} strokeWidth={1.6}/></div><h3>{title}</h3><p>{description}</p>{children}</div>;
}
function PageSlice({items,size=40,label,children}){
  const [page,setPage]=useState(0),last=Math.max(0,Math.ceil(items.length/size)-1),current=Math.min(page,last);
  return <>{children(items.slice(current*size,(current+1)*size))}{last>0&&<nav className="library-pagination" aria-label={label+'分页'}><button className="button" disabled={current===0} onClick={()=>setPage(current-1)}>上一页</button><span>{current+1} / {last+1} · 共 {items.length} 条</span><button className="button" disabled={current===last} onClick={()=>setPage(current+1)}>下一页</button></nav>}</>;
}
function ArtifactDocument({artifact:initial,data,onClose,onOpenCurrent}) {
  const metadata=data.artifacts.find(row=>row.id===initial.id);
  const [loaded,setLoaded]=useState(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;setLoaded(null);setError('');if(!metadata||metadata.accessPolicyQuarantined){setError('成果已移除或正文权限已撤回');return;}
    call('viewDetail',{kind:'artifact',id:metadata.id}).then(row=>{if(active)setLoaded(row);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};
  },[metadata?.id,metadata?.bodyRevision,metadata?.accessPolicyQuarantined]);
  if(!loaded||!metadata||metadata.accessPolicyQuarantined)return <Modal wide title={initial.title} onClose={onClose}><div className="modal-body"><p role={error?'alert':'status'}>{error||'正在读取完整成果…'}</p></div></Modal>;
  return <ArtifactBody artifact={loaded} data={data} onClose={onClose} onOpenCurrent={onOpenCurrent}/>;
}
function ArtifactBody({artifact,data,onClose,onOpenCurrent}) {
  const group=data.resultOverview?.groups.find(g=>g.current.some(a=>a.id===artifact.id)||g.history.some(a=>a.id===artifact.id));
  const current=group?.current.some(a=>a.id===artifact.id);
  const localDraft=current&&group?.delivery&&group.primaryId===artifact.id;
  const delivered=data.agentActions.findLast(r=>r.artifactId===artifact.id&&r.status==='done'&&r.tool==='write_file');
  const format=delivered?.fileFormat||delivered?.result?.format||'md';
  const label={md:'Markdown',txt:'TXT',csv:'CSV',json:'JSON'}[format]||'Markdown';
  const name=delivered?.latestName||`${artifact.title.replace(/[\\/:*?"<>|]/g,'-')}.${format}`;
  const mime={md:'text/markdown',txt:'text/plain',csv:'text/csv',json:'application/json'}[format]||'text/plain';
  return <Modal wide title={artifact.title} subtitle={`工作产出 · ${formatDate(artifact.createdAt)}`} onClose={onClose}><div className="modal-body">{localDraft&&<DeliveryCard group={group}/>}<div className={cx("result-version-banner",!current&&"historical")}><strong>{localDraft?`本地底稿 · ${group.statusLabel}`:current?`当前成果 · ${group.statusLabel}`:"历史版本 / 过程稿"}</strong><p>{localDraft?"下方为保存的本地底稿，最终交付入口与状态见上方。":current?group.next:"此文稿未关联当前已完成步骤，本次验收请查看当前成果。"}</p>{!current&&group?.current.map(a=><button key={a.id} className="button small" onClick={()=>onOpenCurrent(a.id)}>查看当前成果 · {a.title}</button>)}</div>{format==='md'?<Markdown text={artifact.content}/>:<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{artifact.content}</pre>}</div><div className="modal-footer"><span>请结合原始材料判断产出是否适用</span><button className="button" onClick={()=>download(name,artifact.content,mime)}><ArrowDownToLine size={16}/>导出 {label}</button></div></Modal>;
}
function Status({ status }) { return <span className={`status status-${status}`}><i/>{labels[status]}</span>; }
function Toggle({ checked, onChange, label }) { return <button className={cx('toggle', checked && 'on')} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span/></button>; }

export default function App() {
  return window.assistant?.quickCaptureWindow?<QuickCaptureWindow/>:<WorkspaceApp/>;
}
function WorkspaceApp() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState('board');
  const [decisionFilter,setDecisionFilter]=useState('all');
  const [selectedJob,setSelectedJob]=useState(null);
  const [acceptanceTaskId,setAcceptanceTaskId]=useState(null);
  const [revisionTaskId,setRevisionTaskId]=useState(null);
  const [newProject,setNewProject]=useState(null);
  const [jobDraft,setJobDraft]=useState(null);
  const [ruleDraft,setRuleDraft]=useState(null);
  const [selectedProject,setSelectedProject]=useState(null);
  const [showTools,setShowTools]=useState(false);
  const [view, setView] = useState('board');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(null);
  const [pendingIntake, setPendingIntake] = useState(null);
  const [toast, setToast] = useState(null);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(0);
  const [guideReplay, setGuideReplay] = useState(false);
  const [guideDismissed, setGuideDismissed] = useState(false);
  const guideOpen = !!data && (guideReplay || (!guideDismissed && (!data.runtime?.onboarding?.seenAt || (window.assistant?.quickCaptureSupported && data.runtime?.onboarding?.version < 2))));
  const timer = useRef(null);
  const notify = (message, error = false) => { setToast({ message, error }); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(null), 6000); };
  const sync=useRef(null),refreshFailure=useRef(null);
  if(!sync.current)sync.current=createWorkspaceSync({fetchState:revision=>call('stateView',{revision}),onState:setData,onError:message=>{refreshFailure.current=message;setFailure(message);}});
  const refresh = (force=false) => sync.current.refresh(force===true);
  useEffect(() => { refresh(); const visible=()=>{if(!document.hidden)refresh();}; const poll=setInterval(visible,1800);window.addEventListener('focus',visible); document.addEventListener('visibilitychange',visible); return () => { clearInterval(poll); clearTimeout(timer.current); window.removeEventListener('focus',visible); document.removeEventListener('visibilitychange',visible); }; }, []);
  useEffect(()=>{
    if(!pendingIntake)return;
    if(page!=='board'){setPendingIntake(null);return;}
    const receipt=data?.captureQueue?.find(row=>row.id===pendingIntake);
    if(receipt?.taskId){if(!modal)setSelected(receipt.taskId);setPendingIntake(null);}
  },[pendingIntake,data,page,modal]);
  useEffect(()=>window.assistant?.onNavigate?.(target=>{if(!window.assistant.navigationRoutes?.includes(target))return;if(target==='guide'){setGuideReplay(true);setModal(null);setSelected(null);}else if(target.startsWith('decisions:')){setDecisionFilter('group:'+target.split(':')[1]);setPage('decisions');setModal(null);setSelected(null);}else{if(target==='decisions')setDecisionFilter('all');setPage(target);setModal(null);setSelected(null);}}),[]);
  useEffect(()=>window.assistant?.onEngineStatus?.(status=>{if(status?.available===false)setFailure(status.message||'后台执行已停止，请重新启动应用');}),[]);
  useEffect(()=>{
    const collect=event=>{if(data&&!modal&&!selected&&!guideOpen&&!event.repeat&&!event.altKey&&(event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='i'){event.preventDefault();if(window.assistant?.quickCaptureSupported)call('quickCaptureOpen').catch(e=>notify(e.message,true));else setModal({type:'source'});}};
    document.addEventListener('keydown',collect);return()=>document.removeEventListener('keydown',collect);
  },[!!data,!!modal,selected,guideOpen]);
  async function act(action, input = {}, message) {
    const reading=/(?:Snapshot|Preview|Search|Status|List|Read)$/i.test(action)||['readSource','projectReport','viewDetail'].includes(action);
    if(!reading)setPending(n => n + 1);
    const trackedWrite=['settings','saveProvider','deleteProvider','updateTask','taskAction','intakeRoutingSave','intakeRoutingToggle','intakeRoutingDelete','memorySave','memoryToggle','memoryDelete'].includes(action);
    let writeSucceeded=false,refreshAttempted=false;
    try {
      const result=await call(action,input);writeSucceeded=trackedWrite&&!reading;
      if(result?.settings&&Array.isArray(result.tasks)&&Array.isArray(result.sources)&&Array.isArray(result.providers)&&Array.isArray(result.delegations)||action==='acceptanceAccept'){
        refreshAttempted=true;await refresh(true);
        if(refreshFailure.current)throw Object.assign(Error('界面刷新未完成：'+refreshFailure.current),{code:'STATE_REFRESH_FAILED'});
      }
      if(message)notify(message);return result;
    } catch(error) {
      if(writeSucceeded)error.committed=true;
      if(error.committed===true){
        if(!refreshAttempted){try{await refresh(true);}catch{}}
        notify(`已保存，后续处理未完成，请核对当前结果。${error.message}`,true);
      }else notify(error.message,true);
      throw error;
    }
    finally { if(!reading)setPending(n => n - 1); }
  }
  // Click handlers deliberately contain errors; the actionable explanation is shown in the toast.
  const perform = (action, input, message) => act(action, input, message).catch(() => {});
  if (!data) return <div className="loading-screen"><div className="brand-mark"><Sparkles size={24}/></div><h2>行知助手</h2>{failure ? <><p>{failure}</p><button onClick={refresh}>重试</button></> : <><LoaderCircle className="spin"/><p>打开你的工作空间</p></>}</div>;
  const task = data.tasks.find(t => t.id === selected);
  const attention = data.tasks.filter(t => t.status === 'blocked' || t.followupDue).length;
  const review = data.tasks.filter(t => t.status === 'review').length;
  const active = data.tasks.filter(t => !['completed', 'paused'].includes(t.status)).length;
  const fresh = data.sources.filter(s => s.state === 'new'&&s.routing?.status!=='conflict'&&!s.deleted&&!s.projectExcluded).length;
  const automaticWork=data.briefingSchedule?.enabled||data.settings.automatic||data.delegations.some(j=>['ready','running','watching','retry'].includes(j.status))||data.workRules.some(r=>r.status==='enabled')||data.connectors.some(c=>c.enabled)||(data.webConnections||[]).some(c=>c.enabled)||(data.feedConnections||[]).some(c=>c.enabled)||(data.captureQueue||[]).some(r=>r.status==='queued'||r.status==='failed'&&r.autoRetry?.enabled&&r.autoRetry?.nextRetryAt);
  const automaticAllowed=data.stewardshipStatus?.automaticAllowed!==false;
  const backgroundSummary=automaticWork?(automaticAllowed?'后台按计划推进':data.stewardshipStatus?.message||'自动托管暂缓'):'暂无自动工作';
  const hasModels = Object.values(data.settings.roles).every(id => data.providers.some(p => p.id === id));
  const filtered = data.tasks.filter(t => (filter === 'all' || (filter === 'queue' ? ['todo','blocked','paused'].includes(t.status) : filter === 'progress' ? ['running','waiting'].includes(t.status) : filter === 'attention' ? t.status === 'blocked' || t.followupDue : t.status === filter)) && `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase()));
  const pageName = {trash:'已删除',help:'使用说明',capabilities:'能力中心',workmap:'项目工作地图',attention:'关注中心',acceptance:'成果验收',briefing:'工作简报',routing:'材料归类',capture:'收集队列',health:'工作体检',operations:'今日安排',library:'全局检索',playbooks:'工作方案',memory:'工作记忆', decisions:'待我决策',connections:'信息连接',runtime:'运行与恢复',projects:'项目', board: '工作看板', agent: 'Agent 委托', rules:'工作规则', inbox: '信息收件箱', artifacts: '工作产出', activity: '推进记录', settings: '模型与设置' }[page];
  const navigationSection=sectionForPage(page);
  const navigationCounts={trash:data.deletedTasks?.length||0,board:active,decisions:data.decisionCards?.length||0,acceptance:review,attention:data.attentionCounts?.unread||0,agent:data.delegations.filter(j=>!['completed','cancelled'].includes(j.status)).length,rules:data.workRules.filter(r=>r.status==='enabled').length,inbox:fresh,connections:(data.connectors||[]).filter(c=>c.enabled).length+(data.webConnections||[]).filter(c=>c.enabled).length+(data.feedConnections||[]).filter(c=>c.enabled).length,capture:(data.captureQueue||[]).filter(r=>['queued','processing','failed'].includes(r.status)).length,routing:data.sources.filter(s=>s.routing?.status==='conflict'&&!s.deleted&&!s.projectExcluded).length,projects:data.projects.length,artifacts:data.resultOverview?.counts.current||0};
  function openSection(target){setSelected(null);setModal(null);if(target==='agent'){setSelectedJob(null);setShowTools(false);}if(target==='projects')setSelectedProject(null);goto(target);}
  function goto(target, targetFilter = 'all') { if(target==='decisions')setDecisionFilter('all');setPage(target); setFilter(targetFilter); setSearch(''); if(target==='acceptance')setAcceptanceTaskId(null); }
  function helpNavigate(target){
    if(target==='captureWindow'){if(window.assistant?.quickCaptureSupported)perform('quickCaptureOpen');else setModal({type:'source'});}
    else openSection(target);
  }
  async function dismissGuide(target){
    await act('guideDismiss');setGuideDismissed(true);setGuideReplay(false);
    if(target)helpNavigate(target);
  }
  function openReview(id){setSelected(null);setRevisionTaskId(null);goto('acceptance');setAcceptanceTaskId(id);}
  function openRevision(id){setRevisionTaskId(id);setSelected(id);}
  async function openLibraryResult(row){
    try {
      await refresh(true);const latest=sync.current.value;
      const unavailable=()=>notify('这条记录已不存在，请刷新检索结果。',true);
      if(row.type==='source'){const source=latest.sources.find(s=>s.id===row.id);if(source)setModal({type:'sourceView',source});else unavailable();}
      else if(row.type==='artifact'){const artifact=latest.artifacts.find(a=>a.id===row.id);if(artifact)setModal({type:'artifact',artifact});else unavailable();}
      else if(row.type==='task'){if(latest.tasks.some(t=>t.id===row.id))setSelected(row.id);else unavailable();}
      else if(row.type==='project'){if(latest.projects.some(p=>p.id===row.id)){setSelectedProject(row.id);goto('projects');}else unavailable();}
      else if(row.type==='job'||row.type==='decision'){
        const decision=row.type==='decision'?latest.decisions.find(d=>d.id===row.id):null;
        const id=row.type==='decision'?decision?.jobId:row.id;
        if(latest.delegations.some(j=>j.id===id)){setSelectedJob(id);goto('agent');}else unavailable();
      }else if(row.type==='memory'){if(latest.memories.some(m=>m.id===row.id))goto('memory');else unavailable();}
    }catch(error){notify(error.message,true);}
  }
  async function exportAll() {
    try { if (desktop) await act('saveExport'); else download('行知工作空间.json', JSON.stringify(await call('export'), null, 2), 'application/json'); } catch (error) { if (!desktop) notify(error.message, true); }
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="window-drag"/>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); goto('board'); }}><div className="brand-mark"><Sparkles size={24} strokeWidth={1.7}/></div><div><strong>行知 <span>PERSONAL</span></strong><small>你的个人工作助手</small></div></a>
      <div className="workspace-label"><span className="avatar">我</span><div>我的工作空间<small>本地 · 仅你可见</small></div><ShieldCheck size={16}/></div>
      <div className="sidebar-navigation"><div className="nav-caption">工作空间</div>
        <WorkspaceNavigation page={page} counts={navigationCounts} onNavigate={openSection}/>
      </div>
      <div className="local-note"><ShieldCheck size={15}/><span>数据保存在你的电脑<br/><small>模型调用按你的配置进行</small></span></div>
      <div className="navigation-utilities"><WorkspaceNavigation utility page={page} counts={navigationCounts} onNavigate={openSection}/></div>
      <div className="assistant-status"><div className={cx('bot-icon', data.operation && 'working')}><Bot size={20}/></div><div><strong>行知助手 <i className={automaticWork&&automaticAllowed ? 'online' : ''}/></strong><small title={backgroundSummary}>{data.operation ? data.operation.label : backgroundSummary}</small></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb">我的工作空间<ChevronRight size={14}/>{navigationSection&&navigationSection.label!==pageName&&<><span className="breadcrumb-section">{navigationSection.label}</span><ChevronRight size={14}/></>}<strong>{pageName}</strong></div><div className="topbar-right"><button className="button small" onClick={()=>openSection('help')}><BookOpen size={15}/>使用说明</button><button className="button small" title="快捷键 ⌘/Ctrl + Shift + I" onClick={()=>window.assistant?.quickCaptureSupported?perform('quickCaptureOpen'):setModal({type:'source'})}><Plus size={15}/>快速收集</button><span className="local-badge"><i/>本地工作空间</span><button className="icon-button" aria-label="刷新工作空间" onClick={refresh}><RefreshCw size={16}/></button></div></header>
      {failure && <div className="error-bar">连接暂时中断：{failure}<button onClick={refresh}>重新连接</button></div>}
      {data.operation && <div className="operation-bar"><LoaderCircle size={16} className="spin"/><span>{data.operation.label}，进度与产出正在保存…</span><button onClick={() => perform('stop')}>{data.operation.parallel?'停止全部推进':'停止本轮'}</button></div>}
      <div className="page-content">
        <SectionNavigation page={page} counts={navigationCounts} onNavigate={goto}/>
        <div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL ASSISTANT</div><h1>{pageName}</h1><p>{{trash:'移除不再需要的事项，需要时恢复。',help:'快速上手、完整功能与常见问题，随时查阅。',acceptance:'集中查看完成标准、实际产出和检查结果，确认后批量验收。',briefing:'查看这段时间的实际进展，以及目前需要处理的事情。',routing:'按明确规则把新材料归入项目，冲突时集中处理。',capture:'助手忙时先保存材料，空闲后按顺序处理；随时查看结果与重试。',health:'汇总本机配置与工作状态，找到需要处理的下一步。',operations:'一起看清截止时间、跟进安排和推进条件，集中安排下一步。',library:'在完整材料、事项、成果和过往决定中，找到需要的内容。',playbooks:'把常用处理方法保存下来，填写关键要求即可开始下一次委托。',memory:'保存反复使用的事实与偏好，让助手在对应项目中参考。',decisions:'把需要你判断的节点集中起来，处理后自动继续。',connections:'自动收集新信息，关联已有事项，继续推进项目。',runtime:'查看运行状态、调用效率与可恢复的工作记录。',projects:'把长期背景、新材料和事项放在一起，持续推进同一个目标。',board: '把信息变成行动，让每一件事有着落。', agent: '从一个目标开始，让助手自己获取信息、填写事项并持续跟进。', rules:'按资料变化和时间安排，让下一轮工作自动开始。', inbox: '把材料交给助手，提取目标、关联上下文、拆解下一步。', artifacts: '先看当前成果，明确下一步需要你做的决定。', activity: '从信息到结果，每一步都有迹可循。', settings: '选择你的模型，定义助手如何为你工作。'}[page]}</p></div><div className="heading-actions">{page === 'board' && <><button className="button" onClick={() => setModal({ type: 'task' })}><Plus size={16}/>新建事项</button><button className="button primary" onClick={() => setModal({ type: 'source' })}><Plus size={17}/>收集信息</button></>}{page === 'inbox' && <button className="button primary" onClick={() => setModal({ type: 'source' })}><Plus size={17}/>添加材料</button>}{page === 'artifacts' && <button className="button" onClick={exportAll}><ArrowDownToLine size={16}/>导出工作空间</button>}</div></div>
        {page==='board'&&data.captureQueue?.some(row=>row.advancement?.infer&&['queued','processing','failed'].includes(row.status))&&<p className="quick-capture-info">新事项原文已保存，正在排队整理；如有失败，内容会保留。<button className="text-button" onClick={()=>goto('capture')}>查看收集进度</button></p>}
        {page === 'board' && <>
          <div className="stats-grid">
            {[{label:'正在推进的事项', value:active, icon:Zap, hint:'围绕目标，持续向前', color:'green'}, {label:'等待你的判断', value:review, icon:CircleCheck, hint:'产出已准备好，等你验收', color:'purple'}, {label:'需要关注', value:attention, icon:Bell, hint:'缺少信息或到了跟进时间', color:'amber'}, {label:'已经完成', value:data.tasks.filter(t=>t.status==='completed').length, icon:CheckCheck, hint:'每一步，都算数', color:'blue'}].map((s,i)=><button key={s.label} className="stat-card" onClick={()=>{setFilter(['all','review','attention','completed'][i]);}}><div className="stat-top"><span>{s.label}</span><s.icon className={`stat-icon ${s.color}`} size={17}/></div><div className="stat-number">{s.value.toString().padStart(2,'0')}<span>{s.hint}</span></div></button>)}
          </div>
          {!hasModels ? <div className="welcome-banner"><div className="welcome-art"><Sparkles size={26}/><span/></div><div><h3>给你的助手，接上思考的能力</h3><p>连接自己的模型，从第一份材料开始，走完收集、拆解、推进和验收。</p></div><button className="button primary" onClick={()=>goto('settings')}>配置模型<ArrowRight size={16}/></button></div> : <div className="flow-strip"><span><Inbox size={16}/>收集信息</span><ArrowRight/><span><List size={16}/>拆解事项</span><ArrowRight/><span><Sparkles size={16}/>持续推进</span><ArrowRight/><span><ShieldCheck size={16}/>检查结果</span><div className="flow-status"><i className={data.stewardshipStatus?.automaticAllowed===false?'':'online'}/>{data.stewardshipStatus?.automaticAllowed===false?'托管暂缓':'Agent 按委托自动推进'}</div></div>}
          <div className="board-toolbar"><div className="segmented"><button className={view==='board'?'selected':''} onClick={()=>setView('board')}><PanelLeft size={15}/>看板</button><button className={view==='list'?'selected':''} onClick={()=>setView('list')}><List size={15}/>列表</button></div><label className="search-field"><Search size={16}/><input aria-label="搜索事项" placeholder="搜索事项、目标或内容" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="筛选事项" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部事项</option><option value="queue">待推进列全部</option><option value="progress">进行与跟进</option>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}<option value="attention">需要关注</option></select><div className="toolbar-spacer"/>{data.tasks.some(t=>!t.agentJobId&&!t.projectId&&!['completed','paused'].includes(t.status))&&<button className="button subtle" disabled={!!data.operation || pending>0} onClick={()=>perform('cycle')}><Play size={14}/>推进人工事项</button>}</div>
          {view === 'board' ? <div className="board">{[
            {id:'todo',title:'待推进',caption:'目标已明确，准备开始',statuses:['todo','blocked','paused'],color:'stone'},
            {id:'running',title:'进行与跟进',caption:'推进步骤，等待新的反馈',statuses:['running','waiting'],color:'mint'},
            {id:'review',title:'待验收',caption:'检查结果，交给你判断',statuses:['review'],color:'lavender'},
            {id:'completed',title:'已完成',caption:'目标达成，结果已保存',statuses:['completed'],color:'sand'}
          ].map(column=>{const items=filtered.filter(t=>column.statuses.includes(t.status));return <section key={column.id} className={`board-column ${column.color}`}><header><div><i/><h3>{column.title}</h3><span>{items.length}</span></div><button className="icon-button" aria-label={`在${column.title}查看全部`} onClick={()=>{setFilter(column.id==='running'?'progress':column.id==='todo'?'queue':column.id);setView('list');}}><MoreHorizontal size={17}/></button></header><p className="column-caption">{column.caption}</p><div className="cards"><PageSlice items={items} label={column.title}>{rows=>rows.map(t=><TaskCard key={t.id} task={t} onClick={()=>setSelected(t.id)}/>)}</PageSlice>{!items.length&&<div className="column-empty"><Circle size={19}/><span>{data.tasks.length?'暂无事项':column.id==='todo'?'从一份材料开始':'新的进展会出现在这里'}</span>{column.id==='todo'&&!data.tasks.length&&<button onClick={()=>setModal({type:'source'})}>添加第一份材料<ArrowRight size={13}/></button>}</div>}</div></section>})}</div> : <div className="list-panel">{!filtered.length ? <Empty title="暂无匹配的事项" description="添加材料或新建事项，开始推进你的工作。"/> : <><div className="task-list-header"><span>事项</span><span>当前状态</span><span>执行步骤</span><span>截止时间</span></div><PageSlice key={filter+search} items={filtered} label="事项列表">{rows=>rows.map(t=><button key={t.id} className="task-list-row" onClick={()=>setSelected(t.id)}><div><strong>{t.title}</strong><small>{t.description.slice(0,80)}</small></div><Status status={t.status}/><span>{t.steps.filter(s=>s.done).length} / {t.steps.length}</span><span>{t.dueAt?formatDate(t.dueAt):'—'}</span></button>)}</PageSlice></>}</div>}
          <div className="board-footnote"><ShieldCheck size={13}/>实际产出与反馈是进度依据。需要外部执行的步骤会保留在「等待反馈」。</div>
        </>}
        {page === 'inbox' && <>
          <div className="inbox-summary"><div className="section-icon"><Inbox size={22}/></div><div><h3>{fresh ? `${fresh} 份材料，等待整理` : '信息从这里开始流动'}</h3><p>助手会识别可行动的目标，保留来源，并把新信息关联到已有事项。</p></div><button className="button primary" disabled={!fresh||!!data.operation} onClick={()=>perform('extract')}><WandSparkles size={16}/>整理并拆解</button></div>
          <div className="source-layout"><div className="source-list">{!data.sources.length?<Empty title="收集你的第一份材料" description="会议纪要、工作想法、聊天记录或项目说明，都可以成为起点。"><button className="button" onClick={()=>setModal({type:'source'})}><Plus size={16}/>添加材料</button></Empty>:<PageSlice items={data.sources} label="材料列表">{rows=>rows.map(s=><button key={s.id} className="source-row" onClick={()=>setModal({type:'sourceView',source:s})}><span className="file-icon"><FileText size={20}/></span><div><h3>{s.title}</h3><p>{s.preview??s.content.slice(0,1000).replace(/\s+/g,' ').slice(0,130)}</p><small>{s.origin} · {formatDate(s.createdAt)}{s.routing?.status==='conflict'?' · 归类冲突，请到材料归类处理':s.projectId?` · ${data.projects.find(p=>p.id===s.projectId)?.name||'项目'}`:''}</small></div><span className={`source-state ${s.state}`}>{s.routing?.status==='conflict'?'待归类':s.state==='processed'?'已整理':s.state==='processing'?'整理中':'待整理'}</span><ChevronRight size={16}/></button>)}</PageSlice>}</div><aside className="info-aside"><div className="aside-symbol"><Link2 size={22}/></div><h3>让上下文连起来</h3><p>同一个目标的补充材料，可以关联到已有事项，让助手带着之前的进展继续工作。</p><div className="aside-rule"/><h4>支持的材料</h4><ul><li>直接输入或粘贴文本</li><li>导入 TXT、Markdown</li><li>导入 JSON、CSV 文本</li><li>PDF、Word（DOCX）</li><li>PNG、JPG、JPEG 图片文字识别</li></ul><small>文件最多 10 MB、50 万字符，PDF 最多 250 页。Agent 可检索全文并引用页码或段落；图片在本机识别，可能有错漏；扫描 PDF 的无文字页在本机识别（每份最多 20 页），含文字页中的图片不额外识别。</small>{desktop&&<button className="button" onClick={()=>perform('chooseFolder')}><FolderOpen size={15}/>同步本地文件夹</button>}</aside></div>
        </>}
        {page === 'library' && <LibraryPage data={data} act={act} openResult={openLibraryResult}/>}
        {page === 'artifacts' && <ResultsPage openTrash={()=>goto('trash')} data={data} openResult={openLibraryResult} openTask={id=>{setRevisionTaskId(null);setSelected(id);}} openRevision={openRevision} openReview={openReview} openDecisions={()=>goto('decisions')}/>}
        {page === 'playbooks' && <PlaybooksPage startRule={draft=>{setRuleDraft(draft);goto('rules');}} data={data} act={act} perform={perform} startJob={draft=>{setJobDraft(draft);setNewProject(null);setSelectedJob(null);setShowTools(false);goto('agent');}} openJob={id=>{setSelectedJob(id);goto('agent');}}/>}
        {page === 'memory' && <MemoryPage data={data} act={act} perform={perform} openSource={id=>{const source=data.sources.find(s=>s.id===id);if(source)setModal({type:'sourceView',source});}}/>}
        {page === 'activity' && <div className="activity-panel">{!data.events.length?<Empty icon={Clock3} title="每一步推进，都会留下记录" description="添加信息、拆解事项或开始执行后，可以在这里查看过程。"/>:<div className="timeline"><PageSlice items={data.events} label="推进记录">{rows=>rows.map(e=><div key={e.id} className={`timeline-item ${e.kind}`}><div className="timeline-dot">{e.kind==='success'?<Check size={12}/>:e.kind==='error'?<X size={11}/>:<Circle size={8}/>}</div><div><header><strong>{e.title}</strong><time>{formatDate(e.at)}</time></header><p>{e.detail}</p>{e.taskId&&<button className="text-button" onClick={()=>data.deletedTasks?.some(t=>t.id===e.taskId)?goto('trash'):setSelected(e.taskId)}>查看事项<ArrowUpRight size={13}/></button>}</div></div>)}</PageSlice></div>}</div>}
        {page === 'agent' && <AgentPage initialDraft={jobDraft} clearDraft={()=>setJobDraft(null)} initialProject={newProject} clearProject={()=>setNewProject(null)} data={data} act={act} perform={perform} openTask={setSelected} initialJob={selectedJob} initialTools={showTools} openRules={()=>goto('rules')} openDecisions={()=>goto('decisions')} openSettings={()=>goto('settings')}/>}
        {page === 'capture' && <CaptureQueue data={data} act={act} openJob={id=>{setSelectedJob(id);goto('agent');}} openRouting={()=>goto('routing')} openSource={id=>{const source=data.sources.find(s=>s.id===id);if(source)setModal({type:'sourceView',source});}} openProject={id=>{setSelectedProject(id);goto('projects');}}/>}
        {page === 'acceptance' && <AcceptancePage focusTaskId={acceptanceTaskId} clearFocus={()=>setAcceptanceTaskId(null)} openRevision={openRevision} data={data} act={act} openResult={openLibraryResult} onNavigate={route=>{if(route.taskId)setSelected(route.taskId);if(route.jobId)setSelectedJob(route.jobId);if(route.projectId)setSelectedProject(route.projectId);goto(route.page||'board');}} openTask={setSelected} openJob={id=>{setSelectedJob(id);goto('agent');}} openProject={id=>{setSelectedProject(id);goto('projects');}} openArtifact={id=>{const artifact=data.artifacts.find(a=>a.id===id);if(artifact)setModal({type:'artifact',artifact});}}/>}
        {page === 'briefing' && <BriefingPage data={data} act={act} openTask={setSelected} openJob={id=>{setSelectedJob(id);goto('agent');}} openProject={id=>{setSelectedProject(id);goto('projects');}}/>}
        {page === 'attention' && <AttentionPage data={data} act={act} openTask={setSelected} openJob={id=>{setSelectedJob(id);goto('agent');}} openProject={id=>{setSelectedProject(id);goto('projects');}} onNavigate={route=>{if(route.taskId)setSelected(route.taskId);if(route.jobId){setSelectedJob(route.jobId);setShowTools(false);}if(route.projectId)setSelectedProject(route.projectId);goto(route.page==='agents'?'agent':route.page||'board');}}/>}
        {page === 'routing' && <IntakeRouting data={data} act={act} onNavigate={route=>{if(route.projectId)setSelectedProject(route.projectId);goto(route.page||'projects');}} openSource={id=>{const source=data.sources.find(s=>s.id===id);if(source)setModal({type:'sourceView',source});}} openProject={id=>{setSelectedProject(id);goto('projects');}}/>}
        {page === 'health' && <HealthPage data={data} act={act} onNavigate={route=>{if(route.taskId)setSelected(route.taskId);if(route.jobId){setSelectedJob(route.jobId);setShowTools(false);}if(route.projectId)setSelectedProject(route.projectId);if(route.tools)setShowTools(true);goto(route.page||'runtime');}}/>}
        {page === 'operations' && <OperationsPage data={data} act={act} openTask={setSelected} openJob={id=>{setSelectedJob(id);goto('agent');}} openDecisions={()=>goto('decisions')} openProject={id=>{setSelectedProject(id);goto('projects');}}/>}
        {page === 'projects' && <ProjectsPage initialProject={selectedProject} data={data} act={act} perform={perform} openSource={source=>setModal({type:'sourceView',source})} openTask={setSelected} addSource={projectId=>setModal({type:'source',projectId})} openJob={id=>{setSelectedJob(id);setNewProject(null);goto('agent');}} createJob={id=>{setNewProject(id);goto('agent');}}/>}
        {page === 'rules' && <RulesPage initialDraft={ruleDraft} clearDraft={()=>setRuleDraft(null)} data={data} act={act} perform={perform} openJob={id=>{setSelectedJob(id);setShowTools(false);goto('agent');}} openTools={()=>{setShowTools(true);goto('agent');}}/>}
        {page === 'workmap' && <WorkMapPage data={data} act={act} openTask={setSelected} openJob={id=>{setSelectedJob(id);setShowTools(false);goto('agent');}} openProject={id=>{setSelectedProject(id);goto('projects');}} openResult={openLibraryResult}/>}
        {page === 'help' && <HelpPage onNavigate={helpNavigate} onReplay={()=>setGuideReplay(true)}/>}
        {page === 'capabilities' && <CapabilitiesPage data={data} act={act}/>}
        {page === 'connections' && <ConnectionsPage data={data} act={act} perform={perform} openProjects={id=>{setSelectedProject(typeof id==='string'?id:null);goto('projects');}} openRules={()=>goto('rules')}/>}
        {page === 'decisions' && <DecisionsPage filter={decisionFilter} setFilter={setDecisionFilter} openResult={openLibraryResult} openReview={openReview} openRevision={openRevision} data={data} act={act} perform={perform} openJob={id=>{setSelectedJob(id);goto('agent');}} openTask={setSelected}/>}
        {page === 'runtime' && <RuntimePage data={data} act={act} perform={perform}/>}
        {page === 'trash' && <TaskTrash data={data} act={act} openTask={id=>{goto('board');setSelected(id);}} openResults={()=>goto('artifacts')}/>}
        {page === 'settings' && <Settings data={data} act={act} perform={perform} setModal={setModal} exportAll={exportAll}/>}
      </div>
      <footer className="app-footer"><span><span className="save-dot"/>工作数据已保存在本机</span><span>行知助手 <span className="version">v{appVersion}</span><span className="footer-divider"/>收集 · 推进 · 有结果</span></footer>
    </main>
    {guideOpen&&<QuickStartDialog Modal={Modal} hasModels={hasModels} onDismiss={dismissGuide}/>}
    {task&&<TaskDetail startRevision={revisionTaskId===task.id} openReview={()=>openReview(task.id)} task={task} data={data} onClose={()=>{setSelected(null);setRevisionTaskId(null);}} perform={perform} act={act} setModal={setModal} notify={notify} openAgent={()=>{setSelected(null);if(task.agentJobId){setSelectedJob(task.agentJobId);setJobDraft(null);}else{setJobDraft({taskId:task.id,taskUpdatedAt:task.updatedAt,goal:`${task.title}\n\n${task.description}\n\n完成标准：${task.criteria}`,autoAccept:false});}goto('agent');}}/>}
    {modal?.type==='taskDelete'&&<TaskDeleteDialog task={modal.task} data={data} act={act} Modal={Modal} onClose={()=>setModal(null)} onDeleted={()=>{setModal(null);setSelected(null);setRevisionTaskId(null);}}/>}
    {modal?.type==='source'&&<SourceForm data={data} notify={notify} initialProject={modal.projectId} onClose={()=>setModal(null)} act={act}/>}
    {modal?.type==='task'&&(modal.task?<TaskForm task={modal.task} onClose={()=>setModal(null)} act={act}/>:<TaskIntakeDialog data={data} act={act} Modal={Modal} ManualForm={TaskForm} ProviderForm={ProviderForm} onClose={()=>setModal(null)} onCreated={row=>{setModal(null);goto('board');if(row?.taskId)setSelected(row.taskId);else setPendingIntake(row?.id);}}/>)}
    {modal?.type==='provider'&&<ProviderForm provider={modal.provider} onClose={()=>setModal(null)} act={act}/>}
    {modal?.type==='sourceView'&&<SourceViewer source={data.sources.find(s=>s.id===modal.source.id)||modal.source} data={data} act={act} onClose={()=>setModal(null)} openTask={id=>{setModal(null);setSelected(id);}}/>}
    {modal?.type==='artifact'&&<ArtifactDocument onOpenCurrent={id=>{const artifact=data.artifacts.find(a=>a.id===id);if(artifact)setModal({type:'artifact',artifact});}} artifact={modal.artifact} data={data} onClose={()=>setModal(null)}/>}
    {toast&&<div role="status" className={cx('toast',toast.error&&'error')}><span>{toast.error?<AlertCircle size={18}/>:<CircleCheck size={18}/>}</span>{toast.message}<button onClick={()=>setToast(null)} aria-label="关闭提示"><X size={15}/></button></div>}
  </div>;
}

function TaskCard({ task, onClick }) {
  const done = task.steps.filter(s=>s.done).length;
  return <button className="task-card" onClick={onClick}><div className="card-top"><span className="task-id">{task.id.slice(0,6).toUpperCase()}</span>{task.priority==='high'?<span className="priority">优先处理</span>:<span className="card-dots">···</span>}</div><h3>{task.title}</h3><p className="task-description">{task.description||task.criteria}</p>{['blocked','paused','waiting','running'].includes(task.status)&&<Status status={task.status}/>}<div className="task-next"><span>{task.status==='completed'?'完成结果':task.status==='review'?'检查结果':'下一步'}</span><p>{task.status==='blocked'?task.lastError:task.status==='waiting'?task.waitingOn:task.status==='completed'||task.status==='review'?task.verification?.summary:task.steps.find(s=>!s.done)?.title||'检查是否满足完成标准'}</p></div><div className="progress-track"><span style={{width:`${task.steps.length?done/task.steps.length*100:0}%`}}/></div><div className="card-footer"><span><List size={13}/>{done}/{task.steps.length} 步骤</span>{task.followupDue?<span className="due"><Bell size={12}/>待跟进</span>:task.dueAt?<span><Clock3 size={12}/>{new Date(task.dueAt).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</span>:<span><Link2 size={12}/>{task.sourceIds.length} 份材料</span>}</div></button>;
}

function SourceForm({ data, initialProject, onClose, act, notify }) {
  const [title,setTitle]=useState(''),[content,setContent]=useState(''),[files,setFiles]=useState([]),[projectId,setProjectId]=useState(initialProject||''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[autoRetry,setAutoRetry]=useState(false);const input=useRef();
  async function readFiles(list) {
    if(busy)return;setError('');try{const rows=[...list];if(files.length+rows.length>10)throw new Error('每次最多 10 份文件');for(const file of rows){if(!/\.(txt|md|csv|json|pdf|docx|png|jpg|jpeg)$/i.test(file.name))throw new Error(`不支持 ${file.name}，Word 请使用 DOCX 格式`);if(file.size>10000000)throw new Error(`${file.name} 超过 10 MB`);}setFiles(previous=>[...previous,...rows]);}catch(e){setError(e.message);}
  }
  async function submit(event){event.preventDefault();if(busy)return;setBusy(true);setError('');try{
    const items=await serializeCaptureFiles(files);
    const textItems=content.trim()?[{title:title.trim()||content.trim().split('\n')[0].slice(0,80),content,origin:'手动输入',projectId:projectId||null}]:[];
    const organize=event.nativeEvent.submitter?.value==='organize';const result=await act(data.operation?'captureEnqueue':'captureSave',{items,textItems,projectId,organize,autoRetry:organize&&autoRetry});const queued=(result.captureQueue||[]).some(r=>!(data.captureQueue||[]).some(old=>old.id===r.id));notify?.(queued?'材料已保存到收集队列，空闲后处理':organize&&!projectId?'材料已保存，正在整理本次新增内容':'材料已保存');onClose();
  }catch(e){setError(e.message);}finally{setBusy(false);}}
  return <Modal title="把信息交给助手" subtitle="粘贴文字，或导入 PDF、Word、文本和截图。图片和扫描 PDF 先在本机识别文字。" onClose={()=>{if(!busy)onClose();}}><form onSubmit={submit} onPaste={event=>pasteImages(event,readFiles,busy)}><div className="modal-body form-stack">{data.operation&&<p className="help-text" role="status">助手正在工作。本次材料先保存到收集队列，空闲后处理；排队批次合计最多 25 MB。</p>}<label>所属项目<select disabled={busy} aria-label="材料所属项目" value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">按规则归类，未匹配保留独立</option>{data.projects.map(p=><option key={p.id} value={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select><small>未选项目时，启用的归类规则在导入时生效；冲突先保留待处理。指定项目优先，暂停的委托保持暂停。</small></label><label>材料标题<input disabled={busy} value={title} onChange={e=>setTitle(e.target.value)} placeholder="例如：本周产品讨论纪要"/></label><label>内容<textarea disabled={busy} rows={6} value={content} onChange={e=>setContent(e.target.value)} placeholder="会议纪要、目标、要求或新的进展…"/></label><ScreenshotInput addFiles={readFiles} disabled={busy} onBusy={setBusy} onError={setError}/><ScreenshotPreview files={files}/><div className="drop-zone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();readFiles(e.dataTransfer.files);}}><Upload size={21}/><button disabled={busy} type="button" className="text-button" onClick={()=>input.current.click()}>选择文件，或拖到这里</button><small>PDF · DOCX · TXT · MD · CSV · JSON · PNG · JPG · JPEG，每次 10 份，每份 10 MB</small><input disabled={busy} ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg" onChange={e=>readFiles(e.target.files)} aria-label="导入材料文件"/></div><small>图片识别支持中英文，边长最多 10000 像素、总像素最多 2500 万。扫描 PDF 最多识别 20 个无文字页。原图不上传，PDF 原文件也留在本机；选择整理后，识别出的文字会交给配置的模型。</small>{files.map((file,i)=><div className="file-chip" key={i}><FileText size={14}/>{file.name}<button disabled={busy} type="button" aria-label={`移除 ${file.name}`} onClick={()=>setFiles(items=>items.filter((_,index)=>index!==i))}><X size={14}/></button></div>)}{!projectId&&<label className="connection-check"><input type="checkbox" aria-label="收集自动重试" checked={autoRetry} disabled={busy} onChange={e=>setAutoRetry(e.target.checked)}/>临时服务故障自动重试（仅保存并整理，最多3次）</label>}{error&&<p className="form-error">{error}</p>}</div><div className="modal-footer"><span>{projectId?'有项目委托时自动归并；暂停的委托保持暂停。':'仅整理本次新增材料，保留来源定位。'}</span>{!projectId&&<button type="submit" name="mode" value="organize" className="button" disabled={busy||(!content.trim()&&!files.length)||(!data.operation&&!data.providers.some(p=>p.id===data.settings.roles.organize))}>{files.some(file=>/\.(png|jpe?g)$/i.test(file.name))?'识别并转事项':'保存并整理'}</button>}<button type="submit" name="mode" value="save" className="button primary" disabled={busy||(!content.trim()&&!files.length)}>{busy?'正在读取…':'保存材料'}</button></div></form></Modal>;
}
function SourceViewer({source,data,act,onClose,openTask}) {
  const [query,setQuery]=useState(''),[result,setResult]=useState(null),[error,setError]=useState(''),[tab,setTab]=useState('text'),readSequence=useRef(0);
  async function read(start=0,q=query){const sequence=++readSequence.current;try{const next=await act('readSource',{id:source.id,query:q,start,limit:6});if(sequence===readSequence.current){setResult({...next,query:q});setError('');}}catch(e){if(sequence===readSequence.current)setError(e.message);}}
  const current=data.sources.find(s=>s.id===source.id);
  const available=!!current&&!current.deleted&&!current.projectExcluded&&!current.accessPolicyQuarantined;
  useEffect(()=>{setResult(null);setQuery('');setTab('text');if(available)read(0,'');else setError('这份材料已移除、撤回或失去正文权限。');return()=>{readSequence.current++;};},[source.id,source.bodyRevision,source.accessPolicyQuarantined,available]);
  if(!available)return <Modal wide title={source.title} onClose={onClose}><div className="modal-body"><p className="form-error" role="alert">这份材料已移除、撤回或失去正文权限，旧正文已关闭。</p></div></Modal>;
  return <Modal wide title={source.title} subtitle={`${source.origin} · ${source.version?`第 ${source.version} 版 · `:''}${(source.contentChars??source.content.length).toLocaleString()} 字符`} onClose={onClose}>
    <div className="modal-body form-stack"><div className="view-toggle" role="tablist" aria-label="材料详情视图"><button type="button" role="tab" aria-selected={tab==='text'} className={tab==='text'?'active':''} onClick={()=>setTab('text')}>正文定位</button><button type="button" role="tab" aria-selected={tab==='versions'} className={tab==='versions'?'active':''} onClick={()=>setTab('versions')}>版本与影响</button></div>
      <SourceProvenance source={source} onOpen={desktop?async index=>{try{await act('sourceOriginOpen',{id:source.id,index});}catch(e){setError(e.message);}}:undefined}/>{!available&&<p className="form-error">这份材料已不在当前工作空间，请关闭后重新查看。</p>}
      {tab==='versions'?<SourceVersions data={data} sourceId={source.id} act={act} openTask={openTask}/>:<><form className="agent-actions source-search" onSubmit={e=>{e.preventDefault();read();}}><input aria-label="材料全文检索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索全文关键词，定位页码或段落"/><button className="button">检索</button></form>{source.warnings?.map(w=><p key={w} className="help-text">{w}</p>)}{error&&<p className="form-error">{error}</p>}{result&&<><small>共 {result.totalSegments} 个定位片段 · 匹配 {result.totalMatches} 个</small>{!result.segments.length&&<p>没有找到匹配内容</p>}{result.segments.map(s=><section key={s.id} className="source-segment"><strong>{s.label}</strong><pre>{s.text}</pre>{s.truncated&&<small>本页预览已截断，可下载这版原文核对完整内容</small>}</section>)}</>}</>}
    </div><div className="modal-footer"><button className="button" disabled={!available} onClick={async()=>{try{const full=await call('viewDetail',{kind:'source',id:source.id});download(`${full.title.replace(/[\\/:*?"<>|]/g,'-').slice(0,100)}—第${full.version||1}版原文.txt`,full.content,'text/plain;charset=utf-8');}catch(e){setError(e.message);}}}><ArrowDownToLine size={15}/>下载第 {source.version||1} 版原文</button>{tab==='text'&&<><button className="button" disabled={!result?.start} onClick={()=>read(Math.max(0,result.start-6),result.query)}>上一组</button><button className="button" disabled={!result?.more} onClick={()=>read(result.start+6,result.query)}>下一组</button></>}</div>
  </Modal>;
}

function TaskForm({ task, initialDescription='', onClose, act }) {
  const [title,setTitle]=useState(task?.title||'');const [description,setDescription]=useState(task?.description||initialDescription);const [objective,setObjective]=useState(task?.objective||'');const [criteria,setCriteria]=useState(task?.criteria||'');const [priority,setPriority]=useState(task?.priority||'normal');const [dueAt,setDueAt]=useState(dateInput(task?.dueAt));const [steps,setSteps]=useState([{title:'',kind:'analysis'}]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function submit(e){e.preventDefault();setBusy(true);try{await act(task?'updateTask':'createTask',{id:task?.id,title,description,...(task?.objective?{objective}:{}),criteria,priority,dueAt:dueAt?new Date(dueAt).toISOString():null,steps:steps.filter(s=>s.title.trim())},task?'事项已更新':'事项已创建');onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <Modal title={task?'编辑事项':'手动创建事项'} subtitle="明确目标和完成标准，让助手知道什么时候算做好。" onClose={onClose}><form onSubmit={submit}><div className="modal-body form-stack"><label>事项标题<input value={title} required placeholder="例如：整理一份下季度读书计划" onChange={e=>setTitle(e.target.value)}/></label><label>{task?.objective?'背景':'背景与目标'}<textarea rows={3} value={description} onChange={e=>setDescription(e.target.value)} placeholder="为什么做这件事？有哪些已知信息和限制？"/></label>{task?.objective&&<label>目标<textarea rows={2} maxLength={3000} value={objective} onChange={e=>setObjective(e.target.value)}/></label>}<label>完成标准<textarea rows={2} value={criteria} onChange={e=>setCriteria(e.target.value)} placeholder="例如：包含 3 本书、阅读节奏和每周可执行安排"/></label><div className="form-row"><label>优先级<select value={priority} onChange={e=>setPriority(e.target.value)}><option value="normal">普通</option><option value="high">优先处理</option><option value="low">不着急</option></select></label><label>截止时间<input type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)}/></label></div>{!task&&<div className="step-editor"><label>执行步骤 <small>留空时按目标生成分析</small></label>{steps.map((step,i)=><div className="step-input" key={i}><span>{i+1}</span><input aria-label={`步骤 ${i+1}`} value={step.title} onChange={e=>setSteps(rows=>rows.map((r,j)=>j===i?{...r,title:e.target.value}:r))} placeholder="要做的具体动作"/><select aria-label={`步骤 ${i+1} 类型`} value={step.kind} onChange={e=>setSteps(rows=>rows.map((r,j)=>j===i?{...r,kind:e.target.value}:r))}>{Object.entries(kinds).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select><button type="button" className="icon-button" aria-label={`移除步骤 ${i+1}`} onClick={()=>setSteps(rows=>rows.filter((_,j)=>j!==i))}><X size={14}/></button></div>)}<button type="button" className="text-button" onClick={()=>setSteps(rows=>[...rows,{title:'',kind:'analysis'}])} disabled={steps.length>=12}><Plus size={14}/>添加步骤</button></div>}{error&&<p className="form-error">{error}</p>}</div><div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{task?'保存修改':'创建事项'}</button></div></form></Modal>;
}

function TaskDetail({ task, data, onClose, perform, act, setModal, openAgent, openReview, startRevision }) {
  const resultGroup=data.resultOverview?.groups.find(g=>g.taskId===task.id);
  const feedbackRef=useRef(null);
  const [note,setNote]=useState('');const [feedbackType,setFeedbackType]=useState('feedback');
  const [nextDate,setNextDate]=useState(dateInput(task.nextCheckAt));
  useEffect(()=>{setNote('');setFeedbackType(startRevision?'revise':'feedback');if(startRevision)feedbackRef.current?.focus();},[task.id,startRevision]);
  useEffect(()=>{setNextDate(dateInput(task.nextCheckAt));},[task.id,task.nextCheckAt]);
  const external=task.steps.find(s=>!s.done)?.kind==='external';const sources=data.sources.filter(s=>task.sourceIds.includes(s.id));const busy=workBusy(data,{taskId:task.id});
  async function feedback(e){e.preventDefault();try{await act('taskAction',{id:task.id,command:feedbackType,note},task.status==='paused'?'反馈已保存，事项仍保持暂停':'反馈已保存，事项可以继续推进');setNote('');}catch{}}
  return <div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><aside className="task-drawer" role="dialog" aria-label="事项详情"><header className="drawer-header"><span>事项详情 <span className="task-id">{task.id.slice(0,6).toUpperCase()}</span></span><button className="icon-button" aria-label="关闭事项详情" onClick={onClose}><X size={20}/></button></header><div className="drawer-body"><div className="detail-status"><Status status={task.status}/><div className="detail-task-actions"><button className="text-button" disabled={busy} onClick={()=>setModal({type:'task',task})}><Pencil size={14}/>编辑</button><button className="text-button danger" disabled={busy} onClick={()=>setModal({type:'taskDelete',task})}><Trash2 size={14}/>删除事项</button></div></div><h2>{task.title}</h2>{resultGroup&&<section className="task-result-first"><div className="result-next"><strong>{resultGroup.next}</strong><p>{resultGroup.detail}</p>{resultGroup.ready&&<button className="text-button" onClick={openReview}>核对验收要点 →</button>}</div><ResultFiles group={resultGroup} compact openResult={row=>{const artifact=data.artifacts.find(a=>a.id===row.id);if(artifact)setModal({type:'artifact',artifact});}}/></section>}{task.intake?.status==='pending'&&<p className="help-text">原文已保存，Agent 将自动整理标题、背景和目标，然后继续推进。</p>}<p className="detail-description">{task.description||'暂未填写背景'}</p>{task.objective&&<section className="detail-section"><h3>目标</h3><p>{task.objective}</p></section>}<div className="detail-meta"><span><CalendarDays size={14}/>截止时间</span><strong>{formatDate(task.dueAt)}</strong><span><SlidersHorizontal size={14}/>优先级</span><strong>{task.priority==='high'?'优先处理':task.priority==='low'?'不着急':'普通'}</strong></div><div className="criteria-box"><ShieldCheck size={17}/><div><h4>完成标准</h4><p>{task.criteria}</p></div></div>
    {(task.lastError||task.waitingOn)&&<div className={cx('detail-alert',task.status==='blocked'&&'error')}><AlertCircle size={17}/><div><strong>{task.status==='blocked'?'需要调整':'等待新的进展'}</strong><p>{task.lastError||task.waitingOn}</p>{task.followupDue&&<small>已到跟进时间，请补充结果或调整下次检查时间。</small>}</div></div>}
    <section className="detail-section"><header><h3>执行步骤</h3><span>{task.steps.filter(s=>s.done).length} / {task.steps.length}</span></header><div className="steps-list">{task.steps.map((s,i)=><div className={cx('step',s.done&&'done')} key={s.id}><span className="step-number">{s.done?<Check size={13}/>:i+1}</span><div><strong>{s.title}</strong><small>{kinds[s.kind]}{s.evidence&&` · 依据：${s.evidence}`}</small></div></div>)}</div></section>
    <section className="detail-section"><h3>Agent 推进</h3><p className="help-text">{task.agentJobId?'此事项由 Agent 委托推进，可查看工具查询、计划与运行记录。':'交给 Agent 后保留原事项和历史产出，由 Agent 读取资料、重新规划并执行。'}</p><button className="button" disabled={busy||(!task.agentJobId&&(!!task.projectId||task.status==='paused'))} onClick={openAgent}><Bot size={16}/>{task.agentJobId?'查看 Agent 委托':'交给 Agent 继续'}</button>{!task.agentJobId&&task.projectId&&<small>请到所属项目中创建委托。</small>}</section>
    <SpendControls data={data} scopeKey={task.agentJobId?'job:'+task.agentJobId:'task:'+task.id} act={act} showRuns={task.progressRuns||[]}/>
    <GenerationControls task={task} data={data} act={act}/>
    <TaskModelPreference task={task} data={data} act={act}/>
    <GroundingPanel task={task} enabled={data.settings.evidenceGrounding===true}/>
    {task.verification&&<section className="detail-section"><h3>结果检查</h3><div className={cx('verification',task.verification.passed&&'passed')}><ShieldCheck size={18}/><div><strong>{task.verification.passed?'满足完成标准':'尚未满足完成标准'}</strong><p>{task.verification.summary}</p>{task.verification.mode==='incremental'&&<small>本次按改动检查，复用 {task.verification.reusedChunks} 个未变化片段的已通过结果；整体完成标准仍独立核验。</small>}{task.verification.gaps.map((g,i)=><p key={i}>• {g}</p>)}</div></div></section>}
    {!resultGroup&&<section className="detail-section"><h3>当前成果</h3><p className="muted">推进后生成的文稿与分析将显示在这里。</p></section>}
    <section className="detail-section"><header><h3>关联材料</h3><span>{sources.length}</span>{desktop&&task.status!=='completed'&&!task.agentCancelled&&<button className="text-button" onClick={()=>perform('quickCaptureOpen',{taskId:task.id})}>快速补充文字或截图</button>}</header>{sources.length?sources.map(s=><button className="detail-file" key={s.id} onClick={()=>setModal({type:'sourceView',source:s})}><Link2 size={17}/><div><strong>{s.title}</strong><small>{s.origin} · {formatDate(s.provenance?.capturedAt||s.createdAt)}</small></div><ChevronRight size={15}/></button>):<p className="muted">手动创建的事项可以通过反馈补充上下文。</p>}</section>
    {task.status==='waiting'&&<section className="detail-section"><h3>下次跟进</h3><div className="inline-form"><input aria-label="下次跟进时间" type="datetime-local" value={nextDate} onChange={e=>setNextDate(e.target.value)}/><button className="button" disabled={busy} onClick={()=>perform('updateTask',{id:task.id,nextCheckAt:nextDate?new Date(nextDate).toISOString():null},'跟进时间已更新')}>保存</button></div><p className="help-text">到时会标记为需要关注；收到新反馈后继续推进。</p></section>}
    <section className="detail-section"><h3>反馈与补充</h3>{task.notes.map(n=><div className="note" key={n.id}><header><span>{n.kind==='source'?'新材料':'你的反馈'}</span><time>{formatDate(n.at)}</time></header><p>{n.text}</p></div>)}{task.status!=='completed'&&<form onSubmit={feedback} className="feedback-form"><textarea ref={feedbackRef} aria-label="反馈内容" rows={3} value={note} onChange={e=>setNote(e.target.value)} placeholder="补充信息、说明修改方向，或填写外部执行的真实结果…"/><div><select aria-label="反馈类型" value={feedbackType} onChange={e=>setFeedbackType(e.target.value)}><option value="feedback">{task.status==='paused'?'补充信息，保持暂停':'补充信息并继续'}</option><option value="revise">修改最近的产出</option>{external&&<option value="externalDone">外部步骤已完成，附上结果</option>}</select><button className="button primary" disabled={!note.trim()||busy}>提交反馈</button></div></form>}</section>
    <section className="detail-section"><h3>最近进展</h3>{data.events.filter(e=>e.taskId===task.id).slice(0,8).map(e=><div className="detail-event" key={e.id}><i/><div><strong>{e.title}</strong><small>{formatDate(e.at)}</small><p>{e.detail}</p></div></div>)}</section>
    </div><footer className="drawer-footer">{task.status==='paused'?<button className="button" disabled={busy} onClick={()=>perform('taskAction',{id:task.id,command:'resume'})}><Play size={15}/>恢复事项</button>:task.status!=='completed'&&<button className="button" disabled={busy} onClick={()=>perform('taskAction',{id:task.id,command:'pause'})}><Pause size={15}/>暂停</button>}{task.status==='review'?<button className="button primary" disabled={busy} onClick={()=>perform('taskAction',{id:task.id,command:'accept'},'事项已验收完成')}><Check size={16}/>验收完成</button>:['todo','blocked'].includes(task.status)?<button className="button primary" disabled={busy} onClick={()=>task.agentJobId?openAgent():perform('advance',{id:task.id})}><Sparkles size={16}/>{task.agentJobId?'查看 Agent 推进':task.steps.every(s=>s.done)?'继续结果检查':task.steps.find(s=>!s.done)?.checkpoint?'从已保存章节继续':task.status==='blocked'?'重新推进':'推进下一步'}</button>:task.status==='completed'?<span className="completed-label"><CircleCheck size={17}/>已完成并保存结果</span>:<span className="muted">{task.status==='waiting'?'补充结果后继续推进':task.status==='running'?'助手正在处理':'事项已暂停'}</span>}</footer></aside></div>;
}

function ProviderForm(props) { return <ProviderEditor {...props} Modal={Modal}/>; }

function Settings({ data, act, perform, setModal, exportAll }) {
  const [profile,setProfile]=useState(data.settings.profile);const [testing,setTesting]=useState(null);const [testResult,setTestResult]=useState({});
  async function test(id){setTesting(id);try{const result=await act('testProvider',{id});setTestResult(s=>({...s,[id]:{ok:true,message:result.message}}));}catch(e){setTestResult(s=>({...s,[id]:{ok:false,message:e.message}}));}finally{setTesting(null);}}
  const settings=(input)=>perform('settings',input);
  return <div className="settings-layout"><div className="settings-main">
    <section className="settings-card"><header><div><h2><Sparkles size={19}/>我的模型</h2><p>可以给不同工作选择不同模型，也可以全部使用同一个。</p></div><button className="button primary" onClick={()=>setModal({type:'provider'})}><Plus size={15}/>添加模型</button></header>{!data.providers.length?<div className="model-empty"><Bot size={30}/><h3>助手还没有连接模型</h3><p>配置后即可整理材料、生成产出和检查结果。</p><button className="text-button" onClick={()=>setModal({type:'provider'})}>添加第一个模型<ArrowRight size={14}/></button></div>:<div className="providers">{data.providers.map(p=><div className="provider" key={p.id}><div className="provider-icon"><Bot size={20}/></div><div className="provider-info"><h3>{p.name}<span>{protocolLabel(p.type)}</span></h3><p>{p.model}</p><small>{p.type==='codex'?`Codex CLI · ${p.reasoning} · 使用订阅额度`:p.baseUrl}</small>{testResult[p.id]&&<small className={testResult[p.id].ok?'test-ok':'test-error'}>{testResult[p.id].message}</small>}</div><div className="provider-actions"><button className="button small" onClick={()=>test(p.id)} disabled={!!testing}>{testing===p.id?<LoaderCircle className="spin" size={13}/>:'测试连接'}</button><button className="icon-button" aria-label={`编辑 ${p.name}`} onClick={()=>setModal({type:'provider',provider:p})}><Pencil size={15}/></button><button className="icon-button" aria-label={`删除 ${p.name}`} onClick={()=>{if(window.confirm(`删除模型配置「${p.name}」？使用它的自动推进会暂停。`))perform('deleteProvider',{id:p.id});}}><Trash2 size={15}/></button></div></div>)}</div>}<div className="role-grid">{Object.entries(roles).map(([key,label],i)=><label key={key}><span><span className="role-number">0{i+1}</span>{label}</span><small>{['理解材料，提取目标与执行步骤','结合上下文，生成实际工作产出','检查结果是否满足完成标准'][i]}</small><select aria-label={`${label}模型`} value={data.settings.roles[key]} onChange={e=>settings({roles:{...data.settings.roles,[key]:e.target.value}})}><option value="">选择模型</option>{data.providers.map(p=><option value={p.id} key={p.id} disabled={!!p.archivedAt}>{p.name}{p.archivedAt?'（已归档）':''}</option>)}</select></label>)}</div></section>
    <ModelFallback data={data} act={act}/>
    <ModelRouting data={data} act={act}/>
    <section className="settings-card"><header><div><h2><ShieldCheck size={19}/>严格证据核验</h2><p>按要求建立证据清单，把关键结论绑定到原文，并在交付前独立核验。</p></div><Toggle label="开启严格证据核验" checked={data.settings.evidenceGrounding===true} onChange={evidenceGrounding=>settings({evidenceGrounding})}/></header><p className="help-text">核验沿用结果检查模型；相同要求、正文和有效来源的已通过记录可复用。缺少依据时保留具体缺口，核验明细可在事项详情查看。</p></section>
    {data.spendStatus?.error&&<p className="form-error">{data.spendStatus.error}</p>}
    {data.spendStatus?.scopes?.some(s=>s.key==='evaluation')&&<SpendControls data={data} scopeKey="evaluation" act={act}/>}
    <RecentModelCalls data={data}/>
    <QuickCaptureSettings act={act}/>
    <section className="settings-card"><header><div><h2><Zap size={19}/>人工事项的自动托管</h2><p>此开关用于未交给 Agent 的人工事项和收件箱整理。新建事项默认由 Agent 自动推进，无需开启此开关。</p></div><Toggle label="开启自动推进" checked={data.settings.automatic} onChange={automatic=>settings({automatic})}/></header><div className="automation-options"><label>检查间隔<select aria-label="自动推进间隔" value={data.settings.intervalMinutes} onChange={e=>settings({intervalMinutes:Number(e.target.value)})}>{[1,5,15,30,60,120].map(n=><option value={n} key={n}>每 {n} 分钟</option>)}</select></label></div><div className="setting-line"><div><strong>自动整理新材料</strong><p>先提取事项，再继续推进；已有事项会关联新的上下文。</p></div><Toggle label="自动整理新材料" checked={data.settings.autoExtract} onChange={autoExtract=>settings({autoExtract})}/></div><div className="setting-line"><div><strong>检查通过后自动完成</strong><p>关闭时，所有通过模型检查的结果都会等待你验收。</p></div><Toggle label="检查通过后自动完成" checked={data.settings.autoComplete} onChange={autoComplete=>settings({autoComplete})}/></div><div className="settings-note"><Clock3 size={16}/><p>关闭窗口后，桌面助手仍在菜单栏运行。退出应用或电脑休眠期间会停止推进；重新打开后继续。外部执行步骤需要你补充真实结果。</p></div>{data.settings.lastCycleAt&&<small className="last-cycle">上次自动轮次：{formatDate(data.settings.lastCycleAt)}</small>}</section>
    <section className="settings-card"><header><div><h2><BookOpen size={19}/>我的工作偏好</h2><p>告诉助手你的角色、工作习惯和产出要求。</p></div></header><textarea aria-label="我的工作偏好" rows={4} value={profile} onChange={e=>setProfile(e.target.value)} placeholder="例如：我是产品经理，优先推进本周的交付。产出先给结论，再列依据；不确定的信息要标注。"/><div className="settings-actions"><button className="button" onClick={()=>perform('settings',{profile},'工作偏好已保存')}>保存偏好</button></div></section>
    {desktop&&<section className="settings-card"><header><div><h2><FolderOpen size={19}/>本地材料文件夹</h2><p>每 5 分钟同步所选目录下的文本文件，新增和变化内容进入收件箱。</p></div><button className="button" onClick={()=>perform('chooseFolder')}><Plus size={15}/>添加文件夹</button></header>{data.folders.length?data.folders.map(f=><div className="folder-row" key={f.id}><FolderOpen size={18}/><div><strong>{f.name}</strong><small>{f.path}</small><small>{f.error||`上次同步：${formatDate(f.lastSyncedAt)}`}</small></div><button className="icon-button" aria-label={`取消同步 ${f.name}`} onClick={()=>perform('removeFolder',{id:f.id})}><X size={16}/></button></div>):<p className="muted">尚未选择文件夹。只读取所选目录，不读取子目录或符号链接。</p>}{data.folders.length>0&&<button className="text-button" onClick={()=>perform('syncFolders',{},'文件夹已同步')}><RefreshCw size={14}/>立即同步</button>}</section>}
  </div><aside className="settings-aside"><div className="privacy-card"><div className="section-icon"><ShieldCheck size={24}/></div><h3>你的工作，你来掌握</h3><p>材料、事项和产出存储在本机。推进时，会将相关内容发送给你选定的模型服务。</p><div className="aside-rule"/><h4>当前可自动完成</h4><ul><li><Check size={14}/>材料整理与事项拆解</li><li><Check size={14}/>分析、计划、文稿生成</li><li><Check size={14}/>结果检查与定时跟进</li></ul><h4>当前需要人工执行</h4><p>常规事项中的外部步骤需要补充真实结果。Agent 委托可自动保存文件、创建、更新并跟进 GitHub Issue，按授权发表评论；Agent 也可按委托权限运行代码、保存邮件草稿、生成图片和离线语音；Outlook 发信与 GitHub 工作流触发须逐次预览确认。</p></div><div className="storage-card"><h3>本地工作空间</h3><code>{data.storagePath}</code><button className="button" onClick={exportAll}><ArrowDownToLine size={15}/>导出数据（不含密钥）</button>{desktop&&<button className="text-button" onClick={()=>perform('openStorage')}>打开数据文件夹<ArrowUpRight size={14}/></button>}</div></aside></div>;
}
