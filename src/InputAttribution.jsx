import React from 'react';
const names={systemInstructions:'固定说明',requirements:'要求与事项',draft:'当前稿件',evidenceBodies:'证据正文',evidenceMetadata:'证据元数据',toolReceipts:'工具回执',navigation:'目录与续读说明',other:'其他上下文'};
export default function InputAttribution({value}){
 if(!value?.categories)return null;
 return <details className="help-text"><summary>输入开销归因</summary><p>分类 token 按可见输入的 UTF-8 字节占比分摊估算，含服务端额外开销的分摊，不是各部分的精确计费。实际总用量以模型返回为准；缓存不按类别分配。</p>{value.budget&&<p>本次输入预算：{value.budget.unknownCapability?'模型窗口未确认，使用字符保护':`${value.budget.availableInputTokens?.toLocaleString()} token（已预留输出和包装）`}；按字节保守估算，服务端用量可能不同。{value.budget.projectionLevel>0?'已分页保留可恢复材料。':''}</p>}<table><thead><tr><th>输入部分</th><th>可见字节占比</th><th>估算输入 token</th></tr></thead><tbody>{Object.entries(value.categories).filter(([,row])=>row.utf8Bytes>0).map(([key,row])=><tr key={key}><td>{names[key]||key}</td><td>{(100*row.utf8Bytes/value.visibleUtf8Bytes).toFixed(1)}%</td><td>{Number.isFinite(row.estimatedInputTokens)?row.estimatedInputTokens.toLocaleString():'未返回用量'}</td></tr>)}</tbody></table></details>;
}
