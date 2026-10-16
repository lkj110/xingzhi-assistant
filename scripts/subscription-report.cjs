const fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(process.argv[2]||'artifacts/subscription/first-run');
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
const r=read('report.json'),calls=read('model-calls/calls.json');
const review=fs.existsSync(path.join(dir,'review.json'))?read('review.json'):{};
const incomplete=r.activeCase||review.incompleteCase;
const fmt=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const rows=r.cases.map(c=>`| ${c.title} | ${c.passed?'通过':'未通过'} | ${c.calls} | ${(c.durationMs/60000).toFixed(1)} 分钟 | ${c.interventions} | ${c.files} |`);
if(incomplete){const n=calls.filter(c=>c.index>=incomplete.firstCall).length;rows.push(`| ${incomplete.title} | 未完成验证 | ${n} 次尝试 | ${((Date.parse(r.finishedAt)-Date.parse(incomplete.startedAt))/60000).toFixed(1)} 分钟 | 未取得完整记录 | 未取得完整记录 |`);}
const details=r.cases.map(c=>{
 const e=read(`${c.id}/evidence.json`);
 const errors=e.state.delegations.flatMap(j=>j.history.filter(h=>h.error));
 const delivered=e.files.filter(f=>f.name.endsWith('-最新.md'));
 const notes=[`### ${c.title}`,`状态：${c.status}。${c.summary}`,`[查看完整执行证据](${c.id}/evidence.json)`];
 if(errors.length)notes.push(`执行中收到 ${errors.length} 次工具错误：${errors.map(e=>`${e.tool}：${e.error}`).join('；')}。这些错误计入调用量。`);
 if(delivered.length)notes.push(delivered.map(f=>`- [实际交付：${f.name}](${c.id}/${f.name})`).join('\n'));
 if(c.id==='replan')notes.push(`本场景实际事项数：${e.state.tasks.length}；计划修改记录数：${e.state.tasks.reduce((n,t)=>n+(t.planHistory?.length||0),0)}；保留的文稿文件数（含最新入口）：${e.files.length}。`);
 return notes.join('\n\n');
});
if(incomplete)details.push(`### ${incomplete.title}\n\n${review.incompleteExplanation||r.error||'场景被中断，未取得完整验收结果。'}\n\n[逐次调用记录](model-calls/calls.json)`);
const elapsed=r.finishedAt?((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/60000).toFixed(1):'运行中';
const requested=r.requestedCases||review.requestedCases||r.cases.map(c=>c.id);
const findingText=(review.findings||[]).map((f,i)=>`${i+1}. **${f.title}**：${f.detail}`).join('\n');
const md=`# 当前订阅模型实测

开始时间：${fmt(r.startedAt)}（北京时间）；结束时间：${r.finishedAt?fmt(r.finishedAt):'运行中'}。

**计划测试 ${requested.length} 个场景，${r.cases.filter(c=>c.passed).length} 个通过${incomplete?'，1 个未完成验证':''}。** 原始运行状态：${r.status}。

## 测试方式

- 模型：\`${r.model}\`，推理强度 \`${r.reasoning}\`。
- 通过桌面应用自带的 Codex CLI 0.159.2 复用已有 ChatGPT 订阅登录，未创建或导出密钥。旧全局 CLI 0.147.0 的连接探测因版本要求被拒绝，未计入下表场景。
- 行知实际执行规划、文件工具、事项验收、等待与来源变化处理；外部 GitHub 为模拟环境，测试材料是虚构样例。
- 测试关闭 Codex 自身工具，由模型返回 JSON 决策，交给行知执行。未改动实际桌面工作空间。
- 订阅通道共 ${calls.length} 次调用尝试，${calls.filter(c=>c.status==='completed').length} 次完成，${calls.filter(c=>c.status==='failed').length} 次失败或取消；总耗时 ${elapsed} 分钟。

## 场景结果

| 场景 | 判定 | 模型调用 | 耗时 | 人工补充请求 | 最新文件数 |
| --- | --- | ---: | ---: | ---: | ---: |
${rows.join('\n')}

“人工补充请求”包含模型主动询问缺失信息，这在缺失预算场景中是预期行为。通过指本次样例满足检查条件，不表示所有真实业务任务均可靠。调用数包含规划、正文生成和验收模型调用。

${details.join('\n\n')}

## 查看执行证据后发现的问题

${findingText||'未另附人工复核记录。'}

## 范围与重现

这是首次小样本真实模型测试。尚未验收真实 GitHub 写入、全部 10 个场景、真实用户材料或连续后台运行。桌面 App 尚未新增订阅模型选项，本次通道用于测试。

当前通道为每次推理启动一个 CLI 会话，包含 Codex 自身上下文；耗时和 token 数不能直接代表 API 模式。未将订阅用量换算为美元费用；原始结果的 estimatedUSD 为应用默认字段，不表示订阅用量免费。

${review.validation || '回归测试和本次修改范围请以对应版本说明为准。'}

[逐次调用记录](model-calls/calls.json) · [原始机器结果](report.json) · [复核补充记录](review.json) · [运行方法](../../../docs/SUBSCRIPTION-TESTING.md)

官方依据：[Codex 非交互调用](https://learn.chatgpt.com/docs/non-interactive-mode)、[订阅认证](https://learn.chatgpt.com/docs/auth)。
`;
fs.writeFileSync(path.join(dir,'REPORT.md'),md);console.log(path.join(dir,'REPORT.md'));
