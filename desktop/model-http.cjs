const protocols = require('./model-protocols.cjs');
const policy = require('./model-policy.cjs');
const {modelError, transportError, httpError} = require('./model-errors.cjs');

async function readJSON(url, init, watch) {
  const failure = () => watch.signal.aborted ? watch.signal.reason : transportError();
  let response;
  try { response = await fetch(url, {...init, redirect:'error', signal:watch.signal}); }
  catch { throw failure(); }
  watch.touch();
  if (!response.body) throw modelError('MODEL_INVALID_RESPONSE','模型服务返回空响应',false);
  const reader = response.body.getReader(), chunks = [];
  const limit = response.ok ? 2_000_000 : 64000;
  let bytes = 0, exceeded = false;
  try {
    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch { throw failure(); }
      if (chunk.done) break;
      watch.touch(); bytes += chunk.value.byteLength;
      if (bytes > limit) { exceeded = true; await reader.cancel(); break; }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { reader.releaseLock(); }
  let data;
  if (!exceeded) { try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} }
  if (!response.ok) throw httpError(response.status, data?.error?.code || data?.error?.type || data?.error?.status);
  if (exceeded) throw modelError('MODEL_INVALID_RESPONSE','模型响应过大',false);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw modelError('MODEL_INVALID_RESPONSE','模型服务返回的响应格式无效',false);
  return data;
}

async function chat(config, key, messages, {signal,json=true,onUsage,onProgress} = {}) {
  const url = protocols.endpoint(config), body = protocols.request(config,messages,json);
  const limits = policy.normalize(config.requestPolicy);
  const watch = policy.watch({signal,idleMs:limits.idleMinutes*60000,totalMs:limits.totalMinutes*60000,onProgress});
  try {
    const data = await readJSON(url,{method:'POST',headers:protocols.headers(config,key),body:JSON.stringify(body)},watch);
    const usage = protocols.usage(config,data);
    if (usage) onUsage?.(usage);
    const text = protocols.responseText(config,data);
    return json ? require('./model-json.cjs').parse(text) : text;
  } finally { watch.close(); }
}

async function listModels(config, key, {signal} = {}) {
  protocols.normalize(config);
  const url = protocols.modelsURL(config), models = new Map(), seen = new Set();
  const watch = policy.watch({signal,idleMs:30000,totalMs:60000});
  try {
    for (let page = 0; page < 10; page++) {
      const data = await readJSON(url,{method:'GET',headers:protocols.headers(config,key)},watch);
      const result = protocols.modelPage(config,data);
      for (const model of result.models) if (models.size < 1000) models.set(model.id,model);
      const cursor = result.cursor;
      const truncated = result.models.length > 1000 || models.size >= 1000 || (cursor && (page === 9 || seen.has(JSON.stringify(cursor))));
      if (!cursor || truncated) return {models:[...models.values()].sort((a,b)=>a.id.localeCompare(b.id)),truncated:!!truncated};
      if (cursor[1].length > 4000) throw modelError('MODEL_INVALID_RESPONSE','模型列表分页标记无效',false);
      seen.add(JSON.stringify(cursor));
      url.searchParams.set(cursor[0],cursor[1]);
    }
  } finally { watch.close(); }
}

// Retained credentials may only be used with the same service origin.
async function resolveKey(a, input, existing) {
  if (typeof input.key === 'string' && input.key.trim()) return input.key.trim();
  if (input.clearKey || !existing?.sealedKey) return '';
  if (protocols.baseURL(input).origin !== protocols.baseURL(existing).origin) throw modelError('MODEL_CONFIG','服务域名或端口已更改，请重新填写该服务的密钥，或明确清除原密钥',false);
  return a.vault.open(existing.sealedKey);
}

module.exports = {chat,listModels,resolveKey};
