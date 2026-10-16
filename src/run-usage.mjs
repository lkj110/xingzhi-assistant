const number = value => (Number.isFinite(value) ? value : 0).toLocaleString('zh-CN');
const dollars = value => `$${value.toFixed(4)}`;

// Unknown calls and missing prices are not zero-cost calls. Use only the
// original recorded cost; current provider prices must not rewrite history.
export function usageSummary(usage, {pending = false, noCalls = false} = {}) {
  if (noCalls) return '0 token · 折算 $0.0000 · 未调用模型';
  if (!usage) return pending ? '用量与费用待回报' : '用量与费用未记录';
  const reported = usage.reportedCalls ?? (Number.isFinite(usage.inputTokens) ? 1 : 0);
  const unknown = usage.unknownCalls || 0, unpriced = usage.unpricedCalls || 0;
  const total = usage.totalTokens ?? ((usage.inputTokens || 0) + (usage.outputTokens || 0));
  const tokens = reported > 0 ? `${number(total)} token` : pending ? '用量待回报' : unknown ? '用量未知' : '暂无用量报告';
  const priced = reported > unpriced && Number.isFinite(usage.estimatedUSD);
  const cost = priced ? `${unknown || unpriced || pending ? '已知折算' : '折算'} ${dollars(usage.estimatedUSD)}`
    : unpriced ? '费用待计价' : pending ? '费用待回报' : '费用未知';
  return [tokens, cost, unknown ? `${unknown} 次用量未知` : '', unpriced ? `${unpriced} 次缺少单价` : '', pending ? '进行中' : ''].filter(Boolean).join(' · ');
}

export function runUsageSummary(run) {
  return usageSummary(run.usage, {
    pending: run.status === 'running' || (!run.finishedAt && !run.status),
    noCalls: run.status === 'unchanged' && !(run.modelCalls > 0) && !(run.modelCallsDetail?.length),
  });
}

export function callUsage(call) {
  const reported = call.usageReported === true || Number.isFinite(call.inputTokens);
  return {
    inputTokens: call.inputTokens, outputTokens: call.outputTokens, totalTokens: call.totalTokens,
    cachedInputTokens: call.cachedInputTokens, cacheWriteTokens: call.cacheWriteTokens,
    reportedCalls: reported ? 1 : 0,
    unknownCalls: !reported && call.status !== 'running' ? 1 : 0,
    unpricedCalls: reported && !Number.isFinite(call.estimatedUSD) ? 1 : 0,
    estimatedUSD: call.estimatedUSD,
  };
}
