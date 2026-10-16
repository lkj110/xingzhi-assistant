// Isolated deterministic service for end-to-end tests. Never used by the packaged app.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../desktop/server.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingzhi-ui-'));
let requests = 0;
const mock = http.createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw); const prompt = input.messages[0].content;
  const context = input.messages[1] ? JSON.parse(input.messages[1].content) : {};
  let result = { ok: true };
  if (prompt.includes('从材料提取')) result = { summary: '【测试输出】已提取两个可执行目标。', tasks: [
    { title: '准备周五发布说明', description: '根据会议材料，写清楚发布目标与节奏。', criteria: '包含周五发布安排和待确认事项', priority: 'high', sourceIds: [context.sources[0].id], steps: [{ title: '起草发布说明', kind: 'draft' }] },
    { title: '跟进设计稿确认', description: '确认设计稿，保存对方的反馈。', criteria: '有设计确认结果和后续摘要', priority: 'normal', sourceIds: [context.sources[0].id], steps: [{ title: '向设计同事确认方案', kind: 'external' }, { title: '整理确认结果', kind: 'analysis' }] }
  ] };
  else if (prompt.includes('推进给定事项')) result = { kind: 'artifact', title: context.currentStep.title, content: '# 工作产出（流程测试）\n\n这是一份由本地测试服务返回的固定文本，不是真实模型生成。\n\n## 发布安排\n计划周五发布，发布前完成设计确认。\n\n## 待确认事项\n- 设计稿确认结果\n- 发布负责人\n\n## 补充反馈\n' + context.task.notes.map(n => n.text).join('\n'), summary: '【测试输出】已生成文稿。' };
  else if (prompt.includes('独立检查')) result = { passed: true, summary: '【测试输出】已检查产出包含周五发布安排与待确认事项。', gaps: [] };
  requests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
});
mock.listen(4319, '127.0.0.1', async () => {
  const { server, origin } = await startServer({ dir, port: 4318 });
  process.stdout.write(JSON.stringify({ origin, mock: 'http://127.0.0.1:4319/v1', dir }) + '\n');
  const close = () => { server.close(); mock.close(); fs.rmSync(dir, { recursive: true, force: true }); process.stdout.write(`Model requests: ${requests}\n`); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
});
