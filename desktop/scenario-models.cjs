// Saved user policy takes precedence over task preferences and automatic tiers.
// Never inspect source bodies to decide whether they may leave this model group.
function select(a, primary, options = {}) {
  const policy = a.data.settings?.scenarioModels;
  if (!policy?.enabled || ['connection_test', 'evaluation'].includes(options.stage) || a.modelBudgetOwner) return null;
  const payload = options.routingContext || {};
  const intent = [payload.task?.title, payload.task?.description, payload.task?.criteria,
    payload.currentStep?.title, payload.goal, payload.delegation?.goal].filter(v => typeof v === 'string').join('\n');
  const analysis = !!a.activeAgentJob || ['execute', 'verify'].includes(options.role)
    || ['sources', 'artifacts', 'datasets', 'tables', 'records'].some(key => Array.isArray(payload[key]) && payload[key].length > 0)
    || ['planner', 'goal_verify'].includes(options.stage)
    || payload.currentStep?.kind === 'analysis'
    || /分析|核验|核对|诊断|数据|统计|SQL|analy[sz]|data|verif|reconcile/i.test(intent);
  let slot = 'subscription';
  if (analysis) {
    slot = options.role === 'verify' || /根因|架构|跨表|血缘|复杂|风险|root.cause|architecture/i.test(intent) ? 'complex' : 'agent';
    if (options.role !== 'verify' && options.stage !== 'planner' && /改写|润色|翻译|排版|精简|rewrite|translate|format/i.test(payload.currentStep?.title || '')
      && !/分析|核验|核对|analy[sz]|verif/i.test(payload.currentStep?.title || '')) slot = 'editorial';
  }
  const provider = a.data.providers.find(p => p.id === policy[slot] && !p.archivedAt);
  const allowed = analysis ? policy.customIds : [policy.subscription];
  if (!provider || !allowed?.includes(provider.id)) throw Object.assign(new Error('场景模型配置已失效，请重新配置；分析任务不会转发给 GPT 订阅。'), {code: 'MODEL_CONFIG'});
  return {provider, routing: {mode: 'scenario', tier: slot, primaryId: primary.id,
    reason: analysis ? 'Agent 与数据分析使用 Harness 自定义模型' : '其他场景使用 GPT 订阅'}};
}
module.exports = {select};
