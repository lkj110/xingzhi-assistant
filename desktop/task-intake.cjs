const crypto = require('node:crypto');

// Admit a durable request before the agent runs. A lost response or restart
// must not turn a repeated click into a second task or spending scope.
function submit(a, input) {
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 200000) throw Error('请粘贴要推进的内容，最多 20 万字符');
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId)) throw Error('事项请求标识无效');
  const capabilityIds = require('./capture-advance.cjs').normalize({infer:true,capabilityIds:input.capabilityIds}).capabilityIds.sort();
  const text = input.text.trim(), digest = crypto.createHash('sha256').update(text).digest('hex');
  const existing = a.data.captureQueue?.find(row => row.intakeRequestId === input.requestId);
  if (existing) {
    if (existing.intakeTextHash !== digest || JSON.stringify([...(existing.advancement?.capabilityIds||[])].sort()) !== JSON.stringify(capabilityIds)) throw Error('本次内容已变化，请作为新事项提交');
    return a.publicState();
  }
  return require('./capture.cjs').enqueue(a, {
    textItems: [{title: text.split('\n')[0].slice(0, 80), content: text, origin: '新建事项原文'}],
    advancement: {infer: true, capabilityIds},target:{kind:'new'},provenance:{kind:'manual',note:'新建事项原文',capturedAt:new Date().toISOString()},
  }, {intakeRequestId: input.requestId, intakeTextHash: digest});
}
module.exports = {submit};
