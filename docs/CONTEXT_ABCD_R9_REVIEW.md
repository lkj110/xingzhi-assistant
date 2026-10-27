# R9 独立审核归档

2026-10-27。独立审核者：subagent `/root/r9_protocol_review`，未参与本轮实现。本文件由主执行者依据其最终审核结论归档。

最终结论：**no blocking findings**。已审核本轮代码、测试、测量脚本及 R9 文档，未发现需要生产修复的阻断问题。

## 核验结果

- 实际 provider 路由之后、预算之前选择 typed prompt；双向 fallback 重新选择，HTTP 和 JSON repair 路径保留原格式。
- 补证、final/classification 协议边界正确。最终阶段失败保留原进度与用量，不开放额外读取或自动重试。
- 逐字证据绑定、未知限定、来源冲突、全文一致性、计算口径和当前交付回执标准均保留。
- 独立重跑 49 个文件：813 用例，812 通过、0 失败、1 既有 Windows 符号链接权限跳过。
- 独立生成 159 个覆盖 union、enum、nullable、嵌套字段的合法 schema 样本；基线与新版默认 wire schema 均通过 AJV，decoder 输出逐项相同。
- 独立复测 schema 字节、正文唯一集合 hash、阶段/调用数全部一致；九行完整输入精确复现，result/incremental 合成行仅约 1–2 字节动态元数据差异。
- 校验基线导出目录的 231 个 desktop 文件，其中 228 个与基线 Git blob 完全相同；3 个 Swift 文件差异仅 CRLF，与本轮 CJS 测量无关。

## 审核发现与处理

1. 增量测量通过人工注入 previousCheck 触发，仅覆盖通用协议分支；实际 verification-cache 通常需要已复用 grounding 并沿用 legacy/reused 协议。报告已修正，不能宣称真实增量流程普遍收益。
2. 完整输入含动态运行元数据，表格是观测快照而非逐字节恒定值。报告已说明复现波动。
3. 正文 hash 比较唯一内容集合，不证明标识、顺序或重复次数等价。报告保留此测量边界；安全性依据真实可见性、作用域和绑定的离线回归另行验证。

本轮不存在未修复的阻断发现。独立审核未调用真实模型、未部署、未提交或上传。离线审核不能证明真实 CLI 接受新版所有 schema，也不能证明真实漏报/误拦率不变；这两项进入待批准的门检与新样本业务复测。

## 可复核记录

执行测试清单与日志校验值见 `CONTEXT_ABCD_R9_VALIDATION.json`。本地原始记录在工作区上级的 `r9-independent-regression.log`、`r9-independent-measurement.json`、`r9-build.log`；本轮不上传真实模型私有输入或旧 R8 未审核结果。
