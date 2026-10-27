# 严格证据核验的真实模型对照评测

本评测经生产 `Assistant.advance` 和 Codex 订阅适配器运行，用于比较关闭、开启 `evidenceGrounding` 时的最终事实错误、交付阻拦与资源消耗。它使用真实登录的 ChatGPT/Codex 订阅，**会消耗账户模型额度**；不是模拟测试，也不是免费离线检查。脚本中的本地价格字段为零不代表实际调用免费。

案例只包含 `scripts/grounding-eval-cases.cjs` 中的合成业务资料。每个实验分支创建独立的临时 `Assistant` 工作区，结束后清理；不读取日常事项，不修改日常模型配置，不执行真实外部发布。每次模型调用的输入、响应和 usage 会保存在指定输出目录中，供复核。

本文区分两种实验，标签不能混用：

| 脚本 | `baseline` | `strict` |
| --- | --- | --- |
| `grounding-live-eval.cjs` | 严格核验关闭，保留原有 checker | 严格核验开启 |
| `grounding-v3-live-eval.cjs` | 严格核验开启，使用冻结 v2 | 严格核验开启，使用冻结 v3 |

后者测试来源冲突修复与紧凑协议的版本变化，不能将结果描述为“开启严格核验相对于不核验”的收益。

## 对照设计

- `baseline`：关闭严格证据核验，保留产品原有的独立 checker。它不是“完全不检查”的基线。
- `strict`：在同一流程中开启增量 grounding，包括要求清单、结论与原文绑定、本地证据校验等。额外阅读或修正可能改变调用次数。
- 同一案例分别运行两种模式，交替先运行 baseline、strict；默认同时处理两对案例。模型与 reasoning 相同，因此独立调用不等于错误相互独立：生成器和 checker 仍可能共享盲点。
- `delivered` 表示事项进入待审阅状态且生产结果核验通过，不代表已经对外发布，也不代表用户验收。

两条评测路径分别分析，不能合并为自然使用中的幻觉率：

| 路径 | 输入与衡量对象 |
| --- | --- |
| `e2e` | 从合成资料生成答案，再经过生产核验，观察整条链路的最终结果。标准答案只用于运行后的评分。 |
| `fixed` | 将预置候选稿作为 `user_import` 稿件交给生产流程，分别测试答案正确、答案错误的输入。后续流程可能修正稿件，因此必须区分初始输入与最终保存的输出。 |

`fixed` 的 `goldCandidateCorrect` 只标识初始候选的 **answer 与 certainty 是否正确**。当前固定候选的 basis 是泛称，例如“已综合当前有效资料、例外条件和版本信息”，并不保证满足任务要求的具体依据。`fixed-correct` 被阻拦不能直接解释为“整份合格稿被误拦”；需要结合 basis 审计。错误输入被修正为正确答案后交付，也不能算作放行了原来的错误。

## v2 与 v3 的冻结版本对照

`scripts/grounding-v3-live-eval.cjs` 的两组都启用严格核验。准备两个独立冻结实现目录，分别含 `desktop/core.cjs` 及所需运行依赖：`--baseline-root` 使用核验模块 v2，`--candidate-root` 使用 v3。两份实现的 `desktop/*.cjs` 文件集必须一致，且唯一不同文件必须为 `desktop/grounding.cjs`；runner 会检查该条件。生成、取证、存储及其余业务逻辑保持同一版本，实际订阅适配器也由两组共享。

```powershell
node scripts/grounding-v3-live-eval.cjs --baseline-root work/grounding-v2-snapshot --candidate-root work/grounding-v3-snapshot --out work/grounding-version-eval-v3 --model gpt-6.1-sol --reasoning medium
```

目录名只是示例，应替换为已冻结的实际路径；不要在运行中修改快照或共享适配器。此命令会消耗订阅额度。默认预设来自 `scripts/grounding-v3-eval-cases.cjs`：

- 4 对 e2e：缺少基数、同级未解决冲突、受理不能证明送达、局部覆盖不足。任务允许如实未知，每组应保留合法未知交付能力。
- 8 对 fixed：3 份完整合格稿应通过，5 份稿件必须阻断。合格稿包括完整披露来源冲突的未知、按明确优先级得到确定结论、同段六项事实共享引文。阻断稿包括无依据选边、用 unknown 字样掩盖选边、遗漏强制分歧披露、要求必须确定但尚未协调、六项事实中有一项错误。
- 共 12 对、24 个分支；全局默认上限 90 次真实模型调用，每分支默认最多 6 次，并发最多 2 对。上限不是完成保证，所有实际读取、生成和核验均计入用量。

这里 `candidateMeetsCriteria`、`expectedDelivered` 和 `expectedReason` 是运行前固定的完整稿质量标签，只用于事后评分，不发送模型。不要仅凭 answer/certainty 正确就认定必须确定任务的未知中间稿是合格交付；同样，格式正确或大多数事实正确也不能抵消缺少必要披露或单项事实错误。

v3 需要单独检查协议行为：共享引文通过 `format: "compact-v3"` 的顶层 `citations` 与结论 `citationIds` 传输；成功记录省略可由绑定推导的重复理由，但全部要求、关键断言和失败原因仍须覆盖。`sourceConflicts` 仅记录按原要求允许、正文已明确未知且引用双方原文的分歧，必须绑定当前结论和已满足要求；它不覆盖旧 `conflicts`、要求缺口、错误事实或整体失败。详细本地规则见 [EVIDENCE_GROUNDING.md](EVIDENCE_GROUNDING.md)。

本轮版本迭代分别保存为 C、D、E、F 冻结实验。C、D 运行完整预设；E、F 使用 `--lane fixed` 重跑全部 8 对固定稿，以隔离报告协议与本地结构校验的效果。每轮保留原始结果，不把不同轮次挑选出的成功记录拼成一次完整评测。最终边界回归包括：

- 明确未知措辞由普通检查与来源分歧检查共用中央词表，覆盖“无法判断”“不能确定”“无法得知”“未能确认”等，避免两处白名单漂移；普通“未”、建议或可能性不能替代来源分歧中的明确未知。
- 区分未知许可与完整要求核验：`sourceConflicts.requirementIds` 所列许可要求均满足，集合至少关联一个实际未知结论；原始要求逐项独立核验，补充标题等结论本身仍须核对当前文本及原文。它们无需反向挂到要求记录，避免引入原验收协议没有的多余覆盖约束。
- 标题核验关注具体业务断言，主题、问题和类别无需强造推断结论；原文直接确证的等价归纳使用 fact，未直接确证的推断仍须明确标记。

这些修正不改变“必须确定但证据未协调”“隐藏分歧”“错误选边”及旧 `conflicts` 的阻断要求。最终以 F 固定同稿对照及原文复核评估效果，D 端到端结果单独报告；本说明不预设误拦率、漏放率或 token 数字。

冻结版本对照的报告记录两份实现文件哈希、共享适配器/评分/案例指纹和完整参数；结束时再检查生产文件是否变化。`implementationUnchanged` 为 false、分支未配齐或技术故障时，不应将其当作完成的公平对照。该 runner 不与早期 A/B 报告拼接，原始记录保留；语义复核、完整合格稿误拦、必须阻断稿漏放及 token 均按此次版本实验独立分析。无效格式与技术失败也要单列。

只读 `groundingStatus` 可核对当前日常应用 worker 实际加载的版本、紧凑格式、能力标记和模块加载时源码哈希。这是运行版本诊断，不是语义正确性或安全性证明；真实模型评测使用冻结实现，也不能替代对日常应用加载状态的确认。

## 冻结输入与实现

开始前固定案例、标准答案、可接受等价规则、模型、reasoning、预算和业务实现。建议随输出保存 Git 提交号、未提交补丁或相关文件 hash、Codex CLI 版本及运行命令。实现包括业务代码、提示词、适配器和本地验证规则。

一次运行过程中不要修改上述内容。输入或实现发生变化时，使用新的 `--out` 目录，保留旧报告供对照。当前 `grounding-live-eval.cjs` 的 `identity` 包括模型、reasoning、案例计划、业务实现文件、runner/评分、预算、并发和 Node 版本；v3 版本对照 runner 另记录两份实现和共享依赖。早期报告格式未包含同样完整的指纹，不应反推当时已执行这些校验。指纹用于识别版本，运行过程仍需保持文件冻结。

同一冻结版本可用相同命令和输出目录继续尚未记录的分支。已写入 `rows` 的分支会跳过，包括已保存的技术失败；这不是自动重试机制。技术失败的重测应使用新目录，并明确说明重测范围，不能覆盖原始失败记录。

## 运行真实评测

在仓库根目录执行，需要可用的 Node.js、生产适配器支持的 Codex CLI，以及已经登录的订阅。`--model` 必须是本地公开模型缓存中的可用模型；脚本会在开始时检查登录与模型状态。

```powershell
node scripts/grounding-live-eval.cjs --model gpt-6.1-sol --reasoning medium --out work/grounding-live-eval-v1
```

请将示例输出目录换成此次冻结版本的新目录。默认全量计划包括 16 对 e2e、8 对 fixed，共 **48 个分支（arms）**；全局最多 **140 次模型调用**，每个分支最多 6 次。上限是预算保护，不保证所有分支都能在额度内完成。生成、读取和核验可能各自占用调用。

| 参数 | 默认值与用途 |
| --- | --- |
| `--model` | 必填，显式选择已登录订阅可用的模型。 |
| `--out` | 必填，输出目录，包含 `report.json` 与 `calls/` 调用记录。 |
| `--reasoning` | `medium`。 |
| `--lane` | `all`；可指定 `e2e` 或 `fixed`。 |
| `--cases` | 全部案例；可填写以逗号分隔的案例 ID。fixed 只选带 `wrongAnswer` 的前四项。 |
| `--concurrency` | `2`；实际并发限制在 1 到 2 对案例。 |
| `--max-calls` | `140`，整次运行的调用上限。 |
| `--arm-calls` | `6`，单个分支的调用上限。 |

缩小范围的示例仍会调用真实模型、消耗额度：

```powershell
node scripts/grounding-live-eval.cjs --model gpt-6.1-sol --lane e2e --cases exception-scope,latest-revision --max-calls 20 --out work/grounding-live-eval-pilot-v1
```

检查报告的 `status`、技术错误和完成分支数后再解释结果。运行中的报告会持续更新，不能拿尚未配齐的两组总量进行公平比较。达到调用上限、超时或认证失败属于技术问题，应与内容阻拦分开报告。

## 离线分析与语义审计

`scripts/grounding-eval-analysis.cjs` 只读取已有文件，不调用模型，不修改源报告。先输出原始评分视图：

```powershell
node scripts/grounding-eval-analysis.cjs --report work/grounding-live-eval-v1/report.json --out work/grounding-live-eval-v1/analysis.json
```

原始评分要求输出恰好包含三个字符串字段的无围栏 JSON：

```json
{"answer":"结论","certainty":"confirmed","basis":"简短依据"}
```

`certainty` 可为 `confirmed`、`unknown`、`inference` 或 `proposal`。raw 评分对 answer 做 NFC 规范化并去除首尾空白后匹配标准答案，同时检查 certainty；它不自动判断 basis 是否完整、有证据。格式无效是不可评分，不能当作已经证明安全。raw 的 factual error 是本组合成任务上的操作性指标，不覆盖一切形式的幻觉。

语义审计应逐份对照原始资料检查 answer、certainty 和 basis，并将依据、适用两组的对称等价规则、原判与修订判定保存在独立的 `audit-overrides.json` 中。审计文件需要 `schema: 1`、匹配的 `reportIdentity` 和 `overrides`；每项通过 `caseId`、`arm`、候选内容的 SHA-256 `candidateHash`、`originalGrade` 绑定原记录。具体校验以分析脚本的 `applyAudit` 为准，不直接改写 `report.json`。

```powershell
node scripts/grounding-eval-analysis.cjs --report work/grounding-live-eval-v1/report.json --audit work/grounding-live-eval-v1/audit-overrides.json --out work/grounding-live-eval-v1/analysis-audited.json
```

分析保留 `raw` 与 `audited` 两个视图，未审计记录保留原判。脚本会拒绝过期的候选 hash、原判或报告身份；输出路径也不能覆盖报告或审计源文件。审计方式须如实记录，模型或开发者的语义复核不能称为“人类盲审”。

## 指标口径

评估最终事实错误时同时查看按全部尝试、按已交付输出计算的比例，并报告不可评分项。被拦住的错误不进入最终已交付错误的分子；错误候选率与最终错误率需要分开。`taskSuccess` 要求最终答案正确且已交付。若某条路径存在修正，应查看初始候选、调用轨迹和最终内容，不能仅凭“初始输入错误且最终交付”判定漏放。

误拦至少保留以下几种口径，并排除、另列技术失败：

- `falseBlockCorrectCandidateOnly` 是历史的 answerable-only 指标，只判断答案与确定性，未包含合法 unknown。
- `allCorrectCandidateFalseBlock` 包括符合要求的 unknown 与 proposal，但仍不保证 basis 完整。
- `correctUnknownNotDelivered` 与 `safeAbstentionDelivered` 单独展示正确未知是否能够交付。题目明确允许如实未知时，“无法确定”也是可完成的正确答案。
- `fullySupportedCandidateFalseBlock` 只在语义审计后，针对答案、确定性正确且 basis 经原文复核支持的候选统计；它的分母限于已审计的合格记录。

`fixedInput` 中的指标区分“正确答案输入未交付”“错误输入最终仍以错误答案交付”“错误输入修正后正确交付”。这些是不同事件；其中“正确答案输入”仍不代表初始 basis 合格。

## Token 与耗时

实际 token 来自生产适配器返回的 Codex CLI usage，包含 CLI 包装提示和运行环境上下文，不仅是应用消息；`inputChars` 只是应用消息字符数，不能替代 token。核验开销应在相同完整案例对上比较，不能把全部调用消耗都归因于新增 grounding。

```text
totalTokens = inputTokens + outputTokens
uncachedInputTokens = max(0, inputTokens - cachedInputTokens)
```

`cachedInputTokens` 已包含在 `inputTokens` 中，不要再次加到总量。缓存命中可能受执行顺序和共享前缀影响；交替顺序只能减轻该影响。usage 缺失保持 `null`，已知小计不冒充完整总量。

`pairedResources` 仅使用对应资源在两组都完整的案例对，报告差值为 strict 减 baseline。另看每个正确交付任务的 token 与调用成本，它包含失败、阻拦和修正消耗；成功数为零时为 `null`。按尝试成本、按成功交付成本回答的是不同问题。

`durationMs` 是单个分支的端到端耗时，包含本地处理。并发时，各分支耗时相加不是整次运行的实际时长，也不是模型纯计算时间。

## 结论边界

这是小规模、人工选择的合成案例对照。零次观测错误不代表真实错误概率为零；分析输出 Wilson 95% 区间，并为零事件提供单侧上界。案例之间以及同模型生成、复核之间可能相关，不能仅凭这些区间推断所有真实业务的总体幻觉率。

没有观察到幻觉率差异时，应表述为“本次案例与预算下未检出严格核验的增量改善”，同时报告误拦、技术失败、资源消耗和样本限制。提高统计功效应预先固定更多独立的困难案例和重复轮数，重点覆盖例外条件、近似引文、冲突来源、版本变化和证据不足，再分析配对分歧；避免不断追加样本直到出现期望结论。不同模型或实际业务的泛化效果需要独立验证。

本文件说明运行方法和解释口径，不预设任何一次尚未完成的评测结论。

## 核验输入压缩的新样本对照

`scripts/grounding-input-live-eval.cjs` 对比两个均开启严格核验的冻结实现：前者使用原 v3 输入，后者使用 `verify-input-v1`。运行器只允许 `core.cjs`、`generation-context.cjs`、`grounding.cjs` 三个声明文件有差异，模型、推理设置和生产订阅适配器相同。`core.cjs` 的差异用于给 exact 检查缓存标记新的输入协议，不改变本地验收规则。

新样本位于 `scripts/grounding-v4-holdout-cases.cjs`，包括 12 对固定同稿和 4 对端到端任务。材料与标准在推理前封存，独立实现者不读取这些样本；候选实现冻结后才向其运行。模型仅收到公开任务字段、资料及候选稿，不能收到 gold。题目是否未知与候选是否满足完整要求分开判断，正确答案中的虚构依据也计入语义审计。

```powershell
node scripts/grounding-input-live-eval.cjs --baseline-root PATH_TO_BASELINE --candidate-root PATH_TO_CANDIDATE --out PATH_TO_RESULTS --model gpt-6.1-sol --reasoning medium --max-calls 120 --arm-calls 6 --concurrency 2
```

两条件分别运行每个新样本一次、交替前后顺序，按全部预定尝试统计总 token，不删除误拦或错误放行以改善结果。固定稿与端到端结果分列；来源逐字匹配、当前版本、实际展示范围和完整验收标准另作独立审计。保留实际调用 usage、原始消息、输出、候选及实现哈希。用量包含模型包装上下文，缓存输入已包含在输入中。该轮结果无论好坏都保留，不据其修改候选后仍将同一批题称为新样本。

报告应同时比较总 token、输入/输出 token、每正确验收决策成本、完整合格稿误拦、错误放行及已交付内容的事实/依据幻觉。小样本未观测到退化不等于已证明总体错误率不增加；需要更多未参与修改的业务样本和重复采样作进一步验证。
# 输入归因与回执压缩对照（J）

`grounding-receipt-live-eval.cjs` 比较冻结的 `verify-input-v1` 与 `verify-input-v2`，两边均开启严格 v3 核验。`grounding-v5-holdout-cases.cjs` 在生产实现冻结后编写，16 对固定稿（8 合格、8 应拦）与 4 对端到端任务，未用于本次实现调整。每条件每题一次，配对交替调用顺序，同一订阅模型及推理强度；公开输入采用字段白名单，gold 不入提示。

用法：`node scripts/grounding-receipt-live-eval.cjs --baseline-root <冻结基线目录> --candidate-root <冻结候选目录> --out <新的结果目录> --max-calls 132 --arm-calls 6 --concurrency 2`。使用现有订阅授权，仍消耗真实模型额度。结果仅保存在隔离评测工作区，不向外部平台交付，也不向真实事项写入评测数据。

每次调用记录实际 usage、输入分类统计与原始消息/响应。类别 token 是按可见 UTF-8 字节占比分摊的估算；分类按序列化字段位置计算，复用正文仅在实际出现位置计一次，不能据此反推出服务端 tokenizer 或精确缓存分布。总 token 以 input+output 计算，缓存已在 input 内，失败和额外尝试也计入。

质量分母按原文复核的完整交付要求确定，而非只比较 answer：正确答案但虚构 basis 属于应拦稿；必须唯一确认的未知中间稿也属于未完成。误拦＝合格稿被阻断；错误放行＝不合格稿交付；交付幻觉同时检查答案和依据。固定与端到端分别列出，技术失败单列。逐字引文还核对版本和**核验角色**实际收到的字符区间。语义复核由实施该修改的 Codex 助手进行，条件标签可见，不称作独立人类盲审。
