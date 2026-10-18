# 行知助手 · Xingzhi Assistant

一个开源的本地桌面工作助手：**收集材料 → 整理目标与步骤 → 推进事项 → 检查结果 → 验收归档**。

A local-first desktop assistant with multi-provider AI, task execution, source tracking, and human review. Built with Electron, React, and native macOS OCR helpers.

[下载现有 0.40.0 安装包](https://github.com/lkj110/xingzhi-assistant/releases/latest) · [使用说明](docs/USER_GUIDE.md) · [模型接入](docs/MODEL_PROVIDERS.md) · [贡献指南](CONTRIBUTING.md)

## 本次源码更新

本次为 **0.42.4 源码更新**，不是新安装包发行。本次不创建新的 GitHub Release 或上传发行资产，现有 `latest` 安装包仍为 **0.40.0**，不能将该链接视作 0.42.4 下载。

私有最终安装包与公开源码分别记录候选 commit、验证结果及交付身份，不互相代替。公共源码缺少私有历史合同/证据时，正式打包入口明确失败；公共 default 测试通过不授予正式发行资格。

## 能做什么

- **统一收集**：文字、PDF、DOCX、截图、授权文件夹、RSS 和网页；图片及扫描 PDF 可在 Mac 本地 OCR。
- **推进工作**：将目标拆成事项、持续跟进资料变化、生成有来源的产出，支持暂停、恢复、修订和人工验收。
- **多模型接入**：23 个服务预设，覆盖 DeepSeek、Kimi、千问、GLM、MiniMax、豆包、OpenAI、Claude、Gemini、Azure、聚合平台及本地开源模型。
- **原生协议**：Chat Completions、Responses、Anthropic Messages、Gemini generateContent、Azure OpenAI、Ollama；支持自定义地址、模型 ID、鉴权、输出上限与生成参数。
- **本地与开源模型**：Ollama、LM Studio、vLLM、SGLang、llama.cpp 等兼容服务。模型权重由使用者另行安装或连接。
- **权限与成本**：角色模型、备用接续、用量记账、运行预算、资料范围、外部操作确认和回执核对。
- **扩展连接**：GitHub、飞书及办公工具入口、技能仓库和 MCP 能力。连接需要使用者自己的账号与权限。

## 安装与首次使用

现有 `latest` 安装包及公开发行说明为 **v0.40.0**；本次 **0.42.4 源码更新没有创建新 GitHub Release/资产**。现有 DMG / ZIP 面向 **Apple Silicon Mac，macOS 13+**；其他平台尚未验证。

1. 在 [Releases](https://github.com/lkj110/xingzhi-assistant/releases) 下载 DMG，将「行知助手.app」拖入 Applications。
2. 打开「模型与设置」，选择服务商预设，填写自己的密钥与模型 ID，保存后测试连接。也可连接已启动的本地模型服务。
3. 为「信息整理」「事项推进」「结果检查」选择模型，导入材料或创建一个项目。
4. 从工作台推进事项，并在「待我处理」确认外部动作和验收结果。

App 不附带账号或模型额度。ChatGPT 订阅入口依赖使用者自行安装并登录的 Codex CLI；仅在浏览器登录 ChatGPT 不等于 CLI 已登录。此次多模型扩展面向文本与推理；图像/音视频生成、嵌入和重排接口不在该适配范围。

安装包使用 ad-hoc 签名，尚未提供 Apple Developer ID 签名或公证。首次打开步骤及 SHA-256 核对方式见 [安装说明](docs/SHARING.md)。

## 从源码运行

需要 macOS、Node.js 24 或更高版本，以及 Xcode Command Line Tools（编译 Swift OCR 和选区助手）。

```bash
git clone https://github.com/lkj110/xingzhi-assistant.git
cd xingzhi-assistant
npm ci
npm start
```

`npm start` 会先编译本地助手和前端，再启动 Electron。前端单独开发可运行 `npm run dev`；完整桌面能力应通过 Electron 验证。没有模型密钥也可以查看界面、保存材料并运行默认测试。

```bash
npm test                  # 单元与集成测试；合成数据，不调用真实模型
npm run test:models       # 模型协议、路由和备用接续
npm run test:models:desktop # 隔离 Electron 的多模型界面流程
npm run test:desktop      # 全套隔离桌面场景
npm run package:share     # 受控发行入口；没有完整门禁证据时拒绝打包
npm run test:share        # 仅用于已有实际包的验证，不替代发行门禁
```

`test:*:subscription` 与订阅评估脚本是可选的真实模型测试，会消耗个人额度；默认测试和 CI 不运行它们。第三方办公服务、企业数据平台和专用能力仓库需要另行获得权限，不是开箱即用的公共服务。

公共默认测试保留合成恢复、安全隔离和拒绝绕过覆盖，不包含私人安装回执或真实历史快照。缺失私人证据的历史入口明确以 `PRIVATE_HISTORY_UNAVAILABLE` 非零退出；公共测试通过不等于私有七组发行门禁通过。源码验证、私有最终包验证和公开上传分别结算；正式发行不能仅凭公共 default 通过，详见 [公共测试边界](docs/PUBLIC-TESTING.md)。

## 数据如何处理

工作资料保存在本机工作空间，通常位于 `~/Library/Application Support/行知助手/workspace`。模型整理和推进会向你配置的服务发送相关文字；使用本地模型可将该部分留在本机。密钥使用 Electron 的系统加密存储，资料本身以本地明文文件保存。外部文件、消息、GitHub 和办公服务操作遵循各自配置的权限。

源码仓库不包含工作空间、模型凭据、生产业务材料或已登录账号。提交问题前请清除密钥、路径和工作内容；详见 [安全说明](SECURITY.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `desktop/` | Electron 主进程、后台执行、模型协议、连接器、权限与账本 |
| `src/` | React 界面与应用内帮助 |
| `desktop/native/` | Swift 选区捕获、图片 OCR、PDF OCR 源码 |
| `tests/` | 使用合成样例的单元与集成测试 |
| `scripts/` | 构建、隔离桌面场景、打包及可选评估 |
| `docs/` | 使用、接入、费用与开发说明 |

## 项目状态与贡献

这是持续开发中的个人开源项目。欢迎报告可复现问题、改进文档、增加模型适配与测试。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。已有验证范围和限制见 [v0.40.0 发布说明](docs/RELEASE-V0.40.0.md)。

## 许可证

项目原创代码和文档采用 [MIT License](LICENSE)。第三方依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
