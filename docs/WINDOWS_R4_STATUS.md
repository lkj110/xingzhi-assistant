# Windows 修订 4 验证记录

记录日期：2026-10-22（Asia/Shanghai）。基线为 0.42.4 / `a239465af9fc3bb4184676efff3c9d3374db44b7`。本分支包含 Windows 平台适配、本机工具、办公连接扩展和 Agent 工具接入。视频生成不属于本次范围。

## 已完成

- Windows 11 x64 最终运行时回归：4621 项，4559 通过、0 失败、0 取消、62 跳过。平台跳过及 macOS 发布门禁排除保留说明，未将其算作通过。
- 独立原生桌面测试 1 项通过：真实文字选择、复制后的剪贴板恢复、密码控件拒绝和区域截图。长时间后台回归后的桌面阶段曾未收到选区事件；同一源码独立复测通过，保留失败与复测日志，不将先前尝试标成全程成功。
- 最终实际 EXE 验证通过：启动、OCR/PDF 导入、原生组件、冷启动持久化及包内源码哈希比对。
- 实际 EXE 的本机工具 6 项检查与 Agent 界面 5 项检查通过，包含执行前确认、真实代码产出、中文语音预览及重启恢复；渲染异常 0。
- 真实 ChatGPT/Codex 订阅模型完成自动规划、计算文件、未发送邮件草稿和中文 WAV，8 次模型调用后完成任务和委托验收；检查实际文件内容、EML 字段、WAV 头及当前任务的交付证据。
- 独立真实订阅图片委托完成：仅生成 1 张 PNG，5 次调用（含规划、生成和验收），实际文件 1035689 字节；文件与哈希验证通过，人工查看为白底青绿色圆形。
- 媒体路径与 OAuth 刷新定向回归 21 项通过。此组与全量回归重叠，不累加到独立测试总数。

## 功能边界

Agent 支持 `run_code`、`mail_draft`、`generate_image`、`synthesize_speech`、`send_mail`、`github_deploy` 和结果回读。按委托设置工具权限，原委托默认不扩权；发信与部署逐次确认。代码使用当前用户权限，独立工作目录不构成安全沙箱。

真实外部发信和部署未执行：模拟服务验证精确确认、授权撤销、OAuth 刷新、结果未知时停止重试。平台受理不等同于送达或部署成功。

飞书应用创建完成，但用户 OAuth 被平台策略拒绝（21001），需租户管理员或平台支持处理。Slack 登录由用户暂缓；Notion、Outlook、企业微信、钉钉及应用内 GitHub/部署凭据仍需对应账号与目标授权。已连接的 Codex GitHub 账号不等于行知助手自身已获得 GitHub 凭据。

Windows 10、ARM、多显示器混合缩放及可信代码签名尚未验收。本地构建为 unsigned；不沿用原 macOS 正式发行签名。

## 复验

在 Windows 11 x64、Node.js 24+、Python 3、Windows .NET Framework 4.8 和相应 OCR 语言组件环境中：

```powershell
npm ci
npx playwright install chromium
npm run build
npm run test:windows
npm run windows:package
```

`test:windows` 动态发现运行时用例，桌面控件测试独占桌面焦点。实际包验证入口为 `scripts/windows-smoke.cjs`、`scripts/windows-r3-smoke.cjs`、`scripts/windows-r4-smoke.cjs`。真实订阅调用需要自行登录和可用额度，不在默认回归中重复消耗额度。

源码不包含令牌、登录会话、用户工作空间、个人材料或机器专属配置。
