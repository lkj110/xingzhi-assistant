const projectLifecycle=require('./project-lifecycle.cjs');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const briefing=require('./briefing.cjs');
const stewardship=require('./stewardship.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const now=()=>new Date().toISOString();
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function initialize(a){
  a.data.briefingSchedule ||= {revision:crypto.randomUUID(),enabled:false,folder:null,projectId:'',range:'7d',format:'md',cadence:'daily',time:'18:00',weekday:5,timeZone:a.data.stewardship?.timeZone||'UTC',nextRunAt:null,runs:[]};
  const s=a.data.briefingSchedule;s.runs ||= [];
  for(const r of s.runs)if(r.status==='running'){r.status='interrupted';r.error='上次保存中断，请重试核对同一文件';s.enabled=false;s.nextRunAt=null;s.error=r.error;}
}
function validate(a,input){
  if(!object(input)||typeof input.projectId!=='string'||input.projectId&&input.projectId!=='@independent'&&!a.data.projects.some(p=>p.id===input.projectId))throw new Error('请选择有效的简报项目范围');
  if(!['24h','7d','30d'].includes(input.range)||!['md','json'].includes(input.format)||!['daily','weekly'].includes(input.cadence)||typeof input.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)||!Number.isInteger(input.weekday)||input.weekday<0||input.weekday>6||typeof input.enabled!=='boolean')throw new Error('简报计划参数无效');
  if(typeof input.timeZone!=='string')throw new Error('请选择有效时区');
  try{stewardship.local(Date.now(),input.timeZone);}catch{throw new Error('简报时区无效');}
  return Object.fromEntries(['projectId','range','format','cadence','time','weekday','timeZone','enabled'].map(k=>[k,input[k]]));
}
function nextRun(s,after=Date.now()){
  const minute=Number(s.time.slice(0,2))*60+Number(s.time.slice(3));
  const today=stewardship.local(after,s.timeZone);
  // Actual minutes respect missing DST times; repeated wall times run once per local day.
  for(let at=Math.floor(after/60000)*60000+60000;at<=after+15*86400000;at+=60000){
    const p=stewardship.local(at,s.timeZone);
    if(p.minute!==minute||p.day===today.day&&today.minute>=minute)continue;
    if(s.cadence==='weekly'&&new Date(p.day+'T12:00:00Z').getUTCDay()!==s.weekday)continue;
    return new Date(at).toISOString();
  }
  throw new Error('未找到下一次简报时间，请重新设置');
}
function folder(s){
  if(!s.folder||fs.realpathSync(s.folder)!==s.folder||!fs.lstatSync(s.folder).isDirectory())throw new Error('简报目录已失效，请重新选择目录');
  const stat=fs.statSync(s.folder);
  if(s.folderIdentity&&s.folderIdentity!==`${stat.dev}:${stat.ino}`)throw new Error('简报目录已被替换，请重新选择目录');
  return s.folder;
}
function guard(a,input){if(input?.revision!==a.data.briefingSchedule.revision)throw new Error('简报计划已变化，请刷新后重试');}
function snapshot(a){const s=structuredClone(a.data.briefingSchedule);for(const r of s.runs)delete r.content;return {...s,modelCalls:0,networkRequests:0};}
function sanitize(state){if(state.briefingSchedule)for(const r of state.briefingSchedule.runs||[])delete r.content;}
function changeAndSave(a,change){
  const s=a.data.briefingSchedule,before=structuredClone(s),events=structuredClone(a.data.events);
  try{change(s);a.save();return snapshot(a);}
  catch(error){
    for(const key of Object.keys(s))delete s[key];Object.assign(s,before);a.data.events=events;
    // save() can fail after the workspace rename while persisting a secondary
    // ledger. Best-effort rollback keeps that committed workspace consistent too.
    try{a.save();}catch{}
    throw error;
  }
}
function setFolder(a,value){
  a.ensureIdle();const canonical=fs.realpathSync(value),stat=fs.lstatSync(canonical);
  if(!stat.isDirectory())throw new Error('请选择一个简报文件夹');
  if(a.data.folders.some(f=>f.path===canonical))throw new Error('请为简报选择独立目录，避免产出再次进入资料收集');
  return changeAndSave(a,s=>{s.folder=canonical;s.folderIdentity=`${stat.dev}:${stat.ino}`;s.enabled=false;s.nextRunAt=null;s.revision=crypto.randomUUID();s.error=null;});
}
function save(a,input){
  a.ensureIdle();guard(a,input);const config=validate(a,input),s=a.data.briefingSchedule;
  if(config.enabled){folder(s);if(s.runs.some(r=>['failed','interrupted','running'].includes(r.status)))throw new Error('请先核对或放弃失败的简报保存记录');}
  const next=config.enabled?nextRun(config):null;
  return changeAndSave(a,s=>Object.assign(s,config,{nextRunAt:next,revision:crypto.randomUUID(),error:null}));
}
function recordFile(s,r){
  const dir=folder(s);
  if(r.folder!==dir||r.folderIdentity!==s.folderIdentity)throw new Error('原简报目录授权已改变，无法重试该记录');
  if(typeof r.filename!=='string'||!/^行知简报-[0-9T-]+-[a-f0-9-]+\.(md|json)$/.test(r.filename))throw new Error('简报文件名无效');
  return path.join(dir,r.filename);
}
function verify(file,r){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>20_000_000||hash(fs.readFileSync(fd))!==r.hash)throw new Error('简报文件已被修改或未完整保存，请核对后放弃该记录');}
  finally{fs.closeSync(fd);}
}
function run(a,{retryId,scheduled=false}={}){
  const s=a.data.briefingSchedule;
  if(scheduled&&(!s.enabled||!stewardship.canAutomate(a)||a.data.projects.some(p=>p.id===s.projectId&&p.archivedAt)))return snapshot(a);
  let r=retryId?s.runs.find(r=>r.id===retryId):null;
  if(retryId&&(!r||!['failed','interrupted'].includes(r.status)))throw new Error('该记录当前无需重试');
  if(!r){
    if(s.runs.some(r=>['failed','interrupted','running'].includes(r.status)))throw new Error('请先核对或放弃失败的简报保存记录');
    folder(s);validate(a,s);
    const report=briefing.exportReport(a,{projectId:s.projectId,range:s.range,format:s.format});
    if(Buffer.byteLength(report.content)>20_000_000)throw new Error('简报超过 20 MB，请缩小项目或时间范围');
    const at=now(),id=crypto.randomUUID();
    r={id,at,slot:scheduled?s.nextRunAt:null,folder:s.folder,folderIdentity:s.folderIdentity,filename:`行知简报-${at.replace(/[:.Z]/g,'-')}-${id}.${s.format}`,hash:hash(report.content),content:report.content,status:'running',projectId:s.projectId,range:s.range,format:s.format};
    s.runs.unshift(r);s.runs=s.runs.slice(0,100);
  }else {r.status='running';r.error=null;}
  // Persist the exact planned body before touching the destination. A retry only
  // checks or writes this record, never a newly generated report with the same name.
  try{a.save();}catch(error){r.status='interrupted';r.error='保存计划未持久化，目标文件尚未写入；请重试核对原记录';s.error=r.error;s.enabled=false;s.nextRunAt=null;s.revision=crypto.randomUUID();throw error;}
  const plannedContent=r.content,previousEvents=structuredClone(a.data.events);
  try{
    if(a.data.folders.some(f=>f.path===s.folder))throw new Error('简报目录也被用作资料入口，请重新选择独立目录');
    const file=recordFile(s,r);
    if(typeof r.content!=='string'||hash(r.content)!==r.hash)throw new Error('待保存简报内容校验失败，请放弃该记录');
    let fd;
    try{fd=fs.openSync(file,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;verify(file,r);}
    if(fd!==undefined){try{fs.writeFileSync(fd,r.content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    verify(file,r);r.status='done';r.finishedAt=now();delete r.content;delete r.error;s.error=null;
    if(s.enabled)s.nextRunAt=nextRun(s);
    a.event('工作简报已保存',`${r.filename}，已回读核对内容`,null,'success');
  }catch(error){r.status='failed';r.error=error.code?'保存失败，请检查目录权限、磁盘空间及文件是否被替换':error.message;s.error=r.error;s.enabled=false;s.nextRunAt=null;a.event('工作简报保存需要处理',r.error,null,'warning');}
  try{a.save();}
  catch(error){
    // The file may already exist even though its final receipt did not persist.
    // Keep the exact body so this live process can retry by readback, too.
    r.status='interrupted';r.content=plannedContent;delete r.finishedAt;r.error='文件可能已保存，但回执未能持久化；请重试核对原文件';s.error=r.error;s.enabled=false;s.nextRunAt=null;s.revision=crypto.randomUUID();a.data.events=previousEvents;
    throw error;
  }
  return snapshot(a);
}
function tick(a){const s=a.data.briefingSchedule;if(!s?.enabled||a.data.projects.some(p=>p.id===s.projectId&&p.archivedAt)||!s.nextRunAt||Date.parse(s.nextRunAt)>Date.now()||a.operation||!stewardship.canAutomate(a))return false;a.launch('保存定时工作简报',()=>{try{return run(a,{scheduled:true});}catch(error){s.enabled=false;s.nextRunAt=null;s.error='定时简报未保存，请检查项目范围、目录及保存记录';a.event('工作简报保存需要处理',s.error,null,'warning');a.save();throw error;}});return true;}
function resultPath(a,id){const s=a.data.briefingSchedule,r=s.runs.find(r=>r.id===id&&r.status==='done');if(!r)throw new Error('成功的简报记录不存在');const file=recordFile(s,r);verify(file,r);return file;}
function retain(current,restored){restored.briefingSchedule=structuredClone(current.briefingSchedule);pause(restored);}
function pause(data){const s=data.briefingSchedule;if(s){s.enabled=false;s.nextRunAt=null;s.revision=crypto.randomUUID();for(const r of s.runs||[])if(r.status==='running')r.status='interrupted';}}
async function dispatch(a,action,input={}){
  if(action==='briefingScheduleSnapshot')return snapshot(a);
  a.ensureIdle();guard(a,input);
  if(action==='briefingScheduleSave')return save(a,input);
  if(action==='briefingScheduleRun'){const result=run(a);return result;}
  if(action==='briefingScheduleRetry')return run(a,{retryId:input.id});
  if(action==='briefingSchedulePause')return changeAndSave(a,()=>pause(a.data));
  if(action==='briefingScheduleDiscard'){
    const r=a.data.briefingSchedule.runs.find(r=>r.id===input.id);if(!r||!['failed','interrupted'].includes(r.status))throw new Error('该保存记录无需放弃');
    return changeAndSave(a,()=>{r.status='abandoned';r.finishedAt=now();delete r.content;a.data.briefingSchedule.error=null;a.event('已放弃简报保存重试','原目标文件保留，请根据需要人工处理');});
  }
  throw new Error('未知简报计划操作');
}
module.exports={initialize,snapshot,sanitize,setFolder,save,run,tick,nextRun,retain,pause,dispatch,resultPath};
