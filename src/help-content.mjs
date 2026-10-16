export function parseGuide(markdown) {
  const chunks = String(markdown).replace(/\r\n/g, '\n').split(/^## /m);
  return chunks.slice(1).map(chunk => {
    const split = chunk.indexOf('\n');
    const title = (split < 0 ? chunk : chunk.slice(0, split)).trim();
    const body = (split < 0 ? '' : chunk.slice(split + 1)).trim();
    return { id: title, title, body };
  });
}

export function searchGuide(sections, query) {
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sections.filter(section => {
    const text = `${section.title}\n${section.body}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export const guideRoutes = {
  '持续推进与防止重复执行（v0.35.0）': ['agent', '查看实际进展'],
  '平台证据复用与更新（v0.35.0）': ['agent', '查看查询记录'],
  '删除与恢复事项': ['trash', '查看已删除事项'],
  '快速新建、补充与来源追溯': ['captureWindow', '打开快速收集'],
  '快速上手': ['settings', '连接模型'],
  '页面导航与工作流程': ['board', '打开工作台'],
  '连接模型与订阅': ['settings', '打开模型配置'],
  '自动选模、等待与故障接续': ['settings', '打开模型配置'],
  '快速记录、选中文字与截图': ['captureWindow', '打开快速收集'],
  '材料导入、识别与收集队列': ['capture', '查看收集队列'],
  '主动收集与长期托管': ['connections', '配置主动收集'],
  '办公与聊天工具': ['connections', '打开信息连接'],
  '网页、RSS、本地目录与 GitHub': ['connections', '打开信息连接'],
  '委托 Agent 推进事项': ['agent', '打开 Agent 委托'],
  '看板状态、依赖与跟进': ['board', '打开工作看板'],
  '成果阅读、验收与修改': ['artifacts', '查看当前成果'],
  '决策、外部动作与交付': ['decisions', '查看待我决策'],
  '工作规则与工作方案': ['rules', '打开工作规则'],
  '项目、材料归类与工作记忆': ['projects', '打开项目'],
  '能力中心与 DW 仓库': ['capabilities', '打开能力中心'],
  '模型用量、费用与上限': ['agent', '查看委托用量'],
  '超时、失败与用量未知': ['runtime', '打开运行与恢复'],
  '后台运行、工作时段与通知': ['runtime', '配置后台运行'],
  '数据、备份、导出与分享': ['runtime', '查看本地备份'],
  '常见问题与排查顺序': ['health', '打开工作体检'],
};
