// Stateless text-model adapters. Credentials are supplied by the existing vault.
const {modelError, blockedError, httpError} = require('./model-errors.cjs');
const types = ['openai', 'responses', 'anthropic', 'gemini', 'azure', 'ollama', 'codex'];
const configError = message => modelError('MODEL_CONFIG', message, false);
const invalid = message => modelError('MODEL_INVALID_RESPONSE', message, false);
const authModes = ['auto', 'bearer', 'x-api-key', 'x-goog-api-key', 'api-key', 'none'];
const reserved = new Set(['model','messages','input','contents','system','systemInstruction','instructions','stream','tools','tool_choice','toolConfig','functions','function_call','mcp_servers','container','response_format','text','generationConfig','responseMimeType','responseSchema','responseJsonSchema','max_tokens','max_completion_tokens','max_output_tokens','maxOutputTokens','num_predict','store','background','previous_response_id','conversation']);

function extraParameters(value) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { throw configError('高级参数必须是有效的 JSON 对象'); } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed).length > 16000) throw configError('高级参数须为不超过 16 KB 的 JSON 对象');
  function inspect(obj, depth = 0) {
    if (depth > 12) throw configError('高级参数嵌套过深');
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      if (['__proto__','prototype','constructor'].includes(key) || /^(?:api[_-]?key|authorization|headers|password|secret|access[_-]?token)$/i.test(key)) throw configError('高级参数不能包含密钥、请求头或特殊对象属性，请使用密钥输入框');
      inspect(val, depth + 1);
    }
  }
  inspect(parsed);
  if (Object.keys(parsed).some(key => reserved.has(key))) throw configError('高级参数不能覆盖模型、消息、工具、输出格式或输出上限');
  // The app consumes one result. Multiple candidates multiply the bill even
  // when each candidate obeys the same output cap.
  for (const key of ['n', 'best_of', 'candidateCount']) {
    if (Object.hasOwn(parsed, key) && parsed[key] !== 1) throw configError(`高级参数 ${key} 仅支持数值 1；当前接入只处理一个候选结果`);
  }
  return JSON.parse(JSON.stringify(parsed));
}

function normalize(config = {}) {
  const type = config.type || 'openai';
  if (!types.includes(type)) throw configError('不支持的接口类型，请重新选择');
  const authMode = config.authMode || 'auto';
  if (!authModes.includes(authMode)) throw configError('不支持的鉴权方式');
  const tokenParameter = config.tokenParameter || 'max_tokens';
  if (!['max_tokens','max_completion_tokens'].includes(tokenParameter)) throw configError('输出上限参数无效');
  let maxOutputTokens = null;
  if (config.maxOutputTokens !== undefined && config.maxOutputTokens !== null && config.maxOutputTokens !== '') {
    maxOutputTokens = Number(config.maxOutputTokens);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 1000000) throw configError('输出上限须为 16–1000000 的整数，且不能超过所选模型的限制');
  }
  const apiVersion = String(config.apiVersion || '').trim();
  if (apiVersion && !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(apiVersion)) throw configError('API 版本格式应为 YYYY-MM-DD 或 YYYY-MM-DD-preview');
  const workspaceId = String(config.workspaceId || '').trim();
  if (workspaceId && !/^[a-zA-Z0-9_-]{1,200}$/.test(workspaceId)) throw configError('Claude 工作空间 ID 格式无效');
  return {type, authMode, tokenParameter, maxOutputTokens, apiVersion, workspaceId, extraBody: extraParameters(config.extraBody)};
}

function budgetForOptions({type, maxOutputTokens}) {
  if (type === 'codex') return {maxOutputTokens:null, outputTokens:Math.max(128000, maxOutputTokens || 0), mode:'estimate', enforced:false};
  if (maxOutputTokens !== null) return {maxOutputTokens, outputTokens:maxOutputTokens, mode:'explicit', enforced:true};
  if (type === 'anthropic') return {maxOutputTokens:8192, outputTokens:8192, mode:'protocol_default', enforced:true};
  return {maxOutputTokens:null, outputTokens:128000, mode:'estimate', enforced:false};
}
// `enforced` means encoded in the request, not a provider billing guarantee.
function outputBudget(config = {}) { return budgetForOptions(normalize(config)); }

function baseURL(config) {
  let url;
  try { url = new URL(config.baseUrl); } catch { throw configError('模型地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw configError('模型地址须为不含密码、查询参数的 HTTP(S) 地址；Azure API 版本请单独填写');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function endpoint(config) {
  const type = config.type || 'openai', url = baseURL(config);
  if (!types.includes(type) || type === 'codex') throw configError('不支持的 HTTP 接口类型');
  let p = url.pathname.replace(/\/+$/, '');
  if (type === 'ollama') p = /\/api\/chat$/.test(p) ? p : `${p.replace(/\/api$/, '')}/api/chat`;
  else if (type === 'anthropic') p = /\/messages$/.test(p) ? p : `${/\/v1$/.test(p) ? p : p + '/v1'}/messages`;
  else if (type === 'gemini') {
    const model = String(config.model || '').replace(/^models\//, '');
    if (!model) throw configError('请填写 Gemini 模型 ID');
    p = p.replace(/\/models\/[^/]+:generateContent$/, '').replace(/\/models$/, '');
    p = `${p || '/v1beta'}/models/${encodeURIComponent(model)}:generateContent`;
  } else if (type === 'azure' && !/\/openai\/v1(?:\/chat\/completions)?$/.test(p)) {
    if (!config.apiVersion) throw configError('Azure 旧版接口需要填写 API 版本，或使用 /openai/v1 地址');
    p = p.replace(/\/chat\/completions$/, '');
    if (!/\/deployments\/[^/]+$/.test(p)) p = `${p.replace(/\/openai$/, '')}/openai/deployments/${encodeURIComponent(config.model)}`;
    else p = p.replace(/(\/deployments\/)[^/]+$/, (_match,prefix) => prefix + encodeURIComponent(config.model));
    p += '/chat/completions';
    url.searchParams.set('api-version', config.apiVersion);
  } else if (type === 'responses') p = /\/responses$/.test(p) ? p : `${p || '/v1'}/responses`;
  else p = /\/chat\/completions$/.test(p) ? p : `${p}/chat/completions`;
  url.pathname = p;
  return url.href;
}

function headers(config, key) {
  const mode = config.authMode && config.authMode !== 'auto' ? config.authMode : ({anthropic:'x-api-key',gemini:'x-goog-api-key',azure:'api-key'}[config.type] || 'bearer');
  const result = {'Content-Type':'application/json'};
  if (key && mode !== 'none') result[mode === 'bearer' ? 'Authorization' : mode] = mode === 'bearer' ? `Bearer ${key}` : key;
  if (config.type === 'anthropic') {
    result['anthropic-version'] = config.apiVersion || '2023-06-01';
    if (config.workspaceId) result['anthropic-workspace-id'] = config.workspaceId;
  }
  return result;
}

function request(config, messages, json = true) {
  const options = normalize(config), type = options.type;
  if (!Array.isArray(messages) || messages.some(m => !m || !['system','developer','user','assistant'].includes(m.role) || typeof m.content !== 'string')) throw configError('当前模型接入仅接受文本对话消息');
  const useJSON = json && config.jsonMode !== false;
  const max = budgetForOptions(options).maxOutputTokens;
  const system = messages.filter(m => ['system','developer'].includes(m.role)).map(m => m.content).join('\n\n');
  const turns = messages.filter(m => !['system','developer'].includes(m.role));
  if (type === 'anthropic') return {
    ...options.extraBody, model:config.model, stream:false, max_tokens:max,
    system:[system, useJSON ? 'Return only a valid JSON object, without Markdown fences.' : ''].filter(Boolean).join('\n\n'),
    messages:turns.map(m => ({role:m.role,content:m.content}))
  };
  if (type === 'gemini') return {
    ...(system ? {systemInstruction:{parts:[{text:system}]}} : {}),
    contents:turns.map(m => ({role:m.role === 'assistant' ? 'model' : 'user',parts:[{text:m.content}]})),
    generationConfig:{...options.extraBody,...(max ? {maxOutputTokens:max} : {}),...(useJSON ? {responseMimeType:'application/json'} : {})}
  };
  if (type === 'responses') return {
    ...options.extraBody, model:config.model, input:messages.map(m => ({role:m.role,content:m.content})), stream:false, store:false,
    ...(max ? {max_output_tokens:max} : {}), ...(useJSON ? {text:{format:{type:'json_object'}}} : {})
  };
  if (type === 'ollama') return {
    model:config.model,messages,stream:false,...(useJSON ? {format:'json'} : {}),
    ...((Object.keys(options.extraBody).length || max) ? {options:{...options.extraBody,...(max ? {num_predict:max} : {})}} : {})
  };
  return {...options.extraBody,model:config.model,messages,stream:false,...(max ? {[options.tokenParameter]:max} : {}),...(useJSON ? {response_format:{type:'json_object'}} : {})};
}

const count = n => Number.isFinite(n) && n >= 0;
function usage(config, data) {
  let inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, cacheWrite1hTokens;
  const u = data.usage || {};
  if (config.type === 'ollama') { inputTokens = data.prompt_eval_count; outputTokens = data.eval_count; }
  else if (config.type === 'anthropic') {
    cachedInputTokens = u.cache_read_input_tokens ?? 0; cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
    cacheWrite1hTokens = u.cache_creation?.ephemeral_1h_input_tokens;
    inputTokens = count(u.input_tokens) && count(cachedInputTokens) && count(cacheWriteTokens) ? u.input_tokens + cachedInputTokens + cacheWriteTokens : undefined;
    outputTokens = u.output_tokens;
  } else if (config.type === 'gemini') {
    const g = data.usageMetadata || {};
    inputTokens = g.promptTokenCount; cachedInputTokens = g.cachedContentTokenCount;
    outputTokens = count(g.candidatesTokenCount) && count(g.thoughtsTokenCount ?? 0) ? g.candidatesTokenCount + (g.thoughtsTokenCount ?? 0) : undefined;
  } else if (config.type === 'responses') {
    inputTokens = u.input_tokens; outputTokens = u.output_tokens; cachedInputTokens = u.input_tokens_details?.cached_tokens;
  } else {
    inputTokens = u.prompt_tokens; outputTokens = u.completion_tokens; cachedInputTokens = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  }
  if (!count(inputTokens) || !count(outputTokens)) return null;
  return {inputTokens,outputTokens,...(count(cachedInputTokens) ? {cachedInputTokens} : {}),...(count(cacheWriteTokens) ? {cacheWriteTokens} : {}),...(count(cacheWrite1hTokens) ? {cacheWrite1hTokens} : {})};
}

function responseText(config, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('模型服务返回的响应格式无效');
  if (data.error) throw httpError(400, data.error.code || data.error.type || data.error.status);
  let text, truncated = false;
  if (config.type === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content.filter(p => p && typeof p === 'object') : [];
    if (data.stop_reason === 'refusal' || blocks.some(p => p.type === 'refusal')) throw blockedError();
    truncated = data.stop_reason === 'max_tokens' || data.stop_reason === 'pause_turn';
    text = blocks.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
    if (data.stop_reason === 'tool_use' || blocks.some(p => p.type === 'tool_use' || p.type === 'server_tool_use')) throw invalid('模型返回了未请求的工具调用，请使用支持文本输出的模型');
  } else if (config.type === 'gemini') {
    const candidate = data.candidates?.[0];
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts.filter(p => p && typeof p === 'object') : [];
    if (data.promptFeedback?.blockReason || ['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY'].includes(candidate?.finishReason)) throw blockedError();
    truncated = candidate?.finishReason === 'MAX_TOKENS';
    if (candidate?.finishReason && !['STOP','MAX_TOKENS'].includes(candidate.finishReason)) throw invalid('模型未正常完成输出，请检查模型与参数');
    text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    if (parts.some(p => p.functionCall)) throw invalid('模型返回了未请求的工具调用');
  } else if (config.type === 'responses') {
    const parts = Array.isArray(data.output) ? data.output.filter(o => o?.type === 'message').flatMap(o => Array.isArray(o.content) ? o.content.filter(p => p && typeof p === 'object') : []) : [];
    if (parts.some(p => p.type === 'refusal') || data.incomplete_details?.reason === 'content_filter') throw blockedError();
    truncated = data.status === 'incomplete' || data.incomplete_details?.reason === 'max_output_tokens';
    if (data.status && !['completed','incomplete'].includes(data.status)) throw invalid('模型响应尚未完成或已失败');
    text = parts.filter(p => p.type === 'output_text' && typeof p.text === 'string').map(p => p.text).join('');
  } else if (config.type === 'ollama') {
    truncated = data.done_reason === 'length' || data.done === false;
    text = data.message?.content;
  } else {
    const choice = data.choices?.[0], message = choice?.message;
    if (message?.refusal || choice?.finish_reason === 'content_filter') throw blockedError();
    truncated = choice?.finish_reason === 'length';
    if (message?.tool_calls?.length || message?.function_call) throw invalid('模型返回了未请求的工具调用');
    text = typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('') : null;
  }
  if (truncated) throw invalid('模型输出达到上限或未完整结束，请调高输出上限或缩小任务后重试');
  if (typeof text !== 'string' || !text.trim()) throw invalid('模型未返回文本，请检查模型名称与接口类型');
  return text;
}

function modelsURL(config) {
  const url = baseURL(config), type = config.type;
  let p = url.pathname.replace(/\/+$/, '');
  if (type === 'azure' && !/\/openai\/v1(?:\/chat\/completions)?$/.test(p)) throw configError('Azure 旧版部署接口请手动填写部署名称，或改用 /openai/v1 接口读取列表');
  if (type === 'ollama') p = `${p.replace(/\/api(?:\/chat)?$/, '')}/api/tags`;
  else if (type === 'gemini') p = `${p.replace(/\/models(?:\/[^/]+:generateContent)?$/, '') || '/v1beta'}/models`;
  else p = new URL(endpoint({...config,model:config.model || '_catalog'})).pathname.replace(/\/(?:chat\/completions|responses|messages)$/, '/models');
  url.pathname = p;
  return url;
}

function modelPage(config, data) {
  const rows = config.type === 'ollama' || config.type === 'gemini' ? data.models : data.data;
  if (!Array.isArray(rows)) throw invalid('此服务未提供标准模型列表，请手动填写模型 ID');
  const models = rows.filter(m => m && (config.type !== 'gemini' || !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))).map(m => {
    const id = config.type === 'gemini' ? String(m.name || '').replace(/^models\//, '') : String(m.id || m.model || m.name || '');
    return {id, name:String(m.display_name || m.displayName || id).slice(0,200)};
  }).filter(m => m.id.length > 0 && m.id.length <= 200 && !/[\r\n\0]/.test(m.id));
  let cursor;
  if (config.type === 'gemini' && typeof data.nextPageToken === 'string') cursor = ['pageToken',data.nextPageToken];
  else if (config.type === 'anthropic' && typeof data.next_page === 'string') cursor = ['page',data.next_page];
  else if (config.type === 'anthropic' && data.has_more && typeof data.last_id === 'string') cursor = ['after_id',data.last_id];
  return {models,cursor};
}

module.exports = {types, normalize, outputBudget, endpoint, headers, request, usage, responseText, modelsURL, modelPage, baseURL};
