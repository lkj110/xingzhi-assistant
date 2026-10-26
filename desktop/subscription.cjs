const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = process.platform==='win32'?require('./windows-process.cjs'):require('node:child_process');
const {normalizeModelError,modelError,transportError,cancelledError,httpError,preflightError} = require('./model-errors.cjs');
const policy = require('./model-policy.cjs');
const protocol = require('./subscription-protocol.cjs');

const builtin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const maxInputChars=1048576; // Codex exec turn/start input limit, verified locally.
function inputSizeError(actualChars,maxChars=maxInputChars){
 return Object.assign(modelError('MODEL_CONFIG',`本轮输入超过订阅 CLI 的 ${maxChars} 字符上限，请分批读取材料后继续；已有进度已保留。`,false),{diagnostic:{source:'codex_cli',kind:'input_too_large',actualChars,maxChars,inputPolicyVersion:require('./model-input.cjs').POLICY_VERSION}});
}
function inputFailure(output){
 const match=String(output||'').match(/(?:^|\n)Error: turn\/start: turn\/start failed: Input exceeds the maximum length of (\d+) characters\.[^\n]*?"actual_chars"\s*:\s*(\d+)/);
 return match?inputSizeError(Number(match[2]),Number(match[1])):null;
}
function classifyFailure(error={}) {
  if(typeof error==='string')error={message:error};
  const normalized=normalizeModelError(error);
  if(normalized.code!=='MODEL_FAILED')return normalized;
  const code=String(error?.code||''),message=String(error?.message||'');
  if(['context_length_exceeded','context_window_exceeded'].includes(code)||/exceeds? (?:the )?(?:model.s? )?context (?:window|length)|maximum context length/i.test(message))return Object.assign(modelError('MODEL_CONFIG','本次材料超过模型上下文上限，请缩小本轮引用材料后继续；已有资料已保存。',false),{contextOverflow:true});
  if(['insufficient_quota','usage_limit_reached','quota_exceeded'].includes(code)||/you.ve hit your usage limit|usage limit reached/i.test(message))return modelError('MODEL_QUOTA','订阅模型额度已用完，请等待额度恢复后继续；已有进度已保存。',false);
  if(['invalid_api_key','token_expired','authentication_error'].includes(code))return modelError('MODEL_AUTH','订阅登录已失效，请在模型设置中重新检测登录后继续。',false);
  if(['model_not_found','unsupported_model'].includes(code))return modelError('MODEL_CONFIG','当前订阅无法使用这个模型，请重新检测并选择可用模型。',false);
  if(['server_error','service_unavailable','overloaded_error'].includes(code))return httpError(503);
  if(code==='rate_limit_exceeded')return httpError(429);
  if(['stream_disconnected','connection_error'].includes(code)||/^stream disconnected before completion:|^error sending request for url \(/i.test(message))return transportError();
  return modelError('MODEL_CLI','订阅模型未完成本次请求，已有进度已保留。',true);
}
function cliFailure(error={}) {
  const classified=classifyFailure(error);
  // CLI JSON is untrusted, including objects bearing our own error codes. Never
  // retain its message, dispatch flags, retry/repair proofs or arbitrary fields.
  const hints={MODEL_CANCELLED:'操作已停止',MODEL_AUTH:'订阅登录已失效，请在模型设置中重新检测登录后继续。',MODEL_CONFIG:'订阅模型配置无效，请检查模型与输入设置后继续。',MODEL_QUOTA:'订阅模型额度已用完，请等待额度恢复后继续；已有进度已保存。',MODEL_BLOCKED:'模型服务拦截了本次请求，已停止自动推进。',MODEL_TIMEOUT:'模型请求超时，请稍后重试或检查服务。',MODEL_NETWORK:'无法连接模型服务，请检查服务地址和网络。'};
  const result=modelError(classified.code,hints[classified.code]||'订阅模型未完成本次请求，已有进度已保留。',classified.automaticRetry===true);
  // Derive this flag from the documented CLI failure, never its arbitrary fields.
  if(['context_length_exceeded','context_window_exceeded'].includes(String(error?.code||''))||/exceeds? (?:the )?(?:model.s? )?context (?:window|length)|maximum context length/i.test(String(error?.message||'')))result.contextOverflow=true;
  if(classified.code==='MODEL_HTTP'&&Number.isInteger(classified.httpStatus)&&classified.httpStatus>=400&&classified.httpStatus<=599)result.httpStatus=classified.httpStatus;
  result.diagnostic={source:'codex_cli',kind:'turn_failed',fingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify(error)).digest('hex').slice(0,16)};return result;
}
function incomplete(code,completed){return Object.assign(modelError('MODEL_CLI','订阅模型连接提前结束，已有进度已保留。',true),{diagnostic:{source:'codex_cli',kind:completed?'process_exit':'incomplete_stream',exitCode:Number.isInteger(code)?code:null}});}
function executable() {
  const dirs=process.platform==='win32'?require('./host-process.cjs').directories():String(process.env.PATH||'').split(path.delimiter).filter(Boolean),target=process.arch==='arm64'?'aarch64-pc-windows-msvc':'x86_64-pc-windows-msvc';
  const candidates=process.platform==='win32'?[...dirs.map(p=>path.join(p,'codex.exe')),...dirs.flatMap(p=>['codex','codex-win32-'+process.arch].map(pkg=>path.join(p,'node_modules','@openai',pkg,'vendor',target,'codex','codex.exe'))),...require('./codex-desktop.cjs').candidates()]:[builtin,...dirs.map(p=>path.join(p,'codex'))];
  for (const file of candidates) try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  throw modelError('MODEL_CONFIG','未找到 Codex CLI。请安装并用 ChatGPT 账号登录 Codex，再点击检测。',false);
}
function environment() {
  const env={};for(const key of ['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','PATHEXT','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];return env;
}
// File metadata and public configuration only: never open auth.json, keychains,
// provider keys, or the CLI's login output to build a health identity.
function identity() {
  const hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let cli;
  try {const bin=executable(),real=fs.realpathSync(bin),s=fs.statSync(real);cli={pathHash:hash(bin),realpathHash:hash(real),dev:s.dev,ino:s.ino,mtime:s.mtimeMs,ctime:s.ctimeMs,size:s.size,mode:s.mode};}
  catch {cli=null;}
  const env=environment(),home=env.CODEX_HOME||path.join(env.HOME||os.homedir(),'.codex');
  const metadata=file=>{try{const s=fs.statSync(file);return {realpathHash:hash(fs.realpathSync(file)),dev:s.dev,ino:s.ino,mtime:s.mtimeMs,ctime:s.ctimeMs,size:s.size};}catch(error){return {code:['ENOENT','EACCES','EPERM'].includes(error.code)?error.code:'unavailable'};}};
  // Config metadata invalidates even edits of preferences not parsed by status.
  // Environment values (including credential-bearing proxy URLs) are hash-only.
  // Model discovery cache is display data, not login or invocation identity.
  const config=metadata(path.join(home,'config.toml'));
  return {cliHash:cli?hash(cli):null,configurationHash:config.code&&config.code!=='ENOENT'?null:hash({env,config})};
}
function processCall(bin, args, {cwd, input, signal, timeoutMs = 15000, idleTimeoutMs = 0, onLine, onProgress, onClose} = {}) {
  return new Promise((resolve, reject) => {
    const clock=()=>require('node:perf_hooks').performance.now(),started=clock();let lastActivity=started,stderrBytes=0,terminationRequested=false;
    let output = '', pending = '', bytes = 0, failure, hardKill, idleTimer,child;
    const closed=(state,exitCode,exitSignal)=>onClose?.({state,exitCode,signal:exitSignal,durationMs:Math.max(0,Math.round(clock()-started)),idleMs:Math.max(0,Math.round(clock()-lastActivity)),stdoutBytes:bytes,stderrBytes,terminationRequested,errorCode:failure?.code,timeoutKind:failure?.timeoutKind});
    try{signal?.throwIfAborted();child=spawn(bin,args,{cwd,env:environment(),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});}
    catch(error){failure=error;closed(signal?.aborted?'not_started':'spawn_failed');reject(error);return;}
    const decoder=new (require('node:string_decoder').StringDecoder)('utf8');
    const terminate=signal=>{if(process.platform==='win32')require('./host-process.cjs').terminate(child,signal);else try{process.kill(-child.pid,signal);}catch{}};
    const kill = () => {if(!terminationRequested){terminationRequested=true;hardKill=setTimeout(()=>terminate('SIGKILL'),1500);terminate('SIGTERM');}};
    const abort = () => { failure ||= cancelledError(); kill(); };
    signal?.addEventListener('abort', abort, {once:true});
    const timer = timeoutMs > 0 ? setTimeout(() => { failure ||= policy.timeoutError('total'); kill(); }, timeoutMs) : null;
    const activity = () => {
      clearTimeout(idleTimer);
      lastActivity=clock();
      if (idleTimeoutMs > 0) idleTimer = setTimeout(() => { failure ||= policy.timeoutError('idle'); kill(); }, idleTimeoutMs);
      onProgress?.({lastActivityAt:new Date().toISOString()});
    };
    activity();
    child.stdout.on('data', chunk => {
      activity();
      bytes += chunk.length;
      if (bytes > 4_000_000) { failure ||= modelError('MODEL_INVALID_RESPONSE','Codex 响应超过大小上限',false); kill(); return; }
      const decoded=decoder.write(chunk);output = (output + decoded).slice(-16000);
      pending += decoded; let end;
      while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0,end); pending = pending.slice(end+1); try { onLine?.(line); } catch (error) { failure ||= error; kill(); } }
    });
    child.stderr.on('data', chunk => { activity();stderrBytes+=chunk.length; output = (output + chunk.toString()).slice(-16000); });
    child.on('error', () => { failure ||= modelError('MODEL_CONFIG','无法启动 Codex CLI，请重新安装或检测',false); });
    child.on('close', (code,exitSignal) => {
      clearTimeout(timer); clearTimeout(idleTimer); clearTimeout(hardKill); signal?.removeEventListener('abort', abort);
      pending+=decoder.end();
      if (pending) try { onLine?.(pending); } catch (error) { failure ||= error; }
      try{closed('closed',code,exitSignal);}catch(error){reject(error);return;}
      if (failure) reject(failure); else resolve({code, output});
    });
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
    if (signal?.aborted) abort();
  });
}
async function status() {
  let bin;
  try { bin = executable(); } catch (error) { return {installed:false, loggedIn:false, message:error.message}; }
  const [version, login] = await Promise.all([processCall(bin,['--version']), processCall(bin,['login','status'])]);
  if(version.code!==0)throw modelError('MODEL_CONFIG','无法确认 Codex CLI 版本，请重新安装或检测。',false);
  const loggedIn = login.code === 0 && /Logged in using ChatGPT/.test(login.output);
  let model = '', reasoning = 'medium';
  // Read public preferences only. Authentication is owned entirely by the official CLI.
  try {
    const raw = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'config.toml'),'utf8').split(/^\[/m)[0];
    model = raw.match(/^model\s*=\s*"([^"\n]+)"/m)?.[1] || '';
    reasoning = raw.match(/^model_reasoning_effort\s*=\s*"([^"\n]+)"/m)?.[1] || reasoning;
  } catch {}
  let models=[];
  try {
    const cache=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'models_cache.json'),'utf8'));
    models=(cache.models||[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string').map(m=>({id:m.slug,name:m.display_name||m.slug,description:m.description||'',reasoning:(m.supported_reasoning_levels||[]).map(r=>r.effort).filter(r=>typeof r==='string')}));
  } catch {}
  const economical=models.find(m=>m.id==='gpt-6-luna')?.id || models.find(m=>/luna|mini/.test(m.id))?.id || '';
  return {installed:true, loggedIn, models, economical, version:version.output.match(/codex-cli\s+[\w.+-]+/)?.[0] || 'Codex CLI', model, reasoning, message:loggedIn?'已使用 ChatGPT 登录，可使用订阅额度':'请在终端运行 codex login，选择 ChatGPT 登录后重新检测'};
}
function validateInput(messages){
  const input=protocol.serialize(messages);
  const inputChars=input.length>maxInputChars?Array.from(input).length:input.length;
  if(inputChars>maxInputChars)throw inputSizeError(inputChars);
  return input;
}
async function chat(config, _key, messages, {signal, onUsage, onProgress, onReceipt, timeoutMs, responseContract} = {}) {
  let input;try{input=validateInput(messages);}catch(e){onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});throw e;}
  let root,execEntered=false,stage='executable';
  const receipt=require('./model-receipt.cjs').create('codex_cli',input);
  try {
    if(signal?.aborted)throw cancelledError();
    const bin = executable();
    stage='login_status';
    const login=await processCall(bin,['login','status'],{signal});
    if(signal?.aborted)throw cancelledError();
    if (login.code !== 0 || !/Logged in using ChatGPT/.test(login.output)) throw modelError('MODEL_AUTH','Codex 尚未使用 ChatGPT 登录，请在模型设置中重新检测',false);
    stage='setup';
    const limits=policy.normalize(config.requestPolicy);
    root=fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-model-'));
    root=fs.realpathSync(root);
    const schema = path.join(root,'schema.json'), output = path.join(root,'response.json');
    const contract=require('./verification-output.cjs'),structured=contract.selected({responseContract});
    fs.writeFileSync(schema, structured?contract.serialized:JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false}));
    const args = ['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',config.model,
      ...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(config.reasoning || 'medium')}`,
      '--output-schema',schema,'--output-last-message',output,'-'];
    let completed = false, failure, streamError;
    if(signal?.aborted)throw cancelledError();
    // Set before processCall, including synchronous spawn/argument failures.
    execEntered=true;
    const result = await processCall(bin,args,{cwd:root,signal,timeoutMs:timeoutMs ?? limits.totalMinutes*60000,idleTimeoutMs:limits.idleMinutes*60000,onProgress,
      input,onClose:value=>receipt.process(value),
      onLine(line) {
        let event; try { event = JSON.parse(line); } catch { return; }
        const usage=event.usage;
        if(['thread.started','turn.started','turn.completed','turn.failed','error'].includes(event.type))receipt.event(event.type,{requestId:event.request_id,threadId:event.thread_id,errorCode:['error','turn.failed'].includes(event.type)?cliFailure(event.error||event).code:undefined,
          ...(['turn.completed','turn.failed'].includes(event.type)&&usage!=null?{usage:{inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,...(Object.hasOwn(usage,'cached_input_tokens')?{cachedInputTokens:usage.cached_input_tokens}:{})}}:{})});
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'error') streamError=cliFailure(event.error||event);
        if (event.type === 'turn.failed') failure=event.error&&Object.keys(event.error).length?cliFailure(event.error):streamError||cliFailure();
        const boundaryError = protocol.hostToolError(event.item);
        if (boundaryError) throw boundaryError;
      }});
    const rejectedInput=inputFailure(result.output);
    if(rejectedInput){receipt.event('error',{errorCode:rejectedInput.code,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}});throw rejectedInput;}
    if (failure) throw failure;
    if (result.code !== 0 || !completed) throw streamError||incomplete(result.code,completed);
    if (!fs.existsSync(output) || fs.statSync(output).size > 2_000_000) throw modelError('MODEL_INVALID_RESPONSE','订阅模型没有返回有效结果',false);
    const raw=fs.readFileSync(output,'utf8');
    return structured?contract.decode(raw):require('./model-json.cjs').subscription(raw);
  } catch (error) {
    if(!execEntered){
      const failure=preflightError(signal?.aborted?cancelledError():error,stage);
      onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});
      throw failure;
    }
    const normalized = normalizeModelError(error);
    // Authentication, quotas and CLI failures require a deliberate retry.
    if (!signal?.aborted && !(require('./model-errors.cjs').fallbackEligible(normalized)||normalized.code==='MODEL_CLI'&&normalized.automaticRetry===true)) { normalized.modelFailure = true; normalized.automaticRetry = false; }
    throw normalized;
  } finally {
    try{if(execEntered){const record=receipt.snapshot();if(record.usageStatus==='reported')onUsage?.(record.usage);onReceipt?.(record);}}
    finally{if(root)try{fs.rmSync(root,{recursive:true,force:true});}catch{/* Cleanup cannot change the proven dispatch boundary or hide cancellation. */}}
  }
}
module.exports = {chat,status,identity,processCall,cliFailure,incomplete,inputFailure,maxInputChars,validateInput,executable};
