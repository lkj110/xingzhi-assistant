# 通知修复候选：已暴露样本离线回归

本包复用 [原候选样本](../foundation-candidate-20261028/README.md) 的六例及门检。stimuli、gold、anchors、inputs 和 preflight 均保持原字节；不是新的效果评测样本。原封存与历史失败记录不变。

新 plan、package-manifest 和 seal 仅绑定本次隔离候选。产品来源为 8d374b24b2aae2760f3d33cf1c2561130429f6ae，仅纳入已审核的通知局部判定；不改当前安装版。offlineOnly 为 true，执行器拒绝此包 live 模式。继承的预算仅服务离线停止机制，不构成真实预算授权。

运行一次门检加六例完整流程，并运行一场 malformed-evidence 停止检查。正常例应为 review 且验收入口 ready；两固定负例应 blocked 且不可接受。修改、重启、证据与账本必须一致。脚本不执行真人接受。所有回复及用量为合成值，不能当作真实质量率或模型成本。
