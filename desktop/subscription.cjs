const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {normalizeModelError,modelError,transportError,cancelledError,httpError} = require('./model-errors.cjs');
const policy = require('./model-policy.cjs');
const protocol = require('./subscription-protocol.cjs');

const builtin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const maxInputChars=1048576; // Codex exec turn/start input limit, verified locally.
function inputSizeError(actualChars,maxChars=maxInputChars){
 return Object.assign(modelError('MODEL_CONFIG',`本轮输入超过订阅 CLI 的 ${maxChars} 字符上限，请分批读取材料后继续；已有进度已保留。`,false),{diagnostic:{source:'codex_cli',kind:'input_too_large',actualChars,maxChars}});
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
  if(['context_length_exceeded','context_window_exceeded'].includes(code)||/exceeds? (?:the )?(?:model.s? )?context (?:window|length)|maximum context length/i.test(message))return modelError('MODEL_CONFIG','本次材料超过模型上下文上限，请缩小本轮引用材料后继续；已有资料已保存。',false);
  if(['insufficient_quota','usage_limit_reached','quota_exceeded'].includes(code)||/you.ve hit your usage limit|usage limit reached/i.test(message))return modelError('MODEL_QUOTA','订阅模型额度已用完，请等待额度恢复后继续；已有进度已保存。',false);
  if(['invalid_api_key','token_expired','authentication_error'].includes(code))return modelError('MODEL_AUTH','订阅登录已失效，请在模型设置中重新检测登录后继续。',false);
  if(['model_not_found','unsupported_model'].includes(code))return modelError('MODEL_CONFIG','当前订阅无法使用这个模型，请重新检测并选择可用模型。',false);
  if(['server_error','service_unavailable','overloaded_error'].includes(code))return httpError(503);
  if(code==='rate_limit_exceeded')return httpError(429);
  if(['stream_disconnected','connection_error'].includes(code)||/^stream disconnected before completion:|^error sending request for url \(/i.test(message))return transportError();
  return modelError('MODEL_CLI','订阅模型未完成本次请求，已有进度已保留。',true);
}
function cliFailure(error={}) {
  const result=classifyFailure(error);result.diagnostic={source:'codex_cli',kind:'turn_failed',fingerprint:require('node:crypto').createHash('sha256').update(JSON.stringify(error)).digest('hex').slice(0,16)};return result;
}
function incomplete(code,completed){return Object.assign(modelError('MODEL_CLI','订阅模型连接提前结束，已有进度已保留。',true),{diagnostic:{source:'codex_cli',kind:completed?'process_exit':'incomplete_stream',exitCode:Number.isInteger(code)?code:null}});}
function executable() {
  const candidates = [builtin, ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, 'codex'))];
  for (const file of candidates) try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch {}
  throw modelError('MODEL_CONFIG','未找到 Codex CLI。请安装并用 ChatGPT 账号登录 Codex，再点击检测。',false);
}
function environment() {
  const env = {};
  for (const key of ['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','CODEX_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function processCall(bin, args, {cwd, input, signal, timeoutMs = 15000, idleTimeoutMs = 0, onLine, onProgress} = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(bin, args, {cwd, env:environment(), stdio:['pipe','pipe','pipe'], detached:true});
    let output = '', pending = '', bytes = 0, failure, hardKill, idleTimer;
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} hardKill ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500); };
    const abort = () => { failure = cancelledError(); kill(); };
    signal?.addEventListener('abort', abort, {once:true});
    const timer = timeoutMs > 0 ? setTimeout(() => { failure = policy.timeoutError('total'); kill(); }, timeoutMs) : null;
    const activity = () => {
      clearTimeout(idleTimer);
      if (idleTimeoutMs > 0) idleTimer = setTimeout(() => { failure = policy.timeoutError('idle'); kill(); }, idleTimeoutMs);
      onProgress?.({lastActivityAt:new Date().toISOString()});
    };
    activity();
    child.stdout.on('data', chunk => {
      activity();
      bytes += chunk.length;
      if (bytes > 4_000_000) { failure = modelError('MODEL_INVALID_RESPONSE','Codex 响应超过大小上限',false); kill(); return; }
      output = (output + chunk.toString()).slice(-16000);
      pending += chunk.toString(); let end;
      while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0,end); pending = pending.slice(end+1); try { onLine?.(line); } catch (error) { failure ||= error; kill(); } }
    });
    child.stderr.on('data', chunk => { activity(); output = (output + chunk.toString()).slice(-16000); });
    child.on('error', () => { failure = modelError('MODEL_CONFIG','无法启动 Codex CLI，请重新安装或检测',false); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(idleTimer); clearTimeout(hardKill); signal?.removeEventListener('abort', abort);
      if (pending) try { onLine?.(pending); } catch (error) { failure ||= error; }
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
async function chat(config, _key, messages, {signal, onUsage, onProgress, timeoutMs} = {}) {
  const limits=policy.normalize(config.requestPolicy);
  const input=protocol.instructions + '\nAPPLICATION MESSAGES:\n' + JSON.stringify(messages);
  const inputChars=input.length>maxInputChars?Array.from(input).length:input.length;
  if(inputChars>maxInputChars){onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});throw inputSizeError(inputChars);}
  const bin = executable();
  let login;
  try{login=await processCall(bin,['login','status'],{signal});}
  catch{throw signal?.aborted?cancelledError():modelError('MODEL_AUTH','无法确认 Codex 登录状态，请在模型设置中重新检测。',false);}
  if (login.code !== 0 || !/Logged in using ChatGPT/.test(login.output)) throw modelError('MODEL_AUTH','Codex 尚未使用 ChatGPT 登录，请在模型设置中重新检测',false);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'xingzhi-model-')));
  try {
    const schema = path.join(root,'schema.json'), output = path.join(root,'response.json');
    fs.writeFileSync(schema, JSON.stringify({type:'object',properties:{response_json:{type:'string'}},required:['response_json'],additionalProperties:false}));
    const args = ['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--color','never','--json','--model',config.model,
      ...protocol.configuration(),'-c',`model_reasoning_effort=${JSON.stringify(config.reasoning || 'medium')}`,
      '--output-schema',schema,'--output-last-message',output,'-'];
    let completed = false, usage, failure, streamError;
    const result = await processCall(bin,args,{cwd:root,signal,timeoutMs:timeoutMs ?? limits.totalMinutes*60000,idleTimeoutMs:limits.idleMinutes*60000,onProgress,
      input,
      onLine(line) {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'turn.completed') { completed = true; usage = event.usage;
    if (Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens)) onUsage?.({inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,...(Number.isFinite(usage.cached_input_tokens)?{cachedInputTokens:usage.cached_input_tokens}:{})});
        }
        if (event.type === 'error') streamError=cliFailure(event.error||event);
        if (event.type === 'turn.failed') failure=event.error&&Object.keys(event.error).length?cliFailure(event.error):streamError||cliFailure();
        const boundaryError = protocol.hostToolError(event.item);
        if (boundaryError) throw boundaryError;
      }});
    const rejectedInput=inputFailure(result.output);
    if(rejectedInput){onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});throw rejectedInput;}
    if (failure) throw failure;
    if (result.code !== 0 || !completed) throw streamError||incomplete(result.code,completed);
    if (!fs.existsSync(output) || fs.statSync(output).size > 2_000_000) throw modelError('MODEL_INVALID_RESPONSE','订阅模型没有返回有效结果',false);
    return require('./model-json.cjs').subscription(fs.readFileSync(output,'utf8'));
  } catch (error) {
    const normalized = normalizeModelError(error);
    // Authentication, quotas and CLI failures require a deliberate retry.
    if (!signal?.aborted && !(require('./model-errors.cjs').fallbackEligible(normalized)||normalized.code==='MODEL_CLI'&&normalized.automaticRetry===true)) { normalized.modelFailure = true; normalized.automaticRetry = false; }
    throw normalized;
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
module.exports = {chat,status,processCall,cliFailure,incomplete,inputFailure,maxInputChars};
