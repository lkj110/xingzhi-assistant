// Only stable error codes and safe explanations cross into the workspace/UI.
const safeCodes=new Set(['MODEL_BLOCKED','MODEL_HTTP','MODEL_TIMEOUT','MODEL_NETWORK','MODEL_CANCELLED','MODEL_QUOTA','MODEL_AUTH','MODEL_CONFIG','MODEL_INVALID_RESPONSE','MODEL_CLI','MODEL_FAILED','MODEL_STORAGE']);
const contextCodes=new Set(['CONTEXT_LINK_MISSING','CONTEXT_VERSION_CHANGED','CONTEXT_INVALID_REQUEST','CONTEXT_SCOPE_DENIED']);
const internalCodes=new Set([...contextCodes,'EXTERNAL_EFFECT_UNCERTAIN','STORAGE_FAILURE']);
const contextHints={
  CONTEXT_LINK_MISSING:['资料缺少可证明的事项关联','repair_binding','trusted_binding_changed'],
  CONTEXT_VERSION_CHANGED:['材料或工作依据已变化，请刷新目录后核对','refresh_catalog','reference_or_basis_changed'],
  CONTEXT_INVALID_REQUEST:['资料读取参数无效，请按目录修正本请求','correct_request','request_changed'],
  CONTEXT_SCOPE_DENIED:['该引用不在当前可读取范围','use_scoped_catalog','scope_or_permission_changed'],
};
function contextError(code,details={}) {
  if(!contextCodes.has(code))code='CONTEXT_INVALID_REQUEST';
  const [message,recovery,retryCondition]=contextHints[code];
  return Object.assign(new Error(details.message||message),{...details,code,contextFailure:true,modelFailure:false,automaticRetry:false,recovery:details.recovery||recovery,retryCondition:details.retryCondition||retryCondition,safeAlternatives:details.safeAlternatives||[]});
}
function contextResult(error){return {ok:false,code:error.code,message:error.message,recovery:error.recovery,safeAlternatives:error.safeAlternatives||[],retryCondition:error.retryCondition,...(error.contextRevision?{contextRevision:error.contextRevision}:{}),...(error.noProgress?{noProgress:true}:{})};}
function storageError(){return Object.assign(new Error('本地读取结果与纠偏记录无法安全保存，已停止继续请求；已有持久化记录保留，请检查本地存储。'),{code:'STORAGE_FAILURE',modelFailure:false,automaticRetry:false,localPersistence:true,recovery:'diagnose_storage',retryCondition:'storage_recovered'});}
function modelError(code, message, automaticRetry = true) {
  return Object.assign(new Error(message), {code:safeCodes.has(code)?code:'MODEL_FAILED', modelFailure: true, automaticRetry});
}
function blockedError() {
  return modelError('MODEL_BLOCKED', '模型服务拦截了本次请求，已停止自动推进。请检查任务与材料；执行记录和已有产出已保留。', false);
}
function transportError(code='MODEL_NETWORK') {
  return modelError(code,code==='MODEL_TIMEOUT'?'模型请求超时，请稍后重试或检查服务。':'无法连接模型服务，请检查服务地址和网络。');
}
function persistenceError(){return Object.assign(modelError('MODEL_STORAGE','模型调用记录无法保存，已停止继续请求。请检查本地存储后重试。',false),{localPersistence:true});}
function cancelledError(){return modelError('MODEL_CANCELLED','操作已停止',false);}
function normalizeModelError(error) {
  if(internalCodes.has(error?.code))return error;
  if (['content_policy_violation', 'content_filter', 'safety_violation'].includes(error?.code)
    || /flagged for possible cybersecurity risk|blocked by (?:the )?content filter/i.test(error?.message || '')) return blockedError();
  if(error?.modelFailure&&safeCodes.has(error.code))return error;
  if(error?.name==='AbortError')return cancelledError();
  if(error?.name==='TimeoutError'||['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.code))return transportError('MODEL_TIMEOUT');
  if(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','EPIPE','UND_ERR_SOCKET'].includes(error?.code))return transportError();
  return modelError('MODEL_FAILED','模型请求失败，请检查模型服务后重试。',error?.automaticRetry!==false);
}
function httpError(status, code) {
  if (['content_policy_violation', 'content_filter', 'safety_violation'].includes(code)) return blockedError();
  if(['insufficient_quota','quota_exceeded','billing_hard_limit_reached','usage_limit_reached'].includes(code))return modelError('MODEL_QUOTA','模型服务额度已用完，请检查订阅或账户额度后重试。',false);
  const hint = {400:'请求参数无效，请检查模型配置',401:'密钥无效或已过期',403:'无权使用此模型',404:'地址或模型名称不存在',429:'请求频率过高'}[status] || '服务返回错误';
  return Object.assign(modelError('MODEL_HTTP', `模型请求失败（HTTP ${status}）：${hint}`, status === 408 || status === 429 || (status >= 500 && status <= 599)),{httpStatus:status});
}
function fallbackEligible(error){return error?.modelFailure===true&&error.automaticRetry!==false&&(['MODEL_TIMEOUT','MODEL_NETWORK'].includes(error.code)||(error.code==='MODEL_HTTP'&&(error.httpStatus===408||error.httpStatus===429||(error.httpStatus>=500&&error.httpStatus<=599))));}
function safeErrorCode(error){return safeCodes.has(error?.code)||internalCodes.has(error?.code)?error.code:'MODEL_FAILED';}
function diagnostic(error){const d=error?.diagnostic;if(!d||d.source!=='codex_cli')return undefined;return {source:d.source,...(['turn_failed','process_exit','incomplete_stream','host_tool_attempt','input_too_large'].includes(d.kind)?{kind:d.kind}:{}),...(Number.isInteger(d.exitCode)?{exitCode:d.exitCode}:{}),...(/^[a-f0-9]{16}$/.test(d.fingerprint||'')?{fingerprint:d.fingerprint}:{}),...(d.kind==='host_tool_attempt'&&require('./subscription-protocol.cjs').hostItemTypes.has(d.itemType)?{itemType:d.itemType}:{}),...(d.kind==='host_tool_attempt'&&['in_progress','completed','failed','pending'].includes(d.itemStatus)?{itemStatus:d.itemStatus}:{}),...(d.kind==='input_too_large'&&Number.isSafeInteger(d.maxChars)&&Number.isSafeInteger(d.actualChars)?{maxChars:d.maxChars,actualChars:d.actualChars}:{})};}
module.exports = {modelError, blockedError, normalizeModelError, httpError,transportError,cancelledError,persistenceError,fallbackEligible,safeErrorCode,diagnostic,contextError,contextResult,contextCodes,storageError};
