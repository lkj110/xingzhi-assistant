import React,{useEffect,useState} from 'react';
import {Clock3,Pause,Play,ShieldCheck} from 'lucide-react';
import './stewardship.css';
const days=[1,2,3,4,5,6,0],dayNames=['周日','周一','周二','周三','周四','周五','周六'];
const when=(value,timeZone)=>value?new Date(value).toLocaleString('zh-CN',{timeZone,hour12:false}):'—';
function instant(value){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('请选择有效的恢复日期时间');
 const d=new Date(value),pad=n=>String(n).padStart(2,'0');
 const wall=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
 if(!Number.isFinite(d.getTime())||wall!==value)throw Error('该本机日期时间无效或处于夏令时跳过的时段，请重新选择');
 return d.toISOString();
}
export default function StewardshipPanel({data,act}){
 const policy=data.stewardship,status=data.stewardshipStatus;
 const [window,setWindow]=useState(policy?.window||{enabled:false,start:'09:00',end:'18:00'}),[weekdays,setWeekdays]=useState(policy?.weekdays||days);
 const [pauseUntil,setPauseUntil]=useState(''),[pauseRevision,setPauseRevision]=useState(status?.revision),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const selectedDays=JSON.stringify(policy?.weekdays||days);
 useEffect(()=>{setWindow(policy?.window||{enabled:false,start:'09:00',end:'18:00'});setWeekdays(policy?.weekdays||days);},[policy?.window?.enabled,policy?.window?.start,policy?.window?.end,selectedDays]);
 if(!policy||!status)return null;
 const localZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'本机时区',stale=!!pauseUntil&&pauseRevision!==status.revision;
 let selectedInstant;try{selectedInstant=pauseUntil?instant(pauseUntil):null;}catch{}
 async function save(event){event.preventDefault();setBusy(true);setError('');try{await act('stewardshipSettings',{window,weekdays},'托管策略已保存');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function pause(until=null){setBusy(true);setError('');try{await act('stewardshipPause',until?{until:instant(until),revision:pauseRevision}:{});setPauseUntil('');}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function toggle(){if(!policy.paused)return pause();setBusy(true);setError('');try{await act('stewardshipResume');setPauseUntil('');}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="settings-card stewardship-panel" aria-label="全局托管策略">
  <header><div><h2><ShieldCheck size={19}/>全局托管策略</h2><p>统一安排自动收集与事项推进的工作时间。</p></div><button className="button" disabled={busy} onClick={toggle}>{policy.paused?<Play size={15}/>:<Pause size={15}/>} {policy.paused?'恢复自动托管':'暂停自动托管'}</button></header>
  <div className={`stewardship-status ${status.reason?'held':''}`} role="status"><strong>{status.message}</strong>{status.pauseUntil&&<span><Clock3 size={14}/>解除全局暂停：{when(status.pauseUntil,policy.timeZone)} · {policy.timeZone}</span>}{status.nextAllowedAt&&<span><Clock3 size={14}/>预计继续：{when(status.nextAllowedAt,policy.timeZone)} · {policy.timeZone}</span>}{policy.paused&&data.operation&&<small>当前请求返回并保存断点后暂停；恢复时从已保存进度继续。</small>}</div>
  <div className="runtime-facts"><div><small>今日已使用 · {status.day}</small><strong>{status.used} 次</strong></div><div><small>费用控制</small><strong>每次推进累计核算</strong></div><div><small>固定工作时区</small><strong>{policy.timeZone}</strong></div></div>
  <form onSubmit={save} className="stewardship-form"><div className="form-row"><div className="stewardship-hours"><label className="connection-check"><input aria-label="限制自动工作时段" type="checkbox" checked={window.enabled} onChange={e=>setWindow(v=>({...v,enabled:e.target.checked}))}/>限制自动工作时段</label><div className="stewardship-time-inputs"><label>开始时间<input required type="time" aria-label="自动工作开始时间" disabled={!window.enabled} value={window.start} onChange={e=>setWindow(v=>({...v,start:e.target.value}))}/></label><span>至</span><label>结束时间<input required type="time" aria-label="自动工作结束时间" disabled={!window.enabled} value={window.end} onChange={e=>setWindow(v=>({...v,end:e.target.value}))}/></label></div><small>{window.enabled&&window.start>window.end?'结束时间为次日，跨夜时段归属开始日。例如勾选周五，22:00 至 06:00 会持续到周六早晨。':'时间范围按上方固定工作时区计算。'}</small></div></div>
   <fieldset className="stewardship-weekdays"><legend>自动工作星期（至少选择一天）</legend><div>{days.map(day=><label key={day}><input type="checkbox" aria-label={`自动工作${dayNames[day]}`} checked={weekdays.includes(day)} onChange={e=>setWeekdays(v=>e.target.checked?[...v,day]:v.filter(d=>d!==day))}/>{dayNames[day]}</label>)}</div><small>未限制时段时，按所选日期全天运行。修改星期或时段会取消已有定时恢复，暂停状态保留。</small></fieldset>
   <div className="stewardship-save"><button className="button primary" disabled={busy||!weekdays.length}>保存托管策略</button>{!weekdays.length&&<p className="form-error">至少选择一个工作星期</p>}</div></form>
  <div className="stewardship-pause" aria-label="定时暂停自动托管"><h3>暂停到指定时间</h3><label>恢复日期时间 · 本机时区 {localZone}<input type="datetime-local" aria-label="自动托管恢复日期时间" value={pauseUntil} onChange={e=>{setPauseUntil(e.target.value);setPauseRevision(status.revision);setError('');}}/></label>{selectedInstant&&<small>此时刻按工作时区显示为 {when(selectedInstant,policy.timeZone)} · {policy.timeZone}</small>}
   <p>到期只解除全局暂停；仍需处于工作星期和时段，并有可用费用额度。各项手动暂停继续保留。电脑休眠或 App 关闭时，待下次启动或唤醒后检查。</p>
   {stale&&<p className="form-error">托管策略已变化，请重新选择恢复日期时间。</p>}<div className="stewardship-pause-buttons"><button className="button" disabled={busy||!selectedInstant||stale} onClick={()=>pause(pauseUntil)}>暂停到所选时间</button>{policy.pauseUntil&&<button className="button" disabled={busy} onClick={()=>pause()}>改为无限期暂停</button>}</div>
  </div>{error&&<p className="form-error" role="alert">{error}</p>}
  <p className="muted">暂停或时段结束后，已开始的轮次会完成。手动点击推进、同步或模型检测可在暂停、休息日和时段外执行，每次推进仍受累计费用上限控制。失败的请求也计数，纯资料检查不调用模型。</p>
  <p className="muted">完整计量开始于 {when(policy.meteringStartedAt,policy.timeZone)}；重启、恢复备份与切换系统时区不会清空用量记录。恢复备份和停止全部工作会取消定时恢复。调用次数仅作统计，不限制任务长度，也不代表模型订阅余量。</p>
 </section>;
}
