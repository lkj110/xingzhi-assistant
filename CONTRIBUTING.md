# 参与行知助手

欢迎通过 GitHub Issue 报告问题，通过 Pull Request 提交改进。提交内容以本仓库的 MIT 许可证提供。

## 本地开发

1. Fork 本仓库，从 `main` 创建功能分支。
2. 准备 macOS、Node.js 24+、Xcode Command Line Tools，执行 `npm ci`。
3. 执行 `npm start` 启动完整应用；`npm run dev` 只启动前端开发服务。
4. 根据改动运行相应测试。提交前执行 `npm test` 和 `npm run build`；涉及界面或 IPC 时运行相关隔离桌面场景。

桌面测试使用临时 profile，避免连接真实工作空间。具体约定见 [桌面回归测试](docs/DESKTOP-REGRESSION.md)。不要在默认测试或 CI 调用收费模型、真实聊天连接或生产数据平台。

## 提交改动

说明修复的问题、前后行为、验证方式和已知限制。避免将无关重构与功能改动混在一起。新增模型预设时附官方接口文档，并使用本地 HTTP 模拟服务验证鉴权、请求、最终文本、异常与用量解析。仅新增名称而没有可用协议不能视为完成接入。

不要提交 `.env`、API Key、工作空间、真实任务编号/表名、用户日志或私人截图。测试材料使用合成数据。构建产物和依赖目录由 `.gitignore` 排除；安装包放在 GitHub Releases。
