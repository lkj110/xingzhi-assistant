const crypto = require('node:crypto');

const now = () => new Date().toISOString();
const variableNames = ['主题', '要求'];
const defaults = {maxActions: 6, intervalMinutes: 30, autoAccept: true};
const builtins = [
  {id: 'builtin-research', title: '专题调研与比较', description: '收集依据、比较方案，交付可追溯的建议。', goalTemplate: '调研 {{主题}}。先阅读已授权材料，按需要补充公开来源，比较主要方案的适用条件、成本与局限，给出建议。', taskRequirements: '额外要求：{{要求}}\n交付一份结构清晰的调研报告。区分已核实事实与推断，列出来源和时间；遇到冲突先核对，缺少关键证据才提出具体问题。'},
  {id: 'builtin-meeting', title: '会议行动与持续跟进', description: '把会议材料变为行动项，跟进明确结果。', goalTemplate: '整理 {{主题}} 的会议材料，识别已确定的结论、行动事项、负责人、截止时间和依赖，推进可以独立完成的工作并跟进结果。', taskRequirements: '额外要求：{{要求}}\n保留每项结论的材料依据。不能把提议当成决定，不能把已发出询问当成已完成；新信息补充原事项，避免重复建单。'},
  {id: 'builtin-delivery', title: '计划与交付推进', description: '按完成标准拆解目标，检查实际交付。', goalTemplate: '推进 {{主题}}，结合已有背景和材料，按交付物拆解计划、完成标准与依赖，持续更新进度直至可以验收。', taskRequirements: '额外要求：{{要求}}\n优先推进没有阻塞的事项。产出包含具体下一步和依据；等待他人时写明所需结果与期限，最终检查实际交付是否满足目标。'},
  {id: 'builtin-review', title: '阶段复盘与下轮计划', description: '核对目标和实际结果，找出下一轮可行动的改进。', goalTemplate: '对 {{主题}} 进行阶段复盘，阅读已授权的进展材料，比较原目标与实际结果，归纳完成项、未完成原因、风险与下一轮改进。', taskRequirements: '额外要求：{{要求}}\n每项结论对应实际记录。区分外部依赖与可以直接改善的环节，按影响给出少量具体改进事项，说明完成标准。'}
];

function initialize(a) {
  a.data.playbooks ||= [];
  for (const builtin of builtins) {
    if (!a.data.playbooks.some(p => p.id === builtin.id)) {
      a.data.playbooks.push({...builtin, ...defaults, builtin: true, revision: 1, archived: false, createdAt: now(), updatedAt: now()});
    }
  }
}

function text(value, label, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new Error(`${label}${optional ? '须为文本且' : '不能为空且'}不能超过 ${max} 字符`);
  return value.trim();
}

function variables(value) {
  if (/\{\{\{|\}\}\}/.test(value)) throw new Error('方案变量只支持 {{主题}} 和 {{要求}}，请检查括号是否完整');
  const names = [...value.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1]);
  const residue = value.replace(/\{\{(?:主题|要求)\}\}/g, '');
  if (names.some(name => !variableNames.includes(name)) || /\{\{|\}\}/.test(residue)) throw new Error('方案变量只支持 {{主题}} 和 {{要求}}，请检查括号是否完整');
  return [...new Set(names)];
}

function execution(input) {
  const output = {};
  for (const [key, min, max, label] of [['maxActions', 1, 12, '每轮动作上限'], ['intervalMinutes', 5, 1440, '跟进间隔']]) {
    const value = input[key] ?? defaults[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}–${max} 之间的整数`);
    output[key] = value;
  }
  if (input.autoAccept !== undefined && typeof input.autoAccept !== 'boolean') throw new Error('自动验收须为布尔值');
  output.autoAccept = input.autoAccept ?? defaults.autoAccept;
  return output;
}

function fields(input) {
  const record = {
    title: text(input.title, '方案名称', 100), description: text(input.description, '方案说明', 500, true),
    goalTemplate: text(input.goalTemplate, '目标模板', 7000), taskRequirements: text(input.taskRequirements, '处理方法与验收要求', 2000, true),
    ...execution(input)
  };
  variables(`${record.goalTemplate}\n${record.taskRequirements}`);
  return record;
}

function current(a, input) {
  const p = a.data.playbooks.find(p => p.id === input.id);
  if (!p) throw new Error('工作方案不存在，请刷新');
  if (input.revision !== p.revision) throw new Error('工作方案已更新，请重新打开后操作');
  return p;
}

function prepare(p, values) {
  if (p.archived) throw new Error('工作方案已归档，请先恢复');
  if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) throw new Error('方案变量须为对象');
  values ||= {};
  const template = [p.goalTemplate, p.taskRequirements && `处理方法与验收要求：\n${p.taskRequirements}`].filter(Boolean).join('\n\n');
  const substitutions = {};
  for (const name of variables(template)) substitutions[name] = text(values[name], `请填写${name}`, 3000);
  // Replace once: a user's literal text cannot introduce another template expansion.
  const goal = template.replace(/\{\{(主题|要求)\}\}/g, (_, key) => substitutions[key]);
  if (goal.length > 10000) throw new Error('填入变量后的目标超过 10000 字符，请缩短内容');
  return {goal, ...execution(p), templateId: p.id, templateRevision: p.revision};
}

function validateDraft(a, input) {
  if (input.templateId === undefined || input.templateId === null || input.templateId === '') return null;
  const p = current(a, {id:input.templateId,revision:input.templateRevision});
  if (p.archived) throw new Error('工作方案已归档，请先恢复或重新选择方案');
  return {id:p.id,revision:p.revision,title:p.title};
}

function fromJob(a, input) {
  const j = a.data.delegations.find(j => j.id === input.jobId);
  if (!j) throw new Error('委托不存在，请刷新');
  const tasks = j.taskIds.map(id => a.data.tasks.find(t => t.id === id)).filter(t => t && !t.agentCancelled);
  const taskRequirements = tasks.map((t, i) => `${i + 1}. ${t.title}\n完成标准：${t.criteria || '按目标验收'}`).join('\n\n');
  if (j.goal.length > 7000 || taskRequirements.length > 2000) throw new Error('该委托的目标或事项要求较长，请新建方案并提炼处理方法');
  // Only plain goals, criteria and execution limits are extracted. Scope and permissions never enter a recipe.
  return {title: `${j.title || '工作'}方案`.slice(0, 100), description: '从委托提炼，可将具体主题替换为 {{主题}} 后重复使用。', goalTemplate: j.goal, taskRequirements, ...execution(j)};
}

async function dispatch(a, action, input = {}) {
  a.ensureIdle();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作方案参数须为对象');
  if (action === 'playbookFromJob') return fromJob(a, input);
  if (action === 'playbookPrepare') return prepare(current(a, input), input.values);
  if (action === 'playbookSave') {
    const existing = input.id ? current(a, input) : null;
    if (existing?.builtin) throw new Error('内置方案请先复制，再修改');
    if (existing?.archived) throw new Error('工作方案已归档，请先恢复');
    const value = fields(input);
    if (existing) Object.assign(existing, value, {revision: existing.revision + 1, updatedAt: now()});
    else {
      if (a.data.playbooks.filter(p => !p.builtin).length >= 200) throw new Error('最多保存 200 个自定义工作方案');
      a.data.playbooks.unshift({...value, id: crypto.randomUUID(), builtin: false, revision: 1, archived: false, createdAt: now(), updatedAt: now()});
    }
    a.event('工作方案已保存', value.title);
  } else if (action === 'playbookCopy') {
    const p = current(a, input);
    return dispatch(a, 'playbookSave', {...fields(p), title: `${p.title}（副本）`.slice(0, 100)});
  } else if (action === 'playbookArchive') {
    const p = current(a, input);
    if (p.builtin) throw new Error('内置方案不能归档');
    if (typeof input.archived !== 'boolean') throw new Error('请明确归档或恢复方案');
    if (p.archived !== input.archived) {
      p.archived = input.archived; p.revision++; p.updatedAt = now();
      a.event(p.archived ? '工作方案已归档' : '工作方案已恢复', p.title);
    }
  } else throw new Error('未知工作方案操作');
  a.save();
  return a.publicState();
}

module.exports = {initialize, dispatch, prepare, variables, validateDraft};
