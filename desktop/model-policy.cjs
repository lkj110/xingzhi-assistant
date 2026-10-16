const {modelError,cancelledError}=require('./model-errors.cjs');
// Zero disables a deadline. A quiet model can be thinking, so this is a user
// controlled waiting limit, not a claim that the server has stopped working.
function normalize(value={}) {
  const result={idleMinutes:15,totalMinutes:0,retries:0};
  for(const key of Object.keys(result))if(value?.[key]!==undefined){
    const n=Number(value[key]),max=key==='retries'?1:1440;
    if(!Number.isFinite(n)||n<0||n>max||!Number.isInteger(n))throw modelError('MODEL_CONFIG','等待时间须为 0–1440 分钟，自动重试只能为 0 或 1 次。',false);
    result[key]=n;
  }
  return result;
}
function timeoutError(kind) {
  return Object.assign(modelError('MODEL_TIMEOUT',kind==='idle'?'模型超过设定时间没有返回新数据。已保存的章节会保留，可继续等待更久或从未完成章节续跑。':'模型达到你设置的总等待时间。已保存的章节会保留，可调整设置后续跑。'),{timeoutKind:kind});
}
function watch({signal,idleMs=0,totalMs=0,onProgress}={}) {
  const controller=new AbortController();let idle,total,closed=false;
  const expire=kind=>{if(!closed&&!controller.signal.aborted)controller.abort(timeoutError(kind));};
  const touch=()=>{if(closed)return;clearTimeout(idle);if(idleMs>0)idle=setTimeout(()=>expire('idle'),idleMs);onProgress?.({lastActivityAt:new Date().toISOString()});};
  const abort=()=>controller.abort(cancelledError());
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  if(totalMs>0)total=setTimeout(()=>expire('total'),totalMs);
  touch();
  return {signal:controller.signal,touch,close(){closed=true;clearTimeout(idle);clearTimeout(total);signal?.removeEventListener('abort',abort);}};
}
function backoff(signal,ms=1000){return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(cancelledError());
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(cancelledError());};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});
});}
module.exports={normalize,timeoutError,watch,backoff};
