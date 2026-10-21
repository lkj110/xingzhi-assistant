# Windows 功能对应与验证

基线：上游 0.42.4，提交 `a239465af9fc3bb4184676efff3c9d3374db44b7`。使用原有 React 页面和桌面业务引擎，以下功能没有以静态页面或演示数据替代。Windows 系统接口由独立实现承接。

此表对应《USER_GUIDE.md》的全部主要功能域。测试名称指 `tests/*.test.cjs`；通过数量以本次运行报告为准，表格本身不代表真实外部账号验收。

| 原有功能 | Windows 实现和验证入口 |
| --- | --- |
| 引导、工作台、导航、全局检索 | 共用原界面和引擎；onboarding、core、workspace-view、workmap；实际 EXE 启动验证 |
| 快速创建、补充事项、智能归类、来源追溯 | 共用 capture、capture-target、capture-provenance、intake-routing；quick-capture、p2-capture-navigation、capture-target |
| 划词弹窗、兼容复制读取 | Windows UI Automation 与点击后 Ctrl+C；windows-capture-ui、selection-capture，包含剪贴板恢复和密码拒绝 |
| 框选截图、粘贴截图、快捷键 | Windows 虚拟桌面选区与 WinForms 图像捕获；windows-capture-ui、screenshot、实际 EXE 快捷键握手 |
| 图片、旋转照片、扫描 PDF、文档导入 | Windows WinRT OCR/PDF；windows-native、image-ocr、pdf-ocr、core、实际 EXE PNG/PDF 导入 |
| 收集队列、失败重试、重复材料、版本记录 | 共用队列和来源模型；capture-queue、capture-retry、source-versions、source-observations-v3 |
| 模型预设、各类协议、本地模型 | 共用所有 provider adapters；model-providers、model-regression；真实 Electron 页面到 7 类本地 HTTP 模拟接口 |
| Codex 订阅登录检查与模型调用 | Windows 原生 CLI 发现、Job 生命周期；windows-cli 的真实 PE 夹具、subscription-preflight、subscription-protocol |
| 自动选模、备用模型、超时、费用上限 | 共用路由与限制；model-routing、model-fallback、spend、run-usage、model-preflight-health-upgrade |
| Agent 规划、推进、核验、并行和委托权限 | 共用 Agent 全部运行时模块；agent、parallel-execution、execution-control、system-execution-policy、access-policy-protocol-v3 |
| 项目、工作记忆、归类、工作规则、重复方案 | 共用原存储与调度；projects-documents、project-setup、memory、rules、recurring-playbooks |
| 待处理、决策、验收、修改、原稿接续 | 共用原工作流；decisions-protocol-v3、acceptance、revision-protocol、root-reading-revision、verification-editorial-flow |
| 删除、回收、恢复事项 | 共用 task-trash 和生命周期；task-trash、project-lifecycle、lifecycle-protocol-v3 |
| 飞书消息、文档和固定账号分页读取 | Windows 原生 Lark CLI、固定账号临时配置、ACL、Job Object；p1-lark-pinned-session、p1-b2-lark-identity、windows-process |
| 飞书日历、创建/更新交付文档 | 保留原工具与授权规则，CLI 传输使用 Windows Job；calendar、lark-publish、collaboration、connected、v14-audit |
| GitHub、办公 API、网页、RSS、本地目录 | 保留原连接器；connectors-boundary-independent、office-connectors、web-connections、feeds、folder-connections |
| 企业数据平台、证据补取和复用 | Windows 原生或 npm bytedcli，原证据规则完整保留；windows-cli、data-platform、final-platform-*、generic-platform-* |
| 能力中心、本地/远程 Git、DW Python、MCP | Windows Git/Node/Python 发现、Python UTF-8、原 MCP SDK；capabilities、capability-repositories、p2-capability-trust、capability-binding |
| 本地文件交付、命名、ZIP 导出、分享 | 保留原写入/收据/验收规则；named-delivery、delivery-bundle、public-export-boundary、results |
| 工作时段、后台运行、通知与待办角标 | 原调度器、Electron Windows 托盘和任务栏、通知 AUMID/CLSID 与开始菜单；runtime、stewardship-schedule、pending-badges、实际 EXE 快捷方式回读 |
| 暂停、停止、失败接续、工作体检 | 原恢复与诊断模块，Windows 原生进程树退出；health、auto-recovery、windows-process |
| 工作空间保存、原子替换、备份和升级恢复 | Windows 目录句柄兼容，文件内容 fsync 保留；state-migration、工作日志回放、冷启动 EXE 持久化 |

## 必须区分的验证层次

1. 业务回归使用原上游测试和合成材料，验证规则、恢复与结果。
2. Windows 原生测试实际执行 EXE、系统 OCR、UI Automation、鼠标截图、ACL 和进程树。
3. 打包测试从交付的实际 EXE 启动，不使用开发服务器；应用文件与源码逐项比对 SHA-256。
4. 模型和外部服务测试使用本地 HTTP 服务与本地 CLI 合成账户。没有用户授权的真实服务账号验收，不能将其描述成已验证某个企业租户或付费套餐。

没有人为关闭飞书或其他原有功能。外部工具、账号权限和系统组件仍须按 Windows 使用说明配置。

## 修订 3 新增验证

| 新增能力 | 验证与边界 |
| --- | --- |
| 独立 Git/Node/Python 与 Lark CLI | 实际安装、逐文件 SHA-256 校验，Explorer PATH 发现与显式 PATH 优先级测试 |
| 本机资料 MCP、专用目录、代码执行 | local-tools：真实 SDK stdio 会话、读/查找、越界/链接拒绝、Unicode、超时/取消、进程输出上限 |
| Slack 回复/附件、Notion 展开、Outlook 附件 | office-expanded：分页、重启断点、附件解析、限额、跨域凭据拒绝及旧来源保留；模拟服务，不代表账号授权完成 |
| Outlook OAuth | 设备码、轮询间隔、过期、刷新令牌加密、授权变更测试；真实账号待用户注册 |
| 手动邮件与部署 | 精确预览、单次确认、授权变更拒绝、超时结果未知；模拟 API 验证，未发送邮件或部署 |
| 订阅生成图片 | 当前 Codex CLI + gpt-6.1-sol 实际生成 PNG；只接受本次会话目录中的新 PNG，不能将模型声称的任意路径作为产出 |
| Windows 离线语音 | 实际 System.Speech 生成中文 RIFF/WAVE；声音来自系统已安装语音包 |
| 注册指南 | 固定官方站点入口，未授权的平台显示待接入 |

修订 3 的完成数和 UI 检查以修订 3 验证报告为准。视频生成已明确暂不实施；音乐合成、语音克隆、个人微信全量同步、Windows 10/ARM/多屏实机验收和可信发布签名不在已完成清单中。

## 修订 4 新增验证

Agent 新增代码执行、邮件草稿、订阅图片、离线语音、Outlook 发信及 GitHub 工作流调用，支持按委托授权、精确内容确认、结果回读和文件哈希复核。`agent-local` 已通过真实 JavaScript、Python、中文 WAV、本地 EML、重启后确认、权限撤销、结果篡改、模拟发信以及部署结果未知阻止重试等测试。另外，真实 ChatGPT/Codex 订阅模型已自动规划并执行计算、邮件草稿和中文语音，完成文件回读、任务及委托验收。图片单独执行真实订阅测试；邮件发送、部署与办公账号使用模拟服务验证，实际账号授权仍待完成。

修订 4 上传时的完整回归与打包进度单独记录在 [WINDOWS_R4_STATUS.md](WINDOWS_R4_STATUS.md)，不沿用修订 3 的测试数作为修订 4 结论。

## 测试选择

`scripts/windows-test-plan.cjs` 动态纳入所有运行时测试。明确排除的是 macOS `.app` 包身份、原生载荷白名单、上游正式发布门禁及其指标脚本；保留其原文件和入口。Windows 的对应包验证在 `scripts/windows-package.cjs`。

原上游 Apple Vision 原生样本仅在 macOS 运行；Windows 用新增的中文 PNG、EXIF JPEG、扫描 PDF 及实际 EXE 测试覆盖。文件符号链接测试在没有相应 Windows 权限时报告跳过，不改动系统开发者模式。目录 reparse point 则以 junction 实测。
