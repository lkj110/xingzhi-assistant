import CaptureDestination from './CaptureDestination';
import {IntakeCapabilities} from './CapabilitiesPage';
import ScreenshotInput,{ScreenshotPreview,pasteImages,serializeCaptureFiles} from './ScreenshotInput';
import React,{useEffect,useRef,useState} from 'react';
import {Inbox,Upload,X,Trash2,ArrowUpRight,Keyboard,PanelTop,Plus,SlidersHorizontal,Play} from 'lucide-react';
import {call} from './api';
import './quick-capture.css';
const supported=()=>!!window.assistant?.quickCaptureSupported;
const key=()=>crypto.randomUUID();
export function CapturePermissions({act=call}){
 const [status,setStatus]=useState(null),[error,setError]=useState('');
 async function refresh(){try{setStatus(await act('quickCaptureDetectionStatus'));}catch(e){setError(e.message);}}
 useEffect(()=>{if(!supported())return;refresh();const timer=setInterval(refresh,2500);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};},[]);
 async function grant(kind){try{setError('');setStatus(await act('quickCapturePermission',{kind}));}catch(e){setError(e.message);}}
 if(!supported())return null;
 return <section className="capture-permissions" aria-label="快速记录权限"><h3>选中文字，随手记为事项</h3><p>选区弹窗和截图入口默认开启。允许辅助功能后，在其他应用选中文字，会在鼠标旁出现一行工具栏，可选「新建事项」「补充事项」「智能归类」。</p><div><strong>{status?.selectionEnabled?(status.selectionRunning?'选区弹窗：已就绪':status.accessibilityTrusted?'选区弹窗：组件启动中':'选区弹窗：等待辅助功能授权'):'选区弹窗：已在设置中关闭'}</strong>{!status?.accessibilityTrusted&&<button className="button small" onClick={()=>grant('accessibility')}>授权辅助功能</button>}</div><div><strong>框选截图：{status?.screenshotEnabled?(status.screenshotRegistered?'⌘ ⇧ 2 已就绪':'快捷键未就绪'):'已关闭'}</strong>{status?.screenPermission!=='granted'&&<button className="button small" onClick={()=>grant('screen')}>检查屏幕录制权限</button>}</div><small>框选后自动带入小窗。系统截图可复制后粘贴；Sublime 等未提供选区接口的应用，拖选后点击工具栏会读取选中文字，并恢复原剪贴板。读取失败时可手动复制粘贴。内容在你点击推进或整理后才发送给模型。</small>{status?.selectionRunning&&<small>捕获状态：{({waiting:'等待选中文字',gesture_received:'已收到选择动作',selection_changed:'已收到选区变化',focus_unavailable:'当前应用未提供可读焦点',selection_unavailable:'当前应用不支持读取选区',selection_empty:'当前没有选中文字',selection_read:'已读取选中文字',draft_occupied:'正在编辑草稿；关闭小窗后仍可继续划词',popup_shown:'已显示记录弹窗',popup_failed:'弹窗显示失败',read_started:'正在读取选区',own_app:'当前位于行知助手',focus_changed:'选区所属窗口已切换',copy_candidate:'兼容模式：点击工具栏读取选区'})[status.captureDiagnostic?.stage]||'等待选中文字'} · 收到 {status.captureDiagnostic?.events||0} 次事件 · 尝试 {status.captureDiagnostic?.reads||0} 次读取 · 成功 {status.captureDiagnostic?.selections||0} 次</small>}{status?.captureError&&<p role="status">{status.captureError}</p>}{error&&<p className="form-error" role="alert">{error}</p>}</section>;
}
export function QuickCaptureSettings({act=call}){
 const [detection,setDetection]=useState(null);
 const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(){try{setState(await act('quickCaptureStatus'));setDetection(await act('quickCaptureDetectionStatus'));}catch(e){setError(e.message);}}
 useEffect(()=>{if(!supported())return;refresh();const timer=setInterval(refresh,2500);return()=>clearInterval(timer);},[]);
 if(!supported())return <section className="settings-card"><header><div><h2><Keyboard size={19}/>桌面快速收集</h2><p>安装桌面 App 后，可从托盘或全局快捷键打开独立收集小窗。</p></div></header></section>;
 async function detect(patch){setBusy(true);setError('');try{setDetection(await act('quickCaptureDetectionConfigure',patch));}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function configure(enabled){setBusy(true);setError('');try{setState(await act('quickCaptureConfigure',{enabled}));}catch(e){setError(e.message);await refresh();}finally{setBusy(false);}}
 return <section className="settings-card" aria-label="桌面快速收集设置"><header><div><h2><Keyboard size={19}/>桌面快速收集</h2><p>随时把文字和文件送入收集队列，工作台正在推进时也能打开。</p></div><button className="button" onClick={async()=>{try{await act('quickCaptureOpen');}catch(e){setError(e.message);}}}><PanelTop size={15}/>打开收集小窗</button></header><CapturePermissions act={act}/><label className="connection-check"><input type="checkbox" aria-label="启用全局快速收集快捷键" disabled={busy||!state} checked={!!state?.enabled&&!!state?.registered} onChange={event=>configure(event.target.checked)}/>启用全局快捷键 {state?.acceleratorLabel||'Cmd/Ctrl + Shift + Space'}</label><label className="connection-check"><input type="checkbox" aria-label="选中文字自动弹窗" disabled={busy} checked={!!detection?.selectionEnabled} onChange={e=>detect({selectionEnabled:e.target.checked})}/>选中文字后显示微型记录弹窗</label><label className="connection-check"><input type="checkbox" aria-label="启用截图快捷入口" disabled={busy} checked={!!detection?.screenshotEnabled} onChange={e=>detect({screenshotEnabled:e.target.checked})}/>截图快捷入口 {detection?.screenshotKey||'⌘ ⇧ 2'}</label>{detection?.selectionEnabled&&!detection?.selectionRunning&&<p className="help-text">需要在系统设置 → 隐私与安全性 → 辅助功能中允许行知助手。授权后点击<button className="text-button" onClick={refresh}>刷新状态</button>。不提供选区接口的应用会在点击工具栏后通过复制读取，并恢复原剪贴板。</p>}{detection?.captureError&&<p className="form-error">{detection.captureError}</p>}{(error||state?.error)&&<p className="form-error" role="alert">{error||state.error}</p>}<p className="help-text">选区弹窗和截图入口默认开启，可随时关闭。选中文字弹窗在鼠标或键盘选择结束后读取当前选区，在本机预览；点击保存或推进后才进入工作空间。截图使用本应用快捷键框选，完成后带入小窗；系统截图可复制后粘贴。不会持续读取剪贴板。</p></section>;
}
export default function QuickCaptureWindow(){
 const [destination,setDestination]=useState('auto'),[targetTaskId,setTargetTaskId]=useState(''),[sourceContext,setSourceContext]=useState({kind:'manual',capturedAt:new Date().toISOString()}),[sourceUrl,setSourceUrl]=useState(''),[sourceNote,setSourceNote]=useState(''),[suggestion,setSuggestion]=useState(null),[suggesting,setSuggesting]=useState(false),[suggestError,setSuggestError]=useState('');
 const suggestionSequence=useRef(0);
 const [sourceEdits,setSourceEdits]=useState({});
 const [selectionIntent,setSelectionIntent]=useState(null),expectationsRef=useRef(null),criteriaRef=useRef(null);
 const [goal,setGoal]=useState(''),[criteria,setCriteria]=useState(''),[capabilityIds,setCapabilityIds]=useState([]);
 const pendingIntent=useRef(null),loadedCapture=useRef(null),formRef=useRef(null),advanceButton=useRef(null),resumeAfterConfig=useRef(false);
 const [configPrompt,setConfigPrompt]=useState(false),[manualAllowed,setManualAllowed]=useState(false);
 const [state,setState]=useState(null),[title,setTitle]=useState(''),[content,setContent]=useState(''),[projectId,setProjectId]=useState(''),[files,setFiles]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[receipt,setReceipt]=useState(null),[autoRetry,setAutoRetry]=useState(false);
 const input=useRef(null),draft=useRef(key()),submitted=useRef(null),receiptId=useRef(null),editing=useRef(false),receiptSignature=useRef(''),mode=useRef(null);
 function change(setter,value){resumeAfterConfig.current=false;draft.current=key();setter(value);setError('');setMessage('');}
 function clear(keepReceipt=false){resumeAfterConfig.current=false;draft.current=key();setDestination('auto');setTargetTaskId('');setSuggestion(null);setSourceContext({kind:'manual',capturedAt:new Date().toISOString()});setSourceUrl('');setSourceNote('');setSourceEdits({});setTitle('');setProjectId('');setContent('');setFiles([]);setGoal('');setCriteria('');setCapabilityIds([]);setAutoRetry(false);setError('');setMessage('');submitted.current=keepReceipt===true?draft.current:null;if(input.current)input.current.value='';}
 function updateReceipt(next){
  if(!next)return;setReceipt(next);const signature=JSON.stringify(next);if(receiptSignature.current===signature)return;receiptSignature.current=signature;
  if(submitted.current!==draft.current)return;
  if(next.status==='completed'||next.imported&&mode.current!=='advance'&&next.targetKind!=='task'){
   if(submitted.current===draft.current){clear(true);}
   if(next.status==='failed'){setMessage(next.autoRetry?.enabled&&next.autoRetry?.nextRetryAt?`材料已保存，已安排 ${new Date(next.autoRetry.nextRetryAt).toLocaleString('zh-CN')} 后自动重试。`:'材料已保存，后续整理未完成。');setError(next.error||'整理失败，请重试剩余步骤。');}
   else setMessage(next.advanceMessage|| (next.status==='completed'?`材料已保存${next.organize?'并完成本次整理':''}。`:'材料已导入，后续整理正在处理。'));
  }else if(next.status==='queued')setMessage('材料已加入持久队列，导入成功后自动清空本次草稿。');
  else if(next.status==='failed'||next.status==='missing')setError(next.error||'收集未完成，草稿与队列材料已保留。');
 }
 async function refresh(){try{const queried=receiptId.current;const result=await call('quickCaptureState',queried?{receiptId:queried}:{});setState(result);if(!editing.current&&queried===receiptId.current)updateReceipt(result.receipt);}catch(e){setError(e.message);}}
 useEffect(()=>{refresh();const unsubscribe=window.assistant?.onQuickCaptureChange?.(refresh);const timer=setInterval(refresh,1200);const escape=event=>{if(event.key==='Escape')call('quickCaptureHide').catch(e=>setError(e.message));};document.addEventListener('keydown',escape);return()=>{unsubscribe?.();clearInterval(timer);document.removeEventListener('keydown',escape);};},[]);
 useEffect(()=>{if(state?.advanceAvailable&&resumeAfterConfig.current){resumeAfterConfig.current=false;setConfigPrompt(false);formRef.current?.requestSubmit(advanceButton.current);}},[state?.advanceAvailable]);
 const hasDraft=!!(title||content||files.length||goal||criteria||capabilityIds.length||projectId||sourceUrl||sourceNote||targetTaskId);
 const pendingCapture=state?.captureContext&&loadedCapture.current!==state.captureContext.id?state.captureContext:null;
 async function loadCapture(){
  const captured=state?.captureContext;if(!captured||loadedCapture.current===captured.id||captured.requiresCopy)return;
  if(captured.text&&(content.length+captured.text.length+3000>200000)){setError('合并后文字过长，请先保存当前草稿');return;}
  if(captured.image&&(files.length>=10||files.reduce((sum,file)=>sum+file.size,0)+captured.image.base64.length*3/4>25000000)){setError('合并后文件过多或超过25 MB，请先保存当前草稿');return;}
  loadedCapture.current=captured.id;draft.current=key();
  if(!hasDraft&&pendingIntent.current?.id===captured.id){const intent=pendingIntent.current.intent;setDestination(intent==='new'?'new':intent==='supplement'?'task':'auto');setSelectionIntent(intent);}
  pendingIntent.current=null;
  if(captured.targetTaskId){setDestination('task');setTargetTaskId(captured.targetTaskId);}
  if(captured.text&&!content||captured.image&&!content&&!files.length){setSourceContext(captured.provenance||{kind:captured.image?'screenshot':'selection',capturedAt:new Date().toISOString()});if(!sourceEdits.url)setSourceUrl(captured.provenance?.url||'');if(!sourceEdits.note)setSourceNote(captured.provenance?.note||'');}
  if(captured.text){const origin=[captured.provenance?.appName,captured.provenance?.windowTitle,captured.provenance?.url,captured.provenance?.capturedAt].filter(Boolean).join(' · ');setContent(old=>old?old+'\n\n【补充材料'+(origin?'｜'+origin:'')+'】\n'+captured.text:captured.text);}
  if(captured.image){const bytes=Uint8Array.from(atob(captured.image.base64),c=>c.charCodeAt(0));setFiles(old=>[...old,Object.assign(new File([bytes],captured.image.title,{type:'image/png'}),{captureProvenance:captured.provenance||{kind:'screenshot',capturedAt:new Date().toISOString()}})]);}
  try{setState(await call('quickCaptureConsume',{id:captured.id}));}catch(e){setError(e.message);}
 }
 useEffect(()=>{if(state?.captureVisible&&!state.mini&&pendingCapture&&!hasDraft&&!pendingCapture.requiresCopy)loadCapture();},[state?.mini,state?.captureVisible,state?.captureContext?.id,hasDraft]);
 async function chooseSelection(intent){if(busy)return;setBusy(true);pendingIntent.current={id:state.captureContext?.id,intent};try{setError('');setState(await call(state.captureContext?.requiresCopy?'quickCaptureResolve':'quickCaptureExpand',{id:state.captureContext?.id}));}catch(e){pendingIntent.current=null;setError(e.message);await refresh();}finally{setBusy(false);}}
 async function dismissCapture(){try{pendingIntent.current=null;setState(await call('quickCaptureConsume',{id:pendingCapture.id}));}catch(e){setError(e.message);}}
 useEffect(()=>{
  if(!selectionIntent||state?.mini||!content)return;
  setSelectionIntent(null);
  if(selectionIntent==='expectations'){if(expectationsRef.current)expectationsRef.current.open=true;criteriaRef.current?.focus();}
  else if(selectionIntent==='supplement')document.querySelector('[aria-label="补充目标事项"]')?.focus();
 },[selectionIntent,state?.mini,content]);
 useEffect(()=>{call('quickCaptureDraft',{occupied:!!(title||content||files.length||goal||criteria||capabilityIds.length||projectId||sourceUrl||sourceNote||targetTaskId)}).catch(()=>{});},[title,content,files.length,goal,criteria,capabilityIds.length,projectId,sourceUrl,sourceNote,targetTaskId]);
 const provenance={...sourceContext,url:sourceUrl,note:sourceNote};
 async function fileItems(){
  const selected=[...files],fields={...(sourceEdits.url?{url:sourceUrl}:{}),...(sourceEdits.note?{note:sourceNote}:{})};
  const items=await serializeCaptureFiles(selected);
  if(!Object.keys(fields).length)return items;
  return items.map(item=>item.provenance!==undefined&&item.provenance!==null&&(typeof item.provenance!=='object'||Array.isArray(item.provenance))?item:{...item,provenance:{...(item.provenance||{kind:'file'}),...fields}});
 }
 useEffect(()=>{
  const sequence=++suggestionSequence.current;setSuggestion(null);setSuggestError('');
  if(state?.mini||(!content.trim()&&!files.length)){setSuggesting(false);return;}
  setSuggesting(true);const timer=setTimeout(async()=>{try{const items=await fileItems();const result=await call('quickCaptureSuggest',{text:content,items,provenance});if(sequence===suggestionSequence.current)setSuggestion(result);}catch(e){if(sequence===suggestionSequence.current)setSuggestError(e.message);}finally{if(sequence===suggestionSequence.current)setSuggesting(false);}},600);
  return()=>{clearTimeout(timer);suggestionSequence.current++;};
 },[content,files,sourceUrl,sourceNote,sourceEdits,sourceContext,state?.mini]);
 const resolvedTarget=destination==='new'?{kind:'new'}:destination==='task'?(targetTaskId?{kind:'task',taskId:targetTaskId}:null):suggestion?.recommendation==='task'?{kind:'task',taskId:suggestion.taskId}:suggestion?.recommendation==='new'?{kind:'new'}:null;
 const supplement=resolvedTarget?.kind==='task',selectedTask=state?.tasks?.find(t=>t.id===resolvedTarget?.taskId);
 const capabilityScope=supplement?selectedTask?.capabilityScope:state?.projects?.find(p=>p.id===projectId)?.capabilityScope;
 function addFiles(incoming){
  const selected=[...incoming];if(files.length+selected.length>10){setError('一次最多10份文件');return;}
  if(selected.some(file=>file.size>10000000||!file.size)){setError('单份文件须为非空且最多10 MB');return;}
  if(selected.some(file=>!['txt','md','csv','json','pdf','docx','png','jpg','jpeg'].includes(file.name.split('.').at(-1)?.toLowerCase()))){setError('支持TXT、MD、CSV、JSON、PDF、DOCX及PNG/JPG/JPEG图片');return;}
  if([...files,...selected].reduce((sum,file)=>sum+file.size,0)>25000000){setError('本次文件合计最多25 MB');return;}
  change(setFiles,[...files,...selected]);
 }
 async function submit(event){
  event.preventDefault();if(busy)return;if(pendingCapture){setError('请先选择加入或忽略新捕获的内容');return;}const action=event.nativeEvent.submitter?.value||'advance',advance=action==='advance',organize=action==='organize';if(!resolvedTarget){setError('请先选择新建事项或要补充的已有事项');return;}if(advance&&!state?.advanceAvailable){setConfigPrompt(true);return;}setBusy(true);editing.current=true;setError('');setMessage('');if(mode.current!==null&&mode.current!==action)draft.current=key();mode.current=action;const requestId=draft.current;submitted.current=requestId;receiptSignature.current='';
  try{
   const items=await fileItems();
   const textItems=content.trim()?[{title:title.trim()||content.trim().split('\n')[0].slice(0,80),content}]:[];
   const result=await call('quickCaptureSubmit',{requestId,items,textItems,provenance,target:{...resolvedTarget,...(supplement&&!advance&&(goal||criteria)?{note:[goal,criteria].filter(Boolean).join('\n')}: {})},projectId:supplement?selectedTask?.projectId||null:projectId||null,organize:supplement?false:organize,...(advance?{advancement:{infer:true,goal,criteria,capabilityIds:capabilityScope?.inherited?[]:capabilityIds}}:{}),autoRetry:organize&&autoRetry});setState(result.state);if(result.accepted){
    // The durable queue now owns this material, even while another job is busy.
    if(draft.current===requestId){clear();receiptId.current=null;receiptSignature.current='';setReceipt(null);}
   }else{receiptId.current=result.receipt.id;updateReceipt(result.receipt);if(result.warning)setError(result.warning);}
  }catch(e){setError(e.message);}finally{setBusy(false);editing.current=false;}
 }
 const queued=receipt&&submitted.current===draft.current&&['queued','processing'].includes(receipt.status),empty=!content.trim()&&!files.length;
 if(state?.mini)return <main className="selection-toolbar" aria-busy={busy} title={state.captureContext?.requiresCopy?'兼容模式：点击后读取选中文字，并恢复原剪贴板':undefined} role="toolbar" aria-label="选中文字快捷操作"><span className="selection-grip" aria-hidden="true">⠿</span><button disabled={busy} title="从选中文字新建事项" onClick={()=>chooseSelection('new')}><Plus size={16}/>新建事项</button><span className="selection-divider"/><button disabled={busy} title="补充推进中的已有事项" onClick={()=>chooseSelection('supplement')}><SlidersHorizontal size={16}/>补充事项</button><button disabled={busy} className="selection-advance" title="推荐新建或补充到相关事项" onClick={()=>chooseSelection('auto')}><Play size={15}/>智能归类</button></main>;
 return <main className="quick-capture-window"><header><Inbox size={25}/><div><h1>快速记录事项</h1><p>新建事项，或给正在推进的事项补充信息。</p></div><button className="icon-button" aria-label="隐藏快速收集窗口" onClick={()=>call('quickCaptureHide').catch(e=>setError(e.message))}><X size={18}/></button></header><form ref={formRef} onSubmit={submit} onPaste={event=>pasteImages(event,addFiles,busy)}><div className="quick-capture-body form-stack">
  {pendingCapture&&<section className="quick-capture-info" aria-label="新捕获内容"><strong>{hasDraft?'原草稿已保留，新内容尚未加入':'新捕获内容'}</strong><p>{pendingCapture.text?.slice(0,160)||pendingCapture.image?.title||(pendingCapture.targetTaskId?'已选择新的补充事项':'点击读取选中文字')}</p>{hasDraft&&<p>可加入当前草稿，或先清空草稿再使用新内容。关闭窗口不会关闭划词功能。</p>}<button type="button" className="button small" disabled={busy} onClick={()=>pendingCapture.requiresCopy?chooseSelection('auto'):loadCapture()}>{pendingCapture.requiresCopy?'读取新选区':pendingCapture.targetTaskId?'使用指定事项作为补充目标':'加入当前草稿'}</button><button type="button" className="text-button" disabled={busy} onClick={dismissCapture}>忽略这次捕获</button></section>}{state?.automatic?.allowed===false&&<p className="quick-capture-info">材料仍可保存入队。{state.automatic.message}{state.automatic.nextAllowedAt&&<>；预计 {new Date(state.automatic.nextAllowedAt).toLocaleString('zh-CN')} 后继续</>}</p>}
  {state?.busy&&<p className="quick-capture-info">工作台正在处理事项，本次材料会安全排队。</p>}
  <CaptureDestination disabled={busy||queued} mode={destination} onMode={value=>change(setDestination,value)} taskId={targetTaskId} onTask={value=>change(setTargetTaskId,value)} tasks={state?.tasks||[]} suggestion={suggestion} loading={suggesting} error={suggestError}/>
  {supplement&&<p className="quick-capture-info">将补充到「{selectedTask?.title||'所选事项'}」，保留原计划和来源，沿用原委托与累计额度。{selectedTask?.status==='paused'?'该事项已暂停，保存后需恢复才会继续。':''}</p>}
  <details className="capture-options"><summary>信息来源 · {sourceContext.appName||({selection:'选中文字',screenshot:'截图',manual:'手动输入',paste:'粘贴',file:'导入文件'})[sourceContext.kind]}{sourceContext.windowTitle?` · ${sourceContext.windowTitle}`:''}</summary><p className="help-text">采集时间：{new Date(sourceContext.capturedAt).toLocaleString('zh-CN')}。能读取时自动记录来源应用、窗口与链接；无法读取的来源可手动补充。</p><p className="help-text">手动修改的链接和说明用于本次所有材料；未修改的字段保留各文件自己的来源。</p><label>来源链接<input aria-label="快速收集来源链接" value={sourceUrl} maxLength={2000} onChange={e=>{setSourceEdits(previous=>({...previous,url:true}));change(setSourceUrl,e.target.value);}} placeholder="可选，原文或消息链接"/></label><label>来源说明<input aria-label="快速收集来源说明" value={sourceNote} maxLength={500} onChange={e=>{setSourceEdits(previous=>({...previous,note:true}));change(setSourceNote,e.target.value);}} placeholder="例如：某会议、群聊或联系人"/></label></details>
  <details className="capture-options"><summary>标题与所属项目（可选）</summary><label>所属项目<select aria-label="快速收集所属项目" disabled={busy||supplement} value={projectId} onChange={event=>change(setProjectId,event.target.value)}><option value="">按规则归类，未匹配保留独立</option>{state?.projects.map(project=><option key={project.id} value={project.id} disabled={project.archived}>{project.name}{project.archived?'（已归档）':''}</option>)}</select></label>
  <label>标题<input aria-label="快速收集标题" disabled={busy} maxLength={300} value={title} onChange={event=>change(setTitle,event.target.value)} placeholder="可选，留空使用正文首行"/></label>
  </details><label>文字材料<textarea aria-label="快速收集正文" autoFocus disabled={busy} rows={3} maxLength={200000} value={content} onChange={event=>change(setContent,event.target.value)} placeholder="主动粘贴文字、想法或待办要求"/></label>
  <IntakeCapabilities data={{capabilities:state?.capabilities}} value={capabilityIds} scope={capabilityScope} disabled={busy||queued} onChange={value=>change(setCapabilityIds,value)}/>
  <details ref={expectationsRef} className="capture-options"><summary>补充目标和预期（可选）</summary><label>希望推进什么<textarea aria-label="快速记录目标" disabled={busy} rows={2} maxLength={7000} value={goal} onChange={e=>change(setGoal,e.target.value)} placeholder="例如：梳理这段需求涉及的任务，并安排下一步"/></label><label>预期结果与推进要求<textarea ref={criteriaRef} aria-label="快速记录预期结果" disabled={busy} rows={2} maxLength={2000} value={criteria} onChange={e=>change(setCriteria,e.target.value)} placeholder="例如：生成一页交接说明；突出最终输出节点；遇到权限缺口列出并继续"/></label><p className="help-text">{supplement?'沿用原事项授权和累计额度；新增信息不会扩大权限。':projectId?'补充项目后沿用原委托的授权和累计额度。暂停的委托或规则需在主窗口恢复。':'推进使用已配置模型和本次材料；选择的能力可读取仓库资料或运行检查。不会自动获得网页、其他本地目录或外部写入权限。一次推进全过程共用 $100 等值上限，最终结果由你验收。'}</p></details><p className="help-text">只需正文或文件，标题、背景、目标和步骤由 Agent 填写。关键缺口才需要你补充。</p><ScreenshotInput addFiles={addFiles} disabled={busy} onBusy={setBusy} onError={setError}/><ScreenshotPreview files={files}/>
  <div className="quick-capture-drop" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(!busy)addFiles(event.dataTransfer.files);}}><Upload size={20}/><button className="text-button" type="button" disabled={busy} onClick={()=>input.current.click()}>选择文件，或拖到这里</button><small>PDF · DOCX · TXT · MD · CSV · JSON · PNG · JPG · JPEG<br/>最多10份，每份10 MB，本次合计25 MB</small><input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg" aria-label="快速收集文件" onChange={event=>{addFiles(event.target.files);event.target.value='';}}/></div><small>图片在本机识别中英文，边长最多 10000 像素、合计 2500 万像素。扫描 PDF 最多识别 20 个无文字页。选择整理后，识别文字会交给所选模型；原图和 PDF 原文件不上传。</small>
  {files.map((file,index)=><div className="file-chip" key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" disabled={busy} className="icon-button" aria-label={`移除快速收集文件 ${file.name}`} onClick={()=>change(setFiles,files.filter((_,i)=>i!==index))}><X size={13}/></button></div>)}
  {!projectId&&!supplement&&<label className="connection-check"><input type="checkbox" aria-label="快速收集自动重试" checked={autoRetry} disabled={busy} onChange={event=>change(setAutoRetry,event.target.checked)}/>临时服务故障自动重试（仅保存并整理，最多3次）</label>}
  {configPrompt&&!state?.advanceAvailable&&<section className="quick-capture-info" aria-label="连接 Agent 提醒"><strong>请先连接模型，才能自动整理和推进</strong><p>草稿会保留。连接模型并补齐三个角色后，这次提交会自动继续。</p><button type="button" className="button primary" onClick={async()=>{resumeAfterConfig.current=true;try{await call('quickCaptureOpenMain',{page:'settings'});}catch(e){resumeAfterConfig.current=false;setError(e.message);}}}>去连接模型</button><button type="button" className="text-button" onClick={()=>{resumeAfterConfig.current=false;setManualAllowed(true);setConfigPrompt(false);}}>暂不配置，仅保存材料</button></section>}
  {error&&<p className="form-error" role="alert">{error}</p>}{message&&<p className="quick-capture-info" role="status">{message}</p>}
  {receipt?.status==='failed'&&<button type="button" className="button small" disabled={busy||state?.busy} onClick={async()=>{setBusy(true);setError('');try{const result=await call('quickCaptureRetry',{receiptId:receipt.id});setState(result.state);updateReceipt(result.receipt);}catch(e){setError(e.message);}finally{setBusy(false);}}}>重试剩余步骤</button>}
  <p className="help-text">提交成功后自动收起，App 在后台排队并推进；需要补充或确认时到工作台查看。手动关闭小窗会保留草稿，仍可继续划词；新内容需确认后加入。退出应用会清除尚未入队的草稿。已入队的材料保存在本机，后续失败可在收集队列重试。</p>
 </div><footer><div className="quick-capture-actions"><button className="text-button" type="button" disabled={busy||!hasDraft} onClick={clear}><Trash2 size={14}/>清空草稿</button><button className="text-button" type="button" onClick={()=>call('quickCaptureOpenMain',{page:receipt?.jobId||receipt?.taskId?'board':'capture'}).catch(e=>setError(e.message))}>{receipt?.jobId||receipt?.taskId?'查看事项进展':'查看收集队列'}<ArrowUpRight size={14}/></button></div><div className="quick-capture-save">{!projectId&&!supplement&&<button className="button" type="submit" value="organize" disabled={busy||!!pendingCapture||empty||queued||!state?.organizeAvailable||!resolvedTarget}>{files.some(file=>/\.(png|jpe?g)$/i.test(file.name))?'识别并转事项':'保存并整理'}</button>}{(state?.advanceAvailable||manualAllowed||supplement)&&<button className="button" type="submit" value="save" disabled={busy||!!pendingCapture||empty||queued||!state||!resolvedTarget}>{busy?'正在保存…':queued?'已入队，等待处理':supplement?'仅补充材料':'仅保存材料'}</button>}<button ref={advanceButton} className="button primary" type="submit" value="advance" disabled={busy||!!pendingCapture||empty||queued||!state||!resolvedTarget}>{supplement?'补充并继续':destination==='task'?'请选择补充事项':destination==='auto'&&suggestion?.recommendation==='choose'?'请选择事项用途':'新建并推进'}</button></div></footer></form></main>;
}
