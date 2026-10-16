# 行知助手模型接入 · v0.40.0

支持 23 个服务预设，按 6 种 HTTP 文本协议与现有 Codex 订阅方式接入。预设只填协议和服务地址，不限制模型 ID；DeepSeek、Kimi、Qwen、GLM、Llama、Gemma 等可通过官方 API、聚合平台或自己部署的兼容服务使用。

## 快速配置

1. 模型与设置 → 模型配置 → 添加模型 → 选择服务商预设。
2. 按自己的地域、套餐或私有网关修改地址，填写该服务的密钥。
3. 点击「读取模型列表」，或手动填写完整模型 ID。Azure 填部署名称，本地服务填已加载的模型名。
4. 填写费用折算单价；按模型需要设置 JSON 模式、输出上限和高级参数。
5. 保存并测试连接，再分配给信息整理、事项推进和结果检查。

模型列表读取不会进行推理，不计入行知的模型调用记录。列表最多读取 10 页、1000 项，截断会提示；目录缺失或鉴权失败仍可手动填写 ID。连接测试会进行一次实际模型推理。

## 服务预设与官方依据

以下常用地址依据官方资料核对于 2026-10-16。区域、工作空间、Coding Plan 和专用接入点可能使用不同地址，界面允许修改。模型目录和账号权限可能变化，接入能力与所有模型逐一实测是两回事。

| 服务 | 协议 | 默认服务地址 |
| --- | --- | --- |
| ChatGPT 订阅 | ChatGPT 订阅（Codex CLI） | 按本机登录或账号资源填写 |
| [DeepSeek](https://api-docs.deepseek.com/) | OpenAI 兼容 · Chat Completions | `https://api.deepseek.com/v1` |
| [Kimi / Moonshot（国内）](https://platform.moonshot.cn/docs/intro) | OpenAI 兼容 · Chat Completions | `https://api.moonshot.cn/v1` |
| [Kimi / Moonshot（国际）](https://platform.moonshot.ai/docs/intro) | OpenAI 兼容 · Chat Completions | `https://api.moonshot.ai/v1` |
| [通义千问 / 阿里云百炼（北京）](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) | OpenAI 兼容 · Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| [豆包 / 火山方舟](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh) | OpenAI 兼容 · Chat Completions | `https://ark.cn-beijing.volces.com/api/v3` |
| [智谱 GLM / BigModel](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) | OpenAI 兼容 · Chat Completions | `https://open.bigmodel.cn/api/paas/v4` |
| [MiniMax（国内）](https://platform.minimaxi.com/docs/api-reference/text-anthropic-api) | Claude / 兼容 · Messages | `https://api.minimaxi.com/anthropic/v1` |
| [MiniMax（国际）](https://platform.minimax.io/docs/api-reference/text-anthropic-api) | Claude / 兼容 · Messages | `https://api.minimax.io/anthropic/v1` |
| [OpenAI · Responses](https://developers.openai.com/api/docs/guides/text) | OpenAI / 兼容 · Responses | `https://api.openai.com/v1` |
| [OpenAI · Chat Completions](https://developers.openai.com/api/docs/guides/text) | OpenAI 兼容 · Chat Completions | `https://api.openai.com/v1` |
| [Anthropic Claude](https://platform.claude.com/docs/en/api/overview) | Claude / 兼容 · Messages | `https://api.anthropic.com/v1` |
| [Google Gemini](https://ai.google.dev/api/generate-content) | Google Gemini · 原生接口 | `https://generativelanguage.googleapis.com/v1beta` |
| [Azure OpenAI](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints) | Azure OpenAI | 按本机登录或账号资源填写 |
| [xAI / Grok](https://docs.x.ai/developers/rest-api-reference/inference/responses) | OpenAI / 兼容 · Responses | `https://api.x.ai/v1` |
| [Mistral](https://docs.mistral.ai/api/endpoint/chat) | OpenAI 兼容 · Chat Completions | `https://api.mistral.ai/v1` |
| [硅基流动 · 开源模型](https://docs.siliconflow.cn/docs/userguide/quickstart) | OpenAI 兼容 · Chat Completions | `https://api.siliconflow.cn/v1` |
| [OpenRouter](https://openrouter.ai/docs/quickstart) | OpenAI 兼容 · Chat Completions | `https://openrouter.ai/api/v1` |
| [Groq · 开源模型](https://console.groq.com/docs/openai) | OpenAI 兼容 · Chat Completions | `https://api.groq.com/openai/v1` |
| [Together AI · 开源模型](https://docs.together.ai/docs/inference/openai-compatibility) | OpenAI 兼容 · Chat Completions | `https://api.together.ai/v1` |
| [Ollama · 本地开源模型](https://docs.ollama.com/api/chat) | Ollama · 本地 / 远程服务 | `http://localhost:11434` |
| [LM Studio · 本地开源模型](https://lmstudio.ai/docs/developer/openai-compat) | OpenAI 兼容 · Chat Completions | `http://localhost:1234/v1` |
| [vLLM / SGLang / llama.cpp](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/) | OpenAI 兼容 · Chat Completions | `http://localhost:8000/v1` |

## 参数与兼容性

- Chat Completions 保留原有行为；支持自选 `max_tokens` / `max_completion_tokens`，不主动发送 temperature 等可能不兼容的采样参数。
- Responses 使用 `/responses`、消息输入、`store:false`；只提取最终文本，忽略推理块。
- Anthropic Messages 把系统消息转入 `system`，支持版本与工作空间请求头；输出上限默认 8192，可调整；JSON 使用提示词约束并在本地校验。
- Gemini 使用 `generateContent`、`systemInstruction`、`contents`；API Key 放请求头，不放 URL；只读取非 thought 文本，输出用量包含服务报告的思考 token。
- Azure 推荐 `/openai/v1`；旧版部署接口支持独立的 `api-version` 字段；Responses 可选择 Responses 协议、Azure v1 地址和 api-key 鉴权。
- Ollama 支持 `/api/chat`、`/api/tags` 和 options；模型权重由外部服务管理。
- 高级 JSON 参数按接口发送，可配置 DeepSeek/Kimi/GLM 的 thinking、reasoning_effort、Qwen 的 enable_thinking 等参数，具体值必须匹配对应模型；Gemini 写入 generationConfig，Ollama 写入 options。
- 原生响应的拒绝、截断、空文本、非成功状态不能被当成成功结果；已报告用量仍保留。Claude 的缓存读写与 Gemini 的推理用量纳入原有费用账本，未知价格继续要求用户配置。
- 原有配置无需迁移。新增选项改变时撤销旧的备用/自动选模授权，防止继续沿用旧配置的授权；保存后按需重新启用。
- 密钥沿用原有加密存储；服务域名或端口变化须重新填写或明确清除旧密钥。HTTP 重定向不会携带密钥和正文继续跳转。

## 边界

本版对接文本生成与推理，不直接支持图像/音视频生成、向量嵌入或重排接口。需要模型能按照提示词输出行知的 JSON 工作协议；接口连通不代表模型的任务能力已达标。

Bedrock、Vertex 等需要专有 IAM 签名或 OAuth 刷新流程的接口，需经兼容网关转接，未声称原生支持其全部鉴权方式。没有强制重试为其他协议、默认关闭推理或自动改用别的厂商。

## 验证方式

- `npm run test:models`：本地 HTTP 协议契约、模型列表、保存/重启、费用、错误和旧逻辑回归。
- `npm run test:models:desktop`：隔离 Electron 配置 7 种代表入口，读取模型、保存、测试连接和分配角色。
- `npm test` 与 `npm run build`：项目回归和构建。

测试服务均为 loopback 模拟，不使用用户真实密钥、订阅额度或生产工作空间；未逐家进行付费模型实测。
